//! DB-backed conformance for the **per-kind phone switches** — ADR-0206 D5 and 수용 기준 27
//! (#4494 N3). The push judgment tags every target with a notification kind and reads the member's
//! `notification_rule.kinds` as part of the arm conditions.
//!
//! Every test proves one rule with a named assertion that goes red when the rule is reverted (the
//! sabotage that turns it red is in the table below; the handoff lists the measured REDs). All are
//! `#[ignore]`: they need a `pgvector/pgvector:pg18` superuser DB plus the runtime roles.
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26917/s8_4494 \
//!   cargo test -p momo-notifier --test notification_kinds_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! Harness contract (the same as `push_conformance_pg`): `DATABASE_URL` is a **superuser** that
//! applies the migrations and seeds the fixtures past RLS; the judgment runs as the BYPASSRLS
//! `momo_notifier`, the credential that serves every tenant. Messages are inserted by hand, so the
//! shapes the judgment reads (`props.mention_member_ids`, `reply_to_id`, `run_id`, `root_id`, a
//! card's `approval` row) are exactly what each test says.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `no_row_and_an_unreadable_switch_are_today_and_the_desktop_cell_is_not_the_phone` | read `kinds` as "on only if literally true" (`= 'true'::jsonb`), or let the `desktop` cell switch the phone push |
//! | `a_switched_off_kind_is_silent_and_every_other_kind_is_not` | drop the kind's `nr0.kinds->'<kind>'->'phone'` condition from its arm, or read another kind's cell |
//! | `a_shape_arm_that_is_switched_off_is_silent_and_never_revives_as_another_reason` | move a shape arm's switch from the inner `CASE` to the outer `WHEN` (the DM-channel approval card comes back as a `dm` push; `dm` off lets the agent's answer back in) |
//! | `a_why_arm_that_is_switched_off_falls_through_to_the_next_arm` | move a why-arm's switch from the outer `WHEN` into the inner `CASE` (nothing is left to fall to) |
//! | `the_mention_exception_still_covers_the_three_mention_arms` | restrict the mute clause to `arm = 'mentionHuman'` |
//! | `one_members_switches_never_reach_another_member` | drop `nr0.member_id = ms.member_id` from the join |
//! | `a_rule_row_of_another_workspace_is_not_read_by_this_workspaces_judgment` | drop `nr0.workspace_id = $1` from the join (the notifier is BYPASSRLS: that predicate is the tenant fence) |
//! | `end_to_end_a_switched_off_kind_dispatches_nothing` | stop tagging the arm (the kind is the thing the switch reads) |

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::PgPool;
use momo_messaging::NotificationKind;
use momo_notifier::{PushConfig, PushDrain};
use momo_push::{
    judge_candidate_targets, judge_targets, DispatchOutcome, JudgedTarget, PushCandidate,
    PushDispatch, PushDispatcher, PushReason,
};
use serde_json::{json, Value};
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

/// The BYPASSRLS notifier credential: the role that runs the production judgment.
async fn momo_notifier_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let password = std::env::var("MOMO_NOTIFIER_PASSWORD")
        .unwrap_or_else(|_| "momo_notifier_dev_pw".to_string());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_notifier").password(&password))
        .await
        .expect("connect as momo_notifier (run bootstrap_roles.sql first)")
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
          WHERE kind = 'push_candidate' AND status = 'pending' \
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

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/// One workspace: `alice` (the sender), `bob` and `carol` (humans with one device each), `bot` (an
/// agent bob owns), a public channel with all four and a DM between bob and the bot.
struct World {
    ws: Uuid,
    alice: Uuid,
    bob: Uuid,
    carol: Uuid,
    bot: Uuid,
    public: Uuid,
    dm: Uuid,
    seq: AtomicI64,
}

async fn seed_member(su: &PgPool, ws: Uuid, kind: &str, handle: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
         VALUES ($1, $2, $3::member_kind, 'active', $4, $4)",
    )
    .bind(id)
    .bind(ws)
    .bind(kind)
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

