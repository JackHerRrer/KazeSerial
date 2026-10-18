mod log_file;
mod log_store;
mod mcp;
mod serial_splitter;
mod tail_splitter;

use log_file::{LogFileSettings, LogFiles};
use log_store::{LogRecord, LogSource, LogStore};
use regex::Regex;
use rayon::prelude::*;
use serial_splitter::SerialSplitter;
use serialport::{SerialPort, SerialPortType};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tail_splitter::{decode_utf8, TailSplitter};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{Mutex, Notify};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum HighlightSelectMode {
    Match,
    WholeLine,
    Custom,
}

impl Default for HighlightSelectMode {
    fn default() -> Self {
        Self::Match
    }
}

#[derive(Clone, serde::Deserialize)]
struct AdvancedSelectionMessage {
    color: String,
    custom_select: String,
}

#[derive(Clone)]
struct AdvancedSelectionSetting {
    color: String,
    custom_groups: Vec<usize>,
}

#[derive(Clone)]
struct ColoredSpan<'a> {
    start: usize,
    end: usize,
    color: &'a str,
}

#[derive(Clone, serde::Deserialize)]
struct HighlightMessage {
    id: u64,
    text: String,
    color: String,
    is_regex: bool,
    #[serde(default = "default_true")]
    case_sensitive: bool,
    #[serde(default)]
    select_mode: HighlightSelectMode,
    #[serde(default)]
    custom_select: String,
    #[serde(default)]
    whole_line: bool,
    #[serde(default)]
    advanced_selections: Vec<AdvancedSelectionMessage>,
    focus: bool,
    remove: bool,
}

#[derive(Clone)]
struct HighlightSettings {
    _id: u64,
    text: String,
    color: String,
    is_regex: bool,
    select_mode: HighlightSelectMode,
    custom_groups: Vec<usize>,   // capture group indices for plain custom mode
    advanced_custom: Vec<AdvancedSelectionSetting>, // per-group color overrides
    focus: bool,
    remove: bool,
    matcher: Regex,              // rule regex, or the escaped text for plain-text rules
}

#[derive(Clone, serde::Serialize)]
struct Payload {
    id: u64,
    message: String,
    matched: bool,
    rawline: Option<String>,
    removed_line: bool,
    /// Reception time in milliseconds since the Unix epoch; `None` for lines read from a
    /// loaded file, whose real time is unknown.
    timestamp: Option<u64>,
    /// Marker line inserted by the user to delimit a part of the log, see [`marker_payload`].
    marker: bool,
}

/// Marker line: shown as is, not processed by the highlight rules, and listed in the focus panel
/// too so it delimits the focus lines as well.
fn marker_payload(text: String, id: u64, timestamp: Option<u64>) -> Payload {
    Payload {
        id,
        message: html_escape(&text),
        matched: true,
        rawline: Some(text),
        removed_line: false,
        timestamp,
        marker: true,
    }
}

/// Current time in milliseconds since the Unix epoch, used as a line reception time.
fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Pairs every line with the same reception time, for [`process_batch`].
fn with_timestamp(lines: Vec<String>, timestamp: Option<u64>) -> Vec<(String, Option<u64>)> {
    lines.into_iter().map(|line| (line, timestamp)).collect()
}

/// Emits a KazeSerial system message as a regular `serial-data` event.
/// These appear in the log with format `[HH:MM:SS] KazeSerial: {msg}`, in local time like the
/// timestamp column: the time is the reception time of the line.
/// The message is processed through the current highlight rules like any other line.
async fn emit_system_msg(app: &AppHandle<impl Runtime>, msg: String) {
    let timestamp = now_ms();
    let raw = format!("[{}] KazeSerial: {}", log_file::format_timestamp(timestamp, "HH:mm:ss"), msg);
    let state = app.state::<AppState>();
    let message_id = state.message_id_counter.fetch_add(1, Ordering::SeqCst);
    let highlights = state.highlights.lock().await.clone();
    let payload = process_line(raw, &highlights, message_id, Some(timestamp));
    publish_one(app, payload).await;
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialPortEntry {
    port_name: String,
    device_label: String,
}

#[derive(Clone)]
struct AppState {
    serial_connection: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    highlights: Arc<Mutex<Vec<HighlightSettings>>>,
    message_id_counter: Arc<AtomicU64>,
    /// Number of the last marker inserted, so markers are numbered 1, 2, 3...
    marker_counter: Arc<AtomicU64>,
    /// Automatic save of the serial log to files
    log_files: Arc<std::sync::Mutex<LogFiles>>,
    file_watch_active: Arc<AtomicBool>,
    /// Every emitted line is recorded here so the MCP server can serve the same
    /// log the user sees. The webview state is no longer the only copy.
    log_store: Arc<LogStore>,
    /// Lock-free mirror of `serial_connection.is_some()`. Reading the connection
    /// itself would contend with the read loop, which holds it across blocking reads.
    serial_connected: Arc<AtomicBool>,
    /// Incremented by every open / close of the serial port, so a read loop waiting to
    /// reconnect stops when its session has been replaced or closed.
    serial_session: Arc<AtomicU64>,
    mcp_server: Arc<Mutex<Option<mcp::McpServerHandle>>>,
    /// Signaled when the window sends its highlight rules, so an MCP tool that asked the
    /// window to change them knows when they apply.
    highlights_updated: Arc<Notify>,
    /// Held while the log store is changed and the change emitted, so the window receives the
    /// changes in the order of the store, see [`refresh`].
    publish_lock: Arc<Mutex<()>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            serial_connection: Arc::new(Mutex::new(None)),
            highlights: Arc::new(Mutex::new(Vec::new())),
            message_id_counter: Arc::new(AtomicU64::new(1)),
            marker_counter: Arc::new(AtomicU64::new(0)),
            // Default folder set in `setup`, once the paths are known
            log_files: Arc::new(std::sync::Mutex::new(LogFiles::new(std::path::PathBuf::new()))),
            file_watch_active: Arc::new(AtomicBool::new(false)),
            log_store: Arc::new(LogStore::new()),
            serial_connected: Arc::new(AtomicBool::new(false)),
            serial_session: Arc::new(AtomicU64::new(0)),
            mcp_server: Arc::new(Mutex::new(None)),
            highlights_updated: Arc::new(Notify::new()),
            publish_lock: Arc::new(Mutex::new(())),
        }
    }

    /// Called when the logs are cleared: the next marker is numbered 1 again.
    fn reset_markers(&self) {
        self.marker_counter.store(0, Ordering::SeqCst);
    }

    /// Next numbered marker line (`----- MARK 1 -----`), with a new line id.
    fn next_marker(&self, timestamp: Option<u64>) -> Payload {
        let number = self.marker_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let id = self.message_id_counter.fetch_add(1, Ordering::SeqCst);
        marker_payload(format!("----- MARK {} -----", number), id, timestamp)
    }
}

/// Derives a store record from an emitted payload. `rawline` carries the untouched
/// line whenever a highlight rule rewrote `message`, so it wins when present —
/// MCP consumers must never receive the HTML-decorated variant.
fn record_of(payload: &Payload) -> LogRecord {
    LogRecord {
        id: payload.id,
        text: payload
            .rawline
            .clone()
            .unwrap_or_else(|| payload.message.clone()),
        focus: payload.matched,
        removed: payload.removed_line,
        timestamp: payload.timestamp,
        marker: payload.marker,
    }
}

/// Records a batch and emits it as a full replacement of the webview's log list.
async fn publish_replace(app: &AppHandle<impl Runtime>, results: Vec<Payload>) {
    let state = app.state::<AppState>();
    let _publishing = state.publish_lock.lock().await;
    replace_and_emit(app, results).await;
}

