//! #1767 — operator-issued password reset + self password change, against PG.
//!
//! Red: expired · reuse · cross-workspace token · current-password mismatch ·
//! RLS isolation · reissue invalidates the previous live token · ADR-0128 D2
//! hierarchy (admin→owner must not 201).
//! Green: reset consume + login · owner_bootstrap still works on the same
//! table · self password change rotates every session · owner may reset any
//! other human; admin may reset member/guest only; self is always 403.
//!
//! `#[ignore]` — needs a real Postgres. Run via `scripts/verify_owner_claim.sh`.

use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;

use momo_auth::{
    consume_claim_in_tx, mint_owner_claim_token, ClaimMutation, OWNER_CLAIM_TOKEN_LEN,
};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_server::config::{RateLimitConfig, T3Settings};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::util::SubscriberInitExt;
use uuid::Uuid;

#[path = "common/password_cases.rs"]
mod password_cases;

const TEST_JWT_SECRET: &str = "password-reset-conformance-secret";
const OWNER_PASSWORD: &str = "owner-conformance-password";
const OWNER_B_PASSWORD: &str = "owner-b-conformance-password";
const ADMIN_PASSWORD: &str = "admin-conformance-password";
const ADMIN_B_PASSWORD: &str = "admin-b-conformance-password";
const MEMBER_PASSWORD: &str = "member-conformance-password";
const MEMBER_B_PASSWORD: &str = "member-b-conformance-password";
const GUEST_PASSWORD: &str = "guest-conformance-password";
const GUEST_B_PASSWORD: &str = "guest-b-conformance-password";
const RESET_PASSWORD: &str = "reset-conformance-password";
const CHANGED_PASSWORD: &str = "changed-conformance-password";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn role_password(role: &str, env_key: &str) -> String {
    std::env::var(env_key).unwrap_or_else(|_| format!("{role}_dev_pw"))
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn role_pool(role: &str, env_key: &str) -> Result<PgPool, sqlx::Error> {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let options = options
        .username(role)
        .password(&role_password(role, env_key));
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
}

async fn momo_app_pool() -> PgPool {
    role_pool("momo_app", "MOMO_APP_PASSWORD")
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

fn apply_bootstrap_roles() {
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    apply_bootstrap_roles();
    *ready = true;
}

async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_rate_limit(RateLimitConfig::default());
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

/// A server with the per-member change throttle off. The rule tests below send
/// a dozen changes for one member inside a minute, which the production limit
/// (10 per member per 60 s) is there to refuse.
async fn start_server_unthrottled(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_rate_limit(RateLimitConfig {
        password_change_per_member_limit: 0,
        password_change_per_ip_limit: 0,
        ..RateLimitConfig::default()
    });
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

struct Person {
    id: Uuid,
    email: String,
    password: String,
}

struct Tenant {
    workspace: Uuid,
    owner: Person,
    member: Person,
}

async fn seed_human(
    su: &PgPool,
    workspace: Uuid,
    slug: &str,
    role: &str,
    password: &str,
) -> Person {
    let id = Uuid::new_v4();
    let handle = format!("{slug}-{}", &id.to_string()[..8]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed member");
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
    let email = format!("{id}@reset.test");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(id)
    .bind(workspace)
    .bind(&email)
    .bind(password)
    .execute(su)
    .await
    .expect("seed human");
    Person {
        id,
        email,
        password: password.to_string(),
    }
}

struct MatrixTenant {
    workspace: Uuid,
    owner: Person,
    owner_other: Person,
    admin: Person,
    admin_other: Person,
    member: Person,
    member_other: Person,
    guest: Person,
    guest_other: Person,
}

async fn seed_matrix_tenant(su: &PgPool, slug_hint: &str) -> MatrixTenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{slug_hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    MatrixTenant {
        workspace,
        owner: seed_human(su, workspace, "owner", "owner", OWNER_PASSWORD).await,
        owner_other: seed_human(su, workspace, "owner-b", "owner", OWNER_B_PASSWORD).await,
        admin: seed_human(su, workspace, "admin", "admin", ADMIN_PASSWORD).await,
        admin_other: seed_human(su, workspace, "admin-b", "admin", ADMIN_B_PASSWORD).await,
        member: seed_human(su, workspace, "member", "member", MEMBER_PASSWORD).await,
        member_other: seed_human(su, workspace, "member-b", "member", MEMBER_B_PASSWORD).await,
        guest: seed_human(su, workspace, "guest", "guest", GUEST_PASSWORD).await,
        guest_other: seed_human(su, workspace, "guest-b", "guest", GUEST_B_PASSWORD).await,
    }
}

fn matrix_person<'a>(tenant: &'a MatrixTenant, role: &str) -> &'a Person {
    match role {
        "owner" => &tenant.owner,
        "owner_other" => &tenant.owner_other,
        "admin" => &tenant.admin,
        "admin_other" => &tenant.admin_other,
        "member" => &tenant.member,
        "member_other" => &tenant.member_other,
        "guest" => &tenant.guest,
        "guest_other" => &tenant.guest_other,
        other => panic!("unknown matrix role {other}"),
    }
}

async fn issue_password_reset(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    access: &str,
    target: Uuid,
    operator_password: &str,
) -> (u16, Value) {
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/members/{target}/password-reset"
        ))
        .bearer_auth(access)
        // ADR-0215 D6: the issuing operator proves their own password.
        .json(&json!({ "currentPassword": operator_password }))
        .send()
        .await
        .expect("issue password-reset");
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(json!({}));
    (status, body)
}

/// One ADR-0128 D2 cell: login as `actor_role`, issue reset for `target_role`
/// (`self` = actor's own id; `owner` as target of an owner actor = the other owner).
async fn hierarchy_cell(actor_role: &str, target_role: &str) -> (u16, Value) {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_matrix_tenant(&su, &format!("hier-{actor_role}-{target_role}")).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let actor = matrix_person(&tenant, actor_role);
    let (login_status, login_body) = login(
        &http,
        &base,
        tenant.workspace,
        &actor.email,
        &actor.password,
    )
    .await;
    assert_eq!(
        login_status, 200,
        "matrix actor {actor_role} must login: {login_body}"
    );
    let access = login_body["accessToken"]
        .as_str()
        .expect("access")
        .to_string();
    let target_id = if target_role == "self" {
        actor.id
    } else if actor_role == target_role {
        matrix_person(&tenant, &format!("{target_role}_other")).id
    } else {
        matrix_person(&tenant, target_role).id
    };
    issue_password_reset(
        &http,
        &base,
        tenant.workspace,
        &access,
        target_id,
        &actor.password,
    )
    .await
}

async fn seed_tenant(su: &PgPool, slug_hint: &str) -> Tenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{slug_hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let owner = seed_human(su, workspace, "owner", "owner", OWNER_PASSWORD).await;
    let member = seed_human(su, workspace, "member", "member", MEMBER_PASSWORD).await;
    Tenant {
        workspace,
        owner,
        member,
    }
}

async fn login(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    email: &str,
    password: &str,
) -> (u16, Value) {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": password,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(json!({}));
    (status, body)
}

async fn post_claim(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    password: &str,
) -> (u16, Value) {
    let response = http
        .post(format!("{base}/v1/claim"))
        .json(&json!({ "token": token, "password": password }))
        .send()
        .await
        .expect("claim");
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(json!({}));
    (status, body)
}

async fn change_password(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    access: &str,
    current: &str,
    new: &str,
) -> (u16, Value) {
    let response = http
        .patch(format!(
            "{base}/v1/workspaces/{workspace}/members/me/password"
        ))
        .bearer_auth(access)
        .json(&json!({ "currentPassword": current, "newPassword": new }))
        .send()
        .await
        .expect("change password");
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(json!({}));
    (status, body)
}

async fn roster_status(http: &reqwest::Client, base: &str, workspace: Uuid, access: &str) -> u16 {
    http.get(format!("{base}/v1/workspaces/{workspace}/roster"))
        .bearer_auth(access)
        .send()
        .await
        .expect("roster")
        .status()
        .as_u16()
}

async fn seed_owner_bootstrap(
    su: &PgPool,
    expires_sql: &str,
    created_sql: &str,
) -> (Uuid, Uuid, String, String) {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("bootstrap-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let owner = Uuid::new_v4();
    let handle = format!("boot-{}", &owner.to_string()[..8]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(owner)
    .bind(workspace)
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed owner");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed membership");
    let email = format!("{owner}@boot.test");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, NULL)",
    )
    .bind(owner)
    .bind(workspace)
    .bind(&email)
    .execute(su)
    .await
    .expect("seed claim-pending human");
    let token = mint_owner_claim_token().expect("entropy");
    let insert = format!(
        "INSERT INTO credential_claim \
            (workspace_id, member_id, token_hash, expires_at, created_at, kind) \
         VALUES ($1, $2, digest($3::text, 'sha256'), {expires_sql}, {created_sql}, \
                 'owner_bootstrap')"
    );
    sqlx::query(&insert)
        .bind(workspace)
        .bind(owner)
        .bind(&token)
        .execute(su)
        .await
        .expect("seed owner_bootstrap");
    (workspace, owner, email, token)
}

