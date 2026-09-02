//! Personal message reminders — ADR-0175 / #1888.
//!
//! ```text
//! POST   /v1/workspaces/{ws}/reminders
//! GET    /v1/workspaces/{ws}/reminders?state=pending|all
//! PATCH  /v1/workspaces/{ws}/reminders/{id}
//! DELETE /v1/workspaces/{ws}/reminders/{id}
//! ```
//!
//! Human only. The member id is the credential's, never the request's. v1 does
//! not emit outbox: expiry is a client poll (ADR-0175). Writes still share one
//! tenant transaction with their audit row.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal};
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::{
    authorize_reminder_message_in_tx, clamp_reminder_list_limit, complete_reminder_in_tx,
    create_reminder_in_tx, delete_reminder_in_tx, get_own_reminder_in_tx, list_reminders_in_tx,
    normalize_reminder_note, parse_reminder_list_state, reminder_due_at_from_ms,
    snooze_reminder_in_tx, MessageReminder, ReminderTarget,
};

use crate::dto::{
    CreateReminderRequest, ListRemindersQuery, ReminderDto, ReminderListResponse, ReminderResponse,
    UpdateReminderRequest,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, epoch_ms, path_uuid, require_human, settle_db,
    workspace_scope, DbRejectable,
};
use crate::AppState;

const HUMAN_ONLY: &str = "reminders require a human bearer";
const NOT_FOUND: &str = "reminder not found";
const NOT_CHANNEL_MEMBER: &str = "not a member of this channel";
const COMPLETED_CANNOT_SNOOZE: &str = "completed reminder cannot be rescheduled";

fn reminder_dto(row: &MessageReminder) -> ReminderDto {
    ReminderDto {
        id: row.id.to_string(),
        workspace_id: row.workspace_id.to_string(),
        member_id: row.member_id.to_string(),
        channel_id: row.channel_id.to_string(),
        message_id: row.message_id.to_string(),
        due_at_ms: epoch_ms(row.due_at),
        note: row.note.clone(),
        completed_at_ms: row.completed_at.map(epoch_ms),
        created_at_ms: epoch_ms(row.created_at),
        updated_at_ms: epoch_ms(row.updated_at),
    }
}

fn reminder_response(row: MessageReminder) -> ReminderResponse {
    ReminderResponse {
        reminder: reminder_dto(&row),
    }
}

fn due_at_from_request(ms: i64) -> Result<chrono::DateTime<chrono::Utc>, ApiError> {
    reminder_due_at_from_ms(ms, chrono::Utc::now())
        .map_err(|error| ApiError::bad_request(error.to_string()))
}

async fn require_live_human(
    conn: &mut momo_db::PgConnection,
    workspace_id: uuid::Uuid,
    member_id: uuid::Uuid,
) -> Result<Result<(), ApiError>, momo_db::DbError> {
    if active_workspace_role(conn, workspace_id, member_id)
        .await?
        .is_none()
    {
        return Ok(Err(ApiError::forbidden("active human membership required")));
    }
    Ok(Ok(()))
}

/// `POST /v1/workspaces/{ws}/reminders`
pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<CreateReminderRequest>,
) -> Result<(StatusCode, Json<ReminderResponse>), ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&request.channel_id, "invalid channel id")?;
    let message_id = path_uuid(&request.message_id, "invalid message id")?;
    let due_at = due_at_from_request(request.due_at_ms)?;
    let note = normalize_reminder_note(request.note.as_deref())
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<MessageReminder> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                match authorize_reminder_message_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    channel_id,
                    message_id,
                )
                .await?
                {
                    ReminderTarget::MessageNotFound => {
                        return Ok(Err(ApiError::not_found("message not found")));
                    }
                    ReminderTarget::NotChannelMember => {
                        return Ok(Err(ApiError::forbidden(NOT_CHANNEL_MEMBER)));
                    }
                    ReminderTarget::Ready => {}
                }
                let saved = create_reminder_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    channel_id,
                    message_id,
                    due_at,
                    note.as_deref(),
                )
                .await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "reminder.created")
                        .by(member_id)
                        .target("message_reminder", saved.id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.reminder.created.v1",
                            serde_json::json!({
                                "channelId": saved.channel_id,
                                "messageId": saved.message_id,
                                "dueAtMs": epoch_ms(saved.due_at),
                            }),
                        ),
                )
                .await?;
                Ok(Ok(saved))
            })
        })
        .await;

    let saved = settle_db("reminders.create", outcome)?;
    Ok((StatusCode::CREATED, Json(reminder_response(saved))))
}

