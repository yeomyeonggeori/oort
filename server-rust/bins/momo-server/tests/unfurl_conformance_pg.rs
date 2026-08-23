//! REST + worker roundtrip for ADR-0170 (settings, remove, list).
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test unfurl_conformance_pg -- --ignored --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::{build_app, AppState};
use momo_unfurl::{FetchError, FetchKind, Fetched, UnfurlConfig, UnfurlHttp, UnfurlWorker};
use serde_json::{json, Value};
use uuid::Uuid;

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

const TEST_JWT_SECRET: &str = "unfurl-conformance-signing-secret";
const TEST_PASSWORD: &str = "unfurl-test-password";

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect su")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("dsn");
    let options = options.username("momo_app").password(&momo_app_password());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .expect("connect app")
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
    panic!("psql not found");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None).expect("migrations");
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
        .expect("bootstrap");
    assert!(status.success());
    *ready = true;
}

struct Fixture {
    workspace: Uuid,
    #[allow(dead_code)]
    member: Uuid,
    email: String,
    channel: Uuid,
}

async fn seed(su: &PgPool, app: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    let member = Uuid::new_v4();
    let email = format!("{member}@unfurl.test");
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("ws");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(member)
    .bind(workspace)
    .bind(member.to_string())
    .execute(su)
    .await
    .expect("member");
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
    .expect("human");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("owner");
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("unfurl-{}", Uuid::new_v4()),
            topic: None,
            created_by: member,
        },
    )
    .await
    .expect("channel");
    Fixture {
        workspace,
        member,
        email,
        channel: channel.id,
    }
}

struct CountingHttp {
    hits: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl UnfurlHttp for CountingHttp {
    async fn fetch(&self, url: &str, _kind: FetchKind) -> Result<Fetched, FetchError> {
        self.hits.fetch_add(1, Ordering::SeqCst);
        Ok(Fetched {
            final_url: url.to_string(),
            content_type: "text/html".into(),
            body: br#"<meta property="og:title" content="From REST">"#.to_vec(),
        })
    }
}

async fn start_server(app_pool: PgPool, http: Arc<dyn UnfurlHttp>) -> String {
    let state = AppState::new(
        app_pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket",
    )
    .with_unfurl_http(http);
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

async fn login(http: &reqwest::Client, base: &str, fixture: &Fixture) -> String {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": fixture.email,
            "password": TEST_PASSWORD,
            "workspace": fixture.workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    body["accessToken"].as_str().unwrap().to_string()
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn settings_off_then_remove_rest() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    sqlx::query(
        "UPDATE unfurl_job SET status = 'skipped' WHERE status IN ('pending', 'processing')",
    )
    .execute(&su)
    .await
    .ok();
    let hits = Arc::new(AtomicUsize::new(0));
    let transport = Arc::new(CountingHttp { hits: hits.clone() });
    let base = start_server(app_pool.clone(), transport.clone()).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;

    let settings_url = format!("{base}/v1/workspaces/{}/unfurl-settings", fixture.workspace);
    let got = http
        .get(&settings_url)
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(got.status(), 200);
    let body: Value = got.json().await.unwrap();
    assert_eq!(body["enabled"], json!(true), "missing row means on");

    let put = http
        .put(&settings_url)
        .bearer_auth(&token)
        .json(&json!({"enabled": false}))
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 200);
    let body: Value = put.json().await.unwrap();
    assert_eq!(body["enabled"], json!(false));

    let messages_url = format!(
        "{base}/v1/workspaces/{}/channels/{}/messages",
        fixture.workspace, fixture.channel
    );
    let sent = http
        .post(&messages_url)
        .bearer_auth(&token)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "type": "text",
            "body": "https://public.example/rest"
        }))
        .send()
        .await
        .unwrap();
    let sent_status = sent.status();
    let sent: Value = sent.json().await.unwrap();
    assert_eq!(sent_status, 201, "send off: {sent}");
    let message_id = sent["id"].as_str().unwrap().to_string();

    let worker = UnfurlWorker::new(
        su.clone(),
        transport,
        UnfurlConfig::for_tests(database_url(), true),
    );
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.claimed, 1);
    assert_eq!(stats.skipped, 1);
    assert_eq!(hits.load(Ordering::SeqCst), 0, "workspace off => fetch 0");

    // Turn back on and send another message so there is a card to delete.
    let put = http
        .put(&settings_url)
        .bearer_auth(&token)
        .json(&json!({"enabled": true}))
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 200);
    let sent = http
        .post(&messages_url)
        .bearer_auth(&token)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "type": "text",
            "body": "https://public.example/keep"
        }))
        .send()
        .await
        .unwrap();
    let sent_status = sent.status();
    let sent: Value = sent.json().await.unwrap();
    assert_eq!(sent_status, 201, "send on: {sent}");
    let live_id = sent["id"].as_str().unwrap().to_string();
    let stats = worker.drain_once().await.expect("drain on");
    assert_eq!(stats.fetched, 1);
    assert!(hits.load(Ordering::SeqCst) >= 1);

    let list = http
        .get(format!(
            "{base}/v1/workspaces/{}/messages/{live_id}/unfurls",
            fixture.workspace
        ))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(list.status(), 200);
    let list: Value = list.json().await.unwrap();
    assert_eq!(list["unfurls"][0]["title"], json!("From REST"));

    let deleted = http
        .delete(format!(
            "{base}/v1/workspaces/{}/messages/{live_id}/unfurls",
            fixture.workspace
        ))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 200);
    let deleted: Value = deleted.json().await.unwrap();
    assert_eq!(deleted["removed"], json!(true));

    let list = http
        .get(format!(
            "{base}/v1/workspaces/{}/messages/{live_id}/unfurls",
            fixture.workspace
        ))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    let list: Value = list.json().await.unwrap();
    assert_eq!(list["unfurls"].as_array().unwrap().len(), 0);

    // The first off-message must not have grown a card either.
    let list = http
        .get(format!(
            "{base}/v1/workspaces/{}/messages/{message_id}/unfurls",
            fixture.workspace
        ))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    let list: Value = list.json().await.unwrap();
    assert_eq!(list["unfurls"].as_array().unwrap().len(), 0);
}
