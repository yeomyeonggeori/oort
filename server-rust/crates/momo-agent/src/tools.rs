//! The tool catalog and the §3.3 G6 approval policy (goal SRV-T1).
//!
//! ## What a "tool" is here, and what it is not
//!
//! An agent declares the functions it may call in `agent.tool_schema`
//! (`001_init.sql:80`, "OpenAI function defs"). That column is already read by
//! [`crate::mention::load_mention_candidates_in_tx`] and already shipped to the
//! worker as `agent_job.payload.tools` — the declaration half has existed since
//! B5.2 and nothing consumed it.
//!
//! This module adds the two halves that were missing, and keeps them apart on
//! purpose:
//!
//! | half | question | answer lives in |
//! |---|---|---|
//! | **declaration** | what may this agent ask for? | `agent.tool_schema` (per agent, operator-authored) |
//! | **catalog** | what can this *server* actually run? | [`CATALOG`] (per build, this file) |
//! | **policy** | does running it need a human first? | [`requires_approval`] (per call) |
//!
//! A tool the agent declares but the catalog does not implement is not an
//! error in the agent's configuration — it is a capability this server has not
//! grown yet. It is answered with a `tool_result` naming the gap, never with a
//! silent success and never by inventing an executor.
//!
//! ## Why exactly one tool executes in v0
//!
//! goal SRV-T1 exists to close the **approval** axis, not to grow the tool
//! surface: ADR-0137 D5's third axis has no producer at all, so
//! `INSERT INTO approval` is 0 and the inbox is empty by construction. The
//! shortest honest path to a closed loop is one tool that a human genuinely
//! must authorise, wired end to end.
//!
//! [`WORK_SESSION_END`] is that tool, and the reason is **irreversibility**:
//! ending a work session runs `t3_terminate`, which seals the T3 billing ledger
//! (`momo_t3` — "settlement happens in `t3_terminate` and nowhere else") and
//! destroys the running host's state. A spawn can be ended; an end cannot be
//! un-ended. Irreversibility is the best single predicate for "a person decides
//! this", so it is the tool whose approval gate is worth the most.
//!
//! Three properties made it the choice over the alternatives, and each one is a
//! constraint this batch could not have met otherwise:
//!
//! * **It is not a new capability.** `momo_t3::end_work_session_in_tx` +
//!   `terminate_in_tx` are the same domain calls
//!   `routes::work_sessions::end` makes. The tool is a second *caller*, not a
//!   second implementation — so the tool cannot drift from the REST surface.
//! * **It carries no provider credential** (ADR-0004). Execution is a local
//!   Postgres lifecycle transition; nothing about it reaches an LLM provider,
//!   so the tool loop cannot become a path for a key to enter the server.
//! * **It flows through Swift's *generic* approval path.** Swift routes
//!   `work.spawn` through `WorkControlRoutes.applySpawnApprovalDecision`
//!   instead (`ApprovalDecisionRoutes.shouldApplyGenericAgentDecisionFlow`
//!   is `workControlID == nil`), and `work_control` is not ported. Choosing
//!   spawn would have forced either porting that subsystem or diverging from
//!   the contract this batch exists to honour.
//!
//! Everything else the roadmap names is listed in [`DECLARED_NOT_EXECUTABLE`]
//! and refused by name. That list is the scope boundary, written down rather
//! than implied.
//!
//! ## G6 fails closed
//!
//! [`requires_approval`] is a port of Swift `LoopGuards.requiresApproval`
//! (`LoopGuards.swift:251-281`). Missing, duplicated, or unrecognised grant
//! metadata all resolve to **approval required**. That direction is the whole
//! point: the failure mode of a permissive default is an agent taking an
//! irreversible action nobody authorised, and there is no undo for it.

use serde_json::{Map, Value};

/// `work.session.end` — the one tool this server executes in v0.
///
/// Arguments: `{"session_id": "<uuid>"}`. See the module docs for why this one.
pub const WORK_SESSION_END: &str = "work.session.end";

