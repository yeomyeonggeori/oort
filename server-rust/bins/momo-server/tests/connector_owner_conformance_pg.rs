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
//! | `a_job_queued_before_the_mark_is_closed_at_claim_not_run` | job + inbox message written by a stranger while the mark was off → mark on → `oort_jobs_claim` takes only the owner's job; the stranger's job is `done` with its reason, its run `cancelled`, one audit row; `oort_inbox_read` hides the stranger's message and shows the owner's | the claim predicate + `close_connector_foreign_jobs_in_tx`; the inbox `visible` re-check |
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
use momo_server::config::{
    AgentGatewayMode, AgentGatewaySettings, AgentPortConfig, CohostedAgentConfig, SettingsConfig,
};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "connector-owner-pg-conformance-signing-secret";
const AUDIENCE: &str = "/v1/mcp/agent-port";
const PATH: &str = "/v1/mcp/agent-port";
const MODERN_VERSION: &str = "2026-07-28";
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
    start_server_with(pool, CohostedAgentConfig::default(), None).await
}

/// `cohosted` is what the operator declared in the server's environment (#3948);
/// `operator_email` is the one address on `PLATFORM_ADMIN_EMAILS`.
async fn start_server_with(
    pool: PgPool,
    cohosted: CohostedAgentConfig,
    operator_email: Option<String>,
) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_settings(SettingsConfig {
        platform_admin_emails: operator_email.into_iter().collect(),
        ..SettingsConfig::default()
    })
    .with_cohosted(
        cohosted,
        std::sync::Arc::new(momo_provider_probe::GuardedProviderProbe::new(
            momo_settings::EgressPolicy::default(),
            std::time::Duration::from_secs(5),
        )),
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
    bearer: String,
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
        bearer,
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
        .expect("tools/call");
    let value: Value = response.json().await.expect("body");
    assert!(
        value.get("error").is_none() && value["result"]["isError"] != json!(true),
        "{tool}: {value}"
    );
    value["result"]["structuredContent"].clone()
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3938)"]
async fn a_job_queued_before_the_mark_is_closed_at_claim_not_run() {
    let (su, _app, f, base, client) = setup().await;
    let mention = format!("@{} 메일 확인해 줘", f.handle);

    // Mark OFF: a stranger's and the owner's calls are both queued.
    let stranger_msg = send(
        &client,
        &base,
        &f,
        &f.outsider_jwt,
        f.channel,
        None,
        &mention,
    )
    .await;
    let owner_msg = send(&client, &base, &f, &f.owner_jwt, f.channel, None, &mention).await;
    assert_eq!(jobs(&su, &f).await, 2);
    let queued: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT o.id, upper(o.payload->>'author_member_id'), o.status::text FROM outbox o \
          WHERE o.workspace_id=$1 AND o.kind='agent_job' AND o.partition_key=$2 ORDER BY o.id",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(queued.len(), 2);

    // Mark ON afterwards. Nothing is retired by the toggle itself.
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
    let still_pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' AND partition_key=$2 AND status='pending'",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(still_pending, 2, "the toggle does not bulk-retire");

    // The inbox read hides the stranger's message and shows the owner's.
    let inbox = port_call(
        &client,
        &base,
        &f.bearer,
        "oort_inbox_read",
        json!({"limit": 50}),
    )
    .await;
    let events = inbox["events"].as_array().expect("events");
    let seen = |id: Uuid| {
        events.iter().any(|e| {
            e["messageId"] == json!(id.to_string())
                || e["messageId"] == json!(id.to_string().to_uppercase())
        })
    };
    assert!(
        seen(owner_msg),
        "the owner's queued message is readable: {inbox}"
    );
    assert!(
        !seen(stranger_msg),
        "the stranger's queued message is not: {inbox}"
    );

    // The claim takes the owner's job only.
    let claimed = port_call(
        &client,
        &base,
        &f.bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    let claimed_jobs = claimed["jobs"].as_array().expect("jobs");
    assert_eq!(
        claimed_jobs.len(),
        1,
        "only the owner's job is handed over: {claimed}"
    );
    assert!(
        claimed
            .to_string()
            .contains(&owner_msg.to_string().to_uppercase())
            || claimed.to_string().contains(&owner_msg.to_string())
    );

    // The stranger's job is closed, its run cancelled, one audit row.
    let closed: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT status::text, last_error FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
          AND partition_key=$2 AND status='done'",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(closed.len(), 1, "{closed:?}");
    assert_eq!(
        closed[0].1.as_deref(),
        Some("connector owner only; job closed")
    );
    let cancelled: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2 AND status='cancelled' AND error->>'code'='connector_owner_only'",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(cancelled, 1);
    assert_eq!(
        skip_reasons(&su, &f, "agent.connector_owner.job_closed").await,
        vec![CONNECTOR_REASON.to_string()]
    );
    // A second claim is quiet: the closed job is not resurrected.
    let again = port_call(
        &client,
        &base,
        &f.bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(again["jobs"].as_array().map_or(0, Vec::len), 0);
}

// ===========================================================================
// #3948 K-S2 — 「커넥터 시험」 (ADR-0203 증보 K2·K4, red proof 1~6)
//
// A workspace of ONE person whose Hermes (pinned to the operator's env link) reads
// that person's apps. The agent here is a managed, non-hosted agent, so a delivery
// is an `agent_job` outbox row and a refusal is zero such rows. Every assertion
// counts rows; the control that proves each zero is not vacuous is a delivered job
// in the same test.
//
// | test | proves (red proof) | goes red if |
// |---|---|---|
// | `the_trial_turns_on_only_for_the_operator_with_one_person_and_both_attests` | 1 two active people → 409 `connector_trial_members`, 0 marks; 4 each of the three attestation inputs missing → 409 `connector_trial_attest`, 0 marks; 5 an unlisted-grant app → 409 `connector_trial_apps`; 6 a non-operator → 403, 0 marks; an unpinned agent → 409; the generic route cannot mark the pinned agent | the operator gate, the people count, the attest check, the grant check, the pin check, or the generic route's pin refusal |
// | `a_person_joining_after_the_trial_is_on_stops_delivery_with_one_notice` | 2 a second person added by a direct row (no invite) → the owner's mention, DM and work request deliver 0; one notice with the ADR sentence, throttled; the stranger gets the owner sentence (3); gone → delivered again | the people count in the candidate query or `delivery_gate`; the work-request check; the DM state |
// | `the_attestation_leaving_the_environment_stops_delivery` | 4 each attest input removed on a running trial → 0 delivery, one notice; restored → delivered | the attest arm of `connector_trial_stop` or its wiring |
// | `an_app_that_lost_the_owners_grant_stops_delivery` | 5 grant revoked / install revoked for a listed app → 0 delivery, one notice; an unlisted app's grant changing does not | the grant arm / the install join |
// ===========================================================================

const APP_A: &str = "com.momo.plugins.github";
const APP_B: &str = "com.momo.plugins.notion";

struct Trial {
    workspace: Uuid,
    operator: Uuid,
    operator_jwt: String,
    operator_email: String,
    /// The operator's Hermes: managed, pinned to the operator's env link.
    agent: Uuid,
    handle: String,
    /// An agent the operator owns that is NOT pinned (a workd-style agent).
    unpinned: Uuid,
    channel: Uuid,
    dm: Uuid,
}

impl Trial {
    fn fx(&self) -> Fixture {
        // The shared helpers (`count`, `jobs`, ...) read three ids from a Fixture.
        Fixture {
            workspace: self.workspace,
            owner: self.operator,
            owner_jwt: self.operator_jwt.clone(),
            admin_jwt: String::new(),
            outsider_jwt: String::new(),
            outsider: Uuid::nil(),
            agent: self.agent,
            bearer: String::new(),
            handle: self.handle.clone(),
            orphan: Uuid::nil(),
            channel: self.channel,
            dm_owner: self.dm,
            dm_outsider: Uuid::nil(),
        }
    }
}

async fn seed_trial(su: &PgPool) -> Trial {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("trial-{}", workspace.simple()))
        .execute(su)
        .await
        .expect("workspace");
    let (operator, operator_jwt) = seed_human(su, workspace, "owner", "운영자").await;
    let operator_email = format!("{operator}@connector.test");
    let mut agents = Vec::new();
    for (label, pinned) in [("hermes", true), ("loose", false)] {
        let id = Uuid::new_v4();
        let handle = format!("{label}{}", &id.simple().to_string()[..8]);
        insert_member(su, workspace, id, "agent", &handle).await;
        sqlx::query(
            "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id) \
             VALUES($1,$2,'hermes-agent','https://cohosted-agent.invalid/v1',$3)",
        )
        .bind(id)
        .bind(workspace)
        .bind(operator)
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
            .bind(operator)
            .execute(su)
            .await
            .expect("agent profile");
        if pinned {
            sqlx::query(
                "INSERT INTO agent_provider_pin(agent_member_id, workspace_id, kind, pinned_by) \
                 VALUES($1,$2,'operator_env',$3)",
            )
            .bind(id)
            .bind(workspace)
            .bind(operator)
            .execute(su)
            .await
            .expect("pin");
        }
        agents.push((id, handle));
    }
    let mut rooms = Vec::new();
    for (kind, name) in [("public", Some("apps")), ("dm", None)] {
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
        let members = if kind == "dm" {
            vec![operator, agents[0].0]
        } else {
            vec![operator, agents[0].0, agents[1].0]
        };
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
    Trial {
        workspace,
        operator,
        operator_jwt,
        operator_email,
        agent: agents[0].0,
        handle: agents[0].1.clone(),
        unpinned: agents[1].0,
        channel: rooms[0],
        dm: rooms[1],
    }
}

/// An install (enabled) and an active grant of `app` for `member`.
async fn grant_app(su: &PgPool, t: &Trial, member: Uuid, app: &str) {
    let audit: Uuid = sqlx::query_scalar(
        "INSERT INTO audit_log (workspace_id, actor_member_id, subject_member_id, action) \
         VALUES ($1, $2, $2, 'plugin.grant') RETURNING id",
    )
    .bind(t.workspace)
    .bind(member)
    .fetch_one(su)
    .await
    .expect("audit");
    sqlx::query(
        "INSERT INTO workspace_plugin_install (workspace_id, plugin_id, enabled, installed_by, installed_audit_id) \
         VALUES ($1, $2, true, $3, $4) ON CONFLICT (workspace_id, plugin_id) DO NOTHING",
    )
    .bind(t.workspace)
    .bind(app)
    .bind(member)
    .bind(audit)
    .execute(su)
    .await
    .expect("install");
    sqlx::query(
        "INSERT INTO plugin_grant (workspace_id, member_id, plugin_id, scope, granted_by, granted_audit_id) \
         VALUES ($1, $2, $3, 'read', $2, $4)",
    )
    .bind(t.workspace)
    .bind(member)
    .bind(app)
    .bind(audit)
    .execute(su)
    .await
    .expect("grant");
}

async fn revoke_grant(su: &PgPool, t: &Trial, member: Uuid, app: &str) {
    let audit: Uuid = sqlx::query_scalar(
        "INSERT INTO audit_log (workspace_id, actor_member_id, subject_member_id, action) \
         VALUES ($1, $2, $2, 'plugin.revoke') RETURNING id",
    )
    .bind(t.workspace)
    .bind(member)
    .fetch_one(su)
    .await
    .expect("audit");
    let n = sqlx::query(
        "UPDATE plugin_grant SET status='revoked', revoked_at=now(), revoked_audit_id=$4 \
          WHERE workspace_id=$1 AND member_id=$2 AND plugin_id=$3",
    )
    .bind(t.workspace)
    .bind(member)
    .bind(app)
    .bind(audit)
    .execute(su)
    .await
    .expect("revoke")
    .rows_affected();
    assert_eq!(n, 1);
}

async fn restore_grant(su: &PgPool, t: &Trial, member: Uuid, app: &str) {
    sqlx::query(
        "UPDATE plugin_grant SET status='active', revoked_at=NULL, revoked_audit_id=NULL \
          WHERE workspace_id=$1 AND member_id=$2 AND plugin_id=$3",
    )
    .bind(t.workspace)
    .bind(member)
    .bind(app)
    .execute(su)
    .await
    .expect("restore");
}

/// Another person, added by a bare row: no invite, no join route.
async fn add_person_directly(su: &PgPool, t: &Trial, handle: &str) -> Uuid {
    let (id, _jwt) = seed_human(su, t.workspace, "member", handle).await;
    id
}

async fn deactivate(su: &PgPool, t: &Trial, member: Uuid) {
    sqlx::query("UPDATE member SET status='suspended' WHERE workspace_id=$1 AND id=$2")
        .bind(t.workspace)
        .bind(member)
        .execute(su)
        .await
        .expect("deactivate");
}

fn attested(apps: &[&str]) -> CohostedAgentConfig {
    CohostedAgentConfig {
        declared: false,
        tools_locked: true,
        connectors_locked: true,
        connector_apps: apps.iter().map(|a| (*a).to_string()).collect(),
    }
}

/// `(status, code)` of `PUT …/connector-trial`.
async fn put_trial(
    client: &reqwest::Client,
    base: &str,
    t: &Trial,
    jwt: &str,
    agent: Uuid,
    body: Value,
) -> (u16, Option<String>) {
    let response = client
        .put(format!(
            "{base}/v1/workspaces/{}/agents/{agent}/connector-trial",
            t.workspace
        ))
        .bearer_auth(jwt)
        .json(&body)
        .send()
        .await
        .expect("put trial");
    let status = response.status().as_u16();
    let value: Value = response.json().await.unwrap_or(Value::Null);
    let code = value["error"]["code"]
        .as_str()
        .or(value["code"].as_str())
        .map(str::to_string);
    (status, code)
}

async fn get_trial(client: &reqwest::Client, base: &str, t: &Trial, jwt: &str) -> (u16, Value) {
    let response = client
        .get(format!(
            "{base}/v1/workspaces/{}/agents/{}/connector-trial",
            t.workspace, t.agent
        ))
        .bearer_auth(jwt)
        .send()
        .await
        .expect("get trial");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

/// How many agents of the workspace carry the mark.
async fn marks(su: &PgPool, t: &Trial) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM agent WHERE workspace_id=$1 AND connector_owner_human_id IS NOT NULL",
    )
    .bind(t.workspace)
    .fetch_one(su)
    .await
    .unwrap()
}

async fn trial_audits(su: &PgPool, t: &Trial) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND action='agent.connector_trial.updated'",
    )
    .bind(t.workspace)
    .fetch_one(su)
    .await
    .unwrap()
}

