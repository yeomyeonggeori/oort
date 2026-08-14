//! ADR-0162 증보 1 / #1368 HAP-E7 — the MCP OAuth 2.1 authorization server, end
//! to end against PostgreSQL 18.
//!
//! The real Axum router runs against a `momo_app` (NOBYPASSRLS) pool, so every
//! answer below is produced by the same path a generic OAuth client reaches over
//! HTTP. `DATABASE_URL` is a superuser URL used only for migrations and
//! fixtures. Run it through `scripts/verify_agent_port_oauth.sh` so the database
//! is isolated, owned and reclaimed.
//!
//! ## The spine
//!
//! The title constraint of #1368 is "without bearer downgrade", and three tests
//! here are that constraint rather than a feature of it:
//!
//! * [`the_static_bearer_path_is_byte_identical_with_the_flag_on_and_off`] runs
//!   the same four static-bearer requests against two servers that differ only
//!   in the OAuth flag and compares the responses byte for byte, including the
//!   `WWW-Authenticate` challenges — which are additionally pinned to frozen
//!   literals so a change on both sides cannot pass silently;
//! * [`the_three_credential_families_do_not_substitute_for_each_other`] takes
//!   each credential's secret and re-labels it as every other envelope;
//! * [`the_database_refuses_a_credential_class_its_connection_did_not_choose`]
//!   proves the invariant is in PostgreSQL, not only in Rust.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::{AgentPortConfig, AgentPortOauthConfig, RegisteredOauthClient};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "agent-port-oauth-pg-conformance-signing-secret";
const MODERN_VERSION: &str = "2026-07-28";
const PORT_PATH: &str = "/v1/mcp/agent-port";
const AUDIENCE: &str = "/v1/mcp/agent-port";
const ISSUER: &str = "https://oort.conformance.test";
const CONSENT_URL: &str = "https://app.oort.conformance.test/oauth/consent";
const CLIENT_ID: &str = "oort-conformance-client";
const REDIRECT_URI: &str = "https://client.conformance.test/callback";
const OTHER_REDIRECT_URI: &str = "https://client.conformance.test/second";
const PRM_PATH: &str = "/.well-known/oauth-protected-resource/v1/mcp/agent-port";
const ASM_PATH: &str = "/.well-known/oauth-authorization-server";

/// PKCE pair, fixed so the test is a byte-level canary rather than a
/// probabilistic one. Recomputed in [`challenge_for`] so a typo fails loudly.
const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn resource() -> String {
    format!("{ISSUER}{AUDIENCE}")
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated PostgreSQL 18 URL")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

fn required_pg_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| {
        panic!("set {name}; scripts/verify_agent_port_oauth.sh supplies private PG client env")
    })
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to the OAuth conformance DB as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(16)
        .connect_with(options.username("momo_app").password(&momo_app_password()))
        .await
        .expect("connect as momo_app after bootstrap_roles.sql")
}

fn resolve_psql() -> PathBuf {
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths) {
            let candidate = directory.join("psql");
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
    let mut ready = READY.lock().expect("schema setup mutex is healthy");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration on the OAuth conformance DB");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/e2e/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .args([
            "-h",
            &required_pg_env("PGHOST"),
            "-p",
            &required_pg_env("PGPORT"),
            "-U",
            &required_pg_env("PGUSER"),
            "-d",
        ])
        .arg(required_pg_env("PGDATABASE"))
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .env("PGPASSWORD", required_pg_env("PGPASSWORD"))
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

fn oauth_config() -> AgentPortOauthConfig {
    AgentPortOauthConfig::for_tests(
        ISSUER,
        CONSENT_URL,
        vec![RegisteredOauthClient {
            client_id: CLIENT_ID.to_string(),
            redirect_uris: vec![REDIRECT_URI.to_string(), OTHER_REDIRECT_URI.to_string()],
        }],
    )
}

