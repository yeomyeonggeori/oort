//! #6068 — the agent's own reaction tool, end to end (ADR-0162 증보 8 R1 ~ R12, RA1 ~ RA9).
//!
//! A hosted agent is mentioned by a person over REST, claims the job through the Agent Port, and then
//! calls `oort_reaction_set` / `oort_expression_names` over real TCP against a real PG18, as the api's
//! runtime role (`momo_app`, no BYPASSRLS). Fixtures are seeded as the superuser. Every test measures
//! **rows** (reactions, audit lines, call traces, run counts, push/inbox/seq), not only the answer.
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:PORT/DB PGHOST=… PGPORT=… PGUSER=… \
//!   PGDATABASE=… PGPASSWORD=… \
//!   cargo test -p momo-server --test agent_reaction_tool_pg -- --ignored --test-threads=1
//! ```
//!
//! | test | acceptance | red when |
//! |---|---|---|
//! | `the_setting_lists_and_closes_the_two_tools` | RA5 | the view stops dropping the two tools, or the narrower-of-two reading goes |
//! | `one_per_message_three_per_run_and_a_removal_gives_none_back` | RA1 | a limit check in `set_agent_reaction_in_tx`, or the count is read from the rows instead of the run |
//! | `every_message_it_may_not_touch_is_one_answer_and_no_row` | RA2 | a target clause (channel, author, deleted, read boundary) |
//! | `a_run_nobody_called_a_settled_run_and_a_foreign_handle_add_nothing` | RA3 | the requester or run-state check in `reaction_run_in_tx` |
//! | `the_emoji_is_the_pickers_spelling_and_never_a_work_state` | RA4 | the status set, the respelling or the expression clause |
//! | `a_reaction_moves_no_seq_inbox_push_or_run` | RA7 | the tool writes anything but the reaction row, its frame and its audit line |
//! | `names_are_names_of_usable_expressions_only` | RA8 | a field beside the name, or a hidden/deleted name |
//! | `a_card_less_registration_is_neither_a_reaction_nor_a_name` | RA4 · RA8 (#6069, ADR-0218 §19 Y2.5) | `grant_id IS NULL` leaves `AGENT_USABLE_EXPRESSION` |
//! | `adds_and_removals_are_audited_and_refusals_only_traced` | RA9 | the audit's `via`/run, an audit row for a refusal, or the trace token |
//!
//! RA6 (the agent's REST reaction door stays closed) is `momo-auth`'s own test, unchanged. The card-less
//! registrations of RA4/RA8 (#6069's `expression.grant_id`) are `a_card_less_registration_is_neither_a_reaction_nor_a_name`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::AgentPortConfig;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "agent-reaction-6068-pg-signing-secret";
const MODERN_VERSION: &str = "2026-07-28";
const PATH: &str = "/v1/mcp/agent-port";
const AUDIENCE: &str = "/v1/mcp/agent-port";
const EYE: &str = "\u{1F440}";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated PostgreSQL 18 URL")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn app_pool() -> PgPool {
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
    panic!("psql client not found");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
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
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_agent_port(AgentPortConfig {
        external_origin: None,
        window_seconds: 60,
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        hosted_delivery_enabled: true,
        hosted_lease_seconds: momo_outbox::HOSTED_LEASE_SECONDS_DEFAULT,
        subscription_agents_enabled: true,
        claude_subscription_agents_enabled: true,
        oauth: Default::default(),
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
// fixtures
// ---------------------------------------------------------------------------

struct Agent {
    id: Uuid,
    bearer: String,
    token: Uuid,
}

struct World {
    su: PgPool,
    base: String,
    http: reqwest::Client,
    ws: Uuid,
    human_jwt: String,
    agent: Agent,
    other: Agent,
    /// The run's channel.
    channel: Uuid,
    /// Another channel the agent's connection is approved for and it belongs to.
    side: Uuid,
}

async fn exec(su: &PgPool, sql: &str, binds: &[Uuid]) {
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    query
        .execute(su)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

async fn count(su: &PgPool, sql: &str, binds: &[Uuid]) -> i64 {
    let mut query = sqlx::query_scalar::<_, i64>(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    query
        .fetch_one(su)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
}

async fn seed_hosted_agent(
    su: &PgPool,
    ws: Uuid,
    human: Uuid,
    approved: &[Uuid],
    name: &str,
) -> Agent {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'agent',$3,$4)",
    )
    .bind(id)
    .bind(ws)
    .bind(name)
    .bind(format!("{name}-{}", &id.simple().to_string()[..8]))
    .execute(su)
    .await
    .expect("agent member");
    sqlx::query(
        "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id, config) \
         VALUES($1,$2,'hosted-agent','https://hosted-agent.invalid/disabled',$3, \
                '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb)",
    )
    .bind(id)
    .bind(ws)
    .bind(human)
    .execute(su)
    .await
    .expect("agent row");
    exec(
        su,
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
        &[ws, id],
    )
    .await;
    exec(
        su,
        "INSERT INTO agent_profile(agent_member_id, workspace_id, updated_by, paused) \
         VALUES($1,$2,$3,false)",
        &[id, ws, human],
    )
    .await;
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
    .bind(ws)
    .bind(id)
    .bind(human)
    .bind(approved.to_vec())
    .execute(su)
    .await
    .expect("connection");
    let bearer = format!(
        "momo_agent_v1.{ws}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let token: Uuid = sqlx::query_scalar(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, created_by) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'), \
                ARRAY['agent:port:connect','agent:inbox:read','messages:read','messages:write', \
                      'agent:jobs:read','agent:runs:callback']::text[], \
                'hosted agent port','hosted_active',$4,$5,$6) RETURNING id",
    )
    .bind(ws)
    .bind(id)
    .bind(&bearer)
    .bind(connection)
    .bind(AUDIENCE)
    .bind(human)
    .fetch_one(su)
    .await
    .expect("token");
    exec(
        su,
        "UPDATE hosted_agent_connection SET status='active', active_token_id=$3, \
           proved_at=now(), proved_by=$4 WHERE workspace_id=$1 AND id=$2",
        &[ws, connection, token, id],
    )
    .await;
    Agent { id, bearer, token }
}

async fn world() -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(ws)
        .bind(format!("react-{}", ws.simple()))
        .execute(&su)
        .await
        .expect("workspace");
    let human = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human','김도현',$3)",
    )
    .bind(human)
    .bind(ws)
    .bind(format!("dohyun-{}", &human.simple().to_string()[..8]))
    .execute(&su)
    .await
    .expect("human");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(human)
    .bind(ws)
    .bind(format!("{human}@react6068.test"))
    .execute(&su)
    .await
    .expect("human identity");
    exec(
        &su,
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'owner')",
        &[ws, human],
    )
    .await;
    let channel = Uuid::new_v4();
    let side = Uuid::new_v4();
    for id in [channel, side] {
        sqlx::query(
            "INSERT INTO channel(id, workspace_id, kind, name, browse_listed) \
             VALUES($1,$2,'public',$3,true)",
        )
        .bind(id)
        .bind(ws)
        .bind(format!("c-{}", id.simple()))
        .execute(&su)
        .await
        .expect("channel");
        exec(
            &su,
            "INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)",
            &[id, ws],
        )
        .await;
    }
    let agent = seed_hosted_agent(&su, ws, human, &[channel, side], "reactor").await;
    let other = seed_hosted_agent(&su, ws, human, &[channel], "bystander").await;
    for id in [channel, side] {
        for member in [human, agent.id, other.id] {
            exec(
                &su,
                "INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)",
                &[ws, id, member],
            )
            .await;
        }
    }
    let human_jwt = momo_auth::sign_access(human, ws, &[], TEST_JWT_SECRET)
        .expect("sign")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'react-6068')",
    )
    .bind(ws)
    .bind(human)
    .bind(&human_jwt)
    .execute(&su)
    .await
    .expect("session");
    set_workspace_mode(&su, ws, Some("free")).await;
    let base = start_server(app_pool().await).await;
    World {
        su,
        base,
        http: reqwest::Client::new(),
        ws,
        human_jwt,
        agent,
        other,
        channel,
        side,
    }
}

