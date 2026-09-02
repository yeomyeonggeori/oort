//! #1932 / ADR-0177 — member-owned sidebar sections
//! (`GET|PUT /v1/workspaces/{ws}/members/me/sidebar-prefs`).
//!
//! Red proofs (brief §서버 절반 4):
//!   1. `PUT` → `GET` round-trip: sections, placement, stars and `sectionSort`
//!      all survive, and a never-saved member reads the empty v1 default
//!   2. every ADR-0177 D3 cap is a 400 — 51 sections, an 81-character name,
//!      501 channel references, a `version` that is not 1
//!   3. an agent bearer is 403 on both verbs (an agent has no sidebar)
//!   4. one member cannot read or clobber another's prefs, and the row is
//!      invisible from another workspace's tenant transaction (RLS)
//!   5. a save emits **no** outbox row (ADR-0177 D2 — no event in v1)
//!
//! The fixtures are deliberately hostile to a shallow implementation: an
//! 80-character Korean section name (240 bytes — a byte-counting cap would
//! refuse it), many sections at once, and a channel id that names no channel at
//! all (the tolerant contract: the server stores it, the client filters it).
//!
//! `#[ignore]` — needs a real Postgres. Gate PG is the 15432 convention:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test sidebar_prefs_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "sidebar-prefs-conformance-signing-secret";
const TEST_PASSWORD: &str = "sidebar-prefs-test-password";

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

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema lock");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
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
    *ready = true;
}