async fn start_server(pool: PgPool, oauth_enabled: bool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_agent_port(AgentPortConfig {
        external_origin: None,
        window_seconds: 60,
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        hosted_delivery_enabled: false,
        oauth: if oauth_enabled {
            oauth_config()
        } else {
            AgentPortOauthConfig::default()
        },
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind OAuth conformance server");
    let address: SocketAddr = listener.local_addr().expect("OAuth server address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

/// A client that never follows a redirect: every `Location` this suite asserts
/// on is part of the contract, so following one would hide it.
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("build a non-following HTTP client")
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Fixture {
    workspace: Uuid,
    owner: Uuid,
    owner_jwt: String,
    member_jwt: String,
    oauth_agent: Uuid,
    oauth_connection: Uuid,
    static_agent: Uuid,
    static_connection: Uuid,
    static_bearer: String,
    connect_only_bearer: String,
    channel: Uuid,
}

fn raw_static_credential(workspace: Uuid) -> String {
    format!(
        "momo_agent_v1.{workspace}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

async fn seed_human(pool: &PgPool, workspace: Uuid, role: &str, label: &str) -> (Uuid, String) {
    let human = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human',$3,$4)",
    )
    .bind(human)
    .bind(workspace)
    .bind(label)
    .bind(format!("{label}-{}", human.simple()))
    .execute(pool)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(human)
    .bind(workspace)
    .bind(format!("{human}@oauth.test"))
    .execute(pool)
    .await
    .expect("seed human identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) \
         VALUES($1,$2,$3::membership_role)",
    )
    .bind(workspace)
    .bind(human)
    .bind(role)
    .execute(pool)
    .await
    .expect("seed human membership");
    let jwt = momo_auth::sign_access(human, workspace, &[], TEST_JWT_SECRET)
        .expect("sign a human App JWT")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'oauth-conformance')",
    )
    .bind(workspace)
    .bind(human)
    .bind(&jwt)
    .execute(pool)
    .await
    .expect("record the human session token");
    (human, jwt)
}

async fn seed_sentinel_agent(pool: &PgPool, workspace: Uuid, owner: Uuid, label: &str) -> Uuid {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'agent',$3,$4)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(label)
    .bind(format!("{label}-{}", agent.simple()))
    .execute(pool)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id, config) \
         VALUES($1,$2,'hosted-agent','https://hosted-agent.invalid/disabled',$3, \
                '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(owner)
    .execute(pool)
    .await
    .expect("seed sentinel agent row");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
    )
    .bind(workspace)
    .bind(agent)
    .execute(pool)
    .await
    .expect("seed agent membership");
    // Paused: ADR-0162 D6 says only a successful activation may unpause, and the
    // OAuth arm's activation is the token exchange.
    sqlx::query(
        "INSERT INTO agent_profile(agent_member_id, workspace_id, updated_by, paused) \
         VALUES($1,$2,$3,true)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(owner)
    .execute(pool)
    .await
    .expect("seed agent profile");
    agent
}

async fn seed(pool: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("oauth-{}", workspace.simple()))
        .execute(pool)
        .await
        .expect("seed workspace");

    let (owner, owner_jwt) = seed_human(pool, workspace, "owner", "Owner").await;
    let (_member, member_jwt) = seed_human(pool, workspace, "member", "Member").await;

    let oauth_agent = seed_sentinel_agent(pool, workspace, owner, "oauthagent").await;
    let static_agent = seed_sentinel_agent(pool, workspace, owner, "staticagent").await;

    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channel(id, workspace_id, kind, name) VALUES($1,$2,'public',$3)")
        .bind(channel)
        .bind(workspace)
        .bind(format!("general-{}", channel.simple()))
        .execute(pool)
        .await
        .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
        .bind(channel)
        .bind(workspace)
        .execute(pool)
        .await
        .expect("seed channel_seq");
    for member in [owner, static_agent] {
        sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
            .bind(workspace)
            .bind(channel)
            .bind(member)
            .execute(pool)
            .await
            .expect("seed membership");
    }

    // The OAuth arm's starting point: `pairing_pending`, `auth_mode='oauth'`,
    // and — per migration 073 — no pairing challenge at all.
    let oauth_connection = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,auth_mode,created_by) \
         VALUES($1,$2,$3,'pairing_pending','oauth',$4)",
    )
    .bind(oauth_connection)
    .bind(workspace)
    .bind(oauth_agent)
    .bind(owner)
    .execute(pool)
    .await
    .expect("seed oauth connection");

    // The static arm, fully active, so the no-downgrade comparison exercises a
    // real credential rather than only the unauthenticated challenges.
    let static_connection = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,auth_mode,pairing_consumed_at,detected_at, \
           detected_by,confirmed_by,confirmed_at,approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,$3,'detected','static_bearer',now(),now(),$4,$5,now(),$6, \
           ARRAY['agent:port:connect','messages:read']::text[],$5)",
    )
    .bind(static_connection)
    .bind(workspace)
    .bind(static_agent)
    .bind(static_agent)
    .bind(owner)
    .bind(vec![channel])
    .execute(pool)
    .await
    .expect("seed static connection");
    let static_bearer = raw_static_credential(workspace);
    let static_token: Uuid = sqlx::query_scalar(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, created_by) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'), \
                ARRAY['agent:port:connect','messages:read']::text[],'hosted agent port', \
                'hosted_active',$4,$5,$6) RETURNING id",
    )
    .bind(workspace)
    .bind(static_agent)
    .bind(&static_bearer)
    .bind(static_connection)
    .bind(AUDIENCE)
    .bind(owner)
    .fetch_one(pool)
    .await
    .expect("seed static hosted bearer");
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='active', active_token_id=$3, \
           proved_at=now(), proved_by=$4 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(static_connection)
    .bind(static_token)
    .bind(static_agent)
    .execute(pool)
    .await
    .expect("activate static connection");
    sqlx::query(
        "UPDATE agent_profile SET paused=false WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(workspace)
    .bind(static_agent)
    .execute(pool)
    .await
    .expect("unpause the static sentinel");

    // A generic agent bearer with no hosted binding, used as the "wrong scope"
    // arm of the byte-identity comparison.
    let connect_only_bearer = raw_static_credential(workspace);
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'), \
                ARRAY['messages:read']::text[],'generic')",
    )
    .bind(workspace)
    .bind(static_agent)
    .bind(&connect_only_bearer)
    .execute(pool)
    .await
    .expect("seed a scopeless generic bearer");

    Fixture {
        workspace,
        owner,
        owner_jwt,
        member_jwt,
        oauth_agent,
        oauth_connection,
        static_agent,
        static_connection,
        static_bearer,
        connect_only_bearer,
        channel,
    }
}

// ---------------------------------------------------------------------------
// wire helpers
// ---------------------------------------------------------------------------

fn authorize_url(base: &str, overrides: &[(&str, &str)]) -> String {
    let resource = resource();
    let mut params: Vec<(String, String)> = vec![
        ("response_type".into(), "code".into()),
        ("client_id".into(), CLIENT_ID.into()),
        ("redirect_uri".into(), REDIRECT_URI.into()),
        ("scope".into(), "agent:port:connect messages:read".into()),
        ("state".into(), "opaque-client-state".into()),
        ("code_challenge".into(), CHALLENGE.into()),
        ("code_challenge_method".into(), "S256".into()),
        ("resource".into(), resource),
    ];
    for (key, value) in overrides {
        params.retain(|(existing, _)| existing != key);
        if !value.is_empty() {
            params.push(((*key).to_string(), (*value).to_string()));
        }
    }
    let query = params
        .iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                momo_mcp::oauth::percent_encode_query_value(key),
                momo_mcp::oauth::percent_encode_query_value(value)
            )
        })
        .collect::<Vec<_>>()
        .join("&");
    format!("{base}/v1/oauth/authorize?{query}")
}

async fn authorize(
    client: &reqwest::Client,
    base: &str,
    overrides: &[(&str, &str)],
) -> (u16, String) {
    let response = client
        .get(authorize_url(base, overrides))
        .send()
        .await
        .expect("authorize responds");
    let status = response.status().as_u16();
    let location = response
        .headers()
        .get("location")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    (status, location)
}

/// Pull the `request=` envelope out of the consent redirect.
fn request_envelope(location: &str) -> String {
    let (_, query) = location
        .split_once("request=")
        .expect("consent carries a request id");
    percent_decode(query)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).expect("ascii hex");
            out.push(u8::from_str_radix(hex, 16).expect("valid percent escape"));
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).expect("decoded query value is utf-8")
}

fn query_param(location: &str, key: &str) -> Option<String> {
    let (_, query) = location.split_once('?')?;
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then(|| percent_decode(value))
    })
}

async fn decide(
    client: &reqwest::Client,
    base: &str,
    fixture: &Fixture,
    jwt: &str,
    verb: &str,
    body: Value,
) -> (u16, Value) {
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{}/oauth/authorization-requests/{verb}",
            fixture.workspace
        ))
        .bearer_auth(jwt)
        .json(&body)
        .send()
        .await
        .expect("decision responds");
    let status = response.status().as_u16();
    let value = response.json::<Value>().await.unwrap_or(Value::Null);
    (status, value)
}

async fn post_token(
    client: &reqwest::Client,
    base: &str,
    form: &[(&str, &str)],
) -> (u16, Value, Option<String>) {
    let response = client
        .post(format!("{base}/v1/oauth/token"))
        .form(form)
        .send()
        .await
        .expect("token endpoint responds");
    let status = response.status().as_u16();
    let cache = response
        .headers()
        .get("cache-control")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let value = response.json::<Value>().await.unwrap_or(Value::Null);
    (status, value, cache)
}

fn modern_body(method: &str, extra: Value) -> Value {
    let mut params = json!({
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {}
        }
    });
    for (key, value) in extra.as_object().expect("extra params are an object") {
        params
            .as_object_mut()
            .expect("params object")
            .insert(key.clone(), value.clone());
    }
    json!({"jsonrpc": "2.0", "id": "fixed-request-id", "method": method, "params": params})
}

