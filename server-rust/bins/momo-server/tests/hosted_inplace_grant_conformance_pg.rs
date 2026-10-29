//! ADR-0162 증보 5 G1~G6 (#3857) — the in-place 「이 채널에서 쓰기」 card, end
//! to end through the real Axum router on a `momo_app` (NOBYPASSRLS) pool.
//!
//! | test | G6 | proves |
//! |---|---|---|
//! | `an_unapproved_mention_holds_a_run_and_raises_one_card_with_no_job` | ① ⑥ | run `awaiting_approval` (hold marker, deadline), 1 pending approval (`server_in_place`, pins), 1 card in the caller's thread, **0 job / 0 inbox / 0 notice**, no `queued` ledger row; a second call is coalesced (0 run, 0 card, 1 audit); the held run does not use the concurrency slot; only admins list it |
//! | `approving_widens_the_grant_and_releases_exactly_one_job` | ② ⑨ | 200; channel granted + agent seated; run `queued`; exactly 1 job + 1 inbox reference; replay = same receipt, still 1 job; another decision = 409, still 1 job; two concurrent claims hand it out once |
//! | `a_run_that_left_the_hold_rolls_the_whole_decision_back` | ③ | person's cancel before approval → 409, channel not granted, 0 job; a run that left the hold under a still-pending approval → 409 `run_not_parked`, grant rolled back, approval still pending |
//! | `expiry_settles_the_held_run_and_there_is_no_job_to_reclaim` | ④ | the production sweep → `timed_out{approval_expired}`, 0 job, channel not granted, Korean line; a late click settles the same way; a new call after expiry raises a new card |
//! | `only_an_admin_in_the_room_can_decide_and_outsiders_see_nothing` | ⑤ | non-member admin → 404 identical to an unknown id; plain member → 403 `role_required`, nothing spent |
//! | `dm_agent_authored_and_switched_off_calls_keep_the_old_line` | ⑦ | DM, an agent's send, and the switch off → notice line (or A2A skip), 0 card |
//! | `rejection_ends_the_held_run_with_a_reason_the_caller_reads` | G4 | run `cancelled{channel_grant_rejected}`, Korean outcome line, 0 job, channel not granted; next call raises a new card |
//! | `the_per_connection_ceiling_falls_back_to_the_notice_line` | G2 | 5 pending cards per connection, the 6th room gets the notice line |
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
use momo_server::config::{AgentPortConfig, MentionSettings};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "hosted-inplace-grant-pg-conformance-signing-secret";
const MODERN_VERSION: &str = "2026-07-28";
const PATH: &str = "/v1/mcp/agent-port";
const AUDIENCE: &str = "/v1/mcp/agent-port";
const FULL_SCOPES: [&str; 7] = [
    "agent:port:connect",
    "agent:inbox:read",
    "messages:read",
    "messages:write",
    "agent:jobs:read",
    "agent:runs:callback",
    "workspace:propose",
];

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated PostgreSQL 18 URL")
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
        .expect("connect as superuser")
}

async fn role_pool(role: &str, password_env: &str, default_password: &str) -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(16)
        .connect_with(options.username(role).password(
            &std::env::var(password_env).unwrap_or_else(|_| default_password.to_string()),
        ))
        .await
        .expect("connect after bootstrap_roles.sql")
}

