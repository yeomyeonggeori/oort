//! Scheduled messages — ADR-0208 / #4214.
//!
//! ```text
//! POST   /v1/workspaces/{ws}/channels/{ch}/scheduled-messages
//! GET    /v1/workspaces/{ws}/scheduled-messages?channelId=&status=open|pending|failed&cursor=&limit=
//! PATCH  /v1/workspaces/{ws}/scheduled-messages/{id}
//! DELETE /v1/workspaces/{ws}/scheduled-messages/{id}
//! POST   /v1/workspaces/{ws}/scheduled-messages/{id}/send-now
//! ```
//!
//! Human only, and the member id is the credential's, never the request's. The rows are
//! owner-scoped FORCE RLS: another member's schedule is not "forbidden", it is **absent** (404),
//! a workspace owner's included. The server keeps the message and sends it itself — see
//! [`crate::scheduler`] — so there is no client timer anywhere in this feature.
//!
//! **No SQL here.** Every statement is `momo_messaging::scheduled`'s; this module composes them
//! with the checks that need the rest of the server (membership, thread root, the canonical send)
//! and turns outcomes into the status codes of ADR-0208 appendix A.
//!
//! ## Refusals roll back, except the one that must commit
//!
//! A request's refusals travel as [`Refuse::Api`] through the transaction's **error** channel, so
//! whatever the request wrote before it noticed rolls back with it — a create that reserved two
//! attachments and then met a third that is taken leaves nothing behind. The single refusal that
//! must **commit** is `send-now`'s: the canonical send refused the message, the row becomes
//! `failed` with that reason, and the 409 is answered after the commit ([`SendNow::Refused`]).

use std::sync::atomic::Ordering;

use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Path, Query, Request, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, session_id_of, Principal};
use momo_db::{DbError, PgConnection};
use momo_messaging::{
    cancel_schedule_in_tx, clamp_schedule_list_limit, count_pending_in_tx, db_now_in_tx,
    edit_failed_body_in_tx, edit_pending_in_tx, find_schedule_by_request_in_tx,
    get_own_schedule_in_tx, insert_schedule_in_tx, is_channel_member, is_edit_locked,
    list_own_schedules_in_tx, lock_member_schedules_in_tx, lock_own_schedule_in_tx,
    mark_failed_in_tx, mark_sent_in_tx, rearm_failed_in_tx, record_created_in_tx,
    reserve_attachments_in_tx, reserved_attachment_ids_in_tx, schedule_attachments_in_tx,
    validate_send_at, validate_thread_root_in_tx, MessageAttachment, NewSchedule, ReserveRejected,
    ScheduleActor, ScheduleFailure, ScheduleListFilter, ScheduledMessage, ScheduledStatus,
    SendAtInvalid, SCHEDULE_PENDING_LIMIT,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::ApiError;
use crate::routes::deliver::DeliverGates;
use crate::routes::messages::{attachment_link_rejection, thread_root_rejection};
use crate::routes::shared::{
    audit_via_token_id, epoch_ms, futures_box::BoxFuture, path_uuid, require_human, workspace_scope,
};
use crate::scheduler::{deliver_schedule_in_tx, Delivery};
use crate::AppState;

const HUMAN_ONLY: &str = "scheduled messages require a human bearer";
const NOT_FOUND: &str = "scheduled message not found";
const NOT_CHANNEL_MEMBER: &str = "not a member of this channel";
const BAD_ID: &str = "invalid scheduled message id";

// ---------------------------------------------------------------------------
// the request/response shapes (openapi `ScheduledMessage*`)
// ---------------------------------------------------------------------------

/// `POST …/channels/{ch}/scheduled-messages`. **Closed**: `replyToId`, `routing`, `props`,
/// `type` and `signature` are not accepted (D1) and are a 400, not silently dropped.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateScheduledMessageRequest {
    #[serde(default)]
    pub body: Option<String>,
    pub send_at_ms: i64,
    #[serde(default)]
    pub root_id: Option<Uuid>,
    #[serde(default)]
    pub attachment_ids: Option<Vec<Uuid>>,
    pub client_request_id: Uuid,
}

