//! #2815 OB2-9 — subscription agents are the owner's alone (ADR-0193 D4·D5·D6).
//!
//! The real Axum router runs against a `momo_app` (NOBYPASSRLS) pool, so every
//! delivery below goes through the same code a person's send or a hosted CLI's
//! Agent Port request reaches. `DATABASE_URL` is a PostgreSQL 18 superuser URL
//! used only for migrations, fixtures and read-back. Each test is `#[ignore]`d
//! and runs against an isolated container (`2815-*`), never a shared database.
//!
//! Conformance ↔ the branch whose removal turns it red:
//!
//! | test | proves | branch |
//! |---|---|---|
//! | `non_owner_calls_are_not_delivered_and_answered_once` | ① mention/DM/thread reply/work request → 0 delivered, 1 notice | `owner_only_gate` non-owner arm, inbox fan-out owner predicate, work-run owner check |
//! | same | ② 10-min re-call → +0 notice; after 10 min → +1 | `lock_and_find_recent_notice_in_tx` |
//! | `the_owners_call_is_delivered_with_no_notice` | ③ owner → 1 job, 0 notice | (gate does not block everyone) |
//! | `an_offline_owner_call_is_queued_answered_once_and_claimed_on_reconnect` | ④ queued, claimed on reconnect, liveness moves | `recently_seen` offline branch |
//! | `an_owner_call_before_the_connection_is_live_says_the_future_sentence_only` | ④ nothing queued | `reconnectable` offline branch |
//! | `the_kill_switch_stops_every_delivery_and_turning_it_on_resumes` | ⑤ + client value + join refusal + tool view | `owner_only_gate` switch arm, `tool_view_for`, create refusal |
//! | `a_notice_is_one_write_and_another_workspace_sees_zero_rows` | ⑥ single tx + RLS | (RLS FORCE) |
//! | `owner_only_can_never_be_reopened` | D4 「소유자는 바꿀 수 없다」 | migration 089 trigger |
//! | `the_welcome_opener_never_spends_someone_elses_subscription` | welcome speaker | `load_welcome_agent_in_tx` predicate |
//! | `the_subscription_join_records_owner_only_and_refuses_bad_shapes` | create path | `requested_owner_only` / `mark_agent_owner_only_in_tx` |

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

const TEST_JWT_SECRET: &str = "subscription-agent-pg-conformance-signing-secret";
const MODERN_VERSION: &str = "2026-07-28";
const PATH: &str = "/v1/mcp/agent-port";
const AUDIENCE: &str = "/v1/mcp/agent-port";
const NOTICE_SOURCE: &str = "server.subscription_agent.notice.v1";

const NON_OWNER_BODY: &str =
    "성재의 개인 에이전트예요. 팀이 함께 부르는 에이전트는 설정 › AI 연결에서 붙일 수 있어요.";
const OFFLINE_QUEUED_BODY: &str =
    "지금은 오프라인이에요. 맥에서 Claude Code를 다시 열면 이어서 답할게요.";
const OFFLINE_NOT_QUEUED_BODY: &str =
    "지금은 오프라인이에요. 맥에서 Claude Code를 다시 열면 답할 수 있어요.";
const DISABLED_BODY: &str =
    "지금은 이 서버에서 구독 에이전트를 쓸 수 없어요. 설정 › AI 연결에서 API 키로 연결할 수 있어요.";

// ---------------------------------------------------------------------------
// isolated database + server
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated PostgreSQL 18 URL")
}

fn required_pg_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name} for the isolated PG"))
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    PgPoolOptions::new()
        .max_connections(16)
        .connect_with(options.username("momo_app").password(
            &std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".into()),
        ))
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
    panic!("psql client not found");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema mutex");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration");
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
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .env("PGPASSWORD", required_pg_env("PGPASSWORD"))
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

