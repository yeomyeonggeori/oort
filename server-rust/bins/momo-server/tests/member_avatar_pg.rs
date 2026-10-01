//! Member avatar conformance (ADR-0161 증보, #3277) — the four member-avatar
//! routes, driven over real HTTP against real Postgres.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:25432/momo \
//!   cargo test -p momo-server --test member_avatar_pg -- --ignored --nocapture --test-threads=1
//! ```
//!
//! What this file pins:
//!
//! * the self round trip (upload → Drive PUT → complete → roster `avatarUrl`),
//! * **self-only**: another member's pending media cannot be completed (404),
//!   no route names another member for a write, and the composite FK refuses a
//!   pointer at someone else's media on a NOBYPASSRLS `momo_app` connection,
//! * server-side validation: mime allow-list (no SVG), size ceiling, and a
//!   magic-number check on the bytes Drive actually holds,
//! * remove, replace, and the legacy `avatar_url` fallback,
//! * read visibility: any active member of the same workspace; another
//!   workspace is a scope mismatch and RLS shows it zero rows,
//! * agents: an agent bearer is refused on the write routes.
//!
//! Sabotage targets (recorded in the PR): drop the `member_id = $3` filter in
//! `load_own_member_avatar_media_in_tx` (self-only); drop the magic-number
//! comparison in `complete` (sniff).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_drive::{DriveArchive, StubDriveArchive};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "member-avatar-conformance-secret";
const TEST_PASSWORD: &str = "member-avatar-password";

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

struct Person {
    email: String,
    member: Uuid,
}

async fn seed_person(su: &PgPool, workspace: Uuid, role: &str) -> Person {
    let member = Uuid::new_v4();
    let email = format!("{member}@member-avatar.test");
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
    sqlx::query("INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, $3::membership_role)")
        .bind(workspace)
        .bind(member)
        .bind(role)
        .execute(su)
        .await
        .expect("seed workspace_membership");
    Person { email, member }
}

async fn seed_workspace(su: &PgPool) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    workspace
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

/// A PNG header with real dimensions (the server reads them), padded so two
/// fixtures differ byte-for-byte.
fn png_bytes(w: u32, h: u32, tag: &[u8]) -> Vec<u8> {
    let mut v = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    v.extend_from_slice(&w.to_be_bytes());
    v.extend_from_slice(&h.to_be_bytes());
    v.extend_from_slice(&[8, 6, 0, 0, 0]);
    v.extend_from_slice(tag);
    v
}

fn png() -> Vec<u8> {
    png_bytes(16, 16, b"first")
}

fn png2() -> Vec<u8> {
    png_bytes(16, 16, b"second-picture")
}

fn gif_bytes(w: u16, h: u16) -> Vec<u8> {
    let mut v = b"GIF89a".to_vec();
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
    v.extend_from_slice(&[0, 0, 0]);
    v
}

fn webp_vp8x(w: u32, h: u32) -> Vec<u8> {
    let mut v = b"RIFF\x1a\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0".to_vec();
    v.extend_from_slice(&(w - 1).to_le_bytes()[..3]);
    v.extend_from_slice(&(h - 1).to_le_bytes()[..3]);
    v
}

fn webp_vp8l(w: u32, h: u32) -> Vec<u8> {
    let mut v = b"RIFF\x1a\0\0\0WEBPVP8L\x05\0\0\0\x2f".to_vec();
    v.extend_from_slice(&((w - 1) | ((h - 1) << 14)).to_le_bytes());
    v.push(0);
    v
}

fn webp_vp8(w: u16, h: u16) -> Vec<u8> {
    let mut v = b"RIFF\x1a\0\0\0WEBPVP8 \x0a\0\0\0\x10\x02\0\x9d\x01\x2a".to_vec();
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&h.to_le_bytes());
    v
}

fn jpeg_bytes(w: u16, h: u16, sof: u8) -> Vec<u8> {
    let mut v = vec![0xFF, 0xD8, 0xFF, sof, 0, 17, 8];
    v.extend_from_slice(&h.to_be_bytes());
    v.extend_from_slice(&w.to_be_bytes());
    v.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    v
}