/// `PATCH …/scheduled-messages/{id}` — at least one field.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateScheduledMessageRequest {
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub send_at_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListScheduledMessagesQuery {
    pub channel_id: Option<String>,
    pub status: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledMessageDto {
    pub id: String,
    pub workspace_id: String,
    pub member_id: String,
    pub channel_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
    /// Absent once the row is sent or cancelled: the sent message is the record.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<MessageAttachment>,
    pub send_at_ms: i64,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editable_until_ms: Option<i64>,
    pub rev: i32,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledMessageResponse {
    pub scheduled_message: ScheduledMessageDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledMessageListResponse {
    pub scheduled_messages: Vec<ScheduledMessageDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

pub fn schedule_dto(
    row: &ScheduledMessage,
    attachments: Vec<MessageAttachment>,
) -> ScheduledMessageDto {
    let open = matches!(
        row.status,
        ScheduledStatus::Pending | ScheduledStatus::Failed
    );
    ScheduledMessageDto {
        id: row.id.to_string(),
        workspace_id: row.workspace_id.to_string(),
        member_id: row.author_member_id.to_string(),
        channel_id: row.channel_id.to_string(),
        root_id: row.root_id.map(|id| id.to_string()),
        body: row.body.clone(),
        // A sent or cancelled row released its attachments.
        attachments: if open { attachments } else { Vec::new() },
        send_at_ms: row.send_at_ms(),
        status: row.status.as_db_label(),
        failure_reason: row.failure_reason.map(ScheduleFailure::as_code),
        sent_message_id: row.sent_message_id.map(|id| id.to_string()),
        sent_at_ms: row.sent_at.map(epoch_ms),
        editable_until_ms: (row.status == ScheduledStatus::Pending)
            .then(|| row.editable_until_ms()),
        rev: row.rev,
        created_at_ms: epoch_ms(row.created_at),
        updated_at_ms: epoch_ms(row.updated_at),
    }
}

// ---------------------------------------------------------------------------
// a JSON body whose rejections are 400s
// ---------------------------------------------------------------------------

/// `Json<T>`, except that a body the decoder refuses (an unknown key — the closed request —
/// a missing field, a malformed id) is **400**, as openapi appendix A says, not axum's 422.
/// The sentence is serde's own (`unknown field …`), which names the field and nothing the caller
/// did not send.
pub struct ClosedJson<T>(pub T);

impl<T, S> FromRequest<S> for ClosedJson<T>
where
    T: serde::de::DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(request, state).await {
            Ok(Json(value)) => Ok(ClosedJson(value)),
            Err(rejection) => Err(json_rejection(rejection)),
        }
    }
}

fn json_rejection(rejection: JsonRejection) -> ApiError {
    let status = match rejection.status() {
        StatusCode::UNPROCESSABLE_ENTITY => StatusCode::BAD_REQUEST,
        other => other,
    };
    ApiError::new(status, rejection.body_text())
}

// ---------------------------------------------------------------------------
// the transaction a request runs in
// ---------------------------------------------------------------------------

/// Why a request's transaction ended early.
#[derive(Debug)]
enum Refuse {
    /// A refusal with its answer decided. Rolls the transaction back.
    Api(ApiError),
    Db(DbError),
}

impl From<DbError> for Refuse {
    fn from(error: DbError) -> Self {
        Refuse::Db(error)
    }
}

impl From<momo_db::sqlx::Error> for Refuse {
    fn from(error: momo_db::sqlx::Error) -> Self {
        Refuse::Db(DbError::from(error))
    }
}

impl From<ApiError> for Refuse {
    fn from(error: ApiError) -> Self {
        Refuse::Api(error)
    }
}

/// A tenant transaction whose closure speaks [`Refuse`]. `with_tenant_tx_prelude` with empty
/// preludes rather than a second transaction opener, so `app.workspace_id` stays bound in exactly
/// one place (invariant #6).
async fn request_tx<T, F>(pool: &momo_db::PgPool, workspace_id: Uuid, body: F) -> Result<T, Refuse>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> BoxFuture<'c, Result<T, Refuse>> + Send,
{
    momo_db::with_tenant_tx_prelude(
        pool,
        workspace_id,
        |_conn| Box::pin(async move { Ok(()) }),
        |_conn| Box::pin(async move { Ok(()) }),
        body,
    )
    .await
}

/// A request that takes a row lock waits for the scheduler's at most 3 seconds (D9): then it is
/// a `409 scheduled_busy`, "try again", rather than a hang.
async fn bound_lock_wait(conn: &mut PgConnection) -> Result<(), DbError> {
    momo_db::sqlx::query("SELECT set_config('lock_timeout', '3s', true)")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

fn is_lock_timeout(error: &DbError) -> bool {
    matches!(
        error,
        DbError::Sqlx(momo_db::sqlx::Error::Database(db)) if db.code().as_deref() == Some("55P03")
    )
}

fn settle<T>(context: &str, outcome: Result<T, Refuse>) -> Result<T, ApiError> {
    match outcome {
        Ok(value) => Ok(value),
        Err(Refuse::Api(error)) => Err(error),
        Err(Refuse::Db(error)) if is_lock_timeout(&error) => Err(scheduled_busy()),
        Err(Refuse::Db(error)) => Err(ApiError::internal(context, error)),
    }
}

// ---------------------------------------------------------------------------
// the answers of appendix A
// ---------------------------------------------------------------------------

fn conflict(code: &'static str, message: &'static str) -> ApiError {
    ApiError::coded(StatusCode::CONFLICT, code, message)
}

fn scheduled_busy() -> ApiError {
    conflict(
        "scheduled_busy",
        "the scheduled message is being sent right now; try again in a moment",
    )
}

fn already_sent() -> ApiError {
    conflict(
        "scheduled_already_sent",
        "the scheduled message was already sent",
    )
}

fn scheduler_disabled() -> ApiError {
    ApiError::coded(
        StatusCode::SERVICE_UNAVAILABLE,
        "scheduler_disabled",
        "scheduled messages are turned off on this server",
    )
}

fn empty_message() -> ApiError {
    ApiError::coded(
        StatusCode::BAD_REQUEST,
        "empty_message",
        "a scheduled message needs text or an attachment",
    )
}

fn send_at_error(invalid: SendAtInvalid) -> ApiError {
    ApiError::coded(StatusCode::BAD_REQUEST, invalid.code(), invalid.to_string())
}

fn pending_limit_reached() -> ApiError {
    conflict(
        "pending_limit_reached",
        "at most 50 scheduled messages can wait at a time",
    )
}

fn reserve_error(rejected: ReserveRejected) -> ApiError {
    match rejected {
        ReserveRejected::Link(link) => attachment_link_rejection(link),
        ReserveRejected::Reserved => conflict(
            "attachment_reserved",
            "an attachment is held by another scheduled message",
        ),
    }
}

/// `send-now` refused by the canonical send: 409 whose `error.code` is the reason the row now
/// carries.
fn send_now_refusal(reason: ScheduleFailure) -> ApiError {
    let message = match reason {
        ScheduleFailure::AuthorInactive => "the author is not an active member",
        ScheduleFailure::NotMember => "not a member of this channel",
        ScheduleFailure::RootUnavailable => "the thread this message replies to is gone",
        ScheduleFailure::AttachmentUnavailable => "an attachment is missing or already used",
        ScheduleFailure::SendError => "the scheduled message id collides with another message",
        ScheduleFailure::SessionsEnded | ScheduleFailure::Missed | ScheduleFailure::NotAllowed => {
            "the server refused to send this message"
        }
    };
    ApiError::coded(StatusCode::CONFLICT, reason.as_code(), message)
}

/// 503 `scheduler_disabled` when the operator turned the scheduler off **or** the tick refused its
/// database role at boot (`scheduler::start`): either way nothing would send what is accepted.
fn require_enabled(state: &AppState) -> Result<(), ApiError> {
    if state.scheduler.enabled && !state.scheduler_blocked.load(Ordering::SeqCst) {
        Ok(())
    } else {
        Err(scheduler_disabled())
    }
}

async fn require_live_human(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<(), Refuse> {
    if active_workspace_role(conn, workspace_id, member_id)
        .await?
        .is_none()
    {
        return Err(Refuse::Api(ApiError::forbidden(
            "active human membership required",
        )));
    }
    Ok(())
}

/// The sign-in lineage that is writing this content (D14 `armed_session_id`). `None` for a
/// credential minted before migration 088 and for one the request has no token id for.
async fn requester_session(
    conn: &mut PgConnection,
    token_id: Option<Uuid>,
) -> Result<Option<Uuid>, Refuse> {
    match token_id {
        Some(token_id) => Ok(session_id_of(conn, token_id).await.map_err(DbError::from)?),
        None => Ok(None),
    }
}

async fn attachments_of(
    conn: &mut PgConnection,
    member_id: Uuid,
    row: &ScheduledMessage,
) -> Result<Vec<MessageAttachment>, Refuse> {
    let mut by_row = schedule_attachments_in_tx(conn, member_id, &[row.id]).await?;
    Ok(by_row.remove(&row.id).unwrap_or_default())
}

// ---------------------------------------------------------------------------
// POST …/channels/{ch}/scheduled-messages
// ---------------------------------------------------------------------------

/// Schedule a message. A known `clientRequestId` is answered **first**, with the stored row and no
/// further checking (D9), so a retry whose first answer was lost neither trips its own attachment
/// reservation nor the cap.
pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    ClosedJson(request): ClosedJson<CreateScheduledMessageRequest>,
) -> Result<(StatusCode, Json<ScheduledMessageResponse>), ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    require_enabled(&state)?;
    let member_id = principal.member_id;
    let token_id = principal.token_id;
    let actor = ScheduleActor::Member {
        member_id,
        via_token_id: audit_via_token_id(&principal),
    };

    let outcome = request_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            require_live_human(conn, workspace_id, member_id).await?;
            // Before the lookup, not only before the count: two concurrent retries of one create
            // must both reach the lookup *after* the first has committed (D10).
            lock_member_schedules_in_tx(conn, workspace_id, member_id).await?;
            if let Some(existing) = find_schedule_by_request_in_tx(
                conn,
                workspace_id,
                member_id,
                request.client_request_id,
            )
            .await?
            {
                let attachments = attachments_of(conn, member_id, &existing).await?;
                return Ok((existing, attachments));
            }

            let attachment_ids = request.attachment_ids.unwrap_or_default();
            let body = stored_body(&request.body.unwrap_or_default());
            if body.is_empty() && attachment_ids.is_empty() {
                return Err(Refuse::Api(empty_message()));
            }
            let now = db_now_in_tx(conn).await?;
            let send_at = validate_send_at(request.send_at_ms, now)
                .map_err(|invalid| Refuse::Api(send_at_error(invalid)))?;
            // The same membership and root judgments `POST …/messages` makes, in the same words.
            if !is_channel_member(conn, channel_id, member_id).await? {
                return Err(Refuse::Api(ApiError::forbidden(NOT_CHANNEL_MEMBER)));
            }
            if let Some(root_id) = request.root_id {
                if let Err(invalid) = validate_thread_root_in_tx(conn, channel_id, root_id).await? {
                    return Err(Refuse::Api(thread_root_rejection(invalid)));
                }
            }
            if count_pending_in_tx(conn, workspace_id, member_id).await? >= SCHEDULE_PENDING_LIMIT {
                return Err(Refuse::Api(pending_limit_reached()));
            }

            let armed_session_id = requester_session(conn, token_id).await?;
            let row = insert_schedule_in_tx(
                conn,
                &NewSchedule {
                    workspace_id,
                    channel_id,
                    author_member_id: member_id,
                    root_id: request.root_id,
                    body,
                    send_at,
                    client_request_id: request.client_request_id,
                    armed_session_id,
                },
            )
            .await?;
            if !attachment_ids.is_empty() {
                if let Err(rejected) = reserve_attachments_in_tx(
                    conn,
                    workspace_id,
                    channel_id,
                    member_id,
                    row.id,
                    &attachment_ids,
                )
                .await?
                {
                    // Rolls the row and every reservation made so far back with it.
                    return Err(Refuse::Api(reserve_error(rejected)));
                }
            }
            record_created_in_tx(conn, &row, actor).await?;
            let attachments = attachments_of(conn, member_id, &row).await?;
            Ok((row, attachments))
        })
    })
    .await;

    let (row, attachments) = settle("scheduled_messages.create", outcome)?;
    Ok((
        StatusCode::CREATED,
        Json(ScheduledMessageResponse {
            scheduled_message: schedule_dto(&row, attachments),
        }),
    ))
}

