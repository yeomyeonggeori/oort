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
use std::time::Duration;

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
use momo_messaging::{add_channel_member_in_tx, create_channel, ChannelKind, NewChannel};
use momo_server::config::RateLimitConfig;
use momo_server::{build_app, AppState};
use momo_unfurl::{
    FetchError, FetchKind, Fetched, ImageCache, ProxyLimits, SafeUnfurlTransport, UnfurlConfig,
    UnfurlHttp, UnfurlWorker,
};
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

// ---------------------------------------------------------------------------
// ADR-0170 amendment 2026-10-31 (#4881): the new card fields over REST and the icon proxy
// ---------------------------------------------------------------------------

/// Pages and bytes served from memory; every request is remembered with the kind it asked as.
struct SiteHttp {
    asked: std::sync::Mutex<Vec<(String, FetchKind)>>,
}

const ICON_BYTES: &[u8] = &[0, 0, 1, 0, 1, 0, 16, 16];

fn png_40x30() -> Vec<u8> {
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    out.extend_from_slice(&13u32.to_be_bytes());
    out.extend_from_slice(b"IHDR");
    out.extend_from_slice(&40u32.to_be_bytes());
    out.extend_from_slice(&30u32.to_be_bytes());
    out.extend_from_slice(&[8, 6, 0, 0, 0]);
    out
}

#[async_trait::async_trait]
impl UnfurlHttp for SiteHttp {
    async fn fetch(&self, url: &str, kind: FetchKind) -> Result<Fetched, FetchError> {
        self.asked.lock().unwrap().push((url.to_string(), kind));
        let page = |html: &str| Fetched {
            final_url: url.to_string(),
            content_type: "text/html; charset=utf-8".into(),
            body: html.as_bytes().to_vec(),
        };
        match kind {
            FetchKind::Html | FetchKind::Preview => match url {
                "https://news.example/story" => Ok(page(
                    r#"<meta property="og:title" content="Story">
                       <meta property="og:site_name" content="News Example">
                       <meta property="og:image" content="/hero.png">
                       <meta property="og:type" content="video.other">
                       <link rel="apple-touch-icon" href="/touch.png">"#,
                )),
                "https://sized.example/p" => Ok(page(
                    r#"<meta property="og:title" content="Sized">
                       <meta property="og:image" content="/big.png">
                       <meta property="og:image:width" content="1200">
                       <meta property="og:image:height" content="630">"#,
                )),
                "https://empty.example/p" => Ok(page("<html></html>")),
                // Any number of distinct pages that have a card, for tests that need many.
                other if other.contains(".preview.example") => Ok(page(&format!(
                    r#"<meta property="og:title" content="{other}">"#
                ))),
                _ => Err(FetchError::Failed("unknown page".into())),
            },
            FetchKind::Image | FetchKind::Source => Ok(Fetched {
                final_url: url.to_string(),
                content_type: "image/png".into(),
                body: png_40x30(),
            }),
            FetchKind::Icon => Ok(Fetched {
                final_url: url.to_string(),
                content_type: "image/x-icon".into(),
                body: ICON_BYTES.to_vec(),
            }),
        }
    }
}

async fn add_member(su: &PgPool, workspace: Uuid, channel: Uuid) -> Fixture {
    let member = Uuid::new_v4();
    let email = format!("{member}@unfurl.test");
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
         VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("membership");
    Fixture {
        workspace,
        member,
        email,
        channel,
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn site_meta_over_rest_the_icon_proxy_and_the_measured_size() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let other_tenant = seed(&su, &app_pool).await;
    let outsider = add_member(&su, fixture.workspace, fixture.channel).await;
    sqlx::query(
        "UPDATE unfurl_job SET status = 'skipped' WHERE status IN ('pending', 'processing')",
    )
    .execute(&su)
    .await
    .ok();
    let transport = Arc::new(SiteHttp {
        asked: std::sync::Mutex::new(Vec::new()),
    });
    let base = start_server(app_pool.clone(), transport.clone()).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;
    let other_token = login(&http, &base, &other_tenant).await;
    let outsider_token = login(&http, &base, &outsider).await;

    let sent = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&token)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "type": "text",
            "body": "https://news.example/story https://sized.example/p https://empty.example/p"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(sent.status(), 201);
    let message_id = sent.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let worker = UnfurlWorker::new(
        su.clone(),
        transport.clone(),
        UnfurlConfig::for_tests(database_url(), true),
    );
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!((stats.claimed, stats.fetched), (1, 1));

    let list = |token: String| {
        let http = http.clone();
        let url = format!(
            "{base}/v1/workspaces/{}/messages/{message_id}/unfurls",
            fixture.workspace
        );
        async move {
            let response = http.get(url).bearer_auth(token).send().await.unwrap();
            assert_eq!(response.status(), 200);
            response.text().await.unwrap()
        }
    };
    let body = list(token.clone()).await;
    let parsed: Value = serde_json::from_str(&body).unwrap();
    let cards = parsed["unfurls"].as_array().unwrap();
    assert_eq!(cards.len(), 3);
    let (story, sized, empty) = (&cards[0], &cards[1], &cards[2]);
    let (story_id, sized_id, empty_id) = (
        story["id"].as_str().unwrap().to_string(),
        sized["id"].as_str().unwrap().to_string(),
        empty["id"].as_str().unwrap().to_string(),
    );

    // New fields, camelCase, only where there is a value.
    assert_eq!(story["siteName"], "News Example");
    assert_eq!(story["isVideo"], true);
    assert_eq!(
        story["iconUrl"],
        format!(
            "/v1/workspaces/{}/unfurls/{story_id}/icon",
            fixture.workspace
        )
    );
    assert_eq!(
        story["imageUrl"],
        format!(
            "/v1/workspaces/{}/unfurls/{story_id}/image",
            fixture.workspace
        )
    );
    assert!(
        story.get("imageWidth").is_none(),
        "nothing declared, nothing measured yet"
    );
    assert_eq!(
        (sized["imageWidth"].clone(), sized["imageHeight"].clone()),
        (json!(1200), json!(630))
    );
    assert!(sized.get("isVideo").is_none(), "isVideo is only ever true");
    assert!(sized.get("siteName").is_none());
    assert_eq!(
        empty["status"], "failed",
        "no title and no picture: a quiet end"
    );
    for key in ["title", "siteName", "iconUrl", "imageUrl", "isVideo"] {
        assert!(empty.get(key).is_none(), "{key} on a quiet card");
    }
    // No remote address anywhere in the body: neither the icon's nor the picture's.
    for remote in ["touch.png", "hero.png", "big.png", "favicon.ico"] {
        assert!(
            !body.contains(remote),
            "the response must not carry {remote}: {body}"
        );
    }

    let route = |path: String, token: Option<String>| {
        let http = http.clone();
        let base = base.clone();
        async move {
            let mut request = http.get(format!("{base}{path}"));
            if let Some(token) = token {
                request = request.bearer_auth(token);
            }
            request.send().await.unwrap()
        }
    };
    let icon_path = format!(
        "/v1/workspaces/{}/unfurls/{story_id}/icon",
        fixture.workspace
    );
    let image_path = |id: &str| format!("/v1/workspaces/{}/unfurls/{id}/image", fixture.workspace);

    // The icon proxy: bytes through this origin, fetched as an icon from the resolved address.
    let icon = route(icon_path.clone(), Some(token.clone())).await;
    assert_eq!(icon.status(), 200);
    assert_eq!(icon.headers()["content-type"], "image/x-icon");
    assert_eq!(icon.headers()["x-content-type-options"], "nosniff");
    assert_eq!(icon.bytes().await.unwrap().as_ref(), ICON_BYTES);
    assert!(
        transport.asked.lock().unwrap().contains(&(
            "https://news.example/touch.png".to_string(),
            FetchKind::Icon
        )),
        "the icon was asked for as an icon, at the address resolved against the page"
    );

    // Authorization: anonymous 401, a member outside the channel 403, another tenant 403,
    // an unknown card 404, a card with no icon 404.
    assert_eq!(route(icon_path.clone(), None).await.status(), 401);
    assert_eq!(
        route(icon_path.clone(), Some(outsider_token.clone()))
            .await
            .status(),
        403
    );
    assert_eq!(
        route(icon_path.clone(), Some(other_token.clone()))
            .await
            .status(),
        403
    );
    assert_eq!(
        route(
            format!(
                "/v1/workspaces/{}/unfurls/{}/icon",
                fixture.workspace,
                Uuid::new_v4()
            ),
            Some(token.clone())
        )
        .await
        .status(),
        404
    );
    assert_eq!(
        route(
            format!(
                "/v1/workspaces/{}/unfurls/{empty_id}/icon",
                fixture.workspace
            ),
            Some(token.clone())
        )
        .await
        .status(),
        404
    );
    assert_eq!(
        route(image_path(&story_id), Some(outsider_token.clone()))
            .await
            .status(),
        403
    );

    // The picture route measures a picture the page gave no size for, once, and the next
    // list carries it. A size the page declared stays as declared.
    let before = http
        .get(format!(
            "{base}/v1/workspaces/{}/messages/{message_id}/unfurls",
            fixture.workspace
        ))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!before.contains("\"imageWidth\":40"));
    let image = route(image_path(&story_id), Some(token.clone())).await;
    assert_eq!(image.status(), 200);
    assert_eq!(
        image.bytes().await.unwrap().as_ref(),
        png_40x30().as_slice()
    );
    let image = route(image_path(&sized_id), Some(token.clone())).await;
    assert_eq!(image.status(), 200);

    let after: Value = serde_json::from_str(&list(token.clone()).await).unwrap();
    let after = after["unfurls"].as_array().unwrap();
    assert_eq!(
        (
            after[0]["imageWidth"].clone(),
            after[0]["imageHeight"].clone()
        ),
        (json!(40), json!(30)),
        "the size measured from the proxied bytes"
    );
    assert_eq!(
        (
            after[1]["imageWidth"].clone(),
            after[1]["imageHeight"].clone()
        ),
        (json!(1200), json!(630)),
        "a declared size is not replaced by a measured one"
    );
    // The measurement is in the database (card row and the 24 h cache row), not just the reply.
    let stored: (i32, i32) = sqlx::query_as(
        "SELECT c.image_width, c.image_height FROM unfurl_url_cache c \
          WHERE c.workspace_id = $1 AND c.url_key = 'https://news.example/story'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(stored, (40, 30));

    // A second look does not change anything.
    let again = route(image_path(&story_id), Some(token.clone())).await;
    assert_eq!(again.status(), 200);
    let final_list: Value = serde_json::from_str(&list(token).await).unwrap();
    assert_eq!(final_list["unfurls"][0]["imageWidth"], json!(40));
}

