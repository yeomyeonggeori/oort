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

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_auth::{
    consume_claim_in_tx, mint_owner_claim_token, ClaimMutation, OWNER_CLAIM_TOKEN_LEN,
};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_server::config::RateLimitConfig;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

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
        "/../../../infra/e2e/bootstrap_roles.sql"
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
) -> (u16, Value) {
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/members/{target}/password-reset"
        ))
        .bearer_auth(access)
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
    issue_password_reset(&http, &base, tenant.workspace, &access, target_id).await
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
