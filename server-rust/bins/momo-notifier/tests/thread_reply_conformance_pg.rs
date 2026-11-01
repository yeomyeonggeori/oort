//! DB-backed conformance for the **`thread_reply` push** — ADR-0206 증보 1 F4–F7 (#4889 2단계),
//! migration 165 (the notifier's one `SELECT` on `thread_follow`).
//!
//! A new reply in a thread the member follows pushes them, on the seventh wire reason. Every test
//! proves one rule with a named assertion that goes red when the rule is reverted (the sabotage that
//! turns it red is in the doc comment above it, and the stack handoff lists the measured REDs). All
//! are `#[ignore]`: they need a `pgvector/pgvector:pg18` superuser DB plus the runtime roles.
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26914/s5_4889b \
//!   cargo test -p momo-notifier --test thread_reply_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! Harness contract (the same as `push_conformance_pg`): `DATABASE_URL` is a **superuser** that
//! applies the migrations, seeds the people and their devices past RLS and writes the fixtures'
//! timestamps; every send goes through the production spine as `momo_app` (`NOBYPASSRLS`), so the
//! mentions are recorded and the follow rows are made by the real automatic follow; the drain runs as
//! the BYPASSRLS `momo_notifier`; the relay is an injected recording mock. Two tenants are used where
//! isolation matters.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_followed_threads_new_reply_pushes_each_follower_once_and_nobody_else` | drop the `thread_follow` condition from the arm (the stranger is pushed), or the `state IN ('auto','followed')` filter (the one who stopped is pushed), or let the arm select the replier (move `thread_reply` into the author exception) |
//! | `the_three_automatic_paths_all_hear_the_next_reply` | drop the automatic follow call, or the root author / the root's recorded mentions from its candidates |
//! | `a_follower_who_is_also_mentioned_hears_it_once_and_as_the_mention` | put the `thread_reply` arm above the `mention` arm |
//! | `a_pause_a_mute_or_dnd_silences_a_thread_reply_and_an_expired_one_does_not` | let `thread_reply` through the mute (`reason IN ('mention','thread_reply')` in the mute clause) or past DND |
//! | `a_reader_inside_the_window_is_not_pushed_and_one_past_it_is` | drop the `read_state` or the `channel_viewing` clause from the arm, or widen / narrow its 30 s |
//! | `a_streamed_reply_is_held_while_it_streams_and_pushed_once_when_it_closes` | drop `NOT streaming` from the arm |
//! | `a_reply_also_sent_to_the_channel_still_reaches_a_follower_once` | give the reply a second reason / a second dispatch |
//! | `a_thread_reply_push_never_crosses_a_tenant` | drop `tf.workspace_id = $1` from the arm's `thread_follow` lookup |
//! | `a_tool_line_or_a_dm_in_a_followed_thread_pushes_no_thread_reply` | drop `message_type = 'text'` from the arm |
//! | `twenty_replies_in_a_minute_are_seven_pushes_and_the_seventh_is_the_folded_one` | raise the cap 6 to 7, or stop folding, or fold under the message's own collapse id |
//! | `another_thread_has_its_own_window` | key the window by (member, channel) instead of (member, thread root) |
//! | `the_window_starts_over_with_the_next_minute` | never reset the window, or fold by a clock the test cannot move |
//! | `the_server_wide_budget_caps_bulk_pushes_and_leaves_a_mention_alone` | ignore the budget, or spend it on mentions too |
//! | `a_relay_429_drops_a_bulk_push_without_a_retry_but_a_mention_is_still_retried` | requeue a bulk push on 429, or drop a non-bulk push on 429 |
//! | `a_redelivered_candidate_costs_neither_a_window_slot_nor_a_budget_unit` | drop the read-only "already settled" check before the window / budget |

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    create_channel, opening_stream_props, send_message_with_mentions_in_tx,
    send_thread_notice_in_tx, set_thread_follow_in_tx, stream_message_body_in_tx, ChannelKind,
    MessageType, NewChannel, NewMessage, SendExtras, StreamEdit, STREAM_PROPS_KEY,
};
use momo_notifier::{DrainStats, PushConfig, PushDrain};
use momo_push::{DispatchOutcome, PushDispatch, PushDispatcher, RELAY_RATE_LIMITED};
use serde_json::json;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn role_password(env_key: &str, fallback: &str) -> String {
    std::env::var(env_key).unwrap_or_else(|_| fallback.to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn role_pool(role: &str, env_key: &str, fallback: &str) -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let options = options
        .username(role)
        .password(&role_password(env_key, fallback));
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .unwrap_or_else(|error| {
            panic!("connect as {role} (run bootstrap_roles.sql first): {error}")
        })
}

/// The BYPASSRLS notifier credential.
async fn momo_notifier_pool() -> PgPool {
    role_pool(
        "momo_notifier",
        "MOMO_NOTIFIER_PASSWORD",
        "momo_notifier_dev_pw",
    )
    .await
}

/// The RLS-bound API credential every send in this suite goes through.
async fn momo_app_pool() -> PgPool {
    role_pool("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await
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
        .expect("apply all migrations");
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        )))
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

/// The drain claims globally, so two concurrent tests would eat each other's candidates.
async fn drain_test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

/// Push every candidate this test does not own out of the claim window. Non-destructive.
async fn focus_candidates(su: &PgPool, keep_workspace: &[Uuid]) {
    sqlx::query(
        "UPDATE outbox \
            SET available_at = clock_timestamp() + interval '1 hour' \
          WHERE kind = 'push_candidate' \
            AND status = 'pending' \
            AND NOT (workspace_id = ANY($1))",
    )
    .bind(keep_workspace)
    .execute(su)
    .await
    .expect("park candidates belonging to other fixtures");
}