// ---------------------------------------------------------------------------
// #4881 security review r1, M-2: the proxy routes ration what leaves the building
// ---------------------------------------------------------------------------

/// `SiteHttp`, except that every icon is a 404 at the remote site.
struct SiteWithoutIcons {
    inner: SiteHttp,
}

#[async_trait::async_trait]
impl UnfurlHttp for SiteWithoutIcons {
    async fn fetch(&self, url: &str, kind: FetchKind) -> Result<Fetched, FetchError> {
        if kind == FetchKind::Icon {
            self.inner
                .asked
                .lock()
                .unwrap()
                .push((url.to_string(), kind));
            return Err(FetchError::Failed("HTTP 404".into()));
        }
        self.inner.fetch(url, kind).await
    }
}

fn asked_as(site: &SiteHttp, kind: FetchKind) -> Vec<String> {
    site.asked
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, asked)| *asked == kind)
        .map(|(url, _)| url.clone())
        .collect()
}

/// A server whose fetch budget and fetch ceiling the test chose.
async fn start_tuned_server(
    app_pool: PgPool,
    http: Arc<dyn UnfurlHttp>,
    rate: RateLimitConfig,
    limits: ProxyLimits,
) -> String {
    let mut state = AppState::new(
        app_pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket",
    )
    .with_unfurl_http(http)
    .with_rate_limit(rate);
    state.unfurl_cache = Arc::new(ImageCache::with_limits(limits));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().unwrap();
    let app = build_app(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

/// Send one message with the two links that have a picture and an icon each, let the worker
/// make the cards, and return their ids: `(story, sized)`.
async fn two_cards_with_pictures_and_icons<T: UnfurlHttp + 'static>(
    su: &PgPool,
    http: &reqwest::Client,
    base: &str,
    token: &str,
    fixture: &Fixture,
    transport: Arc<T>,
) -> (String, String) {
    let sent = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(token)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "type": "text",
            "body": "https://news.example/story https://sized.example/p"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(sent.status(), 201);
    let message_id = sent.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let worker = UnfurlWorker::new(
        su.clone(),
        transport,
        UnfurlConfig::for_tests(database_url(), true),
    );
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!((stats.claimed, stats.fetched), (1, 1));
    let list: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/messages/{message_id}/unfurls",
            fixture.workspace
        ))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let cards = list["unfurls"].as_array().unwrap();
    assert_eq!(cards.len(), 2);
    for card in cards {
        assert!(card["iconUrl"].is_string() && card["imageUrl"].is_string());
    }
    (
        cards[0]["id"].as_str().unwrap().to_string(),
        cards[1]["id"].as_str().unwrap().to_string(),
    )
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn the_proxy_budget_is_spent_only_by_a_request_that_fetches_and_is_the_members_own() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let second = add_member(&su, fixture.workspace, fixture.channel).await;
    let (workspace, channel, second_id) = (fixture.workspace, fixture.channel, second.member);
    momo_db::with_tenant_tx(&app_pool, workspace, move |conn| {
        Box::pin(async move {
            add_channel_member_in_tx(conn, workspace, channel, second_id, "member").await
        })
    })
    .await
    .expect("add to channel")
    .expect("the second member joins the channel");
    sqlx::query(
        "UPDATE unfurl_job SET status = 'skipped' WHERE status IN ('pending', 'processing')",
    )
    .execute(&su)
    .await
    .ok();
    let site = Arc::new(SiteHttp {
        asked: std::sync::Mutex::new(Vec::new()),
    });
    // One fetch per member per window: the smallest budget that shows both what is counted and
    // what is not.
    let base = start_tuned_server(
        app_pool.clone(),
        site.clone(),
        RateLimitConfig {
            unfurl_proxy_per_member_limit: 1,
            ..RateLimitConfig::default()
        },
        ProxyLimits::default(),
    )
    .await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;
    let second_token = login(&http, &base, &second).await;
    let (story, sized) =
        two_cards_with_pictures_and_icons(&su, &http, &base, &token, &fixture, site.clone()).await;
    let route = |kind: &'static str, id: &str, token: &str| {
        let url = format!("{base}/v1/workspaces/{workspace}/unfurls/{id}/{kind}");
        let (http, token) = (http.clone(), token.to_string());
        async move { http.get(url).bearer_auth(token).send().await.unwrap() }
    };
    let remote_icon_asks = || asked_as(&site, FetchKind::Icon).len();
    let remote_picture_asks = || asked_as(&site, FetchKind::Image).len();

    // The first icon needs a fetch: it spends the one unit, and is served.
    assert_eq!(route("icon", &story, &token).await.status(), 200);
    assert_eq!(remote_icon_asks(), 1);
    // The same icon again is answered from memory: free, and it never reaches the remote site.
    for _ in 0..3 {
        assert_eq!(route("icon", &story, &token).await.status(), 200);
    }
    assert_eq!(remote_icon_asks(), 1, "a cached icon costs no fetch");

    // Another card's icon needs a fetch and the budget is spent: 429 with Retry-After, and the
    // remote site is not asked. The picture route draws on the same budget.
    let refused = route("icon", &sized, &token).await;
    assert_eq!(refused.status(), 429);
    let retry_after: u64 = refused.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse()
        .expect("whole seconds");
    assert!((1..=60).contains(&retry_after), "Retry-After {retry_after}");
    let refused_picture = route("image", &sized, &token).await;
    assert_eq!(refused_picture.status(), 429);
    assert_eq!(remote_icon_asks(), 1);
    assert_eq!(
        remote_picture_asks(),
        0,
        "nothing was fetched for a refusal"
    );

    // Spent budget does not stop what is already held: the first icon still answers.
    assert_eq!(route("icon", &story, &token).await.status(), 200);
    // A card that has nothing to fetch is a 404, never a 429: it spends nothing.
    assert_eq!(
        route("icon", &Uuid::new_v4().to_string(), &token)
            .await
            .status(),
        404
    );

    // The budget is the member's own: the second member fetches the very card the first was
    // refused, and that fills the shared cache.
    assert_eq!(route("icon", &sized, &second_token).await.status(), 200);
    assert_eq!(remote_icon_asks(), 2);
    // Which makes it free for the first member, whose budget is still spent.
    assert_eq!(route("icon", &sized, &token).await.status(), 200);
    assert_eq!(remote_icon_asks(), 2);

    // One refusal burst is one audit row of the documented shape (the existing member-write
    // contract), attributed to the member who was refused.
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'rate_limit.exceeded' AND actor_member_id = $2",
    )
    .bind(workspace)
    .bind(fixture.member)
    .fetch_all(&su)
    .await
    .expect("audit rows");
    assert_eq!(rows.len(), 1, "two refusals, one audit row: {rows:?}");
    assert_eq!(
        rows[0],
        json!({
            "schema": "oort.rate_limit.exceeded.v1",
            "scope": "member",
            "surface": "unfurl_proxy",
            "kind": "human",
            "limit": 1,
            "window_seconds": 60,
        })
    );
    let second_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 AND action = 'rate_limit.exceeded' AND actor_member_id = $2",
    )
    .bind(workspace)
    .bind(second_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(second_rows, 0, "the second member was never refused");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_full_house_of_fetches_in_flight_is_a_429_and_only_for_a_request_that_must_fetch() {
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
    let site = Arc::new(SiteHttp {
        asked: std::sync::Mutex::new(Vec::new()),
    });
    // No place at all among the fetches in flight: every request that must fetch is turned away.
    let base = start_tuned_server(
        app_pool.clone(),
        site.clone(),
        RateLimitConfig::default(),
        ProxyLimits {
            max_in_flight: 0,
            ..ProxyLimits::default()
        },
    )
    .await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;
    let (story, _sized) =
        two_cards_with_pictures_and_icons(&su, &http, &base, &token, &fixture, site.clone()).await;
    let before = site.asked.lock().unwrap().len();
    for kind in ["icon", "image"] {
        let response = http
            .get(format!(
                "{base}/v1/workspaces/{}/unfurls/{story}/{kind}",
                fixture.workspace
            ))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 429, "{kind}");
        assert_eq!(
            response.headers()["retry-after"],
            "1",
            "{kind}: ask again in a second"
        );
    }
    assert_eq!(
        site.asked.lock().unwrap().len(),
        before,
        "a refused request never reached the transport"
    );
    // A card that has nothing to fetch is a plain 404: it takes no place and says nothing about
    // the load.
    let unknown = http
        .get(format!(
            "{base}/v1/workspaces/{}/unfurls/{}/icon",
            fixture.workspace,
            Uuid::new_v4()
        ))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), 404);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn an_icon_that_404ed_is_remembered_so_asking_again_costs_neither_the_site_nor_the_budget() {
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
    let site = Arc::new(SiteWithoutIcons {
        inner: SiteHttp {
            asked: std::sync::Mutex::new(Vec::new()),
        },
    });
    let base = start_tuned_server(
        app_pool.clone(),
        site.clone(),
        RateLimitConfig {
            unfurl_proxy_per_member_limit: 1,
            ..RateLimitConfig::default()
        },
        ProxyLimits::default(),
    )
    .await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;
    let (story, _sized) =
        two_cards_with_pictures_and_icons(&su, &http, &base, &token, &fixture, site.clone()).await;
    // With a budget of one fetch, five requests for an icon that does not exist are five 404s:
    // the first spends the unit and learns it, the other four are answered from what was
    // learned. Without the memory the second would be a 429.
    for attempt in 1..=5 {
        let response = http
            .get(format!(
                "{base}/v1/workspaces/{}/unfurls/{story}/icon",
                fixture.workspace
            ))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 404, "attempt {attempt}");
    }
    assert_eq!(
        asked_as(&site.inner, FetchKind::Icon).len(),
        1,
        "the remote site was asked once"
    );
}

