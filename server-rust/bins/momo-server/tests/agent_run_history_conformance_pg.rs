//! DB-backed conformance for the three **reads** of the agent-run record
//! (#1223 — Swift `AgentRunRoutes.list`/`listByAgent`/`detail` parity).
//!
//! Before this goal the record was write-only on this server. Rows had been
//! accumulating since B2.6 — created by `POST …/channels/{ch}/agent-runs`,
//! advanced by the gateway callbacks — and no request could see any of them:
//! the channel path was mounted `POST`-only so a read answered **405**, and the
//! other two answered **404**. Both clients had been calling all three since the
//! Swift server, and `packages/momo-core`'s surface table folded the whole
//! feature away rather than drawing the absence as a fault.
//!
//! These tests are the proof that a person can now look, and each is written so
//! that a revert shows up as *the wrong person seeing someone else's work*
//! rather than as a missing column.
//!
//! They are `#[ignore]` because they need a `pgvector/pgvector:pg18` superuser DB
//! plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test agent_run_history_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract, identical to `agent_run_cancel_conformance_pg.rs`:
//! `DATABASE_URL` connects as a **superuser** (migrations +
//! `infra/e2e/bootstrap_roles.sql`, fixtures bypass RLS); the **server** runs on
//! `momo_app` (NOBYPASSRLS) so every assertion below is made through the
//! policies production uses.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `history_1_the_channel_list_is_mounted_and_is_the_rooms` | unmount the `GET` (the route answers 405 again), drop the membership check, or drop the `input->>'type' = 'work'` predicate so mention runs leak into the work surface |
//! | `history_2_the_agent_history_pages_by_keyset_over_visible_rooms_only` | drop the `JOIN membership visible` (runs from a room the reader never entered appear), use an `OFFSET` instead of the `(created_at, id)` keyset, or always report a `nextCursor` |
//! | `history_3_the_history_summary_carries_no_brief` | widen the summary projection to the full run row — the brief a person typed in one channel then crosses into a workspace-global page |
//! | `history_4_a_bad_cursor_and_an_unknown_agent_are_named_not_empty` | answer an empty page for an unseen cursor, or 200 for an agent that does not exist |
//! | `history_5_the_detail_read_is_the_rooms_too` | drop the `has_channel_membership` gate, or collapse the 403 into a 404 so a client cannot tell "another channel's work" from "no such work" |

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

const TEST_JWT_SECRET: &str = "issue-1223-run-history-conformance-secret";
const TEST_PASSWORD: &str = "issue-1223-conformance-password";
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

/// A workspace with two rooms. Two is the minimum that can tell "this reader
/// sees the whole workspace" apart from "this reader sees the rooms they are
/// in", which is the only property the history page's `JOIN` exists for.
struct Tenant {
    workspace: Uuid,
    /// In both rooms.
    insider: Uuid,
    insider_email: String,
    /// In `open_channel` only. The reader whose page must stay short.
    outsider: Uuid,
    outsider_email: String,
    open_channel: Uuid,
    private_channel: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, display: &str) -> (Uuid, String) {
    let human = Uuid::new_v4();
    let email = format!("{human}@issue1223.test");
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

async fn seed_channel(su: &PgPool, app: &PgPool, workspace: Uuid, creator: Uuid) -> Uuid {
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("i1223-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: creator,
        },
    )
    .await
    .expect("create channel")
    .id;
    // `create_channel` seeds the creator's membership; nothing else joins by
    // default, which is exactly the asymmetry these tests need.
    let _ = su;
    channel
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

async fn seed_tenant(su: &PgPool, app: &PgPool) -> Tenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    let (insider, insider_email) = seed_human(su, workspace, "owner", "성재").await;
    let (outsider, outsider_email) = seed_human(su, workspace, "member", "동료").await;

    let open_channel = seed_channel(su, app, workspace, insider).await;
    let private_channel = seed_channel(su, app, workspace, insider).await;
    join_channel(su, workspace, open_channel, outsider).await;

    Tenant {
        workspace,
        insider,
        insider_email,
        outsider,
        outsider_email,
        open_channel,
        private_channel,
    }
}

