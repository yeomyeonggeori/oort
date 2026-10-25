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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_drive::{
    DriveArchive, DriveContent, DriveError, DriveFile, DriveUploadSession, LocalDriveArchive,
    StubDriveArchive, UploadBody, MAX_ATTACHMENT_BYTES,
};
use momo_messaging::attachment_reclaim::{
    reclaim_unbound_attachment_in_tx, AttachmentReclaimOutcome, UNBOUND_TTL,
};
use momo_messaging::avatar_reclaim::DriveDelete;
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
            AND actor_member_id = $2 AND detail->>'schema' = 'momo.attachment.upload_started.v2'",
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
    // Bob did not upload it, but he is in the room and step 5's message carries
    // it (before a message does, only Alice reads it: #4233, see
    // `an_unbound_attachment_is_its_uploaders_alone_until_a_message_carries_it`).
    let downloaded = http
        .get(&content_url)
        .bearer_auth(&bob)
        .send()
        .await
        .expect("content");
    assert_eq!(
        downloaded.status(),
        200,
        "any active member of the channel may read an attachment a message carries"
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

    // Reading and binding are different authorizations, and Bob holds neither
    // yet: nothing carries Alice's file, so it is hers alone to read (#4233 — this
    // used to be a 200, the exposure ADR-0208 남는 위험 8 closes). He still may
    // not bind it afterwards; he may read it once Alice's own message carries it.
    let content = content_url(&base, fixture.workspace, fixture.channel, &attachment_id);
    let before = http
        .get(&content)
        .bearer_auth(&bob)
        .send()
        .await
        .expect("content before the post");
    assert_eq!(
        before.status(),
        404,
        "a file no message carries is not Bob's to read"
    );
    let posted = http
        .post(messages_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&alice)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "type": "text",
            "body": "제 파일입니다",
            "attachmentIds": [attachment_id],
        }))
        .send()
        .await
        .expect("alice's send");
    assert_eq!(posted.status(), 201, "the owner binds her own file");
    assert_eq!(
        read_content(&http, &content, &bob).await,
        b"alice's bytes",
        "once a message carries it the room reads it"
    );
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
        content_length: Option<u64>,
        body: UploadBody,
    ) -> Result<(), DriveError> {
        self.inner
            .accept_stub_upload(token, mime, content_length, body)
            .await
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

// ---------------------------------------------------------------------------
// red proof 3 — a file no message carries is its uploader's alone (#4233)
// ---------------------------------------------------------------------------

/// The stub archive, counting every content read it is asked for.
///
/// A refused read must never reach the archive, and a status code cannot show
/// that on its own: Drive's own "file not found" is a 404 too
/// (`routes::attachments::drive_error`), so a 404 that came from the archive
/// looks exactly like one that came from the authorization. The counter tells
/// the two apart.
#[derive(Debug)]
struct CountingArchive {
    inner: StubDriveArchive,
    content_reads: Arc<AtomicUsize>,
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
        self.content_reads.fetch_add(1, Ordering::SeqCst);
        self.inner.file_content(file_id, max_bytes).await
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
    let reads = Arc::new(AtomicUsize::new(0));
    let counter = reads.clone();
    let (base, _archive) = start_server_with(pool, move |base| {
        Arc::new(CountingArchive {
            inner: StubDriveArchive::new(&base),
            content_reads: counter,
        })
    })
    .await;
    (base, reads)
}

/// One GET of the content route: its status and its exact body bytes.
async fn content_response(http: &reqwest::Client, url: &str, token: &str) -> (u16, Vec<u8>) {
    let response = http
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .expect("content");
    let status = response.status().as_u16();
    (status, response.bytes().await.expect("body").to_vec())
}

/// `error.message` of a refusal's body (empty when the body is not an error).
fn refusal_of(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|parsed| parsed["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_default()
}

/// The sentence every refusal to *show* an attachment answers (never a reason).
const CONTENT_NOT_FOUND: &str = "completed attachment not found";

/// **Red proof (#4233, ADR-0208 남는 위험 8).** A file that no message carries
/// yet — a draft in a composer tray, or a file a scheduled message holds for up
/// to 120 days — is read by whoever uploaded it and by no one else; the moment a
/// message carries it, the channel reads it as before.
///
/// Make the read uploader-free again (`load_readable_attachment_in_tx` without
/// its reader term) and step 3 goes red: Bob's read answers 200, and the archive
/// counter moves. Drop its `message_id IS NOT NULL` term and step 4 goes red (the
/// room cannot read what a message carries). Drop its `uploader_member_id` term
/// and step 2 goes red — and with it the sender's own pending row (web
/// `PendingRow`, the phone's optimistic echo), which opens its card while its
/// message is still in flight and so carries nothing yet.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn an_unbound_attachment_is_its_uploaders_alone_until_a_message_carries_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (base, reads) = start_counting_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;
    let outsider = login(&http, &base, fixture.workspace, &fixture.outsider).await;
    const BYTES: &[u8] = "초안 첨부의 바이트".as_bytes();
    let (ws, ch) = (fixture.workspace, fixture.channel);

    // ---- 0. an upload that has not completed is nobody's content ----------
    let session = http
        .post(uploads_url(&base, ws, ch))
        .bearer_auth(&alice)
        .json(&json!({"name": "pending.txt", "mime": "text/plain", "size": 3}))
        .send()
        .await
        .expect("create upload");
    assert_eq!(session.status(), 201);
    let pending_id = session.json::<Value>().await.expect("body")["id"]
        .as_str()
        .expect("id")
        .to_string();
    let (status, body) =
        content_response(&http, &content_url(&base, ws, ch, &pending_id), &alice).await;
    assert_eq!(
        status, 404,
        "pending is not content, even for the member who started it"
    );
    assert_eq!(refusal_of(&body), CONTENT_NOT_FOUND);

    // ---- 1. a completed upload that no message carries --------------------
    let id = upload_and_complete(
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
    let url = content_url(&base, ws, ch, &id);
    let carried_by: Option<Uuid> =
        sqlx::query_scalar("SELECT message_id FROM attachment WHERE id = $1")
            .bind(Uuid::parse_str(&id).expect("uuid"))
            .fetch_one(&su)
            .await
            .expect("attachment row");
    assert!(
        carried_by.is_none(),
        "the premise of everything below: complete, and carried by no message"
    );

    // ---- 2. the uploader reads her own draft ------------------------------
    // This is the sender's own pending row: its message is still in flight, so
    // nothing carries the file, and the card must open it all the same.
    let (status, body) = content_response(&http, &url, &alice).await;
    assert_eq!(status, 200, "the uploader always reads what she uploaded");
    assert_eq!(body, BYTES, "byte for byte");
    assert_eq!(reads.load(Ordering::SeqCst), 1);

    // ---- 3. another member of the room reads nothing ----------------------
    let never_existed = content_url(&base, ws, ch, &Uuid::new_v4().to_string());
    let (missing_status, missing_body) = content_response(&http, &never_existed, &bob).await;
    assert_eq!(missing_status, 404);
    let (status, body) = content_response(&http, &url, &bob).await;
    assert_eq!(status, 404, "Bob is in the room, but no message carries it");
    assert_eq!(
        body, missing_body,
        "a draft that exists must answer byte for byte what an id that never \
         existed answers, or the route tells Bob which drafts exist"
    );
    assert_eq!(refusal_of(&body), CONTENT_NOT_FOUND);
    let (status, body) = content_response(&http, &url, &outsider).await;
    assert_eq!(status, 403, "the membership gate still comes first");
    assert_eq!(refusal_of(&body), "active channel membership required");
    assert_eq!(
        reads.load(Ordering::SeqCst),
        1,
        "a refused read never reaches the archive"
    );

    // ---- 4. a message carries it: the room reads it as before -------------
    let posted = http
        .post(messages_url(&base, ws, ch))
        .bearer_auth(&alice)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "type": "text",
            "body": "자료 올립니다",
            "attachmentIds": [id],
        }))
        .send()
        .await
        .expect("post");
    assert_eq!(posted.status(), 201);
    let (status, body) = content_response(&http, &url, &bob).await;
    assert_eq!(status, 200, "a carried attachment is the room's");
    assert_eq!(body, BYTES, "byte for byte");
    let (status, body) = content_response(&http, &url, &alice).await;
    assert_eq!(status, 200, "and still its uploader's");
    assert_eq!(body, BYTES);
    let (status, body) = content_response(&http, &url, &outsider).await;
    assert_eq!(status, 403, "carrying it opens nothing to a non-member");
    assert_eq!(refusal_of(&body), "active channel membership required");
    assert_eq!(
        reads.load(Ordering::SeqCst),
        3,
        "exactly the three reads that were allowed reached the archive"
    );

    // ---- 5. a member who left reads nothing — her own draft included -------
    let second = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "second.txt",
        "text/plain",
        b"second draft",
    )
    .await;
    sqlx::query(
        "UPDATE membership SET left_at = now() \
          WHERE channel_id = $1 AND member_id = $2 AND left_at IS NULL",
    )
    .bind(ch)
    .bind(fixture.alice.member)
    .execute(&su)
    .await
    .expect("alice leaves the channel");
    let (status, body) =
        content_response(&http, &content_url(&base, ws, ch, &second), &alice).await;
    assert_eq!(
        status, 403,
        "being the uploader is not a way around channel membership"
    );
    assert_eq!(refusal_of(&body), "active channel membership required");
    assert_eq!(reads.load(Ordering::SeqCst), 3);
}

