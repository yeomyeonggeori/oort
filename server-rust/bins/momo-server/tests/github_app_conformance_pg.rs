//! #3947 E-GH1 (ADR-0205 D1·D2·D5·D6) — the GitHub App storage and registration surface,
//! through the real routes and the real `momo_app` role.
//!
//! * acceptance 6: no response, audit row or log line carries the PEM, the webhook secret
//!   or the `client_secret` (marker test); `client_secret` has no column anywhere;
//! * acceptance 8: without `GITHUB_APP_MASTER_KEY` the whole GitHub family is 503 while
//!   other routes work (boot-time reuse refusal is a unit test in `config.rs`);
//! * the manifest flow: one-time state (replay, forgery, expiry, demoted minter), the
//!   callback seals inside itself, a second registration is refused;
//! * the paste form is write-only and rotates the webhook secret with an overlap window;
//! * RLS, as `momo_app`: a tenant session cannot SELECT an unlinked or someone else's
//!   installation, nor read or write the singleton; ingress/operator GUC branches do what
//!   the migration says; a subscription cannot name another workspace's installation.
//!
//! `#[ignore]`: needs a real Postgres, same harness as `provider_limits_conformance_pg.rs`.

use std::io::Write;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_github::{ConvertError, ConvertedApp, GithubAppConverter, Plaintext};
use momo_server::config::{GithubAppSettings, SettingsConfig, T3Settings};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (same contract as provider_limits_conformance_pg.rs)
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "github-app-conformance-app-signing-secret";
const TEST_PROVIDER_MASTER_KEY: &str = "github-app-conformance-provider-master-key";
const TEST_GITHUB_MASTER_KEY: &str = "github-app-conformance-github-master-key";
const TEST_PASSWORD: &str = "github-app-conformance-password";
const PUBLIC_BASE: &str = "https://oort.example.test";

const PEM_MARKER: &str = "PEM-MARKER-GH-0001";
const WEBHOOK_MARKER: &str = "WHSEC-MARKER-GH-0002";
const CLIENT_SECRET_MARKER: &str = "CLIENT-SECRET-MARKER-GH-0003";
const MARKERS: [&str; 3] = [PEM_MARKER, WEBHOOK_MARKER, CLIENT_SECRET_MARKER];

fn pem(marker: &str) -> String {
    format!("-----BEGIN RSA PRIVATE KEY-----\n{marker}\n-----END RSA PRIVATE KEY-----")
}

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

/// One scripted GitHub: counts calls, answers with the markers (the real converter's
/// output type has no `client_secret`, so that marker can only ever be in GitHub's reply).
struct ScriptedConverter {
    calls: AtomicUsize,
    outcome: Mutex<Result<(), ConvertError>>,
    /// (login, type) GitHub reports as the new App's owner.
    owner: (&'static str, &'static str),
}

impl ScriptedConverter {
    fn ok() -> Arc<ScriptedConverter> {
        Arc::new(ScriptedConverter {
            calls: AtomicUsize::new(0),
            outcome: Mutex::new(Ok(())),
            owner: ("acme", "Organization"),
        })
    }

    fn owned_by(login: &'static str, kind: &'static str) -> Arc<ScriptedConverter> {
        Arc::new(ScriptedConverter {
            calls: AtomicUsize::new(0),
            outcome: Mutex::new(Ok(())),
            owner: (login, kind),
        })
    }

    fn failing(error: ConvertError) -> Arc<ScriptedConverter> {
        Arc::new(ScriptedConverter {
            calls: AtomicUsize::new(0),
            outcome: Mutex::new(Err(error)),
            owner: ("acme", "Organization"),
        })
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl GithubAppConverter for ScriptedConverter {
    async fn convert_manifest(&self, _code: &str) -> Result<ConvertedApp, ConvertError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        (*self.outcome.lock().unwrap())?;
        Ok(ConvertedApp {
            app_id: 424242,
            slug: "oort-test".to_string(),
            client_id: "Iv1.conformance".to_string(),
            owner_login: self.owner.0.to_string(),
            owner_type: self.owner.1.to_string(),
            pem: Plaintext::new(pem(PEM_MARKER)),
            webhook_secret: Plaintext::new(WEBHOOK_MARKER),
        })
    }
}

struct ServerOptions<'a> {
    operator_emails: &'a [&'a str],
    github_key: Option<&'a str>,
    public_base: Option<&'a str>,
    converter: Arc<dyn GithubAppConverter>,
}

async fn start_server(pool: PgPool, options: ServerOptions<'_>) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_settings(SettingsConfig {
        provider_link_master_key: Some(TEST_PROVIDER_MASTER_KEY.to_string()),
        env_provider: momo_settings::ProviderConfig::default(),
        platform_admin_emails: options
            .operator_emails
            .iter()
            .map(|email| email.to_ascii_lowercase())
            .collect(),
        environment: "local".to_string(),
    })
    .with_t3(T3Settings {
        public_base_url: options.public_base.map(str::to_string),
        ..T3Settings::default()
    })
    .with_github(GithubAppSettings {
        master_key: options.github_key.map(str::to_string),
    })
    .with_github_converter(options.converter);
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

struct Fixture {
    workspace: Uuid,
    member: Uuid,
    email: String,
}

/// One workspace with one verified-email owner.
async fn seed(su: &PgPool, slug_hint: &str) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{slug_hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let member = Uuid::new_v4();
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
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed workspace_membership");
    let email = format!("{member}@github-app.test");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(member)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human");
    Fixture {
        workspace,
        member,
        email,
    }
}

async fn login(http: &reqwest::Client, base: &str, fixture: &Fixture) -> String {
    let body: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": fixture.email,
            "password": TEST_PASSWORD,
            "workspace": fixture.workspace.to_string(),
        }))
        .send()
        .await
        .expect("login")
        .json()
        .await
        .expect("login body");
    body["accessToken"]
        .as_str()
        .expect("login returns an access token")
        .to_string()
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

