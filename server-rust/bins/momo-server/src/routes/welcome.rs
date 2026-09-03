//! Welcome kickoff enqueue — same-tx as a newly created human member
//! (ADR-0181 D2).
//!
//! Owns no SQL. Resolve + payload live in `momo_agent::welcome`; the run is
//! created by the worker so a missing provider can post `ProviderRequired`
//! without consuming the opener marker.

use chrono::Utc;
use momo_agent::{
    resolve_welcome_target_in_tx, welcome_job_payload, WelcomeKind, MENTION_JOB_METHOD_GATEWAY,
    MENTION_JOB_METHOD_WORKER, WELCOME_AUDIT_QUEUED, WELCOME_AUDIT_SCHEMA,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{DbError, PgConnection};
use serde_json::json;
use uuid::Uuid;

/// Insert the welcome job for a newly created human, or no-op when the
/// workspace has no one who can speak.
pub(crate) async fn enqueue_welcome_kickoff_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    gateway_enabled: bool,
) -> Result<(), DbError> {
    let Some(target) = resolve_welcome_target_in_tx(&mut *conn, workspace_id).await? else {
        return Ok(());
    };
    let delivery = if gateway_enabled {
        MENTION_JOB_METHOD_GATEWAY
    } else {
        MENTION_JOB_METHOD_WORKER
    };
    let payload = welcome_job_payload(
        workspace_id,
        member_id,
        &target,
        WelcomeKind::Opener,
        delivery,
        Utc::now().timestamp_millis(),
    );
    let method = if gateway_enabled {
        MENTION_JOB_METHOD_GATEWAY
    } else {
        MENTION_JOB_METHOD_WORKER
    };
    let job_outbox_id = momo_outbox::emit_outbox(
        &mut *conn,
        workspace_id,
        momo_outbox::OutboxKind::AgentJob,
        method,
        &payload,
        Some(target.agent_member_id),
    )
    .await?;
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
