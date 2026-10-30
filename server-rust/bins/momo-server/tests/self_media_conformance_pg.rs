//! #4820 C2a — `GET /v1/self-media/{ws}/{token}` over real HTTP against a real PG18.
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26821/postgres \
//!   cargo test -p momo-server --test self_media_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! The server runs as `momo_app` (`rolsuper=false`, `rolbypassrls=false`); the fixture is seeded as
//! the superuser; tokens are minted by the real `momo_messaging::mint_with_ttl_in_tx`. The Drive
//! archive is an in-process map that (a) answers a deliberately leaky mime string so a response that
//! passed it through would show, and (b) counts content reads so a refusal that reached Drive would show.

use std::collections::{BTreeSet, HashMap};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_drive::{DriveArchive, DriveContent, DriveError, DriveFile, DriveUploadSession};
use momo_messaging::{mint_with_ttl_in_tx, token_hash};
use momo_server::{build_app, AppState};
use uuid::Uuid;

const LEAKY_DRIVE_MIME: &str = "application/x-drive-internal-mime";

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

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("superuser pool")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let password =
        std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password(&password))
        .await
        .expect("momo_app pool")
}

/// Holds the bytes of the files a test registers and counts every content read.
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
            mime: LEAKY_DRIVE_MIME.to_string(),
            size_bytes: bytes.len() as i64,
            body: futures::stream::once(async move { Ok(axum::body::Bytes::from(bytes)) }).boxed(),
        })
    }
}

fn png_bytes(len: usize) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.resize(len, 0x42);
    bytes
}

struct Server {
    base: String,
    archive: Arc<MapArchive>,
    su: PgPool,
    app: PgPool,
}

