//! Splits the bytes received from a serial port into lines.
//!
//! Devices end their lines with `\r\n`, `\r\r\n` (a `\r\n` whose `\n` the device tty expands),
//! `\n\r`, `\r` or `\n`, and sometimes mix them (a stray `\n` after a reset, for instance). The
//! first `\r` or `\n` ends a line, and the bytes completing the same terminator are skipped: the
//! `\r`s before its `\n`, and a `\r` right after a leading `\n`. So no line ever contains a line
//! break, and empty lines are kept, except between `\r`-only terminators.
//!
//! A port opened while the device is sending usually starts with the end of a terminator, or
//! with a `\0` and a `\n`, so the line breaks received before any other byte are skipped instead
//! of making an empty line. `\0` bytes are always skipped: they are not displayed anyway.

#[derive(Debug, Default)]
pub struct SerialSplitter {
    /// Bytes received since the last terminator.
    line: Vec<u8>,
    /// Terminator that ended the last line, while the next bytes may complete it.
    terminator: Option<Terminator>,
    /// Whether a byte other than a line break has been received.
    started: bool,
}

/// Bytes seen in the terminator being received.
#[derive(Debug)]
struct Terminator {
    cr: bool,
    lf: bool,
}

impl SerialSplitter {
    /// Adds a received byte; returns the line it ends, without its terminator.
    pub fn push(&mut self, byte: u8) -> Option<Vec<u8>> {
        let (cr, lf) = match byte {
            b'\r' => (true, false),
            b'\n' => (false, true),
            0 => return None,
            _ => {
                self.terminator = None;
                self.started = true;
                self.line.push(byte);
                return None;
            }
        };
        if !self.started {
            return None;
        }
        if let Some(terminator) = &mut self.terminator {
            // `\r` before the `\n`, or after a leading `\n`; a single `\n`
            let completes = if cr { !terminator.lf || !terminator.cr } else { !terminator.lf };
            if completes {
                terminator.cr |= cr;
                terminator.lf |= lf;
                return None;
            }
        }
        self.terminator = Some(Terminator { cr, lf });
        Some(std::mem::take(&mut self.line))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(bytes: &[u8]) -> Vec<String> {
        let mut splitter = SerialSplitter::default();
        bytes
            .iter()
            .filter_map(|&byte| splitter.push(byte))
            .map(|line| String::from_utf8(line).unwrap())
            .collect()
    }

    #[test]
    fn every_terminator_ends_a_line() {
        assert_eq!(split(b"a\r\nb\n\rc\rd\ne\r\r\nf\n"), ["a", "b", "c", "d", "e", "f"]);
    }

    #[test]
    fn lone_line_feed_inside_crlf_lines_ends_a_line() {
        assert_eq!(split(b"a\r\r\nb\n[1] Collect\r\r\n[2] tick\r\r\n"), ["a", "b", "[1] Collect", "[2] tick"]);
    }

    #[test]
    fn repeated_terminators_are_empty_lines() {
        assert_eq!(split(b"a\r\n\r\nb\n\nc\r\r\n\r\r\nd\n\r\n\re\n"), ["a", "", "b", "", "c", "", "d", "", "e"]);
    }

    #[test]
    fn line_breaks_before_the_first_line_are_skipped() {
        assert_eq!(split(b"\n\r\r\na\r\r\n\r\r\nb\r\r\n"), ["a", "", "b"]);
    }

    #[test]
    fn nul_bytes_are_skipped() {
        assert_eq!(split(b"\0\n[1] Collect\r\r\na\0b\r\r\n"), ["[1] Collect", "ab"]);
    }

    #[test]
    fn unterminated_line_waits_for_its_terminator() {
        let mut splitter = SerialSplitter::default();
        assert_eq!(splitter.push(b'a'), None);
        assert_eq!(splitter.push(b'\r'), Some(b"a".to_vec()));
        assert_eq!(splitter.push(b'\r'), None);
        assert_eq!(splitter.push(b'\n'), None);
        assert_eq!(splitter.push(b'b'), None);
    }
}
