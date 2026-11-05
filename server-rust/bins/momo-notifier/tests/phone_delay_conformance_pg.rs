//! DB-backed conformance for the **phone delay** — ADR-0206 D4 (#4497), migration 174
//! (`member_activity`), the judgment's Rust tail (`momo_push::refine_targets`) and the notifier's
//! `defer`.
//!
//! A person whose web or desktop client is in use (a `member_activity` stamp under 30 s old) does not
//! get a general-message push on their phone at once: it is held for their `phoneDelaySecs`, dropped
//! if they read the message meanwhile, and sent when the delay runs out. Every test proves one rule
//! with a named assertion that goes red when the rule is reverted (the revert is in the doc comment
//! above it; the handoff lists the measured REDs). All are `#[ignore]`: they need a
//! `pgvector/pgvector:pg18` superuser DB plus the runtime roles.
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26971/w4497 \
//!   cargo test -p momo-notifier --test phone_delay_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! Harness contract (the same as `thread_reply_conformance_pg`): `DATABASE_URL` is a **superuser** that
//! applies the migrations and seeds people, devices, messages (the 011 trigger enqueues the push
//! candidate) and the **clock**; the drain runs as the BYPASSRLS `momo_notifier`; the relay is an
//! injected recording mock. Nothing sleeps and nothing reads an environment variable: time is moved
//! by rewriting `outbox.created_at` (the `T` the delay counts from), `outbox.available_at` and
//! `member_activity.seen_at`, and the retry budget is an argument (`PushConfig::max_attempts`).
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `an_active_desktop_holds_the_phone_push_and_reading_it_cancels_it` | drop the `active_at_t AND read` cancel arm of `decide` (the read DM is sent), or let `defer_push_candidate` keep the spent attempt |
//! | `an_unread_message_is_sent_when_the_delay_runs_out_even_if_the_desktop_is_still_active` | hold on `active_now AND NOT read` without the `before_expiry` term (the one-delay rule: a second hold) |
//! | `no_signal_and_a_zero_delay_are_today_and_a_macos_token_is_never_delayed` | widen `PHONE_PLATFORM` to the desktop's token, or skip the `delay_secs <= 0` early return |
//! | `an_approval_is_never_delayed_while_the_desktop_is_active` | add `ApprovalRequest` to `is_delayable_reason` |
//! | `an_inactive_target_is_sent_now_and_the_active_one_once_later` | judge the whole candidate by its first target, or let a pass-2 send skip `claim_dispatch` |
//! | `deferring_twice_does_not_spend_the_retry_budget` | remove `attempts = GREATEST(attempts - 1, 0)` from `defer_push_candidate` |
//! | `a_retry_wins_over_a_deferral_in_the_same_candidate` | let `defer_candidate` run before the `transient` check |
//! | `a_failed_look_at_the_clock_sends_instead_of_losing_the_push` | return the error instead of `Refined::untouched` (the push is lost) |
//! | `two_workspaces_are_judged_apart` | read `member_activity` without `workspace_id` (members collide only across a forged key, so this pins the explicit predicate by behaviour: one workspace's active person never holds another's push) |

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::PgPool;
use momo_notifier::{DrainStats, PushConfig, PushDrain};
use momo_push::{DispatchOutcome, PushDispatch, PushDispatcher, RELAY_RATE_LIMITED};
use serde_json::json;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Row;
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

/// The BYPASSRLS notifier credential.
async fn momo_notifier_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let options = options.username("momo_notifier").password(&role_password(
        "MOMO_NOTIFIER_PASSWORD",
        "momo_notifier_dev_pw",
    ));
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .unwrap_or_else(|error| {
            panic!("connect as momo_notifier (run bootstrap_roles.sql first): {error}")
        })
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
async fn focus_candidates(su: &PgPool, keep_workspaces: &[Uuid]) {
    sqlx::query(
        "UPDATE outbox \
            SET available_at = clock_timestamp() + interval '1 hour' \
          WHERE kind = 'push_candidate' \
            AND status = 'pending' \
            AND NOT (workspace_id = ANY($1))",
    )
    .bind(keep_workspaces)
    .execute(su)
    .await
    .expect("park candidates belonging to other fixtures");
}

/// Records every push the relay accepted. A device in `limited` is answered `429` instead (and
/// recorded in `refused`), which is how a test makes a retry-tier push fail transiently.
struct Relay {
    sent: Mutex<Vec<PushDispatch>>,
    refused: Mutex<Vec<PushDispatch>>,
    limited: Mutex<HashSet<String>>,
}

