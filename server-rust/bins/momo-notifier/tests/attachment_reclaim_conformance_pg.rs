//! DB-backed conformance for the attachment Drive reclaim sweep (#4443 /
//! ADR-0151 증보 2).
//!
//! Pools mirror production: the candidate read runs as `momo_notifier`
//! (BYPASSRLS, column-level read), every write as `momo_app` (RLS-bound). The Drive
//! is a recording mock — the real Google client is never contacted.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-notifier --test attachment_reclaim_conformance_pg -- --ignored --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `old_unbound_complete_attachments_are_reclaimed_and_everything_else_is_kept` | drop `status = 'complete'` (pending/failed go), `message_id IS NULL` (the carried one goes), `NOT a.reserved` (the held one goes), the `unreserved_at` term of the `GREATEST` (the just-released one goes) or the age term (the young one goes) from `eligible_core_sql` |
//! | `a_file_something_else_holds_is_never_deleted_and_never_in_the_way` | drop any one of the four `NOT EXISTS` of `NO_OTHER_HOLD_SQL` (the huddle merged transcript, the track's source, the track's transcript, a member or workspace avatar naming the same Drive object): that file is deleted — or, for a huddle column, the foreign key refuses and the pass reports a database error. Take `NO_OTHER_HOLD_SQL` out of the per-workspace listing and the five older held files fill the budget of 2 and the two free files stay |
//! | `the_switched_off_reclaimer_counts_exactly_what_the_enabled_one_deletes_and_deletes_nothing` | weaken the tally (drop the `NOT EXISTS` fragment, or `NOT a.reserved`) and its count no longer equals what the enabled sweep deletes; let the switched-off reclaimer reach `sweep_workspace` and rows go; count `bytes` from the wrong column |
//! | `a_drive_failure_writes_nothing_and_the_next_tick_retries` | take the row delete / audit row out of the savepoint, or skip `ROLLBACK TO SAVEPOINT` on `DriveDelete::Failed` |
//! | `a_drive_404_is_success_and_a_second_sweep_calls_drive_zero_times` | count `Gone` as a failure |
//! | `a_refused_delete_leaves_the_row_and_the_object` | commit the row delete on `DriveDelete::Refused` |
//! | `a_bind_or_a_hold_that_commits_while_the_reclaim_waits_beats_it` | drop the eligibility predicate from the statement after the `FOR UPDATE` (decide from the listing or from the lock alone) |
//! | `the_drive_call_runs_inside_the_row_lock_so_a_bind_waits_and_finds_the_row_gone` | call Drive before any lock is taken (no `FOR UPDATE`, Drive answers first) |
//! | `the_reclaim_cannot_reach_another_tenants_row` | drop the workspace predicate from all three statements (lock, eligibility, delete; any one of them suffices on its own, by design). The first mode stays green because RLS covers it too; the second mode, run without RLS, goes red |
//! | `a_write_pool_that_bypasses_rls_is_refused` | drop `ensure_write_pool_rls_bound` from `sweep_once` (both the deleting and the switched-off reclaimer) |
//! | `a_hold_that_appears_after_the_listing_is_seen_by_the_recheck_under_the_lock` | swap the re-check's `eligible_sql(2)` for the core part alone (the huddle-held file then fails the delete on its foreign key, the avatar-shared one is deleted, and the outcome is no longer `SkippedNotEligible`) |
//! | `an_unknown_reference_stops_the_delete_before_any_byte_goes` | call Drive before the row delete (the archive object is gone although a foreign key the predicate has never heard of refuses the row) |
//! | `the_operators_check_sql_agrees_with_the_sweep_and_would_notice_a_reference_it_does_not_know` | change one term of the check SQL's `cand` predicate (its count stops equalling the sweep's tally and the reason split's `CANDIDATE`), drop a `NOT EXISTS` from the reason split, stop listing foreign keys (a new `attachment` FK would pass unseen), drop the `reserved` drift probe, or skip a json column in the soft-reference scan |

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::PgPool;
use momo_drive::{DriveArchive, DriveContent, DriveError, DriveFile, DriveUploadSession};
use momo_messaging::attachment_reclaim::{
    reclaim_candidate_ids_in_tx, reclaim_unbound_attachment_in_tx, sweep_workspace,
    tally_workspace, workspaces_with_reclaim_candidates, AttachmentDeleter,
    AttachmentReclaimCounts, AttachmentReclaimOutcome, ReclaimTally, UNBOUND_TTL,
};
use momo_messaging::avatar_reclaim::{DriveDelete, DriveDeleteFuture};
use momo_notifier::attachment_reclaim::AttachmentReclaimer;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

/// A file name that must reach no audit row and no log.
const SECRET_NAME: &str = "private-payslip-name-visible-nowhere.pdf";

// ---------------------------------------------------------------------------
// harness (same contract as avatar_reclaim_conformance_pg.rs)
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn role_password(env_key: &str, fallback: &str) -> String {
    std::env::var(env_key).unwrap_or_else(|_| fallback.to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn role_pool(role: &str, password: String) -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options.username(role).password(&password))
        .await
        .unwrap_or_else(|error| panic!("connect as {role}: {error}"))
}

async fn momo_app_pool() -> PgPool {
    role_pool(
        "momo_app",
        role_password("MOMO_APP_PASSWORD", "momo_app_dev_pw"),
    )
    .await
}

async fn momo_notifier_pool() -> PgPool {
    role_pool(
        "momo_notifier",
        role_password("MOMO_NOTIFIER_PASSWORD", "momo_notifier_dev_pw"),
    )
    .await
}

fn resolve_psql() -> PathBuf {
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("psql");
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    for candidate in [
        "/opt/homebrew/opt/libpq/bin/psql",
        "/usr/local/opt/libpq/bin/psql",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return path;
        }
    }
    panic!("psql client not found on PATH or Homebrew libpq locations");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        ))
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

/// The sweep reads every tenant's rows; serialize the tests in this binary.
async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

// ---------------------------------------------------------------------------
// recording Drive mock
// ---------------------------------------------------------------------------

type Gate = Arc<Mutex<Option<(String, Arc<tokio::sync::Notify>)>>>;

#[derive(Debug, Default)]
struct DriveState {
    /// Every `delete_file` call, in order.
    calls: Vec<String>,
    /// Per-file scripted answers, consumed front to back; empty = `Ok(())`.
    script: HashMap<String, Vec<Result<(), DriveError>>>,
}

#[derive(Debug, Clone, Default)]
struct MockDrive {
    state: Arc<Mutex<DriveState>>,
    /// While set, `delete_file` of THIS file parks here (inside the row lock)
    /// until released — other rows are not held up.
    gate: Gate,
    entered: Arc<tokio::sync::Notify>,
}

impl MockDrive {
    fn calls_for(&self, file_id: &str) -> usize {
        self.state
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|c| c.as_str() == file_id)
            .count()
    }

    fn total_calls(&self) -> usize {
        self.state.lock().unwrap().calls.len()
    }

    fn script(&self, file_id: &str, answers: Vec<Result<(), DriveError>>) {
        self.state
            .lock()
            .unwrap()
            .script
            .insert(file_id.to_string(), answers);
    }
}

#[async_trait]
impl DriveArchive for MockDrive {
    async fn create_resumable_upload(
        &self,
        _channel_id: Uuid,
        _name: &str,
        _mime: &str,
        _size_bytes: i64,
    ) -> Result<DriveUploadSession, DriveError> {
        Err(DriveError::Unavailable)
    }
    async fn file_metadata(&self, _file_id: &str) -> Result<DriveFile, DriveError> {
        Err(DriveError::Unavailable)
    }
    async fn file_content(
        &self,
        _file_id: &str,
        _max_bytes: i64,
    ) -> Result<DriveContent, DriveError> {
        Err(DriveError::Unavailable)
    }
    async fn delete_file(&self, file_id: &str) -> Result<(), DriveError> {
        let gate = self.gate.lock().unwrap().clone();
        if let Some((gated, release)) = gate {
            if gated == file_id {
                self.entered.notify_one();
                release.notified().await;
            }
        }
        let mut state = self.state.lock().unwrap();
        state.calls.push(file_id.to_string());
        match state.script.get_mut(file_id) {
            Some(answers) if !answers.is_empty() => answers.remove(0),
            _ => Ok(()),
        }
    }
}

