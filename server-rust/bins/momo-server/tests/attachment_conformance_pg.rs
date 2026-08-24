//! Attachment conformance (ADR-0151 D1/D3) — the three Drive routes and the
//! message binding, driven over real HTTP against a real Postgres.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test attachment_conformance_pg -- --ignored --nocapture
//! ```
//!
//! **No real Drive is touched, ever.** The archive is `momo_drive`'s in-process
//! stub, whose upload capability URL points back at this server's own
//! `/__momo_stub/drive/uploads/{token}` route — so the full session → upload →
//! complete → bind → download round trip runs with no credential and no network.
//! One test swaps in an archive of its own to make Drive *disagree* with what was
//! declared, which is the only way to reach the completion route's mismatch
//! branch (the stub cannot contradict itself; see `momo_drive::stub`).
//!
//! Harness contract is `http_smoke_pg.rs`'s: `DATABASE_URL` is a superuser (for
//! migrations and fixture seeding), the server runs as `momo_app`
//! (NOBYPASSRLS), so every assertion below is made through the RLS policies
//! production uses.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_drive::{
    DriveArchive, DriveContent, DriveError, DriveFile, DriveUploadSession, LocalDriveArchive,
    StubDriveArchive,
};
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "attachment-conformance-signing-secret";
const TEST_PASSWORD: &str = "attachment-conformance-password";

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
        "/../../../infra/e2e/bootstrap_roles.sql"
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

/// Boot the real router with `archive` on an ephemeral port.
///
/// The listener is bound **first** so the stub can be told the address it must
/// hand out — its upload URLs point back at this very process, and a stub that
/// advertised the wrong port would make every upload in this file a 404 with no
/// hint as to why.
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

async fn start_server(pool: PgPool) -> String {
    start_server_with(pool, |base| Arc::new(StubDriveArchive::new(&base)))
        .await
        .0
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
    /// Another channel in the same workspace — the "wrong channel" case.
    other_channel: Uuid,
    /// The uploader.
    alice: Person,
    /// Another member of the same channel: may download, may not bind.
    bob: Person,
    /// A member of the workspace who is in NO channel.
    outsider: Person,
}

async fn seed_person(su: &PgPool, workspace: Uuid) -> Person {
    let member = Uuid::new_v4();
    let email = format!("{member}@attach.test");
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
            name: format!("attach-{}", Uuid::new_v4()),
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
            name: format!("attach-other-{}", Uuid::new_v4()),
            topic: None,
            created_by: alice.member,
        },
    )
    .await
    .expect("create other channel");

    // Bob joins the main channel; the outsider joins nothing.
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

// ---------------------------------------------------------------------------
// the round trip
// ---------------------------------------------------------------------------