impl Relay {
    fn accepting() -> Arc<Self> {
        Arc::new(Relay {
            sent: Mutex::new(Vec::new()),
            refused: Mutex::new(Vec::new()),
            limited: Mutex::new(HashSet::new()),
        })
    }

    fn limit(&self, device: Uuid) {
        self.limited.lock().unwrap().insert(device.to_string());
    }

    fn unlimit_all(&self) {
        self.limited.lock().unwrap().clear();
    }

    fn sent(&self) -> Vec<PushDispatch> {
        self.sent.lock().unwrap().clone()
    }

    fn refused(&self) -> Vec<PushDispatch> {
        self.refused.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl PushDispatcher for Relay {
    async fn dispatch(&self, dispatch: &PushDispatch) -> DispatchOutcome {
        if self.limited.lock().unwrap().contains(&dispatch.device_id) {
            self.refused.lock().unwrap().push(dispatch.clone());
            return DispatchOutcome::TransientFailure(RELAY_RATE_LIMITED.to_string());
        }
        self.sent.lock().unwrap().push(dispatch.clone());
        DispatchOutcome::Accepted {
            apns_status: 200,
            apns_reason: None,
        }
    }
}

/// One drain over every candidate that is due for `workspaces`, as the production loop would.
async fn drain(
    su: &PgPool,
    workspaces: &[Uuid],
    config: PushConfig,
    relay: &Arc<Relay>,
) -> DrainStats {
    focus_candidates(su, workspaces).await;
    let dispatcher: Arc<dyn PushDispatcher> = relay.clone();
    PushDrain::new(momo_notifier_pool().await, config, dispatcher)
        .drain_to_empty(64)
        .await
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/// One workspace, one channel (a DM or a public one), a few people with one phone each. People are
/// named by label so an assertion reads "who heard it".
struct Room {
    ws: Uuid,
    channel: Uuid,
    people: BTreeMap<&'static str, Uuid>,
    /// Wire spelling of a device id → `label:platform`.
    devices: HashMap<String, String>,
    /// The device ids per label, in the order they were seeded.
    device_ids: HashMap<&'static str, Vec<Uuid>>,
    seq: AtomicI64,
}

impl Room {
    fn id(&self, label: &str) -> Uuid {
        self.people[label]
    }

    fn next_seq(&self) -> i64 {
        self.seq.fetch_add(1, Ordering::SeqCst)
    }

    /// `label:platform` of everyone pushed for `message`, sorted — one entry per dispatch, so a
    /// double push shows as a duplicate.
    fn heard(&self, sent: &[PushDispatch], message: Uuid) -> Vec<String> {
        let mut heard: Vec<String> = sent
            .iter()
            .filter(|dispatch| dispatch.message_id == message.to_string())
            .map(|dispatch| self.devices[&dispatch.device_id].clone())
            .collect();
        heard.sort_unstable();
        heard
    }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
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

async fn seed_device(su: &PgPool, ws: Uuid, member: Uuid, platform: &str) -> Uuid {
    let device = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO device (id, workspace_id, member_id, platform) \
         VALUES ($1, $2, $3, $4::device_platform)",
    )
    .bind(device)
    .bind(ws)
    .bind(member)
    .bind(platform)
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

/// A room of `kind` (`"dm"` or `"public"`) with these humans, each joined to the channel and
/// holding one **ios** device.
async fn seed_room(su: &PgPool, kind: &str, labels: &[&'static str]) -> Room {
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(ws)
        .bind(ws.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    let mut people = BTreeMap::new();
    for label in labels {
        people.insert(*label, seed_member(su, ws, "human", label).await);
    }

    let channel = Uuid::new_v4();
    if kind == "dm" {
        // `channel_dm_key_required_ck`: a dm channel carries its participant-set key.
        sqlx::query(
            "INSERT INTO channel (id, workspace_id, kind, name, dm_key) \
             VALUES ($1, $2, 'dm', $3, $4)",
        )
        .bind(channel)
        .bind(ws)
        .bind(format!("dm-{}", &channel.simple().to_string()[..8]))
        .bind(channel.simple().to_string())
        .execute(su)
        .await
        .expect("seed dm channel");
    } else {
        sqlx::query(
            "INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)",
        )
        .bind(channel)
        .bind(ws)
        .bind(format!("room-{}", &channel.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("seed public channel");
    }
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(ws)
        .execute(su)
        .await
        .expect("seed channel_seq");

    let mut devices = HashMap::new();
    let mut device_ids: HashMap<&'static str, Vec<Uuid>> = HashMap::new();
    for (&label, &member) in &people {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(ws)
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("seed channel membership");
        let device = seed_device(su, ws, member, "ios").await;
        devices.insert(device.to_string(), format!("{label}:ios"));
        device_ids.entry(label).or_default().push(device);
    }
    Room {
        ws,
        channel,
        people,
        devices,
        device_ids,
        seq: AtomicI64::new(1),
    }
}

/// Give `label` a second device on `platform` (the desktop's own `macos` token).
async fn add_device(su: &PgPool, room: &mut Room, label: &'static str, platform: &str) -> Uuid {
    let device = seed_device(su, room.ws, room.id(label), platform).await;
    room.devices
        .insert(device.to_string(), format!("{label}:{platform}"));
    room.device_ids.entry(label).or_default().push(device);
    device
}

/// A text message from `author`, mentioning `mentions` by the same `props.mention_member_ids`
/// projection the real send path writes. The INSERT fires the 011 trigger: one push candidate.
async fn say(su: &PgPool, room: &Room, author: &str, mentions: &[&str]) -> Uuid {
    let ids: Vec<String> = mentions.iter().map(|m| room.id(m).to_string()).collect();
    let seq = room.next_seq();
    sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props) \
         VALUES ($1, $2, $3, $3, 0, $4, 'text', 'phone-delay fixture', \
                 jsonb_build_object('mention_member_ids', $5::jsonb)) \
         RETURNING id",
    )
    .bind(room.ws)
    .bind(room.channel)
    .bind(seq)
    .bind(room.id(author))
    .bind(json!(ids))
    .fetch_one(su)
    .await
    .expect("insert message (fires push_candidate_enqueue_trg)")
}

/// The member's desktop was in use `secs_ago` seconds ago.
async fn beat(su: &PgPool, room: &Room, who: &str, secs_ago: f64) {
    sqlx::query(
        "INSERT INTO member_activity (workspace_id, member_id, seen_at) \
         VALUES ($1, $2, now() - make_interval(secs => $3::double precision)) \
         ON CONFLICT (workspace_id, member_id) DO UPDATE SET seen_at = EXCLUDED.seen_at",
    )
    .bind(room.ws)
    .bind(room.id(who))
    .bind(secs_ago)
    .execute(su)
    .await
    .expect("set the activity stamp");
}

/// `phoneDelaySecs` for `who` (0, 60 or 300).
async fn set_delay(su: &PgPool, room: &Room, who: &str, secs: i16) {
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, phone_delay_secs) \
         VALUES ($1, $2, $3) \
         ON CONFLICT (workspace_id, member_id) DO UPDATE SET phone_delay_secs = EXCLUDED.phone_delay_secs",
    )
    .bind(room.ws)
    .bind(room.id(who))
    .bind(secs)
    .execute(su)
    .await
    .expect("set phone_delay_secs");
}

/// `who` has read the channel up to `seq`.
async fn read_up_to(su: &PgPool, room: &Room, who: &str, seq: i64) {
    sqlx::query(
        "INSERT INTO read_state (workspace_id, channel_id, member_id, last_read_seq, last_read_at) \
         VALUES ($1, $2, $3, $4, now()) \
         ON CONFLICT (channel_id, member_id) DO UPDATE \
            SET last_read_seq = EXCLUDED.last_read_seq, last_read_at = now()",
    )
    .bind(room.ws)
    .bind(room.channel)
    .bind(room.id(who))
    .bind(seq)
    .execute(su)
    .await
    .expect("set the read cursor");
}

/// The seq `say` gave a message.
async fn seq_of(su: &PgPool, message: Uuid) -> i64 {
    sqlx::query_scalar("SELECT seq FROM message WHERE id = $1")
        .bind(message)
        .fetch_one(su)
        .await
        .expect("read the message seq")
}

/// Let `secs` seconds pass since the candidate was first judged (`T` moves back) and make the
/// deferred row claimable now. The activity stamp is **not** moved: the person kept beating.
async fn let_time_pass(su: &PgPool, message: Uuid, secs: f64) {
    sqlx::query(
        "UPDATE outbox \
            SET created_at = created_at - make_interval(secs => $2::double precision), \
                available_at = now() \
          WHERE kind = 'push_candidate' AND payload->>'message_id' = $1",
    )
    .bind(message.to_string())
    .bind(secs)
    .execute(su)
    .await
    .expect("move the candidate's clock");
}

/// Make a deferred candidate claimable now **without** moving `T` — the message was read inside the
/// delay, and the notifier looks again.
async fn wake_candidate(su: &PgPool, message: Uuid) {
    sqlx::query(
        "UPDATE outbox SET available_at = now() \
          WHERE kind = 'push_candidate' AND payload->>'message_id' = $1",
    )
    .bind(message.to_string())
    .execute(su)
    .await
    .expect("wake the candidate");
}

struct Candidate {
    status: String,
    attempts: i32,
    /// `available_at - created_at`: how far past `T` the candidate waits.
    hold_secs: f64,
}

async fn candidate(su: &PgPool, message: Uuid) -> Candidate {
    let row = sqlx::query(
        "SELECT status::text AS status, attempts, \
                EXTRACT(EPOCH FROM (available_at - created_at))::float8 AS hold_secs \
           FROM outbox \
          WHERE kind = 'push_candidate' AND payload->>'message_id' = $1 \
          ORDER BY id",
    )
    .bind(message.to_string())
    .fetch_one(su)
    .await
    .expect("read the push candidate");
    Candidate {
        status: row.get("status"),
        attempts: row.get("attempts"),
        hold_secs: row.get("hold_secs"),
    }
}

async fn dispatch_rows(su: &PgPool, message: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM push_dispatch_log WHERE message_id = $1")
        .bind(message)
        .fetch_one(su)
        .await
        .expect("count dispatch rows")
}

/// The first drain of a fresh test. Parks other fixtures' candidates.
fn config() -> PushConfig {
    PushConfig::for_target()
}

// ---------------------------------------------------------------------------
// AC 19 — hold, cancel, send when the delay runs out
// ---------------------------------------------------------------------------

/// A DM to a person whose desktop is in use is **not** pushed at once: the candidate is handed back
/// to `pending` until `T + 60 s` with its attempt given back, and no dispatch row exists. When they
/// read it meanwhile the next look **cancels** it: nothing is ever sent, nothing is recorded, and the
/// candidate completes.
///
/// Sabotage: drop the `active_at_t AND read` arm of `decide` (the read DM is sent); keep the spent
/// attempt in `defer_push_candidate` (the `attempts` assertion).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_active_desktop_holds_the_phone_push_and_reading_it_cancels_it() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, "dm", &["ann", "bob"]).await;
    let relay = Relay::accepting();

    beat(&su, &room, "bob", 0.0).await;
    let dm = say(&su, &room, "ann", &[]).await;

    let stats = drain(&su, &[room.ws], config(), &relay).await;
    assert_eq!(
        (stats.dispatched, stats.deferred, stats.activity_held),
        (0, 1, 1),
        "the DM is held for the active desktop: {stats:?}"
    );
    assert!(
        relay.sent().is_empty(),
        "nothing reached the relay while the desktop is in use: {:?}",
        relay.sent()
    );
    assert_eq!(
        dispatch_rows(&su, dm).await,
        0,
        "a hold leaves no dispatch row"
    );
    let held = candidate(&su, dm).await;
    assert_eq!(held.status, "pending", "handed back, not settled");
    assert_eq!(
        held.attempts, 0,
        "the claim's attempt is given back: a hold is not a retry"
    );
    assert!(
        (held.hold_secs - 60.0).abs() < 0.01,
        "it waits until T + 60 s (the default delay), got {}",
        held.hold_secs
    );

    // Bob reads it inside the delay. The notifier looks again before the expiry.
    let seq = seq_of(&su, dm).await;
    read_up_to(&su, &room, "bob", seq).await;
    wake_candidate(&su, dm).await;
    let stats = drain(&su, &[room.ws], config(), &relay).await;
    assert_eq!(
        (stats.dispatched, stats.deferred, stats.activity_cancelled),
        (0, 0, 1),
        "read inside the delay: cancelled, not sent: {stats:?}"
    );
    assert!(relay.sent().is_empty(), "a read message is never pushed");
    assert_eq!(
        dispatch_rows(&su, dm).await,
        0,
        "a cancel leaves no dispatch row"
    );
    assert_eq!(
        candidate(&su, dm).await.status,
        "done",
        "the candidate completes"
    );
}

/// The delay runs out and the person is **still** at the desktop and still has not read it: the push
/// goes. A second look does not hold it again — there is no "delayed once" flag, the hold predicate is
/// simply false past `T + delay` (AC 22).
///
/// Sabotage: hold on `active_now AND NOT read` without the `before_expiry` term — the second pass
/// holds again and sends nothing.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_unread_message_is_sent_when_the_delay_runs_out_even_if_the_desktop_is_still_active() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, "dm", &["ann", "bob"]).await;
    let relay = Relay::accepting();

    beat(&su, &room, "bob", 0.0).await;
    let dm = say(&su, &room, "ann", &[]).await;
    let first = drain(&su, &[room.ws], config(), &relay).await;
    assert_eq!(first.deferred, 1, "held first: {first:?}");

    // 61 s later; he kept beating the whole time.
    let_time_pass(&su, dm, 61.0).await;
    beat(&su, &room, "bob", 0.0).await;
    let second = drain(&su, &[room.ws], config(), &relay).await;

    assert_eq!(
        (second.dispatched, second.deferred, second.activity_held),
        (1, 0, 0),
        "past the expiry the unread DM goes, even to an active desktop (one delay only): {second:?}"
    );
    assert_eq!(room.heard(&relay.sent(), dm), strings(&["bob:ios"]));
    assert_eq!(dispatch_rows(&su, dm).await, 1);
    assert_eq!(candidate(&su, dm).await.status, "done");
}

// ---------------------------------------------------------------------------
// AC 20 — what is never delayed
// ---------------------------------------------------------------------------

/// Nothing changes for: a person who never sent the signal (an old client, a phone-only person); a
/// delay of **0** (no hold, **and** no read-cancel — a read DM still goes, as today); and a `macos`
/// token (the desktop's own), which goes at once while the same person's phone is held.
///
/// Sabotage: widen `PHONE_PLATFORM` to the desktop's token (the macos push is held with the phone);
/// skip the `delay_secs <= 0` early return (the zero-delay cases are held / cancelled).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn no_signal_and_a_zero_delay_are_today_and_a_macos_token_is_never_delayed() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let relay = Relay::accepting();

    // (a) no signal: no `member_activity` row at all.
    let quiet = seed_room(&su, "dm", &["ann", "bob"]).await;
    let to_quiet = say(&su, &quiet, "ann", &[]).await;

    // (b) a delay of 0 with the desktop active, and the message already read.
    let zero = seed_room(&su, "dm", &["ann", "bob"]).await;
    set_delay(&su, &zero, "bob", 0).await;
    beat(&su, &zero, "bob", 0.0).await;
    let to_zero = say(&su, &zero, "ann", &[]).await;
    let seq = seq_of(&su, to_zero).await;
    read_up_to(&su, &zero, "bob", seq).await;

    // (c) an active desktop; bob holds a phone AND a macos token.
    let mut both = seed_room(&su, "dm", &["ann", "bob"]).await;
    add_device(&su, &mut both, "bob", "macos").await;
    beat(&su, &both, "bob", 0.0).await;
    let to_both = say(&su, &both, "ann", &[]).await;

    let stats = drain(&su, &[quiet.ws, zero.ws, both.ws], config(), &relay).await;
    let sent = relay.sent();

    assert_eq!(
        quiet.heard(&sent, to_quiet),
        strings(&["bob:ios"]),
        "no signal, no delay: {stats:?}"
    );
    assert_eq!(
        zero.heard(&sent, to_zero),
        strings(&["bob:ios"]),
        "a delay of 0 is no delay and no read-cancel: {stats:?}"
    );
    assert_eq!(
        both.heard(&sent, to_both),
        strings(&["bob:macos"]),
        "the macos token goes at once; the phone is held: {stats:?}"
    );
    assert_eq!(
        stats.deferred, 1,
        "only the mixed candidate waits (for the phone): {stats:?}"
    );
    assert_eq!(candidate(&su, to_both).await.status, "pending");

    // The phone's turn comes: it goes once, and the macos push is not repeated.
    let_time_pass(&su, to_both, 61.0).await;
    drain(&su, &[both.ws], config(), &relay).await;
    assert_eq!(
        both.heard(&relay.sent(), to_both),
        strings(&["bob:ios", "bob:macos"]),
        "each device exactly once across both passes"
    );
    assert_eq!(dispatch_rows(&su, to_both).await, 2);
}

/// An approval request is not on the allow-list: the owner's phone is pushed at once although their
/// desktop is in use and they have not read the card.
///
/// Sabotage: add `ApprovalRequest` to `is_delayable_reason` — the card is held.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_approval_is_never_delayed_while_the_desktop_is_active() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, "public", &["owner"]).await;
    let relay = Relay::accepting();

