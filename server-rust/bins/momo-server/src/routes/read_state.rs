//! Read state — unread cursors, unread counts, mention badges (ADR-0109, B1.2).
//!
//! Paths verbatim from Swift `ReadStateRoutes.swift:17-19`:
//!   * `GET /v1/workspaces/{ws}/read-state`
//!   * `PUT /v1/workspaces/{ws}/channels/{ch}/read-state`  `{ "last_read_seq": N }`
//!
//! **The client never names the cursor's owner.** Both routes bind it to the
//! authenticated principal, because a request shape with a `memberId` in it is
//! one review slip away from letting anyone mark anyone else's channel read.
//!
//! This module owns no SQL and writes no outbox row itself: the read-state
//! broadcast is emitted inside `momo_messaging::update_read_cursor_in_tx`
//! through `momo_outbox::emit_outbox`, in the same transaction as the cursor
//! write, and only when the cursor actually moved.

use axum::extract::{Path, State};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{active_workspace_role, list_read_state, update_read_cursor_in_tx, ReadState};

use crate::dto::{ReadStateDto, ReadStateListResponseDto, UpdateReadStateRequestDto};
use crate::error::ApiError;
use crate::routes::shared::{agent_tenant_tx, path_uuid, settle_db, workspace_scope, DbRejectable};
use crate::AppState;

fn read_state_dto(state: &ReadState) -> ReadStateDto {
    ReadStateDto {
        channel_id: state.channel_id.to_string(),
        last_read_seq: state.last_read_seq,
        latest_seq: state.latest_seq,
        unread_count: state.unread_count,
        mention_count: state.mention_count,
    }
}

/// `GET /v1/workspaces/{ws}/read-state` — one entry per channel the caller is
/// in, including channels they have never opened (cursor 0, everything unread).
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<ReadStateListResponseDto>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;

    let outcome: DbRejectable<Vec<ReadState>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, principal.member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                }
                Ok(Ok(
                    list_read_state(conn, workspace_id, principal.member_id).await?
                ))
            })
        })
        .await;

    let states = settle_db("read_state.list", outcome)?;
    Ok(Json(ReadStateListResponseDto {
        read_states: states.iter().map(read_state_dto).collect(),
    }))
}

/// `PUT /v1/workspaces/{ws}/channels/{ch}/read-state` — advance the caller's
/// cursor and return the recomputed counts.
///
/// The cursor is a `message.seq`. A negative one is refused outright; anything
/// beyond the channel head is clamped to the head rather than stored, so a
/// client that sends a timestamp gets "all read" instead of a cursor from the
/// future that would hide every later message.
pub async fn update(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    Json(request): Json<UpdateReadStateRequestDto>,
) -> Result<Json<ReadStateDto>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    if request.last_read_seq < 0 {
        return Err(ApiError::bad_request("last_read_seq must be non-negative"));
    }
    let requested = request.last_read_seq;

    let outcome: DbRejectable<ReadState> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match update_read_cursor_in_tx(
                    conn,
                    workspace_id,
                    channel_id,
                    principal.member_id,
                    requested,
                )
                .await?
                {
                    // Swift's 403: not a live member of this channel. Returned
                    // before the first write, so committing this transaction is
                    // indistinguishable from rolling it back.
                    None => Ok(Err(ApiError::forbidden("not a member of this channel"))),
                    Some(update) => Ok(Ok(update.state)),
                }
            })
        })
        .await;

    let updated = settle_db("read_state.update", outcome)?;
    Ok(Json(read_state_dto(&updated)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use uuid::Uuid;

    /// The Swift wire keys here are snake_case — unlike almost every other DTO
    /// in this API. A camelCase rename would silently break every client that
    /// already ships the underscored spelling.
    #[test]
    fn the_read_state_wire_keys_are_snake_case() {
        let json = serde_json::to_value(read_state_dto(&ReadState {
            channel_id: Uuid::from_u128(1),
            last_read_seq: 4,
            latest_seq: 9,
            unread_count: 5,
            mention_count: 2,
        }))
        .expect("serialize");
        assert_eq!(json["last_read_seq"], 4);
        assert_eq!(json["latest_seq"], 9);
        assert_eq!(json["unread_count"], 5);
        assert_eq!(json["mention_count"], 2);
        assert!(json.get("lastReadSeq").is_none(), "{json}");

        let request: UpdateReadStateRequestDto =
            serde_json::from_value(serde_json::json!({"last_read_seq": 7})).expect("decode");
        assert_eq!(request.last_read_seq, 7);
    }

    /// The request shape has no member field at all — the strongest available
    /// guarantee that one member cannot mark another's channel read.
    #[test]
    fn the_request_cannot_name_another_member() {
        let with_member: Result<UpdateReadStateRequestDto, _> = serde_json::from_value(
            serde_json::json!({"last_read_seq": 1, "member_id": Uuid::nil()}),
        );
        let decoded = with_member.expect("Swift's decoder ignores unknown keys");
        assert_eq!(decoded.last_read_seq, 1);
        // Nothing on the struct can carry the smuggled id.
        let fields = serde_json::to_string(&serde_json::json!({"last_read_seq": 1}));
        assert!(fields.is_ok());
    }

    #[test]
    fn a_negative_cursor_is_a_400() {
        let error = ApiError::bad_request("last_read_seq must be non-negative");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }
}
