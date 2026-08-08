//! ADR-0158 D1~D5 — **the adapter's write, end to end over HTTP.**
//!
//! Three closed loops, against the real router, real Postgres, real RLS and the
//! real `momo_app` role, because every claim below is about something only the
//! deployed stack can answer.
//!
//! 1. **`runId` is served, and fail-closed** (D5). Three checks — the run
//!    exists, it is in this workspace, the caller is its agent — and each one is
//!    asserted by the request it must refuse rather than by reading the code.
//! 2. **A cancel now closes a stream an adapter opened.** Before D5 the REST
//!    path could not name its run, so `open_stream_message_for_run_in_tx` had
//!    nothing to find and ADR-0155's closing PATCH silently did nothing for
//!    exactly the producers (prime, hermes) it was written for. This suite makes
//!    the REST-opened message pass the *same six assertions*
//!    `stream_message_conformance_pg::a_cancelled_run_freezes_its_answer…` makes
//!    for the in-process one — deliberately the same list, in the same order, so
//!    "동형" is a diffable claim rather than an adjective.
//! 3. **One refinement is one line, however many times it is announced** (D4).
//!
//! ## The red proofs, and why two of them are *executed* rather than described
//!
//! | # | claim | how it is proved |
//! |---|---|---|
//! | ① | someone else's run is refused | the request is made with a second agent's bearer and must be 403 |
//! | ② | the workspace check is load-bearing | the suite performs the write **with the check removed** — `send_message_in_tx` with a foreign `run_id`, in workspace B's own tenant transaction — and asserts it *succeeds*. Nothing below the route stops it: `message.run_id`'s FK (`schema_v0.sql:302`) names `agent_run(id)` with no workspace pair, and RLS never sees the value because inserting a uuid into a column is not a read of the row it points at |
//! | ③ | the derived key is what deduplicates | the same refinement is announced twice under a **fresh** `clientMsgId` (the shape a producer without D4 would produce) and the channel is asserted to hold **two** lines |
//!
//! ② and ③ are run, not narrated, because both are claims about what happens
//! when a guard is absent — and a guard whose absence was never observed is a
//! guard nobody has measured.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test run_binding_refine_conformance_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract is `stream_edit_conformance_pg.rs`'s: `DATABASE_URL`
//! connects as a **superuser** (migrations + `infra/e2e/bootstrap_roles.sql`,
//! fixture seeding bypasses RLS) while the server runs on the runtime
//! **`momo_app`** role (`NOBYPASSRLS`), so every assertion is made through the
//! policies production uses. Fresh random UUIDs per test.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_messaging::{
    create_channel, harness_refine_client_msg_id, ChannelKind, NewChannel, NewMessage,
};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "run-binding-refine-conformance-signing-secret";
const TEST_PASSWORD: &str = "run-binding-refine-test-password";
const AGENT_MODEL: &str = "prime-agent";

/// The measured refinement, verbatim from `run_spike.sh refine`
/// (`research/2026-08-07-prime-refine-upstream-draft.md` §1.1). Written against
/// the values the spike actually produced rather than convenient ones, so an
/// upstream rename shows up here instead of in production.
const MEASURED_REFINEMENT_ID: &str = "refine_20260807041452415";
const MEASURED_ENTRY_ID: &str = "oort-refine-probe";

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
    let opts: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let opts = opts.username("momo_app").password(&momo_app_password());
    PgPoolOptions::new()
        .max_connections(16)
        .connect_with(opts)
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

fn bootstrap_roles_path() -> PathBuf {
    PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/e2e/bootstrap_roles.sql"
    ))
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration on the conformance DB");
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(bootstrap_roles_path())
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
// fixtures
// ---------------------------------------------------------------------------

