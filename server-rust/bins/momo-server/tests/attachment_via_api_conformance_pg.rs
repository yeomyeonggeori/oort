//! #4934 — the agent-worker reads a requester's picture **through the api** (ADR-0151 증보 3).
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26916/postgres \
//!   cargo test -p momo-server --test attachment_via_api_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! Real PG18, two tenants, the **real router** over TCP running as the non-bypass `momo_app`, and the
//! real `AgentWorker::attachment_reader()` running as `momo_worker`. The archive is an in-process map
//! wired **only into the api**: the worker's own archive is `UnavailableDriveArchive`, so a picture that
//! comes back could only have come through the route. A recorder in front of the router keeps every
//! request path the api saw — which is also how a test learns the token the worker minted for itself.
//! `tracing` is captured at TRACE (the `log` records of reqwest and hyper too), so "the token is in no
//! log line" is measured, not assumed.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_requesters_picture_goes_worker_to_api_to_worker_and_becomes_the_proposal_image` | the reader not using the api; a token or Drive id in a row or log line |
//! | `a_refused_attachment_never_reaches_the_api_and_every_refusal_is_the_same` | dropping the ownership check from the mint (the api would then be asked, and 404 it) |
//! | `the_address_the_worker_mints_is_single_use_and_short_lived_on_the_wire` | removing `used_at IS NULL` or `expires_at > …` from the redeem |
//! | `a_failed_fetch_logs_a_cause_and_never_the_token` | removing the scrub in `self_media::transport` |
//! | `a_worker_with_no_private_address_keeps_reading_its_own_archive` | `attachment_reader` ignoring the configuration |
//! | `a_worker_whose_api_is_unreachable_fails_closed_and_does_not_fall_back_to_the_archive` | a silent fallback to the archive |
//! | `the_api_refusing_after_the_mint_burns_the_address_and_the_worker_refuses` | a second attempt with the same address |

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::extract::{Request, State};
use axum::middleware::{from_fn_with_state, Next};
use axum::response::Response;
use futures::StreamExt;
use momo_agent_worker::provider::MockChatProvider;
use momo_agent_worker::self_media::AttachmentReader;
use momo_agent_worker::{AgentWorker, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_drive::{DriveArchive, DriveContent, DriveError, DriveFile, DriveUploadSession};
use momo_messaging::mint_for_attachment_with_ttl_in_tx;
use momo_server::{build_app, AppState};
use momo_workspace_actions::action_resolve::{self, ActionArgs};
use momo_workspace_actions::profile_avatar::{self, AttachmentBytes, RequesterAttachment};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const MAX_BYTES: usize = 5 * 1024 * 1024;

// --- harness -----------------------------------------------------------------

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
/// this test binary, at TRACE. One global subscriber: the tests run one at a time and every needle they
/// look for is a random token or a unique Drive id.
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

const DRIVE_MIME: &str = "application/x-drive-internal-mime";

/// The api's archive. Counts every content read, so "the api was asked" and "the api was not asked"
/// are both things a test can read.
#[derive(Debug, Default)]
struct MapArchive {
    files: Mutex<HashMap<String, Vec<u8>>>,
    reads: AtomicUsize,
}

#[async_trait]
impl DriveArchive for MapArchive {
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
        file_id: &str,
        max_bytes: i64,
    ) -> Result<DriveContent, DriveError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let bytes = self
            .files
            .lock()
            .unwrap()
            .get(file_id)
            .cloned()
            .ok_or(DriveError::FileNotFound)?;
        if bytes.len() as i64 > max_bytes {
            return Err(DriveError::ContentTooLarge);
        }
        Ok(DriveContent {
            mime: DRIVE_MIME.to_string(),
            size_bytes: bytes.len() as i64,
            body: futures::stream::once(async move { Ok(axum::body::Bytes::from(bytes)) }).boxed(),
        })
    }
}

fn png(side: u32, seed: u32) -> Vec<u8> {
    let mut state = 0x9E37_79B9u32 ^ seed;
    let image = image::RgbaImage::from_fn(side, side, |_, _| {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let b = state.to_le_bytes();
        image::Rgba([b[0], b[1], b[2], 255])
    });
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}