/// Records every dispatch and answers `Accepted`. The only thing this suite ever "sends" to.
struct RecordingDispatcher {
    sent: Arc<Mutex<Vec<PushDispatch>>>,
}

impl RecordingDispatcher {
    fn accepting() -> Arc<Self> {
        Arc::new(RecordingDispatcher {
            sent: Arc::new(Mutex::new(Vec::new())),
        })
    }

    fn sent(&self) -> Vec<PushDispatch> {
        self.sent.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl PushDispatcher for RecordingDispatcher {
    async fn dispatch(&self, dispatch: &PushDispatch) -> DispatchOutcome {
        self.sent.lock().unwrap().push(dispatch.clone());
        DispatchOutcome::Accepted {
            apns_status: 200,
            apns_reason: None,
        }
    }
}

/// Run the notifier's push drain over every candidate the room has produced so far.
async fn drain_room(su: &PgPool, room: &Room) -> Vec<PushDispatch> {
    focus_candidates(su, &[room.ws]).await;
    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    PushDrain::new(pool, PushConfig::for_target(), relay.clone())
        .drain_to_empty(64)
        .await;
    relay.sent()
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/// One workspace, one public channel, a few people with one device each. People are named by
/// label so an assertion reads "who heard it".
struct Room {
    ws: Uuid,
    channel: Uuid,
    people: BTreeMap<&'static str, Uuid>,
    /// Wire spelling of a device id → its owner's label.
    devices: HashMap<String, &'static str>,
}

impl Room {
    fn id(&self, label: &str) -> Uuid {
        self.people[label]
    }

    /// Labels that were pushed for `message` with `reason`, one entry per dispatch (so a double
    /// push shows as a duplicate and fails `assert_hears`).
    fn hits(&self, sent: &[PushDispatch], message: Uuid, reason: &str) -> Vec<&'static str> {
        let mut labels: Vec<&'static str> = sent
            .iter()
            .filter(|dispatch| {
                dispatch.message_id == message.to_string() && dispatch.reason == reason
            })
            .map(|dispatch| self.devices[&dispatch.device_id])
            .collect();
        labels.sort_unstable();
        labels
    }

    /// Exactly these people (each once) were pushed `thread_reply` for `message`.
    fn assert_hears(&self, sent: &[PushDispatch], message: Uuid, expected: &[&'static str]) {
        let mut want: Vec<&'static str> = expected.to_vec();
        want.sort_unstable();
        assert_eq!(
            self.hits(sent, message, "thread_reply"),
            want,
            "thread_reply recipients of {message} (one dispatch per person, one device each); all dispatches: {:?}",
            sent.iter()
                .map(|d| (self.devices.get(&d.device_id), d.reason, d.message_id.clone()))
                .collect::<Vec<_>>()
        );
    }

    /// Nobody was pushed anything for `message`.
    fn assert_silent(&self, sent: &[PushDispatch], message: Uuid) {
        let any: Vec<_> = sent
            .iter()
            .filter(|dispatch| dispatch.message_id == message.to_string())
            .map(|dispatch| (self.devices[&dispatch.device_id], dispatch.reason))
            .collect();
        assert!(
            any.is_empty(),
            "expected no push for {message}, got {any:?}"
        );
    }
}

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
        "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
         VALUES ($1, $2, $3::member_kind, 'active', $4, $5)",
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

/// One device + an active push token for `member`; returns the device id.
async fn seed_device(su: &PgPool, ws: Uuid, member: Uuid) -> Uuid {
    let device = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO device (id, workspace_id, member_id, platform) \
         VALUES ($1, $2, $3, 'ios'::device_platform)",
    )
    .bind(device)
    .bind(ws)
    .bind(member)
    .execute(su)
    .await
    .expect("seed device");
    sqlx::query(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, 'kim.dawn.momo.e2e')",
    )
    .bind(ws)
    .bind(device)
    .bind(member)
    .bind(Uuid::new_v4().simple().to_string().repeat(2))
    .execute(su)
    .await
    .expect("seed push token");
    device
}

/// A room with the given human labels (each joined to the channel and holding one device).
async fn seed_room(su: &PgPool, app: &PgPool, labels: &[&'static str]) -> Room {
    let ws = seed_workspace(su).await;
    let mut people = BTreeMap::new();
    for label in labels {
        people.insert(*label, seed_member(su, ws, "human", label).await);
    }
    let owner = people[labels[0]];
    let channel = create_channel(
        app,
        ws,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("ch-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: owner,
        },
    )
    .await
    .expect("create channel")
    .id;
    let mut devices = HashMap::new();
    for (&label, &member) in &people {
        join(su, ws, channel, member).await;
        devices.insert(seed_device(su, ws, member).await.to_string(), label);
    }
    Room {
        ws,
        channel,
        people,
        devices,
    }
}

fn text(channel: Uuid, author: Uuid, body: &str) -> NewMessage {
    let mut input = NewMessage::text(channel, author, body);
    input.client_msg_id = Some(Uuid::new_v4());
    input
}

/// The REST spine: records mentions, maintains the thread rollup, makes the automatic follows.
async fn rest_send(app: &PgPool, ws: Uuid, input: NewMessage, extras: SendExtras<'static>) -> Uuid {
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(async move {
            let sent = send_message_with_mentions_in_tx(conn, ws, input, extras).await?;
            Ok::<_, DbError>(sent.expect("an unsigned send is never a provenance rejection"))
        })
    })
    .await
    .expect("rest send")
    .message
    .id
}

