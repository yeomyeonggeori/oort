//! Public inbound webhook ingress (#1265 / ADR-0115).
//!
//! Two unauthenticated routes, one write path:
//!
//! * `POST /v1/webhooks/{ws}/{installation}` — HMAC headers
//! * `POST /hooks/{token}` — Slack-compatible URL secret
//!
//! Direct `INSERT INTO message` is forbidden; every created row goes through
//! [`momo_messaging::send_message_in_tx`] so `message.seq` is server-assigned
//! and an `outbox` broadcast appears. The shell contract script greps that.
//!
//! Replay must short-circuit **before parse**. The verifier sabotages that
//! order (`WEBHOOK_RUST_PROVE_RED_INGRESS_ORDER=1`): a second delivery with
//! the same `delivery_id` and a body that would 400 if parsed must still 200.
//!
//! `#[ignore]` because it needs a real Postgres. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test webhook_inbound_conformance_pg -- --ignored --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::WebhookSettings;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "webhook-conformance-app-signing-secret";
const TEST_OUTBOUND_MASTER_KEY: &str = "webhook-conformance-outbound-master-key";
const TEST_PASSWORD: &str = "webhook-conformance-password";
const UNKNOWN: &str = "webhook installation not found";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let options = options.username("momo_app").password(&momo_app_password());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
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

fn apply_bootstrap_roles() {
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
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
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    apply_bootstrap_roles();
    *ready = true;
}

struct Fixture {
    workspace: Uuid,
    channel: Uuid,
    owner_email: String,
}

async fn seed(su: &PgPool, hint: &str) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");

    let owner = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(owner)
    .bind(workspace)
    .bind(owner.to_string())
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner'::membership_role)",
    )
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed workspace_membership");
    let owner_email = format!("{owner}@webhook.test");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(owner)
    .bind(workspace)
    .bind(&owner_email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human");

    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', 'general', 'webhook target', $3)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");

    Fixture {
        workspace,
        channel,
        owner_email,
    }
}

async fn start_server(pool: PgPool, per_installation_limit: u32) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_webhook(WebhookSettings {
        outbound_master_key: Some(TEST_OUTBOUND_MASTER_KEY.to_string()),
        allow_development_http: false,
        doorbell_enabled: false,
        per_installation_limit,
    });
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> String {
    let body: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": TEST_PASSWORD,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login")
        .json()
        .await
        .expect("login body");
    body["accessToken"]
        .as_str()
        .expect("login returns an access token")
        .to_string()
}

async fn create_install(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    mode: &str,
    label: &str,
) -> Value {
    let response = http
        .post(format!("{base}/v1/workspaces/{workspace}/webhooks"))
        .bearer_auth(token)
        .json(&json!({
            "channelId": channel.to_string(),
            "mode": mode,
            "label": label,
        }))
        .send()
        .await
        .expect("create installation");
    assert_eq!(response.status(), 201, "create {mode}");
    response.json().await.expect("create body")
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs() as i64
}

struct NativeCreds {
    workspace: Uuid,
    installation: Uuid,
    key_id: Uuid,
    secret: String,
}

fn native_creds(workspace: Uuid, created: &Value) -> NativeCreds {
    NativeCreds {
        workspace,
        installation: created["installation"]["id"]
            .as_str()
            .expect("id")
            .parse()
            .expect("installation uuid"),
        key_id: created["keyId"]
            .as_str()
            .expect("keyId")
            .parse()
            .expect("key uuid"),
        secret: created["secret"]
            .as_str()
            .expect("native secret")
            .to_string(),
    }
}

fn sign(creds: &NativeCreds, timestamp: &str, delivery_id: &str, body: &[u8]) -> String {
    let body_sha = momo_webhook::sha256_hex(body);
    let base = momo_webhook::canonical_signature_base(
        creds.workspace,
        creds.installation,
        timestamp,
        delivery_id,
        &body_sha,
    );
    format!(
        "v1={}",
        momo_webhook::ingress_signature(&creds.secret, &base)
    )
}

