//! The attachment Drive reclaim sweep (#4443, ADR-0151 증보 2).
//!
//! ## Why
//!
//! A file is uploaded before the message that carries it, so some uploads are never
//! carried: a draft nobody sent, a cancelled schedule's files, a file whose message
//! was hard-deleted. Nothing collected them, so the shared Drive only grew. This
//! sweep deletes a completed attachment that nothing holds once it has been idle for
//! [`momo_messaging::attachment_reclaim::UNBOUND_TTL`] (30 days) — and a file is
//! "held" by more than a message and a schedule; see `momo_messaging::attachment_reclaim`
//! for the full definition and the reference table behind it.
//!
//! ## It ships off
//!
//! **This job deletes files an operator cannot get back, so it deletes nothing until
//! `MOMO_ATTACHMENT_RECLAIM` is exactly `1`** ([`delete_switch_is_on`]). Switched off —
//! the default — every tick still runs the same read path and writes one fixed line
//! (`attachment reclaim dry-run: … candidates=N bytes=B …`, [`dry_run_line`]) with
//! how many files and bytes the delete *would* take, counted with the same predicate
//! the delete uses. An operator compares that line with
//! `infra/rust/sql/attachment_reclaim_check.sql` and only then turns the delete on.
//! A switched-off tick never builds a Drive client and never calls Drive.
//!
//! ## Shape (the avatar reclaim's two-pool shape, ADR-0161 D5)
//!
//! 1. The one cross-tenant read ([`workspaces_with_reclaim_candidates`]) runs on the
//!    notifier's own pool — the existing BYPASSRLS `momo_notifier` role, a **read**
//!    through a column-level grant (`workspace_id`, `status`, `message_id`, `reserved`,
//!    `unreserved_at`, `created_at` — never an attachment id, the Drive id, the name, the
//!    mime, the size or the uploader). It answers **workspace ids only**.
//! 2. Every other statement — the listing, the dry-run count, the row delete — goes
//!    through a second pool whose role must be RLS-bound (`momo_app`);
//!    [`AttachmentReclaimer::sweep_once`] checks that first and refuses otherwise.
//!    **No new RLS-bypassing write path, no new `SECURITY DEFINER`, no foreign owner
//!    binding.** Each workspace is its own tenant transaction (`SET LOCAL
//!    app.workspace_id`), each file another, in which the row is locked, eligibility is
//!    decided again, the row and its audit row are deleted/written inside a savepoint,
//!    the Drive object is deleted, and a failed Drive call takes the savepoint back —
//!    see `momo_messaging::attachment_reclaim` for the order and the race argument.
//!
//! ## What must never happen
//!
//! * A file a message carries, a file a schedule holds, a file another row names, or a
//!   file younger than the TTL is never deleted (decided under the row lock, from the
//!   row — not from the workspace list).
//! * Drive unreachable is not "deleted": a transient failure writes nothing and the
//!   row is retried next tick. Drive **404 is success** (idempotent).
//! * Nothing here logs a file name, a Drive id or a member id — counts only.
//! * Bounded: at most `batch` rows per tick, each Drive call under
//!   [`crate::avatar_reclaim::DELETE_TIMEOUT`] (applied by the shared
//!   `delete_outcome`), and a tick stops after a few consecutive Drive failures.
//!
//! ## What does not run here
//!
//! Only a Google Drive is reclaimed here (the avatar reclaim's limit, for the same
//! reason): `momo-server`'s stub archive is in its own memory, and
//! `LocalDriveArchive::open` clears pending sessions of the process that opens it — the
//! self-host volume, and a Railway volume, belong to the api process alone. On the
//! default `local` backend this job is not configured at all; the api process runs the
//! same two-step sweep for the workspaces whose uploads it has served since it started
//! (`momo-server` `attachment_reclaim`; it has no cross-tenant read, and a new
//! `SECURITY DEFINER` to enumerate tenants was deliberately not made).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use momo_db::{DbError, PgPool};
use momo_drive::DriveArchive;
pub use momo_messaging::attachment_reclaim::AttachmentReclaimStats;
use momo_messaging::attachment_reclaim::{
    delete_switch_is_on, dry_run_line, reclaim_pass, workspaces_with_reclaim_candidates,
    AttachmentDeleter, ReclaimScope, MAX_WORKSPACES_PER_TICK, UNBOUND_TTL,
};
use momo_messaging::avatar_reclaim::{ensure_write_pool_rls_bound, DriveDeleteFuture};

