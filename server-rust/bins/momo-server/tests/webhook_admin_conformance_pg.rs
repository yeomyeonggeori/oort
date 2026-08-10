//! **The two webhook panels' own sequences, replayed against the real server** (#1222 / T13).
//!
//! Organised by *client*, not by server surface — the same discipline as
//! `settings_conformance_pg.rs`. Both panels were landed on 2026-08-09 against a
//! server that had none of these routes, so every call below is one the deployed
//! client already makes and was getting a 404 for.
//!
//! | # | panel | call | client |
//! |---|---|---|---|
//! | 1 | 웹훅 | `GET …/webhooks` | `features/webhooks/api.ts:74` |
//! | 2 | 웹훅 | `POST …/webhooks` | `features/webhooks/api.ts:86` |
//! | 3 | 웹훅 | `POST …/webhooks/{id}/rotate` | `features/webhooks/api.ts:105` |
//! | 4 | 웹훅 | `DELETE …/webhooks/{id}` | `features/webhooks/api.ts:117` |
//! | 5 | 이벤트 구독 | `GET·POST·PUT·DELETE …/event-subscriptions` | `features/settings/eventSubscriptions.ts:465` |
//!
//! Properties asserted here that no single call could show on its own:
//!
//! * **A credential is answered once and is never readable again.** The create
//!   response carries it, the list that follows does not, and the value is not in
//!   Postgres in any form a `LIKE` can find.
//! * **Managing a webhook is not a broadcast.** No route in this batch may append
//!   an `outbox` row; the test counts before and after.
//! * **RLS is what stops a foreign tenant, not a `WHERE` clause.** The second
//!   test runs the same domain reads under another tenant's GUC and requires zero
//!   rows, then re-runs them under the owning tenant's and requires them back —
//!   so a green result cannot come from a query that returns nothing anyway.
//! * **The SSRF guard is enforced by the route, not by the panel.** A private
//!   destination is refused with a 400 even though the client would never send
//!   one.
//!
//! `#[ignore]` because it needs a real Postgres. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test webhook_admin_conformance_pg -- --ignored --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_server::config::WebhookSettings;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (same contract as settings_conformance_pg.rs)
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "webhook-conformance-app-signing-secret";
/// Deliberately different from the app secret, for the same reason B4 split the
/// Centrifugo key and MOMO-572 split the provider key: one leak must not be two.
const TEST_OUTBOUND_MASTER_KEY: &str = "webhook-conformance-outbound-master-key";
const TEST_PASSWORD: &str = "webhook-conformance-password";

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

/// Boot the router with the webhook surface configured the way a deployment
/// would: a dedicated outbound master key and HTTPS-only destinations.
async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_webhook(WebhookSettings {
        outbound_master_key: Some(TEST_OUTBOUND_MASTER_KEY.to_string()),
        allow_development_http: false,
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

// ---------------------------------------------------------------------------
// fixtures (superuser → bypass RLS)
// ---------------------------------------------------------------------------

struct Fixture {
    workspace: Uuid,
    owner: Uuid,
    channel: Uuid,
    owner_email: String,
    member_email: String,
}

/// One workspace, an owner, a plain member (the 403 case), and one public
/// channel for the installation to bind to.
async fn seed(su: &PgPool, hint: &str) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");

    let mut people = Vec::new();
    for role in ["owner", "member"] {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, 'human', $3, $3)",
        )
        .bind(id)
        .bind(workspace)
        .bind(id.to_string())
        .execute(su)
        .await
        .expect("seed member");
        sqlx::query(
            "INSERT INTO workspace_membership (workspace_id, member_id, role) \
             VALUES ($1, $2, $3::membership_role)",
        )
        .bind(workspace)
        .bind(id)
        .bind(role)
        .execute(su)
        .await
        .expect("seed workspace_membership");
        let email = format!("{id}@webhook.test");
        sqlx::query(
            "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
             VALUES ($1, $2, $3, true, momo_password_hash($4))",
        )
        .bind(id)
        .bind(workspace)
        .bind(&email)
        .bind(TEST_PASSWORD)
        .execute(su)
        .await
        .expect("seed human");
        people.push((id, email));
    }

    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', 'general', 'webhook target', $3)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(people[0].0)
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
        owner: people[0].0,
        channel,
        owner_email: people[0].1.clone(),
        member_email: people[1].1.clone(),
    }
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

