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
//! | `an_owner_call_to_a_subscription_agent_with_no_connection_row_is_never_a_worker_job` (#2924) | the owner's mention, work request and welcome of a row-less subscription agent → 0 jobs, the 「연결 안 됨」 line | `OR a.invocation_scope = 'owner_only'` in the three hosted predicates (`mention.rs`, `run.rs`, `welcome.rs`) |
//! | `the_roster_reports_brain_callable_by_owner_and_host_online` (#3392) | roster/hosted-list read contract; humans carry none; other tenant sees nothing | `derive_brain`, `load_agent_read_facts_in_tx`, `HOSTED_RECENTLY_SEEN_SQL` |
//! | `register_creates_names_and_reuses_per_device` (#3392) | default names, `-2`, device suffix, codex, repeat → same agent, active → no value | `default_name_candidates`, `find_subscription_agent_by_device_in_tx`, `reuse_in_tx` |
//! | `register_is_gated_validated_and_capped` (#3392) | member 403, bad input 400, explicit duplicate 409, cap 409 | `require_admin`, validators, `SUBSCRIPTION_AGENTS_PER_HARNESS_LIMIT` |
//! | `register_answers_a_code_when_the_switch_is_off_and_writes_nothing` (#3392) | 409 `subscription_agents_disabled`, 0 rows; non-admin still 403 | kill-switch arm after admin gate |
//! | `register_is_tenant_scoped_and_survives_a_dead_agent_and_a_race` (#3392) | other tenant, dead agent frees its slot, 4 concurrent → 1 row | advisory lock + migration 116 index |
//! | `claude_registration_is_paused_by_default_and_codex_is_not` (#3397 결재) | claude_code → 409 `claude_subscription_agent_paused`, 0 rows; codex → 201; rows report `brainUnavailableReason` only for Claude while off | `claude_enabled` gate in `register`, `AgentReadFacts::unavailable_reason` |
//! | `the_legacy_create_route_honours_the_claude_opt_in_too` (review F1) | `POST …/hosted-agent-connections` with claude_code → 409 coded, 0 rows; codex → 201 | Claude check in `hosted_agent_connections::create` |
//! | `an_existing_claude_subscription_agent_is_not_driven_until_the_instance_opts_in` (#3397 결재) | agent registered before the flag: mention/work request/thread reply/Agent Port → refused with `claude_subscription_agent_paused` + one notice; Codex agent unaffected; flag on → delivered | `owner_only_gate` Claude arm, `tool_view_for` Claude arm, `agent_runs::create` Claude check |
//! | `the_claude_pause_also_covers_welcome_dm_state_and_queued_work` (#3397 review M3) | welcome speaker, DM delivery state, work queued while ON not claimable while OFF | `load_welcome_agent_in_tx` Claude predicate, `hosted_dm_delivery` Claude arm, `tool_view_for` Claude arm |
//! | `a_guest_sees_neither_the_owner_nor_liveness_of_an_agent_it_shares` (review F2) | guest roster: brain/callableBy yes; owner/hostOnline no when owner is not visible | guest narrowing in `roster` |
//! | `a_registered_but_unconnected_subscription_agent_is_never_a_worker_job` (#2924/#2940 regression) | owner call to a freshly registered agent → 0 jobs | `OR a.invocation_scope = 'owner_only'` hosted predicates |

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
const CLAUDE_PAUSED_BODY: &str = "Claude 구독으로 대신 답하는 기능은 Anthropic 확인이 끝날 때까지 쉬고 있어요. 내 작업에서 직접 쓰거나, 설정 › AI 연결에서 API 키로 연결할 수 있어요.";
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
    // The pre-#3397 tests exercise Claude subscription agents, so they opt in.
    start_server_with(pool, subscription_agents_enabled, true).await
}

async fn start_server_with(
    pool: PgPool,
    subscription_agents_enabled: bool,
    claude_subscription_agents_enabled: bool,
) -> String {
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
        claude_subscription_agents_enabled,
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
    seed_with_harness(pool, "claude_code").await
}

