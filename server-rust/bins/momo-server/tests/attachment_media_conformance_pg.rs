//! Video meta and poster conformance (ADR-0151 증보 5 D5, #4673 C5) — the two routes
//! `PUT …/attachments/{id}/media` and `GET …/attachments/{id}/poster`, the `media` summary
//! the projections carry, and `attachment_media`'s tenant boundary, driven over real HTTP
//! against a real Postgres as the `momo_app` role (NOBYPASSRLS).
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test attachment_media_conformance_pg -- --ignored --nocapture
//! ```
//!
//! The archive is `momo_drive`'s in-process stub (no credential, no network), exactly as in
//! `attachment_conformance_pg.rs`, whose harness this file repeats.
//!
//! # Red proof → sabotage
//!
//! | test | what turns it red |
//! |---|---|
//! | `the_media_write_is_the_uploaders_before_the_send_only` | drop `message_id.is_none()` from `may_hold_media` → step 7 (a bound file takes media); drop `status == "complete"` → step 4 (a pending file with bytes takes media); drop the uploader term from **all three** of `may_hold_media`, the route's `load_readable_attachment_in_tx` branch and `load_attachment_in_tx` → step 2 (a member who is not the uploader writes) |
//! | `a_poster_is_validated_by_its_bytes_not_its_label` | drop the sniff comparison → the web page that carries a WebP chunk tag answers 200 (the JPEG-labelled PNG, GIF, HTML and SVG are also stopped by the header parse, which only reads the label's own format — that case exists because the WebP parser alone would accept it); drop the dimension read → the cut-off JPEG answers 200; drop the 1,280 bound → the 1,281 cases; drop the size check → the 256 KiB + 1 B case (the DB CHECK then answers 500, still not the 400 asserted) |
//! | `a_non_video_or_a_fake_video_cannot_hold_media` | drop `require_video_mime` → the PDF; drop `video_magic_matches` → the text-as-mp4 and the crossed containers; widen `validate_media_declaration` → the range cases (the DB CHECK answers 500) |
//! | `the_poster_route_is_the_content_route_for_everyone_else` | drop the membership check, the readable load, or the `complete` gate from `poster` → the matching row of the matrix answers something other than the content route's own refusal |
//! | `a_poster_is_never_in_a_payload` | add the poster column to a projection (`PAGED_ATTACHMENT_JOIN` or `message_attachments_in_tx`) → the page, the send echo or the outbox row carries it; drop `momo_helper_read`'s grant → the team AI's page read answers 42501 |
//! | `media_rows_follow_the_attachment` | make the FK `ON DELETE NO ACTION` → the reclaim's delete fails and the row stays |
//! | `a_send_arriving_mid_write_waits_for_it_and_carries_what_it_wrote` (review M-2) | pass `false` for `for_update` in the write's second transaction (`load_attachment_in_tx(.., false)`) → the send does not wait, its echo and frame carry no `media`, and the table gets the row afterwards |
//! | `a_send_that_wins_while_the_object_is_read_leaves_the_write_refused` (review M-2) | drop `may_hold_media(locked, ..)` from the write's second transaction → the write lands after the send has already bound the file |
//! | `the_media_write_spends_a_member_budget_of_its_own` (review M-1) | drop the `member_write(MemberWrite::MediaWrite)` layer from the route → the fourth write answers 200; point `MediaWrite` at the upload start's limit → the same; give it the upload start's key prefix → the third write answers 429 (the member's earlier upload start already spent a unit of the shared counter) |
//! | `the_media_table_is_tenant_scoped_and_locked_down` | drop `FORCE ROW LEVEL SECURITY`, the `WITH CHECK`, or the composite FK → the matching step; grant `momo_app` DELETE → the privilege step |

use std::io::Cursor;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::Engine as _;
use image::{DynamicImage, ImageBuffer, ImageFormat, Rgb};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_drive::{
    ByteRange, DriveArchive, DriveContent, DriveError, DriveFile, DriveRangeContent,
    DriveUploadSession, StubDriveArchive, UploadBody,
};
use momo_messaging::attachment_reclaim::{
    reclaim_unbound_attachment_in_tx, AttachmentReclaimOutcome, UNBOUND_TTL,
};
use momo_messaging::avatar_reclaim::DriveDelete;
use momo_messaging::{create_channel, ChannelKind, HistoryCursor, NewChannel};
use momo_server::config::RateLimitConfig;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (the same contract as attachment_conformance_pg.rs)
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "attachment-media-conformance-signing-secret";
const TEST_PASSWORD: &str = "attachment-media-conformance-password";

/// The sentence every refusal to *show* an attachment answers (never a reason).
const CONTENT_NOT_FOUND: &str = "completed attachment not found";
const NOT_A_MEMBER: &str = "active channel membership required";
/// The one 404 a readable file with nothing to show answers.
const NO_POSTER: &str = "attachment poster not found";

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

/// Boot the real router with the in-process stub archive on an ephemeral port.
async fn start_server(pool: PgPool) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    let base = format!("http://{address}");
    let archive: Arc<dyn DriveArchive> = Arc::new(StubDriveArchive::new(&base));
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_drive(archive);
    let app = build_app(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    base
}

/// The stub archive, counting every content read it is asked for.
///
/// A refused write must never reach the archive, and a status code cannot show that on its own:
/// the archive's own "file not found" is a 404 too (`routes::attachments::drive_error`), so a 404
/// that came from the archive looks exactly like one that came from the authorization. The counter
/// tells the two apart — and it is what shows the cheap checks run before the expensive read.
#[derive(Debug)]
struct CountingArchive {
    inner: StubDriveArchive,
    content_reads: Arc<AtomicUsize>,
    /// When set, a content read of the gate's object waits until the test lets it go.
    gate: Option<Arc<Gate>>,
}

impl CountingArchive {
    /// One read of an object's bytes was asked for: count it, and hold it at the gate when it is
    /// the gate's object.
    async fn reached(&self, file_id: &str) {
        self.content_reads.fetch_add(1, Ordering::SeqCst);
        if let Some(gate) = &self.gate {
            let held = gate.file_id.lock().expect("gate").as_deref() == Some(file_id);
            if held {
                gate.entered.notify_one();
                gate.release.notified().await;
            }
        }
    }
}

/// Holds one object's content read — the moment between the write's two transactions — until the
/// test lets go, so a send can be made to land exactly there.
#[derive(Debug, Default)]
struct Gate {
    file_id: Mutex<Option<String>>,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[async_trait]
impl DriveArchive for CountingArchive {
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
        self.inner.file_metadata(file_id).await
    }

    async fn file_content(
        &self,
        file_id: &str,
        max_bytes: i64,
    ) -> Result<DriveContent, DriveError> {
        self.reached(file_id).await;
        self.inner.file_content(file_id, max_bytes).await
    }

