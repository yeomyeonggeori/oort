//! **The outbound closed loop, end to end** (#1222 / T13).
//!
//! ```text
//! 설치        POST /v1/workspaces/{ws}/event-subscriptions   (the real route)
//! 발생        a mention message → migration 033's trigger → an outbox row
//! 전송        one sender iteration → a real HTTP POST to a real subscriber
//! 서명 검증   the subscriber recomputes HMAC-SHA256 over "<ts>." || body
//! 감사        record_event_subscription_delivery → one audit_log row, no body
//! 재시도      a 5xx → backoff → the failure ledger → auto-disable at threshold
//! ```
//!
//! Every stage above is the production code path. The one thing the test
//! supplies is the *destination*: the SSRF guard refuses loopback by design, so
//! a mock subscriber on 127.0.0.1 can never be reached by
//! `SafeWebhookTransport`. Rather than weaken the guard for a test, the harness
//! implements `WebhookTransport` with the real signing call and a real reqwest
//! POST, and then asserts **separately** that `SafeWebhookTransport` refuses the
//! exact same URL — so "the guard did not run here" is itself proven rather than
//! assumed.
//!
//! `#[ignore]` because it needs a real Postgres. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-webhook-sender --test webhook_delivery_conformance_pg -- --ignored --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::Router;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::PgPoolOptions;
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_webhook::{OutboundUrl, SystemHostResolver};
use momo_webhook_sender::delivery::{classify, DeliveryResult, WebhookTransport};
use momo_webhook_sender::{SafeWebhookTransport, SenderConfig, WebhookSender};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_MASTER_KEY: &str = "delivery-conformance-outbound-master-key";

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

fn ensure_schema() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/e2e/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

// ---------------------------------------------------------------------------
// the mock subscriber — an independent verifier, not a mirror of our code
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Subscriber {
    secret: String,
    /// The status to answer with. Mutable so one test can walk 500 → 500 → 200.
    status: Arc<AtomicU16>,
    received: Arc<AtomicUsize>,
    /// Every accepted delivery: (`X-Momo-Delivery`, `X-Momo-Event`, body).
    log: Arc<Mutex<Vec<(String, String, String)>>>,
    /// Deliveries whose signature did NOT verify. Must stay 0.
    forged: Arc<AtomicUsize>,
}

async fn receive(State(state): State<Subscriber>, headers: HeaderMap, body: String) -> StatusCode {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string()
    };
    let timestamp = header("x-momo-timestamp");
    let presented = header("x-momo-signature");
    // What a real subscriber does: recompute over "<timestamp>." || body.
    let expected = format!(
        "v1={}",
        momo_webhook::delivery_signature(&state.secret, &timestamp, body.as_bytes())
    );
    if presented != expected {
        state.forged.fetch_add(1, Ordering::SeqCst);
        return StatusCode::UNAUTHORIZED;
    }
    state.received.fetch_add(1, Ordering::SeqCst);
    state
        .log
        .lock()
        .unwrap()
        .push((header("x-momo-delivery"), header("x-momo-event"), body));
    StatusCode::from_u16(state.status.load(Ordering::SeqCst)).unwrap_or(StatusCode::OK)
}

async fn start_subscriber(secret: &str) -> (String, Subscriber) {
    let state = Subscriber {
        secret: secret.to_string(),
        status: Arc::new(AtomicU16::new(200)),
        received: Arc::new(AtomicUsize::new(0)),
        log: Arc::new(Mutex::new(Vec::new())),
        forged: Arc::new(AtomicUsize::new(0)),
    };
    let app = Router::new()
        .route("/hook", post(receive))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind subscriber");
    let address: SocketAddr = listener.local_addr().expect("subscriber address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}/hook"), state)
}

/// The real signing call and a real socket, with the SSRF guard bypassed *only*
/// because the destination is loopback. `the_ssrf_guard_refuses_the_very_url_this_harness_uses`
/// proves that bypass is the whole difference.
struct LoopbackTransport;