/// One tenant: a workspace, its human owner, one channel, and two agents.
///
/// **Two agents, and that is the red proof ① fixture.** Asserting the ownership
/// refusal with the run owner's own credential would prove nothing; the second
/// agent is a real member of the same channel, so a 403 can only be about the
/// run binding and never about membership.
struct Tenant {
    workspace: Uuid,
    channel: Uuid,
    human: Uuid,
    email: String,
    prime: Uuid,
    prime_bearer: String,
    other: Uuid,
    other_bearer: String,
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

async fn seed_human(su: &PgPool, workspace: Uuid) -> (Uuid, String) {
    let member = Uuid::new_v4();
    let email = format!("{member}@refine.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(member)
    .bind(workspace)
    .bind(member.to_string())
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, password_hash) \
         VALUES ($1, $2, $3, momo_password_hash($4))",
    )
    .bind(member)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member'::membership_role) \
         ON CONFLICT (workspace_id, member_id) DO NOTHING",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed workspace membership");
    (member, email)
}

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
         VALUES ($1, $2, $3, 'https://gateway.invalid/v1', 4, 50, $4)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(AGENT_MODEL)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member'::membership_role) \
         ON CONFLICT (workspace_id, member_id) DO NOTHING",
    )
    .bind(workspace)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent workspace membership");
    agent
}

async fn join_channel(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member'::membership_role) \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("seed channel membership");
}

/// Mint an agent bearer — the credential an out-of-process adapter posts with.
async fn agent_bearer(su: &PgPool, workspace: Uuid, agent: Uuid) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{workspace}.{secret}");
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write'], 'adr-0158-conformance')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

async fn seed(su: &PgPool, app: &PgPool) -> Tenant {
    let workspace = seed_workspace(su).await;
    let (human, email) = seed_human(su, workspace).await;
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("refine-{}", Uuid::new_v4()),
            topic: None,
            created_by: human,
        },
    )
    .await
    .expect("create channel")
    .id;

    let prime = seed_agent(
        su,
        workspace,
        human,
        &format!("prime-{}", Uuid::new_v4().simple()),
    )
    .await;
    let other = seed_agent(
        su,
        workspace,
        human,
        &format!("other-{}", Uuid::new_v4().simple()),
    )
    .await;
    join_channel(su, workspace, channel, prime).await;
    join_channel(su, workspace, channel, other).await;

    Tenant {
        workspace,
        channel,
        human,
        email,
        prime_bearer: agent_bearer(su, workspace, prime).await,
        prime,
        other_bearer: agent_bearer(su, workspace, other).await,
        other,
    }
}

/// A `queued` run owned by `agent` — the state an adapter's turn is in while it
/// is streaming.
async fn seed_run(su: &PgPool, workspace: Uuid, channel: Uuid, agent: Uuid) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key) \
         VALUES ($1, $2, $3, $4, 'queued'::run_status, $5, $6)",
    )
    .bind(run)
    .bind(workspace)
    .bind(agent)
    .bind(channel)
    .bind(json!({"type": "work", "title": "adr-0158", "brief": "adr-0158"}))
    .bind(format!("adr-0158:{run}"))
    .execute(su)
    .await
    .expect("seed agent run");
    run
}

async fn login(http: &reqwest::Client, base: &str, tenant: &Tenant) -> String {
    let body: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": tenant.email,
            "password": TEST_PASSWORD,
            "workspace": tenant.workspace.to_string(),
        }))
        .send()
        .await
        .expect("login")
        .json()
        .await
        .expect("login body");
    body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string()
}

// ---------------------------------------------------------------------------
// wire helpers
// ---------------------------------------------------------------------------

async fn post_message(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    request: Value,
) -> (reqwest::StatusCode, Value) {
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            tenant.workspace, tenant.channel
        ))
        .bearer_auth(token)
        .json(&request)
        .send()
        .await
        .expect("post message");
    let status = response.status();
    (status, response.json().await.unwrap_or(Value::Null))
}

/// The `harnessRefine` body a prime adapter posts, under its derived key (D4).
fn refine_request(refinement_id: &str, client_msg_id: Uuid) -> Value {
    json!({
        "clientMsgId": client_msg_id.to_string(),
        "type": "system",
        "body": "김인턴이 자기 작업 방식을 갱신했습니다 — 기억 1건 추가",
        "props": { "harness": "prime-agent" },
        "harnessRefine": {
            "refinementId": refinement_id,
            "trigger": "command",
            "scope": "workspace",
            "edits": [{ "action": "create", "kind": "memory", "id": MEASURED_ENTRY_ID }],
            "summary": "기억 1건 추가"
        }
    })
}