/// **Guard (#4233).** Narrowing the read to "carried, or yours" must not widen it
/// anywhere else: a draft and a carried attachment both stay inside their tenant
/// and their channel, and the status and sentence of each refusal say which
/// guard stopped the request.
///
/// Parenthesize the new predicate wrongly (`… channel_id = $2 AND message_id IS
/// NOT NULL OR uploader_member_id = $3`) and the uploader reads her draft under the
/// wrong channel; drop `channel_id = $2` and every wrong-channel row below answers
/// 200, the carried file included.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_draft_and_a_carried_attachment_stay_inside_their_tenant_and_channel() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let home = seed(&su, &app_pool).await;
    // Another tenant with its own people and channels. `eve` is its channel
    // owner: a member of the other tenant's channels, of none of `home`'s.
    let away = seed(&su, &app_pool).await;
    let (base, reads) = start_counting_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, home.workspace, &home.alice).await;
    let bob = login(&http, &base, home.workspace, &home.bob).await;
    let eve = login(&http, &base, away.workspace, &away.alice).await;
    const BYTES: &[u8] = b"inside-its-tenant-and-channel";

    let draft = upload_and_complete(
        &http,
        &base,
        &alice,
        home.workspace,
        home.channel,
        "draft.txt",
        "text/plain",
        BYTES,
    )
    .await;
    let carried = upload_and_complete(
        &http,
        &base,
        &alice,
        home.workspace,
        home.channel,
        "carried.txt",
        "text/plain",
        BYTES,
    )
    .await;
    let posted = http
        .post(messages_url(&base, home.workspace, home.channel))
        .bearer_auth(&alice)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "type": "text",
            "body": "한 장만 올립니다",
            "attachmentIds": [carried],
        }))
        .send()
        .await
        .expect("post the carried one");
    assert_eq!(posted.status(), 201);

    for (what, id) in [("a draft", &draft), ("a carried attachment", &carried)] {
        // The right id under the other channel of the same tenant: a flat 404 for
        // the uploader and for a member of both channels alike.
        let wrong_channel = content_url(&base, home.workspace, home.other_channel, id);
        for (who, token) in [("its uploader", &alice), ("a member of both", &bob)] {
            let (status, body) = content_response(&http, &wrong_channel, token).await;
            assert_eq!(
                status, 404,
                "{what}, under the wrong channel, read by {who}"
            );
            assert_eq!(refusal_of(&body), CONTENT_NOT_FOUND);
        }

        // Another tenant, addressing this one: the scope guard answers before any
        // row is looked at (it is not RLS that stops this one).
        let (status, body) = content_response(
            &http,
            &content_url(&base, home.workspace, home.channel, id),
            &eve,
        )
        .await;
        assert_eq!(
            status, 403,
            "{what}, another tenant's token on this tenant's path"
        );
        assert_eq!(refusal_of(&body), "workspace scope mismatch");

        // Her own workspace in the path, this tenant's channel: the channel is not
        // hers, so the membership gate answers (RLS hides the channel from her).
        let (status, body) = content_response(
            &http,
            &content_url(&base, away.workspace, home.channel, id),
            &eve,
        )
        .await;
        assert_eq!(status, 403, "{what}, another tenant's channel id");
        assert_eq!(refusal_of(&body), "active channel membership required");

        // Everything hers except the attachment id: her own channel passes the
        // gate, and RLS plus the channel term leave no row to read.
        let (status, body) = content_response(
            &http,
            &content_url(&base, away.workspace, away.channel, id),
            &eve,
        )
        .await;
        assert_eq!(status, 404, "{what}, another tenant's attachment id");
        assert_eq!(refusal_of(&body), CONTENT_NOT_FOUND);
    }
    assert_eq!(
        reads.load(Ordering::SeqCst),
        0,
        "not one of those refusals reached the archive"
    );

    // Controls: the same two files ARE readable where they belong, so the
    // refusals above are the guards' and not an archive that cannot be read.
    let (status, body) = content_response(
        &http,
        &content_url(&base, home.workspace, home.channel, &draft),
        &alice,
    )
    .await;
    assert_eq!((status, body.as_slice()), (200, BYTES), "her draft, to her");
    let (status, body) = content_response(
        &http,
        &content_url(&base, home.workspace, home.channel, &carried),
        &bob,
    )
    .await;
    assert_eq!(
        (status, body.as_slice()),
        (200, BYTES),
        "the carried one, to the room"
    );
    assert_eq!(reads.load(Ordering::SeqCst), 2);
}

