//! #5814 — the owner/admin roster carries suspended humans (ADR-0128 D3 증보).
//!
//! A suspension had no way back from the screen: the roster listed active members
//! only, so once the profile window closed nothing listed the person to reopen and
//! reinstate. The HTTP roster now carries suspended **humans** to an owner or admin
//! person, and to nobody else. Every other path that lists or resolves people keeps
//! refusing them, and those are measured here too, each with an owner as the actor
//! (a member actor would stay green even if a widening leaked).
//!
//! `#[ignore]`: needs a `pgvector/pgvector:pg18` superuser DB plus the runtime roles.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test roster_suspended_admin_view_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract, identical to `roster_paused_conformance_pg.rs`: `DATABASE_URL`
//! connects as a **superuser** (migrations + `infra/rust/sql/bootstrap_roles.sql`,
//! fixtures bypass RLS); the **server** and the team AI read run on `momo_app`
//! (NOBYPASSRLS), so every assertion is made through the policies production uses.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `viewer_by_state_table` | widen for every viewer; widen for nobody; drop `m.kind = 'human'`; widen the status predicate past `suspended`; count suspended rows; drop the narrow-token gate |
//! | `other_paths_never_list_a_suspended_person` | widen the active-only roster query the team AI uses; drop `status = 'active'` from mention recording, DM open or channel add |
//! | `suspend_list_reinstate_round_trip` | widen for nobody (the suspended row never appears) |
//! | `rls_keeps_another_tenants_suspended_people_out` | a measurement of the RLS policy itself, not of this change: the wide read is asked for workspace B under workspace A's tenant GUC |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "roster-5814-suspended-view-secret";
const TEST_PASSWORD: &str = "roster-5814-conformance-pw";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn role_password(var: &str, default: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| default.to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn role_pool(username: &str, password: &str) -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username(username).password(password))
        .await
        .unwrap_or_else(|error| panic!("connect as {username} (bootstrap_roles.sql?): {error}"))
}

async fn app_pool() -> PgPool {
    role_pool(
        "momo_app",
        &role_password("MOMO_APP_PASSWORD", "momo_app_dev_pw"),
    )
    .await
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
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
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

fn fresh_handle() -> String {
    format!("p5814{}", &Uuid::new_v4().simple().to_string()[..10])
}

struct Person {
    id: Uuid,
    email: String,
    handle: String,
}

async fn seed_workspace(su: &PgPool) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    workspace
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, display: &str) -> Person {
    let id = Uuid::new_v4();
    let handle = fresh_handle();
    let email = format!("{id}@roster5814.test");
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
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, password_hash) \
         VALUES ($1, $2, $3, momo_password_hash($4))",
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
    .expect("seed workspace membership");
    Person { id, email, handle }
}

/// An agent member with a workspace row (`role` is what its membership says).
async fn seed_agent(su: &PgPool, workspace: Uuid, owner: Uuid, role: &str) -> Person {
    let id = Uuid::new_v4();
    let handle = fresh_handle();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 4, 50, $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, $3::membership_role)",
    )
    .bind(workspace)
    .bind(id)
    .bind(role)
    .execute(su)
    .await
    .expect("seed agent workspace membership");
    Person {
        id,
        email: String::new(),
        handle,
    }
}

async fn join_channel(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member') \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("seed channel membership");
}

async fn set_status(su: &PgPool, member: Uuid, status: &str) {
    sqlx::query("UPDATE member SET status = $2::member_status WHERE id = $1")
        .bind(member)
        .bind(status)
        .execute(su)
        .await
        .expect("set member status");
}