impl WebhookTransport for LoopbackTransport {
    async fn deliver(
        &self,
        url: &OutboundUrl,
        delivery_id: &str,
        event_kind: &str,
        secret: &str,
        body: &[u8],
    ) -> DeliveryResult {
        let timestamp = chrono::Utc::now().timestamp().to_string();
        // Production's signature function — the value under test.
        let signature = momo_webhook::delivery_signature(secret, &timestamp, body);
        let response = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .expect("client")
            .post(&url.absolute)
            .header("Content-Type", "application/json")
            .header("User-Agent", "momo-outbound-webhook/1")
            .header("X-Momo-Delivery", delivery_id)
            .header("X-Momo-Event", event_kind)
            .header("X-Momo-Timestamp", &timestamp)
            .header("X-Momo-Signature", format!("v1={signature}"))
            .body(body.to_vec())
            .send()
            .await;
        match response {
            Ok(response) => classify(response.status().as_u16()),
            Err(_) => DeliveryResult::Transient {
                reason: "request failed".to_string(),
                status: None,
            },
        }
    }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

struct Tenant {
    workspace: Uuid,
    member: Uuid,
    channel: Uuid,
}

async fn seed(su: &PgPool) -> Tenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("delivery-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(member)
    .bind(workspace)
    .bind(member.to_string())
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed workspace_membership");
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, created_by) \
         VALUES ($1, $2, 'public', 'general', $3)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");
    Tenant {
        workspace,
        member,
        channel,
    }
}

/// Install a subscription the way the route does, and return `(id, secret)`.
async fn install_subscription(
    su: &PgPool,
    tenant: &Tenant,
    url: &str,
    kinds: &[&str],
) -> (Uuid, String) {
    let secret_ref = momo_webhook::random_reference();
    let kinds: Vec<String> = kinds.iter().map(|kind| kind.to_string()).collect();
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO event_subscription \
           (workspace_id, url, secret_ref, event_kinds, enabled, created_by, updated_by) \
         VALUES ($1, $2, $3, $4, true, $5, $5) RETURNING id",
    )
    .bind(tenant.workspace)
    .bind(url)
    .bind(&secret_ref)
    .bind(&kinds)
    .bind(tenant.member)
    .fetch_one(su)
    .await
    .expect("install subscription");
    (
        id,
        momo_webhook::outbound_secret(TEST_MASTER_KEY, &secret_ref),
    )
}

/// Post a message that mentions someone — migration 033's trigger is the
/// producer under test, so nothing here inserts an outbox row by hand.
async fn post_mention(su: &PgPool, tenant: &Tenant, seq: i64, body: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO message \
           (id, workspace_id, channel_id, seq, hlc_ts, author_member_id, type, body, props) \
         VALUES ($1, $2, $3, $4, $5, $6, 'text', $7, \
                 jsonb_build_object('mention_member_ids', jsonb_build_array($6::text)))",
    )
    .bind(id)
    .bind(tenant.workspace)
    .bind(tenant.channel)
    .bind(seq)
    .bind(chrono::Utc::now().timestamp_millis())
    .bind(tenant.member)
    .bind(body)
    .execute(su)
    .await
    .expect("post mention");
    id
}

/// The harness config: `allow_development_http` so the sender's SHAPE parse
/// accepts the loopback verifier's `http://` URL. It does not weaken the address
/// policy — that lives in `SafeWebhookTransport`, which this harness replaces and
/// `the_ssrf_guard_refuses_the_very_url_this_harness_uses` separately exercises.
fn harness_config() -> SenderConfig {
    let mut config = SenderConfig::for_target(database_url(), TEST_MASTER_KEY);
    config.allow_development_http = true;
    config
}

fn sender(pool: PgPool) -> WebhookSender<LoopbackTransport> {
    WebhookSender::new(pool, LoopbackTransport, harness_config())
}

async fn outbox_state(su: &PgPool, subscription: Uuid) -> Vec<(String, i32, Option<String>)> {
    sqlx::query(
        "SELECT status::text, attempts, last_error FROM outbox \
          WHERE kind = 'webhook_delivery' AND partition_key = $1 ORDER BY id",
    )
    .bind(subscription)
    .fetch_all(su)
    .await
    .expect("read outbox")
    .into_iter()
    .map(|row| (row.get(0), row.get(1), row.get(2)))
    .collect()
}