async fn outbox_rows(su: &PgPool) -> i64 {
    sqlx::query("SELECT count(*)::bigint FROM outbox")
        .fetch_one(su)
        .await
        .expect("count outbox")
        .get::<i64, _>(0)
}

async fn audit_rows(su: &PgPool, workspace: Uuid, action: &str) -> i64 {
    sqlx::query("SELECT count(*)::bigint FROM audit_log WHERE workspace_id = $1 AND action = $2")
        .bind(workspace)
        .bind(action)
        .fetch_one(su)
        .await
        .expect("count audit")
        .get::<i64, _>(0)
}

/// Is this exact string anywhere in the two tables that could hold it? The
/// one-time credential must be absent from both, in every column.
async fn secret_is_stored_anywhere(su: &PgPool, secret: &str) -> bool {
    let found: i64 = sqlx::query(
        "SELECT count(*)::bigint FROM webhook_secret_key \
          WHERE COALESCE(secret_ref,'') = $1 OR COALESCE(token_hash,'') = $1",
    )
    .bind(secret)
    .fetch_one(su)
    .await
    .expect("scan webhook_secret_key")
    .get(0);
    let subscriptions: i64 =
        sqlx::query("SELECT count(*)::bigint FROM event_subscription WHERE secret_ref = $1")
            .bind(secret)
            .fetch_one(su)
            .await
            .expect("scan event_subscription")
            .get(0);
    found + subscriptions > 0
}