async fn momo_app_pool() -> PgPool {
    role_pool("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await
}

async fn momo_notifier_pool() -> PgPool {
    role_pool(
        "momo_notifier",
        "MOMO_NOTIFIER_PASSWORD",
        "momo_notifier_dev_pw",
    )
    .await
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

async fn start_server(pool: PgPool, inplace_grant_enabled: bool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_agent_port(AgentPortConfig {
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        hosted_delivery_enabled: true,
        ..AgentPortConfig::default()
    })
    .with_mentions(MentionSettings {
        hosted_inplace_grant_enabled: inplace_grant_enabled,
        ..MentionSettings::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind conformance server");
    let address: SocketAddr = listener.local_addr().expect("server address");
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

struct Person {
    id: Uuid,
    jwt: String,
}

struct Fixture {
    workspace: Uuid,
    /// Workspace owner, in every room — the decider.
    owner: Person,
    /// Plain workspace member, in `room` — sees the card, cannot decide it.
    member: Person,
    /// Workspace admin who is in NO room but `home`.
    outsider_admin: Person,
    agent: Uuid,
    agent_handle: String,
    connection: Uuid,
    bearer: String,
    /// A second hosted agent approved for `home` AND `room` (the A2A case).
    helper_bearer: String,
    /// Approved for the agent's connection at confirm.
    home: Uuid,
    /// Not approved — where the card is raised.
    room: Uuid,
}

fn raw_credential(workspace: Uuid) -> String {
    format!(
        "momo_agent_v1.{workspace}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

async fn seed_human(pool: &PgPool, workspace: Uuid, name: &str, role: &str) -> Person {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human',$3,$4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(name)
    .bind(format!("{name}-{}", id.simple()))
    .execute(pool)
    .await
    .expect("seed human");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(id)
    .bind(workspace)
    .bind(format!("{id}@grant.test"))
    .execute(pool)
    .await
    .expect("seed human identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) \
         VALUES($1,$2,$3::membership_role)",
    )
    .bind(workspace)
    .bind(id)
    .bind(role)
    .execute(pool)
    .await
    .expect("seed workspace membership");
    let jwt = momo_auth::sign_access(id, workspace, &[], TEST_JWT_SECRET)
        .expect("sign a human App JWT")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'inplace-grant')",
    )
    .bind(workspace)
    .bind(id)
    .bind(&jwt)
    .execute(pool)
    .await
    .expect("record the session token");
    Person { id, jwt }
}

async fn seed_channel(pool: &PgPool, workspace: Uuid, name: &str, members: &[Uuid]) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO channel(id, workspace_id, kind, name) VALUES($1,$2,'public',$3)")
        .bind(id)
        .bind(workspace)
        .bind(format!("{name}-{}", &id.simple().to_string()[..8]))
        .execute(pool)
        .await
        .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
        .bind(id)
        .bind(workspace)
        .execute(pool)
        .await
        .expect("seed channel_seq");
    for member in members {
        sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
            .bind(workspace)
            .bind(id)
            .bind(member)
            .execute(pool)
            .await
            .expect("seed membership");
    }
    id
}

/// A hosted agent with an active, proved connection approved for `approved`.
async fn seed_hosted_agent(
    pool: &PgPool,
    workspace: Uuid,
    owner: Uuid,
    handle: &str,
    approved: &[Uuid],
) -> (Uuid, Uuid, String) {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'agent',$3,$4)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(format!("{handle} 봇"))
    .bind(format!("{handle}-{}", agent.simple()))
    .execute(pool)
    .await
    .expect("seed agent member");
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
    .expect("seed agent row");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
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
    .bind(owner)
    .execute(pool)
    .await
    .expect("seed agent profile");

    let connection = Uuid::new_v4();
    let scopes: Vec<String> = FULL_SCOPES.iter().map(|s| s.to_string()).collect();
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_consumed_at,detected_at,detected_by, \
           confirmed_by,confirmed_at,approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,$3,'detected',now(),now(),$4,$4,now(),$5,$6,$4)",
    )
    .bind(connection)
    .bind(workspace)
    .bind(agent)
    .bind(owner)
    .bind(approved.to_vec())
    .bind(&scopes)
    .execute(pool)
    .await
    .expect("seed hosted connection");
    let bearer = raw_credential(workspace);
    let token: Uuid = sqlx::query_scalar(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, created_by) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'),$4,'hosted agent port', \
                'hosted_active',$5,$6,$7) RETURNING id",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&bearer)
    .bind(&scopes)
    .bind(connection)
    .bind(AUDIENCE)
    .bind(owner)
    .fetch_one(pool)
    .await
    .expect("seed hosted bearer");
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
    (agent, connection, bearer)
}

async fn join(pool: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3) \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .execute(pool)
    .await
    .expect("join channel");
}

async fn seed(pool: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("grant-{}", workspace.simple()))
        .execute(pool)
        .await
        .expect("seed workspace");
    let owner = seed_human(pool, workspace, "owner", "owner").await;
    let member = seed_human(pool, workspace, "member", "member").await;
    let outsider_admin = seed_human(pool, workspace, "outsider", "admin").await;

    let home = seed_channel(
        pool,
        workspace,
        "home",
        &[owner.id, member.id, outsider_admin.id],
    )
    .await;
    let room = seed_channel(pool, workspace, "room", &[owner.id, member.id]).await;

    let (agent, connection, bearer) =
        seed_hosted_agent(pool, workspace, owner.id, "grok", &[home]).await;
    let (helper, _, helper_bearer) =
        seed_hosted_agent(pool, workspace, owner.id, "helper", &[home, room]).await;
    for channel in [home, room] {
        join(pool, workspace, channel, agent).await;
        join(pool, workspace, channel, helper).await;
    }
    let agent_handle: String = sqlx::query_scalar("SELECT handle FROM member WHERE id=$1")
        .bind(agent)
        .fetch_one(pool)
        .await
        .unwrap();
    Fixture {
        workspace,
        owner,
        member,
        outsider_admin,
        agent,
        agent_handle,
        connection,
        bearer,
        helper_bearer,
        home,
        room,
    }
}

