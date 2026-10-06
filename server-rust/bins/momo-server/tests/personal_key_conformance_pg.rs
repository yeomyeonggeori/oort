//! #3396 — personal API keys (ADR-0147 증보 2026-10-03): the REST contract and
//! the delivery rule, on the real router against a `momo_app` (NOBYPASSRLS)
//! pool. The worker-side credential boundary has its own red proofs in
//! `momo-agent-worker/tests/personal_key_conformance_pg.rs`.
//!
//! | test | proves | revert that makes it red |
//! |---|---|---|
//! | `issue_list_revoke_keep_the_key_write_only_and_one_to_one` | admin-only issue; own-only `mine`; revoke by admin or holder; 409 on a second key for a member and on the same key twice (same member, other member, other workspace); no response or audit row carries the key; RLS hides the table across workspaces | the unique indexes of migration 117; the role checks; selecting `bearer_ciphertext` in a list statement |
//! | `a_bad_endpoint_or_key_is_refused_before_anything_is_stored` | SSRF/plaintext/credential-shaped input → 400, 0 rows | `validated_base_url`, `requested_key` |
//! | `a_guest_holder_makes_no_agent_and_a_changed_origin_is_in_the_audit` | a guest holder cannot mint a member; a re-issue at another origin is in the audit | the guest check in `create_agent`; `origin_changed_from` |
//! | `deleting_the_member_who_revoked_a_key_does_not_trip_the_one_way_trigger` | `revoked_by` ON DELETE SET NULL vs the immutability trigger | the NULL allowance in `personal_provider_link_immutable` |
//! | `the_personal_agent_is_the_holders_and_is_delivered_to_the_holder_only` | the created agent is `owner_only` + `uses_owner_key`; holder's mention → a worker job even with the subscription kill switch off; a non-holder's mention → 0 jobs and the owner_only skip | `owner_only_gate`, the `uses_owner_key` narrowing in `mention.rs` |

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

const TEST_JWT_SECRET: &str = "personal-key-pg-conformance-signing-secret";
const MASTER_KEY: &str = "personal-key-conformance-master-3396";
const KEY_ONE: &str = "sk-live-personal-3396-aaaa1111bbbb2222";
const KEY_TWO: &str = "sk-live-personal-3396-cccc3333dddd4444";
const BASE: &str = "https://api.provider-one.example/v1";
/// The operator's own provider host (`HERMES_BASE_URL`): exempt from the egress address check.
const OPERATOR_BASE: &str = "https://operator-gateway.example/v1";

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

async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_settings(SettingsConfig {
        provider_link_master_key: Some(MASTER_KEY.to_string()),
        env_provider: momo_settings::ProviderConfig {
            base_url: OPERATOR_BASE.to_string(),
            ..momo_settings::ProviderConfig::default()
        },
        platform_admin_emails: vec![],
        environment: "local".to_string(),
    })
    .with_agent_gateway(AgentGatewaySettings {
        mode: AgentGatewayMode::Gateway,
        secret: "personal-key-conformance-gateway-secret".to_string(),
        allow_legacy_secret: false,
    })
    // Both switches closed on purpose: a personal-key agent must not depend on
    // the hosted-delivery gate or on the subscription kill switch.
    .with_agent_port(AgentPortConfig {
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        hosted_delivery_enabled: false,
        hosted_lease_seconds: momo_outbox::HOSTED_LEASE_SECONDS_DEFAULT,
        subscription_agents_enabled: false,
        ..AgentPortConfig::default()
    });
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

struct World {
    workspace: Uuid,
    admin: Uuid,
    admin_jwt: String,
    m: Uuid,
    m_jwt: String,
    n: Uuid,
    n_jwt: String,
    channel: Uuid,
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
    .bind(format!("{id}@pk.test"))
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
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'pk-conformance')",
    )
    .bind(workspace)
    .bind(id)
    .bind(&jwt)
    .execute(pool)
    .await
    .expect("session token");
    (id, jwt)
}

