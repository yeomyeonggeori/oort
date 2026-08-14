//! ADR-0162 / #1367 HAP-E6 — the hosted-agent disconnect lifecycle, end to end.
//!
//! The real Axum router runs against a `momo_app` (NOBYPASSRLS) pool, so every
//! answer below is produced by the same code path an operator and a hosted
//! adapter reach over HTTP. `DATABASE_URL` is a PostgreSQL 18 superuser URL used
//! only for migrations and fixtures. Run it through
//! `scripts/verify_hosted_disconnect.sh` so the database is isolated, owned and
//! reclaimed.
//!
//! Every assertion here is a byte-level one — a status code, a stored enum
//! label, a row count. None of it matches on prose, because the HAP-E5 review
//! found probabilistic text matching passing against messages that had already
//! drifted.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_auth::AgentBearerIdentity;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_server::config::{AgentGatewayMode, AgentGatewaySettings, AgentPortConfig};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "hosted-disconnect-pg-conformance-signing-secret";
const MODERN_VERSION: &str = "2026-07-28";
const PATH: &str = "/v1/mcp/agent-port";
const AUDIENCE: &str = "/v1/mcp/agent-port";
const HOSTED_SCOPES: [&str; 6] = [
    "agent:port:connect",
    "agent:inbox:read",
    "messages:read",
    "messages:write",
    "agent:jobs:read",
    "agent:runs:callback",
];
/// Every product tool a live hosted credential can reach (HAP-E5).
const PRODUCT_TOOLS: [&str; 8] = [
    "oort_inbox_read",
    "oort_conversation_read",
    "oort_message_post",
    "oort_jobs_claim",
    "oort_job_renew",
    "oort_job_release",
    "oort_run_event",
    "oort_run_complete",
];

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated PostgreSQL 18 URL")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

fn required_pg_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| {
        panic!("set {name}; scripts/verify_hosted_disconnect.sh supplies private PG client env")
    })
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to the disconnect conformance DB as superuser")
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
        .expect("apply every migration on the disconnect conformance DB");
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

async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_agent_gateway(AgentGatewaySettings {
        mode: AgentGatewayMode::Gateway,
        secret: "hosted-disconnect-conformance-gateway-secret".to_string(),
        allow_legacy_secret: false,
    })
    .with_agent_port(AgentPortConfig {
        external_origin: None,
        window_seconds: 60,
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        // HAP-E6 removed the `cfg` that made this unreachable in release, but
        // the default is still closed. A fixture that needs delivery opens it
        // by construction, exactly as an operator now opens it by env var.
        hosted_delivery_enabled: true,
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind disconnect conformance server");
    let address: SocketAddr = listener.local_addr().expect("disconnect server address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct HostedIdentity {
    agent: Uuid,
    connection: Uuid,
    token: Uuid,
    bearer: String,
}

#[derive(Debug)]
struct Fixture {
    workspace: Uuid,
    human: Uuid,
    human_jwt: String,
    ordinary_jwt: String,
    hosted: HostedIdentity,
    /// A second, fully independent hosted agent in the same workspace.
    sibling: HostedIdentity,
    /// A managed (non-hosted) agent in the same workspace.
    managed_agent: Uuid,
    managed_bearer: String,
    /// A dedicated hosted sentinel with **no** connection yet — the identity a
    /// test needs to build a connection in an arbitrary lifecycle state.
    spare_hosted_agent: Uuid,
    channel: Uuid,
}

fn raw_credential(workspace: Uuid) -> String {
    format!(
        "momo_agent_v1.{workspace}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

async fn insert_hosted_token(
    pool: &PgPool,
    workspace: Uuid,
    agent: Uuid,
    connection: Uuid,
    raw: &str,
    created_by: Uuid,
) -> Uuid {
    let scopes: Vec<String> = HOSTED_SCOPES.iter().map(|s| (*s).to_string()).collect();
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

async fn seed_agent(
    pool: &PgPool,
    workspace: Uuid,
    human: Uuid,
    handle: &str,
    hosted: bool,
) -> Uuid {
    let agent = Uuid::new_v4();
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
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
    )
    .bind(workspace)
    .bind(agent)
    .execute(pool)
    .await
    .expect("seed agent workspace membership");
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
    agent
}

async fn activate_hosted(
    pool: &PgPool,
    workspace: Uuid,
    human: Uuid,
    agent: Uuid,
    channel: Uuid,
) -> HostedIdentity {
    let connection = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_consumed_at,detected_at,detected_by, \
           confirmed_by,confirmed_at,approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,$3,'detected',now(),now(),$4,$4,now(),$5, \
           ARRAY['agent:port:connect','agent:inbox:read','messages:read','messages:write', \
                 'agent:jobs:read','agent:runs:callback']::text[],$4)",
    )
    .bind(connection)
    .bind(workspace)
    .bind(agent)
    .bind(human)
    .bind(vec![channel])
    .execute(pool)
    .await
    .expect("seed hosted connection");
    let bearer = raw_credential(workspace);
    let token = insert_hosted_token(pool, workspace, agent, connection, &bearer, human).await;
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='active', active_token_id=$3, \
           proved_at=now(), proved_by=$4 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .bind(token)
    .bind(agent)
    .execute(pool)
    .await
    .expect("activate hosted connection");
    HostedIdentity {
        agent,
        connection,
        token,
        bearer,
    }
}

async fn seed_human(pool: &PgPool, workspace: Uuid, label: &str, role: &str) -> (Uuid, String) {
    let human = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human',$3,$4)",
    )
    .bind(human)
    .bind(workspace)
    .bind(label)
    .bind(format!("{label}-{}", human.simple()))
    .execute(pool)
    .await
    .expect("seed human");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(human)
    .bind(workspace)
    .bind(format!("{human}@disconnect.test"))
    .execute(pool)
    .await
    .expect("seed human identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) \
         VALUES($1,$2,$3::text::membership_role)",
    )
    .bind(workspace)
    .bind(human)
    .bind(role)
    .execute(pool)
    .await
    .expect("seed human membership");
    let jwt = momo_auth::sign_access(human, workspace, &[], TEST_JWT_SECRET)
        .expect("sign a human App JWT")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'disconnect-conformance')",
    )
    .bind(workspace)
    .bind(human)
    .bind(&jwt)
    .execute(pool)
    .await
    .expect("record the human session token");
    (human, jwt)
}

