//! Thread following — `PUT` / `DELETE /v1/workspaces/{ws}/channels/{ch}/messages/{root}/follow`
//! (ADR-0206 증보 1 F8, #4889), the thread read signal `PUT …/messages/{root}/read`, and
//! `POST /v1/workspaces/{ws}/threads/read-all` (ADR-0124 증보 5, #5689).
//!
//! 「따라가기」 and 「그만 따라가기」 for the **caller**: the owner is the bearer, the request has no
//! body and no member id, and nothing is audited or rate-budgeted (a personal setting that changes
//! nothing anyone else sees). Nothing goes to anyone else either; since ADR-0124 증보 4 (#5667) a write
//! that changed the row puts one ids-only `followed_unread.updated` frame on the **caller's own**
//! personal channel, so their other devices re-read the channel's followed-thread total.
//! Both verbs are idempotent and answer `200 {following}` with the effective state after the write.
//!
//! The guard order is the one `GET …/replies` uses, so a caller cannot learn from a follow what they
//! could not learn from reading the thread: workspace scope (403) → live channel member (403, the same
//! bytes a missing channel gets) → the root (404 absent or in another channel, 400 for a reply) → a DM
//! channel (400 `thread_follow_not_applicable`) → the write. Every refusal comes before the first
//! write, which is what lets [`agent_tenant_tx`]'s `Ok(Err(_))` channel commit an empty transaction.
//!
//! Human bearer only: no agent scope opens this path (`required_agent_scope` has no entry for it) and
//! a developer token's closed route table does not list it; [`require_human`] keeps that true if either
//! door is ever widened.

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_agent::approval::is_active_human_member_in_tx;
use momo_auth::Principal;
use momo_messaging::{
    list_read_state_projection, mark_followed_threads_read_in_tx, mark_thread_read_in_tx,
    set_thread_follow_in_tx, FollowRefused, FollowedThreadsReadAll, ThreadReadState,
    ThreadRootInvalid, THREAD_READ_ALL_MAX_CHANNEL_IDS, THREAD_READ_ALL_MAX_THREADS,
};
use serde_json::Value;
use uuid::Uuid;

use crate::dto::{
    ReadStateRowDto, ThreadFollowDto, ThreadReadAllRequestDto, ThreadReadAllResponseDto,
    ThreadReadRequestDto, ThreadReadStateDto,
};
use crate::error::ApiError;
use crate::routes::read_state::read_state_row_dto;
use crate::routes::shared::{
    agent_tenant_tx, path_uuid, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

/// `PUT …/messages/{root}/follow` — follow the thread (`followed`), whatever the state was.
pub async fn follow(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<(String, String, String)>,
) -> Result<Json<ThreadFollowDto>, ApiError> {
    write(state, principal, path, true).await
}

/// `DELETE …/messages/{root}/follow` — stop following (`unfollowed`). The row stays: deleting it
/// would let the automatic follow make it again on the next reply.
pub async fn unfollow(
    state: State<AppState>,
    principal: Extension<Principal>,
    path: Path<(String, String, String)>,
) -> Result<Json<ThreadFollowDto>, ApiError> {
    write(state, principal, path, false).await
}

async fn write(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel, root)): Path<(String, String, String)>,
    follow: bool,
) -> Result<Json<ThreadFollowDto>, ApiError> {
    require_human(&principal, "thread follow requires a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let root_id = path_uuid(&root, "invalid thread root id")?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<bool> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            Ok(
                match set_thread_follow_in_tx(
                    conn,
                    workspace_id,
                    channel_id,
                    root_id,
                    member_id,
                    follow,
                )
                .await?
                {
                    Ok(following) => Ok(following),
                    Err(refused) => Err(refusal(refused)),
                },
            )
        })
    })
    .await;

    let following = settle_db("thread_follow.write", outcome)?;
    Ok(Json(ThreadFollowDto { following }))
}

