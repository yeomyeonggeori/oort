//! What ends with a session (#2677, #3022).
//!
//! A sign-in's lineage (`token.session_id`, 088) is the unit everything a
//! device registered hangs off: its push registration (ADR-0120 D4) and its
//! signing key (ADR-0146 개정 2026-09-28 D-7). Every path that ends a lineage —
//! or every lineage of a member — calls ONE of the two functions here, inside
//! the transaction that revokes the tokens, so the session and everything
//! registered under it end in one commit. One call per path is the point: a
//! new "thing that lives as long as a session" is added here, not at seven
//! call sites.

use momo_auth::device_key::{
    revoke_member_device_keys_in_tx, revoke_session_device_keys_in_tx, DeviceKeyRevocationReason,
};
use momo_db::{DbError, PgConnection};
use momo_push::{invalidate_member_push_tokens_in_tx, invalidate_session_push_tokens_in_tx};
use uuid::Uuid;

/// One lineage ended (logout, unlinking a device, a refresh-token reuse).
pub(crate) async fn end_session_lineage_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    session_id: Uuid,
    reason: DeviceKeyRevocationReason,
) -> Result<(), DbError> {
    invalidate_session_push_tokens_in_tx(conn, workspace_id, member_id, session_id).await?;
    revoke_session_device_keys_in_tx(conn, workspace_id, member_id, session_id, reason)
        .await
        .map_err(DbError::from)?;
    Ok(())
}

/// Every session of the member ended (password change or reset, suspension,
/// removal, leaving the workspace).
pub(crate) async fn end_member_sessions_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<(), DbError> {
    invalidate_member_push_tokens_in_tx(conn, workspace_id, member_id).await?;
    revoke_member_device_keys_in_tx(conn, workspace_id, member_id)
        .await
        .map_err(DbError::from)?;
    Ok(())
}
