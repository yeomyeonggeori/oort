//! DB-backed conformance for **#1788**: local-archive capability URLs
//! advertised from the request origin (ADR-0169 증보 1 / ADR-0167 reuse).
//!
//! `#[ignore]` — needs a `pgvector/pgvector:pg18` superuser DB plus the
//! runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test drive_local_same_origin_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract matches `attachment_conformance_pg.rs`: `DATABASE_URL` is a
//! **superuser**; the **server** runs as `momo_app`. The archive is the real
//! local-volume backend. Proofs bind `0.0.0.0` and the client dials a
//! **non-loopback** address — Host is not injected; reqwest sends the LAN
//! authority it actually connected to.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `d1788_1_legacy_localhost_stays_verbatim_from_a_lan_client` | rewrite Fixed URLs from Host |
//! | `d1788_2_same_origin_lan_put_uses_the_connected_origin` | keep baking `http://127.0.0.1` |
//! | `d1788_3_absolute_url_ignores_the_connected_host` | let SameOrigin rewrite a Fixed URL |
//! | `d1788_4_same_origin_xfp_https_is_https` | ignore `X-Forwarded-Proto` |

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_drive::LocalDriveArchive;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::{build_app, AppState, DriveLocalBase};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "drive-1788-same-origin-secret";
const TEST_PASSWORD: &str = "drive-1788-same-origin-password";

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

/// Outbound IPv4 this machine would use — a real LAN (or VPN) address, not
/// 127.0.0.1. UDP connect does not send a packet; it only picks a source.
fn lan_ipv4() -> Ipv4Addr {
    let socket = UdpSocket::bind("0.0.0.0:0").expect("bind udp for lan discovery");
    socket
        .connect("1.1.1.1:80")
        .expect("udp connect to pick an outbound source");
    match socket.local_addr().expect("udp local addr").ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => ip,
        other => panic!(
            "need a non-loopback IPv4 to prove #1788 (got {other}); \
             connect this host to a LAN or VPN and rerun"
        ),
    }
}

struct DirGuard(PathBuf);
impl Drop for DirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_archive_dir() -> (PathBuf, DirGuard) {
    let dir = std::env::temp_dir().join(format!(
        "oort-drive-1788-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("temp archive");
    (dir.clone(), DirGuard(dir))
}

struct LiveServer {
    lan_origin: String,
    port: u16,
    _archive_dir: DirGuard,
}

async fn start_local_server<F>(pool: PgPool, advertise: F) -> LiveServer
where
    F: FnOnce(u16) -> (String, DriveLocalBase),
{
    let (dir, guard) = temp_archive_dir();
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0")
        .await
        .expect("bind momo-server on all interfaces");
    let address: SocketAddr = listener.local_addr().expect("server address");
    let port = address.port();
    let (archive_base, advert) = advertise(port);
    let archive = LocalDriveArchive::open(dir.to_str(), &archive_base).expect("open local archive");
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_drive(Arc::new(archive))
    .with_drive_local_base(advert);
    let app = build_app(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let lan = lan_ipv4();
    LiveServer {
        lan_origin: format!("http://{lan}:{port}"),
        port,
        _archive_dir: guard,
    }
}

struct Person {
    member: Uuid,
    email: String,
}

struct Fixture {
    workspace: Uuid,
    channel: Uuid,
    alice: Person,
}

async fn seed_person(su: &PgPool, workspace: Uuid) -> Person {
    let member = Uuid::new_v4();
    let email = format!("{member}@drive1788.test");
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
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("drive-1788-{}", Uuid::new_v4()),
            topic: None,
            created_by: alice.member,
        },
    )
    .await
    .expect("create channel");
    Fixture {
        workspace,
        channel: channel.id,
        alice,
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
    assert_eq!(
        response.status(),
        200,
        "seeded credentials log in via {base}"
    );
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string()
}

fn uploads_url(base: &str, workspace: Uuid, channel: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/attachments/uploads")
}

/// ① The pre-#1788 default: a Fixed localhost URL is still handed out when
/// the client actually connected on a LAN address. That is the defect,
/// kept as the verbatim regression of the old env.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + bootstrap_roles.sql"]
async fn d1788_1_legacy_localhost_stays_verbatim_from_a_lan_client() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let server = start_local_server(app_pool, |port| {
        let localhost_base = format!("http://localhost:{port}");
        (
            localhost_base.clone(),
            DriveLocalBase::Fixed(localhost_base),
        )
    })
    .await;
    let http = reqwest::Client::new();
    let token = login(&http, &server.lan_origin, fixture.workspace, &fixture.alice).await;
    let created = http
        .post(uploads_url(
            &server.lan_origin,
            fixture.workspace,
            fixture.channel,
        ))
        .bearer_auth(&token)
        .json(&json!({"name": "red.txt", "mime": "text/plain", "size": 3}))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201, "create from LAN");
    let body: Value = created.json().await.expect("body");
    let upload_url = body["uploadUrl"].as_str().expect("uploadUrl");
    assert!(
        upload_url.starts_with(&format!(
            "http://localhost:{}/__momo_stub/drive/uploads/",
            server.port
        )),
        "① RED: LAN client still received a localhost capability URL: {upload_url}"
    );
    println!(
        "RED ① LAN client {lan} received {upload_url}",
        lan = server.lan_origin
    );
}

