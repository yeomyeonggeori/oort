//! #1820 / ADR-0173 — generic `messages:read` opens channel history REST.
//!
//! Real Axum router on `momo_app` (NOBYPASSRLS). Superuser is fixtures only.
//! Hosted credentials must stay 403 on every GET …/messages surface — the
//! `AgentBearerClass` preflight is the isolation, not a handler guard.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test ext1_read_conformance_pg -- --ignored --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{
    create_channel, is_channel_member, send_message, ChannelKind, NewChannel, NewMessage,
};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "ext1-read-conformance-signing-secret";
const AUDIENCE: &str = "/v1/mcp/agent-port";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(16)
        .connect_with(options.username("momo_app").password(&momo_app_password()))
        .await
        .expect("connect as momo_app (run bootstrap_roles.sql first)")
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
    panic!("psql client not found on PATH or Homebrew libpq locations");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema lock");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/e2e/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

async fn start_server(pool: PgPool) -> String {
    let app = build_app(AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

struct Tenant {
    workspace: Uuid,
    human: Uuid,
    human_jwt: String,
    channel: Uuid,
    other_channel: Uuid,
    agent: Uuid,
}

fn raw_credential(workspace: Uuid) -> String {
    format!(
        "momo_agent_v1.{workspace}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

async fn seed_workspace(su: &PgPool) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("ext1-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    workspace
}

async fn seed_human(su: &PgPool, workspace: Uuid) -> Uuid {
    let human = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(human)
    .bind(workspace)
    .bind(format!("human-{}", human.simple()))
    .execute(su)
    .await
    .expect("seed human");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified) \
         VALUES ($1, $2, $3, true)",
    )
    .bind(human)
    .bind(workspace)
    .bind(format!("{human}@ext1-read.test"))
    .execute(su)
    .await
    .expect("seed human identity");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(human)
    .execute(su)
    .await
    .expect("seed human workspace membership");
    human
}

async fn seed_agent(su: &PgPool, workspace: Uuid, owner: Uuid, handle: &str, hosted: bool) -> Uuid {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $4)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(handle)
    .bind(format!("{handle}-{}", agent.simple()))
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id, config) \
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(if hosted {
        "hosted-agent"
    } else {
        "prime-agent"
    })
    .bind(if hosted {
        "https://hosted-agent.invalid/disabled"
    } else {
        "https://gateway.invalid/v1"
    })
    .bind(owner)
    .bind(if hosted {
        "{\"execution_mode\":\"hosted_dial_in\"}"
    } else {
        "{}"
    })
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent workspace membership");
    sqlx::query(
        "INSERT INTO agent_profile (agent_member_id, workspace_id, updated_by, paused) \
         VALUES ($1, $2, $3, false)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed agent profile");
    agent
}

async fn join_channel(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member'::membership_role) \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("seed channel membership");
}

async fn generic_bearer(su: &PgPool, workspace: Uuid, agent: Uuid, scopes: &[&str]) -> String {
    let token = raw_credential(workspace);
    let scopes: Vec<String> = scopes.iter().map(|scope| (*scope).to_string()).collect();
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), $4, 'ext1-read')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .bind(scopes)
    .execute(su)
    .await
    .expect("seed generic bearer");
    token
}

async fn human_jwt(su: &PgPool, workspace: Uuid, human: Uuid) -> String {
    let jwt = momo_auth::sign_access(human, workspace, &[], TEST_JWT_SECRET)
        .expect("sign human App JWT")
        .token;
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES ($1, 'session', $2, digest($3::text, 'sha256'), ARRAY[]::text[], 'ext1-human')",
    )
    .bind(workspace)
    .bind(human)
    .bind(&jwt)
    .execute(su)
    .await
    .expect("record human session");
    jwt
}

async fn seed_tenant(su: &PgPool, app: &PgPool) -> Tenant {
    let workspace = seed_workspace(su).await;
    let human = seed_human(su, workspace).await;
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("ext1-{}", Uuid::new_v4()),
            topic: None,
            created_by: human,
        },
    )
    .await
    .expect("create home channel")
    .id;
    let other_channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("other-{}", Uuid::new_v4()),
            topic: None,
            created_by: human,
        },
    )
    .await
    .expect("create other channel")
    .id;
    let agent = seed_agent(
        su,
        workspace,
        human,
        &format!("ext1-{}", Uuid::new_v4().simple()),
        false,
    )
    .await;
    join_channel(su, workspace, channel, agent).await;
    Tenant {
        human_jwt: human_jwt(su, workspace, human).await,
        workspace,
        human,
        channel,
        other_channel,
        agent,
    }
}