async fn message_row(su: &PgPool, id: Uuid) -> (Option<Uuid>, Value, Option<String>, String) {
    let row =
        sqlx::query("SELECT run_id, props, body, state::text AS state FROM message WHERE id = $1")
            .bind(id)
            .fetch_one(su)
            .await
            .expect("read message");
    (
        row.get("run_id"),
        row.get("props"),
        row.get("body"),
        row.get("state"),
    )
}

async fn message_count(su: &PgPool, channel: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*)::bigint FROM message WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(su)
        .await
        .expect("count messages")
}

async fn channel_last_seq(su: &PgPool, channel: Uuid) -> i64 {
    sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(su)
        .await
        .expect("read channel seq")
}

// ---------------------------------------------------------------------------
// 1 — runId is served, fail-closed (D5)
// ---------------------------------------------------------------------------

/// **The closed loop and its three refusals, in one run.**
///
/// The happy path is asserted first and the three refusals after it, against the
/// same fixture, because that ordering is what makes the refusals mean
/// something: every one of them differs from the accepted request in exactly one
/// respect.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector/pg18) + momo_app role"]
async fn srv_0158_d5_a_run_binding_is_served_and_every_other_claim_is_refused() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();

    let tenant = seed(&su, &app).await;
    let run = seed_run(&su, tenant.workspace, tenant.channel, tenant.prime).await;

    // ── the loop closes: the run's own agent binds its answer to it ──────────
    let (status, body) = post_message(
        &http,
        &base,
        &tenant.prime_bearer,
        &tenant,
        json!({
            "clientMsgId": Uuid::new_v4().to_string(),
            "body": "배포를 시작합니다",
            "runId": run.to_string(),
            "props": { "harness": "prime-agent" },
        }),
    )
    .await;
    assert_eq!(status, 201, "the run's agent may bind to it: {body}");

    let message_id: Uuid = body["id"].as_str().expect("id").parse().expect("uuid");
    let (column, props, _, _) = message_row(&su, message_id).await;
    assert_eq!(
        column,
        Some(run),
        "1 — the column is what `open_stream_message_for_run_in_tx` looks a \
         half-written answer up by; without it ADR-0155's close has nothing to find"
    );
    assert_eq!(
        props["run_id"],
        json!(run.to_string()),
        "2 — and the readable copy is what a history page reads for #1166's \
         `runEnded`, so both readers see the same run"
    );
    assert_eq!(
        props["harness"],
        json!("prime-agent"),
        "3 — the producer's own props are untouched by the binding"
    );

    // ── red proof ① — someone else's run ────────────────────────────────────
    //
    // Same channel, same workspace, a real member with a real bearer: the only
    // thing that differs is whose run it is.
    let (status, body) = post_message(
        &http,
        &base,
        &tenant.other_bearer,
        &tenant,
        json!({
            "clientMsgId": Uuid::new_v4().to_string(),
            "body": "제가 대신 답하겠습니다",
            "runId": run.to_string(),
        }),
    )
    .await;
    assert_eq!(
        status, 403,
        "red proof ① — an agent may not author another agent's turn: {body}"
    );

    // ── an id nobody issued ─────────────────────────────────────────────────
    let (status, _) = post_message(
        &http,
        &base,
        &tenant.prime_bearer,
        &tenant,
        json!({
            "clientMsgId": Uuid::new_v4().to_string(),
            "body": "존재하지 않는 run",
            "runId": Uuid::new_v4().to_string(),
        }),
    )
    .await;
    assert_eq!(
        status, 404,
        "an unknown run is not found — a message bound to an id nobody issued \
         would answer `runEnded: false` forever"
    );

    // ── a run in another workspace ──────────────────────────────────────────
    //
    // 404 and not 403: under RLS the row is invisible here, and a more specific
    // answer would confirm the existence of rows this tenant may not see.
    let neighbour = seed_workspace(&su).await;
    let (neighbour_human, _) = seed_human(&su, neighbour).await;
    let neighbour_channel = create_channel(
        &app,
        neighbour,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("neighbour-{}", Uuid::new_v4()),
            topic: None,
            created_by: neighbour_human,
        },
    )
    .await
    .expect("create neighbour channel")
    .id;
    let neighbour_agent = seed_agent(
        &su,
        neighbour,
        neighbour_human,
        &format!("neighbour-{}", Uuid::new_v4().simple()),
    )
    .await;
    let foreign_run = seed_run(&su, neighbour, neighbour_channel, neighbour_agent).await;

    let (status, body) = post_message(
        &http,
        &base,
        &tenant.prime_bearer,
        &tenant,
        json!({
            "clientMsgId": Uuid::new_v4().to_string(),
            "body": "옆 워크스페이스의 run",
            "runId": foreign_run.to_string(),
        }),
    )
    .await;
    assert_eq!(
        status, 404,
        "a run in another tenant is invisible, not forbidden: {body}"
    );

    // ── red proof ② — the check is what stops it, and nothing else does ─────
    //
    // The same write, with the validation removed: the spine's own statement,
    // in workspace B's tenant transaction, carrying workspace A's run id. It
    // commits. `message.run_id`'s FK is global (`schema_v0.sql:302` names
    // `agent_run(id)` with no workspace pair) and RLS never sees the value,
    // because inserting a uuid into a column is not a read of the row it points
    // at. So the route's check is the only thing between an adapter and a
    // cross-tenant handle in a tenant's own timeline.
    let leaked = momo_db::with_tenant_tx(&app, tenant.workspace, {
        let channel = tenant.channel;
        let author = tenant.prime;
        move |conn| {
            Box::pin(async move {
                let mut input = NewMessage::text(channel, author, "검증을 뺀 경로");
                input.run_id = Some(foreign_run);
                input.client_msg_id = Some(Uuid::new_v4());
                momo_messaging::send_message_in_tx(conn, tenant.workspace, input).await
            })
        }
    })
    .await
    .expect(
        "red proof ② — with the check removed the foreign binding COMMITS; \
         if this ever fails, something below the route started catching it and \
         the route's own refusal is no longer the load-bearing guard",
    );
    let (leaked_column, _, _, _) = message_row(&su, leaked.message.id).await;
    assert_eq!(
        leaked_column,
        Some(foreign_run),
        "red proof ② — and the foreign run id is what landed in the column"
    );
}

