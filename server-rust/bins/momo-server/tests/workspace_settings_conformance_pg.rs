//! #1800 — `workspace.settings` 읽기·쓰기 REST 컨포먼스.
//!
//! Red: 표면 부재(404)·전 멤버 우회·미지 키 수용·부분 병합이 다른 키를 지움.
//! Green: operator GET/PATCH, RFC 7396 동형 최상위 병합, allowlist, 상한, audit,
//! `GET /v1/workspaces/{ws}` 에 settings 미포함. PATCH 읽기는 `FOR UPDATE` 로
//! 직렬화되어 동시 병합이 서로의 키를 지우지 않는다.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test workspace_settings_conformance_pg -- --ignored --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{rebind_tenant_guc, with_tenant_tx, PgPool};
use momo_server::{build_app, AppState};
use momo_settings::read_workspace_settings_for_update;
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "workspace-settings-conformance-signing-secret";
const TEST_PASSWORD: &str = "workspace-settings-test-password";

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
        .max_connections(8)
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

struct Human {
    id: Uuid,
    email: String,
}

struct Fixture {
    workspace: Uuid,
    owner: Human,
    admin: Human,
    member: Human,
    guest: Human,
    agent: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str) -> Human {
    let id = Uuid::new_v4();
    let email = format!("{id}@workspace-settings.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(id.to_string())
    .execute(su)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(id)
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
    .bind(id)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace_membership");
    Human { id, email }
}

async fn seed_agent(su: &PgPool, workspace: Uuid, owner: Uuid) -> Uuid {
    let agent = Uuid::new_v4();
    let handle = format!("set-{}", &agent.simple().to_string()[..8]);
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
    .expect("seed agent membership");
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
    let owner = seed_human(su, workspace, "owner").await;
    let admin = seed_human(su, workspace, "admin").await;
    let member = seed_human(su, workspace, "member").await;
    let guest = seed_human(su, workspace, "guest").await;
    let agent = seed_agent(su, workspace, owner.id).await;
    Fixture {
        workspace,
        owner,
        admin,
        member,
        guest,
        agent,
    }
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> String {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": TEST_PASSWORD,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status(), 200, "seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("login returns an access token")
        .to_string()
}

async fn agent_bearer(su: &PgPool, workspace: Uuid, agent: Uuid) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{workspace}.{secret}");
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write']::text[], 'settings-conformance')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

fn settings_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/settings")
}

async fn get_settings(http: &reqwest::Client, url: &str, token: &str) -> reqwest::Response {
    http.get(url)
        .bearer_auth(token)
        .send()
        .await
        .expect("GET settings")
}

async fn patch_settings(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    body: &Value,
) -> reqwest::Response {
    http.patch(url)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .expect("PATCH settings")
}

async fn stored_settings(su: &PgPool, workspace: Uuid) -> Value {
    sqlx::query_scalar("SELECT settings FROM workspace WHERE id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("read stored settings")
}

async fn write_settings_sql(su: &PgPool, workspace: Uuid, settings: Value) {
    sqlx::query("UPDATE workspace SET settings = $2 WHERE id = $1")
        .bind(workspace)
        .bind(settings)
        .execute(su)
        .await
        .expect("seed settings via SQL");
}

async fn audit_count(su: &PgPool, workspace: Uuid, action: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*)::bigint FROM audit_log WHERE workspace_id = $1 AND action = $2",
    )
    .bind(workspace)
    .bind(action)
    .fetch_one(su)
    .await
    .expect("count audit rows")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn member_and_guest_are_forbidden_on_get_and_patch() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "roles").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let url = settings_url(&base, fixture.workspace);
    for email in [&fixture.member.email, &fixture.guest.email] {
        let token = login(&http, &base, fixture.workspace, email).await;
        let got = get_settings(&http, &url, &token).await;
        assert_eq!(got.status(), 403, "GET as {email}");
        let patched = patch_settings(
            &http,
            &url,
            &token,
            &json!({"allowed_agent_models": ["hermes-agent"]}),
        )
        .await;
        assert_eq!(patched.status(), 403, "PATCH as {email}");
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn agent_bearer_is_forbidden() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "agent").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = agent_bearer(&su, fixture.workspace, fixture.agent).await;
    let url = settings_url(&base, fixture.workspace);
    let got = get_settings(&http, &url, &token).await;
    assert_eq!(got.status(), 403, "agent GET must not reach the bag");
    let patched = patch_settings(
        &http,
        &url,
        &token,
        &json!({"allowed_agent_models": ["hermes-agent"]}),
    )
    .await;
    assert_eq!(patched.status(), 403, "agent PATCH must not write the bag");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn owner_and_admin_can_read_and_write() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "ops").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let url = settings_url(&base, fixture.workspace);
    for email in [&fixture.owner.email, &fixture.admin.email] {
        let token = login(&http, &base, fixture.workspace, email).await;
        let got = get_settings(&http, &url, &token).await;
        assert_eq!(got.status(), 200, "GET as {email}");
        let patched = patch_settings(
            &http,
            &url,
            &token,
            &json!({"allowed_agent_models": ["hermes-agent"]}),
        )
        .await;
        assert_eq!(patched.status(), 200, "PATCH as {email}");
        let body: Value = patched.json().await.expect("operator PATCH body");
        assert_eq!(body["allowed_agent_models"], json!(["hermes-agent"]));
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn foreign_workspace_is_rejected_and_rls_hides_settings() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let owner = seed(&su, "owner").await;
    let stranger = seed(&su, "stranger").await;
    write_settings_sql(
        &su,
        owner.workspace,
        json!({"allowed_agent_models": ["hermes-fast"]}),
    )
    .await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, stranger.workspace, &stranger.owner.email).await;
    let foreign = get_settings(&http, &settings_url(&base, owner.workspace), &token).await;
    assert_eq!(
        foreign.status(),
        403,
        "path workspace ≠ credential workspace"
    );
    let patched = patch_settings(
        &http,
        &settings_url(&base, owner.workspace),
        &token,
        &json!({"allowed_agent_models": ["hermes-agent"]}),
    )
    .await;
    assert_eq!(patched.status(), 403);

    let owner_workspace = owner.workspace;
    with_tenant_tx(&app, stranger.workspace, move |conn| {
        Box::pin(async move {
            let rows: Vec<Value> =
                sqlx::query_scalar("SELECT settings FROM workspace WHERE id = $1")
                    .bind(owner_workspace)
                    .fetch_all(&mut *conn)
                    .await?;
            assert!(
                rows.is_empty(),
                "foreign GUC must not see the owner's workspace.settings: {rows:?}"
            );
            Ok(())
        })
    })
    .await
    .expect("foreign tenant read");

    with_tenant_tx(&app, owner.workspace, move |conn| {
        Box::pin(async move {
            let settings: Value =
                sqlx::query_scalar("SELECT settings FROM workspace WHERE id = $1")
                    .bind(owner_workspace)
                    .fetch_one(&mut *conn)
                    .await?;
            assert_eq!(settings["allowed_agent_models"], json!(["hermes-fast"]));
            Ok(())
        })
    })
    .await
    .expect("owner tenant read");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn empty_workspace_get_returns_empty_object() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "empty").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner.email).await;
    let got = get_settings(&http, &settings_url(&base, fixture.workspace), &token).await;
    assert_eq!(got.status(), 200);
    let body: Value = got.json().await.expect("empty GET body");
    assert_eq!(body, json!({}));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn partial_merge_preserves_other_keys_and_null_deletes() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "merge").await;
    write_settings_sql(
        &su,
        fixture.workspace,
        json!({"role_labels": {"owner": "대표"}}),
    )
    .await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner.email).await;
    let url = settings_url(&base, fixture.workspace);

    let patched = patch_settings(
        &http,
        &url,
        &token,
        &json!({"allowed_agent_models": ["hermes-agent"]}),
    )
    .await;
    assert_eq!(patched.status(), 200);
    let body: Value = patched.json().await.expect("merge PATCH body");
    assert_eq!(body["allowed_agent_models"], json!(["hermes-agent"]));
    assert_eq!(body["role_labels"], json!({"owner": "대표"}));
    assert_eq!(
        stored_settings(&su, fixture.workspace).await["role_labels"],
        json!({"owner": "대표"}),
        "SQL-seeded key A must survive a PATCH of key B"
    );

    let deleted = patch_settings(&http, &url, &token, &json!({"allowed_agent_models": null})).await;
    assert_eq!(deleted.status(), 200);
    let body: Value = deleted.json().await.expect("null PATCH body");
    assert!(
        body.get("allowed_agent_models").is_none(),
        "null must delete the key: {body}"
    );
    assert_eq!(body["role_labels"], json!({"owner": "대표"}));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn unknown_key_is_rejected() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "unknown").await;
    write_settings_sql(
        &su,
        fixture.workspace,
        json!({"allowed_agent_models": ["keep"]}),
    )
    .await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner.email).await;
    let url = settings_url(&base, fixture.workspace);
    for body in [
        json!({"role_labels": {"owner": "대표"}}),
        json!({"totally_unknown": true}),
        json!({"allowedAgentModels": ["hermes-agent"]}),
    ] {
        let patched = patch_settings(&http, &url, &token, &body).await;
        assert_eq!(patched.status(), 400, "unknown key must 400: {body}");
        let err: Value = patched.json().await.expect("error envelope");
        assert!(err["error"]["message"].is_string(), "{err}");
    }
    assert_eq!(
        stored_settings(&su, fixture.workspace).await["allowed_agent_models"],
        json!(["keep"]),
        "a refused PATCH must not mutate the bag"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn allowed_agent_models_shape_violations_are_rejected() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "shape").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner.email).await;
    let url = settings_url(&base, fixture.workspace);
    for body in [
        json!({"allowed_agent_models": "hermes-agent"}),
        json!({"allowed_agent_models": [1]}),
        json!({"allowed_agent_models": [null]}),
        json!({"allowed_agent_models": [{"id": "hermes-agent"}]}),
    ] {
        let patched = patch_settings(&http, &url, &token, &body).await;
        assert_eq!(patched.status(), 400, "shape violation must 400: {body}");
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn oversized_payload_is_rejected() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "limit").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner.email).await;
    let url = settings_url(&base, fixture.workspace);

    let too_many: Vec<String> = (0..33).map(|i| format!("model-{i}")).collect();
    let count = patch_settings(
        &http,
        &url,
        &token,
        &json!({"allowed_agent_models": too_many}),
    )
    .await;
    assert_eq!(count.status(), 400, "33 models must 400");

    let too_long = "m".repeat(65);
    let length = patch_settings(
        &http,
        &url,
        &token,
        &json!({"allowed_agent_models": [too_long]}),
    )
    .await;
    assert_eq!(length.status(), 400, "65-byte model id must 400");

    let huge = patch_settings(
        &http,
        &url,
        &token,
        &json!({"allowed_agent_models": ["ok"], "pad": "x".repeat(9_000)}),
    )
    .await;
    assert!(
        matches!(huge.status().as_u16(), 400 | 413),
        "oversize body must close with 400/413, got {}",
        huge.status()
    );
    let err: Value = huge.json().await.expect("closed error envelope");
    assert!(err["error"]["message"].is_string(), "{err}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn patch_writes_an_audit_row() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "audit").await;
    let before = audit_count(&su, fixture.workspace, "workspace_setting.updated").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner.email).await;
    let patched = patch_settings(
        &http,
        &settings_url(&base, fixture.workspace),
        &token,
        &json!({"allowed_agent_models": ["hermes-agent"]}),
    )
    .await;
    assert_eq!(patched.status(), 200);
    let after = audit_count(&su, fixture.workspace, "workspace_setting.updated").await;
    assert!(after > before, "PATCH must leave workspace_setting.updated");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn workspace_identity_get_still_omits_settings() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "identity").await;
    write_settings_sql(
        &su,
        fixture.workspace,
        json!({"allowed_agent_models": ["secret-to-members"]}),
    )
    .await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    let response = http
        .get(format!("{base}/v1/workspaces/{}", fixture.workspace))
        .bearer_auth(token)
        .send()
        .await
        .expect("GET workspace identity");
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.expect("identity body");
    assert!(
        body["workspace"].get("settings").is_none(),
        "GET /v1/workspaces/{{ws}} must not grow a settings field: {body}"
    );
    let encoded = body.to_string();
    assert!(
        !encoded.contains("allowed_agent_models") && !encoded.contains("secret-to-members"),
        "identity GET must not leak the bag: {encoded}"
    );
}

