//! Declared presence status — the durable ③ surface of ADR-0160 (프레즌스 6b).
//!
//!   `GET /v1/workspaces/{ws}/presence`  — read the caller's own declared status
//!   `PUT /v1/workspaces/{ws}/presence`  — set it, single write path
//!
//! The availability(②) half is on the ephemeral rail
//! (`routes::ephemeral::availability`), and the connection(①) half is a
//! client-local fact that never reaches the server. This module owns only the
//! durable intent, changed **only** through REST→PG→`emit_outbox(Broadcast)`
//! →relay (invariant: single write path).
//!
//! **The client never names the status's owner.** Both routes bind it to the
//! authenticated principal — a request shape with a `memberId` in it is one
//! review slip from letting anyone set anyone else's status. `SetPresenceRequest`
//! carries only `status`, and `set_presence_status_in_tx` binds the actor.
//!
//! **Human only.** `require_human` guards both routes (프레즌스 사람 전용,
//! ADR-0160 D4); an agent bearer is refused a 403 before any read, exactly like
//! the typing surface. The read returns 404 for a member with no declared status
//! (an agent, or a soft-deleted row) rather than inventing `auto`.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{presence_status_for, set_presence_status_in_tx, PresenceStatus};

use crate::dto::{PresenceStatusResponse, SetPresenceRequest};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

/// Human-only, stated once. An agent's liveness is its `agent_run` (ADR-0160 D4).
const AGENTS_HAVE_NO_PRESENCE: &str =
    "presence is a human signal; an agent's liveness is its agent_run (ADR-0160)";

/// Parse the wire `status` into the sealed enum. A value the enum does not name
/// is a 400 with a sentence — the enum is the guard (ADR-0160 가드 4), and a
/// client learns which field was wrong rather than getting a serde reject.
fn parse_status(raw: &str) -> Result<PresenceStatus, ApiError> {
    PresenceStatus::from_db_label(raw)
        .ok_or_else(|| ApiError::bad_request("status must be one of: auto, away, dnd"))
}

/// `GET /v1/workspaces/{ws}/presence` — the caller's own durable declared status.
///
/// Availability and the effective dot are deliberately absent: the server does
/// not know whether the caller is connected, and the effective value is computed
/// at the render edge and never stored (ADR-0160 D3).
pub async fn get_presence(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<PresenceStatusResponse>, ApiError> {
    require_human(&principal, AGENTS_HAVE_NO_PRESENCE)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<PresenceStatus> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match presence_status_for(conn, member_id).await? {
                    Some(status) => Ok(Ok(status)),
                    // No declared status = not a live human member here. A 404
                    // (not a fabricated `auto`) so the client can tell "the
                    // server has no presence for me" from "I am set to auto".
                    None => Ok(Err(ApiError::not_found("no presence for this member"))),
                }
            })
        })
        .await;

    let status = settle_db("presence.get", outcome)?;
    Ok(Json(PresenceStatusResponse {
        status: status.as_db_label().to_string(),
    }))
}

/// `PUT /v1/workspaces/{ws}/presence` — set the caller's own declared status and
/// broadcast it to their co-members, in one transaction (single write path).
pub async fn set_presence(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<SetPresenceRequest>,
) -> Result<Json<PresenceStatusResponse>, ApiError> {
    require_human(&principal, AGENTS_HAVE_NO_PRESENCE)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let status = parse_status(&request.status)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<PresenceStatus> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match set_presence_status_in_tx(conn, workspace_id, member_id, status).await? {
                    Some(update) => Ok(Ok(update.status)),
                    // Matched no live human member row — returned before any
                    // broadcast, so committing is indistinguishable from a
                    // rollback.
                    None => Ok(Err(ApiError::forbidden("not a live member of this workspace"))),
                }
            })
        })
        .await;

    let status = settle_db("presence.set", outcome)?;
    Ok(Json(PresenceStatusResponse {
        status: status.as_db_label().to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    #[test]
    fn only_the_three_enum_labels_parse_and_the_rest_are_400() {
        assert_eq!(parse_status("auto").expect("auto"), PresenceStatus::Auto);
        assert_eq!(parse_status("away").expect("away"), PresenceStatus::Away);
        assert_eq!(parse_status("dnd").expect("dnd"), PresenceStatus::Dnd);
        // `active` is a lifecycle label, `online` is an effective value neither
        // of which this durable field stores.
        for bad in ["active", "online", "offline", "busy", ""] {
            assert_eq!(
                parse_status(bad).expect_err("rejected").status,
                StatusCode::BAD_REQUEST,
                "{bad} must not parse as a declared status"
            );
        }
    }
}