/// One Agent Port POST reduced to the bytes that make up its contract.
///
/// `date` and `content-length` are excluded because they are not decisions; the
/// challenge header, the status and the whole body are.
async fn port_call(
    client: &reqwest::Client,
    base: &str,
    bearer: Option<&str>,
    method: &str,
    extra: Value,
) -> (u16, String, String, Vec<u8>) {
    let body = modern_body(method, extra);
    let mut request = client
        .post(format!("{base}{PORT_PATH}"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", method);
    if let Some(bearer) = bearer {
        request = request.bearer_auth(bearer);
    }
    let response = request
        .json(&body)
        .send()
        .await
        .expect("agent port responds");
    let status = response.status().as_u16();
    let challenge = response
        .headers()
        .get("www-authenticate")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let cache = response
        .headers()
        .get("cache-control")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = response.bytes().await.expect("body bytes").to_vec();
    (status, challenge, cache, bytes)
}

// ---------------------------------------------------------------------------
// full-loop helper
// ---------------------------------------------------------------------------

/// Metadata → authorize → consent → code → token. Returns the issuance body.
async fn complete_flow(
    client: &reqwest::Client,
    base: &str,
    fixture: &Fixture,
    scopes: &[&str],
) -> Value {
    let (status, location) = authorize(client, base, &[]).await;
    assert_eq!(status, 302, "authorize redirects to the consent surface");
    let envelope = request_envelope(&location);
    let (status, decision) = decide(
        client,
        base,
        fixture,
        &fixture.owner_jwt,
        "approve",
        json!({
            "request": envelope,
            "connectionId": fixture.oauth_connection,
            "approvedScopes": scopes,
            "approvedChannelIds": [fixture.channel],
        }),
    )
    .await;
    assert_eq!(status, 200, "owner approval succeeds: {decision}");
    let redirect = decision["redirectTo"]
        .as_str()
        .expect("redirectTo")
        .to_string();
    let code = query_param(&redirect, "code").expect("approval returns a code");
    let (status, body, cache) = post_token(
        client,
        base,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", &code),
            ("code_verifier", VERIFIER),
            ("redirect_uri", REDIRECT_URI),
            ("resource", &resource()),
        ],
    )
    .await;
    assert_eq!(status, 200, "token exchange succeeds: {body}");
    assert_eq!(cache.as_deref(), Some("no-store"));
    body
}

/// One fresh, approved, unconsumed authorization code.
async fn mint_code(client: &reqwest::Client, base: &str, fixture: &Fixture) -> String {
    let (_, location) = authorize(client, base, &[]).await;
    let envelope = request_envelope(&location);
    let (status, decision) = decide(
        client,
        base,
        fixture,
        &fixture.owner_jwt,
        "approve",
        json!({
            "request": envelope,
            "connectionId": fixture.oauth_connection,
            "approvedScopes": ["agent:port:connect"],
            "approvedChannelIds": [],
        }),
    )
    .await;
    assert_eq!(status, 200, "{decision}");
    query_param(decision["redirectTo"].as_str().expect("redirectTo"), "code").expect("a code")
}

// ---------------------------------------------------------------------------
// 1. disabled is indistinguishable from unimplemented
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn every_oauth_surface_is_absent_while_the_flag_is_off() {
    ensure_schema_and_roles();
    let pool = momo_app_pool().await;
    let base = start_server(pool, false).await;
    let client = client();

    for path in [PRM_PATH, ASM_PATH] {
        let response = client
            .get(format!("{base}{path}"))
            .send()
            .await
            .expect("well-known responds");
        assert_eq!(
            response.status().as_u16(),
            404,
            "{path} must not be advertised"
        );
        assert!(
            response.bytes().await.expect("body").is_empty(),
            "{path} must not answer with a document"
        );
    }
    let (status, location) = authorize(&client, &base, &[]).await;
    assert_eq!(status, 404);
    assert!(location.is_empty(), "a disabled server redirects nowhere");
    let (status, _, _) = post_token(
        &client,
        &base,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
        ],
    )
    .await;
    assert_eq!(status, 404);
    let response = client
        .post(format!("{base}/v1/oauth/revoke"))
        .form(&[("token", "x"), ("client_id", CLIENT_ID)])
        .send()
        .await
        .expect("revoke responds");
    assert_eq!(response.status().as_u16(), 404);
}