async fn say(app: &PgPool, room: &Room, author: &str, body: &str) -> Uuid {
    let input = text(room.channel, room.id(author), body);
    rest_send(app, room.ws, input, SendExtras::default()).await
}

async fn reply(app: &PgPool, room: &Room, author: &str, root: Uuid, body: &str) -> Uuid {
    let mut input = text(room.channel, room.id(author), body);
    input.root_id = Some(root);
    rest_send(app, room.ws, input, SendExtras::default()).await
}

async fn set_follow(app: &PgPool, room: &Room, root: Uuid, who: &str, follow: bool) {
    let (ws, channel, member) = (room.ws, room.channel, room.id(who));
    with_tenant_tx(app, ws, move |conn| {
        Box::pin(
            async move { set_thread_follow_in_tx(conn, ws, channel, root, member, follow).await },
        )
    })
    .await
    .expect("set follow")
    .expect("the follow call was accepted");
}

/// The exact cursor / heartbeat relative to the reply's own `created_at`, so a 29 s / 31 s case
/// does not depend on how long the fixture took to write.
async fn read_cursor_before_reply(su: &PgPool, room: &Room, who: &str, reply: Uuid, secs: i64) {
    sqlx::query(
        "INSERT INTO read_state (workspace_id, channel_id, member_id, last_read_seq, last_read_at) \
         VALUES ($1, $2, $3, 1, (SELECT created_at FROM message WHERE id = $4) \
                                 - make_interval(secs => $5::double precision)) \
         ON CONFLICT (channel_id, member_id) DO UPDATE \
            SET last_read_seq = 1, \
                last_read_at = (SELECT created_at FROM message WHERE id = $4) \
                               - make_interval(secs => $5::double precision)",
    )
    .bind(room.ws)
    .bind(room.channel)
    .bind(room.id(who))
    .bind(reply)
    .bind(secs as f64)
    .execute(su)
    .await
    .expect("set the read cursor");
}

async fn heartbeat_before_reply(su: &PgPool, room: &Room, who: &str, reply: Uuid, secs: i64) {
    sqlx::query(
        "INSERT INTO channel_viewing (workspace_id, channel_id, member_id, seen_at) \
         VALUES ($1, $2, $3, (SELECT created_at FROM message WHERE id = $4) \
                              - make_interval(secs => $5::double precision)) \
         ON CONFLICT (channel_id, member_id) DO UPDATE \
            SET seen_at = (SELECT created_at FROM message WHERE id = $4) \
                          - make_interval(secs => $5::double precision)",
    )
    .bind(room.ws)
    .bind(room.channel)
    .bind(room.id(who))
    .bind(reply)
    .bind(secs as f64)
    .execute(su)
    .await
    .expect("set the presence heartbeat");
}

// ---------------------------------------------------------------------------
// T-7 — who hears a thread reply
// ---------------------------------------------------------------------------

/// The arm's whole target set in one thread: the root's author (automatic), a person who pressed
/// 「따라가기」 (`followed`), and nobody else — not the replier (a message is never pushed to its
/// author), not the person who pressed 「그만 따라가기」, not a member with no row. The envelope names
/// the thread's root, the plain message category, and carries the id-only key set.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn a_followed_threads_new_reply_pushes_each_follower_once_and_nobody_else() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(
        &su,
        &app,
        &["author", "replier", "follower", "stopped", "stranger"],
    )
    .await;

    let root = say(&app, &room, "author", "who has the numbers?").await;
    let first = reply(&app, &room, "replier", root, "I do").await;
    set_follow(&app, &room, root, "follower", true).await;
    set_follow(&app, &room, root, "stopped", false).await;

    let sent = drain_room(&su, &room).await;

    room.assert_hears(&sent, first, &["author", "follower"]);
    for dispatch in sent.iter().filter(|d| d.message_id == first.to_string()) {
        assert_eq!(dispatch.reason, "thread_reply");
        assert_eq!(dispatch.category, "momo.message", "the reply button stays");
        assert_eq!(
            dispatch.thread_id,
            root.to_string(),
            "the envelope's thread-id is the root, which is where a tap goes"
        );
        assert_eq!(dispatch.channel_id, room.channel.to_string());
        let keys: BTreeSet<String> = serde_json::to_value(dispatch)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        let allowed: BTreeSet<String> = [
            "schema",
            "server_id",
            "workspace_id",
            "device_id",
            "device_platform",
            "apns_token",
            "apns_env",
            "apns_topic",
            "collapse_id",
            "badge",
            "reason",
            "thread_id",
            "category",
            "channel_id",
            "message_id",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert_eq!(
            keys, allowed,
            "a reason adds a label, not a field (ADR-0120 D2)"
        );
    }
}

/// The three ways to be followed without pressing anything (F2): the **root's author** (the
/// first reply makes their row), whoever has **replied**, and whoever the **root's** recorded
/// mention named. A third person's later reply reaches all three — and not the third person, and
/// not a member the thread never touched.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn the_three_automatic_paths_all_hear_the_next_reply() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(
        &su,
        &app,
        &["author", "replier", "mentioned", "third", "stranger"],
    )
    .await;

    let root = say(
        &app,
        &room,
        "author",
        "this one is for @mentioned to weigh in on",
    )
    .await;
    let _first = reply(&app, &room, "replier", root, "first reply").await;
    let next = reply(&app, &room, "third", root, "a later reply").await;

    let sent = drain_room(&su, &room).await;

    room.assert_hears(&sent, next, &["author", "replier", "mentioned"]);
}

