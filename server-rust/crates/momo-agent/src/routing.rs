//! The per-request routing tier — `routing { model?, effort? }` (B5.3a).
//!
//! Ported from Swift `RunRouting.swift` (`RunRoutingInput` :25-95 and
//! `RunRoutingResolution` :97-177), which is deliberately **one** type shared by
//! both surfaces that can start a run:
//!
//! ```text
//! POST …/channels/{ch}/agent-runs   (work runs, MOMO-621)
//! POST …/channels/{ch}/messages     (agent mentions, MOMO-625)
//! ```
//!
//! Two properties make that sharing load-bearing rather than tidy:
//!
//! * a `routing` block can never mean two different things depending on how the
//!   run happened to be triggered, and
//! * the **gate asymmetry** (ADR-0134 D1) is stated once: an *explicit* request
//!   value that the workspace does not permit is a visible **400**, while an
//!   *inherited* agent-profile preference that is not usable is silently ignored
//!   and audited ([`crate::mention::resolve_mention_routing`]). The user just
//!   chose the first one, so the failure must be visible; nobody chose the
//!   second one today, so failing the send for it would punish the wrong act.
//!
//! ## Where each half runs
//!
//! Shape validation ([`validate_request_routing`]) is **pure**, so it runs before
//! any transaction opens — the MOMO-362 convention that a malformed body costs no
//! connection. The allow-list and model×effort gates need tenant rows
//! (`workspace.settings`, `agent`, `agent_profile`) and therefore run *inside* the
//! send transaction, once per mentioned agent.

use serde_json::{json, Map, Value};

use crate::effort::{known_level, EFFORT_LEVELS, MAX_EFFORT_LENGTH};

/// The only keys the routing object accepts — Swift `RunRoutingInput.allowedKeys`
/// (:27). Anything else is a 400 rather than a silently dropped intent: ADR-0134
/// D1 B (smuggling routing through a free-form field) was rejected for exactly
/// that reason.
pub const ROUTING_KEYS: [&str; 2] = ["model", "effort"];

/// Swift `RunRoutingInput.maxModelLength` (:28).
pub const MAX_ROUTING_MODEL_LENGTH: usize = 200;