async fn seed_channel(su: &PgPool, ws: Uuid, kind: &str, members: &[Uuid]) -> Uuid {
    let id = Uuid::new_v4();
    // `channel_dm_key_required_ck`: a dm channel carries its participant-set key.
    let dm_key = (kind == "dm").then(|| id.simple().to_string());
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name, dm_key) VALUES ($1, $2, $3::channel_kind, $4, $5)")
        .bind(id)
        .bind(ws)
        .bind(kind)
        .bind(format!("ch-{}", &id.simple().to_string()[..8]))
        .bind(dm_key)
        .execute(su)
        .await
        .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(id)
        .bind(ws)
        .execute(su)
        .await
        .expect("seed channel_seq");
    for member in members {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(ws)
        .bind(id)
        .bind(member)
        .execute(su)
        .await
        .expect("seed channel membership");
    }
    id
}

async fn seed_world(su: &PgPool) -> World {
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(ws)
        .bind(ws.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    let alice = seed_member(su, ws, "human", "alice").await;
    let bob = seed_member(su, ws, "human", "bob").await;
    let carol = seed_member(su, ws, "human", "carol").await;
    let bot = seed_member(su, ws, "agent", "bot").await;
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, \
                            max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
    )
    .bind(bot)
    .bind(ws)
    .bind(bob)
    .execute(su)
    .await
    .expect("seed agent");
    for human in [bob, carol] {
        seed_device(su, ws, human).await;
    }
    let public = seed_channel(su, ws, "public", &[alice, bob, carol, bot]).await;
    let dm = seed_channel(su, ws, "dm", &[bob, bot]).await;
    World {
        ws,
        alice,
        bob,
        carol,
        bot,
        public,
        dm,
        seq: AtomicI64::new(1),
    }
}

/// One message to insert. Inserting fires the 011 trigger, which enqueues the push candidate.
struct Line {
    channel: Uuid,
    author: Uuid,
    message_type: &'static str,
    props: Value,
    root: Option<Uuid>,
    reply_to: Option<Uuid>,
    run: Option<Uuid>,
}

impl Line {
    fn text(channel: Uuid, author: Uuid) -> Line {
        Line {
            channel,
            author,
            message_type: "text",
            props: json!({}),
            root: None,
            reply_to: None,
            run: None,
        }
    }

    fn mentioning(mut self, member: Uuid) -> Line {
        self.props = json!({"mention_member_ids": [member.to_string()]});
        self
    }
}

async fn insert(su: &PgPool, world: &World, line: Line) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, \
            props, root_id, reply_to_id, run_id) \
         VALUES ($1, $2, $3, $3, 0, $4, $5::message_type, 'a line', $6, $7, $8, $9) \
         RETURNING id",
    )
    .bind(world.ws)
    .bind(line.channel)
    .bind(world.seq.fetch_add(1, Ordering::SeqCst))
    .bind(line.author)
    .bind(line.message_type)
    .bind(&line.props)
    .bind(line.root)
    .bind(line.reply_to)
    .bind(line.run)
    .fetch_one(su)
    .await
    .expect("insert message (fires push_candidate_enqueue_trg)")
}

async fn seed_run(su: &PgPool, world: &World, channel: Uuid, status: &str) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key) \
         VALUES ($1, $2, $3, $4, $5::run_status, $6, $7)",
    )
    .bind(run)
    .bind(world.ws)
    .bind(world.bot)
    .bind(channel)
    .bind(status)
    .bind(json!({"type": "chat"}))
    .bind(format!("kinds:{run}"))
    .execute(su)
    .await
    .expect("seed agent run");
    run
}

/// The agent's answer to `question`, the way the worker writes a run's closing line: quoting the
/// request, belonging to a run.
async fn agent_answer(su: &PgPool, world: &World, channel: Uuid, question: Uuid) -> Uuid {
    let run = seed_run(su, world, channel, "succeeded").await;
    let mut line = Line::text(channel, world.bot);
    line.reply_to = Some(question);
    line.run = Some(run);
    insert(su, world, line).await
}

