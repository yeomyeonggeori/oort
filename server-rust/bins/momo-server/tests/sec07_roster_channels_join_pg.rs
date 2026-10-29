//! SEC-07 (#4245) — roster / channel list / invite-create / join assertions that
//! the retired Swift-era `scripts/verify_roster.sh`, `verify_channel_list.sh` and
//! `verify_join.sh` made and no Rust test did. Everything here goes through the
//! real HTTP router on `momo_app` (NOBYPASSRLS); fixtures are written as the
//! superuser so RLS does not hide setup.
//!
//! `#[ignore]` because it needs a real Postgres. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test sec07_roster_channels_join_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | what it pins |
//! |---|---|
//! | `roster_projection_membership_gate_and_tenant_isolation_over_http` | a `member` row without `workspace_membership` is not on the roster; the human row carries its email; an agent row never carries `baseUrl`; a no-membership token is 403; cross-tenant paths are 403 "workspace scope mismatch" in both directions; the other tenant's roster is only that tenant's rows |
//! | `channel_list_excludes_left_and_archived_and_honours_include_archived` | default list = active memberships of non-archived channels; `include_archived=true` (and the camel alias) adds archived channels with `archivedAtMs`, never a left one; every row's `workspaceId` is the requested workspace; names are returned; no-membership token 403; cross-tenant 403/isolation |
//! | `invite_create_and_regenerate_contract_and_admin_signup_chain` | default expiry is exactly 7 days; create body keys; `invite.created` audit target; `role:"owner"` is 400 with no row; regenerate revokes the old row (`revoked_by`, reason) and preserves role/max_uses of the new row, audit detail; admin-role invite makes an admin; that admin can create a member invite whose row is `created_by` the admin; the joiner can read the joined channel |
//! | `empty_password_login_is_401` | `password: ""` is 401 even for an account whose stored hash is the hash of `""` |
//! | `roster_online_is_read_from_the_transport_only_for_rows_the_viewer_may_see` | #4692: `online` is set on human rows the roster query returned and nowhere else — an agent row has no key, a guest's roster holds only people sharing a channel with them and nothing about anyone else the broker listed (an agent, a suspended member, another tenant's member, a person outside the guest's channels), and a client id the broker reported never reaches a response. Sabotage: pass `viewer_is_guest = false` to the roster query; drop the `kind != Human` guard in `apply_availability`; ask the broker for another workspace's channel |
//! | `roster_online_is_absent_not_false_when_the_broker_cannot_answer` | #4692: a broker that answers 503, an error envelope or nothing at all, and an instance with no transport credential, all return the same roster **without an `online` key on any row** — unknown is not offline. Sabotage: map `OnlineRead::Unavailable` to an empty set in `read_availability` |
//!
//! Harness contract is the same as `invite_lifecycle_conformance_pg.rs`:
//! `DATABASE_URL` connects as a superuser (migrations + `bootstrap_roles.sql`).
//! Fixture people are fictional (이도현·박서연·최민수·정하윤, `@example.test`).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use axum::extract::State as AxumState;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json as AxumJson, Router};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::EphemeralSettings;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "sec07-roster-channels-join-app-signing-secret";
const OWNER_PASSWORD: &str = "sec07-owner-password";
const MEMBER_PASSWORD: &str = "sec07-member-password";
const JOIN_PASSWORD: &str = "sec07-join-password";
const AGENT_MODEL: &str = "hermes-agent";
/// A host nobody else in the repo uses, so its presence in a roster body can
/// only come from the agent row's `base_url` column.
const AGENT_BASE_URL_SENTINEL: &str = "sec07-agent-gateway.example.test";
const COMPANY: &str = "달무리 스튜디오";

// ---------------------------------------------------------------------------
// harness (same shape as invite_lifecycle_conformance_pg.rs)
// ---------------------------------------------------------------------------

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
    let options = options.username("momo_app").password(&momo_app_password());
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
        "/../../../infra/rust/sql/bootstrap_roles.sql"
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

// ---------------------------------------------------------------------------
// fixtures (superuser → RLS bypassed)
// ---------------------------------------------------------------------------

struct Person {
    id: Uuid,
    email: String,
    handle: String,
    display: String,
}

async fn seed_workspace(su: &PgPool, slug_hint: &str) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $3)")
        .bind(workspace)
        .bind(format!("{slug_hint}-{workspace}"))
        .bind(COMPANY)
        .execute(su)
        .await
        .expect("seed workspace");
    workspace
}

/// A login-able human. `workspace_role: None` seeds the `member` + `human` rows
/// **without** a `workspace_membership` row — the state R6/R11/C10 are about.
async fn seed_person(
    su: &PgPool,
    workspace: Uuid,
    workspace_role: Option<&str>,
    display: &str,
    hint: &str,
    password: &str,
) -> Person {
    let id = Uuid::new_v4();
    let handle = format!("{hint}-{}", &id.to_string()[..8]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(display)
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed member");
    if let Some(role) = workspace_role {
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
    }
    let email = format!("{hint}-{id}@example.test");
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
        handle,
        display: display.to_string(),
    }
}

async fn seed_channel(
    su: &PgPool,
    workspace: Uuid,
    kind: &str,
    name: &str,
    topic: Option<&str>,
    created_by: Uuid,
    archived: bool,
) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by, archived_at) \
         VALUES ($1, $2, $3::channel_kind, $4, $5, $6, CASE WHEN $7 THEN now() END)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(kind)
    .bind(name)
    .bind(topic)
    .bind(created_by)
    .bind(archived)
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

async fn seed_channel_member(
    su: &PgPool,
    workspace: Uuid,
    channel: Uuid,
    member: Uuid,
    role: &str,
    left: bool,
) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role, left_at) \
         VALUES ($1, $2, $3, $4::membership_role, CASE WHEN $5 THEN now() END)",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .bind(role)
    .bind(left)
    .execute(su)
    .await
    .expect("seed channel membership");
}

/// An agent member carrying a recognisable `base_url`.
async fn seed_agent(su: &PgPool, workspace: Uuid, owner: Uuid, handle: &str) -> Uuid {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, $3, $4, 4, 50, $5)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(AGENT_MODEL)
    .bind(format!("https://{AGENT_BASE_URL_SENTINEL}/v1"))
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

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