async fn new_channel(app: &PgPool, workspace: Uuid, creator: Uuid, kind: ChannelKind) -> Uuid {
    create_channel(
        app,
        workspace,
        NewChannel {
            kind,
            name: format!("r5814-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: creator,
        },
    )
    .await
    .expect("create channel")
    .id
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

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
    assert_eq!(response.status(), 200, "the seeded person logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string()
}

async fn roster_response(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
) -> (u16, Value) {
    let response = http
        .get(format!("{base}/v1/workspaces/{workspace}/roster"))
        .bearer_auth(token)
        .send()
        .await
        .expect("roster");
    let status = response.status().as_u16();
    let body = response.json().await.unwrap_or(Value::Null);
    (status, body)
}

async fn roster(http: &reqwest::Client, base: &str, token: &str, workspace: Uuid) -> Value {
    let (status, body) = roster_response(http, base, token, workspace).await;
    assert_eq!(status, 200, "roster read: {body}");
    body
}

/// The row's `status`, or `None` when the member is not on this roster.
fn listed_status(roster: &Value, member: Uuid) -> Option<String> {
    roster["members"]
        .as_array()
        .expect("members array")
        .iter()
        .find(|row| row["id"] == json!(member.to_string()))
        .map(|row| row["status"].as_str().expect("status").to_string())
}

async fn post_lifecycle(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    member: Uuid,
    action: &str,
) -> u16 {
    http.post(format!(
        "{base}/v1/workspaces/{workspace}/members/{member}/{action}"
    ))
    .bearer_auth(token)
    .send()
    .await
    .expect("lifecycle call")
    .status()
    .as_u16()
}

async fn remove(http: &reqwest::Client, base: &str, token: &str, workspace: Uuid, member: Uuid) {
    let status = http
        .delete(format!("{base}/v1/workspaces/{workspace}/members/{member}"))
        .bearer_auth(token)
        .json(&json!({"ban": false}))
        .send()
        .await
        .expect("remove")
        .status()
        .as_u16();
    assert_eq!(status, 200, "the owner removes a member through the route");
}

// ---------------------------------------------------------------------------
// 1 — viewer × target state, over HTTP
// ---------------------------------------------------------------------------

/// **Who sees a suspended person on the roster, measured cell by cell.**
///
/// Every target shares the channel the guest is in, so the guest narrowing alone
/// can never be the reason a row is missing: a missing suspended row is the
/// lifecycle scope, nothing else. States are reached through the shipped routes
/// where one exists (suspend, remove); the switched-off agent, `invited`, and a
/// `deleted` row that kept its membership row are written directly, the last as
/// a defence that does not lean on the membership join.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn viewer_by_state_table() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;

    let ws = seed_workspace(&su).await;
    let owner = seed_human(&su, ws, "owner", "김도현").await;
    let admin = seed_human(&su, ws, "admin", "이서윤").await;
    let member = seed_human(&su, ws, "member", "박지호").await;
    let guest = seed_human(&su, ws, "guest", "최하린").await;
    let active = seed_human(&su, ws, "member", "정민준").await;
    let suspended = seed_human(&su, ws, "member", "강수아").await;
    let suspended_admin = seed_human(&su, ws, "admin", "윤태오").await;
    let removed = seed_human(&su, ws, "member", "한예린").await;
    let invited = seed_human(&su, ws, "member", "오시우").await;
    let lingering_deleted = seed_human(&su, ws, "member", "서지안").await;
    let agent_off = seed_agent(&su, ws, owner.id, "member").await;
    // An agent whose membership row says admin: the kind gate, not the role, decides.
    let agent_viewer = seed_agent(&su, ws, owner.id, "admin").await;

    let channel = new_channel(&app, ws, owner.id, ChannelKind::Public).await;
    for person in [
        &owner,
        &admin,
        &member,
        &guest,
        &active,
        &suspended,
        &suspended_admin,
        &removed,
        &invited,
        &lingering_deleted,
        &agent_off,
        &agent_viewer,
    ] {
        join_channel(&su, ws, channel, person.id).await;
    }

    // Another tenant's suspended person (RLS).
    let other_ws = seed_workspace(&su).await;
    let _other_owner = seed_human(&su, other_ws, "owner", "문채원").await;
    let other_suspended = seed_human(&su, other_ws, "member", "배도윤").await;
    set_status(&su, other_suspended.id, "suspended").await;

    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, ws, &owner.email).await;
    let admin_token = login(&http, &base, ws, &admin.email).await;
    let member_token = login(&http, &base, ws, &member.email).await;
    let guest_token = login(&http, &base, ws, &guest.email).await;

    // States through the shipped routes.
    for target in [suspended.id, suspended_admin.id] {
        assert_eq!(
            post_lifecycle(&http, &base, &owner_token, ws, target, "suspend").await,
            200
        );
    }
    remove(&http, &base, &owner_token, ws, removed.id).await;
    // States no human route writes.
    set_status(&su, agent_off.id, "suspended").await;
    set_status(&su, invited.id, "invited").await;
    set_status(&su, lingering_deleted.id, "deleted").await;

    // The owner's notification-extension token (narrow, same person).
    let narrow: Value = http
        .post(format!("{base}/v1/auth/push-fetch-token"))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("mint push-fetch")
        .json()
        .await
        .expect("push-fetch body");
    let narrow_token = narrow["token"].as_str().expect("token").to_string();

    // An agent bearer for the agent whose row says admin.
    let bearer = momo_auth::mint_agent_bearer(ws).expect("mint agent bearer");
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, digest($3::text, 'sha256'), \
                 ARRAY['agent:runs:callback'], 'roster-5814')",
    )
    .bind(ws)
    .bind(agent_viewer.id)
    .bind(&bearer)
    .execute(&su)
    .await
    .expect("seed agent bearer");

    let s = |v: &str| Some(v.to_string());
    let targets: [(&str, Uuid); 8] = [
        ("active", active.id),
        ("suspended", suspended.id),
        ("suspended admin", suspended_admin.id),
        ("removed (route)", removed.id),
        ("invited", invited.id),
        ("deleted, membership row kept", lingering_deleted.id),
        ("switched-off agent", agent_off.id),
        ("other workspace, suspended", other_suspended.id),
    ];
    let wide = [
        s("active"),
        s("suspended"),
        s("suspended"),
        None,
        None,
        None,
        None,
        None,
    ];
    let narrow_view = [s("active"), None, None, None, None, None, None, None];
    let viewers: [(&str, &str, [Option<String>; 8]); 5] = [
        ("owner", owner_token.as_str(), wide.clone()),
        ("admin", admin_token.as_str(), wide.clone()),
        ("member", member_token.as_str(), narrow_view.clone()),
        ("guest", guest_token.as_str(), narrow_view.clone()),
        (
            "owner push-fetch",
            narrow_token.as_str(),
            narrow_view.clone(),
        ),
    ];

    let mut table = Vec::new();
    for (viewer, token, expected) in &viewers {
        let body = roster(&http, &base, token, ws).await;
        let mut cells = Vec::new();
        for ((label, target), want) in targets.iter().zip(expected.iter()) {
            let got = listed_status(&body, *target);
            cells.push(format!("{label}={}", got.as_deref().unwrap_or("-")));
            assert_eq!(&got, want, "{viewer} × {label}: {body}");
        }
        // Counts are active rows only, for every viewer.
        let rows = body["members"].as_array().expect("members");
        let active_humans = rows
            .iter()
            .filter(|r| r["kind"] == "human" && r["status"] == "active")
            .count();
        let active_agents = rows
            .iter()
            .filter(|r| r["kind"] == "agent" && r["status"] == "active")
            .count();
        assert_eq!(body["humanCount"], json!(active_humans), "{viewer}: {body}");
        assert_eq!(body["agentCount"], json!(active_agents), "{viewer}: {body}");
        // A suspended row carries no availability key.
        for row in rows.iter().filter(|r| r["status"] != "active") {
            assert!(row.get("online").is_none(), "{viewer}: {row}");
        }
        table.push(format!(
            "{viewer}: {} | humanCount={} rows={}",
            cells.join(" "),
            body["humanCount"],
            rows.len()
        ));
        // One wide body on one line, for the OpenAPI shape check
        // (`scripts/openapi_shape_check.py`) to validate a real suspended row.
        if *viewer == "admin" {
            println!("ROSTER-5814 ADMIN-BODY {body}");
        }
    }

    // The agent door: an agent bearer does not reach the roster at all.
    let (agent_status, agent_body) = roster_response(&http, &base, &bearer, ws).await;
    assert_eq!(
        agent_status, 403,
        "an agent bearer is refused before the roster query: {agent_body}"
    );
    table.push(format!(
        "agent bearer (row says admin): HTTP {agent_status}"
    ));

    // Seeing is not undoing: the admin sees a suspended admin but cannot reinstate.
    assert_eq!(
        post_lifecycle(
            &http,
            &base,
            &admin_token,
            ws,
            suspended_admin.id,
            "reinstate"
        )
        .await,
        403,
        "the reinstate ladder is unchanged"
    );
    table.push("admin reinstates suspended admin: 403".into());

    println!("ROSTER-5814 TABLE\n{}", table.join("\n"));
}

