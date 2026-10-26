//! DB-backed conformance for the **local-volume attachment reclaim** (#4443, ADR-0151 증보 2 D4):
//! the tick that runs in the api process because only the api process can open the volume.
//!
//! `#[ignore]` — needs a `pgvector/pgvector:pg18` superuser DB plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test attachment_reclaim_local_pg -- --ignored --test-threads=1
//! ```
//!
//! Harness contract matches `attachment_conformance_pg.rs`: `DATABASE_URL` is a **superuser**;
//! the **server** and the reclaim tick run as `momo_app` (NOBYPASSRLS). The archive is the real
//! local-volume backend, driven through the real HTTP routes (login → upload → PUT → complete).
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `the_tick_follows_the_workspaces_this_process_served_and_deletes_only_when_switched_on` | drop the `touch` in `create_upload` (nothing is looked at); let the switched-off tick reach the archive's delete (the dry run deletes); drop the age term or the `message_id` term from the shared predicate (see the notifier suite for those); look at every workspace instead of the touched ones (the untouched file goes); never `touch` the second workspace's upload (it is never swept) |
//! | `a_tick_deletes_at_most_batch_files_across_workspaces_and_the_next_tick_carries_on` | stop spending the budget as workspaces are listed (the first tick takes all four) |
//! | `a_big_backlog_in_one_workspace_does_not_starve_the_next_one` | start the next tick at the head again instead of after the workspace that spent the budget (the big backlog spends every tick's budget) |
//! | `a_set_bigger_than_one_tick_is_walked_in_windows` | never advance the cursor (every tick looks at the same first 100 workspaces and the last one is never reached) |
//! | `the_running_tick_obeys_the_switch` | hand a switched-off tick the archive (`archive_for_tick` returns `Some` while off): the loop deletes; or never hand it to a switched-on tick: the loop never deletes |
//! | `a_refused_upload_touches_nothing_and_a_pool_that_bypasses_rls_is_refused` | move the `touch` above the membership check (a 403 would touch); drop `ensure_write_pool_rls_bound` from `sweep_once` or `start` (a superuser pool runs the tick) |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_drive::{DriveArchive, DriveError, LocalDriveArchive};
use momo_messaging::attachment_reclaim::ReclaimTally;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::attachment_reclaim::{start, sweep_once, TouchedWorkspaces};
use momo_server::config::AttachmentReclaimSettings;
use momo_server::{build_app, AppState, DriveLocalBase};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "attachment-reclaim-local-secret";
const TEST_PASSWORD: &str = "attachment-reclaim-local-password";
/// A file name that must reach no audit row.
const SECRET_NAME: &str = "private-payslip-name-visible-nowhere.txt";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password(&momo_app_password()))
        .await
        .expect("connect as momo_app (bootstrap_roles.sql?)")
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

struct DirGuard(PathBuf);
impl Drop for DirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Person {
    member: Uuid,
    email: String,
}

struct Tenant {
    workspace: Uuid,
    channel: Uuid,
    person: Person,
}

async fn seed_person(su: &PgPool, workspace: Uuid) -> Person {
    let member = Uuid::new_v4();
    let email = format!("{member}@reclaim4443.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(member)
    .bind(workspace)
    .bind(member.to_string())
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, password_hash) \
         VALUES ($1, $2, $3, momo_password_hash($4))",
    )
    .bind(member)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human");
    Person { member, email }
}

/// A workspace with one person who made (and is the only member of) a public channel.
async fn seed_tenant(su: &PgPool, app: &PgPool) -> Tenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("reclaim4443-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let person = seed_person(su, workspace).await;
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("reclaim-{}", Uuid::new_v4()),
            topic: None,
            created_by: person.member,
        },
    )
    .await
    .expect("create channel");
    Tenant {
        workspace,
        channel: channel.id,
        person,
    }
}

async fn wipe(su: &PgPool, tenants: &[&Tenant]) {
    for t in tenants {
        sqlx::query("DELETE FROM workspace WHERE id = $1")
            .bind(t.workspace)
            .execute(su)
            .await
            .expect("wipe the tenant");
    }
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, person: &Person) -> String {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": person.email,
            "password": TEST_PASSWORD,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status(), 200, "seeded credentials log in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string()
}

