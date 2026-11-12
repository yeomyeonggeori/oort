//! #5689 / ADR-0124 증보 5 — `POST /v1/workspaces/{ws}/threads/read-all` over HTTP, as the
//! non-bypass `momo_app` role under RLS FORCE, with two workspaces:
//!
//! 1. every followed thread with an unread reply moves to its last reply, through the single read's
//!    statement; one `followed_unread.updated` frame per changed channel, to the caller only; the
//!    answer is those channels' `GET read-state` lines; the same request again changes and sends
//!    nothing; the channel cursor and the inbox are left alone (so is a single thread read's)
//! 2. `channel_ids` that are not the caller's live, unarchived channels are skipped without a trace:
//!    the answer is byte-for-byte the nothing-to-do answer
//! 3. a guest moves only threads in the channels they are in
//! 4. refusals (agent bearer, another workspace's bearer, too many ids, a bad body) write nothing
//! 5. past the per-request cap the answer says `has_more` and the next call finishes the rest
//! 6. the per-member budget answers 429 with `Retry-After`
//! 7. concurrency: a reply that lands while the call waits stays unread, and a position another device
//!    moved further is never pulled back
//!
//! `#[ignore]` - needs a real Postgres:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26989/w5689 \
//!   cargo test -p momo-server --test thread_read_all_conformance_pg -- --ignored --test-threads=1
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::RateLimitConfig;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "thread-read-all-conformance-signing-secret";
const TEST_PASSWORD: &str = "thread-read-all-test-password";
/// The nothing-to-do answer, as bytes.
const NOTHING: &str = r#"{"read_states":[],"marked_thread_count":0,"has_more":false}"#;

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

async fn start_server_with(pool: PgPool, limits: RateLimitConfig) -> String {
    let app = build_app(
        AppState::new(
            pool,
            TEST_JWT_SECRET.to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        )
        .with_rate_limit(limits),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

async fn start_server(pool: PgPool) -> String {
    start_server_with(pool, RateLimitConfig::default()).await
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

async fn seed_person(su: &PgPool, workspace: Uuid, hint: &str, role: &str) -> Human {
    let id = Uuid::new_v4();
    let handle = format!("{hint}-{}", &id.simple().to_string()[..6]);
    let email = format!("{id}@thread-read-all.test");
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
         VALUES ($1, $2, $3::membership_role)",
    )
    .bind(workspace)
    .bind(id)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace membership");
    Human { id, email }
}

async fn seed_human(su: &PgPool, workspace: Uuid, hint: &str) -> Human {
    seed_person(su, workspace, hint, "member").await
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
                 'thread-read-all-conformance')",
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

async fn seed_channel(su: &PgPool, workspace: Uuid, created_by: Uuid) -> Uuid {
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

async fn join_as(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid, role: &str) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, $4::membership_role)",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .bind(role)
    .execute(su)
    .await
    .expect("seed channel membership");
}

async fn join(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
    join_as(su, workspace, channel, member, "member").await;
}

async fn leave(su: &PgPool, channel: Uuid, member: Uuid) {
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("leave the channel");
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

/// `POST …/threads/read-all` with `body`; returns the status and the raw body text.
async fn read_all_raw(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    body: &Value,
) -> (u16, String) {
    let response = http
        .post(format!("{base}/v1/workspaces/{workspace}/threads/read-all"))
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .expect("POST read-all");
    let status = response.status().as_u16();
    (status, response.text().await.unwrap_or_default())
}

async fn read_all(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    body: &Value,
) -> Value {
    let (status, text) = read_all_raw(http, base, token, workspace, body).await;
    assert_eq!(status, 200, "read-all answers 200: {text}");
    serde_json::from_str(&text).expect("read-all body is JSON")
}

/// `GET …/read-state` as `token` reads it: the line of `channel`.
async fn read_state_line(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
) -> Value {
    let response = http
        .get(format!("{base}/v1/workspaces/{workspace}/read-state"))
        .bearer_auth(token)
        .send()
        .await
        .expect("GET read-state");
    assert_eq!(response.status(), 200, "GET read-state is 200");
    let body: Value = response.json().await.expect("read-state body");
    body["read_states"]
        .as_array()
        .expect("read_states")
        .iter()
        .find(|line| line["channel_id"].as_str() == Some(&channel.to_string()))
        .unwrap_or_else(|| panic!("a line for the channel: {body}"))
        .clone()
}

fn changed_channels(body: &Value) -> Vec<String> {
    let mut ids: Vec<String> = body["read_states"]
        .as_array()
        .expect("read_states array")
        .iter()
        .map(|line| line["channel_id"].as_str().expect("channel_id").to_string())
        .collect();
    ids.sort();
    ids
}

fn sorted(channels: &[Uuid]) -> Vec<String> {
    let mut ids: Vec<String> = channels.iter().map(Uuid::to_string).collect();
    ids.sort();
    ids
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

/// `followed_unread.updated` frames for `member` written after `since`.
async fn followed_frames_since(su: &PgPool, since: i64, member: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE id > $1 AND partition_key = $2 \
            AND payload->'data'->>'type' = 'followed_unread.updated'",
    )
    .bind(since)
    .bind(member)
    .fetch_one(su)
    .await
    .expect("count frames")
}

/// Every outbox row written after `since`, whoever it is for.
async fn outbox_rows_since(su: &PgPool, since: i64) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM outbox WHERE id > $1")
        .bind(since)
        .fetch_one(su)
        .await
        .expect("count outbox rows")
}

async fn outbox_mark(su: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT COALESCE(max(id), 0)::bigint FROM outbox")
        .fetch_one(su)
        .await
        .expect("outbox watermark")
}

/// `member`'s unread `thread_reply` inbox items.
async fn unread_thread_reply_items(su: &PgPool, member: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM inbox_item \
          WHERE member_id = $1 AND kind = 'thread_reply' AND read_at IS NULL",
    )
    .bind(member)
    .fetch_one(su)
    .await
    .expect("count inbox items")
}