// ---------------------------------------------------------------------------
// 2 — no other path starts listing a suspended person
// ---------------------------------------------------------------------------

/// **Mention recording, DM open, channel add and the team AI's member list, each
/// with the owner as the actor, never reach a suspended person** — and each does
/// reach an active one in the same breath, so none of the zeros is trivially true.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn other_paths_never_list_a_suspended_person() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;

    let ws = seed_workspace(&su).await;
    let owner = seed_human(&su, ws, "owner", "김도현").await;
    let active = seed_human(&su, ws, "member", "정민준").await;
    let suspended = seed_human(&su, ws, "member", "강수아").await;
    let helper = seed_agent(&su, ws, owner.id, "member").await;
    let channel = new_channel(&app, ws, owner.id, ChannelKind::Public).await;
    let other_channel = new_channel(&app, ws, owner.id, ChannelKind::Public).await;
    for person in [&owner, &active, &suspended, &helper] {
        join_channel(&su, ws, channel, person.id).await;
    }
    join_channel(&su, ws, other_channel, owner.id).await;

    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, ws, &owner.email).await;
    assert_eq!(
        post_lifecycle(&http, &base, &owner_token, ws, suspended.id, "suspend").await,
        200
    );
    // The widening is live for this owner — otherwise the zeros below prove nothing.
    let owner_roster = roster(&http, &base, &owner_token, ws).await;
    assert_eq!(
        listed_status(&owner_roster, suspended.id).as_deref(),
        Some("suspended")
    );

    // (a) mention recording: name both, only the active one is recorded.
    let client_msg_id = Uuid::new_v4();
    let sent = http
        .post(format!(
            "{base}/v1/workspaces/{ws}/channels/{channel}/messages"
        ))
        .bearer_auth(&owner_token)
        .json(&json!({
            "clientMsgId": client_msg_id,
            "body": format!("@{} @{} 확인 부탁해요", active.handle, suspended.handle),
        }))
        .send()
        .await
        .expect("send");
    assert!(sent.status().is_success(), "send: {}", sent.status());
    let mentioned: Value = sqlx::query_scalar(
        "SELECT COALESCE(props->'mention_member_ids', '[]'::jsonb) FROM message \
          WHERE workspace_id = $1 AND client_msg_id = $2",
    )
    .bind(ws)
    .bind(client_msg_id)
    .fetch_one(&su)
    .await
    .expect("read mention ids");
    // Parsed, not compared as text: the props carry the ids upper-cased.
    let mentioned: Vec<Uuid> = mentioned
        .as_array()
        .expect("array")
        .iter()
        .map(|v| Uuid::parse_str(v.as_str().expect("id")).expect("uuid"))
        .collect();
    assert!(
        mentioned.contains(&active.id),
        "the active person is mentioned: {mentioned:?}"
    );
    assert!(
        !mentioned.contains(&suspended.id),
        "a suspended person is never recorded as mentioned: {mentioned:?}"
    );

    // (b) DM open.
    let dm = |target: Uuid| {
        http.post(format!("{base}/v1/workspaces/{ws}/dms"))
            .bearer_auth(&owner_token)
            .json(&json!({"memberId": target}))
            .send()
    };
    assert!(dm(active.id).await.expect("dm").status().is_success());
    assert_eq!(
        dm(suspended.id).await.expect("dm").status().as_u16(),
        404,
        "no DM opens with a suspended person"
    );

    // (c) channel add.
    let add = |target: Uuid| {
        http.post(format!(
            "{base}/v1/workspaces/{ws}/channels/{other_channel}/members"
        ))
        .bearer_auth(&owner_token)
        .json(&json!({"memberId": target}))
        .send()
    };
    assert!(add(active.id).await.expect("add").status().is_success());
    assert_eq!(
        add(suspended.id).await.expect("add").status().as_u16(),
        404,
        "a suspended person is not added to a channel"
    );
    let added: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM membership \
                         WHERE channel_id = $1 AND member_id = $2 AND left_at IS NULL)",
    )
    .bind(other_channel)
    .bind(suspended.id)
    .fetch_one(&su)
    .await
    .expect("membership read");
    assert!(!added);

    // (d) the team AI's member list, requested by the owner, on its roster branch
    // (the requester's own view, i.e. a 1:1 DM with the helper). Run on `momo_app`
    // (NOBYPASSRLS, tenant GUC) rather than under `momo_helper_read`: that role has
    // no SELECT on `human`, which the roster query joins, so this branch cannot run
    // under it at all today — a separate defect, handed off rather than fixed here.
    use momo_workspace_actions::team_ai_tools::{
        execute_read_tool_in_tx, Audience, ReadScope, ToolOutcome,
    };
    let scope = ReadScope {
        workspace_id: ws,
        requester: owner.id,
        reply_channel: channel,
        audience: Audience::RequesterView,
    };
    let outcome = momo_db::with_tenant_tx(&app, ws, move |conn| {
        let scope = scope.clone();
        Box::pin(
            async move { execute_read_tool_in_tx(conn, &scope, "list_members", &json!({})).await },
        )
    })
    .await
    .expect("list_members on the roster branch");
    let ToolOutcome::Data(listing) = outcome else {
        panic!("list_members: expected data, got {outcome:?}");
    };
    assert!(
        listing.contains(&format!("@{}", active.handle)),
        "the active person is listed: {listing}"
    );
    assert!(
        !listing.contains(&suspended.handle),
        "the team AI never lists a suspended person, even for an owner: {listing}"
    );
}

