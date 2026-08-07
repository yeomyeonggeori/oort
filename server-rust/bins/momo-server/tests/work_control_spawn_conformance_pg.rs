//! DB-backed conformance for the spawn closed loop (#1114 — ADR-0114 D4/D5,
//! ADR-0125 D6-A, ADR-0154 D4 stage 1).
//!
//! Before this goal the Rust server had **no** `work_control` surface at all:
//! `INSERT INTO work_control` was 0, `work_auto_approve` had zero routes, and
//! `work.session.spawn` sat in `DECLARED_NOT_EXECUTABLE` naming the gap. These
//! tests are the proof that an agent can now ask to start a tool, that a person
//! decides **whether and where**, and that nothing reaches a host without that
//! decision.
//!
//! They are `#[ignore]` because they need a `pgvector/pgvector:pg18` superuser DB
//! plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test work_control_spawn_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract, identical to `agent_run_cancel_conformance_pg.rs`:
//! `DATABASE_URL` connects as a **superuser** (migrations +
//! `infra/e2e/bootstrap_roles.sql`, fixtures bypass RLS); the **server** runs on
//! `momo_app` (NOBYPASSRLS) so every assertion is made through the policies
//! production uses; the **worker** runs on `momo_worker` (BYPASSRLS).
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `ade1_1_a_spawn_waits_for_a_human_then_reaches_the_host_they_chose` | dispatch on create, drop the host candidates from the approval payload, ignore the decision's `hostId`, or stop binding the acked session |
//! | `ade1_2_an_undecided_spawn_never_reaches_a_host` (**red proof 1**) | let `acknowledge` accept a `pending_approval` control, or make `create` dispatch a spawn without the auto-approve check |
//! | `ade1_3_a_host_the_card_never_offered_is_refused` (**red proof 2**) | drop the `selectable_host_ids` check in the decision, or the in-transaction `spawn_host_ineligible_reason_in_tx` re-check |
//! | `ade1_4_a_pre_authorised_tool_dispatches_without_a_card` | drop `work_auto_approve` from the create path, or stop joining `work_tool_profile` so a disabled tool stays auto-approved |
//! | `ade1_5_the_spawn_tool_closes_the_loop_from_model_to_session` | remove `work.session.spawn` from `CATALOG`, run it without approval, or have the executor ignore `approved_host_id` |
//! | `ade1_6_a_tool_result_stands_beside_its_call_and_survives_a_replay` (#1133, **red proof 1+2**) | revert `write_result` to `call_message_id` (the result folds into the card), or give it a non-deterministic key (a replay posts a second result) |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_agent_worker::provider::{MockChatProvider, ProviderToolCall};
use momo_agent_worker::tool_exec::{self, ToolContext};
use momo_agent_worker::{AgentWorker, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_messaging::{
    create_channel, send_message_in_tx, ChannelKind, MessageType, NewChannel, NewMessage,
};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "ade1-work-control-spawn-conformance-secret";
const TEST_PASSWORD: &str = "ade1-conformance-password";
const AGENT_MODEL: &str = "hermes-agent";
const TOOL: &str = "codex";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

fn momo_worker_password() -> String {
    std::env::var("MOMO_WORKER_PASSWORD").unwrap_or_else(|_| "momo_worker_dev_pw".to_string())
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

/// Retire every worker job this suite did not enqueue — `claim_agent_job_batch`
/// is a **global** claim, so a leftover row from another binary would land in
/// this suite's batch.
async fn settle_residual_worker_jobs(su: &PgPool) {
    sqlx::query(
        "UPDATE outbox SET status = 'done', processed_at = now() \
          WHERE kind = 'agent_job' AND method = 'publish' \
            AND status IN ('pending', 'processing')",
    )
    .execute(su)
    .await
    .expect("sweep residual worker agent_jobs");
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
    human: Uuid,
    email: String,
    channel: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, display: &str) -> (Uuid, String) {
    let human = Uuid::new_v4();
    let email = format!("{human}@ade1.test");
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
    let (human, email) = seed_human(su, workspace, "owner", "성재").await;
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("ade1-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: human,
        },
    )
    .await
    .expect("create channel")
    .id;
    // The tool every spawn in this suite asks for. An unregistered tool is
    // refused before any host is consulted, so without this row every test
    // would pass for the wrong reason.
    seed_tool_profile(su, workspace, human, TOOL, true).await;
    Tenant {
        workspace,
        human,
        email,
        channel,
    }
}

async fn seed_tool_profile(su: &PgPool, workspace: Uuid, by: Uuid, tool: &str, enabled: bool) {
    sqlx::query(
        "INSERT INTO work_tool_profile \
           (workspace_id, tool_key, display_name, launch_template, enabled, created_by, updated_by) \
         VALUES ($1, $2, $2, $3, $4, $5, $5) \
         ON CONFLICT (workspace_id, tool_key) DO UPDATE SET enabled = EXCLUDED.enabled",
    )
    .bind(workspace)
    .bind(tool)
    .bind(json!({"command": tool, "arguments": []}))
    .bind(enabled)
    .bind(by)
    .execute(su)
    .await
    .expect("seed work tool profile");
}

async fn seed_channel_agent(su: &PgPool, tenant: &Tenant, handle: &str) -> Uuid {
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
    .bind(tenant.human)
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
         VALUES ($1, $2, $3, 'member') \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL",
    )
    .bind(tenant.workspace)
    .bind(tenant.channel)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent channel membership");
    agent
}