// ---------------------------------------------------------------------------
// 2. the no-downgrade spine
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_static_bearer_path_is_byte_identical_with_the_flag_on_and_off() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;
    let client = client();
    let disabled = start_server(momo_app_pool().await, false).await;
    let enabled = start_server(momo_app_pool().await, true).await;

    // Four requests that between them cover the whole static admission ladder:
    // no credential, a live credential missing the connect scope, an
    // unrecognised string, and a real hosted static bearer doing real work.
    let scenarios: Vec<(&str, Option<&str>, &str, Value)> = vec![
        ("missing", None, "server/discover", json!({})),
        (
            "insufficient",
            Some(fixture.connect_only_bearer.as_str()),
            "server/discover",
            json!({}),
        ),
        (
            "unknown",
            Some("momo_agent_v1.00000000-0000-7000-8000-000000000001.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            "server/discover",
            json!({}),
        ),
        (
            "live",
            Some(fixture.static_bearer.as_str()),
            "tools/list",
            json!({}),
        ),
    ];

    for (label, bearer, method, extra) in &scenarios {
        let off = port_call(&client, &disabled, *bearer, method, extra.clone()).await;
        let on = port_call(&client, &enabled, *bearer, method, extra.clone()).await;
        assert_eq!(off.0, on.0, "{label}: status differs with the OAuth flag");
        assert_eq!(off.1, on.1, "{label}: WWW-Authenticate differs");
        assert_eq!(off.2, on.2, "{label}: Cache-Control differs");
        assert_eq!(
            off.3, on.3,
            "{label}: response body differs with the OAuth flag"
        );
    }

    // Frozen literals, so a change applied to BOTH servers still fails here.
    // These are the exact bytes HAP-E2 sealed and HAP-E7 must not move.
    let (status, challenge, cache, _) =
        port_call(&client, &enabled, None, "server/discover", json!({})).await;
    assert_eq!(status, 401);
    assert_eq!(challenge, "Bearer scope=\"agent:port:connect\"");
    assert_eq!(cache, "private, no-store");
    let (status, challenge, _, _) = port_call(
        &client,
        &enabled,
        Some(fixture.connect_only_bearer.as_str()),
        "server/discover",
        json!({}),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(
        challenge,
        "Bearer error=\"insufficient_scope\", scope=\"agent:port:connect\""
    );

    // And the static connection is untouched by the flag being on.
    let (status, auth_mode): (String, String) = sqlx::query_as(
        "SELECT status::text, auth_mode FROM hosted_agent_connection WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.static_connection)
    .fetch_one(&super_pool)
    .await
    .expect("read the static connection");
    assert_eq!(
        (status.as_str(), auth_mode.as_str()),
        ("active", "static_bearer")
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_three_credential_families_do_not_substitute_for_each_other() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;

    let issuance = complete_flow(
        &client,
        &base,
        &fixture,
        &["agent:port:connect", "messages:read"],
    )
    .await;
    let access = issuance["access_token"]
        .as_str()
        .expect("access token")
        .to_string();
    let refresh = issuance["refresh_token"]
        .as_str()
        .expect("refresh token")
        .to_string();

    let secret_of = |envelope: &str| envelope.rsplit('.').next().unwrap_or_default().to_string();
    let relabel = |envelope: &str, prefix: &str| {
        format!("{prefix}.{}.{}", fixture.workspace, secret_of(envelope))
    };

    // The stored digest covers the whole envelope, so every re-label below
    // hashes to a value no row carries. Each of these is a distinct promotion
    // attempt: static→oauth, oauth→static, refresh→access, code→access.
    for (label, presented) in [
        (
            "static as oauth",
            relabel(&fixture.static_bearer, "momo_oauth_at_v1"),
        ),
        ("oauth as static", relabel(&access, "momo_agent_v1")),
        ("refresh as access", relabel(&refresh, "momo_oauth_at_v1")),
        ("refresh presented raw", refresh.clone()),
        ("oauth as pairing", relabel(&access, "momo_pair_v1")),
    ] {
        let (status, _, _, _) = port_call(
            &client,
            &base,
            Some(&presented),
            "server/discover",
            json!({}),
        )
        .await;
        assert_eq!(
            status, 401,
            "{label} must not authenticate at the Agent Port"
        );
    }

    // The genuine access credential does work, so the refusals above are about
    // the labels rather than about the surface being broken.
    let (status, _, _, _) = port_call(&client, &base, Some(&access), "tools/list", json!({})).await;
    assert_eq!(
        status, 200,
        "the real OAuth access credential is a principal"
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_database_refuses_a_credential_class_its_connection_did_not_choose() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;

    // A static credential on the OAuth connection.
    let error = sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'), \
                ARRAY['agent:port:connect']::text[],'x','hosted_active',$4,$5)",
    )
    .bind(fixture.workspace)
    .bind(fixture.oauth_agent)
    .bind(raw_static_credential(fixture.workspace))
    .bind(fixture.oauth_connection)
    .bind(AUDIENCE)
    .execute(&super_pool)
    .await
    .expect_err("a static credential on an oauth connection must be refused");
    assert!(
        error
            .to_string()
            .contains("static hosted credential on a oauth connection"),
        "unexpected refusal: {error}"
    );

    // And an OAuth credential on the static connection.
    let error = sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, expires_at, \
                           oauth_client_id, oauth_request_id) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'), \
                ARRAY['agent:port:connect']::text[],'x','hosted_oauth_access',$4,$5, \
                now() + interval '1 hour',$6,$7)",
    )
    .bind(fixture.workspace)
    .bind(fixture.static_agent)
    .bind(raw_static_credential(fixture.workspace))
    .bind(fixture.static_connection)
    .bind(AUDIENCE)
    .bind(CLIENT_ID)
    .bind(Uuid::new_v4())
    .execute(&super_pool)
    .await
    .expect_err("an oauth credential on a static connection must be refused");
    assert!(
        error
            .to_string()
            .contains("oauth hosted credential on a static_bearer connection"),
        "unexpected refusal: {error}"
    );
}

// ---------------------------------------------------------------------------
// 3. metadata truthfulness and issuer/resource stability
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn metadata_names_the_configured_issuer_and_no_unimplemented_capability() {
    ensure_schema_and_roles();
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;

    // Every header a proxy or a caller could use to move the identity.
    let prm: Value = client
        .get(format!("{base}{PRM_PATH}"))
        .header("host", "evil.example")
        .header("x-forwarded-host", "evil.example")
        .header("x-forwarded-proto", "http")
        .header("forwarded", "host=evil.example;proto=http")
        .send()
        .await
        .expect("protected resource metadata responds")
        .json()
        .await
        .expect("PRM is JSON");
    assert_eq!(prm["resource"], json!(resource()));
    assert_eq!(prm["authorization_servers"], json!([ISSUER]));
    assert_eq!(prm["bearer_methods_supported"], json!(["header"]));
    assert_eq!(
        prm["scopes_supported"],
        json!(momo_auth::HOSTED_AGENT_SCOPES)
    );

    let asm: Value = client
        .get(format!("{base}{ASM_PATH}"))
        .header("host", "evil.example")
        .header("x-forwarded-host", "evil.example")
        .send()
        .await
        .expect("authorization server metadata responds")
        .json()
        .await
        .expect("ASM is JSON");
    assert_eq!(asm["issuer"], json!(ISSUER));
    assert_eq!(
        asm["authorization_endpoint"],
        json!(format!("{ISSUER}/v1/oauth/authorize"))
    );
    assert_eq!(
        asm["token_endpoint"],
        json!(format!("{ISSUER}/v1/oauth/token"))
    );
    assert_eq!(
        asm["revocation_endpoint"],
        json!(format!("{ISSUER}/v1/oauth/revoke"))
    );
    assert_eq!(asm["code_challenge_methods_supported"], json!(["S256"]));
    assert_eq!(
        asm["grant_types_supported"],
        json!(["authorization_code", "refresh_token"])
    );
    assert_eq!(
        asm["token_endpoint_auth_methods_supported"],
        json!(["none"])
    );
    assert_eq!(
        asm["authorization_response_iss_parameter_supported"],
        json!(true)
    );
    let rendered = asm.to_string();
    for absent in [
        "registration_endpoint",
        "client_id_metadata_document",
        "client_secret",
        "introspection_endpoint",
        "\"plain\"",
    ] {
        assert!(
            !rendered.contains(absent),
            "{absent} must not be advertised"
        );
    }
    assert_eq!(CHALLENGE, challenge_for(VERIFIER), "PKCE fixture drifted");
}

// ---------------------------------------------------------------------------
// 4. the authorization request
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn authorize_refuses_an_unregistered_client_or_redirect_without_redirecting() {
    ensure_schema_and_roles();
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;

    for overrides in [
        vec![("client_id", "not-registered")],
        vec![("client_id", "")],
        vec![("redirect_uri", "https://attacker.example/steal")],
        vec![("redirect_uri", "https://client.conformance.test/callback/")],
        vec![(
            "redirect_uri",
            "https://client.conformance.test/callback?x=1",
        )],
        vec![("redirect_uri", "")],
    ] {
        let (status, location) = authorize(&client, &base, &overrides).await;
        assert_eq!(status, 400, "{overrides:?} must be a plain refusal");
        assert!(
            location.is_empty(),
            "{overrides:?} must not send the browser anywhere"
        );
    }
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn authorize_fails_closed_on_every_downgrade_shaped_parameter() {
    ensure_schema_and_roles();
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;

    for (overrides, expected) in [
        (vec![("code_challenge_method", "plain")], "invalid_request"),
        (vec![("code_challenge_method", "")], "invalid_request"),
        (vec![("code_challenge", "short")], "invalid_request"),
        (
            vec![("response_type", "token")],
            "unsupported_response_type",
        ),
        (vec![("resource", "")], "invalid_target"),
        (
            vec![("resource", "https://evil.example/v1/mcp/agent-port")],
            "invalid_target",
        ),
        (
            vec![(
                "resource",
                "https://oort.conformance.test/v1/mcp/agent-port/",
            )],
            "invalid_target",
        ),
        (
            vec![("scope", "agent:port:connect work:control")],
            "invalid_scope",
        ),
        (
            vec![("scope", "agent:port:connect realtime:subscribe")],
            "invalid_scope",
        ),
        (
            vec![("scope", "agent:port:connect provider:quota:write")],
            "invalid_scope",
        ),
        (vec![("scope", "messages:read")], "invalid_scope"),
        (vec![("scope", "")], "invalid_scope"),
    ] {
        let (status, location) = authorize(&client, &base, &overrides).await;
        assert_eq!(status, 302, "{overrides:?} answers as an error redirect");
        assert!(
            location.starts_with(&format!("{REDIRECT_URI}?")),
            "{overrides:?} must redirect only to the registered URI: {location}"
        );
        assert_eq!(
            query_param(&location, "error").as_deref(),
            Some(expected),
            "{overrides:?} error code"
        );
        assert_eq!(query_param(&location, "iss").as_deref(), Some(ISSUER));
        assert!(query_param(&location, "code").is_none());
    }
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn authorize_hands_the_browser_only_a_server_minted_request_id() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;

    let (status, location) = authorize(&client, &base, &[]).await;
    assert_eq!(status, 302);
    assert!(
        location.starts_with(&format!("{CONSENT_URL}?request=")),
        "unexpected consent redirect: {location}"
    );
    for forbidden in [
        "code_verifier",
        "access_token",
        "refresh_token",
        "client_secret",
        "momo_agent_v1",
        "momo_oauth_at_v1",
        "momo_oauth_code_v1",
    ] {
        assert!(
            !location.contains(forbidden),
            "{forbidden} leaked into the consent URL"
        );
    }
    // Nothing was written: an unauthenticated endpoint must not be able to grow
    // the ledger.
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_oauth_authorization_request WHERE workspace_id = $1",
    )
    .bind(fixture.workspace)
    .fetch_one(&super_pool)
    .await
    .expect("count authorization requests");
    assert_eq!(pending, 0, "authorize must write nothing");

    let envelope = request_envelope(&location);
    let claims = momo_auth::verify_authorization_request(
        &momo_auth::hosted_oauth_request_key(TEST_JWT_SECRET),
        &envelope,
    )
    .expect("the envelope verifies under the derived key");
    assert_eq!(claims.cid, CLIENT_ID);
    assert_eq!(claims.ru, REDIRECT_URI);
    assert_eq!(claims.res, resource());
    assert_eq!(claims.cc, CHALLENGE);
    assert_eq!(claims.ccm, "S256");
    assert_eq!(claims.st.as_deref(), Some("opaque-client-state"));
}

// ---------------------------------------------------------------------------
// 5. resource-owner consent
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn only_a_logged_in_owner_or_admin_can_decide_and_the_rest_is_non_enumerable() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;
    let (_, location) = authorize(&client, &base, &[]).await;
    let envelope = request_envelope(&location);
    let body = json!({
        "request": envelope,
        "connectionId": fixture.oauth_connection,
        "approvedScopes": ["agent:port:connect"],
        "approvedChannelIds": [],
    });

    // An ordinary member gets the same answer as a nonexistent request.
    let (status, _) = decide(
        &client,
        &base,
        &fixture,
        &fixture.member_jwt,
        "approve",
        body.clone(),
    )
    .await;
    assert_eq!(status, 404, "an ordinary member must not consent");

    // A hosted agent bearer is not a human at all.
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{}/oauth/authorization-requests/approve",
            fixture.workspace
        ))
        .bearer_auth(&fixture.static_bearer)
        .json(&body)
        .send()
        .await
        .expect("agent decision responds");
    assert!(
        matches!(response.status().as_u16(), 401 | 403),
        "a hosted agent bearer must not reach the consent surface"
    );

    // A cross-workspace path is refused before anything is read.
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{}/oauth/authorization-requests/approve",
            Uuid::new_v4()
        ))
        .bearer_auth(&fixture.owner_jwt)
        .json(&body)
        .send()
        .await
        .expect("cross-workspace decision responds");
    assert!(matches!(response.status().as_u16(), 403 | 404));

    let decided: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_oauth_authorization_request WHERE workspace_id = $1",
    )
    .bind(fixture.workspace)
    .fetch_one(&super_pool)
    .await
    .expect("count decisions");
    assert_eq!(decided, 0, "no refused decision may leave a row");
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn exactly_one_terminal_decision_survives_duplicate_submission() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;
    let (_, location) = authorize(&client, &base, &[]).await;
    let envelope = request_envelope(&location);
    let body = json!({
        "request": envelope,
        "connectionId": fixture.oauth_connection,
        "approvedScopes": ["agent:port:connect", "messages:read"],
        "approvedChannelIds": [fixture.channel],
    });

    let (status, first) = decide(
        &client,
        &base,
        &fixture,
        &fixture.owner_jwt,
        "approve",
        body.clone(),
    )
    .await;
    assert_eq!(status, 200, "{first}");
    let (status, _) = decide(
        &client,
        &base,
        &fixture,
        &fixture.owner_jwt,
        "approve",
        body.clone(),
    )
    .await;
    assert_eq!(status, 409, "a duplicate approve is inert");
    let (status, _) = decide(
        &client,
        &base,
        &fixture,
        &fixture.owner_jwt,
        "deny",
        body.clone(),
    )
    .await;
    assert_eq!(status, 409, "a late deny cannot undo a terminal approval");

    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_oauth_authorization_request WHERE workspace_id=$1",
    )
    .bind(fixture.workspace)
    .fetch_one(&super_pool)
    .await
    .expect("count decisions");
    assert_eq!(rows, 1, "exactly one terminal decision");

    // The connection advanced to `detected` with the human recorded, and the
    // sentinel is still paused: consent is not activation.
    let (status, confirmed_by, paused): (String, Uuid, bool) = sqlx::query_as(
        "SELECT hc.status::text, hc.confirmed_by, ap.paused \
           FROM hosted_agent_connection hc \
           JOIN agent_profile ap ON ap.workspace_id=hc.workspace_id \
                                AND ap.agent_member_id=hc.agent_member_id \
          WHERE hc.workspace_id=$1 AND hc.id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.oauth_connection)
    .fetch_one(&super_pool)
    .await
    .expect("read the oauth connection");
    assert_eq!(status, "detected");
    assert_eq!(confirmed_by, fixture.owner);
    assert!(
        paused,
        "the dedicated agent stays paused until the exchange"
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_denial_opens_no_authority_and_returns_a_standard_error_redirect() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;
    let (_, location) = authorize(&client, &base, &[]).await;
    let envelope = request_envelope(&location);

    let (status, decision) = decide(
        &client,
        &base,
        &fixture,
        &fixture.owner_jwt,
        "deny",
        json!({"request": envelope, "connectionId": fixture.oauth_connection}),
    )
    .await;
    assert_eq!(status, 200, "{decision}");
    let redirect = decision["redirectTo"].as_str().expect("redirectTo");
    assert!(redirect.starts_with(&format!("{REDIRECT_URI}?")));
    assert_eq!(
        query_param(redirect, "error").as_deref(),
        Some("access_denied")
    );
    assert_eq!(
        query_param(redirect, "state").as_deref(),
        Some("opaque-client-state")
    );
    assert_eq!(query_param(redirect, "iss").as_deref(), Some(ISSUER));
    assert!(query_param(redirect, "code").is_none());

    let (status, credentials): (String, i64) = sqlx::query_as(
        "SELECT hc.status::text, \
                (SELECT count(*) FROM token t WHERE t.workspace_id=hc.workspace_id \
                   AND t.hosted_connection_id=hc.id) \
           FROM hosted_agent_connection hc WHERE hc.workspace_id=$1 AND hc.id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.oauth_connection)
    .fetch_one(&super_pool)
    .await
    .expect("read the denied connection");
    assert_eq!(
        status, "pairing_pending",
        "a denial leaves the connection alone"
    );
    assert_eq!(credentials, 0, "a denial mints nothing");
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_approval_outside_the_hosted_ceiling_is_refused_and_audited_before_any_code() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;
    let (_, location) = authorize(&client, &base, &[]).await;
    let envelope = request_envelope(&location);

    for scopes in [
        json!(["agent:port:connect", "work:control"]),
        json!(["agent:port:connect", "realtime:subscribe"]),
        json!(["agent:port:connect", "provider:quota:write"]),
        // Inside the ceiling but never requested: consent cannot widen a grant.
        json!(["agent:port:connect", "messages:write"]),
    ] {
        let (status, _) = decide(
            &client,
            &base,
            &fixture,
            &fixture.owner_jwt,
            "approve",
            json!({
                "request": envelope,
                "connectionId": fixture.oauth_connection,
                "approvedScopes": scopes,
                "approvedChannelIds": [fixture.channel],
            }),
        )
        .await;
        assert_eq!(status, 400, "{scopes} must be refused");
    }
    // Missing the mandatory reachability scope is refused too.
    let (status, _) = decide(
        &client,
        &base,
        &fixture,
        &fixture.owner_jwt,
        "approve",
        json!({
            "request": envelope,
            "connectionId": fixture.oauth_connection,
            "approvedScopes": ["messages:read"],
            "approvedChannelIds": [fixture.channel],
        }),
    )
    .await;
    assert_eq!(status, 400, "agent:port:connect is mandatory");

    let denials: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 \
           AND action='hosted_agent.oauth.scope_denied'",
    )
    .bind(fixture.workspace)
    .fetch_one(&super_pool)
    .await
    .expect("count scope denials");
    assert_eq!(
        denials, 4,
        "every approval outside the ceiling OR outside the request leaves one bounded audit"
    );

    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 \
           AND action LIKE 'hosted_agent.oauth.%' \
           AND (detail::text LIKE '%momo_oauth%' OR detail::text LIKE '%verifier%' \
                OR detail::text LIKE '%hash%')",
    )
    .bind(fixture.workspace)
    .fetch_one(&super_pool)
    .await
    .expect("scan audits for secrets");
    assert_eq!(leaked, 0, "no OAuth audit may carry a secret or a digest");

    let codes: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_oauth_authorization_request \
           WHERE workspace_id = $1 AND code_hash IS NOT NULL",
    )
    .bind(fixture.workspace)
    .fetch_one(&super_pool)
    .await
    .expect("count issued codes");
    assert_eq!(codes, 0, "a refused approval mints no code");
}