async fn seed_with_harness(pool: &PgPool, harness: &str) -> Fixture {
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
        "UPDATE agent SET invocation_scope='owner_only', subscription_harness=$3 \
         WHERE workspace_id=$1 AND member_id=$2",
    )
    .bind(workspace)
    .bind(agent)
    .bind(harness)
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
// #3397 (결재 2026-10-03) — an EXISTING Claude subscription agent is not driven
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3397-*)"]
async fn an_existing_claude_subscription_agent_is_not_driven_until_the_instance_opts_in() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    // The fixture is an owner_only Claude Code agent that already exists and is
    // live — registered before the flag, as far as the server can tell.
    let f = seed(&su).await;
    let app = momo_app_pool().await;
    // The subscription switch is ON; only the Claude opt-in is off (the default).
    let paused = start_server_with(app.clone(), true, false).await;
    let client = reqwest::Client::new();
    let mention = format!("@{} 해 줘", f.agent_handle);

    // Baseline BEFORE the mention, so the mention's own fan-out is compared too.
    let events_before = inbox_message_events(&su, &f).await;

    // Mention by the owner: no job, a stable reason, one user-facing sentence.
    send(
        &client,
        &paused,
        &f,
        &f.owner_jwt,
        f.channel,
        &mention,
        None,
    )
    .await;
    assert_eq!(
        inbox_message_events(&su, &f).await,
        events_before,
        "the mention itself reaches no inbox"
    );
    assert_eq!(
        jobs(&su, &f).await,
        0,
        "paused → the owner's call is not delivered"
    );
    assert_eq!(
        last_skip_reason(&su, &f).await,
        "claude_subscription_agent_paused"
    );
    let posted = notices(&su, &f).await;
    assert_eq!(
        posted.len(),
        1,
        "refused with a reason, never silently dropped"
    );
    assert_eq!(posted[0].0, CLAUDE_PAUSED_BODY);
    assert!(
        !posted[0].0.contains(&f.bearer),
        "the sentence never carries a credential"
    );

    // Thread reply / plain message: not an inbox event either.
    let events = events_before;
    send(
        &client,
        &paused,
        &f,
        &f.owner_jwt,
        f.channel,
        "평범한 말",
        None,
    )
    .await;
    assert_eq!(inbox_message_events(&su, &f).await, events);

    // The dialled-in runtime can call nothing; a work request names the code.
    assert!(list_tools(&client, &paused, &f.bearer).await.is_empty());
    assert_eq!(work_request(&client, &paused, &f, &f.owner_jwt).await, 409);

    // A Codex subscription agent is untouched by the Claude opt-in.
    let codex = seed_with_harness(&su, "codex").await;
    assert!(!list_tools(&client, &paused, &codex.bearer).await.is_empty());
    let codex_mention = format!("@{} 해 줘", codex.agent_handle);
    send(
        &client,
        &paused,
        &codex,
        &codex.owner_jwt,
        codex.channel,
        &codex_mention,
        None,
    )
    .await;
    assert_eq!(
        jobs(&su, &codex).await,
        1,
        "Codex is delivered while Claude is paused"
    );
    assert_eq!(jobs(&su, &f).await, 0, "…and Claude still is not");

    // Opted in: Claude is delivered again.
    let on = start_server_with(app, true, true).await;
    assert!(!list_tools(&client, &on, &f.bearer).await.is_empty());
    send(&client, &on, &f, &f.owner_jwt, f.channel, &mention, None).await;
    assert_eq!(jobs(&su, &f).await, 1, "flag on → delivered");
}

// ---------------------------------------------------------------------------
// #3397 review M3 — the remaining doors of the Claude pause
// ---------------------------------------------------------------------------

async fn claimed_job_count(client: &reqwest::Client, base: &str, bearer: &str) -> usize {
    let (_status, body) = claim_jobs(client, base, bearer).await;
    body["result"]["structuredContent"]["jobs"]
        .as_array()
        .map_or(0, Vec::len)
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3397-*)"]
async fn the_claude_pause_also_covers_welcome_dm_state_and_queued_work() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let app = momo_app_pool().await;
    let client = reqwest::Client::new();
    let on = start_server_with(app.clone(), true, true).await;
    let paused = start_server_with(app.clone(), true, false).await;

    // ---- welcome speaker: the owner is welcomed by their Claude agent only
    // while the Claude opt-in is on.
    let resolve = |claude_enabled: bool| {
        let app = app.clone();
        let (workspace, owner) = (f.workspace, f.owner);
        async move {
            momo_db::with_tenant_tx(&app, workspace, move |conn| {
                Box::pin(async move {
                    momo_agent::resolve_welcome_target_in_tx(
                        conn,
                        workspace,
                        true,
                        None,
                        owner,
                        true,
                        claude_enabled,
                    )
                    .await
                })
            })
            .await
            .unwrap()
            .map(|target| target.agent_member_id)
        }
    };
    assert_eq!(resolve(true).await, Some(f.agent), "positive control");
    assert_eq!(resolve(false).await, None, "Claude paused → no welcome");

    // ---- the owner's 1:1 DM delivery state
    let owner_dm = insert_channel(&su, f.workspace, "dm", None).await;
    join(&su, f.workspace, owner_dm, f.owner).await;
    join(&su, f.workspace, owner_dm, f.agent).await;
    let dm_state = |base: String| {
        let client = client.clone();
        let (workspace, jwt) = (f.workspace, f.owner_jwt.clone());
        async move {
            let body: Value = client
                .get(format!(
                    "{base}/v1/workspaces/{workspace}/channels/{owner_dm}/agent-dm-delivery"
                ))
                .bearer_auth(jwt)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            body["state"].as_str().map(str::to_string)
        }
    };
    assert_eq!(
        dm_state(paused.clone()).await.as_deref(),
        Some("claude_subscription_agent_paused")
    );
    assert_ne!(
        dm_state(on.clone()).await.as_deref(),
        Some("claude_subscription_agent_paused"),
        "positive control"
    );

    // ---- work queued while ON is not claimable while OFF, and is again ON
    let mention = format!("@{} 해 줘", f.agent_handle);
    send(&client, &on, &f, &f.owner_jwt, f.channel, &mention, None).await;
    assert_eq!(jobs(&su, &f).await, 1, "queued while the opt-in was on");
    assert_eq!(
        claimed_job_count(&client, &paused, &f.bearer).await,
        0,
        "a job queued earlier is not handed over while paused"
    );
    assert_eq!(
        claimed_job_count(&client, &on, &f.bearer).await,
        1,
        "…and is handed over once the opt-in is on (no expiry drops it)"
    );
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
                        conn, workspace, true, None, member, enabled, true,
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