async fn seed(pool: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("disc-{}", workspace.simple()))
        .execute(pool)
        .await
        .expect("seed workspace");

    let (human, human_jwt) = seed_human(pool, workspace, "Owner", "owner").await;
    let (_ordinary, ordinary_jwt) = seed_human(pool, workspace, "Member", "member").await;

    let hosted_agent = seed_agent(pool, workspace, human, "hosted", true).await;
    let sibling_agent = seed_agent(pool, workspace, human, "sibling", true).await;
    let managed_agent = seed_agent(pool, workspace, human, "managed", false).await;
    let spare_hosted_agent = seed_agent(pool, workspace, human, "spare", true).await;

    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channel(id, workspace_id, kind, name) VALUES($1,$2,'public',$3)")
        .bind(channel)
        .bind(workspace)
        .bind(format!("room-{}", channel.simple()))
        .execute(pool)
        .await
        .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
        .bind(channel)
        .bind(workspace)
        .execute(pool)
        .await
        .expect("seed channel_seq");
    for member in [human, hosted_agent, sibling_agent, managed_agent] {
        sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
            .bind(workspace)
            .bind(channel)
            .bind(member)
            .execute(pool)
            .await
            .expect("seed channel membership");
    }

    let hosted = activate_hosted(pool, workspace, human, hosted_agent, channel).await;
    let sibling = activate_hosted(pool, workspace, human, sibling_agent, channel).await;

    // A managed agent's generic bearer: it must keep working across another
    // agent's disconnect, which is the mixed-workspace half of the evidence.
    let managed_bearer = raw_credential(workspace);
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'), \
                ARRAY['messages:write','messages:read']::text[],'managed runtime')",
    )
    .bind(workspace)
    .bind(managed_agent)
    .bind(&managed_bearer)
    .execute(pool)
    .await
    .expect("seed managed bearer");

    Fixture {
        workspace,
        human,
        human_jwt,
        ordinary_jwt,
        hosted,
        sibling,
        managed_agent,
        managed_bearer,
        spare_hosted_agent,
        channel,
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

async fn agent_port(
    client: &reqwest::Client,
    base: &str,
    bearer: &str,
    method: &str,
    tool: Option<&str>,
    arguments: Value,
) -> (u16, Value) {
    let body = match tool {
        Some(tool) => modern_body(
            method,
            json!(Uuid::new_v4().to_string()),
            json!({"name": tool, "arguments": arguments}),
        ),
        None => modern_body(method, json!(1), json!({})),
    };
    let mut request = client
        .post(format!("{base}{PATH}"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", method)
        .bearer_auth(bearer);
    if let Some(tool) = tool {
        request = request.header("mcp-name", tool);
    }
    let response = request
        .json(&body)
        .send()
        .await
        .expect("agent port responds");
    let status = response.status().as_u16();
    let value: Value = response.json().await.unwrap_or(Value::Null);
    (status, value)
}

async fn call(
    client: &reqwest::Client,
    base: &str,
    bearer: &str,
    tool: &str,
    arguments: Value,
) -> (u16, Value) {
    agent_port(client, base, bearer, "tools/call", Some(tool), arguments).await
}

async fn list_tools(client: &reqwest::Client, base: &str, bearer: &str) -> (u16, Vec<String>) {
    let (status, value) = agent_port(client, base, bearer, "tools/list", None, json!({})).await;
    let names = value["result"]["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    (status, names)
}

fn structured(value: &Value) -> &Value {
    &value["result"]["structuredContent"]
}

async fn post_json(
    client: &reqwest::Client,
    base: &str,
    jwt: &str,
    path: &str,
    body: Value,
) -> (u16, Value) {
    let response = client
        .post(format!("{base}{path}"))
        .bearer_auth(jwt)
        .json(&body)
        .send()
        .await
        .expect("REST responds");
    let status = response.status().as_u16();
    let value: Value = response.json().await.unwrap_or(Value::Null);
    (status, value)
}

async fn get_json(client: &reqwest::Client, base: &str, jwt: &str, path: &str) -> (u16, Value) {
    let response = client
        .get(format!("{base}{path}"))
        .bearer_auth(jwt)
        .send()
        .await
        .expect("REST responds");
    let status = response.status().as_u16();
    let value: Value = response.json().await.unwrap_or(Value::Null);
    (status, value)
}

fn disconnect_path(workspace: Uuid, connection: Uuid) -> String {
    format!("/v1/workspaces/{workspace}/hosted-agent-connections/{connection}/disconnect")
}

fn complete_path(workspace: Uuid, connection: Uuid) -> String {
    format!("/v1/workspaces/{workspace}/hosted-agent-connections/{connection}/disconnect/complete")
}

fn acknowledge_path(workspace: Uuid, connection: Uuid, artifact: &str) -> String {
    format!(
        "/v1/workspaces/{workspace}/hosted-agent-connections/{connection}/cleanup-artifacts/{artifact}/acknowledge"
    )
}

fn artifact_id(manifest: &Value, kind: &str) -> String {
    manifest
        .as_array()
        .expect("manifest array")
        .iter()
        .find(|item| item["kind"] == json!(kind) && item.get("externalRef").is_none())
        .unwrap_or_else(|| panic!("seeded {kind} row is present: {manifest}"))["id"]
        .as_str()
        .expect("artifact id")
        .to_string()
}

async fn connection_status(pool: &PgPool, workspace: Uuid, connection: Uuid) -> String {
    sqlx::query_scalar("SELECT status FROM hosted_agent_connection WHERE workspace_id=$1 AND id=$2")
        .bind(workspace)
        .bind(connection)
        .fetch_one(pool)
        .await
        .expect("connection status")
}

async fn live_credential_count(pool: &PgPool, workspace: Uuid, connection: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM token WHERE workspace_id=$1 AND hosted_connection_id=$2 \
           AND revoked_at IS NULL",
    )
    .bind(workspace)
    .bind(connection)
    .fetch_one(pool)
    .await
    .expect("live credential count")
}

async fn paused(pool: &PgPool, workspace: Uuid, agent: Uuid) -> bool {
    sqlx::query_scalar(
        "SELECT paused FROM agent_profile WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(workspace)
    .bind(agent)
    .fetch_one(pool)
    .await
    .expect("paused flag")
}

async fn audit_count(pool: &PgPool, workspace: Uuid, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND action=$2")
        .bind(workspace)
        .bind(action)
        .fetch_one(pool)
        .await
        .expect("audit count")
}

async fn mention_and_claim(
    client: &reqwest::Client,
    base: &str,
    su: &PgPool,
    fixture: &Fixture,
    identity: &HostedIdentity,
) -> String {
    let handle: String = sqlx::query_scalar("SELECT handle FROM member WHERE id=$1")
        .bind(identity.agent)
        .fetch_one(su)
        .await
        .expect("agent handle");
    let (status, _) = post_json(
        client,
        base,
        &fixture.human_jwt,
        &format!(
            "/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ),
        json!({"clientMsgId": Uuid::new_v4(), "body": format!("@{handle} please answer")}),
    )
    .await;
    assert_eq!(status, 201, "the mention that produces hosted work");
    let (status, claimed) = call(
        client,
        base,
        &identity.bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{claimed}");
    structured(&claimed)["jobs"][0]["leaseHandle"]
        .as_str()
        .expect("a claimed lease handle")
        .to_string()
}

/// Resolve every seeded artifact so the terminal transition is reachable.
/// `bot_disposition` is the caller's choice, because both answers are terminal.
async fn resolve_manifest(
    client: &reqwest::Client,
    base: &str,
    fixture: &Fixture,
    connection: Uuid,
    manifest: &Value,
    bot_disposition: &str,
) {
    for (kind, disposition, status) in [
        ("bot", bot_disposition, "present"),
        ("routine", "delete", "absent"),
        ("plugin", "delete", "absent"),
        ("connector", "delete", "absent"),
        ("local_plugin_files", "delete", "absent"),
    ] {
        let id = artifact_id(manifest, kind);
        let (code, body) = post_json(
            client,
            base,
            &fixture.human_jwt,
            &acknowledge_path(fixture.workspace, connection, &id),
            json!({
                "currentStatus": status,
                "disposition": disposition,
                "evidence": format!("{kind} handled in the provider UI")
            }),
        )
        .await;
        assert_eq!(code, 200, "{kind}: {body}");
        assert_eq!(body["artifact"]["resolved"], json!(true), "{kind}");
    }
}

// ---------------------------------------------------------------------------
// (1) the start is one transaction, and it closes everything at once
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_disconnect_start_revokes_pauses_suppresses_and_closes_every_capability() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app).await;
    let client = reqwest::Client::new();

    // A live connection: eight tools, and one claimed lease in hand.
    let (status, tools) = list_tools(&client, &base, &fixture.hosted.bearer).await;
    assert_eq!(status, 200);
    assert_eq!(tools, PRODUCT_TOOLS.to_vec());
    let handle = mention_and_claim(&client, &base, &su, &fixture, &fixture.hosted).await;
    let leased_before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND method='gateway' AND partition_key=$2 AND status='pending' \
           AND lease_owner IS NOT NULL",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted.agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(leased_before, 1, "one job is out on lease before the pull");

    let messages_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap();
    let inbox_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM hosted_agent_inbox_event WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap();
    assert!(messages_before > 0 && inbox_before > 0);

    // ---- the one transaction ----------------------------------------------
    let (code, started) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &disconnect_path(fixture.workspace, fixture.hosted.connection),
        json!({"artifacts": [{"kind": "routine", "externalRef": "morning-digest"}]}),
    )
    .await;
    assert_eq!(code, 200, "{started}");
    assert_eq!(started["connection"]["status"], json!("cleanup_pending"));
    assert_eq!(started["startedNow"], json!(true));
    // Six seeded kinds plus the one named item; the credential row is the only
    // one this server can close by itself, so five remain required.
    assert_eq!(started["cleanupArtifacts"].as_array().unwrap().len(), 7);
    assert_eq!(started["remainingRequired"], json!(6));

    assert_eq!(
        connection_status(&su, fixture.workspace, fixture.hosted.connection).await,
        "cleanup_pending"
    );
    assert_eq!(
        live_credential_count(&su, fixture.workspace, fixture.hosted.connection).await,
        0,
        "the bearer is revoked in the same transaction"
    );
    assert!(paused(&su, fixture.workspace, fixture.hosted.agent).await);
    let (pending_jobs, leased_after): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE status='pending'), \
                count(*) FILTER (WHERE lease_owner IS NOT NULL) \
           FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
            AND method='gateway' AND partition_key=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted.agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(pending_jobs, 0, "open work is suppressed");
    assert_eq!(leased_after, 0, "the outstanding lease is released");
    let last_error: Option<String> = sqlx::query_scalar(
        "SELECT last_error FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND partition_key=$2 ORDER BY id DESC LIMIT 1",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted.agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        last_error.as_deref(),
        Some(momo_outbox::HOSTED_DISCONNECT_JOB_LAST_ERROR)
    );

    // The seeded secret row is the server-verified one; everything else is not.
    let manifest = &started["cleanupArtifacts"];
    let secret = manifest
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["kind"] == json!("secret") && item.get("externalRef").is_none())
        .expect("seeded secret row");
    assert_eq!(secret["source"], json!("server_verified"));
    assert_eq!(secret["disposition"], json!("revoked"));
    assert_eq!(secret["resolved"], json!(true));
    for kind in [
        "bot",
        "routine",
        "plugin",
        "connector",
        "local_plugin_files",
    ] {
        let item = manifest
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["kind"] == json!(kind) && item.get("externalRef").is_none())
            .unwrap_or_else(|| panic!("seeded {kind}"));
        assert_eq!(item["disposition"], json!("pending"), "{kind}");
        assert!(item.get("source").is_none(), "{kind}");
    }
    assert_eq!(
        manifest.as_array().unwrap()[0]["expectedAction"],
        json!("decide"),
        "bot sorts first and asks for a decision, never a silent removal"
    );

    // ---- every old capability is closed ------------------------------------
    let (status, tools) = list_tools(&client, &base, &fixture.hosted.bearer).await;
    assert_eq!(status, 401, "the transport refuses the revoked bearer");
    assert!(tools.is_empty());
    for tool in PRODUCT_TOOLS {
        let (status, _) = call(&client, &base, &fixture.hosted.bearer, tool, json!({})).await;
        assert_eq!(status, 401, "{tool} after disconnect");
    }
    // The gateway verbs specifically, with the handle that was live a moment ago.
    for tool in ["oort_job_renew", "oort_job_release", "oort_run_complete"] {
        let (status, _) = call(
            &client,
            &base,
            &fixture.hosted.bearer,
            tool,
            json!({"leaseHandle": handle, "status": "succeeded"}),
        )
        .await;
        assert_eq!(status, 401, "{tool} with a pre-disconnect handle");
    }
    // …and the inbox cursor path, which is the one that used to be a poll loop.
    let (status, _) = call(
        &client,
        &base,
        &fixture.hosted.bearer,
        "oort_inbox_read",
        json!({"limit": 5}),
    )
    .await;
    assert_eq!(status, 401, "the inbox cursor stops opening");
    // The foundation request itself is refused, so `initialize` cannot reopen.
    let (status, _) = agent_port(
        &client,
        &base,
        &fixture.hosted.bearer,
        "initialize",
        None,
        json!({}),
    )
    .await;
    assert_eq!(status, 401);

    // ---- and nothing was deleted ------------------------------------------
    let messages_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap();
    let inbox_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM hosted_agent_inbox_event WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap();
    let cursor_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM hosted_agent_inbox_counter WHERE workspace_id=$1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(messages_after, messages_before, "no chat cascade");
    assert_eq!(inbox_after, inbox_before, "no inbox cascade");
    assert!(cursor_rows > 0, "the connection's cursor row survives");

    // ---- the retry is the same answer, written once ------------------------
    assert_eq!(
        audit_count(
            &su,
            fixture.workspace,
            "hosted_agent.connection.disconnect_started"
        )
        .await,
        1
    );
    let (code, replayed) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &disconnect_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    assert_eq!(code, 200, "{replayed}");
    assert_eq!(replayed["startedNow"], json!(false));
    assert_eq!(replayed["connection"]["status"], json!("cleanup_pending"));
    assert_eq!(
        audit_count(
            &su,
            fixture.workspace,
            "hosted_agent.connection.disconnect_started"
        )
        .await,
        1,
        "a replay does not amplify the audit"
    );

    // ---- the sibling hosted agent and the managed one are untouched --------
    let (status, sibling_tools) = list_tools(&client, &base, &fixture.sibling.bearer).await;
    assert_eq!(status, 200);
    assert_eq!(sibling_tools, PRODUCT_TOOLS.to_vec());
    assert_eq!(
        connection_status(&su, fixture.workspace, fixture.sibling.connection).await,
        "active"
    );
    assert_eq!(
        live_credential_count(&su, fixture.workspace, fixture.sibling.connection).await,
        1,
        "a sibling connection's credential is never collateral (#1374 direction)"
    );
    assert!(!paused(&su, fixture.workspace, fixture.sibling.agent).await);
    assert!(!paused(&su, fixture.workspace, fixture.managed_agent).await);
    let (status, _) = post_json(
        &client,
        &base,
        &fixture.managed_bearer,
        &format!(
            "/v1/workspaces/{}/channels/{}/messages",
            fixture.workspace, fixture.channel
        ),
        json!({"clientMsgId": Uuid::new_v4(), "body": "a managed agent still writes"}),
    )
    .await;
    assert_eq!(status, 201, "a generic non-hosted bearer keeps working");
}

