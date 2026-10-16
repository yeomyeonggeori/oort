//! DB-backed conformance for #3930 — a dead APNs token is invalidated, a refusing
//! relay is audited and never touches the token (ADR-0204 D9 = ADR-0120 D4).
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:25930/momo \
//!   cargo test -p momo-notifier --test push_token_invalidation_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract (the same as `push_conformance_pg`, which this file does not
//! touch — it is 2,000 lines and a sibling issue edits it):
//!   * `DATABASE_URL` connects as a **superuser**: it applies every migration plus
//!     the DEVELOPMENT role file `bootstrap_roles.sql` and seeds fixtures;
//!   * the drain runs as `momo_notifier`;
//!   * the relay is a scripted [`PushDispatcher`], except in
//!     `the_real_transport_keeps_the_two_400s_apart`, which drives the real
//!     [`RelayHttpDispatcher`] against a loopback HTTP stub.
//!
//! The development role file grants the notifier every verb on every table, so
//! nothing here can see a missing production grant. That is
//! `prod_role_conformance_pg`'s job (it runs `UPDATE push_token` as the real
//! production role); this file proves the behaviour.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_410_invalidates_the_token_and_the_next_message_skips_it` | drop the 410 arm of `dead_token_reason`, or skip the UPDATE |
//! | `bad_device_token_and_device_token_not_for_topic_invalidate_too` | drop either 400 arm |
//! | `answers_about_the_operator_or_the_network_leave_the_token_alone` | invalidate on any 400/403/429/5xx, or match the reason string loosely |
//! | `only_the_dead_token_of_a_member_with_two_devices_is_invalidated` | invalidate by `member_id` or `device_id` instead of the token row |
//! | `a_transient_failure_does_not_invalidate_and_the_candidate_is_retried` | settle or invalidate on `TransientFailure` |
//! | `a_relay_400_is_audited_once_an_hour_and_never_invalidates` | invalidate on the relay's own 400, drop the audit row, or drop its one-per-hour dedupe |
//! | `a_failing_invalidation_never_loses_the_receipt` | run the UPDATE outside a SAVEPOINT |
//! | `settle_dispatch_and_invalidate_names_what_it_did` | drop the `workspace_id` predicate or the `invalidated_at IS NULL` guard of the UPDATE |
//! | `the_real_transport_keeps_the_two_400s_apart` | read the relay's HTTP 400 as an APNs answer, or drop the body excerpt |

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_notifier::{PushConfig, PushDrain, RelayHttpDispatcher};
use momo_push::{
    settle_dispatch_and_invalidate, DeadTokenReason, DispatchOutcome, PushDispatch, PushDispatcher,
    SettleOutcome,
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
// the scripted relay
// ---------------------------------------------------------------------------

/// Records every dispatch and answers with a scripted outcome, per APNs token or
/// for everyone. It stands where the PushRelay stands in production.
struct ScriptedRelay {
    sent: Mutex<Vec<PushDispatch>>,
    by_token: Mutex<HashMap<String, DispatchOutcome>>,
    default: Mutex<DispatchOutcome>,
}

impl ScriptedRelay {
    fn answering(outcome: DispatchOutcome) -> Arc<Self> {
        Arc::new(ScriptedRelay {
            sent: Mutex::new(Vec::new()),
            by_token: Mutex::new(HashMap::new()),
            default: Mutex::new(outcome),
        })
    }

    fn receipt(apns_status: i32, apns_reason: Option<&str>) -> DispatchOutcome {
        DispatchOutcome::Accepted {
            apns_status,
            apns_reason: apns_reason.map(str::to_string),
        }
    }

    fn answer_token(&self, apns_token: &str, outcome: DispatchOutcome) {
        self.by_token
            .lock()
            .unwrap()
            .insert(apns_token.to_string(), outcome);
    }

    fn sent(&self) -> Vec<PushDispatch> {
        self.sent.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl PushDispatcher for ScriptedRelay {
    async fn dispatch(&self, dispatch: &PushDispatch) -> DispatchOutcome {
        self.sent.lock().unwrap().push(dispatch.clone());
        if let Some(outcome) = self.by_token.lock().unwrap().get(&dispatch.apns_token) {
            return outcome.clone();
        }
        self.default.lock().unwrap().clone()
    }
}

fn drain(pool: &PgPool, dispatcher: Arc<dyn PushDispatcher>) -> PushDrain {
    PushDrain::new(pool.clone(), PushConfig::for_target(), dispatcher)
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

struct Fixture {
    workspace_id: Uuid,
    author_id: Uuid,
    recipient_id: Uuid,
    channel_id: Uuid,
    token_id: Uuid,
    apns_token: String,
}

/// A DM with an author and one recipient who owns one registered device.
async fn seed_dm_fixture(su: &PgPool) -> Fixture {
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
    for member_id in [author_id, recipient_id] {
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
             VALUES ($1, $2, 'human'::member_kind, 'active', $3, $3)",
        )
        .bind(member_id)
        .bind(workspace_id)
        .bind(format!("m{}", member_id.simple()))
        .execute(su)
        .await
        .expect("seed member");
    }
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, dm_key) \
         VALUES ($1, $2, 'dm', 'invalidation', $3)",
    )
    .bind(channel_id)
    .bind(workspace_id)
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
    let apns_token = Uuid::new_v4().simple().to_string().repeat(2);
    let token_id: Uuid = sqlx::query_scalar(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, 'kim.dawn.momo.e2e') RETURNING id",
    )
    .bind(workspace_id)
    .bind(device_id)
    .bind(recipient_id)
    .bind(&apns_token)
    .fetch_one(su)
    .await
    .expect("seed push token");

    Fixture {
        workspace_id,
        author_id,
        recipient_id,
        channel_id,
        token_id,
        apns_token,
    }
}

