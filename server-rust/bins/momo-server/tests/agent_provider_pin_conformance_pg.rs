//! #3873 — 에이전트별 AI 연결 고정 (ADR-0147 증보 2026-10-16), through the real route
//! and the real RLS role.
//!
//! * both verbs are instance-operator only (a workspace admin who is not on the
//!   `PLATFORM_ADMIN_EMAILS` list gets 403 and nothing is written);
//! * an operator can pin an agent to the env link or to a stored team link, the
//!   response says whether the pin still resolves, and `default` clears it;
//! * the body is closed (no URL, key or path rides along);
//! * an `owner_only` agent cannot be pinned (route 409, trigger again);
//! * the table itself refuses writes outside the operator transaction, and a
//!   tenant transaction cannot read, change or delete another tenant's pin.
//!
//! `#[ignore]`: needs a real Postgres, same harness as `provider_probe_conformance_pg.rs`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_provider_link_admin_tx, with_tenant_tx, PgPool};
use momo_server::config::SettingsConfig;
use momo_server::{build_app, AppState};
use momo_settings::{
    delete_agent_pin, read_agent_pin, upsert_agent_pin, PinKind, ProviderConfig, ProviderMode,
};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "agent-pin-conformance-app-signing-secret";
const TEST_PROVIDER_MASTER_KEY: &str = "agent-pin-conformance-provider-master-key";
const TEST_PASSWORD: &str = "agent-pin-conformance-password";
const TEAM_KEY: &str = "sk-pin-team-key-3873-0001";
const ENV_URL: &str = "http://hermes.railway.internal:8642/v1";
const ENV_KEY: &str = "hermes-env-key-3873-0002";

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

/// Boot the router with the settings surface CONFIGURED and the operator's env
/// link (`HERMES_BASE_URL` + key) present, the co-hosted Hermes shape.
async fn start_server(pool: PgPool, operator_email: &str, env_url: &str) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_settings(SettingsConfig {
        provider_link_master_key: Some(TEST_PROVIDER_MASTER_KEY.to_string()),
        env_provider: ProviderConfig {
            mode: ProviderMode::ExternalHermes,
            base_url: env_url.to_string(),
            bearer: ENV_KEY.to_string(),
            allow_local_loopback: true,
        },
        platform_admin_emails: vec![operator_email.to_ascii_lowercase()],
        environment: "local".to_string(),
    });
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

struct Fixture {
    workspace: Uuid,
    owner: Uuid,
    email: String,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, hint: &str) -> (Uuid, String) {
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
         VALUES ($1, $2, $3::membership_role)",
    )
    .bind(workspace)
    .bind(member)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace_membership");
    let email = format!("{member}@{hint}.test");
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
    (member, email)
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
    let (owner, email) = seed_human(su, workspace, "owner", slug_hint).await;
    Fixture {
        workspace,
        owner,
        email,
    }
}

/// An agent member + its `agent` row. `owner_only` builds the subscription shape.
async fn seed_agent(su: &PgPool, f: &Fixture, model_source: &str, owner_only: bool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
         VALUES ($1, $2, 'agent'::member_kind, 'active', 'hermes', $3)",
    )
    .bind(id)
    .bind(f.workspace)
    .bind(id.to_string())
    .execute(su)
    .await
    .expect("agent member");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')",
    )
    .bind(f.workspace)
    .bind(id)
    .execute(su)
    .await
    .expect("agent workspace_membership");
    if owner_only {
        sqlx::query(
            "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id, \
                                invocation_scope, subscription_harness, model_source) \
             VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', $3, \
                     'owner_only', 'claude_code', $4)",
        )
        .bind(id)
        .bind(f.workspace)
        .bind(f.owner)
        .bind(model_source)
        .execute(su)
        .await
        .expect("owner_only agent");
    } else {
        sqlx::query(
            "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id, model_source) \
             VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', $3, $4)",
        )
        .bind(id)
        .bind(f.workspace)
        .bind(f.owner)
        .bind(model_source)
        .execute(su)
        .await
        .expect("agent");
    }
    id
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> String {
    let body: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": TEST_PASSWORD,
            "workspace": workspace.to_string(),
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

async fn reset_instance(su: &PgPool) {
    for table in [
        "agent_provider_pin",
        "provider_default_ai",
        "provider_link_chain",
        "provider_link",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(su)
            .await
            .expect("empty instance table");
    }
}

async fn pin_count(su: &PgPool, agent: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM agent_provider_pin WHERE agent_member_id = $1")
        .bind(agent)
        .fetch_one(su)
        .await
        .unwrap()
}

struct Api<'a> {
    http: &'a reqwest::Client,
    base: &'a str,
    workspace: Uuid,
}