async fn channel_cursor(su: &PgPool, channel: Uuid, member: Uuid) -> Option<i64> {
    sqlx::query_scalar(
        "SELECT last_read_seq FROM read_state WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(channel)
    .bind(member)
    .fetch_optional(su)
    .await
    .expect("read the channel cursor")
}

/// A thread `author` starts in `channel` with `replies` replies from `replier`. Returns
/// `(root, last reply seq)`.
#[allow(clippy::too_many_arguments)]
async fn thread_with_replies(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    channel: Uuid,
    author: &str,
    replier: &str,
    replies: usize,
) -> (Uuid, i64) {
    let (root, mut last) = post_message(http, base, author, workspace, channel, None, "원문").await;
    for n in 0..replies {
        last = post_message(
            http,
            base,
            replier,
            workspace,
            channel,
            Some(root),
            &format!("답글 {n}"),
        )
        .await
        .1;
    }
    (root, last)
}

// ---------------------------------------------------------------------------
// 1 — what moves, what is said, what stays
// ---------------------------------------------------------------------------

/// Alice follows three threads with unread replies in two channels (and one with none in a third, and
/// one she stopped following). Read-all moves exactly the three to their last reply, answers the two
/// channels' `GET read-state` lines (total 0), sends alice one frame per changed channel and carol
/// none, and leaves carol's own position in a shared thread, alice's channel cursors and alice's
/// `thread_reply` inbox items as they were. The same request again is the nothing-to-do answer with no
/// outbox row at all. A single thread read afterwards leaves the inbox alone too.
///
/// Sabotage (measured, see the PR): drop the `member_id` binding of the position statement → carol's
/// position moves; open the transaction without the tenant GUC → the call is refused.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn read_all_moves_every_followed_unread_thread_and_signals_each_changed_channel_once() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();

    let workspace = seed_workspace(&su, "read-all").await;
    let alice = seed_human(&su, workspace, "alice").await;
    let bob = seed_human(&su, workspace, "bob").await;
    let carol = seed_human(&su, workspace, "carol").await;
    let (one, two, three) = (
        seed_channel(&su, workspace, alice.id).await,
        seed_channel(&su, workspace, alice.id).await,
        seed_channel(&su, workspace, alice.id).await,
    );
    for channel in [one, two, three] {
        for member in [&alice, &bob, &carol] {
            join(&su, workspace, channel, member.id).await;
        }
    }
    let alice_token = login(&http, &base, workspace, &alice.email).await;
    let bob_token = login(&http, &base, workspace, &bob.email).await;
    let carol_token = login(&http, &base, workspace, &carol.email).await;

    let (r1, h1) =
        thread_with_replies(&http, &base, workspace, one, &alice_token, &bob_token, 1).await;
    let (r2, h2) =
        thread_with_replies(&http, &base, workspace, one, &alice_token, &bob_token, 2).await;
    let (r3, h3) =
        thread_with_replies(&http, &base, workspace, two, &alice_token, &bob_token, 1).await;
    // A thread alice follows with nothing unread (no replies yet) in the third channel.
    let (r4, _) =
        thread_with_replies(&http, &base, workspace, three, &alice_token, &bob_token, 0).await;
    let follow = |channel: Uuid, root: Uuid| {
        format!("{base}/v1/workspaces/{workspace}/channels/{channel}/messages/{root}/follow")
    };
    let put = http
        .put(follow(three, r4))
        .bearer_auth(&alice_token)
        .send()
        .await
        .expect("follow");
    assert_eq!(put.status(), 200);
    // A thread alice stopped following: its unread reply must stay where it is.
    let (r5, _) =
        thread_with_replies(&http, &base, workspace, two, &alice_token, &bob_token, 1).await;
    let del = http
        .delete(follow(two, r5))
        .bearer_auth(&alice_token)
        .send()
        .await
        .expect("unfollow");
    assert_eq!(del.status(), 200);
    let r5_before = position_of(&su, r5, alice.id).await;
    // Carol follows r1 directly, then bob replies again: carol has an unread reply there too.
    let put = http
        .put(follow(one, r1))
        .bearer_auth(&carol_token)
        .send()
        .await
        .expect("carol follows");
    assert_eq!(put.status(), 200);
    let h1 = post_message(
        &http,
        &base,
        &bob_token,
        workspace,
        one,
        Some(r1),
        "또 답글",
    )
    .await
    .1
    .max(h1);
    let carol_before = position_of(&su, r1, carol.id).await;
    assert!(carol_before < Some(h1), "carol has something unread in r1");

    let inbox_before = unread_thread_reply_items(&su, alice.id).await;
    assert!(
        inbox_before >= 3,
        "alice has thread_reply items: {inbox_before}"
    );
    let cursors_before = [
        channel_cursor(&su, one, alice.id).await,
        channel_cursor(&su, two, alice.id).await,
    ];
    assert!(
        read_state_line(&http, &base, &alice_token, workspace, one).await
            ["followed_unread_reply_count"]
            .as_i64()
            > Some(0)
    );

    let mark = outbox_mark(&su).await;
    let body = read_all(&http, &base, &alice_token, workspace, &json!({})).await;
    assert_eq!(body["marked_thread_count"], 3, "{body}");
    assert_eq!(body["has_more"], false, "{body}");
    assert_eq!(changed_channels(&body), sorted(&[one, two]), "{body}");
    for line in body["read_states"].as_array().expect("lines") {
        assert_eq!(line["followed_unread_reply_count"], 0, "{line}");
        let channel = Uuid::parse_str(line["channel_id"].as_str().expect("id")).expect("uuid");
        assert_eq!(
            line,
            &read_state_line(&http, &base, &alice_token, workspace, channel).await,
            "a line of the answer is the GET read-state line, key for key"
        );
    }
    assert_eq!(position_of(&su, r1, alice.id).await, Some(h1));
    assert_eq!(position_of(&su, r2, alice.id).await, Some(h2));
    assert_eq!(position_of(&su, r3, alice.id).await, Some(h3));
    assert_eq!(
        position_of(&su, r5, alice.id).await,
        r5_before,
        "a stopped follow stays"
    );
    assert_eq!(
        followed_frames_since(&su, mark, alice.id).await,
        2,
        "one frame per changed channel"
    );
    assert_eq!(
        followed_frames_since(&su, mark, carol.id).await,
        0,
        "nobody else hears anything"
    );
    assert_eq!(
        outbox_rows_since(&su, mark).await,
        2,
        "and nothing else is written to the outbox"
    );
    assert_eq!(
        position_of(&su, r1, carol.id).await,
        carol_before,
        "carol's own position stays"
    );
    assert_eq!(
        unread_thread_reply_items(&su, alice.id).await,
        inbox_before,
        "the inbox's thread_reply items stay unread — read-all is a thread read, not an inbox read"
    );
    assert_eq!(
        [
            channel_cursor(&su, one, alice.id).await,
            channel_cursor(&su, two, alice.id).await,
        ],
        cursors_before,
        "the channel cursors do not move"
    );

    // Again: nothing to do, nothing sent.
    let mark = outbox_mark(&su).await;
    let (status, text) = read_all_raw(&http, &base, &alice_token, workspace, &json!({})).await;
    assert_eq!((status, text.as_str()), (200, NOTHING));
    assert_eq!(outbox_rows_since(&su, mark).await, 0);

    // A single thread read leaves the inbox alone as well (the rule read-all copies).
    let (_, h1b) = post_message(
        &http,
        &base,
        &bob_token,
        workspace,
        one,
        Some(r1),
        "새 답글",
    )
    .await;
    let inbox_mid = unread_thread_reply_items(&su, alice.id).await;
    let response = http
        .put(format!(
            "{base}/v1/workspaces/{workspace}/channels/{one}/messages/{r1}/read"
        ))
        .bearer_auth(&alice_token)
        .json(&json!({"last_read_reply_seq": h1b}))
        .send()
        .await
        .expect("PUT read");
    assert_eq!(response.status(), 200);
    assert_eq!(position_of(&su, r1, alice.id).await, Some(h1b));
    assert_eq!(unread_thread_reply_items(&su, alice.id).await, inbox_mid);
}

