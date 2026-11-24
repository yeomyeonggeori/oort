//! ADR-0218 증보 13 §19 Y2.1 (#6069) — the standing grant that lets one agent register its own team
//! expressions without a card, on a person's app session only.
//!
//! | route | who |
//! |---|---|
//! | `PUT /v1/workspaces/{ws}/agents/{agent}/expression-grant` | an active human administrator (gives) |
//! | `DELETE …/expression-grant` | any administrator, the person who gave it, the agent's owner (revokes) |
//! | `GET …/expression-grant` | administrators and the agent's owner (reads, with what is left today and in 30 days) |
//! | `GET /v1/workspaces/{ws}/expression-grants` | administrators (every live grant) and owners (their agents' only) |
//!
//! Every route is closed to an agent bearer ([`require_human`]) and to anything but a person's **full**
//! app session ([`crate::auth::FullPersonSession`]): a developer token never carries the marker, the two
//! push tokens are refused at the door by their route lists, and the human MCP is another path. No route
//! here lets an agent propose, give or read a grant (Y2.1 「에이전트는 승인에 닿지 못한다」 · YT14).
//!
//! Giving one on the settings switch pins the agent's live connection read **now**; an agent with no live
//! connection cannot be granted (Y2.1 「연결 핀」).
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_expressions::self_register::{self, Via};
use momo_expressions::{Actor, Error};
use serde_json::Value;

use crate::auth::FullPersonSession;
use crate::error::ApiError;
use crate::routes::expressions::failure;
use crate::routes::shared::{path_uuid, require_human, workspace_scope};
use crate::AppState;

const HUMAN_ONLY: &str = "expression grants require a person's app session";

fn person(
    principal: &Principal,
    full: Option<Extension<FullPersonSession>>,
    workspace: &str,
) -> Result<Actor, ApiError> {
    require_human(principal, HUMAN_ONLY)?;
    if full.is_none() {
        return Err(ApiError::forbidden(HUMAN_ONLY));
    }
    Ok(Actor {
        workspace: workspace_scope(workspace, principal)?,
        member: principal.member_id,
    })
}

fn no_connection() -> ApiError {
    ApiError::coded(
        StatusCode::CONFLICT,
        "agent_connection_required",
        "the agent has no live connection to approve",
    )
}

/// `PUT /v1/workspaces/{ws}/agents/{agent}/expression-grant`
pub async fn put(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    full: Option<Extension<FullPersonSession>>,
    Path((workspace, agent)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let actor = person(&principal, full, &workspace)?;
    let agent = path_uuid(&agent, "invalid agent id")?;
    let outcome = momo_expressions::transaction(&state.pool, actor, move |conn| {
        Box::pin(async move {
            if !self_register::active_admin_in_tx(conn, actor.workspace, actor.member).await? {
                return Err(Error::Role);
            }
            let connection =
                momo_auth::active_hosted_connection_in_tx(conn, actor.workspace, agent).await?;
            let Some(connection) = connection else {
                return Ok(None);
            };
            self_register::give_in_tx(
                conn,
                actor.workspace,
                actor.member,
                agent,
                connection,
                Via::Settings,
            )
            .await
            .map(Some)
        })
    })
    .await
    .map_err(failure)?;
    outcome.map(Json).ok_or_else(no_connection)
}

/// `DELETE /v1/workspaces/{ws}/agents/{agent}/expression-grant`
pub async fn delete(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    full: Option<Extension<FullPersonSession>>,
    Path((workspace, agent)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let actor = person(&principal, full, &workspace)?;
    let agent = path_uuid(&agent, "invalid agent id")?;
    momo_expressions::transaction(&state.pool, actor, move |conn| {
        Box::pin(async move {
            self_register::revoke_in_tx(conn, actor.workspace, actor.member, agent).await
        })
    })
    .await
    .map(Json)
    .map_err(failure)
}

/// `GET /v1/workspaces/{ws}/agents/{agent}/expression-grant`
pub async fn get(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    full: Option<Extension<FullPersonSession>>,
    Path((workspace, agent)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let actor = person(&principal, full, &workspace)?;
    let agent = path_uuid(&agent, "invalid agent id")?;
    momo_expressions::transaction(&state.pool, actor, move |conn| {
        Box::pin(async move {
            self_register::read_in_tx(conn, actor.workspace, actor.member, agent).await
        })
    })
    .await
    .map(Json)
    .map_err(failure)
}

/// `GET /v1/workspaces/{ws}/expression-grants`
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    full: Option<Extension<FullPersonSession>>,
    Path(workspace): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let actor = person(&principal, full, &workspace)?;
    momo_expressions::transaction(&state.pool, actor, move |conn| {
        Box::pin(
            async move { self_register::list_in_tx(conn, actor.workspace, actor.member).await },
        )
    })
    .await
    .map(Json)
    .map_err(failure)
}
