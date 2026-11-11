//! DB-backed conformance for the read-state projection's **followed-thread total** — ADR-0124 증보 4
//! (#5667): `followed_unread_reply_count` on every `GET …/read-state` line, and the ids-only
//! `followed_unread.updated` frame on the reader's personal channel when it can change.
//!
//! Every test proves one rule with a named assertion that goes red when the rule is reverted (the
//! sabotage is in the doc comment above it; the PR body lists the measured REDs). All are `#[ignore]`
//! — they need a `pgvector/pgvector:pg18` superuser DB plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26592/postgres \
//!   cargo test -p momo-messaging --test followed_unread_projection_pg -- --ignored --test-threads=1
//! ```
//!
//! Harness contract (identical to `thread_unread_conformance_pg.rs`): `DATABASE_URL` is a superuser
//! that applies the migrations and seeds fixtures past RLS; every call under test runs as `momo_app`
//! (`NOBYPASSRLS`), except the one that stands in for a BYPASSRLS caller on purpose.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    create_channel, followed_unread_by_channel_in_tx, list_read_state_projection,
    mark_thread_read_in_tx, send_message_with_mentions_in_tx, set_thread_follow_in_tx,
    thread_follow_views_in_tx, ChannelKind, NewChannel, NewMessage, ReadStateProjection,
    SendExtras,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Row;
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

async fn seed_member(su: &PgPool, ws: Uuid, handle: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human'::member_kind, $3, $4)",
    )
    .bind(id)
    .bind(ws)
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

async fn leave(su: &PgPool, channel: Uuid, member: Uuid) {
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("leave the channel");
}

/// One tenant: people, and public channels they have all joined (the first person creates them).
struct Room {
    ws: Uuid,
    channels: Vec<Uuid>,
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

async fn seed_room(su: &PgPool, app: &PgPool, labels: &[&'static str], channels: usize) -> Room {
    let ws = seed_workspace(su).await;
    let mut people = Vec::new();
    for label in labels {
        people.push((*label, seed_member(su, ws, label).await));
    }
    let mut ids = Vec::new();
    for _ in 0..channels {
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
        ids.push(channel);
    }
    Room {
        ws,
        channels: ids,
        people,
    }
}

/// A message through the REST spine (records mentions, bumps the rollup, makes the automatic follows,
/// signals the followers). Returns `(id, seq)`.
async fn say(
    app: &PgPool,
    room: &Room,
    channel: Uuid,
    author: &str,
    root: Option<Uuid>,
    body: &str,
) -> (Uuid, i64) {
    let mut input = NewMessage::text(channel, room.id(author), body);
    input.client_msg_id = Some(Uuid::new_v4());
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

async fn follow(app: &PgPool, room: &Room, channel: Uuid, root: Uuid, who: &str, on: bool) {
    let (ws, member) = (room.ws, room.id(who));
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move { set_thread_follow_in_tx(conn, ws, channel, root, member, on).await })
    })
    .await
    .expect("set follow")
    .expect("accepted");
}

async fn read_thread(app: &PgPool, room: &Room, channel: Uuid, root: Uuid, who: &str, seq: i64) {
    let (ws, member) = (room.ws, room.id(who));
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move { mark_thread_read_in_tx(conn, ws, channel, root, member, seq).await })
    })
    .await
    .expect("signal")
    .expect("accepted");
}

/// `GET read-state` as the API role sees it: channel → line.
async fn projection(app: &PgPool, ws: Uuid, reader: Uuid) -> HashMap<Uuid, ReadStateProjection> {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move { list_read_state_projection(conn, ws, reader).await })
    })
    .await
    .expect("projection")
    .into_iter()
    .map(|line| (line.state.channel_id, line))
    .collect()
}

async fn total(app: &PgPool, room: &Room, channel: Uuid, who: &str) -> i64 {
    projection(app, room.ws, room.id(who))
        .await
        .get(&channel)
        .unwrap_or_else(|| panic!("{who} has a line for the channel"))
        .followed_unread_reply_count
}

