//! #1768 — ADR-0128 D2/D3 member lifecycle against real Postgres.
//!
//! Actor (owner/admin/member/guest/self) × path matrix, last-owner protection,
//! suspend→login 403, ban→join 403, reinstate, RLS, audit rows.
//!
//! `#[ignore]` — needs a real Postgres. Gate PG is the 15432 convention:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test membership_lifecycle_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "membership-lifecycle-conformance-secret";
const OWNER_PASSWORD: &str = "owner-lifecycle-password";
const OWNER_B_PASSWORD: &str = "owner-b-lifecycle-password";
const ADMIN_PASSWORD: &str = "admin-lifecycle-password";
const ADMIN_B_PASSWORD: &str = "admin-b-lifecycle-password";
const MEMBER_PASSWORD: &str = "member-lifecycle-password";
const MEMBER_B_PASSWORD: &str = "member-b-lifecycle-password";
const GUEST_PASSWORD: &str = "guest-lifecycle-password";
const GUEST_B_PASSWORD: &str = "guest-b-lifecycle-password";
const JOIN_PASSWORD: &str = "join-lifecycle-password";

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

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let options = options
        .username("momo_app")
        .password(&role_password("momo_app", "MOMO_APP_PASSWORD"));
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
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
    );
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

struct MatrixTenant {
    workspace: Uuid,
    channel: Uuid,
    owner: Person,
    owner_other: Person,
    admin: Person,
    admin_other: Person,
    member: Person,
    member_other: Person,
    guest: Person,
    guest_other: Person,
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
    let email = format!("{id}@lifecycle.test");
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

async fn seed_channel_membership(
    su: &PgPool,
    workspace: Uuid,
    channel: Uuid,
    member: Uuid,
    role: &str,
) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, $4::membership_role)",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .bind(role)
    .execute(su)
    .await
    .expect("seed channel membership");
}

async fn seed_public_channel(su: &PgPool, workspace: Uuid, created_by: Uuid) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', 'general', 'Team general channel', $3)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(created_by)
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");
    channel
}