/// **Red proof (#4233, ADR-0208 남는 위험 8).** The exposure this issue was opened
/// for: a file a scheduled message holds is a draft for as long as the schedule
/// holds it (a deadline up to 120 days away) and stays its author's alone; the
/// moment the message goes out it is the room's.
///
/// Make the read uploader-free again and Bob reads the held file the day it was
/// uploaded; drop the `message_id IS NOT NULL` term and the room cannot read the
/// file even after the message went out.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_scheduled_messages_file_is_its_authors_alone_until_the_message_goes_out() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (base, reads) = start_counting_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;
    const BYTES: &[u8] = "예약해 둔 파일의 바이트".as_bytes();
    let (ws, ch) = (fixture.workspace, fixture.channel);
    // The schedule routes also ask for a live workspace membership, which this
    // file's fixture does not seed.
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member'::membership_role)",
    )
    .bind(ws)
    .bind(fixture.alice.member)
    .execute(&su)
    .await
    .expect("alice's workspace membership");

    let id = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "scheduled.txt",
        "text/plain",
        BYTES,
    )
    .await;
    let url = content_url(&base, ws, ch, &id);

    // Alice schedules a message with the file for tomorrow.
    let scheduled = http
        .post(format!(
            "{base}/v1/workspaces/{ws}/channels/{ch}/scheduled-messages"
        ))
        .bearer_auth(&alice)
        .json(&json!({
            "body": "내일 보낼 자료",
            "sendAtMs": chrono::Utc::now().timestamp_millis() + 24 * 3_600_000,
            "attachmentIds": [id],
            "clientRequestId": Uuid::new_v4(),
        }))
        .send()
        .await
        .expect("schedule");
    let scheduled_status = scheduled.status();
    let scheduled: Value = scheduled.json().await.expect("body");
    assert_eq!(
        scheduled_status, 201,
        "the schedule is accepted: {scheduled}"
    );
    let schedule_id = scheduled["scheduledMessage"]["id"]
        .as_str()
        .expect("scheduled message id")
        .to_string();

    // The premise: the schedule holds the file, and no message carries it.
    let attachment = Uuid::parse_str(&id).expect("uuid");
    let held: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM scheduled_message_attachment WHERE attachment_id = $1",
    )
    .bind(attachment)
    .fetch_one(&su)
    .await
    .expect("held");
    let carried_by: Option<Uuid> =
        sqlx::query_scalar("SELECT message_id FROM attachment WHERE id = $1")
            .bind(attachment)
            .fetch_one(&su)
            .await
            .expect("attachment row");
    assert_eq!(held, 1, "the schedule holds the file");
    assert!(
        carried_by.is_none(),
        "holding a file is not carrying it: no message exists yet"
    );

    // While it is held: the author reads it, the room does not.
    let (status, body) = content_response(&http, &url, &alice).await;
    assert_eq!(status, 200, "the author reads what she is holding");
    assert_eq!(body, BYTES, "byte for byte");
    let never_existed = content_url(&base, ws, ch, &Uuid::new_v4().to_string());
    let (_, missing_body) = content_response(&http, &never_existed, &bob).await;
    let (status, body) = content_response(&http, &url, &bob).await;
    assert_eq!(status, 404, "a held file is not the room's to read");
    assert_eq!(
        body, missing_body,
        "and the room cannot tell it from an id that never existed"
    );
    assert_eq!(reads.load(Ordering::SeqCst), 1);

    // The message goes out (the same delivery the tick runs): the room reads it.
    let sent = http
        .post(format!(
            "{base}/v1/workspaces/{ws}/scheduled-messages/{schedule_id}/send-now"
        ))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("send now");
    assert_eq!(sent.status(), 200, "the schedule is sent");
    let sent: Value = sent.json().await.expect("body");
    assert_eq!(sent["scheduledMessage"]["status"], json!("sent"));
    let carried_by: Option<Uuid> =
        sqlx::query_scalar("SELECT message_id FROM attachment WHERE id = $1")
            .bind(attachment)
            .fetch_one(&su)
            .await
            .expect("attachment row");
    assert_eq!(
        carried_by.map(|message| message.to_string()).as_deref(),
        sent["scheduledMessage"]["sentMessageId"].as_str(),
        "the file is on the message that went out"
    );
    let (status, body) = content_response(&http, &url, &bob).await;
    assert_eq!(
        status, 200,
        "once the message is out the room reads its file"
    );
    assert_eq!(body, BYTES, "byte for byte");
    assert_eq!(reads.load(Ordering::SeqCst), 2);
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

// ---------------------------------------------------------------------------
// #1716 — measured size is the row's source of truth
// ---------------------------------------------------------------------------

/// Declared `size: 0` is unknown. Create still accepts it; PUT of real bytes
/// is not a mismatch; complete writes and returns the measured length.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_zero_declaration_completes_with_the_measured_size() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;

    const BYTES: &[u8] = b"measured-unknown-size";
    let created = http
        .post(uploads_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&alice)
        .json(&json!({"name": "unknown.txt", "mime": "text/plain", "size": 0}))
        .send()
        .await
        .expect("create upload");
    assert_eq!(
        created.status(),
        201,
        "a zero declaration is unknown, not 413"
    );
    let created: Value = created.json().await.expect("body");
    let attachment_id = created["id"].as_str().expect("id").to_string();
    let upload_url = created["uploadUrl"]
        .as_str()
        .expect("uploadUrl")
        .to_string();

    let pending_size: i64 = sqlx::query_scalar("SELECT size_bytes FROM attachment WHERE id = $1")
        .bind(Uuid::parse_str(&attachment_id).expect("uuid"))
        .fetch_one(&su)
        .await
        .expect("pending size");
    assert_eq!(
        pending_size, 0,
        "the pending row keeps the unknown declaration"
    );

    let uploaded = http
        .put(&upload_url)
        .header(reqwest::header::CONTENT_TYPE, "text/plain")
        .body(BYTES.to_vec())
        .send()
        .await
        .expect("upload");
    assert_eq!(
        uploaded.status(),
        200,
        "unknown declaration accepts measured bytes"
    );

    let completed = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/attachments/{attachment_id}/complete",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("complete");
    assert_eq!(completed.status(), 200);
    let completed: Value = completed.json().await.expect("body");
    assert_eq!(completed["status"], json!("complete"));
    assert_eq!(
        completed["size"],
        json!(BYTES.len()),
        "complete answers with the measured size, not the 0 declaration: {completed}"
    );

    let stored: i64 = sqlx::query_scalar("SELECT size_bytes FROM attachment WHERE id = $1")
        .bind(Uuid::parse_str(&attachment_id).expect("uuid"))
        .fetch_one(&su)
        .await
        .expect("stored size");
    assert_eq!(stored, BYTES.len() as i64);

    let again = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/attachments/{attachment_id}/complete",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("complete again");
    assert_eq!(again.status(), 200);
    assert_eq!(
        again.json::<Value>().await.expect("body")["size"],
        json!(BYTES.len()),
        "idempotent complete still answers with the measured size"
    );

    let sent = http
        .post(messages_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&alice)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "type": "text",
            "body": "실측 크기",
            "attachmentIds": [attachment_id],
        }))
        .send()
        .await
        .expect("send");
    assert_eq!(sent.status(), 201);
    let sent: Value = sent.json().await.expect("send body");
    assert_eq!(sent["attachments"][0]["sizeBytes"], json!(BYTES.len()));
}

/// Same unknown-declaration path against the local-volume archive.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_local_archive_records_measured_size_for_a_zero_declaration() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let dir = std::env::temp_dir().join(format!(
        "oort-drive-local-zero-{}-{}",
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

    const BYTES: &[u8] = b"local-measured";
    let created = http
        .post(uploads_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&alice)
        .json(&json!({"name": "local-unknown.txt", "mime": "text/plain", "size": 0}))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201);
    let created: Value = created.json().await.expect("body");
    let id = created["id"].as_str().expect("id").to_string();
    let upload_url = created["uploadUrl"].as_str().expect("uploadUrl");
    assert_eq!(
        http.put(upload_url)
            .header(reqwest::header::CONTENT_TYPE, "text/plain")
            .body(BYTES.to_vec())
            .send()
            .await
            .expect("put")
            .status(),
        200
    );
    let completed = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/attachments/{id}/complete",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("complete");
    assert_eq!(completed.status(), 200);
    let completed: Value = completed.json().await.expect("body");
    assert_eq!(completed["size"], json!(BYTES.len()));
    let _ = std::fs::remove_dir_all(&dir);
}

/// An archive that reports a size other than what the session declared.
#[derive(Debug)]
struct DivergentSizeArchive {
    inner: StubDriveArchive,
    reported_size: i64,
}

#[async_trait]
impl DriveArchive for DivergentSizeArchive {
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
        file.size_bytes = self.reported_size;
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
        content_length: Option<u64>,
        body: UploadBody,
    ) -> Result<(), DriveError> {
        self.inner
            .accept_stub_upload(token, mime, content_length, body)
            .await
    }
}