/// Every way a `routing` block can be refused, with Swift's exact sentence.
///
/// The sentences matter beyond tidiness on this surface: the web client's
/// capability probe decides whether to open the composer's model/effort selector
/// by testing the refusal against `/routing/i`
/// (`clients/web/src/features/routing/capability.ts`, `verdictFromSendProbe`), so
/// a refusal that stopped naming `routing` would make a server that *does* serve
/// routing look like one that does not.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RoutingInvalid {
    #[error("routing must be an object")]
    Shape,
    #[error("routing contains unknown fields")]
    UnknownFields,
    #[error("{0} must be a string")]
    NotAString(&'static str),
    #[error("{0} must not be empty")]
    Empty(&'static str),
    #[error("{0} is too large")]
    TooLarge(&'static str),
    #[error("routing.effort must be one of {}", EFFORT_LEVELS.join(", "))]
    UnknownEffortLevel,
    /// ADR-0131 D2 allow-list, applied to an **explicit** request value.
    #[error("routing.model is not in workspace.settings.allowed_agent_models")]
    ModelNotAllowed,
    /// ADR-0134 D2 provider×model effort table, applied to an explicit value.
    #[error("routing.effort is not supported by model {0}")]
    EffortUnsupported(String),
}

/// A validated per-request routing block — Swift `RunRoutingInput` (:25-95).
///
/// An absent/empty object *inherits*, so it validates to `None` rather than an
/// all-`None` block; that keeps the stored `agent_run.input` free of noise keys
/// and makes "the caller chose nothing" and "the caller chose nothing twice"
/// the same request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestedRouting {
    pub model: Option<String>,
    /// Already normalized to a canonical level (`"  HIGH "` → `"high"`).
    pub effort: Option<String>,
}

impl RequestedRouting {
    /// The canonical echo written into `agent_run.input.routing` — Swift
    /// `jsonValue` (:62-67) / `auditObject` (:69-74).
    ///
    /// It records what the caller **asked for**, never what was resolved, so the
    /// stored input stays a pure function of the request body (which is what the
    /// work path's idempotency comparison depends on) and an inherited preference
    /// is never replayed as if it had been a client choice.
    pub fn json_value(&self) -> Option<Value> {
        let mut object = Map::new();
        if let Some(model) = self.model.as_deref() {
            object.insert("model".into(), json!(model));
        }
        if let Some(effort) = self.effort.as_deref() {
            object.insert("effort".into(), json!(effort));
        }
        if object.is_empty() {
            None
        } else {
            Some(Value::Object(object))
        }
    }
}

/// Shape-only validation — Swift `RunRoutingInput.validate` (:37-57).
///
/// Pure: no tenant row is read here, so this runs before the transaction opens.
/// The judgements that need workspace state (the allow-list, the model×effort
/// table) belong to [`crate::mention::resolve_mention_routing`].
pub fn validate_request_routing(
    value: Option<&Value>,
) -> Result<Option<RequestedRouting>, RoutingInvalid> {
    let Some(value) = value else { return Ok(None) };
    if value.is_null() {
        return Ok(None);
    }
    let Some(object) = value.as_object() else {
        return Err(RoutingInvalid::Shape);
    };
    if object
        .keys()
        .any(|key| !ROUTING_KEYS.contains(&key.as_str()))
    {
        return Err(RoutingInvalid::UnknownFields);
    }

    let model = optional_token(
        object.get("model"),
        "routing.model",
        MAX_ROUTING_MODEL_LENGTH,
    )?;
    let effort = match optional_token(object.get("effort"), "routing.effort", MAX_EFFORT_LENGTH)? {
        None => None,
        Some(raw) => Some(
            known_level(Some(&raw))
                .ok_or(RoutingInvalid::UnknownEffortLevel)?
                .to_string(),
        ),
    };
    if model.is_none() && effort.is_none() {
        return Ok(None);
    }
    Ok(Some(RequestedRouting { model, effort }))
}

/// Swift `RunRoutingInput.optionalToken` (:76-94): a present-but-null value
/// inherits, an empty or over-long one is refused **by name**.
fn optional_token(
    value: Option<&Value>,
    field: &'static str,
    limit: usize,
) -> Result<Option<String>, RoutingInvalid> {
    let Some(value) = value else { return Ok(None) };
    if value.is_null() {
        return Ok(None);
    }
    let raw = value
        .as_str()
        .ok_or(RoutingInvalid::NotAString(field))?
        .trim();
    if raw.is_empty() {
        return Err(RoutingInvalid::Empty(field));
    }
    if raw.len() > limit {
        return Err(RoutingInvalid::TooLarge(field));
    }
    Ok(Some(raw.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_or_empty_block_inherits_rather_than_pinning_nothing() {
        assert_eq!(validate_request_routing(None), Ok(None));
        assert_eq!(validate_request_routing(Some(&Value::Null)), Ok(None));
        assert_eq!(validate_request_routing(Some(&json!({}))), Ok(None));
        assert_eq!(
            validate_request_routing(Some(&json!({"model": null, "effort": null}))),
            Ok(None),
            "an explicit null is 'inherit', not 'choose nothing'"
        );
    }

    #[test]
    fn the_routing_object_is_closed_world() {
        assert_eq!(
            validate_request_routing(Some(&json!({"temperature": 0.7}))),
            Err(RoutingInvalid::UnknownFields)
        );
        assert_eq!(
            validate_request_routing(Some(&json!([1, 2]))),
            Err(RoutingInvalid::Shape)
        );
        assert_eq!(
            validate_request_routing(Some(&json!("high"))),
            Err(RoutingInvalid::Shape)
        );
    }

    #[test]
    fn a_token_is_trimmed_and_bounded_and_named_in_its_refusal() {
        let parsed = validate_request_routing(Some(&json!({"model": "  hermes-fast  "})))
            .expect("valid")
            .expect("present");
        assert_eq!(parsed.model.as_deref(), Some("hermes-fast"));
        assert_eq!(parsed.effort, None);

        assert_eq!(
            validate_request_routing(Some(&json!({"model": "   "}))),
            Err(RoutingInvalid::Empty("routing.model"))
        );
        assert_eq!(
            validate_request_routing(Some(&json!({"model": 7}))),
            Err(RoutingInvalid::NotAString("routing.model"))
        );
        assert_eq!(
            validate_request_routing(Some(
                &json!({"model": "x".repeat(MAX_ROUTING_MODEL_LENGTH + 1)})
            )),
            Err(RoutingInvalid::TooLarge("routing.model"))
        );
    }

    /// The effort is normalized at the boundary, so what is stored (and what the
    /// ledger later reads from `input.routing.effort`) is a canonical level.
    #[test]
    fn an_effort_is_normalized_and_must_be_a_known_level() {
        let parsed = validate_request_routing(Some(&json!({"effort": "  HIGH "})))
            .expect("valid")
            .expect("present");
        assert_eq!(parsed.effort.as_deref(), Some("high"));
        assert_eq!(
            validate_request_routing(Some(&json!({"effort": "ludicrous"}))),
            Err(RoutingInvalid::UnknownEffortLevel)
        );
        assert_eq!(
            validate_request_routing(Some(&json!({"effort": "__momo-capability-probe__"}))),
            Err(RoutingInvalid::UnknownEffortLevel),
            "the web capability probe's token is refused by name, which is how the \
             composer learns this server serves routing at all"
        );
    }

    /// Every refusal names `routing`, because the web probe matches the sentence
    /// with `/routing/i` to decide whether to open the model/effort selector.
    #[test]
    fn every_refusal_names_routing() {
        for error in [
            RoutingInvalid::Shape,
            RoutingInvalid::UnknownFields,
            RoutingInvalid::NotAString("routing.model"),
            RoutingInvalid::Empty("routing.model"),
            RoutingInvalid::TooLarge("routing.effort"),
            RoutingInvalid::UnknownEffortLevel,
            RoutingInvalid::ModelNotAllowed,
            RoutingInvalid::EffortUnsupported("hermes-fast".into()),
        ] {
            let sentence = error.to_string();
            assert!(
                sentence.to_lowercase().contains("routing"),
                "`verdictFromSendProbe` reads /routing/i as `ready`: {sentence}"
            );
        }
        assert_eq!(
            RoutingInvalid::UnknownEffortLevel.to_string(),
            "routing.effort must be one of low, medium, high, xhigh, max",
            "the sentence enumerates the levels this server actually accepts"
        );
    }

    /// The echo is what the caller asked for, and an absent half is omitted
    /// rather than written as null.
    #[test]
    fn the_echo_records_the_request_and_omits_what_was_not_asked_for() {
        let requested = validate_request_routing(Some(&json!({"effort": "low"})))
            .expect("valid")
            .expect("present");
        assert_eq!(requested.json_value(), Some(json!({"effort": "low"})));

        let both =
            validate_request_routing(Some(&json!({"model": "hermes-fast", "effort": "low"})))
                .expect("valid")
                .expect("present");
        assert_eq!(
            both.json_value(),
            Some(json!({"model": "hermes-fast", "effort": "low"}))
        );
    }
}