// ---------------------------------------------------------------------------
// (2) the manifest: the #1344 negatives, and the bot's two terminals
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_manifest_separates_a_connector_from_its_files_and_an_inactive_routine_from_removal() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app).await;
    let client = reqwest::Client::new();

    let (code, started) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &disconnect_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    assert_eq!(code, 200, "{started}");
    let manifest = started["cleanupArtifacts"].clone();
    assert_eq!(manifest.as_array().unwrap().len(), 6);

    // ---- #1344: uninstalling the connector left the files behind -----------
    let connector = artifact_id(&manifest, "connector");
    let files = artifact_id(&manifest, "local_plugin_files");
    let (code, body) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &acknowledge_path(fixture.workspace, fixture.hosted.connection, &connector),
        json!({
            "currentStatus": "absent",
            "disposition": "delete",
            "evidence": "Uninstall pressed in the provider UI"
        }),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["artifact"]["resolved"], json!(true));
    assert_eq!(body["artifact"]["source"], json!("manual"));
    let (code, manifest_after) = get_json(
        &client,
        &base,
        &fixture.human_jwt,
        &format!(
            "/v1/workspaces/{}/hosted-agent-connections/{}",
            fixture.workspace, fixture.hosted.connection
        ),
    )
    .await;
    assert_eq!(code, 200);
    let files_row = manifest_after["cleanupArtifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == json!(files))
        .expect("the local files row");
    assert_eq!(
        files_row["resolved"],
        json!(false),
        "a connector uninstall does not remove the files it left on disk"
    );

    // ---- #1344: an inactive routine is not a removed routine ---------------
    let routine = artifact_id(&manifest, "routine");
    let (code, observed) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &acknowledge_path(fixture.workspace, fixture.hosted.connection, &routine),
        json!({"currentStatus": "inactive"}),
    )
    .await;
    assert_eq!(code, 200, "{observed}");
    assert_eq!(observed["artifact"]["currentStatus"], json!("inactive"));
    assert_eq!(observed["artifact"]["disposition"], json!("pending"));
    assert_eq!(
        observed["artifact"]["resolved"],
        json!(false),
        "switching a routine off is an observation, never a cleanup"
    );
    assert!(observed["artifact"].get("source").is_none());
    assert_eq!(observed["changed"], json!(true));
    // Recording the same observation twice writes nothing.
    let (_, repeat) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &acknowledge_path(fixture.workspace, fixture.hosted.connection, &routine),
        json!({"currentStatus": "inactive"}),
    )
    .await;
    assert_eq!(repeat["changed"], json!(false));
    assert_eq!(
        audit_count(
            &su,
            fixture.workspace,
            "hosted_agent.connection.cleanup_artifact_acknowledged"
        )
        .await,
        2,
        "one audit for the connector decision, one for the routine observation"
    );

    // …and the terminal transition is refused while it is merely inactive.
    let (code, refused) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &complete_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    assert_eq!(code, 409, "{refused}");
    assert_eq!(
        connection_status(&su, fixture.workspace, fixture.hosted.connection).await,
        "cleanup_pending"
    );

    // ---- the kind/disposition table is enforced ----------------------------
    for (kind, disposition) in [
        ("local_plugin_files", "preserve"),
        ("plugin", "revoke"),
        ("secret", "delete"),
        ("bot", "revoke"),
    ] {
        let id = artifact_id(&manifest, kind);
        let (code, _) = post_json(
            &client,
            &base,
            &fixture.human_jwt,
            &acknowledge_path(fixture.workspace, fixture.hosted.connection, &id),
            json!({"currentStatus": "absent", "disposition": disposition, "evidence": "no"}),
        )
        .await;
        assert_eq!(code, 400, "{kind} must refuse {disposition}");
    }
    // A decision without evidence is refused before the transaction opens.
    let (code, _) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &acknowledge_path(fixture.workspace, fixture.hosted.connection, &files),
        json!({"currentStatus": "absent", "disposition": "delete"}),
    )
    .await;
    assert_eq!(code, 400, "a manual acknowledgement needs evidence");
    // An invalid observation vocabulary is refused too — `removed` is not a
    // status, and accepting it would let a status stand in for a decision.
    let (code, _) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &acknowledge_path(fixture.workspace, fixture.hosted.connection, &files),
        json!({"currentStatus": "removed"}),
    )
    .await;
    assert_eq!(code, 400);
    // A resolved artifact cannot be re-decided into the other answer.
    let (code, _) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &acknowledge_path(fixture.workspace, fixture.hosted.connection, &connector),
        json!({"currentStatus": "present", "disposition": "delete", "evidence": "again"}),
    )
    .await;
    assert_eq!(code, 409, "a resolution is not re-decidable");

    // ---- the bot's two terminals -------------------------------------------
    // preserve, on this connection: oort never deletes provider chat history.
    let bot = artifact_id(&manifest, "bot");
    let (code, preserved) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &acknowledge_path(fixture.workspace, fixture.hosted.connection, &bot),
        json!({
            "currentStatus": "present",
            "disposition": "preserve",
            "evidence": "kept so the chat history survives"
        }),
    )
    .await;
    assert_eq!(code, 200, "{preserved}");
    assert_eq!(preserved["artifact"]["disposition"], json!("preserved"));
    assert_eq!(
        preserved["artifact"]["resolved"],
        json!(true),
        "preserve is a legal terminal disposition"
    );

    // delete, on the sibling connection: the other legal answer.
    let (code, sibling_started) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &disconnect_path(fixture.workspace, fixture.sibling.connection),
        json!({}),
    )
    .await;
    assert_eq!(code, 200, "{sibling_started}");
    let sibling_manifest = sibling_started["cleanupArtifacts"].clone();
    let sibling_bot = artifact_id(&sibling_manifest, "bot");
    let (code, deleted) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &acknowledge_path(fixture.workspace, fixture.sibling.connection, &sibling_bot),
        json!({
            "currentStatus": "absent",
            "disposition": "delete",
            "evidence": "deleted by the owner, who was warned about the history"
        }),
    )
    .await;
    assert_eq!(code, 200, "{deleted}");
    assert_eq!(deleted["artifact"]["disposition"], json!("removed"));

    // Neither answer touched a single message row.
    let messages: i64 = sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id=$1")
        .bind(fixture.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(messages, 0, "no chat was created, and none was deleted");
}

