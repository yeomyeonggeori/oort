//! #4889 stage 2 / ADR-0206 증보 1 — **안 읽은 답글** over HTTP (owner 10-31 23:49):
//! `unread_reply_count` on the history page's thread summary and `PUT …/messages/{root}/read`.
//!
//! 1. the history page tells each reader their **own** number under a thread they follow — never
//!    their own replies, `0` for "follows, nothing new", and no key at all for a thread they do not
//!    follow
//! 2. only the explicit signal moves the position: not `GET …/replies` (the inbox and the work panels
//!    read replies nobody looks at), not the channel's `PUT read-state`
//! 3. the signal route is refused for a non-member, another workspace, an unknown root, a reply used
//!    as a root, a negative position and an agent bearer, and writes nothing; in a DM it is a no-op
//! 4. the realtime `thread.updated` frame never carries a per-reader number (one frame for the channel)
//!
//! `#[ignore]` - needs a real Postgres:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26914/s5_4889b \
//!   cargo test -p momo-server --test thread_unread_conformance_pg -- --ignored --test-threads=1
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

const TEST_JWT_SECRET: &str = "thread-follow-conformance-signing-secret";
const TEST_PASSWORD: &str = "thread-follow-test-password";

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

// ---------------------------------------------------------------------------
// fixtures (superuser: past RLS)
// ---------------------------------------------------------------------------

struct Human {
    id: Uuid,
    email: String,
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

async fn seed_human(su: &PgPool, workspace: Uuid, hint: &str) -> Human {
    let id = Uuid::new_v4();
    let handle = format!("{hint}-{}", &id.simple().to_string()[..6]);
    let email = format!("{id}@thread-follow.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(&handle)
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
    let id = Uuid::new_v4();
    let handle = format!("ag-{}", &id.simple().to_string()[..8]);
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
        "INSERT INTO agent \
           (member_id, workspace_id, model, base_url, max_concurrent_runs, max_run_steps, \
            owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
    )
    .bind(id)
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
    .bind(id)
    .execute(su)
    .await
    .expect("seed agent workspace membership");
    id
}

async fn agent_bearer(su: &PgPool, workspace: Uuid, agent: Uuid, scopes: &[&str]) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{workspace}.{secret}");
    let scopes: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), $4::text[], \
                 'thread-follow-conformance')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .bind(&scopes)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

async fn seed_channel(su: &PgPool, workspace: Uuid, kind: &str, created_by: Uuid) -> Uuid {
    let channel = Uuid::new_v4();
    if kind == "dm" {
        sqlx::query(
            "INSERT INTO channel (id, workspace_id, kind, dm_key, created_by) \
             VALUES ($1, $2, 'dm', $3, $4)",
        )
        .bind(channel)
        .bind(workspace)
        .bind(format!("t4889-{channel}"))
        .bind(created_by)
        .execute(su)
        .await
        .expect("seed dm channel");
    } else {
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
    }
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");
    channel
}

async fn join(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
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

async fn rows_of(su: &PgPool, root: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM thread_follow WHERE root_id = $1")
        .bind(root)
        .fetch_one(su)
        .await
        .expect("count rows")
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

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

fn read_url(base: &str, workspace: Uuid, channel: Uuid, root: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/messages/{root}/read")
}

fn replies_url(base: &str, workspace: Uuid, channel: Uuid, root: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/messages/{root}/replies")
}

/// `POST …/messages` — a root (`root = None`) or a reply. Returns `(id, seq)`.
async fn post_message(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    root: Option<Uuid>,
    body: &str,
) -> (Uuid, i64) {
    let mut request = json!({"clientMsgId": Uuid::new_v4(), "body": body});
    if let Some(root) = root {
        request["rootId"] = json!(root);
    }
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/channels/{channel}/messages"
        ))
        .bearer_auth(token)
        .json(&request)
        .send()
        .await
        .expect("send message");
    assert_eq!(response.status(), 201, "send accepted");
    let body: Value = response.json().await.expect("send body");
    (
        Uuid::parse_str(body["id"].as_str().expect("message id")).expect("message id is a uuid"),
        body["seq"].as_i64().expect("message seq"),
    )
}

async fn delete_follow(http: &reqwest::Client, url: &str, token: &str) -> u16 {
    http.delete(url)
        .bearer_auth(token)
        .send()
        .await
        .expect("DELETE follow")
        .status()
        .as_u16()
}

/// `PUT …/read` with the position in the body.
async fn put_read(http: &reqwest::Client, url: &str, token: &str, position: i64) -> (u16, Value) {
    put_read_body(http, url, token, &json!({"last_read_reply_seq": position})).await
}

