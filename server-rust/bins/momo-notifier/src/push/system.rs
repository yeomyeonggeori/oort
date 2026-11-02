//! The `push_system` drain — the second consumer of the push feed (ADR-0206 D15, #4341).
//!
//! A `push_system` row is a push that names **no message**: today the test notification a member
//! sends to their own devices (`POST …/notification-diagnostics/test`). It never runs through
//! judgment — the question a test answers is "does the delivery path work", so a pause, a channel
//! mute or a kind switch must not stop it (those are what the diagnostics `GET` reports). What keeps
//! that from being a way to push strangers is the shape of this drain: the row names **one member**
//! and [`momo_push::system_targets`] has no other way to choose a token than that member's own.
//!
//! ## Delivery contract
//!
//! * **Claim** — `FOR UPDATE SKIP LOCKED` on `kind='push_system'` ([`claim_push_system_batch`]).
//!   [`claim_push_candidate_batch`](momo_outbox::claim_push_candidate_batch) never takes these rows
//!   and this claim never takes a candidate.
//! * **At least once, exactly once in effect** — the dispatch is claimed in `push_dispatch_log`
//!   (`message_id` NULL, collapse id `t:<test id>` **from the payload**) before it is sent, so a
//!   crashed run's reclaimed row skips every target already settled.
//! * **Best effort** — a test push is never retried against the relay. A relay 429/5xx is settled
//!   as the failure it is (`lastTest` then reads `failed`); a push that never reached the relay is
//!   left unsettled (`lastTest` reads `queued`, then `stalled`, and the diagnostics infer
//!   `relay_unreachable`). Only a *database* failure on our side requeues the row, with the same
//!   backoff and attempt budget as a push candidate.
//! * **Old relay** — a relay that does not know `test_notification`/`momo.system` answers 400, which
//!   is settled for good by the shared refusal path (never retried, one audit row per token per
//!   hour). The diagnostics classify that recorded refusal as `relay_outdated`.
//! * **Tokens stay healthy-or-dead on APNs' word** — a 410/`BadDeviceToken` receipt invalidates the
//!   token exactly as for any push (ADR-0204 D9), so a test also finds a dead token.
//! * **At most [`momo_push::SYSTEM_PUSH_MAX_TARGETS`] relay calls per row** — the member's most
//!   recently registered or refreshed active tokens; the rest are not tried. A system push has no
//!   message to bound it and a member chooses how many devices they register, so the cap is what
//!   keeps one `POST` from spending the relay's server-wide budget (#4341 review H-1).
//! * **Inside the server-wide budget** (ADR-0206 증보 4 G2, #5091) — every token a test is sent to
//!   spends one dispatch of the same per-minute budget the bulk layer uses
//!   ([`crate::bulk::BulkLayer::try_spend_for`]), so together they never pass
//!   `NOTIFIER_BULK_PUSH_PER_MINUTE`. A token that finds it spent is **settled**, not dropped
//!   silently: its dispatch-log row is claimed and closed `429` /
//!   [`momo_push::BUDGET_SPENT_REASON`], because a test's result *is* that row — without it
//!   `lastTest` would read `queued` and then `stalled`, and the diagnostics would infer a relay that
//!   cannot be reached. The claim comes **before** the spend, so a redelivered row spends nothing
//!   for the targets it already settled.
//! * **Not too old** (ADR-0206 증보 4 G3, #5091) — a test row older than
//!   [`momo_push::TEST_NOTIFICATION_MAX_AGE_SECS`] when it is claimed (a notifier that was stopped
//!   for a while finds its backlog) is **not sent**: each of the member's current tokens gets a
//!   dispatch-log row closed `408` / [`momo_push::TEST_EXPIRED_REASON`] and the outbox row is `done`
//!   with a note. A test asks "does it work now"; a push that arrives minutes later answers nothing.

use momo_db::sqlx;
use momo_db::with_tenant_tx;
use momo_outbox::{
    claim_push_system_batch, reclaim_stuck_push_system, ClaimedPushSystem, PushSystemPayload,
    PushSystemReason,
};
use momo_push::{
    claim_system_dispatch, settle_dispatch, settle_system_dispatch_unsent, system_targets,
    test_notification_dispatch_target, unread_badge, DispatchClaim, DispatchOutcome, PushDispatch,
    SystemTarget, BUDGET_SPENT_REASON, BUDGET_SPENT_STATUS, TEST_EXPIRED_REASON,
    TEST_EXPIRED_STATUS, TEST_NOTIFICATION_MAX_AGE_SECS,
};
use uuid::Uuid;