// ---------------------------------------------------------------------------
// GET …/scheduled-messages
// ---------------------------------------------------------------------------

/// The caller's own schedules, soonest first. `sent` and `cancelled` rows are never listed (they
/// are body-less tombstones kept for the audit link). Works while the scheduler is off.
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<ListScheduledMessagesQuery>,
) -> Result<Json<ScheduledMessageListResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let filter = ScheduleListFilter::parse(query.status.as_deref())
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    let channel_id = nonblank(query.channel_id.as_deref())
        .map(|raw| path_uuid(raw, "invalid channel id"))
        .transpose()?;
    let cursor = nonblank(query.cursor.as_deref())
        .map(|raw| path_uuid(raw, "invalid scheduled message cursor"))
        .transpose()?;
    let limit = clamp_schedule_list_limit(query.limit.as_deref().and_then(|raw| raw.parse().ok()));
    let member_id = principal.member_id;

    let outcome = request_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            require_live_human(conn, workspace_id, member_id).await?;
            let after = match cursor {
                Some(cursor_id) => {
                    match get_own_schedule_in_tx(conn, workspace_id, member_id, cursor_id).await? {
                        Some(row) => Some((row.send_at, row.id)),
                        None => {
                            return Err(Refuse::Api(ApiError::bad_request(
                                "scheduled message cursor was not found",
                            )));
                        }
                    }
                }
                None => None,
            };
            let mut rows = list_own_schedules_in_tx(
                conn,
                workspace_id,
                member_id,
                filter,
                channel_id,
                after,
                limit + 1,
            )
            .await?;
            let next_cursor = if rows.len() as i64 > limit {
                rows.pop();
                rows.last().map(|row| row.id.to_string())
            } else {
                None
            };
            let ids: Vec<Uuid> = rows.iter().map(|row| row.id).collect();
            let mut attachments = schedule_attachments_in_tx(conn, member_id, &ids).await?;
            let dtos = rows
                .iter()
                .map(|row| schedule_dto(row, attachments.remove(&row.id).unwrap_or_default()))
                .collect::<Vec<_>>();
            Ok((dtos, next_cursor))
        })
    })
    .await;

    let (scheduled_messages, next_cursor) = settle("scheduled_messages.list", outcome)?;
    Ok(Json(ScheduledMessageListResponse {
        scheduled_messages,
        next_cursor,
    }))
}