async fn post_native(
    http: &reqwest::Client,
    base: &str,
    creds: &NativeCreds,
    delivery_id: &str,
    timestamp: i64,
    body: Vec<u8>,
    signature_override: Option<String>,
) -> reqwest::Response {
    let ts = timestamp.to_string();
    let signature = signature_override.unwrap_or_else(|| sign(creds, &ts, delivery_id, &body));
    http.post(format!(
        "{base}/v1/webhooks/{}/{}",
        creds.workspace, creds.installation
    ))
    .header("x-momo-signature-version", "v1")
    .header("x-momo-key-id", creds.key_id.to_string())
    .header("x-momo-timestamp", &ts)
    .header("x-momo-delivery-id", delivery_id)
    .header("x-momo-signature", signature)
    .header("content-type", "application/json")
    .body(body)
    .send()
    .await
    .expect("native POST")
}

async fn error_of(response: reqwest::Response) -> (u16, String) {
    let status = response.status().as_u16();
    let body: Value = response.json().await.expect("error json");
    let message = body["error"]["message"]
        .as_str()
        .expect("error.message")
        .to_string();
    (status, message)
}

async fn broadcast_count(su: &PgPool, channel: Uuid, message_id: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*)::bigint FROM outbox \
          WHERE partition_key = $1 AND kind = 'broadcast' \
            AND payload->'data'->'payload'->>'id' = $2",
    )
    .bind(channel)
    .bind(message_id.to_string())
    .fetch_one(su)
    .await
    .expect("count outbox")
}

async fn message_seq(su: &PgPool, message_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT seq FROM message WHERE id = $1")
        .bind(message_id)
        .fetch_one(su)
        .await
        .expect("message seq")
}

