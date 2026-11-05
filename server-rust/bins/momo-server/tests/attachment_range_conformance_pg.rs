//! Attachment content `Range`, `HEAD` and the 206/416 table
//! (ADR-0151 증보 5 D3, #4671) — driven over real HTTP against a real Postgres.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test attachment_range_conformance_pg -- --ignored --nocapture
//! ```
//!
//! What this file holds, and why it is a file of its own: the **authorization
//! boundary is unchanged**. `Range` is read only after authentication, active
//! channel membership, the readable predicate and `status = complete` have all
//! passed, so a request that fails any of them answers exactly what it answered
//! before ranges existed — and a 416 is only ever sent for a file the reader may
//! read. The first test is that claim over every way a read can be refused, with
//! two tenants and the non-bypass `momo_app` role (RLS in force); the rest are the
//! response table, the headers, `HEAD`, and the archive's disagreement with the
//! row.
//!
//! The archive is `momo_drive`'s in-process stub (or the real local volume where a
//! test says so) behind a wrapper that counts what the route asks of it. **No real
//! Drive is touched.** Harness contract is `attachment_conformance_pg.rs`'s:
//! `DATABASE_URL` is a superuser (migrations and fixture seeding) and the server
//! runs as `momo_app` (NOBYPASSRLS).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures::StreamExt;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_drive::{
    ByteRange, DriveArchive, DriveContent, DriveError, DriveFile, DriveRangeContent,
    DriveUploadSession, LocalDriveArchive, StubDriveArchive, UploadBody,
};
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::{build_app, AppState};
use reqwest::header::HeaderMap;
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "attachment-range-conformance-signing-secret";
const TEST_PASSWORD: &str = "attachment-range-conformance-password";

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
        .expect("connect as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let options = options.username("momo_app").password(&momo_app_password());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .expect("connect as momo_app (run bootstrap_roles.sql first)")
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

fn apply_bootstrap_roles() {
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    apply_bootstrap_roles();
    *ready = true;
}

/// What the route asked of the archive. Shared with the test, so a count taken
/// after a request says exactly what that request cost the archive.
#[derive(Debug, Clone, Default)]
struct Watch {
    range_reads: Arc<AtomicUsize>,
    content_reads: Arc<AtomicUsize>,
    metadata_reads: Arc<AtomicUsize>,
    /// Bytes pulled out of range-read bodies.
    bytes_pulled: Arc<AtomicU64>,
    /// Added to the total the archive reports (to make it disagree with the row).
    total_skew: Arc<AtomicI64>,
    /// The `(first, last)` of every range the route asked the archive for.
    ranges: Arc<Mutex<Vec<(u64, u64)>>>,
}

impl Watch {
    fn reset(&self) {
        self.range_reads.store(0, Ordering::SeqCst);
        self.content_reads.store(0, Ordering::SeqCst);
        self.metadata_reads.store(0, Ordering::SeqCst);
        self.bytes_pulled.store(0, Ordering::SeqCst);
    }

    /// The ranges asked of the archive since the last call, in order.
    fn take_ranges(&self) -> Vec<(u64, u64)> {
        std::mem::take(&mut *self.ranges.lock().expect("the log is never poisoned"))
    }

    fn range_reads(&self) -> usize {
        self.range_reads.load(Ordering::SeqCst)
    }

    /// Every way the route could have reached the archive for a read.
    fn archive_touches(&self) -> usize {
        self.range_reads.load(Ordering::SeqCst)
            + self.content_reads.load(Ordering::SeqCst)
            + self.metadata_reads.load(Ordering::SeqCst)
    }

    fn bytes_pulled(&self) -> u64 {
        self.bytes_pulled.load(Ordering::SeqCst)
    }
}

/// The stub archive, counting every read it is asked for.
#[derive(Debug)]
struct WatchedArchive {
    inner: StubDriveArchive,
    watch: Watch,
}

#[async_trait]
impl DriveArchive for WatchedArchive {
    fn accepts_stub_uploads(&self) -> bool {
        true
    }

    async fn create_resumable_upload(
        &self,
        channel_id: Uuid,
        name: &str,
        mime: &str,
        size_bytes: i64,
    ) -> Result<DriveUploadSession, DriveError> {
        self.inner
            .create_resumable_upload(channel_id, name, mime, size_bytes)
            .await
    }

    async fn file_metadata(&self, file_id: &str) -> Result<DriveFile, DriveError> {
        self.watch.metadata_reads.fetch_add(1, Ordering::SeqCst);
        self.inner.file_metadata(file_id).await
    }

    async fn file_content(
        &self,
        file_id: &str,
        max_bytes: i64,
    ) -> Result<DriveContent, DriveError> {
        self.watch.content_reads.fetch_add(1, Ordering::SeqCst);
        self.inner.file_content(file_id, max_bytes).await
    }

    async fn file_range(
        &self,
        file_id: &str,
        range: ByteRange,
        max_bytes: i64,
    ) -> Result<DriveRangeContent, DriveError> {
        self.watch.range_reads.fetch_add(1, Ordering::SeqCst);
        self.watch
            .ranges
            .lock()
            .expect("the log is never poisoned")
            .push((range.start(), range.end()));
        let mut content = self.inner.file_range(file_id, range, max_bytes).await?;
        content.total_size_bytes += self.watch.total_skew.load(Ordering::SeqCst);
        let pulled = self.watch.bytes_pulled.clone();
        content.body = content
            .body
            .inspect(move |item| {
                if let Ok(chunk) = item {
                    pulled.fetch_add(chunk.len() as u64, Ordering::SeqCst);
                }
            })
            .boxed();
        Ok(content)
    }

    async fn delete_file(&self, file_id: &str) -> Result<(), DriveError> {
        self.inner.delete_file(file_id).await
    }

    async fn accept_stub_upload(
        &self,
        token: &str,
        mime: Option<&str>,
        content_length: Option<u64>,
        body: UploadBody,
    ) -> Result<(), DriveError> {
        self.inner
            .accept_stub_upload(token, mime, content_length, body)
            .await
    }
}

/// Boot the real router with `make_archive`'s archive on an ephemeral port.
async fn start_server_with<F>(pool: PgPool, make_archive: F) -> (String, Arc<dyn DriveArchive>)
where
    F: FnOnce(String) -> Arc<dyn DriveArchive>,
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    let base = format!("http://{address}");
    let archive = make_archive(base.clone());
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_drive(archive.clone());
    let app = build_app(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (base, archive)
}

/// A server whose archive is watched: its base URL, the `Watch`, and the archive.
async fn start_watched_server(pool: PgPool) -> (String, Watch, Arc<dyn DriveArchive>) {
    let watch = Watch::default();
    let shared = watch.clone();
    let (base, archive) = start_server_with(pool, move |base| {
        Arc::new(WatchedArchive {
            inner: StubDriveArchive::new(&base),
            watch: shared,
        })
    })
    .await;
    (base, watch, archive)
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

struct Person {
    member: Uuid,
    email: String,
}

struct Fixture {
    workspace: Uuid,
    channel: Uuid,
    /// Another channel of the same workspace — the "wrong channel" case.
    other_channel: Uuid,
    /// The uploader; also the owner of both channels.
    alice: Person,
    /// A member of both channels: may read, may not bind Alice's files.
    bob: Person,
    /// A member of the workspace who is in NO channel.
    outsider: Person,
}

async fn seed_person(su: &PgPool, workspace: Uuid) -> Person {
    let member = Uuid::new_v4();
    let email = format!("{member}@range.test");
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

async fn seed(su: &PgPool, app: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    let alice = seed_person(su, workspace).await;
    let bob = seed_person(su, workspace).await;
    let outsider = seed_person(su, workspace).await;
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("range-{}", Uuid::new_v4()),
            topic: None,
            created_by: alice.member,
        },
    )
    .await
    .expect("create channel");
    let other_channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("range-other-{}", Uuid::new_v4()),
            topic: None,
            created_by: alice.member,
        },
    )
    .await
    .expect("create other channel");
    for channel_id in [channel.id, other_channel.id] {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
             VALUES ($1, $2, $3, 'member')",
        )
        .bind(workspace)
        .bind(channel_id)
        .bind(bob.member)
        .execute(su)
        .await
        .expect("seed bob membership");
    }
    Fixture {
        workspace,
        channel: channel.id,
        other_channel: other_channel.id,
        alice,
        bob,
        outsider,
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

fn uploads_url(base: &str, workspace: Uuid, channel: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/attachments/uploads")
}

fn messages_url(base: &str, workspace: Uuid, channel: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/messages")
}

fn content_url(base: &str, workspace: Uuid, channel: Uuid, attachment: &str) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/attachments/{attachment}/content")
}