    // The owner, and an agent of theirs asking.
    sqlx::query("UPDATE workspace_membership SET role = 'owner'::membership_role WHERE workspace_id = $1 AND member_id = $2")
        .bind(room.ws)
        .bind(room.id("owner"))
        .execute(&su)
        .await
        .expect("make the owner an owner");
    let requester = seed_member(&su, room.ws, "agent", "requester").await;
    sqlx::query(
        "INSERT INTO agent \
           (member_id, workspace_id, model, base_url, max_concurrent_runs, max_run_steps, \
            owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
    )
    .bind(requester)
    .bind(room.ws)
    .bind(room.id("owner"))
    .execute(&su)
    .await
    .expect("seed agent");
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(room.ws)
        .bind(room.channel)
        .bind(requester)
        .execute(&su)
        .await
        .expect("seed the agent's channel membership");
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key) \
         VALUES ($1, $2, $3, $4, 'awaiting_approval'::run_status, $5, $6)",
    )
    .bind(run)
    .bind(room.ws)
    .bind(requester)
    .bind(room.channel)
    .bind(json!({"type": "chat"}))
    .bind(format!("phone-delay:{run}"))
    .execute(&su)
    .await
    .expect("seed agent run");

    beat(&su, &room, "owner", 0.0).await;

    let approval_id = Uuid::new_v4();
    let card: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props) \
         VALUES ($1, $2, $3, $3, 0, $4, 'approval_request', 'Approve it', \
                 jsonb_build_object('approval_id', $5::text, 'action_type', 'tool_call')) \
         RETURNING id",
    )
    .bind(room.ws)
    .bind(room.channel)
    .bind(room.next_seq())
    .bind(requester)
    .bind(approval_id.to_string())
    .fetch_one(&su)
    .await
    .expect("insert approval_request card (fires push_candidate_enqueue_trg)");
    sqlx::query(
        "INSERT INTO approval \
           (id, workspace_id, run_id, channel_id, request_message_id, requested_by, \
            action_type, payload, status, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, 'tool_call', $7, 'pending', now() + interval '1 hour')",
    )
    .bind(approval_id)
    .bind(room.ws)
    .bind(run)
    .bind(room.channel)
    .bind(card)
    .bind(requester)
    .bind(json!({"tool_call": {"call_id": "c1", "name": "send_message"}}))
    .execute(&su)
    .await
    .expect("insert approval");

    let stats = drain(&su, &[room.ws], config(), &relay).await;
    let sent = relay.sent();
    assert_eq!(
        room.heard(&sent, card),
        strings(&["owner:ios"]),
        "the approval goes at once: {stats:?}"
    );
    assert!(
        sent.iter().all(|d| d.reason == "approval_request"),
        "and it is an approval push: {:?}",
        sent.iter().map(|d| d.reason).collect::<Vec<_>>()
    );
    assert_eq!(
        (
            stats.deferred,
            stats.activity_held,
            stats.activity_cancelled
        ),
        (0, 0, 0),
        "nothing was held or cancelled: {stats:?}"
    );
    assert_eq!(candidate(&su, card).await.status, "done");
}

