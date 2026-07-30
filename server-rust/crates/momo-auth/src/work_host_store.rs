//! The `work_host` table — the durable WorkHost credential registry (ADR-0125
//! D1/D8), added in B2.2 so a route layer can mount `WorkHostRoutes.swift`.
//!
//! ## Why this lives in `momo-auth`
//!
//! A `work_host` row **is** a credential: `public_key` is the Ed25519 key every
//! signed host request is verified against and `revoked_at` is its kill switch.
//! That is the same shape as [`crate::token_store`], which owns the `token` rows
//! behind the App JWT — so the two credential stores sit side by side and the
//! crate keeps its stated remit (the two credential surfaces the server
//! authenticates). Putting host-registry SQL in a route module would have split
//! a credential's lifetime across two layers; putting it in `momo-t3` would have
//! claimed that a host is a T3 concept, which it is not (T1/T2 hosts are the
//! same table).
//!
//! Ports Swift `Routes/WorkHostRoutes.swift`:
//! `register` :143-154 · `list` :203-211 · `revoke` :477-502 ·
//! `heartbeat` :231-268 · `loadHost` :695-712 · `hostJSONSelect` :670-693.
//!
//! Like `token_store`, every function takes a caller-supplied `&mut
//! PgConnection`: the RLS GUC seam stays solely in `momo_db::with_tenant_tx`
//! (invariant #6), so a row is only ever visible inside its own workspace.
//!
//! Timestamps are returned as epoch milliseconds computed **in SQL**
//! (`floor(extract(epoch …) * 1000)::bigint`), byte-for-byte the Swift
//! `hostJSONSelect` projection — the wire contract's `…AtMs` fields are then a
//! copy, not a re-derivation that could round differently.

use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// `WorkHostRoutes.onlineWindowSeconds` (:89). A host is "online" when it is
/// unrevoked and heartbeated inside this window.
pub const ONLINE_WINDOW_SECONDS: i64 = 90;

/// One `work_host` row in the shape the wire DTO needs. `capabilities_json` is
/// the raw `jsonb::text`, decoded by the route that owns the DTO — exactly how
/// Swift moves it (`decodeHost`, :714-721).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkHostRecord {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub scope: String,
    pub owner_member_id: Uuid,
    pub host_type: String,
    pub display_name: String,
    pub public_key: String,
    pub capabilities_json: String,
    pub last_seen_at_ms: Option<i64>,
    pub revoked_at_ms: Option<i64>,
    pub created_at_ms: i64,
    pub online: bool,
}

/// What a caller must state to register a host. `capabilities_json` is a JSON
/// object of boolean flags, already validated at the REST boundary
/// (`validatedCapabilities`, :564-579) — the `work_host_capabilities_ck`
/// constraint (021:28-35) is the backstop.
#[derive(Debug, Clone)]
pub struct NewWorkHost {
    pub scope: String,
    pub owner_member_id: Uuid,
    pub host_type: String,
    pub display_name: String,
    pub public_key: String,
    pub capabilities_json: String,
    /// Stamp `last_seen_at` at insert time. The cloud-bootstrap registration
    /// does (`CloudProvisionerRoutes.swift:477-480`: the workd that just spent
    /// its token is by definition alive); the human registration does not
    /// (:145-151), because nothing has reported in yet.
    pub seen_now: bool,
}

/// Ownership/revocation state of a host, taken under `FOR UPDATE`
/// (Swift `revoke` :477-485).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkHostOwnership {
    pub owner_member_id: Uuid,
    pub already_revoked: bool,
}

/// The credential half of a host row, taken under `FOR UPDATE`
/// (Swift `heartbeat` :231-243).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkHostCredential {
    pub public_key: String,
    pub active: bool,
}

/// The `hostJSONSelect` column list, as typed columns rather than a JSON
/// document. Same expressions, same rounding.
const HOST_COLUMNS: &str = "h.id, \
     h.workspace_id, \
     h.scope, \
     h.owner_member_id, \
     h.type AS host_type, \
     h.display_name, \
     h.public_key, \
     h.capabilities::text AS capabilities_json, \
     CASE WHEN h.last_seen_at IS NULL THEN NULL \
          ELSE floor(extract(epoch from h.last_seen_at) * 1000)::bigint END \
       AS last_seen_at_ms, \
     CASE WHEN h.revoked_at IS NULL THEN NULL \
          ELSE floor(extract(epoch from h.revoked_at) * 1000)::bigint END \
       AS revoked_at_ms, \
     floor(extract(epoch from h.created_at) * 1000)::bigint AS created_at_ms, \
     (h.revoked_at IS NULL \
      AND COALESCE(h.last_seen_at >= clock_timestamp() \
                     - make_interval(secs => 90), false)) AS online";