// ---------------------------------------------------------------------------
// 2 — skipped ids leave no trace
// ---------------------------------------------------------------------------

/// Alice has unread followed threads in a channel she is in, in one she left, and in one that was
/// archived; bob has a channel alice is not in; another workspace has its own. Ids that are not alice's
/// live, unarchived channels — left, archived, someone else's, another workspace's, never issued — answer
/// byte-for-byte what `[]` answers and move nothing; mixed with her real channel, only that one moves.
/// With no ids at all, the left and archived channels' threads still stay.
///
/// Sabotage (measured, see the PR): drop `ms.left_at IS NULL` → the left channel's position moves;
/// drop `c.archived_at IS NULL` → the archived one's does.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn ids_that_are_not_the_callers_channels_are_skipped_without_a_trace() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();

    let workspace = seed_workspace(&su, "read-all-skip").await;
    let elsewhere = seed_workspace(&su, "read-all-skip-other").await;
    let alice = seed_human(&su, workspace, "alice").await;
    let bob = seed_human(&su, workspace, "bob").await;
    let foreign = seed_human(&su, elsewhere, "foreign").await;
    let mine = seed_channel(&su, workspace, alice.id).await;
    let left = seed_channel(&su, workspace, alice.id).await;
    let archived = seed_channel(&su, workspace, alice.id).await;
    let bobs = seed_channel(&su, workspace, bob.id).await;
    let foreign_channel = seed_channel(&su, elsewhere, foreign.id).await;
    for channel in [mine, left, archived] {
        for member in [&alice, &bob] {
            join(&su, workspace, channel, member.id).await;
        }
    }
    join(&su, workspace, bobs, bob.id).await;
    join(&su, elsewhere, foreign_channel, foreign.id).await;
    let alice_token = login(&http, &base, workspace, &alice.email).await;
    let bob_token = login(&http, &base, workspace, &bob.email).await;
    let foreign_token = login(&http, &base, elsewhere, &foreign.email).await;

    let (r_mine, h_mine) =
        thread_with_replies(&http, &base, workspace, mine, &alice_token, &bob_token, 1).await;
    let (r_left, _) =
        thread_with_replies(&http, &base, workspace, left, &alice_token, &bob_token, 1).await;
    let (r_arch, _) = thread_with_replies(
        &http,
        &base,
        workspace,
        archived,
        &alice_token,
        &bob_token,
        1,
    )
    .await;
    thread_with_replies(&http, &base, workspace, bobs, &bob_token, &bob_token, 1).await;
    thread_with_replies(
        &http,
        &base,
        elsewhere,
        foreign_channel,
        &foreign_token,
        &foreign_token,
        1,
    )
    .await;
    leave(&su, left, alice.id).await;
    sqlx::query("UPDATE channel SET archived_at = now() WHERE id = $1")
        .bind(archived)
        .execute(&su)
        .await
        .expect("archive");
    let (left_before, arch_before) = (
        position_of(&su, r_left, alice.id).await,
        position_of(&su, r_arch, alice.id).await,
    );
    assert!(
        left_before.is_some() && arch_before.is_some(),
        "alice follows both"
    );

    let mark = outbox_mark(&su).await;
    let (status, empty) = read_all_raw(
        &http,
        &base,
        &alice_token,
        workspace,
        &json!({"channel_ids": []}),
    )
    .await;
    assert_eq!((status, empty.as_str()), (200, NOTHING), "[] is a no-op");
    let junk = json!({"channel_ids": [left, archived, bobs, foreign_channel, Uuid::new_v4()]});
    let (status, text) = read_all_raw(&http, &base, &alice_token, workspace, &junk).await;
    assert_eq!(
        (status, text.as_str()),
        (200, empty.as_str()),
        "the answer for ids alice cannot use is the answer for none"
    );
    assert_eq!(outbox_rows_since(&su, mark).await, 0);
    assert_eq!(position_of(&su, r_left, alice.id).await, left_before);
    assert_eq!(position_of(&su, r_arch, alice.id).await, arch_before);

    let mixed =
        json!({"channel_ids": [left, archived, bobs, mine, foreign_channel, Uuid::new_v4(), mine]});
    let body = read_all(&http, &base, &alice_token, workspace, &mixed).await;
    assert_eq!(changed_channels(&body), sorted(&[mine]), "{body}");
    assert_eq!(body["marked_thread_count"], 1, "{body}");
    assert_eq!(position_of(&su, r_mine, alice.id).await, Some(h_mine));
    assert_eq!(followed_frames_since(&su, mark, alice.id).await, 1);

    // With no ids at all, the left and archived channels' threads still stay where they were.
    thread_with_replies(&http, &base, workspace, mine, &alice_token, &bob_token, 1).await;
    let body = read_all(
        &http,
        &base,
        &alice_token,
        workspace,
        &json!({"channel_ids": null}),
    )
    .await;
    assert_eq!(changed_channels(&body), sorted(&[mine]), "{body}");
    assert_eq!(
        position_of(&su, r_left, alice.id).await,
        left_before,
        "a channel alice left"
    );
    assert_eq!(
        position_of(&su, r_arch, alice.id).await,
        arch_before,
        "an archived channel"
    );
}