/// **Red proof.** Declaring 0 (unknown) or a small known size cannot complete
/// an archive object over 100 MB. The ceiling is on the measured size.
///
/// Drop the `over_ceiling` term in `routes::attachments::complete` and this
/// goes red: complete answers 200 with a size the check constraint forbids
/// on a well-behaved archive, or 409 mismatch — neither is the 413 the
/// receive-time cap owes the client.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn declaring_zero_or_a_small_size_cannot_complete_an_over_ceiling_object() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (base, _archive) = start_server_with(app_pool.clone(), |base| {
        Arc::new(DivergentSizeArchive {
            inner: StubDriveArchive::new(&base),
            reported_size: MAX_ATTACHMENT_BYTES + 1,
        })
    })
    .await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;

    for declared in [0_i64, 5] {
        const BYTES: &[u8] = b"hello";
        let created = http
            .post(uploads_url(&base, fixture.workspace, fixture.channel))
            .bearer_auth(&alice)
            .json(
                &json!({"name": "huge.bin", "mime": "application/octet-stream", "size": declared}),
            )
            .send()
            .await
            .expect("create");
        assert_eq!(created.status(), 201, "declared {declared}");
        let created: Value = created.json().await.expect("body");
        let id = created["id"].as_str().expect("id").to_string();
        let upload_url = created["uploadUrl"].as_str().expect("uploadUrl");
        let put_bytes = if declared == 0 {
            BYTES.to_vec()
        } else {
            vec![b'x'; declared as usize]
        };
        assert_eq!(
            http.put(upload_url)
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(put_bytes)
                .send()
                .await
                .expect("put")
                .status(),
            200,
            "declared {declared} PUT"
        );
        let completed = http
            .post(format!(
                "{base}/v1/workspaces/{}/channels/{}/attachments/{id}/complete",
                fixture.workspace, fixture.channel
            ))
            .bearer_auth(&alice)
            .send()
            .await
            .expect("complete");
        assert_eq!(
            completed.status(),
            413,
            "declared {declared} cannot complete an over-ceiling object"
        );
        assert_eq!(
            completed.json::<Value>().await.expect("body")["error"]["message"],
            json!("Drive attachment exceeds the allowed size")
        );
        let status: String = sqlx::query_scalar("SELECT status FROM attachment WHERE id = $1")
            .bind(Uuid::parse_str(&id).expect("uuid"))
            .fetch_one(&su)
            .await
            .expect("row");
        assert_eq!(status, "failed", "declared {declared} is recorded failed");
    }
}

/// Known (nonzero) declarations still mismatch when the archive disagrees,
/// even when the measured size is under the ceiling.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_known_declaration_that_disagrees_with_the_archive_still_fails() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (base, _archive) = start_server_with(app_pool.clone(), |base| {
        Arc::new(DivergentSizeArchive {
            inner: StubDriveArchive::new(&base),
            reported_size: 8,
        })
    })
    .await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;

    const BYTES: &[u8] = b"hello";
    let created = http
        .post(uploads_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&alice)
        .json(&json!({"name": "note.txt", "mime": "text/plain", "size": BYTES.len()}))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201);
    let created: Value = created.json().await.expect("body");
    let id = created["id"].as_str().expect("id").to_string();
    let upload_url = created["uploadUrl"].as_str().expect("uploadUrl");
    assert_eq!(
        http.put(upload_url)
            .header(reqwest::header::CONTENT_TYPE, "text/plain")
            .body(BYTES.to_vec())
            .send()
            .await
            .expect("put")
            .status(),
        200
    );
    let completed = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/attachments/{id}/complete",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("complete");
    assert_eq!(completed.status(), 409);
    assert_eq!(
        completed.json::<Value>().await.expect("body")["error"]["message"],
        json!("uploaded file size or mime does not match")
    );
    let status: String = sqlx::query_scalar("SELECT status FROM attachment WHERE id = $1")
        .bind(Uuid::parse_str(&id).expect("uuid"))
        .fetch_one(&su)
        .await
        .expect("row");
    assert_eq!(status, "failed");
}

// ---------------------------------------------------------------------------
// #2615 — an upload URL is a one-shot capability
// ---------------------------------------------------------------------------

/// A fresh local-volume archive directory, removed when the guard drops.
struct ArchiveDir(PathBuf);

impl ArchiveDir {
    fn new(label: &str) -> ArchiveDir {
        let dir = std::env::temp_dir().join(format!(
            "oort-drive-2615-{label}-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temp archive");
        ArchiveDir(dir)
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for ArchiveDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn content_url(base: &str, workspace: Uuid, channel: Uuid, attachment: &str) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/attachments/{attachment}/content")
}

async fn read_content(http: &reqwest::Client, url: &str, token: &str) -> Vec<u8> {
    let response = http
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .expect("content");
    assert_eq!(response.status(), 200, "a published attachment is readable");
    response.bytes().await.expect("bytes").to_vec()
}

/// Session → PUT → complete → post to the room → Bob reads it; then replay
/// the same upload URL with forged bytes of the same mime and length — the
/// only shape the archive's size/mime checks ever let through.
async fn a_replayed_upload_url_must_not_touch_published_bytes(base: &str, fixture: &Fixture) {
    let http = reqwest::Client::new();
    let alice = login(&http, base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, base, fixture.workspace, &fixture.bob).await;

    const ORIGINAL: &[u8] = b"quarterly-report-v1";
    const FORGED: &[u8] = b"quarterly-report-XX";
    assert_eq!(ORIGINAL.len(), FORGED.len());

    let created = http
        .post(uploads_url(base, fixture.workspace, fixture.channel))
        .bearer_auth(&alice)
        .json(&json!({"name": "report.txt", "mime": "text/plain", "size": ORIGINAL.len()}))
        .send()
        .await
        .expect("create upload");
    assert_eq!(created.status(), 201);
    let created: Value = created.json().await.expect("body");
    let attachment_id = created["id"].as_str().expect("id").to_string();
    let upload_url = created["uploadUrl"]
        .as_str()
        .expect("uploadUrl")
        .to_string();

    let first = http
        .put(&upload_url)
        .header(reqwest::header::CONTENT_TYPE, "text/plain")
        .body(ORIGINAL.to_vec())
        .send()
        .await
        .expect("first put");
    assert_eq!(first.status(), 200, "the first PUT lands");

    let completed = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/attachments/{attachment_id}/complete",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("complete");
    assert_eq!(completed.status(), 200);

    let sent = http
        .post(messages_url(base, fixture.workspace, fixture.channel))
        .bearer_auth(&alice)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "type": "text",
            "body": "분기 보고서입니다",
            "attachmentIds": [attachment_id],
        }))
        .send()
        .await
        .expect("send");
    assert_eq!(
        sent.status(),
        201,
        "the attachment is published to the room"
    );

    let content = content_url(base, fixture.workspace, fixture.channel, &attachment_id);
    assert_eq!(read_content(&http, &content, &bob).await, ORIGINAL);

    // The replay. Whoever holds the URL — the uploader, a proxy log, a
    // shoulder — must not be able to change what the room already read.
    let replay = http
        .put(&upload_url)
        .header(reqwest::header::CONTENT_TYPE, "text/plain")
        .body(FORGED.to_vec())
        .send()
        .await
        .expect("replayed put");
    let replay_status = replay.status().as_u16();
    let after = read_content(&http, &content, &bob).await;
    assert!(
        matches!(replay_status, 404 | 410) && after == ORIGINAL,
        "#2615: replaying a spent upload URL answered {replay_status} and the published \
         attachment now reads {:?} (it was {:?})",
        String::from_utf8_lossy(&after),
        String::from_utf8_lossy(ORIGINAL),
    );
}

/// **Red proof (#2615).** The local-volume archive — the one the Railway team
/// instance and every self-host default run — spends an upload URL on its
/// first PUT. Before the fix the replay answered 200 and Bob's next read
/// returned the forged bytes.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_local_archive_spends_an_upload_url_on_its_first_put() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let dir = ArchiveDir::new("replay");
    let dir_str = dir.path();
    let (base, _archive) = start_server_with(app_pool.clone(), move |base| {
        Arc::new(LocalDriveArchive::open(Some(dir_str.as_str()), &base).expect("local archive"))
    })
    .await;
    a_replayed_upload_url_must_not_touch_published_bytes(&base, &fixture).await;
}

/// **Red proof (#2615).** The same contract on the in-memory stub, which the
/// verifiers and this suite run against.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_stub_archive_spends_an_upload_url_on_its_first_put() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool.clone()).await;
    a_replayed_upload_url_must_not_touch_published_bytes(&base, &fixture).await;
}