async fn set_workspace_mode(su: &PgPool, ws: Uuid, mode: Option<&str>) {
    match mode {
        Some(mode) => sqlx::query(
            "UPDATE workspace SET settings = coalesce(settings, '{}'::jsonb) \
               || jsonb_build_object('agent_reactions', $2::text) WHERE id = $1",
        )
        .bind(ws)
        .bind(mode)
        .execute(su)
        .await
        .expect("workspace mode"),
        None => sqlx::query(
            "UPDATE workspace SET settings = settings - 'agent_reactions' WHERE id = $1",
        )
        .bind(ws)
        .execute(su)
        .await
        .expect("workspace mode"),
    };
}

async fn set_agent_mode(su: &PgPool, agent: Uuid, mode: Option<&str>) {
    sqlx::query("UPDATE agent SET agent_reactions = $2 WHERE member_id = $1")
        .bind(agent)
        .bind(mode)
        .execute(su)
        .await
        .expect("agent mode");
}

/// A person's message in `channel`.
async fn say(w: &World, channel: Uuid, body: &str) -> Uuid {
    let sent: Value = w
        .http
        .post(format!(
            "{}/v1/workspaces/{}/channels/{channel}/messages",
            w.base, w.ws
        ))
        .bearer_auth(&w.human_jwt)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": body}))
        .send()
        .await
        .expect("send")
        .json()
        .await
        .expect("send body");
    Uuid::parse_str(sent["id"].as_str().unwrap_or_else(|| panic!("{sent}"))).unwrap()
}

