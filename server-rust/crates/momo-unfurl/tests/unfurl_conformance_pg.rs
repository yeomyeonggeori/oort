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
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::{with_tenant_tx, PgPool};
use momo_unfurl::{
    FetchError, FetchKind, Fetched, UnfurlConfig, UnfurlHttp, UnfurlRecord, UnfurlWorker,
};
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

/// The runtime role the API connects as: not a superuser, no BYPASSRLS.
async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("dsn");
    let password = std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".into());
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options.username("momo_app").password(&password))
        .await
        .expect("connect as momo_app")
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
            FetchKind::Html | FetchKind::Preview => Ok(Fetched {
                final_url: url.to_string(),
                content_type: "text/html".into(),
                body: self.html.as_bytes().to_vec(),
            }),
            // `Source` (an imported picture link) is fetched like an image; so is a site icon.
            FetchKind::Image | FetchKind::Source | FetchKind::Icon => Ok(Fetched {
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

// ---------------------------------------------------------------------------
// ADR-0170 amendment 2026-10-31 (#4881): site name, icon, size, video, three cards
// ---------------------------------------------------------------------------

/// Serves a fixed page per address and remembers every request. Nothing leaves the process.
struct SiteHttp {
    pages: std::collections::HashMap<String, String>,
    fetched: Mutex<Vec<(String, FetchKind)>>,
}

impl SiteHttp {
    fn new(pages: &[(&str, &str)]) -> Arc<SiteHttp> {
        Arc::new(SiteHttp {
            pages: pages
                .iter()
                .map(|(url, html)| (url.to_string(), html.to_string()))
                .collect(),
            fetched: Mutex::new(Vec::new()),
        })
    }

    fn asked(&self) -> Vec<(String, FetchKind)> {
        self.fetched.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl UnfurlHttp for SiteHttp {
    async fn fetch(&self, url: &str, kind: FetchKind) -> Result<Fetched, FetchError> {
        self.fetched.lock().unwrap().push((url.to_string(), kind));
        match (kind, self.pages.get(url)) {
            (FetchKind::Html, Some(html)) => Ok(Fetched {
                final_url: url.to_string(),
                content_type: "text/html; charset=utf-8".into(),
                body: html.as_bytes().to_vec(),
            }),
            _ => Err(FetchError::Failed("not served by this fixture".into())),
        }
    }
}

const FULL_PAGE: &str = r#"<head>
  <meta property="og:title" content="Full card">
  <meta property="og:description" content="Everything is present">
  <meta property="og:site_name" content="Site Alpha">
  <meta property="og:image" content="/img/hero.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:type" content="video.other">
  <link rel="icon" href="/favicon-32.png">
  <link rel="apple-touch-icon" href="/touch.png">
</head>"#;

async fn read_cards(pool: &PgPool, workspace: Uuid, message: Uuid) -> Vec<UnfurlRecord> {
    with_tenant_tx(pool, workspace, move |conn| {
        Box::pin(async move { momo_unfurl::list_unfurls_in_tx(conn, message).await })
    })
    .await
    .expect("list cards")
}

async fn last_broadcast(su: &PgPool, workspace: Uuid) -> serde_json::Value {
    sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND payload->'data'->>'type' = 'message.unfurl' \
          ORDER BY id DESC LIMIT 1",
    )
    .bind(workspace)
    .fetch_one(su)
    .await
    .expect("a message.unfurl broadcast")
}

/// Four links in one message: only the first three become cards, in the order they appear, the
/// fourth page is never even requested, and every new column lands (card row and cache row).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB"]
async fn four_links_make_three_cards_in_order_and_every_new_column_is_stored() {
    let _guard = test_lock().await;
    ensure_schema();
    let su = superuser_pool().await;
    skip_leftover_jobs(&su).await;
    let tenant = seed(&su).await;
    let http = SiteHttp::new(&[
        ("https://a.example/1", FULL_PAGE),
        ("https://b.example/2", r#"<title>Only a title</title>"#),
        (
            "https://c.example/3",
            r#"<meta name="twitter:image" content="https://cdn.example/c.png">"#,
        ),
        ("https://d.example/4", r#"<title>Never fetched</title>"#),
    ]);
    let worker = UnfurlWorker::new(
        su.clone(),
        http.clone(),
        UnfurlConfig::for_tests(database_url(), true),
    );
    let message = insert_message(
        &su,
        &tenant,
        "a https://a.example/1 b https://b.example/2 c https://c.example/3 d https://d.example/4",
    )
    .await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!((stats.claimed, stats.fetched), (1, 1));

    let asked = http.asked();
    assert_eq!(
        asked.len(),
        3,
        "three pages were requested and the fourth never was: {asked:?}"
    );
    assert!(asked.iter().all(|(url, _)| !url.contains("d.example")));

    let cards = read_cards(&su, tenant.workspace, message).await;
    assert_eq!(cards.len(), 3, "the fourth link made no card");
    assert_eq!(
        cards
            .iter()
            .map(|c| c.source_url.as_str())
            .collect::<Vec<_>>(),
        [
            "https://a.example/1",
            "https://b.example/2",
            "https://c.example/3"
        ],
        "cards follow the order of the links"
    );

    let a = &cards[0];
    assert_eq!(a.status, "ok");
    assert_eq!(a.title.as_deref(), Some("Full card"));
    assert_eq!(a.site_name.as_deref(), Some("Site Alpha"));
    assert_eq!(
        a.image_url.as_deref(),
        Some("https://a.example/img/hero.png")
    );
    assert_eq!((a.image_width, a.image_height), (Some(1200), Some(630)));
    assert!(a.is_video);
    assert_eq!(
        a.icon_source_url.as_deref(),
        Some("https://a.example/touch.png"),
        "apple-touch-icon wins, resolved against the page"
    );
    assert_eq!(
        a.icon_proxy_key.as_deref(),
        Some(momo_unfurl::store::image_proxy_key("https://a.example/touch.png").as_str())
    );

    let b = &cards[1];
    assert_eq!(b.title.as_deref(), Some("Only a title"));
    assert_eq!((b.site_name.clone(), b.image_url.clone()), (None, None));
    assert_eq!(
        (b.image_width, b.image_height, b.is_video),
        (None, None, false)
    );
    assert_eq!(
        b.icon_source_url.as_deref(),
        Some("https://b.example/favicon.ico"),
        "no declared icon: the site's /favicon.ico"
    );

    let c = &cards[2];
    assert_eq!(c.title, None);
    assert_eq!(c.image_url.as_deref(), Some("https://cdn.example/c.png"));
    assert_eq!(c.status, "ok", "a picture alone is a card");

    // The 24 h cache row carries the same new columns.
    let cached = sqlx::query(
        "SELECT site_name, icon_source_url, icon_proxy_key, image_width, image_height, is_video \
           FROM unfurl_url_cache WHERE workspace_id = $1 AND url_key = $2",
    )
    .bind(tenant.workspace)
    .bind("https://a.example/1")
    .fetch_one(&su)
    .await
    .expect("cache row");
    assert_eq!(
        cached.get::<Option<String>, _>("site_name").as_deref(),
        Some("Site Alpha")
    );
    assert_eq!(
        cached
            .get::<Option<String>, _>("icon_source_url")
            .as_deref(),
        Some("https://a.example/touch.png")
    );
    assert_eq!(cached.get::<Option<i32>, _>("image_width"), Some(1200));
    assert!(cached.get::<bool, _>("is_video"));

    // The broadcast carries the new keys in snake_case and NEVER a remote address.
    let frame = last_broadcast(&su, tenant.workspace).await;
    let cards_json = frame["data"]["payload"]["unfurls"]
        .as_array()
        .expect("unfurls");
    assert_eq!(cards_json.len(), 3);
    let first = &cards_json[0];
    assert_eq!(first["site_name"], "Site Alpha");
    assert_eq!(first["image_width"], 1200);
    assert_eq!(first["image_height"], 630);
    assert_eq!(first["is_video"], true);
    assert_eq!(
        first["icon_url"],
        format!("/v1/workspaces/{}/unfurls/{}/icon", tenant.workspace, a.id),
        "the icon is a proxy path on this origin"
    );
    assert_eq!(
        first["image_url"],
        format!("/v1/workspaces/{}/unfurls/{}/image", tenant.workspace, a.id)
    );
    assert!(
        cards_json[1].get("is_video").is_none(),
        "is_video is only ever true"
    );
    assert!(cards_json[1].get("image_width").is_none());
    let text = frame.to_string();
    for remote in [
        "a.example/touch.png",
        "a.example/img/hero.png",
        "b.example/favicon.ico",
        "cdn.example/c.png",
    ] {
        assert!(
            !text.contains(remote),
            "the broadcast must not carry the remote address {remote}: {text}"
        );
    }
}

/// A page that gives a card nothing to show (no title, no picture) ends the same quiet way a
/// failed fetch does: a `failed` row with no fields, never an `ok` card of just a domain.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB"]
async fn a_page_with_no_title_and_no_picture_ends_quietly() {
    let _guard = test_lock().await;
    ensure_schema();
    let su = superuser_pool().await;
    skip_leftover_jobs(&su).await;
    let tenant = seed(&su).await;
    let http = SiteHttp::new(&[
        (
            "https://quiet.example/page",
            r#"<meta property="og:site_name" content="Quiet">
               <meta name="description" content="only a description">
               <link rel="icon" href="/i.png">"#,
        ),
        ("https://blank.example/page", "<html></html>"),
    ]);
    let worker = UnfurlWorker::new(
        su.clone(),
        http.clone(),
        UnfurlConfig::for_tests(database_url(), true),
    );
    let message = insert_message(
        &su,
        &tenant,
        "https://quiet.example/page https://blank.example/page",
    )
    .await;
    worker.drain_once().await.expect("drain");
    let cards = read_cards(&su, tenant.workspace, message).await;
    assert_eq!(cards.len(), 2);
    for card in &cards {
        assert_eq!(card.status, "failed", "{}", card.source_url);
        assert_eq!(
            (
                card.title.clone(),
                card.description.clone(),
                card.domain.clone(),
                card.site_name.clone(),
                card.image_url.clone(),
                card.icon_source_url.clone(),
                card.icon_proxy_key.clone(),
                card.image_width,
                card.is_video
            ),
            (None, None, None, None, None, None, None, None, false),
            "{}: a quiet end carries no fields",
            card.source_url
        );
    }
    let frame = last_broadcast(&su, tenant.workspace).await;
    for card in frame["data"]["payload"]["unfurls"].as_array().unwrap() {
        let keys: std::collections::BTreeSet<&str> = card
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            ["id", "message_id", "status", "url"].into_iter().collect(),
            "a quiet card is id, message_id, url, status and nothing else"
        );
    }
}

/// The 24 h cache hands every new field to the next message that links the page.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB"]
async fn the_cache_carries_the_new_fields_to_the_next_message() {
    let _guard = test_lock().await;
    ensure_schema();
    let su = superuser_pool().await;
    skip_leftover_jobs(&su).await;
    let tenant = seed(&su).await;
    let http = SiteHttp::new(&[("https://a.example/1", FULL_PAGE)]);
    let worker = UnfurlWorker::new(
        su.clone(),
        http.clone(),
        UnfurlConfig::for_tests(database_url(), true),
    );
    let first = insert_message(&su, &tenant, "https://a.example/1").await;
    worker.drain_once().await.expect("first");
    let second = insert_message(&su, &tenant, "again https://a.example/1").await;
    let stats = worker.drain_once().await.expect("second");
    assert_eq!(stats.cached, 1);
    assert_eq!(http.asked().len(), 1, "the second message did not fetch");
    let one = &read_cards(&su, tenant.workspace, first).await[0];
    let two = &read_cards(&su, tenant.workspace, second).await[0];
    assert_ne!(one.id, two.id);
    assert_eq!(
        (
            &one.site_name,
            &one.icon_source_url,
            &one.icon_proxy_key,
            one.image_width,
            one.image_height,
            one.is_video
        ),
        (
            &two.site_name,
            &two.icon_source_url,
            &two.icon_proxy_key,
            two.image_width,
            two.image_height,
            two.is_video
        ),
        "the cached card is the fetched card"
    );
    assert_eq!(two.site_name.as_deref(), Some("Site Alpha"));
    assert!(two.is_video);
}

/// Real PG, the runtime role (not a superuser, no BYPASSRLS), two tenants: the new columns are
/// written and read inside the tenant's own transaction and are invisible to the other tenant.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn two_tenants_each_read_only_their_own_site_meta_as_the_runtime_role() {
    let _guard = test_lock().await;
    ensure_schema();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let flags =
        sqlx::query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'momo_app'")
            .fetch_one(&su)
            .await
            .expect("momo_app exists");
    assert!(
        !flags.get::<bool, _>("rolsuper"),
        "momo_app must not be a superuser"
    );
    assert!(
        !flags.get::<bool, _>("rolbypassrls"),
        "momo_app must not bypass RLS"
    );

    skip_leftover_jobs(&su).await;
    let (alpha, beta) = (seed(&su).await, seed(&su).await);
    let http = SiteHttp::new(&[
        ("https://a.example/1", FULL_PAGE),
        (
            "https://b.example/1",
            r#"<meta property="og:title" content="Beta card">
               <meta property="og:site_name" content="Site Beta">
               <meta property="og:image" content="/b.png">
               <meta property="og:image:width" content="300">
               <meta property="og:image:height" content="200">
               <link rel="icon" href="/beta.png">"#,
        ),
    ]);
    let worker = UnfurlWorker::new(
        su.clone(),
        http,
        UnfurlConfig::for_tests(database_url(), true),
    );
    let message_a = insert_message(&su, &alpha, "https://a.example/1").await;
    let message_b = insert_message(&su, &beta, "https://b.example/1").await;
    worker.drain_once().await.expect("drain");

    // Each tenant, as momo_app, sees its own card with the new columns...
    let a_cards = read_cards(&app, alpha.workspace, message_a).await;
    assert_eq!(a_cards.len(), 1);
    assert_eq!(a_cards[0].site_name.as_deref(), Some("Site Alpha"));
    assert_eq!(
        a_cards[0].icon_source_url.as_deref(),
        Some("https://a.example/touch.png")
    );
    assert_eq!(
        (a_cards[0].image_width, a_cards[0].image_height),
        (Some(1200), Some(630))
    );
    let b_cards = read_cards(&app, beta.workspace, message_b).await;
    assert_eq!(b_cards[0].site_name.as_deref(), Some("Site Beta"));
    assert_eq!(
        (b_cards[0].image_width, b_cards[0].image_height),
        (Some(300), Some(200))
    );
    assert!(!b_cards[0].is_video);

    // ...and neither can reach the other's: not by message, not by card id.
    assert!(read_cards(&app, alpha.workspace, message_b)
        .await
        .is_empty());
    assert!(read_cards(&app, beta.workspace, message_a).await.is_empty());
    let (a_id, b_id) = (a_cards[0].id, b_cards[0].id);
    let crossed = with_tenant_tx(&app, alpha.workspace, move |conn| {
        Box::pin(async move { momo_unfurl::load_unfurl_in_tx(conn, b_id).await })
    })
    .await
    .expect("load");
    assert!(
        crossed.is_none(),
        "tenant alpha must not load tenant beta's card"
    );
    let own = with_tenant_tx(&app, alpha.workspace, move |conn| {
        Box::pin(async move { momo_unfurl::load_unfurl_in_tx(conn, a_id).await })
    })
    .await
    .expect("load");
    assert_eq!(
        own.expect("own card").site_name.as_deref(),
        Some("Site Alpha")
    );

    // A measured size written under the wrong tenant touches nothing.
    let foreign = b_cards[0].clone();
    let touched = with_tenant_tx(&app, alpha.workspace, move |conn| {
        Box::pin(async move { momo_unfurl::record_measured_size(conn, &foreign, 9, 9).await })
    })
    .await
    .expect("write");
    assert!(!touched);
    assert_eq!(
        (b_cards[0].image_width, b_cards[0].image_height),
        (Some(300), Some(200))
    );
}

/// 「없으면 프록시가 받을 때 잰 값」 lands once, only where the page declared nothing, on the
/// card row and on the cache row for the same page and picture.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB"]
async fn a_measured_size_is_recorded_once_and_a_declared_size_is_never_overwritten() {
    let _guard = test_lock().await;
    ensure_schema();
    let su = superuser_pool().await;
    skip_leftover_jobs(&su).await;
    let tenant = seed(&su).await;
    let http = SiteHttp::new(&[
        (
            "https://nosize.example/p",
            r#"<meta property="og:title" content="No size"><meta property="og:image" content="/p.png">"#,
        ),
        ("https://a.example/1", FULL_PAGE),
    ]);
    let worker = UnfurlWorker::new(
        su.clone(),
        http,
        UnfurlConfig::for_tests(database_url(), true),
    );
    let message =
        insert_message(&su, &tenant, "https://nosize.example/p https://a.example/1").await;
    worker.drain_once().await.expect("drain");
    let cards = read_cards(&su, tenant.workspace, message).await;
    let (nosize, declared) = (cards[0].clone(), cards[1].clone());
    assert_eq!((nosize.image_width, nosize.image_height), (None, None));

    let workspace = tenant.workspace;
    let write = |record: UnfurlRecord, width: i32, height: i32| {
        let su = su.clone();
        async move {
            with_tenant_tx(&su, workspace, move |conn| {
                Box::pin(async move {
                    momo_unfurl::record_measured_size(conn, &record, width, height).await
                })
            })
            .await
            .expect("record_measured_size")
        }
    };
    assert!(
        write(nosize.clone(), 40, 30).await,
        "the first measurement is recorded"
    );
    assert!(!write(nosize.clone(), 99, 77).await, "a second one is not");
    assert!(
        !write(declared.clone(), 5, 5).await,
        "a size the page declared is never replaced"
    );

    let card_size: (i32, i32) =
        sqlx::query_as("SELECT image_width, image_height FROM message_unfurl WHERE id = $1")
            .bind(nosize.id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(card_size, (40, 30));
    let cache_size: (i32, i32) = sqlx::query_as(
        "SELECT image_width, image_height FROM unfurl_url_cache \
          WHERE workspace_id = $1 AND url_key = $2",
    )
    .bind(tenant.workspace)
    .bind("https://nosize.example/p")
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        cache_size,
        (40, 30),
        "the cache row follows, so the next message starts with it"
    );
    let declared_size: (i32, i32) =
        sqlx::query_as("SELECT image_width, image_height FROM message_unfurl WHERE id = $1")
            .bind(declared.id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(declared_size, (1200, 630));
}

/// The rules the migration puts in the database itself, whatever the application does.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB"]
async fn the_database_holds_the_size_pair_the_icon_pair_and_the_name_length() {
    let _guard = test_lock().await;
    ensure_schema();
    let su = superuser_pool().await;
    skip_leftover_jobs(&su).await;
    let tenant = seed(&su).await;
    let message = insert_message(&su, &tenant, "no link here").await;

    #[derive(Clone, Default)]
    struct Row {
        width: Option<i32>,
        height: Option<i32>,
        icon_url: Option<String>,
        icon_key: Option<String>,
        site_name: Option<String>,
    }
    let attempt = |label: &str, row: Row| {
        let su = su.clone();
        let label = label.to_string();
        async move {
            sqlx::query(
                "INSERT INTO message_unfurl \
                   (workspace_id, channel_id, message_id, url_key, source_url, status, \
                    image_width, image_height, icon_source_url, icon_proxy_key, site_name) \
                 VALUES ($1,$2,$3,$4,$4,'ok',$5,$6,$7,$8,$9)",
            )
            .bind(tenant.workspace)
            .bind(tenant.channel)
            .bind(message)
            .bind(format!("https://db.example/{label}"))
            .bind(row.width)
            .bind(row.height)
            .bind(row.icon_url)
            .bind(row.icon_key)
            .bind(row.site_name)
            .execute(&su)
            .await
        }
    };
    let good = Row {
        width: Some(16384),
        height: Some(1),
        icon_url: Some("https://db.example/i.ico".into()),
        icon_key: Some("k".into()),
        site_name: Some("가".repeat(100)),
    };
    attempt("good", good.clone())
        .await
        .expect("the boundary values are valid");
    for (label, row, constraint) in [
        (
            "w-only",
            Row {
                height: None,
                ..good.clone()
            },
            "message_unfurl_image_size_ck",
        ),
        (
            "h-only",
            Row {
                width: None,
                ..good.clone()
            },
            "message_unfurl_image_size_ck",
        ),
        (
            "w-zero",
            Row {
                width: Some(0),
                ..good.clone()
            },
            "message_unfurl_image_size_ck",
        ),
        (
            "h-big",
            Row {
                height: Some(16385),
                ..good.clone()
            },
            "message_unfurl_image_size_ck",
        ),
        (
            "icon-no-key",
            Row {
                icon_key: None,
                ..good.clone()
            },
            "message_unfurl_icon_ck",
        ),
        (
            "key-no-icon",
            Row {
                icon_url: None,
                ..good.clone()
            },
            "message_unfurl_icon_ck",
        ),
        (
            "icon-long",
            Row {
                icon_url: Some(format!("https://db.example/{}", "x".repeat(2100))),
                ..good.clone()
            },
            "message_unfurl_icon_ck",
        ),
        (
            "name-101",
            Row {
                site_name: Some("가".repeat(101)),
                ..good.clone()
            },
            "message_unfurl_site_name_ck",
        ),
        (
            "name-empty",
            Row {
                site_name: Some(String::new()),
                ..good.clone()
            },
            "message_unfurl_site_name_ck",
        ),
    ] {
        let error = attempt(label, row).await.expect_err(label).to_string();
        assert!(
            error.contains(constraint),
            "{label} must violate {constraint}: {error}"
        );
    }

    // #4881 review Low-1: the migration adds all six rules `NOT VALID` (no scan of the existing
    // rows, so a short lock on a big table). That must not weaken them for a NEW row, and the
    // cache table, which the loop above does not touch, holds them just the same.
    let cache_attempt = |label: &str, row: Row| {
        let su = su.clone();
        let label = label.to_string();
        async move {
            sqlx::query(
                "INSERT INTO unfurl_url_cache \
                   (workspace_id, url_key, status, expires_at, \
                    image_width, image_height, icon_source_url, icon_proxy_key, site_name) \
                 VALUES ($1,$2,'ok', now() + interval '1 day',$3,$4,$5,$6,$7)",
            )
            .bind(tenant.workspace)
            .bind(format!("https://db.example/cache/{label}"))
            .bind(row.width)
            .bind(row.height)
            .bind(row.icon_url)
            .bind(row.icon_key)
            .bind(row.site_name)
            .execute(&su)
            .await
        }
    };
    cache_attempt("good", good.clone())
        .await
        .expect("the boundary values are valid in the cache table too");
    for (label, row, constraint) in [
        (
            "w-only",
            Row {
                height: None,
                ..good.clone()
            },
            "unfurl_url_cache_image_size_ck",
        ),
        (
            "h-big",
            Row {
                height: Some(16385),
                ..good.clone()
            },
            "unfurl_url_cache_image_size_ck",
        ),
        (
            "icon-no-key",
            Row {
                icon_key: None,
                ..good.clone()
            },
            "unfurl_url_cache_icon_ck",
        ),
        (
            "name-101",
            Row {
                site_name: Some("가".repeat(101)),
                ..good.clone()
            },
            "unfurl_url_cache_site_name_ck",
        ),
    ] {
        let error = cache_attempt(label, row)
            .await
            .expect_err(label)
            .to_string();
        assert!(
            error.contains(constraint),
            "{label} must violate {constraint}: {error}"
        );
    }
    // An UPDATE of a stored row is checked as well, not only an INSERT.
    let update = sqlx::query(
        "UPDATE message_unfurl SET image_width = 0 WHERE url_key = 'https://db.example/good'",
    )
    .execute(&su)
    .await
    .expect_err("an update that breaks a rule is refused")
    .to_string();
    assert!(update.contains("message_unfurl_image_size_ck"), "{update}");
    // And the six are `NOT VALID`: that is the migration's whole point, and a later edit that
    // puts the validating scan back would otherwise change nothing a test can see.
    let constraints: Vec<(String, bool)> = sqlx::query_as(
        "SELECT conname::text, convalidated FROM pg_constraint \
          WHERE conname IN ( \
            'unfurl_url_cache_site_name_ck', 'unfurl_url_cache_icon_ck', \
            'unfurl_url_cache_image_size_ck', 'message_unfurl_site_name_ck', \
            'message_unfurl_icon_ck', 'message_unfurl_image_size_ck') \
          ORDER BY conname",
    )
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(constraints.len(), 6, "{constraints:?}");
    for (name, validated) in constraints {
        assert!(
            !validated,
            "{name} must be NOT VALID (migration 163, review Low-1). A database that applied \
             migration 163 before that change keeps the validated constraint, because applied \
             migrations are never re-run: use a freshly created database"
        );
    }
}

/// A transport with no room for any request at all (`FetchError::Capacity`), counting the asks.
struct NoRoomHttp {
    asks: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl UnfurlHttp for NoRoomHttp {
    async fn fetch(&self, _url: &str, _kind: FetchKind) -> Result<Fetched, FetchError> {
        self.asks.fetch_add(1, Ordering::SeqCst);
        Err(FetchError::Capacity)
    }
}

/// A fetch this server had no room for is as transient as one that timed out: the job goes back
/// to the queue for a later attempt and no card is written, until the attempts run out. Taken as
/// an unresolvable name, as it was before it had a kind of its own, it gave the same answer; a
/// worker that did not know the new kind would end the card for good as `failed` on the first
/// busy moment.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB"]
async fn a_fetch_this_server_had_no_room_for_is_tried_again_like_a_timeout() {
    let _guard = test_lock().await;
    ensure_schema();
    let su = superuser_pool().await;
    skip_leftover_jobs(&su).await;
    let tenant = seed(&su).await;
    let message_id = insert_message(&su, &tenant, "https://busy.example/story").await;
    let asks = Arc::new(AtomicUsize::new(0));
    let worker = UnfurlWorker::new(
        su.clone(),
        Arc::new(NoRoomHttp { asks: asks.clone() }),
        UnfurlConfig::for_tests(database_url(), true),
    );
    let job = || async {
        sqlx::query_as::<_, (String, i32, Option<String>)>(
            "SELECT status, attempts, last_error FROM unfurl_job WHERE message_id = $1",
        )
        .bind(message_id)
        .fetch_one(&su)
        .await
        .unwrap()
    };
    let cards = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM message_unfurl WHERE message_id = $1")
            .bind(message_id)
            .fetch_one(&su)
            .await
            .unwrap()
    };

    // The first attempt: put back, not ended, and nothing written for the link.
    let stats = worker.drain_once().await.expect("first drain");
    assert_eq!((stats.claimed, stats.failed), (1, 1), "{stats:?}");
    assert_eq!(
        job().await,
        (
            "pending".to_string(),
            1,
            Some("transient fetch".to_string())
        )
    );
    assert_eq!(cards().await, 0, "a busy moment is not a card");
    // The attempts run out as for any transient failure (`UnfurlConfig::for_tests`: three), and
    // only then is the job over: the link was asked for three times, no more.
    worker.drain_once().await.expect("second drain");
    assert_eq!(
        job().await,
        (
            "pending".to_string(),
            2,
            Some("transient fetch".to_string())
        )
    );
    worker.drain_once().await.expect("third drain");
    assert_eq!(job().await.0, "done");
    assert_eq!(asks.load(Ordering::SeqCst), 3);
}
