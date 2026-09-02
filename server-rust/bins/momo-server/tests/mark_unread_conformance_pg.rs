//! #1934 / ADR-0178 — mark-unread signal on `PUT …/read-state`.
//!
//! Red proofs (brief §서버 절반 + 개정 1 / D6 `read_intent`):
//!   1. mark set, then a stale/background advertisement with a lower seq
//!      (GREATEST no-op) → the mark survives, and `unread_count` is **not**
//!      recomposed from it (D3: composition lives in momo-core only)
//!   2. `read_intent=explicit_open` → the mark is cleared in the same request
//!   3. a future or non-existent mark seq is 400 and writes nothing (cursor
//!      and mark both stay where they were)
//!   4. GREATEST regression 0 — a lower `last_read_seq` still cannot rewind
//!   5. unknown `read_intent` is 400; absent means background
//!
//! The fixtures are hostile to a shallow implementation:
//!   * the stale advertisement uses a seq that is *in range* (not 0, not
//!     negative) so a "seq < 1" guard cannot fake survival
//!   * explicit_open is sent with a seq that does **not** advance the cursor,
//!     so an "advanced ⇒ clear" inference cannot pass
//!   * the future-seq 400 is sent alongside a cursor that *would* have
//!     advanced, so a "validate after write" implementation leaves a footprint
//!
//! `#[ignore]` — needs a real Postgres. Gate PG is the 15432 convention:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test mark_unread_conformance_pg \
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

const TEST_JWT_SECRET: &str = "mark-unread-conformance-signing-secret";
const TEST_PASSWORD: &str = "mark-unread-test-password";
/// Five messages so a stale advertisement can name a real, in-range seq
/// (2) that is still behind the cursor (5). A 0/1-message fixture would
/// hide a bug that only shows up when GREATEST has something to refuse.
const MESSAGE_COUNT: i64 = 5;

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
    channel: Uuid,
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
    let email = format!("{id}@mark-unread.test");
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
    let member = seed_human(
        su,
        workspace,
        &format!("me-{}", &Uuid::new_v4().simple().to_string()[..8]),
    )
    .await;
    let channel = seed_public_channel(su, workspace, member.id).await;
    seed_channel_membership(su, workspace, channel, member.id).await;
    for index in 1..=MESSAGE_COUNT {
        seed_message(
            su,
            workspace,
            channel,
            member.id,
            &format!("mark-unread fixture {index}"),
        )
        .await;
    }
    Fixture {
        workspace,
        member,
        channel,
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

fn put_url(base: &str, workspace: Uuid, channel: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/channels/{channel}/read-state")
}

fn list_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/read-state")
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

async fn put_read_state(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    body: Value,
) -> reqwest::Response {
    http.put(put_url(base, workspace, channel))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("PUT read-state")
}

async fn put_ok(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    body: Value,
) -> Value {
    let response = put_read_state(http, base, token, workspace, channel, body).await;
    let status = response.status();
    let parsed: Value = response.json().await.expect("PUT body");
    assert_eq!(status, 200, "PUT read-state is 200: {parsed}");
    parsed
}

async fn list_ok(http: &reqwest::Client, base: &str, token: &str, workspace: Uuid) -> Value {
    let response = http
        .get(list_url(base, workspace))
        .bearer_auth(token)
        .send()
        .await
        .expect("GET read-state");
    assert_eq!(response.status(), 200, "GET read-state is 200");
    response.json().await.expect("GET body")
}

fn entry_for(list: &Value, channel: Uuid) -> &Value {
    let channel = channel.to_string();
    list["read_states"]
        .as_array()
        .expect("read_states array")
        .iter()
        .find(|entry| entry["channel_id"] == json!(channel))
        .expect("channel is listed")
}

/// The mark key is always present so a client can tell "no mark" from
/// "this server is too old to have the concept". `json["missing"]` is
/// Null in serde_json, so `.get` is the assertion that actually proves it.
fn assert_mark(body: &Value, expected: Option<i64>) {
    let value = body
        .get("marked_unread_before_seq")
        .unwrap_or_else(|| panic!("marked_unread_before_seq key must always be present: {body}"));
    match expected {
        Some(seq) => assert_eq!(value, &json!(seq), "{body}"),
        None => assert!(
            value.is_null(),
            "unmarked must be JSON null, not omitted: {body}"
        ),
    }
}

async fn boot(hint: &str) -> (reqwest::Client, String, String, Fixture) {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su, hint).await;
    let base = start_server(app).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.member.email).await;
    (http, base, token, fixture)
}

