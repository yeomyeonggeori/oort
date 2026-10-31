//! The one character rule for short text that an agent or a host writes and people read
//! (ADR-0200 증보 7 7-3, ADR-0162 증보 3 D11): a stage marker, an activity label, a plan step,
//! an activity id.
//!
//! **One function, with the limit as an argument.** The rule used to be a private function of
//! `momo-t3`'s work-session share, with the stage limit (80) a constant. It lives here because
//! two crates that must not depend on each other need the same judgement — `momo-t3` (the
//! share and the Agent Port stage marker) and `momo-agent` (the activity report, which by
//! contract keeps no dependency on `momo-t3`) — and a copy would let the four fields drift
//! apart: tightening this tightens them together (7-Q4). The SQL backstops
//! (`work_session_share_stage_markers_ok`, `agent_report_text_ok`, migration 167) are subsets
//! of it, so a CHECK never fires before this rule does.

/// Control characters include ESC (ANSI) and NUL; the rest is the invisible / direction-changing
/// class (Unicode Cf, Zl, Zp and the default-ignorable fillers) that makes one string read as
/// another or breaks a line in a card.
pub fn is_unsafe_char(c: char) -> bool {
    // Control characters include ESC (ANSI) and NUL; the rest is the invisible /
    // direction-changing class (Unicode Cf, Zl, Zp and the default-ignorable
    // fillers) that makes one string read as another or breaks a line in a card.
    c.is_control()
        || matches!(
            c,
            '\u{00AD}'
                | '\u{034F}'
                | '\u{061C}'
                | '\u{115F}'..='\u{1160}'
                | '\u{17B4}'..='\u{17B5}'
                | '\u{180B}'..='\u{180F}'
                | '\u{200B}'..='\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{206F}'
                | '\u{3164}'
                | '\u{FE00}'..='\u{FE0F}'
                | '\u{FEFF}'
                | '\u{FFA0}'
                | '\u{FFF0}'..='\u{FFFB}'
                | '\u{E0000}'..='\u{E0FFF}'
        )
}

/// Why one piece of text failed the shared rule. A closed kind, so a caller can name the rule
/// without parsing a message (`momo-agent`'s activity report maps it to the `range` /
/// `forbidden` rule names of the Agent Port refusal).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportTextFault {
    /// Empty after trimming, or longer than the field's character limit.
    Length,
    /// A control, invisible or direction-changing character ([`is_unsafe_char`]).
    UnsafeChar,
    /// A `/` or `\\`: a short name is not a path.
    PathSeparator,
}

/// Trim, then judge length (in characters) and characters. The part every short name shares;
/// [`checked_report_text`] adds the path-separator refusal.
pub fn checked_text(raw: &str, max_chars: usize) -> Result<String, ReportTextFault> {
    let value = raw.trim();
    let length = value.chars().count();
    if !(1..=max_chars).contains(&length) {
        return Err(ReportTextFault::Length);
    }
    if value.chars().any(is_unsafe_char) {
        return Err(ReportTextFault::UnsafeChar);
    }
    Ok(value.to_string())
}

/// [`checked_text`] plus the refusal of `/` and `\\`: a stage marker, an activity label, a plan
/// step and an activity id are short words, and a path separator means a path. The one
/// function all four go through.
pub fn checked_report_text(raw: &str, max_chars: usize) -> Result<String, ReportTextFault> {
    let text = checked_text(raw, max_chars)?;
    if text.contains('/') || text.contains('\\') {
        return Err(ReportTextFault::PathSeparator);
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_limit_is_the_callers_and_counts_characters_after_trimming() {
        assert_eq!(
            checked_report_text(&"가".repeat(40), 40).as_deref(),
            Ok(&*"가".repeat(40))
        );
        assert_eq!(
            checked_report_text(&"가".repeat(41), 40),
            Err(ReportTextFault::Length)
        );
        assert_eq!(
            checked_report_text(&format!("  {}  ", "나".repeat(60)), 60).as_deref(),
            Ok(&*"나".repeat(60))
        );
        assert_eq!(checked_report_text("x", 80).as_deref(), Ok("x"));
        assert_eq!(
            checked_report_text(&"x".repeat(81), 80),
            Err(ReportTextFault::Length)
        );
    }

    #[test]
    fn the_kind_of_a_refusal_is_a_value_not_a_sentence() {
        assert_eq!(checked_report_text("   ", 40), Err(ReportTextFault::Length));
        assert_eq!(checked_report_text("", 40), Err(ReportTextFault::Length));
        assert_eq!(
            checked_report_text("x\u{7}", 40),
            Err(ReportTextFault::UnsafeChar)
        );
        assert_eq!(
            checked_report_text("\u{202E}rtl", 40),
            Err(ReportTextFault::UnsafeChar)
        );
        assert_eq!(
            checked_report_text("zero\u{200B}width", 40),
            Err(ReportTextFault::UnsafeChar)
        );
        assert_eq!(
            checked_report_text("a/b", 40),
            Err(ReportTextFault::PathSeparator)
        );
        assert_eq!(
            checked_report_text("a\\b", 40),
            Err(ReportTextFault::PathSeparator)
        );
        // length wins over characters, characters win over the separator: one fixed order
        assert_eq!(
            checked_report_text(&format!("{}/", "x".repeat(40)), 40),
            Err(ReportTextFault::Length)
        );
        assert_eq!(
            checked_report_text("a\u{7}/b", 40),
            Err(ReportTextFault::UnsafeChar)
        );
    }

    /// `checked_text` is the separator-free half: a host label may legitimately hold a `/`.
    #[test]
    fn the_separator_refusal_is_only_in_the_report_text_rule() {
        assert_eq!(checked_text("a/b", 40).as_deref(), Ok("a/b"));
        assert_eq!(checked_text("x\u{7}", 40), Err(ReportTextFault::UnsafeChar));
        assert_eq!(checked_text(" ", 40), Err(ReportTextFault::Length));
    }
}