/// An approval card of the catalog's `work.session.end` tool (any member of the room may decide it)
/// and the `approval` row it renders.
async fn approval_card(su: &PgPool, world: &World, channel: Uuid) -> Uuid {
    let run = seed_run(su, world, channel, "awaiting_approval").await;
    let approval = Uuid::new_v4();
    let mut line = Line::text(channel, world.bot);
    line.message_type = "approval_request";
    line.props = json!({"approval_id": approval.to_string(), "action_type": "tool_call"});
    let message = insert(su, world, line).await;
    sqlx::query(
        "INSERT INTO approval \
           (id, workspace_id, run_id, channel_id, request_message_id, requested_by, \
            action_type, payload, status, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, 'tool_call', $7, 'pending', now() + interval '1 hour')",
    )
    .bind(approval)
    .bind(world.ws)
    .bind(run)
    .bind(channel)
    .bind(message)
    .bind(world.bot)
    .bind(json!({"tool_call": {"call_id": "c1", "name": "work.session.end"}}))
    .execute(su)
    .await
    .expect("seed approval");
    message
}

async fn follow(su: &PgPool, world: &World, root: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO thread_follow (workspace_id, channel_id, root_id, member_id, state) \
         VALUES ($1, $2, $3, $4, 'followed')",
    )
    .bind(world.ws)
    .bind(world.public)
    .bind(root)
    .bind(member)
    .execute(su)
    .await
    .expect("seed thread follow");
}

/// The member's stored switches. `None` is SQL NULL (a row that names nothing).
async fn set_kinds(su: &PgPool, world: &World, member: Uuid, kinds: Option<Value>) {
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, kinds) VALUES ($1, $2, $3) \
         ON CONFLICT (workspace_id, member_id) DO UPDATE SET kinds = EXCLUDED.kinds",
    )
    .bind(world.ws)
    .bind(member)
    .bind(kinds)
    .execute(su)
    .await
    .expect("set kinds");
}

/// One kind's phone cell off, everything else untouched.
fn off(kinds: &[NotificationKind]) -> Value {
    let mut map = serde_json::Map::new();
    for kind in kinds {
        map.insert(kind.as_str().to_string(), json!({"phone": false}));
    }
    Value::Object(map)
}

type Heard = Option<(PushReason, Option<NotificationKind>)>;

/// What the judgment says `member` hears for `message` (one device each, so at most one target).
async fn judged(pool: &PgPool, world: &World, message: Uuid, member: Uuid) -> Heard {
    let mut conn = pool.acquire().await.expect("acquire notifier connection");
    let targets: Vec<JudgedTarget> = judge_targets(&mut conn, world.ws, message)
        .await
        .expect("judge targets");
    let mine: Vec<_> = targets
        .iter()
        .filter(|target| target.member_id == member)
        .collect();
    assert!(mine.len() <= 1, "one device each, one target: {mine:?}");
    mine.first().map(|target| (target.reason, target.kind))
}

/// The six shapes `bob` can be judged on in the public channel, keyed by the kind they carry.
struct Shapes {
    by_kind: BTreeMap<NotificationKind, (Uuid, PushReason)>,
}

