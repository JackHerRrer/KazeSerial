//! MCP server exposing KazeSerial's log buffer to an agent.
//!
//! Transport is Streamable HTTP bound to loopback, served inside the Tauri process, so an
//! agent can read the logs live while the user keeps using the GUI:
//!
//! ```text
//! claude mcp add --transport http kazeserial http://127.0.0.1:9339/mcp
//! ```
//!
//! Read-only apart from [`KazeMcp::clear_logs`]. Nothing here can touch the serial port.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rmcp::handler::server::tool::ToolRouter;
use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::{Implementation, ServerCapabilities, ServerInfo};
use rmcp::transport::streamable_http_server::{
    StreamableHttpService, session::local::LocalSessionManager, tower::StreamableHttpServerConfig,
};
use rmcp::{ErrorData, ServerHandler, tool, tool_router};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

use crate::log_store::{LogRecord, LogStore, SearchOptions};

/// Guardrail so a single call can never blow up the agent's context window.
const HARD_MAX_LINES: usize = 20_000;
/// Upper bound on how long `wait_for_logs` may block.
const MAX_WAIT_MS: u64 = 120_000;

fn is_false(value: &bool) -> bool {
    !*value
}

fn clamp_lines(requested: usize) -> usize {
    requested.clamp(1, HARD_MAX_LINES)
}

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/// One log line. `focus`/`removed` are omitted when false to keep payloads small.
#[derive(Serialize, schemars::JsonSchema)]
pub struct LogLine {
    /// Stable, monotonically increasing line id. Use it with `get_logs_range`
    /// and `wait_for_logs`.
    pub id: u64,
    pub text: String,
    /// Line matches a highlight rule the user marked as "focus".
    #[serde(default, skip_serializing_if = "is_false")]
    pub focus: bool,
    /// Line is hidden in the user's view by a "remove" highlight rule.
    #[serde(default, skip_serializing_if = "is_false")]
    pub removed: bool,
}

impl From<LogRecord> for LogLine {
    fn from(record: LogRecord) -> Self {
        Self {
            id: record.id,
            text: record.text,
            focus: record.focus,
            removed: record.removed,
        }
    }
}

