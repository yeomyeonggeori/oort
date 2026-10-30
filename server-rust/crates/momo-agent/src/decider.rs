//! Who may decide an approval — the decision route's gate, as data
//! (ADR-0204 D7, #3928).
//!
//! `POST …/approvals/{approval}/decision` asks three things of a person before it
//! takes their verdict: that they are an active human member
//! ([`crate::approval::is_active_human_member_in_tx`]), that they are in the
//! room the approval belongs to ([`crate::approval::is_active_channel_member_in_tx`]),
//! and — per approval — a **role or ownership condition**. The push judgment
//! (`momo_push::judge_targets`) must put the same question to the same people
//! before it wakes a lock screen with an 승인 button, or the people who cannot
//! decide are the ones who get the button.
//!
//! The first two are already one function each. This module is the third: which
//! condition an approval puts on its decider. It is **pure** over the stored
//! `(action_type, payload)`, so the decision route and the push judgment read
//! the very same answer and neither can grow a private opinion about it:
//!
//! * [`decider_gate`] — the role condition, by approval shape and by half
//!   (approve / reject). The route's `match` over [`GatePlan`] is exhaustive, so
//!   a new gate must be chosen there; the push side matches the same enum.
//! * [`reference_execution_host`] (in [`crate::approval`]) — the machine a spawn
//!   approval is about, whose owner decides when it is somebody's own
//!   (ADR-0188 D3).
//! * [`pinned_target_agent`] — the agent an `agent_editor` card was drawn for.
//!
//! ## The payload keys these functions read
//!
//! `action.id` ([`action_required_role`]), `action.pins.target`
//! ([`pinned_target_agent`]), `origin` (through
//! [`crate::in_place_grant::is_in_place_grant`]) and — through
//! [`crate::approval::reference_execution_host`] and
//! [`crate::approval::offers_host_choice`] — `execution`. The push judgment
//! projects these keys — and the two paths [`crate::actions::opens_in_app`] reads,
//! `tool_call.name` and whether `action.args` is an object with an `avatar` key — out of
//! `approval.payload` (`momo_push::judge_targets`: it never copies a card's arguments or
//! rationale into the notifier), so a function added here that reads another key must
//! be added to that projection in the same change; `approval_push_audience_conformance_pg`
//! is what notices when it was not.
//!
//! What stays out of here is *evaluation*: whether a given person is an admin or
//! an agent's owner is answered by the primitives the route has always called
//! (`active_workspace_role`, `agent_owner_in_tx`), and the operator scope is a
//! property of the caller's token that no database row records. A rule that is
//! partly a token cannot be a push audience; [`GatePlan::Operator`] therefore
//! reaches the people who are admins, and the PR that introduced this module
//! says so.

use serde_json::Value;
use uuid::Uuid;

use crate::actions::{action_by_id, RequiredRole, ACTION_TYPE_WORKSPACE_ACTION};
use crate::in_place_grant::is_in_place_grant;

/// How the decision route judges the person who decides — the one `match` over
/// [`RequiredRole`] plus the "no role at all" case, as a value both the route and
/// the push judgment can dispatch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatePlan {
    /// Nothing beyond the two conditions every decision has: an active human
    /// member of the approval's channel. Tool-call approvals, spawn approvals
    /// (before the host rule), and the reject half of an ordinary action.
    ChannelMember,
    /// A workspace owner or admin (`routes::invites::require_admin`).
    Admin,
    /// A workspace owner or admin, **or** a principal carrying the platform
    /// operator scope (`routes::shared::has_platform_read_scope`). The second
    /// half is a token property: the route can see it, a database row cannot.
    Operator,
    /// The target agent's owner, or a workspace admin
    /// (`routes::agents::require_profile_editor_in_tx`). Judged against a subject
    /// the route resolves from the proposal ([`pinned_target_agent`] is the same
    /// id, as the card pinned it).
    TargetAgent,
    /// **The person the action changes, and nobody else** (`member.avatar.set`, ADR-0186
    /// 증보 v4): the decider must be the card's pinned target member
    /// ([`pinned_target_member`]) — an admin is not enough, the agent's owner is not
    /// enough. The pin is the person the *server* derived from the run, so the card was
    /// drawn for exactly one human.
    RequestingMember,
}

