//! DB-backed conformance for **goal SRV-T2 / ADR-0149** — the half of 휘발 신호
//! that only a real Postgres can answer.
//!
//! `tests/ephemeral_typing_touches_no_pg.rs` proves the publish path needs no
//! database. This file proves the two things that need one:
//!
//!   1. **the membership check is real** — the grant route and the subscribe
//!      proxy both refuse a caller who is not a live member of that channel,
//!      including across tenants;
//!   2. **nothing is written** — a burst of 「작성 중」 leaves `outbox`,
//!      `message` and `channel_seq` byte-identical.
//!
//! `#[ignore]` because it needs a real Postgres. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test ephemeral_typing_conformance_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract is `http_smoke_pg.rs`'s: `DATABASE_URL` is a **superuser**
//! (migrations + fixture seeding), the server runs as **`momo_app`**
//! (NOBYPASSRLS, so the RLS policies actually apply), the `momo_app` password
//! defaults to `infra/e2e/bootstrap_roles.sql`'s value and is overridable with
//! `MOMO_APP_PASSWORD`, and the schema/roles step is re-runnable — this binary
//! may share one `pgvector/pgvector:pg18` container with the other suites, since
//! every fixture id is a fresh UUID.
//!
//! ## What each test goes red on
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `srv_t2_1_a_grant_needs_live_channel_membership` | drop `is_channel_member` from the grant route, or weaken it to workspace membership |
//! | `srv_t2_2_the_typing_channel_subscribes_by_the_message_channels_rule` | give `typing:` its own subscribe rule, or forget to teach `parse_channel` about it (the namespace would then be unsubscribable — and unauthorized if it ever were) |
//! | `srv_t2_3_typing_writes_nothing_at_all` | route 휘발 신호 through the outbox, or let it take a `message.seq` |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::routing::post;
use axum::{Json as AxumJson, Router};
use momo_auth::{CentrifugoConnectionClaims, REALTIME_META_SCHEMA};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::config::{EphemeralSettings, RealtimeSettings};
use momo_server::routes::realtime::PROXY_SECRET_HEADER;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "srv-t2-ephemeral-conformance-signing-secret";
const TEST_CENT_TOKEN_HMAC: &str = "srv-t2-ephemeral-conformance-cent-hmac";
const TEST_PROXY_SECRET: &str = "srv-t2-ephemeral-conformance-proxy-secret";
const TEST_CENT_API_KEY: &str = "srv-t2-ephemeral-conformance-api-key";
const TEST_PASSWORD: &str = "srv-t2-ephemeral-conformance-password";

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

// ---------------------------------------------------------------------------
// a stand-in Centrifugo, so the publish half runs without a broker
// ---------------------------------------------------------------------------

type Captured = Arc<Mutex<Vec<Value>>>;

async fn spawn_mock_centrifugo() -> (String, Captured) {
    let captured: Captured = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .route(
            "/publish",
            post(
                |State(sink): State<Captured>, AxumJson(body): AxumJson<Value>| async move {
                    sink.lock().expect("sink").push(body);
                    AxumJson(json!({"result": {}}))
                },
            ),
        )
        .with_state(captured.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock centrifugo");
    let address: SocketAddr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}"), captured)
}