/// `PUT …/messages/{root}/read` — 「여기까지 읽었어요」 (#4889 stage 2, owner 10-31 23:49): move the
/// caller's read position in the thread **forward** to `last_read_reply_seq` and answer with where it
/// now stands (`{following, last_read_reply_seq?, unread_reply_count?}`).
///
/// The same door as the follow verbs: human bearer only, the thread read's guard order (workspace scope
/// → live channel member, the same bytes for a channel that does not exist → the root), nothing
/// audited or rate-budgeted; when it moved the position of a thread the caller follows, one ids-only
/// `followed_unread.updated` frame goes to the caller's own personal channel (ADR-0124 증보 4, #5667).
/// It writes **no new row**: for a thread the caller does not
/// follow it changes nothing and answers `{following: false}` — a client may send it without knowing
/// whether it follows. A DM is the same no-op (there are no follow rows there). A negative position is
/// `400`.
pub async fn mark_read(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel, root)): Path<(String, String, String)>,
    Json(body): Json<ThreadReadRequestDto>,
) -> Result<Json<ThreadReadStateDto>, ApiError> {
    require_human(&principal, "thread read requires a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let root_id = path_uuid(&root, "invalid thread root id")?;
    if body.last_read_reply_seq < 0 {
        return Err(ApiError::bad_request(
            "last_read_reply_seq must be non-negative",
        ));
    }
    let member_id = principal.member_id;
    let requested = body.last_read_reply_seq;

    let outcome: DbRejectable<ThreadReadState> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(
                    match mark_thread_read_in_tx(
                        conn,
                        workspace_id,
                        channel_id,
                        root_id,
                        member_id,
                        requested,
                    )
                    .await?
                    {
                        Ok(read) => Ok(read),
                        Err(refused) => Err(refusal(refused)),
                    },
                )
            })
        })
        .await;

    let read = settle_db("thread_follow.read", outcome)?;
    Ok(Json(ThreadReadStateDto {
        following: read.following,
        last_read_reply_seq: read.last_read_reply_seq,
        unread_reply_count: read.unread_reply_count,
    }))
}

/// `POST /v1/workspaces/{ws}/threads/read-all` — 「모두 읽음」 for the threads the caller follows
/// (ADR-0124 증보 5, #5689): every followed thread with an unread reply has its read position moved to
/// its last reply, by the single read's statement, in one write transaction.
///
/// Body: a JSON **object** `{channel_ids?: uuid[] | null}` and nothing else. `{}` or
/// `{"channel_ids": null}` = every channel the caller is a live member of, `{"channel_ids": []}` =
/// none. Anything else is `400` before anything is read — an unknown key (`channelIds` is a typo, not
/// "all"), a body that is not an object (a bare `[]`), an id that is not a uuid, more than
/// [`THREAD_READ_ALL_MAX_CHANNEL_IDS`] distinct ids — because a position only moves forward and a
/// misread body must not become "mark everything read". A request with no JSON content type is `415`.
/// An id that is not such a channel — never was one, another workspace's, one the caller left, an
/// archived one — is **skipped without a word**: the answer is the one the request would get without
/// that id, so a caller cannot learn whether a channel exists from it.
///
/// Two transactions (security review r1 M1): the positions and their frames are written and
/// **committed first**, and only then are the changed channels' `GET read-state` lines read in a
/// second tenant transaction. A reply sent to one of those threads meanwhile waits on the follow row
/// only for the write, never for the read of the caller's whole projection (whose cost is the
/// caller's whole backlog). So the lines are the state just after the commit: a reply that landed in
/// between can already be counted, and the frame makes the client read again anyway.
///
/// Answer: those lines (a fully read channel's `followed_unread_reply_count` is `0`),
/// `marked_thread_count`, and `has_more` when more than [`THREAD_READ_ALL_MAX_THREADS`] threads were
/// waiting — call again. With `has_more: false` the same request again is
/// `{read_states: [], marked_thread_count: 0, has_more: false}` and sends nothing. One
/// `followed_unread.updated` frame per changed channel goes to the caller's own personal channel;
/// nobody else hears anything.
///
/// Human bearer only (an agent bearer has no scope for this path and [`require_human`] refuses it
/// again here; a developer token's closed table does not list it), then an active human workspace
/// member (the inbox read-all's check — there is no per-channel guard to do it). Per-member budget:
/// `RATE_LIMIT_THREAD_READ_ALL_PER_MEMBER`. Like reading one thread, nothing is audited and neither
/// the channel cursor nor the inbox changes.
pub async fn read_all(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    body: Result<Json<Value>, JsonRejection>,
) -> Result<Json<ThreadReadAllResponseDto>, ApiError> {
    require_human(&principal, "thread read requires a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channels = read_all_channels(body)?;
    let member_id = principal.member_id;

    // 1 — move the positions and write their frames, and commit.
    let written: DbRejectable<FollowedThreadsReadAll> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if !is_active_human_member_in_tx(conn, member_id).await? {
                    return Ok(Err(ApiError::forbidden(
                        "not an active human workspace member",
                    )));
                }
                Ok(Ok(mark_followed_threads_read_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    channels.as_deref(),
                    THREAD_READ_ALL_MAX_THREADS,
                )
                .await?))
            })
        })
        .await;
    let done = settle_db("thread_follow.read_all", written)?;

    // 2 — after the commit, the changed channels' read-state lines.
    let read_states = if done.changed_channels.is_empty() {
        Vec::new()
    } else {
        let changed = done.changed_channels.clone();
        let lines: DbRejectable<Vec<ReadStateRowDto>> =
            agent_tenant_tx(&state.pool, workspace_id, move |conn| {
                Box::pin(async move {
                    Ok(Ok(list_read_state_projection(
                        conn,
                        workspace_id,
                        member_id,
                    )
                    .await?
                    .iter()
                    .filter(|row| changed.contains(&row.state.channel_id))
                    .map(read_state_row_dto)
                    .collect()))
                })
            })
            .await;
        settle_db("thread_follow.read_all.lines", lines)?
    };

    Ok(Json(ThreadReadAllResponseDto {
        read_states,
        marked_thread_count: done.marked,
        has_more: done.has_more,
    }))
}

