//! The attachment Drive reclaim sweep (#4443, ADR-0151 증보 2).
//!
//! ## Why
//!
//! A file is uploaded before the message that carries it, so some uploads are never
//! carried: a draft nobody sent, a cancelled schedule's files, a file whose message
//! was hard-deleted. Nothing collected them, so the shared Drive only grew. This
//! sweep deletes a completed attachment that no message and no schedule holds once it
//! has been idle for [`momo_messaging::attachment_reclaim::UNBOUND_TTL`] (30 days).
//!
//! ## Shape (the avatar reclaim's two-pool shape, ADR-0161 D5)
//!
//! 1. The candidate read ([`momo_messaging::attachment_reclaim::attachment_reclaim_candidates`])
//!    runs on the notifier's own pool — the existing BYPASSRLS `momo_notifier` role, a
//!    **read** through a column-level grant (`id`, `workspace_id`, `status`,
//!    `message_id`, `reserved`, `unreserved_at`, `created_at` — never the Drive id, the
//!    file name, the mime or the uploader), the only way to see every tenant. It
//!    returns ids only.
//! 2. Every write goes through a second pool whose role must be RLS-bound
//!    (`momo_app`); [`AttachmentReclaimer::sweep_once`] checks that first and refuses
//!    otherwise. **No new RLS-bypassing write path, no new `SECURITY DEFINER`, no
//!    foreign owner binding.** Each attachment is its own tenant transaction
//!    (`SET LOCAL app.workspace_id`) in which the row is locked, eligibility is decided
//!    again, the row and its audit row are deleted/written inside a savepoint, the
//!    Drive object is deleted, and a failed Drive call takes the savepoint back — see
//!    `momo_messaging::attachment_reclaim` for the order and the race argument.
//!
//! ## What must never happen
//!
//! * A file a message carries, a file a schedule holds, or a file younger than the TTL
//!   is never deleted (decided under the row lock, from the row — not from the
//!   candidate list).
//! * Drive unreachable is not "deleted": a transient failure writes nothing and the
//!   row is retried next tick. Drive **404 is success** (idempotent).
//! * Nothing here logs a file name, a Drive id or a member id — counts only.
//! * Bounded: at most `batch` rows per tick, each Drive call under
//!   [`crate::avatar_reclaim::DELETE_TIMEOUT`] (applied by the shared
//!   `delete_outcome`), and a tick stops after a few consecutive Drive failures.
//!
//! ## What does not run here
//!
//! Only a Google Drive is reclaimed (the avatar reclaim's limit, for the same reason):
//! `momo-server`'s stub archive is in its own memory, and `LocalDriveArchive::open`
//! clears pending sessions of the process that opens it — the self-host volume, and a
//! Railway volume, belong to the api process alone. On the default `local` backend this
//! sweep is **off** and attachment bytes and rows stay where they are
//! (ADR-0151 증보 2, 남는 위험; closing it needs an api-process runner, which needs a
//! cross-tenant candidate read that only a new `SECURITY DEFINER` can give — an owner
//! decision).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_drive::DriveArchive;
use momo_messaging::attachment_reclaim::{
    attachment_reclaim_candidates, reclaim_unbound_attachment_in_tx, AttachmentReclaimCounts,
    AttachmentReclaimOutcome, UNBOUND_TTL,
};
use momo_messaging::avatar_reclaim::ensure_write_pool_rls_bound;
use uuid::Uuid;

use crate::avatar_reclaim::{delete_outcome, AvatarReclaimConfig, MAX_CONSECUTIVE_DRIVE_FAILURES};

/// Settings for the attachment reclaim. The Drive credentials are the avatar reclaim's
/// (one parser, one loader — [`AvatarReclaimConfig`]); only the cadence and the batch
/// are this sweep's own. Holds a key **path**, never key material.
#[derive(Debug, Clone)]
pub struct AttachmentReclaimConfig {
    pub interval: Duration,
    /// Attachments per tick.
    pub batch: i64,
    drive: AvatarReclaimConfig,
}

impl AttachmentReclaimConfig {
    /// Both Drive values present and the backend unset / `google` / `sa`, or `None`.
    /// A `stub` or `local` backend is deliberately `None` (see the module docs).
    pub fn parse(
        backend: Option<&str>,
        sa_key_path: Option<&str>,
        shared_drive_id: Option<&str>,
        interval: Duration,
        batch: i64,
    ) -> Option<AttachmentReclaimConfig> {
        let drive =
            AvatarReclaimConfig::parse(backend, sa_key_path, shared_drive_id, interval, batch)?;
        Some(AttachmentReclaimConfig {
            interval,
            batch: batch.max(1),
            drive,
        })
    }
}

/// What one tick did. Counts only.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentReclaimStats {
    pub workspaces: usize,
    pub counts: AttachmentReclaimCounts,
    /// Per-row transactions that failed in the database.
    pub db_errors: u32,
}

pub struct AttachmentReclaimer {
    drive: Arc<dyn DriveArchive>,
    batch: i64,
    ttl: Duration,
}

impl AttachmentReclaimer {
    pub fn new(drive: Arc<dyn DriveArchive>, batch: i64) -> AttachmentReclaimer {
        AttachmentReclaimer {
            drive,
            batch: batch.max(1),
            ttl: UNBOUND_TTL,
        }
    }

