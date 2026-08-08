//! ADR-0158 D1~D4 — **the agent said it changed itself**, as one channel line.
//!
//! A prime harness rewrites its own instructions on a timer
//! (`getAutoRefineSettings()` is `enabled ?? true`, `turnInterval` 25,
//! `cooldownMs` 20 minutes — 실측, `research/2026-08-07-prime-refine-upstream-draft.md`
//! §1.1). Nothing about that reaches a channel today, and the whole argument of
//! D1 is that in a product where an agent is a first-class member, "a colleague
//! changed how they work" is a fact the team is owed rather than a line in one
//! host's log.
//!
//! ## What this module is, and what it deliberately is not
//!
//! It is a **shape**: a validated block, a server-owned props key, and one
//! derived idempotency key. It is not a new message type (D2 — `system` is
//! reused, so no client learns a frame), not a second write path (the
//! announcement goes through `send_message_with_mentions_in_tx` like every other
//! send), and not a rollback affordance (D3 — `rollbackId` is recorded and
//! nothing is promised about it).
//!
//! ## Why it is not the `momo.stream` contract wearing a different hat
//!
//! The sketch's §2.1 table is worth keeping in view, because the two look alike
//! from a distance and behave oppositely:
//!
//! | | a stream slice (#1152) | a refinement |
//! |---|---|---|
//! | what changed | one message's body | the agent's **later behaviour** — no message changes |
//! | frequency | 17 per turn (실측) | gated by 25 turns *and* a 20-minute cooldown |
//! | `seq` | must **not** be consumed — 17 slices must not read as 17 unreads | **must** be consumed — an audit you cannot scroll back to is not an audit |
//! | rewind guard | `momo.stream.rev` monotonicity | none needed; each refinement is its own event |
//!
//! Routing a refinement through the stream contract would feed refinement
//! revisions into the staleness guard and freeze every later slice of that
//! message as stale. The two contracts are orthogonal, and this module exists so
//! that they stay that way.

use serde_json::{json, Map, Value};
use uuid::Uuid;

/// The server-owned props key a refinement announcement writes into (D2).
///
/// Server-owned for the same reason [`crate::STREAM_PROPS_KEY`] is: the route
/// strips it from client-supplied props so this crate is its only writer. The
/// difference from the stream marker is *why* — nothing reads this key back to
/// make a decision, so the risk is not a poisoned guard but a **forged claim**.
/// A props map is otherwise the producer's own dictionary, and a client that
/// could spell this key by hand could put "김인턴이 자기 작업 방식을 갱신했습니다"
/// under a namespace that says the server vouched for it.
pub const HARNESS_REFINE_PROPS_KEY: &str = "momo.harnessRefine";

/// The `scope` a refinement announcement may claim, and the only one (§2.2).
///
/// The harness's own `scope` for a global refinement is `"global"`, and
/// repeating that word here would be a lie in our vocabulary: an adapter runs
/// one `HOME` per workspace (#1162 tenancy 결론), so what the harness calls
/// global is, on our side of the boundary, exactly one workspace. A value the
/// server cannot vouch for is refused rather than translated silently, because a
/// silent translation is indistinguishable from a correct claim.
pub const HARNESS_REFINE_SCOPE: &str = "workspace";

/// The namespace the refinement idempotency key hangs off (D4).
///
/// Sixteen ASCII bytes, exactly like `tool_exec::TOOL_RESULT_NAMESPACE`, and for
/// the same auditable reason: byte 6 is `a` (`0x61`), so its version nibble is
/// `6`, while every `agent_run.id` is `uuidv7()`. No run id can collide with
/// this namespace, so the refinement key space and the tool-card key space
/// (`Uuid::new_v5(&run_id, …)`) cannot meet at their roots.
const HARNESS_REFINE_NAMESPACE: Uuid = Uuid::from_bytes(*b"momo.harnessRefi");

/// The `clientMsgId` a refinement announcement must carry — **derived, never
/// invented** (D4).
///
/// `RefinementResult.id` (`refine_20260807041452415`) is already a stable key
/// the harness assigned, which is what makes the spike's §8 complaint — "no
/// logic re-uses the same key on a retry" — disappear here for free. It is also
/// an arbitrary string, and `message.client_msg_id` is a `uuid` column
/// (`schema_v0.sql:180`, 동결층). So the string is *hashed into* a uuid rather
/// than parsed as one, which is the same move `tool_exec::result_message_id`
/// makes for a provider's `call_id` and for the same stated reason.
///
/// The determinism **is** the guarantee: two POSTs of one refinement — a retry
/// after a timeout, the RPC path and the file watcher both noticing the same
/// event — derive one key, meet the spine's `(channel, author, client_msg_id)`
/// unique index, and leave one line in the channel.
pub fn harness_refine_client_msg_id(refinement_id: &str) -> Uuid {
    Uuid::new_v5(&HARNESS_REFINE_NAMESPACE, refinement_id.as_bytes())
}