/// One registered host. `seen_ago_seconds` drives the 90s online window, which
/// is what the picker's `selectable` flag hangs off.
async fn seed_host(
    su: &PgPool,
    workspace: Uuid,
    owner: Uuid,
    scope: &str,
    host_type: &str,
    display: &str,
    seen_ago_seconds: Option<i64>,
) -> Uuid {
    let host = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO work_host \
           (id, workspace_id, scope, owner_member_id, type, display_name, public_key, \
            capabilities, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, \
                 CASE WHEN $8::bigint IS NULL THEN NULL \
                      ELSE clock_timestamp() - make_interval(secs => $8::bigint) END)",
    )
    .bind(host)
    .bind(workspace)
    .bind(scope)
    .bind(owner)
    .bind(host_type)
    .bind(display)
    // A distinct, well-formed Ed25519-shaped key per host; nothing here signs.
    .bind(base64_key(host))
    .bind(seen_ago_seconds)
    .execute(su)
    .await
    .expect("seed work host");
    host
}

fn base64_key(seed: Uuid) -> String {
    let bytes = seed.as_bytes();
    let mut raw = Vec::with_capacity(32);
    raw.extend_from_slice(bytes);
    raw.extend_from_slice(bytes);
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in raw.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        for shift in [18, 12, 6, 0] {
            out.push(ALPHABET[((n >> shift) & 0x3f) as usize] as char);
        }
    }
    // 32 bytes → 44 base64 chars with one '=' pad.
    out.truncate(43);
    out.push('=');
    out
}

async fn seed_run(su: &PgPool, tenant: &Tenant, agent: Uuid, status: &str) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key) \
         VALUES ($1, $2, $3, $4, $5::run_status, $6, $7)",
    )
    .bind(run)
    .bind(tenant.workspace)
    .bind(agent)
    .bind(tenant.channel)
    .bind(status)
    .bind(json!({"type": "work", "title": "ade1", "brief": "ade1"}))
    .bind(format!("ade1:{run}"))
    .execute(su)
    .await
    .expect("seed agent run");
    run
}

/// Mint an agent bearer carrying `work:control`.
async fn agent_bearer(su: &PgPool, tenant: &Tenant, agent: Uuid) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{}.{secret}", tenant.workspace);
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['work:control','messages:write'], 'ade1-conformance')",
    )
    .bind(tenant.workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
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

async fn request_spawn(
    http: &reqwest::Client,
    base: &str,
    bearer: &str,
    tenant: &Tenant,
    run: Uuid,
    host: Uuid,
    label: &str,
) -> reqwest::Response {
    http.post(format!(
        "{base}/v1/workspaces/{}/work-controls",
        tenant.workspace
    ))
    .bearer_auth(bearer)
    .json(&json!({
        "channelId": tenant.channel,
        "runId": run,
        "targetHostId": host,
        "kind": "spawn",
        "payload": {"tool": TOOL, "label": label},
    }))
    .send()
    .await
    .expect("request spawn control")
}

async fn decide(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    approval: Uuid,
    approve: bool,
    host: Option<Uuid>,
) -> reqwest::Response {
    let mut body = json!({
        "approval_id": approval,
        "approve": approve,
        "client_decision_id": Uuid::new_v4(),
    });
    if let Some(host) = host {
        body["hostId"] = json!(host);
    }
    http.post(format!(
        "{base}/v1/workspaces/{workspace}/approvals/{approval}/decision"
    ))
    .bearer_auth(token)
    .json(&body)
    .send()
    .await
    .expect("decide approval")
}

async fn error_message(response: reqwest::Response) -> String {
    let payload: Value = response.json().await.expect("error body");
    payload["error"]["message"]
        .as_str()
        .or_else(|| payload["decisionReason"].as_str())
        .unwrap_or_default()
        .to_string()
}

// ---------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------

async fn control_row(su: &PgPool, control: Uuid) -> (String, Uuid, Option<Uuid>, Option<Uuid>) {
    let row = sqlx::query(
        "SELECT status, target_host_id, session_id, approval_message_id \
           FROM work_control WHERE id = $1",
    )
    .bind(control)
    .fetch_one(su)
    .await
    .expect("read work control");
    (
        row.get("status"),
        row.get("target_host_id"),
        row.get("session_id"),
        row.get("approval_message_id"),
    )
}

async fn approvals(su: &PgPool, workspace: Uuid) -> Vec<(Uuid, String, String, Value)> {
    sqlx::query(
        "SELECT id, action_type, status::text AS status, payload FROM approval \
          WHERE workspace_id = $1 ORDER BY created_at, id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read approvals")
    .into_iter()
    .map(|row| {
        (
            row.get("id"),
            row.get("action_type"),
            row.get("status"),
            row.get("payload"),
        )
    })
    .collect()
}

/// Every broadcast of one realtime event type, oldest first.
async fn broadcasts(su: &PgPool, workspace: Uuid, event_type: &str) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->>'type' = $2 \
          ORDER BY id",
    )
    .bind(workspace)
    .bind(event_type)
    .fetch_all(su)
    .await
    .expect("read broadcasts")
}