async fn seed_world(pool: &PgPool) -> World {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("pk-{}", workspace.simple()))
        .execute(pool)
        .await
        .expect("workspace");
    let (admin, admin_jwt) = insert_human(pool, workspace, "관리자", "owner").await;
    let (m, m_jwt) = insert_human(pool, workspace, "엠", "member").await;
    let (n, n_jwt) = insert_human(pool, workspace, "엔", "member").await;
    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channel(id, workspace_id, kind, name) VALUES($1,$2,'public','team')")
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
    for member in [admin, m, n] {
        sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
            .bind(workspace)
            .bind(channel)
            .bind(member)
            .execute(pool)
            .await
            .expect("membership");
    }
    World {
        workspace,
        admin,
        admin_jwt,
        m,
        m_jwt,
        n,
        n_jwt,
        channel,
    }
}

async fn reset_keys(su: &PgPool) {
    // The key fingerprint is unique among active rows instance-wide.
    sqlx::query("DELETE FROM personal_provider_link")
        .execute(su)
        .await
        .expect("clear keys");
}

async fn call(
    client: &reqwest::Client,
    method: &str,
    url: String,
    jwt: &str,
    body: Option<Value>,
) -> (u16, Value) {
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

fn keys_url(base: &str, w: &World, tail: &str) -> String {
    format!("{base}/v1/workspaces/{}/personal-keys{tail}", w.workspace)
}

fn issue_body(owner: Uuid, key: &str) -> Value {
    json!({"ownerMemberId": owner, "apiKey": key, "baseUrl": BASE, "label": "엠의 키"})
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3396-*)"]
async fn issue_list_revoke_keep_the_key_write_only_and_one_to_one() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_keys(&su).await;
    let w = seed_world(&su).await;
    let other = seed_world(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let client = reqwest::Client::new();

    // A member cannot issue. The operator can.
    let (status, _) = call(
        &client,
        "POST",
        keys_url(&base, &w, ""),
        &w.m_jwt,
        Some(issue_body(w.m, KEY_ONE)),
    )
    .await;
    assert_eq!(
        status, 403,
        "a member issued a key for themselves (operator-issued only)"
    );
    let (status, issued) = call(
        &client,
        "POST",
        keys_url(&base, &w, ""),
        &w.admin_jwt,
        Some(issue_body(w.m, KEY_ONE)),
    )
    .await;
    assert_eq!(status, 201, "{issued}");
    let key_id = issued["id"].as_str().expect("id").to_string();
    assert_eq!(issued["status"], "active");
    assert_eq!(issued["ownerMemberId"], w.m.to_string());
    assert_eq!(issued["format"], "openai");
    assert_eq!(issued["endpointLabel"], BASE);
    assert!(
        !issued.to_string().contains(KEY_ONE),
        "the issue response echoes the key"
    );
    for forbidden in ["apiKey", "bearer", "fingerprint", "ciphertext"] {
        assert!(
            issued.get(forbidden).is_none(),
            "{forbidden} in the response"
        );
    }

    // One key, one member: the same key again (same member, another member,
    // another workspace), and a second key for the same member.
    let (status, again) = call(
        &client,
        "POST",
        keys_url(&base, &w, ""),
        &w.admin_jwt,
        Some(issue_body(w.m, KEY_ONE)),
    )
    .await;
    assert_eq!(status, 409, "{again}");
    let (status, to_n) = call(
        &client,
        "POST",
        keys_url(&base, &w, ""),
        &w.admin_jwt,
        Some(issue_body(w.n, KEY_ONE)),
    )
    .await;
    assert_eq!(
        (status, to_n["error"]["code"].clone()),
        (409, json!("personal_key_already_attached")),
        "{to_n}"
    );
    let (status, elsewhere) = call(
        &client,
        "POST",
        keys_url(&base, &other, ""),
        &other.admin_jwt,
        Some(issue_body(other.m, KEY_ONE)),
    )
    .await;
    assert_eq!(
        (status, elsewhere["error"]["code"].clone()),
        (409, json!("personal_key_already_attached")),
        "{elsewhere}"
    );
    let (status, second) = call(
        &client,
        "POST",
        keys_url(&base, &w, ""),
        &w.admin_jwt,
        Some(issue_body(w.m, KEY_TWO)),
    )
    .await;
    assert_eq!(
        (status, second["error"]["code"].clone()),
        (409, json!("personal_key_owner_has_active_key")),
        "{second}"
    );

    // N gets their own, different key.
    let (status, n_key) = call(
        &client,
        "POST",
        keys_url(&base, &w, ""),
        &w.admin_jwt,
        Some(issue_body(w.n, KEY_TWO)),
    )
    .await;
    assert_eq!(status, 201, "{n_key}");

    // Lists: the operator sees both; a member sees their own and nothing else.
    let (status, all) = call(&client, "GET", keys_url(&base, &w, ""), &w.admin_jwt, None).await;
    assert_eq!(status, 200);
    assert_eq!(all["keys"].as_array().unwrap().len(), 2);
    let (status, _) = call(&client, "GET", keys_url(&base, &w, ""), &w.m_jwt, None).await;
    assert_eq!(status, 403, "a member listed the whole workspace's keys");
    let (_, mine_m) = call(&client, "GET", keys_url(&base, &w, "/mine"), &w.m_jwt, None).await;
    let (_, mine_n) = call(&client, "GET", keys_url(&base, &w, "/mine"), &w.n_jwt, None).await;
    assert_eq!(mine_m["keys"].as_array().unwrap().len(), 1);
    assert_eq!(mine_m["keys"][0]["id"], key_id.as_str());
    assert_eq!(mine_n["keys"].as_array().unwrap().len(), 1);
    assert_ne!(
        mine_n["keys"][0]["id"],
        key_id.as_str(),
        "N's list shows M's key"
    );
    for body in [&all, &mine_m, &mine_n] {
        let text = body.to_string();
        assert!(
            !text.contains(KEY_ONE) && !text.contains(KEY_TWO),
            "a list carries a key"
        );
    }

    // Revoke: a member who is neither admin nor the holder gets a 404 (no
    // existence oracle); the holder and the operator can.
    let revoke_url = keys_url(&base, &w, &format!("/{key_id}/revoke"));
    let (status, _) = call(&client, "POST", revoke_url.clone(), &w.n_jwt, None).await;
    assert_eq!(status, 404);
    let (status, revoked) = call(&client, "POST", revoke_url.clone(), &w.m_jwt, None).await;
    assert_eq!(status, 200, "{revoked}");
    assert_eq!(revoked["status"], "revoked");
    let (status, twice) = call(&client, "POST", revoke_url, &w.admin_jwt, None).await;
    assert_eq!((status, twice["status"].clone()), (200, json!("revoked")));
    let (status, _) = call(
        &client,
        "POST",
        keys_url(&base, &other, &format!("/{key_id}/revoke")),
        &other.admin_jwt,
        None,
    )
    .await;
    assert_eq!(status, 404, "another workspace's operator reached this key");

    // After a revoke the member can be issued a fresh key.
    let (status, reissued) = call(
        &client,
        "POST",
        keys_url(&base, &w, ""),
        &w.admin_jwt,
        Some(issue_body(w.m, KEY_ONE)),
    )
    .await;
    assert_eq!(
        status, 201,
        "a revoked key's fingerprint must not block a re-issue: {reissued}"
    );

    // Audit: one row per fact, naming ids and labels — never the key.
    let issued_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND action='provider.personal_link.issued'",
    ).bind(w.workspace).fetch_one(&su).await.unwrap();
    let revoked_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND action='provider.personal_link.revoked'",
    ).bind(w.workspace).fetch_one(&su).await.unwrap();
    assert_eq!(
        (issued_rows, revoked_rows),
        (3, 1),
        "issue x3 (M, N, M again), revoke x1 (the repeat is not re-audited)"
    );
    let fingerprint = momo_settings::key_fingerprint(KEY_ONE, MASTER_KEY);
    let cipher_hex: Vec<String> =
        sqlx::query_scalar(
            "SELECT encode(bearer_ciphertext,'hex') FROM personal_provider_link WHERE workspace_id = ANY($1)",
        )
        .bind(vec![w.workspace, other.workspace])
        .fetch_all(&su)
            .await
            .unwrap();
    for table in ["audit_log", "outbox", "message"] {
        // This test's own workspaces only: the database is shared with other suites.
        let rows: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT row_to_json(x)::text FROM {table} x WHERE workspace_id = ANY($1)"
        ))
        .bind(vec![w.workspace, other.workspace])
        .fetch_all(&su)
        .await
        .unwrap();
        for row in rows {
            assert!(
                !row.contains(KEY_ONE) && !row.contains(KEY_TWO),
                "{table} carries a key"
            );
            assert!(!row.contains(&fingerprint), "{table} carries a fingerprint");
            for hex in &cipher_hex {
                assert!(!row.contains(hex.as_str()), "{table} carries a sealed box");
            }
        }
    }
    let stored: Vec<(Vec<u8>,)> =
        sqlx::query_as("SELECT bearer_ciphertext FROM personal_provider_link")
            .fetch_all(&su)
            .await
            .unwrap();
    for (blob,) in stored {
        assert!(
            !String::from_utf8_lossy(&blob).contains("sk-live"),
            "plaintext at rest"
        );
    }

    // RLS: the app role sees nothing without a workspace, and only its own
    // workspace's rows with one.
    let app = momo_app_pool().await;
    let none: i64 = sqlx::query_scalar("SELECT count(*) FROM personal_provider_link")
        .fetch_optional(&app)
        .await
        .map(|v| v.unwrap_or(0))
        .unwrap_or(-1);
    assert!(
        none <= 0,
        "momo_app read personal keys without a workspace: {none}"
    );
    let seen = momo_db::with_tenant_tx(&app, other.workspace, move |conn| {
        Box::pin(async move {
            let rows: Vec<(Uuid,)> =
                sqlx::query_as("SELECT workspace_id FROM personal_provider_link")
                    .fetch_all(&mut *conn)
                    .await?;
            Ok(rows)
        })
    })
    .await
    .unwrap();
    assert!(
        seen.iter().all(|(ws,)| *ws == other.workspace),
        "RLS leaked another workspace's key rows"
    );
    let _ = w.admin;
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3396-*)"]
async fn a_bad_endpoint_or_key_is_refused_before_anything_is_stored() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_keys(&su).await;
    let w = seed_world(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let client = reqwest::Client::new();
    let agent_member = Uuid::new_v4();
    sqlx::query("INSERT INTO member(id, workspace_id, kind, display_name, handle) VALUES($1,$2,'agent','봇',$3)")
        .bind(agent_member).bind(w.workspace).bind(format!("bot-{}", agent_member.simple()))
        .execute(&su).await.unwrap();

    let cases: Vec<(&str, Value)> = vec![
        (
            "plaintext remote",
            json!({"ownerMemberId": w.m, "apiKey": KEY_ONE, "baseUrl": "http://api.provider.example/v1"}),
        ),
        (
            "userinfo",
            json!({"ownerMemberId": w.m, "apiKey": KEY_ONE, "baseUrl": "https://user:pw@api.provider.example/v1"}),
        ),
        (
            "query",
            json!({"ownerMemberId": w.m, "apiKey": KEY_ONE, "baseUrl": "https://api.provider.example/v1?k=1"}),
        ),
        (
            "metadata literal",
            json!({"ownerMemberId": w.m, "apiKey": KEY_ONE, "baseUrl": "https://169.254.169.254/v1"}),
        ),
        (
            "loopback not allowed",
            json!({"ownerMemberId": w.m, "apiKey": KEY_ONE, "baseUrl": "http://127.0.0.1:9000/v1"}),
        ),
        (
            "whitespace in key",
            json!({"ownerMemberId": w.m, "apiKey": "sk-has space-1234567", "baseUrl": BASE}),
        ),
        (
            "operator host (egress-exempt)",
            json!({"ownerMemberId": w.m, "apiKey": KEY_ONE, "baseUrl": "https://operator-gateway.example:8443/anything"}),
        ),
        (
            "non-ascii key",
            json!({"ownerMemberId": w.m, "apiKey": "sk-live-\u{200b}personal-3396-zero-width", "baseUrl": BASE}),
        ),
        (
            "short key",
            json!({"ownerMemberId": w.m, "apiKey": "sk-1", "baseUrl": BASE}),
        ),
        (
            "envelope as key",
            json!({"ownerMemberId": w.m, "apiKey": "{\"kind\":\"oauth-openai\",\"refresh_token\":\"r\"}", "baseUrl": BASE}),
        ),
        (
            "unknown format",
            json!({"ownerMemberId": w.m, "apiKey": KEY_ONE, "baseUrl": BASE, "format": "claude-subscription"}),
        ),
        (
            "agent as holder",
            json!({"ownerMemberId": agent_member, "apiKey": KEY_ONE, "baseUrl": BASE}),
        ),
        (
            "stranger as holder",
            json!({"ownerMemberId": Uuid::new_v4(), "apiKey": KEY_ONE, "baseUrl": BASE}),
        ),
        (
            "unknown field",
            json!({"ownerMemberId": w.m, "apiKey": KEY_ONE, "baseUrl": BASE, "bearer": "x"}),
        ),
    ];
    for (name, body) in cases {
        let (status, value) = call(
            &client,
            "POST",
            keys_url(&base, &w, ""),
            &w.admin_jwt,
            Some(body),
        )
        .await;
        assert!(
            status == 400 || status == 422,
            "{name}: expected a 4xx refusal, got {status}: {value}"
        );
        let text = value.to_string();
        assert!(
            !text.contains(KEY_ONE),
            "{name}: the refusal echoes the key"
        );
    }
    let stored: i64 =
        sqlx::query_scalar("SELECT count(*) FROM personal_provider_link WHERE workspace_id=$1")
            .bind(w.workspace)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(stored, 0, "a refused issue stored a row");
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3396-*)"]
async fn the_personal_agent_is_the_holders_and_is_delivered_to_the_holder_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_keys(&su).await;
    let w = seed_world(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let client = reqwest::Client::new();

    let (_, issued) = call(
        &client,
        "POST",
        keys_url(&base, &w, ""),
        &w.admin_jwt,
        Some(issue_body(w.m, KEY_ONE)),
    )
    .await;
    let key_id = issued["id"].as_str().expect("key id").to_string();
    let agent_url = keys_url(&base, &w, &format!("/{key_id}/agent"));
    let handle = format!("mbrain-{}", &Uuid::new_v4().simple().to_string()[..8]);
    let agent_body =
        json!({"displayName": "엠의 두뇌", "handle": handle, "model": "gpt-personal-1"});

    // Not N's to make; the holder's to make.
    let (status, _) = call(
        &client,
        "POST",
        agent_url.clone(),
        &w.n_jwt,
        Some(agent_body.clone()),
    )
    .await;
    assert_eq!(status, 404);
    let (status, created) = call(
        &client,
        "POST",
        agent_url.clone(),
        &w.m_jwt,
        Some(agent_body.clone()),
    )
    .await;
    assert_eq!(status, 201, "{created}");
    let agent = Uuid::parse_str(created["agent"]["id"].as_str().unwrap()).unwrap();
    let row: (String, bool, Option<String>, Option<Uuid>, String, String) = sqlx::query_as(
        "SELECT invocation_scope, uses_owner_key, subscription_harness, owner_human_id, model_source, base_url \
           FROM agent WHERE member_id = $1",
    ).bind(agent).fetch_one(&su).await.unwrap();
    assert_eq!(
        (
            row.0.as_str(),
            row.1,
            row.2.as_deref(),
            row.3,
            row.4.as_str(),
            row.5.as_str()
        ),
        ("owner_only", true, None, Some(w.m), "agent", BASE)
    );

    // The read contract (AIH-2) names this brain: a personal key, the holder's
    // alone, served by the worker (so no host to be online).
    let (status, roster) = call(
        &client,
        "GET",
        format!("{base}/v1/workspaces/{}/roster", w.workspace),
        &w.n_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200, "{roster}");
    let row = roster
        .to_string()
        .contains(&agent.to_string())
        .then(|| {
            let members = roster
                .get("members")
                .or_else(|| roster.get("roster"))
                .unwrap_or(&roster);
            members
                .as_array()
                .and_then(|rows| {
                    rows.iter().find(|row| {
                        row["id"]
                            .as_str()
                            .is_some_and(|id| id.eq_ignore_ascii_case(&agent.to_string()))
                    })
                })
                .cloned()
                .expect("the personal agent is on the roster")
        })
        .expect("the personal agent is on the roster");
    assert_eq!(row["brain"], "personal_key", "{row}");
    assert_eq!(row["callableBy"], "owner_only");
    assert_eq!(row["owner"]["id"], json!(w.m.to_string()));
    assert!(row.get("hostOnline").is_none(), "{row}");
    assert!(row.get("brainUnavailableReason").is_none(), "{row}");

    // Put the agent in the room (the join the product does elsewhere), then call it.
    sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
        .bind(w.workspace)
        .bind(w.channel)
        .bind(agent)
        .execute(&su)
        .await
        .unwrap();
    let send = |jwt: String, body: String| {
        let client = client.clone();
        let url = format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            w.workspace, w.channel
        );
        async move {
            let response = client
                .post(url)
                .bearer_auth(jwt)
                .json(&json!({"clientMsgId": Uuid::new_v4(), "body": body}))
                .send()
                .await
                .unwrap();
            assert!(
                response.status().as_u16() < 300,
                "send: {}",
                response.status()
            );
        }
    };
    let jobs = |expected: i64, what: &'static str| {
        let su = su.clone();
        async move {
            let n: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' AND partition_key=$2",
            ).bind(w.workspace).bind(agent).fetch_one(&su).await.unwrap();
            assert_eq!(n, expected, "{what}");
        }
    };

    // A non-holder's mention delivers nothing.
    send(w.n_jwt.clone(), format!("@{handle} 엔이 불러요")).await;
    jobs(0, "a non-holder's mention became a worker job").await;
    let reason: String = sqlx::query_scalar(
        "SELECT detail->>'reason' FROM audit_log WHERE workspace_id=$1 AND action='agent.mention.skipped' \
          ORDER BY created_at DESC, id DESC LIMIT 1",
    ).bind(w.workspace).fetch_one(&su).await.unwrap();
    assert_eq!(reason, "owner_only_non_owner");

    // The operator is not the holder either: the agent is the holder's alone.
    send(w.admin_jwt.clone(), format!("@{handle} 관리자가 불러요")).await;
    jobs(0, "the operator's mention became a worker job").await;

    // The holder's mention is a worker job — with hosted delivery and the
    // subscription kill switch both closed. The payload follows its own model.
    send(w.m_jwt.clone(), format!("@{handle} 엠이 불러요")).await;
    jobs(1, "the holder's mention was not delivered to the worker").await;
    let payload: Value = sqlx::query_scalar(
        "SELECT payload FROM outbox WHERE workspace_id=$1 AND kind='agent_job' AND partition_key=$2",
    ).bind(w.workspace).bind(agent).fetch_one(&su).await.unwrap();
    assert_eq!(payload["model"], "gpt-personal-1");
    assert_eq!(payload["model_source"], "agent");
    assert!(
        !payload.to_string().contains(KEY_ONE),
        "the job carries the key"
    );

    // One personal agent per holder; the second create is a 409, not a second member.
    let (status, second_agent) = call(
        &client,
        "POST",
        agent_url.clone(),
        &w.m_jwt,
        Some(json!({"displayName": "둘째", "handle": format!("second-{}", &Uuid::new_v4().simple().to_string()[..8]), "model": "m"})),
    )
    .await;
    assert_eq!(
        (status, second_agent["error"]["code"].clone()),
        (409, json!("personal_agent_exists")),
        "{second_agent}"
    );

    // A revoked key makes no agent: 409, nothing created.
    let (status, _) = call(
        &client,
        "POST",
        keys_url(&base, &w, &format!("/{key_id}/revoke")),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let (status, refused) = call(&client, "POST", agent_url, &w.m_jwt,
        Some(json!({"displayName": "또", "handle": format!("again-{}", &Uuid::new_v4().simple().to_string()[..8]), "model": "m"}))).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (409, json!("personal_key_revoked")),
        "{refused}"
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3396-*)"]
async fn a_guest_holder_makes_no_agent_and_a_changed_origin_is_in_the_audit() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_keys(&su).await;
    let w = seed_world(&su).await;
    let (guest, guest_jwt) = insert_human(&su, w.workspace, "게스트", "guest").await;
    let base = start_server(momo_app_pool().await).await;
    let client = reqwest::Client::new();

    // A guest holder: the key can be issued, but they cannot mint a member.
    let (status, issued) = call(
        &client,
        "POST",
        keys_url(&base, &w, ""),
        &w.admin_jwt,
        Some(issue_body(guest, KEY_ONE)),
    )
    .await;
    assert_eq!(status, 201, "{issued}");
    let key_id = issued["id"].as_str().unwrap().to_string();
    let (status, refused) = call(
        &client,
        "POST",
        keys_url(&base, &w, &format!("/{key_id}/agent")),
        &guest_jwt,
        Some(json!({"displayName": "게스트 두뇌", "handle": format!("guest-{}", &Uuid::new_v4().simple().to_string()[..8]), "model": "m"})),
    )
    .await;
    assert_eq!(
        status, 403,
        "a guest holder created a workspace member: {refused}"
    );
    let agents: i64 =
        sqlx::query_scalar("SELECT count(*) FROM agent WHERE workspace_id=$1 AND uses_owner_key")
            .bind(w.workspace)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(agents, 0);

    // Revoke and re-issue to the same holder at another origin: the audit row
    // says from where to where (the holder's agent carries over to the new key).
    let (status, _) = call(
        &client,
        "POST",
        keys_url(&base, &w, &format!("/{key_id}/revoke")),
        &w.admin_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200);
    let (status, moved) = call(
        &client,
        "POST",
        keys_url(&base, &w, ""),
        &w.admin_jwt,
        Some(json!({"ownerMemberId": guest, "apiKey": KEY_TWO, "baseUrl": "https://api.provider-two.example/v1"})),
    )
    .await;
    assert_eq!(status, 201, "{moved}");
    let detail: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id=$1 AND action='provider.personal_link.issued' \
          ORDER BY created_at DESC, id DESC LIMIT 1",
    ).bind(w.workspace).fetch_one(&su).await.unwrap();
    assert_eq!(detail["origin_changed_from"], BASE, "{detail}");
    assert!(!detail.to_string().contains(KEY_TWO));
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (3396-*)"]
async fn deleting_the_member_who_revoked_a_key_does_not_trip_the_one_way_trigger() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_keys(&su).await;
    let w = seed_world(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let client = reqwest::Client::new();
    let (revoker, _) = insert_human(&su, w.workspace, "회수자", "admin").await;
    let (_, issued) = call(
        &client,
        "POST",
        keys_url(&base, &w, ""),
        &w.admin_jwt,
        Some(issue_body(w.m, KEY_ONE)),
    )
    .await;
    let key_id = issued["id"].as_str().unwrap().to_string();
    // Revoked directly (the route leaves an audit row, and a member with audit
    // history cannot be hard-deleted at all): the row names the revoker.
    sqlx::query(
        "UPDATE personal_provider_link SET revoked_at = now(), revoked_by = $2 WHERE id = $1::uuid",
    )
    .bind(&key_id)
    .bind(revoker)
    .execute(&su)
    .await
    .expect("revoke");
    // `revoked_by` is ON DELETE SET NULL: removing the revoker rewrites the row,
    // and the revocation trigger must let that one change through.
    sqlx::query("DELETE FROM member WHERE id = $1")
        .bind(revoker)
        .execute(&su)
        .await
        .expect("a revoker's deletion must not be blocked by personal_provider_link_immutable");
    let (revoked_at, revoked_by): (Option<chrono::DateTime<chrono::Utc>>, Option<Uuid>) =
        sqlx::query_as(
            "SELECT revoked_at, revoked_by FROM personal_provider_link WHERE id = $1::uuid",
        )
        .bind(&key_id)
        .fetch_one(&su)
        .await
        .unwrap();
    assert!(revoked_at.is_some() && revoked_by.is_none());
    // And the revocation still cannot be undone.
    let undone =
        sqlx::query("UPDATE personal_provider_link SET revoked_at = NULL WHERE id = $1::uuid")
            .bind(&key_id)
            .execute(&su)
            .await;
    assert!(undone.is_err(), "a revoked key was un-revoked");
}