async fn start_server(pool: PgPool, subscription_agents_enabled: bool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    // Gateway mode so a work request reaches the agent checks at all.
    .with_agent_gateway(AgentGatewaySettings {
        mode: AgentGatewayMode::Gateway,
        secret: "subscription-agent-conformance-gateway-secret".to_string(),
        allow_legacy_secret: false,
    })
    .with_agent_port(AgentPortConfig {
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        // Opened so "delivered" means delivered: with the hosted gate closed
        // every hosted call is skipped and a missing owner check would hide.
        hosted_delivery_enabled: true,
        subscription_agents_enabled,
        ..AgentPortConfig::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().expect("address");
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
// fixture: an owner, a teammate, and the owner's Claude Code as owner_only
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Fixture {
    workspace: Uuid,
    owner: Uuid,
    owner_jwt: String,
    teammate: Uuid,
    teammate_jwt: String,
    agent: Uuid,
    agent_handle: String,
    token: Uuid,
    bearer: String,
    channel: Uuid,
    general: Uuid,
    dm: Uuid,
}

async fn insert_human(pool: &PgPool, workspace: Uuid, name: &str, role: &str) -> (Uuid, String) {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human',$3,$4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(name)
    .bind(format!("h-{}", id.simple()))
    .execute(pool)
    .await
    .expect("human member");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(id)
    .bind(workspace)
    .bind(format!("{id}@sub.test"))
    .execute(pool)
    .await
    .expect("human identity");
    sqlx::query("INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,$3::text::membership_role)")
        .bind(workspace)
        .bind(id)
        .bind(role)
        .execute(pool)
        .await
        .expect("human membership");
    let jwt = momo_auth::sign_access(id, workspace, &[], TEST_JWT_SECRET)
        .expect("sign")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'sub-conformance')",
    )
    .bind(workspace)
    .bind(id)
    .bind(&jwt)
    .execute(pool)
    .await
    .expect("session token");
    (id, jwt)
}

async fn insert_channel(pool: &PgPool, workspace: Uuid, kind: &str, name: Option<&str>) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel(id, workspace_id, kind, name, dm_key) \
         VALUES($1,$2,$3::channel_kind,$4,$5)",
    )
    .bind(id)
    .bind(workspace)
    .bind(kind)
    .bind(name)
    .bind(if kind == "dm" {
        Some(format!("dm-{}", id.simple()))
    } else {
        None
    })
    .execute(pool)
    .await
    .expect("channel");
    sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
        .bind(id)
        .bind(workspace)
        .execute(pool)
        .await
        .expect("channel_seq");
    id
}

async fn join(pool: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(pool)
        .await
        .expect("membership");
}

async fn seed(pool: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("sub-{}", workspace.simple()))
        .execute(pool)
        .await
        .expect("workspace");
    let (owner, owner_jwt) = insert_human(pool, workspace, "성재", "owner").await;
    let (teammate, teammate_jwt) = insert_human(pool, workspace, "동료", "member").await;

    let agent = Uuid::new_v4();
    let agent_handle = format!("claude-{}", agent.simple());
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'agent','Claude Code',$3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(&agent_handle)
    .execute(pool)
    .await
    .expect("agent member");
    sqlx::query(
        "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id, config) \
         VALUES($1,$2,'hosted-agent','https://hosted-agent.invalid/disabled',$3, \
                '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(owner)
    .execute(pool)
    .await
    .expect("agent row");
    // The one transition migration 089 allows: workspace → owner_only.
    sqlx::query(
        "UPDATE agent SET invocation_scope='owner_only', subscription_harness='claude_code' \
         WHERE workspace_id=$1 AND member_id=$2",
    )
    .bind(workspace)
    .bind(agent)
    .execute(pool)
    .await
    .expect("mark owner_only");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
    )
    .bind(workspace)
    .bind(agent)
    .execute(pool)
    .await
    .expect("agent membership");
    sqlx::query(
        "INSERT INTO agent_profile(agent_member_id, workspace_id, updated_by, paused) \
         VALUES($1,$2,$3,false)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(owner)
    .execute(pool)
    .await
    .expect("agent profile");

    let channel = insert_channel(pool, workspace, "public", Some("team")).await;
    let general = insert_channel(pool, workspace, "public", Some("general")).await;
    let dm = insert_channel(pool, workspace, "dm", None).await;
    for room in [channel, general] {
        for member in [owner, teammate, agent] {
            join(pool, workspace, room, member).await;
        }
    }
    join(pool, workspace, dm, teammate).await;
    join(pool, workspace, dm, agent).await;

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
    .bind(owner)
    .bind(vec![channel, general, dm])
    .execute(pool)
    .await
    .expect("connection");
    let bearer = format!(
        "momo_agent_v1.{workspace}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let scopes: Vec<String> = [
        "agent:port:connect",
        "agent:inbox:read",
        "messages:read",
        "messages:write",
        "agent:jobs:read",
        "agent:runs:callback",
    ]
    .iter()
    .map(|scope| scope.to_string())
    .collect();
    let token: Uuid = sqlx::query_scalar(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, created_by, \
                           last_used_at) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'),$4,'claude code', \
                'hosted_active',$5,$6,$7, now()) RETURNING id",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&bearer)
    .bind(scopes)
    .bind(connection)
    .bind(AUDIENCE)
    .bind(owner)
    .fetch_one(pool)
    .await
    .expect("hosted token");
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
    .expect("activate");

    Fixture {
        workspace,
        owner,
        owner_jwt,
        teammate,
        teammate_jwt,
        agent,
        agent_handle,
        token,
        bearer,
        channel,
        general,
        dm,
    }
}