// ---------------------------------------------------------------------------
// (3) the terminal transition: refused, then exactly once, then idempotent
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_terminal_transition_needs_every_artifact_and_then_happens_exactly_once() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app).await;
    let client = reqwest::Client::new();

    // Completing before a disconnect even starts is a 409, not a shortcut.
    let (code, _) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &complete_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    assert_eq!(code, 409);

    let (_, started) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &disconnect_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    let manifest = started["cleanupArtifacts"].clone();

    // One unresolved row is enough to refuse.
    for kind in ["bot", "routine", "plugin", "connector"] {
        let id = artifact_id(&manifest, kind);
        let (code, _) = post_json(
            &client,
            &base,
            &fixture.human_jwt,
            &acknowledge_path(fixture.workspace, fixture.hosted.connection, &id),
            json!({
                "currentStatus": "absent",
                "disposition": "delete",
                "evidence": "handled"
            }),
        )
        .await;
        assert_eq!(code, 200, "{kind}");
    }
    let (code, refused) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &complete_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    assert_eq!(
        code, 409,
        "the local files row alone refuses the terminal: {refused}"
    );
    assert_eq!(
        audit_count(
            &su,
            fixture.workspace,
            "hosted_agent.connection.disconnected"
        )
        .await,
        0
    );

    let files = artifact_id(&manifest, "local_plugin_files");
    let (code, _) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &acknowledge_path(fixture.workspace, fixture.hosted.connection, &files),
        json!({
            "currentStatus": "absent",
            "disposition": "delete",
            "evidence": "~/.provider/plugins removed by hand"
        }),
    )
    .await;
    assert_eq!(code, 200);

    let (code, terminal) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &complete_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    assert_eq!(code, 200, "{terminal}");
    assert_eq!(terminal["connection"]["status"], json!("disconnected"));
    assert_eq!(terminal["disconnectedNow"], json!(true));
    assert!(
        terminal["connection"].get("activeCredentialId").is_none(),
        "a terminal connection names no credential"
    );
    assert_eq!(
        audit_count(
            &su,
            fixture.workspace,
            "hosted_agent.connection.disconnected"
        )
        .await,
        1
    );

    // Replay: the same answer, no second transition, no second audit row.
    let (code, replay) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &complete_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    assert_eq!(code, 200, "{replay}");
    assert_eq!(replay["disconnectedNow"], json!(false));
    assert_eq!(replay["connection"]["status"], json!("disconnected"));
    assert_eq!(
        audit_count(
            &su,
            fixture.workspace,
            "hosted_agent.connection.disconnected"
        )
        .await,
        1,
        "the terminal transition happened exactly once"
    );

    // Starting a disconnect on a terminal connection is a conflict, not a
    // second lifecycle.
    let (code, _) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &disconnect_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    assert_eq!(code, 409);
    // …and so is acknowledging an artifact of a connection that already closed.
    let (code, _) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &acknowledge_path(
            fixture.workspace,
            fixture.hosted.connection,
            &artifact_id(&manifest, "plugin"),
        ),
        json!({"currentStatus": "absent"}),
    )
    .await;
    assert_eq!(code, 409);

    // The database refuses a false terminal even when the transition function
    // is bypassed entirely (migration 072's trigger).
    let forced = sqlx::query(
        "UPDATE hosted_agent_connection SET status='disconnected' \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.sibling.connection)
    .execute(&su)
    .await;
    assert!(
        forced.is_err(),
        "a direct UPDATE cannot mint a terminal state for an unstarted connection"
    );
}