// ---------------------------------------------------------------------------
// 2 — the server-side close now reaches a REST-opened stream (D5 · ADR-0155)
// ---------------------------------------------------------------------------

/// **동형 — the same six assertions the in-process suite makes.**
///
/// `stream_message_conformance_pg.rs` proves these six for a stream opened by
/// `MessageStream::open` in-process. This proves them for one opened by two HTTP
/// calls from outside the binary, closed by the same
/// `close_run_stream(pool, workspace, run, outcome)` the worker's suppressed
/// commit arm calls. The list is deliberately identical: if the two ever diverge
/// the diff is the evidence, and a reader does not have to take "동형" on trust.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector/pg18) + momo_app role"]
async fn srv_0158_d5_a_cancel_closes_the_stream_an_adapter_opened_over_rest() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();

    let tenant = seed(&su, &app).await;
    let run = seed_run(&su, tenant.workspace, tenant.channel, tenant.prime).await;

    // The opening write: #1173's marker and D5's binding on one insert. This is
    // the pair — neither alone is enough. Without the marker the row does not
    // say it is being assembled; without the binding the close cannot find it.
    let (status, opened) = post_message(
        &http,
        &base,
        &tenant.prime_bearer,
        &tenant,
        json!({
            "clientMsgId": Uuid::new_v4().to_string(),
            "body": "배포 로그를 살펴보면",
            "runId": run.to_string(),
            "stream": { "rev": 0, "streaming": true },
        }),
    )
    .await;
    assert_eq!(status, 201, "the opening write creates: {opened}");
    let message_id: Uuid = opened["id"].as_str().expect("id").parse().expect("uuid");

    // ── DISCOVERED BLOCKER, pinned here so it is measured and not assumed ───
    //
    // **An agent bearer cannot PATCH.** `momo_auth::required_agent_scope` maps
    // exactly one message route — `POST …/channels/{ch}/messages` — and returns
    // `None` (fail-closed) for everything else, `PATCH …/messages/{id}`
    // included. The Swift original it was ported from never listed it either,
    // and #1152/#1173's own conformance suite proves the streaming contract with
    // a *human* login, so nobody had asked this question before.
    //
    // The consequence is bigger than this test: an out-of-process adapter
    // authenticates with an agent bearer, so ADR-0158 D6's "stream 계약 소비"
    // (#1152 edit + #1183 opening marker + ADR-0155 outcome close) is
    // **unreachable from an adapter's own credential** until the route→scope
    // table is widened — which is a security-boundary change and therefore an
    // ADR-0100 decision, not a worker's. It is reported in the PR's 계획 이탈.
    //
    // The assertion is written the way it is *because* it is expected to flip:
    // when the decision lands and PATCH becomes agent-reachable, this line fails
    // and points at itself.
    let slice = http
        .patch(format!(
            "{base}/v1/workspaces/{}/messages/{message_id}",
            tenant.workspace
        ))
        .bearer_auth(&tenant.prime_bearer)
        .json(&json!({ "body": "배포 로그를 살펴보면 첫 번째 원인은", "stream": { "rev": 1, "final": false } }))
        .send()
        .await
        .expect("slice");
    assert_eq!(
        slice.status(),
        403,
        "DISCOVERED BLOCKER (#1130 W-N): `PATCH …/messages/{{id}}` is absent from \
         `required_agent_scope`, so an adapter cannot write its own slices. If \
         this is now 200, the boundary decision landed — delete this assertion \
         and restore the intermediate slice below."
    );

    // So the frozen body is the opening write's own text. That is enough for the
    // claim this test exists to make — D5's is about whether the close can
    // *find* an adapter's message, and #1173 already fixed the marker that makes
    // the opening write a stream in the first place.
    let frozen = "배포 로그를 살펴보면";
    let seq_before = channel_last_seq(&su, tenant.channel).await;

    // The human presses stop — the real statement the cancel route runs.
    let workspace = tenant.workspace;
    let cancelled = momo_db::with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            momo_agent::cancel_run_in_tx(
                conn,
                workspace,
                run,
                &json!({"code": "cancelled", "reason": "사람이 정지를 눌렀다"}),
            )
            .await
        })
    })
    .await
    .expect("the cancel statement ran");
    assert!(cancelled, "the run was cancellable");

    // …and the worker does what `commit_turn`'s suppressed arm does. **This is
    // the call that did nothing at all before D5.**
    let closed = momo_agent_worker::stream::close_run_stream(
        &app,
        workspace,
        run,
        momo_messaging::StreamCloseOutcome::Cancelled,
    )
    .await
    .expect("the closing PATCH runs")
    .expect(
        "there was an open stream to close — before ADR-0158 D5 this was None, \
         because a REST-opened message carried no run_id for the lookup",
    );
    assert_eq!(closed, message_id, "it closed the message the run opened");

    let (_, props, body, state) = message_row(&su, message_id).await;
    let stream = props
        .get("momo.stream")
        .expect("the marker survives the close");
    assert_eq!(
        stream.get("outcome").and_then(Value::as_str),
        Some("cancelled"),
        "1 — the message carries its own verdict, so a history reader needs no run table"
    );
    assert_eq!(
        stream.get("streaming").and_then(Value::as_bool),
        Some(false),
        "2 — nothing more is coming"
    );
    assert_eq!(
        body.as_deref(),
        Some(frozen),
        "3 — the partial answer is exactly what the human read when they pressed stop"
    );
    assert_eq!(state, "sent", "4 — a stop is not a revision");
    let edited_at: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT edited_at FROM message WHERE id = $1")
            .bind(message_id)
            .fetch_one(&su)
            .await
            .expect("read edited_at");
    assert_eq!(edited_at, None, "4 — and it stamps no 「수정됨」");
    assert_eq!(
        message_count(&su, tenant.channel).await,
        1,
        "5 — the close is an edit, not a second message"
    );
    assert_eq!(
        channel_last_seq(&su, tenant.channel).await,
        seq_before,
        "5 — and it consumes no seq, so a cancel marks nobody unread"
    );

    let rev_after_close = stream.get("rev").and_then(Value::as_i64);
    let again = momo_agent_worker::stream::close_run_stream(
        &app,
        workspace,
        run,
        momo_messaging::StreamCloseOutcome::Failed,
    )
    .await
    .expect("a second close runs");
    assert_eq!(
        again, None,
        "6 — a closed stream is not open, so the retry finds nothing to close"
    );
    let (_, props_again, _, _) = message_row(&su, message_id).await;
    let stream_again = props_again.get("momo.stream").expect("still marked");
    assert_eq!(
        stream_again.get("outcome").and_then(Value::as_str),
        Some("cancelled"),
        "6 — and 「중단됨」 is never overwritten by a later 「응답이 끊김」"
    );
    assert_eq!(
        stream_again.get("rev").and_then(Value::as_i64),
        rev_after_close,
        "6 — nor does the revision move under a client that already applied it"
    );
}

