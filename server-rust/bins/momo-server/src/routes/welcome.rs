//! Welcome kickoff enqueue — same-tx as a newly created human member
//! (ADR-0181 D2) and as the first agent becoming welcome-capable
//! (ADR-0185 D-C c2).
//!
//! Native targets stay on the worker rail. Hosted targets take the gateway
//! rail (run in-tx, inbox reference), like mentions: a `publish` job for a
//! hosted agent is undeliverable and would consume the opener marker forever.

use chrono::Utc;
use momo_agent::{
    create_agent_run_in_tx, ensure_agent_in_general_in_tx, lock_welcome_opener_in_tx,
    resolve_welcome_owner_in_tx, resolve_welcome_target_in_tx, welcome_job_payload,
    welcome_opener_already_queued_in_tx, welcome_run_input, NewAgentRun, RunTrigger, WelcomeKind,
    WelcomeTarget, MENTION_JOB_METHOD_GATEWAY, MENTION_JOB_METHOD_WORKER, WELCOME_AUDIT_QUEUED,
    WELCOME_AUDIT_SCHEMA,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{DbError, PgConnection};
use serde_json::json;
use uuid::Uuid;

/// Insert the welcome job for a newly created human, or no-op when the
/// workspace has no one who can speak (or the only speaker is an undeliverable
/// hosted agent).
pub(crate) async fn enqueue_welcome_kickoff_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    gateway_enabled: bool,
    hosted_delivery_enabled: bool,
    prefer_agent_member_id: Option<Uuid>,
) -> Result<(), DbError> {
    lock_welcome_opener_in_tx(&mut *conn, workspace_id, member_id).await?;
    if welcome_opener_already_queued_in_tx(&mut *conn, workspace_id, member_id).await? {
        return Ok(());
    }
    let Some(target) = resolve_welcome_target_in_tx(
        &mut *conn,
        workspace_id,
        hosted_delivery_enabled,
        prefer_agent_member_id,
    )
    .await?
    else {
        return Ok(());
    };
    if target.is_hosted {
        enqueue_hosted_welcome_in_tx(
            conn,
            workspace_id,
            member_id,
            &target,
            hosted_delivery_enabled,
        )
        .await?;
        return Ok(());
    }
    enqueue_native_welcome_in_tx(conn, workspace_id, member_id, &target, gateway_enabled).await
}

/// First time a welcome speaker can actually be delivered: enqueue the opener
/// for the workspace owner if they have no live opener yet.
///
/// `speaker_agent_member_id` is the agent on this transition (native create or
/// hosted `active`). It is joined to `#general` when missing so resolve can
/// see it, and it is preferred as the speaker so a later hosted activation is
/// not shadowed by an earlier native that only posted `provider_required`.
pub(crate) async fn enqueue_owner_welcome_kickoff_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    speaker_agent_member_id: Option<Uuid>,
    gateway_enabled: bool,
    hosted_delivery_enabled: bool,
) -> Result<i32, DbError> {
    let Some(owner_id) = resolve_welcome_owner_in_tx(&mut *conn, workspace_id).await? else {
        return Ok(0);
    };
    lock_welcome_opener_in_tx(&mut *conn, workspace_id, owner_id).await?;
    if welcome_opener_already_queued_in_tx(&mut *conn, workspace_id, owner_id).await? {
        return Ok(0);
    }
    let mut joined = 0;
    if let Some(agent_member_id) = speaker_agent_member_id {
        if ensure_agent_in_general_in_tx(&mut *conn, workspace_id, agent_member_id).await? {
            joined = 1;
        }
    }
    enqueue_welcome_kickoff_in_tx(
        conn,
        workspace_id,
        owner_id,
        gateway_enabled,
        hosted_delivery_enabled,
        speaker_agent_member_id,
    )
    .await?;
    Ok(joined)
}

