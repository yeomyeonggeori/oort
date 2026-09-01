//! #1931 / BT-3 — the `channel=` search scope over real HTTP + real Postgres.
//!
//! Red proofs:
//!   1. a channel-scoped search returns that channel's hits and no others, while
//!      the same query without the parameter still returns both channels'
//!   2. a channel the caller is not a member of is **404** — the same 404 a
//!      channel id that does not exist gets, so neither answer is a membership
//!      oracle
//!   3. a cursor minted under one scope is refused under another (400), in both
//!      directions, and the un-swapped cursor still pages
//!   4. `q`, `limit` and the workspace-scope 403 hold unchanged under `channel=`
//!   5. an agent bearer is 403 — search is absent from the agent allow-list, and
//!      #1931 does not change that
//!
//! `#[ignore]` — needs a real Postgres. Gate PG is the 15432 convention:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test search_scope_conformance_pg \
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

const TEST_JWT_SECRET: &str = "search-scope-conformance-signing-secret";
const TEST_PASSWORD: &str = "search-scope-test-password";
/// The needle every fixture message carries, so a scope that is ignored is
/// visible as an extra hit rather than as a missing one.
const NEEDLE: &str = "scoped-needle";

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
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password(&momo_app_password()))
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

/// Two channels the seeker belongs to and one they do not, every one of them
/// holding the same needle.
///
/// The needle has to be in **all three**: a `channel=` that is parsed and then
/// dropped would still pass a fixture where only the scoped channel matches, and
/// a 404 for `stranger` would look right even if the route had merely found
/// nothing to return.
struct Fixture {
    workspace: Uuid,
    other_workspace: Uuid,
    seeker: Human,
    outsider: Human,
    agent: Uuid,
    here: Uuid,
    elsewhere: Uuid,
    stranger: Uuid,
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
    let email = format!("{id}@search-scope.test");
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
    .expect("seed workspace_membership");
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

async fn seed_public_channel(su: &PgPool, workspace: Uuid, created_by: Uuid, name: &str) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', $3, '', $4)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(format!("{name}-{}", &channel.simple().to_string()[..8]))
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

async fn seed_channel_membership(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member')",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("seed channel membership");
}

async fn seed_message(su: &PgPool, workspace: Uuid, channel: Uuid, author: Uuid, body: &str) {
    sqlx::query("UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1")
        .bind(channel)
        .execute(su)
        .await
        .expect("bump seq");
    let seq: i64 = sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(su)
        .await
        .expect("seq");
    sqlx::query(
        "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
         author_member_id, type, body) \
         VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', $6)",
    )
    .bind(Uuid::new_v4())
    .bind(workspace)
    .bind(channel)
    .bind(seq)
    .bind(author)
    .bind(body)
    .execute(su)
    .await
    .expect("seed message");
}