async fn seed_shapes(su: &PgPool, world: &World) -> Shapes {
    let mut by_kind = BTreeMap::new();

    // dm — the agent says something in its DM with bob.
    let dm = insert(su, world, Line::text(world.dm, world.bot)).await;
    by_kind.insert(NotificationKind::Dm, (dm, PushReason::Dm));

    // mentionHuman / mentionAgent — a person and the agent each name bob in the public channel.
    let human = insert(
        su,
        world,
        Line::text(world.public, world.alice).mentioning(world.bob),
    )
    .await;
    by_kind.insert(NotificationKind::MentionHuman, (human, PushReason::Mention));
    let agent = insert(
        su,
        world,
        Line::text(world.public, world.bot).mentioning(world.bob),
    )
    .await;
    by_kind.insert(NotificationKind::MentionAgent, (agent, PushReason::Mention));

    // agentAnswer — bob asked, the agent's run answered (no mention, so the asker arm is the only way in).
    let question = insert(su, world, Line::text(world.public, world.bob)).await;
    let answer = agent_answer(su, world, world.public, question).await;
    by_kind.insert(NotificationKind::AgentAnswer, (answer, PushReason::Mention));

    // approval — a pending card bob may decide.
    let card = approval_card(su, world, world.public).await;
    by_kind.insert(
        NotificationKind::Approval,
        (card, PushReason::ApprovalRequest),
    );

    // threadReply — carol's thread, followed by bob, and alice replies.
    let root = insert(su, world, Line::text(world.public, world.carol)).await;
    follow(su, world, root, world.bob).await;
    let mut reply = Line::text(world.public, world.alice);
    reply.root = Some(root);
    let reply = insert(su, world, reply).await;
    by_kind.insert(
        NotificationKind::ThreadReply,
        (reply, PushReason::ThreadReply),
    );

    Shapes { by_kind }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// 행 부재 = 오늘 (ADR-0206 I5) and the one rule of the switch: **only a literal JSON `false` is
/// off**. A member with no row, a row whose `kinds` is NULL, and a `kinds` that is garbage all hear
/// every shape as before; so does a member who turned off only the *desktop* cell.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn no_row_and_an_unreadable_switch_are_today_and_the_desktop_cell_is_not_the_phone() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_notifier_pool().await;
    let world = seed_world(&su).await;
    let shapes = seed_shapes(&su, &world).await;

    let expected = |kind: NotificationKind| {
        let (_, reason) = shapes.by_kind[&kind];
        Some((reason, Some(kind)))
    };

    // No row at all.
    for (kind, (message, _)) in &shapes.by_kind {
        assert_eq!(
            judged(&pool, &world, *message, world.bob).await,
            expected(*kind),
            "no row: {kind:?}"
        );
    }

    // A row, and values the reader must not mistake for "off".
    let unreadable: [Option<Value>; 9] = [
        None,
        Some(json!("oops")),
        Some(json!([])),
        Some(json!({"dm": "off"})),
        Some(json!({"dm": {"phone": "no"}})),
        Some(json!({"dm": {"phone": null}})),
        Some(json!({"dm": {"phone": 0}})),
        Some(json!({"bogusKind": {"phone": false}})),
        // The desktop cell is the desktop's: it never reaches a phone push.
        Some(json!({
            "dm": {"desktop": false}, "mentionHuman": {"desktop": false},
            "approval": {"desktop": false}, "threadReply": {"desktop": false},
        })),
    ];
    for kinds in unreadable {
        set_kinds(&su, &world, world.bob, kinds.clone()).await;
        for (kind, (message, _)) in &shapes.by_kind {
            assert_eq!(
                judged(&pool, &world, *message, world.bob).await,
                expected(*kind),
                "kinds = {kinds:?}: {kind:?}"
            );
        }
    }
}

/// AC 27 (the six kinds that have an arm today; `workDone` is `work_complete_push`, covered by the
/// API test and `push_conformance_pg`): turning a kind's phone switch off silences that kind and
/// **only** that kind — each of the other five shapes is still heard.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_switched_off_kind_is_silent_and_every_other_kind_is_not() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_notifier_pool().await;
    let world = seed_world(&su).await;
    let shapes = seed_shapes(&su, &world).await;
    assert_eq!(shapes.by_kind.len(), 6, "six kinds have an arm today");

    for switched_off in shapes.by_kind.keys().copied() {
        set_kinds(&su, &world, world.bob, Some(off(&[switched_off]))).await;
        for (kind, (message, reason)) in &shapes.by_kind {
            let heard = judged(&pool, &world, *message, world.bob).await;
            if *kind == switched_off {
                assert_eq!(
                    heard, None,
                    "{switched_off:?} is off but its shape is heard"
                );
            } else {
                assert_eq!(
                    heard,
                    Some((*reason, Some(*kind))),
                    "{switched_off:?} is off: {kind:?} must still be heard"
                );
            }
        }
    }
}