// ---------------------------------------------------------------------------
// 3 — suspend → listed → reinstate → active, through the routes
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn suspend_list_reinstate_round_trip() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;

    let ws = seed_workspace(&su).await;
    let owner = seed_human(&su, ws, "owner", "김도현").await;
    let watcher = seed_human(&su, ws, "member", "박지호").await;
    let target = seed_human(&su, ws, "member", "강수아").await;

    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, ws, &owner.email).await;
    let watcher_token = login(&http, &base, ws, &watcher.email).await;

    let before = roster(&http, &base, &owner_token, ws).await;
    assert_eq!(listed_status(&before, target.id).as_deref(), Some("active"));

    assert_eq!(
        post_lifecycle(&http, &base, &owner_token, ws, target.id, "suspend").await,
        200
    );
    let during = roster(&http, &base, &owner_token, ws).await;
    assert_eq!(
        listed_status(&during, target.id).as_deref(),
        Some("suspended"),
        "the owner finds the suspended person again: {during}"
    );
    let watcher_during = roster(&http, &base, &watcher_token, ws).await;
    assert_eq!(listed_status(&watcher_during, target.id), None);

    assert_eq!(
        post_lifecycle(&http, &base, &owner_token, ws, target.id, "reinstate").await,
        200
    );
    let after = roster(&http, &base, &owner_token, ws).await;
    assert_eq!(listed_status(&after, target.id).as_deref(), Some("active"));
    let watcher_after = roster(&http, &base, &watcher_token, ws).await;
    assert_eq!(
        listed_status(&watcher_after, target.id).as_deref(),
        Some("active")
    );
    // The reinstated person signs in again.
    let _ = login(&http, &base, ws, &target.email).await;
}

