//! Liveness/readiness.
//!
//! `GET /healthz` (packet) and `GET /health` (the path the Swift server and every
//! verification script already use) share one handler. Both include a DB
//! round-trip: a server that cannot reach Postgres is not healthy, because
//! Postgres is the SoT (invariant #1).
//!
//! The ping goes through the pool's connection health check (`Connection::ping`),
//! not a hand-written `SELECT 1` — the route layer owns no SQL.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use momo_db::sqlx::Connection;

use crate::dto::HealthResponse;
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

    Ok(Json(HealthResponse {
        status: "ok",
        service: "momo-server",
        database: "ok",
    }))
}
