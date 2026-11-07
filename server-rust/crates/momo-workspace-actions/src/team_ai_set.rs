//! The proposal transaction of an emoticon set (ADR-0218 증보 6 §12 L2·L3·L5, #5460 S1b).
//!
//! The team AI makes a set's pictures one slot at a time into the server's staging
//! (`momo_expressions::set`); this is the transaction that raises the **one** approval card for
//! them. It is called by **server code** (S5a's worker routine), never by a model's tool call:
//!
//! * its signature has no argument a model could fill — the set id, the run and the context are
//!   the server's; the plan the card shows is **read back from the staged rows** (A24), not passed
//!   in. The ids it raises ([`momo_agent::actions::SERVER_RAISED_ACTION_IDS`]) are on the helper's
//!   allow-list, so the decision route accepts the helper's mark, and on no model's menu;
//! * nothing travels in a body: the card names the set by id and the pictures are copied **inside
//!   the database** (`INSERT … SELECT`) from the staging into the approval's draft rows.
//!
//! One transaction, the caller's: the run is parked, the approval, the drafts, the copied
//! renditions, the head's move to `proposed` and the card either all commit or all roll back. A
//! refusal (`Ok(Err(_))`) is returned **before the first write**; everything after the first write
//! is an `Err` that makes the caller roll back (A10).

use momo_db::{DbError, PgConnection};
use momo_expressions::set::{self, Owner};
use momo_messaging::{send_thread_notice_in_tx, MessageType, NewMessage};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::action_resolve::{self, GateSubject};
use crate::team_ai::{
    read_roles_in_tx, requester_could_approve_in_tx, via_json, CardScope, ProposalContext,
    ProposalOk, ProposalRefusal,
};
use momo_agent::actions;
use momo_agent::card_suggest::suggestion_requester_in_tx;
use momo_agent::inert_display_name;

fn expression_error<T>(result: Result<T, momo_expressions::Error>) -> Result<T, DbError> {
    result.map_err(|error| match error {
        momo_expressions::Error::Db(error) => error,
        other => DbError::from(sqlx::Error::Protocol(other.to_string())),
    })
}

/// `SetAction.args` (ADR-0218 §12 L5.1) read **back from the staged plan**: the title, prefix, face,
/// prompt and every slot's name, display name and tags, byte for byte as `begin` stored them. The
/// set's common tags are not stored apart: the stored slot tags are the final, merged ones, so the
/// common list here is empty (a later slice that merges at `begin` is what fills the slots).
fn plan_args(held: &set::Held) -> Option<Value> {
    Some(json!({
        "setId": held.id.to_string(),
        "title": held.title,
        "prefix": held.prefix,
        "tags": Vec::<String>::new(),
        "backend": held.backend,
        "subjectMemberId": held.subject.map(|id| id.to_string()),
        "prompt": held.prompt.clone()?,
        "slots": held.slots.iter().map(|slot| json!({
            "index": slot.index,
            "name": slot.name,
            "displayName": slot.display_name,
            "tags": slot.tags,
        })).collect::<Vec<_>>(),
    }))
}