/// `POST …/attachments/uploads`: the pending row's id and the capability URL.
#[allow(clippy::too_many_arguments)]
async fn create_session(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    name: &str,
    mime: &str,
    size: usize,
) -> (String, String) {
    let created = http
        .post(uploads_url(base, workspace, channel))
        .bearer_auth(token)
        .json(&json!({"name": name, "mime": mime, "size": size}))
        .send()
        .await
        .expect("create upload");
    assert_eq!(created.status(), 201, "a created session answers 201");
    let created: Value = created.json().await.expect("upload body");
    (
        created["id"].as_str().expect("id").to_string(),
        created["uploadUrl"]
            .as_str()
            .expect("uploadUrl")
            .to_string(),
    )
}

/// Session → upload → complete, returning the attachment id.
#[allow(clippy::too_many_arguments)]
async fn upload_and_complete(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    name: &str,
    mime: &str,
    bytes: &[u8],
) -> String {
    let (id, upload_url) = create_session(
        http,
        base,
        token,
        workspace,
        channel,
        name,
        mime,
        bytes.len(),
    )
    .await;
    let uploaded = http
        .put(&upload_url)
        .header(reqwest::header::CONTENT_TYPE, mime)
        .body(bytes.to_vec())
        .send()
        .await
        .expect("stub upload");
    assert_eq!(
        uploaded.status(),
        200,
        "the bytes go straight to the archive"
    );
    let completed = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/channels/{channel}/attachments/{id}/complete"
        ))
        .bearer_auth(token)
        .send()
        .await
        .expect("complete");
    assert_eq!(completed.status(), 200, "a verified upload completes");
    let completed: Value = completed.json().await.expect("complete body");
    assert_eq!(completed["status"], json!("complete"));
    id
}

/// A message by `token`'s owner carrying `attachment_ids`; returns its id.
async fn post_with_files(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    body: &str,
    attachment_ids: &[&str],
) -> String {
    let sent = http
        .post(messages_url(base, workspace, channel))
        .bearer_auth(token)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "type": "text",
            "body": body,
            "attachmentIds": attachment_ids,
        }))
        .send()
        .await
        .expect("post");
    assert_eq!(sent.status(), 201, "the post is accepted");
    let sent: Value = sent.json().await.expect("post body");
    sent["id"].as_str().expect("message id").to_string()
}