async fn start_server(pool: PgPool, cent_api_url: &str) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_realtime(RealtimeSettings {
        cent_token_hmac: Some(TEST_CENT_TOKEN_HMAC.to_string()),
        cent_proxy_secret: Some(TEST_PROXY_SECRET.to_string()),
        connection_token_ttl_seconds: momo_auth::CONNECTION_TOKEN_TTL_SECONDS,
    })
    .with_ephemeral(EphemeralSettings {
        cent_api_url: Some(cent_api_url.to_string()),
        cent_api_key: Some(TEST_CENT_API_KEY.to_string()),
        ..EphemeralSettings::default()
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

struct Tenant {
    workspace: Uuid,
    /// In the channel.
    member_email: String,
    /// In the workspace, deliberately NOT in the channel — the whole point of a
    /// channel-level check rather than a workspace-level one.
    outsider_email: String,
    channel: Uuid,
}

async fn seed_member(su: &PgPool, workspace: Uuid, label: &str) -> (Uuid, String) {
    let member = Uuid::new_v4();
    let email = format!("{member}@{label}.srvt2.test");
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
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(member)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed workspace membership");
    (member, email)
}

async fn seed_tenant(su: &PgPool, app: &PgPool) -> Tenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");

    let (creator, member_email) = seed_member(su, workspace, "member").await;
    let (_outsider, outsider_email) = seed_member(su, workspace, "outsider").await;

    // `create_channel` seeds `channel_seq` and the CREATOR's channel membership.
    // The outsider gets neither, which is exactly the gap under test.
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("srvt2-{}", Uuid::new_v4()),
            topic: None,
            created_by: creator,
        },
    )
    .await
    .expect("create channel");

    Tenant {
        workspace,
        member_email,
        outsider_email,
        channel: channel.id,
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
        .expect("accessToken")
        .to_string()
}

async fn post_grant(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
) -> (u16, Value) {
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/channels/{channel}/typing/grant"
        ))
        .bearer_auth(token)
        .send()
        .await
        .expect("grant request");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn post_typing(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    grant: &str,
) -> (u16, Value) {
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/channels/{channel}/typing"
        ))
        .bearer_auth(token)
        .json(&json!({ "grant": grant }))
        .send()
        .await
        .expect("typing request");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

/// The subscribe callback Centrifugo sends, with the connection token's `meta`
/// forwarded verbatim (`include_connection_meta`).
async fn subscribe_proxy(
    http: &reqwest::Client,
    base: &str,
    claims: &CentrifugoConnectionClaims,
    channel: &str,
) -> Value {
    let response = http
        .post(format!("{base}/v1/centrifugo/subscribe"))
        .header(PROXY_SECRET_HEADER, TEST_PROXY_SECRET)
        .json(&json!({
            "client": Uuid::new_v4().to_string(),
            "user": claims.sub,
            "channel": channel,
            "meta": { "schema": claims.meta.schema, "token_id": claims.meta.token_id },
        }))
        .send()
        .await
        .expect("subscribe proxy callback");
    assert_eq!(
        response.status().as_u16(),
        200,
        "a proxy decision is always HTTP 200"
    );
    response.json().await.unwrap_or(Value::Null)
}

async fn connection_claims(
    http: &reqwest::Client,
    base: &str,
    token: &str,
) -> CentrifugoConnectionClaims {
    let body: Value = http
        .post(format!("{base}/v1/auth/realtime-token"))
        .bearer_auth(token)
        .send()
        .await
        .expect("realtime token")
        .json()
        .await
        .expect("realtime token body");
    let raw = body["token"].as_str().expect("token").to_string();
    let claims = jsonwebtoken::decode::<CentrifugoConnectionClaims>(
        &raw,
        &jsonwebtoken::DecodingKey::from_secret(TEST_CENT_TOKEN_HMAC.as_bytes()),
        &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256),
    )
    .expect("Centrifugo must be able to verify the connection token")
    .claims;
    assert_eq!(claims.meta.schema, REALTIME_META_SCHEMA);
    claims
}

fn assert_allowed(body: &Value) {
    assert!(
        body.get("result").is_some() && body.get("error").is_none(),
        "expected an allow envelope, got {body}"
    );
}

fn assert_denied(body: &Value, reason: &str) {
    assert!(body.get("result").is_none(), "expected a deny, got {body}");
    assert_eq!(body["error"]["code"], json!(403), "{body}");
    assert_eq!(body["error"]["message"], json!(reason), "{body}");
}

// ---------------------------------------------------------------------------
// 1 — the membership check
// ---------------------------------------------------------------------------

