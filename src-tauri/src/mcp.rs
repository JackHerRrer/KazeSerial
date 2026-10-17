//! MCP server exposing KazeSerial's log buffer to an agent.
//!
//! Transport is Streamable HTTP bound to loopback, served inside the Tauri process, so an
//! agent can read the logs live while the user keeps using the GUI:
//!
//! ```text
//! claude mcp add --transport http kazeserial http://127.0.0.1:9339/mcp
//! ```
//!
//! Read-only apart from [`KazeMcp::clear_logs`], [`KazeMcp::add_highlight`] and
//! [`KazeMcp::refresh_logs`]. Nothing here can touch the serial port.

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
use tauri::{Emitter, Manager};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::log_store::{LogRecord, LogStore, SearchOptions, build_matcher};

/// Guardrail so a single call can never blow up the agent's context window.
const HARD_MAX_LINES: usize = 20_000;
/// Upper bound on how long `wait_for_logs` may block.
const MAX_WAIT_MS: u64 = 120_000;
/// How long a tool waits for the window to carry out what it asked.
const WINDOW_TIMEOUT: Duration = Duration::from_secs(10);

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
pub struct AddHighlightOutput {
    /// The rule as it was added to the user's highlight list, after defaults were applied.
    pub rule: HighlightRule,
    /// Reminder of what the rule applies to.
    pub note: String,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct RefreshOutput {
    pub total_lines: usize,
    /// Lines matching a "focus" highlight rule after the refresh.
    pub focus_lines: usize,
    /// New lowest id, `null` when empty. Every line got a new id.
    pub oldest_id: Option<u64>,
    /// New highest id, `null` when empty. Use as the cursor for `wait_for_logs`.
    pub newest_id: Option<u64>,
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

#[derive(Serialize, schemars::JsonSchema)]
pub struct WaitForPatternOutput {
    /// True when the pattern matched before the timeout.
    pub matched: bool,
    /// The matching line. Absent when the call timed out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<LogLine>,
    /// Matches seen after `after_id`, including the returned one — 0 on timeout.
    pub occurrences_seen: usize,
    /// New cursor: the matched line's id, or the newest id scanned on timeout. Pass it
    /// back as `after_id` to wait for the *next* occurrence.
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
fn default_true() -> bool {
    true
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

#[derive(Deserialize, schemars::JsonSchema)]
pub struct WaitForPatternParams {
    /// Only consider lines with an id strictly greater than this. Use `newest_id`
    /// from `get_status`, or `last_id` from a previous `wait_for_pattern` call to wait
    /// for the next occurrence.
    pub after_id: u64,
    /// Text or regex to look for.
    pub pattern: String,
    /// Treat `pattern` as a Rust regex instead of a literal substring.
    #[serde(default)]
    pub is_regex: bool,
    /// Case-insensitive matching. Default true.
    #[serde(default = "default_ignore_case")]
    pub ignore_case: bool,
    /// Matches to skip before returning — e.g. 2 to ignore the pattern's first two
    /// occurrences and catch the third. Default 0 (return on the first match).
    #[serde(default)]
    pub skip_occurrences: usize,
    /// How long to block waiting for the pattern. Default 15000, max 120000.
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct AdvancedSelectionParams {
    /// Capture groups of the regex to color, numbered from 1 left to right — e.g. [1, 3].
    pub groups: Vec<usize>,
    /// `#rrggbb` color for these groups. Defaults to the rule's `color`.
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct AddHighlightParams {
    /// Text or regex the rule looks for.
    pub pattern: String,
    /// Treat `pattern` as a Rust regex instead of a literal text. Default false.
    #[serde(default)]
    pub is_regex: bool,
    /// Case-sensitive matching. Default true.
    #[serde(default = "default_true")]
    pub case_sensitive: bool,
    /// `#rrggbb` highlight color. Default `#cc7f12` (orange).
    #[serde(default)]
    pub color: Option<String>,
    /// List matching lines in the focus panel (and in `get_focus_logs`). Default true.
    /// Ignored when `remove` is set.
    #[serde(default = "default_true")]
    pub focus: bool,
    /// Hide the matched text (or the whole line with `whole_line`) instead of coloring it.
    /// Default false.
    #[serde(default)]
    pub remove: bool,
    /// Color or remove the entire line instead of just the matched text. Default false.
    /// Cannot be combined with `advanced_selections`.
    #[serde(default)]
    pub whole_line: bool,
    /// Advanced mode: color individual capture groups instead of the whole match, each
    /// selection with its own color. Requires `is_regex`.
    #[serde(default)]
    pub advanced_selections: Vec<AdvancedSelectionParams>,
}

/// One highlight rule, in the shape the Highlight tab stores it.
#[derive(Clone, Debug, PartialEq, Serialize, schemars::JsonSchema)]
pub struct HighlightRule {
    pub text: String,
    pub color: String,
    pub is_regex: bool,
    pub case_sensitive: bool,
    pub whole_line: bool,
    pub advanced: bool,
    pub advanced_selections: Vec<HighlightSelection>,
    pub focus: bool,
    pub remove: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, schemars::JsonSchema)]
pub struct HighlightSelection {
    pub color: String,
    /// Comma-separated capture group numbers, e.g. `1,3`.
    pub selector: String,
}

const DEFAULT_HIGHLIGHT_COLOR: &str = "#cc7f12";

fn is_hex_color(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn parse_color(color: Option<String>, default: &str) -> Result<String, String> {
    match color {
        None => Ok(default.to_string()),
        Some(color) if is_hex_color(&color) => Ok(color.to_lowercase()),
        Some(color) => Err(format!("invalid color {:?}: expected #rrggbb", color)),
    }
}

/// Validates an `add_highlight` request and turns it into the rule the Highlight tab would
/// hold if the user had filled the row with the same options.
fn build_highlight_rule(params: AddHighlightParams) -> Result<HighlightRule, String> {
    if params.pattern.is_empty() {
        return Err("pattern must not be empty".to_string());
    }
    let color = parse_color(params.color, DEFAULT_HIGHLIGHT_COLOR)?;

    let mut capture_groups = 0;
    if params.is_regex {
        let regex = regex::RegexBuilder::new(&params.pattern)
            .case_insensitive(!params.case_sensitive)
            .build()
            .map_err(|e| format!("invalid regex: {}", e))?;
        capture_groups = regex.captures_len() - 1;
    }

    let advanced = !params.advanced_selections.is_empty();
    if advanced && !params.is_regex {
        return Err("advanced_selections requires is_regex".to_string());
    }
    if advanced && params.whole_line {
        return Err("whole_line cannot be combined with advanced_selections".to_string());
    }

    let advanced_selections = params
        .advanced_selections
        .into_iter()
        .map(|selection| {
            if selection.groups.is_empty() {
                return Err("each advanced selection needs at least one group".to_string());
            }
            if let Some(group) = selection.groups.iter().find(|&&g| g < 1 || g > capture_groups) {
                return Err(format!(
                    "capture group {} does not exist: the regex has {} group(s)",
                    group, capture_groups
                ));
            }
            Ok(HighlightSelection {
                color: parse_color(selection.color, &color)?,
                selector: selection
                    .groups
                    .iter()
                    .map(|g| g.to_string())
                    .collect::<Vec<_>>()
                    .join(","),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(HighlightRule {
        text: params.pattern,
        color,
        is_regex: params.is_regex,
        case_sensitive: params.case_sensitive,
        whole_line: params.whole_line,
        advanced,
        advanced_selections,
        // Same rule as the Highlight tab: a "remove" rule never feeds the focus panel.
        focus: params.focus && !params.remove,
        remove: params.remove,
    })
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

    /// Emits `event` to the window and waits until it reports back through `done`.
    async fn ask_window<P: Serialize + Clone>(
        &self,
        event: &str,
        payload: P,
        done: &Notify,
    ) -> Result<(), ErrorData> {
        // Registered before emitting, so a window that answers right away is not missed.
        let notified = done.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        self.app
            .emit(event, payload)
            .map_err(|e| ErrorData::internal_error(format!("failed to reach the window: {}", e), None))?;
        tokio::time::timeout(WINDOW_TIMEOUT, notified)
            .await
            .map_err(|_| ErrorData::internal_error("the window did not answer in time", None))
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
        name = "wait_for_pattern",
        description = "Block until a line matching pattern (substring or regex) with id > \
                       after_id appears, or the timeout expires. Use this instead of a fixed \
                       sleep when you launch a debug session and need to catch a specific log \
                       line — e.g. a boot banner or an assert — without guessing how long that \
                       takes. skip_occurrences lets you ignore the pattern's first N hits and \
                       catch the next one, e.g. to skip past known startup noise. matched=false \
                       means the timeout hit with no (further) match; call again with the \
                       returned last_id as the new after_id to keep waiting."
    )]
    async fn wait_for_pattern(
        &self,
        Parameters(params): Parameters<WaitForPatternParams>,
    ) -> Result<Json<WaitForPatternOutput>, ErrorData> {
        let matcher = build_matcher(&params.pattern, params.is_regex, params.ignore_case)
            .map_err(|e| ErrorData::invalid_params(format!("invalid regex: {}", e), None))?;
        let timeout = Duration::from_millis(params.timeout_ms.min(MAX_WAIT_MS));

        let result = self
            .store
            .wait_for_pattern(
                params.after_id,
                matcher.as_ref(),
                params.skip_occurrences,
                timeout,
            )
            .await;

        Ok(Json(WaitForPatternOutput {
            matched: result.matched,
            line: result.line.map(LogLine::from),
            occurrences_seen: result.occurrences_seen,
            last_id: result.last_id,
        }))
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
        self.app.state::<crate::AppState>().reset_markers();
        // Keep the user's window in sync with what the agent just did.
        let _ = self.app.emit("logs-cleared", ());
        Json(ClearOutput {
            cleared_lines: stats.total_lines,
        })
    }

    #[tool(
        name = "add_highlight",
        description = "Add a highlight rule to the user's Highlight tab, exactly as if they had \
                       filled a new row: a text or regex pattern plus its options (color, case \
                       sensitivity, focus, remove, whole line, and per-capture-group colors in \
                       advanced mode). Use it to make something you found stand out in the \
                       user's window, or to flag lines as focus so get_focus_logs returns them. \
                       The rule is saved with the user's other rules and applies to lines \
                       received from now on; call refresh_logs to apply it to the lines already \
                       shown. Tell the user what you added — they can edit or delete it in the \
                       Highlight tab."
    )]
    async fn add_highlight(
        &self,
        Parameters(params): Parameters<AddHighlightParams>,
    ) -> Result<Json<AddHighlightOutput>, ErrorData> {
        let rule = build_highlight_rule(params).map_err(|e| ErrorData::invalid_params(e, None))?;
        // The Highlight tab owns the rule list: it appends the rule, saves it and sends the
        // updated list back to the backend, as for a rule the user adds by hand.
        let state = self.app.state::<crate::AppState>();
        self.ask_window("mcp-add-highlight", &rule, &state.highlights_updated)
            .await?;
        Ok(Json(AddHighlightOutput {
            rule,
            note: "Applies to lines received from now on. Call refresh_logs to re-color the \
                   lines already shown."
                .to_string(),
        }))
    }

    #[tool(
        name = "refresh_logs",
        description = "Re-apply the current highlight rules to every line shown, like the \
                       user's Refresh button — e.g. right after add_highlight, so the new rule \
                       also colors and flags as focus the lines already captured. Returns once \
                       the window is updated. Every line gets a new id: previous ids and \
                       cursors are no longer valid, use the ids returned here."
    )]
    async fn refresh_logs(&self) -> Result<Json<RefreshOutput>, ErrorData> {
        // Only the window knows the reception time and marker flag of each line, so it runs
        // the Refresh and sends the lines back to be reprocessed.
        let state = self.app.state::<crate::AppState>();
        self.ask_window("mcp-refresh-logs", (), &state.logs_replaced)
            .await?;
        let stats = self.store.stats().await;
        Ok(Json(RefreshOutput {
            total_lines: stats.total_lines,
            focus_lines: stats.focus_lines,
            oldest_id: stats.oldest_id,
            newest_id: stats.newest_id,
        }))
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
                 - wait_for_pattern to block until a specific line shows up, instead of \
                 sleeping a fixed duration before checking — e.g. waiting on a debug session's \
                 boot banner. Call it directly once you know the pattern to watch for; there's no \
                 need to search_logs first to see whether it already occurred — pass the current \
                 newest_id as after_id and wait_for_pattern covers both cases (already present \
                 among the newer lines, or arriving later)\n\
                 - get_all_logs only when you truly need everything; it paginates and a capture \
                 can be tens of thousands of lines\n\
                 - add_highlight to add a highlight rule to the user's window, e.g. to make what \
                 you found stand out or to flag it as focus, then refresh_logs to apply it to the \
                 lines already shown (this gives every line a new id)\n\n\
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

#[cfg(test)]
mod tests {
    use super::*;

    fn params(pattern: &str) -> AddHighlightParams {
        AddHighlightParams {
            pattern: pattern.to_string(),
            is_regex: false,
            case_sensitive: true,
            color: None,
            focus: true,
            remove: false,
            whole_line: false,
            advanced_selections: Vec::new(),
        }
    }

    fn selection(groups: &[usize], color: Option<&str>) -> AdvancedSelectionParams {
        AdvancedSelectionParams {
            groups: groups.to_vec(),
            color: color.map(str::to_string),
        }
    }

    #[test]
    fn defaults_match_a_new_row_of_the_highlight_tab() {
        let rule = build_highlight_rule(params("ERROR")).unwrap();
        assert_eq!(
            rule,
            HighlightRule {
                text: "ERROR".to_string(),
                color: DEFAULT_HIGHLIGHT_COLOR.to_string(),
                is_regex: false,
                case_sensitive: true,
                whole_line: false,
                advanced: false,
                advanced_selections: Vec::new(),
                focus: true,
                remove: false,
            }
        );
    }

    #[test]
    fn remove_rules_are_never_focus() {
        let rule = build_highlight_rule(AddHighlightParams { remove: true, ..params("x") }).unwrap();
        assert!(rule.remove && !rule.focus);
    }

    #[test]
    fn colors_must_be_hex() {
        let ok = build_highlight_rule(AddHighlightParams { color: Some("#A0B1C2".into()), ..params("x") });
        assert_eq!(ok.unwrap().color, "#a0b1c2");
        for bad in ["red", "#fff", "#gg0000", "a0b1c2c"] {
            assert!(build_highlight_rule(AddHighlightParams { color: Some(bad.into()), ..params("x") }).is_err());
        }
    }

    #[test]
    fn rejects_empty_pattern_and_invalid_regex() {
        assert!(build_highlight_rule(params("")).is_err());
        assert!(build_highlight_rule(AddHighlightParams { is_regex: true, ..params("(") }).is_err());
        // Not a regex: parentheses are plain text.
        assert!(build_highlight_rule(params("(")).is_ok());
    }

    #[test]
    fn advanced_selections_become_group_selectors() {
        let rule = build_highlight_rule(AddHighlightParams {
            is_regex: true,
            color: Some("#112233".into()),
            advanced_selections: vec![selection(&[1, 3], None), selection(&[2], Some("#445566"))],
            ..params(r"(\w+)=(\d+) (\w+)")
        })
        .unwrap();
        assert!(rule.advanced && !rule.whole_line);
        assert_eq!(
            rule.advanced_selections,
            vec![
                HighlightSelection { color: "#112233".into(), selector: "1,3".into() },
                HighlightSelection { color: "#445566".into(), selector: "2".into() },
            ]
        );
    }

    #[test]
    fn advanced_selections_are_validated() {
        let advanced = |pattern: &str, is_regex: bool, whole_line: bool, groups: &[usize]| {
            build_highlight_rule(AddHighlightParams {
                is_regex,
                whole_line,
                advanced_selections: vec![selection(groups, None)],
                ..params(pattern)
            })
        };
        assert!(advanced("(a)", false, false, &[1]).is_err(), "requires a regex");
        assert!(advanced("(a)", true, true, &[1]).is_err(), "exclusive with whole_line");
        assert!(advanced("(a)", true, false, &[]).is_err(), "needs a group");
        assert!(advanced("(a)", true, false, &[0]).is_err(), "groups start at 1");
        assert!(advanced("(a)", true, false, &[2]).is_err(), "group out of range");
        assert!(advanced("(a)", true, false, &[1]).is_ok());
    }
}