/// The author deletes her own message (the route is author-only).
async fn delete_message_as(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    message_id: &str,
) {
    let deleted = http
        .delete(format!(
            "{base}/v1/workspaces/{workspace}/messages/{message_id}"
        ))
        .bearer_auth(token)
        .send()
        .await
        .expect("delete");
    assert!(
        deleted.status().is_success(),
        "the author deletes her own message: {}",
        deleted.status()
    );
}

/// One answer: its status, its headers and its exact body bytes.
struct Reply {
    status: u16,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    /// `error.message` of a refusal's body (empty when the body is not an error).
    fn refusal(&self) -> String {
        serde_json::from_slice::<Value>(&self.body)
            .ok()
            .and_then(|parsed| parsed["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_default()
    }

    /// `error.code` of a refusal's body (`None` when the body names none).
    fn refusal_code(&self) -> Option<String> {
        serde_json::from_slice::<Value>(&self.body)
            .ok()
            .and_then(|parsed| parsed["error"]["code"].as_str().map(str::to_string))
    }
}

/// One request to the content route. `extra` are added verbatim (so a test can
/// send two `Range` headers, or an `If-Range`).
async fn ask(
    http: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    token: Option<&str>,
    extra: &[(&str, &str)],
) -> Reply {
    let mut request = http.request(method, url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    for (name, value) in extra {
        request = request.header(*name, *value);
    }
    let response = request.send().await.expect("content request");
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response.bytes().await.expect("body").to_vec();
    Reply {
        status,
        headers,
        body,
    }
}

async fn get(http: &reqwest::Client, url: &str, token: Option<&str>, range: Option<&str>) -> Reply {
    let extra: Vec<(&str, &str)> = range.map(|range| ("range", range)).into_iter().collect();
    ask(http, reqwest::Method::GET, url, token, &extra).await
}

async fn head(
    http: &reqwest::Client,
    url: &str,
    token: Option<&str>,
    range: Option<&str>,
) -> Reply {
    let extra: Vec<(&str, &str)> = range.map(|range| ("range", range)).into_iter().collect();
    ask(http, reqwest::Method::HEAD, url, token, &extra).await
}

// ---------------------------------------------------------------------------
// red proof — the authorization boundary does not move
// ---------------------------------------------------------------------------

/// The `Range` values the oracle test sends to every refused read: a satisfiable
/// one, an unsatisfiable one two ways, a list, and one too long for a `u64`.
const ORACLE_RANGES: [&str; 5] = [
    "bytes=0-0",
    "bytes=999999-",
    "bytes=-0",
    "bytes=0-1,5-6",
    "bytes=0-99999999999999999999999",
];

/// **Red proof (D3 오라클).** `Range` is never a question about whether a file
/// exists or how big it is.
///
/// Every way a read can be refused — another member's draft, a deleted message's
/// file (two half tombstones too), an id that never existed, the right id under
/// the wrong channel, an upload still `pending`, one that `failed`, a person who
/// is in no channel, another tenant (three ways), and no credential at all — is
/// asked with no `Range`, then with each of [`ORACLE_RANGES`] as a `GET`, and as a
/// `HEAD`. Every answer's status and body are byte for byte the answer to the plain
/// request, and the archive is never touched. A control then asks the same ranges
/// of a file the reader may read and gets 206, 416 and 200 — so "all the same"
/// above is the boundary holding, not ranges being ignored.
///
/// Read `Range` before the `status = complete` check and the `pending` and
/// `failed` rows answer 416 (their declared size is real) instead of 404. Read it
/// before the predicate and the non-members would too.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_range_never_asks_whether_a_file_exists() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let home = seed(&su, &app_pool).await;
    // Another tenant with its own people and channels; `eve` owns its channels.
    let away = seed(&su, &app_pool).await;
    let (base, watch, _archive) = start_watched_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, home.workspace, &home.alice).await;
    let bob = login(&http, &base, home.workspace, &home.bob).await;
    let outsider = login(&http, &base, home.workspace, &home.outsider).await;
    let eve = login(&http, &base, away.workspace, &away.alice).await;
    const BYTES: &[u8] = b"0123456789";
    let (ws, ch) = (home.workspace, home.channel);

    // A file the room reads (the control), and files that are refused.
    let carried = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "carried.txt",
        "text/plain",
        BYTES,
    )
    .await;
    post_with_files(&http, &base, &alice, ws, ch, "한 장", &[&carried]).await;
    let draft = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "draft.txt",
        "text/plain",
        BYTES,
    )
    .await;
    let gone = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "gone.txt",
        "text/plain",
        BYTES,
    )
    .await;
    let gone_message = post_with_files(&http, &base, &alice, ws, ch, "곧 지울 글", &[&gone]).await;
    delete_message_as(&http, &base, &alice, ws, &gone_message).await;
    let mut half_tombstones = Vec::new();
    for set_clause in ["deleted_at = now()", "state = 'deleted'"] {
        let file = upload_and_complete(
            &http,
            &base,
            &alice,
            ws,
            ch,
            "half.txt",
            "text/plain",
            BYTES,
        )
        .await;
        let message = post_with_files(&http, &base, &alice, ws, ch, "반쪽 무덤", &[&file]).await;
        sqlx::query(&format!("UPDATE message SET {set_clause} WHERE id = $1"))
            .bind(Uuid::parse_str(&message).expect("uuid"))
            .execute(&su)
            .await
            .expect("half-tombstone");
        half_tombstones.push(file);
    }
    // `pending`: a session whose bytes never came. A declared size that is NOT zero,
    // so an early `Range` read would have a real size to answer 416 with.
    let (pending, _unused_upload_url) = create_session(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "pending.txt",
        "text/plain",
        10,
    )
    .await;
    // `failed`: a finished upload the row now calls failed.
    let failed = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "failed.txt",
        "text/plain",
        BYTES,
    )
    .await;
    sqlx::query("UPDATE attachment SET status = 'failed' WHERE id = $1")
        .bind(Uuid::parse_str(&failed).expect("uuid"))
        .execute(&su)
        .await
        .expect("a failed row");
    let never_existed = Uuid::new_v4().to_string();
    watch.reset();

    struct Case {
        label: String,
        url: String,
        token: Option<String>,
    }
    let case = |label: &str, url: String, token: Option<&String>| Case {
        label: label.to_string(),
        url,
        token: token.cloned(),
    };
    let mut cases = vec![
        case(
            "another member's draft",
            content_url(&base, ws, ch, &draft),
            Some(&bob),
        ),
        case(
            "a deleted message's file, asked by a member",
            content_url(&base, ws, ch, &gone),
            Some(&bob),
        ),
        case(
            "a deleted message's file, asked by its author",
            content_url(&base, ws, ch, &gone),
            Some(&alice),
        ),
        case(
            "an id that never existed",
            content_url(&base, ws, ch, &never_existed),
            Some(&bob),
        ),
        case(
            "the right id under the wrong channel",
            content_url(&base, ws, home.other_channel, &carried),
            Some(&bob),
        ),
        case(
            "an upload still pending, asked by its uploader",
            content_url(&base, ws, ch, &pending),
            Some(&alice),
        ),
        case(
            "an upload that failed, asked by its uploader",
            content_url(&base, ws, ch, &failed),
            Some(&alice),
        ),
        case(
            "a member of no channel",
            content_url(&base, ws, ch, &carried),
            Some(&outsider),
        ),
        case(
            "another tenant's token on this tenant's path",
            content_url(&base, ws, ch, &carried),
            Some(&eve),
        ),
        case(
            "another tenant, its own workspace over this tenant's channel",
            content_url(&base, away.workspace, ch, &carried),
            Some(&eve),
        ),
        case(
            "another tenant, its own channel and this tenant's attachment id",
            content_url(&base, away.workspace, away.channel, &carried),
            Some(&eve),
        ),
        case("no credential", content_url(&base, ws, ch, &carried), None),
    ];
    for (index, file) in half_tombstones.iter().enumerate() {
        cases.push(case(
            if index == 0 {
                "a half tombstone (deleted_at only)"
            } else {
                "a half tombstone (state only)"
            },
            content_url(&base, ws, ch, file),
            Some(&bob),
        ));
    }

    for case in &cases {
        let token = case.token.as_deref();
        let plain = get(&http, &case.url, token, None).await;
        assert!(
            matches!(plain.status, 401 | 403 | 404),
            "{}: the premise is a refusal, got {}",
            case.label,
            plain.status
        );
        for range in ORACLE_RANGES {
            let ranged = get(&http, &case.url, token, Some(range)).await;
            assert_eq!(
                (ranged.status, &ranged.body),
                (plain.status, &plain.body),
                "{}: `Range: {range}` changed the answer",
                case.label
            );
            let probed = head(&http, &case.url, token, Some(range)).await;
            assert_eq!(
                probed.status, plain.status,
                "{}: HEAD with `Range: {range}` changed the status",
                case.label
            );
            assert!(probed.body.is_empty(), "{}: a HEAD has no body", case.label);
        }
        let probed = head(&http, &case.url, token, None).await;
        assert_eq!(probed.status, plain.status, "{}: HEAD", case.label);
    }
    assert_eq!(
        watch.archive_touches(),
        0,
        "not one refused read, with or without Range, reached the archive"
    );

    // The same ranges, asked of a file bob may read, are NOT all the same.
    let readable = content_url(&base, ws, ch, &carried);
    let whole = get(&http, &readable, Some(&bob), None).await;
    assert_eq!((whole.status, whole.body.as_slice()), (200, BYTES));
    let first_byte = get(&http, &readable, Some(&bob), Some("bytes=0-0")).await;
    assert_eq!(
        (first_byte.status, first_byte.body.as_slice()),
        (206, &BYTES[..1])
    );
    for unsatisfiable in ["bytes=999999-", "bytes=-0"] {
        let refused = get(&http, &readable, Some(&bob), Some(unsatisfiable)).await;
        assert_eq!(refused.status, 416, "{unsatisfiable} on a readable file");
        assert_eq!(refused.header("content-range"), Some("bytes */10"));
    }
    for ignored in ["bytes=0-1,5-6", "bytes=0-99999999999999999999999"] {
        let answer = get(&http, &readable, Some(&bob), Some(ignored)).await;
        assert_eq!(
            (answer.status, answer.body.as_slice()),
            (200, BYTES),
            "{ignored}"
        );
    }
}

