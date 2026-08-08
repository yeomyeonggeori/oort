//! **The web client's real boot sequence, replayed against the real server** (B4).
//!
//! Every other smoke in this crate is organised by server surface. This one is
//! organised by *client*: it issues exactly the calls
//! `clients/web/src/**` makes, in the order it makes them, with the bodies it
//! sends — because the gap B4 exists to close was never a missing feature, it
//! was three surfaces that no server-side test had a reason to ask for.
//!
//! The sequence, and where each step is written on the client side:
//!
//! | # | call | client |
//! |---|---|---|
//! | 1 | `POST /v1/auth/login` | `lib/api.ts:548` |
//! | 2 | `POST /v1/auth/realtime-token` | `lib/api.ts:698` (centrifuge-js `getToken`) |
//! | 3 | Centrifugo → `POST /v1/centrifugo/subscribe` for `ch:ws….<CH>` | `lib/realtime.ts:73,736` |
//! | 4 | `GET /v1/workspaces/{ws}/channels` | `features/workspace/useWorkspace.ts:85` |
//! | 5 | `GET /v1/workspaces/{ws}/read-state` | `useWorkspace.ts:100` |
//! | 6 | `GET …/channels/{ch}/messages` | `lib/api.ts:1107` |
//! | 7 | `POST …/channels/{ch}/messages` | `lib/api.ts:1170` |
//! | 8 | `PUT …/channels/{ch}/read-state` | `lib/api.ts:1085` |
//!
//! **B4.1** adds a second sequence in the same style — the one the diff matrix
//! called the dogfooding blockers (D-1, D-7, D-2, D-3):
//!
//! | # | call | client |
//! |---|---|---|
//! | 1 | `POST /v1/auth/login` | `lib/api.ts:548` |
//! | 2 | `GET …/roster` | `lib/api.ts:784` (`useDirectory`) |
//! | 3 | `POST …/channels` | `lib/api.ts:750` (`createChannel`) |
//! | 4 | `POST …/messages` (root) → `POST …/messages` (`rootId`) → `GET …/replies` | `lib/api.ts:1170,1202,1131` |
//! | 5 | `GET /v1/workspaces/{ws}` · `PUT …/notification-pref` | `settings/api.ts:399` · mac `MomoServerRESTChatBackend.swift:684` |
//!
//! Step 3 is the one that needs saying out loud: the *client* never calls the
//! subscribe proxy — **Centrifugo does**, forwarding the connection token's
//! `meta` because `infra/centrifugo.json` sets `include_connection_meta`. So the
//! test plays Centrifugo: it verifies the connection token with the broker's
//! HMAC key (proving Centrifugo could), pulls `meta` out of it, and posts the
//! callback with the proxy secret header. Anything less would test a shape this
//! server invented rather than the one the broker sends.
//!
//! The join between the REST half and the realtime half is asserted directly:
//! the `outbox` row the send writes must name the SAME Centrifugo channel string
//! the client subscribed to in step 3. A drift there is the failure mode where
//! everything looks healthy and no message ever arrives.
//!
//! `#[ignore]` because it needs a real Postgres. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test client_rewire_smoke_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract is the one `http_smoke_pg.rs` documents: `DATABASE_URL` is a
//! superuser (migrations + fixture seeding), the server runs on `momo_app`
//! (NOBYPASSRLS), and the migration runner is re-runnable so binaries may share
//! one container.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_auth::{CentrifugoConnectionClaims, REALTIME_INFO_SCHEMA, REALTIME_META_SCHEMA};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_messaging::{cent_channel, create_channel, ChannelKind, NewChannel};
use momo_server::config::RealtimeSettings;
use momo_server::routes::realtime::PROXY_SECRET_HEADER;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (same contract as http_smoke_pg.rs)
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "client-rewire-app-signing-secret";
/// Deliberately different from the app secret: the whole point of the second key
/// is that a broker-side leak cannot mint API access tokens.
const TEST_CENT_TOKEN_HMAC: &str = "client-rewire-centrifugo-token-secret";
const TEST_PROXY_SECRET: &str = "client-rewire-proxy-shared-secret";
const TEST_PASSWORD: &str = "client-rewire-password";

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

