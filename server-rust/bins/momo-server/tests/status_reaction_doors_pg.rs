//! #6067 — the agent reaction switch moves only on a person's full app session
//! (ADR-0200 증보 8 L10 · LA5).
//!
//! Both values — the workspace key `agent_reactions` (`PATCH …/settings`) and the agent's own
//! `agentReactions` (`PUT …/agents/{agent}/profile`) — are tried with every credential that is not
//! a person's full app session, and with a person's session that is neither an administrator nor
//! the agent's profile editor. Each cell asserts the status **and that the stored value did not
//! move** (the workspace key absent, the agent column NULL). The owner's full session is the
//! control that does move them, and the profile GET reads the stored agent value back.
//!
//! The agent's action arguments and the Agent Port's `oort_action_propose` share one judge —
//! `momo_workspace_actions::action_resolve::tests::no_proposal_can_name_the_agent_reaction_switch`.
//!
//! ```text
//! DATABASE_URL=postgres://… cargo test -p momo-server --test status_reaction_doors_pg \
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

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "status-reaction-6067-doors-secret";
const TEST_PASSWORD: &str = "status-reaction-6067-pw";

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
    format!("p6067{}", &Uuid::new_v4().simple().to_string()[..10])
}

#[allow(dead_code)]
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
    let email = format!("{id}@doors6067.test");
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