/// A follower the reply also names is pushed **once**, and as the mention (F4 「한 건만」): the
/// `mention` arm is above `thread_reply`, one message is one reason per person, and the dispatch
/// key is the message.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn a_follower_who_is_also_mentioned_hears_it_once_and_as_the_mention() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "replier", "follower"]).await;

    let root = say(&app, &room, "author", "thread").await;
    reply(&app, &room, "replier", root, "warm up").await;
    set_follow(&app, &room, root, "follower", true).await;
    let named = reply(&app, &room, "replier", root, "ping @follower, over to you").await;

    let sent = drain_room(&su, &room).await;

    assert_eq!(
        room.hits(&sent, named, "mention"),
        vec!["follower"],
        "the named follower hears it once, as the mention"
    );
    room.assert_hears(&sent, named, &["author"]);
    let total_for_follower = sent
        .iter()
        .filter(|d| d.message_id == named.to_string() && room.devices[&d.device_id] == "follower")
        .count();
    assert_eq!(
        total_for_follower, 1,
        "one message, one push, whatever the follow row says"
    );
}

/// An agent's progress line (`tool_call`) in a followed thread is not a reply a person reads: the
/// arm takes finished `text` lines only. (A DM never reaches the arm: its `dm` arm is above and
/// the arm excludes `dm` itself.)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn a_tool_line_or_a_dm_in_a_followed_thread_pushes_no_thread_reply() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "replier"]).await;
    let agent = seed_agent(&su, room.ws, room.id("author"), "helper").await;
    join(&su, room.ws, room.channel, agent).await;

    let root = say(&app, &room, "author", "thread").await;
    reply(
        &app,
        &room,
        "replier",
        root,
        "a reply makes the author a follower",
    )
    .await;
    // The agent's progress line: a tool_call row inside the thread, written like the worker does.
    let tool_line: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, props, root_id) \
         VALUES ($1, $2, (SELECT last_seq + 1 FROM channel_seq WHERE channel_id = $2), 1, 0, $3, \
                 'tool_call', '{}'::jsonb, $4) RETURNING id",
    )
    .bind(room.ws)
    .bind(room.channel)
    .bind(agent)
    .bind(root)
    .fetch_one(&su)
    .await
    .expect("insert a tool_call line into the thread");

    let sent = drain_room(&su, &room).await;

    room.assert_silent(&sent, tool_line);
}

// ---------------------------------------------------------------------------
// T-8 — what quiets a thread reply
// ---------------------------------------------------------------------------

/// A channel mute silences a thread reply (the issue's acceptance), DND silences it, and the
/// mention exception does **not** open it (only `reason = 'mention'` passes a mute). A mute whose
/// time is up, and a pause whose time is up, no longer silence it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn a_pause_a_mute_or_dnd_silences_a_thread_reply_and_an_expired_one_does_not() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(
        &su,
        &app,
        &[
            "author",
            "replier",
            "muted",
            "mute_lapsed",
            "dnd",
            "dnd_lapsed",
            "mention_exception",
        ],
    )
    .await;

    let root = say(&app, &room, "author", "thread").await;
    for who in [
        "muted",
        "mute_lapsed",
        "dnd",
        "dnd_lapsed",
        "mention_exception",
    ] {
        set_follow(&app, &room, root, who, true).await;
    }
    for (who, until) in [
        ("muted", "NULL"),
        ("mention_exception", "NULL"),
        ("mute_lapsed", "now() - interval '1 hour'"),
    ] {
        sqlx::query(&format!(
            "INSERT INTO notification_pref (workspace_id, channel_id, member_id, muted_until) \
             VALUES ($1, $2, $3, {until})"
        ))
        .bind(room.ws)
        .bind(room.channel)
        .bind(room.id(who))
        .execute(&su)
        .await
        .expect("mute the channel");
    }
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, mention_overrides_mute) \
         VALUES ($1, $2, true)",
    )
    .bind(room.ws)
    .bind(room.id("mention_exception"))
    .execute(&su)
    .await
    .expect("mention exception");
    for (who, until) in [("dnd", "NULL"), ("dnd_lapsed", "now() - interval '1 hour'")] {
        sqlx::query(&format!(
            "INSERT INTO notification_rule (workspace_id, member_id, dnd, dnd_until) \
             VALUES ($1, $2, true, {until})"
        ))
        .bind(room.ws)
        .bind(room.id(who))
        .execute(&su)
        .await
        .expect("DND");
    }

    let new_reply = reply(&app, &room, "replier", root, "anyone?").await;
    let sent = drain_room(&su, &room).await;

    room.assert_hears(&sent, new_reply, &["author", "mute_lapsed", "dnd_lapsed"]);
}

/// 「보고 있음」 (F4): a read cursor or a presence heartbeat inside 30 s of the reply holds the push
/// back; one past the window does not. The two signals are an OR, each on its own.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn a_reader_inside_the_window_is_not_pushed_and_one_past_it_is() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(
        &su,
        &app,
        &[
            "author",
            "replier",
            "cursor_29",
            "cursor_31",
            "beat_29",
            "beat_31",
        ],
    )
    .await;

    let root = say(&app, &room, "author", "thread").await;
    for who in ["cursor_29", "cursor_31", "beat_29", "beat_31"] {
        set_follow(&app, &room, root, who, true).await;
    }
    let new_reply = reply(&app, &room, "replier", root, "look").await;
    read_cursor_before_reply(&su, &room, "cursor_29", new_reply, 29).await;
    read_cursor_before_reply(&su, &room, "cursor_31", new_reply, 31).await;
    heartbeat_before_reply(&su, &room, "beat_29", new_reply, 29).await;
    heartbeat_before_reply(&su, &room, "beat_31", new_reply, 31).await;

    let sent = drain_room(&su, &room).await;

    room.assert_hears(&sent, new_reply, &["author", "cursor_31", "beat_31"]);
}