// ---------------------------------------------------------------------------
// 3 — a guest (ADR-0219)
// ---------------------------------------------------------------------------

/// A guest moves the threads they follow in the channel they are in, and not those of a channel they
/// were taken out of; naming that channel is the nothing-to-do answer.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_guest_reads_only_the_channels_they_are_in() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();

    let workspace = seed_workspace(&su, "read-all-guest").await;
    let alice = seed_human(&su, workspace, "alice").await;
    let guest = seed_person(&su, workspace, "guest", "guest").await;
    let shared = seed_channel(&su, workspace, alice.id).await;
    let former = seed_channel(&su, workspace, alice.id).await;
    for channel in [shared, former] {
        join(&su, workspace, channel, alice.id).await;
        join_as(&su, workspace, channel, guest.id, "guest").await;
    }
    let alice_token = login(&http, &base, workspace, &alice.email).await;
    let guest_token = login(&http, &base, workspace, &guest.email).await;

    let (r_shared, h_shared) = thread_with_replies(
        &http,
        &base,
        workspace,
        shared,
        &guest_token,
        &alice_token,
        1,
    )
    .await;
    let (r_former, _) = thread_with_replies(
        &http,
        &base,
        workspace,
        former,
        &guest_token,
        &alice_token,
        1,
    )
    .await;
    leave(&su, former, guest.id).await;
    let former_before = position_of(&su, r_former, guest.id).await;
    assert!(former_before.is_some());

    let (status, text) = read_all_raw(
        &http,
        &base,
        &guest_token,
        workspace,
        &json!({"channel_ids": [former]}),
    )
    .await;
    assert_eq!((status, text.as_str()), (200, NOTHING));
    let body = read_all(&http, &base, &guest_token, workspace, &json!({})).await;
    assert_eq!(changed_channels(&body), sorted(&[shared]), "{body}");
    assert_eq!(position_of(&su, r_shared, guest.id).await, Some(h_shared));
    assert_eq!(position_of(&su, r_former, guest.id).await, former_before);
}