/// Boot the real router with the realtime rail CONFIGURED — the deployed shape,
/// not the fail-closed default the unit tests exercise.
async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_realtime(RealtimeSettings {
        cent_token_hmac: Some(TEST_CENT_TOKEN_HMAC.to_string()),
        cent_proxy_secret: Some(TEST_PROXY_SECRET.to_string()),
        connection_token_ttl_seconds: momo_auth::CONNECTION_TOKEN_TTL_SECONDS,
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
    member: Uuid,
    email: String,
    /// The channel the member belongs to (created via the domain crate, so it
    /// carries its `channel_seq` row and an owner membership).
    channel: Uuid,
    /// A channel in the SAME workspace the member is NOT a member of.
    foreign_channel: Uuid,
    /// An agent member of the same workspace (B4.1): agents are members
    /// (invariant #5), so the roster must project one without a second path.
    agent: Uuid,
}

async fn seed_member(su: &PgPool, workspace: Uuid, kind: &str) -> Uuid {
    let member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, $3::member_kind, $4, $4)",
    )
    .bind(member)
    .bind(workspace)
    .bind(kind)
    .bind(member.to_string())
    .execute(su)
    .await
    .expect("seed member");
    // migration 026: workspace authority is its own row, and every read that
    // asks "are you in this workspace" goes through it.
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed workspace_membership");
    member
}

async fn seed(su: &PgPool, app: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");

    let member = seed_member(su, workspace, "human").await;
    let email = format!("{member}@rewire.test");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, password_hash) \
         VALUES ($1, $2, $3, momo_password_hash($4))",
    )
    .bind(member)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human");

    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("general-{}", Uuid::new_v4()),
            topic: Some("도그푸딩".to_string()),
            created_by: member,
        },
    )
    .await
    .expect("create channel");

    // A second member owns a channel this member never joined. It exists so the
    // subscribe proxy has something real to refuse.
    let stranger = seed_member(su, workspace, "human").await;
    let foreign = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("private-to-someone-else-{}", Uuid::new_v4()),
            topic: None,
            created_by: stranger,
        },
    )
    .await
    .expect("create foreign channel");

    // An agent member, in the member's channel. Agents are members: the roster
    // must carry it through the same projection as a human, and the channel it
    // shares is what a guest-narrowed read would (correctly) still show.
    let agent = seed_member(su, workspace, "agent").await;
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, config) \
         VALUES ($1, $2, 'hermes-agent', 'http://127.0.0.1:9/v1', \
                 '{\"capabilities\": [\"code\", \"search\", 7]}'::jsonb)",
    )
    .bind(agent)
    .bind(workspace)
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member')",
    )
    .bind(workspace)
    .bind(channel.id)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent membership");

    Fixture {
        workspace,
        member,
        email,
        channel: channel.id,
        foreign_channel: foreign.id,
        agent,
    }
}

/// Promote a member to workspace admin — channel creation is workspace
/// authority (ADR-0128), not channel authority.
async fn promote_to_admin(su: &PgPool, workspace: Uuid, member: Uuid) {
    sqlx::query(
        "UPDATE workspace_membership SET role = 'admin' \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("promote to workspace admin");
}

async fn login(http: &reqwest::Client, base: &str, fixture: &Fixture) -> Value {
    http.post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": fixture.email,
            "password": TEST_PASSWORD,
            "workspace": fixture.workspace.to_string(),
        }))
        .send()
        .await
        .expect("login")
        .json()
        .await
        .expect("login body")
}

// ---------------------------------------------------------------------------
// the client's own vocabulary
// ---------------------------------------------------------------------------

/// Verify + decode a connection token exactly as Centrifugo would: HS256 against
/// `CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY` (= `CENT_TOKEN_HMAC`).
fn decode_connection_token(token: &str, secret: &str) -> CentrifugoConnectionClaims {
    let validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
    jsonwebtoken::decode::<CentrifugoConnectionClaims>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .expect("Centrifugo must be able to verify the connection token")
    .claims
}

