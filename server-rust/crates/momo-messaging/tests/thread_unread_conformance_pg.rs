//! DB-backed conformance for **안 읽은 답글** — ADR-0206 증보 1 (#4889 2단계, owner 10-31 23:49),
//! migration 165's `thread_follow.last_read_reply_seq`.
//!
//! A followed thread remembers how far its follower has read; the summary under the root says how many
//! replies are past that. Every test proves one rule with a named assertion that goes red when the rule
//! is reverted (the sabotage is in the doc comment above it; the stack handoff lists the measured REDs).
//! All are `#[ignore]` — they need a `pgvector/pgvector:pg18` superuser DB plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26914/s5_4889b \
//!   cargo test -p momo-messaging --test thread_unread_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! Harness contract (identical to `thread_follow_conformance_pg.rs`): `DATABASE_URL` is a superuser that
//! applies the migrations and seeds fixtures past RLS; every call under test runs as `momo_app`
//! (`NOBYPASSRLS`). Two tenants are used where isolation matters.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    create_channel, mark_thread_read_in_tx, send_message_with_mentions_in_tx,
    set_thread_follow_in_tx, thread_follow_views_in_tx, ChannelKind, FollowRefused, FollowView,
    NewChannel, NewMessage, SendExtras, ThreadReadState,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
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
    let password =
        std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string());
    PgPoolOptions::new()
        .max_connections(16)
        .connect_with(opts.username("momo_app").password(&password))
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
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration on a pgvector/pg18 DB");
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        ))
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

// ---------------------------------------------------------------------------
// seed helpers (superuser -> past RLS)
// ---------------------------------------------------------------------------

async fn seed_workspace(su: &PgPool) -> Uuid {
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(ws)
        .bind(ws.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    ws
}

async fn seed_member(su: &PgPool, ws: Uuid, kind: &str, handle: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, $3::member_kind, $4, $5)",
    )
    .bind(id)
    .bind(ws)
    .bind(kind)
    .bind(format!("{handle} display"))
    .bind(handle)
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member'::membership_role) ON CONFLICT DO NOTHING",
    )
    .bind(ws)
    .bind(id)
    .execute(su)
    .await
    .expect("seed workspace membership");
    id
}

async fn seed_agent(su: &PgPool, ws: Uuid, owner: Uuid, handle: &str) -> Uuid {
    let id = seed_member(su, ws, "agent", handle).await;
    sqlx::query(
        "INSERT INTO agent \
           (member_id, workspace_id, model, base_url, max_concurrent_runs, max_run_steps, \
            owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
    )
    .bind(id)
    .bind(ws)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed agent");
    id
}

async fn join(su: &PgPool, ws: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member'::membership_role) \
         ON CONFLICT (channel_id, member_id) DO NOTHING",
    )
    .bind(ws)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("seed channel membership");
}

/// One tenant: a public channel with the listed humans joined (the first one creates it).
struct Room {
    ws: Uuid,
    channel: Uuid,
    people: Vec<(&'static str, Uuid)>,
}

impl Room {
    fn id(&self, label: &str) -> Uuid {
        self.people
            .iter()
            .find(|(name, _)| *name == label)
            .unwrap_or_else(|| panic!("no {label} in the room"))
            .1
    }
}

async fn seed_room(su: &PgPool, app: &PgPool, labels: &[&'static str]) -> Room {
    let ws = seed_workspace(su).await;
    let mut people = Vec::new();
    for label in labels {
        people.push((*label, seed_member(su, ws, "human", label).await));
    }
    let channel = create_channel(
        app,
        ws,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("ch-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: people[0].1,
        },
    )
    .await
    .expect("create channel")
    .id;
    for (_, member) in &people {
        join(su, ws, channel, *member).await;
    }
    Room {
        ws,
        channel,
        people,
    }
}

fn text(channel: Uuid, author: Uuid, body: &str) -> NewMessage {
    let mut input = NewMessage::text(channel, author, body);
    input.client_msg_id = Some(Uuid::new_v4());
    input
}

/// A message through the REST spine (records mentions, bumps the thread rollup, makes the automatic
/// follows). Returns `(id, seq)`.
async fn say(
    app: &PgPool,
    room: &Room,
    author: &str,
    root: Option<Uuid>,
    body: &str,
) -> (Uuid, i64) {
    let mut input = text(room.channel, room.id(author), body);
    input.root_id = root;
    let ws = room.ws;
    let sent = with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            let outcome =
                send_message_with_mentions_in_tx(conn, ws, input, SendExtras::default()).await?;
            Ok::<_, DbError>(outcome.expect("an unsigned send is never a provenance rejection"))
        })
    })
    .await
    .expect("rest send");
    (sent.message.id, sent.message.seq)
}

