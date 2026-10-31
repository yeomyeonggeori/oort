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
//!
//! ## Dead tokens (ADR-0204 D9 = ADR-0120 D4)
//!
//! Settling is also where the receipt is read for token health. APNs answering
//! `410`, or `400` with `BadDeviceToken` / `DeviceTokenNotForTopic`, means the
//! token will never receive a push again; [`settle_dispatch_and_invalidate`]
//! sets `push_token.invalidated_at` **in the same transaction** as the receipt,
//! so the next judgment (which selects only `invalidated_at IS NULL`) skips it.
//! Anything the relay itself refused (HTTP 4xx that is not a receipt) goes
//! through [`settle_relay_refusal`] instead and never touches the token.

use momo_db::audit::{write_audit, AuditEntry};
use momo_db::DbError;
use serde_json::json;
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

/// Has this (member, token, collapse id) already been dispatched and settled? A **read only** — it
/// claims nothing and leaves no row. The bulk layer (ADR-0206 증보 1 F6) asks it before it counts a
/// message against a window or spends the server budget, so a redelivered candidate and the messages
/// folded under an already-sent representative cost neither. A claim that was taken but never settled
/// (a crashed in-flight send) is *not* settled: [`claim_dispatch`] takes those over.
pub async fn is_dispatch_settled(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    token_id: Uuid,
    collapse_id: &str,
) -> Result<bool, DbError> {
    let settled: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM push_dispatch_log \
            WHERE workspace_id = $1 \
              AND member_id = $2 \
              AND push_token_id = $3 \
              AND collapse_id = $4 \
              AND apns_status IS NOT NULL)",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(token_id)
    .bind(collapse_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(settled)
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

// ---------------------------------------------------------------------------
// dead tokens
// ---------------------------------------------------------------------------

/// Why APNs said a device token is dead for good.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeadTokenReason {
    /// HTTP `410`, whatever reason string comes with it (`Unregistered` in
    /// practice): the token is no longer active for the topic.
    Gone,
    /// HTTP `400` + `BadDeviceToken`: the token is malformed or not a token of
    /// this environment.
    BadDeviceToken,
    /// HTTP `400` + `DeviceTokenNotForTopic`: the token belongs to another app.
    DeviceTokenNotForTopic,
}

impl DeadTokenReason {
    /// A stable label for logs and tests. Never the token itself.
    pub fn as_str(self) -> &'static str {
        match self {
            DeadTokenReason::Gone => "gone",
            DeadTokenReason::BadDeviceToken => "bad_device_token",
            DeadTokenReason::DeviceTokenNotForTopic => "device_token_not_for_topic",
        }
    }
}

/// Read an APNs receipt for token health: `Some` only for the three answers
/// that mean the token is dead for good (ADR-0204 D9).
///
/// Deliberately narrow. `403` (`ExpiredProviderToken`, `InvalidProviderToken`),
/// `400 BadTopic`, `413`, `429`, `5xx` and a plain `200` are the operator's or the
/// network's business, and revoking a healthy token over them would silence a
/// person's phone. The reason strings are APNs' own, compared exactly: a relay's
/// `relay_http: ...` text can never match, and neither can a near-miss spelling.
pub fn dead_token_reason(apns_status: i32, apns_reason: Option<&str>) -> Option<DeadTokenReason> {
    match (apns_status, apns_reason) {
        (410, _) => Some(DeadTokenReason::Gone),
        (400, Some("BadDeviceToken")) => Some(DeadTokenReason::BadDeviceToken),
        (400, Some("DeviceTokenNotForTopic")) => Some(DeadTokenReason::DeviceTokenNotForTopic),
        _ => None,
    }
}

/// What [`settle_dispatch_and_invalidate`] did beyond recording the receipt.
/// The receipt itself is always recorded when this is returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettleOutcome {
    /// The receipt said nothing about the token's health.
    Settled,
    /// The token is dead and `invalidated_at` is now set.
    Invalidated(DeadTokenReason),
    /// The token is dead but no live row matched (already invalidated by a
    /// re-registration or a racing settle, or not this tenant's): nothing to do.
    NoLiveToken(DeadTokenReason),
    /// The token is dead but the invalidating `UPDATE` failed — a role without the
    /// grant during a rolling deploy is the expected cause. It was rolled back to
    /// its savepoint, so the receipt (the claim that stops a duplicate send) is
    /// still recorded; the caller must log `error` loudly.
    InvalidationFailed {
        reason: DeadTokenReason,
        error: String,
    },
}

