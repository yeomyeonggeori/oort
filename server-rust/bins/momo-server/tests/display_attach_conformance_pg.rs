//! DB-backed conformance for **LIVE-1**: the ADR-0165 display-attach capability
//! plane, its host-signed binding publish, and the `remote_display_available`
//! projection.
//!
//! `#[ignore]` because each needs a real Postgres. Run through the verifier
//! (`scripts/verify_display_attach.sh`), or directly:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test display_attach_conformance_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract is `reattach_smoke_pg.rs`'s: `DATABASE_URL` is a
//! **superuser** (migrations + fixture seeding), the server runs as `momo_app`
//! (NOBYPASSRLS, so the RLS policies actually apply), and the schema/roles step
//! is re-runnable.
//!
//! ## What each test goes red on
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `live1_1_a_screen_is_published_by_its_own_host_and_nobody_else` | drop the signer pin in `publish_binding_in_tx`, accept a human bearer, or let a second binding overwrite the first |
//! | `live1_2_display_grants_are_observer_only_and_fail_closed` | serve `mode=controller`, mint for a host that never advertised `display_attach`, or let a display bearer validate on the PTY route |
//! | `live1_3_availability_and_the_observer_count_agree_everywhere` | forget `remote_display_available` in any one of the three projections, or split the observer count per kind |
//! | `live1_4_revocation_reaches_a_live_stream` | cache the validation verdict, or stop re-joining `work_host`/`observation` on re-validation |
//!
//! ## What is deliberately NOT here
//!
//! No socket is opened by any test in this file, because no socket is opened by
//! the server. The signalling handshake, the ICE exchange and the media are the
//! sandbox's, and the closest this suite gets to them is asserting that the
//! server tells the producer `input_enabled: false` (ADR-0165 D4). The
//! peer-to-peer half is proved separately and honestly by
//! `scripts/display_signaling_probe.py`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "live1-display-attach-signing-secret";
const TEST_PASSWORD: &str = "live1-display-attach-password";
const DISPLAY_ID: &str = "display-live1";
const DISPLAY_ENDPOINT: &str = "wss://sandbox.live1.invalid/display/signal";
const PTY_ID: &str = "pty-live1";
const ATTACH_ENDPOINT: &str = "wss://sandbox.live1.invalid/attach/pty";

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

async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
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
    owner_email: String,
    /// A workspace member who IS in the session's channel — the ordinary
    /// teammate 관전 exists for.
    watcher: Uuid,
    watcher_email: String,
    /// A workspace member who is deliberately **not** in the session's channel.
    outsider_email: String,
    channel: Uuid,
}

async fn seed_member(su: &PgPool, workspace: Uuid, label: &str) -> (Uuid, String) {
    let member = Uuid::new_v4();
    let email = format!("{member}@{label}.live1.test");
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

async fn seed(su: &PgPool, app: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");

    let (owner, owner_email) = seed_member(su, workspace, "owner").await;
    let (watcher, watcher_email) = seed_member(su, workspace, "watcher").await;
    let (_outsider, outsider_email) = seed_member(su, workspace, "outsider").await;

    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("live1-{}", Uuid::new_v4()),
            topic: None,
            created_by: owner,
        },
    )
    .await
    .expect("create channel");

    // The watcher joins; the outsider does not. That difference is the whole
    // observer gate.
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member')",
    )
    .bind(workspace)
    .bind(channel.id)
    .bind(watcher)
    .execute(su)
    .await
    .expect("seed channel membership");

    Fixture {
        workspace,
        owner,
        owner_email,
        watcher,
        watcher_email,
        outsider_email,
        channel: channel.id,
    }
}