    /// The route reads through the range read (as the content route does), so the counter and the
    /// gate sit here too and the stub's own range read is the one exercised.
    async fn file_range(
        &self,
        file_id: &str,
        range: ByteRange,
        max_bytes: i64,
    ) -> Result<DriveRangeContent, DriveError> {
        self.reached(file_id).await;
        self.inner.file_range(file_id, range, max_bytes).await
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

/// A server whose archive counts content reads; the counter is the second value.
async fn start_counting_server(pool: PgPool) -> (String, Arc<AtomicUsize>) {
    start_counting_server_with(pool, None, None).await
}

/// [`start_counting_server`] with the member-write budgets the test names and/or an archive gate.
async fn start_counting_server_with(
    pool: PgPool,
    limits: Option<RateLimitConfig>,
    gate: Option<Arc<Gate>>,
) -> (String, Arc<AtomicUsize>) {
    let reads = Arc::new(AtomicUsize::new(0));
    let counter = reads.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    let base = format!("http://{address}");
    let archive: Arc<dyn DriveArchive> = Arc::new(CountingArchive {
        inner: StubDriveArchive::new(&base),
        content_reads: counter,
        gate,
    });
    let mut state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_drive(archive);
    if let Some(limits) = limits {
        state = state.with_rate_limit(limits);
    }
    let app = build_app(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (base, reads)
}

struct Person {
    member: Uuid,
    email: String,
}

struct Fixture {
    workspace: Uuid,
    channel: Uuid,
    /// Another channel of the same workspace — the "wrong channel" case.
    other_channel: Uuid,
    /// The uploader.
    alice: Person,
    /// Another member of the same channels: may read what a live message carries, may not
    /// write media.
    bob: Person,
    /// A member of the workspace who is in NO channel.
    outsider: Person,
}

async fn seed_person(su: &PgPool, workspace: Uuid) -> Person {
    let member = Uuid::new_v4();
    let email = format!("{member}@media.test");
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
    let mut channels = Vec::new();
    for label in ["media", "media-other"] {
        let channel = create_channel(
            app,
            workspace,
            NewChannel {
                kind: ChannelKind::Public,
                name: format!("{label}-{}", Uuid::new_v4()),
                topic: None,
                created_by: alice.member,
            },
        )
        .await
        .expect("create channel");
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
             VALUES ($1, $2, $3, 'member')",
        )
        .bind(workspace)
        .bind(channel.id)
        .bind(bob.member)
        .execute(su)
        .await
        .expect("seed bob membership");
        channels.push(channel.id);
    }
    Fixture {
        workspace,
        channel: channels[0],
        other_channel: channels[1],
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

// ---------------------------------------------------------------------------
// the wire
// ---------------------------------------------------------------------------

fn uploads_url(base: &str, workspace: Uuid, channel: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/attachments/uploads")
}

fn messages_url(base: &str, workspace: Uuid, channel: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/messages")
}

fn attachment_url(base: &str, ws: Uuid, ch: Uuid, attachment: &str, leaf: &str) -> String {
    format!("{base}/v1/workspaces/{ws}/channels/{ch}/attachments/{attachment}/{leaf}")
}

/// A started upload that has its bytes but was never completed.
#[allow(clippy::too_many_arguments)]
async fn upload_without_completing(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    name: &str,
    mime: &str,
    bytes: &[u8],
) -> String {
    let created = http
        .post(uploads_url(base, workspace, channel))
        .bearer_auth(token)
        .json(&json!({"name": name, "mime": mime, "size": bytes.len()}))
        .send()
        .await
        .expect("create upload");
    assert_eq!(created.status(), 201, "a created session answers 201");
    let created: Value = created.json().await.expect("upload body");
    let id = created["id"].as_str().expect("id").to_string();
    let upload_url = created["uploadUrl"]
        .as_str()
        .expect("uploadUrl")
        .to_string();
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
    id
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
    let id =
        upload_without_completing(http, base, token, workspace, channel, name, mime, bytes).await;
    let completed = http
        .post(attachment_url(base, workspace, channel, &id, "complete"))
        .bearer_auth(token)
        .send()
        .await
        .expect("complete");
    assert_eq!(completed.status(), 200, "a verified upload completes");
    id
}

/// Post a text message carrying `attachment_ids` (a thread reply when `root` is given).
#[allow(clippy::too_many_arguments)]
async fn post_with_files(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    body: &str,
    root: Option<&str>,
    attachment_ids: &[&str],
) -> (String, Value) {
    let mut payload = json!({
        "clientMsgId": Uuid::new_v4(),
        "type": "text",
        "body": body,
        "attachmentIds": attachment_ids,
    });
    if let Some(root) = root {
        payload["rootId"] = json!(root);
    }
    let sent = http
        .post(messages_url(base, workspace, channel))
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .expect("post");
    assert_eq!(sent.status(), 201, "the post is accepted");
    let sent: Value = sent.json().await.expect("post body");
    (sent["id"].as_str().expect("message id").to_string(), sent)
}

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

async fn get_json(http: &reqwest::Client, url: &str, token: &str) -> Value {
    let page = http.get(url).bearer_auth(token).send().await.expect("page");
    assert_eq!(page.status(), 200, "{url}");
    page.json().await.expect("page body")
}

/// The row of `id` in a page's `messages` array.
fn row_of<'a>(page: &'a Value, id: &str) -> &'a Value {
    page["messages"]
        .as_array()
        .expect("messages array")
        .iter()
        .find(|row| row["id"] == json!(id))
        .unwrap_or_else(|| panic!("message {id} is in the page: {page}"))
}

/// What a request answered: status, headers, exact body bytes.
struct Answer {
    status: u16,
    headers: reqwest::header::HeaderMap,
    body: Vec<u8>,
}

impl Answer {
    fn header(&self, name: &str) -> String {
        self.headers
            .get(name)
            .map(|value| value.to_str().expect("ascii header").to_string())
            .unwrap_or_default()
    }

    fn refusal(&self) -> String {
        serde_json::from_slice::<Value>(&self.body)
            .ok()
            .and_then(|parsed| parsed["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_default()
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

async fn get_as(http: &reqwest::Client, url: &str, token: &str) -> Answer {
    let response = http.get(url).bearer_auth(token).send().await.expect("get");
    Answer {
        status: response.status().as_u16(),
        headers: response.headers().clone(),
        body: response.bytes().await.expect("body").to_vec(),
    }
}

async fn put_media(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    (ws, ch): (Uuid, Uuid),
    attachment: &str,
    body: &Value,
) -> Answer {
    let response = http
        .put(attachment_url(base, ws, ch, attachment, "media"))
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .expect("put media");
    Answer {
        status: response.status().as_u16(),
        headers: response.headers().clone(),
        body: response.bytes().await.expect("body").to_vec(),
    }
}

// ---------------------------------------------------------------------------
// bytes
// ---------------------------------------------------------------------------

fn mp4() -> Vec<u8> {
    let mut bytes = b"\0\0\0\x18ftypmp42\0\0\0\0mp42isom".to_vec();
    bytes.extend(std::iter::repeat_n(0u8, 64));
    bytes
}

fn quicktime() -> Vec<u8> {
    let mut bytes = b"\0\0\0\x14ftypqt  \0\0\0\0qt  ".to_vec();
    bytes.extend(std::iter::repeat_n(0u8, 64));
    bytes
}

fn webm() -> Vec<u8> {
    let mut bytes = vec![0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81, 0x01];
    bytes.extend(std::iter::repeat_n(0u8, 64));
    bytes
}

fn encoded(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
    let buffer = ImageBuffer::from_pixel(width, height, Rgb([20u8, 120, 220]));
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(buffer)
        .write_to(&mut out, format)
        .expect("encode");
    out.into_inner()
}

fn jpeg(width: u32, height: u32) -> Vec<u8> {
    encoded(ImageFormat::Jpeg, width, height)
}

fn webp(width: u32, height: u32) -> Vec<u8> {
    encoded(ImageFormat::WebP, width, height)
}

/// Twelve bytes of a web page where `RIFF….WEBP` belongs, then a `VP8X` chunk tag and a canvas of
/// 320 x 180: the header parser alone would read this as a WebP, the magic number is what says it is
/// not.
fn a_web_page_wearing_a_webp_header() -> Vec<u8> {
    let mut bytes = b"<html><head>".to_vec();
    bytes.extend_from_slice(b"VP8X");
    bytes.extend_from_slice(&[10, 0, 0, 0]); // chunk size
    bytes.extend_from_slice(&[0, 0, 0, 0]); // flags
    bytes.extend_from_slice(&[0x3F, 0x01, 0x00]); // width - 1 = 319
    bytes.extend_from_slice(&[0xB3, 0x00, 0x00]); // height - 1 = 179
    bytes
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn poster(mime: &str, bytes: &[u8]) -> Value {
    json!({"mime": mime, "dataBase64": b64(bytes)})
}

/// A request with the three numbers of a short clip, and `poster` when given.
fn media_body(poster: Option<Value>) -> Value {
    let mut body = json!({"durationMs": 4200, "width": 1280, "height": 720});
    if let Some(poster) = poster {
        body["poster"] = poster;
    }
    body
}

async fn media_rows(su: &PgPool, attachment: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM attachment_media WHERE attachment_id = $1")
        .bind(Uuid::parse_str(attachment).expect("uuid"))
        .fetch_one(su)
        .await
        .expect("count media rows")
}

/// `(duration_ms, width, height, poster_mime, octet_length(poster_bytes))` of the row.
async fn media_row(
    su: &PgPool,
    attachment: &str,
) -> Option<(i32, i32, i32, Option<String>, Option<i32>)> {
    sqlx::query(
        "SELECT duration_ms, width, height, poster_mime, octet_length(poster_bytes) AS poster_len \
           FROM attachment_media WHERE attachment_id = $1",
    )
    .bind(Uuid::parse_str(attachment).expect("uuid"))
    .fetch_optional(su)
    .await
    .expect("read the media row")
    .map(|row| {
        (
            row.get("duration_ms"),
            row.get("width"),
            row.get("height"),
            row.get("poster_mime"),
            row.get("poster_len"),
        )
    })
}

// ---------------------------------------------------------------------------
// D5 · who may write
// ---------------------------------------------------------------------------

/// **Red proof (D5 권한).** Media is the **uploader's**, of a file that is **complete** and that
/// **no message carries yet**. Everyone else — a member who is not the uploader, a channel
/// outsider, an upload whose bytes are there but that was never completed, a file a message
/// already carries, a file whose message was deleted — is turned away, and a member who may not
/// even see the file is told what an id that never existed is told, byte for byte.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_media_write_is_the_uploaders_before_the_send_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (base, reads) = start_counting_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;
    let outsider = login(&http, &base, fixture.workspace, &fixture.outsider).await;
    let (ws, ch) = (fixture.workspace, fixture.channel);
    let scope = (ws, ch);
    let with_poster = media_body(Some(poster("image/jpeg", &jpeg(320, 180))));

    let video = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "clip.mp4",
        "video/mp4",
        &mp4(),
    )
    .await;

    // ---- 1. the yardstick: what an id that never existed is told -----------------------
    let unknown = put_media(
        &http,
        &base,
        &bob,
        scope,
        &Uuid::new_v4().to_string(),
        &with_poster,
    )
    .await;
    assert_eq!(unknown.status, 404);
    assert_eq!(unknown.refusal(), CONTENT_NOT_FOUND);

    // ---- 2. a member who is not the uploader is told the same, and nothing is written ---
    let refused = put_media(&http, &base, &bob, scope, &video, &with_poster).await;
    assert_eq!(refused.status, 404, "bob did not upload this file");
    assert_eq!(
        refused.body, unknown.body,
        "the refusal is byte for byte the 404 of an id that never existed"
    );
    assert_eq!(media_rows(&su, &video).await, 0);
    assert_eq!(
        reads.load(Ordering::SeqCst),
        0,
        "a refused write never reaches the archive"
    );

    // ---- 3. a person outside the channel is a 403 --------------------------------------
    let outside = put_media(&http, &base, &outsider, scope, &video, &with_poster).await;
    assert_eq!(outside.status, 403);
    assert_eq!(outside.refusal(), NOT_A_MEMBER);
    assert_eq!(media_rows(&su, &video).await, 0);
    assert_eq!(reads.load(Ordering::SeqCst), 0);

    // ---- 4. an upload whose bytes are in the archive but that was never completed ------
    let pending = upload_without_completing(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "half.mp4",
        "video/mp4",
        &mp4(),
    )
    .await;
    let refused = put_media(&http, &base, &alice, scope, &pending, &with_poster).await;
    assert_eq!(refused.status, 404, "a pending upload takes no media");
    assert_eq!(refused.refusal(), CONTENT_NOT_FOUND);
    assert_eq!(media_rows(&su, &pending).await, 0);
    assert_eq!(
        reads.load(Ordering::SeqCst),
        0,
        "the file's state is judged before the archive is asked for its bytes"
    );

    // ---- 5. the uploader writes -------------------------------------------------------
    let written = put_media(&http, &base, &alice, scope, &video, &with_poster).await;
    assert_eq!(written.status, 200, "{}", written.refusal());
    assert_eq!(
        reads.load(Ordering::SeqCst),
        1,
        "an accepted write read the object's first bytes once"
    );
    assert_eq!(
        written.json(),
        json!({"kind": "video", "durationMs": 4200, "width": 1280, "height": 720, "hasPoster": true}),
        "the answer is the summary a card is drawn from, never the picture"
    );
    let row = media_row(&su, &video).await.expect("the row is written");
    assert_eq!(
        (row.0, row.1, row.2, row.3.as_deref()),
        (4200, 1280, 720, Some("image/jpeg"))
    );
    assert_eq!(row.4, Some(jpeg(320, 180).len() as i32));

    // ---- 6. a second write replaces the first, whole -----------------------------------
    let replaced = put_media(
        &http,
        &base,
        &alice,
        scope,
        &video,
        &json!({"durationMs": 9000, "width": 640, "height": 360}),
    )
    .await;
    assert_eq!(replaced.status, 200);
    assert_eq!(replaced.json()["hasPoster"], json!(false));
    let row = media_row(&su, &video).await.expect("the row is still one");
    assert_eq!(
        row,
        (9000, 640, 360, None, None),
        "a write without a poster clears the old poster: the row describes the last request"
    );
    assert_eq!(media_rows(&su, &video).await, 1, "one row per attachment");

    // the audit trail names the kind and whether there is a poster, and nothing else
    let audits: Vec<Value> = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE action = 'attachment.media_set' AND target_id = $1 \
          ORDER BY created_at, id",
    )
    .bind(Uuid::parse_str(&video).expect("uuid"))
    .fetch_all(&su)
    .await
    .expect("audit rows");
    assert_eq!(audits.len(), 2, "one audit row per accepted write");
    for (audit, (has_poster, replaced)) in audits.iter().zip([(true, false), (false, true)]) {
        assert_eq!(
            audit,
            &json!({
                "schema": "momo.attachment.media_set.v1",
                "channel_id": ch.to_string(),
                "kind": "video",
                "has_poster": has_poster,
                "replaced": replaced,
            })
        );
    }

    // ---- 7. once a message carries the file, the numbers stop moving ------------------
    let (message, _) =
        post_with_files(&http, &base, &alice, ws, ch, "영상 보내요", None, &[&video]).await;
    for (who, token) in [("the uploader", &alice), ("another member", &bob)] {
        let refused = put_media(&http, &base, token, scope, &video, &with_poster).await;
        assert_eq!(
            refused.status, 404,
            "{who} cannot change a sent file's media"
        );
        assert_eq!(refused.refusal(), CONTENT_NOT_FOUND);
    }
    assert_eq!(
        media_row(&su, &video).await,
        Some((9000, 640, 360, None, None)),
        "the refused writes changed nothing"
    );

    // ---- 8. a deleted message's file takes none either --------------------------------
    delete_message_as(&http, &base, &alice, ws, &message).await;
    let refused = put_media(&http, &base, &alice, scope, &video, &with_poster).await;
    assert_eq!(refused.status, 404);
    assert_eq!(refused.refusal(), CONTENT_NOT_FOUND);
}

// ---------------------------------------------------------------------------
// D5 · the poster and the numbers
// ---------------------------------------------------------------------------

/// **Red proof (D5 포스터 검증).** A poster is judged by its **bytes**: a page of HTML, a PNG, a
/// GIF or an SVG that says `image/jpeg` is a 400, so is a JPEG cut off before its frame header (it
/// has no size), a picture over 256 KiB or over 1,280 pixels on a side, a label that is not one of
/// the two poster types, and an encoding that is not strict base64. A real JPEG and a real WebP
/// pass. (A JPEG cut off *after* its frame header also passes — the server reads a header and does
/// not decode — and this test deliberately does not assert otherwise.)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_poster_is_validated_by_its_bytes_not_its_label() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (base, reads) = start_counting_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let (ws, ch) = (fixture.workspace, fixture.channel);
    let scope = (ws, ch);
    let video = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "clip.mp4",
        "video/mp4",
        &mp4(),
    )
    .await;

    let good_jpeg = jpeg(320, 180);
    let mut over_a_quarter_meg = jpeg(64, 64);
    over_a_quarter_meg.resize(256 * 1024 + 1, 0);
    let mut exactly_a_quarter_meg = jpeg(64, 64);
    exactly_a_quarter_meg.resize(256 * 1024, 0);

    // ---- 1. every one of these is a 400, and none leaves a row ------------------------
    let refused: Vec<(&str, Value)> = vec![
        (
            "html labelled as a jpeg",
            poster("image/jpeg", b"<html><script>1</script></html>"),
        ),
        (
            "a png labelled as a jpeg",
            poster("image/jpeg", &encoded(ImageFormat::Png, 64, 64)),
        ),
        (
            "a gif labelled as a jpeg",
            poster("image/jpeg", b"GIF89a\x40\x00\x40\x00\x00\x00\x00;"),
        ),
        (
            "an svg labelled as a jpeg",
            poster(
                "image/jpeg",
                b"<svg xmlns='http://www.w3.org/2000/svg' width='9' height='9'/>",
            ),
        ),
        (
            "a jpeg labelled as a webp",
            poster("image/webp", &good_jpeg),
        ),
        (
            "a web page wearing a webp header",
            poster("image/webp", &a_web_page_wearing_a_webp_header()),
        ),
        (
            "a jpeg cut off before its frame header",
            poster("image/jpeg", &good_jpeg[..20]),
        ),
        ("256 KiB + 1 B", poster("image/jpeg", &over_a_quarter_meg)),
        ("1,281 pixels wide", poster("image/jpeg", &jpeg(1_281, 16))),
        ("1,281 pixels tall", poster("image/jpeg", &jpeg(16, 1_281))),
        (
            "a png label",
            poster("image/png", &encoded(ImageFormat::Png, 64, 64)),
        ),
        (
            "no label",
            json!({"mime": "", "dataBase64": b64(&good_jpeg)}),
        ),
        (
            "an encoding with whitespace",
            json!({"mime": "image/jpeg", "dataBase64": format!("{}\n", b64(&good_jpeg))}),
        ),
        ("an empty picture", poster("image/jpeg", b"")),
    ];
    for (what, poster) in refused {
        let answer = put_media(
            &http,
            &base,
            &alice,
            scope,
            &video,
            &media_body(Some(poster)),
        )
        .await;
        assert_eq!(
            answer.status,
            400,
            "{what}: {}",
            String::from_utf8_lossy(&answer.body)
        );
        assert_eq!(media_rows(&su, &video).await, 0, "{what} left a row");
    }
    // a body past the route's ceiling is refused before it is read
    let huge = put_media(
        &http,
        &base,
        &alice,
        scope,
        &video,
        &json!({"durationMs": 1000, "width": 1, "height": 1,
                "poster": {"mime": "image/jpeg", "dataBase64": "A".repeat(600 * 1024)}}),
    )
    .await;
    assert_eq!(huge.status, 413);
    // a key the route does not know is a client that means something else
    let unknown_key = put_media(
        &http,
        &base,
        &alice,
        scope,
        &video,
        &json!({"durationMs": 1000, "width": 1, "height": 1, "kind": "audio"}),
    )
    .await;
    assert_eq!(
        unknown_key.status,
        422,
        "an unknown key is a body the extractor cannot read into the request: {}",
        String::from_utf8_lossy(&unknown_key.body)
    );
    assert_eq!(media_rows(&su, &video).await, 0);
    // a body the extractor cannot read at all, the statuses `docs/api/openapi.yaml` lists beside 400:
    // not JSON (400), not sent as JSON (415), JSON of the wrong shape — a missing field, a
    // fractional length (422)
    for (what, content_type, body, expected) in [
        (
            "a body that is not JSON",
            "application/json",
            "{not json",
            400,
        ),
        ("an empty body", "application/json", "", 400),
        (
            "JSON sent as text",
            "text/plain",
            r#"{"durationMs":1,"width":1,"height":1}"#,
            415,
        ),
        (
            "a missing field",
            "application/json",
            r#"{"durationMs":1,"width":1}"#,
            422,
        ),
        (
            "a fractional length",
            "application/json",
            r#"{"durationMs":1.5,"width":1,"height":1}"#,
            422,
        ),
    ] {
        let answer = http
            .put(attachment_url(&base, ws, ch, &video, "media"))
            .bearer_auth(&alice)
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(body)
            .send()
            .await
            .expect("put raw body");
        assert_eq!(answer.status(), expected, "{what}");
    }
    assert_eq!(media_rows(&su, &video).await, 0);
    assert_eq!(
        reads.load(Ordering::SeqCst),
        0,
        "a request whose shape is wrong is refused before the archive is asked for anything"
    );

    // ---- 2. the real ones pass; exactly 256 KiB is the last size that does ------------
    for (what, picture, mime, expected) in [
        ("a jpeg", good_jpeg.clone(), "image/jpeg", (320, 180)),
        ("a webp", webp(640, 360), "image/webp", (640, 360)),
        (
            "1,280 on the long side",
            jpeg(1_280, 720),
            "image/jpeg",
            (1_280, 720),
        ),
        (
            "exactly 256 KiB",
            exactly_a_quarter_meg.clone(),
            "image/jpeg",
            (64, 64),
        ),
    ] {
        let answer = put_media(
            &http,
            &base,
            &alice,
            scope,
            &video,
            &media_body(Some(poster(mime, &picture))),
        )
        .await;
        assert_eq!(answer.status, 200, "{what}: {}", answer.refusal());
        let stored: (String, i32, i32, i32) = sqlx::query_as(
            "SELECT poster_mime, poster_width, poster_height, octet_length(poster_bytes) \
               FROM attachment_media WHERE attachment_id = $1",
        )
        .bind(Uuid::parse_str(&video).expect("uuid"))
        .fetch_one(&su)
        .await
        .expect("stored poster");
        assert_eq!(
            (stored.0.as_str(), stored.1, stored.2, stored.3),
            (mime, expected.0, expected.1, picture.len() as i32),
            "{what}: the row keeps the label the bytes proved and the header's size"
        );
    }
}

/// **Red proof (D5 영상 확인).** A file only holds media when its stored type is one of the three
/// video types **and** its first bytes are that container's: text labelled `video/mp4`, a PDF, and
/// a WebM labelled as MP4 (or the other way round) all answer 400. The numbers are range-checked at
/// both ends — a length of 0 or 24 hours + 1 ms, a side of 0 or 16,385.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_non_video_or_a_fake_video_cannot_hold_media() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (base, reads) = start_counting_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let (ws, ch) = (fixture.workspace, fixture.channel);
    let scope = (ws, ch);
    let body = media_body(None);

    // ---- 1. the file is not what its label says ---------------------------------------
    for (what, name, mime, bytes) in [
        (
            "text labelled as mp4",
            "fake.mp4",
            "video/mp4",
            b"just some words, not a movie".to_vec(),
        ),
        (
            "a pdf",
            "doc.pdf",
            "application/pdf",
            b"%PDF-1.7 a pdf".to_vec(),
        ),
        ("a webm labelled as mp4", "crossed.mp4", "video/mp4", webm()),
        (
            "an mp4 labelled as webm",
            "crossed.webm",
            "video/webm",
            mp4(),
        ),
        (
            "an mp4 labelled as an image",
            "clip.png",
            "image/png",
            mp4(),
        ),
        // shorter than the container's box tag: the archive is asked only for bytes that exist
        (
            "a file shorter than the box tag",
            "tiny.mp4",
            "video/mp4",
            b"ftyp".to_vec(),
        ),
    ] {
        let file = upload_and_complete(&http, &base, &alice, ws, ch, name, mime, &bytes).await;
        let before = reads.load(Ordering::SeqCst);
        let answer = put_media(&http, &base, &alice, scope, &file, &body).await;
        assert_eq!(
            answer.status,
            400,
            "{what}: {}",
            String::from_utf8_lossy(&answer.body)
        );
        assert_eq!(media_rows(&su, &file).await, 0, "{what} left a row");
        // a stored type outside the video list is refused without opening the object; a video
        // type is opened for its first bytes, once
        let expected_reads = usize::from(mime.starts_with("video/"));
        assert_eq!(
            reads.load(Ordering::SeqCst) - before,
            expected_reads,
            "{what}: archive reads for the refused write"
        );
    }

    // ---- 2. the three containers hold media -------------------------------------------
    for (what, name, mime, bytes) in [
        ("an mp4", "ok.mp4", "video/mp4", mp4()),
        (
            "a quicktime movie",
            "ok.mov",
            "video/quicktime",
            quicktime(),
        ),
        ("a webm", "ok.webm", "video/webm", webm()),
        // exactly the twelve bytes the check reads: a file no longer than its own prefix
        (
            "an mp4 of exactly twelve bytes",
            "min.mp4",
            "video/mp4",
            b"\0\0\0\x0cftypmp42".to_vec(),
        ),
    ] {
        let file = upload_and_complete(&http, &base, &alice, ws, ch, name, mime, &bytes).await;
        let answer = put_media(&http, &base, &alice, scope, &file, &body).await;
        assert_eq!(answer.status, 200, "{what}: {}", answer.refusal());
        assert_eq!(
            answer.json()["hasPoster"],
            json!(false),
            "{what}: no poster was sent"
        );
        assert_eq!(media_rows(&su, &file).await, 1);
    }

    // ---- 3. the numbers ----------------------------------------------------------------
    let clip = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "clip.mp4",
        "video/mp4",
        &mp4(),
    )
    .await;
    for (what, bad) in [
        (
            "a length of 0",
            json!({"durationMs": 0, "width": 640, "height": 360}),
        ),
        (
            "a length of 24 h + 1 ms",
            json!({"durationMs": 86_400_001_i64, "width": 640, "height": 360}),
        ),
        (
            "a negative length",
            json!({"durationMs": -5, "width": 640, "height": 360}),
        ),
        (
            "a width of 0",
            json!({"durationMs": 1000, "width": 0, "height": 360}),
        ),
        (
            "a height of 0",
            json!({"durationMs": 1000, "width": 640, "height": 0}),
        ),
        (
            "a width of 16,385",
            json!({"durationMs": 1000, "width": 16_385, "height": 360}),
        ),
        (
            "a height of 16,385",
            json!({"durationMs": 1000, "width": 640, "height": 16_385}),
        ),
    ] {
        let answer = put_media(&http, &base, &alice, scope, &clip, &bad).await;
        assert_eq!(
            answer.status,
            400,
            "{what}: {}",
            String::from_utf8_lossy(&answer.body)
        );
        assert_eq!(media_rows(&su, &clip).await, 0, "{what} left a row");
    }
    let edge = put_media(
        &http,
        &base,
        &alice,
        scope,
        &clip,
        &json!({"durationMs": 86_400_000_i64, "width": 16_384, "height": 16_384}),
    )
    .await;
    assert_eq!(
        edge.status,
        200,
        "the largest legal numbers pass: {}",
        edge.refusal()
    );
    let tiny = put_media(
        &http,
        &base,
        &alice,
        scope,
        &clip,
        &json!({"durationMs": 1, "width": 1, "height": 1}),
    )
    .await;
    assert_eq!(
        tiny.status,
        200,
        "the smallest legal numbers pass: {}",
        tiny.refusal()
    );
}