struct Server {
    base: String,
    state: AppState,
    archive: Arc<LocalDriveArchive>,
    _dir: DirGuard,
}

async fn start_server(app: PgPool) -> Server {
    let dir = std::env::temp_dir().join(format!(
        "oort-reclaim-4443-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("temp archive");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    let base = format!("http://{address}");
    let archive =
        Arc::new(LocalDriveArchive::open(dir.to_str(), &base).expect("open local archive"));
    let state = AppState::new(
        app,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_drive(archive.clone())
    .with_drive_local_base(DriveLocalBase::Fixed(base.clone()));
    let router = build_app(state.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Server {
        base,
        state,
        archive,
        _dir: DirGuard(dir),
    }
}

/// Upload `bytes` through the real routes as `person`, and return the attachment id.
async fn upload_and_complete(
    http: &reqwest::Client,
    server: &Server,
    token: &str,
    t: &Tenant,
    name: &str,
    bytes: &[u8],
) -> Uuid {
    let created = http
        .post(format!(
            "{}/v1/workspaces/{}/channels/{}/attachments/uploads",
            server.base, t.workspace, t.channel
        ))
        .bearer_auth(token)
        .json(&json!({"name": name, "mime": "text/plain", "size": bytes.len()}))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201, "create the upload");
    let body: Value = created.json().await.expect("body");
    let upload_url = body["uploadUrl"].as_str().expect("uploadUrl").to_string();
    let id: Uuid = body["id"].as_str().expect("id").parse().expect("uuid");
    let put = http
        .put(&upload_url)
        .header(reqwest::header::CONTENT_TYPE, "text/plain")
        .body(bytes.to_vec())
        .send()
        .await
        .expect("PUT the bytes");
    assert_eq!(put.status(), 200, "the bytes land on the volume");
    let completed = http
        .post(format!(
            "{}/v1/workspaces/{}/channels/{}/attachments/{id}/complete",
            server.base, t.workspace, t.channel
        ))
        .bearer_auth(token)
        .send()
        .await
        .expect("complete");
    assert_eq!(completed.status(), 200, "complete the upload");
    id
}

async fn drive_file_id(su: &PgPool, attachment: Uuid) -> String {
    sqlx::query_scalar("SELECT drive_file_id FROM attachment WHERE id = $1")
        .bind(attachment)
        .fetch_one(su)
        .await
        .expect("drive file id")
}

async fn age(su: &PgPool, attachment: Uuid, days: i32) {
    sqlx::query(
        "UPDATE attachment SET created_at = now() - make_interval(days => $2) WHERE id = $1",
    )
    .bind(attachment)
    .bind(days)
    .execute(su)
    .await
    .expect("age the upload");
}

async fn row_exists(su: &PgPool, attachment: Uuid) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM attachment WHERE id = $1")
        .bind(attachment)
        .fetch_one(su)
        .await
        .expect("count")
        == 1
}

async fn on_volume(server: &Server, file_id: &str) -> bool {
    match server.archive.file_metadata(file_id).await {
        Ok(_) => true,
        Err(DriveError::FileNotFound) => false,
        Err(other) => panic!("unexpected archive answer for {file_id}: {other:?}"),
    }
}

async fn expired_audit(su: &PgPool, workspace: Uuid, attachment: Uuid) -> Vec<Value> {
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

fn as_drive(server: &Server) -> Arc<dyn DriveArchive> {
    Arc::clone(&server.state.drive)
}

/// The tick follows the workspaces this process served uploads for — and only deletes when the
/// operator switched it on.
///
/// A workspace whose upload went through `create_upload` is looked at; a workspace whose old file
/// this process never served is **not** (that is the documented gap — pinned so that changing it
/// means changing the ADR). Switched off, the tick counts and the volume is untouched. Switched
/// on, the object and its sidecar leave the volume, the row goes, the audit row says why and
/// carries no file name, a young file stays, and the untouched workspace stays until an upload
/// there touches it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_tick_follows_the_workspaces_this_process_served_and_deletes_only_when_switched_on() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let a = seed_tenant(&su, &app).await;
    let b = seed_tenant(&su, &app).await;
    let server = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let touched = Arc::clone(&server.state.attachment_reclaim_touched);
    assert!(touched.is_empty(), "nothing is touched before an upload");

    // Workspace A: two uploads through the real routes — one will be 40 days old, one stays young.
    let token_a = login(&http, &server.base, a.workspace, &a.person).await;
    let old = upload_and_complete(&http, &server, &token_a, &a, SECRET_NAME, b"hello").await;
    let young = upload_and_complete(&http, &server, &token_a, &a, "young.txt", b"fresh!").await;
    assert_eq!(
        touched.next_batch(None, 10),
        vec![a.workspace],
        "create_upload remembered the workspace of the authenticated principal, and only it"
    );
    let (f_old, f_young) = (
        drive_file_id(&su, old).await,
        drive_file_id(&su, young).await,
    );
    age(&su, old, 40).await;

    // Workspace B: an old file this process never served (the object arrives through a session
    // the archive made directly; no route, so no touch).
    let session = server
        .archive
        .create_resumable_upload(b.channel, "b.txt", "text/plain", 3)
        .await
        .expect("a session");
    let put = http
        .put(&session.upload_url)
        .header(reqwest::header::CONTENT_TYPE, "text/plain")
        .body(b"bbb".to_vec())
        .send()
        .await
        .expect("PUT");
    assert_eq!(put.status(), 200);
    let b_old: Uuid = sqlx::query_scalar(
        "INSERT INTO attachment (workspace_id, channel_id, uploader_member_id, drive_file_id, \
                                 name, mime, size_bytes, status, created_at) \
         VALUES ($1, $2, $3, $4, 'b.txt', 'text/plain', 3, 'complete', now() - interval '40 days') \
         RETURNING id",
    )
    .bind(b.workspace)
    .bind(b.channel)
    .bind(b.person.member)
    .bind(&session.drive_file_id)
    .fetch_one(&su)
    .await
    .expect("seed B's old file");
    assert!(on_volume(&server, &f_old).await && on_volume(&server, &session.drive_file_id).await);

    // 1. Switched off: counts what the delete would take, deletes nothing.
    let mut cursor = None;
    let dry = sweep_once(None, &touched, &app, 50, &mut cursor)
        .await
        .expect("a switched-off tick");
    assert_eq!(
        dry.dry_run,
        Some(ReclaimTally {
            candidates: 1,
            bytes: 5
        }),
        "A's one old file (5 bytes); B was not looked at, A's young file is not a candidate: {dry:?}"
    );
    assert_eq!(
        dry.looked_at, 1,
        "only the touched workspace was looked at: {dry:?}"
    );
    assert_eq!(dry.counts.reclaimed, 0, "{dry:?}");
    assert!(
        on_volume(&server, &f_old).await && row_exists(&su, old).await,
        "the switched-off tick left the object and the row"
    );
    assert!(expired_audit(&su, a.workspace, old).await.is_empty());

    // 2. Switched on: A's old file goes, with its sidecar; the young file and B's file stay.
    let drive = as_drive(&server);
    let mut cursor = None;
    let run = sweep_once(Some(&drive), &touched, &app, 50, &mut cursor)
        .await
        .expect("a deleting tick");
    assert_eq!(run.counts.reclaimed, 1, "{run:?}");
    assert_eq!(run.db_errors, 0, "{run:?}");
    assert!(
        !on_volume(&server, &f_old).await,
        "the object left the volume"
    );
    assert!(!row_exists(&su, old).await, "the row is gone");
    let audit = expired_audit(&su, a.workspace, old).await;
    assert_eq!(audit.len(), 1, "one audit row says why: {audit:?}");
    assert_eq!(audit[0]["reason"], "unbound_ttl");
    assert!(
        !audit[0].to_string().contains(SECRET_NAME) && !audit[0].to_string().contains("payslip"),
        "the audit row carries no file name: {}",
        audit[0]
    );
    assert!(
        on_volume(&server, &f_young).await && row_exists(&su, young).await,
        "a young file stays"
    );
    assert!(
        on_volume(&server, &session.drive_file_id).await && row_exists(&su, b_old).await,
        "a workspace this process never served an upload for is not looked at: its old file stays"
    );

    // 3. An upload in B touches it, and from then on the old file there is swept too.
    let token_b = login(&http, &server.base, b.workspace, &b.person).await;
    let b_new = upload_and_complete(&http, &server, &token_b, &b, "b2.txt", b"new").await;
    assert_eq!(
        touched.next_batch(None, 10).len(),
        2,
        "A and B are both remembered now"
    );
    let mut cursor = None;
    let run = sweep_once(Some(&drive), &touched, &app, 50, &mut cursor)
        .await
        .expect("a deleting tick");
    assert_eq!(run.counts.reclaimed, 1, "B's old file: {run:?}");
    assert!(!row_exists(&su, b_old).await);
    assert!(!on_volume(&server, &session.drive_file_id).await);
    assert!(row_exists(&su, b_new).await, "B's new upload stays");

    wipe(&su, &[&a, &b]).await;
}

/// A tick deletes at most `batch` files **in total**, across the workspaces it looks at, and the
/// next tick carries on with the rest (the rotation starts after the last workspace it took).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_tick_deletes_at_most_batch_files_across_workspaces_and_the_next_tick_carries_on() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let a = seed_tenant(&su, &app).await;
    let b = seed_tenant(&su, &app).await;
    let server = start_server(app.clone()).await;
    let touched = TouchedWorkspaces::default();
    touched.touch(a.workspace);
    touched.touch(b.workspace);
    // Two old files in each workspace (rows only: an object that is already gone is success
    // for the local archive, so the delete still counts).
    let mut ids = Vec::new();
    for t in [&a, &b] {
        for n in 0..2 {
            let id: Uuid = sqlx::query_scalar(
                "INSERT INTO attachment (workspace_id, channel_id, uploader_member_id, \
                                         drive_file_id, name, mime, size_bytes, status, created_at) \
                 VALUES ($1, $2, $3, $4, 'x.txt', 'text/plain', 1, 'complete', \
                         now() - make_interval(days => $5)) RETURNING id",
            )
            .bind(t.workspace)
            .bind(t.channel)
            .bind(t.person.member)
            .bind(format!("gone-{}", Uuid::new_v4().simple()))
            .bind(40 + n)
            .fetch_one(&su)
            .await
            .expect("seed an old file");
            ids.push(id);
        }
    }
    let drive = as_drive(&server);
    let mut cursor = None;
    let first = sweep_once(Some(&drive), &touched, &app, 3, &mut cursor)
        .await
        .expect("first tick");
    assert_eq!(
        first.counts.reclaimed, 3,
        "batch 3 caps the tick across both workspaces: {first:?}"
    );
    let second = sweep_once(Some(&drive), &touched, &app, 3, &mut cursor)
        .await
        .expect("second tick");
    assert_eq!(
        second.counts.reclaimed, 1,
        "the rest, on the next tick: {second:?}"
    );
    let third = sweep_once(Some(&drive), &touched, &app, 3, &mut cursor)
        .await
        .expect("third tick");
    assert_eq!(third.counts.reclaimed, 0, "nothing left: {third:?}");
    for id in ids {
        assert!(
            !row_exists(&su, id).await,
            "every old file is gone in the end"
        );
    }

    wipe(&su, &[&a, &b]).await;
}

/// Old, complete, unbound rows (no object is needed: an object that is already gone is success
/// for the local archive, so the delete still counts).
async fn old_rows(su: &PgPool, t: &Tenant, count: i32) -> Vec<Uuid> {
    let mut ids = Vec::new();
    for n in 0..count {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO attachment (workspace_id, channel_id, uploader_member_id, \
                                     drive_file_id, name, mime, size_bytes, status, created_at) \
             VALUES ($1, $2, $3, $4, 'x.txt', 'text/plain', 1, 'complete', \
                     now() - make_interval(days => $5)) RETURNING id",
        )
        .bind(t.workspace)
        .bind(t.channel)
        .bind(t.person.member)
        .bind(format!("gone-{}", Uuid::new_v4().simple()))
        .bind(40 + n)
        .fetch_one(su)
        .await
        .expect("seed an old file");
        ids.push(id);
    }
    ids
}