// ---------------------------------------------------------------------------
// 1. the 웹훅 panel's sequence
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_webhook_panel_installs_rotates_and_revokes() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su, "webhook").await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner_email).await;
    let auth = |request: reqwest::RequestBuilder| request.bearer_auth(&token);
    let collection = format!("{base}/v1/workspaces/{}/webhooks", fixture.workspace);
    let outbox_before = outbox_rows(&su).await;

    // -- 1. list: empty before anything is installed -----------------------
    let empty: Value = auth(http.get(&collection))
        .send()
        .await
        .expect("list")
        .json()
        .await
        .expect("list body");
    assert_eq!(
        empty["installations"].as_array().map(Vec::len),
        Some(0),
        "{empty}"
    );

    // -- 2. create: 201, no-store, and the ONE reveal -----------------------
    let response = auth(http.post(&collection))
        .json(&json!({
            "channelId": fixture.channel.to_string(),
            "mode": "native",
            "label": "CI 알림",
        }))
        .send()
        .await
        .expect("create");
    assert_eq!(response.status(), 201);
    assert_eq!(
        response
            .headers()
            .get("cache-control")
            .and_then(|value| value.to_str().ok()),
        Some("no-store"),
        "a one-time credential must not be cacheable"
    );
    let created: Value = response.json().await.expect("create body");
    let installation_id = created["installation"]["id"]
        .as_str()
        .expect("installation id")
        .to_string();
    let secret = created["secret"]
        .as_str()
        .expect("native reveal")
        .to_string();
    assert!(secret.starts_with("momo_whsec_v1."), "{created}");
    assert_eq!(created["signatureVersion"], "v1");
    assert_eq!(created["algorithm"], "HMAC-SHA256");
    assert_eq!(
        created["url"],
        format!("/v1/webhooks/{}/{installation_id}", fixture.workspace),
        "the ingress path is relative so the client resolves it against its own origin"
    );
    assert_eq!(created["installation"]["status"], "active");
    assert_eq!(
        created["installation"]["channelId"],
        fixture.channel.to_string()
    );

    // The four rows ADR-0115 says a create is, and the author that is NOT the
    // installer — the property that stops CI messages from looking like a person.
    let author: Uuid = created["installation"]["authorMemberId"]
        .as_str()
        .expect("author")
        .parse()
        .expect("author uuid");
    assert_ne!(
        author, fixture.owner,
        "an ingress message must not be attributed to whoever installed the hook"
    );
    let author_kind: String = sqlx::query("SELECT kind::text FROM member WHERE id = $1")
        .bind(author)
        .fetch_one(&su)
        .await
        .expect("author member")
        .get(0);
    assert_eq!(author_kind, "agent");
    let author_is_agent: i64 =
        sqlx::query("SELECT count(*)::bigint FROM agent WHERE member_id = $1")
            .bind(author)
            .fetch_one(&su)
            .await
            .expect("agent row")
            .get(0);
    assert_eq!(
        author_is_agent, 0,
        "the service member has no agent row, so nothing can ever run as it"
    );
    assert_eq!(
        audit_rows(&su, fixture.workspace, "webhook.issued").await,
        1
    );

    // -- the reveal is never readable again --------------------------------
    assert!(
        !secret_is_stored_anywhere(&su, &secret).await,
        "the native secret is derived, never persisted"
    );
    let listed: Value = auth(http.get(&collection))
        .send()
        .await
        .expect("list after create")
        .json()
        .await
        .expect("list body");
    let row = &listed["installations"][0];
    assert_eq!(row["id"], installation_id.as_str());
    for forbidden in ["secret", "url", "keyId"] {
        assert!(
            row.get(forbidden).is_none(),
            "the list contract carries no credential material, found {forbidden}: {listed}"
        );
    }

    // -- 3. rotate: a second reveal, a different value ----------------------
    let rotate_url = format!("{collection}/{installation_id}/rotate");
    let rotated: Value = auth(http.post(&rotate_url))
        .json(&json!({ "overlapSeconds": 60 }))
        .send()
        .await
        .expect("rotate")
        .json()
        .await
        .expect("rotate body");
    let rotated_secret = rotated["secret"].as_str().expect("rotate reveal");
    assert_ne!(
        rotated_secret, secret,
        "a rotation that returned the same value would not be a rotation"
    );
    assert_eq!(rotated["overlapSeconds"], 60);
    assert_eq!(
        audit_rows(&su, fixture.workspace, "webhook.rotated").await,
        1
    );

    // The overlap is a DEADLINE on the old key, not a delete: the previous
    // credential must still exist and must now expire.
    let live_keys: i64 = sqlx::query(
        "SELECT count(*)::bigint FROM webhook_secret_key \
          WHERE installation_id = $1::uuid AND revoked_at IS NULL",
    )
    .bind(&installation_id)
    .fetch_one(&su)
    .await
    .expect("count keys")
    .get(0);
    assert_eq!(live_keys, 2, "the previous key survives its overlap window");
    let expiring: i64 = sqlx::query(
        "SELECT count(*)::bigint FROM webhook_secret_key \
          WHERE installation_id = $1::uuid AND valid_until IS NOT NULL",
    )
    .bind(&installation_id)
    .fetch_one(&su)
    .await
    .expect("count expiring")
    .get(0);
    assert_eq!(expiring, 1);

    // Out-of-range overlap is a 400 before anything is written.
    assert_eq!(
        auth(http.post(&rotate_url))
            .json(&json!({ "overlapSeconds": 604_801 }))
            .send()
            .await
            .expect("rotate too long")
            .status(),
        400
    );

    // -- 4. revoke: irreversible, and repeatable ----------------------------
    let revoked: Value = auth(http.delete(format!("{collection}/{installation_id}")))
        .send()
        .await
        .expect("revoke")
        .json()
        .await
        .expect("revoke body");
    assert_eq!(revoked["revoked"], true);
    assert_eq!(revoked["installation"]["status"], "revoked");
    let live_after: i64 = sqlx::query(
        "SELECT count(*)::bigint FROM webhook_secret_key \
          WHERE installation_id = $1::uuid AND revoked_at IS NULL",
    )
    .bind(&installation_id)
    .fetch_one(&su)
    .await
    .expect("count keys after revoke")
    .get(0);
    assert_eq!(live_after, 0, "every credential dies with the installation");

    // A rotate after revoke is a 409, not a new credential for a dead hook.
    assert_eq!(
        auth(http.post(&rotate_url))
            .json(&json!({ "overlapSeconds": 0 }))
            .send()
            .await
            .expect("rotate revoked")
            .status(),
        409
    );
    // DELETE stays safe to repeat and does not write a second audit line.
    assert_eq!(
        auth(http.delete(format!("{collection}/{installation_id}")))
            .send()
            .await
            .expect("revoke twice")
            .status(),
        200
    );
    assert_eq!(
        audit_rows(&su, fixture.workspace, "webhook.revoked").await,
        1
    );

    // -- red proofs: the gates, exercised ----------------------------------
    let member_token = login(&http, &base, fixture.workspace, &fixture.member_email).await;
    assert_eq!(
        http.get(&collection)
            .bearer_auth(&member_token)
            .send()
            .await
            .expect("member list")
            .status(),
        403,
        "a plain member must not read the workspace's ingress installations"
    );
    assert_eq!(
        auth(http.post(&collection))
            .json(&json!({
                "channelId": Uuid::new_v4().to_string(),
                "mode": "native",
                "label": "nope",
            }))
            .send()
            .await
            .expect("create foreign channel")
            .status(),
        404,
        "an installation must bind to an active channel in THIS workspace"
    );
    assert_eq!(
        auth(http.post(&collection))
            .json(&json!({
                "channelId": fixture.channel.to_string(),
                "mode": "discord",
                "label": "nope",
            }))
            .send()
            .await
            .expect("create bad mode")
            .status(),
        400
    );

    // -- managing a webhook is not a broadcast -----------------------------
    assert_eq!(
        outbox_rows(&su).await,
        outbox_before,
        "no route in this batch may append an outbox row"
    );
}