/// The thread summaries' numbers for `reader` over `roots`, summed per channel — the definition the
/// new field must equal. Only followed threads carry a number (exactly what the history page attaches).
async fn summed_summaries(
    app: &PgPool,
    ws: Uuid,
    reader: Uuid,
    roots: &[(Uuid, Uuid)],
) -> HashMap<Uuid, i64> {
    let ids: Vec<Uuid> = roots.iter().map(|(_, root)| *root).collect();
    let views = with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move { thread_follow_views_in_tx(conn, ws, reader, &ids).await })
    })
    .await
    .expect("views");
    let mut sums: HashMap<Uuid, i64> = HashMap::new();
    for (channel, root) in roots {
        if let Some(view) = views.get(root).filter(|view| view.following) {
            *sums.entry(*channel).or_default() += view.unread_reply_count;
        }
    }
    sums
}

/// The highest outbox id so far: frames written after it are "this action's".
async fn outbox_mark(su: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT COALESCE(max(id), 0)::bigint FROM outbox")
        .fetch_one(su)
        .await
        .expect("outbox watermark")
}

/// `followed_unread.updated` frames written after `since`, as (recipient member, channel id) pairs,
/// read off the payload itself (the personal channel name and the ids in the body).
async fn frames_since(su: &PgPool, since: i64) -> Vec<(Uuid, Uuid)> {
    let rows = sqlx::query(
        "SELECT partition_key, payload FROM outbox \
          WHERE id > $1 AND payload->'data'->>'type' = 'followed_unread.updated' \
          ORDER BY id",
    )
    .bind(since)
    .fetch_all(su)
    .await
    .expect("read frames");
    rows.iter()
        .map(|row| {
            let partition: Uuid = row.get("partition_key");
            let payload: serde_json::Value = row.get("payload");
            let member = Uuid::parse_str(
                payload["data"]["payload"]["member_id"]
                    .as_str()
                    .expect("member id"),
            )
            .unwrap();
            assert_eq!(member, partition, "partitioned by the recipient: {payload}");
            assert_eq!(
                payload["channel"],
                serde_json::json!(momo_messaging::read_state_channel(member)),
                "the recipient's own personal channel: {payload}"
            );
            let channel = Uuid::parse_str(
                payload["data"]["payload"]["channel_id"]
                    .as_str()
                    .expect("channel id"),
            )
            .unwrap();
            (member, channel)
        })
        .collect()
}

fn recipients(frames: &[(Uuid, Uuid)]) -> Vec<Uuid> {
    let mut members: Vec<Uuid> = frames.iter().map(|(member, _)| *member).collect();
    members.sort();
    members
}

// ---------------------------------------------------------------------------
// the definition
// ---------------------------------------------------------------------------