/// What set a refinement off (§2.2).
///
/// Four values and no `Other`: an announcement whose trigger this server does
/// not recognise is refused, because the sentence a reader is shown ("자기
///작업 방식을 갱신했습니다") is a claim about *why*, and a server that passed
/// an unknown word through would be vouching for a story it cannot read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HarnessRefineTrigger {
    /// The host asked for it (`refine` RPC command).
    Command,
    /// `turnInterval` elapsed — the on-by-default timer.
    TurnInterval,
    /// A compaction pass carried it.
    Compact,
    /// **The kernel path.** `rlm.harness` wrote `harness_state.json` directly and
    /// the protocol said nothing at all (실측: 6 runs × 37 events,
    /// `refine_complete` = 0). The adapter noticed by hashing the file, so this
    /// value states exactly that and no more — "we saw the file change", never
    /// "the agent decided X". Deleting this variant when upstream emits an event
    /// for kernel writes is the intended end of it.
    ObservedDrift,
}

impl HarnessRefineTrigger {
    /// The wire spelling. The casing is inconsistent (`turn_interval` snake,
    /// `observed-drift` kebab) because the sketch's table is, and the sketch is
    /// what the adapter was written against — tidying it here would be a rename
    /// nobody asked for that lands as a 400 on the other side.
    pub fn wire(self) -> &'static str {
        match self {
            HarnessRefineTrigger::Command => "command",
            HarnessRefineTrigger::TurnInterval => "turn_interval",
            HarnessRefineTrigger::Compact => "compact",
            HarnessRefineTrigger::ObservedDrift => "observed-drift",
        }
    }

    pub fn from_wire(value: &str) -> Option<HarnessRefineTrigger> {
        match value {
            "command" => Some(HarnessRefineTrigger::Command),
            "turn_interval" => Some(HarnessRefineTrigger::TurnInterval),
            "compact" => Some(HarnessRefineTrigger::Compact),
            "observed-drift" => Some(HarnessRefineTrigger::ObservedDrift),
            _ => None,
        }
    }

    /// Every spelling, for the refusal sentence and the openapi enum.
    pub const ALL: [HarnessRefineTrigger; 4] = [
        HarnessRefineTrigger::Command,
        HarnessRefineTrigger::TurnInterval,
        HarnessRefineTrigger::Compact,
        HarnessRefineTrigger::ObservedDrift,
    ];
}

/// One harness entry a refinement touched — **its name and its kind, never its
/// text** (§2.2).
///
/// The rule is a disclosure rule, not a size one. Harness memories can quote the
/// conversation that produced them, so a `before`/`after` pair in a channel is a
/// summary of that conversation posted to everyone in the room. The full record
/// stays on the adapter host, where `RefinementResult.appliedEdits` already
/// keeps it; the channel gets "무엇이 몇 건".
///
/// The wire type is `deny_unknown_fields`, which is what makes this rule
/// mechanical rather than aspirational: a producer that adds `before` gets a
/// 400, not a silently trimmed field it will believe was delivered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessRefineEdit {
    /// `create` / `update` / `delete` as the harness reports it. Free text
    /// rather than an enum: this mirrors an upstream vocabulary that is
    /// undocumented (the whole subject of the §1 issue draft), and a closed set
    /// here would turn a new upstream verb into a 400 on an announcement that is
    /// otherwise perfectly true.
    pub action: String,
    /// `memory` / `instruction` / … — same reasoning as `action`.
    pub kind: String,
    /// The harness's own entry id (실측: `oort-refine-probe`).
    pub id: String,
}

/// A validated refinement announcement, ready to become props.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessRefine {
    pub refinement_id: String,
    pub trigger: HarnessRefineTrigger,
    pub edits: Vec<HarnessRefineEdit>,
    pub summary: Option<String>,
    /// D3 — **recorded, not exposed.** `refine` can be rewound by `rollbackId`
    /// (`RefineOptions`), and v0 deliberately ships no channel affordance for
    /// that: what a rewind should look like to a room is an unanswered UX
    /// question (§2.4), and shipping a half-answer would be harder to withdraw
    /// than to add. Keeping the id on the row is the cheap half — an operator
    /// answering "can this be undone, and by what id" reads the ledger.
    pub rollback_id: Option<String>,
}