async fn put_read_body(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    body: &Value,
) -> (u16, Value) {
    let response = http
        .put(url)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .expect("PUT read");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

/// The newest page of the channel's history as `token` reads it, and the thread summary of `root` in it.
async fn thread_summary(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    root: Uuid,
) -> Value {
    let response = http
        .get(format!(
            "{base}/v1/workspaces/{workspace}/channels/{channel}/messages"
        ))
        .bearer_auth(token)
        .send()
        .await
        .expect("GET history");
    assert_eq!(response.status(), 200, "history reads");
    let page: Value = response.json().await.expect("history body");
    page["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .find(|message| message["id"].as_str() == Some(&root.to_string()))
        .unwrap_or_else(|| panic!("the root is on the page: {page}"))["thread"]
        .clone()
}

fn message_of(body: &Value) -> &str {
    body["error"]["message"].as_str().unwrap_or_default()
}

async fn position_of(su: &PgPool, root: Uuid, member: Uuid) -> Option<i64> {
    sqlx::query_scalar(
        "SELECT last_read_reply_seq FROM thread_follow WHERE root_id = $1 AND member_id = $2",
    )
    .bind(root)
    .bind(member)
    .fetch_optional(su)
    .await
    .expect("read the stored position")
}

// ---------------------------------------------------------------------------
// 1 — the history page's number, per reader
// ---------------------------------------------------------------------------

/// The history page tells each reader their **own** number under a thread they follow: the root's
/// author counts the replier's two replies, the replier (who read up to their own first reply and
/// wrote the second themselves) counts none — `0` is present, "follows, nothing new" — and a bystander
/// gets no key at all. The signal then moves the author's number to 0, and a later reply moves it back
/// to 1. The summary's other keys are exactly what they were.
///
/// Sabotage: stop attaching the count to the history page → every reader's key is absent (red at the
/// author); count the reader's own replies (drop `author_member_id <> viewer`) → the replier reads 2;
/// attach the count for non-followers → the bystander gets a key; make the signal a no-op → the author
/// stays at 2.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_history_page_carries_each_readers_own_unread_count_and_only_for_followed_threads() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();

    let workspace = seed_workspace(&su, "unread-page").await;
    let alice = seed_human(&su, workspace, "alice").await;
    let bob = seed_human(&su, workspace, "bob").await;
    let carol = seed_human(&su, workspace, "carol").await;
    let channel = seed_channel(&su, workspace, "public", alice.id).await;
    for member in [&alice, &bob, &carol] {
        join(&su, workspace, channel, member.id).await;
    }
    let alice_token = login(&http, &base, workspace, &alice.email).await;
    let bob_token = login(&http, &base, workspace, &bob.email).await;
    let carol_token = login(&http, &base, workspace, &carol.email).await;

    let (root, _) =
        post_message(&http, &base, &alice_token, workspace, channel, None, "원문").await;
    post_message(
        &http,
        &base,
        &bob_token,
        workspace,
        channel,
        Some(root),
        "첫 답글",
    )
    .await;
    let (_, second) = post_message(
        &http,
        &base,
        &bob_token,
        workspace,
        channel,
        Some(root),
        "둘째 답글",
    )
    .await;

    let for_alice = thread_summary(&http, &base, &alice_token, workspace, channel, root).await;
    let for_bob = thread_summary(&http, &base, &bob_token, workspace, channel, root).await;
    let for_carol = thread_summary(&http, &base, &carol_token, workspace, channel, root).await;
    assert_eq!(
        for_alice["unread_reply_count"], 2,
        "alice: bob's two replies: {for_alice}"
    );
    assert_eq!(
        for_bob["unread_reply_count"], 0,
        "bob wrote both replies: his own are never counted, and 0 is present, not absent: {for_bob}"
    );
    assert!(
        for_carol.get("unread_reply_count").is_none(),
        "carol follows nothing here: no key at all, not 0: {for_carol}"
    );
    for summary in [&for_alice, &for_bob, &for_carol] {
        assert_eq!(summary["reply_count"], 2);
        assert_eq!(summary["last_reply_seq"], second);
    }

    // The signal: alice has read everything.
    let url = read_url(&base, workspace, channel, root);
    let (status, body) = put_read(&http, &url, &alice_token, second).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body,
        json!({"following": true, "last_read_reply_seq": second, "unread_reply_count": 0})
    );
    let after = thread_summary(&http, &base, &alice_token, workspace, channel, root).await;
    assert_eq!(after["unread_reply_count"], 0);

    // A reply that arrives later is unread again.
    post_message(
        &http,
        &base,
        &bob_token,
        workspace,
        channel,
        Some(root),
        "셋째 답글",
    )
    .await;
    let later = thread_summary(&http, &base, &alice_token, workspace, channel, root).await;
    assert_eq!(later["unread_reply_count"], 1);
    // Someone who stopped following gets no number either (their row, and its position, are kept).
    let follow_url =
        format!("{base}/v1/workspaces/{workspace}/channels/{channel}/messages/{root}/follow");
    assert_eq!(delete_follow(&http, &follow_url, &bob_token).await, 200);
    let stopped = thread_summary(&http, &base, &bob_token, workspace, channel, root).await;
    assert!(
        stopped.get("unread_reply_count").is_none(),
        "a stopped follow is not a followed thread: no number: {stopped}"
    );
    // The bystander's signal writes nothing and answers that she follows nothing.
    let rows = rows_of(&su, root).await;
    let (status, body) = put_read(&http, &url, &carol_token, second).await;
    assert_eq!((status, &body), (200, &json!({"following": false})));
    assert_eq!(
        rows_of(&su, root).await,
        rows,
        "a signal never creates a row"
    );
}