/// `approval.action_type` for a tool call, matching Swift
/// `ApprovalRuntime.pausePlan` (`ApprovalRuntime.swift:36-45`).
///
/// The column's comment offers `'tool_call','deploy','spend'`; Swift's generic
/// agent path always writes the first, and the decision route branches on
/// `work.spawn` to tell a work-control approval apart from this one.
pub const ACTION_TYPE_TOOL_CALL: &str = "tool_call";

/// `audit_log.action` values for the approval lifecycle (Swift
/// `ApprovalRuntime` + `ApprovalDecisionRoutes.auditAction`).
pub const AUDIT_APPROVAL_REQUESTED: &str = "approval.requested";
/// The tool ran (or refused to) after a human said yes.
pub const AUDIT_TOOL_EXECUTED: &str = "tool.executed";
/// The tool could not run after a human said yes.
pub const AUDIT_TOOL_FAILED: &str = "tool.failed";

/// The `detail.schema` every audit row in this subsystem versions on.
pub const TOOL_AUDIT_SCHEMA: &str = "momo.agent_tool_call.v0";

/// What this server can actually execute today.
///
/// One entry. Growing it is a deliberate act with its own ticket: each addition
/// needs an executor, an argument validator, and a decision about whether its
/// approval default may ever be anything but "required".
pub const CATALOG: &[&str] = &[WORK_SESSION_END];

/// Capabilities the product already has that a **future** batch may expose as
/// tools, kept as a list rather than as code.
///
/// These are surfaces momo-server already serves over HTTP; none of them is
/// invented here. They are named so that "why is this not a tool yet" has a
/// written answer, and so the next batch starts from a list instead of a guess.
///
/// | tool | existing surface | why not in v0 |
/// |---|---|---|
/// | `work.session.spawn` | `POST …/work-sessions` | Swift gates it through `work_control`, which is not ported; using the generic path would diverge from the contract |
/// | `work.session.resume` | `POST …/work-sessions/{s}/resume` | opens a new billing ledger — needs the spend-ceiling story spawn needs |
/// | `agent.pause` | `PATCH …/agents/{a}` | reversible, so it does not exercise the gate this batch exists to prove |
/// | `message.post` | `POST …/channels/{c}/messages` | the agent already speaks through the run's own reply path |
pub const DECLARED_NOT_EXECUTABLE: &[&str] = &[
    "work.session.spawn",
    "work.session.resume",
    "agent.pause",
    "message.post",
];

/// Is this a tool this build knows how to run?
pub fn is_executable(tool_name: &str) -> bool {
    let normalized = normalize(tool_name);
    CATALOG.iter().any(|known| normalize(known) == normalized)
}

/// Swift `ToolGrantMetadata.normalize` (`AgentJobPayload.swift:315-319`):
/// trim, lowercase, and treat `-` as `_`.
///
/// Shared by the catalog lookup and the grant matcher so a tool cannot be
/// executable under one spelling and ungranted under another.
pub fn normalize(value: &str) -> String {
    value.trim().to_lowercase().replace('-', "_")
}

/// One tool call as the provider reported it.
///
/// `arguments` is a `Value` rather than a `String` because the wire delivers it
/// as a JSON *string* and every consumer wants the object; parsing once, at the
/// edge, keeps the rest of the pipeline from each having its own opinion about
/// malformed JSON. A call whose arguments do not parse is still a tool call —
/// it simply fails its validator later, with a `tool_result` that says so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
}

impl ToolCall {
    /// `message.props` for a `tool_call` row — the schema's own contract
    /// (`001_init.sql:168`): `{name, arguments, call_id}`.
    ///
    /// Nothing else goes in. `props` is broadcast to every client in the
    /// channel, so this object is a public surface: it carries what the tool
    /// call *is*, never the grant metadata that decided its policy.
    pub fn message_props(&self) -> Value {
        let mut props = Map::new();
        props.insert("name".into(), Value::String(self.name.clone()));
        props.insert("arguments".into(), self.arguments.clone());
        props.insert("call_id".into(), Value::String(self.call_id.clone()));
        Value::Object(props)
    }

    /// The one-line body a client renders when it has no `tool_call` view yet.
    ///
    /// Every message row carries a human-readable `body` so a surface that does
    /// not know this `type` degrades to a sentence instead of a blank bubble.
    pub fn message_body(&self) -> String {
        format!("Tool call: {}", self.name)
    }
}