// ---------------------------------------------------------------------------
// 6. the token exchange and its attack matrix
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_exchange_activates_the_connection_and_binds_the_credential() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;

    let issuance = complete_flow(
        &client,
        &base,
        &fixture,
        &["agent:port:connect", "messages:read"],
    )
    .await;
    assert_eq!(issuance["token_type"], json!("Bearer"));
    assert_eq!(issuance["scope"], json!("agent:port:connect messages:read"));
    assert_eq!(issuance["expires_in"], json!(1800));
    let access = issuance["access_token"].as_str().expect("access token");
    assert!(access.starts_with("momo_oauth_at_v1."));
    assert!(issuance["refresh_token"]
        .as_str()
        .expect("refresh token")
        .starts_with("momo_oauth_rt_v1."));

    let (status, paused, class, audience, scopes): (String, bool, String, String, Vec<String>) =
        sqlx::query_as(
            "SELECT hc.status::text, ap.paused, t.credential_class, t.audience, t.scopes \
               FROM hosted_agent_connection hc \
               JOIN token t ON t.workspace_id=hc.workspace_id AND t.id=hc.active_token_id \
               JOIN agent_profile ap ON ap.workspace_id=hc.workspace_id \
                                    AND ap.agent_member_id=hc.agent_member_id \
              WHERE hc.workspace_id=$1 AND hc.id=$2",
        )
        .bind(fixture.workspace)
        .bind(fixture.oauth_connection)
        .fetch_one(&super_pool)
        .await
        .expect("read the activated connection");
    assert_eq!(status, "active");
    assert!(
        !paused,
        "the exchange unpauses the sentinel in the same transaction"
    );
    assert_eq!(class, "hosted_oauth_access");
    assert_eq!(audience, AUDIENCE);
    assert_eq!(scopes, vec!["agent:port:connect", "messages:read"]);

    // Only digests at rest.
    let raw: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM token WHERE workspace_id=$1 AND encode(token_hash,'escape') LIKE '%momo_oauth%'",
    )
    .bind(fixture.workspace)
    .fetch_one(&super_pool)
    .await
    .expect("scan token rows");
    assert_eq!(raw, 0, "no raw credential is stored");
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_exchange_attack_matrix_fails_closed() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;

    let resource = resource();
    let code = mint_code(&client, &base, &fixture).await;
    let matrix: Vec<(&str, Vec<(&str, String)>)> = vec![
        (
            "wrong verifier",
            vec![(
                "code_verifier",
                "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFy".to_string(),
            )],
        ),
        ("empty verifier", vec![("code_verifier", String::new())]),
        (
            "plain verifier equals challenge",
            vec![("code_verifier", CHALLENGE.to_string())],
        ),
        (
            "wrong redirect",
            vec![("redirect_uri", OTHER_REDIRECT_URI.to_string())],
        ),
        (
            "unregistered redirect",
            vec![("redirect_uri", "https://attacker.example/cb".to_string())],
        ),
        (
            "wrong resource",
            vec![(
                "resource",
                "https://evil.example/v1/mcp/agent-port".to_string(),
            )],
        ),
        ("absent resource", vec![("resource", String::new())]),
        (
            "unregistered client",
            vec![("client_id", "not-registered".to_string())],
        ),
        (
            "cross workspace code",
            vec![(
                "code",
                format!("momo_oauth_code_v1.{}.{}", Uuid::new_v4(), "a".repeat(43)),
            )],
        ),
        (
            "unknown grant type",
            vec![("grant_type", "password".to_string())],
        ),
    ];

    for (label, overrides) in matrix {
        let mut form: Vec<(String, String)> = vec![
            ("grant_type".into(), "authorization_code".into()),
            ("client_id".into(), CLIENT_ID.into()),
            ("code".into(), code.clone()),
            ("code_verifier".into(), VERIFIER.into()),
            ("redirect_uri".into(), REDIRECT_URI.into()),
            ("resource".into(), resource.clone()),
        ];
        for (key, value) in overrides {
            form.retain(|(existing, _)| existing != key);
            if !value.is_empty() {
                form.push((key.to_string(), value));
            }
        }
        let borrowed: Vec<(&str, &str)> = form
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        let (status, body, _) = post_token(&client, &base, &borrowed).await;
        assert!(
            (400..=401).contains(&status),
            "{label} must be refused, got {status} {body}"
        );
        assert!(
            body.get("error").is_some(),
            "{label} answers a standard OAuth error: {body}"
        );
        assert_eq!(
            body.as_object().map(|object| object.len()),
            Some(1),
            "{label} error body carries only a code: {body}"
        );
    }

    // Nothing above consumed the code, so the honest exchange still works.
    let (status, body, _) = post_token(
        &client,
        &base,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", &code),
            ("code_verifier", VERIFIER),
            ("redirect_uri", REDIRECT_URI),
            ("resource", &resource),
        ],
    )
    .await;
    assert_eq!(status, 200, "the honest exchange still succeeds: {body}");

    // And replaying it revokes the family it minted.
    let (status, body, _) = post_token(
        &client,
        &base,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", &code),
            ("code_verifier", VERIFIER),
            ("redirect_uri", REDIRECT_URI),
            ("resource", &resource),
        ],
    )
    .await;
    assert_eq!(status, 400, "a replayed code is refused: {body}");
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM token WHERE workspace_id=$1 AND hosted_connection_id=$2 \
           AND credential_class IN ('hosted_oauth_access','hosted_oauth_refresh') \
           AND revoked_at IS NULL",
    )
    .bind(fixture.workspace)
    .bind(fixture.oauth_connection)
    .fetch_one(&super_pool)
    .await
    .expect("count live credentials");
    assert_eq!(live, 0, "a code replay revokes the whole family");
    let replays: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id=$1 \
           AND action='hosted_agent.oauth.credential_replayed'",
    )
    .bind(fixture.workspace)
    .fetch_one(&super_pool)
    .await
    .expect("count replay audits");
    assert_eq!(replays, 1);
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_expired_authorization_code_is_refused() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;
    let (_, location) = authorize(&client, &base, &[]).await;
    let envelope = request_envelope(&location);
    let (_, decision) = decide(
        &client,
        &base,
        &fixture,
        &fixture.owner_jwt,
        "approve",
        json!({
            "request": envelope,
            "connectionId": fixture.oauth_connection,
            "approvedScopes": ["agent:port:connect"],
            "approvedChannelIds": [],
        }),
    )
    .await;
    let code =
        query_param(decision["redirectTo"].as_str().expect("redirectTo"), "code").expect("a code");
    sqlx::query(
        "UPDATE hosted_oauth_authorization_request SET code_expires_at = now() - interval '1 second' \
          WHERE workspace_id = $1",
    )
    .bind(fixture.workspace)
    .execute(&super_pool)
    .await
    .expect("age the code");

    let (status, body, _) = post_token(
        &client,
        &base,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", &code),
            ("code_verifier", VERIFIER),
            ("redirect_uri", REDIRECT_URI),
            ("resource", &resource()),
        ],
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], json!("invalid_grant"));
    let status: String = sqlx::query_scalar(
        "SELECT status::text FROM hosted_agent_connection WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.oauth_connection)
    .fetch_one(&super_pool)
    .await
    .expect("read connection");
    assert_eq!(status, "detected", "an expired code does not activate");
}

