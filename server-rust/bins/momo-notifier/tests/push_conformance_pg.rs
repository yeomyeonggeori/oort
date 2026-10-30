//! DB-backed conformance for the ADR-0120 push-candidate drain (batch P2).
//!
//! These are the orchestrator's docker-gate red tests. Each proves one property
//! of "a committed message wakes the right devices and tells them nothing", with
//! a named assertion that goes red when the enforcement is reverted. They are
//! `#[ignore]` because they need a `pgvector/pgvector:pg18` database plus the
//! runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-notifier --test push_conformance_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract (same as `notifier_conformance_pg`):
//!   * `DATABASE_URL` connects as a **superuser** — applies every migration plus
//!     `infra/rust/sql/bootstrap_roles.sql`, and seeds fixtures bypassing RLS;
//!   * the drain runs as **`momo_notifier`** (BYPASSRLS), the credential that
//!     lets one process serve every tenant;
//!   * the relay is an **injected mock** ([`RecordingDispatcher`]). Nothing in
//!     this suite contacts Apple, and no APNs key exists to contact it with.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `dispatch_carries_ids_only_and_no_conversation_content` | put a body, display name, handle or channel name on the dispatch payload |
//! | `a_redelivered_candidate_is_never_dispatched_twice` | drop the `push_dispatch_log` claim, or settle before sending |
//! | `judgment_never_reaches_another_tenants_devices` | drop a `workspace_id` predicate from the judgment join |
//! | `the_drain_claims_only_push_candidate_rows` | widen the claim's `kind` filter |
//! | `a_muted_channel_suppresses_the_notification` | drop the `notification_pref` join |
//! | `dnd_suppresses_every_reason` (ADR-0124 증보 1) | drop the `notification_rule.dnd` predicate |
//! | `a_mention_exception_delivers_through_a_channel_mute` (증보 1) | drop the `mention_overrides_mute` arm from the mute clause |
//! | `dnd_outranks_a_mention_exception` (증보 1) | move the `dnd` predicate below the mention-exception arm |
//! | `a_timed_pause_suppresses_until_it_expires_then_delivers` (증보 2) | drop the `dnd_until > now()` arm from the `dnd` predicate |
//! | `declared_dnd_pauses_pushes_and_both_lapse_together` (증보 2 「묶어」) | skip the bundle in `set_declared_presence_in_tx`, or engage it without the DND expiry |
//! | `a_transient_relay_failure_requeues_instead_of_dropping` | settle on transient failure |
//! | `work_complete_pushes_the_session_starter_for_a_long_turn` (ADR-0120 부록 A, #3341) | drop the `work_session_idle` arm, or let the arm yield no reason for the starter |
//! | `work_complete_skips_a_turn_shorter_than_a_minute` | drop the `ran_ms >= $3` predicate |
//! | `work_complete_is_for_the_starter_only_never_a_peer_or_a_forged_card` | drop the owner/author/work_session ownership predicates, or let an ineligible idle card fall through to `dm` |
//! | `work_complete_skips_when_the_owner_was_just_reading_the_channel` | drop the `read_state` recency predicate |
//! | `work_complete_is_pushed_once_per_turn` | drop the per-turn `prior` dedupe predicate |
//! | `work_complete_respects_the_members_own_switch` | drop the `work_complete_push` filter |
//! | `a_hosted_work_run_answer_pushes_its_requester_on_the_sixth_reason` (ADR-0162 증보 3 D14, #3517) | drop the `wrun` arm, or the requester join |
//! | `a_hosted_work_run_under_a_minute_or_just_read_is_silent_not_a_dm` | drop the `ran_ms >= $3` / `read_state` predicates in the `work_run_done` arm |
//! | `a_hosted_work_run_push_needs_a_requester_a_hosted_work_run_and_the_agents_own_answer` | drop the audit-requester, `input.type`, hosted-connection, status or author predicates in `wrun` |
//! | `a_hosted_work_run_push_respects_the_work_complete_switch` | drop `work_run_done` from the `work_complete_push` filter |
//! | `an_approval_push_goes_only_to_the_people_who_may_approve_it` (ADR-0204 D7, #3928) | drop the `may_approve_in_tx` narrowing in `judge_targets`, or make `decider_gate` ignore the registry role |
//! | `an_approval_that_must_be_opened_is_the_open_category_and_the_rest_are_inline` | drop an action from `ONE_TIME_SECRET_ACTION_IDS`, stop `opens_in_app` reading `offers_host_choice`, drop the login handoff from `OPEN_IN_APP_TOOL_NAMES` or the avatar test from the profile update (planner 2026-10-17), or drop `tool_call.name` / the avatar marker from the judgment's payload projection |
//! | `an_approval_card_with_no_approval_row_pushes_nobody` | let a card with no `approval` row fall through to a target (the relay would 400 it forever) |
//! | `an_approval_row_of_another_channel_is_not_the_card_of_this_message` | drop `a.channel_id = (SELECT channel_id FROM msg)` from the approval join in `judge_targets` |
//! | `an_approval_card_a_person_may_not_decide_does_not_leak_through_a_dm_or_a_mention` | let the narrowed `approval_request` reason fall back to `dm` / `mention` |
//! | `a_resume_offer_keeps_its_owner_audience_with_no_approval_row` | apply the approval narrowing to reasons other than `approval_request` |
//! | `an_agents_answer_pushes_the_person_who_asked_and_nobody_else` (ADR-0204 D8, #3929) | drop the `asked` arm from the judgment CASE, or let it select anybody but the author of the message the line answers |
//! | `an_answer_is_held_back_while_the_asker_is_reading_the_channel` | drop the `read_state` window from the `asked` arm |
//! | `an_expired_approval_and_a_stalled_run_reach_the_person_who_asked_through_the_real_sweeps` | drop `answers_message_id` from the approval-expiry line (`approval_sweep`) or from the stall notice (`run_stall_sweep`), or stop the judgment reading it |
//! | `a_dm_keeps_its_dm_reason_for_an_agents_answer_and_ignores_the_window` | put the `asked` arm above the `dm` arm |
//! | `agent_lines_that_answer_nobody_stay_silent` | drop the `run_id IS NOT NULL` or `author_kind = 'agent'` conditions, or read `props.trigger_message_id` instead of `answers_message_id` |
//! | `an_answer_to_a_message_elsewhere_or_by_an_agent_pushes_no_one` | drop the same-channel join or the human-recipient filter |
//! | `an_answer_that_mentions_somebody_keeps_the_mention_rules` | apply the window to explicit mentions, or let the `asked` arm outrank them |
//! | `a_work_run_answer_stays_work_run_done_for_its_requester` | move the `asked` arm above the `work_run_done` arm |
//! | `a_streamed_answer_is_pushed_at_its_close_to_an_asker_who_left_during_it` (ADR-0204 증보 1 D8-a, #3987) | stop `stream_message_body_in_tx` enqueueing the close candidate, or read the window at the opening slice (`created_at`), or let the `seq` shortcut stand for a streamed line |
//! | `a_streamed_answer_is_not_pushed_to_an_asker_who_was_moving_their_cursor_just_before_it_closed` | drop the `read_state` window from the streamed branch of the `asked` arm |
//! | `an_asker_who_was_away_from_the_start_gets_one_push_at_the_close_not_two` | stop holding a still-streaming line in the `asked` arm (`NOT streaming`) |
//! | `the_window_is_read_when_the_answer_closes_not_when_it_opened` | read a streamed line's window against `created_at` instead of `now()` |
//! | `a_cursor_that_reached_the_first_words_does_not_stand_for_having_read_the_end` | apply the `last_read_seq >= seq` shortcut to a streamed line |
//! | `a_single_insert_answer_keeps_its_own_creation_time_as_the_window_basis` | read every line's window against `now()` (the single-INSERT paths must keep `created_at` and the `seq` shortcut) |
//! | `a_close_adds_no_second_push_for_a_person_the_opening_already_pushed` | send a second dispatch for the same message (drop the `collapse_id`/dispatch-log arbitration) |
//! | `a_dm_streamed_answer_is_pushed_by_the_dm_arm_at_its_opening_and_not_again_at_its_close` | hold the `dm` arm for a streaming line, or push the DM peer twice |
//! | `a_short_answer_is_pushed_once_when_it_opens_and_closes_before_anyone_judges_it` | judge the opening and the closing candidate as two pushes |
//! | `a_stream_that_was_stopped_or_failed_is_told_like_a_finished_one` | skip the close candidate for a closing write that carries an `outcome` |
//! | `a_streamed_answers_window_is_thirty_seconds_wide_at_the_close` | widen or narrow the streamed branch's window (the 15 s and 45 s askers bracket 30) |
//! | `a_stream_watched_longer_than_the_window_from_a_standing_cursor_is_pushed_without_a_heartbeat` | (the old-client edge, #4018) make a stale cursor alone read as "looking" |
//! | `a_stream_watched_longer_than_the_window_is_not_pushed_while_the_heartbeat_is_fresh` | drop the `channel_viewing` clause from the `asked` arm |
//! | `a_single_insert_answers_heartbeat_window_is_read_around_its_creation_time` | read the heartbeat against `now()` for a non-streamed line, or widen/narrow its 30 s |
//! | `a_stale_heartbeat_or_one_for_another_channel_does_not_keep_the_push_back` | widen the heartbeat window, or drop the channel match from it |
//! | `a_retried_streams_freeze_between_attempts_announces_nothing_and_its_real_close_announces_once` | let a `provisional` freeze enqueue the candidate, or ignore the flag |
//! | `a_candidate_judged_while_a_retried_stream_is_frozen_is_held` | judge a `provisional` freeze as a closed stream (drop `provisional` from the judgment's `streaming`), so a late candidate pushes the half answer and spends the message's push slot |
//! | `a_pause_announced_as_an_end_would_settle_the_push_the_real_answer_needs` | (a control, not a revert) the premise the `provisional` marker rests on: one push per message, so a push of the half answer swallows the finished answer's |
//! | `closing_a_stream_enqueues_exactly_one_candidate_and_only_for_an_open_stream` | enqueue on every final write, on a slice, for a stale final write on an open stream, or for a message that never streamed; change the candidate's `method` / `partition_key` from the trigger's |
//! | `two_final_writes_racing_to_close_one_stream_enqueue_one_candidate` | read the stored props before taking the message's row lock |

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    opening_stream_props, presence_status_for, send_message_in_tx, set_declared_presence_in_tx,
    stream_message_body_in_tx, CustomStatusPatch, MessageType, NewMessage, PresenceStatus,
    StatusPatch, StreamCloseOutcome, StreamEdit, StreamOutcome, STREAM_PROPS_KEY,
};
use momo_notifier::{PushConfig, PushDrain};
use momo_push::{DispatchOutcome, PushDispatch, PushDispatcher};
use serde_json::{json, Value};
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

/// The BYPASSRLS notifier credential (`bootstrap_roles.sql:33`).
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

/// The drain claims globally, so two concurrent tests would eat each other's
/// candidates. Serialize them.
async fn drain_test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

/// Push every push candidate this test does not own out of the claim window.
/// Non-destructive: it only reschedules.
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

// ---------------------------------------------------------------------------
// the injected relay
// ---------------------------------------------------------------------------

/// Records every dispatch and answers with a scripted outcome. This stands where
/// the Dawn-operated PushRelay stands in production — and it is the only thing
/// this suite ever "sends" to.
struct RecordingDispatcher {
    sent: Arc<Mutex<Vec<PushDispatch>>>,
    outcome: Mutex<DispatchOutcome>,
}

impl RecordingDispatcher {
    fn accepting() -> Arc<Self> {
        Arc::new(RecordingDispatcher {
            sent: Arc::new(Mutex::new(Vec::new())),
            outcome: Mutex::new(DispatchOutcome::Accepted {
                apns_status: 200,
                apns_reason: None,
            }),
        })
    }

    fn failing_transiently() -> Arc<Self> {
        Arc::new(RecordingDispatcher {
            sent: Arc::new(Mutex::new(Vec::new())),
            outcome: Mutex::new(DispatchOutcome::TransientFailure("HTTP 503".to_string())),
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
        self.outcome.lock().unwrap().clone()
    }
}

fn drain(pool: &PgPool, dispatcher: Arc<dyn PushDispatcher>) -> PushDrain {
    PushDrain::new(pool.clone(), PushConfig::for_target(), dispatcher)
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/// Content markers that must never appear in a dispatch. Minted per run so a
/// stale row from an earlier run cannot make the assertion pass by accident.
struct Secrets {
    body: String,
    sender_name: String,
    sender_handle: String,
    channel_name: String,
}

impl Secrets {
    fn mint() -> Secrets {
        let tag = Uuid::new_v4().simple().to_string();
        Secrets {
            body: format!("P2BODYSECRET{}", &tag[..12]),
            sender_name: format!("P2NAME{}", &tag[12..20]),
            sender_handle: format!("p2handle{}", &tag[20..28]),
            channel_name: format!("p2chan{}", &tag[..8]),
        }
    }

    fn all(&self) -> [&str; 4] {
        [
            &self.body,
            &self.sender_name,
            &self.sender_handle,
            &self.channel_name,
        ]
    }
}

struct Fixture {
    workspace_id: Uuid,
    author_id: Uuid,
    recipient_id: Uuid,
    channel_id: Uuid,
    token_id: Uuid,
}

/// Seed a DM with an author and one recipient who owns a registered device.
async fn seed_dm_fixture(su: &PgPool, secrets: &Secrets) -> Fixture {
    let workspace_id = Uuid::new_v4();
    let author_id = Uuid::new_v4();
    let recipient_id = Uuid::new_v4();
    let channel_id = Uuid::new_v4();
    let device_id = Uuid::new_v4();

    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace_id)
        .bind(workspace_id.to_string())
        .execute(su)
        .await
        .expect("seed workspace");

    for (member_id, name, handle) in [
        (
            author_id,
            secrets.sender_name.clone(),
            secrets.sender_handle.clone(),
        ),
        (
            recipient_id,
            format!("r{}", recipient_id.simple()),
            format!("r{}", recipient_id.simple()),
        ),
    ] {
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
             VALUES ($1, $2, 'human'::member_kind, 'active', $3, $4)",
        )
        .bind(member_id)
        .bind(workspace_id)
        .bind(name)
        .bind(handle)
        .execute(su)
        .await
        .expect("seed member");
    }

    // `channel_dm_key_required_ck`: a dm channel must carry its participant-set
    // key. The name is deliberately set too — it is one of the content markers
    // that must not reach the relay.
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, dm_key) \
         VALUES ($1, $2, 'dm', $3, $4)",
    )
    .bind(channel_id)
    .bind(workspace_id)
    .bind(&secrets.channel_name)
    .bind(channel_id.simple().to_string())
    .execute(su)
    .await
    .expect("seed dm channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel_id)
        .bind(workspace_id)
        .execute(su)
        .await
        .expect("seed channel_seq");

    for member_id in [author_id, recipient_id] {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(workspace_id)
        .bind(channel_id)
        .bind(member_id)
        .execute(su)
        .await
        .expect("seed channel membership");
    }

    sqlx::query(
        "INSERT INTO device (id, workspace_id, member_id, platform) \
         VALUES ($1, $2, $3, 'ios'::device_platform)",
    )
    .bind(device_id)
    .bind(workspace_id)
    .bind(recipient_id)
    .execute(su)
    .await
    .expect("seed device");

    let token_id: Uuid = sqlx::query_scalar(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, 'kim.dawn.momo.e2e') RETURNING id",
    )
    .bind(workspace_id)
    .bind(device_id)
    .bind(recipient_id)
    .bind(Uuid::new_v4().simple().to_string().repeat(2))
    .fetch_one(su)
    .await
    .expect("seed push token");

    Fixture {
        workspace_id,
        author_id,
        recipient_id,
        channel_id,
        token_id,
    }
}

/// Insert a message, which fires the 011 trigger and enqueues one candidate.
async fn send_message(su: &PgPool, fixture: &Fixture, body: &str, seq: i64) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body) \
         VALUES ($1, $2, $3, $3, 0, $4, 'text', $5) RETURNING id",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.channel_id)
    .bind(seq)
    .bind(fixture.author_id)
    .bind(body)
    .fetch_one(su)
    .await
    .expect("insert message (fires push_candidate_enqueue_trg)")
}

/// Insert a message that mentions `mentioned`, firing the 011 trigger. In the DM
/// fixture this makes the recipient's reason `'mention'` — the judgment `CASE`
/// checks the mention arm before the `dm` arm, so a mention in a DM is a mention.
/// The projection is the same `props.mention_member_ids` the real send path
/// writes; judgment never re-parses the body.
async fn send_mention_message(
    su: &PgPool,
    fixture: &Fixture,
    body: &str,
    seq: i64,
    mentioned: Uuid,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props) \
         VALUES ($1, $2, $3, $3, 0, $4, 'text', $5, \
                 jsonb_build_object('mention_member_ids', jsonb_build_array($6::text))) \
         RETURNING id",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.channel_id)
    .bind(seq)
    .bind(fixture.author_id)
    .bind(body)
    .bind(mentioned.to_string())
    .fetch_one(su)
    .await
    .expect("insert mention message (fires push_candidate_enqueue_trg)")
}

async fn candidate_status(su: &PgPool, workspace_id: Uuid) -> Vec<(String, i32)> {
    sqlx::query(
        "SELECT status::text AS status, attempts FROM outbox \
          WHERE kind = 'push_candidate' AND workspace_id = $1 ORDER BY id",
    )
    .bind(workspace_id)
    .fetch_all(su)
    .await
    .expect("read candidate status")
    .into_iter()
    .map(|row| {
        (
            row.get::<String, _>("status"),
            row.get::<i32, _>("attempts"),
        )
    })
    .collect()
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// **The reason this design exists** (ADR-0120 D2-A): a relay we do not operate
/// must learn nothing about the conversation. This is the runtime twin of
/// `scripts/verify_push_notifier.sh:576-617` and of the crate unit test
/// `dispatch_payload_is_id_only` — but here the payload is produced by the real
/// drain from a real message whose body, sender name, handle and channel name
/// are all known to the test.
///
/// Put any of those on the wire and this goes red.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn dispatch_carries_ids_only_and_no_conversation_content() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let secrets = Secrets::mint();
    let fixture = seed_dm_fixture(&su, &secrets).await;
    focus_candidates(&su, &[fixture.workspace_id]).await;
    let message_id = send_message(&su, &fixture, &secrets.body, 1).await;

    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    let stats = drain(&pool, relay.clone())
        .drain_once(32)
        .await
        .expect("drain");

    assert_eq!(
        stats.claimed, 1,
        "exactly the fixture's candidate was claimed"
    );
    let sent = relay.sent();
    assert_eq!(sent.len(), 1, "the DM notifies its one other member");

    let payload = serde_json::to_value(&sent[0]).expect("serialize dispatch");
    let object = payload.as_object().expect("dispatch is an object");

    let allowed: std::collections::BTreeSet<&str> = [
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
    .collect();
    let actual: std::collections::BTreeSet<&str> = object.keys().map(String::as_str).collect();
    assert_eq!(
        actual, allowed,
        "the id-only field set changed — an ADR-0120 D2 boundary change"
    );

    let rendered = serde_json::to_string(&payload).expect("render dispatch");
    for secret in secrets.all() {
        assert!(
            !rendered.contains(secret),
            "conversation content '{secret}' leaked into a relay-bound payload"
        );
    }

    assert_eq!(
        object["message_id"],
        serde_json::json!(message_id.to_string())
    );
    assert_eq!(object["reason"], serde_json::json!("dm"));
    assert_eq!(object["category"], serde_json::json!("momo.message"));
}

/// At-least-once delivery of candidates must not become at-least-once delivery
/// of notifications. The 011 partial unique index is the arbiter: the second
/// pass finds a settled dispatch row and sends nothing.
///
/// Delete the `push_dispatch_log` claim and this goes red.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_redelivered_candidate_is_never_dispatched_twice() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let secrets = Secrets::mint();
    let fixture = seed_dm_fixture(&su, &secrets).await;
    focus_candidates(&su, &[fixture.workspace_id]).await;
    send_message(&su, &fixture, &secrets.body, 1).await;

    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    let drain = drain(&pool, relay.clone());

    drain.drain_once(32).await.expect("first drain");
    assert_eq!(relay.sent().len(), 1, "first delivery happens");

    // Simulate redelivery: return the settled candidate to pending, exactly as
    // the boot sweep would after a crash.
    sqlx::query(
        "UPDATE outbox SET status = 'pending', available_at = now() \
          WHERE kind = 'push_candidate' AND workspace_id = $1",
    )
    .bind(fixture.workspace_id)
    .execute(&su)
    .await
    .expect("redeliver the candidate");

    let second = drain.drain_once(32).await.expect("second drain");
    assert_eq!(second.claimed, 1, "the candidate really was re-claimed");
    assert_eq!(
        second.skipped_already_settled, 1,
        "the redelivered candidate must recognise its settled dispatch"
    );
    assert_eq!(
        relay.sent().len(),
        1,
        "a redelivered candidate must not send a second notification"
    );

    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM push_dispatch_log WHERE workspace_id = $1 AND collapse_id IS NOT NULL",
    )
    .bind(fixture.workspace_id)
    .fetch_one(&su)
    .await
    .expect("count dispatch log");
    assert_eq!(
        rows, 1,
        "one dispatch-log row per (member, token, collapse_id)"
    );
}

/// RLS is the backstop, but the judgment query carries its own `workspace_id`
/// predicates because the notifier runs as BYPASSRLS. Drop one of them and a
/// message in tenant A can wake a device in tenant B.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn judgment_never_reaches_another_tenants_devices() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;

    let secrets_a = Secrets::mint();
    let secrets_b = Secrets::mint();
    let tenant_a = seed_dm_fixture(&su, &secrets_a).await;
    let tenant_b = seed_dm_fixture(&su, &secrets_b).await;
    focus_candidates(&su, &[tenant_a.workspace_id]).await;

    // Only tenant A sends.
    send_message(&su, &tenant_a, &secrets_a.body, 1).await;

    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    drain(&pool, relay.clone())
        .drain_once(32)
        .await
        .expect("drain");

    let sent = relay.sent();
    assert_eq!(sent.len(), 1, "only tenant A's recipient is notified");
    assert_eq!(
        sent[0].workspace_id,
        tenant_a.workspace_id.to_string(),
        "the dispatch belongs to the sending tenant"
    );

    let b_token = tenant_b.token_id.to_string();
    for dispatch in &sent {
        assert_ne!(
            dispatch.workspace_id,
            tenant_b.workspace_id.to_string(),
            "a message in one tenant reached another tenant's device"
        );
    }
    let leaked: i64 =
        sqlx::query_scalar("SELECT count(*) FROM push_dispatch_log WHERE push_token_id = $1")
            .bind(tenant_b.token_id)
            .fetch_one(&su)
            .await
            .expect("count tenant B dispatches");
    assert_eq!(
        leaked, 0,
        "tenant B's token {b_token} must have no dispatch rows"
    );
}