/// [`publish_replace`], for a caller already holding the publication lock.
async fn replace_and_emit(app: &AppHandle<impl Runtime>, results: Vec<Payload>) {
    let records: Vec<LogRecord> = results.iter().map(record_of).collect();
    app.state::<AppState>().log_store.replace(records).await;

    let focus: Vec<Payload> = results.iter().filter(|p| p.matched).cloned().collect();
    let _ = app.emit("serial-datas", results);
    let _ = app.emit("serial-datas-focus", focus);
}

/// Records a batch and emits it as an append to the webview's log list.
async fn publish_append(app: &AppHandle<impl Runtime>, results: Vec<Payload>) {
    let state = app.state::<AppState>();
    let _publishing = state.publish_lock.lock().await;
    let records: Vec<LogRecord> = results.iter().map(record_of).collect();
    state.log_store.append(records).await;

    let focus: Vec<Payload> = results.iter().filter(|p| p.matched).cloned().collect();
    let _ = app.emit("serial-datas-append", results);
    let _ = app.emit("serial-datas-focus-append", focus);
}

/// Records a single line, writes it to the log file and emits it as a `serial-data` event.
/// Used for the lines received from the serial port, system messages and markers appended at
/// the end of the log, which are exactly the lines saved to [log files](log_file).
async fn publish_one(app: &AppHandle<impl Runtime>, payload: Payload) {
    let state = app.state::<AppState>();
    let publishing = state.publish_lock.lock().await;
    let record = record_of(&payload);
    let log_file_error = state
        .log_files
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .write(&record.text, payload.timestamp);
    state.log_store.append(vec![record]).await;
    let _ = app.emit("serial-data", payload);
    // Released before the error message, which is published too
    drop(publishing);
    // Not written to the file: writing is paused after a failure
    if let Some(error) = log_file_error {
        Box::pin(emit_system_msg(app, format!("Log file error: {}", error))).await;
    }
}

/// Processes `lines` and their reception times through the current highlight rules, in parallel.
async fn process_batch(app: &AppHandle<impl Runtime>, lines: Vec<(String, Option<u64>)>) -> Vec<Payload> {
    let state = app.state::<AppState>();
    let highlights_vec = state.highlights.lock().await.clone();
    let start_id = state
        .message_id_counter
        .fetch_add(lines.len() as u64, Ordering::SeqCst);

    lines
        .into_par_iter()
        .enumerate()
        .map(|(i, (line, timestamp))| process_line(line, &highlights_vec, start_id + i as u64, timestamp))
        .collect()
}

fn default_true() -> bool { true }

/// Parses a comma-separated list of positive capture group indices (e.g. "1,2,3"),
/// deduplicating and discarding invalid entries.
fn parse_custom_groups(custom_select: &str) -> Vec<usize> {
    let mut seen = HashSet::new();
    custom_select
        .split(',')
        .filter_map(|part| part.trim().parse::<usize>().ok())
        .filter(|idx| *idx > 0)
        .filter(|idx| seen.insert(*idx))
        .collect()
}

/// Merges overlapping byte-range spans and removes empty ones.
fn normalize_spans(mut spans: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    spans.retain(|(start, end)| start < end);
    spans.sort_by_key(|(start, end)| (*start, *end));

    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in spans {
        if let Some(last) = merged.last_mut() {
            if start <= last.1 {
                if end > last.1 {
                    last.1 = end;
                }
                continue;
            }
        }
        merged.push((start, end));
    }
    merged
}

/// Collects the byte ranges (relative to the whole match start) for the requested capture groups.
fn collect_selected_group_spans(
    captures: &regex::Captures<'_>,
    selected_groups: &[usize],
) -> Vec<(usize, usize)> {
    let Some(whole_match) = captures.get(0) else {
        return Vec::new();
    };
    let match_start = whole_match.start();

    let mut spans: Vec<(usize, usize)> = Vec::new();
    for group_idx in selected_groups {
        if let Some(group_match) = captures.get(*group_idx) {
            if group_match.start() >= match_start && group_match.end() <= whole_match.end() {
                spans.push((
                    group_match.start() - match_start,
                    group_match.end() - match_start,
                ));
            }
        }
    }
    normalize_spans(spans)
}

/// Collects non-overlapping colored spans from all advanced selections. Spans are sorted
/// by (start, end) and one overlapping an already kept span is skipped.
fn collect_advanced_colored_spans<'a>(
    captures: &regex::Captures<'_>,
    advanced_custom: &'a [AdvancedSelectionSetting],
) -> Vec<ColoredSpan<'a>> {
    let mut colored_spans: Vec<ColoredSpan> = Vec::new();

    for selection in advanced_custom {
        let spans = collect_selected_group_spans(captures, &selection.custom_groups);
        for (start, end) in spans {
            colored_spans.push(ColoredSpan {
                start,
                end,
                color: &selection.color,
            });
        }
    }

    colored_spans.sort_by_key(|span| (span.start, span.end));

    let mut resolved: Vec<ColoredSpan> = Vec::new();
    for span in colored_spans {
        if let Some(last) = resolved.last() {
            if span.start < last.end {
                continue;
            }
        }
        resolved.push(span);
    }

    resolved
}

/// Collects the union of all group indices across all advanced selections (for removal).
fn collect_advanced_groups_for_remove(advanced_custom: &[AdvancedSelectionSetting]) -> Vec<usize> {
    let mut seen = HashSet::new();
    let mut groups: Vec<usize> = Vec::new();

    for selection in advanced_custom {
        for group in &selection.custom_groups {
            if seen.insert(*group) {
                groups.push(*group);
            }
        }
    }

    groups
}

/// Byte ranges of `text` a `remove` rule deletes: the selected capture groups in custom
/// mode (the whole match when none of them matched), the whole matches otherwise.
fn removal_spans(hl: &HighlightSettings, text: &str) -> Vec<(usize, usize)> {
    let mut spans: Vec<(usize, usize)> = Vec::new();
    if hl.is_regex && hl.select_mode == HighlightSelectMode::Custom {
        let groups = if hl.advanced_custom.is_empty() {
            hl.custom_groups.clone()
        } else {
            collect_advanced_groups_for_remove(&hl.advanced_custom)
        };
        for captures in hl.matcher.captures_iter(text) {
            let Some(whole_match) = captures.get(0) else { continue };
            let selected = collect_selected_group_spans(&captures, &groups);
            if selected.is_empty() {
                spans.push((whole_match.start(), whole_match.end()));
            } else {
                let offset = whole_match.start();
                spans.extend(selected.into_iter().map(|(start, end)| (offset + start, offset + end)));
            }
        }
    } else {
        spans.extend(hl.matcher.find_iter(text).map(|m| (m.start(), m.end())));
    }
    normalize_spans(spans)
}

/// Byte ranges of `text` a highlight rule colors, with their color: the selected capture
/// groups in custom mode (the whole match when none of them matched), the whole matches otherwise.
fn colored_spans<'a>(hl: &'a HighlightSettings, text: &str) -> Vec<ColoredSpan<'a>> {
    let mut spans: Vec<ColoredSpan> = Vec::new();
    if hl.is_regex && hl.select_mode == HighlightSelectMode::Custom {
        for captures in hl.matcher.captures_iter(text) {
            let Some(whole_match) = captures.get(0) else { continue };
            let offset = whole_match.start();
            let selected: Vec<ColoredSpan> = if hl.advanced_custom.is_empty() {
                collect_selected_group_spans(&captures, &hl.custom_groups)
                    .into_iter()
                    .map(|(start, end)| ColoredSpan { start, end, color: &hl.color })
                    .collect()
            } else {
                collect_advanced_colored_spans(&captures, &hl.advanced_custom)
            };
            if selected.is_empty() {
                spans.push(ColoredSpan { start: whole_match.start(), end: whole_match.end(), color: &hl.color });
            } else {
                spans.extend(selected.into_iter().map(|span| ColoredSpan {
                    start: offset + span.start,
                    end: offset + span.end,
                    ..span
                }));
            }
        }
    } else {
        spans.extend(hl.matcher.find_iter(text).map(|m| ColoredSpan {
            start: m.start(),
            end: m.end(),
            color: &hl.color,
        }));
    }
    spans
}