// ---------------------------------------------------------------------------
// red proof — the response table
// ---------------------------------------------------------------------------

/// The ten bytes the table's file holds.
const WHOLE: &[u8] = b"0123456789";

/// One line of the table: what is sent, and the exact answer.
struct Row {
    label: &'static str,
    headers: Vec<(&'static str, &'static str)>,
    status: u16,
    content_range: Option<&'static str>,
    /// The bytes of the answer; for a 416 the JSON error body is checked instead.
    body: &'static [u8],
}

fn row(
    label: &'static str,
    headers: &[(&'static str, &'static str)],
    status: u16,
    content_range: Option<&'static str>,
    body: &'static [u8],
) -> Row {
    Row {
        label,
        headers: headers.to_vec(),
        status,
        content_range,
        body,
    }
}

/// The `(first, last)` the route must ask the archive for to answer `row`: the
/// whole file for a 200, the span `Content-Range` names for a 206, none for a 416.
fn expected_archive_range(row: &Row) -> Option<(u64, u64)> {
    match row.status {
        416 => None,
        200 => Some((0, WHOLE.len() as u64 - 1)),
        _ => {
            let span = row
                .content_range?
                .strip_prefix("bytes ")?
                .split('/')
                .next()?;
            let (first, last) = span.split_once('-')?;
            Some((first.parse().ok()?, last.parse().ok()?))
        }
    }
}