// ---------------------------------------------------------------------------
// D5 · reading the poster
// ---------------------------------------------------------------------------

/// **Red proof (D5 읽기).** The poster is as visible as the bytes and no more: every member and
/// every refusal the content route answers, the poster route answers the same way — a
/// non-member's 403, and **one** flat 404 for another member's draft, a deleted message's file
/// (whole or half a tombstone), another channel's file, a file that is not complete and an id
/// that never existed, byte for byte the content route's. The headers are the content route's
/// download rule. A readable file with nothing to show is a 404 of its own sentence.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_poster_route_is_the_content_route_for_everyone_else() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;
    let outsider = login(&http, &base, fixture.workspace, &fixture.outsider).await;
    let (ws, ch) = (fixture.workspace, fixture.channel);
    let scope = (ws, ch);
    let picture = jpeg(320, 180);
    let with_poster = media_body(Some(poster("image/jpeg", &picture)));
    let poster_of =
        |attachment: &str, channel: Uuid| attachment_url(&base, ws, channel, attachment, "poster");
    let content_of =
        |attachment: &str, channel: Uuid| attachment_url(&base, ws, channel, attachment, "content");

    let video = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "clip.mp4",
        "video/mp4",
        &mp4(),
    )
    .await;
    assert_eq!(
        put_media(&http, &base, &alice, scope, &video, &with_poster)
            .await
            .status,
        200
    );

    // ---- 1. an unsent draft is its uploader's alone ------------------------------------
    let own = get_as(&http, &poster_of(&video, ch), &alice).await;
    assert_eq!(own.status, 200);
    assert_eq!(
        own.body, picture,
        "the uploader gets the very bytes she sent"
    );
    assert_eq!(own.header("content-type"), "image/jpeg");
    assert_eq!(own.header("content-length"), picture.len().to_string());

    let unknown_id = Uuid::new_v4().to_string();
    let yardstick = get_as(&http, &poster_of(&unknown_id, ch), &bob).await;
    assert_eq!(yardstick.status, 404);
    assert_eq!(yardstick.refusal(), CONTENT_NOT_FOUND);
    let content_yardstick = get_as(&http, &content_of(&unknown_id, ch), &bob).await;
    assert_eq!(
        yardstick.body, content_yardstick.body,
        "the poster route's refusal is the content route's, word for word"
    );
    let draft = get_as(&http, &poster_of(&video, ch), &bob).await;
    assert_eq!(draft.status, 404, "another member's draft is not for bob");
    assert_eq!(
        draft.body, yardstick.body,
        "…and he cannot tell it from an id that does not exist"
    );
    assert_eq!(
        draft.body,
        get_as(&http, &content_of(&video, ch), &bob).await.body,
        "…the content route says exactly the same about the same draft"
    );

    // ---- 2. a person outside the channel -----------------------------------------------
    let outside = get_as(&http, &poster_of(&video, ch), &outsider).await;
    assert_eq!(outside.status, 403);
    assert_eq!(outside.refusal(), NOT_A_MEMBER);
    assert_eq!(
        outside.body,
        get_as(&http, &content_of(&video, ch), &outsider).await.body,
        "the 403 is the content route's, word for word"
    );

    // ---- 3. the send opens the file to the room, poster and bytes alike -----------------
    let (message, _) = post_with_files(&http, &base, &alice, ws, ch, "영상", None, &[&video]).await;
    let shared = get_as(&http, &poster_of(&video, ch), &bob).await;
    assert_eq!(shared.status, 200, "{}", shared.refusal());
    assert_eq!(shared.body, picture);
    // the download rule is the content route's: an attachment, never sniffed, never cached
    let bytes_route = get_as(&http, &content_of(&video, ch), &bob).await;
    assert_eq!(bytes_route.status, 200);
    for name in [
        "content-disposition",
        "x-content-type-options",
        "cache-control",
    ] {
        assert_eq!(
            shared.header(name),
            bytes_route.header(name),
            "{name} is the content route's, value for value"
        );
    }
    assert_eq!(shared.header("content-disposition"), "attachment");
    assert_eq!(shared.header("x-content-type-options"), "nosniff");
    let cache = shared.header("cache-control");
    assert!(
        cache.contains("private") && cache.contains("no-store") && cache.contains("no-transform"),
        "never cached, never rewritten by an edge: {cache:?}"
    );
    assert_eq!(
        shared.header("accept-ranges"),
        "",
        "a poster has no ranges to offer, so it does not say it has"
    );

    // ---- 4. the wrong channel ----------------------------------------------------------
    let elsewhere = get_as(&http, &poster_of(&video, fixture.other_channel), &bob).await;
    assert_eq!(
        elsewhere.status, 404,
        "a file is read through its own channel only"
    );
    assert_eq!(
        elsewhere.body,
        get_as(&http, &content_of(&video, fixture.other_channel), &bob)
            .await
            .body
    );

    // ---- 5. a deleted message's file, whole and half a tombstone -----------------------
    delete_message_as(&http, &base, &alice, ws, &message).await;
    for (who, token) in [("bob", &bob), ("the uploader", &alice)] {
        let gone = get_as(&http, &poster_of(&video, ch), token).await;
        assert_eq!(
            gone.status, 404,
            "{who} cannot read a deleted message's poster"
        );
        assert_eq!(
            gone.body, yardstick.body,
            "{who}: byte for byte an unknown id's 404"
        );
    }
    for (half, set_clause) in [
        ("deleted_at only", "deleted_at = now()"),
        ("state only", "state = 'deleted'"),
    ] {
        let file = upload_and_complete(
            &http,
            &base,
            &alice,
            ws,
            ch,
            "half.mp4",
            "video/mp4",
            &mp4(),
        )
        .await;
        assert_eq!(
            put_media(&http, &base, &alice, scope, &file, &with_poster)
                .await
                .status,
            200
        );
        let (message, _) =
            post_with_files(&http, &base, &alice, ws, ch, "반쪽", None, &[&file]).await;
        assert_eq!(
            get_as(&http, &poster_of(&file, ch), &bob).await.status,
            200,
            "control: {half} before the tombstone"
        );
        sqlx::query(&format!("UPDATE message SET {set_clause} WHERE id = $1"))
            .bind(Uuid::parse_str(&message).expect("uuid"))
            .execute(&su)
            .await
            .expect("half-tombstone");
        let gone = get_as(&http, &poster_of(&file, ch), &bob).await;
        assert_eq!(gone.status, 404, "a message with {half} is deleted");
        assert_eq!(gone.body, yardstick.body);
    }

    // ---- 6. a file that is not complete ------------------------------------------------
    let pending = upload_without_completing(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "half.mp4",
        "video/mp4",
        &mp4(),
    )
    .await;
    let not_done = get_as(&http, &poster_of(&pending, ch), &alice).await;
    assert_eq!(not_done.status, 404);
    assert_eq!(
        not_done.refusal(),
        CONTENT_NOT_FOUND,
        "a pending file is not content for anyone, its uploader included — the same sentence as the bytes"
    );

    // ---- 7. a readable file with nothing to show ----------------------------------------
    let unmeasured = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "plain.mp4",
        "video/mp4",
        &mp4(),
    )
    .await;
    let no_frame = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "noframe.mp4",
        "video/mp4",
        &mp4(),
    )
    .await;
    assert_eq!(
        put_media(&http, &base, &alice, scope, &no_frame, &media_body(None))
            .await
            .status,
        200
    );
    let document = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "notes.txt",
        "text/plain",
        b"notes",
    )
    .await;
    for (what, file) in [
        ("a video nobody measured", &unmeasured),
        ("a measurement without a frame", &no_frame),
        ("a document", &document),
    ] {
        let nothing = get_as(&http, &poster_of(file, ch), &alice).await;
        assert_eq!(nothing.status, 404, "{what}");
        assert_eq!(nothing.refusal(), NO_POSTER, "{what}");
    }
}