use super::{DrainStats, PushDrain, TokenFacts};
use crate::bulk::Cause;

/// The HTTP status inside a transient failure's text (`HTTP 429`, `HTTP 503`), or `None` for a
/// transport failure that has no status (the relay was never reached, or never answered).
fn relay_http_status_of(reason: &str) -> Option<i32> {
    reason
        .strip_prefix("HTTP ")?
        .split(':')
        .next()?
        .trim()
        .parse()
        .ok()
}

impl PushDrain {
    /// Return `push_system` rows a previous run left mid-flight. Once, before draining.
    pub async fn reclaim_stuck_system(&self) {
        match reclaim_stuck_push_system(&self.pool).await {
            Ok(0) => {}
            Ok(count) => tracing::info!(count, "reclaimed stuck push_system rows"),
            Err(error) => tracing::warn!(
                error = %error,
                "push_system startup sweep failed; stuck rows wait for the next boot"
            ),
        }
    }

    /// Claim and process one batch of `push_system` rows.
    pub async fn drain_system_once(&self, batch_size: i64) -> Result<DrainStats, sqlx::Error> {
        let claimed = claim_push_system_batch(&self.pool, batch_size).await?;
        let mut stats = DrainStats {
            claimed: claimed.len(),
            ..DrainStats::default()
        };
        for row in claimed {
            self.process_system_row(row, &mut stats).await;
        }
        Ok(stats)
    }

    /// [`PushDrain::drain_system_once`] until a claim comes back short, handing the failure back
    /// instead of logging it (the run loop backs off on it, as for the candidate drain).
    pub async fn drain_system_until_error(
        &self,
        batch_size: i64,
    ) -> (DrainStats, Option<sqlx::Error>) {
        let mut total = DrainStats::default();
        loop {
            match self.drain_system_once(batch_size).await {
                Ok(stats) => {
                    let claimed = stats.claimed;
                    total.claimed += stats.claimed;
                    total.dispatched += stats.dispatched;
                    total.skipped_already_settled += stats.skipped_already_settled;
                    total.requeued += stats.requeued;
                    total.failed += stats.failed;
                    total.held_back += stats.held_back;
                    if claimed < batch_size as usize {
                        // Tests held back (budget spent, expired) are counted with the bulk layer's.
                        self.log_bulk_changes();
                        return (total, None);
                    }
                }
                Err(error) => {
                    self.log_bulk_changes();
                    return (total, Some(error));
                }
            }
        }
    }

    async fn process_system_row(&self, row: ClaimedPushSystem, stats: &mut DrainStats) {
        let payload = match PushSystemPayload::decode(&row.payload) {
            Ok(payload) => payload,
            Err(error) => {
                // A payload this loop cannot read — or a reason this build does not know — will
                // not become readable or known by waiting. Park it; never guess what to send.
                tracing::error!(
                    outbox_id = row.id,
                    error = %error,
                    "push_system payload decode failed; marking failed"
                );
                self.settle_outbox_failed(row.id, &format!("payload decode: {error}"), stats)
                    .await;
                return;
            }
        };
        // `Ok(None)`: delivered (or nothing to deliver) and finished. `Ok(Some(note))`: deliberately
        // not sent, finished with the note. `Err`: our own database failed, retry the row.
        let delivered: Result<Option<String>, String> = match payload.reason {
            PushSystemReason::TestNotification => {
                if row.age_secs > TEST_NOTIFICATION_MAX_AGE_SECS as f64 {
                    self.expire_test_notification(row.workspace_id, &payload, row.age_secs, stats)
                        .await
                        .map(Some)
                } else {
                    self.deliver_test_notification(row.workspace_id, &payload, stats)
                        .await
                        .map(|()| None)
                }
            }
        };
        match delivered {
            Ok(None) => self.settle_outbox_done(row.id, stats).await,
            Ok(Some(note)) => self.settle_outbox_done_with_note(row.id, &note).await,
            // Our own database failed (never the relay's answer): the row is retried, and the
            // claim in the dispatch log keeps a retry from sending a target twice.
            Err(reason) => self.requeue_row(row.id, row.attempts, &reason, stats).await,
        }
    }