/// The new field is, channel by channel, **the sum of the thread summaries' `unread_reply_count`** over
/// the threads the reader follows — and the absolute numbers say what that rule is: other people's
/// replies only, followed threads only, deleted replies not, a thread the reader has read not.
///
/// Fixture (reader = `author`, who wrote both roots in channel 1 and one in channel 2):
/// * channel 1, thread A — `bob` replies twice, `author` once: 2 unread (not the author's own);
/// * channel 1, thread B — `bob` replies once, then `author` stops following: 0 (not followed);
/// * channel 1, thread C — `carol`'s root, `bob` replies: `author` never touched it: 0;
/// * channel 2, thread D — `bob` replies three times, one is deleted: 2.
///
/// Sabotage (each measured RED, see the PR): drop `r.author_member_id <> $2` from
/// `followed_unread_by_channel_in_tx` → channel 1 reads 3; drop `tf.state IN ('auto', 'followed')` →
/// channel 1 reads 3 (thread B counts); drop `r.seq > tf.last_read_reply_seq` → channel 2 reads 3
/// after the partial read below… and the sums diverge.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn the_channel_total_is_the_sum_of_the_followed_threads_summaries() {
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "bob", "carol"], 2).await;
    let (one, two) = (room.channels[0], room.channels[1]);

    let (a, _) = say(&app, &room, one, "author", None, "A").await;
    say(&app, &room, one, "bob", Some(a), "a1").await;
    say(&app, &room, one, "author", Some(a), "a2 by the reader").await;
    say(&app, &room, one, "bob", Some(a), "a3").await;

    let (b, _) = say(&app, &room, one, "author", None, "B").await;
    say(&app, &room, one, "bob", Some(b), "b1").await;
    follow(&app, &room, one, b, "author", false).await;

    let (c, _) = say(&app, &room, one, "carol", None, "C").await;
    say(&app, &room, one, "bob", Some(c), "c1").await;

    let (d, _) = say(&app, &room, two, "author", None, "D").await;
    let (_, d1) = say(&app, &room, two, "bob", Some(d), "d1").await;
    say(&app, &room, two, "bob", Some(d), "d2").await;
    let (d3, _) = say(&app, &room, two, "bob", Some(d), "d3").await;
    sqlx::query("UPDATE message SET deleted_at = now() WHERE id = $1")
        .bind(d3)
        .execute(&su)
        .await
        .expect("delete d3");

    let reader = room.id("author");
    let roots = [(one, a), (one, b), (one, c), (two, d)];
    let lines = projection(&app, room.ws, reader).await;
    let sums = summed_summaries(&app, room.ws, reader, &roots).await;
    for channel in [one, two] {
        assert_eq!(
            lines[&channel].followed_unread_reply_count,
            sums.get(&channel).copied().unwrap_or(0),
            "the channel total is the sum of the per-thread numbers the history page shows"
        );
    }
    assert_eq!(
        lines[&one].followed_unread_reply_count, 2,
        "channel 1: bob's a1 and a3 only — the reader's own a2 is not unread, the stopped thread B \
         and the never-followed thread C count nothing"
    );
    assert_eq!(
        lines[&two].followed_unread_reply_count, 2,
        "channel 2: d1 and d2 — the deleted d3 is not unread"
    );

    // Reading part of thread D lowers exactly that much, and the two definitions still agree.
    read_thread(&app, &room, two, d, "author", d1).await;
    let lines = projection(&app, room.ws, reader).await;
    let sums = summed_summaries(&app, room.ws, reader, &roots).await;
    assert_eq!(
        lines[&two].followed_unread_reply_count, 1,
        "after reading up to d1, only d2 is unread"
    );
    assert_eq!(lines[&two].followed_unread_reply_count, sums[&two]);

    // Someone who follows nothing has 0 on every line (the key is never absent).
    let carol = projection(&app, room.ws, room.id("carol")).await;
    assert_eq!(carol[&two].followed_unread_reply_count, 0);
}

// ---------------------------------------------------------------------------
// reading and following move it, and say so
// ---------------------------------------------------------------------------

/// Reading the thread to its head takes it out of the total, and the reader's personal channel gets one
/// frame; reading again (nothing moves) sends nothing. Stopping following takes the thread out too
/// (one frame), following again brings back what is still unread (one frame), and a follow that
/// changes nothing sends nothing.
///
/// Sabotage: drop the emit in `mark_thread_read_in_tx` → the read frame count is 0; drop the emit in
/// `set_thread_follow_in_tx` → the stop frame count is 0; emit on every request (ignore RETURNING) → the
/// no-op read and the no-op follow each send one.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn reading_and_stopping_take_a_thread_out_of_the_total_and_tell_the_readers_devices() {
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "bob"], 1).await;
    let ch = room.channels[0];
    let reader = room.id("author");

    let (root, _) = say(&app, &room, ch, "author", None, "root").await;
    say(&app, &room, ch, "bob", Some(root), "r1").await;
    let (_, r2) = say(&app, &room, ch, "bob", Some(root), "r2").await;
    assert_eq!(total(&app, &room, ch, "author").await, 2);

    let mark = outbox_mark(&su).await;
    read_thread(&app, &room, ch, root, "author", r2).await;
    assert_eq!(
        total(&app, &room, ch, "author").await,
        0,
        "read to the head: nothing unread"
    );
    assert_eq!(
        frames_since(&su, mark).await,
        vec![(reader, ch)],
        "one frame, on the reader's own channel"
    );

    let mark = outbox_mark(&su).await;
    read_thread(&app, &room, ch, root, "author", r2).await;
    assert!(
        frames_since(&su, mark).await.is_empty(),
        "a read that moves nothing sends nothing"
    );

    // One more reply, then stop following: the thread leaves the total.
    say(&app, &room, ch, "bob", Some(root), "r3").await;
    assert_eq!(total(&app, &room, ch, "author").await, 1);
    let mark = outbox_mark(&su).await;
    follow(&app, &room, ch, root, "author", false).await;
    assert_eq!(
        total(&app, &room, ch, "author").await,
        0,
        "a thread the reader stopped following counts nothing"
    );
    assert_eq!(frames_since(&su, mark).await, vec![(reader, ch)]);

    let mark = outbox_mark(&su).await;
    follow(&app, &room, ch, root, "author", false).await;
    assert!(
        frames_since(&su, mark).await.is_empty(),
        "stopping twice changes nothing and sends nothing"
    );

    let mark = outbox_mark(&su).await;
    follow(&app, &room, ch, root, "author", true).await;
    assert_eq!(
        total(&app, &room, ch, "author").await,
        1,
        "following again brings back what is still unread (r3)"
    );
    assert_eq!(frames_since(&su, mark).await, vec![(reader, ch)]);
}

