//! Automatic save of the serial log to files, configured in the Config tab.
//!
//! Lines are written as they are published: lines received from the serial port, system
//! messages and markers appended at the end of the log (see [`crate::publish_one`]). Opened or
//! followed files, the demo and markers inserted in the middle of the log are not written.
//!
//! - **Session**: each connection to the serial port ([`LogFiles::start_session`]) starts a new
//!   file; an automatic reconnection continues it. Nothing is written before the first
//!   connection since launch; afterwards, lines emitted while disconnected go to the last file.
//! - **Files**: `kazeserial_YYYY-MM-DD_HH-mm-ss.log` (local time the file was created), with a
//!   `_2`, `_3`... suffix when that name is taken.
//! - **Rotation**: when enabled, a file holds at most `max_lines` lines, then a new file is
//!   started, and only the `max_files` most recent `kazeserial_*.log` of the folder are kept.
//!   Without rotation, a file per session, unlimited, and nothing is deleted.
//! - **Line format**: as the Save button writes it, see [`LogFileSettings`].
//! - **Errors**: the first failure is reported once (the caller emits a system message), then
//!   nothing is written until a new session or a settings change.

use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use chrono::{Datelike, Local, TimeZone, Timelike};
use regex::Regex;

const FILE_PREFIX: &str = "kazeserial_";
const FILE_EXTENSION: &str = ".log";
/// Format used when the timestamp format is empty, as in the frontend
const DEFAULT_TIMESTAMP_FORMAT: &str = "HH:mm:ss";
/// Codes replaced in a timestamp format, all fixed-width
static FORMAT_CODES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("YYYY|MM|DD|HH|mm|ss|SSS").expect("valid regex"));

/// Settings sent by the frontend (`set_log_file_settings`).
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileSettings {
    pub enabled: bool,
    /// Folder of the files; `None` or empty for the default one
    pub folder: Option<String>,
    pub rotation: bool,
    pub max_files: usize,
    pub max_lines: usize,
    /// Timestamp column written before each line, as Save does: only when timestamps are shown
    /// and part of the text, formatted with `timestamp_format`, and with `inactivity_ms` only on
    /// lines arriving that long after the previous line of the file (blanks otherwise).
    pub timestamps_in_text: bool,
    pub timestamp_format: String,
    pub inactivity_ms: Option<u64>,
}

impl Default for LogFileSettings {
    /// Same defaults as the frontend, used until it sends its settings
    fn default() -> Self {
        Self {
            enabled: true,
            folder: None,
            rotation: true,
            max_files: 10,
            max_lines: 10_000,
            timestamps_in_text: false,
            timestamp_format: DEFAULT_TIMESTAMP_FORMAT.to_string(),
            inactivity_ms: None,
        }
    }
}

struct OpenFile {
    writer: BufWriter<File>,
    lines: usize,
    /// Timestamp of the last line written, for the inactivity rule
    last_timestamp: Option<u64>,
}

pub struct LogFiles {
    settings: LogFileSettings,
    default_folder: PathBuf,
    session_started: bool,
    current: Option<OpenFile>,
    /// Writing failed: nothing is written until a new session or a settings change
    failed: bool,
}

impl LogFiles {
    pub fn new(default_folder: PathBuf) -> Self {
        Self {
            settings: LogFileSettings::default(),
            default_folder,
            session_started: false,
            current: None,
            failed: false,
        }
    }

    pub fn default_folder(&self) -> &Path {
        &self.default_folder
    }

    pub fn set_default_folder(&mut self, folder: PathBuf) {
        self.default_folder = folder;
    }

    /// Applies new settings. Disabling or changing the folder closes the current file, so the
    /// next line starts a new one; other changes keep it. Any change retries after a failure.
    pub fn set_settings(&mut self, settings: LogFileSettings) {
        if !settings.enabled || self.folder_of(&settings) != self.folder_of(&self.settings) {
            self.current = None;
        }
        self.settings = settings;
        self.failed = false;
    }

    /// New serial connection: the next line starts a new file.
    pub fn start_session(&mut self) {
        self.session_started = true;
        self.current = None;
        self.failed = false;
    }