/// A reply an agent is still streaming is held (it has only its first words), and the write that
/// closes it enqueues the second candidate that pushes each follower once.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn a_streamed_reply_is_held_while_it_streams_and_pushed_once_when_it_closes() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "asker", "follower"]).await;
    let agent = seed_agent(&su, room.ws, room.id("author"), "streamer").await;
    join(&su, room.ws, room.channel, agent).await;

    let root = say(&app, &room, "author", "thread").await;
    reply(&app, &room, "asker", root, "first reply").await;
    set_follow(&app, &room, root, "follower", true).await;

    // The agent's answer opens as a stream, inside the thread (the spine that counts a thread reply).
    let (ws, channel) = (room.ws, room.channel);
    let opening = NewMessage {
        channel_id: channel,
        author_member_id: agent,
        message_type: MessageType::Text,
        body: Some("let me check".to_string()),
        props: json!({ STREAM_PROPS_KEY.to_string(): opening_stream_props() }),
        root_id: Some(root),
        reply_to_id: None,
        client_msg_id: Some(Uuid::new_v4()),
        run_id: None,
        hlc_ts: None,
        hlc_count: None,
    };
    let streamed = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { send_thread_notice_in_tx(conn, ws, opening).await })
    })
    .await
    .expect("open the streamed reply")
    .message
    .id;

    let while_streaming = drain_room(&su, &room).await;
    room.assert_silent(&while_streaming, streamed);

    with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            stream_message_body_in_tx(
                conn,
                ws,
                streamed,
                agent,
                "here is what I found",
                StreamEdit {
                    rev: 1,
                    is_final: true,
                    outcome: None,
                    provisional: false,
                },
            )
            .await?
            .expect("the closing slice is applied");
            Ok::<_, DbError>(())
        })
    })
    .await
    .expect("close the stream");

    let after_close = drain_room(&su, &room).await;
    room.assert_hears(&after_close, streamed, &["author", "asker", "follower"]);
}

// ---------------------------------------------------------------------------
// T-9 — a reply also sent to the channel
// ---------------------------------------------------------------------------

/// 「대화에도 보내기」 (#4887) is one message row with a thread root and the channel flag. With no
/// per-channel 「모든 새 글」 level shipped, the follower hears it once as a `thread_reply`; a member
/// who does not follow hears nothing (no channel-level arm exists for them to land in).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn a_reply_also_sent_to_the_channel_still_reaches_a_follower_once() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "replier", "follower", "stranger"]).await;

    let root = say(&app, &room, "author", "thread").await;
    set_follow(&app, &room, root, "follower", true).await;
    let mut input = text(
        room.channel,
        room.id("replier"),
        "this one matters to everybody",
    );
    input.root_id = Some(root);
    let also = rest_send(
        &app,
        room.ws,
        input,
        SendExtras {
            also_in_channel: true,
            ..SendExtras::default()
        },
    )
    .await;

    let sent = drain_room(&su, &room).await;

    room.assert_hears(&sent, also, &["author", "follower"]);
}

// ---------------------------------------------------------------------------
// T-11 — two tenants
// ---------------------------------------------------------------------------

/// Two workspaces with the same shape: a reply in A's thread reaches A's followers only. And a
/// `thread_follow` row that names A's *thread* and A's member but carries B's `workspace_id`
/// (a row the RLS policy would have refused to write, planted past RLS) is not a follow in A:
/// the arm's lookup is keyed on the judged workspace, not on the thread and member alone.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn a_thread_reply_push_never_crosses_a_tenant() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room_a = seed_room(&su, &app, &["author", "replier", "follower", "planted"]).await;
    let room_b = seed_room(&su, &app, &["author", "replier", "follower"]).await;

    let root_a = say(&app, &room_a, "author", "thread in A").await;
    let root_b = say(&app, &room_b, "author", "thread in B").await;
    set_follow(&app, &room_a, root_a, "follower", true).await;
    set_follow(&app, &room_b, root_b, "follower", true).await;
    // A row from another workspace's books that points at A's thread and A's member.
    sqlx::query(
        "INSERT INTO thread_follow (workspace_id, channel_id, root_id, member_id, state) \
         VALUES ($1, $2, $3, $4, 'followed')",
    )
    .bind(room_b.ws)
    .bind(room_a.channel)
    .bind(root_a)
    .bind(room_a.id("planted"))
    .execute(&su)
    .await
    .expect("plant a foreign-workspace follow row");
    let in_a = reply(&app, &room_a, "replier", root_a, "A's reply").await;

    focus_candidates(&su, &[room_a.ws, room_b.ws]).await;
    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    PushDrain::new(pool, PushConfig::for_target(), relay.clone())
        .drain_to_empty(64)
        .await;
    let sent = relay.sent();

    room_a.assert_hears(&sent, in_a, &["author", "follower"]);
    let b_devices: BTreeSet<&String> = room_b.devices.keys().collect();
    assert!(
        sent.iter()
            .all(|d| !b_devices.contains(&d.device_id) || d.reason != "thread_reply"),
        "B's devices heard no thread_reply about A's thread"
    );
    for dispatch in sent.iter().filter(|d| d.reason == "thread_reply") {
        assert_eq!(dispatch.workspace_id, room_a.ws.to_string());
    }
}