const CACHE_IMMUTABLE: &str = "private, max-age=31536000, immutable";
const SVG: &[u8] = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>";

fn base_path(workspace: Uuid) -> String {
    format!("/v1/workspaces/{workspace}/members/me/avatar")
}

async fn create_upload(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    mime: &str,
    size: usize,
) -> reqwest::Response {
    http.post(format!("{base}{}/uploads", base_path(workspace)))
        .bearer_auth(token)
        .json(&json!({"name": "me.png", "mime": mime, "size": size}))
        .send()
        .await
        .expect("create upload")
}

/// Open a session and PUT the bytes to the stub, returning the pending media id.
async fn start_and_put(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    mime: &str,
    bytes: &[u8],
) -> String {
    let created = create_upload(http, base, token, workspace, mime, bytes.len()).await;
    assert_eq!(created.status(), 201, "a created session answers 201");
    let created: Value = created.json().await.expect("upload body");
    let uploaded = http
        .put(created["uploadUrl"].as_str().expect("uploadUrl"))
        .header(reqwest::header::CONTENT_TYPE, mime)
        .body(bytes.to_vec())
        .send()
        .await
        .expect("stub upload");
    assert_eq!(uploaded.status(), 200, "bytes go straight to the archive");
    created["id"].as_str().expect("id").to_string()
}

async fn complete(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    media: &str,
) -> reqwest::Response {
    http.post(format!("{base}{}/{media}/complete", base_path(workspace)))
        .bearer_auth(token)
        .send()
        .await
        .expect("complete")
}

async fn upload_avatar(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    mime: &str,
    bytes: &[u8],
) -> Value {
    let id = start_and_put(http, base, token, workspace, mime, bytes).await;
    let done = complete(http, base, token, workspace, &id).await;
    assert_eq!(done.status(), 200, "a verified upload completes");
    done.json().await.expect("complete body")
}

async fn roster_avatar(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    member: Uuid,
) -> Option<String> {
    let body: Value = http
        .get(format!("{base}/v1/workspaces/{workspace}/roster"))
        .bearer_auth(token)
        .send()
        .await
        .expect("roster")
        .json()
        .await
        .expect("roster body");
    let rows = body["members"]
        .as_array()
        .or_else(|| body.as_array())
        .unwrap_or_else(|| panic!("roster shape: {body}"));
    let row = rows
        .iter()
        .find(|row| row["id"] == json!(member.to_string()))
        .unwrap_or_else(|| panic!("member in roster: {body}"));
    row["avatarUrl"].as_str().map(str::to_string)
}

async fn get_content(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    member: Uuid,
) -> reqwest::Response {
    get_content_v(http, base, token, workspace, member, None).await
}

async fn get_content_v(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    member: Uuid,
    v: Option<&str>,
) -> reqwest::Response {
    let query = v.map(|v| format!("?v={v}")).unwrap_or_default();
    http.get(format!(
        "{base}/v1/workspaces/{workspace}/members/{member}/avatar/content{query}"
    ))
    .bearer_auth(token)
    .send()
    .await
    .expect("content")
}

async fn pointer(su: &PgPool, member: Uuid) -> Option<Uuid> {
    sqlx::query_scalar("SELECT avatar_media_id FROM member WHERE id = $1")
        .bind(member)
        .fetch_one(su)
        .await
        .expect("read pointer")
}

struct World {
    su: PgPool,
    app: PgPool,
    base: String,
    http: reqwest::Client,
    ws: Uuid,
    alice: Person,
    bob: Person,
    alice_token: String,
    bob_token: String,
}

async fn world() -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let ws = seed_workspace(&su).await;
    let alice = seed_person(&su, ws, "member").await;
    let bob = seed_person(&su, ws, "member").await;
    let alice_token = login(&http, &base, ws, &alice).await;
    let bob_token = login(&http, &base, ws, &bob).await;
    World {
        su,
        app,
        base,
        http,
        ws,
        alice,
        bob,
        alice_token,
        bob_token,
    }
}

