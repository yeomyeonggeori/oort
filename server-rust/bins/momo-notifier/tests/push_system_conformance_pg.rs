//! DB-backed conformance for the `push_system` drain — the second consumer of the push feed
//! (ADR-0206 D11·D15, #4341): the test notification a member sends to their own devices.
//!
//! Each test proves one property of "a push that names no message reaches the named member's own
//! tokens, says nothing about anybody, and is never retried against the relay", with a sabotage
//! that turns it red. `#[ignore]` because they need a `pgvector/pgvector:pg18` database plus the
//! runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/<db> \
//!   cargo test -p momo-notifier --test push_system_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! Harness contract (same as `push_conformance_pg`): `DATABASE_URL` connects as a **superuser**
//! (migrations, `bootstrap_roles.sql`, fixtures); the drain runs as **`momo_notifier`** (BYPASSRLS).
//! The relay is a stand-in: a recording mock, a scripted loopback stub, or — where the point is the
//! relay's own words — the **real relay router** (`momo-push-relay`, stub APNs) over loopback.
//! Nothing here contacts Apple.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_test_push_goes_to_the_named_members_tokens_only_and_logs_no_message` | drop the `t.member_id = $2` predicate in `system_targets` / claim with a nil message id (FK) / put a name on the envelope |
//! | `a_test_push_reaches_the_five_freshest_tokens_and_never_a_sixth` | six live tokens → five relay calls, the stalest token left out (review H-1) | drop the `LIMIT` of `system_targets` / order by something other than `updated_at DESC` |
//! | `a_forged_payload_never_reaches_another_tenants_tokens` | drop the `workspace_id` predicates of `system_targets` |
//! | `a_member_without_a_live_token_gets_a_finished_row_and_no_log` | send to a suspended member / to dead tokens |
//! | `the_two_push_feeds_never_drain_each_other` | widen either claim's `kind` filter |
//! | `an_old_relay_refusing_the_vocabulary_is_settled_once_and_never_retried` | requeue a permanent refusal / invalidate the token on a relay 400 |
//! | `an_environment_mismatch_is_a_failure_not_an_outdated_relay` | classify every 400 as the vocabulary refusal |
//! | `a_relay_429_or_5xx_is_settled_as_failed_and_never_retried` | requeue a transient failure of a test push |
//! | `a_relay_that_cannot_be_reached_leaves_the_claim_unsettled_and_the_row_done` | settle a transport failure / fail the outbox row |
//! | `a_redelivered_row_does_not_send_twice_and_a_crashed_claim_is_taken_over` | drop the dispatch-log claim |
//! | `a_410_receipt_invalidates_the_token_like_any_push` | skip `settle_dispatch_and_invalidate` |
//! | `a_payload_this_build_cannot_read_is_parked_never_sent` | guess at an unknown reason / accept an extra key |
//! | `the_real_relay_accepts_the_test_push_and_speaks_its_static_body` | drop `test_notification`/`momo.system` from the relay vocabulary / put a name in the body |
//! | `the_real_relays_refusal_texts_are_what_the_diagnostics_classify` | reword the relay's refusal without the classifier |
//! | `a_test_past_the_server_budget_is_settled_429_and_never_sent` | (#5091) skip the budget spend (every token is sent) / leave the over-budget claim unsettled / settle it with another reason or leave the reason out of `SERVER_DROP_REASONS` (the diagnostics then say `last_delivery_failed` or `relay_unreachable`) |
//! | `a_redelivered_test_does_not_spend_the_budget_twice` | (#5091) spend the budget before the claim (already-settled tokens cost budget a redelivery does not owe) |
//! | `a_test_row_older_than_five_minutes_is_settled_unsent_and_a_younger_one_still_goes` | (#5091) drop the age check / move the limit to 60 s or 3600 s / skip the settled rows (`lastTest` reads `stalled`, the diagnostics infer `relay_unreachable`) |

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_notifier::{PushConfig, PushDrain, RelayHttpDispatcher};
use momo_outbox::{emit_outbox, emit_push_system, OutboxKind, PushSystemReason};
use momo_push::{
    apns_reason_code, compute_diagnostics, is_relay_vocabulary_refusal,
    test_notification_collapse_id, BlockerCode, Diagnostics, DispatchOutcome, LastTestStatus,
    PushDispatch, PushDispatcher, BUDGET_SPENT_REASON, BUDGET_SPENT_STATUS, TEST_EXPIRED_REASON,
    TEST_EXPIRED_STATUS,
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

/// The BYPASSRLS notifier credential (`bootstrap_roles.sql`).
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
        .args([
            "-v",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "--quiet",
            "--single-transaction",
            "-f",
        ])
        .arg(PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        )))
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

/// The drains claim globally, so two concurrent tests would eat each other's rows. Serialize them.
async fn drain_test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

/// Push every pending outbox row this test does not own out of the claim window. Non-destructive:
/// it only reschedules (the rows of earlier runs and of other fixtures stay what they are).
async fn focus(su: &PgPool, keep_workspace: &[Uuid]) {
    sqlx::query(
        "UPDATE outbox \
            SET available_at = clock_timestamp() + interval '1 hour' \
          WHERE kind IN ('push_system', 'push_candidate') \
            AND status = 'pending' \
            AND NOT (workspace_id = ANY($1))",
    )
    .bind(keep_workspace)
    .execute(su)
    .await
    .expect("park rows belonging to other fixtures");
}

// ---------------------------------------------------------------------------
// the injected relays
// ---------------------------------------------------------------------------

/// Records every dispatch and answers with a scripted outcome.
struct RecordingRelay {
    sent: Mutex<Vec<PushDispatch>>,
    outcome: Mutex<DispatchOutcome>,
}

impl RecordingRelay {
    fn answering(outcome: DispatchOutcome) -> Arc<Self> {
        Arc::new(RecordingRelay {
            sent: Mutex::new(Vec::new()),
            outcome: Mutex::new(outcome),
        })
    }

    fn accepting() -> Arc<Self> {
        Self::answering(DispatchOutcome::Accepted {
            apns_status: 200,
            apns_reason: None,
        })
    }