/// The text a schedule stores: what the author wrote, except that a blank text is the empty string —
/// an attachment-only schedule has `""` (ADR-0208 D3), which is also what the clients send for an
/// attachment-only message (`sendMessage(…, "", { attachmentIds })`).
fn stored_body(raw: &str) -> String {
    if raw.trim().is_empty() {
        String::new()
    } else {
        raw.to_string()
    }
}

fn nonblank(raw: Option<&str>) -> Option<&str> {
    raw.map(str::trim).filter(|value| !value.is_empty())
}

// ---------------------------------------------------------------------------
// PATCH …/scheduled-messages/{id}
// ---------------------------------------------------------------------------

/// Change the text and/or the time. A `pending` row only while more than 30 seconds remain (409
/// `scheduled_too_late` inside them); a `failed` row can be edited any time, and a time re-arms
/// it (D9).
pub async fn update(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, id)): Path<(String, String)>,
    ClosedJson(request): ClosedJson<UpdateScheduledMessageRequest>,
) -> Result<Json<ScheduledMessageResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let schedule_id = path_uuid(&id, BAD_ID)?;
    if request.body.is_none() && request.send_at_ms.is_none() {
        return Err(ApiError::bad_request("body or sendAtMs is required"));
    }
    require_enabled(&state)?;
    let member_id = principal.member_id;
    let token_id = principal.token_id;
    let actor = ScheduleActor::Member {
        member_id,
        via_token_id: audit_via_token_id(&principal),
    };

    let outcome = request_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            bound_lock_wait(conn).await?;
            require_live_human(conn, workspace_id, member_id).await?;
            let Some(row) =
                lock_own_schedule_in_tx(conn, workspace_id, member_id, schedule_id).await?
            else {
                return Err(Refuse::Api(ApiError::not_found(NOT_FOUND)));
            };
            // The state first: a sent row is 409, a cancelled one is as good as absent.
            match row.status {
                ScheduledStatus::Sent => return Err(Refuse::Api(already_sent())),
                ScheduledStatus::Cancelled => {
                    return Err(Refuse::Api(ApiError::not_found(NOT_FOUND)));
                }
                ScheduledStatus::Pending | ScheduledStatus::Failed => {}
            }
            let now = db_now_in_tx(conn).await?;
            let new_body = request.body.as_deref().map(stored_body);
            // The text must not become empty when nothing is attached to say something.
            let held = reserved_attachment_ids_in_tx(conn, member_id, row.id).await?;
            if new_body.as_deref() == Some("") && held.is_empty() {
                return Err(Refuse::Api(empty_message()));
            }
            let updated = match row.status {
                ScheduledStatus::Sent | ScheduledStatus::Cancelled => None,
                ScheduledStatus::Pending => {
                    if is_edit_locked(row.send_at, now) {
                        return Err(Refuse::Api(conflict(
                            "scheduled_too_late",
                            "the scheduled message is about to be sent and can no longer be edited",
                        )));
                    }
                    let send_at = request
                        .send_at_ms
                        .map(|ms| validate_send_at(ms, now))
                        .transpose()
                        .map_err(|invalid| Refuse::Api(send_at_error(invalid)))?;
                    // Moving the time does not move who last wrote the text (D14).
                    let armed = if new_body.is_some() {
                        requester_session(conn, token_id).await?
                    } else {
                        None
                    };
                    edit_pending_in_tx(
                        conn,
                        member_id,
                        row.id,
                        new_body.as_deref(),
                        send_at,
                        armed,
                        actor,
                    )
                    .await?
                }
                ScheduledStatus::Failed => match request.send_at_ms {
                    Some(ms) => {
                        let send_at = validate_send_at(ms, now)
                            .map_err(|invalid| Refuse::Api(send_at_error(invalid)))?;
                        // Re-arming gives the row a slot again.
                        lock_member_schedules_in_tx(conn, workspace_id, member_id).await?;
                        if count_pending_in_tx(conn, workspace_id, member_id).await?
                            >= SCHEDULE_PENDING_LIMIT
                        {
                            return Err(Refuse::Api(pending_limit_reached()));
                        }
                        let armed = requester_session(conn, token_id).await?;
                        rearm_failed_in_tx(
                            conn,
                            member_id,
                            row.id,
                            new_body.as_deref(),
                            send_at,
                            armed,
                            actor,
                        )
                        .await?
                    }
                    None => {
                        let armed = requester_session(conn, token_id).await?;
                        edit_failed_body_in_tx(
                            conn,
                            member_id,
                            row.id,
                            new_body.as_deref().unwrap_or_default(),
                            armed,
                            actor,
                        )
                        .await?
                    }
                },
            };
            // Zero rows under a lock this transaction holds is a broken invariant (RLS turns a
            // wrong scope into "no rows", not an error), never a quiet 200.
            let Some(updated) = updated else {
                return Err(Refuse::Db(DbError::from(momo_db::sqlx::Error::Protocol(
                    "scheduled message invariant: an edit matched no row".into(),
                ))));
            };
            let attachments = attachments_of(conn, member_id, &updated).await?;
            Ok((updated, attachments))
        })
    })
    .await;

    let (row, attachments) = settle("scheduled_messages.update", outcome)?;
    Ok(Json(ScheduledMessageResponse {
        scheduled_message: schedule_dto(&row, attachments),
    }))
}