/// Self round trip + same-workspace read + immutable caching + roster URL.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_member_sets_their_own_avatar_and_everyone_in_the_workspace_reads_it() {
    let w = world().await;
    assert_eq!(
        roster_avatar(&w.http, &w.base, &w.bob_token, w.ws, w.alice.member).await,
        None,
        "no avatar yet"
    );

    let done = upload_avatar(&w.http, &w.base, &w.alice_token, w.ws, "image/png", &png()).await;
    assert_eq!(done["status"], json!("complete"));
    assert_eq!(done["memberId"], json!(w.alice.member.to_string()));
    let media = done["id"].as_str().expect("id").to_string();
    assert!(pointer(&w.su, w.alice.member).await.is_some());

    // Every member DTO that exposes avatarUrl exposes the resolved one: the
    // roster, read by someone else, carries the versioned content path.
    let expected = format!(
        "/v1/workspaces/{}/members/{}/avatar/content?v={media}",
        w.ws, w.alice.member
    );
    assert_eq!(done["avatarUrl"], json!(expected));
    assert_eq!(
        roster_avatar(&w.http, &w.base, &w.bob_token, w.ws, w.alice.member).await,
        Some(expected)
    );

    // Another active member of the same workspace may read it — through the
    // versioned URL the roster handed out.
    let read = get_content_v(
        &w.http,
        &w.base,
        &w.bob_token,
        w.ws,
        w.alice.member,
        Some(&media),
    )
    .await;
    assert_eq!(read.status(), 200);
    let headers = read.headers().clone();
    assert_eq!(headers[reqwest::header::CONTENT_TYPE], "image/png");
    assert_eq!(headers[reqwest::header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(
        headers[reqwest::header::CONTENT_SECURITY_POLICY],
        "default-src 'none'; sandbox"
    );
    assert_eq!(headers[reqwest::header::CACHE_CONTROL], CACHE_IMMUTABLE);
    assert_eq!(
        read.bytes().await.expect("bytes").as_ref(),
        png().as_slice()
    );

    // A member with no avatar is a 404, not an empty 200.
    let none = get_content(&w.http, &w.base, &w.alice_token, w.ws, w.bob.member).await;
    assert_eq!(none.status(), 404);

    // Replacement: a new media id, a new `?v=`, the old bytes are gone.
    let second = upload_avatar(&w.http, &w.base, &w.alice_token, w.ws, "image/png", &png2()).await;
    assert_ne!(second["id"], json!(media));
    assert_ne!(second["avatarUrl"], done["avatarUrl"], "?v= must change");
    let second_media = second["id"].as_str().unwrap().to_string();
    let read = get_content_v(
        &w.http,
        &w.base,
        &w.bob_token,
        w.ws,
        w.alice.member,
        Some(&second_media),
    )
    .await;
    assert_eq!(
        read.bytes().await.expect("bytes").as_ref(),
        png2().as_slice()
    );
    // L-1: the replaced version's URL no longer serves anything — a stale `?v=`
    // must never get today's bytes under yesterday's year-long cache key.
    let stale = get_content_v(
        &w.http,
        &w.base,
        &w.bob_token,
        w.ws,
        w.alice.member,
        Some(&media),
    )
    .await;
    assert_eq!(stale.status(), 404, "the replaced media's v is stale");
    let forged = get_content_v(
        &w.http,
        &w.base,
        &w.bob_token,
        w.ws,
        w.alice.member,
        Some("garbage"),
    )
    .await;
    assert_eq!(forged.status(), 404, "a v that names no media is stale");
    // A bare fetch (no v) is served but is not cacheable-immutable.
    let bare = get_content(&w.http, &w.base, &w.bob_token, w.ws, w.alice.member).await;
    assert_eq!(bare.status(), 200);
    assert_eq!(
        bare.headers()[reqwest::header::CACHE_CONTROL],
        "private, no-cache"
    );

    // Idempotent complete: a second call answers the same row.
    let again = complete(
        &w.http,
        &w.base,
        &w.alice_token,
        w.ws,
        second["id"].as_str().unwrap(),
    )
    .await;
    assert_eq!(again.status(), 200);

    // L-4: a *completed* upload that is no longer current is not re-pointed at.
    // The replaced media answers 409 and Alice keeps her current avatar.
    let before = pointer(&w.su, w.alice.member).await;
    let replaced = complete(&w.http, &w.base, &w.alice_token, w.ws, &media).await;
    assert_eq!(
        replaced.status(),
        409,
        "a replaced upload cannot be re-completed"
    );
    assert_eq!(pointer(&w.su, w.alice.member).await, before);
    // Same after a removal: the once-current media is not resurrected.
    let removed = w
        .http
        .delete(format!("{}{}", w.base, base_path(w.ws)))
        .bearer_auth(&w.alice_token)
        .send()
        .await
        .expect("remove");
    assert_eq!(removed.status(), 204);
    let resurrect = complete(&w.http, &w.base, &w.alice_token, w.ws, &second_media).await;
    assert_eq!(
        resurrect.status(),
        409,
        "a removed avatar is not resurrected by complete"
    );
    assert_eq!(pointer(&w.su, w.alice.member).await, None);
}

/// SELF-ONLY. The red proof of this file.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_member_cannot_touch_another_members_avatar() {
    let w = world().await;

    // Alice opens an upload; Bob learns the media id and tries to finish it.
    let alice_media =
        start_and_put(&w.http, &w.base, &w.alice_token, w.ws, "image/png", &png()).await;
    let hijack = complete(&w.http, &w.base, &w.bob_token, w.ws, &alice_media).await;
    assert_eq!(
        hijack.status(),
        404,
        "another member's pending upload is invisible to complete"
    );
    assert_eq!(
        pointer(&w.su, w.bob.member).await,
        None,
        "Bob has no avatar"
    );
    assert_eq!(
        pointer(&w.su, w.alice.member).await,
        None,
        "nor did Alice's move"
    );

    // There is no write route that names another member.
    for (method, path) in [
        (
            "POST",
            format!(
                "/v1/workspaces/{}/members/{}/avatar/uploads",
                w.ws, w.alice.member
            ),
        ),
        (
            "DELETE",
            format!("/v1/workspaces/{}/members/{}/avatar", w.ws, w.alice.member),
        ),
        (
            "PUT",
            format!("/v1/workspaces/{}/members/{}/avatar", w.ws, w.alice.member),
        ),
    ] {
        let response = w
            .http
            .request(method.parse().unwrap(), format!("{}{path}", w.base))
            .bearer_auth(&w.bob_token)
            .json(&json!({"name": "x.png", "mime": "image/png", "size": 1}))
            .send()
            .await
            .expect("cross-member write");
        assert_eq!(
            response.status(),
            404,
            "{method} {path}: no such route, so nothing to write to"
        );
    }

    // Alice finishes hers; Bob's DELETE (which only ever means "mine") leaves it.
    let done = complete(&w.http, &w.base, &w.alice_token, w.ws, &alice_media).await;
    assert_eq!(done.status(), 200);
    let alices = pointer(&w.su, w.alice.member).await;
    assert!(alices.is_some());
    let removed = w
        .http
        .delete(format!("{}{}", w.base, base_path(w.ws)))
        .bearer_auth(&w.bob_token)
        .send()
        .await
        .expect("bob deletes his own");
    assert_eq!(removed.status(), 204);
    assert_eq!(
        pointer(&w.su, w.alice.member).await,
        alices,
        "Alice's avatar untouched"
    );

    // The DB says the same thing without the route's help: on the production
    // NOBYPASSRLS role, pointing Bob's row at Alice's media is a FK violation.
    let mut tx = w.app.begin().await.expect("begin");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(w.ws.to_string())
        .execute(&mut *tx)
        .await
        .expect("bind GUC");
    let refused = sqlx::query("UPDATE member SET avatar_media_id = $1 WHERE id = $2")
        .bind(alices.unwrap())
        .bind(w.bob.member)
        .execute(&mut *tx)
        .await
        .expect_err("a pointer at another member's media must be unrepresentable");
    let message = refused.to_string();
    assert!(
        message.contains("member_avatar_media_self_fk"),
        "expected the composite FK, got: {message}"
    );
}