// ---------------------------------------------------------------------------
// 4 — refusals
// ---------------------------------------------------------------------------

/// An agent bearer (whatever its scopes) and another workspace's bearer are 403; more than 500 ids is
/// 400; a body that is not the shape is 4xx. None of them moves a position or writes an outbox row.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn refusals_move_nothing() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();

    let workspace = seed_workspace(&su, "read-all-door").await;
    let elsewhere = seed_workspace(&su, "read-all-door-other").await;
    let alice = seed_human(&su, workspace, "alice").await;
    let bob = seed_human(&su, workspace, "bob").await;
    let foreign = seed_human(&su, elsewhere, "foreign").await;
    let channel = seed_channel(&su, workspace, alice.id).await;
    for member in [&alice, &bob] {
        join(&su, workspace, channel, member.id).await;
    }
    let agent = seed_agent(&su, workspace, alice.id).await;
    join(&su, workspace, channel, agent).await;
    let agent_token =
        agent_bearer(&su, workspace, agent, &["messages:read", "messages:write"]).await;
    let alice_token = login(&http, &base, workspace, &alice.email).await;
    let bob_token = login(&http, &base, workspace, &bob.email).await;
    let foreign_token = login(&http, &base, elsewhere, &foreign.email).await;
    let (root, _) = thread_with_replies(
        &http,
        &base,
        workspace,
        channel,
        &alice_token,
        &bob_token,
        1,
    )
    .await;
    // No path makes an agent follow a thread; a row is planted so that a refusal that let the agent
    // through would show up as a moved position.
    sqlx::query(
        "INSERT INTO thread_follow \
           (workspace_id, channel_id, root_id, member_id, state, last_read_reply_seq) \
         VALUES ($1, $2, $3, $4, 'followed', 0)",
    )
    .bind(workspace)
    .bind(channel)
    .bind(root)
    .bind(agent)
    .execute(&su)
    .await
    .expect("plant the agent's follow row");
    let (alice_before, agent_before) = (
        position_of(&su, root, alice.id).await,
        position_of(&su, root, agent).await,
    );
    assert_eq!(agent_before, Some(0));

    let mark = outbox_mark(&su).await;
    let (status, text) = read_all_raw(&http, &base, &agent_token, workspace, &json!({})).await;
    assert_eq!(status, 403, "an agent bearer: {text}");
    let (status, text) = read_all_raw(&http, &base, &foreign_token, workspace, &json!({})).await;
    assert_eq!(status, 403, "another workspace's bearer: {text}");
    let too_many: Vec<Uuid> = (0..501).map(|_| Uuid::new_v4()).collect();
    let (status, text) = read_all_raw(
        &http,
        &base,
        &alice_token,
        workspace,
        &json!({"channel_ids": too_many}),
    )
    .await;
    assert_eq!(status, 400, "501 ids: {text}");
    let (status, _) = read_all_raw(
        &http,
        &base,
        &alice_token,
        workspace,
        &json!({"channel_ids": ["not-a-uuid"]}),
    )
    .await;
    assert_eq!(status, 422, "an id that is not a uuid");
    let no_body = http
        .post(format!("{base}/v1/workspaces/{workspace}/threads/read-all"))
        .bearer_auth(&alice_token)
        .send()
        .await
        .expect("POST without a body");
    assert!(
        no_body.status().is_client_error(),
        "no JSON body is refused: {}",
        no_body.status()
    );
    assert_eq!(
        outbox_rows_since(&su, mark).await,
        0,
        "no refusal writes a frame"
    );
    assert_eq!(position_of(&su, root, alice.id).await, alice_before);
    assert_eq!(position_of(&su, root, agent).await, agent_before);

    // 500 ids is still fine.
    let five_hundred: Vec<Uuid> = (0..500).map(|_| Uuid::new_v4()).collect();
    let (status, text) = read_all_raw(
        &http,
        &base,
        &alice_token,
        workspace,
        &json!({"channel_ids": five_hundred}),
    )
    .await;
    assert_eq!((status, text.as_str()), (200, NOTHING));
}