/// The whole contract in one pass: all three routes, the message binding, and
/// every read surface that carries the result.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_three_routes_round_trip_and_bind_to_a_message() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;

    const BYTES: &[u8] = "보고서 본문입니다".as_bytes();

    // ---- 1. the session ---------------------------------------------------
    let created = http
        .post(uploads_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&alice)
        .json(&json!({"name": "보고서.txt", "mime": "TEXT/PLAIN", "size": BYTES.len()}))
        .send()
        .await
        .expect("create upload");
    assert_eq!(created.status(), 201);
    let created: Value = created.json().await.expect("body");
    let attachment_id = created["id"].as_str().expect("id").to_string();
    assert_eq!(created["status"], json!("pending"));
    let upload_url = created["uploadUrl"]
        .as_str()
        .expect("uploadUrl")
        .to_string();
    assert!(
        upload_url.contains("/__momo_stub/drive/uploads/"),
        "the client is handed the ARCHIVE's URL, not one of ours: {upload_url}"
    );

    // The row exists, is pending, names a Drive file, and belongs to Alice.
    let row = sqlx::query(
        "SELECT status, uploader_member_id, channel_id, message_id, drive_file_id, mime \
           FROM attachment WHERE id = $1",
    )
    .bind(Uuid::parse_str(&attachment_id).expect("uuid"))
    .fetch_one(&su)
    .await
    .expect("pending row");
    assert_eq!(row.get::<String, _>("status"), "pending");
    assert_eq!(
        row.get::<Uuid, _>("uploader_member_id"),
        fixture.alice.member
    );
    assert_eq!(row.get::<Uuid, _>("channel_id"), fixture.channel);
    assert!(row.get::<Option<Uuid>, _>("message_id").is_none());
    assert!(row.get::<Option<String>, _>("drive_file_id").is_some());
    assert_eq!(
        row.get::<String, _>("mime"),
        "text/plain",
        "the stored mime is lowercased — it is what Drive is compared against"
    );

    // The audit trail opens with the session, not with the completion.
    let started: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE action = 'attachment.upload_started' AND target_id = $1 \
            AND actor_member_id = $2 AND detail->>'schema' = 'momo.attachment.upload_started.v1'",
    )
    .bind(Uuid::parse_str(&attachment_id).expect("uuid"))
    .bind(fixture.alice.member)
    .fetch_one(&su)
    .await
    .expect("audit count");
    assert_eq!(started, 1, "the session is audited when it is created");

    // ---- 2. completing before the bytes land is a 404 ---------------------
    let complete_url = format!(
        "{base}/v1/workspaces/{}/channels/{}/attachments/{attachment_id}/complete",
        fixture.workspace, fixture.channel
    );
    let premature = http
        .post(&complete_url)
        .bearer_auth(&alice)
        .send()
        .await
        .expect("premature complete");
    assert_eq!(
        premature.status(),
        404,
        "the archive has no such file yet, so neither does this route"
    );

    // ---- 3. the bytes bypass the server ----------------------------------
    let uploaded = http
        .put(&upload_url)
        .header(reqwest::header::CONTENT_TYPE, "text/plain")
        .body(BYTES.to_vec())
        .send()
        .await
        .expect("upload");
    assert_eq!(uploaded.status(), 200);

    // ---- 4. completion ---------------------------------------------------
    let completed = http
        .post(&complete_url)
        .bearer_auth(&alice)
        .send()
        .await
        .expect("complete");
    assert_eq!(completed.status(), 200);
    let completed: Value = completed.json().await.expect("body");
    assert_eq!(completed["status"], json!("complete"));
    assert_eq!(completed["id"], json!(attachment_id));
    assert_eq!(completed["channelId"], json!(fixture.channel.to_string()));
    assert_eq!(
        completed["uploaderMemberId"],
        json!(fixture.alice.member.to_string())
    );
    assert_eq!(completed["size"], json!(BYTES.len()));
    assert!(
        completed.get("messageId").is_none(),
        "nothing is bound yet, so the key is absent rather than null: {completed}"
    );
    assert!(
        completed.get("driveFileId").is_none() && completed.get("uploadUrl").is_none(),
        "ADR-0151 D3: no archive identifier reaches a client: {completed}"
    );

    // Idempotent.
    let again = http
        .post(&complete_url)
        .bearer_auth(&alice)
        .send()
        .await
        .expect("complete again");
    assert_eq!(
        again.status(),
        200,
        "completing a complete attachment is a no-op"
    );

    // ---- 5. binding to a message -----------------------------------------
    let client_msg_id = Uuid::new_v4();
    let sent = http
        .post(messages_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&alice)
        .json(&json!({
            "clientMsgId": client_msg_id,
            "type": "text",
            "body": "자료 붙였습니다",
            "attachmentIds": [attachment_id],
        }))
        .send()
        .await
        .expect("send with attachment");
    assert_eq!(sent.status(), 201, "attachmentIds is served now");
    let sent: Value = sent.json().await.expect("send body");
    let message_id = sent["id"].as_str().expect("message id").to_string();
    assert_eq!(
        sent["attachments"][0]["id"],
        json!(attachment_id),
        "the send echoes what it just bound: {sent}"
    );
    assert_eq!(sent["attachments"][0]["name"], json!("보고서.txt"));
    assert_eq!(sent["attachments"][0]["mime"], json!("text/plain"));
    assert_eq!(sent["attachments"][0]["sizeBytes"], json!(BYTES.len()));

    // ---- 6. the realtime frame carries it too ----------------------------
    let payload: Value = sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND partition_key = $2 \
            AND payload->'data'->'payload'->>'id' = $3 \
          ORDER BY id DESC LIMIT 1",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .bind(&message_id)
    .fetch_one(&su)
    .await
    .expect("outbox row");
    let frame = &payload["data"]["payload"];
    assert_eq!(payload["data"]["type"], json!("message.new"));
    assert_eq!(
        frame["attachments"][0]["id"],
        json!(attachment_id),
        "invariant #3: the SAME transaction wrote the binding and this frame: {payload}"
    );
    assert_eq!(frame["attachments"][0]["sizeBytes"], json!(BYTES.len()));

    // ---- 7. the read surfaces --------------------------------------------
    let page = http
        .get(messages_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&bob)
        .send()
        .await
        .expect("history");
    assert_eq!(page.status(), 200);
    let page: Value = page.json().await.expect("history body");
    let first = &page["messages"][0];
    assert_eq!(first["id"], json!(message_id));
    assert_eq!(
        first["attachments"][0]["id"],
        json!(attachment_id),
        "history projects attachments too — a reload must not lose the file card"
    );

    // A message with no attachments omits the key entirely (openapi minItems: 1).
    let plain = http
        .post(messages_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&alice)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "type": "text", "body": "그냥 말"}))
        .send()
        .await
        .expect("plain send");
    let plain: Value = plain.json().await.expect("plain body");
    assert!(
        plain.get("attachments").is_none(),
        "an empty array is omitted, not sent: {plain}"
    );

    // ---- 8. the content proxy --------------------------------------------
    let content_url = format!(
        "{base}/v1/workspaces/{}/channels/{}/attachments/{attachment_id}/content",
        fixture.workspace, fixture.channel
    );
    // Bob did not upload it, but he is in the room.
    let downloaded = http
        .get(&content_url)
        .bearer_auth(&bob)
        .send()
        .await
        .expect("content");
    assert_eq!(
        downloaded.status(),
        200,
        "any active member of the channel may read a completed attachment"
    );
    let headers = downloaded.headers().clone();
    assert_eq!(
        headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("text/plain")
    );
    assert_eq!(
        headers
            .get("x-content-type-options")
            .and_then(|value| value.to_str().ok()),
        Some("nosniff"),
        "caller-supplied bytes served from our own origin must never be sniffed"
    );
    assert!(
        headers
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("attachment")),
        "an uploaded .html must download, not render as same-origin content"
    );
    assert_eq!(
        downloaded.bytes().await.expect("bytes").as_ref(),
        BYTES,
        "the bytes come back byte-for-byte"
    );

    // ---- 9. no credential, no bytes --------------------------------------
    let anonymous = http.get(&content_url).send().await.expect("anonymous");
    assert_eq!(anonymous.status(), 401, "the proxy is not a public URL");
}