/// The `required_role` the registry publishes for this proposal's action.
///
/// `None` when the payload names no action or an action this build no longer
/// carries — [`gate_plan`] gives that the strictest rule, admin. Judging the role
/// before resolving the action keeps the **authority** check first, which is the
/// order ADR-0186 D2 spells out: a non-admin must not be able to learn which
/// actions this server still offers by tapping approve.
pub fn action_required_role(payload: &Value) -> Option<RequiredRole> {
    let action_id = payload
        .get("action")
        .and_then(|action| action.get("id"))
        .and_then(Value::as_str)?;
    action_by_id(action_id).map(|action| action.required_role)
}

/// How a role is judged — the one `match` over [`RequiredRole`] (exhaustive, so a
/// new variant must choose its gate here). `None` (a card whose action this
/// build no longer carries) takes the strictest rule, admin.
pub fn gate_plan(role: Option<RequiredRole>) -> GatePlan {
    match role {
        Some(RequiredRole::AgentEditor) => GatePlan::TargetAgent,
        Some(RequiredRole::RequestingMember | RequiredRole::DmParticipant) => {
            GatePlan::RequestingMember
        }
        Some(RequiredRole::WorkspaceOperator) => GatePlan::Operator,
        Some(RequiredRole::Admin) | None => GatePlan::Admin,
    }
}

/// The role condition an approval puts on whoever decides it, by half.
///
/// * **approve** — a workspace action is executed with the *approver's*
///   authority (ADR-0186 D2), so it takes the action's registry role. Every other
///   approval (a tool call, a spawn) takes none.
/// * **reject** — nothing, except an in-place 「이 채널에서 쓰기」 card (ADR-0162
///   증보 5 G2): it has ONE decider for both halves, a workspace admin who is in
///   the room. Without that arm any room member could cancel somebody else's
///   request.
///
/// The push audience is the **approve** half: the notification exists to ask for
/// an 승인, and a person who may only say no is not who it is for.
pub fn decider_gate(action_type: &str, payload: &Value, approve: bool) -> GatePlan {
    if approve {
        if action_type == ACTION_TYPE_WORKSPACE_ACTION {
            gate_plan(action_required_role(payload))
        } else {
            GatePlan::ChannelMember
        }
    } else if payload["origin"] == "dm_agent_admission" {
        GatePlan::RequestingMember
    } else if is_in_place_grant(payload) {
        GatePlan::Admin
    } else {
        GatePlan::ChannelMember
    }
}

/// The agent a workspace-action card was drawn for (`action.pins.target`) — the
/// subject of an [`GatePlan::TargetAgent`] gate. The decision route re-resolves
/// the target and refuses a card whose pins moved, so for any card that can still
/// be approved this is the agent the route will judge the decider against.
pub fn pinned_target_agent(payload: &Value) -> Option<Uuid> {
    payload
        .get("action")
        .and_then(|action| action.get("pins"))
        .and_then(|pins| pins.get("target"))
        .and_then(Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw).ok())
}

