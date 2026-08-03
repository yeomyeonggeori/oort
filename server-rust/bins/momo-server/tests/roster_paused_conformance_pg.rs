//! DB-backed conformance for `paused` on the roster (goal SRV-R2).
//!
//! The gap this closes is not a missing column, it is an **unreachable read**.
//! `agent_profile.paused` had exactly one reader — `GET …/agents/{agent}/profile`
//! — behind an owner/agent-owner gate. So an agent list could not draw pause
//! state: a plain member got a 403 per agent, and even an owner needed one
//! request *per agent* to render a single column. These two tests prove the
//! roster now answers it in one request, for a member with no privilege at all,
//! and that a human row is untouched.
//!
//! They are `#[ignore]` because they need a `pgvector/pgvector:pg18` superuser DB
//! plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test roster_paused_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract, identical to `agent_ops_conformance_pg.rs`: `DATABASE_URL`
//! connects as a **superuser** (migrations + `infra/e2e/bootstrap_roles.sql`,
//! fixtures bypass RLS); the **server** runs on `momo_app` (NOBYPASSRLS) so every
//! assertion is made through the policies production uses.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `srv_r2_1_a_plain_member_reads_pause_state_from_the_roster_in_one_request` | drop `paused` from the projection or the DTO, or project it for humans too (the `CASE` becomes a bare `COALESCE`) |
//! | `srv_r2_2_the_roster_row_follows_the_pause_switch` | read `paused` from anywhere but `agent_profile`, or omit it when false |

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

const TEST_JWT_SECRET: &str = "srv-r2-roster-paused-conformance-secret";
const TEST_PASSWORD: &str = "srv-r2-conformance-password";
const AGENT_MODEL: &str = "hermes-agent";

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

struct Tenant {
    workspace: Uuid,
    owner: Uuid,
    owner_email: String,
    channel: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, display: &str) -> (Uuid, String) {
    let human = Uuid::new_v4();
    let email = format!("{human}@srvr2.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(human)
    .bind(workspace)
    .bind(display)
    .bind(human.to_string())
    .execute(su)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, password_hash) \
         VALUES ($1, $2, $3, momo_password_hash($4))",
    )
    .bind(human)
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
    .bind(human)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace membership");
    (human, email)
}

async fn seed_tenant(su: &PgPool, app: &PgPool) -> Tenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    let (owner, owner_email) = seed_human(su, workspace, "owner", "성재").await;
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("srvr2-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: owner,
        },
    )
    .await
    .expect("create channel")
    .id;

    Tenant {
        workspace,
        owner,
        owner_email,
        channel,
    }
}

/// An agent member with **no `agent_profile` row** — the state every agent is
/// born in. It is the interesting one: "nobody has configured this agent" must
/// report `false`, not a missing key.
async fn seed_agent(su: &PgPool, tenant: &Tenant, handle: &str) -> Uuid {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(tenant.workspace)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, $3, 'https://gateway.invalid/v1', 4, 50, $4)",
    )
    .bind(agent)
    .bind(tenant.workspace)
    .bind(AGENT_MODEL)
    .bind(tenant.owner)
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(tenant.workspace)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent workspace membership");
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member')",
    )
    .bind(tenant.workspace)
    .bind(tenant.channel)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent channel membership");
    agent
}

async fn join_channel(su: &PgPool, tenant: &Tenant, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member') \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL",
    )
    .bind(tenant.workspace)
    .bind(tenant.channel)
    .bind(member)
    .execute(su)
    .await
    .expect("seed channel membership");
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
    assert_eq!(response.status(), 200, "the seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string()
}

async fn roster(http: &reqwest::Client, base: &str, token: &str, workspace: Uuid) -> Value {
    let response = http
        .get(format!("{base}/v1/workspaces/{workspace}/roster"))
        .bearer_auth(token)
        .send()
        .await
        .expect("roster");
    assert_eq!(
        response.status(),
        200,
        "the roster is readable by any workspace member"
    );
    response.json().await.expect("roster body")
}

fn row(roster: &Value, member: Uuid) -> &Value {
    roster["members"]
        .as_array()
        .expect("members array")
        .iter()
        .find(|row| row["id"] == json!(member.to_string()))
        .unwrap_or_else(|| panic!("{member} is on the roster: {roster}"))
}

async fn set_paused(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    agent: Uuid,
    paused: bool,
) -> reqwest::Response {
    http.put(format!(
        "{base}/v1/workspaces/{workspace}/agents/{agent}/pause"
    ))
    .bearer_auth(token)
    .json(&json!({"paused": paused}))
    .send()
    .await
    .expect("pause agent")
}

// ---------------------------------------------------------------------------
// 1 — one request, no privilege, and humans untouched
// ---------------------------------------------------------------------------