/// **Red proof (#2615).** An upload URL presented after its session lifetime
/// is refused over HTTP by both archives, and nothing it carried lands —
/// completion still finds no file and the row stays `pending`. The archives
/// are minted with a zero lifetime so the proof does not wait out
/// `UPLOAD_SESSION_TTL`.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn an_expired_upload_url_is_refused_by_both_archives() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let dir = ArchiveDir::new("expired");
    let dir_str = dir.path();
    let (local, _local_archive) = start_server_with(app_pool.clone(), move |base| {
        Arc::new(
            LocalDriveArchive::open(Some(dir_str.as_str()), &base)
                .expect("local archive")
                .with_upload_session_ttl(Duration::ZERO),
        )
    })
    .await;
    let (stub, _stub_archive) = start_server_with(app_pool.clone(), |base| {
        Arc::new(StubDriveArchive::new(&base).with_upload_session_ttl(Duration::ZERO))
    })
    .await;

    for (label, base) in [("local", local), ("stub", stub)] {
        let http = reqwest::Client::new();
        let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
        const BYTES: &[u8] = b"too-late";
        let created = http
            .post(uploads_url(&base, fixture.workspace, fixture.channel))
            .bearer_auth(&alice)
            .json(&json!({"name": "late.txt", "mime": "text/plain", "size": BYTES.len()}))
            .send()
            .await
            .expect("create upload");
        assert_eq!(created.status(), 201, "{label}");
        let created: Value = created.json().await.expect("body");
        let attachment_id = created["id"].as_str().expect("id").to_string();
        let upload_url = created["uploadUrl"].as_str().expect("uploadUrl");

        let late = http
            .put(upload_url)
            .header(reqwest::header::CONTENT_TYPE, "text/plain")
            .body(BYTES.to_vec())
            .send()
            .await
            .expect("late put");
        assert!(
            matches!(late.status().as_u16(), 404 | 410),
            "{label}: an expired upload URL must be refused, got {}",
            late.status()
        );

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
            404,
            "{label}: the refused bytes never reached the archive"
        );
        let status: String = sqlx::query_scalar("SELECT status FROM attachment WHERE id = $1")
            .bind(Uuid::parse_str(&attachment_id).expect("uuid"))
            .fetch_one(&su)
            .await
            .expect("row");
        assert_eq!(status, "pending", "{label}: nothing completed");
    }
}

// ---------------------------------------------------------------------------
// #2628 — a restored drive volume does not reopen an upload URL
// ---------------------------------------------------------------------------

fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir_all(to).expect("mkdir");
    for entry in std::fs::read_dir(from).expect("read_dir").flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type().expect("file type").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("copy");
        }
    }
}

/// **Red proof (#2628, #2624 review R11).** The operator restores only the
/// drive volume, from a snapshot taken after a session was created and before
/// its upload — PostgreSQL untouched, so the attachment is still `complete`
/// and posted. The snapshot holds the session file and no object, so the
/// landed-object check has nothing to see and the deadline is an hour away.
/// Before the fix the replay answered 200 and Bob then read the forged bytes
/// under the completed attachment id. The restarted server clears the
/// restored session instead.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_restored_drive_volume_does_not_reopen_a_completed_upload_url() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let dir = ArchiveDir::new("restore");
    let snapshot = ArchiveDir::new("restore-snapshot");
    let before_dir = dir.path();
    let (base, _before) = start_server_with(app_pool.clone(), move |base| {
        Arc::new(LocalDriveArchive::open(Some(before_dir.as_str()), &base).expect("local archive"))
    })
    .await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;

    const ORIGINAL: &[u8] = b"signed-contract-v1";
    const FORGED: &[u8] = b"signed-contract-XX";
    let created = http
        .post(uploads_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&alice)
        .json(&json!({"name": "contract.txt", "mime": "text/plain", "size": ORIGINAL.len()}))
        .send()
        .await
        .expect("create upload");
    assert_eq!(created.status(), 201);
    let created: Value = created.json().await.expect("body");
    let attachment_id = created["id"].as_str().expect("id").to_string();
    let upload_url = created["uploadUrl"]
        .as_str()
        .expect("uploadUrl")
        .to_string();

    // The snapshot: the session exists, the object does not yet.
    copy_tree(&dir.0, &snapshot.0);

    assert_eq!(
        http.put(&upload_url)
            .header(reqwest::header::CONTENT_TYPE, "text/plain")
            .body(ORIGINAL.to_vec())
            .send()
            .await
            .expect("put")
            .status(),
        200
    );
    let completed = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/attachments/{attachment_id}/complete",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("complete");
    assert_eq!(completed.status(), 200);
    let sent = http
        .post(messages_url(&base, fixture.workspace, fixture.channel))
        .bearer_auth(&alice)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "type": "text",
            "body": "계약서입니다",
            "attachmentIds": [attachment_id],
        }))
        .send()
        .await
        .expect("send");
    assert_eq!(sent.status(), 201);

    // Restore the drive volume alone, and restart the server over it.
    std::fs::remove_dir_all(&dir.0).expect("lose the volume");
    copy_tree(&snapshot.0, &dir.0);
    let after_dir = dir.path();
    let (restored, _after) = start_server_with(app_pool.clone(), move |base| {
        Arc::new(LocalDriveArchive::open(Some(after_dir.as_str()), &base).expect("local archive"))
    })
    .await;
    let replay_url = upload_url.replacen(&base, &restored, 1);
    assert_ne!(
        replay_url, upload_url,
        "the replay goes to the restarted server"
    );

    let replay = http
        .put(&replay_url)
        .header(reqwest::header::CONTENT_TYPE, "text/plain")
        .body(FORGED.to_vec())
        .send()
        .await
        .expect("replayed put");
    let replay_status = replay.status().as_u16();
    let read = http
        .get(content_url(
            &restored,
            fixture.workspace,
            fixture.channel,
            &attachment_id,
        ))
        .bearer_auth(&bob)
        .send()
        .await
        .expect("content");
    let read_status = read.status().as_u16();
    let read_bytes = read.bytes().await.expect("bytes").to_vec();
    assert!(
        matches!(replay_status, 404 | 410) && read_bytes != FORGED,
        "#2628: after a drive-only restore the replay answered {replay_status} and Bob now \
         reads {read_status} {:?} under the completed attachment",
        String::from_utf8_lossy(&read_bytes),
    );
}

// ---------------------------------------------------------------------------
// ADR-0151 증보 2 (#4443): what a deleted message leaves of its files
// ---------------------------------------------------------------------------
//
// | test | revert that makes it red |
// |---|---|
// | `a_deleted_messages_attachment_is_nobodys_to_read` | drop `m.state <> 'deleted'` from the content load → the half-tombstone with only `state` set answers 200; drop `m.deleted_at IS NULL` → the one with only `deleted_at` set answers 200; drop both → the room, the author and the admin read 200 (step 3); write the predicate as `(carried AND alive) OR uploader` → the author's own read answers 200 |
// | `a_deleted_messages_attachments_are_not_listed_anywhere` | drop the tombstone term from `PAGED_ATTACHMENT_JOIN` → the channel page lists the card (the thread page reads the same constant); from `message_attachments_in_tx` → the retried send echoes it; from `image_attachments_for_messages_in_tx` → the direct call returns the image |
// | `the_audit_trail_never_holds_a_file_name` | put `"name": name` back into the `attachment.upload_started` detail |
// | `a_held_file_is_never_reclaimed_and_a_released_one_is_a_draft_for_a_full_ttl` | drop `NOT a.reserved` from the eligibility → step 2; drop `unreserved_at` from the `GREATEST` → step 3; make the trigger's INSERT branch a no-op → step 1; its DELETE branch → step 3 (steps 4 and 6 sit behind it) |