/// A workspace with a big backlog must not spend every tick's budget: the next tick starts after
/// the workspace whose turn ended the budget, so the other workspace is served first.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_big_backlog_in_one_workspace_does_not_starve_the_next_one() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let a = seed_tenant(&su, &app).await;
    let b = seed_tenant(&su, &app).await;
    // The set is walked in id order: the smaller id is the head of the first tick.
    let (big, small) = if a.workspace < b.workspace {
        (a, b)
    } else {
        (b, a)
    };
    let server = start_server(app.clone()).await;
    let touched = TouchedWorkspaces::default();
    touched.touch(big.workspace);
    touched.touch(small.workspace);
    let big_rows = old_rows(&su, &big, 4).await;
    let small_rows = old_rows(&su, &small, 1).await;
    let drive = as_drive(&server);
    let mut cursor = None;

    // Tick 1: the head spends the whole budget of 2 and the other workspace is not reached.
    let first = sweep_once(Some(&drive), &touched, &app, 2, &mut cursor)
        .await
        .expect("first tick");
    assert_eq!(first.counts.reclaimed, 2, "{first:?}");
    assert!(
        row_exists(&su, small_rows[0]).await,
        "the second workspace waits this tick"
    );

    // Tick 2: the head has moved on, so the small workspace is served first and the big one
    // takes what is left of the budget. Without the rotation the big workspace spends it all
    // again and the small one waits for the whole backlog.
    let second = sweep_once(Some(&drive), &touched, &app, 2, &mut cursor)
        .await
        .expect("second tick");
    assert_eq!(second.counts.reclaimed, 2, "{second:?}");
    assert!(
        !row_exists(&su, small_rows[0]).await,
        "the small workspace's file is gone after two ticks although the big backlog is not"
    );
    let mut left = 0;
    for id in &big_rows {
        if row_exists(&su, *id).await {
            left += 1;
        }
    }
    assert_eq!(
        left, 1,
        "the big workspace still has one file left: 4 - 2 - 1"
    );

    wipe(&su, &[&big, &small]).await;
}