fn check_row(reply: &Reply, row: &Row, size: usize, method: &str) {
    // A 200 row's body is the whole file; the table leaves it empty.
    let what = format!("{method} {}", row.label);
    assert_eq!(reply.status, row.status, "{what}: status");
    assert_eq!(
        reply.header("accept-ranges"),
        Some("bytes"),
        "{what}: Accept-Ranges"
    );
    assert_eq!(
        reply.header("content-range"),
        row.content_range,
        "{what}: Content-Range"
    );
    if row.status == 416 {
        // A 416 carries the usual JSON error; its Content-Length is that body's.
        let length = reply
            .header("content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .expect("a Content-Length");
        assert!(length > 0, "{what}: the error body has a length");
        if method == "GET" {
            assert_eq!(
                reply.body.len(),
                length,
                "{what}: Content-Length is the body's"
            );
            assert_eq!(reply.refusal(), "requested range not satisfiable", "{what}");
        }
        return;
    }
    let expected_body: &[u8] = if row.status == 200 {
        &WHOLE[..size]
    } else {
        row.body
    };
    assert_eq!(
        reply.header("content-length"),
        Some(expected_body.len().to_string().as_str()),
        "{what}: Content-Length"
    );
    if method == "GET" {
        assert_eq!(reply.body.as_slice(), expected_body, "{what}: the bytes");
    } else {
        assert!(reply.body.is_empty(), "{what}: a HEAD has no body");
    }
}

/// **Red proof (D3 응답표).** Every line of the table — status, `Content-Range`,
/// `Content-Length`, `Accept-Ranges` and the bytes — over real HTTP for a
/// ten-byte file, and the empty file. The edges are in it: `a-`, `-n`, `n` at and
/// past the size, `b` past the end, the first and the last byte, a start at the
/// size, `-0`, a list, another unit, a syntax error, an inverted span, numbers at
/// and past what a `u64` holds, `If-Range`, a second `Range` header.
///
/// The archive counter is checked too: a 206 pulls **exactly** the range's bytes
/// out of the archive (not the file and a slice of it), and a 416 reads nothing.
/// Break one line of the grammar or the arithmetic and that row goes red.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_range_table() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (base, watch, _archive) = start_watched_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;
    const BYTES: &[u8] = b"0123456789";
    let (ws, ch) = (fixture.workspace, fixture.channel);

    let file =
        upload_and_complete(&http, &base, &alice, ws, ch, "ten.txt", "text/plain", BYTES).await;
    post_with_files(&http, &base, &alice, ws, ch, "열 바이트", &[&file]).await;
    let url = content_url(&base, ws, ch, &file);

    let rows = vec![
        row("no Range", &[], 200, None, &[]),
        row(
            "the first byte",
            &[("range", "bytes=0-0")],
            206,
            Some("bytes 0-0/10"),
            &BYTES[..1],
        ),
        row(
            "a prefix",
            &[("range", "bytes=0-4")],
            206,
            Some("bytes 0-4/10"),
            &BYTES[..5],
        ),
        row(
            "the whole file as a range",
            &[("range", "bytes=0-9")],
            206,
            Some("bytes 0-9/10"),
            BYTES,
        ),
        row(
            "open-ended",
            &[("range", "bytes=5-")],
            206,
            Some("bytes 5-9/10"),
            &BYTES[5..],
        ),
        row(
            "a suffix",
            &[("range", "bytes=-3")],
            206,
            Some("bytes 7-9/10"),
            &BYTES[7..],
        ),
        row(
            "a suffix as long as the file",
            &[("range", "bytes=-10")],
            206,
            Some("bytes 0-9/10"),
            BYTES,
        ),
        row(
            "a suffix longer than the file",
            &[("range", "bytes=-11")],
            206,
            Some("bytes 0-9/10"),
            BYTES,
        ),
        row(
            "an end past the file",
            &[("range", "bytes=5-99")],
            206,
            Some("bytes 5-9/10"),
            &BYTES[5..],
        ),
        row(
            "the last byte",
            &[("range", "bytes=9-9")],
            206,
            Some("bytes 9-9/10"),
            &BYTES[9..],
        ),
        row(
            "the unit in capitals",
            &[("range", "BYTES=2-3")],
            206,
            Some("bytes 2-3/10"),
            &BYTES[2..4],
        ),
        row(
            "a start at the size",
            &[("range", "bytes=10-")],
            416,
            Some("bytes */10"),
            &[],
        ),
        row(
            "a start and an end past the file",
            &[("range", "bytes=10-12")],
            416,
            Some("bytes */10"),
            &[],
        ),
        row(
            "a zero-length suffix",
            &[("range", "bytes=-0")],
            416,
            Some("bytes */10"),
            &[],
        ),
        row(
            "the largest u64 as a start",
            &[("range", "bytes=18446744073709551615-")],
            416,
            Some("bytes */10"),
            &[],
        ),
        row(
            "a list of ranges",
            &[("range", "bytes=0-1,5-6")],
            200,
            None,
            &[],
        ),
        row("another unit", &[("range", "items=0-1")], 200, None, &[]),
        row("not a range", &[("range", "bytes=abc")], 200, None, &[]),
        row(
            "an inverted span",
            &[("range", "bytes=5-2")],
            200,
            None,
            &[],
        ),
        row(
            "a number far past u64",
            &[("range", "bytes=0-99999999999999999999999")],
            200,
            None,
            &[],
        ),
        row(
            "u64::MAX + 1 as a start",
            &[("range", "bytes=18446744073709551616-")],
            200,
            None,
            &[],
        ),
        row(
            "If-Range with a valid Range",
            &[("range", "bytes=0-1"), ("if-range", "\"x\"")],
            200,
            None,
            &[],
        ),
        row(
            "two Range headers",
            &[("range", "bytes=0-1"), ("range", "bytes=2-3")],
            200,
            None,
            &[],
        ),
    ];
    watch.reset();
    let mut expected_reads = 0usize;
    let mut expected_bytes = 0u64;
    for row in &rows {
        let answer = ask(&http, reqwest::Method::GET, &url, Some(&bob), &row.headers).await;
        check_row(&answer, row, BYTES.len(), "GET");
        // What reached the archive is the one range the route resolved — never the
        // client's text, and for a 416 or an ignored list nothing wider than the
        // file. A 416 reaches it not at all.
        assert_eq!(
            watch.take_ranges(),
            expected_archive_range(row).into_iter().collect::<Vec<_>>(),
            "GET {}: the range that reached the archive",
            row.label
        );
        if row.status != 416 {
            expected_reads += 1;
            expected_bytes += if row.status == 200 {
                BYTES.len()
            } else {
                row.body.len()
            } as u64;
        }
        let probed = ask(&http, reqwest::Method::HEAD, &url, Some(&bob), &row.headers).await;
        check_row(&probed, row, BYTES.len(), "HEAD");
        assert!(
            watch.take_ranges().is_empty(),
            "HEAD {}: a HEAD asks the archive for no range",
            row.label
        );
    }
    assert_eq!(
        watch.range_reads(),
        expected_reads,
        "one archive read per answer that has bytes — none for a 416, none for a HEAD"
    );
    assert_eq!(
        watch.bytes_pulled(),
        expected_bytes,
        "the archive was asked for exactly the bytes that were sent"
    );
    assert_eq!(
        watch.content_reads.load(Ordering::SeqCst),
        0,
        "no whole-object read"
    );

    // The empty file: nothing to range over, nothing to ask the archive.
    let empty =
        upload_and_complete(&http, &base, &alice, ws, ch, "empty.txt", "text/plain", b"").await;
    post_with_files(&http, &base, &alice, ws, ch, "빈 파일", &[&empty]).await;
    let empty_url = content_url(&base, ws, ch, &empty);
    watch.reset();
    for range in [
        None,
        Some("bytes=0-0"),
        Some("bytes=5-"),
        Some("bytes=-1"),
        Some("bytes=0-"),
    ] {
        for method in [reqwest::Method::GET, reqwest::Method::HEAD] {
            let extra: Vec<(&str, &str)> =
                range.map(|range| ("range", range)).into_iter().collect();
            let answer = ask(&http, method.clone(), &empty_url, Some(&bob), &extra).await;
            assert_eq!(
                answer.status, 200,
                "{method} {range:?}: an empty file ignores Range"
            );
            assert_eq!(answer.header("content-length"), Some("0"));
            assert_eq!(answer.header("content-range"), None);
            assert_eq!(answer.header("accept-ranges"), Some("bytes"));
            assert!(answer.body.is_empty());
        }
    }
    assert_eq!(
        watch.archive_touches(),
        0,
        "an empty file asks the archive nothing"
    );
}

