//! Thread following — `PUT` / `DELETE /v1/workspaces/{ws}/channels/{ch}/messages/{root}/follow`
//! (ADR-0206 증보 1 F8, #4889).
//!
//! 「따라가기」 and 「그만 따라가기」 for the **caller**: the owner is the bearer, the request has no
//! body and no member id, and nothing is broadcast, audited or rate-budgeted (a personal setting that
//! changes nothing anyone else sees; other devices converge on their next read — ADR-0177's rule).
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
use momo_auth::Principal;
use momo_messaging::{
    mark_thread_read_in_tx, set_thread_follow_in_tx, FollowRefused, ThreadReadState,
    ThreadRootInvalid,
};

use crate::dto::{ThreadFollowDto, ThreadReadRequestDto, ThreadReadStateDto};
use crate::error::ApiError;
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
/// broadcast, audited or rate-budgeted. It writes **no new row**: for a thread the caller does not
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
