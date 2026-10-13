//! ADR-0162 / #1366 HAP-E5 — the Agent Port tool surface, end to end.
//!
//! The real Axum router runs against a `momo_app` (NOBYPASSRLS) pool, so every
//! answer below is produced by the same code path a hosted adapter reaches over
//! HTTP. `DATABASE_URL` is a PostgreSQL 18 superuser URL used only for
//! migrations and fixtures. Run it through `scripts/verify_agent_port_tools.sh`
//! so the database is isolated, owned, and reclaimed.
//!
//! What is proved here rather than at the unit layer: the scope intersection
//! seen by a real credential in each lifecycle state, that a posted message
//! takes exactly one write path, that the lease verbs race correctly, that a
//! terminal run cannot be re-completed, and that a hosted agent whose connection
//! is not active is refused rather than silently handed to a managed provider.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::{AgentGatewayMode, AgentGatewaySettings, AgentPortConfig};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "agent-port-tools-pg-conformance-signing-secret";
const MODERN_VERSION: &str = "2026-07-28";
const LEGACY_VERSION: &str = "2025-11-25";
const PATH: &str = "/v1/mcp/agent-port";
const AUDIENCE: &str = "/v1/mcp/agent-port";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated PostgreSQL 18 URL")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

fn required_pg_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| {
        panic!("set {name}; scripts/verify_agent_port_tools.sh supplies private PG client env")
    })
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to the tools conformance DB as superuser")
}

/// The **`momo_notifier`** pool — the posture `momo-notifier` actually runs its
/// sweep in.
///
/// Not a convenience: step 1 of `sweep_expired_approvals` is a deliberately
/// cross-tenant read (`workspaces_with_overdue_approvals`) issued with no
/// `app.workspace_id` bound, because a sweep cannot know which tenants need
/// visiting until it looks. On a NOBYPASSRLS role that statement does not merely
/// return nothing — the RLS policy's `current_setting('app.workspace_id',
/// true)::uuid` casts an empty string and raises `22P02`. `momo_notifier` is one
/// of the two roles AGENTS.md keeps as a standing BYPASSRLS exception for
/// exactly this scan, so running the sweep on `momo_app` would be testing a
/// posture production never uses.
async fn momo_notifier_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(
            options.username("momo_notifier").password(
                &std::env::var("MOMO_NOTIFIER_PASSWORD")
                    .unwrap_or_else(|_| "momo_notifier_dev_pw".to_string()),
            ),
        )
        .await
        .expect("connect as momo_notifier after bootstrap_roles.sql")
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
        .expect("apply every migration on the tools conformance DB");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .args([
            "-h",
            &required_pg_env("PGHOST"),
            "-p",
            &required_pg_env("PGPORT"),
            "-U",
            &required_pg_env("PGUSER"),
            "-d",
        ])
        .arg(required_pg_env("PGDATABASE"))
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .env("PGPASSWORD", required_pg_env("PGPASSWORD"))
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

async fn start_server(pool: PgPool, hosted_delivery_enabled: bool) -> String {
    start_server_with_gateway(pool, hosted_delivery_enabled, false).await
}

async fn start_server_with_gateway(
    pool: PgPool,
    hosted_delivery_enabled: bool,
    gateway_mode: bool,
) -> String {
    let mut state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
    if gateway_mode {
        state = state.with_agent_gateway(AgentGatewaySettings {
            mode: AgentGatewayMode::Gateway,
            secret: "agent-port-tools-conformance-gateway-secret".to_string(),
            allow_legacy_secret: false,
        });
    }
    let state = state.with_agent_port(AgentPortConfig {
        external_origin: None,
        window_seconds: 60,
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        // The production gate is closed by default; the fixture is the only
        // thing allowed to open it before HAP-E6 (#1367).
        hosted_delivery_enabled,
        hosted_lease_seconds: momo_outbox::HOSTED_LEASE_SECONDS_DEFAULT,
        subscription_agents_enabled: true,
        // #3397: these suites drive Claude subscription agents; the opt-in is on.
        claude_subscription_agents_enabled: true,
        oauth: Default::default(),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind tools conformance server");
    let address: SocketAddr = listener.local_addr().expect("tools server address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

#[derive(Debug)]
struct Fixture {
    workspace: Uuid,
    #[allow(dead_code)]
    human: Uuid,
    human_jwt: String,
    hosted_agent: Uuid,
    hosted_connection: Uuid,
    hosted_token: Uuid,
    hosted_bearer: String,
    connect_only_bearer: String,
    managed_agent: Uuid,
    #[allow(dead_code)]
    connect_only_agent: Uuid,
    channel: Uuid,
    private_channel: Uuid,
}

fn raw_credential(workspace: Uuid) -> String {
    format!(
        "momo_agent_v1.{workspace}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

#[allow(clippy::too_many_arguments)]
async fn insert_hosted_token(
    pool: &PgPool,
    workspace: Uuid,
    agent: Uuid,
    connection: Uuid,
    raw: &str,
    scopes: &[&str],
    created_by: Uuid,
) -> Uuid {
    let scopes: Vec<String> = scopes.iter().map(|scope| (*scope).to_string()).collect();
    sqlx::query_scalar(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, created_by) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'),$4,'hosted agent port', \
                'hosted_active',$5,$6,$7) RETURNING id",
    )
    .bind(workspace)
    .bind(agent)
    .bind(raw)
    .bind(scopes)
    .bind(connection)
    .bind(AUDIENCE)
    .bind(created_by)
    .fetch_one(pool)
    .await
    .expect("seed hosted bearer")
}

async fn seed(pool: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("tools-{}", workspace.simple()))
        .execute(pool)
        .await
        .expect("seed workspace");

    let human = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human','Tools Human',$3)",
    )
    .bind(human)
    .bind(workspace)
    .bind(format!("human-{}", human.simple()))
    .execute(pool)
    .await
    .expect("seed human");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(human)
    .bind(workspace)
    .bind(format!("{human}@tools.test"))
    .execute(pool)
    .await
    .expect("seed human identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'owner')",
    )
    .bind(workspace)
    .bind(human)
    .execute(pool)
    .await
    .expect("seed human membership");

    let hosted_agent = Uuid::new_v4();
    let connect_only_agent = Uuid::new_v4();
    let managed_agent = Uuid::new_v4();
    // A hosted connection requires the ADR-0162 sentinel agent shape (migration
    // 069's trigger), so the two hosted identities carry it and the managed one
    // deliberately does not — that asymmetry is the mixed workspace under test.
    for (agent, handle, hosted) in [
        (hosted_agent, "hosted", true),
        (connect_only_agent, "connectonly", true),
        (managed_agent, "managed", false),
    ] {
        sqlx::query(
            "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
             VALUES($1,$2,'agent',$3,$4)",
        )
        .bind(agent)
        .bind(workspace)
        .bind(handle)
        .bind(format!("{handle}-{}", agent.simple()))
        .execute(pool)
        .await
        .expect("seed agent member");
        sqlx::query(
            "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id, config) \
             VALUES($1,$2,'hosted-agent',$3,$4,$5::jsonb)",
        )
        .bind(agent)
        .bind(workspace)
        .bind(if hosted {
            "https://hosted-agent.invalid/disabled"
        } else {
            "https://provider.invalid/v1"
        })
        .bind(human)
        .bind(if hosted {
            "{\"execution_mode\":\"hosted_dial_in\"}"
        } else {
            "{}"
        })
        .execute(pool)
        .await
        .expect("seed agent row");
        sqlx::query(
            "INSERT INTO workspace_membership(workspace_id, member_id, role) \
             VALUES($1,$2,'member')",
        )
        .bind(workspace)
        .bind(agent)
        .execute(pool)
        .await
        .expect("seed agent membership");
        sqlx::query(
            "INSERT INTO agent_profile(agent_member_id, workspace_id, updated_by, paused) \
             VALUES($1,$2,$3,false)",
        )
        .bind(agent)
        .bind(workspace)
        .bind(human)
        .execute(pool)
        .await
        .expect("seed agent profile");
    }

    let channel = Uuid::new_v4();
    let private_channel = Uuid::new_v4();
    for (id, name) in [(channel, "approved"), (private_channel, "unapproved")] {
        sqlx::query("INSERT INTO channel(id, workspace_id, kind, name) VALUES($1,$2,'public',$3)")
            .bind(id)
            .bind(workspace)
            .bind(format!("{name}-{}", id.simple()))
            .execute(pool)
            .await
            .expect("seed channel");
        sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
            .bind(id)
            .bind(workspace)
            .execute(pool)
            .await
            .expect("seed channel_seq");
        for member in [human, hosted_agent, connect_only_agent, managed_agent] {
            sqlx::query(
                "INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)",
            )
            .bind(workspace)
            .bind(id)
            .bind(member)
            .execute(pool)
            .await
            .expect("seed membership");
        }
    }

    let hosted_connection = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_consumed_at,detected_at,detected_by, \
           confirmed_by,confirmed_at,approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,$3,'detected',now(),now(),$4,$4,now(),$5, \
           ARRAY['agent:port:connect','agent:inbox:read','messages:read','messages:write', \
                 'agent:jobs:read','agent:runs:callback','workspace:propose']::text[],$4)",
    )
    .bind(hosted_connection)
    .bind(workspace)
    .bind(hosted_agent)
    .bind(human)
    .bind(vec![channel])
    .execute(pool)
    .await
    .expect("seed hosted connection");

    let hosted_bearer = raw_credential(workspace);
    let hosted_token = insert_hosted_token(
        pool,
        workspace,
        hosted_agent,
        hosted_connection,
        &hosted_bearer,
        &[
            "agent:port:connect",
            "agent:inbox:read",
            "messages:read",
            "messages:write",
            "agent:jobs:read",
            "agent:runs:callback",
            // ADR-0186 D2 — the fixture's hosted credential carries the propose
            // scope so the *narrowing* tests below have something to narrow. It
            // is not a default anywhere in the product.
            "workspace:propose",
        ],
        human,
    )
    .await;
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='active', active_token_id=$3, \
           proved_at=now(), proved_by=$4 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(hosted_connection)
    .bind(hosted_token)
    .bind(hosted_agent)
    .execute(pool)
    .await
    .expect("activate hosted connection");

    // A second, fully live connection whose human approval and token carry
    // reachability ONLY. It is the "connect alone opens zero product tools"
    // credential, and it is a real hosted connection rather than a crippled one.
    let connect_only_connection = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_consumed_at,detected_at,detected_by, \
           confirmed_by,confirmed_at,approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,$3,'detected',now(),now(),$4,$4,now(),$5, \
           ARRAY['agent:port:connect']::text[],$4)",
    )
    .bind(connect_only_connection)
    .bind(workspace)
    .bind(connect_only_agent)
    .bind(human)
    .bind(vec![channel])
    .execute(pool)
    .await
    .expect("seed connect-only connection");
    let connect_only_bearer = raw_credential(workspace);
    let connect_only_token = insert_hosted_token(
        pool,
        workspace,
        connect_only_agent,
        connect_only_connection,
        &connect_only_bearer,
        &["agent:port:connect"],
        human,
    )
    .await;
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='active', active_token_id=$3, \
           proved_at=now(), proved_by=$4 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connect_only_connection)
    .bind(connect_only_token)
    .bind(connect_only_agent)
    .execute(pool)
    .await
    .expect("activate connect-only connection");

    let human_jwt = momo_auth::sign_access(human, workspace, &[], TEST_JWT_SECRET)
        .expect("sign a human App JWT")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'tools-conformance')",
    )
    .bind(workspace)
    .bind(human)
    .bind(&human_jwt)
    .execute(pool)
    .await
    .expect("record the human session token");

    Fixture {
        workspace,
        human,
        human_jwt,
        hosted_agent,
        hosted_connection,
        hosted_token,
        hosted_bearer,
        connect_only_bearer,
        managed_agent,
        connect_only_agent,
        channel,
        private_channel,
    }
}

// ---------------------------------------------------------------------------
// wire helpers
// ---------------------------------------------------------------------------

fn modern_body(method: &str, id: Value, extra: Value) -> Value {
    let mut params = json!({
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {}
        }
    });
    for (key, value) in extra.as_object().expect("extra params are an object") {
        params
            .as_object_mut()
            .expect("params object")
            .insert(key.clone(), value.clone());
    }
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

async fn call(
    client: &reqwest::Client,
    base: &str,
    bearer: &str,
    tool: &str,
    arguments: Value,
) -> (u16, Value) {
    let body = modern_body(
        "tools/call",
        json!(Uuid::new_v4().to_string()),
        json!({"name": tool, "arguments": arguments}),
    );
    let response = client
        .post(format!("{base}{PATH}"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", "tools/call")
        .header("mcp-name", tool)
        .bearer_auth(bearer)
        .json(&body)
        .send()
        .await
        .expect("tools/call responds");
    let status = response.status().as_u16();
    let value: Value = response.json().await.expect("JSON-RPC body");
    (status, value)
}

/// Like [`call`], but a refusal at the transport/auth layer carries no JSON-RPC
/// body (an inactive credential is answered before the tool runs): that is
/// `(status, None)` rather than a decode panic.
async fn call_maybe_empty_3530(
    client: &reqwest::Client,
    base: &str,
    bearer: &str,
    tool: &str,
    arguments: Value,
) -> (u16, Option<Value>) {
    let body = modern_body(
        "tools/call",
        json!(Uuid::new_v4().to_string()),
        json!({"name": tool, "arguments": arguments}),
    );
    let response = client
        .post(format!("{base}{PATH}"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", "tools/call")
        .header("mcp-name", tool)
        .bearer_auth(bearer)
        .json(&body)
        .send()
        .await
        .expect("tools/call responds");
    let status = response.status().as_u16();
    (status, response.json().await.ok())
}

async fn list_tools(client: &reqwest::Client, base: &str, bearer: &str) -> Vec<String> {
    let body = modern_body("tools/list", json!(1), json!({}));
    let response = client
        .post(format!("{base}{PATH}"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", "tools/list")
        .bearer_auth(bearer)
        .json(&body)
        .send()
        .await
        .expect("tools/list responds");
    assert_eq!(response.status().as_u16(), 200);
    let value: Value = response.json().await.expect("JSON-RPC body");
    value["result"]["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .map(|tool| tool["name"].as_str().expect("tool name").to_string())
        .collect()
}

fn structured(value: &Value) -> &Value {
    &value["result"]["structuredContent"]
}

fn error_code(value: &Value) -> i64 {
    value["error"]["code"]
        .as_i64()
        .expect("json-rpc error code")
}

// ---------------------------------------------------------------------------
// (1) the catalog a credential sees, per lifecycle state
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_advertised_catalog_follows_the_connection_lifecycle_and_the_scopes() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();

    let all = list_tools(&client, &base, &fixture.hosted_bearer).await;
    assert_eq!(
        all,
        vec![
            "oort_inbox_read",
            "oort_conversation_read",
            "oort_message_post",
            "oort_jobs_claim",
            "oort_job_renew",
            "oort_job_release",
            "oort_run_event",
            "oort_run_complete",
            "oort_action_propose",
            "oort_card_suggest",
            "oort_ping",
        ]
    );

    // `agent:port:connect` alone is reachability, not capability.
    assert!(list_tools(&client, &base, &fixture.connect_only_bearer)
        .await
        .is_empty());
    let (status, refused) = call(
        &client,
        &base,
        &fixture.connect_only_bearer,
        "oort_message_post",
        json!({"channelId": fixture.channel, "clientMsgId": Uuid::new_v4(), "body": "hi"}),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(error_code(&refused), -32602, "invisible reads as unknown");

    // Narrowing the human approval alone closes the tools it opened, and the
    // credential's own scopes are unchanged.
    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_scopes = \
           ARRAY['agent:port:connect','agent:inbox:read']::text[] \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .execute(&su)
    .await
    .unwrap();
    assert_eq!(
        list_tools(&client, &base, &fixture.hosted_bearer).await,
        vec!["oort_inbox_read", "oort_ping"]
    );

    // Narrowing the token alone does the same from the other side.
    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_scopes = \
           ARRAY['agent:port:connect','agent:inbox:read','messages:read','messages:write', \
                 'agent:jobs:read','agent:runs:callback','workspace:propose']::text[] \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query("UPDATE token SET scopes=ARRAY['agent:port:connect','messages:read']::text[] WHERE workspace_id=$1 AND id=$2")
        .bind(fixture.workspace)
        .bind(fixture.hosted_token)
        .execute(&su)
        .await
        .unwrap();
    assert_eq!(
        list_tools(&client, &base, &fixture.hosted_bearer).await,
        vec!["oort_conversation_read"]
    );
    sqlx::query(
        "UPDATE token SET scopes=ARRAY['agent:port:connect','agent:inbox:read','messages:read', \
           'messages:write','agent:jobs:read','agent:runs:callback','workspace:propose']::text[] \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_token)
    .execute(&su)
    .await
    .unwrap();

    // A `detected` connection is the one non-active state that answers: a
    // foundation request is exactly what proves possession, so `tools/list`
    // activates it (HAP-E3) and then lists what the human approved. That is the
    // documented activation path, not a leak — the connection was already
    // confirmed by a human and the credential is the one it minted.
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='detected', proved_at=NULL, proved_by=NULL \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .execute(&su)
    .await
    .unwrap();
    assert_eq!(
        list_tools(&client, &base, &fixture.hosted_bearer)
            .await
            .len(),
        11,
        "a foundation request proves the binding and re-activates it"
    );
    let reactivated: String = sqlx::query_scalar(
        "SELECT status FROM hosted_agent_connection WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(reactivated, "active");

    // Every non-active lifecycle state is stronger than an empty catalog: the
    // proof step refuses the binding outright, so the request never reaches
    // `tools/list` at all and the credential answers 401.
    //
    // `disconnected` is deliberately NOT in this loop. Migration 073 makes the
    // terminal state one a row never leaves (#1386 F3), so a fixture that
    // visits it cannot come back — and this test needs the connection alive for
    // everything after. It is asserted at the very end instead, where the
    // one-way door is the fixture's last move rather than an obstacle.
    for status in ["expired", "cleanup_pending"] {
        sqlx::query("UPDATE hosted_agent_connection SET status=$3 WHERE workspace_id=$1 AND id=$2")
            .bind(fixture.workspace)
            .bind(fixture.hosted_connection)
            .bind(status)
            .execute(&su)
            .await
            .unwrap_or_else(|error| panic!("set status {status}: {error}"));
        let listing = client
            .post(format!("{base}{PATH}"))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", MODERN_VERSION)
            .header("mcp-method", "tools/list")
            .bearer_auth(&fixture.hosted_bearer)
            .json(&modern_body("tools/list", json!(1), json!({})))
            .send()
            .await
            .expect("tools/list responds");
        assert_eq!(listing.status().as_u16(), 401, "{status}");
    }
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='active' WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .execute(&su)
    .await
    .unwrap();
    // A live `active` connection has a live credential and no cleanup in
    // flight, so the fixture is restoring a *state* rather than one column.
    sqlx::query("UPDATE token SET revoked_at=NULL WHERE workspace_id=$1 AND id=$2")
        .bind(fixture.workspace)
        .bind(fixture.hosted_token)
        .execute(&su)
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM hosted_agent_connection_artifact WHERE workspace_id=$1 AND connection_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .execute(&su)
    .await
    .unwrap();
    // A rejected proof also pauses the profile (HAP-E3's fail-closed
    // invalidation), so the fixture restores it before the next axis.
    sqlx::query(
        "UPDATE agent_profile SET paused=false WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    assert_eq!(
        list_tools(&client, &base, &fixture.hosted_bearer)
            .await
            .len(),
        11,
        "restoring the connection restores the catalog"
    );

    // A paused agent also advertises nothing — the human pause outranks the
    // approval, on the listing as well as on the call.
    sqlx::query(
        "UPDATE agent_profile SET paused=true WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    assert!(list_tools(&client, &base, &fixture.hosted_bearer)
        .await
        .is_empty());
    sqlx::query(
        "UPDATE agent_profile SET paused=false WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();

    // The legacy era answers with the same catalog: one mapping, two eras.
    let legacy = client
        .post(format!("{base}{PATH}"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", LEGACY_VERSION)
        .header("mcp-method", "tools/list")
        .bearer_auth(&fixture.hosted_bearer)
        .json(&json!({"jsonrpc":"2.0","id":9,"method":"tools/list","params":{}}))
        .send()
        .await
        .expect("legacy tools/list");
    let legacy: Value = legacy.json().await.expect("legacy body");
    let legacy_names: Vec<String> = legacy["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(legacy_names, all);

    // ---- and the terminal state, last, because it is one-way ---------------
    //
    // `disconnected` is the one lifecycle state that cannot be fabricated:
    // migration 072 asserts that the row arrives from `cleanup_pending`, that a
    // manifest exists at all, that no required artifact is unresolved, that no
    // credential is live and that the dedicated agent is paused. So the fixture
    // performs the local half the lifecycle performs — including one seeded,
    // already-resolved manifest row — and then does not put it back, because
    // migration 073 refuses to let anything put it back.
    sqlx::query("UPDATE token SET revoked_at=now() WHERE workspace_id=$1 AND id=$2")
        .bind(fixture.workspace)
        .bind(fixture.hosted_token)
        .execute(&su)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE agent_profile SET paused=true WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO hosted_agent_connection_artifact \
           (workspace_id, connection_id, agent_member_id, kind, expected_action, \
            current_status, disposition, source, acknowledged_at) \
         VALUES ($1,$2,$3,'secret','revoke','absent','revoked','server_verified',now())",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    for status in ["cleanup_pending", "disconnected"] {
        sqlx::query("UPDATE hosted_agent_connection SET status=$3 WHERE workspace_id=$1 AND id=$2")
            .bind(fixture.workspace)
            .bind(fixture.hosted_connection)
            .bind(status)
            .execute(&su)
            .await
            .unwrap_or_else(|error| panic!("set status {status}: {error}"));
    }
    let terminal = client
        .post(format!("{base}{PATH}"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", "tools/list")
        .bearer_auth(&fixture.hosted_bearer)
        .json(&modern_body("tools/list", json!(1), json!({})))
        .send()
        .await
        .expect("tools/list responds");
    assert_eq!(terminal.status().as_u16(), 401, "disconnected");
    let revival = sqlx::query(
        "UPDATE hosted_agent_connection SET status='active' WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .execute(&su)
    .await
    .expect_err("073 refuses to reopen a terminal connection");
    assert_eq!(
        revival
            .as_database_error()
            .expect("a database error")
            .message(),
        "hosted connection cannot leave disconnected for active",
        "a hosted agent comes back as a new connection or not at all"
    );
}

// ---------------------------------------------------------------------------
// (2) reads and the single write path
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_read_and_write_tools_use_the_existing_domains_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();

    // ---- oort_message_post: one message, one outbox row, idempotent --------
    let client_msg_id = Uuid::new_v4();
    let (status, first) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_message_post",
        json!({"channelId": fixture.channel, "clientMsgId": client_msg_id, "body": "hello from hosted"}),
    )
    .await;
    assert_eq!(status, 200, "{first}");
    let message_id = structured(&first)["messageId"]
        .as_str()
        .expect("messageId")
        .to_string();
    assert_eq!(structured(&first)["deduplicated"], json!(false));

    let (status, replay) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_message_post",
        json!({"channelId": fixture.channel, "clientMsgId": client_msg_id, "body": "hello from hosted"}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        structured(&replay)["messageId"],
        json!(message_id),
        "client_msg_id idempotency is the messenger's, not a second one"
    );
    assert_eq!(structured(&replay)["deduplicated"], json!(true));

    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id=$1 AND client_msg_id=$2",
    )
    .bind(fixture.workspace)
    .bind(client_msg_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(rows, 1, "a retry must not write a second message");
    let broadcasts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='broadcast' \
           AND payload->'data'->'payload'->>'id' = $2",
    )
    .bind(fixture.workspace)
    .bind(&message_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        broadcasts, 1,
        "exactly one outbox row — the tool never publishes directly"
    );

    // ---- oort_conversation_read: the same read, the same visibility --------
    let (status, page) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_conversation_read",
        json!({"channelId": fixture.channel, "limit": 10}),
    )
    .await;
    assert_eq!(status, 200);
    let messages = structured(&page)["messages"].as_array().expect("messages");
    assert!(messages.iter().any(|m| m["id"] == json!(message_id)));

    // An unapproved channel, and a channel that does not exist, answer alike.
    let (unapproved_status, unapproved) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_conversation_read",
        json!({"channelId": fixture.private_channel}),
    )
    .await;
    let (absent_status, absent) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_conversation_read",
        json!({"channelId": Uuid::new_v4()}),
    )
    .await;
    assert_eq!(unapproved_status, absent_status);
    assert_eq!(error_code(&unapproved), error_code(&absent));
    assert_eq!(error_code(&unapproved), -32004);

    // Posting into an unapproved channel is the same refusal.
    let (post_status, post_refused) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_message_post",
        json!({"channelId": fixture.private_channel, "clientMsgId": Uuid::new_v4(), "body": "no"}),
    )
    .await;
    assert_eq!(post_status, 409);
    assert_eq!(error_code(&post_refused), -32004);

    // ---- oort_inbox_read: the durable projection of that same message ------
    // The human's own message reaches the hosted inbox because the send spine
    // fans out inside the send transaction; the agent's own message does not.
    let human_message: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": "a human speaks"}))
        .send()
        .await
        .expect("human send")
        .json()
        .await
        .expect("human send body");
    let human_message_id = human_message["id"]
        .as_str()
        .expect("message id")
        .to_string();

    let (status, inbox) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_inbox_read",
        json!({"limit": 50}),
    )
    .await;
    assert_eq!(status, 200, "{inbox}");
    let events = structured(&inbox)["events"].as_array().expect("events");
    assert!(
        events
            .iter()
            .any(|event| event["messageId"] == json!(human_message_id)),
        "the human's message is projected into the hosted inbox"
    );
    assert!(
        !events
            .iter()
            .any(|event| event["messageId"] == json!(message_id)),
        "an agent never receives its own utterance back"
    );
    for event in events {
        for forbidden in ["inboxSeq", "sourceOutboxId", "outboxId", "jobId"] {
            assert!(
                event.get(forbidden).is_none(),
                "{forbidden} must stay inside"
            );
        }
    }
    let cursor = structured(&inbox)["nextCursor"]
        .as_str()
        .expect("opaque cursor")
        .to_string();
    assert!(cursor.starts_with("momo_inbox_cursor_v1."));
    let (status, empty) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_inbox_read",
        json!({"cursor": cursor, "limit": 50}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(structured(&empty)["events"], json!([]));

    // A cursor that does not open — the shape a rotated cursor secret produces
    // — is refused. It never silently restarts from the beginning.
    let (status, rotated) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_inbox_read",
        json!({"cursor": "momo_inbox_cursor_v1.AAAA"}),
    )
    .await;
    assert_eq!(status, 409);
    assert_eq!(error_code(&rotated), -32004);
}

// ---------------------------------------------------------------------------
// (3) the job/run half: leases, races, terminal rules, opaque handles
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_job_and_run_tools_share_the_gateway_lease_and_terminal_rules() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();

    // A human mention produces the run and the job through the selector.
    let trigger: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "body": format!("@{} please answer", hosted_handle(&su, fixture.hosted_agent).await)
        }))
        .send()
        .await
        .expect("mention send")
        .json()
        .await
        .expect("mention body");
    assert!(trigger["id"].is_string(), "{trigger}");

    let job_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND method='gateway' AND partition_key=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    let diagnostic: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT action, detail->>'reason' FROM audit_log WHERE workspace_id=$1 \
           AND action LIKE 'agent.mention.%' ORDER BY created_at DESC LIMIT 5",
    )
    .bind(fixture.workspace)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(
        job_rows, 1,
        "the hosted selector emitted exactly one job; mention audits: {diagnostic:?}"
    );
    let inbox_jobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_agent_inbox_event WHERE workspace_id=$1 \
           AND connection_id=$2 AND event_kind='agent_job'",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(inbox_jobs, 1, "…and its inbox reference, in the same tx");
    // No wake broadcast on the agent's partition key: the hosted runtime is
    // woken by its inbox, and that row is what 071 refuses to be confused with.
    let wake_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='broadcast' \
           AND partition_key=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(wake_rows, 0);

    // ---- claim ------------------------------------------------------------
    let (status, claimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{claimed}");
    let jobs = structured(&claimed)["jobs"].as_array().expect("jobs");
    assert_eq!(jobs.len(), 1);
    let handle = jobs[0]["leaseHandle"].as_str().expect("handle").to_string();
    assert!(handle.starts_with("momo_lease_v1."));
    let rendered = serde_json::to_string(&jobs[0]).unwrap();
    assert!(!rendered.contains("\"jobId\""));
    assert!(!rendered.contains("\"runId\""));
    assert!(!rendered.contains("\"leaseId\""));
    assert!(jobs[0]["work"]["channelId"].is_string());

    // A second claim finds nothing: the first one holds the lease.
    let (_, again) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({}),
    )
    .await;
    assert_eq!(structured(&again)["jobs"], json!([]));

    // ---- renew / release --------------------------------------------------
    let (status, renewed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_job_renew",
        json!({"leaseHandle": handle}),
    )
    .await;
    assert_eq!(status, 200, "{renewed}");
    assert_eq!(structured(&renewed)["status"], json!("renewed"));

    let (status, released) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_job_release",
        json!({"leaseHandle": handle}),
    )
    .await;
    assert_eq!(status, 200, "{released}");
    // A second release, and a renew after release, both lose: the lease is gone.
    for tool in ["oort_job_release", "oort_job_renew"] {
        let (status, lost) = call(
            &client,
            &base,
            &fixture.hosted_bearer,
            tool,
            json!({"leaseHandle": handle}),
        )
        .await;
        assert_eq!(status, 409, "{tool}");
        assert_eq!(error_code(&lost), -32005, "{tool}");
    }

    // ---- re-claim, then the run callbacks ---------------------------------
    let (_, reclaimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({}),
    )
    .await;
    let handle = structured(&reclaimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .expect("re-claimed handle")
        .to_string();

    let event_id = Uuid::new_v4();
    for _ in 0..2 {
        let (status, event) = call(
            &client,
            &base,
            &fixture.hosted_bearer,
            "oort_run_event",
            json!({"leaseHandle": handle, "status": "thinking", "eventId": event_id}),
        )
        .await;
        assert_eq!(status, 200, "{event}");
    }
    let event_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 \
           AND action='agent.gateway.status' AND detail->>'event_id'=$2",
    )
    .bind(fixture.workspace)
    .bind(event_id.to_string())
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(event_audits, 1, "a replayed event id is one state change");

    let (status, completed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_complete",
        json!({
            "leaseHandle": handle,
            "status": "succeeded",
            "body": "here is the answer",
            "usage": {"model": "hosted-agent", "promptTokens": 10, "completionTokens": 4}
        }),
    )
    .await;
    assert_eq!(status, 200, "{completed}");
    let answer_id = structured(&completed)["messageId"]
        .as_str()
        .expect("answer id")
        .to_string();

    // A replayed completion returns the same message rather than a second one.
    let (status, replayed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_complete",
        json!({"leaseHandle": handle, "status": "succeeded", "body": "here is the answer"}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(structured(&replayed)["messageId"], json!(answer_id));

    // A *different* terminal verdict cannot overwrite the one that stuck.
    let (status, contradiction) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_complete",
        json!({"leaseHandle": handle, "status": "failed", "error": "changed my mind"}),
    )
    .await;
    assert_eq!(status, 200, "a replay answers, it does not re-decide");
    assert_eq!(structured(&contradiction)["messageId"], json!(answer_id));
    let run_status: String = sqlx::query_scalar(
        "SELECT status::text FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(run_status, "succeeded");

    // A progress event after the terminal state is refused.
    let (status, late) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_event",
        json!({"leaseHandle": handle, "status": "running"}),
    )
    .await;
    assert_eq!(status, 409);
    assert_eq!(error_code(&late), -32005);

    // Exactly one usage row for the whole turn.
    let usage_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM usage_ledger WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(usage_rows, 1, "a replayed completion must not bill twice");
}

// ---------------------------------------------------------------------------
// (4) the selector: mixed workspace, fail-closed, no managed fallback
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_inactive_hosted_agent_fails_closed_and_never_falls_back_to_managed() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();

    // Take the hosted connection out of `active` while leaving the agent live.
    //
    // HAP-E6's migration 072 refuses a fabricated `disconnected` on four
    // counts: it must arrive from `cleanup_pending`, the manifest must exist,
    // no required artifact may be unresolved, and the local half (zero live
    // credentials, paused agent) must hold. So the fixture walks the lifecycle
    // — revoke, pause, `cleanup_pending`, seed one resolved row, terminal — and
    // then unpauses the agent again, which is what makes the selector's answer
    // below about the CONNECTION rather than about the pause.
    sqlx::query("UPDATE token SET revoked_at=now() WHERE workspace_id=$1 AND id=$2")
        .bind(fixture.workspace)
        .bind(fixture.hosted_token)
        .execute(&su)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE agent_profile SET paused=true WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='cleanup_pending', active_token_id=NULL \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO hosted_agent_connection_artifact \
           (workspace_id, connection_id, agent_member_id, kind, expected_action, \
            current_status, disposition, source, acknowledged_at) \
         VALUES ($1,$2,$3,'secret','revoke','absent','revoked','server_verified',now())",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='disconnected' \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE agent_profile SET paused=false WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();

    let handle = hosted_handle(&su, fixture.hosted_agent).await;
    let sent: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": format!("@{handle} hello")}))
        .send()
        .await
        .expect("mention send")
        .json()
        .await
        .expect("mention body");
    assert!(sent["id"].is_string(), "the human's message still lands");

    let jobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND partition_key=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        jobs, 0,
        "no job at all — not a managed one, which is what a fallback would be"
    );
    let runs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(runs, 0, "and no run was created either");
    let reason: String = sqlx::query_scalar(
        "SELECT detail->>'reason' FROM audit_log WHERE workspace_id=$1 \
           AND action='agent.mention.skipped' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(reason, "hosted_connection_unavailable");
    // #2871 — a workspace hosted agent without a live connection says so.
    let notices = hosted_notices(&su, fixture.workspace, fixture.channel).await;
    assert_eq!(notices.len(), 1, "one visible line: {notices:?}");
    assert_notice(
        &notices[0],
        fixture.hosted_agent,
        fixture.human,
        "hosted_connection_unavailable",
        "의 연결이 끊겨 있어서 답하지 못했어요. \
         워크스페이스 관리자가 AI › 외부 연결에서 다시 연결할 수 있어요.",
    );
    assert_eq!(
        notices[0]["props"]["notice_action"]["href"],
        json!("/settings?section=agents")
    );
    assert_notice_broadcast(&su, fixture.workspace, &notices[0]).await;

    // The managed agent in the SAME workspace and channel is unaffected.
    let managed_handle = hosted_handle(&su, fixture.managed_agent).await;
    client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": format!("@{managed_handle} hello")}))
        .send()
        .await
        .expect("managed mention send");
    let managed_jobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND method='publish' AND partition_key=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.managed_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        managed_jobs, 1,
        "a managed agent keeps its existing worker path in a mixed workspace"
    );
    let managed_inbox: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_agent_inbox_event WHERE workspace_id=$1 \
           AND agent_member_id=$2 AND event_kind='agent_job'",
    )
    .bind(fixture.workspace)
    .bind(fixture.managed_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(managed_inbox, 0, "and produces no hosted projection");
}

/// The production gate is closed by default, and closed means *skipped*, never
/// "delivered another way".
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_closed_production_gate_routes_a_hosted_agent_nowhere() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, false).await;
    let client = reqwest::Client::new();

    let handle = hosted_handle(&su, fixture.hosted_agent).await;
    client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": format!("@{handle} hello")}))
        .send()
        .await
        .expect("mention send");

    let jobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND partition_key=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(jobs, 0);
    let reason: String = sqlx::query_scalar(
        "SELECT detail->>'reason' FROM audit_log WHERE workspace_id=$1 \
           AND action='agent.mention.skipped' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(reason, "hosted_delivery_not_enabled");

    // #2871 ① one visible line, in the main timeline under the call, with the
    // operator guide as the way out.
    let notices = hosted_notices(&su, fixture.workspace, fixture.channel).await;
    assert_eq!(notices.len(), 1, "one visible line: {notices:?}");
    assert_notice(
        &notices[0],
        fixture.hosted_agent,
        fixture.human,
        "hosted_delivery_not_enabled",
        "에게 메시지를 전달하지 못했어요. 이 서버에서 외부 에이전트 전달이 꺼져 있어요. \
         서버 관리자에게 [켜는 방법](https://github.com/yeomyeonggeori/oort/blob/main/docs/SELF_HOST.md#hosted-agent-agent-port-on-self-host)을 전해 주세요.",
    );
    assert!(
        notices[0]["root_id"].is_null(),
        "a top-level call is answered top-level"
    );
    assert!(notices[0]["props"].get("notice_action").is_none());
    assert_notice_broadcast(&su, fixture.workspace, &notices[0]).await;

    // ② the same person again inside ten minutes → no second line, one audit.
    let mention = |body: String| {
        let client = client.clone();
        let url = format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        );
        let jwt = fixture.human_jwt.clone();
        async move {
            let sent: Value = client
                .post(url)
                .bearer_auth(jwt)
                .json(&json!({"clientMsgId": Uuid::new_v4(), "body": body}))
                .send()
                .await
                .expect("mention send")
                .json()
                .await
                .expect("mention body");
            sent
        }
    };
    mention(format!("@{handle} again")).await;
    assert_eq!(
        hosted_notices(&su, fixture.workspace, fixture.channel)
            .await
            .len(),
        1,
        "the throttle holds the repeat back"
    );
    let throttled: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 \
           AND action='agent.hosted_skip.notice_throttled'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(throttled, 1, "and says so in the audit log");

    // ③ a call inside a thread is a different conversation: told there.
    let root: Value = mention("a thread root".to_string()).await;
    let root_id = root["id"].as_str().expect("root id").to_string();
    let reply: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "body": format!("@{handle} in a thread"),
            "rootId": root_id,
        }))
        .send()
        .await
        .expect("thread mention")
        .json()
        .await
        .expect("thread mention body");
    assert!(reply["id"].is_string(), "{reply}");
    let notices = hosted_notices(&su, fixture.workspace, fixture.channel).await;
    assert_eq!(notices.len(), 2, "one more, in the thread: {notices:?}");
    assert_eq!(
        notices[1]["root_id"].as_str().map(str::to_lowercase),
        Some(root_id.to_lowercase()),
        "posted into the thread the caller spoke in"
    );

    // ④ after ten minutes the top-level repeat is told again.
    sqlx::query(
        "UPDATE message SET created_at = created_at - make_interval(mins => 11) \
          WHERE workspace_id=$1 AND props->>'source'='server.hosted_agent.notice.v1'",
    )
    .bind(fixture.workspace)
    .execute(&su)
    .await
    .unwrap();
    mention(format!("@{handle} later")).await;
    assert_eq!(
        hosted_notices(&su, fixture.workspace, fixture.channel)
            .await
            .len(),
        3,
        "the throttle is a window, not permanent silence"
    );

    // ⑤ RLS: another workspace's GUC sees none of these lines.
    let app_reader = momo_app_pool().await;
    let mut tx = app_reader.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(Uuid::new_v4().to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let foreign: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE props->>'source'='server.hosted_agent.notice.v1'",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(foreign, 0, "another workspace sees zero rows");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(fixture.workspace.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let own: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE props->>'source'='server.hosted_agent.notice.v1'",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(own, 3, "and the owning workspace sees them through RLS");
    tx.rollback().await.unwrap();

    let jobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND partition_key=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(jobs, 0, "telling is not delivering");
    // The tools themselves stay reachable: the gate is on delivery, and the
    // human already approved this connection's scopes.
    assert!(!list_tools(&client, &base, &fixture.hosted_bearer)
        .await
        .is_empty());
}

/// #2871 H-1 — a 1:1 DM can never be approved for hosted delivery
/// (`confirm_hosted_connection_in_tx` takes `kind <> 'dm'` only), so the
/// line there must not ask anyone to approve it, and must not open a door to a
/// screen that refuses DMs. The audit still records the gate that refused it.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_dm_with_a_hosted_agent_says_dms_are_not_delivered_without_a_door() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();

    let dm = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, dm_key, created_by) \
         VALUES ($1, $2, 'dm', NULL, NULL, $3, $4)",
    )
    .bind(dm)
    .bind(fixture.workspace)
    .bind(dm.to_string())
    .bind(fixture.human)
    .execute(&su)
    .await
    .expect("seed dm");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(dm)
        .bind(fixture.workspace)
        .execute(&su)
        .await
        .expect("seed dm seq");
    for member in [fixture.human, fixture.hosted_agent] {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(fixture.workspace)
        .bind(dm)
        .bind(member)
        .execute(&su)
        .await
        .expect("seed dm membership");
    }

    // ADR-0162 증보 2 — the owner's own DM now opens by rule, so the
    // never-opens case is an agent with no owner (B1: nobody can approve).
    sqlx::query("UPDATE agent SET owner_human_id=NULL WHERE member_id=$1")
        .bind(fixture.hosted_agent)
        .execute(&su)
        .await
        .expect("drop owner");
    // Security review Medium-3: whoever names the agent must not be able to
    // plant a link in this server-voiced line.
    sqlx::query("UPDATE member SET display_name=$2 WHERE id=$1")
        .bind(fixture.hosted_agent)
        .bind("[보안 재인증](https://evil.example)")
        .execute(&su)
        .await
        .expect("rename agent");

    // No handle: the 1:1 DM rule addresses the agent by itself.
    let sent: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{dm}/messages",
            fixture.workspace
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": "배포 결과 정리해줄래요?"}))
        .send()
        .await
        .expect("dm send")
        .json()
        .await
        .expect("dm body");
    assert!(sent["id"].is_string(), "{sent}");

    let reason: String = sqlx::query_scalar(
        "SELECT detail->>'reason' FROM audit_log WHERE workspace_id=$1 \
           AND action='agent.mention.skipped' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        reason, "hosted_channel_unapproved",
        "the gate that refused it"
    );

    let notices = hosted_notices(&su, fixture.workspace, dm).await;
    assert_eq!(notices.len(), 1, "one visible line: {notices:?}");
    assert_notice(
        &notices[0],
        fixture.hosted_agent,
        fixture.human,
        "hosted_dm_not_approvable",
        "에게 전달되지 않아요. 외부 에이전트는 승인된 채널이나 1:1 대화에서 불러 주세요.",
    );
    let body = notices[0]["body"].as_str().unwrap();
    assert!(
        !body.contains("승인해"),
        "never asks to approve a DM: {body}"
    );
    assert_eq!(
        body,
        "이 대화는 ［보안 재인증］(https：//evil.example)에게 전달되지 않아요. \
         외부 에이전트는 승인된 채널이나 1:1 대화에서 불러 주세요.",
        "the name is inert: no `[..](..)` and no `http(s)://` survive"
    );
    assert!(
        notices[0]["props"].get("notice_action").is_none(),
        "no door to a screen that refuses DMs"
    );
    assert_notice_broadcast(&su, fixture.workspace, &notices[0]).await;
}

/// #2871 — the hosted skip lines in one channel, oldest first.
async fn hosted_notices(pool: &PgPool, workspace: Uuid, channel: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT jsonb_build_object('id', id, 'type', type, 'body', body, \
                'author', author_member_id, 'root_id', root_id, 'props', props) \
           FROM message WHERE workspace_id=$1 AND channel_id=$2 \
            AND props->>'source'='server.hosted_agent.notice.v1' ORDER BY seq",
    )
    .bind(workspace)
    .bind(channel)
    .fetch_all(pool)
    .await
    .expect("hosted notices")
}

fn assert_notice(notice: &Value, agent: Uuid, caller: Uuid, reason: &str, body_tail: &str) {
    assert_eq!(notice["type"], "system", "{notice}");
    assert_eq!(
        notice["author"],
        json!(agent),
        "authored by the agent member"
    );
    assert_eq!(notice["props"]["kind"], "agent_hosted_skip");
    assert_eq!(notice["props"]["reason"], reason);
    assert_eq!(notice["props"]["notice_for_member_id"], json!(caller));
    let body = notice["body"].as_str().expect("body");
    assert!(body.ends_with(body_tail), "{body}");
}

/// The line reached realtime the only legal way: a broadcast outbox row
/// written beside it.
async fn assert_notice_broadcast(pool: &PgPool, workspace: Uuid, notice: &Value) {
    let id = notice["id"].as_str().expect("notice id").to_lowercase();
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='broadcast' \
           AND lower(payload::text) LIKE '%' || $2 || '%'",
    )
    .bind(workspace)
    .bind(id)
    .fetch_one(pool)
    .await
    .expect("broadcast rows");
    assert!(rows >= 1, "the notice has a broadcast outbox row");
}

async fn hosted_handle(pool: &PgPool, member: Uuid) -> String {
    sqlx::query_scalar("SELECT handle FROM member WHERE id=$1")
        .bind(member)
        .fetch_one(pool)
        .await
        .expect("member handle")
}

// ---------------------------------------------------------------------------
// (5) the managed REST gateway still works, and its answer reaches hosted
//     inboxes
//
// Two findings meet in one scenario, because they are the same run:
//
//   * the uuid comparisons in the gateway lease statements are case-folded, and
//     this is the proof on the **REST** surface the widening actually changed.
//     `mention_job_payload` writes ids uppercase, so reverting either `lower()`
//     turns the claim below into an empty list and every later verb into a 409.
//   * `complete_gateway_run_in_tx` projects the answer it writes into hosted
//     inboxes. The completing agent here is managed and a hosted agent shares
//     the channel, so the hosted inbox must receive a `message` event for an
//     answer nobody posted through the product send path.
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_managed_mention_job_survives_the_whole_rest_gateway_round_trip() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server_with_gateway(app, true, true).await;
    let client = reqwest::Client::new();

    // One bearer carrying both callback scopes, bound to the managed agent.
    let gateway_bearer = raw_credential(fixture.workspace);
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'), \
                ARRAY['agent:jobs:read','agent:runs:callback']::text[],'tools-rest-gateway')",
    )
    .bind(fixture.workspace)
    .bind(fixture.managed_agent)
    .bind(&gateway_bearer)
    .execute(&su)
    .await
    .expect("seed managed gateway bearer");

    let managed_handle = hosted_handle(&su, fixture.managed_agent).await;
    let trigger: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "body": format!("@{managed_handle} answer over REST")
        }))
        .send()
        .await
        .expect("mention send")
        .json()
        .await
        .expect("mention body");
    assert!(trigger["id"].is_string(), "{trigger}");

    // The producer really did write the ids uppercase — without this the test
    // could pass against a payload that never needed folding.
    let raw_run_id: String = sqlx::query_scalar(
        "SELECT payload->>'run_id' FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND partition_key=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.managed_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        raw_run_id,
        raw_run_id.to_uppercase(),
        "mention_job_payload writes uppercase ids; that is what the fold exists for"
    );
    assert_ne!(
        raw_run_id,
        raw_run_id.to_lowercase(),
        "a uuid with no letters would make this test vacuous"
    );

    // ---- claim over REST ---------------------------------------------------
    let pending: Value = client
        .get(format!(
            "{base}/v1/workspaces/{}/agents/{}/gateway/jobs/pending",
            fixture.workspace, fixture.managed_agent
        ))
        .bearer_auth(&gateway_bearer)
        .send()
        .await
        .expect("pending jobs responds")
        .json()
        .await
        .expect("pending jobs body");
    let jobs = pending["jobs"].as_array().expect("jobs array");
    assert_eq!(
        jobs.len(),
        1,
        "an uppercase-id mention job must be claimable over REST: {pending}"
    );
    let job_id = jobs[0]["id"].as_i64().expect("job id");
    let lease_id = jobs[0]["leaseId"].as_str().expect("lease id").to_string();
    let run_id = jobs[0]["runId"].as_str().expect("run id").to_string();

    // ---- renew over REST ---------------------------------------------------
    let renewed = client
        .post(format!(
            "{base}/v1/workspaces/{}/agents/{}/gateway/jobs/{job_id}/lease/renew",
            fixture.workspace, fixture.managed_agent
        ))
        .bearer_auth(&gateway_bearer)
        .json(&json!({"job_id": job_id, "lease_id": lease_id}))
        .send()
        .await
        .expect("renew responds");
    assert_eq!(renewed.status().as_u16(), 200, "renew must find the lease");

    // ---- complete over REST ------------------------------------------------
    let completed = client
        .post(format!(
            "{base}/v1/workspaces/{}/agent-runs/{run_id}/gateway/complete",
            fixture.workspace
        ))
        .bearer_auth(&gateway_bearer)
        .json(&json!({
            "job_id": job_id,
            "lease_id": lease_id,
            "status": "succeeded",
            "body": "the managed answer"
        }))
        .send()
        .await
        .expect("complete responds");
    assert_eq!(completed.status().as_u16(), 200);
    let completed: Value = completed.json().await.expect("complete body");
    let answer_id = completed["messageId"]
        .as_str()
        .expect("answer id")
        .to_string();

    // …and the settle really landed, which is the third folded predicate.
    let settled: String =
        sqlx::query_scalar("SELECT status::text FROM outbox WHERE workspace_id=$1 AND id=$2")
            .bind(fixture.workspace)
            .bind(job_id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(settled, "done", "settle_gateway_job_in_tx folds too");

    // ---- the hosted co-agent receives that answer --------------------------
    let (status, inbox) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_inbox_read",
        json!({"limit": 50}),
    )
    .await;
    assert_eq!(status, 200, "{inbox}");
    let events = structured(&inbox)["events"].as_array().expect("events");
    assert!(
        events
            .iter()
            .any(|event| event["messageId"] == json!(answer_id)),
        "a gateway-completed answer must reach a hosted co-agent's inbox: {events:?}"
    );

    // The completing agent is managed and holds no connection, so nothing was
    // written for it; and the answer was authored by it, so the fan-out's
    // author exclusion is what kept it out of its own inbox had it had one.
    let managed_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_agent_inbox_event WHERE workspace_id=$1 \
           AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.managed_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(managed_events, 0);
}

// ---------------------------------------------------------------------------
// (6) the human's exact-channel grant reaches the JOB path
//
// HAP-E3 confirms a connection for a NAMED set of channels. Channel membership
// is not that grant — an agent can be a member of a room the operator never
// approved for hosted delivery. The E4 inbox already refused such a room; this
// pins that the job path refuses it too, at both layers and independently.
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_unapproved_channel_never_reaches_the_hosted_job_path() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let handle = hosted_handle(&su, fixture.hosted_agent).await;

    // (a) The agent is a member of `private_channel` but the human approved
    //     only `channel`. A mention there must produce nothing at all.
    let sent: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.private_channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": format!("@{handle} secret room")}))
        .send()
        .await
        .expect("mention send")
        .json()
        .await
        .expect("mention body");
    assert!(sent["id"].is_string(), "the human's message still lands");

    let reason: String = sqlx::query_scalar(
        "SELECT detail->>'reason' FROM audit_log WHERE workspace_id=$1 \
           AND action='agent.mention.skipped' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(reason, "hosted_channel_unapproved");
    // #2871 — the caller is told, in that room, and shown the door.
    let notices = hosted_notices(&su, fixture.workspace, fixture.private_channel).await;
    assert_eq!(notices.len(), 1, "one visible line: {notices:?}");
    assert_notice(
        &notices[0],
        fixture.hosted_agent,
        fixture.human,
        "hosted_channel_unapproved",
        "에게 승인되지 않아서 전달하지 못했어요. \
         워크스페이스 관리자가 AI › 외부 연결에서 이 채널을 승인할 수 있어요.",
    );
    assert_eq!(
        notices[0]["props"]["notice_action"],
        json!({"label": "에이전트 자격 열기", "href": "/settings?section=agents"})
    );
    assert_notice_broadcast(&su, fixture.workspace, &notices[0]).await;

    let (status, claimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "{claimed}");
    assert_eq!(
        structured(&claimed)["jobs"],
        json!([]),
        "an unapproved room's prompt must never be claimable"
    );
    let unapproved_inbox: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_agent_inbox_event WHERE workspace_id=$1 \
           AND connection_id=$2 AND source_channel_id=$3",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .bind(fixture.private_channel)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(unapproved_inbox, 0, "and the inbox is untouched");

    // (b) A job created while a channel WAS approved must stop being claimable
    //     the moment the approval is narrowed — the claim re-reads the grant,
    //     so this holds even though the selector already ran and said yes.
    //     Proved by approving the private channel, producing a job there, and
    //     narrowing back before the claim.
    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_channel_ids=ARRAY[$3,$4]::uuid[] \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .bind(fixture.channel)
    .bind(fixture.private_channel)
    .execute(&su)
    .await
    .unwrap();
    client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.private_channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": format!("@{handle} now approved")}))
        .send()
        .await
        .expect("mention send");
    let created: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND partition_key=$2 AND lower(payload->>'channel_id')=lower($3::text)",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .bind(fixture.private_channel.to_string())
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(created, 1, "the approved room really did produce a job");

    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_channel_ids=ARRAY[$3]::uuid[] \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .bind(fixture.channel)
    .execute(&su)
    .await
    .unwrap();
    let (status, after_narrowing) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        structured(&after_narrowing)["jobs"],
        json!([]),
        "narrowing the approval must stop the claim, not merely the producer"
    );
    let leased: Option<Uuid> = sqlx::query_scalar(
        "SELECT lease_owner FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND partition_key=$2 AND lower(payload->>'channel_id')=lower($3::text)",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .bind(fixture.private_channel.to_string())
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(leased, None, "and it is left pending, never leased");

    // (c) No over-narrowing: the approved channel still round-trips.
    client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": format!("@{handle} approved room")}))
        .send()
        .await
        .expect("mention send");
    let (status, approved) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "{approved}");
    let jobs = structured(&approved)["jobs"].as_array().expect("jobs");
    assert_eq!(jobs.len(), 1, "the approved room is unaffected: {approved}");
    let lease_handle = jobs[0]["leaseHandle"].as_str().expect("handle").to_string();
    assert_eq!(
        jobs[0]["work"]["channelId"],
        json!(fixture.channel.to_string().to_uppercase()),
        "and the work it hands over is the approved room's"
    );

    // …and a lease already in hand stops authorizing when its channel's
    // approval is withdrawn mid-flight.
    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_channel_ids=ARRAY[$3]::uuid[] \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .bind(fixture.private_channel)
    .execute(&su)
    .await
    .unwrap();
    for tool in [
        "oort_job_renew",
        "oort_job_release",
        "oort_run_event",
        "oort_run_complete",
    ] {
        let mut arguments = json!({"leaseHandle": lease_handle});
        if tool == "oort_run_complete" {
            arguments["status"] = json!("succeeded");
        }
        let (status, refused) = call(&client, &base, &fixture.hosted_bearer, tool, arguments).await;
        assert_eq!(status, 403, "{tool} must fail closed: {refused}");
        assert_eq!(error_code(&refused), -32003, "{tool}");
    }
}

// ---------------------------------------------------------------------------
// (7) the published schema is the enforced schema
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_advertised_argument_schema_is_what_execution_accepts() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();

    // A misspelled optional field used to be dropped, posting an unthreaded
    // message while the caller believed it had opened a thread.
    let before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id=$1 AND channel_id=$2")
            .bind(fixture.workspace)
            .bind(fixture.channel)
            .fetch_one(&su)
            .await
            .unwrap();
    let (status, refused) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_message_post",
        json!({
            "channelId": fixture.channel,
            "clientMsgId": Uuid::new_v4(),
            "body": "typo'd thread",
            "rootID": Uuid::new_v4()
        }),
    )
    .await;
    assert_eq!(status, 400, "{refused}");
    assert_eq!(error_code(&refused), -32602);
    let after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id=$1 AND channel_id=$2")
            .bind(fixture.workspace)
            .bind(fixture.channel)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(after, before, "an unknown field must post nothing");

    // One out-of-bounds numeric per tool family, plus the negative token count
    // that would have subtracted from a workspace's usage totals.
    for (tool, arguments) in [
        ("oort_inbox_read", json!({"limit": 0})),
        (
            "oort_conversation_read",
            json!({"channelId": fixture.channel, "limit": 5000}),
        ),
        ("oort_jobs_claim", json!({"limit": -1})),
        (
            "oort_run_complete",
            json!({
                "leaseHandle": "momo_lease_v1.AAAA",
                "status": "succeeded",
                "usage": {"promptTokens": -5}
            }),
        ),
        // A wrong type and a malformed uuid are the same refusal.
        ("oort_conversation_read", json!({"channelId": "not-a-uuid"})),
        (
            "oort_run_event",
            json!({"leaseHandle": "momo_lease_v1.AAAA", "status": "succeeded"}),
        ),
        // ADR-0186: the proposal surface is narrower than the REST surface it
        // will execute through, and the narrowing is enforced before any
        // transaction opens — an id outside the registry, a role the card may
        // not ask for, and a use count past the proposal ceiling that
        // `POST …/invites` itself would have accepted.
        (
            "oort_action_propose",
            json!({"handle": "momo_lease_v1.AAAA", "actionId": "webhook.create", "args": {}}),
        ),
        (
            "oort_action_propose",
            json!({"handle": "momo_lease_v1.AAAA", "actionId": "invite.create",
                   "args": {"role": "guest"}}),
        ),
        (
            "oort_action_propose",
            json!({"handle": "momo_lease_v1.AAAA", "actionId": "invite.create",
                   "args": {"maxUses": 101}}),
        ),
        (
            "oort_action_propose",
            json!({"handle": "momo_lease_v1.AAAA", "actionId": "invite.create",
                   "args": {"maxUse": 1}}),
        ),
    ] {
        let (status, refused) = call(&client, &base, &fixture.hosted_bearer, tool, arguments).await;
        assert_eq!(status, 400, "{tool} must refuse: {refused}");
        assert_eq!(error_code(&refused), -32602, "{tool}");
    }

    let ledger: i64 = sqlx::query_scalar("SELECT count(*) FROM usage_ledger WHERE workspace_id=$1")
        .bind(fixture.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(ledger, 0, "a refused usage block writes no ledger row");

    // ---- the three ways the schema used to diverge from execution ---------

    // (i) `null` on a required field is refused; `null` on an optional one is
    //     the wire's way of omitting it and still posts.
    let (status, refused) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_message_post",
        json!({
            "channelId": fixture.channel,
            "clientMsgId": Uuid::new_v4(),
            "body": Value::Null
        }),
    )
    .await;
    assert_eq!(status, 400, "{refused}");
    assert_eq!(error_code(&refused), -32602);
    let (status, posted) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_message_post",
        json!({
            "channelId": fixture.channel,
            "clientMsgId": Uuid::new_v4(),
            "body": "null rootId means absent",
            "rootId": Value::Null
        }),
    )
    .await;
    assert_eq!(status, 200, "{posted}");

    // (ii) A multibyte body over the BYTE ceiling is refused at the validator,
    //      not discovered later by the adapter.
    //
    //      2,001 emoji: 2,001 characters (a quarter of the published 8,000) and
    //      8,004 bytes (just over it). Deliberately just over rather than wildly
    //      over, because `momo_mcp::MAX_STRING_BYTES` bounds any single wire
    //      string at 8 KiB and would otherwise refuse it first with -32600 —
    //      which is correct but would test the transport instead of the schema.
    //
    //      This asserts the **observable contract**: the caller gets one
    //      invalid-arguments answer and nothing is written. It does not isolate
    //      which layer refused, and it cannot, because the whole point of the
    //      fix is that the validator and the adapter now refuse at the same
    //      byte. `momo_mcp::tools::tests::string_bounds_are_counted_in_bytes`
    //      is the isolating proof: it calls the validator directly and turns
    //      RED the moment the count goes back to characters.
    let before_emoji: i64 =
        sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id=$1 AND channel_id=$2")
            .bind(fixture.workspace)
            .bind(fixture.channel)
            .fetch_one(&su)
            .await
            .unwrap();
    let (status, oversize) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_message_post",
        json!({
            "channelId": fixture.channel,
            "clientMsgId": Uuid::new_v4(),
            "body": "\u{1F600}".repeat(2_001)
        }),
    )
    .await;
    assert_eq!(status, 400, "{oversize}");
    assert_eq!(error_code(&oversize), -32602);
    let after_emoji: i64 =
        sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id=$1 AND channel_id=$2")
            .bind(fixture.workspace)
            .bind(fixture.channel)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(after_emoji, before_emoji, "an oversize body posts nothing");
    // The same text measured the other way would have passed: this is the
    // divergence, stated as an assertion rather than a comment.
    let emoji = "\u{1F600}".repeat(2_001);
    assert!(emoji.chars().count() < 8_000 && emoji.len() > 8_000);
    assert!(emoji.len() <= momo_mcp::MAX_STRING_BYTES);

    // (iii) A token count above the ledger column's ceiling is refused by the
    //       declared maximum rather than by a narrowing nobody advertised.
    let (status, overflow) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_complete",
        json!({
            "leaseHandle": "momo_lease_v1.AAAA",
            "status": "succeeded",
            "usage": {"promptTokens": 2_147_483_648_i64}
        }),
    )
    .await;
    assert_eq!(status, 400, "{overflow}");
    assert_eq!(error_code(&overflow), -32602);
}

// ---------------------------------------------------------------------------
// (8) ADR-0186 D2 — proposing parks the run and nothing else happens
// ---------------------------------------------------------------------------

/// The whole propose axis, end to end, against the real router.
///
/// What this proves that no unit test can: that the approval, the card and the
/// run transition land in **one** transaction on a real database; that the
/// parked run is genuinely unreachable by the two verbs that would strand it;
/// that **no** `agent_job` is enqueued (ADR-0186 §5 — 제안 경로에 resume job 0건);
/// that a decision on a `workspace_action` is refused without consuming the
/// approval while AX-3b is unlanded; and that the expiry sweep settles it
/// instead of tripping over a payload shaped unlike a tool call.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_proposal_parks_the_run_and_opens_no_other_path() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();

    // ---- the run, from a human mention, exactly as production makes one ----
    let trigger: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "body": format!("@{} 초대 링크 하나 만들어줘", hosted_handle(&su, fixture.hosted_agent).await)
        }))
        .send()
        .await
        .expect("mention send")
        .json()
        .await
        .expect("mention body");
    assert!(trigger["id"].is_string(), "{trigger}");

    // ---- red proof 1: the scope, on both halves -----------------------------
    //
    // Narrow the credential alone and the tool disappears from the listing and
    // answers `unknown tool` when called — the same answer a tool that does not
    // exist gets, so a refusal cannot be used to discover the catalog.
    sqlx::query(
        "UPDATE token SET scopes=ARRAY['agent:port:connect','agent:inbox:read','messages:read', \
           'messages:write','agent:jobs:read','agent:runs:callback']::text[] \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_token)
    .execute(&su)
    .await
    .unwrap();
    let narrowed = list_tools(&client, &base, &fixture.hosted_bearer).await;
    assert!(
        !narrowed.contains(&"oort_action_propose".to_string()),
        "a credential without workspace:propose must not see the tool: {narrowed:?}"
    );
    let (status, invisible) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_action_propose",
        json!({"handle": "momo_lease_v1.AAAA", "actionId": "invite.create", "args": {}}),
    )
    .await;
    assert_eq!(status, 400, "{invisible}");
    assert_eq!(error_code(&invisible), -32602, "invisible reads as unknown");
    sqlx::query(
        "UPDATE token SET scopes=ARRAY['agent:port:connect','agent:inbox:read','messages:read', \
           'messages:write','agent:jobs:read','agent:runs:callback','workspace:propose']::text[] \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_token)
    .execute(&su)
    .await
    .unwrap();

    // …and the human's half closes it just as completely.
    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_scopes = \
           ARRAY['agent:port:connect','agent:inbox:read','messages:read','messages:write', \
                 'agent:jobs:read','agent:runs:callback']::text[] \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .execute(&su)
    .await
    .unwrap();
    assert!(
        !list_tools(&client, &base, &fixture.hosted_bearer)
            .await
            .contains(&"oort_action_propose".to_string()),
        "an unapproved scope closes the tool even when the credential carries it"
    );
    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_scopes = \
           ARRAY['agent:port:connect','agent:inbox:read','messages:read','messages:write', \
                 'agent:jobs:read','agent:runs:callback','workspace:propose']::text[] \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .execute(&su)
    .await
    .unwrap();

    // ---- claim, then propose ----------------------------------------------
    let (status, claimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{claimed}");
    let jobs = structured(&claimed)["jobs"].as_array().expect("jobs");
    assert_eq!(jobs.len(), 1);
    let handle = jobs[0]["leaseHandle"].as_str().expect("handle").to_string();

    let agent_jobs_before = agent_job_count(&su, fixture.workspace, fixture.hosted_agent).await;

    let (status, proposed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_action_propose",
        json!({
            "handle": handle,
            "actionId": "invite.create",
            "args": {"role": "member", "maxUses": 2, "expiresInDays": 3},
            "rationale": "새 팀원 온보딩 요청"
        }),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let result = structured(&proposed);
    assert_eq!(result["status"], json!("pending"));
    let approval_id = Uuid::parse_str(result["approvalId"].as_str().expect("approvalId"))
        .expect("approvalId is a uuid");
    let card_message_id = Uuid::parse_str(result["cardMessageId"].as_str().expect("cardMessageId"))
        .expect("cardMessageId is a uuid");
    assert!(result["expiresAtMs"].as_i64().expect("expiresAtMs") > 0);
    // Nothing internal crosses the wire, here as everywhere else.
    let rendered = result.to_string();
    for hidden in ["runId", "run_id", "jobId", "leaseId", "code", "secret"] {
        assert!(!rendered.contains(hidden), "{hidden} leaked: {rendered}");
    }

    // ---- red proof 2: one transaction wrote all three things ---------------
    let (action_type, approval_status, payload, request_message_id, requested_by, channel_id): (
        String,
        String,
        Value,
        Option<Uuid>,
        Uuid,
        Uuid,
    ) = sqlx::query_as(
        "SELECT action_type, status::text, payload, request_message_id, requested_by, channel_id \
           FROM approval WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(approval_id)
    .fetch_one(&su)
    .await
    .expect("the approval row exists");
    assert_eq!(action_type, "workspace_action");
    assert_eq!(approval_status, "pending");
    assert_eq!(requested_by, fixture.hosted_agent, "the agent asked");
    assert_eq!(channel_id, fixture.channel);
    assert_eq!(request_message_id, Some(card_message_id), "card ↔ approval");
    assert_eq!(payload["action"]["id"], json!("invite.create"));
    // The **normalised** args, not what the agent typed: the card and the
    // executor must be reading the same numbers.
    assert_eq!(
        payload["action"]["args"],
        json!({"role": "member", "maxUses": 2, "expiresInDays": 3})
    );
    assert_eq!(payload["action"]["rationale"], json!("새 팀원 온보딩 요청"));
    assert_eq!(
        payload["proposed_by"],
        json!(fixture.hosted_agent.to_string())
    );
    assert_eq!(
        payload["resume_model"],
        Value::Null,
        "a workspace action is never resumed into a model"
    );
    assert!(payload.get("tool_call").is_none());

    let (message_type, author, props, message_run_id): (String, Uuid, Value, Option<Uuid>) =
        sqlx::query_as(
            "SELECT type::text, author_member_id, props, run_id FROM message \
              WHERE workspace_id=$1 AND id=$2",
        )
        .bind(fixture.workspace)
        .bind(card_message_id)
        .fetch_one(&su)
        .await
        .expect("the card exists");
    assert_eq!(message_type, "approval_request");
    assert_eq!(author, fixture.hosted_agent, "the card is the agent's own");
    assert!(message_run_id.is_some(), "the card belongs to the run");
    assert_eq!(props["approval_id"], json!(approval_id.to_string()));
    assert_eq!(props["action_type"], json!("workspace_action"));
    assert_eq!(props["status"], json!("pending"));
    assert_eq!(props["action"]["id"], json!("invite.create"));
    assert_eq!(props["action"]["required_role"], json!("admin"));
    assert_eq!(
        props["action"]["rows"],
        json!([
            {"label": "역할", "value": "member"},
            {"label": "사용 횟수", "value": "2회"},
            {"label": "만료", "value": "3일"}
        ])
    );

    let (run_status, deadline_at): (String, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as(
            "SELECT r.status::text, r.deadline_at FROM agent_run r \
               JOIN approval a ON a.run_id = r.id \
              WHERE a.workspace_id=$1 AND a.id=$2",
        )
        .bind(fixture.workspace)
        .bind(approval_id)
        .fetch_one(&su)
        .await
        .expect("the run exists");
    assert_eq!(run_status, "awaiting_approval");
    assert!(
        deadline_at.is_some(),
        "the hold is bounded — without a deadline one unanswered card silences the agent"
    );

    // **No new outbox producer.** The card's broadcast is `send_message_in_tx`'s
    // own; not one extra `agent_job` was enqueued for this agent.
    assert_eq!(
        agent_job_count(&su, fixture.workspace, fixture.hosted_agent).await,
        agent_jobs_before,
        "a proposal enqueues no job — the decision executes it, nothing resumes it"
    );

    // ---- red proof 3: the parked run refuses the two settling verbs --------
    for (tool, arguments) in [
        (
            "oort_run_complete",
            json!({"leaseHandle": handle, "status": "succeeded", "body": "끝냈습니다"}),
        ),
        ("oort_job_release", json!({"leaseHandle": handle})),
    ] {
        let (status, refused) = call(&client, &base, &fixture.hosted_bearer, tool, arguments).await;
        assert_eq!(status, 409, "{tool} must refuse a parked run: {refused}");
        assert_eq!(error_code(&refused), -32005, "{tool}");
    }
    // Renewing while a person decides is exactly right, so it is NOT guarded.
    let (status, renewed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_job_renew",
        json!({"leaseHandle": handle}),
    )
    .await;
    assert_eq!(
        status, 200,
        "a parked run may still hold its lease: {renewed}"
    );

    // A second proposal on the same parked run is a conflict, not a second card.
    let (status, again) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_action_propose",
        json!({"handle": handle, "actionId": "invite.create", "args": {}}),
    )
    .await;
    assert_eq!(status, 409, "{again}");
    assert_eq!(error_code(&again), -32005);
    let cards: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id=$1 AND type='approval_request'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(cards, 1, "one proposal, one card");

    // ---- the proposal is still pending, and nothing has resumed ------------
    //
    // The approve arm is AX-3b's (#2509) and is measured end to end by
    // `an_approved_workspace_action_mints_the_invite_and_shows_the_link_once`,
    // which needs its own parked run because approving closes this one. What
    // this test keeps measuring is the proposal axis: the card is live in a real
    // channel and *nothing* has taken the generic resume path.
    let still_pending: String =
        sqlx::query_scalar("SELECT status::text FROM approval WHERE workspace_id=$1 AND id=$2")
            .bind(fixture.workspace)
            .bind(approval_id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(
        still_pending, "pending",
        "a proposal waits for a person; nothing else settles it"
    );
    assert_eq!(
        agent_job_count(&su, fixture.workspace, fixture.hosted_agent).await,
        agent_jobs_before,
        "and no resume job exists for it"
    );

    // ---- REJECT is open, and is the only way a person says no --------------
    //
    // **ADR-0186 D2: 「거부·만료: 기존 arm 그대로」.** The temporary approve-side
    // refusal must not take the reject side with it. If it did, a person looking
    // at their own agent's proposal would have no way to say no: the card stays
    // pending and the run stays parked, and because `agent.max_concurrent_runs`
    // defaults to **1** and `awaiting_approval` counts as live, that agent
    // answers nothing at all until the one-hour TTL expires — with nothing
    // anywhere saying why.
    let messages_before = channel_message_count(&su, fixture.workspace, fixture.channel).await;
    let reject_status = decide(&client, &base, &fixture, approval_id, false).await;
    assert_eq!(
        reject_status, 200,
        "rejecting a workspace action must work — the executor is what is unlanded, not the refusal"
    );

    let rejected: String =
        sqlx::query_scalar("SELECT status::text FROM approval WHERE workspace_id=$1 AND id=$2")
            .bind(fixture.workspace)
            .bind(approval_id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(rejected, "rejected");

    let run_after_reject: String = sqlx::query_scalar(
        "SELECT r.status::text FROM agent_run r JOIN approval a ON a.run_id = r.id \
          WHERE a.workspace_id=$1 AND a.id=$2",
    )
    .bind(fixture.workspace)
    .bind(approval_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        run_after_reject, "cancelled",
        "a rejection releases the concurrency gate"
    );

    // **The `tool_result` line actually reaches the channel.** This is what the
    // card's idempotency key was changed for: the rejection line is authored by
    // the same agent in the same channel and is keyed on `approval.id`, so a
    // card that had kept `approval.id` too would have collided with it on
    // `message_client_idem_uniq` and one of the two would have been silently
    // dropped. Counting rows is what makes that visible — a props assertion
    // alone would pass on the surviving row.
    let messages_after = channel_message_count(&su, fixture.workspace, fixture.channel).await;
    assert_eq!(
        messages_after - messages_before,
        1,
        "the rejection must add exactly one message (the tool_result) beside the card"
    );
    let (result_author, result_props): (Uuid, Value) = sqlx::query_as(
        "SELECT author_member_id, props FROM message \
          WHERE workspace_id=$1 AND channel_id=$2 AND type='tool_result' \
          ORDER BY seq DESC LIMIT 1",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .expect("the rejection tool_result is in the channel");
    assert_eq!(
        result_author, fixture.hosted_agent,
        "the outcome is authored by the agent whose proposal it was"
    );
    assert_eq!(result_props["approval_id"], json!(approval_id.to_string()));
    assert_eq!(result_props["status"], json!("rejected"));
    // The card and its outcome are two distinct rows with two distinct keys.
    let card_key: Option<Uuid> =
        sqlx::query_scalar("SELECT client_msg_id FROM message WHERE workspace_id=$1 AND id=$2")
            .bind(fixture.workspace)
            .bind(card_message_id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_ne!(
        card_key,
        Some(approval_id),
        "the card must not share the approval id with its own outcome line"
    );

    assert_eq!(
        agent_job_count(&su, fixture.workspace, fixture.hosted_agent).await,
        agent_jobs_before,
        "a rejection enqueues no resume job — the resume job is approve_run's alone"
    );

    // ---- the REAL expiry sweep settles a second proposal -------------------
    //
    // `momo_notifier::approval_sweep::sweep_expired_approvals` is the production
    // loop, called here **as itself** rather than re-assembled from the domain
    // calls it happens to make. Re-assembling it would prove only that the
    // re-assembly does not panic; the risk this guards is that the real sweep
    // *skips* a payload with no `tool_call` and leaves the run parked forever.
    let second = propose_on_a_fresh_run(&client, &base, &su, &fixture).await;
    let jobs_before_sweep = agent_job_count(&su, fixture.workspace, fixture.hosted_agent).await;
    sqlx::query(
        "UPDATE approval SET expires_at = now() - interval '1 minute' \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(second)
    .execute(&su)
    .await
    .unwrap();

    // The sweep runs on its own role, exactly as `momo-notifier` does.
    let notifier = momo_notifier_pool().await;
    let stats = momo_notifier::approval_sweep::sweep_expired_approvals(&notifier, 50)
        .await
        .expect("the production sweep must not fail on a workspace_action payload");
    assert!(
        stats.expired >= 1,
        "the production sweep must settle the overdue workspace action, got {stats:?}"
    );

    let expired: String =
        sqlx::query_scalar("SELECT status::text FROM approval WHERE workspace_id=$1 AND id=$2")
            .bind(fixture.workspace)
            .bind(second)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(expired, "expired");
    let run_after_sweep: String = sqlx::query_scalar(
        "SELECT r.status::text FROM agent_run r JOIN approval a ON a.run_id = r.id \
          WHERE a.workspace_id=$1 AND a.id=$2",
    )
    .bind(fixture.workspace)
    .bind(second)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        run_after_sweep, "timed_out",
        "an expired proposal MUST release the concurrency gate — otherwise one \
         unanswered card silences the agent permanently"
    );
    assert_eq!(
        agent_job_count(&su, fixture.workspace, fixture.hosted_agent).await,
        jobs_before_sweep,
        "expiry enqueues no resume job either — all three arms are job-free"
    );
    // The sweep's own expiry line reached the channel too, beside its card.
    let expiry_line: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message \
          WHERE workspace_id=$1 AND type='tool_result' AND props->>'approval_id' = $2",
    )
    .bind(fixture.workspace)
    .bind(second.to_string())
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        expiry_line, 1,
        "the expiry tool_result must not collide with its own proposal card"
    );
}

/// **ADR-0186 D2 — the park belongs to the lease holder.**
///
/// `bound_handle` proves identity (workspace, agent, connection, approved
/// channel) and says nothing about the lease, so a handle whose lease expired
/// and whose job was re-claimed still decodes and still binds. If proposing
/// accepted it, a stale worker could park a run out from under the worker that
/// actually holds the job — and that second worker would then get 409 on every
/// `oort_run_complete` until the one-hour TTL, unable to finish a turn it owns.
///
/// This is the asymmetry the reviewer found: `oort_run_complete` judges the
/// lease through `complete_gateway_run_in_tx` and proposing did not.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_stale_lease_handle_cannot_park_a_run_someone_else_owns() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();

    let handle_name = hosted_handle(&su, fixture.hosted_agent).await;
    let trigger: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "body": format!("@{handle_name} 초대 링크 만들어줘")
        }))
        .send()
        .await
        .expect("mention send")
        .json()
        .await
        .expect("mention body");
    assert!(trigger["id"].is_string(), "{trigger}");

    // The first worker claims the job and holds a handle.
    let (status, claimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{claimed}");
    let stale_handle = structured(&claimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .expect("handle")
        .to_string();

    // Its lease lapses and a second worker takes the job over. The first
    // worker's handle is now stale — but still perfectly well-formed, still
    // sealed with the live secret, and still bound to this very agent,
    // connection and approved channel.
    // Both timestamps move, because `outbox_gateway_lease_shape_ck` requires
    // `lease_expires_at > lease_acquired_at` — a lapsed lease is one whose whole
    // window is in the past, not one with an impossible shape.
    sqlx::query(
        "UPDATE outbox \
            SET lease_acquired_at = now() - interval '10 minutes', \
                lease_expires_at = now() - interval '1 minute' \
          WHERE workspace_id=$1 AND kind='agent_job' AND partition_key=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    let (status, reclaimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{reclaimed}");
    let fresh_handle = structured(&reclaimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .expect("the takeover mints a new handle")
        .to_string();
    assert_ne!(
        fresh_handle, stale_handle,
        "a takeover must mint a new lease, or this test proves nothing"
    );

    // The stale handle may not park the run.
    let (status, refused) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_action_propose",
        json!({"handle": stale_handle, "actionId": "invite.create", "args": {}}),
    )
    .await;
    assert_eq!(status, 409, "a stale lease must not park a run: {refused}");
    assert_eq!(error_code(&refused), -32005);
    let approvals: i64 = sqlx::query_scalar("SELECT count(*) FROM approval WHERE workspace_id=$1")
        .bind(fixture.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(approvals, 0, "a refused proposal writes nothing");

    // …and the worker that actually holds the lease still can.
    let (status, proposed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_action_propose",
        json!({"handle": fresh_handle, "actionId": "invite.create", "args": {}}),
    )
    .await;
    assert_eq!(status, 200, "the live lease holder may park: {proposed}");
    assert_eq!(structured(&proposed)["status"], json!("pending"));
}

/// Send one decision as the fixture's human and return the HTTP status.
async fn decide(
    client: &reqwest::Client,
    base: &str,
    fixture: &Fixture,
    approval_id: Uuid,
    approve: bool,
) -> u16 {
    client
        .post(format!(
            "{base}/v1/workspaces/{}/approvals/{approval_id}/decision",
            fixture.workspace
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({
            "approvalId": approval_id,
            "approve": approve,
            "clientDecisionId": Uuid::new_v4()
        }))
        .send()
        .await
        .expect("decision responds")
        .status()
        .as_u16()
}

async fn channel_message_count(pool: &PgPool, workspace: Uuid, channel: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id=$1 AND channel_id=$2")
        .bind(workspace)
        .bind(channel)
        .fetch_one(pool)
        .await
        .expect("count channel messages")
}

/// Raise a second mention, claim it, and propose on it. Returns the approval id.
///
/// The expiry arm needs its own parked run because the first one was closed by
/// the rejection above — and settling two different approvals through two
/// different paths is exactly what ADR-0186 §5 asks to be measured separately.
async fn propose_on_a_fresh_run(
    client: &reqwest::Client,
    base: &str,
    su: &PgPool,
    fixture: &Fixture,
) -> Uuid {
    let handle_name = hosted_handle(su, fixture.hosted_agent).await;
    let trigger: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "body": format!("@{handle_name} 하나 더 만들어줘")
        }))
        .send()
        .await
        .expect("second mention send")
        .json()
        .await
        .expect("second mention body");
    assert!(trigger["id"].is_string(), "{trigger}");

    let (status, claimed) = call(
        client,
        base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{claimed}");
    let handle = structured(&claimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .expect("a second lease handle")
        .to_string();

    let (status, proposed) = call(
        client,
        base,
        &fixture.hosted_bearer,
        "oort_action_propose",
        json!({"handle": handle, "actionId": "invite.create", "args": {"role": "member"}}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    Uuid::parse_str(
        structured(&proposed)["approvalId"]
            .as_str()
            .expect("approvalId"),
    )
    .expect("approvalId is a uuid")
}

/// Every `agent_job` row on this agent's partition key, settled or not.
async fn agent_job_count(pool: &PgPool, workspace: Uuid, agent: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND partition_key=$2",
    )
    .bind(workspace)
    .bind(agent)
    .fetch_one(pool)
    .await
    .expect("count agent jobs")
}

// ---------------------------------------------------------------------------
// (9) ADR-0186 D2/D4 — approving a workspace action executes it, once
// ---------------------------------------------------------------------------

/// A global `tracing` capture, installed once per test binary.
///
/// Global rather than thread-local because the thing under measurement runs on
/// the server's own tokio worker threads: `tracing::subscriber::with_default`
/// binds a *thread* and would have captured nothing an axum handler emitted —
/// a capture that can only pass.
///
/// The level is TRACE and the layer is the `fmt` one, so everything the process
/// emits lands here in its rendered form, including `sqlx`'s per-statement
/// events. That is deliberate: the statement log is the likeliest place a
/// credential leaks into logs by accident, and a capture that filtered it out
/// would prove nothing about the risk it exists for.
fn log_capture() -> Arc<Mutex<Vec<u8>>> {
    static CAPTURE: OnceLock<Arc<Mutex<Vec<u8>>>> = OnceLock::new();
    CAPTURE
        .get_or_init(|| {
            let buffer = Arc::new(Mutex::new(Vec::new()));
            // `try_init` rather than `init`: another test in this binary may
            // have installed it first, and losing that race is fine — the
            // buffer it installed is this same `OnceLock` value.
            let _ = tracing_subscriber::fmt()
                .with_writer(CaptureWriter(buffer.clone()))
                .with_max_level(tracing::Level::TRACE)
                .with_ansi(false)
                .try_init();
            buffer
        })
        .clone()
}

#[derive(Clone)]
struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for CaptureWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if let Ok(mut sink) = self.0.lock() {
            // A TRACE-level capture of a whole conformance binary is unbounded
            // by nature; this ceiling keeps a long run from eating the box
            // without changing what the assertions below measure (they read a
            // slice recorded around one HTTP call).
            if sink.len() < 64 * 1024 * 1024 {
                sink.extend_from_slice(buf);
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CaptureWriter {
    type Writer = CaptureWriter;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

fn captured_since(buffer: &Arc<Mutex<Vec<u8>>>, offset: usize) -> String {
    let sink = buffer.lock().expect("the capture buffer is healthy");
    String::from_utf8_lossy(&sink[offset.min(sink.len())..]).into_owned()
}

fn capture_offset(buffer: &Arc<Mutex<Vec<u8>>>) -> usize {
    buffer.lock().expect("the capture buffer is healthy").len()
}

/// A decision, with the two things the receipt-only helper throws away: the
/// response headers (ADR-0186 D4's `no-store`) and the body.
async fn decide_as(
    client: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    bearer: &str,
    approval_id: Uuid,
    approve: bool,
    client_decision_id: Uuid,
) -> (u16, reqwest::header::HeaderMap, Value) {
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{workspace}/approvals/{approval_id}/decision"
        ))
        .bearer_auth(bearer)
        .json(&json!({
            "approvalId": approval_id,
            "approve": approve,
            "clientDecisionId": client_decision_id
        }))
        .send()
        .await
        .expect("decision responds");
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body: Value = response.json().await.expect("a decision body");
    (status, headers, body)
}

/// A second human in the same workspace and the same channel who is **not** an
/// admin — the decider ADR-0186 D2's role gate is about.
async fn seed_plain_member(pool: &PgPool, fixture: &Fixture) -> String {
    let member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human','Plain Member',$3)",
    )
    .bind(member)
    .bind(fixture.workspace)
    .bind(format!("plain-{}", member.simple()))
    .execute(pool)
    .await
    .expect("seed plain member");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(member)
    .bind(fixture.workspace)
    .bind(format!("{member}@tools.test"))
    .execute(pool)
    .await
    .expect("seed plain identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
    )
    .bind(fixture.workspace)
    .bind(member)
    .execute(pool)
    .await
    .expect("seed plain membership");
    sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
        .bind(fixture.workspace)
        .bind(fixture.channel)
        .bind(member)
        .execute(pool)
        .await
        .expect("seed plain channel membership");

    let jwt = momo_auth::sign_access(member, fixture.workspace, &[], TEST_JWT_SECRET)
        .expect("sign a plain member App JWT")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'tools-conformance')",
    )
    .bind(fixture.workspace)
    .bind(member)
    .bind(&jwt)
    .execute(pool)
    .await
    .expect("record the plain member session token");
    jwt
}

/// Mention, claim, propose — and hand back both ids the decision test needs.
async fn propose_invite(
    client: &reqwest::Client,
    base: &str,
    su: &PgPool,
    fixture: &Fixture,
    args: Value,
) -> (Uuid, Uuid) {
    let handle_name = hosted_handle(su, fixture.hosted_agent).await;
    let trigger: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "body": format!("@{handle_name} 초대 링크 하나 만들어줘")
        }))
        .send()
        .await
        .expect("mention send")
        .json()
        .await
        .expect("mention body");
    assert!(trigger["id"].is_string(), "{trigger}");

    let (status, claimed) = call(
        client,
        base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{claimed}");
    let handle = structured(&claimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .expect("a lease handle")
        .to_string();

    let (status, proposed) = call(
        client,
        base,
        &fixture.hosted_bearer,
        "oort_action_propose",
        json!({
            "handle": handle,
            "actionId": "invite.create",
            "args": args,
            "rationale": "새 팀원 온보딩 요청"
        }),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let result = structured(&proposed);
    (
        Uuid::parse_str(result["approvalId"].as_str().expect("approvalId")).expect("uuid"),
        Uuid::parse_str(result["cardMessageId"].as_str().expect("cardMessageId")).expect("uuid"),
    )
}

/// Every durable store this decision writes, as text, in one place.
///
/// The grep for the minted code runs over **all six** rather than the three a
/// reader first thinks of: ADR-0186 D4 names `approval.payload`, message props,
/// the audit row, the log **and the outbox**, and `agent_run.output` is the one
/// the executor itself writes.
async fn durable_text(pool: &PgPool, workspace: Uuid) -> String {
    let mut rendered = String::new();
    for statement in [
        "SELECT coalesce(string_agg(payload::text, ' '), '') FROM approval WHERE workspace_id=$1",
        "SELECT coalesce(string_agg(coalesce(props::text,'') || ' ' || coalesce(body,''), ' '), '') \
           FROM message WHERE workspace_id=$1",
        "SELECT coalesce(string_agg(detail::text, ' '), '') FROM audit_log WHERE workspace_id=$1",
        "SELECT coalesce(string_agg(receipt::text, ' '), '') FROM approval_decision \
           WHERE workspace_id=$1",
        "SELECT coalesce(string_agg(coalesce(output::text,'') || ' ' || coalesce(error::text,''), ' '), '') \
           FROM agent_run WHERE workspace_id=$1",
        "SELECT coalesce(string_agg(payload::text, ' '), '') FROM outbox WHERE workspace_id=$1",
    ] {
        let chunk: String = sqlx::query_scalar(statement)
            .bind(workspace)
            .fetch_one(pool)
            .await
            .expect("read a durable store");
        rendered.push_str(&chunk);
        rendered.push(' ');
    }
    rendered
}

/// **The AX-3b red proof, end to end** (issue #2509).
///
/// Six things are measured against a real database and the real router, in the
/// order a person meets them:
///
/// 1. a non-admin decider is refused `role_required` and the approval survives;
/// 2. an admin's approval mints the invite in the decision transaction;
/// 3. the code appears in the response body and in **no** durable store and in
///    no log line;
/// 4. the persistent card carries 부록 B and nothing that could hold a code;
/// 5. the run ends `succeeded` with zero resume jobs;
/// 6. a replayed `client_decision_id` answers the same receipt with the link
///    gone.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_approved_workspace_action_mints_the_invite_and_shows_the_link_once() {
    ensure_schema_and_roles();
    let capture = log_capture();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();
    let plain_jwt = seed_plain_member(&su, &fixture).await;

    let (approval_id, card_message_id) = propose_invite(
        &client,
        &base,
        &su,
        &fixture,
        json!({"role": "member", "maxUses": 1, "expiresInDays": 7}),
    )
    .await;
    let jobs_before = agent_job_count(&su, fixture.workspace, fixture.hosted_agent).await;
    let invites_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM invite_code WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap();

    // ---- red proof 2: the role gate ----------------------------------------
    //
    // A member of the channel, a human, active — and not an admin. Everything
    // else about this request is identical to the one that succeeds below, so
    // the role is the only variable.
    let (status, _headers, refused) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &plain_jwt,
        approval_id,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 403, "{refused}");
    assert_eq!(
        refused["status"], "role_required",
        "the refusal is receipt-shaped, as every expected failure on this route \
         is (openapi decideApproval): {refused}"
    );
    assert!(
        refused.get("result").is_none(),
        "a refusal executed nothing: {refused}"
    );
    let (still_pending, decided_by): (String, Option<Uuid>) = sqlx::query_as(
        "SELECT status::text, decided_by FROM approval WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(approval_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(still_pending, "pending", "the approval is NOT consumed");
    assert_eq!(decided_by, None);
    let ledger_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM approval_decision WHERE workspace_id=$1 AND approval_id=$2",
    )
    .bind(fixture.workspace)
    .bind(approval_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(ledger_rows, 0, "a refused decision writes no ledger row");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM invite_code WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap(),
        invites_before,
        "and mints nothing"
    );
    // …but the card says somebody tried, which is what AX-4 draws.
    let card_props: Value =
        sqlx::query_scalar("SELECT props FROM message WHERE workspace_id=$1 AND id=$2")
            .bind(fixture.workspace)
            .bind(card_message_id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(card_props["last_attempt"], json!("role_required"));
    assert_eq!(
        card_props["status"],
        json!("pending"),
        "the card is still awaiting a decision"
    );

    // ---- the admin decides, and the action runs ----------------------------
    let decision_id = Uuid::new_v4();
    let log_offset = capture_offset(&capture);
    tracing::info!(canary = "ax3b-log-capture-canary", "log capture is live");
    let (status, headers, approved) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval_id,
        true,
        decision_id,
    )
    .await;
    let captured = captured_since(&capture, log_offset);
    assert_eq!(status, 200, "{approved}");

    // ---- red proof 7: the headers ------------------------------------------
    assert_eq!(
        headers
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-store"),
        "a response carrying a one-time value must not be cacheable (ADR-0186 D4)"
    );
    assert_eq!(
        headers.get("pragma").and_then(|value| value.to_str().ok()),
        Some("no-cache")
    );

    // ---- 부록 C: the body --------------------------------------------------
    assert_eq!(approved["status"], json!("approved"));
    assert_eq!(approved["decidedBy"], json!(fixture.human.to_string()));
    assert_eq!(approved["result"]["actionId"], json!("invite.create"));
    assert_eq!(approved["result"]["ref"]["type"], json!("invite"));
    let invite_id = Uuid::parse_str(
        approved["result"]["ref"]["id"]
            .as_str()
            .expect("the ref names the invite"),
    )
    .expect("invite id is a uuid");
    assert_eq!(
        approved["result"]["secretOnce"]["kind"],
        json!("invite_link")
    );
    let link = approved["result"]["secretOnce"]["value"]
        .as_str()
        .expect("the one-time link")
        .to_string();
    let code = link
        .split("code=")
        .nth(1)
        .expect("the link carries the code")
        .to_string();
    assert!(!code.is_empty());
    assert_eq!(
        link,
        format!("{base}/join?code={code}"),
        "with no MOMO_PUBLIC_BASE_URL configured the link is built from this \
         request's own origin (ADR-0167 derivation)"
    );

    // ---- the invite is real, and it is the approver's ----------------------
    let (invite_role, invite_max_uses, invite_created_by, invite_expires_ms): (
        String,
        i32,
        Uuid,
        i64,
    ) = sqlx::query_as(
        "SELECT role::text, max_uses, created_by, \
                (extract(epoch FROM expires_at) * 1000)::bigint \
           FROM invite_code WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(invite_id)
    .fetch_one(&su)
    .await
    .expect("the invite row exists");
    assert_eq!(invite_role, "member");
    assert_eq!(invite_max_uses, 1);
    assert_eq!(
        invite_created_by, fixture.human,
        "executed with the APPROVER's authority — the agent is never admin"
    );
    assert_eq!(
        approved["result"]["secretOnce"]["expiresAtMs"]
            .as_i64()
            .expect("expiresAtMs"),
        invite_expires_ms
    );
    // The code the body handed out is the one this row hashes, and the row
    // keeps only the hash.
    let code_matches: bool = sqlx::query_scalar(
        "SELECT code_hash = momo_invite_code_hash($2) FROM invite_code \
          WHERE workspace_id=$1 AND id=$3",
    )
    .bind(fixture.workspace)
    .bind(&code)
    .bind(invite_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(code_matches, "the answered code opens this invite");

    // ---- red proof 1: the code lives in the response body and nowhere else --
    let stored = durable_text(&su, fixture.workspace).await;
    assert!(
        !stored.contains(&code),
        "the minted code must not appear in approval.payload, message props or \
         body, audit detail, the decision receipt, agent_run output or the \
         outbox"
    );
    assert!(
        !stored.contains("/join?code="),
        "nor may the assembled link: {stored}"
    );
    assert!(
        captured.contains("ax3b-log-capture-canary"),
        "the capture must be live, or 'the code never appears in the log' is a \
         sentence about nothing"
    );
    assert!(
        captured.contains("sqlx::query"),
        "…and it must reach the layer where a credential would most plausibly \
         leak by accident — the statement log — rather than only the events \
         this test emits itself: {} bytes captured",
        captured.len()
    );
    assert!(
        !captured.contains(&code),
        "the minted code must not appear in any log line emitted while the \
         decision was processed"
    );

    // ---- red proof 5: 부록 B on the persistent card -------------------------
    let (result_author, result_props, result_body, result_key): (
        Uuid,
        Value,
        Option<String>,
        Option<Uuid>,
    ) = sqlx::query_as(
        "SELECT author_member_id, props, body, client_msg_id FROM message \
              WHERE workspace_id=$1 AND channel_id=$2 AND type='tool_result' \
              ORDER BY seq DESC LIMIT 1",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .expect("the action_result line is in the channel");
    assert_eq!(
        result_author, fixture.hosted_agent,
        "the outcome is authored by the agent whose proposal it was"
    );
    assert_ne!(
        result_key,
        Some(approval_id),
        "the result line must not take the key the rejection and expiry lines use"
    );
    let card = &result_props["momo.action_result"];
    assert_eq!(card["v"], json!(1));
    assert_eq!(card["action_id"], json!("invite.create"));
    assert_eq!(card["status"], json!("executed"));
    assert_eq!(card["approval_id"], json!(approval_id.to_string()));
    assert_eq!(card["decided_by"], json!(fixture.human.to_string()));
    assert_eq!(
        card["ref"],
        json!({"type": "invite", "id": invite_id.to_string()})
    );
    assert_eq!(card["secret_shown_once"], json!(true));
    assert_eq!(card["next"]["href"], json!("/settings?section=members"));
    assert_eq!(card["rows"][0], json!({"label": "역할", "value": "member"}));
    let rendered_props = result_props.to_string();
    assert!(!rendered_props.contains("http"), "{rendered_props}");
    assert!(!rendered_props.contains("code="), "{rendered_props}");
    assert!(
        result_body
            .as_deref()
            .expect("a body a client that knows no card kind can still read")
            .starts_with("초대 링크를 만들었어요"),
        "{result_body:?}"
    );

    // ---- the request card is decided, and no longer says it was refused ----
    let card_props: Value =
        sqlx::query_scalar("SELECT props FROM message WHERE workspace_id=$1 AND id=$2")
            .bind(fixture.workspace)
            .bind(card_message_id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(card_props["status"], json!("approved"));
    assert_eq!(card_props["approval_status"], json!("approved"));
    assert!(
        card_props.get("last_attempt").is_none(),
        "an approved card must not still say the last attempt needed an admin — \
         and the key must be GONE, not null: a client that reads it by presence \
         (`\"last_attempt\" in props`) cannot tell a null from a refusal. \
         {card_props}"
    );

    // ---- the audit: two rows, and the generic one is not among them --------
    let audit: Vec<(String, Option<Uuid>, Option<Uuid>, Value)> = sqlx::query_as(
        "SELECT action, actor_member_id, subject_member_id, detail FROM audit_log \
          WHERE workspace_id=$1 AND (detail->>'approval_id') = $2 ORDER BY action",
    )
    .bind(fixture.workspace)
    .bind(approval_id.to_string())
    .fetch_all(&su)
    .await
    .unwrap();
    let actions: Vec<&str> = audit.iter().map(|row| row.0.as_str()).collect();
    assert_eq!(
        actions,
        vec!["action.approved", "invite.created"],
        "ADR-0186 §5 names exactly these two — and NOT the generic \
         approval.approved the tool-call path writes"
    );
    let approved_row = &audit[0];
    assert_eq!(approved_row.1, Some(fixture.human), "a person decided");
    assert_eq!(
        approved_row.2,
        Some(fixture.hosted_agent),
        "…about an agent's proposal"
    );
    assert_eq!(approved_row.3["schema"], json!("momo.action.approved.v1"));
    assert_eq!(approved_row.3["action_id"], json!("invite.create"));
    assert_eq!(
        approved_row.3["proposed_by"],
        json!(fixture.hosted_agent.to_string())
    );
    assert_eq!(
        approved_row.3["decided_by"],
        json!(fixture.human.to_string())
    );
    assert_eq!(
        approved_row.3["ref"],
        json!({"type": "invite", "id": invite_id.to_string()})
    );
    let created_row = &audit[1];
    assert_eq!(created_row.3["schema"], json!("momo.invite.created.v1"));
    assert_eq!(created_row.3["role"], json!("member"));
    assert_eq!(created_row.3["max_uses"], json!(1));
    assert_eq!(
        created_row.3["via_agent"],
        json!(fixture.hosted_agent.to_string()),
        "the invite row records which agent asked for it"
    );
    for forbidden in ["code", "code_hash", "code_preview", "preview", "link"] {
        assert!(
            created_row.3.get(forbidden).is_none(),
            "{forbidden} must not be in an audit detail"
        );
    }

    // ---- red proof 3: the run ended, with no job behind it -----------------
    let (run_status, run_output): (String, Option<Value>) = sqlx::query_as(
        "SELECT r.status::text, r.output FROM agent_run r JOIN approval a ON a.run_id = r.id \
          WHERE a.workspace_id=$1 AND a.id=$2",
    )
    .bind(fixture.workspace)
    .bind(approval_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(run_status, "succeeded");
    let run_output = run_output.expect("the run records what it did");
    assert_eq!(run_output["actionId"], json!("invite.create"));
    assert_eq!(
        run_output["ref"],
        json!({"type": "invite", "id": invite_id.to_string()})
    );
    assert_eq!(
        agent_job_count(&su, fixture.workspace, fixture.hosted_agent).await,
        jobs_before,
        "an executed action enqueues NO resume job — the decision was the \
         execution (ADR-0186 §5)"
    );

    // ---- red proof 4: the replay -------------------------------------------
    //
    // The same `client_decision_id`, the same decider, the same verdict. The
    // server answers the stored receipt — which names the invite and does not
    // carry the link, because the link was never stored.
    let (status, headers, replayed) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval_id,
        true,
        decision_id,
    )
    .await;
    assert_eq!(status, 200, "{replayed}");
    assert_eq!(
        headers
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-store"),
        "no-store is on every outcome, not only the minting one"
    );
    assert_eq!(replayed["result"]["actionId"], json!("invite.create"));
    assert_eq!(replayed["result"]["ref"], approved["result"]["ref"]);
    assert!(
        replayed["result"].get("secretOnce").is_none(),
        "a replay must not re-show the one-time value: {replayed}"
    );
    assert!(!replayed.to_string().contains(&code));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM invite_code WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap(),
        invites_before + 1,
        "and it mints nothing the second time"
    );

    // ---- bodies for the spec's own validator -------------------------------
    //
    // `scripts/verify_openapi_contract_rust.sh` samples this operation with a
    // **tool-call** approval, so its green says nothing about 부록 C: the
    // sampled body has no `result` at all. Setting this variable writes the
    // three bodies this test actually observed, so the spec's validator can be
    // pointed at them:
    //
    //   OPENAPI_DECISION_SAMPLE_DIR=/tmp/ax3b cargo test … --ignored
    //   python3 scripts/openapi_shape_check.py --spec <spec.json> \
    //     --manifest /tmp/ax3b/manifest.json
    //
    // Writing them only on request keeps the test itself hermetic.
    if let Ok(dir) = std::env::var("OPENAPI_DECISION_SAMPLE_DIR") {
        std::fs::create_dir_all(&dir).expect("create the sample directory");
        for (name, body) in [
            ("decision-executed", &approved),
            ("decision-role-required", &refused),
            ("decision-replayed", &replayed),
        ] {
            std::fs::write(format!("{dir}/{name}.json"), body.to_string())
                .expect("write a decision sample");
        }
        let manifest = json!({
            "samples": [
                {
                    "name": "decision-executed",
                    "method": "post",
                    "path": "/v1/workspaces/{workspaceId}/approvals/{approvalId}/decision",
                    "status": "200",
                    "body_file": format!("{dir}/decision-executed.json")
                },
                {
                    "name": "decision-role-required",
                    "method": "post",
                    "path": "/v1/workspaces/{workspaceId}/approvals/{approvalId}/decision",
                    "status": "403",
                    "body_file": format!("{dir}/decision-role-required.json")
                },
                {
                    "name": "decision-replayed",
                    "method": "post",
                    "path": "/v1/workspaces/{workspaceId}/approvals/{approvalId}/decision",
                    "status": "200",
                    "body_file": format!("{dir}/decision-replayed.json")
                }
            ]
        });
        std::fs::write(format!("{dir}/manifest.json"), manifest.to_string())
            .expect("write the sample manifest");
    }
}

/// **The expiry arm, tapped late** (ADR-0186 D2 「거부·만료: 기존 arm 그대로」).
///
/// AX-3a already proved the notifier's sweep settles a `workspace_action`. What
/// is unproved until here is the *other* expiry path: a person who taps 승인 on
/// a card whose deadline has passed. That request reaches `settle_expired`
/// **before** the executor branch, so it must settle the approval as `expired`,
/// time the run out, mint nothing — and, the point of the test, enqueue no
/// resume job for a payload that has no tool call to resume.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_late_tap_on_a_workspace_action_expires_it_and_mints_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();

    let (approval_id, _card) =
        propose_invite(&client, &base, &su, &fixture, json!({"role": "member"})).await;
    let jobs_before = agent_job_count(&su, fixture.workspace, fixture.hosted_agent).await;
    sqlx::query(
        "UPDATE approval SET expires_at = now() - interval '1 minute' \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(approval_id)
    .execute(&su)
    .await
    .unwrap();

    let (status, headers, settled) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval_id,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{settled}");
    assert_eq!(settled["status"], json!("expired"));
    assert!(
        settled.get("result").is_none(),
        "an expiry executed nothing: {settled}"
    );
    assert_eq!(
        headers
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );

    let expired: String =
        sqlx::query_scalar("SELECT status::text FROM approval WHERE workspace_id=$1 AND id=$2")
            .bind(fixture.workspace)
            .bind(approval_id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(expired, "expired");
    let run_status: String = sqlx::query_scalar(
        "SELECT r.status::text FROM agent_run r JOIN approval a ON a.run_id = r.id \
          WHERE a.workspace_id=$1 AND a.id=$2",
    )
    .bind(fixture.workspace)
    .bind(approval_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        run_status, "timed_out",
        "the late tap releases the concurrency gate rather than merely failing"
    );
    assert_eq!(
        agent_job_count(&su, fixture.workspace, fixture.hosted_agent).await,
        jobs_before,
        "the expiry arm must not assume a resume job a workspace action never had"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM invite_code WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap(),
        0,
        "an overdue card mints nothing"
    );
}

/// **M1 — the run left its hold between the execution and the transition.**
///
/// ADR-0186 D2 mints the invite and only then moves the run out of
/// `awaiting_approval`. A human stop or the expiry sweep can win that race, and
/// when it does the invite must not survive: `succeed_parked_run_in_tx`
/// answering `false` is the only guard between "a person approved this" and "an
/// invite exists for a run somebody else already ended".
///
/// This drives the race by cancelling the run under a still-pending approval —
/// exactly the state `routes::agent_runs`' human stop produces if its own
/// approval sweep ever misses one — and measures both halves: the transaction
/// rolled back (no invite, no ledger row, the approval still pending) and the
/// answer is the receipt clients already decode, not a 500 envelope.
///
/// Sabotage: change the guard to `let _ = succeed_parked_run_in_tx(…)` and this
/// goes red on the very first assertion, because the decision then commits.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_approval_whose_run_left_the_hold_rolls_back_and_answers_a_receipt() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();

    let (approval_id, card_message_id) =
        propose_invite(&client, &base, &su, &fixture, json!({"role": "member"})).await;
    let messages_before = channel_message_count(&su, fixture.workspace, fixture.channel).await;

    // The run ends while the card is still pending — the approval row is
    // untouched, so the decision route walks straight into the executor.
    sqlx::query(
        "UPDATE agent_run SET status='cancelled', finished_at=now() \
          WHERE id = (SELECT run_id FROM approval WHERE workspace_id=$1 AND id=$2)",
    )
    .bind(fixture.workspace)
    .bind(approval_id)
    .execute(&su)
    .await
    .unwrap();

    let (status, headers, answered) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval_id,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(
        status, 409,
        "a lost race is an expected failure on this route, not a 500: {answered}"
    );
    assert_eq!(
        answered["status"], "run_not_parked",
        "…and it is receipt-shaped, like every other expected failure here: {answered}"
    );
    assert!(answered.get("result").is_none(), "{answered}");
    assert!(
        answered.get("error").is_none(),
        "the generic envelope would make this the one 500 on a receipt route: {answered}"
    );
    assert_eq!(
        headers
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );

    // ---- everything the executor wrote is gone -----------------------------
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM invite_code WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap(),
        0,
        "the minted invite MUST be rolled back — an invite for a run nobody is \
         waiting on is the exact state this guard exists to prevent"
    );
    let (approval_status, decided_by): (String, Option<Uuid>) = sqlx::query_as(
        "SELECT status::text, decided_by FROM approval WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(approval_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(approval_status, "pending", "the approval is not consumed");
    assert_eq!(decided_by, None);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM approval_decision WHERE workspace_id=$1 AND approval_id=$2"
        )
        .bind(fixture.workspace)
        .bind(approval_id)
        .fetch_one(&su)
        .await
        .unwrap(),
        0,
        "no ledger row survived the rollback"
    );
    assert_eq!(
        channel_message_count(&su, fixture.workspace, fixture.channel).await,
        messages_before,
        "and no result line reached the channel"
    );
    let audit_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND (detail->>'approval_id') = $2",
    )
    .bind(fixture.workspace)
    .bind(approval_id.to_string())
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(audit_rows, 0, "nor any audit row");
    let card_props: Value =
        sqlx::query_scalar("SELECT props FROM message WHERE workspace_id=$1 AND id=$2")
            .bind(fixture.workspace)
            .bind(card_message_id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(card_props["status"], json!("pending"), "{card_props}");
}

/// **L1 — a rejected card must not still say an admin was needed.**
///
/// The refusal patch (`last_attempt`) is written outside any decision, so the
/// arm that finally settles the card has to clear it — and both arms do. The
/// approve arm is measured by the executor test above; this is the reject one,
/// which is the likelier sequence in practice: a member taps 승인, is told an
/// admin must do it, and closes their own proposal instead.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn rejecting_after_a_refused_tap_clears_the_admin_notice() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();
    let plain_jwt = seed_plain_member(&su, &fixture).await;

    let (approval_id, card_message_id) =
        propose_invite(&client, &base, &su, &fixture, json!({"role": "member"})).await;

    // A member taps 승인 and is told who may.
    let (status, _headers, refused) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &plain_jwt,
        approval_id,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 403, "{refused}");
    let card_props: Value =
        sqlx::query_scalar("SELECT props FROM message WHERE workspace_id=$1 AND id=$2")
            .bind(fixture.workspace)
            .bind(card_message_id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(card_props["last_attempt"], json!("role_required"));

    // **The same member may still reject** — ADR-0186 D2 keeps the reject arm
    // as it was, and that asymmetry is deliberate: a person must be able to
    // close their own agent's proposal, or the parked run holds the agent's
    // only concurrency slot until the TTL.
    let (status, _headers, rejected) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &plain_jwt,
        approval_id,
        false,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{rejected}");
    assert_eq!(rejected["status"], json!("rejected"));

    let card_props: Value =
        sqlx::query_scalar("SELECT props FROM message WHERE workspace_id=$1 AND id=$2")
            .bind(fixture.workspace)
            .bind(card_message_id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(card_props["status"], json!("rejected"));
    assert!(
        card_props.get("last_attempt").is_none(),
        "a rejected card saying `last_attempt: role_required` gives two answers \
         to one question — and the key must be GONE, not null: {card_props}"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM invite_code WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap(),
        0,
        "a rejection mints nothing"
    );
}

// ---------------------------------------------------------------------------
// (9) ADR-0162 증보 2 (#2915) — hosted 1:1 DMs
//
// The owner's own DM opens by rule; a DM with anyone else opens only when the
// owner approves that DM; a subscription agent opens nothing but the owner's.
// Every assertion runs through the real router on `momo_app`, and "delivered"
// means **claimed** — the claim SQL is the authority, so a selector that says
// yes over a claim that says no would leave the DM silent one layer deeper.
// ---------------------------------------------------------------------------

async fn seed_dm_2915(pool: &PgPool, workspace: Uuid, creator: Uuid, members: &[Uuid]) -> Uuid {
    let dm = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, dm_key, created_by) \
         VALUES ($1, $2, 'dm', NULL, NULL, $3, $4)",
    )
    .bind(dm)
    .bind(workspace)
    .bind(dm.to_string())
    .bind(creator)
    .execute(pool)
    .await
    .expect("seed dm");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(dm)
        .bind(workspace)
        .execute(pool)
        .await
        .expect("seed dm seq");
    for member in members {
        add_member_2915(pool, workspace, dm, *member).await;
    }
    dm
}

async fn add_member_2915(pool: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(pool)
        .await
        .expect("seed dm membership");
}

/// A second human in the fixture's workspace, with a live App session.
async fn seed_human_2915(
    pool: &PgPool,
    fixture: &Fixture,
    role: &str,
    name: &str,
) -> (Uuid, String) {
    let member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human',$3,$4)",
    )
    .bind(member)
    .bind(fixture.workspace)
    .bind(name)
    .bind(format!("h2915-{}", member.simple()))
    .execute(pool)
    .await
    .expect("seed human");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(member)
    .bind(fixture.workspace)
    .bind(format!("{member}@tools.test"))
    .execute(pool)
    .await
    .expect("seed identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) \
         VALUES($1,$2,$3::membership_role)",
    )
    .bind(fixture.workspace)
    .bind(member)
    .bind(role)
    .execute(pool)
    .await
    .expect("seed workspace membership");
    let jwt = momo_auth::sign_access(member, fixture.workspace, &[], TEST_JWT_SECRET)
        .expect("sign App JWT")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'tools-2915')",
    )
    .bind(fixture.workspace)
    .bind(member)
    .bind(&jwt)
    .execute(pool)
    .await
    .expect("record session");
    (member, jwt)
}

async fn say_2915(
    client: &reqwest::Client,
    base: &str,
    jwt: &str,
    workspace: Uuid,
    channel: Uuid,
    body: &str,
) {
    let status = client
        .post(format!(
            "{base}/v1/workspaces/{workspace}/channels/{channel}/messages"
        ))
        .bearer_auth(jwt)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": body}))
        .send()
        .await
        .expect("send")
        .status();
    assert!(status.is_success(), "send answered {status}");
}

async fn dm_jobs_2915(pool: &PgPool, workspace: Uuid, agent: Uuid, channel: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND partition_key=$2 AND lower(payload->>'channel_id')=lower($3::text)",
    )
    .bind(workspace)
    .bind(agent)
    .bind(channel.to_string())
    .fetch_one(pool)
    .await
    .expect("job count")
}

async fn claim_channels_2915(client: &reqwest::Client, base: &str, bearer: &str) -> Vec<String> {
    let (status, claimed) = call(client, base, bearer, "oort_jobs_claim", json!({})).await;
    assert_eq!(status, 200, "{claimed}");
    structured(&claimed)["jobs"]
        .as_array()
        .expect("jobs")
        .iter()
        .map(|job| {
            job["work"]["channelId"]
                .as_str()
                .expect("channel")
                .to_lowercase()
        })
        .collect()
}

async fn dm_delivery_2915(
    client: &reqwest::Client,
    base: &str,
    jwt: &str,
    workspace: Uuid,
    channel: Uuid,
) -> Value {
    let response = client
        .get(format!(
            "{base}/v1/workspaces/{workspace}/channels/{channel}/agent-dm-delivery"
        ))
        .bearer_auth(jwt)
        .send()
        .await
        .expect("dm delivery");
    assert_eq!(response.status().as_u16(), 200);
    response.json().await.expect("dm delivery body")
}

async fn dm_approval_2915(
    client: &reqwest::Client,
    base: &str,
    jwt: &str,
    fixture: &Fixture,
    channel: Uuid,
    approve: bool,
) -> (u16, Value) {
    let url = format!(
        "{base}/v1/workspaces/{}/hosted-agent-connections/{}/dm-approvals/{channel}",
        fixture.workspace, fixture.hosted_connection
    );
    let request = if approve {
        client.put(url)
    } else {
        client.delete(url)
    };
    let response = request.bearer_auth(jwt).send().await.expect("dm approval");
    let status = response.status().as_u16();
    let body = response.json().await.unwrap_or(Value::Null);
    (status, body)
}

/// `hosted_connection_channel_ids` as `momo_app` under a given tenant GUC.
async fn covered_2915(app: &PgPool, guc: Uuid, workspace: Uuid, connection: Uuid) -> Vec<Uuid> {
    let mut tx = app.begin().await.expect("tx");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(guc.to_string())
        .execute(&mut *tx)
        .await
        .expect("guc");
    let covered: Vec<Uuid> = sqlx::query_scalar("SELECT hosted_connection_channel_ids($1, $2)")
        .bind(workspace)
        .bind(connection)
        .fetch_one(&mut *tx)
        .await
        .expect("covered");
    tx.rollback().await.expect("rollback");
    covered
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_owners_own_dm_with_a_hosted_agent_is_delivered_and_claimed() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();
    // `fixture.human` created the agent: it is the owner.
    let dm = seed_dm_2915(
        &su,
        fixture.workspace,
        fixture.human,
        &[fixture.human, fixture.hosted_agent],
    )
    .await;

    let delivery =
        dm_delivery_2915(&client, &base, &fixture.human_jwt, fixture.workspace, dm).await;
    assert_eq!(delivery["state"], "open", "{delivery}");
    assert_eq!(
        delivery["agentMemberId"],
        json!(fixture.hosted_agent.to_string())
    );

    // No handle: the 1:1 DM rule addresses the agent by itself.
    say_2915(
        &client,
        &base,
        &fixture.human_jwt,
        fixture.workspace,
        dm,
        "배포 결과 정리해줄래요?",
    )
    .await;
    assert_eq!(
        dm_jobs_2915(&su, fixture.workspace, fixture.hosted_agent, dm).await,
        1,
        "the owner's DM produced a hosted job"
    );
    assert!(
        hosted_notices(&su, fixture.workspace, dm).await.is_empty(),
        "and no skip line"
    );
    let claimed = claim_channels_2915(&client, &base, &fixture.hosted_bearer).await;
    assert_eq!(
        claimed,
        vec![dm.to_string()],
        "the claim SQL (the authority) hands the DM's job over"
    );

    // The reply loop closes: the agent can read the DM and answer in it.
    let (status, page) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_conversation_read",
        json!({"channelId": dm, "limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{page}");
    let (status, posted) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_message_post",
        json!({"channelId": dm, "clientMsgId": Uuid::new_v4(), "body": "정리했어요"}),
    )
    .await;
    assert_eq!(status, 200, "{posted}");

    // RLS: the same function under a foreign tenant GUC sees nothing.
    let own = covered_2915(
        &app,
        fixture.workspace,
        fixture.workspace,
        fixture.hosted_connection,
    )
    .await;
    assert!(
        own.contains(&dm) && own.contains(&fixture.channel),
        "{own:?}"
    );
    let foreign = covered_2915(
        &app,
        Uuid::new_v4(),
        fixture.workspace,
        fixture.hosted_connection,
    )
    .await;
    assert!(
        foreign.is_empty(),
        "another tenant's GUC reads nothing: {foreign:?}"
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_members_dm_waits_for_the_owner_and_opens_per_dm() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();
    sqlx::query("UPDATE member SET display_name=$2 WHERE id=$1")
        .bind(fixture.human)
        .bind("[성재](https://evil.example)")
        .execute(&su)
        .await
        .expect("rename owner");
    let (member, member_jwt) = seed_human_2915(&su, &fixture, "member", "민지").await;
    let (_admin, admin_jwt) = seed_human_2915(&su, &fixture, "admin", "관리자").await;
    let owner_dm = seed_dm_2915(
        &su,
        fixture.workspace,
        fixture.human,
        &[fixture.human, fixture.hosted_agent],
    )
    .await;
    let dm = seed_dm_2915(
        &su,
        fixture.workspace,
        member,
        &[member, fixture.hosted_agent],
    )
    .await;

    // (a) Closed by default, and the member is told who can open it.
    let delivery = dm_delivery_2915(&client, &base, &member_jwt, fixture.workspace, dm).await;
    assert_eq!(delivery["state"], "awaiting_owner", "{delivery}");
    assert_eq!(delivery["ownerMemberId"], json!(fixture.human.to_string()));
    say_2915(
        &client,
        &base,
        &member_jwt,
        fixture.workspace,
        dm,
        "안녕하세요",
    )
    .await;
    assert_eq!(
        dm_jobs_2915(&su, fixture.workspace, fixture.hosted_agent, dm).await,
        0
    );
    let notices = hosted_notices(&su, fixture.workspace, dm).await;
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_notice(
        &notices[0],
        fixture.hosted_agent,
        member,
        "hosted_dm_owner_approval_required",
        "［성재］(https：//evil.example)님에게 이 대화를 승인해 달라고 부탁해 주세요.",
    );
    assert!(
        notices[0]["props"].get("notice_action").is_none(),
        "the reader is not the owner: no door"
    );
    assert_notice_broadcast(&su, fixture.workspace, &notices[0]).await;

    // (b) Only the owner writes — not the member, not an admin.
    for jwt in [&member_jwt, &admin_jwt] {
        let (status, body) = dm_approval_2915(&client, &base, jwt, &fixture, dm, true).await;
        assert_eq!(status, 403, "{body}");
    }
    // The owner's own DM is automatic; a public channel is not a DM.
    let (status, _) =
        dm_approval_2915(&client, &base, &fixture.human_jwt, &fixture, owner_dm, true).await;
    assert_eq!(status, 409);
    let (status, _) = dm_approval_2915(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        true,
    )
    .await;
    assert_eq!(status, 422);

    // The list: readable by an admin, editable only by the owner.
    let list_url = format!(
        "{base}/v1/workspaces/{}/hosted-agent-connections/{}/dm-approvals",
        fixture.workspace, fixture.hosted_connection
    );
    let as_admin: Value = client
        .get(&list_url)
        .bearer_auth(&admin_jwt)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(as_admin["canEdit"], false, "{as_admin}");
    let as_owner: Value = client
        .get(&list_url)
        .bearer_auth(&fixture.human_jwt)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(as_owner["canEdit"], true, "{as_owner}");
    let states: Vec<(String, String)> = as_owner["dms"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["channelId"].as_str().unwrap().to_string(),
                row["state"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert!(
        states.contains(&(owner_dm.to_string(), "owner".into())),
        "{states:?}"
    );
    assert!(
        states.contains(&(dm.to_string(), "unapproved".into())),
        "{states:?}"
    );
    let as_member = client
        .get(&list_url)
        .bearer_auth(&member_jwt)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16();
    assert_eq!(as_member, 403);

    // (c) The owner opens this one DM.
    let (status, body) =
        dm_approval_2915(&client, &base, &fixture.human_jwt, &fixture, dm, true).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["changed"], true);
    assert_eq!(body["dm"]["state"], "approved");
    let (_, again) = dm_approval_2915(&client, &base, &fixture.human_jwt, &fixture, dm, true).await;
    assert_eq!(again["changed"], false, "idempotent");
    let granted: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 \
           AND action='hosted_agent.dm_approval.granted'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(granted, 1, "one audit row per change");

    let delivery = dm_delivery_2915(&client, &base, &member_jwt, fixture.workspace, dm).await;
    assert_eq!(delivery["state"], "open", "{delivery}");
    say_2915(
        &client,
        &base,
        &member_jwt,
        fixture.workspace,
        dm,
        "이제 들리나요?",
    )
    .await;
    assert_eq!(
        dm_jobs_2915(&su, fixture.workspace, fixture.hosted_agent, dm).await,
        1
    );
    assert_eq!(
        claim_channels_2915(&client, &base, &fixture.hosted_bearer).await,
        vec![dm.to_string()]
    );

    // (d) A third person joins: no longer 1:1, so the stored approval stops
    //     covering it — live, without anyone editing the list.
    let (third, _) = seed_human_2915(&su, &fixture, "member", "셋째").await;
    add_member_2915(&su, fixture.workspace, dm, third).await;
    let covered = covered_2915(
        &app,
        fixture.workspace,
        fixture.workspace,
        fixture.hosted_connection,
    )
    .await;
    assert!(
        !covered.contains(&dm),
        "a group DM is never covered: {covered:?}"
    );
    assert!(covered.contains(&owner_dm), "{covered:?}");
    let handle = hosted_handle(&su, fixture.hosted_agent).await;
    say_2915(
        &client,
        &base,
        &member_jwt,
        fixture.workspace,
        dm,
        &format!("@{handle} 여기도?"),
    )
    .await;
    assert_eq!(
        dm_jobs_2915(&su, fixture.workspace, fixture.hosted_agent, dm).await,
        1,
        "no new job"
    );
    let last = hosted_notices(&su, fixture.workspace, dm).await;
    assert_eq!(
        last.last().unwrap()["props"]["reason"],
        "hosted_dm_not_approvable",
        "{last:?}"
    );

    // (e) The owner can still withdraw it.
    let (status, body) =
        dm_approval_2915(&client, &base, &fixture.human_jwt, &fixture, dm, false).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["changed"], true);
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_subscription_agents_owner_dm_opens_and_nothing_else_can() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();
    sqlx::query(
        "UPDATE agent SET invocation_scope='owner_only', subscription_harness='claude_code' \
          WHERE workspace_id=$1 AND member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .expect("mark owner_only");
    // Seen recently, so the owner's call is not answered with "offline".
    sqlx::query("UPDATE token SET last_used_at=now() WHERE id=$1")
        .bind(fixture.hosted_token)
        .execute(&su)
        .await
        .expect("seen");
    let (member, member_jwt) = seed_human_2915(&su, &fixture, "member", "민지").await;
    let owner_dm = seed_dm_2915(
        &su,
        fixture.workspace,
        fixture.human,
        &[fixture.human, fixture.hosted_agent],
    )
    .await;
    let dm = seed_dm_2915(
        &su,
        fixture.workspace,
        member,
        &[member, fixture.hosted_agent],
    )
    .await;

    say_2915(
        &client,
        &base,
        &fixture.human_jwt,
        fixture.workspace,
        owner_dm,
        "오늘 할 일?",
    )
    .await;
    assert_eq!(
        dm_jobs_2915(&su, fixture.workspace, fixture.hosted_agent, owner_dm).await,
        1
    );
    assert_eq!(
        claim_channels_2915(&client, &base, &fixture.hosted_bearer).await,
        vec![owner_dm.to_string()],
        "a subscription agent answers its owner's DM"
    );

    // The owner cannot open anyone else's DM with it.
    let (status, body) =
        dm_approval_2915(&client, &base, &fixture.human_jwt, &fixture, dm, true).await;
    assert_eq!(status, 409, "{body}");
    // Even a stored value (written behind the API's back) opens nothing.
    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_dm_channel_ids=ARRAY[$3]::uuid[] \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .bind(dm)
    .execute(&su)
    .await
    .unwrap();
    let covered = covered_2915(
        &app,
        fixture.workspace,
        fixture.workspace,
        fixture.hosted_connection,
    )
    .await;
    assert!(!covered.contains(&dm), "{covered:?}");
    let delivery = dm_delivery_2915(&client, &base, &member_jwt, fixture.workspace, dm).await;
    assert_eq!(delivery["state"], "owner_only", "{delivery}");
    say_2915(
        &client,
        &base,
        &member_jwt,
        fixture.workspace,
        dm,
        "저도 써도 되나요?",
    )
    .await;
    assert_eq!(
        dm_jobs_2915(&su, fixture.workspace, fixture.hosted_agent, dm).await,
        0
    );
    assert!(claim_channels_2915(&client, &base, &fixture.hosted_bearer)
        .await
        .is_empty());
}

/// Security review H1 (#2918) — ADR-0162 증보 2 B6.
///
/// The owner creates a hosted connection; before it is active, a workspace
/// admin who is NOT the owner re-pairs it, detects it with their own runtime
/// and confirms it. That connection must carry no DM: not the owner's own
/// (history via `oort_conversation_read`, new turns via the claim), and not
/// the DMs the owner had opened (cleared in the confirm transaction).
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_connection_a_non_owner_confirmed_carries_no_dm() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();
    let ws = fixture.workspace;
    let (_admin, admin_jwt) = seed_human_2915(&su, &fixture, "admin", "관리자").await;
    let (member, member_jwt) = seed_human_2915(&su, &fixture, "member", "민지").await;

    // The owner (`fixture.human`) creates the connection: the agent is theirs.
    let created: Value = client
        .post(format!("{base}/v1/workspaces/{ws}/hosted-agent-connections"))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({"displayName": "Claude Code", "handle": format!("cc-{}", &Uuid::new_v4().simple().to_string()[..8]), "authMode": "static_bearer"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let connection: Uuid = created["connection"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let agent: Uuid = created["connection"]["agentMemberId"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let owner_dm = seed_dm_2915(&su, ws, fixture.human, &[fixture.human, agent]).await;
    let member_dm = seed_dm_2915(&su, ws, member, &[member, agent]).await;
    // The owner already said something private in their DM.
    say_2915(
        &client,
        &base,
        &fixture.human_jwt,
        ws,
        owner_dm,
        "비공개 메모: 연봉 협상 초안",
    )
    .await;

    // The admin re-pairs it and detects it with their own runtime.
    let regenerated: Value = client
        .post(format!(
            "{base}/v1/workspaces/{ws}/hosted-agent-connections/{connection}/pairing-challenge/regenerate"
        ))
        .bearer_auth(&admin_jwt)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pairing = regenerated["pairingCredential"]
        .as_str()
        .expect("pairing")
        .to_string();
    list_tools(&client, &base, &pairing).await;

    // While it is detected (not yet confirmed) the owner opens the member's DM.
    let url = format!(
        "{base}/v1/workspaces/{ws}/hosted-agent-connections/{connection}/dm-approvals/{member_dm}"
    );
    let status = client
        .put(&url)
        .bearer_auth(&fixture.human_jwt)
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(
        status.as_u16(),
        200,
        "an unconfirmed connection still takes the owner's decision"
    );

    // The admin confirms (no channels at all) and proves.
    let confirmed: Value = client
        .post(format!(
            "{base}/v1/workspaces/{ws}/hosted-agent-connections/{connection}/confirm"
        ))
        .bearer_auth(&admin_jwt)
        .json(&json!({
            "agentMemberId": agent.to_string(),
            "audience": AUDIENCE,
            "approvedChannelIds": [],
            "approvedScopes": ["agent:port:connect","agent:inbox:read","messages:read",
                               "messages:write","agent:jobs:read","agent:runs:callback"],
            "authMode": "static_bearer",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let bearer = confirmed["credential"]
        .as_str()
        .expect("credential")
        .to_string();
    list_tools(&client, &base, &bearer).await;
    let status: String =
        sqlx::query_scalar("SELECT status FROM hosted_agent_connection WHERE id=$1")
            .bind(connection)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(status, "active");

    // The owner's approval did not survive a non-owner's confirm.
    let stored: Vec<Uuid> = sqlx::query_scalar(
        "SELECT approved_dm_channel_ids FROM hosted_agent_connection WHERE id=$1",
    )
    .bind(connection)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(stored.is_empty(), "cleared in the confirm tx: {stored:?}");
    let covered = covered_2915(&app, ws, ws, connection).await;
    assert!(
        !covered.contains(&owner_dm) && !covered.contains(&member_dm),
        "{covered:?}"
    );

    // History: the admin's runtime cannot read the owner's DM.
    let (status, refused) = call(
        &client,
        &base,
        &bearer,
        "oort_conversation_read",
        json!({"channelId": owner_dm, "limit": 10}),
    )
    .await;
    assert_ne!(
        status, 200,
        "owner DM history must not be readable: {refused}"
    );
    // New turns: nothing is created or claimable in either DM.
    say_2915(
        &client,
        &base,
        &fixture.human_jwt,
        ws,
        owner_dm,
        "오늘 일정?",
    )
    .await;
    say_2915(&client, &base, &member_jwt, ws, member_dm, "안녕하세요").await;
    assert_eq!(dm_jobs_2915(&su, ws, agent, owner_dm).await, 0);
    assert_eq!(dm_jobs_2915(&su, ws, agent, member_dm).await, 0);
    assert!(claim_channels_2915(&client, &base, &bearer)
        .await
        .is_empty());
    // And the member is not told to ask the owner (the owner cannot open it).
    let last = hosted_notices(&su, ws, member_dm).await;
    assert_eq!(
        last.last().unwrap()["props"]["reason"],
        "hosted_dm_not_approvable",
        "{last:?}"
    );

    // The owner sees why, and cannot re-open it on this connection.
    let list: Value = client
        .get(format!(
            "{base}/v1/workspaces/{ws}/hosted-agent-connections/{connection}/dm-approvals"
        ))
        .bearer_auth(&fixture.human_jwt)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list["confirmedByNonOwner"], true, "{list}");
    assert_eq!(list["canEdit"], false);
    assert!(
        list["dms"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["state"] == "not_approvable"),
        "{list}"
    );
    let status = client
        .put(&url)
        .bearer_auth(&fixture.human_jwt)
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status.as_u16(), 409);
}

// ---------------------------------------------------------------------------
// (10) ADR-0186 증보 G1~G6 (GC-6 #2947) — oort_card_suggest / card_suggest
// ---------------------------------------------------------------------------

async fn momo_worker_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(
            options.username("momo_worker").password(
                &std::env::var("MOMO_WORKER_PASSWORD")
                    .unwrap_or_else(|_| "momo_worker_dev_pw".to_string()),
            ),
        )
        .await
        .expect("connect as momo_worker after bootstrap_roles.sql")
}

/// A human mention of the hosted agent (optionally in a thread) → the trigger
/// message id and the run it raised.
async fn mention_2947(
    client: &reqwest::Client,
    base: &str,
    su: &PgPool,
    fixture: &Fixture,
    root_id: Option<Uuid>,
) -> (Uuid, Uuid) {
    let handle_name = hosted_handle(su, fixture.hosted_agent).await;
    let mut body = json!({
        "clientMsgId": Uuid::new_v4(),
        "body": format!("@{handle_name} 내 클로드 구독 연결해 줘")
    });
    if let Some(root_id) = root_id {
        body["rootId"] = json!(root_id);
    }
    let trigger: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&body)
        .send()
        .await
        .expect("mention send")
        .json()
        .await
        .expect("mention body");
    let trigger_id = Uuid::parse_str(trigger["id"].as_str().expect("trigger id")).unwrap();
    let run_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM agent_run WHERE workspace_id=$1 AND trigger_message_id=$2",
    )
    .bind(fixture.workspace)
    .bind(trigger_id)
    .fetch_one(su)
    .await
    .expect("the mention raised a run");
    (trigger_id, run_id)
}

async fn suggestion_rows_2947(pool: &PgPool, workspace: Uuid) -> Vec<(Uuid, Value, Option<Uuid>)> {
    sqlx::query_as(
        "SELECT id, props, root_id FROM message \
          WHERE workspace_id=$1 AND props ? 'momo.command_suggest' ORDER BY seq",
    )
    .bind(workspace)
    .fetch_all(pool)
    .await
    .expect("suggestion rows")
}

async fn run_status_2947(pool: &PgPool, run: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id=$1")
        .bind(run)
        .fetch_one(pool)
        .await
        .expect("run status")
}

fn assert_five_keys_2947(props: &Value, for_member: Uuid, args: Value, label: &str) {
    let card = &props["momo.command_suggest"];
    let mut keys: Vec<&str> = card
        .as_object()
        .expect("a command_suggest object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec!["args", "command_id", "for_member_id", "label", "v"],
        "{props}"
    );
    assert_eq!(
        props.as_object().expect("props").len(),
        1,
        "nothing rides beside the card: {props}"
    );
    assert_eq!(card["v"], json!(1));
    assert_eq!(card["command_id"], json!("ai.connect"));
    assert_eq!(card["args"], args);
    assert_eq!(card["for_member_id"], json!(for_member.to_string()));
    assert_eq!(card["label"], json!(label));
}

/// **G6, hosted.** The scope, the refused arguments, the allow-list, the pair
/// rule, the requester, the five keys, the single send transaction, the retry,
/// RLS, and the untouched run — every red proof `oort_card_suggest` owes.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_card_suggestion_is_one_message_for_the_person_who_asked() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();

    let (_trigger, run) = mention_2947(&client, &base, &su, &fixture, None).await;

    // ---- red proof: messages:write on both halves --------------------------
    let full_scopes = "ARRAY['agent:port:connect','agent:inbox:read','messages:read', \
       'messages:write','agent:jobs:read','agent:runs:callback','workspace:propose']::text[]";
    let without_write = "ARRAY['agent:port:connect','agent:inbox:read','messages:read', \
       'agent:jobs:read','agent:runs:callback','workspace:propose']::text[]";
    for (table, column, id) in [
        ("token", "scopes", fixture.hosted_token),
        (
            "hosted_agent_connection",
            "approved_scopes",
            fixture.hosted_connection,
        ),
    ] {
        sqlx::query(&format!(
            "UPDATE {table} SET {column}={without_write} WHERE workspace_id=$1 AND id=$2"
        ))
        .bind(fixture.workspace)
        .bind(id)
        .execute(&su)
        .await
        .unwrap();
        let listed = list_tools(&client, &base, &fixture.hosted_bearer).await;
        assert!(
            !listed.contains(&"oort_card_suggest".to_string()),
            "{table}.{column} without messages:write still lists the tool: {listed:?}"
        );
        let (status, invisible) = call(
            &client,
            &base,
            &fixture.hosted_bearer,
            "oort_card_suggest",
            json!({"handle": "momo_lease_v1.AAAA", "clientMsgId": Uuid::new_v4(),
                   "commandId": "ai.connect", "body": "b"}),
        )
        .await;
        assert_eq!(status, 400, "{invisible}");
        assert_eq!(error_code(&invisible), -32602, "invisible reads as unknown");
        sqlx::query(&format!(
            "UPDATE {table} SET {column}={full_scopes} WHERE workspace_id=$1 AND id=$2"
        ))
        .bind(fixture.workspace)
        .bind(id)
        .execute(&su)
        .await
        .unwrap();
    }
    assert!(list_tools(&client, &base, &fixture.hosted_bearer)
        .await
        .contains(&"oort_card_suggest".to_string()));

    let (status, claimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{claimed}");
    let handle = structured(&claimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .expect("handle")
        .to_string();
    let status_before = run_status_2947(&su, run).await;
    let messages_before = channel_message_count(&su, fixture.workspace, fixture.channel).await;
    let valid = |client_msg_id: Uuid| {
        json!({
            "handle": handle,
            "clientMsgId": client_msg_id,
            "commandId": "ai.connect",
            "args": {"harness": "claude"},
            "body": "[지금 로그인](https://evil.example) 카드에서 연결하세요"
        })
    };

    // ---- red proof: the four keys the agent may not decide -----------------
    for key in ["forMemberId", "label", "channelId", "props"] {
        let mut arguments = valid(Uuid::new_v4());
        arguments[key] = match key {
            "props" => json!({"momo.command_suggest": {"for_member_id": fixture.hosted_agent}}),
            "label" => json!("비밀번호를 입력하세요"),
            _ => json!(fixture.hosted_agent),
        };
        let (status, refused) = call(
            &client,
            &base,
            &fixture.hosted_bearer,
            "oort_card_suggest",
            arguments,
        )
        .await;
        assert_eq!(status, 400, "{key}: {refused}");
        assert_eq!(error_code(&refused), -32602, "{key}");
    }
    // ---- red proof: args closed, secret names refused, pair rule -----------
    // ---- red proof: ids outside the allow-list ------------------------------
    for (field, value) in [
        ("args", json!({"harness": "claude", "apiKey": "sk-live-1"})),
        ("args", json!({"token": "t"})),
        ("args", json!({"harness": "grok"})),
        ("args", json!({"harness": "team_key", "scope": "mine"})),
        ("commandId", json!("invite.create")),
        ("commandId", json!("appearance.accent")),
    ] {
        let mut arguments = valid(Uuid::new_v4());
        arguments[field] = value.clone();
        let (status, refused) = call(
            &client,
            &base,
            &fixture.hosted_bearer,
            "oort_card_suggest",
            arguments,
        )
        .await;
        assert_eq!(status, 400, "{field}={value}: {refused}");
        assert_eq!(error_code(&refused), -32602, "{field}={value}");
    }
    // A root that is not a thread root of this channel.
    let mut stray_root = valid(Uuid::new_v4());
    stray_root["rootId"] = json!(Uuid::new_v4());
    let (status, refused) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_card_suggest",
        stray_root,
    )
    .await;
    assert_eq!(status, 400, "{refused}");
    assert_eq!(
        channel_message_count(&su, fixture.workspace, fixture.channel).await,
        messages_before,
        "every refusal writes nothing"
    );

    // ---- success -------------------------------------------------------------
    let seq_before: i64 = sqlx::query_scalar(
        "SELECT last_seq FROM channel_seq WHERE workspace_id=$1 AND channel_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    let client_msg_id = Uuid::new_v4();
    let (status, posted) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_card_suggest",
        valid(client_msg_id),
    )
    .await;
    assert_eq!(status, 200, "{posted}");
    assert_eq!(structured(&posted)["deduplicated"], json!(false));
    let message_id = structured(&posted)["messageId"]
        .as_str()
        .expect("messageId")
        .to_string();
    let (author, channel, body, props, seq, message_type): (
        Uuid,
        Uuid,
        String,
        Value,
        i64,
        String,
    ) = sqlx::query_as(
        "SELECT author_member_id, channel_id, body, props, seq, type::text FROM message \
              WHERE workspace_id=$1 AND id=$2::uuid",
    )
    .bind(fixture.workspace)
    .bind(&message_id)
    .fetch_one(&su)
    .await
    .expect("the card exists");
    assert_eq!(author, fixture.hosted_agent);
    assert_eq!(
        channel, fixture.channel,
        "the handle's channel, never an argument"
    );
    assert_eq!(message_type, "text");
    assert!(body.contains("카드에서 연결하세요"));
    assert_five_keys_2947(
        &props,
        fixture.human,
        json!({"harness": "claude", "scope": "mine"}),
        "Claude 구독 연결",
    );
    assert!(
        !props.to_string().contains("evil.example"),
        "the agent's words are the body's, never the label's"
    );
    // One send transaction: the seq moved by exactly one, the row holds it, and
    // exactly one broadcast outbox row carries it.
    let seq_after: i64 = sqlx::query_scalar(
        "SELECT last_seq FROM channel_seq WHERE workspace_id=$1 AND channel_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(seq_after, seq_before + 1);
    assert_eq!(seq, seq_after);
    let broadcasts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='broadcast' \
           AND payload->'data'->'payload'->>'id' = $2",
    )
    .bind(fixture.workspace)
    .bind(&message_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(broadcasts, 1, "exactly one outbox row — no direct publish");

    // ---- retry: same clientMsgId → the same one message ---------------------
    let (status, again) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_card_suggest",
        valid(client_msg_id),
    )
    .await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(structured(&again)["deduplicated"], json!(true));
    assert_eq!(structured(&again)["messageId"], json!(message_id));
    assert_eq!(suggestion_rows_2947(&su, fixture.workspace).await.len(), 1);

    // ---- no approval, no run transition --------------------------------------
    let approvals: i64 = sqlx::query_scalar("SELECT count(*) FROM approval WHERE workspace_id=$1")
        .bind(fixture.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(approvals, 0, "a suggestion is not an approval card");
    assert_eq!(
        run_status_2947(&su, run).await,
        status_before,
        "agent_run.status is untouched"
    );

    // ---- RLS: another workspace's GUC sees zero rows ------------------------
    for (guc, expected) in [(Uuid::new_v4(), 0i64), (fixture.workspace, 1i64)] {
        let mut tx = app.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
            .bind(guc.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM message WHERE id=$1::uuid")
            .bind(&message_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        tx.rollback().await.unwrap();
        assert_eq!(visible, expected, "GUC {guc}");
    }
}

/// **G3 / G6 — `for_member_id` cannot be forged, and an agent is nobody's
/// requester.** A run whose trigger an agent wrote (or that has no trigger at
/// all) is `no_human_requester` on both doors, with zero messages.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_run_an_agent_raised_has_nobody_to_suggest_a_card_to() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (_trigger, run) = mention_2947(&client, &base, &su, &fixture, None).await;

    // An agent-authored message in the same channel.
    let (status, spoken) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_message_post",
        json!({"channelId": fixture.channel, "clientMsgId": Uuid::new_v4(), "body": "위임합니다"}),
    )
    .await;
    assert_eq!(status, 200, "{spoken}");
    let agent_message =
        Uuid::parse_str(structured(&spoken)["messageId"].as_str().unwrap()).unwrap();

    let (status, claimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{claimed}");
    let handle = structured(&claimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .expect("handle")
        .to_string();
    let worker = momo_worker_pool().await;

    for trigger in [Some(agent_message), None] {
        sqlx::query("UPDATE agent_run SET trigger_message_id=$2 WHERE id=$1")
            .bind(run)
            .bind(trigger)
            .execute(&su)
            .await
            .unwrap();
        let before = channel_message_count(&su, fixture.workspace, fixture.channel).await;

        let (status, refused) = call(
            &client,
            &base,
            &fixture.hosted_bearer,
            "oort_card_suggest",
            json!({"handle": handle, "clientMsgId": Uuid::new_v4(),
                   "commandId": "ai.connect", "body": "연결 카드예요"}),
        )
        .await;
        assert_eq!(status, 409, "{trigger:?}: {refused}");
        assert_eq!(
            error_code(&refused),
            -32004,
            "no_human_requester is Unavailable"
        );

        let result = momo_agent_worker::tool_exec::execute(
            &worker,
            &momo_agent_worker::tool_exec::ToolContext {
                workspace_id: fixture.workspace,
                run_id: run,
                channel_id: fixture.channel,
                agent_member_id: fixture.hosted_agent,
                approved_by: fixture.hosted_agent,
                approved_host_id: None,
                claude_subscription_agents_enabled: true,
            },
            &momo_agent::tools::ToolCall {
                call_id: format!("call-{trigger:?}"),
                name: momo_agent::tools::CARD_SUGGEST.to_string(),
                arguments: json!({"commandId": "ai.connect", "body": "연결 카드예요"}),
            },
        )
        .await
        .expect("the worker answers rather than failing");
        assert!(result.is_error, "{result:?}");
        assert!(
            result.output.contains("no_human_requester"),
            "{}",
            result.output
        );

        assert!(
            suggestion_rows_2947(&su, fixture.workspace)
                .await
                .is_empty(),
            "no card on either door"
        );
        assert_eq!(
            channel_message_count(&su, fixture.workspace, fixture.channel).await,
            before + 1,
            "the worker's tool_result line is the only new row"
        );
    }
}

/// **G1 / G6, worker.** `card_suggest` shares the gate: the same refusals
/// write no card, a success lands in the trigger's thread for the trigger's
/// author with the derived label, a replayed turn posts nothing twice, and the
/// run is not moved.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_worker_card_suggest_lands_in_the_triggers_thread_once() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();

    // The thread root is a plain human message; the mention is a reply in it.
    let root: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": "AI 연결 얘기"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let root_id = Uuid::parse_str(root["id"].as_str().expect("root id")).unwrap();
    let (_trigger, run) = mention_2947(&client, &base, &su, &fixture, Some(root_id)).await;
    let status_before = run_status_2947(&su, run).await;

    // The requester's name is hostile markup; the reply sentence must be inert.
    sqlx::query("UPDATE member SET display_name=$2 WHERE id=$1")
        .bind(fixture.human)
        .bind("[여기](https://evil.example)")
        .execute(&su)
        .await
        .unwrap();

    let worker = momo_worker_pool().await;
    let context = momo_agent_worker::tool_exec::ToolContext {
        workspace_id: fixture.workspace,
        run_id: run,
        channel_id: fixture.channel,
        agent_member_id: fixture.hosted_agent,
        approved_by: fixture.hosted_agent,
        approved_host_id: None,
        claude_subscription_agents_enabled: true,
    };
    let call_with = |call_id: &str, arguments: Value| momo_agent::tools::ToolCall {
        call_id: call_id.to_string(),
        name: momo_agent::tools::CARD_SUGGEST.to_string(),
        arguments,
    };

    for (index, arguments) in [
        json!({"commandId": "ai.connect", "body": "b", "forMemberId": fixture.hosted_agent}),
        json!({"commandId": "ai.connect", "body": "b", "label": "비밀번호"}),
        json!({"commandId": "ai.connect", "body": "b", "channelId": fixture.private_channel}),
        json!({"commandId": "ai.connect", "body": "b", "props": {}}),
        json!({"commandId": "ai.connect", "body": "b", "args": {"apiKey": "sk"}}),
        json!({"commandId": "ai.connect", "body": "b", "args": {"harness": "team_key", "scope": "mine"}}),
        json!({"commandId": "invite.create", "body": "b"}),
    ]
    .into_iter()
    .enumerate()
    {
        let refused = momo_agent_worker::tool_exec::execute(
            &worker,
            &context,
            &call_with(&format!("bad-{index}"), arguments.clone()),
        )
        .await
        .unwrap();
        assert!(refused.is_error, "{arguments}: {refused:?}");
        assert!(refused.output.contains("invalid_arguments"), "{}", refused.output);
    }
    assert!(suggestion_rows_2947(&su, fixture.workspace)
        .await
        .is_empty());

    let good = call_with(
        "call-good",
        json!({"commandId": "ai.connect", "args": {"scope": "team"}, "body": "팀 키 카드예요"}),
    );
    let first = momo_agent_worker::tool_exec::execute(&worker, &context, &good)
        .await
        .unwrap();
    assert!(!first.is_error, "{first:?}");
    assert!(!first.output.contains("[여기]"), "{}", first.output);
    assert!(!first.output.contains("https://"), "{}", first.output);
    assert!(
        first.output.contains("「팀 AI 키 연결」"),
        "{}",
        first.output
    );

    let rows = suggestion_rows_2947(&su, fixture.workspace).await;
    assert_eq!(rows.len(), 1);
    let (_id, props, card_root) = &rows[0];
    assert_eq!(*card_root, Some(root_id), "the trigger's thread");
    assert_five_keys_2947(
        props,
        fixture.human,
        json!({"harness": "team_key", "scope": "team"}),
        "팀 AI 키 연결",
    );
    // #2959 M1: the card counts as a reply — the rollup moved and
    // `thread.updated` went out beside it.
    assert_eq!(
        thread_rollup_2947(&su, root_id).await,
        (2, 2),
        "trigger reply + card: reply_count 2, thread.updated rows 2"
    );

    // The replay a re-claimed turn performs.
    let replayed = momo_agent_worker::tool_exec::execute(&worker, &context, &good)
        .await
        .unwrap();
    assert_eq!(replayed.output, first.output);
    assert_eq!(suggestion_rows_2947(&su, fixture.workspace).await.len(), 1);
    let results: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id=$1 AND type='tool_result' \
           AND props->>'call_id' = 'call-good'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(results, 1, "one result line beside one card");
    assert_eq!(run_status_2947(&su, run).await, status_before);
    let approvals: i64 = sqlx::query_scalar("SELECT count(*) FROM approval WHERE workspace_id=$1")
        .bind(fixture.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(approvals, 0);
}

/// `(thread.reply_count, thread.updated outbox rows)` for one root.
async fn thread_rollup_2947(pool: &PgPool, root: Uuid) -> (i32, i64) {
    let replies: Option<i32> =
        sqlx::query_scalar("SELECT reply_count FROM thread WHERE root_id=$1")
            .bind(root)
            .fetch_optional(pool)
            .await
            .unwrap();
    let updates: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE kind='broadcast' \
           AND payload->'data'->>'type' = 'thread.updated' \
           AND upper(payload->'data'->'payload'->>'root_id') = upper($1)",
    )
    .bind(root.to_string())
    .fetch_one(pool)
    .await
    .unwrap();
    (replies.unwrap_or(0), updates)
}

async fn cards_2947(pool: &PgPool, workspace: Uuid) -> usize {
    suggestion_rows_2947(pool, workspace).await.len()
}

/// **#2959 M2 — the lease and run-state guards of `oort_card_suggest`.** A
/// handle whose lease lapsed and was re-claimed may not speak for the run; a
/// parked or settled run raises no card. Each refusal is 409/-32005 with zero
/// cards.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_stale_handle_or_a_parked_run_raises_no_card() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (_trigger, run) = mention_2947(&client, &base, &su, &fixture, None).await;

    let claim = |client: reqwest::Client, base: String, bearer: String| async move {
        let (status, claimed) = call(
            &client,
            &base,
            &bearer,
            "oort_jobs_claim",
            json!({"limit": 10}),
        )
        .await;
        assert_eq!(status, 200, "{claimed}");
        structured(&claimed)["jobs"][0]["leaseHandle"]
            .as_str()
            .expect("a lease handle")
            .to_string()
    };
    let stale = claim(client.clone(), base.clone(), fixture.hosted_bearer.clone()).await;
    sqlx::query(
        "UPDATE outbox SET lease_acquired_at = now() - interval '10 minutes', \
                           lease_expires_at = now() - interval '1 minute' \
          WHERE workspace_id=$1 AND kind='agent_job' AND partition_key=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    let fresh = claim(client.clone(), base.clone(), fixture.hosted_bearer.clone()).await;
    assert_ne!(
        stale, fresh,
        "a takeover must mint a new lease, or this proves nothing"
    );

    let suggest = |handle: String| {
        json!({"handle": handle, "clientMsgId": Uuid::new_v4(),
               "commandId": "ai.connect", "body": "연결 카드예요"})
    };
    let (status, refused) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_card_suggest",
        suggest(stale.clone()),
    )
    .await;
    assert_eq!(status, 409, "a stale lease must not post a card: {refused}");
    assert_eq!(error_code(&refused), -32005);
    assert_eq!(cards_2947(&su, fixture.workspace).await, 0);

    for parked in ["awaiting_approval", "cancelled"] {
        sqlx::query(&format!(
            "UPDATE agent_run SET status='{parked}', deadline_at=now() + interval '1 hour' \
              WHERE id=$1"
        ))
        .bind(run)
        .execute(&su)
        .await
        .unwrap();
        let (status, refused) = call(
            &client,
            &base,
            &fixture.hosted_bearer,
            "oort_card_suggest",
            suggest(fresh.clone()),
        )
        .await;
        assert_eq!(status, 409, "{parked}: {refused}");
        assert_eq!(error_code(&refused), -32005, "{parked}");
        assert_eq!(cards_2947(&su, fixture.workspace).await, 0, "{parked}");
    }

    // Control: the live holder on a running run does post.
    sqlx::query("UPDATE agent_run SET status='running', deadline_at=NULL WHERE id=$1")
        .bind(run)
        .execute(&su)
        .await
        .unwrap();
    let (status, posted) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_card_suggest",
        suggest(fresh),
    )
    .await;
    assert_eq!(status, 200, "the live lease holder may post: {posted}");
    assert_eq!(cards_2947(&su, fixture.workspace).await, 1);
}

/// **#2959 M1 (hosted) + L1.** A card with `rootId` is a thread reply in the
/// rollup and in `thread.updated`; a deleted request or a requester who left
/// the channel has nobody to suggest to.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_threaded_card_is_counted_and_a_withdrawn_request_gets_none() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();

    let root: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": "스레드 루트"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let root_id = Uuid::parse_str(root["id"].as_str().expect("root id")).unwrap();
    let (trigger, _run) = mention_2947(&client, &base, &su, &fixture, None).await;
    let (status, claimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{claimed}");
    let handle = structured(&claimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .unwrap()
        .to_string();
    let suggest = |root: Option<Uuid>| {
        let mut arguments = json!({"handle": handle, "clientMsgId": Uuid::new_v4(),
                                   "commandId": "ai.connect", "body": "연결 카드예요"});
        if let Some(root) = root {
            arguments["rootId"] = json!(root);
        }
        arguments
    };

    assert_eq!(thread_rollup_2947(&su, root_id).await, (0, 0));
    let (status, posted) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_card_suggest",
        suggest(Some(root_id)),
    )
    .await;
    assert_eq!(status, 200, "{posted}");
    assert_eq!(
        thread_rollup_2947(&su, root_id).await,
        (1, 1),
        "the card is one reply in the rollup, with one thread.updated"
    );

    // L1 — the person deleted the request.
    sqlx::query("UPDATE message SET deleted_at=now() WHERE id=$1")
        .bind(trigger)
        .execute(&su)
        .await
        .unwrap();
    let (status, refused) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_card_suggest",
        suggest(None),
    )
    .await;
    assert_eq!(status, 409, "deleted request: {refused}");
    assert_eq!(error_code(&refused), -32004);
    sqlx::query("UPDATE message SET deleted_at=NULL WHERE id=$1")
        .bind(trigger)
        .execute(&su)
        .await
        .unwrap();

    // L1 — the person left the channel.
    sqlx::query(
        "UPDATE membership SET left_at=now() WHERE workspace_id=$1 AND channel_id=$2 \
           AND member_id=$3",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .bind(fixture.human)
    .execute(&su)
    .await
    .unwrap();
    let (status, refused) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_card_suggest",
        suggest(None),
    )
    .await;
    assert_eq!(status, 409, "requester left: {refused}");
    assert_eq!(error_code(&refused), -32004);
    assert_eq!(
        cards_2947(&su, fixture.workspace).await,
        1,
        "only the threaded card"
    );
}

// ---------------------------------------------------------------------------
// (10) ADR-0162 증보 3 D11/D12/D15 — progress markers and artifacts (#3516)
// ---------------------------------------------------------------------------

/// Raise a mention for the hosted agent and claim it. Returns the lease handle
/// and the run id.
async fn claimed_run_3516(
    client: &reqwest::Client,
    base: &str,
    su: &PgPool,
    fixture: &Fixture,
) -> (String, Uuid) {
    let handle_name = hosted_handle(su, fixture.hosted_agent).await;
    let trigger: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "body": format!("@{handle_name} 작업해줘")
        }))
        .send()
        .await
        .expect("mention send")
        .json()
        .await
        .expect("mention body");
    assert!(trigger["id"].is_string(), "{trigger}");
    let (status, claimed) = call(
        client,
        base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{claimed}");
    let handle = structured(&claimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .expect("lease handle")
        .to_string();
    let run: Uuid = sqlx::query_scalar(
        "SELECT id FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2 \
          ORDER BY created_at DESC LIMIT 1",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .fetch_one(su)
    .await
    .expect("the run the mention raised");
    (handle, run)
}

/// `(step_count, output)` of one run.
async fn run_record_3516(su: &PgPool, run: Uuid) -> (i32, Value) {
    let row: (i32, Option<Value>) =
        sqlx::query_as("SELECT step_count, output FROM agent_run WHERE id=$1")
            .bind(run)
            .fetch_one(su)
            .await
            .expect("run row");
    (row.0, row.1.unwrap_or(Value::Null))
}

async fn rejected_audits_3516(su: &PgPool, run: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE action='agent.run.report_rejected' \
           AND detail->>'run_id'=$1 ORDER BY created_at",
    )
    .bind(run.to_string())
    .fetch_all(su)
    .await
    .expect("rejected audits")
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn stage_markers_keep_the_latest_twelve_spend_steps_and_refuse_bad_text() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (handle, run) = claimed_run_3516(&client, &base, &su, &fixture).await;
    // A budget small enough to saturate, so the cap is measured and not assumed.
    sqlx::query("UPDATE agent_run SET max_steps=5 WHERE id=$1")
        .bind(run)
        .execute(&su)
        .await
        .unwrap();
    let event = |args: Value| {
        let (client, base, bearer) = (&client, &base, &fixture.hosted_bearer);
        async move { call(client, base, bearer, "oort_run_event", args).await }
    };

    // An event with no marker (the old shape) spends nothing.
    let (status, ok) = event(json!({"leaseHandle": handle, "status": "running"})).await;
    assert_eq!(status, 200, "{ok}");
    assert_eq!(run_record_3516(&su, run).await.0, 0);

    // A retried event (same `eventId`) is one marker and one step, not two.
    let replay_id = Uuid::new_v4();
    for _ in 0..2 {
        let (status, ok) =
            event(json!({"leaseHandle": handle, "stage": "재시도", "eventId": replay_id})).await;
        assert_eq!(status, 200, "{ok}");
    }
    let (steps, output) = run_record_3516(&su, run).await;
    assert_eq!(steps, 1, "a replayed event spends one step");
    assert_eq!(output["stages"], json!(["재시도"]));

    // 14 markers: the newest 12 stay, in order; the step count stops at the cap
    // and no event is refused for reaching it.
    for index in 1..=14 {
        let (status, ok) =
            event(json!({"leaseHandle": handle, "stage": format!("  단계 {index} ")})).await;
        assert_eq!(status, 200, "{index}: {ok}");
    }
    let (steps, output) = run_record_3516(&su, run).await;
    let expected: Vec<Value> = (3..=14)
        .map(|index| json!(format!("단계 {index}")))
        .collect();
    assert_eq!(output["stages"], Value::Array(expected.clone()));
    assert_eq!(steps, 5, "saturates at max_steps");

    // An immediate repeat is one marker.
    let (status, _) = event(json!({"leaseHandle": handle, "stage": "단계 14"})).await;
    assert_eq!(status, 200);
    assert_eq!(
        run_record_3516(&su, run).await.1["stages"],
        Value::Array(expected.clone())
    );

    // Each bad marker is refused with nothing written: no step, no stage, no
    // state change — and one audit row carrying a reason code and no text.
    let before = run_record_3516(&su, run).await;
    let bad_markers = [
        "".to_string(),
        "   ".to_string(),
        "x".repeat(81),
        "a/b".to_string(),
        "a\\b".to_string(),
        "bad\u{7}".to_string(),
        "\u{202E}rtl".to_string(),
    ];
    for bad in &bad_markers {
        let (status, refused) = event(json!({"leaseHandle": handle, "stage": bad})).await;
        assert_eq!(status, 400, "{bad:?}: {refused}");
        assert_eq!(error_code(&refused), -32602);
    }
    // Schema-level refusals (wrong type, over the byte envelope) write nothing either.
    for bad in [json!(3), json!("x".repeat(321))] {
        let (status, _) = event(json!({"leaseHandle": handle, "stage": bad})).await;
        assert_eq!(status, 400);
    }
    assert_eq!(run_record_3516(&su, run).await, before, "no write");
    let audits = rejected_audits_3516(&su, run).await;
    assert_eq!(
        audits.len(),
        bad_markers.len(),
        "one row per refused report"
    );
    for audit in &audits {
        assert_eq!(audit["reason"], json!("stage_invalid"));
        assert_eq!(audit["tool"], json!("oort_run_event"));
        let mut keys: Vec<&str> = audit
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["reason", "run_id", "schema", "tool"],
            "no free text: {audit}"
        );
    }

    // Completing after the markers keeps them; reaching the step cap did not
    // block the completion.
    let (status, done) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_complete",
        json!({"leaseHandle": handle, "status": "succeeded", "body": "끝"}),
    )
    .await;
    assert_eq!(status, 200, "{done}");
    let (steps, output) = run_record_3516(&su, run).await;
    assert_eq!(steps, 5);
    assert_eq!(output["stages"], Value::Array(expected));
    assert_eq!(output["body"], json!("끝"));
    assert_eq!(output["status"], json!("succeeded"));
    assert!(output.get("artifacts").is_none());

    // The handle is dead now (terminal run): a bad marker is answered by the
    // ordinary refusal and adds no audit row, however often it is repeated.
    for _ in 0..5 {
        let (status, _) = event(json!({"leaseHandle": handle, "stage": "a/b"})).await;
        assert_eq!(status, 409);
    }
    assert_eq!(
        rejected_audits_3516(&su, run).await.len(),
        bad_markers.len()
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn artifacts_are_stored_when_valid_and_a_bad_one_refuses_the_whole_completion() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (handle, run) = claimed_run_3516(&client, &base, &su, &fixture).await;
    let complete = |args: Value| {
        let (client, base, bearer) = (&client, &base, &fixture.hosted_bearer);
        async move { call(client, base, bearer, "oort_run_complete", args).await }
    };

    let (status, _) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_event",
        json!({"leaseHandle": handle, "stage": "시작"}),
    )
    .await;
    assert_eq!(status, 200);
    let before = run_record_3516(&su, run).await;
    let messages_before = channel_message_count(&su, fixture.workspace, fixture.channel).await;

    // (artifacts, reason code the audit must carry; None = refused by the
    // transport schema before any transaction opens, so no audit row)
    let refused: Vec<(Value, Option<&str>)> = vec![
        (
            json!({"prUrl": "http://github.com/a/b/pull/1"}),
            Some("artifacts_pr_url_invalid"),
        ),
        (
            json!({"prUrl": "https://evil.example/a/b/pull/1"}),
            Some("artifacts_pr_url_invalid"),
        ),
        (
            json!({"prUrl": "https://github.com/a/b/pull/1/files"}),
            Some("artifacts_pr_url_invalid"),
        ),
        (
            json!({"branch": "/etc/passwd"}),
            Some("artifacts_branch_invalid"),
        ),
        (
            json!({"branch": "fix: rotate the key"}),
            Some("artifacts_branch_invalid"),
        ),
        (
            json!({"branch": "C:\\work"}),
            Some("artifacts_branch_invalid"),
        ),
        (json!({"added": -1}), None),
        (json!({"deleted": 2147483648_i64}), None),
        (json!({"commits": 1.5}), None),
        (json!({"title": "fix the bug"}), None),
        (json!({"files": ["a.rs"]}), None),
        (json!("https://github.com/a/b/pull/1"), None),
        // A good field next to a bad one: the whole report goes.
        (
            json!({"prUrl": "https://github.com/a/b/pull/1", "branch": "bad branch"}),
            Some("artifacts_branch_invalid"),
        ),
    ];
    let mut expected_audits = 0;
    for (artifacts, reason) in &refused {
        let (status, answer) = complete(json!({
            "leaseHandle": handle, "status": "succeeded", "body": "done", "artifacts": artifacts
        }))
        .await;
        assert_eq!(status, 400, "{artifacts}: {answer}");
        assert_eq!(error_code(&answer), -32602);
        if reason.is_some() {
            expected_audits += 1;
        }
    }
    // Nothing was written: the run is still running with the same record, no
    // answer message, no usage row, the lease untouched.
    assert_eq!(run_record_3516(&su, run).await, before);
    let status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id=$1")
        .bind(run)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(status, "running");
    assert_eq!(
        channel_message_count(&su, fixture.workspace, fixture.channel).await,
        messages_before
    );
    let usage_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM usage_ledger WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(usage_rows, 0);
    let audits = rejected_audits_3516(&su, run).await;
    assert_eq!(
        audits.len(),
        expected_audits,
        "one row per report that reached the tool"
    );
    let codes: Vec<&str> = audits
        .iter()
        .map(|a| a["reason"].as_str().unwrap())
        .collect();
    for (_, reason) in refused.iter().filter(|(_, reason)| reason.is_some()) {
        assert!(codes.contains(&reason.unwrap()), "{reason:?} in {codes:?}");
    }
    for audit in &audits {
        assert_eq!(audit["tool"], json!("oort_run_complete"));
        let mut keys: Vec<&str> = audit
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["reason", "run_id", "schema", "tool"],
            "no free text: {audit}"
        );
    }
    let artifacts_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action='agent.run.artifacts_reported' \
           AND detail->>'run_id'=$1",
    )
    .bind(run.to_string())
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        artifacts_audits, 0,
        "a refused report is not a reported one"
    );

    // The same lease completes with a valid report (the refusals did not burn it).
    let (status, done) = complete(json!({
        "leaseHandle": handle, "status": "failed", "error": "tests red",
        "artifacts": {
            "prUrl": "https://GitHub.com/acme/app/pull/42?utm=1#frag",
            "branch": "feat/3516-x", "added": 12, "deleted": 3, "commits": 2
        }
    }))
    .await;
    assert_eq!(status, 200, "{done}");
    let (_, output) = run_record_3516(&su, run).await;
    assert_eq!(
        output["artifacts"],
        json!({
            "prUrl": "https://github.com/acme/app/pull/42",
            "branch": "feat/3516-x", "added": 12, "deleted": 3, "commits": 2
        })
    );
    assert_eq!(output["stages"], json!(["시작"]), "existing keys kept");
    assert_eq!(output["status"], json!("failed"));
    assert!(output["message_id"].is_string());
    let reported: Vec<Value> = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE action='agent.run.artifacts_reported' \
           AND detail->>'run_id'=$1",
    )
    .bind(run.to_string())
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(reported.len(), 1, "one row per completion with artifacts");
    assert_eq!(
        reported[0]["keys"],
        json!(["prUrl", "branch", "added", "deleted", "commits"])
    );
    let rendered = reported[0].to_string();
    assert!(
        !rendered.contains("github.com") && !rendered.contains("feat/3516"),
        "{rendered}"
    );

    // A replayed completion answers, and writes no second report row.
    let (status, _) = complete(json!({
        "leaseHandle": handle, "status": "failed", "error": "tests red",
        "artifacts": {"added": 1}
    }))
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        run_record_3516(&su, run).await.1["artifacts"]["added"],
        json!(12)
    );

    // A retried completion on the finished run answers its first answer even
    // when the retry carries a malformed `artifacts`, and audits nothing.
    let answer = structured(&done)["messageId"].clone();
    let audits_before = rejected_audits_3516(&su, run).await.len();
    for _ in 0..3 {
        let (status, replay) = complete(json!({
            "leaseHandle": handle, "status": "failed", "error": "tests red",
            "artifacts": {"prUrl": "http://evil.example/x"}
        }))
        .await;
        assert_eq!(status, 200, "{replay}");
        assert_eq!(structured(&replay)["messageId"], answer);
    }
    assert_eq!(rejected_audits_3516(&su, run).await.len(), audits_before);
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_dead_lease_cannot_grow_the_audit_log_with_bad_reports() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (handle, run) = claimed_run_3516(&client, &base, &su, &fixture).await;
    // The lease lapses (both timestamps move: `outbox_gateway_lease_shape_ck`).
    sqlx::query(
        "UPDATE outbox SET lease_acquired_at = now() - interval '10 minutes', \
                lease_expires_at = now() - interval '1 minute' \
          WHERE kind='agent_job' AND method='gateway' AND status='pending' \
            AND lower(payload->>'run_id') = lower($1)",
    )
    .bind(run.to_string())
    .execute(&su)
    .await
    .unwrap();
    // #3530: a lapsed lease nobody re-claimed still authorizes its handle, so
    // "dead" now means a takeover — the job is claimed again and the old
    // handle is the stale one.
    let (status, reclaimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{reclaimed}");
    assert_ne!(
        structured(&reclaimed)["jobs"][0]["leaseHandle"].as_str(),
        Some(handle.as_str()),
        "a takeover must mint a new lease, or this proves nothing"
    );
    for _ in 0..4 {
        let (status, _) = call(
            &client,
            &base,
            &fixture.hosted_bearer,
            "oort_run_event",
            json!({"leaseHandle": handle, "stage": "a/b"}),
        )
        .await;
        assert_eq!(status, 409);
        let (status, _) = call(
            &client,
            &base,
            &fixture.hosted_bearer,
            "oort_run_complete",
            json!({"leaseHandle": handle, "status": "succeeded",
                   "artifacts": {"branch": "/etc/passwd"}}),
        )
        .await;
        assert_eq!(status, 409);
    }
    assert!(rejected_audits_3516(&su, run).await.is_empty());
}

// ---------------------------------------------------------------------------
// #3530 AT-8 — hosted lease TTL, implicit renewal, takeover
// ---------------------------------------------------------------------------

/// Seconds until the run's job lease expires, by the database clock (negative
/// once lapsed).
async fn lease_secs_left_3530(su: &PgPool, run: Uuid) -> f64 {
    sqlx::query_scalar(
        "SELECT extract(epoch FROM (lease_expires_at - now()))::float8 FROM outbox \
          WHERE kind='agent_job' AND method='gateway' AND lower(payload->>'run_id') = lower($1)",
    )
    .bind(run.to_string())
    .fetch_one(su)
    .await
    .expect("lease expiry")
}

/// Lapse the run's lease without clearing its owner (both timestamps move for
/// `outbox_gateway_lease_shape_ck`).
async fn lapse_lease_3530(su: &PgPool, run: Uuid) {
    sqlx::query(
        "UPDATE outbox SET lease_acquired_at = now() - interval '2 hours', \
                lease_expires_at = now() - interval '1 minute' \
          WHERE kind='agent_job' AND method='gateway' AND status='pending' \
            AND lower(payload->>'run_id') = lower($1)",
    )
    .bind(run.to_string())
    .execute(su)
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_hosted_claim_leases_for_the_hosted_ttl_and_renew_extends_to_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (handle, run) = claimed_run_3516(&client, &base, &su, &fixture).await;

    // Default 30 minutes — not the managed 30 seconds.
    let left = lease_secs_left_3530(&su, run).await;
    assert!(
        (1700.0..=1800.5).contains(&left),
        "a hosted claim must lease ~30 minutes, got {left}s"
    );

    // Nothing re-queues the job inside the TTL: a second claim 5 minutes in
    // (a lease a 30-second window would long have lost) finds no job.
    sqlx::query(
        "UPDATE outbox SET lease_acquired_at = now() - interval '5 minutes', \
                lease_expires_at = now() + interval '25 minutes' \
          WHERE kind='agent_job' AND method='gateway' AND status='pending' \
            AND lower(payload->>'run_id') = lower($1)",
    )
    .bind(run.to_string())
    .execute(&su)
    .await
    .unwrap();
    let (status, again) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{again}");
    assert!(
        structured(&again)["jobs"]
            .as_array()
            .is_some_and(|jobs| jobs.is_empty()),
        "a live hosted lease must not be claimable by anyone: {again}"
    );

    // Renew extends to the TTL again from a short remainder.
    sqlx::query(
        "UPDATE outbox SET lease_acquired_at = now() - interval '29 minutes', \
                lease_expires_at = now() + interval '20 seconds' \
          WHERE kind='agent_job' AND method='gateway' AND status='pending' \
            AND lower(payload->>'run_id') = lower($1)",
    )
    .bind(run.to_string())
    .execute(&su)
    .await
    .unwrap();
    let (status, renewed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_job_renew",
        json!({"leaseHandle": handle}),
    )
    .await;
    assert_eq!(status, 200, "{renewed}");
    let left = lease_secs_left_3530(&su, run).await;
    assert!(
        (1700.0..=1800.5).contains(&left),
        "renew must extend to the hosted TTL, got {left}s"
    );

    // An expired lease nobody re-claimed is implicitly renewed.
    lapse_lease_3530(&su, run).await;
    let (status, renewed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_job_renew",
        json!({"leaseHandle": handle}),
    )
    .await;
    assert_eq!(status, 200, "an unclaimed expired lease renews: {renewed}");
    assert!((1700.0..=1800.5).contains(&lease_secs_left_3530(&su, run).await));
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_expired_unreclaimed_hosted_handle_still_reports_and_completes() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (handle, run) = claimed_run_3516(&client, &base, &su, &fixture).await;

    // The VM slept past the lease and nobody took the job.
    lapse_lease_3530(&su, run).await;
    let (status, event) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_event",
        json!({"leaseHandle": handle, "stage": "coding"}),
    )
    .await;
    assert_eq!(status, 200, "progress after the gap must land: {event}");

    lapse_lease_3530(&su, run).await;
    let (status, done) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_complete",
        json!({"leaseHandle": handle, "status": "succeeded", "body": "다 했어요"}),
    )
    .await;
    assert_eq!(status, 200, "completion after the gap must land: {done}");
    let run_status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id=$1")
        .bind(run)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(run_status, "succeeded");
    let job_status: String = sqlx::query_scalar(
        "SELECT status::text FROM outbox WHERE kind='agent_job' AND method='gateway' \
            AND lower(payload->>'run_id') = lower($1)",
    )
    .bind(run.to_string())
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(job_status, "done");
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_reclaimed_hosted_job_refuses_the_old_handle_everywhere() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (old, run) = claimed_run_3516(&client, &base, &su, &fixture).await;

    lapse_lease_3530(&su, run).await;
    let (status, reclaimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{reclaimed}");
    let fresh = structured(&reclaimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .expect("takeover handle")
        .to_string();
    assert_ne!(fresh, old);

    for (tool, args) in [
        ("oort_job_renew", json!({"leaseHandle": old})),
        (
            "oort_run_event",
            json!({"leaseHandle": old, "stage": "late"}),
        ),
        (
            "oort_run_complete",
            json!({"leaseHandle": old, "status": "succeeded", "body": "x"}),
        ),
    ] {
        let (status, refused) = call(&client, &base, &fixture.hosted_bearer, tool, args).await;
        assert_eq!(status, 409, "{tool}: {refused}");
        assert_eq!(error_code(&refused), -32005, "{tool}");
    }
    // The takeover's own handle works, and the old refusal changed nothing.
    let (status, done) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_complete",
        json!({"leaseHandle": fresh, "status": "succeeded", "body": "새 손잡이로 끝"}),
    )
    .await;
    assert_eq!(status, 200, "{done}");
}

/// The managed gateway keeps its 30 seconds and its strict expiry (#3530
/// changes hosted claims only).
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_managed_gateway_keeps_its_thirty_second_strict_lease() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server_with_gateway(app, true, true).await;
    let client = reqwest::Client::new();
    let bearer = raw_credential(fixture.workspace);
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'), \
                ARRAY['agent:jobs:read','agent:runs:callback']::text[],'at8-managed')",
    )
    .bind(fixture.workspace)
    .bind(fixture.managed_agent)
    .bind(&bearer)
    .execute(&su)
    .await
    .unwrap();
    let handle_name = hosted_handle(&su, fixture.managed_agent).await;
    let _: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": format!("@{handle_name} hi")}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pending: Value = client
        .get(format!(
            "{base}/v1/workspaces/{}/agents/{}/gateway/jobs/pending",
            fixture.workspace, fixture.managed_agent
        ))
        .bearer_auth(&bearer)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let job = &pending["jobs"][0];
    let job_id = job["id"].as_i64().expect("job id");
    let lease_id = job["leaseId"].as_str().expect("lease").to_string();
    let run_id = job["runId"].as_str().expect("run").to_string();
    let run: Uuid = run_id.parse().unwrap();
    let left = lease_secs_left_3530(&su, run).await;
    assert!(
        (20.0..=30.5).contains(&left),
        "a managed claim must stay at 30 seconds, got {left}s"
    );

    lapse_lease_3530(&su, run).await;
    let renew = client
        .post(format!(
            "{base}/v1/workspaces/{}/agents/{}/gateway/jobs/{job_id}/lease/renew",
            fixture.workspace, fixture.managed_agent
        ))
        .bearer_auth(&bearer)
        .json(&json!({"job_id": job_id, "lease_id": lease_id}))
        .send()
        .await
        .unwrap();
    assert_eq!(renew.status().as_u16(), 409, "managed renew stays strict");
    let complete = client
        .post(format!(
            "{base}/v1/workspaces/{}/agent-runs/{run_id}/gateway/complete",
            fixture.workspace
        ))
        .bearer_auth(&bearer)
        .json(&json!({"job_id": job_id, "lease_id": lease_id, "status": "succeeded", "body": "x"}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        complete.status().as_u16(),
        409,
        "an expired managed lease is not implicitly renewed"
    );
}

/// #3530 review M1: an expired-but-unreclaimed lease must not out-live the
/// per-call re-checks (connection, channel grant, run state). Each case claims,
/// lapses the lease, breaks one precondition, and expects the old handle to be
/// refused by renew, event and complete. `live_first` runs the same breakage
/// on a still-live lease so the two are compared, not just asserted.
async fn expired_then_broken_3530(case: &str) {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (handle, run) = claimed_run_3516(&client, &base, &su, &fixture).await;
    lapse_lease_3530(&su, run).await;
    match case {
        "disconnect" => {
            sqlx::query(
                "UPDATE hosted_agent_connection SET status='cleanup_pending', active_token_id=NULL \
                 WHERE workspace_id=$1 AND id=$2",
            )
            .bind(fixture.workspace)
            .bind(fixture.hosted_connection)
            .execute(&su)
            .await
            .unwrap();
        }
        "narrowed" => {
            sqlx::query(
                "UPDATE hosted_agent_connection SET approved_channel_ids=ARRAY[gen_random_uuid()]::uuid[] \
                 WHERE workspace_id=$1 AND id=$2",
            )
            .bind(fixture.workspace)
            .bind(fixture.hosted_connection)
            .execute(&su)
            .await
            .unwrap();
        }
        "paused" => {
            sqlx::query(
                "UPDATE agent_profile SET paused=true WHERE workspace_id=$1 AND agent_member_id=$2",
            )
            .bind(fixture.workspace)
            .bind(fixture.hosted_agent)
            .execute(&su)
            .await
            .unwrap();
        }
        "cancelled" => {
            sqlx::query("UPDATE agent_run SET status='cancelled' WHERE id=$1")
                .bind(run)
                .execute(&su)
                .await
                .unwrap();
        }
        other => panic!("unknown case {other}"),
    }
    for (tool, args) in [
        ("oort_job_renew", json!({"leaseHandle": handle})),
        (
            "oort_run_event",
            json!({"leaseHandle": handle, "stage": "late"}),
        ),
        (
            "oort_run_complete",
            json!({"leaseHandle": handle, "status": "succeeded", "body": "x"}),
        ),
    ] {
        // `oort_job_renew` is a lease verb with no run check of its own, for a
        // live lease as much as an expired one (it only keeps a lease alive,
        // see the ADR-0186 D2 note above `LeaseVerb::Release`); a cancelled run
        // is stopped at event/complete.
        if case == "cancelled" && tool == "oort_job_renew" {
            continue;
        }
        let (status, refused) =
            call_maybe_empty_3530(&client, &base, &fixture.hosted_bearer, tool, args).await;
        assert!(
            status != 200,
            "{case}/{tool}: an expired lease must not bypass the re-check, got {status}: {refused:?}"
        );
        if let Some(refused) = refused {
            assert!(
                [-32001, -32003, -32004, -32005].contains(&error_code(&refused)),
                "{case}/{tool}: {refused}"
            );
        }
    }
    let run_status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id=$1")
        .bind(run)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_ne!(run_status, "succeeded", "{case}: nothing was completed");
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_expired_hosted_lease_still_meets_every_per_call_recheck_3530() {
    for case in ["disconnect", "narrowed", "cancelled"] {
        expired_then_broken_3530(case).await;
    }
}

/// A paused agent: the gateway lease path never consulted `paused` for a live
/// lease, so an expired one must not behave differently from a live one.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_paused_agent_treats_an_expired_lease_like_a_live_one_3530() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (handle, run) = claimed_run_3516(&client, &base, &su, &fixture).await;
    sqlx::query(
        "UPDATE agent_profile SET paused=true WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    let live = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_event",
        json!({"leaseHandle": handle, "stage": "a"}),
    )
    .await
    .0;
    lapse_lease_3530(&su, run).await;
    let expired = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_event",
        json!({"leaseHandle": handle, "stage": "b"}),
    )
    .await
    .0;
    assert_eq!(live, expired, "pause must not be a lease-expiry side door");
}

// ---------------------------------------------------------------------------
// ADR-0186 증보 2026-10-11 S0 (#3705) — the pending ceiling (V1-e)
// ---------------------------------------------------------------------------

/// Mention, claim and propose once, returning the HTTP status and body instead
/// of asserting success — the shape the ceiling test needs for its 4th call.
async fn try_propose_invite_3705(
    client: &reqwest::Client,
    base: &str,
    su: &PgPool,
    fixture: &Fixture,
) -> (u16, Value) {
    let handle_name = hosted_handle(su, fixture.hosted_agent).await;
    let trigger: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "body": format!("@{handle_name} 초대 링크 또 만들어줘")
        }))
        .send()
        .await
        .expect("mention send")
        .json()
        .await
        .expect("mention body");
    assert!(trigger["id"].is_string(), "{trigger}");
    let (status, claimed) = call(
        client,
        base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{claimed}");
    let handle = structured(&claimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .expect("a lease handle")
        .to_string();
    call(
        client,
        base,
        &fixture.hosted_bearer,
        "oort_action_propose",
        json!({"handle": handle, "actionId": "invite.create", "args": {"role": "member"}}),
    )
    .await
}

async fn pending_workspace_actions_3705(pool: &PgPool, fixture: &Fixture) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM approval WHERE workspace_id=$1 AND requested_by=$2 \
           AND action_type='workspace_action' AND status='pending'",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .fetch_one(pool)
    .await
    .expect("count pending workspace actions")
}

/// **ADR-0186 증보 V1-e — an agent may have three pending proposals, no more.**
///
/// Sequential runs, because a run parks on each proposal: the 4th proposal is
/// `Conflict` with no card, no approval row and no parked run; deciding one of
/// the three frees the slot (the ceiling counts `pending`, not history).
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_fourth_pending_workspace_action_is_refused_and_a_decision_frees_a_slot() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();

    let mut approvals = Vec::new();
    for _ in 0..momo_agent::MAX_PENDING_WORKSPACE_ACTIONS {
        let (status, proposed) = try_propose_invite_3705(&client, &base, &su, &fixture).await;
        assert_eq!(status, 200, "{proposed}");
        approvals.push(
            Uuid::parse_str(structured(&proposed)["approvalId"].as_str().expect("id"))
                .expect("uuid"),
        );
    }
    assert_eq!(pending_workspace_actions_3705(&su, &fixture).await, 3);

    let cards_before = channel_message_count(&su, fixture.workspace, fixture.channel).await;
    let (status, refused) = try_propose_invite_3705(&client, &base, &su, &fixture).await;
    assert_eq!(
        status, 409,
        "the 4th pending proposal is a conflict: {refused}"
    );
    assert_eq!(
        pending_workspace_actions_3705(&su, &fixture).await,
        3,
        "no 4th approval row"
    );
    // The 4th mention posted one human message; no card or approval followed.
    assert_eq!(
        channel_message_count(&su, fixture.workspace, fixture.channel).await,
        cards_before + 1,
        "the refused proposal wrote no card"
    );
    let parked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2 \
           AND status::text='awaiting_approval'",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(parked, 3, "the refused run was not parked");

    // Rejecting one frees a slot: the ceiling is about what is waiting.
    assert_eq!(
        decide(&client, &base, &fixture, approvals[0], false).await,
        200
    );
    assert_eq!(pending_workspace_actions_3705(&su, &fixture).await, 2);
    let (status, accepted) = try_propose_invite_3705(&client, &base, &su, &fixture).await;
    assert_eq!(status, 200, "{accepted}");
    assert_eq!(pending_workspace_actions_3705(&su, &fixture).await, 3);
}

/// **The ceiling's lock is real.** Two proposals of one agent must not both read
/// the count before either writes: the second `lock_agent_and_count…` blocks
/// until the first transaction ends. Without the `FOR NO KEY UPDATE` the second
/// call returns immediately — the exact interleaving that lets four proposals
/// through a ceiling of three.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_pending_count_serialises_proposals_of_one_agent() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su).await;

    let mut first = su.begin().await.expect("first transaction");
    let seen = momo_agent::lock_agent_and_count_pending_workspace_actions_in_tx(
        &mut first,
        fixture.workspace,
        fixture.hosted_agent,
    )
    .await
    .expect("first count");
    assert_eq!(seen, 0);

    let pool = su.clone();
    let (workspace, agent) = (fixture.workspace, fixture.hosted_agent);
    let mut second = tokio::spawn(async move {
        let mut tx = pool.begin().await.expect("second transaction");
        let seen = momo_agent::lock_agent_and_count_pending_workspace_actions_in_tx(
            &mut tx, workspace, agent,
        )
        .await
        .expect("second count");
        tx.commit().await.expect("second commit");
        seen
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(600), &mut second)
            .await
            .is_err(),
        "the second proposal read the count while the first still held the agent"
    );
    first.commit().await.expect("first commit");
    assert_eq!(second.await.expect("second task"), 0);
}

// ---------------------------------------------------------------------------
// ADR-0186 증보 2026-10-11 S1 (#3706) — channel.create (V3 합성)
// ---------------------------------------------------------------------------

/// Mention, claim and propose `action_id`, returning the raw tool answer.
async fn try_propose_action_3706(
    client: &reqwest::Client,
    base: &str,
    su: &PgPool,
    fixture: &Fixture,
    action_id: &str,
    args: Value,
) -> (u16, Value) {
    let handle_name = hosted_handle(su, fixture.hosted_agent).await;
    let trigger: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "body": format!("@{handle_name} {action_id} 부탁해")
        }))
        .send()
        .await
        .expect("mention send")
        .json()
        .await
        .expect("mention body");
    assert!(trigger["id"].is_string(), "{trigger}");
    let (status, claimed) = call(
        client,
        base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{claimed}");
    let handle = structured(&claimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .expect("a lease handle")
        .to_string();
    call(
        client,
        base,
        &fixture.hosted_bearer,
        "oort_action_propose",
        json!({"handle": handle, "actionId": action_id, "args": args}),
    )
    .await
}

fn proposed_approval_3706(answer: &Value) -> Uuid {
    Uuid::parse_str(
        structured(answer)["approvalId"]
            .as_str()
            .unwrap_or_else(|| panic!("no approvalId in {answer}")),
    )
    .expect("uuid")
}

/// An active human in the fixture workspace that is a workspace member but not
/// (yet) in any channel. Returns `(member id, handle)`.
async fn seed_extra_member_3706(pool: &PgPool, fixture: &Fixture, tag: &str) -> (Uuid, String) {
    let member = Uuid::new_v4();
    let handle = format!("{tag}-{}", &member.simple().to_string()[..8]);
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human',$3,$4)",
    )
    .bind(member)
    .bind(fixture.workspace)
    .bind(format!("Extra {tag}"))
    .bind(&handle)
    .execute(pool)
    .await
    .expect("seed extra member");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(member)
    .bind(fixture.workspace)
    .bind(format!("{member}@tools.test"))
    .execute(pool)
    .await
    .expect("seed extra identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
    )
    .bind(fixture.workspace)
    .bind(member)
    .execute(pool)
    .await
    .expect("seed extra workspace membership");
    (member, handle)
}

async fn hosted_approved_3706(pool: &PgPool, fixture: &Fixture) -> Vec<Uuid> {
    sqlx::query_scalar("SELECT approved_channel_ids FROM hosted_agent_connection WHERE id=$1")
        .bind(fixture.hosted_connection)
        .fetch_one(pool)
        .await
        .expect("approved channels")
}

/// The columns of the hosted connection that ADR-0162 增보 2 hangs the DM rule
/// on: a channel grant must not touch any of them.
async fn hosted_confirm_columns_3706(pool: &PgPool, fixture: &Fixture) -> String {
    sqlx::query_scalar(
        "SELECT concat_ws('|', confirmed_by, confirmed_at, active_token_id, \
                array_to_string(approved_scopes, ','), \
                array_to_string(approved_dm_channel_ids, ',')) \
           FROM hosted_agent_connection WHERE id=$1",
    )
    .bind(fixture.hosted_connection)
    .fetch_one(pool)
    .await
    .expect("confirm columns")
}

async fn channel_row_3706(
    pool: &PgPool,
    workspace: Uuid,
    name: &str,
) -> Option<(Uuid, String, Uuid)> {
    sqlx::query_as(
        "SELECT id, kind::text, created_by FROM channel \
          WHERE workspace_id=$1 AND name=$2 AND archived_at IS NULL",
    )
    .bind(workspace)
    .bind(name)
    .fetch_optional(pool)
    .await
    .expect("channel row")
}

async fn audit_count_3706(pool: &PgPool, workspace: Uuid, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND action=$2")
        .bind(workspace)
        .bind(action)
        .fetch_one(pool)
        .await
        .expect("audit count")
}

/// **channel.create, end to end (증보 V3, V6, V11).**
///
/// One approval creates the channel as the approver, seats the proposing agent
/// and the named member, and puts the channel in the agent's approved set — and
/// nothing about the connection's confirm columns moves. A non-admin is refused
/// with the approval intact; the agent reads the new channel's id from its own
/// outcome line and can then post there.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_approved_channel_create_is_one_step_for_channel_membership_and_grant() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let plain_jwt = seed_plain_member(&su, &fixture).await;
    let (extra, extra_handle) = seed_extra_member_3706(&su, &fixture, "guest").await;
    // The fixture's generated handle is longer than the 32 a real workspace
    // allows; give the approver a legal one so it can be named in the proposal.
    let approver_handle = format!("boss-{}", &Uuid::new_v4().simple().to_string()[..8]);
    sqlx::query("UPDATE member SET handle=$2 WHERE id=$1")
        .bind(fixture.human)
        .bind(&approver_handle)
        .execute(&su)
        .await
        .unwrap();
    let name = format!("plan-{}", &Uuid::new_v4().simple().to_string()[..8]);

    // The approver's own handle is in the list on purpose: the approver already
    // owns the channel, and re-adding them must not downgrade `owner`.
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "channel.create",
        json!({"name": name, "memberHandles": [extra_handle, approver_handle]}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let approval_id = proposed_approval_3706(&proposed);
    let card_message_id =
        Uuid::parse_str(structured(&proposed)["cardMessageId"].as_str().unwrap()).unwrap();

    // The card shows the server's names and the widening row, not the handles.
    let card: Value = sqlx::query_scalar("SELECT props FROM message WHERE id=$1")
        .bind(card_message_id)
        .fetch_one(&su)
        .await
        .unwrap();
    let rows = card["action"]["rows"].as_array().expect("rows").clone();
    let row = |label: &str| {
        rows.iter()
            .find(|row| row["label"] == label)
            .unwrap_or_else(|| panic!("no {label} row in {rows:?}"))["value"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(row("채널"), format!("#{name}"));
    assert_eq!(row("공개 범위"), "비공개", "the default kind is private");
    assert!(row("이 에이전트도 참여").starts_with("예"));
    // Display names are not unique, handles are: the card names both, so the
    // approver reads exactly who is being seated.
    assert!(row("함께 넣을 멤버").contains("Extra guest"));
    assert!(
        row("함께 넣을 멤버").contains(&format!("(@{extra_handle})")),
        "{}",
        row("함께 넣을 멤버")
    );
    assert_eq!(card["action"]["required_role"], json!("admin"));
    assert!(channel_row_3706(&su, fixture.workspace, &name)
        .await
        .is_none());

    let approved_before = hosted_approved_3706(&su, &fixture).await;
    let confirm_before = hosted_confirm_columns_3706(&su, &fixture).await;
    let jobs_before = agent_job_count(&su, fixture.workspace, fixture.hosted_agent).await;

    // ---- a non-admin is refused; nothing happens ---------------------------
    let (status, _h, refused) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &plain_jwt,
        approval_id,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 403, "{refused}");
    assert_eq!(refused["status"], "role_required");
    assert!(channel_row_3706(&su, fixture.workspace, &name)
        .await
        .is_none());
    assert_eq!(hosted_approved_3706(&su, &fixture).await, approved_before);
    let pending: String = sqlx::query_scalar("SELECT status::text FROM approval WHERE id=$1")
        .bind(approval_id)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(pending, "pending");

    // ---- an agent cannot decide -------------------------------------------
    let agent_try = client
        .post(format!(
            "{base}/v1/workspaces/{}/approvals/{approval_id}/decision",
            fixture.workspace
        ))
        .bearer_auth(&fixture.hosted_bearer)
        .json(&json!({"approvalId": approval_id, "approve": true,
                      "clientDecisionId": Uuid::new_v4()}))
        .send()
        .await
        .expect("agent decision responds");
    assert!(
        matches!(agent_try.status().as_u16(), 401 | 403),
        "an agent bearer must not decide: {}",
        agent_try.status()
    );
    assert!(channel_row_3706(&su, fixture.workspace, &name)
        .await
        .is_none());

    // ---- the admin approves ------------------------------------------------
    let (status, headers, approved) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval_id,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{approved}");
    assert_eq!(
        headers.get("cache-control").and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    assert_eq!(approved["result"]["actionId"], json!("channel.create"));
    assert_eq!(approved["result"]["ref"]["type"], json!("channel"));
    assert!(
        approved["result"].get("secretOnce").is_none(),
        "channel.create mints no one-time value: {approved}"
    );
    let (channel_id, kind, created_by) = channel_row_3706(&su, fixture.workspace, &name)
        .await
        .expect("the channel exists");
    assert_eq!(
        approved["result"]["ref"]["id"],
        json!(channel_id.to_string())
    );
    assert_eq!(kind, "private");
    assert_eq!(created_by, fixture.human, "the APPROVER created it");

    let roles: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT member_id, role::text FROM membership \
          WHERE workspace_id=$1 AND channel_id=$2 AND left_at IS NULL",
    )
    .bind(fixture.workspace)
    .bind(channel_id)
    .fetch_all(&su)
    .await
    .unwrap();
    let role_of = |member: Uuid| {
        roles
            .iter()
            .find(|(id, _)| *id == member)
            .map(|(_, role)| role.as_str())
    };
    assert_eq!(role_of(fixture.human), Some("owner"), "{roles:?}");
    assert_eq!(role_of(fixture.hosted_agent), Some("member"), "{roles:?}");
    assert_eq!(role_of(extra), Some("member"), "{roles:?}");
    assert_eq!(roles.len(), 3, "{roles:?}");

    let approved_after = hosted_approved_3706(&su, &fixture).await;
    assert!(approved_after.contains(&channel_id));
    assert_eq!(approved_after.len(), approved_before.len() + 1);
    assert_eq!(
        hosted_confirm_columns_3706(&su, &fixture).await,
        confirm_before,
        "a grant never touches the confirm columns"
    );
    let covered: Vec<Uuid> =
        sqlx::query_scalar("SELECT unnest(hosted_connection_channel_ids($1,$2))")
            .bind(fixture.workspace)
            .bind(fixture.hosted_connection)
            .fetch_all(&su)
            .await
            .unwrap();
    assert!(covered.contains(&channel_id));

    // ---- audit -------------------------------------------------------------
    assert_eq!(
        audit_count_3706(&su, fixture.workspace, "channel.created").await,
        1
    );
    assert_eq!(
        audit_count_3706(&su, fixture.workspace, "hosted_connection.channels_granted").await,
        1
    );
    let detail: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id=$1 AND action='channel.created'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(detail["name"], json!(name));
    assert_eq!(
        detail["member_count"],
        json!(1),
        "only the one actually seated"
    );
    assert_eq!(
        detail["member_ids"],
        json!([extra.to_string()]),
        "the audit row names who got in; the approver and the agent are not 'added'"
    );
    assert_eq!(detail["add_proposer"], json!(true));
    assert_eq!(detail["via_agent"], json!(fixture.hosted_agent.to_string()));
    assert_eq!(detail["approval_id"], json!(approval_id.to_string()));

    // ---- the run ended, with no job behind it ------------------------------
    assert_eq!(
        agent_job_count(&su, fixture.workspace, fixture.hosted_agent).await,
        jobs_before
    );

    // ---- the agent can read the id and then speak in the new channel -------
    let line: (String, Value) = sqlx::query_as(
        "SELECT body, props FROM message WHERE workspace_id=$1 AND channel_id=$2 \
           AND props ? 'momo.action_result' ORDER BY seq DESC LIMIT 1",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(line.0.contains(&channel_id.to_string()), "{}", line.0);
    assert!(
        line.1["momo.action_result"].get("next").is_none(),
        "no dead settings link on a channel result"
    );
    let (status, read) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_conversation_read",
        json!({"channelId": fixture.channel, "limit": 20}),
    )
    .await;
    assert_eq!(status, 200, "{read}");
    assert!(
        structured(&read)
            .to_string()
            .contains(&channel_id.to_string()),
        "the agent must be able to read the new channel's id: {read}"
    );
    let (status, posted) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_message_post",
        json!({"channelId": channel_id, "clientMsgId": Uuid::new_v4(), "body": "첫 인사"}),
    )
    .await;
    assert_eq!(
        status, 200,
        "the agent is a member AND approved there: {posted}"
    );
}

/// `addProposer: false` seats and grants nothing for the agent.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_channel_create_without_the_proposer_widens_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let name = format!("solo-{}", &Uuid::new_v4().simple().to_string()[..8]);

    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "channel.create",
        json!({"name": name, "kind": "public", "addProposer": false}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let card_message_id =
        Uuid::parse_str(structured(&proposed)["cardMessageId"].as_str().unwrap()).unwrap();
    let card: Value = sqlx::query_scalar("SELECT props FROM message WHERE id=$1")
        .bind(card_message_id)
        .fetch_one(&su)
        .await
        .unwrap();
    assert!(card["action"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["label"] == "이 에이전트도 참여" && row["value"] == "아니요"));

    let approved_before = hosted_approved_3706(&su, &fixture).await;
    let (status, _h, approved) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        proposed_approval_3706(&proposed),
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{approved}");
    let (channel_id, kind, _) = channel_row_3706(&su, fixture.workspace, &name)
        .await
        .expect("channel");
    assert_eq!(kind, "public");
    let agent_in: i64 =
        sqlx::query_scalar("SELECT count(*) FROM membership WHERE channel_id=$1 AND member_id=$2")
            .bind(channel_id)
            .bind(fixture.hosted_agent)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(agent_in, 0, "the agent was not seated");
    assert_eq!(hosted_approved_3706(&su, &fixture).await, approved_before);
    assert_eq!(
        audit_count_3706(&su, fixture.workspace, "hosted_connection.channels_granted").await,
        0
    );
    assert_eq!(
        audit_count_3706(&su, fixture.workspace, "channel.created").await,
        1
    );
}

/// A failure after the channel row exists rolls back **everything**, leaves the
/// approval pending, and a retry after the fault is cleared succeeds. The fault
/// is injected as a trigger that refuses the extra member's `membership` insert,
/// i.e. it fires after the channel, the creator's membership and the agent's
/// membership were already written in the same transaction.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_channel_create_that_fails_midway_leaves_no_trace_and_can_be_retried() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (extra, extra_handle) = seed_extra_member_3706(&su, &fixture, "late").await;
    let name = format!("atomic-{}", &Uuid::new_v4().simple().to_string()[..8]);

    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "channel.create",
        json!({"name": name, "memberHandles": [extra_handle]}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let approval_id = proposed_approval_3706(&proposed);
    let approved_before = hosted_approved_3706(&su, &fixture).await;

    sqlx::query(&format!(
        "CREATE OR REPLACE FUNCTION fail_membership_3706() RETURNS trigger LANGUAGE plpgsql AS \
         $$ BEGIN IF NEW.member_id = '{extra}' THEN RAISE EXCEPTION 'injected failure'; END IF; \
         RETURN NEW; END $$"
    ))
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER fail_membership_3706 BEFORE INSERT ON membership \
           FOR EACH ROW EXECUTE FUNCTION fail_membership_3706()",
    )
    .execute(&su)
    .await
    .unwrap();

    let (status, _h, failed) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval_id,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert!(
        status >= 500,
        "an injected fault is a server error: {status} {failed}"
    );
    assert!(
        channel_row_3706(&su, fixture.workspace, &name)
            .await
            .is_none(),
        "the channel row was rolled back"
    );
    assert_eq!(hosted_approved_3706(&su, &fixture).await, approved_before);
    for action in [
        "channel.created",
        "action.approved",
        "hosted_connection.channels_granted",
    ] {
        assert_eq!(
            audit_count_3706(&su, fixture.workspace, action).await,
            0,
            "{action}"
        );
    }
    let (state, run_state): (String, String) = sqlx::query_as(
        "SELECT a.status::text, r.status::text FROM approval a \
           JOIN agent_run r ON r.id = a.run_id WHERE a.id=$1",
    )
    .bind(approval_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        (state.as_str(), run_state.as_str()),
        ("pending", "awaiting_approval")
    );

    // The fault is cleared; the very same approval can now be decided.
    sqlx::query("DROP TRIGGER fail_membership_3706 ON membership")
        .execute(&su)
        .await
        .unwrap();
    let (status, _h, retried) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval_id,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{retried}");
    assert!(channel_row_3706(&su, fixture.workspace, &name)
        .await
        .is_some());
}

/// Stale or unsound proposals: unresolvable handles are the one
/// `InvalidArguments`; a name taken before the tap, and a connection already at
/// its ceiling, leave the approval pending with `action_args_invalid`.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_stale_or_unsound_channel_proposal_changes_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let approvals_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM approval WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap();

    // An unknown handle, a malformed one, a deactivated member and an id all
    // fail the same way, and no approval row is written.
    let (gone, gone_handle) = seed_extra_member_3706(&su, &fixture, "gone").await;
    sqlx::query("UPDATE member SET status='suspended' WHERE id=$1")
        .bind(gone)
        .execute(&su)
        .await
        .unwrap_or_else(|_| panic!("deactivate"));
    let mut codes = Vec::new();
    for args in [
        json!({"name": "ok-name", "memberHandles": ["nobody-here"]}),
        json!({"name": "ok-name", "memberHandles": ["Not A Handle"]}),
        json!({"name": "ok-name", "memberHandles": [gone_handle]}),
        json!({"name": "ok-name", "memberHandles": [Uuid::new_v4().to_string()]}),
        json!({"name": "UPPER CASE"}),
    ] {
        let (status, refused) = try_propose_action_3706(
            &client,
            &base,
            &su,
            &fixture,
            "channel.create",
            args.clone(),
        )
        .await;
        codes.push((status, error_code(&refused)));
        assert_eq!(status, 400, "{args}: {refused}");
    }
    assert!(codes.windows(2).all(|pair| pair[0] == pair[1]), "{codes:?}");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM approval WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap(),
        approvals_before
    );

    // `addProposer: false` while listing the proposer itself would make the card
    // contradict itself: refused like any other unresolvable proposal.
    let agent_handle = format!("agent-{}", &Uuid::new_v4().simple().to_string()[..8]);
    sqlx::query("UPDATE member SET handle=$2 WHERE id=$1")
        .bind(fixture.hosted_agent)
        .bind(&agent_handle)
        .execute(&su)
        .await
        .unwrap();
    let (status, refused) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "channel.create",
        json!({"name": "self-ref", "addProposer": false, "memberHandles": [agent_handle]}),
    )
    .await;
    assert_eq!(status, 400, "{refused}");

    // A name that already exists (even a private channel the agent cannot see)
    // does NOT fail the proposal — that would be an existence oracle — but the
    // tap is refused as stale and the approval stays pending.
    let taken = format!("taken-{}", &Uuid::new_v4().simple().to_string()[..8]);
    let existing = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel(id, workspace_id, kind, name, created_by) \
         VALUES($1,$2,'private',$3,$4)",
    )
    .bind(existing)
    .bind(fixture.workspace)
    .bind(&taken)
    .bind(fixture.human)
    .execute(&su)
    .await
    .unwrap();
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "channel.create",
        json!({"name": taken}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let approval_id = proposed_approval_3706(&proposed);
    let (status, _h, stale) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval_id,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{stale}");
    assert_eq!(stale["status"], "action_args_invalid");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM channel WHERE workspace_id=$1 AND lower(name)=$2")
            .bind(fixture.workspace)
            .bind(&taken)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(count, 1, "no second channel");
    let state: String = sqlx::query_scalar("SELECT status::text FROM approval WHERE id=$1")
        .bind(approval_id)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(state, "pending");

    // A connection already at the 50-channel ceiling cannot take one more.
    let name = format!("fifty-{}", &Uuid::new_v4().simple().to_string()[..8]);
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "channel.create",
        json!({"name": name}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_channel_ids = \
            ARRAY(SELECT gen_random_uuid() FROM generate_series(1,50)) WHERE id=$1",
    )
    .bind(fixture.hosted_connection)
    .execute(&su)
    .await
    .unwrap();
    let (status, _h, capped) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        proposed_approval_3706(&proposed),
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{capped}");
    assert_eq!(capped["status"], "action_args_invalid");
    assert!(channel_row_3706(&su, fixture.workspace, &name)
        .await
        .is_none());
    assert_eq!(hosted_approved_3706(&su, &fixture).await.len(), 50);
}

// ---------------------------------------------------------------------------
// ADR-0186 증보 2026-10-11 S2 (#3707) — channel.member.add
// ---------------------------------------------------------------------------

/// A channel made by the fixture's human, with `members` seated (role `member`
/// unless named otherwise).
async fn seed_channel_3707(
    pool: &PgPool,
    fixture: &Fixture,
    kind: &str,
    members: &[(Uuid, &str)],
) -> (Uuid, String) {
    let channel = Uuid::new_v4();
    let name = format!("room-{}", &channel.simple().to_string()[..10]);
    sqlx::query(
        "INSERT INTO channel(id, workspace_id, kind, name, created_by) \
         VALUES($1,$2,$3::channel_kind,$4,$5)",
    )
    .bind(channel)
    .bind(fixture.workspace)
    .bind(kind)
    .bind(&name)
    .bind(fixture.human)
    .execute(pool)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
        .bind(channel)
        .bind(fixture.workspace)
        .execute(pool)
        .await
        .expect("seed channel seq");
    sqlx::query(
        "INSERT INTO membership(workspace_id, channel_id, member_id, role) \
         VALUES($1,$2,$3,'owner')",
    )
    .bind(fixture.workspace)
    .bind(channel)
    .bind(fixture.human)
    .execute(pool)
    .await
    .expect("seed owner");
    for (member, role) in members {
        sqlx::query(
            "INSERT INTO membership(workspace_id, channel_id, member_id, role) \
             VALUES($1,$2,$3,$4::membership_role)",
        )
        .bind(fixture.workspace)
        .bind(channel)
        .bind(member)
        .bind(role)
        .execute(pool)
        .await
        .expect("seed member");
    }
    (channel, name)
}

async fn membership_role_3707(pool: &PgPool, channel: Uuid, member: Uuid) -> Option<String> {
    sqlx::query_scalar(
        "SELECT role::text FROM membership WHERE channel_id=$1 AND member_id=$2 AND left_at IS NULL",
    )
    .bind(channel)
    .bind(member)
    .fetch_optional(pool)
    .await
    .expect("membership role")
}

/// **channel.member.add (증보 V1-b, V6, V11).**
///
/// Visible = public, or private with the agent as a live member. Anything else
/// is one indistinguishable `InvalidArguments`. Approving seats the new members
/// as `member` only — an existing channel admin is skipped, never demoted — and
/// a proposal gone stale (the agent left the room) is refused with the approval
/// still pending.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_approved_member_add_seats_members_in_a_channel_the_agent_can_see() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let plain_jwt = seed_plain_member(&su, &fixture).await;
    let (x1, x1_handle) = seed_extra_member_3706(&su, &fixture, "one").await;
    let (x2, x2_handle) = seed_extra_member_3706(&su, &fixture, "two").await;
    let (y, y_handle) = seed_extra_member_3706(&su, &fixture, "adm").await;

    // P: private, the agent is in it, `y` is already its channel admin.
    let (p, p_name) = seed_channel_3707(
        &su,
        &fixture,
        "private",
        &[(fixture.hosted_agent, "member"), (y, "admin")],
    )
    .await;
    // Q: public, the agent is not in it. R: private, the agent is not in it.
    let (q, q_name) = seed_channel_3707(&su, &fixture, "public", &[]).await;
    let (_r, r_name) = seed_channel_3707(&su, &fixture, "private", &[]).await;

    // ---- P: card, gate, execution -----------------------------------------
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "channel.member.add",
        json!({"channel": format!("#{}", p_name.to_uppercase()), "memberHandles": [x1_handle, y_handle]}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let approval_p = proposed_approval_3706(&proposed);
    let card: Value = sqlx::query_scalar("SELECT props FROM message WHERE id=$1")
        .bind(Uuid::parse_str(structured(&proposed)["cardMessageId"].as_str().unwrap()).unwrap())
        .fetch_one(&su)
        .await
        .unwrap();
    let rows = card["action"]["rows"].as_array().unwrap().clone();
    let row = |label: &str| {
        rows.iter()
            .find(|row| row["label"] == label)
            .unwrap_or_else(|| panic!("no {label} row in {rows:?}"))["value"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(
        row("채널"),
        format!("#{p_name}"),
        "the server's name, not the agent's spelling"
    );
    assert_eq!(row("공개 범위"), "비공개");
    assert_eq!(row("현재 인원"), "3명");
    assert_eq!(
        row("추가할 멤버"),
        format!("Extra one (@{x1_handle})"),
        "only the new member is listed, by name and handle"
    );
    assert_eq!(row("이미 있는 멤버"), "1명");

    let (status, _h, refused) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &plain_jwt,
        approval_p,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 403, "{refused}");
    assert_eq!(refused["status"], "role_required");
    assert_eq!(membership_role_3707(&su, p, x1).await, None);

    let (status, _h, approved) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval_p,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{approved}");
    assert_eq!(approved["result"]["actionId"], json!("channel.member.add"));
    assert_eq!(
        approved["result"]["ref"],
        json!({"type": "channel", "id": p.to_string()})
    );
    assert!(approved["result"].get("secretOnce").is_none());
    assert_eq!(
        membership_role_3707(&su, p, x1).await.as_deref(),
        Some("member")
    );
    assert_eq!(
        membership_role_3707(&su, p, y).await.as_deref(),
        Some("admin"),
        "an existing channel admin is skipped, never demoted"
    );
    assert_eq!(
        audit_count_3706(&su, fixture.workspace, "channel.member_added").await,
        1,
        "one row per member actually seated"
    );
    let detail: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id=$1 AND action='channel.member_added'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(detail["role"], json!("member"));
    assert_eq!(detail["via_agent"], json!(fixture.hosted_agent.to_string()));
    assert_eq!(detail["approval_id"], json!(approval_p.to_string()));

    // ---- Q: a public channel is visible without membership ----------------
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "channel.member.add",
        json!({"channel": q_name, "memberHandles": [x2_handle]}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let (status, _h, approved) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        proposed_approval_3706(&proposed),
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{approved}");
    assert_eq!(
        membership_role_3707(&su, q, x2).await.as_deref(),
        Some("member")
    );
    assert_eq!(
        membership_role_3707(&su, q, fixture.hosted_agent).await,
        None,
        "adding someone else does not seat the agent, and does not widen its approved set"
    );

    // ---- invisible channels are all the same refusal ----------------------
    let other_ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(other_ws)
        .bind(format!("other-{}", other_ws.simple()))
        .execute(&su)
        .await
        .unwrap();
    let foreign_name = format!("foreign-{}", &other_ws.simple().to_string()[..8]);
    let foreign_owner = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human','F','foreign-owner')",
    )
    .bind(foreign_owner)
    .bind(other_ws)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO channel(workspace_id, kind, name, created_by) VALUES($1,'public',$2,$3)",
    )
    .bind(other_ws)
    .bind(&foreign_name)
    .bind(foreign_owner)
    .execute(&su)
    .await
    .unwrap();
    let archived = {
        let (id, name) = seed_channel_3707(&su, &fixture, "public", &[]).await;
        sqlx::query("UPDATE channel SET archived_at = now() WHERE id=$1")
            .bind(id)
            .execute(&su)
            .await
            .unwrap();
        name
    };
    let approvals_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM approval WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap();
    let mut answers = Vec::new();
    for channel in [r_name, "no-such-room".to_string(), foreign_name, archived] {
        let (status, refused) = try_propose_action_3706(
            &client,
            &base,
            &su,
            &fixture,
            "channel.member.add",
            json!({"channel": channel, "memberHandles": [x1_handle]}),
        )
        .await;
        answers.push((status, refused["error"].clone()));
    }
    assert!(
        answers
            .iter()
            .all(|answer| answer.0 == 400 && answer.1 == answers[0].1),
        "an unseen channel must look exactly like a missing one: {answers:?}"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM approval WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap(),
        approvals_before
    );

    // ---- stale: the agent leaves the private room before the tap ----------
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "channel.member.add",
        json!({"channel": p_name, "memberHandles": [x2_handle]}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let approval_stale = proposed_approval_3706(&proposed);
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id=$1 AND member_id=$2")
        .bind(p)
        .bind(fixture.hosted_agent)
        .execute(&su)
        .await
        .unwrap();
    let (status, _h, stale) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval_stale,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{stale}");
    assert_eq!(stale["status"], "action_args_invalid");
    assert_eq!(membership_role_3707(&su, p, x2).await, None);
    let state: String = sqlx::query_scalar("SELECT status::text FROM approval WHERE id=$1")
        .bind(approval_stale)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(state, "pending");
}

/// **What the approver read is what runs (증보 V1-d, pins).**
///
/// A handle can be changed and a channel can be renamed after the card is drawn,
/// so "the same name resolves again" is not enough: the ids the names resolved to
/// are pinned in the payload and a different id at the tap is `action_args_invalid`
/// with nothing written. Also: an agent target is marked on the card, a proposal
/// with nobody new to add is refused, and unseen channels (DM, left room,
/// archived twin) look exactly like a missing one without writing a card or an
/// audit row.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_member_add_card_is_pinned_to_the_ids_it_was_drawn_from() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (x2, x2_handle) = seed_extra_member_3706(&su, &fixture, "pin").await;
    let (x3, _x3_handle) = seed_extra_member_3706(&su, &fixture, "swap").await;
    let (p, p_name) = seed_channel_3707(
        &su,
        &fixture,
        "private",
        &[(fixture.hosted_agent, "member")],
    )
    .await;

    // ---- a handle moved to somebody else after the card was drawn ----------
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "channel.member.add",
        json!({"channel": p_name, "memberHandles": [x2_handle]}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let approval = proposed_approval_3706(&proposed);
    sqlx::query("UPDATE member SET handle=$2 WHERE id=$1")
        .bind(x2)
        .bind(format!("moved-{}", &x2.simple().to_string()[..8]))
        .execute(&su)
        .await
        .unwrap();
    sqlx::query("UPDATE member SET handle=$2 WHERE id=$1")
        .bind(x3)
        .bind(&x2_handle)
        .execute(&su)
        .await
        .unwrap();
    let (status, _h, stale) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{stale}");
    assert_eq!(stale["status"], "action_args_invalid");
    assert_eq!(
        membership_role_3707(&su, p, x3).await,
        None,
        "the swapped-in member"
    );
    assert_eq!(membership_role_3707(&su, p, x2).await, None);

    // ---- a channel renamed away and its name reused ------------------------
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "channel.member.add",
        json!({"channel": p_name, "memberHandles": [x2_handle]}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let approval = proposed_approval_3706(&proposed);
    let (decoy, _) = seed_channel_3707(
        &su,
        &fixture,
        "private",
        &[(fixture.hosted_agent, "member")],
    )
    .await;
    sqlx::query("UPDATE channel SET name=$2 WHERE id=$1")
        .bind(p)
        .bind(format!("renamed-{}", &p.simple().to_string()[..8]))
        .execute(&su)
        .await
        .unwrap();
    sqlx::query("UPDATE channel SET name=$2 WHERE id=$1")
        .bind(decoy)
        .bind(&p_name)
        .execute(&su)
        .await
        .unwrap();
    let (status, _h, stale) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{stale}");
    assert_eq!(stale["status"], "action_args_invalid");
    assert_eq!(membership_role_3707(&su, decoy, x3).await, None);

    // ---- an agent as the member to add is marked on the card ---------------
    let agent_handle = format!("bot-{}", &Uuid::new_v4().simple().to_string()[..8]);
    sqlx::query("UPDATE member SET handle=$2 WHERE id=$1")
        .bind(fixture.managed_agent)
        .bind(&agent_handle)
        .execute(&su)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member') \
         ON CONFLICT DO NOTHING",
    )
    .bind(fixture.workspace)
    .bind(fixture.managed_agent)
    .execute(&su)
    .await
    .unwrap();
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "channel.member.add",
        json!({"channel": p_name, "memberHandles": [agent_handle]}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let card: Value = sqlx::query_scalar("SELECT props FROM message WHERE id=$1")
        .bind(Uuid::parse_str(structured(&proposed)["cardMessageId"].as_str().unwrap()).unwrap())
        .fetch_one(&su)
        .await
        .unwrap();
    let shown = card["action"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["label"] == "추가할 멤버")
        .unwrap()["value"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        shown.contains("에이전트") && shown.contains(&agent_handle),
        "{shown}"
    );

    // ---- unseen channels write nothing and look like a missing one ---------
    let dm = Uuid::new_v4();
    let dm_name = format!("dm-{}", &dm.simple().to_string()[..10]);
    sqlx::query(
        "INSERT INTO channel(id, workspace_id, kind, name, dm_key, created_by) \
         VALUES($1,$2,'dm',$3,$4,$5)",
    )
    .bind(dm)
    .bind(fixture.workspace)
    .bind(&dm_name)
    .bind(format!("{dm}"))
    .bind(fixture.human)
    .execute(&su)
    .await
    .expect("seed dm");
    sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
        .bind(fixture.workspace)
        .bind(dm)
        .bind(fixture.hosted_agent)
        .execute(&su)
        .await
        .unwrap();
    let (left_room, left_name) = seed_channel_3707(
        &su,
        &fixture,
        "private",
        &[(fixture.hosted_agent, "member")],
    )
    .await;
    sqlx::query("UPDATE membership SET left_at=now() WHERE channel_id=$1 AND member_id=$2")
        .bind(left_room)
        .bind(fixture.hosted_agent)
        .execute(&su)
        .await
        .unwrap();
    let twin = format!("twin-{}", &Uuid::new_v4().simple().to_string()[..8]);
    for archived in [true, false] {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO channel(id, workspace_id, kind, name, created_by, archived_at) \
             VALUES($1,$2,'private',$3,$4, CASE WHEN $5 THEN now() END)",
        )
        .bind(id)
        .bind(fixture.workspace)
        .bind(&twin)
        .bind(fixture.human)
        .bind(archived)
        .execute(&su)
        .await
        .unwrap();
        if !archived {
            // The live twin is private and the agent is not in it.
            continue;
        }
    }
    let count_state = |su: PgPool, ws: Uuid| async move {
        let rows: (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM approval WHERE workspace_id=$1), \
                    (SELECT count(*) FROM message WHERE workspace_id=$1 AND type::text='approval_request'), \
                    (SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND action IN \
                       ('action.approved','channel.member_added','channel.created',\
                        'hosted_connection.channels_granted'))",
        )
        .bind(ws)
        .fetch_one(&su)
        .await
        .unwrap();
        rows
    };
    let before = count_state(su.clone(), fixture.workspace).await;
    let mut answers = Vec::new();
    for channel in [dm_name, left_name, twin, "no-such-room-at-all".to_string()] {
        let (status, refused) = try_propose_action_3706(
            &client,
            &base,
            &su,
            &fixture,
            "channel.member.add",
            json!({"channel": channel, "memberHandles": [x2_handle]}),
        )
        .await;
        answers.push((status, refused["error"].clone()));
    }
    assert!(
        answers.iter().all(|a| a.0 == 400 && a.1 == answers[0].1),
        "{answers:?}"
    );
    assert_eq!(count_state(su.clone(), fixture.workspace).await, before);

    // ---- nobody new to add is not a proposal -------------------------------
    sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
        .bind(fixture.workspace)
        .bind(decoy)
        .bind(x3)
        .execute(&su)
        .await
        .unwrap();
    let x3_handle: String = sqlx::query_scalar("SELECT handle FROM member WHERE id=$1")
        .bind(x3)
        .fetch_one(&su)
        .await
        .unwrap();
    let (status, refused) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "channel.member.add",
        json!({"channel": p_name, "memberHandles": [x3_handle]}),
    )
    .await;
    assert_eq!(status, 400, "{refused}");
}

// ---------------------------------------------------------------------------
// ADR-0186 증보 2026-10-11 S3 (#3708) — agent.rename + PATCH …/agents/{agent}
// ---------------------------------------------------------------------------

/// A human with a session token, a workspace role and a seat in the fixture's
/// approved channel (so it can decide approvals raised there).
async fn seed_human_3708(
    pool: &PgPool,
    fixture: &Fixture,
    tag: &str,
    role: &str,
) -> (Uuid, String) {
    let member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human',$3,$4)",
    )
    .bind(member)
    .bind(fixture.workspace)
    .bind(format!("Person {tag}"))
    .bind(format!("{tag}-{}", &member.simple().to_string()[..8]))
    .execute(pool)
    .await
    .expect("seed person");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(member)
    .bind(fixture.workspace)
    .bind(format!("{member}@tools.test"))
    .execute(pool)
    .await
    .expect("seed person identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) \
         VALUES($1,$2,$3::membership_role)",
    )
    .bind(fixture.workspace)
    .bind(member)
    .bind(role)
    .execute(pool)
    .await
    .expect("seed person role");
    sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
        .bind(fixture.workspace)
        .bind(fixture.channel)
        .bind(member)
        .execute(pool)
        .await
        .expect("seed person seat");
    let jwt = momo_auth::sign_access(member, fixture.workspace, &[], TEST_JWT_SECRET)
        .expect("sign person JWT")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'tools-conformance')",
    )
    .bind(fixture.workspace)
    .bind(member)
    .bind(&jwt)
    .execute(pool)
    .await
    .expect("record person token");
    (member, jwt)
}

async fn set_agent_owner_3708(pool: &PgPool, agent: Uuid, owner: Option<Uuid>) {
    sqlx::query("UPDATE agent SET owner_human_id=$2 WHERE member_id=$1")
        .bind(agent)
        .bind(owner)
        .execute(pool)
        .await
        .expect("set owner");
}

/// Give an agent a legal short handle and display name (the fixture's are the
/// long generated ones) and return the handle.
async fn tidy_agent_3708(pool: &PgPool, agent: Uuid, display: &str) -> String {
    let handle = format!("bot-{}", &agent.simple().to_string()[..8]);
    sqlx::query("UPDATE member SET handle=$2, display_name=$3 WHERE id=$1")
        .bind(agent)
        .bind(&handle)
        .bind(display)
        .execute(pool)
        .await
        .expect("tidy agent");
    handle
}

async fn display_name_3708(pool: &PgPool, member: Uuid) -> String {
    sqlx::query_scalar("SELECT display_name FROM member WHERE id=$1")
        .bind(member)
        .fetch_one(pool)
        .await
        .expect("display name")
}

async fn approval_status_3708(pool: &PgPool, approval: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM approval WHERE id=$1")
        .bind(approval)
        .fetch_one(pool)
        .await
        .expect("approval status")
}

/// **agent.rename for oneself (증보 V4).** The approver is the agent's *owner*
/// (not an admin) and the approval executes; a third party who is neither the
/// owner nor an admin is `role_required`; the strict guard refuses every hostile
/// spelling; handle and every other member's name stay put; the broadcast and
/// audit rows are written; the name collision rule covers display names AND
/// handles under disguise.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_agent_renames_itself_after_its_owner_approves() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (owner, owner_jwt) = seed_human_3708(&su, &fixture, "owner", "member").await;
    let (_third, third_jwt) = seed_human_3708(&su, &fixture, "third", "member").await;
    set_agent_owner_3708(&su, fixture.hosted_agent, Some(owner)).await;
    let _agent_handle = tidy_agent_3708(&su, fixture.hosted_agent, "Hermes").await;
    let before_other = display_name_3708(&su, fixture.managed_agent).await;
    let handle_before: String = sqlx::query_scalar("SELECT handle FROM member WHERE id=$1")
        .bind(fixture.hosted_agent)
        .fetch_one(&su)
        .await
        .unwrap();

    // ---- the hostile spellings, all one refusal ----------------------------
    let human_name = display_name_3708(&su, fixture.human).await;
    let mut answers = Vec::new();
    for hostile in [
        "[보안 재인증](https://evil.example)".to_string(),
        "@Person owner".to_string(),
        "<@Person owner>".to_string(),
        "Zero\u{200B}Width".to_string(),
        "admin".to_string(),
        "oort".to_string(),
        "x".repeat(40),
        // Someone else's name, handle, case, width and look-alike variants.
        human_name.to_lowercase(),
        human_name.to_uppercase(),
        "Ｐｅｒｓｏｎ ｏｗｎｅｒ".to_string(),
        "Pеrson owner".to_string(), // Cyrillic е
        before_other.clone(),
        before_other.to_uppercase(),
        // Reserved words anywhere, ASCII look-alikes, and a whole-word prefix of
        // another member's name (`@Tools Human` would also mention "Tools").
        "Admin 2".to_string(),
        "Adm1n".to_string(),
        "Oort Support".to_string(),
        "Tools".to_string(),
        "Tools Human Bot".to_string(),
        "T00ls Human".to_string(),
    ] {
        let (status, refused) = try_propose_action_3706(
            &client,
            &base,
            &su,
            &fixture,
            "agent.rename",
            json!({"displayName": hostile}),
        )
        .await;
        answers.push((status, refused["error"].clone()));
        assert_eq!(status, 400, "{hostile:?} must be refused: {refused}");
    }
    assert!(answers.iter().all(|a| a.1 == answers[0].1), "{answers:?}");
    assert_eq!(display_name_3708(&su, fixture.hosted_agent).await, "Hermes");

    // ---- a good proposal ---------------------------------------------------
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "agent.rename",
        json!({"displayName": "Navigator 🧭"}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let approval = proposed_approval_3706(&proposed);
    let card: Value = sqlx::query_scalar("SELECT props FROM message WHERE id=$1")
        .bind(Uuid::parse_str(structured(&proposed)["cardMessageId"].as_str().unwrap()).unwrap())
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(card["action"]["required_role"], json!("agent_editor"));
    let rows = card["action"]["rows"].as_array().unwrap().clone();
    let row = |label: &str| {
        rows.iter().find(|r| r["label"] == label).unwrap()["value"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert!(row("대상 에이전트").contains("Hermes") && row("대상 에이전트").contains("에이전트"));
    assert_eq!(row("이름 변경"), "Hermes → Navigator 🧭");
    assert!(
        !card["summary"].as_str().unwrap().contains("다른 에이전트"),
        "a self-rename does not claim to rename another agent"
    );

    // ---- a third party who is neither the owner nor an admin ---------------
    let (status, _h, refused) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &third_jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 403, "{refused}");
    assert_eq!(refused["status"], "role_required");
    assert_eq!(display_name_3708(&su, fixture.hosted_agent).await, "Hermes");
    assert_eq!(approval_status_3708(&su, approval).await, "pending");

    // ---- the agent cannot approve its own rename ---------------------------
    let agent_try = client
        .post(format!(
            "{base}/v1/workspaces/{}/approvals/{approval}/decision",
            fixture.workspace
        ))
        .bearer_auth(&fixture.hosted_bearer)
        .json(&json!({"approvalId": approval, "approve": true,
                      "clientDecisionId": Uuid::new_v4()}))
        .send()
        .await
        .expect("agent decision responds");
    assert!(matches!(agent_try.status().as_u16(), 401 | 403));
    assert_eq!(display_name_3708(&su, fixture.hosted_agent).await, "Hermes");

    // ---- the OWNER (not an admin) approves ---------------------------------
    let (status, _h, approved) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &owner_jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{approved}");
    assert_eq!(approved["result"]["actionId"], json!("agent.rename"));
    assert_eq!(
        approved["result"]["ref"],
        json!({"type": "agent", "id": fixture.hosted_agent.to_string()})
    );
    assert!(approved["result"].get("secretOnce").is_none());
    assert_eq!(
        display_name_3708(&su, fixture.hosted_agent).await,
        "Navigator 🧭"
    );
    let handle_after: String = sqlx::query_scalar("SELECT handle FROM member WHERE id=$1")
        .bind(fixture.hosted_agent)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(handle_after, handle_before, "the handle is never renamed");
    assert_eq!(
        display_name_3708(&su, fixture.managed_agent).await,
        before_other
    );

    let detail: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id=$1 AND action='member.renamed'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(detail["old"], json!("Hermes"));
    assert_eq!(detail["new"], json!("Navigator 🧭"));
    assert_eq!(detail["kind"], json!("agent"));
    assert_eq!(detail["managed"], json!(false));
    assert_eq!(detail["via_agent"], json!(fixture.hosted_agent.to_string()));
    assert_eq!(detail["approval_id"], json!(approval.to_string()));
    assert_eq!(
        audit_count_3706(&su, fixture.workspace, "action.approved").await,
        1
    );

    let broadcasts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 \
           AND payload->'data'->>'type' = 'member.renamed' \
           AND payload->'data'->'payload'->>'member_id' = upper($2)",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent.to_string())
    .fetch_one(&su)
    .await
    .unwrap();
    let channels: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM membership WHERE member_id=$1 AND left_at IS NULL",
    )
    .bind(fixture.hosted_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        broadcasts, channels,
        "one roster broadcast per channel the agent is in"
    );
    assert!(broadcasts > 0);

    // ---- the same name again is a no-op, not an error (own current name) ---
    let (status, again) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "agent.rename",
        json!({"displayName": "navigator 🧭"}),
    )
    .await;
    assert_eq!(
        status, 200,
        "an agent may propose its own current name: {again}"
    );
}

/// **Managing another agent (증보 V4-M).** Only an active agent with the same,
/// non-NULL, active human owner is a target; everything else is one refusal. The
/// approver is judged against the TARGET: a person who owns only the proposer is
/// `role_required`. A target whose owner changed after the card was drawn is
/// stale. A second pending rename of the same target is a conflict, and
/// concurrent renames are serialised by the workspace display-name lock.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_agent_can_rename_only_agents_with_the_same_owner() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();
    let (owner, owner_jwt) = seed_human_3708(&su, &fixture, "owner", "member").await;
    let (other, other_jwt) = seed_human_3708(&su, &fixture, "other", "member").await;
    let _a = tidy_agent_3708(&su, fixture.hosted_agent, "Alpha").await;
    let b_handle = tidy_agent_3708(&su, fixture.managed_agent, "Beta").await;
    let c_handle = tidy_agent_3708(&su, fixture.connect_only_agent, "Gamma").await;
    set_agent_owner_3708(&su, fixture.hosted_agent, Some(owner)).await;
    set_agent_owner_3708(&su, fixture.managed_agent, Some(owner)).await;
    set_agent_owner_3708(&su, fixture.connect_only_agent, Some(other)).await;
    let human_handle: String = sqlx::query_scalar("SELECT handle FROM member WHERE id=$1")
        .bind(fixture.human)
        .fetch_one(&su)
        .await
        .unwrap();

    // ---- targets that are not managed all look the same --------------------
    let mut answers = Vec::new();
    for target in [
        c_handle.clone(),     // another owner
        human_handle.clone(), // a human
        "no-such-handle".to_string(),
        "Not A Handle".to_string(),
    ] {
        let (status, refused) = try_propose_action_3706(
            &client,
            &base,
            &su,
            &fixture,
            "agent.rename",
            json!({"displayName": "Renamed", "targetHandle": target}),
        )
        .await;
        assert_eq!(status, 400, "{target}: {refused}");
        answers.push(refused["error"].clone());
    }
    // An ownerless target is not managed either.
    set_agent_owner_3708(&su, fixture.managed_agent, None).await;
    let (status, refused) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "agent.rename",
        json!({"displayName": "Renamed", "targetHandle": b_handle}),
    )
    .await;
    assert_eq!(status, 400, "{refused}");
    answers.push(refused["error"].clone());
    set_agent_owner_3708(&su, fixture.managed_agent, Some(owner)).await;
    // The proposer cannot take its own name onto the target.
    let (status, refused) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "agent.rename",
        json!({"displayName": "alpha", "targetHandle": b_handle}),
    )
    .await;
    assert_eq!(status, 400, "{refused}");
    answers.push(refused["error"].clone());
    assert!(answers.iter().all(|a| *a == answers[0]), "{answers:?}");

    // ---- a managed target ---------------------------------------------------
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "agent.rename",
        json!({"displayName": "Beta Prime", "targetHandle": b_handle}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let approval = proposed_approval_3706(&proposed);
    let card: Value = sqlx::query_scalar("SELECT props FROM message WHERE id=$1")
        .bind(Uuid::parse_str(structured(&proposed)["cardMessageId"].as_str().unwrap()).unwrap())
        .fetch_one(&su)
        .await
        .unwrap();
    assert!(
        card["summary"].as_str().unwrap().contains("다른 에이전트"),
        "the card says it renames ANOTHER agent: {card}"
    );
    let rows = card["action"]["rows"].as_array().unwrap();
    assert!(rows
        .iter()
        .any(|r| r["label"] == "이름 변경" && r["value"] == "Beta → Beta Prime"));

    // A second pending rename of the same target is a conflict.
    let (status, dup) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "agent.rename",
        json!({"displayName": "Beta Again", "targetHandle": b_handle}),
    )
    .await;
    assert_eq!(status, 409, "{dup}");

    // The owner of the PROPOSER only is not an approver once the target moved:
    // the target changes hands, `other` (neither owner nor admin) tries, then
    // the real new owner is judged against the target and the card is stale.
    set_agent_owner_3708(&su, fixture.managed_agent, Some(other)).await;
    let (status, _h, refused) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &owner_jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 403, "owns the proposer, not the target: {refused}");
    assert_eq!(refused["status"], "role_required");
    assert_eq!(display_name_3708(&su, fixture.managed_agent).await, "Beta");
    // The target's new owner is eligible, but the relationship the card was
    // drawn from no longer holds: stale, nothing spent.
    let (status, _h, stale) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &other_jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    // A non-admin is told only `role_required` while the card is unresolvable.
    assert_eq!(status, 403, "{stale}");
    assert_eq!(stale["status"], "role_required");
    // An admin sees the truth: the proposal is stale.
    let (status, _h, stale) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{stale}");
    assert_eq!(stale["status"], "action_args_invalid");
    assert_eq!(approval_status_3708(&su, approval).await, "pending");
    assert_eq!(display_name_3708(&su, fixture.managed_agent).await, "Beta");

    // ---- restore the relationship: the target's owner approves -------------
    set_agent_owner_3708(&su, fixture.managed_agent, Some(owner)).await;
    let (status, _h, approved) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &owner_jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{approved}");
    assert_eq!(
        display_name_3708(&su, fixture.managed_agent).await,
        "Beta Prime"
    );
    assert_eq!(display_name_3708(&su, fixture.hosted_agent).await, "Alpha");
    let detail: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id=$1 AND action='member.renamed'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(detail["managed"], json!(true));
    assert_eq!(
        detail["target_agent"],
        json!(fixture.managed_agent.to_string())
    );
    assert_eq!(detail["owner_member_id"], json!(owner.to_string()));
    assert_eq!(detail["via_agent"], json!(fixture.hosted_agent.to_string()));
}

/// The workspace display-name lock is real: while another transaction holds it,
/// an approved rename waits instead of racing the collision check.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn renames_are_serialised_by_the_workspace_display_name_lock() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let _a = tidy_agent_3708(&su, fixture.hosted_agent, "Alpha").await;
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "agent.rename",
        json!({"displayName": "Zeta"}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let approval = proposed_approval_3706(&proposed);

    let mut holder = su.begin().await.expect("holder transaction");
    momo_messaging::lock_display_name_namespace_in_tx(&mut holder, fixture.workspace)
        .await
        .expect("take the namespace lock");
    let (base2, jwt, workspace) = (base.clone(), fixture.human_jwt.clone(), fixture.workspace);
    let mut decision = tokio::spawn(async move {
        let client = reqwest::Client::new();
        decide_as(
            &client,
            &base2,
            workspace,
            &jwt,
            approval,
            true,
            Uuid::new_v4(),
        )
        .await
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(900), &mut decision)
            .await
            .is_err(),
        "the rename ran while another transaction held the display-name lock"
    );
    assert_eq!(display_name_3708(&su, fixture.hosted_agent).await, "Alpha");
    holder.commit().await.expect("release the lock");
    let (status, _h, body) = decision.await.expect("decision task");
    assert_eq!(status, 200, "{body}");
    assert_eq!(display_name_3708(&su, fixture.hosted_agent).await, "Zeta");
}

/// **The human route (증보 V4).** Owner or admin only; the person's own choice
/// follows the join rule (parentheses allowed) but may not collide with another
/// member's name or handle; an agent bearer cannot use it; only agents can be
/// renamed through it.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_human_rename_route_is_for_the_owner_or_an_admin_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (owner, owner_jwt) = seed_human_3708(&su, &fixture, "owner", "member").await;
    let (_third, third_jwt) = seed_human_3708(&su, &fixture, "third", "member").await;
    set_agent_owner_3708(&su, fixture.hosted_agent, Some(owner)).await;
    let _ = tidy_agent_3708(&su, fixture.hosted_agent, "Hermes").await;
    let other_name = tidy_agent_3708(&su, fixture.managed_agent, "Managed One").await;
    let url = format!(
        "{base}/v1/workspaces/{}/agents/{}",
        fixture.workspace, fixture.hosted_agent
    );
    let patch = |jwt: &str, body: Value| client.patch(&url).bearer_auth(jwt).json(&body).send();

    // A third party: 403. An agent bearer: refused. Nothing changed.
    let response = patch(&third_jwt, json!({"displayName": "Hijack"}))
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 403);
    let response = patch(&fixture.hosted_bearer, json!({"displayName": "Self"}))
        .await
        .unwrap();
    assert!(
        matches!(response.status().as_u16(), 401 | 403),
        "{}",
        response.status()
    );
    assert_eq!(display_name_3708(&su, fixture.hosted_agent).await, "Hermes");

    // A collision (another member's handle, name, disguise) is 409.
    for taken in [
        other_name.clone(),
        "managed one".to_string(),
        "ＭＡＮＡＧＥＤ ＯＮＥ".to_string(),
        "Mаnaged One".to_string(), // Cyrillic а
    ] {
        let response = patch(&owner_jwt, json!({"displayName": taken}))
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 409, "{taken}");
    }
    // Invisible, reordering and line-breaking characters are refused even though
    // a person chose them.
    for hidden in ["Zero\u{200B}Width", "Flip\u{202E}ped", "two\nlines", "ㅤ"] {
        let response = patch(&owner_jwt, json!({"displayName": hidden}))
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 400, "{hidden:?}");
    }
    // A non-admin cannot tell a human id or an unknown id from a real agent:
    // 403 for all three (the 404 is only for someone allowed to know).
    for target in [Uuid::new_v4(), fixture.human, fixture.managed_agent] {
        let response = client
            .patch(format!(
                "{base}/v1/workspaces/{}/agents/{target}",
                fixture.workspace
            ))
            .bearer_auth(&third_jwt)
            .json(&json!({"displayName": "Nope"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 403, "{target}");
    }
    // Empty and unknown keys are 400/422, a human id is 404 for an admin.
    let response = patch(&owner_jwt, json!({"displayName": "   "}))
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 400);
    let response = patch(
        &owner_jwt,
        json!({"displayName": "Ok", "handle": "newhandle"}),
    )
    .await
    .unwrap();
    assert!(matches!(response.status().as_u16(), 400 | 422));
    let human_url = format!(
        "{base}/v1/workspaces/{}/agents/{}",
        fixture.workspace, fixture.human
    );
    let response = client
        .patch(&human_url)
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({"displayName": "Not An Agent"}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status().as_u16(),
        404,
        "a human is not renamable here"
    );
    assert_eq!(display_name_3708(&su, fixture.hosted_agent).await, "Hermes");

    // The owner (not an admin) renames it — the person's choice, parentheses and all.
    let response = patch(&owner_jwt, json!({"displayName": "  김 인턴 (비서)  "}))
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["member"]["displayName"], json!("김 인턴 (비서)"));
    assert_eq!(body["member"]["kind"], json!("agent"));
    assert_eq!(
        display_name_3708(&su, fixture.hosted_agent).await,
        "김 인턴 (비서)"
    );
    // An admin may too; renaming to its own current name is allowed.
    let response = client
        .patch(&url)
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({"displayName": "김 인턴 (비서)"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);

    let detail: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id=$1 AND action='member.renamed' \
          ORDER BY created_at LIMIT 1",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(detail["kind"], json!("agent"));
    assert_eq!(detail["new"], json!("김 인턴 (비서)"));
}

// ---------------------------------------------------------------------------
// ADR-0186 증보 2026-10-11 S4 (#3709) — hosted.channels.grant
// ---------------------------------------------------------------------------

async fn approved_of_3709(pool: &PgPool, agent: Uuid) -> Vec<Uuid> {
    sqlx::query_scalar(
        "SELECT approved_channel_ids FROM hosted_agent_connection WHERE agent_member_id=$1",
    )
    .bind(agent)
    .fetch_one(pool)
    .await
    .expect("approved channels")
}

/// **hosted.channels.grant (증보 V5, V11).**
///
/// The only way an agent asks for more reach, and the narrowest one: its OWN
/// connection, channels it can already see (public, or private with it inside),
/// admin approval, a 50-channel ceiling, one indistinguishable refusal for
/// everything else. The confirm columns and every other agent's connection are
/// untouched; the grant also seats the agent, so it can actually post.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_channel_grant_widens_only_the_proposers_own_connection() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let plain_jwt = seed_plain_member(&su, &fixture).await;

    // Q: public, the agent is not in it. R: private, the agent IS in it.
    // S: private, the agent is not in it. D: a DM the agent is in.
    let (q, q_name) = seed_channel_3707(&su, &fixture, "public", &[]).await;
    let (r, r_name) = seed_channel_3707(
        &su,
        &fixture,
        "private",
        &[(fixture.hosted_agent, "member")],
    )
    .await;
    let (_s, s_name) = seed_channel_3707(&su, &fixture, "private", &[]).await;
    let dm = Uuid::new_v4();
    let dm_name = format!("dm-{}", &dm.simple().to_string()[..10]);
    sqlx::query(
        "INSERT INTO channel(id, workspace_id, kind, name, dm_key, created_by) \
         VALUES($1,$2,'dm',$3,$4,$5)",
    )
    .bind(dm)
    .bind(fixture.workspace)
    .bind(&dm_name)
    .bind(dm.to_string())
    .bind(fixture.human)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
        .bind(fixture.workspace)
        .bind(dm)
        .bind(fixture.hosted_agent)
        .execute(&su)
        .await
        .unwrap();

    let own_before = approved_of_3709(&su, fixture.hosted_agent).await;
    let other_before = approved_of_3709(&su, fixture.connect_only_agent).await;
    let confirm_before = hosted_confirm_columns_3706(&su, &fixture).await;

    // ---- unseen / ineligible channels: one refusal, nothing written --------
    let approvals_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM approval WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap();
    let mut answers = Vec::new();
    for channels in [
        json!([s_name]),
        json!([dm_name]),
        json!(["no-such-room"]),
        json!([q_name, s_name]), // one bad name poisons the whole call
        json!([fixture_channel_name(&su, fixture.channel).await]), // already approved
    ] {
        let (status, refused) = try_propose_action_3706(
            &client,
            &base,
            &su,
            &fixture,
            "hosted.channels.grant",
            json!({"channels": channels}),
        )
        .await;
        answers.push((status, refused["error"].clone()));
    }
    assert!(
        answers.iter().all(|a| a.0 == 400 && a.1 == answers[0].1),
        "{answers:?}"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM approval WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap(),
        approvals_before
    );
    // No key can point at another agent's connection.
    let (status, refused) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "hosted.channels.grant",
        json!({"channels": [q_name], "connectionId": Uuid::new_v4()}),
    )
    .await;
    assert_eq!(status, 400, "{refused}");

    // ---- a good proposal: Q (public) and R (private, member) ----------------
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "hosted.channels.grant",
        json!({"channels": [format!("#{q_name}"), r_name]}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let approval = proposed_approval_3706(&proposed);
    let card: Value = sqlx::query_scalar("SELECT props FROM message WHERE id=$1")
        .bind(Uuid::parse_str(structured(&proposed)["cardMessageId"].as_str().unwrap()).unwrap())
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(card["action"]["required_role"], json!("admin"));
    let rows = card["action"]["rows"].as_array().unwrap().clone();
    assert!(rows.iter().any(|r| r["label"] == "채널"
        && r["value"]
            .as_str()
            .unwrap()
            .starts_with(&format!("#{q_name} · 공개 · "))));
    assert!(rows.iter().any(|r| r["label"] == "채널"
        && r["value"]
            .as_str()
            .unwrap()
            .starts_with(&format!("#{r_name} · 비공개 · "))));
    assert!(rows.iter().any(|r| r["label"] == "승인 채널 수"
        && r["value"] == format!("{}개 → {}개", own_before.len(), own_before.len() + 2)));
    assert_eq!(
        approved_of_3709(&su, fixture.hosted_agent).await,
        own_before
    );

    // ---- a non-admin cannot widen the agent's reach ------------------------
    let (status, _h, refused) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &plain_jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 403, "{refused}");
    assert_eq!(refused["status"], "role_required");
    assert_eq!(
        approved_of_3709(&su, fixture.hosted_agent).await,
        own_before
    );
    assert_eq!(
        membership_role_3707(&su, q, fixture.hosted_agent).await,
        None
    );

    // ---- the admin approves ------------------------------------------------
    let (status, _h, approved) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{approved}");
    assert_eq!(
        approved["result"]["actionId"],
        json!("hosted.channels.grant")
    );
    assert_eq!(
        approved["result"]["ref"],
        json!({"type": "hosted_connection", "id": fixture.hosted_connection.to_string()})
    );
    assert!(approved["result"].get("secretOnce").is_none());
    let own_after = approved_of_3709(&su, fixture.hosted_agent).await;
    assert_eq!(own_after.len(), own_before.len() + 2);
    assert!(own_after.contains(&q) && own_after.contains(&r));
    assert_eq!(
        membership_role_3707(&su, q, fixture.hosted_agent)
            .await
            .as_deref(),
        Some("member"),
        "the grant seats the agent: approved AND a member"
    );
    assert_eq!(
        membership_role_3707(&su, r, fixture.hosted_agent)
            .await
            .as_deref(),
        Some("member")
    );
    // The confirm columns and the DM approvals never move; nor does any other
    // agent's connection.
    assert_eq!(
        hosted_confirm_columns_3706(&su, &fixture).await,
        confirm_before
    );
    assert_eq!(
        approved_of_3709(&su, fixture.connect_only_agent).await,
        other_before
    );
    let covered: Vec<Uuid> =
        sqlx::query_scalar("SELECT unnest(hosted_connection_channel_ids($1,$2))")
            .bind(fixture.workspace)
            .bind(fixture.hosted_connection)
            .fetch_all(&su)
            .await
            .unwrap();
    assert!(covered.contains(&q) && covered.contains(&r));

    let detail: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id=$1 \
           AND action='hosted_connection.channels_granted'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        detail["connection_id"],
        json!(fixture.hosted_connection.to_string())
    );
    assert_eq!(detail["via_agent"], json!(fixture.hosted_agent.to_string()));
    let mut granted: Vec<String> = detail["channel_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    granted.sort();
    let mut expected = vec![q.to_string(), r.to_string()];
    expected.sort();
    assert_eq!(granted, expected);

    // The agent reads the ids from its outcome line and can post in Q.
    let (status, posted) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_message_post",
        json!({"channelId": q, "clientMsgId": Uuid::new_v4(), "body": "안녕하세요"}),
    )
    .await;
    assert_eq!(status, 200, "{posted}");
    let line: String = sqlx::query_scalar(
        "SELECT body FROM message WHERE workspace_id=$1 AND channel_id=$2 \
           AND props ? 'momo.action_result' ORDER BY seq DESC LIMIT 1",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(
        line.contains(&q.to_string()) && line.contains(&r.to_string()),
        "{line}"
    );
}

async fn fixture_channel_name(pool: &PgPool, channel: Uuid) -> String {
    sqlx::query_scalar("SELECT name FROM channel WHERE id=$1")
        .bind(channel)
        .fetch_one(pool)
        .await
        .expect("channel name")
}

/// The 50-channel ceiling holds at proposal time AND at the tap, and a refused
/// grant writes neither the array nor the membership.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_channel_grant_cannot_pass_fifty_approved_channels() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (c1, n1) = seed_channel_3707(&su, &fixture, "public", &[]).await;
    let (_c2, n2) = seed_channel_3707(&su, &fixture, "public", &[]).await;
    let (c3, n3) = seed_channel_3707(&su, &fixture, "public", &[]).await;
    let set_to = |count: usize| {
        let su = su.clone();
        let connection = fixture.hosted_connection;
        let base_channel = fixture.channel;
        async move {
            sqlx::query(
                // The channel the agent is mentioned in stays approved (or no job
                // would reach it); the rest are filler ids up to `count`.
                "UPDATE hosted_agent_connection SET approved_channel_ids = \
                   ARRAY[$3::uuid] || ARRAY(SELECT gen_random_uuid() \
                                              FROM generate_series(1,$2::int - 1)) \
                 WHERE id=$1",
            )
            .bind(connection)
            .bind(count as i32)
            .bind(base_channel)
            .execute(&su)
            .await
            .unwrap();
        }
    };

    // 49 + 2 > 50: refused when proposed.
    set_to(49).await;
    let (status, refused) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "hosted.channels.grant",
        json!({"channels": [n1.clone(), n2]}),
    )
    .await;
    assert_eq!(status, 400, "{refused}");
    // 49 + 1 = 50: allowed.
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "hosted.channels.grant",
        json!({"channels": [n1]}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    // …but the set grew to 50 before the tap: stale, nothing written.
    set_to(50).await;
    let (status, _h, capped) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        proposed_approval_3706(&proposed),
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{capped}");
    assert_eq!(capped["status"], "action_args_invalid");
    assert_eq!(approved_of_3709(&su, fixture.hosted_agent).await.len(), 50);
    assert_eq!(
        membership_role_3707(&su, c1, fixture.hosted_agent).await,
        None
    );

    // The same at the database function itself: the 51st is refused and the
    // membership is not written (the array is checked first).
    let mut tx = su.begin().await.unwrap();
    let outcome = momo_auth::grant_hosted_channels_in_tx(
        &mut tx,
        fixture.workspace,
        fixture.hosted_connection,
        fixture.hosted_agent,
        &[c3],
    )
    .await
    .unwrap();
    assert!(outcome.is_none(), "the 51st channel must be refused");
    tx.commit().await.unwrap();
    assert_eq!(
        membership_role_3707(&su, c3, fixture.hosted_agent).await,
        None
    );
    let _ = n3;

    // The function also refuses another agent's connection id.
    let other_connection: Uuid =
        sqlx::query_scalar("SELECT id FROM hosted_agent_connection WHERE agent_member_id=$1")
            .bind(fixture.connect_only_agent)
            .fetch_one(&su)
            .await
            .unwrap();
    set_to(1).await;
    let mut tx = su.begin().await.unwrap();
    let outcome = momo_auth::grant_hosted_channels_in_tx(
        &mut tx,
        fixture.workspace,
        other_connection,
        fixture.hosted_agent, // the proposer is NOT this connection's agent
        &[c3],
    )
    .await
    .unwrap();
    assert!(
        outcome.is_none(),
        "a connection of another agent is not grantable"
    );
    tx.commit().await.unwrap();
    assert_eq!(
        membership_role_3707(&su, c3, fixture.hosted_agent).await,
        None
    );
}

/// A grant gone stale, or reached by the wrong caller, writes nothing: the
/// connection stopped being live, the agent left the private room, an agent tries
/// to decide, and the database function itself refuses a private room the agent is
/// not in (the visibility rule is enforced there too, not only by the resolver).
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_stale_channel_grant_changes_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (q, q_name) = seed_channel_3707(&su, &fixture, "public", &[]).await;
    let (r, r_name) = seed_channel_3707(
        &su,
        &fixture,
        "private",
        &[(fixture.hosted_agent, "member")],
    )
    .await;
    let (hidden, _) = seed_channel_3707(&su, &fixture, "private", &[]).await;
    let before = approved_of_3709(&su, fixture.hosted_agent).await;

    // The connection stops being live before the tap.
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "hosted.channels.grant",
        json!({"channels": [q_name]}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let first = proposed_approval_3706(&proposed);
    // An agent bearer cannot decide it.
    let agent_try = client
        .post(format!(
            "{base}/v1/workspaces/{}/approvals/{first}/decision",
            fixture.workspace
        ))
        .bearer_auth(&fixture.hosted_bearer)
        .json(&json!({"approvalId": first, "approve": true, "clientDecisionId": Uuid::new_v4()}))
        .send()
        .await
        .unwrap();
    assert!(matches!(agent_try.status().as_u16(), 401 | 403));
    assert_eq!(approved_of_3709(&su, fixture.hosted_agent).await, before);

    // (`proved_at` cannot be cleared on an active connection — the shape check
    // forbids it — so the credential is revoked instead.)
    sqlx::query("UPDATE token SET revoked_at = now() WHERE id=$1")
        .bind(fixture.hosted_token)
        .execute(&su)
        .await
        .unwrap();
    let (status, _h, stale) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        first,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{stale}");
    assert_eq!(stale["status"], "action_args_invalid");
    assert_eq!(approved_of_3709(&su, fixture.hosted_agent).await, before);
    assert_eq!(
        membership_role_3707(&su, q, fixture.hosted_agent).await,
        None
    );
    sqlx::query("UPDATE token SET revoked_at = NULL WHERE id=$1")
        .bind(fixture.hosted_token)
        .execute(&su)
        .await
        .unwrap();

    // The agent leaves the private room before the tap.
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "hosted.channels.grant",
        json!({"channels": [r_name]}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id=$1 AND member_id=$2")
        .bind(r)
        .bind(fixture.hosted_agent)
        .execute(&su)
        .await
        .unwrap();
    let (status, _h, stale) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        proposed_approval_3706(&proposed),
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{stale}");
    assert_eq!(approved_of_3709(&su, fixture.hosted_agent).await, before);

    // The function refuses a private room the agent is not in, on its own.
    let mut tx = su.begin().await.unwrap();
    let outcome = momo_auth::grant_hosted_channels_in_tx(
        &mut tx,
        fixture.workspace,
        fixture.hosted_connection,
        fixture.hosted_agent,
        &[hidden],
    )
    .await
    .unwrap();
    assert!(outcome.is_none(), "a private room the agent cannot see");
    tx.commit().await.unwrap();
    assert_eq!(
        membership_role_3707(&su, hidden, fixture.hosted_agent).await,
        None
    );
    assert_eq!(approved_of_3709(&su, fixture.hosted_agent).await, before);
}

// ---------------------------------------------------------------------------
// ADR-0186 증보 2026-10-11 S5 (#3710) — workspace.settings.update
// ---------------------------------------------------------------------------

async fn settings_bag_3710(pool: &PgPool, workspace: Uuid) -> Value {
    sqlx::query_scalar("SELECT settings FROM workspace WHERE id=$1")
        .bind(workspace)
        .fetch_one(pool)
        .await
        .expect("settings bag")
}

/// **workspace.settings.update (증보 V7, V11).**
///
/// Two keys only, operator-gated, replaced whole for `role_labels`, cleared by
/// `null`; every other key of the bag is byte-identical before and after; the
/// audit row names the keys and carries no value; a stale card (the old value
/// moved) is refused with the approval still pending.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_approved_settings_update_changes_only_the_two_keys() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (_plain, plain_jwt) = seed_human_3708(&su, &fixture, "plain", "member").await;
    let start = json!({
        "allowed_agent_models": ["hermes-agent"],
        "role_labels": {"member": "팀원"},
        "welcome_prompt": "예전 문구"
    });
    sqlx::query("UPDATE workspace SET settings=$2 WHERE id=$1")
        .bind(fixture.workspace)
        .bind(&start)
        .execute(&su)
        .await
        .unwrap();

    // ---- keys this action does not own: refused before any card ------------
    let approvals_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM approval WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap();
    for args in [
        json!({"allowedAgentModels": ["anything"]}),
        json!({"welcomeAgentMemberId": fixture.hosted_agent}),
        json!({"welcomePrompt": "ok", "allowedAgentModels": []}),
        json!({"welcomePrompt": "가".repeat(501)}),
        json!({}),
    ] {
        let (status, refused) = try_propose_action_3706(
            &client,
            &base,
            &su,
            &fixture,
            "workspace.settings.update",
            args.clone(),
        )
        .await;
        assert_eq!(status, 400, "{args}: {refused}");
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM approval WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap(),
        approvals_before
    );

    // ---- a good proposal ----------------------------------------------------
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "workspace.settings.update",
        json!({"welcomePrompt": "새 환영 문구", "roleLabels": {"owner": "대표"}}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let approval = proposed_approval_3706(&proposed);
    let card: Value = sqlx::query_scalar("SELECT props FROM message WHERE id=$1")
        .bind(Uuid::parse_str(structured(&proposed)["cardMessageId"].as_str().unwrap()).unwrap())
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(card["action"]["required_role"], json!("workspace_operator"));
    let rows = card["action"]["rows"].as_array().unwrap().clone();
    let row = |label: &str| {
        rows.iter().find(|r| r["label"] == label).unwrap()["value"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(row("환영 문구"), "\"예전 문구\" → \"새 환영 문구\"");
    assert_eq!(row("역할 이름"), "member=\"팀원\" → owner=\"대표\"");
    assert_eq!(settings_bag_3710(&su, fixture.workspace).await, start);

    // ---- a non-operator and an agent cannot approve ------------------------
    let (status, _h, refused) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &plain_jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 403, "{refused}");
    assert_eq!(refused["status"], "role_required");
    let agent_try = client
        .post(format!(
            "{base}/v1/workspaces/{}/approvals/{approval}/decision",
            fixture.workspace
        ))
        .bearer_auth(&fixture.hosted_bearer)
        .json(&json!({"approvalId": approval, "approve": true,
                      "clientDecisionId": Uuid::new_v4()}))
        .send()
        .await
        .unwrap();
    assert!(matches!(agent_try.status().as_u16(), 401 | 403));
    assert_eq!(settings_bag_3710(&su, fixture.workspace).await, start);

    // ---- the admin approves ------------------------------------------------
    let (status, _h, approved) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{approved}");
    assert_eq!(
        approved["result"]["actionId"],
        json!("workspace.settings.update")
    );
    assert_eq!(
        approved["result"]["ref"],
        json!({"type": "workspace_settings", "id": fixture.workspace.to_string()})
    );
    assert!(approved["result"].get("secretOnce").is_none());
    assert_eq!(
        settings_bag_3710(&su, fixture.workspace).await,
        json!({
            "allowed_agent_models": ["hermes-agent"],
            "role_labels": {"owner": "대표"},
            "welcome_prompt": "새 환영 문구"
        }),
        "role_labels is replaced whole; every other key is untouched"
    );

    // ---- audit names the keys and carries no value --------------------------
    let detail: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id=$1 AND action='workspace_setting.updated'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(detail["keys"], json!(["welcome_prompt", "role_labels"]));
    assert_eq!(detail["via_agent"], json!(fixture.hosted_agent.to_string()));
    assert_eq!(detail["approval_id"], json!(approval.to_string()));
    let rendered = detail.to_string();
    assert!(
        !rendered.contains("새 환영 문구")
            && !rendered.contains("대표")
            && !rendered.contains("예전"),
        "the audit row must not carry the values: {rendered}"
    );
    assert_eq!(
        audit_count_3706(&su, fixture.workspace, "action.approved").await,
        1
    );
    let line: String = sqlx::query_scalar(
        "SELECT body FROM message WHERE workspace_id=$1 AND channel_id=$2 \
           AND props ? 'momo.action_result' ORDER BY seq DESC LIMIT 1",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(line, "설정을 바꿨어요: 환영 문구, 역할 이름");

    // ---- `null` clears one key and leaves the other -------------------------
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "workspace.settings.update",
        json!({"welcomePrompt": Value::Null}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let (status, _h, cleared) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        proposed_approval_3706(&proposed),
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{cleared}");
    assert_eq!(
        settings_bag_3710(&su, fixture.workspace).await,
        json!({"allowed_agent_models": ["hermes-agent"], "role_labels": {"owner": "대표"}})
    );

    // ---- a card whose old value moved is stale ------------------------------
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "workspace.settings.update",
        json!({"roleLabels": {"admin": "관리자"}}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let stale_approval = proposed_approval_3706(&proposed);
    sqlx::query(
        "UPDATE workspace SET settings = jsonb_set(settings, '{role_labels}', '{\"guest\":\"손님\"}') \
          WHERE id=$1",
    )
    .bind(fixture.workspace)
    .execute(&su)
    .await
    .unwrap();
    let moved = settings_bag_3710(&su, fixture.workspace).await;
    let (status, _h, stale) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        stale_approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{stale}");
    assert_eq!(stale["status"], "action_args_invalid");
    assert_eq!(settings_bag_3710(&su, fixture.workspace).await, moved);
    assert_eq!(approval_status_3708(&su, stale_approval).await, "pending");
}

/// The operator gate is `require_workspace_operator`'s set: a workspace admin OR a
/// principal carrying the platform operator scope — and a plain member with
/// neither is refused (covered above). Here: a non-admin member whose session
/// carries `platform:read` may approve.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_platform_operator_who_is_not_an_admin_may_approve_a_settings_update() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let (operator, _plain_jwt) = seed_human_3708(&su, &fixture, "operator", "member").await;
    let jwt = momo_auth::sign_access(
        operator,
        fixture.workspace,
        &["platform:read".to_string()],
        TEST_JWT_SECRET,
    )
    .expect("sign an operator JWT")
    .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY['platform:read']::text[],'operator')",
    )
    .bind(fixture.workspace)
    .bind(operator)
    .bind(&jwt)
    .execute(&su)
    .await
    .unwrap();
    let (status, proposed) = try_propose_action_3706(
        &client,
        &base,
        &su,
        &fixture,
        "workspace.settings.update",
        json!({"roleLabels": {"guest": "손님"}}),
    )
    .await;
    assert_eq!(status, 200, "{proposed}");
    let (status, _h, approved) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &jwt,
        proposed_approval_3706(&proposed),
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{approved}");
    assert_eq!(
        settings_bag_3710(&su, fixture.workspace).await["role_labels"],
        json!({"guest": "손님"})
    );
}

// ---------------------------------------------------------------------------
// (#3740 S1, ADR-0200 D2) the run event ledger
// ---------------------------------------------------------------------------

type LedgerRow = (i64, String, Option<String>, Option<String>, Option<Uuid>);

async fn ledger_3740(pool: &PgPool, workspace: Uuid, run: Uuid) -> Vec<LedgerRow> {
    sqlx::query_as(
        "SELECT seq, kind, stage, code, actor_member_id FROM agent_run_event \
          WHERE workspace_id=$1 AND run_id=$2 ORDER BY seq",
    )
    .bind(workspace)
    .bind(run)
    .fetch_all(pool)
    .await
    .expect("ledger rows")
}

fn kinds_3740(rows: &[LedgerRow]) -> Vec<&str> {
    rows.iter().map(|row| row.1.as_str()).collect()
}

async fn mention_3740(
    client: &reqwest::Client,
    base: &str,
    su: &PgPool,
    fixture: &Fixture,
    agent: Uuid,
) {
    let sent: Value = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "body": format!("@{} please answer", hosted_handle(su, agent).await)
        }))
        .send()
        .await
        .expect("mention send")
        .json()
        .await
        .expect("mention body");
    assert!(sent["id"].is_string(), "{sent}");
}

/// RED PROOF (ADR-0200 D2, S1). A hosted mention run leaves exactly the rows the
/// panel needs after it was closed — queued, claimed (with WHO), started, the
/// stage markers (folded when repeated), the terminal — in one gapless per-run
/// order. A managed agent's run in the same workspace writes nothing.
///
/// Tamper table (each edit must turn this test red):
///   * drop the `claimed` append in `jobs_claim`             -> kinds lack `claimed`
///   * drop the `Stage` append in `record_gateway_event_in_tx` -> kinds lack `stage`
///   * drop the `hosted_lease` guard around that append        -> (managed run test below) ledger rows for a managed run
///   * drop the fold in `agent_run_event_append`               -> the repeated stage adds a row
///   * drop the hosted predicate in `agent_run_event_on_run`   -> the managed run writes `queued`
///   * drop the AFTER INSERT/UPDATE agent_run triggers         -> no `queued`/`started`/`succeeded`
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_run_event_ledger_records_a_hosted_run_in_order() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();

    mention_3740(&client, &base, &su, &fixture, fixture.hosted_agent).await;
    let run: Uuid =
        sqlx::query_scalar("SELECT id FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2")
            .bind(fixture.workspace)
            .bind(fixture.hosted_agent)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(
        kinds_3740(&ledger_3740(&su, fixture.workspace, run).await),
        ["queued"],
        "the run row is the first ledger row, written by the trigger"
    );

    let (status, claimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{claimed}");
    let handle = structured(&claimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .expect("handle")
        .to_string();
    let rows = ledger_3740(&su, fixture.workspace, run).await;
    assert_eq!(kinds_3740(&rows), ["queued", "claimed"]);
    assert_eq!(
        rows[1].4,
        Some(fixture.hosted_agent),
        "`claimed` records WHICH agent took it"
    );
    let status_after_claim: String =
        sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id=$1")
            .bind(run)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(
        status_after_claim, "queued",
        "claim does not move agent_run.status — the ledger is where 'claimed' lives"
    );

    // A stage report starts the run and adds a marker; the same marker again
    // (a different eventId) folds; a stage-less event adds nothing.
    for (stage, expect_new) in [
        (Some("채널 이름 확인"), true),
        (Some("채널 이름 확인"), false),
        (None, false),
        (Some("승인 카드 제안"), true),
    ] {
        let mut arguments = json!({
            "leaseHandle": handle,
            "status": "running",
            "eventId": Uuid::new_v4(),
        });
        if let Some(stage) = stage {
            arguments["stage"] = json!(stage);
        }
        let before = ledger_3740(&su, fixture.workspace, run).await.len();
        let first_event = before == 2; // queued + claimed so far: this event also starts the run
        let (status, event) = call(
            &client,
            &base,
            &fixture.hosted_bearer,
            "oort_run_event",
            arguments,
        )
        .await;
        assert_eq!(status, 200, "{event}");
        let after = ledger_3740(&su, fixture.workspace, run).await.len();
        assert_eq!(
            after - before,
            usize::from(expect_new) + usize::from(first_event),
            "stage {stage:?}: a new marker adds one row, a repeat or a stage-less event none, \
             and the first event also adds `started`"
        );
    }

    // A rejected marker writes nothing at all.
    let before = ledger_3740(&su, fixture.workspace, run).await.len();
    let (status, _) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_event",
        json!({"leaseHandle": handle, "status": "running", "stage": "a/b"}),
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(ledger_3740(&su, fixture.workspace, run).await.len(), before);

    let (status, done) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_complete",
        json!({"leaseHandle": handle, "status": "succeeded", "body": "done"}),
    )
    .await;
    assert_eq!(status, 200, "{done}");

    let rows = ledger_3740(&su, fixture.workspace, run).await;
    assert_eq!(
        kinds_3740(&rows),
        [
            "queued",
            "claimed",
            "started",
            "stage",
            "stage",
            "succeeded"
        ]
    );
    assert!(
        rows.windows(2).all(|pair| pair[0].0 < pair[1].0),
        "seq strictly increases in write order: {rows:?}"
    );
    assert_eq!(rows[3].2.as_deref(), Some("채널 이름 확인"));
    assert_eq!(rows[4].2.as_deref(), Some("승인 카드 제안"));
    assert!(rows
        .iter()
        .filter(|row| row.1 != "stage")
        .all(|row| row.2.is_none()));

    // The managed agent's run in the same workspace writes no ledger row.
    mention_3740(&client, &base, &su, &fixture, fixture.managed_agent).await;
    let managed_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run_event e JOIN agent_run r \
           ON r.workspace_id=e.workspace_id AND r.id=e.run_id \
          WHERE r.workspace_id=$1 AND r.agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.managed_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    let managed_runs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.managed_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(managed_runs >= 1, "the managed mention produced a run");
    assert_eq!(managed_rows, 0, "ADR-0200 D6: hosted agents only");
}

/// RED PROOF (ADR-0200 D2, S1). The approval and sweep paths are covered by the
/// triggers, not by their callers: the notifier's own UPDATE (the approval
/// expiry sweep's role) writes the rows; the stage cap never evicts a lifecycle
/// row; and the table's own CHECKs refuse what the route validator would.
///
/// Tamper table:
///   * drop `agent_run_event_approval_*` triggers   -> no approval_requested/approval_decided
///   * drop the `code` extraction                   -> the timed_out row loses `approval_expired`
///   * drop the notifier GRANT (bootstrap_runtime_roles.sql) -> the notifier UPDATE dies with permission denied
///   * make the cap delete any kind (agent_run_event_trim) -> lifecycle rows vanish at 200
///   * relax `agent_run_event_stage_ck`             -> the `a/b` insert succeeds
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_ledger_triggers_cover_the_sweep_and_the_cap_keeps_lifecycle_rows() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let fixture = seed(&su).await;

    let run: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status) \
         VALUES ($1,$2,$3,'queued') RETURNING id",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    let approval: Uuid = sqlx::query_scalar(
        "INSERT INTO approval (workspace_id, run_id, channel_id, requested_by, action_type) \
         VALUES ($1,$2,$3,$4,'workspace_action') RETURNING id",
    )
    .bind(fixture.workspace)
    .bind(run)
    .bind(fixture.channel)
    .bind(fixture.hosted_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    sqlx::query("UPDATE agent_run SET status='awaiting_approval' WHERE id=$1")
        .bind(run)
        .execute(&su)
        .await
        .unwrap();

    // The expiry sweep runs as momo_notifier (BYPASSRLS, table-scoped grants):
    // its UPDATEs fire the triggers, which must be able to append as that role.
    let mut tx = notifier.begin().await.expect("notifier tx");
    sqlx::query("UPDATE approval SET status='expired' WHERE id=$1")
        .bind(approval)
        .execute(&mut *tx)
        .await
        .expect("notifier may expire an approval and fire the ledger trigger");
    sqlx::query("UPDATE agent_run SET status='timed_out', error=$2 WHERE id=$1")
        .bind(run)
        .bind(json!({"code": "approval_expired", "approval_id": approval.to_string()}))
        .execute(&mut *tx)
        .await
        .expect("notifier may end the run and fire the ledger trigger");
    tx.commit().await.unwrap();

    let rows = ledger_3740(&su, fixture.workspace, run).await;
    assert_eq!(
        kinds_3740(&rows),
        [
            "queued",
            "approval_requested",
            "approval_decided",
            "timed_out"
        ]
    );
    assert_eq!(rows[2].3.as_deref(), Some("expired"));
    assert_eq!(rows[3].3.as_deref(), Some("approval_expired"));
    assert_eq!(rows[1].4, Some(fixture.hosted_agent), "who asked");

    // The cap: 250 stages, 200 rows kept, every lifecycle row still there.
    for n in 0..250 {
        sqlx::query("SELECT agent_run_event_append($1,$2,'stage',$3,NULL,NULL,$4)")
            .bind(fixture.workspace)
            .bind(run)
            .bind(format!("단계 {n}"))
            .bind(fixture.hosted_agent)
            .execute(&su)
            .await
            .unwrap();
        sqlx::query("SELECT agent_run_event_trim($1,$2)")
            .bind(fixture.workspace)
            .bind(run)
            .execute(&su)
            .await
            .unwrap();
    }
    let rows = ledger_3740(&su, fixture.workspace, run).await;
    assert_eq!(rows.len(), 200);
    assert_eq!(
        rows.iter().filter(|row| row.1 != "stage").count(),
        4,
        "the cap evicts old stage rows only"
    );
    assert_eq!(
        rows.last().unwrap().2.as_deref(),
        Some("단계 249"),
        "the newest marker is the one kept"
    );

    // The table refuses what the route validator would (defence in depth).
    for (stage, code) in [
        (Some("a/b"), None),
        (Some("x"), Some("Bad Code")),
        (None, None),
    ] {
        let result = sqlx::query(
            "INSERT INTO agent_run_event (workspace_id, run_id, seq, kind, stage, code) \
             VALUES ($1,$2,9999,$3,$4,$5)",
        )
        .bind(fixture.workspace)
        .bind(run)
        .bind("stage")
        .bind(stage)
        .bind(code)
        .execute(&su)
        .await;
        let error = result.expect_err("a malformed row must be refused");
        let constraint = error
            .as_database_error()
            .and_then(|db| db.constraint())
            .unwrap_or_default()
            .to_string();
        assert!(
            constraint == "agent_run_event_stage_ck" || constraint == "agent_run_event_code_ck",
            "{stage:?} {code:?} refused by the table's own CHECK, not by something else: {constraint:?} / {error}"
        );
    }
}

/// RED PROOF (ADR-0200 D2, S1). The ledger is tenant-isolated by RLS FORCE on
/// the NOBYPASSRLS app role: no setting sees nothing, another tenant sees
/// nothing, and a write for a workspace other than the bound one is refused.
///
/// Tamper table:
///   * drop `FORCE ROW LEVEL SECURITY` or the policy -> another tenant reads rows
///   * drop WITH CHECK                               -> the cross-tenant INSERT succeeds
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_run_event_ledger_is_tenant_isolated() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let other = seed(&su).await;
    let run: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status) \
         VALUES ($1,$2,$3,'queued') RETURNING id",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();

    let count_as = |ws: Uuid| {
        let app = app.clone();
        async move {
            let mut tx = app.begin().await.unwrap();
            sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
                .bind(ws.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            let n: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_run_event")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            n
        }
    };
    assert_eq!(count_as(fixture.workspace).await, 1);
    assert_eq!(
        count_as(other.workspace).await,
        0,
        "another tenant sees none"
    );

    let mut tx = app.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(other.workspace.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    // Through the function: the run is invisible to the bound tenant (RLS on agent_run),
    // so the append is a NULL — it neither writes nor tells whether the run exists.
    let forged: Option<i64> =
        sqlx::query_scalar("SELECT agent_run_event_append($1,$2,'stage','x',NULL,NULL,NULL)")
            .bind(fixture.workspace)
            .bind(run)
            .fetch_one(&mut *tx)
            .await
            .expect("a foreign run is NULL, the same answer as a missing one");
    assert_eq!(forged, None);
    // Around the function: the table's own WITH CHECK refuses another tenant's row.
    sqlx::query("SAVEPOINT raw_insert")
        .execute(&mut *tx)
        .await
        .unwrap();
    let raw = sqlx::query(
        "INSERT INTO agent_run_event (workspace_id, run_id, kind) VALUES ($1,$2,'queued')",
    )
    .bind(fixture.workspace)
    .bind(run)
    .execute(&mut *tx)
    .await;
    assert!(
        raw.is_err(),
        "an INSERT for a workspace other than the bound one is refused by RLS"
    );
    drop(tx);
    assert_eq!(
        ledger_3740(&su, fixture.workspace, run).await.len(),
        1,
        "the foreign attempts wrote nothing"
    );
}

/// RED PROOF (ADR-0200 D2, S1; security review H1/M1/M3). The append takes no lock, so
/// it cannot close a cycle with the claim/approve/cancel paths; a missing run is a NULL,
/// not an error that would poison a claim; and history cannot be rewritten.
///
/// Tamper table:
///   * re-add `pg_advisory_xact_lock` to `agent_run_event_append`  -> the second transaction
///     blocks behind the open first one and the timeout below fires
///   * drop the `EXISTS (SELECT 1 FROM agent_run ...)` guard        -> the missing-run append raises 23503
///   * drop `agent_run_event_immutable_trg`                         -> the UPDATE succeeds
///   * drop the trim call in `append_run_event_in_tx`               -> a re-claim-only run grows past 200
///   * drop `agent_run_event_del_trg`                               -> the deleted run's ledger survives
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_ledger_append_takes_no_lock_and_history_is_immutable() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su).await;
    let run: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status) \
         VALUES ($1,$2,$3,'queued') RETURNING id",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    let approval: Uuid = sqlx::query_scalar(
        "INSERT INTO approval (workspace_id, run_id, channel_id, requested_by, action_type) \
         VALUES ($1,$2,$3,$4,'workspace_action') RETURNING id",
    )
    .bind(fixture.workspace)
    .bind(run)
    .bind(fixture.channel)
    .bind(fixture.hosted_agent)
    .fetch_one(&su)
    .await
    .unwrap();

    // Transaction A is a "cancel": it moves the run (the trigger appends) and stays OPEN.
    let mut a = su.begin().await.unwrap();
    sqlx::query("UPDATE agent_run SET status='cancelled' WHERE id=$1")
        .bind(run)
        .execute(&mut *a)
        .await
        .unwrap();

    // Transaction B is the opposite order: it holds the approval row, then appends a
    // `claimed` row for the same run and decides the approval (the trigger appends).
    // With any per-run lock in the append, B would wait for A here; A would then wait
    // for B's approval row — the deadlock the review found. It must finish while A is open.
    let b = async {
        let mut tx = su.begin().await.unwrap();
        sqlx::query("SELECT id FROM approval WHERE id=$1 FOR UPDATE")
            .bind(approval)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("SELECT agent_run_event_append($1,$2,'claimed',NULL,NULL,NULL,$3)")
            .bind(fixture.workspace)
            .bind(run)
            .bind(fixture.hosted_agent)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("UPDATE approval SET status='cancelled' WHERE id=$1")
            .bind(approval)
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), b)
        .await
        .expect("an append never waits for another transaction's lock");
    a.commit().await.unwrap();

    let rows = ledger_3740(&su, fixture.workspace, run).await;
    assert_eq!(rows.len(), 5, "{rows:?}");
    let mut kinds = kinds_3740(&rows);
    kinds.sort_unstable();
    assert_eq!(
        kinds,
        [
            "approval_decided",
            "approval_requested",
            "cancelled",
            "claimed",
            "queued"
        ]
    );

    // A job pointing at a run that does not exist appends nothing and does not raise.
    let missing: Option<i64> =
        sqlx::query_scalar("SELECT agent_run_event_append($1,$2,'claimed',NULL,NULL,NULL,$3)")
            .bind(fixture.workspace)
            .bind(Uuid::new_v4())
            .bind(fixture.hosted_agent)
            .fetch_one(&su)
            .await
            .expect("a missing run is NULL, not an error");
    assert_eq!(missing, None);

    // History is immutable — even for the superuser's UPDATE.
    let update = sqlx::query("UPDATE agent_run_event SET kind='failed' WHERE run_id=$1")
        .bind(run)
        .execute(&su)
        .await;
    let update = update.expect_err("agent_run_event rows must not be updatable");
    assert_eq!(
        update
            .as_database_error()
            .and_then(|db| db.code())
            .as_deref(),
        Some("23001"),
        "refused by the immutability trigger itself: {update}"
    );

    // The cap, through the PRODUCTION helper (the claim path calls it, not a test): old
    // `claimed` rows are shed, the newest stays, nothing else goes.
    {
        let mut conn = su.acquire().await.unwrap();
        for _ in 0..260 {
            let seq = momo_agent::append_run_event_in_tx(
                &mut conn,
                fixture.workspace,
                run,
                momo_agent::AppendedRunEvent::Claimed,
                fixture.hosted_agent,
            )
            .await
            .unwrap();
            assert!(seq.is_some());
        }
    }
    let rows = ledger_3740(&su, fixture.workspace, run).await;
    assert_eq!(
        rows.len(),
        200,
        "a hard bound even without a single stage row"
    );
    assert!(
        rows.iter().any(|row| row.1 == "queued") && rows.iter().any(|row| row.1 == "cancelled"),
        "only `claimed` rows were shed"
    );

    // No FK means the delete trigger is what removes a deleted run's ledger.
    sqlx::query("DELETE FROM approval WHERE run_id=$1")
        .bind(run)
        .execute(&su)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_run WHERE id=$1")
        .bind(run)
        .execute(&su)
        .await
        .unwrap();
    assert!(
        ledger_3740(&su, fixture.workspace, run).await.is_empty(),
        "a deleted run takes its ledger with it"
    );

    // …and under the production API role + RLS (momo_app, bound tenant), not only for the
    // superuser: the trigger's DELETE runs as the invoker.
    let app = momo_app_pool().await;
    let run2: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status) \
         VALUES ($1,$2,$3,'queued') RETURNING id",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(ledger_3740(&su, fixture.workspace, run2).await.len(), 1);
    let mut tx = app.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(fixture.workspace.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_run WHERE id=$1")
        .bind(run2)
        .execute(&mut *tx)
        .await
        .expect("momo_app may delete a run and fire the ledger delete trigger");
    tx.commit().await.unwrap();
    assert!(
        ledger_3740(&su, fixture.workspace, run2).await.is_empty(),
        "…as momo_app under RLS too"
    );
}

// ---------------------------------------------------------------------------
// (#3741 S2, ADR-0200 D1/D2/D3) the honest read side
// ---------------------------------------------------------------------------

async fn progress_3741(
    client: &reqwest::Client,
    base: &str,
    jwt: &str,
    fixture: &Fixture,
    channel: Uuid,
    query: &str,
) -> (u16, Value) {
    let response = client
        .get(format!(
            "{base}/v1/workspaces/{}/channels/{channel}/agent-runs/progress{query}",
            fixture.workspace
        ))
        .bearer_auth(jwt)
        .send()
        .await
        .expect("progress responds");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn events_3741(
    client: &reqwest::Client,
    base: &str,
    jwt: &str,
    fixture: &Fixture,
    run: &str,
) -> (u16, Value) {
    let response = client
        .get(format!(
            "{base}/v1/workspaces/{}/agent-runs/{run}/events",
            fixture.workspace
        ))
        .bearer_auth(jwt)
        .send()
        .await
        .expect("events responds");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

fn only_run_3741(body: &Value) -> &Value {
    let runs = body["runs"].as_array().expect("runs array");
    assert_eq!(runs.len(), 1, "{body}");
    &runs[0]
}

/// RED PROOF (ADR-0200 D1/D2, S2). The progress read tells the truth at every
/// step of one hosted run — queued (position 1) → claimed (when, lease live) →
/// running (latest stage) → lease stale (expired, not re-claimed) → succeeded —
/// and the ledger endpoint returns the same story with an ordinal and no raw
/// sequence. This is the 2026-10-13 incident reduced to a test: a run nobody has
/// taken is `queued`, never "working" and never "signal lost".
///
/// Tamper table:
///   * derive `claimed` from the run status instead of the job lease -> claimed step shows `queued`
///   * compute lease_state without the expiry compare               -> the expired lease shows `live`
///   * add `seq` to the event DTO                                   -> the no-seq assertion fails
///   * drop the channel-membership check in the events query         -> the outsider gets 200
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_progress_read_tells_the_truth_at_every_step_of_a_hosted_run() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();

    // nothing yet
    let (status, empty) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        "",
    )
    .await;
    assert_eq!(status, 200, "{empty}");
    assert_eq!(empty["runs"], json!([]));

    mention_3740(&client, &base, &su, &fixture, fixture.hosted_agent).await;
    let (_, body) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        "?state=active",
    )
    .await;
    let run = only_run_3741(&body);
    assert_eq!(run["phase"], json!("queued"), "{body}");
    assert_eq!(run["leaseState"], json!("none"));
    assert_eq!(run["queuePosition"], json!(1));
    assert_eq!(run["aheadTotal"], json!(0));
    assert!(run.get("claimedAtMs").is_none());
    let run_id = run["id"].as_str().unwrap().to_string();

    // claimed: the lease is the fact, run.status is still `queued`
    let (_, claimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    let handle = structured(&claimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .unwrap()
        .to_string();
    let (_, body) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        "",
    )
    .await;
    let run = only_run_3741(&body);
    assert_eq!(run["status"], json!("queued"));
    assert_eq!(run["phase"], json!("claimed"), "{body}");
    assert_eq!(run["leaseState"], json!("live"));
    assert!(run["claimedAtMs"].as_i64().unwrap() > 0);
    assert!(run.get("queuePosition").is_none(), "no position once taken");

    // taken but silent past the lease: still `claimed` (the run has not started), and the
    // lease is `stale` — "not renewed", with no queue position (it is not in the queue)
    sqlx::query(
        "UPDATE outbox SET lease_acquired_at = now() - interval '35 minutes', \
                lease_expires_at = now() - interval '5 minutes' \
          WHERE workspace_id=$1 AND kind='agent_job' AND partition_key=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    let (_, body) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        "",
    )
    .await;
    let run = only_run_3741(&body);
    assert_eq!(run["phase"], json!("claimed"), "{body}");
    assert_eq!(run["leaseState"], json!("stale"));
    assert!(run.get("queuePosition").is_none());

    // the agent comes back and renews the expired-but-unreclaimed handle (ADR-0162 A3):
    // the lease lives again, same job, same handle
    let (status, renewed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_job_renew",
        json!({"leaseHandle": handle}),
    )
    .await;
    assert_eq!(status, 200, "{renewed}");
    let (_, body) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        "",
    )
    .await;
    assert_eq!(only_run_3741(&body)["leaseState"], json!("live"), "{body}");

    // running with a stage
    let (status, event) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_event",
        json!({"leaseHandle": handle, "status": "running", "stage": "채널 이름 확인",
               "eventId": Uuid::new_v4()}),
    )
    .await;
    assert_eq!(status, 200, "{event}");
    let (_, body) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        "",
    )
    .await;
    let run = only_run_3741(&body);
    assert_eq!(run["phase"], json!("running"));
    assert_eq!(run["latestStage"], json!("채널 이름 확인"));
    assert_eq!(run["leaseState"], json!("live"));

    // the lease expires and nobody re-claims: stale, and still `running` — a server
    // fact ("lease not renewed"), never the client's "signal lost"
    sqlx::query(
        "UPDATE outbox SET lease_acquired_at = now() - interval '35 minutes', \
                lease_expires_at = now() - interval '5 minutes' \
          WHERE workspace_id=$1 AND kind='agent_job' AND partition_key=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    let (_, body) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        "",
    )
    .await;
    let run = only_run_3741(&body);
    assert_eq!(run["phase"], json!("running"));
    assert_eq!(run["leaseState"], json!("stale"), "{body}");

    // finished
    let (status, done) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_complete",
        json!({"leaseHandle": handle, "status": "succeeded", "body": "done"}),
    )
    .await;
    assert_eq!(status, 200, "{done}");
    let (_, body) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        "?state=active",
    )
    .await;
    assert_eq!(body["runs"], json!([]), "a finished run is not active");
    let (_, body) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        "?state=all",
    )
    .await;
    let run = only_run_3741(&body);
    assert_eq!(run["phase"], json!("succeeded"));
    assert!(run["finishedAtMs"].as_i64().unwrap() > 0);

    // the ledger: same story, ordinals, no raw sequence
    let (status, ledger) = events_3741(&client, &base, &fixture.human_jwt, &fixture, &run_id).await;
    assert_eq!(status, 200, "{ledger}");
    let events = ledger["events"].as_array().unwrap();
    let kinds: Vec<&str> = events.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(
        kinds,
        ["queued", "claimed", "started", "stage", "succeeded"]
    );
    assert_eq!(
        events
            .iter()
            .map(|e| e["ordinal"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        [1, 2, 3, 4, 5]
    );
    assert_eq!(events[3]["stage"], json!("채널 이름 확인"));
    let rendered = serde_json::to_string(&ledger).unwrap();
    assert!(
        !rendered.contains("\"seq\""),
        "the global sequence never leaves: {rendered}"
    );

    // a stranger to the channel and an unknown run are the same 404; a bad id is a 400
    let outsider = seed_outsider_3741(&su, &fixture).await;
    let (status, _) = events_3741(&client, &base, &outsider, &fixture, &run_id).await;
    assert_eq!(status, 404);
    let (status, _) = events_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        &Uuid::new_v4().to_string(),
    )
    .await;
    assert_eq!(status, 404);
    let (status, _) = events_3741(&client, &base, &fixture.human_jwt, &fixture, "nope").await;
    assert_eq!(status, 400);
    let (status, _) = progress_3741(&client, &base, &outsider, &fixture, fixture.channel, "").await;
    assert_eq!(status, 403, "progress is for channel members");
    let (status, _) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        "?state=bogus",
    )
    .await;
    assert_eq!(status, 400);
}

/// A workspace member who is in NO channel with the agent.
async fn seed_outsider_3741(pool: &PgPool, fixture: &Fixture) -> String {
    let jwt = seed_plain_member(pool, fixture).await;
    // seed_plain_member joins `channel`; this outsider leaves it again
    sqlx::query(
        "UPDATE membership SET left_at = now() \
          WHERE workspace_id=$1 AND channel_id=$2 AND member_id <> $3 \
            AND member_id NOT IN (SELECT id FROM member WHERE kind='agent') \
            AND member_id <> $4",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .bind(fixture.human)
    .bind(fixture.human)
    .execute(pool)
    .await
    .unwrap();
    jwt
}

/// RED PROOF (ADR-0200 D3, S2). Two members ask the same agent for work in two
/// different channels. The queue is the agent's real claim order; the second run
/// is position 2 for everyone; but a member of only the second channel is never
/// told WHICH run is ahead — a count, never a name — while a member of both is.
///
/// Tamper table:
///   * order the queue by anything other than `outbox.id`            -> positions swap
///   * return `ahead` without the viewer's membership filter          -> the outsider sees the other channel's run id
///   * count only the viewer's visible runs for `aheadTotal`          -> the outsider is told position 1 / total 0
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_queue_shows_the_claim_order_and_names_only_runs_the_viewer_can_see() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    // both channels are approved for the hosted agent
    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_channel_ids = $3 \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .bind(vec![fixture.channel, fixture.private_channel])
    .execute(&su)
    .await
    .unwrap();
    let plain_jwt = seed_plain_member(&su, &fixture).await; // member of `channel` only
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let handle = hosted_handle(&su, fixture.hosted_agent).await;

    for channel in [fixture.private_channel, fixture.channel] {
        let sent: Value = client
            .post(format!(
                "{base}/v1/workspaces/{}/channels/{channel}/messages",
                fixture.workspace
            ))
            .bearer_auth(&fixture.human_jwt)
            .json(&json!({"clientMsgId": Uuid::new_v4(), "body": format!("@{handle} go")}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(sent["id"].is_string(), "{sent}");
    }
    // The queue is the CLAIM order (outbox.id), not creation time: make the second run
    // look OLDER than the first, so ordering by created_at would swap the positions.
    sqlx::query(
        "UPDATE agent_run SET created_at = created_at - interval '2 hours' \
          WHERE workspace_id=$1 AND channel_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .execute(&su)
    .await
    .unwrap();
    let private_run: String = sqlx::query_scalar(
        "SELECT id::text FROM agent_run WHERE workspace_id=$1 AND channel_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.private_channel)
    .fetch_one(&su)
    .await
    .unwrap();

    // the plain member sees position 2 and ONE run ahead — as a count only
    let (status, body) =
        progress_3741(&client, &base, &plain_jwt, &fixture, fixture.channel, "").await;
    assert_eq!(status, 200, "{body}");
    let run = only_run_3741(&body);
    assert_eq!(run["queuePosition"], json!(2), "{body}");
    assert_eq!(run["aheadTotal"], json!(1));
    assert!(
        run.get("ahead").is_none(),
        "the other channel's run is not named: {body}"
    );
    assert!(
        !serde_json::to_string(&body).unwrap().contains(&private_run),
        "the other channel's run id never reaches a non-member"
    );

    // the human is in both channels: the same run, now named
    let (_, body) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        "",
    )
    .await;
    let run = only_run_3741(&body);
    assert_eq!(run["queuePosition"], json!(2));
    assert_eq!(run["ahead"].as_array().unwrap().len(), 1, "{body}");
    assert_eq!(
        run["ahead"][0]["runId"].as_str().unwrap().to_lowercase(),
        private_run.to_lowercase()
    );

    // once the agent takes the first job the second moves up
    let (_, claimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 1}),
    )
    .await;
    assert_eq!(structured(&claimed)["jobs"].as_array().unwrap().len(), 1);
    let (_, body) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        "",
    )
    .await;
    let run = only_run_3741(&body);
    assert_eq!(run["phase"], json!("queued"));
    assert_eq!(run["queuePosition"], json!(1), "{body}");
    assert_eq!(run["aheadTotal"], json!(0));

    // A job the agent could NOT claim (its token was revoked) is waiting but has no honest
    // position: none is given, instead of a confident "1st" for work nobody can take.
    sqlx::query("UPDATE token SET revoked_at = now() WHERE id=$1")
        .bind(fixture.hosted_token)
        .execute(&su)
        .await
        .unwrap();
    let (_, body) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        "",
    )
    .await;
    let run = only_run_3741(&body);
    assert_eq!(run["phase"], json!("queued"), "{body}");
    assert!(
        run.get("queuePosition").is_none(),
        "unclaimable => no position: {body}"
    );
}

/// RED PROOF (ADR-0200 D1/D2, S2). A finished run's `endReason` is the closed machine
/// code the server wrote and nothing else (a malformed or non-string code is dropped,
/// not echoed); `limit` bounds the page; and another tenant's channel and runs are
/// invisible — 403 for the channel, 404 for the ledger.
///
/// Tamper table:
///   * drop the `end_reason` regex                           -> the malformed code is echoed
///   * select `end_reason` for non-terminal runs too          -> the running run shows a reason
///   * drop the `LIMIT $4`                                    -> `limit=1` returns two runs
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_end_reason_is_a_closed_code_and_other_tenants_are_invisible() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let other = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();

    for (status, error) in [
        ("timed_out", Some(json!({"code": "approval_expired"}))),
        ("failed", Some(json!({"code": "Bad Code!"}))),
        ("failed", Some(json!({"code": 5}))),
        ("succeeded", None),
        ("running", Some(json!({"code": "ignored_while_running"}))),
    ] {
        sqlx::query(
            "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status, error) \
             VALUES ($1,$2,$3,$4::run_status,$5)",
        )
        .bind(fixture.workspace)
        .bind(fixture.hosted_agent)
        .bind(fixture.channel)
        .bind(status)
        .bind(error)
        .execute(&su)
        .await
        .unwrap();
    }
    let (status, body) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        "?limit=200",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let mut reasons: Vec<Option<String>> = body["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|run| run["endReason"].as_str().map(str::to_string))
        .collect();
    reasons.sort();
    assert_eq!(
        reasons,
        [None, None, None, None, Some("approval_expired".to_string())],
        "only the well-formed code of a FINISHED run is shown: {body}"
    );
    let (_, one) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        fixture.channel,
        "?limit=1",
    )
    .await;
    assert_eq!(one["runs"].as_array().unwrap().len(), 1);

    // another tenant's channel is not mine; its run's ledger is a 404, same as nothing
    let foreign_run: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status) \
         VALUES ($1,$2,$3,'queued') RETURNING id",
    )
    .bind(other.workspace)
    .bind(other.hosted_agent)
    .bind(other.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    let (status, _) = progress_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        other.channel,
        "",
    )
    .await;
    assert_eq!(status, 403);
    let (status, _) = events_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        &foreign_run.to_string(),
    )
    .await;
    assert_eq!(status, 404);
}

// ---------------------------------------------------------------------------
// (#3742 S3, ADR-0200 D4) liveness and oort_ping
// ---------------------------------------------------------------------------

async fn connection_liveness_3742(
    client: &reqwest::Client,
    base: &str,
    fixture: &Fixture,
) -> Value {
    let response: Value = client
        .get(format!(
            "{base}/v1/workspaces/{}/hosted-agent-connections/{}",
            fixture.workspace, fixture.hosted_connection
        ))
        .bearer_auth(&fixture.human_jwt)
        .send()
        .await
        .expect("connection get")
        .json()
        .await
        .expect("connection body");
    response["connection"]["liveness"].clone()
}

async fn liveness_row_3742(
    pool: &PgPool,
    fixture: &Fixture,
) -> Option<(
    Option<chrono::DateTime<chrono::Utc>>,
    Option<chrono::DateTime<chrono::Utc>>,
    Option<chrono::DateTime<chrono::Utc>>,
    Option<chrono::DateTime<chrono::Utc>>,
    Option<String>,
)> {
    sqlx::query_as(
        "SELECT last_inbox_read_at, last_claim_at, last_ping_at, last_tool_error_at, \
                last_tool_error_code \
           FROM hosted_agent_liveness WHERE workspace_id=$1 AND connection_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .fetch_optional(pool)
    .await
    .expect("liveness row")
}

/// RED PROOF (ADR-0200 D4-5, S3; 성재 결재 「생존 신호도 추가」). `oort_ping` proves a
/// runtime is up and nothing more: on its own it is `alive_idle` — "alive, takes no
/// work" — never `responsive`; a second ping inside 30 s is a harmless `recorded:false`
/// that moves nothing; and the work signals (inbox read, a claim that took a job)
/// are what make it `responsive`. Connect-only credentials cannot ping at all.
///
/// Tamper table:
///   * let a ping set a work column / count as work in `derive_liveness` -> ping alone shows `responsive`
///   * drop the 30 s throttle in `record_ping_in_tx`                      -> the second ping is `recorded:true`
///   * record a claim even when the claim returned no job                 -> `last_claim_at` set on an empty claim
///   * require no scope for the tool (drop `SCOPE_INBOX_READ`)            -> the connect-only credential pings
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_ping_proves_alive_not_working_and_the_work_signals_are_throttled() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();

    // never heard from: not "connected", not "alive"
    let liveness = connection_liveness_3742(&client, &base, &fixture).await;
    assert_eq!(liveness["state"], json!("unresponsive"), "{liveness}");
    assert_eq!(liveness["workWaiting"], json!(false));
    assert!(liveness_row_3742(&su, &fixture).await.is_none());

    // the tool is advertised to a credential with the inbox scope, and to nobody else
    assert!(list_tools(&client, &base, &fixture.hosted_bearer)
        .await
        .contains(&"oort_ping".to_string()));
    let (status, refused) = call(
        &client,
        &base,
        &fixture.connect_only_bearer,
        "oort_ping",
        json!({}),
    )
    .await;
    assert!(
        status >= 400,
        "a connect-only credential cannot ping: {refused}"
    );
    assert!(liveness_row_3742(&su, &fixture).await.is_none());

    // a ping: recorded, alive but idle
    let (status, pinged) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_ping",
        json!({"state": "idle"}),
    )
    .await;
    assert_eq!(status, 200, "{pinged}");
    assert_eq!(structured(&pinged)["recorded"], json!(true));
    assert_eq!(structured(&pinged)["minIntervalSeconds"], json!(30));
    let liveness = connection_liveness_3742(&client, &base, &fixture).await;
    assert_eq!(liveness["state"], json!("alive_idle"), "{liveness}");
    assert_eq!(liveness["lastPingState"], json!("idle"));
    assert!(
        liveness.get("lastWorkSignalAtMs").is_none(),
        "a ping is not work: {liveness}"
    );
    let first = liveness_row_3742(&su, &fixture).await.expect("row").2;

    // a second ping inside the window: success, recorded:false, nothing moves
    let (status, again) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_ping",
        json!({"state": "working"}),
    )
    .await;
    assert_eq!(status, 200, "a throttled ping is not an error: {again}");
    assert_eq!(structured(&again)["recorded"], json!(false));
    assert_eq!(liveness_row_3742(&su, &fixture).await.unwrap().2, first);
    let stored_state: Option<String> = sqlx::query_scalar(
        "SELECT last_ping_state FROM hosted_agent_liveness WHERE workspace_id=$1 AND connection_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        stored_state.as_deref(),
        Some("idle"),
        "the throttled call changed nothing"
    );

    // closed arguments
    for bad in [
        json!({"state": "sleeping"}),
        json!({"state": 3}),
        json!({"extra": true}),
    ] {
        let (status, _) = call(&client, &base, &fixture.hosted_bearer, "oort_ping", bad).await;
        assert_eq!(status, 400);
    }

    // an empty claim is not a claim
    let (_, empty) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({}),
    )
    .await;
    assert_eq!(structured(&empty)["jobs"], json!([]));
    assert!(liveness_row_3742(&su, &fixture).await.unwrap().1.is_none());

    // the inbox read is work: responsive, and throttled
    let (status, _) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_inbox_read",
        json!({"limit": 5}),
    )
    .await;
    assert_eq!(status, 200);
    let read = liveness_row_3742(&su, &fixture).await.unwrap().0;
    assert!(read.is_some());
    let liveness = connection_liveness_3742(&client, &base, &fixture).await;
    assert_eq!(liveness["state"], json!("responsive"), "{liveness}");
    let (status, _) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_inbox_read",
        json!({"limit": 5}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        liveness_row_3742(&su, &fixture).await.unwrap().0,
        read,
        "a poll inside 30 s writes nothing"
    );

    // a claim that took a job is work, and a queued job is "work waiting" before it
    mention_3740(&client, &base, &su, &fixture, fixture.hosted_agent).await;
    let liveness = connection_liveness_3742(&client, &base, &fixture).await;
    assert_eq!(liveness["workWaiting"], json!(true), "{liveness}");
    // a fresh job is just a polling agent's normal queue; one that has waited past the
    // responsive window while the agent keeps reading its inbox is NOT "responsive"
    assert_eq!(liveness["state"], json!("responsive"), "{liveness}");
    sqlx::query(
        "UPDATE outbox SET created_at = now() - interval '30 minutes' \
          WHERE workspace_id=$1 AND kind='agent_job' AND partition_key=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    let liveness = connection_liveness_3742(&client, &base, &fixture).await;
    assert_eq!(liveness["state"], json!("work_waiting"), "{liveness}");
    assert!(liveness["oldestWaitingAtMs"].as_i64().unwrap() > 0);
    let (_, claimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({}),
    )
    .await;
    assert_eq!(structured(&claimed)["jobs"].as_array().unwrap().len(), 1);
    assert!(liveness_row_3742(&su, &fixture).await.unwrap().1.is_some());
    let liveness = connection_liveness_3742(&client, &base, &fixture).await;
    assert_eq!(liveness["workWaiting"], json!(false));
}

/// RED PROOF (ADR-0200 D4, S3). The refusal that explains "Agent Port unavailable" is
/// kept as a closed code on the caller's own connection, turns the state to `error`
/// while it is the newest fact, and ends with the next accepted call of any kind — the
/// throttle on the work columns must not keep a recovered agent red. A lost lease or a
/// bad argument is the agent's own flow and is not an `error`. Members see the label
/// only; a stranger and a non-hosted agent are the same 404.
///
/// Tamper table:
///   * record every failure kind                          -> the bad-argument call turns the state to `error`
///   * compare the refusal only to the throttled work columns -> the recovery stays `error`
///   * return `lastToolErrorCode` to the member route      -> the member body carries the code
///   * answer 403 for the non-hosted agent                 -> existence of hosting is probeable
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_refusal_is_a_closed_code_that_recovers_and_members_see_the_label_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();

    // an accepted call first
    let (status, _) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_inbox_read",
        json!({}),
    )
    .await;
    assert_eq!(status, 200);

    // a bad argument is the agent's flow, not a connection fault
    let (status, _) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_inbox_read",
        json!({"limit": 0}),
    )
    .await;
    assert_eq!(status, 400);
    assert!(liveness_row_3742(&su, &fixture).await.unwrap().3.is_none());

    // …and so is a lost lease: renewing a handle the agent itself released answers 409
    // `Conflict` from INSIDE the tool (the case a record-every-failure bug would catch;
    // the schema 400 above never reaches the tool at all)
    mention_3740(&client, &base, &su, &fixture, fixture.hosted_agent).await;
    let (_, claimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({}),
    )
    .await;
    let handle = structured(&claimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .unwrap()
        .to_string();
    let (status, _) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_job_release",
        json!({"leaseHandle": handle}),
    )
    .await;
    assert_eq!(status, 200);
    let (status, lost) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_job_renew",
        json!({"leaseHandle": handle}),
    )
    .await;
    assert_eq!(status, 409, "{lost}");
    assert!(
        liveness_row_3742(&su, &fixture).await.unwrap().3.is_none(),
        "a lost lease is the agent's own flow, not a connection error"
    );

    // a refusal about the connection: an unapproved channel is "unavailable"
    let (status, refused) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_conversation_read",
        json!({"channelId": fixture.private_channel}),
    )
    .await;
    assert!(status >= 400, "{refused}");
    let (_, _, _, errored, code) = liveness_row_3742(&su, &fixture).await.unwrap();
    assert!(errored.is_some());
    assert!(
        matches!(
            code.as_deref(),
            Some("unavailable") | Some("not_authorized")
        ),
        "a closed code: {code:?}"
    );
    let liveness = connection_liveness_3742(&client, &base, &fixture).await;
    assert_eq!(liveness["state"], json!("error"), "{liveness}");
    assert_eq!(liveness["lastToolErrorCode"], json!(code.clone().unwrap()));

    // any accepted call ends it — even one the 30 s work-column throttle would swallow
    let (status, _) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_inbox_read",
        json!({}),
    )
    .await;
    assert_eq!(status, 200);
    let liveness = connection_liveness_3742(&client, &base, &fixture).await;
    assert_ne!(liveness["state"], json!("error"), "recovered: {liveness}");

    // the SAME refusal again, seconds later: a new fact, not swallowed by the 30 s
    // throttle (a flapping "unavailable" must not read as fine)
    let (status, _) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_conversation_read",
        json!({"channelId": fixture.private_channel}),
    )
    .await;
    assert!(status >= 400);
    let liveness = connection_liveness_3742(&client, &base, &fixture).await;
    assert_eq!(
        liveness["state"],
        json!("error"),
        "flapping stays visible: {liveness}"
    );
    let (status, _) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_inbox_read",
        json!({}),
    )
    .await;
    assert_eq!(status, 200);

    // the member-facing label
    let plain_jwt = seed_plain_member(&su, &fixture).await; // shares `channel` with the agent
    let url = format!(
        "{base}/v1/workspaces/{}/agents/{}/liveness",
        fixture.workspace, fixture.hosted_agent
    );
    let member: Value = client
        .get(&url)
        .bearer_auth(&plain_jwt)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        member["agentMemberId"].as_str().unwrap().to_lowercase(),
        fixture.hosted_agent.to_string()
    );
    assert!(member["state"].is_string());
    let rendered = serde_json::to_string(&member).unwrap();
    for hidden in ["lastToolError", "lastPing", "doorbell", "workWaiting"] {
        assert!(
            !rendered.contains(hidden),
            "members see the label only: {rendered}"
        );
    }

    // a managed agent (no hosted connection) and a stranger: the same 404
    let managed = client
        .get(format!(
            "{base}/v1/workspaces/{}/agents/{}/liveness",
            fixture.workspace, fixture.managed_agent
        ))
        .bearer_auth(&plain_jwt)
        .send()
        .await
        .unwrap();
    assert_eq!(managed.status().as_u16(), 404);
    let stranger = seed_outsider_3741(&su, &fixture).await;
    let outsider = client
        .get(&url)
        .bearer_auth(&stranger)
        .send()
        .await
        .unwrap();
    assert_eq!(outsider.status().as_u16(), 404);
}

// ---------------------------------------------------------------------------
// (#3744 S5, ADR-0200 D1-4 / D2) stall sweep, realtime frame, retention
// ---------------------------------------------------------------------------

/// Age a hosted run as if its agent went quiet `hours` ago: the lease expired then and the
/// run saw its last event then.
async fn age_run_3744(pool: &PgPool, fixture: &Fixture, run: Uuid, hours: i64) {
    sqlx::query(
        "UPDATE outbox SET lease_acquired_at = now() - make_interval(hours => $3 + 1), \
                lease_expires_at = now() - make_interval(hours => $3) \
          WHERE workspace_id=$1 AND kind='agent_job' AND lower(payload->>'run_id') = lower($2::text) \
            AND lease_owner IS NOT NULL",
    )
    .bind(fixture.workspace)
    .bind(run)
    .bind(hours as i32)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("UPDATE agent_run SET updated_at = now() - make_interval(hours => $2) WHERE id=$1")
        .bind(run)
        .bind(hours as i32)
        .execute(pool)
        .await
        .unwrap();
}

async fn run_status_3744(pool: &PgPool, run: Uuid) -> (String, Option<String>) {
    sqlx::query_as("SELECT status::text, error->>'code' FROM agent_run WHERE id=$1")
        .bind(run)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn frames_3744(pool: &PgPool, fixture: &Fixture, run: Uuid) -> Vec<Value> {
    sqlx::query_scalar::<_, Value>(
        "SELECT payload->'data' FROM outbox \
          WHERE workspace_id=$1 AND kind='broadcast' \
            AND payload->'data'->>'type' = 'agent.run.event' \
            AND lower(payload->'data'->'payload'->>'run_id') = lower($2::text) \
          ORDER BY id",
    )
    .bind(fixture.workspace)
    .bind(run)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// RED PROOF (ADR-0200 D1-4, S5). A hosted run whose agent went quiet is ended by the
/// SERVER with a closed fact — and only then. Fresh work, a revived lease, an
/// approval-parked run, a managed agent's run and a run inside either grace period are all
/// left alone; the ended run's job is retired so a late agent finds a settled run, not a
/// resurrected one; the channel gets one line and the audit log one row.
///
/// Tamper table (each applied and seen red):
///   * drop the `r.updated_at` staleness condition        -> the run with a recent report is ended
///   * drop the `lease_expires_at < now() - grace` term   -> the run whose lease expired 1 h ago
///     but that has been silent 3 h is ended
///   * drop the job-less branch (`j.id IS NULL`)          -> the disconnect-orphaned run and the
///     ten-day-old ghost are not ended
///   * let `awaiting_approval` through BOTH the candidate filter and `end_stalled_run_in_tx`
///     (either alone is caught by the other: two guards on purpose)
///                                                         -> the parked run (given a dead job) is ended
///   * do not retire the job                              -> a pending job survives the ended run
///   * drop the unclaimed term                            -> the 25-hour queued run stays queued
///   * key the notice by the run id                       -> the notice looks like the run's answer
/// Not covered here (deterministic only with an injected pause): the sweep-vs-reclaim race;
/// its second line of defence is `pending_job_has_live_lease_in_tx`, asserted above.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_run_whose_agent_went_quiet_is_ended_with_a_closed_code_and_nothing_else_is() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let notifier = momo_notifier_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app, true).await;
    let client = reqwest::Client::new();
    let policy = momo_outbox::StallPolicy::default();
    // The sweep is cross-tenant by design and this database outlives a test run: settle the
    // ghosts earlier runs left in OTHER workspaces so the counts below are this test's own.
    sqlx::query(
        "UPDATE agent_run SET status='cancelled', finished_at=now() \
          WHERE status IN ('queued','running') AND workspace_id <> $1",
    )
    .bind(fixture.workspace)
    .execute(&su)
    .await
    .unwrap();

    // --- the run that goes quiet -----------------------------------------
    mention_3740(&client, &base, &su, &fixture, fixture.hosted_agent).await;
    let (_, claimed) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_jobs_claim",
        json!({}),
    )
    .await;
    let handle = structured(&claimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .unwrap()
        .to_string();
    let (status, _) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_event",
        json!({"leaseHandle": handle, "status": "running", "stage": "작업 시작", "eventId": Uuid::new_v4()}),
    )
    .await;
    assert_eq!(status, 200);
    let quiet: Uuid =
        sqlx::query_scalar("SELECT id FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2")
            .bind(fixture.workspace)
            .bind(fixture.hosted_agent)
            .fetch_one(&su)
            .await
            .unwrap();

    // fresh: nothing to do
    let stats = momo_notifier::run_stall_sweep::sweep_stalled_runs(&notifier, policy, 50)
        .await
        .unwrap();
    assert_eq!(
        stats.lease_abandoned + stats.unclaimed_expired,
        0,
        "{stats:?}"
    );

    // the re-check the sweep makes under the run lock: a LIVE lease is seen as live…
    {
        let mut connection = su.acquire().await.unwrap();
        assert!(
            momo_outbox::pending_job_has_live_lease_in_tx(
                &mut connection,
                fixture.workspace,
                quiet
            )
            .await
            .unwrap(),
            "a freshly claimed job holds a live lease"
        );
    }

    // stale for 1 hour only: inside the 2-hour grace
    age_run_3744(&su, &fixture, quiet, 1).await;
    momo_notifier::run_stall_sweep::sweep_stalled_runs(&notifier, policy, 50)
        .await
        .unwrap();
    assert_eq!(
        run_status_3744(&su, quiet).await.0,
        "running",
        "1 h is inside the grace"
    );

    // the lease expired 3 hours ago but the agent reported 10 minutes ago: alive
    age_run_3744(&su, &fixture, quiet, 3).await;
    sqlx::query("UPDATE agent_run SET updated_at = now() - interval '10 minutes' WHERE id=$1")
        .bind(quiet)
        .execute(&su)
        .await
        .unwrap();
    momo_notifier::run_stall_sweep::sweep_stalled_runs(&notifier, policy, 50)
        .await
        .unwrap();
    assert_eq!(
        run_status_3744(&su, quiet).await.0,
        "running",
        "a recent report keeps it alive"
    );

    // the lease expired only an hour ago although the run has been silent for three: the LEASE
    // grace is separate from the run's own silence, so this one is still inside it
    sqlx::query(
        "UPDATE outbox SET lease_expires_at = now() - interval '1 hour' \
          WHERE workspace_id=$1 AND kind='agent_job' AND lower(payload->>'run_id') = lower($2::text)",
    )
    .bind(fixture.workspace)
    .bind(quiet)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query("UPDATE agent_run SET updated_at = now() - interval '3 hours' WHERE id=$1")
        .bind(quiet)
        .execute(&su)
        .await
        .unwrap();
    momo_notifier::run_stall_sweep::sweep_stalled_runs(&notifier, policy, 50)
        .await
        .unwrap();
    assert_eq!(
        run_status_3744(&su, quiet).await.0,
        "running",
        "a lease that expired inside the grace keeps the run, whatever its own silence"
    );

    // --- decoys that must survive the sweep that ends the quiet run ---------
    // an approval-parked run with an ancient lease
    let parked: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status, updated_at) \
         VALUES ($1,$2,$3,'awaiting_approval', now() - interval '9 hours') RETURNING id",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    // …and it holds a job whose lease is long dead, so that ONLY the status filter protects it
    sqlx::query(
        "INSERT INTO outbox(workspace_id,kind,status,method,payload,partition_key, \
                            lease_owner, lease_acquired_at, lease_expires_at) \
         VALUES ($1,'agent_job','pending','gateway',$2,$3, uuidv7(), \
                 now() - interval '10 hours', now() - interval '9 hours')",
    )
    .bind(fixture.workspace)
    .bind(json!({
        "agent_member_id": fixture.hosted_agent.to_string(),
        "run_id": parked.to_string(),
        "channel_id": fixture.channel.to_string(),
    }))
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    // a queued run nobody took, 23 hours (inside) and another 25 hours (past) old
    let mut queued = Vec::new();
    for hours in [23, 25] {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status, created_at, updated_at) \
             VALUES ($1,$2,$3,'queued', now() - make_interval(hours => $4), now() - make_interval(hours => $4)) \
             RETURNING id",
        )
        .bind(fixture.workspace)
        .bind(fixture.hosted_agent)
        .bind(fixture.channel)
        .bind(hours)
        .fetch_one(&su)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO outbox(workspace_id,kind,status,method,payload,partition_key) \
             VALUES ($1,'agent_job','pending','gateway',$2,$3)",
        )
        .bind(fixture.workspace)
        .bind(json!({
            "agent_member_id": fixture.hosted_agent.to_string(),
            "run_id": id.to_string(),
            "channel_id": fixture.channel.to_string(),
        }))
        .bind(fixture.hosted_agent)
        .execute(&su)
        .await
        .unwrap();
        queued.push(id);
    }
    // a managed agent's ancient queued run: not hosted, never this sweep's
    let managed: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status, created_at, updated_at) \
         VALUES ($1,$2,$3,'queued', now() - interval '30 hours', now() - interval '30 hours') RETURNING id",
    )
    .bind(fixture.workspace)
    .bind(fixture.managed_agent)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO outbox(workspace_id,kind,status,method,payload,partition_key) \
         VALUES ($1,'agent_job','pending','gateway',$2,$3)",
    )
    .bind(fixture.workspace)
    .bind(json!({
        "agent_member_id": fixture.managed_agent.to_string(),
        "run_id": managed.to_string(),
        "channel_id": fixture.channel.to_string(),
    }))
    .bind(fixture.managed_agent)
    .execute(&su)
    .await
    .unwrap();

    // runs whose delivery job was settled by a disconnect (the commonest ghost): no pending
    // job means no agent can ever report on them. Fresh one survives, silent one is ended.
    let mut suppressed = Vec::new();
    for hours_silent in [0_i32, 3] {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status, updated_at) \
             VALUES ($1,$2,$3,'running', now() - make_interval(hours => $4)) RETURNING id",
        )
        .bind(fixture.workspace)
        .bind(fixture.hosted_agent)
        .bind(fixture.channel)
        .bind(hours_silent)
        .fetch_one(&su)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO outbox(workspace_id,kind,status,method,payload,partition_key,processed_at) \
             VALUES ($1,'agent_job','done','gateway',$2,$3, now())",
        )
        .bind(fixture.workspace)
        .bind(json!({
            "agent_member_id": fixture.hosted_agent.to_string(),
            "run_id": id.to_string(),
            "channel_id": fixture.channel.to_string(),
        }))
        .bind(fixture.hosted_agent)
        .execute(&su)
        .await
        .unwrap();
        suppressed.push(id);
    }
    // a run whose only delivery path is a non-`gateway` job (a resume job): some consumer
    // still has a job to take, so it is NOT the job-less orphan the sweep ends
    let resumed: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status, created_at, updated_at) \
         VALUES ($1,$2,$3,'queued', now() - interval '3 hours', now() - interval '3 hours') RETURNING id",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO outbox(workspace_id,kind,status,method,payload,partition_key) \
         VALUES ($1,'agent_job','pending','resume_approval',$2,$3)",
    )
    .bind(fixture.workspace)
    .bind(json!({
        "agent_member_id": fixture.hosted_agent.to_string(),
        "run_id": resumed.to_string(),
        "channel_id": fixture.channel.to_string(),
    }))
    .bind(fixture.hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    // a run silent for ten days: ended, but without a channel line (the first sweep after a
    // deploy must not light up old channels with weeks-old notices)
    let ancient: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status, created_at, updated_at) \
         VALUES ($1,$2,$3,'running', now() - interval '12 days', now() - interval '10 days') RETURNING id",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();

    // --- now the quiet run really goes quiet --------------------------------
    age_run_3744(&su, &fixture, quiet, 3).await;
    {
        let mut connection = su.acquire().await.unwrap();
        assert!(
            !momo_outbox::pending_job_has_live_lease_in_tx(
                &mut connection,
                fixture.workspace,
                quiet
            )
            .await
            .unwrap(),
            "…and an expired one is not"
        );
    }
    let stats = momo_notifier::run_stall_sweep::sweep_stalled_runs(&notifier, policy, 50)
        .await
        .unwrap();
    assert_eq!(
        stats.lease_abandoned, 3,
        "the quiet run, the silent run with no delivery job, the ten-day-old one: {stats:?}"
    );
    assert_eq!(stats.unclaimed_expired, 1, "{stats:?}");
    assert_eq!(
        run_status_3744(&su, suppressed[1]).await,
        ("timed_out".to_string(), Some("lease_abandoned".to_string())),
        "a run whose job a disconnect settled is ended when it has been silent"
    );
    assert_eq!(
        run_status_3744(&su, suppressed[0]).await.0,
        "running",
        "…but not while it is fresh"
    );
    assert_eq!(run_status_3744(&su, ancient).await.0, "timed_out");
    assert_eq!(
        run_status_3744(&su, resumed).await.0,
        "queued",
        "a run with a pending resume job still has a delivery path"
    );
    let ancient_lines: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id=$1 AND run_id=$2 AND type='system'",
    )
    .bind(fixture.workspace)
    .bind(ancient)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(ancient_lines, 0, "an ancient ghost is ended quietly");

    assert_eq!(
        run_status_3744(&su, quiet).await,
        ("timed_out".to_string(), Some("lease_abandoned".to_string()))
    );
    assert_eq!(
        run_status_3744(&su, queued[1]).await,
        (
            "timed_out".to_string(),
            Some("unclaimed_expired".to_string())
        )
    );
    for (survivor, why) in [
        (parked, "an approval-parked run is the approval sweep's"),
        (queued[0], "23 hours is inside the 24-hour window"),
        (managed, "a managed agent's run is not a hosted run"),
    ] {
        let (status, code) = run_status_3744(&su, survivor).await;
        assert!(code.is_none() && status != "timed_out", "{why}: {status}");
    }

    // the ledger says it, the channel says it once, the audit log says why (actor: the clock)
    let ledger = ledger_3740(&su, fixture.workspace, quiet).await;
    let last = ledger.last().unwrap();
    assert_eq!(
        (last.1.as_str(), last.3.as_deref()),
        ("timed_out", Some("lease_abandoned"))
    );
    let lines: Vec<(String, Value)> = sqlx::query_as(
        "SELECT body, props FROM message WHERE workspace_id=$1 AND run_id=$2 AND type='system'",
    )
    .bind(fixture.workspace)
    .bind(quiet)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0].1["code"], json!("lease_abandoned"));
    let keyed_by_run: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id=$1 AND client_msg_id=$2",
    )
    .bind(fixture.workspace)
    .bind(quiet)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        keyed_by_run, 0,
        "the notice must not look like the run's ANSWER (client_msg_id = run id) to the push judgment"
    );
    let audits: Vec<(Option<Uuid>, Value)> = sqlx::query_as(
        "SELECT actor_member_id, detail FROM audit_log WHERE workspace_id=$1 AND action='agent.run.stalled' \
          AND target_id = $2",
    )
    .bind(fixture.workspace)
    .bind(quiet)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(audits.len(), 1);
    assert!(audits[0].0.is_none(), "the clock ended it, not a member");

    // the delivery job is settled: a late agent on the old handle finds a finished run
    let pending_jobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' AND status='pending' \
           AND lower(payload->>'run_id') = lower($2::text)",
    )
    .bind(fixture.workspace)
    .bind(quiet)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(pending_jobs, 0);
    let (status, late) = call(
        &client,
        &base,
        &fixture.hosted_bearer,
        "oort_run_event",
        json!({"leaseHandle": handle, "status": "running", "eventId": Uuid::new_v4()}),
    )
    .await;
    assert!(
        status >= 400,
        "a late agent does not revive an ended run: {late}"
    );
    assert_eq!(run_status_3744(&su, quiet).await.0, "timed_out");

    // idempotent
    let again = momo_notifier::run_stall_sweep::sweep_stalled_runs(&notifier, policy, 50)
        .await
        .unwrap();
    assert_eq!(again.lease_abandoned + again.unclaimed_expired, 0);

    // realtime: the lifecycle rows produced thin frames — no stage text, no sequence
    let frames = frames_3744(&su, &fixture, quiet).await;
    assert!(!frames.is_empty());
    let rendered = serde_json::to_string(&frames).unwrap();
    assert!(
        !rendered.contains("작업 시작"),
        "no stage text on the wire: {rendered}"
    );
    assert!(
        !rendered.contains("\"seq\""),
        "no raw sequence on the wire: {rendered}"
    );
    let kinds: Vec<&str> = frames
        .iter()
        .map(|frame| frame["payload"]["kind"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"timed_out"), "{kinds:?}");
}

/// RED PROOF (ADR-0200 D2, S5). The ledger announces itself with ONE thin frame per
/// lifecycle row, and consecutive `stage` rows inside two seconds collapse to a single
/// frame (the row is still written; a refetch carries it). The frame is addressed to the
/// run's channel topic.
///
/// Tamper table:
///   * drop the 2-second coalescing                    -> every stage row emits a frame
///   * put `stage`/`seq` in the frame                  -> the no-text / no-seq assertions fail
///   * address the frame to a different topic          -> the topic assertion fails
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_ledger_row_emits_one_thin_frame_and_a_stage_burst_is_coalesced() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su).await;
    let run: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status) \
         VALUES ($1,$2,$3,'queued') RETURNING id",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    // one transaction: all three stage rows share a timestamp, so they are "within 2 s"
    let mut tx = su.begin().await.unwrap();
    for stage in ["하나", "둘", "셋"] {
        sqlx::query("SELECT agent_run_event_append($1,$2,'stage',$3,NULL,NULL,$4)")
            .bind(fixture.workspace)
            .bind(run)
            .bind(stage)
            .bind(fixture.hosted_agent)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let frames = frames_3744(&su, &fixture, run).await;
    let kinds: Vec<&str> = frames
        .iter()
        .map(|frame| frame["payload"]["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        ["queued", "stage"],
        "three stage rows, one frame: {frames:?}"
    );
    let topic: String = sqlx::query_scalar(
        "SELECT payload->>'channel' FROM outbox WHERE workspace_id=$1 AND kind='broadcast' \
           AND payload->'data'->>'type'='agent.run.event' ORDER BY id LIMIT 1",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        topic,
        format!(
            "ch:ws{}.{}",
            fixture.workspace.to_string().to_uppercase(),
            fixture.channel.to_string().to_uppercase()
        )
    );
    let rendered = serde_json::to_string(&frames).unwrap();
    for hidden in ["하나", "둘", "셋", "\"seq\"", "stage\":"] {
        assert!(!rendered.contains(hidden), "{hidden}: {rendered}");
    }
    assert_eq!(
        ledger_3740(&su, fixture.workspace, run).await.len(),
        4,
        "all rows are still written"
    );
}

/// RED PROOF (ADR-0200 D2, S5). A FINISHED run's ledger is deleted 30 days after it
/// finished — and only that: a run finished 29 days ago, a run still in progress however
/// old, and the run rows themselves are untouched. Until the sweep deletes, a read past
/// retention answers an empty ledger. The delete runs on the RLS-bound pool; the read
/// half is the notifier's.
///
/// Tamper table:
///   * measure from `created_at` instead of `finished_at`  -> the ancient running run loses its ledger
///   * 30 -> 3 days                                        -> the 29-day-old ledger is deleted
///   * drop the read-time expiry in `list_run_events_in_tx` -> the expired-but-undeleted ledger is returned
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_finished_runs_ledger_is_kept_thirty_days_and_a_running_one_never_expires() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let notifier = momo_notifier_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();

    let mut runs = Vec::new();
    for (status, finished_days_ago, created_days_ago) in [
        ("succeeded", Some(31), 40),
        ("succeeded", Some(29), 40),
        ("running", None, 90),
    ] {
        let run: Uuid = sqlx::query_scalar(
            "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status, created_at, finished_at) \
             VALUES ($1,$2,$3,$4::run_status, now() - make_interval(days => $5), \
                     CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(days => $6) END) \
             RETURNING id",
        )
        .bind(fixture.workspace)
        .bind(fixture.hosted_agent)
        .bind(fixture.channel)
        .bind(status)
        .bind(created_days_ago)
        .bind(finished_days_ago)
        .fetch_one(&su)
        .await
        .unwrap();
        runs.push(run);
    }
    let [expired, young, ancient_running] = [runs[0], runs[1], runs[2]];
    for run in [expired, young, ancient_running] {
        assert!(!ledger_3740(&su, fixture.workspace, run).await.is_empty());
    }

    // read-time expiry: the sweep has not run, the ledger already reads empty
    let (status, body) = events_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        &expired.to_string(),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["events"],
        json!([]),
        "past retention reads empty: {body}"
    );
    let (_, body) = events_3741(
        &client,
        &base,
        &fixture.human_jwt,
        &fixture,
        &young.to_string(),
    )
    .await;
    assert!(
        !body["events"].as_array().unwrap().is_empty(),
        "29 days is kept: {body}"
    );

    let stats =
        momo_notifier::run_event_retention_sweep::sweep_expired_run_events(&notifier, &app, 50)
            .await
            .unwrap();
    assert!(stats.deleted >= 1, "{stats:?}");
    assert!(ledger_3740(&su, fixture.workspace, expired)
        .await
        .is_empty());
    assert!(!ledger_3740(&su, fixture.workspace, young).await.is_empty());
    assert!(
        !ledger_3740(&su, fixture.workspace, ancient_running)
            .await
            .is_empty(),
        "a run still in progress never expires, however old"
    );
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_run WHERE id = ANY($1)")
        .bind(&runs)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(rows, 3, "the run rows themselves are never touched");

    // idempotent
    let again =
        momo_notifier::run_event_retention_sweep::sweep_expired_run_events(&notifier, &app, 50)
            .await
            .unwrap();
    assert_eq!(again.deleted, 0);
}

/// RED PROOF (S5 review M-1). A steady stage stream keeps framing every two seconds — the
/// rate limit is against the last FRAMED stage row, not the last stage row, so it does not
/// fall silent after the first frame.
///
/// Tamper table:
///   * compare against the last stage row instead of the last framed one -> the third row
///     (2.2 s after the first) is not framed
///   * drop the rate limit                                                -> the second row is framed
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_steady_stage_stream_keeps_framing_every_two_seconds() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su).await;
    let run: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status) \
         VALUES ($1,$2,$3,'queued') RETURNING id",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_agent)
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    for (n, pause_ms) in [(1, 0_u64), (2, 1100), (3, 1100)] {
        tokio::time::sleep(std::time::Duration::from_millis(pause_ms)).await;
        sqlx::query("SELECT agent_run_event_append($1,$2,'stage',$3,NULL,NULL,$4)")
            .bind(fixture.workspace)
            .bind(run)
            .bind(format!("단계 {n}"))
            .bind(fixture.hosted_agent)
            .execute(&su)
            .await
            .unwrap();
    }
    let framed: Vec<bool> = sqlx::query_scalar(
        "SELECT framed FROM agent_run_event WHERE workspace_id=$1 AND run_id=$2 AND kind='stage' ORDER BY seq",
    )
    .bind(fixture.workspace)
    .bind(run)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(
        framed,
        [true, false, true],
        "1st framed; 2nd (1.1 s later) not; 3rd (2.2 s after the 1st) framed"
    );
    let frame_kinds: Vec<Value> = frames_3744(&su, &fixture, run).await;
    let stage_frames = frame_kinds
        .iter()
        .filter(|frame| frame["payload"]["kind"] == json!("stage"))
        .count();
    assert_eq!(stage_frames, 2);
}

// ---------------------------------------------------------------------------
// #3771 — a decided card is announced, and a late click names the real decider
// ---------------------------------------------------------------------------

/// The `message.edited` frames the outbox holds for one message.
async fn edited_frames_for(pool: &PgPool, workspace: Uuid, message: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload->'data' FROM outbox WHERE workspace_id=$1 AND kind='broadcast' \
           AND payload->'data'->>'type' = 'message.edited' \
           AND payload->'data'->'payload'->>'id' = $2 \
         ORDER BY created_at, id",
    )
    .bind(workspace)
    .bind(message.to_string())
    .fetch_all(pool)
    .await
    .expect("read edited frames")
}

/// **The decision rewrites the card and says so (#3771).**
///
/// Measured on prod 2026-10-13: the decision patched `message.props` and
/// published nothing, so the timeline kept `status: pending`, drew the buttons
/// again, and a second click answered 「이미 승인으로 기록되어 있었어요」 — stamped
/// with the *second* presser and the *second* press time (22:54 for a decision
/// that the ledger holds at 22:52).
///
/// 1. the refused (role_required) attempt announces the card (`last_attempt`);
/// 2. the approval announces it again with `status: approved` and no
///    `last_attempt`;
/// 3. a late click is a 409 whose receipt names the **ledger's** decider and
///    time, not the person pressing.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_decided_card_is_announced_and_a_late_click_names_the_real_decision() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();
    let plain_jwt = seed_plain_member(&su, &fixture).await;

    let (approval_id, card_message_id) = propose_invite(
        &client,
        &base,
        &su,
        &fixture,
        json!({"role": "member", "maxUses": 1, "expiresInDays": 7}),
    )
    .await;
    assert!(
        edited_frames_for(&su, fixture.workspace, card_message_id)
            .await
            .is_empty(),
        "a freshly proposed card has been announced by its own message.new, not an edit"
    );

    // 1. the refusal rewrites the card, so it announces it.
    let (status, _, refused) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &plain_jwt,
        approval_id,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 403, "{refused}");
    let after_refusal = edited_frames_for(&su, fixture.workspace, card_message_id).await;
    assert_eq!(after_refusal.len(), 1, "one frame for the refusal");
    assert_eq!(
        after_refusal[0]["payload"]["props"]["last_attempt"],
        json!("role_required")
    );
    assert_eq!(
        after_refusal[0]["payload"]["props"]["status"],
        json!("pending")
    );

    // 2. the approval announces the decided card.
    let (status, _, approved) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval_id,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{approved}");
    let frames = edited_frames_for(&su, fixture.workspace, card_message_id).await;
    assert_eq!(frames.len(), 2, "one more frame for the decision");
    let decided = &frames[1]["payload"];
    assert_eq!(decided["props"]["status"], json!("approved"));
    assert_eq!(
        decided["props"]["decided_by"],
        json!(fixture.human.to_string())
    );
    assert!(
        decided["props"].get("last_attempt").is_none(),
        "the earlier refusal is pruned from the announced card too: {decided}"
    );
    assert_eq!(
        decided["state"],
        json!("sent"),
        "a server rewrite is not a human edit: no 「수정됨」"
    );
    assert!(decided.get("edited_at_ms").is_none_or(Value::is_null));

    // 3. a late click, with a fresh key (what a re-mounted card sends).
    let ledger_ms: i64 = sqlx::query_scalar(
        "SELECT floor(extract(epoch FROM decided_at) * 1000)::bigint FROM approval \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(approval_id)
    .fetch_one(&su)
    .await
    .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    let (status, _, late) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval_id,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{late}");
    assert_eq!(late["status"], json!("approved"));
    assert_eq!(late["decidedBy"], json!(fixture.human.to_string()));
    assert_eq!(
        late["decidedAtMs"].as_i64(),
        Some(ledger_ms),
        "the late click reports the ledger's decision time, not its own: {late}"
    );
    assert_eq!(
        edited_frames_for(&su, fixture.workspace, card_message_id)
            .await
            .len(),
        2,
        "a refused late click rewrites nothing and announces nothing"
    );
}

/// The rejection arm rewrites the card too (#3771), so it announces it too.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_rejected_card_is_announced_as_rejected() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();
    let (approval_id, card_message_id) = propose_invite(
        &client,
        &base,
        &su,
        &fixture,
        json!({"role": "member", "maxUses": 1, "expiresInDays": 7}),
    )
    .await;
    let (status, _, rejected) = decide_as(
        &client,
        &base,
        fixture.workspace,
        &fixture.human_jwt,
        approval_id,
        false,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{rejected}");
    let frames = edited_frames_for(&su, fixture.workspace, card_message_id).await;
    assert_eq!(frames.len(), 1, "the rejection announces the card once");
    assert_eq!(frames[0]["payload"]["props"]["status"], json!("rejected"));
}
