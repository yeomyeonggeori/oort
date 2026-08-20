//! ADR-0162 / #1363 Agent Port DB-backed conformance.
//!
//! The verifier starts the real Axum router with a `momo_app` (NOBYPASSRLS)
//! pool. `DATABASE_URL` is a PostgreSQL 18 superuser URL used only for
//! migrations and fixtures. Run it through `scripts/verify_agent_port.sh` so
//! the database is isolated and the tests stay serial.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_server::config::AgentPortConfig;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "agent-port-pg-conformance-signing-secret";
const LEGACY_VERSION: &str = "2025-11-25";
const MODERN_VERSION: &str = "2026-07-28";
const CONNECT_SCOPE: &str = "agent:port:connect";
const PATH: &str = "/v1/mcp/agent-port";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated PostgreSQL 18 URL")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

fn required_pg_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| {
        panic!("set {name}; scripts/verify_agent_port.sh supplies private PG client env")
    })
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to Agent Port conformance DB as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(16)
        .connect_with(options.username("momo_app").password(&momo_app_password()))
        .await
        .expect("connect as momo_app after bootstrap_roles.sql")
}

fn resolve_psql() -> PathBuf {
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths) {
            let candidate = directory.join("psql");
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

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema setup mutex is healthy");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration on the Agent Port conformance DB");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/e2e/bootstrap_roles.sql"
    ));
    let pg_host = required_pg_env("PGHOST");
    let pg_port = required_pg_env("PGPORT");
    let pg_user = required_pg_env("PGUSER");
    let pg_database = required_pg_env("PGDATABASE");
    let pg_password = required_pg_env("PGPASSWORD");
    let status = Command::new(resolve_psql())
        .args(["-h", &pg_host, "-p", &pg_port, "-U", &pg_user, "-d"])
        .arg(&pg_database)
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        // Passwords belong in the child's environment, never its observable
        // argv. The verifier itself receives this via its private shell env.
        .env("PGPASSWORD", pg_password)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

async fn start_server(pool: PgPool, config: AgentPortConfig) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_agent_port(config);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind Agent Port conformance server");
    let address: SocketAddr = listener.local_addr().expect("Agent Port server address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

#[derive(Clone, Debug)]
struct Credential {
    id: Uuid,
    raw: String,
}

#[derive(Debug)]
struct Fixture {
    workspace: Uuid,
    foreign_workspace: Uuid,
    agent: Uuid,
    active: Credential,
    second_active: Credential,
    no_scope: Credential,
    revoked: Credential,
    expired: Credential,
    cross_workspace: Credential,
    human_bearer: Credential,
    inactive_agent: Credential,
    unknown: String,
    human_jwt: String,
}

fn raw_credential(claimed_workspace: Uuid) -> String {
    format!(
        "momo_agent_v1.{claimed_workspace}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

async fn insert_credential(
    pool: &PgPool,
    row_workspace: Uuid,
    actor: Uuid,
    raw: String,
    scopes: &[&str],
    revoked: bool,
    expired: bool,
) -> Credential {
    let scopes: Vec<String> = scopes.iter().map(|scope| (*scope).to_string()).collect();
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO token \
           (workspace_id, kind, actor_member_id, subject_member_id, token_hash, scopes, \
            label, revoked_at, expires_at) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3, 'sha256'), $4, \
                 'agent-port-pg-fixture', \
                 CASE WHEN $5 THEN now() - interval '1 second' END, \
                 CASE WHEN $6 THEN now() - interval '1 second' END) \
         RETURNING id",
    )
    .bind(row_workspace)
    .bind(actor)
    .bind(&raw)
    .bind(scopes)
    .bind(revoked)
    .bind(expired)
    .fetch_one(pool)
    .await
    .expect("seed agent bearer credential");
    Credential { id, raw }
}

