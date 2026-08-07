//! #1130 전제① — **the growing body**, end to end over HTTP.
//!
//! 실측이 이 파일을 만든 이유 (#1120 prime 스파이크,
//! `docs/planning/research/2026-08-06-prime-agent-spike.md` §2): a 3,661-character
//! streamed answer, already coalesced **30.8×**, still needed **17 REST writes**.
//! Through `POST …/messages` that is 17 messages, 17 `seq` values and 17 rows in
//! everybody's timeline for one sentence. The contract proven here turns those
//! same 17 writes into **one message that grows**.
//!
//! The loop is the real one — real router, real Postgres, real RLS, real outbox
//! — because every claim below is about something only the deployed stack can
//! answer: that the channel counter does not move, that the row stays one row,
//! that a not-newer slice writes nothing, and that a machine assembling an
//! answer never stamps the "수정됨" a human's edit stamps.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test stream_edit_conformance_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract is `http_smoke_pg.rs`'s: `DATABASE_URL` connects as a
//! **superuser** (migrations + `infra/e2e/bootstrap_roles.sql`, fixture seeding
//! bypasses RLS) while the server runs on the runtime **`momo_app`** role
//! (`NOBYPASSRLS`), so every assertion is made through the policies production
//! uses. Fresh random UUIDs per test — the binary shares a container happily.

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

const TEST_JWT_SECRET: &str = "stream-edit-conformance-signing-secret";
const TEST_PASSWORD: &str = "stream-edit-test-password";

/// The measured slice count of one streamed answer. Every "one message, not N"
/// claim below is made at the number the spike actually produced, not a
/// convenient two.
const MEASURED_SLICES: i64 = 17;

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

/// A human who can log in. Two of them, because the authorship red proof needs a
/// *credential* that is not the author's — asserting the refusal with the
/// author's own token would prove nothing.
struct Person {
    member: Uuid,
    email: String,
}

struct Fixture {
    workspace: Uuid,
    channel: Uuid,
    author: Person,
    bystander: Person,
}

async fn seed_person(su: &PgPool, workspace: Uuid) -> Person {
    let member = Uuid::new_v4();
    let email = format!("{member}@stream.test");
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
    Person { member, email }
}

async fn seed(su: &PgPool, app: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");

    let author = seed_person(su, workspace).await;
    let bystander = seed_person(su, workspace).await;

    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("stream-{}", Uuid::new_v4()),
            topic: None,
            created_by: author.member,
        },
    )
    .await
    .expect("create channel");

    // The bystander is a channel member too — otherwise the authorship refusal
    // would be indistinguishable from a membership one, and the red proof would
    // be green for the wrong reason.
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member'::membership_role) \
         ON CONFLICT (channel_id, member_id) DO NOTHING",
    )
    .bind(workspace)
    .bind(channel.id)
    .bind(bystander.member)
    .execute(su)
    .await
    .expect("join the bystander to the channel");

    Fixture {
        workspace,
        channel: channel.id,
        author,
        bystander,
    }
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, person: &Person) -> String {
    let body: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": person.email,
            "password": TEST_PASSWORD,
            "workspace": workspace.to_string(),
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
// wire helpers — exactly the two calls a streaming adapter makes
// ---------------------------------------------------------------------------

/// `POST …/messages` — the first slice, which is what creates the row.
///
/// `client_msg_id` is fixed for the whole turn, so a retried *opening* write
/// returns the message already in the channel instead of opening a second one.
/// That is the spine's own idempotency guard, not a new one.
async fn open(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    fx: &Fixture,
    turn: Uuid,
    body: &str,
) -> Value {
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fx.workspace, fx.channel
        ))
        .bearer_auth(token)
        .json(&json!({ "clientMsgId": turn.to_string(), "body": body }))
        .send()
        .await
        .expect("open the streamed message");
    assert_eq!(response.status(), 201, "the opening write creates");
    response.json().await.expect("opening message body")
}

