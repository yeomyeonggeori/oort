//! Executing an approved tool call (goal SRV-T1).
//!
//! ## The authority question, and the answer that adds no new policy
//!
//! A tool runs **as the human who approved it** — `approved_by` on the resume
//! payload, which is `approval.decided_by`.
//!
//! The alternative was to run it as the agent and invent a rule for what an
//! agent may do to someone else's work session. That rule would be new
//! security policy, written by this batch, reviewable only by reasoning about
//! it. Running as the approver needs no new rule at all: [`end_session`] calls
//! the same domain functions `routes::work_sessions::end` calls, with the same
//! `member_id`, so the tool can do **exactly** what that person could have done
//! by tapping the button themselves — no more, and no less. A non-owner who
//! approves gets the route's own 403, surfaced as a failed `tool_result`.
//!
//! The agent gains nothing it did not have. It proposed; a person acted. Both
//! halves are in the audit trail: `approval.requested` names the agent,
//! `tool.executed` names the approver.
//!
//! ## Why the lock ladder is re-derived here
//!
//! `momo_t3::with_t3_lifecycle_tx` must be entered with the cloud host id
//! resolved **before** the transaction opens, and re-checked inside it — the
//! same two-step `routes::work_sessions::end` performs (and the same 409 when
//! the two disagree). Skipping the ladder for a T3 session would write a
//! settlement outside the advisory that orders settlements, so the branch is
//! reproduced rather than simplified away.
//!
//! ## What this module does not do
//!
//! It does not call a provider, hold a credential, or read one (ADR-0004): the
//! whole execution is a local Postgres lifecycle transition. That is one of the
//! three properties that chose this tool — see `momo_agent::tools`.

