//! The typed `'#이름'` folded the way the server folds a channel name (ADR-0225 D3 steps 1-5).
//!
//! This is the CLI's own copy of `momo_messaging::channel::fold_channel_name`: the binary links no
//! server crate, so the five steps are retyped here and `tests/channel_name_fold.rs` (which
//! depends on the server as a dev-dependency only) holds the two together with the shared vector
//! file and a random batch (ADR-0225 D11). The CLI only *finds* a channel with this value; whether
//! a name may be created is the server's call, so there is no accept/refuse decision here.

use unicode_normalization::UnicodeNormalization as _;

/// The five steps, in order:
///
/// - NFC.
/// - Fullwidth U+FF01..=U+FF5E to U+0021..=U+007E (not NFKC: it would turn compatibility jamo
///   into conjoining ones).
/// - Unicode `White_Space` (`char::is_whitespace`): edge runs go, an inner run becomes one `-`, or
///   nothing when a `-` or `_` already sits next to it.
/// - Lowercase the whole string (default rules, so a final capital sigma becomes `ς`).
/// - NFC again.
pub fn fold_channel_name(raw: &str) -> String {
    let folded: Vec<char> = raw
        .nfc()
        .map(|c| match u32::from(c) {
            code @ 0xFF01..=0xFF5E => char::from_u32(code - 0xFEE0).unwrap_or(c),
            _ => c,
        })
        .collect();
    let is_separator = |c: char| c == '-' || c == '_';
    let mut spaced = String::with_capacity(raw.len());
    let mut index = 0;
    while index < folded.len() {
        let c = folded[index];
        if !c.is_whitespace() {
            spaced.push(c);
            index += 1;
            continue;
        }
        let run_start = index;
        while index < folded.len() && folded[index].is_whitespace() {
            index += 1;
        }
        let Some(&next) = folded.get(index) else {
            break; // a trailing run: dropped
        };
        if run_start == 0 {
            continue; // a leading run: dropped
        }
        let beside_separator =
            spaced.chars().next_back().is_some_and(is_separator) || is_separator(next);
        if !beside_separator {
            spaced.push('-');
        }
    }
    spaced.to_lowercase().nfc().collect()
}