// ---------------------------------------------------------------------------
// AC 23 — a mixed candidate
// ---------------------------------------------------------------------------

/// A message that names two people: one with no signal (goes now), one with an active desktop (held).
/// The held one goes once, later; the first is **not** sent again by the re-judgment (the dispatch
/// log's unique claim skips it).
///
/// Sabotage: judge the whole candidate by its first target (the inactive person is held too, or the
/// active one is sent too early); let the second pass send without `claim_dispatch` (the first
/// person is pushed twice).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_inactive_target_is_sent_now_and_the_active_one_once_later() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, "public", &["ann", "ina", "act"]).await;
    let relay = Relay::accepting();

    beat(&su, &room, "act", 0.0).await;
    let message = say(&su, &room, "ann", &["ina", "act"]).await;

    let first = drain(&su, &[room.ws], config(), &relay).await;
    assert_eq!(
        (first.dispatched, first.deferred),
        (1, 1),
        "ina goes now, act waits: {first:?}"
    );
    assert_eq!(room.heard(&relay.sent(), message), strings(&["ina:ios"]));

    let_time_pass(&su, message, 61.0).await;
    beat(&su, &room, "act", 0.0).await;
    let second = drain(&su, &[room.ws], config(), &relay).await;
    assert_eq!(
        (
            second.dispatched,
            second.skipped_already_settled,
            second.deferred
        ),
        (1, 1, 0),
        "act goes; ina is recognised as already sent: {second:?}"
    );
    assert_eq!(
        room.heard(&relay.sent(), message),
        strings(&["act:ios", "ina:ios"]),
        "each person exactly once across both passes"
    );
    assert_eq!(dispatch_rows(&su, message).await, 2);
    assert_eq!(candidate(&su, message).await.status, "done");
}