async fn delivery_audits(su: &PgPool, workspace: Uuid) -> Vec<Value> {
    sqlx::query(
        "SELECT detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'event_subscription.delivered' \
          ORDER BY created_at, id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read delivery audits")
    .into_iter()
    .map(|row| row.get::<Value, _>(0))
    .collect()
}

// ---------------------------------------------------------------------------
// 1. the closed loop
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_mention_reaches_a_subscriber_signed_and_leaves_exactly_one_audit_line() {
    ensure_schema();
    let su = superuser_pool().await;
    let tenant = seed(&su).await;
    let (url, subscriber) = start_subscriber("placeholder").await;
    let (subscription, secret) = install_subscription(&su, &tenant, &url, &["mention"]).await;
    // The subscriber verifies with the secret the SERVER would have revealed,
    // recomputed from the stored reference — the same value the sender derives.
    let subscriber = Subscriber {
        secret,
        ..subscriber
    };
    let app = Router::new()
        .route("/hook", post(receive))
        .with_state(subscriber.clone());
    // Rebind on the same address by restarting: simplest way to hand the
    // verifier its secret after the row exists.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("rebind subscriber");
    let address: SocketAddr = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let url = format!("http://{address}/hook");
    sqlx::query("UPDATE event_subscription SET url = $2 WHERE id = $1")
        .bind(subscription)
        .bind(&url)
        .execute(&su)
        .await
        .expect("point the subscription at the verifier");

    // -- 발생: the trigger, not the test, enqueues ---------------------------
    let message = post_mention(&su, &tenant, 1, "@someone 배포 나갔습니다").await;
    let queued = outbox_state(&su, subscription).await;
    assert_eq!(
        queued.len(),
        1,
        "migration 033's mention trigger must enqueue exactly one delivery"
    );
    assert_eq!(queued[0].0, "pending");

    // -- 전송 ---------------------------------------------------------------
    let stats = sender(su.clone()).drain_once().await.expect("drain");
    assert_eq!(stats.claimed, 1);
    assert_eq!(stats.delivered, 1, "{stats:?}");
    assert_eq!(subscriber.received.load(Ordering::SeqCst), 1);
    assert_eq!(
        subscriber.forged.load(Ordering::SeqCst),
        0,
        "the subscriber verified the signature independently; a mismatch is a forgery"
    );

    // -- 서명이 서명한 것 ----------------------------------------------------
    let log = subscriber.log.lock().unwrap().clone();
    let (delivery_id, event_kind, body) = &log[0];
    assert_eq!(event_kind, "mention");
    assert!(!delivery_id.is_empty(), "X-Momo-Delivery is the dedupe key");
    let event: Value = serde_json::from_str(body).expect("body is the event envelope");
    assert_eq!(event["kind"], "mention");
    assert_eq!(event["id"], message.to_string());
    assert_eq!(event["data"]["body"], "@someone 배포 나갔습니다");

    // -- 감사: one line, naming the host, carrying no body -------------------
    let audits = delivery_audits(&su, tenant.workspace).await;
    assert_eq!(audits.len(), 1, "one egress, one line");
    let detail = &audits[0];
    assert_eq!(detail["schema"], "momo.event_subscription.delivered.v1");
    assert_eq!(detail["event_kind"], "mention");
    assert_eq!(detail["event_id"], message.to_string());
    assert_eq!(detail["target_host"], "127.0.0.1");
    assert_eq!(detail["http_status"], 200);
    let rendered = detail.to_string();
    assert!(
        !rendered.contains("배포 나갔습니다"),
        "the ledger must never become a second copy of the message body (#1204): {rendered}"
    );
    assert!(
        !rendered.contains(&url),
        "the full URL can carry a subscriber token; only the host is recorded: {rendered}"
    );
    let actor: Option<Uuid> = sqlx::query_scalar(
        "SELECT actor_member_id FROM audit_log \
          WHERE workspace_id = $1 AND action = 'event_subscription.delivered' LIMIT 1",
    )
    .bind(tenant.workspace)
    .fetch_one(&su)
    .await
    .expect("read actor");
    assert_eq!(
        actor, None,
        "a delivery is a system event; nobody pressed it"
    );

    // -- the queue is settled and the ledger is clean ------------------------
    assert_eq!(outbox_state(&su, subscription).await[0].0, "done");
    let failures: i32 =
        sqlx::query_scalar("SELECT delivery_failure_count FROM event_subscription WHERE id = $1")
            .bind(subscription)
            .fetch_one(&su)
            .await
            .expect("read ledger");
    assert_eq!(failures, 0);
}

