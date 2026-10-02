//! DB-backed conformance for the avatar Drive reclaim sweep (#3284 /
//! ADR-0161 D5 + 증보 2).
//!
//! Pools mirror production: the candidate read runs as `momo_notifier`
//! (BYPASSRLS, read only), every write as `momo_app` (RLS-bound). The Drive is a
//! recording mock — the real Google client is never contacted.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-notifier --test avatar_reclaim_conformance_pg -- --ignored --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `replaced_removed_failed_and_expired_are_reclaimed_current_and_young_are_kept` | widen the candidate/eligibility rule, or drop the current-avatar check |
//! | `a_settle_in_flight_wins_over_the_reclaim_and_the_current_avatar_survives` | drop the `FOR UPDATE` lock before the current check, or check "current" before locking |
//! | `a_completion_that_arrives_mid_reclaim_waits_and_then_finds_the_row_failed` | run the Drive call outside the row lock, or leave a reclaimed `pending` row `pending` |
//! | `a_second_sweep_calls_drive_zero_times_and_a_drive_404_is_success` | drop `drive_reclaimed_at IS NULL` from the candidate/eligibility rule |
//! | `a_drive_failure_writes_nothing_and_the_next_tick_retries` | mark the row before/regardless of the Drive answer |
//! | `a_refused_delete_marks_the_row_and_leaves_the_object` | retry a permanent refusal forever |
//! | `the_reclaim_cannot_reach_another_tenants_row` | run the row transaction without the tenant GUC / workspace predicate |
//! | `a_write_pool_that_bypasses_rls_is_refused` | drop the RLS-bound write-pool check |

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_drive::{DriveArchive, DriveContent, DriveError, DriveFile, DriveUploadSession};
use momo_messaging::avatar_reclaim::{
    reclaim_avatar_media_in_tx, AvatarKind, DriveDelete, ReclaimOutcome,
};
use momo_notifier::avatar_reclaim::AvatarReclaimer;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

const SECRET_NAME: &str = "private-selfie-name-visible-nowhere.png";

// ---------------------------------------------------------------------------
// harness (same contract as huddle_sweep_conformance_pg.rs)
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
    /// until released — other tenants' leftover rows are not held up.
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
}

async fn seed_tenant(su: &PgPool, member_count: usize) -> Tenant {
    let workspace_id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace_id)
        .bind(format!("ar-{}", workspace_id.simple()))
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
        .bind(format!("ar-{}", &member_id.simple().to_string()[..12]))
        .execute(su)
        .await
        .expect("seed member");
        members.push(member_id);
    }
    Tenant {
        workspace_id,
        members,
    }
}

fn file_id() -> String {
    format!("f{}", Uuid::new_v4().simple())
}

/// Insert one member avatar media row. `age_hours` backdates `created_at`.
async fn member_media(
    su: &PgPool,
    t: &Tenant,
    member: usize,
    status: &str,
    file: Option<&str>,
    age_hours: i64,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO member_avatar_media \
           (workspace_id, member_id, drive_file_id, name, mime, size_bytes, status, created_at) \
         VALUES ($1, $2, $3, $4, 'image/png', 10, $5, now() - make_interval(hours => $6::int)) \
         RETURNING id",
    )
    .bind(t.workspace_id)
    .bind(t.members[member])
    .bind(file)
    .bind(SECRET_NAME)
    .bind(status)
    .bind(age_hours as i32)
    .fetch_one(su)
    .await
    .expect("seed member media")
}

async fn workspace_media(
    su: &PgPool,
    t: &Tenant,
    status: &str,
    file: Option<&str>,
    age_hours: i64,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO workspace_avatar_media \
           (workspace_id, uploader_member_id, drive_file_id, name, mime, size_bytes, status, created_at) \
         VALUES ($1, $2, $3, $4, 'image/png', 10, $5, now() - make_interval(hours => $6::int)) \
         RETURNING id",
    )
    .bind(t.workspace_id)
    .bind(t.members[0])
    .bind(file)
    .bind(SECRET_NAME)
    .bind(status)
    .bind(age_hours as i32)
    .fetch_one(su)
    .await
    .expect("seed workspace media")
}

async fn point_member(su: &PgPool, member: Uuid, media: Uuid) {
    sqlx::query("UPDATE member SET avatar_media_id = $2 WHERE id = $1")
        .bind(member)
        .bind(media)
        .execute(su)
        .await
        .expect("point member");
}

async fn point_workspace(su: &PgPool, workspace: Uuid, media: Uuid) {
    sqlx::query("UPDATE workspace SET avatar_media_id = $2 WHERE id = $1")
        .bind(workspace)
        .bind(media)
        .execute(su)
        .await
        .expect("point workspace");
}