// ---------------------------------------------------------------------------
// 7. refresh rotation, reuse detection, revocation
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn refresh_rotates_and_reuse_retires_the_family() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;
    let first = complete_flow(&client, &base, &fixture, &["agent:port:connect"]).await;
    let first_access = first["access_token"].as_str().expect("access").to_string();
    let first_refresh = first["refresh_token"]
        .as_str()
        .expect("refresh")
        .to_string();

    let (status, second, cache) = post_token(
        &client,
        &base,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", &first_refresh),
            ("resource", &resource()),
        ],
    )
    .await;
    assert_eq!(status, 200, "{second}");
    assert_eq!(cache.as_deref(), Some("no-store"));
    let second_access = second["access_token"].as_str().expect("access").to_string();
    let second_refresh = second["refresh_token"]
        .as_str()
        .expect("refresh")
        .to_string();
    assert_ne!(
        first_access, second_access,
        "rotation mints a new access credential"
    );
    assert_ne!(
        first_refresh, second_refresh,
        "rotation mints a new refresh credential"
    );

    // The superseded access credential stops working immediately.
    let (status, _, _, _) = port_call(
        &client,
        &base,
        Some(&first_access),
        "server/discover",
        json!({}),
    )
    .await;
    assert_eq!(status, 401, "the rotated-away access credential is dead");
    let (status, _, _, _) = port_call(
        &client,
        &base,
        Some(&second_access),
        "tools/list",
        json!({}),
    )
    .await;
    assert_eq!(status, 200, "the current access credential works");

    // Reuse of the rotated-away refresh credential is a compromise signal.
    let (status, body, _) = post_token(
        &client,
        &base,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", &first_refresh),
            ("resource", &resource()),
        ],
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], json!("invalid_grant"));
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM token WHERE workspace_id=$1 AND hosted_connection_id=$2 \
           AND credential_class IN ('hosted_oauth_access','hosted_oauth_refresh') \
           AND revoked_at IS NULL",
    )
    .bind(fixture.workspace)
    .bind(fixture.oauth_connection)
    .fetch_one(&super_pool)
    .await
    .expect("count live credentials");
    assert_eq!(live, 0, "refresh reuse retires every live credential");
    let (status, _, _, _) = port_call(
        &client,
        &base,
        Some(&second_access),
        "server/discover",
        json!({}),
    )
    .await;
    assert_eq!(
        status, 401,
        "the surviving access credential is retired too"
    );

    // A refresh credential from another client id is not an existence oracle.
    let (status, body, _) = post_token(
        &client,
        &base,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", "not-registered"),
            ("refresh_token", &second_refresh),
            ("resource", &resource()),
        ],
    )
    .await;
    assert_eq!(status, 401, "{body}");
    assert_eq!(body["error"], json!("invalid_client"));
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn revocation_retires_both_halves_and_is_never_an_existence_oracle() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;
    let issuance = complete_flow(&client, &base, &fixture, &["agent:port:connect"]).await;
    let access = issuance["access_token"]
        .as_str()
        .expect("access")
        .to_string();
    let refresh = issuance["refresh_token"]
        .as_str()
        .expect("refresh")
        .to_string();

    let revoke = |token: String| {
        let client = client.clone();
        let base = base.clone();
        async move {
            client
                .post(format!("{base}/v1/oauth/revoke"))
                .form(&[("token", token.as_str()), ("client_id", CLIENT_ID)])
                .send()
                .await
                .expect("revoke responds")
                .status()
                .as_u16()
        }
    };

    // An unknown token, a foreign-shaped token and a real one all answer 200.
    assert_eq!(revoke("not-a-credential".to_string()).await, 200);
    assert_eq!(
        revoke(format!(
            "momo_oauth_at_v1.{}.{}",
            Uuid::new_v4(),
            "a".repeat(43)
        ))
        .await,
        200
    );
    assert_eq!(revoke(access.clone()).await, 200);

    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM token WHERE workspace_id=$1 AND hosted_connection_id=$2 \
           AND revoked_at IS NULL",
    )
    .bind(fixture.workspace)
    .bind(fixture.oauth_connection)
    .fetch_one(&super_pool)
    .await
    .expect("count live credentials");
    assert_eq!(live, 0, "revoking access retires the refresh half too");

    let (status, _, _, _) =
        port_call(&client, &base, Some(&access), "server/discover", json!({})).await;
    assert_eq!(status, 401);
    let (status, body, _) = post_token(
        &client,
        &base,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", &refresh),
            ("resource", &resource()),
        ],
    )
    .await;
    assert_eq!(status, 400, "{body}");
}