// ---------------------------------------------------------------------------
// red proof 1 — an attachment belongs to its uploader
// ---------------------------------------------------------------------------

/// **Red proof.** Bob may read Alice's attachment, but he may not attach it to a
/// message of his own — and the refusal takes his message with it.
///
/// Delete the `uploader != uploader_member_id` guard in
/// `momo_messaging::attachment::link_attachments_in_tx` and this goes red twice:
/// the status becomes 201, and the second half fails because the message
/// committed.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn another_members_attachment_cannot_be_bound_and_the_message_rolls_back_with_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;

    let attachment_id = upload_and_complete(
        &http,
        &base,
        &alice,
        fixture.workspace,
        fixture.channel,
        "alice.txt",
        "text/plain",
        b"alice's bytes",
    )
    .await;

    let client_msg_id = Uuid::new_v4();
    let stolen = http
        .post(messages_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&bob)
        .json(&json!({
            "clientMsgId": client_msg_id,
            "type": "text",
            "body": "제 파일입니다",
            "attachmentIds": [attachment_id],
        }))
        .send()
        .await
        .expect("bob's send");
    assert_eq!(
        stolen.status(),
        403,
        "an attachment belongs to whoever uploaded it"
    );
    let body: Value = stolen.json().await.expect("error body");
    assert_eq!(
        body["error"]["message"],
        json!("attachment belongs to another uploader")
    );

    // The refusal is atomic: Bob's message does not exist.
    let orphan: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE channel_id = $1 AND client_msg_id = $2",
    )
    .bind(fixture.channel)
    .bind(client_msg_id)
    .fetch_one(&su)
    .await
    .expect("count");
    assert_eq!(
        orphan, 0,
        "a refused binding must roll the message back — a message that shipped \
         without its author's file is worse than one that failed to send"
    );
    // …and the attachment is untouched, still free to be bound by its owner.
    let bound: Option<Uuid> = sqlx::query_scalar("SELECT message_id FROM attachment WHERE id = $1")
        .bind(Uuid::parse_str(&attachment_id).expect("uuid"))
        .fetch_one(&su)
        .await
        .expect("attachment row");
    assert!(bound.is_none(), "the refused binding left no mark");

    // Bob CAN download it — reading and binding are different authorizations.
    let readable = http
        .get(format!(
            "{base}/v1/workspaces/{}/channels/{}/attachments/{attachment_id}/content",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&bob)
        .send()
        .await
        .expect("content");
    assert_eq!(readable.status(), 200);
}