/// The subscribe callback Centrifugo sends: the connection's user + the token's
/// `meta`, forwarded verbatim.
async fn subscribe_proxy(
    http: &reqwest::Client,
    base: &str,
    proxy_secret: &str,
    claims: &CentrifugoConnectionClaims,
    channel: &str,
) -> (u16, Value) {
    let response = http
        .post(format!("{base}/v1/centrifugo/subscribe"))
        .header(PROXY_SECRET_HEADER, proxy_secret)
        .json(&json!({
            "client": Uuid::new_v4().to_string(),
            "user": claims.sub,
            "channel": channel,
            "meta": { "schema": claims.meta.schema, "token_id": claims.meta.token_id },
        }))
        .send()
        .await
        .expect("subscribe proxy callback");
    let status = response.status().as_u16();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    (status, body)
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
// the smoke
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_web_clients_boot_channel_and_message_sequence_round_trips() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();

    // -- 1. login (lib/api.ts:548) ----------------------------------------
    let login: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": fixture.email,
            "password": TEST_PASSWORD,
            "workspace": fixture.workspace.to_string(),
        }))
        .send()
        .await
        .expect("login")
        .json()
        .await
        .expect("login body");
    let access = login["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string();
    let realtime_ws_url = login["realtimeWebSocketUrl"]
        .as_str()
        .expect("ADR-0110: the WS address is the server's answer, never derived");
    assert!(realtime_ws_url.starts_with("ws"), "{realtime_ws_url}");

    // -- 2. realtime token (centrifuge-js getToken, lib/api.ts:698) -------
    let token_body: Value = http
        .post(format!("{base}/v1/auth/realtime-token"))
        .bearer_auth(&access)
        .send()
        .await
        .expect("realtime-token")
        .json()
        .await
        .expect("realtime token body");
    assert_eq!(token_body["tokenType"], json!("centrifugo.connection.jwt"));
    assert!(token_body["ttlSeconds"].as_i64().expect("ttlSeconds") > 0);
    assert!(
        token_body["expiresAtMs"].as_i64().expect("expiresAtMs") > 1_700_000_000_000,
        "expiresAtMs is milliseconds, not seconds: {token_body}"
    );
    let connection_token = token_body["token"].as_str().expect("token").to_string();

    // Centrifugo verifies it with ITS key, and only with its key.
    let claims = decode_connection_token(&connection_token, TEST_CENT_TOKEN_HMAC);
    assert!(
        jsonwebtoken::decode::<CentrifugoConnectionClaims>(
            &connection_token,
            &jsonwebtoken::DecodingKey::from_secret(TEST_JWT_SECRET.as_bytes()),
            &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256),
        )
        .is_err(),
        "the app JWT secret must not verify a Centrifugo connection token"
    );
    assert_eq!(claims.meta.schema, REALTIME_META_SCHEMA);
    assert!(
        claims.info.contains(REALTIME_INFO_SCHEMA),
        "info claim: {}",
        claims.info
    );
    assert_eq!(
        claims.sub.to_lowercase(),
        fixture.member.to_string(),
        "Centrifugo's user id is the member id"
    );

    // -- 3. Centrifugo asks whether this subscription is allowed ----------
    let channel_name = cent_channel(fixture.workspace, fixture.channel);
    let (status, allowed) =
        subscribe_proxy(&http, &base, TEST_PROXY_SECRET, &claims, &channel_name).await;
    assert_eq!(status, 200, "a proxy decision is always HTTP 200");
    assert_allowed(&allowed);

    // …and refuses a channel this member never joined. Same workspace, same
    // credential: only membership differs.
    let foreign_name = cent_channel(fixture.workspace, fixture.foreign_channel);
    let (_, denied) =
        subscribe_proxy(&http, &base, TEST_PROXY_SECRET, &claims, &foreign_name).await;
    assert_denied(&denied, "not a member of this channel");

    // A caller without the shared secret is not Centrifugo. This one IS an HTTP
    // error, not a deny envelope: it is a transport-level rejection.
    let forged = http
        .post(format!("{base}/v1/centrifugo/subscribe"))
        .json(&json!({"user": claims.sub, "channel": channel_name}))
        .send()
        .await
        .expect("forged callback");
    assert_eq!(
        forged.status().as_u16(),
        401,
        "network position alone must not authenticate the callback"
    );

    // An unparseable channel fails closed rather than defaulting to allow.
    let (_, garbage) = subscribe_proxy(
        &http,
        &base,
        TEST_PROXY_SECRET,
        &claims,
        "totally:not-a-momo-channel",
    )
    .await;
    assert_denied(&garbage, "unrecognized channel");

    // -- 4. channel list (useWorkspace.ts:85) -----------------------------
    let channels: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/channels",
            fixture.workspace
        ))
        .bearer_auth(&access)
        .send()
        .await
        .expect("channels")
        .json()
        .await
        .expect("channels body");
    let rows = channels["channels"].as_array().expect("channels array");
    assert_eq!(
        rows.len(),
        1,
        "the list is the caller's memberships, not the workspace's channels: {channels}"
    );
    let row = &rows[0];
    assert_eq!(row["id"], json!(fixture.channel.to_string()));
    assert_eq!(row["kind"], json!("public"));
    assert_eq!(row["muted"], json!(false), "muted is a required bool");
    assert!(
        row.get("archivedAtMs").is_none(),
        "the web sidebar filters on `archivedAtMs === undefined`: {row}"
    );
    assert_eq!(row["topic"], json!("도그푸딩"));

    // -- 5. read-state projection (useWorkspace.ts:100) -------------------
    let read_state: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/read-state",
            fixture.workspace
        ))
        .bearer_auth(&access)
        .send()
        .await
        .expect("read-state")
        .json()
        .await
        .expect("read-state body");
    let states = read_state["read_states"]
        .as_array()
        .expect("snake_case `read_states`, as lib/api.ts:1067 reads it");
    assert!(
        states
            .iter()
            .any(|entry| entry["channel_id"] == json!(fixture.channel.to_string())),
        "{read_state}"
    );

    // -- 6. history before anything was said ------------------------------
    let messages_url = format!(
        "{base}/v1/workspaces/{}/channels/{}/messages",
        fixture.workspace, fixture.channel
    );
    let empty: Value = http
        .get(&messages_url)
        .bearer_auth(&access)
        .send()
        .await
        .expect("history")
        .json()
        .await
        .expect("history body");
    assert_eq!(empty["messages"].as_array().expect("array").len(), 0);

    // -- 7. send (lib/api.ts:1170 — the composer's exact body) ------------
    let client_msg_id = Uuid::new_v4();
    let sent = http
        .post(&messages_url)
        .bearer_auth(&access)
        .json(&json!({
            "clientMsgId": client_msg_id,
            "type": "text",
            "body": "도그푸딩 첫 메시지",
        }))
        .send()
        .await
        .expect("send");
    assert_eq!(sent.status().as_u16(), 201);
    let sent: Value = sent.json().await.expect("send body");
    assert_eq!(sent["seq"], json!(1));
    assert_eq!(sent["authorMemberId"], json!(fixture.member.to_string()));

    // THE JOIN: the outbox row the send wrote must name the SAME Centrifugo
    // channel the client subscribed to in step 3. If these two ever disagree,
    // every call above still passes and no message is ever delivered.
    let published_channel: String = sqlx::query(
        "SELECT payload->>'channel' AS channel \
           FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
          ORDER BY id DESC LIMIT 1",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .expect("the send emitted exactly one broadcast outbox row")
    .try_get("channel")
    .expect("payload.channel");
    assert_eq!(
        published_channel, channel_name,
        "the relay publishes to the channel the subscribe proxy authorized"
    );

    // -- 8. advance the read cursor (lib/api.ts:1085) ---------------------
    let advanced: Value = http
        .put(format!(
            "{base}/v1/workspaces/{}/channels/{}/read-state",
            fixture.workspace, fixture.channel
        ))
        .bearer_auth(&access)
        .json(&json!({ "last_read_seq": 1 }))
        .send()
        .await
        .expect("read cursor")
        .json()
        .await
        .expect("read-state body");
    assert_eq!(advanced["last_read_seq"], json!(1));
    assert_eq!(advanced["unread_count"], json!(0));

    // -- 9. history now carries the message, and it round-trips ------------
    let page: Value = http
        .get(&messages_url)
        .bearer_auth(&access)
        .send()
        .await
        .expect("history")
        .json()
        .await
        .expect("history body");
    let listed = page["messages"].as_array().expect("array");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["body"], json!("도그푸딩 첫 메시지"));
    assert_eq!(listed[0]["state"], json!("sent"));

    // -- 10. logout cuts the realtime rail, not just REST ------------------
    // This is the property the whole `meta.token_id` binding exists for: the
    // connection token is still cryptographically valid and still inside its
    // TTL, and the subscribe must stop being authorized anyway.
    let logout = http
        .post(format!("{base}/v1/auth/logout"))
        .bearer_auth(&access)
        .json(&json!({ "refreshToken": login["refreshToken"] }))
        .send()
        .await
        .expect("logout");
    assert_eq!(logout.status().as_u16(), 200);

    let still_valid = decode_connection_token(&connection_token, TEST_CENT_TOKEN_HMAC);
    assert_eq!(still_valid.meta.token_id, claims.meta.token_id);
    let (_, after_logout) =
        subscribe_proxy(&http, &base, TEST_PROXY_SECRET, &claims, &channel_name).await;
    assert_denied(&after_logout, "realtime credential is no longer active");
}