// ---------------------------------------------------------------------------
// red proof — HEAD opens nothing; the headers say what the row says
// ---------------------------------------------------------------------------

/// **Red proof (D3 HEAD).** A `HEAD` reads **no byte** of the archive — not one
/// call, not one byte — and its size and mime are the database row's.
///
/// The row's mime is changed after the upload to something the archive has never
/// heard of, and the headers follow the row. Let `HEAD` open the body stream (the
/// way axum's own HEAD-through-GET fallback would) and the counters move.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn head_reads_no_byte_of_the_archive() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (base, watch, _archive) = start_watched_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;
    const BYTES: &[u8] = b"0123456789";
    let (ws, ch) = (fixture.workspace, fixture.channel);

    let file =
        upload_and_complete(&http, &base, &alice, ws, ch, "ten.txt", "text/plain", BYTES).await;
    post_with_files(&http, &base, &alice, ws, ch, "열 바이트", &[&file]).await;
    sqlx::query("UPDATE attachment SET mime = 'application/x-from-the-row' WHERE id = $1")
        .bind(Uuid::parse_str(&file).expect("uuid"))
        .execute(&su)
        .await
        .expect("the row's mime");
    let url = content_url(&base, ws, ch, &file);
    watch.reset();

    for (range, status, length, content_range) in [
        (None, 200, "10", None),
        (Some("bytes=2-4"), 206, "3", Some("bytes 2-4/10")),
        (Some("bytes=-1"), 206, "1", Some("bytes 9-9/10")),
        (Some("bytes=99-"), 416, "", Some("bytes */10")),
        (Some("bytes=0-1,5-6"), 200, "10", None),
    ] {
        let probed = head(&http, &url, Some(&bob), range).await;
        assert_eq!(probed.status, status, "HEAD {range:?}");
        assert!(probed.body.is_empty(), "HEAD {range:?}: no body");
        assert_eq!(
            probed.header("content-range"),
            content_range,
            "HEAD {range:?}"
        );
        if status != 416 {
            assert_eq!(
                probed.header("content-length"),
                Some(length),
                "HEAD {range:?}"
            );
            assert_eq!(
                probed.header("content-type"),
                Some("application/x-from-the-row"),
                "HEAD {range:?}: the mime is the row's, not the archive's"
            );
        }
    }
    assert_eq!(watch.archive_touches(), 0, "a HEAD never calls the archive");
    assert_eq!(watch.bytes_pulled(), 0, "a HEAD never pulls a byte");

    // The control: the same file, as a GET, does reach the archive — and its
    // headers are the row's too.
    let whole = get(&http, &url, Some(&bob), None).await;
    assert_eq!((whole.status, whole.body.as_slice()), (200, BYTES));
    assert_eq!(
        whole.header("content-type"),
        Some("application/x-from-the-row")
    );
    assert_eq!(watch.range_reads(), 1, "a GET is one archive read");
    assert_eq!(watch.bytes_pulled(), 10);
}