    fn sent(&self) -> Vec<PushDispatch> {
        self.sent.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl PushDispatcher for RecordingRelay {
    async fn dispatch(&self, dispatch: &PushDispatch) -> DispatchOutcome {
        self.sent.lock().unwrap().push(dispatch.clone());
        self.outcome.lock().unwrap().clone()
    }
}

/// A loopback relay that answers per `apns_token` with a scripted (status, body).
#[derive(Clone, Default)]
struct StubRelay {
    answers: Arc<Mutex<HashMap<String, (u16, String)>>>,
}

async fn stub_push(State(stub): State<StubRelay>, body: Bytes) -> (StatusCode, String) {
    let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
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

fn drain(pool: &PgPool, dispatcher: Arc<dyn PushDispatcher>) -> PushDrain {
    PushDrain::new(pool.clone(), PushConfig::for_target(), dispatcher)
}

fn over_http(url: String, seed: Option<[u8; 32]>) -> Arc<dyn PushDispatcher> {
    Arc::new(RelayHttpDispatcher::new(url, "momo-local", seed).expect("build the relay client"))
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/// Display names no dispatch may ever carry. Minted per run so a stale row cannot satisfy a check.
fn marker() -> &'static str {
    static MARKER: OnceLock<String> = OnceLock::new();
    MARKER.get_or_init(|| format!("민감한이름-{}", Uuid::new_v4().simple()))
}

struct Tenant {
    workspace: Uuid,
    me: Uuid,
    other: Uuid,
    channel: Uuid,
}

async fn seed_member(su: &PgPool, workspace: Uuid, label: &str) -> Uuid {
    let id = Uuid::new_v4();
    let handle = format!("h-{}", &id.simple().to_string()[..10]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(format!("{label}-{}", marker()))
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed member");
    id
}

async fn seed_tenant(su: &PgPool) -> Tenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $3)")
        .bind(workspace)
        .bind(format!("sys-{workspace}"))
        .bind(format!("ws-{}", marker()))
        .execute(su)
        .await
        .expect("seed workspace");
    let me = seed_member(su, workspace, "me").await;
    let other = seed_member(su, workspace, "other").await;
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', $3, '', $4)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(format!("ch-{}", &channel.simple().to_string()[..8]))
    .bind(me)
    .execute(su)
    .await
    .expect("seed channel");
    // Three unread lines for `me` (the app-icon badge a push must carry, never a reset to 0).
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 3)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(workspace)
        .bind(channel)
        .bind(me)
        .execute(su)
        .await
        .expect("seed membership");
    Tenant {
        workspace,
        me,
        other,
        channel,
    }
}

/// One live token on a new device. Returns `(token id, apns token)`.
async fn seed_token(su: &PgPool, workspace: Uuid, member: Uuid) -> (Uuid, String) {
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
    let apns = Uuid::new_v4().simple().to_string().repeat(2);
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, 'kim.dawn.momo.e2e') RETURNING id",
    )
    .bind(workspace)
    .bind(device)
    .bind(member)
    .bind(&apns)
    .fetch_one(su)
    .await
    .expect("seed push token");
    (id, apns)
}

/// Enqueue one test push the way the route does (`emit_push_system`), returning the test id.
async fn emit_test(su: &PgPool, workspace: Uuid, member: Uuid) -> Uuid {
    let test_id = Uuid::new_v4();
    emit_push_system(
        su,
        workspace,
        PushSystemReason::TestNotification,
        member,
        None,
        test_id,
        &test_notification_collapse_id(test_id),
    )
    .await
    .expect("enqueue the test push");
    test_id
}

struct LogRow {
    token: Uuid,
    message_id: Option<Uuid>,
    status: Option<i32>,
    reason: Option<String>,
    collapse: String,
}

/// `(push_token_id, message_id, apns_status, apns_reason, collapse_id)` as the log stores them.
type LogRecord = (
    Option<Uuid>,
    Option<Uuid>,
    Option<i32>,
    Option<String>,
    Option<String>,
);

async fn log_rows(su: &PgPool, workspace: Uuid, member: Uuid) -> Vec<LogRow> {
    let rows: Vec<LogRecord> = sqlx::query_as(
        "SELECT push_token_id, message_id, apns_status, apns_reason, collapse_id \
               FROM push_dispatch_log WHERE workspace_id = $1 AND member_id = $2 \
              ORDER BY created_at, id",
    )
    .bind(workspace)
    .bind(member)
    .fetch_all(su)
    .await
    .expect("read the dispatch log");
    rows.into_iter()
        .map(|(token, message_id, status, reason, collapse)| LogRow {
            token: token.expect("a token"),
            message_id,
            status,
            reason,
            collapse: collapse.expect("a collapse id"),
        })
        .collect()
}

async fn outbox_state(su: &PgPool, workspace: Uuid) -> Vec<(String, i32, Option<String>)> {
    sqlx::query_as(
        "SELECT status::text, attempts, last_error FROM outbox \
          WHERE workspace_id = $1 AND kind = 'push_system' ORDER BY id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read push_system rows")
}

async fn is_invalidated(su: &PgPool, token: Uuid) -> bool {
    sqlx::query_scalar("SELECT invalidated_at IS NOT NULL FROM push_token WHERE id = $1")
        .bind(token)
        .fetch_one(su)
        .await
        .expect("read token")
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_test_push_goes_to_the_named_members_tokens_only_and_logs_no_message() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let tenant = seed_tenant(&su).await;
    let (mine_a, _) = seed_token(&su, tenant.workspace, tenant.me).await;
    let (mine_b, _) = seed_token(&su, tenant.workspace, tenant.me).await;
    let (theirs, _) = seed_token(&su, tenant.workspace, tenant.other).await;
    let test_id = emit_test(&su, tenant.workspace, tenant.me).await;
    focus(&su, &[tenant.workspace]).await;

    let relay = RecordingRelay::accepting();
    let stats = drain(&notifier, relay.clone())
        .drain_system_once(32)
        .await
        .expect("drain");
    assert_eq!(
        (stats.claimed, stats.dispatched, stats.failed),
        (1, 2, 0),
        "{stats:?}"
    );

    // Exactly the caller's two tokens — nothing for the other member, who has a live token too.
    let sent = relay.sent();
    assert_eq!(sent.len(), 2, "{sent:?}");
    let mine = [mine_a, mine_b];
    let log = log_rows(&su, tenant.workspace, tenant.me).await;
    assert_eq!(log.len(), 2);
    for row in &log {
        assert!(
            mine.contains(&row.token),
            "a log row for a token that is not the caller's"
        );
        assert_eq!(
            row.message_id, None,
            "the log row names no message: NULL, not a nil id"
        );
        assert_eq!(row.status, Some(200));
        assert_eq!(row.collapse, test_notification_collapse_id(test_id));
    }
    assert!(
        log_rows(&su, tenant.workspace, tenant.other)
            .await
            .is_empty(),
        "the other member's token {theirs} must get nothing"
    );

    // The envelope: the test's reason under `momo.system`, the nil sentinel for every id the push
    // does not have, the member's real badge (3 unread), and only the closed id-only key set.
    let nil = Uuid::nil().to_string();
    for dispatch in &sent {
        assert_eq!(dispatch.reason, "test_notification");
        assert_eq!(dispatch.category, "momo.system");
        assert_eq!(
            (
                &dispatch.channel_id,
                &dispatch.message_id,
                &dispatch.thread_id
            ),
            (&nil, &nil, &nil)
        );
        assert_eq!(dispatch.collapse_id, test_notification_collapse_id(test_id));
        assert_eq!(
            dispatch.badge, 3,
            "a test must not reset the app icon's badge"
        );
        assert_eq!(dispatch.approval_id, None);
        let wire = serde_json::to_value(dispatch).unwrap();
        let mut keys: Vec<&str> = wire
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "apns_env",
                "apns_token",
                "apns_topic",
                "badge",
                "category",
                "channel_id",
                "collapse_id",
                "device_id",
                "device_platform",
                "message_id",
                "reason",
                "schema",
                "server_id",
                "thread_id",
                "workspace_id",
            ],
            "the test push's envelope is the closed id-only set"
        );
        let text = wire.to_string();
        assert!(
            !text.contains(marker()),
            "a display name reached the relay payload: {text}"
        );
        assert!(
            !text.contains(&tenant.other.to_string()),
            "the other member leaked: {text}"
        );
        assert!(
            !text.contains(&tenant.channel.to_string()),
            "a channel id leaked: {text}"
        );
    }
    assert_eq!(outbox_state(&su, tenant.workspace).await[0].0, "done");
}