use momo_agent::tools::{
    ToolCall, ToolResult, WORK_SESSION_END, WORK_SESSION_LOGIN_HANDOFF, WORK_SESSION_SPAWN,
};
use momo_db::{DbError, PgConnection, PgPool};
use momo_messaging::{cent_channel, send_message_in_tx, MessageType, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_t3::work_control::{
    bind_control_session_in_tx, control_event_payload, insert_work_control_in_tx,
    mark_control_dispatched_in_tx, spawn_host_ineligible_reason_in_tx, validated_label,
    validated_tool_key, NewWorkControl, KIND_SPAWN, STATUS_APPROVED,
};
use momo_t3::{
    acquire_slot_in_tx, allocate_uuid_v7, card_props, cloud_host_id_for_host,
    cloud_host_id_for_host_in_tx, cloud_host_id_for_session_in_tx,
    create_work_session_with_id_in_tx, end_work_session_in_tx, is_active_channel_member_in_tx,
    latest_control_window_in_tx, lifecycle_payload, lock_work_session_detail_in_tx,
    resolve_cloud_host_id, start_usage_in_tx, terminate_in_tx, update_session_card_props_in_tx,
    with_t3_lifecycle_tx, work_session_scope_in_tx, work_tool_is_enabled_in_tx,
    ControlWindowEndReason, NewWorkSession, T3Error, T3LockLadder, TerminationReason,
};
use uuid::Uuid;

/// Everything an execution needs to name itself in the timeline.
#[derive(Debug, Clone)]
pub struct ToolContext {
    pub workspace_id: Uuid,
    pub run_id: Uuid,
    pub channel_id: Uuid,
    /// The agent — the `tool_result` message's author, because the tool call was
    /// the agent's utterance and its outcome belongs to the same speaker.
    pub agent_member_id: Uuid,
    /// The human whose authority the tool runs with.
    pub approved_by: Uuid,
    /// ADR-0125 D6-A (#1114) — the host the approver chose, when the approval
    /// asked. `None` means the call's own `host_id` argument stands.
    pub approved_host_id: Option<Uuid>,
}

/// Run an approved tool call and record its `tool_result` in the channel, in one
/// transaction.
///
/// Never returns `Err` for a *tool* failure — a refused or impossible tool call
/// is a [`ToolResult`] with `is_error: true`, because that is what the model
/// must be shown next. `Err` is reserved for a database failure, which is the
/// worker's problem and gets the worker's retry.
pub async fn execute(
    pool: &PgPool,
    context: &ToolContext,
    call: &ToolCall,
) -> Result<ToolResult, DbError> {
    // An unknown tool is answered, not executed. The catalog is deliberately one
    // entry (see `momo_agent::tools`), so this is the arm every *other* declared
    // tool takes — by name, so the model learns what happened rather than
    // seeing a silent success.
    if !momo_agent::is_executable(&call.name) {
        return write_result(
            pool,
            context,
            ToolResult::error(
                &call.call_id,
                format!(
                    "Tool `{}` is declared but this server cannot execute it.",
                    call.name
                ),
            ),
        )
        .await;
    }

    let result = match momo_agent::tools::normalize(&call.name).as_str() {
        name if name == momo_agent::tools::normalize(WORK_SESSION_END) => {
            end_session(pool, context, call).await?
        }
        name if name == momo_agent::tools::normalize(WORK_SESSION_SPAWN) => {
            spawn_session(pool, context, call).await?
        }
        name if name == momo_agent::tools::normalize(WORK_SESSION_LOGIN_HANDOFF) => {
            login_handoff(pool, context, call).await?
        }
        // Unreachable while the catalog has one entry, and deliberately not a
        // `panic!`: a catalog entry added without an executor must degrade to a
        // message, never take the worker down.
        _ => ToolResult::error(
            &call.call_id,
            format!("Tool `{}` has no executor.", call.name),
        ),
    };

    write_result(pool, context, result).await
}

/// `work.session.login_handoff` — report how the person's intervention ended
/// (LIVE-4 / ADR-0004 증보 3 D3).
///
/// ## What "executing" means for a tool whose action is a person
///
/// Nothing here opens a window, dials a screen or touches a run. By the time
/// this runs a human has already decided — approving the card is what resumed
/// the agent — and the only thing left to do is tell the model **which of the
/// three boundary endings happened**, because they are not interchangeable:
///
/// * `returned` and a bare approval both mean the person said they finished.
///   The design canon's 명시 버튼 주동선 makes those the same signal, and the
///   card a reader is looking at says the same thing, so this must not disagree
///   with it.
/// * `expired` means the lease lapsed with nobody saying they were done. That is
///   「중단·완료 불확실」 and the sentence has to forbid the assumption, or the
///   agent walks on across a login screen it never got past.
/// * `session_ended` means there is nothing left to go back to.
///
/// ## Why it reads the ledger rather than trusting the decision
///
/// The approval only records that a person pressed a button. Whether a control
/// window stood, and how it closed, is a fact only 076 holds — and the ledger is
/// the SoT, the boundary envelope merely its transport. A tool result derived
/// from the decision alone would report `returned` for a window that had
/// actually lapsed underneath it.
///
/// Every settled branch is `ToolResult::ok`. None of them is a tool failure: an
/// intervention that lapsed is news the model must act on, not an error it
/// should retry, and marking it `is_error` would paint a person walking away as
/// a fault (ADR-0132's rule about silence, one surface over).
async fn login_handoff(
    pool: &PgPool,
    context: &ToolContext,
    call: &ToolCall,
) -> Result<ToolResult, DbError> {
    let Some(session_id) = call
        .arguments
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw.trim()).ok())
    else {
        return Ok(ToolResult::error(
            &call.call_id,
            "work.session.login_handoff requires a `session_id` argument containing a UUID.",
        ));
    };

    let workspace_id = context.workspace_id;
    let window = momo_db::with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move { latest_control_window_in_tx(conn, workspace_id, session_id).await })
    })
    .await;

    let window = match window {
        Ok(window) => window,
        // A read that failed says so. Guessing 「완료」 here would be the worst
        // possible direction, for exactly the reason `expired` has its own
        // sentence.
        Err(_) => {
            return Ok(ToolResult::error(
                &call.call_id,
                "Could not read the control window ledger for this session. \
                 Re-check the screen before assuming the sign-in completed.",
            ))
        }
    };

    let output = match window {
        None => {
            "The person reported the intervention complete. No control window was opened in \
             this deployment, so continue from the session's own screen state."
        }
        Some(window) if window.ended_at_ms.is_none() => {
            "A person still holds this session's screen. Wait for the boundary event before \
             acting on the session."
        }
        Some(window) => match window.end_reason {
            Some(ControlWindowEndReason::Returned) => {
                "The person finished and handed the screen back. Continue as signed in."
            }
            Some(ControlWindowEndReason::Expired) => {
                "The handoff lapsed with no completion signal. Do NOT assume the sign-in \
                 succeeded: re-check the screen and only then continue."
            }
            Some(ControlWindowEndReason::SessionEnded) => {
                "The work session ended while the handoff was open, so the sign-in did not \
                 complete here."
            }
            // 076's CHECK makes an ended window without a reason
            // unrepresentable. Answering the unreachable branch with the
            // cautious sentence rather than the confident one keeps the failure
            // direction right if that ever stops being true.
            None => {
                "The handoff ended without a recorded reason. Re-check the screen before \
                 assuming the sign-in succeeded."
            }
        },
    };

    Ok(ToolResult::ok(&call.call_id, output))
}