/// The four outbox consumers partition the table by `(kind, method)`. A drain
/// that widened its filter would silently eat the relay's broadcasts.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn the_drain_claims_only_push_candidate_rows() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let secrets = Secrets::mint();
    let fixture = seed_dm_fixture(&su, &secrets).await;
    focus_candidates(&su, &[fixture.workspace_id]).await;

    for kind in ["broadcast", "agent_job", "webhook_delivery"] {
        sqlx::query(
            "INSERT INTO outbox (workspace_id, kind, method, payload, partition_key) \
             VALUES ($1, $2::outbox_kind, 'publish', '{}'::jsonb, $3)",
        )
        .bind(fixture.workspace_id)
        .bind(kind)
        .bind(fixture.channel_id)
        .execute(&su)
        .await
        .expect("seed a foreign-feed outbox row");
    }

    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    let stats = drain(&pool, relay).drain_once(32).await.expect("drain");
    assert_eq!(
        stats.claimed, 0,
        "there is no push candidate yet, so the drain must claim nothing"
    );

    let untouched: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE workspace_id = $1 AND kind <> 'push_candidate' AND status = 'pending'",
    )
    .bind(fixture.workspace_id)
    .fetch_one(&su)
    .await
    .expect("count foreign rows");
    assert_eq!(
        untouched, 3,
        "broadcast / agent_job / webhook_delivery rows belong to other consumers"
    );
}

/// ADR-0124: muting a channel suppresses every reason, including a DM.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_muted_channel_suppresses_the_notification() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let secrets = Secrets::mint();
    let fixture = seed_dm_fixture(&su, &secrets).await;
    focus_candidates(&su, &[fixture.workspace_id]).await;

    sqlx::query(
        "INSERT INTO notification_pref (workspace_id, channel_id, member_id, muted_until) \
         VALUES ($1, $2, $3, now() + interval '1 day')",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.channel_id)
    .bind(fixture.recipient_id)
    .execute(&su)
    .await
    .expect("mute the channel for the recipient");

    send_message(&su, &fixture, &secrets.body, 1).await;

    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    let stats = drain(&pool, relay.clone())
        .drain_once(32)
        .await
        .expect("drain");

    assert_eq!(
        stats.claimed, 1,
        "the candidate is still produced and consumed"
    );
    assert!(
        relay.sent().is_empty(),
        "a muted channel must not notify — judgment suppresses it, the trigger does not"
    );
    let statuses = candidate_status(&su, fixture.workspace_id).await;
    assert_eq!(
        statuses,
        vec![("done".to_string(), 1)],
        "nobody to notify is a completed candidate, not a failure"
    );
}

/// ADR-0124 증보 1: a member's DND row suppresses every reason across the whole
/// workspace, no channel mute required. Here the channel is NOT muted and the
/// candidate is a plain DM — only the `notification_rule.dnd` row stops it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn dnd_suppresses_every_reason() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let secrets = Secrets::mint();
    let fixture = seed_dm_fixture(&su, &secrets).await;
    focus_candidates(&su, &[fixture.workspace_id]).await;

    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, dnd) VALUES ($1, $2, true)",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.recipient_id)
    .execute(&su)
    .await
    .expect("turn on DND for the recipient");

    send_message(&su, &fixture, &secrets.body, 1).await;

    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    let stats = drain(&pool, relay.clone())
        .drain_once(32)
        .await
        .expect("drain");

    assert_eq!(
        stats.claimed, 1,
        "the candidate is still produced and consumed"
    );
    assert!(
        relay.sent().is_empty(),
        "DND must suppress every reason — judgment drops the target, the trigger does not"
    );
    let statuses = candidate_status(&su, fixture.workspace_id).await;
    assert_eq!(
        statuses,
        vec![("done".to_string(), 1)],
        "nobody to notify is a completed candidate, not a failure"
    );
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM push_dispatch_log WHERE member_id = $1")
            .bind(fixture.recipient_id)
            .fetch_one(&su)
            .await
            .expect("count dispatch log");
    assert_eq!(
        rows, 0,
        "a DND-suppressed candidate must leave no dispatch-log row"
    );
}

/// ADR-0124 증보 1 (D3's reserved switch): with `mention_overrides_mute` a
/// mention pierces a channel this member muted in 018 — and ONLY a mention. The
/// DM in the same muted channel stays suppressed, so the exception modifies the
/// mute, it does not undo it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_mention_exception_delivers_through_a_channel_mute() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let secrets = Secrets::mint();
    let fixture = seed_dm_fixture(&su, &secrets).await;
    focus_candidates(&su, &[fixture.workspace_id]).await;

    sqlx::query(
        "INSERT INTO notification_pref (workspace_id, channel_id, member_id, muted_until) \
         VALUES ($1, $2, $3, now() + interval '1 day')",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.channel_id)
    .bind(fixture.recipient_id)
    .execute(&su)
    .await
    .expect("mute the channel for the recipient");
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, mention_overrides_mute) \
         VALUES ($1, $2, true)",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.recipient_id)
    .execute(&su)
    .await
    .expect("let mentions through the mute for the recipient");

    // A plain DM in the muted channel: the exception is mention-only, so this
    // stays suppressed.
    send_message(&su, &fixture, &secrets.body, 1).await;
    // A mention in the same muted channel: this one gets through.
    let mention_id =
        send_mention_message(&su, &fixture, "please review", 2, fixture.recipient_id).await;

    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    drain(&pool, relay.clone())
        .drain_once(32)
        .await
        .expect("drain");

    let sent = relay.sent();
    assert_eq!(
        sent.len(),
        1,
        "exactly the mention pierces the mute; the DM does not"
    );
    assert_eq!(
        sent[0].message_id,
        mention_id.to_string(),
        "the delivered notification is the mention, not the muted DM"
    );
    assert_eq!(sent[0].reason, "mention");
}

/// ADR-0124 증보 1: DND sits ABOVE the mention exception. A member who is both
/// DND and has the exception on still hears nothing, because the panel presents
/// DND as "pause everything" and a leaked mention would break that promise.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn dnd_outranks_a_mention_exception() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let secrets = Secrets::mint();
    let fixture = seed_dm_fixture(&su, &secrets).await;
    focus_candidates(&su, &[fixture.workspace_id]).await;

    sqlx::query(
        "INSERT INTO notification_pref (workspace_id, channel_id, member_id, muted_until) \
         VALUES ($1, $2, $3, now() + interval '1 day')",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.channel_id)
    .bind(fixture.recipient_id)
    .execute(&su)
    .await
    .expect("mute the channel for the recipient");
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, dnd, mention_overrides_mute) \
         VALUES ($1, $2, true, true)",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.recipient_id)
    .execute(&su)
    .await
    .expect("DND on AND mention exception on");

    send_mention_message(&su, &fixture, "urgent @you", 1, fixture.recipient_id).await;

    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    drain(&pool, relay.clone())
        .drain_once(32)
        .await
        .expect("drain");

    assert!(
        relay.sent().is_empty(),
        "DND must win over a mention exception — pause-everything means everything"
    );
}

/// ADR-0124 증보 2: a timed pause suppresses while `dnd_until` is ahead and
/// delivers once it is behind — compared by the judgment SQL at drain time.
/// Nothing sweeps the row: the SAME stored `dnd = true` row is still there when
/// the second message is delivered.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_timed_pause_suppresses_until_it_expires_then_delivers() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let secrets = Secrets::mint();
    let fixture = seed_dm_fixture(&su, &secrets).await;
    focus_candidates(&su, &[fixture.workspace_id]).await;

    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, dnd, dnd_until) \
         VALUES ($1, $2, true, now() + interval '1 hour')",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.recipient_id)
    .execute(&su)
    .await
    .expect("pause for an hour");

    send_message(&su, &fixture, &secrets.body, 1).await;
    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    drain(&pool, relay.clone())
        .drain_once(32)
        .await
        .expect("drain while paused");
    assert!(
        relay.sent().is_empty(),
        "a pause whose expiry is ahead must suppress like an open-ended one"
    );

    // Time passes: the expiry is now behind. Only the timestamp moves — `dnd`
    // stays true, exactly what a lazily-expired row looks like with no sweeper.
    sqlx::query(
        "UPDATE notification_rule SET dnd_until = now() - interval '1 second' \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.recipient_id)
    .execute(&su)
    .await
    .expect("let the pause lapse");
    let still_on: bool = sqlx::query_scalar(
        "SELECT dnd FROM notification_rule WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.recipient_id)
    .fetch_one(&su)
    .await
    .expect("read stored dnd");
    assert!(still_on, "the stored flag is untouched; only time moved");

    let second = send_message(&su, &fixture, &secrets.body, 2).await;
    let relay = RecordingDispatcher::accepting();
    drain(&pool, relay.clone())
        .drain_once(32)
        .await
        .expect("drain after expiry");
    let sent = relay.sent();
    assert_eq!(sent.len(), 1, "an expired pause must deliver: {sent:?}");
    assert_eq!(sent[0].message_id, second.to_string());
}

/// ADR-0124 증보 2 「묶어」: choosing declared DND with an expiry pauses pushes
/// through the presence write alone (no second write to notification-rules),
/// and the pause lapses with DND — real wall-clock expiry, no sweeper, no
/// timestamp rewriting.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn declared_dnd_pauses_pushes_and_both_lapse_together() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let secrets = Secrets::mint();
    let fixture = seed_dm_fixture(&su, &secrets).await;
    focus_candidates(&su, &[fixture.workspace_id]).await;

    let workspace = fixture.workspace_id;
    let recipient = fixture.recipient_id;
    let until = chrono::Utc::now() + chrono::Duration::seconds(3);
    let update = with_tenant_tx(&su, workspace, move |conn| {
        Box::pin(async move {
            set_declared_presence_in_tx(
                conn,
                workspace,
                recipient,
                PresenceStatus::Dnd,
                StatusPatch::Set(Some(until)),
                CustomStatusPatch::default(),
            )
            .await
        })
    })
    .await
    .expect("declare dnd for 3s")
    .expect("a live human");
    assert_eq!(update.status, PresenceStatus::Dnd);

    send_message(&su, &fixture, &secrets.body, 1).await;
    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    drain(&pool, relay.clone())
        .drain_once(32)
        .await
        .expect("drain during dnd");
    assert!(
        relay.sent().is_empty(),
        "declared DND must pause pushes through the presence write alone"
    );

    // Wait out the real expiry.
    let wait = (until - chrono::Utc::now()).to_std().unwrap_or_default()
        + std::time::Duration::from_millis(500);
    tokio::time::sleep(wait).await;

    let after = with_tenant_tx(&su, workspace, move |conn| {
        Box::pin(async move { presence_status_for(conn, recipient).await })
    })
    .await
    .expect("read presence after expiry");
    assert_eq!(
        after,
        Some(PresenceStatus::Auto),
        "an expired DND reads as auto"
    );

    let second = send_message(&su, &fixture, &secrets.body, 2).await;
    let relay = RecordingDispatcher::accepting();
    drain(&pool, relay.clone())
        .drain_once(32)
        .await
        .expect("drain after expiry");
    let sent = relay.sent();
    assert_eq!(
        sent.len(),
        1,
        "the pause must lapse with DND, not outlive it: {sent:?}"
    );
    assert_eq!(sent[0].message_id, second.to_string());
}

/// A relay that is briefly down must not cost a notification. The candidate goes
/// back to `pending` with a backoff and the dispatch stays unsettled, so the
/// retry genuinely re-sends.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_transient_relay_failure_requeues_instead_of_dropping() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let secrets = Secrets::mint();
    let fixture = seed_dm_fixture(&su, &secrets).await;
    focus_candidates(&su, &[fixture.workspace_id]).await;
    send_message(&su, &fixture, &secrets.body, 1).await;

    let relay = RecordingDispatcher::failing_transiently();
    let pool = momo_notifier_pool().await;
    let stats = drain(&pool, relay.clone())
        .drain_once(32)
        .await
        .expect("drain");

    assert_eq!(stats.requeued, 1, "a 503 requeues the candidate");
    let statuses = candidate_status(&su, fixture.workspace_id).await;
    assert_eq!(
        statuses,
        vec![("pending".to_string(), 1)],
        "the candidate returns to pending so the notification is retried"
    );

    let unsettled: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM push_dispatch_log \
          WHERE workspace_id = $1 AND apns_status IS NULL",
    )
    .bind(fixture.workspace_id)
    .fetch_one(&su)
    .await
    .expect("count unsettled dispatch rows");
    assert_eq!(
        unsettled, 1,
        "the in-flight claim stays unsettled so the retry re-sends rather than skipping"
    );
}

// ---------------------------------------------------------------------------
// ADR-0120 부록 A (#3341) — 「작업 끝남」 push: work_session_idle
// ---------------------------------------------------------------------------

/// The session owner is `fixture.recipient_id` (the member with a device); the
/// DM peer is `fixture.author_id`.
struct WorkFixture {
    session_id: Uuid,
    root_id: Uuid,
}

async fn give_device(su: &PgPool, fixture: &Fixture, member_id: Uuid) {
    let device_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO device (id, workspace_id, member_id, platform) \
         VALUES ($1, $2, $3, 'ios'::device_platform)",
    )
    .bind(device_id)
    .bind(fixture.workspace_id)
    .bind(member_id)
    .execute(su)
    .await
    .expect("seed peer device");
    sqlx::query(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, 'kim.dawn.momo.e2e')",
    )
    .bind(fixture.workspace_id)
    .bind(device_id)
    .bind(member_id)
    .bind(Uuid::new_v4().simple().to_string().repeat(2))
    .execute(su)
    .await
    .expect("seed peer push token");
}

/// A running work session owned by `fixture.recipient_id`, with its root card.
async fn seed_work_session(su: &PgPool, fixture: &Fixture) -> WorkFixture {
    let host_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO work_host (id, workspace_id, scope, owner_member_id, type, display_name, \
                                public_key, capabilities, last_seen_at) \
         VALUES ($1, $2, 'member', $3, 'app', 'mac', $4, '{}'::jsonb, clock_timestamp())",
    )
    .bind(host_id)
    .bind(fixture.workspace_id)
    .bind(fixture.recipient_id)
    .bind("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    .execute(su)
    .await
    .expect("seed work host");
    let root_id: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, props) \
         VALUES ($1, $2, 1, 1, 0, $3, 'system', '{\"kind\":\"work.session\"}'::jsonb) RETURNING id",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.channel_id)
    .bind(fixture.recipient_id)
    .fetch_one(su)
    .await
    .expect("seed session root card");
    let session_id: Uuid = sqlx::query_scalar(
        "INSERT INTO work_session \
           (workspace_id, channel_id, member_id, host_id, root_message_id, tool, label) \
         VALUES ($1, $2, $3, $4, $5, 'claude', 'build the thing') RETURNING id",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.channel_id)
    .bind(fixture.recipient_id)
    .bind(host_id)
    .bind(root_id)
    .fetch_one(su)
    .await
    .expect("seed work session");
    WorkFixture {
        session_id,
        root_id,
    }
}

/// Insert an idle card exactly as `transition_lifecycle_in_tx` shapes it. The
/// author / owner / numbers are parameters so a test can forge each fact.
#[allow(clippy::too_many_arguments)]
async fn idle_card(
    su: &PgPool,
    fixture: &Fixture,
    work: &WorkFixture,
    seq: i64,
    author: Uuid,
    owner_prop: Uuid,
    ran_ms: i64,
    turn_started_ms: i64,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, \
            root_id, props) \
         VALUES ($1, $2, $3, $3, 0, $4, 'system', '작업 완료 — idle 대기', $5, \
                 jsonb_build_object('kind', 'work_session_idle', \
                                    'session_id', $6::text, \
                                    'owner_member_id', $7::text, \
                                    'turn_started_ms', $8::bigint, \
                                    'ran_ms', $9::bigint)) \
         RETURNING id",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.channel_id)
    .bind(seq)
    .bind(author)
    .bind(work.root_id)
    .bind(work.session_id.to_string())
    .bind(owner_prop.to_string())
    .bind(turn_started_ms)
    .bind(ran_ms)
    .fetch_one(su)
    .await
    .expect("insert idle card (fires push_candidate_enqueue_trg)")
}

/// Drain the fixture's candidates and return what was dispatched for `message`.
async fn dispatched_for(su: &PgPool, fixture: &Fixture, message: Uuid) -> Vec<PushDispatch> {
    focus_candidates(su, &[fixture.workspace_id]).await;
    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    drain(&pool, relay.clone())
        .drain_once(64)
        .await
        .expect("drain");
    relay
        .sent()
        .into_iter()
        .filter(|dispatch| dispatch.message_id == message.to_string())
        .collect()
}

const LONG_TURN_MS: i64 = 90_000;
const TURN_A: i64 = 1_800_000_000_000;

async fn work_fixture(su: &PgPool) -> (Fixture, WorkFixture) {
    let secrets = Secrets::mint();
    let fixture = seed_dm_fixture(su, &secrets).await;
    // The DM peer has a device too: every "nobody else is notified" claim below
    // is only meaningful if the peer COULD be.
    give_device(su, &fixture, fixture.author_id).await;
    let work = seed_work_session(su, &fixture).await;
    (fixture, work)
}

/// The happy path: the member who started the session hears that a 90 s turn
/// finished — on the fifth reason, the `momo.work` category, ids only — and the
/// DM peer, who is in the channel and has a device, hears nothing.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn work_complete_pushes_the_session_starter_for_a_long_turn() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let (fixture, work) = work_fixture(&su).await;
    let owner = fixture.recipient_id;
    let card = idle_card(&su, &fixture, &work, 2, owner, owner, LONG_TURN_MS, TURN_A).await;

    let sent = dispatched_for(&su, &fixture, card).await;
    assert_eq!(sent.len(), 1, "exactly the starter's one device: {sent:?}");
    assert_eq!(sent[0].reason, "work_session_idle");
    assert_eq!(sent[0].category, "momo.work");
    assert_eq!(sent[0].approval_id, None);
    let rendered = serde_json::to_string(&sent[0]).expect("render");
    assert!(
        !rendered.contains("build the thing") && !rendered.contains("작업 완료"),
        "label and card body stay off the wire: {rendered}"
    );
}

/// A personal agent member (migration 123/124): not a member of the room.
async fn seed_alias(su: &PgPool, fixture: &Fixture) -> Uuid {
    let alias = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', '개인 에이전트', $3)",
    )
    .bind(alias)
    .bind(fixture.workspace_id)
    .bind(format!("alias-{}", alias.simple()))
    .execute(su)
    .await
    .expect("seed alias member");
    alias
}

/// #3592 (P1): a session the owner called through a personal agent speaks as
/// the alias, so its idle line is authored by the alias — and the owner is
/// still told the turn finished. The forgery guard (the author must be the
/// owner **or this session's own persona**) stays closed to anyone else.
/// Red when the persona arm of the `work_session_idle` guard is dropped.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn work_complete_pushes_the_owner_when_the_session_speaks_as_its_alias() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let (fixture, work) = work_fixture(&su).await;
    let owner = fixture.recipient_id;
    let alias = seed_alias(&su, &fixture).await;
    sqlx::query("UPDATE work_session SET persona_member_id = $2 WHERE id = $1")
        .bind(work.session_id)
        .bind(alias)
        .execute(&su)
        .await
        .expect("this session speaks as the alias");

    let card = idle_card(&su, &fixture, &work, 2, alias, owner, LONG_TURN_MS, TURN_A).await;
    let sent = dispatched_for(&su, &fixture, card).await;
    assert_eq!(sent.len(), 1, "the owner's one device: {sent:?}");
    assert_eq!(sent[0].reason, "work_session_idle");

    // The same line authored by a member that is NOT this session's persona is
    // a forgery and tells nobody.
    let stranger = seed_alias(&su, &fixture).await;
    // `stranger` is a real persona — of ANOTHER session (review: a persona of a
    // different session must not vouch for this one).
    let other_root: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, props) \
         VALUES ($1, $2, 90, 90, 0, $3, 'system', '{\"kind\":\"work.session\"}'::jsonb) RETURNING id",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.channel_id)
    .bind(owner)
    .fetch_one(&su)
    .await
    .expect("another session's card");
    sqlx::query(
        "INSERT INTO work_session \
           (workspace_id, channel_id, member_id, host_id, root_message_id, tool, label, persona_member_id) \
         SELECT workspace_id, channel_id, member_id, host_id, $2, tool, 'other', $3 \
           FROM work_session WHERE id = $1",
    )
    .bind(work.session_id)
    .bind(other_root)
    .bind(stranger)
    .execute(&su)
    .await
    .expect("another session spoken as the stranger");
    let forged = idle_card(
        &su,
        &fixture,
        &work,
        3,
        stranger,
        owner,
        LONG_TURN_MS,
        TURN_A + 1,
    )
    .await;
    assert!(
        dispatched_for(&su, &fixture, forged).await.is_empty(),
        "an idle line by someone who is neither the owner nor the session's persona pushes nothing"
    );
}

/// 「1분 이상」: a 59.999 s turn is silent, and silent means NO reason — it must
/// not fall through to the DM arm and push the card's text to the peer.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn work_complete_skips_a_turn_shorter_than_a_minute() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let (fixture, work) = work_fixture(&su).await;
    let owner = fixture.recipient_id;
    let short = idle_card(&su, &fixture, &work, 2, owner, owner, 59_999, TURN_A).await;
    let boundary = idle_card(&su, &fixture, &work, 3, owner, owner, 60_000, TURN_A + 1).await;

    let skipped = dispatched_for(&su, &fixture, short).await;
    assert!(
        skipped.is_empty(),
        "59.999 s is under a minute: {skipped:?}"
    );
    // The boundary is inclusive ("1분 이상"); the same drain handled both cards.
    let relay_again = dispatched_for(&su, &fixture, boundary).await;
    assert!(
        relay_again.is_empty(),
        "the first drain already settled the boundary card; re-drain sends nothing new"
    );
    let delivered: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM push_dispatch_log WHERE workspace_id = $1 AND message_id = $2",
    )
    .bind(fixture.workspace_id)
    .bind(boundary)
    .fetch_one(&su)
    .await
    .expect("count");
    assert_eq!(delivered, 1, "exactly 60 s is long enough");
}

/// Only the starter. A card naming the DM peer as owner, a card authored by the
/// peer, and a card for a session id that belongs to someone else all select no
/// recipient — the peer cannot be spammed by forging a card, and the real owner
/// is not pushed for a card they did not author.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn work_complete_is_for_the_starter_only_never_a_peer_or_a_forged_card() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let (fixture, work) = work_fixture(&su).await;
    let owner = fixture.recipient_id;
    let peer = fixture.author_id;

    // owner prop names the peer, authored by the peer: the peer is not the
    // session's member, so there is no session of theirs to be told about.
    let peer_owned = idle_card(&su, &fixture, &work, 2, peer, peer, LONG_TURN_MS, TURN_A).await;
    // authored by the peer, owner prop names the real owner (a forged card).
    let forged = idle_card(
        &su,
        &fixture,
        &work,
        3,
        peer,
        owner,
        LONG_TURN_MS,
        TURN_A + 1,
    )
    .await;
    // a session id that does not exist.
    let ghost = WorkFixture {
        session_id: Uuid::new_v4(),
        root_id: work.root_id,
    };
    let no_session = idle_card(
        &su,
        &fixture,
        &ghost,
        4,
        owner,
        owner,
        LONG_TURN_MS,
        TURN_A + 2,
    )
    .await;

    focus_candidates(&su, &[fixture.workspace_id]).await;
    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    drain(&pool, relay.clone())
        .drain_once(64)
        .await
        .expect("drain");
    for (name, card) in [
        ("peer-owned", peer_owned),
        ("forged by the peer", forged),
        ("unknown session", no_session),
    ] {
        let hits: Vec<_> = relay
            .sent()
            .into_iter()
            .filter(|d| d.message_id == card.to_string())
            .collect();
        assert!(hits.is_empty(), "{name} idle card pushed: {hits:?}");
    }
}