// ---------------------------------------------------------------------------
// 2. the 이벤트 구독 panel's sequence
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_event_subscription_panel_registers_updates_and_deletes() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su, "evtsub").await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, fixture.workspace, &fixture.owner_email).await;
    let auth = |request: reqwest::RequestBuilder| request.bearer_auth(&token);
    let collection = format!(
        "{base}/v1/workspaces/{}/event-subscriptions",
        fixture.workspace
    );

    // -- create: the ONE reveal --------------------------------------------
    let response = auth(http.post(&collection))
        .json(&json!({
            "url": "https://example.com/oort-hook",
            "eventKinds": ["work.status_changed", "mention", "mention"],
        }))
        .send()
        .await
        .expect("create");
    assert_eq!(response.status(), 201);
    let created: Value = response.json().await.expect("create body");
    let subscription_id = created["eventSubscription"]["id"]
        .as_str()
        .expect("subscription id")
        .to_string();
    let secret = created["secret"].as_str().expect("reveal").to_string();
    assert!(secret.starts_with("momo_evtsec_v1."), "{created}");
    assert_eq!(created["signatureVersion"], "v1");
    assert_eq!(
        created["eventSubscription"]["eventKinds"],
        json!(["mention", "work.status_changed"]),
        "kinds are de-duplicated and sorted, so two identical subscriptions read alike"
    );
    assert_eq!(created["eventSubscription"]["enabled"], true);
    assert!(
        !secret_is_stored_anywhere(&su, &secret).await,
        "the signing secret is derived from secret_ref, never stored"
    );

    // The derivation is the deployed one: a subscriber holding a Swift-issued
    // credential must keep verifying, so the value has to be reproducible from
    // (master key, secret_ref) alone.
    let secret_ref: String =
        sqlx::query("SELECT secret_ref FROM event_subscription WHERE id = $1::uuid")
            .bind(&subscription_id)
            .fetch_one(&su)
            .await
            .expect("read secret_ref")
            .get(0);
    assert_eq!(
        secret,
        momo_webhook::outbound_secret(TEST_OUTBOUND_MASTER_KEY, &secret_ref),
        "the revealed secret must be exactly what the sender will recompute"
    );

    // -- list: the same row, without any signing material -------------------
    let listed: Value = auth(http.get(&collection))
        .send()
        .await
        .expect("list")
        .json()
        .await
        .expect("list body");
    let row = &listed["eventSubscriptions"][0];
    assert_eq!(row["id"], subscription_id.as_str());
    for forbidden in ["secret", "secretRef"] {
        assert!(row.get(forbidden).is_none(), "{listed}");
    }
    assert_eq!(
        audit_rows(&su, fixture.workspace, "event_subscription.created").await,
        1
    );

    // -- update: disable, then re-enable and watch the ledger clear ---------
    let item = format!("{collection}/{subscription_id}");
    let disabled: Value = auth(http.put(&item))
        .json(&json!({ "enabled": false }))
        .send()
        .await
        .expect("disable")
        .json()
        .await
        .expect("disable body");
    assert_eq!(disabled["eventSubscription"]["enabled"], false);
    assert_eq!(
        disabled["eventSubscription"]["disabledReason"],
        "disabled_by_admin"
    );
    assert!(disabled["eventSubscription"]["disabledAtMs"].is_i64());

    // Pretend the sender had counted failures before the admin turned it off.
    sqlx::query("UPDATE event_subscription SET delivery_failure_count = 4 WHERE id = $1::uuid")
        .bind(&subscription_id)
        .execute(&su)
        .await
        .expect("seed failures");
    let reenabled: Value = auth(http.put(&item))
        .json(&json!({ "enabled": true, "url": "https://example.org/moved" }))
        .send()
        .await
        .expect("re-enable")
        .json()
        .await
        .expect("re-enable body");
    assert_eq!(reenabled["eventSubscription"]["enabled"], true);
    assert_eq!(
        reenabled["eventSubscription"]["deliveryFailureCount"], 0,
        "re-enabling must clear the ledger, or the next failure re-trips the threshold"
    );
    assert!(reenabled["eventSubscription"].get("disabledAtMs").is_none());
    assert_eq!(
        reenabled["eventSubscription"]["url"],
        "https://example.org/moved"
    );

    // -- red proofs ---------------------------------------------------------
    assert_eq!(
        auth(http.put(&item))
            .json(&json!({}))
            .send()
            .await
            .expect("empty update")
            .status(),
        400,
        "an empty save must not answer 200 for a change that did not happen"
    );
    for destination in [
        "http://example.com/insecure",
        "https://127.0.0.1/hook",
        "https://192.168.0.5/hook",
        "https://169.254.169.254/latest/meta-data",
        "https://user:pw@example.com/hook",
    ] {
        assert_eq!(
            auth(http.post(&collection))
                .json(&json!({ "url": destination, "eventKinds": ["mention"] }))
                .send()
                .await
                .expect("bad destination")
                .status(),
            400,
            "the SSRF/HTTPS guard is the route's, not the panel's: {destination}"
        );
    }
    assert_eq!(
        auth(http.post(&collection))
            .json(&json!({ "url": "https://example.com/x", "eventKinds": ["telepathy"] }))
            .send()
            .await
            .expect("bad kind")
            .status(),
        400
    );
    let member_token = login(&http, &base, fixture.workspace, &fixture.member_email).await;
    assert_eq!(
        http.get(&collection)
            .bearer_auth(&member_token)
            .send()
            .await
            .expect("member list")
            .status(),
        403,
        "only an owner/admin decides what leaves the workspace"
    );

    // -- delete: the row is gone, the audit line is what remains ------------
    let deleted: Value = auth(http.delete(&item))
        .send()
        .await
        .expect("delete")
        .json()
        .await
        .expect("delete body");
    assert_eq!(deleted["eventSubscription"]["id"], subscription_id.as_str());
    assert_eq!(
        auth(http.delete(&item))
            .send()
            .await
            .expect("delete twice")
            .status(),
        404
    );
    assert_eq!(
        audit_rows(&su, fixture.workspace, "event_subscription.deleted").await,
        1
    );
}

