//! The avatar Drive reclaim sweep (#3284, ADR-0161 D5 + 증보 2).
//!
//! ## Why
//!
//! Replacing or removing an avatar, a rejected completion, and an upload nobody
//! finished all leave a Drive object behind; the request path only moves
//! pointers and statuses. Without this, every replaced face stays on the shared
//! Drive forever.
//!
//! ## Shape (the huddle sweep's two-pool shape)
//!
//! 1. The candidate read ([`momo_messaging::avatar_reclaim::avatar_reclaim_candidates`])
//!    runs on the notifier's own pool — the existing BYPASSRLS `momo_notifier`
//!    role, a **read**, and the only way to see every tenant, exactly as the
//!    approval and huddle sweeps do. It returns ids only.
//! 2. Every write goes through a second pool whose role must be RLS-bound
//!    (`momo_app`); [`AvatarReclaimer::sweep_once`] checks that first and refuses
//!    otherwise. **No new RLS-bypassing write path.** Each row is its own tenant
//!    transaction (`SET LOCAL app.workspace_id`) in which the row is locked, the
//!    "is it somebody's current avatar?" check runs, the Drive object is deleted,
//!    and the row is marked — see `momo_messaging::avatar_reclaim` for the race
//!    argument.
//!
//! ## What must never happen
//!
//! * A current avatar's object is never deleted (checked under the row lock).
//! * Drive unreachable is not "deleted": a transient failure writes nothing and
//!   the row is retried next tick. Drive **404 is success** (idempotent).
//! * Nothing here logs a file name, a Drive id or a member id — counts only.
//! * Bounded: at most `batch` rows per table per tick, each Drive call under
//!   [`DELETE_TIMEOUT`].
//!
//! Only a Google Drive is reclaimed. `momo-server`'s stub archive is in its own
//! memory, and `LocalDriveArchive::open` clears pending sessions of the process
//! that opens it — opening the self-host volume from a second process is not
//! safe, so the local backend is left to a follow-up.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_drive::{DriveArchive, DriveError, GoogleDriveArchive};
use momo_messaging::avatar_reclaim::{
    avatar_reclaim_candidates, ensure_write_pool_rls_bound, reclaim_avatar_media_in_tx,
    write_reclaim_audit, DriveDelete, ReclaimCounts, ReclaimOutcome,
};
use uuid::Uuid;

/// One Drive delete (probe + DELETE) may not hold the tick longer than this.
pub const DELETE_TIMEOUT: Duration = Duration::from_secs(30);
/// Consecutive transient Drive failures after which a tick stops early.
pub const MAX_CONSECUTIVE_DRIVE_FAILURES: u32 = 3;

/// Settings for the avatar reclaim. Holds a key **path**, never key material.
#[derive(Clone)]
pub struct AvatarReclaimConfig {
    pub interval: Duration,
    /// Rows per table per tick.
    pub batch: i64,
    sa_key_path: String,
    shared_drive_id: String,
}

impl std::fmt::Debug for AvatarReclaimConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AvatarReclaimConfig")
            .field("interval", &self.interval)
            .field("batch", &self.batch)
            .field("sa_key_path", &"<redacted>")
            .field("shared_drive_id", &"<redacted>")
            .finish()
    }
}

impl AvatarReclaimConfig {
    /// Both Drive values present and the backend unset / `google` / `sa`, or
    /// `None`. A `stub` or `local` backend is deliberately `None`.
    pub fn parse(
        backend: Option<&str>,
        sa_key_path: Option<&str>,
        shared_drive_id: Option<&str>,
        interval: Duration,
        batch: i64,
    ) -> Option<AvatarReclaimConfig> {
        let backend = backend.map(|b| b.trim().to_lowercase()).unwrap_or_default();
        if !matches!(backend.as_str(), "" | "google" | "sa") {
            return None;
        }
        let sa_key_path = sa_key_path.map(str::trim).filter(|v| !v.is_empty())?;
        let shared_drive_id = shared_drive_id.map(str::trim).filter(|v| !v.is_empty())?;
        Some(AvatarReclaimConfig {
            interval,
            batch: batch.max(1),
            sa_key_path: sa_key_path.to_string(),
            shared_drive_id: shared_drive_id.to_string(),
        })
    }
}

/// What one tick did, totalled over workspaces. Counts only.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AvatarReclaimStats {
    pub workspaces: usize,
    pub counts: ReclaimCounts,
    /// Per-row transactions that failed in the database.
    pub db_errors: u32,
}

pub struct AvatarReclaimer {
    drive: Arc<dyn DriveArchive>,
    batch: i64,
}

impl AvatarReclaimer {
    pub fn new(drive: Arc<dyn DriveArchive>, batch: i64) -> AvatarReclaimer {
        AvatarReclaimer {
            drive,
            batch: batch.max(1),
        }
    }