// ---------------------------------------------------------------------------
// D5 · what travels
// ---------------------------------------------------------------------------

/// **Red proof (D5 페이로드).** The summary — kind, length, size, whether there is a poster — is on
/// the send's own answer, the channel page, the thread page and the realtime frame (the outbox row);
/// the poster's bytes are on none of them. A photo, a document and a video nobody measured carry no
/// `media` key at all. And the team AI's read role — which runs the same page statements and may not
/// read the poster column — can still read a page that carries media.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_poster_is_never_in_a_payload() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;
    let (ws, ch) = (fixture.workspace, fixture.channel);
    let scope = (ws, ch);
    let picture = jpeg(320, 180);
    let picture_b64 = b64(&picture);
    let with_poster = media_body(Some(poster("image/jpeg", &picture)));
    let summary = json!({"kind": "video", "durationMs": 4200, "width": 1280, "height": 720, "hasPoster": true});
    // the first characters of a JPEG's base64 are the same for every JPEG (the header), so the
    // marker is taken from the middle of the picture
    let marker = &picture_b64[40..88];

    let measured = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "clip.mp4",
        "video/mp4",
        &mp4(),
    )
    .await;
    let unmeasured = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "plain.mp4",
        "video/mp4",
        &mp4(),
    )
    .await;
    let document = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "notes.txt",
        "text/plain",
        b"notes",
    )
    .await;
    assert_eq!(
        put_media(&http, &base, &alice, scope, &measured, &with_poster)
            .await
            .status,
        200
    );

    // ---- 1. the send echoes the summary on the measured video only -----------------------
    let (message, echo) = post_with_files(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "셋",
        None,
        &[&measured, &unmeasured, &document],
    )
    .await;
    let echoed = echo["attachments"].as_array().expect("attachments");
    assert_eq!(echoed.len(), 3);
    assert_eq!(
        echoed[0]["media"], summary,
        "the measured video carries its summary"
    );
    assert!(
        echoed[1].get("media").is_none(),
        "a video nobody measured has no media key: {}",
        echoed[1]
    );
    assert!(
        echoed[2].get("media").is_none(),
        "a document has no media key: {}",
        echoed[2]
    );
    assert_eq!(
        echoed[0].as_object().expect("object").len(),
        5,
        "id, name, mime, sizeBytes, media"
    );

    // ---- 2. the channel page ------------------------------------------------------------
    let page = get_json(&http, &messages_url(&base, ws, ch), &bob).await;
    let row = row_of(&page, &message);
    assert_eq!(row["attachments"][0]["media"], summary);
    assert!(row["attachments"][1].get("media").is_none());
    assert!(row["attachments"][2].get("media").is_none());

    // ---- 3. the thread page -------------------------------------------------------------
    let reply_video = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "reply.mp4",
        "video/mp4",
        &mp4(),
    )
    .await;
    assert_eq!(
        put_media(&http, &base, &alice, scope, &reply_video, &with_poster)
            .await
            .status,
        200
    );
    let (reply, _) = post_with_files(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "답글",
        Some(&message),
        &[&reply_video],
    )
    .await;
    let thread = get_json(
        &http,
        &format!("{}/{message}/replies", messages_url(&base, ws, ch)),
        &bob,
    )
    .await;
    assert_eq!(row_of(&thread, &reply)["attachments"][0]["media"], summary);

    // ---- 4. the realtime frame (the outbox row) -----------------------------------------
    let frame: Value = sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND partition_key = $2 \
            AND payload->'data'->'payload'->>'id' = $3 \
          ORDER BY id DESC LIMIT 1",
    )
    .bind(ws)
    .bind(ch)
    .bind(&message)
    .fetch_one(&su)
    .await
    .expect("the message.new outbox row");
    assert_eq!(frame["data"]["payload"]["attachments"][0]["media"], summary);
    assert!(frame["data"]["payload"]["attachments"][1]
        .get("media")
        .is_none());

    // ---- 5. the picture is on none of them ----------------------------------------------
    for (surface, text) in [
        ("the send's answer", echo.to_string()),
        ("the channel page", page.to_string()),
        ("the thread page", thread.to_string()),
        ("the outbox row", frame.to_string()),
    ] {
        assert!(
            !text.contains(marker),
            "{surface} carries the poster's bytes"
        );
        for forbidden in ["dataBase64", "poster_bytes", "posterBytes", "poster_mime"] {
            assert!(
                !text.contains(forbidden),
                "{surface} names {forbidden}: {text}"
            );
        }
    }

    // ---- 6. the team AI's read role reads the same page -----------------------------------
    let helper_page = momo_db::with_tenant_tx(&su, ws, move |conn| {
        Box::pin(async move {
            momo_workspace_actions::team_ai_tools::enter_helper_read_role(conn).await?;
            momo_messaging::list_channel_page(conn, ch, HistoryCursor::Newest, 50).await
        })
    })
    .await
    .expect("the helper role reads a page that carries media (it may not read the poster column)");
    let media = helper_page
        .iter()
        .find(|paged| paged.message.id.to_string() == message)
        .and_then(|paged| paged.attachments.first())
        .and_then(|attachment| attachment.media.clone())
        .expect("the helper's page carries the summary too");
    assert_eq!(
        (
            media.duration_ms,
            media.width,
            media.height,
            media.has_poster
        ),
        (4200, 1280, 720, true)
    );
    let denied = momo_db::with_tenant_tx(&su, ws, |conn| {
        Box::pin(async move {
            momo_workspace_actions::team_ai_tools::enter_helper_read_role(conn).await?;
            sqlx::query("SELECT poster_bytes FROM attachment_media")
                .fetch_all(&mut *conn)
                .await?;
            Ok(())
        })
    })
    .await
    .expect_err("the helper role may not read the poster column");
    assert!(
        denied.to_string().contains("permission denied"),
        "refused by the privilege, not by something else: {denied}"
    );
}