/// `PATCH …/messages/{id}` with a `stream` block — one slice.
///
/// `body` is the **whole text so far**, never a delta: the writer owns the
/// accumulator, which is what makes a retry idempotent. (The spike's own
/// `RestSink` mints a fresh key per write and would duplicate on retry — this
/// contract removes the trap rather than documenting it.)
///
/// Eight arguments because a slice genuinely names eight things (who, where,
/// which message, what text, which revision, is it the last); folding them into
/// a struct would put a layer of indirection between a test and the request it
/// is asserting about.
#[allow(clippy::too_many_arguments)]
async fn slice(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    fx: &Fixture,
    message_id: &str,
    body: &str,
    rev: i64,
    is_final: bool,
) -> (reqwest::StatusCode, Value) {
    let response = http
        .patch(format!(
            "{base}/v1/workspaces/{}/messages/{message_id}",
            fx.workspace
        ))
        .bearer_auth(token)
        .json(&json!({ "body": body, "stream": { "rev": rev, "final": is_final } }))
        .send()
        .await
        .expect("send a slice");
    let status = response.status();
    let body = response.json().await.unwrap_or(Value::Null);
    (status, body)
}

/// The closing `PATCH` of ADR-0155 — a slice that also says **how** the stream
/// ended.
///
/// Separate from [`slice`] rather than a ninth parameter on it, because the two
/// are different events: `slice` is the answer arriving, this is the answer
/// stopping. Keeping them apart is also what lets this helper send the invalid
/// combinations a producer must be refused for (`final: false` with an outcome,
/// an outcome nobody defined) without teaching the ordinary path a shape it
/// never sends.
#[allow(clippy::too_many_arguments)]
async fn close_slice(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    fx: &Fixture,
    message_id: &str,
    body: &str,
    rev: i64,
    is_final: bool,
    outcome: &str,
) -> (reqwest::StatusCode, Value) {
    let response = http
        .patch(format!(
            "{base}/v1/workspaces/{}/messages/{message_id}",
            fx.workspace
        ))
        .bearer_auth(token)
        .json(&json!({
            "body": body,
            "stream": {"rev": rev, "final": is_final, "outcome": outcome},
        }))
        .send()
        .await
        .expect("send a closing slice");
    let status = response.status();
    let body = response.json().await.unwrap_or(Value::Null);
    (status, body)
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

async fn channel_last_seq(su: &PgPool, channel: Uuid) -> i64 {
    sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(su)
        .await
        .expect("read channel_seq")
}

async fn message_count(su: &PgPool, channel: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(su)
        .await
        .expect("count messages")
}

async fn broadcasts(su: &PgPool, channel: Uuid) -> Vec<Value> {
    sqlx::query_scalar::<_, Value>(
        "SELECT payload->'data' FROM outbox \
          WHERE partition_key = $1 AND kind::text = 'broadcast' ORDER BY id",
    )
    .bind(channel)
    .fetch_all(su)
    .await
    .expect("read broadcasts")
}

async fn audit_actions(su: &PgPool, workspace: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT action FROM audit_log WHERE workspace_id = $1 \
           AND action LIKE 'message.%' ORDER BY id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read audit actions")
}

async fn stored(su: &PgPool, message_id: Uuid) -> (Option<String>, String, Option<i64>, Value) {
    let row: (
        Option<String>,
        String,
        Option<chrono::DateTime<chrono::Utc>>,
        Value,
    ) = sqlx::query_as("SELECT body, state::text, edited_at, props FROM message WHERE id = $1")
        .bind(message_id)
        .fetch_one(su)
        .await
        .expect("read the message row");
    (row.0, row.1, row.2.map(|at| at.timestamp_millis()), row.3)
}

// ---------------------------------------------------------------------------
// #1 — the closed loop: 17 writes, one message
// ---------------------------------------------------------------------------

/// **The polygon this ticket exists to close.** One opening `POST` and 16
/// `PATCH` slices — the spike's measured 17 writes — leave the channel holding
/// **one** message whose body is the whole answer.
///
/// Four assertions, each of which goes red on its own reversion:
///
/// 1. `channel_seq` advanced exactly once. Make the streaming path consume a
///    seq and this reads 17 — which would ship as "one answer marks the channel
///    17 unread for everyone".
/// 2. The channel holds one row. Make an adapter fall back to `send` per slice
///    and this reads 17.
/// 3. The final body is the whole answer, and the row still says `sent` with a
///    NULL `edited_at`. Stamp `edited`/`edited_at` on the streaming path (i.e.
///    reuse `edit_message_in_tx`) and the last two go red — which is the
///    "수정됨" badge appearing on every streamed message from its first slice.
/// 4. Every broadcast names the message's own seq and carries the whole body.
///    That is why no client re-reads anything: were the frame body-less, 16
///    slices would be 16 history round trips per connected client per turn.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn seventeen_writes_leave_one_growing_message_and_one_seq() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fx = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fx.workspace, &fx.author).await;

    // A Korean answer, because a slice boundary in Korean is where a naive byte
    // split stops being text — and because momo's channels are mostly Korean.
    let words: Vec<String> = (1..=MEASURED_SLICES)
        .map(|n| format!("{n}번째 조각입니다. "))
        .collect();

    let turn = Uuid::new_v4();
    let opened = open(&http, &base, &token, &fx, turn, &words[0]).await;
    let message_id = opened["id"].as_str().expect("message id").to_string();
    let seq = opened["seq"].as_i64().expect("seq");
    let seq_after_open = channel_last_seq(&su, fx.channel).await;

    let mut accumulated = words[0].clone();
    for (index, word) in words.iter().enumerate().skip(1) {
        accumulated.push_str(word);
        let rev = index as i64;
        let is_final = index == words.len() - 1;
        let (status, body) = slice(
            &http,
            &base,
            &token,
            &fx,
            &message_id,
            &accumulated,
            rev,
            is_final,
        )
        .await;
        assert_eq!(status, 200, "slice {rev} was refused: {body}");
        assert_eq!(
            body["seq"].as_i64(),
            Some(seq),
            "a slice must answer with the message's original seq"
        );
    }

    // 1 — the counter moved once, for the opening write, and never again.
    assert_eq!(
        channel_last_seq(&su, fx.channel).await,
        seq_after_open,
        "{MEASURED_SLICES} writes must consume exactly one seq"
    );
    // 2 — and left one row.
    assert_eq!(
        message_count(&su, fx.channel).await,
        1,
        "a streamed answer is one message, not {MEASURED_SLICES}"
    );

    // 3 — the whole answer is there, and nobody edited anything.
    let uuid = Uuid::parse_str(&message_id).expect("uuid");
    let (body, state, edited_at_ms, props) = stored(&su, uuid).await;
    assert_eq!(body.as_deref(), Some(accumulated.as_str()));
    assert_eq!(
        state, "sent",
        "an answer arriving is not a revision of itself"
    );
    assert_eq!(
        edited_at_ms, None,
        "a growing body must never stamp the edit clock — that badge is a claim \
         a human revised what they said"
    );
    assert_eq!(props["momo.stream"]["rev"], json!(MEASURED_SLICES - 1));
    assert_eq!(
        props["momo.stream"]["streaming"],
        json!(false),
        "the final slice says the text has stopped arriving"
    );

    // 4 — one `message.new` then 16 `message.edited`, all at the same seq, each
    //     carrying the body a renderer needs.
    let frames = broadcasts(&su, fx.channel).await;
    assert_eq!(frames.len(), MEASURED_SLICES as usize);
    assert_eq!(frames[0]["type"], json!("message.new"));
    for frame in &frames[1..] {
        assert_eq!(frame["type"], json!("message.edited"));
        assert_eq!(frame["seq"].as_i64(), Some(seq), "no frame invents a seq");
        assert!(
            frame["payload"]["body"]
                .as_str()
                .is_some_and(|b| !b.is_empty()),
            "every slice frame carries its whole body: {frame}"
        );
        assert_eq!(
            frame["payload"]["edited_at_ms"],
            Value::Null,
            "…and none of them claims an edit"
        );
    }
    assert_eq!(
        frames.last().expect("final frame")["payload"]["body"],
        json!(accumulated),
        "the last frame is the whole answer"
    );

    // The audit trail is one row for the assembly, not one per slice: seventeen
    // `message.edited` rows would be seventeen false claims that a member
    // revised their words, and would drown the real edits an auditor reads for.
    assert_eq!(
        audit_actions(&su, fx.workspace).await,
        vec!["message.streamed".to_string()],
        "one assembled message leaves one audit row, written on the final slice"
    );
}

