//! ADR-0162 증보 3 D10 (#3515 AT-2) — a work request (`POST …/agent-runs`) to a
//! hosted agent, end to end through the real Axum router on a `momo_app`
//! (NOBYPASSRLS) pool.
//!
//! | test | proves |
//! |---|---|
//! | `a_hosted_agent_takes_a_work_request_as_run_job_and_inbox_item` | 201; run queued; ONE gateway job (payload run/author); ONE inbox reference; no wake broadcast; requester recorded (audit actor, job payload, idempotency key); replay = 200 and no second job; the agent claims it with `oort_jobs_claim` |
//! | `every_d10_condition_refuses_with_409_and_writes_nothing` | connection not active/proved, expired, paused, channel not approved → 409 + code, 0 run/job/inbox/audit rows; control: all restored → 201 |
//! | `a_closed_instance_gate_refuses_hosted_work_requests` | HAP-E6 gate closed → 409, 0 rows; same fixture open → 201 |
//! | `a_non_member_requester_is_refused_before_anything_is_written` | requester not an active channel member → 403, 0 rows |
//! | `owner_only_stays_refused_even_with_an_active_approved_connection` | D10 4 |
//! | `a_paused_claude_subscription_agent_is_still_refused_first` | D10 5 / ADR-0193 D18 |
//! | `managed_agents_keep_their_gateway_rules_and_leave_no_orphan_run` | gateway check moved after the agent load: worker mode still 409 for a managed agent, gateway mode still 201 + wake broadcast; paused / cap refusals roll their run back |
//!
//! Run through `scripts/verify_agent_port_tools.sh` so the database is isolated.

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

const TEST_JWT_SECRET: &str = "hosted-work-request-pg-conformance-signing-secret";
const MODERN_VERSION: &str = "2026-07-28";
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

struct Knobs {
    hosted_delivery_enabled: bool,
    gateway_mode: bool,
    claude_subscription_agents_enabled: bool,
}

impl Knobs {
    /// Hosted delivery open, managed gateway on, Claude subscription agents on.
    fn open() -> Self {
        Knobs {
            hosted_delivery_enabled: true,
            gateway_mode: true,
            claude_subscription_agents_enabled: true,
        }
    }
}

async fn start_server(pool: PgPool, knobs: Knobs) -> String {
    let mut state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
    if knobs.gateway_mode {
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
        hosted_delivery_enabled: knobs.hosted_delivery_enabled,
        subscription_agents_enabled: true,
        // #3397: these suites drive Claude subscription agents; the opt-in is on.
        claude_subscription_agents_enabled: knobs.claude_subscription_agents_enabled,
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
    #[allow(dead_code)]
    connect_only_bearer: String,
    managed_agent: Uuid,
    #[allow(dead_code)]
    connect_only_agent: Uuid,
    channel: Uuid,
    private_channel: Uuid,
    /// A workspace human who is in NO channel.
    outsider_jwt: String,
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

    let outsider = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human','Outsider',$3)",
    )
    .bind(outsider)
    .bind(workspace)
    .bind(format!("outsider-{}", outsider.simple()))
    .execute(pool)
    .await
    .expect("seed outsider");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(outsider)
    .bind(workspace)
    .bind(format!("{outsider}@tools.test"))
    .execute(pool)
    .await
    .expect("seed outsider identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
    )
    .bind(workspace)
    .bind(outsider)
    .execute(pool)
    .await
    .expect("seed outsider membership");
    let outsider_jwt = momo_auth::sign_access(outsider, workspace, &[], TEST_JWT_SECRET)
        .expect("sign an outsider App JWT")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'hosted-work')",
    )
    .bind(workspace)
    .bind(outsider)
    .bind(&outsider_jwt)
    .execute(pool)
    .await
    .expect("record the outsider session token");

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
        outsider_jwt,
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

fn structured(value: &Value) -> &Value {
    &value["result"]["structuredContent"]
}

// ---------------------------------------------------------------------------
// work-request helpers
// ---------------------------------------------------------------------------

/// Everything a work request could have written, workspace-wide. A refusal must
/// leave this unchanged: "409 with no run / job / inbox / audit row".
#[derive(Debug, PartialEq, Eq)]
struct Snapshot {
    runs: i64,
    outbox: i64,
    inbox: i64,
    audit: i64,
}