/// Domain-layer lock proof: A's `FOR UPDATE` read keeps B's `FOR UPDATE` unread
/// until A commits. HTTP cannot show this — a request is committed when it
/// answers. Drop the lock and B finishes during the short wait.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn for_update_read_blocks_a_second_for_update() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "for-update").await;
    let workspace = fixture.workspace;

    let mut tx_a = app.begin().await.expect("begin A");
    rebind_tenant_guc(&mut tx_a, workspace)
        .await
        .expect("bind A's tenant GUC");
    sqlx::query("SET LOCAL lock_timeout = '30s'")
        .execute(&mut *tx_a)
        .await
        .expect("arm A's hang guard");
    let held = read_workspace_settings_for_update(&mut tx_a, workspace)
        .await
        .expect("A takes the row");
    assert!(held.is_some(), "A must see the workspace row");

    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    let app_b = app.clone();
    let b = tokio::spawn(async move {
        let mut tx_b = app_b.begin().await.expect("begin B");
        rebind_tenant_guc(&mut tx_b, workspace)
            .await
            .expect("bind B's tenant GUC");
        sqlx::query("SET LOCAL lock_timeout = '30s'")
            .execute(&mut *tx_b)
            .await
            .expect("arm B's hang guard");
        let _ = ready_tx.send(());
        let settings = read_workspace_settings_for_update(&mut tx_b, workspace).await;
        tx_b.commit().await.expect("commit B");
        settings
    });

    ready_rx.await.expect("B reached the for-update");
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(
        !b.is_finished(),
        "B's for-update must still be blocked while A holds the row"
    );

    tx_a.commit().await.expect("commit A");
    let settings = tokio::time::timeout(Duration::from_secs(5), b)
        .await
        .expect("B must finish after A commits")
        .expect("B task")
        .expect("B for-update");
    assert!(settings.is_some(), "B must see the workspace row after A");
}