struct Attempt {
    status: u16,
    body: Value,
}

async fn send(builder: reqwest::RequestBuilder) -> Attempt {
    let response = builder.send().await.expect("request");
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    Attempt { status, body }
}

fn error_message(body: &Value) -> &str {
    body["error"]["message"].as_str().unwrap_or("")
}

async fn try_login(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    email: &str,
    password: &str,
) -> Attempt {
    send(http.post(format!("{base}/v1/auth/login")).json(&json!({
        "email": email,
        "password": password,
        "workspace": workspace.to_string(),
    })))
    .await
}

async fn login(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    email: &str,
    password: &str,
) -> String {
    let attempt = try_login(http, base, workspace, email, password).await;
    assert_eq!(attempt.status, 200, "login must succeed: {}", attempt.body);
    attempt.body["accessToken"]
        .as_str()
        .expect("login returns an access token")
        .to_string()
}

async fn get(http: &reqwest::Client, base: &str, token: &str, path: &str) -> Attempt {
    send(http.get(format!("{base}{path}")).bearer_auth(token)).await
}

fn members(body: &Value) -> &Vec<Value> {
    body["members"].as_array().expect("members array")
}

fn row_by_id(body: &Value, id: Uuid) -> &Value {
    members(body)
        .iter()
        .find(|row| row["id"] == json!(id.to_string()))
        .unwrap_or_else(|| panic!("{id} must be on the roster: {body}"))
}

fn channel_names(body: &Value) -> Vec<String> {
    body["channels"]
        .as_array()
        .expect("channels array")
        .iter()
        .map(|channel| channel["name"].as_str().unwrap_or("<no name>").to_string())
        .collect()
}

fn channel_by_name<'a>(body: &'a Value, name: &str) -> &'a Value {
    body["channels"]
        .as_array()
        .expect("channels array")
        .iter()
        .find(|channel| channel["name"] == json!(name))
        .unwrap_or_else(|| panic!("channel {name} must be listed: {body}"))
}

// ---------------------------------------------------------------------------
// 1 — roster
// ---------------------------------------------------------------------------

/// verify_roster.sh R4, R6, R7, R11, R12, R14, R15.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn roster_projection_membership_gate_and_tenant_isolation_over_http() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;

    // Tenant A: owner 이도현, member 박서연, agent, and 최민수 who has member +
    // human rows but NO workspace_membership.
    let a_workspace = seed_workspace(&su, "sec07-roster-a").await;
    let owner = seed_person(
        &su,
        a_workspace,
        Some("owner"),
        "이도현",
        "dohyeon",
        OWNER_PASSWORD,
    )
    .await;
    let member = seed_person(
        &su,
        a_workspace,
        Some("member"),
        "박서연",
        "seoyeon",
        MEMBER_PASSWORD,
    )
    .await;
    let ghost = seed_person(&su, a_workspace, None, "최민수", "minsu", MEMBER_PASSWORD).await;
    let agent = seed_agent(&su, a_workspace, owner.id, "intern-bot").await;
    let general = seed_channel(
        &su,
        a_workspace,
        "public",
        "general",
        Some("전체 공지"),
        owner.id,
        false,
    )
    .await;
    for who in [owner.id, member.id, agent] {
        seed_channel_member(&su, a_workspace, general, who, "member", false).await;
    }

    // Tenant B: only 정하윤.
    let b_workspace = seed_workspace(&su, "sec07-roster-b").await;
    let b_owner = seed_person(
        &su,
        b_workspace,
        Some("owner"),
        "정하윤",
        "hayun",
        OWNER_PASSWORD,
    )
    .await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, a_workspace, &owner.email, OWNER_PASSWORD).await;
    let b_token = login(&http, &base, b_workspace, &b_owner.email, OWNER_PASSWORD).await;
    let ghost_token = login(&http, &base, a_workspace, &ghost.email, MEMBER_PASSWORD).await;

    // -- R4 / R6 / R7: what the roster contains ----------------------------
    let a_roster = get(
        &http,
        &base,
        &owner_token,
        &format!("/v1/workspaces/{a_workspace}/roster"),
    )
    .await;
    assert_eq!(a_roster.status, 200, "{}", a_roster.body);
    let body = &a_roster.body;
    assert_eq!(
        members(body).len(),
        3,
        "owner + member + agent, and not the member row with no workspace_membership: {body}"
    );
    assert_eq!(body["humanCount"], 2, "{body}");
    assert_eq!(body["agentCount"], 1, "{body}");
    for row in members(body) {
        assert_eq!(
            row["workspaceId"],
            json!(a_workspace.to_string()),
            "a roster row from another workspace: {body}"
        );
    }

    // R6: absent by id, by handle and by email (three independent spellings).
    let text = body.to_string();
    assert!(
        !members(body)
            .iter()
            .any(|row| row["id"] == json!(ghost.id.to_string())),
        "a member without workspace_membership must not be on the roster: {body}"
    );
    assert!(
        !text.contains(&ghost.handle) && !text.contains(&ghost.email),
        "…and not leaked through any other field: {body}"
    );

    // R4: the human row names kind, handle and email.
    let owner_row = row_by_id(body, owner.id);
    assert_eq!(owner_row["kind"], "human");
    assert_eq!(owner_row["handle"], json!(owner.handle));
    assert_eq!(owner_row["displayName"], json!(owner.display));
    assert_eq!(owner_row["email"], json!(owner.email));
    assert_eq!(owner_row["role"], "owner");
    let member_row = row_by_id(body, member.id);
    assert_eq!(member_row["email"], json!(member.email));
    assert_eq!(member_row["handle"], json!(member.handle));

    // R7: an agent row never exposes the gateway it dials.
    let agent_row = row_by_id(body, agent);
    assert_eq!(agent_row["kind"], "agent");
    assert_eq!(agent_row["agentModel"], AGENT_MODEL);
    assert!(
        agent_row.get("email").is_none(),
        "an agent has no email: {agent_row}"
    );
    assert!(
        !text.contains(AGENT_BASE_URL_SENTINEL)
            && !text.contains("baseUrl")
            && !text.contains("base_url"),
        "the roster must not carry the agent's base_url in any key or value: {body}"
    );

    // -- R11: a token whose member has no workspace_membership --------------
    let ghost_roster = get(
        &http,
        &base,
        &ghost_token,
        &format!("/v1/workspaces/{a_workspace}/roster"),
    )
    .await;
    assert_eq!(ghost_roster.status, 403, "{}", ghost_roster.body);
    assert_eq!(error_message(&ghost_roster.body), "not a workspace member");

    // -- R12 / R15: the path workspace must be the token's workspace --------
    // The message is part of the assertion: without the scope guard the request
    // would still be 403, but from the *membership* guard ("not a workspace
    // member") — a different, weaker line of defence.
    let a_into_b = get(
        &http,
        &base,
        &owner_token,
        &format!("/v1/workspaces/{b_workspace}/roster"),
    )
    .await;
    assert_eq!(a_into_b.status, 403, "{}", a_into_b.body);
    assert_eq!(error_message(&a_into_b.body), "workspace scope mismatch");
    let b_into_a = get(
        &http,
        &base,
        &b_token,
        &format!("/v1/workspaces/{a_workspace}/roster"),
    )
    .await;
    assert_eq!(b_into_a.status, 403, "{}", b_into_a.body);
    assert_eq!(error_message(&b_into_a.body), "workspace scope mismatch");

    // -- R13 / R14: the other tenant's roster is exactly its own row --------
    let b_roster = get(
        &http,
        &base,
        &b_token,
        &format!("/v1/workspaces/{b_workspace}/roster"),
    )
    .await;
    assert_eq!(b_roster.status, 200, "{}", b_roster.body);
    let b_body = &b_roster.body;
    assert_eq!(members(b_body).len(), 1, "{b_body}");
    assert_eq!(b_body["humanCount"], 1, "{b_body}");
    assert_eq!(b_body["agentCount"], 0, "{b_body}");
    assert_eq!(members(b_body)[0]["id"], json!(b_owner.id.to_string()));
    for row in members(b_body) {
        assert_eq!(
            row["workspaceId"],
            json!(b_workspace.to_string()),
            "{b_body}"
        );
    }
    let b_text = b_body.to_string();
    for foreign in [
        owner.handle.as_str(),
        owner.email.as_str(),
        member.handle.as_str(),
        AGENT_BASE_URL_SENTINEL,
    ] {
        assert!(
            !b_text.contains(foreign),
            "tenant A data ({foreign}) leaked into tenant B's roster: {b_body}"
        );
    }
}