async fn seed_fixture(pool: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    let foreign_workspace = Uuid::new_v4();
    for (id, prefix) in [
        (workspace, "agent-port"),
        (foreign_workspace, "agent-port-foreign"),
    ] {
        sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
            .bind(id)
            .bind(format!("{prefix}-{}", Uuid::new_v4().simple()))
            .execute(pool)
            .await
            .expect("seed Agent Port workspace");
    }

    let human = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', 'Agent Port Human', $3)",
    )
    .bind(human)
    .bind(workspace)
    .bind(format!("human-{}", human.simple()))
    .execute(pool)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified) \
         VALUES ($1, $2, $3, true)",
    )
    .bind(human)
    .bind(workspace)
    .bind(format!("{human}@agent-port.test"))
    .execute(pool)
    .await
    .expect("seed human identity");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(human)
    .execute(pool)
    .await
    .expect("seed human workspace membership");

    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', 'Agent Port Bot', $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(format!("agent-{}", agent.simple()))
    .execute(pool)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent \
           (member_id, workspace_id, model, base_url, owner_human_id) \
         VALUES ($1, $2, 'hosted-agent', 'https://provider.invalid/v1', $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(human)
    .execute(pool)
    .await
    .expect("seed agent row");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(agent)
    .execute(pool)
    .await
    .expect("seed agent workspace membership");

    let active = insert_credential(
        pool,
        workspace,
        agent,
        raw_credential(workspace),
        &[CONNECT_SCOPE],
        false,
        false,
    )
    .await;
    let second_active = insert_credential(
        pool,
        workspace,
        agent,
        raw_credential(workspace),
        &[CONNECT_SCOPE],
        false,
        false,
    )
    .await;
    let no_scope = insert_credential(
        pool,
        workspace,
        agent,
        raw_credential(workspace),
        &["messages:write"],
        false,
        false,
    )
    .await;
    let revoked = insert_credential(
        pool,
        workspace,
        agent,
        raw_credential(workspace),
        &[CONNECT_SCOPE],
        true,
        false,
    )
    .await;
    let expired = insert_credential(
        pool,
        workspace,
        agent,
        raw_credential(workspace),
        &[CONNECT_SCOPE],
        false,
        true,
    )
    .await;

    // The row and actor belong to A, while the raw envelope claims B. The hash
    // exists, but only behind A's FORCE RLS boundary; a transaction keyed by B
    // must resolve it as unknown.
    let cross_workspace = insert_credential(
        pool,
        workspace,
        agent,
        raw_credential(foreign_workspace),
        &[CONNECT_SCOPE],
        false,
        false,
    )
    .await;
    let human_bearer = insert_credential(
        pool,
        workspace,
        human,
        raw_credential(workspace),
        &[CONNECT_SCOPE],
        false,
        false,
    )
    .await;

    let inactive_member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
         VALUES ($1, $2, 'agent', 'suspended', 'Inactive Agent Port Bot', $3)",
    )
    .bind(inactive_member)
    .bind(workspace)
    .bind(format!("inactive-agent-{}", inactive_member.simple()))
    .execute(pool)
    .await
    .expect("seed inactive agent member");
    sqlx::query(
        "INSERT INTO agent \
           (member_id, workspace_id, model, base_url, owner_human_id) \
         VALUES ($1, $2, 'hosted-agent', 'https://provider.invalid/v1', $3)",
    )
    .bind(inactive_member)
    .bind(workspace)
    .bind(human)
    .execute(pool)
    .await
    .expect("seed inactive agent row");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(inactive_member)
    .execute(pool)
    .await
    .expect("seed inactive agent workspace membership");
    let inactive_agent = insert_credential(
        pool,
        workspace,
        inactive_member,
        raw_credential(workspace),
        &[CONNECT_SCOPE],
        false,
        false,
    )
    .await;
    let unknown = raw_credential(workspace);
    let human_jwt = momo_auth::sign_access(human, workspace, &[], TEST_JWT_SECRET)
        .expect("sign a valid human App JWT")
        .token;

    Fixture {
        workspace,
        foreign_workspace,
        agent,
        active,
        second_active,
        no_scope,
        revoked,
        expired,
        cross_workspace,
        human_bearer,
        inactive_agent,
        unknown,
        human_jwt,
    }
}

fn modern_request(id: Value, method: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": {
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": {
                    "name": "oort-pg-conformance",
                    "version": "1.0.0"
                }
            }
        }
    })
}

