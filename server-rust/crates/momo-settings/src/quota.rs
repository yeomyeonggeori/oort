//! `quota_snapshot` — the **read** half of the provider quota gauge
//! (migration 043, MOMO-623 / ADR-0135 D2).
//!
//! Port of `Routes/ProviderQuotaSnapshotRoutes.list` (:110-139) and `readAll`
//! (:394-409).
//!
//! The write half (`POST /v1/provider/quota-snapshots`) is deliberately **not**
//! in this batch: it is an agent-bearer surface gated on the dedicated
//! `provider:quota:write` scope, and the web client — the contract source for
//! this batch — only ever reads. That asymmetry is the ADR-0135 D2 decision
//! itself: momo never calls a provider quota API, it accepts the numbers from
//! the side that already holds the credential (ADR-0004 자격증명 비유입).
//!
//! RLS split: migration 043 gives this table two policies — a GUC-gated ingest
//! policy and a **member read** policy that only needs a non-empty
//! `app.workspace_id`. So the read below runs in a plain tenant transaction, and
//! an unscoped session still sees nothing.

use chrono::{DateTime, Utc};
use momo_db::DbError;
use sqlx::PgConnection;

/// One stored gauge. `remaining_ratio` is 0..1 **remaining**, never consumed —
/// flipping the sense is how a full bar comes to mean "you are out".
#[derive(Debug, Clone, PartialEq)]
pub struct QuotaSnapshot {
    pub provider_ref: String,
    /// ADR-0135's wire name; the column is `quota_window` because `window` is a
    /// PostgreSQL reserved keyword.
    pub window: String,
    pub remaining_ratio: f64,
    pub resets_at: Option<DateTime<Utc>>,
    pub probed_at: DateTime<Utc>,
    pub ingested_at: DateTime<Utc>,
}

/// One `quota_snapshot` row as it comes off the wire.
type QuotaRow = (
    String,
    String,
    f64,
    Option<DateTime<Utc>>,
    DateTime<Utc>,
    DateTime<Utc>,
);

/// Every gauge, ordered provider-then-`short`-before-`weekly` (Swift :398-405).
///
/// The window ordering is a `CASE`, not alphabetical: the short rolling window is
/// the one an operator acts on first, and 'short' sorts after 'weekly'.
pub async fn list_quota_snapshots(conn: &mut PgConnection) -> Result<Vec<QuotaSnapshot>, DbError> {
    let rows: Vec<QuotaRow> = sqlx::query_as(
        "SELECT provider_ref, quota_window, remaining_ratio, \
                resets_at, probed_at, ingested_at \
           FROM quota_snapshot \
          ORDER BY provider_ref ASC, \
                   CASE quota_window WHEN 'short' THEN 0 ELSE 1 END ASC",
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(provider_ref, window, remaining_ratio, resets_at, probed_at, ingested_at)| {
                QuotaSnapshot {
                    provider_ref,
                    window,
                    remaining_ratio,
                    resets_at,
                    probed_at,
                    ingested_at,
                }
            },
        )
        .collect())
}

impl QuotaSnapshot {
    /// Seconds since the probe, computed on the **server** clock (Swift :474-477).
    ///
    /// The client is explicitly forbidden from deriving this from `probedAt`
    /// (`clients/web/src/features/settings/quotaModel.ts:47-51`): the two clocks
    /// belong to the adapter and to a browser, and a laptop four minutes fast
    /// would otherwise render a probe from the future.
    pub fn age_seconds(&self, now: DateTime<Utc>) -> i64 {
        (now - self.probed_at).num_seconds().max(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(probed_at: DateTime<Utc>) -> QuotaSnapshot {
        QuotaSnapshot {
            provider_ref: "codex".into(),
            window: "short".into(),
            remaining_ratio: 0.42,
            resets_at: None,
            probed_at,
            ingested_at: probed_at,
        }
    }

    #[test]
    fn age_is_never_negative_even_when_the_probe_leads_the_server_clock() {
        let now = DateTime::from_timestamp(1_700_000_000, 0).expect("now");
        let ahead = DateTime::from_timestamp(1_700_000_240, 0).expect("ahead");
        assert_eq!(snapshot(now).age_seconds(now), 0);
        assert_eq!(
            snapshot(now).age_seconds(ahead),
            240,
            "a four-minute-old probe is four minutes old"
        );
        assert_eq!(
            snapshot(ahead).age_seconds(now),
            0,
            "a probe from the future is reported as fresh, never as a negative age"
        );
    }
}
