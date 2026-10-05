//! #3505 — the box runner's server side (ADR-0197 M2): runner credential, the three runner
//! routes, fencing, the attempts cap, closed reports. Real router, `momo_app` (NOBYPASSRLS) pool.
//!
//! | test | proves | revert that makes it red |
//! |---|---|---|
//! | `registration_is_the_instance_operators_and_the_credential_is_only_stored_hashed` | admin 403 / listed operator 201; one live runner; sha256 at rest, no plaintext anywhere (row, audit); rotation kills the old token; revoke returns leases to pending | `require_instance_operator`; storing the token; the unique index |
//! | `only_the_runner_credential_opens_the_runner_routes` | human JWT, garbage, another workspace's runner, a revoked runner, a wrong secret → one identical 401; closed instance → 404 before auth; only refusals spend the per-IP budget | the shared authenticator; the gate; the 401 filter |
//! | `a_stale_lease_cannot_complete_and_a_fresh_one_can` | lease id + attempts fencing over HTTP; wrong runner id at the statement level; a cancelled control is stale | the `lease_id`/`attempts`/`runner_id` predicates |
//! | `the_attempts_cap_poisons_a_control_and_settles_its_box` | 5 hand-outs, then `failed/poisoned` and the box edge (create → deleted, delete → delete_failed); never handed out a 6th time | `MAX_CONTROL_ATTEMPTS` handling |
//! | `reports_must_fit_the_verb_and_a_delete_needs_its_verification` | observed words, deletion report, unknown fields, create → running / delete verified → deleted / unverified → delete_failed | the report checks; `deletion.verified()` |
//! | `concurrent_polls_never_hand_one_control_out_twice` | 8 concurrent claims, exactly one wins | `FOR UPDATE SKIP LOCKED` |
//! | `the_runner_table_is_rls_forced_least_privilege_and_holds_no_plaintext` | FORCE RLS, grants, exact column list, no delete | RLS flags; the lockdown block |
//! | `the_reconcile_list_carries_ids_and_states_only` | `GET …/boxes` shape | the DTO |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::{
    AgentGatewayMode, AgentGatewaySettings, AgentPortConfig, SettingsConfig,
};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "cloud-box-runner-pg-signing-secret";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated PostgreSQL 18 URL")
}

fn required_pg_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name} for the isolated PG"))
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
    panic!("psql client not found");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema mutex");
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
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .env("PGPASSWORD", required_pg_env("PGPASSWORD"))
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

async fn insert_human(pool: &PgPool, workspace: Uuid, name: &str, role: &str) -> (Uuid, String) {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human',$3,$4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(name)
    .bind(format!("h-{}", id.simple()))
    .execute(pool)
    .await
    .expect("human member");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(id)
    .bind(workspace)
    .bind(format!("{id}@cb.test"))
    .execute(pool)
    .await
    .expect("human identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) \
         VALUES($1,$2,$3::text::membership_role)",
    )
    .bind(workspace)
    .bind(id)
    .bind(role)
    .execute(pool)
    .await
    .expect("human membership");
    let jwt = momo_auth::sign_access(id, workspace, &[], TEST_JWT_SECRET)
        .expect("sign")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'cb-conformance')",
    )
    .bind(workspace)
    .bind(id)
    .bind(&jwt)
    .execute(pool)
    .await
    .expect("session token");
    (id, jwt)
}


/// ADR-0197 M4 (증보 2): the runner is not handed a `create` until the box's owner has put its first device list
/// (`PUT …/owner-device-list`, an owner-device-signed control). These suites test the queue, not the trust chain
/// (`cloud_box_relay_pg.rs` in `momo-box-e2e` does), so they plant an opaque list for every box still `creating`.
async fn plant_owner_lists() {
    let su = superuser_pool().await;
    sqlx::query(
        "INSERT INTO cloud_box_trust (box_id, workspace_id, owner_list, owner_list_at) \
         SELECT id, workspace_id, '\\x01'::bytea, now() FROM cloud_box WHERE state = 'creating' \
         ON CONFLICT (box_id) DO UPDATE SET \
           owner_list = COALESCE(cloud_box_trust.owner_list, EXCLUDED.owner_list), \
           owner_list_at = COALESCE(cloud_box_trust.owner_list_at, now())",
    )
    .execute(&su)
    .await
    .expect("plant owner lists");
}

async fn call(
    client: &reqwest::Client,
    method: &str,
    url: String,
    jwt: &str,
    body: Option<Value>,
) -> (u16, Value) {
    if url.ends_with("/claim") {
        plant_owner_lists().await;
    }
    let mut request = match method {
        "GET" => client.get(url),
        _ => client.post(url),
    }
    .bearer_auth(jwt);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.expect("request");
    let status = response.status().as_u16();
    let text = response.text().await.expect("body");
    let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    (status, value)
}

use std::collections::BTreeSet;

use momo_server::config::RateLimitConfig;
use momo_settings::cloud_box::{
    complete_control_in_tx, CompleteOutcome, CompleteReport, MAX_CONTROL_ATTEMPTS,
};
use sha2::{Digest, Sha256};

struct World {
    workspace: Uuid,
    operator: Uuid,
    operator_jwt: String,
    plain_admin_jwt: String,
    m: Uuid,
    m_jwt: String,
}

async fn seed_world(pool: &PgPool) -> World {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("cbr-{}", workspace.simple()))
        .execute(pool)
        .await
        .expect("workspace");
    let (operator, operator_jwt) = insert_human(pool, workspace, "운영자", "owner").await;
    let (_a, plain_admin_jwt) = insert_human(pool, workspace, "관리자", "admin").await;
    let (m, m_jwt) = insert_human(pool, workspace, "엠", "member").await;
    World {
        workspace,
        operator,
        operator_jwt,
        plain_admin_jwt,
        m,
        m_jwt,
    }
}

/// `operators` are the listed instance operators' member ids (their fixture email is `<id>@cb.test`).
async fn start_server(
    pool: PgPool,
    enabled: Option<bool>,
    operators: &[Uuid],
    rate: Option<RateLimitConfig>,
) -> String {
    let mut state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_settings(SettingsConfig {
        provider_link_master_key: None,
        env_provider: momo_settings::ProviderConfig::default(),
        platform_admin_emails: operators.iter().map(|id| format!("{id}@cb.test")).collect(),
        environment: "local".to_string(),
    })
    .with_agent_gateway(AgentGatewaySettings {
        mode: AgentGatewayMode::Gateway,
        secret: "cloud-box-gateway-secret".to_string(),
        allow_legacy_secret: false,
    })
    .with_agent_port(AgentPortConfig {
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        ..AgentPortConfig::default()
    })
    .with_rate_limit(rate.unwrap_or(RateLimitConfig {
        claim_per_ip_limit: 0,
        ..RateLimitConfig::default()
    }));
    if let Some(enabled) = enabled {
        state = state.with_cloud_box(momo_server::config::CloudBoxConfig { enabled });
    }
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

fn runners_url(base: &str, ws: Uuid, tail: &str) -> String {
    format!("{base}/v1/workspaces/{ws}/cloud-box-runners{tail}")
}

fn runner_url(base: &str, ws: Uuid, tail: &str) -> String {
    format!("{base}/v1/workspaces/{ws}/cloud-box-runner{tail}")
}

fn boxes_url(base: &str, ws: Uuid, tail: &str) -> String {
    format!("{base}/v1/workspaces/{ws}/cloud-boxes{tail}")
}

fn error_code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or("")
}

