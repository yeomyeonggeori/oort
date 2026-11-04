//! ADR-0148 증보 2026-10-31 (#4887 「대화에도 보내기」 · #4877 스레드 요약의 참여자) — over the real
//! Axum router, on a `momo_app` (NOBYPASSRLS) pool. The spine-level rules (the DB's CHECK, the
//! order and the cap of the faces, the retry staying a no-op) are in
//! `momo-messaging/tests/thread_reply_home_conformance_pg.rs`; this file proves what only the
//! route can: the 400, the wire's keys, and one shape across the surfaces.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `also_in_channel_without_a_thread_is_a_400_and_stores_nothing` | `alsoInChannel: true` with no `rootId` → 400 on the first try and on a retry, with **no** message row, **no** `seq` bump and **no** outbox row; the same request without the flag, and the flag on a reply, are 201 | the route's shape check is removed (the INSERT fails the CHECK and the answer is a 5xx, not a 400) |
//! | `the_choice_and_the_summary_have_one_shape_on_the_wire` | the history page, the thread page, the send echo and the `thread.updated` frame agree: the flag only on the flagged reply (key absent, never `false`), the summary's five snake_case keys with the same faces, order and count in the page and in the frame; a REST retry with the other choice answers the stored message | a projection drops or renames a key, the frame and the page disagree, a `false` is written, or the retry overwrites the choice |
//!
//! Isolated database only:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres \
//!   cargo test -p momo-server --test thread_reply_home_rest_pg -- --ignored --test-threads=1
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "thread-reply-home-rest-pg-conformance-signing-secret";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated PostgreSQL 18 URL")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(16)
        .connect_with(options.username("momo_app").password(&momo_app_password()))
        .await
        .expect("connect as momo_app after bootstrap_roles.sql")
}

fn resolve_psql() -> PathBuf {
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths) {
            let candidate = directory.join("psql");
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
    let mut ready = READY.lock().expect("schema setup mutex is healthy");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration");
    let roles = PathBuf::from(concat!(
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
        .arg(roles)
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind conformance server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

// ---------------------------------------------------------------------------
// fixture (superuser → RLS bypassed)
// ---------------------------------------------------------------------------

struct Person {
    id: Uuid,
    jwt: String,
}

struct Fixture {
    workspace: Uuid,
    channel: Uuid,
    owner: Person,
    teammate: Person,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, handle: &str) -> Person {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human'::member_kind,$3,$3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(id)
    .bind(workspace)
    .bind(format!("{id}@thread-home.test"))
    .execute(su)
    .await
    .expect("seed human identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) \
         VALUES($1,$2,$3::membership_role)",
    )
    .bind(workspace)
    .bind(id)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace membership");
    let jwt = momo_auth::sign_access(id, workspace, &[], TEST_JWT_SECRET)
        .expect("sign a human App JWT")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'thread-home')",
    )
    .bind(workspace)
    .bind(id)
    .bind(&jwt)
    .execute(su)
    .await
    .expect("record the session token");
    Person { id, jwt }
}

async fn seed(su: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("thread-home-{}", workspace.simple()))
        .execute(su)
        .await
        .expect("seed workspace");
    let owner = seed_human(
        su,
        workspace,
        "owner",
        &format!("owner-{}", Uuid::new_v4().simple()),
    )
    .await;
    let teammate = seed_human(
        su,
        workspace,
        "member",
        &format!("teammate-{}", Uuid::new_v4().simple()),
    )
    .await;
    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channel(id, workspace_id, kind, name) VALUES($1,$2,'public',$3)")
        .bind(channel)
        .bind(workspace)
        .bind(format!("home-{}", channel.simple()))
        .execute(su)
        .await
        .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");
    for member in [owner.id, teammate.id] {
        sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
            .bind(workspace)
            .bind(channel)
            .bind(member)
            .execute(su)
            .await
            .expect("seed channel membership");
    }
    Fixture {
        workspace,
        channel,
        owner,
        teammate,
    }
}

