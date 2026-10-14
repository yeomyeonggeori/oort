//! ADR-0162 증보 5 W1~W3 (#3851, 성재 결재 「깨우기 (추천)」 2026-10-15) — a
//! person's reply without a mention, in a thread an agent opened, wakes that
//! agent as a job. End to end through the real Axum router on a `momo_app`
//! (NOBYPASSRLS) pool; the hosted agent claims through the real Agent Port.
//!
//! Acceptance numbers are ADR-0162 증보 5 G6 ⑩~⑮.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `a_human_reply_in_an_agent_thread_wakes_that_agent_once` (⑩) | agent root → reply wakes it; human root + agent first reply → the next human reply wakes it; one run + one job + one wake broadcast + one `agent.thread_wake.queued`; a replayed send stays one; a human-opened thread wakes nobody; the hosted agent gets one inbox `agent_job` and claims `work.wakeReason="thread_reply"` | the wake call is removed from `route_agent_mentions_in_tx`; the opener query loses its root or first-reply arm; `wake_reason` leaves the claim projection |
//! | `agent_replies_never_wake_anyone` (⑪) | an agent's reply (Agent Port, agent credential) in another agent's thread → 0 wake runs | BOTH halves of the loop guard are removed (the credential refusal in `wake_thread_opener_in_tx` and the roster `kind = 'human'` check) |
//! | `a_reply_that_mentions_an_agent_takes_the_mention_path_only` (⑫) | mentioning another agent → that agent's mention run only; mentioning the opener → one mention run, no wake run | the wake is called on the addressed path too |
//! | `the_owner_switch_turns_the_wake_off` (⑬) | `PUT …/profile {threadReplyWake:false}` → 0; non-editor 403 and unchanged; on again → 1 | the switch check is removed |
//! | `a_second_reply_before_pickup_joins_the_waiting_turn` (⑭) | 2nd reply before claim → no run, one `agent.thread_wake.coalesced`; after claim → a new run | `find_unclaimed_thread_run_in_tx` is skipped, or stops looking at the lease |
//! | `gate_refusals_are_silent` (⑮) | unapproved channel, paused, `owner_only` non-owner → 0 runs, 0 jobs, 0 agent-authored lines, 0 approvals; one `agent.thread_wake.skipped` with the gate's reason; the owner's reply (control) still wakes | the wake path posts the mention path's notices (e.g. the paused line), or skips the gate |
//!
//! Isolated database only:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo PGHOST=127.0.0.1 PGPORT=<port> \
//!   PGUSER=momo PGPASSWORD=momo PGDATABASE=momo \
//!   cargo test -p momo-server --test thread_reply_wake_conformance_pg -- --ignored --test-threads=1
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_messaging::{send_message_in_tx, MessageType, NewMessage};
use momo_server::config::{AgentGatewayMode, AgentGatewaySettings, AgentPortConfig};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "thread-reply-wake-pg-conformance-signing-secret";
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
    std::env::var(name).unwrap_or_else(|_| panic!("set {name} for the private PG client"))
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
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

/// Hosted delivery open, managed gateway on, subscription agents on.
async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_agent_gateway(AgentGatewaySettings {
        mode: AgentGatewayMode::Gateway,
        secret: "thread-reply-wake-conformance-gateway-secret".to_string(),
        allow_legacy_secret: false,
    })
    .with_agent_port(AgentPortConfig {
        external_origin: None,
        window_seconds: 60,
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        hosted_delivery_enabled: true,
        subscription_agents_enabled: true,
        claude_subscription_agents_enabled: true,
        hosted_lease_seconds: momo_outbox::HOSTED_LEASE_SECONDS_DEFAULT,
        oauth: Default::default(),
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
// fixture (superuser → RLS bypassed)
// ---------------------------------------------------------------------------

struct Fixture {
    workspace: Uuid,
    human: Uuid,
    human_jwt: String,
    outsider: Uuid,
    outsider_jwt: String,
    /// Active, proved hosted connection approved for `channel` only.
    hosted: Uuid,
    hosted_bearer: String,
    /// Managed agents (gateway mode on the server).
    managed: Uuid,
    other: Uuid,
    other_handle: String,
    managed_handle: String,
    channel: Uuid,
    unapproved_channel: Uuid,
}

async fn insert_member(su: &PgPool, workspace: Uuid, id: Uuid, kind: &str, handle: &str) {
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,$3::member_kind,$4,$4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(kind)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed member");
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, handle: &str) -> (Uuid, String) {
    let human = Uuid::new_v4();
    insert_member(su, workspace, human, "human", handle).await;
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(human)
    .bind(workspace)
    .bind(format!("{human}@wake.test"))
    .execute(su)
    .await
    .expect("seed human identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,$3::membership_role)",
    )
    .bind(workspace)
    .bind(human)
    .bind(role)
    .execute(su)
    .await
    .expect("seed human membership");
    let jwt = momo_auth::sign_access(human, workspace, &[], TEST_JWT_SECRET)
        .expect("sign a human App JWT")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'thread-wake')",
    )
    .bind(workspace)
    .bind(human)
    .bind(&jwt)
    .execute(su)
    .await
    .expect("record the human session token");
    (human, jwt)
}