/// A throwaway Ed25519 keypair for the "workd". The private half never leaves
/// this test, exactly as it never leaves a real daemon.
fn workd_keypair() -> ([u8; 32], String) {
    let mut seed = [0u8; 32];
    seed[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    seed[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    let public = ed25519_dalek::SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes();
    (seed, BASE64.encode(public))
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

/// Register a workd host over REST and return `(host_id, signing_seed)`.
///
/// `display_capable` is the axis every fail-closed assertion below turns on: a
/// host that does not advertise `display_attach` is a host with no screen, and
/// that is exactly the shape a BYOC box has (momo never images one, so nothing
/// on it ever advertises).
async fn register_host(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    display_capable: bool,
) -> (String, [u8; 32]) {
    let (seed, public_key) = workd_keypair();
    let mut capabilities = json!({ "terminal_attach": true });
    if display_capable {
        capabilities["display_attach"] = json!(true);
    }
    let response = http
        .post(format!("{base}/v1/workspaces/{workspace}/work-hosts"))
        .bearer_auth(token)
        .json(&json!({
            "scope": "workspace",
            "type": "workd",
            "displayName": "live1 sandbox",
            "publicKey": public_key,
            "capabilities": capabilities,
        }))
        .send()
        .await
        .expect("register work host");
    assert_eq!(response.status(), 201, "the host is registered");
    let body: Value = response.json().await.expect("host body");
    (
        body["workHost"]["id"]
            .as_str()
            .expect("workHost.id")
            .to_string(),
        seed,
    )
}

/// Create a work session over REST and return its id.
async fn create_session(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    host: &str,
) -> Uuid {
    let response = http
        .post(format!("{base}/v1/workspaces/{workspace}/work-sessions"))
        .bearer_auth(token)
        .json(&json!({
            "channelId": channel.to_string(),
            "hostId": host,
            "tool": "claude",
            "label": "live1 display spectate",
        }))
        .send()
        .await
        .expect("create work session");
    assert_eq!(response.status(), 201, "the session is created");
    let body: Value = response.json().await.expect("session body");
    Uuid::parse_str(body["workSession"]["id"].as_str().expect("id")).expect("session uuid")
}

/// Send a `MomoHost`-signed POST, the way a real workd does.
async fn signed_host_post(
    http: &reqwest::Client,
    base: &str,
    seed: &[u8; 32],
    workspace: Uuid,
    host_id: &str,
    path: &str,
    body: &Value,
) -> reqwest::Response {
    let raw = serde_json::to_vec(body).expect("serialize the signed body");
    let digest = momo_wire::signing::sha256_hex(&raw);
    let request_id = Uuid::new_v4();
    let sent_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    let payload = momo_wire::signing::request_payload(
        "POST",
        path,
        workspace,
        Uuid::parse_str(host_id).expect("host uuid"),
        sent_at_ms,
        &digest,
        request_id,
    );
    let signature = momo_wire::signing::sign_base64(seed, &payload).expect("sign");

    http.post(format!("{base}{path}"))
        .header("Authorization", format!("MomoHost {host_id}"))
        .header("X-Momo-Work-Host-Sent-At", sent_at_ms.to_string())
        .header("X-Momo-Work-Host-Signature", signature)
        .header("X-Momo-Work-Host-Request-ID", request_id.to_string())
        .header("Content-Type", "application/json")
        .body(raw)
        .send()
        .await
        .expect("signed host request")
}

fn binding_path(workspace: Uuid, session: Uuid) -> String {
    format!("/v1/workspaces/{workspace}/work-sessions/{session}/display-binding")
}

fn display_body() -> Value {
    json!({ "displayId": DISPLAY_ID, "displayEndpoint": DISPLAY_ENDPOINT })
}

/// Publish the display binding through the signed route and require 204.
async fn publish_display(
    http: &reqwest::Client,
    base: &str,
    seed: &[u8; 32],
    workspace: Uuid,
    host_id: &str,
    session: Uuid,
) {
    let response = signed_host_post(
        http,
        base,
        seed,
        workspace,
        host_id,
        &binding_path(workspace, session),
        &display_body(),
    )
    .await;
    assert_eq!(
        response.status(),
        204,
        "the owning host publishes its own screen"
    );
}

/// Bind the PTY pair directly, the way `reattach_smoke_pg` does: the route that
/// writes those two columns is the work-host-signed `PATCH …/work-sessions/{s}`
/// arm, which this server still refuses by name. The display pair, notably, does
/// **not** need this shortcut any more — LIVE-1 ported its publish path, which
/// is why every display assertion below goes through real HTTP.
async fn bind_pty(su: &PgPool, session: Uuid) {
    let updated =
        sqlx::query("UPDATE work_session SET pty_id = $2, attach_endpoint = $3 WHERE id = $1")
            .bind(session)
            .bind(PTY_ID)
            .bind(ATTACH_ENDPOINT)
            .execute(su)
            .await
            .expect("bind the remote PTY")
            .rows_affected();
    assert_eq!(updated, 1);
}

async fn issue_display_capability(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    session: Uuid,
    body: Option<Value>,
) -> reqwest::Response {
    let request = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session}/display-attach"
        ))
        .bearer_auth(token);
    match body {
        Some(body) => request.json(&body),
        None => request,
    }
    .send()
    .await
    .expect("issue display capability")
}

