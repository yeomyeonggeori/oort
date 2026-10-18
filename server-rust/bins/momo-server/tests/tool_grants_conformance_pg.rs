//! #3945 C-S3 — the `tool_grants` evidence a mention job carries for the apps
//! its agent may use (ADR-0113 증보 2 E5). Evidence and audit, never
//! enforcement: the executing path (workd #3957, Hermes #3948) enforces.
//! Real Axum router on a `momo_app` (NOBYPASSRLS) pool; installs, grants and
//! revokes go through the real `/plugins` routes, the mention through the real
//! send route, and the job is read back from `outbox`.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `a_connector_agents_job_carries_the_authors_live_grants_and_no_credential` | before any consent the job carries `tool_grants: []`; after install + grant it carries exactly `{grantId, pluginId, scope, tools}` equal to the projection rows, with no key outside that set and no URL/token-shaped string; an agent without the connector mark gets no key | `attach_app_tool_grants_in_tx` guard; the producer query; `AppToolGrant::to_json` |
//! | `a_revocation_reaches_the_next_job_and_never_rewrites_a_written_one` | grant → job A lists it; revoke → job B lists none and job A is byte-identical; re-grant → listed; install disabled → none; enabled → listed; uninstalled → none; re-installed without consent → none; registry row revoked → none | any of the `plugin_grant`/`workspace_plugin_install`/`plugin_registry` predicates in `load_app_tool_grants_in_tx` |
//! | `the_producer_reads_only_the_delegated_active_humans_rows` | the owner never sees a colleague's consent; an agent id, a suspended human and a deleted human yield none; another workspace's rows are invisible | `member.kind/status/deleted_at` joins; `pg.member_id` bind; RLS |
//! | `a_stale_projection_row_never_outlives_its_grant_or_install` | a hand-revoked install (still `enabled`) and a hand-revoked grant, each with its projection rows left behind, list nothing | the install `revoked_at` predicate; the grant `status`/`revoked_at` pair (either alone is redundant by the table CHECK; both removed goes red) |
//!
//! Isolated database only:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo PGHOST=127.0.0.1 PGPORT=<port> \
//!   PGUSER=momo PGPASSWORD=momo PGDATABASE=momo \
//!   cargo test -p momo-server --test tool_grants_conformance_pg -- --ignored --test-threads=1
//! ```

use std::collections::BTreeSet;
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