// ---------------------------------------------------------------------------
// red proof 2 — Drive's word is what decides completion
// ---------------------------------------------------------------------------

/// An archive that reports a different mime than the session declared.
///
/// The stub deliberately cannot contradict itself, so reaching the completion
/// route's mismatch branch needs an archive that will — and writing it here,
/// rather than adding a "lie to me" switch to the stub, keeps the divergence
/// visible in the test that depends on it.
#[derive(Debug)]
struct DivergentMimeArchive {
    inner: StubDriveArchive,
}

#[async_trait]
impl DriveArchive for DivergentMimeArchive {
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
        let mut file = self.inner.file_metadata(file_id).await?;
        // What actually landed in the archive is not what was declared.
        file.mime = "application/x-msdownload".to_string();
        Ok(file)
    }

    async fn file_content(
        &self,
        file_id: &str,
        max_bytes: i64,
    ) -> Result<DriveContent, DriveError> {
        self.inner.file_content(file_id, max_bytes).await
    }

    async fn accept_stub_upload(
        &self,
        token: &str,
        mime: Option<&str>,
        bytes: Vec<u8>,
    ) -> Result<(), DriveError> {
        self.inner.accept_stub_upload(token, mime, bytes).await
    }
}

/// **Red proof.** A file whose archived mime contradicts the declaration is
/// refused, recorded as `failed`, and can never be attached to a message.
///
/// Drop the `metadata.mime == pending.mime` term in `routes::attachments::complete`
/// and this goes red three ways: the completion answers 200, the row reads
/// `complete`, and the send that follows succeeds — which is precisely the hole,
/// since the declared mime is what every client renders by.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn an_archived_file_that_contradicts_its_declaration_fails_and_stays_unattachable() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (base, _archive) = start_server_with(app_pool.clone(), |base| {
        Arc::new(DivergentMimeArchive {
            inner: StubDriveArchive::new(&base),
        })
    })
    .await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;

    const BYTES: &[u8] = b"harmless looking";
    let created = http
        .post(uploads_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&alice)
        .json(&json!({"name": "invoice.pdf", "mime": "application/pdf", "size": BYTES.len()}))
        .send()
        .await
        .expect("create upload");
    assert_eq!(created.status(), 201);
    let created: Value = created.json().await.expect("body");
    let attachment_id = created["id"].as_str().expect("id").to_string();
    let upload_url = created["uploadUrl"].as_str().expect("uploadUrl");

    let uploaded = http
        .put(upload_url)
        .header(reqwest::header::CONTENT_TYPE, "application/pdf")
        .body(BYTES.to_vec())
        .send()
        .await
        .expect("upload");
    assert_eq!(uploaded.status(), 200);

    let completed = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/attachments/{attachment_id}/complete",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("complete");
    assert_eq!(
        completed.status(),
        409,
        "Drive's word decides, not the client's declaration"
    );
    let body: Value = completed.json().await.expect("error body");
    assert_eq!(
        body["error"]["message"],
        json!("uploaded file size or mime does not match")
    );

    // The refusal is DURABLE — the row moved to `failed` and was audited, so a
    // divergence is a record rather than an upload that stays pending forever.
    let attachment = Uuid::parse_str(&attachment_id).expect("uuid");
    let status: String = sqlx::query_scalar("SELECT status FROM attachment WHERE id = $1")
        .bind(attachment)
        .fetch_one(&su)
        .await
        .expect("row");
    assert_eq!(status, "failed", "a mismatch is recorded, not rolled back");
    let audited: Option<Value> = sqlx::query_scalar(
        "SELECT detail FROM audit_log \
          WHERE action = 'attachment.upload_failed' AND target_id = $1",
    )
    .bind(attachment)
    .fetch_optional(&su)
    .await
    .expect("audit query");
    let audited = audited.expect("the divergence is audited");
    assert_eq!(audited["expected_mime"], json!("application/pdf"));
    assert_eq!(audited["actual_mime"], json!("application/x-msdownload"));

    // And a failed attachment can never reach a message.
    let client_msg_id = Uuid::new_v4();
    let send = http
        .post(messages_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&alice)
        .json(&json!({
            "clientMsgId": client_msg_id,
            "type": "text",
            "body": "청구서입니다",
            "attachmentIds": [attachment_id],
        }))
        .send()
        .await
        .expect("send");
    assert_eq!(send.status(), 409, "only a completed attachment binds");
    let body: Value = send.json().await.expect("error body");
    assert_eq!(
        body["error"]["message"],
        json!("attachment upload is not complete")
    );
    let orphan: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE channel_id = $1 AND client_msg_id = $2",
    )
    .bind(fixture.channel)
    .bind(client_msg_id)
    .fetch_one(&su)
    .await
    .expect("count");
    assert_eq!(orphan, 0, "and the message rolls back with it");
}

