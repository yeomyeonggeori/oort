//! 1:1 「대화 나가기」 (ADR-0177 증보 2026-11-14 D14~D18, #5822) — the caller's own read floor.
//!
//! ```text
//! PUT /v1/workspaces/{ws}/channels/{ch}/dm-leave   { "seenSeq": <integer >= 0> }  → 204
//! ```
//!
//! There is no `DELETE`: the floor is never lowered through the API (D16, D19). **The owner is the
//! bearer** — no request names a member.
//!
//! One transaction, in this order (D16). The order is the contract; `tests/dm_leave_conformance_pg.rs`
//! moves each step and watches the matching proof go red.
//!
//! 0. Participant check (404 for anything that is not an unarchived DM the caller is live in —
//!    before any lock, so a probe learns nothing about a room it is not in).
//! 1. Lock the still-pending admission cards of the room (the order a vote takes them), then the
//!    `channel_seq` row, then the `membership` rows (the send path's order), and judge the D20
//!    scope: 409 `dm_leave_unavailable` outside it.
//!    A request whose floor would not move (a repeat, a late retransmit) stops after this step with
//!    `204` and changes nothing — it must not undo anything written after the leave.
//! 2. The caller's own things first ([`momo_messaging::clear_own_items_below_in_tx`]): schedules in
//!    this channel, and reminders / thread follows / inbox items below the new floor. Before step 4,
//!    because the reminder and follow rows are found through a `message` join the floor hides.
//! 3. A pending agent admission in the room is cancelled exactly as a rejection would
//!    ([`super::dm_agents::cancel_pending_admissions_in_tx`]).
//! 4. Raise `membership.history_from_seq` to `GREATEST(existing, LEAST(seenSeq, head) + 1)`.
//! 5. The read cursor to `floor − 1` with the explicit-open intent, so the unread count, the mention
//!    count and the mark-unread signal are settled together, and one read frame goes to the caller's
//!    own `user:read-state` channel.
//! 6. The closure watermark (`dm_closure`) to `floor − 1`, so a device on an older build hides the
//!    conversation too.
//! 7. Audit `dm.left` (who, which channel, the floor — no text, no counterpart name), only when the
//!    floor actually moved.
//!
//! No message is written: the `channel_seq` → `message` → outbox spine, `message.seq` order and
//! `client_msg_id` idempotency are untouched, and there is no new realtime event kind.
//!
//! Human-only twice over, like the closure route: the path is absent from
//! `momo_auth::required_agent_scope` (an agent bearer is 403 before routing), and [`require_human`]
//! runs first here.

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::{
    clear_own_items_below_in_tx, close_dm_in_tx, dm_leave_participant_in_tx,
    lock_and_classify_in_tx, next_history_floor, raise_history_floor_in_tx,
    update_read_cursor_with_intent_in_tx, DmLeaveClass, MarkUnreadWrite, ReadIntent, ScheduleActor,
};
use serde_json::json;

use crate::dto::PutDmClosureRequestDto;
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
    DbRejectable,
};
use crate::AppState;

const HUMAN_ONLY: &str = "dm leave requires a human bearer";
const NOT_FOUND: &str = "dm not found";
/// D16: a DM the caller is in, but not a person-to-person 1:1 (D20).
pub(crate) const UNAVAILABLE_CODE: &str = "dm_leave_unavailable";
const UNAVAILABLE: &str = "only a one-to-one conversation between two people can be left this way";
/// The audit action (ADR-0128 D5).
pub(crate) const AUDIT_ACTION: &str = "dm.left";

/// Every refusal of the body is a 400 with one message (the closure route's rule).
fn leave_body_error(_rejection: JsonRejection) -> ApiError {
    ApiError::bad_request("seenSeq must be a non-negative integer")
}

fn seen_seq_of(body: Result<Json<PutDmClosureRequestDto>, JsonRejection>) -> Result<i64, ApiError> {
    let Json(request) = body.map_err(leave_body_error)?;
    if request.seen_seq < 0 {
        return Err(ApiError::bad_request(
            "seenSeq must be a non-negative integer",
        ));
    }
    Ok(request.seen_seq)
}

/// `PUT /v1/workspaces/{ws}/channels/{ch}/dm-leave` — leave the 1:1, having seen up to `seenSeq`.
pub async fn put(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    body: Result<Json<PutDmClosureRequestDto>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let seen_seq = seen_seq_of(body)?;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let outcome: DbRejectable<()> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            // 0. participant
            if !dm_leave_participant_in_tx(conn, workspace_id, channel_id, member_id).await? {
                return Ok(Err(ApiError::not_found(NOT_FOUND)));
            }
            // 1. locks and scope
            super::dm_agents::lock_pending_admission_cards_in_tx(conn, workspace_id, channel_id)
                .await?;
            let (last_seq, existing) =
                match lock_and_classify_in_tx(conn, workspace_id, channel_id, member_id).await? {
                    DmLeaveClass::NotFound => return Ok(Err(ApiError::not_found(NOT_FOUND))),
                    DmLeaveClass::Unavailable => {
                        return Ok(Err(ApiError::coded(
                            StatusCode::CONFLICT,
                            UNAVAILABLE_CODE,
                            UNAVAILABLE,
                        )))
                    }
                    DmLeaveClass::Eligible { last_seq, floor } => (last_seq, floor),
                };
            let floor = next_history_floor(seen_seq, last_seq, existing);
            // A repeat, or a late retransmit whose floor does not move, changes nothing at all:
            // it must not cancel a schedule written after the leave, clear a newer mark-unread
            // signal or cancel a newer agent request (D16 「같은 요청 두 번은 결과가 같고」).
            if existing == Some(floor) {
                return Ok(Ok(()));
            }
            // 2. the caller's own things, while the messages they point at are still readable
            clear_own_items_below_in_tx(
                conn,
                workspace_id,
                channel_id,
                member_id,
                floor,
                ScheduleActor::Member {
                    member_id,
                    via_token_id,
                },
            )
            .await?;
            // 3. a pending agent admission in the room
            super::dm_agents::cancel_pending_admissions_in_tx(conn, workspace_id, channel_id)
                .await?;
            // 4. the floor
            let stored =
                raise_history_floor_in_tx(conn, workspace_id, channel_id, member_id, floor).await?;
            // 5. the read cursor (explicit open: the mark-unread signal is cleared with it)
            update_read_cursor_with_intent_in_tx(
                conn,
                workspace_id,
                channel_id,
                member_id,
                stored - 1,
                MarkUnreadWrite::Leave,
                ReadIntent::ExplicitOpen,
            )
            .await?;
            // 6. the closure watermark, for a device that does not know the floor yet
            close_dm_in_tx(conn, workspace_id, channel_id, member_id, stored - 1).await?;
            // 7. audit (only reached when the floor moved)
            write_audit(
                conn,
                &AuditEntry::new(workspace_id, AUDIT_ACTION)
                    .by(member_id)
                    .via_token(via_token_id)
                    .target("channel", channel_id)
                    .with_schema("momo.dm.left.v1", json!({ "history_from_seq": stored })),
            )
            .await?;
            Ok(Ok(()))
        })
    })
    .await;

    settle_db("dm_leave.put", outcome)?;
    Ok(StatusCode::NO_CONTENT)
}