// ---------------------------------------------------------------------------
// 5 — the per-request cap
// ---------------------------------------------------------------------------

/// 101 followed threads with an unread reply: the first call moves 100 and says `has_more`, the
/// channel line still counts the one left, the second call moves it and says no more, the third is the
/// nothing-to-do answer.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn past_the_cap_the_answer_says_more_and_the_next_call_finishes() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();

    let workspace = seed_workspace(&su, "read-all-cap").await;
    let alice = seed_human(&su, workspace, "alice").await;
    let bob = seed_human(&su, workspace, "bob").await;
    let channel = seed_channel(&su, workspace, alice.id).await;
    for member in [&alice, &bob] {
        join(&su, workspace, channel, member.id).await;
    }
    let alice_token = login(&http, &base, workspace, &alice.email).await;
    let bob_token = login(&http, &base, workspace, &bob.email).await;
    for _ in 0..101 {
        thread_with_replies(
            &http,
            &base,
            workspace,
            channel,
            &alice_token,
            &bob_token,
            1,
        )
        .await;
    }

    let body = read_all(&http, &base, &alice_token, workspace, &json!({})).await;
    assert_eq!(body["marked_thread_count"], 100, "{body}");
    assert_eq!(body["has_more"], true);
    assert_eq!(body["read_states"][0]["followed_unread_reply_count"], 1);
    let body = read_all(&http, &base, &alice_token, workspace, &json!({})).await;
    assert_eq!(body["marked_thread_count"], 1, "{body}");
    assert_eq!(body["has_more"], false);
    assert_eq!(body["read_states"][0]["followed_unread_reply_count"], 0);
    let (status, text) = read_all_raw(&http, &base, &alice_token, workspace, &json!({})).await;
    assert_eq!((status, text.as_str()), (200, NOTHING));
}

