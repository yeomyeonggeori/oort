//! #3938 C-S2 — an agent that runs its owner's connected apps is called by that
//! owner alone (ADR-0113 증보 2 E3). Real Axum router on a `momo_app`
//! (NOBYPASSRLS) pool; the agent under test is a *workspace-scoped* hosted agent
//! (NOT `owner_only` — migration 089 cannot express that case), so every refusal
//! below is the new branch and nothing else.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `only_the_agents_owner_turns_the_mark_on_or_off` | non-owner member, workspace admin, unknown agent → 403/404 in both directions and the column is untouched; owner on/off/on is idempotent with one audit row per change; an unknown body key is refused; the database refuses any value but the owner | `set_connector_owner_in_tx` owner check; `agent_connector_owner_is_owner` CHECK |
//! | `a_non_owners_call_is_not_delivered_and_answered_once` | owner mention/DM → job, 0 notice; non-owner mention → 0 job, 0 inbox event, 1 notice (threaded, owner named), throttled on repeat, 1 more after 11 min; DM → 0 job + notice; plain thread reply → not in the inbox; work request → 403 `connector_owner_only`; mark off → the same stranger is delivered | `owner_only_gate` connector arm; `subscription_notice` connector body; inbox fan-out predicate (both queries); `agent_runs::create` check |
//! | `a_thread_wake_by_a_non_owner_is_silent_and_the_owners_wakes` | non-owner plain reply in an agent-opened thread → 0 run, 0 agent line, one `agent.thread_wake.skipped` with the connector reason; owner reply → 1 wake run | the connector arm in `delivery_gate` |
//! | `the_welcome_opener_is_the_owners_alone` | `resolve_welcome_target_in_tx`: a stranger is not welcomed by the connector agent, the owner is | `load_welcome_agent_in_tx` predicate |
//!
//! Non-person authors (agent / work host) are pinned by the unit test
//! `the_connector_owner_gate_tells_a_person_and_stays_silent_for_the_rest` in
//! `routes/agent_mentions.rs`; the worker's A2A refusal by
//! `momo-agent-worker/tests/personal_credential_isolation.rs`.
//!
//! Isolated database only:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo PGHOST=127.0.0.1 PGPORT=<port> \
//!   PGUSER=momo PGPASSWORD=momo PGDATABASE=momo \
//!   cargo test -p momo-server --test connector_owner_conformance_pg -- --ignored --test-threads=1
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

const TEST_JWT_SECRET: &str = "connector-owner-pg-conformance-signing-secret";
const AUDIENCE: &str = "/v1/mcp/agent-port";
const NOTICE_SOURCE: &str = "server.subscription_agent.notice.v1";
const CONNECTOR_REASON: &str = "connector_owner_non_owner";

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
    .bind(format!("{human}@connector.test"))
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
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'connector-owner')",
    )
    .bind(workspace)
    .bind(human)
    .bind(&jwt)
    .execute(su)
    .await
    .expect("record the human session token");
    (human, jwt)
}

struct Fixture {
    workspace: Uuid,
    owner: Uuid,
    owner_jwt: String,
    admin_jwt: String,
    outsider_jwt: String,
    outsider: Uuid,
    /// Workspace-scoped hosted agent owned by `owner`, live connection.
    agent: Uuid,
    handle: String,
    /// An ownerless agent.
    orphan: Uuid,
    channel: Uuid,
    dm_owner: Uuid,
    dm_outsider: Uuid,
}

