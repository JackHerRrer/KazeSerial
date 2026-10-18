//! In-memory log store, the single source of truth shared by the UI and the MCP server.
//!
//! Before this module existed the backend was stateless: [`crate::process_line`] emitted
//! payloads straight to the webview and React held the only copy of the logs. An MCP client
//! has no access to that state, so every emit site now also records here.
//!
//! The store mirrors the UI semantics exactly, so an agent reading it sees the same log the
//! user is looking at:
//! - `serial-data` / `*-append` events append   -> [`LogStore::append`]
//! - `serial-datas` / `serial-datas-focus` replace the list -> [`LogStore::replace`]
//! - a marker inserted in the middle of the log            -> [`LogStore::insert_before`]
//!
//! Records are kept in display order. Ids are given in the order lines are added, so they
//! increase along the log, except for a marker inserted in the middle: it gets a new id, larger
//! than the lines around it. Tools following the log by id (`after_id`) walk records in id
//! order, so such a marker is reported once, as a new line. While the records are in id order,
//! the usual case, the newer records are found by binary search instead of scanning them all.

use std::collections::VecDeque;
use std::time::{Duration, Instant};
use tokio::sync::{Notify, RwLock};

/// Number of lines kept in memory before the oldest are evicted.
/// Override with the `KAZESERIAL_LOG_CAPACITY` environment variable.
const DEFAULT_CAPACITY: usize = 500_000;

/// One recorded log line. `text` is always the *raw* line, never the HTML-decorated
/// variant the webview renders, so MCP consumers never see `<span>` markup.
#[derive(Clone, Debug)]
pub struct LogRecord {
    pub id: u64,
    pub text: String,
    /// Matched a highlight rule flagged `focus` — appears in the user's focus panel.
    pub focus: bool,
    /// Blanked by a `remove` rule — present here but hidden in the user's view.
    pub removed: bool,
    /// Reception time in ms since the Unix epoch, `None` for a line of a loaded file. Kept so a
    /// Refresh, which processes the lines again from here, keeps it.
    pub timestamp: Option<u64>,
    /// Marker line inserted by the user, kept as a marker by a Refresh.
    pub marker: bool,
}

/// Where the currently displayed lines came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LogSource {
    None,
    /// Live serial port, e.g. `/dev/ttyUSB0 @ 115200`.
    Serial { port: String, baud_rate: u32 },
    /// File loaded once as a static snapshot.
    File { path: String },
    /// File being followed `tail -f` style.
    FileWatch { path: String },
}

impl LogSource {
    /// Human-readable description handed to MCP clients.
    pub fn describe(&self) -> String {
        match self {
            LogSource::None => "none".to_string(),
            LogSource::Serial { port, baud_rate } => format!("serial {} @ {} baud", port, baud_rate),
            LogSource::File { path } => format!("file {}", path),
            LogSource::FileWatch { path } => format!("file-watch {} (following)", path),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            LogSource::None => "none",
            LogSource::Serial { .. } => "serial",
            LogSource::File { .. } => "file",
            LogSource::FileWatch { .. } => "file_watch",
        }
    }
}

struct Inner {
    records: VecDeque<LogRecord>,
    capacity: usize,
    /// Lines evicted by the capacity cap since the last clear/replace.
    dropped: u64,
    /// Records are in increasing id order. Set back only by a clear or a replace.
    in_id_order: bool,
    source: LogSource,
}

impl Inner {
    /// Records with `id > after_id`, in id order (the order they were added).
    fn newer_than(&self, after_id: u64) -> Box<dyn Iterator<Item = &LogRecord> + '_> {
        if self.in_id_order {
            let start = self.records.partition_point(|r| r.id <= after_id);
            return Box::new(self.records.range(start..));
        }
        let mut records: Vec<&LogRecord> = self.records.iter().filter(|r| r.id > after_id).collect();
        // Already sorted but for inserted markers, so this stable sort is close to linear
        records.sort_by_key(|r| r.id);
        Box::new(records.into_iter())
    }

    /// Drops the oldest records until the buffer fits `capacity`.
    fn enforce_capacity(&mut self) {
        while self.records.len() > self.capacity {
            self.records.pop_front();
            self.dropped += 1;
        }
    }
}