fn jpeg(side: u32, seed: u32) -> Vec<u8> {
    let mut state = 0x85EB_CA6Bu32 ^ seed;
    let image = image::RgbImage::from_fn(side, side, |_, _| {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let b = state.to_le_bytes();
        image::Rgb([b[0], b[1], b[2]])
    });
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut out, image::ImageFormat::Jpeg)
        .unwrap();
    out.into_inner()
}

async fn record(
    State(seen): State<Arc<Mutex<Vec<String>>>>,
    request: Request,
    next: Next,
) -> Response {
    seen.lock().unwrap().push(request.uri().path().to_string());
    next.run(request).await
}

struct Server {
    base: String,
    archive: Arc<MapArchive>,
    su: PgPool,
    /// What the agent-worker runs as (BYPASSRLS; mints and reads inside tenant transactions).
    worker: PgPool,
    /// Every request path the api saw, in order.
    seen: Arc<Mutex<Vec<String>>>,
}

impl Server {
    fn requests(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
    fn reads(&self) -> usize {
        self.archive.reads.load(Ordering::SeqCst)
    }
    /// The token of the one request the api saw: the last path segment.
    fn the_one_token(&self) -> String {
        let requests = self.requests();
        assert_eq!(
            requests.len(),
            1,
            "exactly one request reached the api: {requests:?}"
        );
        requests[0].rsplit('/').next().unwrap().to_string()
    }
}

async fn start() -> Server {
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
    let archive = Arc::new(MapArchive::default());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().unwrap();
    let state = AppState::new(
        app,
        "attachment-via-api-signing-secret".to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_drive(archive.clone());
    let router = build_app(state).layer(from_fn_with_state(seen.clone(), record));
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Server {
        base: format!("http://{address}"),
        archive,
        su,
        worker,
        seen,
    }
}

struct Tenant {
    ws: Uuid,
    alice: Uuid,
    bob: Uuid,
    agent: Uuid,
    channel: Uuid,
    /// alice's request message, and the PNG it carries
    photo: Uuid,
    photo_drive_file: String,
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

async fn seed_message(su: &PgPool, ws: Uuid, channel: Uuid, author: Uuid) -> Uuid {
    let seq: i64 = sqlx::query_scalar(
        "UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1 RETURNING last_seq",
    )
    .bind(channel)
    .fetch_one(su)
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
    .execute(su)
    .await
    .unwrap();
    id
}

/// One attachment row (and, when `bytes` is given, the file in the api's archive).
#[allow(clippy::too_many_arguments)]
async fn seed_attachment(
    server: &Server,
    ws: Uuid,
    channel: Uuid,
    uploader: Uuid,
    message: Uuid,
    mime: &str,
    size: i64,
    status: &str,
    bytes: Option<Vec<u8>>,
) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let drive_file = format!("drv-{id}");
    sqlx::query(
        "INSERT INTO attachment (id, workspace_id, channel_id, uploader_member_id, message_id, \
         drive_file_id, name, mime, size_bytes, status) \
         VALUES ($1, $2, $3, $4, $5, $6, 'photo', $7, $8, $9)",
    )
    .bind(id)
    .bind(ws)
    .bind(channel)
    .bind(uploader)
    .bind(message)
    .bind(&drive_file)
    .bind(mime)
    .bind(size)
    .bind(status)
    .execute(&server.su)
    .await
    .unwrap();
    if let Some(bytes) = bytes {
        server
            .archive
            .files
            .lock()
            .unwrap()
            .insert(drive_file.clone(), bytes);
    }
    (id, drive_file)
}

/// A complete, readable picture of `uploader`'s on a fresh message of theirs.
async fn seed_picture(
    server: &Server,
    ws: Uuid,
    channel: Uuid,
    uploader: Uuid,
    mime: &str,
    bytes: Vec<u8>,
) -> (Uuid, Uuid, String, usize) {
    let message = seed_message(&server.su, ws, channel, uploader).await;
    let size = bytes.len();
    let (id, drive_file) = seed_attachment(
        server,
        ws,
        channel,
        uploader,
        message,
        mime,
        size as i64,
        "complete",
        Some(bytes),
    )
    .await;
    (id, message, drive_file, size)
}

async fn seed_run(su: &PgPool, ws: Uuid, channel: Uuid, agent: Uuid, trigger: Uuid) -> Uuid {
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
    .bind(format!("attachment-via-api:{run}"))
    .execute(su)
    .await
    .unwrap();
    run
}

async fn seed_tenant(server: &Server) -> Tenant {
    let su = &server.su;
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
    let (photo, trigger, photo_drive_file, _) =
        seed_picture(server, ws, channel, alice, "image/png", png(64, 1)).await;
    let run = seed_run(su, ws, channel, agent, trigger).await;
    Tenant {
        ws,
        alice,
        bob,
        agent,
        channel,
        photo,
        photo_drive_file,
        run,
    }
}

/// The worker as production builds it: its own archive is `UnavailableDriveArchive` (it could not read
/// a byte itself); the private address is set when `origin` is.
fn worker(server: &Server, origin: Option<&str>) -> AgentWorker {
    let mut config = WorkerConfig::for_target(database_url());
    if let Some(origin) = origin {
        config = config.with_api_internal_origin(origin);
    }
    AgentWorker::new(
        server.worker.clone(),
        Arc::new(MockChatProvider::echo()),
        config,
    )
}

fn avatar_args(attachment: Uuid) -> ActionArgs {
    let action = momo_agent::actions::action_by_id("member.avatar.set").unwrap();
    action_resolve::validated_action_args(
        action,
        &json!({"attachmentId": attachment.to_string()}),
        chrono::Utc::now().timestamp_millis(),
    )
    .expect("valid arguments")
    .args
}

/// What `prepare` hands the reader once the lookup has passed — called directly, so the **mint's own**
/// ownership rule is what answers (the lookup in `prepare` would otherwise refuse first).
async fn read_direct(
    worker: &AgentWorker,
    tenant: &Tenant,
    attachment: Uuid,
    size: i64,
) -> Result<Vec<u8>, &'static str> {
    worker
        .attachment_reader()
        .read(&RequesterAttachment {
            workspace_id: tenant.ws,
            run_id: tenant.run,
            agent_id: tenant.agent,
            attachment_id: attachment,
            drive_file_id: "",
            size_bytes: size,
            max_bytes: MAX_BYTES,
        })
        .await
}

async fn token_rows(server: &Server, ws: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM self_media_token WHERE workspace_id = $1")
        .bind(ws)
        .fetch_one(&server.su)
        .await
        .unwrap()
}

/// No durable row a run, a worker or the api writes, and no log line, holds any of `needles` (the token
/// the worker minted for itself, the Drive ids). Not vacuous: the scan insists there were rows and logs.
async fn assert_no_leak(server: &Server, ws: Uuid, needles: &[&str], logs: &Capture) {
    let mut scanned = 0;
    for table in [
        "audit_log",
        "outbox",
        "agent_run",
        "message",
        "self_media_token",
    ] {
        let rows: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT to_jsonb(t)::text FROM {table} t WHERE workspace_id = $1"
        ))
        .bind(ws)
        .fetch_all(&server.su)
        .await
        .unwrap();
        scanned += rows.len();
        for row in &rows {
            for needle in needles {
                assert!(!row.contains(needle), "{table} holds `{needle}`: {row}");
            }
        }
    }
    assert!(scanned >= 3, "the scan looked at {scanned} rows");
    let text = logs.text();
    assert!(
        text.len() > 1000,
        "the capture is live ({} bytes)",
        text.len()
    );
    // the `log` records of the HTTP client are part of it (hyper_util·reqwest talk through `log`), so
    // their silence about the address is something this scan saw rather than something it could not
    assert!(
        text.contains("hyper_util::") && text.contains("reqwest::"),
        "the capture carries the HTTP client's own records"
    );
    for needle in needles {
        assert!(!text.contains(needle), "a log line holds `{needle}`");
    }
}