async fn visible_claims(app: &PgPool, tenant: Uuid) -> i64 {
    let mut tx = app.begin().await.expect("begin");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(tenant.to_string())
        .execute(&mut *tx)
        .await
        .expect("bind GUC");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM credential_claim")
        .fetch_one(&mut *tx)
        .await
        .expect("count");
    tx.rollback().await.expect("rollback");
    count
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn owner_bootstrap_still_consumes_on_the_generalized_table() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let (workspace, _, email, token) =
        seed_owner_bootstrap(&su, "now() + interval '24 hours'", "now()").await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();

    assert_eq!(
        login(&http, &base, workspace, &email, OWNER_PASSWORD)
            .await
            .0,
        401
    );
    let (status, body) = post_claim(&http, &base, &token, OWNER_PASSWORD).await;
    assert_eq!(
        status, 200,
        "owner_bootstrap regression must still 200: {body}"
    );
    assert_eq!(
        login(&http, &base, workspace, &email, OWNER_PASSWORD)
            .await
            .0,
        200
    );
    let (reuse, _) = post_claim(&http, &base, &token, OWNER_PASSWORD).await;
    assert_eq!(reuse, 409);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn reset_issue_consume_reuse_reissue_and_cross_workspace() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su, "reset-happy").await;
    let other = seed_tenant(&su, "reset-other").await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();

    let (login_status, login_body) = login(
        &http,
        &base,
        tenant.workspace,
        &tenant.owner.email,
        &tenant.owner.password,
    )
    .await;
    assert_eq!(login_status, 200, "{login_body}");
    let access = login_body["accessToken"].as_str().expect("access");

    let issued = http
        .post(format!(
            "{base}/v1/workspaces/{}/members/{}/password-reset",
            tenant.workspace, tenant.member.id
        ))
        .bearer_auth(access)
        .json(&json!({ "currentPassword": &tenant.owner.password }))
        .send()
        .await
        .expect("issue");
    assert_eq!(issued.status().as_u16(), 201, "admin issues a reset token");
    let issued_body: Value = issued.json().await.expect("issue body");
    let token = issued_body["token"].as_str().expect("token").to_string();
    assert_eq!(token.len(), OWNER_CLAIM_TOKEN_LEN);
    assert_eq!(issued_body["kind"], json!("password_reset"));
    assert!(
        issued_body["claimPath"]
            .as_str()
            .is_some_and(|path| path == format!("/claim/{token}")),
        "claimPath must be the existing ClaimPage route: {issued_body}"
    );
    // ADR-0215 D6 (acceptance 5c): `claimPath` stays, and an absolute `claimUrl` joins it.
    assert!(
        issued_body["claimUrl"]
            .as_str()
            .is_some_and(|url| url.ends_with(&format!("/claim/{token}"))),
        "the 201 names the link as a URL too: {issued_body}"
    );
    assert!(
        issued_body["claimUrlSecure"].is_boolean(),
        "and says whether the address can be trusted to open for the reader: {issued_body}"
    );

    let first_hash: Vec<u8> = sqlx::query_scalar(
        "SELECT token_hash FROM credential_claim \
          WHERE workspace_id = $1 AND member_id = $2 \
            AND kind = 'password_reset' AND consumed_at IS NULL",
    )
    .bind(tenant.workspace)
    .bind(tenant.member.id)
    .fetch_one(&su)
    .await
    .expect("live hash");
    assert_eq!(first_hash.len(), 32);
    assert_ne!(first_hash.as_slice(), token.as_bytes());

    let reissued = http
        .post(format!(
            "{base}/v1/workspaces/{}/members/{}/password-reset",
            tenant.workspace, tenant.member.id
        ))
        .bearer_auth(access)
        .json(&json!({ "currentPassword": &tenant.owner.password }))
        .send()
        .await
        .expect("reissue");
    assert_eq!(reissued.status().as_u16(), 201);
    let reissued_body: Value = reissued.json().await.expect("reissue body");
    let new_token = reissued_body["token"]
        .as_str()
        .expect("new token")
        .to_string();
    assert_ne!(new_token, token, "reissue must mint a different raw token");

    let (stale, _) = post_claim(&http, &base, &token, RESET_PASSWORD).await;
    assert_eq!(
        stale, 409,
        "reissue must invalidate the previous live token"
    );

    let (status, body) = post_claim(&http, &base, &new_token, RESET_PASSWORD).await;
    assert_eq!(status, 200, "fresh reset token consumes: {body}");
    assert_eq!(
        login(
            &http,
            &base,
            tenant.workspace,
            &tenant.member.email,
            RESET_PASSWORD,
        )
        .await
        .0,
        200
    );
    assert_eq!(
        login(
            &http,
            &base,
            tenant.workspace,
            &tenant.member.email,
            MEMBER_PASSWORD,
        )
        .await
        .0,
        401,
        "the old password must die with the reset"
    );

    let (reuse, _) = post_claim(&http, &base, &new_token, RESET_PASSWORD).await;
    assert_eq!(reuse, 409, "single-use: consumed reset cannot be replayed");

    let foreign = with_tenant_tx(&app_pool, other.workspace, {
        let token = new_token.clone();
        move |conn| {
            Box::pin(async move {
                Ok::<_, momo_db::DbError>(
                    consume_claim_in_tx(conn, other.workspace, &token, RESET_PASSWORD).await?,
                )
            })
        }
    })
    .await
    .expect("cross-workspace consume");
    assert_eq!(
        foreign,
        ClaimMutation::NotFound,
        "a token from workspace A must not apply inside workspace B"
    );

    assert_eq!(visible_claims(&app_pool, tenant.workspace).await, 2);
    assert_eq!(
        visible_claims(&app_pool, other.workspace).await,
        0,
        "B's tenant GUC must not see A's credential_claim rows"
    );

    let member_login = login(
        &http,
        &base,
        tenant.workspace,
        &tenant.member.email,
        RESET_PASSWORD,
    )
    .await;
    let member_access = member_login.1["accessToken"]
        .as_str()
        .expect("member access");
    let forbidden = http
        .post(format!(
            "{base}/v1/workspaces/{}/members/{}/password-reset",
            tenant.workspace, tenant.owner.id
        ))
        .bearer_auth(member_access)
        .json(&json!({ "currentPassword": RESET_PASSWORD }))
        .send()
        .await
        .expect("member issue");
    assert_eq!(
        forbidden.status().as_u16(),
        403,
        "a plain member cannot issue a reset token"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_expired_reset_token_is_gone() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su, "reset-expired").await;
    let token = mint_owner_claim_token().expect("entropy");
    sqlx::query(
        "INSERT INTO credential_claim \
            (workspace_id, member_id, token_hash, expires_at, created_at, kind) \
         VALUES ($1, $2, digest($3::text, 'sha256'), \
                 now() - interval '1 second', now() - interval '2 seconds', \
                 'password_reset')",
    )
    .bind(tenant.workspace)
    .bind(tenant.member.id)
    .bind(&token)
    .execute(&su)
    .await
    .expect("seed expired reset");
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let (status, body) = post_claim(&http, &base, &token, RESET_PASSWORD).await;
    assert_eq!(status, 410, "expired reset must be 410: {body}");
    assert_eq!(
        body["claimKind"],
        json!("password_reset"),
        "the 410 names the kind of link that ran out (ADR-0215 D6): {body}"
    );
    assert_eq!(
        login(
            &http,
            &base,
            tenant.workspace,
            &tenant.member.email,
            RESET_PASSWORD,
        )
        .await
        .0,
        401,
        "an expired reset must not have set a password"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn current_password_mismatch_is_refused_and_sessions_rotate_on_change() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su, "pw-change").await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();

    let first = login(
        &http,
        &base,
        tenant.workspace,
        &tenant.member.email,
        MEMBER_PASSWORD,
    )
    .await;
    assert_eq!(first.0, 200);
    let access_a = first.1["accessToken"].as_str().expect("a").to_string();
    let second = login(
        &http,
        &base,
        tenant.workspace,
        &tenant.member.email,
        MEMBER_PASSWORD,
    )
    .await;
    let access_b = second.1["accessToken"].as_str().expect("b").to_string();

    let mismatch = http
        .patch(format!(
            "{base}/v1/workspaces/{}/members/me/password",
            tenant.workspace
        ))
        .bearer_auth(&access_a)
        .json(&json!({
            "currentPassword": "not-the-password",
            "newPassword": CHANGED_PASSWORD,
        }))
        .send()
        .await
        .expect("mismatch");
    assert_eq!(
        mismatch.status().as_u16(),
        403,
        "wrong current password must be refused"
    );
    assert_eq!(
        login(
            &http,
            &base,
            tenant.workspace,
            &tenant.member.email,
            MEMBER_PASSWORD,
        )
        .await
        .0,
        200,
        "a refused change must leave the old password standing"
    );

    let changed = http
        .patch(format!(
            "{base}/v1/workspaces/{}/members/me/password",
            tenant.workspace
        ))
        .bearer_auth(&access_a)
        .json(&json!({
            "currentPassword": MEMBER_PASSWORD,
            "newPassword": CHANGED_PASSWORD,
        }))
        .send()
        .await
        .expect("change");
    assert_eq!(changed.status().as_u16(), 200);
    let changed_body: Value = changed.json().await.expect("change body");
    let new_access = changed_body["accessToken"].as_str().expect("new access");

    let stale_a = http
        .get(format!("{base}/v1/workspaces/{}/roster", tenant.workspace))
        .bearer_auth(&access_a)
        .send()
        .await
        .expect("stale a");
    let stale_b = http
        .get(format!("{base}/v1/workspaces/{}/roster", tenant.workspace))
        .bearer_auth(&access_b)
        .send()
        .await
        .expect("stale b");
    assert_eq!(stale_a.status().as_u16(), 401, "the changing session dies");
    assert_eq!(stale_b.status().as_u16(), 401, "sibling sessions die too");

    let live = http
        .get(format!("{base}/v1/workspaces/{}/roster", tenant.workspace))
        .bearer_auth(new_access)
        .send()
        .await
        .expect("rotated session");
    assert_eq!(live.status().as_u16(), 200, "PATCH returns a live pair");
    assert_eq!(
        login(
            &http,
            &base,
            tenant.workspace,
            &tenant.member.email,
            CHANGED_PASSWORD,
        )
        .await
        .0,
        200
    );
}