/// `(body, kind)` of the trial notices the agent said, oldest first.
async fn trial_notices(su: &PgPool, t: &Trial) -> Vec<(String, String)> {
    sqlx::query_as(
        "SELECT body, props->>'subscription_notice' FROM message \
          WHERE workspace_id=$1 AND author_member_id=$2 AND props->>'source'=$3 \
            AND props->>'subscription_notice' LIKE 'connector_trial_%' ORDER BY seq",
    )
    .bind(t.workspace)
    .bind(t.agent)
    .bind(NOTICE_SOURCE)
    .fetch_all(su)
    .await
    .unwrap()
}

async fn trial_setup() -> (PgPool, PgPool, Trial, reqwest::Client) {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let t = seed_trial(&su).await;
    grant_app(&su, &t, t.operator, APP_A).await;
    grant_app(&su, &t, t.operator, APP_B).await;
    let app = momo_app_pool().await;
    (su, app, t, reqwest::Client::new())
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3948)"]
async fn the_trial_turns_on_only_for_the_operator_with_one_person_and_both_attests() {
    let (su, app, t, client) = trial_setup().await;
    let on = json!({"enabled": true});
    let operator = Some(t.operator_email.clone());
    let good = start_server_with(app.clone(), attested(&[APP_A, APP_B]), operator.clone()).await;

    // Red proof 1 + 6: a second ACTIVE person, added without any invite.
    let second = add_person_directly(&su, &t, "동료").await;
    let second_jwt = momo_auth::sign_access(second, t.workspace, &[], TEST_JWT_SECRET)
        .expect("jwt")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'second')",
    )
    .bind(t.workspace)
    .bind(second)
    .bind(&second_jwt)
    .execute(&su)
    .await
    .unwrap();
    assert_eq!(
        put_trial(&client, &good, &t, &t.operator_jwt, t.agent, on.clone()).await,
        (409, Some("connector_trial_members".to_string())),
        "two active people"
    );
    assert_eq!(marks(&su, &t).await, 0, "nothing recorded");
    assert_eq!(trial_audits(&su, &t).await, 0);
    // A person who is not an instance operator: 403 whatever the people count.
    assert_eq!(
        put_trial(&client, &good, &t, &second_jwt, t.agent, on.clone())
            .await
            .0,
        403
    );
    assert_eq!(get_trial(&client, &good, &t, &second_jwt).await.0, 403);
    assert_eq!(marks(&su, &t).await, 0);
    // The second person leaves; now the control is the same request succeeding.
    deactivate(&su, &t, second).await;

    // Red proof 6, the case only the instance-operator gate can refuse: the agent's own
    // owner, an admin of the workspace, whose address is not on PLATFORM_ADMIN_EMAILS.
    let not_listed = start_server_with(
        app.clone(),
        attested(&[APP_A, APP_B]),
        Some("someone-else@connector.test".to_string()),
    )
    .await;
    assert_eq!(
        put_trial(
            &client,
            &not_listed,
            &t,
            &t.operator_jwt,
            t.agent,
            on.clone()
        )
        .await
        .0,
        403,
        "owner of the agent, but not an instance operator"
    );
    assert_eq!(
        get_trial(&client, &not_listed, &t, &t.operator_jwt).await.0,
        403
    );
    assert_eq!(marks(&su, &t).await, 0);

    // Red proof 4: each attestation input missing alone, then the control.
    let missing = [
        CohostedAgentConfig {
            tools_locked: false,
            ..attested(&[APP_A, APP_B])
        },
        CohostedAgentConfig {
            connectors_locked: false,
            ..attested(&[APP_A, APP_B])
        },
        attested(&[]),
    ];
    for config in missing {
        let base = start_server_with(app.clone(), config, operator.clone()).await;
        assert_eq!(
            put_trial(&client, &base, &t, &t.operator_jwt, t.agent, on.clone()).await,
            (409, Some("connector_trial_attest".to_string()))
        );
        assert_eq!(marks(&su, &t).await, 0);
    }
    // Red proof 5 at enable time: an app on in Hermes that the owner never granted.
    let ungranted = start_server_with(
        app.clone(),
        attested(&[APP_A, "com.momo.plugins.linear"]),
        operator.clone(),
    )
    .await;
    assert_eq!(
        put_trial(
            &client,
            &ungranted,
            &t,
            &t.operator_jwt,
            t.agent,
            on.clone()
        )
        .await,
        (409, Some("connector_trial_apps".to_string()))
    );
    assert_eq!(marks(&su, &t).await, 0);
    // Only the co-hosted (pinned) agent can be tried; the closed body; a stranger agent id.
    assert_eq!(
        put_trial(&client, &good, &t, &t.operator_jwt, t.unpinned, on.clone()).await,
        (409, Some("connector_trial_not_cohosted".to_string()))
    );
    assert_eq!(
        put_trial(
            &client,
            &good,
            &t,
            &t.operator_jwt,
            t.agent,
            json!({"enabled": true, "ownerId": second})
        )
        .await
        .0,
        422
    );
    assert_eq!(
        put_trial(
            &client,
            &good,
            &t,
            &t.operator_jwt,
            Uuid::new_v4(),
            on.clone()
        )
        .await
        .0,
        404
    );
    // Hermes has one token volume: while another agent of the workspace is pinned to
    // it too, the trial cannot be turned on (that agent would reach the same apps).
    sqlx::query(
        "INSERT INTO agent_provider_pin(agent_member_id, workspace_id, kind, pinned_by) \
         VALUES($1,$2,'operator_env',$3)",
    )
    .bind(t.unpinned)
    .bind(t.workspace)
    .bind(t.operator)
    .execute(&su)
    .await
    .unwrap();
    assert_eq!(
        put_trial(&client, &good, &t, &t.operator_jwt, t.agent, on.clone()).await,
        (409, Some("connector_trial_shared".to_string()))
    );
    assert_eq!(marks(&su, &t).await, 0);
    sqlx::query("DELETE FROM agent_provider_pin WHERE agent_member_id=$1")
        .bind(t.unpinned)
        .execute(&su)
        .await
        .unwrap();
    // The generic mark route cannot turn the pinned agent on behind the trial's back.
    let generic = client
        .put(format!(
            "{good}/v1/workspaces/{}/agents/{}/connector-owner",
            t.workspace, t.agent
        ))
        .bearer_auth(&t.operator_jwt)
        .json(&on)
        .send()
        .await
        .unwrap();
    assert_eq!(generic.status().as_u16(), 409);
    assert_eq!(marks(&su, &t).await, 0);

    // Control: everything in place → on, the mark is the operator, one audit row,
    // idempotent; the response says it is a self-declaration.
    assert_eq!(
        put_trial(&client, &good, &t, &t.operator_jwt, t.agent, on.clone())
            .await
            .0,
        200
    );
    assert_eq!(marks(&su, &t).await, 1);
    assert_eq!(mark(&su, &t.fx(), t.agent).await, Some(t.operator));
    assert_eq!(
        put_trial(&client, &good, &t, &t.operator_jwt, t.agent, on.clone())
            .await
            .0,
        200
    );
    assert_eq!(trial_audits(&su, &t).await, 1, "one change, one row");
    let (status, view) = get_trial(&client, &good, &t, &t.operator_jwt).await;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["enabled"], true);
    assert!(view["stopped"].is_null(), "flowing: {view}");
    assert_eq!(view["attested"]["selfDeclared"], true);
    assert!(
        view["note"].as_str().unwrap_or("").contains("자기 선언"),
        "{view}"
    );
    // While it is on, no second agent can be put on the same Hermes through the pin
    // route (409, nothing written); after it is off the same request is accepted.
    let pin_put = |agent: Uuid| {
        let client = client.clone();
        let url = format!(
            "{good}/v1/workspaces/{}/agents/{agent}/provider-pin",
            t.workspace
        );
        let jwt = t.operator_jwt.clone();
        async move {
            let response = client
                .put(url)
                .bearer_auth(jwt)
                .json(&json!({"kind": "operator_env"}))
                .send()
                .await
                .unwrap();
            let status = response.status().as_u16();
            let value: Value = response.json().await.unwrap_or(Value::Null);
            (
                status,
                value["error"]["code"]
                    .as_str()
                    .or(value["code"].as_str())
                    .map(str::to_string),
            )
        }
    };
    let pins = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM agent_provider_pin WHERE workspace_id=$1 AND kind='operator_env'",
        )
        .bind(t.workspace)
        .fetch_one(&su)
        .await
        .unwrap()
    };
    assert_eq!(pins().await, 1);
    assert_eq!(
        pin_put(t.unpinned).await,
        (409, Some("connector_trial_on".to_string()))
    );
    assert_eq!(pins().await, 1, "nothing was pinned");
    // Off is the operator's, immediate, and audited once.
    assert_eq!(
        put_trial(
            &client,
            &good,
            &t,
            &t.operator_jwt,
            t.agent,
            json!({"enabled": false})
        )
        .await
        .0,
        200
    );
    assert_eq!(marks(&su, &t).await, 0);
    assert_eq!(trial_audits(&su, &t).await, 2);
    assert_eq!(pin_put(t.unpinned).await.0, 200, "trial off: pin accepted");
    assert_eq!(pins().await, 2);
}