// ---------------------------------------------------------------------------
// Native HMAC: ok / forged / expired / unknown / replay-before-parse
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn native_signature_ok_forged_expired_replay_and_unknown_404() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su, "inbound-native").await;
    let base = start_server(momo_app_pool().await, 60).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner_email).await;
    let created = create_install(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        "native",
        "CI",
    )
    .await;
    let creds = native_creds(fixture.workspace, &created);
    let body = br#"{"text":"hello from native"}"#.to_vec();

    let ok = post_native(
        &http,
        &base,
        &creds,
        "delivery-ok-1",
        unix_now(),
        body.clone(),
        None,
    )
    .await;
    assert_eq!(ok.status(), 201, "first native delivery");
    let ok_body: Value = ok.json().await.expect("201 body");
    assert_eq!(ok_body["duplicate"], false);
    let message_id: Uuid = ok_body["messageId"]
        .as_str()
        .expect("messageId")
        .parse()
        .expect("message uuid");
    assert_eq!(message_seq(&su, message_id).await, 1);
    assert_eq!(broadcast_count(&su, fixture.channel, message_id).await, 1);

    let forged = post_native(
        &http,
        &base,
        &creds,
        "delivery-forged",
        unix_now(),
        body.clone(),
        Some("v1=0000000000000000000000000000000000000000000000000000000000000000".into()),
    )
    .await;
    let (forged_status, _) = error_of(forged).await;
    assert_eq!(forged_status, 401, "forged HMAC is 401, not 404");

    let expired = post_native(
        &http,
        &base,
        &creds,
        "delivery-expired",
        unix_now() - 400,
        body.clone(),
        None,
    )
    .await;
    let (expired_status, _) = error_of(expired).await;
    assert_eq!(expired_status, 401, "timestamp outside the 5-minute window");

    let unknown_install = Uuid::new_v4();
    let unknown_url = format!(
        "{base}/v1/webhooks/{}/{}",
        fixture.workspace, unknown_install
    );
    let ts = unix_now().to_string();
    let unknown_body = body.clone();
    let dummy = NativeCreds {
        workspace: fixture.workspace,
        installation: unknown_install,
        key_id: creds.key_id,
        secret: creds.secret.clone(),
    };
    let unknown = http
        .post(&unknown_url)
        .header("x-momo-signature-version", "v1")
        .header("x-momo-key-id", creds.key_id.to_string())
        .header("x-momo-timestamp", &ts)
        .header("x-momo-delivery-id", "delivery-unknown")
        .header(
            "x-momo-signature",
            sign(&dummy, &ts, "delivery-unknown", &unknown_body),
        )
        .header("content-type", "application/json")
        .body(unknown_body)
        .send()
        .await
        .expect("unknown install POST");
    let (unknown_status, unknown_msg) = error_of(unknown).await;
    assert_eq!(unknown_status, 404);
    assert_eq!(unknown_msg, UNKNOWN);

    // Same delivery_id, a body that parse_native would 400, HMAC of *that* body.
    // Must 200 because replay short-circuits above parse. The verifier moves
    // parse above the signature check and this case is the one that goes RED.
    let garbage = br#"{"nope":true}"#.to_vec();
    let replay = post_native(
        &http,
        &base,
        &creds,
        "delivery-ok-1",
        unix_now(),
        garbage,
        None,
    )
    .await;
    assert_eq!(
        replay.status(),
        200,
        "replay of a known delivery_id must not parse the new body"
    );
    let replay_body: Value = replay.json().await.expect("200 body");
    assert_eq!(replay_body["duplicate"], true);
    assert_eq!(replay_body["messageId"], ok_body["messageId"]);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn native_consecutive_seq_and_outbox_row() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su, "inbound-seq").await;
    let base = start_server(momo_app_pool().await, 60).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner_email).await;
    let created = create_install(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        "native",
        "seq",
    )
    .await;
    let creds = native_creds(fixture.workspace, &created);

    let first = post_native(
        &http,
        &base,
        &creds,
        "seq-a",
        unix_now(),
        br#"{"text":"one"}"#.to_vec(),
        None,
    )
    .await;
    assert_eq!(first.status(), 201);
    let first_body: Value = first.json().await.expect("first");
    let second = post_native(
        &http,
        &base,
        &creds,
        "seq-b",
        unix_now(),
        br#"{"text":"two"}"#.to_vec(),
        None,
    )
    .await;
    assert_eq!(second.status(), 201);
    let second_body: Value = second.json().await.expect("second");

    let id1: Uuid = first_body["messageId"].as_str().unwrap().parse().unwrap();
    let id2: Uuid = second_body["messageId"].as_str().unwrap().parse().unwrap();
    let seq1 = message_seq(&su, id1).await;
    let seq2 = message_seq(&su, id2).await;
    assert_eq!(seq2, seq1 + 1, "server-assigned consecutive seq");
    assert_eq!(first_body["seq"], seq1);
    assert_eq!(second_body["seq"], seq2);
    assert_eq!(broadcast_count(&su, fixture.channel, id1).await, 1);
    assert_eq!(broadcast_count(&su, fixture.channel, id2).await, 1);
}