// ---------------------------------------------------------------------------
// (3b) the terminal guard's four clauses, each proved by the failure it causes
//
// The clause that matters most here is the artifact one, and it is the one that
// was dead code until this test existed: `NOT EXISTS (… required AND NOT
// resolved)` is vacuously true on an empty manifest, so a connection that never
// ran a disconnect start walked straight through it. Each assertion below names
// the clause it trips, by message, because "the UPDATE failed" would pass
// against the wrong guard.
// ---------------------------------------------------------------------------

async fn terminal_refusal(pool: &PgPool, workspace: Uuid, connection: Uuid) -> String {
    let error = sqlx::query(
        "UPDATE hosted_agent_connection SET status='disconnected' \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .execute(pool)
    .await
    .expect_err("the terminal guard refuses this transition");
    error
        .as_database_error()
        .expect("a database error")
        .message()
        .to_string()
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_terminal_guard_names_the_clause_that_refused_the_transition() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app).await;
    let client = reqwest::Client::new();

    // (ii) the OLD.status gate — a `pairing_pending` connection cannot jump
    // straight to the terminal, however clean its local half looks.
    let jumper = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_challenge_hash, \
           pairing_expires_at,created_by) \
         VALUES($1,$2,$3,'pairing_pending',digest($4::text,'sha256'), \
           now() + interval '15 minutes',$5)",
    )
    .bind(jumper)
    .bind(fixture.workspace)
    .bind(fixture.spare_hosted_agent)
    .bind(format!(
        "momo_pair_v1.{}.{}",
        fixture.workspace,
        Uuid::new_v4().simple()
    ))
    .bind(fixture.human)
    .execute(&su)
    .await
    .expect("seed a pairing_pending connection");
    sqlx::query(
        "UPDATE agent_profile SET paused=true WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.spare_hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    assert_eq!(
        terminal_refusal(&su, fixture.workspace, jumper).await,
        "hosted connection cannot reach disconnected from pairing_pending",
        "the terminal has exactly one predecessor"
    );

    // (iii) the empty-manifest gate — `cleanup_pending` with zero rows is the
    // repair-script shape, and the unresolved-artifact clause cannot catch it
    // because there is nothing to be unresolved.
    sqlx::query(
        "UPDATE hosted_agent_connection \
            SET status='detected', pairing_consumed_at=now(), detected_at=now(), detected_by=$3 \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(jumper)
    .bind(fixture.spare_hosted_agent)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='cleanup_pending' \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(jumper)
    .execute(&su)
    .await
    .unwrap();
    assert_eq!(
        terminal_refusal(&su, fixture.workspace, jumper).await,
        "hosted connection has no cleanup artifact manifest",
        "an empty manifest is refused rather than read as fully resolved"
    );
    // …and the HTTP route refuses the same row for the same reason, so Rust and
    // the database state one contract rather than two.
    let (code, refused) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &complete_path(fixture.workspace, jumper),
        json!({}),
    )
    .await;
    assert_eq!(code, 409, "{refused}");
    assert_eq!(
        connection_status(&su, fixture.workspace, jumper).await,
        "cleanup_pending"
    );

    // (i) the unresolved-artifact clause, on a connection that really did start
    // a disconnect. This is the assertion that was impossible before the
    // empty-manifest gate existed: with rows present, the clause has something
    // to judge and names itself when it refuses.
    let (_, started) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &disconnect_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    let manifest = started["cleanupArtifacts"].clone();
    for kind in ["bot", "routine", "plugin", "connector"] {
        let id = artifact_id(&manifest, kind);
        let (code, _) = post_json(
            &client,
            &base,
            &fixture.human_jwt,
            &acknowledge_path(fixture.workspace, fixture.hosted.connection, &id),
            json!({"currentStatus": "absent", "disposition": "delete", "evidence": "handled"}),
        )
        .await;
        assert_eq!(code, 200, "{kind}");
    }
    // Exactly one required row is left: `local_plugin_files`.
    assert_eq!(
        terminal_refusal(&su, fixture.workspace, fixture.hosted.connection).await,
        "hosted connection has unresolved required cleanup artifacts",
        "the artifact clause refuses, and it is the artifact clause that says so"
    );

    // Resolve it, and the same direct UPDATE now trips the credential clause
    // instead only if the local half were undone — it is not, so the transition
    // is permitted. Ordering the clauses this way proves each is reachable.
    let files = artifact_id(&manifest, "local_plugin_files");
    let (code, _) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &acknowledge_path(fixture.workspace, fixture.hosted.connection, &files),
        json!({"currentStatus": "absent", "disposition": "delete", "evidence": "removed by hand"}),
    )
    .await;
    assert_eq!(code, 200);
    sqlx::query("UPDATE token SET revoked_at=NULL WHERE workspace_id=$1 AND id=$2")
        .bind(fixture.workspace)
        .bind(fixture.hosted.token)
        .execute(&su)
        .await
        .unwrap();
    assert_eq!(
        terminal_refusal(&su, fixture.workspace, fixture.hosted.connection).await,
        "hosted connection still has a live credential",
        "a resurrected credential refuses the terminal even with a clean manifest"
    );
    sqlx::query("UPDATE token SET revoked_at=now() WHERE workspace_id=$1 AND id=$2")
        .bind(fixture.workspace)
        .bind(fixture.hosted.token)
        .execute(&su)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE agent_profile SET paused=false WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted.agent)
    .execute(&su)
    .await
    .unwrap();
    assert_eq!(
        terminal_refusal(&su, fixture.workspace, fixture.hosted.connection).await,
        "hosted connection agent is not paused",
        "an unpaused agent refuses the terminal too"
    );

    // With every clause satisfied the route completes, which is what makes the
    // four refusals above statements about the guard rather than about a
    // connection that could never have finished anyway.
    sqlx::query(
        "UPDATE agent_profile SET paused=true WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted.agent)
    .execute(&su)
    .await
    .unwrap();
    let (code, terminal) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &complete_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    assert_eq!(code, 200, "{terminal}");
    assert_eq!(terminal["connection"]["status"], json!("disconnected"));
}

