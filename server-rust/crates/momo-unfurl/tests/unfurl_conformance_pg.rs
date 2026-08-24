//! PG conformance for ADR-0170 unfurl worker (mock HTTP fixture).
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-unfurl --test unfurl_conformance_pg -- --ignored --nocapture
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

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::Router;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::PgPoolOptions;
use momo_db::sqlx::Row;
use momo_db::{with_tenant_tx, PgPool};
use momo_unfurl::{FetchError, FetchKind, Fetched, UnfurlConfig, UnfurlHttp, UnfurlWorker};
use uuid::Uuid;

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect")
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

fn ensure_schema() {
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
        .expect("bootstrap_roles");
    assert!(status.success());
    *ready = true;
}

struct Tenant {
    workspace: Uuid,
    member: Uuid,
    channel: Uuid,
}

async fn skip_leftover_jobs(su: &PgPool) {
    sqlx::query(
        "UPDATE unfurl_job SET status = 'skipped' \
          WHERE status IN ('pending', 'processing')",
    )
    .execute(su)
    .await
    .expect("clear leftover jobs");
}

async fn seed(su: &PgPool) -> Tenant {
    let workspace = Uuid::new_v4();
    let member = Uuid::new_v4();
    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("unfurl-{workspace}"))
        .execute(su)
        .await
        .expect("workspace");
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
        "INSERT INTO channel (id, workspace_id, kind, name, created_by) \
         VALUES ($1, $2, 'public', 'general', $3)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seq");
    Tenant {
        workspace,
        member,
        channel,
    }
}

async fn insert_message(su: &PgPool, tenant: &Tenant, body: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1")
        .bind(tenant.channel)
        .execute(su)
        .await
        .expect("bump seq");
    let seq: i64 = sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
        .bind(tenant.channel)
        .fetch_one(su)
        .await
        .expect("seq");
    sqlx::query(
        "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
         author_member_id, type, body) \
         VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', $6)",
    )
    .bind(id)
    .bind(tenant.workspace)
    .bind(tenant.channel)
    .bind(seq)
    .bind(tenant.member)
    .bind(body)
    .execute(su)
    .await
    .expect("message");
    id
}

struct CountingHttp {
    hits: Arc<AtomicUsize>,
    html: String,
}

#[async_trait::async_trait]
impl UnfurlHttp for CountingHttp {
    async fn fetch(&self, url: &str, kind: FetchKind) -> Result<Fetched, FetchError> {
        self.hits.fetch_add(1, Ordering::SeqCst);
        match kind {
            FetchKind::Html => Ok(Fetched {
                final_url: url.to_string(),
                content_type: "text/html".into(),
                body: self.html.as_bytes().to_vec(),
            }),
            FetchKind::Image => Ok(Fetched {
                final_url: url.to_string(),
                content_type: "image/png".into(),
                body: vec![0x89, 0x50, 0x4e, 0x47],
            }),
        }
    }
}