/// Register a runner through the operator route and return (runner id, credential).
async fn register_runner(
    client: &reqwest::Client,
    base: &str,
    w: &World,
    name: &str,
) -> (Uuid, String) {
    let (status, body) = call(
        client,
        "POST",
        runners_url(base, w.workspace, ""),
        &w.operator_jwt,
        Some(json!({ "name": name })),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    (
        Uuid::parse_str(body["runner"]["id"].as_str().expect("runner id")).expect("uuid"),
        body["credential"].as_str().expect("credential").to_string(),
    )
}

/// The owner creates a box; returns its id.
async fn create_box(client: &reqwest::Client, base: &str, w: &World) -> Uuid {
    let (status, body) = call(
        client,
        "POST",
        boxes_url(base, w.workspace, ""),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 201, "{body}");
    Uuid::parse_str(body["id"].as_str().expect("box id")).expect("uuid")
}

async fn claim_http(client: &reqwest::Client, base: &str, ws: Uuid, token: &str) -> Value {
    let (status, body) = call(
        client,
        "POST",
        runner_url(base, ws, "/claim"),
        token,
        Some(json!({ "limit": 10 })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    body
}

async fn complete_http(
    client: &reqwest::Client,
    base: &str,
    ws: Uuid,
    token: &str,
    control: &str,
    body: Value,
) -> (u16, Value) {
    call(
        client,
        "POST",
        runner_url(base, ws, &format!("/controls/{control}/complete")),
        token,
        Some(body),
    )
    .await
}

async fn box_state(su: &PgPool, id: Uuid) -> String {
    sqlx::query_scalar("SELECT state FROM cloud_box WHERE id = $1")
        .bind(id)
        .fetch_one(su)
        .await
        .expect("box state")
}

async fn control_row(su: &PgPool, id: &str) -> (String, Option<String>, i32) {
    sqlx::query_as(
        "SELECT status, result_code, attempts FROM cloud_box_control WHERE id = $1::uuid",
    )
    .bind(id)
    .fetch_one(su)
    .await
    .expect("control")
}

async fn expire_lease(su: &PgPool, id: &str) {
    sqlx::query("UPDATE cloud_box_control SET lease_expires_at = now() - interval '1 second' WHERE id = $1::uuid")
        .bind(id)
        .execute(su)
        .await
        .expect("expire lease");
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ---------------------------------------------------------------------------
// registration, rotation, revocation
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3505-*)"]
async fn registration_is_the_instance_operators_and_the_credential_is_only_stored_hashed() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = seed_world(&su).await;
    let base = start_server(app.clone(), Some(true), &[w.operator], None).await;
    let client = reqwest::Client::new();

    // A workspace admin who is not a listed instance operator cannot register (D2 역할 분리); a plain member and a stranger neither.
    for jwt in [&w.plain_admin_jwt, &w.m_jwt] {
        let (status, body) = call(
            &client,
            "POST",
            runners_url(&base, w.workspace, ""),
            jwt,
            Some(json!({ "name": "런너" })),
        )
        .await;
        assert_eq!(status, 403, "{body}");
    }
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM cloud_box_runner WHERE workspace_id = $1")
            .bind(w.workspace)
            .fetch_one(&su)
            .await
            .expect("count");
    assert_eq!(rows, 0, "a refused registration wrote a runner");

    // Bad names and unknown fields.
    for bad in [json!({ "name": "" }), json!({ "name": "x".repeat(65) })] {
        let (status, _) = call(
            &client,
            "POST",
            runners_url(&base, w.workspace, ""),
            &w.operator_jwt,
            Some(bad),
        )
        .await;
        assert_eq!(status, 400);
    }
    let (status, _) = call(
        &client,
        "POST",
        runners_url(&base, w.workspace, ""),
        &w.operator_jwt,
        Some(json!({ "name": "런너", "image": "evil" })),
    )
    .await;
    assert_eq!(status, 422, "an unknown field (image) must be refused");

    let (runner, token) = register_runner(&client, &base, &w, "런너 A").await;
    assert!(token.starts_with(&format!("oort_runner.{runner}.")));
    // At rest: the hash only. No column anywhere holds the plaintext.
    let stored: (Vec<u8>, String) = sqlx::query_as(
        "SELECT credential_hash, credential_fingerprint FROM cloud_box_runner WHERE id = $1",
    )
    .bind(runner)
    .fetch_one(&su)
    .await
    .expect("runner row");
    assert_eq!(
        stored
            .0
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>(),
        sha256_hex(&token)
    );
    assert_eq!(stored.1, sha256_hex(&token)[..16]);
    let leaked: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM audit_log WHERE detail::text LIKE '%' || $1 || '%') \
              + (SELECT count(*) FROM cloud_box_runner WHERE name LIKE '%' || $1 || '%')",
    )
    .bind(&token)
    .fetch_one(&su)
    .await
    .expect("leak scan");
    assert_eq!(leaked, 0, "the credential reached the audit log or a row");
    let audit: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_log WHERE target_type = 'cloud_box_runner' AND target_id = $1 ORDER BY created_at, id",
    )
    .bind(runner)
    .fetch_all(&su)
    .await
    .expect("audit");
    assert_eq!(audit, vec!["cloud_box_runner.registered"]);

    // One live runner per workspace.
    let (status, body) = call(
        &client,
        "POST",
        runners_url(&base, w.workspace, ""),
        &w.operator_jwt,
        Some(json!({ "name": "둘째" })),
    )
    .await;
    assert_eq!(
        (status, error_code(&body)),
        (409, "cloud_box_runner_exists")
    );

    // The list names the runner and nothing secret.
    let (status, list) = call(
        &client,
        "GET",
        runners_url(&base, w.workspace, ""),
        &w.operator_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let text = list.to_string();
    assert!(
        !text.contains(&token)
            && !text.contains("credentialHash")
            && !text.contains("\"credential\""),
        "{text}"
    );
    assert_eq!(
        list["runners"][0]["credentialFingerprint"],
        sha256_hex(&token)[..16]
    );

    // The credential works; rotation kills it at once and the new one works.
    let first = claim_http(&client, &base, w.workspace, &token).await;
    assert_eq!(first["controls"], json!([]));
    let raw = client
        .post(runners_url(
            &base,
            w.workspace,
            &format!("/{runner}/rotate"),
        ))
        .bearer_auth(&w.operator_jwt)
        .send()
        .await
        .expect("rotate");
    let (status, cache_control, pragma) = (
        raw.status().as_u16(),
        raw.headers().get("cache-control").cloned(),
        raw.headers().get("pragma").cloned(),
    );
    let rotated: Value = raw.json().await.expect("json");
    assert_eq!(status, 200, "{rotated}");
    assert_eq!(
        (
            cache_control.as_ref().and_then(|v| v.to_str().ok()),
            pragma.as_ref().and_then(|v| v.to_str().ok())
        ),
        (Some("no-store"), Some("no-cache")),
        "a one-time credential response must not be cacheable"
    );
    let new_token = rotated["credential"]
        .as_str()
        .expect("new credential")
        .to_string();
    assert_ne!(new_token, token);
    let (status, _) = call(
        &client,
        "POST",
        runner_url(&base, w.workspace, "/claim"),
        &token,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, 401, "the rotated-out credential still works");
    claim_http(&client, &base, w.workspace, &new_token).await;
    let (status, _) = call(
        &client,
        "POST",
        runners_url(&base, w.workspace, &format!("/{}/rotate", Uuid::new_v4())),
        &w.operator_jwt,
        None,
    )
    .await;
    assert_eq!(status, 404);

    // Revoke: the runner's held leases go back to pending and its credential is dead.
    let box_id = create_box(&client, &base, &w).await;
    let claimed = claim_http(&client, &base, w.workspace, &new_token).await;
    assert_eq!(claimed["controls"].as_array().expect("controls").len(), 1);
    let control = claimed["controls"][0]["id"]
        .as_str()
        .expect("id")
        .to_string();
    let (status, revoked) = call(
        &client,
        "POST",
        runners_url(&base, w.workspace, &format!("/{runner}/revoke")),
        &w.operator_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200, "{revoked}");
    assert!(revoked["revokedAtMs"].is_number());
    let held: (String, Option<Uuid>, Option<Uuid>) = sqlx::query_as(
        "SELECT status, runner_id, lease_id FROM cloud_box_control WHERE id = $1::uuid",
    )
    .bind(&control)
    .fetch_one(&su)
    .await
    .expect("control");
    assert_eq!(
        held,
        ("pending".to_string(), None, None),
        "a revoked runner kept its lease"
    );
    let (status, _) = call(
        &client,
        "POST",
        runner_url(&base, w.workspace, "/claim"),
        &new_token,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, 401, "a revoked runner still authenticates");
    // Revoking again is fine; and a revoked runner cannot be rotated back to life.
    let (status, _) = call(
        &client,
        "POST",
        runners_url(&base, w.workspace, &format!("/{runner}/revoke")),
        &w.operator_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let (status, _) = call(
        &client,
        "POST",
        runners_url(&base, w.workspace, &format!("/{runner}/rotate")),
        &w.operator_jwt,
        None,
    )
    .await;
    assert_eq!(status, 404);
    // …and the next runner registers fresh and takes the pending control.
    let (second, second_token) = register_runner(&client, &base, &w, "런너 B").await;
    assert_ne!(second, runner);
    let taken = claim_http(&client, &base, w.workspace, &second_token).await;
    assert_eq!(taken["controls"][0]["id"].as_str(), Some(control.as_str()));
    assert_eq!(
        taken["controls"][0]["boxId"].as_str(),
        Some(box_id.to_string().as_str())
    );
    let audit: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_log WHERE target_type = 'cloud_box_runner' AND target_id = $1 ORDER BY created_at, id",
    )
    .bind(runner)
    .fetch_all(&su)
    .await
    .expect("audit");
    assert_eq!(
        audit,
        vec![
            "cloud_box_runner.registered",
            "cloud_box_runner.rotated",
            "cloud_box_runner.revoked"
        ]
    );
    // A revoked row stays revoked at the database level too.
    let undone = sqlx::query("UPDATE cloud_box_runner SET revoked_at = NULL WHERE id = $1")
        .bind(runner)
        .execute(&su)
        .await;
    assert!(undone.is_err(), "a revoked runner was un-revoked");
    // The operator of another workspace cannot see or touch this one.
    let other = seed_world(&su).await;
    let other_base =
        start_server(app.clone(), Some(true), &[w.operator, other.operator], None).await;
    let (status, _) = call(
        &client,
        "GET",
        runners_url(&other_base, w.workspace, ""),
        &other.operator_jwt,
        None,
    )
    .await;
    assert_eq!(status, 403, "workspace scope mismatch");
}