fn reqwest_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap()
}

// --- the loop ------------------------------------------------------------------

/// The whole Railway shape in one process: the worker has no archive, the api has the file. The
/// picture a person sent (a file that is **not** the request's own trigger photo) comes back through the
/// route, is decoded by the proposal's own decoder, and leaves no token and no Drive id anywhere.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_requesters_picture_goes_worker_to_api_to_worker_and_becomes_the_proposal_image() {
    let logs = capture_logs();
    let server = start().await;
    let tenant = seed_tenant(&server).await;
    let (jpeg_id, _, jpeg_drive_file, _) = seed_picture(
        &server,
        tenant.ws,
        tenant.channel,
        tenant.alice,
        "image/jpeg",
        jpeg(96, 7),
    )
    .await;

    let worker = worker(&server, Some(&server.base));
    let reader = worker.attachment_reader();
    assert!(
        matches!(reader, AttachmentReader::Api(_)),
        "a configured private address means the api path"
    );
    let prepared = profile_avatar::prepare_with(
        &server.worker,
        &reader,
        tenant.ws,
        tenant.run,
        tenant.agent,
        &avatar_args(jpeg_id),
    )
    .await
    .expect("prepared")
    .expect("an image");
    assert_eq!(prepared.origin, "attachment");
    assert_eq!(prepared.requester, tenant.alice);
    assert_eq!(prepared.run_id, tenant.run);
    assert!(!prepared.image.bytes.is_empty());

    // it came through the api and nowhere else
    assert_eq!(server.reads(), 1, "the api read its archive once");
    let token = server.the_one_token();
    assert_eq!(
        server.requests()[0],
        format!("/v1/self-media/{}/{token}", tenant.ws)
    );
    let (bound, spent): ((Uuid, Uuid, Uuid, Uuid, Uuid), bool) = {
        let row: (Uuid, Uuid, Uuid, Uuid, Uuid, bool) = sqlx::query_as(
            "SELECT run_id, agent_member_id, requester_member_id, channel_id, attachment_id, \
                    used_at IS NOT NULL FROM self_media_token WHERE workspace_id = $1",
        )
        .bind(tenant.ws)
        .fetch_one(&server.su)
        .await
        .unwrap();
        ((row.0, row.1, row.2, row.3, row.4), row.5)
    };
    assert_eq!(
        bound,
        (
            tenant.run,
            tenant.agent,
            tenant.alice,
            tenant.channel,
            jpeg_id
        ),
        "the address the worker minted names the ONE attachment the proposal carried"
    );
    assert!(spent, "and the worker spent it");

    assert_no_leak(
        &server,
        tenant.ws,
        &[&token, &jpeg_drive_file, &tenant.photo_drive_file],
        &logs,
    )
    .await;
}