/// ADR-0215 D2 (#4593) on `PATCH …/members/me/password`: the `newPassword` is
/// held to the rule (10 characters minimum, 72 bytes maximum). A refusal is a
/// coded 400 before any statement runs: the password stands and the caller's
/// session lives.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_changed_password_is_held_to_the_new_password_rule() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su, "pw-rule").await;
    let base = start_server_unthrottled(app_pool).await;
    let http = reqwest::Client::new();
    let (status, body) = login(
        &http,
        &base,
        tenant.workspace,
        &tenant.member.email,
        MEMBER_PASSWORD,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let mut access = body["accessToken"].as_str().expect("access").to_string();

    for (case, password, code) in password_cases::refused() {
        let (status, body) = change_password(
            &http,
            &base,
            tenant.workspace,
            &access,
            MEMBER_PASSWORD,
            &password,
        )
        .await;
        assert_eq!(status, 400, "{case}: {body}");
        assert_eq!(body["error"]["code"], json!(code), "{case}: {body}");
    }
    let (status, body) =
        change_password(&http, &base, tenant.workspace, &access, MEMBER_PASSWORD, "").await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"]["message"], json!("password is required"));
    assert!(
        body["error"].get("code").is_none(),
        "an empty password has never carried an error.code: {body}"
    );

    // Nothing above was applied: the session lives and the old password stands.
    assert_eq!(
        roster_status(&http, &base, tenant.workspace, &access).await,
        200,
        "a refused change revokes no session"
    );
    assert_eq!(
        login(
            &http,
            &base,
            tenant.workspace,
            &tenant.member.email,
            MEMBER_PASSWORD,
        )
        .await
        .0,
        200,
        "a refused change leaves the old password standing"
    );

    // The accepting side, chained: each new password is the next change's
    // current password, and each signs in with exactly the bytes it was set with.
    let mut current = MEMBER_PASSWORD.to_string();
    for (case, password) in password_cases::accepted() {
        let (status, body) =
            change_password(&http, &base, tenant.workspace, &access, &current, &password).await;
        assert_eq!(status, 200, "{case}: {body}");
        access = body["accessToken"]
            .as_str()
            .expect("new access")
            .to_string();
        assert_eq!(
            login(
                &http,
                &base,
                tenant.workspace,
                &tenant.member.email,
                &password,
            )
            .await
            .0,
            200,
            "{case}: the stored password signs in with the bytes it was set with"
        );
        current = password;
    }
}

/// ADR-0215 D2, the other half of the split: the password the caller *proves* is
/// not held to the new rule. An account whose password predates it — nine
/// characters, or more than 72 bytes — must still be able to change it, or the
/// people who most need to change it are the ones locked out.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_current_password_is_not_held_to_the_new_password_rule() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su, "pw-current").await;
    let base = start_server_unthrottled(app_pool).await;
    let http = reqwest::Client::new();
    let nine = "legacy-9c";
    assert_eq!(nine.chars().count(), 9);
    let over_ceiling = "L".repeat(100);
    let short = seed_human(&su, tenant.workspace, "legacy-short", "member", nine).await;
    let long = seed_human(
        &su,
        tenant.workspace,
        "legacy-long",
        "member",
        &over_ceiling,
    )
    .await;

    for (case, person, replacement) in [
        ("nine-character current password", &short, "replacement-ten"),
        ("100-character current password", &long, "replacement-chars"),
    ] {
        let (status, body) = login(
            &http,
            &base,
            tenant.workspace,
            &person.email,
            &person.password,
        )
        .await;
        assert_eq!(status, 200, "{case}: {body}");
        let access = body["accessToken"].as_str().expect("access");
        let (status, body) = change_password(
            &http,
            &base,
            tenant.workspace,
            access,
            &person.password,
            replacement,
        )
        .await;
        assert_eq!(status, 200, "{case} changes to a valid one: {body}");
        assert_eq!(
            login(&http, &base, tenant.workspace, &person.email, replacement)
                .await
                .0,
            200,
            "{case}: the replacement signs in"
        );
        assert_eq!(
            login(
                &http,
                &base,
                tenant.workspace,
                &person.email,
                &person.password
            )
            .await
            .0,
            401,
            "{case}: the old password died with the change"
        );
    }
}

/// ADR-0215 F8 made a fact (it was `[S, runtime-unverified]`): `gen_salt('bf')`
/// reads the first 72 bytes of a password and ignores the rest. That is why the
/// new-password ceiling is 72 **bytes** and why a longer password is refused
/// instead of truncated: to this database, two passwords that agree on their
/// first 72 bytes are the same password.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn bcrypt_reads_exactly_the_first_72_bytes_of_a_password() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    // (a password, the hash it was stored under, whether `momo_password_verify`
    // accepts it) — each row says what the database makes of one pair.
    let verifies = |stored: String, presented: String| {
        let su = su.clone();
        async move {
            sqlx::query_scalar::<_, bool>("SELECT momo_password_verify($1, momo_password_hash($2))")
                .bind(presented)
                .bind(stored)
                .fetch_one(&su)
                .await
                .expect("verify against a fresh hash")
        }
    };
    let seventy_two = "a".repeat(72);
    assert!(
        verifies(seventy_two.clone(), seventy_two.clone()).await,
        "control: a password verifies against its own hash"
    );
    assert!(
        verifies(format!("{seventy_two}Y"), format!("{seventy_two}X")).await,
        "byte 73 is ignored: two different passwords with one 72-byte prefix are the same password"
    );
    assert!(
        !verifies(
            format!("{}Y", "a".repeat(71)),
            format!("{}X", "a".repeat(71))
        )
        .await,
        "byte 72 counts: that is why 72 bytes, not fewer, is the ceiling"
    );
    // The ceiling is in bytes, not characters: 24 Hangul syllables are exactly
    // 72 bytes, so a 25th is ignored.
    let hangul = password_cases::NFC_HAN.repeat(24);
    assert_eq!(hangul.len(), 72);
    assert!(
        verifies(format!("{hangul}\u{D55C}"), format!("{hangul}\u{1112}")).await,
        "the 25th syllable is past byte 72 and ignored"
    );
}

/// ADR-0215 D2: login does not apply the rule. An account that exists keeps
/// signing in with the password it has — a nine-character one, and one longer
/// than the 72 bytes the rule allows a new password.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn login_does_not_apply_the_new_password_rule() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su, "pw-login").await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let nine = seed_human(&su, tenant.workspace, "login-nine", "member", "legacy-9c").await;
    let long = seed_human(
        &su,
        tenant.workspace,
        "login-long",
        "member",
        &"L".repeat(100),
    )
    .await;
    for (case, person) in [("nine characters", &nine), ("100 characters", &long)] {
        let (status, body) = login(
            &http,
            &base,
            tenant.workspace,
            &person.email,
            &person.password,
        )
        .await;
        assert_eq!(status, 200, "{case}: {body}");
        assert!(body["accessToken"].is_string(), "{case}: {body}");
    }
}

/// ADR-0215 D2 on the `password_reset` kind of `POST /v1/claim` (the first
/// owner's bootstrap is `claim_conformance_pg`'s). A refused password is a coded
/// 400 that applies nothing: the reset link stays live, the member keeps the old
/// password and the session, and the same link then takes a valid password.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_reset_claim_password_is_held_to_the_new_password_rule() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su, "reset-rule").await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();

    let (status, owner) = login(
        &http,
        &base,
        tenant.workspace,
        &tenant.owner.email,
        &tenant.owner.password,
    )
    .await;
    assert_eq!(status, 200, "{owner}");
    let (status, issued) = issue_password_reset(
        &http,
        &base,
        tenant.workspace,
        owner["accessToken"].as_str().expect("owner access"),
        tenant.member.id,
        &tenant.owner.password,
    )
    .await;
    assert_eq!(status, 201, "{issued}");
    let token = issued["token"].as_str().expect("token").to_string();
    let (status, member) = login(
        &http,
        &base,
        tenant.workspace,
        &tenant.member.email,
        MEMBER_PASSWORD,
    )
    .await;
    assert_eq!(status, 200, "{member}");
    let member_access = member["accessToken"].as_str().expect("member access");

    for (case, password, code) in password_cases::refused() {
        let (status, body) = post_claim(&http, &base, &token, &password).await;
        assert_eq!(status, 400, "{case}: {body}");
        assert_eq!(body["error"]["code"], json!(code), "{case}: {body}");
    }

    let link_live: bool = sqlx::query_scalar(
        "SELECT consumed_at IS NULL FROM credential_claim \
          WHERE workspace_id = $1 AND member_id = $2 AND kind = 'password_reset' \
          ORDER BY created_at DESC LIMIT 1",
    )
    .bind(tenant.workspace)
    .bind(tenant.member.id)
    .fetch_one(&su)
    .await
    .expect("read the reset link");
    assert!(
        link_live,
        "a refused password does not spend the reset link"
    );
    assert_eq!(
        roster_status(&http, &base, tenant.workspace, member_access).await,
        200,
        "a refused reset revokes no session"
    );
    assert_eq!(
        login(
            &http,
            &base,
            tenant.workspace,
            &tenant.member.email,
            MEMBER_PASSWORD,
        )
        .await
        .0,
        200,
        "a refused reset leaves the old password standing"
    );

    let (status, body) = post_claim(&http, &base, &token, password_cases::TEN_CHARS).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        login(
            &http,
            &base,
            tenant.workspace,
            &tenant.member.email,
            password_cases::TEN_CHARS,
        )
        .await
        .0,
        200
    );
    assert_eq!(
        roster_status(&http, &base, tenant.workspace, member_access).await,
        401,
        "the reset that went through ended the old session"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn password_change_rate_limit_is_per_member() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su, "pw-limit").await;
    let state = AppState::new(
        app_pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_rate_limit(RateLimitConfig {
        password_change_per_member_limit: 2,
        password_change_per_ip_limit: 0,
        ..RateLimitConfig::default()
    });
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let base = format!("http://{address}");
    let http = reqwest::Client::new();
    let (status, body) = login(
        &http,
        &base,
        tenant.workspace,
        &tenant.member.email,
        MEMBER_PASSWORD,
    )
    .await;
    assert_eq!(status, 200);
    let access = body["accessToken"].as_str().expect("access");
    let guess = || {
        let http = http.clone();
        let base = base.clone();
        let access = access.to_string();
        let workspace = tenant.workspace;
        async move {
            http.patch(format!(
                "{base}/v1/workspaces/{workspace}/members/me/password"
            ))
            .bearer_auth(access)
            .json(&json!({
                "currentPassword": "wrong",
                "newPassword": "also-wrong-but-different",
            }))
            .send()
            .await
            .expect("guess")
        }
    };
    assert_eq!(guess().await.status().as_u16(), 403);
    assert_eq!(guess().await.status().as_u16(), 403);
    assert_eq!(guess().await.status().as_u16(), 429);
}