/// Escapes the characters that have a meaning in HTML text and attribute values. Line breaks
/// become spaces: a line is shown on a single row of fixed height, which a break would overflow
/// (the HTML parser turns a lone `\r` into a break too). Spaces keep the text offsets unchanged.
fn html_escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\r' | '\n' => escaped.push(' '),
            _ => escaped.push(c),
        }
    }
    escaped
}

/// A log line being processed: the text left by `remove` rules and the color of each byte.
/// Rules only ever see this raw text, never HTML; the markup is built once by [`Self::to_html`].
struct StyledLine<'a> {
    text: String,
    /// Color of each byte of `text`. A later rule overrides an earlier one.
    colors: Vec<Option<&'a str>>,
}

impl<'a> StyledLine<'a> {
    fn new(text: String) -> Self {
        let colors = vec![None; text.len()];
        Self { text, colors }
    }

    fn color(&mut self, span: &ColoredSpan<'a>) {
        for color in &mut self.colors[span.start..span.end] {
            *color = Some(span.color);
        }
    }

    /// Deletes sorted, non-overlapping byte ranges, with their colors.
    fn remove(&mut self, spans: &[(usize, usize)]) {
        let mut text = String::with_capacity(self.text.len());
        let mut colors = Vec::with_capacity(self.colors.len());
        let mut cursor = 0usize;
        for &(start, end) in spans.iter().chain(std::iter::once(&(self.text.len(), self.text.len()))) {
            text.push_str(&self.text[cursor..start]);
            colors.extend_from_slice(&self.colors[cursor..start]);
            cursor = end;
        }
        self.text = text;
        self.colors = colors;
    }

    fn clear(&mut self) {
        self.remove(&[(0, self.text.len())]);
    }

    /// Escaped HTML with one `<span>` per run of same-colored text.
    fn to_html(&self) -> String {
        let mut html = String::with_capacity(self.text.len());
        let mut current: Option<&str> = None;
        let mut run_start = 0usize;
        let flush = |html: &mut String, color: Option<&str>, run: &str| {
            if run.is_empty() {
                return;
            }
            match color {
                Some(color) => {
                    html.push_str(&format!("<span style=\"color:{};\">", html_escape(color)));
                    html.push_str(&html_escape(run));
                    html.push_str("</span>");
                }
                None => html.push_str(&html_escape(run)),
            }
        };
        for (index, _) in self.text.char_indices() {
            let color = self.colors[index];
            if color != current {
                flush(&mut html, current, &self.text[run_start..index]);
                current = color;
                run_start = index;
            }
        }
        flush(&mut html, current, &self.text[run_start..]);
        html
    }
}

/// Applies all highlight rules to a single raw log line and returns the processed [`Payload`].
/// This function is pure (no I/O, no locking) so it can safely be called from rayon threads.
///
/// Rules are applied in order on the raw text: a `remove` rule changes the text later rules
/// see, a whole-line `remove` stops processing. The HTML message is built at the end, with
/// the log text escaped so it can never be interpreted as markup.
fn process_line(
    input_line: String,
    highlights_vec: &[HighlightSettings],
    message_id: u64,
    timestamp: Option<u64>,
) -> Payload {
    let mut line = StyledLine::new(input_line.clone());
    let mut matched_for_focus = false;
    let mut any_rule_matched = false;
    let mut removed_line = false;

    for hl in highlights_vec {
        if hl.text.is_empty() || !hl.matcher.is_match(&line.text) {
            continue;
        }
        any_rule_matched = true;

        if hl.remove {
            if hl.select_mode == HighlightSelectMode::WholeLine {
                line.clear();
                removed_line = true;
                break;
            }
            let spans = removal_spans(hl, &line.text);
            line.remove(&spans);
        } else if hl.select_mode == HighlightSelectMode::WholeLine {
            line.color(&ColoredSpan { start: 0, end: line.text.len(), color: &hl.color });
        } else {
            for span in colored_spans(hl, &line.text) {
                line.color(&span);
            }
        }

        if hl.focus && !hl.remove {
            matched_for_focus = true;
        }
    }

    let message = line.to_html();
    // The frontend and the log store fall back to `message` when `rawline` is missing, so it
    // must be set whenever the message differs from the raw line (escaping included).
    let rawline = if any_rule_matched || message != input_line {
        Some(input_line)
    } else {
        None
    };
    Payload {
        id: message_id,
        message,
        matched: matched_for_focus,
        rawline,
        removed_line,
        timestamp,
        marker: false,
    }
}

async fn parse_log_line(input_line: String, emitter: tauri::AppHandle) -> Payload {
    let highlights_vec = emitter.state::<AppState>().highlights.lock().await.clone();
    let message_id = emitter.state::<AppState>().message_id_counter.fetch_add(1, Ordering::SeqCst);
    process_line(input_line, &highlights_vec, message_id, Some(now_ms()))
}

/// Replaces the whole log with generated `lines` (demo), which have no reception time.
#[tauri::command]
async fn add_logs_line(lines: Vec<String>, emitter: tauri::AppHandle) -> Result<(), String> {
    let results = process_batch(&emitter, with_timestamp(lines, None)).await;
    publish_replace(&emitter, results).await;
    Ok(())
}

/// Processes a recorded line again through `highlights`, keeping its id, reception time and
/// marker flag.
fn reprocess(record: LogRecord, highlights: &[HighlightSettings]) -> Payload {
    if record.marker {
        marker_payload(record.text, record.id, record.timestamp)
    } else {
        process_line(record.text, highlights, record.id, record.timestamp)
    }
}

/// Re-applies the current highlight rules to the whole log, for the Refresh button and the MCP
/// `refresh_logs` tool. Lines keep their id, reception time and marker flag.
///
/// The log store holds every line shown, so the lines are taken from it and processed in parallel
/// without the publication lock: lines keep being received meanwhile. Under the lock, the lines
/// published meanwhile are processed too and the result replaces the log, so no line received
/// during a Refresh is lost or shown twice.
async fn refresh(app: &AppHandle<impl Runtime>) {
    let state = app.state::<AppState>();
    let highlights = state.highlights.lock().await.clone();
    let mut processed: HashMap<u64, Payload> = state
        .log_store
        .map_records(LogRecord::clone)
        .await
        .into_par_iter()
        .map(|record| (record.id, reprocess(record, &highlights)))
        .collect();

    let _publishing = state.publish_lock.lock().await;
    let results = state
        .log_store
        .map_records(|record| {
            processed
                .remove(&record.id)
                .unwrap_or_else(|| reprocess(record.clone(), &highlights))
        })
        .await;
    replace_and_emit(app, results).await;
}

#[tauri::command]
async fn refresh_logs(app: tauri::AppHandle) -> Result<(), String> {
    refresh(&app).await;
    Ok(())
}

/// Appends a numbered marker line (`----- MARK 1 -----`) to delimit a part of the log, e.g. a
/// reproduction attempt.
#[tauri::command]
async fn add_marker(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let payload = state.next_marker(Some(now_ms()));
    publish_one(&app, payload).await;
    Ok(())
}

/// Inserts a numbered marker line just above the line `before_id`, e.g. to mark where a problem
/// starts in an existing log. The marker is recorded in the log store and returned, not emitted:
/// the webview inserts it itself, in the main and focus lists. `timestamp` is the one of the line
/// above the marker, so the marker does not change which timestamps are shown.
#[tauri::command]
async fn insert_marker(
    before_id: u64,
    timestamp: Option<u64>,
    state: tauri::State<'_, AppState>,
) -> Result<Payload, String> {
    let payload = state.next_marker(timestamp);
    let _publishing = state.publish_lock.lock().await;
    state.log_store.insert_before(before_id, record_of(&payload)).await;
    Ok(payload)
}