/// RED proof (#4934, 소유 재판정): every id that is not the requester's own complete image in this run's
/// conversation is the one same refusal — at the lookup (`prepare_with`) **and** at the mint (the reader
/// called directly) — and **no request reaches the api** (a 404 from the api would look the same from the
/// outside, which is why the recorder is what is measured).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_refused_attachment_never_reaches_the_api_and_every_refusal_is_the_same() {
    let server = start().await;
    let su = &server.su;
    let worker = worker(&server, Some(&server.base));
    let reader = worker.attachment_reader();

    // (tenant, attachment id) pairs; the label says why each is not alice's to use
    let mut cases: Vec<(&str, Tenant, Uuid)> = Vec::new();

    let tenant = seed_tenant(&server).await;
    let (bobs, _, _, _) = seed_picture(
        &server,
        tenant.ws,
        tenant.channel,
        tenant.bob,
        "image/png",
        png(32, 2),
    )
    .await;
    cases.push(("somebody else's file", tenant, bobs));

    for (label, sql) in [
        (
            "deleted (state)",
            "UPDATE message SET state = 'deleted'::message_state WHERE id = $1",
        ),
        (
            "deleted (deleted_at)",
            "UPDATE message SET deleted_at = now() WHERE id = $1",
        ),
    ] {
        let tenant = seed_tenant(&server).await;
        let (file, message, _, _) = seed_picture(
            &server,
            tenant.ws,
            tenant.channel,
            tenant.alice,
            "image/png",
            png(32, 3),
        )
        .await;
        sqlx::query(sql).bind(message).execute(su).await.unwrap();
        cases.push((label, tenant, file));
    }

    let tenant = seed_tenant(&server).await;
    let elsewhere = seed_channel(su, tenant.ws, tenant.alice, &[tenant.alice]).await;
    let (file, _, _, _) = seed_picture(
        &server,
        tenant.ws,
        elsewhere,
        tenant.alice,
        "image/png",
        png(32, 4),
    )
    .await;
    cases.push(("another conversation", tenant, file));

    let one = seed_tenant(&server).await;
    let two = seed_tenant(&server).await;
    cases.push(("another workspace's file", one, two.photo));

    for (label, mime, size, status) in [
        (
            "a type the proposal does not take",
            "image/gif",
            100_i64,
            "complete",
        ),
        ("not an image", "application/pdf", 100, "complete"),
        ("still uploading", "image/png", 100, "pending"),
        (
            "over the ceiling",
            "image/png",
            MAX_BYTES as i64 + 1,
            "complete",
        ),
    ] {
        let tenant = seed_tenant(&server).await;
        let message = seed_message(su, tenant.ws, tenant.channel, tenant.alice).await;
        let (file, _) = seed_attachment(
            &server,
            tenant.ws,
            tenant.channel,
            tenant.alice,
            message,
            mime,
            size,
            status,
            Some(png(32, 5)),
        )
        .await;
        cases.push((label, tenant, file));
    }
    let tenant = seed_tenant(&server).await;
    cases.push(("an id that does not exist", tenant, Uuid::new_v4()));

    // the reader holds the row's own declared size to the ceiling too: a size outside 1..=ceiling is
    // refused before any address is minted, whatever attachment it is paired with
    let tenant = seed_tenant(&server).await;
    for size in [0_i64, -1, MAX_BYTES as i64 + 1] {
        let result = read_direct(&worker, &tenant, tenant.photo, size).await;
        assert_eq!(
            result.err(),
            Some("attachment_not_available"),
            "size {size}"
        );
    }
    assert_eq!(
        token_rows(&server, tenant.ws).await,
        0,
        "no address for a size the rule refuses"
    );

    for (label, tenant, attachment) in &cases {
        let lookup = profile_avatar::prepare_with(
            &server.worker,
            &reader,
            tenant.ws,
            tenant.run,
            tenant.agent,
            &avatar_args(*attachment),
        )
        .await;
        assert_eq!(
            lookup.err(),
            Some("attachment_not_available"),
            "lookup: {label}"
        );
        let mint = read_direct(&worker, tenant, *attachment, 100).await;
        assert_eq!(
            mint.err(),
            Some("attachment_not_available"),
            "mint: {label}"
        );
        assert_eq!(
            token_rows(&server, tenant.ws).await,
            0,
            "{label}: a refusal writes nothing"
        );
    }
    assert!(
        server.requests().is_empty(),
        "a refused attachment must never reach the api: {:?}",
        server.requests()
    );
    assert_eq!(server.reads(), 0, "and the archive was never opened");

    // control: the same calls on an untouched tenant do reach the api and come back with the picture
    let tenant = seed_tenant(&server).await;
    let size = png(64, 1).len() as i64;
    let bytes = read_direct(&worker, &tenant, tenant.photo, size)
        .await
        .expect("served");
    assert_eq!(bytes, png(64, 1));
    assert_eq!(server.requests().len(), 1);
}