impl Api<'_> {
    fn url(&self, agent: Uuid) -> String {
        format!(
            "{}/v1/workspaces/{}/agents/{agent}/provider-pin",
            self.base, self.workspace
        )
    }

    async fn get(&self, token: &str, agent: Uuid) -> (u16, Value) {
        let response = self
            .http
            .get(self.url(agent))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn put(&self, token: &str, agent: Uuid, body: Value) -> (u16, Value) {
        let response = self
            .http
            .put(self.url(agent))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_pin_route_is_instance_operator_only_on_both_verbs() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    reset_instance(&su).await;
    let f = seed(&su, "pin-op").await;
    let agent = seed_agent(&su, &f, "agent", false).await;
    // A workspace ADMIN who is not on the PLATFORM_ADMIN_EMAILS list: they could
    // edit the agent's profile, but they do not own the instance's credentials.
    let (_, admin_email) = seed_human(&su, f.workspace, "admin", "pin-admin").await;
    // An operator of some other workspace.
    let stranger = seed(&su, "pin-stranger").await;
    let base = start_server(app_pool, &f.email, ENV_URL).await;
    let http = reqwest::Client::new();
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
    };
    let op = login(&http, &base, f.workspace, &f.email).await;
    let admin = login(&http, &base, f.workspace, &admin_email).await;
    let other = login(&http, &base, stranger.workspace, &stranger.email).await;

    // Not an operator: 403 both verbs, nothing written.
    assert_eq!(api.get(&admin, agent).await.0, 403);
    assert_eq!(
        api.put(&admin, agent, json!({"kind": "operator_env"}))
            .await
            .0,
        403
    );
    assert_eq!(api.get(&other, agent).await.0, 403);
    assert_eq!(
        api.put(&other, agent, json!({"kind": "operator_env"}))
            .await
            .0,
        403
    );
    assert_eq!(pin_count(&su, agent).await, 0, "a refused write left a row");

    // The operator may. (Positive control: the gate is not just always closed.)
    let (status, body) = api.put(&op, agent, json!({"kind": "operator_env"})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(pin_count(&su, agent).await, 1);
    // A non-operator can neither read nor clear it.
    assert_eq!(api.get(&admin, agent).await.0, 403);
    assert_eq!(
        api.put(&admin, agent, json!({"kind": "default"})).await.0,
        403
    );
    assert_eq!(
        pin_count(&su, agent).await,
        1,
        "a refused clear removed the row"
    );
    reset_instance(&su).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_operator_pins_env_or_a_team_link_and_clears_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    reset_instance(&su).await;
    let f = seed(&su, "pin-flow").await;
    let own_model = seed_agent(&su, &f, "agent", false).await;
    let follows_default = seed_agent(&su, &f, "instance_default", false).await;
    let base = start_server(app_pool, &f.email, ENV_URL).await;
    let http = reqwest::Client::new();
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
    };
    let op = login(&http, &base, f.workspace, &f.email).await;

    // No pin yet.
    let (status, body) = api.get(&op, own_model).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["schema"], "momo.agent.provider_pin.v0");
    assert_eq!(body["pin"], Value::Null);

    // The env pin, with NO team link stored yet.
    let (status, body) = api
        .put(&op, own_model, json!({"kind": "operator_env"}))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["pin"]["kind"], "operator_env");
    assert_eq!(body["pin"]["linkResolved"], true);
    let env_label = body["pin"]["endpointLabel"].as_str().unwrap().to_string();
    assert!(env_label.contains("hermes.railway.internal"), "{env_label}");
    assert!(
        !body.to_string().contains(ENV_KEY),
        "the response carries the env key: {body}"
    );

    // A team link and one hop to point at.
    let stored = http
        .put(format!("{base}/v1/provider/link"))
        .bearer_auth(&op)
        .json(&json!({"baseUrl": "http://127.0.0.1:9/openai/v1", "bearer": TEAM_KEY}))
        .send()
        .await
        .unwrap();
    assert_eq!(stored.status(), 200);
    let set_chain = |host: &'static str| {
        let request = http
            .put(format!("{base}/v1/provider/link/chain"))
            .bearer_auth(&op)
            .json(&json!({"entries": [{"position": 1, "baseUrl": host, "bearer": TEAM_KEY}]}));
        async move { assert_eq!(request.send().await.unwrap().status(), 200) }
    };
    set_chain("http://127.0.0.1:10/first/v1").await;

    // A team-link pin needs the agent's own model: the team row never applies to a
    // pinned agent, so an agent on the instance default would call the pinned
    // provider with the placeholder name.
    let (status, body) = api
        .put(
            &op,
            follows_default,
            json!({"kind": "team_link", "linkPosition": 1}),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"]["code"], "agent_own_model_required");
    assert_eq!(pin_count(&su, follows_default).await, 0);
    // ...while the env pin has no such condition (Hermes's model name is its own).
    assert_eq!(
        api.put(&op, follows_default, json!({"kind": "operator_env"}))
            .await
            .0,
        200
    );

    // Position 1 (the hop) and position 0 (the stored link itself).
    let (status, body) = api
        .put(
            &op,
            own_model,
            json!({"kind": "team_link", "linkPosition": 1}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["pin"]["kind"], "team_link");
    assert_eq!(body["pin"]["linkPosition"], 1);
    assert_eq!(body["pin"]["linkResolved"], true);
    let hop_label = body["pin"]["endpointLabel"].as_str().unwrap().to_string();
    assert!(hop_label.contains("127.0.0.1"), "{hop_label}");
    assert_eq!(
        pin_count(&su, own_model).await,
        1,
        "one row per agent: replace, not add"
    );
    let (status, body) = api
        .put(
            &op,
            own_model,
            json!({"kind": "team_link", "linkPosition": 0}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["pin"]["linkPosition"], 0);
    assert_eq!(body["pin"]["linkResolved"], true);

    // The operator re-saves the chain with another host: position 1 is not what
    // it was pinned on, and the read says so (the worker would refuse the turn).
    let (status, _) = api
        .put(
            &op,
            own_model,
            json!({"kind": "team_link", "linkPosition": 1}),
        )
        .await;
    assert_eq!(status, 200);
    set_chain("http://127.0.0.1:11/second/v1").await;
    let (status, body) = api.get(&op, own_model).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["pin"]["linkPosition"], 1);
    assert_eq!(body["pin"]["linkResolved"], false, "{body}");
    assert_eq!(
        body["pin"]["endpointLabel"],
        hop_label.as_str(),
        "the label it was pinned on"
    );

    // Refusals: an unconfigured position, a closed body, the wrong shapes.
    let (status, _) = api
        .put(
            &op,
            own_model,
            json!({"kind": "team_link", "linkPosition": 7}),
        )
        .await;
    assert_eq!(status, 400);
    for body in [
        json!({"kind": "team_link"}),
        json!({"kind": "team_link", "linkPosition": -1}),
        json!({"kind": "operator_env", "linkPosition": 0}),
        json!({"kind": "subscription"}),
        json!({"kind": "operator_env", "baseUrl": "http://169.254.169.254/"}),
        json!({"kind": "operator_env", "bearer": "sk-x"}),
        json!({"kind": "team_link", "linkPosition": 1, "profileDir": "/Users/me/.claude"}),
        json!({}),
    ] {
        let (status, _) = api.put(&op, own_model, body.clone()).await;
        assert!((400..500).contains(&status), "{body} -> {status}");
    }

    // Position 0 is the stored link: with none stored it is not "env".
    sqlx::query("DELETE FROM provider_link")
        .execute(&su)
        .await
        .unwrap();
    let (status, body) = api
        .put(
            &op,
            own_model,
            json!({"kind": "team_link", "linkPosition": 0}),
        )
        .await;
    assert_eq!(
        status, 400,
        "position 0 with no stored link must not mean env: {body}"
    );

    // An agent that does not exist (or lives elsewhere) is a 404.
    assert_eq!(
        api.put(&op, Uuid::new_v4(), json!({"kind": "operator_env"}))
            .await
            .0,
        404
    );
    assert_eq!(api.get(&op, Uuid::new_v4()).await.0, 404);

    // `default` clears; clearing twice is fine.
    let (status, body) = api.put(&op, own_model, json!({"kind": "default"})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["pin"], Value::Null);
    assert_eq!(pin_count(&su, own_model).await, 0);
    assert_eq!(
        api.put(&op, own_model, json!({"kind": "default"})).await.0,
        200
    );

    // The audit trail names kind, position and the redacted label, never a key.
    let audits: Vec<Value> = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = 'agent.provider_pin.updated' \
          ORDER BY created_at",
    )
    .bind(f.workspace)
    .fetch_all(&su)
    .await
    .unwrap();
    assert!(audits.len() >= 4, "{audits:?}");
    let all = Value::Array(audits).to_string();
    assert!(all.contains("operator_env") && all.contains("team_link") && all.contains("cleared"));
    for secret in [TEAM_KEY, ENV_KEY, "Bearer", "169.254"] {
        assert!(!all.contains(secret), "audit carries `{secret}`: {all}");
    }
    reset_instance(&su).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_env_pin_needs_an_env_link_on_this_server() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    reset_instance(&su).await;
    let f = seed(&su, "pin-noenv").await;
    let agent = seed_agent(&su, &f, "agent", false).await;
    let base = start_server(app_pool, &f.email, "").await;
    let http = reqwest::Client::new();
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
    };
    let op = login(&http, &base, f.workspace, &f.email).await;
    let (status, body) = api.put(&op, agent, json!({"kind": "operator_env"})).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(pin_count(&su, agent).await, 0);
    reset_instance(&su).await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_owner_only_agent_cannot_be_pinned_by_the_route_or_the_table() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    reset_instance(&su).await;
    let f = seed(&su, "pin-owner-only").await;
    let personal = seed_agent(&su, &f, "agent", true).await;
    let base = start_server(app_pool, &f.email, ENV_URL).await;
    let http = reqwest::Client::new();
    let api = Api {
        http: &http,
        base: &base,
        workspace: f.workspace,
    };
    let op = login(&http, &base, f.workspace, &f.email).await;

    for body in [
        json!({"kind": "operator_env"}),
        json!({"kind": "team_link", "linkPosition": 0}),
    ] {
        let (status, error) = api.put(&op, personal, body.clone()).await;
        assert_eq!(status, 409, "{body}: {error}");
        assert_eq!(error["error"]["code"], "owner_only_agent_cannot_be_pinned");
    }
    assert_eq!(pin_count(&su, personal).await, 0);
    // Clearing is always allowed: it is the way back.
    assert_eq!(
        api.put(&op, personal, json!({"kind": "default"})).await.0,
        200
    );

    // The table refuses the same thing even when the route is bypassed (superuser
    // insert: only the trigger stands in the way).
    let direct = sqlx::query(
        "INSERT INTO agent_provider_pin (agent_member_id, workspace_id, kind) \
         VALUES ($1, $2, 'operator_env')",
    )
    .bind(personal)
    .bind(f.workspace)
    .execute(&su)
    .await;
    assert!(
        direct.is_err(),
        "the trigger let an owner_only agent be pinned"
    );

    // And a pin cannot name another tenant's workspace for this agent.
    let team_agent = seed_agent(&su, &f, "agent", false).await;
    let other = seed(&su, "pin-other-ws").await;
    let cross = sqlx::query(
        "INSERT INTO agent_provider_pin (agent_member_id, workspace_id, kind) \
         VALUES ($1, $2, 'operator_env')",
    )
    .bind(team_agent)
    .bind(other.workspace)
    .execute(&su)
    .await;
    assert!(
        cross.is_err(),
        "the trigger let a pin name a foreign workspace"
    );
    // The CHECK refuses a pin that smuggles a label onto the env kind.
    let shaped = sqlx::query(
        "INSERT INTO agent_provider_pin (agent_member_id, workspace_id, kind, link_endpoint_label) \
         VALUES ($1, $2, 'operator_env', 'x')",
    )
    .bind(team_agent)
    .bind(f.workspace)
    .execute(&su)
    .await;
    assert!(
        shaped.is_err(),
        "the shape CHECK let a label ride on operator_env"
    );
    reset_instance(&su).await;
}

