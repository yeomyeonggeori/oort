//! DB-backed conformance for the **inbox API** — ADR-0199 D3~D7, #3681 (E2).
//!
//! Real router on an isolated PG as `momo_app` (NOBYPASSRLS). `#[ignore]`:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:24072/momo \
//!   cargo test -p momo-server --test inbox_api_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_member_sees_only_their_own_items_and_a_stranger_gets_404` | drop `member_id = $2` from the list / read / read-all statements |
//! | `another_workspace_is_refused_by_the_path_scope` | drop `workspace_scope` |
//! | `keyset_paging_walks_every_item_once_even_on_equal_timestamps` | page by offset, drop the `id` tie-break, or compare `created_at` alone |
//! | `filters_pick_by_reason` | change any filter fragment |
//! | `reading_an_item_never_moves_the_channel_cursor_and_is_idempotent` | make the item read write `read_state`, or rewrite `read_at` on replay |
//! | `read_all_marks_only_what_is_visible_and_says_so_once` | drop the visibility join from read-all, or publish on a zero count |
//! | `deleted_and_lost_and_muted_items_are_re_judged_at_read_time` | store a body snapshot, drop the membership / muted joins |
//! | `a_quote_reply_publishes_one_created_event_in_the_senders_transaction` | drop `inbox_item_publish_created_trg` |
//! | `pending_approvals_are_merged_on_the_first_page_only` | store/merge approvals on later pages |
//! | `retention_deletes_only_old_read_items_and_is_idempotent` | delete unread rows, touch `message`, or use the wrong clock |
//! | `a_bad_filter_cursor_or_muted_value_is_a_400` | loosen the parsers or drop the cursor range check |
//! | `an_item_born_in_the_future_reads_with_a_200_and_never_before_its_message` | revert `GREATEST(now(), created_at)` in the single / read-all UPDATE |
//! | `the_unread_count_stops_at_one_thousand` | drop the `LIMIT` / `.min(INBOX_UNREAD_COUNT_CAP)` |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_server::{build_app, AppState, RealtimeAdvert};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "inbox-api-conformance-signing-secret";
const TEST_PASSWORD: &str = "inbox-api-test-password";

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let password =
        std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password(&password))
        .await
        .expect("connect as momo_app")
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
    panic!("psql client not found");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema lock");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args([
            "-v",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "--quiet",
            "--single-transaction",
        ])
        .arg("-f")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        ))
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

