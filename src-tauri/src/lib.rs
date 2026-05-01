use regex::Regex;
use serialport::SerialPort;

use std::{fs, sync::Arc};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

#[derive(Clone, serde::Deserialize)]
struct HighlightMessage {
    id: u64,
    text: String,
    color: String,
    is_regex: bool,
    whole_line: bool,
    remove: bool,
}

#[derive(Clone)]
struct HighlightSettings {
    _id: u64,
    text: String,
    color: String,
    is_regex: bool,
    whole_line: bool,
    remove: bool,
    regex: Option<Regex>,
}
#[derive(Clone, serde::Serialize)]
struct Payload {
    id : u64,
    message: String,
    matched: bool,
    rawline: Option<String>,
    removed_line: bool,
}

#[derive(Clone)]
struct AppState {
    serial_connection: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    highlights: Arc<Mutex<Vec<HighlightSettings>>>,
    message_id_counter: Arc<AtomicU64>,
}

async fn parse_log_line(input_line: String, emitter: tauri::AppHandle) -> (Payload, bool) {
    let highlights_vec = emitter.state::<AppState>().highlights.lock().await.clone();
    let message_id = emitter.state::<AppState>().message_id_counter.fetch_add(1, Ordering::SeqCst);
    let rawline = input_line.clone();
    let mut line = input_line;
    let mut matched = false;
    let mut should_send_raw = false;
    let mut removed_line = false;
    // Applique le surlignage côté Rust
    for hl in &highlights_vec {
        if !hl.text.is_empty() {
            let does_match = if hl.is_regex {
                hl.regex.as_ref().map_or(false, |r| r.is_match(&line))
            } else {
                line.contains(&hl.text as &str)
            };
            if does_match {
                if hl.remove {
                    if hl.whole_line {
                        line.clear();
                        removed_line = true;
                        matched = true;
                        should_send_raw = true;
                        break;
                    } else if hl.is_regex {
                        if let Some(ref regex) = hl.regex {
                            line = regex.replace_all(&line, "").to_string();
                        }
                    } else {
                        line = line.replace(&hl.text as &str, "");
                    }
                } else {
                    if hl.whole_line {
                        line = format!("<span style=\"color:{}\">{}</span>", hl.color, line);
                    } else if hl.is_regex {
                        if let Some(ref regex) = hl.regex {
                            line = regex
                                .replace_all(
                                    &line,
                                    format!("<span style=\"color:{};\">$0</span>", hl.color),
                                )
                                .to_string();
                        }
                    } else {
                        line = line.replace(
                            &hl.text as &str,
                            &format!("<span style=\"color:{}\">{}</span>", hl.color, hl.text),
                        );
                    }
                }
                matched = true;
                should_send_raw = true;
            }
        }
    }
    if should_send_raw {
        return (Payload {
            id: message_id,
            message: line,
            matched,
            rawline:Some(rawline),
            removed_line,
        }, should_send_raw);
    }else{
        return (Payload {
            id: message_id,
            message: line,
            matched,
            rawline:None,
            removed_line,
        }, should_send_raw);
    }
}

#[tauri::command]
async fn add_logs_line(lines: Vec<String>, emitter: tauri::AppHandle) -> Result<(), String> {

    let app_handle = emitter.clone();
    let mut logs_line: Vec<Payload> = Vec::new();
    let mut logs_line_focus: Vec<Payload> = Vec::new();
    // Applique les regles de highlight/remove configurees
    for line in lines{
        let should_send_raw ;
        let cur_payload: Payload;
        (cur_payload,should_send_raw) = parse_log_line(line.clone(), app_handle.clone()).await;
        if should_send_raw {
            logs_line.push(cur_payload.clone());
            logs_line_focus.push(cur_payload);
        }else{
            logs_line.push(cur_payload);
        }
    }

    let _ = app_handle.emit(
        "serial-datas",
        logs_line,
    );
    let _ = app_handle.emit(
        "serial-datas-focus",
        logs_line_focus,
    );
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
            match regex::Regex::new(&text) {
                Ok(reg) => Some(reg),
                Err(err) => {
                    println!("Failed to set regex: {}", err);
                    continue;
                }
            }
        } else {
            None
        };
        hilights_settings.push(HighlightSettings {
            _id: elem.id,
            text: elem.text,
            color: elem.color,
            is_regex: elem.is_regex,
            whole_line: elem.whole_line,
            remove: elem.remove,
            regex: cur_regex,
        });
    }
    let mut lock = state.highlights.lock().await;
    *lock = hilights_settings;
    Ok(())
}

#[tauri::command]
async fn list_ports() -> Result<Vec<String>, String> {
    println!("Listing ports...");
    match serialport::available_ports() {
        Ok(ports) => {
            println!("Listing ports... {:?}", ports);
            Ok(ports.into_iter().map(|p| p.port_name).collect())
        }
        Err(e) => Err(format!("Failed to list ports: {}", e)),
    }
}

#[tauri::command]
async fn open_port(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    port_name: String,
    baud_rate: u32,
) -> Result<(), String> {
    match serialport::new(port_name, baud_rate).open() {
        Ok(port) => {
            *state.serial_connection.lock().await = Some(port);
            let serial = state.serial_connection.clone();
            let app_handle = app.clone();
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
                                    let _ = app_handle.emit(
                                        "serial-data",
                                        Payload {
                                            id:message_id,
                                            message: test,
                                            matched: false,
                                            rawline:None,
                                            removed_line: false,
                                        },
                                    );
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
                                    let (cur_payload, _) = parse_log_line(line.clone(), app_handle.clone()).await;
                                    let _ = app_handle.emit(
                                        "serial-data",
                                        cur_payload,
                                    );
                                    line_buffer.clear();
                                }
                            }
                            Ok(_) => {}
                            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                                std::thread::sleep(std::time::Duration::from_millis(2));
                            }
                            Err(_) => {
                                std::thread::sleep(std::time::Duration::from_millis(2));
                            }
                        }
                    } else {
                        break;
                    }
                }
            });
            Ok(())
        }
        Err(e) => Err(format!("Failed to open port: {}", e)),
    }
}

#[tauri::command]
async fn close_port(state: tauri::State<'_, AppState>) -> Result<(), String> {
    *state.serial_connection.lock().await = None;
    Ok(())
}
fn create_config_dir(app: &mut tauri::App) {
    match fs::create_dir(app.path().app_config_dir().unwrap()) {
        Ok(_) => {}
        Err(err) => {
            println!("Unable to create dir  {}", err);
        }
    };
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState {
        serial_connection: Arc::new(Mutex::new(None)),
        highlights: Arc::new(Mutex::new(Vec::new())),
        message_id_counter: Arc::new(AtomicU64::new(1)),
    };
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    builder
        .setup(|app| {
            create_config_dir(app);
            Ok(())
        })
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            list_ports,
            open_port,
            close_port,
            set_highlights,
            add_logs_line
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
