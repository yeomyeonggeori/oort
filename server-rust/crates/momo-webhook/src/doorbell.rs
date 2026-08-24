//! ADR-0171 hosted-connection doorbell — the SQL half.
//!
//! Registration is tenant-scoped. Dispatch is a BYPASSRLS poll of this table
//! against `hosted_agent_inbox_counter`, not an outbox producer. Nothing here
//! inserts into `outbox`.

use chrono::{DateTime, Utc};
use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::crypto::{
    masked_doorbell_secret, open_doorbell_secret, seal_doorbell_secret, DoorbellSealError,
};

/// Constant wake body (ADR-0171 D2). No message id, no workspace, no cursor.
pub const DOORBELL_BODY: &[u8] = br#"{"kind":"oort.doorbell.v1"}"#;

pub const DOORBELL_KIND: &str = "oort.doorbell.v1";

/// GET/list projection. **There is no sealed or plaintext secret field.**
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoorbellProjection {
    pub url: String,
    pub secret_masked: String,
    pub last_fired_at: Option<DateTime<Utc>>,
    pub last_status: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoalesceAction {
    /// First event of a window: fire now.
    Leading,
    /// Window is open: remember a trailing fire, send nothing.
    MarkTrailing,
    /// Window expired with pending events: fire once.
    Trailing,
    /// Nothing to do.
    Idle,
}

/// Leading-edge + trailing coalescing (ADR-0171 D4).
///
/// RED of the unguarded path is [`CoalesceAction::Leading`] on every
/// `new_events` regardless of `window_open` — a burst then fires once per
/// event instead of ≤2.
pub fn coalesce_action(
    new_events: bool,
    pending_trailing: bool,
    window_open: bool,
) -> CoalesceAction {
    if window_open {
        if new_events {
            return CoalesceAction::MarkTrailing;
        }
        return CoalesceAction::Idle;
    }
    if new_events {
        return CoalesceAction::Leading;
    }
    if pending_trailing {
        return CoalesceAction::Trailing;
    }
    CoalesceAction::Idle
}

/// The unguarded "fire every new event" decision. Exists so AC3 can name the
/// failure mode rather than only the passing one.
pub fn unguarded_fire_every_new_event(new_events: bool) -> bool {
    new_events
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoorbellClaim {
    pub workspace_id: Uuid,
    pub connection_id: Uuid,
    pub url: String,
    pub secret_sealed: Vec<u8>,
    pub last_seen_inbox_seq: i64,
    pub pending_trailing: bool,
    pub window_started_at: Option<DateTime<Utc>>,
    pub inbox_last_seq: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DoorbellRegisterError {
    #[error("hosted connection not found")]
    NotFound,
    #[error("doorbell requires an active hosted connection")]
    NotActive,
    #[error("{0}")]
    Seal(DoorbellSealError),
}

pub async fn register_doorbell_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    actor_member_id: Uuid,
    url: &str,
    secret: &str,
    master_key: &str,
) -> Result<Result<DoorbellProjection, DoorbellRegisterError>, DbError> {
    let status: Option<String> = sqlx::query_scalar(
        "SELECT status::text FROM hosted_agent_connection \
          WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(status) = status else {
        return Ok(Err(DoorbellRegisterError::NotFound));
    };
    if status != "active" {
        return Ok(Err(DoorbellRegisterError::NotActive));
    }
    let sealed = match seal_doorbell_secret(secret, master_key) {
        Ok(sealed) => sealed,
        Err(error) => return Ok(Err(DoorbellRegisterError::Seal(error))),
    };
    let masked = masked_doorbell_secret(secret);
    let current_seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE( \
            (SELECT last_seq FROM hosted_agent_inbox_counter \
              WHERE workspace_id = $1 AND connection_id = $2), \
            0)",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_one(&mut *conn)
    .await?;
    let row = sqlx::query(
        "INSERT INTO hosted_agent_doorbell \
           (workspace_id, connection_id, url, secret_sealed, secret_masked, \
            registered_by, last_seen_inbox_seq, pending_trailing, window_started_at, \
            last_fired_at, last_status, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, false, NULL, NULL, NULL, now()) \
         ON CONFLICT (connection_id) DO UPDATE SET \
            url = EXCLUDED.url, \
            secret_sealed = EXCLUDED.secret_sealed, \
            secret_masked = EXCLUDED.secret_masked, \
            registered_by = EXCLUDED.registered_by, \
            registered_at = now(), \
            last_seen_inbox_seq = EXCLUDED.last_seen_inbox_seq, \
            pending_trailing = false, \
            window_started_at = NULL, \
            last_fired_at = NULL, \
            last_status = NULL, \
            updated_at = now() \
         RETURNING url, secret_masked, last_fired_at, last_status",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(url)
    .bind(sealed)
    .bind(&masked)
    .bind(actor_member_id)
    .bind(current_seq)
    .fetch_one(&mut *conn)
    .await?;
    Ok(Ok(decode_projection(&row)?))
}

pub async fn unregister_doorbell_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
) -> Result<Option<DoorbellProjection>, DbError> {
    let row = sqlx::query(
        "DELETE FROM hosted_agent_doorbell \
          WHERE workspace_id = $1 AND connection_id = $2 \
        RETURNING url, secret_masked, last_fired_at, last_status",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_optional(&mut *conn)
    .await?;
    row.as_ref()
        .map(decode_projection)
        .transpose()
        .map_err(DbError::from)
}

pub async fn load_doorbell_projection_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
) -> Result<Option<DoorbellProjection>, DbError> {
    let row = sqlx::query(
        "SELECT url, secret_masked, last_fired_at, last_status \
           FROM hosted_agent_doorbell \
          WHERE workspace_id = $1 AND connection_id = $2",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_optional(&mut *conn)
    .await?;
    row.as_ref()
        .map(decode_projection)
        .transpose()
        .map_err(DbError::from)
}

pub async fn list_doorbell_projections_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Vec<(Uuid, DoorbellProjection)>, DbError> {
    let rows = sqlx::query(
        "SELECT connection_id, url, secret_masked, last_fired_at, last_status \
           FROM hosted_agent_doorbell WHERE workspace_id = $1",
    )
    .bind(workspace_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push((row.try_get("connection_id")?, decode_projection(row)?));
    }
    Ok(out)
}

fn decode_projection(row: &sqlx::postgres::PgRow) -> Result<DoorbellProjection, sqlx::Error> {
    Ok(DoorbellProjection {
        url: row.try_get("url")?,
        secret_masked: row.try_get("secret_masked")?,
        last_fired_at: row.try_get("last_fired_at")?,
        last_status: row.try_get("last_status")?,
    })
}

/// Claim doorbells that have new inbox events or an expired trailing window.
///
/// `cooldown_ms` is the D4 window. The sender re-checks `window_open` in
/// process because the SQL prefilter is a wake set, not the decision.
pub async fn claim_doorbell_batch(
    conn: &mut PgConnection,
    batch_size: i64,
    cooldown_ms: i64,
) -> Result<Vec<DoorbellClaim>, sqlx::Error> {
    let rows = sqlx::query(
        "WITH claimed AS ( \
             SELECT d.connection_id \
               FROM hosted_agent_doorbell d \
               JOIN hosted_agent_connection hc \
                 ON hc.workspace_id = d.workspace_id AND hc.id = d.connection_id \
               LEFT JOIN hosted_agent_inbox_counter c \
                 ON c.workspace_id = d.workspace_id AND c.connection_id = d.connection_id \
              WHERE hc.status = 'active' \
                AND ( \
                      COALESCE(c.last_seq, 0) > d.last_seen_inbox_seq \
                   OR (d.pending_trailing AND ( \
                         d.window_started_at IS NULL \
                      OR d.window_started_at <= now() - ($2::bigint * interval '1 millisecond') \
                   )) \
                ) \
              ORDER BY d.connection_id \
              FOR UPDATE OF d SKIP LOCKED \
              LIMIT $1 \
         ) \
         SELECT d.workspace_id, d.connection_id, d.url, d.secret_sealed, \
                d.last_seen_inbox_seq, d.pending_trailing, d.window_started_at, \
                COALESCE(c.last_seq, 0) AS inbox_last_seq \
           FROM hosted_agent_doorbell d \
           JOIN claimed x ON x.connection_id = d.connection_id \
           LEFT JOIN hosted_agent_inbox_counter c \
             ON c.workspace_id = d.workspace_id AND c.connection_id = d.connection_id",
    )
    .bind(batch_size)
    .bind(cooldown_ms)
    .fetch_all(&mut *conn)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push(DoorbellClaim {
            workspace_id: row.try_get("workspace_id")?,
            connection_id: row.try_get("connection_id")?,
            url: row.try_get("url")?,
            secret_sealed: row.try_get("secret_sealed")?,
            last_seen_inbox_seq: row.try_get("last_seen_inbox_seq")?,
            pending_trailing: row.try_get("pending_trailing")?,
            window_started_at: row.try_get("window_started_at")?,
            inbox_last_seq: row.try_get("inbox_last_seq")?,
        });
    }
    Ok(out)
}

pub fn open_claimed_secret(
    claim: &DoorbellClaim,
    master_key: &str,
) -> Result<String, DoorbellSealError> {
    open_doorbell_secret(&claim.secret_sealed, master_key)
}

pub async fn mark_trailing_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    last_seen_inbox_seq: i64,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE hosted_agent_doorbell \
            SET last_seen_inbox_seq = $3, \
                pending_trailing = true, \
                updated_at = now() \
          WHERE workspace_id = $1 AND connection_id = $2",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(last_seen_inbox_seq)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Consume the wake and start the cooldown window **before** the HTTP hop, so
/// two senders cannot both fire the same leading edge. `last_fired_at` is
/// written afterwards by [`record_doorbell_fire_in_tx`].
pub async fn consume_for_fire_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    last_seen_inbox_seq: i64,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE hosted_agent_doorbell \
            SET last_seen_inbox_seq = $3, \
                pending_trailing = false, \
                window_started_at = now(), \
                updated_at = now() \
          WHERE workspace_id = $1 AND connection_id = $2",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(last_seen_inbox_seq)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn record_doorbell_fire_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    last_status: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE hosted_agent_doorbell \
            SET last_fired_at = now(), \
                last_status = $3, \
                updated_at = now() \
          WHERE workspace_id = $1 AND connection_id = $2",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(last_status)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The payload bytes that leave the process. Typed serialization is forbidden:
/// a struct round-trip could add an identifier and break D2.
pub fn doorbell_body() -> &'static [u8] {
    DOORBELL_BODY
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_inside_an_open_window_is_two_fires_not_one_per_event() {
        // tick 0: first event, window closed → leading
        assert_eq!(coalesce_action(true, false, false), CoalesceAction::Leading);
        // ticks 1..n: more events, window open → trailing mark, no fire
        assert_eq!(
            coalesce_action(true, false, true),
            CoalesceAction::MarkTrailing
        );
        assert_eq!(
            coalesce_action(true, true, true),
            CoalesceAction::MarkTrailing
        );
        // window expired with pending → one trailing fire
        assert_eq!(
            coalesce_action(false, true, false),
            CoalesceAction::Trailing
        );
    }

    /// RED of AC3: dropping the `window_open` guard fires once per event.
    #[test]
    fn removing_coalesce_would_fire_every_event_in_a_burst() {
        let events = 5;
        let mut guarded = 0;
        let mut unguarded = 0;
        let mut pending = false;
        let mut window_open = false;
        for i in 0..events {
            if unguarded_fire_every_new_event(true) {
                unguarded += 1;
            }
            match coalesce_action(true, pending, window_open) {
                CoalesceAction::Leading | CoalesceAction::Trailing => {
                    guarded += 1;
                    window_open = true;
                    pending = false;
                }
                CoalesceAction::MarkTrailing => pending = true,
                CoalesceAction::Idle => {}
            }
            if i == 0 {
                window_open = true;
            }
        }
        // expire window
        if coalesce_action(false, pending, false) == CoalesceAction::Trailing {
            guarded += 1;
        }
        assert_eq!(
            unguarded, 5,
            "the unguarded path is the red: 5 events, 5 fires"
        );
        assert_eq!(
            guarded, 2,
            "removing coalesce_action would fail this assertion"
        );
    }

    #[test]
    fn the_payload_is_the_constant_and_names_no_identifier() {
        let body = std::str::from_utf8(doorbell_body()).expect("utf8");
        assert_eq!(body, r#"{"kind":"oort.doorbell.v1"}"#);
        for forbidden in ["workspace", "message", "connection", "inbox", "id"] {
            assert!(
                !body.to_ascii_lowercase().contains(forbidden),
                "D2 forbids identifiers in the payload; found {forbidden} in {body}"
            );
        }
    }

    #[test]
    fn migration_080_adds_no_outbox_producer_trigger() {
        let sql = include_str!("../../../../server/Migrations/080_hosted_agent_doorbell.sql");
        let uncommented: String = sql
            .lines()
            .filter(|line| !line.trim_start().starts_with("--"))
            .collect();
        let upper = uncommented.to_ascii_uppercase();
        let lower = uncommented.to_ascii_lowercase();
        assert!(
            !upper.contains("CREATE TRIGGER"),
            "AC7: adding a trigger to 080 is the red — doorbell dispatch must poll, not enqueue"
        );
        assert!(
            !lower.contains("insert into outbox"),
            "AC7: 080 must not write outbox rows"
        );
        assert!(
            !lower.contains("enqueue_"),
            "AC7: 080 must not grow an enqueue helper"
        );
    }
}