/// A person mentions the agent in the run channel; the agent claims the job. (trigger, run, handle)
async fn mentioned_run(w: &World) -> (Uuid, Uuid, String) {
    let handle_name: String = sqlx::query_scalar("SELECT handle FROM member WHERE id=$1")
        .bind(w.agent.id)
        .fetch_one(&w.su)
        .await
        .unwrap();
    let trigger = say(w, w.channel, &format!("@{handle_name} 확인 부탁해요")).await;
    let run: Uuid = sqlx::query_scalar(
        "SELECT id FROM agent_run WHERE workspace_id=$1 AND trigger_message_id=$2",
    )
    .bind(w.ws)
    .bind(trigger)
    .fetch_one(&w.su)
    .await
    .expect("the mention raised a run");
    let (status, claimed) = call(w, &w.agent.bearer, "oort_jobs_claim", json!({"limit": 10})).await;
    assert_eq!(status, 200, "{claimed}");
    let handle = claimed["result"]["structuredContent"]["jobs"]
        .as_array()
        .expect("jobs")
        .iter()
        .find_map(|job| job["leaseHandle"].as_str())
        .expect("a handle")
        .to_string();
    (trigger, run, handle)
}

fn body(method: &str, extra: Value) -> Value {
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

async fn call(w: &World, bearer: &str, tool: &str, arguments: Value) -> (u16, Value) {
    let response = w
        .http
        .post(format!("{}{PATH}", w.base))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", "tools/call")
        .header("mcp-name", tool)
        .bearer_auth(bearer)
        .json(&body(
            "tools/call",
            json!({"name": tool, "arguments": arguments}),
        ))
        .send()
        .await
        .expect("tools/call");
    let status = response.status().as_u16();
    (status, response.json().await.expect("JSON-RPC body"))
}

async fn listed(w: &World, bearer: &str) -> Vec<String> {
    let value: Value = w
        .http
        .post(format!("{}{PATH}", w.base))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", "tools/list")
        .bearer_auth(bearer)
        .json(&body("tools/list", json!({})))
        .send()
        .await
        .expect("tools/list")
        .json()
        .await
        .expect("list body");
    value["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_string())
        .collect()
}

async fn react(w: &World, handle: &str, message: Uuid, emoji: &str, action: &str) -> (u16, Value) {
    call(
        w,
        &w.agent.bearer,
        "oort_reaction_set",
        json!({"handle": handle, "messageId": message, "emoji": emoji, "action": action}),
    )
    .await
}

/// The agent's **own** reaction rows on `message`, as stored — the server's status reactions (👀 while
/// it holds the job, ✅ once it succeeded, ADR-0200 증보 8) are the server's, not the agent's choice.
async fn agent_rows(w: &World, message: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT emoji FROM reaction WHERE message_id=$1 AND member_id=$2 \
            AND emoji NOT IN ('\u{1F440}', '\u{2705}') ORDER BY emoji",
    )
    .bind(message)
    .bind(w.agent.id)
    .fetch_all(&w.su)
    .await
    .unwrap()
}

async fn all_agent_rows(w: &World) -> i64 {
    count(
        &w.su,
        "SELECT count(*) FROM reaction WHERE workspace_id=$1 AND member_id=$2 \
            AND emoji NOT IN ('\u{1F440}', '\u{2705}')",
        &[w.ws, w.agent.id],
    )
    .await
}

/// The error envelope without its id: what two refusals must share to be "one answer".
fn shape(status: u16, value: &Value) -> (u16, Value, Value) {
    (
        status,
        value["error"]["code"].clone(),
        json!({"message": value["error"]["message"], "data": value["error"]["data"]}),
    )
}

fn ok(status: u16, value: &Value) -> &Value {
    assert_eq!(status, 200, "{value}");
    &value["result"]["structuredContent"]
}

// ---------------------------------------------------------------------------
// RA5 — the setting
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (DATABASE_URL) + bootstrap_roles.sql"]
async fn the_setting_lists_and_closes_the_two_tools() {
    let w = world().await;
    let (_trigger, _run, handle) = mentioned_run(&w).await;
    let target = say(&w, w.channel, "배포 끝났어요").await;
    let tools = ["oort_reaction_set", "oort_expression_names"];

    let open = listed(&w, &w.agent.bearer).await;
    for tool in tools {
        assert!(open.contains(&tool.to_string()), "{open:?}");
    }
    // Every reading that is not 「자유롭게」 on the narrower side: exactly two fewer, and a call is the
    // unknown-tool answer with no row.
    for (workspace, agent, label) in [
        (None, None, "no key = 상태 표시만"),
        (Some("status"), None, "workspace status"),
        (Some("off"), None, "workspace off"),
        (Some("true"), None, "a word outside the three = off"),
        (Some("free"), Some("status"), "agent narrows"),
        (Some("status"), Some("free"), "agent cannot widen"),
    ] {
        set_workspace_mode(&w.su, w.ws, workspace).await;
        set_agent_mode(&w.su, w.agent.id, agent).await;
        let closed = listed(&w, &w.agent.bearer).await;
        assert_eq!(open.len() - closed.len(), 2, "{label}: {closed:?}");
        for tool in tools {
            assert!(!closed.contains(&tool.to_string()), "{label}");
        }
        let (status, refused) = react(&w, &handle, target, "\u{1F44D}", "add").await;
        let (_, unknown) = call(&w, &w.agent.bearer, "oort_no_such_tool", json!({})).await;
        assert_eq!(status, 400, "{label}: {refused}");
        assert_eq!(
            refused["error"], unknown["error"],
            "{label}: like a tool that does not exist"
        );
        assert_eq!(all_agent_rows(&w).await, 0, "{label}");
    }
    // Opened again: the same handle works — and lowering it mid-run closes the very next call.
    set_workspace_mode(&w.su, w.ws, Some("free")).await;
    set_agent_mode(&w.su, w.agent.id, None).await;
    let (status, added) = react(&w, &handle, target, "\u{1F44D}", "add").await;
    assert_eq!(ok(status, &added)["changed"], json!(true));
    set_agent_mode(&w.su, w.agent.id, Some("off")).await;
    let (status, _) = react(&w, &handle, target, "\u{1F44D}", "remove").await;
    assert_eq!(status, 400, "closed on the next call");
    assert_eq!(
        agent_rows(&w, target).await.len(),
        1,
        "what was put stays (R3)"
    );
}

// ---------------------------------------------------------------------------
// RA1 — the limits
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (DATABASE_URL) + bootstrap_roles.sql"]
async fn one_per_message_three_per_run_and_a_removal_gives_none_back() {
    let w = world().await;
    let (_trigger, run, handle) = mentioned_run(&w).await;
    let a = say(&w, w.channel, "하나").await;
    let b = say(&w, w.channel, "둘").await;
    let c = say(&w, w.channel, "셋").await;
    let d = say(&w, w.channel, "넷").await;

    let (status, value) = react(&w, &handle, a, "\u{1F44D}", "add").await;
    ok(status, &value);
    // The second on one message: refused, still one row.
    let (status, second) = react(&w, &handle, a, "\u{1F389}", "add").await;
    assert_eq!(
        (status, second["error"]["code"].clone()),
        (409, json!(-32005)),
        "{second}"
    );
    assert_eq!(agent_rows(&w, a).await.len(), 1);

    for message in [b, c] {
        let (status, value) = react(&w, &handle, message, "\u{1F64F}", "add").await;
        ok(status, &value);
    }
    let adds: i16 = sqlx::query_scalar("SELECT agent_reaction_count FROM agent_run WHERE id=$1")
        .bind(run)
        .fetch_one(&w.su)
        .await
        .unwrap();
    assert_eq!(adds, 3);
    // Take one off: the count does not come back, and the fourth add is refused.
    let (status, value) = react(&w, &handle, c, "\u{1F64F}", "remove").await;
    assert_eq!(ok(status, &value)["changed"], json!(true));
    let rows_before = all_agent_rows(&w).await;
    let frames_before = count(
        &w.su,
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='broadcast' \
            AND payload->'data'->>'type' LIKE 'reaction.%'",
        &[w.ws],
    )
    .await;
    assert!(
        frames_before >= 5,
        "the frames are counted ({frames_before})"
    );
    for message in [c, d] {
        let (status, fourth) = react(&w, &handle, message, "\u{1F64F}", "add").await;
        assert_eq!(
            (status, fourth["error"]["code"].clone()),
            (409, json!(-32005)),
            "{fourth}"
        );
    }
    assert_eq!(all_agent_rows(&w).await, rows_before);
    assert_eq!(
        count(
            &w.su,
            "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='broadcast' \
                AND payload->'data'->>'type' LIKE 'reaction.%'",
            &[w.ws],
        )
        .await,
        frames_before,
        "no frame for a refused add"
    );
}

// ---------------------------------------------------------------------------
// RA2 — the message
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (DATABASE_URL) + bootstrap_roles.sql"]
async fn every_message_it_may_not_touch_is_one_answer_and_no_row() {
    let w = world().await;
    let (trigger, _run, handle) = mentioned_run(&w).await;
    // ① the agent's own message, ② a deleted one, ③ another channel's, ⑤ an id that is nothing.
    let (status, posted) = call(
        &w,
        &w.agent.bearer,
        "oort_message_post",
        json!({"channelId": w.channel, "clientMsgId": Uuid::new_v4(), "body": "정리했어요"}),
    )
    .await;
    let own = Uuid::parse_str(ok(status, &posted)["messageId"].as_str().unwrap()).unwrap();
    let deleted = say(&w, w.channel, "지울 글").await;
    exec(
        &w.su,
        "UPDATE message SET state='deleted', deleted_at=now() WHERE id=$1",
        &[deleted],
    )
    .await;
    let elsewhere = say(&w, w.side, "다른 방의 글").await;
    let mut answers = Vec::new();
    for (label, message) in [
        ("① its own message", own),
        ("② deleted", deleted),
        ("③ another channel", elsewhere),
        ("⑤ no such message", Uuid::new_v4()),
    ] {
        let (status, refused) = react(&w, &handle, message, "\u{1F44D}", "add").await;
        assert_eq!(status, 409, "{label}: {refused}");
        answers.push((label, shape(status, &refused)));
    }
    // ④ below the agent's read floor: the run's room becomes an admitted room whose seat starts
    // after this message (migration 156's boundary — the one `oort_conversation_read` reads under).
    let before_seat = say(&w, w.channel, "착석 전 글").await;
    let seat_seq: i64 = sqlx::query_scalar("SELECT seq FROM message WHERE id=$1")
        .bind(before_seat)
        .fetch_one(&w.su)
        .await
        .unwrap();
    let after_seat = say(&w, w.channel, "착석 뒤 글").await;
    exec(
        &w.su,
        "UPDATE channel SET kind='dm', browse_listed=false, dm_key='admitted:react-6068-' || id::text \
          WHERE id=$1",
        &[w.channel],
    )
    .await;
    let human: Uuid = sqlx::query_scalar("SELECT author_member_id FROM message WHERE id=$1")
        .bind(trigger)
        .fetch_one(&w.su)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO dm_agent_admission(workspace_id, channel_id, agent_member_id, requested_by, \
           trigger_message_id, required_human_ids, expires_at, admitted_at, admitted_after_seq) \
         VALUES($1,$2,$3,$4,$5,ARRAY[$4]::uuid[],now() + interval '1 day', \
                now() - interval '1 hour', $6)",
    )
    .bind(w.ws)
    .bind(w.channel)
    .bind(w.agent.id)
    .bind(human)
    .bind(trigger)
    .bind(seat_seq)
    .execute(&w.su)
    .await
    .expect("seat the agent after the message");

    // (Checked after the others: once the room is admitted, the earlier messages are below the floor
    // too, and would hide what the other cases measure.)
    let (status, refused) = react(&w, &handle, before_seat, "\u{1F44D}", "add").await;
    assert_eq!(status, 409, "④: {refused}");
    answers.push(("④ below the read floor", shape(status, &refused)));
    for (label, answer) in &answers {
        assert_eq!(answer, &answers[0].1, "{label} answers like the others");
    }
    assert_eq!(answers[0].1 .1, json!(-32004));
    assert_eq!(all_agent_rows(&w).await, 0, "no row for any of them");
    // The control: a person's message after the seat is reachable through the same door.
    let (status, value) = react(&w, &handle, after_seat, "\u{1F44D}", "add").await;
    ok(status, &value);
    assert_eq!(
        agent_rows(&w, after_seat).await,
        vec!["\u{1F44D}\u{FE0F}".to_string()]
    );
}