/// #4341 security review H-1, at the consumer: a `push_system` row reaches at most
/// `SYSTEM_PUSH_MAX_TARGETS` (5) of the named member's tokens, whatever the producer wrote — the
/// number of devices a member registers is theirs to choose, and each one is a relay call.
///
/// Six live tokens, created in one order and *refreshed* in another (the first just registered
/// again, the second not seen for an hour): the token left out is the stalest, so the order is
/// `updated_at`, not the id.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_test_push_reaches_the_five_freshest_tokens_and_never_a_sixth() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let tenant = seed_tenant(&su).await;
    let mut tokens: Vec<(Uuid, String)> = Vec::new(); // (token id, apns token), in creation order
    for age_minutes in [0, 60, 5, 4, 3, 2] {
        let (token, apns) = seed_token(&su, tenant.workspace, tenant.me).await;
        sqlx::query(
            "UPDATE push_token SET updated_at = now() - make_interval(mins => $2) WHERE id = $1",
        )
        .bind(token)
        .bind(age_minutes)
        .execute(&su)
        .await
        .expect("set the token's last registration");
        tokens.push((token, apns));
    }
    let stalest = tokens[1].clone();
    let test_id = emit_test(&su, tenant.workspace, tenant.me).await;
    focus(&su, &[tenant.workspace]).await;

    let relay = RecordingRelay::accepting();
    let stats = drain(&notifier, relay.clone())
        .drain_system_once(32)
        .await
        .expect("drain");
    assert_eq!(
        (stats.claimed, stats.dispatched, stats.failed),
        (1, 5, 0),
        "{stats:?}"
    );

    let sent = relay.sent();
    assert_eq!(
        sent.len(),
        5,
        "one push_system row is five relay calls at most, however many tokens the member has"
    );
    let mut reached: Vec<&str> = sent
        .iter()
        .map(|dispatch| dispatch.apns_token.as_str())
        .collect();
    reached.sort_unstable();
    let mut freshest: Vec<&str> = tokens
        .iter()
        .filter(|(token, _)| *token != stalest.0)
        .map(|(_, apns)| apns.as_str())
        .collect();
    freshest.sort_unstable();
    assert_eq!(
        reached, freshest,
        "the five most recently registered tokens — not the stalest one ({})",
        stalest.1
    );

    let log = log_rows(&su, tenant.workspace, tenant.me).await;
    assert_eq!(log.len(), 5, "one settled log row per device reached");
    for row in &log {
        assert_ne!(row.token, stalest.0, "the stalest token has no log row");
        assert_eq!(row.status, Some(200));
        assert_eq!(row.collapse, test_notification_collapse_id(test_id));
    }
    assert_eq!(outbox_state(&su, tenant.workspace).await[0].0, "done");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_forged_payload_never_reaches_another_tenants_tokens() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let tenant_a = seed_tenant(&su).await;
    let tenant_b = seed_tenant(&su).await;
    seed_token(&su, tenant_a.workspace, tenant_a.me).await;
    seed_token(&su, tenant_b.workspace, tenant_b.me).await;

    // A row of tenant B that names tenant A's member (a forged or buggy producer), and the
    // reverse. The member and the workspace must agree for a token to be chosen.
    emit_test(&su, tenant_b.workspace, tenant_a.me).await;
    emit_test(&su, tenant_a.workspace, tenant_b.me).await;
    focus(&su, &[tenant_a.workspace, tenant_b.workspace]).await;

    let relay = RecordingRelay::accepting();
    let stats = drain(&notifier, relay.clone())
        .drain_system_once(32)
        .await
        .unwrap();
    assert_eq!(stats.claimed, 2);
    assert!(
        relay.sent().is_empty(),
        "a token was chosen across tenants: {:?}",
        relay.sent()
    );
    assert!(log_rows(&su, tenant_a.workspace, tenant_a.me)
        .await
        .is_empty());
    assert!(log_rows(&su, tenant_b.workspace, tenant_b.me)
        .await
        .is_empty());
    assert_eq!(outbox_state(&su, tenant_a.workspace).await[0].0, "done");
    assert_eq!(outbox_state(&su, tenant_b.workspace).await[0].0, "done");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_member_without_a_live_token_gets_a_finished_row_and_no_log() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let tenant = seed_tenant(&su).await;
    // A token that died after the request, and a suspended member's live one.
    let (dead, _) = seed_token(&su, tenant.workspace, tenant.me).await;
    sqlx::query("UPDATE push_token SET invalidated_at = now() WHERE id = $1")
        .bind(dead)
        .execute(&su)
        .await
        .unwrap();
    seed_token(&su, tenant.workspace, tenant.other).await;
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(tenant.other)
        .execute(&su)
        .await
        .expect("suspend the other member");
    emit_test(&su, tenant.workspace, tenant.me).await;
    emit_test(&su, tenant.workspace, tenant.other).await;
    focus(&su, &[tenant.workspace]).await;

    let relay = RecordingRelay::accepting();
    let stats = drain(&notifier, relay.clone())
        .drain_system_once(32)
        .await
        .unwrap();
    assert_eq!(
        (stats.claimed, stats.failed, stats.requeued),
        (2, 0, 0),
        "{stats:?}"
    );
    assert!(relay.sent().is_empty(), "{:?}", relay.sent());
    assert!(log_rows(&su, tenant.workspace, tenant.me).await.is_empty());
    assert!(log_rows(&su, tenant.workspace, tenant.other)
        .await
        .is_empty());
    for (status, _, _) in outbox_state(&su, tenant.workspace).await {
        assert_eq!(
            status, "done",
            "nobody to send to is a finished row, not a failure"
        );
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn the_two_push_feeds_never_drain_each_other() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let tenant = seed_tenant(&su).await;
    seed_token(&su, tenant.workspace, tenant.me).await;
    let candidate_payload = json!({
        "schema": "momo.push_candidate.v1",
        "message_id": Uuid::new_v4(),
        "channel_id": tenant.channel,
        "author_member_id": tenant.other,
        "message_type": "text",
    });
    emit_outbox(
        &su,
        tenant.workspace,
        OutboxKind::PushCandidate,
        "notify",
        &candidate_payload,
        Some(tenant.channel),
    )
    .await
    .expect("enqueue a candidate");
    emit_test(&su, tenant.workspace, tenant.me).await;
    focus(&su, &[tenant.workspace]).await;
    let kinds = |su: PgPool| async move {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT kind::text, status::text FROM outbox WHERE workspace_id = $1 ORDER BY id",
        )
        .bind(tenant.workspace)
        .fetch_all(&su)
        .await
        .unwrap();
        rows
    };

    // The system drain takes the system row and leaves the candidate pending…
    let relay = RecordingRelay::accepting();
    let push = drain(&notifier, relay.clone());
    let stats = push.drain_system_once(32).await.unwrap();
    assert_eq!(stats.claimed, 1);
    assert_eq!(
        kinds(su.clone()).await,
        [
            ("push_candidate".to_string(), "pending".to_string()),
            ("push_system".to_string(), "done".to_string()),
        ]
    );
    // …and the candidate drain takes the candidate (judging a message that is not there: nobody
    // to notify, done) and never the system row, which here is pending again.
    sqlx::query(
        "UPDATE outbox SET status = 'pending' WHERE workspace_id = $1 AND kind = 'push_system'",
    )
    .bind(tenant.workspace)
    .execute(&su)
    .await
    .unwrap();
    let stats = push.drain_once(32).await.unwrap();
    assert_eq!(stats.claimed, 1);
    assert_eq!(
        kinds(su.clone()).await,
        [
            ("push_candidate".to_string(), "done".to_string()),
            ("push_system".to_string(), "pending".to_string()),
        ]
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_old_relay_refusing_the_vocabulary_is_settled_once_and_never_retried() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let tenant = seed_tenant(&su).await;
    let (token, apns) = seed_token(&su, tenant.workspace, tenant.me).await;
    let (stub, url) = spawn_stub_relay().await;
    // What a relay that predates `test_notification` / `momo.system` really answers.
    stub.answers.lock().unwrap().insert(
        apns,
        (400, "invalid momo.push.dispatch.v2 payload".to_string()),
    );
    emit_test(&su, tenant.workspace, tenant.me).await;
    focus(&su, &[tenant.workspace]).await;

    let push = drain(&notifier, over_http(url, None));
    let stats = push.drain_system_once(32).await.unwrap();
    assert_eq!(
        (
            stats.claimed,
            stats.dispatched,
            stats.requeued,
            stats.failed
        ),
        (1, 1, 0, 0)
    );
    let log = log_rows(&su, tenant.workspace, tenant.me).await;
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].status, Some(400));
    let recorded = log[0]
        .reason
        .clone()
        .expect("the relay's refusal is recorded");
    assert_eq!(
        recorded,
        "relay_http: HTTP 400: invalid momo.push.dispatch.v2 payload"
    );
    // The diagnostics' evidence: an outdated relay, as a code, with none of the relay's words.
    assert!(is_relay_vocabulary_refusal(400, Some(&recorded)));
    assert_eq!(
        apns_reason_code(400, Some(&recorded)).as_deref(),
        Some("relay_vocabulary_refused")
    );
    // Not retried, not parked as failed, and the healthy token was not touched.
    let outbox = outbox_state(&su, tenant.workspace).await;
    assert_eq!(
        (outbox[0].0.as_str(), outbox[0].1),
        ("done", 1),
        "{outbox:?}"
    );
    assert!(
        !is_invalidated(&su, token).await,
        "a relay 400 must never kill a healthy token"
    );
    let stats = push.drain_system_once(32).await.unwrap();
    assert_eq!(stats.claimed, 0, "nothing is left to retry");
    // One audit row per token per hour (ADR-0204 D9) records the refusal for the operator.
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = 'push.relay.refused'",
    )
    .bind(tenant.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(audits, 1);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn an_environment_mismatch_is_a_failure_not_an_outdated_relay() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let tenant = seed_tenant(&su).await;
    let (_, apns) = seed_token(&su, tenant.workspace, tenant.me).await;
    let (stub, url) = spawn_stub_relay().await;
    stub.answers.lock().unwrap().insert(
        apns,
        (
            400,
            "dispatch APNs environment does not match relay".to_string(),
        ),
    );
    emit_test(&su, tenant.workspace, tenant.me).await;
    focus(&su, &[tenant.workspace]).await;

    drain(&notifier, over_http(url, None))
        .drain_system_once(32)
        .await
        .unwrap();
    let log = log_rows(&su, tenant.workspace, tenant.me).await;
    let recorded = log[0].reason.clone().unwrap();
    assert_eq!(log[0].status, Some(400));
    assert!(
        !is_relay_vocabulary_refusal(400, Some(&recorded)),
        "the relay is fine and configured for another APNs environment: {recorded}"
    );
    assert_eq!(
        apns_reason_code(400, Some(&recorded)).as_deref(),
        Some("relay_environment_mismatch")
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_relay_429_or_5xx_is_settled_as_failed_and_never_retried() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let tenant = seed_tenant(&su).await;
    let (_, rate_limited) = seed_token(&su, tenant.workspace, tenant.me).await;
    let (_, broken) = seed_token(&su, tenant.workspace, tenant.me).await;
    let (stub, url) = spawn_stub_relay().await;
    stub.answers.lock().unwrap().insert(
        rate_limited.clone(),
        (429, "server push rate limit exceeded".to_string()),
    );
    stub.answers
        .lock()
        .unwrap()
        .insert(broken.clone(), (503, "APNs transport failed".to_string()));
    emit_test(&su, tenant.workspace, tenant.me).await;
    focus(&su, &[tenant.workspace]).await;

    let push = drain(&notifier, over_http(url, None));
    let stats = push.drain_system_once(32).await.unwrap();
    assert_eq!(
        (stats.claimed, stats.held_back, stats.requeued),
        (1, 2, 0),
        "{stats:?}"
    );
    let log = log_rows(&su, tenant.workspace, tenant.me).await;
    let mut settled: Vec<(Option<i32>, Option<String>)> = log
        .iter()
        .map(|row| (row.status, row.reason.clone()))
        .collect();
    settled.sort();
    assert_eq!(
        settled,
        [
            (Some(429), Some("relay_http: HTTP 429".to_string())),
            (Some(503), Some("relay_http: HTTP 503".to_string())),
        ],
        "each answer is recorded as the failure it is, with the relay_http prefix"
    );
    let outbox = outbox_state(&su, tenant.workspace).await;
    assert_eq!(
        (outbox[0].0.as_str(), outbox[0].1),
        ("done", 1),
        "a test is never retried: {outbox:?}"
    );
    assert_eq!(push.drain_system_once(32).await.unwrap().claimed, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_relay_that_cannot_be_reached_leaves_the_claim_unsettled_and_the_row_done() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let tenant = seed_tenant(&su).await;
    seed_token(&su, tenant.workspace, tenant.me).await;
    // A port nobody listens on.
    let closed = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        format!("http://{address}/v1/push")
    };
    emit_test(&su, tenant.workspace, tenant.me).await;
    focus(&su, &[tenant.workspace]).await;

    let stats = drain(&notifier, over_http(closed, None))
        .drain_system_once(32)
        .await
        .unwrap();
    assert_eq!(
        (stats.claimed, stats.held_back, stats.requeued, stats.failed),
        (1, 1, 0, 0),
        "{stats:?}"
    );
    let log = log_rows(&su, tenant.workspace, tenant.me).await;
    assert_eq!(log.len(), 1);
    assert_eq!(
        (log[0].status, log[0].reason.as_deref()),
        (None, None),
        "a push that never reached the relay stays unsettled: the test reads queued, then stalled, \
         and the diagnostics infer relay_unreachable"
    );
    let outbox = outbox_state(&su, tenant.workspace).await;
    assert_eq!(outbox[0].0, "done", "{outbox:?}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_redelivered_row_does_not_send_twice_and_a_crashed_claim_is_taken_over() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let tenant = seed_tenant(&su).await;
    let (settled_token, _) = seed_token(&su, tenant.workspace, tenant.me).await;
    let test_id = emit_test(&su, tenant.workspace, tenant.me).await;
    focus(&su, &[tenant.workspace]).await;

    let relay = RecordingRelay::accepting();
    let push = drain(&notifier, relay.clone());
    push.drain_system_once(32).await.unwrap();
    assert_eq!(relay.sent().len(), 1);

    // A crash after the send leaves the row `processing`; the boot sweep returns it to pending and
    // the second pass finds every target settled.
    sqlx::query(
        "UPDATE outbox SET status = 'processing' WHERE workspace_id = $1 AND kind = 'push_system'",
    )
    .bind(tenant.workspace)
    .execute(&su)
    .await
    .unwrap();
    push.reclaim_stuck_system().await;
    let stats = push.drain_system_once(32).await.unwrap();
    assert_eq!(
        (stats.claimed, stats.skipped_already_settled),
        (1, 1),
        "{stats:?}"
    );
    assert_eq!(
        relay.sent().len(),
        1,
        "a redelivered row must not send again"
    );

    // A claim a crashed run took but never settled is taken over and re-sent — once.
    let (crashed_token, _) = seed_token(&su, tenant.workspace, tenant.me).await;
    sqlx::query(
        "INSERT INTO push_dispatch_log (workspace_id, member_id, push_token_id, collapse_id) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(tenant.workspace)
    .bind(tenant.me)
    .bind(crashed_token)
    .bind(test_notification_collapse_id(test_id))
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE outbox SET status = 'pending' WHERE workspace_id = $1 AND kind = 'push_system'",
    )
    .bind(tenant.workspace)
    .execute(&su)
    .await
    .unwrap();
    push.drain_system_once(32).await.unwrap();
    assert_eq!(
        relay.sent().len(),
        2,
        "exactly one more send, for the crashed claim"
    );
    let log = log_rows(&su, tenant.workspace, tenant.me).await;
    assert_eq!(log.len(), 2);
    assert!(
        log.iter().all(|row| row.status == Some(200)),
        "both settled"
    );
    assert!(log.iter().any(|row| row.token == settled_token));
    assert!(log.iter().any(|row| row.token == crashed_token));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_410_receipt_invalidates_the_token_like_any_push() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let tenant = seed_tenant(&su).await;
    let (token, _) = seed_token(&su, tenant.workspace, tenant.me).await;
    emit_test(&su, tenant.workspace, tenant.me).await;
    focus(&su, &[tenant.workspace]).await;

    let relay = RecordingRelay::answering(DispatchOutcome::Accepted {
        apns_status: 410,
        apns_reason: Some("Unregistered".to_string()),
    });
    drain(&notifier, relay).drain_system_once(32).await.unwrap();
    assert!(
        is_invalidated(&su, token).await,
        "APNs said the token is gone: a test finds that too"
    );
    let log = log_rows(&su, tenant.workspace, tenant.me).await;
    assert_eq!(
        (log[0].status, log[0].reason.as_deref()),
        (Some(410), Some("Unregistered"))
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_payload_this_build_cannot_read_is_parked_never_sent() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let tenant = seed_tenant(&su).await;
    seed_token(&su, tenant.workspace, tenant.me).await;
    let ids = |extra: Value, reason: &str| {
        let mut payload = json!({
            "schema": "momo.push_system.v1",
            "reason": reason,
            "member_id": tenant.me,
            "ref_id": Uuid::new_v4(),
            "collapse_id": "t:x",
        });
        if let (Some(object), Some(extra)) = (payload.as_object_mut(), extra.as_object()) {
            object.extend(extra.clone());
        }
        payload
    };
    // The next slice's reason (not guessed at), and a payload with a name riding along.
    for payload in [
        ids(json!({}), "scheduled_failed"),
        ids(json!({"display_name": marker()}), "test_notification"),
    ] {
        emit_outbox(
            &su,
            tenant.workspace,
            OutboxKind::PushSystem,
            "notify",
            &payload,
            None,
        )
        .await
        .expect("enqueue");
    }
    focus(&su, &[tenant.workspace]).await;

    let relay = RecordingRelay::accepting();
    let stats = drain(&notifier, relay.clone())
        .drain_system_once(32)
        .await
        .unwrap();
    assert_eq!((stats.claimed, stats.failed), (2, 2), "{stats:?}");
    assert!(
        relay.sent().is_empty(),
        "an unreadable row must send nothing"
    );
    for (status, _, error) in outbox_state(&su, tenant.workspace).await {
        assert_eq!(status, "failed");
        assert!(error.unwrap_or_default().contains("payload decode"));
    }
    assert!(log_rows(&su, tenant.workspace, tenant.me).await.is_empty());
}

// ---------------------------------------------------------------------------
// the real relay
// ---------------------------------------------------------------------------

/// The real relay router (stub APNs, capture file) on loopback, with the notifier's signing key
/// registered. Returns its `/v1/push` URL, the signing seed and the capture file.
async fn spawn_real_relay(
    apns_environment: Option<momo_push_relay::config::ApnsEnvironment>,
) -> (String, [u8; 32], PathBuf) {
    let seed = [7u8; 32];
    let public = ed25519_dalek::SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes();
    let capture = std::env::temp_dir().join(format!("momo-relay-capture-{}.jsonl", Uuid::new_v4()));
    let environment: HashMap<String, String> = HashMap::from([
        (
            "MOMO_RELAY_SERVERS".to_string(),
            json!({ "momo-local": BASE64.encode(public) }).to_string(),
        ),
        ("MOMO_APNS_SENDER".to_string(), "stub".to_string()),
        ("MOMO_APNS_ALLOW_STUB".to_string(), "1".to_string()),
        (
            "MOMO_APNS_STUB_CAPTURE_PATH".to_string(),
            capture.display().to_string(),
        ),
        (
            "MOMO_PUSH_RELAY_RATE_LIMIT_PER_MINUTE".to_string(),
            "1000".to_string(),
        ),
    ]);
    let mut config =
        momo_push_relay::RelayConfig::load(&environment, |_| true).expect("relay config");
    config.apns_environment = apns_environment;
    let router =
        momo_push_relay::build_router(momo_push_relay::AppState::stub_from_config(&config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind the relay");
    let address = listener.local_addr().expect("relay address");
    tokio::spawn(async move {
        axum::serve(listener, router).await.ok();
    });
    (format!("http://{address}/v1/push"), seed, capture)
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn the_real_relay_accepts_the_test_push_and_speaks_its_static_body() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let tenant = seed_tenant(&su).await;
    seed_token(&su, tenant.workspace, tenant.me).await;
    let (url, seed, capture) = spawn_real_relay(None).await;
    let test_id = emit_test(&su, tenant.workspace, tenant.me).await;
    focus(&su, &[tenant.workspace]).await;

    // Signed with the registered key, through the real transport, into the real validator.
    let started = std::time::Instant::now();
    let stats = drain(&notifier, over_http(url, Some(seed)))
        .drain_system_once(32)
        .await
        .unwrap();
    assert_eq!((stats.claimed, stats.dispatched), (1, 1), "{stats:?}");
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    let log = log_rows(&su, tenant.workspace, tenant.me).await;
    assert_eq!(
        (log.len(), log[0].status, log[0].message_id),
        (1, Some(200), None),
        "the real relay validated the sentinel-id envelope and the stub APNs answered 200"
    );
    assert_eq!(log[0].collapse, test_notification_collapse_id(test_id));

    // What the relay handed to APNs: the static body for the reason, the system category, nothing else.
    let captured = std::fs::read_to_string(&capture).expect("the stub APNs capture");
    let line: Value = serde_json::from_str(captured.lines().next().expect("one payload")).unwrap();
    assert_eq!(line["aps"]["alert"]["title"], "oort");
    assert_eq!(line["aps"]["alert"]["body"], "시험 알림이에요");
    assert_eq!(line["aps"]["category"], "momo.system");
    assert_eq!(line["aps"]["sound"], "default");
    assert_eq!(line["aps"]["badge"], 3);
    assert_eq!(line["momo"]["reason"], "test_notification");
    let nil = Uuid::nil().to_string();
    assert_eq!(line["momo"]["channel_id"], nil);
    assert_eq!(line["momo"]["message_id"], nil);
    let text = line.to_string();
    for forbidden in [marker(), "display_name", "channel_name", "message_body"] {
        assert!(
            !text.contains(forbidden),
            "{forbidden} reached the APNs payload: {text}"
        );
    }
    std::fs::remove_file(&capture).ok();
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn the_real_relays_refusal_texts_are_what_the_diagnostics_classify() {
    // No database: the REAL relay's two 400 messages, through the REAL transport, into the same
    // function the diagnostics use. A relay that rewords either message turns this red, instead of
    // quietly turning `relay_outdated` into `failed` (or the reverse) in production.
    let (url, seed, capture) =
        spawn_real_relay(Some(momo_push_relay::config::ApnsEnvironment::Production)).await;
    let dispatcher = RelayHttpDispatcher::new(url, "momo-local", Some(seed)).expect("client");
    let target = || momo_push::DispatchTarget {
        server_id: "momo-local".to_string(),
        workspace_id: Uuid::new_v4(),
        device_id: Uuid::new_v4(),
        device_platform: "ios".to_string(),
        apns_token: Uuid::new_v4().simple().to_string().repeat(2),
        apns_env: "production".to_string(),
        apns_topic: "kim.dawn.momo.e2e".to_string(),
        collapse_id: "t:x".to_string(),
        badge: 0,
        reason: momo_push::PushReason::TestNotification,
        thread_id: Uuid::nil(),
        category: momo_push::PushCategory::System,
        approval_id: None,
        channel_id: Uuid::nil(),
        message_id: Uuid::nil(),
    };

    // (1) A reason the relay does not know: its closed-vocabulary refusal. (A relay that predates
    // `test_notification` refuses exactly this way; here the unknown label stands in for it.)
    let mut unknown = PushDispatch::new(&target());
    unknown.reason = "a_reason_this_relay_has_never_heard_of";
    let DispatchOutcome::PermanentFailure {
        relay_http_status,
        reason,
    } = dispatcher.dispatch(&unknown).await
    else {
        panic!("the relay must refuse an unknown reason with a permanent 400");
    };
    assert_eq!(relay_http_status, 400);
    let recorded = format!("relay_http: {reason}");
    assert!(
        is_relay_vocabulary_refusal(400, Some(&recorded)),
        "the diagnostics no longer recognise the relay's vocabulary refusal: {recorded}"
    );
    assert_eq!(
        apns_reason_code(400, Some(&recorded)).as_deref(),
        Some("relay_vocabulary_refused")
    );

    // (2) A dispatch for the other APNs environment: the relay's environment refusal.
    let mut mismatched = PushDispatch::new(&target());
    mismatched.apns_env = "sandbox".to_string();
    let DispatchOutcome::PermanentFailure {
        relay_http_status,
        reason,
    } = dispatcher.dispatch(&mismatched).await
    else {
        panic!("the relay must refuse another environment with a permanent 400");
    };
    assert_eq!(relay_http_status, 400);
    let recorded = format!("relay_http: {reason}");
    assert!(
        !is_relay_vocabulary_refusal(400, Some(&recorded)),
        "{recorded}"
    );
    assert_eq!(
        apns_reason_code(400, Some(&recorded)).as_deref(),
        Some("relay_environment_mismatch"),
        "the relay's environment refusal changed its words: {recorded}"
    );
    std::fs::remove_file(&capture).ok();
}

// ---------------------------------------------------------------------------
// #5091 — the test notification inside the server-wide budget, and not when it is old
// (ADR-0206 증보 4 G2·G3)
// ---------------------------------------------------------------------------

/// A fixed epoch second for the bulk layer's held clock: the budget minute cannot roll over mid-test.
const T0: i64 = 1_800_000_000;

fn held_clock(now: &Arc<AtomicI64>) -> momo_notifier::bulk::Clock {
    let now = now.clone();
    Arc::new(move || now.load(Ordering::SeqCst))
}

/// The runtime API role (NOBYPASSRLS): the diagnostics `GET` runs as this.
async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let options = options
        .username("momo_app")
        .password(&role_password("MOMO_APP_PASSWORD", "momo_app_dev_pw"));
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .expect("connect as momo_app (run bootstrap_roles.sql first)")
}

/// What `GET …/notification-diagnostics` computes for `member`, as the API role.
async fn diagnostics_of(app: &PgPool, workspace: Uuid, member: Uuid) -> Diagnostics {
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move { compute_diagnostics(conn, workspace, member, None, None).await })
    })
    .await
    .expect("compute the diagnostics")
}

/// Record `test_id` as the member's last test, as the route's reservation does, `age_secs` ago.
async fn mark_last_test(su: &PgPool, workspace: Uuid, member: Uuid, test_id: Uuid, age_secs: i64) {
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, last_test_id, last_test_at) \
         VALUES ($1, $2, $3, now() - make_interval(secs => $4::double precision)) \
         ON CONFLICT (workspace_id, member_id) \
         DO UPDATE SET last_test_id = EXCLUDED.last_test_id, last_test_at = EXCLUDED.last_test_at",
    )
    .bind(workspace)
    .bind(member)
    .bind(test_id)
    .bind(age_secs as f64)
    .execute(su)
    .await
    .expect("record the member's last test");
}