async fn seed_matrix_tenant(su: &PgPool, slug_hint: &str) -> MatrixTenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{slug_hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let owner = seed_human(su, workspace, "owner", "owner", OWNER_PASSWORD).await;
    let owner_other = seed_human(su, workspace, "owner-b", "owner", OWNER_B_PASSWORD).await;
    let admin = seed_human(su, workspace, "admin", "admin", ADMIN_PASSWORD).await;
    let admin_other = seed_human(su, workspace, "admin-b", "admin", ADMIN_B_PASSWORD).await;
    let member = seed_human(su, workspace, "member", "member", MEMBER_PASSWORD).await;
    let member_other = seed_human(su, workspace, "member-b", "member", MEMBER_B_PASSWORD).await;
    let guest = seed_human(su, workspace, "guest", "guest", GUEST_PASSWORD).await;
    let guest_other = seed_human(su, workspace, "guest-b", "guest", GUEST_B_PASSWORD).await;
    let channel = seed_public_channel(su, workspace, owner.id).await;
    for (person, role) in [
        (&owner, "owner"),
        (&owner_other, "owner"),
        (&admin, "admin"),
        (&admin_other, "admin"),
        (&member, "member"),
        (&member_other, "member"),
        (&guest, "guest"),
        (&guest_other, "guest"),
    ] {
        seed_channel_membership(su, workspace, channel, person.id, role).await;
    }
    MatrixTenant {
        workspace,
        channel,
        owner,
        owner_other,
        admin,
        admin_other,
        member,
        member_other,
        guest,
        guest_other,
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

fn target_id(tenant: &MatrixTenant, actor_role: &str, target_role: &str) -> Uuid {
    if target_role == "self" {
        matrix_person(tenant, actor_role).id
    } else if actor_role == target_role {
        matrix_person(tenant, &format!("{target_role}_other")).id
    } else {
        matrix_person(tenant, target_role).id
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

async fn access_token(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    person: &Person,
) -> String {
    let (status, body) = login(http, base, workspace, &person.email, &person.password).await;
    assert_eq!(status, 200, "matrix actor must login: {body}");
    body["accessToken"].as_str().expect("access").to_string()
}

fn error_message(body: &Value) -> &str {
    body["error"]["message"].as_str().unwrap_or("")
}

async fn send(builder: reqwest::RequestBuilder) -> (u16, Value) {
    let response = builder.send().await.expect("request");
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(json!({}));
    (status, body)
}

enum PathKind {
    WorkspaceRole,
    ChannelRole,
    Suspend,
    Remove,
    CreateBan,
    ListBans,
}

fn expected_admin_path(actor: &str, target: &str) -> u16 {
    match (actor, target) {
        ("owner", "self") | ("admin", "self") => 403,
        ("owner", "owner") | ("admin", "owner") | ("admin", "admin") => 403,
        ("owner", "admin") | ("owner", "member") | ("owner", "guest") => 200,
        ("admin", "member") | ("admin", "guest") => 200,
        ("member", _) | ("guest", _) => 403,
        _ => panic!("unspecified cell {actor} -> {target}"),
    }
}

fn expected_ban_path(actor: &str) -> u16 {
    match actor {
        "owner" | "admin" => 201,
        "member" | "guest" => 403,
        _ => panic!("unspecified ban actor {actor}"),
    }
}

fn expected_list_bans(actor: &str) -> u16 {
    match actor {
        "owner" | "admin" => 200,
        "member" | "guest" => 403,
        _ => panic!("unspecified list actor {actor}"),
    }
}

async fn matrix_cell(kind: PathKind, actor_role: &str, target_role: &str) -> (u16, Value) {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_matrix_tenant(
        &su,
        &format!("mx-{actor_role}-{target_role}-{}", path_label(&kind)),
    )
    .await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let actor = matrix_person(&tenant, actor_role);
    let access = access_token(&http, &base, tenant.workspace, actor).await;
    let target = target_id(&tenant, actor_role, target_role);
    match kind {
        PathKind::WorkspaceRole => {
            send(
                http.patch(format!(
                    "{base}/v1/workspaces/{}/members/{target}/role",
                    tenant.workspace
                ))
                .bearer_auth(access)
                .json(&json!({ "role": "guest" })),
            )
            .await
        }
        PathKind::ChannelRole => {
            send(
                http.patch(format!(
                    "{base}/v1/workspaces/{}/channels/{}/members/{target}/role",
                    tenant.workspace, tenant.channel
                ))
                .bearer_auth(access)
                .json(&json!({ "role": "guest" })),
            )
            .await
        }
        PathKind::Suspend => {
            send(
                http.post(format!(
                    "{base}/v1/workspaces/{}/members/{target}/suspend",
                    tenant.workspace
                ))
                .bearer_auth(access),
            )
            .await
        }
        PathKind::Remove => {
            send(
                http.delete(format!(
                    "{base}/v1/workspaces/{}/members/{target}",
                    tenant.workspace
                ))
                .bearer_auth(access),
            )
            .await
        }
        PathKind::CreateBan => {
            send(
                http.post(format!("{base}/v1/workspaces/{}/bans", tenant.workspace))
                    .bearer_auth(access)
                    .json(&json!({ "email": format!("{target}@ban.test") })),
            )
            .await
        }
        PathKind::ListBans => {
            send(
                http.get(format!("{base}/v1/workspaces/{}/bans", tenant.workspace))
                    .bearer_auth(access),
            )
            .await
        }
    }
}

fn path_label(kind: &PathKind) -> &'static str {
    match kind {
        PathKind::WorkspaceRole => "wsrole",
        PathKind::ChannelRole => "chrole",
        PathKind::Suspend => "suspend",
        PathKind::Remove => "remove",
        PathKind::CreateBan => "ban",
        PathKind::ListBans => "listban",
    }
}

fn assert_forbidden_message(body: &Value) {
    let message = error_message(body);
    assert!(
        message == "workspace admin required"
            || message == "not an active workspace member"
            || message == "members cannot manage themselves"
            || message == "cannot manage an equal or higher role"
            || message == "admins cannot grant admin or owner"
            || message == "channel admin required"
            || message == "membership management requires a human member",
        "403 must use the Swift closed set: {body}"
    );
}

macro_rules! matrix_cell_test {
    ($name:ident, $kind:expr, $actor:expr, $target:expr, $expected:expr) => {
        #[tokio::test]
        #[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
        async fn $name() {
            let (status, body) = matrix_cell($kind, $actor, $target).await;
            assert_eq!(status, $expected, "{} -> {}: {body}", $actor, $target);
            if $expected == 403 {
                assert_forbidden_message(&body);
            }
        }
    };
}

// Workspace role — requested role is always guest so admin grant check passes.
matrix_cell_test!(
    wsrole_owner_owner,
    PathKind::WorkspaceRole,
    "owner",
    "owner",
    403
);
matrix_cell_test!(
    wsrole_owner_admin,
    PathKind::WorkspaceRole,
    "owner",
    "admin",
    200
);
matrix_cell_test!(
    wsrole_owner_member,
    PathKind::WorkspaceRole,
    "owner",
    "member",
    200
);
matrix_cell_test!(
    wsrole_owner_guest,
    PathKind::WorkspaceRole,
    "owner",
    "guest",
    200
);
matrix_cell_test!(
    wsrole_owner_self,
    PathKind::WorkspaceRole,
    "owner",
    "self",
    403
);
matrix_cell_test!(
    wsrole_admin_owner,
    PathKind::WorkspaceRole,
    "admin",
    "owner",
    403
);
matrix_cell_test!(
    wsrole_admin_admin,
    PathKind::WorkspaceRole,
    "admin",
    "admin",
    403
);
matrix_cell_test!(
    wsrole_admin_member,
    PathKind::WorkspaceRole,
    "admin",
    "member",
    200
);
matrix_cell_test!(
    wsrole_admin_guest,
    PathKind::WorkspaceRole,
    "admin",
    "guest",
    200
);
matrix_cell_test!(
    wsrole_admin_self,
    PathKind::WorkspaceRole,
    "admin",
    "self",
    403
);
matrix_cell_test!(
    wsrole_member_owner,
    PathKind::WorkspaceRole,
    "member",
    "owner",
    403
);
matrix_cell_test!(
    wsrole_member_member,
    PathKind::WorkspaceRole,
    "member",
    "member",
    403
);
matrix_cell_test!(
    wsrole_member_self,
    PathKind::WorkspaceRole,
    "member",
    "self",
    403
);
matrix_cell_test!(
    wsrole_guest_member,
    PathKind::WorkspaceRole,
    "guest",
    "member",
    403
);
matrix_cell_test!(
    wsrole_guest_self,
    PathKind::WorkspaceRole,
    "guest",
    "self",
    403
);

matrix_cell_test!(
    chrole_owner_admin,
    PathKind::ChannelRole,
    "owner",
    "admin",
    200
);
matrix_cell_test!(
    chrole_admin_member,
    PathKind::ChannelRole,
    "admin",
    "member",
    200
);
matrix_cell_test!(
    chrole_admin_owner,
    PathKind::ChannelRole,
    "admin",
    "owner",
    403
);
matrix_cell_test!(
    chrole_member_guest,
    PathKind::ChannelRole,
    "member",
    "guest",
    403
);
matrix_cell_test!(
    chrole_guest_member,
    PathKind::ChannelRole,
    "guest",
    "member",
    403
);
matrix_cell_test!(
    chrole_owner_self,
    PathKind::ChannelRole,
    "owner",
    "self",
    403
);

matrix_cell_test!(
    suspend_owner_admin,
    PathKind::Suspend,
    "owner",
    "admin",
    200
);
matrix_cell_test!(
    suspend_owner_member,
    PathKind::Suspend,
    "owner",
    "member",
    200
);
matrix_cell_test!(
    suspend_owner_owner,
    PathKind::Suspend,
    "owner",
    "owner",
    403
);
matrix_cell_test!(suspend_owner_self, PathKind::Suspend, "owner", "self", 403);
matrix_cell_test!(
    suspend_admin_member,
    PathKind::Suspend,
    "admin",
    "member",
    200
);
matrix_cell_test!(
    suspend_admin_owner,
    PathKind::Suspend,
    "admin",
    "owner",
    403
);
matrix_cell_test!(
    suspend_admin_admin,
    PathKind::Suspend,
    "admin",
    "admin",
    403
);
matrix_cell_test!(
    suspend_member_guest,
    PathKind::Suspend,
    "member",
    "guest",
    403
);
matrix_cell_test!(
    suspend_guest_member,
    PathKind::Suspend,
    "guest",
    "member",
    403
);

matrix_cell_test!(
    remove_owner_member,
    PathKind::Remove,
    "owner",
    "member",
    200
);
matrix_cell_test!(remove_owner_owner, PathKind::Remove, "owner", "owner", 403);
matrix_cell_test!(remove_owner_self, PathKind::Remove, "owner", "self", 403);
matrix_cell_test!(remove_admin_guest, PathKind::Remove, "admin", "guest", 200);
matrix_cell_test!(remove_admin_owner, PathKind::Remove, "admin", "owner", 403);
matrix_cell_test!(
    remove_member_guest,
    PathKind::Remove,
    "member",
    "guest",
    403
);

matrix_cell_test!(ban_owner, PathKind::CreateBan, "owner", "member", 201);
matrix_cell_test!(ban_admin, PathKind::CreateBan, "admin", "member", 201);
matrix_cell_test!(ban_member, PathKind::CreateBan, "member", "member", 403);
matrix_cell_test!(ban_guest, PathKind::CreateBan, "guest", "member", 403);

matrix_cell_test!(listban_owner, PathKind::ListBans, "owner", "member", 200);
matrix_cell_test!(listban_admin, PathKind::ListBans, "admin", "member", 200);
matrix_cell_test!(listban_member, PathKind::ListBans, "member", "member", 403);
matrix_cell_test!(listban_guest, PathKind::ListBans, "guest", "member", 403);

#[allow(dead_code)]
fn _expected_admin_path_is_the_matrix() {
    assert_eq!(expected_admin_path("owner", "admin"), 200);
    assert_eq!(expected_ban_path("owner"), 201);
    assert_eq!(expected_list_bans("member"), 403);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn last_owner_cannot_be_demoted_suspended_or_removed() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("last-owner-{workspace}"))
        .execute(&su)
        .await
        .expect("workspace");
    let owner = seed_human(&su, workspace, "solo", "owner", OWNER_PASSWORD).await;
    let admin = seed_human(&su, workspace, "adm", "admin", ADMIN_PASSWORD).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = access_token(&http, &base, workspace, &owner).await;
    let admin_token = access_token(&http, &base, workspace, &admin).await;

    let demote = send(
        http.patch(format!(
            "{base}/v1/workspaces/{workspace}/members/{}/role",
            owner.id
        ))
        .bearer_auth(&owner_token)
        .json(&json!({ "role": "admin" })),
    )
    .await;
    assert_eq!(demote.0, 409, "{}", demote.1);
    assert_eq!(
        error_message(&demote.1),
        "workspace must retain at least one owner"
    );

    let suspend = send(
        http.post(format!(
            "{base}/v1/workspaces/{workspace}/members/{}/suspend",
            owner.id
        ))
        .bearer_auth(&admin_token),
    )
    .await;
    assert_eq!(suspend.0, 409, "{}", suspend.1);
    assert_eq!(
        error_message(&suspend.1),
        "workspace must retain at least one owner"
    );

    let remove = send(
        http.delete(format!(
            "{base}/v1/workspaces/{workspace}/members/{}",
            owner.id
        ))
        .bearer_auth(&admin_token),
    )
    .await;
    assert_eq!(remove.0, 409, "{}", remove.1);
    assert_eq!(
        error_message(&remove.1),
        "workspace must retain at least one owner"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn admin_cannot_grant_admin_or_owner() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_matrix_tenant(&su, "grant").await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let access = access_token(&http, &base, tenant.workspace, &tenant.admin).await;
    let (status, body) = send(
        http.patch(format!(
            "{base}/v1/workspaces/{}/members/{}/role",
            tenant.workspace, tenant.member.id
        ))
        .bearer_auth(access)
        .json(&json!({ "role": "admin" })),
    )
    .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(error_message(&body), "admins cannot grant admin or owner");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn suspend_blocks_login_and_reinstate_restores_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_matrix_tenant(&su, "suspend-login").await;
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
    let stale = first.1["accessToken"].as_str().expect("access").to_string();
    let owner = access_token(&http, &base, tenant.workspace, &tenant.owner).await;

    let (status, body) = send(
        http.post(format!(
            "{base}/v1/workspaces/{}/members/{}/suspend",
            tenant.workspace, tenant.member.id
        ))
        .bearer_auth(&owner),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "suspended");

    let blocked = login(
        &http,
        &base,
        tenant.workspace,
        &tenant.member.email,
        MEMBER_PASSWORD,
    )
    .await;
    assert_eq!(blocked.0, 403, "{}", blocked.1);
    assert_eq!(error_message(&blocked.1), "member is suspended");

    let roster = http
        .get(format!("{base}/v1/workspaces/{}/roster", tenant.workspace))
        .bearer_auth(&stale)
        .send()
        .await
        .expect("stale roster");
    assert_eq!(
        roster.status().as_u16(),
        401,
        "suspend must revoke live sessions"
    );

    let (reinstate, reinstate_body) = send(
        http.post(format!(
            "{base}/v1/workspaces/{}/members/{}/reinstate",
            tenant.workspace, tenant.member.id
        ))
        .bearer_auth(&owner),
    )
    .await;
    assert_eq!(reinstate, 200, "{reinstate_body}");
    assert_eq!(reinstate_body["status"], "active");
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
        200
    );

    let action: String = sqlx::query_scalar(
        "SELECT action FROM audit_log \
          WHERE workspace_id = $1 AND action = 'member.suspended' \
            AND actor_member_id = $2 AND subject_member_id = $3 \
            AND target_type = 'member' AND target_id = $3",
    )
    .bind(tenant.workspace)
    .bind(tenant.owner.id)
    .bind(tenant.member.id)
    .fetch_one(&su)
    .await
    .expect("suspend audit");
    assert_eq!(action, "member.suspended");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn ban_blocks_invite_redeem_and_is_tenant_isolated() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_matrix_tenant(&su, "ban-join").await;
    let other = seed_matrix_tenant(&su, "ban-other").await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let owner = access_token(&http, &base, tenant.workspace, &tenant.owner).await;
    let banned_email = format!("banned-{}@join.test", Uuid::new_v4());

    let created = send(
        http.post(format!("{base}/v1/workspaces/{}/bans", tenant.workspace))
            .bearer_auth(&owner)
            .json(&json!({ "email": banned_email })),
    )
    .await;
    assert_eq!(created.0, 201, "{}", created.1);
    let ban_id = created.1["ban"]["id"].as_str().expect("ban id").to_string();

    let invite = http
        .post(format!("{base}/v1/workspaces/{}/invites", tenant.workspace))
        .bearer_auth(&owner)
        .json(&json!({ "role": "member", "maxUses": 3 }))
        .send()
        .await
        .expect("invite");
    assert_eq!(invite.status().as_u16(), 201);
    let invite_body: Value = invite.json().await.expect("invite body");
    let code = invite_body["code"].as_str().expect("code");

    let join = send(http.post(format!("{base}/v1/join")).json(&json!({
        "code": code,
        "email": banned_email,
        "displayName": "Banned Joiner",
        "password": JOIN_PASSWORD,
    })))
    .await;
    assert_eq!(join.0, 403, "{}", join.1);
    assert_eq!(
        error_message(&join.1),
        "member is banned from this workspace"
    );

    let visible_here: i64 = {
        let mut tx = app_pool.begin().await.expect("begin a");
        sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
            .bind(tenant.workspace.to_string())
            .execute(&mut *tx)
            .await
            .expect("guc a");
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_ban")
            .fetch_one(&mut *tx)
            .await
            .expect("count a");
        tx.rollback().await.expect("rollback a");
        count
    };
    let visible_there: i64 = {
        let mut tx = app_pool.begin().await.expect("begin b");
        sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
            .bind(other.workspace.to_string())
            .execute(&mut *tx)
            .await
            .expect("guc b");
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_ban")
            .fetch_one(&mut *tx)
            .await
            .expect("count b");
        tx.rollback().await.expect("rollback b");
        count
    };
    assert_eq!(visible_here, 1);
    assert_eq!(visible_there, 0, "foreign tenant GUC must not see the ban");

    let other_owner = access_token(&http, &base, other.workspace, &other.owner).await;
    let foreign = send(
        http.delete(format!(
            "{base}/v1/workspaces/{}/bans/{ban_id}",
            other.workspace
        ))
        .bearer_auth(other_owner),
    )
    .await;
    assert!(
        foreign.0 == 403 || foreign.0 == 404,
        "cross-tenant ban delete must not succeed: {}",
        foreign.1
    );

    let action: String = sqlx::query_scalar(
        "SELECT action FROM audit_log \
          WHERE workspace_id = $1 AND action = 'ban.created' \
            AND actor_member_id = $2 AND target_type = 'workspace_ban'",
    )
    .bind(tenant.workspace)
    .bind(tenant.owner.id)
    .fetch_one(&su)
    .await
    .expect("ban audit");
    assert_eq!(action, "ban.created");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn channel_member_who_is_channel_admin_can_change_a_lower_label() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_matrix_tenant(&su, "ch-admin").await;
    sqlx::query(
        "UPDATE membership SET role = 'admin' \
          WHERE workspace_id = $1 AND channel_id = $2 AND member_id = $3",
    )
    .bind(tenant.workspace)
    .bind(tenant.channel)
    .bind(tenant.member.id)
    .execute(&su)
    .await
    .expect("promote channel label");
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let access = access_token(&http, &base, tenant.workspace, &tenant.member).await;
    let (status, body) = send(
        http.patch(format!(
            "{base}/v1/workspaces/{}/channels/{}/members/{}/role",
            tenant.workspace, tenant.channel, tenant.guest.id
        ))
        .bearer_auth(access)
        .json(&json!({ "role": "member" })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["scope"], "channel");
    assert_eq!(body["role"], "member");
}