/// `work.session.end` — end a work session, settling its T3 ledger.
async fn end_session(
    pool: &PgPool,
    context: &ToolContext,
    call: &ToolCall,
) -> Result<ToolResult, DbError> {
    let Some(session_id) = call
        .arguments
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw.trim()).ok())
    else {
        return Ok(ToolResult::error(
            &call.call_id,
            "work.session.end requires a `session_id` argument containing a UUID.",
        ));
    };

    let workspace_id = context.workspace_id;
    let actor = context.approved_by;

    // Resolved without a lock; the transaction re-reads it under the ladder and
    // refuses if it moved (`routes::work_sessions::end`).
    let cloud_host_id = match resolve_cloud_host_id(pool, workspace_id, session_id).await {
        Ok(id) => id,
        Err(T3Error::SessionNotFound) => {
            return Ok(ToolResult::error(&call.call_id, "Work session not found."))
        }
        Err(error) => return Ok(tool_failure(&call.call_id, error)),
    };

    let call_id = call.call_id.clone();
    let channel_id = context.channel_id;
    // `tool_body` pins the `for<'c>` shape both transaction guards require.
    // Without it the compiler infers one concrete lifetime for
    // `&mut PgConnection` at the closure's definition site and then refuses it
    // at both call sites — the same reason `routes::shared::lifecycle_body`
    // exists on the server side.
    let body = tool_body(move |conn: &mut PgConnection| {
        let call_id = call_id.clone();
        Box::pin(async move {
            end_session_in_tx(
                conn,
                workspace_id,
                actor,
                session_id,
                cloud_host_id,
                &call_id,
                channel_id,
            )
            .await
        }) as _
    });

    let outcome = match cloud_host_id {
        // Same ladder `routes::work_sessions::end` takes: this transaction may
        // reach `t3_terminate`, which appends a `credit_entry`.
        Some(cloud_host_id) => {
            with_t3_lifecycle_tx(
                pool,
                workspace_id,
                T3LockLadder::host(cloud_host_id).with_workspace_credit(),
                body,
            )
            .await
        }
        None => {
            momo_db::with_tenant_tx_prelude(
                pool,
                workspace_id,
                |_conn| Box::pin(async move { Ok(()) }),
                |_conn| Box::pin(async move { Ok(()) }),
                body,
            )
            .await
        }
    };

    match outcome {
        Ok(result) => Ok(result),
        Err(error) => Ok(tool_failure(&call.call_id, error)),
    }
}