// ---------------------------------------------------------------------------
// DELETE …/scheduled-messages/{id}
// ---------------------------------------------------------------------------

/// Cancel. Allowed on `pending` and `failed` up to the moment the row is sent — **including the
/// last 30 seconds**: cancelling is the safety action, and the row lock decides a race (the
/// scheduler holds it → this waits, then finds the row `sent` → 409; this first → the scheduler's
/// re-check finds nothing). Cancelling a cancelled row is 204 again. Works while the scheduler is
/// off.
pub async fn delete(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let schedule_id = path_uuid(&id, BAD_ID)?;
    let member_id = principal.member_id;
    let actor = ScheduleActor::Member {
        member_id,
        via_token_id: audit_via_token_id(&principal),
    };

    let outcome = request_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            bound_lock_wait(conn).await?;
            require_live_human(conn, workspace_id, member_id).await?;
            let Some(row) =
                lock_own_schedule_in_tx(conn, workspace_id, member_id, schedule_id).await?
            else {
                return Err(Refuse::Api(ApiError::not_found(NOT_FOUND)));
            };
            match row.status {
                ScheduledStatus::Cancelled => Ok(()),
                ScheduledStatus::Sent => Err(Refuse::Api(already_sent())),
                ScheduledStatus::Pending | ScheduledStatus::Failed => {
                    match cancel_schedule_in_tx(conn, member_id, row.id, actor).await? {
                        Some(_) => Ok(()),
                        None => Err(Refuse::Db(DbError::from(momo_db::sqlx::Error::Protocol(
                            "scheduled message invariant: a cancel matched no row".into(),
                        )))),
                    }
                }
            }
        })
    })
    .await;

    settle("scheduled_messages.delete", outcome)?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// POST …/scheduled-messages/{id}/send-now