/// 「앱 비활성일 때만」, approximated server-side (ADR-0120 부록 A-8): a person
/// whose read cursor moved in the channel within 30 s before the card is looking
/// at it; one who last read minutes ago is not.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn work_complete_skips_when_the_owner_was_just_reading_the_channel() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;

    // Reading right now -> silent.
    let (fixture, work) = work_fixture(&su).await;
    let owner = fixture.recipient_id;
    sqlx::query(
        "INSERT INTO read_state (workspace_id, channel_id, member_id, last_read_seq, last_read_at) \
         VALUES ($1, $2, $3, 1, now())",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.channel_id)
    .bind(owner)
    .execute(&su)
    .await
    .expect("owner just read the channel");
    let watched = idle_card(&su, &fixture, &work, 2, owner, owner, LONG_TURN_MS, TURN_A).await;
    let sent = dispatched_for(&su, &fixture, watched).await;
    assert!(
        sent.is_empty(),
        "the owner is looking at the channel: {sent:?}"
    );

    // Last read five minutes ago, and behind the card -> pushed.
    let (fixture, work) = work_fixture(&su).await;
    let owner = fixture.recipient_id;
    sqlx::query(
        "INSERT INTO read_state (workspace_id, channel_id, member_id, last_read_seq, last_read_at) \
         VALUES ($1, $2, $3, 1, now() - interval '5 minutes')",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.channel_id)
    .bind(owner)
    .execute(&su)
    .await
    .expect("owner read the channel long ago");
    let away = idle_card(&su, &fixture, &work, 2, owner, owner, LONG_TURN_MS, TURN_A).await;
    let sent = dispatched_for(&su, &fixture, away).await;
    assert_eq!(sent.len(), 1, "the owner is away: {sent:?}");
    assert_eq!(sent[0].reason, "work_session_idle");
}

/// One push per turn. A second idle card for the same turn (a retried
/// transition, a duplicate relay of the host's report) is silent; the next turn
/// is a different `turn_started_ms` and is pushed again.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn work_complete_is_pushed_once_per_turn() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let (fixture, work) = work_fixture(&su).await;
    let owner = fixture.recipient_id;
    let first = idle_card(&su, &fixture, &work, 2, owner, owner, LONG_TURN_MS, TURN_A).await;
    let duplicate = idle_card(
        &su,
        &fixture,
        &work,
        3,
        owner,
        owner,
        LONG_TURN_MS + 5,
        TURN_A,
    )
    .await;
    let next_turn = idle_card(
        &su,
        &fixture,
        &work,
        4,
        owner,
        owner,
        LONG_TURN_MS,
        TURN_A + 200_000,
    )
    .await;

    focus_candidates(&su, &[fixture.workspace_id]).await;
    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    drain(&pool, relay.clone())
        .drain_once(64)
        .await
        .expect("drain");
    let count = |card: Uuid| {
        relay
            .sent()
            .iter()
            .filter(|d| d.message_id == card.to_string() && d.reason == "work_session_idle")
            .count()
    };
    assert_eq!(count(first), 1, "the turn's first card is pushed");
    assert_eq!(
        count(duplicate),
        0,
        "a second card for the same turn is not"
    );
    assert_eq!(count(next_turn), 1, "the next turn is pushed again");
}

/// The member's own switch (`PATCH …/notification-rules/push-kinds`). It turns
/// off this kind only: a plain DM still reaches them.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn work_complete_respects_the_members_own_switch() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let (fixture, work) = work_fixture(&su).await;
    let owner = fixture.recipient_id;
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, work_complete_push) \
         VALUES ($1, $2, false)",
    )
    .bind(fixture.workspace_id)
    .bind(owner)
    .execute(&su)
    .await
    .expect("owner switches 작업 끝남 off");
    let card = idle_card(&su, &fixture, &work, 2, owner, owner, LONG_TURN_MS, TURN_A).await;
    let dm = send_message(&su, &fixture, "hello", 3).await;

    focus_candidates(&su, &[fixture.workspace_id]).await;
    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    drain(&pool, relay.clone())
        .drain_once(64)
        .await
        .expect("drain");
    let sent = relay.sent();
    assert!(
        sent.iter().all(|d| d.message_id != card.to_string()),
        "the switch is off: {sent:?}"
    );
    assert!(
        sent.iter()
            .any(|d| d.message_id == dm.to_string() && d.reason == "dm"),
        "the switch is per kind — a DM still notifies: {sent:?}"
    );
}

// ---------------------------------------------------------------------------
// ADR-0162 증보 3 D14 (#3517) — 「작업 끝남」 for a hosted agent's work run
// ---------------------------------------------------------------------------

/// The requester is `fixture.recipient_id` (the member with a device); the DM
/// peer `fixture.author_id` has a device too, so "only the requester" is a real
/// claim. `agent` is a hosted agent in the channel.
struct RunFixture {
    agent: Uuid,
}

async fn seed_hosted_agent(su: &PgPool, fixture: &Fixture, hosted: bool) -> RunFixture {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
         VALUES ($1, $2, 'agent'::member_kind, 'active', 'hermes', $3)",
    )
    .bind(agent)
    .bind(fixture.workspace_id)
    .bind(format!("a{}", agent.simple()))
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, \
                            max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 4, 50, $3)",
    )
    .bind(agent)
    .bind(fixture.workspace_id)
    .bind(fixture.recipient_id)
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(fixture.workspace_id)
        .bind(fixture.channel_id)
        .bind(agent)
        .execute(su)
        .await
        .expect("agent joins the channel");
    if hosted {
        // Migration 069's guard: a hosted connection needs the sentinel agent shape.
        sqlx::query(
            "UPDATE agent SET model = 'hosted-agent', \
                    base_url = 'https://hosted-agent.invalid/disabled', \
                    config = jsonb_build_object('execution_mode', 'hosted_dial_in') \
              WHERE workspace_id = $1 AND member_id = $2",
        )
        .bind(fixture.workspace_id)
        .bind(agent)
        .execute(su)
        .await
        .expect("make the agent a hosted sentinel");
        sqlx::query(
            "INSERT INTO hosted_agent_connection \
               (workspace_id, agent_member_id, status, created_by, pairing_challenge_hash, \
                pairing_expires_at) \
             VALUES ($1, $2, 'pairing_pending', $3, '\\x00'::bytea, now() + interval '1 hour')",
        )
        .bind(fixture.workspace_id)
        .bind(agent)
        .bind(fixture.recipient_id)
        .execute(su)
        .await
        .expect("seed hosted connection");
    }
    RunFixture { agent }
}

async fn run_work_fixture(su: &PgPool) -> (Fixture, RunFixture) {
    let secrets = Secrets::mint();
    let fixture = seed_dm_fixture(su, &secrets).await;
    give_device(su, &fixture, fixture.author_id).await;
    let run = seed_hosted_agent(su, &fixture, true).await;
    (fixture, run)
}

/// A run that ended `status` after `ran_ms`, asked for by `requester` (`None` =
/// no `agent.work.queued` audit row), of input type `input_type`.
#[allow(clippy::too_many_arguments)]
async fn seed_run(
    su: &PgPool,
    fixture: &Fixture,
    agent: Uuid,
    status: &str,
    ran_ms: i64,
    input_type: &str,
    requester: Option<Uuid>,
) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key, \
            started_at, finished_at) \
         VALUES ($1, $2, $3, $4, $5::run_status, jsonb_build_object('type', $6::text, 'title', 'SECRET-TITLE'), \
                 $7, now() - make_interval(secs => $8::double precision / 1000.0), now())",
    )
    .bind(run)
    .bind(fixture.workspace_id)
    .bind(agent)
    .bind(fixture.channel_id)
    .bind(status)
    .bind(input_type)
    .bind(format!("t:{run}"))
    .bind(ran_ms)
    .execute(su)
    .await
    .expect("seed run");
    if let Some(requester) = requester {
        sqlx::query(
            "INSERT INTO audit_log (workspace_id, actor_member_id, action, target_type, target_id, run_id) \
             VALUES ($1, $2, 'agent.work.queued', 'agent_run', $3, $3)",
        )
        .bind(fixture.workspace_id)
        .bind(requester)
        .bind(run)
        .execute(su)
        .await
        .expect("seed requester audit row");
    }
    run
}

/// The run's final answer exactly as `complete_gateway_run_in_tx` shapes it:
/// authored by the agent, `client_msg_id = run_id`, `run_id` set.
async fn run_answer(
    su: &PgPool,
    fixture: &Fixture,
    run: Uuid,
    author: Uuid,
    seq: i64,
    kind: &str,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, \
            client_msg_id, run_id) \
         VALUES ($1, $2, $3, $3, 0, $4, $5::message_type, 'SECRET-ANSWER', $6, $6) RETURNING id",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.channel_id)
    .bind(seq)
    .bind(author)
    .bind(kind)
    .bind(run)
    .fetch_one(su)
    .await
    .expect("insert run answer (fires push_candidate_enqueue_trg)")
}

fn only_reason<'a>(sent: &'a [PushDispatch], reason: &str) -> Vec<&'a PushDispatch> {
    sent.iter().filter(|d| d.reason == reason).collect()
}

/// Happy path: the requester hears a 90 s hosted work run ended, on the sixth
/// reason, the `momo.work` category, ids only. The DM peer (a device, in the
/// channel) is NOT told on that reason, and a failed run pushes the same way.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_hosted_work_run_answer_pushes_its_requester_on_the_sixth_reason() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let (fixture, run) = run_work_fixture(&su).await;
    let requester = fixture.recipient_id;
    let ok = seed_run(
        &su,
        &fixture,
        run.agent,
        "succeeded",
        90_000,
        "work",
        Some(requester),
    )
    .await;
    let ok_msg = run_answer(&su, &fixture, ok, run.agent, 2, "text").await;
    let bad = seed_run(
        &su,
        &fixture,
        run.agent,
        "failed",
        90_000,
        "work",
        Some(requester),
    )
    .await;
    let bad_msg = run_answer(&su, &fixture, bad, run.agent, 3, "system").await;

    focus_candidates(&su, &[fixture.workspace_id]).await;
    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    drain(&pool, relay.clone())
        .drain_once(64)
        .await
        .expect("drain");
    // A second drain (redelivery) sends nothing new for the same runs.
    drain(&pool, relay.clone())
        .drain_once(64)
        .await
        .expect("redrain");
    let sent = relay.sent();
    for message in [ok_msg, bad_msg] {
        let hits: Vec<_> = sent
            .iter()
            .filter(|d| d.message_id == message.to_string() && d.reason == "work_run_done")
            .collect();
        assert_eq!(
            hits.len(),
            1,
            "one push per run, to the requester's one device: {sent:?}"
        );
        assert_eq!(hits[0].category, "momo.work");
        assert_eq!(hits[0].approval_id, None);
        let rendered = serde_json::to_string(hits[0]).expect("render");
        assert!(
            !rendered.contains("SECRET-TITLE") && !rendered.contains("SECRET-ANSWER"),
            "title and answer stay off the wire: {rendered}"
        );
    }
    // The requester has one device; the peer (the other device) got the ordinary
    // DM reason, never `work_run_done`.
    assert_eq!(only_reason(&sent, "work_run_done").len(), 2);
}

/// 「1분 이상」 and A-8: a 59.999 s run, and a run whose requester was just
/// reading the channel, push NOTHING to the requester — silent, not the DM arm.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_hosted_work_run_under_a_minute_or_just_read_is_silent_not_a_dm() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let (fixture, run) = run_work_fixture(&su).await;
    let requester = fixture.recipient_id;
    let short = seed_run(
        &su,
        &fixture,
        run.agent,
        "succeeded",
        59_000,
        "work",
        Some(requester),
    )
    .await;
    let short_msg = run_answer(&su, &fixture, short, run.agent, 2, "text").await;
    let edge = seed_run(
        &su,
        &fixture,
        run.agent,
        "succeeded",
        61_000,
        "work",
        Some(requester),
    )
    .await;
    let edge_msg = run_answer(&su, &fixture, edge, run.agent, 3, "text").await;

    focus_candidates(&su, &[fixture.workspace_id]).await;
    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    drain(&pool, relay.clone())
        .drain_once(64)
        .await
        .expect("drain");
    let sent = relay.sent();
    let to_requester = |message: Uuid| -> Vec<&PushDispatch> {
        sent.iter()
            .filter(|d| d.message_id == message.to_string() && d.reason != "dm")
            .collect()
    };
    assert!(
        to_requester(short_msg).is_empty(),
        "59 s is under a minute: {sent:?}"
    );
    assert_eq!(
        to_requester(edge_msg)
            .iter()
            .filter(|d| d.reason == "work_run_done")
            .count(),
        1,
        "61 s is long enough"
    );
    // The requester's own device never got `dm` for the short run's answer: the
    // arm yields no reason for them (the peer's `dm` is the ordinary DM rule).
    let requester_device: String = sqlx::query_scalar(
        "SELECT d.id::text FROM device d WHERE d.workspace_id = $1 AND d.member_id = $2",
    )
    .bind(fixture.workspace_id)
    .bind(requester)
    .fetch_one(&su)
    .await
    .expect("requester device");
    assert!(
        sent.iter()
            .all(|d| !(d.message_id == short_msg.to_string() && d.device_id == requester_device)),
        "a short run does not fall through to dm for the requester: {sent:?}"
    );

    // Just reading the channel -> silent for the requester.
    let (fixture, run) = run_work_fixture(&su).await;
    let requester = fixture.recipient_id;
    sqlx::query(
        "INSERT INTO read_state (workspace_id, channel_id, member_id, last_read_seq, last_read_at) \
         VALUES ($1, $2, $3, 1, now())",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.channel_id)
    .bind(requester)
    .execute(&su)
    .await
    .expect("requester just read the channel");
    let watched = seed_run(
        &su,
        &fixture,
        run.agent,
        "succeeded",
        90_000,
        "work",
        Some(requester),
    )
    .await;
    let watched_msg = run_answer(&su, &fixture, watched, run.agent, 2, "text").await;
    let sent = dispatched_for(&su, &fixture, watched_msg).await;
    assert!(
        only_reason(&sent, "work_run_done").is_empty(),
        "the requester is looking at the channel: {sent:?}"
    );
}

/// Fail-closed inputs: no requester record, a mention run, a managed (not hosted)
/// agent, a cancelled run, a message that is not the agent's own answer, and a
/// peer who did not ask — none of them selects `work_run_done`.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_hosted_work_run_push_needs_a_requester_a_hosted_work_run_and_the_agents_own_answer() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let (fixture, run) = run_work_fixture(&su).await;
    let managed = seed_hosted_agent(&su, &fixture, false).await;
    let requester = fixture.recipient_id;
    let peer = fixture.author_id;

    let no_requester = seed_run(&su, &fixture, run.agent, "succeeded", 90_000, "work", None).await;
    let no_requester_msg = run_answer(&su, &fixture, no_requester, run.agent, 2, "text").await;
    let mention = seed_run(
        &su,
        &fixture,
        run.agent,
        "succeeded",
        90_000,
        "mention",
        Some(requester),
    )
    .await;
    let mention_msg = run_answer(&su, &fixture, mention, run.agent, 3, "text").await;
    let managed_run = seed_run(
        &su,
        &fixture,
        managed.agent,
        "succeeded",
        90_000,
        "work",
        Some(requester),
    )
    .await;
    let managed_msg = run_answer(&su, &fixture, managed_run, managed.agent, 4, "text").await;
    let cancelled = seed_run(
        &su,
        &fixture,
        run.agent,
        "cancelled",
        90_000,
        "work",
        Some(requester),
    )
    .await;
    let cancelled_msg = run_answer(&su, &fixture, cancelled, run.agent, 5, "text").await;
    let still_running = seed_run(
        &su,
        &fixture,
        run.agent,
        "running",
        90_000,
        "work",
        Some(requester),
    )
    .await;
    let running_msg = run_answer(&su, &fixture, still_running, run.agent, 6, "text").await;
    // Not the agent's own answer: the peer posts a message carrying a real run's id.
    let forged_run = seed_run(
        &su,
        &fixture,
        run.agent,
        "succeeded",
        90_000,
        "work",
        Some(requester),
    )
    .await;
    let forged_msg = run_answer(&su, &fixture, forged_run, peer, 7, "text").await;
    // The peer asked for this run: the requester is NOT told.
    let peer_asked = seed_run(
        &su,
        &fixture,
        run.agent,
        "succeeded",
        90_000,
        "work",
        Some(peer),
    )
    .await;
    let peer_asked_msg = run_answer(&su, &fixture, peer_asked, run.agent, 8, "text").await;

    focus_candidates(&su, &[fixture.workspace_id]).await;
    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    drain(&pool, relay.clone())
        .drain_once(64)
        .await
        .expect("drain");
    let sent = relay.sent();
    for (name, message) in [
        ("no requester", no_requester_msg),
        ("mention run", mention_msg),
        ("managed agent", managed_msg),
        ("cancelled", cancelled_msg),
        ("still running", running_msg),
        ("not the agent's answer", forged_msg),
    ] {
        let hits: Vec<_> = sent
            .iter()
            .filter(|d| d.message_id == message.to_string() && d.reason == "work_run_done")
            .collect();
        assert!(hits.is_empty(), "{name} pushed work_run_done: {hits:?}");
    }
    // The peer asked (and has a device): the peer gets it, the requester-of-record
    // being someone else means the owner (recipient) does not.
    let peer_hits: Vec<_> = sent
        .iter()
        .filter(|d| d.message_id == peer_asked_msg.to_string() && d.reason == "work_run_done")
        .collect();
    assert_eq!(peer_hits.len(), 1, "exactly the person who asked: {sent:?}");
    let peer_device: String = sqlx::query_scalar(
        "SELECT d.id::text FROM device d WHERE d.workspace_id = $1 AND d.member_id = $2",
    )
    .bind(fixture.workspace_id)
    .bind(peer)
    .fetch_one(&su)
    .await
    .expect("peer device");
    assert_eq!(peer_hits[0].device_id, peer_device);
}

/// The member's own switch governs the run push too, and turns off that kind
/// only: the requester is silent for the run, not for a plain DM.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_hosted_work_run_push_respects_the_work_complete_switch() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let (fixture, run) = run_work_fixture(&su).await;
    let requester = fixture.recipient_id;
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, work_complete_push) \
         VALUES ($1, $2, false)",
    )
    .bind(fixture.workspace_id)
    .bind(requester)
    .execute(&su)
    .await
    .expect("requester switches 작업 끝남 off");
    let done = seed_run(
        &su,
        &fixture,
        run.agent,
        "succeeded",
        90_000,
        "work",
        Some(requester),
    )
    .await;
    let done_msg = run_answer(&su, &fixture, done, run.agent, 2, "text").await;
    let dm = send_message(&su, &fixture, "hello", 3).await;

    focus_candidates(&su, &[fixture.workspace_id]).await;
    let relay = RecordingDispatcher::accepting();
    let pool = momo_notifier_pool().await;
    drain(&pool, relay.clone())
        .drain_once(64)
        .await
        .expect("drain");
    let sent = relay.sent();
    assert!(
        only_reason(&sent, "work_run_done").is_empty(),
        "the switch is off: {sent:?}"
    );
    assert!(
        sent.iter()
            .any(|d| d.message_id == dm.to_string() && d.reason == "dm"),
        "the switch is per kind — a DM still notifies: {sent:?}"
    );
    let _ = done_msg;
}

// ---------------------------------------------------------------------------
// approval requests — who is woken, and by which category (ADR-0204 D7, #3928)
// ---------------------------------------------------------------------------
//
// An `approval_request` card is pushed to the people who MAY APPROVE it — the
// decision route's own conditions, asked through the functions the route calls —
// and its category says whether the lock screen may decide it (`momo.approval`) or
// the app must open the card (`momo.approval.open`).
//
// The room below holds one person for every answer those conditions can give. The
// mirror image — the real decision route refusing exactly the people left out here
// — is measured in `momo-server/tests/approval_push_audience_conformance_pg.rs`.

/// The kinds of person an approval card can meet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum Who {
    /// A workspace owner: passes every role condition.
    Owner,
    /// A workspace admin: passes every role condition.
    Admin,
    /// A plain member: decides a tool call and nothing gated.
    Member,
    /// A plain member who owns the agent an `agent_editor` card is about.
    AgentOwner,
    /// A plain member who owns the one member-scoped work host.
    HostOwner,
}

const EVERYONE: [Who; 5] = [
    Who::Owner,
    Who::Admin,
    Who::Member,
    Who::AgentOwner,
    Who::HostOwner,
];

struct ApprovalRoom {
    workspace_id: Uuid,
    channel_id: Uuid,
    /// The agent that asks for approvals.
    requester: Uuid,
    /// The agent an `agent_editor` card names; owned by [`Who::AgentOwner`].
    pet: Uuid,
    run_id: Uuid,
    people: BTreeMap<Who, Uuid>,
    /// Every seeded device, by the wire spelling of its id → its person.
    devices: HashMap<String, Who>,
    /// A member-scoped host owned by [`Who::HostOwner`].
    laptop: Uuid,
    /// A workspace-scoped host.
    team_box: Uuid,
    seq: AtomicI64,
}

impl ApprovalRoom {
    fn id(&self, who: Who) -> Uuid {
        self.people[&who]
    }

    fn device_count(&self, who: Who) -> usize {
        self.devices.values().filter(|owner| **owner == who).count()
    }

    fn next_seq(&self) -> i64 {
        self.seq.fetch_add(1, Ordering::SeqCst)
    }
}

/// How many devices each person owns: two for an admin and a plain member, so a
/// person judged once is still pushed on every device they own (and a person
/// judged out is out on all of them).
fn device_total(who: Who) -> usize {
    match who {
        Who::Admin | Who::Member => 2,
        _ => 1,
    }
}

async fn seed_member_with(su: &PgPool, workspace: Uuid, kind: &str, handle: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
         VALUES ($1, $2, $3::member_kind, 'active', $4, $5)",
    )
    .bind(id)
    .bind(workspace)
    .bind(kind)
    .bind(handle)
    .bind(format!("{handle}-{}", id.simple()))
    .execute(su)
    .await
    .expect("seed member");
    id
}

async fn seed_workspace_role(su: &PgPool, workspace: Uuid, member: Uuid, role: &str) {
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, $3::membership_role)",
    )
    .bind(workspace)
    .bind(member)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace membership");
}

async fn seed_agent_owned_by(su: &PgPool, workspace: Uuid, handle: &str, owner: Uuid) -> Uuid {
    let agent = seed_member_with(su, workspace, "agent", handle).await;
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, \
                            max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 4, 50, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed agent");
    seed_workspace_role(su, workspace, agent, "member").await;
    agent
}

