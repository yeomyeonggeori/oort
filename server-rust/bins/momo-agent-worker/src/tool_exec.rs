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

use momo_agent::tools::{ToolCall, ToolResult, WORK_SESSION_END};
use momo_db::{DbError, PgConnection, PgPool};
use momo_messaging::{cent_channel, send_message_in_tx, MessageType, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_t3::{
    card_props, cloud_host_id_for_session_in_tx, end_work_session_in_tx,
    is_active_channel_member_in_tx, lifecycle_payload, lock_work_session_detail_in_tx,
    resolve_cloud_host_id, terminate_in_tx, update_session_card_props_in_tx, with_t3_lifecycle_tx,
    work_session_scope_in_tx, T3Error, T3LockLadder, TerminationReason,
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
async fn write_result(
    pool: &PgPool,
    context: &ToolContext,
    result: ToolResult,
) -> Result<ToolResult, DbError> {
    let props = result.message_props();
    let body = result.message_body();
    let client_msg_id = call_message_id(context.run_id, &result.call_id);
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

/// A stable v5-style id for one `(run, call_id)` pair.
///
/// `client_msg_id` is a `uuid` column, and a provider's `call_id` is an
/// arbitrary string, so the string is hashed into a uuid rather than parsed as
/// one. Deterministic on purpose — that is the whole idempotency guarantee.
pub fn call_message_id(run_id: Uuid, call_id: &str) -> Uuid {
    Uuid::new_v5(&run_id, call_id.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Idempotency hangs off this being a pure function of the pair — a retried
    /// turn must derive the same key or the spine's guard cannot deduplicate.
    #[test]
    fn the_result_key_is_deterministic_per_run_and_call() {
        let run = Uuid::from_u128(1);
        assert_eq!(
            call_message_id(run, "call_a"),
            call_message_id(run, "call_a")
        );
        assert_ne!(
            call_message_id(run, "call_a"),
            call_message_id(run, "call_b")
        );
        assert_ne!(
            call_message_id(run, "call_a"),
            call_message_id(Uuid::from_u128(2), "call_a")
        );
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