/// Server-side validation: mime allow-list, size, and the bytes themselves.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_server_refuses_bad_mimes_oversize_files_and_bytes_that_are_not_the_image_claimed() {
    let w = world().await;

    for mime in [
        "image/svg+xml",
        "application/pdf",
        "text/html",
        "image/heic",
        "",
    ] {
        let response = create_upload(&w.http, &w.base, &w.alice_token, w.ws, mime, 10).await;
        assert_eq!(response.status(), 400, "{mime:?} must be a 400");
    }
    for size in [5 * 1024 * 1024 + 1, 0] {
        let response =
            create_upload(&w.http, &w.base, &w.alice_token, w.ws, "image/png", size).await;
        assert_eq!(response.status(), 413, "size {size} must be a 413");
    }
    let nameless = w
        .http
        .post(format!("{}{}/uploads", w.base, base_path(w.ws)))
        .bearer_auth(&w.alice_token)
        .json(&json!({"name": "../x.png", "mime": "image/png", "size": 4}))
        .send()
        .await
        .expect("bad name");
    assert_eq!(nameless.status(), 400);
    // Unknown fields are refused (deny_unknown_fields): a member id smuggled
    // into the body cannot do anything.
    let smuggled = w
        .http
        .post(format!("{}{}/uploads", w.base, base_path(w.ws)))
        .bearer_auth(&w.alice_token)
        .json(&json!({"name": "a.png", "mime": "image/png", "size": 4,
                      "memberId": w.bob.member.to_string()}))
        .send()
        .await
        .expect("smuggled member id");
    assert!(smuggled.status().is_client_error());

    // SVG bytes uploaded under an `image/png` label: Drive's size and mime agree
    // with the declaration, only the magic number does not. 409, and the row is
    // `failed` — it never becomes anybody's avatar.
    let media = start_and_put(&w.http, &w.base, &w.alice_token, w.ws, "image/png", SVG).await;
    let done = complete(&w.http, &w.base, &w.alice_token, w.ws, &media).await;
    assert_eq!(
        done.status(),
        409,
        "bytes that are not a PNG must not complete as one"
    );
    assert_eq!(pointer(&w.su, w.alice.member).await, None);
    let status: String = sqlx::query_scalar("SELECT status FROM member_avatar_media WHERE id = $1")
        .bind(Uuid::parse_str(&media).unwrap())
        .fetch_one(&w.su)
        .await
        .expect("row");
    assert_eq!(status, "failed");

    // Size boundary: exactly 5 MiB is accepted, one byte more is not.
    let exact = create_upload(
        &w.http,
        &w.base,
        &w.alice_token,
        w.ws,
        "image/png",
        5 * 1024 * 1024,
    )
    .await;
    assert_eq!(exact.status(), 201, "exactly 5 MiB is within the ceiling");
    let over = create_upload(
        &w.http,
        &w.base,
        &w.alice_token,
        w.ws,
        "image/png",
        5 * 1024 * 1024 + 1,
    )
    .await;
    assert_eq!(over.status(), 413);
}