async fn seed(su: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("wake-{}", workspace.simple()))
        .execute(su)
        .await
        .expect("seed workspace");
    let (human, human_jwt) = seed_human(
        su,
        workspace,
        "owner",
        &format!("owner-{}", Uuid::new_v4().simple()),
    )
    .await;
    let (outsider, outsider_jwt) = seed_human(
        su,
        workspace,
        "member",
        &format!("teammate-{}", Uuid::new_v4().simple()),
    )
    .await;

    let hosted = Uuid::new_v4();
    let managed = Uuid::new_v4();
    let other = Uuid::new_v4();
    let managed_handle = format!("opener{}", &managed.simple().to_string()[..8]);
    let other_handle = format!("helper{}", &other.simple().to_string()[..8]);
    for (agent, handle, is_hosted) in [
        (
            hosted,
            format!("grok{}", &hosted.simple().to_string()[..8]),
            true,
        ),
        (managed, managed_handle.clone(), false),
        (other, other_handle.clone(), false),
    ] {
        insert_member(su, workspace, agent, "agent", &handle).await;
        sqlx::query(
            "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id, config, \
                               max_concurrent_runs) \
             VALUES($1,$2,'hosted-agent',$3,$4,$5::jsonb,4)",
        )
        .bind(agent)
        .bind(workspace)
        .bind(if is_hosted {
            "https://hosted-agent.invalid/disabled"
        } else {
            "https://provider.invalid/v1"
        })
        .bind(human)
        .bind(if is_hosted {
            "{\"execution_mode\":\"hosted_dial_in\"}"
        } else {
            "{}"
        })
        .execute(su)
        .await
        .expect("seed agent row");
        sqlx::query(
            "INSERT INTO workspace_membership(workspace_id, member_id, role) \
             VALUES($1,$2,'member')",
        )
        .bind(workspace)
        .bind(agent)
        .execute(su)
        .await
        .expect("seed agent membership");
        sqlx::query(
            "INSERT INTO agent_profile(agent_member_id, workspace_id, updated_by, paused) \
             VALUES($1,$2,$3,false)",
        )
        .bind(agent)
        .bind(workspace)
        .bind(human)
        .execute(su)
        .await
        .expect("seed agent profile");
    }

    let channel = Uuid::new_v4();
    let unapproved_channel = Uuid::new_v4();
    for (id, name) in [(channel, "approved"), (unapproved_channel, "unapproved")] {
        sqlx::query("INSERT INTO channel(id, workspace_id, kind, name) VALUES($1,$2,'public',$3)")
            .bind(id)
            .bind(workspace)
            .bind(format!("{name}-{}", id.simple()))
            .execute(su)
            .await
            .expect("seed channel");
        sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
            .bind(id)
            .bind(workspace)
            .execute(su)
            .await
            .expect("seed channel_seq");
        for member in [human, outsider, hosted, managed, other] {
            sqlx::query(
                "INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)",
            )
            .bind(workspace)
            .bind(id)
            .bind(member)
            .execute(su)
            .await
            .expect("seed membership");
        }
    }

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
    .bind(hosted)
    .bind(human)
    .bind(vec![channel])
    .execute(su)
    .await
    .expect("seed hosted connection");
    let hosted_bearer = format!(
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
    .map(|scope| (*scope).to_string())
    .collect();
    let token: Uuid = sqlx::query_scalar(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, created_by) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'),$4,'hosted agent port', \
                'hosted_active',$5,$6,$7) RETURNING id",
    )
    .bind(workspace)
    .bind(hosted)
    .bind(&hosted_bearer)
    .bind(scopes)
    .bind(connection)
    .bind(AUDIENCE)
    .bind(human)
    .fetch_one(su)
    .await
    .expect("seed hosted bearer");
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='active', active_token_id=$3, \
           proved_at=now(), proved_by=$4 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .bind(token)
    .bind(hosted)
    .execute(su)
    .await
    .expect("activate hosted connection");

    Fixture {
        workspace,
        human,
        human_jwt,
        outsider,
        outsider_jwt,
        hosted,
        hosted_bearer,
        managed,
        other,
        other_handle,
        managed_handle,
        channel,
        unapproved_channel,
    }
}