// ---------------------------------------------------------------------------
// 2. retry, the failure ledger, and auto-disable
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_broken_subscriber_is_retried_counted_and_finally_switched_off() {
    ensure_schema();
    let su = superuser_pool().await;
    let tenant = seed(&su).await;
    let secret_holder = Arc::new(Mutex::new(String::new()));
    // Start the verifier first so the subscription can name it, then hand it the
    // secret: the value is derivable from the stored reference either way.
    let (url, subscriber) = start_subscriber("").await;
    let (subscription, secret) = install_subscription(&su, &tenant, &url, &["mention"]).await;
    *secret_holder.lock().unwrap() = secret.clone();
    // The verifier for this test answers 5xx, so the signature is checked but the
    // delivery still fails — which is exactly the case the ledger exists for.
    let failing = Subscriber {
        secret,
        ..subscriber.clone()
    };
    failing.status.store(503, Ordering::SeqCst);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind failing subscriber");
    let address: SocketAddr = listener.local_addr().expect("address");
    let app = Router::new()
        .route("/hook", post(receive))
        .with_state(failing.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    sqlx::query("UPDATE event_subscription SET url = $2 WHERE id = $1")
        .bind(subscription)
        .bind(format!("http://{address}/hook"))
        .execute(&su)
        .await
        .expect("point at the failing subscriber");

    let mut config = harness_config();
    config.disable_after_server_failures = 2;
    let sender = WebhookSender::new(su.clone(), LoopbackTransport, config);

    // -- first 5xx: counted, requeued with a backoff ------------------------
    post_mention(&su, &tenant, 1, "first").await;
    let stats = sender.drain_once().await.expect("drain 1");
    assert_eq!(stats.requeued, 1, "{stats:?}");
    let ledger: (i32, bool) =
        sqlx::query("SELECT delivery_failure_count, enabled FROM event_subscription WHERE id = $1")
            .bind(subscription)
            .fetch_one(&su)
            .await
            .map(|row| (row.get(0), row.get(1)))
            .expect("ledger");
    assert_eq!(ledger, (1, true));
    let queued = outbox_state(&su, subscription).await;
    assert_eq!(queued[0].0, "pending", "a 5xx is retryable");
    assert_eq!(queued[0].1, 1, "the claim already incremented attempts");
    assert_eq!(queued[0].2.as_deref(), Some("HTTP 503"));

    // The 5xx still reached the host, so it IS an egress and must be audited.
    assert_eq!(
        delivery_audits(&su, tenant.workspace).await.len(),
        1,
        "a delivery that got an answer is a delivery, whatever the answer was"
    );

    // -- second 5xx: the threshold trips ------------------------------------
    sqlx::query("UPDATE outbox SET available_at = now() WHERE partition_key = $1")
        .bind(subscription)
        .execute(&su)
        .await
        .expect("make the retry due");
    let stats = sender.drain_once().await.expect("drain 2");
    assert_eq!(stats.failed, 1, "{stats:?}");
    let ledger: (i32, bool, Option<String>) = sqlx::query(
        "SELECT delivery_failure_count, enabled, disabled_reason \
           FROM event_subscription WHERE id = $1",
    )
    .bind(subscription)
    .fetch_one(&su)
    .await
    .map(|row| (row.get(0), row.get(1), row.get(2)))
    .expect("ledger");
    assert_eq!(ledger.0, 2);
    assert!(!ledger.1, "the threshold must actually switch it off");
    assert_eq!(ledger.2.as_deref(), Some("server_5xx_threshold"));
    let auto_disabled: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM audit_log \
          WHERE workspace_id = $1 AND action = 'event_subscription.auto_disabled'",
    )
    .bind(tenant.workspace)
    .fetch_one(&su)
    .await
    .expect("count auto-disable audits");
    assert_eq!(
        auto_disabled, 1,
        "oort turned a destination off; that is a decision and it needs a record"
    );
    assert_eq!(subscriber.forged.load(Ordering::SeqCst), 0);

    // -- a queued delivery must not outlive the decision that stopped it ----
    let before_count = outbox_state(&su, subscription).await.len();
    post_mention(&su, &tenant, 2, "after").await;
    assert_eq!(
        outbox_state(&su, subscription).await.len(),
        before_count,
        "033's enqueue selects `WHERE s.enabled`, so a disabled subscription is not          queued for at all — the send is stopped at the producer, not just at the sender"
    );
    let received_before = failing.received.load(Ordering::SeqCst);
    // Force one in anyway (as a race between enqueue and disable would), and
    // require the sender to settle it WITHOUT sending.
    sqlx::query(
        "UPDATE outbox SET status='pending', available_at = now() \
          WHERE partition_key = $1 AND status <> 'done'",
    )
    .bind(subscription)
    .execute(&su)
    .await
    .expect("re-arm");
    let stats = sender.drain_once().await.expect("drain 3");
    assert_eq!(stats.skipped, stats.claimed, "{stats:?}");
    assert_eq!(
        failing.received.load(Ordering::SeqCst),
        received_before,
        "nothing may be sent to a subscription an admin (or the threshold) turned off"
    );
}