/// Complete a session for `bytes` declared as `mime` and return the response.
async fn put_and_complete(w: &World, mime: &str, bytes: &[u8]) -> (reqwest::Response, String) {
    let media = start_and_put(&w.http, &w.base, &w.alice_token, w.ws, mime, bytes).await;
    (
        complete(&w.http, &w.base, &w.alice_token, w.ws, &media).await,
        media,
    )
}

/// M-1 — the decode bomb. A small file whose header declares a huge canvas must
/// not become anybody's avatar: every format's oversize case, the 4096 boundary,
/// and headers whose dimensions cannot be read.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_header_declaring_more_than_4096_by_4096_never_becomes_an_avatar() {
    let w = world().await;
    let oversize: Vec<(&str, &str, Vec<u8>)> = vec![
        ("png wide", "image/png", png_bytes(4097, 16, b"x")),
        ("png tall", "image/png", png_bytes(16, 4097, b"x")),
        ("png huge", "image/png", png_bytes(u32::MAX, u32::MAX, b"x")),
        ("gif", "image/gif", gif_bytes(4097, 16)),
        ("gif max", "image/gif", gif_bytes(u16::MAX, u16::MAX)),
        ("webp vp8x", "image/webp", webp_vp8x(4097, 16)),
        (
            "webp vp8x huge",
            "image/webp",
            webp_vp8x(16_777_216, 16_777_216),
        ),
        ("webp vp8l", "image/webp", webp_vp8l(4097, 16)),
        ("webp vp8", "image/webp", webp_vp8(16_383, 16)),
        ("jpeg sof0", "image/jpeg", jpeg_bytes(4097, 16, 0xC0)),
        ("jpeg sof2", "image/jpeg", jpeg_bytes(16, 4097, 0xC2)),
        (
            "jpeg max",
            "image/jpeg",
            jpeg_bytes(u16::MAX, u16::MAX, 0xC0),
        ),
    ];
    for (label, mime, bytes) in oversize {
        let (response, media) = put_and_complete(&w, mime, &bytes).await;
        assert_eq!(
            response.status(),
            422,
            "{label}: oversize header must be refused"
        );
        let status: String =
            sqlx::query_scalar("SELECT status FROM member_avatar_media WHERE id = $1")
                .bind(Uuid::parse_str(&media).unwrap())
                .fetch_one(&w.su)
                .await
                .expect("row");
        assert_eq!(status, "failed", "{label}: the upload is marked failed");
        assert_eq!(
            pointer(&w.su, w.alice.member).await,
            None,
            "{label}: no avatar set"
        );
    }

    // Unreadable dimensions are a refusal, not a pass: right magic number, no
    // IHDR / no SOF / truncated.
    let mut no_ihdr = png_bytes(16, 16, b"x");
    no_ihdr[12..16].copy_from_slice(b"IDAT");
    let unreadable: Vec<(&str, &str, Vec<u8>)> = vec![
        ("png without IHDR", "image/png", no_ihdr),
        (
            "png truncated",
            "image/png",
            b"\x89PNG\r\n\x1a\n\0\0".to_vec(),
        ),
        (
            "jpeg without SOF",
            "image/jpeg",
            vec![0xFF, 0xD8, 0xFF, 0xDA, 0, 4, 0, 0],
        ),
        ("png zero width", "image/png", png_bytes(0, 16, b"x")),
    ];
    for (label, mime, bytes) in unreadable {
        let (response, _) = put_and_complete(&w, mime, &bytes).await;
        assert_eq!(
            response.status(),
            422,
            "{label}: unreadable dimensions are refused"
        );
    }
    assert_eq!(pointer(&w.su, w.alice.member).await, None);

    // The boundary itself, and a normal one per format, still succeed.
    for (label, mime, bytes) in [
        ("png 4096", "image/png", png_bytes(4096, 4096, b"edge")),
        ("gif", "image/gif", gif_bytes(64, 64)),
        ("webp vp8x", "image/webp", webp_vp8x(512, 512)),
        ("jpeg sof2", "image/jpeg", jpeg_bytes(640, 480, 0xC2)),
    ] {
        let (response, _) = put_and_complete(&w, mime, &bytes).await;
        assert_eq!(
            response.status(),
            200,
            "{label} within the ceiling completes"
        );
    }
}