// ---------------------------------------------------------------------------
// 2 — only the signal moves the position
// ---------------------------------------------------------------------------

/// Reading the thread's replies (the inbox and the work panels do) does not move the position, and
/// neither does the channel's own read cursor: reading the channel to its head does not show the
/// replies inside its threads.
///
/// Sabotage: advance the position inside `GET …/replies` → the first assertion goes red; let
/// `PUT read-state` carry the thread position → the second goes red.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn only_the_signal_moves_the_position_not_a_replies_read_and_not_the_channel_cursor() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();

    let workspace = seed_workspace(&su, "unread-signal").await;
    let alice = seed_human(&su, workspace, "alice").await;
    let bob = seed_human(&su, workspace, "bob").await;
    let channel = seed_channel(&su, workspace, "public", alice.id).await;
    for member in [&alice, &bob] {
        join(&su, workspace, channel, member.id).await;
    }
    let alice_token = login(&http, &base, workspace, &alice.email).await;
    let bob_token = login(&http, &base, workspace, &bob.email).await;

    let (root, _) =
        post_message(&http, &base, &alice_token, workspace, channel, None, "원문").await;
    let (_, last) = post_message(
        &http,
        &base,
        &bob_token,
        workspace,
        channel,
        Some(root),
        "답글",
    )
    .await;
    let before = position_of(&su, root, alice.id)
        .await
        .expect("alice follows");

    let page = http
        .get(replies_url(&base, workspace, channel, root))
        .bearer_auth(&alice_token)
        .send()
        .await
        .expect("GET replies");
    assert_eq!(page.status(), 200);
    assert_eq!(
        position_of(&su, root, alice.id).await,
        Some(before),
        "reading the replies is not reading them: other screens fetch them unseen"
    );

    let channel_read = http
        .put(format!(
            "{base}/v1/workspaces/{workspace}/channels/{channel}/read-state"
        ))
        .bearer_auth(&alice_token)
        .json(&json!({"last_read_seq": last + 100, "read_intent": "explicit_open"}))
        .send()
        .await
        .expect("PUT read-state");
    assert_eq!(channel_read.status(), 200);
    assert_eq!(
        position_of(&su, root, alice.id).await,
        Some(before),
        "reading the channel to its head does not show the replies inside its threads"
    );

    let (status, _) = put_read(
        &http,
        &read_url(&base, workspace, channel, root),
        &alice_token,
        last,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        position_of(&su, root, alice.id).await,
        Some(last),
        "the signal does"
    );
}

// ---------------------------------------------------------------------------
// 3 — the door
// ---------------------------------------------------------------------------