/// Record the APNs receipt against a claimed dispatch and, when the receipt says
/// the token is dead, invalidate it in the same transaction.
///
/// The receipt comes first and must succeed: it is what turns the claim into a
/// permanent "already sent" marker. The invalidation runs inside a `SAVEPOINT`, so
/// a failure there (a missing `UPDATE` grant on a deploy that ordered the notifier
/// before the role file, a trigger, a lock timeout) rolls back only itself. The
/// alternative — letting it poison the transaction — would leave the claim
/// unsettled and re-send the notification on every redelivery.
///
/// The `UPDATE` names the tenant as well as the row (`workspace_id`), is a no-op on
/// an already invalid token (`invalidated_at IS NULL`), and sets only the two
/// columns the production `momo_notifier` role may write.
pub async fn settle_dispatch_and_invalidate(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    log_id: Uuid,
    token_id: Uuid,
    apns_status: i32,
    apns_reason: Option<&str>,
) -> Result<SettleOutcome, DbError> {
    settle_dispatch(conn, log_id, apns_status, apns_reason).await?;
    let Some(reason) = dead_token_reason(apns_status, apns_reason) else {
        return Ok(SettleOutcome::Settled);
    };

    let mut savepoint = sqlx::Connection::begin(&mut *conn).await?;
    let invalidated = sqlx::query(
        "UPDATE push_token \
            SET invalidated_at = now(), updated_at = now() \
          WHERE id = $1 AND workspace_id = $2 AND invalidated_at IS NULL",
    )
    .bind(token_id)
    .bind(workspace_id)
    .execute(&mut *savepoint)
    .await;
    match invalidated {
        Ok(done) => {
            savepoint.commit().await?;
            if done.rows_affected() > 0 {
                Ok(SettleOutcome::Invalidated(reason))
            } else {
                Ok(SettleOutcome::NoLiveToken(reason))
            }
        }
        Err(error) => {
            savepoint.rollback().await?;
            Ok(SettleOutcome::InvalidationFailed {
                reason,
                error: error.to_string(),
            })
        }
    }
}

// ---------------------------------------------------------------------------
// relay refusals
// ---------------------------------------------------------------------------

/// `audit_log.action` of a relay refusal.
pub const AUDIT_RELAY_REFUSED: &str = "push.relay.refused";

/// The `detail.schema` of a relay-refusal audit row.
pub const AUDIT_RELAY_REFUSED_SCHEMA: &str = "momo.push.relay.refused.v1";

/// A relay answer that was not an APNs receipt: the relay itself said no
/// (a 4xx other than 429). Carries what an operator needs to find the cause and
/// nothing that identifies the person or the token's value.
#[derive(Debug, Clone)]
pub struct RelayRefusal<'a> {
    pub relay_http_status: i32,
    /// The relay's own words (status line plus the start of its body), already
    /// bounded and stripped of control characters by the transport.
    pub reason: &'a str,
    pub token_id: Uuid,
    pub apns_env: &'a str,
    pub apns_topic: &'a str,
    pub device_platform: &'a str,
}

/// What [`settle_relay_refusal`] did beyond recording the refusal. The refusal
/// itself is always recorded when this is returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefusalOutcome {
    /// Recorded; this status is not one the audit covers.
    Settled,
    /// Recorded, and one `push.relay.refused` audit row was written.
    Audited,
    /// Recorded; the token already has such a row inside the window.
    AuditedRecently,
    /// Recorded, but the audit row could not be written (rolled back to its
    /// savepoint). The caller must log `error`.
    AuditFailed { error: String },
}

/// Record a relay refusal against a claimed dispatch.
///
/// The log row carries the relay's real HTTP status with a `relay_http:` prefix, so
/// no later pass can mistake it for an APNs answer (review #424 M1). The token is
/// **never** invalidated here: a relay `400` — an environment that does not match
/// the relay's, a bad topic, a vocabulary the relay does not know — says the
/// *deployment* is wrong, and revoking every device it touches would be the
/// outage. Instead a `400` leaves one audit row per token per hour (ADR-0204 D9).
pub async fn settle_relay_refusal(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    log_id: Uuid,
    refusal: &RelayRefusal<'_>,
) -> Result<RefusalOutcome, DbError> {
    let recorded = format!("relay_http: {}", refusal.reason);
    settle_dispatch(conn, log_id, refusal.relay_http_status, Some(&recorded)).await?;
    if refusal.relay_http_status != 400 {
        return Ok(RefusalOutcome::Settled);
    }

    // The audit is worth less than the receipt: in a savepoint, so a failure here
    // (a role without the grant, a constraint) cannot undo the settle above.
    let mut savepoint = sqlx::Connection::begin(&mut *conn).await?;
    match audit_relay_refusal(&mut savepoint, workspace_id, refusal).await {
        Ok(outcome) => {
            savepoint.commit().await?;
            Ok(outcome)
        }
        Err(error) => {
            savepoint.rollback().await?;
            Ok(RefusalOutcome::AuditFailed {
                error: error.to_string(),
            })
        }
    }
}