/// **The B4.1 dogfooding sequence**, in the order a person doing internal use
/// performs it: sign in, see who is here, make a room, hold a threaded
/// conversation in it, and change a setting.
///
/// Each step is one of the blockers `docs/planning/2026-08-01-b4-contract-diff.md`
/// listed, and each assertion is written against the *client's* reading of the
/// answer rather than the server's shape — a roster row the client's validator
/// drops is worse than a 404, because the screen looks fine and every name is a
/// uuid.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_dogfooding_sequence_round_trips() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    promote_to_admin(&su, fixture.workspace, fixture.member).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();

    // -- 1. login ---------------------------------------------------------
    let login_body = login(&http, &base, &fixture).await;
    let access = login_body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string();

    // -- 2. roster (D-1) — the projection that turns a uuid into a name -----
    let roster: Value = http
        .get(format!("{base}/v1/workspaces/{}/roster", fixture.workspace))
        .bearer_auth(&access)
        .send()
        .await
        .expect("roster")
        .json()
        .await
        .expect("roster body");
    let members = roster["members"].as_array().expect("members array");
    assert_eq!(
        roster["humanCount"].as_u64().expect("humanCount"),
        2,
        "the caller and the stranger who owns the foreign channel: {roster}"
    );
    assert_eq!(roster["agentCount"].as_u64().expect("agentCount"), 1);
    // The order is kind then handle, and 'agent' sorts before 'human'.
    assert_eq!(members[0]["kind"], json!("agent"), "{roster}");

    let agent_row = members
        .iter()
        .find(|row| row["id"] == json!(fixture.agent.to_string()))
        .expect("the agent is on the roster: agents are members");
    assert_eq!(agent_row["origin"], json!("local"));
    assert_eq!(
        agent_row["capabilities"],
        json!(["code", "search"]),
        "a non-string entry in agent.config.capabilities is dropped, not rendered: {agent_row}"
    );
    assert_eq!(agent_row["agentModel"], json!("hermes-agent"));
    // Every key `isRosterMember` (lib/api.ts:91-108) requires must be present,
    // or the client silently DROPS the row and the member vanishes from the
    // timeline's name table.
    for required in [
        "id",
        "workspaceId",
        "kind",
        "status",
        "displayName",
        "handle",
        "channelCount",
        "channelIds",
        "capabilities",
        "createdAtMs",
        "updatedAtMs",
    ] {
        assert!(
            agent_row.get(required).is_some(),
            "`{required}` missing → the client drops this row: {agent_row}"
        );
    }
    let self_row = members
        .iter()
        .find(|row| row["id"] == json!(fixture.member.to_string()))
        .expect("the caller is on their own roster");
    assert_eq!(self_row["role"], json!("admin"));
    assert_eq!(
        self_row["channelCount"],
        json!(1),
        "the caller owns one channel: {self_row}"
    );

    // ?kind= narrows; an unknown kind is refused rather than widened.
    let agents_only: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/roster?kind=agent",
            fixture.workspace
        ))
        .bearer_auth(&access)
        .send()
        .await
        .expect("roster?kind=agent")
        .json()
        .await
        .expect("body");
    assert_eq!(agents_only["members"].as_array().expect("array").len(), 1);
    assert_eq!(agents_only["humanCount"], json!(0));
    let bad_kind = http
        .get(format!(
            "{base}/v1/workspaces/{}/roster?kind=robot",
            fixture.workspace
        ))
        .bearer_auth(&access)
        .send()
        .await
        .expect("roster?kind=robot");
    assert_eq!(
        bad_kind.status().as_u16(),
        400,
        "an unknown filter must not silently answer with the whole roster"
    );

    // The `/members` alias is the same handler, byte for byte.
    let alias: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/members",
            fixture.workspace
        ))
        .bearer_auth(&access)
        .send()
        .await
        .expect("members alias")
        .json()
        .await
        .expect("body");
    assert_eq!(alias, roster, "the compat alias must not drift");

    // -- 3. channel creation (D-7) ----------------------------------------
    let channels_url = format!("{base}/v1/workspaces/{}/channels", fixture.workspace);
    let created = http
        .post(&channels_url)
        .bearer_auth(&access)
        .json(&json!({ "kind": "private", "name": "dogfood", "topic": "도그푸딩 1차" }))
        .send()
        .await
        .expect("createChannel");
    assert_eq!(created.status().as_u16(), 201);
    let created: Value = created.json().await.expect("created body");
    let new_channel = created["channel"]["id"]
        .as_str()
        .expect("channel id")
        .to_string();
    assert_eq!(created["channel"]["kind"], json!("private"));
    assert_eq!(created["channel"]["muted"], json!(false));
    assert_eq!(
        created["creatorMembership"]["role"],
        json!("owner"),
        "the creator owns the channel it just made: {created}"
    );

    // The name guard is case-insensitive and answers 409, not 500.
    let duplicate = http
        .post(&channels_url)
        .bearer_auth(&access)
        .json(&json!({ "kind": "public", "name": "DOGFOOD" }))
        .send()
        .await
        .expect("duplicate");
    assert_eq!(duplicate.status().as_u16(), 409);

    // A malformed name is refused before any DB access, by name.
    let bad_name = http
        .post(&channels_url)
        .bearer_auth(&access)
        .json(&json!({ "kind": "public", "name": "-nope-" }))
        .send()
        .await
        .expect("bad name");
    assert_eq!(bad_name.status().as_u16(), 400);

    // The new channel shows up in the caller's own sidebar read — creation
    // seeded the membership, so no separate join is needed.
    let listed: Value = http
        .get(&channels_url)
        .bearer_auth(&access)
        .send()
        .await
        .expect("channels")
        .json()
        .await
        .expect("body");
    assert!(
        listed["channels"]
            .as_array()
            .expect("array")
            .iter()
            .any(|row| row["id"] == json!(new_channel)),
        "a created channel the creator cannot see is a channel that does not work: {listed}"
    );

    // -- 4. thread round trip (D-2) ---------------------------------------
    let messages_url = format!(
        "{base}/v1/workspaces/{}/channels/{}/messages",
        fixture.workspace, new_channel
    );

    // The routing probe runs BEFORE the composer opens its selector, and it
    // sends an impossible root + an impossible effort at once.
    //
    // B4.1 asserted 404 here, because this server refused `routing` outright and
    // `absent` was the true answer. **B5.3a serves routing**, so the true answer
    // flipped: the shape check runs before the transaction the root lookup lives
    // in, the probe gets a 400 naming `routing.effort`, and
    // `verdictFromSendProbe` reads `ready`. The selector it opens now works —
    // which is the only reason the verdict was allowed to change.
    // See docs/planning/2026-08-01-b4-contract-diff.md §4.1.
    let probe = http
        .post(&messages_url)
        .bearer_auth(&access)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "rootId": Uuid::new_v4(),
            "type": "text",
            "body": "",
            "routing": { "effort": "__momo-capability-probe__" },
        }))
        .send()
        .await
        .expect("probeSendRouting");
    assert_eq!(
        probe.status().as_u16(),
        400,
        "the probe must read `ready` now that routing is served"
    );
    let probe_body: Value = probe.json().await.expect("probe body");
    let probe_message = probe_body["error"]["message"]
        .as_str()
        .expect("an error sentence")
        .to_string();
    assert!(
        probe_message.to_lowercase().contains("routing"),
        "`verdictFromSendProbe` matches /routing/i to reach `ready`; without the \
         word the composer locks the selector and shows 「다시 확인」: {probe_message}"
    );

    let root = http
        .post(&messages_url)
        .bearer_auth(&access)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "type": "text",
            "body": "스레드 루트",
        }))
        .send()
        .await
        .expect("root send");
    assert_eq!(root.status().as_u16(), 201);
    let root: Value = root.json().await.expect("root body");
    let root_id = root["id"].as_str().expect("root id").to_string();
    assert!(
        root.get("thread").is_none(),
        "a root with no replies carries no rollup: {root}"
    );

    let reply = http
        .post(&messages_url)
        .bearer_auth(&access)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "rootId": root_id,
            "type": "text",
            "body": "첫 답글",
        }))
        .send()
        .await
        .expect("thread reply");
    assert_eq!(reply.status().as_u16(), 201);
    let reply: Value = reply.json().await.expect("reply body");
    assert_eq!(
        reply["rootId"].as_str().map(str::to_lowercase),
        Some(root_id.to_lowercase())
    );
    assert!(
        reply.get("thread").is_none(),
        "a reply reports no rollup of its own: {reply}"
    );

    // A reply may not hang off a reply — one level, like Slack.
    let nested = http
        .post(&messages_url)
        .bearer_auth(&access)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "rootId": reply["id"],
            "type": "text",
            "body": "2단",
        }))
        .send()
        .await
        .expect("nested reply");
    assert_eq!(nested.status().as_u16(), 400);
    let nested: Value = nested.json().await.expect("nested body");
    assert_eq!(
        nested["error"]["message"],
        json!("thread root must be a top-level message")
    );

    // The replies page reads oldest-first and reports no cursor at the end.
    let replies: Value = http
        .get(format!("{messages_url}/{root_id}/replies"))
        .bearer_auth(&access)
        .send()
        .await
        .expect("replies")
        .json()
        .await
        .expect("replies body");
    let reply_rows = replies["messages"].as_array().expect("messages array");
    assert_eq!(reply_rows.len(), 1, "{replies}");
    assert_eq!(reply_rows[0]["body"], json!("첫 답글"));
    assert!(
        replies.get("nextCursor").is_none(),
        "the client reads `nextCursor === undefined` as the end: {replies}"
    );

    // A garbage cursor is a 400: silently restarting from 0 would replay the
    // whole thread as if it were new.
    let bad_cursor = http
        .get(format!("{messages_url}/{root_id}/replies?cursor=nope"))
        .bearer_auth(&access)
        .send()
        .await
        .expect("bad cursor");
    assert_eq!(bad_cursor.status().as_u16(), 400);

    // The rollup rides the history page — the "2-hop closure" the badge needs.
    let history: Value = http
        .get(&messages_url)
        .bearer_auth(&access)
        .send()
        .await
        .expect("history")
        .json()
        .await
        .expect("history body");
    let root_row = history["messages"]
        .as_array()
        .expect("array")
        .iter()
        .find(|row| row["id"] == json!(root_id))
        .expect("the root is on the page");
    assert_eq!(
        root_row["thread"]["reply_count"],
        json!(1),
        "snake_case: threadRollup() reads `reply_count` literally: {root_row}"
    );
    assert_eq!(root_row["thread"]["last_reply_seq"], reply["seq"]);
    assert!(
        root_row["thread"]["last_reply_at"]
            .as_i64()
            .expect("last_reply_at")
            > 1_700_000_000_000,
        "the rollup timestamp is milliseconds: {root_row}"
    );

    // THE JOIN, thread edition: the reply committed TWO broadcast rows — the
    // message and the additive `thread.updated` beside it — on the same channel
    // string, and the rollup publication carries no `version` (the reply's own
    // message.new already claimed that seq as the channel version, and
    // Centrifugo drops a non-increasing one).
    let channel_string = cent_channel(
        fixture.workspace,
        Uuid::parse_str(&new_channel).expect("channel uuid"),
    );
    let thread_update: Value = sqlx::query(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->>'type' = 'thread.updated' \
          ORDER BY id DESC LIMIT 1",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .expect("the reply emitted a thread.updated broadcast")
    .try_get("payload")
    .expect("payload");
    assert_eq!(thread_update["channel"], json!(channel_string));
    assert_eq!(thread_update["data"]["payload"]["reply_count"], json!(1));
    assert!(
        thread_update.get("version").is_none(),
        "a thread.updated that re-claims the reply's seq would be dropped by the broker: \
         {thread_update}"
    );

    // -- 5. settings (D-3, the sequence minimum) ---------------------------
    let workspace_body: Value = http
        .get(format!("{base}/v1/workspaces/{}", fixture.workspace))
        .bearer_auth(&access)
        .send()
        .await
        .expect("workspace")
        .json()
        .await
        .expect("workspace body");
    assert!(
        workspace_body.get("workspace").is_some(),
        "fetchWorkspace throws without the envelope: {workspace_body}"
    );
    assert_eq!(
        workspace_body["workspace"]["id"]
            .as_str()
            .map(str::to_lowercase),
        Some(fixture.workspace.to_string())
    );
    assert!(
        workspace_body["workspace"]["updatedAtMs"]
            .as_i64()
            .expect("updatedAtMs")
            > 1_700_000_000_000,
        "the rename endpoint compares this token: {workspace_body}"
    );

    // The mute setting is per-member and it must show up in the very read the
    // sidebar makes — a `muted` that can be written and not read back is a
    // setting that appears not to work.
    let muted: Value = http
        .put(format!(
            "{base}/v1/workspaces/{}/channels/{new_channel}/notification-pref",
            fixture.workspace
        ))
        .bearer_auth(&access)
        .json(&json!({ "muted": true }))
        .send()
        .await
        .expect("mute")
        .json()
        .await
        .expect("mute body");
    assert_eq!(muted["muted"], json!(true));

    let after_mute: Value = http
        .get(&channels_url)
        .bearer_auth(&access)
        .send()
        .await
        .expect("channels")
        .json()
        .await
        .expect("body");
    let muted_row = after_mute["channels"]
        .as_array()
        .expect("array")
        .iter()
        .find(|row| row["id"] == json!(new_channel))
        .expect("the muted channel is still listed");
    assert_eq!(
        muted_row["muted"],
        json!(true),
        "muted is the CALLER's preference and must survive the round trip: {muted_row}"
    );

    // Un-muting deletes the row rather than storing `false` — absence is the
    // default, so the read must agree.
    let unmuted: Value = http
        .put(format!(
            "{base}/v1/workspaces/{}/channels/{new_channel}/notification-pref",
            fixture.workspace
        ))
        .bearer_auth(&access)
        .json(&json!({ "muted": false }))
        .send()
        .await
        .expect("unmute")
        .json()
        .await
        .expect("unmute body");
    assert_eq!(unmuted["muted"], json!(false));

    // The audit row shares the preference's transaction (ADR-0124 / momo_db::audit).
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 AND action = 'notification_pref.updated'",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .expect("audit count");
    assert_eq!(audited, 2, "both mute writes are recorded");

    // A member of the workspace who is not in the channel cannot set its
    // preference: the setting belongs to a membership, not to a workspace.
    let outsider_channel = fixture.foreign_channel;
    let refused = http
        .put(format!(
            "{base}/v1/workspaces/{}/channels/{outsider_channel}/notification-pref",
            fixture.workspace
        ))
        .bearer_auth(&access)
        .json(&json!({ "muted": true }))
        .send()
        .await
        .expect("foreign mute");
    assert_eq!(refused.status().as_u16(), 403);
}