async fn seed_work_host_row(
    su: &PgPool,
    workspace: Uuid,
    scope: &str,
    owner: Uuid,
    host_type: &str,
) -> Uuid {
    let host = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO work_host (id, workspace_id, scope, owner_member_id, type, display_name, \
                                public_key, capabilities, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, clock_timestamp())",
    )
    .bind(host)
    .bind(workspace)
    .bind(scope)
    .bind(owner)
    .bind(host_type)
    .bind(format!("{scope}-host"))
    .bind("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    .execute(su)
    .await
    .expect("seed work host");
    host
}

/// One device + an active push token for `member`; returns the device id.
async fn seed_device_for(su: &PgPool, workspace: Uuid, member: Uuid) -> Uuid {
    let device = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO device (id, workspace_id, member_id, platform) \
         VALUES ($1, $2, $3, 'ios'::device_platform)",
    )
    .bind(device)
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed device");
    sqlx::query(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, 'kim.dawn.momo.e2e')",
    )
    .bind(workspace)
    .bind(device)
    .bind(member)
    .bind(Uuid::new_v4().simple().to_string().repeat(2))
    .execute(su)
    .await
    .expect("seed push token");
    device
}

async fn seed_approval_room(su: &PgPool) -> ApprovalRoom {
    let workspace_id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace_id)
        .bind(workspace_id.to_string())
        .execute(su)
        .await
        .expect("seed workspace");

    let mut people = BTreeMap::new();
    for (who, role) in [
        (Who::Owner, "owner"),
        (Who::Admin, "admin"),
        (Who::Member, "member"),
        (Who::AgentOwner, "member"),
        (Who::HostOwner, "member"),
    ] {
        let id = seed_member_with(su, workspace_id, "human", &format!("{who:?}")).await;
        seed_workspace_role(su, workspace_id, id, role).await;
        people.insert(who, id);
    }

    let requester = seed_agent_owned_by(su, workspace_id, "requester", people[&Who::Owner]).await;
    let pet = seed_agent_owned_by(su, workspace_id, "pet", people[&Who::AgentOwner]).await;

    let channel_id = Uuid::new_v4();
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(channel_id)
        .bind(workspace_id)
        .bind(format!("room-{}", &channel_id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel_id)
        .bind(workspace_id)
        .execute(su)
        .await
        .expect("seed channel_seq");
    for member in people.values().copied().chain([requester, pet]) {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(workspace_id)
        .bind(channel_id)
        .bind(member)
        .execute(su)
        .await
        .expect("seed channel membership");
    }

    let mut devices = HashMap::new();
    for (&who, &member) in &people {
        for _ in 0..device_total(who) {
            let device = seed_device_for(su, workspace_id, member).await;
            devices.insert(device.to_string(), who);
        }
    }

    let laptop =
        seed_work_host_row(su, workspace_id, "member", people[&Who::HostOwner], "app").await;
    let team_box =
        seed_work_host_row(su, workspace_id, "workspace", people[&Who::Owner], "workd").await;

    let run_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key) \
         VALUES ($1, $2, $3, $4, 'awaiting_approval'::run_status, $5, $6)",
    )
    .bind(run_id)
    .bind(workspace_id)
    .bind(requester)
    .bind(channel_id)
    .bind(json!({"type": "chat"}))
    .bind(format!("approval-room:{run_id}"))
    .execute(su)
    .await
    .expect("seed agent run");

    ApprovalRoom {
        workspace_id,
        channel_id,
        requester,
        pet,
        run_id,
        people,
        devices,
        laptop,
        team_box,
        seq: AtomicI64::new(1),
    }
}

/// An `approval_request` card and the `approval` row it renders, as the producers
/// leave them. The message insert fires the 011 trigger (one push candidate).
/// Returns `(approval id, message id)`.
async fn approval_card(
    su: &PgPool,
    room: &ApprovalRoom,
    action_type: &str,
    payload: &Value,
) -> (Uuid, Uuid) {
    let approval_id = Uuid::new_v4();
    let seq = room.next_seq();
    let message_id: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props) \
         VALUES ($1, $2, $3, $3, 0, $4, 'approval_request', 'Approve it', \
                 jsonb_build_object('approval_id', $5::text, 'action_type', $6::text)) \
         RETURNING id",
    )
    .bind(room.workspace_id)
    .bind(room.channel_id)
    .bind(seq)
    .bind(room.requester)
    .bind(approval_id.to_string())
    .bind(action_type)
    .fetch_one(su)
    .await
    .expect("insert approval_request card (fires push_candidate_enqueue_trg)");
    sqlx::query(
        "INSERT INTO approval \
           (id, workspace_id, run_id, channel_id, request_message_id, requested_by, \
            action_type, payload, status, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', now() + interval '1 hour')",
    )
    .bind(approval_id)
    .bind(room.workspace_id)
    .bind(room.run_id)
    .bind(room.channel_id)
    .bind(message_id)
    .bind(room.requester)
    .bind(action_type)
    .bind(payload)
    .execute(su)
    .await
    .expect("insert approval");
    (approval_id, message_id)
}

/// One approval shape, and what ADR-0204 D7 says about it.
struct Card {
    label: &'static str,
    action_type: &'static str,
    payload: Value,
    /// Who is woken: the people who may approve it.
    audience: Vec<Who>,
    /// `momo.approval` (the lock screen decides) or `momo.approval.open` (the app does).
    category: &'static str,
}

fn workspace_action(id: &str, pins: Value) -> Value {
    json!({"action": {"id": id, "args": {}, "pins": pins}})
}

/// An `agent.profile.update` card for the room's agent, with these arguments.
fn profile_update(room: &ApprovalRoom, args: Value) -> Value {
    json!({"action": {
        "id": "agent.profile.update",
        "args": args,
        "pins": {"target": room.pet.to_string()},
    }})
}

fn spawn_payload(
    room: &ApprovalRoom,
    default_host: Option<Uuid>,
    requested: Option<Uuid>,
) -> Value {
    json!({
        "execution": {
            "kind": "work_session_spawn",
            "tool": "codex",
            "label": "refactor",
            "requested_host_id": requested.map(|id| id.to_string()),
            "default_host_id": default_host.map(|id| id.to_string()),
            "host_candidates": [
                {"host_id": room.laptop.to_string(), "selectable": true},
                {"host_id": room.team_box.to_string(), "selectable": true},
            ],
        }
    })
}

/// Every approval shape the decision route tells apart, with the audience and the
/// category the ADR gives it. The audience column is the decision route's own rule
/// written out by hand (the route's refusals are checked against it in
/// `approval_push_audience_conformance_pg`), so this table can be read without
/// reading the code that computes it.
fn cards(room: &ApprovalRoom) -> Vec<Card> {
    let inline = "momo.approval";
    let open = "momo.approval.open";
    let admins = vec![Who::Owner, Who::Admin];
    vec![
        Card {
            label: "a tool call: any member of the room",
            action_type: "tool_call",
            payload: json!({"tool_call": {"call_id": "c1", "name": "send_message"}}),
            audience: EVERYONE.to_vec(),
            category: inline,
        },
        // Planner decision 2026-10-17: the lock screen cannot show what is being
        // approved, so these two are opened in the app.
        Card {
            label: "the login handoff: any member of the room; which session and why is read on the card",
            action_type: "tool_call",
            payload: json!({"tool_call": {
                "call_id": "c2",
                "name": "work.session.login_handoff",
                "arguments_json": {
                    "session_id": "11111111-1111-4111-8111-111111111111",
                    "reason": "로그인이 필요해요",
                },
            }}),
            audience: EVERYONE.to_vec(),
            category: open,
        },
        Card {
            label: "a tool call that names no tool: nothing says a banner is enough",
            action_type: "tool_call",
            payload: json!({"tool_call": {"call_id": "c3"}}),
            audience: EVERYONE.to_vec(),
            category: open,
        },
        Card {
            label: "agent.profile.update, words only: admins and the agent's owner; the lock screen decides",
            action_type: "workspace_action",
            payload: profile_update(room, json!({"tagline": "새 소개"})),
            audience: vec![Who::Owner, Who::Admin, Who::AgentOwner],
            category: inline,
        },
        Card {
            label: "agent.profile.update with a staged picture: admins and the agent's owner; the app shows the picture",
            action_type: "workspace_action",
            payload: profile_update(
                room,
                json!({"tagline": "새 소개", "avatar": {
                    "source": "staged",
                    "imageId": "22222222-2222-4222-8222-222222222222",
                    "sha256": "a".repeat(64),
                    "origin": "generated",
                }}),
            ),
            audience: vec![Who::Owner, Who::Admin, Who::AgentOwner],
            category: open,
        },
        Card {
            label: "agent.profile.update removing the picture: opened too — the change is to the picture",
            action_type: "workspace_action",
            payload: profile_update(room, json!({"avatar": null})),
            audience: vec![Who::Owner, Who::Admin, Who::AgentOwner],
            category: open,
        },
        Card {
            label: "agent.profile.update changing the name: the app shows the new name",
            action_type: "workspace_action",
            payload: profile_update(room, json!({"displayName": "새 이름"})),
            audience: vec![Who::Owner, Who::Admin, Who::AgentOwner],
            category: open,
        },
        Card {
            label: "member.display_name.set: the requester sees the new name in the app",
            action_type: "workspace_action",
            payload: json!({"action": {
                "id": "member.display_name.set",
                "args": {"displayName": "새 이름"},
                "pins": {"target": room.id(Who::Owner).to_string()},
            }}),
            audience: vec![Who::Owner],
            category: open,
        },
        // Not reachable (the resolver stores an object), but it is the one input on which
        // Postgres' `jsonb_exists` alone would disagree with `opens_in_app`: it says yes
        // to an array holding the text "avatar". The projection asks for an object first.
        Card {
            label: "agent.profile.update whose args are not an object: no avatar key, decided as words",
            action_type: "workspace_action",
            payload: profile_update(room, json!(["avatar", "displayName"])),
            audience: vec![Who::Owner, Who::Admin, Who::AgentOwner],
            category: inline,
        },
        Card {
            label: "channel.create: workspace admins",
            action_type: "workspace_action",
            payload: workspace_action("channel.create", json!({})),
            audience: admins.clone(),
            category: inline,
        },
        Card {
            label: "workspace.settings.update: operator, which a row can only see as an admin",
            action_type: "workspace_action",
            payload: workspace_action("workspace.settings.update", json!({})),
            audience: admins.clone(),
            category: inline,
        },
        Card {
            label: "agent.rename: admins and the target agent's owner",
            action_type: "workspace_action",
            payload: workspace_action("agent.rename", json!({"target": room.pet.to_string()})),
            audience: vec![Who::Owner, Who::Admin, Who::AgentOwner],
            category: open,
        },
        Card {
            label: "invite.create: admins; the link is shown once, so the app opens it",
            action_type: "workspace_action",
            payload: workspace_action("invite.create", json!({})),
            audience: admins.clone(),
            category: open,
        },
        Card {
            label: "agent.invite: admins; the pairing code is shown once, so the app opens it",
            action_type: "workspace_action",
            payload: workspace_action("agent.invite", json!({})),
            audience: admins.clone(),
            category: open,
        },
        // ADR-0186 증보 v5 U-e (#4703): the card quotes the first 120 characters of a message
        // that can be thousands, and a pin endorses all of it — read in the app, not decided
        // from a banner.
        Card {
            label: "message.pin: admins; the card only quotes the message, so the app opens it",
            action_type: "workspace_action",
            payload: workspace_action("message.pin", json!({})),
            audience: admins.clone(),
            category: open,
        },
        Card {
            label: "message.unpin: admins; the same card, the same app",
            action_type: "workspace_action",
            payload: workspace_action("message.unpin", json!({})),
            audience: admins.clone(),
            category: open,
        },
        // ADR-0186 증보 v5 U-c (#4704): nobody asked for this card, so a 승인 button on the lock
        // screen would consent to something its reader never looked at. `channel.create` is
        // otherwise decided inline (above); the origin alone moves it to the app.
        Card {
            label: "channel.create raised unasked (origin agent_initiated): the app opens it",
            action_type: "workspace_action",
            payload: {
                let mut payload = workspace_action("channel.create", json!({}));
                payload["origin"] = json!("agent_initiated");
                payload
            },
            audience: admins,
            category: open,
        },
        Card {
            label: "spawn onto the owner's own laptop (card default): that owner only",
            action_type: "work.spawn",
            payload: spawn_payload(room, Some(room.laptop), Some(room.laptop)),
            audience: vec![Who::HostOwner],
            category: open,
        },
        Card {
            label: "spawn the request named a laptop and the card chose nothing: that owner only",
            action_type: "work.spawn",
            payload: spawn_payload(room, None, Some(room.laptop)),
            audience: vec![Who::HostOwner],
            category: open,
        },
        Card {
            label: "spawn onto a team box: any member of the room",
            action_type: "work.spawn",
            payload: spawn_payload(room, Some(room.team_box), Some(room.team_box)),
            audience: EVERYONE.to_vec(),
            category: open,
        },
    ]
}

/// Drain the room's candidates through `pool` and return what was dispatched.
async fn drain_room(su: &PgPool, pool: &PgPool, room: &ApprovalRoom) -> Vec<PushDispatch> {
    focus_candidates(su, &[room.workspace_id]).await;
    let relay = RecordingDispatcher::accepting();
    drain(pool, relay.clone())
        .drain_once(128)
        .await
        .expect("drain");
    relay.sent()
}

fn people_woken(room: &ApprovalRoom, sent: &[PushDispatch], message: Uuid) -> BTreeSet<Who> {
    sent.iter()
        .filter(|dispatch| dispatch.message_id == message.to_string())
        .map(|dispatch| room.devices[&dispatch.device_id])
        .collect()
}

/// **ADR-0204 D7, the audience.** An approval request used to wake every human in
/// its channel — including the ones the decision route would refuse, who then held a
/// lock-screen 승인 button that answers 403. It now wakes the people who MAY approve
/// it, on every device they own.
///
/// Revert the narrowing in `judge_targets`, or make `decider_gate` ignore the
/// registry role, and the plain member is woken for an admin action.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_approval_push_goes_only_to_the_people_who_may_approve_it() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let cards = cards(&room);
    let mut sent_cards = Vec::new();
    for card in &cards {
        let (approval, message) = approval_card(&su, &room, card.action_type, &card.payload).await;
        sent_cards.push((approval, message));
    }
    let sent = drain_room(&su, &pool, &room).await;

    for (card, (approval, message)) in cards.iter().zip(&sent_cards) {
        let woken = people_woken(&room, &sent, *message);
        let expected: BTreeSet<Who> = card.audience.iter().copied().collect();
        assert_eq!(woken, expected, "{}", card.label);

        let hits: Vec<&PushDispatch> = sent
            .iter()
            .filter(|dispatch| dispatch.message_id == message.to_string())
            .collect();
        // Judged once per person, pushed on every device they own.
        let devices: usize = card
            .audience
            .iter()
            .map(|who| room.device_count(*who))
            .sum();
        assert_eq!(
            hits.len(),
            devices,
            "{}: every device of every decider",
            card.label
        );
        for hit in hits {
            assert_eq!(hit.reason, "approval_request", "{}", card.label);
            assert_eq!(
                hit.approval_id.as_deref(),
                Some(approval.to_string().as_str()),
                "{}: the push names its approval",
                card.label
            );
        }
    }
}

/// **ADR-0204 D7, the category.** The lock screen decides an approval behind Face
/// ID (`momo.approval`) except where a banner cannot do the job: an action that
/// mints a value shown once, a spawn that asks which machine, the login handoff and
/// a profile update that changes the picture (planner 2026-10-17), or a name change
/// (#4810). Those are
/// `momo.approval.open` — one 「열어서 결정」 button, no 승인·거절.
///
/// Both categories name their approval.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_approval_that_must_be_opened_is_the_open_category_and_the_rest_are_inline() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let cards = cards(&room);
    // The function the decision route calls (#3977: `via=push_action` on an approval that
    // `opens_in_app` is refused) reads the WHOLE payload; the push reads the routing
    // projection of it. A card they disagree on is a banner button the route then
    // refuses, or an app-only card the route would have decided — so the table ties the
    // three together: what is written down, what the whole-payload function says, and
    // (below) the category the projection-fed judgment actually sent.
    for card in &cards {
        assert_eq!(
            momo_agent::actions::opens_in_app(card.action_type, &card.payload),
            card.category == "momo.approval.open",
            "{}: `opens_in_app` on the whole payload must agree with the table and with the push",
            card.label
        );
    }
    let mut messages = Vec::new();
    for card in &cards {
        let (approval, message) = approval_card(&su, &room, card.action_type, &card.payload).await;
        messages.push((approval, message));
    }
    let sent = drain_room(&su, &pool, &room).await;

    for (card, (approval, message)) in cards.iter().zip(&messages) {
        let hits: Vec<&PushDispatch> = sent
            .iter()
            .filter(|dispatch| dispatch.message_id == message.to_string())
            .collect();
        assert!(!hits.is_empty(), "{}: somebody is woken", card.label);
        for hit in hits {
            assert_eq!(hit.category, card.category, "{}", card.label);
            assert_eq!(
                hit.approval_id.as_deref(),
                Some(approval.to_string().as_str()),
                "{}: both approval categories name their approval",
                card.label
            );
        }
    }
}

/// A message that merely has the type `approval_request` — no `approval` row — has
/// nobody to ask. It used to reach the relay as a `momo.approval` push with no
/// approval id, which the relay refuses with a 400 and the candidate then failed
/// permanently. It is now settled with nobody woken.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_approval_card_with_no_approval_row_pushes_nobody() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let message: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props) \
         VALUES ($1, $2, $3, $3, 0, $4, 'approval_request', 'orphan card', '{}'::jsonb) \
         RETURNING id",
    )
    .bind(room.workspace_id)
    .bind(room.channel_id)
    .bind(room.next_seq())
    .bind(room.requester)
    .fetch_one(&su)
    .await
    .expect("insert a card with no approval row");

    let sent = drain_room(&su, &pool, &room).await;
    assert!(
        people_woken(&room, &sent, message).is_empty(),
        "no approval row, nobody to ask: {sent:?}"
    );
    assert!(
        sent.iter()
            .all(|dispatch| dispatch.message_id != message.to_string()),
        "and nothing reached the relay for it"
    );
    // One claim (`attempts` counts claims), settled `done` — not parked for a retry
    // and not failed.
    assert_eq!(
        candidate_status(&su, room.workspace_id).await,
        vec![("done".to_string(), 1)],
        "the candidate is settled, not retried or failed"
    );
}

/// `approval.request_message_id` is not unique and not tied to a channel by the schema.
/// The approval a message is "the card of" must also belong to that message's own
/// channel — the route authorizes against the approval's channel, so an audience built
/// from a different one would wake the wrong room. (No producer writes this shape; the
/// join makes the structure, not the producers' good manners, the guarantee.) The
/// control is the same card before the move: a tool call, which wakes everybody.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_approval_row_of_another_channel_is_not_the_card_of_this_message() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let tool_call = json!({"tool_call": {"call_id": "c1", "name": "send_message"}});
    let (_, control) = approval_card(&su, &room, "tool_call", &tool_call).await;
    let (moved, message) = approval_card(&su, &room, "tool_call", &tool_call).await;

    let elsewhere = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', 'elsewhere')",
    )
    .bind(elsewhere)
    .bind(room.workspace_id)
    .execute(&su)
    .await
    .expect("seed another channel");
    sqlx::query("UPDATE approval SET channel_id = $2 WHERE id = $1")
        .bind(moved)
        .bind(elsewhere)
        .execute(&su)
        .await
        .expect("move the approval row to another channel");

    let sent = drain_room(&su, &pool, &room).await;
    assert_eq!(
        people_woken(&room, &sent, control).len(),
        EVERYONE.len(),
        "the unmoved tool call still wakes the whole room: {sent:?}"
    );
    assert!(
        people_woken(&room, &sent, message).is_empty(),
        "an approval row that belongs to another channel is not this message's card: {sent:?}"
    );
}

/// A person the decision route would refuse must not get the card another way. The
/// judgment CASE gives `approval_request` precedence over `mention` and `dm`, so
/// narrowing the audience has to DROP the person — not hand them the next reason.
/// In a DM with the agent, and even when the card mentions them by name, the plain
/// member hears nothing for an admin-gated card, while a tool call in the same room
/// still reaches them (so the silence is the narrowing, not a broken room).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_approval_card_a_person_may_not_decide_does_not_leak_through_a_dm_or_a_mention() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;
    let member = room.id(Who::Member);

    // A DM between the plain member and the requesting agent.
    let dm = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, dm_key) VALUES ($1, $2, 'dm', $3, $4)",
    )
    .bind(dm)
    .bind(room.workspace_id)
    .bind("dm")
    .bind(dm.simple().to_string())
    .execute(&su)
    .await
    .expect("seed dm");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(dm)
        .bind(room.workspace_id)
        .execute(&su)
        .await
        .expect("seed dm channel_seq");
    for participant in [member, room.requester] {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(room.workspace_id)
        .bind(dm)
        .bind(participant)
        .execute(&su)
        .await
        .expect("seed dm membership");
    }

    // An admin-gated card in the DM that also names the member in `props`.
    let admin_only = workspace_action("channel.create", json!({}));
    let gated = Uuid::new_v4();
    let gated_message: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props) \
         VALUES ($1, $2, 1, 1, 0, $3, 'approval_request', 'Approve it', \
                 jsonb_build_object('approval_id', $4::text, \
                                    'mention_member_ids', jsonb_build_array($5::text))) \
         RETURNING id",
    )
    .bind(room.workspace_id)
    .bind(dm)
    .bind(room.requester)
    .bind(gated.to_string())
    .bind(member.to_string())
    .fetch_one(&su)
    .await
    .expect("insert gated card in the dm");
    sqlx::query(
        "INSERT INTO approval \
           (id, workspace_id, run_id, channel_id, request_message_id, requested_by, \
            action_type, payload, status, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, 'workspace_action', $7, 'pending', \
                 now() + interval '1 hour')",
    )
    .bind(gated)
    .bind(room.workspace_id)
    .bind(room.run_id)
    .bind(dm)
    .bind(gated_message)
    .bind(room.requester)
    .bind(&admin_only)
    .execute(&su)
    .await
    .expect("insert gated approval");

    // The positive control: a tool call in the same DM, which the member may decide.
    let ungated = Uuid::new_v4();
    let ungated_message: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props) \
         VALUES ($1, $2, 2, 2, 0, $3, 'approval_request', 'Approve it', \
                 jsonb_build_object('approval_id', $4::text)) \
         RETURNING id",
    )
    .bind(room.workspace_id)
    .bind(dm)
    .bind(room.requester)
    .bind(ungated.to_string())
    .fetch_one(&su)
    .await
    .expect("insert ungated card in the dm");
    sqlx::query(
        "INSERT INTO approval \
           (id, workspace_id, run_id, channel_id, request_message_id, requested_by, \
            action_type, payload, status, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, 'tool_call', $7, 'pending', now() + interval '1 hour')",
    )
    .bind(ungated)
    .bind(room.workspace_id)
    .bind(room.run_id)
    .bind(dm)
    .bind(ungated_message)
    .bind(room.requester)
    .bind(json!({"tool_call": {"call_id": "c2", "name": "send_message"}}))
    .execute(&su)
    .await
    .expect("insert ungated approval");

    let sent = drain_room(&su, &pool, &room).await;
    let leaked: Vec<&PushDispatch> = sent
        .iter()
        .filter(|dispatch| dispatch.message_id == gated_message.to_string())
        .collect();
    assert!(
        leaked.is_empty(),
        "the member may not decide it, so it reaches them as neither approval, mention nor dm: {leaked:?}"
    );
    let control: Vec<&PushDispatch> = sent
        .iter()
        .filter(|dispatch| dispatch.message_id == ungated_message.to_string())
        .collect();
    assert_eq!(
        control.len(),
        device_total(Who::Member),
        "the same DM still reaches the member for a card they may decide: {sent:?}"
    );
    assert!(control
        .iter()
        .all(|dispatch| dispatch.reason == "approval_request"
            && dispatch.category == "momo.approval"));
}

