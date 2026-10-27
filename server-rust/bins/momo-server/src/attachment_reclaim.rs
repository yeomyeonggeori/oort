//! The attachment reclaim tick of the api process (#4443, ADR-0151 증보 2 D4) — the half that
//! runs on the **local volume**.
//!
//! ## Why it lives here and not in the notifier
//!
//! The default archive of a self-host and of a Railway instance is `local`: the bytes are files
//! under `MOMO_DRIVE_LOCAL_DIR`, and only the api process can open that volume
//! (`LocalDriveArchive::open` clears the pending upload sessions of the process that opens it,
//! so a second process must not). The notifier reclaims a Google Drive; this tick reclaims the
//! local volume with **the same two steps** (`momo_messaging::attachment_reclaim::reclaim_pass`)
//! and the same switch (`delete_switch_is_on`: `MOMO_ATTACHMENT_RECLAIM` exactly `1`). It runs
//! **only when the backend is `local`** — with a Google Drive the notifier does it, and running
//! both would only make two processes look at the same rows.
//!
//! ## It ships off
//!
//! The job deletes files nobody can get back, so until `MOMO_ATTACHMENT_RECLAIM` is exactly `1`
//! every tick only **counts** what it would delete (the same predicate the delete uses) and
//! writes one fixed `attachment reclaim dry-run: …` line. It never calls the archive's delete.
//!
//! ## No cross-tenant read, no new privilege: the touched set
//!
//! This process has no way to ask "which workspaces have a reclaimable file": it connects as
//! `momo_app` (NOBYPASSRLS), and `workspace` is FORCE-RLS on `app.workspace_id`, so a
//! connection that has not bound a workspace sees **no `workspace` row at all** (measured on the
//! scratch database in #4443). The ways around that are a BYPASSRLS connection in the
//! internet-facing process or a new `SECURITY DEFINER` that enumerates tenants; the first is
//! refused by AGENTS.md and the second is exactly the kind of boundary the owner asked to
//! avoid unless it cannot be (and it carries the upgrade-order risk migration 150 already hit).
//!
//! So the tick looks at the workspaces **whose uploads this process has served since it
//! started** ([`TouchedWorkspaces`], filled by `create_upload` after the principal's workspace
//! was checked — never from a request body). Each is its own tenant transaction
//! (`SET LOCAL app.workspace_id`), exactly like a request's. What that covers and what it
//! does not is part of the contract, not a footnote:
//!
//! * a workspace that keeps uploading is swept (everything of it that is eligible, in batches);
//! * a workspace nobody has uploaded to **since the last restart** is not looked at until
//!   somebody does — its old drafts stay, as bytes and rows, which is today's behaviour;
//! * storage does not *grow* in a workspace that uploads nothing, so the gap is a bounded
//!   backlog, not a leak. Closing it completely needs the id-only definer (the ADR-0208 145
//!   shape), which is a follow-up the owner can still take.
//!
//! ## Bounded
//!
//! At most `batch` files a tick, each archive call under [`DELETE_TIMEOUT`], at most
//! [`MAX_WORKSPACES_PER_TICK`] workspaces a tick, a tick stops after a few consecutive archive
//! failures, and the touched set itself is capped ([`MAX_TOUCHED_WORKSPACES`]).
//!
//! **Rotation** ([`cursor_after`]): a workspace with a big backlog spends the whole `batch` if it
//! is looked at first, so the next tick starts **after the last workspace this tick actually
//! looked at** — the one whose turn ended the budget, or the last of the window when the budget
//! held. That is a round robin over the touched set: a workspace that spent the budget goes to the
//! back of the queue and cannot starve the others, and a set bigger than one tick's limit is
//! walked window by window.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use momo_db::{DbError, PgPool};
use momo_drive::{DriveArchive, DriveError};
use momo_messaging::attachment_reclaim::{
    dry_run_line, reclaim_pass, AttachmentDeleter, AttachmentReclaimStats, ReclaimScope,
    MAX_WORKSPACES_PER_TICK, UNBOUND_TTL,
};
use momo_messaging::avatar_reclaim::{ensure_write_pool_rls_bound, DriveDelete, DriveDeleteFuture};
use tokio::sync::watch;
use uuid::Uuid;

use crate::config::AttachmentReclaimSettings;