// ---------------------------------------------------------------------------
// #4881 security review r2, Low: the places are shared, so each member has a share, and being
// turned away for want of a place costs the member nothing
// ---------------------------------------------------------------------------

/// `SiteHttp`, except that once armed every icon request says it has arrived and then waits at a
/// gate the test opens: a way to hold fetches in flight while the test asks for more.
struct HeldIcons {
    inner: SiteHttp,
    armed: std::sync::atomic::AtomicBool,
    arrived: tokio::sync::mpsc::UnboundedSender<()>,
    gate: Arc<tokio::sync::Semaphore>,
}

#[async_trait::async_trait]
impl UnfurlHttp for HeldIcons {
    async fn fetch(&self, url: &str, kind: FetchKind) -> Result<Fetched, FetchError> {
        if kind == FetchKind::Icon && self.armed.load(Ordering::SeqCst) {
            let _ = self.arrived.send(());
            self.gate.acquire().await.expect("gate open").forget();
        }
        self.inner.fetch(url, kind).await
    }
}

/// Two members of one channel, two cards with a picture and an icon each, and a site whose icons
/// can be held at a gate.
struct HeldWorld {
    su: PgPool,
    base: String,
    http: reqwest::Client,
    workspace: Uuid,
    alice: Uuid,
    alice_token: String,
    bob_token: String,
    story: String,
    sized: String,
    gate: Arc<tokio::sync::Semaphore>,
    arrived: tokio::sync::mpsc::UnboundedReceiver<()>,
}

async fn held_world(rate: RateLimitConfig, limits: ProxyLimits) -> HeldWorld {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let bob = add_member(&su, fixture.workspace, fixture.channel).await;
    let (workspace, channel, bob_id) = (fixture.workspace, fixture.channel, bob.member);
    momo_db::with_tenant_tx(&app_pool, workspace, move |conn| {
        Box::pin(async move {
            add_channel_member_in_tx(conn, workspace, channel, bob_id, "member").await
        })
    })
    .await
    .expect("add to channel")
    .expect("the second member joins the channel");
    sqlx::query(
        "UPDATE unfurl_job SET status = 'skipped' WHERE status IN ('pending', 'processing')",
    )
    .execute(&su)
    .await
    .ok();
    let (arrived_tx, arrived) = tokio::sync::mpsc::unbounded_channel();
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let site = Arc::new(HeldIcons {
        inner: SiteHttp {
            asked: std::sync::Mutex::new(Vec::new()),
        },
        armed: std::sync::atomic::AtomicBool::new(false),
        arrived: arrived_tx,
        gate: gate.clone(),
    });
    let base = start_tuned_server(app_pool.clone(), site.clone(), rate, limits).await;
    let http = reqwest::Client::new();
    let alice_token = login(&http, &base, &fixture).await;
    let bob_token = login(&http, &base, &bob).await;
    let (story, sized) =
        two_cards_with_pictures_and_icons(&su, &http, &base, &alice_token, &fixture, site.clone())
            .await;
    // From here on, an icon is held at the gate.
    site.armed.store(true, Ordering::SeqCst);
    HeldWorld {
        su,
        base,
        http,
        workspace,
        alice: fixture.member,
        alice_token,
        bob_token,
        story,
        sized,
        gate,
        arrived,
    }
}

impl HeldWorld {
    fn request(&self, kind: &str, id: &str, token: &str) -> reqwest::RequestBuilder {
        self.http
            .get(format!(
                "{}/v1/workspaces/{}/unfurls/{id}/{kind}",
                self.base, self.workspace
            ))
            .bearer_auth(token)
    }

    /// A request that must be answered at once. The bound makes a request that waits for a place
    /// it should not have been given fail here, instead of hanging the suite at the gate.
    async fn ask(&self, kind: &str, id: &str, token: &str) -> reqwest::Response {
        tokio::time::timeout(
            Duration::from_secs(10),
            self.request(kind, id, token).send(),
        )
        .await
        .expect("the request must be answered at once, not wait for a place")
        .expect("request")
    }

    /// An icon request on a task of its own, so the test goes on while it waits at the gate.
    fn start_icon(&self, id: &str, token: &str) -> tokio::task::JoinHandle<reqwest::Response> {
        let request = self.request("icon", id, token);
        tokio::spawn(async move { request.send().await.expect("icon request") })
    }

    /// Wait until an icon request has reached the site, so it holds its places.
    async fn arrived(&mut self, what: &str) {
        tokio::time::timeout(Duration::from_secs(10), self.arrived.recv())
            .await
            .unwrap_or_else(|_| panic!("{what}: never reached the site"))
            .expect("the site is alive");
    }
}