// ---------------------------------------------------------------------------
// the remaining refusals
// ---------------------------------------------------------------------------

/// One attachment, one message — enforced under a row lock, so the second claim
/// loses rather than silently moving the file.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn an_attachment_binds_to_exactly_one_message() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;

    let attachment_id = upload_and_complete(
        &http,
        &base,
        &alice,
        fixture.workspace,
        fixture.channel,
        "once.txt",
        "text/plain",
        b"once",
    )
    .await;
    let url = messages_url(&base, fixture.workspace, fixture.channel);

    let first = http
        .post(&url)
        .bearer_auth(&alice)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(), "type": "text", "body": "첫 번째",
            "attachmentIds": [attachment_id],
        }))
        .send()
        .await
        .expect("first send");
    assert_eq!(first.status(), 201);
    let first_id = first.json::<Value>().await.expect("body")["id"]
        .as_str()
        .expect("id")
        .to_string();

    let second = http
        .post(&url)
        .bearer_auth(&alice)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(), "type": "text", "body": "두 번째",
            "attachmentIds": [attachment_id],
        }))
        .send()
        .await
        .expect("second send");
    assert_eq!(second.status(), 409);
    assert_eq!(
        second.json::<Value>().await.expect("body")["error"]["message"],
        json!("attachment is already linked")
    );

    // The first binding stands.
    let bound: Option<Uuid> = sqlx::query_scalar("SELECT message_id FROM attachment WHERE id = $1")
        .bind(Uuid::parse_str(&attachment_id).expect("uuid"))
        .fetch_one(&su)
        .await
        .expect("row");
    assert_eq!(bound, Some(Uuid::parse_str(&first_id).expect("uuid")));

    // A duplicate id in ONE request is refused before any lock is taken.
    let duplicated = http
        .post(&url)
        .bearer_auth(&alice)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(), "type": "text", "body": "중복",
            "attachmentIds": [attachment_id, attachment_id],
        }))
        .send()
        .await
        .expect("duplicate send");
    assert_eq!(duplicated.status(), 400);
    assert_eq!(
        duplicated.json::<Value>().await.expect("body")["error"]["message"],
        json!("attachmentIds must not contain duplicates")
    );
}

