//! Bounded, linear SSE line splitting shared by the streamed wires (review
//! M-2, #2888).
//!
//! The adapters used to append each chunk to a buffer and rescan it from the
//! start for `\n`, so a provider (or a compromised relay) that streamed bytes
//! with no newline made the worker's CPU quadratic and its memory unbounded
//! until the request timeout. Here only the **new** chunk is scanned, and every
//! accumulator has a ceiling; crossing one is a non-retryable
//! [`ProviderError::InvalidResponse`] that ends the turn at once.

use crate::provider::ProviderError;

/// One SSE line (a `data:` field is one line) may not exceed this.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
/// One event's joined `data:` payload may not exceed this.
pub const MAX_EVENT_BYTES: usize = 4 * 1024 * 1024;
/// The accumulated answer text may not exceed this.
pub const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;
/// One tool call's accumulated JSON arguments may not exceed this.
pub const MAX_TOOL_INPUT_BYTES: usize = 1024 * 1024;
/// Content-block indexes above this are refused (Anthropic).
pub const MAX_BLOCK_INDEX: u64 = 63;

/// The error every ceiling reports.
pub fn over_limit(what: &str, limit: usize) -> ProviderError {
    ProviderError::InvalidResponse(format!(
        "provider stream exceeded the {what} limit ({limit} bytes)"
    ))
}

/// Append `chunk` to the pending partial line in `pending`, returning every
/// complete line (without `\r\n` / `\n`). Scans `chunk` only, so the total
/// work over a stream is linear in its length.
pub fn take_lines(pending: &mut Vec<u8>, chunk: &[u8]) -> Result<Vec<Vec<u8>>, ProviderError> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, byte) in chunk.iter().enumerate() {
        if *byte == b'\n' {
            pending.extend_from_slice(&chunk[start..index]);
            let mut line = std::mem::take(pending);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.len() > MAX_LINE_BYTES {
                return Err(over_limit("SSE line", MAX_LINE_BYTES));
            }
            lines.push(line);
            start = index + 1;
        }
    }
    pending.extend_from_slice(&chunk[start..]);
    if pending.len() > MAX_LINE_BYTES {
        return Err(over_limit("SSE line", MAX_LINE_BYTES));
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_split_across_chunks_and_crlf_is_stripped() {
        let mut pending = Vec::new();
        assert!(take_lines(&mut pending, b"data: a").unwrap().is_empty());
        let lines = take_lines(&mut pending, b"bc\r\n\ndata: d").unwrap();
        assert_eq!(lines, vec![b"data: abc".to_vec(), Vec::new()]);
        assert_eq!(pending, b"data: d");
    }

    /// Review M-2: 16 MiB with no newline is refused as soon as the pending
    /// line passes 1 MiB — not after quadratic rescans of the whole buffer.
    #[test]
    fn a_newline_free_flood_is_refused_at_the_line_ceiling() {
        let mut pending = Vec::new();
        let chunk = vec![b'x'; 64 * 1024];
        let started = std::time::Instant::now();
        let mut fed = 0usize;
        let mut refused = false;
        for _ in 0..256 {
            fed += chunk.len();
            if take_lines(&mut pending, &chunk).is_err() {
                refused = true;
                break;
            }
        }
        assert!(refused, "no ceiling on a newline-free stream");
        assert!(
            fed <= MAX_LINE_BYTES + chunk.len(),
            "fed {fed} bytes before refusing"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    /// Many short lines in one huge chunk stay linear.
    #[test]
    fn a_huge_chunk_of_short_lines_is_linear() {
        let chunk = b": ping\n".repeat(2 * 1024 * 1024);
        let started = std::time::Instant::now();
        let lines = take_lines(&mut Vec::new(), &chunk).unwrap();
        assert_eq!(lines.len(), 2 * 1024 * 1024);
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }
}