// ---------------------------------------------------------------------------
// 2 — channel list
// ---------------------------------------------------------------------------

/// verify_channel_list.sh C4, C6–C14.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn channel_list_excludes_left_and_archived_and_honours_include_archived() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;

    let a_workspace = seed_workspace(&su, "sec07-chan-a").await;
    let owner = seed_person(
        &su,
        a_workspace,
        Some("owner"),
        "이도현",
        "dohyeon",
        OWNER_PASSWORD,
    )
    .await;
    let ghost = seed_person(&su, a_workspace, None, "최민수", "minsu", MEMBER_PASSWORD).await;
    // Seeded in an order that is not the expected output order.
    let general = seed_channel(
        &su,
        a_workspace,
        "public",
        "general",
        Some("전체 공지"),
        owner.id,
        false,
    )
    .await;
    let lab = seed_channel(
        &su,
        a_workspace,
        "public",
        "agent-lab",
        Some("에이전트 실험실"),
        owner.id,
        false,
    )
    .await;
    let left = seed_channel(
        &su,
        a_workspace,
        "public",
        "left-room",
        None,
        owner.id,
        false,
    )
    .await;
    let archived = seed_channel(
        &su,
        a_workspace,
        "public",
        "archived-room",
        None,
        owner.id,
        true,
    )
    .await;
    let archived_left = seed_channel(
        &su,
        a_workspace,
        "public",
        "archived-left-room",
        None,
        owner.id,
        true,
    )
    .await;
    // The owner never joined this one.
    let hidden = seed_channel(
        &su,
        a_workspace,
        "private",
        "hidden-room",
        None,
        owner.id,
        false,
    )
    .await;
    for (channel, left_at) in [
        (general, false),
        (lab, false),
        (left, true),
        (archived, false),
        (archived_left, true),
    ] {
        seed_channel_member(&su, a_workspace, channel, owner.id, "member", left_at).await;
    }

    let b_workspace = seed_workspace(&su, "sec07-chan-b").await;
    let b_owner = seed_person(
        &su,
        b_workspace,
        Some("owner"),
        "정하윤",
        "hayun",
        OWNER_PASSWORD,
    )
    .await;
    let b_general = seed_channel(
        &su,
        b_workspace,
        "public",
        "b-general",
        Some("정하윤의 채널"),
        b_owner.id,
        false,
    )
    .await;
    seed_channel_member(&su, b_workspace, b_general, b_owner.id, "member", false).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, a_workspace, &owner.email, OWNER_PASSWORD).await;
    let b_token = login(&http, &base, b_workspace, &b_owner.email, OWNER_PASSWORD).await;
    let ghost_token = login(&http, &base, a_workspace, &ghost.email, MEMBER_PASSWORD).await;
    let list_path = format!("/v1/workspaces/{a_workspace}/channels");

    // -- C7 (+C4, C6): default list ---------------------------------------
    let default = get(&http, &base, &token, &list_path).await;
    assert_eq!(default.status, 200, "{}", default.body);
    assert_eq!(
        channel_names(&default.body),
        vec!["agent-lab".to_string(), "general".to_string()],
        "only active memberships of non-archived channels, public group by name: {}",
        default.body
    );
    for channel in default.body["channels"].as_array().unwrap() {
        assert_eq!(
            channel["workspaceId"],
            json!(a_workspace.to_string()),
            "{channel}"
        );
        assert_eq!(channel["kind"], "public", "{channel}");
        assert!(
            channel.get("archivedAtMs").is_none(),
            "a live channel has no archivedAtMs: {channel}"
        );
    }
    assert_eq!(
        channel_by_name(&default.body, "general")["id"],
        json!(general.to_string())
    );
    assert_eq!(
        channel_by_name(&default.body, "agent-lab")["topic"],
        "에이전트 실험실"
    );
    let default_text = default.body.to_string();
    for absent in [left, archived, archived_left, hidden] {
        assert!(
            !default_text.contains(&absent.to_string()),
            "{absent} must not be in the default list: {}",
            default.body
        );
    }

    // -- C8 / C9: include_archived ----------------------------------------
    for query in ["include_archived=true", "includeArchived=true"] {
        let with = get(&http, &base, &token, &format!("{list_path}?{query}")).await;
        assert_eq!(with.status, 200, "{query}: {}", with.body);
        assert_eq!(
            channel_names(&with.body),
            vec![
                "agent-lab".to_string(),
                "archived-room".to_string(),
                "general".to_string()
            ],
            "{query}: archived joins the list; left channels (archived or not) never do: {}",
            with.body
        );
        for channel in with.body["channels"].as_array().unwrap() {
            assert_eq!(
                channel["workspaceId"],
                json!(a_workspace.to_string()),
                "{channel}"
            );
        }
        let archived_row = channel_by_name(&with.body, "archived-room");
        assert!(
            archived_row["archivedAtMs"]
                .as_i64()
                .is_some_and(|ms| ms > 0),
            "{query}: an archived channel reports archivedAtMs: {archived_row}"
        );
        assert!(channel_by_name(&with.body, "general")
            .get("archivedAtMs")
            .is_none());
        let text = with.body.to_string();
        for absent in [left, archived_left, hidden] {
            assert!(
                !text.contains(&absent.to_string()),
                "{query}: {absent} leaked: {text}"
            );
        }
    }
    // Only the literal "true" opts in (`ChannelListQuery::include_archived`).
    let not_true = get(
        &http,
        &base,
        &token,
        &format!("{list_path}?include_archived=1"),
    )
    .await;
    assert_eq!(not_true.status, 200, "{}", not_true.body);
    assert_eq!(
        channel_names(&not_true.body),
        vec!["agent-lab".to_string(), "general".to_string()],
        "include_archived=1 is not the literal true: {}",
        not_true.body
    );

    // -- C10: no workspace_membership -------------------------------------
    let ghost_list = get(&http, &base, &ghost_token, &list_path).await;
    assert_eq!(ghost_list.status, 403, "{}", ghost_list.body);
    assert_eq!(error_message(&ghost_list.body), "not a workspace member");

    // -- C11 / C14: path workspace must be the token's --------------------
    let a_into_b = get(
        &http,
        &base,
        &token,
        &format!("/v1/workspaces/{b_workspace}/channels"),
    )
    .await;
    assert_eq!(a_into_b.status, 403, "{}", a_into_b.body);
    assert_eq!(error_message(&a_into_b.body), "workspace scope mismatch");
    let b_into_a = get(&http, &base, &b_token, &list_path).await;
    assert_eq!(b_into_a.status, 403, "{}", b_into_a.body);
    assert_eq!(error_message(&b_into_a.body), "workspace scope mismatch");

    // -- C12 / C13: the other tenant sees exactly its own channel ---------
    let b_list = get(
        &http,
        &base,
        &b_token,
        &format!("/v1/workspaces/{b_workspace}/channels?include_archived=true"),
    )
    .await;
    assert_eq!(b_list.status, 200, "{}", b_list.body);
    assert_eq!(
        channel_names(&b_list.body),
        vec!["b-general".to_string()],
        "{}",
        b_list.body
    );
    let b_row = &b_list.body["channels"][0];
    assert_eq!(b_row["workspaceId"], json!(b_workspace.to_string()));
    assert_eq!(b_row["id"], json!(b_general.to_string()));
    let b_text = b_list.body.to_string();
    for foreign in [general, lab, left, archived, archived_left, hidden] {
        assert!(
            !b_text.contains(&foreign.to_string()),
            "tenant A channel {foreign} leaked into tenant B: {b_text}"
        );
    }
}

