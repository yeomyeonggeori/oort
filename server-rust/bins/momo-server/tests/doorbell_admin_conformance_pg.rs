//! ADR-0171 WD-1 doorbell admin REST — red proofs against a real PG + router.
//!
//! ```text
//! DATABASE_URL=postgres://momo:change-me-postgres@localhost:23202/momo \
//!   cargo test -p momo-server --test doorbell_admin_conformance_pg -- --ignored --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::WebhookSettings;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "doorbell-admin-conformance-jwt";
const TEST_OUTBOUND_MASTER_KEY: &str = "doorbell-admin-conformance-outbound-key";
const DOORBELL_SECRET: &str = "crsr_live_doorbell_admin_secret_value";

const HOSTED_SCOPES: [&str; 6] = [
    "agent:port:connect",
    "agent:inbox:read",
    "messages:read",
    "messages:write",
    "agent:jobs:read",
    "agent:runs:callback",
];

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
        .expect("connect as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let options = options.username("momo_app").password(&momo_app_password());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .expect("connect as momo_app")
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
        "/../../../infra/e2e/bootstrap_roles.sql"
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

struct Fixture {
    workspace: Uuid,
    connection: Uuid,
    human_jwt: String,
}

async fn seed(pool: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("dbell-{}", workspace.simple()))
        .execute(pool)
        .await
        .expect("workspace");
    let human = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human','Owner',$3)",
    )
    .bind(human)
    .bind(workspace)
    .bind(format!("owner-{}", human.simple()))
    .execute(pool)
    .await
    .expect("human");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(human)
    .bind(workspace)
    .bind(format!("{human}@doorbell.test"))
    .execute(pool)
    .await
    .expect("human identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) \
         VALUES($1,$2,'owner')",
    )
    .bind(workspace)
    .bind(human)
    .execute(pool)
    .await
    .expect("membership");
    let jwt = momo_auth::sign_access(human, workspace, &[], TEST_JWT_SECRET)
        .expect("jwt")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'doorbell-admin')",
    )
    .bind(workspace)
    .bind(human)
    .bind(&jwt)
    .execute(pool)
    .await
    .expect("session token");

    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'agent','hosted',$3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(format!("hosted-{}", agent.simple()))
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
    .bind(human)
    .execute(pool)
    .await
    .expect("agent");
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
    .bind(human)
    .execute(pool)
    .await
    .expect("profile");

    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channel(id, workspace_id, kind, name) VALUES($1,$2,'public','room')")
        .bind(channel)
        .bind(workspace)
        .execute(pool)
        .await
        .expect("channel");
    sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
        .bind(channel)
        .bind(workspace)
        .execute(pool)
        .await
        .expect("channel_seq");
    for member in [human, agent] {
        sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
            .bind(workspace)
            .bind(channel)
            .bind(member)
            .execute(pool)
            .await
            .expect("channel member");
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
    .bind(agent)
    .bind(human)
    .bind(vec![channel])
    .execute(pool)
    .await
    .expect("connection");
    let bearer = format!(
        "momo_agent_v1.{workspace}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let scopes: Vec<String> = HOSTED_SCOPES.iter().map(|s| (*s).to_string()).collect();
    let token: Uuid = sqlx::query_scalar(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, created_by) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'),$4,'hosted', \
                'hosted_active',$5,'/v1/mcp/agent-port',$6) RETURNING id",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&bearer)
    .bind(scopes)
    .bind(connection)
    .bind(human)
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
        connection,
        human_jwt: jwt,
    }
}