/// A fresh handle inside the 2-32 character rule.
fn short_handle(prefix: &str) -> String {
    format!("{prefix}-{}", &Uuid::new_v4().simple().to_string()[..12])
}

// ---------------------------------------------------------------------------
// wire + read-back helpers
// ---------------------------------------------------------------------------

async fn send(
    client: &reqwest::Client,
    base: &str,
    f: &Fixture,
    jwt: &str,
    channel: Uuid,
    body: &str,
    root: Option<Uuid>,
) -> Uuid {
    let mut request = json!({"clientMsgId": Uuid::new_v4(), "body": body});
    if let Some(root) = root {
        request["rootId"] = json!(root);
    }
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{channel}/messages",
            f.workspace
        ))
        .bearer_auth(jwt)
        .json(&request)
        .send()
        .await
        .expect("send");
    let status = response.status().as_u16();
    let value: Value = response.json().await.expect("send body");
    assert!(status < 300, "send answered {status}: {value}");
    Uuid::parse_str(value["id"].as_str().expect("message id")).expect("uuid")
}

async fn jobs(pool: &PgPool, f: &Fixture) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND partition_key=$2",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn inbox_message_events(pool: &PgPool, f: &Fixture) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM hosted_agent_inbox_event \
          WHERE workspace_id=$1 AND agent_member_id=$2 AND event_kind='message'",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// `(body, root_id, kind, recipient)` of every notice, oldest first.