/// `GET /v1/workspaces/{ws}/reminders?state=pending|all`
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<ListRemindersQuery>,
) -> Result<Json<ReminderListResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let state_filter = parse_reminder_list_state(query.state.as_deref())
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let cursor = match query
        .cursor
        .as_deref()
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
    {
        Some(raw) => Some(path_uuid(raw, "invalid reminder cursor")?),
        None => None,
    };
    let limit = clamp_reminder_list_limit(query.limit.as_deref().and_then(|raw| raw.parse().ok()));
    let member_id = principal.member_id;

    let outcome: DbRejectable<(Vec<MessageReminder>, Option<String>)> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                    return Ok(Err(rejection));
                }
                let cursor_key = if let Some(cursor_id) = cursor {
                    match get_own_reminder_in_tx(conn, member_id, cursor_id).await? {
                        Some(row) => Some((row.due_at, row.id)),
                        None => {
                            return Ok(Err(ApiError::bad_request("reminder cursor was not found")));
                        }
                    }
                } else {
                    None
                };
                let mut rows =
                    list_reminders_in_tx(conn, member_id, state_filter, cursor_key, limit + 1)
                        .await?;
                let next_cursor = if rows.len() as i64 > limit {
                    rows.pop();
                    rows.last().map(|row| row.id.to_string())
                } else {
                    None
                };
                Ok(Ok((rows, next_cursor)))
            })
        })
        .await;

    let (rows, next_cursor) = settle_db("reminders.list", outcome)?;
    Ok(Json(ReminderListResponse {
        reminders: rows.iter().map(reminder_dto).collect(),
        next_cursor,
    }))
}

/// `PATCH /v1/workspaces/{ws}/reminders/{id}` — snooze or complete.
pub async fn update(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, reminder)): Path<(String, String)>,
    Json(request): Json<UpdateReminderRequest>,
) -> Result<Json<ReminderResponse>, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let reminder_id = path_uuid(&reminder, "invalid reminder id")?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    match (request.due_at_ms, request.completed) {
        (None, None) => Err(ApiError::bad_request("dueAtMs or completed is required")),
        (Some(_), Some(_)) => Err(ApiError::bad_request(
            "dueAtMs and completed cannot both be set",
        )),
        (None, Some(false)) => Err(ApiError::bad_request("completed must be true")),
        (Some(ms), None) => {
            let due_at = due_at_from_request(ms)?;
            let outcome: DbRejectable<MessageReminder> =
                agent_tenant_tx(&state.pool, workspace_id, move |conn| {
                    Box::pin(async move {
                        if let Err(rejection) =
                            require_live_human(conn, workspace_id, member_id).await?
                        {
                            return Ok(Err(rejection));
                        }
                        match get_own_reminder_in_tx(conn, member_id, reminder_id).await? {
                            None => return Ok(Err(ApiError::not_found(NOT_FOUND))),
                            Some(existing) if existing.completed_at.is_some() => {
                                return Ok(Err(ApiError::new(
                                    StatusCode::CONFLICT,
                                    COMPLETED_CANNOT_SNOOZE,
                                )));
                            }
                            Some(_) => {}
                        }
                        let Some(saved) =
                            snooze_reminder_in_tx(conn, member_id, reminder_id, due_at).await?
                        else {
                            return Ok(Err(ApiError::not_found(NOT_FOUND)));
                        };
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, "reminder.updated")
                                .by(member_id)
                                .target("message_reminder", saved.id)
                                .via_token(via_token)
                                .with_schema(
                                    "momo.reminder.updated.v1",
                                    serde_json::json!({
                                        "dueAtMs": epoch_ms(saved.due_at),
                                    }),
                                ),
                        )
                        .await?;
                        Ok(Ok(saved))
                    })
                })
                .await;
            let saved = settle_db("reminders.snooze", outcome)?;
            Ok(Json(reminder_response(saved)))
        }
        (None, Some(true)) => {
            let outcome: DbRejectable<(MessageReminder, bool)> =
                agent_tenant_tx(&state.pool, workspace_id, move |conn| {
                    Box::pin(async move {
                        if let Err(rejection) =
                            require_live_human(conn, workspace_id, member_id).await?
                        {
                            return Ok(Err(rejection));
                        }
                        let Some(before) =
                            get_own_reminder_in_tx(conn, member_id, reminder_id).await?
                        else {
                            return Ok(Err(ApiError::not_found(NOT_FOUND)));
                        };
                        let already_done = before.completed_at.is_some();
                        let Some(saved) =
                            complete_reminder_in_tx(conn, member_id, reminder_id).await?
                        else {
                            return Ok(Err(ApiError::not_found(NOT_FOUND)));
                        };
                        if !already_done {
                            write_audit(
                                conn,
                                &AuditEntry::new(workspace_id, "reminder.completed")
                                    .by(member_id)
                                    .target("message_reminder", saved.id)
                                    .via_token(via_token)
                                    .with_schema(
                                        "momo.reminder.completed.v1",
                                        serde_json::json!({
                                            "completedAtMs": saved
                                                .completed_at
                                                .map(epoch_ms),
                                        }),
                                    ),
                            )
                            .await?;
                        }
                        Ok(Ok((saved, already_done)))
                    })
                })
                .await;
            let (saved, _) = settle_db("reminders.complete", outcome)?;
            Ok(Json(reminder_response(saved)))
        }
    }
}