/// D5 / AC 27: an arm about the message's **shape** claims the message whether or not its switch is
/// on, so an off switch is silence — it never revives as a weaker reason. In an agent's DM:
/// the approval card does not come back as a `dm`, and `dm` off silences the agent's answer too
/// (the answer arm sits below the DM arm and must not be reached).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_shape_arm_that_is_switched_off_is_silent_and_never_revives_as_another_reason() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_notifier_pool().await;
    let world = seed_world(&su).await;

    // The approval card, in the DM.
    let card = approval_card(&su, &world, world.dm).await;
    // The agent's answer to bob's own question, in the DM.
    let question = insert(&su, &world, Line::text(world.dm, world.bob)).await;
    let answer = agent_answer(&su, &world, world.dm, question).await;

    let approval = Some((
        PushReason::ApprovalRequest,
        Some(NotificationKind::Approval),
    ));
    let dm = Some((PushReason::Dm, Some(NotificationKind::Dm)));
    // Baseline: the card is an approval and the answer is a `dm` (the DM arm answers first).
    assert_eq!(judged(&pool, &world, card, world.bob).await, approval);
    assert_eq!(judged(&pool, &world, answer, world.bob).await, dm);

    // approval off: the card is silent — not a `dm` push of the same card.
    set_kinds(
        &su,
        &world,
        world.bob,
        Some(off(&[NotificationKind::Approval])),
    )
    .await;
    assert_eq!(
        judged(&pool, &world, card, world.bob).await,
        None,
        "an approval card in a DM must not come back as a `dm` push"
    );
    assert_eq!(judged(&pool, &world, answer, world.bob).await, dm);

    // dm off: the agent's answer is silent — not an `agentAnswer` push — and the card is an approval again.
    set_kinds(&su, &world, world.bob, Some(off(&[NotificationKind::Dm]))).await;
    assert_eq!(
        judged(&pool, &world, answer, world.bob).await,
        None,
        "`dm` off silences the agent's answer in that DM too"
    );
    assert_eq!(judged(&pool, &world, card, world.bob).await, approval);

    // Both off: the card is not a `dm` either.
    set_kinds(
        &su,
        &world,
        world.bob,
        Some(off(&[NotificationKind::Approval, NotificationKind::Dm])),
    )
    .await;
    assert_eq!(judged(&pool, &world, card, world.bob).await, None);
}