async fn seed_agent(su: &PgPool, tenant: &Tenant, handle: &str, channels: &[Uuid]) -> Uuid {
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
    .bind(tenant.insider)
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
    for channel in channels {
        join_channel(su, tenant.workspace, *channel, agent).await;
    }
    agent
}

/// One run, with `created_at` chosen by the caller.
///
/// The clock is explicit because the history page is ordered by
/// `(created_at, id)` and `now()` inside one transaction would hand every seeded
/// row the same instant — an order that only the tie-break decides is an order
/// the test cannot distinguish from a broken one.
#[allow(clippy::too_many_arguments)]
async fn seed_run(
    su: &PgPool,
    tenant: &Tenant,
    agent: Uuid,
    channel: Uuid,
    status: &str,
    input: Value,
    age_seconds: i64,
) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key, \
            created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5::run_status, $6, $7, \
                 now() - make_interval(secs => $8::double precision), \
                 now() - make_interval(secs => $8::double precision))",
    )
    .bind(run)
    .bind(tenant.workspace)
    .bind(agent)
    .bind(channel)
    .bind(status)
    .bind(&input)
    .bind(format!("i1223:{run}"))
    .bind(age_seconds as f64)
    .execute(su)
    .await
    .expect("seed agent run");
    run
}

fn work_input(title: &str, brief: &str) -> Value {
    json!({"type": "work", "title": title, "brief": brief})
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

async fn get(http: &reqwest::Client, base: &str, token: &str, path: &str) -> reqwest::Response {
    http.get(format!("{base}{path}"))
        .bearer_auth(token)
        .send()
        .await
        .expect("GET")
}

async fn json_body(response: reqwest::Response) -> Value {
    response.json().await.expect("json body")
}

fn ids(page: &Value, key: &str) -> Vec<String> {
    page[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} is an array in {page}"))
        .iter()
        .map(|run| run["id"].as_str().expect("id").to_lowercase())
        .collect()
}

// ---------------------------------------------------------------------------
// 1 — the channel list
// ---------------------------------------------------------------------------

/// **The read that used to be a 405 answers, and it answers to the room.**
///
/// Three properties in one round trip, because they are one decision: the route
/// exists for `GET`, the caller has to be in the channel, and what comes back is
/// the *work* history — not every run that ever touched the room. The mention
/// run seeded below is the discriminator for the third: it lives in the same
/// channel, was raised by the same agent, and must not appear, because the
/// channel run list is the work surface's history and a mention's history is the
/// timeline itself.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn history_1_the_channel_list_is_mounted_and_is_the_rooms() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(
        &su,
        &tenant,
        "hermes",
        &[tenant.open_channel, tenant.private_channel],
    )
    .await;

    let newer = seed_run(
        &su,
        &tenant,
        agent,
        tenant.open_channel,
        "running",
        work_input("배포 준비", "스테이징에 올려줘"),
        10,
    )
    .await;
    let older = seed_run(
        &su,
        &tenant,
        agent,
        tenant.open_channel,
        "succeeded",
        work_input("로그 정리", "옛날 로그 지워줘"),
        600,
    )
    .await;
    let mention = seed_run(
        &su,
        &tenant,
        agent,
        tenant.open_channel,
        "succeeded",
        json!({"surface": "mention", "prompt": "이거 뭐야?"}),
        5,
    )
    .await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let insider = login(&http, &base, tenant.workspace, &tenant.insider_email).await;

    let path = format!(
        "/v1/workspaces/{}/channels/{}/agent-runs",
        tenant.workspace, tenant.open_channel
    );
    let response = get(&http, &base, &insider, &path).await;
    assert_eq!(
        response.status(),
        200,
        "the channel run list is mounted for GET — this is the 405 that made the \
         client fold the whole surface away"
    );
    let page = json_body(response).await;
    assert_eq!(
        ids(&page, "runs"),
        vec![newer.to_string(), older.to_string()],
        "newest first, and the mention run ({mention}) is not work history"
    );
    assert_eq!(
        page["runs"][0]["triggerSummary"],
        json!("배포 준비"),
        "the excerpt a list renders comes from the run's own input"
    );
    assert_eq!(page["runs"][0]["status"], json!("running"));

    // `?type=` is a closed vocabulary: an unsupported value is named, because an
    // empty page would say "there were none" about a surface that does not exist.
    let refused = get(&http, &base, &insider, &format!("{path}?type=mention")).await;
    assert_eq!(refused.status(), 400, "only type=work is supported");
    let ok = get(&http, &base, &insider, &format!("{path}?type=work&limit=1")).await;
    assert_eq!(ok.status(), 200);
    assert_eq!(ids(&json_body(ok).await, "runs"), vec![newer.to_string()]);

    // The room is the authorization. A workspace member who is not in this
    // channel is refused rather than served an empty list.
    let outsider = login(&http, &base, tenant.workspace, &tenant.outsider_email).await;
    let private = format!(
        "/v1/workspaces/{}/channels/{}/agent-runs",
        tenant.workspace, tenant.private_channel
    );
    let forbidden = get(&http, &base, &outsider, &private).await;
    assert_eq!(
        forbidden.status(),
        403,
        "a room the caller is not in refuses; it does not answer an empty page"
    );
}