    /// A test row that waited longer than [`TEST_NOTIFICATION_MAX_AGE_SECS`] before it was claimed:
    /// nothing is sent. Each of the member's current tokens (the same most-recent set a fresh test
    /// would have gone to) gets its dispatch-log row claimed and closed `408` /
    /// `notifier_test_expired` in one tenant transaction, so `lastTest` reads `failed` instead of
    /// `stalled` and the diagnostics do not infer an unreachable relay from a test this notifier
    /// itself discarded. Returns the note for the finished outbox row; `Err` is a database failure
    /// on our side and means "retry the row" (it is still too old next time).
    async fn expire_test_notification(
        &self,
        workspace_id: Uuid,
        payload: &PushSystemPayload,
        age_secs: f64,
        stats: &mut DrainStats,
    ) -> Result<String, String> {
        let member_id = payload.member_id;
        let collapse = payload.collapse_id.clone();
        let settled = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let targets = system_targets(conn, workspace_id, member_id).await?;
                for target in &targets {
                    settle_system_dispatch_unsent(
                        conn,
                        workspace_id,
                        member_id,
                        target.token_id,
                        &collapse,
                        TEST_EXPIRED_STATUS,
                        TEST_EXPIRED_REASON,
                    )
                    .await?;
                }
                Ok(targets.len())
            })
        })
        .await
        .map_err(|error| format!("settling an expired test failed: {error}"))?;
        for _ in 0..settled {
            self.bulk
                .count_for(PushSystemReason::TestNotification.as_str(), Cause::Expired);
        }
        stats.held_back += settled;
        tracing::info!(
            collapse_id = %payload.collapse_id,
            age_secs = age_secs as i64,
            max_age_secs = TEST_NOTIFICATION_MAX_AGE_SECS,
            targets = settled,
            "stale test notification settled unsent"
        );
        Ok(format!(
            "expired: {}s old, a test is not sent after {TEST_NOTIFICATION_MAX_AGE_SECS}s",
            age_secs as i64
        ))
    }

    /// Send one test notification to the payload's member's active tokens (the most recent
    /// [`momo_push::SYSTEM_PUSH_MAX_TARGETS`] of them). `Err` is a
    /// database failure on our side and means "retry the row"; every relay outcome is `Ok`.
    async fn deliver_test_notification(
        &self,
        workspace_id: Uuid,
        payload: &PushSystemPayload,
        stats: &mut DrainStats,
    ) -> Result<(), String> {
        let member_id = payload.member_id;
        let targets = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move { system_targets(conn, workspace_id, member_id).await })
        })
        .await
        .map_err(|error| format!("system targets failed: {error}"))?;
        // Nobody to send to (the tokens died since the request) is a finished row, not a failure,
        // and leaves no dispatch-log row.
        for target in &targets {
            self.send_test_notification(workspace_id, payload, target, stats)
                .await?;
        }
        Ok(())
    }

    async fn send_test_notification(
        &self,
        workspace_id: Uuid,
        payload: &PushSystemPayload,
        target: &SystemTarget,
        stats: &mut DrainStats,
    ) -> Result<(), String> {
        let member_id = payload.member_id;
        let token_id = target.token_id;
        let collapse = payload.collapse_id.clone();

        // Claim the dispatch slot (message_id NULL) and read the real badge in one tenant
        // transaction, then leave it before touching the network.
        let claimed = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let claim =
                    claim_system_dispatch(conn, workspace_id, member_id, token_id, &collapse)
                        .await?;
                let badge = match claim {
                    DispatchClaim::AlreadySettled => 0,
                    DispatchClaim::Claimed { .. } => {
                        unread_badge(conn, workspace_id, member_id).await?
                    }
                };
                Ok((claim, badge))
            })
        })
        .await
        .map_err(|error| format!("dispatch-log claim failed: {error}"))?;
        let (claim, badge) = claimed;
        let log_id = match claim {
            DispatchClaim::AlreadySettled => {
                stats.skipped_already_settled += 1;
                return Ok(());
            }
            DispatchClaim::Claimed { log_id } => log_id,
        };

        // The server-wide budget (ADR-0206 증보 4 G2), spent only for a token this run owns — one
        // already settled returned above without costing anything. A token that finds it spent is
        // settled, not forgotten: see the module docs for why a test's row must exist.
        if !self
            .bulk
            .try_spend_for(PushSystemReason::TestNotification.as_str())
        {
            self.settle_budget_spent(workspace_id, log_id).await?;
            stats.held_back += 1;
            tracing::debug!(
                collapse_id = %payload.collapse_id,
                "test notification past the server-wide budget; settled, not sent"
            );
            return Ok(());
        }

        let dispatch = PushDispatch::new(&test_notification_dispatch_target(
            &self.config.server_id,
            workspace_id,
            target,
            &payload.collapse_id,
            badge,
        ));
        let token = TokenFacts::from(target);
        match self.dispatcher.dispatch(&dispatch).await {
            DispatchOutcome::Accepted {
                apns_status,
                apns_reason,
            } => {
                self.settle_receipt(workspace_id, log_id, &token, apns_status, apns_reason)
                    .await;
                stats.dispatched += 1;
            }
            DispatchOutcome::PermanentFailure {
                relay_http_status,
                reason,
            } => {
                // The relay itself said no and retrying cannot change it — an old relay refusing
                // the new vocabulary is the case this exists for. Settled with the relay's real
                // status and the `relay_http:` prefix (the diagnostics' evidence for
                // `relay_outdated`), never touching the token.
                tracing::error!(
                    collapse_id = %payload.collapse_id,
                    relay_http_status,
                    reason = %reason,
                    "test notification refused by the relay; settled, not retried"
                );
                self.settle_refusal(workspace_id, log_id, &token, relay_http_status, &reason)
                    .await;
                stats.dispatched += 1;
            }
            DispatchOutcome::TransientFailure(reason) => {
                // Best effort: no retry, so one press is one try and the budget it spent is
                // honest. A relay that answered 429/5xx is settled as that answer; one that never
                // answered leaves the claim unsettled so `lastTest` ages to `stalled` and the
                // diagnostics infer `relay_unreachable`.
                stats.held_back += 1;
                match relay_http_status_of(&reason) {
                    Some(status) => {
                        tracing::warn!(
                            collapse_id = %payload.collapse_id,
                            relay_http_status = status,
                            "test notification not accepted by the relay; settled, not retried"
                        );
                        self.settle_test_failure(workspace_id, log_id, status, &reason)
                            .await;
                    }
                    None => tracing::warn!(
                        collapse_id = %payload.collapse_id,
                        reason = %reason,
                        "test notification never reached the relay; left unsettled, not retried"
                    ),
                }
            }
        }
        Ok(())
    }

    /// Close a claimed test dispatch the server-wide budget had no room for: `429` /
    /// `notifier_budget_spent`. Not an APNs answer and not the relay's (it was never called), so no
    /// `relay_http:` prefix; it never touches the token. `Err` is our database failing, and the row
    /// is retried rather than left unsettled.
    async fn settle_budget_spent(&self, workspace_id: Uuid, log_id: Uuid) -> Result<(), String> {
        with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                settle_dispatch(conn, log_id, BUDGET_SPENT_STATUS, Some(BUDGET_SPENT_REASON)).await
            })
        })
        .await
        .map_err(|error| format!("settling a budget-spent test failed: {error}"))
    }

    /// Settle a best-effort test push the relay answered 429/5xx: the answer's status and the
    /// `relay_http:` prefix, so no later pass can read it as an APNs receipt.
    async fn settle_test_failure(
        &self,
        workspace_id: Uuid,
        log_id: Uuid,
        status: i32,
        reason: &str,
    ) {
        let recorded = format!("relay_http: {reason}");
        let result = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move { settle_dispatch(conn, log_id, status, Some(&recorded)).await })
        })
        .await;
        if let Err(error) = result {
            // The claim stays unsettled: the test reads `queued`, then `stalled`. Loud, not fatal.
            tracing::error!(%log_id, error = %error, "failed to settle a failed test notification");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The status a transient failure's text carries: only `HTTP <n>` forms; a transport failure
    /// has none, and nothing else is read as a status.
    #[test]
    fn a_transient_failure_carries_a_status_only_when_the_relay_answered() {
        assert_eq!(relay_http_status_of("HTTP 429"), Some(429));
        assert_eq!(relay_http_status_of("HTTP 503"), Some(503));
        assert_eq!(relay_http_status_of("HTTP 502: bad gateway"), Some(502));
        assert_eq!(
            relay_http_status_of("relay dispatch failed: connection refused"),
            None
        );
        assert_eq!(relay_http_status_of("relay signature failed: x"), None);
        assert_eq!(relay_http_status_of("HTTP abc"), None);
        assert_eq!(relay_http_status_of(""), None);
    }
}