async fn enqueue_native_welcome_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    target: &WelcomeTarget,
    gateway_enabled: bool,
) -> Result<(), DbError> {
    let delivery = if gateway_enabled {
        MENTION_JOB_METHOD_GATEWAY
    } else {
        MENTION_JOB_METHOD_WORKER
    };
    let payload = welcome_job_payload(
        workspace_id,
        member_id,
        target,
        WelcomeKind::Opener,
        delivery,
        Utc::now().timestamp_millis(),
        None,
    );
    let method = if gateway_enabled {
        MENTION_JOB_METHOD_GATEWAY
    } else {
        MENTION_JOB_METHOD_WORKER
    };
    emit_welcome_job(conn, workspace_id, member_id, target, method, payload).await
}

/// Hosted opener: gateway method, run in-tx, inbox reference. If the gate is
/// closed or `#general` is not approved, no-op without writing the marker.
async fn enqueue_hosted_welcome_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    target: &WelcomeTarget,
    hosted_delivery_enabled: bool,
) -> Result<(), DbError> {
    let Some(connection_id) = target.hosted_active_connection_id else {
        return Ok(());
    };
    if !hosted_delivery_enabled || !target.hosted_channel_approved {
        return Ok(());
    }
    let trigger = RunTrigger::Welcome {
        workspace_id,
        member_id,
        agent_member_id: target.agent_member_id,
        channel_id: target.channel_id,
        kind: WelcomeKind::Opener,
    };
    let idempotency_key = trigger.idempotency_key();
    let input = welcome_run_input(
        workspace_id,
        member_id,
        target.agent_member_id,
        target.channel_id,
        WelcomeKind::Opener,
        &target.prompt,
        &idempotency_key,
    );
    let created = create_agent_run_in_tx(
        &mut *conn,
        workspace_id,
        NewAgentRun {
            channel_id: target.channel_id,
            trigger,
            parent_run_id: None,
            max_steps: target.max_run_steps,
            depth: 0,
            input,
        },
    )
    .await?;
    if !created.created {
        return Ok(());
    }
    let payload = welcome_job_payload(
        workspace_id,
        member_id,
        target,
        WelcomeKind::Opener,
        MENTION_JOB_METHOD_GATEWAY,
        Utc::now().timestamp_millis(),
        Some(created.id),
    );
    let job_outbox_id = momo_outbox::emit_outbox(
        &mut *conn,
        workspace_id,
        momo_outbox::OutboxKind::AgentJob,
        MENTION_JOB_METHOD_GATEWAY,
        &payload,
        Some(target.agent_member_id),
    )
    .await?;
    if momo_messaging::append_job_reference_in_tx(
        &mut *conn,
        workspace_id,
        target.agent_member_id,
        connection_id,
        target.channel_id,
        job_outbox_id,
        created.id,
    )
    .await?
    .is_none()
    {
        return Err(DbError::from(momo_db::sqlx::Error::Protocol(
            "hosted welcome inbox refused".into(),
        )));
    }
    write_welcome_queued_audit(conn, workspace_id, member_id, target, job_outbox_id).await
}

async fn emit_welcome_job(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    target: &WelcomeTarget,
    method: &str,
    payload: serde_json::Value,
) -> Result<(), DbError> {
    let job_outbox_id = momo_outbox::emit_outbox(
        &mut *conn,
        workspace_id,
        momo_outbox::OutboxKind::AgentJob,
        method,
        &payload,
        Some(target.agent_member_id),
    )
    .await?;
    write_welcome_queued_audit(conn, workspace_id, member_id, target, job_outbox_id).await
}

async fn write_welcome_queued_audit(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    target: &WelcomeTarget,
    job_outbox_id: i64,
) -> Result<(), DbError> {
    write_audit(
        conn,
        &AuditEntry::new(workspace_id, WELCOME_AUDIT_QUEUED)
            .by(member_id)
            .about(target.agent_member_id)
            .with_schema(
                WELCOME_AUDIT_SCHEMA,
                json!({
                    "kind": WelcomeKind::Opener.as_key(),
                    "channel_id": target.channel_id,
                    "agent_member_id": target.agent_member_id,
                    "job_outbox_id": job_outbox_id,
                }),
            ),
    )
    .await?;
    Ok(())
}
