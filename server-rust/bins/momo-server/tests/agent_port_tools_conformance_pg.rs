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
use std::sync::Mutex;

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
        "/../../../infra/e2e/bootstrap_roles.sql"
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
                 'agent:jobs:read','agent:runs:callback']::text[],$4)",
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
        vec!["oort_inbox_read"]
    );

    // Narrowing the token alone does the same from the other side.
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
           'messages:write','agent:jobs:read','agent:runs:callback']::text[] \
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
        8,
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

    // Every *terminal* lifecycle state is stronger than an empty catalog: the
    // proof step refuses the binding outright, so the request never reaches
    // `tools/list` at all and the credential answers 401.
    for status in ["expired", "cleanup_pending", "disconnected"] {
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
        8,
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
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='disconnected', active_token_id=NULL \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted_connection)
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
    // The tools themselves stay reachable: the gate is on delivery, and the
    // human already approved this connection's scopes.
    assert!(!list_tools(&client, &base, &fixture.hosted_bearer)
        .await
        .is_empty());
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
}