fn worker(pool: PgPool, http: CountingHttp, enabled: bool) -> UnfurlWorker<CountingHttp> {
    UnfurlWorker::new(
        pool,
        Arc::new(http),
        UnfurlConfig::for_tests(database_url(), enabled),
    )
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB"]
async fn message_to_record_to_outbox_roundtrip() {
    let _guard = test_lock().await;
    ensure_schema();
    let su = superuser_pool().await;
    skip_leftover_jobs(&su).await;
    let tenant = seed(&su).await;
    let hits = Arc::new(AtomicUsize::new(0));
    let html = r#"<meta property="og:title" content="Hello card">
                  <meta property="og:description" content="from fixture">
                  <meta property="og:image" content="https://cdn.example/a.png">"#;
    let http = CountingHttp {
        hits: hits.clone(),
        html: html.into(),
    };
    let worker = worker(su.clone(), http, true);
    let message_id =
        insert_message(&su, &tenant, "see https://public.example/article please").await;

    let jobs: i64 = sqlx::query_scalar("SELECT count(*) FROM unfurl_job WHERE message_id = $1")
        .bind(message_id)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(jobs, 1, "INSERT trigger queued a job");

    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.claimed, 1);
    assert_eq!(stats.fetched, 1);
    assert_eq!(hits.load(Ordering::SeqCst), 1);

    let title: String =
        sqlx::query_scalar("SELECT title FROM message_unfurl WHERE message_id = $1")
            .bind(message_id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(title, "Hello card");

    let seq_before: i64 =
        sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(tenant.channel)
            .fetch_one(&su)
            .await
            .unwrap();

    let row = sqlx::query(
        "SELECT kind::text, payload->>'channel' AS channel, \
                payload->'data'->>'type' AS event, \
                payload->'data'->>'seq' AS seq \
           FROM outbox \
          WHERE workspace_id = $1 \
            AND payload->'data'->>'type' = 'message.unfurl' \
          ORDER BY id DESC LIMIT 1",
    )
    .bind(tenant.workspace)
    .fetch_one(&su)
    .await
    .expect("broadcast");
    assert_eq!(row.get::<String, _>("kind"), "broadcast");
    assert_eq!(row.get::<String, _>("event"), "message.unfurl");
    let seq_after: i64 =
        sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(tenant.channel)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(seq_before, seq_after, "unfurl must not consume message.seq");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB"]
async fn workspace_off_fetches_zero_times() {
    let _guard = test_lock().await;
    ensure_schema();
    let su = superuser_pool().await;
    skip_leftover_jobs(&su).await;
    let tenant = seed(&su).await;
    sqlx::query("INSERT INTO workspace_unfurl_setting (workspace_id, enabled) VALUES ($1, false)")
        .bind(tenant.workspace)
        .execute(&su)
        .await
        .unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let http = CountingHttp {
        hits: hits.clone(),
        html: "<html></html>".into(),
    };
    let worker = worker(su.clone(), http, true);
    insert_message(&su, &tenant, "https://public.example/off").await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.claimed, 1);
    assert_eq!(stats.skipped, 1);
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB"]
async fn instance_off_claims_nothing() {
    let _guard = test_lock().await;
    ensure_schema();
    let su = superuser_pool().await;
    skip_leftover_jobs(&su).await;
    let tenant = seed(&su).await;
    let hits = Arc::new(AtomicUsize::new(0));
    let http = CountingHttp {
        hits: hits.clone(),
        html: "<html></html>".into(),
    };
    let worker = worker(su.clone(), http, false);
    insert_message(&su, &tenant, "https://public.example/instance-off").await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.claimed, 0);
    assert_eq!(hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB"]
async fn ttl_cache_reuses_a_fetch() {
    let _guard = test_lock().await;
    ensure_schema();
    let su = superuser_pool().await;
    skip_leftover_jobs(&su).await;
    let tenant = seed(&su).await;
    let hits = Arc::new(AtomicUsize::new(0));
    let html = r#"<meta property="og:title" content="Cached">"#;
    let http = CountingHttp {
        hits: hits.clone(),
        html: html.into(),
    };
    let worker = worker(su.clone(), http, true);
    insert_message(&su, &tenant, "https://public.example/same").await;
    worker.drain_once().await.expect("first");
    insert_message(&su, &tenant, "again https://public.example/same").await;
    let stats = worker.drain_once().await.expect("second");
    assert_eq!(stats.cached, 1);
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "second message reused the 24h cache"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB"]
async fn tombstone_blocks_regeneration() {
    let _guard = test_lock().await;
    ensure_schema();
    let su = superuser_pool().await;
    skip_leftover_jobs(&su).await;
    let tenant = seed(&su).await;
    let message_id = insert_message(&su, &tenant, "https://public.example/gone").await;
    with_tenant_tx(&su, tenant.workspace, |conn| {
        Box::pin(async move {
            let _ = momo_unfurl::remove_unfurls_in_tx(
                conn,
                tenant.workspace,
                message_id,
                tenant.member,
            )
            .await?;
            Ok::<(), momo_db::DbError>(())
        })
    })
    .await
    .expect("remove");

    let hits = Arc::new(AtomicUsize::new(0));
    let http = CountingHttp {
        hits: hits.clone(),
        html: "<html></html>".into(),
    };
    // The original job may already be pending; drain it — tombstone wins.
    let worker = worker(su.clone(), http, true);
    let stats = worker.drain_once().await.expect("drain");
    assert!(stats.skipped >= 1 || stats.claimed == 0 || stats.fetched == 0);
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM message_unfurl WHERE message_id = $1")
            .bind(message_id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(remaining, 0);
}

// ---------------------------------------------------------------------------
// live mock HTTP origin (mock_hermes convention) — SSRF is tested separately
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Origin {
    hits: Arc<AtomicUsize>,
    html: Arc<String>,
}

async fn serve_page(
    State(origin): State<Origin>,
) -> (StatusCode, [(&'static str, &'static str); 1], String) {
    origin.hits.fetch_add(1, Ordering::SeqCst);
    (
        StatusCode::OK,
        [("content-type", "text/html; charset=utf-8")],
        origin.html.as_ref().clone(),
    )
}

struct PlainGet {
    client: reqwest::Client,
}

#[async_trait::async_trait]
impl UnfurlHttp for PlainGet {
    async fn fetch(&self, url: &str, _kind: FetchKind) -> Result<Fetched, FetchError> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| FetchError::Failed(e.to_string()))?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(FetchError::Failed(format!("HTTP {status}")));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("text/html")
            .to_string();
        let body = response
            .bytes()
            .await
            .map_err(|e| FetchError::Failed(e.to_string()))?
            .to_vec();
        Ok(Fetched {
            final_url: url.to_string(),
            content_type,
            body,
        })
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB"]
async fn mock_http_origin_roundtrip() {
    let _guard = test_lock().await;
    ensure_schema();
    let su = superuser_pool().await;
    skip_leftover_jobs(&su).await;
    let tenant = seed(&su).await;
    let hits = Arc::new(AtomicUsize::new(0));
    let origin = Origin {
        hits: hits.clone(),
        html: Arc::new(r#"<meta property="og:title" content="Live fixture">"#.into()),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr: SocketAddr = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/article", get(serve_page))
        .with_state(origin);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let page = format!("http://127.0.0.1:{}/article", addr.port());
    insert_message(&su, &tenant, &format!("read {page}")).await;

    let worker = UnfurlWorker::new(
        su.clone(),
        Arc::new(PlainGet {
            client: reqwest::Client::new(),
        }),
        UnfurlConfig::for_tests(database_url(), true),
    );
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.claimed, 1);
    assert_eq!(stats.fetched, 1);
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    let title: String =
        sqlx::query_scalar("SELECT title FROM message_unfurl ORDER BY created_at DESC LIMIT 1")
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(title, "Live fixture");
}