async fn work_sessions(su: &PgPool, workspace: Uuid) -> Vec<(Uuid, Uuid, Uuid, String, String)> {
    sqlx::query(
        "SELECT id, member_id, host_id, tool, status FROM work_session \
          WHERE workspace_id = $1 ORDER BY started_at, id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read work sessions")
    .into_iter()
    .map(|row| {
        (
            row.get("id"),
            row.get("member_id"),
            row.get("host_id"),
            row.get("tool"),
            row.get("status"),
        )
    })
    .collect()
}

fn candidate(execution: &Value, host: Uuid) -> &Value {
    execution["host_candidates"]
        .as_array()
        .expect("host_candidates is an array")
        .iter()
        .find(|entry| entry["host_id"] == json!(host.to_string()))
        .unwrap_or_else(|| panic!("host {host} is missing from the picker: {execution}"))
}

// ---------------------------------------------------------------------------
// 1 — the closed loop
// ---------------------------------------------------------------------------

/// **An agent asks, a person decides where, and only then does a host hear it.**
///
/// This is the whole chain #1114 exists to close, asserted at every joint:
/// request → `pending_approval` + a card that names the hosts → decision that
/// **changes** the host → `dispatched` + one realtime envelope → session →
/// `acked` with the session bound → the lineage that binding unlocks.
///
/// The host swap in the middle is the ADR-0125 D6-A assertion. The agent asked
/// for the laptop; the person sent it to the team box. If the decision route
/// ignored `hostId`, every other assertion here would still pass and the picker
/// would be decoration — so the swap is checked on the ledger row, on the
/// broadcast, and on the session that ends up bound.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn ade1_1_a_spawn_waits_for_a_human_then_reaches_the_host_they_chose() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;
    let run = seed_run(&su, &tenant, agent, "running").await;

    let laptop = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "member",
        "app",
        "내 맥",
        Some(5),
    )
    .await;
    let vps = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "workspace",
        "workd",
        "팀 VPS",
        Some(5),
    )
    .await;
    let sleeping = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "member",
        "app",
        "낡은 맥",
        Some(3_600),
    )
    .await;
    let cloud = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "workspace",
        "cloud",
        "momo Cloud",
        Some(5),
    )
    .await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;
    let bearer = agent_bearer(&su, &tenant, agent).await;

    // ---- the request --------------------------------------------------------
    let response = request_spawn(&http, &base, &bearer, &tenant, run, laptop, "리팩터링").await;
    assert_eq!(response.status(), 201, "an agent may request a control");
    let body: Value = response.json().await.expect("control body");
    let control: Uuid = body["workControl"]["id"]
        .as_str()
        .and_then(|raw| Uuid::parse_str(raw).ok())
        .expect("the response names the control");
    assert_eq!(
        body["workControl"]["status"],
        json!("pending_approval"),
        "a spawn nobody pre-authorised waits: {body}"
    );
    assert!(
        broadcasts(&su, tenant.workspace, "work.control.dispatched")
            .await
            .is_empty(),
        "nothing reaches a host before a person decides"
    );

    // ---- the card ADR-0125 D6-A asks for ------------------------------------
    let raised = approvals(&su, tenant.workspace).await;
    assert_eq!(raised.len(), 1, "exactly one approval: {raised:?}");
    let (approval, action_type, status, payload) = raised[0].clone();
    assert_eq!(action_type, "work.spawn");
    assert_eq!(status, "pending");
    let execution = &payload["execution"];
    assert_eq!(execution["kind"], json!("work_session_spawn"));
    assert_eq!(execution["tool"], json!(TOOL));
    assert_eq!(
        execution["default_host_id"],
        json!(laptop.to_string()),
        "ADR-0125 D6-A: 로컬 온라인 우선 — the online `app` host is pre-selected: {execution}"
    );
    assert_eq!(candidate(execution, laptop)["selectable"], json!(true));
    assert_eq!(candidate(execution, laptop)["tier"], json!("local"));
    assert_eq!(candidate(execution, vps)["selectable"], json!(true));
    assert_eq!(candidate(execution, vps)["tier"], json!("remote"));
    assert_eq!(
        candidate(execution, sleeping)["unavailable_reason"],
        json!("offline"),
        "an offline host is shown with its reason, not hidden"
    );
    assert_eq!(
        candidate(execution, cloud)["unavailable_reason"],
        json!("t3_disabled"),
        "ADR-0136: the T3 slot is reserved and never selectable in stage 1"
    );

    // The card the room sees carries the same rows, so a client can draw the
    // picker from the broadcast alone.
    let card_props: Value = sqlx::query_scalar(
        "SELECT props FROM message WHERE workspace_id = $1 AND type = 'approval_request'",
    )
    .bind(tenant.workspace)
    .fetch_one(&su)
    .await
    .expect("the approval card exists");
    assert_eq!(card_props["kind"], json!("work_control_approval"));
    assert_eq!(card_props["execution"], *execution);

    // ---- the decision, which also chooses the host -------------------------
    let response = decide(
        &http,
        &base,
        &token,
        tenant.workspace,
        approval,
        true,
        Some(vps),
    )
    .await;
    assert_eq!(response.status(), 200, "the room's human may decide");

    let (status, target, session, approval_message) = control_row(&su, control).await;
    assert_eq!(status, "dispatched", "the decision released it to a host");
    assert_eq!(
        target, vps,
        "the person sent it somewhere else than the agent asked — that is the \
         whole point of the D6-A card"
    );
    assert!(session.is_none(), "a spawn binds its session only at ack");
    assert!(approval_message.is_some());

    let dispatched = broadcasts(&su, tenant.workspace, "work.control.dispatched").await;
    assert_eq!(dispatched.len(), 1, "exactly one dispatch: {dispatched:?}");
    assert_eq!(
        dispatched[0]["data"]["payload"]["target_host_id"],
        json!(vps.to_string()),
        "the host that is told is the host the person picked"
    );
    assert_eq!(
        dispatched[0]["data"]["payload"]["payload"],
        json!({"tool": TOOL, "label": "리팩터링"}),
        "the envelope carries the closed payload and nothing host-local"
    );

    // ---- the session, and the ack that binds it ----------------------------
    let created = http
        .post(format!(
            "{base}/v1/workspaces/{}/work-sessions",
            tenant.workspace
        ))
        .bearer_auth(&token)
        .json(&json!({
            "channelId": tenant.channel,
            "hostId": vps,
            "tool": TOOL,
            "label": "리팩터링",
        }))
        .send()
        .await
        .expect("create work session");
    assert_eq!(created.status(), 201);
    let created: Value = created.json().await.expect("session body");
    let session_id: Uuid = created["workSession"]["id"]
        .as_str()
        .and_then(|raw| Uuid::parse_str(raw).ok())
        .expect("session id");

    let acked = http
        .post(format!(
            "{base}/v1/workspaces/{}/work-controls/{control}/ack",
            tenant.workspace
        ))
        .bearer_auth(&token)
        .json(&json!({"ok": true, "sessionId": session_id}))
        .send()
        .await
        .expect("ack the control");
    assert_eq!(acked.status(), 200, "the registered host owner may ack");
    let (status, _, bound, _) = control_row(&su, control).await;
    assert_eq!(status, "acked");
    assert_eq!(
        bound,
        Some(session_id),
        "the ledger now knows which session this spawn produced"
    );

    // ---- what that binding unlocks -----------------------------------------
    // An `input` is only legal inside an acked spawn's lineage, so this 201 is
    // the proof the loop actually closed rather than merely ending.
    let follow_up = http
        .post(format!(
            "{base}/v1/workspaces/{}/work-controls",
            tenant.workspace
        ))
        .bearer_auth(&bearer)
        .json(&json!({
            "channelId": tenant.channel,
            "runId": run,
            "targetHostId": vps,
            "sessionId": session_id,
            "kind": "input",
            "payload": {"text": "계속"},
        }))
        .send()
        .await
        .expect("send input control");
    assert_eq!(
        follow_up.status(),
        201,
        "an input inside the approved lineage needs no second approval"
    );
    let follow_up: Value = follow_up.json().await.expect("input body");
    assert_eq!(
        follow_up["workControl"]["status"],
        json!("dispatched"),
        "input/read/kill dispatch straight away — the human already said yes to \
         this session"
    );
}