/// **A plain member reads pause state off the roster — the read that was a 403
/// per agent before.**
///
/// The 403 assertion in the middle is the point of the whole goal: the same
/// member, in the same breath, still cannot read the agent's *profile*. So this
/// is not "the gate was widened" — the gate is exactly where it was, and one
/// boolean that was already public (mentioning a paused agent posts a public
/// system line saying so) moved onto the list that already existed.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn srv_r2_1_a_plain_member_reads_pause_state_from_the_roster_in_one_request() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let sleeping = seed_agent(&su, &tenant, "hermes").await;
    let awake = seed_agent(&su, &tenant, "kimintern").await;
    let (member, member_email) = seed_human(&su, tenant.workspace, "member", "평사원").await;
    join_channel(&su, &tenant, member).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let member_token = login(&http, &base, tenant.workspace, &member_email).await;

    // The owner puts one agent to sleep through the shipped route.
    assert_eq!(
        set_paused(&http, &base, &owner_token, tenant.workspace, sleeping, true)
            .await
            .status(),
        200
    );

    // ---- the read that used to be impossible --------------------------------
    let roster = roster(&http, &base, &member_token, tenant.workspace).await;
    assert_eq!(
        row(&roster, sleeping)["paused"],
        json!(true),
        "the list can draw the sleep badge: {roster}"
    );
    assert_eq!(
        row(&roster, awake)["paused"],
        json!(false),
        "an agent with no agent_profile row at all is awake, not unknown — and it \
         says so explicitly rather than omitting the key: {roster}"
    );

    // ---- humans are untouched -----------------------------------------------
    for human in [tenant.owner, member] {
        let human_row = row(&roster, human);
        assert_eq!(human_row["kind"], json!("human"));
        assert!(
            human_row.get("paused").is_none(),
            "a person is not a thing that can be paused: {human_row}"
        );
    }

    // ---- and the gate that was NOT widened ----------------------------------
    let profile = http
        .get(format!(
            "{base}/v1/workspaces/{}/agents/{sleeping}/profile",
            tenant.workspace
        ))
        .bearer_auth(&member_token)
        .send()
        .await
        .expect("profile read");
    assert_eq!(
        profile.status(),
        403,
        "the same member still cannot read instructions/tools/triggers — only the \
         one field that was already public moved"
    );

    // The narrowed list carries it too, since that is what an agent tab asks for.
    let agents_only: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/roster?kind=agent",
            tenant.workspace
        ))
        .bearer_auth(&member_token)
        .send()
        .await
        .expect("roster?kind=agent")
        .json()
        .await
        .expect("body");
    assert_eq!(agents_only["humanCount"], json!(0));
    assert_eq!(row(&agents_only, sleeping)["paused"], json!(true));
}

// ---------------------------------------------------------------------------
// 2 — it is the live switch, not a snapshot
// ---------------------------------------------------------------------------

/// **Pausing and waking move the roster row, in that order.**
///
/// A field that is right once and then stale is worse than no field: a list
/// showing 재워짐 for an agent that is answering is a bug report waiting to
/// happen. This drives the actual `PUT …/pause` route both ways and re-reads the
/// list each time, so the roster row is proven to be a read of
/// `agent_profile.paused` rather than anything cached beside it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn srv_r2_2_the_roster_row_follows_the_pause_switch() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(&su, &tenant, "hermes").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.owner_email).await;

    let before = roster(&http, &base, &owner_token, tenant.workspace).await;
    assert_eq!(row(&before, agent)["paused"], json!(false));

    assert_eq!(
        set_paused(&http, &base, &owner_token, tenant.workspace, agent, true)
            .await
            .status(),
        200
    );
    let asleep = roster(&http, &base, &owner_token, tenant.workspace).await;
    assert_eq!(
        row(&asleep, agent)["paused"],
        json!(true),
        "the pause the route wrote is the pause the list reads"
    );

    assert_eq!(
        set_paused(&http, &base, &owner_token, tenant.workspace, agent, false)
            .await
            .status(),
        200
    );
    let awake = roster(&http, &base, &owner_token, tenant.workspace).await;
    assert_eq!(
        row(&awake, agent)["paused"],
        json!(false),
        "waking it up moves the row back — the field is a read, not a one-way flag"
    );

    // The row's other agent keys are unchanged by any of this, so nothing about
    // the projection's new join altered what was already there.
    let row = row(&awake, agent);
    assert_eq!(row["kind"], json!("agent"));
    assert_eq!(row["agentModel"], json!(AGENT_MODEL));
    assert_eq!(row["origin"], json!("local"));
    assert_eq!(row["ownerHumanId"], json!(tenant.owner.to_string()));
    assert_eq!(row["maxConcurrentRuns"], json!(4));
}