/// The change route counts an attempt **before** it judges the new password
/// (ADR-0215 D2, #4593 security review L-2): a refused `newPassword` is an
/// attempt too, so the per-member limit sees it. The order is rate limit, then
/// the two password checks, then `current == new`.
///
/// `password_change_rate_limit_is_per_member` above sends a `newPassword` the
/// rule accepts, so it cannot tell the order: a route that judged the password
/// first would never count a refusal, and this is the test that notices.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_refused_new_password_is_counted_by_the_change_rate_limit() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su, "pw-limit-order").await;
    let state = AppState::new(
        app_pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_rate_limit(RateLimitConfig {
        password_change_per_member_limit: 2,
        password_change_per_ip_limit: 0,
        ..RateLimitConfig::default()
    });
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let base = format!("http://{address}");
    let http = reqwest::Client::new();
    let (status, body) = login(
        &http,
        &base,
        tenant.workspace,
        &tenant.member.email,
        MEMBER_PASSWORD,
    )
    .await;
    assert_eq!(status, 200);
    let access = body["accessToken"].as_str().expect("access");
    // The right current password and a new one the rule refuses, so the only
    // thing wrong with the request is the new password.
    let refused = || {
        let http = http.clone();
        let base = base.clone();
        let access = access.to_string();
        let workspace = tenant.workspace;
        async move {
            let response = http
                .patch(format!(
                    "{base}/v1/workspaces/{workspace}/members/me/password"
                ))
                .bearer_auth(access)
                .json(&json!({
                    "currentPassword": MEMBER_PASSWORD,
                    "newPassword": password_cases::NINE_CHARS,
                }))
                .send()
                .await
                .expect("change");
            let status = response.status().as_u16();
            let body: Value = response.json().await.unwrap_or(Value::Null);
            (status, body)
        }
    };
    for attempt in 1..=2 {
        let (status, body) = refused().await;
        assert_eq!(status, 400, "attempt {attempt}: {body}");
        assert_eq!(
            body["error"]["code"],
            json!("password_too_short"),
            "attempt {attempt}: {body}"
        );
    }
    let (status, body) = refused().await;
    assert_eq!(
        status, 429,
        "the two refusals above were attempts, so the third is over the limit: {body}"
    );
}

/// ADR-0128 D2 matrix: each cell is one ignored PG test (red proof first).
macro_rules! hierarchy_cell_test {
    ($name:ident, $actor:expr, $target:expr, $expected:expr) => {
        #[tokio::test]
        #[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
        async fn $name() {
            let (status, body) = hierarchy_cell($actor, $target).await;
            assert_eq!(status, $expected, "{} -> {}: {body}", $actor, $target);
            if $expected == 403 {
                let message = body["error"]["message"].as_str().unwrap_or("");
                assert!(
                    message == "workspace admin required"
                        || message == "password reset not permitted"
                        || message == "not a workspace member",
                    "403 must use the closed ErrorResponse set, no raw role: {body}"
                );
            }
        }
    };
}

hierarchy_cell_test!(hierarchy_owner_resets_other_owner, "owner", "owner", 201);
hierarchy_cell_test!(hierarchy_owner_resets_admin, "owner", "admin", 201);
hierarchy_cell_test!(hierarchy_owner_resets_member, "owner", "member", 201);
hierarchy_cell_test!(hierarchy_owner_resets_guest, "owner", "guest", 201);
hierarchy_cell_test!(hierarchy_owner_cannot_reset_self, "owner", "self", 403);

hierarchy_cell_test!(hierarchy_admin_cannot_reset_owner, "admin", "owner", 403);
hierarchy_cell_test!(hierarchy_admin_cannot_reset_admin, "admin", "admin", 403);
hierarchy_cell_test!(hierarchy_admin_resets_member, "admin", "member", 201);
hierarchy_cell_test!(hierarchy_admin_resets_guest, "admin", "guest", 201);
hierarchy_cell_test!(hierarchy_admin_cannot_reset_self, "admin", "self", 403);

hierarchy_cell_test!(hierarchy_member_cannot_reset_owner, "member", "owner", 403);
hierarchy_cell_test!(hierarchy_member_cannot_reset_admin, "member", "admin", 403);
hierarchy_cell_test!(
    hierarchy_member_cannot_reset_member,
    "member",
    "member",
    403
);
hierarchy_cell_test!(hierarchy_member_cannot_reset_guest, "member", "guest", 403);
hierarchy_cell_test!(hierarchy_member_cannot_reset_self, "member", "self", 403);

hierarchy_cell_test!(hierarchy_guest_cannot_reset_owner, "guest", "owner", 403);
hierarchy_cell_test!(hierarchy_guest_cannot_reset_admin, "guest", "admin", 403);
hierarchy_cell_test!(hierarchy_guest_cannot_reset_member, "guest", "member", 403);
hierarchy_cell_test!(hierarchy_guest_cannot_reset_guest, "guest", "guest", 403);
hierarchy_cell_test!(hierarchy_guest_cannot_reset_self, "guest", "self", 403);

// ===========================================================================
// #4596 — the operator's reissue (ADR-0215 D6) and the end of a pending link (D4)
// ===========================================================================

const WRONG_OPERATOR_PASSWORD: &str = "not-the-operators-password";

/// A rate-limit config with the reissue budget at `limit`. The member-change throttle is off
/// too: the scenes below change a member's password a few times inside a minute.
fn reissue_rate(limit: u32) -> RateLimitConfig {
    RateLimitConfig {
        password_reset_issue_per_admin_limit: limit,
        password_change_per_member_limit: 0,
        password_change_per_ip_limit: 0,
        ..RateLimitConfig::default()
    }
}