// ---------------------------------------------------------------------------
// 2 — red proof 1: an undecided spawn never reaches a host
// ---------------------------------------------------------------------------

/// **RED PROOF 1 — a spawn nobody approved does not execute.**
///
/// Two halves, because there are two ways to break it: the ledger must not
/// dispatch a `pending_approval` row, and the ack must not settle one. A revert
/// that dispatches on create fails the first assertion; a revert that drops
/// `acknowledge`'s status guard fails the second and would let an agent's own
/// host report a spawn that was never authorised.
///
/// The rejection half then proves the other direction: a `no` is `denied` and
/// still silent.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn ade1_2_an_undecided_spawn_never_reaches_a_host() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;
    let run = seed_run(&su, &tenant, agent, "running").await;
    let laptop = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "member",
        "app",
        "내 맥",
        Some(5),
    )
    .await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;
    let bearer = agent_bearer(&su, &tenant, agent).await;

    let body: Value = request_spawn(&http, &base, &bearer, &tenant, run, laptop, "위험한 일")
        .await
        .json()
        .await
        .expect("control body");
    let control: Uuid = Uuid::parse_str(body["workControl"]["id"].as_str().expect("id")).unwrap();

    // Half one: the ledger did not release it.
    assert!(
        broadcasts(&su, tenant.workspace, "work.control.dispatched")
            .await
            .is_empty(),
        "a pending spawn was broadcast to a host"
    );

    // Half two: the host owner cannot settle what was never dispatched.
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{}/work-controls/{control}/ack",
            tenant.workspace
        ))
        .bearer_auth(&token)
        .json(&json!({"ok": true, "sessionId": Uuid::new_v4()}))
        .send()
        .await
        .expect("ack a pending control");
    assert_eq!(
        response.status(),
        409,
        "acking a pending control must conflict, not succeed"
    );
    assert_eq!(
        error_message(response).await,
        "only dispatched controls can be acknowledged"
    );
    let (status, _, session, _) = control_row(&su, control).await;
    assert_eq!(status, "pending_approval", "and the row did not move");
    assert!(session.is_none());

    // ---- the other direction: a `no` is recorded and still silent ----------
    let raised = approvals(&su, tenant.workspace).await;
    let approval = raised[0].0;
    let response = decide(
        &http,
        &base,
        &token,
        tenant.workspace,
        approval,
        false,
        None,
    )
    .await;
    assert_eq!(response.status(), 200);
    let (status, _, _, _) = control_row(&su, control).await;
    assert_eq!(
        status, "denied",
        "a refused spawn is denied, not left pending"
    );
    assert!(
        broadcasts(&su, tenant.workspace, "work.control.dispatched")
            .await
            .is_empty(),
        "a denied spawn must never be broadcast to a host"
    );
    assert!(
        work_sessions(&su, tenant.workspace).await.is_empty(),
        "and no session exists for a spawn that was refused"
    );
}