async fn refusal_rows(su: &PgPool, workspace: Uuid, member: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 AND action = 'rate_limit.exceeded' AND actor_member_id = $2",
    )
    .bind(workspace)
    .bind(member)
    .fetch_one(su)
    .await
    .expect("audit rows")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_request_turned_away_for_want_of_a_place_keeps_the_members_budget() {
    let _guard = test_lock().await;
    // One fetch per member per window, and one place in all.
    let mut world = held_world(
        RateLimitConfig {
            unfurl_proxy_per_member_limit: 1,
            ..RateLimitConfig::default()
        },
        ProxyLimits {
            max_in_flight: 1,
            ..ProxyLimits::default()
        },
    )
    .await;
    // Bob's request for the story's icon is in flight and holds the one place.
    let bobs = world.start_icon(&world.story, &world.bob_token);
    world.arrived("bob's icon").await;

    // Alice asks three times for the other card's icon. There is no place, so each is turned away
    // with "ask again in a second" and none costs her anything: a spent budget would answer with
    // the rest of the window instead.
    for attempt in 1..=3 {
        let turned_away = world.ask("icon", &world.sized, &world.alice_token).await;
        assert_eq!(turned_away.status(), 429, "attempt {attempt}");
        assert_eq!(
            turned_away.headers()["retry-after"],
            "1",
            "attempt {attempt}: refused for the place, not for the budget"
        );
    }
    assert_eq!(
        refusal_rows(&world.su, world.workspace, world.alice).await,
        0,
        "her budget never ran out"
    );

    // Bob's fetch ends and the place is free. Alice's one unit is still hers: her request is
    // served (the second permit is hers at the gate).
    world.gate.add_permits(2);
    assert_eq!(bobs.await.unwrap().status(), 200);
    let served = world.ask("icon", &world.sized, &world.alice_token).await;
    assert_eq!(
        served.status(),
        200,
        "the turned-away requests spent none of her budget"
    );

    // The request that did fetch did spend it, as it should: the same card's picture needs a
    // fetch of its own, her one unit is gone, and the refusal names the rest of the window.
    let spent = world.ask("image", &world.sized, &world.alice_token).await;
    assert_eq!(spent.status(), 429);
    let retry_after: u64 = spent.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse()
        .expect("whole seconds");
    assert!((2..=60).contains(&retry_after), "Retry-After {retry_after}");
    assert_eq!(
        refusal_rows(&world.su, world.workspace, world.alice).await,
        1,
        "the one refusal that was about the budget"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn one_members_share_of_the_places_does_not_shut_another_member_out() {
    let _guard = test_lock().await;
    // Eight places in all, one for each member.
    let mut world = held_world(
        RateLimitConfig::default(),
        ProxyLimits {
            max_in_flight: 8,
            max_in_flight_per_member: 1,
            ..ProxyLimits::default()
        },
    )
    .await;
    // Alice's request for the story's icon is in flight and holds her one place.
    let alices = world.start_icon(&world.story, &world.alice_token);
    world.arrived("alice's icon").await;

    // Her next request is turned away at once, although seven of the eight places are free.
    let refused = world.ask("icon", &world.sized, &world.alice_token).await;
    assert_eq!(refused.status(), 429);
    assert_eq!(refused.headers()["retry-after"], "1");
    assert!(
        world.arrived.try_recv().is_err(),
        "the refused request never reached the site"
    );

    // Bob is not shut out by her: his request is given a place and reaches the site.
    let bobs = world.start_icon(&world.sized, &world.bob_token);
    world.arrived("bob's icon").await;
    world.gate.add_permits(2);
    assert_eq!(alices.await.unwrap().status(), 200);
    assert_eq!(bobs.await.unwrap().status(), 200);
}

// ---------------------------------------------------------------------------
// ADR-0170 amendment 2026-11-01 (#4884): the card of a link that is still in the composer, and
// 「미리보기 없이 보내기」
// ---------------------------------------------------------------------------

/// A server for the preview tests: the instance's unfurl switch as the test chose, and the
/// budget and the places among the fetches in flight as the test chose.
async fn start_preview_server(
    app_pool: PgPool,
    http: Arc<dyn UnfurlHttp>,
    rate: RateLimitConfig,
    limits: ProxyLimits,
    instance_enabled: bool,
) -> String {
    let mut state = AppState::new(
        app_pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket",
    )
    .with_unfurl_http(http)
    .with_unfurl_enabled(instance_enabled)
    .with_rate_limit(rate);
    state.unfurl_cache = Arc::new(ImageCache::with_limits(limits));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().unwrap();
    let app = build_app(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

/// What every test below stands on: the role the server's pool runs as is neither a superuser
/// nor a bypass of row-level security, so a tenant's rows are what RLS says they are.
async fn assert_runtime_role_is_not_privileged(app: &PgPool) {
    let flags =
        sqlx::query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
            .fetch_one(app)
            .await
            .expect("the runtime role exists");
    assert!(
        !sqlx::Row::get::<bool, _>(&flags, "rolsuper"),
        "momo_app is a superuser"
    );
    assert!(
        !sqlx::Row::get::<bool, _>(&flags, "rolbypassrls"),
        "momo_app bypasses RLS"
    );
}

async fn join_channel(app: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid, role: &str) {
    let role = role.to_string();
    momo_db::with_tenant_tx(app, workspace, move |conn| {
        Box::pin(
            async move { add_channel_member_in_tx(conn, workspace, channel, member, &role).await },
        )
    })
    .await
    .expect("add to channel")
    .expect("the member joins the channel");
}

async fn post_preview(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    channel: Uuid,
    token: Option<&str>,
    url: &str,
) -> reqwest::Response {
    let mut request = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/channels/{channel}/unfurl-previews"
        ))
        .json(&json!({ "url": url }));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    request.send().await.unwrap()
}

async fn get_path(
    http: &reqwest::Client,
    base: &str,
    path: &str,
    token: &str,
) -> reqwest::Response {
    http.get(format!("{base}{path}"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
}

fn skip_stale_jobs() -> &'static str {
    "UPDATE unfurl_job SET status = 'skipped' WHERE status IN ('pending', 'processing')"
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_preview_shows_the_card_to_the_member_who_asked_and_never_a_remote_address() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    assert_runtime_role_is_not_privileged(&app_pool).await;
    let fixture = seed(&su, &app_pool).await;
    let other_tenant = seed(&su, &app_pool).await;
    let colleague = add_member(&su, fixture.workspace, fixture.channel).await;
    join_channel(
        &app_pool,
        fixture.workspace,
        fixture.channel,
        colleague.member,
        "member",
    )
    .await;
    let site = Arc::new(SiteHttp {
        asked: std::sync::Mutex::new(Vec::new()),
    });
    let base = start_preview_server(
        app_pool.clone(),
        site.clone(),
        RateLimitConfig::default(),
        ProxyLimits::default(),
        true,
    )
    .await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;
    let colleague_token = login(&http, &base, &colleague).await;
    let other_token = login(&http, &base, &other_tenant).await;
    let (workspace, channel) = (fixture.workspace, fixture.channel);

    let response = post_preview(
        &http,
        &base,
        workspace,
        channel,
        Some(&token),
        "https://news.example/story",
    )
    .await;
    assert_eq!(response.status(), 200);
    let text = response.text().await.unwrap();
    let card: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(card["status"], "ok");
    assert_eq!(card["url"], "https://news.example/story");
    assert_eq!(card["title"], "Story");
    assert_eq!(card["siteName"], "News Example");
    assert_eq!(card["domain"], "news.example");
    assert_eq!(card["isVideo"], json!(true));
    assert!(
        card.get("messageId").is_none(),
        "there is no message yet: {card}"
    );
    let id = card["id"].as_str().expect("an ok preview has an id");
    Uuid::parse_str(id).expect("a UUID");
    // Only the two paths on this origin: never the page's own picture or icon address.
    let image_path = format!("/v1/workspaces/{workspace}/unfurl-previews/{id}/image");
    let icon_path = format!("/v1/workspaces/{workspace}/unfurl-previews/{id}/icon");
    assert_eq!(card["imageUrl"], image_path.as_str());
    assert_eq!(card["iconUrl"], icon_path.as_str());
    for remote in [
        "hero.png",
        "touch.png",
        "favicon",
        "https://news.example/hero",
    ] {
        assert!(
            !text.contains(remote),
            "the response names {remote}: {text}"
        );
    }
    assert_eq!(
        asked_as(&site, FetchKind::Preview),
        vec!["https://news.example/story".to_string()],
        "the page was asked for as a preview"
    );
    assert!(
        asked_as(&site, FetchKind::Html).is_empty(),
        "never as the worker's kind, which has no port rule"
    );

    // The picture and the icon come through the paths, by the stored card's proxy.
    let picture = get_path(&http, &base, &image_path, &token).await;
    assert_eq!(picture.status(), 200);
    assert_eq!(picture.headers()["content-type"], "image/png");
    assert_eq!(picture.headers()["x-content-type-options"], "nosniff");
    assert_eq!(picture.bytes().await.unwrap().to_vec(), png_40x30());
    let icon = get_path(&http, &base, &icon_path, &token).await;
    assert_eq!(icon.status(), 200);
    assert_eq!(icon.headers()["content-type"], "image/x-icon");
    assert_eq!(asked_as(&site, FetchKind::Image).len(), 1);
    assert_eq!(asked_as(&site, FetchKind::Icon).len(), 1);

    // A preview is its asker's own: a colleague in the same channel gets a 404 for its id, and
    // the other tenant is told the workspace is not theirs (403), or finds nothing (404).
    assert_eq!(
        get_path(&http, &base, &image_path, &colleague_token)
            .await
            .status(),
        404
    );
    assert_eq!(
        get_path(&http, &base, &image_path, &other_token)
            .await
            .status(),
        403
    );
    let theirs = format!(
        "/v1/workspaces/{}/unfurl-previews/{id}/image",
        other_tenant.workspace
    );
    assert_eq!(
        get_path(&http, &base, &theirs, &other_token).await.status(),
        404
    );

    // No credential, no preview: the request, and both paths.
    assert_eq!(
        post_preview(
            &http,
            &base,
            workspace,
            channel,
            None,
            "https://news.example/story"
        )
        .await
        .status(),
        401
    );
    assert_eq!(
        http.get(format!("{base}{image_path}"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn only_an_active_member_of_the_channel_may_preview_and_a_guest_only_where_it_may_send() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    assert_runtime_role_is_not_privileged(&app_pool).await;
    let fixture = seed(&su, &app_pool).await;
    let (workspace, channel) = (fixture.workspace, fixture.channel);
    // A second channel the owner made, that the guest is not in.
    let closed = create_channel(
        &app_pool,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("closed-{}", Uuid::new_v4()),
            topic: None,
            created_by: fixture.member,
        },
    )
    .await
    .expect("second channel")
    .id;
    // A member of the workspace who is in no channel, and a guest who is in one.
    let outsider = add_member(&su, workspace, channel).await;
    let guest = add_member(&su, workspace, channel).await;
    sqlx::query("UPDATE workspace_membership SET role = 'guest' WHERE member_id = $1")
        .bind(guest.member)
        .execute(&su)
        .await
        .expect("make the guest");
    join_channel(&app_pool, workspace, channel, guest.member, "guest").await;
    let site = Arc::new(SiteHttp {
        asked: std::sync::Mutex::new(Vec::new()),
    });
    let base = start_preview_server(
        app_pool.clone(),
        site.clone(),
        RateLimitConfig::default(),
        ProxyLimits::default(),
        true,
    )
    .await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, &fixture).await;
    let outsider_token = login(&http, &base, &outsider).await;
    let guest_token = login(&http, &base, &guest).await;
    let url = "https://news.example/story";

    // A member of the workspace who is not in the channel, and a channel that does not exist,
    // are the same 403 — the answer does not say which channels there are.
    for (label, channel_id, token) in [
        ("not in the channel", channel, &outsider_token),
        ("no such channel", Uuid::new_v4(), &owner_token),
        (
            "owner, not in that channel's membership",
            Uuid::new_v4(),
            &guest_token,
        ),
    ] {
        let response = post_preview(&http, &base, workspace, channel_id, Some(token), url).await;
        assert_eq!(response.status(), 403, "{label}");
    }
    assert!(
        asked_as(&site, FetchKind::Preview).is_empty(),
        "a refusal never reached the transport"
    );

    // The guest may preview in the channel it is in — the rule a send has — and not elsewhere.
    let allowed = post_preview(&http, &base, workspace, channel, Some(&guest_token), url).await;
    assert_eq!(allowed.status(), 200);
    assert_eq!(allowed.json::<Value>().await.unwrap()["status"], "ok");
    let elsewhere = post_preview(&http, &base, workspace, closed, Some(&guest_token), url).await;
    assert_eq!(elsewhere.status(), 403, "a guest outside that channel");
    assert_eq!(asked_as(&site, FetchKind::Preview).len(), 1);

    // The owner is in the first channel only too.
    assert_eq!(
        post_preview(&http, &base, workspace, channel, Some(&owner_token), url)
            .await
            .status(),
        200
    );
    // And a request for another workspace's path is the usual scope mismatch.
    let foreign = post_preview(
        &http,
        &base,
        Uuid::new_v4(),
        channel,
        Some(&owner_token),
        url,
    )
    .await;
    assert_eq!(foreign.status(), 403);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn two_tenants_and_two_members_never_share_a_preview() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    assert_runtime_role_is_not_privileged(&app_pool).await;
    let tenant_a = seed(&su, &app_pool).await;
    let tenant_b = seed(&su, &app_pool).await;
    let colleague = add_member(&su, tenant_a.workspace, tenant_a.channel).await;
    join_channel(
        &app_pool,
        tenant_a.workspace,
        tenant_a.channel,
        colleague.member,
        "member",
    )
    .await;
    let site = Arc::new(SiteHttp {
        asked: std::sync::Mutex::new(Vec::new()),
    });
    let base = start_preview_server(
        app_pool.clone(),
        site.clone(),
        RateLimitConfig::default(),
        ProxyLimits::default(),
        true,
    )
    .await;
    let http = reqwest::Client::new();
    let a_token = login(&http, &base, &tenant_a).await;
    let colleague_token = login(&http, &base, &colleague).await;
    let b_token = login(&http, &base, &tenant_b).await;
    let url = "https://news.example/story";
    let ask = |tenant: &Fixture, token: &str| {
        let (http, base, token) = (http.clone(), base.clone(), token.to_string());
        let (workspace, channel) = (tenant.workspace, tenant.channel);
        async move {
            let response = post_preview(&http, &base, workspace, channel, Some(&token), url).await;
            assert_eq!(response.status(), 200);
            response.json::<Value>().await.unwrap()
        }
    };
    let asked = || asked_as(&site, FetchKind::Preview).len();

    let first = ask(&tenant_a, &a_token).await;
    assert_eq!(asked(), 1);
    // The same member asking again is answered from what the server holds: the same id, and
    // the page is not asked for again.
    let again = ask(&tenant_a, &a_token).await;
    assert_eq!(again["id"], first["id"]);
    assert_eq!(asked(), 1, "a held preview costs the site nothing");

    // A colleague in the same channel and workspace gets a preview of their own: another
    // request to the site and another id. One member's draft is not another's cache hit.
    let colleague_card = ask(&colleague_for(&tenant_a, &colleague), &colleague_token).await;
    assert_eq!(
        asked(),
        2,
        "another member of the same workspace fetches again"
    );
    assert_ne!(colleague_card["id"], first["id"]);

    // And so does another tenant that asks about the very same address.
    let b_card = ask(&tenant_b, &b_token).await;
    assert_eq!(asked(), 3, "another tenant fetches again");
    assert_ne!(b_card["id"], first["id"]);
    assert_ne!(b_card["id"], colleague_card["id"]);

    // Ids are not interchangeable: each token reads only its own.
    let path = |workspace: Uuid, card: &Value, kind: &str| {
        format!(
            "/v1/workspaces/{workspace}/unfurl-previews/{}/{kind}",
            card["id"].as_str().unwrap()
        )
    };
    assert_eq!(
        get_path(
            &http,
            &base,
            &path(tenant_a.workspace, &first, "image"),
            &a_token
        )
        .await
        .status(),
        200
    );
    assert_eq!(
        get_path(
            &http,
            &base,
            &path(tenant_a.workspace, &first, "image"),
            &colleague_token
        )
        .await
        .status(),
        404
    );
    assert_eq!(
        get_path(
            &http,
            &base,
            &path(tenant_b.workspace, &first, "image"),
            &b_token
        )
        .await
        .status(),
        404,
        "another tenant's id, asked for in one's own workspace"
    );
    assert_eq!(
        get_path(
            &http,
            &base,
            &path(tenant_a.workspace, &first, "image"),
            &b_token
        )
        .await
        .status(),
        403,
        "another tenant's workspace in the path"
    );
}

/// The fixture shape `ask` takes, for a member who is not the workspace's owner.
fn colleague_for(tenant: &Fixture, member: &Fixture) -> Fixture {
    Fixture {
        workspace: tenant.workspace,
        member: member.member,
        email: member.email.clone(),
        channel: tenant.channel,
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_preview_is_cached_and_spends_budget_only_when_it_fetches() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let second = add_member(&su, fixture.workspace, fixture.channel).await;
    join_channel(
        &app_pool,
        fixture.workspace,
        fixture.channel,
        second.member,
        "member",
    )
    .await;
    let (workspace, channel) = (fixture.workspace, fixture.channel);
    let site = Arc::new(SiteHttp {
        asked: std::sync::Mutex::new(Vec::new()),
    });
    // Two fetches per member per window: the smallest budget that shows what is and is not counted.
    let base = start_preview_server(
        app_pool.clone(),
        site.clone(),
        RateLimitConfig {
            unfurl_preview_per_member_limit: 2,
            ..RateLimitConfig::default()
        },
        ProxyLimits::default(),
        true,
    )
    .await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;
    let second_token = login(&http, &base, &second).await;
    let ask = |token: &str, url: &str| {
        let (http, base, token, url) = (
            http.clone(),
            base.clone(),
            token.to_string(),
            url.to_string(),
        );
        async move { post_preview(&http, &base, workspace, channel, Some(&token), &url).await }
    };
    let asked = || asked_as(&site, FetchKind::Preview).len();

    // The first address is the one page that has a picture, so a preview of it has two paths.
    let one = ask(&token, "https://news.example/story").await;
    assert_eq!(one.status(), 200);
    let one: Value = one.json().await.unwrap();
    // The same address, again and again: free, and the site is asked once.
    for _ in 0..3 {
        assert_eq!(
            ask(&token, "https://news.example/story").await.status(),
            200
        );
    }
    // A cosmetically different spelling of the same address is the same address.
    assert_eq!(
        ask(&token, "HTTPS://NEWS.example/story").await.status(),
        200
    );
    assert_eq!(asked(), 1, "a held preview is free");

    assert_eq!(
        ask(&token, "https://two.preview.example/").await.status(),
        200
    );
    assert_eq!(asked(), 2);

    // The budget is spent: a third address that must be fetched is a 429 with Retry-After, and
    // the site is not asked.
    let refused = ask(&token, "https://three.preview.example/").await;
    assert_eq!(refused.status(), 429);
    let retry_after: u64 = refused.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse()
        .expect("whole seconds");
    assert!((1..=60).contains(&retry_after), "Retry-After {retry_after}");
    assert_eq!(asked(), 2, "a refusal never reached the transport");
    // What is held still answers with the budget spent.
    assert_eq!(
        ask(&token, "https://news.example/story").await.status(),
        200
    );
    assert_eq!(
        ask(&token, "https://two.preview.example/").await.status(),
        200
    );

    // The preview budget is its own: the picture of a preview already made is a different
    // surface, with its own budget, and is still served.
    let image_path = one["imageUrl"].as_str().expect("the first has a picture");
    assert_eq!(
        get_path(&http, &base, image_path, &token).await.status(),
        200
    );

    // And it is the member's own: the colleague fetches the address the first was refused.
    assert_eq!(
        ask(&second_token, "https://three.preview.example/")
            .await
            .status(),
        200
    );
    assert_eq!(asked(), 3);

    // One refusal burst is one audit row of the documented shape, for the member who was
    // refused and for no one else.
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'rate_limit.exceeded' AND actor_member_id = $2",
    )
    .bind(workspace)
    .bind(fixture.member)
    .fetch_all(&su)
    .await
    .expect("audit rows");
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(
        rows[0],
        json!({
            "schema": "oort.rate_limit.exceeded.v1",
            "scope": "member",
            "surface": "unfurl_preview",
            "kind": "human",
            "limit": 2,
            "window_seconds": 60,
        })
    );
    let second_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 AND action = 'rate_limit.exceeded' AND actor_member_id = $2",
    )
    .bind(workspace)
    .bind(second.member)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(second_rows, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_preview_with_no_place_is_a_429_and_gives_the_unit_back() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (workspace, channel) = (fixture.workspace, fixture.channel);
    let site = Arc::new(SiteHttp {
        asked: std::sync::Mutex::new(Vec::new()),
    });
    // A budget of one fetch, and no place at all for this member among the fetches in flight.
    let base = start_preview_server(
        app_pool.clone(),
        site.clone(),
        RateLimitConfig {
            unfurl_preview_per_member_limit: 1,
            ..RateLimitConfig::default()
        },
        ProxyLimits {
            max_in_flight_per_member: 0,
            ..ProxyLimits::default()
        },
        true,
    )
    .await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;
    for attempt in 1..=3 {
        let response = post_preview(
            &http,
            &base,
            workspace,
            channel,
            Some(&token),
            &format!("https://attempt{attempt}.preview.example/"),
        )
        .await;
        assert_eq!(response.status(), 429, "attempt {attempt}");
        // `Retry-After: 1` is the answer for a missing place. A spent budget would say how long
        // is left of the window, and the second attempt would be that if the first had not
        // been given its unit back.
        assert_eq!(
            response.headers()["retry-after"],
            "1",
            "attempt {attempt}: asked again in a second, not told the budget is spent"
        );
    }
    assert!(
        asked_as(&site, FetchKind::Preview).is_empty(),
        "no place, no request"
    );
    let audit: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 AND action = 'rate_limit.exceeded'",
    )
    .bind(workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(audit, 0, "no refusal was the budget's");
}

/// ADR-0170 증보 D20: the budget counts a request that **fetches**, whatever the fetch finds. The
/// only unit given back is the one for a place that was not there, so a member cannot probe a
/// site's (or a great many sites') failures for free. A refund added to the `failed` answer is the
/// regression this holds: the third address below would then be a 200.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_failed_preview_spends_the_budget_like_a_good_one() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (workspace, channel) = (fixture.workspace, fixture.channel);
    let site = Arc::new(SiteHttp {
        asked: std::sync::Mutex::new(Vec::new()),
    });
    // Two fetches per member per window, and the places among the fetches in flight left as they
    // are: a 429 below can only be the budget's.
    let base = start_preview_server(
        app_pool.clone(),
        site.clone(),
        RateLimitConfig {
            unfurl_preview_per_member_limit: 2,
            ..RateLimitConfig::default()
        },
        ProxyLimits::default(),
        true,
    )
    .await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;
    let ask = |url: &str| {
        let (http, base, token, url) = (http.clone(), base.clone(), token.clone(), url.to_string());
        async move { post_preview(&http, &base, workspace, channel, Some(&token), &url).await }
    };
    let asked = || asked_as(&site, FetchKind::Preview).len();

    // The two ways a fetch ends in `failed` that the route cannot tell apart: the transport
    // errors (the stand-in knows no such page), and the page arrives with nothing a card can show.
    let down = "https://down.example/story";
    let empty = "https://empty.example/p";
    for url in [down, empty] {
        let response = ask(url).await;
        assert_eq!(response.status(), 200, "{url}");
        let body: Value = response.json().await.unwrap();
        assert_eq!(body, json!({ "url": url, "status": "failed" }), "{url}");
    }
    assert_eq!(asked(), 2, "both went to the transport, and both failed");

    // A third address, one that has a card, is refused by the budget: two failures spent it.
    let refused = ask("https://third.preview.example/").await;
    assert_eq!(
        refused.status(),
        429,
        "a failed preview spent its unit; it was not given back"
    );
    let retry_after: u64 = refused.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse()
        .expect("whole seconds");
    assert!((1..=60).contains(&retry_after), "Retry-After {retry_after}");
    assert_eq!(asked(), 2, "a refusal never reached the transport");
    // The refusal is the budget's (one audit row), not a missing place's (which writes none).
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'rate_limit.exceeded' AND actor_member_id = $2",
    )
    .bind(workspace)
    .bind(fixture.member)
    .fetch_all(&su)
    .await
    .expect("audit rows");
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["surface"], "unfurl_preview");
    assert_eq!(rows[0]["limit"], 2);

    // What failed is remembered, and asking again is free: the same two addresses are still
    // `failed` with the budget spent (a 200, not a 429), and the transport is not asked again.
    for url in [down, empty] {
        let response = ask(url).await;
        assert_eq!(response.status(), 200, "{url} again");
        assert_eq!(
            response.json::<Value>().await.unwrap()["status"],
            "failed",
            "{url} again"
        );
    }
    assert_eq!(asked(), 2, "a remembered failure costs the site nothing");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_destination_the_guard_refuses_is_a_plain_failed_preview_through_the_production_transport(
) {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (workspace, channel) = (fixture.workspace, fixture.channel);
    // A live listener on the loopback address: nothing may ever connect to it.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let connections = Arc::new(AtomicUsize::new(0));
    tokio::spawn({
        let connections = connections.clone();
        async move {
            while listener.accept().await.is_ok() {
                connections.fetch_add(1, Ordering::SeqCst);
            }
        }
    });
    // The transport the server really runs, not a stand-in. Every address below is refused
    // before any name is looked up, so nothing here needs a network.
    let transport: Arc<dyn UnfurlHttp> = Arc::new(SafeUnfurlTransport::production(false));
    let base = start_preview_server(
        app_pool.clone(),
        transport,
        RateLimitConfig::default(),
        ProxyLimits::default(),
        true,
    )
    .await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;
    let refused = [
        "https://127.0.0.1/".to_string(),
        format!("https://127.0.0.1:{port}/"),
        format!("http://127.0.0.1:{port}/"),
        "https://localhost/x".to_string(),
        "https://169.254.169.254/latest/meta-data/".to_string(),
        "https://10.0.0.5/".to_string(),
        "https://192.168.1.1/admin".to_string(),
        "https://[::1]/".to_string(),
        "http://news.example/plain".to_string(),
        "https://news.example:8443/other-port".to_string(),
    ];
    for url in &refused {
        let response = post_preview(&http, &base, workspace, channel, Some(&token), url).await;
        assert_eq!(response.status(), 200, "{url}");
        let text = response.text().await.unwrap();
        let body: Value = serde_json::from_str(&text).unwrap();
        let mut keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["status", "url"], "{url}: {text}");
        assert_eq!(body["status"], "failed", "{url}");
        assert!(
            !text.contains("blocked"),
            "a refusal is not told apart from any other failure: {text}"
        );
    }
    assert_eq!(
        connections.load(Ordering::SeqCst),
        0,
        "the loopback listener was dialled"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_preview_makes_no_request_while_the_workspace_or_the_instance_has_unfurls_off() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (workspace, channel) = (fixture.workspace, fixture.channel);
    let site = Arc::new(SiteHttp {
        asked: std::sync::Mutex::new(Vec::new()),
    });
    let base = start_preview_server(
        app_pool.clone(),
        site.clone(),
        RateLimitConfig::default(),
        ProxyLimits::default(),
        true,
    )
    .await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;
    let url = "https://news.example/story";
    let switch = |enabled: bool| {
        let (http, base, token) = (http.clone(), base.clone(), token.clone());
        async move {
            let response = http
                .put(format!("{base}/v1/workspaces/{workspace}/unfurl-settings"))
                .bearer_auth(token)
                .json(&json!({ "enabled": enabled }))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
        }
    };

    // The workspace switch is off: the answer is a plain `failed` and nothing is fetched.
    switch(false).await;
    let off = post_preview(&http, &base, workspace, channel, Some(&token), url).await;
    assert_eq!(off.status(), 200);
    assert_eq!(
        off.json::<Value>().await.unwrap(),
        json!({"url": url, "status": "failed"})
    );
    assert!(
        asked_as(&site, FetchKind::Preview).is_empty(),
        "off means no request"
    );
    // Nothing was kept either: switching it back on is a fresh ask that fetches and succeeds.
    switch(true).await;
    let on = post_preview(&http, &base, workspace, channel, Some(&token), url).await;
    assert_eq!(on.json::<Value>().await.unwrap()["status"], "ok");
    assert_eq!(asked_as(&site, FetchKind::Preview).len(), 1);

    // The instance switch (`MOMO_UNFURL_ENABLED`) off, with the workspace on.
    let quiet_site = Arc::new(SiteHttp {
        asked: std::sync::Mutex::new(Vec::new()),
    });
    let quiet_base = start_preview_server(
        app_pool.clone(),
        quiet_site.clone(),
        RateLimitConfig::default(),
        ProxyLimits::default(),
        false,
    )
    .await;
    let quiet = post_preview(&http, &quiet_base, workspace, channel, Some(&token), url).await;
    assert_eq!(quiet.status(), 200);
    assert_eq!(quiet.json::<Value>().await.unwrap()["status"], "failed");
    assert!(
        asked_as(&quiet_site, FetchKind::Preview).is_empty(),
        "an instance with unfurls off makes no request on anyone's behalf"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_malformed_preview_request_is_a_400_before_any_fetch() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let (workspace, channel) = (fixture.workspace, fixture.channel);
    let site = Arc::new(SiteHttp {
        asked: std::sync::Mutex::new(Vec::new()),
    });
    let base = start_preview_server(
        app_pool.clone(),
        site.clone(),
        RateLimitConfig::default(),
        ProxyLimits::default(),
        true,
    )
    .await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;
    let too_long = format!("https://news.example/{}", "a".repeat(2100));
    for url in [
        "",
        "not a url",
        "ftp://news.example/file",
        "javascript:alert(1)",
        "https://user:secret@news.example/story",
        "https:///nohost",
        too_long.as_str(),
    ] {
        let response = post_preview(&http, &base, workspace, channel, Some(&token), url).await;
        assert_eq!(response.status(), 400, "{:?}", &url[..url.len().min(40)]);
    }
    // The body is closed-world and one address only: the draft's text has no place in it.
    let with_text = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/channels/{channel}/unfurl-previews"
        ))
        .bearer_auth(&token)
        .json(&json!({ "url": "https://news.example/story", "body": "the whole draft" }))
        .send()
        .await
        .unwrap();
    assert!(
        with_text.status().is_client_error(),
        "{}",
        with_text.status()
    );
    let without_url = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/channels/{channel}/unfurl-previews"
        ))
        .bearer_auth(&token)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert!(without_url.status().is_client_error());
    assert!(
        asked_as(&site, FetchKind::Preview).is_empty(),
        "a malformed request never reached the transport"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_message_sent_with_suppress_unfurl_gets_no_cards_and_one_without_still_does() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    assert_runtime_role_is_not_privileged(&app_pool).await;
    let fixture = seed(&su, &app_pool).await;
    let (workspace, channel) = (fixture.workspace, fixture.channel);
    sqlx::query(skip_stale_jobs()).execute(&su).await.ok();
    let site = Arc::new(SiteHttp {
        asked: std::sync::Mutex::new(Vec::new()),
    });
    let base = start_preview_server(
        app_pool.clone(),
        site.clone(),
        RateLimitConfig::default(),
        ProxyLimits::default(),
        true,
    )
    .await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &fixture).await;
    let send = |client_msg_id: Uuid, extra: Value| {
        let (http, base, token) = (http.clone(), base.clone(), token.clone());
        async move {
            let mut body = json!({
                "clientMsgId": client_msg_id,
                "type": "text",
                "body": "https://news.example/story"
            });
            body.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let response = http
                .post(format!(
                    "{base}/v1/workspaces/{workspace}/channels/{channel}/messages"
                ))
                .bearer_auth(token)
                .json(&body)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 201);
            response.json::<Value>().await.unwrap()["id"]
                .as_str()
                .unwrap()
                .to_string()
        }
    };
    let (suppressed_client, plain_client, explicit_client) =
        (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let suppressed = send(suppressed_client, json!({"suppressUnfurl": true})).await;
    let plain = send(plain_client, json!({})).await;
    let explicit = send(explicit_client, json!({"suppressUnfurl": false})).await;

    let worker = UnfurlWorker::new(
        su.clone(),
        site.clone(),
        UnfurlConfig::for_tests(database_url(), true),
    );
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.claimed, 3, "the trigger still queues a job for each");
    assert_eq!(stats.skipped, 1, "and the suppressed one ends as skipped");
    // The two that get cards share one link: the first fetches it, the second finds the answer.
    assert_eq!((stats.fetched, stats.cached), (1, 1));

    let cards = |message: String| {
        let (http, base, token) = (http.clone(), base.clone(), token.clone());
        async move {
            let list: Value = http
                .get(format!(
                    "{base}/v1/workspaces/{workspace}/messages/{message}/unfurls"
                ))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            list["unfurls"].as_array().unwrap().len()
        }
    };
    assert_eq!(cards(suppressed.clone()).await, 0, "suppressed: no card");
    assert_eq!(cards(plain.clone()).await, 1, "no key: a card, as ever");
    assert_eq!(cards(explicit.clone()).await, 1, "false: a card, as ever");
    assert_eq!(
        asked_as(&site, FetchKind::Html).len(),
        1,
        "the suppressed message's link was never fetched (the other two share one cached answer)"
    );

    // The tombstone is the one the author's own removal plants: one row, in the author's name,
    // for the suppressed message only.
    let tombstones = |message: &str| {
        let su = su.clone();
        let message = Uuid::parse_str(message).unwrap();
        async move {
            sqlx::query_as::<_, (Uuid,)>(
                "SELECT removed_by FROM message_unfurl_tombstone WHERE message_id = $1",
            )
            .bind(message)
            .fetch_all(&su)
            .await
            .unwrap()
        }
    };
    assert_eq!(tombstones(&suppressed).await, vec![(fixture.member,)]);
    assert!(tombstones(&plain).await.is_empty());
    assert!(tombstones(&explicit).await.is_empty());

    // A retry is not a second chance to decide, either way. The same clientMsgId answers the
    // stored message: dropping the key does not lift the suppression, and adding it to a message
    // that already went out plants nothing.
    assert_eq!(send(suppressed_client, json!({})).await, suppressed);
    assert_eq!(
        send(plain_client, json!({"suppressUnfurl": true})).await,
        plain
    );
    assert_eq!(tombstones(&suppressed).await.len(), 1);
    assert!(
        tombstones(&plain).await.is_empty(),
        "a retry plants no tombstone"
    );
    let stats = worker.drain_once().await.expect("drain again");
    assert_eq!(stats.claimed, 0, "a retry queues no job");
    assert_eq!(cards(suppressed).await, 0);
    assert_eq!(cards(plain).await, 1);

    // The key on a message with no link is accepted and harmless.
    let linkless = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/channels/{channel}/messages"
        ))
        .bearer_auth(&token)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "type": "text",
            "body": "no link here",
            "suppressUnfurl": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(linkless.status(), 201);
}