// ---------------------------------------------------------------------------
// 2 — one agent's workspace-global history
// ---------------------------------------------------------------------------

/// **The history page spans the workspace, and stops at the reader's rooms.**
///
/// This is the test the whole MOMO-653 projection exists for. One agent works in
/// two channels; the reader is in one of them. Everything the agent did in the
/// other must be absent — not truncated, not redacted, absent — and the keyset
/// has to keep meaning the same boundary while it pages.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn history_2_the_agent_history_pages_by_keyset_over_visible_rooms_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(
        &su,
        &tenant,
        "hermes",
        &[tenant.open_channel, tenant.private_channel],
    )
    .await;

    let first = seed_run(
        &su,
        &tenant,
        agent,
        tenant.open_channel,
        "succeeded",
        work_input("첫 번째", "b"),
        30,
    )
    .await;
    let second = seed_run(
        &su,
        &tenant,
        agent,
        tenant.open_channel,
        "running",
        work_input("두 번째", "b"),
        20,
    )
    .await;
    let third = seed_run(
        &su,
        &tenant,
        agent,
        tenant.open_channel,
        "failed",
        work_input("세 번째", "b"),
        10,
    )
    .await;
    let hidden = seed_run(
        &su,
        &tenant,
        agent,
        tenant.private_channel,
        "succeeded",
        work_input("보이면 안 되는 것", "다른 방의 브리프"),
        15,
    )
    .await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let outsider = login(&http, &base, tenant.workspace, &tenant.outsider_email).await;
    let path = format!("/v1/workspaces/{}/agents/{agent}/runs", tenant.workspace);

    let response = get(&http, &base, &outsider, &path).await;
    assert_eq!(response.status(), 200, "the agent history is mounted");
    let page = json_body(response).await;
    assert_eq!(
        ids(&page, "runs"),
        vec![third.to_string(), second.to_string(), first.to_string()],
        "newest first, and the run in the room this reader never joined ({hidden}) \
         is not in the page at all"
    );
    assert!(
        page.get("nextCursor").is_none() || page["nextCursor"].is_null(),
        "a complete page reports no cursor, so a client does not page into nothing: {page}"
    );

    // Two pages of one, walked by the cursor the server hands back. The second
    // page must continue rather than restart — an OFFSET would repeat `third`
    // the moment anything else was inserted.
    let page1 = json_body(get(&http, &base, &outsider, &format!("{path}?limit=1")).await).await;
    assert_eq!(ids(&page1, "runs"), vec![third.to_string()]);
    let cursor = page1["nextCursor"].as_str().expect("a further page exists");
    assert_eq!(cursor.to_lowercase(), third.to_string());
    let page2 = json_body(
        get(
            &http,
            &base,
            &outsider,
            &format!("{path}?limit=1&cursor={cursor}"),
        )
        .await,
    )
    .await;
    assert_eq!(ids(&page2, "runs"), vec![second.to_string()]);
    let cursor2 = page2["nextCursor"].as_str().expect("one more page");
    let page3 = json_body(
        get(
            &http,
            &base,
            &outsider,
            &format!("{path}?limit=1&cursor={cursor2}"),
        )
        .await,
    )
    .await;
    assert_eq!(ids(&page3, "runs"), vec![first.to_string()]);
    assert!(
        page3.get("nextCursor").is_none() || page3["nextCursor"].is_null(),
        "the last page says it is the last: {page3}"
    );

    // The reader who IS in both rooms sees both rooms — the join narrows by
    // membership, not by channel identity.
    let insider = login(&http, &base, tenant.workspace, &tenant.insider_email).await;
    let full = json_body(get(&http, &base, &insider, &path).await).await;
    assert_eq!(
        ids(&full, "runs"),
        vec![
            third.to_string(),
            hidden.to_string(),
            second.to_string(),
            first.to_string()
        ],
        "someone in both rooms sees all four, interleaved by time"
    );
}

