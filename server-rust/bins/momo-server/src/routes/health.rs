//! Liveness/readiness.
//!
//! `GET /healthz` (packet) and `GET /health` (the path the Swift server and every
//! verification script already use) share one handler. Both include a DB
//! round-trip: a server that cannot reach Postgres is not healthy, because
//! Postgres is the SoT (invariant #1).
//!
//! The ping goes through the pool's connection health check (`Connection::ping`),
//! not a hand-written `SELECT 1`. The optional `schema` object reads the migrate
//! ledger (`schema_migrations.version` = filename) and carries no secrets.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use momo_db::sqlx::{self, Connection, Row};

use crate::dto::{HealthResponse, HealthSchema};
use crate::error::ApiError;
use crate::AppState;

pub async fn health(State(state): State<AppState>) -> Result<Json<HealthResponse>, ApiError> {
    let mut connection = state.pool.acquire().await.map_err(|error| {
        tracing::error!(error = %error, "health: pool acquire failed");
        ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "database unavailable")
    })?;
    connection.ping().await.map_err(|error| {
        tracing::error!(error = %error, "health: database ping failed");
        ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "database unavailable")
    })?;

    let schema = match sqlx::query(
        "SELECT count(*)::bigint AS applied, \
                COALESCE(max(version), '') AS head \
           FROM schema_migrations",
    )
    .fetch_one(&mut *connection)
    .await
    {
        Ok(row) => HealthSchema {
            applied: row.try_get::<i64, _>("applied").unwrap_or(0),
            head: row.try_get::<String, _>("head").unwrap_or_default(),
        },
        Err(error) => {
            tracing::debug!(error = %error, "health: schema_migrations unread");
            HealthSchema {
                applied: 0,
                head: String::new(),
            }
        }
    };

    Ok(Json(HealthResponse {
        status: "ok",
        service: "momo-server",
        database: "ok",
        schema,
    }))
}