    /// Another idle time than [`UNBOUND_TTL`]. For tests only: nothing in the
    /// configuration reaches it, so an operator cannot shorten the TTL of a running
    /// instance.
    pub fn with_ttl(mut self, ttl: Duration) -> AttachmentReclaimer {
        self.ttl = ttl;
        self
    }

    /// Build the Google archive named by `config`. `None` when the service account
    /// cannot be loaded (the error carries no credential material).
    pub fn from_config(config: &AttachmentReclaimConfig) -> Option<AttachmentReclaimer> {
        config
            .drive
            .google_archive()
            .map(|archive| AttachmentReclaimer::new(archive, config.batch))
    }

    /// One iteration. `read_pool` is the BYPASSRLS notifier pool (read only);
    /// `write_pool` must be RLS-bound or this refuses to run.
    pub async fn sweep_once(
        &self,
        read_pool: &PgPool,
        write_pool: &PgPool,
    ) -> Result<AttachmentReclaimStats, DbError> {
        ensure_write_pool_rls_bound(write_pool).await?;
        let candidates = attachment_reclaim_candidates(read_pool, self.batch, self.ttl).await?;

        let mut per_workspace: HashMap<Uuid, AttachmentReclaimCounts> = HashMap::new();
        let mut stats = AttachmentReclaimStats::default();
        let drive_unavailable = Arc::new(AtomicBool::new(false));
        // A Drive that keeps failing (timeouts, 5xx) must not hold the tick for
        // batch x DELETE_TIMEOUT: stop after a few consecutive failures.
        let mut consecutive_drive_failures = 0u32;

        for candidate in candidates {
            if consecutive_drive_failures >= MAX_CONSECUTIVE_DRIVE_FAILURES {
                break;
            }
            if drive_unavailable.load(Ordering::Relaxed) {
                // No Drive configured at all: every further row would fail the
                // same way. Stop; nothing was written.
                break;
            }
            let drive = Arc::clone(&self.drive);
            let flag = Arc::clone(&drive_unavailable);
            let ttl = self.ttl;
            let result = with_tenant_tx(write_pool, candidate.workspace_id, move |conn| {
                Box::pin(async move {
                    reclaim_unbound_attachment_in_tx(
                        conn,
                        candidate.workspace_id,
                        candidate.attachment_id,
                        ttl,
                        move |file_id| {
                            Box::pin(async move { delete_outcome(&*drive, file_id, &flag).await })
                        },
                    )
                    .await
                })
            })
            .await;

            let counts = per_workspace.entry(candidate.workspace_id).or_default();
            match result {
                Ok(outcome) => {
                    counts.record(outcome);
                    if outcome == AttachmentReclaimOutcome::DriveFailed {
                        consecutive_drive_failures += 1;
                    } else {
                        consecutive_drive_failures = 0;
                    }
                }
                Err(error) => {
                    stats.db_errors += 1;
                    // Fixed text: a database error may echo relation/constraint
                    // names, and nothing here needs them.
                    let _ = &error;
                    tracing::warn!(
                        workspace_id = %candidate.workspace_id,
                        "attachment reclaim failed for an attachment (database error)"
                    );
                }
            }
        }

        stats.workspaces = per_workspace.len();
        for counts in per_workspace.values() {
            stats.counts.add(counts);
        }

        if stats.counts.reclaimed > 0 || stats.counts.refused > 0 || stats.counts.drive_failed > 0 {
            tracing::info!(
                workspaces = stats.workspaces,
                reclaimed = stats.counts.reclaimed,
                skipped = stats.counts.skipped_not_eligible,
                drive_failed = stats.counts.drive_failed,
                refused = stats.counts.refused,
                "attachment reclaim deleted Drive objects"
            );
        }
        Ok(stats)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICK: Duration = Duration::from_secs(60);

    #[test]
    fn only_a_complete_google_drive_configuration_enables_the_reclaim() {
        let parse =
            |backend, key, drive| AttachmentReclaimConfig::parse(backend, key, drive, TICK, 50);
        assert!(parse(None, Some("/k.json"), Some("0ABC")).is_some());
        assert!(parse(Some("google"), Some("/k.json"), Some("0ABC")).is_some());
        assert!(parse(Some(" SA "), Some("/k.json"), Some("0ABC")).is_some());
        assert!(parse(None, None, Some("0ABC")).is_none());
        assert!(parse(None, Some("/k.json"), None).is_none());
        assert!(parse(None, Some(" "), Some("0ABC")).is_none());
        // The default self-host / Railway archive and the test archive are not reachable
        // from this process: the sweep is off there, not half on.
        assert!(parse(Some("local"), Some("/k.json"), Some("0ABC")).is_none());
        assert!(parse(Some("stub"), Some("/k.json"), Some("0ABC")).is_none());
    }

    #[test]
    fn the_batch_is_at_least_one_and_debug_never_prints_the_key_path_or_drive_id() {
        let config = AttachmentReclaimConfig::parse(
            None,
            Some("/secrets/sa-visible-nowhere.json"),
            Some("0DriveIdVisibleNowhere"),
            TICK,
            0,
        )
        .unwrap();
        assert_eq!(config.batch, 1);
        let rendered = format!("{config:?}");
        assert!(!rendered.contains("sa-visible-nowhere"));
        assert!(!rendered.contains("DriveIdVisibleNowhere"));
    }
}
