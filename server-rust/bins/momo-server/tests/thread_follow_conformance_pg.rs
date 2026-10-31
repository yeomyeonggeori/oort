//! #4889 / ADR-0206 증보 1 - thread following over HTTP:
//! `PUT` / `DELETE /v1/workspaces/{ws}/channels/{ch}/messages/{root}/follow` and the `following`
//! field of `GET …/messages/{root}/replies`.
//!
//! 1. a reply sent over REST follows the replier and the root's author; `GET …/replies` tells each
//!    caller about **their own** state, on every page
//! 2. `PUT` follows (idempotent), `DELETE` stops, and what was stopped stays stopped when the next
//!    reply or mention arrives
//! 3. a non-member, another workspace, an unknown root, a reply used as a root, a DM and a bad id
//!    are refused with the status and the sentence the thread read uses — and write nothing
//! 4. an agent bearer is refused whatever scopes it carries
//!
//! `#[ignore]` - needs a real Postgres:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26914/postgres \
//!   cargo test -p momo-server --test thread_follow_conformance_pg -- --ignored --test-threads=1
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
    handle: String,
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
    Human { id, email, handle }
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

async fn state_of(su: &PgPool, root: Uuid, member: Uuid) -> Option<String> {
    sqlx::query_scalar("SELECT state FROM thread_follow WHERE root_id = $1 AND member_id = $2")
        .bind(root)
        .bind(member)
        .fetch_optional(su)
        .await
        .expect("read state")
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

fn follow_url(base: &str, workspace: Uuid, channel: Uuid, root: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/messages/{root}/follow")
}

fn replies_url(base: &str, workspace: Uuid, channel: Uuid, root: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/messages/{root}/replies")
}

/// `POST …/messages` — a root (`root = None`) or a reply. Returns the new message id.
async fn post_message(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    root: Option<Uuid>,
    body: &str,
) -> Uuid {
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
    Uuid::parse_str(body["id"].as_str().expect("message id")).expect("message id is a uuid")
}

async fn put_follow(http: &reqwest::Client, url: &str, token: &str) -> (u16, Value) {
    let response = http
        .put(url)
        .bearer_auth(token)
        .send()
        .await
        .expect("PUT follow");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn delete_follow(http: &reqwest::Client, url: &str, token: &str) -> (u16, Value) {
    let response = http
        .delete(url)
        .bearer_auth(token)
        .send()
        .await
        .expect("DELETE follow");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn replies_page(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    query: &[(&str, &str)],
) -> Value {
    let response = http
        .get(url)
        .query(query)
        .bearer_auth(token)
        .send()
        .await
        .expect("GET replies");
    assert_eq!(response.status(), 200, "the thread reads");
    response.json().await.expect("replies body")
}

fn message_of(body: &Value) -> &str {
    body["error"]["message"].as_str().unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 1 + 2 — the flow
// ---------------------------------------------------------------------------

/// A REST reply follows its author and the root's author; `GET …/replies` reports the caller's own
/// state on **every** page; `PUT` / `DELETE` flip it; and a stopped thread stays stopped when the next
/// reply names the person.
///
/// Red if the auto-follow call leaves the send path (alice and bob read `false`), if `following` is
/// read for the wrong member, or if the automatic write can flip `unfollowed` back (carol's last
/// assertion).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_reply_follows_and_put_delete_flip_and_a_stopped_thread_stays_stopped() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();

    let workspace = seed_workspace(&su, "follow-flow").await;
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

    let root = post_message(&http, &base, &alice_token, workspace, channel, None, "원문").await;
    let url = replies_url(&base, workspace, channel, root);
    let empty = replies_page(&http, &url, &alice_token, &[]).await;
    assert_eq!(
        empty["following"], false,
        "a thread nobody replied to has no follower yet (and the field is present)"
    );

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
    post_message(
        &http,
        &base,
        &bob_token,
        workspace,
        channel,
        Some(root),
        "둘째 답글",
    )
    .await;
    assert_eq!(state_of(&su, root, alice.id).await.as_deref(), Some("auto"));
    assert_eq!(state_of(&su, root, bob.id).await.as_deref(), Some("auto"));
    assert_eq!(state_of(&su, root, carol.id).await, None);

    for (token, who, expect) in [
        (&alice_token, "alice (root author)", true),
        (&bob_token, "bob (replier)", true),
        (&carol_token, "carol (bystander)", false),
    ] {
        let first = replies_page(&http, &url, token, &[("limit", "1")]).await;
        assert_eq!(first["following"], expect, "{who}: the first page");
        let cursor = first["nextCursor"].as_i64().expect("a second page exists");
        let second = replies_page(&http, &url, token, &[("cursor", &cursor.to_string())]).await;
        assert_eq!(
            second["following"], expect,
            "{who}: every page carries the field"
        );
    }

    // carol follows (idempotent), then stops
    let follow = follow_url(&base, workspace, channel, root);
    let (status, body) = put_follow(&http, &follow, &carol_token).await;
    assert_eq!(
        (status, &body["following"]),
        (200, &json!(true)),
        "PUT → following"
    );
    let (status, body) = put_follow(&http, &follow, &carol_token).await;
    assert_eq!(
        (status, &body["following"]),
        (200, &json!(true)),
        "a second PUT is the same"
    );
    assert_eq!(
        state_of(&su, root, carol.id).await.as_deref(),
        Some("followed")
    );
    assert_eq!(
        replies_page(&http, &url, &carol_token, &[]).await["following"],
        true,
        "the thread read sees the write"
    );

    let (status, body) = delete_follow(&http, &follow, &carol_token).await;
    assert_eq!(
        (status, &body["following"]),
        (200, &json!(false)),
        "DELETE → not following"
    );
    let (status, body) = delete_follow(&http, &follow, &carol_token).await;
    assert_eq!(
        (status, &body["following"]),
        (200, &json!(false)),
        "a second DELETE is the same"
    );
    assert_eq!(
        state_of(&su, root, carol.id).await.as_deref(),
        Some("unfollowed")
    );
    assert_eq!(
        replies_page(&http, &url, &carol_token, &[]).await["following"],
        false
    );

    // the next reply names carol, and she replies herself: she stays stopped
    post_message(
        &http,
        &base,
        &bob_token,
        workspace,
        channel,
        Some(root),
        &format!("@{} 보고 있어요?", carol.handle),
    )
    .await;
    post_message(
        &http,
        &base,
        &carol_token,
        workspace,
        channel,
        Some(root),
        "네 보고 있어요",
    )
    .await;
    assert_eq!(
        state_of(&su, root, carol.id).await.as_deref(),
        Some("unfollowed"),
        "neither a mention nor her own reply follows her again"
    );
    assert_eq!(
        replies_page(&http, &url, &carol_token, &[]).await["following"],
        false
    );
    // …and the way back is the explicit one
    let (status, body) = put_follow(&http, &follow, &carol_token).await;
    assert_eq!((status, &body["following"]), (200, &json!(true)));
    // another person's follow state is never visible through this member's read
    assert_eq!(
        replies_page(&http, &url, &bob_token, &[]).await["following"],
        true
    );
}

// ---------------------------------------------------------------------------
// 3 — refusals
// ---------------------------------------------------------------------------

/// Every refusal answers with the status and the sentence the thread read uses, and writes nothing.
///
/// Red if the membership guard is removed (the outsider and the cross-tenant caller would get 200 and
/// a row), if the root guard is removed (the bad roots would get 200), or if the DM guard is removed.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn refusals_are_the_thread_reads_and_write_nothing() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();

    let workspace = seed_workspace(&su, "follow-refuse-a").await;
    let other = seed_workspace(&su, "follow-refuse-b").await;
    let alice = seed_human(&su, workspace, "alice").await;
    let bob = seed_human(&su, workspace, "bob").await;
    let outsider = seed_human(&su, workspace, "outsider").await; // workspace member, not in the channel
    let stranger = seed_human(&su, other, "stranger").await;
    let channel = seed_channel(&su, workspace, "public", alice.id).await;
    join(&su, workspace, channel, alice.id).await;
    join(&su, workspace, channel, bob.id).await;
    let alice_token = login(&http, &base, workspace, &alice.email).await;
    let bob_token = login(&http, &base, workspace, &bob.email).await;
    let outsider_token = login(&http, &base, workspace, &outsider.email).await;
    let stranger_token = login(&http, &base, other, &stranger.email).await;

    let root = post_message(&http, &base, &alice_token, workspace, channel, None, "원문").await;
    let reply = post_message(
        &http,
        &base,
        &bob_token,
        workspace,
        channel,
        Some(root),
        "답글",
    )
    .await;
    let rows_before = rows_of(&su, root).await;

    // not a member of the channel
    let (status, body) = put_follow(
        &http,
        &follow_url(&base, workspace, channel, root),
        &outsider_token,
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(message_of(&body), "not a member of this channel");
    // …and the thread read refuses the same caller with the same words
    let read = http
        .get(replies_url(&base, workspace, channel, root))
        .bearer_auth(&outsider_token)
        .send()
        .await
        .expect("outsider reads the thread");
    assert_eq!(read.status(), 403);
    let read_body: Value = read.json().await.expect("body");
    assert_eq!(
        message_of(&read_body),
        message_of(&body),
        "same bytes as the read"
    );
    let (status, _) = delete_follow(
        &http,
        &follow_url(&base, workspace, channel, root),
        &outsider_token,
    )
    .await;
    assert_eq!(status, 403, "stopping is guarded like following");

    // another workspace: the path names the wrong tenant for the credential
    let (status, body) = put_follow(
        &http,
        &follow_url(&base, workspace, channel, root),
        &stranger_token,
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(message_of(&body), "workspace scope mismatch");
    // the stranger's own tenant, but this tenant's channel and root: the channel does not exist there
    let (status, body) = put_follow(
        &http,
        &follow_url(&base, other, channel, root),
        &stranger_token,
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(
        message_of(&body),
        "not a member of this channel",
        "another tenant's channel is indistinguishable from a channel the caller is not in"
    );

    // the root
    let (status, body) = put_follow(
        &http,
        &follow_url(&base, workspace, channel, Uuid::new_v4()),
        &bob_token,
    )
    .await;
    assert_eq!(status, 404, "an unknown root");
    assert_eq!(message_of(&body), "thread root not found");
    let (status, body) = put_follow(
        &http,
        &follow_url(&base, workspace, channel, reply),
        &bob_token,
    )
    .await;
    assert_eq!(status, 400, "a reply is not a thread root");
    assert_eq!(message_of(&body), "thread root must be a top-level message");
    let (status, _) = http
        .put(format!(
            "{base}/v1/workspaces/{workspace}/channels/{channel}/messages/not-a-uuid/follow"
        ))
        .bearer_auth(&bob_token)
        .send()
        .await
        .map(|response| (response.status().as_u16(), ()))
        .expect("bad id");
    assert_eq!(status, 400, "a malformed root id");

    // a DM
    let dm = seed_channel(&su, workspace, "dm", alice.id).await;
    join(&su, workspace, dm, alice.id).await;
    join(&su, workspace, dm, bob.id).await;
    let dm_root = post_message(&http, &base, &alice_token, workspace, dm, None, "DM 원문").await;
    let (status, body) = put_follow(
        &http,
        &follow_url(&base, workspace, dm, dm_root),
        &bob_token,
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(body["error"]["code"], "thread_follow_not_applicable");
    assert_eq!(state_of(&su, dm_root, bob.id).await, None);
    // a DM thread read still answers, with `following: false`
    post_message(
        &http,
        &base,
        &bob_token,
        workspace,
        dm,
        Some(dm_root),
        "DM 답글",
    )
    .await;
    assert_eq!(
        replies_page(
            &http,
            &replies_url(&base, workspace, dm, dm_root),
            &bob_token,
            &[]
        )
        .await["following"],
        false
    );
    assert_eq!(rows_of(&su, dm_root).await, 0);

    assert_eq!(
        rows_of(&su, root).await,
        rows_before,
        "no refusal above wrote a row"
    );
    assert_eq!(state_of(&su, root, outsider.id).await, None);
    assert_eq!(state_of(&su, root, stranger.id).await, None);
}

// ---------------------------------------------------------------------------
// 4 — agents
// ---------------------------------------------------------------------------

/// No agent bearer reaches the follow routes, whatever scopes it carries — while the same bearer, with
/// `messages:read`, can still read the thread (and reads `following: false`: agents never follow).
///
/// Red if `require_human` is dropped **and** an agent scope ever opens the path; today the
/// route is also absent from `required_agent_scope`, so the door refuses first. Either way the table
/// below must stay empty for the agent.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_agent_bearer_cannot_follow_whatever_its_scopes() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();

    let workspace = seed_workspace(&su, "follow-agent").await;
    let alice = seed_human(&su, workspace, "alice").await;
    let agent = seed_agent(&su, workspace, alice.id).await;
    let channel = seed_channel(&su, workspace, "public", alice.id).await;
    join(&su, workspace, channel, alice.id).await;
    join(&su, workspace, channel, agent).await;
    let alice_token = login(&http, &base, workspace, &alice.email).await;
    let root = post_message(&http, &base, &alice_token, workspace, channel, None, "원문").await;
    let broad = agent_bearer(
        &su,
        workspace,
        agent,
        &["messages:write", "messages:read", "read-state:write"],
    )
    .await;

    let follow = follow_url(&base, workspace, channel, root);
    let (put_status, _) = put_follow(&http, &follow, &broad).await;
    let (delete_status, _) = delete_follow(&http, &follow, &broad).await;
    assert_eq!(put_status, 403, "PUT is refused for an agent bearer");
    assert_eq!(delete_status, 403, "DELETE is refused for an agent bearer");
    assert_eq!(
        state_of(&su, root, agent).await,
        None,
        "nothing was written for the agent"
    );
    assert_eq!(rows_of(&su, root).await, 0);

    let read = http
        .get(replies_url(&base, workspace, channel, root))
        .bearer_auth(&broad)
        .send()
        .await
        .expect("agent reads the thread");
    assert_eq!(
        read.status(),
        200,
        "control: `messages:read` still reads the thread"
    );
    let page: Value = read.json().await.expect("replies body");
    assert_eq!(page["following"], false, "an agent never follows");
}