/// Settings of the automatic save of the serial log, sent by the Config tab at launch and on
/// every change, see [`log_file`].
#[tauri::command]
fn set_log_file_settings(settings: LogFileSettings, state: tauri::State<'_, AppState>) {
    state
        .log_files
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .set_settings(settings);
}

/// Folder of the log files when none is chosen, shown in the Config tab.
#[tauri::command]
fn get_default_log_folder(state: tauri::State<'_, AppState>) -> String {
    state
        .log_files
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .default_folder()
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
async fn append_logs_line(lines: Vec<String>, emitter: tauri::AppHandle) -> Result<(), String> {
    let results = process_batch(&emitter, with_timestamp(lines, Some(now_ms()))).await;
    publish_append(&emitter, results).await;
    Ok(())
}

/// Converts a rule received from the frontend into its processing form.
/// Returns `None` when its regex does not compile, so the rule is skipped.
fn build_highlight_settings(elem: HighlightMessage) -> Option<HighlightSettings> {
    let pattern = if elem.is_regex {
        elem.text.clone()
    } else {
        regex::escape(&elem.text)
    };
    let matcher = match regex::RegexBuilder::new(&pattern)
        .case_insensitive(!elem.case_sensitive)
        .build()
    {
        Ok(reg) => reg,
        Err(err) => {
            println!("Failed to set regex: {}", err);
            return None;
        }
    };

    let mut select_mode = if elem.whole_line {
        HighlightSelectMode::WholeLine
    } else {
        elem.select_mode
    };

    if !elem.is_regex && select_mode == HighlightSelectMode::Custom {
        select_mode = HighlightSelectMode::Match;
    }

    let advanced_custom = if elem.is_regex && select_mode == HighlightSelectMode::Custom {
        elem.advanced_selections
            .into_iter()
            .map(|selection| AdvancedSelectionSetting {
                color: selection.color,
                custom_groups: parse_custom_groups(&selection.custom_select),
            })
            .filter(|selection| !selection.custom_groups.is_empty())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    let custom_groups = if elem.is_regex && select_mode == HighlightSelectMode::Custom && advanced_custom.is_empty() {
        parse_custom_groups(&elem.custom_select)
    } else {
        Vec::new()
    };

    Some(HighlightSettings {
        _id: elem.id,
        text: elem.text,
        color: elem.color,
        is_regex: elem.is_regex,
        select_mode,
        custom_groups,
        advanced_custom,
        focus: if elem.remove { false } else { elem.focus },
        remove: elem.remove,
        matcher,
    })
}

#[tauri::command]
async fn set_highlights(
    highlights: Vec<HighlightMessage>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let hilights_settings: Vec<HighlightSettings> = highlights
        .into_iter()
        .filter_map(build_highlight_settings)
        .collect();
    *state.highlights.lock().await = hilights_settings;
    state.highlights_updated.notify_waiters();
    Ok(())
}

#[tauri::command]
async fn list_ports() -> Result<Vec<SerialPortEntry>, String> {
    println!("Listing ports...");
    match serialport::available_ports() {
        Ok(ports) => {
            println!("Listing ports... {:?}", ports);
            Ok(ports
                .into_iter()
                .map(|p| {
                    let device_label = match p.port_type {
                        SerialPortType::UsbPort(info) => {
                            let mut label_parts: Vec<String> = Vec::new();

                            if let Some(manufacturer) = info.manufacturer {
                                if !manufacturer.trim().is_empty() {
                                    label_parts.push(manufacturer);
                                }
                            }
                            if let Some(product) = info.product {
                                if !product.trim().is_empty() {
                                    label_parts.push(product);
                                }
                            }

                            if label_parts.is_empty() {
                                format!("USB device {:04x}:{:04x}", info.vid, info.pid)
                            } else {
                                label_parts.join(" ")
                            }
                        }
                        SerialPortType::BluetoothPort => "Bluetooth serial device".to_string(),
                        SerialPortType::PciPort => "PCI serial device".to_string(),
                        SerialPortType::Unknown => "Serial device".to_string(),
                    };

                    SerialPortEntry {
                        port_name: p.port_name,
                        device_label,
                    }
                })
                .collect())
        }
        Err(e) => Err(format!("Failed to list ports: {}", e)),
    }
}

#[tauri::command]
async fn open_port(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    port_name: String,
    port_description: Option<String>,
    baud_rate: u32,
    // When the port is lost, wait for it to come back and reopen it instead of disconnecting
    auto_reconnect: Option<bool>,
) -> Result<(), String> {
    let auto_reconnect = auto_reconnect.unwrap_or(false);
    let session = state.serial_session.fetch_add(1, Ordering::SeqCst) + 1;
    match serialport::new(&port_name, baud_rate).open() {
        Ok(port) => {
            *state.serial_connection.lock().await = Some(port);
            state.serial_connected.store(true, Ordering::SeqCst);
            // A new connection starts a new log file; an automatic reconnection continues it
            state
                .log_files
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .start_session();
            state
                .log_store
                .set_source(LogSource::Serial {
                    port: port_name.clone(),
                    baud_rate,
                })
                .await;
            let desc = port_description.unwrap_or_default();
            emit_system_msg(
                &app,
                format!("Connection to {} ({}) established", port_name, desc),
            ).await;
            let serial = state.serial_connection.clone();
            let app_handle = app.clone();
            let mut port_name_loop = port_name.clone();
            // To find the device again if it comes back under another name
            let identity = available_port_identities()
                .into_iter()
                .find(|(name, _)| *name == port_name)
                .and_then(|(_, identity)| identity);
            tokio::spawn(async move {
                let mut splitter = SerialSplitter::default();
                loop {
                    let mut lock = serial.lock().await;

                    if let Some(ref mut port) = *lock {
                        let mut temp = [0u8; 1];
                        if let Err(e) = port.set_timeout(std::time::Duration::from_millis(1000)) {
                            println!("Failed to set timeout: {}", e);
                        }
                        match port.read(&mut temp) {
                            Ok(1) => {
                                if temp[0] != b'\r'
                                    && temp[0] != b'\n'
                                    && temp[0].is_ascii() == false
                                {
                                    let message_id = app_handle.state::<AppState>().message_id_counter.fetch_add(1, Ordering::SeqCst);
                                    let test = format!("{:#02x} ", &temp[0]);
                                    publish_one(
                                        &app_handle,
                                        Payload {
                                            id:message_id,
                                            message: test,
                                            matched: false,
                                            rawline:None,
                                            removed_line: false,
                                            timestamp: Some(now_ms()),
                                            marker: false,
                                        },
                                    ).await;
                                    continue;
                                }
                                if let Some(line) = splitter.push(temp[0]) {
                                    let line = String::from_utf8_lossy(&line).to_string();
                                    let cur_payload = parse_log_line(line, app_handle.clone()).await;
                                    publish_one(&app_handle, cur_payload).await;
                                }
                            }
                            Ok(_) => {}
                            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                                std::thread::sleep(std::time::Duration::from_millis(2));
                            }
                            Err(_) => {
                                app_handle
                                    .state::<AppState>()
                                    .serial_connected
                                    .store(false, Ordering::SeqCst);
                                if !auto_reconnect {
                                    emit_system_msg(
                                        &app_handle,
                                        format!("Connection to {} lost", port_name_loop),
                                    ).await;
                                    let _ = app_handle.emit("serial-disconnected", ());
                                    break;
                                }
                                // Release the dead port, then wait for the device to come back
                                *lock = None;
                                drop(lock);
                                splitter = SerialSplitter::default();
                                emit_system_msg(
                                    &app_handle,
                                    format!("Connection to {} lost, waiting for it to come back", port_name_loop),
                                ).await;
                                let _ = app_handle.emit("serial-reconnecting", ());
                                let Some(new_name) =
                                    wait_for_port(&app_handle, &port_name_loop, identity.as_ref(), baud_rate, session).await
                                else {
                                    break;
                                };
                                if new_name == port_name_loop {
                                    emit_system_msg(
                                        &app_handle,
                                        format!("Connection to {} re-established", port_name_loop),
                                    ).await;
                                } else {
                                    emit_system_msg(
                                        &app_handle,
                                        format!("Connection to {} re-established as {}", port_name_loop, new_name),
                                    ).await;
                                    app_handle
                                        .state::<AppState>()
                                        .log_store
                                        .set_source(LogSource::Serial { port: new_name.clone(), baud_rate })
                                        .await;
                                    port_name_loop = new_name;
                                }
                                // Carries the port name, so the Serial tab selects it if it changed
                                let _ = app_handle.emit("serial-reconnected", port_name_loop.clone());
                            }
                        }
                    } else {
                        break;
                    }
                }
            });
            Ok(())
        }
        Err(e) => {
            emit_system_msg(&app, format!("Connection failed: {}", e)).await;
            Err(format!("Failed to open port: {}", e))
        }
    }
}

/// USB identity of a serial port. A USB device reset while its port is still open often comes
/// back under another name (`/dev/ttyACM0` -> `/dev/ttyACM1`), so it is found again by identity.
#[derive(Clone, Debug, PartialEq)]
struct UsbIdentity {
    vid: u16,
    pid: u16,
    serial_number: Option<String>,
}

/// Available ports with their USB identity (`None` for non-USB ports).
fn available_port_identities() -> Vec<(String, Option<UsbIdentity>)> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let identity = match p.port_type {
                SerialPortType::UsbPort(info) => Some(UsbIdentity {
                    vid: info.vid,
                    pid: info.pid,
                    serial_number: info.serial_number,
                }),
                _ => None,
            };
            (p.port_name, identity)
        })
        .collect()
}

