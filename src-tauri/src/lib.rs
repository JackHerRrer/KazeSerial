use regex::Regex;
use serialport::SerialPort;

use std::{fs, sync::Arc};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

#[derive(Clone, serde::Deserialize)]
struct RemoveMessage {
    text: String,
}
#[derive(Clone, serde::Deserialize)]
struct HighlightMessage {
    id: u64,
    text: String,
    color: String,
}

#[derive(Clone)]
struct HighlightSettings {
    _id: u64,
    text: String,
    color: String,
    regex: Regex,
}
#[derive(Clone, serde::Serialize)]
struct Payload {
    id : u64,
    message: String,
    matched: bool,
    rawline: Option<String>,
}

#[derive(Clone)]
struct AppState {
    serial_connection: Arc<Mutex<Option<Box<dyn SerialPort>>>>,
    highlights: Arc<Mutex<Vec<HighlightSettings>>>,
    removes: Arc<Mutex<Vec<String>>>,
    message_id_counter: Arc<AtomicU64>,
}
#[tauri::command]
async fn add_logs_line(line: String, emitter: tauri::AppHandle) -> Result<(), String> {
    let mut matched: bool = false;
    let highlights_vec = emitter.state::<AppState>().highlights.lock().await.clone();
    let removes_vec = emitter.state::<AppState>().removes.lock().await.clone();
    let message_id = emitter.state::<AppState>().message_id_counter.fetch_add(1, Ordering::SeqCst);
    let app_handle = emitter.clone();
    let mut line = line;
    let rawline = line.clone();
    let mut should_send_raw = false;
    // Applique la suppression des chaînes avant le surlignage
    for rm in &removes_vec {
        if !rm.is_empty() && line.contains(rm) {
            line = line.replace(rm, "");
            should_send_raw = true;
        }
    }
    // Applique le surlignage côté Rust
    for hl in &highlights_vec {
        if !hl.text.is_empty() && hl.regex.is_match(&line) {
            line = hl
                .regex
                .replace_all(
                    &line,
                    format!("<span style=\"color:{};\">$0</span>", hl.color),
                )
                .to_string();
            matched = true;
            should_send_raw = true;
        }
    }
    if should_send_raw {
        let _ = app_handle.emit(
            "serial-data",
            Payload {
                id:message_id,
                message: line,
                matched: matched,
                rawline: Some(rawline)
            },
        );
    }else{
        let _ = app_handle.emit(
            "serial-data",
            Payload {
                id:message_id,
                message: line,
                matched: matched,
                rawline:None
            },
        );
    }

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
        //println!("Compiling regex for highlight: {}", text);
        let cur_regex = match regex::Regex::new(&text) {
            Ok(reg) => reg,
            Err(err) => {
                println!("Failed to set regex: {}", err);
                continue;
            }
        };
        hilights_settings.push(HighlightSettings {
            _id: elem.id,
            text: elem.text,
            color: elem.color,
            regex: cur_regex,
        });
    }
    let mut lock = state.highlights.lock().await;
    *lock = hilights_settings;
    Ok(())
}

#[tauri::command]
async fn set_removes(
    removes: Vec<RemoveMessage>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut removes_vec: Vec<String> = Vec::new();
    for elem in removes {
        if !elem.text.is_empty() {
            removes_vec.push(elem.text);
        }
    }
    let mut lock = state.removes.lock().await;
    *lock = removes_vec;
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
                                            rawline:None
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
                                    // Applique la suppression des chaînes avant le surlignage
                                    let _ = add_logs_line(line.clone(), app_handle.clone()).await;
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
        removes: Arc::new(Mutex::new(Vec::new())),
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
            set_removes,
            add_logs_line
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