async fn post_json(
    client: &reqwest::Client,
    base: &str,
    token: Option<&str>,
    version: Option<&str>,
    mirror_method: Option<&str>,
    body: &Value,
    with_resume_headers: bool,
) -> reqwest::Response {
    let mut request = client
        .post(format!("{base}{PATH}"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .json(body);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(version) = version {
        request = request.header("mcp-protocol-version", version);
    }
    if let Some(method) = mirror_method {
        request = request.header("mcp-method", method);
    }
    if with_resume_headers {
        request = request
            .header("mcp-session-id", "untrusted-session-id")
            .header("last-event-id", "untrusted-event-id");
    }
    request.send().await.expect("Agent Port request responds")
}

fn assert_stateless_headers(response: &reqwest::Response) {
    assert_eq!(
        response
            .headers()
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("private, no-store"),
        "Agent Port responses must never be shared or replayed from cache"
    );
    assert!(
        response.headers().get("mcp-session-id").is_none(),
        "Agent Port must never establish or echo an MCP session"
    );
}

async fn expect_auth_failure(response: reqwest::Response, status: u16, challenge: &'static str) {
    assert_eq!(response.status().as_u16(), status);
    assert_stateless_headers(&response);
    assert_eq!(
        response
            .headers()
            .get("www-authenticate")
            .and_then(|value| value.to_str().ok()),
        Some(challenge)
    );
    assert_eq!(
        response
            .bytes()
            .await
            .expect("read auth failure body")
            .len(),
        0,
        "credential failures expose no protocol oracle"
    );
}

#[derive(Debug, PartialEq, Eq)]
struct ProductCounts {
    messages: i64,
    outbox: i64,
    agent_runs: i64,
    approvals: i64,
    usage: i64,
    work_sessions: i64,
}

async fn product_counts(pool: &PgPool) -> ProductCounts {
    let row = sqlx::query(
        "SELECT (SELECT count(*) FROM message) AS messages, \
                (SELECT count(*) FROM outbox) AS outbox, \
                (SELECT count(*) FROM agent_run) AS agent_runs, \
                (SELECT count(*) FROM approval) AS approvals, \
                (SELECT count(*) FROM usage_ledger) AS usage, \
                (SELECT count(*) FROM work_session) AS work_sessions",
    )
    .fetch_one(pool)
    .await
    .expect("snapshot product tables");
    ProductCounts {
        messages: row.try_get("messages").expect("messages count"),
        outbox: row.try_get("outbox").expect("outbox count"),
        agent_runs: row.try_get("agent_runs").expect("agent_runs count"),
        approvals: row.try_get("approvals").expect("approvals count"),
        usage: row.try_get("usage").expect("usage count"),
        work_sessions: row.try_get("work_sessions").expect("work_sessions count"),
    }
}

async fn audit_count(pool: &PgPool, token: Uuid, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE via_token_id = $1 AND action = $2")
        .bind(token)
        .bind(action)
        .fetch_one(pool)
        .await
        .expect("count Agent Port audit rows")
}

async fn last_used(pool: &PgPool, token: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT last_used_at IS NOT NULL FROM token WHERE id = $1")
        .bind(token)
        .fetch_one(pool)
        .await
        .expect("read token last_used_at")
}

async fn last_used_value(pool: &PgPool, token: Uuid) -> Option<String> {
    sqlx::query_scalar("SELECT last_used_at::text FROM token WHERE id = $1")
        .bind(token)
        .fetch_one(pool)
        .await
        .expect("read exact token last_used_at")
}

async fn all_token_audit_count(pool: &PgPool, token: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE via_token_id = $1")
        .bind(token)
        .fetch_one(pool)
        .await
        .expect("count all token audit rows")
}

async fn token_hash_hex(pool: &PgPool, token: Uuid) -> String {
    sqlx::query_scalar("SELECT encode(token_hash, 'hex') FROM token WHERE id = $1")
        .bind(token)
        .fetch_one(pool)
        .await
        .expect("read stored credential digest")
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL 18; run scripts/verify_agent_port.sh"]
async fn dual_era_auth_audit_and_read_only_contract_use_the_real_router() {
    ensure_schema_and_roles();
    let superuser = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed_fixture(&superuser).await;
    let before = product_counts(&superuser).await;
    let role_row = sqlx::query(
        "SELECT current_user AS role_name, \
                (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass",
    )
    .fetch_one(&app)
    .await
    .expect("inspect runtime database role");
    assert_eq!(role_row.get::<String, _>("role_name"), "momo_app");
    assert!(!role_row.get::<bool, _>("bypass"));
    let app_rls_probe = app.clone();
    let base = start_server(
        app,
        AgentPortConfig {
            external_origin: None,
            window_seconds: 60,
            per_token_limit: 0,
            per_agent_limit: 0,
            per_ip_limit: 0,
            hosted_delivery_enabled: false,
            oauth: Default::default(),
        },
    )
    .await;
    let client = reqwest::Client::new();

    for method in [reqwest::Method::GET, reqwest::Method::DELETE] {
        let response = client
            .request(method.clone(), format!("{base}{PATH}"))
            .send()
            .await
            .expect("closed transport method responds");
        assert_eq!(response.status(), 405, "{method} must remain closed");
        assert!(response.headers().get("mcp-session-id").is_none());
    }

    let discover = post_json(
        &client,
        &base,
        Some(&fixture.active.raw),
        Some(MODERN_VERSION),
        Some("server/discover"),
        &modern_request(json!(1), "server/discover"),
        false,
    )
    .await;
    assert_eq!(discover.status(), 200);
    assert_stateless_headers(&discover);
    assert_eq!(
        discover
            .json::<Value>()
            .await
            .expect("modern discover JSON"),
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "protocolVersion": MODERN_VERSION,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {
                    "name": "oort-agent-port",
                    "title": "oort Agent Port",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "resultType": "server/discover",
                "cache": {"ttlSeconds": 300, "scope": "private"}
            }
        })
    );

    let modern_list = post_json(
        &client,
        &base,
        Some(&fixture.active.raw),
        Some(MODERN_VERSION),
        Some("tools/list"),
        &modern_request(json!("modern-list"), "tools/list"),
        true,
    )
    .await;
    assert_eq!(modern_list.status(), 200);
    assert_stateless_headers(&modern_list);
    assert_eq!(
        modern_list.json::<Value>().await.expect("modern list JSON"),
        json!({
            "jsonrpc": "2.0",
            "id": "modern-list",
            "result": {
                "tools": [],
                "resultType": "tools/list",
                "cache": {"ttlSeconds": 0, "scope": "private"}
            }
        })
    );

    // The first legacy request negotiates in its body and deliberately omits
    // MCP-Protocol-Version. Every follow-up below carries the exact version.
    let initialize_body = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "initialize",
        "params": {
            "protocolVersion": LEGACY_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "legacy-pg", "version": "1.0.0"}
        }
    });
    let initialize = post_json(
        &client,
        &base,
        Some(&fixture.active.raw),
        None,
        Some("initialize"),
        &initialize_body,
        false,
    )
    .await;
    assert_eq!(initialize.status(), 200);
    assert_stateless_headers(&initialize);
    assert_eq!(
        initialize
            .json::<Value>()
            .await
            .expect("legacy initialize JSON"),
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "protocolVersion": LEGACY_VERSION,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {
                    "name": "oort-agent-port",
                    "title": "oort Agent Port",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        })
    );

    let initialized = post_json(
        &client,
        &base,
        Some(&fixture.active.raw),
        Some(LEGACY_VERSION),
        Some("notifications/initialized"),
        &json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }),
        true,
    )
    .await;
    assert_eq!(initialized.status(), 202);
    assert_stateless_headers(&initialized);
    assert_eq!(
        initialized.bytes().await.expect("initialized body").len(),
        0
    );

    let ping = post_json(
        &client,
        &base,
        Some(&fixture.active.raw),
        Some(LEGACY_VERSION),
        Some("ping"),
        &json!({"jsonrpc": "2.0", "id": 3, "method": "ping", "params": {}}),
        false,
    )
    .await;
    assert_eq!(ping.status(), 200);
    assert_stateless_headers(&ping);
    assert_eq!(
        ping.json::<Value>().await.expect("legacy ping JSON"),
        json!({"jsonrpc": "2.0", "id": 3, "result": {}})
    );

    let legacy_list = post_json(
        &client,
        &base,
        Some(&fixture.active.raw),
        Some(LEGACY_VERSION),
        Some("tools/list"),
        &json!({"jsonrpc": "2.0", "id": 4, "method": "tools/list", "params": {}}),
        false,
    )
    .await;
    assert_eq!(legacy_list.status(), 200);
    assert_stateless_headers(&legacy_list);
    assert_eq!(
        legacy_list
            .json::<Value>()
            .await
            .expect("legacy tools/list JSON"),
        json!({"jsonrpc": "2.0", "id": 4, "result": {"tools": []}})
    );

    let auth_body = modern_request(json!(90), "server/discover");
    expect_auth_failure(
        post_json(
            &client,
            &base,
            None,
            Some(MODERN_VERSION),
            Some("server/discover"),
            &auth_body,
            false,
        )
        .await,
        401,
        "Bearer scope=\"agent:port:connect\"",
    )
    .await;
    for token in [
        fixture.unknown.as_str(),
        fixture.revoked.raw.as_str(),
        fixture.expired.raw.as_str(),
        fixture.cross_workspace.raw.as_str(),
        fixture.human_bearer.raw.as_str(),
        fixture.inactive_agent.raw.as_str(),
        fixture.human_jwt.as_str(),
    ] {
        expect_auth_failure(
            post_json(
                &client,
                &base,
                Some(token),
                Some(MODERN_VERSION),
                Some("server/discover"),
                &auth_body,
                false,
            )
            .await,
            401,
            "Bearer error=\"invalid_token\", scope=\"agent:port:connect\"",
        )
        .await;
    }
    expect_auth_failure(
        post_json(
            &client,
            &base,
            Some(&fixture.no_scope.raw),
            Some(MODERN_VERSION),
            Some("server/discover"),
            &auth_body,
            false,
        )
        .await,
        403,
        "Bearer error=\"insufficient_scope\", scope=\"agent:port:connect\"",
    )
    .await;

    assert_eq!(
        audit_count(&superuser, fixture.active.id, "auth.agent_bearer.used").await,
        6,
        "every accepted POST is independently authenticated and audited"
    );
    assert_eq!(
        audit_count(
            &superuser,
            fixture.no_scope.id,
            "auth.agent_bearer.scope_denied"
        )
        .await,
        1,
        "a live credential missing agent:port:connect is auditable"
    );
    for token in [
        fixture.revoked.id,
        fixture.expired.id,
        fixture.cross_workspace.id,
        fixture.human_bearer.id,
        fixture.inactive_agent.id,
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit_log WHERE via_token_id = $1")
                .bind(token)
                .fetch_one(&superuser)
                .await
                .expect("count rejected-token audit rows"),
            0,
            "unidentified/revoked/expired/cross-tenant credentials emit no actor audit"
        );
    }
    let denied_detail: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log \
         WHERE via_token_id = $1 AND action = 'auth.agent_bearer.scope_denied'",
    )
    .bind(fixture.no_scope.id)
    .fetch_one(&superuser)
    .await
    .expect("load missing-scope audit detail");
    assert_eq!(
        denied_detail,
        json!({
            "schema": "momo.agent_bearer.use.v1",
            "method": "POST",
            "path": PATH,
            "required_scope": CONNECT_SCOPE,
            "granted": false
        })
    );
    assert!(last_used(&superuser, fixture.active.id).await);
    assert!(!last_used(&superuser, fixture.no_scope.id).await);
    assert!(!last_used(&superuser, fixture.revoked.id).await);
    assert!(!last_used(&superuser, fixture.expired.id).await);
    assert!(!last_used(&superuser, fixture.cross_workspace.id).await);
    assert!(!last_used(&superuser, fixture.human_bearer.id).await);
    assert!(!last_used(&superuser, fixture.inactive_agent.id).await);

    // Revocation is checked on every request. A previously accepted token must
    // become opaque immediately, without a second touch or used audit.
    let revoke_first = post_json(
        &client,
        &base,
        Some(&fixture.second_active.raw),
        Some(MODERN_VERSION),
        Some("server/discover"),
        &auth_body,
        false,
    )
    .await;
    assert_eq!(revoke_first.status(), 200);
    let before_revoke_touch = last_used_value(&superuser, fixture.second_active.id).await;
    let before_revoke_audits = audit_count(
        &superuser,
        fixture.second_active.id,
        "auth.agent_bearer.used",
    )
    .await;
    assert_eq!(before_revoke_audits, 1);
    sqlx::query("UPDATE token SET revoked_at = now() WHERE id = $1")
        .bind(fixture.second_active.id)
        .execute(&superuser)
        .await
        .expect("revoke previously accepted credential");
    expect_auth_failure(
        post_json(
            &client,
            &base,
            Some(&fixture.second_active.raw),
            Some(MODERN_VERSION),
            Some("server/discover"),
            &auth_body,
            false,
        )
        .await,
        401,
        "Bearer error=\"invalid_token\", scope=\"agent:port:connect\"",
    )
    .await;
    assert_eq!(
        last_used_value(&superuser, fixture.second_active.id).await,
        before_revoke_touch
    );
    assert_eq!(
        audit_count(
            &superuser,
            fixture.second_active.id,
            "auth.agent_bearer.used"
        )
        .await,
        before_revoke_audits
    );

    // Membership is an independent liveness predicate, not just an issuance
    // precondition. Removing it kills every bearer for the actor on the next
    // request and produces no false actor side effect.
    let membership_touch = last_used_value(&superuser, fixture.active.id).await;
    let membership_audits = all_token_audit_count(&superuser, fixture.active.id).await;
    sqlx::query("DELETE FROM workspace_membership WHERE workspace_id = $1 AND member_id = $2")
        .bind(fixture.workspace)
        .bind(fixture.agent)
        .execute(&superuser)
        .await
        .expect("remove active agent workspace membership");
    expect_auth_failure(
        post_json(
            &client,
            &base,
            Some(&fixture.active.raw),
            Some(MODERN_VERSION),
            Some("server/discover"),
            &auth_body,
            false,
        )
        .await,
        401,
        "Bearer error=\"invalid_token\", scope=\"agent:port:connect\"",
    )
    .await;
    assert_eq!(
        last_used_value(&superuser, fixture.active.id).await,
        membership_touch
    );
    assert_eq!(
        all_token_audit_count(&superuser, fixture.active.id).await,
        membership_audits
    );

    let audit_texts: Vec<String> =
        sqlx::query_scalar("SELECT detail::text FROM audit_log WHERE workspace_id IN ($1, $2)")
            .bind(fixture.workspace)
            .bind(fixture.foreign_workspace)
            .fetch_all(&superuser)
            .await
            .expect("load bounded audit detail text");
    let audit_text = audit_texts.join("\n");
    for credential in [
        &fixture.active,
        &fixture.second_active,
        &fixture.no_scope,
        &fixture.revoked,
        &fixture.expired,
        &fixture.cross_workspace,
        &fixture.human_bearer,
        &fixture.inactive_agent,
    ] {
        let secret = credential
            .raw
            .rsplit('.')
            .next()
            .expect("credential envelope has a secret segment");
        let digest = token_hash_hex(&superuser, credential.id).await;
        assert!(
            !audit_text.contains(&credential.raw),
            "audit details must not retain a raw Agent Port bearer"
        );
        assert!(
            !audit_text.contains(&digest),
            "audit details retain a token hash"
        );
        assert!(
            !audit_text.contains(&secret[..secret.len().min(24)]),
            "audit details retain a unique bearer secret prefix"
        );
    }
    assert!(
        !audit_text.contains(&fixture.human_jwt),
        "audit details must not retain a human JWT"
    );
    assert!(!audit_text.contains("oort-pg-conformance"));

    let hidden_own_audits =
        momo_db::with_tenant_tx(&app_rls_probe, fixture.foreign_workspace, move |conn| {
            Box::pin(async move {
                sqlx::query_scalar::<_, i64>(
                    "SELECT count(*) FROM audit_log WHERE workspace_id = $1",
                )
                .bind(fixture.workspace)
                .fetch_one(conn)
                .await
                .map_err(momo_db::DbError::from)
            })
        })
        .await
        .expect("probe FORCE RLS through momo_app");
    assert_eq!(
        hidden_own_audits, 0,
        "foreign tenant GUC must hide own audits"
    );
    assert_eq!(
        product_counts(&superuser).await,
        before,
        "discover/list/auth/rate-independent traffic must not write product data"
    );
}