/// The mock as the thing that deletes — the same classification the notifier's Google
/// deleter applies (`FileNotFound` is "gone", a permanent refusal is `Refused`).
impl AttachmentDeleter for MockDrive {
    fn delete<'a>(&'a self, drive_file_id: &'a str) -> DriveDeleteFuture<'a> {
        Box::pin(async move {
            match self.delete_file(drive_file_id).await {
                Ok(()) => DriveDelete::Deleted,
                Err(DriveError::FileNotFound) => DriveDelete::Gone,
                Err(DriveError::AccessDenied | DriveError::InvalidArguments(_)) => {
                    DriveDelete::Refused
                }
                Err(_) => DriveDelete::Failed,
            }
        })
    }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

struct Tenant {
    workspace_id: Uuid,
    members: Vec<Uuid>,
    channel_id: Uuid,
}

async fn seed_tenant(su: &PgPool, member_count: usize) -> Tenant {
    let workspace_id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace_id)
        .bind(format!("atr-{}", workspace_id.simple()))
        .execute(su)
        .await
        .expect("seed workspace");
    let mut members = Vec::new();
    for _ in 0..member_count {
        let member_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
             VALUES ($1, $2, 'human', 'active', $3, $3)",
        )
        .bind(member_id)
        .bind(workspace_id)
        .bind(format!("atr-{}", &member_id.simple().to_string()[..12]))
        .execute(su)
        .await
        .expect("seed member");
        members.push(member_id);
    }
    let channel_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, created_by) \
         VALUES ($1, $2, 'public', $3, $4)",
    )
    .bind(channel_id)
    .bind(workspace_id)
    .bind(format!("c-{}", &channel_id.simple().to_string()[..8]))
    .bind(members[0])
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel_id)
        .bind(workspace_id)
        .execute(su)
        .await
        .expect("seed channel_seq");
    for member in &members {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
             VALUES ($1, $2, $3, 'member')",
        )
        .bind(workspace_id)
        .bind(channel_id)
        .bind(member)
        .execute(su)
        .await
        .expect("seed membership");
    }
    Tenant {
        workspace_id,
        members,
        channel_id,
    }
}

fn file_id() -> String {
    format!("f{}", Uuid::new_v4().simple())
}

/// One attachment row. `age_days` backdates `created_at`.
async fn attachment(
    su: &PgPool,
    t: &Tenant,
    status: &str,
    file: Option<&str>,
    age_days: i32,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO attachment \
           (workspace_id, channel_id, uploader_member_id, drive_file_id, name, mime, size_bytes, \
            status, created_at) \
         VALUES ($1, $2, $3, $4, $5, 'application/pdf', 10, $6, \
                 now() - make_interval(days => $7)) \
         RETURNING id",
    )
    .bind(t.workspace_id)
    .bind(t.channel_id)
    .bind(t.members[0])
    .bind(file)
    .bind(SECRET_NAME)
    .bind(status)
    .bind(age_days)
    .fetch_one(su)
    .await
    .expect("seed attachment")
}

/// A message to carry a file (raw seed: the sweep never reads message bodies).
async fn message(su: &PgPool, t: &Tenant) -> Uuid {
    let seq: i64 = sqlx::query_scalar(
        "UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1 RETURNING last_seq",
    )
    .bind(t.channel_id)
    .fetch_one(su)
    .await
    .expect("next seq");
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
                              author_member_id, type, body) \
         VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', 'x')",
    )
    .bind(id)
    .bind(t.workspace_id)
    .bind(t.channel_id)
    .bind(seq)
    .bind(t.members[0])
    .execute(su)
    .await
    .expect("seed message");
    id
}

async fn carry(su: &PgPool, attachment: Uuid, message: Uuid) {
    sqlx::query("UPDATE attachment SET message_id = $2 WHERE id = $1")
        .bind(attachment)
        .bind(message)
        .execute(su)
        .await
        .expect("carry");
}

async fn hold(su: &PgPool, attachment: Uuid) {
    sqlx::query("UPDATE attachment SET reserved = true WHERE id = $1")
        .bind(attachment)
        .execute(su)
        .await
        .expect("hold");
}

async fn release_days_ago(su: &PgPool, attachment: Uuid, days: i32) {
    sqlx::query(
        "UPDATE attachment SET unreserved_at = now() - make_interval(days => $2) WHERE id = $1",
    )
    .bind(attachment)
    .bind(days)
    .execute(su)
    .await
    .expect("release");
}

async fn exists(su: &PgPool, attachment: Uuid) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM attachment WHERE id = $1")
        .bind(attachment)
        .fetch_one(su)
        .await
        .expect("count")
        == 1
}

async fn expired_audit(su: &PgPool, workspace: Uuid, attachment: Uuid) -> Vec<serde_json::Value> {
    sqlx::query_scalar(
        "SELECT detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'attachment.expired' AND target_id = $2",
    )
    .bind(workspace)
    .bind(attachment)
    .fetch_all(su)
    .await
    .expect("audit rows")
}

/// Every tenant these tests seeded, so a test that counts across tenants starts from a
/// known floor (the DB is shared and earlier tests leave rows — a refused delete leaves
/// an eligible one on purpose). The tests in this binary are serialized by `test_lock`.
async fn wipe_test_tenants(su: &PgPool) {
    // The unknown-reference test's throwaway table (a foreign key into attachment) must not
    // outlive it, or the cascade below would be refused by it.
    sqlx::query("DROP TABLE IF EXISTS atr_unknown_reference")
        .execute(su)
        .await
        .expect("drop the throwaway reference table");
    sqlx::query("DELETE FROM workspace WHERE slug LIKE 'atr-%'")
        .execute(su)
        .await
        .expect("wipe the tenants earlier tests seeded");
}

/// What the delete would take from every workspace **except** `mine`. Other suites share
/// this database and leave eligible files behind; a test that compares a global count with
/// what it seeded adds this floor, computed with the same full predicate.
async fn foreign_tally(p: &Pools, mine: &[Uuid]) -> ReclaimTally {
    let hinted = workspaces_with_reclaim_candidates(&p.read, 100_000, UNBOUND_TTL)
        .await
        .expect("cross-tenant read");
    let mut total = ReclaimTally::default();
    for workspace in hinted.into_iter().filter(|w| !mine.contains(w)) {
        let tally = tally_workspace(&p.write, workspace, UNBOUND_TTL)
            .await
            .expect("tally a foreign workspace");
        total.add(&tally);
    }
    total
}

async fn set_size(su: &PgPool, attachment: Uuid, bytes: i64) {
    sqlx::query("UPDATE attachment SET size_bytes = $2 WHERE id = $1")
        .bind(attachment)
        .bind(bytes)
        .execute(su)
        .await
        .expect("size");
}

/// A recorded huddle with one transcription job and one track (raw seed: the Rust
/// server writes none of the attachment columns yet, so the fixture names them by hand —
/// they are the foreign keys of `046_huddle_transcription.sql`).
struct Huddle {
    job: Uuid,
    track: Uuid,
}