/// The narrowing belongs to the `approval_request` REASON, not to every
/// `approval_request`-typed message. A resume offer is one of those (it groups as
/// work, and has no `approval` row): it still reaches the session's owner — a plain
/// member who could decide nothing gated — on the work category, with no approval id.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_resume_offer_keeps_its_owner_audience_with_no_approval_row() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;
    let owner_of_session = room.id(Who::Member);

    let message: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props) \
         VALUES ($1, $2, $3, $3, 0, $4, 'approval_request', 'resume?', \
                 jsonb_build_object('kind', 'resume_offer', 'owner_member_id', $5::text)) \
         RETURNING id",
    )
    .bind(room.workspace_id)
    .bind(room.channel_id)
    .bind(room.next_seq())
    .bind(room.requester)
    .bind(owner_of_session.to_string())
    .fetch_one(&su)
    .await
    .expect("insert resume offer");

    let sent = drain_room(&su, &pool, &room).await;
    let hits: Vec<&PushDispatch> = sent
        .iter()
        .filter(|dispatch| dispatch.message_id == message.to_string())
        .collect();
    assert_eq!(hits.len(), device_total(Who::Member), "{hits:?}");
    for hit in hits {
        assert_eq!(room.devices[&hit.device_id], Who::Member);
        assert_eq!(hit.reason, "resume_offer");
        assert_eq!(hit.category, "momo.work");
        assert_eq!(hit.approval_id, None);
    }
}

// ---------------------------------------------------------------------------
// an agent's answer reaches the person who asked (ADR-0204 D8, #3929)
// ---------------------------------------------------------------------------
//
// A run's closing line — the final answer, the approval-expiry result, the stall
// notice — pushes the person whose message the run answered, unless they are reading
// the channel. The wire reason is the existing `mention` (no vocabulary change).
//
// The room is the approval room: the asker is `Who::Member` (two devices), and every
// other human in it is a bystander who must hear nothing.

const ASKER: Who = Who::Member;

/// A human's message in the room — the request an agent answers. (It fires the 011
/// trigger like any message and, mentioning nobody, pushes nobody.)
async fn human_says(su: &PgPool, room: &ApprovalRoom, channel: Uuid, author: Uuid) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body) \
         VALUES ($1, $2, $3, $3, 0, $4, 'text', 'could you look at this?') RETURNING id",
    )
    .bind(room.workspace_id)
    .bind(channel)
    .bind(room.next_seq())
    .bind(author)
    .fetch_one(su)
    .await
    .expect("insert the request")
}

/// A hosted agent in the room: the dedicated sentinel agent a `hosted_agent_connection`
/// requires (migration 120's guard), a member of the room's channel.
async fn seed_hosted_sentinel(su: &PgPool, room: &ApprovalRoom) -> Uuid {
    let agent = seed_member_with(su, room.workspace_id, "agent", "hosted").await;
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, \
                            max_run_steps, owner_human_id, config) \
         VALUES ($1, $2, 'hosted-agent', 'https://hosted-agent.invalid/disabled', 4, 50, $3, \
                 jsonb_build_object('execution_mode', 'hosted_dial_in'))",
    )
    .bind(agent)
    .bind(room.workspace_id)
    .bind(room.id(Who::Owner))
    .execute(su)
    .await
    .expect("seed hosted sentinel agent");
    seed_workspace_role(su, room.workspace_id, agent, "member").await;
    sqlx::query(
        "INSERT INTO hosted_agent_connection \
           (workspace_id, agent_member_id, status, created_by, pairing_challenge_hash, \
            pairing_expires_at) \
         VALUES ($1, $2, 'pairing_pending', $3, '\\x00'::bytea, now() + interval '1 hour')",
    )
    .bind(room.workspace_id)
    .bind(agent)
    .bind(room.id(Who::Owner))
    .execute(su)
    .await
    .expect("the sentinel agent is a hosted agent");
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(room.workspace_id)
        .bind(room.channel_id)
        .bind(agent)
        .execute(su)
        .await
        .expect("the hosted agent joins the channel");
    agent
}

/// A chat run the agent raised for `trigger`.
async fn chat_run_for(
    su: &PgPool,
    room: &ApprovalRoom,
    channel: Uuid,
    trigger: Option<Uuid>,
    status: &str,
) -> Uuid {
    chat_run_by(su, room, room.requester, channel, trigger, status).await
}

async fn chat_run_by(
    su: &PgPool,
    room: &ApprovalRoom,
    agent: Uuid,
    channel: Uuid,
    trigger: Option<Uuid>,
    status: &str,
) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, trigger_message_id, status, input, \
            idempotency_key) \
         VALUES ($1, $2, $3, $4, $5, $6::run_status, $7, $8)",
    )
    .bind(run)
    .bind(room.workspace_id)
    .bind(agent)
    .bind(channel)
    .bind(trigger)
    .bind(status)
    .bind(json!({"type": "chat"}))
    .bind(format!("answer:{run}"))
    .execute(su)
    .await
    .expect("insert chat run");
    run
}

/// An agent-authored line, shaped as a producer leaves it. The knobs are the facts the
/// judgment reads: the message type, the run it belongs to, what it quotes, its props.
struct AgentLine {
    channel: Uuid,
    /// The agent that wrote it; the room's requester unless a test says otherwise.
    author: Option<Uuid>,
    message_type: &'static str,
    run: Option<Uuid>,
    reply_to: Option<Uuid>,
    props: Value,
    client_msg_id: Option<Uuid>,
}

impl AgentLine {
    fn new(channel: Uuid) -> AgentLine {
        AgentLine {
            channel,
            author: None,
            message_type: "text",
            run: None,
            reply_to: None,
            props: json!({}),
            client_msg_id: None,
        }
    }
}

async fn agent_says(su: &PgPool, room: &ApprovalRoom, line: AgentLine) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, \
            props, reply_to_id, run_id, client_msg_id) \
         VALUES ($1, $2, $3, $3, 0, $4, $5::message_type, 'an agent line', $6, $7, $8, $9) \
         RETURNING id",
    )
    .bind(room.workspace_id)
    .bind(line.channel)
    .bind(room.next_seq())
    .bind(line.author.unwrap_or(room.requester))
    .bind(line.message_type)
    .bind(&line.props)
    .bind(line.reply_to)
    .bind(line.run)
    .bind(line.client_msg_id)
    .fetch_one(su)
    .await
    .expect("insert agent line (fires push_candidate_enqueue_trg)")
}

/// The final answer of `run`, exactly as the worker and the gateway write it:
/// quoting the request, keyed by the run id.
async fn final_answer(su: &PgPool, room: &ApprovalRoom, run: Uuid, request: Uuid) -> Uuid {
    final_answer_by(su, room, room.requester, run, request).await
}

async fn final_answer_by(
    su: &PgPool,
    room: &ApprovalRoom,
    agent: Uuid,
    run: Uuid,
    request: Uuid,
) -> Uuid {
    agent_says(
        su,
        room,
        AgentLine {
            author: Some(agent),
            run: Some(run),
            reply_to: Some(request),
            client_msg_id: Some(run),
            ..AgentLine::new(room.channel_id)
        },
    )
    .await
}

fn hits_for(sent: &[PushDispatch], message: Uuid) -> Vec<&PushDispatch> {
    sent.iter()
        .filter(|dispatch| dispatch.message_id == message.to_string())
        .collect()
}

async fn set_read_cursor(su: &PgPool, room: &ApprovalRoom, who: Who, last_read_at_sql: &str) {
    set_read_cursor_at(su, room, who, 1, last_read_at_sql).await;
}

/// The asker's read cursor in the room's channel: it reached `last_read_seq` at
/// `last_read_at_sql` (a SQL timestamp expression).
async fn set_read_cursor_at(
    su: &PgPool,
    room: &ApprovalRoom,
    who: Who,
    last_read_seq: i64,
    last_read_at_sql: &str,
) {
    sqlx::query(&format!(
        "INSERT INTO read_state (workspace_id, channel_id, member_id, last_read_seq, last_read_at) \
         VALUES ($1, $2, $3, $4, {last_read_at_sql}) \
         ON CONFLICT (channel_id, member_id) DO UPDATE \
            SET last_read_seq = $4, last_read_at = {last_read_at_sql}"
    ))
    .bind(room.workspace_id)
    .bind(room.channel_id)
    .bind(room.id(who))
    .bind(last_read_seq)
    .execute(su)
    .await
    .expect("set the read cursor");
}

/// A message's `seq` — what a read cursor has to reach to "cover" it.
async fn message_seq(su: &PgPool, message: Uuid) -> i64 {
    sqlx::query_scalar("SELECT seq FROM message WHERE id = $1")
        .bind(message)
        .fetch_one(su)
        .await
        .expect("read the seq of a message")
}

/// Make a message look `secs` old: it was written that long ago. (For a streamed answer
/// the row's `created_at` is its OPENING slice — "the stream opened two minutes ago".)
async fn age_message(su: &PgPool, message: Uuid, secs: i64) {
    sqlx::query("UPDATE message SET created_at = now() - make_interval(secs => $2::double precision) WHERE id = $1")
        .bind(message)
        .bind(secs as f64)
        .execute(su)
        .await
        .expect("age the message");
}

/// Bring the channel counter up to the rows a fixture wrote by hand, so a real send takes
/// the next sequence like any other.
async fn catch_up_channel_seq(su: &PgPool, channel_id: Uuid) {
    sqlx::query(
        "UPDATE channel_seq SET last_seq = COALESCE((SELECT max(seq) FROM message WHERE channel_id = $1), 0) \
          WHERE channel_id = $1",
    )
    .bind(channel_id)
    .execute(su)
    .await
    .expect("channel_seq catch-up");
}

/// The OPENING slice of a streamed answer, written by the real `send_message_in_tx` the
/// way `MessageStream::open` writes it (`bins/momo-agent-worker/src/stream.rs`) and the
/// REST streamers' opening `POST` does: the first words, `momo.stream.streaming = true`
/// from the first byte, the quote and the run from the first slice, `client_msg_id` =
/// the run id. This INSERT is what the 011 trigger turns into a candidate.
async fn open_streamed_answer(su: &PgPool, room: &ApprovalRoom, run: Uuid, request: Uuid) -> Uuid {
    open_streamed_answer_in(su, room, room.channel_id, run, request, json!({})).await
}

/// [`open_streamed_answer`] in any channel of the room, with `extra_props` merged into the
/// opening props (a REST streamer's opening names the quoted author in `mention_member_ids`).
async fn open_streamed_answer_in(
    su: &PgPool,
    room: &ApprovalRoom,
    channel_id: Uuid,
    run: Uuid,
    request: Uuid,
    extra_props: Value,
) -> Uuid {
    catch_up_channel_seq(su, channel_id).await;
    let workspace = room.workspace_id;
    let mut props = json!({
        "source": "agent_worker.final_text.v0",
        "run_id": run,
        STREAM_PROPS_KEY.to_string(): opening_stream_props(),
    });
    if let (Some(into), Some(extra)) = (props.as_object_mut(), extra_props.as_object()) {
        into.extend(extra.clone());
    }
    let input = NewMessage {
        channel_id,
        author_member_id: room.requester,
        message_type: MessageType::Text,
        body: Some("네, 확인해 볼게요".to_string()),
        props,
        root_id: None,
        reply_to_id: Some(request),
        client_msg_id: Some(run),
        run_id: Some(run),
        hlc_ts: None,
        hlc_count: None,
    };
    with_tenant_tx(su, workspace, move |conn| {
        Box::pin(async move { send_message_in_tx(conn, workspace, input).await })
    })
    .await
    .expect("open the streamed answer")
    .message
    .id
}

/// One write of the streaming edit contract, by the real `stream_message_body_in_tx`:
/// revision `rev`, final or not, optionally carrying how the stream ended.
async fn write_stream_slice(
    su: &PgPool,
    room: &ApprovalRoom,
    message: Uuid,
    rev: i64,
    is_final: bool,
    outcome: Option<StreamCloseOutcome>,
) -> StreamOutcome {
    write_stream_edit(su, room, message, rev, is_final, outcome, false).await
}

/// [`write_stream_slice`] that can also be the worker's PROVISIONAL freeze — the close a
/// retried turn leaves between two attempts, which the writer says is not the answer's end.
async fn write_stream_edit(
    su: &PgPool,
    room: &ApprovalRoom,
    message: Uuid,
    rev: i64,
    is_final: bool,
    outcome: Option<StreamCloseOutcome>,
    provisional: bool,
) -> StreamOutcome {
    let workspace = room.workspace_id;
    let author = room.requester;
    with_tenant_tx(su, workspace, move |conn| {
        Box::pin(async move {
            let applied = stream_message_body_in_tx(
                conn,
                workspace,
                message,
                author,
                if is_final {
                    "네, 확인했어요. 결과는 이래요."
                } else {
                    "네, 확인해 볼게요. 먼저 살펴보면"
                },
                StreamEdit {
                    rev,
                    is_final,
                    outcome,
                    provisional,
                },
            )
            .await?;
            Ok::<_, DbError>(applied.expect("the domain did not refuse the slice"))
        })
    })
    .await
    .expect("write the slice")
}

/// The CLOSING slice of that answer — what `commit_turn` writes inside the transaction
/// that ends the run, and what a REST streamer's last `PATCH` does. `streaming` goes
/// `true -> false`; the stream's revision after the opening is 1.
async fn close_streamed_answer(
    su: &PgPool,
    room: &ApprovalRoom,
    message: Uuid,
    outcome: Option<StreamCloseOutcome>,
) {
    let applied = write_stream_slice(su, room, message, 1, true, outcome).await;
    assert!(
        matches!(applied, StreamOutcome::Applied(_)),
        "the closing slice was not applied: {applied:?}"
    );
}

/// How many push candidates exist for `message` — the 011 trigger's one per INSERT, plus
/// the stream close's.
async fn candidates_of(su: &PgPool, message: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE kind = 'push_candidate' AND payload->>'message_id' = $1",
    )
    .bind(message.to_string())
    .fetch_one(su)
    .await
    .expect("count the candidates of a message")
}

/// How many of them were enqueued by a stream's closing write (`source: stream_closed`).
async fn closing_candidates_of(su: &PgPool, message: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE kind = 'push_candidate' AND payload->>'message_id' = $1 \
            AND payload->>'source' = 'stream_closed'",
    )
    .bind(message.to_string())
    .fetch_one(su)
    .await
    .expect("count the closing candidates of a message")
}

/// [`drain_room`] that also hands back the drain's tally — "claimed 0" is the proof that
/// nothing was waiting to be judged, "skipped_already_settled" that a person was already
/// pushed for the message.
async fn drain_room_full(
    su: &PgPool,
    pool: &PgPool,
    room: &ApprovalRoom,
) -> (momo_notifier::DrainStats, Vec<PushDispatch>) {
    focus_candidates(su, &[room.workspace_id]).await;
    let relay = RecordingDispatcher::accepting();
    let stats = drain(pool, relay.clone())
        .drain_once(128)
        .await
        .expect("drain");
    (stats, relay.sent())
}

/// [`drain_room`] that also says how many candidates the drain claimed.
async fn drain_room_counted(
    su: &PgPool,
    pool: &PgPool,
    room: &ApprovalRoom,
) -> (usize, Vec<PushDispatch>) {
    let (stats, sent) = drain_room_full(su, pool, room).await;
    (stats.claimed, sent)
}

/// A DM between `member` and the room's agent; returns its channel id.
async fn seed_dm(su: &PgPool, room: &ApprovalRoom, member: Uuid) -> Uuid {
    let dm = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, dm_key) VALUES ($1, $2, 'dm', 'dm', $3)",
    )
    .bind(dm)
    .bind(room.workspace_id)
    .bind(dm.simple().to_string())
    .execute(su)
    .await
    .expect("seed dm");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(dm)
        .bind(room.workspace_id)
        .execute(su)
        .await
        .expect("seed dm channel_seq");
    for participant in [member, room.requester] {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(room.workspace_id)
        .bind(dm)
        .bind(participant)
        .execute(su)
        .await
        .expect("seed dm membership");
    }
    dm
}

/// **The point of D8.** A person asks an agent something in a channel and walks away.
/// The agent's answer used to reach nobody (the mention record is a Skip path, and the
/// answer mentions no one): the person found out by opening the app. It now pushes
/// them — and only them, on every device they own, as a `mention` with no approval id.
///
/// The question itself pushes nobody (a control: a human message that mentions no one).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_agents_answer_pushes_the_person_who_asked_and_nobody_else() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "succeeded").await;
    let answer = final_answer(&su, &room, run, question).await;

    let sent = drain_room(&su, &pool, &room).await;
    assert!(
        hits_for(&sent, question).is_empty(),
        "a question that mentions nobody pushes nobody: {sent:?}"
    );
    assert_eq!(
        people_woken(&room, &sent, answer),
        BTreeSet::from([ASKER]),
        "only the person who asked: {sent:?}"
    );
    let hits = hits_for(&sent, answer);
    assert_eq!(hits.len(), device_total(ASKER), "every device they own");
    for hit in hits {
        assert_eq!(hit.reason, "mention");
        assert_eq!(hit.category, "momo.mention");
        assert_eq!(hit.approval_id, None);
    }
}

/// "Seen" is the 30 s window the work reasons already use (ADR-0120 부록 A-8): a person
/// whose read cursor moved in the channel is looking at it, and the answer is already
/// in front of them. The control is the same answer for somebody whose cursor is
/// five minutes old — so the silence is the window, not the shape of the answer.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_answer_is_held_back_while_the_asker_is_reading_the_channel() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let watcher = Who::Member;
    let away = Who::AgentOwner;
    set_read_cursor(&su, &room, watcher, "now()").await;
    set_read_cursor(&su, &room, away, "now() - interval '5 minutes'").await;

    let mut answers = Vec::new();
    for asker in [watcher, away] {
        let question = human_says(&su, &room, room.channel_id, room.id(asker)).await;
        let run = chat_run_for(&su, &room, room.channel_id, Some(question), "succeeded").await;
        answers.push((asker, final_answer(&su, &room, run, question).await));
    }

    let sent = drain_room(&su, &pool, &room).await;
    for (asker, answer) in answers {
        let woken = people_woken(&room, &sent, answer);
        if asker == watcher {
            assert!(
                woken.is_empty(),
                "{asker:?} is reading the channel: {sent:?}"
            );
        } else {
            assert_eq!(
                woken,
                BTreeSet::from([asker]),
                "{asker:?} is away: {sent:?}"
            );
        }
    }
}

/// The other two lines a run can end on are written by sweeps, and the sweeps are what
/// stamp `props.answers_message_id`. So this runs the REAL sweeps against a real run and
/// real approval and reads what they wrote — a hand-built line would prove the judgment
/// and leave the producers untested.
///
/// * an approval that lapsed with nobody deciding → the expiry result line;
/// * a hosted run whose agent went quiet for hours → the stall notice.
///
/// Each pushes the person who asked (and nobody else), and each carries the marker.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_expired_approval_and_a_stalled_run_reach_the_person_who_asked_through_the_real_sweeps()
{
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;
    let asker = room.id(ASKER);

    // ---- an approval that lapsed ---------------------------------------------
    let question = human_says(&su, &room, room.channel_id, asker).await;
    let parked = chat_run_for(
        &su,
        &room,
        room.channel_id,
        Some(question),
        "awaiting_approval",
    )
    .await;
    let approval = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO approval \
           (id, workspace_id, run_id, channel_id, requested_by, action_type, payload, status, \
            expires_at) \
         VALUES ($1, $2, $3, $4, $5, 'tool_call', $6, 'pending', now() - interval '1 minute')",
    )
    .bind(approval)
    .bind(room.workspace_id)
    .bind(parked)
    .bind(room.channel_id)
    .bind(room.requester)
    .bind(json!({"tool_call": {"call_id": "c9", "name": "send_message"}}))
    .execute(&su)
    .await
    .expect("insert an overdue approval");

    // Approval outcomes now update their own card; give this fixture the card
    // the real producer creates, and preserve its server-owned run association.
    let expiry_card: Uuid = sqlx::query_scalar(
        "INSERT INTO message(workspace_id,channel_id,seq,hlc_ts,hlc_count,author_member_id,type,body,props,run_id) \
         VALUES($1,$2,$3,$3,0,$4,'approval_request','도구 실행 승인', \
             jsonb_build_object('approval_id',$5::text,'status','pending'),$6) RETURNING id")
        .bind(room.workspace_id).bind(room.channel_id).bind(room.next_seq())
        .bind(room.requester).bind(approval.to_string()).bind(parked)
        .fetch_one(&su).await.unwrap();
    sqlx::query("UPDATE approval SET request_message_id=$2 WHERE id=$1")
        .bind(approval)
        .bind(expiry_card)
        .execute(&su)
        .await
        .unwrap();

    // ---- a hosted run that went quiet ----------------------------------------
    let stalled_question = human_says(&su, &room, room.channel_id, asker).await;
    let hosted = seed_hosted_sentinel(&su, &room).await;
    let stalled = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, trigger_message_id, status, input, \
            idempotency_key, started_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, now() - interval '5 hours', \
                 now() - interval '4 hours')",
    )
    .bind(stalled)
    .bind(room.workspace_id)
    .bind(hosted)
    .bind(room.channel_id)
    .bind(stalled_question)
    .bind(json!({"type": "chat"}))
    .bind(format!("answer:{stalled}"))
    .execute(&su)
    .await
    .expect("insert a stalled hosted run");

    // The fixture wrote its messages by hand; bring the channel counter up to them so
    // the sweeps' lines take the next sequence like any real send.
    sqlx::query(
        "UPDATE channel_seq SET last_seq = COALESCE((SELECT max(seq) FROM message WHERE channel_id = $1), 0) \
          WHERE channel_id = $1",
    )
    .bind(room.channel_id)
    .execute(&su)
    .await
    .expect("channel_seq catch-up");

    // The sweeps are global and batched (32 per pass): a database that earlier runs
    // left overdue rows in hands them out oldest first, so one pass may not reach this
    // fixture's rows. Sweep until a pass finds nothing — the fixture's rows are among
    // what gets settled, wherever they sit in the queue.
    let mut expired_total = 0;
    for _ in 0..50 {
        let pass = momo_notifier::approval_sweep::sweep_expired_approvals(&pool, 32)
            .await
            .expect("approval expiry sweep");
        expired_total += pass.expired;
        if pass.expired == 0 {
            break;
        }
    }
    assert!(expired_total >= 1, "the overdue approval was swept");
    let mut abandoned_total = 0;
    for _ in 0..50 {
        let pass = momo_notifier::run_stall_sweep::sweep_stalled_runs(
            &pool,
            momo_outbox::StallPolicy::default(),
            32,
        )
        .await
        .expect("run stall sweep");
        abandoned_total += pass.lease_abandoned;
        if pass.lease_abandoned == 0 && pass.unclaimed_expired == 0 {
            break;
        }
    }
    assert!(abandoned_total >= 1, "the stalled run was swept");

    let expiry_line = expiry_card;
    let expired_status: String =
        sqlx::query_scalar("SELECT props->>'status' FROM message WHERE id=$1")
            .bind(expiry_card)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(expired_status, "expired");
    let stall_line: Uuid = sqlx::query_scalar(
        "SELECT id FROM message WHERE workspace_id = $1 AND run_id = $2 \
            AND props->>'kind' = 'agent_run_timed_out'",
    )
    .bind(room.workspace_id)
    .bind(stalled)
    .fetch_one(&su)
    .await
    .expect("the sweep wrote the stall notice");

    // What the producers stamped (read back, not assumed).
    for (line, request) in [(stall_line, stalled_question)] {
        let stamped: Option<String> =
            sqlx::query_scalar("SELECT props->>'answers_message_id' FROM message WHERE id = $1")
                .bind(line)
                .fetch_one(&su)
                .await
                .expect("read the marker");
        assert_eq!(stamped.as_deref(), Some(request.to_string().as_str()));
    }

    let sent = drain_room(&su, &pool, &room).await;
    for (what, line) in [
        ("approval expiry", expiry_line),
        ("stall notice", stall_line),
    ] {
        assert_eq!(
            people_woken(&room, &sent, line),
            BTreeSet::from([ASKER]),
            "{what}: only the person who asked: {sent:?}"
        );
        let hits = hits_for(&sent, line);
        assert_eq!(hits.len(), device_total(ASKER), "{what}");
        for hit in hits {
            assert_eq!(hit.reason, "mention", "{what}");
            assert_eq!(hit.category, "momo.mention", "{what}");
            assert_eq!(hit.approval_id, None, "{what}");
        }
    }
}