async fn start_server(pool: PgPool) -> String {
    let app = build_app(AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

struct Human {
    id: Uuid,
    email: String,
}

struct Fixture {
    workspace: Uuid,
    member: Human,
    other: Human,
    agent: Uuid,
    channels: Vec<Uuid>,
}

async fn seed_workspace(su: &PgPool, hint: &str) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    workspace
}

async fn seed_human(su: &PgPool, workspace: Uuid, handle: &str) -> Human {
    let id = Uuid::new_v4();
    let email = format!("{id}@sidebar.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(handle)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
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
         VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(id)
    .execute(su)
    .await
    .expect("seed workspace membership");
    Human { id, email }
}

async fn seed_agent(su: &PgPool, workspace: Uuid, owner: Uuid) -> Uuid {
    let agent = Uuid::new_v4();
    let handle = format!("ag-{}", &agent.simple().to_string()[..8]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent \
           (member_id, workspace_id, model, base_url, max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
    )
    .bind(agent)
    .bind(workspace)
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
    .expect("seed agent membership");
    agent
}

async fn seed_public_channel(su: &PgPool, workspace: Uuid, created_by: Uuid) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', $3, '', $4)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(format!("ch-{}", &channel.simple().to_string()[..8]))
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

async fn seed(su: &PgPool, hint: &str) -> Fixture {
    let workspace = seed_workspace(su, hint).await;
    let member = seed_human(
        su,
        workspace,
        &format!("me-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let other = seed_human(
        su,
        workspace,
        &format!("ot-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let agent = seed_agent(su, workspace, member.id).await;
    let mut channels = Vec::new();
    for _ in 0..3 {
        channels.push(seed_public_channel(su, workspace, member.id).await);
    }
    Fixture {
        workspace,
        member,
        other,
        agent,
        channels,
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
    assert_eq!(response.status(), 200, "seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("login returns an access token")
        .to_string()
}

async fn agent_bearer(su: &PgPool, workspace: Uuid, agent: Uuid) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{workspace}.{secret}");
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write']::text[], 'sidebar-prefs-conformance')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

fn prefs_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/members/me/sidebar-prefs")
}

async fn error_status_message(response: reqwest::Response) -> (u16, String) {
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or_else(|_| json!({}));
    let message = body["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    (status, message)
}

async fn get_prefs(http: &reqwest::Client, base: &str, token: &str, workspace: Uuid) -> Value {
    let response = http
        .get(prefs_url(base, workspace))
        .bearer_auth(token)
        .send()
        .await
        .expect("GET sidebar-prefs");
    assert_eq!(response.status(), 200, "GET is 200");
    response.json().await.expect("GET body")
}

async fn put_prefs(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    prefs: Value,
) -> reqwest::Response {
    http.put(prefs_url(base, workspace))
        .bearer_auth(token)
        .json(&json!({ "prefs": prefs }))
        .send()
        .await
        .expect("PUT sidebar-prefs")
}

/// 80 Korean characters — 240 bytes. A cap implemented over `len()` refuses
/// this at 27 characters, so a short ASCII fixture would hide the bug.
fn long_korean_name() -> String {
    let unit = "긴급대응";
    unit.repeat(20)
}

/// A syntactically valid channel id that names no channel row. ADR-0177 D3's
/// tolerant contract: the server must store it, not 400 or silently drop it.
fn dead_channel_id() -> String {
    "00000000-0000-4000-8000-0000deadbeef".to_string()
}

// ---------------------------------------------------------------------------
// 1. round-trip
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn sidebar_prefs_put_then_get_round_trip() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "round").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;

    // A member who has never saved reads the empty v1 default, not a 404.
    let empty = get_prefs(&http, &base, &token, fixture.workspace).await;
    assert_eq!(empty["prefs"]["version"], 1);
    assert_eq!(empty["prefs"]["sections"].as_array().unwrap().len(), 0);
    assert_eq!(
        empty["prefs"]["starredChannelIds"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert!(
        empty.get("updatedAtMs").is_none(),
        "a never-saved member carries no timestamp"
    );

    let name = long_korean_name();
    assert_eq!(name.chars().count(), 80);
    assert_eq!(name.len(), 240, "the fixture is 240 bytes wide on purpose");

    let payload = json!({
        "version": 1,
        "sections": [
            {
                "id": "sec-work",
                "name": name,
                "order": 0,
                "channelIds": [
                    fixture.channels[0].to_string(),
                    fixture.channels[1].to_string(),
                ],
            },
            {
                // A section whose only channel is dead. The server stores it —
                // the client is what filters at render time.
                "id": "sec-graveyard",
                "name": "지난 분기",
                "order": 5,
                "channelIds": [dead_channel_id()],
            },
        ],
        "starredChannelIds": [fixture.channels[2].to_string()],
        "sectionSort": "manual",
    });

    let saved = put_prefs(&http, &base, &token, fixture.workspace, payload.clone()).await;
    assert_eq!(saved.status(), 200, "PUT is 200");
    let saved_body: Value = saved.json().await.expect("PUT body");
    assert!(
        saved_body["updatedAtMs"].as_i64().is_some(),
        "a stored payload carries its write timestamp"
    );

    let read = get_prefs(&http, &base, &token, fixture.workspace).await;
    assert_eq!(
        read["prefs"], saved_body["prefs"],
        "GET returns exactly what PUT stored"
    );
    let sections = read["prefs"]["sections"].as_array().expect("sections");
    assert_eq!(sections.len(), 2);
    assert_eq!(sections[0]["id"], "sec-work");
    assert_eq!(
        sections[0]["name"], name,
        "an 80-character Korean name survives"
    );
    assert_eq!(sections[0]["order"], 0);
    assert_eq!(
        sections[0]["channelIds"].as_array().unwrap().len(),
        2,
        "channel placement survives"
    );
    assert_eq!(
        sections[1]["order"], 5,
        "a sparse order is the member's, not renumbered"
    );
    assert_eq!(
        sections[1]["channelIds"][0],
        dead_channel_id(),
        "a dead channel id is stored, not refused (ADR-0177 D3 tolerant contract)"
    );
    assert_eq!(
        read["prefs"]["starredChannelIds"][0],
        fixture.channels[2].to_string(),
        "BT-5's star field is accepted by BT-4's schema"
    );
    assert_eq!(read["prefs"]["sectionSort"], "manual");

    // A second PUT replaces the whole blob — this is not a patch.
    let replaced = put_prefs(
        &http,
        &base,
        &token,
        fixture.workspace,
        json!({"version": 1, "sections": [], "starredChannelIds": []}),
    )
    .await;
    assert_eq!(replaced.status(), 200);
    let after = get_prefs(&http, &base, &token, fixture.workspace).await;
    assert_eq!(
        after["prefs"]["sections"].as_array().unwrap().len(),
        0,
        "PUT replaces; the previous sections are gone"
    );
    assert!(
        after["prefs"].get("sectionSort").is_none(),
        "a field left out of the replacement is cleared, not carried over"
    );
}

// ---------------------------------------------------------------------------
// 2. caps
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn sidebar_prefs_caps_are_refused_with_400() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "caps").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;

    let section = |i: usize, channels: usize| {
        json!({
            "id": format!("s{i}"),
            "name": format!("섹션 {i}"),
            "order": i,
            "channelIds": (0..channels)
                .map(|c| Uuid::from_u128((i * 1000 + c + 1) as u128).to_string())
                .collect::<Vec<_>>(),
        })
    };

    // 50 sections is the cap and must pass — a test that only proved the
    // refusal would also pass against a server that refused everything.
    let fifty: Vec<Value> = (0..50).map(|i| section(i, 0)).collect();
    let ok = put_prefs(
        &http,
        &base,
        &token,
        fixture.workspace,
        json!({"version": 1, "sections": fifty, "starredChannelIds": []}),
    )
    .await;
    assert_eq!(ok.status(), 200, "50 sections is legal");

    let fifty_one: Vec<Value> = (0..51).map(|i| section(i, 0)).collect();
    let (status, message) = error_status_message(
        put_prefs(
            &http,
            &base,
            &token,
            fixture.workspace,
            json!({"version": 1, "sections": fifty_one, "starredChannelIds": []}),
        )
        .await,
    )
    .await;
    assert_eq!(status, 400, "51 sections is over the ADR-0177 D3 cap");
    assert!(
        message.contains("50"),
        "the refusal names the cap it violated: {message}"
    );

    // 81 characters — again Korean, so a byte-based cap cannot pass this by
    // accident.
    let over_name = "긴".repeat(81);
    let (status, message) = error_status_message(
        put_prefs(
            &http,
            &base,
            &token,
            fixture.workspace,
            json!({
                "version": 1,
                "sections": [{"id": "s1", "name": over_name, "order": 0, "channelIds": []}],
                "starredChannelIds": [],
            }),
        )
        .await,
    )
    .await;
    assert_eq!(status, 400, "an 81-character name is refused");
    assert!(message.contains("80"), "the refusal names 80: {message}");

    // 501 references, split across two lists so a per-list cap would let it
    // through. The payload cap is on the whole blob.
    let placed: Vec<String> = (0..400u128)
        .map(|i| Uuid::from_u128(i + 1).to_string())
        .collect();
    let starred: Vec<String> = (0..101u128)
        .map(|i| Uuid::from_u128(i + 10_000).to_string())
        .collect();
    let (status, message) = error_status_message(
        put_prefs(
            &http,
            &base,
            &token,
            fixture.workspace,
            json!({
                "version": 1,
                "sections": [{"id": "s1", "name": "많음", "order": 0, "channelIds": placed}],
                "starredChannelIds": starred,
            }),
        )
        .await,
    )
    .await;
    assert_eq!(status, 400, "501 channel references is over the cap");
    assert!(message.contains("500"), "the refusal names 500: {message}");

    // version is mandatory and must be 1.
    let (status, _) = error_status_message(
        put_prefs(
            &http,
            &base,
            &token,
            fixture.workspace,
            json!({"version": 2, "sections": [], "starredChannelIds": []}),
        )
        .await,
    )
    .await;
    assert_eq!(status, 400, "an unknown payload version is refused");

    // A body with no `version` at all never reaches the validator: the field has
    // no serde default, so the closed-world decoder refuses it — 422, the same
    // answer every other `deny_unknown_fields` DTO in this server gives. The
    // distinction is the point: 400 means "I read your payload and it breaks a
    // rule", 422 means "that is not a payload". Either way ADR-0177 D3's
    // "version=1 필수" holds, and nothing is stored.
    let missing_version = http
        .put(prefs_url(&base, fixture.workspace))
        .bearer_auth(&token)
        .json(&json!({"prefs": {"sections": [], "starredChannelIds": []}}))
        .send()
        .await
        .expect("PUT without version");
    assert_eq!(
        missing_version.status(),
        422,
        "version is required, not defaulted — the decoder refuses it"
    );

    // The 50-section payload from the top of this test is still what is stored:
    // a refused PUT writes nothing.
    let stored = get_prefs(&http, &base, &token, fixture.workspace).await;
    assert_eq!(
        stored["prefs"]["sections"].as_array().unwrap().len(),
        50,
        "a 400 leaves the previous save untouched"
    );
}

// ---------------------------------------------------------------------------
// 3. agent 403
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn sidebar_prefs_refuse_an_agent_bearer() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "agent").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let bearer = agent_bearer(&su, fixture.workspace, fixture.agent).await;

    let (status, _) = error_status_message(
        http.get(prefs_url(&base, fixture.workspace))
            .bearer_auth(&bearer)
            .send()
            .await
            .expect("agent GET"),
    )
    .await;
    assert_eq!(status, 403, "an agent has no sidebar to read");

    let (status, _) = error_status_message(
        put_prefs(
            &http,
            &base,
            &bearer,
            fixture.workspace,
            json!({"version": 1, "sections": [], "starredChannelIds": []}),
        )
        .await,
    )
    .await;
    assert_eq!(status, 403, "an agent has no sidebar to write");

    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM member_sidebar_prefs WHERE workspace_id = $1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .expect("count prefs rows");
    assert_eq!(rows, 0, "a refused agent PUT wrote nothing");
}

// ---------------------------------------------------------------------------
// 4. member + tenant isolation
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn sidebar_prefs_are_invisible_to_another_member_and_another_workspace() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "iso").await;
    // The RLS probe below re-uses this pool, so the server gets a clone: both
    // halves must speak as the NOBYPASSRLS `momo_app` role.
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let mine = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    let theirs = login(&http, &base, fixture.workspace, &fixture.other.email).await;

    let saved = put_prefs(
        &http,
        &base,
        &mine,
        fixture.workspace,
        json!({
            "version": 1,
            "sections": [{
                "id": "sec-private",
                "name": "내 비밀 섹션",
                "order": 0,
                "channelIds": [fixture.channels[0].to_string()],
            }],
            "starredChannelIds": [],
        }),
    )
    .await;
    assert_eq!(saved.status(), 200);

    // The other member in the SAME workspace sees their own empty sidebar, not
    // mine — `/members/me` is the whole addressing scheme.
    let theirs_read = get_prefs(&http, &base, &theirs, fixture.workspace).await;
    assert_eq!(
        theirs_read["prefs"]["sections"].as_array().unwrap().len(),
        0,
        "another member reads their own empty default, never mine"
    );

    // …and their save cannot clobber mine.
    let their_save = put_prefs(
        &http,
        &base,
        &theirs,
        fixture.workspace,
        json!({
            "version": 1,
            "sections": [{"id": "theirs", "name": "남의 것", "order": 0, "channelIds": []}],
            "starredChannelIds": [],
        }),
    )
    .await;
    assert_eq!(their_save.status(), 200);

    let mine_again = get_prefs(&http, &base, &mine, fixture.workspace).await;
    assert_eq!(
        mine_again["prefs"]["sections"][0]["id"], "sec-private",
        "another member's save left mine untouched"
    );

    let stored: i64 =
        sqlx::query_scalar("SELECT count(*) FROM member_sidebar_prefs WHERE workspace_id = $1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .expect("count");
    assert_eq!(stored, 2, "two members, two rows — never a shared one");

    // RLS: a tenant transaction bound to a DIFFERENT workspace cannot see the
    // row, even asking for it by primary key. This is the `ws_isolation` policy
    // migration 084 installs (ADR-0177 D2), proven under the NOBYPASSRLS
    // `momo_app` role rather than the superuser that seeded the fixture.
    let elsewhere = seed_workspace(&su, "elsewhere").await;
    let member_id = fixture.member.id;
    let visible: i64 = momo_db::with_tenant_tx(&app, elsewhere, move |conn| {
        Box::pin(async move {
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM member_sidebar_prefs WHERE member_id = $1",
            )
            .bind(member_id)
            .fetch_one(&mut *conn)
            .await?;
            Ok(count)
        })
    })
    .await
    .expect("cross-tenant read");
    assert_eq!(
        visible, 0,
        "ws_isolation hides the row from another workspace's transaction"
    );

    // The same read inside the OWNING workspace's transaction does find it —
    // otherwise a policy that denied everything would pass the assertion above.
    let own_workspace = fixture.workspace;
    let visible: i64 = momo_db::with_tenant_tx(&app, own_workspace, move |conn| {
        Box::pin(async move {
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM member_sidebar_prefs WHERE member_id = $1",
            )
            .bind(member_id)
            .fetch_one(&mut *conn)
            .await?;
            Ok(count)
        })
    })
    .await
    .expect("same-tenant read");
    assert_eq!(visible, 1, "the owning tenant still reads its own row");
}

// ---------------------------------------------------------------------------
// 5. no event (ADR-0177 D2)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn saving_sidebar_prefs_emits_no_outbox_row() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "quiet").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;

    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox WHERE workspace_id = $1")
        .bind(fixture.workspace)
        .fetch_one(&su)
        .await
        .expect("count outbox before");

    for round in 0..3 {
        let response = put_prefs(
            &http,
            &base,
            &token,
            fixture.workspace,
            json!({
                "version": 1,
                "sections": [{
                    "id": format!("s{round}"),
                    "name": format!("회차 {round}"),
                    "order": round,
                    "channelIds": [fixture.channels[0].to_string()],
                }],
                "starredChannelIds": [],
            }),
        )
        .await;
        assert_eq!(response.status(), 200);
    }

    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox WHERE workspace_id = $1")
        .bind(fixture.workspace)
        .fetch_one(&su)
        .await
        .expect("count outbox after");
    assert_eq!(
        after, before,
        "ADR-0177 D2: sidebar prefs produce no outbox event in v1"
    );
}
