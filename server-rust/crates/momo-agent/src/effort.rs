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
///
/// The 2026-08-04 upstream catalog lists a sixth level, `ultra`, on
/// `gpt-5.6-sol` and `gpt-5.6-terra` ("Maximum reasoning with automatic task
/// delegation"). It is **not** added here, and the omission is a decision rather
/// than an oversight: a level that delegates sub-tasks is a different cost and
/// approval shape than the five below, the clients' Korean label map
/// (`packages/momo-core/src/features/routing/routingModel.ts`) would render it
/// as the bare token `ultra`, and nothing in momo has measured it end to end.
/// Fail-closed is the cheap direction — an `ultra` request is a 400 today and
/// adding the level later breaks nothing.
pub const EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Longest accepted token — mirrors migration 041's
/// `length(effort) BETWEEN 1 AND 32` CHECK on both columns (Swift :50).
pub const MAX_EFFORT_LENGTH: usize = 32;

/// The conservative triple an unlisted model falls back to (Swift :88), so an
/// unknown model never silently accepts an `xhigh`/`max` the provider would
/// reject downstream.
pub const FALLBACK_EFFORTS: [&str; 3] = ["low", "medium", "high"];

/// The level an unlisted model starts at (Swift :89).
pub const FALLBACK_DEFAULT_EFFORT: &str = "medium";

/// Where a row's `model` string comes from — and therefore how much this server
/// is entitled to claim about it.
///
/// The distinction is not cosmetic: [`provider_catalog_models`] is what
/// [`crate::mention::allowed_agent_models`] may offer to a workspace that has
/// never configured an allow-list, and offering a name nobody measured is
/// exactly the failure the fallback triple exists to prevent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelOrigin {
    /// One of momo's own provider-agnostic gateway handles (ADR-0130). What a
    /// given deployment's hermes maps `hermes-fast` *to* is a per-instance
    /// configuration fact this server has not measured, so these names are
    /// never offered as alternatives to anyone.
    GatewayHandle,
    /// A model id the upstream provider publishes in its **own** catalog.
    ///
    /// Measured 2026-08-04 from `GET https://chatgpt.com/backend-api/codex/models`
    /// — the same base URL the ADR-0147 OAuth link stores
    /// (`momo-settings/src/link.rs:349`) and the same host
    /// `bins/momo-agent-worker/src/responses.rs` posts `/responses` to. The
    /// response body carries `slug`, `default_reasoning_level` and
    /// `supported_reasoning_levels[]` per model; the rows below are that
    /// answer, narrowed (never widened) to levels momo's own vocabulary knows.
    ProviderCatalog,
}

/// One row of the v0 constant table (Swift :61-86). `hermes` is momo's
/// provider-agnostic gateway handle namespace (ADR-0130).
///
/// `provider` and `default_effort` exist because B4.2 serves this table over the
/// wire (`GET /v1/provider/effort-table`), and the response is shaped
/// provider → models → efforts so a later DB/registry source can replace the
/// constant without a client-visible contract change. They live **here** rather
/// than in the route so the picker's vocabulary and the ledger writer's stay one
/// table — two copies is how a picker comes to offer a level the writer drops.
pub struct EffortEntry {
    pub provider: &'static str,
    pub model: &'static str,
    pub efforts: &'static [&'static str],
    /// The level chosen when nothing else in the ADR-0134 D3 chain says
    /// otherwise. Never above what `efforts` lists.
    pub default_effort: &'static str,
    /// Whether `model` is a name momo made up or a name the provider publishes.
    pub origin: ModelOrigin,
}

/// The wire `provider` key for the measured upstream catalog.
///
/// Deliberately **not** `external-hermes`: that is migration 039's *link mode*
/// (how this instance connects), while this is the *catalog* the link reaches.
/// One instance-global link may be re-pointed without the models it served
/// changing their names.
pub const PROVIDER_OPENAI_CODEX: &str = "openai-codex";

/// The gateway-handle namespace (ADR-0130).
pub const PROVIDER_HERMES: &str = "hermes";