// ---------------------------------------------------------------------------
// D5 · the row follows its attachment
// ---------------------------------------------------------------------------

async fn reclaim_once(
    app: &PgPool,
    workspace: Uuid,
    attachment: Uuid,
    calls: &Arc<Mutex<Vec<String>>>,
) -> AttachmentReclaimOutcome {
    let calls = Arc::clone(calls);
    momo_db::with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            reclaim_unbound_attachment_in_tx(
                conn,
                workspace,
                attachment,
                UNBOUND_TTL,
                move |file_id| {
                    let file_id = file_id.to_string();
                    Box::pin(async move {
                        calls.lock().expect("calls").push(file_id);
                        DriveDelete::Deleted
                    })
                },
            )
            .await
        })
    })
    .await
    .expect("reclaim transaction")
}

/// **Red proof (D5 회수).** The media row is the attachment's: when the attachment row goes — here
/// through the real reclaim sweep, running as `momo_app` which holds no DELETE on the media table —
/// the media row and its poster go with it. A foreign key that does not cascade would make the
/// sweep's own delete fail and the file would never be collected.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn media_rows_follow_the_attachment() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let (ws, ch) = (fixture.workspace, fixture.channel);
    let video =
        upload_and_complete(&http, &base, &alice, ws, ch, "old.mp4", "video/mp4", &mp4()).await;
    let answer = put_media(
        &http,
        &base,
        &alice,
        (ws, ch),
        &video,
        &media_body(Some(poster("image/jpeg", &jpeg(160, 90)))),
    )
    .await;
    assert_eq!(answer.status, 200);
    assert_eq!(media_rows(&su, &video).await, 1, "control: the row exists");

    // an unsent draft nobody touched for longer than the reclaim's grace
    let video_id = Uuid::parse_str(&video).expect("uuid");
    sqlx::query("UPDATE attachment SET created_at = now() - interval '40 days' WHERE id = $1")
        .bind(video_id)
        .execute(&su)
        .await
        .expect("age the draft");
    let calls = Arc::new(Mutex::new(Vec::new()));
    let outcome = reclaim_once(&app_pool, ws, video_id, &calls).await;
    assert_eq!(outcome, AttachmentReclaimOutcome::Reclaimed);
    assert_eq!(
        calls.lock().expect("calls").len(),
        1,
        "the archive object was deleted too"
    );
    let attachments: i64 = sqlx::query_scalar("SELECT count(*) FROM attachment WHERE id = $1")
        .bind(video_id)
        .fetch_one(&su)
        .await
        .expect("count");
    assert_eq!(attachments, 0, "the attachment row is gone");
    assert_eq!(
        media_rows(&su, &video).await,
        0,
        "…and its media row and poster went with it"
    );
}