/// **RLS, on the surfaces B4.1 added.** A tenant transaction opened for one
/// workspace must read **zero rows** of another's roster, channels and thread —
/// not fewer rows, not filtered rows, zero.
///
/// The assertions run through `momo_app` (NOBYPASSRLS), which is the only
/// faithful way to exercise the policies: the superuser that seeds the fixtures
/// would pass every one of them.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_foreign_tenants_rows_are_zero_under_the_callers_guc() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let mine = seed(&su, &app_pool).await;
    let theirs = seed(&su, &app_pool).await;

    // Give the other tenant a real thread to be invisible.
    let (their_root, their_reply_seq) =
        momo_db::with_tenant_tx(&app_pool, theirs.workspace, move |conn| {
            Box::pin(async move {
                let root = momo_messaging::send_message_with_mentions_in_tx(
                    conn,
                    theirs.workspace,
                    momo_messaging::NewMessage::text(theirs.channel, theirs.member, "그쪽 루트")
                        .with_client_msg_id(Uuid::new_v4()),
                    momo_messaging::SendExtras::default(),
                )
                .await?
                .expect("unsigned send is never rejected");
                let mut reply =
                    momo_messaging::NewMessage::text(theirs.channel, theirs.member, "그쪽 답글")
                        .with_client_msg_id(Uuid::new_v4());
                reply.root_id = Some(root.message.id);
                let sent = momo_messaging::send_message_with_mentions_in_tx(
                    conn,
                    theirs.workspace,
                    reply,
                    momo_messaging::SendExtras::default(),
                )
                .await?
                .expect("unsigned send is never rejected");
                Ok::<_, momo_db::DbError>((root.message.id, sent.message.seq))
            })
        })
        .await
        .expect("seed the other tenant's thread");
    assert!(their_reply_seq > 0);

    // Now read THEIR ids with MY GUC bound. Every count must be zero.
    let (roster, channels, replies, rollup, workspace_read) =
        momo_db::with_tenant_tx(&app_pool, mine.workspace, move |conn| {
            Box::pin(async move {
                let roster = momo_messaging::list_workspace_roster(
                    conn,
                    theirs.workspace,
                    theirs.member,
                    false,
                    None,
                    200,
                )
                .await?;
                let channels = momo_messaging::list_workspace_channels(
                    conn,
                    theirs.workspace,
                    theirs.member,
                    true,
                    200,
                )
                .await?;
                let replies = momo_messaging::list_thread_replies(
                    conn,
                    theirs.channel,
                    their_root,
                    None,
                    200,
                )
                .await?;
                let rollup = momo_messaging::fetch_thread_rollup_in_tx(conn, their_root).await?;
                let workspace_read = momo_messaging::read_workspace_for_active_member(
                    conn,
                    theirs.workspace,
                    theirs.member,
                )
                .await?;
                Ok::<_, momo_db::DbError>((roster, channels, replies, rollup, workspace_read))
            })
        })
        .await
        .expect("cross-tenant read runs; it simply must find nothing");

    assert!(
        roster.is_empty(),
        "another tenant's roster is not a narrower list, it is no list: {roster:?}"
    );
    assert!(channels.is_empty(), "{channels:?}");
    assert!(
        replies.messages.is_empty(),
        "a thread is scoped by the same policy as its channel: {:?}",
        replies.messages
    );
    assert!(replies.next_cursor.is_none());
    assert!(rollup.is_none(), "the rollup is a row too: {rollup:?}");
    assert_eq!(
        workspace_read,
        momo_messaging::WorkspaceRead::NotFound,
        "under my GUC their workspace does not exist — 404, and NOT the 403 that \
         would confirm it does"
    );

    // …and the same reads under the OWNING tenant's GUC do find rows, so the
    // zeros above are RLS and not a broken query.
    let their_roster = momo_db::with_tenant_tx(&app_pool, theirs.workspace, move |conn| {
        Box::pin(async move {
            momo_messaging::list_workspace_roster(
                conn,
                theirs.workspace,
                theirs.member,
                false,
                None,
                200,
            )
            .await
        })
    })
    .await
    .expect("their own roster");
    assert!(
        !their_roster.is_empty(),
        "the query itself works; only the tenant boundary made it empty"
    );
    assert!(mine.agent != theirs.agent);
}