/// ADR-0113 증보 2 E8 (#4054): the stall sweep's line says `site_silent` — the SERVER's
/// observation of a lease nobody renewed — and only for an agent that has apps attached.
/// An agent without apps keeps the line it always had. Run through the REAL sweep.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn the_stall_sweeps_line_says_site_silent_only_for_an_agent_with_apps() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;
    let asker = room.id(ASKER);

    let plain = seed_hosted_sentinel(&su, &room).await;
    let with_apps = seed_hosted_sentinel(&su, &room).await;
    sqlx::query("UPDATE agent SET connector_owner_human_id = owner_human_id WHERE member_id = $1")
        .bind(with_apps)
        .execute(&su)
        .await
        .expect("attach apps to one agent");

    let mut runs = Vec::new();
    for agent in [plain, with_apps] {
        let question = human_says(&su, &room, room.channel_id, asker).await;
        let run = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO agent_run \
               (id, workspace_id, agent_member_id, channel_id, trigger_message_id, status, input, \
                idempotency_key, started_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, now() - interval '5 hours', \
                     now() - interval '4 hours')",
        )
        .bind(run)
        .bind(room.workspace_id)
        .bind(agent)
        .bind(room.channel_id)
        .bind(question)
        .bind(json!({"type": "chat"}))
        .bind(format!("answer:{run}"))
        .execute(&su)
        .await
        .expect("insert a stalled hosted run");
        runs.push(run);
    }
    // …and a queued run whose job no site took for a day (the unclaimed case).
    let unclaimed_question = human_says(&su, &room, room.channel_id, asker).await;
    let unclaimed = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, trigger_message_id, status, input, \
            idempotency_key, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, now() - interval '30 hours', \
                 now() - interval '30 hours')",
    )
    .bind(unclaimed)
    .bind(room.workspace_id)
    .bind(with_apps)
    .bind(room.channel_id)
    .bind(unclaimed_question)
    .bind(json!({"type": "chat"}))
    .bind(format!("answer:{unclaimed}"))
    .execute(&su)
    .await
    .expect("insert an unclaimed hosted run");
    sqlx::query(
        "INSERT INTO outbox (workspace_id, kind, method, payload, partition_key) \
         VALUES ($1, 'agent_job', 'publish', $2, $3)",
    )
    .bind(room.workspace_id)
    .bind(json!({"run_id": unclaimed.to_string()}))
    .bind(with_apps)
    .execute(&su)
    .await
    .expect("the job nobody claimed");
    sqlx::query(
        "UPDATE channel_seq SET last_seq = COALESCE((SELECT max(seq) FROM message WHERE channel_id = $1), 0) \
          WHERE channel_id = $1",
    )
    .bind(room.channel_id)
    .execute(&su)
    .await
    .expect("channel_seq catch-up");

    for _ in 0..50 {
        let pass = momo_notifier::run_stall_sweep::sweep_stalled_runs(
            &pool,
            momo_outbox::StallPolicy::default(),
            32,
        )
        .await
        .expect("run stall sweep");
        if pass.lease_abandoned == 0 && pass.unclaimed_expired == 0 {
            break;
        }
    }

    let notice_of = |run: Uuid| {
        let su = &su;
        let workspace = room.workspace_id;
        async move {
            sqlx::query_scalar::<_, Value>(
                "SELECT props FROM message WHERE workspace_id = $1 AND run_id = $2 \
                    AND props->>'kind' = 'agent_run_timed_out'",
            )
            .bind(workspace)
            .bind(run)
            .fetch_one(su)
            .await
            .expect("the sweep wrote the stall notice")
        }
    };
    let plain_props = notice_of(runs[0]).await;
    assert!(
        plain_props.get("app_notice").is_none(),
        "an agent without apps keeps its line: {plain_props}"
    );
    let app_props = notice_of(runs[1]).await;
    assert_eq!(
        app_props["app_notice"],
        json!({"kind": "site_silent"}),
        "the server's own observation, no `site`: {app_props}"
    );
    // A job no site took is no site there to answer, not a quiet one.
    let unclaimed_props = notice_of(unclaimed).await;
    assert_eq!(unclaimed_props["code"], json!("unclaimed_expired"));
    assert_eq!(unclaimed_props["app_notice"], json!({"kind": "site_off"}));
}

/// A DM already pushes every message to the other person, as `dm`, with no reading
/// window. An agent's answer in a DM is such a message and keeps all of that: the
/// answer arm is for everywhere else. (Putting it above `dm` would turn DM answers into
/// `mention`s and start suppressing them for a reader — a regression.)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_dm_keeps_its_dm_reason_for_an_agents_answer_and_ignores_the_window() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;
    let asker = room.id(ASKER);

    let dm = seed_dm(&su, &room, asker).await;
    // The asker is reading the DM right now — which would hold back an answer
    // anywhere else.
    sqlx::query(
        "INSERT INTO read_state (workspace_id, channel_id, member_id, last_read_seq, last_read_at) \
         VALUES ($1, $2, $3, 1, now())",
    )
    .bind(room.workspace_id)
    .bind(dm)
    .bind(asker)
    .execute(&su)
    .await
    .expect("the asker is reading the dm");

    let question = human_says(&su, &room, dm, asker).await;
    let run = chat_run_for(&su, &room, dm, Some(question), "succeeded").await;
    let answer = agent_says(
        &su,
        &room,
        AgentLine {
            run: Some(run),
            reply_to: Some(question),
            client_msg_id: Some(run),
            ..AgentLine::new(dm)
        },
    )
    .await;

    let sent = drain_room(&su, &pool, &room).await;
    let hits = hits_for(&sent, answer);
    assert_eq!(
        hits.len(),
        device_total(ASKER),
        "the DM peer is pushed whether or not they are reading: {sent:?}"
    );
    for hit in hits {
        assert_eq!(hit.reason, "dm");
        assert_eq!(hit.category, "momo.message");
    }
}

/// The rule is "an agent's line that ANSWERS a person's message, in a run". Everything
/// else an agent writes stays as quiet as it was — and several of those lines sit next
/// to the answer in the same channel, belong to the same run, or quote the same
/// message. Each is built here and none may push the asker:
///
/// * a tool call and a tool result (the run's progress), and a rejection-shaped result:
///   a run, no marker;
/// * the hosted-skip notice: a run, and it names `props.trigger_message_id` — a
///   different key on purpose, so it stays silent;
/// * a work-session card: it quotes the owner's message, but belongs to no run;
/// * a human's reply to the asker: a quote, but not an agent's line.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn agent_lines_that_answer_nobody_stay_silent() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "running").await;

    let mut quiet = Vec::new();
    for (label, line) in [
        (
            "a tool call of the run",
            AgentLine {
                message_type: "tool_call",
                run: Some(run),
                ..AgentLine::new(room.channel_id)
            },
        ),
        (
            "a tool result of the run",
            AgentLine {
                message_type: "tool_result",
                run: Some(run),
                ..AgentLine::new(room.channel_id)
            },
        ),
        (
            "a rejection-shaped result (run, approval props, no marker)",
            AgentLine {
                message_type: "tool_result",
                run: Some(run),
                props: json!({"status": "rejected", "approval_id": Uuid::new_v4().to_string()}),
                ..AgentLine::new(room.channel_id)
            },
        ),
        (
            "the hosted-skip notice (names props.trigger_message_id, not the marker)",
            AgentLine {
                message_type: "system",
                run: Some(run),
                props: json!({"kind": "hosted_skip_notice",
                              "trigger_message_id": question.to_string(),
                              "notice_for_member_id": room.id(ASKER).to_string()}),
                client_msg_id: Some(Uuid::new_v4()),
                ..AgentLine::new(room.channel_id)
            },
        ),
        (
            "a work-session card that quotes the asker's message but belongs to no run",
            AgentLine {
                message_type: "system",
                reply_to: Some(question),
                props: json!({"kind": "work_session"}),
                ..AgentLine::new(room.channel_id)
            },
        ),
    ] {
        quiet.push((label, agent_says(&su, &room, line).await));
    }
    // A human replying to the asker's message: a quote, but not an agent's line.
    let neighbour = room.id(Who::AgentOwner);
    let human_reply: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, \
            reply_to_id, run_id) \
         VALUES ($1, $2, $3, $3, 0, $4, 'text', 'I think so too', $5, $6) RETURNING id",
    )
    .bind(room.workspace_id)
    .bind(room.channel_id)
    .bind(room.next_seq())
    .bind(neighbour)
    .bind(question)
    .bind(run)
    .fetch_one(&su)
    .await
    .expect("insert a human reply");
    quiet.push((
        "a human's reply to the asker (even one tagged with the run)",
        human_reply,
    ));
    // The control: the run's real final answer, in the same drain. It pushes the asker,
    // so the silence of everything above is the shape of those lines — not a judgment
    // that has stopped pushing anybody.
    let control = final_answer(&su, &room, run, question).await;

    let sent = drain_room(&su, &pool, &room).await;
    assert_eq!(
        people_woken(&room, &sent, control),
        BTreeSet::from([ASKER]),
        "the control answer reaches the asker, so a silent line is silent on its own merits: {sent:?}"
    );
    for (label, message) in quiet {
        assert!(
            hits_for(&sent, message).is_empty(),
            "{label} must not push anybody: {sent:?}"
        );
    }
}

/// Two ways a quote can point somewhere that is not "the person who asked":
///
/// * at a message in ANOTHER channel (an agent's `reply_to_id` is not trusted to stay
///   in the room — the answer is for the room it is in);
/// * at a message another AGENT wrote (agent-to-agent delegation): there is no person
///   to push.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_answer_to_a_message_elsewhere_or_by_an_agent_pushes_no_one() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    // A second channel with the asker in it, and a request of theirs there.
    let elsewhere = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', 'elsewhere')",
    )
    .bind(elsewhere)
    .bind(room.workspace_id)
    .execute(&su)
    .await
    .expect("seed other channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(elsewhere)
        .bind(room.workspace_id)
        .execute(&su)
        .await
        .expect("seed other channel_seq");
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3), ($1, $2, $4)",
    )
    .bind(room.workspace_id)
    .bind(elsewhere)
    .bind(room.id(ASKER))
    .bind(room.requester)
    .execute(&su)
    .await
    .expect("seed other channel members");
    let faraway_question = human_says(&su, &room, elsewhere, room.id(ASKER)).await;

    let run = chat_run_for(&su, &room, room.channel_id, None, "succeeded").await;
    let stray = agent_says(
        &su,
        &room,
        AgentLine {
            run: Some(run),
            reply_to: Some(faraway_question),
            client_msg_id: Some(run),
            ..AgentLine::new(room.channel_id)
        },
    )
    .await;

    // A message another agent wrote, which this agent answers.
    let delegation = agent_says(&su, &room, AgentLine::new(room.channel_id)).await;
    let child = chat_run_for(&su, &room, room.channel_id, Some(delegation), "succeeded").await;
    let reply = agent_says(
        &su,
        &room,
        AgentLine {
            run: Some(child),
            reply_to: Some(delegation),
            client_msg_id: Some(child),
            ..AgentLine::new(room.channel_id)
        },
    )
    .await;

    // The control: an ordinary answer to the asker's message in THIS channel, same drain.
    let here = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let here_run = chat_run_for(&su, &room, room.channel_id, Some(here), "succeeded").await;
    let control = final_answer(&su, &room, here_run, here).await;

    let sent = drain_room(&su, &pool, &room).await;
    assert_eq!(
        people_woken(&room, &sent, control),
        BTreeSet::from([ASKER]),
        "the control answer reaches the asker, so the two silences below are the rule, \
         not a judgment that pushes nobody: {sent:?}"
    );
    assert!(
        hits_for(&sent, stray).is_empty(),
        "a quote of a message in another channel answers nobody here: {sent:?}"
    );
    assert!(
        hits_for(&sent, reply).is_empty(),
        "an answer to an agent's message has no person to push: {sent:?}"
    );
}

/// An explicit mention keeps its own rules when the same line also answers somebody:
/// a person named in the answer is pushed whether or not they are reading (mentions
/// have no window), and the asker — the other person — is held back while they read.
/// Nobody gets two pushes for one line.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_answer_that_mentions_somebody_keeps_the_mention_rules() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;
    let named = Who::AgentOwner;

    set_read_cursor(&su, &room, ASKER, "now()").await;
    set_read_cursor(&su, &room, named, "now()").await;

    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "succeeded").await;
    let answer = agent_says(
        &su,
        &room,
        AgentLine {
            run: Some(run),
            reply_to: Some(question),
            client_msg_id: Some(run),
            props: json!({"mention_member_ids": [room.id(named).to_string()]}),
            ..AgentLine::new(room.channel_id)
        },
    )
    .await;

    let sent = drain_room(&su, &pool, &room).await;
    assert_eq!(
        people_woken(&room, &sent, answer),
        BTreeSet::from([named]),
        "the person named is pushed although they are reading; the asker is reading too, \
         so is held back: {sent:?}"
    );
    let hits = hits_for(&sent, answer);
    assert_eq!(
        hits.len(),
        device_total(named),
        "one push per device, one reason"
    );
    assert!(hits.iter().all(|hit| hit.reason == "mention"));
}

/// A hosted `type=work` run's final answer is `work_run_done` for the person who asked
/// for the run — one reason per message, and `work_run_done` is above the answer arm. A
/// work answer that (artificially) quotes a message must not turn into a `mention`.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_work_run_answer_stays_work_run_done_for_its_requester() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;
    let requester = room.id(ASKER);

    let hosted = seed_hosted_sentinel(&su, &room).await;
    let question = human_says(&su, &room, room.channel_id, requester).await;
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, trigger_message_id, status, input, \
            idempotency_key, started_at, finished_at) \
         VALUES ($1, $2, $3, $4, $5, 'succeeded', $6, $7, now() - interval '90 seconds', now())",
    )
    .bind(run)
    .bind(room.workspace_id)
    .bind(hosted)
    .bind(room.channel_id)
    .bind(question)
    .bind(json!({"type": "work"}))
    .bind(format!("answer:{run}"))
    .execute(&su)
    .await
    .expect("insert a finished work run");
    sqlx::query(
        "INSERT INTO audit_log (workspace_id, actor_member_id, action, target_type, target_id, run_id) \
         VALUES ($1, $2, 'agent.work.queued', 'agent_run', $3, $3)",
    )
    .bind(room.workspace_id)
    .bind(requester)
    .bind(run)
    .execute(&su)
    .await
    .expect("the requester's queued row");
    let answer = final_answer_by(&su, &room, hosted, run, question).await;

    let sent = drain_room(&su, &pool, &room).await;
    let hits = hits_for(&sent, answer);
    assert_eq!(hits.len(), device_total(ASKER), "{hits:?}");
    for hit in hits {
        assert_eq!(hit.reason, "work_run_done", "one reason per message");
        assert_eq!(hit.category, "momo.work");
    }
}

/// An answer is a `mention` for the person who asked, so the settings that govern a
/// mention govern it: DND silences it, a muted channel silences it, a person who left
/// the channel is no longer in it — and 「멘션은 예외」 (ADR-0124 증보 1) lets it through
/// the mute, exactly as it does for an @mention. ADR-0204 D8 does not say; this pins the
/// reading the wire reason `mention` gives. (If a muted channel should silence an answer
/// even for somebody who kept the exception, that is one more `CASE` arm — a decision.)
///
/// Five people each ask once and are answered once; the plain asker is the control.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn the_askers_own_settings_still_apply_to_an_answer() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let plain = ASKER;
    let left = Who::Owner;
    let muted = Who::Admin;
    let muted_but_excepting = Who::AgentOwner;
    let asleep = Who::HostOwner;

    let mut answers = Vec::new();
    for asker in [plain, left, muted, muted_but_excepting, asleep] {
        let question = human_says(&su, &room, room.channel_id, room.id(asker)).await;
        let run = chat_run_for(&su, &room, room.channel_id, Some(question), "succeeded").await;
        answers.push((asker, final_answer(&su, &room, run, question).await));
    }

    sqlx::query(
        "UPDATE membership SET left_at = now() \
          WHERE workspace_id = $1 AND channel_id = $2 AND member_id = $3",
    )
    .bind(room.workspace_id)
    .bind(room.channel_id)
    .bind(room.id(left))
    .execute(&su)
    .await
    .expect("one asker leaves the channel");
    for who in [muted, muted_but_excepting] {
        sqlx::query(
            "INSERT INTO notification_pref (workspace_id, channel_id, member_id, muted_until) \
             VALUES ($1, $2, $3, now() + interval '1 day')",
        )
        .bind(room.workspace_id)
        .bind(room.channel_id)
        .bind(room.id(who))
        .execute(&su)
        .await
        .expect("mute the channel");
    }
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, mention_overrides_mute) \
         VALUES ($1, $2, true)",
    )
    .bind(room.workspace_id)
    .bind(room.id(muted_but_excepting))
    .execute(&su)
    .await
    .expect("keep 「멘션은 예외」");
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, dnd) VALUES ($1, $2, true)",
    )
    .bind(room.workspace_id)
    .bind(room.id(asleep))
    .execute(&su)
    .await
    .expect("do not disturb");

    let sent = drain_room(&su, &pool, &room).await;
    for (asker, answer) in answers {
        let woken = people_woken(&room, &sent, answer);
        if asker == plain || asker == muted_but_excepting {
            assert_eq!(woken, BTreeSet::from([asker]), "{asker:?}: {sent:?}");
        } else {
            assert!(woken.is_empty(), "{asker:?} must hear nothing: {sent:?}");
        }
    }
}

/// `props.answers_message_id` decides whom to wake, so a value that cannot be trusted
/// wakes nobody — and does not break the statement for everybody else: the cast is
/// guarded, so text that is not a UUID is simply "no marker". Each line below is an
/// agent's, in this channel, and each is silent; the last one (a well-formed marker, the
/// shape the sweeps write) is the control that pushes the asker in the same drain.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_answer_marker_that_cannot_be_trusted_pushes_no_one() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "succeeded").await;
    let marker = |value: Value| json!({ momo_agent::PROP_ANSWERS_MESSAGE_ID.to_string(): value });

    let mut quiet = Vec::new();
    for (label, run_of_line, props) in [
        (
            "text that is not a UUID",
            Some(run),
            marker(json!("not-a-uuid")),
        ),
        ("a number", Some(run), marker(json!(42))),
        (
            "a UUID that names no message",
            Some(run),
            marker(json!(Uuid::new_v4().to_string())),
        ),
        (
            "a good marker on a line that belongs to no run",
            None,
            marker(json!(question.to_string())),
        ),
    ] {
        let message = agent_says(
            &su,
            &room,
            AgentLine {
                message_type: "tool_result",
                run: run_of_line,
                props,
                client_msg_id: Some(Uuid::new_v4()),
                ..AgentLine::new(room.channel_id)
            },
        )
        .await;
        quiet.push((label, message));
    }
    // A well-formed marker on a human's message: only an agent's line may carry the right
    // to wake somebody (and REST strips the key from client props besides).
    let neighbour = room.id(Who::AgentOwner);
    let by_a_human: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, \
            props, run_id) \
         VALUES ($1, $2, $3, $3, 0, $4, 'text', 'a person writes the marker', $5, $6) RETURNING id",
    )
    .bind(room.workspace_id)
    .bind(room.channel_id)
    .bind(room.next_seq())
    .bind(neighbour)
    .bind(marker(json!(question.to_string())))
    .bind(run)
    .fetch_one(&su)
    .await
    .expect("insert a human line carrying the marker");
    quiet.push(("a good marker on a human's message", by_a_human));

    let control = agent_says(
        &su,
        &room,
        AgentLine {
            message_type: "tool_result",
            run: Some(run),
            props: marker(json!(question.to_string())),
            client_msg_id: Some(Uuid::new_v4()),
            ..AgentLine::new(room.channel_id)
        },
    )
    .await;

    let sent = drain_room(&su, &pool, &room).await;
    assert_eq!(
        people_woken(&room, &sent, control),
        BTreeSet::from([ASKER]),
        "the well-formed marker is the control — it reaches the asker: {sent:?}"
    );
    for (label, message) in quiet {
        assert!(
            hits_for(&sent, message).is_empty(),
            "{label} must not push anybody: {sent:?}"
        );
    }
    // The statement itself survived every one of those lines. A cast that raised would
    // push nobody either — the notifier requeues a candidate whose judgment failed — so
    // silence alone cannot tell "no marker" from "the judgment blew up". The settled
    // state can: every candidate of this room is done.
    let statuses = candidate_status(&su, room.workspace_id).await;
    assert!(
        !statuses.is_empty() && statuses.iter().all(|(status, _)| status == "done"),
        "a judgment that raised is requeued instead of settled: {statuses:?}"
    );
}