/// A test row that has already waited `age_secs` (what a notifier that was stopped finds).
async fn emit_test_aged(su: &PgPool, workspace: Uuid, member: Uuid, age_secs: i64) -> Uuid {
    let test_id = emit_test(su, workspace, member).await;
    sqlx::query(
        "UPDATE outbox SET created_at = now() - make_interval(secs => $3::double precision) \
          WHERE workspace_id = $1 AND kind = 'push_system' AND payload->>'ref_id' = $2",
    )
    .bind(workspace)
    .bind(test_id.to_string())
    .bind(age_secs as f64)
    .execute(su)
    .await
    .expect("age the test row");
    test_id
}

/// The collapse-id-scoped slice of a member's dispatch log.
async fn log_of_test(su: &PgPool, workspace: Uuid, member: Uuid, test_id: Uuid) -> Vec<LogRow> {
    let collapse = test_notification_collapse_id(test_id);
    log_rows(su, workspace, member)
        .await
        .into_iter()
        .filter(|row| row.collapse == collapse)
        .collect()
}

/// Neither a delivery failure nor an unreachable relay: what a server-side drop must never become.
fn assert_no_false_alarm(diagnostics: &Diagnostics) {
    for blocker in &diagnostics.blockers {
        assert!(
            blocker.code != BlockerCode::LastDeliveryFailed
                && blocker.code != BlockerCode::RelayUnreachable,
            "the server's own drop was read as {:?}: {:?}",
            blocker.code,
            diagnostics.blockers
        );
    }
}