// ---------------------------------------------------------------------------
// wire helpers
// ---------------------------------------------------------------------------

/// An agent's own message, written through the product's single write path
/// (the spine the gateway completion and the worker use). Used where the test
/// needs "this agent said something here" without driving a whole turn.
async fn agent_says(
    app: &PgPool,
    f: &Fixture,
    agent: Uuid,
    channel: Uuid,
    root: Option<Uuid>,
    body: &str,
) -> Uuid {
    let workspace = f.workspace;
    let body = body.to_string();
    momo_db::with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            let mut message = NewMessage::text(channel, agent, body);
            message.message_type = MessageType::Text;
            message.root_id = root;
            message.client_msg_id = Some(Uuid::new_v4());
            let sent = send_message_in_tx(conn, workspace, message).await?;
            Ok(sent.message.id)
        })
    })
    .await
    .expect("agent message")
}

#[allow(clippy::too_many_arguments)]
async fn send(
    client: &reqwest::Client,
    base: &str,
    f: &Fixture,
    jwt: &str,
    channel: Uuid,
    root: Option<Uuid>,
    body: &str,
    client_msg_id: Uuid,
) -> Uuid {
    let mut request = json!({"clientMsgId": client_msg_id, "body": body});
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
        .expect("send responds");
    let status = response.status().as_u16();
    let value: Value = response.json().await.expect("send body");
    assert_eq!(status, 201, "send: {value}");
    Uuid::parse_str(value["id"].as_str().expect("message id")).expect("uuid id")
}

async fn human_says(
    client: &reqwest::Client,
    base: &str,
    f: &Fixture,
    channel: Uuid,
    root: Option<Uuid>,
    body: &str,
) -> Uuid {
    send(
        client,
        base,
        f,
        &f.human_jwt,
        channel,
        root,
        body,
        Uuid::new_v4(),
    )
    .await
}

async fn port_call(
    client: &reqwest::Client,
    base: &str,
    bearer: &str,
    tool: &str,
    arguments: Value,
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
            "name": tool,
            "arguments": arguments,
        }
    });
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
    let value: Value = response.json().await.expect("JSON-RPC body");
    assert!(
        value.get("error").is_none() && value["result"]["isError"] != json!(true),
        "{tool}: {value}"
    );
    value["result"]["structuredContent"].clone()
}

/// The hosted agent posts through the Agent Port — an agent credential.
async fn hosted_posts(
    client: &reqwest::Client,
    base: &str,
    f: &Fixture,
    root: Option<Uuid>,
    body: &str,
) -> Uuid {
    let mut arguments = json!({
        "channelId": f.channel,
        "clientMsgId": Uuid::new_v4(),
        "body": body,
    });
    if let Some(root) = root {
        arguments["rootId"] = json!(root);
    }
    let answer = port_call(
        client,
        base,
        &f.hosted_bearer,
        "oort_message_post",
        arguments,
    )
    .await;
    Uuid::parse_str(answer["messageId"].as_str().expect("messageId")).expect("uuid")
}

async fn count(su: &PgPool, sql: &str, workspace: Uuid, id: Uuid) -> i64 {
    sqlx::query_scalar::<_, i64>(sql)
        .bind(workspace)
        .bind(id)
        .fetch_one(su)
        .await
        .expect("count")
}