/// An attachment cannot cross channels, and a non-member cannot start one.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_channel_boundary_holds_on_every_route() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;
    let outsider = login(&http, &base, fixture.workspace, &fixture.outsider).await;

    // A member of no channel cannot open a session.
    let refused = http
        .post(uploads_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&outsider)
        .json(&json!({"name": "x.txt", "mime": "text/plain", "size": 1}))
        .send()
        .await
        .expect("outsider upload");
    assert_eq!(refused.status(), 403);
    assert_eq!(
        refused.json::<Value>().await.expect("body")["error"]["message"],
        json!("active channel membership required")
    );

    // Bob uploads into the OTHER channel, then tries to attach it here.
    let elsewhere = upload_and_complete(
        &http,
        &base,
        &bob,
        fixture.workspace,
        fixture.other_channel,
        "elsewhere.txt",
        "text/plain",
        b"elsewhere",
    )
    .await;
    let crossed = http
        .post(messages_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&bob)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(), "type": "text", "body": "다른 방 파일",
            "attachmentIds": [elsewhere],
        }))
        .send()
        .await
        .expect("cross-channel send");
    assert_eq!(crossed.status(), 403);
    assert_eq!(
        crossed.json::<Value>().await.expect("body")["error"]["message"],
        json!("attachment belongs to another channel")
    );

    // The content proxy is channel-scoped too: the same id under the wrong
    // channel is a flat 404, never a redirect to the right one.
    let wrong_channel = http
        .get(format!(
            "{base}/v1/workspaces/{}/channels/{}/attachments/{elsewhere}/content",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&bob)
        .send()
        .await
        .expect("content under the wrong channel");
    assert_eq!(wrong_channel.status(), 404);

    // An id that never existed answers identically — no enumeration.
    let missing = http
        .get(format!(
            "{base}/v1/workspaces/{}/channels/{}/attachments/{}/content",
            fixture.workspace,
            fixture.channel,
            Uuid::new_v4()
        ))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("missing content");
    assert_eq!(missing.status(), 404);
    assert_eq!(
        missing.json::<Value>().await.expect("body")["error"]["message"],
        json!("completed attachment not found")
    );
}

/// Shape refusals, all of them before a connection is taken.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_malformed_declaration_never_reaches_the_archive() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let url = uploads_url(&base, fixture.workspace, fixture.channel);

    for (body, status, message) in [
        (
            json!({"name": "a/b.txt", "mime": "text/plain", "size": 1}),
            400,
            "attachment name is invalid",
        ),
        (
            json!({"name": "  ", "mime": "text/plain", "size": 1}),
            400,
            "attachment name is invalid",
        ),
        (
            json!({"name": "a.txt", "mime": "not-a-mime", "size": 1}),
            400,
            "attachment mime is invalid",
        ),
        (
            json!({"name": "a.txt", "mime": "text/plain", "size": 104_857_601i64}),
            413,
            "attachment size must be at most 100 MB",
        ),
        (
            json!({"name": "a.txt", "mime": "text/plain", "size": -1}),
            413,
            "attachment size must be at most 100 MB",
        ),
    ] {
        let response = http
            .post(&url)
            .bearer_auth(&alice)
            .json(&body)
            .send()
            .await
            .expect("malformed upload");
        assert_eq!(response.status(), status, "for {body}");
        assert_eq!(
            response.json::<Value>().await.expect("body")["error"]["message"],
            json!(message)
        );
    }

    // Nothing was written for any of them.
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM attachment WHERE channel_id = $1")
        .bind(fixture.channel)
        .fetch_one(&su)
        .await
        .expect("count");
    assert_eq!(rows, 0, "a shape refusal writes no row");
}