// ---------------------------------------------------------------------------
// Slack-compatible token: ok / revoked / typo — same 404 sentence
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn slack_token_ok_revoked_typo_share_the_404_sentence() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su, "inbound-slack").await;
    let base = start_server(momo_app_pool().await, 60).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner_email).await;
    let created = create_install(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        "slack_compatible",
        "grafana",
    )
    .await;
    let url = created["url"].as_str().expect("slack url").to_string();
    assert!(url.starts_with("/hooks/momo_hook_v1."), "{url}");
    let hook_token = url.trim_start_matches("/hooks/");

    let ok = http
        .post(format!("{base}{url}"))
        .json(&json!({ "text": "hello from slack" }))
        .send()
        .await
        .expect("slack ok");
    assert_eq!(ok.status(), 201);
    let ok_body: Value = ok.json().await.expect("slack 201");
    let message_id: Uuid = ok_body["messageId"].as_str().unwrap().parse().unwrap();
    assert_eq!(broadcast_count(&su, fixture.channel, message_id).await, 1);

    let duplicate = http
        .post(format!("{base}{url}"))
        .json(&json!({ "text": "hello from slack" }))
        .send()
        .await
        .expect("slack duplicate");
    assert_eq!(duplicate.status(), 200);
    let dup_body: Value = duplicate.json().await.expect("slack 200");
    assert_eq!(dup_body["duplicate"], true);
    assert_eq!(dup_body["messageId"], ok_body["messageId"]);

    let mut typo = hook_token.to_string();
    let last = typo.pop().expect("token chars");
    typo.push(if last == 'A' { 'B' } else { 'A' });
    let typo_resp = http
        .post(format!("{base}/hooks/{typo}"))
        .json(&json!({ "text": "typo" }))
        .send()
        .await
        .expect("typo");
    let (typo_status, typo_msg) = error_of(typo_resp).await;
    assert_eq!(typo_status, 404);
    assert_eq!(typo_msg, UNKNOWN);

    let installation_id = created["installation"]["id"].as_str().expect("id");
    let revoked = http
        .delete(format!(
            "{base}/v1/workspaces/{}/webhooks/{installation_id}",
            fixture.workspace
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("revoke");
    assert_eq!(revoked.status(), 200);

    let after_revoke = http
        .post(format!("{base}{url}"))
        .json(&json!({ "text": "still here" }))
        .send()
        .await
        .expect("revoked POST");
    let (revoked_status, revoked_msg) = error_of(after_revoke).await;
    assert_eq!(revoked_status, 404);
    assert_eq!(revoked_msg, UNKNOWN);
    assert_eq!(
        typo_msg, revoked_msg,
        "existence leak is the status, not the copy"
    );
}

// ---------------------------------------------------------------------------
// Guards: 413 / 429
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn oversize_body_is_413_on_both_routes() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su, "inbound-413").await;
    let base = start_server(momo_app_pool().await, 60).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner_email).await;
    let native = create_install(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        "native",
        "413",
    )
    .await;
    let slack = create_install(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        "slack_compatible",
        "413-slack",
    )
    .await;
    let creds = native_creds(fixture.workspace, &native);
    let huge = vec![b'x'; momo_webhook::MAXIMUM_BODY_BYTES + 1];

    let native_big = post_native(
        &http,
        &base,
        &creds,
        "delivery-413",
        unix_now(),
        huge.clone(),
        None,
    )
    .await;
    let (native_status, native_msg) = error_of(native_big).await;
    assert_eq!(native_status, 413);
    assert_eq!(native_msg, "webhook body exceeds 262144 bytes");

    let slack_url = slack["url"].as_str().expect("url");
    let slack_big = http
        .post(format!("{base}{slack_url}"))
        .header("content-type", "application/json")
        .body(huge)
        .send()
        .await
        .expect("slack 413");
    let (slack_status, slack_msg) = error_of(slack_big).await;
    assert_eq!(slack_status, 413);
    assert_eq!(slack_msg, native_msg);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn per_installation_rate_limit_is_429() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su, "inbound-429").await;
    let base = start_server(momo_app_pool().await, 2).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner_email).await;
    let created = create_install(
        &http,
        &base,
        &token,
        fixture.workspace,
        fixture.channel,
        "native",
        "429",
    )
    .await;
    let creds = native_creds(fixture.workspace, &created);

    for index in 1..=2 {
        let response = post_native(
            &http,
            &base,
            &creds,
            &format!("delivery-429-{index}"),
            unix_now(),
            br#"{"text":"rate"}"#.to_vec(),
            None,
        )
        .await;
        assert_eq!(response.status(), 201, "admission {index}");
    }
    let limited = post_native(
        &http,
        &base,
        &creds,
        "delivery-429-3",
        unix_now(),
        br#"{"text":"rate"}"#.to_vec(),
        None,
    )
    .await;
    assert_eq!(limited.status(), 429);
    assert!(limited.headers().get("retry-after").is_some());
    let (status, message) = error_of(limited).await;
    assert_eq!(status, 429);
    assert_eq!(message, "rate limit exceeded");
}