// ---------------------------------------------------------------------------
// 3 — what the summary refuses to carry
// ---------------------------------------------------------------------------

/// **A workspace-global page carries an excerpt, never the brief.**
///
/// The page is reachable by anyone who shares a room with the agent, so the
/// object a person typed into one channel is not theirs to read from an agent
/// hub. `triggerSummary` is the one sentence that crosses, bounded; `input`,
/// `output` and `error` do not appear at all. The full projection stays behind
/// the run-detail read, which is gated on the run's own room.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn history_3_the_history_summary_carries_no_brief() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(&su, &tenant, "hermes", &[tenant.open_channel]).await;
    let secret_brief = "여기 절대 새면 안 되는 브리프 본문";
    let run = seed_run(
        &su,
        &tenant,
        agent,
        tenant.open_channel,
        "succeeded",
        work_input("요약만 보인다", secret_brief),
        10,
    )
    .await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.outsider_email).await;
    let page = json_body(
        get(
            &http,
            &base,
            &token,
            &format!("/v1/workspaces/{}/agents/{agent}/runs", tenant.workspace),
        )
        .await,
    )
    .await;

    let raw = page.to_string();
    assert!(
        !raw.contains(secret_brief),
        "the brief must not cross into a workspace-global page: {raw}"
    );
    let summary = &page["runs"][0];
    assert_eq!(
        summary["id"].as_str().map(str::to_lowercase),
        Some(run.to_string())
    );
    assert_eq!(summary["triggerSummary"], json!("요약만 보인다"));
    let mut keys: Vec<&str> = summary
        .as_object()
        .expect("a summary object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "channelId",
            "createdAtMs",
            "id",
            "status",
            "triggerSummary",
            "updatedAtMs"
        ],
        "openapi AgentRunSummary is additionalProperties:false — every absent \
         key here is a field that must never be added by accident"
    );
}

// ---------------------------------------------------------------------------
// 4 — the two refusals the page owes a client
// ---------------------------------------------------------------------------