/// RED proof (#4934, 1회용·만료): the address the worker mints behaves on the wire as the contract says —
/// served once, then the one refusal; a one-second address is refused after its second.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_address_the_worker_mints_is_single_use_and_short_lived_on_the_wire() {
    let server = start().await;
    let tenant = seed_tenant(&server).await;
    let mint = |ttl: i64| {
        let (ws, run, agent, attachment, pool) = (
            tenant.ws,
            tenant.run,
            tenant.agent,
            tenant.photo,
            server.worker.clone(),
        );
        async move {
            with_tenant_tx(&pool, ws, move |conn| {
                Box::pin(async move {
                    mint_for_attachment_with_ttl_in_tx(conn, ws, run, agent, attachment, ttl).await
                })
            })
            .await
            .expect("mint")
            .expect("a token")
            .token
        }
    };
    let get = |token: String| {
        let url = format!("{}/v1/self-media/{}/{token}", server.base, tenant.ws);
        async move {
            let response = reqwest_client().get(url).send().await.expect("request");
            (
                response.status().as_u16(),
                response.bytes().await.unwrap().to_vec(),
            )
        }
    };

    let token = mint(60).await;
    let (status, body) = get(token.clone()).await;
    assert_eq!((status, body), (200, png(64, 1)), "served once");
    let (status, body) = get(token).await;
    assert_eq!(status, 404, "a spent address is refused");
    assert!(
        !body.is_empty() && body.len() < 200,
        "with the one short body"
    );

    let token = mint(1).await;
    tokio::time::sleep(Duration::from_millis(1300)).await;
    let (status, _) = get(token).await;
    assert_eq!(status, 404, "an expired address is refused");
}