/// The result of running (or refusing to run) a tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolResult {
    pub call_id: String,
    pub output: String,
    pub is_error: bool,
}

impl ToolResult {
    pub fn ok(call_id: impl Into<String>, output: impl Into<String>) -> ToolResult {
        ToolResult {
            call_id: call_id.into(),
            output: output.into(),
            is_error: false,
        }
    }

    pub fn error(call_id: impl Into<String>, output: impl Into<String>) -> ToolResult {
        ToolResult {
            call_id: call_id.into(),
            output: output.into(),
            is_error: true,
        }
    }

    /// `message.props` for a `tool_result` row — `{call_id, output, is_error}`
    /// (`001_init.sql:169`).
    pub fn message_props(&self) -> Value {
        let mut props = Map::new();
        props.insert("call_id".into(), Value::String(self.call_id.clone()));
        props.insert("output".into(), Value::String(self.output.clone()));
        props.insert("is_error".into(), Value::Bool(self.is_error));
        Value::Object(props)
    }

    pub fn message_body(&self) -> String {
        self.output.clone()
    }
}

/// One `tool_grants` entry from the Context Packet projection, reduced to the
/// three fields the policy actually reads.
///
/// Swift's `ToolGrantMetadata` (`AgentJobPayload.swift:188-203`) carries
/// fourteen; the other eleven are provenance for surfaces this batch does not
/// serve. Decoding only what is read means an unfamiliar field cannot fail the
/// decode — and the whole object still rides along untouched into
/// `approval.payload.tool_call.tool_grant`, so nothing is lost for the batch
/// that needs it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ToolGrant {
    pub tool_name: String,
    pub approval_policy: Option<String>,
    /// Swift's `grant` field: `"read"` is the only value that can make a tool
    /// exempt, and only together with a read risk level.
    pub grant: Option<String>,
    /// Swift's `effectiveRiskLevel`: `risk_level ?? risk`, and **`None` when the
    /// two aliases disagree** (`riskAliasesConflict`).
    pub risk_level: Option<String>,
}

impl ToolGrant {
    /// Decode one grant object. Unknown keys are ignored; a missing
    /// `tool_name` makes the entry unusable, which the caller reads as "no
    /// single match" and therefore as approval-required.
    pub fn from_json(value: &Value) -> Option<ToolGrant> {
        let object = value.as_object()?;
        let tool_name = object.get("tool_name")?.as_str()?.to_string();
        let string = |key: &str| {
            object
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };

        // Swift `effectiveRiskLevel` (:262-265): when `risk` and `risk_level`
        // are both present and disagree, the level is *unknown*, not
        // "whichever we read first". An unknown risk fails closed below.
        let risk = string("risk");
        let risk_level_field = string("risk_level");
        let risk_level = match (&risk, &risk_level_field) {
            (Some(risk), Some(level)) if normalize(risk) != normalize(level) => None,
            _ => risk_level_field.or(risk),
        };

        Some(ToolGrant {
            tool_name,
            approval_policy: string("approval_policy"),
            grant: string("grant"),
            risk_level,
        })
    }

    /// Decode the payload's whole `tool_grants` array.
    pub fn from_json_array(value: &Value) -> Vec<ToolGrant> {
        value
            .as_array()
            .map(|entries| entries.iter().filter_map(ToolGrant::from_json).collect())
            .unwrap_or_default()
    }

    /// Swift `isReadOnlyGrant` (:283-285): a grant is read-only only when
    /// **both** `grant` and the effective risk level say `read`.
    pub fn is_read_only(&self) -> bool {
        self.grant.as_deref().map(normalize).as_deref() == Some("read")
            && self.risk_level.as_deref().map(normalize).as_deref() == Some("read")
    }

