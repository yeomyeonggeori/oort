//! `oort_action_initiate` — an approval card an agent raises **nobody asked for**
//! (ADR-0186 증보 2026-10-27 v5 U-a~U-d, #4704).
//!
//! `oort_action_propose` needs a lease handle, so it can only ever answer a request a person made.
//! This is the other door: no handle, no channel, no recipient. One call writes, in one
//! transaction, a run born `awaiting_approval`, one `workspace_action` approval and one card in the
//! agent's **owner's** one-to-one direct message — and stops. The action runs only when a person
//! says yes, as that person (the decision route, unchanged in kind).
//!
//! ## The order is the security
//!
//! `momo_db::with_tenant_tx` **commits a handled refusal**, so anything written before a refusal
//! stays. Hence the order, which the tests hold:
//!
//! 1. the agent's unasked-card calls are serialised behind an advisory lock (a re-ask of a card and
//!    a new card of the same agent never run side by side), then the connection and the scope are
//!    proved again inside this transaction (doors 1 and 2);
//! 2. a **re-ask** of a `clientRequestId` already raised answers from the record and stops: it
//!    reads, writes nothing, and is allowed while the workspace switch is off (it tells the agent
//!    about its own card and about nothing else);
//! 3. the rest of the door: the workspace switch (3), an active human owner who confirmed this
//!    connection (4), and that owner passing the action's role gate *now* (5);
//! 4. *(ceilings and rate: PR B — before the resolution, so an agent at its ceiling learns nothing
//!    from whether a name resolves, review M1)*;
//! 5. the arguments resolved **for the owner's eyes** (6): a channel or message the owner could
//!    not already read is the owner's side of the door;
//! 6. only now the owner's direct message is opened (idempotent), then the run, the approval and
//!    the card. Any failure after this point rolls all five tables back (run, approval, message,
//!    channel, membership).
//!
//! ## Answers
//!
//! Doors 1–6 answer one `ToolFailure::Unavailable`, byte for byte, whichever failed — an agent
//! must not be able to feel its owner's role or its connection's makeup (V1-b). What is the agent's
//! own — malformed arguments, a name it cannot see — is `InvalidArguments`. The ceilings and
//! duplicates (7, PR B) are `Conflict`: they are about the agent's own proposals and hide nothing.
//! (A **paused** agent never gets here: its tool list is already empty, so every tool answers it as
//! an unknown one; the check inside is for a pause that lands between the list and the call.)
//!
//! ## Lock order — no exclusive lock on a row anybody else shares
//!
//! `advisory(agent)` → `hosted_agent_connection · token · member · workspace_membership ·
//! agent_profile` (all `FOR SHARE`, the hosted canon) → reads and the shared `channel` row of a named
//! room → **the DM's `channel_seq` (`FOR UPDATE`, when the DM exists)** → the DM pair's advisory lock
//! and the DM's `channel` / `membership` rows (only when the DM is not already open) → `agent_run` →
//! `approval` → `message` (its `channel_seq` is already ours).
//!
//! * The first lock is advisory, not a row lock on the agent's `member`: a `FOR NO KEY UPDATE` there
//!   is exclusive against the `FOR SHARE` every message write, every decision's wake and the identity
//!   proof itself take, so it made two simultaneous calls of one agent deadlock every time and formed
//!   cycles with all of them (security review of #4704, M1).
//! * A person's send into the same DM, and a decision's wake, take `channel_seq` first (a send) or
//!   share-lock the agent's membership row in the DM before asking for it (a wake). The membership
//!   rows are the only thing this transaction could hold exclusively that those two want, and it
//!   takes them **only** when the DM has to be opened or re-opened — never for a DM that is already
//!   open — and only after `channel_seq` (review L8, held by a test that plays the person against
//!   an archived DM, which is the case that does write them).
//! * What is left is a three-way queue with an administrator's disconnect, which exists between any
//!   hosted tool and any send already. A transaction that loses a lock cycle to someone else commits
//!   nothing, and is run once more (below).