// ---------------------------------------------------------------------------
// #2924 — no connection row: the owner's call is still never a team-key job
// ---------------------------------------------------------------------------

/// review-2922 M1, probe P2. A subscription agent whose
/// `hosted_agent_connection` row is gone (operator repair, a future delete
/// path) is still a subscription agent: the owner's own mention, work request
/// and welcome must end in the #2871 「연결 안 됨」 line (or a refusal), never
/// in a `delivery = worker` job the team worker would run on the team key.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (2815-*)"]
async fn an_owner_call_to_a_subscription_agent_with_no_connection_row_is_never_a_worker_job() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    // The row goes (073 allows a direct DELETE while it has no inbox events;
    // its Agent Port token cascades with it).
    sqlx::query("DELETE FROM hosted_agent_connection WHERE workspace_id=$1")
        .bind(f.workspace)
        .execute(&su)
        .await
        .expect("drop the connection row");

    // Gateway mode, so the work request below reaches the agent checks at all
    // (worker mode refuses it upstream); review-2922 P2 measured the mention
    // bypass in both modes.
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
    assert_eq!(
        jobs(&su, &f).await,
        0,
        "the owner's mention of a row-less subscription agent became a job"
    );
    assert_eq!(
        last_skip_reason(&su, &f).await,
        "hosted_connection_unavailable"
    );
    let lines: Vec<(String, String)> = sqlx::query_as(
        "SELECT body, props->>'notice_for_member_id' FROM message \
          WHERE workspace_id=$1 AND author_member_id=$2 \
            AND props->>'source'='server.hosted_agent.notice.v1' ORDER BY seq",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(lines.len(), 1, "one 「연결 안 됨」 line: {lines:?}");
    assert!(lines[0].0.contains("연결이 끊겨"), "{}", lines[0].0);
    assert_eq!(lines[0].1, f.owner.to_string());

    // The owner's work request: refused before any run exists, by the hosted
    // refusal itself (not an unrelated upstream gate).
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/agent-runs",
            f.workspace, f.channel
        ))
        .bearer_auth(&f.owner_jwt)
        .json(&json!({
            "agent_member_id": f.agent,
            "client_run_id": Uuid::new_v4(),
            "input": {"type": "work", "title": "t", "brief": "b"},
        }))
        .send()
        .await
        .expect("agent-runs");
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    assert_eq!(status, 409, "the owner's work request: {body}");
    assert!(
        body.contains("hosted agent delivery is not enabled"),
        "refused by the hosted boundary: {body}"
    );
    assert_eq!(jobs(&su, &f).await, 0, "the work request became a job");

    // The owner's welcome: a hosted agent that cannot be delivered to is not
    // a speaker, so no welcome job is ever written for it.
    let app = momo_app_pool().await;
    let (workspace, owner) = (f.workspace, f.owner);
    let target = momo_db::with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            momo_agent::resolve_welcome_target_in_tx(conn, workspace, true, None, owner, true, true)
                .await
        })
    })
    .await
    .unwrap()
    .map(|target| target.agent_member_id);
    assert_eq!(target, None, "the owner is welcomed on a team-key turn");
    let agent_runs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(agent_runs, 0, "no run was ever created for it");
}

// ---------------------------------------------------------------------------
// #3392 AIH-2 — read contract + register-after-login
// ---------------------------------------------------------------------------

async fn get_json(client: &reqwest::Client, url: &str, jwt: &str) -> (u16, Value) {
    let response = client.get(url).bearer_auth(jwt).send().await.expect("get");
    let status = response.status().as_u16();
    let value = response.json().await.unwrap_or(Value::Null);
    (status, value)
}

async fn register(
    client: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    jwt: &str,
    body: Value,
) -> (u16, Value, Option<String>) {
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{workspace}/subscription-agents/register"
        ))
        .bearer_auth(jwt)
        .json(&body)
        .send()
        .await
        .expect("register");
    let status = response.status().as_u16();
    let cache = response
        .headers()
        .get("cache-control")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let value = response.json().await.unwrap_or(Value::Null);
    (status, value, cache)
}