const ENTRIES: [EffortEntry; 10] = [
    EffortEntry {
        provider: PROVIDER_HERMES,
        model: "hermes-agent",
        efforts: &["low", "medium", "high", "xhigh", "max"],
        default_effort: "medium",
        origin: ModelOrigin::GatewayHandle,
    },
    EffortEntry {
        provider: PROVIDER_HERMES,
        model: "hermes-default",
        efforts: &["low", "medium", "high", "xhigh", "max"],
        default_effort: "medium",
        origin: ModelOrigin::GatewayHandle,
    },
    EffortEntry {
        provider: PROVIDER_HERMES,
        model: "hermes-fast",
        efforts: &["low", "medium"],
        default_effort: "low",
        origin: ModelOrigin::GatewayHandle,
    },
    EffortEntry {
        provider: PROVIDER_HERMES,
        model: "hermes-lite",
        efforts: &["low", "medium"],
        default_effort: "low",
        origin: ModelOrigin::GatewayHandle,
    },
    // ---- measured 2026-08-04, `GET {base}/models` ---------------------------
    // Order = the catalog's own `priority`, so the picker reads the way the
    // provider ranks its models rather than the way they happen to be spelled.
    EffortEntry {
        provider: PROVIDER_OPENAI_CODEX,
        model: "gpt-5.6-sol",
        // The catalog also lists `ultra` here. momo does not serve it — see
        // `EFFORT_LEVELS`.
        efforts: &["low", "medium", "high", "xhigh", "max"],
        default_effort: "low",
        origin: ModelOrigin::ProviderCatalog,
    },
    EffortEntry {
        provider: PROVIDER_OPENAI_CODEX,
        model: "gpt-5.6-terra",
        efforts: &["low", "medium", "high", "xhigh", "max"],
        default_effort: "medium",
        origin: ModelOrigin::ProviderCatalog,
    },
    EffortEntry {
        provider: PROVIDER_OPENAI_CODEX,
        model: "gpt-5.6-luna",
        efforts: &["low", "medium", "high", "xhigh", "max"],
        default_effort: "medium",
        origin: ModelOrigin::ProviderCatalog,
    },
    EffortEntry {
        provider: PROVIDER_OPENAI_CODEX,
        model: "gpt-5.5",
        efforts: &["low", "medium", "high", "xhigh"],
        default_effort: "medium",
        origin: ModelOrigin::ProviderCatalog,
    },
    EffortEntry {
        provider: PROVIDER_OPENAI_CODEX,
        model: "gpt-5.4",
        efforts: &["low", "medium", "high", "xhigh"],
        default_effort: "medium",
        origin: ModelOrigin::ProviderCatalog,
    },
    EffortEntry {
        provider: PROVIDER_OPENAI_CODEX,
        model: "gpt-5.4-mini",
        efforts: &["low", "medium", "high", "xhigh"],
        default_effort: "medium",
        origin: ModelOrigin::ProviderCatalog,
    },
];

/// Every measured provider model id, in table order.
///
/// This is the **only** list a workspace with no configured allow-list may be
/// offered beyond its agent's own model, and it is deliberately a projection of
/// `ENTRIES` rather than a second constant: a model that can be picked but has
/// no effort row would hand the picker a level the send path drops.
pub fn provider_catalog_models() -> impl Iterator<Item = &'static str> {
    ENTRIES
        .iter()
        .filter(|entry| entry.origin == ModelOrigin::ProviderCatalog)
        .map(|entry| entry.model)
}

/// Whether `model` is one of the measured provider ids (trimmed, exact case).
///
/// Exact case on purpose: this string is sent to the provider verbatim, and a
/// case-folded match here would let `GPT-5.6-Luna` into the allow-list and then
/// out to a backend that answers 400.
pub fn is_provider_catalog_model(model: &str) -> bool {
    let normalized = model.trim();
    ENTRIES
        .iter()
        .any(|entry| entry.model == normalized && entry.origin == ModelOrigin::ProviderCatalog)
}

/// The table grouped by provider, in first-seen order (Swift
/// `ProviderEffortTable.response` :144-171).
///
/// First-seen rather than sorted: the order of `ENTRIES` is the order an operator
/// reads them in, and re-sorting would make the wire order an accident of
/// spelling.
pub fn providers() -> Vec<(&'static str, Vec<&'static EffortEntry>)> {
    let mut grouped: Vec<(&'static str, Vec<&'static EffortEntry>)> = Vec::new();
    for entry in ENTRIES.iter() {
        match grouped.iter_mut().find(|(name, _)| *name == entry.provider) {
            Some((_, models)) => models.push(entry),
            None => grouped.push((entry.provider, vec![entry])),
        }
    }
    grouped
}