use crate::avatar_reclaim::{delete_outcome, AvatarReclaimConfig};

/// Settings for the attachment reclaim. The Drive credentials are the avatar reclaim's
/// (one parser, one loader — [`AvatarReclaimConfig`]); only the cadence, the batch and
/// the delete switch are this sweep's own. Holds a key **path**, never key material.
#[derive(Debug, Clone)]
pub struct AttachmentReclaimConfig {
    pub interval: Duration,
    /// Attachments per tick.
    pub batch: i64,
    /// `MOMO_ATTACHMENT_RECLAIM` is exactly `1`. `false` (the default) still looks and
    /// writes the dry-run line; it never deletes.
    pub delete_enabled: bool,
    drive: AvatarReclaimConfig,
}

impl AttachmentReclaimConfig {
    /// Both Drive values present and the backend unset / `google` / `sa`, or `None`.
    /// A `stub` or `local` backend is deliberately `None` (see the module docs).
    ///
    /// `switch` is the raw `MOMO_ATTACHMENT_RECLAIM`; only the exact text `1` turns the
    /// delete on ([`delete_switch_is_on`]). Unset, empty, `true`, `yes` and every other
    /// value leave this configured but looking only.
    pub fn parse(
        switch: Option<&str>,
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
            delete_enabled: delete_switch_is_on(switch),
            drive,
        })
    }
}

/// The Google Drive behind [`AttachmentDeleter`]. One per tick, so `unavailable` (the
/// archive said it is not configured at all) does not outlive the tick that saw it.
struct GoogleDeleter {
    drive: Arc<dyn DriveArchive>,
    unavailable: AtomicBool,
}

impl AttachmentDeleter for GoogleDeleter {
    fn delete<'a>(&'a self, drive_file_id: &'a str) -> DriveDeleteFuture<'a> {
        Box::pin(delete_outcome(
            &*self.drive,
            drive_file_id,
            &self.unavailable,
        ))
    }

    fn unavailable(&self) -> bool {
        self.unavailable.load(Ordering::Relaxed)
    }
}

pub struct AttachmentReclaimer {
    /// `None` is the switched-off reclaimer: it counts and logs, and has no Drive.
    drive: Option<Arc<dyn DriveArchive>>,
    batch: i64,
}

impl AttachmentReclaimer {
    /// A reclaimer that deletes through `drive`.
    pub fn new(drive: Arc<dyn DriveArchive>, batch: i64) -> AttachmentReclaimer {
        AttachmentReclaimer {
            drive: Some(drive),
            batch: batch.max(1),
        }
    }

    /// The switched-off reclaimer: every tick counts what the delete would take and
    /// writes the dry-run line. It owns no Drive client and calls no Drive.
    pub fn dry_run(batch: i64) -> AttachmentReclaimer {
        AttachmentReclaimer {
            drive: None,
            batch: batch.max(1),
        }
    }

    /// The reclaimer `config` describes: deleting when the switch is `1` **and** the
    /// Google archive loads, looking only otherwise. A service account that cannot be
    /// loaded (the error carries no credential material) falls back to looking only —
    /// a delete that cannot reach its Drive is not a delete.
    pub fn from_config(config: &AttachmentReclaimConfig) -> AttachmentReclaimer {
        AttachmentReclaimer::from_config_with(config, |config| config.drive.google_archive())
    }