fn to_lines(records: Vec<LogRecord>) -> Vec<LogLine> {
    records.into_iter().map(LogLine::from).collect()
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct StatusOutput {
    /// Where the lines come from: `none`, `serial`, `file` or `file_watch`.
    pub source_kind: String,
    /// Human-readable source, e.g. `serial /dev/ttyUSB0 @ 115200 baud`.
    pub source: String,
    /// True while a serial port is open.
    pub serial_connected: bool,
    /// True while a file is being followed `tail -f` style.
    pub file_watching: bool,
    pub total_lines: usize,
    /// Lines matching a "focus" highlight rule.
    pub focus_lines: usize,
    /// Lowest id still in the buffer, `null` when empty.
    pub oldest_id: Option<u64>,
    /// Highest id in the buffer, `null` when empty. Use as the cursor for `wait_for_logs`.
    pub newest_id: Option<u64>,
    /// Lines evicted by the ring buffer since the last load — those are gone for good.
    pub dropped_lines: u64,
    /// Ring buffer size, set by `KAZESERIAL_LOG_CAPACITY`.
    pub capacity: usize,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct LogsOutput {
    pub lines: Vec<LogLine>,
    /// Number of lines returned.
    pub returned: usize,
    /// Lines matching the query before the cap was applied.
    pub total_matching: usize,
    /// True when `total_matching` exceeded the cap and lines were left out.
    pub truncated: bool,
    /// Highest id returned — pass it back as `after_id` to `wait_for_logs`.
    pub last_id: Option<u64>,
    /// Offset to pass to the next `get_all_logs` call, `null` when done.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,
}

impl LogsOutput {
    fn new(lines: Vec<LogLine>, total_matching: usize) -> Self {
        let returned = lines.len();
        let last_id = lines.last().map(|l| l.id);
        Self {
            lines,
            returned,
            total_matching,
            truncated: returned < total_matching,
            last_id,
            next_offset: None,
        }
    }
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct SearchHitOutput {
    /// Id of the matching line itself (context lines carry different ids).
    pub hit_id: u64,
    /// The matching line plus any requested context, in order.
    pub lines: Vec<LogLine>,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct SearchOutput {
    pub hits: Vec<SearchHitOutput>,
    pub returned: usize,
    pub total_hits: usize,
    pub truncated: bool,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct ClearOutput {
    pub cleared_lines: usize,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct WaitOutput {
    pub lines: Vec<LogLine>,
    pub returned: usize,
    /// False when the wait timed out with no new line.
    pub got_lines: bool,
    /// New cursor: highest id returned, or the `after_id` you passed on timeout.
    pub last_id: u64,
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

fn default_tail_count() -> usize {
    100
}
fn default_page_size() -> usize {
    2_000
}
fn default_search_limit() -> usize {
    100
}
fn default_ignore_case() -> bool {
    true
}
fn default_timeout_ms() -> u64 {
    15_000
}
fn default_wait_max() -> usize {
    500
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct TailParams {
    /// How many trailing lines to return. Default 100.
    #[serde(default = "default_tail_count")]
    pub count: usize,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct RangeParams {
    /// First line id to include (inclusive).
    pub from_id: u64,
    /// Last line id to include (inclusive).
    pub to_id: u64,
    /// Cap on returned lines. Default 2000, hard max 20000.
    #[serde(default = "default_page_size")]
    pub max_lines: usize,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct AllParams {
    /// Position to start from, 0-based. Use `next_offset` from the previous call.
    #[serde(default)]
    pub offset: usize,
    /// Cap on returned lines. Default 2000, hard max 20000.
    #[serde(default = "default_page_size")]
    pub max_lines: usize,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct FocusParams {
    /// How many trailing focus lines to return. Default 100.
    #[serde(default = "default_tail_count")]
    pub count: usize,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct SearchParams {
    /// Text or regex to look for.
    pub pattern: String,
    /// Treat `pattern` as a Rust regex instead of a literal substring.
    #[serde(default)]
    pub is_regex: bool,
    /// Case-insensitive matching. Default true.
    #[serde(default = "default_ignore_case")]
    pub ignore_case: bool,
    /// Cap on returned hits. Default 100, hard max 20000.
    #[serde(default = "default_search_limit")]
    pub limit: usize,
    /// Lines of context to include before each hit.
    #[serde(default)]
    pub context_before: usize,
    /// Lines of context to include after each hit.
    #[serde(default)]
    pub context_after: usize,
    /// Restrict the search to ids >= this value.
    #[serde(default)]
    pub from_id: Option<u64>,
    /// Restrict the search to ids <= this value.
    #[serde(default)]
    pub to_id: Option<u64>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct WaitParams {
    /// Return lines with an id strictly greater than this. Use `newest_id` from
    /// `get_status`, or `last_id` from your previous call.
    pub after_id: u64,
    /// How long to block waiting for new lines. Default 15000, max 120000.
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    /// Cap on returned lines. Default 500, hard max 20000.
    #[serde(default = "default_wait_max")]
    pub max_lines: usize,
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// MCP handler. One instance per session; all instances share the same [`LogStore`].
#[derive(Clone)]
pub struct KazeMcp {
    store: Arc<LogStore>,
    serial_connected: Arc<AtomicBool>,
    file_watch_active: Arc<AtomicBool>,
    app: tauri::AppHandle,
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl KazeMcp {
    pub fn new(
        store: Arc<LogStore>,
        serial_connected: Arc<AtomicBool>,
        file_watch_active: Arc<AtomicBool>,
        app: tauri::AppHandle,
    ) -> Self {
        Self {
            store,
            serial_connected,
            file_watch_active,
            app,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        name = "get_status",
        description = "Orientation call: what KazeSerial is capturing right now and how much of \
                       it is buffered. Returns the log source (serial port, loaded file or \
                       followed file), the line count, the oldest and newest line ids, and how \
                       many lines the ring buffer has already evicted. Call this first — the ids \
                       it returns are the cursors every other tool takes."
    )]
    async fn get_status(&self) -> Json<StatusOutput> {
        let stats = self.store.stats().await;
        Json(StatusOutput {
            source_kind: stats.source.kind().to_string(),
            source: stats.source.describe(),
            serial_connected: self.serial_connected.load(Ordering::SeqCst),
            file_watching: self.file_watch_active.load(Ordering::SeqCst),
            total_lines: stats.total_lines,
            focus_lines: stats.focus_lines,
            oldest_id: stats.oldest_id,
            newest_id: stats.newest_id,
            dropped_lines: stats.dropped_lines,
            capacity: stats.capacity,
        })
    }

    #[tool(
        name = "tail_logs",
        description = "The most recent lines, oldest first — the equivalent of `tail -n`. Start \
                       here when the user says something just went wrong. Cheaper than dumping \
                       the whole buffer."
    )]
    async fn tail_logs(&self, Parameters(params): Parameters<TailParams>) -> Json<LogsOutput> {
        let count = clamp_lines(params.count);
        let stats = self.store.stats().await;
        let records = self.store.tail(count).await;
        Json(LogsOutput::new(to_lines(records), stats.total_lines))
    }

    #[tool(
        name = "get_logs_range",
        description = "Lines between two ids, inclusive. Use it to zoom in around something \
                       another call surfaced — e.g. the 200 lines either side of an error id. \
                       Ids are stable and never reused within a session."
    )]
    async fn get_logs_range(
        &self,
        Parameters(params): Parameters<RangeParams>,
    ) -> Result<Json<LogsOutput>, ErrorData> {
        if params.from_id > params.to_id {
            return Err(ErrorData::invalid_params(
                "from_id must be less than or equal to to_id",
                None,
            ));
        }
        let max_lines = clamp_lines(params.max_lines);
        let (records, total) = self
            .store
            .range(params.from_id, params.to_id, max_lines)
            .await;
        Ok(Json(LogsOutput::new(to_lines(records), total)))
    }

    #[tool(
        name = "get_all_logs",
        description = "The complete buffer, paginated. Returns `next_offset` when more remains — \
                       keep calling with it until it comes back null. Prefer search_logs or \
                       tail_logs when you can: a full capture is often tens of thousands of \
                       lines and will flood your context."
    )]
    async fn get_all_logs(&self, Parameters(params): Parameters<AllParams>) -> Json<LogsOutput> {
        let max_lines = clamp_lines(params.max_lines);
        let (records, total) = self.store.page(params.offset, max_lines).await;
        let consumed = params.offset + records.len();

        let mut output = LogsOutput::new(to_lines(records), total);
        output.truncated = consumed < total;
        output.next_offset = (consumed < total).then_some(consumed);
        Json(output)
    }

    #[tool(
        name = "get_focus_logs",
        description = "Only the lines matching a highlight rule the user flagged as \"focus\" — \
                       the app's own focus panel. High signal: these are the patterns the user \
                       already decided matter for the bug they are chasing."
    )]
    async fn get_focus_logs(&self, Parameters(params): Parameters<FocusParams>) -> Json<LogsOutput> {
        let count = clamp_lines(params.count);
        let stats = self.store.stats().await;
        let records = self.store.focus(count).await;
        Json(LogsOutput::new(to_lines(records), stats.focus_lines))
    }

    #[tool(
        name = "search_logs",
        description = "Grep the buffer, with optional surrounding context lines. Substring by \
                       default, or a Rust regex with is_regex. Use context_before/context_after \
                       to see what led up to a hit. This is the cheapest way to find something \
                       in a large capture — reach for it before get_all_logs."
    )]
    async fn search_logs(&self, Parameters(params): Parameters<SearchParams>) -> Json<SearchOutput> {
        let limit = clamp_lines(params.limit);
        let (hits, total_hits) = self
            .store
            .search(SearchOptions {
                pattern: &params.pattern,
                is_regex: params.is_regex,
                ignore_case: params.ignore_case,
                limit,
                context_before: params.context_before.min(500),
                context_after: params.context_after.min(500),
                from_id: params.from_id,
                to_id: params.to_id,
            })
            .await;

        let returned = hits.len();
        Json(SearchOutput {
            hits: hits
                .into_iter()
                .map(|hit| SearchHitOutput {
                    hit_id: hit.hit_id,
                    lines: to_lines(hit.lines),
                })
                .collect(),
            returned,
            total_hits,
            truncated: returned < total_hits,
        })
    }

    #[tool(
        name = "wait_for_logs",
        description = "Block until lines newer than after_id arrive, or the timeout expires. This \
                       is how you follow a live capture without polling: take newest_id from \
                       get_status, then keep calling with the last_id you get back. Returns \
                       got_lines=false on timeout, which is normal when the device is quiet — \
                       just call again."
    )]
    async fn wait_for_logs(&self, Parameters(params): Parameters<WaitParams>) -> Json<WaitOutput> {
        let max_lines = clamp_lines(params.max_lines);
        let timeout = Duration::from_millis(params.timeout_ms.min(MAX_WAIT_MS));

        let records = self
            .store
            .wait_after(params.after_id, timeout, max_lines)
            .await;

        let lines = to_lines(records);
        let last_id = lines.last().map(|l| l.id).unwrap_or(params.after_id);
        Json(WaitOutput {
            returned: lines.len(),
            got_lines: !lines.is_empty(),
            last_id,
            lines,
        })
    }

    #[tool(
        name = "clear_logs",
        description = "Wipe the buffer in both the agent's view and the user's window, so a \
                       reproduction starts from a clean slate. Destructive: cleared lines are \
                       gone, they are not written anywhere. Ask the user before calling it \
                       unless they asked for a fresh capture."
    )]
    async fn clear_logs(&self) -> Json<ClearOutput> {
        let stats = self.store.stats().await;
        self.store.clear().await;
        // Keep the user's window in sync with what the agent just did.
        let _ = self.app.emit("logs-cleared", ());
        Json(ClearOutput {
            cleared_lines: stats.total_lines,
        })
    }
}

// `router = self.tool_router` reuses the router built once per session; the macro's
// default (`Self::tool_router()`) would rebuild it on every tool call.
#[rmcp::tool_handler(router = self.tool_router)]
impl ServerHandler for KazeMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new("kazeserial", env!("CARGO_PKG_VERSION"))
                    .with_title("KazeSerial logs")
                    .with_description(
                        "Live serial-port and log-file capture from the KazeSerial window",
                    )
                    .with_website_url("https://github.com/simon0356/KazeSerial"),
            )
            .with_instructions(
                "KazeSerial is a serial-port log viewer the user is watching right now. These \
                 tools read the same buffer they see on screen, so you can debug alongside them.\n\n\
                 Start with get_status to learn the source and the newest line id. Then:\n\
                 - tail_logs for what just happened\n\
                 - search_logs to find something in a large capture (cheapest option)\n\
                 - get_logs_range to zoom in around a line id\n\
                 - get_focus_logs for the lines the user's own highlight rules flagged as \
                 important — high signal\n\
                 - wait_for_logs to follow the capture live: pass the last id you saw and it \
                 blocks until new lines arrive\n\
                 - get_all_logs only when you truly need everything; it paginates and a capture \
                 can be tens of thousands of lines\n\n\
                 Line text is always raw, with no highlight markup. Ids are stable within a \
                 session; the buffer is a ring, so old lines can be evicted (dropped_lines in \
                 get_status says how many).",
            )
    }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/// Live server: cancelling the token stops the listener and all sessions.