async fn expect_rate_limit(response: reqwest::Response) {
    assert_eq!(response.status(), 429);
    assert_stateless_headers(&response);
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .expect("rate denial carries a numeric Retry-After");
    assert!((1..=60).contains(&retry_after));
    assert_eq!(
        response.json::<Value>().await.expect("rate error JSON"),
        json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": {"code": -32029, "message": "rate limit exceeded"}
        })
    );
}

#[tokio::test]
#[ignore = "requires isolated PostgreSQL 18; run scripts/verify_agent_port.sh"]
async fn token_agent_and_socket_peer_rate_axes_are_independent() {
    ensure_schema_and_roles();
    let superuser = superuser_pool().await;
    let fixture = seed_fixture(&superuser).await;
    let before = product_counts(&superuser).await;
    let client = reqwest::Client::new();
    let body = modern_request(json!(1), "server/discover");

    let token_base = start_server(
        momo_app_pool().await,
        AgentPortConfig {
            external_origin: None,
            window_seconds: 60,
            per_token_limit: 1,
            per_agent_limit: 0,
            per_ip_limit: 0,
            hosted_delivery_enabled: false,
            oauth: Default::default(),
        },
    )
    .await;
    let first = post_json(
        &client,
        &token_base,
        Some(&fixture.active.raw),
        Some(MODERN_VERSION),
        Some("server/discover"),
        &body,
        false,
    )
    .await;
    assert_eq!(first.status(), 200);
    let token_touch_after_allow = last_used_value(&superuser, fixture.active.id).await;
    let token_used_after_allow =
        audit_count(&superuser, fixture.active.id, "auth.agent_bearer.used").await;
    for _ in 0..12 {
        expect_rate_limit(
            post_json(
                &client,
                &token_base,
                Some(&fixture.active.raw),
                Some(MODERN_VERSION),
                Some("server/discover"),
                &body,
                false,
            )
            .await,
        )
        .await;
    }
    assert_eq!(
        last_used_value(&superuser, fixture.active.id).await,
        token_touch_after_allow,
        "repeated 429s must not touch last_used_at"
    );
    assert_eq!(
        audit_count(&superuser, fixture.active.id, "auth.agent_bearer.used").await,
        token_used_after_allow,
        "repeated 429s must not write used audits"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_log \
             WHERE via_token_id = $1 \
               AND action = 'agent_port.rate_limit.denied' \
               AND detail->>'axis' = 'token'",
        )
        .bind(fixture.active.id)
        .fetch_one(&superuser)
        .await
        .expect("count bounded token denial audits"),
        1,
        "one token bucket emits at most one denial audit per window"
    );

    let agent_base = start_server(
        momo_app_pool().await,
        AgentPortConfig {
            external_origin: None,
            window_seconds: 60,
            per_token_limit: 0,
            per_agent_limit: 1,
            per_ip_limit: 0,
            hosted_delivery_enabled: false,
            oauth: Default::default(),
        },
    )
    .await;
    let first_agent = post_json(
        &client,
        &agent_base,
        Some(&fixture.active.raw),
        Some(MODERN_VERSION),
        Some("server/discover"),
        &body,
        false,
    )
    .await;
    assert_eq!(first_agent.status(), 200);
    expect_rate_limit(
        post_json(
            &client,
            &agent_base,
            Some(&fixture.second_active.raw),
            Some(MODERN_VERSION),
            Some("server/discover"),
            &body,
            false,
        )
        .await,
    )
    .await;
    assert!(!last_used(&superuser, fixture.second_active.id).await);
    assert_eq!(
        audit_count(
            &superuser,
            fixture.second_active.id,
            "auth.agent_bearer.used"
        )
        .await,
        0
    );

    let missing_scope_base = start_server(
        momo_app_pool().await,
        AgentPortConfig {
            external_origin: None,
            window_seconds: 60,
            per_token_limit: 1,
            per_agent_limit: 0,
            per_ip_limit: 0,
            hosted_delivery_enabled: false,
            oauth: Default::default(),
        },
    )
    .await;
    expect_auth_failure(
        post_json(
            &client,
            &missing_scope_base,
            Some(&fixture.no_scope.raw),
            Some(MODERN_VERSION),
            Some("server/discover"),
            &body,
            false,
        )
        .await,
        403,
        "Bearer error=\"insufficient_scope\", scope=\"agent:port:connect\"",
    )
    .await;
    for _ in 0..8 {
        expect_rate_limit(
            post_json(
                &client,
                &missing_scope_base,
                Some(&fixture.no_scope.raw),
                Some(MODERN_VERSION),
                Some("server/discover"),
                &body,
                false,
            )
            .await,
        )
        .await;
    }
    assert_eq!(
        audit_count(
            &superuser,
            fixture.no_scope.id,
            "auth.agent_bearer.scope_denied"
        )
        .await,
        1,
        "missing-scope traffic is rate-admitted before its denial audit"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_log \
             WHERE via_token_id = $1 \
               AND action = 'agent_port.rate_limit.denied' \
               AND detail->>'axis' = 'token'",
        )
        .bind(fixture.no_scope.id)
        .fetch_one(&superuser)
        .await
        .expect("count missing-scope rate audit"),
        1
    );
    assert!(!last_used(&superuser, fixture.no_scope.id).await);

    let ip_base = start_server(
        momo_app_pool().await,
        AgentPortConfig {
            external_origin: None,
            window_seconds: 60,
            per_token_limit: 0,
            per_agent_limit: 0,
            per_ip_limit: 1,
            hosted_delivery_enabled: false,
            oauth: Default::default(),
        },
    )
    .await;
    let first_ip = post_json(
        &client,
        &ip_base,
        Some(&fixture.active.raw),
        Some(MODERN_VERSION),
        Some("server/discover"),
        &body,
        false,
    )
    .await;
    assert_eq!(first_ip.status(), 200);
    expect_rate_limit(
        post_json(
            &client,
            &ip_base,
            None,
            Some(MODERN_VERSION),
            Some("server/discover"),
            &body,
            false,
        )
        .await,
    )
    .await;

    let mut axes: Vec<String> = sqlx::query_scalar(
        "SELECT detail->>'axis' FROM audit_log \
         WHERE workspace_id = $1 \
           AND via_token_id = ANY($2::uuid[]) \
           AND action = 'agent_port.rate_limit.denied'",
    )
    .bind(fixture.workspace)
    .bind(vec![fixture.active.id, fixture.second_active.id])
    .fetch_all(&superuser)
    .await
    .expect("load authenticated rate-limit audit axes");
    axes.sort();
    assert_eq!(
        axes,
        vec!["agent".to_string(), "token".to_string()],
        "token and agent denials are audited; pre-auth socket peer has no invented actor"
    );
    let rate_details: Vec<Value> = sqlx::query_scalar(
        "SELECT detail FROM audit_log \
         WHERE workspace_id = $1 \
           AND via_token_id = ANY($2::uuid[]) \
           AND action = 'agent_port.rate_limit.denied'",
    )
    .bind(fixture.workspace)
    .bind(vec![fixture.active.id, fixture.second_active.id])
    .fetch_all(&superuser)
    .await
    .expect("load rate-limit audit details");
    for detail in rate_details {
        let axis = detail["axis"].as_str().expect("rate audit axis");
        assert_eq!(
            detail,
            json!({
                "schema": "oort.agent_port.rate_limit.v1",
                "axis": axis,
                "limit": 1,
                "window_seconds": 60
            })
        );
    }
    assert_eq!(
        product_counts(&superuser).await,
        before,
        "all three abuse-control axes must leave product tables untouched"
    );

    // Token and agent axes are individually atomic under concurrency. At most
    // one request is admitted, while every denial remains side-effect-free and
    // each axis emits at most its one first-denial audit for this window.
    let concurrent = seed_fixture(&superuser).await;
    let concurrent_base = start_server(
        momo_app_pool().await,
        AgentPortConfig {
            external_origin: None,
            window_seconds: 60,
            per_token_limit: 1,
            per_agent_limit: 1,
            per_ip_limit: 0,
            hosted_delivery_enabled: false,
            oauth: Default::default(),
        },
    )
    .await;
    let mut tasks = tokio::task::JoinSet::new();
    for request_id in 0..20 {
        let client = client.clone();
        let base = concurrent_base.clone();
        let token = concurrent.active.raw.clone();
        tasks.spawn(async move {
            post_json(
                &client,
                &base,
                Some(&token),
                Some(MODERN_VERSION),
                Some("server/discover"),
                &modern_request(json!(request_id), "server/discover"),
                false,
            )
            .await
            .status()
            .as_u16()
        });
    }
    let mut accepted = 0;
    let mut denied = 0;
    while let Some(result) = tasks.join_next().await {
        match result.expect("concurrent request task remains healthy") {
            200 => accepted += 1,
            429 => denied += 1,
            status => panic!("unexpected concurrent Agent Port status {status}"),
        }
    }
    assert_eq!(
        accepted, 1,
        "combined limiter must admit exactly one request"
    );
    assert_eq!(denied, 19);
    assert_eq!(
        audit_count(&superuser, concurrent.active.id, "auth.agent_bearer.used").await,
        i64::from(accepted)
    );
    let concurrent_denial_axes: Vec<String> = sqlx::query_scalar(
        "SELECT detail->>'axis' FROM audit_log \
         WHERE workspace_id = $1 AND action = 'agent_port.rate_limit.denied'",
    )
    .bind(concurrent.workspace)
    .fetch_all(&superuser)
    .await
    .expect("load concurrent limiter denial axes");
    let mut concurrent_denial_axes = concurrent_denial_axes;
    concurrent_denial_axes.sort();
    assert_eq!(
        concurrent_denial_axes,
        vec!["agent".to_string(), "token".to_string()],
        "each denied stable axis emits exactly its first-window audit"
    );
    assert_eq!(
        product_counts(&superuser).await,
        before,
        "concurrent limiter traffic must not create product writes"
    );
}
