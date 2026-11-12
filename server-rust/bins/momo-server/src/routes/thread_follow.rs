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

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_agent::approval::is_active_human_member_in_tx;
use momo_auth::Principal;
use momo_messaging::{
    list_read_state_projection, mark_followed_threads_read_in_tx, mark_thread_read_in_tx,
    set_thread_follow_in_tx, FollowRefused, ThreadReadState, ThreadRootInvalid,
    THREAD_READ_ALL_MAX_CHANNEL_IDS, THREAD_READ_ALL_MAX_THREADS,
};

use crate::dto::{
    ThreadFollowDto, ThreadReadAllRequestDto, ThreadReadAllResponseDto, ThreadReadRequestDto,
    ThreadReadStateDto,
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
/// its last reply, by the single read's statement, in one transaction.
///
/// Body `{channel_ids?: uuid[]}`: absent or `null` = every channel the caller is a live member of,
/// `[]` = none. An id that is not such a channel — never was one, another workspace's, one the caller
/// left, an archived one — is **skipped without a word**: the answer is the one the request would get
/// without that id, so a caller cannot learn whether a channel exists from it. More than
/// [`THREAD_READ_ALL_MAX_CHANNEL_IDS`] ids is `400` before anything is read.
///
/// Answer: the `GET read-state` lines of the channels that changed (read after the write, so a fully
/// read channel's `followed_unread_reply_count` is `0`), `marked_thread_count`, and `has_more` when
/// more than [`THREAD_READ_ALL_MAX_THREADS`] threads were waiting — call again. With `has_more: false`
/// the same request again is `{read_states: [], marked_thread_count: 0, has_more: false}` and sends
/// nothing. One `followed_unread.updated` frame per changed channel goes to the caller's own personal
/// channel; nobody else hears anything.
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
    Json(body): Json<ThreadReadAllRequestDto>,
) -> Result<Json<ThreadReadAllResponseDto>, ApiError> {
    require_human(&principal, "thread read requires a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channels = match body.channel_ids {
        None => None,
        Some(mut ids) => {
            if ids.len() > THREAD_READ_ALL_MAX_CHANNEL_IDS {
                return Err(ApiError::bad_request(format!(
                    "channel_ids may name at most {THREAD_READ_ALL_MAX_CHANNEL_IDS} channels"
                )));
            }
            ids.sort_unstable();
            ids.dedup();
            Some(ids)
        }
    };
    let member_id = principal.member_id;

    let outcome: DbRejectable<ThreadReadAllResponseDto> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if !is_active_human_member_in_tx(conn, member_id).await? {
                    return Ok(Err(ApiError::forbidden(
                        "not an active human workspace member",
                    )));
                }
                let done = mark_followed_threads_read_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    channels.as_deref(),
                    THREAD_READ_ALL_MAX_THREADS,
                )
                .await?;
                let read_states = if done.changed_channels.is_empty() {
                    Vec::new()
                } else {
                    list_read_state_projection(conn, workspace_id, member_id)
                        .await?
                        .iter()
                        .filter(|row| done.changed_channels.contains(&row.state.channel_id))
                        .map(read_state_row_dto)
                        .collect()
                };
                Ok(Ok(ThreadReadAllResponseDto {
                    read_states,
                    marked_thread_count: done.marked,
                    has_more: done.has_more,
                }))
            })
        })
        .await;

    Ok(Json(settle_db("thread_follow.read_all", outcome)?))
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