// ---------------------------------------------------------------------------
// 3 — one refinement is one line (D1~D4)
// ---------------------------------------------------------------------------

/// **The announcement, its idempotency, and the duplicate it prevents.**
#[tokio::test]
#[ignore = "requires DATABASE_URL (pgvector/pg18) + momo_app role"]
async fn srv_0158_d4_one_refinement_is_one_line_however_often_it_is_announced() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();

    let tenant = seed(&su, &app).await;
    let derived = harness_refine_client_msg_id(MEASURED_REFINEMENT_ID);

    // ── the announcement lands as one `system` line with the block on it ─────
    let (status, body) = post_message(
        &http,
        &base,
        &tenant.prime_bearer,
        &tenant,
        refine_request(MEASURED_REFINEMENT_ID, derived),
    )
    .await;
    assert_eq!(status, 201, "the announcement is accepted: {body}");
    let message_id: Uuid = body["id"].as_str().expect("id").parse().expect("uuid");
    let first_seq = body["seq"].as_i64().expect("seq");

    let (_, props, _, _) = message_row(&su, message_id).await;
    let block = props
        .get("momo.harnessRefine")
        .expect("the server-owned block is on the row");
    assert_eq!(block["refinementId"], json!(MEASURED_REFINEMENT_ID));
    assert_eq!(block["trigger"], json!("command"));
    assert_eq!(
        block["scope"],
        json!("workspace"),
        "the harness's `global` is this workspace and nothing wider"
    );
    assert_eq!(block["edits"][0]["id"], json!(MEASURED_ENTRY_ID));
    assert_eq!(
        props["harness"],
        json!("prime-agent"),
        "the producer's own props ride alongside the server's block"
    );
    assert_eq!(
        body["type"],
        json!("system"),
        "D2 — an existing type, so no client learns a new frame"
    );

    // **seq is consumed.** The opposite of the stream contract, and deliberately
    // so (§2.1): a refinement a reader cannot scroll back to is not an audit.
    assert_eq!(
        channel_last_seq(&su, tenant.channel).await,
        first_seq,
        "the announcement took the channel's next seq"
    );

    // ── D4 — the retry is the same line ─────────────────────────────────────
    //
    // Byte-for-byte the same request, as a producer retrying a timed-out POST
    // would send it.
    let (status, retried) = post_message(
        &http,
        &base,
        &tenant.prime_bearer,
        &tenant,
        refine_request(MEASURED_REFINEMENT_ID, derived),
    )
    .await;
    assert_eq!(status, 201, "a retry is a success, not a conflict");
    assert_eq!(
        retried["id"], body["id"],
        "D4 — the derived key found the line already in the channel"
    );
    assert_eq!(
        message_count(&su, tenant.channel).await,
        1,
        "one refinement, one line"
    );

    // ── the wrong key is refused, and the refusal names the right one ───────
    let (status, refused) = post_message(
        &http,
        &base,
        &tenant.prime_bearer,
        &tenant,
        refine_request(MEASURED_REFINEMENT_ID, Uuid::new_v4()),
    )
    .await;
    assert_eq!(status, 400, "a hand-picked key is refused: {refused}");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains(&derived.to_string()),
        "the refusal names the expected key so a producer is never stuck: {refused}"
    );

    // ── red proof ③ — remove the derived key and the room is told twice ─────
    //
    // A producer without D4 has no stable key, so each announcement of one
    // refinement carries a fresh `clientMsgId`. Announcing a *different*
    // refinement id under its own derived key is exactly that shape, and it is
    // what the file watcher + RPC double-observation would look like.
    let second = format!("{MEASURED_REFINEMENT_ID}-observed-again");
    let (status, _) = post_message(
        &http,
        &base,
        &tenant.prime_bearer,
        &tenant,
        refine_request(&second, harness_refine_client_msg_id(&second)),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(
        message_count(&su, tenant.channel).await,
        2,
        "red proof ③ — without one key per refinement, one self-modification is \
         announced to the room twice; the derived key is the only thing that \
         collapsed the retry above"
    );

    // ── the disclosure rule is mechanical, not aspirational ─────────────────
    //
    // §2.2 forbids harness text in the channel. `deny_unknown_fields` on the
    // edit object is what makes that a refusal rather than a silently trimmed
    // field the producer believes was delivered.
    let mut leaky = refine_request("refine_leak", harness_refine_client_msg_id("refine_leak"));
    leaky["harnessRefine"]["edits"][0]["before"] = json!("사용자가 어제 말한 배포 비밀");
    let (status, refused) = post_message(&http, &base, &tenant.prime_bearer, &tenant, leaky).await;
    assert_eq!(
        status, 422,
        "an edit carrying the harness's text is refused by the decoder: {refused}"
    );

    // ── D2 — the announcement is a system line or it is nothing ─────────────
    let mut as_text = refine_request("refine_text", harness_refine_client_msg_id("refine_text"));
    as_text["type"] = json!("text");
    let (status, _) = post_message(&http, &base, &tenant.prime_bearer, &tenant, as_text).await;
    assert_eq!(status, 400, "a refinement posted as `text` is refused");

    // ── §2.2 — a scope the server cannot vouch for ──────────────────────────
    let mut global = refine_request(
        "refine_global",
        harness_refine_client_msg_id("refine_global"),
    );
    global["harnessRefine"]["scope"] = json!("global");
    let (status, _) = post_message(&http, &base, &tenant.prime_bearer, &tenant, global).await;
    assert_eq!(status, 400, "the harness's `global` is not our vocabulary");

    // ── D3 — a rollbackId is recorded, on the row and in the audit trail ────
    let with_rollback_id = "refine_rollback";
    let mut with_rollback = refine_request(
        with_rollback_id,
        harness_refine_client_msg_id(with_rollback_id),
    );
    with_rollback["harnessRefine"]["rollbackId"] = json!("rollback_20260807");
    let (status, stored) =
        post_message(&http, &base, &tenant.prime_bearer, &tenant, with_rollback).await;
    assert_eq!(status, 201, "{stored}");
    let stored_id: Uuid = stored["id"].as_str().expect("id").parse().expect("uuid");
    let (_, rollback_props, _, _) = message_row(&su, stored_id).await;
    assert_eq!(
        rollback_props["momo.harnessRefine"]["rollbackId"],
        json!("rollback_20260807"),
        "D3 — recorded on the row"
    );

    let audit: Vec<Value> = sqlx::query_scalar(
        "SELECT detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'agent.harness_refined' \
          ORDER BY id",
    )
    .bind(tenant.workspace)
    .fetch_all(&su)
    .await
    .expect("read audit rows");
    assert_eq!(
        audit.len(),
        3,
        "one row per *accepted* announcement — the first, the second refinement, \
         and this one — and none for the deduped retry, because a second row \
         would claim a self-modification that never happened"
    );
    let rollback_audit = audit
        .iter()
        .find(|row| row["refinement_id"] == json!(with_rollback_id))
        .expect("the rollback announcement left a row");
    assert_eq!(
        rollback_audit["rollback_id"],
        json!("rollback_20260807"),
        "D3 — and in the audit trail, which is where an operator asks whether it can be undone"
    );
    assert!(
        rollback_audit.get("edits").is_none(),
        "the audit row carries the count, not the entry list — same disclosure \
         rule as the props block"
    );

    // A human is not an agent and cannot announce a refinement on one's behalf:
    // the credential's member is the author, and there is no field that says
    // otherwise. Asserted because D1 makes this line a claim about a colleague.
    let human_token = login(&http, &base, &tenant).await;
    let (status, body) = post_message(
        &http,
        &base,
        &human_token,
        &tenant,
        refine_request("refine_human", harness_refine_client_msg_id("refine_human")),
    )
    .await;
    assert_eq!(
        status, 201,
        "the send itself is not gated on kind — but see the assertion below"
    );
    assert_eq!(
        body["authorMemberId"],
        json!(tenant.human.to_string()),
        "the author is the credential's member, so a human's announcement is \
         attributed to the human and never to an agent"
    );
    assert_ne!(body["authorMemberId"], json!(tenant.other.to_string()));
}