/// The level `model` starts at (Swift `defaultEffort` :100-102).
pub fn default_effort(model: &str) -> &'static str {
    let normalized = model.trim();
    ENTRIES
        .iter()
        .find(|entry| entry.model == normalized)
        .map(|entry| entry.default_effort)
        .unwrap_or(FALLBACK_DEFAULT_EFFORT)
}

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
        assert_eq!(default_effort("gpt-9-ultra"), FALLBACK_DEFAULT_EFFORT);
    }

    /// Every default must be a level its own model actually accepts — a table
    /// that starts a model above its ceiling hands out a guaranteed 400.
    #[test]
    fn every_default_effort_is_a_level_its_model_accepts() {
        for entry in ENTRIES.iter() {
            assert!(
                entry.efforts.contains(&entry.default_effort),
                "{} defaults to {}, which it does not list",
                entry.model,
                entry.default_effort
            );
            assert!(EFFORT_LEVELS.contains(&entry.default_effort));
        }
        assert!(FALLBACK_EFFORTS.contains(&FALLBACK_DEFAULT_EFFORT));
        assert_eq!(default_effort("hermes-fast"), "low");
        assert_eq!(default_effort("  hermes-agent  "), "medium");
    }

    /// Providers come out in first-seen order, and every model lands under
    /// exactly one of them.
    #[test]
    fn the_table_groups_by_provider_in_first_seen_order() {
        let grouped = providers();
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].0, PROVIDER_HERMES);
        assert_eq!(
            grouped[0]
                .1
                .iter()
                .map(|entry| entry.model)
                .collect::<Vec<_>>(),
            vec![
                "hermes-agent",
                "hermes-default",
                "hermes-fast",
                "hermes-lite"
            ]
        );
        assert_eq!(grouped[1].0, PROVIDER_OPENAI_CODEX);
        assert_eq!(
            grouped
                .iter()
                .map(|(_, models)| models.len())
                .sum::<usize>(),
            ENTRIES.len(),
            "no model may be dropped or duplicated by the grouping"
        );
    }

    /// The measured rows, pinned literally.
    ///
    /// This test is the *evidence*, not a tautology: it fails the moment someone
    /// edits the table by intuition instead of by re-reading
    /// `GET https://chatgpt.com/backend-api/codex/models`. The 2026-08-04 answer
    /// carried eight slugs; two are absent below on purpose —
    /// `gpt-5.3-codex-spark` (`supported_in_api: false`) and `codex-auto-review`
    /// (a review-only alias whose `display_name` is confusingly *GPT-5.6-Luna*;
    /// the general model of that family is `gpt-5.6-luna`, which is here).
    #[test]
    fn the_measured_provider_catalog_is_the_2026_08_04_answer() {
        assert_eq!(
            provider_catalog_models().collect::<Vec<_>>(),
            vec![
                "gpt-5.6-sol",
                "gpt-5.6-terra",
                "gpt-5.6-luna",
                "gpt-5.5",
                "gpt-5.4",
                "gpt-5.4-mini",
            ],
            "the catalog is measured, not invented — re-measure before editing"
        );
        // 성재's two complaints, as assertions.
        assert!(
            is_provider_catalog_model("gpt-5.6-luna"),
            "'루나 모델 피커에 luna가 없다' — the id the picker was missing"
        );
        for level in ["xhigh", "max"] {
            assert!(
                supports("gpt-5.6-sol", level),
                "'추론 강도에 매우 높음/최대가 없다' — {level} is measured-supported on sol"
            );
            assert!(supports("gpt-5.6-luna", level));
            assert!(supports("gpt-5.6-terra", level));
        }
        // …and the narrower rows stay narrow: 5.5/5.4 stop at xhigh.
        assert!(supports("gpt-5.5", "xhigh"));
        assert!(!supports("gpt-5.5", "max"));
        assert!(!supports("gpt-5.4-mini", "max"));
    }

    /// `ultra` is in the upstream catalog and deliberately not in momo's.
    #[test]
    fn the_sixth_upstream_level_is_refused_rather_than_half_supported() {
        assert!(!EFFORT_LEVELS.contains(&"ultra"));
        assert_eq!(known_level(Some("ultra")), None);
        assert!(!supports("gpt-5.6-sol", "ultra"));
        assert_eq!(
            ledger_effort(None, Some("ultra"), None, "gpt-5.6-sol"),
            None,
            "an unknown token is never written to the analysis axis"
        );
    }

    /// A gateway handle is never a catalog id, which is what stops
    /// `allowed_agent_models` from offering `hermes-lite` to a hermes
    /// deployment that never said it serves one.
    #[test]
    fn gateway_handles_are_not_provider_catalog_ids() {
        for handle in [
            "hermes-agent",
            "hermes-default",
            "hermes-fast",
            "hermes-lite",
        ] {
            assert!(!is_provider_catalog_model(handle), "{handle}");
        }
        assert!(is_provider_catalog_model("  gpt-5.6-luna  "), "trimmed");
        assert!(
            !is_provider_catalog_model("GPT-5.6-Luna"),
            "the id goes to the provider verbatim, so the match is case-exact"
        );
        assert!(!is_provider_catalog_model("gpt-5.3-codex-spark"));
        assert!(!is_provider_catalog_model("codex-auto-review"));
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