// ---------------------------------------------------------------------------
// #2 — RED: only the author may grow a message
// ---------------------------------------------------------------------------

/// **RED proof.** A channel member who is *not* the author cannot stream into
/// someone else's message. Drop the authorship guard from
/// `stream_message_body_in_tx` and this goes green with a 200 — which is a
/// contract under which anyone can rewrite anyone's words and blame the
/// streaming path for it.
///
/// The refusal is a **403 and not a 404**: the caller can already read the
/// message (the membership gate passed), so hiding its existence would protect
/// nothing while making "you may not" indistinguishable from a typo'd id.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_bystander_cannot_stream_into_someone_elses_message() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fx = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();

    let author_token = login(&http, &base, fx.workspace, &fx.author).await;
    let bystander_token = login(&http, &base, fx.workspace, &fx.bystander).await;

    let opened = open(
        &http,
        &base,
        &author_token,
        &fx,
        Uuid::new_v4(),
        "내가 쓴 첫 조각",
    )
    .await;
    let message_id = opened["id"].as_str().expect("message id").to_string();
    let frames_before = broadcasts(&su, fx.channel).await.len();

    let (status, error) = slice(
        &http,
        &base,
        &bystander_token,
        &fx,
        &message_id,
        "남의 글을 내 손으로 고쳐쓴다",
        1,
        false,
    )
    .await;
    assert_eq!(status, 403, "a non-author is refused: {error}");

    let uuid = Uuid::parse_str(&message_id).expect("uuid");
    let (body, _, _, props) = stored(&su, uuid).await;
    assert_eq!(
        body.as_deref(),
        Some("내가 쓴 첫 조각"),
        "the refusal left the body alone"
    );
    assert!(
        props.get("momo.stream").is_none(),
        "…and left no revision behind for a later slice to trip over"
    );
    assert_eq!(
        broadcasts(&su, fx.channel).await.len(),
        frames_before,
        "a refused slice publishes nothing"
    );
}