use chrono::Utc;
use momo_auth::{active_workspace_role, SCOPE_WORKSPACE_INITIATE};
use momo_db::{DbError, PgConnection};
use momo_mcp::ToolFailure;
use momo_messaging::{
    lock_direct_message_seq_in_tx, open_direct_message_in_tx, send_message_in_tx, MessageType,
    NewMessage, OpenedDirectMessage,
};
use momo_workspace_actions::action_resolve::{
    initiative_args_checks, resolve_initiative_action_in_tx, validated_action_args, ActionArgs,
    OWNER_CANNOT_SEE,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::routes::agent_port_tools::{
    arguments, authorize_in_tx, internal, optional_str, required_str, required_uuid, HostedCaller,
};
use crate::AppState;

/// The workspace settings key that switches unasked cards off for the whole workspace
/// (ADR-0186 증보 v5 U-b-3). Absent reads as **on**; `false` is off.
const SETTING_AGENT_INITIATIVE: &str = "agent_initiative";

/// A transaction that lost a lock cycle to a person's concurrent send and committed nothing is run
/// once more: it is one transaction with no effect outside the database, and its replay is
/// idempotent by `clientRequestId`. Once, not in a loop — the order above is what makes the cycle
/// impossible; this is the belt for a cycle nobody has thought of. (`approvals::decide` does the
/// same, for the same reason.)
const INITIATE_ATTEMPTS: u32 = 2;

fn is_deadlock_victim(error: &DbError) -> bool {
    matches!(
        error,
        DbError::Sqlx(momo_db::sqlx::Error::Database(database))
            if database.code().as_deref() == Some("40P01")
    )
}

/// `oort_action_initiate { clientRequestId, actionId, args, rationale? }`.
pub(crate) async fn action_initiate(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let client_request_id = required_uuid(args, "clientRequestId")?;
    let action_id = required_str(args, "actionId", 128)?;
    // An id that is proposable but not initiative, a team-AI-only id and an unknown id are one
    // answer, before any argument is read: the tool cannot be used to ask which actions exist.
    let action = momo_agent::actions::initiative_action_by_id(action_id)
        .ok_or(ToolFailure::InvalidArguments)?;
    // The agent's own sentence to a person who did not ask: the profile-tagline rules, 140
    // characters. An empty one is no rationale.
    let rationale: Option<String> = match optional_str(args, "rationale", 560)? {
        None => None,
        Some(raw) if raw.trim().is_empty() => None,
        Some(raw) => Some(
            momo_messaging::name_guard::validated_agent_tagline(raw)
                .map_err(|_| ToolFailure::InvalidArguments)?,
        ),
    };
    let raw_args = args.get("args").cloned().unwrap_or_else(|| json!({}));
    // The pure half of the normaliser, before a transaction opens, so a malformed proposal never
    // costs one — and the unasked card's own checks (private channel, plain topic).
    let now_ms = Utc::now().timestamp_millis();
    let mut pure = validated_action_args(action, &raw_args, now_ms)
        .map_err(|_| ToolFailure::InvalidArguments)?;
    initiative_args_checks(&mut pure).map_err(|_| ToolFailure::InvalidArguments)?;
    let normalized = pure.normalized;

    let mut attempt = 1;
    loop {
        let rationale = rationale.clone();
        let raw_args = raw_args.clone();
        let normalized = normalized.clone();
        let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
            Box::pin(async move {
                initiate_in_tx(
                    conn,
                    caller,
                    client_request_id,
                    action,
                    &raw_args,
                    &normalized,
                    rationale.as_deref(),
                )
                .await
            })
        })
        .await;
        match outcome {
            Err(error) if attempt < INITIATE_ATTEMPTS && is_deadlock_victim(&error) => {
                attempt += 1;
                tracing::warn!(
                    "an unasked card was the victim of a deadlock; running it once more"
                );
            }
            other => {
                return other.map_err(|error| internal("agent_port.action_initiate", error))?
            }
        }
    }
}