// ---------------------------------------------------------------------------
// wire + read helpers
// ---------------------------------------------------------------------------

async fn send(
    client: &reqwest::Client,
    base: &str,
    f: &Fixture,
    jwt: &str,
    channel: Uuid,
    body: &str,
) -> Value {
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{channel}/messages",
            f.workspace
        ))
        .bearer_auth(jwt)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": body}))
        .send()
        .await
        .expect("send responds");
    let status = response.status().as_u16();
    let value: Value = response.json().await.expect("send body");
    assert!(
        (200..300).contains(&status) && value["id"].is_string(),
        "{status} {value}"
    );
    value
}

async fn decide(
    client: &reqwest::Client,
    base: &str,
    f: &Fixture,
    jwt: &str,
    approval: Uuid,
    approve: bool,
    client_decision_id: Uuid,
) -> (u16, Value) {
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{}/approvals/{approval}/decision",
            f.workspace
        ))
        .bearer_auth(jwt)
        .json(&json!({
            "approval_id": approval,
            "approve": approve,
            "client_decision_id": client_decision_id,
        }))
        .send()
        .await
        .expect("decision responds");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn tool(
    client: &reqwest::Client,
    base: &str,
    bearer: &str,
    name: &str,
    args: Value,
) -> Value {
    let body = json!({
        "jsonrpc": "2.0",
        "id": Uuid::new_v4().to_string(),
        "method": "tools/call",
        "params": {
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
                "io.modelcontextprotocol/clientCapabilities": {}
            },
            "name": name,
            "arguments": args,
        }
    });
    let response = client
        .post(format!("{base}{PATH}"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", "tools/call")
        .header("mcp-name", name)
        .bearer_auth(bearer)
        .json(&body)
        .send()
        .await
        .expect("tools/call responds");
    assert_eq!(response.status().as_u16(), 200);
    response.json().await.expect("JSON-RPC body")
}

async fn count(pool: &PgPool, sql: &str, workspace: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(workspace)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|error| panic!("{sql}: {error}"))
}

