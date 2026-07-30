//! The **signed work-host request** credential path (MOMO-657 / migration 048),
//! ported from Swift `Auth/WorkHostAuthenticator.swift:29-125`.
//!
//! ## Why this is a second credential surface, not a variation of the heartbeat
//!
//! A heartbeat signs `momo.work_host.heartbeat.v1\n{ws}\n{host}\n{sentAtMs}` and
//! carries no request id: the ±5 minute skew window is the whole of its
//! freshness contract, and a replay inside that window can only re-stamp
//! `last_seen_at`. A host **request** signs
//! `momo.work_host.request.v2\n{METHOD}\n{path}\n{ws}\n{host}\n{sentAtMs}\n{bodyDigest}\n{requestID}`
//! — it binds the method, the path and the raw body hash, and it is replay-
//! protected by one-time consumption of `requestID`, because a request *acts*.
//! Migration 048 exists for exactly that consumption and says why in its header:
//! "Accepting v1 in parallel would keep the body-substitution and replay
//! vulnerability open."
//!
//! This module owns the two DB halves of that check and nothing else. The
//! cryptographic verdict is [`crate::workhost::verify_work_host_request`] (which
//! is itself a thin wrapper over the shared `momo-wire` format, so signer and
//! verifier cannot drift), and header parsing / path allow-listing is the route
//! layer's — the same split B2.2 used for the heartbeat.
//!
//! Both functions take a caller-supplied `&mut PgConnection`: the RLS GUC seam
//! stays solely in `momo_db::with_tenant_tx` (invariant #6), so a host row and a
//! replay row are only ever visible inside their own workspace.

use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// Replay-row retention (`048:22`, `clock_timestamp() + interval '10 minutes'`).
///
/// Ten minutes is longer than the five-minute signature skew window on purpose:
/// a row must outlive every signature that could still be presented, or the
/// barrier has a gap at its own edge. `work_host_request_retention_ck` (048:23)
/// enforces the relationship in the schema.
pub const REQUEST_REPLAY_RETENTION_MINUTES: i64 = 10;

/// The signing credential of a host that is still allowed to act.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkHostSigningCredential {
    /// Canonical base64 Ed25519 public key — the *stored* key, so a revoked or
    /// re-registered host cannot be verified against a key it once had.
    pub public_key: String,
    pub owner_member_id: Uuid,
}

/// Load the signing credential for a host request (`WorkHostAuthenticator`
/// :62-81).
///
/// The `member` join is authorization, not decoration: a host whose owner has
/// been deactivated or soft-deleted stops being able to act at all, without
/// anyone having to remember to revoke the host row too. `None` means "this
/// request is not authorized" for every reason at once — unknown host, revoked
/// host, dead owner — and the caller answers one indistinguishable 401.
pub async fn load_work_host_signing_credential(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
) -> Result<Option<WorkHostSigningCredential>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT h.public_key, h.owner_member_id \
           FROM work_host h \
           JOIN member owner \
             ON owner.id = h.owner_member_id \
            AND owner.workspace_id = h.workspace_id \
            AND owner.kind = 'human' \
            AND owner.status = 'active' \
            AND owner.deleted_at IS NULL \
          WHERE h.id = $1 \
            AND h.workspace_id = $2 \
            AND h.revoked_at IS NULL \
          LIMIT 1",
    )
    .bind(host_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(WorkHostSigningCredential {
        public_key: row.try_get("public_key")?,
        owner_member_id: row.try_get("owner_member_id")?,
    }))
}

/// Consume a request id exactly once (`WorkHostAuthenticator` :95-116).
///
/// `false` = this id has already been used, i.e. a replay, and the caller must
/// refuse. The atomicity is the `ON CONFLICT … DO NOTHING RETURNING`: two
/// concurrent presentations of the same signature both reach the insert and
/// exactly one gets a row back. A `SELECT` followed by an `INSERT` would leave
/// the window this primary key exists to close.
///
/// The expired-row prune runs first, in the same statement sequence, so the
/// table is bounded by use rather than by a timer that could stop running.
pub async fn consume_work_host_request_id(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
    request_id: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query(
        "DELETE FROM work_host_request \
          WHERE workspace_id = $1 AND expires_at <= clock_timestamp()",
    )
    .bind(workspace_id)
    .execute(&mut *conn)
    .await?;

    let consumed: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO work_host_request (workspace_id, request_id, host_id, expires_at) \
         VALUES ($1, $2, $3, clock_timestamp() + make_interval(mins => $4::int)) \
         ON CONFLICT (workspace_id, request_id) DO NOTHING \
         RETURNING request_id",
    )
    .bind(workspace_id)
    .bind(request_id)
    .bind(host_id)
    .bind(REQUEST_REPLAY_RETENTION_MINUTES as i32)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(consumed.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The schema's own CHECK (048:23) requires `expires_at > consumed_at +
    /// interval '5 minutes'`. A retention shortened to the skew window itself
    /// would fail that constraint at runtime — assert the relationship here so
    /// it fails in `cargo test` instead.
    #[test]
    fn replay_retention_outlives_the_signature_skew_window() {
        let skew_minutes = crate::workhost::HEARTBEAT_CLOCK_SKEW_MS / 60_000;
        assert_eq!(skew_minutes, 5, "±5 minutes, WorkHostRoutes :90");
        assert!(
            REQUEST_REPLAY_RETENTION_MINUTES > skew_minutes,
            "a replay row must outlive every signature that could still be presented \
             (work_host_request_retention_ck, 048:23)"
        );
    }
}
