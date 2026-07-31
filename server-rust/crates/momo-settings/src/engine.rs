//! `work_host_engine` — the per-workspace code-execution engine selection
//! (migration 040, MOMO-582 / ADR-0114 증보1 B).
//!
//! Port of Swift `Provider/WorkHostEngineStore.swift` + the validation half of
//! `Routes/WorkHostEngineRoutes.swift`.
//!
//! Unlike `provider_link`, this table is **per-workspace under the uniform
//! `app.workspace_id` policy**, so every statement here runs inside a plain
//! `momo_db::with_tenant_tx` — no operator GUC involved.
//!
//! ADR-0004: the row carries an engine LABEL and nothing else. There is no
//! column, and no request field, that could hold a provider key, an OAuth token,
//! or a host-local path.

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

/// The labels migration 040's CHECK constraint accepts (Swift :33). These must
/// stay in lockstep with the migration **and** with the daemon's `WorkEngine`.
pub const ALLOWED_ENGINES: [&str; 3] = ["opencode", "goose", "codex-local"];

/// Boot default (Swift :36 / `WorkEngine.default`): an absent row resolves to
/// opencode **without any write**, which is why a GET on a fresh workspace
/// reports `source: "default"` rather than creating a row.
pub const DEFAULT_ENGINE: &str = "opencode";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredWorkHostEngine {
    pub engine: String,
    pub updated_by_member_id: Option<Uuid>,
    pub updated_at_ms: i64,
}

/// Validate a requested label against the CHECK set (Swift `validatedEngine`
/// :110-119). An unknown value must be a 400 here, never a 500 surfaced from the
/// database constraint.
pub fn validated_engine(raw: &str) -> Option<&'static str> {
    let trimmed = raw.trim();
    ALLOWED_ENGINES
        .iter()
        .find(|engine| **engine == trimmed)
        .copied()
}

/// Read the workspace's row, or `None` when it has never chosen an engine.
pub async fn read_work_host_engine(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Option<StoredWorkHostEngine>, DbError> {
    let row: Option<(String, Option<Uuid>, i64)> = sqlx::query_as(
        "SELECT engine, \
                updated_by, \
                floor(extract(epoch from updated_at) * 1000)::bigint \
           FROM work_host_engine \
          WHERE workspace_id = $1 \
          LIMIT 1",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(
        row.map(|(engine, updated_by, updated_at_ms)| StoredWorkHostEngine {
            engine,
            updated_by_member_id: updated_by,
            updated_at_ms,
        }),
    )
}

/// Upsert the workspace's engine. `updated_at` advances monotonically so a
/// same-millisecond re-save still moves the value a polling GUI compares on.
pub async fn upsert_work_host_engine(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    engine: &str,
    updated_by: Uuid,
) -> Result<StoredWorkHostEngine, DbError> {
    let (engine, updated_by, updated_at_ms): (String, Option<Uuid>, i64) = sqlx::query_as(
        "INSERT INTO work_host_engine (workspace_id, engine, updated_by, updated_at) \
         VALUES ($1, $2, $3, now()) \
         ON CONFLICT (workspace_id) DO UPDATE \
           SET engine = EXCLUDED.engine, \
               updated_by = EXCLUDED.updated_by, \
               updated_at = greatest( \
                 clock_timestamp(), \
                 work_host_engine.updated_at + interval '1 millisecond' \
               ) \
         RETURNING engine, \
                   updated_by, \
                   floor(extract(epoch from updated_at) * 1000)::bigint",
    )
    .bind(workspace_id)
    .bind(engine)
    .bind(updated_by)
    .fetch_one(&mut *conn)
    .await?;
    Ok(StoredWorkHostEngine {
        engine,
        updated_by_member_id: updated_by,
        updated_at_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_engine_set_is_migration_040s_check_set() {
        assert_eq!(ALLOWED_ENGINES, ["opencode", "goose", "codex-local"]);
        assert_eq!(DEFAULT_ENGINE, "opencode");
        assert_eq!(validated_engine("  goose  "), Some("goose"));
        assert_eq!(
            validated_engine("Goose"),
            None,
            "the CHECK is case-sensitive"
        );
        assert_eq!(validated_engine("claude-code"), None);
        assert_eq!(validated_engine(""), None);
    }
}