// ---------------------------------------------------------------------------
// #3 — RED: a not-newer revision writes nothing
// ---------------------------------------------------------------------------

/// **RED proof.** The staleness rule is idempotency and ordering in one line: a
/// `rev` that is not strictly greater than the stored one is a 200 that writes
/// nothing, publishes nothing and audits nothing.
///
/// Both halves matter and both are exercised here:
///
/// * **replay** — the adapter re-sends a slice it already sent (the spike's
///   `RestSink` has no retry key at all today, so this is the very first thing
///   a real adapter will do);
/// * **overtaken** — a slice arrives *after* its own successor, which at a
///   750ms window over 17 concurrent writes is not a hypothetical.
///
/// Remove the guard and the body rewinds mid-answer on every connected client,
/// and the outbox grows a frame that un-says what the last one said.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_replayed_or_overtaken_slice_writes_nothing_and_the_body_never_rewinds() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fx = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fx.workspace, &fx.author).await;

    let opened = open(&http, &base, &token, &fx, Uuid::new_v4(), "하나").await;
    let message_id = opened["id"].as_str().expect("message id").to_string();
    let uuid = Uuid::parse_str(&message_id).expect("uuid");

    for (body, rev) in [("하나 둘", 1), ("하나 둘 셋", 2)] {
        let (status, answer) =
            slice(&http, &base, &token, &fx, &message_id, body, rev, false).await;
        assert_eq!(status, 200, "slice {rev}: {answer}");
    }
    let frames_after_two = broadcasts(&su, fx.channel).await.len();

    // A replay of rev 2, byte-identical.
    let (status, answer) = slice(
        &http,
        &base,
        &token,
        &fx,
        &message_id,
        "하나 둘 셋",
        2,
        false,
    )
    .await;
    assert_eq!(
        status, 200,
        "a replay is not a failure — 409 would make a correct retry look broken: {answer}"
    );

    // …and rev 1 arriving late, carrying a body that is a *prefix* of the truth.
    let (status, answer) = slice(&http, &base, &token, &fx, &message_id, "하나 둘", 1, false).await;
    assert_eq!(status, 200, "an overtaken slice is not a failure: {answer}");
    assert_eq!(
        answer["body"],
        json!("하나 둘 셋"),
        "the stale answer still reports the row as it stands, not as the caller believed"
    );

    let (body, _, _, props) = stored(&su, uuid).await;
    assert_eq!(
        body.as_deref(),
        Some("하나 둘 셋"),
        "the body never rewinds to an earlier slice"
    );
    assert_eq!(props["momo.stream"]["rev"], json!(2));
    assert_eq!(
        broadcasts(&su, fx.channel).await.len(),
        frames_after_two,
        "neither the replay nor the overtaken slice published a frame"
    );
    assert!(
        audit_actions(&su, fx.workspace).await.is_empty(),
        "nothing was assembled yet, so nothing is audited"
    );
}