// ---------------------------------------------------------------------------
// 3 — red proof 2: an ineligible host is refused
// ---------------------------------------------------------------------------

/// **RED PROOF 2 — a host the card never offered cannot be chosen.**
///
/// Three shapes of "not eligible", each a different reason the picker greys a
/// row, and each refused at decision time:
///
/// * another member's **member-scoped** host — the row is not in the list at all;
/// * an **offline** host of the approver's own — listed, but `selectable: false`;
/// * the reserved **cloud** slot (ADR-0136).
///
/// The final approval on the legitimate host is what stops this test from
/// passing by refusing everything.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn ade1_3_a_host_the_card_never_offered_is_refused() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;
    let run = seed_run(&su, &tenant, agent, "running").await;
    let (stranger, _) = seed_human(&su, tenant.workspace, "member", "동료").await;

    let laptop = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "member",
        "app",
        "내 맥",
        Some(5),
    )
    .await;
    let sleeping = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "member",
        "app",
        "낡은 맥",
        Some(3_600),
    )
    .await;
    let cloud = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "workspace",
        "cloud",
        "momo Cloud",
        Some(5),
    )
    .await;
    let strangers_box = seed_host(
        &su,
        tenant.workspace,
        stranger,
        "member",
        "app",
        "동료의 맥",
        Some(5),
    )
    .await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;
    let bearer = agent_bearer(&su, &tenant, agent).await;

    // The ledger refuses a *request* aimed at someone else's private host, too —
    // the picker is the second line of defence, not the only one.
    let refused = request_spawn(
        &http,
        &base,
        &bearer,
        &tenant,
        run,
        strangers_box,
        "남의 맥",
    )
    .await;
    assert_eq!(refused.status(), 403);
    assert_eq!(
        error_message(refused).await,
        "member-scoped work host belongs to another session owner"
    );

    let body: Value = request_spawn(&http, &base, &bearer, &tenant, run, laptop, "리팩터링")
        .await
        .json()
        .await
        .expect("control body");
    let control: Uuid = Uuid::parse_str(body["workControl"]["id"].as_str().expect("id")).unwrap();
    let approval = approvals(&su, tenant.workspace).await[0].0;

    for (host, why) in [
        (
            strangers_box,
            "a colleague's private host is not a candidate",
        ),
        (sleeping, "an offline host is listed but not selectable"),
        (cloud, "the T3 slot is reserved, not offered"),
    ] {
        let response = decide(
            &http,
            &base,
            &token,
            tenant.workspace,
            approval,
            true,
            Some(host),
        )
        .await;
        assert_eq!(response.status(), 403, "{why}");
        assert_eq!(
            error_message(response).await,
            "selected host is not one of this approval's candidates",
            "{why}"
        );
        let (status, _, _, _) = control_row(&su, control).await;
        assert_eq!(status, "pending_approval", "{why} — and nothing moved");
        assert!(
            broadcasts(&su, tenant.workspace, "work.control.dispatched")
                .await
                .is_empty(),
            "{why} — and no host was told"
        );
    }

    // …and the legitimate host still works, so the refusals above are a rule
    // rather than a broken route.
    let response = decide(
        &http,
        &base,
        &token,
        tenant.workspace,
        approval,
        true,
        Some(laptop),
    )
    .await;
    assert_eq!(response.status(), 200);
    let (status, target, _, _) = control_row(&su, control).await;
    assert_eq!(status, "dispatched");
    assert_eq!(target, laptop);
}

// ---------------------------------------------------------------------------
// 4 — ADR-0114 D5: the host owner's standing permission
// ---------------------------------------------------------------------------

