//! Personal message reminders (ADR-0175 / #1888).
//!
//! Sidecar rows on `message`, owned by one human member. v1 has no outbox
//! fan-out — expiry is a client poll. Every statement here also binds
//! `app.member_id` so the table's owner-scoped FORCE RLS matches the caller;
//! `app.workspace_id` is already on the tenant transaction.

use chrono::{DateTime, Utc};
use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::identity::is_channel_member;

/// Optional memo cap — the CHECK on `082_message_reminder.sql`.
pub const REMINDER_NOTE_MAX_CHARS: usize = 500;

/// Default / max page size, same clamp as history / agent-run lists.
pub const REMINDER_LIST_LIMIT_DEFAULT: i64 = 50;
pub const REMINDER_LIST_LIMIT_MAX: i64 = 200;

const REMINDER_COLS: &str = "id, workspace_id, member_id, channel_id, message_id, \
     due_at, note, completed_at, created_at, updated_at";

/// One `message_reminder` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageReminder {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    pub channel_id: Uuid,
    pub message_id: Uuid,
    pub due_at: DateTime<Utc>,
    pub note: Option<String>,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// `GET …/reminders?state=`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReminderListState {
    Pending,
    All,
}

/// Why a create/list could not aim at the named message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReminderTarget {
    Ready,
    MessageNotFound,
    NotChannelMember,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("note must be at most 500 characters")]
pub struct ReminderNoteInvalid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ReminderDueInvalid {
    #[error("invalid dueAtMs")]
    Unrepresentable,
    #[error("dueAtMs must be in the future")]
    InThePast,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("state must be pending or all")]
pub struct ReminderStateInvalid;

/// Trim, drop blanks, refuse more than [`REMINDER_NOTE_MAX_CHARS`].
pub fn normalize_reminder_note(note: Option<&str>) -> Result<Option<String>, ReminderNoteInvalid> {
    let Some(raw) = note else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > REMINDER_NOTE_MAX_CHARS {
        return Err(ReminderNoteInvalid);
    }
    Ok(Some(trimmed.to_string()))
}

/// Epoch milliseconds → a future timestamptz. `now` is injected so a test can
/// freeze the cutoff without sleeping.
pub fn reminder_due_at_from_ms(
    ms: i64,
    now: DateTime<Utc>,
) -> Result<DateTime<Utc>, ReminderDueInvalid> {
    let due = DateTime::from_timestamp_millis(ms).ok_or(ReminderDueInvalid::Unrepresentable)?;
    if due <= now {
        return Err(ReminderDueInvalid::InThePast);
    }
    Ok(due)
}

pub fn parse_reminder_list_state(
    raw: Option<&str>,
) -> Result<ReminderListState, ReminderStateInvalid> {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("pending") => Ok(ReminderListState::Pending),
        Some("all") => Ok(ReminderListState::All),
        Some(_) => Err(ReminderStateInvalid),
    }
}

pub fn clamp_reminder_list_limit(requested: Option<i64>) -> i64 {
    match requested {
        Some(value) if value > 0 => value.min(REMINDER_LIST_LIMIT_MAX),
        _ => REMINDER_LIST_LIMIT_DEFAULT,
    }
}

/// Owner-scope GUC for this table. `SET LOCAL` via `set_config(..., true)` so
/// it unwinds with the tenant transaction. `app.workspace_id` stays in
/// `momo_db::tenant` — this is the extra predicate 082's policy names.
pub async fn bind_reminder_owner_guc(
    conn: &mut PgConnection,
    member_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query("SELECT set_config('app.member_id', $1, true)")
        .bind(member_id.to_string())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// The named message must live in `channel_id` and the caller must currently
/// be a member of that channel. A channel mismatch is [`MessageNotFound`] so
/// a caller cannot probe whether the id exists elsewhere.
pub async fn authorize_reminder_message_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    channel_id: Uuid,
    message_id: Uuid,
) -> Result<ReminderTarget, DbError> {
    bind_reminder_owner_guc(conn, member_id).await?;
    let found: Option<Uuid> = sqlx::query_scalar(
        "SELECT channel_id FROM message \
          WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL",
    )
    .bind(message_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    match found {
        Some(actual) if actual == channel_id => {}
        Some(_) | None => return Ok(ReminderTarget::MessageNotFound),
    }
    if !is_channel_member(conn, channel_id, member_id).await? {
        return Ok(ReminderTarget::NotChannelMember);
    }
    Ok(ReminderTarget::Ready)
}

pub async fn create_reminder_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    channel_id: Uuid,
    message_id: Uuid,
    due_at: DateTime<Utc>,
    note: Option<&str>,
) -> Result<MessageReminder, DbError> {
    bind_reminder_owner_guc(conn, member_id).await?;
    let row = sqlx::query(&format!(
        "INSERT INTO message_reminder \
            (workspace_id, member_id, channel_id, message_id, due_at, note) \
          VALUES ($1, $2, $3, $4, $5, $6) \
          RETURNING {REMINDER_COLS}"
    ))
    .bind(workspace_id)
    .bind(member_id)
    .bind(channel_id)
    .bind(message_id)
    .bind(due_at)
    .bind(note)
    .fetch_one(&mut *conn)
    .await?;
    Ok(decode_reminder(&row)?)
}

pub async fn get_own_reminder_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    reminder_id: Uuid,
) -> Result<Option<MessageReminder>, DbError> {
    bind_reminder_owner_guc(conn, member_id).await?;
    let row = sqlx::query(&format!(
        "SELECT {REMINDER_COLS} FROM message_reminder \
          WHERE id = $1 AND member_id = $2"
    ))
    .bind(reminder_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(row) => Ok(Some(decode_reminder(&row)?)),
        None => Ok(None),
    }
}