// ---------------------------------------------------------------------------
// authentication
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3505-*)"]
async fn only_the_runner_credential_opens_the_runner_routes() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = seed_world(&su).await;
    let other = seed_world(&su).await;
    let base = start_server(app.clone(), Some(true), &[w.operator, other.operator], None).await;
    let client = reqwest::Client::new();
    let (runner, token) = register_runner(&client, &base, &w, "런너").await;
    let other_base_world = &other;
    let (other_runner, other_token) =
        register_runner(&client, &base, other_base_world, "남의 런너").await;
    let (_revoked_id, revoked_token) = {
        let third = seed_world(&su).await;
        let b = start_server(app.clone(), Some(true), &[third.operator], None).await;
        let (id, token) = register_runner(&client, &b, &third, "폐기될 런너").await;
        let (status, _) = call(
            &client,
            "POST",
            runners_url(&b, third.workspace, &format!("/{id}/revoke")),
            &third.operator_jwt,
            None,
        )
        .await;
        assert_eq!(status, 200);
        // Presented against the third workspace below, but its revocation is what is tested.
        ((third.workspace, id), token)
    };
    let third_ws = {
        let id: Uuid = sqlx::query_scalar("SELECT workspace_id FROM cloud_box_runner WHERE credential_hash = digest($1::text, 'sha256')")
            .bind(&revoked_token)
            .fetch_one(&su)
            .await
            .expect("third workspace");
        id
    };
    let wrong_secret = format!("oort_runner.{runner}.{}", "A".repeat(43));
    let routes: Vec<(&str, String, Option<Value>)> = vec![
        (
            "POST",
            runner_url(&base, w.workspace, "/claim"),
            Some(json!({"limit": 1})),
        ),
        (
            "POST",
            runner_url(
                &base,
                w.workspace,
                &format!("/controls/{}/complete", Uuid::new_v4()),
            ),
            Some(json!({"leaseId": Uuid::new_v4(), "attempts": 1, "ok": true})),
        ),
        ("GET", runner_url(&base, w.workspace, "/boxes"), None),
    ];
    let mut bodies = BTreeSet::new();
    for (method, url, body) in &routes {
        for (label, bearer) in [
            ("a human JWT (the owner)", w.operator_jwt.clone()),
            ("a human JWT (a member)", w.m_jwt.clone()),
            ("garbage", "not-a-token".to_string()),
            ("an empty bearer", String::new()),
            ("the right runner id, a wrong secret", wrong_secret.clone()),
            ("another workspace's runner", other_token.clone()),
        ] {
            let (status, body) = call(&client, method, url.clone(), &bearer, body.clone()).await;
            assert_eq!(status, 401, "{method} {url} with {label}: {body}");
            bodies.insert(body.to_string());
        }
        // No Authorization header at all.
        let response = match *method {
            "GET" => client.get(url.clone()).send().await,
            _ => {
                client
                    .post(url.clone())
                    .json(&body.clone().unwrap_or(json!({})))
                    .send()
                    .await
            }
        }
        .expect("request");
        assert_eq!(
            response.status().as_u16(),
            401,
            "{method} {url} with no header"
        );
        bodies.insert(
            response
                .text()
                .await
                .expect("body")
                .parse::<Value>()
                .expect("json")
                .to_string(),
        );
    }
    assert_eq!(
        bodies.len(),
        1,
        "every credential failure must answer the same sentence: {bodies:?}"
    );
    // A revoked runner (its own workspace) is the same 401.
    let (status, body) = call(
        &client,
        "POST",
        runner_url(&base, third_ws, "/claim"),
        &revoked_token,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, 401);
    assert!(bodies.contains(&body.to_string()));
    // The runner's own credential works — and only in its workspace.
    claim_http(&client, &base, w.workspace, &token).await;
    let (status, _) = call(
        &client,
        "POST",
        runner_url(&base, other.workspace, "/claim"),
        &token,
        Some(json!({})),
    )
    .await;
    assert_eq!(
        status, 401,
        "a runner credential presented for another workspace's path"
    );
    let (status, _) = call(
        &client,
        "POST",
        runner_url(&base, w.workspace, "/claim"),
        &other_token,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, 401);
    let _ = (other_runner,);
    // The runner credential is not a bearer for anything else.
    let (status, _) = call(
        &client,
        "GET",
        boxes_url(&base, w.workspace, "/mine"),
        &token,
        None,
    )
    .await;
    assert_eq!(status, 401, "a runner credential read the owner's box API");
    let (status, _) = call(
        &client,
        "GET",
        runners_url(&base, w.workspace, ""),
        &token,
        None,
    )
    .await;
    assert_eq!(status, 401, "a runner credential read the operator API");

    // A closed instance: 404 before anything is read, with or without a valid credential and whatever the body.
    let closed = start_server(app.clone(), None, &[w.operator], None).await;
    for (method, url, body) in &routes {
        let url = url.replace(&base, &closed);
        let (status, _) = call(&client, method, url.clone(), &token, body.clone()).await;
        assert_eq!(status, 404, "{method} {url} on a closed instance");
    }
    let raw = client
        .post(runner_url(&closed, w.workspace, "/claim"))
        .bearer_auth("x")
        .header("content-type", "application/json")
        .body("{not json")
        .send()
        .await
        .expect("raw");
    assert_eq!(
        raw.status().as_u16(),
        404,
        "malformed JSON on a closed instance"
    );
    let (status, _) = call(
        &client,
        "POST",
        runners_url(&closed, w.workspace, ""),
        &w.operator_jwt,
        Some(json!({"name": "x"})),
    )
    .await;
    assert_eq!(status, 404, "registration on a closed instance");

    // Per-IP budget: only REFUSED credentials spend it; a polling runner is never throttled.
    let limited = start_server(
        app.clone(),
        Some(true),
        &[w.operator],
        Some(RateLimitConfig {
            claim_per_ip_limit: 5,
            ..RateLimitConfig::default()
        }),
    )
    .await;
    for _ in 0..40 {
        let (status, _) = call(
            &client,
            "POST",
            runner_url(&limited, w.workspace, "/claim"),
            &token,
            Some(json!({})),
        )
        .await;
        assert_eq!(
            status, 200,
            "an accepted poll must not spend the refusal budget"
        );
    }
    let mut refused = Vec::new();
    for _ in 0..8 {
        let (status, _) = call(
            &client,
            "POST",
            runner_url(&limited, w.workspace, "/claim"),
            "oort_runner.x",
            Some(json!({})),
        )
        .await;
        refused.push(status);
    }
    assert_eq!(&refused[..5], &[401; 5], "{refused:?}");
    assert!(
        refused[5..].iter().all(|s| *s == 429),
        "the 6th refusal must be a 429: {refused:?}"
    );
    // The pre-check: once the address's refusal budget is spent even a VALID credential from it is
    // turned away before the handler runs.
    let (status, _) = call(
        &client,
        "POST",
        runner_url(&limited, w.workspace, "/claim"),
        &token,
        Some(json!({})),
    )
    .await;
    assert_eq!(
        status, 429,
        "an exhausted address still reached the handler"
    );
    // Body is closed even for the right credential: unknown fields are 422, bad limit 400.
    let (status, _) = call(
        &client,
        "POST",
        runner_url(&base, w.workspace, "/claim"),
        &token,
        Some(json!({"limit": 1, "image": "x"})),
    )
    .await;
    assert_eq!(status, 422);
    let (status, _) = call(
        &client,
        "POST",
        runner_url(&base, w.workspace, "/claim"),
        &token,
        Some(json!({"limit": 0})),
    )
    .await;
    assert_eq!(status, 400);
}