// ---------------------------------------------------------------------------
// T-10 — the bulk layer: a window per (member, thread), a server budget, no retry on 429
// ---------------------------------------------------------------------------

/// A fixed epoch second, so the window's minute cannot change under a test.
const T0: i64 = 1_800_000_000;

fn held_clock(now: &Arc<AtomicI64>) -> momo_notifier::bulk::Clock {
    let now = now.clone();
    Arc::new(move || now.load(Ordering::SeqCst))
}

async fn drain_pass(su: &PgPool, rooms: &[&Room], drain: &PushDrain) -> DrainStats {
    let keep: Vec<Uuid> = rooms.iter().map(|room| room.ws).collect();
    focus_candidates(su, &keep).await;
    drain.drain_to_empty(64).await
}

fn mine<'a>(
    room: &Room,
    sent: &'a [PushDispatch],
    who: &str,
    reason: &str,
) -> Vec<&'a PushDispatch> {
    sent.iter()
        .filter(|dispatch| dispatch.reason == reason && room.devices[&dispatch.device_id] == who)
        .collect()
}

async fn candidate_statuses(su: &PgPool, ws: Uuid) -> Vec<(String, i64)> {
    sqlx::query_as(
        "SELECT status::text, count(*) FROM outbox \
          WHERE kind = 'push_candidate' AND workspace_id = $1 GROUP BY 1 ORDER BY 1",
    )
    .bind(ws)
    .fetch_all(su)
    .await
    .expect("candidate statuses")
}

/// Twenty replies in one minute to one follower are **seven** pushes: the first six go out as usual
/// under their own collapse ids, the seventh goes out as the window's one representative
/// (`o:<root>:<minute>`), and the other thirteen send nothing. Same for every follower. The first
/// reply is not delayed (there is no time-based merging).
///
/// Sabotage: raise the cap 6 → 7 (eight pushes); fold under the message's own `m:` id (the
/// representative assertion goes red, and the other thirteen would each send); never fold (twenty).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn twenty_replies_in_a_minute_are_seven_pushes_and_the_seventh_is_the_folded_one() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "replier", "follower"]).await;

    let root = say(&app, &room, "author", "a busy thread").await;
    set_follow(&app, &room, root, "follower", true).await;
    let mut replies = Vec::new();
    for n in 0..20 {
        replies.push(reply(&app, &room, "replier", root, &format!("reply {n}")).await);
    }

    let now = Arc::new(AtomicI64::new(T0));
    let relay = RecordingDispatcher::accepting();
    let drain = PushDrain::new(
        momo_notifier_pool().await,
        PushConfig::for_target(),
        relay.clone(),
    )
    .with_bulk_clock(held_clock(&now));
    let stats = drain_pass(&su, &[&room], &drain).await;
    let sent = relay.sent();

    for who in ["author", "follower"] {
        let pushes = mine(&room, &sent, who, "thread_reply");
        assert_eq!(pushes.len(), 7, "{who}: twenty replies are seven pushes");
        for (n, dispatch) in pushes[..6].iter().enumerate() {
            assert_eq!(
                dispatch.message_id,
                replies[n].to_string(),
                "{who}: reply {n}"
            );
            assert_eq!(
                dispatch.collapse_id,
                format!("m:{}", replies[n]),
                "{who}: the first six keep the message's own collapse id"
            );
        }
        assert_eq!(
            pushes[6].message_id,
            replies[6].to_string(),
            "{who}: the seventh reply"
        );
        assert_eq!(
            pushes[6].collapse_id,
            format!("o:{root}:{}", T0 / 60),
            "{who}: the seventh is the window's representative"
        );
        assert_eq!(
            pushes[6].thread_id,
            root.to_string(),
            "its tap goes to the thread"
        );
        assert!(
            replies[7..]
                .iter()
                .all(|reply| pushes.iter().all(|p| p.message_id != reply.to_string())),
            "{who}: the other thirteen send nothing"
        );
    }
    assert_eq!(
        stats.held_back, 26,
        "13 held back for each of the two followers"
    );
    assert!(
        !drain
            .bulk_counters()
            .contains_key(&("thread_reply", "budget")),
        "the thirteen folded messages did not even ask for the budget (the representative was \
         already sent): {:?}",
        drain.bulk_counters()
    );
    assert_eq!(
        drain.bulk_counters().get(&("thread_reply", "window")).copied(),
        Some(28),
        "fourteen messages folded for each of the two followers (the representative carries the seventh)"
    );
    assert_eq!(
        candidate_statuses(&su, room.ws)
            .await
            .iter()
            .map(|(status, _)| status.as_str())
            .collect::<Vec<_>>(),
        vec!["done"],
        "a folded push is a completed candidate, not a failure and not a retry"
    );
}