async fn huddle_transcription(su: &PgPool, t: &Tenant) -> Huddle {
    let huddle: Uuid = sqlx::query_scalar(
        "INSERT INTO huddle (workspace_id, channel_id, started_by, ended_at) \
         VALUES ($1, $2, $3, now()) RETURNING id",
    )
    .bind(t.workspace_id)
    .bind(t.channel_id)
    .bind(t.members[0])
    .fetch_one(su)
    .await
    .expect("seed huddle");
    let notice = message(su, t).await;
    let recording: Uuid = sqlx::query_scalar(
        "INSERT INTO huddle_recording \
           (workspace_id, huddle_id, channel_id, requested_by, model, status, notice_message_id) \
         VALUES ($1, $2, $3, $4, 'test-model', 'stopped', $5) RETURNING id",
    )
    .bind(t.workspace_id)
    .bind(huddle)
    .bind(t.channel_id)
    .bind(t.members[0])
    .bind(notice)
    .fetch_one(su)
    .await
    .expect("seed recording");
    let job: Uuid = sqlx::query_scalar(
        "INSERT INTO huddle_transcription_job \
           (workspace_id, huddle_id, recording_id, channel_id, model) \
         VALUES ($1, $2, $3, $4, 'test-model') RETURNING id",
    )
    .bind(t.workspace_id)
    .bind(huddle)
    .bind(recording)
    .bind(t.channel_id)
    .fetch_one(su)
    .await
    .expect("seed job");
    let track: Uuid = sqlx::query_scalar(
        "INSERT INTO huddle_transcription_track \
           (workspace_id, job_id, member_id, livekit_track_sid) \
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(t.workspace_id)
    .bind(job)
    .bind(t.members[0])
    .bind(format!("TR_{}", Uuid::new_v4().simple()))
    .fetch_one(su)
    .await
    .expect("seed track");
    Huddle { job, track }
}

async fn name_merged_transcript(su: &PgPool, huddle: &Huddle, attachment: Uuid) {
    sqlx::query(
        "UPDATE huddle_transcription_job SET merged_transcript_attachment_id = $2 WHERE id = $1",
    )
    .bind(huddle.job)
    .bind(attachment)
    .execute(su)
    .await
    .expect("merged transcript");
}

async fn name_track_source(su: &PgPool, huddle: &Huddle, attachment: Uuid) {
    sqlx::query("UPDATE huddle_transcription_track SET source_attachment_id = $2 WHERE id = $1")
        .bind(huddle.track)
        .bind(attachment)
        .execute(su)
        .await
        .expect("track source");
}

async fn name_track_transcript(su: &PgPool, huddle: &Huddle, attachment: Uuid) {
    sqlx::query(
        "UPDATE huddle_transcription_track SET transcript_attachment_id = $2 WHERE id = $1",
    )
    .bind(huddle.track)
    .bind(attachment)
    .execute(su)
    .await
    .expect("track transcript");
}

/// A member avatar media row that names the **same Drive object** as an attachment.
async fn member_avatar_naming(su: &PgPool, t: &Tenant, drive_file_id: &str) {
    sqlx::query(
        "INSERT INTO member_avatar_media \
           (workspace_id, member_id, drive_file_id, name, mime, size_bytes, status) \
         VALUES ($1, $2, $3, 'a.png', 'image/png', 10, 'complete')",
    )
    .bind(t.workspace_id)
    .bind(t.members[0])
    .bind(drive_file_id)
    .execute(su)
    .await
    .expect("member avatar media");
}

async fn workspace_avatar_naming(su: &PgPool, t: &Tenant, drive_file_id: &str) {
    sqlx::query(
        "INSERT INTO workspace_avatar_media \
           (workspace_id, uploader_member_id, drive_file_id, name, mime, size_bytes, status) \
         VALUES ($1, $2, $3, 'w.png', 'image/png', 10, 'complete')",
    )
    .bind(t.workspace_id)
    .bind(t.members[0])
    .bind(drive_file_id)
    .execute(su)
    .await
    .expect("workspace avatar media");
}

async fn tombstone(su: &PgPool, message: Uuid) {
    sqlx::query(
        "UPDATE message SET state = 'deleted', body = NULL, deleted_at = now() WHERE id = $1",
    )
    .bind(message)
    .execute(su)
    .await
    .expect("tombstone");
}

struct Pools {
    su: PgPool,
    read: PgPool,
    write: PgPool,
}

async fn pools() -> Pools {
    ensure_schema_and_roles();
    Pools {
        su: superuser_pool().await,
        read: momo_notifier_pool().await,
        write: momo_app_pool().await,
    }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn old_unbound_complete_attachments_are_reclaimed_and_everything_else_is_kept() {
    let _guard = test_lock().await;
    let p = pools().await;
    let a = seed_tenant(&p.su, 1).await;
    let b = seed_tenant(&p.su, 1).await;
    let (f_old, f_young, f_carried, f_pending, f_failed, f_held, f_released_young, f_released_old) = (
        file_id(),
        file_id(),
        file_id(),
        file_id(),
        file_id(),
        file_id(),
        file_id(),
        file_id(),
    );
    let f_other = file_id();
    // 40 days old, complete, carried by nothing, held by nothing: reclaimable.
    let old = attachment(&p.su, &a, "complete", Some(&f_old), 40).await;
    // 10 days old: young.
    let young = attachment(&p.su, &a, "complete", Some(&f_young), 10).await;
    // 40 days old but a message carries it.
    let carried = attachment(&p.su, &a, "complete", Some(&f_carried), 40).await;
    let m = message(&p.su, &a).await;
    carry(&p.su, carried, m).await;
    // 40 days old but never completed / rejected: not this sweep's.
    let pending = attachment(&p.su, &a, "pending", Some(&f_pending), 40).await;
    let failed = attachment(&p.su, &a, "failed", Some(&f_failed), 40).await;
    // 40 days old but a schedule holds it.
    let held = attachment(&p.su, &a, "complete", Some(&f_held), 40).await;
    hold(&p.su, held).await;
    // 40 days old, released 5 days ago (a draft again for a full TTL) / 35 days ago.
    let released_young = attachment(&p.su, &a, "complete", Some(&f_released_young), 40).await;
    release_days_ago(&p.su, released_young, 5).await;
    let released_old = attachment(&p.su, &a, "complete", Some(&f_released_old), 40).await;
    release_days_ago(&p.su, released_old, 35).await;
    // Another tenant's old draft: the sweep walks every tenant.
    let other = attachment(&p.su, &b, "complete", Some(&f_other), 40).await;

    let drive = MockDrive::default();
    let reclaimer = AttachmentReclaimer::new(Arc::new(drive.clone()), 500);
    let stats = reclaimer
        .sweep_once(&p.read, &p.write)
        .await
        .expect("sweep");
    assert!(stats.counts.reclaimed >= 3, "{stats:?}");

    for (f, label) in [
        (&f_old, "idle past the TTL"),
        (&f_released_old, "released long ago"),
        (&f_other, "another tenant's draft"),
    ] {
        assert_eq!(drive.calls_for(f), 1, "{label} must be deleted once");
    }
    for (f, label) in [
        (&f_young, "young"),
        (&f_carried, "carried by a message"),
        (&f_pending, "pending"),
        (&f_failed, "failed"),
        (&f_held, "held by a schedule"),
        (&f_released_young, "released a few days ago"),
    ] {
        assert_eq!(drive.calls_for(f), 0, "{label} must never be deleted");
    }
    for (id, label) in [
        (old, "idle past the TTL"),
        (released_old, "released long ago"),
        (other, "another tenant's draft"),
    ] {
        assert!(
            !exists(&p.su, id).await,
            "{label}: the row goes with the object"
        );
    }
    for (id, label) in [
        (young, "young"),
        (carried, "carried"),
        (pending, "pending"),
        (failed, "failed"),
        (held, "held"),
        (released_young, "released a few days ago"),
    ] {
        assert!(exists(&p.su, id).await, "{label}: the row stays");
    }

    // One audit row per reclaimed file, in its own tenant — and no name, no Drive id.
    for (workspace, id, f) in [
        (a.workspace_id, old, &f_old),
        (a.workspace_id, released_old, &f_released_old),
        (b.workspace_id, other, &f_other),
    ] {
        let rows = expired_audit(&p.su, workspace, id).await;
        assert_eq!(rows.len(), 1, "one audit row for {id}");
        let text = rows[0].to_string();
        assert_eq!(
            rows[0]["schema"],
            serde_json::json!("momo.attachment.expired.v1")
        );
        assert_eq!(rows[0]["reason"], serde_json::json!("unbound_ttl"));
        assert!(
            !text.contains(SECRET_NAME) && !text.contains(f),
            "the audit row of a deletion names neither the file nor its Drive object: {text}"
        );
    }
    // …and nothing was audited for the files that were kept.
    for (id, _) in [(young, ()), (carried, ()), (held, ()), (released_young, ())] {
        assert!(expired_audit(&p.su, a.workspace_id, id).await.is_empty());
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn a_drive_failure_writes_nothing_and_the_next_tick_retries() {
    let _guard = test_lock().await;
    let p = pools().await;
    let t = seed_tenant(&p.su, 1).await;
    let f = file_id();
    let id = attachment(&p.su, &t, "complete", Some(&f), 40).await;

    let drive = MockDrive::default();
    drive.script(&f, vec![Err(DriveError::UpstreamFailure), Ok(())]);
    let reclaimer = AttachmentReclaimer::new(Arc::new(drive.clone()), 500);

    let stats = reclaimer
        .sweep_once(&p.read, &p.write)
        .await
        .expect("tick 1");
    assert!(stats.counts.drive_failed >= 1, "{stats:?}");
    assert_eq!(drive.calls_for(&f), 1, "Drive was asked");
    assert!(
        exists(&p.su, id).await,
        "unreachable Drive is not 'deleted': the row delete was taken back"
    );
    assert!(
        expired_audit(&p.su, t.workspace_id, id).await.is_empty(),
        "…and so was its audit row: nothing was written"
    );

    reclaimer
        .sweep_once(&p.read, &p.write)
        .await
        .expect("tick 2");
    assert_eq!(drive.calls_for(&f), 2, "the next tick retries");
    assert!(!exists(&p.su, id).await, "and now the row goes");
    assert_eq!(expired_audit(&p.su, t.workspace_id, id).await.len(), 1);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn a_drive_404_is_success_and_a_second_sweep_calls_drive_zero_times() {
    let _guard = test_lock().await;
    let p = pools().await;
    let t = seed_tenant(&p.su, 1).await;
    let (f_gone, f_ok) = (file_id(), file_id());
    let gone = attachment(&p.su, &t, "complete", Some(&f_gone), 40).await;
    let ok = attachment(&p.su, &t, "complete", Some(&f_ok), 41).await;

    let drive = MockDrive::default();
    // Drive says the first file is already gone: that is success (the crash between
    // "Drive deleted" and COMMIT converges the same way).
    drive.script(&f_gone, vec![Err(DriveError::FileNotFound)]);
    let reclaimer = AttachmentReclaimer::new(Arc::new(drive.clone()), 500);
    reclaimer
        .sweep_once(&p.read, &p.write)
        .await
        .expect("first");
    assert!(!exists(&p.su, gone).await, "a 404 is success: the row goes");
    assert!(!exists(&p.su, ok).await);
    assert_eq!((drive.calls_for(&f_gone), drive.calls_for(&f_ok)), (1, 1));

    let before = drive.total_calls();
    reclaimer
        .sweep_once(&p.read, &p.write)
        .await
        .expect("second");
    reclaimer
        .sweep_once(&p.read, &p.write)
        .await
        .expect("third");
    assert_eq!(
        (drive.calls_for(&f_gone), drive.calls_for(&f_ok)),
        (1, 1),
        "a re-run must not touch Drive for rows already reclaimed"
    );
    assert_eq!(drive.total_calls(), before, "…and asks nothing else of it");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn a_refused_delete_leaves_the_row_and_the_object() {
    let _guard = test_lock().await;
    let p = pools().await;
    let t = seed_tenant(&p.su, 1).await;
    let f = file_id();
    let id = attachment(&p.su, &t, "complete", Some(&f), 40).await;

    let drive = MockDrive::default();
    // "Not on our shared drive": a permanent refusal. The object is not ours to delete,
    // and deleting the row would forget where it is.
    drive.script(&f, vec![Err(DriveError::AccessDenied)]);
    let reclaimer = AttachmentReclaimer::new(Arc::new(drive.clone()), 500);
    let stats = reclaimer.sweep_once(&p.read, &p.write).await.expect("tick");
    assert!(stats.counts.refused >= 1, "{stats:?}");
    assert!(exists(&p.su, id).await, "the row stays");
    assert!(
        expired_audit(&p.su, t.workspace_id, id).await.is_empty(),
        "and nothing says it was deleted"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn a_bind_or_a_hold_that_commits_while_the_reclaim_waits_beats_it() {
    let _guard = test_lock().await;
    let p = pools().await;
    let t = seed_tenant(&p.su, 1).await;
    let (f_bind, f_hold) = (file_id(), file_id());
    let to_bind = attachment(&p.su, &t, "complete", Some(&f_bind), 40).await;
    let to_hold = attachment(&p.su, &t, "complete", Some(&f_hold), 40).await;
    let m = message(&p.su, &t).await;

    // The send's transaction: it has taken the row lock (`link_attachments_in_tx`'s
    // FOR UPDATE) and bound the file, and has NOT committed. The schedule's
    // transaction does the same for the other file (the trigger's effect is the flag).
    let mut inflight = p.write.begin().await.expect("begin");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(t.workspace_id.to_string())
        .execute(&mut *inflight)
        .await
        .unwrap();
    for id in [to_bind, to_hold] {
        sqlx::query("SELECT id FROM attachment WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *inflight)
            .await
            .unwrap();
    }
    sqlx::query("UPDATE attachment SET message_id = $2 WHERE id = $1")
        .bind(to_bind)
        .bind(m)
        .execute(&mut *inflight)
        .await
        .unwrap();
    sqlx::query("UPDATE attachment SET reserved = true WHERE id = $1")
        .bind(to_hold)
        .execute(&mut *inflight)
        .await
        .unwrap();

    let drive = MockDrive::default();
    let reclaimer = AttachmentReclaimer::new(Arc::new(drive.clone()), 500);
    let (read, write) = (p.read.clone(), p.write.clone());
    let sweep = tokio::spawn(async move { reclaimer.sweep_once(&read, &write).await });

    // The reclaim read both rows as candidates (nothing is committed yet), reached the
    // row lock and has to wait.
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(
        !sweep.is_finished(),
        "the reclaim must wait on the row lock"
    );
    assert_eq!(drive.calls_for(&f_bind) + drive.calls_for(&f_hold), 0);

    inflight.commit().await.expect("commit");
    sweep.await.expect("join").expect("sweep");

    assert_eq!(
        (drive.calls_for(&f_bind), drive.calls_for(&f_hold)),
        (0, 0),
        "a file that was just bound or held is never deleted"
    );
    assert!(exists(&p.su, to_bind).await && exists(&p.su, to_hold).await);
    let carried_by: Option<Uuid> =
        sqlx::query_scalar("SELECT message_id FROM attachment WHERE id = $1")
            .bind(to_bind)
            .fetch_one(&p.su)
            .await
            .unwrap();
    assert_eq!(carried_by, Some(m), "the bind stands");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn the_drive_call_runs_inside_the_row_lock_so_a_bind_waits_and_finds_the_row_gone() {
    let _guard = test_lock().await;
    let p = pools().await;
    let t = seed_tenant(&p.su, 1).await;
    let f = file_id();
    let id = attachment(&p.su, &t, "complete", Some(&f), 40).await;

    let drive = MockDrive::default();
    let release = Arc::new(tokio::sync::Notify::new());
    *drive.gate.lock().unwrap() = Some((f.clone(), release.clone()));
    let reclaimer = AttachmentReclaimer::new(Arc::new(drive.clone()), 500);
    let (read, write) = (p.read.clone(), p.write.clone());
    let sweep = tokio::spawn(async move { reclaimer.sweep_once(&read, &write).await });
    // The reclaim is inside the Drive call, holding the row lock.
    drive.entered.notified().await;

    // A send binding the file (`link_attachments_in_tx`'s FOR UPDATE read) must wait.
    let write = p.write.clone();
    let ws = t.workspace_id;
    let bind = tokio::spawn(async move {
        let mut tx = write.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
            .bind(ws.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        let row: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM attachment WHERE id = $1 FOR UPDATE")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .unwrap();
        tx.rollback().await.ok();
        row
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!bind.is_finished(), "the bind must wait for the reclaim");

    release.notify_one();
    sweep.await.expect("join").expect("sweep");
    assert_eq!(
        bind.await.unwrap(),
        None,
        "the send then finds no such attachment (404), never a file whose bytes are gone"
    );
    assert_eq!(drive.calls_for(&f), 1);
    assert!(!exists(&p.su, id).await);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn the_reclaim_cannot_reach_another_tenants_row() {
    let _guard = test_lock().await;
    let p = pools().await;
    let a = seed_tenant(&p.su, 1).await;
    let b = seed_tenant(&p.su, 1).await;
    let f = file_id();
    let id_b = attachment(&p.su, &b, "complete", Some(&f), 40).await;
    let calls = Arc::new(Mutex::new(0u32));

    // Mode 1 — A's tenant transaction on the RLS-bound pool, aimed at B's row by B's
    // workspace id and by A's.
    for aimed_at in [b.workspace_id, a.workspace_id] {
        let counter = calls.clone();
        let outcome = momo_db::with_tenant_tx(&p.write, a.workspace_id, move |conn| {
            Box::pin(async move {
                reclaim_unbound_attachment_in_tx(conn, aimed_at, id_b, UNBOUND_TTL, move |_| {
                    Box::pin(async move {
                        *counter.lock().unwrap() += 1;
                        DriveDelete::Deleted
                    })
                })
                .await
            })
        })
        .await
        .expect("tx");
        assert_eq!(outcome, AttachmentReclaimOutcome::SkippedNotEligible);
    }
    assert_eq!(*calls.lock().unwrap(), 0, "Drive must not be called");
    assert!(exists(&p.su, id_b).await);

    // Mode 2 — the same call on a connection that RLS does not filter (the superuser's),
    // aimed at B's row with A's workspace id: the workspace predicate in the statements
    // has to hold on its own, because here nothing else does.
    let counter = calls.clone();
    let mut tx = p.su.begin().await.expect("begin");
    let outcome =
        reclaim_unbound_attachment_in_tx(&mut tx, a.workspace_id, id_b, UNBOUND_TTL, move |_| {
            Box::pin(async move {
                *counter.lock().unwrap() += 1;
                DriveDelete::Deleted
            })
        })
        .await
        .expect("reclaim");
    tx.commit().await.expect("commit");
    assert_eq!(outcome, AttachmentReclaimOutcome::SkippedNotEligible);
    assert_eq!(*calls.lock().unwrap(), 0, "Drive must not be called");
    assert!(exists(&p.su, id_b).await, "B's row is untouched");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn a_write_pool_that_bypasses_rls_is_refused() {
    let _guard = test_lock().await;
    let p = pools().await;
    let drive = MockDrive::default();
    let reclaimer = AttachmentReclaimer::new(Arc::new(drive.clone()), 500);
    // The BYPASSRLS notifier pool as the *write* pool.
    let refused = reclaimer.sweep_once(&p.read, &p.read).await;
    assert!(refused.is_err(), "a BYPASSRLS write pool must be refused");
    assert_eq!(drive.total_calls(), 0, "and nothing reached Drive");
    // The switched-off reclaimer reads through the same pool, so it refuses the same way.
    let refused_off = AttachmentReclaimer::dry_run(500)
        .sweep_once(&p.read, &p.read)
        .await;
    assert!(
        refused_off.is_err(),
        "the dry-run count runs on the write pool too, and that pool must be RLS-bound"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn a_file_something_else_holds_is_never_deleted_and_never_in_the_way() {
    let _guard = test_lock().await;
    let p = pools().await;
    wipe_test_tenants(&p.su).await;
    let t = seed_tenant(&p.su, 1).await;
    let huddle = huddle_transcription(&p.su, &t).await;

    // Seven old, complete, unbound, unreserved files: every one passes the part of the
    // definition the BYPASSRLS read can see. Five are held by something it cannot, and
    // are the OLDEST (90 days), so they sort first and would fill a window.
    let f_merged = file_id();
    let f_source = file_id();
    let f_transcript = file_id();
    let f_member_avatar = file_id();
    let f_workspace_avatar = file_id();
    let held_merged = attachment(&p.su, &t, "complete", Some(&f_merged), 90).await;
    name_merged_transcript(&p.su, &huddle, held_merged).await;
    let held_source = attachment(&p.su, &t, "complete", Some(&f_source), 91).await;
    name_track_source(&p.su, &huddle, held_source).await;
    let held_transcript = attachment(&p.su, &t, "complete", Some(&f_transcript), 92).await;
    name_track_transcript(&p.su, &huddle, held_transcript).await;
    let held_member_avatar = attachment(&p.su, &t, "complete", Some(&f_member_avatar), 93).await;
    member_avatar_naming(&p.su, &t, &f_member_avatar).await;
    let held_workspace_avatar =
        attachment(&p.su, &t, "complete", Some(&f_workspace_avatar), 94).await;
    workspace_avatar_naming(&p.su, &t, &f_workspace_avatar).await;
    // A file a message carries stays carried when the message is deleted (soft): the
    // sweep reclaims what NO message carries, and a tombstone still carries.
    let f_tombstoned = file_id();
    let carried_by_tombstone = attachment(&p.su, &t, "complete", Some(&f_tombstoned), 95).await;
    let dead = message(&p.su, &t).await;
    carry(&p.su, carried_by_tombstone, dead).await;
    tombstone(&p.su, dead).await;
    // The two files nothing holds.
    let (f_free_old, f_free_new) = (file_id(), file_id());
    let free_old = attachment(&p.su, &t, "complete", Some(&f_free_old), 41).await;
    let free_new = attachment(&p.su, &t, "complete", Some(&f_free_new), 40).await;

    // The cross-tenant read is only a hint: it names this workspace and cannot tell which
    // of the files are held. The listing under the tenant's own policies can.
    let hinted = workspaces_with_reclaim_candidates(&p.read, 100, UNBOUND_TTL)
        .await
        .expect("cross-tenant read");
    assert!(
        hinted.contains(&t.workspace_id),
        "the hint names the workspace (workspace ids are all it answers): {hinted:?}"
    );
    let workspace = t.workspace_id;
    let listed = momo_db::with_tenant_tx(&p.write, workspace, move |conn| {
        Box::pin(async move { reclaim_candidate_ids_in_tx(conn, workspace, 50, UNBOUND_TTL).await })
    })
    .await
    .expect("listing");
    assert_eq!(
        listed,
        vec![free_old, free_new],
        "the listing holds exactly the two files nothing holds, oldest first"
    );

    // A budget of two is enough for both: the held files are not in the way.
    let drive = MockDrive::default();
    let deleter: Arc<dyn AttachmentDeleter> = Arc::new(drive.clone());
    let mut failures = 0u32;
    let sweep = sweep_workspace(&p.write, workspace, UNBOUND_TTL, 2, &deleter, &mut failures)
        .await
        .expect("sweep");
    assert_eq!(sweep.listed, 2, "{sweep:?}");
    assert_eq!(sweep.counts.reclaimed, 2, "{sweep:?}");
    assert_eq!(
        sweep.db_errors, 0,
        "the predicate says no first: a foreign key refusing the delete is never what stops a held file ({sweep:?})"
    );
    assert_eq!(sweep.counts.skipped_not_eligible, 0, "{sweep:?}");

    for (f, label) in [(&f_free_old, "free, older"), (&f_free_new, "free, newer")] {
        assert_eq!(drive.calls_for(f), 1, "{label} is deleted once");
    }
    for (f, label) in [
        (&f_merged, "named by a huddle job as its merged transcript"),
        (&f_source, "named by a huddle track as its source"),
        (&f_transcript, "named by a huddle track as its transcript"),
        (&f_member_avatar, "the same Drive object as a member avatar"),
        (
            &f_workspace_avatar,
            "the same Drive object as a workspace avatar",
        ),
        (&f_tombstoned, "carried by a deleted message"),
    ] {
        assert_eq!(drive.calls_for(f), 0, "{label}: never deleted");
    }
    for (id, label) in [(free_old, "free, older"), (free_new, "free, newer")] {
        assert!(!exists(&p.su, id).await, "{label}: row gone");
    }
    for (id, label) in [
        (held_merged, "huddle merged transcript"),
        (held_source, "huddle track source"),
        (held_transcript, "huddle track transcript"),
        (held_member_avatar, "member avatar object"),
        (held_workspace_avatar, "workspace avatar object"),
        (carried_by_tombstone, "carried by a deleted message"),
    ] {
        assert!(exists(&p.su, id).await, "{label}: row stays");
        assert!(
            expired_audit(&p.su, workspace, id).await.is_empty(),
            "{label}: and nothing says it was deleted"
        );
    }

    // And a whole tick (this workspace is still in the hint: the held files look like
    // candidates from where the notifier stands) leaves every held file alone and finds
    // nothing more to delete here. Other suites share this database, so the assertions are
    // about this workspace's files, not the tick's global totals.
    AttachmentReclaimer::new(Arc::new(drive.clone()), 500)
        .sweep_once(&p.read, &p.write)
        .await
        .expect("tick");
    for f in [
        &f_merged,
        &f_source,
        &f_transcript,
        &f_member_avatar,
        &f_workspace_avatar,
        &f_tombstoned,
    ] {
        assert_eq!(
            drive.calls_for(f),
            0,
            "a held file is skipped by the predicate, tick after tick"
        );
    }
    assert_eq!(
        tally_workspace(&p.write, workspace, UNBOUND_TTL)
            .await
            .expect("tally"),
        ReclaimTally::default(),
        "nothing left to delete in this workspace"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn the_switched_off_reclaimer_counts_exactly_what_the_enabled_one_deletes_and_deletes_nothing(
) {
    let _guard = test_lock().await;
    let p = pools().await;
    wipe_test_tenants(&p.su).await;
    let a = seed_tenant(&p.su, 1).await;
    let b = seed_tenant(&p.su, 1).await;
    let c = seed_tenant(&p.su, 1).await;

    // Workspace a: two files to delete (100 + 250 bytes), and one of each kind to keep.
    let (a1, a2) = (file_id(), file_id());
    let del_a1 = attachment(&p.su, &a, "complete", Some(&a1), 40).await;
    set_size(&p.su, del_a1, 100).await;
    let del_a2 = attachment(&p.su, &a, "complete", Some(&a2), 70).await;
    set_size(&p.su, del_a2, 250).await;
    let f_young = file_id();
    attachment(&p.su, &a, "complete", Some(&f_young), 5).await;
    let f_pending = file_id();
    attachment(&p.su, &a, "pending", Some(&f_pending), 90).await;
    let f_held = file_id();
    let held = attachment(&p.su, &a, "complete", Some(&f_held), 90).await;
    hold(&p.su, held).await;
    let f_carried = file_id();
    let carried = attachment(&p.su, &a, "complete", Some(&f_carried), 90).await;
    let m = message(&p.su, &a).await;
    carry(&p.su, carried, m).await;
    // Workspace b: one file to delete (7 bytes).
    let f_b = file_id();
    let del_b = attachment(&p.su, &b, "complete", Some(&f_b), 45).await;
    set_size(&p.su, del_b, 7).await;
    // Workspace c: its only old file is named by a huddle track. The cross-tenant read
    // cannot see that, so it still names this workspace — and the count says 0 for it.
    let f_c = file_id();
    let held_c = attachment(&p.su, &c, "complete", Some(&f_c), 80).await;
    let huddle_c = huddle_transcription(&p.su, &c).await;
    name_track_transcript(&p.su, &huddle_c, held_c).await;

    let hinted = workspaces_with_reclaim_candidates(&p.read, 100, UNBOUND_TTL)
        .await
        .expect("cross-tenant read");
    assert!(
        [a.workspace_id, b.workspace_id, c.workspace_id]
            .iter()
            .all(|w| hinted.contains(w)),
        "the hint names all three, including the one whose only file is held: {hinted:?}"
    );
    let c_tally = tally_workspace(&p.write, c.workspace_id, UNBOUND_TTL)
        .await
        .expect("tally c");
    assert_eq!(
        c_tally,
        ReclaimTally::default(),
        "…but the full predicate counts nothing for it"
    );

    // The switched-off reclaimer: counts, deletes nothing, owns no Drive.
    let off = AttachmentReclaimer::dry_run(500);
    assert!(!off.deletes());
    let mine = [a.workspace_id, b.workspace_id, c.workspace_id];
    let mut expected = ReclaimTally {
        candidates: 3,
        bytes: 100 + 250 + 7,
    };
    let mine_expected = expected;
    // Other suites' leftovers, counted with the same predicate, are part of the global tally.
    let foreign = foreign_tally(&p, &mine).await;
    expected.add(&foreign);
    for tick in 1..=2 {
        let stats = off
            .sweep_once(&p.read, &p.write)
            .await
            .unwrap_or_else(|e| panic!("dry run {tick}: {e}"));
        assert_eq!(stats.dry_run, Some(expected), "tick {tick}: {stats:?}");
        assert_eq!(
            stats.counts,
            AttachmentReclaimCounts::default(),
            "{stats:?}"
        );
        assert_eq!(stats.db_errors, 0, "{stats:?}");
    }
    // Per workspace (no leftovers in the way): a and b have something to delete, c — whose
    // only old file a huddle names — has not.
    let per_workspace = |w: Uuid| {
        let write = p.write.clone();
        async move {
            tally_workspace(&write, w, UNBOUND_TTL)
                .await
                .expect("tally")
        }
    };
    assert_eq!(
        per_workspace(a.workspace_id).await,
        ReclaimTally {
            candidates: 2,
            bytes: 350
        }
    );
    assert_eq!(
        per_workspace(b.workspace_id).await,
        ReclaimTally {
            candidates: 1,
            bytes: 7
        }
    );
    assert_eq!(per_workspace(c.workspace_id).await, ReclaimTally::default());
    for (id, label) in [(del_a1, "a1"), (del_a2, "a2"), (del_b, "b")] {
        assert!(
            exists(&p.su, id).await,
            "switched off: {label} is still there"
        );
    }
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'attachment.expired' \
           AND workspace_id = ANY($1)",
    )
    .bind(vec![a.workspace_id, b.workspace_id, c.workspace_id])
    .fetch_one(&p.su)
    .await
    .unwrap();
    assert_eq!(audited, 0, "switched off: no deletion was audited");

    // The enabled reclaimer deletes exactly what the dry run counted.
    let drive = MockDrive::default();
    let on = AttachmentReclaimer::new(Arc::new(drive.clone()), 500);
    assert!(on.deletes());
    let stats = on.sweep_once(&p.read, &p.write).await.expect("enabled");
    assert_eq!(
        i64::from(stats.counts.reclaimed),
        expected.candidates,
        "the enabled sweep deletes exactly what the dry run counted: {stats:?}"
    );
    assert_eq!(drive.total_calls() as i64, expected.candidates);
    let freed: i64 = sqlx::query_scalar(
        "SELECT COALESCE(sum((detail->>'size_bytes')::bigint), 0)::bigint FROM audit_log \
          WHERE action = 'attachment.expired' AND workspace_id = ANY($1)",
    )
    .bind(vec![a.workspace_id, b.workspace_id, c.workspace_id])
    .fetch_one(&p.su)
    .await
    .unwrap();
    assert_eq!(
        freed, mine_expected.bytes,
        "the bytes the dry run counted for these workspaces are the bytes deleted from them"
    );
    for (id, label) in [(del_a1, "a1"), (del_a2, "a2"), (del_b, "b")] {
        assert!(!exists(&p.su, id).await, "enabled: {label} is gone");
    }
    // After the delete, the dry run has nothing left to report for these workspaces.
    for w in mine {
        assert_eq!(
            per_workspace(w).await,
            ReclaimTally::default(),
            "after the delete"
        );
    }
    let after = off.sweep_once(&p.read, &p.write).await.expect("after");
    assert_eq!(
        after.dry_run,
        Some(foreign_tally(&p, &mine).await),
        "{after:?}"
    );
}

// ---------------------------------------------------------------------------
// the last line of defence under the row lock
// ---------------------------------------------------------------------------

/// The listing is a hint, the lock is the decision: a hold that appears **after** the listing
/// (and so cannot have been seen by it) must be seen by the re-check under the row lock — and the
/// holds only a tenant-bound statement can see are exactly the ones a weakened re-check would
/// miss (the huddle columns, an avatar object sharing the Drive id). The functions are called
/// directly so the listing's own filtering cannot hide a weakened re-check.
#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn a_hold_that_appears_after_the_listing_is_seen_by_the_recheck_under_the_lock() {
    let _guard = test_lock().await;
    let p = pools().await;
    wipe_test_tenants(&p.su).await;
    let t = seed_tenant(&p.su, 1).await;
    let huddle = huddle_transcription(&p.su, &t).await;
    let (f_track, f_avatar) = (file_id(), file_id());
    let by_track = attachment(&p.su, &t, "complete", Some(&f_track), 90).await;
    let by_avatar = attachment(&p.su, &t, "complete", Some(&f_avatar), 91).await;
    let workspace = t.workspace_id;

    // Both are in the listing: nothing holds them yet.
    let listed = momo_db::with_tenant_tx(&p.write, workspace, move |conn| {
        Box::pin(async move { reclaim_candidate_ids_in_tx(conn, workspace, 50, UNBOUND_TTL).await })
    })
    .await
    .expect("listing");
    assert_eq!(
        listed,
        vec![by_avatar, by_track],
        "both are candidates when listed (oldest first: the avatar one is 91 days, the track one 90)"
    );

    // Then something takes them, between the listing and the row lock.
    name_track_source(&p.su, &huddle, by_track).await;
    member_avatar_naming(&p.su, &t, &f_avatar).await;

    let drive = MockDrive::default();
    let mut outcomes = Vec::new();
    for id in [by_track, by_avatar] {
        let drive = drive.clone();
        outcomes.push(
            momo_db::with_tenant_tx(&p.write, workspace, move |conn| {
                Box::pin(async move {
                    reclaim_unbound_attachment_in_tx(
                        conn,
                        workspace,
                        id,
                        UNBOUND_TTL,
                        move |file_id| Box::pin(async move { drive.delete(file_id).await }),
                    )
                    .await
                })
            })
            .await,
        );
    }
    let calls = drive.total_calls();
    let (track_row, avatar_row) = (
        exists(&p.su, by_track).await,
        exists(&p.su, by_avatar).await,
    );
    wipe_test_tenants(&p.su).await;

    for (label, outcome) in [
        ("huddle track", &outcomes[0]),
        ("avatar object", &outcomes[1]),
    ] {
        assert!(
            matches!(outcome, Ok(AttachmentReclaimOutcome::SkippedNotEligible)),
            "a file the {label} took after the listing is skipped by the re-check, not refused by a \
             foreign key or deleted: {outcome:?}"
        );
    }
    assert_eq!(calls, 0, "no archive call for a file that something took");
    assert!(track_row && avatar_row, "both rows are still there");
}

/// A reference kind the predicate has never heard of — a foreign key from a table added later —
/// must stop the delete **before any byte goes**: the row is deleted first, inside the savepoint,
/// so the foreign key refuses it and the archive is never called. (Because the row lock is held
/// to the end, no new reference can appear mid-transaction; this is the defence for a kind nobody
/// has written into the predicate yet, and the operator's check SQL names it `UNKNOWN`.)
#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn an_unknown_reference_stops_the_delete_before_any_byte_goes() {
    let _guard = test_lock().await;
    let p = pools().await;
    wipe_test_tenants(&p.su).await;
    let t = seed_tenant(&p.su, 1).await;
    let f = file_id();
    let referenced = attachment(&p.su, &t, "complete", Some(&f), 90).await;
    sqlx::query(
        "CREATE TABLE atr_unknown_reference ( \
           id serial PRIMARY KEY, attachment_id uuid NOT NULL REFERENCES attachment(id))",
    )
    .execute(&p.su)
    .await
    .expect("a table with a foreign key into attachment");
    sqlx::query("INSERT INTO atr_unknown_reference (attachment_id) VALUES ($1)")
        .bind(referenced)
        .execute(&p.su)
        .await
        .expect("a row that references the file");

    let drive = MockDrive::default();
    let stats = AttachmentReclaimer::new(Arc::new(drive.clone()), 500)
        .sweep_once(&p.read, &p.write)
        .await;
    let (calls, row) = (drive.calls_for(&f), exists(&p.su, referenced).await);
    wipe_test_tenants(&p.su).await;

    let stats = stats.expect("the sweep itself runs");
    assert!(
        stats.db_errors >= 1,
        "the foreign key refused the row delete and the sweep counted it: {stats:?}"
    );
    assert_eq!(
        calls, 0,
        "the archive object must not be deleted when a reference refuses the row"
    );
    assert!(row, "the referenced row is still there");
}

// ---------------------------------------------------------------------------
// the operator's check SQL (`infra/rust/sql/attachment_reclaim_check.sql`)
// ---------------------------------------------------------------------------

const CHECK_SQL: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../infra/rust/sql/attachment_reclaim_check.sql"
);

/// Run the check SQL as the operator would (psql, superuser) and read its `section|key|n|bytes`
/// lines. A line that does not parse is a failure, not a skipped row.
fn run_check_sql() -> std::collections::BTreeMap<(String, String), (i64, i64)> {
    let output = Command::new(resolve_psql())
        .arg(database_url())
        .args([
            "-X",
            "-A",
            "-t",
            "-F",
            "|",
            "-v",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
        ])
        .arg("-f")
        .arg(CHECK_SQL)
        .output()
        .expect("spawn psql for attachment_reclaim_check.sql");
    assert!(
        output.status.success(),
        "the check SQL failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut rows = std::collections::BTreeMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if matches!(line.trim(), "BEGIN" | "ROLLBACK" | "") {
            continue;
        }
        let parts: Vec<&str> = line.split('|').collect();
        assert_eq!(
            parts.len(),
            4,
            "a check line is section|key|n|bytes: {line:?}"
        );
        let n: i64 = parts[2].parse().unwrap_or_else(|_| panic!("n in {line:?}"));
        let bytes: i64 = parts[3]
            .parse()
            .unwrap_or_else(|_| panic!("bytes in {line:?}"));
        rows.insert((parts[0].to_string(), parts[1].to_string()), (n, bytes));
    }
    rows
}

fn count_of(
    rows: &std::collections::BTreeMap<(String, String), (i64, i64)>,
    section: &str,
    key: &str,
) -> (i64, i64) {
    rows.get(&(section.to_string(), key.to_string()))
        .copied()
        .unwrap_or((0, 0))
}

/// The operator turns the delete on after comparing the sweep's dry-run line with this SQL, so
/// the SQL must count the same thing, and must say so when something new points at a file.
///
/// What it pins (each against rows this test seeds, as a **delta** from a run just before — the
/// database is shared and other suites leave files behind):
///
/// * `candidates` equals what the sweep itself counts over every workspace (same predicate, other
///   formulation) **and** equals the `CANDIDATE` row of the reason split (a second formulation of
///   the same fact inside the SQL);
/// * each seeded kind lands in its own reason: a live message, a deleted message, a schedule, a
///   young file, a pending and a failed row, a huddle row, an avatar object;
/// * every foreign key into `attachment` is one the SQL names `(known)` — a migration that adds a
///   fifth turns this red until the reference table, the predicate and the SQL are updated;
/// * the `reserved` mirror drifting from the real reservation rows (the trigger bypassed) is
///   reported, so the check is not a mirror that agrees with itself;
/// * a candidate's id sitting inside a json column (`message.props`) is reported by the
///   soft-reference scan, so "0" there means something;
/// * a Drive object shared with another attachment row (the one reference a tenant-bound sweep
///   cannot see, because RLS hides the other workspace) is reported.
#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn the_operators_check_sql_agrees_with_the_sweep_and_would_notice_a_reference_it_does_not_know(
) {
    let _guard = test_lock().await;
    let p = pools().await;
    wipe_test_tenants(&p.su).await;
    let t = seed_tenant(&p.su, 1).await;
    let other = seed_tenant(&p.su, 1).await;
    let huddle = huddle_transcription(&p.su, &t).await;

    let before = run_check_sql();

    // Two candidates (the older one is also the soft-reference sample's first pick), and one
    // example of every reason a file is not.
    let (f_c1, f_c2) = (file_id(), file_id());
    let _c1 = attachment(&p.su, &t, "complete", Some(&f_c1), 40).await;
    let c2 = attachment(&p.su, &t, "complete", Some(&f_c2), 3_000).await;
    set_size(&p.su, c2, 1_000).await;
    let live = message(&p.su, &t).await;
    let bound_live = attachment(&p.su, &t, "complete", Some(&file_id()), 40).await;
    carry(&p.su, bound_live, live).await;
    let dead = message(&p.su, &t).await;
    let bound_dead = attachment(&p.su, &t, "complete", Some(&file_id()), 40).await;
    carry(&p.su, bound_dead, dead).await;
    tombstone(&p.su, dead).await;
    let held = attachment(&p.su, &t, "complete", Some(&file_id()), 40).await;
    hold(&p.su, held).await;
    attachment(&p.su, &t, "complete", Some(&file_id()), 10).await; // young
    attachment(&p.su, &t, "pending", Some(&file_id()), 40).await;
    attachment(&p.su, &t, "failed", Some(&file_id()), 40).await;
    let huddle_held = attachment(&p.su, &t, "complete", Some(&file_id()), 90).await;
    name_merged_transcript(&p.su, &huddle, huddle_held).await;
    let f_avatar = file_id();
    attachment(&p.su, &t, "complete", Some(&f_avatar), 91).await;
    member_avatar_naming(&p.su, &t, &f_avatar).await;

    let after = run_check_sql();
    let delta = |section: &str, key: &str| {
        let (a, ab) = count_of(&after, section, key);
        let (b, bb) = count_of(&before, section, key);
        (a - b, ab - bb)
    };

    // 1. The SQL and the sweep count the same files and the same bytes.
    let everyone = foreign_tally(&p, &[]).await;
    let (sql_n, sql_bytes) = count_of(&after, "candidates", "all_workspaces");
    assert_eq!(
        (sql_n, sql_bytes),
        (everyone.candidates, everyone.bytes),
        "the check SQL's candidates are exactly what the sweep counts over every workspace"
    );
    assert_eq!(
        delta("candidates", "all_workspaces"),
        (2, 10 + 1_000),
        "the two seeded candidates, with their bytes (10 and 1000)"
    );
    assert_eq!(
        count_of(&after, "reason", "CANDIDATE"),
        (sql_n, sql_bytes),
        "the reason split's CANDIDATE row is the same fact written a second way"
    );

    // 2. Every seeded kind lands in its own reason.
    for (reason, expected) in [
        ("CANDIDATE", 2),
        ("bound to a live message", 1),
        ("bound to a deleted message (kept: message_id is set)", 1),
        ("held by a scheduled message", 1),
        (
            "unbound, younger than 30 days (or released less than 30 days ago)",
            1,
        ),
        ("pending (this sweep never touches it)", 1),
        ("failed (this sweep never touches it)", 1),
        ("held by a huddle transcription row", 1),
        ("same Drive object as an avatar media row", 1),
    ] {
        assert_eq!(delta("reason", reason).0, expected, "reason {reason:?}");
    }

    // 3. Every foreign key into attachment is one the SQL knows. A new one would say UNKNOWN.
    let fks: Vec<&String> = after
        .keys()
        .filter(|(section, _)| section == "incoming_fk")
        .map(|(_, key)| key)
        .collect();
    assert_eq!(
        fks.len(),
        4,
        "the four foreign keys into attachment: {fks:?}"
    );
    assert!(
        fks.iter().all(|key| key.ends_with("(known)")),
        "a foreign key into attachment that the check SQL does not know is a new reference \
         kind: update the ADR-0151 증보 2 reference table, the sweep's predicate and this SQL: {fks:?}"
    );

    // 4. Nothing seeded is a candidate that something still points at, and no reservation row
    //    exists without its flag.
    for key in [
        "message_id_set",
        "reservation_row_exists",
        "huddle_transcription_row",
    ] {
        assert_eq!(
            delta("candidate_with_a_reference", key).0,
            0,
            "no candidate is referenced: {key}"
        );
    }
    assert_eq!(
        delta(
            "flag_drift_all_attachments",
            "reservation_row_without_reserved_flag"
        )
        .0,
        0
    );

    // 5. The drift probe is not a mirror agreeing with itself: bypass the trigger (as a restore
    //    or a bug would), add a reservation row for a file, and the SQL reports the lost flag.
    let drifted = attachment(&p.su, &t, "complete", Some(&file_id()), 40).await;
    let schedule = Uuid::new_v4();
    let mut conn = p.su.acquire().await.expect("a superuser connection");
    sqlx::query("SET session_replication_role = replica")
        .execute(&mut *conn)
        .await
        .expect("bypass the reserve trigger");
    sqlx::query(
        "INSERT INTO scheduled_message (id, workspace_id, channel_id, author_member_id, body, \
                                        send_at, client_request_id) \
         VALUES ($1, $2, $3, $4, 'later', now() + interval '2 days', $5)",
    )
    .bind(schedule)
    .bind(t.workspace_id)
    .bind(t.channel_id)
    .bind(t.members[0])
    .bind(Uuid::new_v4())
    .execute(&mut *conn)
    .await
    .expect("a schedule");
    sqlx::query(
        "INSERT INTO scheduled_message_attachment \
           (scheduled_message_id, workspace_id, member_id, attachment_id, position) \
         VALUES ($1, $2, $3, $4, 0)",
    )
    .bind(schedule)
    .bind(t.workspace_id)
    .bind(t.members[0])
    .bind(drifted)
    .execute(&mut *conn)
    .await
    .expect("a reservation row the flag does not know");
    sqlx::query("RESET session_replication_role")
        .execute(&mut *conn)
        .await
        .expect("restore triggers");
    drop(conn);

    // 6. A candidate's id inside a json column, and a Drive object shared with another row.
    sqlx::query("UPDATE message SET props = jsonb_build_object('note', $2::text) WHERE id = $1")
        .bind(live)
        .bind(c2.to_string())
        .execute(&p.su)
        .await
        .expect("a soft reference");
    let shared = attachment(&p.su, &other, "complete", Some(&f_c1), 5).await;
    assert!(exists(&p.su, shared).await);

    let probed = run_check_sql();
    let probe = |section: &str, key: &str| {
        let (a, _) = count_of(&probed, section, key);
        let (b, _) = count_of(&after, section, key);
        a - b
    };
    assert_eq!(
        probe(
            "flag_drift_all_attachments",
            "reservation_row_without_reserved_flag"
        ),
        1,
        "a reservation row whose flag the trigger never set is reported"
    );
    assert_eq!(
        probe("candidate_with_a_reference", "reservation_row_exists"),
        1,
        "the unflagged file is old, so the sweep's predicate calls it a candidate while a \
         reservation row still holds it: the check reports exactly that contradiction"
    );
    assert!(
        count_of(&probed, "soft_reference", "message.props").0 >= 1,
        "the soft-reference scan sees a candidate's id inside message.props: {probed:?}"
    );
    assert_eq!(
        probe("drive_object_shared_with", "another attachment row"),
        1,
        "a Drive object another attachment row also names is reported"
    );
    // The scan covers json columns the schema has today (32 at the time of writing): a column
    // dropped from the scan would show up as a missing row for one that always exists.
    for column in [
        "message.props",
        "approval.payload",
        "audit_log.detail",
        "outbox.payload",
    ] {
        assert!(
            probed.contains_key(&("soft_reference".to_string(), column.to_string())),
            "the soft-reference scan covers {column}"
        );
    }

    wipe_test_tenants(&p.su).await;
}