async fn start_server_with(pool: PgPool, rate: RateLimitConfig, t3: Option<T3Settings>) -> String {
    let mut state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_rate_limit(rate);
    if let Some(settings) = t3 {
        state = state.with_t3(settings);
    }
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

async fn access_of(http: &reqwest::Client, base: &str, workspace: Uuid, who: &Person) -> String {
    let (status, body) = login(http, base, workspace, &who.email, &who.password).await;
    assert_eq!(status, 200, "{} must sign in: {body}", who.email);
    body["accessToken"].as_str().expect("access").to_string()
}

fn reset_url(base: &str, workspace: Uuid, target: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/members/{target}/password-reset")
}

/// The operator's request with their own password in the body.
async fn issue_as(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    access: &str,
    target: Uuid,
    password: &str,
) -> reqwest::Response {
    http.post(reset_url(base, workspace, target))
        .bearer_auth(access)
        .json(&json!({ "currentPassword": password }))
        .send()
        .await
        .expect("issue as the operator")
}

/// A link issued properly: the raw token.
async fn issue_link(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    operator: &(String, &str),
    target: Uuid,
) -> String {
    let response = issue_as(http, base, workspace, &operator.0, target, operator.1).await;
    assert_eq!(response.status().as_u16(), 201, "the link is issued");
    let body: Value = response.json().await.expect("issue body");
    body["token"].as_str().expect("token").to_string()
}

async fn live_reset_hashes(su: &PgPool, workspace: Uuid, member: Uuid) -> Vec<Vec<u8>> {
    sqlx::query_scalar(
        "SELECT token_hash FROM credential_claim \
          WHERE workspace_id = $1 AND member_id = $2 \
            AND kind = 'password_reset' AND consumed_at IS NULL",
    )
    .bind(workspace)
    .bind(member)
    .fetch_all(su)
    .await
    .expect("live reset hashes")
}

async fn audit_details(su: &PgPool, workspace: Uuid, action: &str) -> Vec<Value> {
    sqlx::query_scalar("SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = $2")
        .bind(workspace)
        .bind(action)
        .fetch_all(su)
        .await
        .expect("audit rows")
}

/// ADR-0215 D6, acceptance 4b / 4b′ / 4d: the issue asks for the **operator's own** password.
/// Nothing usable sent is one 400 (not the extractor's 415 / 422); a wrong one is a 403 that
/// changes nothing — the previous live link is the same row, no issue audit row is written, and
/// exactly one refusal row records it (never a value the caller sent); a plain member is turned
/// away by the ladder, not by the password, and leaves no refusal row.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_issue_asks_for_the_operators_own_password_and_a_refusal_changes_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su, "reissue-confirm").await;
    let base = start_server_with(app_pool, reissue_rate(10_000), None).await;
    let http = reqwest::Client::new();
    let owner = access_of(&http, &base, tenant.workspace, &tenant.owner).await;
    let url = reset_url(&base, tenant.workspace, tenant.member.id);

    // A proper issue first: the live link every refusal below must leave alone.
    let operator = (owner.clone(), tenant.owner.password.as_str());
    let live_token = issue_link(&http, &base, tenant.workspace, &operator, tenant.member.id).await;
    let hashes_before = live_reset_hashes(&su, tenant.workspace, tenant.member.id).await;
    assert_eq!(hashes_before.len(), 1);
    assert_eq!(
        audit_details(&su, tenant.workspace, "member.password_reset.issued")
            .await
            .len(),
        1
    );

    // 4b — nothing usable sent: one 400 with one code, however it was not sent.
    let broken_cases = [
        ("no body", http.post(&url)),
        ("empty object", http.post(&url).json(&json!({}))),
        (
            "empty string",
            http.post(&url).json(&json!({ "currentPassword": "" })),
        ),
        (
            "wrong type",
            http.post(&url).json(&json!({ "currentPassword": 5 })),
        ),
        (
            "null",
            http.post(&url).json(&json!({ "currentPassword": null })),
        ),
        (
            "not json",
            http.post(&url)
                .header("content-type", "text/plain")
                .body("hunter2"),
        ),
        (
            "broken json",
            http.post(&url)
                .header("content-type", "application/json")
                .body("{"),
        ),
    ];
    for (label, request) in broken_cases {
        let response = request.bearer_auth(&owner).send().await.expect(label);
        assert_eq!(response.status().as_u16(), 400, "{label}");
        let body: Value = response.json().await.expect("error body");
        assert_eq!(
            body["error"]["code"],
            json!("current_password_required"),
            "{label}: {body}"
        );
    }
    let too_long = "x".repeat(1025);
    assert_eq!(
        issue_as(
            &http,
            &base,
            tenant.workspace,
            &owner,
            tenant.member.id,
            &too_long
        )
        .await
        .status()
        .as_u16(),
        400,
        "the password the operator proves is bounded like any current password"
    );
    assert_eq!(
        audit_details(&su, tenant.workspace, "member.password_reset.refused")
            .await
            .len(),
        0,
        "a request that sent no password is not a wrong password: no refusal row"
    );

    // 4b′ — a wrong password: 403, and nothing else moved.
    let wrong = issue_as(
        &http,
        &base,
        tenant.workspace,
        &owner,
        tenant.member.id,
        WRONG_OPERATOR_PASSWORD,
    )
    .await;
    assert_eq!(wrong.status().as_u16(), 403);
    let wrong_body: Value = wrong.json().await.expect("refusal body");
    assert_eq!(
        wrong_body["error"]["code"],
        json!("current_password_incorrect"),
        "{wrong_body}"
    );
    assert_eq!(
        live_reset_hashes(&su, tenant.workspace, tenant.member.id).await,
        hashes_before,
        "the previous live link is the same row it was"
    );
    assert_eq!(
        audit_details(&su, tenant.workspace, "member.password_reset.issued")
            .await
            .len(),
        1,
        "a refused request writes no issue audit row"
    );
    let refused = audit_details(&su, tenant.workspace, "member.password_reset.refused").await;
    assert_eq!(refused.len(), 1, "one refusal row records it");
    assert_eq!(
        refused[0],
        json!({
            "schema": "momo.member.password_reset.refused.v1",
            "via": "admin",
            "reason": "current_password_incorrect"
        }),
        "a refusal row is `via` and `reason`, nothing a caller sent"
    );
    // Same window, another wrong password: refused again, still one row (ADR-0215 D9).
    let again = issue_as(
        &http,
        &base,
        tenant.workspace,
        &owner,
        tenant.member.id,
        "another-wrong-password",
    )
    .await;
    assert_eq!(again.status().as_u16(), 403);
    assert_eq!(
        audit_details(&su, tenant.workspace, "member.password_reset.refused")
            .await
            .len(),
        1,
        "one refusal row per operator and window, however many wrong passwords"
    );

    // A plain member: the ladder's 403, with their own right password and with none — and no
    // refusal row, which is for a wrong *operator* password.
    let member = access_of(&http, &base, tenant.workspace, &tenant.member).await;
    for password in [Some(tenant.member.password.as_str()), None] {
        let request = http.post(&url).bearer_auth(&member);
        let response = match password {
            Some(password) => request.json(&json!({ "currentPassword": password })),
            None => request,
        }
        .send()
        .await
        .expect("member attempt");
        assert_eq!(
            response.status().as_u16(),
            403,
            "a plain member is turned away whatever the body says"
        );
    }
    assert_eq!(
        audit_details(&su, tenant.workspace, "member.password_reset.refused")
            .await
            .len(),
        1,
        "the ladder's 403 is not a wrong password"
    );

    // None of that touched the previous live link: it still opens.
    let (status, body) = post_claim(&http, &base, &live_token, RESET_PASSWORD).await;
    assert_eq!(status, 200, "the link a refused issue left alone: {body}");
}

/// ADR-0215 D6 / D2 (acceptance 1f, 4d): the password the operator *proves* is not held to the
/// rule for a password they *choose* — an operator whose password predates the rule can still issue.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_operator_whose_password_predates_the_new_rule_can_still_issue() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su, "reissue-short").await;
    let short = seed_human(&su, tenant.workspace, "admin9", "admin", "short-pw9").await;
    assert_eq!(
        short.password.chars().count(),
        9,
        "below the 10-character rule"
    );
    let base = start_server_with(app_pool, reissue_rate(10_000), None).await;
    let http = reqwest::Client::new();
    let access = access_of(&http, &base, tenant.workspace, &short).await;
    let response = issue_as(
        &http,
        &base,
        tenant.workspace,
        &access,
        tenant.member.id,
        &short.password,
    )
    .await;
    assert_eq!(
        response.status().as_u16(),
        201,
        "a 9-character current password issues: {}",
        response.text().await.unwrap_or_default()
    );
}

/// ADR-0215 D6, acceptance 4c: the password is judged **before** the target is looked at, so a
/// wrong password cannot tell a real member from a missing one — the same 403, word for word —
/// while a proven operator does learn that a member is missing (404). Another workspace's
/// operator reaches nothing of this workspace.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_wrong_operator_password_cannot_tell_a_real_member_from_a_missing_one() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su, "reissue-oracle").await;
    let other = seed_tenant(&su, "reissue-oracle-b").await;
    let base = start_server_with(app_pool, reissue_rate(10_000), None).await;
    let http = reqwest::Client::new();
    let owner = access_of(&http, &base, tenant.workspace, &tenant.owner).await;
    let missing = Uuid::new_v4();

    let real_wrong = issue_as(
        &http,
        &base,
        tenant.workspace,
        &owner,
        tenant.member.id,
        WRONG_OPERATOR_PASSWORD,
    )
    .await;
    let missing_wrong = issue_as(
        &http,
        &base,
        tenant.workspace,
        &owner,
        missing,
        WRONG_OPERATOR_PASSWORD,
    )
    .await;
    assert_eq!(real_wrong.status().as_u16(), 403);
    assert_eq!(missing_wrong.status().as_u16(), 403);
    let (real_body, missing_body): (Value, Value) = (
        real_wrong.json().await.expect("real"),
        missing_wrong.json().await.expect("missing"),
    );
    assert_eq!(
        real_body, missing_body,
        "a wrong password answers the same for a real member and a missing one"
    );

    // Control: once the password is proven the lookup does happen, and a missing member is a 404.
    let proven_missing = issue_as(
        &http,
        &base,
        tenant.workspace,
        &owner,
        missing,
        &tenant.owner.password,
    )
    .await;
    assert_eq!(proven_missing.status().as_u16(), 404);

    // Another workspace's operator: the path says this workspace -> scope mismatch; their own
    // workspace with this workspace's member -> nothing there, and a wrong password there is the
    // same 403 as everywhere.
    let foreign = access_of(&http, &base, other.workspace, &other.owner).await;
    assert_eq!(
        issue_as(
            &http,
            &base,
            tenant.workspace,
            &foreign,
            tenant.member.id,
            &other.owner.password
        )
        .await
        .status()
        .as_u16(),
        403,
        "a bearer of another workspace is refused at the workspace scope"
    );
    assert_eq!(
        issue_as(
            &http,
            &base,
            other.workspace,
            &foreign,
            tenant.member.id,
            &other.owner.password
        )
        .await
        .status()
        .as_u16(),
        404,
        "this workspace's member does not exist in the other workspace"
    );
    assert_eq!(
        live_reset_hashes(&su, tenant.workspace, tenant.member.id)
            .await
            .len(),
        0,
        "nothing above minted a link"
    );
}

/// ADR-0215 D6, acceptance 4f: the budget is the operator's own — the sixth request in a window is
/// a 429 **even with the right password**, wrong passwords count against it as well, and another
/// operator's budget is untouched.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_operators_budget_is_per_operator_and_counts_a_right_password_too() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_matrix_tenant(&su, "reissue-budget").await;
    let base = start_server(app_pool).await; // the production default: 5 a window
    let http = reqwest::Client::new();
    let owner = access_of(&http, &base, tenant.workspace, &tenant.owner).await;
    let other_owner = access_of(&http, &base, tenant.workspace, &tenant.owner_other).await;
    let admin = access_of(&http, &base, tenant.workspace, &tenant.admin).await;

    for attempt in 1..=5 {
        let response = issue_as(
            &http,
            &base,
            tenant.workspace,
            &owner,
            tenant.member.id,
            &tenant.owner.password,
        )
        .await;
        assert_eq!(
            response.status().as_u16(),
            201,
            "request {attempt} is inside the budget"
        );
    }
    let sixth = issue_as(
        &http,
        &base,
        tenant.workspace,
        &owner,
        tenant.member.id,
        &tenant.owner.password,
    )
    .await;
    assert_eq!(
        sixth.status().as_u16(),
        429,
        "the sixth request is over budget even with the right password"
    );
    let retry_after: u64 = sixth
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .expect("a 429 says when to come back");
    assert!(retry_after > 0 && retry_after <= 60, "{retry_after}");
    assert_eq!(
        issue_as(
            &http,
            &base,
            tenant.workspace,
            &owner,
            tenant.member.id,
            WRONG_OPERATOR_PASSWORD
        )
        .await
        .status()
        .as_u16(),
        429,
        "once the budget is spent, the budget answers — not the password"
    );

    // Another operator's budget is their own.
    assert_eq!(
        issue_as(
            &http,
            &base,
            tenant.workspace,
            &other_owner,
            tenant.member.id,
            &tenant.owner_other.password
        )
        .await
        .status()
        .as_u16(),
        201,
        "the other owner's budget is untouched"
    );

    // Wrong passwords are guesses and count: five of them use the admin's window up.
    for attempt in 1..=5 {
        assert_eq!(
            issue_as(
                &http,
                &base,
                tenant.workspace,
                &admin,
                tenant.member.id,
                WRONG_OPERATOR_PASSWORD
            )
            .await
            .status()
            .as_u16(),
            403,
            "guess {attempt} is inside the budget and wrong"
        );
    }
    assert_eq!(
        issue_as(
            &http,
            &base,
            tenant.workspace,
            &admin,
            tenant.member.id,
            &tenant.admin.password
        )
        .await
        .status()
        .as_u16(),
        429,
        "five wrong guesses spent the window: the right password waits too"
    );
}