// ---------------------------------------------------------------------------
// AC 21 / AC 24 — the retry budget
// ---------------------------------------------------------------------------

/// Two people with delays 60 and 300 hold one candidate **twice**; the third look sends the second
/// person, and the relay answers `429` (a retry-tier push). With `NOTIFIER_MAX_ATTEMPTS = 2` the
/// candidate must still be `pending` (requeued with backoff): the two deferrals did not spend the
/// budget.
///
/// Sabotage: remove `attempts = GREATEST(attempts - 1, 0)` from `defer_push_candidate` — the third
/// claim finds `attempts = 3 >= 2` and parks the candidate as `failed`.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn deferring_twice_does_not_spend_the_retry_budget() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, "public", &["ann", "r60", "r300"]).await;
    let relay = Relay::accepting();
    let budget = PushConfig {
        max_attempts: 2,
        ..PushConfig::for_target()
    };

    set_delay(&su, &room, "r60", 60).await;
    set_delay(&su, &room, "r300", 300).await;
    beat(&su, &room, "r60", 0.0).await;
    beat(&su, &room, "r300", 0.0).await;
    let message = say(&su, &room, "ann", &["r60", "r300"]).await;

    // Pass 1: both held until the earlier expiry.
    let one = drain(&su, &[room.ws], budget.clone(), &relay).await;
    assert_eq!(
        (one.dispatched, one.deferred, one.activity_held),
        (0, 1, 2),
        "{one:?}"
    );
    let after_one = candidate(&su, message).await;
    assert_eq!(
        (after_one.status.as_str(), after_one.attempts),
        ("pending", 0)
    );
    assert!(
        (after_one.hold_secs - 60.0).abs() < 0.01,
        "{}",
        after_one.hold_secs
    );

    // Pass 2 (61 s on): r60 goes, r300 is held again until T + 300.
    let_time_pass(&su, message, 61.0).await;
    beat(&su, &room, "r60", 0.0).await;
    beat(&su, &room, "r300", 0.0).await;
    let two = drain(&su, &[room.ws], budget.clone(), &relay).await;
    assert_eq!(
        (two.dispatched, two.deferred, two.activity_held),
        (1, 1, 1),
        "{two:?}"
    );
    let after_two = candidate(&su, message).await;
    assert_eq!(
        (after_two.status.as_str(), after_two.attempts),
        ("pending", 0)
    );
    assert!(
        (after_two.hold_secs - 300.0).abs() < 0.01,
        "{}",
        after_two.hold_secs
    );

    // Pass 3 (past T + 300): r300 is due and the relay says 429 for them.
    let_time_pass(&su, message, 301.0).await;
    beat(&su, &room, "r300", 0.0).await;
    for device in &room.device_ids["r300"] {
        relay.limit(*device);
    }
    let three = drain(&su, &[room.ws], budget, &relay).await;
    assert_eq!(
        three.requeued, 1,
        "the 429 requeues the candidate: {three:?}"
    );
    assert_eq!(three.failed, 0, "and does not fail it: {three:?}");
    let after_three = candidate(&su, message).await;
    assert_eq!(
        (after_three.status.as_str(), after_three.attempts),
        ("pending", 1),
        "still alive: the deferrals gave their attempts back"
    );
    assert_eq!(relay.refused().len(), 1, "the 429 was r300's");
}