/// The read-all body, strictly (security review r1 M2): a JSON object whose only key is
/// `channel_ids`. `None` = every channel; `Some(ids)` = those (sorted, duplicates dropped, at most
/// [`THREAD_READ_ALL_MAX_CHANNEL_IDS`]). Every refusal is an [`ApiError`] (the `ErrorResponse` shape):
/// `415` without a JSON content type, `413` past the body limit, `400` for everything else.
fn read_all_channels(
    body: Result<Json<Value>, JsonRejection>,
) -> Result<Option<Vec<Uuid>>, ApiError> {
    let Json(value) = body.map_err(|rejection| match rejection {
        JsonRejection::MissingJsonContentType(_) => ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "the body must be JSON: send {} for every channel",
        ),
        other if other.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "the body is too large")
        }
        _ => ApiError::bad_request("the body is not valid JSON"),
    })?;
    if !value.is_object() {
        return Err(ApiError::bad_request(
            "the body must be a JSON object: {} or {\"channel_ids\": [...]}",
        ));
    }
    let request: ThreadReadAllRequestDto = serde_json::from_value(value).map_err(|_| {
        ApiError::bad_request("the body takes only channel_ids: an array of channel ids, or null")
    })?;
    let Some(mut ids) = request.channel_ids else {
        return Ok(None);
    };
    ids.sort_unstable();
    ids.dedup();
    if ids.len() > THREAD_READ_ALL_MAX_CHANNEL_IDS {
        return Err(ApiError::bad_request(format!(
            "channel_ids may name at most {THREAD_READ_ALL_MAX_CHANNEL_IDS} channels"
        )));
    }
    Ok(Some(ids))
}

fn refusal(refused: FollowRefused) -> ApiError {
    match refused {
        // The same sentence `GET …/replies` and `POST …/messages` use for a channel the caller is
        // not in — or one that does not exist.
        FollowRefused::NotAMember => ApiError::forbidden("not a member of this channel"),
        FollowRefused::Root(ThreadRootInvalid::NotFound) => {
            ApiError::not_found(ThreadRootInvalid::NotFound.to_string())
        }
        FollowRefused::Root(other) => ApiError::bad_request(other.to_string()),
        FollowRefused::NotApplicable => ApiError::coded(
            StatusCode::BAD_REQUEST,
            "thread_follow_not_applicable",
            "following a thread does not apply to a direct message",
        ),
    }
}