/// The longest `refinementId` / edit field this server will store.
///
/// These are identifiers, not prose: the measured ones are 23 and 17 characters
/// (`refine_20260807041452415`, `oort-refine-probe`). The cap exists so that a
/// producer cannot use an id field as the content channel §2.2 closed.
pub const HARNESS_REFINE_ID_MAX_CHARS: usize = 200;

/// The longest human `summary` a refinement may carry.
///
/// Bounded for the disclosure reason, not a storage one — an unbounded summary
/// is exactly the "요약본 유출" §2.2 refuses, re-opened under a friendlier name.
pub const HARNESS_REFINE_SUMMARY_MAX_CHARS: usize = 500;

/// The most edits one announcement may enumerate.
///
/// A refinement that touched more entries than this is still announced; the
/// count simply stops being an itemised list, which is the failure mode that
/// costs the least. (No measured run came close — the spike's applied edits
/// numbered 1.)
pub const HARNESS_REFINE_EDITS_MAX: usize = 50;

/// Why a refinement announcement was refused **at the acceptance point**.
///
/// All of them are the caller's to fix, and all of them are 400 at the route.
/// Refusing here rather than dropping the block is the #1183 discipline applied
/// one layer up: a producer that believes it announced a self-modification, and
/// did not, has no way to discover the difference.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HarnessRefineInvalid {
    #[error("harnessRefine requires type \"system\" (ADR-0158 D2)")]
    NotSystemMessage,
    #[error("harnessRefine requires a human-readable body — the reason belongs in props, the sentence in the channel")]
    MissingBody,
    #[error("harnessRefine.refinementId must be a non-empty id of at most {HARNESS_REFINE_ID_MAX_CHARS} characters")]
    RefinementId,
    #[error(
        "harnessRefine.trigger must be one of: command, turn_interval, compact, observed-drift"
    )]
    Trigger,
    #[error("harnessRefine.scope must be \"{HARNESS_REFINE_SCOPE}\" — an adapter runs one HOME per workspace, so the harness's \"global\" is this workspace and nothing wider")]
    Scope,
    #[error("harnessRefine.edits[].action/kind/id must each be a non-empty id of at most {HARNESS_REFINE_ID_MAX_CHARS} characters")]
    Edit,
    #[error("harnessRefine.edits may name at most {HARNESS_REFINE_EDITS_MAX} entries")]
    TooManyEdits,
    #[error("harnessRefine.summary must be at most {HARNESS_REFINE_SUMMARY_MAX_CHARS} characters — the harness text stays on the adapter host")]
    Summary,
    /// The idempotency key is derived, so a caller that supplies a different one
    /// is told which one this refinement has. Naming the value is what keeps the
    /// refusal actionable rather than a riddle.
    #[error("clientMsgId for this refinement must be {expected} — the key is derived from refinementId so a retry cannot announce twice (ADR-0158 D4)")]
    ClientMsgId { expected: Uuid },
}

impl HarnessRefine {
    /// The `props["momo.harnessRefine"]` object this announcement stores.
    ///
    /// `summary`/`rollbackId` are **absent** rather than `null` when unset, the
    /// same shape rule ADR-0155's `outcome` follows: a producer written before a
    /// field existed sends what it always sent, and a reader cannot tell the two
    /// apart from a field that was explicitly cleared.
    pub fn props(&self) -> Value {
        let mut object = Map::new();
        object.insert(
            "refinementId".to_string(),
            Value::String(self.refinement_id.clone()),
        );
        object.insert(
            "trigger".to_string(),
            Value::String(self.trigger.wire().to_string()),
        );
        // Written by the server, not copied from the request — the request's
        // value was only ever a claim this server had to agree with.
        object.insert(
            "scope".to_string(),
            Value::String(HARNESS_REFINE_SCOPE.to_string()),
        );
        object.insert(
            "edits".to_string(),
            Value::Array(
                self.edits
                    .iter()
                    .map(|edit| json!({ "action": edit.action, "kind": edit.kind, "id": edit.id }))
                    .collect(),
            ),
        );
        if let Some(summary) = self.summary.as_ref() {
            object.insert("summary".to_string(), Value::String(summary.clone()));
        }
        if let Some(rollback_id) = self.rollback_id.as_ref() {
            object.insert("rollbackId".to_string(), Value::String(rollback_id.clone()));
        }
        Value::Object(object)
    }