/// D5: an arm about **why this person** — a mention by a person or by an agent, an agent's answer —
/// falls through to the next arm when its switch is off, so a message that stands on two reasons is
/// still heard on the other one; with nothing left to fall to it is silent.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_why_arm_that_is_switched_off_falls_through_to_the_next_arm() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_notifier_pool().await;
    let world = seed_world(&su).await;

    let thread_reply = Some((PushReason::ThreadReply, Some(NotificationKind::ThreadReply)));
    let dm = Some((PushReason::Dm, Some(NotificationKind::Dm)));

    // (1) In the DM the agent names bob: `mentionAgent` off falls to the DM arm; both off is silent.
    let mention_in_dm = insert(
        &su,
        &world,
        Line::text(world.dm, world.bot).mentioning(world.bob),
    )
    .await;
    assert_eq!(
        judged(&pool, &world, mention_in_dm, world.bob).await,
        Some((PushReason::Mention, Some(NotificationKind::MentionAgent)))
    );
    set_kinds(
        &su,
        &world,
        world.bob,
        Some(off(&[NotificationKind::MentionAgent])),
    )
    .await;
    assert_eq!(judged(&pool, &world, mention_in_dm, world.bob).await, dm);
    set_kinds(
        &su,
        &world,
        world.bob,
        Some(off(&[NotificationKind::MentionAgent, NotificationKind::Dm])),
    )
    .await;
    assert_eq!(judged(&pool, &world, mention_in_dm, world.bob).await, None);

    // (2) Bob follows a thread and alice names him in a reply there: `mentionHuman` off falls to
    // `threadReply`; with that off too, silence.
    let root = insert(&su, &world, Line::text(world.public, world.carol)).await;
    follow(&su, &world, root, world.bob).await;
    let mut reply = Line::text(world.public, world.alice).mentioning(world.bob);
    reply.root = Some(root);
    let named_reply = insert(&su, &world, reply).await;
    set_kinds(&su, &world, world.bob, None).await;
    assert_eq!(
        judged(&pool, &world, named_reply, world.bob).await,
        Some((PushReason::Mention, Some(NotificationKind::MentionHuman)))
    );
    set_kinds(
        &su,
        &world,
        world.bob,
        Some(off(&[NotificationKind::MentionHuman])),
    )
    .await;
    assert_eq!(
        judged(&pool, &world, named_reply, world.bob).await,
        thread_reply
    );
    set_kinds(
        &su,
        &world,
        world.bob,
        Some(off(&[
            NotificationKind::MentionHuman,
            NotificationKind::ThreadReply,
        ])),
    )
    .await;
    assert_eq!(judged(&pool, &world, named_reply, world.bob).await, None);

    // (3) The agent answers bob inside the followed thread: `agentAnswer` off falls to `threadReply`.
    let question = {
        let mut line = Line::text(world.public, world.bob);
        line.root = Some(root);
        insert(&su, &world, line).await
    };
    let run = seed_run(&su, &world, world.public, "succeeded").await;
    let mut line = Line::text(world.public, world.bot);
    line.root = Some(root);
    line.reply_to = Some(question);
    line.run = Some(run);
    let thread_answer = insert(&su, &world, line).await;
    set_kinds(&su, &world, world.bob, None).await;
    assert_eq!(
        judged(&pool, &world, thread_answer, world.bob).await,
        Some((PushReason::Mention, Some(NotificationKind::AgentAnswer)))
    );
    set_kinds(
        &su,
        &world,
        world.bob,
        Some(off(&[NotificationKind::AgentAnswer])),
    )
    .await;
    assert_eq!(
        judged(&pool, &world, thread_answer, world.bob).await,
        thread_reply
    );
}

/// The mention exception (`mention_overrides_mute`) is a property of the **wire reason** `mention`,
/// which three arms share: all three still pass a muted channel, and none of the others does.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn the_mention_exception_still_covers_the_three_mention_arms() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_notifier_pool().await;
    let world = seed_world(&su).await;
    let shapes = seed_shapes(&su, &world).await;

    sqlx::query(
        "INSERT INTO notification_pref (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
    )
    .bind(world.ws)
    .bind(world.public)
    .bind(world.bob)
    .execute(&su)
    .await
    .expect("mute the public channel for bob");

    let mention_kinds = [
        NotificationKind::MentionHuman,
        NotificationKind::MentionAgent,
        NotificationKind::AgentAnswer,
    ];
    for exception in [false, true] {
        sqlx::query(
            "INSERT INTO notification_rule (workspace_id, member_id, mention_overrides_mute) \
             VALUES ($1, $2, $3) \
             ON CONFLICT (workspace_id, member_id) \
             DO UPDATE SET mention_overrides_mute = EXCLUDED.mention_overrides_mute",
        )
        .bind(world.ws)
        .bind(world.bob)
        .bind(exception)
        .execute(&su)
        .await
        .expect("set the mention exception");
        for (kind, (message, reason)) in &shapes.by_kind {
            // The DM is not in the muted channel; every public-channel shape is.
            if *kind == NotificationKind::Dm {
                continue;
            }
            let heard = judged(&pool, &world, *message, world.bob).await;
            if exception && mention_kinds.contains(kind) {
                assert_eq!(
                    heard,
                    Some((*reason, Some(*kind))),
                    "{kind:?} passes the mute"
                );
            } else {
                assert_eq!(heard, None, "exception={exception}: {kind:?} stays muted");
            }
        }
    }
}