/// Snapshot of the store's shape, cheap to compute and safe to call often.
#[derive(Clone, Debug)]
pub struct LogStats {
    pub total_lines: usize,
    pub focus_lines: usize,
    pub oldest_id: Option<u64>,
    pub newest_id: Option<u64>,
    pub dropped_lines: u64,
    pub capacity: usize,
    pub source: LogSource,
}

pub struct LogStore {
    inner: RwLock<Inner>,
    /// Woken on every append so `wait_for_logs` can block instead of polling.
    notify: Notify,
}

impl LogStore {
    pub fn new() -> Self {
        let capacity = std::env::var("KAZESERIAL_LOG_CAPACITY")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_CAPACITY);

        Self {
            inner: RwLock::new(Inner {
                records: VecDeque::new(),
                capacity,
                dropped: 0,
                in_id_order: true,
                source: LogSource::None,
            }),
            notify: Notify::new(),
        }
    }

    /// Appends records, mirroring an `serial-data` / `*-append` emit.
    pub async fn append(&self, records: Vec<LogRecord>) {
        if records.is_empty() {
            return;
        }
        {
            let mut inner = self.inner.write().await;
            let follows = inner.records.back().is_none_or(|last| last.id < records[0].id);
            inner.in_id_order &= follows && records.is_sorted_by_key(|r| r.id);
            inner.records.extend(records);
            inner.enforce_capacity();
        }
        self.notify.notify_waiters();
    }

    /// Replaces the whole buffer, mirroring a `serial-datas` emit (file load, watch start).
    pub async fn replace(&self, records: Vec<LogRecord>) {
        {
            let mut inner = self.inner.write().await;
            inner.in_id_order = records.is_sorted_by_key(|r| r.id);
            inner.records = VecDeque::from(records);
            inner.dropped = 0;
            inner.enforce_capacity();
        }
        self.notify.notify_waiters();
    }

    /// Inserts `record` just before the record `before_id`. Does nothing when that record is not
    /// in the store anymore (evicted or cleared).
    pub async fn insert_before(&self, before_id: u64, record: LogRecord) {
        {
            let mut inner = self.inner.write().await;
            let Some(position) = inner.records.iter().position(|r| r.id == before_id) else {
                return;
            };
            inner.in_id_order &= record.id < before_id
                && (position == 0 || inner.records[position - 1].id < record.id);
            inner.records.insert(position, record);
            inner.enforce_capacity();
        }
        self.notify.notify_waiters();
    }

    pub async fn clear(&self) {
        let mut inner = self.inner.write().await;
        inner.records.clear();
        inner.dropped = 0;
        inner.in_id_order = true;
    }

    pub async fn set_source(&self, source: LogSource) {
        self.inner.write().await.source = source;
    }

    /// Clears the source only if it still refers to `path` — avoids a stopping
    /// watcher wiping the label of a source the user has already switched to.
    pub async fn clear_source_if_watching(&self, path: &str) {
        let mut inner = self.inner.write().await;
        if matches!(&inner.source, LogSource::FileWatch { path: p } if p == path) {
            inner.source = LogSource::File {
                path: path.to_string(),
            };
        }
    }

    pub async fn stats(&self) -> LogStats {
        let inner = self.inner.read().await;
        LogStats {
            total_lines: inner.records.len(),
            focus_lines: inner.records.iter().filter(|r| r.focus).count(),
            oldest_id: inner.records.front().map(|r| r.id),
            // Not the last record when a marker was inserted in the middle of the log
            newest_id: inner.records.iter().map(|r| r.id).max(),
            dropped_lines: inner.dropped,
            capacity: inner.capacity,
            source: inner.source.clone(),
        }
    }

    /// `f` applied to every record, in display order.
    pub async fn map_records<T>(&self, f: impl FnMut(&LogRecord) -> T) -> Vec<T> {
        self.inner.read().await.records.iter().map(f).collect()
    }

    /// Last `count` records, oldest first.
    pub async fn tail(&self, count: usize) -> Vec<LogRecord> {
        let inner = self.inner.read().await;
        let skip = inner.records.len().saturating_sub(count);
        inner.records.iter().skip(skip).cloned().collect()
    }

    /// Records with `from_id <= id <= to_id`, capped at `max_lines`.
    /// Returns `(records, total_matching)` so callers can report truncation.
    pub async fn range(&self, from_id: u64, to_id: u64, max_lines: usize) -> (Vec<LogRecord>, usize) {
        let inner = self.inner.read().await;
        let total = inner
            .records
            .iter()
            .filter(|r| r.id >= from_id && r.id <= to_id)
            .count();
        let out = inner
            .records
            .iter()
            .filter(|r| r.id >= from_id && r.id <= to_id)
            .take(max_lines)
            .cloned()
            .collect();
        (out, total)
    }

    /// Window of the full log by position, for paginating a complete dump.
    /// Returns `(records, total_lines)`.
    pub async fn page(&self, offset: usize, max_lines: usize) -> (Vec<LogRecord>, usize) {
        let inner = self.inner.read().await;
        let total = inner.records.len();
        let out = inner
            .records
            .iter()
            .skip(offset)
            .take(max_lines)
            .cloned()
            .collect();
        (out, total)
    }

    /// Last `count` focus-matched records, oldest first.
    pub async fn focus(&self, count: usize) -> Vec<LogRecord> {
        let inner = self.inner.read().await;
        let matching: Vec<&LogRecord> = inner.records.iter().filter(|r| r.focus).collect();
        let skip = matching.len().saturating_sub(count);
        matching.into_iter().skip(skip).cloned().collect()
    }

    /// Records strictly after `after_id`, in id order, capped at `max_lines`.
    pub async fn after(&self, after_id: u64, max_lines: usize) -> Vec<LogRecord> {
        let inner = self.inner.read().await;
        inner
            .newer_than(after_id)
            .take(max_lines)
            .cloned()
            .collect()
    }

    /// Blocks until at least one record with `id > after_id` exists, or `timeout` elapses.
    /// Lets an agent follow the log live without busy-polling.
    pub async fn wait_after(
        &self,
        after_id: u64,
        timeout: Duration,
        max_lines: usize,
    ) -> Vec<LogRecord> {
        let deadline = Instant::now() + timeout;
        loop {
            // Register interest before checking, so an append landing between the
            // check and the wait cannot be missed.
            let notified = self.notify.notified();

            let available = self.after(after_id, max_lines).await;
            if !available.is_empty() {
                return available;
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Vec::new();
            }
            if tokio::time::timeout(remaining, notified).await.is_err() {
                return Vec::new();
            }
        }
    }

    /// Blocks until the `skip_occurrences + 1`-th record matching `matcher` with
    /// `id > after_id` appears, or `timeout` elapses. Unlike `wait_after`, a batch of
    /// appends that doesn't reach the target occurrence count does not make the call
    /// return early — it keeps waiting on the same deadline.
    pub async fn wait_for_pattern(
        &self,
        after_id: u64,
        matcher: &(dyn Fn(&str) -> bool + Sync),
        skip_occurrences: usize,
        timeout: Duration,
    ) -> PatternWait {
        let deadline = Instant::now() + timeout;
        loop {
            // Register interest before checking, so an append landing between the
            // check and the wait cannot be missed.
            let notified = self.notify.notified();

            let inner = self.inner.read().await;
            let mut occurrences_seen = 0usize;
            let mut last_id = after_id;
            let mut found: Option<LogRecord> = None;
            for record in inner.newer_than(after_id) {
                last_id = record.id;
                if matcher(&record.text) {
                    occurrences_seen += 1;
                    if occurrences_seen > skip_occurrences {
                        found = Some(record.clone());
                        break;
                    }
                }
            }
            drop(inner);

            if let Some(line) = found {
                let last_id = line.id;
                return PatternWait {
                    matched: true,
                    line: Some(line),
                    occurrences_seen,
                    last_id,
                };
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return PatternWait {
                    matched: false,
                    line: None,
                    occurrences_seen,
                    last_id,
                };
            }
            if tokio::time::timeout(remaining, notified).await.is_err() {
                return PatternWait {
                    matched: false,
                    line: None,
                    occurrences_seen,
                    last_id,
                };
            }
        }
    }

    /// Substring or regex search with optional surrounding context lines.
    /// Returns `(hit_blocks, total_hits)`; each block is a contiguous run of
    /// records covering one hit plus its context, with the hit ids listed.
    pub async fn search(&self, opts: SearchOptions<'_>) -> (Vec<SearchHit>, usize) {
        let inner = self.inner.read().await;

        let candidates: Vec<(usize, &LogRecord)> = inner
            .records
            .iter()
            .enumerate()
            .filter(|(_, r)| {
                opts.from_id.map_or(true, |f| r.id >= f) && opts.to_id.map_or(true, |t| r.id <= t)
            })
            .collect();

        let matcher = match build_matcher(opts.pattern, opts.is_regex, opts.ignore_case) {
            Ok(matcher) => matcher,
            Err(_) => return (Vec::new(), 0),
        };

        let hit_positions: Vec<usize> = candidates
            .iter()
            .filter(|(_, r)| matcher(&r.text))
            .map(|(i, _)| *i)
            .collect();

        let total_hits = hit_positions.len();

        let mut hits: Vec<SearchHit> = Vec::new();
        for pos in hit_positions.into_iter().take(opts.limit) {
            let start = pos.saturating_sub(opts.context_before);
            let end = (pos + opts.context_after).min(inner.records.len().saturating_sub(1));

            let lines: Vec<LogRecord> = inner
                .records
                .iter()
                .skip(start)
                .take(end - start + 1)
                .cloned()
                .collect();

            let hit_id = inner.records.get(pos).map(|r| r.id).unwrap_or(0);
            hits.push(SearchHit { hit_id, lines });
        }

        (hits, total_hits)
    }
}