    /// Swift `singleMatch` (:305-313): exactly one entry must match, because
    /// two entries for one tool mean the projection is ambiguous about which
    /// policy applies — and an ambiguous policy is not a policy.
    pub fn single_match<'g>(grants: &'g [ToolGrant], tool_name: &str) -> Option<&'g ToolGrant> {
        let target = normalize(tool_name);
        if target.is_empty() {
            return None;
        }
        let mut matches = grants
            .iter()
            .filter(|grant| normalize(&grant.tool_name) == target);
        let first = matches.next()?;
        match matches.next() {
            Some(_) => None,
            None => Some(first),
        }
    }
}

/// Why a call needs (or does not need) a human — carried into the approval
/// payload so a reviewer can see the reason the gate fired without replaying
/// the projection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalReason {
    /// No `tool_grants` projection, or no single matching entry. Fail closed.
    GrantMissingOrAmbiguous,
    /// The grant names a policy that demands a human.
    PolicyRequiresApproval,
    /// The grant names a policy this build has no runtime for (e.g. a
    /// conditional budget threshold). Pause rather than guess.
    PolicyUnsupported,
    /// The grant exempts the call and the grant is genuinely read-only.
    ExemptReadOnly,
}

impl ApprovalReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalReason::GrantMissingOrAmbiguous => "grant_missing_or_ambiguous",
            ApprovalReason::PolicyRequiresApproval => "policy_requires_approval",
            ApprovalReason::PolicyUnsupported => "policy_unsupported",
            ApprovalReason::ExemptReadOnly => "exempt_read_only",
        }
    }

    pub fn requires_approval(self) -> bool {
        !matches!(self, ApprovalReason::ExemptReadOnly)
    }
}

/// G6 — does this tool call need a human before it runs?
///
/// Port of Swift `LoopGuards.requiresApproval(toolName:toolGrants:)`
/// (`LoopGuards.swift:251-281`). Swift's MOMO-164 verb-heuristic fallback
/// (`:284`) is **not** ported: Swift itself marks it legacy and MOMO-165 already
/// made the metadata path fail closed, so porting a second, looser answer would
/// only create a way to disagree with the first.
///
/// Returns the *reason*, not a bare bool, because the reason is what the
/// approval row records — and "why did this stop" is the first question a human
/// reading an approval inbox asks.
pub fn approval_reason(tool_name: &str, grants: Option<&[ToolGrant]>) -> ApprovalReason {
    let Some(grants) = grants else {
        return ApprovalReason::GrantMissingOrAmbiguous;
    };
    let Some(grant) = ToolGrant::single_match(grants, tool_name) else {
        return ApprovalReason::GrantMissingOrAmbiguous;
    };
    let Some(policy) = grant.approval_policy.as_deref().map(normalize) else {
        return ApprovalReason::GrantMissingOrAmbiguous;
    };

    match policy.as_str() {
        "require_approval" | "requires_approval" | "approval_required" | "always" | "required" => {
            ApprovalReason::PolicyRequiresApproval
        }
        // Swift `:271-274`: an exemption is honoured only when the grant is
        // genuinely read-only. A grant that claims "never" while holding write
        // risk is a misconfiguration, and the safe reading of it is a pause.
        "never" | "none" | "read_only" | "readonly" => {
            if grant.is_read_only() {
                ApprovalReason::ExemptReadOnly
            } else {
                ApprovalReason::PolicyRequiresApproval
            }
        }
        // v0 has no runtime for conditional policies (`budget_threshold` and
        // friends). Swift pauses; so do we.
        _ => ApprovalReason::PolicyUnsupported,
    }
}