// ---------------------------------------------------------------------------
// RA3 — the run
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (DATABASE_URL) + bootstrap_roles.sql"]
async fn a_run_nobody_called_a_settled_run_and_a_foreign_handle_add_nothing() {
    let w = world().await;
    let (trigger, run, handle) = mentioned_run(&w).await;
    let target = say(&w, w.channel, "고마워요").await;

    // Nobody called it (a suggestion, a welcome): no calling message.
    exec(
        &w.su,
        "UPDATE agent_run SET trigger_message_id=NULL WHERE id=$1",
        &[run],
    )
    .await;
    let (status, refused) = react(&w, &handle, target, "\u{1F44D}", "add").await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (409, json!(-32004)),
        "{refused}"
    );
    let (status, refused) = call(
        &w,
        &w.agent.bearer,
        "oort_expression_names",
        json!({"handle": handle}),
    )
    .await;
    assert_eq!(status, 409, "{refused}");
    exec(
        &w.su,
        "UPDATE agent_run SET trigger_message_id=$2 WHERE id=$1",
        &[run, trigger],
    )
    .await;

    // Another connection's handle, presented by the other agent.
    let (status, refused) = call(
        &w,
        &w.other.bearer,
        "oort_reaction_set",
        json!({"handle": handle, "messageId": target, "emoji": "\u{1F44D}", "action": "add"}),
    )
    .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (403, json!(-32003)),
        "{refused}"
    );
    let others: i64 = count(
        &w.su,
        "SELECT count(*) FROM reaction WHERE member_id=$1",
        &[w.other.id],
    )
    .await;
    assert_eq!(others, 0);

    // The run ends: its handle speaks no more.
    let (status, done) = call(
        &w,
        &w.agent.bearer,
        "oort_run_complete",
        json!({"leaseHandle": handle, "status": "succeeded", "body": "확인했어요."}),
    )
    .await;
    ok(status, &done);
    let (status, refused) = react(&w, &handle, target, "\u{1F44D}", "add").await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(agent_rows(&w, target).await.len(), 0);
}

