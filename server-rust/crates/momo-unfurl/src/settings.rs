//! Workspace on/off. Missing row = enabled (ADR-0170 D4).

use chrono::{DateTime, Utc};
use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnfurlSetting {
    pub enabled: bool,
    pub updated_at: Option<DateTime<Utc>>,
}

pub async fn load_setting_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<UnfurlSetting, DbError> {
    let row = sqlx::query(
        "SELECT enabled, updated_at FROM workspace_unfurl_setting WHERE workspace_id = $1",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(match row {
        Some(row) => UnfurlSetting {
            enabled: row.get("enabled"),
            updated_at: Some(row.get("updated_at")),
        },
        None => UnfurlSetting {
            enabled: true,
            updated_at: None,
        },
    })
}

pub async fn workspace_fetch_allowed(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<bool, DbError> {
    Ok(load_setting_in_tx(conn, workspace_id).await?.enabled)
}

pub async fn upsert_setting_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    enabled: bool,
    updated_by: Uuid,
) -> Result<UnfurlSetting, DbError> {
    let row = sqlx::query(
        "INSERT INTO workspace_unfurl_setting (workspace_id, enabled, updated_by, updated_at) \
         VALUES ($1, $2, $3, now()) \
         ON CONFLICT (workspace_id) DO UPDATE SET \
           enabled = EXCLUDED.enabled, \
           updated_by = EXCLUDED.updated_by, \
           updated_at = now() \
         RETURNING enabled, updated_at",
    )
    .bind(workspace_id)
    .bind(enabled)
    .bind(updated_by)
    .fetch_one(&mut *conn)
    .await?;
    Ok(UnfurlSetting {
        enabled: row.get("enabled"),
        updated_at: Some(row.get("updated_at")),
    })
}