/// One archive delete may not hold the tick longer than this (the notifier's
/// `avatar_reclaim::DELETE_TIMEOUT`, for the same reason).
pub const DELETE_TIMEOUT: Duration = Duration::from_secs(30);

/// The touched set never holds more than this many workspaces. A workspace beyond it is simply
/// not remembered (it is not an error, and nothing is dropped from the set): the cap exists so
/// that the set cannot grow with the number of tenants an instance has ever served.
pub const MAX_TOUCHED_WORKSPACES: usize = 10_000;

/// The workspaces whose uploads this process has served since it started.
///
/// A set of ids and nothing else: it holds no file, no name and no member, and it is only ever
/// read to decide *which tenant transaction to open next* — every statement after that runs
/// under the tenant's own RLS policies like a request's.
#[derive(Debug, Default)]
pub struct TouchedWorkspaces {
    inner: Mutex<BTreeSet<Uuid>>,
}

impl TouchedWorkspaces {
    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeSet<Uuid>> {
        // A panic while holding the lock cannot leave the set half-written (one insert), so a
        // poisoned lock is still a usable set.
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Remember that this process served an upload in `workspace_id`. Cheap and idempotent.
    pub fn touch(&self, workspace_id: Uuid) {
        let mut set = self.lock();
        if set.len() < MAX_TOUCHED_WORKSPACES || set.contains(&workspace_id) {
            set.insert(workspace_id);
        }
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    /// Up to `limit` workspaces in id order, starting **after** `after` and wrapping around to
    /// the start — each workspace at most once. A tick that remembers the last workspace it looked
    /// at ([`cursor_after`]) walks the whole set over successive ticks.
    pub fn next_batch(&self, after: Option<Uuid>, limit: usize) -> Vec<Uuid> {
        let all: Vec<Uuid> = self.lock().iter().copied().collect();
        let start = match after {
            Some(after) => all.partition_point(|id| *id <= after),
            None => 0,
        };
        all[start..]
            .iter()
            .chain(all[..start].iter())
            .take(limit)
            .copied()
            .collect()
    }
}

/// Run one archive delete under [`DELETE_TIMEOUT`] and classify it. The classification is the
/// notifier's (`avatar_reclaim::delete_outcome`, which `momo-messaging` cannot share because it
/// does not depend on the Drive crate): the archive's `Ok` covers "already gone", a refusal is
/// permanent, an unconfigured archive stops the tick, everything else is retried next tick.
pub(crate) async fn delete_outcome(
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

/// The archive behind [`AttachmentDeleter`]: the process's own (`AppState::drive`), already
/// open — nothing here opens the volume a second time.
struct ArchiveDeleter {
    drive: Arc<dyn DriveArchive>,
    unavailable: AtomicBool,
}

impl AttachmentDeleter for ArchiveDeleter {
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

/// Where the next tick starts: **after the last workspace this tick looked at** — the one whose
/// turn ended the budget (it goes to the back of the queue, so a big backlog cannot starve the
/// others), or the last of the window when the budget held. `looked_at` is how many of `batch`
/// the pass examined ([`AttachmentReclaimStats::looked_at`]); `None` when it examined none, so the
/// cursor stays where it was.
pub(crate) fn cursor_after(batch: &[Uuid], looked_at: usize) -> Option<Uuid> {
    looked_at
        .checked_sub(1)
        .and_then(|last| batch.get(last))
        .copied()
}

/// One iteration. `drive = None` is the switched-off tick: it counts and returns the tally in
/// [`AttachmentReclaimStats::dry_run`]; it owns no deleter and writes nothing. `cursor` is the
/// last workspace the previous tick looked at (this tick starts after it, [`cursor_after`]).
///
/// `write_pool` must be RLS-bound or this refuses to run — it carries every statement.
pub async fn sweep_once(
    drive: Option<&Arc<dyn DriveArchive>>,
    touched: &TouchedWorkspaces,
    write_pool: &PgPool,
    batch: i64,
    cursor: &mut Option<Uuid>,
) -> Result<AttachmentReclaimStats, DbError> {
    ensure_write_pool_rls_bound(write_pool).await?;
    let workspaces = touched.next_batch(*cursor, MAX_WORKSPACES_PER_TICK as usize);
    let order = workspaces.clone();
    let deleter: Option<Arc<dyn AttachmentDeleter>> = drive.map(|drive| {
        Arc::new(ArchiveDeleter {
            drive: Arc::clone(drive),
            unavailable: AtomicBool::new(false),
        }) as Arc<dyn AttachmentDeleter>
    });
    let stats = reclaim_pass(write_pool, workspaces, UNBOUND_TTL, batch, deleter.as_ref()).await;
    if let Some(next) = cursor_after(&order, stats.looked_at) {
        *cursor = Some(next);
    }
    Ok(stats)
}

/// Whether **this process** reclaims the attachments of `backend`. Only the `local` volume: with a
/// Google Drive (`google`, `sa`, or unset) the notifier does it, and `stub` is the test archive in
/// the memory of whichever process holds it. Running both here and in the notifier would only make
/// two processes look at the same rows.
pub fn runs_in_this_process(backend: &str) -> bool {
    backend == momo_drive::LOCAL_BACKEND
}

/// The archive a tick may delete through: `Some` only when the operator switched the delete on
/// (`MOMO_ATTACHMENT_RECLAIM` exactly `1`, already parsed into `settings`). A switched-off tick is
/// handed `None`, so it owns no deleter and cannot call the archive's delete at all.
pub(crate) fn archive_for_tick<'a>(
    settings: &AttachmentReclaimSettings,
    drive: &'a Arc<dyn DriveArchive>,
) -> Option<&'a Arc<dyn DriveArchive>> {
    settings.delete_enabled.then_some(drive)
}

/// What a tick writes to the log: counts only (no name, no Drive id, no member id).
fn log_tick(stats: &AttachmentReclaimStats) {
    if let Some(tally) = &stats.dry_run {
        tracing::info!(
            "{}",
            dry_run_line(
                ReclaimScope::TouchedByThisProcess,
                stats.looked_at,
                stats.workspaces,
                tally
            )
        );
    }
    if stats.db_errors > 0 {
        // Fixed text: a database error may echo relation/constraint names.
        tracing::warn!(
            db_errors = stats.db_errors,
            failed_workspaces = ?stats.failed_workspaces,
            "attachment reclaim (local volume) failed in the database for some workspaces or attachments"
        );
    }
    if stats.counts.reclaimed > 0 || stats.counts.refused > 0 || stats.counts.drive_failed > 0 {
        tracing::info!(
            workspaces = stats.workspaces,
            reclaimed = stats.counts.reclaimed,
            skipped = stats.counts.skipped_not_eligible,
            drive_failed = stats.counts.drive_failed,
            refused = stats.counts.refused,
            "attachment reclaim (local volume) deleted archive objects"
        );
    }
}

/// Start the tick. `None` when the pool connects as a role that skips row-level security (the
/// tick refuses to run: its writes must be filtered by the tenant policies like a request's —
/// "no BYPASSRLS on a write path", AGENTS.md held in code) or the role could not be asked.
///
/// `drive` is `AppState::drive`, the archive this process already serves uploads from. The
/// caller (`main`) starts this **only on the local backend**.
pub async fn start(
    drive: Arc<dyn DriveArchive>,
    touched: Arc<TouchedWorkspaces>,
    pool: PgPool,
    settings: AttachmentReclaimSettings,
    stop: watch::Receiver<bool>,
) -> Option<tokio::task::JoinHandle<()>> {
    if let Err(error) = ensure_write_pool_rls_bound(&pool).await {
        tracing::error!(
            error = %error,
            "attachment reclaim (local volume) is NOT running: its database role could not be \
             confirmed as row-level-security bound; unbound attachments are neither counted nor \
             reclaimed"
        );
        return None;
    }
    Some(tokio::spawn(run_loop(drive, touched, pool, settings, stop)))
}

/// Look every `interval_ms`; stop when `stop` turns true **or its sender is gone** (a loop that
/// kept running with nobody left to stop it would spin). The stop is looked at between ticks, so a
/// tick in progress runs to its end (at most `batch` files, each archive call bounded by
/// [`DELETE_TIMEOUT`]); `main` waits a bounded time and then lets the process exit. A file whose
/// archive delete had not answered keeps its row (its savepoint is never committed) and the next
/// process retries it — the archive delete is idempotent.
async fn run_loop(
    drive: Arc<dyn DriveArchive>,
    touched: Arc<TouchedWorkspaces>,
    pool: PgPool,
    settings: AttachmentReclaimSettings,
    mut stop: watch::Receiver<bool>,
) {
    tracing::info!(
        delete_enabled = settings.delete_enabled,
        interval_ms = settings.interval_ms,
        batch = settings.batch,
        "attachment reclaim tick started (local volume): {}",
        if settings.delete_enabled {
            "MOMO_ATTACHMENT_RECLAIM=1, deleting completed attachments nothing holds after 30 idle \
             days in the workspaces this process has served uploads for"
        } else {
            "dry run (MOMO_ATTACHMENT_RECLAIM is not 1): nothing is deleted, each tick logs how \
             many files and bytes it would"
        }
    );
    let mut cursor: Option<Uuid> = None;
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() {
                    break;
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(settings.interval_ms)) => {}
        }
        if *stop.borrow() {
            break;
        }
        let archive = archive_for_tick(&settings, &drive);
        match sweep_once(archive, &touched, &pool, settings.batch, &mut cursor).await {
            Ok(stats) => log_tick(&stats),
            Err(_) => tracing::warn!(
                "attachment reclaim (local volume) tick failed before it looked at a workspace \
                 (database error)"
            ),
        }
    }
    tracing::info!("attachment reclaim tick stopped (local volume)");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    #[test]
    fn touching_is_idempotent_and_remembers_only_ids() {
        let set = TouchedWorkspaces::default();
        assert!(set.is_empty());
        set.touch(id(7));
        set.touch(id(7));
        set.touch(id(3));
        assert_eq!(set.len(), 2);
        assert_eq!(set.next_batch(None, 10), vec![id(3), id(7)], "id order");
    }