/// ADR-0215 D6, acceptance 5b / 5b′ / 5c: `claimUrl` is the **configured public address** when
/// there is one — whatever `Host` the request carries — else the request's own origin; and that
/// origin is only "secure" when it is https and not loopback / a private address. `claimPath` stays.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_link_address_is_the_configured_public_one_before_the_hosts_and_says_when_it_is_local()
{
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su, "reissue-origin").await;
    let http = reqwest::Client::new();

    let issue_at = |base: String, headers: Vec<(&'static str, &'static str)>| {
        let (http, workspace, member) = (http.clone(), tenant.workspace, tenant.member.id);
        let (email, password) = (tenant.owner.email.clone(), tenant.owner.password.clone());
        async move {
            let (_, login_body) = login(&http, &base, workspace, &email, &password).await;
            let access = login_body["accessToken"]
                .as_str()
                .expect("access")
                .to_string();
            let mut request = http
                .post(reset_url(&base, workspace, member))
                .bearer_auth(access)
                .json(&json!({ "currentPassword": password }));
            for (name, value) in headers {
                request = request.header(name, value);
            }
            let response = request.send().await.expect("issue");
            assert_eq!(response.status().as_u16(), 201);
            let body: Value = response.json().await.expect("issue body");
            body
        }
    };

    // Configured: the public address wins over any Host the request carries.
    let configured = start_server_with(
        momo_app_pool().await,
        reissue_rate(10_000),
        Some(T3Settings {
            public_base_url: Some("https://oort.example.test".to_string()),
            ..T3Settings::default()
        }),
    )
    .await;
    let body = issue_at(configured, vec![("host", "evil.example")]).await;
    let token = body["token"].as_str().expect("token");
    assert_eq!(
        body["claimUrl"],
        json!(format!("https://oort.example.test/claim/{token}")),
        "the configured address, not the request's Host: {body}"
    );
    assert_eq!(body["claimUrlSecure"], json!(true), "{body}");
    assert_eq!(
        body["claimPath"],
        json!(format!("/claim/{token}")),
        "{body}"
    );

    // Not configured: the request's own origin, and the answer says when it is local.
    let plain = start_server_with(momo_app_pool().await, reissue_rate(10_000), None).await;
    let own_host = plain.trim_start_matches("http://").to_string();
    for (headers, expected_origin, secure) in [
        (vec![], format!("http://{own_host}"), false),
        (
            vec![
                ("host", "oort.example.test"),
                ("x-forwarded-proto", "https"),
            ],
            "https://oort.example.test".to_string(),
            true,
        ),
        (
            vec![("host", "oort.example.test"), ("x-forwarded-proto", "http")],
            "http://oort.example.test".to_string(),
            false,
        ),
        (
            vec![("host", "192.168.1.5"), ("x-forwarded-proto", "https")],
            "https://192.168.1.5".to_string(),
            false,
        ),
        (
            vec![("host", "localhost:3000"), ("x-forwarded-proto", "https")],
            "https://localhost:3000".to_string(),
            false,
        ),
    ] {
        let body = issue_at(plain.clone(), headers.clone()).await;
        let token = body["token"].as_str().expect("token");
        assert_eq!(
            body["claimUrl"],
            json!(format!("{expected_origin}/claim/{token}")),
            "{headers:?}: {body}"
        );
        assert_eq!(body["claimUrlSecure"], json!(secure), "{headers:?}: {body}");
    }
}

fn assert_names_no_claim_kind(case: &str, body: &Value) {
    assert!(
        body.get("claimKind").is_none() && !body.to_string().contains("claimKind"),
        "{case}: this answer must not name the kind of link: {body}"
    );
}

/// ADR-0215 D6, acceptance 5a: `claimKind` is named on the 200, the 409 and the 410 — for both
/// kinds — and on **nothing else**: the 404 (unknown token, or a member who is not active), the
/// 400s and the 429 give a caller who does not hold a spendable token nothing about the token.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn claim_kind_is_named_on_200_409_and_410_and_on_nothing_else() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su, "claim-kind").await;
    let base = start_server_with(momo_app_pool().await, reissue_rate(10_000), None).await;
    let http = reqwest::Client::new();
    let owner = (
        access_of(&http, &base, tenant.workspace, &tenant.owner).await,
        tenant.owner.password.as_str(),
    );

    // ---- password_reset ------------------------------------------------------------------
    let link = issue_link(&http, &base, tenant.workspace, &owner, tenant.member.id).await;
    let (status, body) = post_claim(&http, &base, &link, RESET_PASSWORD).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["claimKind"], json!("password_reset"), "200: {body}");
    assert!(
        body["accessToken"].is_string() && body["member"].is_object(),
        "the 200 is still the login response, with the kind added: {body}"
    );
    let (status, body) = post_claim(&http, &base, &link, RESET_PASSWORD).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["claimKind"], json!("password_reset"), "409: {body}");

    let expired_for = seed_human(&su, tenant.workspace, "expired", "member", MEMBER_PASSWORD).await;
    let expired = mint_owner_claim_token().expect("entropy");
    sqlx::query(
        "INSERT INTO credential_claim \
            (workspace_id, member_id, token_hash, expires_at, created_at, kind) \
         VALUES ($1, $2, digest($3::text, 'sha256'), \
                 now() - interval '1 second', now() - interval '2 seconds', 'password_reset')",
    )
    .bind(tenant.workspace)
    .bind(expired_for.id)
    .bind(&expired)
    .execute(&su)
    .await
    .expect("seed expired reset");
    let (status, body) = post_claim(&http, &base, &expired, RESET_PASSWORD).await;
    assert_eq!(status, 410, "{body}");
    assert_eq!(body["claimKind"], json!("password_reset"), "410: {body}");

    // ---- owner_bootstrap -----------------------------------------------------------------
    let (_, _, _, fresh) = seed_owner_bootstrap(&su, "now() + interval '24 hours'", "now()").await;
    let (status, body) = post_claim(&http, &base, &fresh, RESET_PASSWORD).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["claimKind"], json!("owner_bootstrap"), "200: {body}");
    let (status, body) = post_claim(&http, &base, &fresh, RESET_PASSWORD).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["claimKind"], json!("owner_bootstrap"), "409: {body}");
    let (_, _, _, stale) = seed_owner_bootstrap(
        &su,
        "now() - interval '1 second'",
        "now() - interval '2 seconds'",
    )
    .await;
    let (status, body) = post_claim(&http, &base, &stale, RESET_PASSWORD).await;
    assert_eq!(status, 410, "{body}");
    assert_eq!(body["claimKind"], json!("owner_bootstrap"), "410: {body}");
    let (_, has_password, _, held) =
        seed_owner_bootstrap(&su, "now() + interval '24 hours'", "now()").await;
    sqlx::query("UPDATE human SET password_hash = momo_password_hash($2) WHERE member_id = $1")
        .bind(has_password)
        .bind("already-has-a-password")
        .execute(&su)
        .await
        .expect("give the owner a password");
    let (status, body) = post_claim(&http, &base, &held, RESET_PASSWORD).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(
        body["error"]["message"],
        json!("owner already has a password"),
        "{body}"
    );
    assert_eq!(body["claimKind"], json!("owner_bootstrap"), "409: {body}");

    // ---- nothing else names it -----------------------------------------------------------
    let unknown = mint_owner_claim_token().expect("entropy");
    let (status, body) = post_claim(&http, &base, &unknown, RESET_PASSWORD).await;
    assert_eq!(status, 404, "{body}");
    assert_names_no_claim_kind("unknown token", &body);

    let inactive_for =
        seed_human(&su, tenant.workspace, "inactive", "member", MEMBER_PASSWORD).await;
    let inactive = issue_link(&http, &base, tenant.workspace, &owner, inactive_for.id).await;
    // Suspended behind the server's back, so the link is still unspent and its member is not active.
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(inactive_for.id)
        .execute(&su)
        .await
        .expect("suspend");
    let (status, body) = post_claim(&http, &base, &inactive, RESET_PASSWORD).await;
    assert_eq!(status, 404, "{body}");
    assert_names_no_claim_kind("a member who is not active", &body);

    let (status, body) = post_claim(&http, &base, "abc", RESET_PASSWORD).await;
    assert_eq!(status, 400, "{body}");
    assert_names_no_claim_kind("a malformed token", &body);
    let spare_for = seed_human(&su, tenant.workspace, "spare", "member", MEMBER_PASSWORD).await;
    let spare = issue_link(&http, &base, tenant.workspace, &owner, spare_for.id).await;
    let (status, body) = post_claim(&http, &base, &spare, "short").await;
    assert_eq!(status, 400, "{body}");
    assert_names_no_claim_kind("a refused password", &body);

    let throttled = start_server_with(
        momo_app_pool().await,
        RateLimitConfig {
            claim_per_ip_limit: 1,
            ..RateLimitConfig::default()
        },
        None,
    )
    .await;
    let mut last = (0, json!({}));
    for _ in 0..2 {
        let response = http
            .post(format!("{throttled}/v1/claim"))
            .header("x-forwarded-for", "198.51.100.77")
            .json(&json!({ "token": spare, "password": RESET_PASSWORD }))
            .send()
            .await
            .expect("claim");
        last = (
            response.status().as_u16(),
            response.json().await.unwrap_or(json!({})),
        );
    }
    assert_eq!(last.0, 429, "{}", last.1);
    assert_names_no_claim_kind("the per-address limit", &last.1);
}