/// The authorization + settlement, mirroring `work_sessions::end_in_tx`.
#[allow(clippy::too_many_arguments)]
async fn end_session_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    actor_member_id: Uuid,
    session_id: Uuid,
    expected_cloud_host_id: Option<Uuid>,
    call_id: &str,
    run_channel_id: Uuid,
) -> Result<ToolResult, T3Error> {
    if cloud_host_id_for_session_in_tx(conn, workspace_id, session_id).await?
        != expected_cloud_host_id
    {
        return Ok(ToolResult::error(
            call_id,
            "Work session cloud lifecycle changed; ask again.",
        ));
    }

    if expected_cloud_host_id.is_some() {
        // Authorization WITHOUT the session row lock — `t3_terminate` owns the
        // `usage → session` rungs and must take them after this prelude's
        // `credit → cloud host`. Taking the session row here inverts that order.
        let Some((owner_member_id, _host_id, channel_id)) =
            work_session_scope_in_tx(conn, workspace_id, session_id).await?
        else {
            return Ok(ToolResult::error(call_id, "Work session not found."));
        };
        if owner_member_id != actor_member_id {
            return Ok(ToolResult::error(
                call_id,
                "Only the session owner can end it, and the approver is not the owner.",
            ));
        }
        if !is_active_channel_member_in_tx(conn, workspace_id, channel_id, owner_member_id).await? {
            return Ok(ToolResult::error(
                call_id,
                "Active channel membership required.",
            ));
        }
        terminate_in_tx(conn, workspace_id, session_id, TerminationReason::Ended).await?;
    }

    let Some((existing, root_seq)) =
        lock_work_session_detail_in_tx(conn, workspace_id, session_id).await?
    else {
        return Ok(ToolResult::error(call_id, "Work session not found."));
    };
    if existing.member_id != actor_member_id {
        return Ok(ToolResult::error(
            call_id,
            "Only the session owner can end it, and the approver is not the owner.",
        ));
    }
    if !is_active_channel_member_in_tx(conn, workspace_id, existing.channel_id, existing.member_id)
        .await?
    {
        return Ok(ToolResult::error(
            call_id,
            "Active channel membership required.",
        ));
    }
    // Already ended: the same idempotent success the route answers with. A tool
    // call retried after a lease takeover must not read as a failure.
    if existing.status == "ended" {
        return Ok(ToolResult::ok(
            call_id,
            format!("Work session `{}` was already ended.", existing.label),
        ));
    }
    // The run's channel is not the session's: the agent is reaching outside the
    // room it was asked in. Refused even though the approver is the owner,
    // because the approval card a person read named this channel.
    if existing.channel_id != run_channel_id {
        return Ok(ToolResult::error(
            call_id,
            "Work session belongs to a different channel than this run.",
        ));
    }

    let Some(ended) = end_work_session_in_tx(conn, workspace_id, session_id, None).await? else {
        return Ok(ToolResult::error(
            call_id,
            "Work session state changed; ask again.",
        ));
    };

    let props = card_props(
        ended.id,
        &ended.tool,
        &ended.label,
        "ended",
        ended.ended_at_ms,
        ended.exit_code,
        None,
        None,
    );
    update_session_card_props_in_tx(
        conn,
        workspace_id,
        ended.root_message_id,
        &props.to_string(),
    )
    .await?;

    emit_outbox(
        &mut *conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &lifecycle_payload(
            &cent_channel(workspace_id, ended.channel_id),
            "work.session.ended",
            &ended,
            root_seq,
        ),
        Some(ended.channel_id),
    )
    .await
    .map_err(|error| T3Error::from(DbError::from(error)))?;

    Ok(ToolResult::ok(
        call_id,
        format!("Ended work session `{}` ({}).", ended.label, ended.tool),
    ))
}

// ---------------------------------------------------------------------------
// work.session.spawn (#1114)
// ---------------------------------------------------------------------------

/// The validated arguments of a `work.session.spawn` call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnArguments {
    pub tool: String,
    pub label: String,
    /// The host the **model** proposed, which the approver may replace.
    pub host_id: Option<Uuid>,
}

/// The argument validator (the second of the three pieces #1114 required).
///
/// It answers a `&'static str` rather than an error type because every rejection
/// here becomes a `tool_result` the model reads: the sentence *is* the return
/// value, and one that says "which host?" is what makes the next turn better
/// than the last.
///
/// `host_id` is deliberately permissive about absence and strict about shape: a
/// missing host is the normal case (the approver picks), while a present one
/// that is not a uuid is a model mistake worth naming rather than dropping.
pub fn spawn_arguments(arguments: &serde_json::Value) -> Result<SpawnArguments, &'static str> {
    let Some(object) = arguments.as_object() else {
        return Err("work.session.spawn requires an arguments object.");
    };
    let Some(tool) = object.get("tool").and_then(serde_json::Value::as_str) else {
        return Err("work.session.spawn requires a `tool` argument, e.g. \"codex\".");
    };
    let tool = validated_tool_key(tool)
        .map_err(|_| "`tool` must be a lowercase tool key such as `codex` or `claude`.")?;
    let Some(label) = object.get("label").and_then(serde_json::Value::as_str) else {
        return Err("work.session.spawn requires a `label` argument naming the session.");
    };
    let label = validated_label(label).map_err(|_| "`label` must contain 1 to 120 characters.")?;

    let host_id = match object.get("host_id") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let Some(host_id) = value
                .as_str()
                .map(str::trim)
                .and_then(|raw| Uuid::parse_str(raw).ok())
            else {
                return Err(
                    "`host_id` must be a work host UUID, or omitted so the approver picks.",
                );
            };
            Some(host_id)
        }
    };
    Ok(SpawnArguments {
        tool,
        label,
        host_id,
    })
}