async fn reset_github(su: &PgPool) {
    for table in [
        "github_channel_subscription",
        "github_receipt",
        "github_link_claim",
        "github_app_installation",
        "github_app",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(su)
            .await
            .unwrap_or_else(|error| panic!("reset {table}: {error}"));
    }
}

/// Everything the server said, kept so the marker test can scan it.
#[derive(Default)]
struct Seen(Vec<String>);

impl Seen {
    async fn record(&mut self, response: reqwest::Response) -> (u16, Option<String>, Value) {
        let status = response.status().as_u16();
        let headers = format!("{:?}", response.headers());
        let location = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let text = response.text().await.unwrap_or_default();
        self.0.push(headers);
        self.0.push(text.clone());
        let body = serde_json::from_str(&text).unwrap_or(Value::Null);
        (status, location, body)
    }

    fn assert_clean(&self) {
        for blob in &self.0 {
            for marker in MARKERS {
                assert!(
                    !blob.contains(marker),
                    "{marker} reached a response: {blob}"
                );
            }
        }
    }
}

fn state_from_registration_url(url: &str) -> String {
    let encoded = url
        .split("state=")
        .nth(1)
        .expect("registrationUrl carries state");
    // The token is `<uuid>.<hex>`: only `-`, `.`, alphanumerics, so no percent escapes.
    encoded.to_string()
}

#[derive(Clone, Default)]
struct SharedBuf(Arc<Mutex<Vec<u8>>>);

impl Write for SharedBuf {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// acceptance 8 — no key, no surface
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn without_the_master_key_the_github_surface_is_503_and_nothing_else_is() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_github(&su).await;
    let fixture = seed(&su, "gh503").await;
    let base = start_server(
        momo_app_pool().await,
        ServerOptions {
            operator_emails: &[&fixture.email],
            github_key: None,
            public_base: Some(PUBLIC_BASE),
            converter: ScriptedConverter::ok(),
        },
    )
    .await;
    let http = http();
    let token = login(&http, &base, &fixture).await;