/// ADR-0206 증보 4 G2: a test spends the server-wide budget (the bulk layer's, one dispatch per
/// token). With a budget of three and five tokens, three go to the relay and the other two are
/// **settled** `429` / `notifier_budget_spent` — rows that exist, are closed and say what happened —
/// so the test reads `sent`, the diagnostics have no `last_delivery_failed` and no
/// `relay_unreachable`, no token is touched, and the counter says two. A second test in a minute
/// with no budget at all sends nothing and reads `failed`·429 — not `queued`/`stalled`.
///
/// Sabotage: skip the spend (five relay calls); settle nothing (NULL rows, `lastTest` stays
/// `queued`); settle with another reason; leave the reason out of `SERVER_DROP_REASONS` (the
/// diagnostics call it `last_delivery_failed`).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn a_test_past_the_server_budget_is_settled_429_and_never_sent() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let mut mine = Vec::new();
    for _ in 0..5 {
        mine.push(seed_token(&su, tenant.workspace, tenant.me).await.0);
    }
    let (theirs, _) = seed_token(&su, tenant.workspace, tenant.other).await;

    // A budget of three for the minute, and a test to five tokens.
    let first = emit_test(&su, tenant.workspace, tenant.me).await;
    mark_last_test(&su, tenant.workspace, tenant.me, first, 0).await;
    focus(&su, &[tenant.workspace]).await;
    let mut config = PushConfig::for_target();
    config.bulk_push_per_minute = 3;
    let now = Arc::new(AtomicI64::new(T0));
    let relay = RecordingRelay::accepting();
    let push =
        PushDrain::new(notifier.clone(), config, relay.clone()).with_bulk_clock(held_clock(&now));
    let stats = push.drain_system_once(32).await.expect("drain");
    assert_eq!(
        (
            stats.claimed,
            stats.dispatched,
            stats.held_back,
            stats.failed
        ),
        (1, 3, 2, 0),
        "{stats:?}"
    );
    assert_eq!(
        relay.sent().len(),
        3,
        "the relay is called three times, not five"
    );

    let log = log_of_test(&su, tenant.workspace, tenant.me, first).await;
    assert_eq!(
        log.len(),
        5,
        "every token has a row: sent or settled, none missing"
    );
    assert!(
        log.iter().all(|row| row.status.is_some()),
        "no claim is left unsettled"
    );
    assert_eq!(log.iter().filter(|row| row.status == Some(200)).count(), 3);
    let dropped: Vec<&LogRow> = log.iter().filter(|row| row.status != Some(200)).collect();
    assert_eq!(dropped.len(), 2);
    for row in dropped {
        assert_eq!(row.status, Some(BUDGET_SPENT_STATUS));
        assert_eq!(row.reason.as_deref(), Some(BUDGET_SPENT_REASON));
        assert_eq!(row.message_id, None);
    }
    for token in &mine {
        assert!(
            !is_invalidated(&su, *token).await,
            "a budget row never touches a token"
        );
    }
    assert!(log_rows(&su, tenant.workspace, tenant.other)
        .await
        .is_empty());
    assert!(!is_invalidated(&su, theirs).await);
    assert_eq!(
        push.bulk_counters()
            .get(&("test_notification", "budget"))
            .copied(),
        Some(2),
        "{:?}",
        push.bulk_counters()
    );
    assert_eq!(outbox_state(&su, tenant.workspace).await[0].0, "done");

    let diagnostics = diagnostics_of(&app, tenant.workspace, tenant.me).await;
    assert_no_false_alarm(&diagnostics);
    assert!(diagnostics.ok, "{:?}", diagnostics.blockers);
    let last = diagnostics.last_test.expect("the last test");
    assert_eq!(last.status, LastTestStatus::Sent, "three devices got it");

    // The next minute's budget is nothing at all: a second test sends nothing and says so.
    let second = emit_test(&su, tenant.workspace, tenant.me).await;
    mark_last_test(&su, tenant.workspace, tenant.me, second, 0).await;
    focus(&su, &[tenant.workspace]).await;
    let mut none = PushConfig::for_target();
    none.bulk_push_per_minute = 0;
    let relay_none = RecordingRelay::accepting();
    let push_none = PushDrain::new(notifier.clone(), none, relay_none.clone())
        .with_bulk_clock(held_clock(&now));
    let stats = push_none.drain_system_once(32).await.expect("drain");
    assert_eq!(
        (stats.claimed, stats.dispatched, stats.held_back),
        (1, 0, 5),
        "{stats:?}"
    );
    assert!(relay_none.sent().is_empty(), "nothing reaches the relay");
    let log = log_of_test(&su, tenant.workspace, tenant.me, second).await;
    assert_eq!(log.len(), 5);
    assert!(log.iter().all(|row| {
        row.status == Some(BUDGET_SPENT_STATUS)
            && row.reason.as_deref() == Some(BUDGET_SPENT_REASON)
    }));
    let diagnostics = diagnostics_of(&app, tenant.workspace, tenant.me).await;
    assert_no_false_alarm(&diagnostics);
    let last = diagnostics.last_test.expect("the last test");
    assert_eq!(
        (last.status, last.apns_status),
        (LastTestStatus::Failed, Some(BUDGET_SPENT_STATUS)),
        "settled and failed with the honest status, not queued or stalled"
    );
    assert_eq!(outbox_state(&su, tenant.workspace).await[1].0, "done");
}

