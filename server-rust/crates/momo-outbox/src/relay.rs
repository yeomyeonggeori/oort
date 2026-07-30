//! Relay consumer skeleton — the outbox drain side of the single write path.
//!
//! Ports the claim query from `relay/OutboxRelay/.../RelayService.swift:160-196`:
//! pending `broadcast`/`webhook_delivery` rows are selected `FOR UPDATE SKIP
//! LOCKED` and flipped to `processing` in the SAME transaction, so a claim is
//! loss-free (it depends only on commit) and two relay workers never grab the
//! same row. Publishing/settlement (POST Centrifugo `/api/publish`, retry
//! backoff) is B1+; B0 fixes the claim contract only.
//!
//! `momo-relay` (the binary) will own the actual loop; this lives in
//! `momo-outbox` because it is outbox SQL and this crate is the sole owner of it.

use chrono::{DateTime, Utc};
use sqlx::PgPool;

/// A claimed outbox row, flipped to `processing` and ready to publish.
#[derive(Debug, Clone)]
pub struct ClaimedRow {
    pub id: i64,
    pub kind: String,
    pub attempts: i32,
    pub payload: String,
    pub created_at: DateTime<Utc>,
}

/// Claim up to `batch_size` pending broadcast/webhook rows and flip them to
/// `processing` in one transaction. Returns the claimed rows in `id` order.
///
/// Skeleton: the query is the real ADR-parity claim; the caller loop, publish,
/// and settlement land in B1.
pub async fn claim_batch(pool: &PgPool, batch_size: i64) -> Result<Vec<ClaimedRow>, sqlx::Error> {
    let rows: Vec<ClaimedRow> = sqlx::query_as::<_, (i64, String, i32, String, DateTime<Utc>)>(
        "WITH claimed AS ( \
             SELECT id FROM outbox \
              WHERE kind IN ('broadcast', 'webhook_delivery') \
                AND status = 'pending' \
                AND available_at <= now() \
              ORDER BY id \
              FOR UPDATE SKIP LOCKED \
              LIMIT $1 \
         ) \
         UPDATE outbox o \
            SET status = 'processing', attempts = o.attempts + 1 \
           FROM claimed c \
          WHERE o.id = c.id \
          RETURNING o.id, o.kind::text, o.attempts, o.payload::text, o.created_at",
    )
    .bind(batch_size)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(id, kind, attempts, payload, created_at)| ClaimedRow {
        id,
        kind,
        attempts,
        payload,
        created_at,
    })
    .collect();
    Ok(rows)
}

// ---------------------------------------------------------------------------
// B1.5 additions — the API `momo-relay` (the binary) consumes.
//
// The relay binary owns the loop; every statement that touches the `outbox`
// table lives here, so invariant #3's "one crate owns outbox SQL" survives the
// arrival of a second consumer.
// ---------------------------------------------------------------------------

/// The `pg_notify` channel the schema's `outbox_notify_trg`
/// (`001_init.sql:432`) fires on. Exposed so the relay's `LISTEN` never
/// hard-codes a channel name that the trigger owns.
pub const NOTIFY_CHANNEL: &str = "outbox";

/// Claim up to `batch_size` pending **broadcast** rows and flip them to
/// `processing` in one statement (its own implicit transaction), so the claim is
/// atomic and `FOR UPDATE SKIP LOCKED` guarantees two relay workers never grab
/// the same row.
///
/// This is [`claim_batch`] narrowed to `kind='broadcast'`: the relay publishes
/// to Centrifugo only. `webhook_delivery` / `push_candidate` / `agent_job` rows
/// belong to their own consumers (B1 gate lesson) and must not be drained here.
pub async fn claim_broadcast_batch(
    pool: &PgPool,
    batch_size: i64,
) -> Result<Vec<ClaimedRow>, sqlx::Error> {
    let rows: Vec<ClaimedRow> = sqlx::query_as::<_, (i64, String, i32, String, DateTime<Utc>)>(
        "WITH claimed AS ( \
             SELECT id FROM outbox \
              WHERE kind = 'broadcast' \
                AND status = 'pending' \
                AND available_at <= now() \
              ORDER BY id \
              FOR UPDATE SKIP LOCKED \
              LIMIT $1 \
         ) \
         UPDATE outbox o \
            SET status = 'processing', attempts = o.attempts + 1 \
           FROM claimed c \
          WHERE o.id = c.id \
          RETURNING o.id, o.kind::text, o.attempts, o.payload::text, o.created_at",
    )
    .bind(batch_size)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(id, kind, attempts, payload, created_at)| ClaimedRow {
        id,
        kind,
        attempts,
        payload,
        created_at,
    })
    .collect();
    Ok(rows)
}

/// Settle a claimed row as delivered: `status='done'`, `processed_at=now()`.
/// `reason` records a non-error terminal note (Swift `markDone(_:reason:)`).
pub async fn mark_done(pool: &PgPool, id: i64, reason: Option<&str>) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE outbox SET status='done', processed_at=now(), last_error=$2 WHERE id=$1")
        .bind(id)
        .bind(reason)
        .execute(pool)
        .await?;
    Ok(())
}

/// Settle a claimed row as permanently undeliverable: `status='failed'`. The row
/// is kept (not deleted) for postmortem, matching Swift `markFailed`.
pub async fn mark_failed(pool: &PgPool, id: i64, reason: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE outbox SET status='failed', processed_at=now(), last_error=$2 WHERE id=$1")
        .bind(id)
        .bind(reason)
        .execute(pool)
        .await?;
    Ok(())
}

/// Return a claimed row to `pending` with a backoff (`available_at` in the
/// future). `attempts` is *not* touched here — it was already incremented by the
/// claim, which is what makes retry counting deterministic (Swift `requeue`).
pub async fn requeue(
    pool: &PgPool,
    id: i64,
    backoff_seconds: i64,
    reason: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE outbox \
            SET status='pending', \
                available_at = now() + ($2::int * interval '1 second'), \
                last_error = $3 \
          WHERE id = $1",
    )
    .bind(id)
    .bind(backoff_seconds as i32)
    .bind(reason)
    .execute(pool)
    .await?;
    Ok(())
}

/// Exponential retry backoff in seconds, capped at 60: 1, 2, 4, 8, … (Swift
/// `min(Int(pow(2.0, Double(row.attempts))), 60)`). `attempts` is the value the
/// claim already incremented, so the first retry waits 2s.
pub fn backoff_seconds(attempts: i32) -> i64 {
    if attempts <= 0 {
        return 1;
    }
    if attempts >= 6 {
        return 60;
    }
    (1i64 << attempts).min(60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_matches_swift_curve_and_cap() {
        // Swift: min(pow(2, attempts), 60).
        assert_eq!(backoff_seconds(0), 1);
        assert_eq!(backoff_seconds(1), 2);
        assert_eq!(backoff_seconds(2), 4);
        assert_eq!(backoff_seconds(3), 8);
        assert_eq!(backoff_seconds(4), 16);
        assert_eq!(backoff_seconds(5), 32);
        // 2^6 = 64 → capped.
        assert_eq!(backoff_seconds(6), 60);
        assert_eq!(backoff_seconds(31), 60, "no overflow at large attempts");
        assert_eq!(backoff_seconds(i32::MAX), 60);
    }

    #[test]
    fn notify_channel_matches_trigger() {
        assert_eq!(NOTIFY_CHANNEL, "outbox");
    }
}
