//! #4820 C2a — `GET /v1/self-media/{ws}/{token}` over real HTTP against a real PG18.
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26821/postgres \
//!   cargo test -p momo-server --test self_media_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! The server runs as `momo_app` (`rolsuper=false`, `rolbypassrls=false`); the fixture is seeded as
//! the superuser; tokens are minted by the real `momo_messaging::mint_with_ttl_in_tx` **as
//! `momo_worker`**, the role the agent-worker mints with (`momo_app` holds no INSERT on the token
//! table: `self-media-token-lockdown`). The Drive archive is an in-process map that (a) answers a
//! deliberately leaky mime string so a response that passed it through would show, (b) counts content
//! reads so a refusal that reached Drive would show, and (c) can be told to stop holding itself to the
//! ceiling the route hands it, so the route's own length check is what a test measures.

use std::collections::{BTreeSet, HashMap};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
use momo_server::config::RateLimitConfig;
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

/// The agent-worker's own role (BYPASSRLS): the only runtime role that may INSERT a token.
async fn momo_worker_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let password =
        std::env::var("MOMO_WORKER_PASSWORD").unwrap_or_else(|_| "momo_worker_dev_pw".to_string());
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options.username("momo_worker").password(&password))
        .await
        .expect("momo_worker pool")
}

/// Holds the bytes of the files a test registers and counts every content read.
#[derive(Debug, Default)]
struct MapArchive {
    files: Mutex<HashMap<String, Vec<u8>>>,
    reads: AtomicUsize,
    /// When set, `file_content` hands back whatever bytes the file holds even if they are longer than
    /// the `max_bytes` the caller asked for. A real archive enforces that ceiling (so a longer stream
    /// fails before the route sees it); an archive that does not is what the route's own length check
    /// exists for, and a test of that check needs one.
    uncapped: AtomicBool,
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
        if bytes.len() as i64 > max_bytes && !self.uncapped.load(Ordering::SeqCst) {
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
    /// What the agent-worker runs as. It mints; the api (`momo_app`, behind the router) only redeems.
    worker: PgPool,
}

async fn start() -> Server {
    start_with(RateLimitConfig::default()).await
}

async fn start_with(rate_limit: RateLimitConfig) -> Server {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let worker = momo_worker_pool().await;
    let archive = Arc::new(MapArchive::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().unwrap();
    let state = AppState::new(
        app,
        "self-media-conformance-signing-secret".to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_drive(archive.clone())
    .with_rate_limit(rate_limit);
    let router = build_app(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Server {
        base: format!("http://{address}"),
        archive,
        su,
        worker,
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
    with_tenant_tx(&server.worker, ws, move |conn| {
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

/// Refusals spend the caller's address budget and only they do: after the budget (30, this route's
/// own default) is gone the address is turned away with 429 + Retry-After before the handler runs, and
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

/// The declared length is a promise the route holds the archive to (security review L2): bytes one
/// short of what the row declares, one over it, or far over it — all of which still start like the
/// declared image — are refused with the one 404. They are never served short and never cut down to
/// fit. The archive here does not hold itself to the ceiling the route passes it, so what refuses
/// the long ones is the route's own check, not the archive's.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_stream_one_byte_short_or_long_is_refused_and_never_truncated() {
    let server = start().await;
    server.archive.uncapped.store(true, Ordering::SeqCst);
    let tenant = seed_tenant(&server).await; // the row declares 4096 bytes
    let declared = 4096usize;

    // the control: the declared length, served whole — so a 404 below is about the length
    let token = mint(&server, &tenant, 300).await;
    let whole = get(&server, &address(&tenant, &token)).await;
    assert_eq!(whole.status, 200, "the declared length is served");
    assert_eq!(whole.body, png_bytes(declared));

    // the one refusal everything below must equal
    let baseline = get(&server, &address(&tenant, &"N".repeat(43))).await;
    assert_eq!(baseline.status, 404);
    let fingerprint = |seen: &Seen| {
        seen.headers
            .iter()
            .filter(|(name, _)| name != "date")
            .cloned()
            .collect::<BTreeSet<_>>()
    };

    for (label, length) in [
        ("one byte short", declared - 1),
        ("one byte long", declared + 1),
        ("far longer", declared * 2),
    ] {
        server
            .archive
            .files
            .lock()
            .unwrap()
            .insert(tenant.drive_file.clone(), png_bytes(length));
        let token = mint(&server, &tenant, 300).await;
        let reads_before = server.archive.reads.load(Ordering::SeqCst);
        let refused = get(&server, &address(&tenant, &token)).await;
        assert_eq!(
            refused.status,
            404,
            "{label}: a stream that is not the declared length is not served (got {} body bytes)",
            refused.body.len()
        );
        assert_eq!(refused.body, baseline.body, "{label}: the same body");
        assert_eq!(
            fingerprint(&refused),
            fingerprint(&baseline),
            "{label}: the same headers"
        );
        assert_eq!(
            server.archive.reads.load(Ordering::SeqCst),
            reads_before + 1,
            "{label}: the archive was read — it is the length that is wrong"
        );
        let spent: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM self_media_token WHERE token_hash = $1 AND used_at IS NOT NULL",
        )
        .bind(token_hash(&token).to_vec())
        .fetch_one(&server.su)
        .await
        .unwrap();
        assert_eq!(spent, 1, "{label}: the token was spent either way");
    }
}

/// One workspace's refusals never block another workspace's picture (security review L7). The
/// co-hosted Hermes reaches the api from one address for every workspace and its tool lets any
/// well-shaped address through, so a model that invents addresses under its own workspace used to
/// spend the budget every workspace's real addresses needed. The budget is now this route's own
/// number and is split by the workspace in the path. `claim_per_ip_limit` is set far above the
/// number so a budget that still read the claim one would show.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn one_workspaces_refusals_never_block_another_workspaces_picture() {
    let server = start_with(RateLimitConfig {
        self_media_per_workspace_limit: 4,
        claim_per_ip_limit: 100_000,
        ..RateLimitConfig::default()
    })
    .await;
    let one = seed_tenant(&server).await;
    let two = seed_tenant(&server).await;
    let one_token = mint(&server, &one, 300).await;
    let two_token = mint(&server, &two, 300).await;
    let hermes = "198.51.100.40"; // every workspace's picture request arrives from here
    let from = |ip: &'static str, path: String| {
        let url = format!("{}{path}", server.base);
        async move {
            client()
                .get(url)
                .header("x-forwarded-for", ip)
                .send()
                .await
                .unwrap()
        }
    };

    // workspace one's model invents addresses: four 404s spend its budget, then 429
    let mut statuses = Vec::new();
    for round in 0..7u8 {
        let fake = format!("{}{}", "N".repeat(42), char::from(b'a' + round));
        statuses.push(from(hermes, address(&one, &fake)).await.status().as_u16());
    }
    assert_eq!(
        statuses[..4],
        [404, 404, 404, 404],
        "its own budget, not the claim one: {statuses:?}"
    );
    assert!(
        statuses[4..].iter().all(|status| *status == 429),
        "then turned away: {statuses:?}"
    );

    // the budget is real for workspace one: its own live address is turned away too, before the
    // handler, so the token is not spent either
    let blocked = from(hermes, address(&one, &one_token)).await;
    assert_eq!(blocked.status().as_u16(), 429);
    assert!(blocked.headers().contains_key("retry-after"));
    let unspent: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM self_media_token WHERE token_hash = $1 AND used_at IS NULL",
    )
    .bind(token_hash(&one_token).to_vec())
    .fetch_one(&server.su)
    .await
    .unwrap();
    assert_eq!(unspent, 1, "turned away before the handler: not spent");

    // …and workspace two, from the very same address, is untouched: its real picture is served
    let served = from(hermes, address(&two, &two_token)).await;
    assert_eq!(
        served.status().as_u16(),
        200,
        "another workspace's refusals must not block this workspace's picture"
    );
    assert_eq!(served.bytes().await.unwrap().to_vec(), png_bytes(4096));

    // workspace two still has its whole budget of its own
    let mut two_statuses = Vec::new();
    for round in 0..5u8 {
        let fake = format!("{}{}", "M".repeat(42), char::from(b'a' + round));
        two_statuses.push(from(hermes, address(&two, &fake)).await.status().as_u16());
    }
    assert_eq!(
        two_statuses,
        [404, 404, 404, 404, 429],
        "workspace one's refusals spent none of workspace two's budget"
    );

    // and workspace one's budget belongs to this address: its live address is served from another
    let elsewhere = from("198.51.100.41", address(&one, &one_token)).await;
    assert_eq!(elsewhere.status().as_u16(), 200);
}

/// The split by workspace must not be a way around the limit: the path names the workspace, so a
/// caller who rotates it would never spend the same budget twice and every guess would cost a
/// database transaction again. The address-wide ceiling (ten times the per-workspace number) cuts the
/// rotation off, and a workspace spelled any way but the canonical one shares a single bucket.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn rotating_the_workspace_in_the_path_does_not_walk_around_the_limit() {
    let server = start_with(RateLimitConfig {
        self_media_per_workspace_limit: 2,
        ..RateLimitConfig::default()
    })
    .await;
    let ceiling = 20usize; // ten times the per-workspace number
    let rotate = |ip: &'static str, workspace: String| {
        let url = format!(
            "{}/v1/self-media/{workspace}/{}",
            server.base,
            "N".repeat(43)
        );
        async move {
            client()
                .get(url)
                .header("x-forwarded-for", ip)
                .send()
                .await
                .unwrap()
        }
    };
    let mut statuses = Vec::new();
    for _ in 0..ceiling + 6 {
        statuses.push(
            rotate("198.51.100.50", Uuid::new_v4().to_string())
                .await
                .status()
                .as_u16(),
        );
    }
    let not_found = statuses.iter().filter(|status| **status == 404).count();
    assert!(
        (ceiling..=ceiling + 1).contains(&not_found),
        "a different workspace every time still runs out at the ceiling, not never: {statuses:?}"
    );
    assert!(
        statuses.last() == Some(&429),
        "turned away at the ceiling: {statuses:?}"
    );
    // another address has its own ceiling
    assert_eq!(
        rotate("198.51.100.51", Uuid::new_v4().to_string())
            .await
            .status()
            .as_u16(),
        404
    );

    // spellings the handler would not take as a workspace share one bucket (limit 2), not one each
    let mut other = Vec::new();
    for round in 0..4 {
        other.push(
            rotate("198.51.100.52", format!("not-a-workspace-{round}"))
                .await
                .status()
                .as_u16(),
        );
    }
    assert_eq!(
        other,
        [404, 404, 429, 429],
        "every non-canonical spelling is charged to one bucket"
    );
}