async fn reclaimed(su: &PgPool, table: &str, id: Uuid) -> bool {
    sqlx::query_scalar(&format!(
        "SELECT drive_reclaimed_at IS NOT NULL FROM {table} WHERE id = $1"
    ))
    .bind(id)
    .fetch_one(su)
    .await
    .expect("read reclaimed")
}

async fn status_of(su: &PgPool, table: &str, id: Uuid) -> String {
    sqlx::query_scalar(&format!("SELECT status FROM {table} WHERE id = $1"))
        .bind(id)
        .fetch_one(su)
        .await
        .expect("read status")
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

const MEMBER: &str = "member_avatar_media";
const WORKSPACE: &str = "workspace_avatar_media";

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn replaced_removed_failed_and_expired_are_reclaimed_current_and_young_are_kept() {
    let _guard = test_lock().await;
    let p = pools().await;
    let t = seed_tenant(&p.su, 2).await;
    let (f_old, f_cur, f_removed, f_failed, f_expired, f_young, f_ws_old, f_ws_cur) = (
        file_id(),
        file_id(),
        file_id(),
        file_id(),
        file_id(),
        file_id(),
        file_id(),
        file_id(),
    );
    // member 0: an old avatar that was replaced, and the current one.
    let m_old = member_media(&p.su, &t, 0, "complete", Some(&f_old), 5).await;
    let m_cur = member_media(&p.su, &t, 0, "complete", Some(&f_cur), 1).await;
    point_member(&p.su, t.members[0], m_cur).await;
    // member 1: removed (complete, pointer NULL), a rejected completion, an
    // abandoned pending, a young pending, and a reservation with no Drive file.
    let m_removed = member_media(&p.su, &t, 1, "complete", Some(&f_removed), 3).await;
    let m_failed = member_media(&p.su, &t, 1, "failed", Some(&f_failed), 2).await;
    let m_expired = member_media(&p.su, &t, 1, "pending", Some(&f_expired), 25).await;
    let m_young = member_media(&p.su, &t, 1, "pending", Some(&f_young), 1).await;
    let m_reservation = member_media(&p.su, &t, 1, "failed", None, 30).await;
    // workspace avatar: replaced + current.
    let w_old = workspace_media(&p.su, &t, "complete", Some(&f_ws_old), 5).await;
    let w_cur = workspace_media(&p.su, &t, "complete", Some(&f_ws_cur), 1).await;
    point_workspace(&p.su, t.workspace_id, w_cur).await;

    let drive = MockDrive::default();
    let reclaimer = AvatarReclaimer::new(Arc::new(drive.clone()), 500);
    let stats = reclaimer
        .sweep_once(&p.read, &p.write)
        .await
        .expect("sweep");
    assert!(stats.counts.reclaimed() >= 5, "{stats:?}");

    for (f, label) in [
        (&f_old, "replaced"),
        (&f_removed, "removed"),
        (&f_failed, "failed"),
        (&f_expired, "expired pending"),
        (&f_ws_old, "workspace replaced"),
    ] {
        assert_eq!(drive.calls_for(f), 1, "{label} must be deleted once");
    }
    for (f, label) in [
        (&f_cur, "current member avatar"),
        (&f_young, "young pending"),
        (&f_ws_cur, "current workspace avatar"),
    ] {
        assert_eq!(drive.calls_for(f), 0, "{label} must never be deleted");
    }

    assert!(reclaimed(&p.su, MEMBER, m_old).await);
    assert!(reclaimed(&p.su, MEMBER, m_removed).await);
    assert!(reclaimed(&p.su, MEMBER, m_failed).await);
    assert!(reclaimed(&p.su, MEMBER, m_expired).await);
    assert!(reclaimed(&p.su, WORKSPACE, w_old).await);
    assert!(!reclaimed(&p.su, MEMBER, m_cur).await);
    assert!(!reclaimed(&p.su, MEMBER, m_young).await);
    assert!(!reclaimed(&p.su, MEMBER, m_reservation).await);
    assert!(!reclaimed(&p.su, WORKSPACE, w_cur).await);
    // The abandoned pending can no longer be completed into a dead file.
    assert_eq!(status_of(&p.su, MEMBER, m_expired).await, "failed");
    assert_eq!(status_of(&p.su, MEMBER, m_old).await, "complete");
    // Pointers untouched.
    let pointer: Option<Uuid> =
        sqlx::query_scalar("SELECT avatar_media_id FROM member WHERE id = $1")
            .bind(t.members[0])
            .fetch_one(&p.su)
            .await
            .unwrap();
    assert_eq!(pointer, Some(m_cur));
    let ws_pointer: Option<Uuid> =
        sqlx::query_scalar("SELECT avatar_media_id FROM workspace WHERE id = $1")
            .bind(t.workspace_id)
            .fetch_one(&p.su)
            .await
            .unwrap();
    assert_eq!(ws_pointer, Some(w_cur));

    // Audit: counts only — no file name, no Drive id, no member id.
    let detail: String = sqlx::query_scalar(
        "SELECT detail::text FROM audit_log \
          WHERE workspace_id = $1 AND action = 'avatar.drive_reclaimed'",
    )
    .bind(t.workspace_id)
    .fetch_one(&p.su)
    .await
    .expect("one audit row for the tick");
    assert!(
        detail.contains("\"replaced\": 3") || detail.contains("\"replaced\":3"),
        "{detail}"
    );
    assert!(!detail.contains(SECRET_NAME), "{detail}");
    assert!(
        !detail.contains(&f_old) && !detail.contains(&f_cur),
        "{detail}"
    );
    assert!(!detail.contains(&t.members[0].to_string()), "{detail}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn a_settle_in_flight_wins_over_the_reclaim_and_the_current_avatar_survives() {
    let _guard = test_lock().await;
    let p = pools().await;
    let t = seed_tenant(&p.su, 1).await;
    let f = file_id();
    // An old pending upload: eligible as "abandoned" — until a completion lands.
    let media = member_media(&p.su, &t, 0, "pending", Some(&f), 25).await;

    // The completion's transaction: marks the row complete and re-points the
    // member at it, and has NOT committed yet.
    let mut settle = p.write.begin().await.expect("begin settle");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(t.workspace_id.to_string())
        .execute(&mut *settle)
        .await
        .unwrap();
    sqlx::query("UPDATE member_avatar_media SET status = 'complete' WHERE id = $1")
        .bind(media)
        .execute(&mut *settle)
        .await
        .unwrap();
    sqlx::query("UPDATE member SET avatar_media_id = $2 WHERE id = $1")
        .bind(t.members[0])
        .bind(media)
        .execute(&mut *settle)
        .await
        .unwrap();

    let drive = MockDrive::default();
    let reclaimer = AvatarReclaimer::new(Arc::new(drive.clone()), 500);
    let (read, write) = (p.read.clone(), p.write.clone());
    let sweep = tokio::spawn(async move { reclaimer.sweep_once(&read, &write).await });

    // The reclaim reaches the row lock and has to wait for the completion.
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(
        !sweep.is_finished(),
        "the reclaim must wait on the row lock"
    );
    assert_eq!(drive.calls_for(&f), 0);

    settle.commit().await.expect("commit settle");
    sweep.await.expect("join").expect("sweep");

    assert_eq!(
        drive.calls_for(&f),
        0,
        "a just-completed avatar is never deleted"
    );
    assert!(!reclaimed(&p.su, MEMBER, media).await);
    assert_eq!(status_of(&p.su, MEMBER, media).await, "complete");
    let pointer: Option<Uuid> =
        sqlx::query_scalar("SELECT avatar_media_id FROM member WHERE id = $1")
            .bind(t.members[0])
            .fetch_one(&p.su)
            .await
            .unwrap();
    assert_eq!(pointer, Some(media), "the member still has an avatar");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn a_completion_that_arrives_mid_reclaim_waits_and_then_finds_the_row_failed() {
    let _guard = test_lock().await;
    let p = pools().await;
    let t = seed_tenant(&p.su, 1).await;
    let f = file_id();
    let media = member_media(&p.su, &t, 0, "pending", Some(&f), 25).await;

    let drive = MockDrive::default();
    let release = Arc::new(tokio::sync::Notify::new());
    *drive.gate.lock().unwrap() = Some((f.clone(), release.clone()));
    let reclaimer = AvatarReclaimer::new(Arc::new(drive.clone()), 500);
    let (read, write) = (p.read.clone(), p.write.clone());
    let sweep = tokio::spawn(async move { reclaimer.sweep_once(&read, &write).await });
    // The reclaim is inside the Drive call, holding the row lock.
    drive.entered.notified().await;

    // A completion (the route's `FOR UPDATE` read of the row) must wait.
    let write = p.write.clone();
    let ws = t.workspace_id;
    let completion = tokio::spawn(async move {
        let mut tx = write.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
            .bind(ws.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        let status: String =
            sqlx::query_scalar("SELECT status FROM member_avatar_media WHERE id = $1 FOR UPDATE")
                .bind(media)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        tx.rollback().await.ok();
        status
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        !completion.is_finished(),
        "the completion must wait for the reclaim"
    );

    release.notify_one();
    sweep.await.expect("join").expect("sweep");
    // The route refuses anything that is not `pending` — and it is `failed` now.
    assert_eq!(completion.await.unwrap(), "failed");
    assert_eq!(drive.calls_for(&f), 1);
    assert!(reclaimed(&p.su, MEMBER, media).await);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn a_second_sweep_calls_drive_zero_times_and_a_drive_404_is_success() {
    let _guard = test_lock().await;
    let p = pools().await;
    let t = seed_tenant(&p.su, 1).await;
    let (f_gone, f_ok) = (file_id(), file_id());
    let m_gone = member_media(&p.su, &t, 0, "failed", Some(&f_gone), 2).await;
    let m_ok = member_media(&p.su, &t, 0, "complete", Some(&f_ok), 3).await;

    let drive = MockDrive::default();
    // Drive says the first file is already gone: that is success.
    drive.script(&f_gone, vec![Err(DriveError::FileNotFound)]);
    let reclaimer = AvatarReclaimer::new(Arc::new(drive.clone()), 500);
    reclaimer
        .sweep_once(&p.read, &p.write)
        .await
        .expect("first");
    assert!(reclaimed(&p.su, MEMBER, m_gone).await, "404 marks the row");
    assert!(reclaimed(&p.su, MEMBER, m_ok).await);
    assert_eq!((drive.calls_for(&f_gone), drive.calls_for(&f_ok)), (1, 1));

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
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn a_drive_failure_writes_nothing_and_the_next_tick_retries() {
    let _guard = test_lock().await;
    let p = pools().await;
    let t = seed_tenant(&p.su, 1).await;
    let f = file_id();
    let media = member_media(&p.su, &t, 0, "complete", Some(&f), 3).await;

    let drive = MockDrive::default();
    drive.script(&f, vec![Err(DriveError::UpstreamFailure), Ok(())]);
    let reclaimer = AvatarReclaimer::new(Arc::new(drive.clone()), 500);

    let stats = reclaimer
        .sweep_once(&p.read, &p.write)
        .await
        .expect("tick 1");
    assert!(stats.counts.drive_failed >= 1, "{stats:?}");
    assert!(
        !reclaimed(&p.su, MEMBER, media).await,
        "unreachable Drive is not 'deleted'"
    );

    reclaimer
        .sweep_once(&p.read, &p.write)
        .await
        .expect("tick 2");
    assert!(reclaimed(&p.su, MEMBER, media).await);
    assert_eq!(drive.calls_for(&f), 2);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn a_refused_delete_marks_the_row_and_leaves_the_object() {
    let _guard = test_lock().await;
    let p = pools().await;
    let t = seed_tenant(&p.su, 1).await;
    let f = file_id();
    let media = member_media(&p.su, &t, 0, "complete", Some(&f), 3).await;

    let drive = MockDrive::default();
    // "Not on our shared drive": a permanent refusal, never retried.
    drive.script(&f, vec![Err(DriveError::AccessDenied)]);
    let reclaimer = AvatarReclaimer::new(Arc::new(drive.clone()), 500);
    let stats = reclaimer.sweep_once(&p.read, &p.write).await.expect("tick");
    assert!(stats.counts.refused >= 1, "{stats:?}");
    assert!(reclaimed(&p.su, MEMBER, media).await);
    reclaimer
        .sweep_once(&p.read, &p.write)
        .await
        .expect("again");
    assert_eq!(drive.calls_for(&f), 1, "a permanent refusal is not retried");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn the_reclaim_cannot_reach_another_tenants_row() {
    let _guard = test_lock().await;
    let p = pools().await;
    let a = seed_tenant(&p.su, 1).await;
    let b = seed_tenant(&p.su, 1).await;
    let f = file_id();
    let media_b = member_media(&p.su, &b, 0, "complete", Some(&f), 3).await;

    // A's tenant transaction, aimed at B's row — by B's workspace id, and by A's.
    for aimed_at in [b.workspace_id, a.workspace_id] {
        let calls = Arc::new(Mutex::new(0u32));
        let counter = calls.clone();
        let outcome = with_tenant_tx(&p.write, a.workspace_id, move |conn| {
            Box::pin(async move {
                reclaim_avatar_media_in_tx(conn, aimed_at, AvatarKind::Member, media_b, move |_| {
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
        assert_eq!(outcome, ReclaimOutcome::SkippedNotEligible);
        assert_eq!(*calls.lock().unwrap(), 0, "Drive must not be called");
    }
    assert!(!reclaimed(&p.su, MEMBER, media_b).await);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL (pgvector/pg18 superuser) with bootstrap roles"]
async fn a_write_pool_that_bypasses_rls_is_refused() {
    let _guard = test_lock().await;
    let p = pools().await;
    let reclaimer = AvatarReclaimer::new(Arc::new(MockDrive::default()), 500);
    // The BYPASSRLS notifier pool as the *write* pool.
    let refused = reclaimer.sweep_once(&p.read, &p.read).await;
    assert!(refused.is_err(), "a BYPASSRLS write pool must be refused");
}