async fn follow(app: &PgPool, room: &Room, root: Uuid, who: &str, on: bool) {
    let (ws, channel, member) = (room.ws, room.channel, room.id(who));
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move { set_thread_follow_in_tx(conn, ws, channel, root, member, on).await })
    })
    .await
    .expect("set follow")
    .expect("accepted");
}

/// The reader's standing in `root` as the API role sees it.
async fn view(app: &PgPool, ws: Uuid, reader: Uuid, root: Uuid) -> Option<FollowView> {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move { thread_follow_views_in_tx(conn, ws, reader, &[root]).await })
    })
    .await
    .expect("read views")
    .get(&root)
    .copied()
}

async fn signal(
    app: &PgPool,
    room: &Room,
    root: Uuid,
    who: &str,
    seq: i64,
) -> Result<ThreadReadState, FollowRefused> {
    let (ws, channel, member) = (room.ws, room.channel, room.id(who));
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move { mark_thread_read_in_tx(conn, ws, channel, root, member, seq).await })
    })
    .await
    .expect("signal")
}

/// The stored position, read past RLS.
async fn stored_position(su: &PgPool, root: Uuid, member: Uuid) -> Option<i64> {
    sqlx::query_scalar(
        "SELECT last_read_reply_seq FROM thread_follow WHERE root_id = $1 AND member_id = $2",
    )
    .bind(root)
    .bind(member)
    .fetch_optional(su)
    .await
    .expect("read the stored position")
}

async fn rows_for(su: &PgPool, root: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM thread_follow WHERE root_id = $1")
        .bind(root)
        .fetch_one(su)
        .await
        .expect("count rows")
}

// ---------------------------------------------------------------------------
// where a new row starts
// ---------------------------------------------------------------------------

/// A new row starts where the person already is: the **replier** at their own reply (they saw the
/// thread up to there), the root's author and the mentioned at the reply just before the one that
/// pulled them in (so that reply is the first unread one), and a **direct** follow at the thread's
/// head ("from now on").
///
/// Sabotage: seed every automatic row at 0 → the replier's and the mentioned person's positions go red
/// (and the replier would see the whole thread as unread right after replying); drop the replier's
/// special case (`$5` for everyone) → the author's position goes red; seed a direct follow at 0 →
/// the direct follower's position goes red.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_new_row_starts_where_the_person_already_is() {
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(
        &su,
        &app,
        &["author", "replier", "mentioned", "direct", "plain"],
    )
    .await;

    let (root, _) = say(&app, &room, "author", None, "root").await;
    let (_, first) = say(&app, &room, "replier", Some(root), "first").await;
    assert_eq!(
        stored_position(&su, root, room.id("replier")).await,
        Some(first),
        "the replier read up to their own reply"
    );
    assert_eq!(
        stored_position(&su, root, room.id("author")).await,
        Some(first - 1),
        "the root's author is pulled in by the first reply: that reply is unread"
    );

    let (_, second) = say(
        &app,
        &room,
        "replier",
        Some(root),
        "second, ping @mentioned",
    )
    .await;
    assert_eq!(
        stored_position(&su, root, room.id("mentioned")).await,
        Some(second - 1),
        "a person mentioned deep in a thread sees the reply that named them as the first unread one, \
         not the whole history"
    );
    assert_eq!(
        stored_position(&su, root, room.id("replier")).await,
        Some(first),
        "a later reply never moves an existing row's position (only a signal does)"
    );

    follow(&app, &room, root, "direct", true).await;
    assert_eq!(
        stored_position(&su, root, room.id("direct")).await,
        Some(second),
        "following is 'from now on': the replies already there are not new"
    );
    assert_eq!(
        stored_position(&su, root, room.id("plain")).await,
        None,
        "a member the thread never touched has no row and so no position"
    );
}

// ---------------------------------------------------------------------------
// what is counted
// ---------------------------------------------------------------------------