/// A candidate with a held target **and** a retry-tier transient error (a relay `429`) is requeued
/// with the ordinary backoff, not deferred: `defer` would hide the failure. The next look judges the
/// held target again on its own clock.
///
/// Sabotage: let `defer_candidate` run before the `transient` check — the candidate waits for the
/// hold instead of the backoff (its `available_at` is T + 300, not about now + 2 s) and the retry
/// is lost.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_retry_wins_over_a_deferral_in_the_same_candidate() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, "public", &["ann", "ina", "act"]).await;
    let relay = Relay::accepting();

    set_delay(&su, &room, "act", 300).await;
    beat(&su, &room, "act", 0.0).await;
    let message = say(&su, &room, "ann", &["ina", "act"]).await;
    for device in &room.device_ids["ina"] {
        relay.limit(*device);
    }

    let stats = drain(&su, &[room.ws], config(), &relay).await;
    assert_eq!(
        (stats.requeued, stats.deferred, stats.activity_held),
        (1, 0, 1),
        "ina's 429 is a retry, act's hold is not a deferral of its own: {stats:?}"
    );
    let waiting = sqlx::query(
        "SELECT status::text AS status, \
                EXTRACT(EPOCH FROM (available_at - now()))::float8 AS wait_secs \
           FROM outbox WHERE kind = 'push_candidate' AND payload->>'message_id' = $1",
    )
    .bind(message.to_string())
    .fetch_one(&su)
    .await
    .expect("read the candidate");
    assert_eq!(waiting.get::<String, _>("status"), "pending");
    let wait: f64 = waiting.get("wait_secs");
    assert!(
        wait < 30.0,
        "the backoff is seconds, not the 300 s hold: waits {wait} s"
    );

    // The relay recovers; the next look sends ina and, act still being inside the delay, holds act.
    relay.unlimit_all();
    wake_candidate(&su, message).await;
    let next = drain(&su, &[room.ws], config(), &relay).await;
    assert_eq!((next.dispatched, next.deferred), (1, 1), "{next:?}");
    assert_eq!(room.heard(&relay.sent(), message), strings(&["ina:ios"]));
}