// ---------------------------------------------------------------------------
// a new reply tells the followers
// ---------------------------------------------------------------------------

/// A new reply sends one frame to **every follower but its author** — the root's author, an earlier
/// replier, a person who followed by hand without ever writing (who gets **no inbox item** for it:
/// the inbox's `thread_reply` recipients are the root's author and the writers, which is why the inbox
/// signal is not enough), and a person the reply mentions (pulled in by this very reply). Nobody else:
/// not the author, not a member who stopped following, not a follower who left the channel, not a
/// member who never followed.
///
/// Sabotage: drop the `signal_followers_of_reply_in_tx` call → no frame at all; drop
/// `tf.member_id <> $4` → the author gets one; drop `ms.left_at IS NULL` → the person who left gets one;
/// drop `tf.state IN ('auto', 'followed')` → the stopped member gets one; call it before
/// `auto_follow_in_tx` → the person mentioned in this reply gets none.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_new_reply_tells_every_live_follower_but_its_author() {
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(
        &su,
        &app,
        &[
            "author",
            "replier",
            "direct",
            "mentioned",
            "stopped",
            "gone",
            "plain",
        ],
        1,
    )
    .await;
    let ch = room.channels[0];

    let (root, _) = say(&app, &room, ch, "author", None, "root").await;
    say(&app, &room, ch, "replier", Some(root), "first").await;
    for who in ["direct", "stopped", "gone"] {
        follow(&app, &room, ch, root, who, true).await;
    }
    follow(&app, &room, ch, root, "stopped", false).await;
    leave(&su, ch, room.id("gone")).await;

    let mark = outbox_mark(&su).await;
    let (reply, _) = say(
        &app,
        &room,
        ch,
        "replier",
        Some(root),
        "second, ping @mentioned",
    )
    .await;
    let frames = frames_since(&su, mark).await;
    let mut expected = vec![room.id("author"), room.id("direct"), room.id("mentioned")];
    expected.sort();
    assert_eq!(
        recipients(&frames),
        expected,
        "the root's author, the direct follower and the person this reply pulled in — not the \
         replier (their own reply), not the stopped one, not the one who left, not a bystander"
    );
    assert!(frames.iter().all(|(_, channel)| *channel == ch));

    // The inbox gap this frame closes: the direct follower never wrote, so the inbox made them nothing.
    let direct_items: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM inbox_item WHERE member_id = $1 AND message_id = $2",
    )
    .bind(room.id("direct"))
    .bind(reply)
    .fetch_one(&su)
    .await
    .expect("inbox items");
    assert_eq!(
        direct_items, 0,
        "a direct follower gets no inbox item for a reply — the inbox signal cannot carry this"
    );
    assert_eq!(
        total(&app, &room, ch, "direct").await,
        1,
        "…but the projection counts it for them"
    );
}

