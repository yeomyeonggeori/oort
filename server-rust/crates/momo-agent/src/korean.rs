//! Korean particles for server-authored lines (goal SRV-B5b).
//!
//! ## What was wrong
//!
//! Two lines this server writes **into a channel, durably** hedged in front of
//! the reader:
//!
//! ```text
//! 루나은(는) 현재 일시정지되어 있습니다.
//! 오르트에게 위임하지 못했습니다. 오르트이(가) 동시 실행 한도에 …
//! ```
//!
//! `은(는)` is not a localised string; it is a machine declining to decide
//! something it can decide. For a Hangul ending the choice is *fully*
//! determined by the last syllable, and every agent 성재 actually runs — 루나,
//! 오르트, 김인턴 — is named in Hangul.
//!
//! ## The rule, shared with the clients on purpose
//!
//! [`has_final_consonant`] is a rule-for-rule port of
//! `packages/momo-core/src/lib/koreanParticle.ts` (goal RN-B4c), which is itself
//! a port of the mac client's `MomoKoreanParticle`. Same Hangul range, same
//! `(code - 0xAC00) % 28`, same "trailing whitespace and punctuation are not
//! spoken, so they do not decide".
//!
//! ## …and one deliberate difference, which is why it returns `Option`
//!
//! For a **non-Hangul** ending (`Hermes`, `MOMO-613`, `gpt-5.6-sol`) the clients
//! pick the open form — "Hermes가" — on the argument that a neutral guess beats
//! a hedge on a label that re-renders every frame.
//!
//! This module answers `None` instead, and the callers below keep the `은(는)`
//! hedge for that case. The difference is not an oversight, it is the surface:
//! these two strings are **`message.body` rows**. A UI label that guesses wrong
//! is re-rendered on the next paint; a durable line that guesses wrong is in the
//! room's history forever, and Korean pronunciation of a Latin word is genuinely
//! ambiguous ("슬랙**이**" but "헤르메스**가**" — the same open-form default is
//! right for one and wrong for the other).
//!
//! So `None` is a *representable state* rather than a silent `false`. If the
//! product later decides both surfaces should guess alike, the change is
//! `unwrap_or(false)` at these call sites and nothing else — the shared half
//! stays shared either way.
//!
//! **Swift's originals are left alone** (`MessageRoutes.swift:1601` still writes
//! the hedge). The port discipline is that Swift is the measured reference, not
//! a thing this batch edits; the divergence is recorded here instead.

/// Which of the four particle pairs a sentence needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParticlePair {
    /// 이 / 가
    Subject,
    /// 을 / 를
    Object,
    /// 은 / 는
    Topic,
}

impl ParticlePair {
    /// `(with a final consonant, without one, the hedge)`.
    fn forms(self) -> (&'static str, &'static str, &'static str) {
        match self {
            ParticlePair::Subject => ("이", "가", "이(가)"),
            ParticlePair::Object => ("을", "를", "을(를)"),
            ParticlePair::Topic => ("은", "는", "은(는)"),
        }
    }
}

const HANGUL_FIRST: u32 = 0xAC00;
const HANGUL_LAST: u32 = 0xD7A3;
/// Every Hangul syllable block cycles through 28 final-consonant slots, 0 = none.
const JONGSEONG_SLOTS: u32 = 28;

/// The last character that is actually pronounced.
///
/// Trailing whitespace and punctuation are skipped because they are not spoken,
/// so they do not decide the particle — `"김인턴!"` is still `김인턴이`.
fn last_spoken_char(word: &str) -> Option<char> {
    word.chars().rev().find(|c| !is_unspoken(*c))
}

/// Whitespace, or punctuation a Korean line realistically ends on.
///
/// The clients test `\p{P}` (every Unicode punctuation category). std has no
/// equivalent and this crate carries no unicode table dependency, so the class
/// is **approximated by the blocks that actually appear in Korean copy**: ASCII,
/// General Punctuation (`…` `—` `‘’“”`), CJK Symbols (`。` `、` `「」` `『』`)
/// and Halfwidth/Fullwidth forms (`！` `？` `．`).
///
/// The approximation is safe in one direction on purpose: a punctuation mark
/// this misses is simply *not skipped*, so the word reads as non-Hangul-ending
/// and takes the hedge — the same answer it gave before this goal existed. A
/// miss degrades to the old behaviour rather than to a wrong particle.
fn is_unspoken(c: char) -> bool {
    if c.is_whitespace() || c.is_ascii_punctuation() {
        return true;
    }
    matches!(c as u32,
        0x2000..=0x206F   // General Punctuation
        | 0x3000..=0x303F // CJK Symbols and Punctuation
        | 0xFF00..=0xFF65 // Halfwidth and Fullwidth Forms (punctuation half)
    )
}