/// ② same-origin + a real LAN dial: the capability URL uses that origin, and
/// PUT to it succeeds.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + bootstrap_roles.sql"]
async fn d1788_2_same_origin_lan_put_uses_the_connected_origin() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let server = start_local_server(app_pool, |_| {
        ("http://127.0.0.1:1".to_string(), DriveLocalBase::SameOrigin)
    })
    .await;
    let http = reqwest::Client::new();
    let token = login(&http, &server.lan_origin, fixture.workspace, &fixture.alice).await;
    let bytes = b"lan";
    let created = http
        .post(uploads_url(
            &server.lan_origin,
            fixture.workspace,
            fixture.channel,
        ))
        .bearer_auth(&token)
        .json(&json!({"name": "lan.txt", "mime": "text/plain", "size": bytes.len()}))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201);
    let body: Value = created.json().await.expect("body");
    let upload_url = body["uploadUrl"].as_str().expect("uploadUrl").to_string();
    let id = body["id"].as_str().expect("id").to_string();
    assert!(
        upload_url.starts_with(&format!("{}/__momo_stub/drive/uploads/", server.lan_origin)),
        "② GREEN: expected LAN origin {}, got {upload_url}",
        server.lan_origin
    );
    assert!(
        !upload_url.contains("127.0.0.1") && !upload_url.contains("localhost"),
        "② must not leak loopback: {upload_url}"
    );

    let uploaded = http
        .put(&upload_url)
        .header(reqwest::header::CONTENT_TYPE, "text/plain")
        .body(bytes.to_vec())
        .send()
        .await
        .expect("PUT via the advertised LAN URL");
    assert_eq!(uploaded.status(), 200, "② PUT to {upload_url} must succeed");

    let completed = http
        .post(format!(
            "{}/v1/workspaces/{}/channels/{}/attachments/{id}/complete",
            server.lan_origin, fixture.workspace, fixture.channel
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("complete");
    assert_eq!(completed.status(), 200, "complete after LAN PUT");
    println!(
        "GREEN ② LAN origin {} advertised {upload_url} and PUT 200",
        server.lan_origin
    );
}

/// ③ An operator-pinned absolute URL is never rewritten from Host.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + bootstrap_roles.sql"]
async fn d1788_3_absolute_url_ignores_the_connected_host() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let server = start_local_server(app_pool, |_| {
        let pinned = "https://files.oor7.com".to_string();
        (pinned.clone(), DriveLocalBase::Fixed(pinned))
    })
    .await;
    let http = reqwest::Client::new();
    let token = login(&http, &server.lan_origin, fixture.workspace, &fixture.alice).await;
    let created = http
        .post(uploads_url(
            &server.lan_origin,
            fixture.workspace,
            fixture.channel,
        ))
        .bearer_auth(&token)
        .json(&json!({"name": "pin.txt", "mime": "text/plain", "size": 3}))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201);
    let body: Value = created.json().await.expect("body");
    let upload_url = body["uploadUrl"].as_str().expect("uploadUrl");
    assert!(
        upload_url.starts_with("https://files.oor7.com/__momo_stub/drive/uploads/"),
        "③ absolute URL must stay verbatim: {upload_url}"
    );
    println!("GREEN ③ verbatim absolute {upload_url}");
}

/// ④ same-origin + trusted-proxy `X-Forwarded-Proto: https` derives https
/// (Caddy's normalized hop — the 0167 rule, not the raw connection scheme).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + bootstrap_roles.sql"]
async fn d1788_4_same_origin_xfp_https_is_https() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let server = start_local_server(app_pool, |_| {
        ("http://127.0.0.1:1".to_string(), DriveLocalBase::SameOrigin)
    })
    .await;
    let http = reqwest::Client::new();
    let token = login(&http, &server.lan_origin, fixture.workspace, &fixture.alice).await;
    let host = server
        .lan_origin
        .strip_prefix("http://")
        .expect("lan origin is http");
    let created = http
        .post(uploads_url(
            &server.lan_origin,
            fixture.workspace,
            fixture.channel,
        ))
        .bearer_auth(&token)
        .header("X-Forwarded-Proto", "https")
        .header("Host", host)
        .json(&json!({"name": "tls.txt", "mime": "text/plain", "size": 3}))
        .send()
        .await
        .expect("create");
    assert_eq!(created.status(), 201);
    let body: Value = created.json().await.expect("body");
    let upload_url = body["uploadUrl"].as_str().expect("uploadUrl");
    assert!(
        upload_url.starts_with(&format!("https://{host}/__momo_stub/drive/uploads/")),
        "④ XFP https must derive https: {upload_url}"
    );
    println!("GREEN ④ XFP https → {upload_url}");
}