async fn start_server(pool: PgPool, doorbell_enabled: bool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_webhook(WebhookSettings {
        outbound_master_key: Some(TEST_OUTBOUND_MASTER_KEY.to_string()),
        allow_development_http: false,
        doorbell_enabled,
    });
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

fn doorbell_url(base: &str, fixture: &Fixture) -> String {
    format!(
        "{base}/v1/workspaces/{}/hosted-agent-connections/{}/doorbell",
        fixture.workspace, fixture.connection
    )
}

/// AC1: secret never appears in REST body, audit, or stored plaintext.
/// RED: putting `secret` on the response would fail the contains() assertion.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_doorbell_secret_never_appears_in_rest_or_logs() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(momo_app_pool().await, true).await;
    let http = reqwest::Client::new();

    let response = http
        .put(doorbell_url(&base, &fixture))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({
            "url": "https://example.com/automations/webhook/test",
            "secret": DOORBELL_SECRET,
        }))
        .send()
        .await
        .expect("register");
    assert_eq!(response.status(), 200, "{}", response.text().await.unwrap());
    let body: Value = response.json().await.expect("body");
    let rendered = body.to_string();
    assert!(
        !rendered.contains(DOORBELL_SECRET),
        "AC1 red: echoing the Bearer would fail here: {rendered}"
    );
    assert_eq!(body["secretMasked"], "••••alue");

    let get: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/hosted-agent-connections/{}",
            fixture.workspace, fixture.connection
        ))
        .bearer_auth(&fixture.human_jwt)
        .send()
        .await
        .expect("get")
        .json()
        .await
        .expect("get body");
    let get_rendered = get.to_string();
    assert!(!get_rendered.contains(DOORBELL_SECRET), "{get_rendered}");
    assert_eq!(get["connection"]["doorbellSecretMasked"], "••••alue");

    let stored: String = sqlx::query_scalar(
        "SELECT convert_from(secret_sealed, 'UTF8') FROM hosted_agent_doorbell \
          WHERE connection_id = $1",
    )
    .bind(fixture.connection)
    .fetch_optional(&su)
    .await
    .ok()
    .flatten()
    .unwrap_or_default();
    assert!(
        !stored.contains(DOORBELL_SECRET),
        "AC1 red: storing plaintext would fail here"
    );
    let audit_hit: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM audit_log \
          WHERE workspace_id = $1 AND detail::text LIKE $2",
    )
    .bind(fixture.workspace)
    .bind(format!("%{DOORBELL_SECRET}%"))
    .fetch_one(&su)
    .await
    .expect("audit scan");
    assert_eq!(
        audit_hit, 0,
        "AC1 red: audit carrying the secret would fail"
    );
}

/// AC2: private/loopback/link-local URLs are refused at register.
/// RED: skipping validated_url would 200 these.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn outbound_http_policy_refuses_private_doorbell_urls() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(momo_app_pool().await, true).await;
    let http = reqwest::Client::new();
    for url in [
        "https://127.0.0.1/hook",
        "https://localhost/hook",
        "https://10.1.2.3/hook",
        "https://169.254.169.254/latest/meta-data",
        "https://192.168.1.1/hook",
        "http://example.com/hook",
    ] {
        let response = http
            .put(doorbell_url(&base, &fixture))
            .bearer_auth(&fixture.human_jwt)
            .json(&json!({"url": url, "secret": DOORBELL_SECRET}))
            .send()
            .await
            .expect("register");
        assert_eq!(
            response.status(),
            400,
            "AC2 red: skipping OutboundHTTPPolicy would accept {url}: {}",
            response.text().await.unwrap_or_default()
        );
    }
}

/// AC6: flag off is empty 404 and writes nothing.
/// RED: mounting a working handler without the gate would 200.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn flag_off_doorbell_route_is_empty_404_and_writes_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(momo_app_pool().await, false).await;
    let http = reqwest::Client::new();
    let response = http
        .put(doorbell_url(&base, &fixture))
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({
            "url": "https://example.com/automations/webhook/test",
            "secret": DOORBELL_SECRET,
        }))
        .send()
        .await
        .expect("register");
    assert_eq!(response.status(), 404);
    let bytes = response.bytes().await.expect("body");
    assert!(
        bytes.is_empty(),
        "AC6 red: a JSON 404 would leak that the route exists: {:?}",
        String::from_utf8_lossy(&bytes)
    );
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM hosted_agent_doorbell WHERE connection_id = $1",
    )
    .bind(fixture.connection)
    .fetch_one(&su)
    .await
    .expect("count");
    assert_eq!(rows, 0);

    let get = http
        .get(format!(
            "{base}/v1/workspaces/{}/hosted-agent-connections/{}",
            fixture.workspace, fixture.connection
        ))
        .bearer_auth(&fixture.human_jwt)
        .send()
        .await
        .expect("get")
        .json::<Value>()
        .await
        .expect("get body");
    assert!(
        get["connection"].get("doorbellUrl").is_none(),
        "flag off GET must omit doorbell fields: {get}"
    );
}

/// Register then unregister writes one audit row each; GET drops the fields.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn register_and_unregister_each_write_one_audit_row() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(momo_app_pool().await, true).await;
    let http = reqwest::Client::new();
    let url = doorbell_url(&base, &fixture);
    let put = http
        .put(&url)
        .bearer_auth(&fixture.human_jwt)
        .json(&json!({
            "url": "https://example.com/automations/webhook/test",
            "secret": DOORBELL_SECRET,
        }))
        .send()
        .await
        .expect("put");
    assert_eq!(put.status(), 200);
    let delete = http
        .delete(&url)
        .bearer_auth(&fixture.human_jwt)
        .send()
        .await
        .expect("delete");
    assert_eq!(delete.status(), 200);
    let registered: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM audit_log \
          WHERE workspace_id=$1 AND action='hosted_agent.doorbell.registered'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .expect("registered audit");
    let unregistered: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM audit_log \
          WHERE workspace_id=$1 AND action='hosted_agent.doorbell.unregistered'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .expect("unregistered audit");
    assert_eq!(registered, 1);
    assert_eq!(unregistered, 1);
}