async fn initiate_in_tx(
    conn: &mut PgConnection,
    caller: HostedCaller,
    client_request_id: Uuid,
    action: &'static momo_agent::WorkspaceAction,
    raw_args: &Value,
    normalized: &Value,
    rationale: Option<&str>,
) -> Result<Result<Value, ToolFailure>, DbError> {
    let workspace_id = caller.workspace_id;
    let agent = caller.agent_member_id;

    // ---- serialise this agent's unasked-card calls (see the module header) -------------------
    //
    // First, before any share lock is taken: an advisory lock only this producer takes. The agent
    // and workspace are the transport's proven ones, so a revoked credential can only queue itself.
    momo_agent::initiative::lock_agent_initiative_in_tx(conn, workspace_id, agent).await?;

    // ---- doors 1 and 2: the connection, the scope, the agent --------------------------------
    //
    // `authorize_in_tx` re-proves the connection is active and proved, the agent active and not
    // paused, and `workspace:initiate` on **both** the token and the human's approval. Every
    // miss is the same `Unavailable` here (the tool's own, not the propose door's
    // `NotAuthorized`): a refusal of this door never says which part of the door it was.
    let identity = match authorize_in_tx(conn, caller, SCOPE_WORKSPACE_INITIATE).await? {
        Ok(identity) => identity,
        Err(_) => return Ok(Err(ToolFailure::Unavailable)),
    };

    // ---- the re-ask: read, write nothing, stop -----------------------------------------------
    //
    // Right behind doors 1 and 2 and **before** the switch and the owner (3–5): the answer is
    // the agent's own card's state and nothing about the owner, so it is allowed while the switch
    // is off. (A paused agent never gets here: doors 1–2 refuse it for every tool.) The same id
    // with different content is `Conflict`, judged on the **normalised** arguments the card was
    // drawn from — not on the rationale, which is commentary, and not on resolved ids, which
    // would need the resolution this branch skips.
    if let Some(record) = momo_agent::initiative::find_initiative_by_request_in_tx(
        conn,
        workspace_id,
        agent,
        client_request_id,
    )
    .await?
    {
        if record.action_id.as_deref() != Some(action.id) || &record.args != normalized {
            return Ok(Err(ToolFailure::Conflict));
        }
        return Ok(Ok(momo_agent::initiative::reask_answer(
            &record,
            Utc::now(),
        )));
    }

    // ---- doors 3, 4, 5 -----------------------------------------------------------------------
    // 3. the workspace switch (absent = on; a non-boolean or unreadable value = off).
    // Only an absent key or a literal `true` is on: a value that is not a boolean (`"false"`, `0`)
    // is not a switch somebody meant to leave on, and the door fails closed on it.
    let switch_on = match momo_settings::read_workspace_settings(conn, workspace_id).await? {
        Some(bag) => match bag.get(SETTING_AGENT_INITIATIVE) {
            None => true,
            Some(Value::Bool(on)) => *on,
            Some(_) => false,
        },
        None => false,
    };
    if !switch_on {
        return Ok(Err(ToolFailure::Unavailable));
    }
    // 4. an active human owner who confirmed this very connection.
    let Some(facts) = momo_agent::initiative::initiative_facts_in_tx(
        conn,
        workspace_id,
        agent,
        identity.connection_id,
    )
    .await?
    else {
        return Ok(Err(ToolFailure::Unavailable));
    };
    let owner = facts.owner_member_id;
    // 5. the owner passes this action's role gate **now**. Only `Admin` is spelled: an action
    // whose gate is anything else is not an initiative action, and a gate this function does not
    // know is a gate nobody passes. (A dead card is the thing refused; the decision's own gate is
    // the boundary.)
    let gate_open = match action.required_role {
        momo_agent::RequiredRole::Admin => active_workspace_role(conn, workspace_id, owner)
            .await
            .map_err(DbError::from)?
            .is_some_and(|role| role.is_admin()),
        _ => false,
    };
    if !gate_open {
        return Ok(Err(ToolFailure::Unavailable));
    }

    // ---- ceilings, rate: PR B (before the resolution, ADR U-d / review M1) -------------------

    // ---- 6. the arguments, resolved for the owner's eyes --------------------------------------
    let now = Utc::now();
    let resolved = match resolve_initiative_action_in_tx(
        conn,
        workspace_id,
        agent,
        owner,
        action,
        raw_args,
        now.timestamp_millis(),
    )
    .await?
    {
        Ok(resolved) => resolved,
        // The owner's side of the door: the same bytes as every other door refusal.
        Err(error) if error.message == OWNER_CANNOT_SEE => {
            return Ok(Err(ToolFailure::Unavailable))
        }
        // The agent's own: a name it cannot see, an argument the domain refuses.
        Err(_) => return Ok(Err(ToolFailure::InvalidArguments)),
    };
    // The resolver's normalisation is the one the card is drawn from and the decision re-proves;
    // it must be the one the re-ask compares.
    if &resolved.validated.normalized != normalized {
        return Ok(Err(ToolFailure::InvalidArguments));
    }

    // ---- duplicates, cooldown: PR B ------------------------------------------------------------

    // ---- 7. only now: the owner's DM, then the run, the approval and the card -----------------
    //
    // The DM's `channel_seq` FIRST when it exists — the order a person's send into it takes,
    // before anything here could take an exclusive lock on the DM's membership rows (module
    // header) — and an already-open DM is not opened again: the open's upsert would take both
    // membership rows exclusively even though it changes nothing.
    let dm_channel = match lock_direct_message_seq_in_tx(conn, workspace_id, agent, owner).await? {
        Some(dm) if dm.open => dm.channel_id,
        _ => match open_direct_message_in_tx(conn, workspace_id, agent, owner).await? {
            OpenedDirectMessage::Opened { channel, .. } => channel.id,
            OpenedDirectMessage::TargetNotFound => return Ok(Err(ToolFailure::Unavailable)),
        },
    };
    let expires_at =
        momo_agent::default_expires_at(now, momo_agent::initiative::INITIATIVE_TTL_SECONDS);
    let created = momo_agent::create_held_agent_run_in_tx(
        conn,
        workspace_id,
        momo_agent::NewAgentRun {
            channel_id: dm_channel,
            trigger: momo_agent::RunTrigger::AgentInitiated {
                agent_member_id: agent,
                client_request_id,
            },
            parent_run_id: None,
            max_steps: facts.max_run_steps,
            depth: 0,
            input: momo_agent::initiative::initiative_run_input(),
        },
        expires_at,
    )
    .await?;
    if !created.created {
        // The re-ask above found nothing under this key, and the member lock keeps every other
        // call of this agent out: a run that already exists here is a broken invariant, and
        // rolling back is the only safe answer.
        return Err(DbError::from(momo_db::sqlx::Error::RowNotFound));
    }

    let mut payload = momo_agent::workspace_action_payload(
        action.id,
        &resolved.validated.normalized,
        rationale,
        agent,
    );
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "origin".into(),
            Value::String(momo_agent::initiative::APPROVAL_ORIGIN_AGENT_INITIATED.into()),
        );
        if let Some(action_block) = object.get_mut("action").and_then(Value::as_object_mut) {
            // The ids the names resolved to, for the decision to compare.
            action_block.insert("pins".into(), resolved.pins.clone());
        }
    }
    let approval_id = momo_agent::create_pending_approval_in_tx(
        conn,
        workspace_id,
        momo_agent::NewApproval {
            run_id: created.id,
            channel_id: dm_channel,
            // The **agent** asked: `approval.requested_by` is a member id like any other, and a
            // decision requires `member.kind = 'human'`, so no agent can decide its own card.
            requested_by: agent,
            action_type: momo_agent::ACTION_TYPE_WORKSPACE_ACTION.to_string(),
            payload,
            expires_at,
        },
    )
    .await?;

    let message_preview: Option<Value> = match &resolved.validated.args {
        ActionArgs::MessagePin {
            target: Some(target),
            ..
        } => Some(momo_agent::actions::message_pin_preview(
            target.id,
            target.channel_id,
            &target.card,
        )),
        _ => None,
    };
    let mut block = momo_agent::action_block(action, resolved.validated.rows.clone(), rationale);
    if let (Some(preview), Some(object)) = (message_preview, block.as_object_mut()) {
        object.insert("preview".into(), preview);
    }
    let mut props = momo_agent::workspace_action_request_props(
        approval_id,
        created.id,
        dm_channel,
        action,
        block,
        expires_at,
    );
    if let Some(object) = props.as_object_mut() {
        // What tells a client the card was not asked for (the N4 contract) and what tells a
        // person: the sentence says so, in words, for the client that does not know the key.
        object.insert(
            "origin".into(),
            Value::String(momo_agent::initiative::APPROVAL_ORIGIN_AGENT_INITIATED.into()),
        );
        object.insert(
            "summary".into(),
            Value::String(momo_agent::initiative::initiative_summary(action)),
        );
    }
    let card = send_message_in_tx(
        conn,
        workspace_id,
        NewMessage {
            channel_id: dm_channel,
            author_member_id: agent,
            message_type: MessageType::ApprovalRequest,
            body: Some(momo_agent::workspace_action_request_body(action)),
            props,
            root_id: None,
            reply_to_id: None,
            // Derived from the approval id, never the approval id itself — see
            // `momo_agent::card_client_msg_id`: the card and the outcome line of one approval
            // share (channel, author) and must not share a key.
            client_msg_id: Some(momo_agent::card_client_msg_id(approval_id)),
            run_id: Some(created.id),
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await?;
    momo_agent::attach_request_message_in_tx(conn, workspace_id, approval_id, card.message.id)
        .await?;

    Ok(Ok(json!({
        "approvalId": approval_id,
        "status": "pending",
        "expiresAtMs": expires_at.timestamp_millis(),
        "cardMessageId": card.message.id,
    })))
}