// ---------------------------------------------------------------------------
// fail-open, tenants
// ---------------------------------------------------------------------------

/// If the tail cannot read its facts the push is **sent**, not lost: the notifier role loses its
/// `SELECT` on `member_activity` (what a missing grant in production looks like) and an active
/// person's DM goes out at once, as before the delay existed. The same fact is the reason the
/// grant itself is pinned by `prod_role_conformance_pg` — this behaviour hides the failure from the
/// user, so only a test on the grant can see it.
///
/// Sabotage: return the tail's error instead of `Refined::untouched` — the candidate is requeued
/// and nothing is sent.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_failed_look_at_the_clock_sends_instead_of_losing_the_push() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, "dm", &["ann", "bob"]).await;
    let relay = Relay::accepting();

    beat(&su, &room, "bob", 0.0).await;
    let dm = say(&su, &room, "ann", &[]).await;

    sqlx::query("REVOKE ALL ON TABLE member_activity FROM momo_notifier")
        .execute(&su)
        .await
        .expect("take the notifier's grant away");
    let stats = drain(&su, &[room.ws], config(), &relay).await;
    // Put it back first, so a failed assertion does not poison the next test.
    sqlx::query("GRANT SELECT ON TABLE member_activity TO momo_notifier")
        .execute(&su)
        .await
        .expect("give the notifier's grant back");

    assert_eq!(
        room.heard(&relay.sent(), dm),
        strings(&["bob:ios"]),
        "a tail that cannot read sends without the delay: {stats:?}"
    );
    assert_eq!(
        (stats.deferred, stats.requeued, stats.failed),
        (0, 0, 0),
        "{stats:?}"
    );
    assert_eq!(candidate(&su, dm).await.status, "done");
}