/// Turn the trial on through the route, with `apps` attested, on a running server.
async fn enable_trial(
    su: &PgPool,
    app: &PgPool,
    client: &reqwest::Client,
    t: &Trial,
    apps: &[&str],
) -> String {
    let base = start_server_with(app.clone(), attested(apps), Some(t.operator_email.clone())).await;
    assert_eq!(
        put_trial(
            client,
            &base,
            t,
            &t.operator_jwt,
            t.agent,
            json!({"enabled": true})
        )
        .await
        .0,
        200
    );
    assert_eq!(marks(su, t).await, 1);
    base
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3948)"]
async fn a_person_joining_after_the_trial_is_on_stops_delivery_with_one_notice() {
    let (su, app, t, client) = trial_setup().await;
    let base = enable_trial(&su, &app, &client, &t, &[APP_A, APP_B]).await;
    let fx = t.fx();
    let mention = format!("@{} 메일 확인해 줘", t.handle);

    // Control: with one person the owner's mention is a job and nobody is told anything.
    send(
        &client,
        &base,
        &fx,
        &t.operator_jwt,
        t.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(jobs(&su, &fx).await, 1);
    assert!(trial_notices(&su, &t).await.is_empty());

    // A second person arrives by a bare row (no invite). The next mention of the owner
    // delivers 0 and is answered once, with the ADR's sentence.
    let second = add_person_directly(&su, &t, "동료").await;
    let first = send(
        &client,
        &base,
        &fx,
        &t.operator_jwt,
        t.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(jobs(&su, &fx).await, 1, "nothing delivered");
    let said = trial_notices(&su, &t).await;
    assert_eq!(said.len(), 1, "{said:?}");
    assert_eq!(
        said[0].0,
        "워크스페이스에 사람이 늘어서 Hermes 앱 시험을 멈췄어요. Hermes의 앱 연결을 지우거나, 사람별 분리가 생길 때까지 기다려 주세요."
    );
    assert_eq!(said[0].1, "connector_trial_members");
    assert_eq!(
        skip_reasons(&su, &fx, "agent.mention.skipped")
            .await
            .last()
            .map(String::as_str),
        Some("connector_trial_members")
    );
    let _ = first;
    // Throttled, not repeated.
    send(
        &client,
        &base,
        &fx,
        &t.operator_jwt,
        t.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(trial_notices(&su, &t).await.len(), 1);
    assert_eq!(jobs(&su, &fx).await, 1);

    // The DM (no mention) and the work request stop too.
    send(&client, &base, &fx, &t.operator_jwt, t.dm, None, "안녕").await;
    assert_eq!(jobs(&su, &fx).await, 1, "a DM delivers nothing either");
    let runs_before = runs(&su, &fx).await;
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/agent-runs",
            t.workspace, t.channel
        ))
        .bearer_auth(&t.operator_jwt)
        .json(
            &json!({"agent_member_id": t.agent, "client_run_id": Uuid::new_v4(),
                      "input": {"type": "work", "title": "t", "brief": "b"}}),
        )
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    assert_eq!(status, 409, "{body}");
    assert_eq!(
        body["error"]["code"].as_str().or(body["code"].as_str()),
        Some("connector_trial_members"),
        "{body}"
    );
    assert_eq!(runs(&su, &fx).await, runs_before, "no run was written");
    let (_, view) = get_trial(&client, &base, &t, &t.operator_jwt).await;
    assert_eq!(view["enabled"], true);
    assert_eq!(view["stopped"], "members", "{view}");
    // The DM screen's own delivery state says it too (not 「열려 있어요」).
    let dm_state: Value = client
        .get(format!(
            "{base}/v1/workspaces/{}/channels/{}/agent-dm-delivery",
            t.workspace, t.dm
        ))
        .bearer_auth(&t.operator_jwt)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(dm_state["state"], "connector_trial_stopped", "{dm_state}");

    // Red proof 3: the other person's own mention is the owner sentence, not delivery.
    // (Their token: a session row for the bare member.)
    let second_jwt = momo_auth::sign_access(second, t.workspace, &[], TEST_JWT_SECRET)
        .expect("jwt")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'second')",
    )
    .bind(t.workspace)
    .bind(second)
    .bind(&second_jwt)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
        .bind(t.workspace)
        .bind(t.channel)
        .bind(second)
        .execute(&su)
        .await
        .unwrap();
    send(&client, &base, &fx, &second_jwt, t.channel, None, &mention).await;
    assert_eq!(
        jobs(&su, &fx).await,
        1,
        "a stranger's call delivers nothing"
    );
    let owner_sentences: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id=$1 AND author_member_id=$2 \
           AND props->>'subscription_notice'='connector_non_owner'",
    )
    .bind(t.workspace)
    .bind(t.agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(owner_sentences, 1);

    // Control: the second person leaves, and the very same owner mention is a job again,
    // and the DM state is no longer the stopped one.
    deactivate(&su, &t, second).await;
    sqlx::query("UPDATE message SET created_at = created_at - interval '11 minutes' WHERE workspace_id=$1 AND author_member_id=$2")
        .bind(t.workspace)
        .bind(t.agent)
        .execute(&su)
        .await
        .unwrap();
    send(
        &client,
        &base,
        &fx,
        &t.operator_jwt,
        t.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(jobs(&su, &fx).await, 2, "counted live: delivered again");
    let dm_state: Value = client
        .get(format!(
            "{base}/v1/workspaces/{}/channels/{}/agent-dm-delivery",
            t.workspace, t.dm
        ))
        .bearer_auth(&t.operator_jwt)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(dm_state["state"], "not_hosted", "{dm_state}");
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3948)"]
async fn the_attestation_leaving_the_environment_stops_delivery() {
    let (su, app, t, client) = trial_setup().await;
    let _on = enable_trial(&su, &app, &client, &t, &[APP_A, APP_B]).await;
    let fx = t.fx();
    let mention = format!("@{} 메일 확인해 줘", t.handle);
    let operator = Some(t.operator_email.clone());

    // Same database, same mark; only the server's environment differs.
    let complete =
        start_server_with(app.clone(), attested(&[APP_A, APP_B]), operator.clone()).await;
    send(
        &client,
        &complete,
        &fx,
        &t.operator_jwt,
        t.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(jobs(&su, &fx).await, 1, "control: attested → delivered");

    let broken = [
        (
            "tools lock gone",
            CohostedAgentConfig {
                tools_locked: false,
                ..attested(&[APP_A, APP_B])
            },
        ),
        (
            "connector attest gone",
            CohostedAgentConfig {
                connectors_locked: false,
                ..attested(&[APP_A, APP_B])
            },
        ),
        ("app list gone", attested(&[])),
    ];
    for (n, (label, config)) in broken.into_iter().enumerate() {
        let base = start_server_with(app.clone(), config, operator.clone()).await;
        // Age the previous notice out of the throttle so each variant must speak.
        sqlx::query("UPDATE message SET created_at = created_at - interval '11 minutes' WHERE workspace_id=$1 AND author_member_id=$2")
            .bind(t.workspace)
            .bind(t.agent)
            .execute(&su)
            .await
            .unwrap();
        send(
            &client,
            &base,
            &fx,
            &t.operator_jwt,
            t.channel,
            None,
            &mention,
        )
        .await;
        assert_eq!(jobs(&su, &fx).await, 1, "{label}: nothing delivered");
        let said = trial_notices(&su, &t).await;
        assert_eq!(said.len(), n + 1, "{label}: one notice each: {said:?}");
        assert_eq!(said[n].1, "connector_trial_attest", "{label}");
        let (_, view) = get_trial(&client, &base, &t, &t.operator_jwt).await;
        assert_eq!(view["stopped"], "attest", "{label}: {view}");
    }

    // Restored → delivered again.
    send(
        &client,
        &complete,
        &fx,
        &t.operator_jwt,
        t.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(jobs(&su, &fx).await, 2);
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3948)"]
async fn an_app_that_lost_the_owners_grant_stops_delivery() {
    let (su, app, t, client) = trial_setup().await;
    let base = enable_trial(&su, &app, &client, &t, &[APP_A, APP_B]).await;
    let fx = t.fx();
    let mention = format!("@{} 메일 확인해 줘", t.handle);
    let age = || async {
        sqlx::query("UPDATE message SET created_at = created_at - interval '11 minutes' WHERE workspace_id=$1 AND author_member_id=$2")
            .bind(t.workspace)
            .bind(t.agent)
            .execute(&su)
            .await
            .unwrap();
    };

    send(
        &client,
        &base,
        &fx,
        &t.operator_jwt,
        t.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(jobs(&su, &fx).await, 1, "control: both apps granted");

    // A grant for an app Hermes does not have on changes nothing.
    grant_app(&su, &t, t.operator, "com.momo.plugins.linear").await;
    revoke_grant(&su, &t, t.operator, "com.momo.plugins.linear").await;
    age().await;
    send(
        &client,
        &base,
        &fx,
        &t.operator_jwt,
        t.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(jobs(&su, &fx).await, 2, "an unlisted app is not judged");

    // The owner revokes a listed app's grant while Hermes still has it on.
    revoke_grant(&su, &t, t.operator, APP_B).await;
    send(
        &client,
        &base,
        &fx,
        &t.operator_jwt,
        t.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(jobs(&su, &fx).await, 2, "nothing delivered");
    let said = trial_notices(&su, &t).await;
    assert_eq!(said.len(), 1, "{said:?}");
    assert_eq!(said[0].1, "connector_trial_apps");
    let (_, view) = get_trial(&client, &base, &t, &t.operator_jwt).await;
    assert_eq!(view["stopped"], "apps", "{view}");

    // Granted again → delivered.
    restore_grant(&su, &t, t.operator, APP_B).await;
    age().await;
    send(
        &client,
        &base,
        &fx,
        &t.operator_jwt,
        t.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(jobs(&su, &fx).await, 3);

    // An admin uninstalling the app (install revoked) with the grant row untouched
    // is the same: the grant is not active without an enabled install.
    sqlx::query(
        "UPDATE workspace_plugin_install SET enabled=false WHERE workspace_id=$1 AND plugin_id=$2",
    )
    .bind(t.workspace)
    .bind(APP_A)
    .execute(&su)
    .await
    .unwrap();
    age().await;
    send(
        &client,
        &base,
        &fx,
        &t.operator_jwt,
        t.channel,
        None,
        &mention,
    )
    .await;
    assert_eq!(jobs(&su, &fx).await, 3, "install disabled → stopped");
}

/// The claim-time half of 「배달 직전마다 활성 사람 멤버를 다시 센다」 (#3948 K2-3), on
/// the gateway lane (`method='gateway'`, claimed by `oort_jobs_claim`): two of the
/// owner's jobs are queued while the agent is plain; it is then marked and pinned to
/// the operator's env link. With one active person the claim hands the first over;
/// once the workspace has three again the second is closed unrun with its own
/// reason (not the foreign-author one), its run cancelled and one audit row written.
/// (The fixture agent is a hosted dial-in agent: that is the lane whose claim SQL is
/// under test, the trial rule in it does not care how the agent got its pin.)
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3948)"]
async fn a_trial_job_is_closed_at_claim_when_the_workspace_grew() {
    let (su, _app, f, base, client) = setup().await;
    let mention = format!("@{} 메일 확인해 줘", f.handle);
    send(&client, &base, &f, &f.owner_jwt, f.channel, None, &mention).await;
    let second_msg = send(&client, &base, &f, &f.owner_jwt, f.channel, None, &mention).await;
    assert_eq!(jobs(&su, &f).await, 2, "two owner jobs queued while plain");

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
    sqlx::query(
        "INSERT INTO agent_provider_pin(agent_member_id, workspace_id, kind, pinned_by) \
         VALUES($1,$2,'operator_env',$3)",
    )
    .bind(f.agent)
    .bind(f.workspace)
    .bind(f.owner)
    .execute(&su)
    .await
    .unwrap();

    // Control: one active person (the owner) -> exactly one job is handed over.
    sqlx::query(
        "UPDATE member SET status='suspended' WHERE workspace_id=$1 AND kind='human' AND id <> $2",
    )
    .bind(f.workspace)
    .bind(f.owner)
    .execute(&su)
    .await
    .unwrap();
    let first = port_call(
        &client,
        &base,
        &f.bearer,
        "oort_jobs_claim",
        json!({"limit": 1}),
    )
    .await;
    assert_eq!(
        first["jobs"].as_array().map_or(0, Vec::len),
        1,
        "one person: delivered: {first}"
    );

    // The workspace grows again: the other queued job is NOT handed over, it is closed.
    sqlx::query("UPDATE member SET status='active' WHERE workspace_id=$1 AND kind='human'")
        .bind(f.workspace)
        .execute(&su)
        .await
        .unwrap();
    let later = port_call(
        &client,
        &base,
        &f.bearer,
        "oort_jobs_claim",
        json!({"limit": 10}),
    )
    .await;
    assert_eq!(
        later["jobs"].as_array().map_or(0, Vec::len),
        0,
        "three people: nothing handed over: {later}"
    );
    let closed: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT last_error FROM outbox WHERE workspace_id=$1 AND kind='agent_job' \
          AND partition_key=$2 AND status='done'",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(
        closed,
        vec![Some(
            "connector trial: workspace no longer has exactly one person; job closed".to_string()
        )],
        "{second_msg}"
    );
    let cancelled: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2 \
            AND status='cancelled' AND error->>'code'='connector_trial_members'",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(cancelled, 1);
    assert_eq!(
        skip_reasons(&su, &f, "agent.connector_owner.job_closed").await,
        vec!["connector_trial_members".to_string()]
    );
}
