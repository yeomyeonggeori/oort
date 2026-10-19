//! #3954 E-GH2 (ADR-0205 D3·D4·D5·D6) — receiving GitHub events, linking an installation and
//! subscribing channels, through the real routes and the real `momo_app` role.
//!
//! One named test per acceptance row:
//!
//! * 1  `a_bad_or_missing_signature_is_401_and_writes_nothing`
//! * 2  `a_redelivered_delivery_is_a_duplicate_and_the_channel_has_one_message`
//! * 3  `a_link_needs_both_signals_in_either_order_and_never_from_a_forgery`
//! * 4  `an_installation_belongs_to_one_workspace_and_events_never_cross_tenants`
//! * 5  `suspend_and_delete_silence_a_channel_and_unsuspend_restores_it`
//! * 9  `an_oversize_body_is_413_a_ping_is_200_and_an_unknown_event_is_200_with_no_message`
//! * 10 `the_previous_webhook_secret_verifies_only_inside_the_overlap_window`
//! * 11 `a_private_repository_needs_an_explicit_confirmation_for_a_public_channel`
//! * 13 `commits_and_releases_reach_only_the_channels_that_turned_them_on`
//!
//! and the supporting rows: the operator-only unlinked list, the per-installation rate budget with
//! its one audit row, the 503 without the master key, and RLS on the migration-142 tables as
//! `momo_app`.
//!
//! `#[ignore]`: needs a real Postgres, same harness as `github_app_conformance_pg.rs`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_github::{ConvertError, ConvertedApp, GithubAppConverter};
use momo_server::config::{GithubAppSettings, SettingsConfig, T3Settings, WebhookSettings};
use momo_server::{build_app, AppState};
use momo_webhook::github_signature;
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "github-ingress-conformance-app-signing-secret";
const TEST_PROVIDER_MASTER_KEY: &str = "github-ingress-conformance-provider-master-key";
const TEST_GITHUB_MASTER_KEY: &str = "github-ingress-conformance-github-master-key";
const TEST_PASSWORD: &str = "github-ingress-conformance-password";
const PUBLIC_BASE: &str = "https://oort.example.test";
const SECRET_1: &str = "WHSEC-KNOWN-ONE-0001";
const SECRET_2: &str = "WHSEC-KNOWN-TWO-0002";

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

/// Phase 1 makes no outbound call from the receiver; the converter is never reached here.
struct NoConverter;

#[async_trait]
impl GithubAppConverter for NoConverter {
    async fn convert_manifest(&self, _code: &str) -> Result<ConvertedApp, ConvertError> {
        Err(ConvertError::Unreachable)
    }
}

struct ServerOptions<'a> {
    operator_emails: &'a [&'a str],
    github_key: Option<&'a str>,
    per_installation_limit: u32,
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
        public_base_url: Some(PUBLIC_BASE.to_string()),
        ..T3Settings::default()
    })
    .with_webhook(WebhookSettings {
        per_installation_limit: options.per_installation_limit,
        ..WebhookSettings::default()
    })
    .with_github(GithubAppSettings {
        master_key: options.github_key.map(str::to_string),
    })
    .with_github_converter(Arc::new(NoConverter));
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
    let email = format!("{member}@github-ingress.test");
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
        "github_installation_repository",
        "github_workspace_author",
        "github_app_installation",
        "github_app_public",
        "github_app",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(su)
            .await
            .unwrap_or_else(|error| panic!("reset {table}: {error}"));
    }
}

fn pem() -> String {
    "-----BEGIN RSA PRIVATE KEY-----\nPEM-MARKER-INGRESS\n-----END RSA PRIVATE KEY-----".to_string()
}

/// Everything one test needs: two workspaces (A is also the instance operator), a server with a
/// registered App whose webhook secret the test knows.
struct Env {
    su: PgPool,
    base: String,
    http: reqwest::Client,
    a: Fixture,
    b: Fixture,
    token_a: String,
    token_b: String,
}

async fn env_with(limit: u32, register_app: bool) -> Env {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_github(&su).await;
    let a = seed(&su, "ghin-a").await;
    let b = seed(&su, "ghin-b").await;
    let base = start_server(
        momo_app_pool().await,
        ServerOptions {
            operator_emails: &[&a.email],
            github_key: Some(TEST_GITHUB_MASTER_KEY),
            per_installation_limit: limit,
        },
    )
    .await;
    let http = http();
    let token_a = login(&http, &base, &a).await;
    let token_b = login(&http, &base, &b).await;
    let env = Env {
        su,
        base,
        http,
        a,
        b,
        token_a,
        token_b,
    };
    if register_app {
        env.paste_secret(SECRET_1).await;
    }
    env
}

async fn env() -> Env {
    env_with(1000, true).await
}

impl Env {
    async fn paste_secret(&self, secret: &str) {
        let response = self
            .http
            .put(format!("{}/v1/integrations/github/app", self.base))
            .bearer_auth(&self.token_a)
            .json(&json!({
                "appId": 31337,
                "slug": "oort-test",
                "clientId": "Iv1.ingress",
                "ownerLogin": "acme",
                "ownerType": "Organization",
                "privateKey": pem(),
                "webhookSecret": secret,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "paste the App");
    }

    /// POST a signed delivery. `secret = None` sends no signature header at all.
    async fn deliver(
        &self,
        event: &str,
        delivery: &str,
        payload: &Value,
        secret: Option<&str>,
    ) -> (u16, Value) {
        let body = serde_json::to_vec(payload).unwrap();
        self.deliver_raw(
            event,
            delivery,
            body,
            secret.map(|s| {
                format!(
                    "sha256={}",
                    github_signature(s, &serde_json::to_vec(payload).unwrap())
                )
            }),
        )
        .await
    }

    async fn deliver_raw(
        &self,
        event: &str,
        delivery: &str,
        body: Vec<u8>,
        signature: Option<String>,
    ) -> (u16, Value) {
        let mut request = self
            .http
            .post(format!("{}/v1/integrations/github/webhook", self.base))
            .header("x-github-event", event)
            .header("x-github-delivery", delivery)
            .header("content-type", "application/json")
            .body(body);
        if let Some(signature) = signature {
            request = request.header("x-hub-signature-256", signature);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn channel(&self, workspace: Uuid, kind: &str, name: &str) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, $3::channel_kind, $4)")
            .bind(id)
            .bind(workspace)
            .bind(kind)
            .bind(format!("{name}-{id}"))
            .execute(&self.su)
            .await
            .expect("seed channel");
        sqlx::query(
            "INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)",
        )
        .bind(id)
        .bind(workspace)
        .execute(&self.su)
        .await
        .expect("seed channel_seq");
        id
    }

    async fn messages(&self, channel: Uuid) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
            .bind(channel)
            .fetch_one(&self.su)
            .await
            .unwrap()
    }

    async fn count(&self, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&self.su)
            .await
            .unwrap()
    }