/// Wake runs of `agent` (any trigger message).
async fn wake_runs(su: &PgPool, f: &Fixture, agent: Uuid) -> i64 {
    count(
        su,
        "SELECT count(*) FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2 \
           AND idempotency_key LIKE 'thread_reply:%'",
        f.workspace,
        agent,
    )
    .await
}

/// Every run of `agent`, mention or wake.
async fn all_runs(su: &PgPool, f: &Fixture, agent: Uuid) -> i64 {
    count(
        su,
        "SELECT count(*) FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2",
        f.workspace,
        agent,
    )
    .await
}

async fn jobs_of(su: &PgPool, f: &Fixture, agent: Uuid) -> i64 {
    count(
        su,
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND partition_key=$2",
        f.workspace,
        agent,
    )
    .await
}

/// Lines in `agent`'s name anywhere in the workspace (answers, notices, the
/// paused line — all authored by the agent member).
async fn agent_lines(su: &PgPool, f: &Fixture, agent: Uuid) -> i64 {
    count(
        su,
        "SELECT count(*) FROM message WHERE workspace_id=$1 AND author_member_id=$2",
        f.workspace,
        agent,
    )
    .await
}

async fn audits(su: &PgPool, f: &Fixture, action: &str, message: Uuid) -> Vec<Value> {
    sqlx::query_scalar::<_, Value>(
        "SELECT detail FROM audit_log WHERE workspace_id=$1 AND action=$2 \
           AND target_id=$3 ORDER BY created_at",
    )
    .bind(f.workspace)
    .bind(action)
    .bind(message)
    .fetch_all(su)
    .await
    .expect("audit rows")
}

async fn wake_run_for(su: &PgPool, f: &Fixture, reply: Uuid, agent: Uuid) -> Option<(Uuid, Value)> {
    sqlx::query_as::<_, (Uuid, Value)>(
        "SELECT id, input FROM agent_run WHERE workspace_id=$1 AND idempotency_key=$2",
    )
    .bind(f.workspace)
    .bind(format!(
        "thread_reply:{}:{}",
        reply.to_string().to_uppercase(),
        agent.to_string().to_uppercase()
    ))
    .fetch_optional(su)
    .await
    .expect("wake run lookup")
}

async fn setup() -> (PgPool, PgPool, Fixture, String, reqwest::Client) {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    (su, app, f, base, reqwest::Client::new())
}