/// A redelivered row (the notifier crashed after settling part of it) owes the budget only for the
/// targets it still has to send: the two tokens already settled are skipped **without** spending, so
/// the other three all go out under a budget of three. Spending before the claim would charge the
/// two that were already sent.
///
/// The two settled tokens are the freshest, so they come first in the order the targets are walked:
/// a spend before the claim burns the budget on them.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn a_redelivered_test_does_not_spend_the_budget_twice() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let tenant = seed_tenant(&su).await;
    let mut tokens = Vec::new();
    for _ in 0..5 {
        tokens.push(seed_token(&su, tenant.workspace, tenant.me).await.0);
    }
    let test_id = emit_test(&su, tenant.workspace, tenant.me).await;
    focus(&su, &[tenant.workspace]).await;
    // An earlier run settled the two freshest tokens (the last two seeded).
    for token in &tokens[3..] {
        sqlx::query(
            "INSERT INTO push_dispatch_log \
               (workspace_id, member_id, push_token_id, collapse_id, apns_status) \
             VALUES ($1, $2, $3, $4, 200)",
        )
        .bind(tenant.workspace)
        .bind(tenant.me)
        .bind(*token)
        .bind(test_notification_collapse_id(test_id))
        .execute(&su)
        .await
        .expect("an earlier run settled this token");
    }

    let mut config = PushConfig::for_target();
    config.bulk_push_per_minute = 3;
    let now = Arc::new(AtomicI64::new(T0));
    let relay = RecordingRelay::accepting();
    let push = PushDrain::new(notifier, config, relay.clone()).with_bulk_clock(held_clock(&now));
    let stats = push.drain_system_once(32).await.expect("drain");
    assert_eq!(
        (
            stats.claimed,
            stats.dispatched,
            stats.skipped_already_settled,
            stats.held_back
        ),
        (1, 3, 2, 0),
        "the three tokens still owed all fit in a budget of three: {stats:?}"
    );
    assert_eq!(relay.sent().len(), 3);
    assert!(
        !push
            .bulk_counters()
            .contains_key(&("test_notification", "budget")),
        "nothing was refused: {:?}",
        push.bulk_counters()
    );
}

