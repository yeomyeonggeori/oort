//! #5371 — `PUT /v1/agent-media/{ws}/{token}` and the worker that calls it, over real TCP, a real
//! PG18, the real isolated decoder child and a real local archive (ADR-0151 증보 8: WA2~WA17, WA19,
//! WA22, WA24).
//!
//! ```text
//! cargo build -p momo-expressions --bins            # the decoder child sits next to the test exe
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:PORT/DB \
//!   cargo test -p momo-server --test agent_picture_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! The server runs as `momo_app` (not a superuser, no BYPASSRLS); the fixture is seeded as the
//! superuser; tokens are minted — and forged — as `momo_worker`, the role the agent-worker runs as.
//! The archive is a real [`LocalDriveArchive`] in a temp directory, wrapped so a test can make
//! `put_object` fail, report `Unavailable`, or end the run / archive the channel / collide with the
//! row **after the object exists** (the deterministic "the run ends while the picture is decoded").
//!
//! The decoder slots, the decoder counters and the write slots are process-wide, so **every test holds
//! one global async mutex for its whole length** and reads counter *deltas*.
//!
//! What each test measures is a real value (bytes read back from the archive, rows, counters, status
//! and body), and the production line whose removal turns it red is named here:
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_picture_is_written_as_the_runs_agent_…` | take channel/uploader/name/mime from the request instead of the run (`agent_picture::write_picture_in_tx` binds `binding.channel_id`, `target.agent_member_id`, `picture.name`) |
//! | `the_stored_bytes_are_the_decoders_output_…` | store `bytes` instead of `prepared.data` (`agent_media::land`, `put_object(…)`) |
//! | `one_token_is_one_picture_…` | drop `t.used_at IS NULL` from `agent_picture::redeem_in_tx` |
//! | `every_refusal_that_depends_on_the_token_is_the_same_404` | drop `t.slot <= $3`, the run-state EXISTS, the binding re-check or the `workspace_id` bind in `redeem_in_tx`; or answer a refusal with anything but `refused()` |
//! | `a_bad_token_is_answered_before_its_body_…` | move the spend above the `Content-Length` checks (`agent_media::write`, steps 3–5) |
//! | `the_declared_length_is_the_input_…` | drop `bytes.len() == declared` / the `to_bytes` limit / the body deadline in `land` |
//! | `only_pictures_the_decoder_accepts_are_stored_…` | delete the `SNIFFED` match in `land` (a one-frame GIF becomes a 201) |
//! | `bombs_are_refused_by_the_child_…` | call an in-process decoder (`in_process_codec_starts` moves) or skip the child (`decoder_children_started` stays 0) |
//! | `a_busy_decoder_is_waited_for_…` | `prepare_photo_waiting` → `try_acquire` / no `Place` limit (`media.rs permit_waiting`) |
//! | `the_write_slot_gate_…` | take the slot after the spend / drop `try_acquire_owned` |
//! | `a_failing_archive_…` | collapse the `DriveError::Unavailable` / `_` arms; drop `discard(…)`; drop the third binding in `write_picture_in_tx` |
//! | `the_daily_ceiling_…` | drop the `today >= daily_ceiling` check or its predicates |
//! | `the_refusal_budget_…` | mount `per_ip_agent_media` on the read key / spend on 411, 413, 503, 422, 201 |
//! | `no_token_path_byte_or_content_type_…` | log or store the token / path / input bytes / `Content-Type` anywhere |
//! | `the_worker_writes_…` | drop `AttachmentPolicy::Project`, the savepoint rollback, or `run_picture_ids_in_tx` |
//! | `the_worker_refuses_…` | drop the pre-checks before `mint`, `Policy::none()`, or add a retry |
//! | `a_caller_that_hangs_up_…` | run `land` inline instead of `tokio::spawn(land(…))` |

use std::collections::{BTreeSet, HashMap};
use std::io::Cursor;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::extract::{Request, State};
use axum::middleware::{from_fn_with_state, Next};
use axum::response::Response;
use base64::Engine as _;
use futures::future::BoxFuture;
use futures::StreamExt;
use momo_agent_worker::agent_picture::{
    send_answer_with_run_pictures_in_tx, PictureRefusal, PictureWriter, WrittenPicture,
    PICTURE_UPLOAD_FAILED_SENTENCE,
};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_drive::{
    DriveArchive, DriveContent, DriveError, DriveFile, DriveUploadSession, LocalDriveArchive,
    UnavailableDriveArchive, UploadBody, MAX_ATTACHMENT_BYTES,
};
use momo_expressions::media;
use momo_messaging::{
    link_attachments_in_tx, mint_agent_picture_in_tx, mint_agent_picture_with_ttl_in_tx,
    token_hash, AgentPictureGrant, AttachmentLinkRejected, MessageType, NewMessage,
    AGENT_MEDIA_TTL_SECS, AGENT_PICTURES_PER_RUN, AGENT_PICTURE_MAX_INPUT_BYTES,
    SELF_MEDIA_INTERNAL_TTL_SECS, SELF_MEDIA_MAX_BYTES,
};
use momo_server::config::RateLimitConfig;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const FIVE_MIB: usize = 5 * 1024 * 1024;
/// Markers planted in the pictures that go in: none of them may be in what comes out, in a row or in a
/// log line. Each is unique to this test binary.
const CAMERA: &str = "OORT-MARKER-CAMERA-5371";
const GPS_NOTE: &str = "OORT-MARKER-GPS-5371";
const COMMENT: &str = "OORT-MARKER-COMMENT-5371";
const TRAILER: &str = "OORT-MARKER-TRAILER-5371";
const TEXT_CHUNK: &str = "OORT-MARKER-TEXT-5371";
const MARKERS: [&str; 5] = [CAMERA, GPS_NOTE, COMMENT, TRAILER, TEXT_CHUNK];
/// The request metadata a hostile caller sends: the route reads none of it.
const HOSTILE: &str = "OORT-HOSTILE-CT-5371";
const HOSTILE_NAME: &str = "OORT-HOSTILE-NAME-5371.html";
/// What every raw request names as its address (`x-forwarded-for`), as the brief asks.
const RAW_IP: &str = "203.0.113.7";

// --- harness ------------------------------------------------------------------

/// One global gate: the decoder slots, the decoder counters and the write slots are process-wide.
static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn begin() -> (tokio::sync::MutexGuard<'static, ()>, Capture) {
    let gate = GATE.lock().await;
    (gate, capture_logs())
}

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a disposable PG18 superuser DB")
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
    panic!("psql client not found");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
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
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

/// The sibling decoder child must exist next to the test executable (no env var is ever set here).
fn require_decoder() {
    if std::env::var_os("OORT_EXPRESSION_DECODER").is_some() {
        return;
    }
    let exe = std::env::current_exe().expect("test executable");
    let mut dir = exe.parent().expect("target dir").to_path_buf();
    if dir.file_name() == Some(std::ffi::OsStr::new("deps")) {
        dir.pop();
    }
    let path = dir.join("momo-expression-decoder");
    assert!(
        path.is_file(),
        "build the decoder first: cargo build -p momo-expressions --bins ({path:?}); without it \
         every picture is invalid media"
    );
}

async fn pool_as(role: &str, password_env: &str, fallback: &str, max: u32) -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let password = std::env::var(password_env).unwrap_or_else(|_| fallback.to_string());
    PgPoolOptions::new()
        .max_connections(max)
        .connect_with(options.username(role).password(&password))
        .await
        .unwrap_or_else(|error| panic!("connect as {role}: {error}"))
}

/// Everything `tracing` (and, through `tracing-log`, the `log` records of reqwest and hyper) says in
/// this test binary, at TRACE. One global subscriber; every needle a test looks for is a random token
/// or a string unique to this file.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for CaptureWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = CaptureWriter;
    fn make_writer(&'a self) -> CaptureWriter {
        CaptureWriter(self.0.clone())
    }
}

impl Capture {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

fn capture_logs() -> Capture {
    static CAPTURE: OnceLock<Capture> = OnceLock::new();
    CAPTURE
        .get_or_init(|| {
            let capture = Capture::default();
            tracing_subscriber::fmt()
                .with_max_level(tracing::Level::TRACE)
                .with_ansi(false)
                .with_writer(capture.clone())
                .try_init()
                .expect("one global subscriber per test binary");
            capture
        })
        .clone()
}

/// Both decoder slots, held for as long as this value lives. A panic drops it, so a failing test
/// cannot leave every later test facing a busy decoder.
struct HeldSlots(#[allow(dead_code)] tokio::sync::OwnedSemaphorePermit);

async fn hold_decoder_slots() -> HeldSlots {
    HeldSlots(
        media::decoder_slots()
            .acquire_many_owned(2)
            .await
            .expect("the decoder slots"),
    )
}

/// The parent's own counters (`decoder_children_started`, `in_process_codec_starts`), as a mark to
/// read a delta from.
#[derive(Clone, Copy)]
struct Marks {
    children: u64,
    in_process: u64,
}

impl Marks {
    fn now() -> Marks {
        Marks {
            children: media::decoder_children_started(),
            in_process: media::in_process_codec_starts(),
        }
    }
    fn children(&self) -> u64 {
        media::decoder_children_started() - self.children
    }
    fn in_process(&self) -> u64 {
        media::in_process_codec_starts() - self.in_process
    }
}

// --- the archive --------------------------------------------------------------

/// A hook that runs after `put_object` stored the object and before it returns, with the stored id.
type Hook = Arc<dyn Fn(String) -> BoxFuture<'static, ()> + Send + Sync>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum PutMode {
    Real,
    /// `put_object` answers an upstream failure without storing anything.
    Fails,
    /// `put_object` answers `Unavailable` without storing anything.
    Unavailable,
}

struct ArchiveDir(PathBuf);

impl ArchiveDir {
    fn new() -> ArchiveDir {
        let dir = std::env::temp_dir().join(format!("oort-agent-picture-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp archive");
        ArchiveDir(dir)
    }
}

impl Drop for ArchiveDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A real [`LocalDriveArchive`] that forwards everything, records every `delete_file`, and lets a test
/// fail `put_object` or run something once the object exists.
struct Files {
    inner: LocalDriveArchive,
    root: PathBuf,
    mode: Mutex<PutMode>,
    after_put: Mutex<Option<Hook>>,
    deleted: Mutex<Vec<String>>,
    puts: AtomicUsize,
}

impl std::fmt::Debug for Files {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Files").finish_non_exhaustive()
    }
}

impl Files {
    fn open(dir: &ArchiveDir) -> Files {
        let inner =
            LocalDriveArchive::open(dir.0.to_str(), "http://127.0.0.1:9").expect("a local archive");
        Files {
            inner,
            root: dir.0.clone(),
            mode: Mutex::new(PutMode::Real),
            after_put: Mutex::new(None),
            deleted: Mutex::new(Vec::new()),
            puts: AtomicUsize::new(0),
        }
    }

    fn set_mode(&self, mode: PutMode) {
        *self.mode.lock().unwrap() = mode;
    }

    fn set_after_put(&self, hook: Option<Hook>) {
        *self.after_put.lock().unwrap() = hook;
    }

    /// The ids of the objects the archive holds right now.
    fn objects(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.root.join("objects"))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .filter(|name| !name.ends_with(".meta") && !name.ends_with(".tmp"))
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn deleted(&self) -> Vec<String> {
        self.deleted.lock().unwrap().clone()
    }

    fn puts(&self) -> usize {
        self.puts.load(Ordering::SeqCst)
    }

    /// The bytes the archive actually holds for `id` — what a reader would be served.
    async fn read(&self, id: &str) -> Vec<u8> {
        let mut content = self
            .inner
            .file_content(id, MAX_ATTACHMENT_BYTES)
            .await
            .expect("the stored object");
        let mut bytes = Vec::new();
        while let Some(chunk) = content.body.next().await {
            bytes.extend_from_slice(&chunk.expect("a chunk"));
        }
        bytes
    }
}

#[async_trait]
impl DriveArchive for Files {
    fn backend_kind(&self) -> &'static str {
        self.inner.backend_kind()
    }

    fn accepts_stub_uploads(&self) -> bool {
        self.inner.accepts_stub_uploads()
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
        self.inner.file_metadata(file_id).await
    }

    async fn file_content(
        &self,
        file_id: &str,
        max_bytes: i64,
    ) -> Result<DriveContent, DriveError> {
        self.inner.file_content(file_id, max_bytes).await
    }

    async fn delete_file(&self, file_id: &str) -> Result<(), DriveError> {
        self.deleted.lock().unwrap().push(file_id.to_string());
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

    async fn put_object(
        &self,
        channel_id: Uuid,
        name: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> Result<DriveFile, DriveError> {
        self.puts.fetch_add(1, Ordering::SeqCst);
        let mode = *self.mode.lock().unwrap();
        match mode {
            PutMode::Fails => return Err(DriveError::UpstreamFailure),
            PutMode::Unavailable => return Err(DriveError::Unavailable),
            PutMode::Real => {}
        }
        let file = self.inner.put_object(channel_id, name, mime, bytes).await?;
        let hook = self.after_put.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook(file.drive_file_id.clone()).await;
        }
        Ok(file)
    }
}

/// A hook that runs one statement as the superuser with the given ids bound, once an object exists.
fn sql_hook(su: &PgPool, sql: &'static str, ids: Vec<Uuid>) -> Hook {
    let su = su.clone();
    Arc::new(move |_stored| {
        let su = su.clone();
        let ids = ids.clone();
        Box::pin(async move {
            let mut query = sqlx::query(sql);
            for id in &ids {
                query = query.bind(*id);
            }
            query.execute(&su).await.expect("the hook's statement");
        })
    })
}

// --- the server ---------------------------------------------------------------

async fn record(
    State(seen): State<Arc<Mutex<Vec<String>>>>,
    request: Request,
    next: Next,
) -> Response {
    seen.lock()
        .unwrap()
        .push(format!("{} {}", request.method(), request.uri().path()));
    next.run(request).await
}

struct World {
    base: String,
    addr: SocketAddr,
    su: PgPool,
    /// What the api runs as (`momo_app`): not a superuser, no BYPASSRLS.
    app: PgPool,
    /// What the agent-worker runs as (BYPASSRLS): it mints, and a test forges with it.
    worker: PgPool,
    files: Arc<Files>,
    /// The api's write slots (`AppState::agent_media_slots`): a test holds permits to fill them.
    slots: Arc<tokio::sync::Semaphore>,
    /// `METHOD path` of every request the router saw, in order.
    seen: Arc<Mutex<Vec<String>>>,
    /// Every `(workspace, token)` a test minted: the leak scan's needles.
    minted: Mutex<Vec<(Uuid, String)>>,
    /// Every workspace a test seeded: the leak scan's tables.
    spaces: Mutex<Vec<Uuid>>,
    _dir: ArchiveDir,
}

async fn boot() -> World {
    boot_with(|state| state).await
}

async fn boot_with(tune: impl FnOnce(AppState) -> AppState) -> World {
    require_decoder();
    ensure_schema_and_roles();
    let su = PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("superuser pool");
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw", 8).await;
    let worker = pool_as(
        "momo_worker",
        "MOMO_WORKER_PASSWORD",
        "momo_worker_dev_pw",
        4,
    )
    .await;
    let dir = ArchiveDir::new();
    let files = Arc::new(Files::open(&dir));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().unwrap();
    let state = tune(
        AppState::new(
            app.clone(),
            "agent-picture-conformance-signing-secret".to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        )
        .with_drive(files.clone()),
    );
    let slots = state.agent_media_slots.clone();
    let router = build_app(state).layer(from_fn_with_state(seen.clone(), record));
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    World {
        base: format!("http://{addr}"),
        addr,
        su,
        app,
        worker,
        files,
        slots,
        seen,
        minted: Mutex::new(Vec::new()),
        spaces: Mutex::new(Vec::new()),
        _dir: dir,
    }
}

impl World {
    fn requests(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }

    /// The tokens the **worker** minted for itself are only known from the paths the router saw: add the
    /// ones whose hash is in the token table to the minted list (a made-up token a test sent is not).
    async fn adopt_requested_tokens(&self) {
        for request in self.requests() {
            let Some((_, tail)) = request.split_once("/v1/agent-media/") else {
                continue;
            };
            let mut parts = tail.split('/');
            let (Some(ws), Some(token)) = (
                parts.next().and_then(|ws| ws.parse::<Uuid>().ok()),
                parts.next(),
            ) else {
                continue;
            };
            let known: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM attachment_write_token WHERE workspace_id = $1 AND token_hash = $2",
            )
            .bind(ws)
            .bind(token_hash(token).to_vec())
            .fetch_one(&self.su)
            .await
            .unwrap();
            let mut minted = self.minted.lock().unwrap();
            if known == 1 && !minted.iter().any(|(_, have)| have == token) {
                minted.push((ws, token.to_string()));
            }
        }
    }

    /// No durable row and no log line holds any token a test minted, the tokens the worker minted for
    /// itself (read off the paths the router saw), the `agent-media/` path, or any of `extra`; the token
    /// table holds each token's SHA-256 and nothing else. Not vacuous: the scan insists it saw rows and a
    /// live capture of the database's own statements.
    async fn assert_no_leak(&self, extra: &[&str], logs: &Capture) {
        let minted = self.minted.lock().unwrap().clone();
        let spaces = self.spaces.lock().unwrap().clone();
        let mut needles: Vec<String> = minted.iter().map(|(_, token)| token.clone()).collect();
        for request in self.requests() {
            if let Some((_, tail)) = request.split_once("/v1/agent-media/") {
                if let Some(token) = tail.rsplit('/').next().filter(|token| token.len() == 43) {
                    needles.push(token.to_string());
                }
            }
        }
        needles.extend(extra.iter().map(|needle| (*needle).to_string()));
        needles.push("agent-media/".to_string());

        let mut scanned = 0;
        for ws in &spaces {
            for table in [
                "audit_log",
                "outbox",
                "agent_run",
                "message",
                "attachment",
                "attachment_write_token",
            ] {
                let rows: Vec<String> = sqlx::query_scalar(&format!(
                    "SELECT to_jsonb(t)::text FROM {table} t WHERE workspace_id = $1"
                ))
                .bind(ws)
                .fetch_all(&self.su)
                .await
                .unwrap();
                scanned += rows.len();
                for row in &rows {
                    for needle in &needles {
                        assert!(
                            !row.contains(needle.as_str()),
                            "{table} holds `{needle}`: {row}"
                        );
                    }
                }
            }
        }
        assert!(scanned >= 3, "the scan looked at {scanned} rows");
        // the token table keeps the SHA-256 of what was minted, and only that
        for (ws, token) in &minted {
            let hashed: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM attachment_write_token WHERE workspace_id = $1 AND token_hash = $2",
            )
            .bind(ws)
            .bind(token_hash(token).to_vec())
            .fetch_one(&self.su)
            .await
            .unwrap();
            assert_eq!(
                hashed, 1,
                "the table holds the hash of a minted token, once"
            );
        }
        let text = logs.text();
        assert!(
            text.len() > 1000 && text.contains("sqlx::query"),
            "the capture is live and carries the database's own statements ({} bytes)",
            text.len()
        );
        for needle in &needles {
            assert!(
                !text.contains(needle.as_str()),
                "a log line holds `{needle}`"
            );
        }
    }
}

// --- the fixture --------------------------------------------------------------

#[derive(Clone)]
struct Tenant {
    ws: Uuid,
    alice: Uuid,
    agent: Uuid,
    /// The run's conversation.
    channel: Uuid,
    /// A second conversation the same agent and requester are in: where the request lies it should go.
    other_channel: Uuid,
    trigger: Uuid,
    run: Uuid,
}

async fn seed_member(su: &PgPool, ws: Uuid, kind: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id,workspace_id,kind,status,display_name,handle) \
         VALUES($1,$2,$3::member_kind,'active',$4,$4)",
    )
    .bind(id)
    .bind(ws)
    .bind(kind)
    .bind(id.to_string())
    .execute(su)
    .await
    .unwrap();
    id
}

async fn seed_channel(su: &PgPool, ws: Uuid, creator: Uuid, members: &[Uuid]) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, created_by) \
         VALUES ($1, $2, 'public', $3, $4)",
    )
    .bind(channel)
    .bind(ws)
    .bind(format!("c-{channel}"))
    .bind(creator)
    .execute(su)
    .await
    .unwrap();
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(ws)
        .execute(su)
        .await
        .unwrap();
    for member in members {
        sqlx::query("INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)")
            .bind(ws)
            .bind(channel)
            .bind(member)
            .execute(su)
            .await
            .unwrap();
    }
    channel
}

/// A message by `author`; `pool` is the superuser for the fixture and `momo_worker` for a forgery.
async fn seed_message(pool: &PgPool, ws: Uuid, channel: Uuid, author: Uuid) -> Uuid {
    let seq: i64 = sqlx::query_scalar(
        "UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1 RETURNING last_seq",
    )
    .bind(channel)
    .fetch_one(pool)
    .await
    .unwrap();
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
         author_member_id, type, body) VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', 'x')",
    )
    .bind(id)
    .bind(ws)
    .bind(channel)
    .bind(seq)
    .bind(author)
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn seed_run(pool: &PgPool, ws: Uuid, channel: Uuid, agent: Uuid, trigger: Uuid) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id, trigger_message_id, \
         status, idempotency_key) VALUES ($1, $2, $3, $4, $5, 'running'::run_status, $6)",
    )
    .bind(run)
    .bind(ws)
    .bind(agent)
    .bind(channel)
    .bind(trigger)
    .bind(format!("agent-picture:{run}"))
    .execute(pool)
    .await
    .unwrap();
    run
}

async fn seed_tenant(w: &World) -> Tenant {
    let su = &w.su;
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id,slug,name) VALUES($1,$2,$2)")
        .bind(ws)
        .bind(ws.to_string())
        .execute(su)
        .await
        .unwrap();
    let alice = seed_member(su, ws, "human").await;
    let bob = seed_member(su, ws, "human").await;
    let agent = seed_member(su, ws, "agent").await;
    let channel = seed_channel(su, ws, alice, &[alice, bob, agent]).await;
    let other_channel = seed_channel(su, ws, alice, &[alice, bob, agent]).await;
    let trigger = seed_message(su, ws, channel, alice).await;
    let run = seed_run(su, ws, channel, agent, trigger).await;
    w.spaces.lock().unwrap().push(ws);
    Tenant {
        ws,
        alice,
        agent,
        channel,
        other_channel,
        trigger,
        run,
    }
}

/// Another run of the same agent in the same channel (every token is one run's one slot).
/// A mark row `age` old for `ws` (what the api's write leaves behind, at the age a test needs), written by
/// the superuser: nobody else may write one.
async fn seed_mark_row(w: &World, ws: Uuid, age: &str) {
    sqlx::query(
        "INSERT INTO agent_picture_mark (workspace_id, attachment_id, run_id, agent_member_id, written_at) \
         VALUES ($1, $2, $3, $4, clock_timestamp() - $5::interval)",
    )
    .bind(ws)
    .bind(Uuid::new_v4())
    .bind(Uuid::new_v4())
    .bind(Uuid::new_v4())
    .bind(age)
    .execute(&w.su)
    .await
    .expect("mark row");
}

async fn fresh_run(w: &World, t: &Tenant) -> Uuid {
    let trigger = seed_message(&w.su, t.ws, t.channel, t.alice).await;
    seed_run(&w.su, t.ws, t.channel, t.agent, trigger).await
}

/// The write address the worker would mint, with the production lifetime. `None`: any rule refused.
async fn try_mint(w: &World, ws: Uuid, run: Uuid, agent: Uuid) -> Option<AgentPictureGrant> {
    let grant = with_tenant_tx(&w.worker, ws, move |conn| {
        Box::pin(async move { mint_agent_picture_in_tx(conn, ws, run, agent).await })
    })
    .await
    .expect("mint");
    if let Some(grant) = &grant {
        w.minted.lock().unwrap().push((ws, grant.token.clone()));
    }
    grant
}

async fn mint_for(w: &World, t: &Tenant, run: Uuid) -> String {
    try_mint(w, t.ws, run, t.agent)
        .await
        .expect("a token")
        .token
}

async fn mint_ttl(w: &World, t: &Tenant, run: Uuid, ttl_secs: i64) -> String {
    let (ws, agent) = (t.ws, t.agent);
    let grant = with_tenant_tx(&w.worker, ws, move |conn| {
        Box::pin(
            async move { mint_agent_picture_with_ttl_in_tx(conn, ws, run, agent, ttl_secs).await },
        )
    })
    .await
    .expect("mint")
    .expect("a token");
    w.minted.lock().unwrap().push((ws, grant.token.clone()));
    grant.token
}

/// A well-formed token nobody minted: 32 random bytes, URL-safe, 43 characters.
fn made_up_token() -> String {
    let mut bytes = Uuid::new_v4().as_bytes().to_vec();
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A row in the token table that `momo_worker` writes by hand (the BYPASSRLS role's INSERT right):
/// whatever it names, the api derives who and where from the run when the token is spent.
async fn forge_token(w: &World, ws: Uuid, run: Uuid, agent: Uuid, slot: i16) -> String {
    let token = made_up_token();
    let hash = token_hash(&token).to_vec();
    with_tenant_tx(&w.worker, ws, move |conn| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO attachment_write_token \
                    (workspace_id, token_hash, run_id, agent_member_id, slot, created_at, expires_at) \
                 VALUES ($1, $2, $3, $4, $5, clock_timestamp(), clock_timestamp() + interval '60 seconds')",
            )
            .bind(ws)
            .bind(hash)
            .bind(run)
            .bind(agent)
            .bind(slot)
            .execute(&mut *conn)
            .await?;
            Ok(())
        })
    })
    .await
    .expect("forge");
    w.minted.lock().unwrap().push((ws, token.clone()));
    token
}

async fn set_run_status(w: &World, run: Uuid, status: &str) {
    sqlx::query("UPDATE agent_run SET status = $2::run_status WHERE id = $1")
        .bind(run)
        .bind(status)
        .execute(&w.su)
        .await
        .unwrap();
}

// --- reading the database back ------------------------------------------------

#[derive(Debug, Clone)]
struct Row {
    id: Uuid,
    channel_id: Uuid,
    uploader: Uuid,
    message_id: Option<Uuid>,
    drive_file_id: String,
    name: String,
    mime: String,
    size_bytes: i64,
    status: String,
}

type RowTuple = (
    Uuid,
    Uuid,
    Uuid,
    Option<Uuid>,
    Option<String>,
    String,
    String,
    i64,
    String,
);

fn row_of(tuple: RowTuple) -> Row {
    Row {
        id: tuple.0,
        channel_id: tuple.1,
        uploader: tuple.2,
        message_id: tuple.3,
        drive_file_id: tuple.4.unwrap_or_default(),
        name: tuple.5,
        mime: tuple.6,
        size_bytes: tuple.7,
        status: tuple.8,
    }
}

const ROW_COLUMNS: &str =
    "id, channel_id, uploader_member_id, message_id, drive_file_id, name, mime, size_bytes, status";

async fn attachment_row(w: &World, id: Uuid) -> Row {
    row_of(
        sqlx::query_as::<_, RowTuple>(&format!(
            "SELECT {ROW_COLUMNS} FROM attachment WHERE id = $1"
        ))
        .bind(id)
        .fetch_one(&w.su)
        .await
        .expect("the attachment row"),
    )
}

/// The attachments this tenant's agent uploaded.
async fn agent_rows(w: &World, t: &Tenant) -> Vec<Row> {
    sqlx::query_as::<_, RowTuple>(&format!(
        "SELECT {ROW_COLUMNS} FROM attachment WHERE workspace_id = $1 AND uploader_member_id = $2 \
          ORDER BY created_at, id"
    ))
    .bind(t.ws)
    .bind(t.agent)
    .fetch_all(&w.su)
    .await
    .unwrap()
    .into_iter()
    .map(row_of)
    .collect()
}

async fn count(w: &World, sql: &str, id: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_one(&w.su)
        .await
        .unwrap()
}

/// Whether the token is spent, and the attachment its row recorded.
async fn token_state(w: &World, token: &str) -> (bool, Option<Uuid>) {
    sqlx::query_as(
        "SELECT used_at IS NOT NULL, attachment_id FROM attachment_write_token WHERE token_hash = $1",
    )
    .bind(token_hash(token).to_vec())
    .fetch_one(&w.su)
    .await
    .expect("the token row")
}

#[derive(Debug, Clone)]
struct Audit {
    actor: Option<Uuid>,
    target_type: Option<String>,
    target_id: Option<Uuid>,
    via_token: Option<Uuid>,
    detail: Value,
}

async fn audits(w: &World, ws: Uuid, action: &str) -> Vec<Audit> {
    sqlx::query_as::<
        _,
        (
            Option<Uuid>,
            Option<Uuid>,
            Option<String>,
            Option<Uuid>,
            Option<Uuid>,
            Value,
        ),
    >(
        "SELECT actor_member_id, subject_member_id, target_type, target_id, via_token_id, detail \
           FROM audit_log WHERE workspace_id = $1 AND action = $2 ORDER BY created_at, id",
    )
    .bind(ws)
    .bind(action)
    .fetch_all(&w.su)
    .await
    .unwrap()
    .into_iter()
    .map(|row| Audit {
        actor: row.0,
        target_type: row.2,
        target_id: row.3,
        via_token: row.4,
        detail: row.5,
    })
    .collect()
}

/// The one `agent_picture_refused` line a post-spend refusal leaves: its closed word and its run.
async fn refused_reason(w: &World, t: &Tenant, run: Uuid) -> Vec<String> {
    audits(w, t.ws, "attachment.agent_picture_refused")
        .await
        .into_iter()
        .filter(|audit| audit.target_id == Some(run))
        .map(|audit| audit.detail["reason"].as_str().unwrap_or("?").to_string())
        .collect()
}

/// Poll until `check` gives a value (the detached landing task finishes on its own time).
async fn eventually<T, F, Fut>(what: &str, check: F) -> T
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    for _ in 0..200 {
        if let Some(value) = check().await {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("never happened within 10 s: {what}");
}

// --- talking to the server ----------------------------------------------------

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap()
}

struct Seen {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    /// The closed word of a refusal (`error.code`).
    fn code(&self) -> Option<String> {
        self.json()["error"]["code"].as_str().map(str::to_string)
    }
    /// Status, body and every header but `date`: what "the same answer, byte for byte" compares.
    fn fingerprint(&self) -> (u16, Vec<u8>, BTreeSet<(String, String)>) {
        (
            self.status,
            self.body.clone(),
            self.headers
                .iter()
                .filter(|(name, _)| name != "date")
                .cloned()
                .collect(),
        )
    }
}

async fn seen_of(response: reqwest::Response) -> Seen {
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or("<binary>").to_string(),
            )
        })
        .collect();
    Seen {
        status,
        headers,
        body: response.bytes().await.unwrap().to_vec(),
    }
}

fn address(ws: Uuid, token: &str) -> String {
    format!("/v1/agent-media/{ws}/{token}")
}

/// `PUT` the picture exactly as the worker does, from no address in particular (no budget is spent).
async fn put(w: &World, ws: Uuid, token: &str, bytes: Vec<u8>) -> Seen {
    put_with(w, &address(ws, token), &[], bytes).await
}

async fn put_with(
    w: &World,
    path_and_query: &str,
    headers: &[(&str, &str)],
    bytes: Vec<u8>,
) -> Seen {
    let mut request = client()
        .put(format!("{}{}", w.base, path_and_query))
        .body(bytes);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    seen_of(request.send().await.expect("request")).await
}

/// [`put`] from a named address: the refusal budget is keyed on it, and a request with none is charged
/// to nobody.
async fn put_from(w: &World, ip: &str, ws: Uuid, token: &str, bytes: Vec<u8>) -> Seen {
    put_with(w, &address(ws, token), &[("x-forwarded-for", ip)], bytes).await
}

async fn send_method(w: &World, method: reqwest::Method, path: &str, ip: &str) -> Seen {
    seen_of(
        client()
            .request(method, format!("{}{}", w.base, path))
            .header("x-forwarded-for", ip)
            .send()
            .await
            .expect("request"),
    )
    .await
}

// --- a raw socket: the whole request head and every byte are the test's -------

struct Raw {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
    after: Duration,
}

enum Step {
    Send(Vec<u8>),
    Pause(Duration),
    HalfClose,
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn has(haystack: &[u8], needle: &str) -> bool {
    find(haystack, needle.as_bytes()).is_some()
}

fn content_length_of(head: &[u8]) -> usize {
    String::from_utf8_lossy(head)
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse().ok())
        .unwrap_or(0)
}

/// Send a `PUT` head and then `steps`, reading the server's answer **at the same time**. `None`: no
/// answer within `patience` (a server that waits for a body it was promised never answers a probe that
/// does not send it). The write half stays open after the last step, so the server is never told the
/// request ended unless the steps say so.
async fn raw(
    addr: SocketAddr,
    path: &str,
    headers: &[(&str, String)],
    steps: Vec<Step>,
    patience: Duration,
) -> Option<Raw> {
    let started = Instant::now();
    let socket = tokio::net::TcpStream::connect(addr).await.expect("connect");
    let (mut reader, mut writer) = socket.into_split();
    let mut head = format!("PUT {path} HTTP/1.1\r\nHost: {addr}\r\nX-Forwarded-For: {RAW_IP}\r\n");
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let sender = tokio::spawn(async move {
        if writer.write_all(head.as_bytes()).await.is_err() {
            return;
        }
        for step in steps {
            match step {
                Step::Send(bytes) => {
                    if writer.write_all(&bytes).await.is_err() {
                        return;
                    }
                }
                Step::Pause(pause) => tokio::time::sleep(pause).await,
                Step::HalfClose => {
                    let _ = writer.shutdown().await;
                }
            }
        }
        std::future::pending::<()>().await;
    });
    let mut received = Vec::new();
    let read = tokio::time::timeout(patience, async {
        let mut buffer = [0u8; 4096];
        loop {
            let n = reader.read(&mut buffer).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            received.extend_from_slice(&buffer[..n]);
            if let Some(end) = find(&received, b"\r\n\r\n") {
                if received.len() >= end + 4 + content_length_of(&received[..end]) {
                    break;
                }
            }
        }
    })
    .await;
    let after = started.elapsed();
    sender.abort();
    if read.is_err() && find(&received, b"\r\n\r\n").is_none() {
        return None;
    }
    // the first response only: a stray byte after the announced body is read by the server as the start
    // of a next request and answered too, on the same connection
    let end = find(&received, b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&received[..end]).into_owned();
    let wanted = content_length_of(&received[..end]);
    let body_end = (end + 4 + wanted).min(received.len());
    let body = String::from_utf8_lossy(&received[end + 4..body_end]).into_owned();
    let mut lines = head.lines();
    let status = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    Some(Raw {
        status,
        headers,
        body,
        after,
    })
}

impl Raw {
    fn into_seen(self) -> Seen {
        Seen {
            status: self.status,
            headers: self.headers.into_iter().collect(),
            body: self.body.into_bytes(),
        }
    }
}

/// [`put`] with the `Content-Length` written out, whatever the body is — an empty one included (reqwest
/// sends no length for an empty body, and the route then answers 411).
async fn put_declared(w: &World, ws: Uuid, token: &str, bytes: Vec<u8>) -> Seen {
    raw(
        w.addr,
        &address(ws, token),
        &length(bytes.len()),
        vec![Step::Send(bytes)],
        Duration::from_secs(30),
    )
    .await
    .expect("an answer")
    .into_seen()
}

impl Raw {
    fn code(&self) -> Option<String> {
        serde_json::from_str::<Value>(&self.body).ok()?["error"]["code"]
            .as_str()
            .map(str::to_string)
    }
}

const PROMPT: Duration = Duration::from_secs(5);

fn length(n: usize) -> Vec<(&'static str, String)> {
    vec![("Content-Length", n.to_string())]
}

// --- the pictures -------------------------------------------------------------

fn encode(image: image::DynamicImage, format: image::ImageFormat) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    image.write_to(&mut out, format).unwrap();
    out.into_inner()
}

fn noise(seed: u32) -> impl FnMut() -> [u8; 4] {
    let mut state = 0x9E37_79B9u32 ^ seed;
    move || {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        state.to_le_bytes()
    }
}

/// A PNG with an alpha channel (the decoder keeps it a PNG).
fn png_rgba(w: u32, h: u32, seed: u32) -> Vec<u8> {
    let mut next = noise(seed);
    let image = image::RgbaImage::from_fn(w, h, |_, _| {
        let b = next();
        image::Rgba([b[0], b[1], b[2], 255])
    });
    encode(
        image::DynamicImage::ImageRgba8(image),
        image::ImageFormat::Png,
    )
}

/// A PNG without one (the decoder turns it into a JPEG).
fn png_rgb(w: u32, h: u32, seed: u32) -> Vec<u8> {
    let mut next = noise(seed);
    let image = image::RgbImage::from_fn(w, h, |_, _| {
        let b = next();
        image::Rgb([b[0], b[1], b[2]])
    });
    encode(
        image::DynamicImage::ImageRgb8(image),
        image::ImageFormat::Png,
    )
}

fn jpeg_rgb(w: u32, h: u32, seed: u32) -> Vec<u8> {
    let mut next = noise(seed);
    let image = image::RgbImage::from_fn(w, h, |_, _| {
        let b = next();
        image::Rgb([b[0], b[1], b[2]])
    });
    encode(
        image::DynamicImage::ImageRgb8(image),
        image::ImageFormat::Jpeg,
    )
}

/// A still, lossless WebP.
fn webp_rgba(w: u32, h: u32, seed: u32) -> Vec<u8> {
    let mut next = noise(seed);
    let image = image::RgbaImage::from_fn(w, h, |_, _| {
        let b = next();
        image::Rgba([b[0], b[1], b[2], 255])
    });
    encode(
        image::DynamicImage::ImageRgba8(image),
        image::ImageFormat::WebP,
    )
}

/// Smooth, so a big one still compresses under the 5 MiB input ceiling.
fn gradient_png_rgba(w: u32, h: u32) -> Vec<u8> {
    let image = image::RgbaImage::from_fn(w, h, |x, y| {
        image::Rgba([(x * 255 / w) as u8, (y * 255 / h) as u8, 128, 255])
    });
    encode(
        image::DynamicImage::ImageRgba8(image),
        image::ImageFormat::Png,
    )
}

/// Left half red, right half blue: which way it is turned shows in where the red ends up.
fn two_halves_jpeg(w: u32, h: u32) -> Vec<u8> {
    let image = image::RgbImage::from_fn(w, h, |x, _| {
        if x < w / 2 {
            image::Rgb([220, 30, 30])
        } else {
            image::Rgb([30, 30, 220])
        }
    });
    encode(
        image::DynamicImage::ImageRgb8(image),
        image::ImageFormat::Jpeg,
    )
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = (data.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut checked = kind.to_vec();
    checked.extend_from_slice(data);
    out.extend_from_slice(&crc32(&checked).to_be_bytes());
    out
}

/// `chunks` spliced in right before the first `IDAT`.
fn png_with_chunks(png: &[u8], chunks: &[Vec<u8>]) -> Vec<u8> {
    let mut at = 8;
    while at + 8 <= png.len() {
        let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
        if &png[at + 4..at + 8] == b"IDAT" {
            break;
        }
        at += 12 + len;
    }
    let mut out = png[..at].to_vec();
    for chunk in chunks {
        out.extend_from_slice(chunk);
    }
    out.extend_from_slice(&png[at..]);
    out
}

/// Only the signature and an `IHDR` that claims `w`×`h`: 33 bytes, whatever it claims.
fn png_header_only(w: u32, h: u32) -> Vec<u8> {
    let mut ihdr = w.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    out.extend_from_slice(&png_chunk(b"IHDR", &ihdr));
    out
}

/// A big-endian EXIF block: the orientation, a camera string (`Make`) and, in the GPS IFD, a note.
fn exif_tiff(orientation: u16) -> Vec<u8> {
    let entry = |out: &mut Vec<u8>, tag: u16, kind: u16, count: u32, value: [u8; 4]| {
        out.extend_from_slice(&tag.to_be_bytes());
        out.extend_from_slice(&kind.to_be_bytes());
        out.extend_from_slice(&count.to_be_bytes());
        out.extend_from_slice(&value);
    };
    let ifd0_at = 8usize;
    let gps_at = ifd0_at + 2 + 3 * 12 + 4;
    let data_at = gps_at + 2 + 2 * 12 + 4;
    let make = [CAMERA.as_bytes(), b"\0"].concat();
    let area = [b"ASCII\0\0\0".as_slice(), GPS_NOTE.as_bytes()].concat();
    let mut tiff = b"MM\0*".to_vec();
    tiff.extend_from_slice(&(ifd0_at as u32).to_be_bytes());
    tiff.extend_from_slice(&3u16.to_be_bytes());
    entry(
        &mut tiff,
        0x010F,
        2,
        make.len() as u32,
        (data_at as u32).to_be_bytes(),
    );
    entry(
        &mut tiff,
        0x0112,
        3,
        1,
        [(orientation >> 8) as u8, orientation as u8, 0, 0],
    );
    entry(&mut tiff, 0x8825, 4, 1, (gps_at as u32).to_be_bytes());
    tiff.extend_from_slice(&0u32.to_be_bytes());
    tiff.extend_from_slice(&2u16.to_be_bytes());
    entry(&mut tiff, 0x0001, 2, 2, *b"N\0\0\0");
    entry(
        &mut tiff,
        0x001C,
        7,
        area.len() as u32,
        ((data_at + make.len()) as u32).to_be_bytes(),
    );
    tiff.extend_from_slice(&0u32.to_be_bytes());
    tiff.extend_from_slice(&make);
    tiff.extend_from_slice(&area);
    tiff
}

/// `jpeg` with an EXIF block (orientation, camera, GPS note), a comment and bytes after its end.
fn jpeg_with_metadata(jpeg: &[u8], orientation: u16) -> Vec<u8> {
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend_from_slice(&exif_tiff(orientation));
    let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
    out.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&app1);
    out.extend_from_slice(&[0xFF, 0xFE]);
    out.extend_from_slice(&((COMMENT.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(COMMENT.as_bytes());
    out.extend_from_slice(&jpeg[2..]);
    out.extend_from_slice(TRAILER.as_bytes());
    out
}

/// `png` with a text chunk, an EXIF chunk and bytes after `IEND`.
fn png_with_metadata(png: &[u8]) -> Vec<u8> {
    let text = png_chunk(b"tEXt", format!("Comment\0{TEXT_CHUNK}").as_bytes());
    let exif = png_chunk(b"eXIf", &exif_tiff(1));
    let mut out = png_with_chunks(png, &[text, exif]);
    out.extend_from_slice(TRAILER.as_bytes());
    out
}

/// `bytes` followed by zeros up to exactly `total` (a decoder stops at the end of the picture).
fn padded(mut bytes: Vec<u8>, total: usize) -> Vec<u8> {
    assert!(bytes.len() <= total);
    bytes.resize(total, 0);
    bytes
}

/// The smallest GIF there is, one frame: the decoder opens it as a still.
fn gif_one_frame() -> Vec<u8> {
    let mut gif = b"GIF89a".to_vec();
    gif.extend_from_slice(&[0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]);
    gif.extend_from_slice(&[0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00]);
    gif.extend_from_slice(&[0x21, 0xF9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00]);
    gif.extend_from_slice(&[0x2C, 0, 0, 0, 0, 0x01, 0x00, 0x01, 0x00, 0x00]);
    gif.extend_from_slice(&[0x02, 0x02, 0x44, 0x01, 0x00]);
    gif.push(0x3B);
    gif
}

fn gif_two_frames() -> Vec<u8> {
    let mut gif = b"GIF89a".to_vec();
    gif.extend_from_slice(&[0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]);
    gif.extend_from_slice(&[0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00]);
    for _ in 0..2 {
        gif.extend_from_slice(&[0x21, 0xF9, 0x04, 0x00, 0x0A, 0x00, 0x00, 0x00]);
        gif.extend_from_slice(&[0x2C, 0, 0, 0, 0, 0x01, 0x00, 0x01, 0x00, 0x00]);
        gif.extend_from_slice(&[0x02, 0x02, 0x44, 0x01, 0x00]);
    }
    gif.push(0x3B);
    gif
}

/// A PNG that says it is animated: `acTL` and `fcTL` before the data.
fn apng() -> Vec<u8> {
    let mut actl = 2u32.to_be_bytes().to_vec();
    actl.extend_from_slice(&0u32.to_be_bytes());
    let mut fctl = 0u32.to_be_bytes().to_vec();
    fctl.extend_from_slice(&8u32.to_be_bytes());
    fctl.extend_from_slice(&8u32.to_be_bytes());
    fctl.extend_from_slice(&[0u8; 8]);
    fctl.extend_from_slice(&[0, 10, 0, 100, 0, 0]);
    png_with_chunks(
        &png_rgba(8, 8, 3),
        &[png_chunk(b"acTL", &actl), png_chunk(b"fcTL", &fctl)],
    )
}

fn riff_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = kind.to_vec();
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    if data.len() % 2 == 1 {
        out.push(0);
    }
    out
}

/// A WebP container whose `VP8X` says "animation", with the `ANIM` and `ANMF` chunks an animation has.
fn webp_animated() -> Vec<u8> {
    let mut body = b"WEBP".to_vec();
    body.extend_from_slice(&riff_chunk(b"VP8X", &[0x02, 0, 0, 0, 7, 0, 0, 7, 0, 0]));
    body.extend_from_slice(&riff_chunk(b"ANIM", &[0, 0, 0, 0, 0, 0]));
    body.extend_from_slice(&riff_chunk(b"ANMF", &[0u8; 24]));
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

fn svg() -> Vec<u8> {
    b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"><rect width=\"8\" height=\"8\" fill=\"red\"/></svg>".to_vec()
}

fn html() -> Vec<u8> {
    b"<!doctype html><html><body><script>alert(1)</script></body></html>".to_vec()
}

fn pdf() -> Vec<u8> {
    b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n".to_vec()
}

fn heic_like() -> Vec<u8> {
    let mut bytes = vec![0x00, 0x00, 0x00, 0x18];
    bytes.extend_from_slice(b"ftypheic\x00\x00\x00\x00mif1heic");
    bytes.extend_from_slice(&[0u8; 64]);
    bytes
}

fn png_magic_then_garbage() -> Vec<u8> {
    let mut next = noise(9);
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    for _ in 0..64 {
        bytes.extend_from_slice(&next());
    }
    bytes
}

// --- small assertions ---------------------------------------------------------

fn expect_201(seen: &Seen) -> (Uuid, String, i64) {
    assert_eq!(seen.status, 201, "{}", seen.text());
    let body = seen.json();
    (
        body["attachmentId"]
            .as_str()
            .expect("attachmentId")
            .parse()
            .expect("a uuid"),
        body["mime"].as_str().expect("mime").to_string(),
        body["sizeBytes"].as_i64().expect("sizeBytes"),
    )
}

fn expect_refused(seen: &Seen, status: u16, code: &str) {
    assert_eq!(seen.status, status, "{}", seen.text());
    assert_eq!(seen.code().as_deref(), Some(code), "{}", seen.text());
}

// --- WA11: the row, the audit, and a request that lies -------------------------

/// The picture lands as the **run's** agent in the **run's** channel under a name the **server** chose,
/// whatever the request says: a hostile `Content-Type`, a claimed channel (header and query), a claimed
/// uploader, a file name. The response is three fields; the row, the archive object and the audit line
/// are read back.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_picture_is_written_as_the_runs_agent_in_the_runs_channel_whatever_the_request_claims() {
    let (_gate, logs) = begin().await;
    let w = boot().await;
    let t = seed_tenant(&w).await;

    // A. an RGBA PNG, with every piece of request metadata lying
    let token = mint_for(&w, &t, t.run).await;
    let input = png_rgba(96, 64, 1);
    let marks = Marks::now();
    let hostile_type = format!("text/html; charset={HOSTILE}");
    let lie_channel = t.other_channel.to_string();
    let lie_uploader = t.alice.to_string();
    let disposition = format!("attachment; filename=\"{HOSTILE_NAME}\"");
    let path = format!(
        "{}?channel={}&uploader={}&name={HOSTILE_NAME}",
        address(t.ws, &token),
        t.other_channel,
        t.alice
    );
    let seen = put_with(
        &w,
        &path,
        &[
            ("content-type", hostile_type.as_str()),
            ("x-channel", lie_channel.as_str()),
            ("x-uploader", lie_uploader.as_str()),
            ("x-file-name", HOSTILE_NAME),
            ("content-disposition", disposition.as_str()),
        ],
        input.clone(),
    )
    .await;
    let (id, mime, size) = expect_201(&seen);
    let keys: BTreeSet<String> = seen.json().as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        BTreeSet::from(["attachmentId", "mime", "sizeBytes"].map(String::from)),
        "the response is the three fields and nothing else"
    );
    assert_eq!(seen.header("cache-control"), Some("no-store"));

    let row = attachment_row(&w, id).await;
    assert_eq!(row.uploader, t.agent, "the uploader is the run's agent");
    assert_ne!(row.uploader, t.alice, "…not the member the request named");
    assert_eq!(row.channel_id, t.channel, "the channel is the run's");
    assert_ne!(
        row.channel_id, t.other_channel,
        "…not the one the request named"
    );
    assert_eq!(row.status, "complete");
    assert_eq!(row.message_id, None);
    assert_eq!(row.name, "picture-1.png", "the name is the server's");
    assert_eq!(
        row.mime, "image/png",
        "the mime is the decoder's, not `text/html`"
    );
    assert_eq!(mime, "image/png");

    // the archive's own object, read back — the row's size is the object's real length
    assert_eq!(w.files.objects(), vec![row.drive_file_id.clone()]);
    let stored = w.files.read(&row.drive_file_id).await;
    assert_eq!(row.size_bytes, stored.len() as i64);
    assert_eq!(size, stored.len() as i64);
    let metadata = w.files.file_metadata(&row.drive_file_id).await.unwrap();
    assert_eq!(
        (
            metadata.size_bytes,
            metadata.mime.as_str(),
            metadata.name.as_str()
        ),
        (row.size_bytes, "image/png", "picture-1.png")
    );
    // (an image-crate PNG with nothing extra in it encodes to the same bytes again, so "differs from the
    // input" is T2's claim, made with pictures that carry something to strip)
    assert!(stored.starts_with(b"\x89PNG\r\n\x1a\n"));

    // the audit line: the documented fields, nothing that names a file, a byte, a token or an address
    let written = audits(&w, t.ws, "attachment.agent_picture_written").await;
    assert_eq!(written.len(), 1);
    let line = &written[0];
    assert_eq!(line.actor, Some(t.agent));
    assert_eq!(line.target_type.as_deref(), Some("attachment"));
    assert_eq!(line.target_id, Some(id));
    assert_eq!(line.via_token, None);
    let fields: BTreeSet<String> = line.detail.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        fields,
        BTreeSet::from(
            [
                "schema",
                "channel_id",
                "run_id",
                "slot",
                "mime_in",
                "mime",
                "bytes_in",
                "bytes",
                "decode_ms",
                "backend"
            ]
            .map(String::from)
        )
    );
    assert_eq!(
        line.detail["schema"],
        "momo.attachment.agent_picture_written.v1"
    );
    assert_eq!(line.detail["channel_id"], t.channel.to_string());
    assert_eq!(line.detail["run_id"], t.run.to_string());
    assert_eq!(line.detail["slot"], 1);
    assert_eq!(line.detail["mime_in"], "image/png");
    assert_eq!(line.detail["mime"], "image/png");
    assert_eq!(line.detail["bytes_in"], input.len());
    assert_eq!(line.detail["bytes"], stored.len());
    assert_eq!(line.detail["backend"], "local");
    assert!(line.detail["decode_ms"].as_i64().is_some_and(|ms| ms >= 0));
    let line_text = line.detail.to_string();
    for forbidden in [HOSTILE, HOSTILE_NAME, "picture-1", token.as_str()] {
        assert!(
            !line_text.contains(forbidden),
            "the audit line holds `{forbidden}`"
        );
    }
    assert!(audits(&w, t.ws, "attachment.agent_picture_refused")
        .await
        .is_empty());

    // the token's own row: spent, with the one attachment it made, and the hash of the token only
    assert_eq!(token_state(&w, &token).await, (true, Some(id)));
    // the route went through the child, and the parent decoded nothing itself
    assert_eq!(marks.children(), 1, "exactly one decoder child");
    assert_eq!(
        marks.in_process(),
        0,
        "the parent never opens a picture in its own process"
    );

    // B. a JPEG with no alpha is a JPEG, and the name follows the type
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    let (id, mime, _) = expect_201(&put(&w, t.ws, &token, jpeg_rgb(80, 60, 2)).await);
    let row = attachment_row(&w, id).await;
    assert_eq!(
        (mime.as_str(), row.mime.as_str()),
        ("image/jpeg", "image/jpeg")
    );
    assert_eq!(row.name, "picture-1.jpg");
    assert_eq!(agent_rows(&w, &t).await.len(), 2);

    w.assert_no_leak(&[HOSTILE, HOSTILE_NAME, hostile_type.as_str()], &logs)
        .await;
}

// --- WA8: what is stored is the decoder's output --------------------------------

/// (label, the answer, the token it used and whether the spend was meant to have burned it)
type Case = (String, Seen, Option<(String, bool)>);

async fn written_object(w: &World, t: &Tenant, input: Vec<u8>) -> (Row, Vec<u8>) {
    let run = fresh_run(w, t).await;
    let token = mint_for(w, t, run).await;
    let (id, _, _) = expect_201(&put(w, t.ws, &token, input).await);
    let row = attachment_row(w, id).await;
    let stored = w.files.read(&row.drive_file_id).await;
    (row, stored)
}

/// The bytes the **archive** holds (not the response) are re-encoded from pixels: different from the
/// input, none of the planted EXIF (camera, GPS), comment, text chunk or trailing bytes, the type is PNG
/// for a picture with alpha and JPEG for one without, the long side ≤ 1024, the size ≤ 4 MiB, and an EXIF
/// orientation is applied.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_stored_bytes_are_the_decoders_output_and_carry_nothing_of_the_input() {
    let (_gate, logs) = begin().await;
    let w = boot().await;
    let t = seed_tenant(&w).await;

    // A. a phone JPEG, sideways by EXIF 6, with a camera string, a GPS note, a comment and a tail
    let photo = jpeg_with_metadata(&two_halves_jpeg(1280, 960), 6);
    for marker in [CAMERA, GPS_NOTE, COMMENT, TRAILER, "Exif"] {
        assert!(has(&photo, marker), "control: the input carries {marker}");
    }
    let (row, stored) = written_object(&w, &t, photo.clone()).await;
    assert_ne!(stored, photo, "the input was not stored");
    for marker in MARKERS.iter().copied().chain(["Exif"]) {
        assert!(!has(&stored, marker), "`{marker}` left with the picture");
    }
    assert_eq!(
        (row.mime.as_str(), row.name.as_str()),
        ("image/jpeg", "picture-1.jpg")
    );
    assert!(stored.starts_with(&[0xFF, 0xD8, 0xFF]));
    assert!(stored.len() <= 4 * 1024 * 1024);
    let upright = image::load_from_memory(&stored).unwrap();
    assert_eq!(
        (upright.width(), upright.height()),
        (768, 1024),
        "1280×960 turned a quarter and shrunk to 1024 on the long side"
    );
    let pixels = upright.to_rgb8();
    let top = pixels.get_pixel(pixels.width() / 2, pixels.height() / 4);
    let bottom = pixels.get_pixel(pixels.width() / 2, pixels.height() * 3 / 4);
    assert!(
        top[0] > 150 && top[2] < 100,
        "EXIF 6 puts the left (red) half on top: {top:?}"
    );
    assert!(
        bottom[2] > 150 && bottom[0] < 100,
        "…and the right (blue) half below: {bottom:?}"
    );

    // the same picture with orientation 1 is not turned: red stays on the left (the turn is the EXIF's)
    let (_, stored) =
        written_object(&w, &t, jpeg_with_metadata(&two_halves_jpeg(1280, 960), 1)).await;
    let flat = image::load_from_memory(&stored).unwrap();
    assert_eq!((flat.width(), flat.height()), (1024, 768));
    let pixels = flat.to_rgb8();
    let left = pixels.get_pixel(pixels.width() / 4, pixels.height() / 2);
    assert!(
        left[0] > 150 && left[2] < 100,
        "orientation 1 keeps red on the left: {left:?}"
    );

    // B. a big PNG with alpha, a text chunk, an EXIF chunk and a tail: stays a PNG, ≤ 1024
    let big = png_with_metadata(&gradient_png_rgba(1536, 1152));
    for marker in [TEXT_CHUNK, TRAILER, "tEXt", "eXIf", CAMERA] {
        assert!(has(&big, marker), "control: the PNG carries {marker}");
    }
    let (row, stored) = written_object(&w, &t, big.clone()).await;
    assert_ne!(stored, big);
    for marker in MARKERS
        .iter()
        .copied()
        .chain(["tEXt", "eXIf", "iTXt", "zTXt", "iCCP"])
    {
        assert!(!has(&stored, marker), "`{marker}` left with the picture");
    }
    assert_eq!(
        (row.mime.as_str(), row.name.as_str()),
        ("image/png", "picture-1.png")
    );
    assert!(stored.starts_with(b"\x89PNG\r\n\x1a\n") && stored.len() <= 4 * 1024 * 1024);
    let small = image::load_from_memory(&stored).unwrap();
    assert_eq!((small.width(), small.height()), (1024, 768));

    // C. a PNG with no alpha becomes a JPEG
    let plain = png_with_metadata(&png_rgb(200, 150, 5));
    let (row, stored) = written_object(&w, &t, plain.clone()).await;
    assert_eq!(
        (row.mime.as_str(), row.name.as_str()),
        ("image/jpeg", "picture-1.jpg")
    );
    assert!(stored.starts_with(&[0xFF, 0xD8, 0xFF]) && stored != plain);
    for marker in MARKERS {
        assert!(!has(&stored, marker), "`{marker}` left with the picture");
    }

    w.assert_no_leak(&MARKERS, &logs).await;
}

// --- WA2: one token, one picture ------------------------------------------------

/// The same token `PUT` over real TCP by several clients at once: exactly one `201`, every other one the
/// refusal; one attachment row and one archive object per token.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn one_token_is_one_picture_under_real_concurrency() {
    let (_gate, logs) = begin().await;
    let w = boot().await;
    let t = seed_tenant(&w).await;
    let unknown = put(&w, t.ws, &made_up_token(), png_rgba(32, 32, 1)).await;
    assert_eq!(unknown.status, 404);
    for round in 0..4usize {
        let run = fresh_run(&w, &t).await;
        let token = mint_for(&w, &t, run).await;
        // four clients: the api serves four writes at once (a fifth would be told 503 before the spend)
        let answers = futures::future::join_all(
            (0..4u32).map(|n| put(&w, t.ws, &token, png_rgba(48, 48, 10 + n))),
        )
        .await;
        let created = answers.iter().filter(|a| a.status == 201).count();
        let refused: Vec<&Seen> = answers.iter().filter(|a| a.status == 404).collect();
        assert_eq!(
            created, 1,
            "round {round}: exactly one request won the token"
        );
        assert_eq!(
            refused.len(),
            3,
            "round {round}: every other one was refused"
        );
        for other in refused {
            assert_eq!(
                other.fingerprint(),
                unknown.fingerprint(),
                "the loser gets the one refusal"
            );
        }
        assert_eq!(
            agent_rows(&w, &t).await.len(),
            round + 1,
            "one row per token"
        );
        assert_eq!(w.files.objects().len(), round + 1, "one object per token");
        assert_eq!(
            w.files.puts(),
            round + 1,
            "the archive was written once per token"
        );
    }
    w.assert_no_leak(&[], &logs).await;
}

/// Everything that depends on the token and fails — a token nobody minted, a malformed one, an expired
/// one, one under another workspace's path, a run that ended (every state but `queued`/`running`,
/// `awaiting_approval` and `paused` included), a requester or agent who left, a deleted requester, an
/// archived channel, a forged row at slot 2, a forged row for another agent — is the **same** `404`, byte
/// for byte, and decodes and stores nothing. A tenant's token on another tenant's path leaves the other
/// tenant with no row, and the token unspent.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn every_refusal_that_depends_on_the_token_is_the_same_404() {
    let (_gate, logs) = begin().await;
    let w = boot().await;
    let t = seed_tenant(&w).await;
    let picture = png_rgba(40, 40, 6);
    let reference = put(&w, t.ws, &made_up_token(), picture.clone()).await;
    assert_eq!(reference.status, 404);
    assert_eq!(reference.json()["error"]["message"], "not found");
    let marks = Marks::now();

    // (label, the answer, the token it used and whether the spend was meant to have burned it)
    let mut cases: Vec<Case> = Vec::new();

    // the path and token shapes, answered without the database
    let token = made_up_token();
    cases.push((
        "short token".into(),
        put(&w, t.ws, "short", picture.clone()).await,
        None,
    ));
    cases.push((
        "a 44-character token".into(),
        put(&w, t.ws, &format!("{token}A"), picture.clone()).await,
        None,
    ));
    cases.push((
        "an upper-case workspace".into(),
        put_with(
            &w,
            &format!(
                "/v1/agent-media/{}/{token}",
                t.ws.to_string().to_uppercase()
            ),
            &[],
            picture.clone(),
        )
        .await,
        None,
    ));
    cases.push((
        "a workspace that is not an id".into(),
        put_with(
            &w,
            &format!("/v1/agent-media/not-a-uuid/{token}"),
            &[],
            picture.clone(),
        )
        .await,
        None,
    ));
    cases.push((
        "a workspace nobody made".into(),
        put(&w, Uuid::new_v4(), &token, picture.clone()).await,
        None,
    ));

    // expired
    let run = fresh_run(&w, &t).await;
    let token = mint_ttl(&w, &t, run, 1).await;
    tokio::time::sleep(Duration::from_millis(1400)).await;
    cases.push((
        "expired".into(),
        put(&w, t.ws, &token, picture.clone()).await,
        Some((token, false)),
    ));

    // a run that is not in flight, in every state it can be in
    for status in [
        "succeeded",
        "failed",
        "cancelled",
        "timed_out",
        "awaiting_approval",
        "paused",
    ] {
        let run = fresh_run(&w, &t).await;
        let token = mint_for(&w, &t, run).await;
        set_run_status(&w, run, status).await;
        cases.push((
            format!("run {status}"),
            put(&w, t.ws, &token, picture.clone()).await,
            Some((token, false)),
        ));
    }

    // forged rows (the BYPASSRLS role's INSERT right): slot 2 is beyond the run's limit; another agent
    // is not the run's agent
    let run = fresh_run(&w, &t).await;
    let token = forge_token(&w, t.ws, run, t.agent, 2).await;
    cases.push((
        "forged slot 2".into(),
        put(&w, t.ws, &token, picture.clone()).await,
        Some((token, false)),
    ));
    let run = fresh_run(&w, &t).await;
    let impostor = seed_member(&w.su, t.ws, "agent").await;
    let token = forge_token(&w, t.ws, run, impostor, 1).await;
    cases.push((
        "forged row for another agent".into(),
        put(&w, t.ws, &token, picture.clone()).await,
        Some((token, false)),
    ));

    // the binding no longer holds: the spend ran, then the run's own conversation said no
    for label in [
        "requester left",
        "agent left",
        "requester deleted",
        "channel archived",
    ] {
        let t2 = seed_tenant(&w).await;
        let token = mint_for(&w, &t2, t2.run).await;
        let (sql, who) = match label {
            "requester left" => (
                "UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2",
                Some(t2.alice),
            ),
            "agent left" => (
                "UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2",
                Some(t2.agent),
            ),
            "requester deleted" => ("UPDATE member SET deleted_at = now() WHERE id = $1", None),
            _ => ("UPDATE channel SET archived_at = now() WHERE id = $1", None),
        };
        let mut query = sqlx::query(sql);
        query = match label {
            "requester deleted" => query.bind(t2.alice),
            "channel archived" => query.bind(t2.channel),
            _ => query.bind(t2.channel).bind(who.unwrap()),
        };
        query.execute(&w.su).await.unwrap();
        cases.push((
            label.to_string(),
            put(&w, t2.ws, &token, picture.clone()).await,
            Some((token, true)),
        ));
    }

    // another workspace's path: tenant A's token on tenant B's address
    let a = seed_tenant(&w).await;
    let b = seed_tenant(&w).await;
    let token_a = mint_for(&w, &a, a.run).await;
    cases.push((
        "another workspace's path".into(),
        put(&w, b.ws, &token_a, picture.clone()).await,
        Some((token_a.clone(), false)),
    ));
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM attachment_write_token WHERE workspace_id = $1",
            b.ws
        )
        .await,
        0,
        "the other tenant has no token row"
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM attachment WHERE workspace_id = $1",
            b.ws
        )
        .await,
        0
    );

    // every one of them is the reference answer, byte for byte, and its token is where it should be
    for (label, seen, token) in &cases {
        assert_eq!(
            seen.fingerprint(),
            reference.fingerprint(),
            "{label}: the refusal is the one 404"
        );
        if let Some((token, burned)) = token {
            let (used, attachment) = token_state(&w, token).await;
            assert_eq!(
                used,
                *burned,
                "{label}: the token is {} ",
                if *burned { "spent" } else { "unspent" }
            );
            assert_eq!(attachment, None, "{label}: no attachment was recorded");
        }
    }
    // …and not one of them decoded or stored anything
    assert_eq!(marks.children(), 0, "no decoder child for any refusal");
    assert!(w.files.objects().is_empty() && w.files.puts() == 0);
    let spaces = w.spaces.lock().unwrap().clone();
    let strays: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM attachment a JOIN member m ON m.id = a.uploader_member_id \
          WHERE m.kind = 'agent' AND a.workspace_id = ANY($1)",
    )
    .bind(spaces)
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(strays, 0, "no agent attachment anywhere");

    // WA14: A's token was not burned by B's path — it still writes, as A, in A's channel
    let (id, _, _) = expect_201(&put(&w, a.ws, &token_a, picture.clone()).await);
    let row = attachment_row(&w, id).await;
    assert_eq!((row.uploader, row.channel_id), (a.agent, a.channel));
    // A's attachment is invisible to B's tenant transaction, and to the api role without a tenant at all
    let seen_by_b: i64 = with_tenant_tx(&w.app, b.ws, move |conn| {
        Box::pin(async move {
            Ok(
                sqlx::query_scalar("SELECT count(*) FROM attachment WHERE id = $1")
                    .bind(id)
                    .fetch_one(&mut *conn)
                    .await?,
            )
        })
    })
    .await
    .unwrap();
    assert_eq!(seen_by_b, 0, "tenant B cannot see tenant A's attachment");
    let without_guc: i64 = sqlx::query_scalar("SELECT count(*) FROM attachment_write_token")
        .fetch_one(&w.app)
        .await
        .unwrap();
    assert_eq!(
        without_guc, 0,
        "momo_app sees no token row without a tenant"
    );
    // a BYPASSRLS caller (the worker's role) cannot bind A's attachment into B's message either
    let (b_ws, b_channel, b_message, b_agent) = (b.ws, b.channel, b.trigger, b.agent);
    let rejected = with_tenant_tx(&w.worker, b.ws, move |conn| {
        Box::pin(async move {
            link_attachments_in_tx(conn, b_ws, b_channel, b_message, b_agent, None, &[id]).await
        })
    })
    .await
    .unwrap();
    assert_eq!(
        rejected,
        Err(AttachmentLinkRejected::NotFound),
        "another tenant's attachment is `not found`, not `foreign channel`"
    );

    w.assert_no_leak(&[], &logs).await;
}

// --- WA4: the order of operations -------------------------------------------------

/// A token that is unknown, expired, spent or the run's of an ended run is answered with the `404` while
/// the caller has sent 64 KiB of an announced 5 MiB (a server that read the body first would never
/// answer), starts no decoder child and writes nothing. A `PUT` with no `Content-Length` (411, also when
/// it is chunked) or one announcing 5 MiB + 1 (413) is answered from the head alone, and leaves its token
/// **unspent**: the same token then writes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_bad_token_is_answered_before_its_body_is_read_and_a_missing_or_oversized_length_leaves_the_token_unspent(
) {
    let (_gate, logs) = begin().await;
    let w = boot().await;
    let t = seed_tenant(&w).await;

    // the tokens that must be refused: unknown, expired, spent, run ended
    let unknown = made_up_token();
    let expired = {
        let run = fresh_run(&w, &t).await;
        mint_ttl(&w, &t, run, 1).await
    };
    let spent = {
        let run = fresh_run(&w, &t).await;
        let token = mint_for(&w, &t, run).await;
        expect_201(&put(&w, t.ws, &token, png_rgba(40, 40, 3)).await);
        token
    };
    let ended = {
        let run = fresh_run(&w, &t).await;
        let token = mint_for(&w, &t, run).await;
        set_run_status(&w, run, "cancelled").await;
        token
    };
    tokio::time::sleep(Duration::from_millis(1400)).await;
    assert_eq!(
        w.files.objects().len(),
        1,
        "only the control write stored anything"
    );
    let marks = Marks::now();
    let puts_before = w.files.puts();

    let mut announce = length(FIVE_MIB);
    announce.push(("Content-Type", "application/octet-stream".to_string()));
    for (label, token) in [
        ("unknown", &unknown),
        ("expired", &expired),
        ("spent", &spent),
        ("run ended", &ended),
    ] {
        let answer = raw(
            w.addr,
            &address(t.ws, token),
            &announce,
            vec![Step::Send(vec![0u8; 64 * 1024])],
            PROMPT,
        )
        .await
        .unwrap_or_else(|| {
            panic!(
                "{label}: no answer within {PROMPT:?} after 64 KiB of an announced 5 MiB — the body \
                 is being read before the token is judged"
            )
        });
        assert_eq!(answer.status, 404, "{label}");
        assert!(answer.after < PROMPT);
    }
    assert_eq!(marks.children(), 0, "no decoder child for a refused token");
    assert_eq!(w.files.puts(), puts_before, "no archive write");
    assert_eq!(w.files.objects().len(), 1);
    assert_eq!(agent_rows(&w, &t).await.len(), 1);

    // 411 and 413 are answered from the head and burn nothing
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    let path = address(t.ws, &token);
    let missing = raw(w.addr, &path, &[], vec![], PROMPT)
        .await
        .expect("an answer to a request with no length");
    assert_eq!(missing.status, 411);
    assert_eq!(missing.code().as_deref(), Some("length_required"));
    let chunked = raw(
        w.addr,
        &path,
        &[("Transfer-Encoding", "chunked".to_string())],
        vec![Step::Send(b"5\r\nhello\r\n0\r\n\r\n".to_vec())],
        PROMPT,
    )
    .await
    .expect("an answer to a chunked request");
    assert_eq!(
        chunked.status, 411,
        "a chunked body announces no length either"
    );
    let over = raw(w.addr, &path, &length(FIVE_MIB + 1), vec![], PROMPT)
        .await
        .expect("an answer from the head alone");
    assert_eq!(over.status, 413);
    assert_eq!(over.code().as_deref(), Some("too_large"));
    assert_eq!(
        token_state(&w, &token).await,
        (false, None),
        "neither refusal spent the token"
    );
    assert_eq!(marks.children(), 0);
    // the very same token writes
    let (id, _, _) = expect_201(&put(&w, t.ws, &token, png_rgba(40, 40, 4)).await);
    assert_eq!(token_state(&w, &token).await, (true, Some(id)));

    w.assert_no_leak(&[], &logs).await;
}

// --- WA5: the declared length is the input -----------------------------------------

/// A body shorter than it announced is `400 length_mismatch` (the token is spent, nothing is decoded or
/// stored); a body longer than it announced is cut at the announced length by the HTTP framing (a valid
/// picture followed by one stray byte writes; a picture cut short of its announced end is not a picture
/// even though the whole of it is on the wire); exactly 5 MiB passes the length gate and 5 MiB + 1 does
/// not; a body that trickles in a byte at a time is cut at the body deadline.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_declared_length_is_the_input_and_nothing_else() {
    let (_gate, logs) = begin().await;
    let w = boot_with(|state| state.with_agent_media_body_deadline(Duration::from_secs(2))).await;
    let t = seed_tenant(&w).await;
    let picture = png_rgba(64, 64, 4);
    let n = picture.len();

    // A. fewer bytes than announced, then the client half-closes
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    let marks = Marks::now();
    let answer = raw(
        w.addr,
        &address(t.ws, &token),
        &length(n),
        vec![Step::Send(picture[..n - 100].to_vec()), Step::HalfClose],
        PROMPT,
    )
    .await
    .expect("an answer to a half-closed, short body");
    assert_eq!(answer.status, 400);
    assert_eq!(answer.code().as_deref(), Some("length_mismatch"));
    assert_eq!(marks.children(), 0, "a short body is never decoded");
    assert!(agent_rows(&w, &t).await.is_empty() && w.files.objects().is_empty());
    assert_eq!(
        token_state(&w, &token).await,
        (true, None),
        "the spend came first: the token is gone"
    );
    assert_eq!(refused_reason(&w, &t, run).await, vec!["length_mismatch"]);
    let line = &audits(&w, t.ws, "attachment.agent_picture_refused").await[0];
    assert_eq!(
        line.detail["bytes_in"], n,
        "the line records the announced length"
    );
    assert_eq!(line.detail["slot"], 1);

    // B. one stray byte after an announced, complete picture: the picture writes, the byte is not input
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    let mut with_stray = picture.clone();
    with_stray.push(b'X');
    let answer = raw(
        w.addr,
        &address(t.ws, &token),
        &length(n),
        vec![Step::Send(with_stray)],
        PROMPT,
    )
    .await
    .expect("an answer");
    assert_eq!(answer.status, 201, "{}", answer.body);
    assert_eq!(agent_rows(&w, &t).await.len(), 1);
    // …and a picture whose announced length ends before its own end is cut there, though all of it is sent
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    let marks = Marks::now();
    let answer = raw(
        w.addr,
        &address(t.ws, &token),
        &length(n - 20),
        vec![Step::Send(picture.clone())],
        PROMPT,
    )
    .await
    .expect("an answer");
    assert_eq!(
        answer.status, 422,
        "the input is the first n-20 bytes: {}",
        answer.body
    );
    assert_eq!(answer.code().as_deref(), Some("invalid_picture"));
    assert_eq!(marks.children(), 1);
    assert_eq!(
        agent_rows(&w, &t).await.len(),
        1,
        "the cut picture stored nothing"
    );

    // C. exactly 5 MiB is within the length gate; 5 MiB + 1 announced is 413
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    let five = padded(jpeg_rgb(300, 200, 5), FIVE_MIB);
    assert_eq!(five.len(), FIVE_MIB);
    let answer = put(&w, t.ws, &token, five).await;
    assert!(
        matches!(answer.status, 201 | 422),
        "5 MiB passed the length gate (not 400/411/413): {} {}",
        answer.status,
        answer.text()
    );
    if answer.status == 201 {
        let (id, _, size) = expect_201(&answer);
        let stored = w
            .files
            .read(&attachment_row(&w, id).await.drive_file_id)
            .await;
        assert_eq!(stored.len() as i64, size);
        assert!(stored.len() < FIVE_MIB / 4, "the padding is not stored");
    }
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    let over = raw(
        w.addr,
        &address(t.ws, &token),
        &length(FIVE_MIB + 1),
        vec![],
        PROMPT,
    )
    .await
    .expect("an answer");
    assert_eq!(
        (over.status, over.code().as_deref()),
        (413, Some("too_large"))
    );
    assert_eq!(token_state(&w, &token).await, (false, None));

    // D. a body that arrives one byte at a time is cut at the body deadline (2 s here)
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    let rows_before = agent_rows(&w, &t).await.len();
    let marks = Marks::now();
    let mut drip = Vec::new();
    for _ in 0..40 {
        drip.push(Step::Send(vec![0x89]));
        drip.push(Step::Pause(Duration::from_millis(250)));
    }
    let answer = raw(
        w.addr,
        &address(t.ws, &token),
        &length(1000),
        drip,
        Duration::from_secs(8),
    )
    .await
    .expect("an answer before the drip ends");
    assert_eq!(answer.status, 400);
    assert_eq!(answer.code().as_deref(), Some("length_mismatch"));
    assert!(
        answer.after >= Duration::from_millis(1500) && answer.after < Duration::from_secs(6),
        "cut at the body deadline, after {:?}",
        answer.after
    );
    assert_eq!(marks.children(), 0);
    assert_eq!(agent_rows(&w, &t).await.len(), rows_before);
    assert_eq!(token_state(&w, &token).await, (true, None));
    assert_eq!(refused_reason(&w, &t, run).await, vec!["length_mismatch"]);

    w.assert_no_leak(&[], &logs).await;
}

// --- WA6: formats, with the real decoder child ---------------------------------------

/// GIF (one frame and animated), APNG, SVG, HTML, PDF, an animated WebP, HEIC-like bytes, nothing at all
/// and a PNG signature over garbage are all `422` and store nothing; a still PNG, JPEG and WebP are
/// `201`. The one-frame GIF is a picture the decoder child **would** take (control: asked directly it
/// answers), so it is the route's sniff — and only the sniff — that stops it, before any child starts.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn only_pictures_the_decoder_accepts_are_stored_and_a_one_frame_gif_is_stopped_by_the_sniff()
{
    let (_gate, logs) = begin().await;
    let w = boot().await;
    let t = seed_tenant(&w).await;

    // control: the child itself takes a one-frame GIF as a still, and refuses the animated one
    let control = media::prepare_photo_waiting(gif_one_frame(), media::WAIT_MAX)
        .await
        .expect("the decoder opens a one-frame GIF as a still picture");
    assert_eq!(control.mime, "image/png");
    assert!(
        media::prepare_photo_waiting(gif_two_frames(), media::WAIT_MAX)
            .await
            .is_err(),
        "the decoder refuses a moving GIF"
    );

    let refused: Vec<(&str, Vec<u8>, &str, u64)> = vec![
        ("one-frame GIF", gif_one_frame(), "unsupported_format", 0),
        ("animated GIF", gif_two_frames(), "unsupported_format", 0),
        ("SVG", svg(), "unsupported_format", 0),
        ("HTML", html(), "unsupported_format", 0),
        ("PDF", pdf(), "unsupported_format", 0),
        ("HEIC", heic_like(), "unsupported_format", 0),
        ("empty body", Vec::new(), "unsupported_format", 0),
        ("APNG", apng(), "invalid_picture", 1),
        ("animated WebP", webp_animated(), "invalid_picture", 1),
        (
            "PNG signature over garbage",
            png_magic_then_garbage(),
            "invalid_picture",
            1,
        ),
    ];
    for (label, bytes, code, children) in refused {
        let run = fresh_run(&w, &t).await;
        let token = mint_for(&w, &t, run).await;
        let marks = Marks::now();
        let seen = put_declared(&w, t.ws, &token, bytes).await;
        expect_refused(&seen, 422, code);
        assert_eq!(
            marks.children(),
            children,
            "{label}: decoder children started"
        );
        assert!(
            agent_rows(&w, &t).await.is_empty(),
            "{label}: no attachment row"
        );
        assert!(
            w.files.objects().is_empty() && w.files.puts() == 0,
            "{label}: no object"
        );
        assert_eq!(
            token_state(&w, &token).await,
            (true, None),
            "{label}: spent, nothing recorded"
        );
        assert_eq!(
            refused_reason(&w, &t, run).await,
            vec![code.to_string()],
            "{label}"
        );
        assert!(audits(&w, t.ws, "attachment.agent_picture_written")
            .await
            .is_empty());
    }

    // the three still types write
    let stills: Vec<(&str, Vec<u8>, &str)> = vec![
        ("PNG", png_rgba(60, 40, 1), "image/png"),
        ("JPEG", jpeg_rgb(60, 40, 2), "image/jpeg"),
        ("WebP", webp_rgba(60, 40, 3), "image/png"),
    ];
    for (n, (label, bytes, mime)) in stills.into_iter().enumerate() {
        let run = fresh_run(&w, &t).await;
        let token = mint_for(&w, &t, run).await;
        let marks = Marks::now();
        let seen = put(&w, t.ws, &token, bytes).await;
        let (id, answered, _) = expect_201(&seen);
        assert_eq!(answered, mime, "{label}");
        assert_eq!(marks.children(), 1, "{label}: one child");
        assert_eq!(attachment_row(&w, id).await.mime, mime, "{label}");
        assert_eq!(agent_rows(&w, &t).await.len(), n + 1);
    }
    w.assert_no_leak(&[], &logs).await;
}

// --- WA7: bombs ------------------------------------------------------------------------

/// Files that are small and claim a huge picture (4097 wide, 16,004,000 pixels, 2³¹ square), one cut off
/// after its header and one cut in half are `422`; each costs **one decoder child** and the parent opens
/// no picture in its own process — the route's connection to the decoder is the child, never a codec
/// here. (The counters are the parent's own.)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn bombs_are_refused_by_the_child_and_the_parent_decodes_nothing() {
    let (_gate, logs) = begin().await;
    let w = boot().await;
    let t = seed_tenant(&w).await;
    let whole = Marks::now();
    let half = {
        let full = png_rgb(64, 64, 2);
        full[..full.len() / 2].to_vec()
    };
    let bombs: Vec<(&str, Vec<u8>)> = vec![
        ("4097 pixels wide", png_header_only(4097, 1)),
        (
            "4000 × 4001 = 16,004,000 pixels",
            png_header_only(4000, 4001),
        ),
        ("2³¹ × 2³¹", png_header_only(0x7FFF_FFFF, 0x7FFF_FFFF)),
        ("cut off after a sane header", png_header_only(64, 64)),
        ("cut in half", half),
    ];
    for (label, bytes) in bombs {
        assert!(bytes.len() < 100_000, "{label}: the file is small");
        let run = fresh_run(&w, &t).await;
        let token = mint_for(&w, &t, run).await;
        let marks = Marks::now();
        let seen = put(&w, t.ws, &token, bytes).await;
        expect_refused(&seen, 422, "invalid_picture");
        assert_eq!(
            marks.children(),
            1,
            "{label}: the route went through the child"
        );
        assert_eq!(
            marks.in_process(),
            0,
            "{label}: the parent opened nothing itself"
        );
        assert!(
            agent_rows(&w, &t).await.is_empty() && w.files.objects().is_empty(),
            "{label}"
        );
        assert_eq!(
            refused_reason(&w, &t, run).await,
            vec!["invalid_picture"],
            "{label}"
        );
    }
    // a picture that is fine is also decoded by the child only
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    expect_201(&put(&w, t.ws, &token, png_rgba(64, 64, 8)).await);
    assert_eq!(
        whole.children(),
        6,
        "five bombs and one picture: six children"
    );
    assert_eq!(
        whole.in_process(),
        0,
        "…and the parent decoded none of them"
    );
    w.assert_no_leak(&[], &logs).await;
}

// --- WA9: the two decoder slots and the write slots --------------------------------

/// With both decoder slots taken a write waits (about 3 s, `WAIT_MAX`) and is then told `503 busy` —
/// no child, the token already spent. With the two places in line taken a third is told at once. When
/// the slots are free again the two in line are served and the next write goes straight through. A
/// person's own direct upload never queues: it is `Busy` immediately.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_busy_decoder_is_waited_for_a_little_and_a_full_line_is_told_at_once() {
    let (_gate, logs) = begin().await;
    let w = boot().await;
    let t = seed_tenant(&w).await;
    let picture = png_rgba(48, 48, 1);

    // A. both slots taken, nobody else in line
    let held = hold_decoder_slots().await;
    let started = Instant::now();
    assert_eq!(
        media::prepare_photo(picture.clone()).await.err(),
        Some(media::Rejected::Busy),
        "a person's direct upload is refused at once"
    );
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "…and does not queue"
    );
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    let marks = Marks::now();
    let started = Instant::now();
    let seen = put(&w, t.ws, &token, picture.clone()).await;
    let waited = started.elapsed();
    expect_refused(&seen, 503, "busy");
    assert!(
        seen.header("retry-after").is_some(),
        "a busy decoder may be retried"
    );
    assert!(
        waited >= Duration::from_millis(2500) && waited <= Duration::from_millis(6000),
        "waited about WAIT_MAX (3 s), not {waited:?}"
    );
    assert_eq!(marks.children(), 0, "no child without a slot");
    assert_eq!(
        token_state(&w, &token).await,
        (true, None),
        "the caller proved the token: it is spent"
    );
    assert_eq!(refused_reason(&w, &t, run).await, vec!["busy"]);
    assert!(agent_rows(&w, &t).await.is_empty() && w.files.objects().is_empty());
    drop(held);

    // B. two in line, a third told at once; then the slots free and the two in line are served
    let held = hold_decoder_slots().await;
    let mut tokens = Vec::new();
    for _ in 0..3 {
        let run = fresh_run(&w, &t).await;
        tokens.push((run, mint_for(&w, &t, run).await));
    }
    let marks = Marks::now();
    let ((first, second), (third, told_in)) = tokio::join!(
        async {
            tokio::join!(
                put(&w, t.ws, &tokens[0].1, picture.clone()),
                put(&w, t.ws, &tokens[1].1, picture.clone())
            )
        },
        async {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            let started = Instant::now();
            let third = put(&w, t.ws, &tokens[2].1, picture.clone()).await;
            let told_in = started.elapsed();
            drop(held);
            (third, told_in)
        }
    );
    expect_refused(&third, 503, "busy");
    assert!(
        told_in < Duration::from_millis(2000),
        "a full line is told at once, not after a wait: {told_in:?}"
    );
    assert_eq!(first.status, 201, "{}", first.text());
    assert_eq!(second.status, 201, "{}", second.text());
    assert_eq!(
        marks.children(),
        2,
        "only the two that were in line got a child"
    );
    assert_eq!(agent_rows(&w, &t).await.len(), 2);
    assert_eq!(w.files.objects().len(), 2);
    assert_eq!(token_state(&w, &tokens[2].1).await, (true, None));
    assert_eq!(refused_reason(&w, &t, tokens[2].0).await, vec!["busy"]);

    // C. free slots: straight through
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    let started = Instant::now();
    expect_201(&put(&w, t.ws, &token, picture.clone()).await);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "no wait when a slot is free"
    );
    w.assert_no_leak(&[], &logs).await;
}

/// The api serves a fixed number of writes at once. The one beyond it is turned away with `503 busy` and
/// `Retry-After` **before the token is spent**, so the same token writes as soon as a slot frees. (The
/// caller proved nothing yet, so no audit line either.)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_write_slot_gate_answers_503_before_the_token_is_spent() {
    let (_gate, logs) = begin().await;
    let w = boot_with(|state| state.with_agent_media_slots(1)).await;
    let t = seed_tenant(&w).await;
    let token = mint_for(&w, &t, t.run).await;
    let permit = w
        .slots
        .clone()
        .acquire_owned()
        .await
        .expect("the one write slot");
    let marks = Marks::now();
    let started = Instant::now();
    let seen = put(&w, t.ws, &token, png_rgba(40, 40, 2)).await;
    expect_refused(&seen, 503, "busy");
    assert!(seen.header("retry-after").is_some());
    assert!(started.elapsed() < Duration::from_secs(1), "told at once");
    assert_eq!(
        token_state(&w, &token).await,
        (false, None),
        "the token is not spent"
    );
    assert!(audits(&w, t.ws, "attachment.agent_picture_refused")
        .await
        .is_empty());
    assert_eq!(marks.children(), 0);
    drop(permit);
    expect_201(&put(&w, t.ws, &token, png_rgba(40, 40, 2)).await);
    // the slot is given back when the write ends, not kept
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    expect_201(&put(&w, t.ws, &token, png_rgba(40, 40, 3)).await);
    w.assert_no_leak(&[], &logs).await;
}

// --- WA10: the archive and the run end ---------------------------------------------------

async fn write_once(w: &World, t: &Tenant, picture: Vec<u8>) -> (Uuid, String, Seen) {
    let run = fresh_run(w, t).await;
    let token = mint_for(w, t, run).await;
    let seen = put(w, t.ws, &token, picture).await;
    (run, token, seen)
}

/// Whatever fails after the token is spent leaves **no row**, **no object** and **one closed word**:
/// the archive refuses (`502 storage_failed`), the run ends while the picture is decoded or the channel
/// is archived or the requester leaves (`409 run_over`, the object is deleted), the row insert itself
/// fails after the object exists (`500`, the object is deleted).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_failing_archive_or_a_run_that_ends_leaves_no_row_no_object_and_one_closed_word() {
    let (_gate, logs) = begin().await;
    let w = boot().await;
    let t = seed_tenant(&w).await;
    let picture = png_rgba(48, 48, 5);

    // the archive refuses the write
    w.files.set_mode(PutMode::Fails);
    let (run, token, seen) = write_once(&w, &t, picture.clone()).await;
    expect_refused(&seen, 502, "storage_failed");
    assert!(agent_rows(&w, &t).await.is_empty() && w.files.objects().is_empty());
    assert_eq!(w.files.puts(), 1);
    assert_eq!(refused_reason(&w, &t, run).await, vec!["storage_failed"]);
    assert!(audits(&w, t.ws, "attachment.agent_picture_written")
        .await
        .is_empty());
    assert_eq!(token_state(&w, &token).await, (true, None));
    // …and the archive reports it cannot be written to at all
    w.files.set_mode(PutMode::Unavailable);
    let (run, _, seen) = write_once(&w, &t, picture.clone()).await;
    expect_refused(&seen, 503, "drive_not_configured");
    assert!(
        seen.header("retry-after").is_none(),
        "an unconfigured archive is not retried"
    );
    assert_eq!(
        refused_reason(&w, &t, run).await,
        vec!["drive_not_configured"]
    );
    w.files.set_mode(PutMode::Real);

    // the run ends while the picture is decoded (the hook runs once the object exists)
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    w.files.set_after_put(Some(sql_hook(
        &w.su,
        "UPDATE agent_run SET status = 'cancelled'::run_status WHERE id = $1",
        vec![run],
    )));
    let marks = Marks::now();
    let seen = put(&w, t.ws, &token, picture.clone()).await;
    w.files.set_after_put(None);
    expect_refused(&seen, 409, "run_over");
    assert_eq!(
        marks.children(),
        1,
        "the picture was decoded and stored first"
    );
    assert_eq!(w.files.deleted().len(), 1, "the stored object was deleted");
    assert!(
        w.files.objects().is_empty(),
        "…and the archive holds nothing"
    );
    assert!(agent_rows(&w, &t).await.is_empty(), "no row");
    assert_eq!(refused_reason(&w, &t, run).await, vec!["run_over"]);
    assert!(audits(&w, t.ws, "attachment.agent_picture_written")
        .await
        .is_empty());
    assert_eq!(token_state(&w, &token).await, (true, None));

    // the channel is archived mid-flight
    let t2 = seed_tenant(&w).await;
    let token = mint_for(&w, &t2, t2.run).await;
    w.files.set_after_put(Some(sql_hook(
        &w.su,
        "UPDATE channel SET archived_at = now() WHERE id = $1",
        vec![t2.channel],
    )));
    let seen = put(&w, t2.ws, &token, picture.clone()).await;
    w.files.set_after_put(None);
    expect_refused(&seen, 409, "run_over");
    assert_eq!(w.files.deleted().len(), 2);
    assert!(w.files.objects().is_empty() && agent_rows(&w, &t2).await.is_empty());
    assert_eq!(refused_reason(&w, &t2, t2.run).await, vec!["run_over"]);

    // the requester leaves mid-flight
    let t3 = seed_tenant(&w).await;
    let token = mint_for(&w, &t3, t3.run).await;
    w.files.set_after_put(Some(sql_hook(
        &w.su,
        "UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2",
        vec![t3.channel, t3.alice],
    )));
    let seen = put(&w, t3.ws, &token, picture.clone()).await;
    w.files.set_after_put(None);
    expect_refused(&seen, 409, "run_over");
    assert_eq!(w.files.deleted().len(), 3);
    assert!(w.files.objects().is_empty() && agent_rows(&w, &t3).await.is_empty());

    // the row insert itself fails after the object exists: a row already holds that object's id
    let t4 = seed_tenant(&w).await;
    let token = mint_for(&w, &t4, t4.run).await;
    let (su, ws, channel, alice) = (w.su.clone(), t4.ws, t4.channel, t4.alice);
    w.files.set_after_put(Some(Arc::new(move |stored: String| {
        let su = su.clone();
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO attachment (workspace_id, channel_id, uploader_member_id, message_id, \
                 drive_file_id, name, mime, size_bytes, status) \
                 VALUES ($1, $2, $3, NULL, $4, 'decoy', 'image/png', 1, 'complete')",
            )
            .bind(ws)
            .bind(channel)
            .bind(alice)
            .bind(stored)
            .execute(&su)
            .await
            .expect("the colliding row");
        })
    })));
    let seen = put(&w, t4.ws, &token, picture.clone()).await;
    w.files.set_after_put(None);
    assert_eq!(seen.status, 500, "{}", seen.text());
    assert_eq!(seen.json()["error"]["message"], "internal server error");
    for cause in ["attachment_", "duplicate", "unique", "decoy"] {
        assert!(
            !seen.text().contains(cause),
            "the answer names no database cause: {}",
            seen.text()
        );
    }
    assert_eq!(w.files.deleted().len(), 4, "the object was deleted");
    assert!(w.files.objects().is_empty());
    assert!(agent_rows(&w, &t4).await.is_empty(), "no row for the agent");
    assert!(audits(&w, t4.ws, "attachment.agent_picture_written")
        .await
        .is_empty());
    assert_eq!(token_state(&w, &token).await, (true, None));

    // nothing above is sticky: the same archive, healthy again, writes
    let (_, _, seen) = write_once(&w, &t, picture).await;
    expect_201(&seen);
    assert_eq!(w.files.objects().len(), 1);
    w.assert_no_leak(&[], &logs).await;
}

/// An instance with no archive at all (`UnavailableDriveArchive`, the default of an unconfigured api)
/// answers `503 drive_not_configured` — without `Retry-After`, with the token spent and the closed word
/// in the audit line.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn an_instance_with_no_archive_answers_drive_not_configured() {
    let (_gate, logs) = begin().await;
    let w = boot_with(|state| state.with_drive(Arc::new(UnavailableDriveArchive))).await;
    let t = seed_tenant(&w).await;
    let (run, token, seen) = write_once(&w, &t, png_rgba(40, 40, 7)).await;
    expect_refused(&seen, 503, "drive_not_configured");
    assert!(seen.header("retry-after").is_none());
    assert_eq!(token_state(&w, &token).await, (true, None));
    assert_eq!(
        refused_reason(&w, &t, run).await,
        vec!["drive_not_configured"]
    );
    assert!(agent_rows(&w, &t).await.is_empty());
    w.assert_no_leak(&[], &logs).await;
}

// --- WA24: the api's own daily ceiling, and a forged world ----------------------------------

/// The api counts, for itself, the **marks** (`agent_picture_mark`, #5530) of this workspace from the last
/// 24 hours: one per picture the api wrote for an agent. At the ceiling a write is `429 cap_reached`: the
/// object that was stored is deleted, nothing is written, one audit line says why. It is per workspace and
/// counts nothing but recent marks — an agent's `complete` attachment row that no write made is not one — and
/// a worker that forges whole runs with the BYPASSRLS role is held to the slot limit (slot 2 is a `404`) and
/// then to the same ceiling, which it cannot talk down by deleting the attachment its picture became.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_daily_ceiling_is_counted_by_the_api_and_a_forged_world_meets_it_too() {
    let (_gate, logs) = begin().await;
    let w = boot_with(|state| state.with_agent_media_daily_ceiling(1)).await;
    let picture = png_rgba(48, 48, 6);

    // the first write of the day passes; the second, in the same workspace, does not
    let t = seed_tenant(&w).await;
    let (_, _, first) = write_once(&w, &t, picture.clone()).await;
    expect_201(&first);
    let (run, token, seen) = write_once(&w, &t, picture.clone()).await;
    expect_refused(&seen, 429, "cap_reached");
    assert_eq!(w.files.puts(), 2, "the second picture was stored…");
    assert_eq!(w.files.deleted().len(), 1, "…and deleted again");
    assert_eq!(w.files.objects().len(), 1, "the object count did not grow");
    assert_eq!(agent_rows(&w, &t).await.len(), 1, "no second row");
    assert_eq!(refused_reason(&w, &t, run).await, vec!["cap_reached"]);
    assert_eq!(
        audits(&w, t.ws, "attachment.agent_picture_written")
            .await
            .len(),
        1
    );
    assert_eq!(token_state(&w, &token).await, (true, None));

    // per workspace: another workspace is at zero
    let other = seed_tenant(&w).await;
    expect_201(&write_once(&w, &other, picture.clone()).await.2);

    // only a mark of the last day counts (#5530). Attachment rows of every kind are not what the api counts:
    // a person's upload, a failed one, an old agent row — and an agent's complete row from today that no
    // write of the api made (the old source counted it and would refuse this workspace's first picture)
    let counted = seed_tenant(&w).await;
    for (uploader, status, age, drive_file) in [
        (counted.alice, "complete", "0 seconds", Some("human")),
        (counted.agent, "failed", "0 seconds", None),
        (counted.agent, "complete", "2 days", Some("old")),
        (counted.agent, "complete", "0 seconds", Some("agent-today")),
    ] {
        sqlx::query(&format!(
            "INSERT INTO attachment (workspace_id, channel_id, uploader_member_id, message_id, \
             drive_file_id, name, mime, size_bytes, status, created_at) \
             VALUES ($1, $2, $3, NULL, $4, 'x', 'image/png', 1, $5, now() - interval '{age}')"
        ))
        .bind(counted.ws)
        .bind(counted.channel)
        .bind(uploader)
        .bind(drive_file.map(|name| format!("seed-{name}-{}", Uuid::new_v4())))
        .bind(status)
        .execute(&w.su)
        .await
        .unwrap();
    }
    seed_mark_row(&w, counted.ws, "2 days").await; // a mark two days old is outside the window
    let (_, _, seen) = write_once(&w, &counted, picture.clone()).await;
    assert_eq!(
        seen.status,
        201,
        "no attachment row and no old mark is today's count: {}",
        seen.text()
    );
    // that write made its own mark, so the next one meets the ceiling
    let (_, _, seen) = write_once(&w, &counted, picture.clone()).await;
    expect_refused(&seen, 429, "cap_reached");

    // a mark of today is what counts, wherever it came from: seeded directly, the first write is the cap
    let marked = seed_tenant(&w).await;
    seed_mark_row(&w, marked.ws, "1 hour").await;
    let (_, _, seen) = write_once(&w, &marked, picture.clone()).await;
    expect_refused(&seen, 429, "cap_reached");

    // a forged world, written by the worker's own (BYPASSRLS) role: an agent, its membership, a trigger
    // message and a run — and tokens
    let victim = seed_tenant(&w).await;
    let (ws, channel) = (victim.ws, victim.channel);
    let forged_agent = seed_member(&w.worker, ws, "agent").await;
    sqlx::query("INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)")
        .bind(ws)
        .bind(channel)
        .bind(forged_agent)
        .execute(&w.worker)
        .await
        .unwrap();
    let trigger = seed_message(&w.worker, ws, channel, victim.alice).await;
    let forged_run = seed_run(&w.worker, ws, channel, forged_agent, trigger).await;
    let beyond = forge_token(&w, ws, forged_run, forged_agent, 2).await;
    let seen = put(&w, ws, &beyond, picture.clone()).await;
    assert_eq!(
        seen.status,
        404,
        "slot 2 is beyond the run's limit: {}",
        seen.text()
    );
    assert_eq!(token_state(&w, &beyond).await, (false, None));
    // (control: the forgery is otherwise good — slot 1 writes, as the forged agent, in the run's channel)
    let within = forge_token(
        &w,
        ws,
        trigger_run_slot(&w, ws, channel, forged_agent, victim.alice).await,
        forged_agent,
        1,
    )
    .await;
    let (id, _, _) = expect_201(&put(&w, ws, &within, picture.clone()).await);
    let row = attachment_row(&w, id).await;
    assert_eq!((row.uploader, row.channel_id), (forged_agent, channel));
    // …the worker's own role (it may DELETE and UPDATE `attachment`) deletes the row its picture became — what
    // used to bring the count back to zero (#5530; the other ways, `member.kind` and the parents' deletes, are
    // `agent_picture_pg`'s fifteen attempts: a run whose agent seat holds a person is refused at the spend, so
    // it cannot be done here and still reach the ceiling)…
    sqlx::query("DELETE FROM attachment WHERE id = $1")
        .bind(id)
        .execute(&w.worker)
        .await
        .expect("the worker may delete an attachment row");
    // …and the next forged run meets the api's ceiling all the same
    let run = trigger_run_slot(&w, ws, channel, forged_agent, victim.alice).await;
    let again = forge_token(&w, ws, run, forged_agent, 1).await;
    let before = w.files.objects().len();
    let seen = put(&w, ws, &again, picture).await;
    expect_refused(&seen, 429, "cap_reached");
    assert_eq!(
        w.files.objects().len(),
        before,
        "the object count did not grow"
    );
    w.assert_no_leak(&[], &logs).await;
}

/// A new forged run for `agent` (the worker's role writes the trigger message and the run).
async fn trigger_run_slot(
    w: &World,
    ws: Uuid,
    channel: Uuid,
    agent: Uuid,
    requester: Uuid,
) -> Uuid {
    let trigger = seed_message(&w.worker, ws, channel, requester).await;
    seed_run(&w.worker, ws, channel, agent, trigger).await
}

// --- WA19: the refusal budget -------------------------------------------------------------------

fn tight_budget(w: impl FnOnce(AppState) -> AppState) -> impl FnOnce(AppState) -> AppState {
    move |state| {
        w(state.with_rate_limit(RateLimitConfig {
            self_media_per_workspace_limit: 3,
            ..RateLimitConfig::default()
        }))
    }
}

/// Only the route's own `404` (a refusal that depends on the token) spends the caller's budget — a
/// `411`, a `413`, a `405`, a write-slot `503`, a decoder `503`, a `422` and a `201` spend nothing — and
/// once it is spent the next request is `429` **before the handler**, so a live token is not even spent.
/// A request with no address is charged to nobody.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_refusal_budget_is_spent_only_by_the_routes_own_404() {
    let (_gate, logs) = begin().await;
    let w = boot_with(tight_budget(|state| state)).await;
    let t = seed_tenant(&w).await;
    let picture = png_rgba(40, 40, 2);
    let bad = address(t.ws, &made_up_token());

    // 411 and 413 are answered from the head
    for _ in 0..4 {
        let missing = raw(w.addr, &bad, &[], vec![], PROMPT)
            .await
            .expect("an answer");
        assert_eq!(missing.status, 411);
        let over = raw(w.addr, &bad, &length(FIVE_MIB + 1), vec![], PROMPT)
            .await
            .expect("an answer");
        assert_eq!(over.status, 413);
    }
    // every method but PUT is a 405 from the router, before the budget layer
    for _ in 0..2 {
        for method in [
            reqwest::Method::GET,
            reqwest::Method::POST,
            reqwest::Method::DELETE,
            reqwest::Method::HEAD,
            reqwest::Method::PATCH,
            reqwest::Method::OPTIONS,
        ] {
            let seen = send_method(&w, method.clone(), &bad, RAW_IP).await;
            assert_eq!(seen.status, 405, "{method}");
            assert_eq!(seen.header("allow"), Some("PUT"), "{method}");
        }
    }
    // the write-slot gate: 503 for a live token, which stays unspent
    let run = fresh_run(&w, &t).await;
    let live = mint_for(&w, &t, run).await;
    let all_slots = w
        .slots
        .clone()
        .acquire_many_owned(4)
        .await
        .expect("the write slots");
    for _ in 0..2 {
        let seen = put_from(&w, RAW_IP, t.ws, &live, picture.clone()).await;
        expect_refused(&seen, 503, "busy");
    }
    drop(all_slots);
    assert_eq!(token_state(&w, &live).await, (false, None));
    // the decoder 503 (after the spend)
    let held = hold_decoder_slots().await;
    let seen = put_from(&w, RAW_IP, t.ws, &live, picture.clone()).await;
    expect_refused(&seen, 503, "busy");
    drop(held);
    // 422 three times, 201 three times
    for _ in 0..3 {
        let run = fresh_run(&w, &t).await;
        let token = mint_for(&w, &t, run).await;
        let seen = put_from(&w, RAW_IP, t.ws, &token, gif_one_frame()).await;
        expect_refused(&seen, 422, "unsupported_format");
    }
    for n in 0..3u32 {
        let run = fresh_run(&w, &t).await;
        let token = mint_for(&w, &t, run).await;
        expect_201(&put_from(&w, RAW_IP, t.ws, &token, png_rgba(40, 40, 20 + n)).await);
    }

    // the budget (3) is whole: exactly three 404s, then 429 with Retry-After
    let mut statuses = Vec::new();
    for _ in 0..5 {
        statuses.push(
            put_from(&w, RAW_IP, t.ws, &made_up_token(), picture.clone())
                .await
                .status,
        );
    }
    assert_eq!(
        statuses,
        [404, 404, 404, 429, 429],
        "only refusals spent it"
    );
    let run = fresh_run(&w, &t).await;
    let live = mint_for(&w, &t, run).await;
    let blocked = put_from(&w, RAW_IP, t.ws, &live, picture.clone()).await;
    assert_eq!(blocked.status, 429);
    assert!(blocked.header("retry-after").is_some());
    assert_eq!(
        token_state(&w, &live).await,
        (false, None),
        "turned away before the handler: the live token is not spent"
    );
    // another address and another workspace have their own budgets
    assert_eq!(
        put_from(&w, "198.51.100.62", t.ws, &made_up_token(), picture.clone())
            .await
            .status,
        404
    );
    let other = seed_tenant(&w).await;
    assert_eq!(
        put_from(&w, RAW_IP, other.ws, &made_up_token(), picture.clone())
            .await
            .status,
        404
    );
    // no address, no charge
    for _ in 0..6 {
        assert_eq!(
            put(&w, t.ws, &made_up_token(), picture.clone())
                .await
                .status,
            404
        );
    }
    w.assert_no_leak(&[], &logs).await;
}

/// The write route's budget and the read route's are two buckets (per address and workspace, and the
/// address-wide ceiling above them): spending the read route's budget leaves the write route whole and
/// the other way round, and rotating the workspace in the path does not walk around the limit.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_write_budget_and_the_read_budget_are_two_buckets() {
    let (_gate, _logs) = begin().await;
    let w = boot_with(tight_budget(|state| state)).await;
    let ws = Uuid::new_v4();
    let read = |ws: Uuid| format!("/v1/self-media/{ws}/{}", "N".repeat(43));
    let body = vec![0x89u8, b'P', b'N', b'G'];

    // address A: the read budget is spent; the write budget is whole
    let a = "198.51.100.71";
    let mut reads = Vec::new();
    for _ in 0..4 {
        reads.push(
            send_method(&w, reqwest::Method::GET, &read(ws), a)
                .await
                .status,
        );
    }
    assert_eq!(reads, [404, 404, 404, 429]);
    let mut writes = Vec::new();
    for _ in 0..4 {
        writes.push(
            put_from(&w, a, ws, &made_up_token(), body.clone())
                .await
                .status,
        );
    }
    assert_eq!(
        writes,
        [404, 404, 404, 429],
        "a spent read budget left the write budget whole"
    );

    // address B: the other way round
    let b = "198.51.100.72";
    let mut writes = Vec::new();
    for _ in 0..4 {
        writes.push(
            put_from(&w, b, ws, &made_up_token(), body.clone())
                .await
                .status,
        );
    }
    assert_eq!(writes, [404, 404, 404, 429]);
    let mut reads = Vec::new();
    for _ in 0..4 {
        reads.push(
            send_method(&w, reqwest::Method::GET, &read(ws), b)
                .await
                .status,
        );
    }
    assert_eq!(
        reads,
        [404, 404, 404, 429],
        "a spent write budget left the read budget whole"
    );

    // address C: a different workspace every time still runs out, at ten times the per-workspace number
    let c = "198.51.100.73";
    let mut statuses = Vec::new();
    for _ in 0..34 {
        statuses.push(
            put_from(&w, c, Uuid::new_v4(), &made_up_token(), body.clone())
                .await
                .status,
        );
    }
    let not_found = statuses.iter().filter(|status| **status == 404).count();
    assert!(
        (30..=31).contains(&not_found),
        "the address-wide ceiling (3 × 10) is the limit, not never: {statuses:?}"
    );
    assert_eq!(statuses.last(), Some(&429));
    // …and it is the write ceiling: the read route from the same address still answers its own 404
    assert_eq!(
        send_method(&w, reqwest::Method::GET, &read(Uuid::new_v4()), c)
            .await
            .status,
        404
    );
}

// --- WA15: nothing leaks, on any road -------------------------------------------------------------

/// A tour through the success and **every** failure road the route has — with hostile request metadata
/// on every request and pictures carrying planted markers — and then one scan: no tracing line, audit
/// row, outbox payload, run `error`, message `props`, attachment row or response body holds a token, the
/// `agent-media/` path, a marker from the input, the hostile `Content-Type` or the hostile file name; the
/// token table holds each token's SHA-256 and nothing else. (The scan is not vacuous: it insists it saw
/// rows and the database's own log lines.)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn no_token_path_byte_or_content_type_survives_any_outcome() {
    let (_gate, logs) = begin().await;
    let w = boot_with(|state| state.with_agent_media_daily_ceiling(2)).await;
    let t = seed_tenant(&w).await;
    let hostile_type = format!("text/html; charset={HOSTILE}");
    let disposition = format!("attachment; filename=\"{HOSTILE_NAME}\"");
    let lie_channel = t.other_channel.to_string();
    let mut answers: Vec<(&str, Seen)> = Vec::new();

    async fn tour_put(
        w: &World,
        t: &Tenant,
        token: &str,
        hostile_type: &str,
        disposition: &str,
        lie_channel: &str,
        bytes: Vec<u8>,
    ) -> Seen {
        let path = format!(
            "{}?channel={lie_channel}&name={HOSTILE_NAME}",
            address(t.ws, token)
        );
        put_with(
            w,
            &path,
            &[
                ("content-type", hostile_type),
                ("content-disposition", disposition),
                ("x-channel", lie_channel),
                ("x-file-name", HOSTILE_NAME),
            ],
            bytes,
        )
        .await
    }

    // two successes with marker-laden pictures (the ceiling is two)
    for (label, bytes) in [
        (
            "success: JPEG with EXIF, comment, tail",
            jpeg_with_metadata(&two_halves_jpeg(400, 300), 6),
        ),
        (
            "success: PNG with text, EXIF, tail",
            png_with_metadata(&png_rgba(100, 100, 3)),
        ),
    ] {
        let run = fresh_run(&w, &t).await;
        let token = mint_for(&w, &t, run).await;
        let seen = tour_put(
            &w,
            &t,
            &token,
            &hostile_type,
            &disposition,
            &lie_channel,
            bytes,
        )
        .await;
        expect_201(&seen);
        answers.push((label, seen));
    }
    let doomed = png_with_metadata(&png_rgba(60, 60, 4));
    macro_rules! tour {
        ($label:expr, $bytes:expr, $status:expr, $code:expr) => {{
            let run = fresh_run(&w, &t).await;
            let token = mint_for(&w, &t, run).await;
            let seen = tour_put(
                &w,
                &t,
                &token,
                &hostile_type,
                &disposition,
                &lie_channel,
                $bytes,
            )
            .await;
            expect_refused(&seen, $status, $code);
            answers.push(($label, seen));
            (run, token)
        }};
    }
    // a refusal that depends on the token
    answers.push((
        "bad token",
        put_with(
            &w,
            &format!("{}?channel={lie_channel}", address(t.ws, &made_up_token())),
            &[("content-type", hostile_type.as_str())],
            doomed.clone(),
        )
        .await,
    ));
    // the format roads
    tour!(
        "unsupported format",
        gif_one_frame(),
        422,
        "unsupported_format"
    );
    tour!("invalid picture", apng(), 422, "invalid_picture");
    // the ceiling (two pictures are already written today)
    tour!("cap reached", doomed.clone(), 429, "cap_reached");
    // the archive roads
    w.files.set_mode(PutMode::Fails);
    tour!("storage failed", doomed.clone(), 502, "storage_failed");
    w.files.set_mode(PutMode::Unavailable);
    tour!("no archive", doomed.clone(), 503, "drive_not_configured");
    w.files.set_mode(PutMode::Real);
    // the run ends while the picture is decoded
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    w.files.set_after_put(Some(sql_hook(
        &w.su,
        "UPDATE agent_run SET status = 'cancelled'::run_status WHERE id = $1",
        vec![run],
    )));
    let seen = tour_put(
        &w,
        &t,
        &token,
        &hostile_type,
        &disposition,
        &lie_channel,
        doomed.clone(),
    )
    .await;
    w.files.set_after_put(None);
    expect_refused(&seen, 409, "run_over");
    answers.push(("run over", seen));
    // the row insert fails (in a fresh workspace: the ceiling of two is read before the insert)
    let fresh = seed_tenant(&w).await;
    let token_fresh = mint_for(&w, &fresh, fresh.run).await;
    let (su, ws, channel, alice) = (w.su.clone(), fresh.ws, fresh.channel, fresh.alice);
    w.files.set_after_put(Some(Arc::new(move |stored: String| {
        let su = su.clone();
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO attachment (workspace_id, channel_id, uploader_member_id, message_id, \
                 drive_file_id, name, mime, size_bytes, status) \
                 VALUES ($1, $2, $3, NULL, $4, 'decoy', 'image/png', 1, 'complete')",
            )
            .bind(ws)
            .bind(channel)
            .bind(alice)
            .bind(stored)
            .execute(&su)
            .await
            .expect("the colliding row");
        })
    })));
    let seen = tour_put(
        &w,
        &fresh,
        &token_fresh,
        &hostile_type,
        &disposition,
        &lie_channel,
        doomed.clone(),
    )
    .await;
    w.files.set_after_put(None);
    assert_eq!(seen.status, 500);
    answers.push(("row insert fails", seen));
    // the decoder is busy (the slow road)
    let held = hold_decoder_slots().await;
    tour!("decoder busy", doomed.clone(), 503, "busy");
    drop(held);
    // the write slots are full
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    let all_slots = w
        .slots
        .clone()
        .acquire_many_owned(4)
        .await
        .expect("the write slots");
    let seen = tour_put(
        &w,
        &t,
        &token,
        &hostile_type,
        &disposition,
        &lie_channel,
        doomed.clone(),
    )
    .await;
    drop(all_slots);
    expect_refused(&seen, 503, "busy");
    answers.push(("write slots full", seen));
    // the length roads
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    let path = address(t.ws, &token);
    let heads = [
        ("Content-Type", hostile_type.clone()),
        ("Content-Disposition", disposition.clone()),
    ];
    let missing = raw(w.addr, &path, &heads, vec![], PROMPT)
        .await
        .expect("an answer");
    assert_eq!(missing.status, 411);
    let mut over = length(FIVE_MIB + 1);
    over.extend(heads.iter().cloned());
    let over = raw(w.addr, &path, &over, vec![], PROMPT)
        .await
        .expect("an answer");
    assert_eq!(over.status, 413);
    let mut short = length(doomed.len());
    short.extend(heads.iter().cloned());
    let short = raw(
        w.addr,
        &path,
        &short,
        vec![
            Step::Send(doomed[..doomed.len() - 50].to_vec()),
            Step::HalfClose,
        ],
        PROMPT,
    )
    .await
    .expect("an answer");
    assert_eq!(short.status, 400);
    for (label, raw) in [
        ("no length", missing),
        ("too long", over),
        ("short body", short),
    ] {
        answers.push((label, raw.into_seen()));
    }

    // the scan
    let mut needles: Vec<String> = MARKERS.iter().map(|marker| marker.to_string()).collect();
    needles.extend([
        HOSTILE.to_string(),
        HOSTILE_NAME.to_string(),
        hostile_type.clone(),
        "agent-media/".to_string(),
    ]);
    for (label, seen) in &answers {
        let text = seen.text();
        for needle in &needles {
            assert!(
                !text.contains(needle.as_str()),
                "{label}: the answer holds `{needle}`: {text}"
            );
        }
        for (name, value) in &seen.headers {
            for needle in &needles {
                assert!(
                    !value.contains(needle.as_str()),
                    "{label}: header {name} holds `{needle}`"
                );
            }
        }
    }
    assert!(
        answers.len() >= 14,
        "the tour covered {} roads",
        answers.len()
    );
    let extra: Vec<&str> = needles.iter().map(String::as_str).collect();
    w.assert_no_leak(&extra, &logs).await;
}

// --- WA16 / WA12 / WA13 / WA17: the worker, end to end ---------------------------------------------

async fn answer_message(
    w: &World,
    t: &Tenant,
    run: Uuid,
    reply_to: Option<Uuid>,
    body: &str,
) -> NewMessage {
    let _ = w;
    NewMessage {
        channel_id: t.channel,
        author_member_id: t.agent,
        message_type: MessageType::Text,
        body: Some(body.to_string()),
        props: json!({ "run_id": run }),
        root_id: None,
        reply_to_id: reply_to,
        client_msg_id: Some(run),
        run_id: Some(run),
        hlc_ts: None,
        hlc_count: None,
    }
}

/// The answer the helper posts, in the worker's own transaction.
async fn post_answer(w: &World, ws: Uuid, input: NewMessage) -> momo_messaging::SentMessage {
    with_tenant_tx(&w.worker, ws, move |conn| {
        Box::pin(async move {
            send_answer_with_run_pictures_in_tx(conn, ws, input)
                .await
                .map(|posted| posted.sent)
        })
    })
    .await
    .expect("the answer")
}

/// The `message.new` payloads the outbox holds for one message.
async fn message_new_payloads(w: &World, ws: Uuid, message: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload FROM outbox WHERE workspace_id = $1 \
            AND payload->'data'->>'type' = 'message.new' AND payload->'data'->'payload'->>'id' = $2",
    )
    .bind(ws)
    .bind(message.to_string())
    .fetch_all(&w.su)
    .await
    .unwrap()
}

/// The real `PictureWriter` writes a real picture through the real router, and the answer is then posted
/// in **one** message that carries it (the attachment is bound, and the `message.new` payload shows it).
/// A retried answer binds nothing twice; a run that wrote no picture, and a picture another run wrote,
/// are not bound; and when the binding is refused the answer goes out once, without the picture and with
/// the one fixed sentence — no second message, no half-bound state, no hole in the channel's sequence.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_worker_writes_a_real_picture_through_the_real_router_and_posts_one_answer_with_it() {
    let (_gate, logs) = begin().await;
    let w = boot().await;
    let t = seed_tenant(&w).await;
    let writer = PictureWriter::new(Some(&w.base)).expect("a private origin");
    let input = png_rgba(80, 60, 7);

    // A. the write: one request, the row and the object the response names
    let before = w.requests().len();
    let written: WrittenPicture = writer
        .write(&w.worker, t.ws, t.run, t.agent, input.clone())
        .await
        .expect("a picture written");
    let sent_requests = w.requests();
    assert_eq!(sent_requests.len(), before + 1, "one request, once");
    assert!(sent_requests[before].starts_with(&format!("PUT /v1/agent-media/{}/", t.ws)));
    let row = attachment_row(&w, written.attachment_id).await;
    assert_eq!((row.uploader, row.channel_id), (t.agent, t.channel));
    assert_eq!((row.status.as_str(), row.message_id), ("complete", None));
    assert_eq!(written.mime, row.mime);
    assert_eq!(written.size_bytes, row.size_bytes);
    assert_eq!(
        w.files.read(&row.drive_file_id).await.len() as i64,
        written.size_bytes
    );
    // the run's one slot is used: a second write makes no token and no request
    assert_eq!(
        writer
            .write(&w.worker, t.ws, t.run, t.agent, input.clone())
            .await
            .err(),
        Some(PictureRefusal::NoToken)
    );
    assert_eq!(w.requests().len(), before + 1);
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM attachment_write_token WHERE workspace_id = $1",
            t.ws
        )
        .await,
        1
    );

    // B. the answer: exactly one message from the agent, with the attachment bound and projected
    let answer = answer_message(&w, &t, t.run, Some(t.trigger), "Here is your picture").await;
    let sent = post_answer(&w, t.ws, answer.clone()).await;
    assert!(!sent.deduped);
    assert_eq!(sent.message.body.as_deref(), Some("Here is your picture"));
    assert_eq!(sent.attachments.len(), 1);
    assert_eq!(sent.attachments[0].id, written.attachment_id.to_string());
    assert_eq!(
        count(&w, "SELECT count(*) FROM message WHERE workspace_id = $1 AND author_member_id IN (SELECT id FROM member WHERE kind = 'agent')", t.ws).await,
        1,
        "exactly one message from the agent"
    );
    assert_eq!(
        attachment_row(&w, written.attachment_id).await.message_id,
        Some(sent.message.id)
    );
    let payloads = message_new_payloads(&w, t.ws, sent.message.id).await;
    assert_eq!(payloads.len(), 1, "one `message.new` for the answer");
    let attached = &payloads[0]["data"]["payload"]["attachments"];
    assert_eq!(
        attached.as_array().map(Vec::len),
        Some(1),
        "the broadcast carries the picture: {}",
        payloads[0]
    );
    assert_eq!(attached[0]["id"], written.attachment_id.to_string());
    // a retry (`client_msg_id` = the run) is the same message and binds nothing again
    let again = post_answer(&w, t.ws, answer).await;
    assert!(again.deduped);
    assert_eq!(again.message.id, sent.message.id);
    assert_eq!(
        message_new_payloads(&w, t.ws, sent.message.id).await.len(),
        1
    );
    assert_eq!(
        attachment_row(&w, written.attachment_id).await.message_id,
        Some(sent.message.id)
    );

    // C. a run that wrote nothing posts a plain answer, and does not pick up another run's picture
    let other_run = fresh_run(&w, &t).await;
    let stray = writer
        .write(&w.worker, t.ws, other_run, t.agent, png_rgba(40, 40, 8))
        .await
        .expect("another run's picture");
    let quiet_run = fresh_run(&w, &t).await;
    let plain = post_answer(
        &w,
        t.ws,
        answer_message(&w, &t, quiet_run, None, "No picture this time").await,
    )
    .await;
    assert_eq!(plain.message.body.as_deref(), Some("No picture this time"));
    assert!(plain.attachments.is_empty());
    assert_eq!(
        attachment_row(&w, stray.attachment_id).await.message_id,
        None,
        "a picture another run wrote, unbound, in the same channel by the same agent, is not bound by this answer"
    );

    // D. the binding is refused (the picture is moved to another conversation before the answer): one
    //    message, without the picture, with the fixed sentence — and nothing half-done
    let run = fresh_run(&w, &t).await;
    let moved = writer
        .write(&w.worker, t.ws, run, t.agent, png_rgba(40, 40, 9))
        .await
        .expect("a picture to be refused");
    sqlx::query("UPDATE attachment SET channel_id = $2 WHERE id = $1")
        .bind(moved.attachment_id)
        .bind(t.other_channel)
        .execute(&w.su)
        .await
        .unwrap();
    let seq_before: i64 =
        sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(t.channel)
            .fetch_one(&w.su)
            .await
            .unwrap();
    let refused = post_answer(
        &w,
        t.ws,
        answer_message(&w, &t, run, None, "The second picture").await,
    )
    .await;
    let body = refused.message.body.clone().expect("a body");
    assert!(body.starts_with("The second picture"), "{body}");
    assert!(body.ends_with(PICTURE_UPLOAD_FAILED_SENTENCE), "{body}");
    assert!(refused.attachments.is_empty());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM message WHERE workspace_id = $1 AND client_msg_id = $2"
        )
        .bind(t.ws)
        .bind(run)
        .fetch_one(&w.su)
        .await
        .unwrap(),
        1,
        "exactly one message for the run: the first attempt was taken back"
    );
    assert_eq!(
        attachment_row(&w, moved.attachment_id).await.message_id,
        None,
        "nothing bound"
    );
    let seq_after: i64 =
        sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(t.channel)
            .fetch_one(&w.su)
            .await
            .unwrap();
    assert_eq!(
        seq_after,
        seq_before + 1,
        "one message took one sequence number"
    );
    let payloads = message_new_payloads(&w, t.ws, refused.message.id).await;
    assert_eq!(payloads.len(), 1);
    assert!(
        payloads[0]["data"]["payload"].get("attachments").is_none(),
        "the broadcast promised no picture: {}",
        payloads[0]
    );

    w.adopt_requested_tokens().await;
    w.assert_no_leak(&[], &logs).await;
}

/// A stub that is not the api: it records every request head, then either hangs up without a word or
/// answers `response` byte for byte.
async fn stub(response: Option<Vec<u8>>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let heads = Arc::new(Mutex::new(Vec::new()));
    let kept = heads.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let (kept, response) = (kept.clone(), response.clone());
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 16 * 1024];
                let read = socket.read(&mut buffer).await.unwrap_or(0);
                kept.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buffer[..read]).into_owned());
                if let Some(response) = response {
                    let _ = socket.write_all(&response).await;
                    let _ = socket.shutdown().await;
                }
            });
        }
    });
    (origin, heads)
}

fn status_only(status: &str) -> Option<Vec<u8>> {
    Some(
        format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").into_bytes(),
    )
}

/// The worker refuses, before it mints anything, what the api would refuse (more than 5 MiB, a GIF,
/// nothing at all: no token row, no request); is closed without a private origin; follows no redirect
/// (the second server sees nothing); tries exactly once (one request, one token row, no second attempt);
/// and its log line names the kind of failure and none of the address.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_worker_refuses_what_the_api_would_refuse_follows_no_redirect_and_tries_once() {
    let (_gate, logs) = begin().await;
    let w = boot().await;
    let t = seed_tenant(&w).await;
    assert!(
        PictureWriter::new(None).is_none(),
        "no private origin, no write path"
    );
    assert!(PictureWriter::new(Some("not an origin")).is_none());
    let writer = PictureWriter::new(Some(&w.base)).expect("a private origin");

    // pre-refusals: no token, no request
    let before = w.requests().len();
    for (label, bytes, want) in [
        (
            "5 MiB + 1",
            padded(b"\x89PNG\r\n\x1a\n".to_vec(), FIVE_MIB + 1),
            PictureRefusal::TooLarge,
        ),
        ("a GIF", gif_one_frame(), PictureRefusal::NotAPicture),
        ("nothing", Vec::new(), PictureRefusal::NotAPicture),
    ] {
        assert_eq!(
            writer
                .write(&w.worker, t.ws, t.run, t.agent, bytes)
                .await
                .err(),
            Some(want),
            "{label}"
        );
    }
    assert_eq!(w.requests().len(), before, "no request reached the api");
    let tokens = "SELECT count(*) FROM attachment_write_token WHERE workspace_id = $1";
    assert_eq!(count(&w, tokens, t.ws).await, 0, "no token was minted");
    // no token: the run is over
    let ended = fresh_run(&w, &t).await;
    set_run_status(&w, ended, "cancelled").await;
    assert_eq!(
        writer
            .write(&w.worker, t.ws, ended, t.agent, png_rgba(40, 40, 1))
            .await
            .err(),
        Some(PictureRefusal::NoToken)
    );
    assert_eq!(w.requests().len(), before);
    assert_eq!(count(&w, tokens, t.ws).await, 0);

    // a redirect is an answer, not a place to go
    let (elsewhere, elsewhere_heads) = stub(status_only("200 OK")).await;
    let redirect = format!(
        "HTTP/1.1 302 Found\r\nlocation: {elsewhere}/stolen\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
    );
    let (origin, heads) = stub(Some(redirect.into_bytes())).await;
    let run = fresh_run(&w, &t).await;
    let redirected = PictureWriter::new(Some(&origin)).unwrap();
    let result = redirected
        .write(&w.worker, t.ws, run, t.agent, png_rgba(40, 40, 2))
        .await;
    assert_eq!(
        result,
        Err(PictureRefusal::Failed("status")),
        "a 302 is an answer that is not a picture"
    );
    assert_eq!(
        heads.lock().unwrap().len(),
        1,
        "the redirecting server was asked once"
    );
    assert_eq!(
        elsewhere_heads.lock().unwrap().len(),
        0,
        "…and the worker never went where it pointed"
    );
    // tried once: one token row for the run, and a second write finds no slot
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM attachment_write_token WHERE run_id = $1",
            run
        )
        .await,
        1
    );
    assert_eq!(
        redirected
            .write(&w.worker, t.ws, run, t.agent, png_rgba(40, 40, 2))
            .await
            .err(),
        Some(PictureRefusal::NoToken)
    );
    assert_eq!(heads.lock().unwrap().len(), 1, "no second attempt");

    // the api answers with a status or hangs up: one fixed word each, and a log line without the address
    let mut seen_tokens = Vec::new();
    for (status, word) in [
        (status_only("404 Not Found"), "refused"),
        (status_only("500 Internal Server Error"), "status"),
        (status_only("503 Service Unavailable"), "busy"),
        (None, "request"),
    ] {
        let (origin, heads) = stub(status).await;
        let run = fresh_run(&w, &t).await;
        let result = PictureWriter::new(Some(&origin))
            .unwrap()
            .write(&w.worker, t.ws, run, t.agent, png_rgba(40, 40, 3))
            .await;
        assert_eq!(result, Err(PictureRefusal::Failed(word)));
        let heads = heads.lock().unwrap().clone();
        assert_eq!(heads.len(), 1, "{word}: one request");
        let request_line = heads[0].lines().next().unwrap().to_string();
        let token = request_line
            .strip_prefix(&format!("PUT /v1/agent-media/{}/", t.ws))
            .and_then(|rest| rest.strip_suffix(" HTTP/1.1"))
            .unwrap_or_else(|| panic!("the request line is the fixed shape: {request_line}"))
            .to_string();
        assert_eq!(token.len(), 43);
        let lowered = heads[0].to_ascii_lowercase();
        for header in ["authorization", "cookie", "x-api-key", "proxy-"] {
            assert!(
                !lowered.contains(header),
                "the worker sent `{header}`: {}",
                heads[0]
            );
        }
        // the worker's own line: found by the run it names; it says what kind and holds none of the address
        let run_text = run.to_string();
        let ours: Vec<String> = logs
            .text()
            .lines()
            .filter(|line| line.contains("agent picture:") && line.contains(&run_text))
            .map(str::to_string)
            .collect();
        assert_eq!(
            ours.len(),
            1,
            "{word}: one line an operator can read: {ours:?}"
        );
        let ws_text = t.ws.to_string();
        let peer = origin.strip_prefix("http://").unwrap();
        for needle in [
            origin.as_str(),
            peer,
            ws_text.as_str(),
            "/v1/",
            "agent-media",
            token.as_str(),
        ] {
            assert!(
                !ours[0].contains(needle),
                "{word}: the line holds `{needle}`: {}",
                ours[0]
            );
        }
        assert!(
            ours[0].contains(&format!("cause={word}"))
                || word == "request"
                || word == "busy"
                || word == "refused"
                || word == "status",
            "{}",
            ours[0]
        );
        seen_tokens.push(token);
    }
    // an address that nothing listens on: the connection itself fails
    let dead = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let run = fresh_run(&w, &t).await;
    assert_eq!(
        PictureWriter::new(Some(&dead))
            .unwrap()
            .write(&w.worker, t.ws, run, t.agent, png_rgba(40, 40, 4))
            .await,
        Err(PictureRefusal::Failed("connect"))
    );

    let extra: Vec<&str> = seen_tokens.iter().map(String::as_str).collect();
    w.assert_no_leak(&extra, &logs).await;
}

// --- WA22: one number ------------------------------------------------------------------------------

/// The route's input ceiling is the decoder's and the read route's (5 MiB), and the write address lives
/// the same 60 seconds as the read address — read off the row the worker's own role wrote, and compared
/// with the number the ADR names rather than with the constant it was written from.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_limits_are_one_number_and_the_write_address_lives_sixty_seconds() {
    let (_gate, _logs) = begin().await;
    assert_eq!(AGENT_PICTURE_MAX_INPUT_BYTES, momo_expressions::INPUT_BYTES);
    assert_eq!(AGENT_PICTURE_MAX_INPUT_BYTES as i64, SELF_MEDIA_MAX_BYTES);
    assert_eq!(AGENT_PICTURE_MAX_INPUT_BYTES, 5 * 1024 * 1024);
    assert_eq!(AGENT_MEDIA_TTL_SECS, SELF_MEDIA_INTERNAL_TTL_SECS);
    assert_eq!(AGENT_MEDIA_TTL_SECS, 60);
    assert_eq!(AGENT_PICTURES_PER_RUN, 1, "v1 writes one picture per run");

    let w = boot().await;
    let t = seed_tenant(&w).await;
    let token = mint_for(&w, &t, t.run).await;
    // `created_at` and `expires_at` are two `clock_timestamp()`s of one INSERT: the span is the lifetime
    // and a few microseconds
    let lifetime: f64 = sqlx::query_scalar(
        "SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::float8 \
           FROM attachment_write_token WHERE token_hash = $1",
    )
    .bind(token_hash(&token).to_vec())
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert!(
        (lifetime - 60.0).abs() < 0.1,
        "the write address lives 60 seconds, not {lifetime}"
    );
    // the slot of that row, and the table's own limits: a second slot cannot be minted in v1
    assert_eq!(
        sqlx::query_scalar::<_, i16>(
            "SELECT slot FROM attachment_write_token WHERE token_hash = $1"
        )
        .bind(token_hash(&token).to_vec())
        .fetch_one(&w.su)
        .await
        .unwrap(),
        1
    );
    assert!(
        try_mint(&w, t.ws, t.run, t.agent).await.is_none(),
        "the run's one slot is taken"
    );
}

// --- the caller leaves: the work finishes anyway ---------------------------------------------------------

/// Write a request on a raw socket (`sent` of the `declared` body bytes), wait until the token is spent —
/// the handler is then demonstrably in flight; a request that arrives together with its own hang-up may
/// never be handed to a handler at all, whatever the route does — and drop the socket without reading a
/// byte of the answer.
async fn send_and_hang_up(w: &World, token: &str, path: &str, declared: usize, sent: &[u8]) {
    let mut socket = tokio::net::TcpStream::connect(w.addr)
        .await
        .expect("connect");
    let head = format!(
        "PUT {path} HTTP/1.1\r\nHost: {}\r\nX-Forwarded-For: {RAW_IP}\r\nContent-Length: {declared}\r\n\r\n",
        w.addr
    );
    socket.write_all(head.as_bytes()).await.expect("head");
    socket.write_all(sent).await.expect("body");
    socket.flush().await.expect("flush");
    eventually("the token is spent: the handler is in flight", || async {
        token_state(w, token).await.0.then_some(())
    })
    .await;
    drop(socket);
}

/// A caller that sends everything and hangs up without reading the answer still gets its picture
/// **stored** (one row, one object, the audit line, the token's record) — and one that hangs up with
/// half the body gets the `length_mismatch` line and nothing stored. Everything after the spend runs in a
/// task of its own, so the hang-up cannot strand an object that no row names: measured with the caller
/// leaving (a) at once, (b) while the work waits in the decoder's line, (c) between the archive write and
/// the row.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_caller_that_hangs_up_after_sending_everything_still_gets_its_picture_stored_or_cleaned()
{
    let (_gate, logs) = begin().await;
    let w = boot().await;
    let t = seed_tenant(&w).await;
    let picture = png_rgba(64, 64, 11);

    // (a) at once
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    send_and_hang_up(&w, &token, &address(t.ws, &token), picture.len(), &picture).await;
    let row = eventually("the attachment row of a caller who hung up", || async {
        agent_rows(&w, &t).await.into_iter().next()
    })
    .await;
    assert_eq!(
        (row.uploader, row.channel_id, row.status.as_str()),
        (t.agent, t.channel, "complete")
    );
    assert_eq!(agent_rows(&w, &t).await.len(), 1);
    assert_eq!(
        w.files.objects(),
        vec![row.drive_file_id.clone()],
        "exactly one object"
    );
    assert_eq!(
        audits(&w, t.ws, "attachment.agent_picture_written")
            .await
            .len(),
        1
    );
    assert_eq!(token_state(&w, &token).await, (true, Some(row.id)));

    // (b) while the work waits for a decoder slot: the slots free half a second after the hang-up
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    let held = hold_decoder_slots().await;
    send_and_hang_up(&w, &token, &address(t.ws, &token), picture.len(), &picture).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        agent_rows(&w, &t).await.len(),
        1,
        "nothing yet: the work is in line"
    );
    drop(held);
    eventually(
        "the second attachment row, written after the caller left",
        || async { (agent_rows(&w, &t).await.len() == 2).then_some(()) },
    )
    .await;
    assert_eq!(w.files.objects().len(), 2);
    assert_eq!(
        audits(&w, t.ws, "attachment.agent_picture_written")
            .await
            .len(),
        2
    );

    // (c) between the archive write and the row: the hook holds the work there for 0.8 s
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    w.files.set_after_put(Some(Arc::new(|_stored: String| {
        Box::pin(async {
            tokio::time::sleep(Duration::from_millis(800)).await;
        })
    })));
    send_and_hang_up(&w, &token, &address(t.ws, &token), picture.len(), &picture).await;
    eventually(
        "the third attachment row, written after the caller left mid-write",
        || async { (agent_rows(&w, &t).await.len() == 3).then_some(()) },
    )
    .await;
    w.files.set_after_put(None);
    assert_eq!(w.files.objects().len(), 3, "every object has its row");
    assert!(w.files.deleted().is_empty(), "nothing had to be cleaned up");
    let (used, recorded) = token_state(&w, &token).await;
    assert!(used && recorded.is_some());

    // a caller that hangs up halfway through the body: the refusal is recorded, nothing is stored
    let run = fresh_run(&w, &t).await;
    let token = mint_for(&w, &t, run).await;
    let marks = Marks::now();
    send_and_hang_up(
        &w,
        &token,
        &address(t.ws, &token),
        picture.len(),
        &picture[..picture.len() / 2],
    )
    .await;
    let reasons = eventually(
        "the length_mismatch line of a caller who left mid-body",
        || async {
            let reasons = refused_reason(&w, &t, run).await;
            (!reasons.is_empty()).then_some(reasons)
        },
    )
    .await;
    assert_eq!(reasons, vec!["length_mismatch"]);
    assert_eq!(
        agent_rows(&w, &t).await.len(),
        3,
        "no row for the half picture"
    );
    assert_eq!(w.files.objects().len(), 3);
    assert_eq!(marks.children(), 0, "a half body is never decoded");
    assert_eq!(token_state(&w, &token).await, (true, None));
    w.assert_no_leak(&[], &logs).await;
}

/// The premise of the test above, measured: with this server stack a caller who sends a whole request
/// and hangs up gets its **ordinary handler dropped** mid-work (it never finishes). That is why the
/// route runs everything after the spend in a task of its own, and why the hang-up test above would go
/// red if `land` ran inline. The handler here has the route's shape — something unrelated to the body
/// first (the token's spend), then the body, then work — and no database.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn control_hanging_up_drops_an_ordinary_handler_which_is_why_the_work_runs_in_its_own_task() {
    use std::sync::atomic::AtomicBool;
    let (_gate, _logs) = begin().await;
    struct Flags {
        started: AtomicBool,
        dropped: AtomicBool,
        finished: AtomicBool,
    }
    struct OnDrop(Arc<Flags>);
    impl Drop for OnDrop {
        fn drop(&mut self) {
            self.0.dropped.store(true, Ordering::SeqCst);
        }
    }
    let flags = Arc::new(Flags {
        started: AtomicBool::new(false),
        dropped: AtomicBool::new(false),
        finished: AtomicBool::new(false),
    });
    let handler_flags = flags.clone();
    let app = axum::Router::new().route(
        "/x",
        axum::routing::put(move |body: axum::body::Body| {
            let flags = handler_flags.clone();
            async move {
                let _guard = OnDrop(flags.clone());
                flags.started.store(true, Ordering::SeqCst);
                // the token's spend, then the body, then the work
                tokio::time::sleep(Duration::from_millis(50)).await;
                let _ = axum::body::to_bytes(body, 1024).await;
                tokio::time::sleep(Duration::from_millis(700)).await;
                flags.finished.store(true, Ordering::SeqCst);
                "done"
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let mut socket = tokio::net::TcpStream::connect(addr).await.unwrap();
    socket
        .write_all(
            format!("PUT /x HTTP/1.1\r\nHost: {addr}\r\nContent-Length: 4\r\n\r\nabcd").as_bytes(),
        )
        .await
        .unwrap();
    socket.flush().await.unwrap();
    // hang up once the handler is in flight (hung up at once, hyper may never hand it the request)
    eventually("the handler started", || async {
        flags.started.load(Ordering::SeqCst).then_some(())
    })
    .await;
    drop(socket);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(
        flags.dropped.load(Ordering::SeqCst) && !flags.finished.load(Ordering::SeqCst),
        "a caller who hangs up cancels an ordinary handler before it finishes (dropped={}, finished={})",
        flags.dropped.load(Ordering::SeqCst),
        flags.finished.load(Ordering::SeqCst)
    );
}