// ---------------------------------------------------------------------------
// red proof — the headers
// ---------------------------------------------------------------------------

/// **Red proof (D3 헤더).** `200`, `206`, `416` and `HEAD` — all of them — carry
/// `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`,
/// `Cache-Control: private, no-store, no-transform` and `Accept-Ranges: bytes`.
/// A 206 is a download like any other (the claim `docs/security/claims.yaml`
/// ATT-1 makes about these bytes). Content-Type is the row's mime, except on a 416
/// where it is the JSON error's. Nothing redirects, and the methods that are not
/// `GET` or `HEAD` are 405.
///
/// Take `attachment` off the 206 and that row goes red.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn content_responses_keep_the_headers() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (base, _watch, _archive) = start_watched_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;
    const BYTES: &[u8] = b"<html><script>alert(1)</script></html>";
    let (ws, ch) = (fixture.workspace, fixture.channel);

    let file = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "page.html",
        "text/html",
        BYTES,
    )
    .await;
    post_with_files(&http, &base, &alice, ws, ch, "위험한 이름의 파일", &[&file]).await;
    let url = content_url(&base, ws, ch, &file);

    for (method, range, status) in [
        (reqwest::Method::GET, None, 200),
        (reqwest::Method::GET, Some("bytes=0-5"), 206),
        (reqwest::Method::GET, Some("bytes=99999-"), 416),
        (reqwest::Method::HEAD, None, 200),
        (reqwest::Method::HEAD, Some("bytes=0-5"), 206),
        (reqwest::Method::HEAD, Some("bytes=99999-"), 416),
    ] {
        let extra: Vec<(&str, &str)> = range.map(|range| ("range", range)).into_iter().collect();
        let answer = ask(&http, method.clone(), &url, Some(&bob), &extra).await;
        let what = format!("{method} {range:?}");
        assert_eq!(answer.status, status, "{what}");
        assert_eq!(
            answer.header("content-disposition"),
            Some("attachment"),
            "{what}"
        );
        assert_eq!(
            answer.header("x-content-type-options"),
            Some("nosniff"),
            "{what}"
        );
        assert_eq!(
            answer.header("cache-control"),
            Some("private, no-store, no-transform"),
            "{what}"
        );
        assert_eq!(answer.header("accept-ranges"), Some("bytes"), "{what}");
        assert_eq!(answer.header("location"), None, "{what}: nothing redirects");
        assert_eq!(
            answer.header("content-type"),
            Some(if status == 416 {
                "application/json"
            } else {
                "text/html"
            }),
            "{what}: the row's mime, or the error's JSON"
        );
    }

    // The methods that are not GET or HEAD are refused by the route's table.
    for method in [
        reqwest::Method::POST,
        reqwest::Method::PUT,
        reqwest::Method::DELETE,
        reqwest::Method::PATCH,
    ] {
        let answer = ask(&http, method.clone(), &url, Some(&bob), &[]).await;
        assert_eq!(answer.status, 405, "{method}");
        let allow = answer.header("allow").unwrap_or_default().to_string();
        assert!(
            allow.contains("GET") && allow.contains("HEAD"),
            "{method}: Allow: {allow}"
        );
    }
}

// ---------------------------------------------------------------------------
// red proof — the archive may not contradict the row
// ---------------------------------------------------------------------------