/// `work.session.spawn` — start a tool in a new work session on a chosen host.
///
/// ## Why the session is created here and not by a daemon
///
/// The REST ledger's spawn is a message to a host: the daemon starts the tool,
/// creates the session, and acks. That path stays exactly as Swift has it. This
/// executor is the **in-process** half the tool loop needs, and it does what
/// Swift's `resume` does (`WorkSessionRoutes.swift:1940-1959`): create the
/// session first, then write the `work_control` spawn row **bound to it**, so a
/// daemon watching `work.control.dispatched` is told which session to attach the
/// tool it starts to. One ledger, two orders of arrival — not two ledgers.
///
/// ## The three authorities, kept apart
///
/// * the **agent** proposed it (`context.agent_member_id` authors the result);
/// * a **human** authorised it, and chose where (`context.approved_host_id`);
/// * the session belongs to the agent's **owner human**, which is the member
///   every check below is made for. That is Swift's `sessionOwnerMemberID =
///   binding.ownerHumanID`, and it is why an approver from another team cannot
///   turn a colleague's agent into a session on their own laptop.
async fn spawn_session(
    pool: &PgPool,
    context: &ToolContext,
    call: &ToolCall,
) -> Result<ToolResult, DbError> {
    let arguments = match spawn_arguments(&call.arguments) {
        Ok(arguments) => arguments,
        Err(message) => return Ok(ToolResult::error(&call.call_id, message)),
    };
    // The human's pick wins over the model's proposal. Both absent is a refusal
    // rather than a guess: picking a host on the agent's behalf would make the
    // approval card decorative.
    let Some(host_id) = context.approved_host_id.or(arguments.host_id) else {
        return Ok(ToolResult::error(
            &call.call_id,
            "No work host was chosen for this spawn. Ask the person approving to \
             pick a host, or name one with `host_id`.",
        ));
    };

    let workspace_id = context.workspace_id;
    let channel_id = context.channel_id;
    let agent_member_id = context.agent_member_id;
    let call_id = call.call_id.clone();

    let owner_member_id = match momo_db::with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            momo_t3::work_control::agent_owner_human_in_tx(conn, workspace_id, agent_member_id)
                .await
                .map_err(|error| match error {
                    T3Error::Db(inner) => inner,
                    other => DbError::Sqlx(momo_db::sqlx::Error::Protocol(other.to_string())),
                })
        })
    })
    .await?
    {
        Some(owner) => owner,
        None => {
            return Ok(ToolResult::error(
                &call.call_id,
                "This agent has no active human owner, so it cannot own a work session.",
            ))
        }
    };

    // Resolved without a lock; the transaction re-reads it under the ladder and
    // refuses if it moved — the same two-step `routes::work_sessions::create`
    // performs.
    let cloud_host_id = match cloud_host_id_for_host(pool, workspace_id, host_id).await {
        Ok(id) => id,
        Err(error) => return Ok(spawn_failure(&call.call_id, error)),
    };

    let spawn = arguments.clone();
    let body = tool_body(move |conn: &mut PgConnection| {
        let call_id = call_id.clone();
        let spawn = spawn.clone();
        Box::pin(async move {
            spawn_session_in_tx(
                conn,
                SpawnInTx {
                    workspace_id,
                    owner_member_id,
                    agent_member_id,
                    channel_id,
                    host_id,
                    expected_cloud_host_id: cloud_host_id,
                    arguments: spawn,
                    call_id,
                },
            )
            .await
        }) as _
    });

    let outcome = match cloud_host_id {
        // T3: the host advisory + the work_pool rung, exactly as the REST create
        // takes them (`lockWorkPool: targetCloudHostID != nil`).
        Some(cloud_host_id) => {
            with_t3_lifecycle_tx(
                pool,
                workspace_id,
                T3LockLadder::host(cloud_host_id).with_work_pool(),
                body,
            )
            .await
        }
        None => {
            momo_db::with_tenant_tx_prelude(
                pool,
                workspace_id,
                |_conn| Box::pin(async move { Ok(()) }),
                |_conn| Box::pin(async move { Ok(()) }),
                body,
            )
            .await
        }
    };

    match outcome {
        Ok(result) => Ok(result),
        Err(error) => Ok(spawn_failure(&call.call_id, error)),
    }
}

struct SpawnInTx {
    workspace_id: Uuid,
    owner_member_id: Uuid,
    agent_member_id: Uuid,
    channel_id: Uuid,
    host_id: Uuid,
    expected_cloud_host_id: Option<Uuid>,
    arguments: SpawnArguments,
    call_id: String,
}