/// The grant route is where the whole 휘발 surface's authorization lives, so it
/// is checked the way an attacker would probe it: a workspace member who is not
/// in the channel, and a member of another tenant entirely.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn srv_t2_1_a_grant_needs_live_channel_membership() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let other = seed_tenant(&su, &app_pool).await;
    let (cent_url, _captured) = spawn_mock_centrifugo().await;
    let base = start_server(app_pool, &cent_url).await;
    let http = reqwest::Client::new();

    // (a) a live channel member gets a grant, and it describes the cadence.
    let member_token = login(&http, &base, tenant.workspace, &tenant.member_email).await;
    let (status, body) = post_grant(
        &http,
        &base,
        &member_token,
        tenant.workspace,
        tenant.channel,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["channel"],
        json!(momo_ephemeral::ephemeral_channel(
            tenant.workspace,
            tenant.channel
        )),
        "the grant names the 휘발 channel, not the message channel"
    );
    assert!(body["grant"].as_str().is_some_and(|g| !g.is_empty()));
    assert!(
        body["signalTtlMs"].as_i64().unwrap_or_default() > 0,
        "{body}"
    );
    assert!(
        body["republishIntervalMs"].as_i64().unwrap_or_default() * 2
            <= body["signalTtlMs"].as_i64().unwrap_or_default(),
        "the cadence the server publishes must survive one dropped republish: {body}"
    );

    // (b) a WORKSPACE member who is not in the channel is refused. This is the
    // assertion that separates a channel-level check from `issue_token`'s
    // workspace-level one — the outsider can mint a realtime token perfectly
    // well, and still may not signal here.
    let outsider_token = login(&http, &base, tenant.workspace, &tenant.outsider_email).await;
    let (status, body) = post_grant(
        &http,
        &base,
        &outsider_token,
        tenant.workspace,
        tenant.channel,
    )
    .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(
        body["error"]["message"],
        json!("not a member of this channel"),
        "and the refusal says nothing about whether the channel exists"
    );

    // (c) another tenant's channel, asked for under this credential's own
    // workspace id. RLS is not covering this path, so the check has to be the
    // one refusing it.
    let (status, body) =
        post_grant(&http, &base, &member_token, tenant.workspace, other.channel).await;
    assert_eq!(status, 403, "cross-tenant channel must be refused: {body}");

    // (d) …and asked for under the OTHER workspace's id, which the path/
    // credential scope check refuses first.
    let (status, body) =
        post_grant(&http, &base, &member_token, other.workspace, other.channel).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["error"]["message"], json!("workspace scope mismatch"));

    // (e) and no credential at all is a 401, not an anonymous grant.
    let anonymous = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/typing/grant",
            tenant.workspace, tenant.channel
        ))
        .send()
        .await
        .expect("anonymous grant");
    assert_eq!(anonymous.status().as_u16(), 401);
}

// ---------------------------------------------------------------------------
// 2 — the subscribe side
// ---------------------------------------------------------------------------

/// Publishing is only half the leak. If anyone could *subscribe* to
/// `typing:ws….<CH>`, they would learn who is in a channel they cannot read —
/// which is the leak ADR-0149 names. The rule must be the message channel's,
/// with no separate implementation to drift.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn srv_t2_2_the_typing_channel_subscribes_by_the_message_channels_rule() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let other = seed_tenant(&su, &app_pool).await;
    let (cent_url, _captured) = spawn_mock_centrifugo().await;
    let base = start_server(app_pool, &cent_url).await;
    let http = reqwest::Client::new();

    let ephemeral = momo_ephemeral::ephemeral_channel(tenant.workspace, tenant.channel);
    let durable = momo_messaging::cent_channel(tenant.workspace, tenant.channel);

    // The channel member may watch both rails.
    let member_token = login(&http, &base, tenant.workspace, &tenant.member_email).await;
    let member_claims = connection_claims(&http, &base, &member_token).await;
    assert_allowed(&subscribe_proxy(&http, &base, &member_claims, &durable).await);
    assert_allowed(&subscribe_proxy(&http, &base, &member_claims, &ephemeral).await);

    // The workspace outsider may watch neither, and the refusal is the same
    // sentence for both — one rule, one wording.
    let outsider_token = login(&http, &base, tenant.workspace, &tenant.outsider_email).await;
    let outsider_claims = connection_claims(&http, &base, &outsider_token).await;
    assert_denied(
        &subscribe_proxy(&http, &base, &outsider_claims, &durable).await,
        "not a member of this channel",
    );
    assert_denied(
        &subscribe_proxy(&http, &base, &outsider_claims, &ephemeral).await,
        "not a member of this channel",
    );

    // Another tenant's 휘발 channel: denied for a member of this one.
    assert_denied(
        &subscribe_proxy(
            &http,
            &base,
            &member_claims,
            &momo_ephemeral::ephemeral_channel(other.workspace, other.channel),
        )
        .await,
        "not a member of this channel",
    );
}