/// `DELETE /v1/workspaces/{ws}/reminders/{id}`
pub async fn delete(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, reminder)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let reminder_id = path_uuid(&reminder, "invalid reminder id")?;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<()> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if let Err(rejection) = require_live_human(conn, workspace_id, member_id).await? {
                return Ok(Err(rejection));
            }
            if !delete_reminder_in_tx(conn, member_id, reminder_id).await? {
                return Ok(Err(ApiError::not_found(NOT_FOUND)));
            }
            write_audit(
                conn,
                &AuditEntry::new(workspace_id, "reminder.deleted")
                    .by(member_id)
                    .target("message_reminder", reminder_id)
                    .via_token(via_token)
                    .with_schema("momo.reminder.deleted.v1", serde_json::json!({})),
            )
            .await?;
            Ok(Ok(()))
        })
    })
    .await;

    settle_db("reminders.delete", outcome)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_auth::PrincipalKind;
    use uuid::Uuid;

    fn principal(kind: PrincipalKind) -> Principal {
        Principal {
            member_id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            token_id: Some(Uuid::from_u128(3)),
            scopes: vec![],
            kind,
        }
    }

    #[test]
    fn an_agent_principal_is_refused_before_any_write() {
        let error = require_human(&principal(PrincipalKind::Agent), HUMAN_ONLY).expect_err("403");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(error.message, HUMAN_ONLY);
        assert!(require_human(&principal(PrincipalKind::Human), HUMAN_ONLY).is_ok());
    }

    #[test]
    fn the_wire_omits_absent_note_and_completed_stamp() {
        let json = serde_json::to_value(ReminderDto {
            id: "r".into(),
            workspace_id: "w".into(),
            member_id: "m".into(),
            channel_id: "c".into(),
            message_id: "msg".into(),
            due_at_ms: 1,
            note: None,
            completed_at_ms: None,
            created_at_ms: 2,
            updated_at_ms: 3,
        })
        .expect("serialize");
        assert_eq!(json["dueAtMs"], 1);
        assert_eq!(json["channelId"], "c");
        assert!(json.get("note").is_none(), "{json}");
        assert!(json.get("completedAtMs").is_none(), "{json}");
    }
}