/// Other people's finished `text` replies past the position — **not the reader's own**, not a deleted
/// one, not a progress line — and only for a thread the reader follows (a stranger has no value at
/// all, a stopped follow reports none).
///
/// Sabotage: drop `r.author_member_id <> $2` → the replier counts their own replies; drop
/// `r.deleted_at IS NULL` → the deleted reply counts; drop `r.type = 'text'` → the tool line counts;
/// treat `unfollowed` as following → the stopped member gets a number.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn unread_counts_other_peoples_replies_past_the_position_and_only_for_followers() {
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "replier", "stopped", "stranger"]).await;
    let agent = seed_agent(&su, room.ws, room.id("author"), "helper").await;
    join(&su, room.ws, room.channel, agent).await;

    let (root, _) = say(&app, &room, "author", None, "root").await;
    follow(&app, &room, root, "stopped", true).await;
    say(&app, &room, "replier", Some(root), "r1").await;
    say(&app, &room, "author", Some(root), "r2 by the root's author").await;
    say(&app, &room, "replier", Some(root), "r3").await;
    let (r4, _) = say(&app, &room, "replier", Some(root), "r4").await;
    follow(&app, &room, root, "stopped", false).await;
    // An agent's progress line inside the thread: not a reply anybody reads.
    sqlx::query(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, props, root_id) \
         VALUES ($1, $2, (SELECT last_seq + 1 FROM channel_seq WHERE channel_id = $2), 1, 0, $3, \
                 'tool_call', '{}'::jsonb, $4)",
    )
    .bind(room.ws)
    .bind(room.channel)
    .bind(agent)
    .bind(root)
    .execute(&su)
    .await
    .expect("insert a tool_call line into the thread");

    let replier = view(&app, room.ws, room.id("replier"), root)
        .await
        .expect("replier follows");
    assert!(replier.following);
    assert_eq!(
        replier.unread_reply_count, 1,
        "the replier wrote r1, r3 and r4 (own: never counted) and read up to r1; only the author's r2 \
         is somebody else's text past the position; the tool line is no reply"
    );
    let author = view(&app, room.ws, room.id("author"), root)
        .await
        .expect("author follows");
    assert_eq!(
        author.unread_reply_count, 3,
        "the author's own r2 is not counted; r1, r3 and r4 are unread (position started before r1)"
    );

    // A deleted reply is not unread any more.
    sqlx::query("UPDATE message SET deleted_at = now() WHERE id = $1")
        .bind(r4)
        .execute(&su)
        .await
        .expect("delete r4");
    assert_eq!(
        view(&app, room.ws, room.id("author"), root)
            .await
            .unwrap()
            .unread_reply_count,
        2,
        "a deleted reply drops out of the count"
    );

    let stopped = view(&app, room.ws, room.id("stopped"), root)
        .await
        .expect("the row is kept");
    assert!(!stopped.following, "a stopped follow is not following");
    assert!(
        view(&app, room.ws, room.id("stranger"), root)
            .await
            .is_none(),
        "a member with no row has no standing at all"
    );
}

// ---------------------------------------------------------------------------
// the signal
// ---------------------------------------------------------------------------

/// The signal moves the position **forward only**, and never past the last reply that exists: a lower
/// request changes nothing, a request beyond the head stops at the head, and a negative one reads as 0.
///
/// Sabotage: drop `target.seq > tf.last_read_reply_seq` from the UPDATE → the lower request rewinds the
/// position; drop the `LEAST(…, thread head)` → the request past the head marks future replies read.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn the_signal_only_moves_forward_and_never_past_the_head() {
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "replier"]).await;

    let (root, _) = say(&app, &room, "author", None, "root").await;
    let (_, r1) = say(&app, &room, "replier", Some(root), "r1").await;
    let (_, r2) = say(&app, &room, "replier", Some(root), "r2").await;
    let (_, r3) = say(&app, &room, "replier", Some(root), "r3").await;
    let author = room.id("author");
    assert_eq!(stored_position(&su, root, author).await, Some(r1 - 1));

    let after_r2 = signal(&app, &room, root, "author", r2).await.unwrap();
    assert_eq!(
        after_r2,
        ThreadReadState {
            following: true,
            last_read_reply_seq: Some(r2),
            unread_reply_count: Some(1),
        }
    );
    let rewind = signal(&app, &room, root, "author", r1).await.unwrap();
    assert_eq!(
        rewind.last_read_reply_seq,
        Some(r2),
        "a lower request does not rewind"
    );
    assert_eq!(stored_position(&su, root, author).await, Some(r2));
    let negative = signal(&app, &room, root, "author", -40).await.unwrap();
    assert_eq!(
        negative.last_read_reply_seq,
        Some(r2),
        "a negative request is read as 0"
    );

    let beyond = signal(&app, &room, root, "author", r3 + 1_000)
        .await
        .unwrap();
    assert_eq!(
        beyond,
        ThreadReadState {
            following: true,
            last_read_reply_seq: Some(r3),
            unread_reply_count: Some(0),
        },
        "past the head stops at the head: nothing that was not written yet is marked read"
    );
    // A reply written after the clamp is unread — the clamp did not eat it.
    let (_, r4) = say(&app, &room, "replier", Some(root), "r4").await;
    assert!(r4 > r3);
    assert_eq!(
        view(&app, room.ws, author, root)
            .await
            .unwrap()
            .unread_reply_count,
        1,
        "a reply written after the signal is unread"
    );
}