    /// [`AttachmentReclaimer::from_config`] with the archive loader handed in, so a test can
    /// prove that a switched-off config never asks for an archive at all.
    fn from_config_with(
        config: &AttachmentReclaimConfig,
        load_archive: impl FnOnce(&AttachmentReclaimConfig) -> Option<Arc<dyn DriveArchive>>,
    ) -> AttachmentReclaimer {
        if !config.delete_enabled {
            return AttachmentReclaimer::dry_run(config.batch);
        }
        match load_archive(config) {
            Some(archive) => AttachmentReclaimer::new(archive, config.batch),
            None => {
                tracing::error!(
                    "attachment reclaim: MOMO_ATTACHMENT_RECLAIM=1 but the Drive service account \
                     is unusable; running as a dry run (nothing is deleted)"
                );
                AttachmentReclaimer::dry_run(config.batch)
            }
        }
    }

    /// Whether this reclaimer will delete.
    pub fn deletes(&self) -> bool {
        self.drive.is_some()
    }

    /// One iteration. `read_pool` is the BYPASSRLS notifier pool (it answers workspace
    /// ids and nothing else); `write_pool` must be RLS-bound or this refuses to run — it
    /// carries every other statement, the dry-run count included. The two steps after the
    /// workspace list are `momo_messaging::attachment_reclaim::reclaim_pass`, which the api
    /// process's local-volume runner calls too.
    pub async fn sweep_once(
        &self,
        read_pool: &PgPool,
        write_pool: &PgPool,
    ) -> Result<AttachmentReclaimStats, DbError> {
        ensure_write_pool_rls_bound(write_pool).await?;
        let workspaces =
            workspaces_with_reclaim_candidates(read_pool, MAX_WORKSPACES_PER_TICK, UNBOUND_TTL)
                .await?;

        let deleter: Option<Arc<dyn AttachmentDeleter>> = self.drive.as_ref().map(|drive| {
            Arc::new(GoogleDeleter {
                drive: Arc::clone(drive),
                unavailable: AtomicBool::new(false),
            }) as Arc<dyn AttachmentDeleter>
        });
        let stats = reclaim_pass(
            write_pool,
            workspaces,
            UNBOUND_TTL,
            self.batch,
            deleter.as_ref(),
        )
        .await;

        if let Some(tally) = &stats.dry_run {
            // Switched off: the same predicate, no Drive. One fixed line per tick.
            tracing::info!(
                "{}",
                dry_run_line(
                    ReclaimScope::AllWorkspaces,
                    stats.looked_at,
                    stats.workspaces,
                    tally
                )
            );
        }
        if stats.db_errors > 0 {
            // Fixed text: a database error may echo relation/constraint names, and
            // nothing here needs them. The workspace ids say where to look.
            tracing::warn!(
                db_errors = stats.db_errors,
                failed_workspaces = ?stats.failed_workspaces,
                "attachment reclaim failed in the database for some workspaces or attachments"
            );
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
    fn only_a_complete_google_drive_configuration_configures_the_reclaim() {
        let parse = |backend, key, drive| {
            AttachmentReclaimConfig::parse(None, backend, key, drive, TICK, 50)
        };
        assert!(parse(None, Some("/k.json"), Some("0ABC")).is_some());
        assert!(parse(Some("google"), Some("/k.json"), Some("0ABC")).is_some());
        assert!(parse(Some(" SA "), Some("/k.json"), Some("0ABC")).is_some());
        assert!(parse(None, None, Some("0ABC")).is_none());
        assert!(parse(None, Some("/k.json"), None).is_none());
        assert!(parse(None, Some(" "), Some("0ABC")).is_none());
        // The default self-host / Railway archive and the test archive are not reachable
        // from this process: the sweep is not configured there at all.
        assert!(parse(Some("local"), Some("/k.json"), Some("0ABC")).is_none());
        assert!(parse(Some("stub"), Some("/k.json"), Some("0ABC")).is_none());
    }

    /// The sweep deletes files, so it ships **off**: configured, it looks and logs; only
    /// the exact text `1` lets it delete (`MOMO_ATTACHMENT_RECLAIM`, separate from the
    /// Drive credentials the avatar reclaim needs).
    #[test]
    fn the_sweep_deletes_only_when_the_switch_is_exactly_one() {
        let parse = |switch| {
            AttachmentReclaimConfig::parse(switch, None, Some("/k.json"), Some("0ABC"), TICK, 50)
                .expect("a complete Google configuration")
        };
        assert!(!parse(None).delete_enabled, "unset is off");
        assert!(parse(Some("1")).delete_enabled);
        for near_miss in [
            "0", "", "true", "TRUE", "yes", "on", " 1", "1 ", "01", "enable",
        ] {
            assert!(
                !parse(Some(near_miss)).delete_enabled,
                "{near_miss:?} must leave the delete off"
            );
        }
    }

    /// A switched-off config never asks for a Drive archive (so it can neither build a
    /// client nor call Drive); an enabled one asks once and deletes through it; an enabled
    /// one whose archive cannot load falls back to looking only.
    #[test]
    fn a_switched_off_reclaimer_never_asks_for_a_drive() {
        use std::sync::atomic::AtomicU32;
        use std::sync::Arc;

        #[derive(Debug)]
        struct NoDrive;
        #[async_trait::async_trait]
        impl DriveArchive for NoDrive {
            async fn create_resumable_upload(
                &self,
                _channel_id: uuid::Uuid,
                _name: &str,
                _mime: &str,
                _size_bytes: i64,
            ) -> Result<momo_drive::DriveUploadSession, momo_drive::DriveError> {
                Err(momo_drive::DriveError::Unavailable)
            }
            async fn file_metadata(
                &self,
                _file_id: &str,
            ) -> Result<momo_drive::DriveFile, momo_drive::DriveError> {
                Err(momo_drive::DriveError::Unavailable)
            }
            async fn file_content(
                &self,
                _file_id: &str,
                _max_bytes: i64,
            ) -> Result<momo_drive::DriveContent, momo_drive::DriveError> {
                Err(momo_drive::DriveError::Unavailable)
            }
            async fn delete_file(&self, _file_id: &str) -> Result<(), momo_drive::DriveError> {
                Ok(())
            }
        }

        let config = |switch| {
            AttachmentReclaimConfig::parse(switch, None, Some("/k.json"), Some("0ABC"), TICK, 10)
                .expect("a complete Google configuration")
        };
        let asked = AtomicU32::new(0);
        let loader = |_: &AttachmentReclaimConfig| -> Option<Arc<dyn DriveArchive>> {
            asked.fetch_add(1, Ordering::SeqCst);
            Some(Arc::new(NoDrive))
        };

        let off = AttachmentReclaimer::from_config_with(&config(None), loader);
        assert!(!off.deletes(), "switched off: looking only");
        assert_eq!(
            asked.load(Ordering::SeqCst),
            0,
            "switched off: no archive is asked for"
        );

        let near_miss = AttachmentReclaimer::from_config_with(&config(Some("true")), loader);
        assert!(!near_miss.deletes(), "`true` is not `1`");
        assert_eq!(asked.load(Ordering::SeqCst), 0);

        let on = AttachmentReclaimer::from_config_with(&config(Some("1")), loader);
        assert!(on.deletes(), "exactly 1 with a loadable archive: deleting");
        assert_eq!(asked.load(Ordering::SeqCst), 1);

        let unusable = AttachmentReclaimer::from_config_with(&config(Some("1")), |_| None);
        assert!(
            !unusable.deletes(),
            "1 but the archive cannot load: a delete that cannot reach its Drive is not a delete"
        );
        assert!(!AttachmentReclaimer::dry_run(10).deletes());
    }

    #[test]
    fn the_batch_is_at_least_one_and_debug_never_prints_the_key_path_or_drive_id() {
        let config = AttachmentReclaimConfig::parse(
            None,
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