// ---------------------------------------------------------------------------

enum SendNow {
    /// Boxed: the row is large next to the one-byte refusal (`clippy::large_enum_variant`).
    Sent(Box<ScheduledMessage>),
    /// The canonical send refused it; the row is `failed` with this reason and that is committed.
    Refused(ScheduleFailure),
}

/// Send a `pending` or `failed` schedule right now, **in this request**, through the same
/// function the tick and `POST …/messages` use (D4, D9). The row lock keeps the scheduler out and
/// the caller gets the result at once. A `sessions_ended` row is sent the same way: this click is
/// the re-confirmation (the client has shown the author the whole text first).
pub async fn send_now(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, id)): Path<(String, String)>,
) -> Result<Json<ScheduledMessageResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let schedule_id = path_uuid(&id, BAD_ID)?;
    require_enabled(&state)?;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);
    let actor = ScheduleActor::Member {
        member_id,
        via_token_id,
    };
    let gates = DeliverGates::from_state(&state);

    let outcome = request_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            bound_lock_wait(conn).await?;
            require_live_human(conn, workspace_id, member_id).await?;
            let Some(row) =
                lock_own_schedule_in_tx(conn, workspace_id, member_id, schedule_id).await?
            else {
                return Err(Refuse::Api(ApiError::not_found(NOT_FOUND)));
            };
            match row.status {
                ScheduledStatus::Sent => return Err(Refuse::Api(already_sent())),
                ScheduledStatus::Cancelled => {
                    return Err(Refuse::Api(ApiError::not_found(NOT_FOUND)));
                }
                ScheduledStatus::Pending | ScheduledStatus::Failed => {}
            }
            match deliver_schedule_in_tx(conn, &gates, &row, via_token_id).await? {
                Delivery::Sent(sent) => {
                    let closed = mark_sent_in_tx(
                        conn,
                        member_id,
                        row.id,
                        sent.message.id,
                        actor,
                        Some("send_now"),
                    )
                    .await?;
                    let Some(closed) = closed else {
                        return Err(Refuse::Db(DbError::from(momo_db::sqlx::Error::Protocol(
                            "scheduled message invariant: closing a sent schedule matched no row"
                                .into(),
                        ))));
                    };
                    Ok(SendNow::Sent(Box::new(closed)))
                }
                Delivery::Refused(reason) => {
                    if mark_failed_in_tx(conn, member_id, row.id, reason, actor)
                        .await?
                        .is_none()
                    {
                        return Err(Refuse::Db(DbError::from(momo_db::sqlx::Error::Protocol(
                            "scheduled message invariant: closing a refused schedule matched no row"
                                .into(),
                        ))));
                    }
                    // Commit: the row is `failed` with the reason the author is about to be told.
                    Ok(SendNow::Refused(reason))
                }
            }
        })
    })
    .await;

    match settle("scheduled_messages.send_now", outcome)? {
        SendNow::Sent(row) => Ok(Json(ScheduledMessageResponse {
            scheduled_message: schedule_dto(&row, Vec::new()),
        })),
        SendNow::Refused(reason) => Err(send_now_refusal(reason)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_create_request_is_closed_and_camel_case() {
        let ok: CreateScheduledMessageRequest = serde_json::from_value(serde_json::json!({
            "body": "hi",
            "sendAtMs": 1,
            "rootId": "00000000-0000-0000-0000-000000000001",
            "attachmentIds": [],
            "clientRequestId": "00000000-0000-0000-0000-000000000002",
        }))
        .expect("parse");
        assert_eq!(ok.send_at_ms, 1);
        for forbidden in [
            "replyToId",
            "routing",
            "props",
            "type",
            "signature",
            "memberId",
        ] {
            let mut body = serde_json::json!({
                "body": "hi",
                "sendAtMs": 1,
                "clientRequestId": "00000000-0000-0000-0000-000000000002",
            });
            body[forbidden] = serde_json::json!("x");
            assert!(
                serde_json::from_value::<CreateScheduledMessageRequest>(body).is_err(),
                "{forbidden} must be refused, not dropped"
            );
        }
        assert!(
            serde_json::from_value::<CreateScheduledMessageRequest>(
                serde_json::json!({"sendAtMs": 1})
            )
            .is_err(),
            "clientRequestId is required"
        );
    }

    async fn decode(content_type: Option<&str>, body: &str) -> Result<(), ApiError> {
        let mut request = axum::http::Request::builder().method("POST").uri("/");
        if let Some(content_type) = content_type {
            request = request.header(axum::http::header::CONTENT_TYPE, content_type);
        }
        let request = request
            .body(axum::body::Body::from(body.to_string()))
            .expect("request");
        ClosedJson::<CreateScheduledMessageRequest>::from_request(request, &())
            .await
            .map(|_| ())
    }

    /// Appendix A: a body the decoder refuses is 400 (axum's own answer would be 422), a body that is
    /// not JSON at all keeps its 415.
    #[tokio::test]
    async fn a_decoder_refusal_is_a_400_and_a_wrong_content_type_stays_a_415() {
        let ok =
            r#"{"body":"x","sendAtMs":1,"clientRequestId":"00000000-0000-0000-0000-000000000002"}"#;
        assert!(decode(Some("application/json"), ok).await.is_ok());
        let unknown = r#"{"body":"x","sendAtMs":1,"routing":{},"clientRequestId":"00000000-0000-0000-0000-000000000002"}"#;
        let refused = decode(Some("application/json"), unknown)
            .await
            .expect_err("closed");
        assert_eq!(refused.status, StatusCode::BAD_REQUEST);
        assert!(refused.message.contains("routing"), "{}", refused.message);
        let missing = decode(Some("application/json"), r#"{"sendAtMs":1}"#)
            .await
            .expect_err("clientRequestId is required");
        assert_eq!(missing.status, StatusCode::BAD_REQUEST);
        let not_json = decode(Some("application/json"), "{nope")
            .await
            .expect_err("syntax");
        assert_eq!(not_json.status, StatusCode::BAD_REQUEST);
        let wrong_type = decode(Some("text/plain"), ok)
            .await
            .expect_err("content type");
        assert_eq!(wrong_type.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[test]
    fn the_dto_omits_what_a_finished_row_no_longer_has() {
        let at = chrono::DateTime::from_timestamp_millis(1_800_000_000_000).unwrap();
        let mut row = ScheduledMessage {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            channel_id: Uuid::from_u128(3),
            author_member_id: Uuid::from_u128(4),
            root_id: None,
            body: Some("text".into()),
            send_at: at,
            status: ScheduledStatus::Pending,
            failure_reason: None,
            attempts: 0,
            next_attempt_at: None,
            sent_message_id: None,
            sent_at: None,
            client_request_id: Uuid::from_u128(5),
            armed_session_id: None,
            rev: 0,
            created_at: at,
            updated_at: at,
        };
        let pending = serde_json::to_value(schedule_dto(&row, Vec::new())).unwrap();
        assert_eq!(pending["status"], "pending");
        assert_eq!(pending["body"], "text");
        assert_eq!(pending["editableUntilMs"], 1_800_000_000_000_i64 - 30_000);
        assert!(pending.get("attachments").is_none(), "empty is omitted");
        assert!(pending.get("failureReason").is_none());

        row.status = ScheduledStatus::Sent;
        row.body = None;
        row.sent_message_id = Some(Uuid::from_u128(9));
        row.sent_at = Some(at);
        let sent = serde_json::to_value(schedule_dto(&row, Vec::new())).unwrap();
        assert!(sent.get("body").is_none());
        assert!(sent.get("editableUntilMs").is_none());
        assert_eq!(sent["sentMessageId"], Uuid::from_u128(9).to_string());
    }
}