async fn post_text(app: &PgPool, workspace: Uuid, channel: Uuid, author: Uuid, body: &str) -> Uuid {
    send_message(
        app,
        workspace,
        NewMessage::text(channel, author, body).with_client_msg_id(Uuid::new_v4()),
    )
    .await
    .expect("seed message")
    .message
    .id
}

async fn post_reply(
    app: &PgPool,
    workspace: Uuid,
    channel: Uuid,
    author: Uuid,
    root: Uuid,
    body: &str,
) -> Uuid {
    let mut input = NewMessage::text(channel, author, body).with_client_msg_id(Uuid::new_v4());
    input.root_id = Some(root);
    send_message(app, workspace, input)
        .await
        .expect("seed reply")
        .message
        .id
}

async fn get_messages(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    query: &str,
) -> (reqwest::StatusCode, Value) {
    let suffix = if query.is_empty() {
        String::new()
    } else {
        format!("?{query}")
    };
    let response = http
        .get(format!(
            "{base}/v1/workspaces/{workspace}/channels/{channel}/messages{suffix}"
        ))
        .bearer_auth(token)
        .send()
        .await
        .expect("GET messages");
    let status = response.status();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn get_replies(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    root: Uuid,
) -> (reqwest::StatusCode, Value) {
    let response = http
        .get(format!(
            "{base}/v1/workspaces/{workspace}/channels/{channel}/messages/{root}/replies"
        ))
        .bearer_auth(token)
        .send()
        .await
        .expect("GET replies");
    let status = response.status();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn seed_hosted_bearer(
    su: &PgPool,
    workspace: Uuid,
    human: Uuid,
    channel: Uuid,
    expires_at_sql: Option<&str>,
    connection_status: &str,
) -> String {
    let agent = seed_agent(
        su,
        workspace,
        human,
        &format!("hosted-{}", Uuid::new_v4().simple()),
        true,
    )
    .await;
    join_channel(su, workspace, channel, agent).await;
    let connection = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_consumed_at,detected_at,detected_by, \
           confirmed_by,confirmed_at,approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,$3,'detected',now(),now(),$4,$4,now(),$5, \
           ARRAY['agent:port:connect','messages:read']::text[],$4)",
    )
    .bind(connection)
    .bind(workspace)
    .bind(agent)
    .bind(human)
    .bind(vec![channel])
    .execute(su)
    .await
    .expect("seed hosted connection");
    let bearer = raw_credential(workspace);
    let token_id: Uuid = sqlx::query_scalar(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, created_by) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'),$4,'hosted ext1-read', \
                'hosted_active',$5,$6,$7) RETURNING id",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&bearer)
    .bind(vec![
        "agent:port:connect".to_string(),
        "messages:read".to_string(),
    ])
    .bind(connection)
    .bind(AUDIENCE)
    .bind(human)
    .fetch_one(su)
    .await
    .expect("seed hosted token");
    if let Some(expires_expr) = expires_at_sql {
        sqlx::query(&format!(
            "UPDATE token SET expires_at = {expires_expr} WHERE id = $1"
        ))
        .bind(token_id)
        .execute(su)
        .await
        .expect("stamp hosted grace expiry");
    }
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='active', active_token_id=$3, \
           proved_at=now(), proved_by=$4 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .bind(token_id)
    .bind(agent)
    .execute(su)
    .await
    .expect("activate hosted connection");
    if connection_status != "active" {
        sqlx::query("UPDATE hosted_agent_connection SET status=$3 WHERE workspace_id=$1 AND id=$2")
            .bind(workspace)
            .bind(connection)
            .bind(connection_status)
            .execute(su)
            .await
            .expect("move hosted connection status");
    }
    bearer
}

/// RED proof: mapping is absent, so generic + `messages:read` is still 403.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector/pg18) + momo_app role"]
async fn ext1_read_generic_with_messages_read_gets_history() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let tenant = seed_tenant(&su, &app).await;
    post_text(
        &app,
        tenant.workspace,
        tenant.channel,
        tenant.human,
        "hello",
    )
    .await;
    let bearer = generic_bearer(&su, tenant.workspace, tenant.agent, &["messages:read"]).await;

    let (status, body) =
        get_messages(&http, &base, &bearer, tenant.workspace, tenant.channel, "").await;
    assert_eq!(
        status.as_u16(),
        403,
        "RED: GET …/messages is unlisted for agent bearers: {body}"
    );
}