async fn snapshot(su: &PgPool, workspace: Uuid) -> Snapshot {
    let count = |sql: &'static str| {
        let su = su.clone();
        async move {
            sqlx::query_scalar::<_, i64>(sql)
                .bind(workspace)
                .fetch_one(&su)
                .await
                .expect("count")
        }
    };
    Snapshot {
        runs: count("SELECT count(*) FROM agent_run WHERE workspace_id=$1").await,
        outbox: count("SELECT count(*) FROM outbox WHERE workspace_id=$1").await,
        inbox: count("SELECT count(*) FROM hosted_agent_inbox_event WHERE workspace_id=$1").await,
        audit: count(
            "SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND action='agent.work.queued'",
        )
        .await,
    }
}

async fn post_run(
    client: &reqwest::Client,
    base: &str,
    f: &Fixture,
    jwt: &str,
    channel: Uuid,
    agent: Uuid,
    client_run_id: Uuid,
) -> (u16, Value) {
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{channel}/agent-runs",
            f.workspace
        ))
        .bearer_auth(jwt)
        .json(&json!({
            "agent_member_id": agent,
            "client_run_id": client_run_id,
            "input": {"type": "work", "title": "PR 정리", "brief": "열린 PR을 정리해 주세요"},
        }))
        .send()
        .await
        .expect("agent-runs responds");
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    (status, body)
}

/// Assert a refusal: the status, the (optional) machine code, and that nothing
/// anywhere was written.
async fn assert_refused(
    su: &PgPool,
    f: &Fixture,
    outcome: (u16, Value),
    status: u16,
    code: Option<&str>,
    before: &Snapshot,
    why: &str,
) {
    assert_eq!(outcome.0, status, "{why}: {}", outcome.1);
    if let Some(code) = code {
        assert_eq!(
            outcome.1["error"]["code"],
            json!(code),
            "{why}: {}",
            outcome.1
        );
    }
    assert_eq!(
        &snapshot(su, f.workspace).await,
        before,
        "{why}: a refused work request wrote rows"
    );
}

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3515)"]
async fn a_hosted_agent_takes_a_work_request_as_run_job_and_inbox_item() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    // Worker mode: a hosted agent never consults the managed gateway (the
    // mention selector's rule), so the request must work with the gateway OFF.
    let base = start_server(
        momo_app_pool().await,
        Knobs {
            gateway_mode: false,
            ..Knobs::open()
        },
    )
    .await;
    let client = reqwest::Client::new();
    let run_key = Uuid::new_v4();

    let (status, run) = post_run(
        &client,
        &base,
        &f,
        &f.human_jwt,
        f.channel,
        f.hosted_agent,
        run_key,
    )
    .await;
    assert_eq!(status, 201, "{run}");
    let run_id: Uuid = run["id"].as_str().expect("run id").parse().unwrap();
    assert_eq!(run["status"], json!("queued"));

    // The run, queued, against the hosted agent in the requested channel.
    let (agent, channel, state, key): (Uuid, Uuid, String, String) = sqlx::query_as(
        "SELECT agent_member_id, channel_id, status::text, idempotency_key \
           FROM agent_run WHERE workspace_id=$1 AND id=$2",
    )
    .bind(f.workspace)
    .bind(run_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        (agent, channel, state.as_str()),
        (f.hosted_agent, f.channel, "queued")
    );
    // D14 depends on the requester: it is part of the run's idempotency key …
    assert!(
        key.contains(&f.human.to_string().to_uppercase()),
        "the work idempotency key names the requester: {key}"
    );

    // … of the ONE gateway job's payload …
    let jobs: Vec<(i64, String, Value)> = sqlx::query_as(
        "SELECT id, method, payload FROM outbox \
          WHERE workspace_id=$1 AND kind='agent_job' AND partition_key=$2",
    )
    .bind(f.workspace)
    .bind(f.hosted_agent)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(jobs.len(), 1, "exactly one job: {jobs:?}");
    assert_eq!(jobs[0].1, "gateway");
    assert_eq!(jobs[0].2["run_id"], json!(run_id.to_string()));
    assert_eq!(jobs[0].2["author_member_id"], json!(f.human.to_string()));
    assert_eq!(jobs[0].2["channel_id"], json!(f.channel.to_string()));

    // … and of the durable audit row, written by the requester about the agent.
    let (actor, subject, audit_run): (Uuid, Uuid, Uuid) = sqlx::query_as(
        "SELECT actor_member_id, subject_member_id, run_id FROM audit_log \
          WHERE workspace_id=$1 AND action='agent.work.queued'",
    )
    .bind(f.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        (actor, subject, audit_run),
        (f.human, f.hosted_agent, run_id)
    );

    // The hosted doorbell: ONE inbox reference to that job on that connection,
    // and no managed wake broadcast on the agent's partition key.
    let inbox: Vec<(Uuid, String, Option<i64>, Option<Uuid>)> = sqlx::query_as(
        "SELECT connection_id, event_kind, source_outbox_id, source_run_id \
           FROM hosted_agent_inbox_event WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(f.workspace)
    .bind(f.hosted_agent)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(
        inbox,
        vec![(
            f.hosted_connection,
            "agent_job".to_string(),
            Some(jobs[0].0),
            Some(run_id)
        )]
    );
    let wake: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='broadcast' AND partition_key=$2",
    )
    .bind(f.workspace)
    .bind(f.hosted_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        wake, 0,
        "a hosted job is not announced on the managed wake channel"
    );

    // A retry of the same request is the same run: 200, no second job or inbox row.
    let before = snapshot(&su, f.workspace).await;
    let (status, replay) = post_run(
        &client,
        &base,
        &f,
        &f.human_jwt,
        f.channel,
        f.hosted_agent,
        run_key,
    )
    .await;
    assert_eq!(status, 200, "{replay}");
    assert_eq!(replay["id"], run["id"]);
    assert_eq!(snapshot(&su, f.workspace).await, before);

    // The agent itself picks the work up through the Agent Port.
    let (status, claimed) = call(
        &client,
        &base,
        &f.hosted_bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(status, 200, "{claimed}");
    let claimed_jobs = structured(&claimed)["jobs"].as_array().expect("jobs");
    assert_eq!(claimed_jobs.len(), 1, "{claimed}");
    assert_eq!(
        claimed_jobs[0]["work"]["channelId"],
        json!(f.channel.to_string())
    );
}