// ---------------------------------------------------------------------------
// 8. the credential is a principal only at the Agent Port
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_oauth_credential_is_not_a_principal_on_any_generic_rest_route() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;
    let issuance = complete_flow(
        &client,
        &base,
        &fixture,
        &["agent:port:connect", "messages:read"],
    )
    .await;
    let access = issuance["access_token"]
        .as_str()
        .expect("access")
        .to_string();

    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id=$1")
        .bind(fixture.workspace)
        .fetch_one(&super_pool)
        .await
        .expect("count messages");

    let workspace = fixture.workspace;
    let agent = fixture.oauth_agent;
    let channel = fixture.channel;
    let attempts: Vec<(&str, String, Option<Value>)> = vec![
        (
            "POST",
            format!("{base}/v1/workspaces/{workspace}/channels/{channel}/messages"),
            Some(json!({"body": "hello", "idempotencyKey": Uuid::new_v4().to_string()})),
        ),
        (
            "GET",
            format!("{base}/v1/workspaces/{workspace}/agents/{agent}/gateway/jobs/pending"),
            None,
        ),
        (
            "POST",
            format!(
                "{base}/v1/workspaces/{workspace}/agents/{agent}/gateway/jobs/{}/lease/renew",
                Uuid::new_v4()
            ),
            Some(json!({})),
        ),
        (
            "POST",
            format!(
                "{base}/v1/workspaces/{workspace}/agent-runs/{}/gateway/complete",
                Uuid::new_v4()
            ),
            Some(json!({"status": "completed"})),
        ),
        (
            "POST",
            format!("{base}/v1/auth/realtime-token"),
            Some(json!({})),
        ),
    ];
    for (method, url, body) in attempts {
        let mut request = match method {
            "GET" => client.get(&url),
            _ => client.post(&url),
        };
        request = request.bearer_auth(&access);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.expect("generic REST responds");
        assert!(
            matches!(response.status().as_u16(), 401 | 403),
            "{method} {url} admitted an OAuth credential with {}",
            response.status()
        );
    }

    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id=$1")
        .bind(fixture.workspace)
        .fetch_one(&super_pool)
        .await
        .expect("count messages");
    assert_eq!(before, after, "no generic REST attempt may mutate anything");

    // The same credential is a full principal at the canonical resource.
    let (status, _, _, body) =
        port_call(&client, &base, Some(&access), "tools/list", json!({})).await;
    assert_eq!(status, 200);
    let listed: Value = serde_json::from_slice(&body).expect("tools/list JSON");
    let names: Vec<String> = listed["result"]["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .map(|tool| tool["name"].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(
        names.contains(&"oort_conversation_read".to_string()),
        "the approved messages:read scope opens exactly its tool: {names:?}"
    );
    assert!(
        !names.contains(&"oort_message_post".to_string()),
        "an unapproved scope opens nothing: {names:?}"
    );
}

