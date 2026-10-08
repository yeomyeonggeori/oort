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

/// The one "online" definition lives in `momo_wire::work_host_online`
/// (ADR-0198 T4); re-exported so existing callers keep their path.
pub use momo_wire::{work_host_online_sql, ONLINE_WINDOW_SECONDS};

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

/// The `hostJSONSelect` column list, as typed columns rather than a JSON
/// document. Same expressions, same rounding.
fn host_columns() -> String {
    format!(
        "h.id, \
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
     {online} AS online",
        online = work_host_online_sql("h")
    )
}

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

/// [`insert_work_host`] under a caller-chosen id — the host id candidate a
/// root device key signed (`host_register`, ADR-0146 개정 D-8, #3022). `None`
/// when a host with that id already exists (in any workspace): a replayed
/// statement collides with the row it created, which is what makes the
/// statement single-use without a nonce ledger.
pub async fn insert_work_host_with_id(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
    new: &NewWorkHost,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO work_host \
           (id, workspace_id, scope, owner_member_id, type, display_name, \
            public_key, capabilities, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, \
                 CASE WHEN $9 THEN clock_timestamp() ELSE NULL END) \
         ON CONFLICT (id) DO NOTHING \
         RETURNING id",
    )
    .bind(host_id)
    .bind(workspace_id)
    .bind(&new.scope)
    .bind(new.owner_member_id)
    .bind(&new.host_type)
    .bind(&new.display_name)
    .bind(&new.public_key)
    .bind(&new.capabilities_json)
    .bind(new.seen_now)
    .fetch_optional(&mut *conn)
    .await
}