async fn seed(su: &PgPool, hint: &str) -> Fixture {
    let workspace = seed_workspace(su, hint).await;
    let other_workspace = seed_workspace(su, &format!("{hint}-b")).await;
    let seeker = seed_human(
        su,
        workspace,
        &format!("sk-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let owner = seed_human(
        su,
        workspace,
        &format!("ow-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let outsider = seed_human(
        su,
        other_workspace,
        &format!("os-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let agent = seed_agent(su, workspace, seeker.id).await;

    let here = seed_public_channel(su, workspace, seeker.id, "here").await;
    let elsewhere = seed_public_channel(su, workspace, seeker.id, "elsewhere").await;
    let stranger = seed_public_channel(su, workspace, owner.id, "stranger").await;
    seed_channel_membership(su, workspace, here, seeker.id).await;
    seed_channel_membership(su, workspace, elsewhere, seeker.id).await;
    seed_channel_membership(su, workspace, stranger, owner.id).await;

    // Two hits in `here` so the scope can be paged, one in each sibling so an
    // ignored scope shows up as a larger page.
    seed_message(su, workspace, here, seeker.id, &format!("{NEEDLE} alpha")).await;
    seed_message(su, workspace, here, seeker.id, &format!("{NEEDLE} bravo")).await;
    seed_message(
        su,
        workspace,
        elsewhere,
        seeker.id,
        &format!("{NEEDLE} charlie"),
    )
    .await;
    seed_message(
        su,
        workspace,
        stranger,
        owner.id,
        &format!("{NEEDLE} delta - unreadable"),
    )
    .await;

    Fixture {
        workspace,
        other_workspace,
        seeker,
        outsider,
        agent,
        here,
        elsewhere,
        stranger,
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
                 ARRAY['messages:write','messages:read']::text[], 'search-scope-conformance')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

fn search_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/search/messages")
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

fn hit_channels(body: &Value) -> Vec<String> {
    body["hits"]
        .as_array()
        .expect("hits array")
        .iter()
        .map(|hit| hit["channelId"].as_str().expect("channelId").to_string())
        .collect()
}

/// Proof 1 — the scope narrows to exactly one channel, and its absence does not.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_channel_scope_returns_that_channel_and_only_that_channel() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "narrow").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.seeker.email).await;

    let workspace_wide = http
        .get(format!(
            "{}?q={NEEDLE}",
            search_url(&base, fixture.workspace)
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("workspace search");
    assert_eq!(workspace_wide.status(), 200);
    let workspace_body: Value = workspace_wide.json().await.expect("workspace body");
    let workspace_channels = hit_channels(&workspace_body);
    assert_eq!(
        workspace_channels.len(),
        3,
        "the default scope is still every channel the caller belongs to, and \
         still excludes the one they do not: {workspace_body}"
    );
    assert!(
        !workspace_channels.contains(&fixture.stranger.to_string()),
        "the un-joined channel's hit must never surface: {workspace_body}"
    );

    let scoped = http
        .get(format!(
            "{}?q={NEEDLE}&channel={}",
            search_url(&base, fixture.workspace),
            fixture.here
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("channel search");
    assert_eq!(scoped.status(), 200);
    let scoped_body: Value = scoped.json().await.expect("scoped body");
    let scoped_channels = hit_channels(&scoped_body);
    assert_eq!(
        scoped_channels.len(),
        2,
        "`here` holds two of the three readable hits: {scoped_body}"
    );
    assert!(
        scoped_channels
            .iter()
            .all(|channel| channel == &fixture.here.to_string()),
        "a hit from a sibling channel means the parameter was parsed and then \
         ignored: {scoped_body}"
    );

    // The sibling scope is the mirror image — one hit, the other channel's.
    let sibling = http
        .get(format!(
            "{}?q={NEEDLE}&channel={}",
            search_url(&base, fixture.workspace),
            fixture.elsewhere
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("sibling search");
    assert_eq!(sibling.status(), 200);
    let sibling_body: Value = sibling.json().await.expect("sibling body");
    assert_eq!(
        hit_channels(&sibling_body),
        vec![fixture.elsewhere.to_string()],
        "{sibling_body}"
    );

    // An empty `channel=` is the workspace scope, not a 400 and not an empty
    // page: a client that clears the chip by blanking the field is not asking
    // for a channel called "".
    let blank = http
        .get(format!(
            "{}?q={NEEDLE}&channel=",
            search_url(&base, fixture.workspace)
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("blank scope");
    assert_eq!(blank.status(), 200);
    let blank_body: Value = blank.json().await.expect("blank body");
    assert_eq!(hit_channels(&blank_body).len(), 3, "{blank_body}");
}

/// Proof 2 — an unreadable channel and an absent one answer the same 404.
///
/// The `stranger` channel *exists* and *matches the query*; the only thing the
/// caller lacks is membership. If that answered 200-with-no-hits while a random
/// UUID answered 404, the pair of responses would be a membership oracle: a
/// caller could enumerate which channel ids are real.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_channel_the_caller_may_not_read_is_the_same_404_as_one_that_is_not_there() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "probe").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.seeker.email).await;

    let unreadable = http
        .get(format!(
            "{}?q={NEEDLE}&channel={}",
            search_url(&base, fixture.workspace),
            fixture.stranger
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("non-member scope");
    let unreadable = error_status_message(unreadable).await;
    assert_eq!(
        unreadable,
        (404, "channel not found".to_string()),
        "a real channel the caller has not joined is a 404, not an empty page"
    );

    let absent = http
        .get(format!(
            "{}?q={NEEDLE}&channel={}",
            search_url(&base, fixture.workspace),
            Uuid::new_v4()
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("absent channel scope");
    assert_eq!(
        error_status_message(absent).await,
        unreadable,
        "the two answers must be indistinguishable — status AND message"
    );

    // A channel in another workspace is the same answer again: the tenant GUC
    // and the membership check both say no, and neither says which one it was.
    let foreign_channel =
        seed_public_channel(&su, fixture.other_workspace, fixture.outsider.id, "foreign").await;
    seed_channel_membership(
        &su,
        fixture.other_workspace,
        foreign_channel,
        fixture.outsider.id,
    )
    .await;
    seed_message(
        &su,
        fixture.other_workspace,
        foreign_channel,
        fixture.outsider.id,
        &format!("{NEEDLE} foreign"),
    )
    .await;
    let cross_tenant = http
        .get(format!(
            "{}?q={NEEDLE}&channel={foreign_channel}",
            search_url(&base, fixture.workspace)
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("cross-tenant scope");
    assert_eq!(
        error_status_message(cross_tenant).await,
        unreadable,
        "a channel in another workspace must not be distinguishable from one \
         that does not exist"
    );

    // A malformed id is a 400 instead, because it names no channel at all.
    let malformed = http
        .get(format!(
            "{}?q={NEEDLE}&channel=not-a-uuid",
            search_url(&base, fixture.workspace)
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("malformed scope");
    assert_eq!(
        error_status_message(malformed).await,
        (400, "invalid channel id".to_string())
    );
}

/// Proof 3 — the cursor is sealed to the scope that minted it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_cursor_may_not_be_replayed_under_a_different_scope() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "cursor").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.seeker.email).await;

    let scoped_page_one = http
        .get(format!(
            "{}?q={NEEDLE}&limit=1&channel={}",
            search_url(&base, fixture.workspace),
            fixture.here
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("scoped page 1");
    assert_eq!(scoped_page_one.status(), 200);
    let scoped_body: Value = scoped_page_one.json().await.expect("scoped body");
    let scoped_cursor = scoped_body["nextCursor"]
        .as_str()
        .expect("two hits in `here`, page size one: a next cursor exists")
        .to_string();

    // Its own scope pages, and stays inside the channel.
    let scoped_page_two = http
        .get(format!(
            "{}?q={NEEDLE}&limit=1&channel={}&cursor={scoped_cursor}",
            search_url(&base, fixture.workspace),
            fixture.here
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("scoped page 2");
    assert_eq!(scoped_page_two.status(), 200);
    let page_two_body: Value = scoped_page_two.json().await.expect("page 2 body");
    assert_eq!(
        hit_channels(&page_two_body),
        vec![fixture.here.to_string()],
        "page 2 must stay in the scope page 1 was taken from: {page_two_body}"
    );
    assert!(
        page_two_body.get("nextCursor").is_none(),
        "two hits, page size one: page 2 is the last: {page_two_body}"
    );

    // Dropping the scope mid-page is refused, not silently widened.
    let widened = http
        .get(format!(
            "{}?q={NEEDLE}&limit=1&cursor={scoped_cursor}",
            search_url(&base, fixture.workspace)
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("widened replay");
    assert_eq!(
        error_status_message(widened).await,
        (
            400,
            "cursor was minted for a different search scope".to_string()
        ),
        "resuming a channel walk against the workspace walk would overlap or \
         skip rows, and the client would read it as a paging bug"
    );

    // So is swapping it onto another channel.
    let swapped = http
        .get(format!(
            "{}?q={NEEDLE}&limit=1&channel={}&cursor={scoped_cursor}",
            search_url(&base, fixture.workspace),
            fixture.elsewhere
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("swapped replay");
    assert_eq!(
        error_status_message(swapped).await,
        (
            400,
            "cursor was minted for a different search scope".to_string()
        )
    );

    // And the mirror: a workspace cursor may not be narrowed mid-page either.
    let wide_page_one = http
        .get(format!(
            "{}?q={NEEDLE}&limit=1",
            search_url(&base, fixture.workspace)
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("workspace page 1");
    let wide_body: Value = wide_page_one.json().await.expect("workspace body");
    let wide_cursor = wide_body["nextCursor"]
        .as_str()
        .expect("three readable hits, page size one")
        .to_string();
    let narrowed = http
        .get(format!(
            "{}?q={NEEDLE}&limit=1&channel={}&cursor={wide_cursor}",
            search_url(&base, fixture.workspace),
            fixture.here
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("narrowed replay");
    assert_eq!(
        error_status_message(narrowed).await,
        (
            400,
            "cursor was minted for a different search scope".to_string()
        )
    );
}

/// Proof 4/5 — the guards that were already here still hold under `channel=`,
/// and the agent allow-list is unchanged.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_existing_search_guards_hold_unchanged_under_a_channel_scope() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, "guards").await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.seeker.email).await;

    // q >= 2 is still checked, and still *before* the scope is resolved — a
    // one-character query does not become a channel probe.
    let short = http
        .get(format!(
            "{}?q=a&channel={}",
            search_url(&base, fixture.workspace),
            fixture.stranger
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("short query");
    assert_eq!(
        error_status_message(short).await,
        (400, "q must contain at least 2 characters".to_string()),
        "the cheapest refusal stays first: a sub-minimum query must not reach \
         the membership lookup at all"
    );

    // limit still clamps inside the scope.
    let clamped = http
        .get(format!(
            "{}?q={NEEDLE}&limit=9000&channel={}",
            search_url(&base, fixture.workspace),
            fixture.here
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("clamped limit");
    assert_eq!(clamped.status(), 200);
    let clamped_body: Value = clamped.json().await.expect("clamped body");
    assert_eq!(hit_channels(&clamped_body).len(), 2, "{clamped_body}");

    // A garbage cursor is still 400 `invalid cursor` — the *other* cursor 400,
    // so the two failure modes stay distinguishable to a client.
    let garbage = http
        .get(format!(
            "{}?q={NEEDLE}&channel={}&cursor=%25%25%25",
            search_url(&base, fixture.workspace),
            fixture.here
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("garbage cursor");
    assert_eq!(
        error_status_message(garbage).await,
        (400, "invalid cursor".to_string())
    );

    // A foreign workspace path is still 403 before anything is looked up.
    let foreign = http
        .get(format!(
            "{}?q={NEEDLE}&channel={}",
            search_url(&base, fixture.other_workspace),
            fixture.here
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("foreign workspace");
    assert_eq!(
        error_status_message(foreign).await,
        (403, "workspace scope mismatch".to_string())
    );

    // Search is absent from `required_agent_scope`, in both scopes. #1931 adds a
    // query parameter to a human route; it does not open the route to agents.
    let bearer = agent_bearer(&su, fixture.workspace, fixture.agent).await;
    for query in [
        format!("q={NEEDLE}"),
        format!("q={NEEDLE}&channel={}", fixture.here),
    ] {
        let agent_attempt = http
            .get(format!("{}?{query}", search_url(&base, fixture.workspace)))
            .bearer_auth(&bearer)
            .send()
            .await
            .expect("agent search");
        assert_eq!(
            agent_attempt.status().as_u16(),
            403,
            "no agent credential reaches search, with or without a channel scope"
        );
    }
}