async fn jobs_for_agent(pool: &PgPool, f: &Fixture) -> i64 {
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

async fn inbox_events(pool: &PgPool, f: &Fixture) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM hosted_agent_inbox_event WHERE workspace_id=$1 \
           AND agent_member_id=$2",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn room_granted(pool: &PgPool, f: &Fixture, channel: Uuid) -> bool {
    sqlx::query_scalar(
        "SELECT $3 = ANY(approved_channel_ids) FROM hosted_agent_connection \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(f.workspace)
    .bind(f.connection)
    .bind(channel)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// `(approval id, run id, card message id)` of the pending in-place cards in
/// `channel`, oldest first.
async fn in_place_cards(pool: &PgPool, f: &Fixture, channel: Uuid) -> Vec<(Uuid, Uuid, Uuid)> {
    sqlx::query_as(
        "SELECT id, run_id, request_message_id FROM approval \
          WHERE workspace_id=$1 AND channel_id=$2 AND payload->>'origin'='server_in_place' \
          ORDER BY created_at",
    )
    .bind(f.workspace)
    .bind(channel)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn run_state(pool: &PgPool, run: Uuid) -> (String, Option<String>) {
    sqlx::query_as("SELECT status::text, error->>'code' FROM agent_run WHERE id=$1")
        .bind(run)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn notices(pool: &PgPool, f: &Fixture, channel: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT props->>'reason' FROM message WHERE workspace_id=$1 AND channel_id=$2 \
            AND props->>'source'='server.hosted_agent.notice.v1' ORDER BY seq",
    )
    .bind(f.workspace)
    .bind(channel)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn approvals_listed(
    client: &reqwest::Client,
    base: &str,
    f: &Fixture,
    jwt: &str,
) -> Vec<String> {
    let value: Value = client
        .get(format!(
            "{base}/v1/workspaces/{}/approvals?status=pending",
            f.workspace
        ))
        .bearer_auth(jwt)
        .send()
        .await
        .expect("list approvals")
        .json()
        .await
        .expect("approvals body");
    value["approvals"]
        .as_array()
        .expect("approvals array")
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_string())
        .collect()
}

/// One explicit mention of the agent in `room`, then the one card it raised.
async fn raise_card(
    client: &reqwest::Client,
    base: &str,
    su: &PgPool,
    f: &Fixture,
    room: Uuid,
) -> (Uuid, Uuid, Uuid) {
    send(
        client,
        base,
        f,
        &f.owner.jwt,
        room,
        &format!("@{} 이 방 PR 좀 봐 줄래요?", f.agent_handle),
    )
    .await;
    let cards = in_place_cards(su, f, room).await;
    assert_eq!(cards.len(), 1, "one card for the call");
    cards[0]
}

// ---------------------------------------------------------------------------
// ① ⑥ — the producer
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3857)"]
async fn an_unapproved_mention_holds_a_run_and_raises_one_card_with_no_job() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();

    // A thread in the room, so "the card lands where the person spoke" is
    // measurable.
    let root = send(&client, &base, &f, &f.owner.jwt, f.room, "배포 얘기").await;
    let root_id = Uuid::parse_str(root["id"].as_str().unwrap()).unwrap();
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            f.workspace, f.room
        ))
        .bearer_auth(&f.owner.jwt)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "rootId": root_id,
            "body": format!("@{} 이 스레드 정리해 줘요", f.agent_handle),
        }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success(), "{}", response.status());

    // ① — run, approval and card, each exactly once; NO job.
    let cards = in_place_cards(&su, &f, f.room).await;
    assert_eq!(cards.len(), 1, "{cards:?}");
    let (approval, run, card) = cards[0];
    let (status, _) = run_state(&su, run).await;
    assert_eq!(status, "awaiting_approval");
    let (hold, has_deadline, trigger_kind): (Option<String>, bool, Option<String>) =
        sqlx::query_as(
            "SELECT input->>'hold', deadline_at IS NOT NULL, input->>'surface' \
               FROM agent_run WHERE id=$1",
        )
        .bind(run)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(hold.as_deref(), Some("channel_grant"));
    assert!(has_deadline, "the hold is bounded by the approval's expiry");
    assert_eq!(trigger_kind.as_deref(), Some("mention"));

    let payload: Value = sqlx::query_scalar("SELECT payload FROM approval WHERE id=$1")
        .bind(approval)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(payload["action"]["id"], json!("hosted.channels.grant"));
    assert_eq!(payload["origin"], json!("server_in_place"));
    assert_eq!(
        payload["action"]["pins"],
        json!({"connection": f.connection.to_string(), "channels": [f.room.to_string()]}),
        "exactly this room, on this agent's own connection"
    );
    assert_eq!(payload["requested_for"], json!(f.owner.id.to_string()));

    let (card_type, card_author, card_root, props): (String, Uuid, Option<Uuid>, Value) =
        sqlx::query_as(
            "SELECT type::text, author_member_id, root_id, props FROM message WHERE id=$1",
        )
        .bind(card)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(card_type, "approval_request");
    assert_eq!(card_author, f.agent);
    assert_eq!(
        card_root,
        Some(root_id),
        "in the thread the person spoke in"
    );
    assert_eq!(props["title"], json!("이 채널에서 쓰기"));
    assert_eq!(props["origin"], json!("server_in_place"));
    assert_eq!(props["action"]["required_role"], json!("admin"));
    let rows = props["action"]["rows"].as_array().unwrap();
    assert_eq!(rows[0]["label"], json!("에이전트"));
    assert_eq!(rows[1]["label"], json!("채널"));
    assert_eq!(
        rows[2],
        json!({"label": "승인 채널 수", "value": "1개 → 2개"})
    );

    assert_eq!(jobs_for_agent(&su, &f).await, 0, "no job before approval");
    assert_eq!(inbox_events(&su, &f).await, 0, "nothing reached the agent");
    assert!(
        notices(&su, &f, f.room).await.is_empty(),
        "the card replaces the notice line"
    );
    // The ledger never claims a queued/started turn for a held run.
    let kinds: Vec<String> =
        sqlx::query_scalar("SELECT kind FROM agent_run_event WHERE run_id=$1 ORDER BY seq")
            .bind(run)
            .fetch_all(&su)
            .await
            .unwrap();
    assert_eq!(kinds, vec!["approval_requested".to_string()]);
    let claimed = tool(&client, &base, &f.bearer, "oort_jobs_claim", json!({})).await;
    assert_eq!(claimed["result"]["structuredContent"]["jobs"], json!([]));

    // ⑥ — a second call while the card waits: no run, no card, one audit row.
    let runs_before = count(
        &su,
        "SELECT count(*) FROM agent_run WHERE workspace_id=$1",
        f.workspace,
    )
    .await;
    send(
        &client,
        &base,
        &f,
        &f.member.jwt,
        f.room,
        &format!("@{} 저도 부탁해요", f.agent_handle),
    )
    .await;
    assert_eq!(in_place_cards(&su, &f, f.room).await.len(), 1);
    assert_eq!(
        count(
            &su,
            "SELECT count(*) FROM agent_run WHERE workspace_id=$1",
            f.workspace
        )
        .await,
        runs_before
    );
    assert_eq!(
        count(
            &su,
            "SELECT count(*) FROM audit_log WHERE workspace_id=$1 \
               AND action='agent.hosted_grant_card.coalesced'",
            f.workspace
        )
        .await,
        1
    );
    assert!(notices(&su, &f, f.room).await.is_empty());

    // The held run does not take the agent's only concurrency slot: a work
    // request in the approved room still starts.
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/agent-runs",
            f.workspace, f.home
        ))
        .bearer_auth(&f.owner.jwt)
        .json(&json!({
            "agent_member_id": f.agent,
            "client_run_id": Uuid::new_v4(),
            "input": {"type": "work", "title": "PR 정리", "brief": "열린 PR을 정리해 주세요"},
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status().as_u16(),
        201,
        "{:?}",
        response.text().await
    );

    // Who lists it: the deciding admin does; a plain member and an admin
    // outside the room do not.
    let id = approval.to_string();
    assert!(approvals_listed(&client, &base, &f, &f.owner.jwt)
        .await
        .contains(&id));
    assert!(!approvals_listed(&client, &base, &f, &f.member.jwt)
        .await
        .contains(&id));
    assert!(!approvals_listed(&client, &base, &f, &f.outsider_admin.jwt)
        .await
        .contains(&id));
}

// ---------------------------------------------------------------------------
// ② ⑨ — approval releases exactly one job
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3857)"]
async fn approving_widens_the_grant_and_releases_exactly_one_job() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();

    let (approval, run, _) = raise_card(&client, &base, &su, &f, f.room).await;
    // A second call is coalesced; its message must be in the first job's window.
    send(
        &client,
        &base,
        &f,
        &f.member.jwt,
        f.room,
        &format!("@{} 테스트 결과도 같이요", f.agent_handle),
    )
    .await;
    assert!(!room_granted(&su, &f, f.room).await);

    let decision_id = Uuid::new_v4();
    let (status, receipt) = decide(
        &client,
        &base,
        &f,
        &f.owner.jwt,
        approval,
        true,
        decision_id,
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["status"], json!("approved"));
    assert!(
        room_granted(&su, &f, f.room).await,
        "the room is now granted"
    );
    assert_eq!(run_state(&su, run).await.0, "queued");
    // Independent review of #3858: the hold marker leaves with the hold. A
    // released run that later parks on an ordinary approval must count against
    // the concurrency cap again (`live_run_count_in_tx`).
    let hold: Option<String> =
        sqlx::query_scalar("SELECT input->>'hold' FROM agent_run WHERE id=$1")
            .bind(run)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(hold, None, "the released run no longer reads as held");
    assert_eq!(jobs_for_agent(&su, &f).await, 1, "exactly one job");
    assert_eq!(inbox_events(&su, &f).await, 1, "one inbox reference");
    let job_payload: Value = sqlx::query_scalar(
        "SELECT payload FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND partition_key=$2",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        job_payload["run_id"].as_str().unwrap().to_lowercase(),
        run.to_string()
    );
    let window = job_payload["recent_messages"].to_string();
    assert!(
        window.contains("테스트 결과도 같이요"),
        "the coalesced call is read on the first turn: {window}"
    );
    let via: Option<String> = sqlx::query_scalar(
        "SELECT detail->>'via' FROM audit_log WHERE workspace_id=$1 \
           AND action='hosted_connection.channels_granted'",
    )
    .bind(f.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(via.as_deref(), Some("in_place_card"));
    let card_status: String = sqlx::query_scalar(
        "SELECT m.props->>'status' FROM approval a JOIN message m ON m.id=a.request_message_id \
          WHERE a.id=$1",
    )
    .bind(approval)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(card_status, "approved");
    let kinds: Vec<String> =
        sqlx::query_scalar("SELECT kind FROM agent_run_event WHERE run_id=$1 ORDER BY seq")
            .bind(run)
            .fetch_all(&su)
            .await
            .unwrap();
    assert_eq!(
        kinds,
        vec!["approval_requested", "approval_decided", "queued"]
    );

    // ② — the same decision again: the original receipt, still one job.
    let (status, replay) = decide(
        &client,
        &base,
        &f,
        &f.owner.jwt,
        approval,
        true,
        decision_id,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(replay, receipt);
    // A different decision on the same card: already decided, still one job.
    let (status, again) = decide(
        &client,
        &base,
        &f,
        &f.owner.jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{again}");
    assert_eq!(jobs_for_agent(&su, &f).await, 1);
    assert_eq!(in_place_cards(&su, &f, f.room).await.len(), 1);

    // ⑨ — two simultaneous claims hand the job out once.
    let (a, b) = tokio::join!(
        tool(
            &client,
            &base,
            &f.bearer,
            "oort_jobs_claim",
            json!({"limit": 10})
        ),
        tool(
            &client,
            &base,
            &f.bearer,
            "oort_jobs_claim",
            json!({"limit": 10})
        ),
    );
    let got = |value: &Value| {
        value["result"]["structuredContent"]["jobs"]
            .as_array()
            .map(Vec::len)
            .unwrap_or(0)
    };
    assert_eq!(got(&a) + got(&b), 1, "{a} {b}");

    // A later call in the now-granted room is an ordinary queued mention.
    send(
        &client,
        &base,
        &f,
        &f.owner.jwt,
        f.room,
        &format!("@{} 하나 더요", f.agent_handle),
    )
    .await;
    assert_eq!(
        in_place_cards(&su, &f, f.room).await.len(),
        1,
        "no new card"
    );
    assert_eq!(jobs_for_agent(&su, &f).await, 2);
}

// ---------------------------------------------------------------------------
// ③ — a run that left the hold rolls the decision back
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3857)"]
async fn a_run_that_left_the_hold_rolls_the_whole_decision_back() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();

    // (a) A person stops the held run from the room, then an admin approves.
    let (approval, run, _) = raise_card(&client, &base, &su, &f, f.room).await;
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{}/agent-runs/{run}/cancel",
            f.workspace
        ))
        .bearer_auth(&f.member.jwt)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success(), "{}", response.status());
    let (status, body) = decide(
        &client,
        &base,
        &f,
        &f.owner.jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert!(
        !room_granted(&su, &f, f.room).await,
        "no grant for a stopped run"
    );
    assert_eq!(jobs_for_agent(&su, &f).await, 0);

    // (b) The run leaves the hold while the approval itself is still pending
    //     (the race the guard exists for): the grant written earlier in the
    //     decision transaction must roll back with it.
    let other = seed_channel(&su, f.workspace, "race", &[f.owner.id, f.agent]).await;
    let (approval, run, _) = raise_card(&client, &base, &su, &f, other).await;
    sqlx::query("UPDATE agent_run SET status='timed_out', finished_at=now() WHERE id=$1")
        .bind(run)
        .execute(&su)
        .await
        .unwrap();
    let (status, body) = decide(
        &client,
        &base,
        &f,
        &f.owner.jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["status"], json!("run_not_parked"), "{body}");
    assert!(!room_granted(&su, &f, other).await, "the grant rolled back");
    assert_eq!(jobs_for_agent(&su, &f).await, 0);
    let still: String = sqlx::query_scalar("SELECT status::text FROM approval WHERE id=$1")
        .bind(approval)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(still, "pending", "nothing was decided");
}