async fn start() -> Server {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let archive = Arc::new(MapArchive::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().unwrap();
    let state = AppState::new(
        app.clone(),
        "self-media-conformance-signing-secret".to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_drive(archive.clone());
    let router = build_app(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Server {
        base: format!("http://{address}"),
        archive,
        su,
        app,
    }
}

struct Tenant {
    ws: Uuid,
    alice: Uuid,
    bob: Uuid,
    agent: Uuid,
    channel: Uuid,
    trigger: Uuid,
    drive_file: String,
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

async fn seed_attachment(
    server: &Server,
    ws: Uuid,
    channel: Uuid,
    uploader: Uuid,
    message: Uuid,
    bytes: Vec<u8>,
) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let drive_file = format!("drv-{id}");
    sqlx::query(
        "INSERT INTO attachment (id, workspace_id, channel_id, uploader_member_id, message_id, \
         drive_file_id, name, mime, size_bytes, status) \
         VALUES ($1, $2, $3, $4, $5, $6, 'photo', 'image/png', $7, 'complete')",
    )
    .bind(id)
    .bind(ws)
    .bind(channel)
    .bind(uploader)
    .bind(message)
    .bind(&drive_file)
    .bind(bytes.len() as i64)
    .execute(&server.su)
    .await
    .unwrap();
    server
        .archive
        .files
        .lock()
        .unwrap()
        .insert(drive_file.clone(), bytes);
    (id, drive_file)
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
    .bind(format!("self-media:{run}"))
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
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, created_by) \
         VALUES ($1, $2, 'public', 'general', $3)",
    )
    .bind(channel)
    .bind(ws)
    .bind(alice)
    .execute(su)
    .await
    .unwrap();
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(ws)
        .execute(su)
        .await
        .unwrap();
    for member in [alice, bob, agent] {
        sqlx::query("INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)")
            .bind(ws)
            .bind(channel)
            .bind(member)
            .execute(su)
            .await
            .unwrap();
    }
    let trigger = seed_message(su, ws, channel, alice).await;
    let (_attachment, drive_file) =
        seed_attachment(server, ws, channel, alice, trigger, png_bytes(4096)).await;
    let run = seed_run(su, ws, channel, agent, trigger).await;
    Tenant {
        ws,
        alice,
        bob,
        agent,
        channel,
        trigger,
        drive_file,
        run,
    }
}

async fn mint(server: &Server, tenant: &Tenant, ttl_secs: i64) -> String {
    let (ws, run, agent) = (tenant.ws, tenant.run, tenant.agent);
    with_tenant_tx(&server.app, ws, move |conn| {
        Box::pin(async move { mint_with_ttl_in_tx(conn, ws, run, agent, ttl_secs).await })
    })
    .await
    .expect("mint")
    .expect("a token")
    .token
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap()
}

struct Seen {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

async fn get(server: &Server, path: &str) -> Seen {
    let response = client()
        .get(format!("{}{}", server.base, path))
        .send()
        .await
        .expect("request");
    seen(response).await
}

async fn seen(response: reqwest::Response) -> Seen {
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

fn address(tenant: &Tenant, token: &str) -> String {
    format!("/v1/self-media/{}/{token}", tenant.ws)
}

/// The served picture: exactly the row's bytes and mime, a fixed header list, no redirect, no
/// Drive id or Drive string anywhere on the wire — and the second request is the one refusal.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_picture_is_served_once_with_a_fixed_header_list_and_no_drive_trace() {
    let server = start().await;
    let tenant = seed_tenant(&server).await;
    let token = mint(&server, &tenant, 300).await;

    let served = get(&server, &address(&tenant, &token)).await;
    assert_eq!(served.status, 200, "served");
    assert_eq!(served.body, png_bytes(4096), "the attachment's own bytes");
    let names: BTreeSet<String> = served.headers.iter().map(|(n, _)| n.clone()).collect();
    let allowed: BTreeSet<String> = [
        "content-type",
        "content-length",
        "content-disposition",
        "x-content-type-options",
        "cache-control",
        "referrer-policy",
        "date",
    ]
    .iter()
    .map(|name| name.to_string())
    .collect();
    assert_eq!(
        names, allowed,
        "a fixed header list, nothing the archive supplied"
    );
    assert!(!names.contains("location"), "no redirect");
    let header = |name: &str| {
        served
            .headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
            .unwrap()
    };
    assert_eq!(
        header("content-type"),
        "image/png",
        "the row's mime, not the archive's"
    );
    assert_eq!(header("content-length"), "4096");
    assert_eq!(header("x-content-type-options"), "nosniff");
    assert_eq!(header("cache-control"), "private, no-store");
    let everything = served
        .headers
        .iter()
        .map(|(n, v)| format!("{n}: {v}"))
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    for forbidden in [
        tenant.drive_file.to_lowercase(),
        LEAKY_DRIVE_MIME.to_string(),
        "drive".to_string(),
        "google".to_string(),
    ] {
        assert!(
            !everything.contains(&forbidden),
            "the response headers must carry no Drive trace ({forbidden}): {everything}"
        );
    }
    assert_eq!(
        server.archive.reads.load(Ordering::SeqCst),
        1,
        "one Drive read"
    );

    // spent: the same address again is the one refusal
    let again = get(&server, &address(&tenant, &token)).await;
    assert_eq!(again.status, 404);
    assert!(
        again.headers.iter().all(|(n, _)| n != "location"),
        "a refusal does not redirect either"
    );
    assert_eq!(
        server.archive.reads.load(Ordering::SeqCst),
        1,
        "a refusal never reads Drive"
    );
}

/// Every reason a request is not served is the byte-identical 404 (status, headers that matter, body)
/// and never reaches Drive: malformed, unknown, another workspace's, expired, spent, the run is over,
/// somebody else's file, a deleted request, bytes that are not the declared image, a Drive miss.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn every_refusal_is_one_identical_404_that_never_reads_drive() {
    let server = start().await;
    let mut refusals: Vec<(&str, Seen)> = Vec::new();

    let tenant = seed_tenant(&server).await;
    let token = mint(&server, &tenant, 300).await;
    refusals.push((
        "not a token",
        get(&server, &address(&tenant, "short")).await,
    ));
    refusals.push((
        "traversal",
        get(
            &server,
            &format!("/v1/self-media/{}/..%2F..%2Fx", tenant.ws),
        )
        .await,
    ));
    refusals.push((
        "unknown token",
        get(&server, &address(&tenant, &"N".repeat(43))).await,
    ));
    refusals.push((
        "not a workspace",
        get(&server, &format!("/v1/self-media/not-a-uuid/{token}")).await,
    ));
    refusals.push((
        "uppercase workspace",
        get(
            &server,
            &format!(
                "/v1/self-media/{}/{token}",
                tenant.ws.to_string().to_uppercase()
            ),
        )
        .await,
    ));
    let other = seed_tenant(&server).await;
    refusals.push((
        "another workspace",
        get(&server, &format!("/v1/self-media/{}/{token}", other.ws)).await,
    ));
    let reads_before_serving = server.archive.reads.load(Ordering::SeqCst);
    assert_eq!(reads_before_serving, 0, "no refusal so far read Drive");

    // spent
    assert_eq!(get(&server, &address(&tenant, &token)).await.status, 200);
    refusals.push(("spent", get(&server, &address(&tenant, &token)).await));
    let reads_after_serving = server.archive.reads.load(Ordering::SeqCst);

    // expired
    let tenant = seed_tenant(&server).await;
    let token = mint(&server, &tenant, 1).await;
    tokio::time::sleep(Duration::from_millis(1300)).await;
    refusals.push(("expired", get(&server, &address(&tenant, &token)).await));

    // the run is over
    let tenant = seed_tenant(&server).await;
    let token = mint(&server, &tenant, 300).await;
    sqlx::query("UPDATE agent_run SET status = 'succeeded'::run_status WHERE id = $1")
        .bind(tenant.run)
        .execute(&server.su)
        .await
        .unwrap();
    refusals.push(("run over", get(&server, &address(&tenant, &token)).await));

    // the request message was deleted
    let tenant = seed_tenant(&server).await;
    let token = mint(&server, &tenant, 300).await;
    sqlx::query(
        "UPDATE message SET state = 'deleted'::message_state, deleted_at = now() WHERE id = $1",
    )
    .bind(tenant.trigger)
    .execute(&server.su)
    .await
    .unwrap();
    refusals.push((
        "deleted request",
        get(&server, &address(&tenant, &token)).await,
    ));

    // somebody else's file (a row naming alice as requester for bob's attachment)
    let tenant = seed_tenant(&server).await;
    let bobs_message = seed_message(&server.su, tenant.ws, tenant.channel, tenant.bob).await;
    let (bobs_file, _) = seed_attachment(
        &server,
        tenant.ws,
        tenant.channel,
        tenant.bob,
        bobs_message,
        png_bytes(512),
    )
    .await;
    let forged = "F".repeat(43);
    sqlx::query(
        "INSERT INTO self_media_token (workspace_id, token_hash, run_id, agent_member_id, \
         requester_member_id, channel_id, attachment_id, expires_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7, clock_timestamp() + interval '5 minutes')",
    )
    .bind(tenant.ws)
    .bind(token_hash(&forged).to_vec())
    .bind(tenant.run)
    .bind(tenant.agent)
    .bind(tenant.alice)
    .bind(tenant.channel)
    .bind(bobs_file)
    .execute(&server.su)
    .await
    .unwrap();
    refusals.push((
        "somebody else's file",
        get(&server, &address(&tenant, &forged)).await,
    ));

    // bytes that are not the declared image (an HTML page stored under image/png)
    let tenant = seed_tenant(&server).await;
    server
        .archive
        .files
        .lock()
        .unwrap()
        .insert(tenant.drive_file.clone(), vec![b'<'; 4096]);
    let token = mint(&server, &tenant, 300).await;
    let reads_before_html = server.archive.reads.load(Ordering::SeqCst);
    refusals.push((
        "not the declared image",
        get(&server, &address(&tenant, &token)).await,
    ));
    assert_eq!(
        server.archive.reads.load(Ordering::SeqCst),
        reads_before_html + 1,
        "this one does read Drive: the bytes are what is wrong"
    );

    // Drive no longer has the file
    let tenant = seed_tenant(&server).await;
    server
        .archive
        .files
        .lock()
        .unwrap()
        .remove(&tenant.drive_file);
    let token = mint(&server, &tenant, 300).await;
    refusals.push((
        "a Drive miss",
        get(&server, &address(&tenant, &token)).await,
    ));

    let (label0, first) = &refusals[0];
    for (label, seen) in &refusals {
        assert_eq!(seen.status, 404, "{label}");
        assert_eq!(
            seen.body, first.body,
            "{label} vs {label0}: the body is the same"
        );
        let fingerprint = |s: &Seen| {
            s.headers
                .iter()
                .filter(|(n, _)| n != "date")
                .cloned()
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(
            fingerprint(seen),
            fingerprint(first),
            "{label}: the headers are the same"
        );
    }
    assert!(refusals.len() >= 12);
    // every refusal that needed no bytes left Drive alone: the only reads are the one served picture,
    // the HTML case and the missing-file case
    assert_eq!(reads_after_serving, 1);
    assert_eq!(
        server.archive.reads.load(Ordering::SeqCst),
        1 + 1 + 1,
        "reads: the served picture, the HTML bytes, the Drive miss — and nothing else"
    );
}

/// A token presented under another workspace's path neither serves nor is spent by the attempt.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_wrong_workspace_in_the_path_neither_serves_nor_spends_the_token() {
    let server = start().await;
    let one = seed_tenant(&server).await;
    let two = seed_tenant(&server).await;
    let token = mint(&server, &one, 300).await;
    let wrong = get(&server, &format!("/v1/self-media/{}/{token}", two.ws)).await;
    assert_eq!(wrong.status, 404);
    let right = get(&server, &address(&one, &token)).await;
    assert_eq!(
        right.status, 200,
        "the wrong-workspace attempt spent nothing"
    );
}

/// Only GET reaches the handler: HEAD would spend the token with the body dropped, POST has no business here.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn only_get_reaches_the_handler_and_other_methods_spend_nothing() {
    let server = start().await;
    let tenant = seed_tenant(&server).await;
    let token = mint(&server, &tenant, 300).await;
    let url = format!("{}{}", server.base, address(&tenant, &token));
    let head = client().head(&url).send().await.unwrap();
    assert_eq!(head.status().as_u16(), 405, "HEAD is not routed");
    let post = client().post(&url).send().await.unwrap();
    assert_eq!(post.status().as_u16(), 405, "POST is not routed");
    let spent: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM self_media_token WHERE used_at IS NOT NULL AND workspace_id = $1",
    )
    .bind(tenant.ws)
    .fetch_one(&server.su)
    .await
    .unwrap();
    assert_eq!(spent, 0, "neither method spent the token");
    assert_eq!(get(&server, &address(&tenant, &token)).await.status, 200);
}