/// An instance that never configured the broker must refuse to mint a connection
/// token and must refuse every proxy callback — not fall back to a guessed
/// secret. This boots the SAME router with the default (empty) realtime settings.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_unconfigured_realtime_rail_fails_closed() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;

    // Default AppState: no `with_realtime`.
    let state = AppState::new(
        app_pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, build_app(state)).await;
    });
    let base = format!("http://{address}");
    let http = reqwest::Client::new();

    let login: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": fixture.email,
            "password": TEST_PASSWORD,
            "workspace": fixture.workspace.to_string(),
        }))
        .send()
        .await
        .expect("login")
        .json()
        .await
        .expect("login body");
    let access = login["accessToken"].as_str().expect("accessToken");

    let token = http
        .post(format!("{base}/v1/auth/realtime-token"))
        .bearer_auth(access)
        .send()
        .await
        .expect("realtime-token");
    assert_eq!(
        token.status().as_u16(),
        503,
        "no CENT_TOKEN_HMAC means no connection token, not one signed with the app key"
    );

    let callback = http
        .post(format!("{base}/v1/centrifugo/subscribe"))
        .header(PROXY_SECRET_HEADER, "anything")
        .json(&json!({
            "user": fixture.member.to_string(),
            "channel": cent_channel(fixture.workspace, fixture.channel),
        }))
        .send()
        .await
        .expect("callback");
    assert_eq!(
        callback.status().as_u16(),
        401,
        "an unset CENT_PROXY_SECRET must deny, never accept any header"
    );
}