async fn validate_display(
    http: &reqwest::Client,
    base: &str,
    seed: &[u8; 32],
    workspace: Uuid,
    host_id: &str,
    token: &str,
    stream: bool,
) -> reqwest::Response {
    signed_host_post(
        http,
        base,
        seed,
        workspace,
        host_id,
        &format!("/v1/workspaces/{workspace}/work-hosts/{host_id}/display-attach/validate"),
        &json!({ "capability_token": token, "stream": stream }),
    )
    .await
}

// ---------------------------------------------------------------------------
// live1-1 — a screen is published by its own host, once, and by nobody else
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live1_1_a_screen_is_published_by_its_own_host_and_nobody_else() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let token = login(&http, &base, workspace, &fixture.owner_email).await;
    let (host_id, host_seed) = register_host(&http, &base, &token, workspace, true).await;
    let (other_host_id, other_seed) = register_host(&http, &base, &token, workspace, true).await;
    let session = create_session(&http, &base, &token, workspace, fixture.channel, &host_id).await;

    // ---- a human bearer may not say what is on a machine's screen ----------
    let response = http
        .post(format!("{base}{}", binding_path(workspace, session)))
        .bearer_auth(&token)
        .json(&display_body())
        .send()
        .await
        .expect("human publish attempt");
    assert_eq!(
        response.status(),
        403,
        "publishing a binding is a claim about a machine; only the machine makes it"
    );

    // The same refusal on the two human session paths, by name rather than as a
    // silent drop (ADR-0134 D1).
    let created = http
        .post(format!("{base}/v1/workspaces/{workspace}/work-sessions"))
        .bearer_auth(&token)
        .json(&json!({
            "channelId": fixture.channel.to_string(),
            "hostId": host_id,
            "tool": "claude",
            "label": "smuggled",
            "displayId": DISPLAY_ID,
            "displayEndpoint": DISPLAY_ENDPOINT,
        }))
        .send()
        .await
        .expect("create with a display binding");
    assert_eq!(created.status(), 400);
    let body: Value = created.json().await.expect("error body");
    assert_eq!(
        body["error"]["message"], "display binding requires work host signature",
        "refused by name, so a client is told what it asked for"
    );

    // ---- a host may not publish onto another host's session ----------------
    let response = signed_host_post(
        &http,
        &base,
        &other_seed,
        workspace,
        &other_host_id,
        &binding_path(workspace, session),
        &display_body(),
    )
    .await;
    assert_eq!(
        response.status(),
        403,
        "the signer pin: a registered host is not thereby authorised over every \
         session in the workspace"
    );

    // ---- the owning host publishes, and republishing is idempotent ---------
    publish_display(&http, &base, &host_seed, workspace, &host_id, session).await;
    publish_display(&http, &base, &host_seed, workspace, &host_id, session).await;

    // ---- a *different* binding is a conflict, not an overwrite -------------
    let response = signed_host_post(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        &binding_path(workspace, session),
        &json!({
            "displayId": "display-usurper",
            "displayEndpoint": DISPLAY_ENDPOINT,
        }),
    )
    .await;
    assert_eq!(response.status(), 409);

    // ---- a credentialed signalling URL never enters the ledger -------------
    for bad in [
        json!({"displayId": DISPLAY_ID, "displayEndpoint": "wss://user:pw@host.invalid/s"}),
        json!({"displayId": DISPLAY_ID, "displayEndpoint": "wss://host.invalid/s?token=1"}),
        json!({"displayId": DISPLAY_ID, "displayEndpoint": "ws://host.invalid/s"}),
        json!({"displayId": "-bad", "displayEndpoint": DISPLAY_ENDPOINT}),
    ] {
        let response = signed_host_post(
            &http,
            &base,
            &host_seed,
            workspace,
            &host_id,
            &binding_path(workspace, session),
            &bad,
        )
        .await;
        assert_eq!(
            response.status(),
            400,
            "the endpoint grammar is 023's, and it is checked before the lock"
        );
    }

    // The ledger holds exactly the first binding, and the audit row names the
    // host rather than a person.
    let stored: (String, String) =
        sqlx::query_as("SELECT display_id, display_endpoint FROM work_session WHERE id = $1")
            .bind(session)
            .fetch_one(&su)
            .await
            .expect("read the stored binding");
    assert_eq!(
        stored,
        (DISPLAY_ID.to_string(), DISPLAY_ENDPOINT.to_string())
    );

    let audits: Vec<(Option<Uuid>, Option<Uuid>, Value)> = sqlx::query_as(
        "SELECT actor_member_id, via_token_id, detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'work.display_binding.published'",
    )
    .bind(workspace)
    .fetch_all(&su)
    .await
    .expect("read binding audit");
    assert_eq!(
        audits.len(),
        1,
        "a republish writes no second row — it changed nothing"
    );
    let (actor, via_token, detail) = &audits[0];
    assert!(
        actor.is_none() && via_token.is_none(),
        "a host is not a member; naming its owning human would record that a \
         person did something they did not"
    );
    assert_eq!(detail["host_id"], json!(host_id));
    assert_eq!(detail["display_id"], json!(DISPLAY_ID));
}