// ---------------------------------------------------------------------------
// 9. the admin API still refuses to hand anyone an `oauth` connection
// ---------------------------------------------------------------------------

/// ADR-0162's "UI/API가 아직 구현되지 않은 `oauth`를 선택하거나 자동 fallback하지
/// 않는다", proved with the authorization server **switched on**.
///
/// HAP-E7 builds the authorization server; #1360/#1369 build the wizard that
/// creates an `oauth` connection and walks a person through consent. Until that
/// lands, `POST .../hosted-agent-connections` refuses `authMode: "oauth"`
/// unconditionally — the flag does not widen it — so there is no way for a
/// client to obtain an OAuth connection it could not then complete.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_admin_api_refuses_an_oauth_connection_even_with_the_server_enabled() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;

    let before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM hosted_agent_connection WHERE workspace_id = $1")
            .bind(fixture.workspace)
            .fetch_one(&super_pool)
            .await
            .expect("count connections");

    for auth_mode in ["oauth", "OAUTH", "oauth ", "static_bearer_or_oauth"] {
        let response = client
            .post(format!(
                "{base}/v1/workspaces/{}/hosted-agent-connections",
                fixture.workspace
            ))
            .bearer_auth(&fixture.owner_jwt)
            .json(&json!({
                "displayName": "Hosted",
                "handle": format!("h{}", Uuid::new_v4().simple()),
                "authMode": auth_mode,
            }))
            .send()
            .await
            .expect("create responds");
        assert_eq!(
            response.status().as_u16(),
            400,
            "authMode {auth_mode:?} must be refused"
        );
    }

    let after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM hosted_agent_connection WHERE workspace_id = $1")
            .bind(fixture.workspace)
            .fetch_one(&super_pool)
            .await
            .expect("count connections");
    assert_eq!(
        before, after,
        "a refused create leaves no connection behind"
    );
}

// ---------------------------------------------------------------------------
// 10. tenancy
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn authorization_requests_are_invisible_across_the_tenant_boundary() {
    ensure_schema_and_roles();
    let super_pool = superuser_pool().await;
    let fixture = seed(&super_pool).await;
    let client = client();
    let base = start_server(momo_app_pool().await, true).await;
    complete_flow(&client, &base, &fixture, &["agent:port:connect"]).await;

    let app_pool = momo_app_pool().await;
    let mine: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_oauth_authorization_request WHERE workspace_id = $1",
    )
    .bind(fixture.workspace)
    .fetch_one(&mut *set_tenant(&app_pool, fixture.workspace).await)
    .await
    .expect("read own authorization requests");
    assert_eq!(mine, 1);

    let theirs: i64 = sqlx::query_scalar("SELECT count(*) FROM hosted_oauth_authorization_request")
        .fetch_one(&mut *set_tenant(&app_pool, Uuid::new_v4()).await)
        .await
        .expect("read a foreign tenant");
    assert_eq!(theirs, 0, "FORCE RLS hides another workspace's requests");
}

async fn set_tenant(pool: &PgPool, workspace: Uuid) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    let mut conn = pool.acquire().await.expect("acquire a momo_app connection");
    sqlx::query("SELECT set_config('app.workspace_id', $1::text, false)")
        .bind(workspace)
        .execute(&mut *conn)
        .await
        .expect("bind the tenant GUC");
    conn
}