// ---------------------------------------------------------------------------
// RA4 — what
// ---------------------------------------------------------------------------

async fn seed_expression(su: &PgPool, ws: Uuid, by: Uuid, name: &str, status: &str) {
    sqlx::query(
        "INSERT INTO expression(workspace_id, name, display_name, tags, origin, created_by, status, \
                                version, hidden_at, deleted_at) \
         VALUES($1,$2,$2,'[\"태그\"]'::jsonb,'{\"kind\":\"upload\"}'::jsonb,$3,$4,1, \
                CASE WHEN $4='hidden' THEN now() END, CASE WHEN $4='deleted' THEN now() END)",
    )
    .bind(ws)
    .bind(name)
    .bind(by)
    .bind(status)
    .execute(su)
    .await
    .unwrap_or_else(|e| panic!("expression {name}: {e}"));
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (DATABASE_URL) + bootstrap_roles.sql"]
async fn the_emoji_is_the_pickers_spelling_and_never_a_work_state() {
    let w = world().await;
    let (trigger, _run, handle) = mentioned_run(&w).await;
    let human: Uuid = sqlx::query_scalar("SELECT author_member_id FROM message WHERE id=$1")
        .bind(trigger)
        .fetch_one(&w.su)
        .await
        .unwrap();
    let target = say(&w, w.channel, "회의 자료 올렸어요").await;
    let plain_argument = {
        let (status, value) = react(&w, &handle, target, "not-an-emoji", "add").await;
        shape(status, &value)
    };
    assert_eq!(plain_argument.0, 400);

    // The fourteen, written out, each in the picker's spelling and bare: the argument answer, no row.
    for emoji in [
        "👀",
        "👁️",
        "👁️‍🗨️",
        "✅",
        "✔️",
        "☑️",
        "🆗",
        "❌",
        "❎",
        "🚫",
        "⛔",
        "⏳",
        "⌛",
        "🔄",
    ] {
        for spelling in [emoji.to_string(), emoji.replace('\u{FE0F}', "")] {
            let (status, refused) = react(&w, &handle, target, &spelling, "add").await;
            assert_eq!(shape(status, &refused), plain_argument, "{spelling:?}");
        }
    }
    // Words that are not one emoji.
    for text in ["승인됨", "ok", "\u{1F44D}\u{1F44D}", " \u{1F44D}"] {
        let (status, refused) = react(&w, &handle, target, text, "add").await;
        assert_eq!(shape(status, &refused), plain_argument, "{text:?}");
    }
    // Team expressions: hidden, deleted and unknown names are the same argument answer.
    seed_expression(&w.su, w.ws, human, "party", "active").await;
    seed_expression(&w.su, w.ws, human, "hush", "hidden").await;
    seed_expression(&w.su, w.ws, human, "gone", "deleted").await;
    for name in [":hush:", ":gone:", ":nope:"] {
        let (status, refused) = react(&w, &handle, target, name, "add").await;
        assert_eq!(shape(status, &refused), plain_argument, "{name}");
    }
    assert_eq!(all_agent_rows(&w).await, 0, "no row for any refusal");

    // Normalised: ❤ without its selector is stored as the picker stores it; the other spelling of the
    // same emoji is the same reaction (the per-message cap holds it), and removing by either spelling
    // takes it off.
    let (status, value) = react(&w, &handle, target, "\u{2764}", "add").await;
    assert_eq!(ok(status, &value)["emoji"], json!("\u{2764}\u{FE0F}"));
    assert_eq!(
        agent_rows(&w, target).await,
        vec!["\u{2764}\u{FE0F}".to_string()]
    );
    let (status, _) = react(&w, &handle, target, "\u{2764}\u{FE0F}", "add").await;
    assert_eq!(status, 409);
    assert_eq!(agent_rows(&w, target).await.len(), 1);
    let (status, value) = react(&w, &handle, target, "\u{2764}", "remove").await;
    assert_eq!(ok(status, &value)["changed"], json!(true));
    assert!(agent_rows(&w, target).await.is_empty());

    // An active expression is a reaction like a person's, stored as `:name:`.
    let other_target = say(&w, w.channel, "축하해요").await;
    let (status, value) = react(&w, &handle, other_target, ":party:", "add").await;
    ok(status, &value);
    assert_eq!(
        agent_rows(&w, other_target).await,
        vec![":party:".to_string()]
    );
    // Hidden afterwards: no new one, but the agent can still take its own off (R8).
    exec(
        &w.su,
        "UPDATE expression SET status='hidden', hidden_at=now() WHERE workspace_id=$1 AND name='party'",
        &[w.ws],
    )
    .await;
    let (status, value) = react(&w, &handle, other_target, ":party:", "remove").await;
    assert_eq!(ok(status, &value)["changed"], json!(true));
    assert!(agent_rows(&w, other_target).await.is_empty());
}

/// RA4 · RA8 for the card-less registrations (#6069, ADR-0218 증보 13 §19 Y2.5 · ADR-0162 증보 8 R6 3): an
/// active expression that carries a standing grant is not something an agent may react with — the plain
/// argument answer and no row — and its name is not in the list, while a person's active one is both.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (DATABASE_URL) + bootstrap_roles.sql"]
async fn a_card_less_registration_is_neither_a_reaction_nor_a_name() {
    let w = world().await;
    let (trigger, _run, handle) = mentioned_run(&w).await;
    let human: Uuid = sqlx::query_scalar("SELECT author_member_id FROM message WHERE id=$1")
        .bind(trigger)
        .fetch_one(&w.su)
        .await
        .unwrap();
    seed_expression(&w.su, w.ws, human, "party", "active").await;
    let grant: Uuid = sqlx::query_scalar(
        "INSERT INTO expression_agent_grant(workspace_id, agent_member_id, granted_by, connection_id, granted_via) \
         VALUES($1, $2, $3, $4, 'settings') RETURNING id",
    )
    .bind(w.ws)
    .bind(w.agent.id)
    .bind(human)
    .bind(Uuid::new_v4())
    .fetch_one(&w.su)
    .await
    .expect("a standing grant");
    sqlx::query(
        "INSERT INTO expression(workspace_id, name, display_name, tags, origin, created_by, proposed_by, grant_id, version) \
         VALUES($1, 'selfmade', 'selfmade', '[]'::jsonb, '{\"kind\":\"generated\"}'::jsonb, $2, $3, $4, 1)",
    )
    .bind(w.ws)
    .bind(human)
    .bind(w.agent.id)
    .bind(grant)
    .execute(&w.su)
    .await
    .expect("a card-less registration");

    let target = say(&w, w.channel, "새 이모티콘 어때요").await;
    let plain_argument = {
        let (status, value) = react(&w, &handle, target, "not-an-emoji", "add").await;
        shape(status, &value)
    };
    let (status, refused) = react(&w, &handle, target, ":selfmade:", "add").await;
    assert_eq!(shape(status, &refused), plain_argument);
    assert!(agent_rows(&w, target).await.is_empty(), "no row for it");
    let (status, value) = react(&w, &handle, target, ":party:", "add").await;
    ok(status, &value);
    assert_eq!(agent_rows(&w, target).await, vec![":party:".to_string()]);

    let (status, value) = call(
        &w,
        &w.agent.bearer,
        "oort_expression_names",
        json!({"handle": handle}),
    )
    .await;
    assert_eq!(
        ok(status, &value),
        &json!({"names": ["party"], "truncated": false})
    );
}

// ---------------------------------------------------------------------------
// RA7 — nothing else moves
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (DATABASE_URL) + bootstrap_roles.sql"]
async fn a_reaction_moves_no_seq_inbox_push_or_run() {
    let w = world().await;
    let (_trigger, _run, handle) = mentioned_run(&w).await;
    let target = say(&w, w.channel, "점심 뭐 먹을까요").await;
    async fn snapshot(w: &World) -> (i64, i64, i64, i64) {
        (
            count(
                &w.su,
                "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='push_candidate'",
                &[w.ws],
            )
            .await,
            count(
                &w.su,
                "SELECT count(*) FROM inbox_item WHERE workspace_id=$1",
                &[w.ws],
            )
            .await,
            count(
                &w.su,
                "SELECT last_seq FROM channel_seq WHERE channel_id=$1",
                &[w.channel],
            )
            .await,
            count(
                &w.su,
                "SELECT count(*) FROM agent_run WHERE workspace_id=$1",
                &[w.ws],
            )
            .await,
        )
    }
    let before = snapshot(&w).await;
    let (status, value) = react(&w, &handle, target, "\u{1F60B}", "add").await;
    ok(status, &value);
    assert_eq!(snapshot(&w).await, before, "after the add");
    let (status, value) = react(&w, &handle, target, "\u{1F60B}", "remove").await;
    ok(status, &value);
    assert_eq!(snapshot(&w).await, before, "after the removal");
    assert_eq!(
        count(
            &w.su,
            "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='broadcast' \
                AND payload->'data'->>'type' IN ('reaction.added','reaction.removed') \
                AND payload->'data'->'payload'->>'emoji' = '\u{1F60B}'",
            &[w.ws],
        )
        .await,
        2,
        "one frame each, the shape a person's tap sends"
    );
}

// ---------------------------------------------------------------------------
// RA8 — the names
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (DATABASE_URL) + bootstrap_roles.sql"]
async fn names_are_names_of_usable_expressions_only() {
    let w = world().await;
    let (trigger, _run, handle) = mentioned_run(&w).await;
    let human: Uuid = sqlx::query_scalar("SELECT author_member_id FROM message WHERE id=$1")
        .bind(trigger)
        .fetch_one(&w.su)
        .await
        .unwrap();
    seed_expression(&w.su, w.ws, human, "party", "active").await;
    seed_expression(&w.su, w.ws, human, "clap", "active").await;
    seed_expression(&w.su, w.ws, human, "hush", "hidden").await;
    seed_expression(&w.su, w.ws, human, "gone", "deleted").await;

    let (status, value) = call(
        &w,
        &w.agent.bearer,
        "oort_expression_names",
        json!({"handle": handle}),
    )
    .await;
    let names = ok(status, &value);
    assert_eq!(
        names,
        &json!({"names": ["clap", "party"], "truncated": false})
    );
    let text = value.to_string();
    for absent in ["태그", "upload", "http", "hush", "gone", &human.to_string()] {
        assert!(!text.contains(absent), "{absent} in {text}");
    }

    // More than the limit: two hundred names and the flag.
    sqlx::query(
        "INSERT INTO expression(workspace_id, name, display_name, tags, origin, created_by, version) \
         SELECT $1, 'bulk' || lpad(g::text, 3, '0'), 'bulk', '[]'::jsonb, '{}'::jsonb, $2, 1 \
           FROM generate_series(1, 200) g",
    )
    .bind(w.ws)
    .bind(human)
    .execute(&w.su)
    .await
    .expect("bulk expressions");
    let (status, value) = call(
        &w,
        &w.agent.bearer,
        "oort_expression_names",
        json!({"handle": handle}),
    )
    .await;
    let names = ok(status, &value);
    assert_eq!(names["names"].as_array().unwrap().len(), 200);
    assert_eq!(names["truncated"], json!(true));
}

// ---------------------------------------------------------------------------
// RA9 — the record
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (DATABASE_URL) + bootstrap_roles.sql"]
async fn adds_and_removals_are_audited_and_refusals_only_traced() {
    let w = world().await;
    let (_trigger, run, handle) = mentioned_run(&w).await;
    let target = say(&w, w.channel, "리뷰 남겼어요").await;
    let (status, value) = react(&w, &handle, target, "\u{1F64F}", "add").await;
    ok(status, &value);
    let (status, value) = react(&w, &handle, target, "\u{1F64F}", "remove").await;
    ok(status, &value);
    let rows: Vec<(String, Option<Uuid>, Option<Uuid>, Value)> = sqlx::query_as(
        "SELECT action, run_id, via_token_id, detail FROM audit_log \
          WHERE workspace_id=$1 AND action LIKE 'reaction.%' AND detail->>'derived' IS NULL \
          ORDER BY created_at, id",
    )
    .bind(w.ws)
    .fetch_all(&w.su)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2, "{rows:?}");
    for ((action, run_id, token, detail), expected) in
        rows.iter().zip(["reaction.added", "reaction.removed"])
    {
        assert_eq!(action, expected);
        assert_eq!(*run_id, Some(run));
        assert_eq!(*token, Some(w.agent.token));
        assert_eq!(detail["via"], json!("agent_port"));
        assert_eq!(detail["run_id"], json!(run.to_string()));
        assert!(
            detail.get("derived").is_none(),
            "not the server's status reaction"
        );
    }

    // The run's own ledger keeps each call as a `tool_call` row (name and closed code only).
    assert_eq!(
        count(
            &w.su,
            "SELECT count(*) FROM agent_run_event WHERE run_id=$1 AND kind='tool_call' \
                AND tool='oort_reaction_set' AND code='ok'",
            &[run],
        )
        .await,
        2
    );

    // Refusals: no audit line, and the call trace carries the closed cause.
    for (emoji, reason) in [
        (EYE, "reaction_status_emoji"),
        ("확인", "reaction_not_emoji"),
        (":nope:", "reaction_expression_unavailable"),
    ] {
        let (status, _) = react(&w, &handle, target, emoji, "add").await;
        assert_eq!(status, 400);
        let traced: Option<String> = sqlx::query_scalar(
            "SELECT detail->>'reason' FROM audit_log \
              WHERE workspace_id=$1 AND action='agent_port.call' AND detail->>'tool'='oort_reaction_set' \
              ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .bind(w.ws)
        .fetch_one(&w.su)
        .await
        .unwrap();
        assert_eq!(traced.as_deref(), Some(reason), "{emoji}");
    }
    let (status, _) = react(&w, &handle, Uuid::new_v4(), "\u{1F64F}", "add").await;
    assert_eq!(status, 409);
    assert_eq!(
        count(
            &w.su,
            "SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND action LIKE 'reaction.%' \
                AND detail->>'derived' IS NULL",
            &[w.ws],
        )
        .await,
        2,
        "a refusal writes no audit line"
    );
}
