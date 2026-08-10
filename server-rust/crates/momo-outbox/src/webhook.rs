//! The `webhook_delivery` consumer's outbox SQL (#1222 / T13).
//!
//! The fifth feed on the `outbox` table, and — like the other four — it lives in
//! this crate because this crate owns every `outbox` statement in the workspace
//! (invariant #3). Its `WHERE` clause is disjoint from all of them by `kind`, so
//! the relay's broadcast drain, the gateway's lease, the agent worker's job and
//! the notifier's push candidates are all untouched by its arrival.
//!
//! ## Why this is a separate consumer and not the relay
//!
//! `crates/momo-outbox/src/relay.rs:82` and `bins/momo-relay/src/lib.rs:23` both
//! say the relay is **broadcast only** and that `webhook_delivery` must not be
//! drained there. That is not a filing preference — the relay is the workspace's
//! *only Centrifugo writer* (invariant #2), and the property that makes the
//! claim credible is that its dependency graph contains one HTTP destination.
//! Teaching it to POST an operator-supplied URL would replace "the relay talks
//! to Centrifugo" with "the relay talks to whatever a row says", and every
//! reader of that invariant would have to re-derive it from the code. So the
//! webhook sender is its own binary with its own credential and its own claim,
//! and the two loops meet only through disjoint `kind` predicates.
//!
//! ## Settlement is a transaction, and the audit is deliberately outside it
//!
//! A 5xx from a subscriber moves two rows: the outbox row (retry or fail) and
//! the subscription's failure ledger (count, possibly disable). Those must
//! commit together or a subscription can be disabled for a delivery that was
//! then retried anyway. The **egress audit** is the opposite case and is written
//! separately by the caller (`momo_webhook::record_delivery_audit`): the bytes
//! have already left, so a queue-side rollback must not erase the record of it.

use sqlx::{PgConnection, PgPool};

use crate::relay::ClaimedRow;

/// Claim up to `batch_size` pending **`webhook_delivery`** rows and flip them to
/// `processing` in one statement, `FOR UPDATE SKIP LOCKED`.
///
/// The mirror of [`crate::relay::claim_broadcast_batch`], narrowed to the other
/// kind. `partition_key` is the subscription id (migration 033 sets it), so two
/// senders can work different subscriptions concurrently while the row lock
/// keeps either from taking the same delivery twice.
pub async fn claim_webhook_delivery_batch(
    pool: &PgPool,
    batch_size: i64,
) -> Result<Vec<ClaimedRow>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (i64, String, i32, String, chrono::DateTime<chrono::Utc>)>(
        "WITH claimed AS ( \
             SELECT id FROM outbox \
              WHERE kind = 'webhook_delivery' \
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
// Transaction-scoped settlement
//
// The pool-level twins in `relay` settle a row on their own. These take a
// connection so the caller can settle the outbox row and the subscription's
// failure ledger in ONE transaction — see the module header.
// ---------------------------------------------------------------------------

/// `status='done'` inside the caller's transaction. `reason` is a non-error
/// terminal note (`"subscription missing"`, `"subscription disabled"`).
pub async fn mark_done_in_tx(
    conn: &mut PgConnection,
    id: i64,
    reason: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE outbox SET status='done', processed_at=now(), last_error=$2 WHERE id=$1")
        .bind(id)
        .bind(reason)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// `status='failed'` inside the caller's transaction. The row is kept for
/// postmortem, never deleted.
pub async fn mark_failed_in_tx(
    conn: &mut PgConnection,
    id: i64,
    reason: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE outbox SET status='failed', processed_at=now(), last_error=$2 WHERE id=$1")
        .bind(id)
        .bind(reason)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Back to `pending` with a backoff, inside the caller's transaction.
/// `attempts` is untouched — the claim already incremented it, which is what
/// makes retry counting deterministic.
pub async fn requeue_in_tx(
    conn: &mut PgConnection,
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
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    /// The two claims must never overlap, or the relay would publish a webhook
    /// payload to Centrifugo and the sender would POST a broadcast frame to a
    /// subscriber. The predicate is the whole guarantee, so it is asserted as
    /// text rather than left to a runtime that needs a database.
    #[test]
    fn the_two_claims_are_disjoint_by_kind() {
        let webhook = include_str!("webhook.rs");
        let relay = include_str!("relay.rs");
        assert!(webhook.contains("kind = 'webhook_delivery'"));
        assert!(relay.contains("kind = 'broadcast'"));
        // Spelled in two pieces so this assertion does not match itself.
        let widened = concat!("kind IN", " (");
        assert!(
            !webhook.contains(widened),
            "the sender must claim exactly one kind; a widened predicate would \
             let it drain the relay's feed"
        );
    }
}