    async fn link_state(&self, token: &str, workspace: Uuid) -> String {
        let response = self
            .http
            .post(format!(
                "{}/v1/workspaces/{workspace}/github/link",
                self.base
            ))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "mint an install state");
        let body: Value = response.json().await.unwrap();
        let url = body["installUrl"].as_str().unwrap();
        assert!(url.starts_with("https://github.com/apps/oort-test/installations/new?state="));
        url.split("state=").nth(1).unwrap().to_string()
    }

    async fn setup(&self, installation: i64, state: &str) -> (u16, Option<String>) {
        let response = self
            .http
            .get(format!(
                "{}/v1/integrations/github/setup?installation_id={installation}&setup_action=install&state={state}",
                self.base
            ))
            .send()
            .await
            .unwrap();
        let location = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        (response.status().as_u16(), location)
    }

    async fn installation_workspace(&self, installation: i64) -> Option<Option<Uuid>> {
        sqlx::query_scalar(
            "SELECT workspace_id FROM github_app_installation WHERE installation_id = $1",
        )
        .bind(installation)
        .fetch_optional(&self.su)
        .await
        .unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    async fn subscribe(
        &self,
        token: &str,
        workspace: Uuid,
        channel: Uuid,
        installation: i64,
        repository: &str,
        features: Option<&[&str]>,
        confirm: bool,
    ) -> (u16, Value) {
        let mut body = json!({
            "channelId": channel.to_string(),
            "installationId": installation,
            "repository": repository,
            "confirmPrivate": confirm,
        });
        if let Some(features) = features {
            body["features"] = json!(features);
        }
        let response = self
            .http
            .post(format!(
                "{}/v1/workspaces/{workspace}/github/subscriptions",
                self.base
            ))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    /// Full D3 flow for workspace A: mint state, hit the setup URL, then the signed event.
    async fn link_a(&self, installation: i64, repos: &[(i64, &str, bool)]) {
        let state = self.link_state(&self.token_a, self.a.workspace).await;
        self.setup(installation, &state).await;
        let (status, _) = self
            .deliver(
                "installation",
                &format!("link-{installation}-{}", Uuid::new_v4()),
                &installation_created(installation, "acme", repos),
                Some(SECRET_1),
            )
            .await;
        assert_eq!(status, 200);
        assert_eq!(
            self.installation_workspace(installation).await,
            Some(Some(self.a.workspace)),
            "the two signals linked the installation"
        );
    }
}

// ---------------------------------------------------------------------------
// payload builders
// ---------------------------------------------------------------------------

fn installation_created(id: i64, login: &str, repos: &[(i64, &str, bool)]) -> Value {
    json!({
        "action": "created",
        "installation": {
            "id": id,
            "account": {"login": login, "type": "Organization"},
            "repository_selection": "selected",
        },
        "repositories": repos
            .iter()
            .map(|(id, name, private)| json!({"id": id, "full_name": name, "private": private}))
            .collect::<Vec<_>>(),
        "sender": {"login": "installer"},
    })
}

fn installation_action(id: i64, action: &str) -> Value {
    json!({
        "action": action,
        "installation": {
            "id": id,
            "account": {"login": "acme", "type": "Organization"},
            "repository_selection": "selected",
        },
        "sender": {"login": "installer"},
    })
}

fn pull_request_opened(installation: i64, repo: (i64, &str), number: i64) -> Value {
    json!({
        "action": "opened",
        "installation": {"id": installation},
        "sender": {"login": "alice"},
        "repository": {"id": repo.0, "full_name": repo.1, "html_url": format!("https://github.com/{}", repo.1), "default_branch": "main"},
        "pull_request": {
            "number": number, "title": format!("Change {number}"),
            "html_url": format!("https://github.com/{}/pull/{number}", repo.1),
            "draft": false, "merged": false
        },
    })
}

fn push_event(installation: i64, repo: (i64, &str)) -> Value {
    json!({
        "ref": "refs/heads/main", "deleted": false,
        "installation": {"id": installation},
        "sender": {"login": "erin"}, "pusher": {"name": "erin"},
        "compare": format!("https://github.com/{}/compare/a...b", repo.1),
        "repository": {"id": repo.0, "full_name": repo.1, "default_branch": "main"},
        "commits": [{"message": "ship it"}],
    })
}

fn release_published(installation: i64, repo: (i64, &str)) -> Value {
    json!({
        "action": "published",
        "installation": {"id": installation},
        "sender": {"login": "fay"},
        "repository": {"id": repo.0, "full_name": repo.1},
        "release": {"tag_name": "v1.0.0", "name": "First", "draft": false,
                    "html_url": format!("https://github.com/{}/releases/tag/v1.0.0", repo.1)},
    })
}

// ---------------------------------------------------------------------------
// acceptance 1 — signature
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_bad_or_missing_signature_is_401_and_writes_nothing() {
    let env = env().await;
    env.link_a(901, &[(1, "acme/widgets", false)]).await;
    let channel = env.channel(env.a.workspace, "public", "gh-sig").await;
    let (status, _) = env
        .subscribe(
            &env.token_a,
            env.a.workspace,
            channel,
            901,
            "acme/widgets",
            None,
            false,
        )
        .await;
    assert_eq!(status, 200);

    let receipts = env.count("github_receipt").await;
    let installs = env.count("github_app_installation").await;
    let messages = env.messages(channel).await;
    let payload = pull_request_opened(901, (1, "acme/widgets"), 7);
    let body = serde_json::to_vec(&payload).unwrap();
    let good = format!("sha256={}", github_signature(SECRET_1, &body));

    // Control: the same request with the right signature is accepted, so the 401s below are
    // the signature check and nothing else.
    let (control, response) = env
        .deliver_raw(
            "pull_request",
            "sig-control",
            body.clone(),
            Some(good.clone()),
        )
        .await;
    assert_eq!((control, response["delivered"].as_u64()), (200, Some(1)));

    let wrong_secret = format!("sha256={}", github_signature("not-the-secret", &body));
    let tampered = format!("sha256={}", github_signature(SECRET_1, b"{}"));
    let sha1_form = good.replace("sha256=", "sha1=");
    let bare = good.trim_start_matches("sha256=").to_string();
    let truncated = good[..good.len() - 2].to_string();
    for (label, signature) in [
        ("missing", None),
        ("wrong secret", Some(wrong_secret)),
        ("signature of another body", Some(tampered)),
        ("sha1 form", Some(sha1_form)),
        ("no scheme prefix", Some(bare)),
        ("truncated", Some(truncated)),
        ("empty", Some(String::new())),
    ] {
        let (status, _) = env
            .deliver_raw(
                "pull_request",
                &format!("sig-{}", label.replace(' ', "-")),
                body.clone(),
                signature,
            )
            .await;
        assert_eq!(status, 401, "{label}");
    }
    assert_eq!(
        env.count("github_receipt").await,
        receipts + 1,
        "only the control left a receipt"
    );
    assert_eq!(env.count("github_app_installation").await, installs);
    assert_eq!(
        env.messages(channel).await,
        messages + 1,
        "only the control posted"
    );

    // An unsigned `installation.created` must not create a routing row either.
    let (status, _) = env
        .deliver_raw(
            "installation",
            "sig-install",
            serde_json::to_vec(&installation_created(902, "evil", &[])).unwrap(),
            None,
        )
        .await;
    assert_eq!(status, 401);
    assert_eq!(
        env.installation_workspace(902).await,
        None,
        "no row from an unsigned event"
    );
}

// ---------------------------------------------------------------------------
// acceptance 2 — replay
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_redelivered_delivery_is_a_duplicate_and_the_channel_has_one_message() {
    let env = env().await;
    env.link_a(911, &[(2, "acme/api", false)]).await;
    let channel = env.channel(env.a.workspace, "public", "gh-dup").await;
    let (status, _) = env
        .subscribe(
            &env.token_a,
            env.a.workspace,
            channel,
            911,
            "acme/api",
            None,
            false,
        )
        .await;
    assert_eq!(status, 200);

    let payload = pull_request_opened(911, (2, "acme/api"), 1);
    let (first, body) = env
        .deliver("pull_request", "dup-1", &payload, Some(SECRET_1))
        .await;
    assert_eq!(first, 200);
    assert_eq!(
        (body["duplicate"].as_bool(), body["delivered"].as_u64()),
        (Some(false), Some(1))
    );
    let (again, body) = env
        .deliver("pull_request", "dup-1", &payload, Some(SECRET_1))
        .await;
    assert_eq!(again, 200);
    assert_eq!(body["duplicate"], json!(true));
    assert_eq!(
        env.messages(channel).await,
        1,
        "the same delivery posts once"
    );

    // A different delivery of the same event is a new message.
    let (_, body) = env
        .deliver("pull_request", "dup-2", &payload, Some(SECRET_1))
        .await;
    assert_eq!(body["delivered"].as_u64(), Some(1));
    assert_eq!(env.messages(channel).await, 2);

    // The author is the workspace's dedicated, non-login 「GitHub」 member, not a person.
    let (kind, name, humans): (String, String, i64) = sqlx::query_as(
        "SELECT m.kind::text, m.display_name, \
                (SELECT count(*) FROM human h WHERE h.member_id = m.id) \
           FROM message x JOIN member m ON m.id = x.author_member_id \
          WHERE x.channel_id = $1 LIMIT 1",
    )
    .bind(channel)
    .fetch_one(&env.su)
    .await
    .unwrap();
    assert_eq!(
        (kind.as_str(), name.as_str(), humans),
        ("agent", "GitHub", 0)
    );
    let text: String =
        sqlx::query_scalar("SELECT body FROM message WHERE channel_id = $1 ORDER BY seq LIMIT 1")
            .bind(channel)
            .fetch_one(&env.su)
            .await
            .unwrap();
    assert!(text.contains("@alice님이 PR을 열었어요"), "{text}");
}

// ---------------------------------------------------------------------------
// acceptance 3 — two signals, exactly one link
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_link_needs_both_signals_in_either_order_and_never_from_a_forgery() {
    let env = env().await;

    // (a) setup URL first, then the signed event.
    let state = env.link_state(&env.token_a, env.a.workspace).await;
    let (status, location) = env.setup(1001, &state).await;
    assert_eq!(status, 303);
    assert!(
        location.unwrap().contains("githubInstall=pending"),
        "setup alone only pends"
    );
    assert_eq!(
        env.installation_workspace(1001).await,
        None,
        "no signed event: nothing linked"
    );
    let (status, _) = env
        .deliver(
            "installation",
            "order-a",
            &installation_created(1001, "acme", &[]),
            Some(SECRET_1),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        env.installation_workspace(1001).await,
        Some(Some(env.a.workspace))
    );
    let linked_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'github.installation_linked' AND workspace_id = $1",
    )
    .bind(env.a.workspace)
    .fetch_one(&env.su)
    .await
    .unwrap();
    assert_eq!(linked_audits, 1, "exactly one link");
    // The signed event repeated under a new delivery id changes nothing.
    env.deliver(
        "installation",
        "order-a-again",
        &installation_created(1001, "acme", &[]),
        Some(SECRET_1),
    )
    .await;
    let linked_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'github.installation_linked' AND workspace_id IN ($1, $2)",
    )
    .bind(env.a.workspace)
    .bind(env.b.workspace)
    .fetch_one(&env.su)
    .await
    .unwrap();
    assert_eq!(linked_audits, 1);

    // (b) signed event first (a row without a workspace), then the setup URL.
    env.deliver(
        "installation",
        "order-b",
        &installation_created(1002, "beta", &[]),
        Some(SECRET_1),
    )
    .await;
    assert_eq!(
        env.installation_workspace(1002).await,
        Some(None),
        "event alone: row, no workspace"
    );
    let state = env.link_state(&env.token_a, env.a.workspace).await;
    let (status, location) = env.setup(1002, &state).await;
    assert_eq!(status, 303);
    assert!(location.unwrap().contains("githubInstall=linked"));
    assert_eq!(
        env.installation_workspace(1002).await,
        Some(Some(env.a.workspace))
    );

    // (c) forgeries link nothing.
    env.deliver(
        "installation",
        "order-c",
        &installation_created(1003, "gamma", &[]),
        Some(SECRET_1),
    )
    .await;
    for (label, forged) in [
        ("no state at all", String::new()),
        ("garbage", "not-a-state".to_string()),
        (
            "well-shaped but never minted",
            format!("{}.{}", env.a.workspace, "ab".repeat(32)),
        ),
        (
            "another workspace's shape",
            format!("{}.{}", env.b.workspace, "cd".repeat(32)),
        ),
    ] {
        let (status, _) = env.setup(1003, &forged).await;
        assert!(status == 303 || status == 409, "{label}: {status}");
        assert_eq!(
            env.installation_workspace(1003).await,
            Some(None),
            "{label}"
        );
    }
    // A spent state cannot link again; an expired one cannot link at all.
    let state = env.link_state(&env.token_a, env.a.workspace).await;
    sqlx::query("UPDATE github_link_claim SET expires_at = now() - interval '1 minute' WHERE consumed_at IS NULL")
        .execute(&env.su)
        .await
        .unwrap();
    let (_, location) = env.setup(1003, &state).await;
    assert!(
        location.unwrap().contains("githubInstall=state_invalid"),
        "expired"
    );
    assert_eq!(env.installation_workspace(1003).await, Some(None));

    // (d) two live claims naming one installation: neither is auto-linked (the forged-id shape).
    let state_a = env.link_state(&env.token_a, env.a.workspace).await;
    let state_b = env.link_state(&env.token_b, env.b.workspace).await;
    env.setup(1004, &state_a).await;
    env.setup(1004, &state_b).await;
    env.deliver(
        "installation",
        "order-d",
        &installation_created(1004, "delta", &[]),
        Some(SECRET_1),
    )
    .await;
    assert_eq!(
        env.installation_workspace(1004).await,
        Some(None),
        "an ambiguous pair is left for the instance operator"
    );

    // A workspace admin cannot mint a state for another workspace.
    let response = env
        .http
        .post(format!(
            "{}/v1/workspaces/{}/github/link",
            env.base, env.b.workspace
        ))
        .bearer_auth(&env.token_a)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
}

