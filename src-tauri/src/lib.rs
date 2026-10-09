mod log_store;
mod mcp;
mod tail_splitter;

use log_store::{LogRecord, LogSource, LogStore};
use regex::Regex;
use rayon::prelude::*;
use serialport::{SerialPort, SerialPortType};
use std::collections::HashSet;
use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tail_splitter::{decode_utf8, TailSplitter};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

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
struct ColoredSpan {
    start: usize,
    end: usize,
    color: String,
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
    case_sensitive: bool,
    select_mode: HighlightSelectMode,
    custom_groups: Vec<usize>,   // capture group indices for plain custom mode
    advanced_custom: Vec<AdvancedSelectionSetting>, // per-group color overrides
    focus: bool,
    remove: bool,
    regex: Option<Regex>,        // compiled regex, None for plain-text rules
}

#[derive(Clone, serde::Serialize)]
struct Payload {
    id: u64,
    message: String,
    matched: bool,
    rawline: Option<String>,
    removed_line: bool,
}

/// Returns the current UTC wall-clock time as HH:MM:SS.
fn make_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let h = (secs % 86400) / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}", h, m, s)
}

/// Emits a KazeSerial system message as a regular `serial-data` event.
/// These appear in the log with format `[HH:MM:SS] KazeSerial: {msg}`.
/// The message is processed through the current highlight rules like any other line.
async fn emit_system_msg(app: &tauri::AppHandle, msg: String) {
    let raw = format!("[{}] KazeSerial: {}", make_timestamp(), msg);
    let state = app.state::<AppState>();
    let message_id = state.message_id_counter.fetch_add(1, Ordering::SeqCst);
    let highlights = state.highlights.lock().await.clone();
    let payload = process_line(raw, &highlights, message_id);
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
    file_watch_active: Arc<AtomicBool>,
    /// Every emitted line is recorded here so the MCP server can serve the same
    /// log the user sees. The webview state is no longer the only copy.
    log_store: Arc<LogStore>,
    /// Lock-free mirror of `serial_connection.is_some()`. Reading the connection
    /// itself would contend with the read loop, which holds it across blocking reads.
    serial_connected: Arc<AtomicBool>,
    mcp_server: Arc<Mutex<Option<mcp::McpServerHandle>>>,
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
    }
}

/// Records a batch and emits it as a full replacement of the webview's log list.
async fn publish_replace(app: &tauri::AppHandle, results: Vec<Payload>) {
    let records: Vec<LogRecord> = results.iter().map(record_of).collect();
    app.state::<AppState>().log_store.replace(records).await;

    let focus: Vec<Payload> = results.iter().filter(|p| p.matched).cloned().collect();
    let _ = app.emit("serial-datas", results);
    let _ = app.emit("serial-datas-focus", focus);
}

/// Records a batch and emits it as an append to the webview's log list.
async fn publish_append(app: &tauri::AppHandle, results: Vec<Payload>) {
    let records: Vec<LogRecord> = results.iter().map(record_of).collect();
    app.state::<AppState>().log_store.append(records).await;

    let focus: Vec<Payload> = results.iter().filter(|p| p.matched).cloned().collect();
    let _ = app.emit("serial-datas-append", results);
    let _ = app.emit("serial-datas-focus-append", focus);
}

/// Records a single line and emits it as a `serial-data` event.
async fn publish_one(app: &tauri::AppHandle, payload: Payload) {
    app.state::<AppState>()
        .log_store
        .append(vec![record_of(&payload)])
        .await;
    let _ = app.emit("serial-data", payload);
}