// ---------------------------------------------------------------------------
// D5 · the write and the send are ordered, and the write has a budget (review r1 M-1, M-2)
// ---------------------------------------------------------------------------

/// The row of the media table and the summary the room was told, side by side.
fn summary_of(echo: &Value) -> Option<Value> {
    echo["attachments"][0].get("media").cloned()
}

async fn message_frame(su: &PgPool, ws: Uuid, ch: Uuid, message: &str) -> Value {
    sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND partition_key = $2 \
            AND payload->'data'->'payload'->>'id' = $3 \
          ORDER BY id DESC LIMIT 1",
    )
    .bind(ws)
    .bind(ch)
    .bind(message)
    .fetch_one(su)
    .await
    .expect("the message.new outbox row")
}

/// **Red proof (review r1 M-2, the lock).** A send that arrives while a media write is in flight is
/// ordered with it, never interleaved: the write holds the attachment row `FOR UPDATE` from before
/// its INSERT, the send takes the same lock to bind the file, so the send **waits** and then carries
/// what the write stored. Without the lock the send binds and answers at once, the room is told a
/// file with no `media`, and the write lands afterwards — the numbers and the poster of a sent file
/// change after the room saw it.
///
/// The write's INSERT is slowed by a trigger that sleeps (for this one file only), so its
/// transaction is open while the send arrives; the test waits until the database says the write's
/// backend is asleep in it before it sends, so the order is made, not hoped for. The trigger and its
/// function are dropped as soon as the race is over.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_send_arriving_mid_write_waits_for_it_and_carries_what_it_wrote() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let (ws, ch) = (fixture.workspace, fixture.channel);
    let video = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "race.mp4",
        "video/mp4",
        &mp4(),
    )
    .await;
    let video_id = Uuid::parse_str(&video).expect("uuid");

    // slow the write's INSERT, for this file only
    let function = format!("c5_slow_media_{}", Uuid::new_v4().simple());
    sqlx::query(&format!(
        "CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF NEW.attachment_id = '{video_id}' THEN PERFORM pg_sleep(1.5); END IF; RETURN NEW; END $$"
    ))
    .execute(&su)
    .await
    .expect("slow function");
    sqlx::query(&format!(
        "CREATE TRIGGER {function} BEFORE INSERT OR UPDATE ON attachment_media \
         FOR EACH ROW EXECUTE FUNCTION {function}()"
    ))
    .execute(&su)
    .await
    .expect("slow trigger");

    let put = {
        let (http, base, alice, video) = (http.clone(), base.clone(), alice.clone(), video.clone());
        tokio::spawn(async move {
            put_media(
                &http,
                &base,
                &alice,
                (ws, ch),
                &video,
                &json!({"durationMs": 1111, "width": 640, "height": 360}),
            )
            .await
        })
    };
    // wait until the write's backend is asleep inside its INSERT
    let mut asleep = false;
    for _ in 0..250 {
        let sleepers: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity \
              WHERE datname = current_database() AND wait_event = 'PgSleep' \
                AND query LIKE '%INSERT INTO attachment_media%'",
        )
        .fetch_one(&su)
        .await
        .expect("activity");
        if sleepers > 0 {
            asleep = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    let sent_at = std::time::Instant::now();
    let (message, echo) = if asleep {
        post_with_files(
            &http,
            &base,
            &alice,
            ws,
            ch,
            "mid-write send",
            None,
            &[&video],
        )
        .await
    } else {
        (String::new(), Value::Null)
    };
    let waited = sent_at.elapsed();
    let put = put.await.expect("join the write");

    // the race is over: take the trigger away before anything can fail
    sqlx::query(&format!("DROP TRIGGER {function} ON attachment_media"))
        .execute(&su)
        .await
        .expect("drop trigger");
    sqlx::query(&format!("DROP FUNCTION {function}()"))
        .execute(&su)
        .await
        .expect("drop function");

    assert!(
        asleep,
        "the write reached its INSERT and slept there (the premise of the race)"
    );
    assert_eq!(put.status, 200, "{}", put.refusal());
    assert!(
        waited >= std::time::Duration::from_millis(300),
        "the send waited for the write's lock instead of racing past it (took {waited:?})"
    );
    let row = media_row(&su, &video).await.expect("the write is stored");
    assert_eq!((row.0, row.1, row.2), (1111, 640, 360));
    let frame = message_frame(&su, ws, ch, &message).await;
    let told = summary_of(&echo).expect("the send's answer carries what the write stored");
    assert_eq!(
        told["durationMs"],
        json!(row.0),
        "the send's answer and the table agree"
    );
    assert_eq!(
        frame["data"]["payload"]["attachments"][0].get("media"),
        Some(&told),
        "the room's frame says what the send's answer says"
    );
}