/// One `push.relay.refused` row per token per hour.
async fn audit_relay_refusal(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    refusal: &RelayRefusal<'_>,
) -> Result<RefusalOutcome, DbError> {
    let recent: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM audit_log \
            WHERE workspace_id = $1 \
              AND action = $2 \
              AND target_type = 'push_token' \
              AND target_id = $3 \
              AND created_at > now() - interval '1 hour')",
    )
    .bind(workspace_id)
    .bind(AUDIT_RELAY_REFUSED)
    .bind(refusal.token_id)
    .fetch_one(&mut *conn)
    .await?;
    if recent {
        return Ok(RefusalOutcome::AuditedRecently);
    }

    write_audit(
        conn,
        &AuditEntry::new(workspace_id, AUDIT_RELAY_REFUSED)
            .target("push_token", refusal.token_id)
            .with_schema(
                AUDIT_RELAY_REFUSED_SCHEMA,
                json!({
                    "relay_http_status": refusal.relay_http_status,
                    "reason": refusal.reason,
                    "apns_env": refusal.apns_env,
                    "apns_topic": refusal.apns_topic,
                    "device_platform": refusal.device_platform,
                    "token_invalidated": false,
                }),
            ),
    )
    .await?;
    Ok(RefusalOutcome::Audited)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_three_answers_that_mean_a_dead_token_say_so() {
        assert_eq!(
            dead_token_reason(410, Some("Unregistered")),
            Some(DeadTokenReason::Gone)
        );
        assert_eq!(
            dead_token_reason(410, None),
            Some(DeadTokenReason::Gone),
            "a 410 is dead whatever the reason string says"
        );
        assert_eq!(
            dead_token_reason(410, Some("SomethingNew")),
            Some(DeadTokenReason::Gone)
        );
        assert_eq!(
            dead_token_reason(400, Some("BadDeviceToken")),
            Some(DeadTokenReason::BadDeviceToken)
        );
        assert_eq!(
            dead_token_reason(400, Some("DeviceTokenNotForTopic")),
            Some(DeadTokenReason::DeviceTokenNotForTopic)
        );
    }

    #[test]
    fn everything_else_leaves_the_token_alone() {
        let alive: &[(i32, Option<&str>)] = &[
            (200, None),
            (200, Some("BadDeviceToken")),
            // the operator's problems, not the device's
            (403, Some("ExpiredProviderToken")),
            (403, Some("InvalidProviderToken")),
            (400, Some("BadTopic")),
            (400, Some("MissingTopic")),
            (400, Some("PayloadEmpty")),
            (400, None),
            (413, Some("PayloadTooLarge")),
            (429, Some("TooManyRequests")),
            (500, Some("InternalServerError")),
            (503, Some("ServiceUnavailable")),
            // a relay answer recorded with the prefix can never match
            (400, Some("relay_http: HTTP 400")),
            (400, Some("relay_http: BadDeviceToken")),
            // APNs' strings are compared exactly
            (400, Some("baddevicetoken")),
            (400, Some("BadDeviceToken ")),
            (400, Some("BadDeviceTokens")),
            (400, Some("devicetokennotfortopic")),
            // the reason of a dead token does not matter under another status
            (500, Some("BadDeviceToken")),
            (403, Some("DeviceTokenNotForTopic")),
            (411, None),
            (409, None),
        ];
        for (status, reason) in alive {
            assert_eq!(
                dead_token_reason(*status, *reason),
                None,
                "{status} {reason:?} must not invalidate a token"
            );
        }
    }

    #[test]
    fn the_reason_labels_are_stable_and_distinct() {
        let labels = [
            DeadTokenReason::Gone.as_str(),
            DeadTokenReason::BadDeviceToken.as_str(),
            DeadTokenReason::DeviceTokenNotForTopic.as_str(),
        ];
        assert_eq!(
            labels,
            ["gone", "bad_device_token", "device_token_not_for_topic"]
        );
    }
}