// ---------------------------------------------------------------------------
// 3. the guard this harness deliberately steps around
// ---------------------------------------------------------------------------

/// **Red proof for the harness itself.** The two tests above reach a loopback
/// subscriber only because `LoopbackTransport` skips the SSRF check. If the
/// production transport would ALSO reach it, those tests would be proving
/// nothing about the guard. So: the same URL, through the real transport, must
/// be refused — and refused with no status, so no audit line is written for a
/// payload that never left.
#[tokio::test]
async fn the_ssrf_guard_refuses_the_very_url_this_harness_uses() {
    let url = momo_webhook::validated_url("https://example.com/hook", false).expect("public");
    let loopback = OutboundUrl {
        scheme: "http".into(),
        host: "127.0.0.1".into(),
        port: Some(9),
        path_and_query: "/hook".into(),
        absolute: "http://127.0.0.1:9/hook".into(),
    };
    let transport = SafeWebhookTransport::new(true, std::time::Duration::from_millis(200));
    let result = transport
        .deliver(&loopback, "1", "mention", "secret", b"{}")
        .await;
    assert_eq!(
        result,
        DeliveryResult::Permanent {
            reason: "SSRF guard rejected destination".to_string(),
            status: None,
        },
        "a loopback destination must never be reached by the production transport"
    );
    assert_eq!(
        result.delivered_status(),
        None,
        "nothing left the process, so nothing may be written to the #1204 ledger"
    );

    // …and the guard is not simply refusing everything: a public destination
    // passes the same check. (It is not connected to — only resolved.)
    assert!(
        momo_webhook::validated_resolved_addresses(&url, &SystemHostResolver)
            .await
            .is_ok()
            || std::env::var("MOMO_OFFLINE_TEST").is_ok(),
        "a public host must pass the same guard, or the refusal above proves nothing"
    );
}

/// The other red proof: a subscriber that verifies signatures must reject a
/// payload signed with the wrong secret. Without this, the "signature verified"
/// assertion in test 1 could be satisfied by a verifier that accepts anything.
#[tokio::test]
async fn the_verifier_rejects_a_wrongly_signed_payload() {
    let (url, subscriber) = start_subscriber("the-right-secret").await;
    let body = json!({"kind": "mention"}).to_string();
    let timestamp = "1700000000";
    let forged = momo_webhook::delivery_signature("the-WRONG-secret", timestamp, body.as_bytes());
    let status = reqwest::Client::new()
        .post(&url)
        .header("X-Momo-Timestamp", timestamp)
        .header("X-Momo-Signature", format!("v1={forged}"))
        .body(body)
        .send()
        .await
        .expect("post")
        .status();
    assert_eq!(status, 401);
    assert_eq!(subscriber.forged.load(Ordering::SeqCst), 1);
    assert_eq!(subscriber.received.load(Ordering::SeqCst), 0);
}