/// The signal route is the thread read's door: a non-member (403, the sentence a missing channel
/// gets), another workspace (403), an unknown root (404), a reply used as a root (400), a negative
/// position (400), a body without the position (422) and an agent bearer (403) are all refused and
/// write nothing; in a DM the signal is a harmless no-op.
///
/// Sabotage: drop the membership check in the guard → the non-member case goes red; drop the
/// negative check → the 400 case goes red.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_signal_route_refuses_what_the_thread_read_refuses_and_writes_nothing() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();

    let workspace = seed_workspace(&su, "unread-door").await;
    let other_workspace = seed_workspace(&su, "unread-door-other").await;
    let alice = seed_human(&su, workspace, "alice").await;
    let bob = seed_human(&su, workspace, "bob").await;
    let outsider = seed_human(&su, workspace, "outsider").await;
    let foreign = seed_human(&su, other_workspace, "foreign").await;
    let channel = seed_channel(&su, workspace, "public", alice.id).await;
    for member in [&alice, &bob] {
        join(&su, workspace, channel, member.id).await;
    }
    let agent = seed_agent(&su, workspace, alice.id).await;
    join(&su, workspace, channel, agent).await;
    let agent_token =
        agent_bearer(&su, workspace, agent, &["messages:read", "messages:write"]).await;
    let alice_token = login(&http, &base, workspace, &alice.email).await;
    let bob_token = login(&http, &base, workspace, &bob.email).await;
    let outsider_token = login(&http, &base, workspace, &outsider.email).await;
    let foreign_token = login(&http, &base, other_workspace, &foreign.email).await;

    let (root, _) =
        post_message(&http, &base, &alice_token, workspace, channel, None, "원문").await;
    let (reply, last) = post_message(
        &http,
        &base,
        &bob_token,
        workspace,
        channel,
        Some(root),
        "답글",
    )
    .await;
    let position = position_of(&su, root, alice.id).await;
    let url = read_url(&base, workspace, channel, root);

    let (status, body) = put_read(&http, &url, &outsider_token, last).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(message_of(&body), "not a member of this channel");
    let (status, _) = put_read(&http, &url, &foreign_token, last).await;
    assert_eq!(status, 403, "a bearer of another workspace");
    let (status, body) = put_read(&http, &url, &agent_token, last).await;
    assert_eq!(
        status, 403,
        "an agent bearer is refused whatever its scopes: {body}"
    );
    let (status, _) = put_read(
        &http,
        &read_url(&base, workspace, channel, Uuid::new_v4()),
        &alice_token,
        last,
    )
    .await;
    assert_eq!(status, 404, "a root that is not in this channel");
    let (status, _) = put_read(
        &http,
        &read_url(&base, workspace, channel, reply),
        &alice_token,
        last,
    )
    .await;
    assert_eq!(status, 400, "a reply is not a thread root");
    let (status, body) = put_read(&http, &url, &alice_token, -1).await;
    assert_eq!(status, 400, "{body}");
    let (status, _) = put_read_body(&http, &url, &alice_token, &json!({})).await;
    assert_eq!(status, 422, "the position is required");
    assert_eq!(
        position_of(&su, root, alice.id).await,
        position,
        "not one refusal moved the position"
    );

    // A DM: no follow rows exist there, so the signal is a no-op, not an error.
    let dm = seed_channel(&su, workspace, "dm", alice.id).await;
    for member in [&alice, &bob] {
        join(&su, workspace, dm, member.id).await;
    }
    let (dm_root, _) =
        post_message(&http, &base, &alice_token, workspace, dm, None, "dm root").await;
    post_message(
        &http,
        &base,
        &bob_token,
        workspace,
        dm,
        Some(dm_root),
        "dm reply",
    )
    .await;
    let (status, body) = put_read(
        &http,
        &read_url(&base, workspace, dm, dm_root),
        &alice_token,
        99,
    )
    .await;
    assert_eq!((status, &body), (200, &json!({"following": false})));
    assert_eq!(rows_of(&su, dm_root).await, 0);
}

// ---------------------------------------------------------------------------
// 4 — the broadcast
// ---------------------------------------------------------------------------

/// `thread.updated` is one frame for the whole channel, so it cannot say how many replies one reader
/// has not read, and it does not: its payload keeps exactly the keys it had.
///
/// Sabotage: put `unread_reply_count` into `build_thread_updated_payload` → red.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_thread_updated_frame_carries_no_per_reader_number() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();

    let workspace = seed_workspace(&su, "unread-frame").await;
    let alice = seed_human(&su, workspace, "alice").await;
    let bob = seed_human(&su, workspace, "bob").await;
    let channel = seed_channel(&su, workspace, "public", alice.id).await;
    for member in [&alice, &bob] {
        join(&su, workspace, channel, member.id).await;
    }
    let alice_token = login(&http, &base, workspace, &alice.email).await;
    let bob_token = login(&http, &base, workspace, &bob.email).await;
    let (root, _) =
        post_message(&http, &base, &alice_token, workspace, channel, None, "원문").await;
    post_message(
        &http,
        &base,
        &bob_token,
        workspace,
        channel,
        Some(root),
        "답글",
    )
    .await;

    let frame: Value = sqlx::query_scalar(
        "SELECT payload->'data'->'payload' FROM outbox \
          WHERE workspace_id = $1 AND payload->'data'->>'type' = 'thread.updated' \
          ORDER BY id DESC LIMIT 1",
    )
    .bind(workspace)
    .fetch_one(&su)
    .await
    .expect("the reply emitted a thread.updated frame");
    let mut keys: Vec<&str> = frame
        .as_object()
        .expect("payload object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "channel_id",
            "last_reply_at",
            "last_reply_seq",
            "participant_count",
            "participant_ids",
            "reply_count",
            "root_id"
        ],
        "the frame keeps exactly its keys: {frame}"
    );
}