/// A run that ended badly still closes with a line, and that line answers the person who
/// asked: they hear that it failed. (A failed turn's closing line is the same kind of
/// message as the success — quoting the request, keyed by the run.)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_run_that_ended_badly_still_tells_the_asker() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let mut lines = Vec::new();
    for status in ["failed", "timed_out"] {
        let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
        let run = chat_run_for(&su, &room, room.channel_id, Some(question), status).await;
        lines.push((status, final_answer(&su, &room, run, question).await));
    }

    let sent = drain_room(&su, &pool, &room).await;
    for (status, line) in lines {
        assert_eq!(
            people_woken(&room, &sent, line),
            BTreeSet::from([ASKER]),
            "a run that {status} still answers its asker: {sent:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// a STREAMED answer is judged when it closes (ADR-0204 증보 1 D8-a, #3987)
// ---------------------------------------------------------------------------
//
// The in-process worker writes one answer in two steps: the OPENING slice is the INSERT
// (the 011 trigger's one candidate) and a later write closes the same row
// (`stream_message_body_in_tx`, `streaming: true -> false`). Until #3987 the answer was
// judged once, at its birth, against a read cursor the question had just moved — and the
// finished answer never. Now
//
//   * a line that is still streaming is HELD by the answer arm: it is only the first words;
//   * the closing write enqueues one more candidate, in its own transaction;
//   * that judgment reads "reading" at the moment of the close (`now()`), and does not let a
//     cursor that reached the line's first words stand for having read the end.
//
// Everything below is built with the real writers (`send_message_in_tx`,
// `stream_message_body_in_tx`), so the shapes are the ones production has. A stream that
// "opened two minutes ago" is the real opening with `created_at` moved back
// ([`age_message`]) — the judgment cannot tell the difference, and no test sleeps.

/// **#3987 acceptance 1.** The asker sent the question and watched the answer begin: two
/// minutes ago their cursor reached the opening slice (it covers the line's `seq`). Then
/// they put the phone down. While the answer streamed there was nothing to push — only the
/// first words. When it closes they are pushed once, now, on every device.
///
/// The control is a single-INSERT answer for another asker in the SAME first drain: it
/// pushes, so the opening's silence is the hold and not a judgment that pushes nobody.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_streamed_answer_is_pushed_at_its_close_to_an_asker_who_left_during_it() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let control_asker = Who::AgentOwner;
    set_read_cursor(&su, &room, control_asker, "now() - interval '5 minutes'").await;

    // Hand-written rows first; the real send comes last (it takes the next channel seq).
    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "running").await;
    let control_question = human_says(&su, &room, room.channel_id, room.id(control_asker)).await;
    let control_run = chat_run_for(
        &su,
        &room,
        room.channel_id,
        Some(control_question),
        "succeeded",
    )
    .await;
    let control = final_answer(&su, &room, control_run, control_question).await;
    let streamed = open_streamed_answer(&su, &room, run, question).await;

    // The stream opened two minutes ago; the asker's cursor reached it two seconds later.
    age_message(&su, streamed, 120).await;
    let seq = message_seq(&su, streamed).await;
    set_read_cursor_at(&su, &room, ASKER, seq, "now() - interval '118 seconds'").await;

    // ---- the opening candidate: nothing to push yet -----------------------------------
    let (_, sent) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(
        people_woken(&room, &sent, control),
        BTreeSet::from([control_asker]),
        "the control: a single-INSERT answer pushes its away asker in this very drain: {sent:?}"
    );
    assert!(
        hits_for(&sent, streamed).is_empty(),
        "a line that is still streaming is held — it is the first words, not the answer: {sent:?}"
    );
    assert_eq!(
        candidates_of(&su, streamed).await,
        1,
        "the INSERT's candidate"
    );

    // ---- the stream closes ------------------------------------------------------------
    close_streamed_answer(&su, &room, streamed, None).await;
    assert_eq!(
        candidates_of(&su, streamed).await,
        2,
        "the closing write enqueues the second candidate"
    );
    assert_eq!(closing_candidates_of(&su, streamed).await, 1);

    let (stats, sent) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(
        stats.claimed, 1,
        "exactly the closing candidate was waiting"
    );
    assert_eq!(
        people_woken(&room, &sent, streamed),
        BTreeSet::from([ASKER]),
        "the asker left during the stream, so the finished answer reaches them: {sent:?}"
    );
    let hits = hits_for(&sent, streamed);
    assert_eq!(
        hits.len(),
        device_total(ASKER),
        "every device they own, once"
    );
    for hit in hits {
        assert_eq!(hit.reason, "mention");
        assert_eq!(hit.category, "momo.mention");
        assert_eq!(hit.approval_id, None);
    }

    // ---- and nothing is left to judge -------------------------------------------------
    let (claimed, sent) = drain_room_counted(&su, &pool, &room).await;
    assert_eq!(claimed, 0);
    assert!(sent.is_empty(), "{sent:?}");
}

/// **#3987 acceptance 1, the other half.** An asker whose cursor moved in the 30 seconds
/// before the stream closed is looking at the channel and is not pushed — and, in the same
/// drain, an asker who is away is: the second stream is the control.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_streamed_answer_is_not_pushed_to_an_asker_who_was_moving_their_cursor_just_before_it_closed(
) {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let watcher = ASKER;
    let away = Who::AgentOwner;
    let q_watcher = human_says(&su, &room, room.channel_id, room.id(watcher)).await;
    let run_watcher = chat_run_for(&su, &room, room.channel_id, Some(q_watcher), "running").await;
    let q_away = human_says(&su, &room, room.channel_id, room.id(away)).await;
    let run_away = chat_run_for(&su, &room, room.channel_id, Some(q_away), "running").await;
    let watcher_stream = open_streamed_answer(&su, &room, run_watcher, q_watcher).await;
    let away_stream = open_streamed_answer(&su, &room, run_away, q_away).await;
    for stream in [watcher_stream, away_stream] {
        age_message(&su, stream, 120).await;
    }
    // The watcher's client advanced their cursor five seconds ago; the other asker's cursor
    // reached their stream's first words but has not moved for ten minutes.
    set_read_cursor_at(
        &su,
        &room,
        watcher,
        message_seq(&su, watcher_stream).await,
        "now() - interval '5 seconds'",
    )
    .await;
    set_read_cursor_at(
        &su,
        &room,
        away,
        message_seq(&su, away_stream).await,
        "now() - interval '10 minutes'",
    )
    .await;

    let (_, sent) = drain_room_full(&su, &pool, &room).await;
    for stream in [watcher_stream, away_stream] {
        assert!(
            hits_for(&sent, stream).is_empty(),
            "held while streaming: {sent:?}"
        );
    }
    close_streamed_answer(&su, &room, watcher_stream, None).await;
    close_streamed_answer(&su, &room, away_stream, None).await;

    let (stats, sent) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(stats.claimed, 2, "both closing candidates were judged");
    assert!(
        people_woken(&room, &sent, watcher_stream).is_empty(),
        "the watcher moved their cursor five seconds ago: {sent:?}"
    );
    assert_eq!(
        people_woken(&room, &sent, away_stream),
        BTreeSet::from([away]),
        "the control: the away asker is pushed in the same drain: {sent:?}"
    );
    // The watched candidate settled as done: nobody to push is a completed candidate.
    assert!(candidate_status(&su, room.workspace_id)
        .await
        .iter()
        .all(|(status, _)| status == "done"));
}

/// The width of the window a streamed answer is judged against. A cursor that moved 15
/// seconds before the close is inside the 30 and the asker is not pushed; one that stopped
/// 45 seconds before is outside and the asker is — in the same drain, for two streams that
/// both opened two minutes ago (so neither verdict can come from the stream's own age).
///
/// The pair brackets 30 on both sides, 15 seconds clear of it each way so a slow drain cannot
/// tip either: a window narrowed to 10 seconds pushes the first asker, one widened to 90 stays
/// silent for the second. (The 5-second and 118-second cases of the tests around this one
/// leave everything between them unpinned.)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_streamed_answers_window_is_thirty_seconds_wide_at_the_close() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let inside = ASKER;
    let outside = Who::AgentOwner;
    let q_inside = human_says(&su, &room, room.channel_id, room.id(inside)).await;
    let run_inside = chat_run_for(&su, &room, room.channel_id, Some(q_inside), "running").await;
    let q_outside = human_says(&su, &room, room.channel_id, room.id(outside)).await;
    let run_outside = chat_run_for(&su, &room, room.channel_id, Some(q_outside), "running").await;
    let inside_stream = open_streamed_answer(&su, &room, run_inside, q_inside).await;
    let outside_stream = open_streamed_answer(&su, &room, run_outside, q_outside).await;
    for stream in [inside_stream, outside_stream] {
        age_message(&su, stream, 120).await;
    }
    set_read_cursor_at(
        &su,
        &room,
        inside,
        message_seq(&su, inside_stream).await,
        "now() - interval '15 seconds'",
    )
    .await;
    set_read_cursor_at(
        &su,
        &room,
        outside,
        message_seq(&su, outside_stream).await,
        "now() - interval '45 seconds'",
    )
    .await;

    drain_room_full(&su, &pool, &room).await; // the openings: held
    close_streamed_answer(&su, &room, inside_stream, None).await;
    close_streamed_answer(&su, &room, outside_stream, None).await;

    let (stats, sent) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(stats.claimed, 2);
    assert!(
        people_woken(&room, &sent, inside_stream).is_empty(),
        "15 seconds is inside the 30-second window: {sent:?}"
    );
    assert_eq!(
        people_woken(&room, &sent, outside_stream),
        BTreeSet::from([outside]),
        "45 seconds is outside it: {sent:?}"
    );
}

/// **The old-client edge (#3987 M2, kept by #4018).** An asker whose client sends no heartbeat
/// and who watched a stream to its end from a cursor that stood still is pushed at the close.
///
/// A read cursor — and `last_read_at` with it — moves only when `last_read_seq` does, and a
/// stream spends no `seq`: after the client marks the opening slice read, nothing moves the
/// cursor for the rest of a long answer. Without a presence beat the server cannot tell
/// looking from gone, so past the window it pushes. The heartbeat (next test) is the fix for
/// clients that send it; this one pins that the cursor alone is unchanged for those that do not.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_stream_watched_longer_than_the_window_from_a_standing_cursor_is_pushed_without_a_heartbeat(
) {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "running").await;
    let streamed = open_streamed_answer(&su, &room, run, question).await;

    // A 50-second answer, watched from the first word: the client marked the opening read
    // when it arrived, then the cursor had nothing to move with. 45 seconds on, it closes.
    age_message(&su, streamed, 50).await;
    set_read_cursor_at(
        &su,
        &room,
        ASKER,
        message_seq(&su, streamed).await,
        "now() - interval '45 seconds'",
    )
    .await;
    drain_room_full(&su, &pool, &room).await;
    close_streamed_answer(&su, &room, streamed, None).await;

    let (_, sent) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(
        people_woken(&room, &sent, streamed),
        BTreeSet::from([ASKER]),
        "no heartbeat, cursor 45 s old: reads as gone: {sent:?}"
    );
}

/// The same asker, same standing cursor, but the client beat 20 seconds before the close:
/// they are looking, so nothing is pushed (#4018).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_stream_watched_longer_than_the_window_is_not_pushed_while_the_heartbeat_is_fresh() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "running").await;
    let streamed = open_streamed_answer(&su, &room, run, question).await;
    age_message(&su, streamed, 50).await;
    set_read_cursor_at(
        &su,
        &room,
        ASKER,
        message_seq(&su, streamed).await,
        "now() - interval '45 seconds'",
    )
    .await;
    set_viewing(
        &su,
        room.workspace_id,
        room.channel_id,
        room.id(ASKER),
        "10",
    )
    .await;
    drain_room_full(&su, &pool, &room).await;
    close_streamed_answer(&su, &room, streamed, None).await;

    let (_, sent) = drain_room_full(&su, &pool, &room).await;
    assert!(
        people_woken(&room, &sent, streamed).is_empty(),
        "a beat 20 s ago is inside the window: {sent:?}"
    );
}

/// What does not count as looking: a beat older than the window, and a beat for another
/// channel. Each asker below stands on a 45 s-old cursor.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_stale_heartbeat_or_one_for_another_channel_does_not_keep_the_push_back() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let stale = ASKER;
    let other_channel = Who::AgentOwner;
    let q_stale = human_says(&su, &room, room.channel_id, room.id(stale)).await;
    let run_stale = chat_run_for(&su, &room, room.channel_id, Some(q_stale), "running").await;
    let q_other = human_says(&su, &room, room.channel_id, room.id(other_channel)).await;
    let run_other = chat_run_for(&su, &room, room.channel_id, Some(q_other), "running").await;
    let stale_stream = open_streamed_answer(&su, &room, run_stale, q_stale).await;
    let other_stream = open_streamed_answer(&su, &room, run_other, q_other).await;
    for (stream, who) in [(stale_stream, stale), (other_stream, other_channel)] {
        age_message(&su, stream, 120).await;
        set_read_cursor_at(
            &su,
            &room,
            who,
            message_seq(&su, stream).await,
            "now() - interval '45 seconds'",
        )
        .await;
    }
    // ASKER's beat for this channel is 40 s old (stale). AgentOwner's only beat is fresh but
    // for a different channel.
    set_viewing(
        &su,
        room.workspace_id,
        room.channel_id,
        room.id(stale),
        "45",
    )
    .await;
    let elsewhere = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', 'elsewhere-viewing')",
    )
    .bind(elsewhere)
    .bind(room.workspace_id)
    .execute(&su)
    .await
    .expect("seed another channel");
    set_viewing(
        &su,
        room.workspace_id,
        elsewhere,
        room.id(other_channel),
        "2",
    )
    .await;

    drain_room_full(&su, &pool, &room).await;
    close_streamed_answer(&su, &room, stale_stream, None).await;
    close_streamed_answer(&su, &room, other_stream, None).await;

    let (_, sent) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(
        people_woken(&room, &sent, stale_stream),
        BTreeSet::from([stale]),
        "a 40 s-old beat is outside the window: {sent:?}"
    );
    assert_eq!(
        people_woken(&room, &sent, other_stream),
        BTreeSet::from([other_channel]),
        "a beat for another channel is not looking at this one: {sent:?}"
    );
}

/// The heartbeat's window basis for a single-INSERT answer is the answer's own `created_at`
/// (like the cursor's), not `now()`: the answer arrived 120 s ago and is judged now.
///
/// * beat 100 s ago, i.e. 20 s *after* it arrived: looking -> quiet;
/// * beat 140 s ago, i.e. 20 s *before* it arrived: inside the 30 s window -> quiet;
/// * beat 160 s ago, i.e. 40 s before: outside it -> pushed.
///
/// Reading them against `now()` would push the first two. (Review of #4018, M1/M2.)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_single_insert_answers_heartbeat_window_is_read_around_its_creation_time() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let mut answers = Vec::new();
    for (asker, age) in [
        (Who::Member, "100"),
        (Who::AgentOwner, "140"),
        (Who::Admin, "160"),
    ] {
        let question = human_says(&su, &room, room.channel_id, room.id(asker)).await;
        let run = chat_run_for(&su, &room, room.channel_id, Some(question), "succeeded").await;
        let answer = final_answer(&su, &room, run, question).await;
        age_message(&su, answer, 120).await;
        set_viewing(&su, room.workspace_id, room.channel_id, room.id(asker), age).await;
        answers.push((asker, answer));
    }

    let (_, sent) = drain_room_full(&su, &pool, &room).await;
    for (asker, answer) in &answers {
        let woken = people_woken(&room, &sent, *answer);
        if *asker == Who::Admin {
            assert_eq!(woken, BTreeSet::from([Who::Admin]), "40 s before: {sent:?}");
        } else {
            assert!(woken.is_empty(), "{asker:?} was looking: {sent:?}");
        }
    }
}

/// A presence beat `age_secs` seconds old (SQL integer literal) for `member` in `channel`.
async fn set_viewing(
    su: &PgPool,
    workspace_id: Uuid,
    channel_id: Uuid,
    member: Uuid,
    age_secs: &str,
) {
    sqlx::query(&format!(
        "INSERT INTO channel_viewing (workspace_id, channel_id, member_id, seen_at) \
         VALUES ($1, $2, $3, now() - interval '{age_secs} seconds') \
         ON CONFLICT (channel_id, member_id) DO UPDATE \
            SET seen_at = now() - interval '{age_secs} seconds'"
    ))
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member)
    .execute(su)
    .await
    .expect("set the presence beat");
}

/// **#3987 acceptance 2.** An asker who was away from the very first word does not get an
/// opening push with half a sentence and then another at the end: the opening is held, and
/// the close is the one push. (Before: they got the opening one and never the end.)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_asker_who_was_away_from_the_start_gets_one_push_at_the_close_not_two() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    set_read_cursor(&su, &room, ASKER, "now() - interval '5 minutes'").await;
    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "running").await;
    let streamed = open_streamed_answer(&su, &room, run, question).await;

    // The opening: the asker is away, and still nothing is sent — the line is streaming.
    let (stats, opening) = drain_room_full(&su, &pool, &room).await;
    assert!(stats.claimed >= 1);
    assert!(
        hits_for(&opening, streamed).is_empty(),
        "an away asker is not pushed the first words: {opening:?}"
    );
    assert_eq!(stats.dispatched, 0);
    assert!(candidate_status(&su, room.workspace_id)
        .await
        .iter()
        .all(|(status, _)| status == "done"));

    // Held does not mean forgotten: drain again while the stream is still open, and still
    // nothing — an unclosed stream is never judged by this arm.
    let (_, again) = drain_room_full(&su, &pool, &room).await;
    assert!(again.is_empty(), "{again:?}");

    close_streamed_answer(&su, &room, streamed, None).await;
    let (_, closing) = drain_room_full(&su, &pool, &room).await;
    let hits = hits_for(&closing, streamed);
    assert_eq!(
        hits.len(),
        device_total(ASKER),
        "one push per device, at the close: {closing:?}"
    );
    for hit in hits {
        assert_eq!(hit.reason, "mention");
        assert_eq!(hit.category, "momo.mention");
    }

    let (claimed, later) = drain_room_counted(&su, &pool, &room).await;
    assert_eq!(claimed, 0);
    assert!(later.is_empty());
}

/// The window is read **when the answer closes**, not when it opened. The stream opened two
/// minutes ago; the asker's cursor moved twenty seconds after that and not since. Against
/// the opening (`created_at`) they were "reading"; at the close they have been gone for
/// 100 seconds. (The cursor does NOT cover the line's `seq` here, so the only thing in play
/// is the basis the window is measured from.)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn the_window_is_read_when_the_answer_closes_not_when_it_opened() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "running").await;
    let streamed = open_streamed_answer(&su, &room, run, question).await;
    age_message(&su, streamed, 120).await;
    assert!(
        message_seq(&su, streamed).await > 1,
        "the cursor below does not cover the line"
    );
    set_read_cursor_at(&su, &room, ASKER, 1, "now() - interval '100 seconds'").await;

    drain_room_full(&su, &pool, &room).await;
    close_streamed_answer(&su, &room, streamed, None).await;
    let (_, sent) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(
        people_woken(&room, &sent, streamed),
        BTreeSet::from([ASKER]),
        "100 seconds before the close is away, even though it is 20 seconds after the opening: {sent:?}"
    );
}

/// A cursor that reached the first words says the asker saw the answer BEGIN — not that
/// they are still there at the end. Here the cursor covers the line's `seq` (they read the
/// opening slice) but has not moved for ten minutes: the shortcut that suppresses a
/// single-INSERT answer the asker has already read must not apply to a streamed one.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_cursor_that_reached_the_first_words_does_not_stand_for_having_read_the_end() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "running").await;
    let streamed = open_streamed_answer(&su, &room, run, question).await;
    age_message(&su, streamed, 120).await;
    let seq = message_seq(&su, streamed).await;
    set_read_cursor_at(&su, &room, ASKER, seq, "now() - interval '10 minutes'").await;

    drain_room_full(&su, &pool, &room).await;
    close_streamed_answer(&su, &room, streamed, None).await;
    let (_, sent) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(
        people_woken(&room, &sent, streamed),
        BTreeSet::from([ASKER]),
        "covering the first words' seq is not reading the end: {sent:?}"
    );
}

/// **#3987 acceptance 3, the boundary.** Everything that is not streamed keeps the window
/// it always had: measured from the line's own `created_at`, with the `seq` shortcut.
/// Three askers are answered by single-INSERT lines written two minutes ago and judged
/// now (a late drain, a retried candidate):
///
/// * cursor moved 100 s ago — 20 s *after* the answer arrived: they were reading it → not pushed;
/// * cursor moved 200 s ago — 80 s *before* it arrived, covering nothing: away → pushed;
/// * cursor 600 s old but covering the answer's `seq`: they have read it → not pushed.
///
/// Reading these against `now()` instead would push the first and the third.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_single_insert_answer_keeps_its_own_creation_time_as_the_window_basis() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    let reading_after = Who::Member;
    let away_before = Who::Admin;
    let saw_it = Who::AgentOwner;
    let mut answers = Vec::new();
    for asker in [reading_after, away_before, saw_it] {
        let question = human_says(&su, &room, room.channel_id, room.id(asker)).await;
        let run = chat_run_for(&su, &room, room.channel_id, Some(question), "succeeded").await;
        let answer = final_answer(&su, &room, run, question).await;
        age_message(&su, answer, 120).await;
        answers.push((asker, answer));
    }
    let seq_of = |asker: Who| {
        answers
            .iter()
            .find(|(who, _)| *who == asker)
            .map(|(_, answer)| *answer)
            .expect("an answer for this asker")
    };
    set_read_cursor_at(
        &su,
        &room,
        reading_after,
        1,
        "now() - interval '100 seconds'",
    )
    .await;
    set_read_cursor_at(&su, &room, away_before, 1, "now() - interval '200 seconds'").await;
    let covered = message_seq(&su, seq_of(saw_it)).await;
    set_read_cursor_at(
        &su,
        &room,
        saw_it,
        covered,
        "now() - interval '600 seconds'",
    )
    .await;

    let (_, sent) = drain_room_full(&su, &pool, &room).await;
    for (asker, answer) in &answers {
        let woken = people_woken(&room, &sent, *answer);
        if *asker == away_before {
            assert_eq!(woken, BTreeSet::from([away_before]), "{asker:?}: {sent:?}");
        } else {
            assert!(woken.is_empty(), "{asker:?} had read it: {sent:?}");
        }
    }
}

/// A REST streamer's opening names the quoted author as mentioned, so the explicit-mention
/// arm pushes at the opening (no window); the close then finds that person already pushed
/// for this message (`collapse_id` and the dispatch-log unique index) and sends nothing.
/// The asker is even "reading" — the mention arm does not care, and neither does the
/// dedupe.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_close_adds_no_second_push_for_a_person_the_opening_already_pushed() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    set_read_cursor(&su, &room, ASKER, "now()").await;
    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "running").await;
    let streamed = open_streamed_answer_in(
        &su,
        &room,
        room.channel_id,
        run,
        question,
        json!({ "mention_member_ids": [room.id(ASKER).to_string()] }),
    )
    .await;

    let (_, opening) = drain_room_full(&su, &pool, &room).await;
    let hits = hits_for(&opening, streamed);
    assert_eq!(
        hits.len(),
        device_total(ASKER),
        "pushed at the opening: {opening:?}"
    );
    assert!(hits.iter().all(|hit| hit.reason == "mention"));

    close_streamed_answer(&su, &room, streamed, None).await;
    let (stats, closing) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(stats.claimed, 1, "the closing candidate was judged");
    assert_eq!(stats.dispatched, 0, "and sent nothing: {closing:?}");
    assert_eq!(
        stats.skipped_already_settled,
        device_total(ASKER),
        "every device already had its push for this message"
    );
    assert!(closing.is_empty());
}