async fn plain_agent(
    pool: &PgPool,
    f: &Fixture,
    handle: &str,
    model_source: &str,
    hosted: bool,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) VALUES($1,$2,'agent',$3,$3)",
    )
    .bind(id)
    .bind(f.workspace)
    .bind(handle)
    .execute(pool)
    .await
    .expect("agent member");
    sqlx::query(
        "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id, config, model_source) \
         VALUES($1,$2,CASE WHEN $6 THEN 'hosted-agent' ELSE 'm' END, \
                CASE WHEN $6 THEN 'https://hosted-agent.invalid/disabled' ELSE 'https://x.invalid/' END, \
                $3,$4::jsonb,$5)",
    )
    .bind(id)
    .bind(f.workspace)
    .bind(f.owner)
    .bind(if hosted {
        json!({"execution_mode": "hosted_dial_in"})
    } else {
        json!({})
    })
    .bind(model_source)
    .bind(hosted)
    .execute(pool)
    .await
    .expect("agent row");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
    )
    .bind(f.workspace)
    .bind(id)
    .execute(pool)
    .await
    .expect("agent membership");
    id
}

fn roster_row(roster: &Value, id: Uuid) -> &Value {
    roster["members"]
        .as_array()
        .expect("members")
        .iter()
        .find(|row| row["id"] == json!(id.to_string()))
        .unwrap_or_else(|| panic!("{id} missing from roster: {roster}"))
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3392-*)"]
async fn the_roster_reports_brain_callable_by_owner_and_host_online() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let team = plain_agent(&su, &f, &short_handle("team"), "agent", false).await;
    let dflt = plain_agent(&su, &f, &short_handle("dflt"), "instance_default", false).await;
    let ext = plain_agent(&su, &f, &short_handle("ext"), "agent", true).await;
    sqlx::query(
        "INSERT INTO hosted_agent_connection(workspace_id, agent_member_id, pairing_challenge_hash, \
           pairing_expires_at, created_by) VALUES($1,$2,digest('x','sha256'), now()+interval '5 min', $3)",
    )
    .bind(f.workspace)
    .bind(ext)
    .bind(f.owner)
    .execute(&su)
    .await
    .expect("external connection");
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();
    let url = format!("{base}/v1/workspaces/{}/roster", f.workspace);

    // A plain member (not the owner, not an admin) reads the same facts.
    let (status, roster) = get_json(&client, &url, &f.teammate_jwt).await;
    assert_eq!(status, 200, "{roster}");
    let sub = roster_row(&roster, f.agent);
    assert_eq!(sub["brain"], "subscription");
    assert_eq!(sub["callableBy"], "owner_only");
    assert_eq!(sub["owner"]["id"], json!(f.owner.to_string()));
    assert_eq!(sub["owner"]["displayName"], "성재");
    assert_eq!(sub["hostOnline"], true, "the fixture's token was just used");
    let row = roster_row(&roster, team);
    assert_eq!(
        (row["brain"].as_str(), row["callableBy"].as_str()),
        (Some("team_key"), Some("everyone"))
    );
    assert!(
        row.get("owner").is_none() && row.get("hostOnline").is_none(),
        "{row}"
    );
    let row = roster_row(&roster, dflt);
    assert_eq!(row["brain"], "instance_default");
    let row = roster_row(&roster, ext);
    assert_eq!(
        (row["brain"].as_str(), row["callableBy"].as_str()),
        (Some("external"), Some("everyone"))
    );
    assert!(row.get("owner").is_none(), "{row}");
    assert_eq!(row["hostOnline"], false, "dials in, never seen");
    for human in [f.owner, f.teammate] {
        let row = roster_row(&roster, human);
        for key in ["brain", "callableBy", "owner", "hostOnline"] {
            assert!(row.get(key).is_none(), "human row carries {key}: {row}");
        }
    }

    // hostOnline is the 10-minute heuristic: 20 minutes of silence reads false.
    sqlx::query("UPDATE token SET last_used_at = now() - interval '20 minutes' WHERE id=$1")
        .bind(f.token)
        .execute(&su)
        .await
        .unwrap();
    let (_, roster) = get_json(&client, &url, &f.teammate_jwt).await;
    assert_eq!(roster_row(&roster, f.agent)["hostOnline"], false);

    // The hosted-connection list (admin) carries the same four.
    let (status, list) = get_json(
        &client,
        &format!(
            "{base}/v1/workspaces/{}/hosted-agent-connections",
            f.workspace
        ),
        &f.owner_jwt,
    )
    .await;
    assert_eq!(status, 200, "{list}");
    let connection = list["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["agentMemberId"] == json!(f.agent.to_string()))
        .expect("fixture connection");
    assert_eq!(connection["brain"], "subscription");
    assert_eq!(connection["callableBy"], "owner_only");
    assert_eq!(connection["owner"]["displayName"], "성재");

    // Someone from another workspace sees nothing of it.
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(other)
        .bind(format!("sub-{}", other.simple()))
        .execute(&su)
        .await
        .unwrap();
    let (_, outsider_jwt) = insert_human(&su, other, "외부", "owner").await;
    let (status, body) = get_json(&client, &url, &outsider_jwt).await;
    assert!(matches!(status, 401 | 403), "{status} {body}");
    assert!(!body.to_string().contains("subscription"), "{body}");
}

async fn agent_rows_of(pool: &PgPool, f: &Fixture, owner: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM agent WHERE workspace_id=$1 AND owner_human_id=$2 \
           AND subscription_device_id IS NOT NULL",
    )
    .bind(f.workspace)
    .bind(owner)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3392-*)"]