/// ADR-0170 증보 D21: 「미리보기 없이 보내기」 belongs to the message being sent, whatever shape the
/// message has, and to nobody else's. A thread reply (`rootId`) and a quote (`replyToId`) go through
/// the same send transaction as a plain message, so a misplaced plant would do one of two things:
/// leave a card on a message whose author asked for none, or take the card away from the message
/// that was replied to or quoted, which may be somebody else's. Both are held here. The same shapes
/// without the key still get a card, so the empty results are the key's doing and not the shape's;
/// and a colleague's suppressed reply and quote leave the owner's message, link and card, as it was.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn suppress_unfurl_covers_a_thread_reply_and_a_quote_and_never_reaches_the_message_it_answers(
) {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    assert_runtime_role_is_not_privileged(&app_pool).await;
    let fixture = seed(&su, &app_pool).await;
    let (workspace, channel) = (fixture.workspace, fixture.channel);
    // A colleague in the same channel: the author of the replies that are not the owner's.
    let colleague = add_member(&su, workspace, channel).await;
    join_channel(&app_pool, workspace, channel, colleague.member, "member").await;
    sqlx::query(skip_stale_jobs()).execute(&su).await.ok();
    let site = Arc::new(SiteHttp {
        asked: std::sync::Mutex::new(Vec::new()),
    });
    let base = start_preview_server(
        app_pool.clone(),
        site.clone(),
        RateLimitConfig::default(),
        ProxyLimits::default(),
        true,
    )
    .await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, &fixture).await;
    let colleague_token = login(&http, &base, &colleague).await;
    // Every message carries the same link, so every one of them would get a card.
    let send = |token: &str, extra: Value| {
        let (http, base, token) = (http.clone(), base.clone(), token.to_string());
        async move {
            let mut request = json!({
                "clientMsgId": Uuid::new_v4(),
                "type": "text",
                "body": "https://news.example/story"
            });
            request
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let response = http
                .post(format!(
                    "{base}/v1/workspaces/{workspace}/channels/{channel}/messages"
                ))
                .bearer_auth(token)
                .json(&request)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 201, "{request}");
            response.json::<Value>().await.unwrap()["id"]
                .as_str()
                .unwrap()
                .to_string()
        }
    };

    // The owner's message that is replied to and quoted. It is not suppressed: it gets its card.
    let root = send(&owner_token, json!({})).await;
    // The owner's own replies and quotes, with the key and (as the control) without it.
    let reply_suppressed = send(
        &owner_token,
        json!({"rootId": root, "suppressUnfurl": true}),
    )
    .await;
    let quote_suppressed = send(
        &owner_token,
        json!({"replyToId": root, "suppressUnfurl": true}),
    )
    .await;
    let reply_plain = send(&owner_token, json!({"rootId": root})).await;
    let quote_plain = send(&owner_token, json!({"replyToId": root})).await;
    // The colleague's reply and quote, with the key, to the owner's message.
    let foreign_reply = send(
        &colleague_token,
        json!({"rootId": root, "suppressUnfurl": true}),
    )
    .await;
    let foreign_quote = send(
        &colleague_token,
        json!({"replyToId": root, "suppressUnfurl": true}),
    )
    .await;

    let worker = UnfurlWorker::new(
        su.clone(),
        site.clone(),
        UnfurlConfig::for_tests(database_url(), true),
    );
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.claimed, 7, "each of the seven links queued a job");
    assert_eq!(stats.skipped, 4, "the four suppressed ones end as skipped");
    // The three that get cards share one link: the first fetches it, the others find the answer.
    assert_eq!((stats.fetched, stats.cached), (1, 2));

    let cards = |message: &str| {
        let (http, base, token, message) = (
            http.clone(),
            base.clone(),
            owner_token.clone(),
            message.to_string(),
        );
        async move {
            let list: Value = http
                .get(format!(
                    "{base}/v1/workspaces/{workspace}/messages/{message}/unfurls"
                ))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            list["unfurls"].as_array().unwrap().len()
        }
    };
    for (label, message) in [
        ("owner's thread reply, suppressed", &reply_suppressed),
        ("owner's quote, suppressed", &quote_suppressed),
        ("colleague's thread reply, suppressed", &foreign_reply),
        ("colleague's quote, suppressed", &foreign_quote),
    ] {
        assert_eq!(cards(message).await, 0, "{label}");
    }
    for (label, message) in [
        ("the message that was replied to and quoted", &root),
        ("thread reply, no key", &reply_plain),
        ("quote, no key", &quote_plain),
    ] {
        assert_eq!(cards(message).await, 1, "{label}: a card");
    }
    assert_eq!(
        asked_as(&site, FetchKind::Html).len(),
        1,
        "the link was fetched once, for the three messages that get a card"
    );

    // One tombstone for each suppressed message, in the name of the one who sent it, and none for
    // the message that was answered or for the two without the key.
    let tombstones = |message: &str| {
        let su = su.clone();
        let message = Uuid::parse_str(message).unwrap();
        async move {
            sqlx::query_as::<_, (Uuid,)>(
                "SELECT removed_by FROM message_unfurl_tombstone WHERE message_id = $1",
            )
            .bind(message)
            .fetch_all(&su)
            .await
            .unwrap()
        }
    };
    for (label, message, author) in [
        ("owner's thread reply", &reply_suppressed, fixture.member),
        ("owner's quote", &quote_suppressed, fixture.member),
        ("colleague's thread reply", &foreign_reply, colleague.member),
        ("colleague's quote", &foreign_quote, colleague.member),
    ] {
        assert_eq!(tombstones(message).await, vec![(author,)], "{label}");
    }
    for (label, message) in [
        ("the message that was answered", &root),
        ("thread reply, no key", &reply_plain),
        ("quote, no key", &quote_plain),
    ] {
        assert!(tombstones(message).await.is_empty(), "{label}");
    }
}