// ---------------------------------------------------------------------------
// live1-2 — observer only, and closed unless a host said otherwise
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live1_2_display_grants_are_observer_only_and_fail_closed() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let owner_token = login(&http, &base, workspace, &fixture.owner_email).await;
    let watcher_token = login(&http, &base, workspace, &fixture.watcher_email).await;
    let outsider_token = login(&http, &base, workspace, &fixture.outsider_email).await;

    // A host that never advertised a display — the shape a BYOC box has.
    let (blind_host, blind_seed) =
        register_host(&http, &base, &owner_token, workspace, false).await;
    let blind_session = create_session(
        &http,
        &base,
        &owner_token,
        workspace,
        fixture.channel,
        &blind_host,
    )
    .await;

    // It cannot even publish: a binding that sits in the ledger while every
    // capability request 409s would be two surfaces disagreeing about one box.
    let response = signed_host_post(
        &http,
        &base,
        &blind_seed,
        workspace,
        &blind_host,
        &binding_path(workspace, blind_session),
        &display_body(),
    )
    .await;
    assert_eq!(response.status(), 409, "no advertisement, no screen");

    // Even with a binding forced past the route, issuance stays closed — the
    // advertisement is re-read on every mint, so an operator who re-registers a
    // box without the flag closes it.
    sqlx::query("UPDATE work_session SET display_id = $2, display_endpoint = $3 WHERE id = $1")
        .bind(blind_session)
        .bind(DISPLAY_ID)
        .bind(DISPLAY_ENDPOINT)
        .execute(&su)
        .await
        .expect("force a binding the route would have refused");
    let response =
        issue_display_capability(&http, &base, &watcher_token, workspace, blind_session, None)
            .await;
    assert_eq!(
        response.status(),
        409,
        "fail-closed: the host capability is a clause of issuance, not a \
         consequence of the binding"
    );

    // ---- the ordinary, advertised host ------------------------------------
    let (host_id, host_seed) = register_host(&http, &base, &owner_token, workspace, true).await;
    let session = create_session(
        &http,
        &base,
        &owner_token,
        workspace,
        fixture.channel,
        &host_id,
    )
    .await;

    // Before a binding exists there is nothing to watch.
    let response =
        issue_display_capability(&http, &base, &watcher_token, workspace, session, None).await;
    assert_eq!(response.status(), 409);

    publish_display(&http, &base, &host_seed, workspace, &host_id, session).await;

    // ---- the boundary ADR-0004 증보 3 is holding ---------------------------
    let response = issue_display_capability(
        &http,
        &base,
        &owner_token,
        workspace,
        session,
        Some(json!({ "mode": "controller" })),
    )
    .await;
    assert_eq!(
        response.status(),
        403,
        "control is not this batch's to grant, and the owner is not an exception"
    );
    let body: Value = response.json().await.expect("error body");
    assert_eq!(
        body["error"]["message"],
        "display attach is view-only; controller mode is not available"
    );

    // ---- who may watch ----------------------------------------------------
    let response =
        issue_display_capability(&http, &base, &outsider_token, workspace, session, None).await;
    assert_eq!(
        response.status(),
        403,
        "the observer gate is the existing one: channel membership, verbatim"
    );

    let response =
        issue_display_capability(&http, &base, &watcher_token, workspace, session, None).await;
    assert_eq!(response.status(), 200);
    let grant: Value = response.json().await.expect("grant body");
    assert_eq!(grant["display_endpoint"], json!(DISPLAY_ENDPOINT));
    assert_eq!(grant["display_id"], json!(DISPLAY_ID));
    assert_eq!(grant["mode"], json!("observer"));
    let capability = grant["capability_token"]
        .as_str()
        .expect("token")
        .to_string();
    assert!(capability.starts_with("momo_terminal_attach_v1."));

    // ---- the producer validates, and is told not to open input ------------
    let response = validate_display(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        &capability,
        false,
    )
    .await;
    assert_eq!(response.status(), 200);
    let validated: Value = response.json().await.expect("validation body");
    assert_eq!(validated["display_id"], json!(DISPLAY_ID));
    assert_eq!(validated["work_session_id"], json!(session.to_string()));
    assert_eq!(validated["mode"], json!("observer"));
    assert_eq!(
        validated["input_enabled"],
        json!(false),
        "ADR-0165 D4: view-only is a datachannel that is never opened, and this \
         is the server stating that to the only process that can honour it"
    );

    // ---- the two kinds do not lend each other authority -------------------
    let response = signed_host_post(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        &format!("/v1/workspaces/{workspace}/work-hosts/{host_id}/terminal-attach/validate"),
        &json!({ "capability_token": capability }),
    )
    .await;
    assert_eq!(
        response.status(),
        401,
        "a display bearer is not a terminal bearer, even on the same box"
    );

    bind_pty(&su, session).await;
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session}/terminal-attach"
        ))
        .bearer_auth(&watcher_token)
        .json(&json!({ "mode": "observer" }))
        .send()
        .await
        .expect("issue a pty observer grant");
    assert_eq!(response.status(), 200);
    let pty_grant: Value = response.json().await.expect("pty grant");
    let pty_capability = pty_grant["capability_token"].as_str().expect("token");
    let response = validate_display(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        pty_capability,
        false,
    )
    .await;
    assert_eq!(
        response.status(),
        401,
        "and the reverse: a terminal bearer opens no screen"
    );

    // ---- the ledger says what kind each row is ----------------------------
    let kinds: Vec<(String, String)> = sqlx::query_as(
        "SELECT kind, mode FROM terminal_attach_capability \
          WHERE work_session_id = $1 ORDER BY kind",
    )
    .bind(session)
    .fetch_all(&su)
    .await
    .expect("read capability kinds");
    assert_eq!(
        kinds,
        vec![
            ("display".to_string(), "observer".to_string()),
            ("pty".to_string(), "observer".to_string()),
        ]
    );

    // ---- 075's CHECK is the lock, not this route's politeness -------------
    let forced = sqlx::query(
        "INSERT INTO terminal_attach_capability \
           (workspace_id, work_session_id, host_id, owner_member_id, token_hash, \
            expires_at, mode, kind) \
         VALUES ($1, $2, (SELECT host_id FROM work_session WHERE id = $2), $3, \
                 digest('forced', 'sha256'), clock_timestamp() + interval '60 seconds', \
                 'controller', 'display')",
    )
    .bind(workspace)
    .bind(session)
    .bind(fixture.owner)
    .execute(&su)
    .await;
    assert!(
        forced.is_err(),
        "terminal_attach_display_observer_ck makes a controllable screen \
         unrepresentable — the boundary survives a route being rewritten"
    );
}