async fn register_creates_names_and_reuses_per_device() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let (minsu, minsu_jwt) = insert_human(&su, f.workspace, "민수", "owner").await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();

    // 1. First call creates: default name, owner_only, paused, value minted once.
    let (status, first, cache) = register(
        &client,
        &base,
        f.workspace,
        &minsu_jwt,
        json!({"harness": "claude_code", "deviceId": "mac-aaaaaaaa"}),
    )
    .await;
    assert_eq!(status, 201, "{first}");
    assert_eq!(cache.as_deref(), Some("no-store"));
    assert_eq!(first["reused"], false);
    assert_eq!(first["agent"]["displayName"], "민수-claude");
    assert!(first["agent"]["handle"]
        .as_str()
        .unwrap()
        .ends_with("-claude"));
    let value = first["pairingCredential"].as_str().expect("one-time value");
    assert!(value.starts_with("momo_pair_v1"), "{value}");
    assert_eq!(first["connection"]["invocationScope"], "owner_only");
    assert_eq!(first["connection"]["subscriptionHarness"], "claude_code");
    let agent_id = Uuid::parse_str(first["agent"]["id"].as_str().unwrap()).unwrap();
    let row: (String, Option<String>, Uuid, String, bool) = sqlx::query_as(
        "SELECT a.invocation_scope, a.subscription_harness, a.owner_human_id, \
                a.subscription_device_id, ap.paused \
           FROM agent a JOIN agent_profile ap ON ap.agent_member_id=a.member_id \
          WHERE a.member_id=$1",
    )
    .bind(agent_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            "owner_only".into(),
            Some("claude_code".into()),
            minsu,
            "mac-aaaaaaaa".into(),
            true
        )
    );
    // Stored as a hash, never the value.
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_agent_connection WHERE pairing_challenge_hash = convert_to($1,'UTF8')",
    )
    .bind(value)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(leaked, 0);
    let audited: Vec<(String,)> = sqlx::query_as(
        "SELECT detail::text FROM audit_log WHERE workspace_id=$1 AND action='subscription_agent.registered'",
    )
    .bind(f.workspace)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(audited.len(), 1);
    assert!(
        !audited[0].0.contains(value) && !audited[0].0.contains("mac-aaaaaaaa"),
        "{}",
        audited[0].0
    );

    // 2. Same (caller, harness, device) again: same agent, fresh value, no second row.
    let hash_before: Vec<u8> = sqlx::query_scalar(
        "SELECT pairing_challenge_hash FROM hosted_agent_connection WHERE agent_member_id=$1",
    )
    .bind(agent_id)
    .fetch_one(&su)
    .await
    .unwrap();
    let (status, again, _) = register(
        &client,
        &base,
        f.workspace,
        &minsu_jwt,
        json!({"harness": "claude_code", "deviceId": "mac-aaaaaaaa"}),
    )
    .await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["reused"], true);
    assert_eq!(again["agent"]["id"], first["agent"]["id"]);
    assert_ne!(again["pairingCredential"], first["pairingCredential"]);
    let hash_after: Vec<u8> = sqlx::query_scalar(
        "SELECT pairing_challenge_hash FROM hosted_agent_connection WHERE agent_member_id=$1",
    )
    .bind(agent_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_ne!(hash_before, hash_after, "the old value must stop working");
    assert_eq!(agent_rows_of(&su, &f, minsu).await, 1);

    // 3. Another Mac, no label: the default collides, so -2.
    let (status, second, _) = register(
        &client,
        &base,
        f.workspace,
        &minsu_jwt,
        json!({"harness": "claude_code", "deviceId": "mac-bbbbbbbb"}),
    )
    .await;
    assert_eq!(status, 201, "{second}");
    assert_eq!(second["agent"]["displayName"], "민수-claude-2");
    assert!(second["agent"]["handle"]
        .as_str()
        .unwrap()
        .ends_with("-claude-2"));

    // 4. Another Mac with a label: the device name is part of the default.
    let (status, third, _) = register(
        &client,
        &base,
        f.workspace,
        &minsu_jwt,
        json!({"harness": "claude_code", "deviceId": "mac-cccccccc", "deviceLabel": "민수의 MacBook Pro"}),
    )
    .await;
    assert_eq!(status, 201, "{third}");
    assert_eq!(third["agent"]["displayName"], "민수-claude-macbookpro");

    // 5. Codex has its own name.
    let (status, codex, _) = register(
        &client,
        &base,
        f.workspace,
        &minsu_jwt,
        json!({"harness": "codex", "deviceId": "mac-aaaaaaaa"}),
    )
    .await;
    assert_eq!(status, 201, "{codex}");
    assert_eq!(codex["agent"]["displayName"], "민수-codex");
    assert_eq!(codex["connection"]["subscriptionHarness"], "codex");

    // 6. Edited before creating: the person's own handle is taken as is.
    let (status, edited, _) = register(
        &client,
        &base,
        f.workspace,
        &minsu_jwt,
        json!({"harness": "codex", "deviceId": "mac-dddddddd", "displayName": "민수의 코덱스", "handle": "minsu-cdx"}),
    )
    .await;
    assert_eq!(status, 201, "{edited}");
    assert_eq!(edited["agent"]["handle"], "minsu-cdx");
    assert_eq!(edited["agent"]["displayName"], "민수의 코덱스");

    // 7. An active connection is reused with no new value (「이미 있음」).
    sqlx::query("UPDATE agent SET subscription_device_id='fixture-device-1' WHERE member_id=$1")
        .bind(f.agent)
        .execute(&su)
        .await
        .unwrap();
    let (status, active, _) = register(
        &client,
        &base,
        f.workspace,
        &f.owner_jwt,
        json!({"harness": "claude_code", "deviceId": "fixture-device-1"}),
    )
    .await;
    assert_eq!(status, 200, "{active}");
    assert_eq!(active["reused"], true);
    assert_eq!(active["connection"]["status"], "active");
    assert!(active.get("pairingCredential").is_none(), "{active}");

    // 8. A disconnected connection gets a new pairing on the same agent.
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='cleanup_pending' WHERE agent_member_id=$1",
    )
    .bind(f.agent)
    .execute(&su)
    .await
    .unwrap();
    let (status, pending, _) = register(
        &client,
        &base,
        f.workspace,
        &f.owner_jwt,
        json!({"harness": "claude_code", "deviceId": "fixture-device-1"}),
    )
    .await;
    assert_eq!(status, 409, "{pending}");
    assert_eq!(
        pending["error"]["code"],
        "subscription_agent_cleanup_pending"
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3392-*)"]
async fn register_is_gated_validated_and_capped() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let (suyeon, suyeon_jwt) = insert_human(&su, f.workspace, "수연", "admin").await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();
    let ok = json!({"harness": "claude_code", "deviceId": "gate-aaaaaaaa"});

    // A plain member may not (same as 「구독 추가」), and nothing is written.
    let (status, body, _) =
        register(&client, &base, f.workspace, &f.teammate_jwt, ok.clone()).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(agent_rows_of(&su, &f, f.teammate).await, 0);
    // Unauthenticated.
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{}/subscription-agents/register",
            f.workspace
        ))
        .json(&ok)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 401);

    for bad in [
        json!({"harness": "grok", "deviceId": "gate-aaaaaaaa"}),
        json!({"harness": "claude_code", "deviceId": "short"}),
        json!({"harness": "claude_code", "deviceId": "has space in it"}),
        json!({"harness": "claude_code", "deviceId": "gate-aaaaaaaa", "handle": "Bad Handle!"}),
        json!({"harness": "claude_code", "deviceId": "gate-aaaaaaaa", "invocationScope": "workspace"}),
    ] {
        let (status, body, _) =
            register(&client, &base, f.workspace, &suyeon_jwt, bad.clone()).await;
        assert!(matches!(status, 400 | 422), "{bad} -> {status} {body}");
    }
    assert_eq!(
        agent_rows_of(&su, &f, suyeon).await,
        0,
        "a refused call wrote nothing"
    );

    // An explicit handle that exists is a plain 409 (no suffixing the person's choice).
    let (status, _, _) = register(
        &client,
        &base,
        f.workspace,
        &suyeon_jwt,
        json!({"harness": "codex", "deviceId": "gate-bbbbbbbb", "handle": "suyeon-x"}),
    )
    .await;
    assert_eq!(status, 201);
    let (status, body, _) = register(
        &client,
        &base,
        f.workspace,
        &suyeon_jwt,
        json!({"harness": "codex", "deviceId": "gate-cccccccc", "handle": "suyeon-x"}),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert!(body["error"].get("code").is_none(), "{body}");

    // The cap: five per CLI, the sixth is refused with a code.
    for n in 0..5 {
        let (status, body, _) = register(
            &client,
            &base,
            f.workspace,
            &suyeon_jwt,
            json!({"harness": "claude_code", "deviceId": format!("cap-device-{n}")}),
        )
        .await;
        assert_eq!(status, 201, "{n}: {body}");
    }
    let (status, body, _) = register(
        &client,
        &base,
        f.workspace,
        &suyeon_jwt,
        json!({"harness": "claude_code", "deviceId": "cap-device-5"}),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"]["code"], "subscription_agent_limit");
    // Already-registered devices still answer (reuse is not capped).
    let (status, _, _) = register(
        &client,
        &base,
        f.workspace,
        &suyeon_jwt,
        json!({"harness": "claude_code", "deviceId": "cap-device-0"}),
    )
    .await;
    assert_eq!(status, 200);
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3392-*)"]
async fn register_answers_a_code_when_the_switch_is_off_and_writes_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, false).await;
    let client = reqwest::Client::new();
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM member WHERE workspace_id=$1")
        .bind(f.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    let body = json!({"harness": "claude_code", "deviceId": "off-device-1"});
    let (status, value, _) =
        register(&client, &base, f.workspace, &f.owner_jwt, body.clone()).await;
    assert_eq!(status, 409, "{value}");
    assert_eq!(value["error"]["code"], "subscription_agents_disabled");
    // A member who may not register hears 403, not the operator's switch.
    let (status, value, _) = register(&client, &base, f.workspace, &f.teammate_jwt, body).await;
    assert_eq!(status, 403, "{value}");
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM member WHERE workspace_id=$1")
        .bind(f.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(before, after);
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3392-*)"]
async fn register_is_tenant_scoped_and_survives_a_dead_agent_and_a_race() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();

    // Another workspace: the same device id is a different agent; this workspace's
    // path refuses that workspace's token.
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(other)
        .bind(format!("sub-{}", other.simple()))
        .execute(&su)
        .await
        .unwrap();
    let (other_owner, other_jwt) = insert_human(&su, other, "다른팀", "owner").await;
    let body = json!({"harness": "claude_code", "deviceId": "shared-device-1"});
    let (status, mine, _) = register(&client, &base, f.workspace, &f.owner_jwt, body.clone()).await;
    assert_eq!(status, 201, "{mine}");
    let (status, theirs, _) = register(&client, &base, other, &other_jwt, body.clone()).await;
    assert_eq!(status, 201, "{theirs}");
    assert_ne!(mine["agent"]["id"], theirs["agent"]["id"]);
    let (status, cross, _) = register(&client, &base, f.workspace, &other_jwt, body.clone()).await;
    assert!(matches!(status, 401 | 403), "{status} {cross}");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM agent WHERE workspace_id=$1 AND owner_human_id=$2"
        )
        .bind(f.workspace)
        .bind(other_owner)
        .fetch_one(&su)
        .await
        .unwrap(),
        0
    );

    // A dead agent frees its Mac's slot: registering again makes a new one.
    sqlx::query("UPDATE member SET status='suspended' WHERE id=$1")
        .bind(Uuid::parse_str(mine["agent"]["id"].as_str().unwrap()).unwrap())
        .execute(&su)
        .await
        .unwrap();
    let (status, reborn, _) =
        register(&client, &base, f.workspace, &f.owner_jwt, body.clone()).await;
    assert_eq!(status, 201, "{reborn}");
    assert_ne!(reborn["agent"]["id"], mine["agent"]["id"]);

    // Four concurrent first calls for one new device converge on one row.
    let (racer, racer_jwt) = insert_human(&su, f.workspace, "경합", "owner").await;
    let race = json!({"harness": "codex", "deviceId": "race-device-1"});
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let (client, base, jwt, race) = (
                client.clone(),
                base.clone(),
                racer_jwt.clone(),
                race.clone(),
            );
            let workspace = f.workspace;
            tokio::spawn(async move { register(&client, &base, workspace, &jwt, race).await })
        })
        .collect();
    let mut results = Vec::new();
    for handle in handles {
        results.push(handle.await.expect("racer"));
    }
    let created = results
        .iter()
        .filter(|(status, _, _)| *status == 201)
        .count();
    let reused = results
        .iter()
        .filter(|(status, _, _)| *status == 200)
        .count();
    assert_eq!((created, reused), (1, 3), "{results:?}");
    assert_eq!(agent_rows_of(&su, &f, racer).await, 1);
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3392-*)"]
async fn a_registered_but_unconnected_subscription_agent_is_never_a_worker_job() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();
    let (status, made, _) = register(
        &client,
        &base,
        f.workspace,
        &f.owner_jwt,
        json!({"harness": "claude_code", "deviceId": "regress-device-1"}),
    )
    .await;
    assert_eq!(status, 201, "{made}");
    let agent = Uuid::parse_str(made["agent"]["id"].as_str().unwrap()).unwrap();
    let handle = made["agent"]["handle"].as_str().unwrap().to_string();
    join(&su, f.workspace, f.channel, agent).await;
    send(
        &client,
        &base,
        &f,
        &f.owner_jwt,
        f.channel,
        &format!("@{handle} 부탁해"),
        None,
    )
    .await;
    let for_agent: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND payload::text LIKE '%' || $2::text || '%'",
    )
    .bind(f.workspace)
    .bind(agent.to_string())
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        for_agent, 0,
        "the owner's call to a registered, unconnected subscription agent became a job"
    );
    let runs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(f.workspace)
    .bind(agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        runs, 0,
        "no run — and so no team-key spend — was created for it"
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3392-*)"]
async fn claude_registration_is_paused_by_default_and_codex_is_not() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let client = reqwest::Client::new();
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM member WHERE workspace_id=$1")
        .bind(f.workspace)
        .fetch_one(&su)
        .await
        .unwrap();

    // Default config of this decision: the Claude opt-in is off.
    let off = start_server_with(momo_app_pool().await, true, false).await;
    let (status, body, _) = register(
        &client,
        &off,
        f.workspace,
        &f.owner_jwt,
        json!({"harness": "claude_code", "deviceId": "paused-device-1"}),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"]["code"], "claude_subscription_agent_paused");
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM member WHERE workspace_id=$1")
        .bind(f.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(before, after, "a paused registration wrote nothing");
    // A member who may not register still hears 403 first.
    let (status, _, _) = register(
        &client,
        &off,
        f.workspace,
        &f.teammate_jwt,
        json!({"harness": "claude_code", "deviceId": "paused-device-1"}),
    )
    .await;
    assert_eq!(status, 403);
    // The general kill switch speaks before the Claude one.
    let both_off = start_server_with(momo_app_pool().await, false, false).await;
    let (_, body, _) = register(
        &client,
        &both_off,
        f.workspace,
        &f.owner_jwt,
        json!({"harness": "claude_code", "deviceId": "paused-device-1"}),
    )
    .await;
    assert_eq!(body["error"]["code"], "subscription_agents_disabled");

    // Codex is unaffected by the Claude opt-in.
    let (status, codex, _) = register(
        &client,
        &off,
        f.workspace,
        &f.owner_jwt,
        json!({"harness": "codex", "deviceId": "paused-device-1"}),
    )
    .await;
    assert_eq!(status, 201, "{codex}");
    let codex_id = Uuid::parse_str(codex["agent"]["id"].as_str().unwrap()).unwrap();

    // Status field: only a Claude subscription agent, only while the opt-in is off.
    let url = format!("{off}/v1/workspaces/{}/roster", f.workspace);
    let (_, roster) = get_json(&client, &url, &f.teammate_jwt).await;
    assert_eq!(
        roster_row(&roster, f.agent)["brainUnavailableReason"],
        "claude_subscription_agent_paused"
    );
    assert!(roster_row(&roster, codex_id)
        .get("brainUnavailableReason")
        .is_none());
    assert!(roster_row(&roster, f.owner)
        .get("brainUnavailableReason")
        .is_none());
    let (_, list) = get_json(
        &client,
        &format!(
            "{off}/v1/workspaces/{}/hosted-agent-connections",
            f.workspace
        ),
        &f.owner_jwt,
    )
    .await;
    let claude_row = list["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["agentMemberId"] == json!(f.agent.to_string()))
        .unwrap();
    assert_eq!(
        claude_row["brainUnavailableReason"],
        "claude_subscription_agent_paused"
    );

    // Opted in: the same agent reports nothing and Claude registers.
    let on = start_server_with(momo_app_pool().await, true, true).await;
    let (_, roster) = get_json(
        &client,
        &format!("{on}/v1/workspaces/{}/roster", f.workspace),
        &f.teammate_jwt,
    )
    .await;
    assert!(roster_row(&roster, f.agent)
        .get("brainUnavailableReason")
        .is_none());
    let (status, body, _) = register(
        &client,
        &on,
        f.workspace,
        &f.owner_jwt,
        json!({"harness": "claude_code", "deviceId": "paused-device-1"}),
    )
    .await;
    assert_eq!(status, 201, "{body}");
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3392-*)"]
async fn the_legacy_create_route_honours_the_claude_opt_in_too() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let client = reqwest::Client::new();
    let off = start_server_with(momo_app_pool().await, true, false).await;
    let url = format!(
        "{off}/v1/workspaces/{}/hosted-agent-connections",
        f.workspace
    );
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM member WHERE workspace_id=$1")
        .bind(f.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    let response = client
        .post(&url)
        .bearer_auth(&f.owner_jwt)
        .json(
            &json!({"displayName": "클로드", "handle": short_handle("cl"),
                      "invocationScope": "owner_only", "subscriptionHarness": "claude_code"}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 409);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "claude_subscription_agent_paused");
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM member WHERE workspace_id=$1")
        .bind(f.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(before, after, "the refused legacy create wrote nothing");
    let response = client
        .post(&url)
        .bearer_auth(&f.owner_jwt)
        .json(
            &json!({"displayName": "코덱스", "handle": short_handle("cx"),
                      "invocationScope": "owner_only", "subscriptionHarness": "codex"}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 201, "Codex is not paused");
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3392-*)"]
async fn a_guest_sees_neither_the_owner_nor_liveness_of_an_agent_it_shares() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let (guest, guest_jwt) = insert_human(&su, f.workspace, "손님", "guest").await;
    // A room with only the guest and the agent: the owner is in none of the
    // guest's channels.
    let room = insert_channel(&su, f.workspace, "public", Some("guest-room")).await;
    join(&su, f.workspace, room, guest).await;
    join(&su, f.workspace, room, f.agent).await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();
    let (status, roster) = get_json(
        &client,
        &format!("{base}/v1/workspaces/{}/roster", f.workspace),
        &guest_jwt,
    )
    .await;
    assert_eq!(status, 200, "{roster}");
    let row = roster_row(&roster, f.agent);
    assert_eq!(row["brain"], "subscription");
    assert_eq!(row["callableBy"], "owner_only");
    assert!(row.get("owner").is_none(), "owner leaked to a guest: {row}");
    assert!(
        row.get("hostOnline").is_none(),
        "liveness leaked to a guest: {row}"
    );
    assert!(
        !roster["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == json!(f.owner.to_string())),
        "the owner is not on the guest's roster"
    );
}