/// The person a `member.avatar.set` card was drawn for (`action.pins.target`) — the subject
/// of a [`GatePlan::RequestingMember`] gate. The same pin path as [`pinned_target_agent`];
/// a separate name because the subject here is a **human**, and a reader of the push
/// audience should not have to know that an agent pin and a member pin share a key.
pub fn pinned_target_member(payload: &Value) -> Option<Uuid> {
    pinned_target_agent(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::{
        ACTION_AGENT_RENAME, ACTION_CHANNEL_CREATE, ACTION_INVITE_CREATE,
        ACTION_WORKSPACE_SETTINGS_UPDATE,
    };
    use crate::in_place_grant::APPROVAL_ORIGIN_SERVER_IN_PLACE;
    use serde_json::json;

    fn card(action_id: &str) -> Value {
        json!({"action": {"id": action_id, "args": {}}})
    }

    #[test]
    fn each_required_role_has_its_own_gate_and_unknown_is_admin() {
        assert_eq!(gate_plan(Some(RequiredRole::Admin)), GatePlan::Admin);
        assert_eq!(gate_plan(None), GatePlan::Admin);
        assert_eq!(
            gate_plan(Some(RequiredRole::WorkspaceOperator)),
            GatePlan::Operator
        );
        assert_eq!(
            gate_plan(Some(RequiredRole::AgentEditor)),
            GatePlan::TargetAgent
        );
    }

    /// The approve half of a workspace action takes the registry's role; the
    /// gate cannot be written beside the registry, because it is read from it.
    #[test]
    fn a_workspace_actions_approve_gate_is_its_registry_role() {
        for action in crate::actions::ACTIONS {
            assert_eq!(
                decider_gate(ACTION_TYPE_WORKSPACE_ACTION, &card(action.id), true),
                gate_plan(Some(action.required_role)),
                "{}",
                action.id
            );
        }
        assert_eq!(
            decider_gate(
                ACTION_TYPE_WORKSPACE_ACTION,
                &card(ACTION_INVITE_CREATE),
                true
            ),
            GatePlan::Admin
        );
        assert_eq!(
            decider_gate(
                ACTION_TYPE_WORKSPACE_ACTION,
                &card(ACTION_AGENT_RENAME),
                true
            ),
            GatePlan::TargetAgent
        );
        assert_eq!(
            decider_gate(
                ACTION_TYPE_WORKSPACE_ACTION,
                &card(ACTION_WORKSPACE_SETTINGS_UPDATE),
                true
            ),
            GatePlan::Operator
        );
        // A card for an action this build does not carry takes the strictest rule.
        assert_eq!(
            decider_gate(ACTION_TYPE_WORKSPACE_ACTION, &card("no.such.action"), true),
            GatePlan::Admin
        );
        assert_eq!(
            decider_gate(ACTION_TYPE_WORKSPACE_ACTION, &json!({}), true),
            GatePlan::Admin
        );
    }

    /// Anything that is not a workspace action asks nothing more of its approver
    /// than a seat in the room — a payload that merely *contains* an action id must
    /// not borrow a role.
    /// `member.avatar.set` is decided by the person it changes — not by an admin and not by
    /// the agent's owner — and the push audience reads the same pin.
    #[test]
    fn a_member_avatar_card_is_gated_to_its_pinned_person() {
        let person = Uuid::from_u128(77);
        let payload = json!({"action": {
            "id": crate::actions::ACTION_MEMBER_AVATAR_SET,
            "args": {},
            "pins": {"target": person.to_string()},
        }});
        assert_eq!(
            action_required_role(&payload),
            Some(RequiredRole::RequestingMember)
        );
        assert_eq!(
            decider_gate(ACTION_TYPE_WORKSPACE_ACTION, &payload, true),
            GatePlan::RequestingMember
        );
        assert_eq!(pinned_target_member(&payload), Some(person));
        // Rejecting needs only a seat in the room, as for every ordinary action.
        assert_eq!(
            decider_gate(ACTION_TYPE_WORKSPACE_ACTION, &payload, false),
            GatePlan::ChannelMember
        );
    }

    #[test]
    fn a_tool_call_or_a_spawn_takes_only_a_seat_in_the_room() {
        for action_type in ["tool_call", "work.spawn"] {
            assert_eq!(
                decider_gate(action_type, &card(ACTION_CHANNEL_CREATE), true),
                GatePlan::ChannelMember,
                "{action_type}"
            );
        }
    }

    #[test]
    fn rejecting_asks_a_role_only_of_an_in_place_card() {
        // An ordinary workspace action: any room member may say no.
        assert_eq!(
            decider_gate(
                ACTION_TYPE_WORKSPACE_ACTION,
                &card(ACTION_CHANNEL_CREATE),
                false
            ),
            GatePlan::ChannelMember
        );
        let mut in_place = card(ACTION_CHANNEL_CREATE);
        in_place["origin"] = json!(APPROVAL_ORIGIN_SERVER_IN_PLACE);
        assert_eq!(
            decider_gate(ACTION_TYPE_WORKSPACE_ACTION, &in_place, false),
            GatePlan::Admin
        );
        assert_eq!(
            decider_gate("tool_call", &json!({}), false),
            GatePlan::ChannelMember
        );
    }

    #[test]
    fn the_pinned_target_is_the_agent_an_editor_card_was_drawn_for() {
        let agent = Uuid::from_u128(0xa1);
        let payload =
            json!({"action": {"id": ACTION_AGENT_RENAME, "pins": {"target": agent.to_string()}}});
        assert_eq!(pinned_target_agent(&payload), Some(agent));
        for missing in [
            json!({}),
            json!({"action": {"id": ACTION_AGENT_RENAME}}),
            json!({"action": {"pins": {"target": null}}}),
            json!({"action": {"pins": {"target": "not-a-uuid"}}}),
        ] {
            assert_eq!(pinned_target_agent(&missing), None, "{missing}");
        }
    }
}