/// **A handle the reader cannot hold is named, not silently emptied.**
///
/// An empty page means "you have reached the end". Answering it to a client
/// holding a cursor out of another agent's history — or asking after an agent
/// that does not exist — would be a lie about the reader's own data, and a
/// paging loop that never terminates for the right reason.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn history_4_a_bad_cursor_and_an_unknown_agent_are_named_not_empty() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(&su, &tenant, "hermes", &[tenant.open_channel]).await;
    seed_run(
        &su,
        &tenant,
        agent,
        tenant.open_channel,
        "succeeded",
        work_input("보이는 것", "b"),
        10,
    )
    .await;
    // A run of the same agent in a room the outsider never joined: a real id,
    // and still not a cursor this reader may page from.
    let unseen = seed_run(
        &su,
        &tenant,
        agent,
        tenant.private_channel,
        "succeeded",
        work_input("안 보이는 것", "b"),
        20,
    )
    .await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.outsider_email).await;
    let path = format!("/v1/workspaces/{}/agents/{agent}/runs", tenant.workspace);

    for (cursor, why) in [
        (
            unseen.to_string(),
            "a real run in a room this reader is not in",
        ),
        (Uuid::new_v4().to_string(), "a run id that does not exist"),
    ] {
        let response = get(&http, &base, &token, &format!("{path}?cursor={cursor}")).await;
        assert_eq!(response.status(), 400, "{why}");
    }
    let malformed = get(&http, &base, &token, &format!("{path}?cursor=not-a-uuid")).await;
    assert_eq!(malformed.status(), 400, "a cursor that is not a uuid");

    let unknown_agent = get(
        &http,
        &base,
        &token,
        &format!(
            "/v1/workspaces/{}/agents/{}/runs",
            tenant.workspace,
            Uuid::new_v4()
        ),
    )
    .await;
    assert_eq!(
        unknown_agent.status(),
        404,
        "an agent that does not exist is not an agent with no history"
    );

    // The human-only gate: the agent hub is a person's surface. (Asserted
    // through the human path here because no agent bearer can reach the route
    // at all — `momo_auth::required_agent_scope` does not list it.)
    assert_eq!(
        get(&http, &base, &token, &path).await.status(),
        200,
        "a human workspace member reads it"
    );
}

// ---------------------------------------------------------------------------
// 5 — one run in full
// ---------------------------------------------------------------------------

/// **The detail read is the room's, and it says which of the two "no"s it means.**
///
/// A run in a channel the caller is not in answers 403 while a run that does not
/// exist answers 404. Collapsing them would cost a client the sentence it needs:
/// "이 작업은 다른 채널의 것입니다" and "없는 작업입니다" are different things to
/// tell a person, and under RLS the 403 discloses nothing a cross-tenant caller
/// could ever reach.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn history_5_the_detail_read_is_the_rooms_too() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(
        &su,
        &tenant,
        "hermes",
        &[tenant.open_channel, tenant.private_channel],
    )
    .await;
    let visible = seed_run(
        &su,
        &tenant,
        agent,
        tenant.open_channel,
        "running",
        work_input("열린 방의 작업", "브리프 본문"),
        10,
    )
    .await;
    let hidden = seed_run(
        &su,
        &tenant,
        agent,
        tenant.private_channel,
        "succeeded",
        work_input("닫힌 방의 작업", "다른 방 브리프"),
        20,
    )
    .await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.outsider_email).await;
    let detail = |run: Uuid| format!("/v1/workspaces/{}/agent-runs/{run}", tenant.workspace);

    let response = get(&http, &base, &token, &detail(visible)).await;
    assert_eq!(response.status(), 200, "a run in the caller's room reads");
    let body = json_body(response).await;
    assert_eq!(
        body["id"].as_str().map(str::to_lowercase),
        Some(visible.to_string())
    );
    assert_eq!(
        body["input"]["brief"],
        json!("브리프 본문"),
        "the detail read is the full projection — this is where the brief lives"
    );
    assert_eq!(body["status"], json!("running"));
    assert_eq!(body["stepCount"], json!(0));
    assert_eq!(
        body["workspaceId"].as_str().map(str::to_lowercase),
        Some(tenant.workspace.to_string()),
        "the detail carries the fields the summary refuses to"
    );

    assert_eq!(
        get(&http, &base, &token, &detail(hidden)).await.status(),
        403,
        "a run in a room this caller is not in is refused, not hidden as absent"
    );
    assert_eq!(
        get(&http, &base, &token, &detail(Uuid::new_v4()))
            .await
            .status(),
        404,
        "a run that does not exist here is absent, not refused"
    );

    // The member of both rooms reads both, which is what makes the 403 above a
    // statement about the reader rather than about the run.
    let insider_token = login(&http, &base, tenant.workspace, &tenant.insider_email).await;
    assert_eq!(
        get(&http, &base, &insider_token, &detail(hidden))
            .await
            .status(),
        200
    );
    let _ = tenant.insider;
    let _ = tenant.outsider;
}