// ---------------------------------------------------------------------------
// fencing
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3505-*)"]
async fn a_stale_lease_cannot_complete_and_a_fresh_one_can() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = seed_world(&su).await;
    let base = start_server(app.clone(), Some(true), &[w.operator], None).await;
    let client = reqwest::Client::new();
    let (runner, token) = register_runner(&client, &base, &w, "런너").await;
    let box_id = create_box(&client, &base, &w).await;

    let first = claim_http(&client, &base, w.workspace, &token).await;
    let c1 = &first["controls"][0];
    let control = c1["id"].as_str().expect("id").to_string();
    assert_eq!(c1["verb"], "create");
    assert_eq!(c1["attempts"], 1);
    assert_eq!(
        c1["limits"],
        json!({"cpuMillis": 1000, "memoryMb": 2048, "diskGb": 10, "pids": 512})
    );
    assert_eq!(
        c1.as_object()
            .expect("object")
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>(),
        ["attempts", "boxId", "id", "leaseId", "limits", "seq", "verb"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        "a control carries verb, box, limits and its lease — no image, command, mount or env"
    );
    let lease1 = c1["leaseId"].as_str().expect("lease").to_string();

    // The lease runs out; the same control comes back as attempt 2 with a NEW lease.
    expire_lease(&su, &control).await;
    let second = claim_http(&client, &base, w.workspace, &token).await;
    let c2 = &second["controls"][0];
    assert_eq!(
        (c2["id"].as_str(), c2["attempts"].as_i64()),
        (Some(control.as_str()), Some(2))
    );
    let lease2 = c2["leaseId"].as_str().expect("lease").to_string();
    assert_ne!(lease1, lease2);

    let ok =
        |lease: &str, attempts: i64| json!({"leaseId": lease, "attempts": attempts, "ok": true});
    // The old lease (right attempts for it) is fenced out and writes nothing.
    let (status, body) = complete_http(
        &client,
        &base,
        w.workspace,
        &token,
        &control,
        ok(&lease1, 1),
    )
    .await;
    assert_eq!(
        (status, error_code(&body)),
        (409, "cloud_box_control_stale"),
        "{body}"
    );
    // The new lease with the OLD attempt count is fenced out too.
    let (status, body) = complete_http(
        &client,
        &base,
        w.workspace,
        &token,
        &control,
        ok(&lease2, 1),
    )
    .await;
    assert_eq!(
        (status, error_code(&body)),
        (409, "cloud_box_control_stale"),
        "{body}"
    );
    // An unknown lease id.
    let (status, _) = complete_http(
        &client,
        &base,
        w.workspace,
        &token,
        &control,
        ok(&Uuid::new_v4().to_string(), 2),
    )
    .await;
    assert_eq!(status, 409);
    assert_eq!(
        control_row(&su, &control).await,
        ("claimed".to_string(), None, 2),
        "a fenced completion wrote something"
    );
    assert_eq!(
        box_state(&su, box_id).await,
        "creating",
        "a fenced completion moved the box"
    );
    // Unknown control.
    let (status, _) = complete_http(
        &client,
        &base,
        w.workspace,
        &token,
        &Uuid::new_v4().to_string(),
        ok(&lease2, 2),
    )
    .await;
    assert_eq!(status, 404);
    // The current lease completes, and the box edge lands in the same transaction.
    let (status, body) = complete_http(
        &client,
        &base,
        w.workspace,
        &token,
        &control,
        ok(&lease2, 2),
    )
    .await;
    assert_eq!(
        (status, body["boxState"].as_str()),
        (200, Some("running")),
        "{body}"
    );
    assert_eq!(
        control_row(&su, &control).await,
        ("done".to_string(), Some("ok".to_string()), 2)
    );
    assert_eq!(box_state(&su, box_id).await, "running");
    // Completing twice is fenced (it is no longer claimed).
    let (status, _) = complete_http(
        &client,
        &base,
        w.workspace,
        &token,
        &control,
        ok(&lease2, 2),
    )
    .await;
    assert_eq!(status, 409);

    // At the statement level: the right lease under ANOTHER runner id is stale (fencing includes the runner).
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, w.workspace, &format!("/{box_id}/stop")),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let stop = claim_http(&client, &base, w.workspace, &token).await;
    let s = &stop["controls"][0];
    let stop_id = Uuid::parse_str(s["id"].as_str().expect("id")).expect("uuid");
    let stop_lease = Uuid::parse_str(s["leaseId"].as_str().expect("lease")).expect("uuid");
    let ws = w.workspace;
    let outcome = momo_db::with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            complete_control_in_tx(
                conn,
                ws,
                Uuid::new_v4(),
                stop_id,
                stop_lease,
                1,
                CompleteReport {
                    ok: true,
                    observed: None,
                    deletion: None,
                },
            )
            .await
        })
    })
    .await
    .expect("complete");
    assert_eq!(
        outcome,
        CompleteOutcome::Stale,
        "another runner id completed this runner's control"
    );

    // A control the owner superseded is no longer completable. (A claimed control whose lease ran out is
    // cancelled by the next owner request, like M1's supersede.)
    expire_lease(&su, &stop_id.to_string()).await;
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, w.workspace, &format!("/{box_id}/start")),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(control_row(&su, &stop_id.to_string()).await.0, "cancelled");
    let (status, _) = complete_http(
        &client,
        &base,
        w.workspace,
        &token,
        &stop_id.to_string(),
        ok(&stop_lease.to_string(), 1),
    )
    .await;
    assert_eq!(status, 409, "a cancelled control was completed");
    let _ = runner;
}

