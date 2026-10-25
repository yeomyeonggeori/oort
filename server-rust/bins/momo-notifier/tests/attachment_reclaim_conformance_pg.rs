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
//! | `old_unbound_complete_attachments_are_reclaimed_and_everything_else_is_kept` | drop `status = 'complete'` (pending/failed go), `message_id IS NULL` (the carried one goes), `NOT a.reserved` (the held one goes), the `unreserved_at` term of the `GREATEST` (the just-released one goes) or the age term (the young one goes) from `eligible_sql` |
//! | `a_drive_failure_writes_nothing_and_the_next_tick_retries` | take the row delete / audit row out of the savepoint, or skip `ROLLBACK TO SAVEPOINT` on `DriveDelete::Failed` |
//! | `a_drive_404_is_success_and_a_second_sweep_calls_drive_zero_times` | count `Gone` as a failure |
//! | `a_refused_delete_leaves_the_row_and_the_object` | commit the row delete on `DriveDelete::Refused` |
//! | `a_bind_or_a_hold_that_commits_while_the_reclaim_waits_beats_it` | drop the eligibility predicate from the statement after the `FOR UPDATE` (decide from the candidate list or from the lock alone) |
//! | `the_drive_call_runs_inside_the_row_lock_so_a_bind_waits_and_finds_the_row_gone` | call Drive before any lock is taken (no `FOR UPDATE`, Drive answers first) |
//! | `the_reclaim_cannot_reach_another_tenants_row` | drop the workspace predicate from all three statements (lock, eligibility, delete; any one of them suffices on its own, by design). The first mode stays green because RLS covers it too; the second mode, run without RLS, goes red |
//! | `a_write_pool_that_bypasses_rls_is_refused` | drop `ensure_write_pool_rls_bound` from `sweep_once` |

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
    reclaim_unbound_attachment_in_tx, AttachmentReclaimOutcome, UNBOUND_TTL,
};
use momo_messaging::avatar_reclaim::DriveDelete;
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
}