/// Port to reopen after `original` was lost, among the `available` ports:
/// - without USB identity, `original` itself (it may not be listed, e.g. a pseudo terminal);
/// - with a serial number, the port of the same device, whatever its name;
/// - without serial number, `original` if it is that device again, otherwise the only port with the
///   same VID/PID: when there are several, the device cannot be told apart, so none is chosen.
fn find_reconnect_port(
    original: &str,
    identity: Option<&UsbIdentity>,
    available: &[(String, Option<UsbIdentity>)],
) -> Option<String> {
    let Some(identity) = identity else {
        return Some(original.to_string());
    };
    let candidates: Vec<&String> = available
        .iter()
        .filter(|(_, port)| {
            port.as_ref().is_some_and(|port| {
                port.vid == identity.vid
                    && port.pid == identity.pid
                    && (identity.serial_number.is_none() || port.serial_number == identity.serial_number)
            })
        })
        .map(|(name, _)| name)
        .collect();
    if candidates.iter().any(|name| *name == original) {
        return Some(original.to_string());
    }
    if identity.serial_number.is_some() || candidates.len() == 1 {
        return candidates.first().map(|name| name.to_string());
    }
    None
}

/// Tries every 500 ms to reopen the port lost under `port_name`, found again by its USB identity
/// when it has one. Returns the name it was reopened under, or `None` if the session was closed or
/// replaced meanwhile (Disconnect, or a new Connect).
async fn wait_for_port(
    app: &tauri::AppHandle,
    port_name: &str,
    identity: Option<&UsbIdentity>,
    baud_rate: u32,
    session: u64,
) -> Option<String> {
    let state = app.state::<AppState>();
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if state.serial_session.load(Ordering::SeqCst) != session {
            return None;
        }
        let Some(name) = find_reconnect_port(port_name, identity, &available_port_identities()) else {
            continue;
        };
        if let Ok(port) = serialport::new(&name, baud_rate).open() {
            let mut connection = state.serial_connection.lock().await;
            // Checked again under the lock: a Disconnect may have happened while opening
            if state.serial_session.load(Ordering::SeqCst) != session {
                return None;
            }
            *connection = Some(port);
            state.serial_connected.store(true, Ordering::SeqCst);
            return Some(name);
        }
    }
}

#[tauri::command]
async fn close_port(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.serial_session.fetch_add(1, Ordering::SeqCst);
    *state.serial_connection.lock().await = None;
    state.serial_connected.store(false, Ordering::SeqCst);
    emit_system_msg(&app, "Connection closed".to_string()).await;
    Ok(())
}

/// Clears the log store when the user clears the main log, so MCP clients see the same log.
/// Unlike the MCP `clear_logs` tool, it does not emit `logs-cleared`: the window already
/// cleared what the user asked for.
#[tauri::command]
async fn clear_logs(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let _publishing = state.publish_lock.lock().await;
    state.log_store.clear().await;
    state.reset_markers();
    Ok(())
}

/// Opens a file once: its lines replace the logs. Decoded and split like a followed file,
/// except that the last line is kept even without a trailing newline.
#[tauri::command]
async fn open_file(
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mut splitter = TailSplitter::default();
    let mut lines = splitter.feed(&String::from_utf8_lossy(&bytes));
    lines.extend(splitter.finish());

    state.log_store.set_source(LogSource::File { path }).await;
    // The real reception time of a file's lines is unknown
    let results = process_batch(&app, with_timestamp(lines, None)).await;
    publish_replace(&app, results).await;
    Ok(())
}

#[tauri::command]
async fn watch_file(
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Signal any existing watcher to stop, then re-arm
    state.file_watch_active.store(false, Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    state.file_watch_active.store(true, Ordering::SeqCst);

    // Read initial content and track the byte position actually consumed
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let (content, consumed) = decode_utf8(&bytes);
    let mut splitter = TailSplitter::default();
    let lines = splitter.feed(&content);

    state
        .log_store
        .set_source(LogSource::FileWatch { path: path.clone() })
        .await;

    // Emit initial batch (replaces current logs); its reception time is unknown
    let results = process_batch(&app, with_timestamp(lines, None)).await;
    publish_replace(&app, results).await;

    let active = state.file_watch_active.clone();
    let app_handle = app.clone();

    tokio::spawn(async move {
        let mut last_size = consumed as u64;

        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;

            if !active.load(Ordering::SeqCst) {
                break;
            }

            let metadata = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => break,
            };
            let new_size = metadata.len();

            if new_size > last_size {
                use std::io::{Read, Seek, SeekFrom};
                let mut bytes = Vec::new();
                let read = std::fs::File::open(&path).and_then(|mut file| {
                    file.seek(SeekFrom::Start(last_size))?;
                    file.read_to_end(&mut bytes)
                });
                if read.is_err() {
                    continue;
                }
                let (text, consumed) = decode_utf8(&bytes);
                last_size += consumed as u64;

                let new_lines = splitter.feed(&text);
                if !new_lines.is_empty() {
                    let results = process_batch(&app_handle, with_timestamp(new_lines, Some(now_ms()))).await;
                    publish_append(&app_handle, results).await;
                }
            } else if new_size < last_size {
                // File truncated/rotated — restart from beginning
                last_size = 0;
                splitter = TailSplitter::default();
            }
        }

        app_handle
            .state::<AppState>()
            .log_store
            .clear_source_if_watching(&path)
            .await;
        let _ = app_handle.emit("file-watch-stopped", ());
    });

    Ok(())
}

#[tauri::command]
async fn stop_file_watch(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.file_watch_active.store(false, Ordering::SeqCst);
    Ok(())
}

/// Reported to the UI so it can display the URL to hand to an agent.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct McpStatus {
    running: bool,
    url: Option<String>,
    port: Option<u16>,
}