// ---------------------------------------------------------------------------
// 3 — invite create / regenerate / admin signup chain
// ---------------------------------------------------------------------------

struct InviteRow {
    role: String,
    max_uses: i32,
    revoked: bool,
    revoked_by: Option<Uuid>,
    revocation_reason: Option<String>,
    created_by: Uuid,
}

async fn invite_row(su: &PgPool, invite: Uuid) -> InviteRow {
    let row: (String, i32, bool, Option<Uuid>, Option<String>, Uuid) = sqlx::query_as(
        "SELECT role::text, max_uses, revoked_at IS NOT NULL, revoked_by, \
                revocation_reason, created_by \
           FROM invite_code WHERE id = $1",
    )
    .bind(invite)
    .fetch_one(su)
    .await
    .expect("invite row");
    InviteRow {
        role: row.0,
        max_uses: row.1,
        revoked: row.2,
        revoked_by: row.3,
        revocation_reason: row.4,
        created_by: row.5,
    }
}

async fn invite_count(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*)::bigint FROM invite_code WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count invites")
}

async fn workspace_role_of(su: &PgPool, workspace: Uuid, member: Uuid) -> Option<String> {
    sqlx::query_scalar(
        "SELECT role::text FROM workspace_membership WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace)
    .bind(member)
    .fetch_optional(su)
    .await
    .expect("workspace role")
}

/// `(actor_member_id, subject_member_id, detail)` of the single audit row for
/// `action` on `target`; panics if there is not exactly one.
async fn one_audit(
    su: &PgPool,
    workspace: Uuid,
    action: &str,
    target: Uuid,
) -> (Option<Uuid>, Option<Uuid>, Value) {
    let rows: Vec<(Option<Uuid>, Option<Uuid>, Value)> = sqlx::query_as(
        "SELECT actor_member_id, subject_member_id, detail FROM audit_log \
          WHERE workspace_id = $1 AND action = $2 AND target_id = $3",
    )
    .bind(workspace)
    .bind(action)
    .bind(target)
    .fetch_all(su)
    .await
    .expect("audit rows");
    assert_eq!(rows.len(), 1, "exactly one {action} audit row for {target}");
    rows.into_iter().next().unwrap()
}

async fn create_invite(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    payload: Value,
) -> Attempt {
    send(
        http.post(format!("{base}/v1/workspaces/{workspace}/invites"))
            .bearer_auth(token)
            .json(&payload),
    )
    .await
}

async fn post_join(http: &reqwest::Client, base: &str, code: &str, email: &str) -> Attempt {
    send(http.post(format!("{base}/v1/join")).json(&json!({
        "code": code,
        "email": email,
        "displayName": "박서연",
        "password": JOIN_PASSWORD,
    })))
    .await
}

fn joiner_email(hint: &str) -> String {
    format!("{hint}-{}@example.test", Uuid::new_v4())
}

/// verify_join.sh J2–J8, J10–J12, J17, J19, J20.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn invite_create_and_regenerate_contract_and_admin_signup_chain() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;

    let workspace = seed_workspace(&su, "sec07-join").await;
    let owner = seed_person(
        &su,
        workspace,
        Some("owner"),
        "이도현",
        "dohyeon",
        OWNER_PASSWORD,
    )
    .await;
    let general = seed_channel(
        &su,
        workspace,
        "public",
        "general",
        Some("전체 공지"),
        owner.id,
        false,
    )
    .await;
    seed_channel_member(&su, workspace, general, owner.id, "owner", false).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, workspace, &owner.email, OWNER_PASSWORD).await;

    // -- J2 / J3 / J4: create with no expiresAtMs --------------------------
    let created = create_invite(
        &http,
        &base,
        &owner_token,
        workspace,
        json!({"role": "member", "maxUses": 2}),
    )
    .await;
    assert_eq!(created.status, 201, "{}", created.body);
    let mut keys: Vec<&str> = created
        .body
        .as_object()
        .expect("create body is an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["code", "invite"], "{}", created.body);
    assert!(
        created.body["code"]
            .as_str()
            .is_some_and(|code| code.len() > 6),
        "the raw code is returned once: {}",
        created.body
    );
    let invite = &created.body["invite"];
    let expires = invite["expiresAtMs"].as_i64().expect("expiresAtMs");
    let created_at = invite["createdAtMs"].as_i64().expect("createdAtMs");
    assert_eq!(
        expires - created_at,
        7 * 24 * 60 * 60 * 1000,
        "no expiresAtMs → exactly seven days: {invite}"
    );
    assert_eq!(invite["role"], "member");
    assert_eq!(invite["maxUses"], 2);
    assert_eq!(invite["createdBy"], json!(owner.id.to_string()));
    let created_id = Uuid::parse_str(invite["id"].as_str().expect("invite id")).unwrap();
    let (actor, _, detail) = one_audit(&su, workspace, "invite.created", created_id).await;
    assert_eq!(actor, Some(owner.id), "the creator is the audit actor");
    assert_eq!(detail["role"], "member", "{detail}");
    assert_eq!(detail["max_uses"], 2, "{detail}");
    assert!(
        !detail
            .to_string()
            .contains(created.body["code"].as_str().unwrap()),
        "an audit row never carries the code: {detail}"
    );

    // -- J5: owner is not an invitable role --------------------------------
    let before = invite_count(&su, workspace).await;
    let owner_invite = create_invite(
        &http,
        &base,
        &owner_token,
        workspace,
        json!({"role": "owner", "maxUses": 1}),
    )
    .await;
    assert_eq!(owner_invite.status, 400, "{}", owner_invite.body);
    assert_eq!(
        error_message(&owner_invite.body),
        "invite role must be admin, member, or guest"
    );
    assert_eq!(
        invite_count(&su, workspace).await,
        before,
        "a refused owner invite must not leave a row"
    );
    let owner_rows: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM invite_code WHERE workspace_id = $1 AND role = 'owner'",
    )
    .bind(workspace)
    .fetch_one(&su)
    .await
    .expect("owner invites");
    assert_eq!(owner_rows, 0);

    // -- J6 / J7 / J8: regenerate a non-default invite ---------------------
    // guest / 7 uses, so "preserved" cannot be the column default.
    let source = create_invite(
        &http,
        &base,
        &owner_token,
        workspace,
        json!({"role": "guest", "maxUses": 7}),
    )
    .await;
    assert_eq!(source.status, 201, "{}", source.body);
    let source_id = Uuid::parse_str(source.body["invite"]["id"].as_str().unwrap()).unwrap();
    let regenerated = send(
        http.post(format!(
            "{base}/v1/workspaces/{workspace}/invites/{source_id}/regenerate"
        ))
        .bearer_auth(&owner_token),
    )
    .await;
    assert_eq!(regenerated.status, 201, "{}", regenerated.body);
    let new_invite = &regenerated.body["invite"];
    let new_id = Uuid::parse_str(new_invite["id"].as_str().unwrap()).unwrap();
    assert_ne!(new_id, source_id);
    assert_eq!(new_invite["role"], "guest", "{new_invite}");
    assert_eq!(new_invite["maxUses"], 7, "{new_invite}");
    assert!(new_invite.get("revokedAtMs").is_none(), "{new_invite}");

    let old_row = invite_row(&su, source_id).await;
    assert!(old_row.revoked, "the old invite must be revoked");
    assert_eq!(old_row.revoked_by, Some(owner.id));
    assert_eq!(old_row.revocation_reason.as_deref(), Some("regenerated"));
    let new_row = invite_row(&su, new_id).await;
    assert!(!new_row.revoked, "the replacement is live");
    assert_eq!(new_row.role, "guest");
    assert_eq!(new_row.max_uses, 7);
    assert_eq!(new_row.created_by, owner.id);
    let (_, _, regen_detail) = one_audit(&su, workspace, "invite.regenerated", source_id).await;
    assert_eq!(
        regen_detail["new_invite_id"],
        json!(new_id.to_string()),
        "{regen_detail}"
    );
    assert_eq!(regen_detail["role"], "guest", "{regen_detail}");
    assert_eq!(regen_detail["max_uses"], 7, "{regen_detail}");

    // -- J10: an admin invite makes an admin -------------------------------
    let admin_invite = create_invite(
        &http,
        &base,
        &owner_token,
        workspace,
        json!({"role": "admin", "maxUses": 1}),
    )
    .await;
    assert_eq!(admin_invite.status, 201, "{}", admin_invite.body);
    let admin_code = admin_invite.body["code"].as_str().unwrap().to_string();
    let admin_invite_id =
        Uuid::parse_str(admin_invite.body["invite"]["id"].as_str().unwrap()).unwrap();
    let admin_join = post_join(&http, &base, &admin_code, &joiner_email("seoyeon-admin")).await;
    assert_eq!(admin_join.status, 201, "{}", admin_join.body);
    let admin_token = admin_join.body["accessToken"]
        .as_str()
        .expect("join returns an access token")
        .to_string();
    let admin_id = Uuid::parse_str(admin_join.body["member"]["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        workspace_role_of(&su, workspace, admin_id).await.as_deref(),
        Some("admin"),
        "the joiner holds the invite's role at workspace level"
    );

    // -- J19 / J20: redemption row and join audit name the right ids -------
    let redemption_id = Uuid::parse_str(admin_join.body["redemptionId"].as_str().unwrap()).unwrap();
    let redemption: (Uuid, Uuid, Uuid) = sqlx::query_as(
        "SELECT id, invite_code_id, member_id FROM invite_code_redemption \
          WHERE workspace_id = $1 AND invite_code_id = $2",
    )
    .bind(workspace)
    .bind(admin_invite_id)
    .fetch_one(&su)
    .await
    .expect("exactly one redemption row");
    assert_eq!(redemption, (redemption_id, admin_invite_id, admin_id));
    let (join_actor, join_subject, join_detail) =
        one_audit(&su, workspace, "invite.join", admin_invite_id).await;
    assert_eq!(join_actor, Some(admin_id));
    assert_eq!(join_subject, Some(admin_id));
    assert_eq!(join_detail["role"], "admin", "{join_detail}");

    // -- J11 / J12: the new admin (not an owner) mints a member invite -----
    let by_admin = create_invite(
        &http,
        &base,
        &admin_token,
        workspace,
        json!({"role": "member", "maxUses": 3}),
    )
    .await;
    assert_eq!(
        by_admin.status, 201,
        "an admin may create invites: {}",
        by_admin.body
    );
    let by_admin_id = Uuid::parse_str(by_admin.body["invite"]["id"].as_str().unwrap()).unwrap();
    let by_admin_row = invite_row(&su, by_admin_id).await;
    assert_eq!(by_admin_row.created_by, admin_id);
    assert_eq!(by_admin_row.role, "member");
    assert_eq!(by_admin_row.max_uses, 3);
    let by_admin_code = by_admin.body["code"].as_str().unwrap().to_string();
    let member_join = post_join(&http, &base, &by_admin_code, &joiner_email("minsu-member")).await;
    assert_eq!(member_join.status, 201, "{}", member_join.body);
    let joined_channels = member_join.body["memberships"]
        .as_array()
        .expect("memberships");
    assert!(!joined_channels.is_empty(), "{}", member_join.body);
    for membership in joined_channels {
        assert_eq!(membership["role"], "member", "{membership}");
    }
    let joined_member =
        Uuid::parse_str(member_join.body["member"]["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        workspace_role_of(&su, workspace, joined_member)
            .await
            .as_deref(),
        Some("member")
    );

    // -- J17: the join-issued token can read the channel it was put in -----
    let member_token = member_join.body["accessToken"].as_str().unwrap();
    let channel_id = joined_channels[0]["channelId"].as_str().unwrap();
    assert_eq!(channel_id, general.to_string());
    let messages = get(
        &http,
        &base,
        member_token,
        &format!("/v1/workspaces/{workspace}/channels/{channel_id}/messages"),
    )
    .await;
    assert_eq!(messages.status, 200, "{}", messages.body);
    assert!(messages.body["messages"].is_array(), "{}", messages.body);
}

// ---------------------------------------------------------------------------
// 4 — empty password
// ---------------------------------------------------------------------------

/// verify_join.sh J15. The account's stored hash is `momo_password_hash('')`,
/// the one shape for which "empty password" could otherwise authenticate.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn empty_password_login_is_401() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let workspace = seed_workspace(&su, "sec07-empty-pw").await;
    let person = seed_person(
        &su,
        workspace,
        Some("member"),
        "정하윤",
        "hayun",
        OWNER_PASSWORD,
    )
    .await;
    let blank = seed_person(&su, workspace, Some("member"), "최민수", "minsu", "").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();

    let empty = try_login(&http, &base, workspace, &person.email, "").await;
    assert_eq!(empty.status, 401, "{}", empty.body);
    assert_eq!(error_message(&empty.body), "invalid credentials");

    let blank_hash = try_login(&http, &base, workspace, &blank.email, "").await;
    assert_eq!(
        blank_hash.status, 401,
        "an account whose hash is the hash of the empty string is still not enterable with \"\": {}",
        blank_hash.body
    );

    // The same account is not simply unusable.
    let ok = try_login(&http, &base, workspace, &person.email, OWNER_PASSWORD).await;
    assert_eq!(ok.status, 200, "{}", ok.body);
}