    #[test]
    fn the_set_is_capped_and_a_known_workspace_is_never_dropped() {
        let set = TouchedWorkspaces::default();
        for n in 0..MAX_TOUCHED_WORKSPACES as u128 {
            set.touch(id(n));
        }
        assert_eq!(set.len(), MAX_TOUCHED_WORKSPACES);
        // One more is not remembered — and nothing already in the set is evicted for it.
        set.touch(id(u128::MAX));
        assert_eq!(set.len(), MAX_TOUCHED_WORKSPACES);
        assert!(!set
            .next_batch(None, MAX_TOUCHED_WORKSPACES)
            .contains(&id(u128::MAX)));
        // Touching one that is already there is still fine.
        set.touch(id(5));
        assert_eq!(set.len(), MAX_TOUCHED_WORKSPACES);
    }

    /// A set bigger than one tick's limit is walked over successive ticks: the cursor is the
    /// last id taken, the walk wraps, and no workspace is taken twice in one batch.
    #[test]
    fn a_batch_walks_the_whole_set_round_robin_without_repeating() {
        let set = TouchedWorkspaces::default();
        for n in 1..=5u128 {
            set.touch(id(n));
        }
        let first = set.next_batch(None, 2);
        assert_eq!(first, vec![id(1), id(2)]);
        let second = set.next_batch(first.last().copied(), 2);
        assert_eq!(second, vec![id(3), id(4)]);
        let third = set.next_batch(second.last().copied(), 2);
        assert_eq!(third, vec![id(5), id(1)], "wraps around");
        // A limit larger than the set returns each workspace once, never twice.
        let all = set.next_batch(Some(id(3)), 100);
        assert_eq!(all, vec![id(4), id(5), id(1), id(2), id(3)]);
        // An empty set is an empty batch, whatever the cursor.
        assert!(TouchedWorkspaces::default()
            .next_batch(Some(id(9)), 4)
            .is_empty());
        // A cursor past the end starts over at the beginning.
        assert_eq!(set.next_batch(Some(id(99)), 2), vec![id(1), id(2)]);
    }