const TEST_JWT_SECRET: &str = "tool-grants-pg-conformance-signing-secret";
const AUDIENCE: &str = "/v1/mcp/agent-port";
const GITHUB: &str = "com.momo.plugins.github";

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
    /// Workspace-scoped hosted agent owned by `owner`, live connection.
    agent: Uuid,
    handle: String,
    channel: Uuid,
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
    let handle = format!("gmail{}", &agent.simple().to_string()[..8]);
    for (id, h) in [(agent, handle.clone())] {
        insert_member(su, workspace, id, "agent", &h).await;
        sqlx::query(
            "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id, config) \
             VALUES($1,$2,'hosted-agent','https://hosted-agent.invalid/disabled',$3, \
                    '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb)",
        )
        .bind(id)
        .bind(workspace)
        .bind(owner)
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
    for (kind, name, members) in [("public", Some("apps"), vec![owner, outsider, agent])] {
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
        agent,
        handle,
        channel: rooms[0],
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

// ---- helpers for this file ----------------------------------------------------

fn plugin_url(base: &str, f: &Fixture, tail: &str) -> String {
    format!(
        "{base}/v1/workspaces/{}/plugins/{GITHUB}{tail}",
        f.workspace
    )
}

async fn plugin_call(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    jwt: &str,
    body: Option<Value>,
) -> u16 {
    let mut request = client.request(method, url).bearer_auth(jwt);
    if let Some(body) = body {
        request = request.json(&body);
    }
    request.send().await.expect("plugin call").status().as_u16()
}

async fn install(client: &reqwest::Client, base: &str, f: &Fixture, enabled: bool) {
    let status = plugin_call(
        client,
        reqwest::Method::POST,
        plugin_url(base, f, "/install"),
        &f.admin_jwt,
        Some(json!({ "enabled": enabled })),
    )
    .await;
    assert!(status == 200 || status == 201, "install: {status}");
}

async fn uninstall(client: &reqwest::Client, base: &str, f: &Fixture) {
    let status = plugin_call(
        client,
        reqwest::Method::DELETE,
        plugin_url(base, f, "/install"),
        &f.admin_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200, "uninstall");
}

async fn grant(client: &reqwest::Client, base: &str, f: &Fixture, jwt: &str) {
    let status = plugin_call(
        client,
        reqwest::Method::POST,
        plugin_url(base, f, "/grants"),
        jwt,
        Some(json!({ "scope": "github:read" })),
    )
    .await;
    assert!(status == 200 || status == 201, "grant: {status}");
}

async fn revoke(client: &reqwest::Client, base: &str, f: &Fixture, jwt: &str) {
    let status = plugin_call(
        client,
        reqwest::Method::DELETE,
        plugin_url(base, f, "/grants/github%3Aread"),
        jwt,
        None,
    )
    .await;
    assert_eq!(status, 200, "revoke");
}

async fn mark_on(client: &reqwest::Client, base: &str, f: &Fixture, on: bool) {
    assert_eq!(
        put_mark(
            client,
            base,
            f,
            &f.owner_jwt,
            f.agent,
            json!({"enabled": on})
        )
        .await,
        200
    );
}

/// Every agent job written for the agent, oldest first, as `(id, payload text)`.
async fn job_payloads(su: &PgPool, f: &Fixture) -> Vec<(i64, String)> {
    sqlx::query_as(
        "SELECT id, payload::text FROM outbox \
          WHERE workspace_id = $1 AND kind = 'agent_job' AND partition_key = $2 ORDER BY id",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .fetch_all(su)
    .await
    .expect("jobs")
}

/// Mention the agent as its owner and return the new job's payload text.
async fn mention(su: &PgPool, client: &reqwest::Client, base: &str, f: &Fixture) -> (i64, String) {
    let before = job_payloads(su, f).await.len();
    send(
        client,
        base,
        f,
        &f.owner_jwt,
        f.channel,
        None,
        &format!("@{} 앱 좀 써 줘", f.handle),
    )
    .await;
    let jobs = job_payloads(su, f).await;
    assert_eq!(jobs.len(), before + 1, "one new job per mention");
    jobs.last().cloned().expect("job")
}

fn tool_grants(payload_text: &str) -> Option<Value> {
    let payload: Value = serde_json::from_str(payload_text).expect("payload json");
    payload.get("tool_grants").cloned()
}

fn keys_of(value: &Value, into: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                into.insert(key.clone());
                keys_of(child, into);
            }
        }
        Value::Array(items) => items.iter().for_each(|child| keys_of(child, into)),
        _ => {}
    }
}

fn strings_of(value: &Value, into: &mut Vec<String>) {
    match value {
        Value::String(text) => into.push(text.clone()),
        Value::Object(map) => map.values().for_each(|child| strings_of(child, into)),
        Value::Array(items) => items.iter().for_each(|child| strings_of(child, into)),
        _ => {}
    }
}

async fn projected_tools(su: &PgPool, f: &Fixture, member: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT tool_name FROM plugin_capability_projection \
          WHERE workspace_id = $1 AND member_id = $2 AND plugin_id = $3 ORDER BY tool_name",
    )
    .bind(f.workspace)
    .bind(member)
    .bind(GITHUB)
    .fetch_all(su)
    .await
    .expect("projection")
}

async fn grant_id(su: &PgPool, f: &Fixture, member: Uuid) -> Uuid {
    sqlx::query_scalar(
        "SELECT id FROM plugin_grant WHERE workspace_id = $1 AND member_id = $2 \
            AND plugin_id = $3 AND scope = 'github:read'",
    )
    .bind(f.workspace)
    .bind(member)
    .bind(GITHUB)
    .fetch_one(su)
    .await
    .expect("grant id")
}