// ---------------------------------------------------------------------------
// ④ — expiry
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3857)"]
async fn expiry_settles_the_held_run_and_there_is_no_job_to_reclaim() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();

    let (approval, run, _) = raise_card(&client, &base, &su, &f, f.room).await;
    sqlx::query("UPDATE approval SET expires_at = now() - interval '1 minute' WHERE id=$1")
        .bind(approval)
        .execute(&su)
        .await
        .unwrap();
    let stats =
        momo_notifier::approval_sweep::sweep_expired_approvals(&momo_notifier_pool().await, 50)
            .await
            .expect("the production sweep");
    assert!(stats.expired >= 1, "{stats:?}");
    assert_eq!(
        run_state(&su, run).await,
        (
            "timed_out".to_string(),
            Some("approval_expired".to_string())
        )
    );
    assert_eq!(jobs_for_agent(&su, &f).await, 0, "there was never a job");
    assert!(!room_granted(&su, &f, f.room).await);
    let line: String = sqlx::query_scalar(
        "SELECT body FROM message WHERE workspace_id=$1 AND channel_id=$2 \
           AND type='tool_result' AND client_msg_id=$3",
    )
    .bind(f.workspace)
    .bind(f.room)
    .bind(approval)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        line,
        "시간이 지나 요청을 처리하지 않았어요. 다시 불러 주세요."
    );
    // The 24-hour stall sweep has nothing of this run to reclaim: it was never
    // queued or running.
    let reclaimable: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run WHERE id=$1 AND status IN ('queued','running')",
    )
    .bind(run)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(reclaimable, 0);

    // Calling again after expiry raises a fresh card.
    send(
        &client,
        &base,
        &f,
        &f.owner.jwt,
        f.room,
        &format!("@{} 다시 부탁해요", f.agent_handle),
    )
    .await;
    let cards = in_place_cards(&su, &f, f.room).await;
    assert_eq!(cards.len(), 2);
    // A late click on that fresh card after ITS deadline settles it the same way.
    let (fresh, fresh_run, _) = cards[1];
    sqlx::query("UPDATE approval SET expires_at = now() - interval '1 minute' WHERE id=$1")
        .bind(fresh)
        .execute(&su)
        .await
        .unwrap();
    let (status, body) = decide(
        &client,
        &base,
        &f,
        &f.owner.jwt,
        fresh,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["status"], json!("expired"));
    assert_eq!(run_state(&su, fresh_run).await.0, "timed_out");
    assert_eq!(jobs_for_agent(&su, &f).await, 0);
    assert!(!room_granted(&su, &f, f.room).await);
}