// ---------------------------------------------------------------------------
// D10: every condition refuses with 409 and writes nothing
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3515)"]
async fn every_d10_condition_refuses_with_409_and_writes_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, Knobs::open()).await;
    let client = reqwest::Client::new();
    let before = snapshot(&su, f.workspace).await;
    let ask = |channel: Uuid| {
        let (client, base, f_ws, jwt) = (
            client.clone(),
            base.clone(),
            f.workspace,
            f.human_jwt.clone(),
        );
        let agent = f.hosted_agent;
        async move {
            let response = client
                .post(format!(
                    "{base}/v1/workspaces/{f_ws}/channels/{channel}/agent-runs"
                ))
                .bearer_auth(jwt)
                .json(&json!({
                    "agent_member_id": agent,
                    "client_run_id": Uuid::new_v4(),
                    "input": {"type": "work", "title": "t", "brief": "b"},
                }))
                .send()
                .await
                .expect("agent-runs");
            let status = response.status().as_u16();
            (
                status,
                response.json::<Value>().await.unwrap_or(Value::Null),
            )
        }
    };

    // D10 2 — the channel is not in the approved set (the agent IS a member).
    assert_refused(
        &su,
        &f,
        ask(f.private_channel).await,
        409,
        Some("hosted_channel_not_approved"),
        &before,
        "unapproved channel",
    )
    .await;

    // D10 1 — a revoked credential is not a live connection.
    sqlx::query("UPDATE token SET revoked_at=now() WHERE workspace_id=$1 AND id=$2")
        .bind(f.workspace)
        .bind(f.hosted_token)
        .execute(&su)
        .await
        .expect("revoke");
    assert_refused(
        &su,
        &f,
        ask(f.channel).await,
        409,
        Some("hosted_connection_not_active"),
        &before,
        "credential revoked",
    )
    .await;
    sqlx::query("UPDATE token SET revoked_at=NULL WHERE workspace_id=$1 AND id=$2")
        .bind(f.workspace)
        .bind(f.hosted_token)
        .execute(&su)
        .await
        .expect("un-revoke");

    // D10 1 — every other lifecycle state.
    // (`detected` is the not-yet-proved state: 070's activation shape makes
    // `active` imply proved, so un-proving is a status change, not a column.)
    for status in ["detected", "expired", "cleanup_pending"] {
        sqlx::query(
            "UPDATE hosted_agent_connection SET status=$3, \
               proved_at = CASE WHEN $3='detected' THEN NULL ELSE proved_at END, \
               proved_by = CASE WHEN $3='detected' THEN NULL ELSE proved_by END \
             WHERE workspace_id=$1 AND id=$2",
        )
        .bind(f.workspace)
        .bind(f.hosted_connection)
        .bind(status)
        .execute(&su)
        .await
        .unwrap_or_else(|error| panic!("set status {status}: {error}"));
        assert_refused(
            &su,
            &f,
            ask(f.channel).await,
            409,
            Some("hosted_connection_not_active"),
            &before,
            status,
        )
        .await;
    }
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='active', active_token_id=$4, \
                proved_at=now(), proved_by=$3 \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(f.workspace)
    .bind(f.hosted_connection)
    .bind(f.hosted_agent)
    .bind(f.hosted_token)
    .execute(&su)
    .await
    .expect("reactivate");

    // D10 1 — the dedicated member is paused.
    sqlx::query(
        "UPDATE agent_profile SET paused=true WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(f.workspace)
    .bind(f.hosted_agent)
    .execute(&su)
    .await
    .expect("pause");
    assert_refused(
        &su,
        &f,
        ask(f.channel).await,
        409,
        Some("agent_paused"),
        &before,
        "agent paused",
    )
    .await;
    sqlx::query(
        "UPDATE agent_profile SET paused=false WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(f.workspace)
    .bind(f.hosted_agent)
    .execute(&su)
    .await
    .expect("unpause");

    // The control: with every condition restored the same request succeeds, so
    // each refusal above was caused by exactly the condition it names.
    let (status, run) = ask(f.channel).await;
    assert_eq!(status, 201, "control: {run}");
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3515)"]
async fn a_closed_instance_gate_refuses_hosted_work_requests() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    // The instance gate (HAP-E6) governs work requests like mentions. A fresh
    // fixture, so no other guard (the concurrency cap in particular) can be what
    // answers 409.
    let closed = start_server(
        momo_app_pool().await,
        Knobs {
            hosted_delivery_enabled: false,
            ..Knobs::open()
        },
    )
    .await;
    let client = reqwest::Client::new();
    let before = snapshot(&su, f.workspace).await;
    let (status, body) = post_run(
        &client,
        &closed,
        &f,
        &f.human_jwt,
        f.channel,
        f.hosted_agent,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert!(
        body.to_string()
            .contains("hosted agent delivery is not enabled"),
        "{body}"
    );
    assert_eq!(snapshot(&su, f.workspace).await, before, "gate closed");

    // The same fixture on an open server accepts the request: the gate was the
    // only thing in the way.
    let open = start_server(momo_app_pool().await, Knobs::open()).await;
    let (status, body) = post_run(
        &client,
        &open,
        &f,
        &f.human_jwt,
        f.channel,
        f.hosted_agent,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 201, "{body}");
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3515)"]
async fn a_non_member_requester_is_refused_before_anything_is_written() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, Knobs::open()).await;
    let client = reqwest::Client::new();
    let before = snapshot(&su, f.workspace).await;
    let outcome = post_run(
        &client,
        &base,
        &f,
        &f.outsider_jwt,
        f.channel,
        f.hosted_agent,
        Uuid::new_v4(),
    )
    .await;
    assert_refused(
        &su,
        &f,
        outcome,
        403,
        None,
        &before,
        "requester not in channel",
    )
    .await;

    // An agent credential cannot start an agent's work: the route is a human's.
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/agent-runs",
            f.workspace, f.channel
        ))
        .bearer_auth(&f.hosted_bearer)
        .json(&json!({
            "agent_member_id": f.hosted_agent,
            "client_run_id": Uuid::new_v4(),
            "input": {"type": "work", "title": "t", "brief": "b"},
        }))
        .send()
        .await
        .expect("agent-runs");
    assert!(
        matches!(response.status().as_u16(), 401 | 403),
        "an agent cannot request agent work: {}",
        response.status()
    );
    assert_eq!(snapshot(&su, f.workspace).await, before);
}