/// M-2 — the hourly session limit counts every status and cannot be beaten by a
/// burst. 20 are allowed; the rest are 429, whether they arrive one by one or all
/// at once.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_hourly_upload_limit_counts_every_status_and_holds_under_a_burst() {
    let w = world().await;

    // Serial: 1 complete + 1 failed (svg bytes under a png label) + 18 pending
    // = 20 sessions of three different statuses; the 21st is refused.
    let (done, _) = put_and_complete(&w, "image/png", &png()).await;
    assert_eq!(done.status(), 200);
    let (bad, _) = put_and_complete(&w, "image/png", SVG).await;
    assert_eq!(bad.status(), 409);
    for i in 0..18 {
        let r = create_upload(&w.http, &w.base, &w.alice_token, w.ws, "image/png", 4).await;
        assert_eq!(r.status(), 201, "session {i} is within the limit");
    }
    let refused = create_upload(&w.http, &w.base, &w.alice_token, w.ws, "image/png", 4).await;
    assert_eq!(refused.status(), 429, "complete and failed rows count too");
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM member_avatar_media WHERE member_id = $1")
            .bind(w.alice.member)
            .fetch_one(&w.su)
            .await
            .expect("count");
    assert_eq!(rows, 20, "the refused request reserved nothing");

    // Burst: 40 simultaneous requests from a fresh member — exactly 20 get in.
    let mut tasks = Vec::new();
    for _ in 0..40 {
        let (http, base, token, ws) = (w.http.clone(), w.base.clone(), w.bob_token.clone(), w.ws);
        tasks.push(tokio::spawn(async move {
            create_upload(&http, &base, &token, ws, "image/png", 4)
                .await
                .status()
                .as_u16()
        }));
    }
    let mut created = 0;
    let mut limited = 0;
    for task in tasks {
        match task.await.expect("join") {
            201 => created += 1,
            429 => limited += 1,
            other => panic!("unexpected status {other}"),
        }
    }
    assert_eq!(
        (created, limited),
        (20, 20),
        "a burst cannot overshoot the hourly limit"
    );
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM member_avatar_media WHERE member_id = $1")
            .bind(w.bob.member)
            .fetch_one(&w.su)
            .await
            .expect("count");
    assert_eq!(rows, 20);
}