/// ADR-0215 D4, acceptance 2d / 2e / 2f: a member-wide end of sessions ends the member's pending
/// reset link in the same commit — a suspension, a removal, leaving the workspace — but the
/// member's **own password change does not** (a thief who knows the password must not be able to
/// cut every link an operator issues), and an `owner_bootstrap` claim is left alone by all of it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_pending_reset_link_ends_with_the_members_sessions_but_not_with_their_own_change() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su, "link-ends").await;
    let base = start_server_with(momo_app_pool().await, reissue_rate(10_000), None).await;
    let http = reqwest::Client::new();
    let owner = (
        access_of(&http, &base, tenant.workspace, &tenant.owner).await,
        tenant.owner.password.as_str(),
    );
    let ws = tenant.workspace;

    // 2d — suspension, removal, leaving: the old link answers 409, and the row is spent.
    let suspended = seed_human(&su, ws, "to-suspend", "member", MEMBER_PASSWORD).await;
    let removed = seed_human(&su, ws, "to-remove", "member", MEMBER_PASSWORD).await;
    let leaving = seed_human(&su, ws, "to-leave", "member", MEMBER_PASSWORD).await;
    let suspended_link = issue_link(&http, &base, ws, &owner, suspended.id).await;
    let removed_link = issue_link(&http, &base, ws, &owner, removed.id).await;
    let leaving_link = issue_link(&http, &base, ws, &owner, leaving.id).await;
    for member in [suspended.id, removed.id, leaving.id] {
        assert_eq!(live_reset_hashes(&su, ws, member).await.len(), 1);
    }

    let response = http
        .post(format!(
            "{base}/v1/workspaces/{ws}/members/{}/suspend",
            suspended.id
        ))
        .bearer_auth(&owner.0)
        .send()
        .await
        .expect("suspend");
    assert_eq!(
        response.status().as_u16(),
        200,
        "{:?}",
        response.text().await
    );
    let response = http
        .delete(format!("{base}/v1/workspaces/{ws}/members/{}", removed.id))
        .bearer_auth(&owner.0)
        .send()
        .await
        .expect("remove");
    assert_eq!(
        response.status().as_u16(),
        200,
        "{:?}",
        response.text().await
    );
    let leaving_access = access_of(&http, &base, ws, &leaving).await;
    let response = http
        .delete(format!("{base}/v1/workspaces/{ws}/members/me"))
        .bearer_auth(&leaving_access)
        .send()
        .await
        .expect("leave");
    assert_eq!(
        response.status().as_u16(),
        200,
        "{:?}",
        response.text().await
    );

    for (scene, member, link) in [
        ("suspended", suspended.id, &suspended_link),
        ("removed", removed.id, &removed_link),
        ("left", leaving.id, &leaving_link),
    ] {
        assert_eq!(
            live_reset_hashes(&su, ws, member).await.len(),
            0,
            "{scene}: the pending link is spent with the sessions"
        );
        let (status, body) = post_claim(&http, &base, link, RESET_PASSWORD).await;
        assert_eq!(
            status, 409,
            "{scene}: the old link answers 'already used': {body}"
        );
    }

    // 2e — the member's own change leaves the link alone, however often it happens.
    let changer = seed_human(&su, ws, "to-change", "member", MEMBER_PASSWORD).await;
    let changer_link = issue_link(&http, &base, ws, &owner, changer.id).await;
    let mut access = access_of(&http, &base, ws, &changer).await;
    let (mut current, mut next) = (MEMBER_PASSWORD, CHANGED_PASSWORD);
    for round in 0..2 {
        let (status, body) = change_password(&http, &base, ws, &access, current, next).await;
        assert_eq!(status, 200, "change {round}: {body}");
        access = body["accessToken"]
            .as_str()
            .expect("new access")
            .to_string();
        std::mem::swap(&mut current, &mut next);
    }
    assert_eq!(
        live_reset_hashes(&su, ws, changer.id).await.len(),
        1,
        "two changes of the member's own later, the operator's link is still live"
    );
    let (status, body) = post_claim(&http, &base, &changer_link, RESET_PASSWORD).await;
    assert_eq!(
        status, 200,
        "the link a change did not end still works: {body}"
    );

    // 2f — an owner_bootstrap claim is not a reset link: nothing above ends it.
    let guarded = seed_human(&su, ws, "has-bootstrap", "member", MEMBER_PASSWORD).await;
    let bootstrap = mint_owner_claim_token().expect("entropy");
    sqlx::query(
        "INSERT INTO credential_claim \
            (workspace_id, member_id, token_hash, expires_at, created_at, kind) \
         VALUES ($1, $2, digest($3::text, 'sha256'), now() + interval '24 hours', now(), \
                 'owner_bootstrap')",
    )
    .bind(ws)
    .bind(guarded.id)
    .bind(&bootstrap)
    .execute(&su)
    .await
    .expect("seed a pending owner_bootstrap claim");
    let _ = issue_link(&http, &base, ws, &owner, guarded.id).await;
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{ws}/members/{}/suspend",
            guarded.id
        ))
        .bearer_auth(&owner.0)
        .send()
        .await
        .expect("suspend the member that also has a bootstrap claim");
    assert_eq!(
        response.status().as_u16(),
        200,
        "{:?}",
        response.text().await
    );
    assert_eq!(
        live_reset_hashes(&su, ws, guarded.id).await.len(),
        0,
        "the reset link ended"
    );
    let bootstrap_live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM credential_claim \
          WHERE workspace_id = $1 AND member_id = $2 \
            AND kind = 'owner_bootstrap' AND consumed_at IS NULL",
    )
    .bind(ws)
    .bind(guarded.id)
    .fetch_one(&su)
    .await
    .expect("bootstrap claims");
    assert_eq!(bootstrap_live, 1, "the owner_bootstrap claim is untouched");
}

/// ADR-0215 D4, acceptance 2g-1 at the level it can still be proven: every caller of the
/// member-wide end already holds the membership lock, so the old claim-vs-suspension cycle can no
/// longer be built over HTTP — but the end must still **never wait** for a claim row somebody
/// else holds (a path that does not take the membership lock, a spend in flight). Hold the link's
/// row from another connection and suspend the member: the suspension finishes at once, the held
/// link is skipped, not ended and not waited for.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_claim_row_somebody_else_holds_is_skipped_not_waited_for() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su, "link-skip").await;
    let base = start_server_with(momo_app_pool().await, reissue_rate(10_000), None).await;
    let http = reqwest::Client::new();
    let owner = (
        access_of(&http, &base, tenant.workspace, &tenant.owner).await,
        tenant.owner.password.as_str(),
    );
    let _link = issue_link(&http, &base, tenant.workspace, &owner, tenant.member.id).await;

    let mut holder = su.begin().await.expect("begin");
    sqlx::query(
        "SELECT id FROM credential_claim \
          WHERE workspace_id = $1 AND member_id = $2 \
            AND kind = 'password_reset' AND consumed_at IS NULL FOR UPDATE",
    )
    .bind(tenant.workspace)
    .bind(tenant.member.id)
    .fetch_one(&mut *holder)
    .await
    .expect("hold the link's row");

    let suspension = {
        let (http, access) = (http.clone(), owner.0.clone());
        let url = format!(
            "{base}/v1/workspaces/{}/members/{}/suspend",
            tenant.workspace, tenant.member.id
        );
        tokio::spawn(async move {
            http.post(url)
                .bearer_auth(access)
                .send()
                .await
                .expect("suspend")
                .status()
                .as_u16()
        })
    };
    let finished = tokio::time::timeout(Duration::from_secs(5), suspension).await;
    let status = match finished {
        Ok(joined) => joined.expect("the suspension task"),
        Err(_) => {
            holder.rollback().await.expect("release the row");
            panic!("the sweep waited for a claim row somebody else holds: it must SKIP LOCKED");
        }
    };
    assert_eq!(
        status, 200,
        "the suspension went through while the row was held"
    );
    assert_eq!(
        live_reset_hashes(&su, tenant.workspace, tenant.member.id)
            .await
            .len(),
        1,
        "the held link was skipped: not ended, not waited for"
    );
    holder.rollback().await.expect("release the row");
}

#[derive(Clone)]
struct LogBuffer(Arc<Mutex<Vec<u8>>>);

impl Write for LogBuffer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().expect("log buffer").extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for LogBuffer {
    type Writer = LogBuffer;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// RFC 3986 percent-encoding (unreserved characters stay literal).
fn percent_encoded(raw: &str) -> String {
    raw.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

/// Every spelling of `secret` a leak could take: as is, base64 (both alphabets) and percent-encoded.
fn spellings(secret: &str) -> Vec<String> {
    let mut all = vec![
        secret.to_string(),
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret),
        base64::engine::general_purpose::STANDARD.encode(secret),
        percent_encoded(secret),
    ];
    all.sort();
    all.dedup();
    all
}

/// The names of the secrets that appear in `haystack` in any spelling.
fn leaked<'a>(haystack: &str, secrets: &[(&'a str, &str)]) -> Vec<&'a str> {
    secrets
        .iter()
        .filter(|(_, secret)| spellings(secret).iter().any(|form| haystack.contains(form)))
        .map(|(name, _)| *name)
        .collect()
}