// ---------------------------------------------------------------------------
// 1. mark survives a stale / background GREATEST no-op
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn mark_unread_survives_a_stale_background_advertisement() {
    let _guard = test_lock().await;
    let (http, base, token, fixture) = boot("survive").await;

    // Catch up to the head so unread_count is 0. A mark behind that cursor is
    // the *normal* case (the reader finished the channel, then marked a
    // point they want to return to).
    let caught_up = put_ok(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        json!({"last_read_seq": MESSAGE_COUNT}),
    )
    .await;
    assert_eq!(caught_up["last_read_seq"], json!(MESSAGE_COUNT));
    assert_eq!(caught_up["unread_count"], json!(0));
    assert_mark(&caught_up, None);

    let marked = put_ok(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        json!({
            "last_read_seq": MESSAGE_COUNT,
            "mark_unread_before_seq": 3,
        }),
    )
    .await;
    assert_eq!(marked["last_read_seq"], json!(MESSAGE_COUNT));
    assert_mark(&marked, Some(3));
    assert_eq!(
        marked["unread_count"],
        json!(0),
        "D3: the server must not fold the mark into unread_count; \
         composition is momo-core's job. last_read=5, latest=5 ⇒ 0, \
         even though the mark says 'unread from 3'"
    );

    let listed = list_ok(&http, &base, &token, fixture.workspace).await;
    let entry = entry_for(&listed, fixture.channel);
    assert_mark(entry, Some(3));
    assert_eq!(entry["last_read_seq"], json!(MESSAGE_COUNT));
    assert_eq!(entry["unread_count"], json!(0));

    // Proof ①: another device replays an older cursor. GREATEST is a no-op
    // on last_read_seq, and because the request carries no explicit_open
    // intent (absent = background), the mark must stay.
    let stale = put_ok(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        json!({"last_read_seq": 2}),
    )
    .await;
    assert_eq!(
        stale["last_read_seq"],
        json!(MESSAGE_COUNT),
        "GREATEST still refuses to rewind"
    );
    assert_mark(&stale, Some(3));

    // The same property with the intent spelled out, so a default-only
    // implementation cannot pass by ignoring the field entirely.
    let background = put_ok(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        json!({
            "last_read_seq": 1,
            "read_intent": "background",
        }),
    )
    .await;
    assert_eq!(background["last_read_seq"], json!(MESSAGE_COUNT));
    assert_mark(&background, Some(3));

    // A background *advance* (message arrived while the channel stayed open)
    // must also leave the mark. D6 exists because this request is
    // byte-identical to an explicit re-open except for the intent field.
    let arrived = put_ok(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        json!({
            "last_read_seq": MESSAGE_COUNT,
            "read_intent": "background",
        }),
    )
    .await;
    assert_mark(&arrived, Some(3));
}

// ---------------------------------------------------------------------------
// 2. explicit_open clears the mark in the same request
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn explicit_open_clears_the_mark_in_the_same_request() {
    let _guard = test_lock().await;
    let (http, base, token, fixture) = boot("clear").await;

    put_ok(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        json!({"last_read_seq": MESSAGE_COUNT}),
    )
    .await;
    put_ok(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        json!({
            "last_read_seq": MESSAGE_COUNT,
            "mark_unread_before_seq": 2,
        }),
    )
    .await;

    // Re-opening a channel whose head has not moved does not advance the
    // cursor. If the server inferred "clear when advanced", this would leave
    // the mark — which is exactly the case D6 has to get right.
    let opened = put_ok(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        json!({
            "last_read_seq": MESSAGE_COUNT,
            "read_intent": "explicit_open",
        }),
    )
    .await;
    assert_eq!(opened["last_read_seq"], json!(MESSAGE_COUNT));
    assert_mark(&opened, None);

    let listed = list_ok(&http, &base, &token, fixture.workspace).await;
    assert_mark(entry_for(&listed, fixture.channel), None);
}