// ---------------------------------------------------------------------------
// membership and tenants
// ---------------------------------------------------------------------------

/// A channel the reader is no longer a member of counts nowhere: its line is gone from the projection
/// (with the threads they still follow there), and the other channel's line is untouched.
///
/// Sabotage: none in this change's code holds it — the projection's existing `ms.left_at IS NULL` join
/// does; dropping that join's predicate turns this red.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_channel_the_reader_left_counts_nowhere() {
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "bob"], 2).await;
    let (one, two) = (room.channels[0], room.channels[1]);

    let (a, _) = say(&app, &room, one, "author", None, "A").await;
    say(&app, &room, one, "bob", Some(a), "a1").await;
    let (d, _) = say(&app, &room, two, "author", None, "D").await;
    say(&app, &room, two, "bob", Some(d), "d1").await;
    say(&app, &room, two, "bob", Some(d), "d2").await;

    leave(&su, one, room.id("author")).await;
    let lines = projection(&app, room.ws, room.id("author")).await;
    assert!(
        !lines.contains_key(&one),
        "no line for a channel the reader left"
    );
    assert_eq!(lines[&two].followed_unread_reply_count, 2);
    let total_everywhere: i64 = lines
        .values()
        .map(|line| line.followed_unread_reply_count)
        .sum();
    assert_eq!(
        total_everywhere, 2,
        "the thread they still follow in the channel they left adds nothing anywhere"
    );
}

/// Two tenants never mix. Under the API role RLS already hides the other tenant, so this also stands
/// in for a **BYPASSRLS caller** (the agent worker's role reaches this module): as the superuser, a
/// foreign `thread_follow` row naming A's reader in B's workspace must not reach A's totals.
///
/// Sabotage: drop `tf.workspace_id = $1` from `followed_unread_by_channel_in_tx` → the superuser read
/// returns B's channel with B's unread replies (the API-role read stays green: RLS masks it, which is
/// why the bypassing read is the one that guards the predicate).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn two_tenants_never_mix_even_for_a_caller_that_bypasses_rls() {
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let a = seed_room(&su, &app, &["author", "bob"], 1).await;
    let b = seed_room(&su, &app, &["author", "bob"], 1).await;
    let (ch_a, ch_b) = (a.channels[0], b.channels[0]);

    let (root_a, _) = say(&app, &a, ch_a, "author", None, "A's root").await;
    say(&app, &a, ch_a, "bob", Some(root_a), "A's reply").await;
    let (root_b, _) = say(&app, &b, ch_b, "author", None, "B's root").await;
    say(&app, &b, ch_b, "bob", Some(root_b), "B's reply 1").await;
    say(&app, &b, ch_b, "bob", Some(root_b), "B's reply 2").await;

    // A foreign row: B's workspace, B's thread, but A's reader as the follower (only a superuser can
    // write it — exactly the shape a missing workspace predicate would let through).
    let reader = a.id("author");
    sqlx::query(
        "INSERT INTO thread_follow \
           (workspace_id, channel_id, root_id, member_id, state, last_read_reply_seq) \
         VALUES ($1, $2, $3, $4, 'followed', 0)",
    )
    .bind(b.ws)
    .bind(ch_b)
    .bind(root_b)
    .bind(reader)
    .execute(&su)
    .await
    .expect("seed the foreign row");

    let ws_a = a.ws;
    let mut tx = su.begin().await.expect("superuser tx");
    let bypassing = followed_unread_by_channel_in_tx(&mut tx, ws_a, reader)
        .await
        .expect("superuser read");
    tx.rollback().await.expect("rollback");
    assert_eq!(
        bypassing,
        HashMap::from([(ch_a, 1)]),
        "a caller that bypasses RLS still sees only A's totals"
    );

    // Under the API role, each tenant's line is its own.
    assert_eq!(total(&app, &a, ch_a, "author").await, 1);
    assert_eq!(total(&app, &b, ch_b, "author").await, 2);
    let lines_a = projection(&app, a.ws, reader).await;
    assert!(!lines_a.contains_key(&ch_b));
}