// ---------------------------------------------------------------------------
// the attempts cap
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3505-*)"]
async fn the_attempts_cap_poisons_a_control_and_settles_its_box() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = seed_world(&su).await;
    let base = start_server(app.clone(), Some(true), &[w.operator], None).await;
    let client = reqwest::Client::new();
    let (_runner, token) = register_runner(&client, &base, &w, "런너").await;
    let box_id = create_box(&client, &base, &w).await;

    let mut control = String::new();
    for attempt in 1..=MAX_CONTROL_ATTEMPTS {
        let got = claim_http(&client, &base, w.workspace, &token).await;
        let c = &got["controls"][0];
        assert_eq!(c["attempts"].as_i64(), Some(i64::from(attempt)), "{got}");
        control = c["id"].as_str().expect("id").to_string();
        assert_eq!(got["poisoned"], json!([]));
        expire_lease(&su, &control).await;
    }
    // The next poll does not hand it out a sixth time: it poisons it and settles the box.
    let after = claim_http(&client, &base, w.workspace, &token).await;
    assert_eq!(
        after["controls"],
        json!([]),
        "a poisoned control was handed out again"
    );
    assert_eq!(after["poisoned"], json!([control]));
    assert_eq!(
        control_row(&su, &control).await,
        (
            "failed".to_string(),
            Some("poisoned".to_string()),
            MAX_CONTROL_ATTEMPTS
        )
    );
    assert_eq!(
        box_state(&su, box_id).await,
        "deleted",
        "a poisoned create is a failed create"
    );
    let reason: Option<String> =
        sqlx::query_scalar("SELECT closed_reason FROM cloud_box WHERE id = $1")
            .bind(box_id)
            .fetch_one(&su)
            .await
            .expect("reason");
    assert_eq!(reason.as_deref(), Some("create_failed"));
    let again = claim_http(&client, &base, w.workspace, &token).await;
    assert_eq!(
        (again["controls"].clone(), again["poisoned"].clone()),
        (json!([]), json!([])),
        "poison is reported once"
    );
    // The DB floor above the Rust cap: attempts cannot pass 10 by any path.
    let over = sqlx::query("UPDATE cloud_box_control SET attempts = 11 WHERE id = $1::uuid")
        .bind(&control)
        .execute(&su)
        .await;
    assert!(over.is_err(), "the attempts hard floor is missing");

    // A poisoned DELETE leaves the box in delete_failed (volume may remain: the owner/admin retries).
    let second = seed_world(&su).await;
    let base2 = start_server(app.clone(), Some(true), &[second.operator], None).await;
    let (_r2, token2) = register_runner(&client, &base2, &second, "런너").await;
    let box2 = create_box(&client, &base2, &second).await;
    let got = claim_http(&client, &base2, second.workspace, &token2).await;
    let create = got["controls"][0]["id"].as_str().expect("id").to_string();
    let lease = got["controls"][0]["leaseId"]
        .as_str()
        .expect("lease")
        .to_string();
    let (status, _) = complete_http(
        &client,
        &base2,
        second.workspace,
        &token2,
        &create,
        json!({"leaseId": lease, "attempts": 1, "ok": true}),
    )
    .await;
    assert_eq!(status, 200);
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base2, second.workspace, &format!("/{box2}/delete")),
        &second.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let mut delete = String::new();
    for _ in 1..=MAX_CONTROL_ATTEMPTS {
        let got = claim_http(&client, &base2, second.workspace, &token2).await;
        delete = got["controls"][0]["id"].as_str().expect("id").to_string();
        assert_eq!(got["controls"][0]["verb"], "delete");
        expire_lease(&su, &delete).await;
    }
    let after = claim_http(&client, &base2, second.workspace, &token2).await;
    assert_eq!(after["poisoned"], json!([delete]));
    assert_eq!(box_state(&su, box2).await, "delete_failed");
    let audit: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_log WHERE target_type = 'cloud_box' AND target_id = $1 ORDER BY created_at, id",
    )
    .bind(box2)
    .fetch_all(&su)
    .await
    .expect("audit");
    assert!(
        audit.contains(&"cloud_box.delete_failed".to_string()),
        "{audit:?}"
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3505-*)"]
async fn a_control_handed_back_by_a_revoked_runner_at_the_cap_is_still_poisoned() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = seed_world(&su).await;
    let base = start_server(app.clone(), Some(true), &[w.operator], None).await;
    let client = reqwest::Client::new();
    let (runner, token) = register_runner(&client, &base, &w, "런너").await;
    let box_id = create_box(&client, &base, &w).await;
    let mut control = String::new();
    for attempt in 1..=MAX_CONTROL_ATTEMPTS {
        let got = claim_http(&client, &base, w.workspace, &token).await;
        control = got["controls"][0]["id"].as_str().expect("id").to_string();
        if attempt < MAX_CONTROL_ATTEMPTS {
            expire_lease(&su, &control).await;
        }
    }
    // The 5th lease is live; the operator revokes the runner: the control returns to pending at attempts = 5.
    let (status, _) = call(
        &client,
        "POST",
        runners_url(&base, w.workspace, &format!("/{runner}/revoke")),
        &w.operator_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        control_row(&su, &control).await,
        ("pending".to_string(), None, MAX_CONTROL_ATTEMPTS)
    );
    let (_, second_token) = register_runner(&client, &base, &w, "런너 B").await;
    let got = claim_http(&client, &base, w.workspace, &second_token).await;
    assert_eq!(
        got["controls"],
        json!([]),
        "a control at the cap was handed out again"
    );
    assert_eq!(got["poisoned"], json!([control]));
    assert_eq!(
        box_state(&su, box_id).await,
        "deleted",
        "its box never settled"
    );
}