// ---------------------------------------------------------------------------
// #4 — the discriminator a consumer depends on
// ---------------------------------------------------------------------------

/// A human editing an assembled message **is** an edit, and it must be
/// distinguishable from the slices that built it — that difference is exactly
/// what `RealtimeSubscriptionDriver` uses to decide it may drop a stale stream
/// frame without ever dropping a person's correction.
///
/// So: after the stream finalises with `state = 'sent'` and no `edited_at`, a
/// plain `PATCH` (no `stream` block) stamps both. Collapse the two paths into
/// one and this goes red on whichever half you collapsed toward.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_human_edit_after_a_stream_is_still_an_edit() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fx = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fx.workspace, &fx.author).await;

    let opened = open(&http, &base, &token, &fx, Uuid::new_v4(), "초안").await;
    let message_id = opened["id"].as_str().expect("message id").to_string();
    let uuid = Uuid::parse_str(&message_id).expect("uuid");
    let (status, _) = slice(&http, &base, &token, &fx, &message_id, "초안 완성", 1, true).await;
    assert_eq!(status, 200);

    let (_, state, edited_at_ms, _) = stored(&su, uuid).await;
    assert_eq!(state, "sent");
    assert_eq!(edited_at_ms, None);

    let response = http
        .patch(format!(
            "{base}/v1/workspaces/{}/messages/{message_id}",
            fx.workspace
        ))
        .bearer_auth(&token)
        .json(&json!({ "body": "사람이 고친 문장" }))
        .send()
        .await
        .expect("plain edit");
    assert_eq!(response.status(), 200);

    let (body, state, edited_at_ms, props) = stored(&su, uuid).await;
    assert_eq!(body.as_deref(), Some("사람이 고친 문장"));
    assert_eq!(state, "edited", "a person revising their words is an edit");
    assert!(
        edited_at_ms.is_some(),
        "…and the edit clock is what says so"
    );
    assert_eq!(
        props["momo.stream"]["rev"],
        json!(1),
        "a plain edit leaves the producer's props alone, revision included"
    );

    assert_eq!(
        audit_actions(&su, fx.workspace).await,
        vec!["message.streamed".to_string(), "message.edited".to_string()],
        "the two writes leave two differently-named rows, in order"
    );
}

// ---------------------------------------------------------------------------
// #5 — the refusals the contract owns
// ---------------------------------------------------------------------------