async fn start_server() -> String {
    let app = build_app(AppState::new(
        momo_app_pool().await,
        TEST_JWT_SECRET.to_string(),
        RealtimeAdvert::SameOrigin,
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
// fixtures (superuser, past RLS; messages are inserted with plain SQL so the
// projection triggers fire exactly as they do for the real writers)
// ---------------------------------------------------------------------------

struct Human {
    id: Uuid,
    email: String,
    token: String,
}

struct World {
    http: reqwest::Client,
    base: String,
    su: PgPool,
    ws: Uuid,
}

async fn world() -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(ws)
        .bind(ws.to_string())
        .execute(&su)
        .await
        .expect("seed workspace");
    World {
        http: reqwest::Client::new(),
        base: start_server().await,
        su,
        ws,
    }
}

impl World {
    async fn human(&self, handle: &str) -> Human {
        self.human_in(self.ws, handle).await
    }

    async fn human_in(&self, ws: Uuid, handle: &str) -> Human {
        let id = Uuid::new_v4();
        let email = format!("{id}@inbox.test");
        sqlx::query("INSERT INTO member (id, workspace_id, kind, display_name, handle) VALUES ($1, $2, 'human', $3, $3)")
            .bind(id).bind(ws).bind(format!("{handle}{}", &id.simple().to_string()[..4]))
            .execute(&self.su).await.expect("member");
        sqlx::query("INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) VALUES ($1, $2, $3, true, momo_password_hash($4))")
            .bind(id).bind(ws).bind(&email).bind(TEST_PASSWORD)
            .execute(&self.su).await.expect("human");
        sqlx::query("INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')")
            .bind(ws).bind(id).execute(&self.su).await.expect("ws membership");
        let response = self
            .http
            .post(format!("{}/v1/auth/login", self.base))
            .json(&json!({"email": email, "password": TEST_PASSWORD, "workspace": ws.to_string()}))
            .send()
            .await
            .expect("login");
        assert_eq!(response.status(), 200);
        let body: Value = response.json().await.unwrap();
        Human {
            id,
            email,
            token: body["accessToken"].as_str().unwrap().to_string(),
        }
    }

    async fn channel(&self, name: &str, kind: &str, members: &[Uuid]) -> Uuid {
        let ch = Uuid::new_v4();
        let dm_key = (kind == "dm").then(|| ch.to_string());
        sqlx::query("INSERT INTO channel (id, workspace_id, kind, name, dm_key, created_by) VALUES ($1, $2, $3::channel_kind, $4, $5, $6)")
            .bind(ch).bind(self.ws).bind(kind)
            .bind((kind != "dm").then(|| format!("{name}-{}", &ch.simple().to_string()[..6])))
            .bind(dm_key).bind(members[0])
            .execute(&self.su).await.expect("channel");
        sqlx::query(
            "INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)",
        )
        .bind(ch)
        .bind(self.ws)
        .execute(&self.su)
        .await
        .expect("seq");
        for member in members {
            sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id, role) VALUES ($1, $2, $3, 'member')")
                .bind(self.ws).bind(ch).bind(member).execute(&self.su).await.expect("membership");
        }
        ch
    }

    /// Insert one text message; returns (id, seq).
    async fn say(
        &self,
        ch: Uuid,
        author: Uuid,
        body: &str,
        reply_to: Option<Uuid>,
        root: Option<Uuid>,
        at: Option<&str>,
    ) -> (Uuid, i64) {
        let seq: i64 = sqlx::query_scalar("UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1 RETURNING last_seq")
            .bind(ch).fetch_one(&self.su).await.unwrap();
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, reply_to_id, root_id, created_at) VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', $6, $7, $8, COALESCE($9::timestamptz, now()))")
            .bind(id).bind(self.ws).bind(ch).bind(seq).bind(author).bind(body)
            .bind(reply_to).bind(root).bind(at)
            .execute(&self.su).await.expect("message");
        (id, seq)
    }

    fn url(&self, tail: &str) -> String {
        format!("{}/v1/workspaces/{}/{tail}", self.base, self.ws)
    }

    async fn get(&self, who: &Human, tail: &str) -> (u16, Value) {
        let response = self
            .http
            .get(self.url(tail))
            .bearer_auth(&who.token)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn put(&self, who: &Human, tail: &str) -> (u16, Value) {
        let response = self
            .http
            .put(self.url(tail))
            .bearer_auth(&who.token)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn post(&self, who: &Human, tail: &str) -> (u16, Value) {
        let response = self
            .http
            .post(self.url(tail))
            .bearer_auth(&who.token)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn inbox(&self, who: &Human, query: &str) -> Value {
        let (status, body) = self.get(who, &format!("inbox{query}")).await;
        assert_eq!(status, 200, "{body}");
        body
    }

    async fn outbox_count(&self, member: Uuid, event: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM outbox WHERE kind = 'broadcast' AND partition_key = $1 AND payload #>> '{data,type}' = $2")
            .bind(member).bind(event).fetch_one(&self.su).await.unwrap()
    }
}

fn ids(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_string())
        .collect()
}

// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_member_sees_only_their_own_items_and_a_stranger_gets_404() {
    let _guard = test_lock().await;
    let w = world().await;
    let alice = w.human("alice").await;
    let bob = w.human("bob").await;
    let carol = w.human("carol").await;
    let ch = w
        .channel("general", "public", &[alice.id, bob.id, carol.id])
        .await;
    let (mine, _) = w.say(ch, alice.id, "내 글", None, None, None).await;
    w.say(ch, bob.id, "bob이 인용", Some(mine), None, None)
        .await;

    let page = w.inbox(&alice, "").await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["kind"], "reply_to_me");
    assert_eq!(page["items"][0]["quotedMessage"]["preview"], "내 글");
    assert_eq!(page["items"][0]["message"]["preview"], "bob이 인용");
    assert_eq!(page["unreadCount"], 1);
    let item_id = page["items"][0]["id"].as_str().unwrap().to_string();

    // a same-workspace stranger sees nothing and cannot touch it
    assert_eq!(
        w.inbox(&carol, "").await["items"].as_array().unwrap().len(),
        0
    );
    assert_eq!(
        w.inbox(&bob, "").await["items"].as_array().unwrap().len(),
        0,
        "the sender is not a recipient"
    );
    let (status, body) = w.put(&carol, &format!("inbox/{item_id}/read")).await;
    assert_eq!(status, 404, "{body}");
    let (made_up_status, made_up_body) = w
        .put(&carol, &format!("inbox/{}/read", Uuid::new_v4()))
        .await;
    assert_eq!(made_up_status, 404);
    assert_eq!(
        body, made_up_body,
        "a foreign id and a made-up id are indistinguishable"
    );
    let still_unread: bool =
        sqlx::query_scalar("SELECT read_at IS NULL FROM inbox_item WHERE id = $1")
            .bind(item_id.parse::<Uuid>().unwrap())
            .fetch_one(&w.su)
            .await
            .unwrap();
    assert!(still_unread, "the 404 changed nothing");

    // read-all by the stranger leaves alice's item alone
    let (status, body) = w.post(&carol, "inbox/read-all").await;
    assert_eq!(status, 200);
    assert_eq!(body["marked"], 0);
    assert_eq!(w.inbox(&alice, "").await["unreadCount"], 1);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn another_workspace_is_refused_by_the_path_scope() {
    let _guard = test_lock().await;
    let w = world().await;
    let alice = w.human("alice").await;
    let other_ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(other_ws)
        .bind(other_ws.to_string())
        .execute(&w.su)
        .await
        .unwrap();
    let zed = w.human_in(other_ws, "zed").await;

    // zed's token against alice's workspace path
    let response = w
        .http
        .get(w.url("inbox"))
        .bearer_auth(&zed.token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let response = w
        .http
        .put(w.url(&format!("inbox/{}/read", Uuid::new_v4())))
        .bearer_auth(&zed.token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let response = w
        .http
        .post(w.url("inbox/read-all"))
        .bearer_auth(&zed.token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    // no token at all
    let response = w.http.get(w.url("inbox")).send().await.unwrap();
    assert_eq!(response.status(), 401);
    let _ = (alice.email.len(), zed.email.len());
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn keyset_paging_walks_every_item_once_even_on_equal_timestamps() {
    let _guard = test_lock().await;
    let w = world().await;
    let alice = w.human("alice").await;
    let bob = w.human("bob").await;
    let ch = w.channel("general", "public", &[alice.id, bob.id]).await;
    let (mine, _) = w
        .say(
            ch,
            alice.id,
            "원문",
            None,
            None,
            Some("2026-01-01T00:00:00Z"),
        )
        .await;
    // 25 replies; the first 9 share one timestamp exactly (tie-break by id)
    let mut want = Vec::new();
    for n in 0..25 {
        let at = if n < 9 {
            "2026-02-01T00:00:00.000000Z".to_string()
        } else {
            format!("2026-02-01T00:{:02}:00Z", n)
        };
        let (id, _) = w
            .say(ch, bob.id, &format!("답 {n}"), Some(mine), None, Some(&at))
            .await;
        want.push(id);
    }
    let mut seen: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let q = match &cursor {
            Some(c) => format!("?limit=10&cursor={c}"),
            None => "?limit=10".to_string(),
        };
        let page = w.inbox(&alice, &q).await;
        pages += 1;
        let batch = page["items"].as_array().unwrap();
        assert!(batch.len() <= 10);
        seen.extend(ids(&page));
        // newest first
        let times: Vec<&str> = batch
            .iter()
            .map(|i| i["createdAt"].as_str().unwrap())
            .collect();
        assert!(times.windows(2).all(|p| p[0] >= p[1]), "{times:?}");
        match page["nextCursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => break,
        }
        assert!(pages < 10, "paging must terminate");
    }
    assert_eq!(pages, 3, "10 + 10 + 5");
    assert_eq!(seen.len(), 25, "no item missed");
    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), 25, "no item twice");
    // a limit above the ceiling is clamped, not an error
    let page = w.inbox(&alice, "?limit=100000").await;
    assert_eq!(page["items"].as_array().unwrap().len(), 25);
    assert!(page["nextCursor"].is_null());
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn filters_pick_by_reason() {
    let _guard = test_lock().await;
    let w = world().await;
    let alice = w.human("alice").await;
    let bob = w.human("bob").await;
    let ch = w.channel("general", "public", &[alice.id, bob.id]).await;
    let dm = w.channel("dm", "dm", &[alice.id, bob.id]).await;

    let (root, _) = w.say(ch, alice.id, "루트", None, None, None).await;
    let (quote, _) = w.say(ch, bob.id, "인용", Some(root), None, None).await;
    let (thread, _) = w.say(ch, bob.id, "스레드 답", None, Some(root), None).await;
    let (dm_msg, _) = w.say(dm, bob.id, "DM", None, None, None).await;
    // a server-recorded mention (props written the way record_mentions_in_tx does)
    let (mention, _) = w.say(ch, bob.id, "멘션", None, None, None).await;
    sqlx::query("UPDATE message SET props = jsonb_set(props, '{mention_member_ids}', to_jsonb($2::text[])) WHERE id = $1")
        .bind(mention).bind(vec![alice.id.to_string().to_uppercase()]).execute(&w.su).await.unwrap();

    let kinds = |page: &Value| -> Vec<String> {
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["message"]["id"].as_str().unwrap().to_string())
            .collect()
    };
    let all = kinds(&w.inbox(&alice, "").await);
    assert_eq!(all.len(), 4);
    let only = |f: &str, expect: Uuid| {
        let alice = &alice;
        let w = &w;
        let f = f.to_string();
        async move {
            let got = kinds(&w.inbox(alice, &format!("?filter={f}")).await);
            assert_eq!(got, vec![expect.to_string()], "filter={f}");
        }
    };
    only("reply", quote).await;
    only("mention", mention).await;
    only("dm", dm_msg).await;
    only("thread", thread).await;
    assert_eq!(
        w.inbox(&alice, "?filter=unread").await["items"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn reading_an_item_never_moves_the_channel_cursor_and_is_idempotent() {
    let _guard = test_lock().await;
    let w = world().await;
    let alice = w.human("alice").await;
    let bob = w.human("bob").await;
    let ch = w.channel("general", "public", &[alice.id, bob.id]).await;
    let (mine, _) = w.say(ch, alice.id, "원문", None, None, None).await;
    let (_, seq1) = w.say(ch, bob.id, "답 1", Some(mine), None, None).await;
    w.say(ch, bob.id, "답 2", Some(mine), None, None).await;

    let page = w.inbox(&alice, "").await;
    assert_eq!(page["unreadCount"], 2);
    let newest = page["items"][0]["id"].as_str().unwrap().to_string();

    let (status, first) = w.put(&alice, &format!("inbox/{newest}/read")).await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["unreadCount"], 1);
    let read_at = first["readAt"].as_str().unwrap().to_string();
    assert_eq!(w.outbox_count(alice.id, "inbox_item.read").await, 1);

    let (status, again) = w.put(&alice, &format!("inbox/{newest}/read")).await;
    assert_eq!(status, 200);
    assert_eq!(
        again["readAt"], read_at,
        "replay keeps the original read_at"
    );
    assert_eq!(
        w.outbox_count(alice.id, "inbox_item.read").await,
        1,
        "a replay publishes nothing"
    );

    // the channel cursor is untouched: item -> cursor has no direction
    let cursor: Option<i64> = sqlx::query_scalar(
        "SELECT last_read_seq FROM read_state WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(ch)
    .bind(alice.id)
    .fetch_optional(&w.su)
    .await
    .unwrap();
    assert!(
        cursor.is_none() || cursor == Some(0),
        "reading the newest item moved the cursor to {cursor:?}"
    );

    // the other direction: the channel cursor passing the older item reads it
    let response = w
        .http
        .put(w.url(&format!("channels/{ch}/read-state")))
        .bearer_auth(&alice.token)
        .json(&json!({"last_read_seq": seq1}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(w.inbox(&alice, "").await["unreadCount"], 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn read_all_marks_only_what_is_visible_and_says_so_once() {
    let _guard = test_lock().await;
    let w = world().await;
    let alice = w.human("alice").await;
    let bob = w.human("bob").await;
    let ch = w.channel("general", "public", &[alice.id, bob.id]).await;
    let hidden = w.channel("quiet", "public", &[alice.id, bob.id]).await;
    let dm = w.channel("dm", "dm", &[alice.id, bob.id]).await;
    let (mine, _) = w.say(ch, alice.id, "원문", None, None, None).await;
    w.say(ch, bob.id, "답", Some(mine), None, None).await;
    w.say(dm, bob.id, "DM", None, None, None).await;
    let (hidden_mine, _) = w
        .say(hidden, alice.id, "조용한 방 원문", None, None, None)
        .await;
    w.say(
        hidden,
        bob.id,
        "조용한 방 답",
        Some(hidden_mine),
        None,
        None,
    )
    .await;
    sqlx::query("INSERT INTO notification_pref (workspace_id, member_id, channel_id, muted_until) VALUES ($1, $2, $3, NULL)")
        .bind(w.ws).bind(alice.id).bind(hidden).execute(&w.su).await.unwrap();

    assert_eq!(
        w.inbox(&alice, "").await["unreadCount"],
        2,
        "the muted room is not counted"
    );
    // filtered read-all touches only that reason
    let (_, body) = w.post(&alice, "inbox/read-all?filter=dm").await;
    assert_eq!(body["marked"], 1);
    assert_eq!(body["unreadCount"], 1);
    let (_, body) = w.post(&alice, "inbox/read-all").await;
    assert_eq!(body["marked"], 1);
    assert_eq!(body["unreadCount"], 0);
    assert_eq!(w.outbox_count(alice.id, "inbox.read_all").await, 2);
    let (_, body) = w.post(&alice, "inbox/read-all").await;
    assert_eq!(body["marked"], 0);
    assert_eq!(
        w.outbox_count(alice.id, "inbox.read_all").await,
        2,
        "nothing marked, nothing published"
    );

    // the hidden item was not consumed behind the member's back
    let unread: i64 = sqlx::query_scalar("SELECT count(*) FROM inbox_item WHERE member_id = $1 AND channel_id = $2 AND read_at IS NULL")
        .bind(alice.id).bind(hidden).fetch_one(&w.su).await.unwrap();
    assert_eq!(unread, 1);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn deleted_and_lost_and_muted_items_are_re_judged_at_read_time() {
    let _guard = test_lock().await;
    let w = world().await;
    let alice = w.human("alice").await;
    let bob = w.human("bob").await;
    let ch = w.channel("general", "public", &[alice.id, bob.id]).await;
    let priv_ch = w.channel("secret", "private", &[alice.id, bob.id]).await;
    let muted = w.channel("muted", "public", &[alice.id, bob.id]).await;

    let (mine, _) = w.say(ch, alice.id, "원문", None, None, None).await;
    let (reply, _) = w.say(ch, bob.id, "지울 답", Some(mine), None, None).await;
    let (pmine, _) = w
        .say(priv_ch, alice.id, "비공개 원문", None, None, None)
        .await;
    w.say(priv_ch, bob.id, "비공개 답", Some(pmine), None, None)
        .await;
    let (mmine, _) = w.say(muted, alice.id, "뮤트 원문", None, None, None).await;
    let (mreply, _) = w
        .say(muted, bob.id, "뮤트 답", Some(mmine), None, None)
        .await;
    sqlx::query("INSERT INTO notification_pref (workspace_id, member_id, channel_id, muted_until) VALUES ($1, $2, $3, NULL)")
        .bind(w.ws).bind(alice.id).bind(muted).execute(&w.su).await.unwrap();

    // muted rooms hide by default and show on request
    assert_eq!(
        w.inbox(&alice, "").await["items"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        w.inbox(&alice, "?muted=show").await["items"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    // mention_overrides_mute lets a MENTION through a muted room
    sqlx::query("UPDATE message SET props = jsonb_set(props, '{mention_member_ids}', to_jsonb($2::text[])) WHERE id = $1")
        .bind(mreply).bind(vec![alice.id.to_string().to_uppercase()]).execute(&w.su).await.unwrap();
    assert_eq!(
        w.inbox(&alice, "").await["items"].as_array().unwrap().len(),
        2,
        "override is off by default"
    );
    sqlx::query("INSERT INTO notification_rule (workspace_id, member_id, mention_overrides_mute) VALUES ($1, $2, true) ON CONFLICT (workspace_id, member_id) DO UPDATE SET mention_overrides_mute = true")
        .bind(w.ws).bind(alice.id).execute(&w.su).await.unwrap();
    assert_eq!(
        w.inbox(&alice, "").await["items"].as_array().unwrap().len(),
        3
    );

    // a deleted message keeps its row but loses its words
    sqlx::query(
        // body deliberately KEPT: only the deleted branch may hide the text
        "UPDATE message SET deleted_at = now(), state = 'deleted' WHERE id = $1",
    )
    .bind(reply)
    .execute(&w.su)
    .await
    .unwrap();
    let page = w.inbox(&alice, "?muted=show").await;
    let deleted = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["message"]["id"] == reply.to_string())
        .unwrap();
    assert_eq!(deleted["message"]["deleted"], true);
    assert_eq!(
        deleted["message"]["preview"], "",
        "a deleted message's words never leave, even though its body is still in the row"
    );
    // a deleted QUOTED message is hidden the same way (its body is also kept)
    sqlx::query("UPDATE message SET deleted_at = now(), state = 'deleted' WHERE id = $1")
        .bind(mine)
        .execute(&w.su)
        .await
        .unwrap();
    let page = w.inbox(&alice, "?muted=show").await;
    let with_quote = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["message"]["id"] == reply.to_string())
        .unwrap();
    assert_eq!(with_quote["quotedMessage"]["deleted"], true);
    assert_eq!(with_quote["quotedMessage"]["preview"], "");

    // losing a private room removes its items from view and from the count
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(priv_ch)
        .bind(alice.id)
        .execute(&w.su)
        .await
        .unwrap();
    let page = w.inbox(&alice, "?muted=show").await;
    assert_eq!(
        page["items"].as_array().unwrap().len(),
        2,
        "the private room's item is gone from the list"
    );
    assert!(page["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|i| i["channel"]["id"] != priv_ch.to_string()));
    assert_eq!(page["unreadCount"], 2);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_quote_reply_publishes_one_created_event_in_the_senders_transaction() {
    let _guard = test_lock().await;
    let w = world().await;
    let alice = w.human("alice").await;
    let bob = w.human("bob").await;
    let ch = w.channel("general", "public", &[alice.id, bob.id]).await;
    let (mine, _) = w
        .say(
            ch,
            alice.id,
            "원문",
            None,
            None,
            Some("2026-01-01T00:00:00Z"),
        )
        .await;
    // an OLD message's item (backfill-shaped) publishes nothing
    w.say(
        ch,
        bob.id,
        "오래된 답",
        Some(mine),
        None,
        Some("2026-01-02T00:00:00Z"),
    )
    .await;
    assert_eq!(
        w.outbox_count(alice.id, "inbox_item.created").await,
        0,
        "old source message: no live event"
    );

    // a REAL send through the REST spine (one tx: seq + message + outbox + projection + event)
    let response = w
        .http
        .post(w.url(&format!("channels/{ch}/messages")))
        .bearer_auth(&bob.token)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": "진짜 인용 답", "replyToId": mine}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 201, "{}", response.text().await.unwrap());

    assert_eq!(w.outbox_count(alice.id, "inbox_item.created").await, 1);
    let payload: Value = sqlx::query_scalar("SELECT payload FROM outbox WHERE kind = 'broadcast' AND partition_key = $1 AND payload #>> '{data,type}' = 'inbox_item.created'")
        .bind(alice.id).fetch_one(&w.su).await.unwrap();
    assert_eq!(
        payload["channel"],
        format!("user:read-state#{}", alice.id.to_string().to_uppercase())
    );
    let text = payload.to_string();
    assert!(
        !text.contains("진짜 인용 답"),
        "ids only: no message text in the event"
    );
    assert_eq!(payload["data"]["payload"]["kind"], "reply_to_me");
    // the author is not a recipient: no event on bob's channel
    assert_eq!(w.outbox_count(bob.id, "inbox_item.created").await, 0);
    // the item exists and the page shows it first
    assert_eq!(
        w.inbox(&alice, "").await["items"][0]["message"]["preview"],
        "진짜 인용 답"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn pending_approvals_are_merged_on_the_first_page_only() {
    let _guard = test_lock().await;
    let w = world().await;
    let alice = w.human("alice").await;
    let ch = w.channel("general", "public", &[alice.id]).await;
    let agent = Uuid::new_v4();
    sqlx::query("INSERT INTO member (id, workspace_id, kind, display_name, handle) VALUES ($1, $2, 'agent', 'bot', $3)")
        .bind(agent).bind(w.ws).bind(format!("bot{}", &agent.simple().to_string()[..6])).execute(&w.su).await.unwrap();
    sqlx::query("INSERT INTO agent (member_id, workspace_id, model, base_url) VALUES ($1, $2, 'm', 'http://localhost/v1')")
        .bind(agent).bind(w.ws).execute(&w.su).await.unwrap();
    let run = Uuid::new_v4();
    sqlx::query("INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id) VALUES ($1, $2, $3, $4)")
        .bind(run).bind(w.ws).bind(agent).bind(ch).execute(&w.su).await.unwrap();
    sqlx::query("INSERT INTO approval (workspace_id, run_id, channel_id, requested_by, action_type, payload) VALUES ($1, $2, $3, $4, 'tool_call', '{}'::jsonb)")
        .bind(w.ws).bind(run).bind(ch).bind(agent).execute(&w.su).await.unwrap();

    let first = w.inbox(&alice, "").await;
    assert_eq!(
        first["approvalsPending"].as_array().unwrap().len(),
        1,
        "approvals are merged at read time"
    );
    assert_eq!(
        first["items"].as_array().unwrap().len(),
        0,
        "and are not inbox_item rows"
    );
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM inbox_item WHERE workspace_id = $1")
        .bind(w.ws)
        .fetch_one(&w.su)
        .await
        .unwrap();
    assert_eq!(rows, 0, "nothing was stored for the approval");
    // a continuation page carries none
    let cursor = Uuid::new_v4();
    let fake = {
        use base64::Engine as _;
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(format!("{}:{}", 1_900_000_000_000_000i64, cursor))
    };
    let next = w.inbox(&alice, &format!("?cursor={fake}")).await;
    assert_eq!(next["approvalsPending"].as_array().unwrap().len(), 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn retention_deletes_only_old_read_items_and_is_idempotent() {
    let _guard = test_lock().await;
    let w = world().await;
    let alice = w.human("alice").await;
    let bob = w.human("bob").await;
    let ch = w.channel("general", "public", &[alice.id, bob.id]).await;
    let (mine, _) = w.say(ch, alice.id, "원문", None, None, None).await;
    let mut ids = Vec::new();
    for n in 0..4 {
        let (m, _) = w
            .say(ch, bob.id, &format!("답 {n}"), Some(mine), None, None)
            .await;
        ids.push(m);
    }
    // 0: read 40 days ago (expired) · 1: read 10 days ago (kept) · 2: unread, ancient (kept) · 3: read 31 days ago (expired)
    // Backdate with the guard triggers off (replica role, one fixture tx): the
    // guard is exactly what stops a direct UPDATE from doing this.
    let mut fixture = w.su.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(&mut *fixture)
        .await
        .unwrap();
    for (idx, set) in [
        (0, "read_at = now() - interval '40 days'"),
        (1, "read_at = now() - interval '10 days'"),
        (2, "created_at = now() - interval '200 days'"),
        (3, "read_at = now() - interval '31 days'"),
    ] {
        sqlx::query(&format!(
            "UPDATE inbox_item SET {set} WHERE message_id = $1"
        ))
        .bind(ids[idx])
        .execute(&mut *fixture)
        .await
        .unwrap();
    }
    fixture.commit().await.unwrap();
    let messages_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id = $1")
            .bind(w.ws)
            .fetch_one(&w.su)
            .await
            .unwrap();

    let app = momo_app_pool().await;
    let ws = w.ws;
    let run = |batch: i64| {
        let app = app.clone();
        async move {
            with_tenant_tx(&app, ws, move |conn| {
                Box::pin(async move {
                    momo_messaging::delete_read_inbox_items_in_tx(conn, ws, batch).await
                })
            })
            .await
            .unwrap()
        }
    };
    let candidates = {
        let mut conn = w.su.acquire().await.unwrap();
        momo_messaging::workspaces_with_expired_inbox_items(&mut conn, 100)
            .await
            .unwrap()
    };
    assert!(candidates.contains(&ws));
    assert_eq!(run(1).await, 1, "bounded by the batch");
    assert_eq!(run(100).await, 1, "the rest drains next tick");
    assert_eq!(run(100).await, 0, "idempotent: a third run finds nothing");

    let left: Vec<Uuid> = sqlx::query_scalar(
        "SELECT message_id FROM inbox_item WHERE workspace_id = $1 ORDER BY message_id",
    )
    .bind(w.ws)
    .fetch_all(&w.su)
    .await
    .unwrap();
    let mut expect = vec![ids[1], ids[2]];
    expect.sort();
    assert_eq!(
        left, expect,
        "read-and-fresh and unread-and-old both survive"
    );
    let messages_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id = $1")
            .bind(w.ws)
            .fetch_one(&w.su)
            .await
            .unwrap();
    assert_eq!(
        messages_before, messages_after,
        "the source messages are never touched"
    );
    let _ = alice.email.len();
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_bad_filter_cursor_or_muted_value_is_a_400() {
    let _guard = test_lock().await;
    let w = world().await;
    let alice = w.human("alice").await;
    for q in [
        "?filter=task",
        "?filter=all%3B",
        "?cursor=%25%25%25",
        "?cursor=bm90LWEtY3Vyc29y",
        "?muted=maybe",
    ] {
        let (status, body) = w.get(&alice, &format!("inbox{q}")).await;
        assert_eq!(status, 400, "{q}: {body}");
    }
    // out-of-range micros in an otherwise well-formed cursor: 400, never a 500
    {
        use base64::Engine as _;
        for micros in [i64::MAX, i64::MIN, -1_000_000i64, i64::MIN / 2] {
            let cursor = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(format!("{micros}:{}", Uuid::new_v4()));
            let (status, body) = w.get(&alice, &format!("inbox?cursor={cursor}")).await;
            assert_eq!(status, 400, "micros {micros}: {body}");
        }
    }
    let (status, _) = w.post(&alice, "inbox/read-all?filter=bogus").await;
    assert_eq!(status, 400);
    let (status, _) = w.put(&alice, "inbox/not-a-uuid/read").await;
    assert_eq!(status, 400);
    // a junk limit falls back to the default rather than failing
    let (status, _) = w.get(&alice, "inbox?limit=abc").await;
    assert_eq!(status, 200);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn an_item_born_in_the_future_reads_with_a_200_and_never_before_its_message() {
    let _guard = test_lock().await;
    let w = world().await;
    let alice = w.human("alice").await;
    let bob = w.human("bob").await;
    let ch = w.channel("general", "public", &[alice.id, bob.id]).await;
    let (mine, _) = w.say(ch, alice.id, "원문", None, None, None).await;
    // created a couple of seconds ahead of this server's clock: the case where the
    // reader's now() (transaction start) is earlier than the item's created_at
    let ahead: String = sqlx::query_scalar(
        "SELECT to_char(clock_timestamp() + interval '3 seconds', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')",
    )
    .fetch_one(&w.su).await.unwrap();
    let ahead2: String = sqlx::query_scalar(
        "SELECT to_char(clock_timestamp() + interval '4 seconds', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')",
    )
    .fetch_one(&w.su).await.unwrap();
    let (a, _) = w
        .say(
            ch,
            bob.id,
            "앞선 시계 1",
            Some(mine),
            None,
            Some(ahead.as_str()),
        )
        .await;
    let (b, _) = w
        .say(
            ch,
            bob.id,
            "앞선 시계 2",
            Some(mine),
            None,
            Some(ahead2.as_str()),
        )
        .await;
    // the projection copies message.created_at, so both are "in the future"
    let item_a: Uuid = sqlx::query_scalar("SELECT id FROM inbox_item WHERE message_id = $1")
        .bind(a)
        .fetch_one(&w.su)
        .await
        .unwrap();
    let (status, body) = w.put(&alice, &format!("inbox/{item_a}/read")).await;
    assert_eq!(status, 200, "single read of a future-dated item: {body}");
    let (status, body) = w.post(&alice, "inbox/read-all").await;
    assert_eq!(status, 200, "read-all with a future-dated item: {body}");
    assert_eq!(body["marked"], 1);
    for m in [a, b] {
        let ok: bool = sqlx::query_scalar("SELECT read_at IS NOT NULL AND read_at >= created_at FROM inbox_item WHERE message_id = $1")
            .bind(m).fetch_one(&w.su).await.unwrap();
        assert!(ok, "read_at must not precede the message");
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn the_unread_count_stops_at_one_thousand() {
    let _guard = test_lock().await;
    let w = world().await;
    let alice = w.human("alice").await;
    let bob = w.human("bob").await;
    let ch = w.channel("general", "public", &[alice.id, bob.id]).await;
    let (mine, _) = w.say(ch, alice.id, "원문", None, None, None).await;
    sqlx::query(
        "WITH bump AS (UPDATE channel_seq SET last_seq = last_seq + 1005 WHERE channel_id = $1 RETURNING last_seq) \
         INSERT INTO message (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, reply_to_id) \
         SELECT $2, $1, bump.last_seq - 1005 + n, 0, 0, $3, 'text', 'r' || n, $4 \
           FROM bump, generate_series(1, 1005) AS n",
    )
    .bind(ch).bind(w.ws).bind(bob.id).bind(mine)
    .execute(&w.su).await.unwrap();
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM inbox_item WHERE member_id = $1 AND read_at IS NULL",
    )
    .bind(alice.id)
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(rows, 1005, "fixture: more unread rows than the cap");
    let page = w.inbox(&alice, "?limit=1").await;
    assert_eq!(page["unreadCount"], 1000, "capped, not 1005");
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
}