// ---- tests --------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3945)"]
async fn a_connector_agents_job_carries_the_authors_live_grants_and_no_credential() {
    let (su, _app, f, base, client) = setup().await;
    mark_on(&client, &base, &f, true).await;

    // Before any consent: evaluated, none. Not the same as an old server's
    // "never looked" (key absent).
    let (_, first) = mention(&su, &client, &base, &f).await;
    assert_eq!(tool_grants(&first), Some(json!([])));

    install(&client, &base, &f, true).await;
    grant(&client, &base, &f, &f.owner_jwt).await;
    // A colleague's consent must not ride the owner's job.
    grant(&client, &base, &f, &f.outsider_jwt).await;

    let (_, second) = mention(&su, &client, &base, &f).await;
    let list = tool_grants(&second).expect("key present");
    let entries = list.as_array().expect("array");
    assert_eq!(entries.len(), 1, "only the author's consent: {list}");
    let entry = &entries[0];
    let allowed: BTreeSet<String> = ["grantId", "pluginId", "scope", "tools"]
        .iter()
        .map(|key| (*key).to_string())
        .collect();
    let mut keys = BTreeSet::new();
    keys_of(&list, &mut keys);
    assert_eq!(keys, allowed, "no key outside the documented four");
    assert_eq!(entry["pluginId"], GITHUB);
    assert_eq!(entry["scope"], "github:read");
    assert_eq!(
        entry["grantId"].as_str().expect("grantId"),
        grant_id(&su, &f, f.owner).await.to_string().to_uppercase()
    );
    let expected = projected_tools(&su, &f, f.owner).await;
    assert!(!expected.is_empty(), "the scope projected tools");
    let tools: Vec<String> = entry["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool.as_str().expect("tool name").to_string())
        .collect();
    assert_eq!(tools, expected, "names come from the projection rows");
    let mut strings = Vec::new();
    strings_of(&list, &mut strings);
    for text in &strings {
        let lower = text.to_lowercase();
        assert!(
            !lower.contains("http") && !lower.contains("token") && !lower.contains("secret"),
            "credential-shaped value in tool_grants: {text}"
        );
    }

    // An agent without the connector mark carries no key at all.
    mark_on(&client, &base, &f, false).await;
    let (_, plain) = mention(&su, &client, &base, &f).await;
    assert_eq!(tool_grants(&plain), None, "an ordinary agent gets no key");
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3945)"]
async fn a_revocation_reaches_the_next_job_and_never_rewrites_a_written_one() {
    let (su, _app, f, base, client) = setup().await;
    mark_on(&client, &base, &f, true).await;
    install(&client, &base, &f, true).await;
    grant(&client, &base, &f, &f.owner_jwt).await;

    let listed = |text: &str| -> usize {
        tool_grants(text)
            .and_then(|list| list.as_array().map(Vec::len))
            .expect("tool_grants present")
    };

    let (job_a_id, job_a) = mention(&su, &client, &base, &f).await;
    assert_eq!(listed(&job_a), 1);

    // Revoked mid-flight: the NEXT job lists none; the written one is untouched.
    revoke(&client, &base, &f, &f.owner_jwt).await;
    let (_, job_b) = mention(&su, &client, &base, &f).await;
    assert_eq!(listed(&job_b), 0, "a revoked grant is not evidence");
    let reread = job_payloads(&su, &f)
        .await
        .into_iter()
        .find(|(id, _)| *id == job_a_id)
        .expect("job A still there")
        .1;
    assert_eq!(reread, job_a, "an already-written job is never rewritten");

    // A fresh consent is listed again.
    grant(&client, &base, &f, &f.owner_jwt).await;
    let (_, job_c) = mention(&su, &client, &base, &f).await;
    assert_eq!(listed(&job_c), 1);

    // Install turned off: the consent stays, the tools leave (W3).
    install(&client, &base, &f, false).await;
    let (_, job_d) = mention(&su, &client, &base, &f).await;
    assert_eq!(listed(&job_d), 0, "a disabled install lists nothing");
    install(&client, &base, &f, true).await;
    let (_, job_e) = mention(&su, &client, &base, &f).await;
    assert_eq!(
        listed(&job_e),
        1,
        "re-enabled: the standing consent is back"
    );

    // Uninstalled, then installed again: consent does not come back.
    uninstall(&client, &base, &f).await;
    let (_, job_f) = mention(&su, &client, &base, &f).await;
    assert_eq!(listed(&job_f), 0);
    install(&client, &base, &f, true).await;
    let (_, job_g) = mention(&su, &client, &base, &f).await;
    assert_eq!(listed(&job_g), 0, "a reinstall starts without consent");

    // The registry row pulled by the platform: listed no more, even with a
    // live grant and a live install. Put back exactly as found.
    grant(&client, &base, &f, &f.owner_jwt).await;
    let (_, job_h) = mention(&su, &client, &base, &f).await;
    assert_eq!(listed(&job_h), 1);
    let before: bool = sqlx::query_scalar(
        "SELECT revoked_at IS NOT NULL FROM plugin_registry WHERE plugin_id = $1",
    )
    .bind(GITHUB)
    .fetch_one(&su)
    .await
    .expect("registry state");
    sqlx::query("UPDATE plugin_registry SET revoked_at = now() WHERE plugin_id = $1")
        .bind(GITHUB)
        .execute(&su)
        .await
        .expect("revoke registry row");
    let (_, job_i) = mention(&su, &client, &base, &f).await;
    sqlx::query(
        "UPDATE plugin_registry \
            SET revoked_at = CASE WHEN $2 THEN COALESCE(revoked_at, now()) ELSE NULL END \
          WHERE plugin_id = $1",
    )
    .bind(GITHUB)
    .bind(before)
    .execute(&su)
    .await
    .expect("restore registry row");
    assert_eq!(listed(&job_i), 0, "a revoked registry row lists nothing");
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3945)"]
async fn the_producer_reads_only_the_delegated_active_humans_rows() {
    let (su, app, f, base, client) = setup().await;
    install(&client, &base, &f, true).await;
    grant(&client, &base, &f, &f.owner_jwt).await;
    grant(&client, &base, &f, &f.outsider_jwt).await;

    let load = |workspace: Uuid, member: Uuid| {
        let app = app.clone();
        async move {
            momo_db::with_tenant_tx(&app, workspace, move |conn| {
                Box::pin(async move {
                    momo_agent::load_app_tool_grants_in_tx(conn, workspace, member).await
                })
            })
            .await
            .expect("load")
        }
    };

    let owner = load(f.workspace, f.owner).await;
    assert_eq!(owner.len(), 1);
    assert_eq!(
        owner[0].grant_id,
        grant_id(&su, &f, f.owner).await,
        "the owner's own row, not the colleague's"
    );
    // The API refuses an agent's grant, so plant one the way a bug or a
    // hand-written row would: the producer must still not list it.
    let planted: Uuid = sqlx::query_scalar(
        "INSERT INTO plugin_grant(workspace_id, member_id, plugin_id, scope, granted_by, granted_audit_id) \
         SELECT workspace_id, $2, plugin_id, scope, $2, granted_audit_id FROM plugin_grant \
          WHERE id = $1 RETURNING id",
    )
    .bind(grant_id(&su, &f, f.owner).await)
    .bind(f.agent)
    .fetch_one(&su)
    .await
    .expect("plant an agent grant");
    sqlx::query(
        "INSERT INTO plugin_capability_projection(workspace_id, member_id, plugin_id, scope, tool_name, \
                capability_version, schema_digest, risk, approval_tier, grant_id) \
         SELECT workspace_id, $2, plugin_id, scope, tool_name, capability_version, schema_digest, \
                risk, approval_tier, $3 FROM plugin_capability_projection \
          WHERE workspace_id = $1 AND member_id = $4 AND plugin_id = $5",
    )
    .bind(f.workspace)
    .bind(f.agent)
    .bind(planted)
    .bind(f.owner)
    .bind(GITHUB)
    .execute(&su)
    .await
    .expect("plant an agent projection");
    assert!(
        load(f.workspace, f.agent).await.is_empty(),
        "an agent is never a delegated user, even holding a row"
    );
    assert!(
        load(Uuid::new_v4(), f.owner).await.is_empty(),
        "another workspace sees none of it"
    );

    for status in ["suspended", "deleted"] {
        sqlx::query("UPDATE member SET status = $2::member_status WHERE id = $1")
            .bind(f.owner)
            .bind(status)
            .execute(&su)
            .await
            .expect("change status");
        assert!(
            load(f.workspace, f.owner).await.is_empty(),
            "a {status} member is not a delegated user"
        );
    }
    sqlx::query("UPDATE member SET status = 'active' WHERE id = $1")
        .bind(f.owner)
        .execute(&su)
        .await
        .expect("restore");
    // Active but soft-deleted: the deleted_at predicate alone must drop it.
    sqlx::query("UPDATE member SET deleted_at = now() WHERE id = $1")
        .bind(f.owner)
        .execute(&su)
        .await
        .expect("soft-delete");
    assert!(
        load(f.workspace, f.owner).await.is_empty(),
        "a soft-deleted member is not a delegated user"
    );
    sqlx::query("UPDATE member SET deleted_at = NULL WHERE id = $1")
        .bind(f.owner)
        .execute(&su)
        .await
        .expect("restore");
    assert_eq!(load(f.workspace, f.owner).await.len(), 1);
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#3945)"]
async fn a_stale_projection_row_never_outlives_its_grant_or_install() {
    let (su, app, f, base, client) = setup().await;
    install(&client, &base, &f, true).await;
    grant(&client, &base, &f, &f.owner_jwt).await;
    let load = || {
        let app = app.clone();
        let (workspace, member) = (f.workspace, f.owner);
        async move {
            momo_db::with_tenant_tx(&app, workspace, move |conn| {
                Box::pin(async move {
                    momo_agent::load_app_tool_grants_in_tx(conn, workspace, member).await
                })
            })
            .await
            .expect("load")
        }
    };
    assert_eq!(load().await.len(), 1);

    // The install is revoked by hand (enabled stays true, projection stays):
    // the install predicate alone must drop the entry.
    sqlx::query(
        "UPDATE workspace_plugin_install \
            SET revoked_at = now(), revoked_by = installed_by, revoked_audit_id = installed_audit_id \
          WHERE workspace_id = $1 AND plugin_id = $2",
    )
    .bind(f.workspace)
    .bind(GITHUB)
    .execute(&su)
    .await
    .expect("revoke install by hand");
    assert!(load().await.is_empty(), "a revoked install lists nothing");
    sqlx::query(
        "UPDATE workspace_plugin_install \
            SET revoked_at = NULL, revoked_by = NULL, revoked_audit_id = NULL \
          WHERE workspace_id = $1 AND plugin_id = $2",
    )
    .bind(f.workspace)
    .bind(GITHUB)
    .execute(&su)
    .await
    .expect("restore install");
    assert_eq!(load().await.len(), 1);

    // The grant is revoked by hand, the projection rows left behind.
    sqlx::query(
        "UPDATE plugin_grant \
            SET status = 'revoked', revoked_at = now(), revoked_audit_id = granted_audit_id \
          WHERE workspace_id = $1 AND plugin_id = $2",
    )
    .bind(f.workspace)
    .bind(GITHUB)
    .execute(&su)
    .await
    .expect("revoke grant by hand");
    assert!(
        !projected_tools(&su, &f, f.owner).await.is_empty(),
        "the stale projection is still there"
    );
    assert!(
        load().await.is_empty(),
        "a revoked grant lists nothing even with a stale projection"
    );
}