/// The same in a DM: the `dm` arm pushes the peer at the opening whether or not they are
/// reading (as it always did), the answer arm is not involved, and the close adds nothing.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_dm_streamed_answer_is_pushed_by_the_dm_arm_at_its_opening_and_not_again_at_its_close() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;
    let asker = room.id(ASKER);

    let dm = seed_dm(&su, &room, asker).await;
    let question = human_says(&su, &room, dm, asker).await;
    let run = chat_run_for(&su, &room, dm, Some(question), "running").await;
    let streamed = open_streamed_answer_in(&su, &room, dm, run, question, json!({})).await;

    let (_, opening) = drain_room_full(&su, &pool, &room).await;
    let hits = hits_for(&opening, streamed);
    assert_eq!(
        hits.len(),
        device_total(ASKER),
        "the DM peer is pushed at the opening: {opening:?}"
    );
    for hit in hits {
        assert_eq!(hit.reason, "dm");
        assert_eq!(hit.category, "momo.message");
    }

    close_streamed_answer(&su, &room, streamed, None).await;
    let (stats, closing) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(stats.claimed, 1);
    assert_eq!(stats.dispatched, 0, "{closing:?}");
    assert_eq!(stats.skipped_already_settled, device_total(ASKER));
}

/// A short answer opens and closes before anyone has judged it: both candidates are
/// pending in the same drain. The asker is away; they are pushed once. Whichever candidate
/// is judged first sends; the other finds the push already settled.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_short_answer_is_pushed_once_when_it_opens_and_closes_before_anyone_judges_it() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    set_read_cursor(&su, &room, ASKER, "now() - interval '5 minutes'").await;
    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "running").await;
    let streamed = open_streamed_answer(&su, &room, run, question).await;
    close_streamed_answer(&su, &room, streamed, None).await;
    assert_eq!(candidates_of(&su, streamed).await, 2);

    let (stats, sent) = drain_room_full(&su, &pool, &room).await;
    assert!(stats.claimed >= 2);
    assert_eq!(
        hits_for(&sent, streamed).len(),
        device_total(ASKER),
        "once per device, not once per candidate: {sent:?}"
    );
    assert_eq!(
        stats.skipped_already_settled,
        device_total(ASKER),
        "the second candidate found every push already settled"
    );
}

/// A stream a human stopped, or one whose provider died, is closed with an `outcome` and
/// leaves its frozen text in the channel (ADR-0155). That is still the end of the answer,
/// and the asker is told like for a finished one — they learn it stopped. (This includes an
/// asker who pressed stop themselves: the server does not move a read cursor when a stop is
/// pressed — the stop writes a line, and a client that reports that line read moves the
/// cursor, which this suite does not model — so an asker whose cursor stood still for the
/// window is indistinguishable from one who left. Whether a stopped stream should skip the
/// person who stopped it is a product decision the ADR did not make; the close is judged by
/// what the message says, not how it ended.)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_stream_that_was_stopped_or_failed_is_told_like_a_finished_one() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    set_read_cursor(&su, &room, ASKER, "now() - interval '5 minutes'").await;
    let mut streams = Vec::new();
    for outcome in [StreamCloseOutcome::Cancelled, StreamCloseOutcome::Failed] {
        let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
        let run = chat_run_for(&su, &room, room.channel_id, Some(question), "running").await;
        streams.push((outcome, run, question));
    }
    let mut opened = Vec::new();
    for (outcome, run, question) in streams {
        opened.push((
            outcome,
            open_streamed_answer(&su, &room, run, question).await,
        ));
    }
    drain_room_full(&su, &pool, &room).await;
    for (outcome, stream) in &opened {
        close_streamed_answer(&su, &room, *stream, Some(*outcome)).await;
    }
    let (_, sent) = drain_room_full(&su, &pool, &room).await;
    for (outcome, stream) in &opened {
        assert_eq!(
            people_woken(&room, &sent, *stream),
            BTreeSet::from([ASKER]),
            "a stream that ended {outcome:?} is still an answer's end: {sent:?}"
        );
    }
}

/// **The retried turn (review of #3987, M1).** The provider dies mid-answer and the job has
/// attempts left, so the worker freezes the half answer (`outcome: failed`) while the job
/// waits out its backoff — and the next attempt REOPENS the same message and closes it for
/// real. That freeze is not where the answer ends: it is provisional, it announces nothing,
/// and the one push the asker gets comes at the close that does end the turn.
///
/// Announce at the freeze instead and the asker is told "an answer arrived" while the
/// message holds only the half answer and a retry is still pending; and because `collapse_id`
/// is per message, that early push settles the message and the real close's push is skipped
/// as already settled — the finished answer is never announced. The last half of this test
/// is the control: the same stream, closed for real the way a last attempt closes it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_retried_streams_freeze_between_attempts_announces_nothing_and_its_real_close_announces_once(
) {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    set_read_cursor(&su, &room, ASKER, "now() - interval '5 minutes'").await;
    // Hand-written rows first; the real sends come last (they take the next channel seq).
    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "running").await;
    let last_question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let last_run = chat_run_for(&su, &room, room.channel_id, Some(last_question), "running").await;
    let streamed = open_streamed_answer(&su, &room, run, question).await;

    // The opening candidate is judged while the stream is open: held.
    let (_, sent) = drain_room_full(&su, &pool, &room).await;
    assert!(hits_for(&sent, streamed).is_empty(), "{sent:?}");

    // ---- attempt 1: some words arrive, the provider dies, the worker freezes them ------
    let slice = write_stream_slice(&su, &room, streamed, 1, false, None).await;
    assert!(matches!(slice, StreamOutcome::Applied(_)));
    let freeze = write_stream_edit(
        &su,
        &room,
        streamed,
        2,
        true,
        Some(StreamCloseOutcome::Failed),
        true,
    )
    .await;
    assert!(
        matches!(freeze, StreamOutcome::Applied(_)),
        "the freeze is a real write: {freeze:?}"
    );
    let frozen: Value = sqlx::query_scalar("SELECT props->$2 FROM message WHERE id = $1")
        .bind(streamed)
        .bind(STREAM_PROPS_KEY)
        .fetch_one(&su)
        .await
        .expect("read the stream block");
    assert_eq!(
        frozen["streaming"],
        json!(false),
        "the half answer is frozen: {frozen}"
    );
    assert_eq!(frozen["outcome"], json!("failed"), "…and marked: {frozen}");
    assert_eq!(
        closing_candidates_of(&su, streamed).await,
        0,
        "a provisional freeze is not the end of the answer: it enqueues no candidate"
    );
    let (claimed, sent) = drain_room_counted(&su, &pool, &room).await;
    assert_eq!(claimed, 0, "nothing is waiting to be judged");
    assert!(
        sent.is_empty(),
        "the asker is not pushed at the freeze: {sent:?}"
    );

    // ---- attempt 2: the same message is reopened, then closed for real ------------------
    let reopened = write_stream_slice(&su, &room, streamed, 3, false, None).await;
    assert!(matches!(reopened, StreamOutcome::Applied(_)));
    assert_eq!(
        closing_candidates_of(&su, streamed).await,
        0,
        "reopening is not a close either"
    );
    let closed = write_stream_slice(&su, &room, streamed, 4, true, None).await;
    assert!(matches!(closed, StreamOutcome::Applied(_)));
    assert_eq!(
        closing_candidates_of(&su, streamed).await,
        1,
        "the close that ends the turn enqueues the one candidate"
    );
    assert_eq!(
        candidates_of(&su, streamed).await,
        2,
        "the INSERT's + the end's"
    );

    let (stats, sent) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(stats.claimed, 1);
    assert_eq!(
        people_woken(&room, &sent, streamed),
        BTreeSet::from([ASKER]),
        "the away asker is told when the answer ends: {sent:?}"
    );
    assert_eq!(
        hits_for(&sent, streamed).len(),
        device_total(ASKER),
        "once per device — the freeze did not spend the message's push slot"
    );

    // ---- the control: a last attempt's failure is a close that does announce ------------
    let ended = open_streamed_answer(&su, &room, last_run, last_question).await;
    drain_room_full(&su, &pool, &room).await;
    close_streamed_answer(&su, &room, ended, Some(StreamCloseOutcome::Failed)).await;
    assert_eq!(
        closing_candidates_of(&su, ended).await,
        1,
        "the same failed close, not provisional, is the end of the answer"
    );
    let (_, sent) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(people_woken(&room, &sent, ended), BTreeSet::from([ASKER]));
}

/// **Review of #3987, M2.** A candidate that is judged late — the notifier was busy, or the
/// judgment failed once and was requeued — can land inside a retried turn's freeze: the
/// opening candidate is still waiting when the worker freezes the half answer for the
/// backoff. The message then reads `streaming: false, outcome: failed`, exactly like the end
/// of a turn that really failed, and judging it as closed would push the asker the half
/// answer — and, `collapse_id` being per message, spend the slot the real answer needs.
///
/// A provisional freeze says on the message itself that it is not the end, and the answer arm
/// holds it like a stream that is still open. The candidate is consumed with no push; the
/// close that ends the turn enqueues the next one, which pushes once.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_candidate_judged_while_a_retried_stream_is_frozen_is_held() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    set_read_cursor(&su, &room, ASKER, "now() - interval '5 minutes'").await;
    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "running").await;
    drain_room_full(&su, &pool, &room).await; // the question's own candidate: nobody to push
    let streamed = open_streamed_answer(&su, &room, run, question).await;

    // The opening candidate is NOT drained yet: the freeze lands before it is judged.
    let slice = write_stream_slice(&su, &room, streamed, 1, false, None).await;
    assert!(matches!(slice, StreamOutcome::Applied(_)));
    let freeze = write_stream_edit(
        &su,
        &room,
        streamed,
        2,
        true,
        Some(StreamCloseOutcome::Failed),
        true,
    )
    .await;
    assert!(matches!(freeze, StreamOutcome::Applied(_)), "{freeze:?}");

    let (stats, sent) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(
        stats.claimed, 1,
        "the opening candidate is judged now, inside the freeze"
    );
    assert!(
        hits_for(&sent, streamed).is_empty(),
        "a frozen-for-a-retry answer is not the answer: held, not pushed: {sent:?}"
    );

    // The retry reopens it and the turn ends: one push, of the finished answer.
    let reopened = write_stream_slice(&su, &room, streamed, 3, false, None).await;
    assert!(matches!(reopened, StreamOutcome::Applied(_)));
    let closed = write_stream_slice(&su, &room, streamed, 4, true, None).await;
    assert!(matches!(closed, StreamOutcome::Applied(_)));
    let (stats, sent) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(stats.claimed, 1);
    assert_eq!(
        people_woken(&room, &sent, streamed),
        BTreeSet::from([ASKER]),
        "the finished answer reaches the asker who was away: {sent:?}"
    );
    assert_eq!(hits_for(&sent, streamed).len(), device_total(ASKER));
}

/// **The premise, pinned (review of #3987, L5).** Why a retried turn's freeze must not be an
/// announcement. Write the same freeze as a plain close — what the stream's writer does for a
/// turn that really ended — and the half answer is pushed to the asker; `collapse_id` is per
/// message, so that push settles every device, and the push for the finished answer, a moment
/// later, finds them all settled and goes nowhere. The asker is told once, with half a
/// sentence, and never with the answer.
///
/// This is not a test of the fix (it passes however the freeze is written) — it is what the
/// `provisional` marker exists to prevent, kept next to the tests that prove the marker works.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_pause_announced_as_an_end_would_settle_the_push_the_real_answer_needs() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;
    let pool = momo_notifier_pool().await;

    set_read_cursor(&su, &room, ASKER, "now() - interval '5 minutes'").await;
    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "running").await;
    let streamed = open_streamed_answer(&su, &room, run, question).await;
    drain_room_full(&su, &pool, &room).await; // the opening: held while the stream is open

    // The provider dies mid-answer and the freeze is written as an END (not provisional).
    let slice = write_stream_slice(&su, &room, streamed, 1, false, None).await;
    assert!(matches!(slice, StreamOutcome::Applied(_)));
    let freeze = write_stream_edit(
        &su,
        &room,
        streamed,
        2,
        true,
        Some(StreamCloseOutcome::Failed),
        false,
    )
    .await;
    assert!(matches!(freeze, StreamOutcome::Applied(_)), "{freeze:?}");
    let (_, sent) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(
        hits_for(&sent, streamed).len(),
        device_total(ASKER),
        "the half answer is pushed to every device: {sent:?}"
    );

    // The retry reopens the message and finishes it. Its push finds every device settled.
    let reopened = write_stream_slice(&su, &room, streamed, 3, false, None).await;
    assert!(matches!(reopened, StreamOutcome::Applied(_)));
    let closed = write_stream_slice(&su, &room, streamed, 4, true, None).await;
    assert!(matches!(closed, StreamOutcome::Applied(_)));
    let (stats, sent) = drain_room_full(&su, &pool, &room).await;
    assert_eq!(
        stats.claimed, 1,
        "the finished answer's candidate is judged"
    );
    assert_eq!(
        stats.skipped_already_settled,
        device_total(ASKER),
        "…and every device it would reach was already settled by the half answer's push"
    );
    assert!(
        hits_for(&sent, streamed).is_empty(),
        "the asker is never told the answer arrived: {sent:?}"
    );
}

/// The producer: the closing write — and only it — enqueues the second candidate.
/// Exactly one per stream; none for a slice, for a second final write (a producer's retry
/// at a higher revision), for a stale write, or for a message that never streamed.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn closing_a_stream_enqueues_exactly_one_candidate_and_only_for_an_open_stream() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;

    // A line that never streamed (hand-written rows first; the real send comes last).
    let plain = agent_says(&su, &room, AgentLine::new(room.channel_id)).await;
    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "running").await;
    let streamed = open_streamed_answer(&su, &room, run, question).await;
    assert_eq!(
        candidates_of(&su, streamed).await,
        1,
        "the INSERT's candidate"
    );
    assert_eq!(closing_candidates_of(&su, streamed).await, 0);

    // A slice grows the answer; it is not the end.
    let slice = write_stream_slice(&su, &room, streamed, 1, false, None).await;
    assert!(matches!(slice, StreamOutcome::Applied(_)));
    assert_eq!(
        closing_candidates_of(&su, streamed).await,
        0,
        "a slice is not a close"
    );

    // A final write that lost a race to the slice above (revision not above the stored
    // one) changes nothing — on a stream that is still OPEN, where a careless "final means
    // close" would enqueue a candidate for a close that never happened.
    let stale_final = write_stream_slice(&su, &room, streamed, 1, true, None).await;
    assert!(
        matches!(stale_final, StreamOutcome::Stale(_)),
        "{stale_final:?}"
    );
    assert_eq!(
        closing_candidates_of(&su, streamed).await,
        0,
        "a stale final write is not a close"
    );
    let still_open: Value = sqlx::query_scalar("SELECT props->$2 FROM message WHERE id = $1")
        .bind(streamed)
        .bind(STREAM_PROPS_KEY)
        .fetch_one(&su)
        .await
        .expect("read the stream block");
    assert_eq!(
        still_open["streaming"],
        json!(true),
        "the stale write closed nothing"
    );

    // The close.
    let closed = write_stream_slice(&su, &room, streamed, 2, true, None).await;
    assert!(matches!(closed, StreamOutcome::Applied(_)));
    assert_eq!(closing_candidates_of(&su, streamed).await, 1);
    assert_eq!(candidates_of(&su, streamed).await, 2);

    // Its payload is the trigger's, ids only, plus the source — and the notifier decodes it.
    let payload: Value = sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE kind = 'push_candidate' AND payload->>'message_id' = $1 \
            AND payload->>'source' = 'stream_closed'",
    )
    .bind(streamed.to_string())
    .fetch_one(&su)
    .await
    .expect("the closing candidate");
    assert_eq!(payload["schema"], "momo.push_candidate.v1");
    assert_eq!(payload["message_id"], streamed.to_string());
    assert_eq!(payload["channel_id"], room.channel_id.to_string());
    assert_eq!(payload["author_member_id"], room.requester.to_string());
    assert_eq!(payload["message_type"], "text");
    let decoded = momo_push::PushCandidate::decode(&payload.to_string()).expect("decodes");
    assert_eq!(decoded.message_id, streamed);
    assert_eq!(decoded.channel_id, room.channel_id);
    for body_like in ["body", "text", "content", "display_name"] {
        assert!(
            payload.get(body_like).is_none(),
            "the candidate is id-only: {payload}"
        );
    }
    let (method, partition_key): (String, Option<Uuid>) = sqlx::query_as(
        "SELECT method, partition_key FROM outbox WHERE kind = 'push_candidate' \
            AND payload->>'message_id' = $1 AND payload->>'source' = 'stream_closed'",
    )
    .bind(streamed.to_string())
    .fetch_one(&su)
    .await
    .expect("method and partition key");
    assert_eq!(method, "notify", "the same method as the trigger's rows");
    let (trigger_method, trigger_partition): (String, Option<Uuid>) = sqlx::query_as(
        "SELECT method, partition_key FROM outbox WHERE kind = 'push_candidate' \
            AND payload->>'message_id' = $1 AND payload->>'source' IS NULL",
    )
    .bind(streamed.to_string())
    .fetch_one(&su)
    .await
    .expect("the trigger's row");
    assert_eq!(
        (method, partition_key),
        (trigger_method, trigger_partition),
        "the same row shape as the trigger's"
    );
    assert_eq!(
        partition_key,
        Some(room.channel_id),
        "partitioned by channel, like the trigger's rows"
    );

    // A second final write at a higher revision is applied (a producer's retry) but is not
    // a close: the block is already closed.
    let again = write_stream_slice(&su, &room, streamed, 3, true, None).await;
    assert!(matches!(again, StreamOutcome::Applied(_)));
    assert_eq!(
        closing_candidates_of(&su, streamed).await,
        1,
        "closed once, judged once"
    );

    // A stale final write (revision not above the stored one) changes nothing at all.
    let stale = write_stream_slice(&su, &room, streamed, 2, true, None).await;
    assert!(matches!(stale, StreamOutcome::Stale(_)));
    assert_eq!(closing_candidates_of(&su, streamed).await, 1);

    // A message that never streamed has no stream to close.
    let written = write_stream_slice(&su, &room, plain, 1, true, None).await;
    assert!(matches!(written, StreamOutcome::Applied(_)));
    assert_eq!(
        closing_candidates_of(&su, plain).await,
        0,
        "a final write on a message that never streamed is not a close"
    );
    assert_eq!(
        candidates_of(&su, plain).await,
        1,
        "only the INSERT's candidate"
    );
}

/// Wait until the backend with `pid` is blocked on a lock — and no other: a waiter of some
/// other test in the same database must not count.
async fn wait_until_backend_is_blocked_on_a_lock(su: &PgPool, pid: i32) {
    for _ in 0..200 {
        let blocked: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity \
                             WHERE pid = $1 AND wait_event_type = 'Lock')",
        )
        .bind(pid)
        .fetch_one(su)
        .await
        .expect("read pg_stat_activity");
        if blocked {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("the second writer (backend {pid}) never blocked on the message's row lock");
}

/// Two final writes racing to close one stream enqueue one candidate between them.
///
/// The decision "this write is the one that closes it" is made from `props` read **under
/// the message's row lock**. Writer A takes the lock and holds it; writer B (a producer's
/// retry at a higher revision) queues behind it; A commits, B proceeds and must find the
/// block already closed. Read the props before taking the lock and B still sees
/// `streaming: true` from before A's commit — both writers think they closed it, and the
/// message gets two candidates. Sequential tests cannot see that; this one makes B wait.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn two_final_writes_racing_to_close_one_stream_enqueue_one_candidate() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_approval_room(&su).await;

    let question = human_says(&su, &room, room.channel_id, room.id(ASKER)).await;
    let run = chat_run_for(&su, &room, room.channel_id, Some(question), "running").await;
    let streamed = open_streamed_answer(&su, &room, run, question).await;
    let slice = write_stream_slice(&su, &room, streamed, 1, false, None).await;
    assert!(matches!(slice, StreamOutcome::Applied(_)));

    let workspace = room.workspace_id;
    let author = room.requester;
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel::<()>();
    let (commit_tx, commit_rx) = tokio::sync::oneshot::channel::<()>();
    let (pid_tx, pid_rx) = tokio::sync::oneshot::channel::<i32>();

    // Writer A: the close at revision 2. It holds the row lock until told to commit.
    let writer_a = {
        let su = su.clone();
        tokio::spawn(async move {
            with_tenant_tx(&su, workspace, move |conn| {
                Box::pin(async move {
                    let applied = stream_message_body_in_tx(
                        conn,
                        workspace,
                        streamed,
                        author,
                        "첫 번째 닫힘",
                        StreamEdit {
                            rev: 2,
                            is_final: true,
                            outcome: None,
                            provisional: false,
                        },
                    )
                    .await?;
                    let _ = locked_tx.send(());
                    let _ = commit_rx.await;
                    Ok::<_, DbError>(applied.expect("the domain did not refuse the close"))
                })
            })
            .await
        })
    };
    if locked_rx.await.is_err() {
        // A ended before it took the lock: say why, instead of hanging on it.
        let outcome = writer_a.await.expect("join A");
        panic!("writer A never reached the point of holding the row lock: {outcome:?}");
    }

    // Writer B: another close, at revision 3, queued behind A's lock.
    let writer_b = {
        let su = su.clone();
        tokio::spawn(async move {
            with_tenant_tx(&su, workspace, move |conn| {
                Box::pin(async move {
                    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                        .fetch_one(&mut *conn)
                        .await?;
                    let _ = pid_tx.send(pid);
                    let applied = stream_message_body_in_tx(
                        conn,
                        workspace,
                        streamed,
                        author,
                        "두 번째 닫힘",
                        StreamEdit {
                            rev: 3,
                            is_final: true,
                            outcome: None,
                            provisional: false,
                        },
                    )
                    .await?;
                    Ok::<_, DbError>(applied.expect("the domain did not refuse the close"))
                })
            })
            .await
        })
    };
    let writer_b_pid = pid_rx.await.expect("writer B reports its backend");
    wait_until_backend_is_blocked_on_a_lock(&su, writer_b_pid).await;
    commit_tx.send(()).expect("let writer A commit");

    let a = writer_a.await.expect("join A").expect("A commits");
    let b = writer_b.await.expect("join B").expect("B commits");
    assert!(matches!(a, StreamOutcome::Applied(_)), "{a:?}");
    assert!(matches!(b, StreamOutcome::Applied(_)), "{b:?}");
    assert_eq!(
        closing_candidates_of(&su, streamed).await,
        1,
        "the stream was closed once, by whichever writer got the lock first"
    );
}