/// Make `person` a member of the room with a workspace role, for the tests that need
/// an admin to show a role is no way around a refusal.
async fn seed_room_member_with_role(su: &PgPool, fixture: &Fixture, person: &Person, role: &str) {
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, $3::membership_role)",
    )
    .bind(fixture.workspace)
    .bind(person.member)
    .bind(role)
    .execute(su)
    .await
    .expect("workspace membership");
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member')",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .bind(person.member)
    .execute(su)
    .await
    .expect("channel membership");
}

/// Post a text message carrying `attachment_ids` (a thread reply when `root` is given);
/// returns the message id and the `clientMsgId` it was sent under.
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
) -> (String, Uuid) {
    let client_msg_id = Uuid::new_v4();
    let mut payload = json!({
        "clientMsgId": client_msg_id,
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
    (
        sent["id"].as_str().expect("message id").to_string(),
        client_msg_id,
    )
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

/// The channel's history page as `token`'s owner.
async fn history_as(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
) -> Value {
    let page = http
        .get(messages_url(base, workspace, channel))
        .bearer_auth(token)
        .send()
        .await
        .expect("history");
    assert_eq!(page.status(), 200);
    page.json().await.expect("history body")
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

/// **Red proof (#4443, ADR-0151 증보 2 D1).** The soft delete leaves `message_id` on the
/// file, so "a message carries it" is not enough: the message has to be alive. Once its
/// author deletes it, **nobody** reads the file — not the room, not the author who is also
/// the uploader, not a workspace admin who is in the channel — and the refusal is the flat
/// 404 an id that never existed gets, byte for byte.
///
/// The predicate's shape is part of the proof: `(carried AND alive) OR uploader` would
/// hand the file back to the very person who deleted the message, so the author's own read
/// is a separate step.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_deleted_messages_attachment_is_nobodys_to_read() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (base, reads) = start_counting_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;
    let admin_person = seed_person(&su, fixture.workspace).await;
    seed_room_member_with_role(&su, &fixture, &admin_person, "admin").await;
    let admin = login(&http, &base, fixture.workspace, &admin_person).await;
    const BYTES: &[u8] = "곧 지워질 메시지의 첨부".as_bytes();
    let (ws, ch) = (fixture.workspace, fixture.channel);

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
    let kept = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "kept.txt",
        "text/plain",
        BYTES,
    )
    .await;
    let (gone_message, _) =
        post_with_files(&http, &base, &alice, ws, ch, "곧 지울 글", None, &[&gone]).await;
    post_with_files(&http, &base, &alice, ws, ch, "남길 글", None, &[&kept]).await;
    let gone_url = content_url(&base, ws, ch, &gone);

    // ---- 1. while the message lives, the whole room reads the file ---------
    for (who, token) in [("alice", &alice), ("bob", &bob), ("the admin", &admin)] {
        let (status, body) = content_response(&http, &gone_url, token).await;
        assert_eq!(status, 200, "{who} reads a file a live message carries");
        assert_eq!(body, BYTES);
    }
    assert_eq!(reads.load(Ordering::SeqCst), 3);

    // ---- 2. its author deletes it ------------------------------------------
    delete_message_as(&http, &base, &alice, ws, &gone_message).await;
    let still_pointing: Option<Uuid> =
        sqlx::query_scalar("SELECT message_id FROM attachment WHERE id = $1")
            .bind(Uuid::parse_str(&gone).expect("uuid"))
            .fetch_one(&su)
            .await
            .expect("attachment row");
    assert_eq!(
        still_pointing.map(|id| id.to_string()).as_deref(),
        Some(gone_message.as_str()),
        "the premise: a soft delete leaves message_id on the file, so only the message's \
         own state can close the read"
    );

    // ---- 3. nobody reads it, and nobody can tell it from an unknown id -----
    let never_existed = content_url(&base, ws, ch, &Uuid::new_v4().to_string());
    let (missing_status, missing_body) = content_response(&http, &never_existed, &bob).await;
    assert_eq!(missing_status, 404);
    for (who, token) in [
        ("another member of the room", &bob),
        ("the author, who is also the uploader", &alice),
        ("a workspace admin who is in the channel", &admin),
    ] {
        let (status, body) = content_response(&http, &gone_url, token).await;
        assert_eq!(status, 404, "{who} must not read a deleted message's file");
        assert_eq!(
            body, missing_body,
            "{who}: the refusal is byte for byte the 404 of an id that never existed"
        );
        assert_eq!(refusal_of(&body), CONTENT_NOT_FOUND);
    }
    assert_eq!(
        reads.load(Ordering::SeqCst),
        3,
        "a refused read never reaches the archive"
    );

    // ---- 4. the message next to it is untouched -----------------------------
    let (status, body) = content_response(&http, &content_url(&base, ws, ch, &kept), &bob).await;
    assert_eq!(
        status, 200,
        "deleting one message closes only its own files"
    );
    assert_eq!(body, BYTES);
    assert_eq!(reads.load(Ordering::SeqCst), 4);

    // ---- 5. a half-tombstone is a tombstone, whichever half is written -----
    // (Swift's own guards read `state == 'deleted' || deleted_at != nil`; a row written
    // by an older code path can carry only one of them.)
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
            "half.txt",
            "text/plain",
            BYTES,
        )
        .await;
        let (message, _) =
            post_with_files(&http, &base, &alice, ws, ch, "반쪽 무덤", None, &[&file]).await;
        sqlx::query(&format!("UPDATE message SET {set_clause} WHERE id = $1"))
            .bind(Uuid::parse_str(&message).expect("uuid"))
            .execute(&su)
            .await
            .expect("half-tombstone");
        let (status, body) =
            content_response(&http, &content_url(&base, ws, ch, &file), &bob).await;
        assert_eq!(status, 404, "a message with {half} is deleted");
        assert_eq!(refusal_of(&body), CONTENT_NOT_FOUND);
    }
    assert_eq!(reads.load(Ordering::SeqCst), 4);
}