/// **Red proof (review r1 M-2, the second look).** The write checks the file twice, once before it
/// reads the object and once in the transaction that writes. A send that binds the file in between
/// must leave the write **refused** — nothing stored, the same flat 404 — because by then the room
/// has seen the file as it was. The archive read is held at exactly that moment (a gate on the
/// object), the send goes through, and only then is the read let go.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_send_that_wins_while_the_object_is_read_leaves_the_write_refused() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let gate = Arc::new(Gate::default());
    let (base, reads) =
        start_counting_server_with(app_pool.clone(), None, Some(gate.clone())).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let (ws, ch) = (fixture.workspace, fixture.channel);
    let video = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "gated.mp4",
        "video/mp4",
        &mp4(),
    )
    .await;
    let drive_file: String =
        sqlx::query_scalar("SELECT drive_file_id FROM attachment WHERE id = $1")
            .bind(Uuid::parse_str(&video).expect("uuid"))
            .fetch_one(&su)
            .await
            .expect("drive file id");
    *gate.file_id.lock().expect("gate") = Some(drive_file);

    let put = {
        let (http, base, alice, video) = (http.clone(), base.clone(), alice.clone(), video.clone());
        tokio::spawn(async move {
            put_media(
                &http,
                &base,
                &alice,
                (ws, ch),
                &video,
                &media_body(Some(poster("image/jpeg", &jpeg(160, 90)))),
            )
            .await
        })
    };
    // the write has passed its first look and is reading the object
    tokio::time::timeout(std::time::Duration::from_secs(10), gate.entered.notified())
        .await
        .expect("the write reached the archive read");
    assert_eq!(reads.load(Ordering::SeqCst), 1);

    // the send binds the file now
    let (message, echo) = post_with_files(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "wins the race",
        None,
        &[&video],
    )
    .await;
    gate.release.notify_one();
    let put = put.await.expect("join the write");

    assert_eq!(put.status, 404, "the write finds the file already sent");
    assert_eq!(put.refusal(), CONTENT_NOT_FOUND);
    assert_eq!(
        media_row(&su, &video).await,
        None,
        "nothing was stored for a file a message already carries"
    );
    assert!(
        summary_of(&echo).is_none(),
        "the send's answer had no media: {echo}"
    );
    let frame = message_frame(&su, ws, ch, &message).await;
    assert!(
        frame["data"]["payload"]["attachments"][0]
            .get("media")
            .is_none(),
        "…and neither did the room's frame, which still tells the truth about the table"
    );
}

/// **Red proof (review r1 M-1).** The media write spends a per-member budget of its own, before the
/// body is read: with a budget of three, the fourth write in the window answers 429 with
/// `Retry-After` and the standard body, stores nothing and **never reaches the archive**, and leaves
/// one audit row naming the surface. The budget is the member's own (another member writes freely)
/// and is not the upload start's (starting an upload is still allowed at the moment the media
/// writes are refused).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_media_write_spends_a_member_budget_of_its_own() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let limits = RateLimitConfig {
        media_write_per_member_limit: 3,
        ..RateLimitConfig::default()
    };
    let (base, reads) = start_counting_server_with(app_pool.clone(), Some(limits), None).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;
    let (ws, ch) = (fixture.workspace, fixture.channel);
    let scope = (ws, ch);
    let video = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "loop.mp4",
        "video/mp4",
        &mp4(),
    )
    .await;
    let write = |duration: i64| json!({"durationMs": duration, "width": 640, "height": 360});

    // ---- 1. three writes are inside the budget ------------------------------------------
    for duration in [1001, 1002, 1003] {
        let answer = put_media(&http, &base, &alice, scope, &video, &write(duration)).await;
        assert_eq!(answer.status, 200, "{duration}: {}", answer.refusal());
    }
    assert_eq!(reads.load(Ordering::SeqCst), 3);

    // ---- 2. the fourth is the first over: 429, nothing stored, the archive never asked ----
    let refused = put_media(&http, &base, &alice, scope, &video, &write(7777)).await;
    assert_eq!(refused.status, 429, "the fourth write in the window");
    let retry_after: u64 = refused
        .header("retry-after")
        .parse()
        .expect("a 429 carries Retry-After in whole seconds");
    assert!((1..=60).contains(&retry_after), "Retry-After {retry_after}");
    assert_eq!(
        refused.json(),
        json!({"error": {"message": "rate limit exceeded"}}),
        "the standard envelope every other limiter here answers"
    );
    assert_eq!(
        media_row(&su, &video).await.map(|row| row.0),
        Some(1003),
        "the refused write stored nothing: the row is the third write's"
    );
    assert_eq!(
        reads.load(Ordering::SeqCst),
        3,
        "a refused write never reaches the archive"
    );
    // a refused request is counted too: the gate runs before the body is read, so even a body that
    // would be a 400 is a 429 now (the budget is spent on requests, not on good requests)
    let junk = put_media(
        &http,
        &base,
        &alice,
        scope,
        &video,
        &json!({"durationMs": 0}),
    )
    .await;
    assert_eq!(junk.status, 429);

    // ---- 3. one audit row names the surface -----------------------------------------------
    let audits: Vec<Value> = sqlx::query_scalar(
        "SELECT detail FROM audit_log \
          WHERE workspace_id = $1 AND actor_member_id = $2 AND action = 'rate_limit.exceeded'",
    )
    .bind(ws)
    .bind(fixture.alice.member)
    .fetch_all(&su)
    .await
    .expect("audit rows");
    assert_eq!(audits.len(), 1, "a burst leaves one row: {audits:?}");
    assert_eq!(audits[0]["surface"], json!("media_write"));
    assert_eq!(audits[0]["limit"], json!(3));
    assert_eq!(audits[0]["kind"], json!("human"));

    // ---- 4. the budget is the member's own and the surface's own ---------------------------
    let bobs =
        upload_and_complete(&http, &base, &bob, ws, ch, "bobs.mp4", "video/mp4", &mp4()).await;
    let answer = put_media(&http, &base, &bob, scope, &bobs, &write(2001)).await;
    assert_eq!(
        answer.status,
        200,
        "another member's budget is untouched: {}",
        answer.refusal()
    );
    let started = http
        .post(uploads_url(&base, ws, ch))
        .bearer_auth(&alice)
        .json(&json!({"name": "next.mp4", "mime": "video/mp4", "size": 10}))
        .send()
        .await
        .expect("start another upload");
    assert_eq!(
        started.status(),
        201,
        "starting an upload is a different budget: it is still open while the media writes are refused"
    );
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