/// RED proof: replies share the same unlisted GET surface.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector/pg18) + momo_app role"]
async fn ext1_read_generic_with_messages_read_gets_replies() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let tenant = seed_tenant(&su, &app).await;
    let root = post_text(&app, tenant.workspace, tenant.channel, tenant.human, "root").await;
    post_reply(
        &app,
        tenant.workspace,
        tenant.channel,
        tenant.human,
        root,
        "reply",
    )
    .await;
    let bearer = generic_bearer(&su, tenant.workspace, tenant.agent, &["messages:read"]).await;

    let (status, body) = get_replies(
        &http,
        &base,
        &bearer,
        tenant.workspace,
        tenant.channel,
        root,
    )
    .await;
    assert_eq!(
        status.as_u16(),
        403,
        "RED: GET …/replies is unlisted for agent bearers: {body}"
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector/pg18) + momo_app role"]
async fn ext1_read_generic_without_messages_read_is_403() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let tenant = seed_tenant(&su, &app).await;
    post_text(
        &app,
        tenant.workspace,
        tenant.channel,
        tenant.human,
        "hello",
    )
    .await;
    let bearer = generic_bearer(&su, tenant.workspace, tenant.agent, &["messages:write"]).await;

    let (status, body) =
        get_messages(&http, &base, &bearer, tenant.workspace, tenant.channel, "").await;
    assert_eq!(status.as_u16(), 403, "{body}");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector/pg18) + momo_app role"]
async fn ext1_read_hosted_active_get_messages_is_403() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let tenant = seed_tenant(&su, &app).await;
    post_text(
        &app,
        tenant.workspace,
        tenant.channel,
        tenant.human,
        "hello",
    )
    .await;
    let hosted = seed_hosted_bearer(
        &su,
        tenant.workspace,
        tenant.human,
        tenant.channel,
        None,
        "active",
    )
    .await;

    let (status, body) =
        get_messages(&http, &base, &hosted, tenant.workspace, tenant.channel, "").await;
    assert_eq!(
        status.as_u16(),
        403,
        "hosted_active must not reach GET …/messages: {body}"
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector/pg18) + momo_app role"]
async fn ext1_read_hosted_grace_get_messages_is_403() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let tenant = seed_tenant(&su, &app).await;
    post_text(
        &app,
        tenant.workspace,
        tenant.channel,
        tenant.human,
        "hello",
    )
    .await;
    let hosted = seed_hosted_bearer(
        &su,
        tenant.workspace,
        tenant.human,
        tenant.channel,
        Some("now() + interval '1 hour'"),
        "active",
    )
    .await;

    let (status, body) =
        get_messages(&http, &base, &hosted, tenant.workspace, tenant.channel, "").await;
    assert_eq!(
        status.as_u16(),
        403,
        "hosted grace window must not reach GET …/messages: {body}"
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector/pg18) + momo_app role"]
async fn ext1_read_hosted_cleanup_pending_get_messages_is_403() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let tenant = seed_tenant(&su, &app).await;
    post_text(
        &app,
        tenant.workspace,
        tenant.channel,
        tenant.human,
        "hello",
    )
    .await;
    let hosted = seed_hosted_bearer(
        &su,
        tenant.workspace,
        tenant.human,
        tenant.channel,
        None,
        "cleanup_pending",
    )
    .await;

    let (status, body) =
        get_messages(&http, &base, &hosted, tenant.workspace, tenant.channel, "").await;
    assert_eq!(
        status.as_u16(),
        403,
        "cleanup_pending hosted must not reach GET …/messages: {body}"
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector/pg18) + momo_app role"]
async fn ext1_read_non_member_channel_is_403() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let tenant = seed_tenant(&su, &app).await;
    post_text(
        &app,
        tenant.workspace,
        tenant.other_channel,
        tenant.human,
        "secret",
    )
    .await;
    let bearer = generic_bearer(&su, tenant.workspace, tenant.agent, &["messages:read"]).await;

    let (status, body) = get_messages(
        &http,
        &base,
        &bearer,
        tenant.workspace,
        tenant.other_channel,
        "",
    )
    .await;
    assert_eq!(status.as_u16(), 403, "non-member channel: {body}");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector/pg18) + momo_app role"]
async fn ext1_read_cross_tenant_rls_hides_foreign_messages() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let home = seed_tenant(&su, &app).await;
    let foreign = seed_tenant(&su, &app).await;
    post_text(&app, home.workspace, home.channel, home.human, "home").await;
    let bearer = generic_bearer(&su, home.workspace, home.agent, &["messages:read"]).await;

    let (status, body) = get_messages(
        &http,
        &base,
        &bearer,
        foreign.workspace,
        foreign.channel,
        "",
    )
    .await;
    assert_eq!(
        status.as_u16(),
        403,
        "path workspace must match the credential: {body}"
    );

    let home_channel = home.channel;
    with_tenant_tx(&app, foreign.workspace, move |conn| {
        Box::pin(async move {
            let seen: i64 =
                sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
                    .bind(home_channel)
                    .fetch_one(&mut *conn)
                    .await?;
            assert_eq!(seen, 0, "foreign tenant GUC must not see home messages");
            Ok::<_, momo_db::DbError>(())
        })
    })
    .await
    .expect("RLS self-check");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector/pg18) + momo_app role"]