/// **Red proof (D3 헤더, 총 길이).** The headers are built from the row, so an
/// archive that reports another total than the row's is refused with a 502
/// **before a byte is sent** — for a whole read and for a range alike — and the
/// refusal says nothing about the archive. A `HEAD` opens nothing and therefore
/// stays 200 (a known residual: it cannot see the disagreement). An object the
/// archive no longer has is its 404.
///
/// Delete the comparison and the skewed archive is served under a
/// `Content-Length` it does not match.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn an_archive_that_disagrees_with_the_row_is_refused_before_any_byte() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (base, watch, archive) = start_watched_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;
    const BYTES: &[u8] = b"0123456789";
    let (ws, ch) = (fixture.workspace, fixture.channel);

    let file =
        upload_and_complete(&http, &base, &alice, ws, ch, "ten.txt", "text/plain", BYTES).await;
    post_with_files(&http, &base, &alice, ws, ch, "열 바이트", &[&file]).await;
    let url = content_url(&base, ws, ch, &file);

    for skew in [1i64, -1] {
        watch.total_skew.store(skew, Ordering::SeqCst);
        for range in [None, Some("bytes=2-4")] {
            let refused = get(&http, &url, Some(&bob), range).await;
            assert_eq!(refused.status, 502, "skew {skew}, {range:?}");
            assert!(refused.header("content-range").is_none());
            // ADR-0151 증보 7: the 502 names itself and says when to come back, read off the
            // response the real router sent (after every layer), not off the error value.
            assert_eq!(
                refused.refusal_code().as_deref(),
                Some("drive_upstream_failed"),
                "skew {skew}, {range:?}"
            );
            assert_eq!(
                refused.header("retry-after"),
                Some("5"),
                "skew {skew}, {range:?}"
            );
            let message = refused.refusal();
            assert!(
                !message.contains("stub") && !message.contains("local-") && !message.is_empty(),
                "the refusal names no archive detail: {message:?}"
            );
        }
        let probed = head(&http, &url, Some(&bob), None).await;
        assert_eq!(probed.status, 200, "a HEAD cannot see the disagreement");
    }
    watch.total_skew.store(0, Ordering::SeqCst);
    let honest = get(&http, &url, Some(&bob), Some("bytes=2-4")).await;
    assert_eq!((honest.status, honest.body.as_slice()), (206, &BYTES[2..5]));

    // An object the archive no longer holds is its own 404, not a 5xx.
    let drive_file_id: String =
        sqlx::query_scalar("SELECT drive_file_id FROM attachment WHERE id = $1")
            .bind(Uuid::parse_str(&file).expect("uuid"))
            .fetch_one(&su)
            .await
            .expect("drive_file_id");
    archive
        .delete_file(&drive_file_id)
        .await
        .expect("delete from the archive");
    let missing = get(&http, &url, Some(&bob), None).await;
    assert_eq!(missing.status, 404);
}

// ---------------------------------------------------------------------------
// the real local volume behind the real route
// ---------------------------------------------------------------------------

/// **Red proof (D3 백엔드, 로컬).** The local volume serves ranges through the real
/// route: every range of a file that spans several read chunks — across the
/// 256 KiB chunk edge, from the middle, the suffix, the last byte, the whole file —
/// comes back as exactly those bytes with the right `Content-Range` and
/// `Content-Length`; a `HEAD` says the same without a body.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_local_archive_serves_ranges_through_the_real_route() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let dir = std::env::temp_dir().join(format!(
        "oort-drive-range-pg-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("temp archive");
    let dir_str = dir.to_string_lossy().into_owned();
    let (base, _archive) = start_server_with(app_pool.clone(), move |base| {
        Arc::new(LocalDriveArchive::open(Some(dir_str.as_str()), &base).expect("local archive"))
    })
    .await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;
    let (ws, ch) = (fixture.workspace, fixture.channel);

    const LEN: usize = 700_000;
    let bytes: Vec<u8> = (0..LEN).map(|index| (index % 251) as u8).collect();
    let file = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "big.bin",
        "application/octet-stream",
        &bytes,
    )
    .await;
    post_with_files(&http, &base, &alice, ws, ch, "큰 파일", &[&file]).await;
    let url = content_url(&base, ws, ch, &file);

    let last = LEN - 1;
    for (header, start, end) in [
        ("bytes=0-0", 0, 0),
        ("bytes=262143-262144", 262_143, 262_144),
        ("bytes=100000-500000", 100_000, 500_000),
        ("bytes=300000-", 300_000, last),
        ("bytes=-1000", LEN - 1000, last),
        ("bytes=699999-699999", last, last),
        ("bytes=0-699999", 0, last),
    ] {
        let answer = get(&http, &url, Some(&bob), Some(header)).await;
        assert_eq!(answer.status, 206, "{header}");
        let expected_range = format!("bytes {start}-{end}/{LEN}");
        assert_eq!(
            answer.header("content-range"),
            Some(expected_range.as_str()),
            "{header}"
        );
        assert_eq!(
            answer.header("content-length"),
            Some((end - start + 1).to_string().as_str()),
            "{header}"
        );
        assert_eq!(
            answer.body,
            &bytes[start..=end],
            "{header}: exactly those bytes"
        );
        let probed = head(&http, &url, Some(&bob), Some(header)).await;
        assert_eq!(probed.status, 206, "HEAD {header}");
        assert_eq!(
            probed.header("content-range"),
            Some(expected_range.as_str())
        );
        assert!(probed.body.is_empty());
    }
    let whole = get(&http, &url, Some(&bob), None).await;
    assert_eq!(whole.status, 200);
    assert_eq!(whole.body, bytes, "the whole file, byte for byte");
    let past = get(&http, &url, Some(&bob), Some("bytes=700000-")).await;
    assert_eq!(past.status, 416);
    assert_eq!(past.header("content-range"), Some("bytes */700000"));
    let _ = std::fs::remove_dir_all(&dir);
}