/// Starts the MCP server on loopback unless one is already running, in which case the
/// existing one is reported as-is rather than rebound. `port` 0 picks a free port.
async fn ensure_mcp_server(app: &tauri::AppHandle, port: u16) -> Result<McpStatus, String> {
    let state = app.state::<AppState>();
    let mut slot = state.mcp_server.lock().await;

    if let Some(existing) = slot.as_ref() {
        return Ok(McpStatus {
            running: true,
            url: Some(existing.url()),
            port: Some(existing.addr.port()),
        });
    }

    let handle = mcp::start(
        port,
        state.log_store.clone(),
        state.serial_connected.clone(),
        state.file_watch_active.clone(),
        app.clone(),
    )
    .await?;

    let status = McpStatus {
        running: true,
        url: Some(handle.url()),
        port: Some(handle.addr.port()),
    };
    let url = handle.url();
    *slot = Some(handle);
    // Released before emitting: emit_system_msg records into the log store, and
    // holding this lock across it serves no purpose.
    drop(slot);

    emit_system_msg(app, format!("MCP server listening on {}", url)).await;
    Ok(status)
}

#[tauri::command]
async fn start_mcp_server(port: Option<u16>, app: tauri::AppHandle) -> Result<McpStatus, String> {
    ensure_mcp_server(&app, port.unwrap_or(DEFAULT_MCP_PORT)).await
}

#[tauri::command]
async fn stop_mcp_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<McpStatus, String> {
    if let Some(handle) = state.mcp_server.lock().await.take() {
        handle.stop();
        emit_system_msg(&app, "MCP server stopped".to_string()).await;
    }
    Ok(McpStatus {
        running: false,
        url: None,
        port: None,
    })
}

#[tauri::command]
async fn get_mcp_status(state: tauri::State<'_, AppState>) -> Result<McpStatus, String> {
    let slot = state.mcp_server.lock().await;
    Ok(match slot.as_ref() {
        Some(handle) => McpStatus {
            running: true,
            url: Some(handle.url()),
            port: Some(handle.addr.port()),
        },
        None => McpStatus {
            running: false,
            url: None,
            port: None,
        },
    })
}
fn create_config_dir(app: &mut tauri::App) {
    match fs::create_dir_all(app.path().app_config_dir().unwrap()) {
        Ok(_) => {}
        Err(err) => {
            println!("Unable to create dir  {}", err);
        }
    };
}
/// Default MCP port. Picked to be memorable and outside the ephemeral range;
/// the UI can request another one, and 0 asks the OS for any free port.
const DEFAULT_MCP_PORT: u16 = 9339;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    builder
        .setup(|app| {
            create_config_dir(app);

            // Default log file folder: in the user data folder, named after the application
            // rather than its identifier
            if let Ok(data_dir) = app.path().data_dir() {
                app.state::<AppState>()
                    .log_files
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .set_default_folder(data_dir.join("KazeSerial").join("logs"));
            }

            // `KAZESERIAL_MCP_PORT` starts the MCP server at launch, so an agent-driven
            // session does not require clicking the toolbar button first. Use 0 to let
            // the OS pick a free port; the chosen URL is printed into the log.
            if let Some(port) = std::env::var("KAZESERIAL_MCP_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = ensure_mcp_server(&handle, port).await {
                        println!("Failed to start MCP server on port {}: {}", port, err);
                    }
                });
            }
            Ok(())
        })
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            list_ports,
            open_port,
            close_port,
            set_highlights,
            add_logs_line,
            append_logs_line,
            refresh_logs,
            clear_logs,
            add_marker,
            insert_marker,
            set_log_file_settings,
            get_default_log_folder,
            open_file,
            watch_file,
            stop_file_watch,
            start_mcp_server,
            stop_mcp_server,
            get_mcp_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod reconnect_tests {
    use super::*;

    fn usb(vid: u16, pid: u16, serial: Option<&str>) -> Option<UsbIdentity> {
        Some(UsbIdentity { vid, pid, serial_number: serial.map(str::to_string) })
    }

    fn port(name: &str, identity: Option<UsbIdentity>) -> (String, Option<UsbIdentity>) {
        (name.to_string(), identity)
    }

    #[test]
    fn non_usb_port_is_reopened_by_name() {
        assert_eq!(find_reconnect_port("/dev/ttyS0", None, &[]), Some("/dev/ttyS0".to_string()));
    }

    #[test]
    fn device_with_serial_number_is_found_under_another_name() {
        let identity = usb(0x303a, 0x1001, Some("D0:CF"));
        let available = [port("/dev/ttyUSB0", usb(0x0403, 0x6001, Some("FTAL"))), port("/dev/ttyACM1", identity.clone())];
        assert_eq!(find_reconnect_port("/dev/ttyACM0", identity.as_ref(), &available), Some("/dev/ttyACM1".to_string()));
    }

    #[test]
    fn same_name_is_preferred() {
        let identity = usb(0x303a, 0x1001, None);
        let available = [port("/dev/ttyACM1", identity.clone()), port("/dev/ttyACM0", identity.clone())];
        assert_eq!(find_reconnect_port("/dev/ttyACM0", identity.as_ref(), &available), Some("/dev/ttyACM0".to_string()));
    }

    #[test]
    fn device_not_back_yet_is_not_found() {
        let identity = usb(0x303a, 0x1001, Some("D0:CF"));
        let available = [port("/dev/ttyACM0", usb(0x303a, 0x1001, Some("OTHER")))];
        assert_eq!(find_reconnect_port("/dev/ttyACM0", identity.as_ref(), &available), None);
    }

    #[test]
    fn without_serial_number_a_single_candidate_is_accepted() {
        let identity = usb(0x0403, 0x6001, None);
        let available = [port("/dev/ttyUSB1", identity.clone())];
        assert_eq!(find_reconnect_port("/dev/ttyUSB0", identity.as_ref(), &available), Some("/dev/ttyUSB1".to_string()));
    }

    #[test]
    fn without_serial_number_several_candidates_are_ambiguous() {
        let identity = usb(0x0403, 0x6001, None);
        let available = [port("/dev/ttyUSB1", identity.clone()), port("/dev/ttyUSB2", identity.clone())];
        assert_eq!(find_reconnect_port("/dev/ttyUSB0", identity.as_ref(), &available), None);
    }
}

#[cfg(test)]
mod process_line_tests {
    use super::*;

    const R: &str = "R";
    const G: &str = "G";

    /// Plain-text, case-sensitive highlight rule, as the frontend sends it.
    fn rule(text: &str, color: &str) -> HighlightMessage {
        HighlightMessage {
            id: 0,
            text: text.to_string(),
            color: color.to_string(),
            is_regex: false,
            case_sensitive: true,
            select_mode: HighlightSelectMode::Match,
            custom_select: String::new(),
            whole_line: false,
            advanced_selections: Vec::new(),
            focus: false,
            remove: false,
        }
    }

    fn regex(text: &str, color: &str) -> HighlightMessage {
        HighlightMessage { is_regex: true, ..rule(text, color) }
    }

    fn whole_line(text: &str, color: &str) -> HighlightMessage {
        HighlightMessage { whole_line: true, select_mode: HighlightSelectMode::WholeLine, ..rule(text, color) }
    }

    fn remove(rule: HighlightMessage) -> HighlightMessage {
        HighlightMessage { remove: true, ..rule }
    }

    /// Regex rule in advanced mode, with `(color, groups)` selections.
    fn advanced(text: &str, color: &str, selections: &[(&str, &str)]) -> HighlightMessage {
        HighlightMessage {
            select_mode: HighlightSelectMode::Custom,
            advanced_selections: selections
                .iter()
                .map(|(color, groups)| AdvancedSelectionMessage {
                    color: color.to_string(),
                    custom_select: groups.to_string(),
                })
                .collect(),
            ..regex(text, color)
        }
    }

    fn process(line: &str, rules: Vec<HighlightMessage>) -> Payload {
        let settings: Vec<HighlightSettings> =
            rules.into_iter().filter_map(build_highlight_settings).collect();
        process_line(line.to_string(), &settings, 1, None)
    }