// ---------------------------------------------------------------------------
// D10 4 / 5: owner_only and the Claude conservative mode stay closed
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3515)"]
async fn owner_only_stays_refused_even_with_an_active_approved_connection() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, Knobs::open()).await;
    let client = reqwest::Client::new();
    // The hosted fixture agent becomes the owner's Codex subscription agent. Its
    // connection is active, proved, and approves the channel — everything D10
    // 1–3 ask for — so only D10 4 can be what refuses it.
    sqlx::query(
        "UPDATE agent SET invocation_scope='owner_only', subscription_harness='codex' \
          WHERE workspace_id=$1 AND member_id=$2",
    )
    .bind(f.workspace)
    .bind(f.hosted_agent)
    .execute(&su)
    .await
    .expect("mark owner_only");
    let before = snapshot(&su, f.workspace).await;
    let (status, body) = post_run(
        &client,
        &base,
        &f,
        &f.human_jwt,
        f.channel,
        f.hosted_agent,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert!(
        body.to_string()
            .contains("hosted agent delivery is not enabled"),
        "{body}"
    );
    assert_eq!(snapshot(&su, f.workspace).await, before);

    // The same agent, owned by someone else, is refused earlier still (403): the
    // owner_only call rule is not weakened either.
    let before = snapshot(&su, f.workspace).await;
    let outcome = post_run(
        &client,
        &base,
        &f,
        &f.outsider_jwt,
        f.channel,
        f.hosted_agent,
        Uuid::new_v4(),
    )
    .await;
    assert_ne!(outcome.0, 201, "{}", outcome.1);
    assert_eq!(snapshot(&su, f.workspace).await, before);
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3515)"]
async fn a_paused_claude_subscription_agent_is_still_refused_first() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(
        momo_app_pool().await,
        Knobs {
            claude_subscription_agents_enabled: false,
            ..Knobs::open()
        },
    )
    .await;
    let client = reqwest::Client::new();
    sqlx::query(
        "UPDATE agent SET invocation_scope='owner_only', subscription_harness='claude_code' \
          WHERE workspace_id=$1 AND member_id=$2",
    )
    .bind(f.workspace)
    .bind(f.hosted_agent)
    .execute(&su)
    .await
    .expect("mark claude owner_only");
    let before = snapshot(&su, f.workspace).await;
    let outcome = post_run(
        &client,
        &base,
        &f,
        &f.human_jwt,
        f.channel,
        f.hosted_agent,
        Uuid::new_v4(),
    )
    .await;
    assert_refused(
        &su,
        &f,
        outcome,
        409,
        Some("claude_subscription_agent_paused"),
        &before,
        "claude conservative mode",
    )
    .await;
}