/// Two workspaces in one drain: the person with an active desktop in one has their push held; an
/// identical DM in the other (no signal) goes at once. One workspace's stamps never hold another's
/// push.
///
/// Sabotage: read `member_activity` without the `workspace_id` predicate **and** key it by something
/// shared (the tail is explicit about the workspace because the notifier is BYPASSRLS; this pins the
/// behaviour, and the predicate is named in every read of `refine.rs`).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn two_workspaces_are_judged_apart() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let active = seed_room(&su, "dm", &["ann", "bob"]).await;
    let idle = seed_room(&su, "dm", &["ann", "bob"]).await;
    let relay = Relay::accepting();

    beat(&su, &active, "bob", 0.0).await;
    let held = say(&su, &active, "ann", &[]).await;
    let now = say(&su, &idle, "ann", &[]).await;

    let stats = drain(&su, &[active.ws, idle.ws], config(), &relay).await;
    assert_eq!(
        (stats.dispatched, stats.deferred),
        (1, 1),
        "one goes, one waits: {stats:?}"
    );
    assert!(relay
        .sent()
        .iter()
        .all(|d| d.workspace_id == idle.ws.to_string()));
    assert_eq!(idle.heard(&relay.sent(), now), strings(&["bob:ios"]));
    assert!(active.heard(&relay.sent(), held).is_empty());
}