    /// Build the Google archive named by `config`. `None` when the service
    /// account cannot be loaded (the error carries no credential material).
    pub fn from_config(config: &AvatarReclaimConfig) -> Option<AvatarReclaimer> {
        match GoogleDriveArchive::new(Some(&config.sa_key_path), Some(&config.shared_drive_id)) {
            Ok(archive) => Some(AvatarReclaimer::new(Arc::new(archive), config.batch)),
            Err(error) => {
                tracing::error!(%error, "avatar reclaim: Drive archive unavailable");
                None
            }
        }
    }

    /// One iteration. `read_pool` is the BYPASSRLS notifier pool (read only);
    /// `write_pool` must be RLS-bound or this refuses to run.
    pub async fn sweep_once(
        &self,
        read_pool: &PgPool,
        write_pool: &PgPool,
    ) -> Result<AvatarReclaimStats, DbError> {
        ensure_write_pool_rls_bound(write_pool).await?;
        let candidates = avatar_reclaim_candidates(read_pool, self.batch).await?;

        let mut per_workspace: HashMap<Uuid, ReclaimCounts> = HashMap::new();
        let mut stats = AvatarReclaimStats::default();
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
            let result = with_tenant_tx(write_pool, candidate.workspace_id, move |conn| {
                Box::pin(async move {
                    reclaim_avatar_media_in_tx(
                        conn,
                        candidate.workspace_id,
                        candidate.kind,
                        candidate.media_id,
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
                    if outcome == ReclaimOutcome::DriveFailed {
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
                        "avatar reclaim failed for a media row (database error)"
                    );
                }
            }
        }

        stats.workspaces = per_workspace.len();
        for (workspace_id, counts) in per_workspace {
            stats.counts.add(&counts);
            if let Err(error) = write_reclaim_audit(write_pool, workspace_id, counts).await {
                stats.db_errors += 1;
                tracing::warn!(
                    workspace_id = %workspace_id,
                    error = %error,
                    "avatar reclaim audit write failed"
                );
            }
        }

        if stats.counts.reclaimed() > 0 || stats.counts.refused > 0 || stats.counts.drive_failed > 0
        {
            tracing::info!(
                workspaces = stats.workspaces,
                replaced = stats.counts.replaced,
                failed = stats.counts.failed,
                expired_pending = stats.counts.expired_pending,
                skipped_current = stats.counts.skipped_current,
                drive_failed = stats.counts.drive_failed,
                refused = stats.counts.refused,
                "avatar reclaim deleted Drive objects"
            );
        }
        Ok(stats)
    }
}

/// Run one Drive delete under [`DELETE_TIMEOUT`] and classify it. A 404 is the
/// archive's `Ok`; `FileNotFound` is accepted too, for an archive that reports it.
async fn delete_outcome(
    drive: &dyn DriveArchive,
    file_id: &str,
    unavailable: &AtomicBool,
) -> DriveDelete {
    match tokio::time::timeout(DELETE_TIMEOUT, drive.delete_file(file_id)).await {
        Ok(Ok(())) => DriveDelete::Deleted,
        Ok(Err(DriveError::FileNotFound)) => DriveDelete::Gone,
        Ok(Err(DriveError::AccessDenied | DriveError::InvalidArguments(_))) => DriveDelete::Refused,
        Ok(Err(DriveError::Unavailable)) => {
            unavailable.store(true, Ordering::Relaxed);
            DriveDelete::Failed
        }
        Ok(Err(_)) | Err(_) => DriveDelete::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICK: Duration = Duration::from_secs(60);

    #[test]
    fn only_a_complete_google_drive_configuration_enables_the_reclaim() {
        let parse = |backend, key, drive| AvatarReclaimConfig::parse(backend, key, drive, TICK, 50);
        assert!(parse(None, Some("/k.json"), Some("0ABC")).is_some());
        assert!(parse(Some("google"), Some("/k.json"), Some("0ABC")).is_some());
        assert!(parse(Some(" SA "), Some("/k.json"), Some("0ABC")).is_some());
        assert!(parse(None, None, Some("0ABC")).is_none());
        assert!(parse(None, Some("/k.json"), None).is_none());
        assert!(parse(None, Some(" "), Some("0ABC")).is_none());
        // The self-host / test archives are not reachable from this process.
        assert!(parse(Some("local"), Some("/k.json"), Some("0ABC")).is_none());
        assert!(parse(Some("stub"), Some("/k.json"), Some("0ABC")).is_none());
    }

    #[test]
    fn debug_never_prints_the_key_path_or_drive_id() {
        let config = AvatarReclaimConfig::parse(
            None,
            Some("/secrets/sa-visible-nowhere.json"),
            Some("0DriveIdVisibleNowhere"),
            TICK,
            50,
        )
        .unwrap();
        let rendered = format!("{config:?}");
        assert!(!rendered.contains("sa-visible-nowhere"));
        assert!(!rendered.contains("DriveIdVisibleNowhere"));
    }
}