async fn notices(pool: &PgPool, f: &Fixture) -> Vec<(String, Option<Uuid>, String, String)> {
    sqlx::query_as(
        "SELECT body, root_id, props->>'subscription_notice', props->>'notice_for_member_id' \
           FROM message WHERE workspace_id=$1 AND author_member_id=$2 \
            AND props->>'source'=$3 ORDER BY seq",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .bind(NOTICE_SOURCE)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn last_skip_reason(pool: &PgPool, f: &Fixture) -> String {
    sqlx::query_scalar(
        "SELECT detail->>'reason' FROM audit_log WHERE workspace_id=$1 \
           AND action='agent.mention.skipped' ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(f.workspace)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn age_notices(pool: &PgPool, f: &Fixture, minutes: i64) {
    sqlx::query(
        "UPDATE message SET created_at = created_at - make_interval(mins => $3) \
          WHERE workspace_id=$1 AND author_member_id=$2 AND props->>'source'=$4",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .bind(minutes as i32)
    .bind(NOTICE_SOURCE)
    .execute(pool)
    .await
    .unwrap();
}

fn mcp_body(method: &str, extra: Value) -> Value {
    let mut params = json!({
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {}
        }
    });
    for (key, value) in extra.as_object().expect("object") {
        params[key] = value.clone();
    }
    json!({"jsonrpc": "2.0", "id": Uuid::new_v4().to_string(), "method": method, "params": params})
}

async fn list_tools(client: &reqwest::Client, base: &str, bearer: &str) -> Vec<String> {
    let response = client
        .post(format!("{base}{PATH}"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", "tools/list")
        .bearer_auth(bearer)
        .json(&mcp_body("tools/list", json!({})))
        .send()
        .await
        .expect("tools/list");
    assert_eq!(response.status().as_u16(), 200);
    let value: Value = response.json().await.expect("body");
    value["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_string())
        .collect()
}

async fn claim_jobs(client: &reqwest::Client, base: &str, bearer: &str) -> (u16, Value) {
    let response = client
        .post(format!("{base}{PATH}"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", "tools/call")
        .header("mcp-name", "oort_jobs_claim")
        .bearer_auth(bearer)
        .json(&mcp_body(
            "tools/call",
            json!({"name": "oort_jobs_claim", "arguments": {"limit": 10}}),
        ))
        .send()
        .await
        .expect("tools/call");
    let status = response.status().as_u16();
    (status, response.json().await.expect("body"))
}

async fn work_request(client: &reqwest::Client, base: &str, f: &Fixture, jwt: &str) -> u16 {
    client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/agent-runs",
            f.workspace, f.channel
        ))
        .bearer_auth(jwt)
        .json(&json!({
            "agent_member_id": f.agent,
            "client_run_id": Uuid::new_v4(),
            "input": {"type": "work", "title": "t", "brief": "b"},
        }))
        .send()
        .await
        .expect("agent-runs")
        .status()
        .as_u16()
}

// ---------------------------------------------------------------------------
// ① ② — a non-owner is never delivered, and hears whose agent this is once
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (2815-*)"]
async fn non_owner_calls_are_not_delivered_and_answered_once() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();
    let mention = format!("@{} 이거 봐 줄래?", f.agent_handle);

    // ① mention, top level.
    let first = send(
        &client,
        &base,
        &f,
        &f.teammate_jwt,
        f.channel,
        &mention,
        None,
    )
    .await;
    assert_eq!(
        jobs(&su, &f).await,
        0,
        "a non-owner's mention delivers nothing"
    );
    assert_eq!(
        inbox_message_events(&su, &f).await,
        0,
        "not even as an inbox message event"
    );
    assert_eq!(last_skip_reason(&su, &f).await, "owner_only_non_owner");
    let posted = notices(&su, &f).await;
    assert_eq!(posted.len(), 1, "exactly one notice: {posted:?}");
    assert_eq!(posted[0].0, NON_OWNER_BODY);
    assert_eq!(posted[0].1, Some(first), "threaded under the call");
    assert_eq!(posted[0].2, "non_owner");
    assert_eq!(posted[0].3, f.teammate.to_string());
    let message_type: String = sqlx::query_scalar(
        "SELECT type::text FROM message WHERE workspace_id=$1 AND author_member_id=$2 \
           AND props->>'source'=$3",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .bind(NOTICE_SOURCE)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        message_type, "text",
        "the agent's sentence, not a system line"
    );

    // ② the same person again within ten minutes → no second notice.
    send(
        &client,
        &base,
        &f,
        &f.teammate_jwt,
        f.channel,
        &mention,
        None,
    )
    .await;
    assert_eq!(jobs(&su, &f).await, 0);
    assert_eq!(notices(&su, &f).await.len(), 1, "throttled");
    let throttled: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 \
           AND action='agent.subscription.notice_throttled'",
    )
    .bind(f.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(throttled, 1);

    // ② the throttle is not permanent silence: past the window, one more.
    age_notices(&su, &f, 11).await;
    send(
        &client,
        &base,
        &f,
        &f.teammate_jwt,
        f.channel,
        &mention,
        None,
    )
    .await;
    assert_eq!(jobs(&su, &f).await, 0);
    assert_eq!(
        notices(&su, &f).await.len(),
        2,
        "one more after ten minutes"
    );

    // ① a plain thread reply (no mention) in a thread the agent answered in.
    let root = send(&client, &base, &f, &f.owner_jwt, f.channel, "스레드", None).await;
    let before = inbox_message_events(&su, &f).await;
    assert_eq!(before, 1, "the owner's own message does reach the inbox");
    send(
        &client,
        &base,
        &f,
        &f.teammate_jwt,
        f.channel,
        "그냥 답글",
        Some(root),
    )
    .await;
    assert_eq!(
        inbox_message_events(&su, &f).await,
        before,
        "a non-owner's thread reply is not delivered to the owner_only runtime"
    );
    assert_eq!(
        notices(&su, &f).await.len(),
        2,
        "a reply without a mention gets no notice (planner 판정 2026-09-26)"
    );

    // ① a mention inside that thread → a notice in THAT thread.
    send(
        &client,
        &base,
        &f,
        &f.teammate_jwt,
        f.channel,
        &mention,
        Some(root),
    )
    .await;
    let posted = notices(&su, &f).await;
    assert_eq!(posted.len(), 3);
    assert_eq!(
        posted[2].1,
        Some(root),
        "answered in the thread it was said in"
    );
    assert_eq!(jobs(&su, &f).await, 0);

    // ② the throttle is per person: a second non-owner calling in the same
    // thread inside the window still hears the sentence once.
    let (second, second_jwt) = insert_human(&su, f.workspace, "다른동료", "member").await;
    join(&su, f.workspace, f.channel, second).await;
    send(
        &client,
        &base,
        &f,
        &second_jwt,
        f.channel,
        &mention,
        Some(root),
    )
    .await;
    let posted = notices(&su, &f).await;
    assert_eq!(
        posted.len(),
        4,
        "each person gets their own notice: {posted:?}"
    );
    assert_eq!(posted[3].3, second.to_string());
    send(
        &client,
        &base,
        &f,
        &second_jwt,
        f.channel,
        &mention,
        Some(root),
    )
    .await;
    assert_eq!(notices(&su, &f).await.len(), 4, "…once per window each");
    assert_eq!(jobs(&su, &f).await, 0);

    // ① the 1:1 DM rule (no @handle at all).
    send(&client, &base, &f, &f.teammate_jwt, f.dm, "안녕?", None).await;
    assert_eq!(
        jobs(&su, &f).await,
        0,
        "a DM from a non-owner delivers nothing"
    );
    let dm_notices: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id=$1 AND channel_id=$2 \
           AND author_member_id=$3 AND props->>'subscription_notice'='non_owner'",
    )
    .bind(f.workspace)
    .bind(f.dm)
    .bind(f.agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(dm_notices, 1);

    // ① a work request.
    assert_eq!(
        work_request(&client, &base, &f, &f.teammate_jwt).await,
        403,
        "a non-owner's work request is refused by the owner gate"
    );
    assert_eq!(
        work_request(&client, &base, &f, &f.owner_jwt).await,
        409,
        "the owner passes the owner gate and meets the existing hosted refusal"
    );
    let runs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        runs, 0,
        "no run for anyone but the owner, and none from a refused one"
    );
}

// ---------------------------------------------------------------------------
// ③ — the owner's call is delivered, and nobody is told anything
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (2815-*)"]
async fn the_owners_call_is_delivered_with_no_notice() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();

    send(
        &client,
        &base,
        &f,
        &f.owner_jwt,
        f.channel,
        &format!("@{} 부탁해", f.agent_handle),
        None,
    )
    .await;
    assert_eq!(jobs(&su, &f).await, 1, "the owner's mention is one job");
    let job_refs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_agent_inbox_event \
          WHERE workspace_id=$1 AND agent_member_id=$2 AND event_kind='agent_job'",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(job_refs, 1, "with its hosted inbox reference");
    assert_eq!(inbox_message_events(&su, &f).await, 1);
    assert!(
        notices(&su, &f).await.is_empty(),
        "no notice for the owner online"
    );
}

// ---------------------------------------------------------------------------
// ④ — the owner calls while the CLI is away: queued, told once, claimed later
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (2815-*)"]
async fn an_offline_owner_call_is_queued_answered_once_and_claimed_on_reconnect() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    sqlx::query("UPDATE token SET last_used_at = now() - interval '1 hour' WHERE id=$1")
        .bind(f.token)
        .execute(&su)
        .await
        .unwrap();
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();
    let mention = format!("@{} 오프라인이어도 괜찮아", f.agent_handle);

    send(&client, &base, &f, &f.owner_jwt, f.channel, &mention, None).await;
    assert_eq!(jobs(&su, &f).await, 1, "the call is not dropped");
    let posted = notices(&su, &f).await;
    assert_eq!(posted.len(), 1, "{posted:?}");
    assert_eq!(posted[0].0, OFFLINE_QUEUED_BODY);
    assert_eq!(posted[0].2, "offline");
    assert_eq!(posted[0].3, f.owner.to_string());
    for forbidden in ["기기", "마지막", "MacBook", "위치"] {
        assert!(!posted[0].0.contains(forbidden), "{}", posted[0].0);
    }

    send(&client, &base, &f, &f.owner_jwt, f.channel, &mention, None).await;
    assert_eq!(jobs(&su, &f).await, 2, "every call is queued");
    assert_eq!(
        notices(&su, &f).await.len(),
        1,
        "but told only once per window"
    );

    // Reconnect: the CLI comes back and claims what waited for it.
    let (status, claimed) = claim_jobs(&client, &base, &f.bearer).await;
    assert_eq!(status, 200, "{claimed}");
    let claimed_jobs = claimed["result"]["structuredContent"]["jobs"]
        .as_array()
        .expect("jobs")
        .len();
    assert_eq!(
        claimed_jobs, 2,
        "both queued calls are handed over: {claimed}"
    );
    // The liveness signal the offline branch reads actually moves: the CLI's
    // visit touched its credential, so the next call counts as online.
    let fresh: bool = sqlx::query_scalar(
        "SELECT last_used_at > now() - interval '1 minute' FROM token WHERE id=$1",
    )
    .bind(f.token)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(fresh, "an Agent Port request refreshes token.last_used_at");
    send(&client, &base, &f, &f.owner_jwt, f.channel, &mention, None).await;
    assert_eq!(jobs(&su, &f).await, 3);
    assert_eq!(
        notices(&su, &f).await.len(),
        1,
        "back online: no offline sentence"
    );
}

// ---------------------------------------------------------------------------
// ④' — the owner calls before the connection is live: nothing is queued, so
// only the sentence about the future is true
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (2815-*)"]
async fn an_owner_call_before_the_connection_is_live_says_the_future_sentence_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    // A second owner_only agent of the same owner whose connection is still
    // `detected` (the CLI dialed in; not yet proved) — no active credential.
    let pending = Uuid::new_v4();
    let pending_handle = format!("pend-{}", &pending.simple().to_string()[..12]);
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'agent','Claude Code',$3)",
    )
    .bind(pending)
    .bind(f.workspace)
    .bind(&pending_handle)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id, config) \
         VALUES($1,$2,'hosted-agent','https://hosted-agent.invalid/disabled',$3, \
                '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb)",
    )
    .bind(pending)
    .bind(f.workspace)
    .bind(f.owner)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE agent SET invocation_scope='owner_only', subscription_harness='claude_code' \
         WHERE workspace_id=$1 AND member_id=$2",
    )
    .bind(f.workspace)
    .bind(pending)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
    )
    .bind(f.workspace)
    .bind(pending)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agent_profile(agent_member_id, workspace_id, updated_by, paused) \
         VALUES($1,$2,$3,false)",
    )
    .bind(pending)
    .bind(f.workspace)
    .bind(f.owner)
    .execute(&su)
    .await
    .unwrap();
    join(&su, f.workspace, f.channel, pending).await;
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           workspace_id,agent_member_id,status,pairing_consumed_at,detected_at,detected_by, \
           approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,'detected',now(),now(),$2,$3,ARRAY['agent:port:connect']::text[],$4)",
    )
    .bind(f.workspace)
    .bind(pending)
    .bind(vec![f.channel])
    .bind(f.owner)
    .execute(&su)
    .await
    .unwrap();
    let pending_fixture = Fixture {
        agent: pending,
        agent_handle: pending_handle.clone(),
        ..f.clone()
    };
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();
    let mention = format!("@{pending_handle} 들려?");

    send(&client, &base, &f, &f.owner_jwt, f.channel, &mention, None).await;
    assert_eq!(
        jobs(&su, &pending_fixture).await,
        0,
        "no live connection: the existing skip, no new queue"
    );
    assert_eq!(
        last_skip_reason(&su, &f).await,
        "hosted_connection_unavailable"
    );
    let posted = notices(&su, &pending_fixture).await;
    assert_eq!(posted.len(), 1, "{posted:?}");
    assert_eq!(
        posted[0].0, OFFLINE_NOT_QUEUED_BODY,
        "no 「이어서」: nothing was queued"
    );

    // A teammate in the same state hears only whose agent this is.
    send(
        &client,
        &base,
        &f,
        &f.teammate_jwt,
        f.channel,
        &mention,
        None,
    )
    .await;
    let posted = notices(&su, &pending_fixture).await;
    assert_eq!(posted.len(), 2);
    assert_eq!(posted[1].0, NON_OWNER_BODY);
}