// ---------------------------------------------------------------------------
// 6 — the per-member budget
// ---------------------------------------------------------------------------

/// With a budget of 2 a window, the third call is 429 with `Retry-After`, and another member's budget
/// is their own.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_per_member_budget_answers_429() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server_with(
        momo_app_pool().await,
        RateLimitConfig {
            thread_read_all_per_member_limit: 2,
            ..RateLimitConfig::default()
        },
    )
    .await;
    let http = reqwest::Client::new();

    let workspace = seed_workspace(&su, "read-all-budget").await;
    let alice = seed_human(&su, workspace, "alice").await;
    let bob = seed_human(&su, workspace, "bob").await;
    let alice_token = login(&http, &base, workspace, &alice.email).await;
    let bob_token = login(&http, &base, workspace, &bob.email).await;
    for _ in 0..2 {
        read_all(&http, &base, &alice_token, workspace, &json!({})).await;
    }
    let refused = http
        .post(format!("{base}/v1/workspaces/{workspace}/threads/read-all"))
        .bearer_auth(&alice_token)
        .json(&json!({}))
        .send()
        .await
        .expect("third call");
    assert_eq!(refused.status(), 429);
    assert!(
        refused.headers().get("retry-after").is_some(),
        "a 429 says when"
    );
    read_all(&http, &base, &bob_token, workspace, &json!({})).await;
}

// ---------------------------------------------------------------------------
// 7 — concurrency
// ---------------------------------------------------------------------------

/// Wait until a `momo_app` backend is waiting on a row lock.
async fn wait_for_lock_waiter(su: &PgPool) {
    for _ in 0..200 {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity \
              WHERE usename = 'momo_app' AND wait_event_type = 'Lock'",
        )
        .fetch_one(su)
        .await
        .expect("read pg_stat_activity");
        if waiting > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("read-all never waited on the held row lock");
}