// ---------------------------------------------------------------------------
// managed agents: the selector moved, the rules did not
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3515)"]
async fn managed_agents_keep_their_gateway_rules_and_leave_no_orphan_run() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let client = reqwest::Client::new();

    // Worker mode: a managed agent still cannot take a work run.
    let worker = start_server(
        momo_app_pool().await,
        Knobs {
            gateway_mode: false,
            ..Knobs::open()
        },
    )
    .await;
    let before = snapshot(&su, f.workspace).await;
    let outcome = post_run(
        &client,
        &worker,
        &f,
        &f.human_jwt,
        f.channel,
        f.managed_agent,
        Uuid::new_v4(),
    )
    .await;
    assert_refused(
        &su,
        &f,
        outcome,
        409,
        None,
        &before,
        "managed agent, worker mode",
    )
    .await;

    // Gateway mode: 201, a wake broadcast on the agent's key, NO inbox row.
    let base = start_server(momo_app_pool().await, Knobs::open()).await;
    let (status, run) = post_run(
        &client,
        &base,
        &f,
        &f.human_jwt,
        f.channel,
        f.managed_agent,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 201, "{run}");
    let wake: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='broadcast' AND partition_key=$2",
    )
    .bind(f.workspace)
    .bind(f.managed_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(wake, 1);
    assert_eq!(snapshot(&su, f.workspace).await.inbox, 0);

    // The concurrency cap refuses a second run and takes its row back out.
    sqlx::query("UPDATE agent SET max_concurrent_runs=1 WHERE workspace_id=$1 AND member_id=$2")
        .bind(f.workspace)
        .bind(f.managed_agent)
        .execute(&su)
        .await
        .expect("cap");
    let before = snapshot(&su, f.workspace).await;
    let outcome = post_run(
        &client,
        &base,
        &f,
        &f.human_jwt,
        f.channel,
        f.managed_agent,
        Uuid::new_v4(),
    )
    .await;
    assert_refused(&su, &f, outcome, 409, None, &before, "concurrency cap").await;

    // A paused managed agent likewise leaves no queued run behind.
    sqlx::query(
        "UPDATE agent_profile SET paused=true WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(f.workspace)
    .bind(f.managed_agent)
    .execute(&su)
    .await
    .expect("pause");
    let outcome = post_run(
        &client,
        &base,
        &f,
        &f.human_jwt,
        f.channel,
        f.managed_agent,
        Uuid::new_v4(),
    )
    .await;
    assert_refused(&su, &f, outcome, 409, None, &before, "paused managed agent").await;
}