// ---------------------------------------------------------------------------
// live1-3 — availability and the observer count agree on every surface
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live1_3_availability_and_the_observer_count_agree_everywhere() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let owner_token = login(&http, &base, workspace, &fixture.owner_email).await;
    let watcher_token = login(&http, &base, workspace, &fixture.watcher_email).await;
    let (host_id, host_seed) = register_host(&http, &base, &owner_token, workspace, true).await;
    let session = create_session(
        &http,
        &base,
        &owner_token,
        workspace,
        fixture.channel,
        &host_id,
    )
    .await;

    // Three readers of the same row. The projection is composed from one
    // definition, and this is the runtime half of that guarantee.
    let read_all = |token: String| {
        let http = http.clone();
        let base = base.clone();
        async move {
            let list: Value = http
                .get(format!(
                    "{base}/v1/workspaces/{workspace}/work-sessions?active=1"
                ))
                .bearer_auth(&token)
                .send()
                .await
                .expect("list")
                .json()
                .await
                .expect("list body");
            let reattach: Value = http
                .get(format!(
                    "{base}/v1/workspaces/{workspace}/work-sessions/{session}/reattach"
                ))
                .bearer_auth(&token)
                .send()
                .await
                .expect("reattach")
                .json()
                .await
                .expect("reattach body");
            let ended: Value = http
                .patch(format!(
                    "{base}/v1/workspaces/{workspace}/work-sessions/{session}"
                ))
                .bearer_auth(&token)
                .json(&json!({ "status": "ended" }))
                .send()
                .await
                .expect("end")
                .json()
                .await
                .expect("end body");
            (list, reattach, ended)
        }
    };

    // Before any binding: three surfaces, three falses.
    let listed: Value = http
        .get(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions?active=1"
        ))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("list")
        .json()
        .await
        .expect("list body");
    let row = listed["workSessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .find(|row| {
            row["id"]
                .as_str()
                .unwrap()
                .eq_ignore_ascii_case(&session.to_string())
        })
        .expect("our session")
        .clone();
    assert_eq!(row["remoteDisplayAvailable"], json!(false));
    assert_eq!(row["remoteAttachAvailable"], json!(false));
    // The raw signalling URL is never in a session read — only beside the
    // capability that authorises dialling it.
    assert!(row.get("displayEndpoint").is_none());
    assert!(row.get("attachEndpoint").is_none());

    publish_display(&http, &base, &host_seed, workspace, &host_id, session).await;

    // One observer, then the count every surface publishes.
    let response =
        issue_display_capability(&http, &base, &watcher_token, workspace, session, None).await;
    assert_eq!(response.status(), 200);

    let listed: Value = http
        .get(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions?active=1"
        ))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("list")
        .json()
        .await
        .expect("list body");
    let row = listed["workSessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .find(|row| {
            row["id"]
                .as_str()
                .unwrap()
                .eq_ignore_ascii_case(&session.to_string())
        })
        .expect("our session")
        .clone();
    assert_eq!(row["remoteDisplayAvailable"], json!(true));
    assert_eq!(
        row["remoteAttachAvailable"],
        json!(false),
        "a screen is not a terminal — the two booleans are independent, and a \
         client that folded them would offer 이어서 쓰기 on a session with no PTY"
    );
    assert_eq!(
        row["observerGrantCount"],
        json!(1),
        "the count is kind-blind: someone watching the screen is watching"
    );

    let reattach: Value = http
        .get(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session}/reattach"
        ))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("reattach")
        .json()
        .await
        .expect("reattach body");
    assert_eq!(
        reattach["workSession"]["remoteDisplayAvailable"],
        json!(true)
    );
    assert_eq!(
        reattach["verdict"],
        json!("replay_only"),
        "ADR-0139 D3 still speaks only about the terminal: a live screen with no \
         PTY is not something to 이어서 쓰다"
    );

    // The count-only envelope, unchanged and unduplicated.
    let envelopes: Vec<Value> = sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 \
            AND payload->'data'->>'type' = 'work.session.observer'",
    )
    .bind(workspace)
    .fetch_all(&su)
    .await
    .expect("read observer envelopes");
    assert_eq!(envelopes.len(), 1, "one grant, one event");
    let payload = &envelopes[0]["data"]["payload"];
    let mut keys: Vec<&str> = payload
        .as_object()
        .expect("payload")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec!["observer_count", "session_id"],
        "count-only: a display grant does not widen what leaves the workspace"
    );
    assert_eq!(payload["observer_count"], json!(1));

    // The third reader is the `RETURNING` projection on the end path.
    let (_list, _reattach, ended) = read_all(owner_token.clone()).await;
    assert_eq!(ended["workSession"]["status"], json!("ended"));
    assert_eq!(
        ended["workSession"]["remoteDisplayAvailable"],
        json!(true),
        "the RETURNING projection answers the same question as the other two"
    );
}