/// A revision below 1 is a 400 with its own sentence, and a tombstone cannot be
/// streamed into.
///
/// `0` is refused rather than treated as "the first slice" because a message
/// that never streamed reads as revision `0`: accepting it would make "I am
/// first" and "I am a replay of nothing" the same request, and the strictly-
/// greater rule would have no floor.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_zero_revision_and_a_tombstone_are_both_refused_by_name() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fx = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fx.workspace, &fx.author).await;

    let opened = open(&http, &base, &token, &fx, Uuid::new_v4(), "살아있는 글").await;
    let message_id = opened["id"].as_str().expect("message id").to_string();

    for rev in [0, -1] {
        let (status, error) = slice(&http, &base, &token, &fx, &message_id, "더", rev, false).await;
        assert_eq!(status, 400, "rev {rev} must be refused: {error}");
        assert_eq!(
            error["error"]["message"]
                .as_str()
                .or(error["message"].as_str()),
            Some("stream revision must be a positive integer"),
            "the refusal keeps its own sentence: {error}"
        );
    }

    let deleted = http
        .delete(format!(
            "{base}/v1/workspaces/{}/messages/{message_id}",
            fx.workspace
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("delete");
    assert_eq!(deleted.status(), 200);

    let (status, error) = slice(
        &http,
        &base,
        &token,
        &fx,
        &message_id,
        "무덤에 글을 더 쓴다",
        1,
        false,
    )
    .await;
    assert_eq!(
        status, 400,
        "a tombstone must not grow a body back: {error}"
    );
}

// ---------------------------------------------------------------------------
// #6 — ADR-0155: the wire shape of a stream that was stopped
// ---------------------------------------------------------------------------

/// The optional field, proved from the outside: a closing slice may name an
/// `outcome`, and the response and the row both carry it.
///
/// The first half of the test is the **backward-compatibility assertion** the
/// ADR promised. A producer that has never heard of `outcome` sends exactly what
/// it always sent, and what comes back is exactly what always came back — no
/// `outcome` key, not a null one. That distinction is the contract: clients read
/// "did this answer finish?" as a key-presence test, and a server that stamped
/// `"outcome": null` on every completed answer would make every reader write a
/// null check nobody agreed to.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_closing_slice_may_name_how_the_stream_ended() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fx = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fx.workspace, &fx.author).await;

    // A turn that simply finished — the pre-ADR shape, unchanged.
    let finished = open(&http, &base, &token, &fx, Uuid::new_v4(), "끝까지 쓴 답").await;
    let finished_id = finished["id"].as_str().expect("message id").to_string();
    let (status, body) = slice(
        &http,
        &base,
        &token,
        &fx,
        &finished_id,
        "끝까지 쓴 답입니다.",
        1,
        true,
    )
    .await;
    assert_eq!(status, 200, "a plain final slice still works: {body}");
    let (_, _, _, props) = stored(&su, Uuid::parse_str(&finished_id).unwrap()).await;
    let finished_stream = props.get("momo.stream").expect("the marker");
    assert_eq!(
        finished_stream.get("outcome"),
        None,
        "a completed answer says nothing about how it ended, because it just ended"
    );

    // A turn that was stopped.
    let stopped = open(&http, &base, &token, &fx, Uuid::new_v4(), "절반쯤 쓰다가").await;
    let stopped_id = stopped["id"].as_str().expect("message id").to_string();
    let seq_before = channel_last_seq(&su, fx.channel).await;
    let (status, response) = close_slice(
        &http,
        &base,
        &token,
        &fx,
        &stopped_id,
        "절반쯤 쓰다가",
        1,
        true,
        "cancelled",
    )
    .await;
    assert_eq!(
        status, 200,
        "the closing slice is an ordinary 200: {response}"
    );
    assert_eq!(
        response["props"]["momo.stream"]["outcome"].as_str(),
        Some("cancelled"),
        "the response carries the verdict, so a producer can confirm the marking landed: {response}"
    );
    assert_eq!(
        response["state"].as_str(),
        Some("sent"),
        "a stop is not a revision: {response}"
    );
    assert!(
        response["editedAtMs"].is_null(),
        "and it stamps no 「수정됨」: {response}"
    );

    let (body, state, edited_at_ms, props) =
        stored(&su, Uuid::parse_str(&stopped_id).unwrap()).await;
    let stream_props = props.get("momo.stream").expect("the marker");
    assert_eq!(
        stream_props.get("outcome").and_then(Value::as_str),
        Some("cancelled")
    );
    assert_eq!(
        stream_props.get("streaming").and_then(Value::as_bool),
        Some(false),
        "a marked ending is not still arriving"
    );
    assert_eq!(
        body.as_deref(),
        Some("절반쯤 쓰다가"),
        "the frozen body is what the human read when they pressed stop"
    );
    assert_eq!(state, "sent");
    assert_eq!(edited_at_ms, None);
    assert_eq!(
        channel_last_seq(&su, fx.channel).await,
        seq_before,
        "closing a stream consumes no seq — a cancel marks nobody unread"
    );

    let last = broadcasts(&su, fx.channel)
        .await
        .pop()
        .expect("a broadcast");
    assert_eq!(
        last["type"].as_str(),
        Some("message.edited"),
        "no new frame type: a client renders the stop from the frame it already applies: {last}"
    );
    assert_eq!(
        last["payload"]["props"]["momo.stream"]["outcome"].as_str(),
        Some("cancelled"),
        "and the verdict rides the broadcast, so nobody re-reads history to draw the tail: {last}"
    );

    // ADR-0155 결정 4 — the frozen message is an ordinary message. Quoting it
    // works, which is the concrete half of "a stopped answer is not a tombstone":
    // option B was rejected precisely because deleting would break references
    // like this one.
    let quoted = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            fx.workspace, fx.channel
        ))
        .bearer_auth(&token)
        .json(&json!({
            "clientMsgId": Uuid::new_v4().to_string(),
            "body": "여기까지만 봐도 됩니다",
            "replyToId": stopped_id,
        }))
        .send()
        .await
        .expect("quote the frozen message");
    assert_eq!(
        quoted.status(),
        201,
        "a cancel-frozen message can still be quoted"
    );
}