struct World {
    su: PgPool,
    f: Fixture,
    base: String,
    http: reqwest::Client,
}

async fn setup() -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    let app = momo_app_pool().await;
    let base = start_server(app).await;
    World {
        su,
        f,
        base,
        http: reqwest::Client::new(),
    }
}

impl World {
    fn messages_url(&self) -> String {
        format!(
            "{}/v1/workspaces/{}/channels/{}/messages",
            self.base, self.f.workspace, self.f.channel
        )
    }

    /// `POST …/messages` as `person`; the status and the parsed body.
    async fn send(&self, person: &Person, body: Value) -> (u16, Value) {
        let response = self
            .http
            .post(self.messages_url())
            .bearer_auth(&person.jwt)
            .json(&body)
            .send()
            .await
            .expect("send request");
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        (
            status,
            serde_json::from_str(&text).unwrap_or(json!({ "raw": text })),
        )
    }

    async fn get(&self, person: &Person, url: String) -> Value {
        let response = self
            .http
            .get(url)
            .bearer_auth(&person.jwt)
            .send()
            .await
            .expect("get request");
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        assert_eq!(status, 200, "GET: {text}");
        serde_json::from_str(&text).expect("json body")
    }

    /// A top-level message; its id.
    async fn root(&self, person: &Person, body: &str) -> String {
        let (status, message) = self
            .send(
                person,
                json!({ "clientMsgId": Uuid::new_v4(), "type": "text", "body": body }),
            )
            .await;
        assert_eq!(status, 201, "{message}");
        message["id"].as_str().expect("message id").to_string()
    }

    async fn counts(&self) -> (i64, i64, i64) {
        let seq: i64 = sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(self.f.channel)
            .fetch_one(&self.su)
            .await
            .expect("last_seq");
        let messages: i64 =
            sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
                .bind(self.f.channel)
                .fetch_one(&self.su)
                .await
                .expect("message count");
        let outbox: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox WHERE workspace_id = $1")
            .bind(self.f.workspace)
            .fetch_one(&self.su)
            .await
            .expect("outbox count");
        (seq, messages, outbox)
    }

    /// The newest `thread.updated` payload of `root` — what every open client was told.
    async fn last_thread_updated(&self, root: &str) -> Value {
        sqlx::query_scalar(
            "SELECT payload->'data'->'payload' FROM outbox \
              WHERE workspace_id = $1 AND kind::text = 'broadcast' \
                AND payload->'data'->>'type' = 'thread.updated' \
                AND lower(payload->'data'->'payload'->>'root_id') = lower($2) \
              ORDER BY id DESC LIMIT 1",
        )
        .bind(self.f.workspace)
        .bind(root)
        .fetch_one(&self.su)
        .await
        .expect("a reply publishes thread.updated")
    }
}

fn reply_body(root: &str, text: &str, also_in_channel: Option<bool>) -> (Uuid, Value) {
    let client_msg_id = Uuid::new_v4();
    let mut body = json!({
        "clientMsgId": client_msg_id,
        "type": "text",
        "body": text,
        "rootId": root,
    });
    if let Some(flag) = also_in_channel {
        body["alsoInChannel"] = json!(flag);
    }
    (client_msg_id, body)
}

// ---------------------------------------------------------------------------
// 400
// ---------------------------------------------------------------------------