// ---------------------------------------------------------------------------
// ⑤ — the kill switch
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (2815-*)"]
async fn the_kill_switch_stops_every_delivery_and_turning_it_on_resumes() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let app = momo_app_pool().await;
    let off = start_server(app.clone(), false).await;
    let client = reqwest::Client::new();
    let mention = format!("@{} 해 줘", f.agent_handle);

    // The owner's own call: not delivered, one D6 sentence.
    send(&client, &off, &f, &f.owner_jwt, f.channel, &mention, None).await;
    assert_eq!(
        jobs(&su, &f).await,
        0,
        "switch off → the owner's call is not delivered"
    );
    assert_eq!(
        last_skip_reason(&su, &f).await,
        "subscription_agents_disabled"
    );
    let posted = notices(&su, &f).await;
    assert_eq!(posted.len(), 1);
    assert_eq!(posted[0].0, DISABLED_BODY);
    send(&client, &off, &f, &f.owner_jwt, f.channel, &mention, None).await;
    assert_eq!(notices(&su, &f).await.len(), 1, "same throttle");

    // Nor as an inbox message, nor through the Agent Port.
    let events = inbox_message_events(&su, &f).await;
    send(
        &client,
        &off,
        &f,
        &f.owner_jwt,
        f.channel,
        "평범한 말",
        None,
    )
    .await;
    assert_eq!(inbox_message_events(&su, &f).await, events);
    assert!(
        list_tools(&client, &off, &f.bearer).await.is_empty(),
        "an owner_only runtime can call nothing while the switch is off"
    );

    // The value clients read.
    let workspace: Value = client
        .get(format!("{off}/v1/workspaces/{}", f.workspace))
        .bearer_auth(&f.teammate_jwt)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(workspace["workspace"]["subscriptionAgentsEnabled"], false);

    // Joining through the subscription path is refused and writes nothing.
    let agents_before: i64 = sqlx::query_scalar("SELECT count(*) FROM agent WHERE workspace_id=$1")
        .bind(f.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    let refused = client
        .post(format!(
            "{off}/v1/workspaces/{}/hosted-agent-connections",
            f.workspace
        ))
        .bearer_auth(&f.owner_jwt)
        .json(&json!({
            "displayName": "내 Claude",
            "handle": short_handle("mine"),
            "invocationScope": "owner_only",
            "subscriptionHarness": "claude_code",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status().as_u16(), 409);
    let agents_after: i64 = sqlx::query_scalar("SELECT count(*) FROM agent WHERE workspace_id=$1")
        .bind(f.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(
        agents_after, agents_before,
        "no owner_only agent was created"
    );
    assert_eq!(work_request(&client, &off, &f, &f.owner_jwt).await, 409);

    // Turned back on (a restart with the variable set): delivery resumes, with
    // no announcement.
    let on = start_server(app, true).await;
    assert!(!list_tools(&client, &on, &f.bearer).await.is_empty());
    send(&client, &on, &f, &f.owner_jwt, f.channel, &mention, None).await;
    assert_eq!(jobs(&su, &f).await, 1, "switch on → delivered again");
    assert_eq!(notices(&su, &f).await.len(), 1, "no resume message");
    let workspace: Value = client
        .get(format!("{on}/v1/workspaces/{}", f.workspace))
        .bearer_auth(&f.teammate_jwt)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(workspace["workspace"]["subscriptionAgentsEnabled"], true);
}

// ---------------------------------------------------------------------------
// ⑥ — the notice is one write on the single path, and RLS bounds it
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (2815-*)"]
async fn a_notice_is_one_write_and_another_workspace_sees_zero_rows() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let other = seed(&su).await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();

    send(
        &client,
        &base,
        &f,
        &f.teammate_jwt,
        f.channel,
        &format!("@{}", f.agent_handle),
        None,
    )
    .await;

    // channel_seq advanced to the notice's seq, and the notice has its own
    // broadcast outbox row: the same spine as any message.
    let (notice_id, notice_seq): (Uuid, i64) = sqlx::query_as(
        "SELECT id, seq FROM message WHERE workspace_id=$1 AND author_member_id=$2 \
           AND props->>'source'=$3",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .bind(NOTICE_SOURCE)
    .fetch_one(&su)
    .await
    .unwrap();
    let last_seq: i64 = sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id=$1")
        .bind(f.channel)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(
        last_seq, notice_seq,
        "the notice took the channel's next seq"
    );
    let broadcasts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='broadcast' \
           AND payload->'data'->>'type'='message.new' \
           AND payload->'data'->'payload'->>'id' = $2",
    )
    .bind(f.workspace)
    .bind(notice_id.to_string())
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        broadcasts, 1,
        "the notice is published through the outbox once"
    );
    // …and the thread it landed in was rolled up beside it.
    let thread_updates: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='broadcast' \
           AND payload->'data'->>'type'='thread.updated'",
    )
    .bind(f.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(thread_updates >= 1, "the reply bumped its root's rollup");

    // Under another workspace's GUC the notice does not exist, and a write
    // aimed at this workspace's channel commits nothing.
    let mut tx = app.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(other.workspace.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let visible: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE props->>'source'=$1 AND workspace_id=$2",
    )
    .bind(NOTICE_SOURCE)
    .bind(f.workspace)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(visible, 0, "another workspace's GUC reads zero notice rows");
    let recent = momo_agent::lock_and_find_recent_notice_in_tx(
        &mut tx,
        f.workspace,
        f.agent,
        f.channel,
        f.channel,
        f.teammate,
        momo_agent::SubscriptionNoticeKind::NonOwner,
    )
    .await
    .unwrap();
    assert!(
        !recent,
        "the throttle cannot see across the tenant boundary either"
    );
    let written = momo_messaging::send_thread_notice_in_tx(
        &mut tx,
        f.workspace,
        momo_messaging::NewMessage::text(f.channel, f.agent, "cross-tenant"),
    )
    .await;
    assert!(written.is_err(), "RLS refuses the cross-tenant write");
    drop(tx);
}

// ---------------------------------------------------------------------------
// D4 「소유자는 바꿀 수 없다」 — enforced by the database
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (2815-*)"]
async fn owner_only_can_never_be_reopened() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    for (sql, what) in [
        (
            "UPDATE agent SET invocation_scope='workspace', subscription_harness=NULL \
             WHERE workspace_id=$1 AND member_id=$2",
            "reopen to the workspace",
        ),
        (
            "UPDATE agent SET owner_human_id=(SELECT id FROM member WHERE workspace_id=$1 \
               AND kind='human' AND id<>(SELECT owner_human_id FROM agent WHERE member_id=$2) \
               LIMIT 1) WHERE workspace_id=$1 AND member_id=$2",
            "hand it to someone else",
        ),
        (
            "UPDATE agent SET subscription_harness='codex' WHERE workspace_id=$1 AND member_id=$2",
            "swap the harness",
        ),
    ] {
        let result = sqlx::query(sql)
            .bind(f.workspace)
            .bind(f.agent)
            .execute(&su)
            .await;
        assert!(result.is_err(), "even a superuser cannot {what}");
    }
    let scope: String = sqlx::query_scalar("SELECT invocation_scope FROM agent WHERE member_id=$1")
        .bind(f.agent)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(scope, "owner_only");
    // The shape check: an owner_only row without a harness is not a row.
    let bare = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'agent','bare',$3)",
    )
    .bind(bare)
    .bind(f.workspace)
    .bind(format!("bare-{}", bare.simple()))
    .execute(&su)
    .await
    .unwrap();
    let inserted = sqlx::query(
        "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id, \
                           invocation_scope) \
         VALUES($1,$2,'m','https://x.invalid/v1',$3,'owner_only')",
    )
    .bind(bare)
    .bind(f.workspace)
    .bind(f.owner)
    .execute(&su)
    .await;
    assert!(
        inserted.is_err(),
        "owner_only without a harness violates the shape"
    );
}