// ---------------------------------------------------------------------------
// ⑩
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3851)"]
async fn a_human_reply_in_an_agent_thread_wakes_that_agent_once() {
    let (su, app, f, base, client) = setup().await;

    // (a) The agent's own message is the thread root.
    let root = agent_says(&app, &f, f.managed, f.channel, None, "배포 끝났어요").await;
    let reply_id = Uuid::new_v4();
    let reply = send(
        &client,
        &base,
        &f,
        &f.human_jwt,
        f.channel,
        Some(root),
        "로그도 같이 봐 줄래요?",
        reply_id,
    )
    .await;
    let (run, input) = wake_run_for(&su, &f, reply, f.managed)
        .await
        .expect("⑩ the reply wakes the agent that opened the thread");
    assert_eq!(input["addressing"], json!("thread_reply"), "{input}");
    assert_eq!(
        input["surface"],
        json!("mention"),
        "same vocabulary as a mention (W4)"
    );
    assert_eq!(
        input["trigger_message_id"],
        json!(reply.to_string().to_uppercase())
    );
    let trigger: Option<Uuid> =
        sqlx::query_scalar("SELECT trigger_message_id FROM agent_run WHERE id=$1")
            .bind(run)
            .fetch_one(&su)
            .await
            .expect("trigger column");
    assert_eq!(
        trigger,
        Some(reply),
        "the reply is the run's trigger message"
    );
    let job: (String, Value) = sqlx::query_as(
        "SELECT method, payload FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
           AND upper(payload->>'run_id')=upper($2::text)",
    )
    .bind(f.workspace)
    .bind(run)
    .fetch_one(&su)
    .await
    .expect("exactly one job for the wake run");
    assert_eq!(job.0, "gateway", "gateway mode → gateway job");
    assert_eq!(job.1["wake_reason"], json!("thread_reply"));
    assert_eq!(job.1["prompt"], json!("로그도 같이 봐 줄래요?"));
    let broadcasts = count(
        &su,
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='broadcast' \
           AND payload->'data'->>'type'='agent.job' \
           AND upper(payload->'data'->'payload'->>'run_id')=upper($2::text)",
        f.workspace,
        run,
    )
    .await;
    assert_eq!(broadcasts, 1, "the managed gateway's doorbell rings once");
    assert_eq!(
        audits(&su, &f, "agent.thread_wake.queued", reply)
            .await
            .len(),
        1
    );
    assert_eq!(wake_runs(&su, &f, f.managed).await, 1);
    assert_eq!(jobs_of(&su, &f, f.managed).await, 1);

    // The same send replayed (same clientMsgId) is deduped upstream: still one.
    let replayed = send(
        &client,
        &base,
        &f,
        &f.human_jwt,
        f.channel,
        Some(root),
        "로그도 같이 봐 줄래요?",
        reply_id,
    )
    .await;
    assert_eq!(replayed, reply);
    assert_eq!(
        wake_runs(&su, &f, f.managed).await,
        1,
        "⑩ replay → still one"
    );
    assert_eq!(
        jobs_of(&su, &f, f.managed).await,
        1,
        "⑩ replay → still one job"
    );

    // (b) A person opened the thread and the agent answered first inside it.
    // The person's FIRST reply after that is the trigger and must not count
    // itself as the thread's first reply (`seq <`).
    let other_root = human_says(&client, &base, &f, f.channel, None, "이번 주 일정 정리").await;
    assert_eq!(
        all_runs(&su, &f, f.other).await,
        0,
        "no agent was addressed"
    );
    agent_says(
        &app,
        &f,
        f.other,
        f.channel,
        Some(other_root),
        "정리해 둘게요",
    )
    .await;
    let follow_up = human_says(
        &client,
        &base,
        &f,
        f.channel,
        Some(other_root),
        "금요일도 넣어 줘요",
    )
    .await;
    assert!(
        wake_run_for(&su, &f, follow_up, f.other).await.is_some(),
        "⑩ first-reply shape: the agent that answered first is woken"
    );
    assert_eq!(wake_runs(&su, &f, f.other).await, 1);

    // A thread nobody but people are in wakes nobody.
    let people_root = human_says(&client, &base, &f, f.channel, None, "점심 뭐 먹지").await;
    human_says(&client, &base, &f, f.channel, Some(people_root), "김밥").await;
    human_says(&client, &base, &f, f.channel, Some(people_root), "좋아요").await;
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run WHERE workspace_id=$1 \
           AND idempotency_key LIKE 'thread_reply:%'",
    )
    .bind(f.workspace)
    .fetch_one(&su)
    .await
    .expect("count");
    assert_eq!(total, 2, "only the two agent-opened threads woke anyone");

    // (c) The hosted agent: same job, an inbox `agent_job`, and the claim says
    // why it was woken.
    let hosted_root = hosted_posts(&client, &base, &f, None, "PR 올렸어요").await;
    let hosted_reply = human_says(
        &client,
        &base,
        &f,
        f.channel,
        Some(hosted_root),
        "테스트도 돌렸어요?",
    )
    .await;
    let (hosted_run, _) = wake_run_for(&su, &f, hosted_reply, f.hosted)
        .await
        .expect("⑩ the hosted agent is woken too");
    let inbox_jobs = count(
        &su,
        "SELECT count(*) FROM hosted_agent_inbox_event WHERE workspace_id=$1 \
           AND event_kind='agent_job' AND source_run_id=$2",
        f.workspace,
        hosted_run,
    )
    .await;
    assert_eq!(
        inbox_jobs, 1,
        "one inbox agent_job, same kind as a mention's"
    );
    let claimed = port_call(
        &client,
        &base,
        &f.hosted_bearer,
        "oort_jobs_claim",
        json!({}),
    )
    .await;
    let jobs = claimed["jobs"].as_array().expect("jobs");
    assert_eq!(jobs.len(), 1, "{claimed}");
    assert_eq!(
        jobs[0]["work"]["wakeReason"],
        json!("thread_reply"),
        "{claimed}"
    );
    assert_eq!(
        jobs[0]["work"]["triggerMessageId"],
        json!(hosted_reply.to_string().to_uppercase())
    );
}