/// **RED proof.** The two shapes a producer must not get away with.
///
/// 1. `outcome` on a slice that is not `final`. Remove the pairing guard in
///    `stream_message_body_in_tx` and this goes green with a 200, leaving a row
///    that says `{"streaming": true, "outcome": "cancelled"}` — a message that
///    is simultaneously live and abandoned, which no renderer can resolve.
/// 2. An `outcome` value nobody defined. Drop the parse in the route and this
///    goes green: the unknown token lands in the message's props, every client
///    fails to match it, and the answer renders as though it had finished
///    normally — the exact silent lie ADR-0155 option C was rejected for.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn an_outcome_is_refused_off_the_final_slice_and_outside_its_two_values() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fx = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fx.workspace, &fx.author).await;

    let opened = open(&http, &base, &token, &fx, Uuid::new_v4(), "아직 쓰는 중").await;
    let message_id = opened["id"].as_str().expect("message id").to_string();
    let (_, _, _, before) = stored(&su, Uuid::parse_str(&message_id).unwrap()).await;

    let (status, error) = close_slice(
        &http,
        &base,
        &token,
        &fx,
        &message_id,
        "더 쓴다",
        1,
        false,
        "cancelled",
    )
    .await;
    assert_eq!(
        status, 400,
        "an ending may not ride a non-final slice: {error}"
    );
    assert_eq!(
        error["error"]["message"]
            .as_str()
            .or(error["message"].as_str()),
        Some("stream outcome may only accompany the final slice"),
        "the refusal keeps its own sentence: {error}"
    );

    let (status, error) = close_slice(
        &http,
        &base,
        &token,
        &fx,
        &message_id,
        "더 쓴다",
        1,
        true,
        "abandoned",
    )
    .await;
    assert_eq!(
        status, 400,
        "an undefined outcome is refused, not stored: {error}"
    );
    assert_eq!(
        error["error"]["message"]
            .as_str()
            .or(error["message"].as_str()),
        Some("stream outcome must be \"cancelled\" or \"failed\""),
        "and it names the two values, so an adapter author is not left guessing: {error}"
    );

    let (_, _, _, after) = stored(&su, Uuid::parse_str(&message_id).unwrap()).await;
    assert_eq!(
        after.get("momo.stream"),
        before.get("momo.stream"),
        "neither refusal moved the revision, which would refuse the writer's own next slice as stale"
    );
}
