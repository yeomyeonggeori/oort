//! What goes to the terminal: JSON documents, text that other people wrote, times.

use std::io::Write;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;

/// One JSON document on standard output, then a newline (ADR-0216 D10 「안정 출력」).
pub fn print_json<T: Serialize>(value: &T) -> std::io::Result<()> {
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    serde_json::to_writer(&mut handle, value).map_err(std::io::Error::other)?;
    handle.write_all(b"\n")?;
    handle.flush()
}

/// One line on standard error (messages, warnings): never data.
pub fn note(message: &str) {
    let _ = writeln!(std::io::stderr().lock(), "{message}");
}

/// Text another person, the server or the argument parser wrote, made safe to print.
///
/// * A message body can carry escape sequences (`ESC [ 2 J`, a title-bar rewrite, a hyperlink)
///   and Unicode bidirectional overrides that make a line read differently from what it is:
///   control characters other than newline and tab and the bidi controls become `?`.
/// * Anything shaped like an oort token (`momo_dev…`) becomes `[토큰]`. A person who types a
///   token where it does not belong (`oort login --with-token momo_dev_v1…`) must not have the
///   parser's complaint print it back into a scrollback.
///
/// JSON output is not touched: JSON escapes control characters on its own, and no document holds
/// a token but `oort token`'s.
pub fn sanitize(text: &str) -> String {
    redact_tokens(text)
        .chars()
        .map(|character| {
            let bidi = matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}');
            let control = character.is_control() && character != '\n' && character != '\t';
            if bidi || control {
                '?'
            } else {
                character
            }
        })
        .collect()
}

/// Replace every run that starts like an oort token envelope (`momo_dev_v1.`, `momo_devr_v1.`)
/// with `[토큰]`, up to the first character that cannot be part of one.
pub fn redact_tokens(text: &str) -> String {
    const MARKER: &str = "momo_dev";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(MARKER) {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let length = tail
            .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')))
            .unwrap_or(tail.len());
        out.push_str("[토큰]");
        rest = &tail[length..];
    }
    out.push_str(rest);
    out
}

/// Epoch milliseconds as RFC 3339 UTC (`2026-10-28T09:30:00Z`).
pub fn rfc3339(epoch_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(epoch_ms)
        .map(|time| time.to_rfc3339_opts(SecondsFormat::Secs, true))
        .unwrap_or_else(|| "-".to_string())
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// The first 8 characters of an id: enough to tell people apart on one screen.
pub fn short_id(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_sequences_and_bidi_overrides_never_reach_the_terminal() {
        let hostile = "ok\u{1b}[2Jgone\u{202e}txt\u{7}\u{9b}x\ttab\nline";
        let safe = sanitize(hostile);
        assert_eq!(safe, "ok?[2Jgone?txt??x\ttab\nline");
        assert!(sanitize("한국어 · 😀").contains("한국어 · 😀"));
    }

    #[test]
    fn anything_shaped_like_a_token_is_replaced_wherever_it_appears() {
        let token = "momo_dev_v1.6f1c2b0e-3a4d-4e5f-8a9b-0c1d2e3f4a5b.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
        let refresh = token.replace("momo_dev_v1", "momo_devr_v1");
        let printed = sanitize(&format!(
            "unexpected argument '{token}' found; also {refresh}, and ({token})"
        ));
        assert!(!printed.contains("AbCdEf"), "{printed}");
        assert!(!printed.contains("momo_dev"), "{printed}");
        assert_eq!(printed.matches("[토큰]").count(), 3, "{printed}");
        assert_eq!(sanitize("plain text, no secrets"), "plain text, no secrets");
    }

    #[test]
    fn times_are_rfc3339_utc() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_793_179_800_000), "2026-10-28T09:30:00Z");
    }
}