// ---------------------------------------------------------------------------
// the welcome opener
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (2815-*)"]
async fn the_welcome_opener_never_spends_someone_elses_subscription() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let app = momo_app_pool().await;

    let resolve = |member: Uuid, enabled: bool| {
        let app = app.clone();
        let workspace = f.workspace;
        async move {
            momo_db::with_tenant_tx(&app, workspace, move |conn| {
                Box::pin(async move {
                    momo_agent::resolve_welcome_target_in_tx(
                        conn, workspace, true, None, member, enabled,
                    )
                    .await
                })
            })
            .await
            .unwrap()
            .map(|target| target.agent_member_id)
        }
    };
    assert_eq!(
        resolve(f.teammate, true).await,
        None,
        "a teammate is never welcomed on the owner's subscription"
    );
    assert_eq!(resolve(f.owner, true).await, Some(f.agent), "the owner is");
    assert_eq!(
        resolve(f.owner, false).await,
        None,
        "and nobody with the switch off"
    );
    let _ = f.general;
}

// ---------------------------------------------------------------------------
// the subscription join (create)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (2815-*)"]
async fn the_subscription_join_records_owner_only_and_refuses_bad_shapes() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();
    let url = format!(
        "{base}/v1/workspaces/{}/hosted-agent-connections",
        f.workspace
    );

    for body in [
        json!({"invocationScope": "owner_only"}),
        json!({"subscriptionHarness": "codex"}),
        json!({"invocationScope": "owner_only", "subscriptionHarness": "grok"}),
        json!({"invocationScope": "team"}),
    ] {
        let mut request = json!({
            "displayName": "잘못",
            "handle": short_handle("bad"),
        });
        for (key, value) in body.as_object().unwrap() {
            request[key] = value.clone();
        }
        let status = client
            .post(&url)
            .bearer_auth(&f.owner_jwt)
            .json(&request)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16();
        assert_eq!(status, 400, "{request}");
    }

    let created: Value = client
        .post(&url)
        .bearer_auth(&f.owner_jwt)
        .json(&json!({
            "displayName": "내 Codex",
            "handle": short_handle("codex"),
            "invocationScope": "owner_only",
            "subscriptionHarness": "codex",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        created["connection"]["invocationScope"], "owner_only",
        "{created}"
    );
    assert_eq!(created["connection"]["subscriptionHarness"], "codex");
    let agent = Uuid::parse_str(created["connection"]["agentMemberId"].as_str().unwrap()).unwrap();
    let (scope, harness, owner): (String, Option<String>, Option<Uuid>) = sqlx::query_as(
        "SELECT invocation_scope, subscription_harness, owner_human_id FROM agent \
          WHERE member_id=$1",
    )
    .bind(agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(scope, "owner_only");
    assert_eq!(harness.as_deref(), Some("codex"));
    assert_eq!(owner, Some(f.owner), "the creator is the owner");

    let listed: Value = client
        .get(&url)
        .bearer_auth(&f.owner_jwt)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let row = listed["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["agentMemberId"] == json!(agent.to_string()))
        .expect("listed");
    assert_eq!(row["invocationScope"], "owner_only");

    // A team agent through the same door is unchanged.
    let team: Value = client
        .post(&url)
        .bearer_auth(&f.owner_jwt)
        .json(&json!({
            "displayName": "팀 에이전트",
            "handle": short_handle("team"),
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(team["connection"]["invocationScope"], "workspace");
    assert!(team["connection"].get("subscriptionHarness").is_none());
}