/// The eligibility re-check, the session, and the control row — one transaction.
///
/// Order is the REST route's: every refusal is answered before the first write,
/// so a refused spawn leaves no card, no session and no ledger row behind.
async fn spawn_session_in_tx(
    conn: &mut PgConnection,
    input: SpawnInTx,
) -> Result<ToolResult, T3Error> {
    let call_id = input.call_id.as_str();

    if cloud_host_id_for_host_in_tx(conn, input.workspace_id, input.host_id).await?
        != input.expected_cloud_host_id
    {
        return Ok(ToolResult::error(
            call_id,
            "Work host cloud lifecycle changed; ask again.",
        ));
    }
    // **Red proof #2 lives here.** The picker's answer was computed when the
    // card was drawn; this is the answer now, for the member who will own the
    // session. A host that belongs to someone else, was revoked, went quiet, or
    // is the reserved T3 slot is refused by name.
    if let Some(reason) = spawn_host_ineligible_reason_in_tx(
        conn,
        input.workspace_id,
        input.host_id,
        input.owner_member_id,
    )
    .await?
    {
        return Ok(ToolResult::error(
            call_id,
            format!("That work host cannot run this session ({reason})."),
        ));
    }
    if !work_tool_is_enabled_in_tx(conn, input.workspace_id, &input.arguments.tool).await? {
        return Ok(ToolResult::error(
            call_id,
            format!(
                "`{}` is not enabled in this workspace.",
                input.arguments.tool
            ),
        ));
    }
    if !is_active_channel_member_in_tx(
        conn,
        input.workspace_id,
        input.channel_id,
        input.owner_member_id,
    )
    .await?
    {
        return Ok(ToolResult::error(
            call_id,
            "The session owner is not an active member of this channel.",
        ));
    }
    // Slot admission (ADR-0125 D5). Its vocabulary is the REST route's.
    if let Err(error) = acquire_slot_in_tx(
        conn,
        input.workspace_id,
        input.owner_member_id,
        input.host_id,
    )
    .await
    {
        return Ok(match error {
            T3Error::SlotsExhausted { .. } => ToolResult::error(
                call_id,
                "This workspace has no free work session slots right now.",
            ),
            T3Error::MemberSlotLimit { .. } => ToolResult::error(
                call_id,
                "The session owner has reached their concurrent work session limit.",
            ),
            other => return Err(other),
        });
    }

    // ---- writes ------------------------------------------------------------
    let session_id = allocate_uuid_v7(conn).await?;
    let props = card_props(
        session_id,
        &input.arguments.tool,
        &input.arguments.label,
        "running",
        None,
        None,
        None,
        None,
    );
    // The card goes through the message spine, so the seq bump, the row and its
    // `message.new` broadcast keep one implementation (invariants #3/#4).
    // `client_msg_id = session_id` makes the card idempotent per session, the
    // same key `routes::work_sessions::create` uses.
    let card = send_message_in_tx(
        conn,
        input.workspace_id,
        NewMessage {
            channel_id: input.channel_id,
            author_member_id: input.owner_member_id,
            message_type: MessageType::System,
            body: None,
            props,
            root_id: None,
            reply_to_id: None,
            client_msg_id: Some(session_id),
            run_id: None,
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await
    .map_err(T3Error::from)?;

    let session = create_work_session_with_id_in_tx(
        conn,
        input.workspace_id,
        session_id,
        NewWorkSession {
            channel_id: input.channel_id,
            member_id: input.owner_member_id,
            host_id: input.host_id,
            root_message_id: card.message.id,
            tool: input.arguments.tool.clone(),
            label: input.arguments.label.clone(),
        },
    )
    .await?;
    start_usage_in_tx(conn, input.workspace_id, session.id, input.host_id).await?;

    // The ledger row a host consumes. It is born `approved` — a human already
    // said yes to *this* spawn, and the row records the delivery rather than
    // re-asking the question.
    let control = insert_work_control_in_tx(
        conn,
        input.workspace_id,
        NewWorkControl {
            channel_id: input.channel_id,
            requester_member_id: input.agent_member_id,
            target_host_id: input.host_id,
            session_id: None,
            kind: KIND_SPAWN.to_string(),
            payload: serde_json::json!({
                "tool": input.arguments.tool,
                "label": input.arguments.label,
            }),
            status: STATUS_APPROVED.to_string(),
        },
    )
    .await?;
    let control = bind_control_session_in_tx(conn, input.workspace_id, control.id, session.id)
        .await?
        .unwrap_or(control);
    let Some(dispatched) =
        mark_control_dispatched_in_tx(conn, input.workspace_id, control.id).await?
    else {
        return Err(T3Error::IllegalTransition(
            "spawn control could not be dispatched".to_string(),
        ));
    };

    let detail = lock_work_session_detail_in_tx(conn, input.workspace_id, session.id)
        .await?
        .ok_or(T3Error::SessionNotFound)?;
    for payload in [
        lifecycle_payload(
            &cent_channel(input.workspace_id, input.channel_id),
            "work.session.started",
            &detail.0,
            card.message.seq,
        ),
        control_event_payload(
            &cent_channel(input.workspace_id, input.channel_id),
            "work.control.dispatched",
            &dispatched,
            None,
            None,
        ),
    ] {
        emit_outbox(
            &mut *conn,
            input.workspace_id,
            OutboxKind::Broadcast,
            "publish",
            &payload,
            Some(input.channel_id),
        )
        .await
        .map_err(|error| T3Error::from(DbError::from(error)))?;
    }

    Ok(ToolResult::ok(
        call_id,
        format!(
            "Started work session `{}` ({}) on host {}.",
            input.arguments.label, input.arguments.tool, input.host_id
        ),
    ))
}

/// A domain failure a spawn should tell the model about, phrased without
/// internals.
fn spawn_failure(call_id: &str, error: T3Error) -> ToolResult {
    ToolResult::error(
        call_id,
        format!("Could not start the work session: {error}"),
    )
}

/// Pin a closure to the higher-ranked shape `with_t3_lifecycle_tx` and
/// `with_tenant_tx_prelude` both take, so one closure can serve both arms.
fn tool_body<F>(body: F) -> F
where
    F: for<'c> FnOnce(
            &'c mut PgConnection,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<ToolResult, T3Error>> + Send + 'c>,
        > + Send,
{
    body
}

/// A domain failure the model should hear about, phrased without internals.
fn tool_failure(call_id: &str, error: T3Error) -> ToolResult {
    ToolResult::error(call_id, format!("Could not end the work session: {error}"))
}

/// Write the `tool_result` into the channel through the message spine.
///
/// `client_msg_id` is derived from the **provider's `call_id`**, which is what
/// makes execution idempotent: a job re-claimed after a lease takeover produces
/// the same key, and the spine's `(channel, author, client_msg_id)` guard
/// returns the existing row instead of posting a second result. The tool's own
/// side effect is idempotent for the same reason the route's is — an
/// already-ended session answers success without ending it twice.
///
/// It is [`result_message_id`], **not** [`call_message_id`] — see #1133. The two
/// rows share a channel and an author (the agent said both things), so sharing a
/// key too made the guard treat the result as a retry of the card and fold it
/// away: the room saw the ask and never the answer.
async fn write_result(
    pool: &PgPool,
    context: &ToolContext,
    result: ToolResult,
) -> Result<ToolResult, DbError> {
    let props = result.message_props();
    let body = result.message_body();
    let client_msg_id = result_message_id(context.run_id, &result.call_id);
    let context = context.clone();
    let stored = result.clone();

    momo_db::with_tenant_tx(pool, context.workspace_id, move |conn| {
        Box::pin(async move {
            send_message_in_tx(
                conn,
                context.workspace_id,
                NewMessage {
                    channel_id: context.channel_id,
                    author_member_id: context.agent_member_id,
                    message_type: MessageType::ToolResult,
                    body: Some(body),
                    props,
                    root_id: None,
                    reply_to_id: None,
                    client_msg_id: Some(client_msg_id),
                    run_id: Some(context.run_id),
                    hlc_ts: None,
                    hlc_count: None,
                },
            )
            .await?;
            Ok(())
        })
    })
    .await?;

    Ok(stored)
}

/// A stable v5-style id for one `(run, call_id)` pair — the **`tool_call` card**.
///
/// `client_msg_id` is a `uuid` column, and a provider's `call_id` is an
/// arbitrary string, so the string is hashed into a uuid rather than parsed as
/// one. Deterministic on purpose — that is the whole idempotency guarantee.
pub fn call_message_id(run_id: Uuid, call_id: &str) -> Uuid {
    Uuid::new_v5(&run_id, call_id.as_bytes())
}

/// The namespace the `tool_result` key space hangs off (#1133).
///
/// The card's key space is `Uuid::new_v5(&run_id, …)`, so a *separate* namespace
/// is what makes the result's key space disjoint — and disjoint **by
/// construction**, not by luck. The near miss worth naming: prefixing the name
/// instead (`"tool_result:" + call_id`) leaves both spaces rooted at the same
/// namespace, so a provider that happened to emit the `call_id`
/// `tool_result:x` would land back on top of another call's card. A name is
/// attacker- and vendor-controlled; a namespace is not.
///
/// The bytes are ASCII, which makes the constant readable in a hexdump and
/// pins the argument: byte 6 is `o` (`0x6f`), so its version nibble is 6, and
/// `agent_run.id` is `uuidv7()` at every insert site (`momo_agent::run`,
/// `schema_v0.sql:268`). No run id can ever equal this namespace, so the two
/// key spaces cannot meet at their roots either.
const TOOL_RESULT_NAMESPACE: Uuid = Uuid::from_bytes(*b"momo.tool_result");

/// A stable v5-style id for one `(run, call_id)` pair — the **`tool_result` row**.
///
/// Deterministic for the same reason [`call_message_id`] is: a resume replayed
/// after a lease takeover re-derives this key, the spine's
/// `(channel, author, client_msg_id)` guard finds the row it wrote the first
/// time, and the channel keeps exactly one result line per call. What changed in
/// #1133 is only *which* key space it is deterministic in.
///
/// `run_id` occupies a fixed 16-byte prefix of the hashed name, so the mapping
/// from `(run_id, call_id)` is injective — no `call_id` can borrow bytes from a
/// neighbouring run's id and alias onto it.
pub fn result_message_id(run_id: Uuid, call_id: &str) -> Uuid {
    let mut name = Vec::with_capacity(16 + call_id.len());
    name.extend_from_slice(run_id.as_bytes());
    name.extend_from_slice(call_id.as_bytes());
    Uuid::new_v5(&TOOL_RESULT_NAMESPACE, &name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Idempotency hangs off this being a pure function of the pair — a retried
    /// turn must derive the same key or the spine's guard cannot deduplicate.
    #[test]
    fn the_result_key_is_deterministic_per_run_and_call() {
        let run = Uuid::from_u128(1);
        for key in [call_message_id, result_message_id] {
            assert_eq!(key(run, "call_a"), key(run, "call_a"));
            assert_ne!(key(run, "call_a"), key(run, "call_b"));
            assert_ne!(key(run, "call_a"), key(Uuid::from_u128(2), "call_a"));
        }
    }

    /// #1133. The card and the result are two messages by one author in one
    /// channel, so the spine's `(channel, author, client_msg_id)` guard folds
    /// them the moment their keys agree — and the room loses the answer while
    /// keeping the question. Reverting `write_result` to `call_message_id`
    /// fails here first.
    #[test]
    fn a_call_and_its_result_never_share_a_key() {
        let run = Uuid::from_u128(1);
        assert_ne!(
            call_message_id(run, "call_a"),
            result_message_id(run, "call_a")
        );
    }

    /// The namespace is what makes that separation structural rather than
    /// probable: no `call_id` a provider can emit — including one that spells
    /// the prefix a name-based scheme would have used — walks one key space
    /// into the other.
    #[test]
    fn no_call_id_can_forge_a_result_key() {
        let run = Uuid::from_u128(1);
        for forged in [
            "tool_result:call_a",
            "tool_result",
            "result:call_a",
            // The 16 raw bytes of the namespace itself, and of a run id.
            "momo.tool_result",
            "\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{0}\u{1}",
        ] {
            assert_ne!(
                call_message_id(run, forged),
                result_message_id(run, "call_a"),
                "`{forged}` reached the result key space through the card's"
            );
        }
    }

    /// The 16-byte `run_id` prefix is what keeps the concatenated name
    /// injective: two different pairs cannot hash the same bytes by sliding the
    /// boundary between them.
    #[test]
    fn the_result_key_cannot_slide_its_run_boundary() {
        // `run_a` + "bcall" vs `run_b` + "call" — same tail letters, different
        // pairs, and the fixed-width prefix keeps them apart.
        let run_a = Uuid::from_bytes([0xaa; 16]);
        let run_b = Uuid::from_bytes([0xbb; 16]);
        assert_ne!(
            result_message_id(run_a, "bcall"),
            result_message_id(run_b, "call")
        );
    }

    /// The namespace is a v6-shaped constant and every `agent_run.id` is
    /// `uuidv7()`, so the two key spaces cannot share a root either.
    #[test]
    fn the_namespace_is_not_a_shape_any_run_id_takes() {
        assert_eq!(TOOL_RESULT_NAMESPACE.get_version_num(), 6);
        assert_ne!(TOOL_RESULT_NAMESPACE.get_version_num(), 7);
    }

    /// A `tool_result` for a failure is still a result, and its props keep the
    /// schema's three keys plus nothing that could leak internals.
    #[test]
    fn a_failed_tool_is_a_result_not_an_error() {
        let result = tool_failure("c1", T3Error::SessionNotFound);
        assert!(result.is_error);
        assert_eq!(result.call_id, "c1");
        let props = result.message_props();
        assert_eq!(props["is_error"], serde_json::json!(true));
        assert_eq!(props["call_id"], "c1");
    }
}