async fn seed(su: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("conn-{}", workspace.simple()))
        .execute(su)
        .await
        .expect("workspace");
    let (owner, owner_jwt) = seed_human(su, workspace, "member", "세은").await;
    let (_admin, admin_jwt) = seed_human(su, workspace, "admin", "관리자").await;
    let (outsider, outsider_jwt) = seed_human(su, workspace, "member", "동료").await;

    let agent = Uuid::new_v4();
    let orphan = Uuid::new_v4();
    let handle = format!("gmail{}", &agent.simple().to_string()[..8]);
    for (id, h, owned) in [
        (agent, handle.clone(), true),
        (
            orphan,
            format!("orph{}", &orphan.simple().to_string()[..8]),
            false,
        ),
    ] {
        insert_member(su, workspace, id, "agent", &h).await;
        sqlx::query(
            "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id, config) \
             VALUES($1,$2,'hosted-agent','https://hosted-agent.invalid/disabled',$3, \
                    '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb)",
        )
        .bind(id)
        .bind(workspace)
        .bind(owned.then_some(owner))
        .execute(su)
        .await
        .expect("agent");
        sqlx::query("INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')")
            .bind(workspace)
            .bind(id)
            .execute(su)
            .await
            .expect("agent membership");
        sqlx::query("INSERT INTO agent_profile(agent_member_id, workspace_id, updated_by, paused) VALUES($1,$2,$3,false)")
            .bind(id)
            .bind(workspace)
            .bind(owner)
            .execute(su)
            .await
            .expect("agent profile");
    }

    let mut rooms = Vec::new();
    for (kind, name, members) in [
        ("public", Some("apps"), vec![owner, outsider, agent]),
        ("dm", None, vec![owner, agent]),
        ("dm", None, vec![outsider, agent]),
    ] {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO channel(id, workspace_id, kind, name, dm_key) VALUES($1,$2,$3::channel_kind,$4,$5)")
            .bind(id)
            .bind(workspace)
            .bind(kind)
            .bind(name.map(|n| format!("{n}-{}", id.simple())))
            .bind((kind == "dm").then(|| format!("dm-{}", id.simple())))
            .execute(su)
            .await
            .expect("channel");
        sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
            .bind(id)
            .bind(workspace)
            .execute(su)
            .await
            .expect("channel_seq");
        for member in members {
            sqlx::query(
                "INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)",
            )
            .bind(workspace)
            .bind(id)
            .bind(member)
            .execute(su)
            .await
            .expect("membership");
        }
        rooms.push(id);
    }

    let connection = Uuid::new_v4();
    let scopes: Vec<String> = [
        "agent:port:connect",
        "agent:inbox:read",
        "messages:read",
        "messages:write",
        "agent:jobs:read",
        "agent:runs:callback",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();
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
    .bind(vec![rooms[0]])
    .bind(&scopes)
    .execute(su)
    .await
    .expect("connection");
    let bearer = format!(
        "momo_agent_v1.{workspace}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let token: Uuid = sqlx::query_scalar(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, created_by) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'),$4,'connector', \
                'hosted_active',$5,$6,$7) RETURNING id",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&bearer)
    .bind(&scopes)
    .bind(connection)
    .bind(AUDIENCE)
    .bind(owner)
    .fetch_one(su)
    .await
    .expect("token");
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='active', active_token_id=$3, \
           proved_at=now(), proved_by=$4 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .bind(token)
    .bind(agent)
    .execute(su)
    .await
    .expect("activate");

    Fixture {
        workspace,
        owner,
        owner_jwt,
        admin_jwt,
        outsider_jwt,
        outsider,
        agent,
        handle,
        orphan,
        channel: rooms[0],
        dm_owner: rooms[1],
        dm_outsider: rooms[2],
    }
}

async fn setup() -> (PgPool, PgPool, Fixture, String, reqwest::Client) {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    (su, app, f, base, reqwest::Client::new())
}

async fn put_mark(
    client: &reqwest::Client,
    base: &str,
    f: &Fixture,
    jwt: &str,
    agent: Uuid,
    body: Value,
) -> u16 {
    client
        .put(format!(
            "{base}/v1/workspaces/{}/agents/{agent}/connector-owner",
            f.workspace
        ))
        .bearer_auth(jwt)
        .json(&body)
        .send()
        .await
        .expect("put")
        .status()
        .as_u16()
}