/// A switch is the member's own: bob turning `mentionHuman` off never changes what carol hears.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn one_members_switches_never_reach_another_member() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_notifier_pool().await;
    let world = seed_world(&su).await;

    // alice names both bob and carol.
    let mut line = Line::text(world.public, world.alice);
    line.props = json!({"mention_member_ids": [world.bob.to_string(), world.carol.to_string()]});
    let message = insert(&su, &world, line).await;
    let heard = Some((PushReason::Mention, Some(NotificationKind::MentionHuman)));

    set_kinds(
        &su,
        &world,
        world.bob,
        Some(off(&[NotificationKind::MentionHuman])),
    )
    .await;
    assert_eq!(judged(&pool, &world, message, world.bob).await, None);
    assert_eq!(judged(&pool, &world, message, world.carol).await, heard);

    set_kinds(&su, &world, world.bob, None).await;
    set_kinds(
        &su,
        &world,
        world.carol,
        Some(off(&[NotificationKind::MentionHuman])),
    )
    .await;
    assert_eq!(judged(&pool, &world, message, world.bob).await, heard);
    assert_eq!(judged(&pool, &world, message, world.carol).await, None);
}

/// End to end through the notifier's own drain: with the switch on the DM is dispatched once on
/// reason `dm`; with `dm` off nothing is dispatched and the candidate is still finished (a switched-off
/// kind is silence, not a stuck row).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn end_to_end_a_switched_off_kind_dispatches_nothing() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_notifier_pool().await;
    let world = seed_world(&su).await;

    let drain = |su: PgPool, pool: PgPool, ws: Uuid| async move {
        focus_candidates(&su, &[ws]).await;
        let relay = Arc::new(RecordingDispatcher {
            sent: Arc::new(Mutex::new(Vec::new())),
        });
        PushDrain::new(pool, PushConfig::for_target(), relay.clone())
            .drain_to_empty(64)
            .await;
        let sent = relay.sent.lock().unwrap().clone();
        sent
    };

    let first = insert(&su, &world, Line::text(world.dm, world.bot)).await;
    let sent = drain(su.clone(), pool.clone(), world.ws).await;
    let reasons: BTreeSet<(String, &str)> = sent
        .iter()
        .map(|dispatch| (dispatch.message_id.clone(), dispatch.reason))
        .collect();
    assert_eq!(
        reasons,
        BTreeSet::from([(first.to_string(), "dm")]),
        "switch on: one dm push"
    );

    set_kinds(&su, &world, world.bob, Some(off(&[NotificationKind::Dm]))).await;
    let second = insert(&su, &world, Line::text(world.dm, world.bot)).await;
    let sent = drain(su.clone(), pool.clone(), world.ws).await;
    assert!(
        sent.iter()
            .all(|dispatch| dispatch.message_id != second.to_string()),
        "switch off: nothing for the second message, got {sent:?}"
    );
    let unfinished: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE workspace_id = $1 AND kind = 'push_candidate' AND status <> 'done'",
    )
    .bind(world.ws)
    .fetch_one(&su)
    .await
    .expect("count unfinished candidates");
    assert_eq!(unfinished, 0, "a silenced candidate is finished, not stuck");
}