    /// The next tick starts after the last workspace this tick looked at: a workspace that spent the
    /// budget goes to the back of the queue (a big backlog cannot starve the others), and a set
    /// bigger than one tick's limit is walked window by window.
    #[test]
    fn the_cursor_continues_after_the_last_workspace_a_tick_looked_at() {
        let set = TouchedWorkspaces::default();
        for n in 1..=3u128 {
            set.touch(id(n));
        }
        // The budget ends in the first workspace each tick looks at: the head moves on every time.
        let mut cursor = None;
        let mut heads = Vec::new();
        for _ in 0..4 {
            let batch = set.next_batch(cursor, 100);
            heads.push(batch[0]);
            cursor = cursor_after(&batch, 1);
        }
        assert_eq!(
            heads,
            vec![id(1), id(2), id(3), id(1)],
            "a workspace that spent the budget goes to the back"
        );
        // A window that was looked at in full hands the next tick what follows it.
        let big = TouchedWorkspaces::default();
        for n in 1..=5u128 {
            big.touch(id(n));
        }
        let first = big.next_batch(None, 2);
        let cursor = cursor_after(&first, first.len());
        assert_eq!(cursor, Some(id(2)), "after the window, not the head");
        assert_eq!(big.next_batch(cursor, 2), vec![id(3), id(4)]);
        // Nothing looked at: the cursor does not move.
        assert_eq!(cursor_after(&first, 0), None);
        assert_eq!(cursor_after(&[], 0), None);
    }