pub struct McpServerHandle {
    pub addr: SocketAddr,
    cancel: CancellationToken,
}

impl McpServerHandle {
    pub fn url(&self) -> String {
        format!("http://{}/mcp", self.addr)
    }

    pub fn stop(&self) {
        self.cancel.cancel();
    }
}

/// Binds the MCP server to `127.0.0.1:port` and serves it in a background task.
///
/// `port` 0 asks the OS for a free port; the actual address is in the returned handle.
/// Binding is loopback-only, and rmcp additionally validates the `Host` header against
/// loopback names to blunt DNS-rebinding attacks from a browser.
pub async fn start(
    port: u16,
    store: Arc<LogStore>,
    serial_connected: Arc<AtomicBool>,
    file_watch_active: Arc<AtomicBool>,
    app: tauri::AppHandle,
) -> Result<McpServerHandle, String> {
    let cancel = CancellationToken::new();

    let service = StreamableHttpService::new(
        {
            let store = store.clone();
            let serial_connected = serial_connected.clone();
            let file_watch_active = file_watch_active.clone();
            let app = app.clone();
            move || {
                Ok(KazeMcp::new(
                    store.clone(),
                    serial_connected.clone(),
                    file_watch_active.clone(),
                    app.clone(),
                ))
            }
        },
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default()
            // Plain JSON replies keep simple tool calls out of SSE framing.
            .with_json_response(true)
            .with_cancellation_token(cancel.clone()),
    );

    let router = axum::Router::new().nest_service("/mcp", service);

    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)))
        .await
        .map_err(|e| format!("Failed to bind 127.0.0.1:{}: {}", port, e))?;

    let addr = listener
        .local_addr()
        .map_err(|e| format!("Failed to read local address: {}", e))?;

    let shutdown = cancel.clone();
    tokio::spawn(async move {
        let served = axum::serve(listener, router)
            .with_graceful_shutdown(async move { shutdown.cancelled().await })
            .await;
        if let Err(err) = served {
            println!("MCP server stopped with error: {}", err);
        }
    });

    Ok(McpServerHandle { addr, cancel })
}
