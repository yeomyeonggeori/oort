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