// ---------------------------------------------------------------------------
// #3509 review: M1 race, M2 write scope, M3 cheap refusals, L5 throttle
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3505-*)"]
async fn revoke_waits_for_an_in_flight_runner_authentication() {
    use momo_settings::cloud_box_runner::{authenticate_runner_in_tx, revoke_runner_in_tx};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = seed_world(&su).await;
    let base = start_server(app.clone(), Some(true), &[w.operator], None).await;
    let client = reqwest::Client::new();
    let (runner, token) = register_runner(&client, &base, &w, "런너").await;
    // Fresh last_seen_at: the throttled touch writes nothing, so the ONLY lock the authentication
    // holds is the share lock under test (a row write would also block a revoke, masking its absence).
    sqlx::query("UPDATE cloud_box_runner SET last_seen_at = now() WHERE id = $1")
        .bind(runner)
        .execute(&su)
        .await
        .expect("touch");
    let (ws, operator) = (w.workspace, w.operator);
    let revoked = Arc::new(AtomicBool::new(false));
    let seen_during = Arc::new(AtomicBool::new(true));
    let handle: Arc<std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>> = Arc::default();
    let (app2, revoked2, seen2, handle2) = (
        app.clone(),
        revoked.clone(),
        seen_during.clone(),
        handle.clone(),
    );
    momo_db::with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            // Authentication (a claim's first step) holds the runner row…
            let info = authenticate_runner_in_tx(conn, ws, &token).await?;
            assert!(info.is_some());
            // …so a revoke started now must wait for this transaction.
            let (app3, revoked3) = (app2.clone(), revoked2.clone());
            *handle2.lock().expect("handle") = Some(tokio::spawn(async move {
                momo_db::with_tenant_tx(&app3, ws, move |c| {
                    Box::pin(
                        async move { revoke_runner_in_tx(c, ws, runner, operator, None).await },
                    )
                })
                .await
                .expect("revoke");
                revoked3.store(true, Ordering::SeqCst);
            }));
            tokio::time::sleep(std::time::Duration::from_millis(600)).await;
            seen2.store(revoked2.load(Ordering::SeqCst), Ordering::SeqCst);
            Ok(())
        })
    })
    .await
    .expect("auth tx");
    assert!(
        !seen_during.load(Ordering::SeqCst),
        "a revoke interleaved with an in-flight claim authentication"
    );
    let join = handle.lock().expect("handle").take().expect("spawned");
    join.await.expect("revoke task");
    assert!(
        revoked.load(Ordering::SeqCst),
        "the revoke never completed after the claim finished"
    );
    let (status, _) = call(
        &client,
        "POST",
        runner_url(&base, w.workspace, "/claim"),
        "x",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, 401);
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3505-*)"]
async fn a_platform_read_token_cannot_register_rotate_or_revoke_a_runner() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = seed_world(&su).await;
    let base = start_server(app.clone(), Some(true), &[w.operator], None).await;
    let client = reqwest::Client::new();
    let (runner, _token) = register_runner(&client, &base, &w, "런너").await;
    // An admin whose only credential is a `platform:read` token (and who is not on the allow-list).
    let (viewer, _) = insert_human(&su, w.workspace, "읽기 운영자", "admin").await;
    let scopes = vec!["platform:read".to_string()];
    let jwt = momo_auth::sign_access(viewer, w.workspace, &scopes, TEST_JWT_SECRET)
        .expect("sign")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),$4,'platform-read')",
    )
    .bind(w.workspace)
    .bind(viewer)
    .bind(&jwt)
    .bind(&scopes)
    .execute(&su)
    .await
    .expect("token");
    let (status, _) = call(
        &client,
        "GET",
        runners_url(&base, w.workspace, ""),
        &jwt,
        None,
    )
    .await;
    assert_eq!(status, 200, "platform:read may still READ the runner list");
    for (method, url, body) in [
        (
            "POST",
            runners_url(&base, w.workspace, ""),
            Some(json!({"name": "x"})),
        ),
        (
            "POST",
            runners_url(&base, w.workspace, &format!("/{runner}/rotate")),
            None,
        ),
        (
            "POST",
            runners_url(&base, w.workspace, &format!("/{runner}/revoke")),
            None,
        ),
    ] {
        let (status, body) = call(&client, method, url.clone(), &jwt, body).await;
        assert_eq!(
            status, 403,
            "{url}: a platform:read token wrote the runner: {body}"
        );
    }
    // Nothing changed: the one runner is still live.
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM cloud_box_runner WHERE workspace_id = $1 AND revoked_at IS NULL",
    )
    .bind(w.workspace)
    .fetch_one(&su)
    .await
    .expect("count");
    assert_eq!(live, 1);
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3505-*)"]
async fn refusals_are_cheap_bodies_are_capped_and_last_seen_is_throttled() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = seed_world(&su).await;
    let base = start_server(app.clone(), Some(true), &[w.operator], None).await;
    let client = reqwest::Client::new();
    let (runner, token) = register_runner(&client, &base, &w, "런너").await;
    // Body cap: a 5 KB body is refused before it is read.
    plant_owner_lists().await;
    let big = client
        .post(runner_url(&base, w.workspace, "/claim"))
        .bearer_auth(&token)
        .header("content-type", "application/json")
        .body(format!(
            "{{\"limit\": 1, \"pad\": \"{}\"}}",
            "x".repeat(5000)
        ))
        .send()
        .await
        .expect("big");
    assert_eq!(big.status().as_u16(), 413);
    // last_seen_at moves at most once a minute.
    claim_http(&client, &base, w.workspace, &token).await;
    let first: Option<i64> = sqlx::query_scalar("SELECT (extract(epoch from last_seen_at) * 1000)::bigint FROM cloud_box_runner WHERE id = $1")
        .bind(runner)
        .fetch_one(&su)
        .await
        .expect("seen");
    assert!(first.is_some());
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    claim_http(&client, &base, w.workspace, &token).await;
    let second: Option<i64> = sqlx::query_scalar("SELECT (extract(epoch from last_seen_at) * 1000)::bigint FROM cloud_box_runner WHERE id = $1")
        .bind(runner)
        .fetch_one(&su)
        .await
        .expect("seen");
    assert_eq!(first, second, "last_seen_at was rewritten on every poll");
    sqlx::query(
        "UPDATE cloud_box_runner SET last_seen_at = now() - interval '2 minutes' WHERE id = $1",
    )
    .bind(runner)
    .execute(&su)
    .await
    .expect("age");
    claim_http(&client, &base, w.workspace, &token).await;
    let third: Option<i64> = sqlx::query_scalar("SELECT (extract(epoch from last_seen_at) * 1000)::bigint FROM cloud_box_runner WHERE id = $1")
        .bind(runner)
        .fetch_one(&su)
        .await
        .expect("seen");
    assert!(third > first, "a stale last_seen_at was not refreshed");
}

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3505-*)"]
async fn reports_must_fit_the_verb_and_a_delete_needs_its_verification() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = seed_world(&su).await;
    let base = start_server(app.clone(), Some(true), &[w.operator], None).await;
    let client = reqwest::Client::new();
    let (_runner, token) = register_runner(&client, &base, &w, "런너").await;
    let box_id = create_box(&client, &base, &w).await;

    // create: a failure settles the box as a failed create; extra report fields are refused.
    let got = claim_http(&client, &base, w.workspace, &token).await;
    let c = got["controls"][0].clone();
    let (id, lease) = (
        c["id"].as_str().expect("id").to_string(),
        c["leaseId"].as_str().expect("lease").to_string(),
    );
    for (label, extra) in [
        (
            "an observed word on a create",
            json!({"observed": "running"}),
        ),
        (
            "a deletion report on a create",
            json!({"deletion": {"containerAbsent": true, "volumeAbsent": true}}),
        ),
    ] {
        let mut body = json!({"leaseId": lease, "attempts": 1, "ok": true});
        body.as_object_mut()
            .expect("object")
            .extend(extra.as_object().expect("object").clone());
        let (status, _) = complete_http(&client, &base, w.workspace, &token, &id, body).await;
        assert_eq!(status, 400, "{label}");
    }
    for field in ["image", "command", "mounts", "env", "inspect", "status"] {
        let mut body = json!({"leaseId": lease, "attempts": 1, "ok": true});
        body[field] = json!("x");
        let (status, _) = complete_http(&client, &base, w.workspace, &token, &id, body).await;
        assert_eq!(status, 422, "an unknown field `{field}` must be refused");
    }
    assert_eq!(
        control_row(&su, &id).await.0,
        "claimed",
        "a refused report changed the control"
    );
    let (status, body) = complete_http(
        &client,
        &base,
        w.workspace,
        &token,
        &id,
        json!({"leaseId": lease, "attempts": 1, "ok": true}),
    )
    .await;
    assert_eq!((status, body["boxState"].as_str()), (200, Some("running")));

    // status: ok needs exactly one of three words; a failure carries none; no deletion report.
    let ws = w.workspace;
    let enqueue_status = |su: PgPool| async move {
        sqlx::query(
            "INSERT INTO cloud_box_control (workspace_id, box_id, verb) VALUES ($1, $2, 'status')",
        )
        .bind(ws)
        .bind(box_id)
        .execute(&su)
        .await
        .expect("status control");
    };
    enqueue_status(su.clone()).await;
    let got = claim_http(&client, &base, w.workspace, &token).await;
    let c = got["controls"][0].clone();
    assert_eq!(c["verb"], "status");
    assert!(c.get("limits").is_none());
    let (id, lease) = (
        c["id"].as_str().expect("id").to_string(),
        c["leaseId"].as_str().expect("lease").to_string(),
    );
    for (label, body) in [
        (
            "ok without a word",
            json!({"leaseId": lease, "attempts": 1, "ok": true}),
        ),
        (
            "a word outside the closed three",
            json!({"leaseId": lease, "attempts": 1, "ok": true, "observed": "Up 3 hours (healthy)"}),
        ),
        (
            "a failure with a word",
            json!({"leaseId": lease, "attempts": 1, "ok": false, "observed": "running"}),
        ),
        (
            "a deletion report on a status",
            json!({"leaseId": lease, "attempts": 1, "ok": true, "observed": "running", "deletion": {"containerAbsent": true, "volumeAbsent": true}}),
        ),
    ] {
        let (status, _) = complete_http(&client, &base, w.workspace, &token, &id, body).await;
        assert_eq!(status, 400, "{label}");
    }
    let (status, _) = complete_http(
        &client,
        &base,
        w.workspace,
        &token,
        &id,
        json!({"leaseId": lease, "attempts": 1, "ok": true, "observed": "stopped"}),
    )
    .await;
    assert_eq!(status, 200);
    let observed: Option<String> =
        sqlx::query_scalar("SELECT observed FROM cloud_box_control WHERE id = $1::uuid")
            .bind(&id)
            .fetch_one(&su)
            .await
            .expect("observed");
    assert_eq!(observed.as_deref(), Some("stopped"));
    assert_eq!(
        box_state(&su, box_id).await,
        "running",
        "a status report is a fact, not a transition"
    );

    // start/stop failures move no state (no edge in the D3 table) and leave an audit row.
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, w.workspace, &format!("/{box_id}/stop")),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let got = claim_http(&client, &base, w.workspace, &token).await;
    let c = got["controls"][0].clone();
    let (id, lease) = (
        c["id"].as_str().expect("id").to_string(),
        c["leaseId"].as_str().expect("lease").to_string(),
    );
    let (status, body) = complete_http(
        &client,
        &base,
        w.workspace,
        &token,
        &id,
        json!({"leaseId": lease, "attempts": 1, "ok": false}),
    )
    .await;
    assert_eq!(
        (status, body.get("boxState").is_none()),
        (200, true),
        "{body}"
    );
    assert_eq!(
        control_row(&su, &id).await,
        ("failed".to_string(), Some("failed".to_string()), 1)
    );
    assert_eq!(box_state(&su, box_id).await, "stopped");
    let audit: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_log WHERE target_type = 'cloud_box' AND target_id = $1 ORDER BY created_at, id",
    )
    .bind(box_id)
    .fetch_all(&su)
    .await
    .expect("audit");
    assert!(
        audit.contains(&"cloud_box.control_failed".to_string()),
        "{audit:?}"
    );

    // delete: done only with the verification, and only when BOTH absences are verified.
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, w.workspace, &format!("/{box_id}/delete")),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let got = claim_http(&client, &base, w.workspace, &token).await;
    let c = got["controls"][0].clone();
    assert_eq!(c["verb"], "delete");
    let (id, lease) = (
        c["id"].as_str().expect("id").to_string(),
        c["leaseId"].as_str().expect("lease").to_string(),
    );
    let (status, _) = complete_http(
        &client,
        &base,
        w.workspace,
        &token,
        &id,
        json!({"leaseId": lease, "attempts": 1, "ok": true}),
    )
    .await;
    assert_eq!(
        status, 400,
        "a delete that says done without the verification report"
    );
    let (status, _) = complete_http(&client, &base, w.workspace, &token, &id, json!({"leaseId": lease, "attempts": 1, "ok": true, "observed": "absent", "deletion": {"containerAbsent": true, "volumeAbsent": true}})).await;
    assert_eq!(status, 400, "a delete reports no observed word");
    assert_eq!(box_state(&su, box_id).await, "deleting");
    // The runner SAYS ok but the volume is still there: the server does not trust the flag.
    let (status, body) = complete_http(&client, &base, w.workspace, &token, &id, json!({"leaseId": lease, "attempts": 1, "ok": true, "deletion": {"containerAbsent": true, "volumeAbsent": false}})).await;
    assert_eq!(
        (status, body["boxState"].as_str()),
        (200, Some("delete_failed")),
        "{body}"
    );
    let report: (String, Option<String>, Option<bool>, Option<bool>) = sqlx::query_as(
        "SELECT status, result_code, container_absent, volume_absent FROM cloud_box_control WHERE id = $1::uuid",
    )
    .bind(&id)
    .fetch_one(&su)
    .await
    .expect("report");
    assert_eq!(
        report,
        (
            "failed".to_string(),
            Some("failed".to_string()),
            Some(true),
            Some(false)
        )
    );
    // The admin retries; the runner verifies both and the box closes as deleted.
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, w.workspace, &format!("/{box_id}/delete")),
        &w.operator_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let got = claim_http(&client, &base, w.workspace, &token).await;
    let c = got["controls"][0].clone();
    let (id, lease) = (
        c["id"].as_str().expect("id").to_string(),
        c["leaseId"].as_str().expect("lease").to_string(),
    );
    let (status, body) = complete_http(&client, &base, w.workspace, &token, &id, json!({"leaseId": lease, "attempts": 1, "ok": true, "deletion": {"containerAbsent": true, "volumeAbsent": true}})).await;
    assert_eq!(
        (status, body["boxState"].as_str()),
        (200, Some("deleted")),
        "{body}"
    );
    let tomb: (String, Option<String>) =
        sqlx::query_as("SELECT state, closed_reason FROM cloud_box WHERE id = $1")
            .bind(box_id)
            .fetch_one(&su)
            .await
            .expect("tombstone");
    assert_eq!(tomb.0, "deleted");
    // The reconcile list still names the tombstone (with its state) for a while.
    let (status, list) = call(
        &client,
        "GET",
        runner_url(&base, w.workspace, "/boxes"),
        &token,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert!(list["boxes"]
        .as_array()
        .expect("boxes")
        .iter()
        .any(|b| b["boxId"] == box_id.to_string() && b["state"] == "deleted"));
}

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3505-*)"]
async fn concurrent_polls_never_hand_one_control_out_twice() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = seed_world(&su).await;
    let base = start_server(app.clone(), Some(true), &[w.operator], None).await;
    let client = reqwest::Client::new();
    let (_runner, token) = register_runner(&client, &base, &w, "런너").await;
    create_box(&client, &base, &w).await;
    let mut handles = Vec::new();
    for _ in 0..8 {
        let (client, base, token, ws) = (client.clone(), base.clone(), token.clone(), w.workspace);
        handles.push(tokio::spawn(async move {
            claim_http(&client, &base, ws, &token).await
        }));
    }
    let mut got = 0;
    for handle in handles {
        let body = handle.await.expect("join");
        got += body["controls"].as_array().expect("controls").len();
    }
    assert_eq!(
        got, 1,
        "one control was handed to more than one concurrent poll"
    );
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3505-*)"]
async fn the_runner_table_is_rls_forced_least_privilege_and_holds_no_plaintext() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let a = seed_world(&su).await;
    let b = seed_world(&su).await;
    let base = start_server(app.clone(), Some(true), &[a.operator, b.operator], None).await;
    let client = reqwest::Client::new();
    let (ra, _) = register_runner(&client, &base, &a, "런너 A").await;
    let (rb, _) = register_runner(&client, &base, &b, "런너 B").await;

    let (enabled, forced): (bool, bool) = sqlx::query_as(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'cloud_box_runner'::regclass",
    )
    .fetch_one(&su)
    .await
    .expect("flags");
    assert!(
        enabled && forced,
        "cloud_box_runner must be ENABLE+FORCE row level security"
    );
    // Another workspace's runner is invisible inside this tenant, and a cross-workspace insert is refused.
    let (visible, hidden): (i64, i64) = momo_db::with_tenant_tx(&app, a.workspace, {
        let (ra, rb) = (ra, rb);
        move |conn| {
            Box::pin(async move {
                let visible: i64 =
                    sqlx::query_scalar("SELECT count(*) FROM cloud_box_runner WHERE id = $1")
                        .bind(ra)
                        .fetch_one(&mut *conn)
                        .await?;
                let hidden: i64 =
                    sqlx::query_scalar("SELECT count(*) FROM cloud_box_runner WHERE id = $1")
                        .bind(rb)
                        .fetch_one(&mut *conn)
                        .await?;
                Ok((visible, hidden))
            })
        }
    })
    .await
    .expect("rls read");
    assert_eq!((visible, hidden), (1, 0));
    let foreign_workspace = b.workspace;
    let crossed = momo_db::with_tenant_tx(&app, a.workspace, move |conn| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO cloud_box_runner (workspace_id, name, credential_hash, credential_fingerprint) \
                 VALUES ($1, 'x', digest('x', 'sha256'), repeat('a', 16))",
            )
            .bind(foreign_workspace)
            .execute(&mut *conn)
            .await?;
            Ok(())
        })
    })
    .await;
    assert!(
        crossed.is_err(),
        "a tenant wrote another workspace's runner row"
    );
    // No GUC, no rows: the policy cast either hides everything or refuses the unset setting outright.
    let none = {
        let mut conn = app.acquire().await.expect("conn");
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM cloud_box_runner")
            .fetch_one(&mut *conn)
            .await
    };
    match none {
        Ok(count) => assert_eq!(count, 0, "rows were visible with no tenant GUC"),
        Err(error) => assert!(
            error
                .to_string()
                .contains("invalid input syntax for type uuid"),
            "unexpected failure without the GUC: {error}"
        ),
    }

    // Grants: the BYPASSRLS pollers never touch it; momo_app selects/inserts/updates only.
    for (role, privilege, expect) in [
        ("momo_relay", "SELECT", false),
        ("momo_worker", "SELECT", false),
        ("momo_notifier", "SELECT", false),
        ("momo_app", "SELECT", true),
        ("momo_app", "INSERT", true),
        ("momo_app", "UPDATE", true),
        ("momo_app", "DELETE", false),
        ("momo_app", "TRUNCATE", false),
    ] {
        let has: Option<bool> = sqlx::query_scalar(
            "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) \
                    THEN has_table_privilege($1, 'cloud_box_runner', $2) END",
        )
        .bind(role)
        .bind(privilege)
        .fetch_one(&su)
        .await
        .expect("privilege");
        if let Some(has) = has {
            assert_eq!(has, expect, "{role} {privilege} on cloud_box_runner");
        }
    }
    // Rows are revoked, never deleted.
    let deleted = sqlx::query("DELETE FROM cloud_box_runner WHERE id = $1")
        .bind(ra)
        .execute(&su)
        .await;
    assert!(deleted.is_err(), "a runner row was deleted");
    // Exact columns: a hash and a fingerprint, never a plaintext or a token column.
    let columns: Vec<String> = sqlx::query_scalar(
        "SELECT column_name::text FROM information_schema.columns \
          WHERE table_schema = 'public' AND table_name = 'cloud_box_runner' ORDER BY column_name",
    )
    .fetch_all(&su)
    .await
    .expect("columns");
    assert_eq!(
        columns,
        [
            "created_at",
            "credential_fingerprint",
            "credential_hash",
            "id",
            "last_seen_at",
            "name",
            "registered_by",
            "revoked_at",
            "rotated_at",
            // ADR-0197 M4 (migration 120): the runner's PUBLIC signing key — set once, never a seed. No
            // fingerprint column: the device computes it from these bytes.
            "signing_public_key",
            "workspace_id",
        ]
    );
}