/// ADR-0204 증보 6 D6-5 + ADR-0206 증보 3: the notice that goes to the person who **asked** when their
/// approval card was rejected is an `agentAnswer` — a wire `mention`, an outcome the agent reports —
/// and follows that switch. It is not an approval request, so `approval` (the switch of the requests
/// *you* must decide) does not silence it, and it is a shape arm, so an off switch is silence.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn the_settled_approval_notice_is_an_agent_answer_and_follows_that_switch() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_notifier_pool().await;
    let world = seed_world(&su).await;

    // bob asked in the public channel; the agent's run for that request raised a card; alice rejected it.
    let request = insert(&su, &world, Line::text(world.public, world.bob)).await;
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, trigger_message_id, status, input, \
            idempotency_key) \
         VALUES ($1, $2, $3, $4, $5, 'awaiting_approval'::run_status, $6, $7)",
    )
    .bind(run)
    .bind(world.ws)
    .bind(world.bot)
    .bind(world.public)
    .bind(request)
    .bind(json!({"type": "chat"}))
    .bind(format!("kinds-settled:{run}"))
    .execute(&su)
    .await
    .expect("seed the run bob's request raised");
    let approval = Uuid::new_v4();
    let mut card = Line::text(world.public, world.bot);
    card.message_type = "approval_request";
    card.run = Some(run);
    card.props = json!({"approval_id": approval.to_string(), "action_type": "tool_call"});
    let card = insert(&su, &world, card).await;
    sqlx::query(
        "INSERT INTO approval \
           (id, workspace_id, run_id, channel_id, request_message_id, requested_by, \
            action_type, payload, status, decided_by, decided_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, 'tool_call', $7, 'rejected'::approval_status, $8, now(), \
                 now() + interval '1 hour')",
    )
    .bind(approval)
    .bind(world.ws)
    .bind(run)
    .bind(world.public)
    .bind(card)
    .bind(world.bot)
    .bind(json!({"tool_call": {"call_id": "c1", "name": "work.session.end"}}))
    .bind(world.alice)
    .execute(&su)
    .await
    .expect("seed the rejected approval");

    let candidate = PushCandidate {
        message_id: card,
        channel_id: world.public,
        source: Some("approval_settled".to_string()),
    };
    let notice = |member: Uuid| {
        let (pool, candidate) = (pool.clone(), candidate.clone());
        async move {
            let mut conn = pool.acquire().await.expect("acquire notifier connection");
            let targets = judge_candidate_targets(&mut conn, world.ws, &candidate)
                .await
                .expect("judge the settlement candidate");
            targets
                .iter()
                .find(|target| target.member_id == member)
                .map(|target| (target.reason, target.kind))
        }
    };
    let heard = Some((PushReason::Mention, Some(NotificationKind::AgentAnswer)));

    // Baseline: the person who asked hears it, as an agentAnswer; the decider and the others do not.
    set_kinds(&su, &world, world.bob, None).await;
    assert_eq!(notice(world.bob).await, heard);
    assert_eq!(
        notice(world.alice).await,
        None,
        "the decider is not told their own decision"
    );
    assert_eq!(notice(world.carol).await, None, "only the person who asked");

    // `agentAnswer` off silences it — and nothing revives it.
    set_kinds(
        &su,
        &world,
        world.bob,
        Some(off(&[NotificationKind::AgentAnswer])),
    )
    .await;
    assert_eq!(notice(world.bob).await, None);

    // `approval` (the requests you decide) and the mention kinds do not touch it.
    set_kinds(
        &su,
        &world,
        world.bob,
        Some(off(&[
            NotificationKind::Approval,
            NotificationKind::MentionAgent,
            NotificationKind::MentionHuman,
            NotificationKind::Dm,
        ])),
    )
    .await;
    assert_eq!(notice(world.bob).await, heard);
}

/// Two tenants. The judgment runs as a BYPASSRLS role, so the tenant fence of the switch read is the
/// `workspace_id` predicate of its own join, not RLS. `notification_rule`'s keys are two
/// single-column foreign keys, so a row that names this workspace's member under **another**
/// workspace's id is storable (not by the API, whose `WITH CHECK` refuses it; by a superuser or a bug) —
/// and nothing but that predicate keeps it from switching a push off here.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_rule_row_of_another_workspace_is_not_read_by_this_workspaces_judgment() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_notifier_pool().await;
    let world = seed_world(&su).await;
    let elsewhere = seed_world(&su).await;
    let dm = insert(&su, &world, Line::text(world.dm, world.bot)).await;
    let heard = Some((PushReason::Dm, Some(NotificationKind::Dm)));

    // The foreign row: the other workspace's id, this workspace's bob, `dm` off.
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, kinds) VALUES ($1, $2, $3)",
    )
    .bind(elsewhere.ws)
    .bind(world.bob)
    .bind(off(&[NotificationKind::Dm]))
    .execute(&su)
    .await
    .expect("store a rule row under another workspace");
    assert_eq!(
        judged(&pool, &world, dm, world.bob).await,
        heard,
        "another workspace's row must not switch bob's push off"
    );

    // His own workspace's row is the one that counts.
    set_kinds(&su, &world, world.bob, Some(off(&[NotificationKind::Dm]))).await;
    assert_eq!(judged(&pool, &world, dm, world.bob).await, None);
}
