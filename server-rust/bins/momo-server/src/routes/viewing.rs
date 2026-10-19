//! Presence heartbeat — `PUT /v1/workspaces/{ws}/channels/{ch}/viewing` (ADR-0204 증보 3, #4018).
//!
//! A client with a channel on screen beats here every ~15 s while the app is foregrounded.
//! The push judgment reads the stamp as "looking at this channel" for 30 s. Like the read
//! cursor, **the owner is the bearer**: the request carries no body and no member id.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Extension;
use momo_auth::Principal;
use momo_messaging::{touch_channel_viewing_in_tx, ViewingOutcome};

use crate::error::ApiError;
use crate::routes::shared::{agent_tenant_tx, path_uuid, settle_db, workspace_scope, DbRejectable};
use crate::AppState;

/// `204` when recorded; `403` when the caller is not a live member of the channel.
pub async fn touch(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;

    let outcome: DbRejectable<()> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            match touch_channel_viewing_in_tx(conn, workspace_id, channel_id, principal.member_id)
                .await?
            {
                ViewingOutcome::NotAMember => {
                    Ok(Err(ApiError::forbidden("not a member of this channel")))
                }
                ViewingOutcome::Recorded => Ok(Ok(())),
            }
        })
    })
    .await;

    settle_db("viewing.touch", outcome)?;
    Ok(StatusCode::NO_CONTENT)
}