/// Raise the approval card of the staged set `set_id`, in the caller's tenant transaction.
///
/// The order is the team AI door's (ADR-0201 D2, F10), minus what a set does not have (no model
/// arguments, no limit shared with ordinary cards): the role-bundle wall, the **live human
/// requester** of the run (`Work`, welcome and first-proposal runs have none, so they refuse and
/// write nothing — A5), the agent's mutex, the owner's predicates on the head (agent, requester,
/// run, `staging`, plan confirmed, two hours not over), the plan read back and normalised, the
/// resolver, `requester_could_approve_in_tx` (A22), then the writes: park, approval, drafts and
/// renditions, the head's move, the card with the helper's mark (A23), the request card attached.
///
/// Refusals: [`ProposalRefusal::RoleOff`] (the bundle that owns the id is off),
/// [`ProposalRefusal::NoHumanRequester`], [`ProposalRefusal::InvalidArguments`] (not this agent's /
/// this person's / this run's set, not `staging`, not confirmed, expired, a slot still `planned`,
/// nothing ready to choose from, a plan the normaliser does not take — all one answer),
/// [`ProposalRefusal::RequesterLacksRole`], [`ProposalRefusal::RunNotParkable`].
pub async fn propose_set_in_tx(
    conn: &mut PgConnection,
    context: &ProposalContext,
    set_id: Uuid,
) -> Result<Result<ProposalOk, ProposalRefusal>, DbError> {
    let workspace_id = context.workspace_id;
    let Some(action) = actions::proposable_action_by_id(
        actions::ACTION_EXPRESSION_SET_CREATE,
        actions::ProposalDoor::TeamAi,
    ) else {
        return Ok(Err(ProposalRefusal::NotAllowed));
    };
    // B13-I5: the wall of the bundle that owns the id (none until S5a gives it one).
    if !read_roles_in_tx(conn, workspace_id)
        .await?
        .action_allowed(action.id)
    {
        return Ok(Err(ProposalRefusal::RoleOff));
    }
    // The requester: the human who wrote the trigger, and nobody else (L2.4-1).
    let Some(requester) = suggestion_requester_in_tx(conn, workspace_id, context.run_id).await?
    else {
        return Ok(Err(ProposalRefusal::NoHumanRequester));
    };
    if requester.channel_id != context.channel_id {
        return Ok(Err(ProposalRefusal::NoHumanRequester));
    }
    // The agent's own member row is the mutex of its one undecided set (`begin` takes it too).
    let agent: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM member WHERE workspace_id = $1 AND id = $2 AND kind = 'agent' \
            AND status = 'active' AND deleted_at IS NULL FOR NO KEY UPDATE",
    )
    .bind(workspace_id)
    .bind(context.agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    if agent.is_none() {
        return Ok(Err(ProposalRefusal::InvalidArguments));
    }
    let owner = Owner {
        workspace: workspace_id,
        agent: context.agent_member_id,
        requester: requester.member_id,
        run: context.run_id,
    };
    let Some(held) = expression_error(set::lock_for_proposal_in_tx(conn, owner, set_id).await)?
    else {
        return Ok(Err(ProposalRefusal::InvalidArguments));
    };
    // The card stands where the person asked; a finished set has something to choose from.
    if held.channel_id != context.channel_id
        || held.slots.iter().any(|slot| slot.state == "planned")
        || !held.slots.iter().any(|slot| slot.state == "ready")
    {
        return Ok(Err(ProposalRefusal::InvalidArguments));
    }
    let Some(raw_args) = plan_args(&held) else {
        return Ok(Err(ProposalRefusal::InvalidArguments));
    };
    let validated = match action_resolve::validated_action_args(action, &raw_args, context.now_ms) {
        Ok(validated) => validated,
        Err(_) => return Ok(Err(ProposalRefusal::InvalidArguments)),
    };
    let resolved = match action_resolve::resolve_action_in_tx(
        conn,
        workspace_id,
        context.agent_member_id,
        Some(context.run_id),
        action,
        &raw_args,
        context.now_ms,
    )
    .await?
    {
        Ok(resolved) => resolved,
        Err(_) => return Ok(Err(ProposalRefusal::InvalidArguments)),
    };
    debug_assert_eq!(validated.normalized, resolved.validated.normalized);
    // A22: the requester must be able to approve their own card — a live human of the channel,
    // not a guest, inside the add policy now, and the face when the set names one.
    if !requester_could_approve_in_tx(
        conn,
        workspace_id,
        requester.member_id,
        action,
        GateSubject::Workspace,
        CardScope {
            channel_id: context.channel_id,
            face: held.subject,
        },
    )
    .await?
    {
        return Ok(Err(ProposalRefusal::RequesterLacksRole));
    }

    // ---- the first write -------------------------------------------------------------------
    momo_agent::run::mark_run_started_in_tx(conn, context.run_id).await?;
    if !momo_agent::run::park_run_for_approval_in_tx(conn, context.run_id, context.expires_at)
        .await?
    {
        return Ok(Err(ProposalRefusal::RunNotParkable));
    }
    let mut payload = actions::workspace_action_payload(
        action.id,
        &resolved.validated.normalized,
        None,
        context.agent_member_id,
    );
    if let Some(block) = payload.get_mut("action").and_then(Value::as_object_mut) {
        block.insert("pins".into(), resolved.pins.clone());
    }
    // A23, L2.4-6: the helper's mark, the very shape `propose_with_avatar_in_tx` writes — the
    // decision route accepts a card of this id only with it, and `requester_id` is the trigger's
    // author.
    if let Some(object) = payload.as_object_mut() {
        object.insert("via_ai".into(), via_json(context, requester.member_id));
    }
    let decision = actions::decision_mode(actions::ACTION_TYPE_WORKSPACE_ACTION, &payload);
    let approval_id = momo_agent::create_pending_approval_in_tx(
        conn,
        workspace_id,
        momo_agent::NewApproval {
            run_id: context.run_id,
            channel_id: context.channel_id,
            requested_by: context.agent_member_id,
            action_type: actions::ACTION_TYPE_WORKSPACE_ACTION.to_string(),
            payload,
            expires_at: context.expires_at,
        },
    )
    .await?;
    // Drafts and renditions copied in the database, the staging emptied, the head moved with its
    // approval in one UPDATE. The hand-over reads `expires_at` again, after the approval INSERT: a set
    // that expires between the lock above and this call is refused **here**, and this refusal is the
    // only wall left at that edge (#5460 review M2-a), not a second proof. It is an `Err` on purpose:
    // the caller rolls back what was written so far, whereas an `Ok(Err(_))` would be committed (an
    // approval nobody can see and a run parked until its window ends).
    let handed = match expression_error(
        set::hand_over_in_tx(conn, owner, set_id, approval_id, context.expires_at).await,
    )? {
        Ok(handed) => handed,
        Err(refusal) => {
            return Err(DbError::from(sqlx::Error::Protocol(format!(
                "a staged set could not be handed to its approval: {}",
                refusal.code()
            ))))
        }
    };
    let card = expression_error(
        set::card_in_tx(conn, workspace_id, set_id, approval_id, context.expires_at).await,
    )?;
    let mut rows = vec![
        actions::action_row("제목", held.title.clone()),
        actions::action_row("그림", format!("{}개", handed.ready)),
    ];
    if handed.gray > 0 {
        rows.push(actions::action_row(
            "만들지 못한 장면",
            format!("{}개", handed.gray),
        ));
    }
    let mut block = actions::action_block(action, rows, None);
    if let Some(object) = block.as_object_mut() {
        // ADR-0218 `SetApproval`: the set as stored, in `approval_request.props.action.expressionSet`.
        object.insert("expressionSet".into(), card);
    }
    let mut props = actions::workspace_action_request_props(
        approval_id,
        context.run_id,
        context.channel_id,
        action,
        block,
        context.expires_at,
    );
    if let Some(object) = props.as_object_mut() {
        // D6-3: the approver is told who asked and that the team AI proposed it.
        object.insert(
            "proposed_via".into(),
            json!({
                "kind": "team_ai",
                "requester_id": requester.member_id.to_string(),
                "requester_name": inert_display_name(&requester.display_name),
            }),
        );
    }
    actions::stamp_decision_mode(&mut props, decision);
    let place = momo_agent::run_answer_root_in_tx(conn, workspace_id, context.run_id).await?;
    let card = send_thread_notice_in_tx(
        conn,
        workspace_id,
        NewMessage {
            channel_id: context.channel_id,
            author_member_id: context.agent_member_id,
            message_type: MessageType::ApprovalRequest,
            body: Some(actions::workspace_action_request_body(action)),
            props,
            root_id: place,
            reply_to_id: None,
            client_msg_id: Some(actions::card_client_msg_id(approval_id)),
            run_id: Some(context.run_id),
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await?;
    momo_agent::approval::attach_request_message_in_tx(
        conn,
        workspace_id,
        approval_id,
        card.message.id,
    )
    .await?;
    // The run's creation → card time, in the database's own clock: the figure ADR-0201 D7's budget is
    // judged by, the same one the model's door records (`run_to_card_ms`).
    let run_to_card_ms: Option<i64> = sqlx::query(
        "SELECT (extract(epoch FROM (clock_timestamp() - created_at)) * 1000)::bigint AS ms \
           FROM agent_run WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(context.run_id)
    .fetch_optional(&mut *conn)
    .await?
    .and_then(|row| row.try_get::<Option<i64>, _>("ms").ok().flatten());
    Ok(Ok(ProposalOk {
        run_to_card_ms,
        approval_id,
        card_message_id: card.message.id,
        requester_member_id: requester.member_id,
    }))
}