pub async fn list_reminders_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    state: ReminderListState,
    cursor: Option<(DateTime<Utc>, Uuid)>,
    limit: i64,
) -> Result<Vec<MessageReminder>, DbError> {
    bind_reminder_owner_guc(conn, member_id).await?;
    let include_completed = matches!(state, ReminderListState::All);
    let rows = if let Some((cursor_due, cursor_id)) = cursor {
        sqlx::query(&format!(
            "SELECT {REMINDER_COLS} FROM message_reminder \
              WHERE member_id = $1 \
                AND ($2 OR completed_at IS NULL) \
                AND (due_at, id) > ($3, $4) \
              ORDER BY due_at ASC, id ASC \
              LIMIT $5"
        ))
        .bind(member_id)
        .bind(include_completed)
        .bind(cursor_due)
        .bind(cursor_id)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await?
    } else {
        sqlx::query(&format!(
            "SELECT {REMINDER_COLS} FROM message_reminder \
              WHERE member_id = $1 \
                AND ($2 OR completed_at IS NULL) \
              ORDER BY due_at ASC, id ASC \
              LIMIT $3"
        ))
        .bind(member_id)
        .bind(include_completed)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await?
    };
    rows.iter()
        .map(decode_reminder)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

pub async fn snooze_reminder_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    reminder_id: Uuid,
    due_at: DateTime<Utc>,
) -> Result<Option<MessageReminder>, DbError> {
    bind_reminder_owner_guc(conn, member_id).await?;
    let row = sqlx::query(&format!(
        "UPDATE message_reminder \
            SET due_at = $3, updated_at = now() \
          WHERE id = $1 AND member_id = $2 AND completed_at IS NULL \
          RETURNING {REMINDER_COLS}"
    ))
    .bind(reminder_id)
    .bind(member_id)
    .bind(due_at)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(row) => Ok(Some(decode_reminder(&row)?)),
        None => Ok(None),
    }
}

pub async fn complete_reminder_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    reminder_id: Uuid,
) -> Result<Option<MessageReminder>, DbError> {
    bind_reminder_owner_guc(conn, member_id).await?;
    let row = sqlx::query(&format!(
        "UPDATE message_reminder \
            SET completed_at = COALESCE(completed_at, now()), updated_at = now() \
          WHERE id = $1 AND member_id = $2 \
          RETURNING {REMINDER_COLS}"
    ))
    .bind(reminder_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(row) => Ok(Some(decode_reminder(&row)?)),
        None => Ok(None),
    }
}

pub async fn delete_reminder_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
    reminder_id: Uuid,
) -> Result<bool, DbError> {
    bind_reminder_owner_guc(conn, member_id).await?;
    let deleted: Option<Uuid> = sqlx::query_scalar(
        "DELETE FROM message_reminder \
          WHERE id = $1 AND member_id = $2 \
          RETURNING id",
    )
    .bind(reminder_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(deleted.is_some())
}

fn decode_reminder(row: &sqlx::postgres::PgRow) -> Result<MessageReminder, sqlx::Error> {
    Ok(MessageReminder {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        member_id: row.try_get("member_id")?,
        channel_id: row.try_get("channel_id")?,
        message_id: row.try_get("message_id")?,
        due_at: row.try_get("due_at")?,
        note: row.try_get("note")?,
        completed_at: row.try_get("completed_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_notes_collapse_to_absent() {
        assert_eq!(normalize_reminder_note(None).expect("ok"), None);
        assert_eq!(normalize_reminder_note(Some("  ")).expect("ok"), None);
        assert_eq!(
            normalize_reminder_note(Some("  later  "))
                .expect("ok")
                .as_deref(),
            Some("later")
        );
    }

    #[test]
    fn notes_longer_than_500_chars_are_refused() {
        let too_long = "가".repeat(501);
        assert!(normalize_reminder_note(Some(&too_long)).is_err());
        let ok = "가".repeat(500);
        assert_eq!(
            normalize_reminder_note(Some(&ok)).expect("ok").as_deref(),
            Some(ok.as_str())
        );
    }

    #[test]
    fn past_and_present_due_times_are_refused() {
        let now = DateTime::from_timestamp_millis(1_700_000_000_000).expect("now");
        assert!(matches!(
            reminder_due_at_from_ms(1_700_000_000_000, now),
            Err(ReminderDueInvalid::InThePast)
        ));
        assert!(matches!(
            reminder_due_at_from_ms(1_699_999_999_000, now),
            Err(ReminderDueInvalid::InThePast)
        ));
        let due = reminder_due_at_from_ms(1_700_000_000_001, now).expect("future");
        assert_eq!(due.timestamp_millis(), 1_700_000_000_001);
    }

    #[test]
    fn list_state_defaults_to_pending() {
        assert_eq!(
            parse_reminder_list_state(None).expect("ok"),
            ReminderListState::Pending
        );
        assert_eq!(
            parse_reminder_list_state(Some("")).expect("ok"),
            ReminderListState::Pending
        );
        assert_eq!(
            parse_reminder_list_state(Some("pending")).expect("ok"),
            ReminderListState::Pending
        );
        assert_eq!(
            parse_reminder_list_state(Some("all")).expect("ok"),
            ReminderListState::All
        );
        assert!(parse_reminder_list_state(Some("done")).is_err());
    }

    #[test]
    fn list_limit_clamps_like_history() {
        assert_eq!(clamp_reminder_list_limit(None), 50);
        assert_eq!(clamp_reminder_list_limit(Some(0)), 50);
        assert_eq!(clamp_reminder_list_limit(Some(-3)), 50);
        assert_eq!(clamp_reminder_list_limit(Some(7)), 7);
        assert_eq!(clamp_reminder_list_limit(Some(10_000)), 200);
    }
}