/// Parameters for [`LogStore::search`].
pub struct SearchOptions<'a> {
    pub pattern: &'a str,
    pub is_regex: bool,
    pub ignore_case: bool,
    pub limit: usize,
    pub context_before: usize,
    pub context_after: usize,
    pub from_id: Option<u64>,
    pub to_id: Option<u64>,
}

/// One search hit plus its context lines.
pub struct SearchHit {
    pub hit_id: u64,
    pub lines: Vec<LogRecord>,
}

/// Result of [`LogStore::wait_for_pattern`].
pub struct PatternWait {
    pub matched: bool,
    /// The matching record, present only when `matched` is true.
    pub line: Option<LogRecord>,
    /// Matches seen after `after_id`, including the returned one.
    pub occurrences_seen: usize,
    /// Highest id scanned — the matched line's id, or the newest id seen before timeout.
    pub last_id: u64,
}

/// A compiled line matcher, as produced by [`build_matcher`].
pub type LineMatcher = Box<dyn Fn(&str) -> bool + Send + Sync>;

/// Builds a substring or regex line matcher, shared by `search` and `wait_for_pattern`
/// so the two never drift on what "matches" means.
pub fn build_matcher(
    pattern: &str,
    is_regex: bool,
    ignore_case: bool,
) -> Result<LineMatcher, regex::Error> {
    if is_regex {
        let pattern = if ignore_case {
            format!("(?i){}", pattern)
        } else {
            pattern.to_string()
        };
        let re = regex::Regex::new(&pattern)?;
        Ok(Box::new(move |line: &str| re.is_match(line)))
    } else if ignore_case {
        let needle = pattern.to_lowercase();
        Ok(Box::new(move |line: &str| line.to_lowercase().contains(&needle)))
    } else {
        let needle = pattern.to_string();
        Ok(Box::new(move |line: &str| line.contains(&needle)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn record(id: u64, text: &str) -> LogRecord {
        LogRecord {
            id,
            text: text.to_string(),
            focus: false,
            removed: false,
            timestamp: None,
            marker: false,
        }
    }

    fn focus_record(id: u64, text: &str) -> LogRecord {
        LogRecord {
            focus: true,
            ..record(id, text)
        }
    }

    async fn store_with(lines: &[(u64, &str)]) -> LogStore {
        let store = LogStore::new();
        store
            .append(lines.iter().map(|(id, t)| record(*id, t)).collect())
            .await;
        store
    }

    #[tokio::test]
    async fn append_preserves_order_and_tail_returns_newest() {
        let store = store_with(&[(1, "a"), (2, "b"), (3, "c"), (4, "d")]).await;

        let tail = store.tail(2).await;
        assert_eq!(
            tail.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![3, 4],
            "tail must return the newest lines, oldest first"
        );

        // Asking for more than exists is not an error.
        assert_eq!(store.tail(99).await.len(), 4);
    }

    #[tokio::test]
    async fn replace_discards_previous_content() {
        let store = store_with(&[(1, "old"), (2, "old")]).await;
        store.replace(vec![record(3, "new")]).await;

        let stats = store.stats().await;
        assert_eq!(stats.total_lines, 1);
        assert_eq!(stats.oldest_id, Some(3));
        assert_eq!(stats.newest_id, Some(3));
    }

    #[tokio::test]
    async fn range_is_inclusive_and_reports_truncation() {
        let store = store_with(&[(1, "a"), (2, "b"), (3, "c"), (4, "d"), (5, "e")]).await;

        let (records, total) = store.range(2, 4, 10).await;
        assert_eq!(records.iter().map(|r| r.id).collect::<Vec<_>>(), vec![2, 3, 4]);
        assert_eq!(total, 3);

        // The cap limits what comes back but `total` still reports the real count,
        // so callers can tell they only got part of the range.
        let (capped, total) = store.range(1, 5, 2).await;
        assert_eq!(capped.len(), 2);
        assert_eq!(total, 5);
    }

    #[tokio::test]
    async fn page_walks_the_whole_buffer() {
        let store = store_with(&[(1, "a"), (2, "b"), (3, "c")]).await;

        let (first, total) = store.page(0, 2).await;
        assert_eq!(total, 3);
        assert_eq!(first.iter().map(|r| r.id).collect::<Vec<_>>(), vec![1, 2]);

        let (second, _) = store.page(2, 2).await;
        assert_eq!(second.iter().map(|r| r.id).collect::<Vec<_>>(), vec![3]);

        // Past the end yields nothing rather than panicking.
        assert!(store.page(10, 2).await.0.is_empty());
    }

    #[tokio::test]
    async fn focus_returns_only_flagged_lines() {
        let store = LogStore::new();
        store
            .append(vec![
                record(1, "plain"),
                focus_record(2, "important"),
                record(3, "plain"),
                focus_record(4, "also important"),
            ])
            .await;

        let focus = store.focus(10).await;
        assert_eq!(focus.iter().map(|r| r.id).collect::<Vec<_>>(), vec![2, 4]);
        assert_eq!(store.stats().await.focus_lines, 2);

        // Trailing window applies to the filtered set, not the raw buffer.
        assert_eq!(
            store.focus(1).await.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![4]
        );
    }

    #[tokio::test]
    async fn capacity_evicts_oldest_and_counts_drops() {
        let store = LogStore::new();
        {
            let mut inner = store.inner.write().await;
            inner.capacity = 3;
        }

        store
            .append((1..=5).map(|id| record(id, "line")).collect())
            .await;

        let stats = store.stats().await;
        assert_eq!(stats.total_lines, 3);
        assert_eq!(stats.oldest_id, Some(3), "the two oldest lines are evicted");
        assert_eq!(stats.newest_id, Some(5));
        assert_eq!(stats.dropped_lines, 2, "drops must be reported to MCP clients");
    }

    #[tokio::test]
    async fn search_matches_substring_regex_and_case() {
        let store = store_with(&[
            (1, "boot ok"),
            (2, "ERROR: timeout"),
            (3, "still fine"),
            (4, "error: retry"),
        ])
        .await;

        let opts = |pattern: &'static str| SearchOptions {
            pattern,
            is_regex: false,
            ignore_case: true,
            limit: 100,
            context_before: 0,
            context_after: 0,
            from_id: None,
            to_id: None,
        };

        // Case-insensitive by default: catches both ERROR and error.
        let (hits, total) = store.search(opts("error")).await;
        assert_eq!(total, 2);
        assert_eq!(hits.iter().map(|h| h.hit_id).collect::<Vec<_>>(), vec![2, 4]);

        // Case-sensitive narrows it to the uppercase one.
        let (hits, _) = store
            .search(SearchOptions {
                ignore_case: false,
                ..opts("ERROR")
            })
            .await;
        assert_eq!(hits.iter().map(|h| h.hit_id).collect::<Vec<_>>(), vec![2]);

        // Regex mode.
        let (hits, _) = store
            .search(SearchOptions {
                is_regex: true,
                ..opts("^error")
            })
            .await;
        assert_eq!(hits.iter().map(|h| h.hit_id).collect::<Vec<_>>(), vec![2, 4]);

        // An invalid regex yields no hits instead of blowing up the tool call.
        let (hits, total) = store
            .search(SearchOptions {
                is_regex: true,
                ..opts("(unclosed")
            })
            .await;
        assert!(hits.is_empty());
        assert_eq!(total, 0);
    }

    #[tokio::test]
    async fn search_includes_context_and_respects_id_bounds() {
        let store = store_with(&[
            (1, "a"),
            (2, "b"),
            (3, "needle"),
            (4, "d"),
            (5, "e"),
            (6, "needle"),
        ])
        .await;

        let (hits, _) = store
            .search(SearchOptions {
                pattern: "needle",
                is_regex: false,
                ignore_case: true,
                limit: 100,
                context_before: 1,
                context_after: 1,
                from_id: None,
                to_id: Some(4),
            })
            .await;

        assert_eq!(hits.len(), 1, "the id bound excludes the second needle");
        assert_eq!(hits[0].hit_id, 3);
        assert_eq!(
            hits[0].lines.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![2, 3, 4],
            "context lines surround the hit"
        );
    }

    #[tokio::test]
    async fn wait_after_returns_immediately_when_data_is_already_there() {
        let store = store_with(&[(1, "a"), (2, "b")]).await;

        let got = store
            .wait_after(1, Duration::from_millis(50), 10)
            .await;
        assert_eq!(got.iter().map(|r| r.id).collect::<Vec<_>>(), vec![2]);
    }

    #[tokio::test]
    async fn wait_after_times_out_on_a_quiet_capture() {
        let store = store_with(&[(1, "a")]).await;

        let got = store.wait_after(1, Duration::from_millis(30), 10).await;
        assert!(got.is_empty(), "a timeout must yield no lines, not an error");
    }

    #[tokio::test]
    async fn wait_after_wakes_on_a_later_append() {
        let store = Arc::new(store_with(&[(1, "a")]).await);

        let writer = {
            let store = store.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                store.append(vec![record(2, "arrived later")]).await;
            })
        };

        let got = store.wait_after(1, Duration::from_secs(5), 10).await;
        writer.await.unwrap();

        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "arrived later");
    }

    #[tokio::test]
    async fn wait_for_pattern_returns_immediately_when_the_match_is_already_there() {
        let store = store_with(&[(1, "a"), (2, "needle"), (3, "c")]).await;
        let matcher = build_matcher("needle", false, true).unwrap();

        let got = store
            .wait_for_pattern(0, matcher.as_ref(), 0, Duration::from_millis(50))
            .await;

        assert!(got.matched);
        assert_eq!(got.line.unwrap().id, 2);
        assert_eq!(got.occurrences_seen, 1);
        assert_eq!(got.last_id, 2);
    }

    #[tokio::test]
    async fn wait_for_pattern_skips_the_requested_occurrences() {
        let store = store_with(&[(1, "needle"), (2, "needle"), (3, "needle")]).await;
        let matcher = build_matcher("needle", false, true).unwrap();

        let got = store
            .wait_for_pattern(0, matcher.as_ref(), 2, Duration::from_millis(50))
            .await;

        assert!(got.matched, "the third occurrence should still land inside the timeout");
        assert_eq!(got.line.unwrap().id, 3);
        assert_eq!(got.occurrences_seen, 3);
    }

    #[tokio::test]
    async fn wait_for_pattern_times_out_when_not_enough_occurrences_arrive() {
        let store = store_with(&[(1, "needle")]).await;
        let matcher = build_matcher("needle", false, true).unwrap();

        let got = store
            .wait_for_pattern(0, matcher.as_ref(), 1, Duration::from_millis(30))
            .await;

        assert!(!got.matched);
        assert_eq!(got.occurrences_seen, 1, "the single match was seen but not returned");
        assert_eq!(got.last_id, 1);
    }

    #[tokio::test]
    async fn wait_for_pattern_wakes_on_a_later_matching_append() {
        let store = Arc::new(store_with(&[(1, "a")]).await);

        let writer = {
            let store = store.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(10)).await;
                store.append(vec![record(2, "noise")]).await;
                tokio::time::sleep(Duration::from_millis(10)).await;
                store.append(vec![record(3, "needle")]).await;
            })
        };

        let matcher = build_matcher("needle", false, true).unwrap();
        let got = store
            .wait_for_pattern(1, matcher.as_ref(), 0, Duration::from_secs(5))
            .await;
        writer.await.unwrap();

        assert!(got.matched);
        assert_eq!(got.line.unwrap().id, 3);
    }

    #[tokio::test]
    async fn insert_before_places_the_record_above_its_line() {
        let store = store_with(&[(1, "a"), (2, "b"), (3, "c")]).await;

        store.insert_before(2, record(4, "mark")).await;
        // Unknown line (evicted or cleared): nothing is inserted
        store.insert_before(42, record(5, "lost")).await;

        let (records, _) = store.page(0, 10).await;
        assert_eq!(records.iter().map(|r| r.id).collect::<Vec<_>>(), vec![1, 4, 2, 3]);
        assert_eq!(store.stats().await.newest_id, Some(4), "the newest id, not the last line");
    }

    #[tokio::test]
    async fn following_by_id_with_gaps_in_the_ids() {
        let ids = |records: Vec<LogRecord>| records.iter().map(|r| r.id).collect::<Vec<_>>();
        let store = store_with(&[(1, "a"), (2, "b"), (5, "c"), (9, "d")]).await;
        assert_eq!(ids(store.after(3, 10).await), vec![5, 9]);
        assert_eq!(ids(store.after(0, 3).await), vec![1, 2, 5]);
        assert_eq!(ids(store.after(9, 10).await), Vec::<u64>::new());

        // A line of another source appended after a newer one: still followed in id order
        store.append(vec![record(7, "late")]).await;
        assert_eq!(ids(store.after(3, 10).await), vec![5, 7, 9]);

        // Cleared, the log is in id order again
        store.clear().await;
        store.append(vec![record(10, "e"), record(11, "f")]).await;
        assert_eq!(ids(store.after(10, 10).await), vec![11]);
    }

    #[tokio::test]
    async fn following_by_id_reports_an_inserted_marker_once() {
        let store = store_with(&[(1, "a"), (2, "b"), (3, "c")]).await;
        store.insert_before(2, record(4, "mark")).await;
        store.append(vec![record(5, "d")]).await;

        let first = store.after(2, 2).await;
        assert_eq!(first.iter().map(|r| r.id).collect::<Vec<_>>(), vec![3, 4]);
        let second = store.after(4, 2).await;
        assert_eq!(second.iter().map(|r| r.id).collect::<Vec<_>>(), vec![5]);

        // Line 3 matches but is displayed after the marker: walking by id still sees it first
        let matcher = build_matcher("c|mark", true, true).unwrap();
        let got = store
            .wait_for_pattern(2, matcher.as_ref(), 0, Duration::from_millis(10))
            .await;
        assert_eq!(got.line.unwrap().id, 3);
    }

    #[tokio::test]
    async fn clearing_resets_counts_but_keeps_the_source_label() {
        let store = store_with(&[(1, "a"), (2, "b")]).await;
        store
            .set_source(LogSource::Serial {
                port: "/dev/ttyUSB0".to_string(),
                baud_rate: 115_200,
            })
            .await;

        store.clear().await;

        let stats = store.stats().await;
        assert_eq!(stats.total_lines, 0);
        assert_eq!(stats.dropped_lines, 0);
        assert_eq!(stats.source.kind(), "serial");
        assert_eq!(stats.source.describe(), "serial /dev/ttyUSB0 @ 115200 baud");
    }

    #[tokio::test]
    async fn stopping_a_watch_downgrades_only_its_own_source() {
        let store = LogStore::new();
        store
            .set_source(LogSource::FileWatch {
                path: "/tmp/a.log".to_string(),
            })
            .await;

        // A watcher shutting down after the user moved on must not relabel the
        // source the user switched to.
        store.clear_source_if_watching("/tmp/other.log").await;
        assert_eq!(store.stats().await.source.kind(), "file_watch");

        store.clear_source_if_watching("/tmp/a.log").await;
        assert_eq!(store.stats().await.source.kind(), "file");
    }
}