/// Refusals spend the caller's address budget and only they do: after the budget (30, the claim
/// budget) is gone the address is turned away with 429 + Retry-After before the handler runs, and
/// a different address is unaffected.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn refusals_spend_the_per_address_budget_and_serving_does_not() {
    let server = start().await;
    let tenant = seed_tenant(&server).await;
    let guess = |ip: &'static str, token: String| {
        let url = format!("{}/v1/self-media/{}/{token}", server.base, tenant.ws);
        async move {
            client()
                .get(url)
                .header("x-forwarded-for", ip)
                .send()
                .await
                .unwrap()
        }
    };
    // a served picture spends nothing: 40 of them from one address never reach 429
    for _ in 0..3 {
        let token = mint(&server, &tenant, 300).await;
        let served = guess("198.51.100.20", token).await;
        assert_eq!(served.status().as_u16(), 200);
    }
    let mut statuses = Vec::new();
    for _ in 0..34 {
        statuses.push(
            guess("198.51.100.21", "N".repeat(43))
                .await
                .status()
                .as_u16(),
        );
    }
    let not_found = statuses.iter().filter(|s| **s == 404).count();
    assert!(
        (30..=31).contains(&not_found),
        "about the budget's worth of 404s, then 429: {statuses:?}"
    );
    assert!(
        statuses.contains(&429),
        "the address is turned away: {statuses:?}"
    );
    let retry = guess("198.51.100.21", "N".repeat(43)).await;
    assert_eq!(retry.status().as_u16(), 429);
    assert!(retry.headers().contains_key("retry-after"));
    // another address is not affected
    let token = mint(&server, &tenant, 300).await;
    assert_eq!(guess("198.51.100.22", token).await.status().as_u16(), 200);
}