/// **A tool the host owner pre-authorised dispatches with no card at all —
/// unless the workspace has since turned that tool off.**
///
/// The second half is the one worth keeping: `work_auto_approve` joins
/// `work_tool_profile` precisely so that disabling a tool disables its
/// automation too. Drop the join and a member's month-old tick keeps launching a
/// tool an operator has since forbidden.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn ade1_4_a_pre_authorised_tool_dispatches_without_a_card() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;
    let run = seed_run(&su, &tenant, agent, "running").await;
    let laptop = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "member",
        "app",
        "내 맥",
        Some(5),
    )
    .await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;
    let bearer = agent_bearer(&su, &tenant, agent).await;

    let enabled = http
        .put(format!(
            "{base}/v1/workspaces/{}/work-auto-approvals/{TOOL}",
            tenant.workspace
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("enable auto approve");
    assert_eq!(enabled.status(), 200);
    let listed: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/work-auto-approvals",
            tenant.workspace
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list auto approvals")
        .json()
        .await
        .expect("list body");
    assert_eq!(listed["tools"], json!([TOOL]));

    let body: Value = request_spawn(&http, &base, &bearer, &tenant, run, laptop, "자동")
        .await
        .json()
        .await
        .expect("control body");
    assert_eq!(
        body["workControl"]["status"],
        json!("dispatched"),
        "a pre-authorised spawn goes straight to the host: {body}"
    );
    assert!(
        body["workControl"]["approvalMessageId"].is_null(),
        "and raises no card: {body}"
    );
    assert!(
        approvals(&su, tenant.workspace).await.is_empty(),
        "an auto-approved spawn writes no approval row"
    );
    assert_eq!(
        broadcasts(&su, tenant.workspace, "work.control.dispatched")
            .await
            .len(),
        1
    );

    // ---- the workspace turns the tool off ----------------------------------
    seed_tool_profile(&su, tenant.workspace, tenant.human, TOOL, false).await;
    let refused = request_spawn(&http, &base, &bearer, &tenant, run, laptop, "여전히 자동?").await;
    assert_eq!(
        refused.status(),
        400,
        "a disabled tool cannot be spawned at all, auto-approval or not"
    );
    assert_eq!(
        error_message(refused).await,
        "work tool is not registered or enabled"
    );
    assert_eq!(
        broadcasts(&su, tenant.workspace, "work.control.dispatched")
            .await
            .len(),
        1,
        "still exactly the one dispatch from before"
    );
}

// ---------------------------------------------------------------------------
// 5 — the tool loop: model → approval → session
// ---------------------------------------------------------------------------

/// **The closed loop through the agent's own tool channel.**
///
/// A model asks for `work.session.spawn`; the run parks on a human; the card
/// carries the hosts; the person approves **and picks**; the resumed worker
/// creates the session on that host and writes the ledger row a daemon would
/// consume. This is the path ADR-0154 D4 stage 1 names, end to end, with no
/// hand-seeded rows in the middle.
///
/// Reverting `work.session.spawn` out of `CATALOG` makes the first drain answer
/// a `tool_result` naming the gap instead of parking; running it without the
/// approval makes the session exist before the decision; ignoring
/// `approved_host_id` puts the session on the laptop the model guessed rather
/// than the box the person chose.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn ade1_5_the_spawn_tool_closes_the_loop_from_model_to_session() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let worker_pool = role_pool("momo_worker", &momo_worker_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    // The mention below is what starts the run; nothing else needs the id.
    let _agent = seed_channel_agent(&su, &tenant, "hermes").await;

    let laptop = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "member",
        "app",
        "내 맥",
        Some(5),
    )
    .await;
    let vps = seed_host(
        &su,
        tenant.workspace,
        tenant.human,
        "workspace",
        "workd",
        "팀 VPS",
        Some(5),
    )
    .await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;

    // The mention that starts a real run.
    let sent = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            tenant.workspace, tenant.channel
        ))
        .bearer_auth(&token)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": "@hermes 코덱스 세션 하나 띄워줘"}))
        .send()
        .await
        .expect("send mention");
    assert_eq!(sent.status(), 201);
    let run: Uuid = sqlx::query_scalar("SELECT id FROM agent_run WHERE workspace_id = $1")
        .bind(tenant.workspace)
        .fetch_one(&su)
        .await
        .expect("the mention started one run");

    // ---- turn 1: the model asks for the tool -------------------------------
    let spawn_call = ProviderToolCall {
        id: "call_spawn_1".to_string(),
        // momo's own name, because that is what a real adapter hands the worker:
        // the wire spelling `work_session_spawn` is mapped back by
        // `momo_tool_name` at the provider boundary (`responses.rs`), and the
        // mock stands in for the adapter's output, not for the raw wire.
        name: momo_agent::tools::WORK_SESSION_SPAWN.to_string(),
        // The model proposes the laptop; the person will not agree.
        arguments: json!({"tool": TOOL, "label": "리팩터링", "host_id": laptop.to_string()})
            .to_string(),
    };
    let worker = AgentWorker::new(
        worker_pool.clone(),
        Arc::new(MockChatProvider::echo().with_tool_calls([vec![spawn_call], vec![]])),
        WorkerConfig::for_target(database_url()),
    );
    worker.drain_once().await.expect("first drain");

    let run_status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run)
        .fetch_one(&su)
        .await
        .expect("read run");
    assert_eq!(
        run_status, "awaiting_approval",
        "a spawn parks the run on a human"
    );
    assert!(
        work_sessions(&su, tenant.workspace).await.is_empty(),
        "**nothing ran**: no session exists before the decision"
    );

    let raised = approvals(&su, tenant.workspace).await;
    assert_eq!(raised.len(), 1, "one approval: {raised:?}");
    let (approval, action_type, _, payload) = raised[0].clone();
    assert_eq!(
        action_type, "tool_call",
        "the tool channel's own action type — the work-control ledger's is \
         `work.spawn`, and the decision route branches on exactly that"
    );
    let execution = &payload["execution"];
    assert_eq!(
        execution["requested_host_id"],
        json!(laptop.to_string()),
        "the model's proposal is recorded as a proposal: {execution}"
    );
    assert_eq!(candidate(execution, vps)["selectable"], json!(true));

    // ---- the decision: approve, but somewhere else -------------------------
    let response = decide(
        &http,
        &base,
        &token,
        tenant.workspace,
        approval,
        true,
        Some(vps),
    )
    .await;
    assert_eq!(response.status(), 200);

    // ---- turn 2: the resumed worker runs it --------------------------------
    worker.drain_once().await.expect("resume drain");

    let sessions = work_sessions(&su, tenant.workspace).await;
    assert_eq!(
        sessions.len(),
        1,
        "one session, created by the tool: {sessions:?}"
    );
    let (session_id, member_id, host_id, tool, status) = sessions[0].clone();
    assert_eq!(
        host_id, vps,
        "the session runs where the **person** said, not where the model guessed"
    );
    assert_eq!(
        member_id, tenant.human,
        "a spawned session belongs to the agent's owner human, never to the agent"
    );
    assert_eq!(tool, TOOL);
    assert_eq!(status, "running");

    // The ledger row a daemon consumes, bound to the session it belongs to.
    let control: (Uuid, String, Uuid, Option<Uuid>) = sqlx::query(
        "SELECT id, status, target_host_id, session_id FROM work_control \
          WHERE workspace_id = $1 AND kind = 'spawn'",
    )
    .bind(tenant.workspace)
    .fetch_one(&su)
    .await
    .map(|row| {
        (
            row.get("id"),
            row.get("status"),
            row.get("target_host_id"),
            row.get("session_id"),
        )
    })
    .expect("the tool wrote a work_control row");
    assert_eq!(control.1, "dispatched");
    assert_eq!(control.2, vps);
    assert_eq!(
        control.3,
        Some(session_id),
        "the control names the session, so a daemon knows what to attach the \
         tool it starts to"
    );

    let dispatched = broadcasts(&su, tenant.workspace, "work.control.dispatched").await;
    assert_eq!(dispatched.len(), 1);
    let started = broadcasts(&su, tenant.workspace, "work.session.started").await;
    assert_eq!(started.len(), 1, "the room is told the session began");

    // ---- what the room and the model are told ------------------------------
    // The `tool_call` card the agent posted before anything was decided: a
    // person watching the channel saw the ask, not just its consequence.
    let asked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message \
          WHERE workspace_id = $1 AND type = 'tool_call' \
            AND props->>'name' = $2",
    )
    .bind(tenant.workspace)
    .bind(momo_agent::tools::WORK_SESSION_SPAWN)
    .fetch_one(&su)
    .await
    .expect("count tool_call cards");
    assert_eq!(asked, 1, "the agent's request is visible in the room");

    // …and so is its answer (#1133). Both rows stand on the spine with their
    // own `seq`, which is the whole user-visible payoff of the spawn loop: the
    // room reads 「세션 시작됨」 rather than a request that trails off.
    //
    // Until #1133 the result carried `call_message_id(run, call_id)` — the
    // card's key — and the spine's `(channel, author, client_msg_id)` guard
    // folded it into the card, leaving this query with one row instead of two.
    let spine: Vec<(String, Uuid, i64, String)> = sqlx::query(
        "SELECT type::text, client_msg_id, seq, COALESCE(body, '') AS body \
           FROM message \
          WHERE workspace_id = $1 AND run_id = $2 \
            AND type IN ('tool_call', 'tool_result') \
          ORDER BY seq",
    )
    .bind(tenant.workspace)
    .bind(run)
    .fetch_all(&su)
    .await
    .expect("read the run's tool rows")
    .into_iter()
    .map(|row| {
        (
            row.get("type"),
            row.get("client_msg_id"),
            row.get::<i64, _>("seq"),
            row.get("body"),
        )
    })
    .collect();
    assert_eq!(
        spine.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
        vec!["tool_call", "tool_result"],
        "the ask AND its answer, in that order: {spine:?}"
    );
    assert!(spine[0].2 < spine[1].2, "two seqs, not one: {spine:?}");
    // The keys are the shipped functions, not hand-derived: reverting
    // `write_result` to `call_message_id` makes the second row vanish above and
    // these two equal here.
    assert_eq!(
        spine[0].1,
        momo_agent_worker::tool_exec::call_message_id(run, "call_spawn_1"),
        "the card keeps its key"
    );
    assert_eq!(
        spine[1].1,
        momo_agent_worker::tool_exec::result_message_id(run, "call_spawn_1"),
        "and the result has one of its own"
    );
    assert!(
        spine[1].3.contains("리팩터링") && spine[1].3.contains(&vps.to_string()),
        "the result names the session and the host it landed on: {}",
        spine[1].3
    );

    // …and the turn's answer carries the outcome in the model's own language.
    let answer: String = sqlx::query_scalar(
        "SELECT COALESCE(body, '') FROM message \
          WHERE workspace_id = $1 AND run_id = $2 AND type = 'text' \
          ORDER BY seq DESC LIMIT 1",
    )
    .bind(tenant.workspace)
    .bind(run)
    .fetch_one(&su)
    .await
    .expect("the resumed turn answered");
    assert!(
        answer.contains("리팩터링") && answer.contains(&vps.to_string()),
        "the answer names the session and the host it landed on: {answer}"
    );
}