// ---------------------------------------------------------------------------
// acceptance 4 — one workspace per installation, and RLS
// ---------------------------------------------------------------------------

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
async fn an_installation_belongs_to_one_workspace_and_events_never_cross_tenants() {
    let env = env().await;
    env.link_a(1101, &[(11, "acme/shared-name", false)]).await;
    let channel_a = env.channel(env.a.workspace, "public", "gh-a").await;
    let channel_b = env.channel(env.b.workspace, "public", "gh-b").await;
    let (status, _) = env
        .subscribe(
            &env.token_a,
            env.a.workspace,
            channel_a,
            1101,
            "acme/shared-name",
            None,
            false,
        )
        .await;
    assert_eq!(status, 200);

    // B tries to claim A's installation by setup URL: 409, and the row stays A's.
    let state_b = env.link_state(&env.token_b, env.b.workspace).await;
    let (status, _) = env.setup(1101, &state_b).await;
    assert_eq!(status, 409, "claiming an installation linked elsewhere");
    assert_eq!(
        env.installation_workspace(1101).await,
        Some(Some(env.a.workspace))
    );
    // The operator cannot silently re-point it either.
    let response = env
        .http
        .post(format!(
            "{}/v1/integrations/github/installations/1101/link",
            env.base
        ))
        .bearer_auth(&env.token_a)
        .json(&json!({"workspaceId": env.b.workspace.to_string()}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 409);
    assert_eq!(
        env.installation_workspace(1101).await,
        Some(Some(env.a.workspace))
    );

    // B cannot subscribe to A's installation (it cannot even see it).
    let (status, _) = env
        .subscribe(
            &env.token_b,
            env.b.workspace,
            channel_b,
            1101,
            "acme/shared-name",
            None,
            false,
        )
        .await;
    assert_eq!(status, 404);
    // And the database refuses a subscription row that names another workspace's installation.
    let forced = sqlx::query(
        "INSERT INTO github_channel_subscription (workspace_id, channel_id, installation_id, repo_full_name) \
         VALUES ($1, $2, 1101, 'acme/shared-name')",
    )
    .bind(env.b.workspace)
    .bind(channel_b)
    .execute(&env.su)
    .await;
    assert!(
        forced.is_err(),
        "the guard trigger refuses a cross-workspace subscription"
    );

    // The event reaches A's channel and only A's.
    let (_, body) = env
        .deliver(
            "pull_request",
            "cross-1",
            &pull_request_opened(1101, (11, "acme/shared-name"), 3),
            Some(SECRET_1),
        )
        .await;
    assert_eq!(body["delivered"].as_u64(), Some(1));
    assert_eq!(env.messages(channel_a).await, 1);
    assert_eq!(env.messages(channel_b).await, 0);

    // RLS as the real role: a tenant session sees only its own linked installation, never an
    // unlinked or another workspace's one.
    env.deliver(
        "installation",
        "cross-unlinked",
        &installation_created(1102, "ghost", &[(12, "ghost/x", true)]),
        Some(SECRET_1),
    )
    .await;
    let app = momo_app_pool().await;
    let tenant_a = env.a.workspace.to_string();
    let tenant_b = env.b.workspace.to_string();
    let as_a = [("app.workspace_id", tenant_a.as_str())];
    let as_b = [("app.workspace_id", tenant_b.as_str())];
    assert_eq!(
        count_as_app(&app, &as_a, "github_app_installation").await,
        1
    );
    assert_eq!(
        count_as_app(&app, &as_b, "github_app_installation").await,
        0
    );
    assert_eq!(
        count_as_app(&app, &as_a, "github_installation_repository").await,
        1
    );
    assert_eq!(
        count_as_app(&app, &as_b, "github_installation_repository").await,
        0
    );
    assert_eq!(
        count_as_app(&app, &as_a, "github_app").await,
        0,
        "the sealed App is invisible"
    );
    assert_eq!(
        count_as_app(&app, &as_a, "github_app_public").await,
        1,
        "its slug is not secret"
    );
    // A tenant session cannot link: UPDATE sees no row.
    assert_eq!(
        as_app(
            &app,
            &as_b,
            "UPDATE github_app_installation SET workspace_id = workspace_id"
        )
        .await
        .unwrap(),
        0
    );
    assert!(
        as_app(
            &app,
            &as_b,
            "INSERT INTO github_app_installation (installation_id, account_login, account_type, repository_selection) \
             VALUES (9999, 'x', 'User', 'all')"
        )
        .await
        .is_err(),
        "a tenant session cannot create routing rows"
    );
    // The link GUC opens the install claims and the installation columns — and nothing else.
    let link = [("app.github_link", "on")];
    assert_eq!(count_as_app(&app, &link, "github_app").await, 0);
    assert_eq!(
        count_as_app(&app, &link, "github_app_installation").await,
        2
    );
    assert_eq!(
        as_app(&app, &link, "UPDATE github_app SET slug = 'x'")
            .await
            .unwrap(),
        0
    );
    assert!(as_app(
        &app,
        &link,
        "INSERT INTO github_installation_repository (installation_id, repo_id, full_name, private) VALUES (1101, 99, 'a/b', true)"
    )
    .await
    .is_err());
    // The manifest claim (purpose app_manifest) is never reachable through the link branch.
    sqlx::query(
        "INSERT INTO github_link_claim (workspace_id, member_id, purpose, state_hash, owner_type, expires_at) \
         VALUES ($1, $2, 'app_manifest', decode(repeat('ab', 32), 'hex'), 'User', now() + interval '1 hour')",
    )
    .bind(env.a.workspace)
    .bind(env.a.member)
    .execute(&env.su)
    .await
    .unwrap();
    let live_installs: i64 =
        sqlx::query_scalar("SELECT count(*) FROM github_link_claim WHERE purpose = 'install'")
            .fetch_one(&env.su)
            .await
            .unwrap();
    assert_eq!(
        count_as_app(&app, &link, "github_link_claim").await,
        live_installs
    );
    // Ordinary tenant isolation still holds for claims and the author table.
    assert_eq!(
        count_as_app(&app, &as_b, "github_workspace_author").await,
        0
    );
    assert_eq!(
        count_as_app(&app, &as_a, "github_workspace_author").await,
        1
    );
}

// ---------------------------------------------------------------------------
// acceptance 5 — suspend / delete / unsuspend
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn suspend_and_delete_silence_a_channel_and_unsuspend_restores_it() {
    let env = env().await;
    env.link_a(1201, &[(21, "acme/one", false), (22, "acme/two", false)])
        .await;
    let channel = env.channel(env.a.workspace, "public", "gh-life").await;
    let other = env.channel(env.a.workspace, "public", "gh-life-two").await;
    for (channel, repo) in [(channel, "acme/one"), (other, "acme/two")] {
        let (status, _) = env
            .subscribe(
                &env.token_a,
                env.a.workspace,
                channel,
                1201,
                repo,
                None,
                false,
            )
            .await;
        assert_eq!(status, 200);
    }

    let event = |n: i64| pull_request_opened(1201, (21, "acme/one"), n);
    let (_, body) = env
        .deliver("pull_request", "life-1", &event(1), Some(SECRET_1))
        .await;
    assert_eq!(body["delivered"].as_u64(), Some(1));
    assert_eq!(env.messages(channel).await, 1);

    // suspend: silence.
    let (status, _) = env
        .deliver(
            "installation",
            "life-suspend",
            &installation_action(1201, "suspend"),
            Some(SECRET_1),
        )
        .await;
    assert_eq!(status, 200);
    let (status, body) = env
        .deliver("pull_request", "life-2", &event(2), Some(SECRET_1))
        .await;
    assert_eq!(
        (status, body["ignored"].as_str()),
        (200, Some("installation_inactive"))
    );
    assert_eq!(env.messages(channel).await, 1, "no message while suspended");

    // unsuspend: the next event posts again.
    env.deliver(
        "installation",
        "life-unsuspend",
        &installation_action(1201, "unsuspend"),
        Some(SECRET_1),
    )
    .await;
    let (_, body) = env
        .deliver("pull_request", "life-3", &event(3), Some(SECRET_1))
        .await;
    assert_eq!(body["delivered"].as_u64(), Some(1));
    assert_eq!(env.messages(channel).await, 2);

    // A stale redelivery of the old `suspend` is a duplicate and must not re-suspend.
    let (_, body) = env
        .deliver(
            "installation",
            "life-suspend",
            &installation_action(1201, "suspend"),
            Some(SECRET_1),
        )
        .await;
    assert_eq!(body["duplicate"], json!(true));
    let (_, body) = env
        .deliver("pull_request", "life-4", &event(4), Some(SECRET_1))
        .await;
    assert_eq!(
        body["delivered"].as_u64(),
        Some(1),
        "the duplicate suspend changed nothing"
    );
    assert_eq!(env.messages(channel).await, 3);

    // installation_repositories.removed switches that repository's subscriptions off; .added back on.
    let removed = json!({
        "action": "removed",
        "installation": {"id": 1201, "account": {"login": "acme", "type": "Organization"}, "repository_selection": "selected"},
        "repositories_removed": [{"id": 22, "full_name": "acme/two", "private": false}],
    });
    env.deliver(
        "installation_repositories",
        "life-removed",
        &removed,
        Some(SECRET_1),
    )
    .await;
    let (_, body) = env
        .deliver(
            "pull_request",
            "life-5",
            &pull_request_opened(1201, (22, "acme/two"), 5),
            Some(SECRET_1),
        )
        .await;
    assert_eq!(body["ignored"].as_str(), Some("no_subscription"));
    assert_eq!(env.messages(other).await, 0);
    let added = json!({
        "action": "added",
        "installation": {"id": 1201, "account": {"login": "acme", "type": "Organization"}, "repository_selection": "selected"},
        "repositories_added": [{"id": 22, "full_name": "acme/two", "private": false}],
    });
    env.deliver(
        "installation_repositories",
        "life-added",
        &added,
        Some(SECRET_1),
    )
    .await;
    let (_, body) = env
        .deliver(
            "pull_request",
            "life-6",
            &pull_request_opened(1201, (22, "acme/two"), 6),
            Some(SECRET_1),
        )
        .await;
    assert_eq!(body["delivered"].as_u64(), Some(1));
    assert_eq!(env.messages(other).await, 1);

    // deleted: silence, and every subscription is switched off.
    env.deliver(
        "installation",
        "life-deleted",
        &installation_action(1201, "deleted"),
        Some(SECRET_1),
    )
    .await;
    let (_, body) = env
        .deliver("pull_request", "life-7", &event(7), Some(SECRET_1))
        .await;
    assert_eq!(body["ignored"].as_str(), Some("installation_inactive"));
    assert_eq!(env.messages(channel).await, 3);
    let active: i64 =
        sqlx::query_scalar("SELECT count(*) FROM github_channel_subscription WHERE active")
            .fetch_one(&env.su)
            .await
            .unwrap();
    assert_eq!(active, 0);
}

/// POST headers declaring `length` body bytes and no body; the answer is the status line.
async fn oversize_status(base: &str, length: usize, signature: &str) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let address = base.trim_start_matches("http://");
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    let request = format!(
        "POST /v1/integrations/github/webhook HTTP/1.1\r\nHost: {address}\r\n\
         x-github-event: pull_request\r\nx-github-delivery: size-raw\r\n\
         x-hub-signature-256: {signature}\r\ncontent-type: application/json\r\n\
         content-length: {length}\r\nconnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    // A server that wrongly waits for the body would hang here: that is a failure, not a pass.
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        stream.read_to_end(&mut answer),
    )
    .await;
    let text = String::from_utf8_lossy(&answer);
    text.split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// acceptance 9 — size, ping, unknown events
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_oversize_body_is_413_a_ping_is_200_and_an_unknown_event_is_200_with_no_message() {
    let env = env().await;
    env.link_a(1301, &[(31, "acme/size", false)]).await;
    let channel = env.channel(env.a.workspace, "public", "gh-size").await;
    env.subscribe(
        &env.token_a,
        env.a.workspace,
        channel,
        1301,
        "acme/size",
        None,
        false,
    )
    .await;

    // Over the ceiling: 413 before a byte of the body is read, and nothing is written. A raw
    // socket is used because the server answers (and closes) while a client library is still
    // writing the 5 MiB, which surfaces there as a reset instead of the status.
    let receipts = env.count("github_receipt").await;
    for length in [5 * 1024 * 1024 + 1, 25 * 1024 * 1024] {
        assert_eq!(
            oversize_status(&env.base, length, "sha256=00").await,
            413,
            "{length}"
        );
    }
    assert_eq!(env.count("github_receipt").await, receipts);

    // Exactly at the ceiling is accepted (a JSON document padded with whitespace).
    let mut at_limit =
        serde_json::to_vec(&pull_request_opened(1301, (31, "acme/size"), 1)).unwrap();
    at_limit.resize(5 * 1024 * 1024, b' ');
    let signature = format!("sha256={}", github_signature(SECRET_1, &at_limit));
    let (status, body) = env
        .deliver_raw("pull_request", "size-3", at_limit, Some(signature))
        .await;
    assert_eq!((status, body["delivered"].as_u64()), (200, Some(1)));

    // ping: signed, 200, nothing written.
    let before = env.messages(channel).await;
    let (status, body) = env
        .deliver(
            "ping",
            "size-ping",
            &json!({"zen": "Keep it logically awesome."}),
            Some(SECRET_1),
        )
        .await;
    assert_eq!((status, body["event"].as_str()), (200, Some("ping")));
    // An unsigned ping is still refused.
    let (status, _) = env
        .deliver("ping", "size-ping-2", &json!({"zen": "x"}), None)
        .await;
    assert_eq!(status, 401);

    // Unknown event: 200 and no message.
    for event in ["star", "fork", "workflow_run", "deployment_status"] {
        let payload = json!({"action": "created", "installation": {"id": 1301},
                             "repository": {"id": 31, "full_name": "acme/size"}, "sender": {"login": "x"}});
        let (status, body) = env
            .deliver(
                event,
                &format!("size-{}", event.replace('_', "-")),
                &payload,
                Some(SECRET_1),
            )
            .await;
        assert_eq!(status, 200, "{event}");
        assert!(body["delivered"].as_u64().unwrap_or(0) == 0, "{event}");
    }
    assert_eq!(
        env.messages(channel).await,
        before,
        "ping and unknown events post nothing"
    );
    // Unannounced actions of a known event also post nothing.
    let mut labeled = pull_request_opened(1301, (31, "acme/size"), 9);
    labeled["action"] = json!("labeled");
    let (status, body) = env
        .deliver("pull_request", "size-labeled", &labeled, Some(SECRET_1))
        .await;
    assert_eq!(
        (status, body["ignored"].as_str()),
        (200, Some("event_not_announced"))
    );
    assert_eq!(env.messages(channel).await, before);
}

// ---------------------------------------------------------------------------
// acceptance 10 — rotation overlap
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_previous_webhook_secret_verifies_only_inside_the_overlap_window() {
    let env = env().await;
    let payload = json!({"zen": "rotate"});
    let (status, _) = env.deliver("ping", "rot-1", &payload, Some(SECRET_1)).await;
    assert_eq!(status, 200);

    env.paste_secret(SECRET_2).await;
    for (secret, delivery) in [(SECRET_2, "rot-new"), (SECRET_1, "rot-old")] {
        let (status, _) = env.deliver("ping", delivery, &payload, Some(secret)).await;
        assert_eq!(status, 200, "inside the overlap window {secret} verifies");
    }
    let (status, _) = env
        .deliver("ping", "rot-bad", &payload, Some("never-the-secret"))
        .await;
    assert_eq!(status, 401);

    // The window ends: the previous value is refused, the current one still passes.
    sqlx::query("UPDATE github_app SET previous_valid_until = now() - interval '1 minute'")
        .execute(&env.su)
        .await
        .unwrap();
    let (status, _) = env
        .deliver("ping", "rot-old-2", &payload, Some(SECRET_1))
        .await;
    assert_eq!(status, 401, "after the window the old secret is refused");
    let (status, _) = env
        .deliver("ping", "rot-new-2", &payload, Some(SECRET_2))
        .await;
    assert_eq!(status, 200);
}

// ---------------------------------------------------------------------------
// acceptance 11 — private repository into a public channel
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_private_repository_needs_an_explicit_confirmation_for_a_public_channel() {
    let env = env().await;
    env.link_a(
        1401,
        &[(41, "acme/secret-sauce", true), (42, "acme/open", false)],
    )
    .await;
    let public = env.channel(env.a.workspace, "public", "gh-pub").await;
    let private = env.channel(env.a.workspace, "private", "gh-priv").await;
    let subs = |env: &Env| {
        let su = env.su.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM github_channel_subscription")
                .fetch_one(&su)
                .await
                .unwrap()
        }
    };

    // Private repo, public channel, no confirmation: refused with the coded 409, zero rows.
    let (status, body) = env
        .subscribe(
            &env.token_a,
            env.a.workspace,
            public,
            1401,
            "acme/secret-sauce",
            None,
            false,
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(
        body["error"]["code"].as_str(),
        Some("private_repository_requires_confirmation"),
        "{body}"
    );
    assert_eq!(subs(&env).await, 0, "no row without the confirmation");
    // A repository the server cannot place in the list is treated as possibly private.
    let (status, body) = env
        .subscribe(
            &env.token_a,
            env.a.workspace,
            public,
            1401,
            "acme/not-listed",
            None,
            false,
        )
        .await;
    assert_eq!(
        status, 404,
        "a 'selected' installation lists everything it can see: {body}"
    );
    assert_eq!(subs(&env).await, 0);

    // A public repo in a public channel needs none.
    let (status, _) = env
        .subscribe(
            &env.token_a,
            env.a.workspace,
            public,
            1401,
            "acme/open",
            None,
            false,
        )
        .await;
    assert_eq!(status, 200);
    // A private repo in a private channel needs none.
    let (status, _) = env
        .subscribe(
            &env.token_a,
            env.a.workspace,
            private,
            1401,
            "acme/secret-sauce",
            None,
            false,
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(subs(&env).await, 2);
    // With the explicit confirmation the public channel may have the private repository.
    let (status, body) = env
        .subscribe(
            &env.token_a,
            env.a.workspace,
            public,
            1401,
            "acme/secret-sauce",
            None,
            true,
        )
        .await;
    assert_eq!(
        (status, body["privateConfirmed"].as_bool()),
        (200, Some(true))
    );
    assert_eq!(subs(&env).await, 3);

    // Validation: unknown feature, DM channel, malformed repository, non-admin.
    let (status, _) = env
        .subscribe(
            &env.token_a,
            env.a.workspace,
            public,
            1401,
            "acme/open",
            Some(&["pulls", "nonsense"]),
            false,
        )
        .await;
    assert_eq!(status, 400);
    let (status, _) = env
        .subscribe(
            &env.token_a,
            env.a.workspace,
            public,
            1401,
            "not a repo",
            None,
            false,
        )
        .await;
    assert_eq!(status, 400);
    let response = env
        .http
        .post(format!("{}/v1/workspaces/{}/github/subscriptions", env.base, env.a.workspace))
        .json(&json!({"channelId": public.to_string(), "installationId": 1401, "repository": "acme/open"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401, "no bearer");

    // Unsubscribe.
    let overview: Value = env
        .http
        .get(format!(
            "{}/v1/workspaces/{}/github",
            env.base, env.a.workspace
        ))
        .bearer_auth(&env.token_a)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(overview["installations"].as_array().unwrap().len(), 1);
    assert_eq!(
        overview["installations"][0]["repositories"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let id = overview["subscriptions"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let response = env
        .http
        .delete(format!(
            "{}/v1/workspaces/{}/github/subscriptions/{id}",
            env.base, env.a.workspace
        ))
        .bearer_auth(&env.token_a)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);
    assert_eq!(subs(&env).await, 2);
}

// ---------------------------------------------------------------------------
// acceptance 13 — optional features
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn commits_and_releases_reach_only_the_channels_that_turned_them_on() {
    let env = env().await;
    env.link_a(1501, &[(51, "acme/feat", false)]).await;
    let plain = env.channel(env.a.workspace, "public", "gh-plain").await;
    let rich = env.channel(env.a.workspace, "public", "gh-rich").await;
    let (status, _) = env
        .subscribe(
            &env.token_a,
            env.a.workspace,
            plain,
            1501,
            "acme/feat",
            None,
            false,
        )
        .await;
    assert_eq!(status, 200);
    let (status, _) = env
        .subscribe(
            &env.token_a,
            env.a.workspace,
            rich,
            1501,
            "acme/feat",
            Some(&["pulls", "commits", "releases"]),
            false,
        )
        .await;
    assert_eq!(status, 200);

    let (_, body) = env
        .deliver(
            "push",
            "feat-push",
            &push_event(1501, (51, "acme/feat")),
            Some(SECRET_1),
        )
        .await;
    assert_eq!(body["delivered"].as_u64(), Some(1));
    assert_eq!(
        (env.messages(plain).await, env.messages(rich).await),
        (0, 1),
        "push"
    );
    let (_, body) = env
        .deliver(
            "release",
            "feat-release",
            &release_published(1501, (51, "acme/feat")),
            Some(SECRET_1),
        )
        .await;
    assert_eq!(body["delivered"].as_u64(), Some(1));
    assert_eq!(
        (env.messages(plain).await, env.messages(rich).await),
        (0, 2),
        "release"
    );
    // A default-on event reaches both.
    let (_, body) = env
        .deliver(
            "pull_request",
            "feat-pr",
            &pull_request_opened(1501, (51, "acme/feat"), 1),
            Some(SECRET_1),
        )
        .await;
    assert_eq!(body["delivered"].as_u64(), Some(2));
    assert_eq!(
        (env.messages(plain).await, env.messages(rich).await),
        (1, 3)
    );
    // A push to a non-default branch is silent even where commits are on.
    let mut feature_branch = push_event(1501, (51, "acme/feat"));
    feature_branch["ref"] = json!("refs/heads/feature");
    env.deliver("push", "feat-push-2", &feature_branch, Some(SECRET_1))
        .await;
    assert_eq!(env.messages(rich).await, 3);
    // The repository id was learnt from the first event.
    let learnt: i64 =
        sqlx::query_scalar("SELECT count(*) FROM github_channel_subscription WHERE repo_id = 51")
            .fetch_one(&env.su)
            .await
            .unwrap();
    assert_eq!(learnt, 2);
}

// ---------------------------------------------------------------------------
// the operator's list, the rate budget, the missing key
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn only_the_instance_operator_sees_unlinked_installations_and_can_attach_one() {
    let env = env().await;
    env.deliver(
        "installation",
        "op-1",
        &installation_created(1601, "orphan-org", &[(61, "orphan-org/a", true)]),
        Some(SECRET_1),
    )
    .await;
    assert_eq!(env.installation_workspace(1601).await, Some(None));

    // Workspace B's owner is not an instance operator: the list is closed to them.
    let denied = env
        .http
        .get(format!("{}/v1/integrations/github/installations", env.base))
        .bearer_auth(&env.token_b)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
    let denied = env
        .http
        .post(format!(
            "{}/v1/integrations/github/installations/1601/link",
            env.base
        ))
        .bearer_auth(&env.token_b)
        .json(&json!({"workspaceId": env.b.workspace.to_string()}))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
    assert_eq!(
        env.installation_workspace(1601).await,
        Some(None),
        "a refused caller linked nothing"
    );
    // B's own overview never shows the orphan.
    let overview: Value = env
        .http
        .get(format!(
            "{}/v1/workspaces/{}/github",
            env.base, env.b.workspace
        ))
        .bearer_auth(&env.token_b)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(overview["installations"].as_array().unwrap().len(), 0);

    let list: Value = env
        .http
        .get(format!("{}/v1/integrations/github/installations", env.base))
        .bearer_auth(&env.token_a)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let listed = list["installations"].as_array().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["accountLogin"], json!("orphan-org"));
    assert_eq!(listed[0]["repositoryCount"], json!(1));

    let attached = env
        .http
        .post(format!(
            "{}/v1/integrations/github/installations/1601/link",
            env.base
        ))
        .bearer_auth(&env.token_a)
        .json(&json!({"workspaceId": env.b.workspace.to_string()}))
        .send()
        .await
        .unwrap();
    assert_eq!(attached.status(), 204);
    assert_eq!(
        env.installation_workspace(1601).await,
        Some(Some(env.b.workspace))
    );
    let missing = env
        .http
        .post(format!(
            "{}/v1/integrations/github/installations/1601/link",
            env.base
        ))
        .bearer_auth(&env.token_a)
        .json(&json!({"workspaceId": Uuid::new_v4().to_string()}))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_per_installation_budget_answers_429_and_writes_one_audit_row_per_burst() {
    let env = env_with(2, true).await;
    env.link_a(1701, &[(71, "acme/rate", false)]).await;
    let channel = env.channel(env.a.workspace, "public", "gh-rate").await;
    env.subscribe(
        &env.token_a,
        env.a.workspace,
        channel,
        1701,
        "acme/rate",
        None,
        false,
    )
    .await;
    // `link_a` and `subscribe` already spent part of the budget for installation 1701; wait it out
    // by counting only what follows.
    let mut statuses = Vec::new();
    for n in 0..6 {
        let (status, _) = env
            .deliver(
                "pull_request",
                &format!("rate-{n}"),
                &pull_request_opened(1701, (71, "acme/rate"), n),
                Some(SECRET_1),
            )
            .await;
        statuses.push(status);
    }
    assert!(statuses.contains(&429), "{statuses:?}");
    assert!(statuses.contains(&200), "{statuses:?}");
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'webhook.rate_limited' AND workspace_id = $1",
    )
    .bind(env.a.workspace)
    .fetch_one(&env.su)
    .await
    .unwrap();
    assert_eq!(audits, 1, "one audit row for the whole burst");
    let mode: String = sqlx::query_scalar(
        "SELECT detail->>'mode' FROM audit_log WHERE action = 'webhook.rate_limited' AND workspace_id = $1 LIMIT 1",
    )
    .bind(env.a.workspace)
    .fetch_one(&env.su)
    .await
    .unwrap();
    assert_eq!(mode, "github");
    // A denied delivery left no receipt, so GitHub's redelivery after the window posts normally.
    let receipts: i64 =
        sqlx::query_scalar("SELECT count(*) FROM github_receipt WHERE delivery_id LIKE 'rate-%'")
            .fetch_one(&env.su)
            .await
            .unwrap();
    assert_eq!(
        receipts as usize,
        statuses.iter().filter(|s| **s == 200).count()
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn without_the_master_key_the_receive_and_subscribe_surfaces_are_503() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_github(&su).await;
    let a = seed(&su, "ghin-nokey").await;
    let base = start_server(
        momo_app_pool().await,
        ServerOptions {
            operator_emails: &[&a.email],
            github_key: None,
            per_installation_limit: 100,
        },
    )
    .await;
    let http = http();
    let token = login(&http, &base, &a).await;
    let post = http
        .post(format!("{base}/v1/integrations/github/webhook"))
        .header("x-github-event", "ping")
        .header("x-github-delivery", "nokey-1")
        .header("x-hub-signature-256", "sha256=00")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(post.status(), 503);
    for path in [
        format!("/v1/workspaces/{}/github", a.workspace),
        "/v1/integrations/github/installations".to_string(),
    ] {
        let response = http
            .get(format!("{base}{path}"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 503, "{path}");
    }
    let response = http
        .post(format!("{base}/v1/workspaces/{}/github/link", a.workspace))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    let setup = http
        .get(format!(
            "{base}/v1/integrations/github/setup?installation_id=1&state=x"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(setup.status(), 503);
    // Another route is unaffected.
    let health = http.get(format!("{base}/healthz")).send().await.unwrap();
    assert!(health.status().as_u16() < 500, "{}", health.status());
}

// ---------------------------------------------------------------------------
// review findings: demoted minter, concurrent signals, repo rename, archived channel
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_demoted_minters_state_links_nothing_by_either_path() {
    let env = env().await;
    // Path 1: demoted before the setup URL is opened: the id is never recorded.
    let state = env.link_state(&env.token_a, env.a.workspace).await;
    sqlx::query("UPDATE workspace_membership SET role = 'member' WHERE member_id = $1")
        .bind(env.a.member)
        .execute(&env.su)
        .await
        .unwrap();
    let (status, location) = env.setup(1801, &state).await;
    assert_eq!(status, 303);
    assert!(location.unwrap().contains("githubInstall=not_admin"));
    let recorded: i64 =
        sqlx::query_scalar("SELECT count(*) FROM github_link_claim WHERE installation_id = 1801")
            .fetch_one(&env.su)
            .await
            .unwrap();
    assert_eq!(
        recorded, 0,
        "a demoted admin's state records no installation id"
    );
    // Path 2: demoted AFTER the setup URL recorded the id, before the signed event arrives.
    sqlx::query("UPDATE workspace_membership SET role = 'owner' WHERE member_id = $1")
        .bind(env.a.member)
        .execute(&env.su)
        .await
        .unwrap();
    let state = env.link_state(&env.token_a, env.a.workspace).await;
    env.setup(1802, &state).await;
    sqlx::query("UPDATE workspace_membership SET role = 'member' WHERE member_id = $1")
        .bind(env.a.member)
        .execute(&env.su)
        .await
        .unwrap();
    env.deliver(
        "installation",
        "dm-1",
        &installation_created(1802, "acme", &[]),
        Some(SECRET_1),
    )
    .await;
    assert_eq!(
        env.installation_workspace(1802).await,
        Some(None),
        "the signed event did not link"
    );
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM github_link_claim WHERE installation_id = 1802 AND consumed_at IS NULL",
    )
    .fetch_one(&env.su)
    .await
    .unwrap();
    assert_eq!(live, 0, "the dead claim was spent");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn simultaneous_signals_always_link_exactly_once() {
    let env = Arc::new(env().await);
    for round in 0..8_i64 {
        let installation = 1900 + round;
        let state = env.link_state(&env.token_a, env.a.workspace).await;
        let setup = {
            let env = Arc::clone(&env);
            let state = state.clone();
            tokio::spawn(async move { env.setup(installation, &state).await })
        };
        let event = {
            let env = Arc::clone(&env);
            tokio::spawn(async move {
                env.deliver(
                    "installation",
                    &format!("race-{round}"),
                    &installation_created(installation, "acme", &[]),
                    Some(SECRET_1),
                )
                .await
            })
        };
        let _ = tokio::join!(setup, event);
        assert_eq!(
            env.installation_workspace(installation).await,
            Some(Some(env.a.workspace)),
            "round {round}: two concurrent halves must still meet"
        );
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_renamed_repository_does_not_inherit_the_old_names_subscription_and_archived_channels_are_skipped(
) {
    let env = env().await;
    env.link_a(2001, &[(81, "acme/foo", false), (82, "acme/other", false)])
        .await;
    let channel = env.channel(env.a.workspace, "public", "gh-rename").await;
    let archived = env.channel(env.a.workspace, "public", "gh-archived").await;
    for ch in [channel, archived] {
        let (status, _) = env
            .subscribe(
                &env.token_a,
                env.a.workspace,
                ch,
                2001,
                "acme/foo",
                None,
                false,
            )
            .await;
        assert_eq!(status, 200);
    }
    // The first event teaches the subscriptions repo id 81.
    let (_, body) = env
        .deliver(
            "pull_request",
            "rn-1",
            &pull_request_opened(2001, (81, "acme/foo"), 1),
            Some(SECRET_1),
        )
        .await;
    assert_eq!(body["delivered"].as_u64(), Some(2));
    // A different repository (id 99) now carries the same name: it must not reach the channel.
    let (_, body) = env
        .deliver(
            "pull_request",
            "rn-2",
            &pull_request_opened(2001, (99, "acme/foo"), 2),
            Some(SECRET_1),
        )
        .await;
    assert_eq!(body["ignored"].as_str(), Some("no_subscription"), "{body}");
    assert_eq!(env.messages(channel).await, 1);
    // An archived channel stops receiving.
    sqlx::query("UPDATE channel SET archived_at = now() WHERE id = $1")
        .bind(archived)
        .execute(&env.su)
        .await
        .unwrap();
    let (_, body) = env
        .deliver(
            "pull_request",
            "rn-3",
            &pull_request_opened(2001, (81, "acme/foo"), 3),
            Some(SECRET_1),
        )
        .await;
    assert_eq!(body["delivered"].as_u64(), Some(1));
    assert_eq!(env.messages(archived).await, 1, "no post after archiving");
    assert_eq!(env.messages(channel).await, 2);
}
