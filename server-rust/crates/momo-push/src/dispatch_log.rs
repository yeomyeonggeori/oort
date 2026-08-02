//! Idempotent dispatch — `push_dispatch_log` as a claim, not just an audit.
//!
//! Port of `NotifierService.dispatchOne` / `settleDispatch`
//! (`NotifierService.swift:480-610`).
//!
//! Candidates arrive **at least once** (a crash between claim and settle
//! replays them), so "send exactly once" has to be a property of the database,
//! not of the loop. Migration 011's partial unique index
//! `push_dispatch_dedupe_uniq (member_id, push_token_id, collapse_id)` is that
//! property: inserting the row *is* the claim.
//!
//! Three states, and each one has a different correct answer:
//!
//! | insert result | meaning | action |
//! |---|---|---|
//! | inserted | first claim | send |
//! | conflict, `apns_status` set | already dispatched | **skip** |
//! | conflict, `apns_status` NULL | a crashed in-flight claim | take over and re-send |
//!
//! The last row is why duplicates are bounded rather than impossible: a process
//! that dies mid-flight leaves an unsettled claim, and re-sending it is safer
//! than dropping a notification. `apns-collapse-id` makes the rare APNs-side
//! duplicate replace the earlier one on the device instead of stacking.

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// The outcome of claiming a dispatch slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchClaim {
    /// This process owns the send. Carries the log row to settle afterwards.
    Claimed { log_id: Uuid },
    /// Someone already dispatched this (member, token, collapse_id). Skip.
    AlreadySettled,
}

/// Claim the right to dispatch one target, idempotently.
///
/// `ON CONFLICT ... DO NOTHING` plus the follow-up read is one statement so two
/// notifier instances racing the same candidate cannot both believe they won.
pub async fn claim_dispatch(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
    member_id: Uuid,
    token_id: Uuid,
    collapse_id: &str,
) -> Result<DispatchClaim, DbError> {
    let row = sqlx::query(
        "WITH ins AS ( \
           INSERT INTO push_dispatch_log \
             (workspace_id, message_id, member_id, push_token_id, collapse_id) \
           VALUES ($1, $2, $3, $4, $5) \
           ON CONFLICT (member_id, push_token_id, collapse_id) \
             WHERE push_token_id IS NOT NULL AND collapse_id IS NOT NULL \
           DO NOTHING \
           RETURNING id \
         ) \
         SELECT id, false AS settled FROM ins \
         UNION ALL \
         SELECT l.id, l.apns_status IS NOT NULL AS settled \
           FROM push_dispatch_log l \
          WHERE l.member_id = $3 \
            AND l.push_token_id = $4 \
            AND l.collapse_id = $5 \
            AND NOT EXISTS (SELECT 1 FROM ins) \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(message_id)
    .bind(member_id)
    .bind(token_id)
    .bind(collapse_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else {
        // Neither inserted nor found: the row was deleted between the two
        // halves, which should be impossible. Surface it rather than sending.
        return Err(DbError::Sqlx(sqlx::Error::RowNotFound));
    };

    let settled: bool = row.get("settled");
    if settled {
        return Ok(DispatchClaim::AlreadySettled);
    }
    Ok(DispatchClaim::Claimed {
        log_id: row.get("id"),
    })
}

/// Record the APNs receipt against a claimed dispatch.
///
/// Settling is what turns the claim into a permanent "already sent" marker, so
/// a redelivered candidate skips it.
pub async fn settle_dispatch(
    conn: &mut PgConnection,
    log_id: Uuid,
    apns_status: i32,
    apns_reason: Option<&str>,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE push_dispatch_log \
            SET apns_status = $2, apns_reason = $3 \
          WHERE id = $1",
    )
    .bind(log_id)
    .bind(apns_status)
    .bind(apns_reason)
    .execute(&mut *conn)
    .await?;
    Ok(())
}