    /// The derived key this announcement must be sent under (D4).
    pub fn client_msg_id(&self) -> Uuid {
        harness_refine_client_msg_id(&self.refinement_id)
    }
}

/// One id-shaped field's check. Counted in characters, not bytes, because a cap
/// a Korean id trips at a third of its stated length is not the cap that was
/// documented.
fn is_valid_id(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= HARNESS_REFINE_ID_MAX_CHARS
}

/// Validate the wire block's *values* — the half `deny_unknown_fields` cannot do.
///
/// Serde refuses fields nobody declared; this refuses declared fields whose
/// values the server would otherwise be repeating on the producer's word. Split
/// this way because the two failures are different sentences: "you sent a key I
/// do not know" and "the scope you claimed is not one I can vouch for".
pub fn validate_harness_refine(
    refinement_id: &str,
    trigger: &str,
    scope: &str,
    edits: &[(String, String, String)],
    summary: Option<&str>,
    rollback_id: Option<&str>,
) -> Result<HarnessRefine, HarnessRefineInvalid> {
    if !is_valid_id(refinement_id) {
        return Err(HarnessRefineInvalid::RefinementId);
    }
    let trigger = HarnessRefineTrigger::from_wire(trigger).ok_or(HarnessRefineInvalid::Trigger)?;
    if scope != HARNESS_REFINE_SCOPE {
        return Err(HarnessRefineInvalid::Scope);
    }
    if edits.len() > HARNESS_REFINE_EDITS_MAX {
        return Err(HarnessRefineInvalid::TooManyEdits);
    }
    let mut checked = Vec::with_capacity(edits.len());
    for (action, kind, id) in edits {
        if !is_valid_id(action) || !is_valid_id(kind) || !is_valid_id(id) {
            return Err(HarnessRefineInvalid::Edit);
        }
        checked.push(HarnessRefineEdit {
            action: action.clone(),
            kind: kind.clone(),
            id: id.clone(),
        });
    }
    let summary = match summary {
        None => None,
        Some(summary) => {
            if summary.chars().count() > HARNESS_REFINE_SUMMARY_MAX_CHARS {
                return Err(HarnessRefineInvalid::Summary);
            }
            Some(summary.to_string())
        }
    };
    let rollback_id = match rollback_id {
        None => None,
        Some(rollback_id) => {
            if !is_valid_id(rollback_id) {
                return Err(HarnessRefineInvalid::RefinementId);
            }
            Some(rollback_id.to_string())
        }
    };
    Ok(HarnessRefine {
        refinement_id: refinement_id.to_string(),
        trigger,
        edits: checked,
        summary,
        rollback_id,
    })
}

