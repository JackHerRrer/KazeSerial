//! Splits the bytes appended to a followed file into lines.
//!
//! A file can be read while its last line is still being written. Only lines terminated
//! by `\n` are emitted; the unterminated rest is kept until a later chunk completes it, so
//! a line written in several steps is never split and a chunk starting with `\n` does not
//! produce an empty line.

#[derive(Debug, Default)]
pub struct TailSplitter {
    /// Text received after the last `\n`, waiting for its line terminator.
    pending: String,
}

/// Text displayed for a line: without the `\r` of a `\r\n` terminator.
fn display_text(raw: &str) -> &str {
    raw.strip_suffix('\r').unwrap_or(raw)
}

impl TailSplitter {
    /// Returns the lines completed by `chunk`, in order.
    pub fn feed(&mut self, chunk: &str) -> Vec<String> {
        self.pending.push_str(chunk);
        let Some(end) = self.pending.rfind('\n') else {
            return Vec::new();
        };
        let rest = self.pending.split_off(end + 1);
        let complete = std::mem::replace(&mut self.pending, rest);
        complete[..end]
            .split('\n')
            .map(|line| display_text(line).to_string())
            .collect()
    }
}

/// Decodes `bytes` as UTF-8 and returns the text with the number of bytes consumed.
/// An incomplete character at the end is left unconsumed so the next read completes it;
/// invalid bytes elsewhere are replaced with `U+FFFD`.
pub fn decode_utf8(bytes: &[u8]) -> (String, usize) {
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_string(), bytes.len()),
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            (String::from_utf8_lossy(&bytes[..valid]).into_owned(), valid)
        }
        Err(_) => (String::from_utf8_lossy(bytes).into_owned(), bytes.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn complete_lines_are_emitted() {
        let mut splitter = TailSplitter::default();
        assert_eq!(splitter.feed("a\nb\n"), lines(&["a", "b"]));
        assert_eq!(splitter.feed("c\n"), lines(&["c"]));
    }

    #[test]
    fn unterminated_line_waits_for_its_terminator() {
        let mut splitter = TailSplitter::default();
        assert_eq!(splitter.feed("old"), lines(&[]));
        assert_eq!(splitter.feed("xyz"), lines(&[]));
        assert_eq!(splitter.feed("\nnew"), lines(&["oldxyz"]));
        assert_eq!(splitter.feed("\n"), lines(&["new"]));
    }

    #[test]
    fn newline_terminating_pending_line_adds_no_empty_line() {
        let mut splitter = TailSplitter::default();
        splitter.feed("old");
        assert_eq!(splitter.feed("\nnew\n"), lines(&["old", "new"]));
    }

    #[test]
    fn crlf_is_handled_across_chunks() {
        let mut splitter = TailSplitter::default();
        assert_eq!(splitter.feed("a\r"), lines(&[]));
        assert_eq!(splitter.feed("\nb\r\n"), lines(&["a", "b"]));
    }

    #[test]
    fn empty_lines_are_kept() {
        let mut splitter = TailSplitter::default();
        assert_eq!(splitter.feed("a\n\nb\n"), lines(&["a", "", "b"]));
        assert_eq!(splitter.feed("\n"), lines(&[""]));
    }

    #[test]
    fn incomplete_utf8_character_is_left_for_next_read() {
        let bytes = "é".as_bytes();
        assert_eq!(decode_utf8(&[b'a', bytes[0]]), ("a".to_string(), 1));
        assert_eq!(decode_utf8(bytes), ("é".to_string(), 2));
    }

    #[test]
    fn invalid_utf8_is_replaced() {
        assert_eq!(decode_utf8(&[b'a', 0xff, b'b']), ("a\u{FFFD}b".to_string(), 3));
    }
}