/// L-3 — guests may set their own picture ("everyone can set their own"); they
/// still cannot reach anyone else's.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_guest_may_set_and_remove_their_own_avatar_only() {
    let w = world().await;
    let guest = seed_person(&w.su, w.ws, "guest").await;
    let guest_token = login(&w.http, &w.base, w.ws, &guest).await;

    let done = upload_avatar(&w.http, &w.base, &guest_token, w.ws, "image/png", &png()).await;
    assert_eq!(done["memberId"], json!(guest.member.to_string()));
    assert!(pointer(&w.su, guest.member).await.is_some());

    // …but a guest cannot finish a member's upload.
    let alice_media =
        start_and_put(&w.http, &w.base, &w.alice_token, w.ws, "image/png", &png2()).await;
    let hijack = complete(&w.http, &w.base, &guest_token, w.ws, &alice_media).await;
    assert_eq!(hijack.status(), 404);

    let removed = w
        .http
        .delete(format!("{}{}", w.base, base_path(w.ws)))
        .bearer_auth(&guest_token)
        .send()
        .await
        .expect("guest removes");
    assert_eq!(removed.status(), 204);
    assert_eq!(pointer(&w.su, guest.member).await, None);
}

/// Remove, and the legacy `avatar_url` decision (D-M4).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn remove_clears_the_avatar_and_the_legacy_url_is_the_fallback() {
    let w = world().await;
    sqlx::query("UPDATE member SET avatar_url = '/legacy/alice.png' WHERE id = $1")
        .bind(w.alice.member)
        .execute(&w.su)
        .await
        .expect("seed legacy url");
    assert_eq!(
        roster_avatar(&w.http, &w.base, &w.bob_token, w.ws, w.alice.member).await,
        Some("/legacy/alice.png".to_string()),
        "no upload: the legacy column is shown unchanged"
    );

    let done = upload_avatar(&w.http, &w.base, &w.alice_token, w.ws, "image/png", &png()).await;
    assert_eq!(
        roster_avatar(&w.http, &w.base, &w.bob_token, w.ws, w.alice.member).await,
        done["avatarUrl"].as_str().map(str::to_string),
        "an uploaded avatar wins over the legacy column"
    );

    let removed = w
        .http
        .delete(format!("{}{}", w.base, base_path(w.ws)))
        .bearer_auth(&w.alice_token)
        .send()
        .await
        .expect("delete");
    assert_eq!(removed.status(), 204);
    assert_eq!(pointer(&w.su, w.alice.member).await, None);
    assert_eq!(
        roster_avatar(&w.http, &w.base, &w.bob_token, w.ws, w.alice.member).await,
        Some("/legacy/alice.png".to_string()),
        "removing the upload falls back to the legacy value, which is left alone"
    );
    let gone = get_content(&w.http, &w.base, &w.bob_token, w.ws, w.alice.member).await;
    assert_eq!(gone.status(), 404, "the removed bytes are no longer served");

    // Idempotent: a second delete is still a 204 and writes no second audit row.
    let again = w
        .http
        .delete(format!("{}{}", w.base, base_path(w.ws)))
        .bearer_auth(&w.alice_token)
        .send()
        .await
        .expect("delete again");
    assert_eq!(again.status(), 204);
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = 'member.avatar_removed'",
    )
    .bind(w.ws)
    .fetch_one(&w.su)
    .await
    .expect("audit count");
    assert_eq!(audits, 1);
}