// ---------------------------------------------------------------------------
// 4 — RLS, measured on its own
// ---------------------------------------------------------------------------

/// **The wide read cannot reach another tenant's suspended people, even when it
/// is asked to by id.** The HTTP table above cannot tell the query's own
/// `workspace_id` predicate from RLS, since both hold there. Here the query is
/// handed workspace B as its argument inside workspace A's tenant transaction
/// on `momo_app` (NOBYPASSRLS), so only the row-level policy stands between it
/// and B's rows. The superuser read beforehand proves B's rows exist.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn rls_keeps_another_tenants_suspended_people_out() {
    use momo_messaging::{list_workspace_roster_with_status, RosterStatusScope};

    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;

    let ws_a = seed_workspace(&su).await;
    let owner_a = seed_human(&su, ws_a, "owner", "김도현").await;
    let ws_b = seed_workspace(&su).await;
    let _owner_b = seed_human(&su, ws_b, "owner", "문채원").await;
    let suspended_b = seed_human(&su, ws_b, "member", "배도윤").await;
    set_status(&su, suspended_b.id, "suspended").await;

    let present: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM member m \
           JOIN workspace_membership wm \
             ON wm.workspace_id = m.workspace_id AND wm.member_id = m.id \
          WHERE m.workspace_id = $1 AND m.status IN ('active', 'suspended')",
    )
    .bind(ws_b)
    .fetch_one(&su)
    .await
    .expect("superuser count");
    assert_eq!(
        present, 2,
        "workspace B has an owner and a suspended person"
    );

    let owner = owner_a.id;
    let leaked = momo_db::with_tenant_tx(&app, ws_a, move |conn| {
        Box::pin(async move {
            list_workspace_roster_with_status(
                conn,
                ws_b,
                owner,
                false,
                None,
                500,
                RosterStatusScope::ActiveAndSuspendedHumans,
            )
            .await
        })
    })
    .await
    .expect("wide read under tenant A");
    assert!(
        leaked.is_empty(),
        "tenant A's transaction read workspace B's members: {:?}",
        leaked.iter().map(|m| (m.id, &m.status)).collect::<Vec<_>>()
    );

    // The same call under B's own GUC does return B's suspended person, so the
    // empty answer above is the policy and not a broken query.
    let own = momo_db::with_tenant_tx(&app, ws_b, move |conn| {
        Box::pin(async move {
            list_workspace_roster_with_status(
                conn,
                ws_b,
                owner,
                false,
                None,
                500,
                RosterStatusScope::ActiveAndSuspendedHumans,
            )
            .await
        })
    })
    .await
    .expect("wide read under tenant B");
    assert!(
        own.iter()
            .any(|m| m.id == suspended_b.id && m.status == "suspended"),
        "the query itself does carry B's suspended person under B's GUC"
    );
}