    /// Renders the HTML message as the user sees it: text with `{COLOR:...}` around colored
    /// runs. Nested spans resolve to the innermost color, like in the browser.
    fn rendered(html: &str) -> String {
        let mut stack: Vec<String> = Vec::new();
        let mut chars: Vec<(char, Option<String>)> = Vec::new();
        let mut rest = html;
        while let Some(c) = rest.chars().next() {
            if let Some(after) = rest.strip_prefix("<span style=\"color:") {
                let end = after.find("\">").expect("unterminated span tag");
                let color = html_unescape(after[..end].trim_end_matches(';'));
                stack.push(color);
                rest = &after[end + 2..];
            } else if let Some(after) = rest.strip_prefix("</span>") {
                stack.pop().expect("unbalanced span");
                rest = after;
            } else if c == '<' {
                panic!("unexpected markup in {:?}", html);
            } else if c == '&' {
                let end = rest.find(';').expect("unterminated entity");
                let decoded = html_unescape(&rest[..=end]);
                chars.extend(decoded.chars().map(|d| (d, stack.last().cloned())));
                rest = &rest[end + 1..];
            } else {
                chars.push((c, stack.last().cloned()));
                rest = &rest[c.len_utf8()..];
            }
        }
        assert!(stack.is_empty(), "unbalanced span in {:?}", html);

        let mut out = String::new();
        let mut current: Option<String> = None;
        for (c, color) in chars {
            if color != current {
                if current.is_some() {
                    out.push('}');
                }
                if let Some(color) = &color {
                    out.push_str(&format!("{{{}:", color));
                }
                current = color;
            }
            out.push(c);
        }
        if current.is_some() {
            out.push('}');
        }
        out
    }

    fn html_unescape(text: &str) -> String {
        text.replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&amp;", "&")
    }

    #[test]
    fn line_without_match_is_unchanged() {
        let payload = process("abc", vec![rule("x", R)]);
        assert_eq!(payload.message, "abc");
        assert_eq!(payload.rawline, None);
        assert!(!payload.matched);
    }

    #[test]
    fn plain_text_highlights_every_occurrence() {
        let payload = process("err x err", vec![rule("err", R)]);
        assert_eq!(rendered(&payload.message), "{R:err} x {R:err}");
        assert_eq!(payload.rawline.as_deref(), Some("err x err"));
    }

    #[test]
    fn plain_text_case_insensitive_keeps_original_casing() {
        let rule = HighlightMessage { case_sensitive: false, ..rule("err", R) };
        assert_eq!(rendered(&process("Err x ERR", vec![rule]).message), "{R:Err} x {R:ERR}");
    }

    #[test]
    fn regex_highlights_every_match() {
        assert_eq!(rendered(&process("a1 b22", vec![regex(r"\d+", R)]).message), "a{R:1} b{R:22}");
    }

    #[test]
    fn regex_case_insensitive() {
        let rule = HighlightMessage { case_sensitive: false, ..regex("ERR", R) };
        assert_eq!(rendered(&process("err", vec![rule]).message), "{R:err}");
    }

    #[test]
    fn whole_line_colors_the_whole_line() {
        assert_eq!(rendered(&process("abc", vec![whole_line("b", R)]).message), "{R:abc}");
    }

    #[test]
    fn whole_line_rule_follows_rule_order_priority() {
        assert_eq!(rendered(&process("abc", vec![whole_line("a", R), rule("b", G)]).message), "{R:a}{G:b}{R:c}");
        assert_eq!(rendered(&process("abc", vec![rule("b", G), whole_line("a", R)]).message), "{R:abc}");
    }

    #[test]
    fn last_whole_line_rule_wins() {
        assert_eq!(rendered(&process("abc", vec![whole_line("a", R), whole_line("b", G)]).message), "{G:abc}");
    }

    #[test]
    fn later_rule_wins_on_overlap() {
        assert_eq!(rendered(&process("error", vec![rule("error", R), rule("err", G)]).message), "{G:err}{R:or}");
    }

    #[test]
    fn remove_plain_text() {
        let payload = process("a--b", vec![remove(rule("--", R))]);
        assert_eq!(payload.message, "ab");
        assert_eq!(payload.rawline.as_deref(), Some("a--b"));
        assert!(!payload.removed_line);
    }

    #[test]
    fn later_rules_see_the_text_left_by_remove() {
        assert_eq!(rendered(&process("a-b", vec![remove(rule("-", R)), rule("ab", G)]).message), "{G:ab}");
    }

    #[test]
    fn remove_regex() {
        assert_eq!(process("abc   ", vec![remove(regex(r"\s+$", R))]).message, "abc");
    }

    #[test]
    fn remove_whole_line_stops_processing() {
        let payload = process("abc", vec![remove(whole_line("b", R)), HighlightMessage { focus: true, ..rule("a", G) }]);
        assert_eq!(payload.message, "");
        assert!(payload.removed_line);
        assert!(!payload.matched);
        assert_eq!(payload.rawline.as_deref(), Some("abc"));
    }

    #[test]
    fn advanced_colors_each_group() {
        let rule = advanced(r"(\w+)=(\d+)", R, &[(R, "1"), (G, "2")]);
        assert_eq!(rendered(&process("x=1 y=22", vec![rule]).message), "{R:x}={G:1} {R:y}={G:22}");
    }

    #[test]
    fn advanced_overlapping_groups_earliest_then_shortest_wins() {
        // Groups are sorted by (start, end); a group overlapping an already kept one is skipped
        let rule = advanced(r"((a)b)", R, &[(G, "1"), (R, "2")]);
        assert_eq!(rendered(&process("ab", vec![rule]).message), "{R:a}b");
    }

    #[test]
    fn advanced_without_groups_colors_the_whole_match() {
        let rule = advanced(r"\d+", G, &[(R, "")]);
        assert_eq!(rendered(&process("a12", vec![rule]).message), "a{G:12}");
    }

    #[test]
    fn remove_advanced_removes_selected_groups() {
        let rule = remove(advanced(r"(\d+)-(\d+)", R, &[(R, "1")]));
        assert_eq!(process("a 12-34 b", vec![rule]).message, "a -34 b");
    }

    #[test]
    fn focus_is_set_by_highlight_rules_only() {
        assert!(process("abc", vec![HighlightMessage { focus: true, ..rule("b", R) }]).matched);
        assert!(!process("abc", vec![remove(HighlightMessage { focus: true, ..rule("b", R) })]).matched);
    }

    #[test]
    fn html_characters_in_the_log_are_escaped() {
        let payload = process("if a <b && c> d", vec![]);
        assert_eq!(payload.message, "if a &lt;b &amp;&amp; c&gt; d");
        // Refresh, Save and the MCP store read `rawline` when present, `message` otherwise
        assert_eq!(payload.rawline.as_deref(), Some("if a <b && c> d"));
    }

    #[test]
    fn line_breaks_in_the_log_are_shown_as_spaces() {
        let payload = process("a\rb\nc", vec![rule("b", R)]);
        assert_eq!(payload.message, "a <span style=\"color:R;\">b</span> c");
        assert_eq!(payload.rawline.as_deref(), Some("a\rb\nc"));
    }

    #[test]
    fn html_in_the_log_is_never_interpreted() {
        let payload = process("<img src=x onerror=alert(1)>", vec![rule("img", R)]);
        assert_eq!(
            payload.message,
            "&lt;<span style=\"color:R;\">img</span> src=x onerror=alert(1)&gt;"
        );
        assert_eq!(rendered(&payload.message), "<{R:img} src=x onerror=alert(1)>");
    }

    #[test]
    fn rules_can_match_html_characters() {
        assert_eq!(rendered(&process("a <tag> b", vec![rule("<tag>", R)]).message), "a {R:<tag>} b");
        assert_eq!(rendered(&process("x & y", vec![regex("&", R)]).message), "x {R:&} y");
    }