/// Cross-workspace isolation, over HTTP and at the RLS policy.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn another_workspace_cannot_read_or_see_the_avatar() {
    let w = world().await;
    upload_avatar(&w.http, &w.base, &w.alice_token, w.ws, "image/png", &png()).await;

    let other_ws = seed_workspace(&w.su).await;
    let outsider = seed_person(&w.su, other_ws, "owner").await;
    let outsider_token = login(&w.http, &w.base, other_ws, &outsider).await;

    // Addressing A's workspace with B's token: scope mismatch.
    let cross = get_content(&w.http, &w.base, &outsider_token, w.ws, w.alice.member).await;
    assert_eq!(cross.status(), 403);
    // Addressing B's own workspace with A's member id: that member is not there.
    let wrong = get_content(&w.http, &w.base, &outsider_token, other_ws, w.alice.member).await;
    assert_eq!(wrong.status(), 404);
    // And the writes are scoped to the caller's own workspace.
    let write = create_upload(&w.http, &w.base, &outsider_token, w.ws, "image/png", 4).await;
    assert_eq!(write.status(), 403);

    // The RLS policy itself: same NOBYPASSRLS connection, two tenants.
    for (tenant, expected) in [(w.ws, 1_i64), (other_ws, 0_i64)] {
        let mut tx = w.app.begin().await.expect("begin");
        sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
            .bind(tenant.to_string())
            .execute(&mut *tx)
            .await
            .expect("bind GUC");
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM member_avatar_media")
            .fetch_one(&mut *tx)
            .await
            .expect("count");
        tx.rollback().await.expect("rollback");
        assert_eq!(count, expected, "tenant {tenant}");
    }

    // A departed member's avatar is not served either.
    sqlx::query("UPDATE member SET deleted_at = now() WHERE id = $1")
        .bind(w.alice.member)
        .execute(&w.su)
        .await
        .expect("soft delete");
    let gone = get_content(&w.http, &w.base, &w.bob_token, w.ws, w.alice.member).await;
    assert_eq!(gone.status(), 404);
}

/// Agents cannot change human avatars (nor their own, in this version).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn an_agent_bearer_is_refused_on_the_avatar_routes() {
    let w = world().await;
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(w.ws)
    .bind(format!("bot-{agent}"))
    .execute(&w.su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'claude-opus-4', 'https://gateway.invalid/v1', 4, 50, $3)",
    )
    .bind(agent)
    .bind(w.ws)
    .bind(w.alice.member)
    .execute(&w.su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(w.ws)
    .bind(agent)
    .execute(&w.su)
    .await
    .expect("seed agent workspace membership");
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{}.{secret}", w.ws);
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['work:control','messages:write','messages:read'], 'member-avatar-conformance')",
    )
    .bind(w.ws)
    .bind(agent)
    .bind(&token)
    .execute(&w.su)
    .await
    .expect("seed agent bearer");

    let upload = create_upload(&w.http, &w.base, &token, w.ws, "image/png", 4).await;
    assert_eq!(upload.status(), 403);
    let delete = w
        .http
        .delete(format!("{}{}", w.base, base_path(w.ws)))
        .bearer_auth(&token)
        .send()
        .await
        .expect("agent delete");
    assert_eq!(delete.status(), 403);
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM member_avatar_media WHERE workspace_id = $1")
            .bind(w.ws)
            .fetch_one(&w.su)
            .await
            .expect("count");
    assert_eq!(rows, 0, "the refused agent wrote nothing");
}