/// The signal writes **no row**, and a stopped follow keeps its position without reporting a count:
/// for a thread the caller does not follow the answer is `following: false` and nothing is stored;
/// for a stopped one the position keeps up (so re-following does not resurface what was read) but no
/// number comes back.
///
/// Sabotage: make the signal an upsert → the stranger gets a row; stop updating a stopped row → the
/// re-follow resurfaces replies the person read; report the count for an `unfollowed` row → the
/// stopped member's answer carries a number.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn the_signal_writes_no_row_and_a_stopped_follow_keeps_its_position_without_reporting_it() {
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "replier", "stranger"]).await;

    let (root, _) = say(&app, &room, "author", None, "root").await;
    let (_, r1) = say(&app, &room, "replier", Some(root), "r1").await;
    let (_, r2) = say(&app, &room, "replier", Some(root), "r2").await;

    let before = rows_for(&su, root).await;
    let nobody = signal(&app, &room, root, "stranger", r2).await.unwrap();
    assert_eq!(
        nobody,
        ThreadReadState {
            following: false,
            last_read_reply_seq: None,
            unread_reply_count: None,
        }
    );
    assert_eq!(
        rows_for(&su, root).await,
        before,
        "the signal creates no row"
    );

    follow(&app, &room, root, "author", false).await;
    let stopped = signal(&app, &room, root, "author", r1).await.unwrap();
    assert_eq!(
        stopped,
        ThreadReadState {
            following: false,
            last_read_reply_seq: None,
            unread_reply_count: None,
        },
        "a stopped follow reports no number"
    );
    assert_eq!(
        stored_position(&su, root, room.id("author")).await,
        Some(r1),
        "…but its position kept up with what the person read"
    );
    follow(&app, &room, root, "author", true).await;
    assert_eq!(
        view(&app, room.ws, room.id("author"), root)
            .await
            .unwrap()
            .unread_reply_count,
        1,
        "re-following shows only what is really unread (r2), not what was read while stopped (r1)"
    );
}

// ---------------------------------------------------------------------------
// two tenants
// ---------------------------------------------------------------------------

/// Another tenant cannot read or move a position: in B's context, A's roots have no views and a signal
/// aimed at A's thread is refused as a non-member and writes nothing. (RLS is what holds this; the
/// `momo_app` role is `NOBYPASSRLS`.)
///
/// Sabotage: drop the `ws_isolation` policy (or make it `USING (true)`) → B's context reads A's rows
/// and the signal moves A's position.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn two_tenants_cannot_read_or_move_each_others_positions() {
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let a = seed_room(&su, &app, &["author", "replier"]).await;
    let b = seed_room(&su, &app, &["author", "replier"]).await;

    let (root_a, _) = say(&app, &a, "author", None, "A's root").await;
    let (_, a1) = say(&app, &a, "replier", Some(root_a), "A's reply").await;
    let (root_b, _) = say(&app, &b, "author", None, "B's root").await;
    say(&app, &b, "replier", Some(root_b), "B's reply").await;
    let a_author = a.id("author");

    // B's tenant context, A's ids.
    let (ws_a, ws_b) = (a.ws, b.ws);
    let (channel_a, root, member) = (a.channel, root_a, a_author);
    let views = with_tenant_tx(&app, ws_b, move |conn| {
        Box::pin(async move { thread_follow_views_in_tx(conn, ws_a, member, &[root]).await })
    })
    .await
    .expect("views");
    assert!(views.is_empty(), "B's context sees none of A's positions");
    let refused = with_tenant_tx(&app, ws_b, move |conn| {
        Box::pin(async move {
            mark_thread_read_in_tx(conn, ws_a, channel_a, root, member, 1_000_000).await
        })
    })
    .await
    .expect("signal");
    assert_eq!(refused, Err(FollowRefused::NotAMember));
    assert_eq!(
        stored_position(&su, root_a, a_author).await,
        Some(a1 - 1),
        "A's position did not move"
    );

    // And each tenant's own counts are its own.
    assert_eq!(
        view(&app, a.ws, a_author, root_a)
            .await
            .unwrap()
            .unread_reply_count,
        1
    );
    assert_eq!(
        view(&app, b.ws, b.id("author"), root_b)
            .await
            .unwrap()
            .unread_reply_count,
        1
    );
}