/// A second device (and token) for the recipient. Returns `(token_id, apns_token)`.
async fn add_second_device(su: &PgPool, fixture: &Fixture) -> (Uuid, String) {
    let device_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO device (id, workspace_id, member_id, platform) \
         VALUES ($1, $2, $3, 'ios'::device_platform)",
    )
    .bind(device_id)
    .bind(fixture.workspace_id)
    .bind(fixture.recipient_id)
    .execute(su)
    .await
    .expect("seed second device");
    let apns_token = Uuid::new_v4().simple().to_string().repeat(2);
    let token_id: Uuid = sqlx::query_scalar(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, 'kim.dawn.momo.e2e') RETURNING id",
    )
    .bind(fixture.workspace_id)
    .bind(device_id)
    .bind(fixture.recipient_id)
    .bind(&apns_token)
    .fetch_one(su)
    .await
    .expect("seed second push token");
    (token_id, apns_token)
}

/// Insert a message, which fires the 011 trigger and enqueues one candidate.
async fn send_message(su: &PgPool, fixture: &Fixture, seq: i64) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body) \
         VALUES ($1, $2, $3, $3, 0, $4, 'text', 'hello') RETURNING id",
    )
    .bind(fixture.workspace_id)
    .bind(fixture.channel_id)
    .bind(seq)
    .bind(fixture.author_id)
    .fetch_one(su)
    .await
    .expect("insert message (fires push_candidate_enqueue_trg)")
}

async fn is_invalidated(su: &PgPool, token_id: Uuid) -> bool {
    sqlx::query_scalar("SELECT invalidated_at IS NOT NULL FROM push_token WHERE id = $1")
        .bind(token_id)
        .fetch_one(su)
        .await
        .expect("read push_token")
}

/// `(push_token_id, apns_status, apns_reason)` of every dispatch-log row of the
/// workspace, oldest first.
async fn log_rows(
    su: &PgPool,
    workspace_id: Uuid,
) -> Vec<(Option<Uuid>, Option<i32>, Option<String>)> {
    sqlx::query(
        "SELECT push_token_id, apns_status, apns_reason FROM push_dispatch_log \
          WHERE workspace_id = $1 ORDER BY id",
    )
    .bind(workspace_id)
    .fetch_all(su)
    .await
    .expect("read dispatch log")
    .into_iter()
    .map(|row| {
        (
            row.get("push_token_id"),
            row.get("apns_status"),
            row.get("apns_reason"),
        )
    })
    .collect()
}

/// `(status, attempts)` of every push candidate of the workspace.
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