/// The bool form, for call sites that only branch.
pub fn requires_approval(tool_name: &str, grants: Option<&[ToolGrant]>) -> bool {
    approval_reason(tool_name, grants).requires_approval()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn grant(policy: &str, grant_kind: &str, risk: &str) -> ToolGrant {
        ToolGrant {
            tool_name: WORK_SESSION_END.to_string(),
            approval_policy: Some(policy.to_string()),
            grant: Some(grant_kind.to_string()),
            risk_level: Some(risk.to_string()),
        }
    }

    /// The invariant this whole module exists for. Revert any arm and an
    /// irreversible action runs with nobody's permission.
    #[test]
    fn g6_fails_closed_on_every_uncertainty() {
        // no projection at all
        assert!(requires_approval(WORK_SESSION_END, None));
        // projection present, tool absent
        assert!(requires_approval(WORK_SESSION_END, Some(&[])));
        // two entries for one tool = ambiguous
        let duplicated = [
            grant("never", "read", "read"),
            grant("never", "read", "read"),
        ];
        assert!(
            requires_approval(WORK_SESSION_END, Some(&duplicated)),
            "a duplicated grant is ambiguous, and an ambiguous policy is not a policy"
        );
        // a grant with no policy at all
        let policyless = [ToolGrant {
            tool_name: WORK_SESSION_END.to_string(),
            ..ToolGrant::default()
        }];
        assert!(requires_approval(WORK_SESSION_END, Some(&policyless)));
        // a policy this build cannot evaluate
        let conditional = [grant("budget_threshold", "write", "high")];
        assert_eq!(
            approval_reason(WORK_SESSION_END, Some(&conditional)),
            ApprovalReason::PolicyUnsupported
        );
    }

    /// An exemption must be earned by BOTH fields, not claimed by one.
    #[test]
    fn a_never_policy_does_not_exempt_a_write_grant() {
        assert!(
            requires_approval(WORK_SESSION_END, Some(&[grant("never", "write", "high")])),
            "a grant claiming exemption while holding write risk is a misconfiguration"
        );
        assert!(!requires_approval(
            WORK_SESSION_END,
            Some(&[grant("never", "read", "read")])
        ));
    }

    /// Swift `effectiveRiskLevel`: disagreeing aliases mean the level is
    /// unknown, which costs the exemption.
    #[test]
    fn conflicting_risk_aliases_lose_the_exemption() {
        let decoded = ToolGrant::from_json(&json!({
            "tool_name": WORK_SESSION_END,
            "approval_policy": "never",
            "grant": "read",
            "risk": "read",
            "risk_level": "high",
        }))
        .expect("decodes");
        assert_eq!(decoded.risk_level, None);
        assert!(!decoded.is_read_only());
        assert!(requires_approval(WORK_SESSION_END, Some(&[decoded])));
    }

    /// Swift `normalize` (:315-319) folds case and treats `-` as `_` — and
    /// leaves `.` alone. Both halves matter:
    ///
    /// * case and dash/underscore must fold, or a grant authored
    ///   `Work_Session-End` would silently fail to match the call and (because
    ///   G6 fails closed) turn every invocation into an approval;
    /// * `.` must **not** fold, or `work.session.end` and `work_session_end`
    ///   would become one name and a grant written for one tool would authorise
    ///   a different one.
    #[test]
    fn matching_folds_case_and_dashes_but_not_dots() {
        let mut spelled = grant("never", "read", "read");
        spelled.tool_name = "WORK.SESSION-END".to_string();
        assert!(
            !requires_approval("work.session_end", Some(&[spelled.clone()])),
            "case and dash/underscore fold"
        );
        assert!(
            requires_approval("work_session_end", Some(&[spelled])),
            "a dot is a real character; folding it would let one grant authorise another tool"
        );
        assert!(is_executable("  WORK.SESSION.END  "));
    }

    /// The catalog is the executable set, and it is deliberately one entry.
    #[test]
    fn only_the_catalog_executes() {
        assert!(is_executable(WORK_SESSION_END));
        for declared in DECLARED_NOT_EXECUTABLE {
            assert!(
                !is_executable(declared),
                "{declared} is a named future tool, not an executable one"
            );
        }
        assert!(!is_executable("rm.-rf"));
    }

    /// `props` is broadcast to every client in the channel. It carries the call,
    /// never the policy metadata that judged it.
    #[test]
    fn tool_call_props_match_the_schema_contract() {
        let call = ToolCall {
            call_id: "call_1".into(),
            name: WORK_SESSION_END.into(),
            arguments: json!({"session_id": "s"}),
        };
        let props = call.message_props();
        let object = props.as_object().expect("object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["arguments", "call_id", "name"],
            "schema_v0.sql:168 pins tool_call props to exactly {{name, arguments, call_id}}"
        );

        let result = ToolResult::error("call_1", "nope");
        let object = result.message_props();
        let object = object.as_object().expect("object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["call_id", "is_error", "output"]);
    }
}