/// The window belongs to the **thread**: six replies in each of two threads of one channel are twelve
/// individual pushes, none folded. (Keyed by channel, the seventh would already fold.)
///
/// Sabotage: key the window by (member, channel) → the seventh push of the follower is an `o:` one.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn another_thread_has_its_own_window() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "replier", "follower"]).await;

    let first = say(&app, &room, "author", "thread one").await;
    let second = say(&app, &room, "author", "thread two").await;
    set_follow(&app, &room, first, "follower", true).await;
    set_follow(&app, &room, second, "follower", true).await;
    for n in 0..6 {
        reply(&app, &room, "replier", first, &format!("one {n}")).await;
        reply(&app, &room, "replier", second, &format!("two {n}")).await;
    }

    let now = Arc::new(AtomicI64::new(T0));
    let relay = RecordingDispatcher::accepting();
    let drain = PushDrain::new(
        momo_notifier_pool().await,
        PushConfig::for_target(),
        relay.clone(),
    )
    .with_bulk_clock(held_clock(&now));
    let stats = drain_pass(&su, &[&room], &drain).await;

    let sent = relay.sent();
    let pushes = mine(&room, &sent, "follower", "thread_reply");
    assert_eq!(pushes.len(), 12, "six in each thread");
    assert!(
        pushes.iter().all(|p| p.collapse_id.starts_with("m:")),
        "none is folded"
    );
    assert_eq!(stats.held_back, 0);
}

/// A new minute is a new window: after eight replies (six, the representative, one folded) the clock
/// moves a minute and the next two replies go out individually again.
///
/// Sabotage: never reset the window.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn the_window_starts_over_with_the_next_minute() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "replier", "follower"]).await;

    let root = say(&app, &room, "author", "thread").await;
    set_follow(&app, &room, root, "follower", true).await;
    for n in 0..8 {
        reply(&app, &room, "replier", root, &format!("burst {n}")).await;
    }
    let now = Arc::new(AtomicI64::new(T0));
    let relay = RecordingDispatcher::accepting();
    let drain = PushDrain::new(
        momo_notifier_pool().await,
        PushConfig::for_target(),
        relay.clone(),
    )
    .with_bulk_clock(held_clock(&now));
    drain_pass(&su, &[&room], &drain).await;
    let first_minute = relay.sent();
    assert_eq!(
        mine(&room, &first_minute, "follower", "thread_reply").len(),
        7
    );

    now.fetch_add(60, Ordering::SeqCst);
    let after = [
        reply(&app, &room, "replier", root, "a minute later").await,
        reply(&app, &room, "replier", root, "and another").await,
    ];
    drain_pass(&su, &[&room], &drain).await;
    let sent = relay.sent();
    let later: Vec<_> = mine(&room, &sent, "follower", "thread_reply")
        .into_iter()
        .filter(|p| after.iter().any(|id| p.message_id == id.to_string()))
        .collect();
    assert_eq!(later.len(), 2, "both replies of the new minute go out");
    assert!(
        later.iter().all(|p| p.collapse_id.starts_with("m:")),
        "as individual pushes"
    );
}

/// The server-wide budget holds the whole layer to `bulk_push_per_minute` dispatches per minute: three
/// pushes go out and the rest are not sent and leave **no** unsettled claim behind; their candidates
/// complete. A mention in the same minute is not part of the layer and is still sent.
///
/// Sabotage: ignore the budget (eleven pushes); count mentions against it (the mention is lost).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn the_server_wide_budget_caps_bulk_pushes_and_leaves_a_mention_alone() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "replier", "follower"]).await;

    // Five threads with one reply each — a window per thread, so nothing folds and only the budget
    // can hold the pushes back — and a sixth whose reply names the follower.
    for n in 0..5 {
        let root = say(&app, &room, "author", &format!("thread {n}")).await;
        set_follow(&app, &room, root, "follower", true).await;
        reply(&app, &room, "replier", root, &format!("reply {n}")).await;
    }
    let last = say(&app, &room, "author", "thread 5").await;
    set_follow(&app, &room, last, "follower", true).await;
    let ping = reply(&app, &room, "replier", last, "over to you @follower").await;

    let mut config = PushConfig::for_target();
    config.bulk_push_per_minute = 3;
    let now = Arc::new(AtomicI64::new(T0));
    let relay = RecordingDispatcher::accepting();
    let drain = PushDrain::new(momo_notifier_pool().await, config, relay.clone())
        .with_bulk_clock(held_clock(&now));
    let stats = drain_pass(&su, &[&room], &drain).await;
    let sent = relay.sent();

    let bulk_sent = sent.iter().filter(|d| d.reason == "thread_reply").count();
    assert_eq!(
        bulk_sent, 3,
        "the budget is three dispatches a minute across everyone"
    );
    assert_eq!(
        room.hits(&sent, ping, "mention"),
        vec!["follower"],
        "a mention is not in the layer: the spent budget does not touch it"
    );
    assert_eq!(
        drain.bulk_counters().get(&("thread_reply", "budget")).copied(),
        Some(8),
        "eleven bulk pushes were due (two followers in each of five threads, and the author of the \
         sixth); three went out"
    );
    assert_eq!(stats.held_back, 8);
    assert!(
        candidate_statuses(&su, room.ws)
            .await
            .iter()
            .all(|(status, _)| status == "done"),
        "an over-budget push completes its candidate"
    );
    let stranded: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM push_dispatch_log WHERE workspace_id = $1 AND apns_status IS NULL",
    )
    .bind(room.ws)
    .fetch_one(&su)
    .await
    .expect("count unsettled claims");
    assert_eq!(
        stranded, 0,
        "a held-back push is decided before any claim is taken"
    );
}