/// The database is the last gate: with the route's check out of the picture, a
/// tenant transaction still cannot write the table, and cannot see or touch another
/// tenant's pin. Runs as the real NOBYPASSRLS `momo_app` role.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_table_writes_only_inside_the_operator_transaction_and_isolates_tenants() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    reset_instance(&su).await;
    let a = seed(&su, "pin-rls-a").await;
    let b = seed(&su, "pin-rls-b").await;
    let agent_a = seed_agent(&su, &a, "agent", false).await;
    let (ws_a, ws_b, by) = (a.workspace, b.workspace, a.owner);

    // An ordinary tenant transaction (what a workspace admin's request runs in)
    // is refused by the write policy.
    let refused = with_tenant_tx(&app, ws_a, move |conn| {
        Box::pin(async move {
            upsert_agent_pin(conn, ws_a, agent_a, PinKind::OperatorEnv, None, None, by).await?;
            Ok(())
        })
    })
    .await;
    assert!(refused.is_err(), "a tenant tx wrote the pin table");
    assert_eq!(pin_count(&su, agent_a).await, 0);

    // The operator transaction writes it.
    with_provider_link_admin_tx(&app, ws_a, move |conn| {
        Box::pin(async move {
            upsert_agent_pin(conn, ws_a, agent_a, PinKind::OperatorEnv, None, None, by).await?;
            Ok(())
        })
    })
    .await
    .expect("the operator tx writes the pin");
    assert_eq!(pin_count(&su, agent_a).await, 1);

    // The owner tenant reads it; another tenant does not.
    let own = with_tenant_tx(&app, ws_a, move |conn| {
        Box::pin(async move { Ok(read_agent_pin(conn, ws_a, agent_a).await.ok().flatten()) })
    })
    .await
    .unwrap();
    assert!(own.is_some(), "the owner tenant cannot read its own pin");
    let foreign = with_tenant_tx(&app, ws_b, move |conn| {
        Box::pin(async move {
            // Even naming the other tenant's workspace id in the WHERE clause.
            Ok(read_agent_pin(conn, ws_a, agent_a).await.ok().flatten())
        })
    })
    .await
    .unwrap();
    assert!(foreign.is_none(), "RLS let another tenant read the pin");

    // A tenant tx can neither delete nor rewrite it (the policy hides the row from
    // the write, so it is a no-op rather than an error).
    let removed = with_tenant_tx(&app, ws_a, move |conn| {
        Box::pin(async move { Ok(delete_agent_pin(conn, ws_a, agent_a).await?) })
    })
    .await
    .unwrap();
    assert!(!removed, "a tenant tx deleted a pin");
    let rewritten = with_tenant_tx(&app, ws_a, move |conn| {
        Box::pin(async move {
            Ok(
                sqlx::query("UPDATE agent_provider_pin SET kind = kind WHERE agent_member_id = $1")
                    .bind(agent_a)
                    .execute(&mut *conn)
                    .await?
                    .rows_affected(),
            )
        })
    })
    .await
    .unwrap();
    assert_eq!(rewritten, 0, "a tenant tx updated a pin");
    assert_eq!(pin_count(&su, agent_a).await, 1);

    // The operator transaction of ANOTHER workspace cannot delete this tenant's pin.
    let cross = with_provider_link_admin_tx(&app, ws_b, move |conn| {
        Box::pin(async move { Ok(delete_agent_pin(conn, ws_a, agent_a).await?) })
    })
    .await
    .unwrap();
    assert!(
        !cross,
        "an operator tx of another workspace deleted the pin"
    );
    assert_eq!(pin_count(&su, agent_a).await, 1);
    reset_instance(&su).await;
}