/// A touched set bigger than one tick's limit (100 workspaces) is walked window by window: the
/// workspace that falls in the second window is reached on the second tick. The first 150 ids do
/// not exist (each is an empty tenant transaction) and sort before the real workspace.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_set_bigger_than_one_tick_is_walked_in_windows() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let real = seed_tenant(&su, &app).await;
    let server = start_server(app.clone()).await;
    let touched = TouchedWorkspaces::default();
    for n in 1..=150u128 {
        touched.touch(Uuid::from_u128(n));
    }
    touched.touch(real.workspace);
    assert!(
        real.workspace > Uuid::from_u128(150),
        "the real workspace sorts after the 150 made-up ones"
    );
    let rows = old_rows(&su, &real, 1).await;
    let drive = as_drive(&server);
    let mut cursor = None;

    let first = sweep_once(Some(&drive), &touched, &app, 50, &mut cursor)
        .await
        .expect("first tick");
    assert_eq!(first.looked_at, 100, "one window of 100: {first:?}");
    assert!(
        row_exists(&su, rows[0]).await,
        "the real workspace is in the second window"
    );
    let second = sweep_once(Some(&drive), &touched, &app, 50, &mut cursor)
        .await
        .expect("second tick");
    assert_eq!(
        second.looked_at, 100,
        "the last 51 (the real one among them), then the walk wraps around to fill the window: {second:?}"
    );
    assert_eq!(second.counts.reclaimed, 1, "{second:?}");
    assert!(
        !row_exists(&su, rows[0]).await,
        "the second window reaches the real workspace and its old file goes"
    );

    wipe(&su, &[&real]).await;
}

