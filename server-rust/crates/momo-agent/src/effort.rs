//! The reasoning-effort axis (ADR-0134 D2), ported from Swift
//! `ProviderEffortTableRoutes.swift:41-142`.
//!
//! Migration 041 made `usage_ledger.effort` a **nullable `text` with a length
//! CHECK only** — deliberately not an enum, because "which levels a model accepts
//! differs per model and evolves faster than migrations" (041 header). The
//! semantic gate therefore lives here, in code, and this module is the only place
//! that decides what a valid level is.

/// Canonical superset, ascending (Swift :46). A value outside this set is never a
/// valid effort regardless of model.
pub const EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Longest accepted token — mirrors migration 041's
/// `length(effort) BETWEEN 1 AND 32` CHECK on both columns (Swift :50).
pub const MAX_EFFORT_LENGTH: usize = 32;

/// The conservative triple an unlisted model falls back to (Swift :88), so an
/// unknown model never silently accepts an `xhigh`/`max` the provider would
/// reject downstream.
pub const FALLBACK_EFFORTS: [&str; 3] = ["low", "medium", "high"];

/// One row of the v0 constant table (Swift :61-86). `hermes` is momo's
/// provider-agnostic gateway handle namespace (ADR-0130).
struct EffortEntry {
    model: &'static str,
    efforts: &'static [&'static str],
}

const ENTRIES: [EffortEntry; 4] = [
    EffortEntry {
        model: "hermes-agent",
        efforts: &["low", "medium", "high", "xhigh", "max"],
    },
    EffortEntry {
        model: "hermes-default",
        efforts: &["low", "medium", "high", "xhigh", "max"],
    },
    EffortEntry {
        model: "hermes-fast",
        efforts: &["low", "medium"],
    },
    EffortEntry {
        model: "hermes-lite",
        efforts: &["low", "medium"],
    },
];

/// The levels `model` accepts, falling back to [`FALLBACK_EFFORTS`] (Swift :96).
pub fn supported_efforts(model: &str) -> &'static [&'static str] {
    let normalized = model.trim();
    ENTRIES
        .iter()
        .find(|entry| entry.model == normalized)
        .map(|entry| entry.efforts)
        .unwrap_or(&FALLBACK_EFFORTS)
}

/// Whether `effort` is accepted for `model`. Comparison is on the canonical
/// lowercase token; normalize first with [`known_level`] (Swift :106).
pub fn supports(model: &str, effort: &str) -> bool {
    supported_efforts(model).contains(&effort)
}

/// A token that is a known level, normalized — or `None`.
///
/// Returns `None` rather than erroring (Swift `knownLevel` :137): this is the
/// silent-inheritance path, where an unusable preference is *ignored*, not a
/// client-visible failure.
pub fn known_level(raw: Option<&str>) -> Option<&'static str> {
    let raw = raw?.trim();
    if raw.is_empty() || raw.len() > MAX_EFFORT_LENGTH {
        return None;
    }
    let lowered = raw.to_ascii_lowercase();
    EFFORT_LEVELS
        .iter()
        .find(|level| **level == lowered)
        .copied()
}

/// The value written to `usage_ledger.effort` — Swift
/// `AgentGatewayRoutes.ledgerEffort` (:1379-1395), comment and all.
///
/// **The adapter-reported value wins**: the provider is the authority on what it
/// actually ran, so it is accepted whenever it is a known level, even if this
/// server's table does not list it for that model. The request/profile tiers are
/// *inferences*, so they are accepted only when the resolved model actually
/// supports them — which is also how a model change silently clears a stale
/// preference (D3) instead of writing a wrong analysis axis. Nothing usable →
/// `None`, and the column is nullable by design (041: "NULL = none chosen or
/// inherited").
pub fn ledger_effort(
    reported: Option<&str>,
    requested: Option<&str>,
    profile_preference: Option<&str>,
    model: &str,
) -> Option<&'static str> {
    if let Some(reported) = known_level(reported) {
        return Some(reported);
    }
    for candidate in [requested, profile_preference] {
        let Some(normalized) = known_level(candidate) else {
            continue;
        };
        if supports(model, normalized) {
            return Some(normalized);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_level_set_and_length_cap_match_migration_041() {
        assert_eq!(EFFORT_LEVELS, ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(
            MAX_EFFORT_LENGTH, 32,
            "041: length(effort) BETWEEN 1 AND 32"
        );
        assert_eq!(known_level(Some(&"a".repeat(33))), None);
        assert_eq!(known_level(Some("")), None);
        assert_eq!(known_level(Some("  HIGH  ")), Some("high"));
        assert_eq!(known_level(Some("turbo")), None);
        assert_eq!(known_level(None), None);
    }

    #[test]
    fn an_unlisted_model_falls_back_to_the_conservative_triple() {
        assert_eq!(supported_efforts("gpt-9-ultra"), &FALLBACK_EFFORTS);
        assert!(!supports("gpt-9-ultra", "max"));
        assert!(supports("hermes-agent", "max"));
        assert!(!supports("hermes-fast", "high"));
    }

    /// The provider is the authority on what it ran.
    #[test]
    fn the_adapter_report_wins_even_off_table() {
        assert_eq!(
            ledger_effort(Some("max"), Some("low"), None, "hermes-fast"),
            Some("max"),
            "hermes-fast does not list max, but the adapter says it ran it"
        );
    }

    /// An inference is only recorded when the resolved model could have honoured
    /// it — this is what makes a model change clear a stale preference (D3).
    #[test]
    fn an_inference_is_dropped_when_the_model_cannot_honour_it() {
        assert_eq!(
            ledger_effort(None, Some("xhigh"), None, "hermes-fast"),
            None,
            "a request-tier effort the model rejects must not become an analysis axis"
        );
        assert_eq!(
            ledger_effort(None, None, Some("high"), "hermes-fast"),
            None,
            "a stale agent-profile preference is silently cleared, not written"
        );
        assert_eq!(
            ledger_effort(None, None, Some("medium"), "hermes-fast"),
            Some("medium"),
            "a preference the model supports is inherited"
        );
    }

    #[test]
    fn precedence_is_reported_then_requested_then_profile() {
        assert_eq!(
            ledger_effort(Some("low"), Some("high"), Some("max"), "hermes-agent"),
            Some("low")
        );
        assert_eq!(
            ledger_effort(None, Some("high"), Some("max"), "hermes-agent"),
            Some("high")
        );
        assert_eq!(
            ledger_effort(None, None, Some("max"), "hermes-agent"),
            Some("max")
        );
        assert_eq!(ledger_effort(None, None, None, "hermes-agent"), None);
        // An unknown token at any tier is skipped, not propagated.
        assert_eq!(
            ledger_effort(Some("ludicrous"), Some("high"), None, "hermes-agent"),
            Some("high")
        );
    }
}