// ---------------------------------------------------------------------------
// (4) reconnect is a new namespace; the old one keeps failing
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_reconnect_is_a_new_namespace_and_never_revives_the_old_one() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app).await;
    let client = reqwest::Client::new();

    let handle = mention_and_claim(&client, &base, &su, &fixture, &fixture.hosted).await;
    let (status, cursor_page) = call(
        &client,
        &base,
        &fixture.hosted.bearer,
        "oort_inbox_read",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200);
    let old_cursor = structured(&cursor_page)["nextCursor"]
        .as_str()
        .expect("a sealed cursor")
        .to_string();
    let old_bearer = fixture.hosted.bearer.clone();

    let (_, started) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &disconnect_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    resolve_manifest(
        &client,
        &base,
        &fixture,
        fixture.hosted.connection,
        &started["cleanupArtifacts"],
        "preserve",
    )
    .await;
    let (code, _) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &complete_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    assert_eq!(code, 200);

    // A new pairing on the same dedicated agent: a new connection id, a new
    // credential, a new cursor namespace. The live-uniqueness index permits it
    // only because the old connection is terminal.
    let reconnected = activate_hosted(
        &su,
        fixture.workspace,
        fixture.human,
        fixture.hosted.agent,
        fixture.channel,
    )
    .await;
    assert_ne!(reconnected.connection, fixture.hosted.connection);
    assert_ne!(reconnected.token, fixture.hosted.token);
    sqlx::query(
        "UPDATE agent_profile SET paused=false WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted.agent)
    .execute(&su)
    .await
    .unwrap();

    let (status, tools) = list_tools(&client, &base, &reconnected.bearer).await;
    assert_eq!(status, 200);
    assert_eq!(tools, PRODUCT_TOOLS.to_vec(), "the new era is fully open");

    // Everything from the old era stays dead.
    let (status, _) = list_tools(&client, &base, &old_bearer).await;
    assert_eq!(status, 401, "the old credential is not revived");
    // The transport admits the new credential; the sealed handle is judged
    // after that, inside the tool's own transaction, and it names the old
    // connection — so the refusal is the tool layer's `NotAuthorized`, not a
    // transport 401.
    let (status, renewed) = call(
        &client,
        &base,
        &reconnected.bearer,
        "oort_job_renew",
        json!({"leaseHandle": handle}),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(
        renewed["error"]["code"],
        json!(-32003),
        "a handle sealed to the old connection is not authorized in the new one"
    );
    let (_, replayed_cursor) = call(
        &client,
        &base,
        &reconnected.bearer,
        "oort_inbox_read",
        json!({"cursor": old_cursor}),
    )
    .await;
    assert_eq!(
        replayed_cursor["error"]["code"],
        json!(-32004),
        "the old cursor does not open in the new namespace"
    );
    assert_eq!(
        connection_status(&su, fixture.workspace, fixture.hosted.connection).await,
        "disconnected",
        "the old connection stays terminal"
    );
}

// ---------------------------------------------------------------------------
// (5) concurrency, reconciliation and the atomic rollback
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_disconnect_racing_a_claim_produces_one_serial_outcome() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app).await;
    let client = reqwest::Client::new();

    // Enough work that a claim has something to take.
    for _ in 0..3 {
        let _ = mention_and_claim(&client, &base, &su, &fixture, &fixture.hosted).await;
        sqlx::query(
            "UPDATE outbox SET lease_owner=NULL, lease_acquired_at=NULL, lease_expires_at=NULL \
              WHERE workspace_id=$1 AND partition_key=$2",
        )
        .bind(fixture.workspace)
        .bind(fixture.hosted.agent)
        .execute(&su)
        .await
        .unwrap();
    }

    let disconnect = {
        let client = client.clone();
        let base = base.clone();
        let jwt = fixture.human_jwt.clone();
        let path = disconnect_path(fixture.workspace, fixture.hosted.connection);
        tokio::spawn(async move { post_json(&client, &base, &jwt, &path, json!({})).await })
    };
    let claim = {
        let client = client.clone();
        let base = base.clone();
        let bearer = fixture.hosted.bearer.clone();
        tokio::spawn(async move {
            call(
                &client,
                &base,
                &bearer,
                "oort_jobs_claim",
                json!({"limit": 10}),
            )
            .await
        })
    };
    let (disconnect_result, claim_result) = tokio::join!(disconnect, claim);
    let (disconnect_status, _) = disconnect_result.expect("disconnect task");
    let (claim_status, claimed) = claim_result.expect("claim task");
    assert_eq!(
        disconnect_status, 200,
        "the disconnect always wins its own row"
    );

    // Three serial outcomes are legal and nothing else is, because the claim
    // takes `FOR SHARE` on the connection inside its own transaction and the
    // disconnect takes `FOR UPDATE` on the same row:
    //   * 200 — the claim's whole transaction committed first, and the
    //     disconnect then waited for it and suppressed what it handed out;
    //   * 403 — the transport admitted the still-live bearer, and the tool's
    //     own re-read found the connection already `cleanup_pending`;
    //   * 401 — the disconnect committed before the transport read the token.
    // No interleaving can produce a live lease, which is what the invariants
    // below assert exactly.
    assert!(
        matches!(claim_status, 200 | 401 | 403),
        "claim answered {claim_status}"
    );
    if claim_status == 200 {
        let jobs = structured(&claimed)["jobs"].as_array().expect("jobs array");
        assert!(jobs.len() <= 3);
    }
    let (pending, leased): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE status='pending'), \
                count(*) FILTER (WHERE lease_owner IS NOT NULL) \
           FROM outbox WHERE workspace_id=$1 AND kind='agent_job' AND partition_key=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted.agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(pending, 0, "no job survives the disconnect claimable");
    assert_eq!(leased, 0, "no lease survives the disconnect");
    assert_eq!(
        connection_status(&su, fixture.workspace, fixture.hosted.connection).await,
        "cleanup_pending"
    );
    assert_eq!(
        audit_count(
            &su,
            fixture.workspace,
            "hosted_agent.connection.disconnect_started"
        )
        .await,
        1,
        "one disconnect, one audit row, whichever order the race took"
    );

    // A claim after the commit is refused every time, not intermittently, and
    // by the transport rather than the tool: the bearer itself is revoked.
    for _ in 0..3 {
        let (status, _) = call(
            &client,
            &base,
            &fixture.hosted.bearer,
            "oort_jobs_claim",
            json!({}),
        )
        .await;
        assert_eq!(status, 401);
    }
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_emergency_revoked_credential_is_reconciled_by_the_first_domain_guard() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app).await;
    let client = reqwest::Client::new();

    let _ = mention_and_claim(&client, &base, &su, &fixture, &fixture.hosted).await;

    // The generic credential surface refuses to touch a hosted member at all,
    // so this split state can only be produced out of band — which is exactly
    // the operator emergency-revoke the reconciliation exists for.
    for (path, body_json) in [
        (
            format!(
                "/v1/workspaces/{}/agents/{}/credentials",
                fixture.workspace, fixture.hosted.agent
            ),
            json!({"scopes": ["messages:write"]}),
        ),
        (
            format!(
                "/v1/workspaces/{}/agents/{}/credentials/{}/revoke",
                fixture.workspace, fixture.hosted.agent, fixture.hosted.token
            ),
            json!({"reason": "operator emergency"}),
        ),
    ] {
        let (status, body) = post_json(&client, &base, &fixture.human_jwt, &path, body_json).await;
        assert_eq!(status, 409, "{path}");
        assert_eq!(
            body["error"]["message"],
            json!("hosted_connection_managed"),
            "{path}"
        );
    }

    sqlx::query("UPDATE token SET revoked_at=now() WHERE workspace_id=$1 AND id=$2")
        .bind(fixture.workspace)
        .bind(fixture.hosted.token)
        .execute(&su)
        .await
        .unwrap();
    assert_eq!(
        connection_status(&su, fixture.workspace, fixture.hosted.connection).await,
        "active",
        "the split state before any guard has looked"
    );

    // The first domain guard reconciles it — fail-closed, before any capability
    // runs, in one transaction.
    let (status, _) = list_tools(&client, &base, &fixture.hosted.bearer).await;
    assert_eq!(status, 401);
    assert_eq!(
        connection_status(&su, fixture.workspace, fixture.hosted.connection).await,
        "cleanup_pending"
    );
    assert!(paused(&su, fixture.workspace, fixture.hosted.agent).await);
    let (pending, leased): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE status='pending'), \
                count(*) FILTER (WHERE lease_owner IS NOT NULL) \
           FROM outbox WHERE workspace_id=$1 AND kind='agent_job' AND partition_key=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted.agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!((pending, leased), (0, 0), "open work is suppressed too");
    let manifest_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_agent_connection_artifact WHERE workspace_id=$1 \
           AND connection_id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.hosted.connection)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        manifest_rows, 6,
        "the manifest is seeded by the reconcile too"
    );
    assert_eq!(
        audit_count(
            &su,
            fixture.workspace,
            "hosted_agent.connection.disconnect_started"
        )
        .await,
        1
    );
    let trigger: String = sqlx::query_scalar(
        "SELECT detail->>'trigger' FROM audit_log WHERE workspace_id=$1 \
           AND action='hosted_agent.connection.disconnect_started'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(trigger, "credential_invalidated");

    // A second call finds `cleanup_pending` and does not reconcile again.
    let (status, _) = list_tools(&client, &base, &fixture.hosted.bearer).await;
    assert_eq!(status, 401);
    assert_eq!(
        audit_count(
            &su,
            fixture.workspace,
            "hosted_agent.connection.disconnect_started"
        )
        .await,
        1,
        "reconciliation is idempotent"
    );

    // The sibling connection is untouched: the revoke was connection-scoped.
    assert_eq!(
        live_credential_count(&su, fixture.workspace, fixture.sibling.connection).await,
        1
    );
    let (status, _) = list_tools(&client, &base, &fixture.sibling.bearer).await;
    assert_eq!(status, 200);
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_failed_disconnect_rolls_every_effect_back() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(app).await;
    let client = reqwest::Client::new();

    // Remove the profile row the pause writes. The revoke runs first, so if the
    // transaction were not atomic the credential would already be dead while
    // the connection still said `active`.
    sqlx::query("DELETE FROM agent_profile WHERE workspace_id=$1 AND agent_member_id=$2")
        .bind(fixture.workspace)
        .bind(fixture.hosted.agent)
        .execute(&su)
        .await
        .unwrap();

    let (code, _) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &disconnect_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    assert_eq!(code, 500, "a disconnect that cannot pause must fail");

    assert_eq!(
        connection_status(&su, fixture.workspace, fixture.hosted.connection).await,
        "active",
        "the transition rolled back"
    );
    assert_eq!(
        live_credential_count(&su, fixture.workspace, fixture.hosted.connection).await,
        1,
        "the revoke rolled back with it"
    );
    let artifacts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_agent_connection_artifact WHERE workspace_id=$1",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(artifacts, 0, "no manifest was seeded");
    assert_eq!(
        audit_count(
            &su,
            fixture.workspace,
            "hosted_agent.connection.disconnect_started"
        )
        .await,
        0,
        "and no audit row claims it happened"
    );
}