async fn mark(su: &PgPool, f: &Fixture, agent: Uuid) -> Option<Uuid> {
    sqlx::query_scalar(
        "SELECT connector_owner_human_id FROM agent WHERE workspace_id=$1 AND member_id=$2",
    )
    .bind(f.workspace)
    .bind(agent)
    .fetch_one(su)
    .await
    .expect("mark")
}

async fn send(
    client: &reqwest::Client,
    base: &str,
    f: &Fixture,
    jwt: &str,
    channel: Uuid,
    root: Option<Uuid>,
    body: &str,
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
    let value: Value = response.json().await.expect("body");
    assert_eq!(status, 201, "send: {value}");
    Uuid::parse_str(value["id"].as_str().expect("id")).expect("uuid")
}

async fn count(su: &PgPool, sql: &str, f: &Fixture) -> i64 {
    sqlx::query_scalar::<_, i64>(sql)
        .bind(f.workspace)
        .bind(f.agent)
        .fetch_one(su)
        .await
        .expect("count")
}

async fn jobs(su: &PgPool, f: &Fixture) -> i64 {
    count(su, "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' AND partition_key=$2", f).await
}

async fn inbox_messages(su: &PgPool, f: &Fixture) -> i64 {
    count(su, "SELECT count(*) FROM hosted_agent_inbox_event WHERE workspace_id=$1 AND agent_member_id=$2 AND event_kind='message'", f).await
}

async fn runs(su: &PgPool, f: &Fixture) -> i64 {
    count(
        su,
        "SELECT count(*) FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2",
        f,
    )
    .await
}

async fn agent_lines(su: &PgPool, f: &Fixture) -> i64 {
    count(
        su,
        "SELECT count(*) FROM message WHERE workspace_id=$1 AND author_member_id=$2",
        f,
    )
    .await
}