/// Processes `lines` through the current highlight rules, in parallel.
async fn process_batch(app: &tauri::AppHandle, lines: Vec<String>) -> Vec<Payload> {
    let state = app.state::<AppState>();
    let highlights_vec = state.highlights.lock().await.clone();
    let start_id = state
        .message_id_counter
        .fetch_add(lines.len() as u64, Ordering::SeqCst);

    lines
        .into_par_iter()
        .enumerate()
        .map(|(i, line)| process_line(line, &highlights_vec, start_id + i as u64))
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

/// Wraps selected spans of `segment` in a `<span style="color:">` tag.
/// Falls back to wrapping the entire segment when no spans are provided.
fn build_highlighted_segment(segment: &str, spans: &[(usize, usize)], color: &str) -> String {
    let mut output = String::new();
    let mut cursor = 0usize;

    for (start, end) in spans {
        output.push_str(&segment[cursor..*start]);
        output.push_str(&format!("<span style=\"color:{};\">", color));
        output.push_str(&segment[*start..*end]);
        output.push_str("</span>");
        cursor = *end;
    }

    output.push_str(&segment[cursor..]);
    output
}

/// Removes the selected spans from `segment`, keeping surrounding text.
fn build_removed_segment(segment: &str, spans: &[(usize, usize)]) -> String {
    let mut output = String::new();
    let mut cursor = 0usize;

    for (start, end) in spans {
        output.push_str(&segment[cursor..*start]);
        cursor = *end;
    }

    output.push_str(&segment[cursor..]);
    output
}

/// Applies highlighting to a single regex match using a custom group selection.
fn highlight_custom_regex_match(
    captures: &regex::Captures<'_>,
    color: &str,
    selected_groups: &[usize],
) -> String {
    let Some(whole_match) = captures.get(0) else {
        return String::new();
    };

    let segment = whole_match.as_str();
    let mut spans = collect_selected_group_spans(captures, selected_groups);

    if spans.is_empty() {
        spans.push((0, segment.len()));
    }

    build_highlighted_segment(segment, &spans, color)
}

/// Collects non-overlapping colored spans from all advanced selections (first match wins).
fn collect_advanced_colored_spans(
    captures: &regex::Captures<'_>,
    advanced_custom: &[AdvancedSelectionSetting],
) -> Vec<ColoredSpan> {
    let mut colored_spans: Vec<ColoredSpan> = Vec::new();

    for selection in advanced_custom {
        let spans = collect_selected_group_spans(captures, &selection.custom_groups);
        for (start, end) in spans {
            colored_spans.push(ColoredSpan {
                start,
                end,
                color: selection.color.clone(),
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

/// Applies per-group color highlights to a single regex match in advanced mode.
fn highlight_advanced_regex_match(
    captures: &regex::Captures<'_>,
    advanced_custom: &[AdvancedSelectionSetting],
    fallback_color: &str,
) -> String {
    let Some(whole_match) = captures.get(0) else {
        return String::new();
    };

    let segment = whole_match.as_str();
    let spans = collect_advanced_colored_spans(captures, advanced_custom);

    if spans.is_empty() {
        return format!("<span style=\"color:{};\">{}</span>", fallback_color, segment);
    }

    let mut output = String::new();
    let mut cursor = 0usize;

    for span in spans {
        output.push_str(&segment[cursor..span.start]);
        output.push_str(&format!("<span style=\"color:{};\">", span.color));
        output.push_str(&segment[span.start..span.end]);
        output.push_str("</span>");
        cursor = span.end;
    }

    output.push_str(&segment[cursor..]);
    output
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

/// Removes selected capture groups from a single regex match.
fn remove_custom_regex_match(captures: &regex::Captures<'_>, selected_groups: &[usize]) -> String {
    let Some(whole_match) = captures.get(0) else {
        return String::new();
    };

    let segment = whole_match.as_str();
    let spans = collect_selected_group_spans(captures, selected_groups);

    if spans.is_empty() {
        return String::new();
    }

    build_removed_segment(segment, &spans)
}

/// Applies all highlight rules to a single raw log line and returns the processed [`Payload`].
/// This function is pure (no I/O, no locking) so it can safely be called from rayon threads.
fn process_line(input_line: String, highlights_vec: &[HighlightSettings], message_id: u64) -> Payload {
    let rawline = input_line.clone();
    let mut line = input_line;
    let mut matched_for_focus = false;
    let mut should_send_raw = false;
    let mut removed_line = false;
    // Applique le surlignage côté Rust
    for hl in highlights_vec {
        if !hl.text.is_empty() {
            let does_match = if hl.is_regex {
                hl.regex.as_ref().map_or(false, |r| r.is_match(&line))
            } else if hl.case_sensitive {
                line.contains(&hl.text as &str)
            } else {
                line.to_lowercase().contains(&hl.text.to_lowercase() as &str)
            };
            if does_match {
                if hl.remove {
                    if hl.select_mode == HighlightSelectMode::WholeLine {
                        line.clear();
                        removed_line = true;
                        should_send_raw = true;
                        break;
                    }

                    if hl.is_regex {
                        if let Some(ref regex) = hl.regex {
                            if hl.select_mode == HighlightSelectMode::Custom {
                                if hl.advanced_custom.is_empty() {
                                    line = regex
                                        .replace_all(&line, |captures: &regex::Captures<'_>| {
                                            remove_custom_regex_match(captures, &hl.custom_groups)
                                        })
                                        .to_string();
                                } else {
                                    let groups_for_remove = collect_advanced_groups_for_remove(&hl.advanced_custom);
                                    line = regex
                                        .replace_all(&line, |captures: &regex::Captures<'_>| {
                                            remove_custom_regex_match(captures, &groups_for_remove)
                                        })
                                        .to_string();
                                }
                            } else {
                                line = regex.replace_all(&line, "").to_string();
                            }
                        }
                    } else if hl.case_sensitive {
                        line = line.replace(
                            &hl.text as &str,
                            "",
                        );
                    } else {
                        let lower_text = hl.text.to_lowercase();
                        let lower_line = line.to_lowercase();
                        let mut result = String::new();
                        let mut search_from = 0usize;
                        while let Some(pos) = lower_line[search_from..].find(&lower_text as &str) {
                            let abs = search_from + pos;
                            result.push_str(&line[search_from..abs]);
                            search_from = abs + lower_text.len();
                        }
                        result.push_str(&line[search_from..]);
                        line = result;
                    }
                } else {
                    if hl.select_mode == HighlightSelectMode::WholeLine {
                        line = format!("<span style=\"color:{}\">{}</span>", hl.color, line);
                    } else if hl.is_regex {
                        if let Some(ref regex) = hl.regex {
                            if hl.select_mode == HighlightSelectMode::Custom {
                                if hl.advanced_custom.is_empty() {
                                    line = regex
                                        .replace_all(&line, |captures: &regex::Captures<'_>| {
                                            highlight_custom_regex_match(
                                                captures,
                                                &hl.color,
                                                &hl.custom_groups,
                                            )
                                        })
                                        .to_string();
                                } else {
                                    line = regex
                                        .replace_all(&line, |captures: &regex::Captures<'_>| {
                                            highlight_advanced_regex_match(
                                                captures,
                                                &hl.advanced_custom,
                                                &hl.color,
                                            )
                                        })
                                        .to_string();
                                }
                            } else {
                                line = regex
                                    .replace_all(
                                        &line,
                                        format!("<span style=\"color:{};\">$0</span>", hl.color),
                                    )
                                    .to_string();
                            }
                        }
                    } else if hl.case_sensitive {
                        line = line.replace(
                            &hl.text as &str,
                            &format!("<span style=\"color:{}\">{}</span>", hl.color, hl.text),
                        );
                    } else {
                        let lower_text = hl.text.to_lowercase();
                        let lower_line = line.to_lowercase();
                        let mut result = String::new();
                        let mut search_from = 0usize;
                        while let Some(pos) = lower_line[search_from..].find(&lower_text as &str) {
                            let abs = search_from + pos;
                            result.push_str(&line[search_from..abs]);
                            let matched_slice = &line[abs..abs + lower_text.len()];
                            result.push_str(&format!("<span style=\"color:{}\">{}</span>", hl.color, matched_slice));
                            search_from = abs + lower_text.len();
                        }
                        result.push_str(&line[search_from..]);
                        line = result;
                    }
                }
                if hl.focus && !hl.remove {
                    matched_for_focus = true;
                }
                should_send_raw = true;
            }
        }
    }
    if should_send_raw {
        Payload {
            id: message_id,
            message: line,
            matched: matched_for_focus,
            rawline: Some(rawline),
            removed_line,
        }
    } else {
        Payload {
            id: message_id,
            message: line,
            matched: matched_for_focus,
            rawline: None,
            removed_line,
        }
    }
}

async fn parse_log_line(input_line: String, emitter: tauri::AppHandle) -> Payload {
    let highlights_vec = emitter.state::<AppState>().highlights.lock().await.clone();
    let message_id = emitter.state::<AppState>().message_id_counter.fetch_add(1, Ordering::SeqCst);
    process_line(input_line, &highlights_vec, message_id)
}

/// Replaces the whole log with `lines`. `source` labels where they came from for
/// MCP clients; pass `None` to leave the current label alone (e.g. when merely
/// re-applying highlight rules to lines already shown).
#[tauri::command]
async fn add_logs_line(
    lines: Vec<String>,
    source: Option<String>,
    emitter: tauri::AppHandle,
) -> Result<(), String> {
    if let Some(path) = source {
        emitter
            .state::<AppState>()
            .log_store
            .set_source(LogSource::File { path })
            .await;
    }

    let results = process_batch(&emitter, lines).await;
    publish_replace(&emitter, results).await;
    Ok(())
}

#[tauri::command]
async fn append_logs_line(lines: Vec<String>, emitter: tauri::AppHandle) -> Result<(), String> {
    let results = process_batch(&emitter, lines).await;
    publish_append(&emitter, results).await;
    Ok(())
}

#[tauri::command]
async fn set_highlights(
    highlights: Vec<HighlightMessage>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut hilights_settings: Vec<HighlightSettings> = Vec::new();
    for elem in highlights {
        let text = elem.text.clone();
        let cur_regex = if elem.is_regex {
            let pattern = if elem.case_sensitive {
                text.clone()
            } else {
                format!("(?i){}", text)
            };
            match regex::Regex::new(&pattern) {
                Ok(reg) => Some(reg),
                Err(err) => {
                    println!("Failed to set regex: {}", err);
                    continue;
                }
            }
        } else {
            None
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

        hilights_settings.push(HighlightSettings {
            _id: elem.id,
            text: elem.text,
            color: elem.color,
            is_regex: elem.is_regex,
            case_sensitive: elem.case_sensitive,
            select_mode,
            custom_groups,
            advanced_custom,
            focus: if elem.remove { false } else { elem.focus },
            remove: elem.remove,
            regex: cur_regex,
        });
    }
    let mut lock = state.highlights.lock().await;
    *lock = hilights_settings;
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
) -> Result<(), String> {
    match serialport::new(&port_name, baud_rate).open() {
        Ok(port) => {
            *state.serial_connection.lock().await = Some(port);
            state.serial_connected.store(true, Ordering::SeqCst);
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
            let port_name_loop = port_name.clone();
            tokio::spawn(async move {
                let mut line_buffer: Vec<u8> = Vec::new();
                //let regex_eol = regex::Regex::new(r"\r\n|\n\r|\r|\n").unwrap();
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
                                        },
                                    ).await;
                                    continue;
                                }
                                line_buffer.push(temp[0]);
                                let len = line_buffer.len();
                                let found = if len >= 2 {
                                    (line_buffer[len - 2] == b'\r' && line_buffer[len - 1] == b'\n')
                                        || (line_buffer[len - 2] == b'\n'
                                            && line_buffer[len - 1] == b'\r')
                                } else {
                                    temp[0] == b'\r' || temp[0] == b'\n'
                                };
                                if found {
                                    //let s = String::from_utf8_lossy(&line_buffer);
                                    //let mut line = regex_eol.replace_all(&s, "").to_string();
                                    let line = String::from_utf8_lossy(&line_buffer).to_string();
                                    let cur_payload = parse_log_line(line.clone(), app_handle.clone()).await;
                                    publish_one(&app_handle, cur_payload).await;
                                    line_buffer.clear();
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
                                emit_system_msg(
                                    &app_handle,
                                    format!("Connection to {} lost", port_name_loop),
                                ).await;
                                let _ = app_handle.emit("serial-disconnected", ());
                                break;
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

#[tauri::command]
async fn close_port(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    *state.serial_connection.lock().await = None;
    state.serial_connected.store(false, Ordering::SeqCst);
    emit_system_msg(&app, "Connection closed".to_string()).await;
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

    // Emit initial batch (replaces current logs)
    let results = process_batch(&app, lines).await;
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
                    let results = process_batch(&app_handle, new_lines).await;
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
    match fs::create_dir(app.path().app_config_dir().unwrap()) {
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
    let state = AppState {
        serial_connection: Arc::new(Mutex::new(None)),
        highlights: Arc::new(Mutex::new(Vec::new())),
        message_id_counter: Arc::new(AtomicU64::new(1)),
        file_watch_active: Arc::new(AtomicBool::new(false)),
        log_store: Arc::new(LogStore::new()),
        serial_connected: Arc::new(AtomicBool::new(false)),
        mcp_server: Arc::new(Mutex::new(None)),
    };
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    builder
        .setup(|app| {
            create_config_dir(app);

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
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            list_ports,
            open_port,
            close_port,
            set_highlights,
            add_logs_line,
            append_logs_line,
            watch_file,
            stop_file_watch,
            start_mcp_server,
            stop_mcp_server,
            get_mcp_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