// ---------------------------------------------------------------------------
// (6) the disconnect surface is non-enumerable off its own principal
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_disconnect_surface_is_non_enumerable_off_its_own_workspace_and_principal() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let foreign = seed(&su).await;
    let base = start_server(app).await;
    let client = reqwest::Client::new();

    // An ordinary member of the right workspace: forbidden, and told nothing.
    let (code, _) = post_json(
        &client,
        &base,
        &fixture.ordinary_jwt,
        &disconnect_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    assert_eq!(code, 403);

    // An admin of another workspace, naming this connection: the workspace scope
    // refuses before the connection is ever looked up.
    let (code, _) = post_json(
        &client,
        &base,
        &foreign.human_jwt,
        &disconnect_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    assert!(
        matches!(code, 403 | 404),
        "cross-workspace answer was {code}"
    );

    // A connection id that does not exist and one that belongs to another
    // workspace answer identically inside this workspace.
    for connection in [Uuid::new_v4(), foreign.hosted.connection] {
        let (code, _) = post_json(
            &client,
            &base,
            &fixture.human_jwt,
            &disconnect_path(fixture.workspace, connection),
            json!({}),
        )
        .await;
        assert_eq!(code, 404, "absent and foreign are the same answer");
    }

    // The agent's own bearer cannot disconnect itself: this is a human surface.
    let (code, _) = post_json(
        &client,
        &base,
        &fixture.hosted.bearer,
        &disconnect_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    assert!(matches!(code, 401 | 403), "agent bearer answer was {code}");

    // An artifact of another connection is not addressable through this one.
    let (_, started) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &disconnect_path(fixture.workspace, fixture.hosted.connection),
        json!({}),
    )
    .await;
    let (_, sibling_started) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &disconnect_path(fixture.workspace, fixture.sibling.connection),
        json!({}),
    )
    .await;
    let foreign_artifact = artifact_id(&sibling_started["cleanupArtifacts"], "plugin");
    let (code, _) = post_json(
        &client,
        &base,
        &fixture.human_jwt,
        &acknowledge_path(
            fixture.workspace,
            fixture.hosted.connection,
            &foreign_artifact,
        ),
        json!({"currentStatus": "absent", "disposition": "delete", "evidence": "not mine"}),
    )
    .await;
    assert_eq!(code, 404);
    assert_eq!(
        started["cleanupArtifacts"].as_array().unwrap().len(),
        6,
        "each connection owns its own manifest"
    );

    // The foreign workspace's connection never moved.
    assert_eq!(
        connection_status(&su, foreign.workspace, foreign.hosted.connection).await,
        "active"
    );
}

// ---------------------------------------------------------------------------
// (7) #1374 — the lifecycle invalidation never reaches past its own connection
// ---------------------------------------------------------------------------

/// A retired (`expired`) connection for `agent` whose hosted credential was
/// never revoked.
///
/// This is the only row shape a member-scoped revocation could reach and a
/// connection-scoped one cannot, so it is the row the adversary below holds. It
/// is legal beside a live connection precisely because migration 069's partial
/// unique index (`hosted_agent_connection_workspace_agent_live_uniq`) excludes
/// `expired`/`disconnected` — which is also why "the agent's other **live**
/// connection", the shape #1374 was first written against, is not a state this
/// schema can hold.
async fn seed_retired_connection(
    pool: &PgPool,
    workspace: Uuid,
    human: Uuid,
    agent: Uuid,
) -> (Uuid, Uuid) {
    let connection = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection(id,workspace_id,agent_member_id,status,created_by) \
         VALUES($1,$2,$3,'expired',$4)",
    )
    .bind(connection)
    .bind(workspace)
    .bind(agent)
    .bind(human)
    .execute(pool)
    .await
    .expect("seed retired connection");
    let raw = raw_credential(workspace);
    let token = insert_hosted_token(pool, workspace, agent, connection, &raw, human).await;
    (connection, token)
}