fn decode_host(row: &sqlx::postgres::PgRow) -> Result<WorkHostRecord, sqlx::Error> {
    Ok(WorkHostRecord {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        scope: row.try_get("scope")?,
        owner_member_id: row.try_get("owner_member_id")?,
        host_type: row.try_get("host_type")?,
        display_name: row.try_get("display_name")?,
        public_key: row.try_get("public_key")?,
        capabilities_json: row.try_get("capabilities_json")?,
        last_seen_at_ms: row.try_get("last_seen_at_ms")?,
        revoked_at_ms: row.try_get("revoked_at_ms")?,
        created_at_ms: row.try_get("created_at_ms")?,
        online: row.try_get("online")?,
    })
}

/// Insert a host identity and return its id (Swift `register` :143-154).
pub async fn insert_work_host(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    new: &NewWorkHost,
) -> Result<Uuid, sqlx::Error> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO work_host \
           (workspace_id, scope, owner_member_id, type, display_name, \
            public_key, capabilities, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, \
                 CASE WHEN $8 THEN clock_timestamp() ELSE NULL END) \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(&new.scope)
    .bind(new.owner_member_id)
    .bind(&new.host_type)
    .bind(&new.display_name)
    .bind(&new.public_key)
    .bind(&new.capabilities_json)
    .bind(new.seen_now)
    .fetch_one(&mut *conn)
    .await?;
    Ok(id)
}

/// Re-read one host (Swift `loadHost` :695-712). RLS confines the lookup to the
/// transaction's workspace, so the id alone is a safe predicate — same as Swift.
pub async fn load_work_host(
    conn: &mut PgConnection,
    host_id: Uuid,
) -> Result<Option<WorkHostRecord>, sqlx::Error> {
    let sql = format!("SELECT {HOST_COLUMNS} FROM work_host h WHERE h.id = $1");
    let row = sqlx::query(&sql)
        .bind(host_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref().map(decode_host).transpose()
}

/// Every host in the workspace, oldest first (Swift `list` :203-210).
pub async fn list_work_hosts(conn: &mut PgConnection) -> Result<Vec<WorkHostRecord>, sqlx::Error> {
    let sql = format!("SELECT {HOST_COLUMNS} FROM work_host h ORDER BY h.created_at, h.id");
    let rows = sqlx::query(&sql).fetch_all(&mut *conn).await?;
    rows.iter().map(decode_host).collect()
}

/// Lock a host and report who owns it / whether it is already revoked
/// (Swift `revoke` :477-489).
pub async fn lock_work_host_ownership(
    conn: &mut PgConnection,
    host_id: Uuid,
) -> Result<Option<WorkHostOwnership>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT owner_member_id, revoked_at IS NOT NULL AS already_revoked \
           FROM work_host WHERE id = $1 FOR UPDATE",
    )
    .bind(host_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(WorkHostOwnership {
        owner_member_id: row.try_get("owner_member_id")?,
        already_revoked: row.try_get("already_revoked")?,
    }))
}

/// Revoke idempotently: the FIRST revocation timestamp is kept
/// (Swift `revoke` :495-502, `COALESCE(revoked_at, clock_timestamp())`).
pub async fn mark_work_host_revoked(
    conn: &mut PgConnection,
    host_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE work_host \
            SET revoked_at = COALESCE(revoked_at, clock_timestamp()) \
          WHERE id = $1",
    )
    .bind(host_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Lock the credential a heartbeat must be verified against
/// (Swift `heartbeat` :231-243).
///
/// The row lock is taken **before** the signature is checked, exactly like
/// Swift: a concurrent revoke must not be able to slip between "the key was
/// valid" and "last_seen_at was stamped".
pub async fn lock_work_host_credential(
    conn: &mut PgConnection,
    host_id: Uuid,
) -> Result<Option<WorkHostCredential>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT public_key, revoked_at IS NULL AS active \
           FROM work_host WHERE id = $1 FOR UPDATE",
    )
    .bind(host_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(WorkHostCredential {
        public_key: row.try_get("public_key")?,
        active: row.try_get("active")?,
    }))
}

/// Stamp liveness. `false` means the host was revoked in the meantime and the
/// caller must answer 401 (Swift `heartbeat` :256-268).
pub async fn touch_work_host_last_seen(
    conn: &mut PgConnection,
    host_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let updated: Option<Uuid> = sqlx::query_scalar(
        "UPDATE work_host \
            SET last_seen_at = clock_timestamp() \
          WHERE id = $1 AND revoked_at IS NULL \
        RETURNING id",
    )
    .bind(host_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(updated.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn online_window_matches_the_swift_constant() {
        assert_eq!(ONLINE_WINDOW_SECONDS, 90);
        assert!(
            HOST_COLUMNS.contains("make_interval(secs => 90)"),
            "the projection's window must be the same 90s the constant names"
        );
    }
}