    /// Only the local volume is this process's to reclaim; a Google Drive is the notifier's.
    #[test]
    fn only_the_local_volume_is_reclaimed_by_the_api_process() {
        assert!(runs_in_this_process("local"));
        for other in ["google", "sa", "stub", "", "LOCAL", "local "] {
            assert!(!runs_in_this_process(other), "{other:?}");
        }
    }

    /// The switch decides whether a tick is handed an archive to delete through. Off (the
    /// default) it is handed none: a switched-off tick cannot reach the archive's delete.
    #[test]
    fn a_tick_is_handed_the_archive_only_when_the_delete_is_switched_on() {
        let drive: Arc<dyn DriveArchive> = Arc::new(momo_drive::UnavailableDriveArchive);
        let off = AttachmentReclaimSettings::default();
        assert!(!off.delete_enabled);
        assert!(
            archive_for_tick(&off, &drive).is_none(),
            "ships off: no archive"
        );
        let on = AttachmentReclaimSettings {
            delete_enabled: true,
            ..off
        };
        assert!(archive_for_tick(&on, &drive).is_some());
    }

    /// The archive's answers, classified the way the notifier classifies Google's. The local
    /// archive's `delete_file` is idempotent (`Ok` for an object that is already gone), so the
    /// arms that matter for it are `Ok`, a refused id and an I/O failure.
    #[tokio::test]
    async fn the_archives_answers_are_classified_like_the_notifiers() {
        use std::sync::Mutex as StdMutex;

        #[derive(Debug)]
        struct Answers(StdMutex<Option<Result<(), DriveError>>>);
        #[async_trait::async_trait]
        impl DriveArchive for Answers {
            async fn create_resumable_upload(
                &self,
                _channel_id: Uuid,
                _name: &str,
                _mime: &str,
                _size_bytes: i64,
            ) -> Result<momo_drive::DriveUploadSession, DriveError> {
                Err(DriveError::Unavailable)
            }
            async fn file_metadata(
                &self,
                _file_id: &str,
            ) -> Result<momo_drive::DriveFile, DriveError> {
                Err(DriveError::Unavailable)
            }
            async fn file_content(
                &self,
                _file_id: &str,
                _max_bytes: i64,
            ) -> Result<momo_drive::DriveContent, DriveError> {
                Err(DriveError::Unavailable)
            }
            async fn delete_file(&self, _file_id: &str) -> Result<(), DriveError> {
                self.0.lock().unwrap().take().expect("one answer per call")
            }
        }

        let classify = |answer: Result<(), DriveError>| {
            let drive = Answers(StdMutex::new(Some(answer)));
            let flag = AtomicBool::new(false);
            async move {
                let outcome = delete_outcome(&drive, "any", &flag).await;
                (outcome, flag.load(Ordering::Relaxed))
            }
        };
        assert_eq!(classify(Ok(())).await, (DriveDelete::Deleted, false));
        assert_eq!(
            classify(Err(DriveError::FileNotFound)).await,
            (DriveDelete::Gone, false)
        );
        assert_eq!(
            classify(Err(DriveError::AccessDenied)).await,
            (DriveDelete::Refused, false)
        );
        assert_eq!(
            classify(Err(DriveError::InvalidArguments("odd id".into()))).await,
            (DriveDelete::Refused, false)
        );
        assert_eq!(
            classify(Err(DriveError::UpstreamFailure)).await,
            (DriveDelete::Failed, false),
            "an I/O failure is retried, not refused"
        );
        assert_eq!(
            classify(Err(DriveError::Unavailable)).await,
            (DriveDelete::Failed, true),
            "an unconfigured archive stops the tick"
        );
    }
}