async fn ext1_read_inactive_membership_is_403() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let tenant = seed_tenant(&su, &app).await;
    post_text(
        &app,
        tenant.workspace,
        tenant.channel,
        tenant.human,
        "hello",
    )
    .await;
    let kicked = seed_agent(
        &su,
        tenant.workspace,
        tenant.human,
        &format!("kicked-{}", Uuid::new_v4().simple()),
        false,
    )
    .await;
    join_channel(&su, tenant.workspace, tenant.channel, kicked).await;
    let kicked_bearer = generic_bearer(&su, tenant.workspace, kicked, &["messages:read"]).await;
    sqlx::query(
        "UPDATE membership SET left_at = now() \
          WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(tenant.channel)
    .bind(kicked)
    .execute(&su)
    .await
    .expect("kick from channel");

    let still_member = {
        let channel = tenant.channel;
        with_tenant_tx(&app, tenant.workspace, move |conn| {
            Box::pin(async move { is_channel_member(conn, channel, kicked).await })
        })
        .await
        .expect("is_channel_member after kick")
    };
    assert!(
        !still_member,
        "is_channel_member must treat left_at as not-active"
    );

    let (status, body) = get_messages(
        &http,
        &base,
        &kicked_bearer,
        tenant.workspace,
        tenant.channel,
        "",
    )
    .await;
    assert_eq!(status.as_u16(), 403, "kicked member: {body}");

    let paused = seed_agent(
        &su,
        tenant.workspace,
        tenant.human,
        &format!("paused-{}", Uuid::new_v4().simple()),
        false,
    )
    .await;
    join_channel(&su, tenant.workspace, tenant.channel, paused).await;
    let paused_bearer = generic_bearer(&su, tenant.workspace, paused, &["messages:read"]).await;
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(paused)
        .execute(&su)
        .await
        .expect("suspend agent");

    let channel_still_open = {
        let channel = tenant.channel;
        with_tenant_tx(&app, tenant.workspace, move |conn| {
            Box::pin(async move { is_channel_member(conn, channel, paused).await })
        })
        .await
        .expect("is_channel_member after suspend")
    };
    assert!(
        channel_still_open,
        "is_channel_member is channel left_at, not workspace status — auth already requires active"
    );

    let (status, body) = get_messages(
        &http,
        &base,
        &paused_bearer,
        tenant.workspace,
        tenant.channel,
        "",
    )
    .await;
    assert_ne!(
        status.as_u16(),
        200,
        "suspended agent must not read history: {body}"
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector/pg18) + momo_app role"]
async fn ext1_read_pagination_cursor_limit_still_works() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let tenant = seed_tenant(&su, &app).await;
    for body in ["one", "two", "three"] {
        post_text(&app, tenant.workspace, tenant.channel, tenant.human, body).await;
    }

    let (status, page) = get_messages(
        &http,
        &base,
        &tenant.human_jwt,
        tenant.workspace,
        tenant.channel,
        "limit=2",
    )
    .await;
    assert_eq!(status.as_u16(), 200, "{page}");
    let messages = page["messages"].as_array().expect("messages array");
    assert_eq!(messages.len(), 2, "{page}");
    let next_before = page["nextBefore"].as_i64().expect("nextBefore");
    let (status, older) = get_messages(
        &http,
        &base,
        &tenant.human_jwt,
        tenant.workspace,
        tenant.channel,
        &format!("limit=2&before={next_before}"),
    )
    .await;
    assert_eq!(status.as_u16(), 200, "{older}");
    let older_messages = older["messages"].as_array().expect("older page");
    assert_eq!(older_messages.len(), 1, "{older}");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector/pg18) + momo_app role"]
async fn ext1_read_human_bearer_history_is_unchanged() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let tenant = seed_tenant(&su, &app).await;
    post_text(
        &app,
        tenant.workspace,
        tenant.channel,
        tenant.human,
        "hello",
    )
    .await;

    let (status, body) = get_messages(
        &http,
        &base,
        &tenant.human_jwt,
        tenant.workspace,
        tenant.channel,
        "",
    )
    .await;
    assert_eq!(status.as_u16(), 200, "{body}");
    assert_eq!(body["messages"][0]["body"], json!("hello"));
}