async fn seed_profile(su: &PgPool, workspace: Uuid, agent: Uuid, by: Uuid) {
    sqlx::query(
        "INSERT INTO agent_profile (agent_member_id, workspace_id, instructions, updated_by) \
         VALUES ($1, $2, '', $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(by)
    .execute(su)
    .await
    .expect("seed agent profile");
}

/// (workspace key as stored, agent column as stored)
async fn stored(su: &PgPool, workspace: Uuid, agent: Uuid) -> (Option<Value>, Option<String>) {
    let key: Option<Value> =
        sqlx::query_scalar("SELECT settings->'agent_reactions' FROM workspace WHERE id = $1")
            .bind(workspace)
            .fetch_one(su)
            .await
            .expect("workspace key");
    let column: Option<String> =
        sqlx::query_scalar("SELECT agent_reactions FROM agent WHERE member_id = $1")
            .bind(agent)
            .fetch_one(su)
            .await
            .expect("agent column");
    (key, column)
}

/// The two writes, as one credential presents them. Returns (settings status, profile status).
async fn try_both(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    agent: Uuid,
) -> (u16, u16) {
    let settings = http
        .patch(format!("{base}/v1/workspaces/{workspace}/settings"))
        .bearer_auth(token)
        .json(&json!({"agent_reactions": "free"}))
        .send()
        .await
        .expect("settings patch")
        .status()
        .as_u16();
    let profile = http
        .put(format!(
            "{base}/v1/workspaces/{workspace}/agents/{agent}/profile"
        ))
        .bearer_auth(token)
        .json(&json!({"instructions": "", "agentReactions": "free"}))
        .send()
        .await
        .expect("profile put")
        .status()
        .as_u16();
    (settings, profile)
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn only_a_persons_full_session_moves_the_agent_reaction_switch() {
    use momo_auth::{issue_dev_card_in_tx, DevTool, NewDevCard, DEV_FIXED_POLICY, DEV_SCOPES};
    use momo_db::{with_tenant_tx, DbError};

    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = app_pool().await;
    let ws = seed_workspace(&su).await;
    let owner = seed_human(&su, ws, "owner", "김도현").await;
    let member = seed_human(&su, ws, "member", "강수아").await;
    let agent = seed_agent(&su, ws, owner.id, "member").await;
    seed_profile(&su, ws, agent.id, owner.id).await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, ws, &owner.email).await;
    let member_token = login(&http, &base, ws, &member.email).await;
    let untouched = (None, None);
    assert_eq!(stored(&su, ws, agent.id).await, untouched);

    let mut cells: Vec<(String, String)> = Vec::new();
    // A person's session, but neither administrator nor the agent's profile editor.
    cells.push(("member's full session".into(), member_token.clone()));
    // The two narrow tokens of the owner.
    for mint in ["/v1/auth/push-action-token", "/v1/auth/push-fetch-token"] {
        let response = http
            .post(format!("{base}{mint}"))
            .bearer_auth(&owner_token)
            .send()
            .await
            .expect("mint a narrow token");
        let body: Value = response.json().await.expect("narrow token body");
        let token = body["token"]
            .as_str()
            .unwrap_or_else(|| panic!("{mint}: {body}"));
        cells.push((mint.to_string(), token.to_string()));
    }
    // The owner's developer card, full scopes.
    let card = {
        let new = NewDevCard {
            label: "도현 맥북 터미널".to_string(),
            tool: DevTool::Cli,
            scopes: DEV_SCOPES.iter().map(|scope| scope.to_string()).collect(),
            channel_ids: None,
            expires_in_days: 30,
        };
        let holder = owner.id;
        with_tenant_tx(&app, ws, move |conn| {
            Box::pin(async move {
                Ok::<_, DbError>(
                    issue_dev_card_in_tx(conn, ws, holder, &new, DEV_FIXED_POLICY).await?,
                )
            })
        })
        .await
        .expect("card transaction")
        .expect("an owner may hold a developer card")
        .secret
    };
    cells.push(("developer card (full)".into(), card.clone()));
    // The agent's own bearer.
    let bearer = momo_auth::mint_agent_bearer(ws).expect("mint agent bearer");
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, digest($3::text, 'sha256'), \
                 ARRAY['agent:port:connect','agent:runs:callback','agent:messages:write'], \
                 'status-reaction-6067')",
    )
    .bind(ws)
    .bind(agent.id)
    .bind(&bearer)
    .execute(&su)
    .await
    .expect("seed agent bearer");
    cells.push(("agent bearer".into(), bearer));

    let mut table = Vec::new();
    for (label, token) in &cells {
        let (settings, profile) = try_both(&http, &base, token, ws, agent.id).await;
        table.push(format!("{label}: settings {settings}, profile {profile}"));
        assert!(
            matches!(settings, 401 | 403),
            "{label}: settings PATCH answered {settings}"
        );
        assert!(
            matches!(profile, 401 | 403),
            "{label}: profile PUT answered {profile}"
        );
        assert_eq!(
            stored(&su, ws, agent.id).await,
            untouched,
            "{label}: a value moved"
        );
    }

    // The person's MCP: its catalog has no tool that writes settings or a profile, and a call
    // by such a name is an error that moves nothing.
    let mcp = |body: Value| {
        http.post(format!("{base}/v1/mcp/me"))
            .bearer_auth(&card)
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-11-25")
            .json(&body)
            .send()
    };
    let listed: Value = mcp(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
        .await
        .expect("tools/list")
        .json()
        .await
        .unwrap_or(Value::Null);
    let names: Vec<String> = listed["result"]["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|t| t["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    assert!(!names.is_empty(), "the human MCP lists its tools: {listed}");
    assert!(
        names.iter().all(|name| !name.contains("setting")
            && !name.contains("profile")
            && !name.contains("reaction")),
        "{names:?}"
    );
    let called: Value = mcp(json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "oort_me_settings_update", "arguments": {"agent_reactions": "free"}}
    }))
    .await
    .expect("tools/call")
    .json()
    .await
    .unwrap_or(Value::Null);
    assert!(
        called.get("error").is_some() || called["result"]["isError"] == json!(true),
        "an unknown tool is an error: {called}"
    );
    table.push(format!(
        "human MCP: tools {names:?}, unknown settings tool → error"
    ));
    assert_eq!(
        stored(&su, ws, agent.id).await,
        untouched,
        "human MCP: a value moved"
    );
    println!("STATUS-REACTION-6067 DOORS\n{}", table.join("\n"));

    // The control: the owner's full session moves both, and the profile GET reads it back.
    assert_eq!(
        try_both(&http, &base, &owner_token, ws, agent.id).await,
        (200, 200)
    );
    assert_eq!(
        stored(&su, ws, agent.id).await,
        (Some(json!("free")), Some("free".to_string()))
    );
    let profile: Value = http
        .get(format!(
            "{base}/v1/workspaces/{ws}/agents/{}/profile",
            agent.id
        ))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("profile get")
        .json()
        .await
        .expect("profile body");
    assert_eq!(
        profile["profile"]["agentReactions"],
        json!("free"),
        "{profile}"
    );
    // null follows the workspace again; an unknown word is a 400 that stores nothing.
    let cleared = http
        .put(format!(
            "{base}/v1/workspaces/{ws}/agents/{}/profile",
            agent.id
        ))
        .bearer_auth(&owner_token)
        .json(&json!({"instructions": "", "agentReactions": null}))
        .send()
        .await
        .expect("clear");
    assert_eq!(cleared.status(), 200);
    let body: Value = cleared.json().await.expect("cleared body");
    assert_eq!(body["profile"]["agentReactions"], Value::Null, "{body}");
    let refused = http
        .patch(format!("{base}/v1/workspaces/{ws}/settings"))
        .bearer_auth(&owner_token)
        .json(&json!({"agent_reactions": true}))
        .send()
        .await
        .expect("bad word");
    assert_eq!(refused.status(), 400);
    assert_eq!(stored(&su, ws, agent.id).await, (Some(json!("free")), None));
}