/// `alsoInChannel: true` belongs to a thread reply. Without a `rootId` the route answers 400 —
/// on the first try and on a retry — before it takes a connection, so **nothing** is stored: no
/// message row, no `seq` bump, no outbox row. The same request without the flag, and the flag on a
/// reply, both work.
///
/// Goes red if the route's shape check is removed: the INSERT then fails the CHECK and the answer
/// is a 5xx (with the transaction rolled back), not this 400.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4887)"]
async fn also_in_channel_without_a_thread_is_a_400_and_stores_nothing() {
    let w = setup().await;
    let before = w.counts().await;

    let refused = json!({
        "clientMsgId": Uuid::new_v4(),
        "type": "text",
        "body": "답글이 아니에요",
        "alsoInChannel": true,
    });
    for attempt in ["first try", "retry"] {
        let (status, body) = w.send(&w.f.teammate, refused.clone()).await;
        assert_eq!(status, 400, "{attempt}: {body}");
        assert!(
            body.to_string().contains("alsoInChannel"),
            "{attempt}: the answer names the field: {body}"
        );
    }
    assert_eq!(
        w.counts().await,
        before,
        "a refused send leaves no seq bump, no message and no outbox row"
    );

    // Control 1: the flag off (or absent) with no root is the unchanged request.
    let (status, plain) = w
        .send(
            &w.f.teammate,
            json!({
                "clientMsgId": Uuid::new_v4(),
                "type": "text",
                "body": "그냥 글",
                "alsoInChannel": false,
            }),
        )
        .await;
    assert_eq!(status, 201, "{plain}");
    assert!(
        plain.get("alsoInChannel").is_none(),
        "false is never echoed: {plain}"
    );

    // Control 2: on a reply the choice is accepted and echoed as `true`.
    let root = w.root(&w.f.owner, "원글").await;
    let (_, body) = reply_body(&root, "함께 보내요", Some(true));
    let (status, echo) = w.send(&w.f.teammate, body).await;
    assert_eq!(status, 201, "{echo}");
    assert_eq!(echo["alsoInChannel"], json!(true), "{echo}");
    assert_eq!(echo["rootId"], json!(root));
}

// ---------------------------------------------------------------------------
// one shape
// ---------------------------------------------------------------------------