/// The call is held on alice's row (another transaction holds its lock) while things happen:
///
/// * **a reply lands meanwhile** → read-all moves the position to the last reply it saw, and the new
///   reply stays unread (`followed_unread_reply_count` 1);
/// * **another device reads further meanwhile** → read-all leaves that position where it is; it never
///   pulls it back to the head it saw.
///
/// Sabotage (measured, see the PR): request `i64::MAX` instead of the head it read → the first scene's
/// new reply is marked read.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn concurrent_replies_stay_unread_and_a_position_never_moves_back() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();

    let workspace = seed_workspace(&su, "read-all-race").await;
    let alice = seed_human(&su, workspace, "alice").await;
    let bob = seed_human(&su, workspace, "bob").await;
    let channel = seed_channel(&su, workspace, alice.id).await;
    for member in [&alice, &bob] {
        join(&su, workspace, channel, member.id).await;
    }
    let alice_token = login(&http, &base, workspace, &alice.email).await;
    let bob_token = login(&http, &base, workspace, &bob.email).await;

    // Scene 1: a reply lands while read-all waits.
    let (root, seen) = thread_with_replies(
        &http,
        &base,
        workspace,
        channel,
        &alice_token,
        &bob_token,
        1,
    )
    .await;
    let mut holder = su.begin().await.expect("begin holder");
    sqlx::query("SELECT 1 FROM thread_follow WHERE root_id = $1 AND member_id = $2 FOR UPDATE")
        .bind(root)
        .bind(alice.id)
        .execute(&mut *holder)
        .await
        .expect("hold alice's row");
    let call = {
        let (http, base, token) = (http.clone(), base.clone(), alice_token.clone());
        tokio::spawn(async move { read_all(&http, &base, &token, workspace, &json!({})).await })
    };
    wait_for_lock_waiter(&su).await;
    let (_, late) = post_message(
        &http,
        &base,
        &bob_token,
        workspace,
        channel,
        Some(root),
        "늦은 답글",
    )
    .await;
    holder.commit().await.expect("release");
    let body = call.await.expect("read-all task");
    assert_eq!(body["marked_thread_count"], 1, "{body}");
    assert_eq!(
        position_of(&su, root, alice.id).await,
        Some(seen),
        "up to what it saw"
    );
    assert!(late > seen);
    assert_eq!(
        read_state_line(&http, &base, &alice_token, workspace, channel).await
            ["followed_unread_reply_count"],
        1,
        "the reply that landed meanwhile is still unread"
    );

    // Scene 2: another device reads further while read-all waits.
    let (root, _) = thread_with_replies(
        &http,
        &base,
        workspace,
        channel,
        &alice_token,
        &bob_token,
        1,
    )
    .await;
    let mut holder = su.begin().await.expect("begin holder");
    sqlx::query("SELECT 1 FROM thread_follow WHERE root_id = $1 AND member_id = $2 FOR UPDATE")
        .bind(root)
        .bind(alice.id)
        .execute(&mut *holder)
        .await
        .expect("hold alice's row");
    let call = {
        let (http, base, token) = (http.clone(), base.clone(), alice_token.clone());
        tokio::spawn(async move {
            read_all(
                &http,
                &base,
                &token,
                workspace,
                &json!({"channel_ids": [channel]}),
            )
            .await
        })
    };
    wait_for_lock_waiter(&su).await;
    let (_, further) = post_message(
        &http,
        &base,
        &bob_token,
        workspace,
        channel,
        Some(root),
        "더 뒤 답글",
    )
    .await;
    sqlx::query(
        "UPDATE thread_follow SET last_read_reply_seq = $3 WHERE root_id = $1 AND member_id = $2",
    )
    .bind(root)
    .bind(alice.id)
    .bind(further)
    .execute(&mut *holder)
    .await
    .expect("the other device reads to the newest reply");
    holder.commit().await.expect("release");
    call.await.expect("read-all task");
    assert_eq!(
        position_of(&su, root, alice.id).await,
        Some(further),
        "read-all never pulls a position back"
    );
}