/// **Red proof (#4443, ADR-0151 증보 2 D2).** The history page keeps a deleted message as
/// a tombstone (so a reconnecting client converges on the deletion), but the tombstone
/// lists none of the files its author removed: not on the channel page, not on the thread
/// page, not in the echo of a retried send, and not in the agent port's image list.
///
/// The control rows (a live message and a live reply) keep their cards, so "lists nothing"
/// cannot be a page that lost its attachments altogether. The assertions are made on the
/// file's **name and id anywhere in the serialized page**, not only on the one key.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_deleted_messages_attachments_are_not_listed_anywhere() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let bob = login(&http, &base, fixture.workspace, &fixture.bob).await;
    let (ws, ch) = (fixture.workspace, fixture.channel);
    const GONE_NAME: &str = "삭제될-첨부-이름.png";
    const KEPT_NAME: &str = "남는-첨부-이름.png";
    const REPLY_NAME: &str = "삭제될-답글-첨부-이름.png";
    const BYTES: &[u8] = b"png-ish bytes";

    // Image mimes, so the agent port's image projection has something to list.
    let gone =
        upload_and_complete(&http, &base, &alice, ws, ch, GONE_NAME, "image/png", BYTES).await;
    let kept =
        upload_and_complete(&http, &base, &alice, ws, ch, KEPT_NAME, "image/png", BYTES).await;
    let reply_file =
        upload_and_complete(&http, &base, &alice, ws, ch, REPLY_NAME, "image/png", BYTES).await;
    let (gone_message, gone_client_msg_id) =
        post_with_files(&http, &base, &alice, ws, ch, "지울 글", None, &[&gone]).await;
    let (kept_message, _) =
        post_with_files(&http, &base, &alice, ws, ch, "남길 글", None, &[&kept]).await;
    let (reply_message, _) = post_with_files(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "지울 답글",
        Some(&kept_message),
        &[&reply_file],
    )
    .await;
    let replies_url =
        format!("{base}/v1/workspaces/{ws}/channels/{ch}/messages/{kept_message}/replies");
    let replies_as = |token: String| {
        let http = http.clone();
        let url = replies_url.clone();
        async move {
            let page = http
                .get(url)
                .bearer_auth(token)
                .send()
                .await
                .expect("replies");
            assert_eq!(page.status(), 200);
            page.json::<Value>().await.expect("replies body")
        }
    };
    let image_ids = |ids: Vec<String>| {
        let app_pool = app_pool.clone();
        async move {
            let ids: Vec<Uuid> = ids
                .iter()
                .map(|id| Uuid::parse_str(id).expect("uuid"))
                .collect();
            momo_db::with_tenant_tx(&app_pool, ws, move |conn| {
                Box::pin(async move {
                    momo_messaging::image_attachments_for_messages_in_tx(conn, ws, &ids).await
                })
            })
            .await
            .expect("image projection")
            .into_iter()
            .map(|(_, attachment, ..)| attachment.to_string())
            .collect::<Vec<_>>()
        }
    };

    // ---- 1. control: before any delete every surface lists the files -------
    let page = history_as(&http, &base, &bob, ws, ch).await;
    assert_eq!(
        row_of(&page, &gone_message)["attachments"][0]["name"],
        json!(GONE_NAME)
    );
    assert_eq!(
        row_of(&page, &kept_message)["attachments"][0]["name"],
        json!(KEPT_NAME)
    );
    let thread = replies_as(bob.clone()).await;
    assert_eq!(
        row_of(&thread, &reply_message)["attachments"][0]["name"],
        json!(REPLY_NAME)
    );
    let listed = image_ids(vec![gone_message.clone(), kept_message.clone()]).await;
    assert!(
        listed.contains(&gone) && listed.contains(&kept),
        "control: the agent port lists both images while both messages live: {listed:?}"
    );

    // ---- 2. the author deletes the message and the reply -------------------
    delete_message_as(&http, &base, &alice, ws, &gone_message).await;
    delete_message_as(&http, &base, &alice, ws, &reply_message).await;

    // ---- 3. the channel page keeps the tombstone and lists nothing for it --
    let page = history_as(&http, &base, &bob, ws, ch).await;
    let tombstone = row_of(&page, &gone_message);
    assert_eq!(
        tombstone["state"],
        json!("deleted"),
        "the tombstone stays visible"
    );
    assert!(
        tombstone.get("attachments").is_none(),
        "a tombstone lists no files: {tombstone}"
    );
    let text = page.to_string();
    assert!(
        !text.contains(GONE_NAME) && !text.contains(&gone),
        "the deleted file's name and id appear nowhere in the page: {text}"
    );
    assert_eq!(
        row_of(&page, &kept_message)["attachments"][0]["name"],
        json!(KEPT_NAME),
        "control: the live message next to it still lists its card"
    );

    // ---- 4. the thread page does the same ----------------------------------
    let thread = replies_as(bob.clone()).await;
    let reply_row = row_of(&thread, &reply_message);
    assert_eq!(reply_row["state"], json!("deleted"));
    assert!(reply_row.get("attachments").is_none(), "{reply_row}");
    let text = thread.to_string();
    assert!(
        !text.contains(REPLY_NAME) && !text.contains(&reply_file),
        "the deleted reply's file appears nowhere in the thread page: {text}"
    );

    // ---- 5. a retried send echoes no card for a message since deleted ------
    let retried = http
        .post(messages_url(&base, ws, ch))
        .bearer_auth(&alice)
        .json(&json!({
            "clientMsgId": gone_client_msg_id,
            "type": "text",
            "body": "지울 글",
            "attachmentIds": [gone],
        }))
        .send()
        .await
        .expect("retried send");
    assert!(
        retried.status().is_success(),
        "the retry is answered: {}",
        retried.status()
    );
    let retried: Value = retried.json().await.expect("retry body");
    assert_eq!(
        retried["id"],
        json!(gone_message),
        "the retry is the same message"
    );
    assert!(
        retried.get("attachments").is_none() && !retried.to_string().contains(GONE_NAME),
        "the replay of a deleted message echoes no file card: {retried}"
    );

    // ---- 6. the agent port's image list ------------------------------------
    let listed = image_ids(vec![gone_message.clone(), kept_message.clone()]).await;
    assert_eq!(
        listed,
        vec![kept.clone()],
        "the deleted message's image is not listed; the live one is"
    );
}

/// **Red proof (#4443, ADR-0151 증보 2 D3).** The audit trail is read by admins and
/// outlives the file (the reclaim sweep deletes the row), so a file name — which can be a
/// person's — is in none of an attachment's audit rows. The id, the mime and the size are
/// there; the schema is v2.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_audit_trail_never_holds_a_file_name() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let (ws, ch) = (fixture.workspace, fixture.channel);
    const NAME: &str = "급여명세서-이도현.pdf";
    const BYTES: &[u8] = b"%PDF-1.4 fixture";

    let id =
        upload_and_complete(&http, &base, &alice, ws, ch, NAME, "application/pdf", BYTES).await;
    post_with_files(&http, &base, &alice, ws, ch, "자료", None, &[&id]).await;
    let attachment = Uuid::parse_str(&id).expect("uuid");

    let rows = sqlx::query(
        "SELECT action, detail FROM audit_log WHERE workspace_id = $1 AND target_id = $2 \
          ORDER BY created_at, id",
    )
    .bind(ws)
    .bind(attachment)
    .fetch_all(&su)
    .await
    .expect("audit rows");
    let actions: Vec<String> = rows
        .iter()
        .map(|row| row.get::<String, _>("action"))
        .collect();
    assert_eq!(
        actions,
        [
            "attachment.upload_started",
            "attachment.upload_completed",
            "attachment.message_linked"
        ],
        "the whole life of the file is audited"
    );
    for row in &rows {
        let detail: Value = row.get("detail");
        let text = detail.to_string();
        assert!(
            !text.contains("급여명세서") && !text.contains("이도현") && !text.contains(".pdf"),
            "{}: no part of the file name is in the detail: {text}",
            row.get::<String, _>("action")
        );
    }
    let started: Value = rows[0].get("detail");
    assert_eq!(
        started["schema"],
        json!("momo.attachment.upload_started.v2")
    );
    assert!(started.get("name").is_none(), "{started}");
    assert_eq!(started["mime"], json!("application/pdf"));
    assert_eq!(started["size_bytes"], json!(BYTES.len().to_string()));
    assert_eq!(started["channel_id"], json!(ch.to_string()));

    // …and nowhere else in the workspace's trail either.
    let anywhere: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND detail::text LIKE '%급여명세서%'",
    )
    .bind(ws)
    .fetch_one(&su)
    .await
    .expect("count");
    assert_eq!(anywhere, 0, "the name is in no audit row of the workspace");
}

/// One reclaim transaction on the RLS-bound pool, with a Drive that answers `answer` and
/// records the file ids it was asked to delete.
async fn reclaim_once(
    app: &PgPool,
    workspace: Uuid,
    attachment: Uuid,
    answer: DriveDelete,
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
                        answer
                    })
                },
            )
            .await
        })
    })
    .await
    .expect("reclaim transaction")
}