/// A relay `429` for a bulk-layer push is **dropped, not retried**: the candidate completes and the
/// claimed row is settled `429` / `relay_http: dropped` (so a redelivery cannot send it). In the same
/// candidate a non-bulk push (the mention) is still requeued with backoff on a 429.
///
/// Sabotage: requeue a bulk push on 429 (the bulk-only candidate stays `pending`); drop a non-bulk push
/// on 429 (the mention's candidate would complete and its claim be settled).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn a_relay_429_drops_a_bulk_push_without_a_retry_but_a_mention_is_still_retried() {
    struct RateLimited;
    #[async_trait::async_trait]
    impl PushDispatcher for RateLimited {
        async fn dispatch(&self, _dispatch: &PushDispatch) -> DispatchOutcome {
            DispatchOutcome::TransientFailure(RELAY_RATE_LIMITED.to_string())
        }
    }

    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "replier", "follower"]).await;

    let root = say(&app, &room, "author", "thread").await;
    set_follow(&app, &room, root, "follower", true).await;
    let plain = reply(&app, &room, "replier", root, "just a reply").await;
    let ping = reply(&app, &room, "replier", root, "and a call for @follower").await;

    let relay: Arc<dyn PushDispatcher> = Arc::new(RateLimited);
    let drain = PushDrain::new(momo_notifier_pool().await, PushConfig::for_target(), relay);
    let stats = drain_pass(&su, &[&room], &drain).await;

    async fn status_of(su: &PgPool, message: Uuid) -> String {
        sqlx::query_scalar(
            "SELECT status::text FROM outbox \
              WHERE kind = 'push_candidate' AND payload->>'message_id' = $1 ORDER BY id LIMIT 1",
        )
        .bind(message.to_string())
        .fetch_one(su)
        .await
        .expect("candidate status")
    }
    assert_eq!(
        status_of(&su, plain).await,
        "done",
        "a bulk-only candidate whose pushes the relay rate-limited is finished, not retried"
    );
    assert_eq!(
        status_of(&su, ping).await,
        "pending",
        "the same 429 on a mention still requeues the candidate with backoff"
    );
    assert_eq!(stats.requeued, 1, "only the mention's candidate");

    let dropped: Vec<(Option<i32>, Option<String>)> = sqlx::query_as(
        "SELECT apns_status, apns_reason FROM push_dispatch_log \
          WHERE workspace_id = $1 AND message_id = $2 ORDER BY member_id",
    )
    .bind(room.ws)
    .bind(plain)
    .fetch_all(&su)
    .await
    .expect("dispatch log of the plain reply");
    assert_eq!(
        dropped.len(),
        2,
        "one claimed row for each of the two followers"
    );
    assert!(
        dropped.iter().all(|(status, reason)| *status == Some(429)
            && reason.as_deref() == Some("relay_http: dropped")),
        "a dropped push is settled 429 / relay_http: dropped: {dropped:?}"
    );
    assert_eq!(
        drain
            .bulk_counters()
            .get(&("thread_reply", "relay_429"))
            .copied(),
        Some(3),
        "the plain reply was due to both followers; the one that names the follower reaches only the \
         author as a thread_reply (the follower hears it as the mention, which is not in the layer)"
    );
    let mention_row: (Option<i32>,) = sqlx::query_as(
        "SELECT apns_status FROM push_dispatch_log \
          WHERE workspace_id = $1 AND message_id = $2 AND member_id = $3",
    )
    .bind(room.ws)
    .bind(ping)
    .bind(room.id("follower"))
    .fetch_one(&su)
    .await
    .expect("the mention's dispatch row");
    assert_eq!(
        mention_row.0, None,
        "the mention's claim stays unsettled for its retry"
    );
}

/// A candidate the outbox hands back (a crash between claim and settle) costs the layer nothing: every
/// push it names is already settled, so no window slot is counted again and no budget unit is spent.
/// The budget here is exactly what the first pass used, so a second look that spent any would fail.
///
/// Sabotage: drop the read-only "already settled" check that precedes the window and the budget → the
/// redelivery asks for budget it no longer has (twelve held back, none recognised as settled).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn a_redelivered_candidate_costs_neither_a_window_slot_nor_a_budget_unit() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let (su, app) = (superuser_pool().await, momo_app_pool().await);
    let room = seed_room(&su, &app, &["author", "replier", "follower"]).await;

    let root = say(&app, &room, "author", "thread").await;
    set_follow(&app, &room, root, "follower", true).await;
    for n in 0..6 {
        reply(&app, &room, "replier", root, &format!("reply {n}")).await;
    }

    let mut config = PushConfig::for_target();
    config.bulk_push_per_minute = 12;
    let now = Arc::new(AtomicI64::new(T0));
    let relay = RecordingDispatcher::accepting();
    let drain = PushDrain::new(momo_notifier_pool().await, config, relay.clone())
        .with_bulk_clock(held_clock(&now));
    let first = drain_pass(&su, &[&room], &drain).await;
    assert_eq!(
        first.dispatched, 12,
        "six replies for each of the two followers"
    );

    sqlx::query(
        "UPDATE outbox SET status = 'pending', available_at = now() - interval '1 second' \
          WHERE kind = 'push_candidate' AND workspace_id = $1",
    )
    .bind(room.ws)
    .execute(&su)
    .await
    .expect("hand every candidate back, as a crash would");
    let second = drain_pass(&su, &[&room], &drain).await;

    assert_eq!(relay.sent().len(), 12, "nothing is sent twice");
    assert_eq!(
        second.skipped_already_settled, 12,
        "every push was recognised as already settled"
    );
    assert_eq!(
        second.held_back, 0,
        "…not mistaken for new demand on the budget"
    );
    assert!(
        !drain
            .bulk_counters()
            .contains_key(&("thread_reply", "budget")),
        "{:?}",
        drain.bulk_counters()
    );
}