// ---------------------------------------------------------------------------
// ⑪
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3851)"]
async fn agent_replies_never_wake_anyone() {
    let (su, app, f, base, client) = setup().await;
    let root = agent_says(&app, &f, f.managed, f.channel, None, "빌드 깨졌어요").await;
    // Another agent replies in that thread through the Agent Port, with no
    // mention — the loop the guard exists for.
    let agent_reply = hosted_posts(&client, &base, &f, Some(root), "제가 볼게요").await;
    assert_eq!(
        wake_runs(&su, &f, f.managed).await,
        0,
        "⑪ an agent's reply never wakes the thread's agent"
    );
    assert_eq!(all_runs(&su, &f, f.hosted).await, 0);
    assert!(audits(&su, &f, "agent.thread_wake.skipped", agent_reply)
        .await
        .is_empty());

    // The hosted agent's own thread, answered by itself: nothing either.
    let own = hosted_posts(&client, &base, &f, None, "정리 시작").await;
    hosted_posts(&client, &base, &f, Some(own), "정리 끝").await;
    assert_eq!(all_runs(&su, &f, f.hosted).await, 0, "⑪ no self-wake");

    // Control: a person's reply in the same first thread does wake it.
    human_says(&client, &base, &f, f.channel, Some(root), "고마워요").await;
    assert_eq!(wake_runs(&su, &f, f.managed).await, 1);
}

// ---------------------------------------------------------------------------
// ⑫
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3851)"]
async fn a_reply_that_mentions_an_agent_takes_the_mention_path_only() {
    let (su, app, f, base, client) = setup().await;
    let root = agent_says(&app, &f, f.managed, f.channel, None, "초안 올렸어요").await;

    human_says(
        &client,
        &base,
        &f,
        f.channel,
        Some(root),
        &format!("@{} 이것도 봐 줘요", f.other_handle),
    )
    .await;
    assert_eq!(wake_runs(&su, &f, f.managed).await, 0, "⑫ no wake");
    assert_eq!(all_runs(&su, &f, f.managed).await, 0);
    let mention_runs = count(
        &su,
        "SELECT count(*) FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2 \
           AND idempotency_key LIKE 'mention:%'",
        f.workspace,
        f.other,
    )
    .await;
    assert_eq!(
        mention_runs, 1,
        "⑫ the mentioned agent gets its mention run"
    );

    // Mentioning the opener itself: one run, the mention's.
    human_says(
        &client,
        &base,
        &f,
        f.channel,
        Some(root),
        &format!("@{} 고쳐 줘요", f.managed_handle),
    )
    .await;
    assert_eq!(all_runs(&su, &f, f.managed).await, 1, "⑫ exactly one run");
    assert_eq!(
        wake_runs(&su, &f, f.managed).await,
        0,
        "⑫ and it is not a wake"
    );
}

// ---------------------------------------------------------------------------
// ⑬
// ---------------------------------------------------------------------------