/// The agent's ONE live connection, `detected` and confirmed, whose
/// `active_token_id` has been revoked out from under it.
///
/// That is exactly the state whose prove takes the invalidation branch — the
/// branch that runs while holding `member` and `workspace_membership`
/// `FOR UPDATE`, and the reason #1374 is filed against the prove path rather
/// than against detect/resolve/confirm/expire-stale (all of which reach the
/// same invalidation holding nothing but their own connection row).
async fn seed_detected_connection_with_dead_credential(
    pool: &PgPool,
    workspace: Uuid,
    human: Uuid,
    agent: Uuid,
    channel: Uuid,
) -> (Uuid, Uuid) {
    let connection = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_challenge_hash,pairing_expires_at, \
           pairing_consumed_at,detected_at,detected_by,confirmed_by,confirmed_at, \
           approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,$3,'detected',digest($4::text,'sha256'),now() + interval '15 minutes', \
                now(),now(),$5,$5,now(),$6, \
                ARRAY['agent:port:connect','agent:inbox:read','messages:read','messages:write', \
                      'agent:jobs:read','agent:runs:callback']::text[],$5)",
    )
    .bind(connection)
    .bind(workspace)
    .bind(agent)
    .bind(raw_credential(workspace))
    .bind(human)
    .bind(vec![channel])
    .execute(pool)
    .await
    .expect("seed detected connection");
    let raw = raw_credential(workspace);
    let token = insert_hosted_token(pool, workspace, agent, connection, &raw, human).await;
    sqlx::query(
        "UPDATE hosted_agent_connection SET active_token_id=$3 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .bind(token)
    .execute(pool)
    .await
    .expect("bind the connection's active credential");
    sqlx::query("UPDATE token SET revoked_at=now() WHERE workspace_id=$1 AND id=$2")
        .bind(workspace)
        .bind(token)
        .execute(pool)
        .await
        .expect("revoke the credential out from under the connection");
    (connection, token)
}

/// Park until `pid` is actually waiting on a lock.
///
/// This is a condition poll on an observable server state, not a timing guess:
/// nothing is asserted until PostgreSQL itself reports the adversary blocked,
/// so the interleaving the test claims is the interleaving it gets. The bound
/// exists only so a broken fixture fails loudly instead of hanging the suite.
async fn await_lock_wait(su: &PgPool, pid: i32) {
    for _ in 0..600 {
        let waiting: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity \
                             WHERE pid=$1 AND wait_event_type='Lock')",
        )
        .bind(pid)
        .fetch_one(su)
        .await
        .expect("read pg_stat_activity");
        if waiting {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("the adversary never blocked on the member row");
}

/// The AB-BA #1374 tracks, driven from both ends at once.
///
/// T1 is a real `prove_hosted_binding_in_tx` that fails its credential probe and
/// therefore invalidates, holding `member` and `workspace_membership`
/// `FOR UPDATE` while it does. Its first two statements are pre-run here on the
/// same connection so the interleaving is deterministic — they are prove's own
/// (`hosted_connection.rs`, member then workspace_membership), so T1 enters the
/// invalidation in exactly the lock state production reaches it in.
///
/// T2 holds the agent's OTHER hosted credential `FOR SHARE` and then asks for
/// the member row — `token → member`, the order every inbox and tool statement
/// takes as `FOR SHARE OF hc,t,m,wm,ap,cm`. It plays those two rowmarks rather
/// than calling an inbox append, because an append reaches a credential only
/// through an `active` connection while this agent's live connection is
/// `detected` for as long as its prove is failing — the literal pair cannot be
/// stood up at once, which is itself the reason the repair had to be the
/// invalidation's *reach* rather than the probe order.
///
/// With a member-scoped revocation T1 asks for T2's token after T2 has asked for
/// T1's member row and PostgreSQL breaks the cycle with 40P01. With the
/// connection-scoped one, T1's write set never leaves its own connection, so the
/// two transactions simply serialize.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_failing_prove_never_reaches_a_sibling_connections_credential() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let workspace = fixture.workspace;
    let agent = fixture.spare_hosted_agent;

    let (retired, retired_token) =
        seed_retired_connection(&su, workspace, fixture.human, agent).await;
    let (pending, pending_token) = seed_detected_connection_with_dead_credential(
        &su,
        workspace,
        fixture.human,
        agent,
        fixture.channel,
    )
    .await;

    let (pid_tx, pid_rx) = tokio::sync::oneshot::channel::<i32>();
    let (held_tx, held_rx) = tokio::sync::oneshot::channel::<()>();

    let adversary = tokio::spawn({
        let app = app.clone();
        async move {
            held_rx.await.expect("T1 takes the member row first");
            with_tenant_tx(&app, workspace, move |conn| {
                Box::pin(async move {
                    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                        .fetch_one(&mut *conn)
                        .await?;
                    pid_tx.send(pid).expect("hand T1 the adversary's backend");
                    let _token: Option<i32> = sqlx::query_scalar(
                        "SELECT 1 FROM token WHERE workspace_id=$1 AND id=$2 FOR SHARE",
                    )
                    .bind(workspace)
                    .bind(retired_token)
                    .fetch_optional(&mut *conn)
                    .await?;
                    // Parks here, behind T1's FOR UPDATE, exactly where an inbox
                    // append parks between its `t` and `m` rowmarks.
                    let _member: Option<i32> = sqlx::query_scalar(
                        "SELECT 1 FROM member WHERE workspace_id=$1 AND id=$2 FOR SHARE",
                    )
                    .bind(workspace)
                    .bind(agent)
                    .fetch_optional(&mut *conn)
                    .await?;
                    Ok(())
                })
            })
            .await
        }
    });

    let identity = AgentBearerIdentity {
        token_id: pending_token,
        member_id: agent,
        workspace_id: workspace,
        scopes: HOSTED_SCOPES
            .iter()
            .map(|scope| scope.to_string())
            .collect(),
        hosted_connection_id: Some(pending),
        audience: Some(AUDIENCE.to_string()),
    };
    let watcher = su.clone();
    let proof = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            let _member: Option<i32> = sqlx::query_scalar(
                "SELECT 1 FROM member WHERE workspace_id=$1 AND id=$2 AND kind='agent' \
                   AND status='active' AND deleted_at IS NULL FOR UPDATE",
            )
            .bind(workspace)
            .bind(agent)
            .fetch_optional(&mut *conn)
            .await?;
            let _membership: Option<i32> = sqlx::query_scalar(
                "SELECT 1 FROM workspace_membership WHERE workspace_id=$1 AND member_id=$2 \
                 FOR UPDATE",
            )
            .bind(workspace)
            .bind(agent)
            .fetch_optional(&mut *conn)
            .await?;
            held_tx.send(()).expect("release the adversary");
            let pid = pid_rx.await.expect("the adversary's backend");
            await_lock_wait(&watcher, pid).await;
            Ok(momo_auth::prove_hosted_binding_in_tx(conn, &identity, true).await?)
        })
    })
    .await
    .expect("the failing prove commits instead of deadlocking");
    assert_eq!(proof, momo_auth::HostedProof::Rejected);
    adversary
        .await
        .expect("adversary task")
        .expect("the adversary commits instead of deadlocking");

    // The connection this prove was for is fully retired…
    assert_eq!(connection_status(&su, workspace, pending).await, "expired");
    assert_eq!(live_credential_count(&su, workspace, pending).await, 0);
    assert!(paused(&su, workspace, agent).await);

    // …and the sibling connection's credential is untouched, which is the whole
    // point: the write set stopped at the connection the caller had locked.
    assert_eq!(live_credential_count(&su, workspace, retired).await, 1);
    assert_eq!(connection_status(&su, workspace, retired).await, "expired");

    // Untouched is not the same as usable. The surviving credential names a
    // connection that is not `detected`/`active` and is not its
    // `active_token_id`, so the prove guard refuses it — which is why narrowing
    // the revocation costs no capability.
    let sibling_identity = AgentBearerIdentity {
        token_id: retired_token,
        member_id: agent,
        workspace_id: workspace,
        scopes: HOSTED_SCOPES
            .iter()
            .map(|scope| scope.to_string())
            .collect(),
        hosted_connection_id: Some(retired),
        audience: Some(AUDIENCE.to_string()),
    };
    let refused = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            Ok(momo_auth::prove_hosted_binding_in_tx(conn, &sibling_identity, true).await?)
        })
    })
    .await
    .expect("prove the surviving credential");
    assert_eq!(refused, momo_auth::HostedProof::Rejected);
}