/// A stub that is not the api: it records the whole request head, then either hangs up without a word or
/// answers `status`. It is what lets a test hold the token the worker minted for itself.
async fn recording_stub(status: Option<&'static str>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let heads = Arc::new(Mutex::new(Vec::new()));
    let kept = heads.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let kept = kept.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 16 * 1024];
                let read = socket.read(&mut buffer).await.unwrap_or(0);
                kept.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buffer[..read]).into_owned());
                if let Some(status) = status {
                    let answer = format!(
                        "HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    );
                    let _ = socket.write_all(answer.as_bytes()).await;
                    let _ = socket.shutdown().await;
                }
                // `None`: drop the socket with the request unanswered
            });
        }
    });
    (origin, heads)
}

/// RED proof (#4934, 로그 가림): a fetch that fails mid-flight logs **a cause** (an operator can see why
/// the picture did not come) and never the token — the transport's own message carries the URL, so the
/// scrub on it is what is under test. The request the worker sent carries no credential of its own.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_failed_fetch_logs_a_cause_and_never_the_token() {
    let logs = capture_logs();
    let server = start().await;

    // 1. the server hangs up without answering: a transport error whose message holds the URL
    let tenant = seed_tenant(&server).await;
    let (origin, heads) = recording_stub(None).await;
    let size = png(64, 1).len() as i64;
    let result = read_direct(&worker(&server, Some(&origin)), &tenant, tenant.photo, size).await;
    assert_eq!(result.err(), Some("drive_unavailable"));
    let heads = heads.lock().unwrap().clone();
    assert_eq!(heads.len(), 1, "one request reached the stub");
    let head = &heads[0];
    let request_line = head.lines().next().unwrap();
    let token = request_line
        .strip_prefix(&format!("GET /v1/self-media/{}/", tenant.ws))
        .and_then(|rest| rest.strip_suffix(" HTTP/1.1"))
        .unwrap_or_else(|| panic!("the request line is the fixed shape: {request_line}"))
        .to_string();
    assert_eq!(token.len(), 43);
    let lowered = head.to_ascii_lowercase();
    for header in ["authorization", "cookie", "x-api-key", "proxy-"] {
        assert!(
            !lowered.contains(header),
            "the worker sent `{header}`: {head}"
        );
    }
    let text = logs.text();
    assert!(
        text.contains("attachment read through the api failed"),
        "the failure leaves a line an operator can read"
    );
    assert!(
        text.contains("<redacted>"),
        "and it shows the URL with the token scrubbed"
    );
    assert_no_leak(
        &server,
        tenant.ws,
        &[&token, &tenant.photo_drive_file],
        &logs,
    )
    .await;

    // 2. the server answers with a status: only the number is logged
    let tenant = seed_tenant(&server).await;
    let (origin, _) = recording_stub(Some("500 Internal Server Error")).await;
    let result = read_direct(&worker(&server, Some(&origin)), &tenant, tenant.photo, size).await;
    assert_eq!(result.err(), Some("drive_unavailable"));
    let (origin, _) = recording_stub(Some("404 Not Found")).await;
    let result = read_direct(&worker(&server, Some(&origin)), &tenant, tenant.photo, size).await;
    assert_eq!(
        result.err(),
        Some("attachment_not_available"),
        "the api's one refusal reads as not available"
    );
    assert!(logs.text().contains("status 500"));
}