/// The loop itself — the timer, the switch it was started with and the archive it is handed —
/// obeys the switch, not only the functions it calls. A short interval lets the real `start`
/// run a few ticks.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_running_tick_obeys_the_switch() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let a = seed_tenant(&su, &app).await;
    let server = start_server(app.clone()).await;
    let touched = Arc::new(TouchedWorkspaces::default());
    touched.touch(a.workspace);
    let rows = old_rows(&su, &a, 1).await;
    let fast = |delete_enabled| AttachmentReclaimSettings {
        delete_enabled,
        interval_ms: 50,
        batch: 50,
    };

    // Switched off: several ticks go by and nothing is deleted.
    let (stop, rx) = tokio::sync::watch::channel(false);
    let handle = start(
        as_drive(&server),
        Arc::clone(&touched),
        app.clone(),
        fast(false),
        rx,
    )
    .await
    .expect("an RLS-bound pool runs the tick");
    tokio::time::sleep(Duration::from_millis(800)).await;
    let survived_off = row_exists(&su, rows[0]).await;
    stop.send(true).expect("stop");
    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("stops")
        .expect("no panic");
    assert!(
        survived_off,
        "a switched-off loop never deletes, however many ticks it runs"
    );

    // Switched on: the same loop, handed the archive, deletes.
    let (stop, rx) = tokio::sync::watch::channel(false);
    let handle = start(
        as_drive(&server),
        Arc::clone(&touched),
        app.clone(),
        fast(true),
        rx,
    )
    .await
    .expect("an RLS-bound pool runs the tick");
    let mut gone = false;
    for _ in 0..100 {
        if !row_exists(&su, rows[0]).await {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    stop.send(true).expect("stop");
    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("stops")
        .expect("no panic");
    assert!(
        gone,
        "a switched-on loop deletes the old file within a few ticks"
    );

    wipe(&su, &[&a]).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_refused_upload_touches_nothing_and_a_pool_that_bypasses_rls_is_refused() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let c = seed_tenant(&su, &app).await;
    // A second person of the same workspace who is NOT in the channel: the membership check
    // refuses (403) before any session is created.
    let outsider = seed_person(&su, c.workspace).await;
    let server = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let token = login(&http, &server.base, c.workspace, &outsider).await;
    let refused = http
        .post(format!(
            "{}/v1/workspaces/{}/channels/{}/attachments/uploads",
            server.base, c.workspace, c.channel
        ))
        .bearer_auth(&token)
        .json(&json!({"name": "x.txt", "mime": "text/plain", "size": 1}))
        .send()
        .await
        .expect("create");
    assert_eq!(
        refused.status(),
        403,
        "the outsider is not a channel member"
    );
    let malformed = http
        .post(format!(
            "{}/v1/workspaces/{}/channels/{}/attachments/uploads",
            server.base, c.workspace, c.channel
        ))
        .bearer_auth(&token)
        .json(&json!({"name": "", "mime": "text/plain", "size": 1}))
        .send()
        .await
        .expect("create");
    assert_eq!(malformed.status(), 400, "an empty name is refused by shape");
    assert!(
        server.state.attachment_reclaim_touched.is_empty(),
        "a request that did not create an upload remembers no workspace"
    );

    // The tick refuses a pool whose role skips row-level security — and so does `start`.
    let mut cursor = None;
    let touched = Arc::clone(&server.state.attachment_reclaim_touched);
    touched.touch(c.workspace);
    let refused = sweep_once(None, &touched, &su, 50, &mut cursor).await;
    assert!(
        refused.is_err(),
        "a superuser pool must not run the sweep: {refused:?}"
    );
    let (_stop, rx) = tokio::sync::watch::channel(false);
    assert!(
        start(
            as_drive(&server),
            Arc::clone(&touched),
            su.clone(),
            AttachmentReclaimSettings::default(),
            rx
        )
        .await
        .is_none(),
        "start refuses a superuser pool"
    );

    // …and starts on the RLS-bound one, and stops when told to.
    let (stop, rx) = tokio::sync::watch::channel(false);
    let handle = start(
        as_drive(&server),
        touched,
        app.clone(),
        AttachmentReclaimSettings::default(),
        rx,
    )
    .await
    .expect("an RLS-bound pool runs the tick");
    stop.send(true).expect("stop");
    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("the tick stops when told to")
        .expect("the tick task did not panic");

    wipe(&su, &[&c]).await;
}
