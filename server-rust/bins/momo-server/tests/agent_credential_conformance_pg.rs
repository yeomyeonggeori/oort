//! PostgreSQL/HTTP conformance for generic agent bearer lifecycle (#1358).
//!
//! The suite deliberately starts the real Axum router on `momo_app`
//! (NOBYPASSRLS) while using a superuser only for isolated fixtures and
//! assertions. It proves the boundary that unit tests cannot: human admin
//! authorization, one-time reveal, digest-only custody, fail-closed tenant and
//! agent binding, idempotent revoke audit, authentication after expiry/revoke,
//! and serialized rotation.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:24538/momo \
//! cargo test -p momo-server --test agent_credential_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_server::config::SettingsConfig;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "agent-credential-conformance-jwt-secret";
const TEST_PASSWORD: &str = "agent-credential-conformance-password";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as i64
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(12)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(12)
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

async fn start_server(pool: PgPool, operator_email: &str) -> String {
    let settings = SettingsConfig {
        platform_admin_emails: vec![operator_email.to_ascii_lowercase()],
        ..SettingsConfig::default()
    };
    let app = build_app(
        AppState::new(
            pool,
            TEST_JWT_SECRET.to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        )
        .with_settings(settings),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

struct Fixture {
    workspace: Uuid,
    owner_email: String,
    admin_email: String,
    member_email: String,
    agent: Uuid,
    rotation_agent: Uuid,
    grace_agent: Uuid,
    foreign_agent: Uuid,
    rollback_agent: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str) -> (Uuid, String) {
    let member = Uuid::new_v4();
    let email = format!("{member}@agent-credential.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(member)
    .bind(workspace)
    .bind(member.to_string())
    .execute(su)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(member)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human auth");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, $3::membership_role)",
    )
    .bind(workspace)
    .bind(member)
    .bind(role)
    .execute(su)
    .await
    .expect("seed human workspace membership");
    (member, email)
}

async fn seed_agent(su: &PgPool, workspace: Uuid, owner: Uuid, suffix: &str) -> Uuid {
    let agent = Uuid::new_v4();
    let handle = format!("cred-{suffix}-{}", &agent.simple().to_string()[..8]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent \
           (member_id, workspace_id, model, base_url, max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(owner)
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
    agent
}

async fn seed(su: &PgPool, hint: &str) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let (owner, owner_email) = seed_human(su, workspace, "owner").await;
    let (_, admin_email) = seed_human(su, workspace, "admin").await;
    let (_, member_email) = seed_human(su, workspace, "member").await;
    let agent = seed_agent(su, workspace, owner, "main").await;
    let rotation_agent = seed_agent(su, workspace, owner, "rotate").await;
    let grace_agent = seed_agent(su, workspace, owner, "grace").await;
    let foreign_agent = seed_agent(su, workspace, owner, "foreign").await;
    let rollback_agent = seed_agent(su, workspace, owner, "rollback").await;
    Fixture {
        workspace,
        owner_email,
        admin_email,
        member_email,
        agent,
        rotation_agent,
        grace_agent,
        foreign_agent,
        rollback_agent,
    }
}

async fn login(http: &reqwest::Client, base: &str, fixture: &Fixture, email: &str) -> String {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": TEST_PASSWORD,
            "workspace": fixture.workspace,
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status(), 200, "seeded human logs in");
    response.json::<Value>().await.expect("login body")["accessToken"]
        .as_str()
        .expect("login access token")
        .to_string()
}

fn credentials_url(base: &str, workspace: Uuid, agent: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/agents/{agent}/credentials")
}

async fn issue(
    http: &reqwest::Client,
    url: &str,
    human_token: &str,
    body: Value,
) -> (reqwest::StatusCode, reqwest::header::HeaderMap, Value) {
    let response = http
        .post(url)
        .bearer_auth(human_token)
        .json(&body)
        .send()
        .await
        .expect("issue credential");
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.json().await.expect("credential response body");
    (status, headers, body)
}

async fn audit_count(su: &PgPool, workspace: Uuid, action: &str, target: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*)::bigint FROM audit_log \
          WHERE workspace_id = $1 AND action = $2 AND target_id = $3",
    )
    .bind(workspace)
    .bind(action)
    .bind(target)
    .fetch_one(su)
    .await
    .expect("count credential audit")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn generic_agent_credentials_are_one_time_bounded_and_revocable() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su, "credential-a").await;
    let other = seed(&su, "credential-b").await;
    let base = start_server(momo_app_pool().await, &fixture.owner_email).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, &fixture, &fixture.owner_email).await;
    let admin_token = login(&http, &base, &fixture, &fixture.admin_email).await;
    let member_token = login(&http, &base, &fixture, &fixture.member_email).await;
    let url = credentials_url(&base, fixture.workspace, fixture.agent);

    // Human owner/admin only, with a closed non-empty scope vocabulary.
    assert_eq!(
        issue(&http, &url, &member_token, json!({})).await.0,
        reqwest::StatusCode::FORBIDDEN
    );
    assert_eq!(
        issue(
            &http,
            &url,
            &owner_token,
            json!({"scopes": ["future:unknown"]}),
        )
        .await
        .0,
        reqwest::StatusCode::BAD_REQUEST
    );
    assert_eq!(
        issue(&http, &url, &owner_token, json!({"scopes": []}))
            .await
            .0,
        reqwest::StatusCode::BAD_REQUEST
    );
    assert_eq!(
        issue(
            &http,
            &url,
            &admin_token,
            json!({"scopes": ["provider:quota:write"]}),
        )
        .await
        .0,
        reqwest::StatusCode::FORBIDDEN,
        "workspace admin authority alone never grants the instance-operator scope"
    );
    assert_eq!(
        issue(
            &http,
            &url,
            &admin_token,
            json!({"scopes": ["messages:write"], "rotationGraceSeconds": 0}),
        )
        .await
        .0,
        reqwest::StatusCode::CREATED,
        "a workspace admin may issue an ordinary generic credential"
    );
    let operator_url = credentials_url(&base, fixture.workspace, fixture.foreign_agent);
    assert_eq!(
        issue(
            &http,
            &operator_url,
            &owner_token,
            json!({"scopes": ["provider:quota:write"]}),
        )
        .await
        .0,
        reqwest::StatusCode::CREATED,
        "a listed owner may explicitly grant the operator-only scope"
    );
    assert_eq!(
        issue(
            &http,
            &url,
            &owner_token,
            json!({"expiresAtMs": now_ms() - 1}),
        )
        .await
        .0,
        reqwest::StatusCode::BAD_REQUEST,
        "credential expiry must be future"
    );

    // Create reveals once and stores only SHA-256. Its reusable object has no
    // token/hash/prefix field, and the default excludes all read/Port scopes.
    let (status, headers, created) = issue(&http, &url, &owner_token, json!({})).await;
    assert_eq!(status, reqwest::StatusCode::CREATED, "{created}");
    assert_eq!(
        headers.get("cache-control").and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    assert_eq!(
        headers.get("pragma").and_then(|v| v.to_str().ok()),
        Some("no-cache")
    );
    let raw = created["token"]
        .as_str()
        .expect("one-time token")
        .to_string();
    assert!(raw.starts_with(&format!("momo_agent_v1.{}.", fixture.workspace)));
    let credential_id =
        Uuid::parse_str(created["credential"]["id"].as_str().expect("credential id"))
            .expect("credential UUID");
    let metadata = &created["credential"];
    for forbidden in ["token", "tokenHash", "hash", "prefix"] {
        assert!(metadata.get(forbidden).is_none(), "{forbidden}: {metadata}");
    }
    let defaults = metadata["scopes"].as_array().expect("default scopes");
    for non_default in [
        "messages:read",
        "agent:port:connect",
        "agent:inbox:read",
        "provider:quota:write",
    ] {
        assert!(
            !defaults.iter().any(|scope| scope == non_default),
            "{non_default} must be explicit: {defaults:?}"
        );
    }
    let stored_hash: Vec<u8> = sqlx::query_scalar("SELECT token_hash FROM token WHERE id = $1")
        .bind(credential_id)
        .fetch_one(&su)
        .await
        .expect("stored digest");
    let expected_hash: Vec<u8> = sqlx::query_scalar("SELECT digest($1::text, 'sha256')")
        .bind(&raw)
        .fetch_one(&su)
        .await
        .expect("expected digest");
    assert_eq!(stored_hash, expected_hash);
    assert_eq!(stored_hash.len(), 32);

    let app_bypasses_rls: bool =
        sqlx::query_scalar("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'momo_app'")
            .fetch_one(&su)
            .await
            .expect("read momo_app RLS posture");
    assert!(!app_bypasses_rls, "momo_app must remain NOBYPASSRLS");
    let forced_tables: Vec<String> = sqlx::query_scalar(
        "SELECT relname::text FROM pg_class \
          WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity",
    )
    .bind(vec!["token", "audit_log"])
    .fetch_all(&su)
    .await
    .expect("read FORCE RLS posture");
    assert_eq!(
        forced_tables.len(),
        2,
        "token and audit_log require FORCE RLS"
    );
    let app_pool = momo_app_pool().await;
    let mut wrong_tenant = app_pool.begin().await.expect("wrong-GUC transaction");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(other.workspace.to_string())
        .execute(&mut *wrong_tenant)
        .await
        .expect("set wrong tenant GUC");
    let wrong_guc_visibility: i64 =
        sqlx::query_scalar("SELECT count(*)::bigint FROM token WHERE id = $1")
            .bind(credential_id)
            .fetch_one(&mut *wrong_tenant)
            .await
            .expect("query token through wrong tenant GUC");
    assert_eq!(
        wrong_guc_visibility, 0,
        "wrong tenant GUC must see no credential"
    );
    wrong_tenant
        .rollback()
        .await
        .expect("rollback wrong-GUC read");

    let listed_response = http
        .get(&url)
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("list credentials");
    assert_eq!(listed_response.status(), 200);
    let listed_text = listed_response.text().await.expect("list text");
    assert!(!listed_text.contains(&raw));
    assert!(!listed_text.contains("momo_agent_v1."));
    assert!(!listed_text.contains("tokenHash"));
    let listed: Value = serde_json::from_str(&listed_text).expect("list JSON");
    assert!(listed["credentials"]
        .as_array()
        .expect("credentials")
        .iter()
        .any(|item| item["id"] == credential_id.to_string()));
    let leaked_audits: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM audit_log \
          WHERE workspace_id = $1 AND detail::text LIKE '%momo_agent_v1.%'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .expect("scan credential audits");
    assert_eq!(
        leaked_audits, 0,
        "audit details must never contain a bearer"
    );

    // Deliberately fail audit insertion to prove mutation+audit are one
    // transaction. Neither issuance nor revoke may leave a partial token row.
    let install_audit_failure = |action: &str, target: Uuid| {
        format!(
            "CREATE OR REPLACE FUNCTION test_fail_agent_credential_audit() \
               RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
                 IF NEW.action = '{action}' AND NEW.subject_member_id = '{target}'::uuid THEN \
                   RAISE EXCEPTION 'injected credential audit failure'; \
                 END IF; RETURN NEW; END $$; \
             DROP TRIGGER IF EXISTS test_fail_agent_credential_audit ON audit_log; \
             CREATE TRIGGER test_fail_agent_credential_audit BEFORE INSERT ON audit_log \
               FOR EACH ROW EXECUTE FUNCTION test_fail_agent_credential_audit()"
        )
    };
    sqlx::raw_sql(&install_audit_failure(
        "agent.credential.issued",
        fixture.rollback_agent,
    ))
    .execute(&su)
    .await
    .expect("install issuance audit failure");
    let rollback_url = credentials_url(&base, fixture.workspace, fixture.rollback_agent);
    assert_eq!(
        issue(&http, &rollback_url, &owner_token, json!({})).await.0,
        reqwest::StatusCode::INTERNAL_SERVER_ERROR
    );
    let partial_issue_rows: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM token \
          WHERE workspace_id = $1 AND actor_member_id = $2 AND kind = 'agent_bearer'",
    )
    .bind(fixture.workspace)
    .bind(fixture.rollback_agent)
    .fetch_one(&su)
    .await
    .expect("count partial issuance rows");
    assert_eq!(
        partial_issue_rows, 0,
        "failed audit must roll issuance back"
    );

    sqlx::raw_sql(
        "DROP TRIGGER test_fail_agent_credential_audit ON audit_log; \
         DROP FUNCTION test_fail_agent_credential_audit()",
    )
    .execute(&su)
    .await
    .expect("remove issuance audit failure");
    let (_, _, rollback_credential) = issue(&http, &rollback_url, &owner_token, json!({})).await;
    let rollback_credential_id = Uuid::parse_str(
        rollback_credential["credential"]["id"]
            .as_str()
            .expect("rollback credential id"),
    )
    .expect("rollback credential UUID");
    sqlx::raw_sql(&install_audit_failure(
        "agent.credential.revoked",
        fixture.rollback_agent,
    ))
    .execute(&su)
    .await
    .expect("install revoke audit failure");
    let failed_revoke_status = http
        .post(format!("{rollback_url}/{rollback_credential_id}/revoke"))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("revoke with injected audit failure")
        .status();
    assert_eq!(
        failed_revoke_status,
        reqwest::StatusCode::INTERNAL_SERVER_ERROR
    );
    let partial_revoke: Option<String> =
        sqlx::query_scalar("SELECT revoked_at::text FROM token WHERE id = $1")
            .bind(rollback_credential_id)
            .fetch_one(&su)
            .await
            .expect("read rollback credential revocation");
    assert!(
        partial_revoke.is_none(),
        "failed audit must roll revoke back"
    );
    assert_eq!(
        audit_count(
            &su,
            fixture.workspace,
            "agent.credential.revoked",
            rollback_credential_id,
        )
        .await,
        0,
        "failed revoke audit must leave zero partial audit rows"
    );
    sqlx::raw_sql(
        "DROP TRIGGER test_fail_agent_credential_audit ON audit_log; \
         DROP FUNCTION test_fail_agent_credential_audit()",
    )
    .execute(&su)
    .await
    .expect("remove revoke audit failure");

    // Agent bearers cannot manage credentials, a foreign workspace fails at
    // the workspace binding, and foreign agent/credential pairs enumerate
    // nothing.
    assert_eq!(
        http.get(&url)
            .bearer_auth(&raw)
            .send()
            .await
            .expect("agent tries credential route")
            .status(),
        reqwest::StatusCode::FORBIDDEN
    );
    assert_eq!(
        http.get(credentials_url(&base, other.workspace, other.agent))
            .bearer_auth(&owner_token)
            .send()
            .await
            .expect("cross-workspace list")
            .status(),
        reqwest::StatusCode::FORBIDDEN
    );
    assert_eq!(
        http.post(format!(
            "{}/{}/revoke",
            credentials_url(&base, fixture.workspace, fixture.foreign_agent),
            credential_id
        ))
        .bearer_auth(&owner_token)
        .json(&json!({}))
        .send()
        .await
        .expect("foreign agent credential pair")
        .status(),
        reqwest::StatusCode::NOT_FOUND
    );

    // Missing scope is 403 and audited; an expired credential and an explicitly
    // revoked credential both become the existing non-enumerating 401 path.
    let (_, _, wrong_scope) = issue(
        &http,
        &url,
        &owner_token,
        json!({"scopes": ["messages:write"], "rotationGraceSeconds": 60}),
    )
    .await;
    let wrong_raw = wrong_scope["token"].as_str().expect("wrong-scope token");
    let gateway_url = format!(
        "{base}/v1/workspaces/{}/agents/{}/gateway/jobs/pending",
        fixture.workspace, fixture.agent
    );
    assert_eq!(
        http.get(&gateway_url)
            .bearer_auth(wrong_raw)
            .send()
            .await
            .expect("wrong scope")
            .status(),
        reqwest::StatusCode::FORBIDDEN
    );
    let scope_denied: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM audit_log \
          WHERE workspace_id = $1 AND action = 'auth.agent_bearer.scope_denied'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .expect("scope-denied audit");
    assert_eq!(scope_denied, 1);

    let (_, _, expiring) = issue(
        &http,
        &url,
        &owner_token,
        json!({
            "scopes": ["agent:jobs:read"],
            "expiresAtMs": now_ms() + 2_500,
            "rotationGraceSeconds": 60,
        }),
    )
    .await;
    let expiring_raw = expiring["token"]
        .as_str()
        .expect("expiring token")
        .to_string();
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    assert_eq!(
        http.get(&gateway_url)
            .bearer_auth(&expiring_raw)
            .send()
            .await
            .expect("expired token")
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );

    // A zero-second grace is the boundary form of "after grace": the new
    // issue succeeds but its predecessor immediately becomes unauthenticated.
    let grace_url = credentials_url(&base, fixture.workspace, fixture.grace_agent);
    let (status, _, grace_predecessor) = issue(
        &http,
        &grace_url,
        &owner_token,
        json!({"scopes": ["agent:jobs:read"]}),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::CREATED);
    let grace_predecessor_raw = grace_predecessor["token"]
        .as_str()
        .expect("grace predecessor token")
        .to_string();
    let (status, _, _) = issue(
        &http,
        &grace_url,
        &owner_token,
        json!({"scopes": ["agent:jobs:read"], "rotationGraceSeconds": 0}),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::CREATED);
    let grace_gateway_url = format!(
        "{base}/v1/workspaces/{}/agents/{}/gateway/jobs/pending",
        fixture.workspace, fixture.grace_agent
    );
    assert_eq!(
        http.get(&grace_gateway_url)
            .bearer_auth(&grace_predecessor_raw)
            .send()
            .await
            .expect("predecessor after zero grace")
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );

    let (_, _, revocable) = issue(
        &http,
        &url,
        &owner_token,
        json!({"scopes": ["agent:jobs:read"], "rotationGraceSeconds": 60}),
    )
    .await;
    let revocable_id = Uuid::parse_str(
        revocable["credential"]["id"]
            .as_str()
            .expect("revocable id"),
    )
    .expect("revocable UUID");
    let revocable_raw = revocable["token"]
        .as_str()
        .expect("revocable token")
        .to_string();
    let revoke_url = format!("{url}/{revocable_id}/revoke");
    let first: Value = http
        .post(&revoke_url)
        .bearer_auth(&owner_token)
        .json(&json!({"reason": "operator rotation"}))
        .send()
        .await
        .expect("first revoke")
        .json()
        .await
        .expect("first revoke body");
    assert_eq!(first["revokedNow"], true);
    assert_eq!(first["alreadyRevoked"], false);
    let replay: Value = http
        .post(&revoke_url)
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("revoke replay")
        .json()
        .await
        .expect("revoke replay body");
    assert_eq!(replay["revokedNow"], false);
    assert_eq!(replay["alreadyRevoked"], true);
    assert_eq!(
        audit_count(
            &su,
            fixture.workspace,
            "agent.credential.revoked",
            revocable_id,
        )
        .await,
        1,
        "revoke replay must not append a second audit"
    );
    assert_eq!(
        http.get(&gateway_url)
            .bearer_auth(&revocable_raw)
            .send()
            .await
            .expect("revoked token")
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );

    // A long requested rotation grace never extends a predecessor that already
    // expires sooner.
    let rotation_url = credentials_url(&base, fixture.workspace, fixture.rotation_agent);
    let requested_expiry = now_ms() + 5 * 60 * 1000;
    let (_, _, predecessor) = issue(
        &http,
        &rotation_url,
        &owner_token,
        json!({
            "scopes": ["agent:jobs:read"],
            "expiresAtMs": requested_expiry,
        }),
    )
    .await;
    let predecessor_id = Uuid::parse_str(
        predecessor["credential"]["id"]
            .as_str()
            .expect("predecessor id"),
    )
    .expect("predecessor UUID");
    let (_, _, _) = issue(
        &http,
        &rotation_url,
        &owner_token,
        json!({"scopes": ["agent:jobs:read"], "rotationGraceSeconds": 3600}),
    )
    .await;
    let predecessor_after: i64 = sqlx::query(
        "SELECT (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms \
           FROM token WHERE id = $1",
    )
    .bind(predecessor_id)
    .fetch_one(&su)
    .await
    .expect("predecessor expiry")
    .get("expires_at_ms");
    assert!(
        predecessor_after <= requested_expiry,
        "rotation must never extend an old expiry: {predecessor_after} > {requested_expiry}"
    );

    // Two overlapping rotations serialize on the agent row. After both return,
    // exactly one successor remains long-lived; every predecessor has a grace
    // expiry. This is the observable contract, independent of which request won.
    let request_a = http
        .post(&rotation_url)
        .bearer_auth(&owner_token)
        .json(&json!({"scopes": ["agent:jobs:read"], "rotationGraceSeconds": 600}))
        .send();
    let request_b = http
        .post(&rotation_url)
        .bearer_auth(&owner_token)
        .json(&json!({"scopes": ["agent:jobs:read"], "rotationGraceSeconds": 600}))
        .send();
    let (response_a, response_b) = tokio::join!(request_a, request_b);
    assert_eq!(response_a.expect("rotation A").status(), 201);
    assert_eq!(response_b.expect("rotation B").status(), 201);
    let live_without_expiry: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM token \
          WHERE workspace_id = $1 AND actor_member_id = $2 \
            AND kind = 'agent_bearer' AND revoked_at IS NULL AND expires_at IS NULL",
    )
    .bind(fixture.workspace)
    .bind(fixture.rotation_agent)
    .fetch_one(&su)
    .await
    .expect("count long-lived successors");
    assert_eq!(live_without_expiry, 1);

    let raw_shaped_audit: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM audit_log \
          WHERE workspace_id = $1 \
            AND (detail ? 'token' OR detail ? 'tokenHash' OR detail ? 'prefix' \
                 OR detail::text LIKE '%momo_agent_v1.%')",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .expect("final audit secret scan");
    assert_eq!(raw_shaped_audit, 0);
}