// ---------------------------------------------------------------------------
// live1-4 — revocation reaches a stream that is already open
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live1_4_revocation_reaches_a_live_stream() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let owner_token = login(&http, &base, workspace, &fixture.owner_email).await;
    let watcher_token = login(&http, &base, workspace, &fixture.watcher_email).await;
    let (host_id, host_seed) = register_host(&http, &base, &owner_token, workspace, true).await;
    let session = create_session(
        &http,
        &base,
        &owner_token,
        workspace,
        fixture.channel,
        &host_id,
    )
    .await;
    publish_display(&http, &base, &host_seed, workspace, &host_id, session).await;

    let issue = |token: String| {
        let http = http.clone();
        let base = base.clone();
        async move {
            let response =
                issue_display_capability(&http, &base, &token, workspace, session, None).await;
            assert_eq!(response.status(), 200);
            let body: Value = response.json().await.expect("grant body");
            body["capability_token"]
                .as_str()
                .expect("token")
                .to_string()
        }
    };

    // ---- the owner closes observation --------------------------------------
    let capability = issue(watcher_token.clone()).await;
    // `stream: true` is the producer re-checking a peer connection it already
    // serves. It relaxes expiry and ONLY expiry, so everything below still bites.
    let response = validate_display(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        &capability,
        true,
    )
    .await;
    assert_eq!(response.status(), 200, "the stream is live");

    sqlx::query("UPDATE work_session SET observation = 'owner_only' WHERE id = $1")
        .bind(session)
        .execute(&su)
        .await
        .expect("close observation");
    let response = validate_display(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        &capability,
        true,
    )
    .await;
    assert_eq!(
        response.status(),
        401,
        "closing observation cuts a screen that is already open — the verdict is \
         a fresh join every time, never a cached one"
    );

    // And the owner is refused too, because display has no controller grade.
    // Named here rather than left to be discovered: on the PTY side the owner
    // reaches an owner_only session as controller, and on this side that door
    // does not exist yet (ADR-0004 증보 3).
    let response =
        issue_display_capability(&http, &base, &owner_token, workspace, session, None).await;
    assert_eq!(response.status(), 403);

    sqlx::query("UPDATE work_session SET observation = 'open' WHERE id = $1")
        .bind(session)
        .execute(&su)
        .await
        .expect("reopen observation");

    // ---- the watcher leaves the channel ------------------------------------
    let capability = issue(watcher_token.clone()).await;
    sqlx::query(
        "UPDATE membership SET left_at = clock_timestamp() \
          WHERE workspace_id = $1 AND channel_id = $2 AND member_id = $3",
    )
    .bind(workspace)
    .bind(fixture.channel)
    .bind(fixture.watcher)
    .execute(&su)
    .await
    .expect("leave the channel");
    let response = validate_display(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        &capability,
        true,
    )
    .await;
    assert_eq!(
        response.status(),
        401,
        "leaving the channel ends the stream, not just the next request for one"
    );
    sqlx::query(
        "UPDATE membership SET left_at = NULL \
          WHERE workspace_id = $1 AND channel_id = $2 AND member_id = $3",
    )
    .bind(workspace)
    .bind(fixture.channel)
    .bind(fixture.watcher)
    .execute(&su)
    .await
    .expect("rejoin the channel");

    // ---- the operator withdraws the host's display advertisement -----------
    let capability = issue(watcher_token.clone()).await;
    sqlx::query(
        "UPDATE work_host SET capabilities = capabilities - 'display_attach' WHERE id = $1",
    )
    .bind(Uuid::parse_str(&host_id).expect("host uuid"))
    .execute(&su)
    .await
    .expect("withdraw the display advertisement");
    let response = validate_display(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        &capability,
        true,
    )
    .await;
    assert_eq!(
        response.status(),
        401,
        "the advertisement is a clause of the authorization join, so withdrawing \
         it closes every live screen on the box within one re-validation period"
    );

    // ---- and nothing above put a frame, an endpoint or a bearer anywhere ---
    let leaks: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE workspace_id = $1 \
            AND (payload::text LIKE '%' || $2 || '%' OR payload::text LIKE '%' || $3 || '%')",
    )
    .bind(workspace)
    .bind(DISPLAY_ENDPOINT)
    .bind(&capability)
    .fetch_one(&su)
    .await
    .expect("scan the outbox");
    assert_eq!(
        leaks, 0,
        "the signalling endpoint and the bearer leave through exactly one door: \
         the capability response"
    );

    let audit_leaks: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 AND detail::text LIKE '%' || $2 || '%'",
    )
    .bind(workspace)
    .bind(&capability)
    .fetch_one(&su)
    .await
    .expect("scan the audit log");
    assert_eq!(audit_leaks, 0, "only the digest is ever persisted");
}