async fn refusal_audit_count(su: &PgPool, workspace_id: Uuid, token_id: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 AND action = 'push.relay.refused' \
            AND target_type = 'push_token' AND target_id = $2",
    )
    .bind(workspace_id)
    .bind(token_id)
    .fetch_one(su)
    .await
    .expect("count relay refusal audit rows")
}

/// One message to the recipient, drained once. Returns the drain's tally.
async fn drain_one_message(
    su: &PgPool,
    notifier: &PgPool,
    relay: &Arc<ScriptedRelay>,
    fixture: &Fixture,
    seq: i64,
) -> momo_notifier::DrainStats {
    send_message(su, fixture, seq).await;
    focus_candidates(su, &[fixture.workspace_id]).await;
    drain(notifier, relay.clone())
        .drain_once(32)
        .await
        .expect("drain once")
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_410_invalidates_the_token_and_the_next_message_skips_it() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;

    // 410 with APNs' reason, and 410 with none: dead whatever the string says.
    for (label, reason) in [("Unregistered", Some("Unregistered")), ("no reason", None)] {
        let fixture = seed_dm_fixture(&su).await;
        let relay = ScriptedRelay::answering(ScriptedRelay::receipt(410, reason));

        let stats = drain_one_message(&su, &notifier, &relay, &fixture, 1).await;
        assert_eq!(stats.dispatched, 1, "{label}: the first message is sent");
        assert!(
            is_invalidated(&su, fixture.token_id).await,
            "{label}: a 410 invalidates the token"
        );
        let logs = log_rows(&su, fixture.workspace_id).await;
        assert_eq!(
            logs,
            vec![(
                Some(fixture.token_id),
                Some(410),
                reason.map(str::to_string)
            )],
            "{label}: the receipt is recorded next to the invalidation"
        );

        // The next message finds no active token: nothing is sent, the candidate
        // is simply done.
        let sent_before = relay.sent().len();
        let stats = drain_one_message(&su, &notifier, &relay, &fixture, 2).await;
        assert_eq!(stats.dispatched, 0, "{label}: nobody left to notify");
        assert_eq!(
            relay.sent().len(),
            sent_before,
            "{label}: the dead token is not sent to again"
        );
        assert!(
            candidate_status(&su, fixture.workspace_id)
                .await
                .iter()
                .all(|(status, _)| status == "done"),
            "{label}: both candidates are completed, not retried"
        );
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn bad_device_token_and_device_token_not_for_topic_invalidate_too() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;

    for reason in ["BadDeviceToken", "DeviceTokenNotForTopic"] {
        let fixture = seed_dm_fixture(&su).await;
        let relay = ScriptedRelay::answering(ScriptedRelay::receipt(400, Some(reason)));

        let stats = drain_one_message(&su, &notifier, &relay, &fixture, 1).await;
        assert_eq!(stats.dispatched, 1, "{reason}");
        assert!(
            is_invalidated(&su, fixture.token_id).await,
            "{reason}: invalidates the token"
        );
        assert_eq!(
            log_rows(&su, fixture.workspace_id).await,
            vec![(Some(fixture.token_id), Some(400), Some(reason.to_string()))],
            "{reason}"
        );
        let stats = drain_one_message(&su, &notifier, &relay, &fixture, 2).await;
        assert_eq!(stats.dispatched, 0, "{reason}: the next message skips it");
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn answers_about_the_operator_or_the_network_leave_the_token_alone() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;

    // None of these says the DEVICE is gone: provider-auth and topic problems are
    // the operator's, 429/5xx the network's, and a near-miss spelling is not APNs'.
    let alive: &[(i32, Option<&str>)] = &[
        (200, None),
        (400, Some("BadTopic")),
        (400, Some("PayloadEmpty")),
        (400, None),
        (400, Some("baddevicetoken")),
        (400, Some("BadDeviceToken ")),
        (403, Some("ExpiredProviderToken")),
        (403, Some("InvalidProviderToken")),
        (403, Some("DeviceTokenNotForTopic")),
        (413, Some("PayloadTooLarge")),
        (429, Some("TooManyRequests")),
        (500, Some("InternalServerError")),
        (503, Some("ServiceUnavailable")),
    ];
    for (status, reason) in alive {
        let fixture = seed_dm_fixture(&su).await;
        let relay = ScriptedRelay::answering(ScriptedRelay::receipt(*status, *reason));
        let stats = drain_one_message(&su, &notifier, &relay, &fixture, 1).await;
        assert_eq!(stats.dispatched, 1, "{status} {reason:?}");
        assert!(
            !is_invalidated(&su, fixture.token_id).await,
            "{status} {reason:?} must not invalidate a healthy token"
        );
        assert_eq!(
            log_rows(&su, fixture.workspace_id).await,
            vec![(
                Some(fixture.token_id),
                Some(*status),
                reason.map(str::to_string)
            )],
            "{status} {reason:?}: still settled verbatim"
        );
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn only_the_dead_token_of_a_member_with_two_devices_is_invalidated() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;

    let fixture = seed_dm_fixture(&su).await;
    let (second_token, second_apns) = add_second_device(&su, &fixture).await;
    let relay = ScriptedRelay::answering(ScriptedRelay::receipt(200, None));
    relay.answer_token(
        &fixture.apns_token,
        ScriptedRelay::receipt(410, Some("Unregistered")),
    );

    let stats = drain_one_message(&su, &notifier, &relay, &fixture, 1).await;
    assert_eq!(stats.dispatched, 2, "both devices are tried");
    assert!(
        is_invalidated(&su, fixture.token_id).await,
        "the dead one is invalidated"
    );
    assert!(
        !is_invalidated(&su, second_token).await,
        "the healthy device of the same member keeps its token"
    );

    // From now on only the healthy device is sent to.
    let sent_before = relay.sent().len();
    let stats = drain_one_message(&su, &notifier, &relay, &fixture, 2).await;
    assert_eq!(stats.dispatched, 1);
    let later = relay.sent()[sent_before..].to_vec();
    assert_eq!(later.len(), 1);
    assert_eq!(
        later[0].apns_token, second_apns,
        "and it is the healthy one"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_transient_failure_does_not_invalidate_and_the_candidate_is_retried() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;

    for reason in ["HTTP 429", "HTTP 503"] {
        let fixture = seed_dm_fixture(&su).await;
        let relay = ScriptedRelay::answering(DispatchOutcome::TransientFailure(reason.to_string()));
        let stats = drain_one_message(&su, &notifier, &relay, &fixture, 1).await;
        assert_eq!(stats.requeued, 1, "{reason}: the candidate goes back");
        assert!(
            !is_invalidated(&su, fixture.token_id).await,
            "{reason}: a transient failure says nothing about the token"
        );
        assert_eq!(
            log_rows(&su, fixture.workspace_id).await,
            vec![(Some(fixture.token_id), None, None)],
            "{reason}: the claim stays unsettled so the retry sends again"
        );
        assert_eq!(
            candidate_status(&su, fixture.workspace_id).await,
            vec![("pending".to_string(), 1)],
            "{reason}"
        );
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_relay_400_is_audited_once_an_hour_and_never_invalidates() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;

    let fixture = seed_dm_fixture(&su).await;
    let reason = "HTTP 400: dispatch APNs environment does not match relay";
    let relay = ScriptedRelay::answering(DispatchOutcome::PermanentFailure {
        relay_http_status: 400,
        reason: reason.to_string(),
    });

    let stats = drain_one_message(&su, &notifier, &relay, &fixture, 1).await;
    assert_eq!(stats.dispatched, 1);
    assert!(
        !is_invalidated(&su, fixture.token_id).await,
        "the relay's own 400 is the deployment's problem, never the device's"
    );
    assert_eq!(
        log_rows(&su, fixture.workspace_id).await,
        vec![(
            Some(fixture.token_id),
            Some(400),
            Some(format!("relay_http: {reason}"))
        )],
        "settled with the relay's real status and the relay_http: prefix"
    );
    assert_eq!(
        refusal_audit_count(&su, fixture.workspace_id, fixture.token_id).await,
        1,
        "one audit row for the first refusal"
    );
    let detail: serde_json::Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = 'push.relay.refused'",
    )
    .bind(fixture.workspace_id)
    .fetch_one(&su)
    .await
    .expect("read the audit detail");
    assert_eq!(detail["schema"], "momo.push.relay.refused.v1");
    assert_eq!(detail["relay_http_status"], 400);
    assert_eq!(detail["reason"], reason);
    assert_eq!(detail["apns_env"], "sandbox");
    assert_eq!(detail["apns_topic"], "kim.dawn.momo.e2e");
    assert_eq!(detail["device_platform"], "ios");
    assert_eq!(detail["token_invalidated"], false);
    assert!(
        !detail.to_string().contains(&fixture.apns_token),
        "the device token's value never reaches the audit log"
    );

    // A second refusal inside the hour is recorded in the log but not re-audited.
    drain_one_message(&su, &notifier, &relay, &fixture, 2).await;
    assert_eq!(log_rows(&su, fixture.workspace_id).await.len(), 2);
    assert_eq!(
        refusal_audit_count(&su, fixture.workspace_id, fixture.token_id).await,
        1,
        "still one row: the hour is a window, not a count"
    );
    assert!(!is_invalidated(&su, fixture.token_id).await);

    // Past the window the next refusal is audited again: the dedupe is an hour,
    // not forever.
    sqlx::query(
        "UPDATE audit_log SET created_at = now() - interval '2 hours' \
          WHERE workspace_id = $1 AND action = 'push.relay.refused'",
    )
    .bind(fixture.workspace_id)
    .execute(&su)
    .await
    .expect("age the audit row");
    drain_one_message(&su, &notifier, &relay, &fixture, 3).await;
    assert_eq!(
        refusal_audit_count(&su, fixture.workspace_id, fixture.token_id).await,
        2
    );

    // Only a 400 is audited (ADR-0204 D9 names the environment mismatch): a 403
    // from the relay is recorded and nothing else.
    let other = seed_dm_fixture(&su).await;
    let forbidden = ScriptedRelay::answering(DispatchOutcome::PermanentFailure {
        relay_http_status: 403,
        reason: "HTTP 403".to_string(),
    });
    drain_one_message(&su, &notifier, &forbidden, &other, 1).await;
    assert_eq!(
        log_rows(&su, other.workspace_id).await,
        vec![(
            Some(other.token_id),
            Some(403),
            Some("relay_http: HTTP 403".to_string())
        )]
    );
    assert_eq!(
        refusal_audit_count(&su, other.workspace_id, other.token_id).await,
        0,
        "a relay 403 is not audited"
    );
    assert!(!is_invalidated(&su, other.token_id).await);
}

/// Make every `UPDATE` of one push token fail, like a missing grant would. The
/// trigger is scoped to the row, so nothing else in the shared database notices.
async fn make_updates_of_this_token_fail(su: &PgPool, token_id: Uuid) {
    // A run that panicked between create and drop must not poison the next one.
    stop_refusing_updates(su).await;
    sqlx::query(
        "CREATE OR REPLACE FUNCTION push_token_refuse_update_3930() RETURNS trigger \
         LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused by the 3930 test'; END $$",
    )
    .execute(su)
    .await
    .expect("create the refusing function");
    sqlx::query(&format!(
        "CREATE TRIGGER push_token_refuse_update_3930 BEFORE UPDATE ON push_token \
         FOR EACH ROW WHEN (OLD.id = '{token_id}') \
         EXECUTE FUNCTION push_token_refuse_update_3930()"
    ))
    .execute(su)
    .await
    .expect("create the refusing trigger");
}

async fn stop_refusing_updates(su: &PgPool) {
    sqlx::query("DROP TRIGGER IF EXISTS push_token_refuse_update_3930 ON push_token")
        .execute(su)
        .await
        .expect("drop the refusing trigger");
    sqlx::query("DROP FUNCTION IF EXISTS push_token_refuse_update_3930()")
        .execute(su)
        .await
        .expect("drop the refusing function");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_failing_invalidation_never_loses_the_receipt() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;

    // A deploy that starts the notifier before the role file lands, a trigger, a
    // lock timeout: the UPDATE fails. The receipt must still be recorded — an
    // unsettled claim is re-sent on every redelivery.
    let fixture = seed_dm_fixture(&su).await;
    make_updates_of_this_token_fail(&su, fixture.token_id).await;
    let relay = ScriptedRelay::answering(ScriptedRelay::receipt(410, Some("Unregistered")));
    let stats = drain_one_message(&su, &notifier, &relay, &fixture, 1).await;
    let logs = log_rows(&su, fixture.workspace_id).await;
    let invalidated = is_invalidated(&su, fixture.token_id).await;
    let candidates = candidate_status(&su, fixture.workspace_id).await;
    stop_refusing_updates(&su).await;

    assert_eq!(stats.dispatched, 1, "the send is not undone by the failure");
    assert_eq!(
        logs,
        vec![(
            Some(fixture.token_id),
            Some(410),
            Some("Unregistered".to_string())
        )],
        "the receipt is settled although the invalidation failed"
    );
    assert!(
        !invalidated,
        "and the token is untouched (the UPDATE rolled back to its savepoint)"
    );
    assert_eq!(
        candidates,
        vec![("done".to_string(), 1)],
        "claimed once, completed once: a failed invalidation is not a retry"
    );

    // Once the cause is gone the next dead answer invalidates it normally.
    let stats = drain_one_message(&su, &notifier, &relay, &fixture, 2).await;
    assert_eq!(stats.dispatched, 1);
    assert!(
        is_invalidated(&su, fixture.token_id).await,
        "self-healing: the next 410 gets through"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn settle_dispatch_and_invalidate_names_what_it_did() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;

    let fixture = seed_dm_fixture(&su).await;
    let message = send_message(&su, &fixture, 1).await;
    // Park the candidate: this test settles by hand, nothing may drain it.
    focus_candidates(&su, &[]).await;

    // A claimed, unsettled dispatch-log row for the token, as `claim_dispatch` leaves it.
    let mut next_log = 0;
    let mut claim = |collapse_suffix: &str| {
        next_log += 1;
        let collapse = format!("m:{message}:{collapse_suffix}:{next_log}");
        let su = su.clone();
        let fixture_workspace = fixture.workspace_id;
        let recipient = fixture.recipient_id;
        let token = fixture.token_id;
        async move {
            sqlx::query_scalar::<_, Uuid>(
                "INSERT INTO push_dispatch_log \
                   (workspace_id, message_id, member_id, push_token_id, collapse_id) \
                 VALUES ($1, $2, $3, $4, $5) RETURNING id",
            )
            .bind(fixture_workspace)
            .bind(message)
            .bind(recipient)
            .bind(token)
            .bind(collapse)
            .fetch_one(&su)
            .await
            .expect("claim a dispatch-log row")
        }
    };
    let settle = |workspace: Uuid, log: Uuid, status: i32, reason: Option<&'static str>| {
        let notifier = notifier.clone();
        let token = fixture.token_id;
        async move {
            with_tenant_tx(&notifier, workspace, move |conn| {
                Box::pin(async move {
                    settle_dispatch_and_invalidate(conn, workspace, log, token, status, reason)
                        .await
                })
            })
            .await
            .expect("settle")
        }
    };

    // A healthy receipt settles and leaves the token alone.
    let log = claim("ok").await;
    assert_eq!(
        settle(fixture.workspace_id, log, 200, None).await,
        SettleOutcome::Settled
    );
    assert!(!is_invalidated(&su, fixture.token_id).await);

    // The tenant is part of the UPDATE's identity: a mismatched workspace finds no
    // live row, and the token survives.
    let log = claim("foreign").await;
    let foreign = Uuid::new_v4();
    let outcome = {
        let notifier = notifier.clone();
        let token = fixture.token_id;
        let workspace = fixture.workspace_id;
        with_tenant_tx(&notifier, workspace, move |conn| {
            Box::pin(async move {
                settle_dispatch_and_invalidate(conn, foreign, log, token, 410, Some("Unregistered"))
                    .await
            })
        })
        .await
        .expect("settle with a foreign workspace id")
    };
    assert_eq!(outcome, SettleOutcome::NoLiveToken(DeadTokenReason::Gone));
    assert!(
        !is_invalidated(&su, fixture.token_id).await,
        "a settle that names another tenant cannot invalidate this tenant's token"
    );

    // The real thing.
    let log = claim("dead").await;
    assert_eq!(
        settle(fixture.workspace_id, log, 410, Some("Unregistered")).await,
        SettleOutcome::Invalidated(DeadTokenReason::Gone)
    );
    assert!(is_invalidated(&su, fixture.token_id).await);
    let stamped: (bool, bool) = sqlx::query_as(
        "SELECT invalidated_at IS NOT NULL, updated_at >= invalidated_at \
           FROM push_token WHERE id = $1",
    )
    .bind(fixture.token_id)
    .fetch_one(&su)
    .await
    .expect("read stamps");
    assert_eq!(
        stamped,
        (true, true),
        "invalidated_at and updated_at move together"
    );

    // A second dead answer for the same token changes nothing and says so (the
    // `invalidated_at IS NULL` guard keeps the first timestamp).
    let first: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT invalidated_at FROM push_token WHERE id = $1")
            .bind(fixture.token_id)
            .fetch_one(&su)
            .await
            .expect("read first stamp");
    let log = claim("dead-again").await;
    assert_eq!(
        settle(fixture.workspace_id, log, 400, Some("BadDeviceToken")).await,
        SettleOutcome::NoLiveToken(DeadTokenReason::BadDeviceToken)
    );
    let second: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT invalidated_at FROM push_token WHERE id = $1")
            .bind(fixture.token_id)
            .fetch_one(&su)
            .await
            .expect("read second stamp");
    assert_eq!(
        first, second,
        "an already-invalid token keeps its first invalidated_at"
    );

    // A failing UPDATE is reported with its cause, and the receipt still lands.
    let other = seed_dm_fixture(&su).await;
    let other_message = send_message(&su, &other, 1).await;
    focus_candidates(&su, &[]).await;
    let other_log: Uuid = sqlx::query_scalar(
        "INSERT INTO push_dispatch_log \
           (workspace_id, message_id, member_id, push_token_id, collapse_id) \
         VALUES ($1, $2, $3, $4, 'c-refused') RETURNING id",
    )
    .bind(other.workspace_id)
    .bind(other_message)
    .bind(other.recipient_id)
    .bind(other.token_id)
    .fetch_one(&su)
    .await
    .expect("claim");
    make_updates_of_this_token_fail(&su, other.token_id).await;
    let failed = with_tenant_tx(&notifier, other.workspace_id, {
        let workspace = other.workspace_id;
        let token = other.token_id;
        move |conn| {
            Box::pin(async move {
                settle_dispatch_and_invalidate(
                    conn,
                    workspace,
                    other_log,
                    token,
                    410,
                    Some("Unregistered"),
                )
                .await
            })
        }
    })
    .await
    .expect("settle");
    let landed = log_rows(&su, other.workspace_id).await;
    stop_refusing_updates(&su).await;
    match failed {
        SettleOutcome::InvalidationFailed { reason, error } => {
            assert_eq!(reason, DeadTokenReason::Gone);
            assert!(error.contains("refused by the 3930 test"), "{error}");
        }
        unexpected => panic!("expected InvalidationFailed, got {unexpected:?}"),
    }
    assert_eq!(
        landed,
        vec![(
            Some(other.token_id),
            Some(410),
            Some("Unregistered".to_string())
        )]
    );
    assert!(!is_invalidated(&su, other.token_id).await);
}

// ---------------------------------------------------------------------------
// the real transport against a loopback relay
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct StubRelay {
    /// `apns_token` -> (HTTP status, body)
    answers: Arc<Mutex<HashMap<String, (u16, String)>>>,
}

async fn stub_push(State(stub): State<StubRelay>, body: Bytes) -> (StatusCode, String) {
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    let token = value["apns_token"].as_str().unwrap_or_default().to_string();
    let (status, text) = stub
        .answers
        .lock()
        .unwrap()
        .get(&token)
        .cloned()
        .unwrap_or((200, r#"{"apns_status":200}"#.to_string()));
    (StatusCode::from_u16(status).expect("status"), text)
}

async fn spawn_stub_relay() -> (StubRelay, String) {
    let stub = StubRelay::default();
    let app = Router::new()
        .route("/v1/push", post(stub_push))
        .with_state(stub.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind the stub relay");
    let address = listener.local_addr().expect("stub relay address");
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    (stub, format!("http://{address}/v1/push"))
}

/// The two kinds of 400 the notifier can meet, through the REAL transport:
/// APNs' own `400 BadDeviceToken` arrives inside a 200 receipt and kills the token;
/// the relay's own `HTTP 400` (a body explaining itself) leaves the token alone and
/// leaves an audit row that quotes the relay (review #424 M1, ADR-0204 D9).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn the_real_transport_keeps_the_two_400s_apart() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let (stub, url) = spawn_stub_relay().await;
    let dispatcher: Arc<dyn PushDispatcher> = Arc::new(
        RelayHttpDispatcher::new(url, "momo-local", None).expect("build the relay client"),
    );

    // (1) APNs said 410: HTTP 200 with the receipt -> invalidated.
    let dead = seed_dm_fixture(&su).await;
    stub.answers.lock().unwrap().insert(
        dead.apns_token.clone(),
        (
            200,
            r#"{"apns_status":410,"apns_reason":"Unregistered"}"#.to_string(),
        ),
    );
    send_message(&su, &dead, 1).await;
    focus_candidates(&su, &[dead.workspace_id]).await;
    drain(&notifier, dispatcher.clone())
        .drain_once(32)
        .await
        .expect("drain");
    assert!(
        is_invalidated(&su, dead.token_id).await,
        "APNs 410 over the wire"
    );
    assert_eq!(
        log_rows(&su, dead.workspace_id).await,
        vec![(
            Some(dead.token_id),
            Some(410),
            Some("Unregistered".to_string())
        )]
    );

    // (2) APNs said 400 BadDeviceToken: also a 200 receipt -> invalidated.
    let bad = seed_dm_fixture(&su).await;
    stub.answers.lock().unwrap().insert(
        bad.apns_token.clone(),
        (
            200,
            r#"{"apns_status":400,"apns_reason":"BadDeviceToken"}"#.to_string(),
        ),
    );
    send_message(&su, &bad, 1).await;
    focus_candidates(&su, &[bad.workspace_id]).await;
    drain(&notifier, dispatcher.clone())
        .drain_once(32)
        .await
        .expect("drain");
    assert!(
        is_invalidated(&su, bad.token_id).await,
        "APNs 400 BadDeviceToken over the wire"
    );

    // (3) The RELAY said HTTP 400 with its own explanation -> token kept, audited.
    let refused = seed_dm_fixture(&su).await;
    stub.answers.lock().unwrap().insert(
        refused.apns_token.clone(),
        (
            400,
            "dispatch APNs environment does not match relay\n".to_string(),
        ),
    );
    send_message(&su, &refused, 1).await;
    focus_candidates(&su, &[refused.workspace_id]).await;
    drain(&notifier, dispatcher.clone())
        .drain_once(32)
        .await
        .expect("drain");
    assert!(
        !is_invalidated(&su, refused.token_id).await,
        "the relay's HTTP 400 never invalidates"
    );
    assert_eq!(
        log_rows(&su, refused.workspace_id).await,
        vec![(
            Some(refused.token_id),
            Some(400),
            Some(
                "relay_http: HTTP 400: dispatch APNs environment does not match relay".to_string()
            )
        )],
        "the log quotes the relay"
    );
    assert_eq!(
        refusal_audit_count(&su, refused.workspace_id, refused.token_id).await,
        1
    );

    // (4) The same text as a 200 body is a receipt that is not JSON: accepted as
    // 200 (parity with `decode_receipt`), not an invalidation.
    let odd = seed_dm_fixture(&su).await;
    stub.answers
        .lock()
        .unwrap()
        .insert(odd.apns_token.clone(), (200, "BadDeviceToken".to_string()));
    send_message(&su, &odd, 1).await;
    focus_candidates(&su, &[odd.workspace_id]).await;
    drain(&notifier, dispatcher.clone())
        .drain_once(32)
        .await
        .expect("drain");
    assert!(!is_invalidated(&su, odd.token_id).await);
    assert_eq!(
        log_rows(&su, odd.workspace_id).await,
        vec![(Some(odd.token_id), Some(200), None)]
    );
}