// ---------------------------------------------------------------------------
// 3 — nothing is written
// ---------------------------------------------------------------------------

async fn counts(su: &PgPool, workspace: Uuid, channel: Uuid) -> (i64, i64, i64) {
    let outbox: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox WHERE workspace_id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("count outbox");
    let messages: i64 = sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
        .bind(channel)
        .fetch_one(su)
        .await
        .expect("count messages");
    let last_seq: i64 =
        sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(channel)
            .fetch_one(su)
            .await
            .expect("read channel_seq");
    (outbox, messages, last_seq)
}

/// **The invariant test.** A burst of 「작성 중」 must leave the spine untouched:
/// no outbox row (invariant #3 / the ADR's whole 기각 A), no message, and no
/// `message.seq` consumed (invariant #4).
///
/// The numbers are the ADR's own worked example in miniature: one typist, one
/// channel, twelve publishes. In the naive design that would be twelve outbox
/// rows nobody ever reads.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn srv_t2_3_typing_writes_nothing_at_all() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let (cent_url, captured) = spawn_mock_centrifugo().await;
    let base = start_server(app_pool, &cent_url).await;
    let http = reqwest::Client::new();

    let token = login(&http, &base, tenant.workspace, &tenant.member_email).await;
    let (status, grant_body) =
        post_grant(&http, &base, &token, tenant.workspace, tenant.channel).await;
    assert_eq!(status, 200, "{grant_body}");
    let grant = grant_body["grant"].as_str().expect("grant").to_string();

    let before = counts(&su, tenant.workspace, tenant.channel).await;

    const BURST: usize = 12;
    for attempt in 0..BURST {
        let (status, body) = post_typing(
            &http,
            &base,
            &token,
            tenant.workspace,
            tenant.channel,
            &grant,
        )
        .await;
        assert_eq!(status, 202, "publish {attempt}: {body}");
        assert_eq!(
            body["channel"],
            json!(momo_ephemeral::ephemeral_channel(
                tenant.workspace,
                tenant.channel
            ))
        );
        assert!(
            body["expiresAtMs"].as_i64().unwrap_or_default() > 0,
            "the client is told when to forget: {body}"
        );
    }

    let after = counts(&su, tenant.workspace, tenant.channel).await;
    assert_eq!(
        after, before,
        "휘발 신호 must not touch outbox / message / channel_seq — \
         (outbox, messages, last_seq) before={before:?} after={after:?}"
    );

    // The signals did travel, so "nothing changed" is not "nothing happened".
    let publishes = captured.lock().expect("sink").clone();
    assert_eq!(publishes.len(), BURST);
    for body in &publishes {
        assert_eq!(
            body["channel"],
            json!(momo_ephemeral::ephemeral_channel(
                tenant.workspace,
                tenant.channel
            ))
        );
        assert!(
            body["data"].get("seq").is_none(),
            "a 휘발 signal must not carry a seq: {body}"
        );
    }

    // A grant minted for this channel still cannot be spent on a channel the
    // same member is not in — the publish route never re-reads the database, so
    // this is the binding doing the work.
    let foreign = Uuid::new_v4();
    let (status, body) = post_typing(&http, &base, &token, tenant.workspace, foreign, &grant).await;
    assert_eq!(status, 403, "{body}");
}