/// An instance with no archive keeps the routes and says so — 503, not 404.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn an_unconfigured_archive_answers_503_from_a_mounted_route() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (base, archive) = start_server_with(app_pool.clone(), |_base| {
        Arc::new(momo_drive::UnavailableDriveArchive)
    })
    .await;
    assert!(!archive.accepts_stub_uploads());
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;

    let response = http
        .post(uploads_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&alice)
        .json(&json!({"name": "a.txt", "mime": "text/plain", "size": 1}))
        .send()
        .await
        .expect("upload with no archive");
    assert_eq!(
        response.status(),
        503,
        "the route exists; the archive does not"
    );
    assert_eq!(
        response.json::<Value>().await.expect("body")["error"]["message"],
        json!("Drive archive is not configured")
    );

    // …and the stub upload endpoint is not mounted at all on such an instance.
    let stub = http
        .put(format!(
            "{base}/__momo_stub/drive/uploads/{}",
            Uuid::new_v4().to_string().to_lowercase()
        ))
        .body("x")
        .send()
        .await
        .expect("stub upload");
    assert_eq!(
        stub.status(),
        404,
        "an in-memory upload endpoint exists only where the stub archive does"
    );

    let unwritten: i64 =
        sqlx::query_scalar("SELECT count(*) FROM attachment WHERE channel_id = $1")
            .bind(fixture.channel)
            .fetch_one(&su)
            .await
            .expect("count");
    assert_eq!(unwritten, 0);
}

/// ADR-0169 — the local-volume archive is a third DriveArchive, not a fork of
/// the routes. Google is never contacted; the in-memory stub is not used.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_local_archive_round_trips_session_put_complete_content() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let dir = std::env::temp_dir().join(format!(
        "oort-drive-local-pg-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("temp archive");
    let dir_str = dir.to_string_lossy().into_owned();
    let (base, archive) = start_server_with(app_pool.clone(), move |base| {
        Arc::new(LocalDriveArchive::open(Some(dir_str.as_str()), &base).expect("local archive"))
    })
    .await;
    assert!(archive.accepts_stub_uploads());
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;

    const BYTES: &[u8] = b"local-archive-round-trip";
    let id = upload_and_complete(
        &http,
        &base,
        &alice,
        fixture.workspace,
        fixture.channel,
        "note.txt",
        "text/plain",
        BYTES,
    )
    .await;

    let content = http
        .get(format!(
            "{base}/v1/workspaces/{}/channels/{}/attachments/{id}/content",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("content");
    assert_eq!(content.status(), 200);
    assert_eq!(content.bytes().await.expect("bytes").as_ref(), BYTES);

    let row: String = sqlx::query_scalar("SELECT drive_file_id FROM attachment WHERE id = $1")
        .bind(Uuid::parse_str(&id).expect("uuid"))
        .fetch_one(&su)
        .await
        .expect("drive_file_id");
    assert!(
        row.starts_with("local-"),
        "the stored archive id is the local opaque id, not a stub/google id: {row}"
    );

    let mut leaked = false;
    if let Ok(entries) = std::fs::read_dir(dir.join("objects")) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().contains("note") {
                leaked = true;
            }
        }
    }
    assert!(!leaked, "user filename leaked onto the archive volume");
    let _ = std::fs::remove_dir_all(&dir);
}