    #[test]
    fn rules_do_not_match_entities_or_markup() {
        let rules = vec![rule("e", "#cc7f12"), rule("lt", G), rule("span", G), regex(r"\d", G)];
        assert_eq!(rendered(&process("e <", rules).message), "{#cc7f12:e} <");
    }

    #[test]
    fn anchored_regex_matches_after_whole_line_rule() {
        assert_eq!(rendered(&process("ab", vec![whole_line("a", R), regex("^a", G)]).message), "{G:a}{R:b}");
    }

    #[test]
    fn match_can_span_text_colored_by_an_earlier_rule() {
        assert_eq!(rendered(&process("error x", vec![rule("rr", R), rule("error x", G)]).message), "{G:error x}");
    }

    #[test]
    fn color_value_is_escaped() {
        let payload = process("a", vec![rule("a", "red\" onmouseover=\"x")]);
        assert_eq!(payload.message, "<span style=\"color:red&quot; onmouseover=&quot;x;\">a</span>");
    }

    #[test]
    fn reprocessing_rawline_gives_the_same_message() {
        let rules = || vec![rule("b", R), remove(rule("-", G))];
        let first = process("a <b> - &", rules());
        let second = process(first.rawline.as_deref().unwrap(), rules());
        assert_eq!(first.message, second.message);
    }

    #[test]
    fn plain_text_rule_is_not_a_regex() {
        assert_eq!(rendered(&process("a.b axb", vec![rule("a.b", R)]).message), "{R:a.b} axb");
    }

    #[test]
    fn multibyte_characters_are_kept_intact() {
        let payload = process("été ° ok", vec![rule("t", R), remove(rule("°", G))]);
        assert_eq!(rendered(&payload.message), "é{R:t}é  ok");
    }

    #[test]
    fn marker_is_escaped_and_listed_in_focus() {
        let payload = marker_payload("<MARK>".to_string(), 3, Some(7));
        assert_eq!(payload.message, "&lt;MARK&gt;");
        assert_eq!(payload.rawline.as_deref(), Some("<MARK>"));
        assert!(payload.marker && payload.matched && !payload.removed_line);
        assert_eq!((payload.id, payload.timestamp), (3, Some(7)));
    }

    #[test]
    fn timestamp_is_passed_through() {
        let settings: Vec<HighlightSettings> = Vec::new();
        assert_eq!(process_line("a".to_string(), &settings, 1, Some(42)).timestamp, Some(42));
        assert_eq!(process_line("a".to_string(), &settings, 1, None).timestamp, None);
    }

    #[test]
    fn empty_regex_match_counts_as_match_without_color() {
        let payload = process("abc", vec![regex("x*", R)]);
        assert_eq!(rendered(&payload.message), "abc");
        assert_eq!(payload.rawline.as_deref(), Some("abc"));
    }
}

#[cfg(test)]
mod refresh_tests {
    use super::*;
    use tauri::Listener;

    /// Ids of the main log list, updated from the events as `page.tsx` does.
    type Window = Arc<std::sync::Mutex<Vec<u64>>>;

    fn ids_of(payload: &str) -> Vec<u64> {
        let lines: Vec<serde_json::Value> = serde_json::from_str(payload).unwrap();
        lines.iter().map(|line| line["id"].as_u64().unwrap()).collect()
    }

    fn app_with_window() -> (tauri::App<tauri::test::MockRuntime>, Window) {
        let app = tauri::test::mock_app();
        app.manage(AppState::new());
        let window: Window = Default::default();
        let list = window.clone();
        app.listen_any("serial-data", move |event| {
            let line: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
            list.lock().unwrap().push(line["id"].as_u64().unwrap());
        });
        let list = window.clone();
        app.listen_any("serial-datas-append", move |event| list.lock().unwrap().extend(ids_of(event.payload())));
        let list = window.clone();
        app.listen_any("serial-datas", move |event| *list.lock().unwrap() = ids_of(event.payload()));
        (app, window)
    }

    #[test]
    fn lines_received_during_a_refresh_are_kept_once() {
        let (app, window) = app_with_window();
        let handle = app.handle().clone();
        tauri::async_runtime::block_on(async move {
            let lines = (0..20_000).map(|i| format!("line {i}")).collect();
            publish_append(&handle, process_batch(&handle, with_timestamp(lines, Some(1))).await).await;

            // Lines received from the serial port while the log is refreshed again and again
            let serial = handle.clone();
            let receiving = tokio::spawn(async move {
                let state = serial.state::<AppState>();
                for i in 0..2_000 {
                    let id = state.message_id_counter.fetch_add(1, Ordering::SeqCst);
                    publish_one(&serial, process_line(format!("serial {i}"), &[], id, Some(now_ms()))).await;
                    tokio::task::yield_now().await;
                }
            });
            while !receiving.is_finished() {
                refresh(&handle).await;
            }
            receiving.await.unwrap();

            // Counts rather than the lists, which would be unreadable on failure
            let lost = |ids: &[u64]| {
                let ids: HashSet<&u64> = ids.iter().collect();
                (1..=22_000).filter(|id| !ids.contains(id)).count()
            };
            let stored = handle.state::<AppState>().log_store.map_records(|record| record.id).await;
            assert_eq!((lost(&stored), stored.len()), (0, 22_000), "lines lost, lines recorded");
            assert!(stored.windows(2).all(|pair| pair[0] < pair[1]), "lines recorded in order");
            let shown = window.lock().unwrap().clone();
            assert_eq!((lost(&shown), shown.len()), (0, 22_000), "lines lost, lines shown");
            assert!(shown == stored, "the window shows the recorded lines");
        });
    }

    #[test]
    fn refresh_keeps_ids_timestamps_and_markers() {
        let (app, window) = app_with_window();
        let handle = app.handle().clone();
        tauri::async_runtime::block_on(async move {
            let state = handle.state::<AppState>();
            publish_append(&handle, process_batch(&handle, with_timestamp(vec!["a".into(), "b".into()], Some(7))).await).await;
            publish_one(&handle, state.next_marker(Some(8))).await;
            *state.highlights.lock().await = vec![build_highlight_settings(HighlightMessage {
                id: 0,
                text: "b".into(),
                color: "R".into(),
                is_regex: false,
                case_sensitive: true,
                select_mode: HighlightSelectMode::Match,
                custom_select: String::new(),
                whole_line: false,
                advanced_selections: Vec::new(),
                focus: true,
                remove: false,
            })
            .unwrap()];

            refresh(&handle).await;

            let records = state.log_store.map_records(LogRecord::clone).await;
            let summary: Vec<_> = records.iter().map(|r| (r.id, r.text.as_str(), r.timestamp, r.marker, r.focus)).collect();
            assert_eq!(summary, vec![
                (1, "a", Some(7), false, false),
                (2, "b", Some(7), false, true),
                (3, "----- MARK 1 -----", Some(8), true, true),
            ]);
            assert_eq!(*window.lock().unwrap(), vec![1, 2, 3]);
        });
    }
}

#[cfg(test)]
mod system_message_tests {
    use super::*;
    use chrono::TimeZone;
    use tauri::Listener;

    #[test]
    fn system_message_shows_its_timestamp_in_local_time() {
        let app = tauri::test::mock_app();
        app.manage(AppState::new());
        let received = Arc::new(std::sync::Mutex::new(None));
        let slot = received.clone();
        app.listen_any("serial-data", move |event| {
            *slot.lock().unwrap() = Some(serde_json::from_str::<serde_json::Value>(event.payload()).unwrap());
        });

        tauri::async_runtime::block_on(emit_system_msg(app.handle(), "hello".to_string()));

        let payload = received.lock().unwrap().take().expect("a serial-data event");
        let timestamp = payload["timestamp"].as_i64().unwrap();
        let local = chrono::Local.timestamp_millis_opt(timestamp).unwrap();
        assert_eq!(payload["message"], local.format("[%H:%M:%S] KazeSerial: hello").to_string());
    }
}