// ---------------------------------------------------------------------------
// ⑤ — who may decide
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3857)"]
async fn only_an_admin_in_the_room_can_decide_and_outsiders_see_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();

    let (approval, run, card) = raise_card(&client, &base, &su, &f, f.room).await;

    // An admin outside the room: the same answer an unknown id gets.
    let (status, outsider) = decide(
        &client,
        &base,
        &f,
        &f.outsider_admin.jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    let unknown_id = Uuid::new_v4();
    let (unknown_status, unknown) = decide(
        &client,
        &base,
        &f,
        &f.outsider_admin.jwt,
        unknown_id,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!((status, unknown_status), (404, 404), "{outsider} {unknown}");
    assert_eq!(outsider["status"], unknown["status"]);
    assert_eq!(outsider["decisionReason"], unknown["decisionReason"]);
    // The other decision route — by run — says the same, whichever run is named: a run in the path
    // that is not the card's must not tell an outsider "there is such a card" (400) from "there is
    // none" (404). (The card's own run is the card's room's business; a run that is not its own is
    // the case this closes — security review of #4704 PR B, M1, which widened the hiding of an
    // unasked card to the in-place card's shared definition.)
    for (label, run_in_path) in [("another run", Uuid::new_v4()), ("its own run", run)] {
        let response = client
            .post(format!("{base}/v1/agent-runs/{run_in_path}/approval-decisions"))
            .bearer_auth(&f.outsider_admin.jwt)
            .json(&json!({"approvalId": approval, "approve": true, "clientDecisionId": Uuid::new_v4()}))
            .send()
            .await
            .expect("by-run decision responds");
        let by_run_status = response.status().as_u16();
        let by_run: Value = response.json().await.unwrap_or(Value::Null);
        assert_eq!(by_run_status, 404, "outsider, {label}: {by_run}");
        assert_eq!(by_run["status"], unknown["status"], "outsider, {label}");
        assert_eq!(
            by_run["decisionReason"], unknown["decisionReason"],
            "outsider, {label}"
        );
    }
    // …and cannot read the card's room at all.
    let messages = client
        .get(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            f.workspace, f.room
        ))
        .bearer_auth(&f.outsider_admin.jwt)
        .send()
        .await
        .unwrap();
    assert!(!messages.status().is_success(), "{}", messages.status());

    // A plain member of the room: refused, nothing spent.
    let (status, member) = decide(
        &client,
        &base,
        &f,
        &f.member.jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 403, "{member}");
    assert_eq!(member["status"], json!("role_required"));
    // …and the same member saying no is refused the same way (independent
    // review of #3858): the decider is an admin in the room for both halves
    // (G2), and the outcome line says 「관리자가 … 승인하지 않아서」.
    let (status, member_no) = decide(
        &client,
        &base,
        &f,
        &f.member.jwt,
        approval,
        false,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 403, "{member_no}");
    assert_eq!(member_no["status"], json!("role_required"));
    let outcome_lines = count(
        &su,
        "SELECT count(*) FROM message WHERE workspace_id=$1 AND type='tool_result'",
        f.workspace,
    )
    .await;
    assert_eq!(
        outcome_lines, 0,
        "a refused rejection writes no outcome line"
    );
    let still: String = sqlx::query_scalar("SELECT status::text FROM approval WHERE id=$1")
        .bind(approval)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(still, "pending");
    assert_eq!(run_state(&su, run).await.0, "awaiting_approval");
    assert!(!room_granted(&su, &f, f.room).await);
    assert_eq!(jobs_for_agent(&su, &f).await, 0);
    let _ = card;

    // The owner (admin + in the room) can.
    let (status, ok) = decide(
        &client,
        &base,
        &f,
        &f.owner.jwt,
        approval,
        true,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{ok}");
    assert_eq!(jobs_for_agent(&su, &f).await, 1);
}

// ---------------------------------------------------------------------------
// ⑦ — every other shape keeps the old line
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3857)"]
async fn dm_agent_authored_and_switched_off_calls_keep_the_old_line() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let client = reqwest::Client::new();

    // The switch off: the notice line, no card, no run.
    let off = start_server(momo_app_pool().await, false).await;
    send(
        &client,
        &off,
        &f,
        &f.owner.jwt,
        f.room,
        &format!("@{} 여기서도 돼요?", f.agent_handle),
    )
    .await;
    assert!(in_place_cards(&su, &f, f.room).await.is_empty());
    assert_eq!(
        notices(&su, &f, f.room).await,
        vec!["hosted_channel_unapproved".to_string()]
    );
    assert_eq!(
        count(
            &su,
            "SELECT count(*) FROM agent_run WHERE workspace_id=$1",
            f.workspace
        )
        .await,
        0
    );

    let on = start_server(momo_app_pool().await, true).await;

    // An agent's send that names the agent in a room unapproved for it: the
    // A2A rule skips it before any hosted question, so no card.
    let posted = tool(
        &client,
        &on,
        &f.helper_bearer,
        "oort_message_post",
        json!({
            "channelId": f.room,
            "clientMsgId": Uuid::new_v4(),
            "body": format!("@{} 같이 봐 줘", f.agent_handle),
        }),
    )
    .await;
    assert!(posted["error"].is_null(), "{posted}");
    assert!(in_place_cards(&su, &f, f.room).await.is_empty());

    // A DM with a non-owner and the agent: the DM rules, never a card.
    let dm = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, dm_key, created_by) \
         VALUES ($1, $2, 'dm', NULL, NULL, $3, $4)",
    )
    .bind(dm)
    .bind(f.workspace)
    .bind(dm.to_string())
    .bind(f.member.id)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(dm)
        .bind(f.workspace)
        .execute(&su)
        .await
        .unwrap();
    join(&su, f.workspace, dm, f.member.id).await;
    join(&su, f.workspace, dm, f.agent).await;
    send(
        &client,
        &on,
        &f,
        &f.member.jwt,
        dm,
        &format!("@{} DM으로 부탁해요", f.agent_handle),
    )
    .await;
    assert!(in_place_cards(&su, &f, dm).await.is_empty());
    assert_eq!(notices(&su, &f, dm).await.len(), 1, "the DM sentence");
    assert_eq!(jobs_for_agent(&su, &f).await, 0);
}