/// **Red proof (#4443, ADR-0151 증보 2 D4), through the real schedule routes.** A schedule
/// holds its files for up to 120 days, so the reclaim must never take one — and it can only
/// know through `attachment.reserved`, which a trigger mirrors from the owner-scoped
/// reservation table (the reclaim neither reads that table nor binds the author's scope).
/// When the hold ends (cancel, send) the file is a draft again **for a full TTL from that
/// moment** (ADR-0208 D11 「초안과 같은 상태」), not from its upload: a file uploaded 40 days
/// ago and released today is not reclaimable today.
///
/// 1. the schedule holds the file → `reserved`; 2. 40 days on, a held file is not reclaimed;
/// 3. cancel releases it → `unreserved_at` is stamped and the file is still not reclaimable;
/// 4. a send-now releases a second file by binding it → not reserved, and bound wins;
/// 5. 40 days after the release the draft is reclaimed: the row and its Drive object go, one
///    audit row says so, and it carries no file name.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_held_file_is_never_reclaimed_and_a_released_one_is_a_draft_for_a_full_ttl() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let alice = login(&http, &base, fixture.workspace, &fixture.alice).await;
    let (ws, ch) = (fixture.workspace, fixture.channel);
    // The schedule routes also ask for a live workspace membership.
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member'::membership_role)",
    )
    .bind(ws)
    .bind(fixture.alice.member)
    .execute(&su)
    .await
    .expect("alice's workspace membership");
    const NAME: &str = "예약해-둔-파일-이도현.txt";
    let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let schedule = |file: String| {
        let http = http.clone();
        let url = format!("{base}/v1/workspaces/{ws}/channels/{ch}/scheduled-messages");
        let token = alice.clone();
        async move {
            let created = http
                .post(url)
                .bearer_auth(token)
                .json(&json!({
                    "body": "내일 보낼 자료",
                    "sendAtMs": chrono::Utc::now().timestamp_millis() + 24 * 3_600_000,
                    "attachmentIds": [file],
                    "clientRequestId": Uuid::new_v4(),
                }))
                .send()
                .await
                .expect("schedule");
            assert_eq!(created.status(), 201);
            let created: Value = created.json().await.expect("body");
            created["scheduledMessage"]["id"]
                .as_str()
                .expect("schedule id")
                .to_string()
        }
    };
    let flags = |attachment: Uuid| {
        let su = su.clone();
        async move {
            let row = sqlx::query("SELECT reserved, unreserved_at FROM attachment WHERE id = $1")
                .bind(attachment)
                .fetch_one(&su)
                .await
                .expect("attachment flags");
            (
                row.get::<bool, _>("reserved"),
                row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("unreserved_at"),
            )
        }
    };
    let age = |attachment: Uuid, column: &'static str| {
        let su = su.clone();
        async move {
            sqlx::query(&format!(
                "UPDATE attachment SET {column} = now() - interval '40 days' WHERE id = $1"
            ))
            .bind(attachment)
            .execute(&su)
            .await
            .expect("age the file");
        }
    };
    let exists = |attachment: Uuid| {
        let su = su.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM attachment WHERE id = $1")
                .bind(attachment)
                .fetch_one(&su)
                .await
                .expect("count")
                == 1
        }
    };

    // ---- 1. the schedule holds the file; the trigger mirrors it ------------
    let held = upload_and_complete(&http, &base, &alice, ws, ch, NAME, "text/plain", b"held").await;
    let held_id = Uuid::parse_str(&held).expect("uuid");
    let schedule_id = schedule(held.clone()).await;
    assert_eq!(
        flags(held_id).await,
        (true, None),
        "reserved, never released"
    );

    // ---- 2. 40 days on, a held file is not reclaimable ---------------------
    age(held_id, "created_at").await;
    let outcome = reclaim_once(&app_pool, ws, held_id, DriveDelete::Deleted, &calls).await;
    assert_eq!(
        outcome,
        AttachmentReclaimOutcome::SkippedNotEligible,
        "a schedule holds it"
    );
    assert!(calls.lock().unwrap().is_empty(), "Drive was never asked");
    assert!(exists(held_id).await, "the row is untouched");

    // ---- 3. cancelling releases it — and the file is a draft for a full TTL -
    let cancelled = http
        .delete(format!(
            "{base}/v1/workspaces/{ws}/scheduled-messages/{schedule_id}"
        ))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("cancel");
    assert!(
        cancelled.status().is_success(),
        "cancel: {}",
        cancelled.status()
    );
    let (reserved, released_at) = flags(held_id).await;
    assert!(!reserved, "the hold ended");
    assert!(released_at.is_some(), "…and the release is stamped");
    let outcome = reclaim_once(&app_pool, ws, held_id, DriveDelete::Deleted, &calls).await;
    assert_eq!(
        outcome,
        AttachmentReclaimOutcome::SkippedNotEligible,
        "uploaded 40 days ago but released just now: still a draft for a full TTL"
    );
    assert!(calls.lock().unwrap().is_empty());
    assert!(exists(held_id).await);

    // ---- 4. a send-now releases a second file by binding it ----------------
    let sent_file = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "sent.txt",
        "text/plain",
        b"sent",
    )
    .await;
    let sent_id = Uuid::parse_str(&sent_file).expect("uuid");
    let sent_schedule = schedule(sent_file.clone()).await;
    assert!(flags(sent_id).await.0, "held until it goes out");
    let went = http
        .post(format!(
            "{base}/v1/workspaces/{ws}/scheduled-messages/{sent_schedule}/send-now"
        ))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("send now");
    assert_eq!(went.status(), 200);
    assert!(!flags(sent_id).await.0, "the hold ended with the send");
    age(sent_id, "created_at").await;
    age(sent_id, "unreserved_at").await;
    let outcome = reclaim_once(&app_pool, ws, sent_id, DriveDelete::Deleted, &calls).await;
    assert_eq!(
        outcome,
        AttachmentReclaimOutcome::SkippedNotEligible,
        "a file a message carries is never reclaimed, however old"
    );
    assert!(exists(sent_id).await);

    // ---- 5. 40 days after the release the draft goes -----------------------
    age(held_id, "unreserved_at").await;
    let drive_file_id: String =
        sqlx::query_scalar("SELECT drive_file_id FROM attachment WHERE id = $1")
            .bind(held_id)
            .fetch_one(&su)
            .await
            .expect("drive file id");
    let outcome = reclaim_once(&app_pool, ws, held_id, DriveDelete::Deleted, &calls).await;
    assert_eq!(outcome, AttachmentReclaimOutcome::Reclaimed);
    assert_eq!(
        *calls.lock().unwrap(),
        vec![drive_file_id],
        "exactly that Drive object"
    );
    assert!(!exists(held_id).await, "the row went with it");
    let audit: Vec<Value> = sqlx::query_scalar(
        "SELECT detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'attachment.expired' AND target_id = $2",
    )
    .bind(ws)
    .bind(held_id)
    .fetch_all(&su)
    .await
    .expect("expired audit");
    assert_eq!(audit.len(), 1, "one audit row says so");
    assert_eq!(audit[0]["schema"], json!("momo.attachment.expired.v1"));
    assert_eq!(audit[0]["reason"], json!("unbound_ttl"));
    assert_eq!(audit[0]["channel_id"], json!(ch.to_string()));
    assert!(
        !audit[0].to_string().contains("이도현") && audit[0].get("name").is_none(),
        "the audit row of a deletion carries no file name: {}",
        audit[0]
    );

    // ---- 6. the retention purge releases a hold by CASCADE, and the flag follows ----
    // `purge_expired_schedule_in_tx` deletes the schedule row as `momo_app` under its
    // author's scope; the reservation rows go with it by the foreign key's cascade, so this
    // is the one release that never names the reservation table in a statement.
    let cascaded = upload_and_complete(
        &http,
        &base,
        &alice,
        ws,
        ch,
        "cascaded.txt",
        "text/plain",
        b"cascade",
    )
    .await;
    let cascaded_id = Uuid::parse_str(&cascaded).expect("uuid");
    let cascaded_schedule = Uuid::parse_str(&schedule(cascaded.clone()).await).expect("uuid");
    assert!(flags(cascaded_id).await.0, "held by its schedule");
    let author = fixture.alice.member;
    momo_db::with_tenant_tx(&app_pool, ws, move |conn| {
        Box::pin(async move {
            momo_messaging::owner_scope::bind_owner_guc(conn, author).await?;
            sqlx::query("DELETE FROM scheduled_message WHERE id = $1")
                .bind(cascaded_schedule)
                .execute(&mut *conn)
                .await?;
            Ok(())
        })
    })
    .await
    .expect("purge the schedule row");
    let (reserved, released_at) = flags(cascaded_id).await;
    assert!(!reserved, "the cascade released the hold");
    assert!(released_at.is_some(), "…and stamped the release");
}