/// No private address configured: the worker reads its own archive exactly as it did before #4934, and the
/// api never hears about it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_worker_with_no_private_address_keeps_reading_its_own_archive() {
    let server = start().await;
    let tenant = seed_tenant(&server).await;
    let own = worker(&server, None).with_drive(server.archive.clone());
    let reader = own.attachment_reader();
    assert!(matches!(reader, AttachmentReader::Archive(_)));
    let prepared = profile_avatar::prepare_with(
        &server.worker,
        &reader,
        tenant.ws,
        tenant.run,
        tenant.agent,
        &avatar_args(tenant.photo),
    )
    .await
    .expect("prepared")
    .expect("an image");
    assert_eq!(prepared.origin, "attachment");
    assert_eq!(server.reads(), 1, "its own archive read the file");
    assert!(server.requests().is_empty(), "the api was not asked");
    assert_eq!(
        token_rows(&server, tenant.ws).await,
        0,
        "and no address was minted"
    );

    // a value that is not an origin leaves the address off, exactly as the environment does
    for bad in [
        "",
        "api:8080",
        "http://api:8080/",
        "http://user:pw@api:8080",
        "HTTP://API",
    ] {
        let config = WorkerConfig::for_target(database_url()).with_api_internal_origin(bad);
        assert_eq!(config.api_internal_origin, None, "{bad:?}");
    }
}

/// One source per deployment. A worker told to use the api whose api cannot be reached **fails**; it does
/// not quietly read the archive it also happens to have (which would hide a broken private network).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_worker_whose_api_is_unreachable_fails_closed_and_does_not_fall_back_to_the_archive() {
    let server = start().await;
    let tenant = seed_tenant(&server).await;
    let closed = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let both = worker(&server, Some(&closed)).with_drive(server.archive.clone());
    let result = profile_avatar::prepare_with(
        &server.worker,
        &both.attachment_reader(),
        tenant.ws,
        tenant.run,
        tenant.agent,
        &avatar_args(tenant.photo),
    )
    .await;
    assert_eq!(result.err(), Some("drive_unavailable"));
    assert_eq!(server.reads(), 0, "the archive it also had was not read");
}

/// The api spends the address before it reads its archive (the contract: a token is single use). When the
/// archive then cannot produce the file, the address stays spent, the worker is told "not available", and
/// it does not ask again.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_api_refusing_after_the_mint_burns_the_address_and_the_worker_refuses() {
    let server = start().await;
    let tenant = seed_tenant(&server).await;
    server
        .archive
        .files
        .lock()
        .unwrap()
        .remove(&tenant.photo_drive_file);
    let size = png(64, 1).len() as i64;
    let result = read_direct(
        &worker(&server, Some(&server.base)),
        &tenant,
        tenant.photo,
        size,
    )
    .await;
    assert_eq!(result.err(), Some("attachment_not_available"));
    assert_eq!(server.requests().len(), 1, "one attempt, not a retry");
    assert_eq!(server.reads(), 1, "the api did try its archive");
    let spent: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM self_media_token WHERE workspace_id = $1 AND used_at IS NOT NULL",
    )
    .bind(tenant.ws)
    .fetch_one(&server.su)
    .await
    .unwrap();
    assert_eq!(spent, 1, "the address is burned");
}