/// `(body, root_id, kind, recipient)` of every connector notice, oldest first.
async fn notices(su: &PgPool, f: &Fixture) -> Vec<(String, Option<Uuid>, String, String)> {
    sqlx::query_as(
        "SELECT body, root_id, props->>'subscription_notice', props->>'notice_for_member_id' \
           FROM message WHERE workspace_id=$1 AND author_member_id=$2 \
            AND props->>'source'=$3 ORDER BY seq",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .bind(NOTICE_SOURCE)
    .fetch_all(su)
    .await
    .unwrap()
}

async fn skip_reasons(su: &PgPool, f: &Fixture, action: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT COALESCE(detail->>'reason','') FROM audit_log WHERE workspace_id=$1 AND action=$2 AND subject_member_id=$3 ORDER BY id")
        .bind(f.workspace)
        .bind(action)
        .bind(f.agent)
        .fetch_all(su)
        .await
        .unwrap()
}

fn notice_body() -> String {
    "이 에이전트는 세은님의 앱 권한으로 움직여서, 세은님만 부를 수 있어요.".to_string()
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3938)"]
async fn only_the_agents_owner_turns_the_mark_on_or_off() {
    let (su, _app, f, base, client) = setup().await;
    let on = json!({"enabled": true});
    let off = json!({"enabled": false});

    // Not the owner: a member, a workspace admin. On AND off.
    for jwt in [&f.outsider_jwt, &f.admin_jwt] {
        assert_eq!(
            put_mark(&client, &base, &f, jwt, f.agent, on.clone()).await,
            403
        );
    }
    assert_eq!(mark(&su, &f, f.agent).await, None);
    // An ownerless agent can be marked by nobody.
    assert_eq!(
        put_mark(&client, &base, &f, &f.owner_jwt, f.orphan, on.clone()).await,
        403
    );
    assert_eq!(
        put_mark(&client, &base, &f, &f.owner_jwt, Uuid::new_v4(), on.clone()).await,
        404
    );
    // The body is closed.
    assert_eq!(
        put_mark(
            &client,
            &base,
            &f,
            &f.owner_jwt,
            f.agent,
            json!({"enabled": true, "ownerId": f.outsider})
        )
        .await,
        422
    );
    assert_eq!(mark(&su, &f, f.agent).await, None);

    // The owner: on (idempotent), then a non-owner cannot switch it off.
    assert_eq!(
        put_mark(&client, &base, &f, &f.owner_jwt, f.agent, on.clone()).await,
        200
    );
    assert_eq!(
        put_mark(&client, &base, &f, &f.owner_jwt, f.agent, on.clone()).await,
        200
    );
    assert_eq!(mark(&su, &f, f.agent).await, Some(f.owner));
    for jwt in [&f.outsider_jwt, &f.admin_jwt] {
        assert_eq!(
            put_mark(&client, &base, &f, jwt, f.agent, off.clone()).await,
            403
        );
    }
    assert_eq!(
        mark(&su, &f, f.agent).await,
        Some(f.owner),
        "a refused off leaves it on"
    );
    let scope: String = sqlx::query_scalar("SELECT invocation_scope FROM agent WHERE member_id=$1")
        .bind(f.agent)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(
        scope, "workspace",
        "the mark does not touch owner_only (089)"
    );

    // Off is immediate; one audit row per real change.
    assert_eq!(
        put_mark(&client, &base, &f, &f.owner_jwt, f.agent, off.clone()).await,
        200
    );
    assert_eq!(
        put_mark(&client, &base, &f, &f.owner_jwt, f.agent, off).await,
        200
    );
    assert_eq!(mark(&su, &f, f.agent).await, None);
    let audited = skip_reasons(&su, &f, "agent.connector_owner.updated").await;
    assert_eq!(audited.len(), 2, "on once, off once: {audited:?}");

    // The database holds the line too: no value but the agent's own owner.
    let forged = sqlx::query(
        "UPDATE agent SET connector_owner_human_id=$3 WHERE workspace_id=$1 AND member_id=$2",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .bind(f.outsider)
    .execute(&su)
    .await;
    assert!(forged.is_err(), "agent_connector_owner_is_owner");
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3938)"]
async fn a_non_owners_call_is_not_delivered_and_answered_once() {
    let (su, _app, f, base, client) = setup().await;
    let mention = format!("@{} 메일 확인해 줘", f.handle);

    // Control before the mark: the stranger is an ordinary caller, delivered.
    send(
        &client,
        &base,
        &f,
        &f.outsider_jwt,
        f.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(jobs(&su, &f).await, 1, "no mark, no refusal");
    assert_eq!(
        put_mark(
            &client,
            &base,
            &f,
            &f.owner_jwt,
            f.agent,
            json!({"enabled": true})
        )
        .await,
        200
    );
    let baseline_jobs = jobs(&su, &f).await;

    // The owner is delivered, nobody is told anything.
    let root = send(&client, &base, &f, &f.owner_jwt, f.channel, None, &mention).await;
    assert_eq!(
        jobs(&su, &f).await,
        baseline_jobs + 1,
        "the owner's mention is a job"
    );
    assert!(notices(&su, &f).await.is_empty());
    let inbox_before = inbox_messages(&su, &f).await;

    // The stranger: 0 job, 0 inbox event, one sentence naming the owner.
    let first = send(
        &client,
        &base,
        &f,
        &f.outsider_jwt,
        f.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(jobs(&su, &f).await, baseline_jobs + 1, "nothing delivered");
    assert_eq!(
        inbox_messages(&su, &f).await,
        inbox_before,
        "not even an inbox event"
    );
    assert_eq!(
        skip_reasons(&su, &f, "agent.mention.skipped")
            .await
            .last()
            .map(String::as_str),
        Some(CONNECTOR_REASON)
    );
    let posted = notices(&su, &f).await;
    assert_eq!(posted.len(), 1, "{posted:?}");
    assert_eq!(posted[0].0, notice_body());
    assert_eq!(posted[0].1, Some(first));
    assert_eq!(posted[0].2, "connector_non_owner");
    assert_eq!(posted[0].3, f.outsider.to_string());

    // Throttled inside ten minutes, one more after.
    send(
        &client,
        &base,
        &f,
        &f.outsider_jwt,
        f.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(notices(&su, &f).await.len(), 1);
    sqlx::query("UPDATE message SET created_at = created_at - interval '11 minutes' WHERE workspace_id=$1 AND author_member_id=$2 AND props->>'source'=$3")
        .bind(f.workspace)
        .bind(f.agent)
        .bind(NOTICE_SOURCE)
        .execute(&su)
        .await
        .unwrap();
    send(
        &client,
        &base,
        &f,
        &f.outsider_jwt,
        f.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(notices(&su, &f).await.len(), 2);
    assert_eq!(jobs(&su, &f).await, baseline_jobs + 1);

    // A plain thread reply by the stranger never reaches the agent's inbox;
    // the owner's does (the zero is not vacuous).
    let before = inbox_messages(&su, &f).await;
    send(
        &client,
        &base,
        &f,
        &f.outsider_jwt,
        f.channel,
        Some(root),
        "그냥 답글",
    )
    .await;
    assert_eq!(
        inbox_messages(&su, &f).await,
        before,
        "stranger's reply is not delivered"
    );
    send(
        &client,
        &base,
        &f,
        &f.owner_jwt,
        f.channel,
        Some(root),
        "제 답글",
    )
    .await;
    assert!(
        inbox_messages(&su, &f).await > before,
        "the owner's reply is"
    );
    assert_eq!(
        notices(&su, &f).await.len(),
        2,
        "a reply without a mention is told nothing"
    );

    // DM rule: the stranger's DM is refused with the sentence, the owner's is delivered.
    let dm_jobs = jobs(&su, &f).await;
    send(
        &client,
        &base,
        &f,
        &f.outsider_jwt,
        f.dm_outsider,
        None,
        "안녕?",
    )
    .await;
    assert_eq!(
        jobs(&su, &f).await,
        dm_jobs,
        "a stranger's DM delivers nothing"
    );
    let dm_notices: i64 = sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id=$1 AND channel_id=$2 AND author_member_id=$3 AND props->>'subscription_notice'='connector_non_owner'")
        .bind(f.workspace)
        .bind(f.dm_outsider)
        .bind(f.agent)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(dm_notices, 1);
    send(&client, &base, &f, &f.owner_jwt, f.dm_owner, None, "안녕").await;
    assert_eq!(jobs(&su, &f).await, dm_jobs + 1, "the owner's DM is a job");

    // Work request (type=work): 403 with its own code for the stranger.
    let work = |jwt: String| {
        let client = client.clone();
        let url = format!(
            "{base}/v1/workspaces/{}/channels/{}/agent-runs",
            f.workspace, f.channel
        );
        let agent = f.agent;
        async move {
            let response = client
                .post(url)
                .bearer_auth(jwt)
                .json(
                    &json!({"agent_member_id": agent, "client_run_id": Uuid::new_v4(),
                              "input": {"type": "work", "title": "t", "brief": "b"}}),
                )
                .send()
                .await
                .unwrap();
            let status = response.status().as_u16();
            let value: Value = response.json().await.unwrap_or(Value::Null);
            (status, value)
        }
    };
    let runs_before = runs(&su, &f).await;
    let (status, body) = work(f.outsider_jwt.clone()).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(
        body["error"]["code"].as_str().or(body["code"].as_str()),
        Some("connector_owner_only"),
        "{body}"
    );
    assert_eq!(
        runs(&su, &f).await,
        runs_before,
        "no run from a refused request"
    );
    let (status, body) = work(f.owner_jwt.clone()).await;
    assert_ne!(status, 403, "the owner passes the connector check: {body}");

    // Off is immediate: the same stranger is delivered again.
    assert_eq!(
        put_mark(
            &client,
            &base,
            &f,
            &f.owner_jwt,
            f.agent,
            json!({"enabled": false})
        )
        .await,
        200
    );
    let notices_before = notices(&su, &f).await.len();
    let jobs_before = jobs(&su, &f).await;
    send(
        &client,
        &base,
        &f,
        &f.outsider_jwt,
        f.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(jobs(&su, &f).await, jobs_before + 1);
    assert_eq!(notices(&su, &f).await.len(), notices_before);
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3938)"]
async fn a_thread_wake_by_a_non_owner_is_silent_and_the_owners_wakes() {
    let (su, app, f, base, client) = setup().await;
    assert_eq!(
        put_mark(
            &client,
            &base,
            &f,
            &f.owner_jwt,
            f.agent,
            json!({"enabled": true})
        )
        .await,
        200
    );
    // The agent opened a thread (fixture line, written through the single write path).
    let (workspace, channel, agent) = (f.workspace, f.channel, f.agent);
    let root = momo_db::with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            let mut message = NewMessage::text(channel, agent, "메일 요약이에요".to_string());
            message.message_type = MessageType::Text;
            message.client_msg_id = Some(Uuid::new_v4());
            Ok(send_message_in_tx(conn, workspace, message)
                .await?
                .message
                .id)
        })
    })
    .await
    .expect("agent root");
    let lines = agent_lines(&su, &f).await;
    let reply = send(
        &client,
        &base,
        &f,
        &f.outsider_jwt,
        f.channel,
        Some(root),
        "이것 좀 봐요",
    )
    .await;
    assert_eq!(runs(&su, &f).await, 0, "a stranger's reply wakes nothing");
    assert_eq!(jobs(&su, &f).await, 0);
    assert_eq!(agent_lines(&su, &f).await, lines, "and nothing is said");
    let skipped: Vec<Value> = sqlx::query_scalar("SELECT detail FROM audit_log WHERE workspace_id=$1 AND action='agent.thread_wake.skipped' AND target_id=$2")
        .bind(f.workspace)
        .bind(reply)
        .fetch_all(&su)
        .await
        .unwrap();
    assert_eq!(skipped.len(), 1);
    assert_eq!(skipped[0]["reason"], json!(CONNECTOR_REASON));
    // Control: the owner's reply wakes it.
    send(
        &client,
        &base,
        &f,
        &f.owner_jwt,
        f.channel,
        Some(root),
        "계속해 줘요",
    )
    .await;
    assert_eq!(
        runs(&su, &f).await,
        1,
        "the refusal above was the connector gate's"
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3938)"]
async fn the_welcome_opener_is_the_owners_alone() {
    let (su, app, f, base, client) = setup().await;
    assert_eq!(
        put_mark(
            &client,
            &base,
            &f,
            &f.owner_jwt,
            f.agent,
            json!({"enabled": true})
        )
        .await,
        200
    );
    // The welcome lands in #general: give the fixture one the agent is approved for.
    let general = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel(id, workspace_id, kind, name) VALUES($1,$2,'public','general')",
    )
    .bind(general)
    .bind(f.workspace)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
        .bind(general)
        .bind(f.workspace)
        .execute(&su)
        .await
        .unwrap();
    for member in [f.owner, f.outsider, f.agent] {
        sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
            .bind(f.workspace)
            .bind(general)
            .bind(member)
            .execute(&su)
            .await
            .unwrap();
    }
    sqlx::query("UPDATE hosted_agent_connection SET approved_channel_ids = approved_channel_ids || $2::uuid WHERE workspace_id=$1 AND agent_member_id=$3")
        .bind(f.workspace)
        .bind(general)
        .bind(f.agent)
        .execute(&su)
        .await
        .unwrap();
    let resolve = |member: Uuid| {
        let app = app.clone();
        let workspace = f.workspace;
        async move {
            momo_db::with_tenant_tx(&app, workspace, move |conn| {
                Box::pin(async move {
                    momo_agent::resolve_welcome_target_in_tx(
                        conn, workspace, true, None, member, true, true,
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
        resolve(f.outsider).await,
        None,
        "a stranger is not welcomed by the connected agent"
    );
    assert_eq!(resolve(f.owner).await, Some(f.agent), "the owner is");
    let _ = (&su, f.dm_owner);
}