// ---------------------------------------------------------------------------
// 3. future / non-existent seq is 400 and writes nothing
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_future_or_unknown_mark_seq_is_400_and_writes_nothing() {
    let _guard = test_lock().await;
    let (http, base, token, fixture) = boot("future").await;

    let baseline = put_ok(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        json!({"last_read_seq": 3}),
    )
    .await;
    assert_eq!(baseline["last_read_seq"], json!(3));
    assert_mark(&baseline, None);

    // Seq 6 is one past the head — the smallest future value. A
    // `seq <= latest` check that forgot to look at `message` would still
    // refuse this; the next request is the one that needs the row lookup.
    let future = put_read_state(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        json!({
            "last_read_seq": MESSAGE_COUNT,
            "mark_unread_before_seq": MESSAGE_COUNT + 1,
        }),
    )
    .await;
    let (status, message) = error_status_message(future).await;
    assert_eq!(status, 400, "a future seq is 400, not stored: {message}");
    assert!(
        message.to_lowercase().contains("not") || message.contains("exist"),
        "plain-language refusal, not an internal code: {message}"
    );
    assert!(
        !message.to_lowercase().contains("select") && !message.contains("read_state"),
        "the error must not leak SQL: {message}"
    );

    // A clock-shaped value is a seq this channel has never handed out. It
    // would also be clamped as a *cursor*; as a mark it must 400, not clamp.
    let clocklike: i64 = 1_764_547_200_000;
    let (status, message) = error_status_message(
        put_read_state(
            &http,
            &base,
            &token,
            fixture.workspace,
            fixture.channel,
            json!({
                "last_read_seq": MESSAGE_COUNT,
                "mark_unread_before_seq": clocklike,
            }),
        )
        .await,
    )
    .await;
    assert_eq!(status, 400, "a non-existent seq is 400: {message}");

    // The 400s travelled with a last_read_seq that *would* have advanced
    // 3 → 5. Validation runs before the first write, so neither the cursor
    // nor a mark is sitting in the row.
    let listed = list_ok(&http, &base, &token, fixture.workspace).await;
    let entry = entry_for(&listed, fixture.channel);
    assert_eq!(
        entry["last_read_seq"],
        json!(3),
        "a refused mark must not sneak a cursor advance through"
    );
    assert_mark(entry, None);
}

// ---------------------------------------------------------------------------
// 4. GREATEST regression 0
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn greatest_still_refuses_to_rewind_without_a_mark() {
    let _guard = test_lock().await;
    let (http, base, token, fixture) = boot("greatest").await;

    let advanced = put_ok(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        json!({"last_read_seq": 4}),
    )
    .await;
    assert_eq!(advanced["last_read_seq"], json!(4));
    assert_eq!(advanced["unread_count"], json!(1));

    let stale = put_ok(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        json!({"last_read_seq": 1}),
    )
    .await;
    assert_eq!(
        stale["last_read_seq"],
        json!(4),
        "GREATEST is unchanged by the mark-unread column"
    );
    assert_eq!(stale["unread_count"], json!(1));
    assert_mark(&stale, None);
}

// ---------------------------------------------------------------------------
// 5. unknown read_intent → 400; absent → background
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn unknown_read_intent_is_400_and_absent_means_background() {
    let _guard = test_lock().await;
    let (http, base, token, fixture) = boot("intent").await;

    put_ok(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        json!({"last_read_seq": MESSAGE_COUNT}),
    )
    .await;
    put_ok(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        json!({
            "last_read_seq": MESSAGE_COUNT,
            "mark_unread_before_seq": 4,
        }),
    )
    .await;

    // A typo must not silently become background *or* explicit_open.
    // "stale_flush" is a plausible name a client might invent for the
    // phone's AppState != active path — exactly the event that must not
    // clear the mark, and also not a valid enum member.
    let (status, message) = error_status_message(
        put_read_state(
            &http,
            &base,
            &token,
            fixture.workspace,
            fixture.channel,
            json!({
                "last_read_seq": MESSAGE_COUNT,
                "read_intent": "stale_flush",
            }),
        )
        .await,
    )
    .await;
    assert_eq!(
        status, 400,
        "unknown read_intent is 400, not a silent default: {message}"
    );
    assert!(
        message.contains("read_intent"),
        "the refusal names the field: {message}"
    );

    let listed = list_ok(&http, &base, &token, fixture.workspace).await;
    // The 400 wrote nothing, so the mark the previous PUT set is intact.
    assert_mark(entry_for(&listed, fixture.channel), Some(4));

    // Absent intent is background: the mark stays. This is the safety
    // default — every client that predates the field sends nothing.
    let absent = put_ok(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        json!({"last_read_seq": MESSAGE_COUNT}),
    )
    .await;
    assert_mark(&absent, Some(4));
}
