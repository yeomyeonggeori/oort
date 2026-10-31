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
            FetchKind::Html => match url {
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