    /// Writes a line received at `timestamp` (ms since the Unix epoch). Returns the error the
    /// first time writing fails, so the caller can report it.
    pub fn write(&mut self, text: &str, timestamp: Option<u64>) -> Option<String> {
        if !self.settings.enabled || !self.session_started || self.failed {
            return None;
        }
        match self.try_write(text, timestamp) {
            Ok(()) => None,
            Err(err) => {
                self.failed = true;
                self.current = None;
                Some(err.to_string())
            }
        }
    }

    fn try_write(&mut self, text: &str, timestamp: Option<u64>) -> io::Result<()> {
        let full = self.settings.rotation
            && self
                .current
                .as_ref()
                .is_some_and(|file| file.lines >= self.settings.max_lines.max(1));
        if full || self.current.is_none() {
            self.current = Some(self.open_new_file()?);
        }
        let settings = &self.settings;
        let Some(file) = self.current.as_mut() else {
            return Ok(());
        };
        // Serial lines keep their line terminator; the file uses `\n`
        let text = text.trim_end_matches(['\r', '\n']);
        let column = timestamp_column(settings, timestamp, file.last_timestamp);
        writeln!(file.writer, "{}{}", column, text)?;
        // Flushed on every line, so the file is complete if the application stops
        file.writer.flush()?;
        file.lines += 1;
        file.last_timestamp = timestamp;
        Ok(())
    }

    fn folder_of(&self, settings: &LogFileSettings) -> PathBuf {
        match settings.folder.as_deref() {
            Some(folder) if !folder.trim().is_empty() => PathBuf::from(folder),
            _ => self.default_folder.clone(),
        }
    }

    /// Creates a new file, then deletes the oldest ones beyond `max_files` (rotation only).
    fn open_new_file(&self) -> io::Result<OpenFile> {
        let folder = self.folder_of(&self.settings);
        fs::create_dir_all(&folder)?;
        let stamp = Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
        let mut path = folder.join(format!("{FILE_PREFIX}{stamp}{FILE_EXTENSION}"));
        let mut suffix = 2;
        while path.exists() {
            path = folder.join(format!("{FILE_PREFIX}{stamp}_{suffix}{FILE_EXTENSION}"));
            suffix += 1;
        }
        let file = File::create_new(&path)?;
        if self.settings.rotation {
            delete_oldest_files(&folder, self.settings.max_files.max(1), &path);
        }
        Ok(OpenFile {
            writer: BufWriter::new(file),
            lines: 0,
            last_timestamp: None,
        })
    }
}

/// Keeps the `max_files` most recent `kazeserial_*.log` files of `folder` (by modification time,
/// then name), `current` always included. Best effort: a file that cannot be deleted is kept.
fn delete_oldest_files(folder: &Path, max_files: usize, current: &Path) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.starts_with(FILE_PREFIX) && name.ends_with(FILE_EXTENSION)
        })
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter(|entry| entry.path() != current)
        .map(|entry| {
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (modified, entry.path())
        })
        .collect();
    files.sort();
    // The current file takes one of the `max_files` places
    let excess = (files.len() + 1).saturating_sub(max_files);
    for (_, path) in files.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}

/// Timestamp column of a line, like `timestampColumnText` in the frontend: the timestamp and a
/// space, blanks of the same width when the line shows no timestamp, nothing when timestamps are
/// not part of the text. `previous` is the timestamp of the previous line of the file.
fn timestamp_column(settings: &LogFileSettings, timestamp: Option<u64>, previous: Option<u64>) -> String {
    if !settings.timestamps_in_text {
        return String::new();
    }
    // Like `isTimestampShown`: with an inactivity delay, only after that long without any line
    let shown = timestamp.filter(|timestamp| match (settings.inactivity_ms, previous) {
        (Some(delay), Some(previous)) => timestamp.saturating_sub(previous) >= delay,
        _ => true,
    });
    match shown {
        Some(timestamp) => format!("{} ", format_timestamp(timestamp, &settings.timestamp_format)),
        None => " ".repeat(format_timestamp(0, &settings.timestamp_format).chars().count() + 1),
    }
}

