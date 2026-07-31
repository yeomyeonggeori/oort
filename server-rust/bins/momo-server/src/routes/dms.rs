//! Direct messages — discovery and idempotent creation (B1.2).
//!
//! Paths are the Swift paths verbatim (`DMRoutes.swift:25-26`):
//!   * `GET  /v1/workspaces/{ws}/dms`
//!   * `POST /v1/workspaces/{ws}/dms`  `{ "memberId": "…" }`
//!
//! This module owns **no SQL**: `momo_messaging::dm` holds every statement, and
//! the whole open — channel, `channel_seq`, both memberships — is one statement
//! inside one `with_tenant_tx`, so a half-created DM cannot exist. No outbox row
//! is written (opening a DM publishes nothing; the first *message* does), and
//! nothing here talks to Centrifugo.
//!
//! The four outcomes and why each is what it is:
//!   * **400** — a member DM-ing itself. A self-DM has no second participant, so
//!     the canonical pair key would collapse; refusing is clearer than inventing
//!     a one-member channel.
//!   * **403** — the caller is not an active member of `{ws}`.
//!   * **404** — the *target* is not an active member of `{ws}`. Distinct from
//!     403 so a client can tell "you may not" from "they are not here".
//!   * **201 / 200** — created now, or already existed. The split is the whole
//!     idempotency contract: a retry is a 200, never a second channel.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{
    active_workspace_role, list_direct_messages, open_direct_message_in_tx,
    validate_direct_message_target, DirectMessage, OpenedDirectMessage,
};

use crate::dto::{
    ChannelDto, OpenDirectMessageRequest, OpenDirectMessageResponse, WorkspaceChannelsResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{agent_tenant_tx, settle_db, workspace_scope, DbRejectable};
use crate::AppState;

/// Swift's 403 wording for a non-member of the workspace.
fn not_a_workspace_member() -> ApiError {
    ApiError::forbidden("not a workspace member")
}

fn channel_dto(channel: &DirectMessage) -> ChannelDto {
    ChannelDto {
        id: channel.id.to_string(),
        workspace_id: channel.workspace_id.to_string(),
        kind: channel.kind.as_db_label().to_string(),
        name: channel.name.clone(),
        topic: channel.topic.clone(),
        dm_key: Some(channel.dm_key.clone()),
        member_ids: Some(channel.member_ids.iter().map(|id| id.to_string()).collect()),
        created_by: channel.created_by.map(|id| id.to_string()),
        archived_at_ms: None,
        muted: channel.muted,
    }
}

/// `GET /v1/workspaces/{ws}/dms` — the caller's live DM channels, newest first.
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<WorkspaceChannelsResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;

    let outcome: DbRejectable<Vec<DirectMessage>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, principal.member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(not_a_workspace_member()));
                }
                let channels =
                    list_direct_messages(conn, workspace_id, principal.member_id).await?;
                Ok(Ok(channels))
            })
        })
        .await;

    let channels = settle_db("dms.list", outcome)?;
    Ok(Json(WorkspaceChannelsResponse {
        channels: channels.iter().map(channel_dto).collect(),
    }))
}

/// `POST /v1/workspaces/{ws}/dms` — open (or find) the 1:1 DM with `memberId`.
pub async fn open(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<OpenDirectMessageRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let target_id = request.member_id;
    validate_direct_message_target(principal.member_id, target_id)
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;

    // Authorization and the write share one transaction, like Swift's
    // `withTenantTransaction` block: a caller removed from the workspace
    // mid-flight cannot still open a DM inside it.
    let outcome: DbRejectable<(DirectMessage, bool)> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, principal.member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(not_a_workspace_member()));
                }
                match open_direct_message_in_tx(conn, workspace_id, principal.member_id, target_id)
                    .await?
                {
                    OpenedDirectMessage::TargetNotFound => Ok(Err(ApiError::not_found(
                        "active workspace member not found",
                    ))),
                    OpenedDirectMessage::Opened { channel, created } => Ok(Ok((channel, created))),
                }
            })
        })
        .await;

    let (channel, created) = settle_db("dms.open", outcome)?;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((
        status,
        Json(OpenDirectMessageResponse {
            channel: channel_dto(&channel),
            created,
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_messaging::ChannelKind;
    use uuid::Uuid;

    fn direct_message() -> DirectMessage {
        DirectMessage {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            kind: ChannelKind::Dm,
            name: None,
            topic: None,
            dm_key: "deadbeef".into(),
            member_ids: vec![Uuid::from_u128(3), Uuid::from_u128(4)],
            created_by: Some(Uuid::from_u128(3)),
            muted: false,
        }
    }

    /// A DM has no name/topic, and Swift omits null optionals. A client reading
    /// `name` as a required string would break on an emitted `null`.
    #[test]
    fn a_dm_channel_omits_its_null_fields() {
        let json = serde_json::to_value(channel_dto(&direct_message())).expect("serialize");
        assert_eq!(json["kind"], "dm");
        assert_eq!(json["dmKey"], "deadbeef");
        assert_eq!(json["memberIds"].as_array().expect("array").len(), 2);
        assert_eq!(json["muted"], false);
        assert!(json.get("name").is_none(), "{json}");
        assert!(json.get("topic").is_none(), "{json}");
        assert!(
            json.get("archivedAtMs").is_none(),
            "the DM surface never returns an archived channel: {json}"
        );
    }

    #[test]
    fn the_request_accepts_both_key_spellings() {
        let camel: OpenDirectMessageRequest =
            serde_json::from_value(serde_json::json!({"memberId": Uuid::from_u128(9)}))
                .expect("camelCase");
        let snake: OpenDirectMessageRequest =
            serde_json::from_value(serde_json::json!({"member_id": Uuid::from_u128(9)}))
                .expect("snake_case");
        assert_eq!(camel.member_id, snake.member_id);
    }

    #[test]
    fn a_self_dm_is_refused_before_any_db_access() {
        let member = Uuid::from_u128(5);
        let error = validate_direct_message_target(member, member)
            .map_err(|invalid| ApiError::bad_request(invalid.to_string()))
            .expect_err("self DM");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert!(
            error.message.contains("another member"),
            "{}",
            error.message
        );
    }
}