/// ADR-0170 증보 D16: a preview request is judged on an **active** member of the workspace who is a
/// current member of the channel. The second half alone (the channel row) is what a member who
/// stopped being active still has, so each way of stopping is tried with the channel row and the
/// token left exactly as they were. (Suspending, removing or leaving through the REST routes revokes
/// every token of the member, `revoke_member_tokens_in_tx`, and would be a 401 at the door; this is
/// the check the request makes for itself, and the one the other tests in this file never reach.)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_member_the_workspace_does_not_count_as_active_may_not_preview_from_a_channel_it_is_still_in(
) {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    assert_runtime_role_is_not_privileged(&app_pool).await;
    let fixture = seed(&su, &app_pool).await;
    let (workspace, channel) = (fixture.workspace, fixture.channel);
    let colleague = add_member(&su, workspace, channel).await;
    join_channel(&app_pool, workspace, channel, colleague.member, "member").await;
    let site = Arc::new(SiteHttp {
        asked: std::sync::Mutex::new(Vec::new()),
    });
    let base = start_preview_server(
        app_pool.clone(),
        site.clone(),
        RateLimitConfig::default(),
        ProxyLimits::default(),
        true,
    )
    .await;
    let http = reqwest::Client::new();
    // Both sign in first: nothing below touches a token.
    let owner_token = login(&http, &base, &fixture).await;
    let token = login(&http, &base, &colleague).await;
    let url = "https://news.example/story";
    let asked = || asked_as(&site, FetchKind::Preview).len();
    let preview = |token: &str| {
        let (http, base, token) = (http.clone(), base.clone(), token.to_string());
        async move { post_preview(&http, &base, workspace, channel, Some(&token), url).await }
    };

    // Control: the same member, the same channel, the same address, active: a preview.
    assert_eq!(preview(&token).await.status(), 200);
    assert_eq!(asked(), 1);

    // Each way of not being active, with what undoes it. The conditions are the three of
    // `momo_auth::active_workspace_role`: a `workspace_membership` row, `member.status = 'active'`,
    // and `member.deleted_at` unset.
    let member = colleague.member;
    for (label, stop, undo) in [
        (
            "suspended",
            "UPDATE member SET status = 'suspended' WHERE id = $1",
            "UPDATE member SET status = 'active' WHERE id = $1",
        ),
        (
            "deleted",
            "UPDATE member SET deleted_at = now() WHERE id = $1",
            "UPDATE member SET deleted_at = NULL WHERE id = $1",
        ),
        (
            "no workspace membership",
            "DELETE FROM workspace_membership WHERE member_id = $1",
            "INSERT INTO workspace_membership (workspace_id, member_id, role) \
             SELECT m.workspace_id, m.id, 'member'::membership_role FROM member m WHERE m.id = $1",
        ),
    ] {
        sqlx::query(stop)
            .bind(member)
            .execute(&su)
            .await
            .unwrap_or_else(|error| panic!("{label}: {error}"));
        let in_channel: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM membership \
              WHERE channel_id = $1 AND member_id = $2 AND left_at IS NULL)",
        )
        .bind(channel)
        .bind(member)
        .fetch_one(&su)
        .await
        .unwrap();
        assert!(in_channel, "{label}: the channel row is untouched");

        // The address was already asked about, so a refusal that came late would be an answer
        // from the cache: it is a 403 before anything is looked up, and the site is not asked.
        let before = asked();
        let refused = preview(&token).await;
        assert_eq!(refused.status(), 403, "{label}");
        assert_eq!(
            asked(),
            before,
            "{label}: a refusal never reached the transport"
        );
        // The rest of the channel is not affected.
        assert_eq!(
            preview(&owner_token).await.status(),
            200,
            "{label}: another member is unaffected"
        );

        sqlx::query(undo)
            .bind(member)
            .execute(&su)
            .await
            .unwrap_or_else(|error| panic!("{label}: undo: {error}"));
        assert_eq!(
            preview(&token).await.status(),
            200,
            "{label}: active again, allowed again"
        );
    }
}