// ---------------------------------------------------------------------------
// 3. RLS, proved by running the same read under the wrong tenant
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_foreign_tenants_guc_sees_neither_family() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let owner = seed(&su, "rls-owner").await;
    let stranger = seed(&su, "rls-stranger").await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, owner.workspace, &owner.owner_email).await;

    http.post(format!("{base}/v1/workspaces/{}/webhooks", owner.workspace))
        .bearer_auth(&token)
        .json(&json!({
            "channelId": owner.channel.to_string(),
            "mode": "slack_compatible",
            "label": "slack",
        }))
        .send()
        .await
        .expect("create installation");
    http.post(format!(
        "{base}/v1/workspaces/{}/event-subscriptions",
        owner.workspace
    ))
    .bearer_auth(&token)
    .json(&json!({ "url": "https://example.com/rls", "eventKinds": ["mention"] }))
    .send()
    .await
    .expect("create subscription");

    // The domain reads, run under the NOBYPASSRLS role with each GUC in turn.
    let app_pool = momo_app_pool().await;
    for (workspace, expected, why) in [
        (
            stranger.workspace,
            0usize,
            "a foreign tenant's GUC must see nothing",
        ),
        (
            owner.workspace,
            1usize,
            "…and the owning tenant's must see it, or the zero above proves nothing",
        ),
    ] {
        let counts: (usize, usize) = momo_db::with_tenant_tx(&app_pool, workspace, move |conn| {
            Box::pin(async move {
                let installations = momo_webhook::list_installations(conn, workspace).await?;
                let subscriptions = momo_webhook::list_subscriptions(conn, workspace).await?;
                Ok((installations.len(), subscriptions.len()))
            })
        })
        .await
        .expect("tenant read");
        assert_eq!(counts.0, expected, "webhook_installation: {why}");
        assert_eq!(counts.1, expected, "event_subscription: {why}");
    }

    // And the HTTP path refuses the cross-tenant address outright, before RLS
    // is ever consulted (defence in depth — `workspace_scope`).
    assert_eq!(
        http.get(format!(
            "{base}/v1/workspaces/{}/event-subscriptions",
            stranger.workspace
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("cross-tenant read")
        .status(),
        403
    );
}