// ---------------------------------------------------------------------------
// the old fields
// ---------------------------------------------------------------------------

/// The projection statement before #5667, frozen here word for word: every field it returned must
/// come back with exactly the same value now that a followed thread with unread replies, a mention, a
/// mark and an advanced cursor sit in the same channel.
const PROJECTION_BEFORE_5667: &str = "SELECT c.id AS channel_id, \
                COALESCE(rs.last_read_seq, 0)::bigint AS last_read_seq, \
                COALESCE(cs.last_seq, 0)::bigint AS latest_seq, \
                GREATEST(COALESCE(cs.last_seq, 0) - COALESCE(rs.last_read_seq, 0), 0)::bigint \
                  AS unread_count, \
                COALESCE(rs.mention_count, 0)::int AS mention_count, \
                rs.marked_unread_before_seq, \
                COALESCE(cs.last_readable_seq, 0)::bigint AS latest_readable_seq, \
                dc.closed_at_seq \
           FROM membership ms \
           JOIN channel c \
             ON c.id = ms.channel_id \
            AND c.workspace_id = $1 \
            AND c.archived_at IS NULL \
           JOIN channel_seq cs \
             ON cs.channel_id = c.id \
            AND cs.workspace_id = $1 \
           LEFT JOIN read_state rs \
             ON rs.channel_id = c.id \
            AND rs.member_id = $2 \
            AND rs.workspace_id = $1 \
           LEFT JOIN dm_closure dc \
             ON dc.channel_id = c.id \
            AND dc.member_id = $2 \
            AND dc.workspace_id = $1 \
          WHERE ms.member_id = $2 \
            AND ms.left_at IS NULL \
          ORDER BY ms.joined_at, c.id";

/// Sabotage: fold the followed total into `unread_count` or `mention_count` → this goes red.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn the_existing_fields_are_exactly_the_old_projections() {
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "bob"], 2).await;
    let (one, two) = (room.channels[0], room.channels[1]);
    let reader = room.id("author");

    let (root, _) = say(&app, &room, one, "author", None, "root").await;
    say(&app, &room, one, "bob", Some(root), "r1 @author").await;
    let (_, r2) = say(&app, &room, one, "bob", Some(root), "r2").await;
    say(&app, &room, two, "bob", None, "elsewhere").await;
    let ws = room.ws;
    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            momo_messaging::update_read_cursor_with_intent_in_tx(
                conn,
                ws,
                one,
                reader,
                r2 - 1,
                momo_messaging::MarkUnreadWrite::Set(r2),
                momo_messaging::ReadIntent::Background,
            )
            .await
        })
    })
    .await
    .expect("advance the cursor and set a mark");

    let now = projection(&app, room.ws, reader).await;
    assert_eq!(
        now[&one].followed_unread_reply_count, 2,
        "the fixture has a total"
    );
    let before = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            sqlx::query(PROJECTION_BEFORE_5667)
                .bind(ws)
                .bind(reader)
                .fetch_all(&mut *conn)
                .await
                .map_err(DbError::from)
        })
    })
    .await
    .expect("the old statement");
    assert_eq!(before.len(), now.len(), "the same lines");
    for row in &before {
        let channel: Uuid = row.get("channel_id");
        let line = &now[&channel];
        let old = (
            row.get::<i64, _>("last_read_seq"),
            row.get::<i64, _>("latest_seq"),
            row.get::<i64, _>("unread_count"),
            row.get::<i32, _>("mention_count"),
            row.get::<Option<i64>, _>("marked_unread_before_seq"),
            row.get::<i64, _>("latest_readable_seq"),
            row.get::<Option<i64>, _>("closed_at_seq"),
        );
        let new = (
            line.state.last_read_seq,
            line.state.latest_seq,
            line.state.unread_count,
            line.state.mention_count,
            line.state.marked_unread_before_seq,
            line.latest_readable_seq,
            line.closed_at_seq,
        );
        assert_eq!(new, old, "channel {channel}: every old field unchanged");
    }
}