// ---------------------------------------------------------------------------
// the reconcile list
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3505-*)"]
async fn the_reconcile_list_carries_ids_and_states_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = seed_world(&su).await;
    let base = start_server(app.clone(), Some(true), &[w.operator], None).await;
    let client = reqwest::Client::new();
    let (_runner, token) = register_runner(&client, &base, &w, "런너").await;
    let box_id = create_box(&client, &base, &w).await;
    let (status, list) = call(
        &client,
        "GET",
        runner_url(&base, w.workspace, "/boxes"),
        &token,
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        list,
        json!({"boxes": [{"boxId": box_id.to_string(), "state": "creating"}]})
    );
    // Another workspace's boxes are not in it.
    let other = seed_world(&su).await;
    let other_base = start_server(app.clone(), Some(true), &[other.operator], None).await;
    create_box(&client, &other_base, &other).await;
    let (_, list) = call(
        &client,
        "GET",
        runner_url(&base, w.workspace, "/boxes"),
        &token,
        None,
    )
    .await;
    assert_eq!(list["boxes"].as_array().expect("boxes").len(), 1);
    // A live box is always on the list, whatever its state.
    sqlx::query(
        "UPDATE cloud_box SET state = 'deleting', closed_reason = 'owner_delete' WHERE id = $1",
    )
    .bind(box_id)
    .execute(&su)
    .await
    .expect("deleting");
    let (_, list) = call(
        &client,
        "GET",
        runner_url(&base, w.workspace, "/boxes"),
        &token,
        None,
    )
    .await;
    assert_eq!(list["boxes"][0]["state"], "deleting");
    let _ = w.m;
}