/// Formats a reception time in local time, like `formatTimestamp` in the frontend: the codes
/// `YYYY MM DD HH mm ss SSS` are replaced, any other character is kept.
pub fn format_timestamp(timestamp: u64, format: &str) -> String {
    let Some(date) = Local.timestamp_millis_opt(timestamp as i64).single() else {
        return String::new();
    };
    let format = if format.trim().is_empty() { DEFAULT_TIMESTAMP_FORMAT } else { format };
    FORMAT_CODES
        .replace_all(format, |code: &regex::Captures| match &code[0] {
            "YYYY" => format!("{:04}", date.year()),
            "MM" => format!("{:02}", date.month()),
            "DD" => format!("{:02}", date.day()),
            "HH" => format!("{:02}", date.hour()),
            "mm" => format!("{:02}", date.minute()),
            "ss" => format!("{:02}", date.second()),
            _ => format!("{:03}", date.timestamp_subsec_millis()),
        })
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Empty folder of its own for each test
    fn test_folder(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("kazeserial_log_file_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        folder
    }

    fn log_files(folder: &Path, settings: LogFileSettings) -> LogFiles {
        let mut files = LogFiles::new(folder.to_path_buf());
        files.set_settings(settings);
        files
    }

    /// Contents of the log files of `folder`, oldest first
    fn contents(folder: &Path) -> Vec<String> {
        let mut paths: Vec<PathBuf> = fs::read_dir(folder)
            .map(|entries| entries.filter_map(|entry| entry.ok()).map(|entry| entry.path()).collect())
            .unwrap_or_default();
        paths.sort();
        paths.iter().map(|path| fs::read_to_string(path).unwrap()).collect()
    }

    #[test]
    fn nothing_is_written_before_the_first_session() {
        let folder = test_folder("before_session");
        let mut files = log_files(&folder, LogFileSettings::default());

        assert_eq!(files.write("MCP server listening", Some(0)), None);
        assert!(!folder.exists());

        files.start_session();
        files.write("connected\r\n", Some(0));
        assert_eq!(contents(&folder), vec!["connected\n"]);
    }

    #[test]
    fn rotation_starts_new_files_and_keeps_the_most_recent_ones() {
        let folder = test_folder("rotation");
        let settings = LogFileSettings { max_files: 2, max_lines: 2, ..LogFileSettings::default() };
        let mut files = log_files(&folder, settings);
        files.start_session();
        for line in ["1", "2", "3", "4", "5"] {
            assert_eq!(files.write(line, None), None);
        }

        // Files created within the same second are told apart by a suffix: `.log` sorts before
        // `_2.log`, `_3.log`, so the name order is the creation order
        assert_eq!(contents(&folder), vec!["3\n4\n", "5\n"]);
    }

    #[test]
    fn without_rotation_a_session_has_a_single_unlimited_file() {
        let folder = test_folder("no_rotation");
        let settings = LogFileSettings { rotation: false, max_files: 1, max_lines: 1, ..LogFileSettings::default() };
        let mut files = log_files(&folder, settings);
        files.start_session();
        files.write("1", None);
        files.write("2", None);
        files.start_session();
        files.write("3", None);

        assert_eq!(contents(&folder), vec!["1\n2\n", "3\n"]);
    }

    #[test]
    fn a_failure_is_reported_once_then_retried_on_a_settings_change() {
        let folder = test_folder("failure");
        // A file where the folder should be
        fs::create_dir_all(folder.parent().unwrap()).unwrap();
        fs::write(&folder, "").unwrap();
        let mut files = log_files(&folder, LogFileSettings::default());
        files.start_session();

        assert!(files.write("1", None).is_some());
        assert_eq!(files.write("2", None), None, "reported once");

        fs::remove_file(&folder).unwrap();
        files.set_settings(LogFileSettings::default());
        files.write("3", None);
        assert_eq!(contents(&folder), vec!["3\n"]);
    }

    #[test]
    fn timestamp_column_follows_the_save_rules() {
        let settings = LogFileSettings {
            timestamps_in_text: true,
            timestamp_format: "ss.SSS".to_string(),
            inactivity_ms: Some(500),
            ..LogFileSettings::default()
        };
        assert_eq!(timestamp_column(&settings, Some(27_512), None), "27.512 ");
        // Less than the delay after the previous line: blanks of the same width
        assert_eq!(timestamp_column(&settings, Some(27_600), Some(27_512)), "       ");
        assert_eq!(timestamp_column(&settings, Some(28_100), Some(27_512)), "28.100 ");
        assert_eq!(timestamp_column(&settings, None, Some(27_512)), "       ");

        let hidden = LogFileSettings { timestamps_in_text: false, ..settings };
        assert_eq!(timestamp_column(&hidden, Some(27_512), None), "");
    }
}