/// Re-read one host (Swift `loadHost` :695-712). RLS confines the lookup to the
/// transaction's workspace, so the id alone is a safe predicate — same as Swift.
pub async fn load_work_host(
    conn: &mut PgConnection,
    host_id: Uuid,
) -> Result<Option<WorkHostRecord>, sqlx::Error> {
    let sql = format!("SELECT {} FROM work_host h WHERE h.id = $1", host_columns());
    let row = sqlx::query(&sql)
        .bind(host_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref().map(decode_host).transpose()
}

/// Every host in the workspace, oldest first (Swift `list` :203-210).
pub async fn list_work_hosts(conn: &mut PgConnection) -> Result<Vec<WorkHostRecord>, sqlx::Error> {
    let sql = format!(
        "SELECT {} FROM work_host h ORDER BY h.created_at, h.id",
        host_columns()
    );
    let rows = sqlx::query(&sql).fetch_all(&mut *conn).await?;
    rows.iter().map(decode_host).collect()
}

/// Display names of the given members (RLS confines it to the transaction's
/// workspace). Only active members are returned, so a departed owner's name is
/// not shown. Used to name a host the viewer does not own (#3583).
pub async fn member_display_names(
    conn: &mut PgConnection,
    member_ids: &[Uuid],
) -> Result<std::collections::HashMap<Uuid, String>, sqlx::Error> {
    if member_ids.is_empty() {
        return Ok(Default::default());
    }
    let rows = sqlx::query(
        "SELECT id, display_name FROM member \
          WHERE id = ANY($1) AND status = 'active' AND deleted_at IS NULL",
    )
    .bind(member_ids)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| Ok((row.try_get("id")?, row.try_get("display_name")?)))
        .collect()
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
    // #3590: a revoked host announces nothing and offers no folder; drop what
    // it had issued in the same transaction (idempotent).
    sqlx::query("DELETE FROM work_host_folder WHERE host_id = $1")
        .bind(host_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Stamp liveness. `false` means the host was revoked in the meantime and the
/// caller must answer 401 (Swift `heartbeat` :256-268).
///
/// Since ADR-0188 D7 the heartbeat authenticates as a v2 signed request in its
/// own transaction (signature verified, request id consumed) before this runs,
/// so `revoked_at IS NULL` here is what keeps a revoke that lands in between
/// from being overwritten by a stamp.
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

/// One folder a host issued (ADR-0188 D6): an opaque id and the name to show.
/// Never a path — the table refuses one (`work_host_folder_name_ck`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkHostFolderRecord {
    pub folder_id: String,
    pub display_name: String,
    /// `project` (an owner-allowed folder) or `question` (the host-issued empty
    /// 「질문용 폴더」, at most one per host).
    pub kind: String,
}

/// Make `folders` exactly the set `host_id` has announced (#3590): rows the host
/// no longer lists go, the rest are upserted only when something changed (a
/// beat every 30 s that repeats itself writes nothing). A revoked host writes nothing, so
/// a revoke that lands between the heartbeat's authentication and this call
/// still wins. `false` = the host is revoked or gone.
pub async fn replace_work_host_folders(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
    folders: &[WorkHostFolderRecord],
) -> Result<bool, sqlx::Error> {
    let live: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM work_host WHERE id = $1 AND revoked_at IS NULL FOR UPDATE",
    )
    .bind(host_id)
    .fetch_optional(&mut *conn)
    .await?;
    if live.is_none() {
        return Ok(false);
    }
    let keep: Vec<&str> = folders.iter().map(|f| f.folder_id.as_str()).collect();
    sqlx::query("DELETE FROM work_host_folder WHERE host_id = $1 AND NOT (folder_id = ANY($2))")
        .bind(host_id)
        .bind(&keep)
        .execute(&mut *conn)
        .await?;
    // Project rows first, the question row last: a folder that stops being the
    // question folder while another becomes it must not meet the one-question
    // index mid-way.
    let ordered = folders
        .iter()
        .filter(|f| f.kind != "question")
        .chain(folders.iter().filter(|f| f.kind == "question"));
    for folder in ordered {
        sqlx::query(
            "INSERT INTO work_host_folder (workspace_id, host_id, folder_id, display_name, kind) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (host_id, folder_id) DO UPDATE \
                SET display_name = EXCLUDED.display_name, kind = EXCLUDED.kind, \
                    updated_at = now() \
              WHERE (work_host_folder.display_name, work_host_folder.kind) \
                    IS DISTINCT FROM (EXCLUDED.display_name, EXCLUDED.kind)",
        )
        .bind(workspace_id)
        .bind(host_id)
        .bind(&folder.folder_id)
        .bind(&folder.display_name)
        .bind(&folder.kind)
        .execute(&mut *conn)
        .await?;
    }
    Ok(true)
}

/// The folders of the given hosts, by host, in a stable order (project folders
/// by name, then the question folder). RLS confines it to the workspace.
pub async fn list_work_host_folders(
    conn: &mut PgConnection,
    host_ids: &[Uuid],
) -> Result<std::collections::HashMap<Uuid, Vec<WorkHostFolderRecord>>, sqlx::Error> {
    let mut by_host: std::collections::HashMap<Uuid, Vec<WorkHostFolderRecord>> =
        Default::default();
    if host_ids.is_empty() {
        return Ok(by_host);
    }
    let rows = sqlx::query(
        "SELECT host_id, folder_id, display_name, kind FROM work_host_folder \
          WHERE host_id = ANY($1) ORDER BY kind DESC, display_name, folder_id",
    )
    .bind(host_ids)
    .fetch_all(&mut *conn)
    .await?;
    for row in &rows {
        by_host
            .entry(row.try_get("host_id")?)
            .or_default()
            .push(WorkHostFolderRecord {
                folder_id: row.try_get("folder_id")?,
                display_name: row.try_get("display_name")?,
                kind: row.try_get("kind")?,
            });
    }
    Ok(by_host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn online_window_matches_the_swift_constant() {
        assert_eq!(ONLINE_WINDOW_SECONDS, 90);
        assert!(
            host_columns().contains(&work_host_online_sql("h")),
            "the work-hosts projection must embed the shared online expression"
        );
    }
}