/// ADR-0215 D9, acceptance 10: what the operator typed, the link and the password it sets never
/// leave the server except in the one answer that hands them over. The whole path runs — a missing
/// password, a wrong one, the issue, a refused new password, the claim, a replay — and the captured
/// logs, every `audit_log` row of the workspace and every refusal body carry **none** of the
/// operator's password (right or wrong), the token, the link, or the password the claim set, in any
/// spelling. The detector is shown to see a leak: the token planted in the real capture, and every
/// secret in every spelling planted in a short stand-in, is found.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn what_the_operator_typed_and_the_link_never_leave_the_server_but_in_the_answer_that_hands_them_over(
) {
    ensure_schema_and_roles();
    let logs = Arc::new(Mutex::new(Vec::<u8>::new()));
    let _guard = tracing_subscriber::fmt()
        .with_writer(LogBuffer(logs.clone()))
        .with_max_level(tracing::Level::DEBUG)
        .set_default();

    let su = superuser_pool().await;
    let tenant = seed_tenant(&su, "reissue-leak").await;
    // Passwords that percent-encode and base64 differently from how they are typed.
    let operator_password = "op pass/with+symbols=ü";
    let wrong_password = "wrong pass/with+symbols=ü";
    let wrong_password_again = "wrong again/with+symbols=ü";
    let claimed_password = "new pass/with+symbols=ü!1";
    let operator = seed_human(
        &su,
        tenant.workspace,
        "leak-admin",
        "admin",
        operator_password,
    )
    .await;
    let base = start_server_with(momo_app_pool().await, reissue_rate(10_000), None).await;
    let http = reqwest::Client::new();
    let access = access_of(&http, &base, tenant.workspace, &operator).await;

    // Answers that must not echo anything: collected, and searched with the logs.
    let mut refusals = String::new();
    let response = http
        .post(reset_url(&base, tenant.workspace, tenant.member.id))
        .bearer_auth(&access)
        .send()
        .await
        .expect("no password");
    refusals.push_str(&response.text().await.unwrap_or_default());
    let response = issue_as(
        &http,
        &base,
        tenant.workspace,
        &access,
        tenant.member.id,
        wrong_password,
    )
    .await;
    assert_eq!(response.status().as_u16(), 403);
    refusals.push_str(&response.text().await.unwrap_or_default());
    // The window's one audit row is taken: this one is refused all the same, with no row of its own.
    let response = issue_as(
        &http,
        &base,
        tenant.workspace,
        &access,
        tenant.member.id,
        wrong_password_again,
    )
    .await;
    assert_eq!(response.status().as_u16(), 403);
    refusals.push_str(&response.text().await.unwrap_or_default());

    let response = issue_as(
        &http,
        &base,
        tenant.workspace,
        &access,
        tenant.member.id,
        operator_password,
    )
    .await;
    assert_eq!(response.status().as_u16(), 201);
    let issued: Value = response.json().await.expect("issue body");
    let token = issued["token"].as_str().expect("token").to_string();
    let claim_url = issued["claimUrl"].as_str().expect("claimUrl").to_string();

    let (status, body) = post_claim(&http, &base, &token, "short").await;
    assert_eq!(status, 400);
    refusals.push_str(&body.to_string());
    let (status, _) = post_claim(&http, &base, &token, claimed_password).await;
    assert_eq!(status, 200);
    let (status, body) = post_claim(&http, &base, &token, claimed_password).await;
    assert_eq!(status, 409);
    refusals.push_str(&body.to_string());

    let audit: String = sqlx::query_scalar(
        "SELECT coalesce(string_agg(row_to_json(a)::text, E'\\n'), '') \
           FROM audit_log a WHERE a.workspace_id = $1",
    )
    .bind(tenant.workspace)
    .fetch_one(&su)
    .await
    .expect("audit dump");
    assert!(
        audit.contains("member.password_reset.issued")
            && audit.contains("member.password_reset.refused"),
        "the dump is of the rows this path wrote"
    );
    assert_eq!(
        audit
            .matches("\"action\":\"member.password_reset.refused\"")
            .count(),
        1,
        "two wrong passwords in one window leave one audit row"
    );
    let log_text = String::from_utf8_lossy(&logs.lock().expect("logs").clone()).to_string();
    assert!(!log_text.is_empty(), "the capture saw the server run");

    // ADR-0215 D9: a refusal with no audit row is not silent. The request that sent no password and
    // the second wrong password of the window each leave one WARN line: the operator's id and a
    // reason code, and — by the leak check below — nothing the request held.
    let operator_id = operator.id.to_string();
    let warn_lines = |message: &str| -> Vec<String> {
        log_text
            .lines()
            .filter(|line| line.contains("WARN") && line.contains(message))
            .map(str::to_string)
            .collect()
    };
    let no_password = warn_lines("without a usable current password");
    assert_eq!(no_password.len(), 1, "{no_password:?}");
    assert!(
        no_password[0].contains(&operator_id)
            && no_password[0].contains("current_password_required"),
        "{}",
        no_password[0]
    );
    let again = warn_lines("refused again in this window");
    assert_eq!(again.len(), 1, "{again:?}");
    assert!(
        again[0].contains(&operator_id) && again[0].contains("current_password_incorrect"),
        "{}",
        again[0]
    );

    let secrets: [(&str, &str); 6] = [
        ("operator password", operator_password),
        ("wrong password", wrong_password),
        ("second wrong password", wrong_password_again),
        ("claim token", token.as_str()),
        ("claim link", claim_url.as_str()),
        ("claimed password", claimed_password),
    ];
    let haystack = format!("{log_text}\n{audit}\n{refusals}");
    assert_eq!(
        leaked(&haystack, &secrets),
        Vec::<&str>::new(),
        "something the operator typed, or the link, left the server outside the answer that hands it over"
    );

    // The detector can see. In the real capture: the token, planted, is found. And every secret, in
    // every spelling, is found when planted in a short stand-in (the capture is megabytes at debug
    // level, and the loop is twenty-odd scans).
    assert!(
        leaked(&format!("{haystack}\nplanted {token}"), &secrets).contains(&"claim token"),
        "a token planted in the real capture must be found"
    );
    for (name, secret) in secrets {
        for form in spellings(secret) {
            let planted = format!("an unrelated line\nplanted {form}");
            assert!(
                leaked(&planted, &secrets).contains(&name),
                "a planted {name} written as {form:?} must be found"
            );
        }
    }
}

/// The membership lock held exclusively and nothing else: a change in flight that has taken its
/// first statement and not yet finished (the same shape `session_issue_conformance_pg` uses).
async fn hold_membership_lock(
    su: &PgPool,
    workspace: Uuid,
) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = su.begin().await.expect("begin the change");
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 128))")
        .bind(workspace.to_string())
        .execute(&mut *tx)
        .await
        .expect("take the membership lock");
    tx
}

/// ADR-0215 D6 + 증보 2 K5, the placement of the operator's password check: a request that is
/// going to be refused — a wrong password, no password, a plain member — is answered while a
/// change holds the membership lock, because it never asks for the lock; one that is going to
/// succeed queues for it. (The control is what makes the first half mean something: it shows the
/// lock really is held, and that the right password is the request that waits.)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_refused_reissue_does_not_queue_behind_the_membership_lock() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su, "reissue-lock").await;
    let base = start_server_with(momo_app_pool().await, reissue_rate(10_000), None).await;
    let http = reqwest::Client::new();
    let owner = access_of(&http, &base, tenant.workspace, &tenant.owner).await;
    let member = access_of(&http, &base, tenant.workspace, &tenant.member).await;
    let url = reset_url(&base, tenant.workspace, tenant.member.id);

    let change = hold_membership_lock(&su, tenant.workspace).await;

    let within = Duration::from_millis(1500);
    let wrong = tokio::time::timeout(
        within,
        issue_as(
            &http,
            &base,
            tenant.workspace,
            &owner,
            tenant.member.id,
            WRONG_OPERATOR_PASSWORD,
        ),
    )
    .await
    .expect("a wrong password was answered without waiting for the lock");
    assert_eq!(wrong.status().as_u16(), 403);
    let nothing = tokio::time::timeout(within, http.post(&url).bearer_auth(&owner).send())
        .await
        .expect("a request with no password was answered without waiting for the lock")
        .expect("send");
    assert_eq!(nothing.status().as_u16(), 400);
    let plain_member = tokio::time::timeout(
        within,
        issue_as(
            &http,
            &base,
            tenant.workspace,
            &member,
            tenant.member.id,
            &tenant.member.password,
        ),
    )
    .await
    .expect("a plain member was answered without waiting for the lock");
    assert_eq!(plain_member.status().as_u16(), 403);

    // Control: the request that will succeed is the one that waits for the lock.
    let (control_http, control_url, control_access, control_password) = (
        http.clone(),
        url.clone(),
        owner.clone(),
        tenant.owner.password.clone(),
    );
    let mut proper = tokio::spawn(async move {
        control_http
            .post(control_url)
            .bearer_auth(control_access)
            .json(&json!({ "currentPassword": control_password }))
            .send()
            .await
            .expect("proper issue")
            .status()
            .as_u16()
    });
    assert!(
        tokio::time::timeout(within, &mut proper).await.is_err(),
        "the right password queues for the membership lock — the lock really is held"
    );
    change.rollback().await.expect("release the lock");
    assert_eq!(
        proper.await.expect("the proper issue"),
        201,
        "released, the queued request is issued"
    );
}