    let get = http
        .get(format!("{base}/v1/integrations/github/app"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(get.status(), 503);
    let text = get.text().await.unwrap();
    assert!(text.contains("GITHUB_APP_MASTER_KEY"), "{text}");

    let post = http
        .post(format!("{base}/v1/integrations/github/app/manifest"))
        .bearer_auth(&token)
        .json(&json!({"ownerType": "user"}))
        .send()
        .await
        .unwrap();
    assert_eq!(post.status(), 503);

    let put = http
        .put(format!("{base}/v1/integrations/github/app"))
        .bearer_auth(&token)
        .json(&json!({
            "appId": 1, "slug": "x", "clientId": "c", "ownerLogin": "acme",
            "ownerType": "User", "privateKey": pem(PEM_MARKER), "webhookSecret": WEBHOOK_MARKER,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 503);

    // The unauthenticated redirect is closed too.
    let callback = http
        .get(format!(
            "{base}/v1/integrations/github/app/callback?code=abc&state=x"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(callback.status(), 503);

    // …while an unrelated instance-global family on the same operator is untouched.
    let provider = http
        .get(format!("{base}/v1/provider/link"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(provider.status(), 200, "the AI 연결 family must still work");
    let health = http.get(format!("{base}/healthz")).send().await.unwrap();
    assert_eq!(health.status(), 200);

    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM github_app")
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(rows, 0, "a 503 writes nothing");
}

// ---------------------------------------------------------------------------
// the manifest flow
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "current_thread")]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_manifest_flow_seals_inside_the_callback_and_leaks_nothing() {
    // Capture every log line this test's runtime emits (server tasks run on this thread).
    let logs = SharedBuf::default();
    let writer = logs.clone();
    let _guard = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish(),
    );

    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_github(&su).await;
    let fixture = seed(&su, "ghflow").await;
    let converter = ScriptedConverter::ok();
    let base = start_server(
        momo_app_pool().await,
        ServerOptions {
            operator_emails: &[&fixture.email],
            github_key: Some(TEST_GITHUB_MASTER_KEY),
            public_base: Some(PUBLIC_BASE),
            converter: converter.clone(),
        },
    )
    .await;
    let http = http();
    let token = login(&http, &base, &fixture).await;
    let mut seen = Seen::default();

    // Nothing registered yet.
    let (status, _, body) = seen
        .record(
            http.get(format!("{base}/v1/integrations/github/app"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap(),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["configured"], json!(false));
    assert_eq!(body["masterKeyConfigured"], json!(true));
    assert_eq!(body["publicAddressConfigured"], json!(true));
    // The status names the permission set it will ask for.
    assert_eq!(body["permissions"].as_object().unwrap().len(), 5);

    // Bad input is a 400, never a state row.
    for bad in [
        json!({"ownerType": "bot"}),
        json!({"ownerType": "organization"}),
        json!({"ownerType": "organization", "organization": "a/b"}),
    ] {
        let (status, _, _) = seen
            .record(
                http.post(format!("{base}/v1/integrations/github/app/manifest"))
                    .bearer_auth(&token)
                    .json(&bad)
                    .send()
                    .await
                    .unwrap(),
            )
            .await;
        assert_eq!(status, 400, "{bad}");
    }
    let claims: i64 = sqlx::query_scalar("SELECT count(*) FROM github_link_claim")
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(claims, 0);

    // Start: the manifest asks for exactly the five reads and carries a one-time state.
    let (status, _, started) = seen
        .record(
            http.post(format!("{base}/v1/integrations/github/app/manifest"))
                .bearer_auth(&token)
                .json(&json!({"ownerType": "organization", "organization": "acme"}))
                .send()
                .await
                .unwrap(),
        )
        .await;
    assert_eq!(status, 200, "{started}");
    let registration_url = started["registrationUrl"].as_str().unwrap();
    assert!(registration_url
        .starts_with("https://github.com/organizations/acme/settings/apps/new?state="));
    let permissions = started["manifest"]["default_permissions"]
        .as_object()
        .unwrap();
    let mut names: Vec<&str> = permissions.keys().map(String::as_str).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        ["checks", "contents", "issues", "metadata", "pull_requests"]
    );
    assert!(permissions.values().all(|level| level == "read"));
    assert_eq!(started["manifest"]["public"], json!(false));
    assert_eq!(
        started["manifest"]["request_oauth_on_install"],
        json!(false)
    );
    assert_eq!(
        started["manifest"]["redirect_url"],
        json!(format!("{PUBLIC_BASE}/v1/integrations/github/app/callback"))
    );
    let state = state_from_registration_url(registration_url);
    // Only the hash is stored.
    let stored: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM github_link_claim WHERE purpose = 'app_manifest' \
           AND state_hash = sha256($1::bytea)",
    )
    .bind(state.as_bytes())
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(stored, 1);
    let raw_in_db: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM github_link_claim WHERE convert_from(state_hash, 'LATIN1') LIKE '%' || $1 || '%'",
    )
    .bind(&state)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(raw_in_db, 0, "the raw state must not be stored");

    // A forged state (right shape, never minted) and a malformed one: no GitHub call.
    let forged = format!("{}.{}", fixture.workspace, "ab".repeat(32));
    for bad_state in [forged.as_str(), "garbage", ""] {
        let (status, location, _) = seen
            .record(
                http.get(format!(
                    "{base}/v1/integrations/github/app/callback?code=abc123&state={bad_state}"
                ))
                .send()
                .await
                .unwrap(),
            )
            .await;
        assert_eq!(status, 303);
        assert!(
            location
                .as_deref()
                .unwrap()
                .contains("githubApp=state_invalid"),
            "{location:?}"
        );
    }
    assert_eq!(converter.calls(), 0, "a bad state must never reach GitHub");

    // The real callback: spends the state, converts, seals, stores.
    let callback_url =
        format!("{base}/v1/integrations/github/app/callback?code=abc123&state={state}");
    let response = http.get(&callback_url).send().await.unwrap();
    assert_eq!(
        response
            .headers()
            .get("referrer-policy")
            .and_then(|v| v.to_str().ok()),
        Some("no-referrer")
    );
    let (status, location, _) = seen.record(response).await;
    assert_eq!(status, 303);
    assert_eq!(
        location.as_deref(),
        Some(&format!("{PUBLIC_BASE}/?githubApp=created")[..])
    );
    assert_eq!(converter.calls(), 1);

    // Replay of the same URL: the state is spent, GitHub is not called again.
    let (status, location, _) = seen
        .record(http.get(&callback_url).send().await.unwrap())
        .await;
    assert_eq!(status, 303);
    assert!(location.unwrap().contains("githubApp=state_invalid"));
    assert_eq!(converter.calls(), 1);

    // What is stored: sealed boxes that open ONLY under the GitHub master key, and nothing readable.
    let (pem_box, hook_box, source): (Vec<u8>, Vec<u8>, String) =
        sqlx::query_as("SELECT pem_ciphertext, webhook_secret_ciphertext, source FROM github_app")
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(source, "manifest");
    for sealed in [&pem_box, &hook_box] {
        assert_eq!(sealed[0], 0x01, "version byte leads the box");
        for marker in MARKERS {
            assert!(
                !sealed.windows(marker.len()).any(|w| w == marker.as_bytes()),
                "{marker} is stored in the clear"
            );
        }
        assert!(
            momo_settings::crypto::open_bearer(sealed, TEST_GITHUB_MASTER_KEY).is_err(),
            "the provider-link domain must not open a GitHub box"
        );
    }
    assert_eq!(
        momo_settings::github_app::open_github_webhook_secret(&hook_box, TEST_GITHUB_MASTER_KEY)
            .unwrap(),
        WEBHOOK_MARKER
    );
    assert!(
        momo_settings::github_app::open_github_webhook_secret(&hook_box, TEST_PROVIDER_MASTER_KEY)
            .is_err(),
        "another master key cannot open it"
    );
    // The slot is bound into the AEAD: the webhook opener is NOT a back door to the PEM column.
    assert!(
        momo_settings::github_app::open_github_webhook_secret(&pem_box, TEST_GITHUB_MASTER_KEY)
            .is_err(),
        "a PEM box must not open through the webhook-secret opener"
    );

    // The operator view now shows the App, without a single secret.
    let (status, _, body) = seen
        .record(
            http.get(format!("{base}/v1/integrations/github/app"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap(),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(body["configured"], json!(true));
    assert_eq!(body["app"]["slug"], "oort-test");
    assert_eq!(body["app"]["ownerLogin"], "acme");
    assert_eq!(body["app"]["source"], "manifest");
    assert_eq!(
        body["app"]["installUrl"],
        "https://github.com/apps/oort-test/installations/new"
    );

    // A second registration is refused up front.
    let (status, _, body) = seen
        .record(
            http.post(format!("{base}/v1/integrations/github/app/manifest"))
                .bearer_auth(&token)
                .json(&json!({"ownerType": "user"}))
                .send()
                .await
                .unwrap(),
        )
        .await;
    assert_eq!(status, 409, "{body}");

    // ---- acceptance 6: responses, audit rows, tables, logs ----
    seen.assert_clean();
    let audit: Vec<String> = sqlx::query_scalar(
        "SELECT to_jsonb(a)::text FROM audit_log a WHERE a.workspace_id = $1 AND a.action LIKE 'github_app.%'",
    )
    .bind(fixture.workspace)
    .fetch_all(&su)
    .await
    .unwrap();
    assert!(
        audit
            .iter()
            .any(|row| row.contains("github_app.registered")),
        "registration is audited: {audit:?}"
    );
    assert!(audit
        .iter()
        .any(|row| row.contains("github_app.manifest_started")));
    for row in &audit {
        for marker in MARKERS {
            assert!(!row.contains(marker), "{marker} in audit: {row}");
        }
    }
    for table in [
        "github_app",
        "github_app_installation",
        "github_link_claim",
        "github_channel_subscription",
        "github_receipt",
    ] {
        let rows: Vec<String> =
            sqlx::query_scalar(&format!("SELECT to_jsonb(t)::text FROM {table} t"))
                .fetch_all(&su)
                .await
                .unwrap();
        for row in rows {
            for marker in MARKERS {
                assert!(!row.contains(marker), "{marker} in {table}: {row}");
            }
        }
    }
    let secret_columns: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.columns \
          WHERE table_schema = 'public' AND table_name LIKE 'github_%' \
            AND column_name ILIKE '%client_secret%'",
    )
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(secret_columns, 0, "client_secret has no column anywhere");
    let logged = String::from_utf8_lossy(&logs.0.lock().unwrap()).to_string();
    assert!(
        logged.len() > 100,
        "the log capture saw nothing: {}",
        logged.len()
    );
    for marker in MARKERS {
        assert!(!logged.contains(marker), "{marker} reached a log line");
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_dead_state_or_a_failed_conversion_registers_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_github(&su).await;
    let fixture = seed(&su, "ghdead").await;
    let http = http();

    // -- expired state: the one-hour window is enforced in SQL --
    let converter = ScriptedConverter::ok();
    let base = start_server(
        momo_app_pool().await,
        ServerOptions {
            operator_emails: &[&fixture.email],
            github_key: Some(TEST_GITHUB_MASTER_KEY),
            public_base: Some(PUBLIC_BASE),
            converter: converter.clone(),
        },
    )
    .await;
    let token = login(&http, &base, &fixture).await;
    let start = |token: String, base: String| {
        let http = http.clone();
        async move {
            let started: Value = http
                .post(format!("{base}/v1/integrations/github/app/manifest"))
                .bearer_auth(token)
                .json(&json!({"ownerType": "user"}))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            state_from_registration_url(started["registrationUrl"].as_str().expect("url"))
        }
    };
    let state = start(token.clone(), base.clone()).await;
    sqlx::query("UPDATE github_link_claim SET expires_at = now() - interval '1 second'")
        .execute(&su)
        .await
        .unwrap();
    let response = http
        .get(format!(
            "{base}/v1/integrations/github/app/callback?code=abc&state={state}"
        ))
        .send()
        .await
        .unwrap();
    assert!(response
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("githubApp=state_invalid"));
    assert_eq!(converter.calls(), 0);

    // -- a minter who is no longer an operator: the state dies with the role --
    sqlx::query("DELETE FROM github_link_claim")
        .execute(&su)
        .await
        .unwrap();
    let state = start(token.clone(), base.clone()).await;
    sqlx::query("UPDATE workspace_membership SET role = 'member' WHERE member_id = $1")
        .bind(fixture.member)
        .execute(&su)
        .await
        .unwrap();
    let response = http
        .get(format!(
            "{base}/v1/integrations/github/app/callback?code=abc&state={state}"
        ))
        .send()
        .await
        .unwrap();
    assert!(response
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("githubApp=not_operator"));
    assert_eq!(
        converter.calls(),
        0,
        "a demoted minter never reaches GitHub"
    );
    sqlx::query("UPDATE workspace_membership SET role = 'owner' WHERE member_id = $1")
        .bind(fixture.member)
        .execute(&su)
        .await
        .unwrap();

    // -- GitHub rejects the code: nothing stored, the state is spent, a label is audited --
    let failing = ScriptedConverter::failing(ConvertError::CodeRejected);
    let base = start_server(
        momo_app_pool().await,
        ServerOptions {
            operator_emails: &[&fixture.email],
            github_key: Some(TEST_GITHUB_MASTER_KEY),
            public_base: Some(PUBLIC_BASE),
            converter: failing.clone(),
        },
    )
    .await;
    let token = login(&http, &base, &fixture).await;
    sqlx::query("DELETE FROM github_link_claim")
        .execute(&su)
        .await
        .unwrap();
    let state = start(token, base.clone()).await;
    let response = http
        .get(format!(
            "{base}/v1/integrations/github/app/callback?code=abc&state={state}"
        ))
        .send()
        .await
        .unwrap();
    assert!(response
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("githubApp=convert_code_rejected"));
    assert_eq!(failing.calls(), 1);
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM github_app")
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(rows, 0);
    let failed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 \
           AND action = 'github_app.registration_failed' AND detail->>'reason' = 'code_rejected'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(failed, 1, "the failure reason is audited as a label");
}

// ---------------------------------------------------------------------------
// the paste form
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_paste_form_is_write_only_and_rotates_with_an_overlap_window() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_github(&su).await;
    let operator = seed(&su, "ghpaste").await;
    let bystander = seed(&su, "ghbystander").await;
    let base = start_server(
        momo_app_pool().await,
        ServerOptions {
            operator_emails: &[&operator.email],
            github_key: Some(TEST_GITHUB_MASTER_KEY),
            public_base: None,
            converter: ScriptedConverter::ok(),
        },
    )
    .await;
    let http = http();
    let token = login(&http, &base, &operator).await;
    let mut seen = Seen::default();
    let body = |app_id: i64, secret: &str| {
        json!({
            "appId": app_id, "slug": "hand-made", "clientId": "Iv1.hand",
            "ownerLogin": "acme", "ownerType": "Organization",
            "privateKey": pem(PEM_MARKER), "webhookSecret": secret,
        })
    };
    let put = |token: &str, payload: Value| {
        let request = http
            .put(format!("{base}/v1/integrations/github/app"))
            .bearer_auth(token)
            .json(&payload);
        async move { request.send().await.unwrap() }
    };

    // A listed operator only: an ordinary workspace owner is refused.
    let other_token = login(&http, &base, &bystander).await;
    let (status, _, _) = seen
        .record(put(&other_token, body(7, WEBHOOK_MARKER)).await)
        .await;
    assert_eq!(status, 403);

    // Shape checks.
    for (bad, why) in [
        (
            json!({"appId": 0, "slug": "x", "clientId": "c", "ownerLogin": "acme", "ownerType": "User", "privateKey": pem(PEM_MARKER), "webhookSecret": "w"}),
            "appId",
        ),
        (
            json!({"appId": 1, "slug": "x y", "clientId": "c", "ownerLogin": "acme", "ownerType": "User", "privateKey": pem(PEM_MARKER), "webhookSecret": "w"}),
            "slug",
        ),
        (
            json!({"appId": 1, "slug": "x", "clientId": "c", "ownerLogin": "acme", "ownerType": "Bot", "privateKey": pem(PEM_MARKER), "webhookSecret": "w"}),
            "ownerType",
        ),
        (
            json!({"appId": 1, "slug": "x", "clientId": "c", "ownerLogin": "acme", "ownerType": "User", "privateKey": "not a pem", "webhookSecret": "w"}),
            "privateKey",
        ),
        (
            json!({"appId": 1, "slug": "x", "clientId": "c", "ownerLogin": "acme", "ownerType": "User", "privateKey": pem(PEM_MARKER), "webhookSecret": " "}),
            "webhookSecret",
        ),
    ] {
        let (status, _, body) = seen.record(put(&token, bad).await).await;
        assert_eq!(status, 400, "{why}: {body}");
    }
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM github_app")
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(rows, 0);

    // First paste: stored, echoed without secrets, no rotation window.
    let (status, _, first) = seen
        .record(put(&token, body(7, WEBHOOK_MARKER)).await)
        .await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["configured"], json!(true));
    assert_eq!(first["app"]["source"], "paste");
    assert_eq!(first["app"]["rotationWindowOpen"], json!(false));
    // The paste works without a public address (the status says so honestly).
    assert_eq!(first["publicAddressConfigured"], json!(false));

    // Same app, new webhook secret: the old one keeps verifying for the window.
    let (status, _, second) = seen
        .record(put(&token, body(7, "WHSEC-MARKER-GH-0002-b")).await)
        .await;
    assert_eq!(status, 200);
    assert_eq!(second["app"]["rotationWindowOpen"], json!(true));
    let (current, previous, until): (Vec<u8>, Option<Vec<u8>>, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as(
            "SELECT webhook_secret_ciphertext, webhook_secret_previous_ciphertext, previous_valid_until \
               FROM github_app",
        )
        .fetch_one(&su)
        .await
        .unwrap();
    let open = |sealed: &[u8]| {
        momo_settings::github_app::open_github_webhook_secret(sealed, TEST_GITHUB_MASTER_KEY)
            .unwrap()
    };
    assert_eq!(open(&current), "WHSEC-MARKER-GH-0002-b");
    assert_eq!(open(&previous.expect("previous kept")), WEBHOOK_MARKER);
    let hours = (until.expect("window set") - chrono::Utc::now()).num_minutes();
    assert!(
        (23 * 60..=24 * 60).contains(&hours),
        "window ~24h, got {hours} minutes"
    );

    // A different app id starts clean: the old app's secret verifies nothing for the new one.
    let (status, _, third) = seen
        .record(put(&token, body(8, "WHSEC-MARKER-GH-0002-c")).await)
        .await;
    assert_eq!(status, 200);
    assert_eq!(third["app"]["rotationWindowOpen"], json!(false));
    let previous: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT webhook_secret_previous_ciphertext FROM github_app")
            .fetch_one(&su)
            .await
            .unwrap();
    assert!(previous.is_none());

    seen.assert_clean();
    let audit: Vec<String> = sqlx::query_scalar(
        "SELECT to_jsonb(a)::text FROM audit_log a WHERE a.workspace_id = $1 AND a.action = 'github_app.pasted'",
    )
    .bind(operator.workspace)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(audit.len(), 3);
    for row in audit {
        for marker in MARKERS {
            assert!(!row.contains(marker), "{marker} in audit: {row}");
        }
    }
}

// ---------------------------------------------------------------------------
// RLS, as momo_app
// ---------------------------------------------------------------------------

/// Run `statement` as `momo_app` inside a transaction that sets exactly the given GUCs
/// (a tenant session sets only `app.workspace_id`). Returns rows affected or the DB error.
async fn as_app(pool: &PgPool, gucs: &[(&str, &str)], statement: &str) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    for (name, value) in gucs {
        sqlx::query("SELECT set_config($1, $2, true)")
            .bind(name)
            .bind(value)
            .execute(&mut *tx)
            .await?;
    }
    let result = sqlx::query(statement).execute(&mut *tx).await;
    let _ = tx.rollback().await;
    result.map(|r| r.rows_affected())
}

async fn count_as_app(pool: &PgPool, gucs: &[(&str, &str)], table: &str) -> i64 {
    let mut tx = pool.begin().await.unwrap();
    for (name, value) in gucs {
        sqlx::query("SELECT set_config($1, $2, true)")
            .bind(name)
            .bind(value)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let _ = tx.rollback().await;
    count
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn rls_hides_the_app_and_other_workspaces_installations_from_a_tenant_session() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_github(&su).await;
    let a = seed(&su, "ghrls-a").await;
    let b = seed(&su, "ghrls-b").await;
    let app = momo_app_pool().await;

    // Fixtures through the superuser (bypasses RLS).
    sqlx::query(
        "INSERT INTO github_app (app_id, slug, client_id, owner_login, owner_type, pem_ciphertext, \
           webhook_secret_ciphertext, source) VALUES (1, 's', 'c', 'acme', 'User', '\\x01aa', '\\x01bb', 'paste')",
    )
    .execute(&su)
    .await
    .unwrap();
    for (id, workspace) in [
        (101_i64, Some(a.workspace)),
        (102, Some(b.workspace)),
        (103, None),
    ] {
        sqlx::query(
            "INSERT INTO github_app_installation (installation_id, account_login, account_type, \
               repository_selection, workspace_id, linked_at) \
             VALUES ($1, $2, 'Organization', 'selected', $3, CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END)",
        )
        .bind(id)
        .bind(format!("acct-{id}"))
        .bind(workspace)
        .execute(&su)
        .await
        .unwrap();
    }

    let tenant_a = [("app.workspace_id", a.workspace.to_string())];
    let tenant_a: Vec<(&str, &str)> = tenant_a.iter().map(|(k, v)| (*k, v.as_str())).collect();

    // ---- github_app: invisible and unwritable to a tenant session ----
    assert_eq!(count_as_app(&app, &tenant_a, "github_app").await, 0);
    assert!(
        as_app(
            &app,
            &tenant_a,
            "INSERT INTO github_app (id, app_id, slug, client_id, owner_login, owner_type, pem_ciphertext, webhook_secret_ciphertext, source) \
             VALUES (true, 9, 's', 'c', 'x', 'User', '\\x01aa', '\\x01bb', 'paste')"
        )
        .await
        .is_err(),
        "tenant INSERT into github_app must be refused"
    );
    assert_eq!(
        as_app(&app, &tenant_a, "UPDATE github_app SET slug = 'hijack'")
            .await
            .unwrap(),
        0,
        "tenant UPDATE sees no row"
    );
    assert_eq!(
        as_app(&app, &tenant_a, "DELETE FROM github_app")
            .await
            .unwrap(),
        0,
        "tenant DELETE sees no row"
    );
    // The operator GUC opens it; the ingress GUC reads but cannot write.
    let operator = [
        ("app.workspace_id", a.workspace.to_string()),
        ("app.github_app_admin", "on".to_string()),
    ];
    let operator: Vec<(&str, &str)> = operator.iter().map(|(k, v)| (*k, v.as_str())).collect();
    assert_eq!(count_as_app(&app, &operator, "github_app").await, 1);
    let ingress = [("app.github_ingress", "on")];
    assert_eq!(count_as_app(&app, &ingress, "github_app").await, 1);
    assert_eq!(
        as_app(&app, &ingress, "UPDATE github_app SET slug = 'hijack'")
            .await
            .unwrap(),
        0,
        "ingress cannot write the singleton"
    );
    assert!(as_app(
        &app,
        &ingress,
        "INSERT INTO github_app (id, app_id, slug, client_id, owner_login, owner_type, pem_ciphertext, webhook_secret_ciphertext, source) \
         VALUES (true, 9, 's', 'c', 'x', 'User', '\\x01aa', '\\x01bb', 'paste')"
    )
    .await
    .is_err());
    // A wrong value of the GUC opens nothing.
    assert_eq!(
        count_as_app(&app, &[("app.github_app_admin", "yes")], "github_app").await,
        0
    );

    // ---- github_app_installation ----
    // Tenant A sees ONLY its own linked row: not workspace B's, not the unlinked one.
    let mut tx = app.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(a.workspace.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let visible: Vec<i64> =
        sqlx::query_scalar("SELECT installation_id FROM github_app_installation ORDER BY 1")
            .fetch_all(&mut *tx)
            .await
            .unwrap();
    let _ = tx.rollback().await;
    assert_eq!(visible, vec![101]);
    // …and cannot write any (no tenant INSERT/UPDATE policy; no DELETE policy for anyone).
    assert!(as_app(
        &app,
        &tenant_a,
        "INSERT INTO github_app_installation (installation_id, account_login, account_type, repository_selection) \
         VALUES (999, 'x', 'User', 'all')"
    )
    .await
    .is_err());
    assert_eq!(
        as_app(
            &app,
            &tenant_a,
            "UPDATE github_app_installation SET account_login = 'x'"
        )
        .await
        .unwrap(),
        0,
        "a tenant UPDATE matches no row (no policy)"
    );
    // Link-stealing: a tenant cannot adopt the unlinked installation.
    assert_eq!(
        as_app(
            &app,
            &tenant_a,
            "UPDATE github_app_installation SET workspace_id = (SELECT current_setting('app.workspace_id')::uuid), linked_at = now() \
             WHERE installation_id = 103"
        )
        .await
        .unwrap(),
        0
    );
    // Nobody can DELETE (no policy): even operator and ingress match zero rows.
    for gucs in [&operator[..], &ingress[..]] {
        assert_eq!(
            as_app(&app, gucs, "DELETE FROM github_app_installation")
                .await
                .unwrap(),
            0
        );
    }
    // Operator sees all three and may link; ingress sees all, inserts and updates.
    assert_eq!(
        count_as_app(&app, &operator, "github_app_installation").await,
        3
    );
    assert_eq!(
        count_as_app(&app, &ingress, "github_app_installation").await,
        3
    );
    assert_eq!(
        as_app(
            &app,
            &operator,
            "UPDATE github_app_installation SET workspace_id = current_setting('app.workspace_id')::uuid, linked_at = now() WHERE installation_id = 103"
        )
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        as_app(
            &app,
            &ingress,
            "INSERT INTO github_app_installation (installation_id, account_login, account_type, repository_selection) \
             VALUES (555, 'new-acct', 'User', 'all')"
        )
        .await
        .unwrap(),
        1
    );
    // The operator branch does NOT admit inserts (only signed ingress creates installation rows).
    assert!(as_app(
        &app,
        &operator,
        "INSERT INTO github_app_installation (installation_id, account_login, account_type, repository_selection) \
         VALUES (556, 'forged', 'User', 'all')"
    )
    .await
    .is_err());
    // The pairing CHECK: a workspace without a link time is not a row.
    assert!(sqlx::query(
        "INSERT INTO github_app_installation (installation_id, account_login, account_type, repository_selection, workspace_id) \
         VALUES (557, 'x', 'User', 'all', $1)"
    )
    .bind(a.workspace)
    .execute(&su)
    .await
    .is_err());

    // ---- tenant tables: ws_isolation ----
    let channel_a = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', 'gh-a')",
    )
    .bind(channel_a)
    .bind(a.workspace)
    .execute(&su)
    .await
    .expect("seed channel A");
    let channel_b = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', 'gh-b')",
    )
    .bind(channel_b)
    .bind(b.workspace)
    .execute(&su)
    .await
    .expect("seed channel B");

    // A subscribes to ITS installation (101): ok.
    let subscribe = |workspace: Uuid, channel: Uuid, installation: i64| {
        format!(
            "INSERT INTO github_channel_subscription (workspace_id, channel_id, installation_id, repo_full_name) \
             VALUES ('{workspace}', '{channel}', {installation}, 'acme/repo')"
        )
    };
    assert_eq!(
        as_app(&app, &tenant_a, &subscribe(a.workspace, channel_a, 101))
            .await
            .unwrap(),
        1
    );
    // A names workspace B's installation (102) or the unlinked one (103→ now linked to A by the
    // rolled-back update above, so use 555 which is unlinked): refused by the guard trigger.
    for foreign in [102_i64, 555] {
        let error = as_app(&app, &tenant_a, &subscribe(a.workspace, channel_a, foreign))
            .await
            .expect_err("a subscription may only name an installation linked to its own workspace");
        assert!(
            error.to_string().contains("own workspace"),
            "installation {foreign}: {error}"
        );
    }
    // A cannot write rows for workspace B (ws_isolation WITH CHECK).
    assert!(
        as_app(&app, &tenant_a, &subscribe(b.workspace, channel_b, 102))
            .await
            .is_err()
    );
    // Unknown feature names are refused by the CHECK.
    assert!(as_app(
        &app,
        &tenant_a,
        &format!(
            "INSERT INTO github_channel_subscription (workspace_id, channel_id, installation_id, repo_full_name, features) \
             VALUES ('{}', '{channel_a}', 101, 'acme/other', ARRAY['pulls','admin'])",
            a.workspace
        )
    )
    .await
    .is_err());

    // Claims and receipts are workspace-scoped.
    sqlx::query(
        "INSERT INTO github_link_claim (workspace_id, member_id, purpose, state_hash, expires_at) \
         VALUES ($1, $2, 'app_manifest', sha256('a'::bytea), now() + interval '1 hour')",
    )
    .bind(b.workspace)
    .bind(b.member)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO github_receipt (workspace_id, delivery_id, installation_id, event) VALUES ($1, 'd-1', 102, 'issues')",
    )
    .bind(b.workspace)
    .execute(&su)
    .await
    .unwrap();
    assert_eq!(count_as_app(&app, &tenant_a, "github_link_claim").await, 0);
    assert_eq!(count_as_app(&app, &tenant_a, "github_receipt").await, 0);
    let tenant_b = [("app.workspace_id", b.workspace.to_string())];
    let tenant_b: Vec<(&str, &str)> = tenant_b.iter().map(|(k, v)| (*k, v.as_str())).collect();
    assert_eq!(count_as_app(&app, &tenant_b, "github_link_claim").await, 1);
    assert_eq!(count_as_app(&app, &tenant_b, "github_receipt").await, 1);
    // (workspace_id, delivery_id) is the idempotence key.
    assert!(as_app(
        &app,
        &tenant_b,
        &format!(
            "INSERT INTO github_receipt (workspace_id, delivery_id, installation_id, event) VALUES ('{}', 'd-1', 102, 'issues')",
            b.workspace
        )
    )
    .await
    .is_err());
    // A manifest claim cannot carry an installation id.
    assert!(sqlx::query(
        "INSERT INTO github_link_claim (workspace_id, member_id, purpose, state_hash, installation_id, expires_at) \
         VALUES ($1, $2, 'app_manifest', sha256('z'::bytea), 1, now() + interval '1 hour')"
    )
    .bind(a.workspace)
    .bind(a.member)
    .execute(&su)
    .await
    .is_err());
}

// ---------------------------------------------------------------------------
// state binding, concurrency, operator gate (independent review M1, test gaps)
// ---------------------------------------------------------------------------

async fn start_flow(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    body: Value,
) -> (String, Value) {
    let started: Value = http
        .post(format!("{base}/v1/integrations/github/app/manifest"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    (
        state_from_registration_url(started["registrationUrl"].as_str().expect("url")),
        started,
    )
}

fn location_of(response: &reqwest::Response) -> String {
    response
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_state_cannot_be_paired_with_an_app_made_under_another_account() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_github(&su).await;
    let fixture = seed(&su, "ghowner").await;
    let http = http();

    // The operator asked for the organization `acme`; GitHub's reply says `evil-corp`.
    let wrong_login = ScriptedConverter::owned_by("evil-corp", "Organization");
    let base = start_server(
        momo_app_pool().await,
        ServerOptions {
            operator_emails: &[&fixture.email],
            github_key: Some(TEST_GITHUB_MASTER_KEY),
            public_base: Some(PUBLIC_BASE),
            converter: wrong_login.clone(),
        },
    )
    .await;
    let token = login(&http, &base, &fixture).await;
    let (state, _) = start_flow(
        &http,
        &base,
        &token,
        json!({"ownerType": "organization", "organization": "acme"}),
    )
    .await;
    let response = http
        .get(format!(
            "{base}/v1/integrations/github/app/callback?code=abc&state={state}"
        ))
        .send()
        .await
        .unwrap();
    assert!(
        location_of(&response).contains("githubApp=owner_mismatch"),
        "{}",
        location_of(&response)
    );
    assert_eq!(wrong_login.calls(), 1);
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM github_app")
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(
        rows, 0,
        "an App under someone else's account is never stored"
    );
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 \
           AND action = 'github_app.registration_failed' AND detail->>'reason' = 'owner_mismatch'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(audited, 1);

    // A personal-account flow does not accept an organization-owned App either.
    sqlx::query("DELETE FROM github_link_claim")
        .execute(&su)
        .await
        .unwrap();
    let wrong_type = ScriptedConverter::owned_by("acme", "Organization");
    let base = start_server(
        momo_app_pool().await,
        ServerOptions {
            operator_emails: &[&fixture.email],
            github_key: Some(TEST_GITHUB_MASTER_KEY),
            public_base: Some(PUBLIC_BASE),
            converter: wrong_type.clone(),
        },
    )
    .await;
    let token = login(&http, &base, &fixture).await;
    let (state, _) = start_flow(&http, &base, &token, json!({"ownerType": "user"})).await;
    let response = http
        .get(format!(
            "{base}/v1/integrations/github/app/callback?code=abc&state={state}"
        ))
        .send()
        .await
        .unwrap();
    assert!(location_of(&response).contains("githubApp=owner_mismatch"));

    // Control: the matching account (case-insensitive login) registers.
    sqlx::query("DELETE FROM github_link_claim")
        .execute(&su)
        .await
        .unwrap();
    let matching = ScriptedConverter::owned_by("ACME", "Organization");
    let base = start_server(
        momo_app_pool().await,
        ServerOptions {
            operator_emails: &[&fixture.email],
            github_key: Some(TEST_GITHUB_MASTER_KEY),
            public_base: Some(PUBLIC_BASE),
            converter: matching.clone(),
        },
    )
    .await;
    let token = login(&http, &base, &fixture).await;
    let (state, _) = start_flow(
        &http,
        &base,
        &token,
        json!({"ownerType": "organization", "organization": "acme"}),
    )
    .await;
    let response = http
        .get(format!(
            "{base}/v1/integrations/github/app/callback?code=abc&state={state}"
        ))
        .send()
        .await
        .unwrap();
    assert!(location_of(&response).contains("githubApp=created"));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn two_simultaneous_callbacks_on_one_state_register_exactly_once() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_github(&su).await;
    let fixture = seed(&su, "ghrace").await;
    let converter = ScriptedConverter::ok();
    let base = start_server(
        momo_app_pool().await,
        ServerOptions {
            operator_emails: &[&fixture.email],
            github_key: Some(TEST_GITHUB_MASTER_KEY),
            public_base: Some(PUBLIC_BASE),
            converter: converter.clone(),
        },
    )
    .await;
    let http = http();
    let token = login(&http, &base, &fixture).await;
    let (state, _) = start_flow(
        &http,
        &base,
        &token,
        json!({"ownerType": "organization", "organization": "acme"}),
    )
    .await;
    let url = format!("{base}/v1/integrations/github/app/callback?code=abc&state={state}");
    let (a, b, c, d) = tokio::join!(
        http.get(&url).send(),
        http.get(&url).send(),
        http.get(&url).send(),
        http.get(&url).send()
    );
    let outcomes: Vec<String> = [a, b, c, d]
        .into_iter()
        .map(|r| location_of(&r.unwrap()))
        .collect();
    assert_eq!(
        outcomes
            .iter()
            .filter(|l| l.contains("githubApp=created"))
            .count(),
        1,
        "{outcomes:?}"
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|l| l.contains("githubApp=state_invalid"))
            .count(),
        3,
        "{outcomes:?}"
    );
    assert_eq!(converter.calls(), 1, "GitHub's one-time code is spent once");
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM github_app")
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(rows, 1);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn only_a_listed_instance_operator_reaches_the_operator_routes() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_github(&su).await;
    let operator = seed(&su, "ghop").await;
    let owner_not_listed = seed(&su, "ghnotlisted").await;
    let base = start_server(
        momo_app_pool().await,
        ServerOptions {
            operator_emails: &[&operator.email],
            github_key: Some(TEST_GITHUB_MASTER_KEY),
            public_base: Some(PUBLIC_BASE),
            converter: ScriptedConverter::ok(),
        },
    )
    .await;
    let http = http();
    let token = login(&http, &base, &owner_not_listed).await;
    let get = http
        .get(format!("{base}/v1/integrations/github/app"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        get.status(),
        403,
        "an ordinary workspace owner is not an instance operator"
    );
    let post = http
        .post(format!("{base}/v1/integrations/github/app/manifest"))
        .bearer_auth(&token)
        .json(&json!({"ownerType": "user"}))
        .send()
        .await
        .unwrap();
    assert_eq!(post.status(), 403);
    // No bearer at all: the authenticated routes are not reachable anonymously.
    for request in [
        http.get(format!("{base}/v1/integrations/github/app")),
        http.post(format!("{base}/v1/integrations/github/app/manifest"))
            .json(&json!({"ownerType": "user"})),
    ] {
        assert_eq!(request.send().await.unwrap().status(), 401);
    }
    let claims: i64 = sqlx::query_scalar("SELECT count(*) FROM github_link_claim")
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(claims, 0, "a refused caller mints no state");
}