// ---------------------------------------------------------------------------
// G4 — rejection
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3857)"]
async fn rejection_ends_the_held_run_with_a_reason_the_caller_reads() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();

    let (approval, run, _) = raise_card(&client, &base, &su, &f, f.room).await;
    let (status, receipt) = decide(
        &client,
        &base,
        &f,
        &f.owner.jwt,
        approval,
        false,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["status"], json!("rejected"));
    assert_eq!(
        run_state(&su, run).await,
        (
            "cancelled".to_string(),
            Some("channel_grant_rejected".to_string())
        )
    );
    assert_eq!(jobs_for_agent(&su, &f).await, 0);
    assert_eq!(
        inbox_events(&su, &f).await,
        0,
        "a rejected in-place card tells the agent nothing in its inbox: the room is not one its \
         connection covers (ADR-0186 증보 v5 U-f), and a rejection is not a wake-up"
    );
    assert!(!room_granted(&su, &f, f.room).await);
    let line: String = sqlx::query_scalar(
        "SELECT body FROM message WHERE workspace_id=$1 AND channel_id=$2 \
           AND type='tool_result' AND client_msg_id=$3",
    )
    .bind(f.workspace)
    .bind(f.room)
    .bind(approval)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        line,
        "관리자가 이 채널에서 쓰기를 승인하지 않아서 요청을 처리하지 않았어요."
    );

    // After a rejection, calling again asks again.
    send(
        &client,
        &base,
        &f,
        &f.owner.jwt,
        f.room,
        &format!("@{} 한 번 더 부탁해요", f.agent_handle),
    )
    .await;
    assert_eq!(in_place_cards(&su, &f, f.room).await.len(), 2);
}

// ---------------------------------------------------------------------------
// G2 — the per-connection ceiling
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3857)"]
async fn the_per_connection_ceiling_falls_back_to_the_notice_line() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();

    let mut rooms = Vec::new();
    for index in 0..6 {
        rooms.push(
            seed_channel(
                &su,
                f.workspace,
                &format!("cap{index}"),
                &[f.owner.id, f.agent],
            )
            .await,
        );
    }
    for room in &rooms[..5] {
        raise_card(&client, &base, &su, &f, *room).await;
    }
    send(
        &client,
        &base,
        &f,
        &f.owner.jwt,
        rooms[5],
        &format!("@{} 여섯 번째 방", f.agent_handle),
    )
    .await;
    assert!(in_place_cards(&su, &f, rooms[5]).await.is_empty());
    assert_eq!(
        notices(&su, &f, rooms[5]).await,
        vec!["hosted_channel_unapproved".to_string()]
    );
    assert_eq!(jobs_for_agent(&su, &f).await, 0);
}
