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
//!     `infra/e2e/bootstrap_roles.sql`, and seeds fixtures bypassing RLS;
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
//! | `a_transient_relay_failure_requeues_instead_of_dropping` | settle on transient failure |

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::PgPool;
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
            "/../../../infra/e2e/bootstrap_roles.sql"
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