/// The send's props with the refinement block stamped in.
///
/// Merged into whatever the producer already sent (`{"harness": "prime-agent"}`
/// in the sketch), never replacing it — the same merge
/// `message::opening_stream_input` makes, so an announcement can also carry the
/// ordinary producer props every other message of that adapter carries.
pub fn harness_refine_input_props(props: Value, refine: &HarnessRefine) -> Value {
    let mut object = match props {
        Value::Object(object) => object,
        _ => Map::new(),
    };
    object.insert(HARNESS_REFINE_PROPS_KEY.to_string(), refine.props());
    Value::Object(object)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> Result<HarnessRefine, HarnessRefineInvalid> {
        validate_harness_refine(
            "refine_20260807041452415",
            "command",
            "workspace",
            &[(
                "create".to_string(),
                "memory".to_string(),
                "oort-refine-probe".to_string(),
            )],
            Some("기억 1건 추가"),
            None,
        )
    }

    /// The measured shape from `run_spike.sh refine` parses, field for field.
    /// Written against the 실측 values rather than convenient ones so that a
    /// rename upstream shows up here rather than in production.
    #[test]
    fn the_measured_refinement_result_is_accepted_verbatim() {
        let refine = valid().expect("the measured shape is valid");
        assert_eq!(refine.refinement_id, "refine_20260807041452415");
        assert_eq!(refine.trigger, HarnessRefineTrigger::Command);
        assert_eq!(refine.edits.len(), 1);
        assert_eq!(refine.edits[0].id, "oort-refine-probe");

        let props = refine.props();
        assert_eq!(props["scope"], json!("workspace"));
        assert_eq!(props["trigger"], json!("command"));
        assert_eq!(props["edits"][0]["kind"], json!("memory"));
        assert!(
            props.get("rollbackId").is_none(),
            "absent, not null — a producer that never had the field means what it always meant"
        );
    }

    /// **D4, and the reason this module owns a namespace.** The key is a pure
    /// function of the refinement id: an RPC-sourced announcement and a
    /// file-watcher-sourced one for the same refinement collapse in the spine's
    /// unique index instead of double-announcing.
    #[test]
    fn the_idempotency_key_is_a_pure_function_of_the_refinement_id() {
        let once = harness_refine_client_msg_id("refine_20260807041452415");
        let again = harness_refine_client_msg_id("refine_20260807041452415");
        assert_eq!(once, again);
        assert_ne!(
            once,
            harness_refine_client_msg_id("refine_20260807041452416")
        );
        assert_eq!(valid().expect("valid").client_msg_id(), once);
    }

    /// The namespace is pinned by value, because an adapter in another language
    /// re-derives this key and a "tidy-up" of the constant would silently split
    /// the key space in two — every retry after it becoming a second
    /// announcement of a refinement that happened once.
    #[test]
    fn the_namespace_is_pinned_and_cannot_collide_with_a_run_id() {
        assert_eq!(
            HARNESS_REFINE_NAMESPACE.to_string(),
            "6d6f6d6f-2e68-6172-6e65-737352656669",
            "16 ASCII bytes of `momo.harnessRefi` — the value an adapter in \
             another language pastes"
        );
        // Byte 6's high nibble is the version field. `agent_run.id` is uuidv7;
        // this is 6, so no run id can ever equal the namespace.
        assert_eq!(HARNESS_REFINE_NAMESPACE.as_bytes()[6] >> 4, 6);
    }

    /// §2.2's disclosure rule, asserted as a refusal rather than a comment.
    #[test]
    fn a_scope_the_server_cannot_vouch_for_is_refused() {
        let global = validate_harness_refine("refine_1", "command", "global", &[], None, None);
        assert_eq!(global, Err(HarnessRefineInvalid::Scope));
    }

    /// An unknown trigger is a story this server cannot read, so it does not
    /// repeat it.
    #[test]
    fn an_unknown_trigger_is_refused_rather_than_passed_through() {
        assert_eq!(
            validate_harness_refine("refine_1", "vibes", "workspace", &[], None, None),
            Err(HarnessRefineInvalid::Trigger)
        );
        for trigger in HarnessRefineTrigger::ALL {
            assert_eq!(
                HarnessRefineTrigger::from_wire(trigger.wire()),
                Some(trigger),
                "every spelling this server advertises must round-trip"
            );
        }
    }

    /// The caps are disclosure guards, so they are asserted at the boundary that
    /// matters — one character over is a refusal, not a truncation.
    #[test]
    fn an_oversized_summary_is_refused_not_truncated() {
        let long = "가".repeat(HARNESS_REFINE_SUMMARY_MAX_CHARS + 1);
        assert_eq!(
            validate_harness_refine("refine_1", "command", "workspace", &[], Some(&long), None),
            Err(HarnessRefineInvalid::Summary)
        );
        let at_limit = "가".repeat(HARNESS_REFINE_SUMMARY_MAX_CHARS);
        assert!(
            validate_harness_refine(
                "refine_1",
                "command",
                "workspace",
                &[],
                Some(&at_limit),
                None
            )
            .is_ok(),
            "counted in characters, not bytes"
        );
    }

    /// D3 — stored when sent, and it does not change the shape when it is not.
    #[test]
    fn a_rollback_id_is_recorded_without_being_promised() {
        let refine = validate_harness_refine(
            "refine_1",
            "command",
            "workspace",
            &[],
            None,
            Some("rollback_20260807"),
        )
        .expect("valid");
        assert_eq!(refine.props()["rollbackId"], json!("rollback_20260807"));
    }

    /// The block joins the producer's own props instead of replacing them.
    #[test]
    fn the_refine_block_joins_the_props_a_send_already_carried() {
        let refine = valid().expect("valid");
        let props = harness_refine_input_props(json!({ "harness": "prime-agent" }), &refine);
        assert_eq!(props["harness"], json!("prime-agent"));
        assert_eq!(
            props[HARNESS_REFINE_PROPS_KEY]["refinementId"],
            json!("refine_20260807041452415")
        );
    }
}