// ---------------------------------------------------------------------------
// 5 — roster availability (#4692, ADR-0160 ②)
// ---------------------------------------------------------------------------
//
// The roster carries `online` on a human row: does this person have a live
// connection to the workspace. It is read from Centrifugo's presence table by the
// api and **only ever looked up by rows the roster query already returned**, so
// what a viewer can learn is exactly the roster they may already read. The
// broker here is a stand-in that reports a presence table on purpose stuffed with
// people the viewer must never hear about.

/// A fragment no real id contains: if it shows up in a response, a presence
/// entry's `client` field (a device) leaked.
const BROKER_CLIENT_SENTINEL: &str = "broker-client-sentinel-";
const TEST_CENT_API_KEY: &str = "sec07-online-conformance-api-key";

type Rolls = Arc<HashMap<String, Vec<String>>>;

/// A Centrifugo that answers `POST /presence` for the channels it is given and
/// says `unknown channel` for every other — so a handler that asked about the
/// wrong workspace gets an error, not somebody else's table.
async fn spawn_presence_broker(rolls: HashMap<String, Vec<String>>) -> String {
    let app = Router::new()
        .route(
            "/presence",
            post(
                |AxumState(rolls): AxumState<Rolls>, AxumJson(body): AxumJson<Value>| async move {
                    let channel = body["channel"].as_str().unwrap_or_default().to_string();
                    match rolls.get(&channel) {
                        Some(users) => {
                            let mut presence = serde_json::Map::new();
                            for (index, user) in users.iter().enumerate() {
                                let client =
                                    format!("{BROKER_CLIENT_SENTINEL}{index}-{}", Uuid::new_v4());
                                presence.insert(
                                    client.clone(),
                                    json!({"user": user, "client": client}),
                                );
                            }
                            AxumJson(json!({"result": {"presence": presence}}))
                        }
                        None => {
                            AxumJson(json!({"error": {"code": 102, "message": "unknown channel"}}))
                        }
                    }
                },
            ),
        )
        .with_state(Arc::new(rolls));
    serve_on_loopback(app).await
}