async fn put_wake(
    client: &reqwest::Client,
    base: &str,
    f: &Fixture,
    jwt: &str,
    agent: Uuid,
    enabled: bool,
) -> (u16, Value) {
    let response = client
        .put(format!(
            "{base}/v1/workspaces/{}/agents/{agent}/profile",
            f.workspace
        ))
        .bearer_auth(jwt)
        .json(&json!({"instructions": "", "threadReplyWake": enabled}))
        .send()
        .await
        .expect("profile PUT responds");
    let status = response.status().as_u16();
    let value: Value = response.json().await.unwrap_or(Value::Null);
    (status, value)
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3851)"]
async fn the_owner_switch_turns_the_wake_off() {
    let (su, app, f, base, client) = setup().await;

    let (status, body) = put_wake(&client, &base, &f, &f.human_jwt, f.managed, false).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["profile"]["threadReplyWake"], json!(false), "{body}");
    let read = client
        .get(format!(
            "{base}/v1/workspaces/{}/agents/{}/profile",
            f.workspace, f.managed
        ))
        .bearer_auth(&f.human_jwt)
        .send()
        .await
        .expect("profile GET")
        .json::<Value>()
        .await
        .expect("profile body");
    assert_eq!(read["profile"]["threadReplyWake"], json!(false), "{read}");

    let root = agent_says(&app, &f, f.managed, f.channel, None, "회의록 올렸어요").await;
    let reply = human_says(&client, &base, &f, f.channel, Some(root), "고마워요").await;
    assert_eq!(wake_runs(&su, &f, f.managed).await, 0, "⑬ switched off → 0");
    assert!(
        audits(&su, &f, "agent.thread_wake.skipped", reply)
            .await
            .is_empty(),
        "off is silent: not even an audit row per reply"
    );

    // Not the agent's owner and not an admin: refused, value unchanged.
    let (status, _) = put_wake(&client, &base, &f, &f.outsider_jwt, f.managed, true).await;
    assert_eq!(status, 403);
    let stored: bool = sqlx::query_scalar("SELECT thread_reply_wake FROM agent WHERE member_id=$1")
        .bind(f.managed)
        .fetch_one(&su)
        .await
        .expect("column");
    assert!(!stored, "a refused PUT changed nothing");

    // A PUT without the key leaves it as it is.
    let response = client
        .put(format!(
            "{base}/v1/workspaces/{}/agents/{}/profile",
            f.workspace, f.managed
        ))
        .bearer_auth(&f.human_jwt)
        .json(&json!({"instructions": "짧게"}))
        .send()
        .await
        .expect("profile PUT");
    assert_eq!(response.status().as_u16(), 200);
    let body: Value = response.json().await.expect("body");
    assert_eq!(body["profile"]["threadReplyWake"], json!(false), "{body}");

    let (status, body) = put_wake(&client, &base, &f, &f.human_jwt, f.managed, true).await;
    assert_eq!(status, 200, "{body}");
    human_says(&client, &base, &f, f.channel, Some(root), "하나 더요").await;
    assert_eq!(wake_runs(&su, &f, f.managed).await, 1, "⑬ on again → wakes");
}

// ---------------------------------------------------------------------------
// ⑭
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3851)"]
async fn a_second_reply_before_pickup_joins_the_waiting_turn() {
    let (su, _app, f, base, client) = setup().await;
    let root = hosted_posts(&client, &base, &f, None, "리뷰 끝났어요").await;
    let first = human_says(&client, &base, &f, f.channel, Some(root), "고칠 게 있나요?").await;
    let (waiting, _) = wake_run_for(&su, &f, first, f.hosted)
        .await
        .expect("first reply wakes");

    let second = human_says(&client, &base, &f, f.channel, Some(root), "그리고 문서도요").await;
    assert_eq!(
        wake_runs(&su, &f, f.hosted).await,
        1,
        "⑭ a reply before pickup starts no second turn"
    );
    assert_eq!(jobs_of(&su, &f, f.hosted).await, 1);
    let coalesced = audits(&su, &f, "agent.thread_wake.coalesced", second).await;
    assert_eq!(coalesced.len(), 1, "one coalesced audit row");
    assert_eq!(
        coalesced[0]["run_id"],
        json!(waiting.to_string().to_uppercase()),
        "{}",
        coalesced[0]
    );
    assert!(
        !coalesced[0].to_string().contains("그리고 문서도요"),
        "the reply's body is never copied into the audit"
    );

    // Picked up: the next reply is a turn of its own.
    let claimed = port_call(
        &client,
        &base,
        &f.hosted_bearer,
        "oort_jobs_claim",
        json!({}),
    )
    .await;
    assert_eq!(
        claimed["jobs"].as_array().map(Vec::len),
        Some(1),
        "{claimed}"
    );
    let third = human_says(&client, &base, &f, f.channel, Some(root), "급해요").await;
    assert!(
        wake_run_for(&su, &f, third, f.hosted).await.is_some(),
        "⑭ after pickup a new reply is a new run"
    );
    assert_eq!(wake_runs(&su, &f, f.hosted).await, 2);
}