/// ADR-0206 증보 4 G3: a notifier that was stopped finds a backlog. Test rows older than five
/// minutes are **not sent** — no relay call — and are settled: each current token of the member gets
/// a row closed `408` / `notifier_test_expired`, the outbox row is `done` with a note. The test the
/// person last pressed then reads `failed`·408 — not `stalled`, and the diagnostics do not infer a
/// relay that cannot be reached from a test this notifier itself threw away. A row four and a half
/// minutes old is still sent (the limit is five), by its own member's tokens only.
///
/// Sabotage: drop the age check (the stale rows are sent); the limit 300 → 60 s (the 4½-minute row is
/// held) or → 3600 s (the 6-minute row is sent); skip the settled rows (`lastTest` is `stalled`).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier / momo_app roles"]
async fn a_test_row_older_than_five_minutes_is_settled_unsent_and_a_younger_one_still_goes() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let mut mine = Vec::new();
    for _ in 0..3 {
        mine.push(seed_token(&su, tenant.workspace, tenant.me).await.0);
    }
    let mut theirs = Vec::new();
    for _ in 0..2 {
        theirs.push(seed_token(&su, tenant.workspace, tenant.other).await.0);
    }

    // `me`: two stale tests (six minutes and an hour), the newer of the two is the last pressed.
    // `other`: a test four and a half minutes old, which is still young enough.
    let stale_a = emit_test_aged(&su, tenant.workspace, tenant.me, 360).await;
    let stale_b = emit_test_aged(&su, tenant.workspace, tenant.me, 3600).await;
    let young = emit_test_aged(&su, tenant.workspace, tenant.other, 270).await;
    mark_last_test(&su, tenant.workspace, tenant.me, stale_a, 360).await;
    mark_last_test(&su, tenant.workspace, tenant.other, young, 270).await;
    focus(&su, &[tenant.workspace]).await;

    let relay = RecordingRelay::accepting();
    let now = Arc::new(AtomicI64::new(T0));
    let push = PushDrain::new(notifier, PushConfig::for_target(), relay.clone())
        .with_bulk_clock(held_clock(&now));
    let stats = push.drain_system_once(32).await.expect("drain");
    assert_eq!(
        (
            stats.claimed,
            stats.dispatched,
            stats.held_back,
            stats.failed
        ),
        (3, 2, 6, 0),
        "{stats:?}"
    );

    // The relay saw the young row's two dispatches and nothing of the stale ones.
    let sent = relay.sent();
    assert_eq!(sent.len(), 2, "{sent:?}");
    let young_collapse = test_notification_collapse_id(young);
    assert!(sent
        .iter()
        .all(|dispatch| dispatch.collapse_id == young_collapse));
    assert_eq!(
        log_of_test(&su, tenant.workspace, tenant.other, young)
            .await
            .len(),
        2
    );

    // Each stale test has a closed row per current token of `me`, and none is left unsettled.
    for stale in [stale_a, stale_b] {
        let log = log_of_test(&su, tenant.workspace, tenant.me, stale).await;
        assert_eq!(log.len(), 3, "one row per current token");
        for row in &log {
            assert_eq!(row.status, Some(TEST_EXPIRED_STATUS));
            assert_eq!(row.reason.as_deref(), Some(TEST_EXPIRED_REASON));
            assert!(mine.contains(&row.token));
        }
    }
    for token in mine.iter().chain(theirs.iter()) {
        assert!(!is_invalidated(&su, *token).await);
    }

    // The outbox rows are all finished; the stale ones say why.
    let state = outbox_state(&su, tenant.workspace).await;
    assert_eq!(state.len(), 3);
    assert!(
        state.iter().all(|(status, _, _)| status == "done"),
        "{state:?}"
    );
    let noted = state
        .iter()
        .filter(|(_, _, note)| {
            note.as_deref()
                .is_some_and(|text| text.starts_with("expired:"))
        })
        .count();
    assert_eq!(noted, 2, "{state:?}");
    assert_eq!(
        push.bulk_counters()
            .get(&("test_notification", "expired"))
            .copied(),
        Some(6),
        "{:?}",
        push.bulk_counters()
    );

    // What the person sees: the stale test is `failed`·408 with no invented alarm; the young one `sent`.
    let mine_now = diagnostics_of(&app, tenant.workspace, tenant.me).await;
    assert_no_false_alarm(&mine_now);
    let last = mine_now.last_test.expect("the last test");
    assert_eq!(
        (last.status, last.apns_status),
        (LastTestStatus::Failed, Some(TEST_EXPIRED_STATUS))
    );
    let theirs_now = diagnostics_of(&app, tenant.workspace, tenant.other).await;
    assert_eq!(
        theirs_now.last_test.expect("the other's last test").status,
        LastTestStatus::Sent
    );
}