// ---------------------------------------------------------------------------
// 6 — the tool_result's own key (#1133)
// ---------------------------------------------------------------------------

/// **A result stands beside its call, and a replay adds nothing.**
///
/// The bug, precisely: a `tool_call` card and its `tool_result` are two
/// messages by ONE author in ONE channel, and both derived `client_msg_id` from
/// `call_message_id(run, call_id)`. The spine's
/// `(channel, author, client_msg_id)` guard cannot tell "the result of that
/// call" from "that call, posted twice", so it did the only thing it can: it
/// folded the second write into the first and returned the card. The room kept
/// the question and lost the answer — since before #1114, for every tool.
///
/// This stages the collision rather than describing it: the card is written
/// through the same spine with the same shipped `call_message_id`, and only
/// then does the executor run. Two things must hold at once, and they pull in
/// opposite directions:
///
/// - **red proof 1 — a replay writes no second result.** The executor is run
///   twice, which is exactly what a job re-claimed after a lease takeover does.
///   Giving the result a random key, or none, makes the second run post a
///   duplicate here.
/// - **red proof 2 — the old key is a collision.** Reverting `write_result` to
///   `call_message_id` folds the result into the card, and the room is left
///   with a `tool_call` and nothing else.
///
/// The staged call names a session that does not exist, so the executor's
/// answer is a refusal it can give twice without touching a lifecycle row: the
/// only thing under test is the key.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn ade1_6_a_tool_result_stands_beside_its_call_and_survives_a_replay() {
    const CALL_ID: &str = "call_replayed_1";

    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let worker_pool = role_pool("momo_worker", &momo_worker_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_channel_agent(&su, &tenant, "hermes").await;
    let run = seed_run(&su, &tenant, agent, "running").await;
    let workspace = tenant.workspace;
    let channel = tenant.channel;

    let call = momo_agent::tools::ToolCall {
        call_id: CALL_ID.to_string(),
        name: momo_agent::tools::WORK_SESSION_END.to_string(),
        arguments: json!({"session_id": Uuid::new_v4().to_string()}),
    };

    // The card `record_tool_call` posts before anything executes — same spine,
    // same shipped key function, so the key space really is occupied.
    let card = call.clone();
    momo_db::with_tenant_tx(&worker_pool, workspace, move |conn| {
        Box::pin(async move {
            send_message_in_tx(
                conn,
                workspace,
                NewMessage {
                    channel_id: channel,
                    author_member_id: agent,
                    message_type: MessageType::ToolCall,
                    body: Some(card.message_body()),
                    props: card.message_props(),
                    root_id: None,
                    reply_to_id: None,
                    client_msg_id: Some(tool_exec::call_message_id(run, CALL_ID)),
                    run_id: Some(run),
                    hlc_ts: None,
                    hlc_count: None,
                },
            )
            .await?;
            Ok(())
        })
    })
    .await
    .expect("post the tool_call card");

    let context = ToolContext {
        workspace_id: workspace,
        run_id: run,
        channel_id: channel,
        agent_member_id: agent,
        approved_by: tenant.human,
        approved_host_id: None,
    };

    let first = tool_exec::execute(&worker_pool, &context, &call)
        .await
        .expect("execute");
    assert!(
        first.is_error && first.output.contains("not found"),
        "the staged call is refused without touching anything: {first:?}"
    );
    assert_eq!(
        tool_rows(&su, workspace, run).await,
        vec!["tool_call".to_string(), "tool_result".to_string()],
        "**red proof 2**: the answer is on the spine next to the ask"
    );

    // The replay a re-claimed job performs.
    let replayed = tool_exec::execute(&worker_pool, &context, &call)
        .await
        .expect("replay");
    assert_eq!(
        replayed.output, first.output,
        "a replay answers the model the same thing"
    );
    assert_eq!(
        tool_rows(&su, workspace, run).await,
        vec!["tool_call".to_string(), "tool_result".to_string()],
        "**red proof 1**: still one result — the key is idempotent, just no \
         longer the card's"
    );
}

/// The run's tool rows in spine order, as type labels.
async fn tool_rows(su: &PgPool, workspace: Uuid, run: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT type::text FROM message \
          WHERE workspace_id = $1 AND run_id = $2 \
            AND type IN ('tool_call', 'tool_result') \
          ORDER BY seq",
    )
    .bind(workspace)
    .bind(run)
    .fetch_all(su)
    .await
    .expect("read the run's tool rows")
}