/// `Some(true)` for a Hangul syllable closing on a final consonant, `Some(false)`
/// for an open one, and **`None` when the ending is not Hangul at all** — see
/// the module header for why that third case exists.
pub fn has_final_consonant(word: &str) -> Option<bool> {
    let last = last_spoken_char(word)?;
    let code = last as u32;
    if !(HANGUL_FIRST..=HANGUL_LAST).contains(&code) {
        return None;
    }
    Some(!(code - HANGUL_FIRST).is_multiple_of(JONGSEONG_SLOTS))
}

/// The particle alone: the decided form, or the hedge when undecidable.
pub fn particle_for(word: &str, pair: ParticlePair) -> &'static str {
    let (with_final, without_final, hedge) = pair.forms();
    match has_final_consonant(word) {
        Some(true) => with_final,
        Some(false) => without_final,
        None => hedge,
    }
}

/// `"루나"` + Topic → `"루나는"`; `"Hermes"` + Topic → `"Hermes은(는)"`.
pub fn attach_particle(word: &str, pair: ParticlePair) -> String {
    format!("{word}{}", particle_for(word, pair))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The agents 성재 actually runs, which is the whole reason this exists.
    #[test]
    fn the_real_roster_reads_like_korean() {
        assert_eq!(attach_particle("루나", ParticlePair::Topic), "루나는");
        assert_eq!(attach_particle("오르트", ParticlePair::Topic), "오르트는");
        assert_eq!(attach_particle("김인턴", ParticlePair::Topic), "김인턴은");
        assert_eq!(attach_particle("오르트", ParticlePair::Subject), "오르트가");
        assert_eq!(attach_particle("김인턴", ParticlePair::Subject), "김인턴이");
    }

    /// The arithmetic, at both ends of the block and across the 28-slot cycle.
    #[test]
    fn the_jongseong_cycle_is_the_whole_rule() {
        // 가 (0xAC00) is the first syllable and has no final consonant; 각 is
        // the next code point and has one.
        assert_eq!(has_final_consonant("가"), Some(false));
        assert_eq!(has_final_consonant("각"), Some(true));
        // 힣 (0xD7A3) is the last syllable in the block, and it closes.
        assert_eq!(has_final_consonant("힣"), Some(true));
        // One full cycle on: 개 (0xAC00 + 28) is open again.
        assert_eq!(has_final_consonant("개"), Some(false));
    }

    /// Punctuation and whitespace are not spoken, so they do not decide.
    #[test]
    fn trailing_punctuation_does_not_decide_the_particle() {
        for spelled in [
            "김인턴",
            "김인턴 ",
            "김인턴!",
            "김인턴...",
            "김인턴 \t",
            // Non-ASCII marks a Korean line actually ends on. The clients skip
            // these via `\p{P}`; this crate approximates the class by block.
            "김인턴…",
            "김인턴。",
            "김인턴！",
            "「김인턴」",
        ] {
            assert_eq!(
                has_final_consonant(spelled),
                Some(true),
                "{spelled:?} still ends in 턴"
            );
        }
        assert_eq!(has_final_consonant("   "), None, "nothing spoken at all");
        assert_eq!(has_final_consonant(""), None);
    }

    /// A non-Hangul ending is **undecidable**, not "open".
    ///
    /// This is the one place this module diverges from the clients, and the
    /// assertion states the reason: Korean pronunciation of a Latin word is
    /// genuinely ambiguous, and these strings are durable message bodies.
    #[test]
    fn a_non_hangul_ending_hedges_rather_than_guesses() {
        for foreign in ["Hermes", "MOMO-613", "gpt-5.6-sol", "503", "🌙"] {
            assert_eq!(
                has_final_consonant(foreign),
                None,
                "{foreign} has no single Korean reading"
            );
            assert_eq!(
                attach_particle(foreign, ParticlePair::Topic),
                format!("{foreign}은(는)"),
                "the hedge is honest here; the clients guess open because a label \
                 re-renders and a channel line does not"
            );
        }
        // …and switching to the clients' behaviour is one call away, which is
        // what makes this a policy rather than a fork of the rule.
        assert!(!has_final_consonant("Hermes").unwrap_or(false));
    }

    /// A mixed name decides on its last spoken syllable, not on its script.
    #[test]
    fn a_mixed_name_decides_on_what_is_actually_spoken_last() {
        assert_eq!(
            attach_particle("GPT-5 루나", ParticlePair::Topic),
            "GPT-5 루나는"
        );
        assert_eq!(
            attach_particle("루나 Hermes", ParticlePair::Topic),
            "루나 Hermes은(는)"
        );
    }
}