/// A Centrifugo that is up and answers every call with a 503.
async fn spawn_failing_broker() -> String {
    let app = Router::new().route(
        "/presence",
        post(|| async { StatusCode::SERVICE_UNAVAILABLE }),
    );
    serve_on_loopback(app).await
}

async fn serve_on_loopback(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind broker stand-in");
    let address: SocketAddr = listener.local_addr().expect("broker address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

async fn start_server_with_broker(pool: PgPool, cent_api_url: Option<&str>) -> String {
    let mut state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
    if let Some(url) = cent_api_url {
        state = state.with_ephemeral(EphemeralSettings {
            cent_api_url: Some(url.to_string()),
            cent_api_key: Some(TEST_CENT_API_KEY.to_string()),
            ..EphemeralSettings::default()
        });
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

/// What the broker reports for a member: upper-case, as the connection token's
/// `sub` is.
fn broker_user(id: Uuid) -> String {
    id.to_string().to_uppercase()
}

struct Team {
    workspace: Uuid,
    owner: Person,
    alice: Person,
    bob: Person,
    guest: Person,
    agent: Uuid,
    suspended: Person,
}

/// One workspace, arranged so that every kind of person the broker might list
/// is present: a non-guest viewer (owner), two members (one connected, one not),
/// a guest who shares a channel with alice **only**, an agent, and a suspended
/// member.
async fn seed_team(su: &PgPool) -> Team {
    let workspace = seed_workspace(su, "sec07-online").await;
    let owner = seed_person(
        su,
        workspace,
        Some("owner"),
        "이도현",
        "owner",
        OWNER_PASSWORD,
    )
    .await;
    let alice = seed_person(
        su,
        workspace,
        Some("member"),
        "박서연",
        "alice",
        MEMBER_PASSWORD,
    )
    .await;
    let bob = seed_person(
        su,
        workspace,
        Some("member"),
        "최민수",
        "bob",
        MEMBER_PASSWORD,
    )
    .await;
    let guest = seed_person(
        su,
        workspace,
        Some("guest"),
        "정하윤",
        "guest",
        MEMBER_PASSWORD,
    )
    .await;
    let suspended = seed_person(
        su,
        workspace,
        Some("member"),
        "한지우",
        "suspended",
        MEMBER_PASSWORD,
    )
    .await;
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(suspended.id)
        .execute(su)
        .await
        .expect("suspend a member");
    let agent = seed_agent(su, workspace, owner.id, "helper").await;

    // `shared`: the guest and alice. `private`: the owner and bob. The guest
    // shares nothing with the owner or bob.
    let shared = seed_channel(su, workspace, "public", "shared", None, alice.id, false).await;
    seed_channel_member(su, workspace, shared, alice.id, "owner", false).await;
    seed_channel_member(su, workspace, shared, guest.id, "member", false).await;
    let private = seed_channel(su, workspace, "private", "private", None, owner.id, false).await;
    seed_channel_member(su, workspace, private, owner.id, "owner", false).await;
    seed_channel_member(su, workspace, private, bob.id, "member", false).await;

    Team {
        workspace,
        owner,
        alice,
        bob,
        guest,
        agent,
        suspended,
    }
}

fn ids_of(body: &Value) -> Vec<String> {
    members(body)
        .iter()
        .map(|row| row["id"].as_str().unwrap_or_default().to_string())
        .collect()
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn roster_online_is_read_from_the_transport_only_for_rows_the_viewer_may_see() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let team = seed_team(&su).await;

    // Another tenant, with its own person and its own connected table. Its member
    // is in the presence table of the workspace under test **on purpose**: a broker
    // that listed a stranger there must still leave no trace in any response.
    let other_workspace = seed_workspace(&su, "sec07-online-other").await;
    let stranger = seed_person(
        &su,
        other_workspace,
        Some("owner"),
        "윤재민",
        "stranger",
        OWNER_PASSWORD,
    )
    .await;

    let mut rolls = HashMap::new();
    rolls.insert(
        momo_ephemeral::online_channel(team.workspace),
        vec![
            broker_user(team.owner.id),
            // lower-case on purpose: the id is the same person however it is spelled
            team.alice.id.to_string().to_lowercase(),
            broker_user(team.guest.id),
            // people the roster never lists to anyone:
            broker_user(team.agent),
            broker_user(team.suspended.id),
            broker_user(stranger.id),
            // a connection that names nobody
            String::new(),
        ],
    );
    rolls.insert(
        momo_ephemeral::online_channel(other_workspace),
        vec![broker_user(stranger.id)],
    );
    let broker = spawn_presence_broker(rolls).await;
    let base = start_server_with_broker(app_pool, Some(&broker)).await;
    let http = reqwest::Client::new();
    let roster_path = format!("/v1/workspaces/{}/roster", team.workspace);

    // -- a non-guest viewer: every person the roster lists, with their availability --
    let owner_token = login(
        &http,
        &base,
        team.workspace,
        &team.owner.email,
        OWNER_PASSWORD,
    )
    .await;
    let owner_view = get(&http, &base, &owner_token, &roster_path).await;
    assert_eq!(owner_view.status, 200, "{}", owner_view.body);
    let body = &owner_view.body;
    assert_eq!(
        row_by_id(body, team.owner.id)["online"],
        json!(true),
        "{body}"
    );
    assert_eq!(
        row_by_id(body, team.alice.id)["online"],
        json!(true),
        "the broker spelled her id in lower case; it is still her: {body}"
    );
    assert_eq!(
        row_by_id(body, team.guest.id)["online"],
        json!(true),
        "{body}"
    );
    assert_eq!(
        row_by_id(body, team.bob.id)["online"],
        json!(false),
        "bob is on the roster and the broker does not list him: offline, not unknown: {body}"
    );
    assert!(
        row_by_id(body, team.agent).get("online").is_none(),
        "an agent's liveness is its agent_run: the key is absent, not false (ADR-0160 D4): {body}"
    );
    let owner_ids = ids_of(body);
    assert!(
        !owner_ids.contains(&team.suspended.id.to_string()),
        "a suspended member is not on the roster, whatever the broker says: {body}"
    );
    let owner_text = body.to_string();
    for forbidden in [
        stranger.id.to_string(),
        BROKER_CLIENT_SENTINEL.to_string(),
        "conn_info".to_string(),
    ] {
        assert!(
            !owner_text.contains(&forbidden),
            "{forbidden} reached a response: {owner_text}"
        );
    }

    // -- a guest: the roster's own narrowing, and nothing the broker said widens it --
    let guest_token = login(
        &http,
        &base,
        team.workspace,
        &team.guest.email,
        MEMBER_PASSWORD,
    )
    .await;
    let guest_view = get(&http, &base, &guest_token, &roster_path).await;
    assert_eq!(guest_view.status, 200, "{}", guest_view.body);
    let body = &guest_view.body;
    let mut guest_ids = ids_of(body);
    guest_ids.sort();
    let mut expected = vec![team.guest.id.to_string(), team.alice.id.to_string()];
    expected.sort();
    assert_eq!(
        guest_ids, expected,
        "a guest sees only people who share a channel with them: {body}"
    );
    assert_eq!(
        row_by_id(body, team.alice.id)["online"],
        json!(true),
        "{body}"
    );
    assert_eq!(
        row_by_id(body, team.guest.id)["online"],
        json!(true),
        "{body}"
    );
    let guest_text = body.to_string();
    for (what, hidden) in [
        ("the owner", team.owner.id.to_string()),
        ("the owner's handle", team.owner.handle.clone()),
        ("the owner's name", team.owner.display.clone()),
        ("bob", team.bob.id.to_string()),
        ("bob's handle", team.bob.handle.clone()),
        ("the agent", team.agent.to_string()),
        ("the suspended member", team.suspended.id.to_string()),
        ("another tenant's member", stranger.id.to_string()),
        (
            "a presence entry's device id",
            BROKER_CLIENT_SENTINEL.to_string(),
        ),
    ] {
        assert!(
            !guest_text.contains(&hidden),
            "{what} is outside this guest's roster and must leave no trace: {guest_text}"
        );
    }

    // -- the other tenant: its own table, none of ours --
    let stranger_token = login(
        &http,
        &base,
        other_workspace,
        &stranger.email,
        OWNER_PASSWORD,
    )
    .await;
    let stranger_view = get(
        &http,
        &base,
        &stranger_token,
        &format!("/v1/workspaces/{other_workspace}/roster"),
    )
    .await;
    assert_eq!(stranger_view.status, 200, "{}", stranger_view.body);
    assert_eq!(ids_of(&stranger_view.body), vec![stranger.id.to_string()]);
    assert_eq!(
        row_by_id(&stranger_view.body, stranger.id)["online"],
        json!(true)
    );
    let stranger_text = stranger_view.body.to_string();
    for ours in [team.owner.id, team.alice.id, team.bob.id, team.guest.id] {
        assert!(
            !stranger_text.contains(&ours.to_string()),
            "another tenant's roster must not mention {ours}: {stranger_text}"
        );
    }

    // -- an agents-only listing has no human row to annotate --
    let agents_only = get(
        &http,
        &base,
        &owner_token,
        &format!("{roster_path}?kind=agent"),
    )
    .await;
    assert_eq!(agents_only.status, 200, "{}", agents_only.body);
    assert!(members(&agents_only.body)
        .iter()
        .all(|row| row.get("online").is_none()));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn roster_online_is_absent_not_false_when_the_broker_cannot_answer() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let team = seed_team(&su).await;
    let roster_path = format!("/v1/workspaces/{}/roster", team.workspace);
    let http = reqwest::Client::new();

    // The control: a broker that answers. Without it, "no online key anywhere"
    // below would also pass on a server that never reads availability at all.
    let mut rolls = HashMap::new();
    rolls.insert(
        momo_ephemeral::online_channel(team.workspace),
        vec![broker_user(team.owner.id)],
    );
    let healthy = spawn_presence_broker(rolls).await;
    let base = start_server_with_broker(app_pool.clone(), Some(&healthy)).await;
    let token = login(
        &http,
        &base,
        team.workspace,
        &team.owner.email,
        OWNER_PASSWORD,
    )
    .await;
    let answered = get(&http, &base, &token, &roster_path).await;
    assert_eq!(answered.status, 200, "{}", answered.body);
    assert_eq!(
        row_by_id(&answered.body, team.owner.id)["online"],
        json!(true)
    );
    assert_eq!(
        row_by_id(&answered.body, team.alice.id)["online"],
        json!(false)
    );

    // Three ways of not answering, and the instance that was never given a transport.
    let failing = spawn_failing_broker().await;
    let silent_about_this_workspace = spawn_presence_broker(HashMap::new()).await; // `unknown channel`
    let refused = {
        // A port nothing listens on: bind, note the address, drop.
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = probe.local_addr().expect("addr");
        drop(probe);
        format!("http://{address}")
    };
    let cases: [(&str, Option<&str>); 4] = [
        ("a broker answering 503", Some(&failing)),
        (
            "a broker with no such namespace",
            Some(&silent_about_this_workspace),
        ),
        ("a broker that refuses connections", Some(&refused)),
        ("an instance with no CENT_API_URL/KEY", None),
    ];
    for (what, url) in cases {
        let base = start_server_with_broker(app_pool.clone(), url).await;
        let token = login(
            &http,
            &base,
            team.workspace,
            &team.owner.email,
            OWNER_PASSWORD,
        )
        .await;
        let view = get(&http, &base, &token, &roster_path).await;
        assert_eq!(
            view.status, 200,
            "{what}: the roster itself must not depend on the broker: {}",
            view.body
        );
        assert!(
            ids_of(&view.body).contains(&team.alice.id.to_string()),
            "{what}: the roster is otherwise unchanged: {}",
            view.body
        );
        assert!(
            members(&view.body)
                .iter()
                .all(|row| row.get("online").is_none()),
            "{what}: unknown must not be reported as offline (no row may carry `online`): {}",
            view.body
        );
    }
}