// ---------------------------------------------------------------------------
// ⑮
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3851)"]
async fn gate_refusals_are_silent() {
    let (su, app, f, base, client) = setup().await;
    let approvals_before = count(
        &su,
        "SELECT count(*) FROM approval WHERE workspace_id=$1 AND $2::uuid IS NOT NULL",
        f.workspace,
        f.hosted,
    )
    .await;

    // (a) A channel the hosted connection was never approved for. The agent's
    // line there is fixture data (the Agent Port would refuse to post it).
    let root = agent_says(&app, &f, f.hosted, f.unapproved_channel, None, "예전 메모").await;
    let lines = agent_lines(&su, &f, f.hosted).await;
    let reply = human_says(
        &client,
        &base,
        &f,
        f.unapproved_channel,
        Some(root),
        "이것 좀 봐요",
    )
    .await;
    assert_eq!(
        all_runs(&su, &f, f.hosted).await,
        0,
        "⑮ unapproved → no run"
    );
    assert_eq!(jobs_of(&su, &f, f.hosted).await, 0);
    assert_eq!(
        agent_lines(&su, &f, f.hosted).await,
        lines,
        "⑮ and no notice line in the agent's name"
    );
    let skipped = audits(&su, &f, "agent.thread_wake.skipped", reply).await;
    assert_eq!(skipped.len(), 1);
    assert_eq!(skipped[0]["reason"], json!("hosted_channel_unapproved"));

    // (b) `paused`: the mention path would post the visible paused line; the
    // wake posts nothing.
    sqlx::query("UPDATE agent_profile SET paused=true WHERE agent_member_id=$1")
        .bind(f.managed)
        .execute(&su)
        .await
        .expect("pause");
    let paused_root = agent_says(&app, &f, f.managed, f.channel, None, "작업 중이에요").await;
    let lines = agent_lines(&su, &f, f.managed).await;
    let reply = human_says(
        &client,
        &base,
        &f,
        f.channel,
        Some(paused_root),
        "언제 돼요?",
    )
    .await;
    assert_eq!(all_runs(&su, &f, f.managed).await, 0, "⑮ paused → no run");
    assert_eq!(
        agent_lines(&su, &f, f.managed).await,
        lines,
        "⑮ no paused line"
    );
    let skipped = audits(&su, &f, "agent.thread_wake.skipped", reply).await;
    assert_eq!(skipped[0]["reason"], json!("agent_paused"));

    // (c) `owner_only`: a teammate who is not the owner replies in the owner's
    // subscription agent's thread.
    sqlx::query(
        "UPDATE agent SET invocation_scope='owner_only', subscription_harness='codex' \
          WHERE workspace_id=$1 AND member_id=$2",
    )
    .bind(f.workspace)
    .bind(f.hosted)
    .execute(&su)
    .await
    .expect("mark owner_only");
    let owned_root = hosted_posts(&client, &base, &f, None, "개인 메모 정리").await;
    let lines = agent_lines(&su, &f, f.hosted).await;
    let reply = send(
        &client,
        &base,
        &f,
        &f.outsider_jwt,
        f.channel,
        Some(owned_root),
        "저도 궁금해요",
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(
        all_runs(&su, &f, f.hosted).await,
        0,
        "⑮ owner_only → no run"
    );
    assert_eq!(
        agent_lines(&su, &f, f.hosted).await,
        lines,
        "⑮ no 「소유자만」 line"
    );
    let skipped = audits(&su, &f, "agent.thread_wake.skipped", reply).await;
    assert_eq!(
        skipped[0]["reason"],
        json!("owner_only_non_owner"),
        "{skipped:?}"
    );
    assert_ne!(f.outsider, f.human);

    // No approval card anywhere — W1 is not the in-place grant (G6 ⑦).
    let approvals_after = count(
        &su,
        "SELECT count(*) FROM approval WHERE workspace_id=$1 AND $2::uuid IS NOT NULL",
        f.workspace,
        f.hosted,
    )
    .await;
    assert_eq!(approvals_after, approvals_before, "⑮ no approval rows");

    // Control: the owner's own reply in that thread passes every gate.
    human_says(
        &client,
        &base,
        &f,
        f.channel,
        Some(owned_root),
        "계속해 줘요",
    )
    .await;
    assert_eq!(
        wake_runs(&su, &f, f.hosted).await,
        1,
        "the owner's reply wakes it — the refusal above was the gate's"
    );
}
