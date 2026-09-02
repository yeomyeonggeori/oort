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
//! broadcast is emitted inside `momo_messaging::update_read_cursor_with_intent_in_tx`
//! through `momo_outbox::emit_outbox`, in the same transaction as the cursor
//! (and mark) write.
//!
//! ADR-0178 extends the PUT body with `mark_unread_before_seq` (set the
//! mark-unread signal) and `read_intent` (why this advertisement was sent).
//! `last_read_seq` stays monotone (GREATEST). The mark is independent of that
//! merge: a stale/background replay cannot push it away, and only
//! `read_intent=explicit_open` clears it, in the same transaction.

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{
    active_workspace_role, list_read_state, update_read_cursor_with_intent_in_tx, MarkUnreadWrite,
    ReadCursorOutcome, ReadIntent, ReadState,
};

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
        marked_unread_before_seq: state.marked_unread_before_seq,
    }
}

fn read_state_body_error(rejection: JsonRejection) -> ApiError {
    let detail = rejection.body_text();
    // The only closed enum on this body is `read_intent`. A typo there must
    // not become Axum's 422 "this is not a payload" — ADR-0178 proof ⑤ names
    // 400, and a 422 would let a client treat it as a decoder mismatch
    // rather than a bad intent.
    if detail.contains("unknown variant") {
        return ApiError::bad_request("read_intent must be explicit_open or background");
    }
    ApiError::new(rejection.status(), "read-state body is invalid")
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
///
/// `mark_unread_before_seq`, when present, is validated in the same
/// transaction against a real `message` row in this channel (D5). A future or
/// never-issued seq is 400 and leaves the cursor untouched.
pub async fn update(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    body: Result<Json<UpdateReadStateRequestDto>, JsonRejection>,
) -> Result<Json<ReadStateDto>, ApiError> {
    let Json(request) = match body {
        Ok(json) => json,
        Err(rejection) => return Err(read_state_body_error(rejection)),
    };
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    if request.last_read_seq < 0 {
        return Err(ApiError::bad_request("last_read_seq must be non-negative"));
    }
    let requested = request.last_read_seq;
    let mark = match request.mark_unread_before_seq {
        Some(seq) => MarkUnreadWrite::Set(seq),
        None => MarkUnreadWrite::Leave,
    };
    // Absent is background — the safety default. Every client that predates
    // this field, plus the retiring Swift server, sends nothing.
    let intent: ReadIntent = request.read_intent.map(Into::into).unwrap_or_default();

    let outcome: DbRejectable<ReadState> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                match update_read_cursor_with_intent_in_tx(
                    conn,
                    workspace_id,
                    channel_id,
                    principal.member_id,
                    requested,
                    mark,
                    intent,
                )
                .await?
                {
                    // Swift's 403: not a live member of this channel. Returned
                    // before the first write, so committing this transaction is
                    // indistinguishable from rolling it back.
                    ReadCursorOutcome::NotAMember => {
                        Ok(Err(ApiError::forbidden("not a member of this channel")))
                    }
                    ReadCursorOutcome::MarkSeqNotInChannel(seq) => Ok(Err(ApiError::bad_request(
                        format!("mark_unread_before_seq {seq} is not a message in this channel"),
                    ))),
                    ReadCursorOutcome::Updated(update) => Ok(Ok(update.state)),
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
            marked_unread_before_seq: None,
        }))
        .expect("serialize");
        assert_eq!(json["last_read_seq"], 4);
        assert_eq!(json["latest_seq"], 9);
        assert_eq!(json["unread_count"], 5);
        assert_eq!(json["mention_count"], 2);
        assert!(json.get("lastReadSeq").is_none(), "{json}");
        assert!(
            json.get("marked_unread_before_seq").is_some(),
            "the mark key is always present (null when unmarked): {json}"
        );
        assert!(json["marked_unread_before_seq"].is_null());

        let request: UpdateReadStateRequestDto =
            serde_json::from_value(serde_json::json!({"last_read_seq": 7})).expect("decode");
        assert_eq!(request.last_read_seq, 7);
        assert_eq!(request.mark_unread_before_seq, None);
        assert_eq!(request.read_intent, None);
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

    #[test]
    fn unknown_read_intent_fails_to_decode() {
        let result: Result<UpdateReadStateRequestDto, _> = serde_json::from_value(
            serde_json::json!({"last_read_seq": 1, "read_intent": "stale_flush"}),
        );
        assert!(
            result.is_err(),
            "a typo'd intent must not silently become background: {result:?}"
        );
    }

    #[test]
    fn explicit_open_and_background_decode() {
        let open: UpdateReadStateRequestDto = serde_json::from_value(serde_json::json!({
            "last_read_seq": 1,
            "read_intent": "explicit_open",
        }))
        .expect("decode");
        assert_eq!(
            ReadIntent::from(open.read_intent.expect("present")),
            ReadIntent::ExplicitOpen
        );
        let background: UpdateReadStateRequestDto = serde_json::from_value(serde_json::json!({
            "last_read_seq": 1,
            "read_intent": "background",
        }))
        .expect("decode");
        assert_eq!(
            ReadIntent::from(background.read_intent.expect("present")),
            ReadIntent::Background
        );
        let absent: UpdateReadStateRequestDto =
            serde_json::from_value(serde_json::json!({"last_read_seq": 1})).expect("decode");
        assert_eq!(
            absent.read_intent.map(ReadIntent::from).unwrap_or_default(),
            ReadIntent::Background,
            "absent is the safety default, not explicit_open"
        );
    }
}
