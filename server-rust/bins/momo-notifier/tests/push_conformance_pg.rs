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

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{
    presence_status_for, set_declared_presence_in_tx, CustomStatusPatch, PresenceStatus,
    StatusPatch,
};
use momo_notifier::{PushConfig, PushDrain};
use momo_push::{DispatchOutcome, PushDispatch, PushDispatcher};
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