/// One shape across the surfaces. After a teammate's plain reply, the owner's flagged reply and
/// another plain reply by the teammate:
///
/// * the history page: the root's `thread` has exactly the five snake_case keys; the faces are
///   `[teammate, owner]` (the teammate replied last), the count is 2; only the flagged reply carries
///   `alsoInChannel` and the others have **no key** (never `false`);
/// * the thread page: the same flag on the same reply;
/// * the `thread.updated` frame the outbox holds says the same faces and count as the page;
/// * a REST retry with the other choice answers the stored message and changes nothing.
///
/// Goes red if a projection drops or renames a key, if the frame and the page disagree, if `false`
/// is written, or if the retry overwrites the choice.
#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#4887, #4877)"]
async fn the_choice_and_the_summary_have_one_shape_on_the_wire() {
    let w = setup().await;
    let owner = w.f.owner.id.to_string();
    let teammate = w.f.teammate.id.to_string();

    let root = w.root(&w.f.owner, "주간 공지").await;
    let (first_id, first_body) = reply_body(&root, "팀원의 첫 답", None);
    let (status, first) = w.send(&w.f.teammate, first_body.clone()).await;
    assert_eq!(status, 201, "{first}");
    let (flagged_id, flagged_body) = reply_body(&root, "채널에도 알려요", Some(true));
    let (status, flagged) = w.send(&w.f.owner, flagged_body.clone()).await;
    assert_eq!(status, 201, "{flagged}");
    let (_, last_body) = reply_body(&root, "팀원의 둘째 답", None);
    let (status, last) = w.send(&w.f.teammate, last_body).await;
    assert_eq!(status, 201, "{last}");
    let flagged_message_id = flagged["id"].as_str().expect("flagged id").to_string();

    // 기록 페이지
    let page = w
        .get(&w.f.owner, format!("{}?limit=50", w.messages_url()))
        .await;
    let rows = page["messages"].as_array().expect("messages");
    let row = |id: &str| -> &Value {
        rows.iter()
            .find(|message| message["id"] == json!(id))
            .expect("the message is on the page")
    };
    let thread = &row(&root)["thread"];
    let mut keys: Vec<&str> = thread
        .as_object()
        .expect("the root carries a rollup")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "last_reply_at",
            "last_reply_seq",
            "participant_count",
            "participant_ids",
            "reply_count",
            // #4889 stage 2 — the one key that is the reader's own: the owner wrote the root, so the
            // first reply made them a follower, and two of the three replies are somebody else's.
            // The `thread.updated` frame (below) never carries it: it is one frame for the channel.
            "unread_reply_count",
        ],
        "the rollup keeps its snake_case keys, the two summary keys, and — for a follower — the \
         reader's own unread count: {thread}"
    );
    assert_eq!(thread["reply_count"], json!(3));
    assert_eq!(
        thread["unread_reply_count"],
        json!(2),
        "the teammate's two replies are unread; the owner's own reply is never counted"
    );
    assert_eq!(
        thread["participant_ids"],
        json!([teammate, owner]),
        "newest replier first, lowercase ids"
    );
    assert_eq!(thread["participant_count"], json!(2));

    assert_eq!(row(&flagged_message_id)["alsoInChannel"], json!(true));
    for quiet in [
        first["id"].as_str().expect("first id"),
        last["id"].as_str().expect("last id"),
        root.as_str(),
    ] {
        assert!(
            row(quiet).get("alsoInChannel").is_none(),
            "a message that did not choose it carries no key: {}",
            row(quiet)
        );
    }

    // 스레드 페이지(스레드 열기)
    let replies = w
        .get(
            &w.f.owner,
            format!("{}/{root}/replies?limit=50", w.messages_url()),
        )
        .await;
    let reply_rows = replies["messages"].as_array().expect("replies");
    assert_eq!(reply_rows.len(), 3);
    for reply in reply_rows {
        assert_eq!(
            reply.get("alsoInChannel").is_some(),
            reply["id"] == json!(flagged_message_id),
            "the thread page carries the same choice: {reply}"
        );
        assert!(
            reply.get("thread").is_none(),
            "a reply carries no rollup of its own: {reply}"
        );
    }

    // 실시간 요약 갱신: the same faces and count as the page
    let frame = w.last_thread_updated(&root).await;
    assert_eq!(
        frame["participant_ids"], thread["participant_ids"],
        "{frame}"
    );
    assert_eq!(frame["participant_count"], thread["participant_count"]);
    assert_eq!(frame["reply_count"], thread["reply_count"]);

    // 멱등 재시도: the other choice in both directions, the stored message answers, nothing moves.
    // Rows are counted, not `seq`: a retried send has always burned one `channel_seq.last_seq` step
    // (the bump and the INSERT are one statement, and `ON CONFLICT DO NOTHING` keeps the bump) —
    // that is the send spine as it stood before this change, and not what this test is about.
    let (_, messages_before, outbox_before) = w.counts().await;
    let mut flip_on = first_body;
    flip_on["alsoInChannel"] = json!(true);
    let (status, retried) = w.send(&w.f.teammate, flip_on).await;
    assert_eq!(status, 201, "{retried}");
    assert_eq!(
        retried["id"], first["id"],
        "same clientMsgId is the same message"
    );
    assert!(
        retried.get("alsoInChannel").is_none(),
        "the stored choice (off) answers, not the retry's: {retried}"
    );
    let mut flip_off = flagged_body;
    flip_off["alsoInChannel"] = json!(false);
    let (status, retried) = w.send(&w.f.owner, flip_off).await;
    assert_eq!(status, 201, "{retried}");
    assert_eq!(retried["id"], json!(flagged_message_id));
    assert_eq!(
        retried["alsoInChannel"],
        json!(true),
        "a retry cannot turn a chosen reply off: {retried}"
    );
    let (_, messages_after, outbox_after) = w.counts().await;
    assert_eq!(
        (messages_after, outbox_after),
        (messages_before, outbox_before),
        "retries store and publish nothing"
    );
    let _ = (first_id, flagged_id);
}