/// The `attachment_media` table is a tenant table like every other: `workspace_id` on the row, RLS
/// enabled **and forced**, the `ws_isolation` policy on both the read and the write side, a foreign
/// key that cannot point across tenants, and no privilege the code does not use.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_media_table_is_tenant_scoped_and_locked_down() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();

    // ---- 1. the shape: a workspace_id column, RLS enabled and forced, ws_isolation ------
    let column: (String, String) = sqlx::query_as(
        "SELECT data_type, is_nullable FROM information_schema.columns \
          WHERE table_schema = 'public' AND table_name = 'attachment_media' AND column_name = 'workspace_id'",
    )
    .fetch_one(&su)
    .await
    .expect("workspace_id column");
    assert_eq!(column, ("uuid".to_string(), "NO".to_string()));
    let flags: (bool, bool) = sqlx::query_as(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class \
          WHERE oid = 'public.attachment_media'::regclass",
    )
    .fetch_one(&su)
    .await
    .expect("rls flags");
    assert_eq!(flags, (true, true), "RLS is enabled and FORCED");
    let policies: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT polname::text, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid) \
           FROM pg_policy WHERE polrelid = 'public.attachment_media'::regclass",
    )
    .fetch_all(&su)
    .await
    .expect("policies");
    assert_eq!(policies.len(), 1, "exactly one policy: {policies:?}");
    let (name, using, check) = &policies[0];
    assert_eq!(name, "ws_isolation");
    for (side, expr) in [("USING", using), ("WITH CHECK", check)] {
        let expr = expr.as_deref().unwrap_or_default();
        assert!(
            expr.contains("workspace_id") && expr.contains("app.workspace_id"),
            "{side} must bind workspace_id to the tenant GUC: {expr:?}"
        );
    }

    // ---- 2. two tenants, each with a media row ------------------------------------------
    let one = seed(&su, &app_pool).await;
    let two = seed(&su, &app_pool).await;
    let mut files = Vec::new();
    let mut tokens = Vec::new();
    for fixture in [&one, &two] {
        let token = login(&http, &base, fixture.workspace, &fixture.alice).await;
        tokens.push(token.clone());
        let file = upload_and_complete(
            &http,
            &base,
            &token,
            fixture.workspace,
            fixture.channel,
            "clip.mp4",
            "video/mp4",
            &mp4(),
        )
        .await;
        let answer = put_media(
            &http,
            &base,
            &token,
            (fixture.workspace, fixture.channel),
            &file,
            &media_body(Some(poster("image/jpeg", &jpeg(64, 64)))),
        )
        .await;
        assert_eq!(answer.status, 200);
        files.push(file);
    }
    let (file_one, file_two) = (
        Uuid::parse_str(&files[0]).expect("uuid"),
        Uuid::parse_str(&files[1]).expect("uuid"),
    );

    // the role the server runs as is the RLS-bound one the ADR requires
    let flags: (bool, bool) =
        sqlx::query_as("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
            .fetch_one(&app_pool)
            .await
            .expect("the app role's flags");
    assert_eq!(
        flags,
        (false, false),
        "the server's pool is neither superuser nor BYPASSRLS"
    );

    // ---- the routes across the tenant line ------------------------------------------------
    // tenant two's person asks, through her own workspace, for tenant one's file and channel: the
    // channel is not in her workspace, so she is no member of it (403), for the write and the read
    // alike; and through tenant one's workspace her credential is for another workspace (403)
    let before = media_row(&su, &files[0]).await;
    let stranger = put_media(
        &http,
        &base,
        &tokens[1],
        (two.workspace, one.channel),
        &files[0],
        &media_body(None),
    )
    .await;
    assert_eq!(stranger.status, 403, "{}", stranger.refusal());
    assert_eq!(stranger.refusal(), NOT_A_MEMBER);
    let poster_of_one = attachment_url(&base, two.workspace, one.channel, &files[0], "poster");
    assert_eq!(get_as(&http, &poster_of_one, &tokens[1]).await.status, 403);
    for (method, leaf) in [("PUT", "media"), ("GET", "poster")] {
        let url = attachment_url(&base, one.workspace, one.channel, &files[0], leaf);
        let request = if method == "PUT" {
            http.put(&url).json(&media_body(None))
        } else {
            http.get(&url)
        };
        let answer = request
            .bearer_auth(&tokens[1])
            .send()
            .await
            .expect("cross-tenant");
        assert_eq!(
            answer.status(),
            403,
            "{method} {leaf} with another workspace's credential"
        );
    }
    assert_eq!(
        media_row(&su, &files[0]).await,
        before,
        "nothing was written across the line"
    );

    // tenant one sees one row — its own — through the RLS-bound role
    let seen: Vec<Uuid> = momo_db::with_tenant_tx(&app_pool, one.workspace, |conn| {
        Box::pin(async move {
            Ok(
                sqlx::query_scalar("SELECT attachment_id FROM attachment_media")
                    .fetch_all(&mut *conn)
                    .await?,
            )
        })
    })
    .await
    .expect("read as tenant one");
    assert_eq!(
        seen,
        vec![file_one],
        "a tenant sees its own media rows and no other's"
    );

    // a row for another tenant cannot be written from this one (the WITH CHECK)
    let cross_write = momo_db::with_tenant_tx(&app_pool, one.workspace, move |conn| {
        let target = two.workspace;
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO attachment_media (workspace_id, attachment_id, duration_ms, width, height) \
                 VALUES ($1, $2, 1000, 64, 64) ON CONFLICT DO NOTHING",
            )
            .bind(target)
            .bind(Uuid::new_v4())
            .execute(&mut *conn)
            .await?;
            Ok(())
        })
    })
    .await
    .expect_err("a tenant cannot write a row for another tenant");
    assert!(
        cross_write.to_string().contains("row-level security"),
        "refused by the policy: {cross_write}"
    );

    // a row of this tenant cannot point at another tenant's attachment (the composite FK)
    let cross_point = momo_db::with_tenant_tx(&app_pool, one.workspace, move |conn| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO attachment_media (workspace_id, attachment_id, duration_ms, width, height) \
                 VALUES ($1, $2, 1000, 64, 64)",
            )
            .bind(one.workspace)
            .bind(file_two)
            .execute(&mut *conn)
            .await?;
            Ok(())
        })
    })
    .await
    .expect_err("a media row cannot point at another tenant's attachment");
    assert!(
        cross_point.to_string().contains("foreign key"),
        "refused by the composite foreign key: {cross_point}"
    );

    // ---- 3. no privilege the code does not use ------------------------------------------
    let app: (bool, bool, bool, bool, bool) = sqlx::query_as(
        "SELECT has_table_privilege('momo_app', 'public.attachment_media', 'SELECT'), \
                has_table_privilege('momo_app', 'public.attachment_media', 'INSERT'), \
                has_table_privilege('momo_app', 'public.attachment_media', 'UPDATE'), \
                has_table_privilege('momo_app', 'public.attachment_media', 'DELETE'), \
                has_table_privilege('momo_app', 'public.attachment_media', 'TRUNCATE')",
    )
    .fetch_one(&su)
    .await
    .expect("momo_app privileges");
    assert_eq!(
        app,
        (true, true, true, false, false),
        "momo_app: SELECT, INSERT, UPDATE and nothing more"
    );
    let delete = momo_db::with_tenant_tx(&app_pool, one.workspace, |conn| {
        Box::pin(async move {
            sqlx::query("DELETE FROM attachment_media WHERE false")
                .execute(&mut *conn)
                .await?;
            Ok(())
        })
    })
    .await
    .expect_err("nobody deletes a media row by hand");
    assert!(delete.to_string().contains("permission denied"), "{delete}");
    for role in ["momo_relay", "momo_worker", "momo_notifier"] {
        let any: bool = sqlx::query_scalar(
            "SELECT has_any_column_privilege($1, 'public.attachment_media', 'SELECT') \
                 OR has_table_privilege($1, 'public.attachment_media', 'INSERT') \
                 OR has_table_privilege($1, 'public.attachment_media', 'UPDATE') \
                 OR has_table_privilege($1, 'public.attachment_media', 'DELETE')",
        )
        .bind(role)
        .fetch_one(&su)
        .await
        .expect("role privileges");
        assert!(!any, "{role} must hold nothing on attachment_media");
    }
}
