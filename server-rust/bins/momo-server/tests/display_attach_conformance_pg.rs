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
//! Since LIVE-3 it also covers ADR-0004 증보 3: who may take control of a live
//! screen, what that costs the agent while it lasts, and the three ways the
//! window closes. #1425 added the fourth thing a window does — it stops the
//! agent's **run layer** (D6, 「토큰 소진 0」) — and with it a fourth close, the
//! lease lapse settled by `momo-notifier`'s sweep rather than by a route.
//!
//! ## What each test goes red on
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `live1_1_a_screen_is_published_by_its_own_host_and_nobody_else` | drop the signer pin in `publish_binding_in_tx`, accept a human bearer, or let a second binding overwrite the first |
//! | `live1_2_display_grants_are_observer_only_and_fail_closed` | grant control to a non-owner, mint for a host that never advertised `display_attach`, let a display bearer validate on the PTY route, or drop `display_control_window_open_uniq` |
//! | `live1_3_availability_and_the_observer_count_agree_everywhere` | forget `remote_display_available` in any one of the three projections, or split the observer count per kind |
//! | `live1_4_revocation_reaches_a_live_stream` | cache the validation verdict, stop re-joining `work_host`/`observation` on re-validation, or drop the owner exemption from the observer arm |
//! | `live3_1_control_opens_only_for_the_owner_and_only_with_a_window` | issue control to a watcher, skip the host-advertisement clause for controller, open two windows on one session, or mint a controller grant without a window row |
//! | `live3_2_the_agent_cannot_reach_a_session_under_human_control` | delete the window check in `work_controls::create_in_tx`, move it below the writes, drop the `NOT EXISTS` clause from `pending_controls_for_host_in_tx`, or start blocking spawns |
//! | `live3_3_the_window_closes_three_ways_and_every_one_is_idempotent` | make a repeated return 4xx, stop sweeping lapsed leases, relabel a lapse `returned`, leave a window open on an ended session, or stop emitting the close envelope |
//! | `live3_4_input_enabled_tracks_the_window_and_not_just_the_grade` | answer `input_enabled` from the grade alone, or stop renewing the lease on re-validation |
//! | `live3_5_a_retaken_grant_carries_the_keyboard_and_the_replaced_one_does_not` | leave the window bound to the grant it was opened by when the same owner re-takes control, or mint a second window for the retry |
//! | `live3_6_a_session_that_leaves_underneath_a_window_closes_it` | stop closing the window on the source session of a resume, or let an idempotent 재종료 return early past a window still standing on an ended session |
//! | `live3_7_a_control_window_parks_the_run_it_stops_and_four_doors_resume_it` | drop the park from `issue_in_tx`, drop the resume from `emit_control_closed_in_tx`, delete the notifier's lapse sweep, resume a run a second window still holds, park a run parked on an approval, or let a close resurrect a cancelled run |
//! | `live3_8_a_window_opening_elsewhere_outlasts_a_return_that_races_it` | drop the run-row lock from either half of the park/resume pair, or narrow the park's lock to the rows it intends to update |
//! | `live3_9_two_closes_at_once_still_leave_exactly_one_resume` | drop the run-row lock from the resume, or take it before the caller's own window close instead of after |
//! | `live4_1_the_handoff_card_hears_the_boundary_and_the_join_survives_a_shouted_uuid` | drop the `message.edited` publish that follows the card stamp (in the route or in the notifier's sweep), put the model's raw `session_id` into `props` instead of the canonical one, let the open stamp merge over the previous lapse's end keys instead of deleting them, or let a settled handoff be rewritten by a later window |
//! | `live5a_1_a_grant_carries_its_own_expiring_relay_credential` | mint one shared credential instead of a per-session one, replay the grant's credential on validate instead of minting against that call's clock, drop the expiry from the username, serve a relay the operator did not name, or turn "no relay configured" into an error or an absent field |
//! | `live5a_2_control_closes_observation_and_all_three_closes_restore_it` | leave `observation` open while somebody types a password, restore a default instead of the value the window displaced, forget the restore on any one of the four closes (including the notifier sweep nobody performs), or "restore" `open` onto a session the owner had already closed |
//! | `live5a_3_a_teammates_live_stream_ends_when_control_opens` | close observation only for new grants and not for a stream already running, drop the owner exemption from the arm control just closed, leave the session `owner_only` after the return, or stop projecting the standing window into the session read model |
//! | `live5a_4_a_half_written_control_window_exposes_no_screen` | write the observation flip in a transaction of its own, or let a failed window insert leave the session `owner_only` with no window anywhere to close |
//! | `live5a_5_the_session_surface_reconstructs_all_three_window_states` | drop the control projection from the session list, answer it off `ended_at IS NULL` without the lease clause, or return 0 rather than absence when nobody holds the keyboard |
//!
//! ### The mutation proof (ADR-0004 증보 3's own acceptance criterion)
//!
//! 증보 3 asks for the non-observation gate to be proved by mutation rather than
//! asserted. `live3_2` is built for that and its shape is the argument: the
//! agent it uses is **fully entitled** — live run, approved lineage, running
//! session, unrevoked host — and the test watches it succeed (201) before the
//! window and be refused (409) after, with nothing else changed. An assertion
//! that only ever saw the refusal would pass against a route that refuses
//! everything; this one cannot. It then checks the ledger is unchanged by the
//! refused attempts, so 「the agent observed nothing」 is a claim about what was
//! written and not merely about what was delivered.
//!
//! Since #1425 that test carries a second axis for the same reason. A window
//! now parks the runs driving its session, and a parked run is refused by
//! `control_run_binding_in_tx` *above* the session gate — so measuring the
//! session gate on a parked run would measure the wrong refusal. `live3_2`
//! therefore keeps two runs: the one the window parks, and a bystander that
//! drives a different session and stays `running`. The bystander is refused on
//! the controlled session and served on its own **in the same breath**, which is
//! a control no "refuse everything" implementation can produce.
//!
//! `live3_7` carries D6's own mutation proof, on the surface where the credit
//! is actually spent: the gateway's completion door answers a *different
//! sentence* before and after the window (a lease refusal, then an approval-hold
//! refusal), and `usage_ledger` gains nothing meanwhile.
//!
//! `live5a_3` carries the same shape for the **person** D2 protects rather than
//! the agent D3 does. The teammate it uses is fully entitled — active member,
//! still in the channel, session `observation = 'open'` — and the test watches
//! their live stream validate **200 before** control opens and **401 after**,
//! with nothing revoked and nothing else changed. That 401 is the measurement
//! the whole clause rests on: closing observation only for *new* grants would
//! leave the password on a screen somebody is already watching, and an assertion
//! that only ever saw the refusal could not tell the two builds apart.
//!
//! ## What is deliberately NOT here
//!
//! No socket is opened by any test in this file, because no socket is opened by
//! the server. The signalling handshake, the ICE exchange and the media are the
//! sandbox's, and the closest this suite gets to them is asserting what the
//! server *tells* the producer through `input_enabled` (ADR-0165 D4, ADR-0004
//! 증보 3). Whether a producer honours that — opens a datachannel when told
//! true, and closes it when told false — is unproved by anything in this
//! repository and is labelled as such in the template spec's `unverified`
//! block. The peer-to-peer half is proved separately and honestly by
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

/// The role the control-window sweep really runs as (#1425).
///
/// `live3_7` drives one real iteration of `momo-notifier`'s sweep, and running
/// it on the superuser pool would prove nothing about whether the notifier can
/// perform it: the candidate query is **cross-tenant** by necessity (invariant
/// #6 binds `app.workspace_id` per transaction, so there is no tenant to bind
/// yet) and `display_control_window` carries RLS FORCE. On a NOBYPASSRLS role
/// that read matches zero rows and the sweep silently does nothing forever.
/// `bootstrap_roles.sql` grants `momo_notifier` BYPASSRLS and asserts it; this
/// pool is what makes the test depend on that fact rather than on a superuser
/// that would hide its absence.
async fn momo_notifier_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let password = std::env::var("MOMO_NOTIFIER_PASSWORD")
        .unwrap_or_else(|_| "momo_notifier_dev_pw".to_string());
    let options = options.username("momo_notifier").password(&password);
    PgPoolOptions::new()
        .max_connections(4)
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
    start_server_with_turn(pool, None).await
}

/// The relay this instance is configured with, spelled the way the install
/// runbook spells the real one (LIVE-5a).
///
/// A **documentation-range** address on purpose: no test in this file opens a
/// socket, and a fixture carrying the production relay's address would look
/// like one that might.
const TEST_TURN_URLS: [&str; 2] = [
    "turn:198.51.100.7:3478?transport=udp",
    "turn:198.51.100.7:3478?transport=tcp",
];
const TEST_TURN_SECRET: &str = "live5a-static-auth-secret";
const TEST_TURN_TTL_SECONDS: i64 = 3600;

fn test_turn_policy() -> momo_t3::TurnCredentialPolicy {
    momo_t3::TurnCredentialPolicy::new(
        TEST_TURN_URLS.iter().map(|url| url.to_string()).collect(),
        TEST_TURN_SECRET.to_string(),
        TEST_TURN_TTL_SECONDS,
    )
    .expect("a complete relay policy")
}

/// Start a server with — or deliberately without — a TURN credential policy.
///
/// The `None` arm is not a convenience: it is the state **every deployment is in
/// today**, and `live5a_1` asserts what it answers, so shipping this change to
/// an un-updated instance is a proved outcome rather than a hope.
async fn start_server_with_turn(
    pool: PgPool,
    turn: Option<momo_t3::TurnCredentialPolicy>,
) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
    let state = match turn {
        Some(policy) => state.with_turn(policy),
        None => state,
    };
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

    // ---- the boundary ADR-0004 증보 3 drew ---------------------------------
    //
    // LIVE-1 refused `controller` to everybody, including the owner, because the
    // decision had not been made. It has been (2026-08-15), and the refusal that
    // replaced the blanket one is narrower and permanent: control is the session
    // OWNER's act on their own session (증보 3 D1). A teammate who may watch
    // still may not type, and the sentence they get is the PTY path's, reused.
    let response = issue_display_capability(
        &http,
        &base,
        &watcher_token,
        workspace,
        session,
        Some(json!({ "mode": "controller" })),
    )
    .await;
    assert_eq!(
        response.status(),
        403,
        "control is the owner's act on their own session — watching does not \
         earn a keyboard"
    );
    let body: Value = response.json().await.expect("error body");
    assert_eq!(
        body["error"]["message"],
        "only the session owner can attach as controller"
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

    // ---- what 076 locks now that the observer lock is gone ----------------
    //
    // LIVE-1 asserted here that `terminal_attach_display_observer_ck` made a
    // controllable screen unrepresentable. 076 dropped that CHECK by decision,
    // so this asserts the constraint that replaced it — and it is a stronger
    // one, because it guards a state that would be actively dangerous rather
    // than merely undecided: **two open control windows on one session**, i.e.
    // two people typing into one VM with each other's keystrokes interleaved.
    //
    // Written as a forced INSERT past the route for the same reason LIVE-1's
    // was: a route can be rewritten by a batch that never read this file, and
    // a unique index cannot be talked out of it.
    // The digest is drawn fresh: `token_hash` is UNIQUE across the whole table,
    // so a literal here would collide with the previous run against a reused
    // database and this INSERT would fail for a reason that has nothing to do
    // with what is being asserted.
    let controller_grant = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO terminal_attach_capability \
           (workspace_id, work_session_id, host_id, owner_member_id, token_hash, \
            expires_at, mode, kind) \
         VALUES ($1, $2, (SELECT host_id FROM work_session WHERE id = $2), $3, \
                 digest($4::text, 'sha256'), clock_timestamp() + interval '60 seconds', \
                 'controller', 'display') \
         RETURNING id",
    )
    .bind(workspace)
    .bind(session)
    .bind(fixture.owner)
    .bind(format!("forced-{}", Uuid::new_v4()))
    .fetch_one(&su)
    .await
    .expect("a display controller row is representable since 076 — that is the decision");

    let open_window = |capability: Uuid| {
        let su = su.clone();
        async move {
            sqlx::query(
                "INSERT INTO display_control_window \
                   (workspace_id, work_session_id, grantee_member_id, capability_id, \
                    lease_expires_at) \
                 VALUES ($1, $2, $3, $4, clock_timestamp() + interval '90 seconds')",
            )
            .bind(workspace)
            .bind(session)
            .bind(fixture.owner)
            .bind(capability)
            .execute(&su)
            .await
        }
    };
    open_window(controller_grant)
        .await
        .expect("the first window opens");
    assert!(
        open_window(controller_grant).await.is_err(),
        "display_control_window_open_uniq makes two people holding one \
         session's keyboard unrepresentable"
    );
    // Left closed so it cannot leak into another assertion in this test.
    sqlx::query("UPDATE display_control_window SET ended_at = clock_timestamp(), end_reason = 'returned' WHERE work_session_id = $1 AND ended_at IS NULL")
        .bind(session)
        .execute(&su)
        .await
        .expect("close the forced window");
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

    // But the OWNER still gets in, and that is LIVE-3's other decision.
    //
    // LIVE-1 asserted a 403 here and flagged it: with no controller grade, an
    // `owner_only` session had no screen for anybody, its owner included. 성재
    // settled it — `owner_only` means 「소유자만 본다」, not 「아무도 못 본다」 —
    // so the owner's observer grant is exempt from the observation clause while
    // the teammate's is still cut above.
    let response =
        issue_display_capability(&http, &base, &owner_token, workspace, session, None).await;
    assert_eq!(
        response.status(),
        200,
        "owner_only closes the session to teammates, not to its owner"
    );
    let owner_grant: Value = response.json().await.expect("owner grant body");
    let owner_capability = owner_grant["capability_token"].as_str().expect("token");
    // And it survives re-validation, which is the half that matters: a grant
    // that mints and is then cut on the next 30-second poll is a screen that
    // goes black in front of the person who is allowed to see it.
    let response = validate_display(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        owner_capability,
        true,
    )
    .await;
    assert_eq!(
        response.status(),
        200,
        "the exemption is in the authorization join too, not only at issuance"
    );

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

// ---------------------------------------------------------------------------
// LIVE-3 fixtures — an agent, a run, and a bearer that may drive a session
//
// The gate LIVE-3 adds is not about people, so the LIVE-1 fixtures cannot
// exercise it: only an AGENT can create a work control (`work_controls::create`
// refuses a human bearer by name), and only a control names a session an agent
// wants to touch. These three helpers are the smallest thing that can be
// refused, ported from `work_control_spawn_conformance_pg.rs`.
// ---------------------------------------------------------------------------

/// Seed an agent member that lives in the session's channel.
async fn seed_agent(su: &PgPool, fixture: &Fixture, handle: &str) -> Uuid {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(fixture.workspace)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'claude-opus-4', 'https://gateway.invalid/v1', 4, 50, $3)",
    )
    .bind(agent)
    .bind(fixture.workspace)
    .bind(fixture.owner)
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(fixture.workspace)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent workspace membership");
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member') \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent channel membership");
    agent
}

/// A live run for that agent — `control_run_binding_in_tx` requires one.
async fn seed_run(su: &PgPool, fixture: &Fixture, agent: Uuid) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key) \
         VALUES ($1, $2, $3, $4, 'running'::run_status, $5, $6)",
    )
    .bind(run)
    .bind(fixture.workspace)
    .bind(agent)
    .bind(fixture.channel)
    .bind(json!({"type": "work", "title": "live3", "brief": "live3"}))
    .bind(format!("live3:{run}"))
    .execute(su)
    .await
    .expect("seed agent run");
    run
}

/// `agent_run.status`, straight from the ledger — the fact #1425 writes.
async fn run_status(su: &PgPool, run: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run)
        .fetch_one(su)
        .await
        .expect("read the run status")
}

/// Mint an agent bearer carrying `work:control`.
async fn agent_bearer(su: &PgPool, fixture: &Fixture, agent: Uuid) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{}.{secret}", fixture.workspace);
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['work:control','messages:write'], 'live3-conformance')",
    )
    .bind(fixture.workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

/// The acked `spawn` that makes a session part of this agent's lineage.
///
/// `session_control_lineage_status_in_tx` will not let an agent touch a session
/// it did not spawn (ADR-0114 D5: `input`/`read`/`kill` live inside a lineage a
/// human approved once). The LIVE-1 fixtures create sessions over the owner's
/// REST path, which is nobody's lineage, so the agent tests seed the root
/// control the real flow would have written.
///
/// Seeded rather than driven through spawn→ack because what LIVE-3 is testing
/// is the refusal *after* entitlement, and an agent that got here by a different
/// door is entitled by exactly the same predicate.
async fn seed_spawn_lineage(
    su: &PgPool,
    fixture: &Fixture,
    agent: Uuid,
    host_id: &str,
    session: Uuid,
) {
    sqlx::query(
        "INSERT INTO work_control \
           (workspace_id, channel_id, requester_member_id, target_host_id, session_id, \
            kind, payload, status) \
         VALUES ($1, $2, $3, $4, $5, 'spawn', $6, 'acked')",
    )
    .bind(fixture.workspace)
    .bind(fixture.channel)
    .bind(agent)
    .bind(Uuid::parse_str(host_id).expect("host uuid"))
    .bind(session)
    .bind(json!({ "tool": "claude", "label": "live3 lineage root" }))
    .execute(su)
    .await
    .expect("seed the acked spawn this session descends from");
}

/// The agent asking to do something to a session — its only server path there.
#[allow(clippy::too_many_arguments)]
async fn agent_work_control(
    http: &reqwest::Client,
    base: &str,
    bearer: &str,
    fixture: &Fixture,
    run: Uuid,
    host_id: &str,
    session: Uuid,
    kind: &str,
) -> reqwest::Response {
    let mut body = json!({
        "channelId": fixture.channel.to_string(),
        "runId": run.to_string(),
        "targetHostId": host_id,
        "sessionId": session.to_string(),
        "kind": kind,
        "payload": {},
    });
    // 020's per-kind payload CHECK is a closed world: `input` carries `text` and
    // nothing else, `read` an optional `tail_lines`, `kill` an empty object.
    if kind == "input" {
        body["payload"] = json!({ "text": "whoami\n" });
    }
    http.post(format!(
        "{base}/v1/workspaces/{}/work-controls",
        fixture.workspace
    ))
    .bearer_auth(bearer)
    .json(&body)
    .send()
    .await
    .expect("agent work control")
}

/// Take control as the session owner, and return the raw response.
async fn take_control(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    session: Uuid,
) -> reqwest::Response {
    issue_display_capability(
        http,
        base,
        token,
        workspace,
        session,
        Some(json!({ "mode": "controller" })),
    )
    .await
}

async fn return_control(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    session: Uuid,
) -> reqwest::Response {
    http.delete(format!(
        "{base}/v1/workspaces/{workspace}/work-sessions/{session}/display-control"
    ))
    .bearer_auth(token)
    .send()
    .await
    .expect("return display control")
}

/// Poll a host's queue the way its daemon does — a **signed GET**, which is the
/// only way a daemon learns what to run (`pending_controls_for_host_in_tx`).
///
/// The "right now" in what this returns is the whole point of the assertions
/// that use it: the same dispatched row is delivered or withheld depending on
/// whether a person holds that session's keyboard.
async fn poll_pending(
    http: &reqwest::Client,
    base: &str,
    seed: &[u8; 32],
    workspace: Uuid,
    host_id: &str,
) -> Vec<Value> {
    let path = format!("/v1/workspaces/{workspace}/work-hosts/{host_id}/pending-controls");
    let digest = momo_wire::signing::sha256_hex(&[]);
    let request_id = Uuid::new_v4();
    let sent_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    let payload = momo_wire::signing::request_payload(
        "GET",
        &path,
        workspace,
        Uuid::parse_str(host_id).expect("host uuid"),
        sent_at_ms,
        &digest,
        request_id,
    );
    let signature = momo_wire::signing::sign_base64(seed, &payload).expect("sign");
    let response = http
        .get(format!("{base}{path}"))
        .header("Authorization", format!("MomoHost {host_id}"))
        .header("X-Momo-Work-Host-Sent-At", sent_at_ms.to_string())
        .header("X-Momo-Work-Host-Signature", signature)
        .header("X-Momo-Work-Host-Request-ID", request_id.to_string())
        .send()
        .await
        .expect("poll pending controls");
    assert_eq!(response.status(), 200, "a host may poll its own queue");
    let body: Value = response.json().await.expect("pending body");
    body["workControls"]
        .as_array()
        .expect("workControls array")
        .clone()
}

/// The open window on a session, if any, straight from the ledger.
async fn open_window(su: &PgPool, session: Uuid) -> Option<(Uuid, Uuid)> {
    sqlx::query_as(
        "SELECT id, grantee_member_id FROM display_control_window \
          WHERE work_session_id = $1 AND ended_at IS NULL",
    )
    .bind(session)
    .fetch_optional(su)
    .await
    .expect("read the open control window")
}

/// The open window as a full row: `(id, 정지 시각, lease)`.
///
/// Separate from [`open_window`] because the assertions about a **re-take** are
/// about identity and time — the same window, still started when it started,
/// with its lease pushed back out — and none of those are visible through a
/// grantee id.
async fn open_window_row(su: &PgPool, session: Uuid) -> (Uuid, i64, i64) {
    sqlx::query_as(
        "SELECT id, \
                floor(extract(epoch from started_at) * 1000)::bigint, \
                floor(extract(epoch from lease_expires_at) * 1000)::bigint \
           FROM display_control_window \
          WHERE work_session_id = $1 AND ended_at IS NULL",
    )
    .bind(session)
    .fetch_one(su)
    .await
    .expect("the session has exactly one open control window")
}

/// How many rows this session's control history has, open or closed.
async fn window_count(su: &PgPool, session: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM display_control_window WHERE work_session_id = $1")
        .bind(session)
        .fetch_one(su)
        .await
        .expect("count the windows")
}

/// The `end_reason` written on this session's single window row.
async fn window_end_reason(su: &PgPool, session: Uuid) -> Option<String> {
    sqlx::query_scalar("SELECT end_reason FROM display_control_window WHERE work_session_id = $1")
        .bind(session)
        .fetch_one(su)
        .await
        .expect("read the end reason")
}

/// The `end_reason` of the window on this session that closed **last**.
///
/// [`window_end_reason`]'s sibling, for the tests whose session is taken and
/// returned more than once. A session with two windows in its history has two
/// rows, and asking for "the" reason without an order is an ambiguous question —
/// a bug in the assertion, not in the ledger.
///
/// Ordered by `ended_at` rather than `started_at` because [`lapse_lease`] ages
/// a window's **start** ten minutes into the past (it has to: a lapsed lease is
/// always an old window, never a fresh one with a past lease), so start order
/// and close order genuinely disagree in exactly the test that needs this.
async fn last_closed_window_end_reason(su: &PgPool, session: Uuid) -> Option<String> {
    sqlx::query_scalar(
        "SELECT end_reason FROM display_control_window \
          WHERE work_session_id = $1 AND ended_at IS NOT NULL \
          ORDER BY ended_at DESC, id DESC LIMIT 1",
    )
    .bind(session)
    .fetch_one(su)
    .await
    .expect("read the last close reason")
}

/// PostgreSQL's own clock, in the milliseconds every assertion below compares
/// against. Read from the database rather than the test process so a renewal
/// computed by `clock_timestamp()` is judged on the clock that computed it.
async fn db_now_ms(su: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint")
        .fetch_one(su)
        .await
        .expect("read the database clock")
}

/// Bring a standing lease to within seconds of lapsing **without** lapsing it.
///
/// A renewal is otherwise unobservable in a suite that runs in milliseconds:
/// every write sets `clock_timestamp() + 90s`, so "renewed" and "not renewed"
/// differ by a round trip. Shrinking the lease first makes the difference a full
/// interval, which is the only size an assertion can see.
async fn shorten_lease(su: &PgPool, session: Uuid) {
    let shortened = sqlx::query(
        "UPDATE display_control_window \
            SET lease_expires_at = clock_timestamp() + interval '5 seconds' \
          WHERE work_session_id = $1 AND ended_at IS NULL",
    )
    .bind(session)
    .execute(su)
    .await
    .expect("shorten the lease")
    .rows_affected();
    assert_eq!(shortened, 1, "there was an open window to shorten");
}

/// Re-validate the way a producer does every 30 seconds, and answer what the
/// server told it about the keyboard.
async fn revalidate(
    http: &reqwest::Client,
    base: &str,
    seed: &[u8; 32],
    workspace: Uuid,
    host_id: &str,
    token: &str,
) -> (reqwest::StatusCode, Value) {
    let response = validate_display(http, base, seed, workspace, host_id, token, true).await;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .unwrap_or_else(|_| json!({ "error": "unparsed" }));
    (status, body)
}

/// The `closed` boundary envelopes this session's window produced.
async fn closed_control_envelopes(su: &PgPool, workspace: Uuid, session: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload->'data'->'payload' FROM outbox \
          WHERE workspace_id = $1 \
            AND payload->'data'->>'type' = 'work.session.control' \
            AND payload->'data'->'payload'->>'state' = 'closed' \
            AND payload->'data'->'payload'->>'session_id' = $2::text",
    )
    .bind(workspace)
    .bind(session.to_string())
    .fetch_all(su)
    .await
    .expect("read this session's close envelopes")
}

/// The offline sweep's verdict, applied as a fixture: no HTTP path writes
/// `orphaned` (ADR-0125 D11 — it is the sweep's word, which is why
/// `daemon_ack_resume_conformance_pg` seeds it the same way).
async fn orphan_session(su: &PgPool, session: Uuid) {
    let orphaned = sqlx::query(
        "UPDATE work_session SET status = 'orphaned', host_lost_at = clock_timestamp() \
          WHERE id = $1",
    )
    .bind(session)
    .execute(su)
    .await
    .expect("orphan the session")
    .rows_affected();
    assert_eq!(orphaned, 1);
}

/// A session that reached `ended` by a path that does **not** close control
/// windows — the offline sweep and `t3_terminate`, which settle the billing
/// ledger and leave the window to the lease backstop.
///
/// Written as SQL rather than driven through one of those paths because what is
/// under test is the *reconciliation*: an ended session with an open window is a
/// state this system can reach, and the idempotent 재종료 is where the ledger
/// gets to be honest about it. Which door produced the state is irrelevant to
/// the route that has to answer for it.
async fn force_ended(su: &PgPool, session: Uuid) {
    let ended = sqlx::query(
        "UPDATE work_session SET status = 'ended', ended_at = clock_timestamp() \
          WHERE id = $1",
    )
    .bind(session)
    .execute(su)
    .await
    .expect("end the session behind the route's back")
    .rows_affected();
    assert_eq!(ended, 1);
}

/// Age a window until its lease has lapsed — what a producer that stopped
/// re-validating looks like, without waiting 90 seconds for it.
///
/// **Both** timestamps move, and that is not a trick to dodge
/// `display_control_window_lease_ck`: the constraint says a lease was valid when
/// it was written, which is true of every real write (a lease is always
/// `clock_timestamp() + 90s`). A window whose lease has lapsed is therefore
/// always an OLD window, never a fresh one with a past lease, and the fixture
/// has to produce the state the system can actually reach.
async fn lapse_lease(su: &PgPool, session: Uuid) {
    let aged = sqlx::query(
        "UPDATE display_control_window \
            SET started_at = clock_timestamp() - interval '10 minutes', \
                lease_expires_at = clock_timestamp() - interval '8 minutes' \
          WHERE work_session_id = $1 AND ended_at IS NULL",
    )
    .bind(session)
    .execute(su)
    .await
    .expect("age the control window past its lease")
    .rows_affected();
    assert_eq!(aged, 1, "there was an open window to lapse");
}

// ---------------------------------------------------------------------------
// live3-1 — control opens for the owner, for nobody else, and never without a
//           window in the ledger
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live3_1_control_opens_only_for_the_owner_and_only_with_a_window() {
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

    // ---- a host with no screen cannot be controlled either ------------------
    // The fail-closed advertisement gate is a clause of issuance, not of the
    // observer grade, so opening control must not have slipped past it. This is
    // also how BYOC stays out (증보 3 D7) without policy naming a provider.
    let (blind_host, _blind_seed) =
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
    sqlx::query("UPDATE work_session SET display_id = $2, display_endpoint = $3 WHERE id = $1")
        .bind(blind_session)
        .bind(DISPLAY_ID)
        .bind(DISPLAY_ENDPOINT)
        .execute(&su)
        .await
        .expect("force a binding the route would have refused");
    let response = take_control(&http, &base, &owner_token, workspace, blind_session).await;
    assert_eq!(
        response.status(),
        409,
        "a box that never advertised a screen has no keyboard either — BYOC is \
         excluded by this clause and not by a provider name"
    );
    assert!(
        open_window(&su, blind_session).await.is_none(),
        "a refused grant leaves no window"
    );

    // ---- the ordinary, advertised host --------------------------------------
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

    // ---- who may not ---------------------------------------------------------
    for (label, token) in [
        ("a teammate who may watch", &watcher_token),
        ("a workspace member outside the channel", &outsider_token),
    ] {
        let response = take_control(&http, &base, token, workspace, session).await;
        assert_eq!(
            response.status(),
            403,
            "{label} does not get the keyboard — control is the owner's act on \
             their own session (ADR-0004 증보 3 D1)"
        );
        assert!(
            open_window(&su, session).await.is_none(),
            "{label} left no window behind"
        );
    }

    // ---- the owner does, and the window is part of the same act -------------
    let response = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);
    let grant: Value = response.json().await.expect("grant body");
    assert_eq!(grant["mode"], json!("controller"));
    assert_eq!(grant["display_id"], json!(DISPLAY_ID));
    let started_at = grant["control_started_at"]
        .as_i64()
        .expect("a controller grant reports when control began");

    let (window_id, grantee) = open_window(&su, session)
        .await
        .expect("a controller grant that opened no window would be a keyboard nobody recorded");
    assert_eq!(grantee, fixture.owner);

    // ---- re-taking control is idempotent ------------------------------------
    // A client retry must not mint a second window: 정지 시각 is a fact the
    // agent is told, and two answers to it is not a fact.
    let response = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);
    let again: Value = response.json().await.expect("second grant body");
    assert_eq!(
        again["control_started_at"].as_i64(),
        Some(started_at),
        "re-taking control renews the window rather than starting a new one"
    );
    let (window_again, _) = open_window(&su, session).await.expect("still one window");
    assert_eq!(window_again, window_id, "and it is the same row");

    let windows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM display_control_window WHERE work_session_id = $1",
    )
    .bind(session)
    .fetch_one(&su)
    .await
    .expect("count windows");
    assert_eq!(windows, 1, "one intervention, one row");

    // ---- the audit says a boundary was crossed, and says nothing else -------
    let detail: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'work.display_attach.issued' \
            AND detail->>'mode' = 'controller' \
          ORDER BY created_at DESC LIMIT 1",
    )
    .bind(workspace)
    .fetch_one(&su)
    .await
    .expect("read the control audit row");
    assert_eq!(detail["mode"], json!("controller"));
    assert_eq!(detail["kind"], json!("display"));
    assert_eq!(detail["control_window_opened"], json!(true));

    // ---- the boundary event carries the boundary and nothing else ----------
    let payload: Value = sqlx::query_scalar(
        "SELECT payload->'data'->'payload' FROM outbox \
          WHERE workspace_id = $1 \
            AND payload->'data'->>'type' = 'work.session.control' \
          ORDER BY id LIMIT 1",
    )
    .bind(workspace)
    .fetch_one(&su)
    .await
    .expect("read the control envelope");
    let mut keys: Vec<&str> = payload
        .as_object()
        .expect("payload")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec!["session_id", "started_at", "state"],
        "ADR-0004 증보 3 D3: the agent learns 정지 시각 and that is the whole list \
         — no grantee, no frame, no keystroke, no endpoint"
    );
    assert_eq!(payload["state"], json!("opened"));

    // ---- and a second person cannot take it away ---------------------------
    // Unreachable through the owner check above (only the owner gets this far),
    // so it is forced at the ledger: two open windows is the state the unique
    // index exists to refuse.
    let stolen = sqlx::query(
        "INSERT INTO display_control_window \
           (workspace_id, work_session_id, grantee_member_id, capability_id, lease_expires_at) \
         VALUES ($1, $2, $3, \
                 (SELECT id FROM terminal_attach_capability \
                   WHERE work_session_id = $2 AND mode = 'controller' LIMIT 1), \
                 clock_timestamp() + interval '90 seconds')",
    )
    .bind(workspace)
    .bind(session)
    .bind(fixture.watcher)
    .execute(&su)
    .await;
    assert!(
        stolen.is_err(),
        "one open window per session — two keyboards on one VM is unrepresentable"
    );
}

// ---------------------------------------------------------------------------
// live3-2 — 비관측: the agent is refused while a person holds control
//
// This is ADR-0004 증보 3 D3's 기술적 차단 and the acceptance criterion that
// asks for a mutation proof. The adversarial shape is deliberate: the agent
// here is fully entitled — live run, approved lineage, running session, a host
// that is not revoked — and is refused anyway, on the one axis that changed.
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live3_2_the_agent_cannot_reach_a_session_under_human_control() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let owner_token = login(&http, &base, workspace, &fixture.owner_email).await;
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

    let agent = seed_agent(&su, &fixture, "live3-intern").await;
    let run = seed_run(&su, &fixture, agent).await;
    let bearer = agent_bearer(&su, &fixture, agent).await;
    seed_spawn_lineage(&su, &fixture, agent, &host_id, session).await;

    // A second session on the same host, and a second live run of the same
    // agent that drives only that one.
    //
    // Since #1425 the session gate is not the only thing a window does: it also
    // parks every run **driving the controlled session** (증보 3 D6), and a
    // parked run is refused by `control_run_binding_in_tx` before the session
    // gate is ever consulted. Measuring the session gate on a parked run would
    // therefore measure the wrong refusal.
    //
    // So the two facts get one subject each. `run` drives `session` and carries
    // the parking; `bystander` drives `elsewhere` and is what the session gate
    // is measured on. It is entitled by exactly the same predicates —
    // `session_control_lineage_status_in_tx` reads the *agent*'s lineage, not
    // the run's — so nothing about the mutation proof was weakened by the split,
    // and it gained a second axis: `elsewhere` stays reachable at the same
    // instant `session` is refused, which no route that simply refuses
    // everything could produce.
    let elsewhere = create_session(
        &http,
        &base,
        &owner_token,
        workspace,
        fixture.channel,
        &host_id,
    )
    .await;
    let bystander = seed_run(&su, &fixture, agent).await;
    seed_spawn_lineage(&su, &fixture, agent, &host_id, elsewhere).await;

    // ---- the control plane works for this agent BEFORE the window ----------
    // The mutation proof needs this: an assertion that only ever saw a refusal
    // would pass just as well against a route that refuses everything.
    for kind in ["read", "input"] {
        let response = agent_work_control(
            &http, &base, &bearer, &fixture, run, &host_id, session, kind,
        )
        .await;
        let status = response.status();
        assert_eq!(
            status,
            201,
            "{kind} is exactly what this agent is entitled to do right now: {:?}",
            response.text().await
        );
    }
    let response = agent_work_control(
        &http, &base, &bearer, &fixture, bystander, &host_id, elsewhere, "read",
    )
    .await;
    assert_eq!(
        response.status(),
        201,
        "and so is the bystander run on its own session"
    );
    let dispatched: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM work_control WHERE session_id = $1 AND status = 'dispatched'",
    )
    .bind(session)
    .fetch_one(&su)
    .await
    .expect("count dispatched controls");
    assert_eq!(dispatched, 2, "both landed and were dispatched to the host");

    // Every row this session has, including the acked spawn it descends from.
    // Counted here so the post-refusal count below compares like with like.
    let controls_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM work_control WHERE session_id = $1")
            .bind(session)
            .fetch_one(&su)
            .await
            .expect("count controls");

    // ---- the person takes control ------------------------------------------
    let response = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);

    // ---- and now the same agent, unchanged, is refused ---------------------
    for kind in ["read", "input", "kill"] {
        let response = agent_work_control(
            &http, &base, &bearer, &fixture, bystander, &host_id, session, kind,
        )
        .await;
        assert_eq!(
            response.status(),
            409,
            "ADR-0004 증보 3 D3: while a person is typing, the agent's own path \
             to this session is refused — `{kind}` included"
        );
        let body: Value = response.json().await.expect("error body");
        assert_eq!(
            body["error"]["message"], "work session is under human control",
            "and it is told the boundary, not the pixels"
        );
    }
    // …while the session nobody is typing into is still reachable, in the same
    // breath, by the same run. The gate is about a screen, not about an agent.
    let response = agent_work_control(
        &http, &base, &bearer, &fixture, bystander, &host_id, elsewhere, "read",
    )
    .await;
    assert_eq!(
        response.status(),
        201,
        "증보 3 stops the agent's reach into ONE screen; a second session on the \
         same host, in the same channel, is untouched"
    );

    // The refusal happens above every write: an agent that tried to look leaves
    // no control row, no dispatch and no audit trail of having looked. That is
    // what makes 「the agent observed nothing」 a statement about the ledger.
    let controls_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM work_control WHERE session_id = $1")
            .bind(session)
            .fetch_one(&su)
            .await
            .expect("count controls");
    assert_eq!(
        controls_after, controls_before,
        "nothing was written by the three refused attempts — the gate sits above \
         every write, so an agent that tried to look leaves no trace of having tried"
    );

    // ---- the work already dispatched is WITHHELD, not delivered ------------
    // The race the create-side gate cannot reach: two controls were dispatched
    // one moment before the window opened. If the daemon could still collect
    // them it would read the screen the person is typing a password into.
    let delivered = poll_pending(&http, &base, &host_seed, workspace, &host_id).await;
    let for_session = |queue: &[Value], target: Uuid| -> usize {
        queue
            .iter()
            .filter(|control| control["sessionId"].as_str() == Some(&target.to_string()))
            .count()
    };
    assert_eq!(
        for_session(&delivered, session),
        0,
        "a control dispatched before the window opened is withheld while it \
         stands — the poll is the only way a daemon learns what to run, and \
         handing these over would read the screen the person is typing into"
    );
    // The same poll, on the same host, still carries the other session's work.
    // Withholding is a clause about a screen, not a stop-the-world for the
    // daemon, and an assertion that only saw an empty queue could not tell the
    // two apart.
    assert!(
        for_session(&delivered, elsewhere) >= 1,
        "the host's other session is not under anybody's keyboard, so its \
         dispatched work is delivered in the very same poll"
    );

    // ---- the AGENT's other work is untouched -------------------------------
    // 증보 3 stops the agent's reach into THIS session, not the agent. A spawn
    // names no session, so it is not the session anybody is typing into — and
    // this run is not one the window parked, so nothing about it changed.
    let response = http
        .post(format!("{base}/v1/workspaces/{workspace}/work-controls"))
        .bearer_auth(&bearer)
        .json(&json!({
            "channelId": fixture.channel.to_string(),
            "runId": bystander.to_string(),
            "targetHostId": host_id,
            "kind": "spawn",
            "payload": { "tool": "claude", "label": "elsewhere" },
        }))
        .send()
        .await
        .expect("spawn during a control window");
    assert_ne!(
        response.status(),
        409,
        "a spawn names no session; blocking it would stop the agent rather than \
         its reach into one screen (증보 3 D6)"
    );

    // ---- the RUN that was driving this session is stopped (#1425) -----------
    // The other half of D6, and the reason the two subjects above are two. This
    // run is parked, so its refusal is its own and arrives before the session
    // gate is consulted at all — which is exactly why the sweeper in
    // `momo-notifier` has to exist. `live3_7` owns that story; here the only
    // claim is that the window really did move the run.
    assert_eq!(
        run_status(&su, run).await,
        "paused",
        "ADR-0004 증보 3 D6: 정지되는 것은 에이전트 런 층"
    );
    assert_eq!(
        run_status(&su, bystander).await,
        "running",
        "…and only the runs driving the controlled session — a window is not a \
         pause button for the agent"
    );

    // ---- the VM never moved (증보 3 D6) ------------------------------------
    let status: String = sqlx::query_scalar("SELECT status FROM work_session WHERE id = $1")
        .bind(session)
        .fetch_one(&su)
        .await
        .expect("read session status");
    assert_eq!(
        status, "running",
        "ADR-0140's state machine is untouched: the VM stays running and stays \
         billable. What stops is the run layer's reach, not the machine."
    );

    // ---- return, and the agent resumes -------------------------------------
    let response = return_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);
    let returned: Value = response.json().await.expect("return body");
    assert_eq!(returned["closed"], json!(true));

    let response = agent_work_control(
        &http, &base, &bearer, &fixture, run, &host_id, session, "read",
    )
    .await;
    assert_eq!(
        response.status(),
        201,
        "「사용자 개입 완료」 — the agent's reach comes back with the keyboard"
    );

    // And the withheld work is delivered now rather than lost.
    let delivered = poll_pending(&http, &base, &host_seed, workspace, &host_id).await;
    assert!(
        for_session(&delivered, session) >= 2,
        "withholding paused the work; it did not throw it away — a withheld row \
         is still `dispatched`, so the next poll after the window closes gets it"
    );
}

// ---------------------------------------------------------------------------
// live3-3 — the window closes three ways, all idempotent, all fail-closed
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live3_3_the_window_closes_three_ways_and_every_one_is_idempotent() {
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

    let fresh_session = |label: &'static str| {
        let http = http.clone();
        let base = base.clone();
        let owner_token = owner_token.clone();
        let host_id = host_id.clone();
        let channel = fixture.channel;
        async move {
            let session =
                create_session(&http, &base, &owner_token, workspace, channel, &host_id).await;
            publish_display(&http, &base, &host_seed, workspace, &host_id, session).await;
            let response = take_control(&http, &base, &owner_token, workspace, session).await;
            assert_eq!(response.status(), 200, "{label}: control opens");
            session
        }
    };

    let end_reason = |session: Uuid| {
        let su = su.clone();
        async move {
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT end_reason FROM display_control_window WHERE work_session_id = $1",
            )
            .bind(session)
            .fetch_one(&su)
            .await
            .expect("read the end reason")
        }
    };

    // ---- 1. the person hands it back ---------------------------------------
    let returned_session = fresh_session("return").await;
    let response = return_control(&http, &base, &owner_token, workspace, returned_session).await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.expect("return body");
    assert_eq!(body["closed"], json!(true));
    assert!(open_window(&su, returned_session).await.is_none());
    assert_eq!(
        end_reason(returned_session).await.as_deref(),
        Some("returned")
    );

    // Idempotent: a retried return is success with `closed: false`, never a 4xx.
    let response = return_control(&http, &base, &owner_token, workspace, returned_session).await;
    assert_eq!(
        response.status(),
        200,
        "a retried return is the state the caller asked for, not a failure"
    );
    let body: Value = response.json().await.expect("second return body");
    assert_eq!(body["closed"], json!(false));

    // And a teammate cannot end somebody else's intervention.
    let taken_again = fresh_session("return/authz").await;
    let response = return_control(&http, &base, &watcher_token, workspace, taken_again).await;
    assert_eq!(
        response.status(),
        403,
        "ending an intervention mid-password is the owner's call, like starting one"
    );
    assert!(open_window(&su, taken_again).await.is_some());

    // ---- 2. the lease lapses ------------------------------------------------
    // The producer stopped re-validating: the browser was closed, the tab
    // crashed, the person walked away. Nobody performs this close, so the ledger
    // has to perform it — otherwise the agent stays blocked forever by a window
    // whose holder is gone.
    let lapsed_session = fresh_session("lapse").await;
    lapse_lease(&su, lapsed_session).await;

    let agent = seed_agent(&su, &fixture, "live3-lapse-intern").await;
    let run = seed_run(&su, &fixture, agent).await;
    let bearer = agent_bearer(&su, &fixture, agent).await;
    seed_spawn_lineage(&su, &fixture, agent, &host_id, lapsed_session).await;
    let response = agent_work_control(
        &http,
        &base,
        &bearer,
        &fixture,
        run,
        &host_id,
        lapsed_session,
        "read",
    )
    .await;
    assert_eq!(
        response.status(),
        201,
        "a lapsed window stops blocking the agent — the fail-safe direction, \
         because a person who left must not silence an agent permanently"
    );
    assert!(open_window(&su, lapsed_session).await.is_none());
    assert_eq!(
        end_reason(lapsed_session).await.as_deref(),
        Some("expired"),
        "and it is closed with the reason that is TRUE — a lapse relabelled \
         'returned' would be a wrong story about what happened"
    );

    // ---- 3. the session ends underneath it ---------------------------------
    let ended_session = fresh_session("session end").await;
    let response = http
        .patch(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{ended_session}"
        ))
        .bearer_auth(&owner_token)
        .json(&json!({ "status": "ended" }))
        .send()
        .await
        .expect("end the session");
    assert_eq!(response.status(), 200);
    assert!(
        open_window(&su, ended_session).await.is_none(),
        "a window left open on an ended session would block the agent forever \
         on a session nobody can control"
    );
    assert_eq!(
        end_reason(ended_session).await.as_deref(),
        Some("session_ended")
    );

    // ---- every close announced itself --------------------------------------
    // The 재개 half of 증보 3 D3. Three closes, three envelopes, each naming why.
    let closed: Vec<Value> = sqlx::query_scalar(
        "SELECT payload->'data'->'payload' FROM outbox \
          WHERE workspace_id = $1 \
            AND payload->'data'->>'type' = 'work.session.control' \
            AND payload->'data'->'payload'->>'state' = 'closed'",
    )
    .bind(workspace)
    .fetch_all(&su)
    .await
    .expect("read close envelopes");
    let mut reasons: Vec<String> = closed
        .iter()
        .map(|payload| payload["end_reason"].as_str().unwrap_or("").to_string())
        .collect();
    reasons.sort();
    assert_eq!(
        reasons,
        vec!["expired", "returned", "session_ended"],
        "each close is a boundary event and each says which of the three it was"
    );
    for payload in &closed {
        assert!(
            payload["ended_at"].is_i64(),
            "재개 시각 is the fact this event exists to carry"
        );
    }
}

// ---------------------------------------------------------------------------
// live3-4 — `input_enabled` is honest, and honesty is what makes 반환 real
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live3_4_input_enabled_tracks_the_window_and_not_just_the_grade() {
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

    let validated = |capability: String, stream: bool| {
        let http = http.clone();
        let base = base.clone();
        let host_id = host_id.clone();
        async move {
            let response = validate_display(
                &http,
                &base,
                &host_seed,
                workspace,
                &host_id,
                &capability,
                stream,
            )
            .await;
            let status = response.status();
            let body: Value = response
                .json()
                .await
                .unwrap_or_else(|_| json!({ "error": "unparsed" }));
            (status, body)
        }
    };

    // ---- an observer is told no, exactly as before --------------------------
    let response =
        issue_display_capability(&http, &base, &watcher_token, workspace, session, None).await;
    assert_eq!(response.status(), 200);
    let watcher_capability = response.json::<Value>().await.expect("grant")["capability_token"]
        .as_str()
        .expect("token")
        .to_string();
    let (status, body) = validated(watcher_capability, false).await;
    assert_eq!(status, 200);
    assert_eq!(body["mode"], json!("observer"));
    assert_eq!(
        body["input_enabled"],
        json!(false),
        "ADR-0165 D4 is unchanged for view-only: the guarantee is a datachannel \
         that is never opened"
    );

    // ---- a controller with a standing window is told yes -------------------
    let response = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);
    let control_capability = response.json::<Value>().await.expect("grant")["capability_token"]
        .as_str()
        .expect("token")
        .to_string();

    let (status, body) = validated(control_capability.clone(), false).await;
    assert_eq!(status, 200);
    assert_eq!(body["mode"], json!("controller"));
    assert_eq!(
        body["input_enabled"],
        json!(true),
        "the producer may open input only because the server said so — never \
         because a viewer asked"
    );

    // A re-validation renews the lease, which is what keeps the window open for
    // as long as the stream is up (076: the 60-second dial TTL does not bound a
    // live WebRTC session, and keying the window to it would resume the agent
    // mid-login).
    let (status, body) = validated(control_capability.clone(), true).await;
    assert_eq!(status, 200);
    assert_eq!(body["input_enabled"], json!(true));
    assert!(
        open_window(&su, session).await.is_some(),
        "re-validating is the producer saying the stream is up, and that is what \
         holds the window open"
    );

    // ---- return, and the SAME bearer stops enabling input -------------------
    // This is the assertion that makes 반환 mean something. Without it, handing
    // control back would be a row in a table and a keyboard that still worked.
    let response = return_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);

    let (status, body) = validated(control_capability, true).await;
    assert_eq!(
        status, 200,
        "the grant itself is still authorised — the owner may still watch"
    );
    assert_eq!(
        body["input_enabled"],
        json!(false),
        "but the keyboard is gone within one re-validation period, because the \
         window it depended on has closed"
    );
}

// ---------------------------------------------------------------------------
// live3-5 — a re-take moves the keyboard onto the grant that was just minted
//
// The failure this test exists for is a **retry**, which is the most ordinary
// thing a client does. The response to the first `display-attach` is lost, or
// the socket drops and the browser re-dials; the person presses 제어하기 again
// and gets token B. Every issue mints a new capability row, and the only renewal
// a live stream has is keyed by capability id — so a window still pointing at
// token A is a window that B cannot keep alive. The person is told
// `input_enabled: false`, nothing renews the lease, and ninety seconds into a
// login they are still typing the window lapses and the agent resumes reading
// the screen. That is exactly what ADR-0004 증보 3 D3 forbids, arriving through
// the one door a retry always opens.
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live3_5_a_retaken_grant_carries_the_keyboard_and_the_replaced_one_does_not() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let owner_token = login(&http, &base, workspace, &fixture.owner_email).await;
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

    // ---- the first dial, and a producer live on it --------------------------
    let response = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200, "the owner takes control");
    let token_a = response.json::<Value>().await.expect("first grant")["capability_token"]
        .as_str()
        .expect("token")
        .to_string();
    let (window_id, started_at_ms, _) = open_window_row(&su, session).await;

    let (status, body) = revalidate(&http, &base, &host_seed, workspace, &host_id, &token_a).await;
    assert_eq!(status, 200);
    assert_eq!(
        body["input_enabled"],
        json!(true),
        "the first bearer holds the keyboard, as live3-4 already proves"
    );

    // ---- the retry ----------------------------------------------------------
    // The lease is shortened first so that "the re-take renewed it" is a claim
    // an assertion can see rather than a claim about microseconds.
    shorten_lease(&su, session).await;
    let response = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(
        response.status(),
        200,
        "re-taking control you already hold is a retry, not a conflict"
    );
    let token_b = response.json::<Value>().await.expect("second grant")["capability_token"]
        .as_str()
        .expect("token")
        .to_string();
    assert_ne!(token_a, token_b, "every issue mints a fresh bearer");

    // Same window. The person never let go, so 정지 시각 keeps its value and the
    // agent is owed no second boundary event.
    let (retaken_id, retaken_started_at_ms, lease_ms) = open_window_row(&su, session).await;
    assert_eq!(
        retaken_id, window_id,
        "a retry must not mint a second window — 정지 시각 would become ambiguous"
    );
    assert_eq!(
        retaken_started_at_ms, started_at_ms,
        "the window did not restart; it is the same intervention"
    );
    assert_eq!(
        window_count(&su, session).await,
        1,
        "and there is exactly one row to be ambiguous about"
    );
    assert!(
        lease_ms > db_now_ms(&su).await + 60_000,
        "the re-take renewed the lease it rebound"
    );

    // ---- the new bearer is the one that works -------------------------------
    // The assertion the whole test is for. Before the rebind this answered
    // `false`: the window still named token A, so B's renewal matched no row.
    let (status, body) = revalidate(&http, &base, &host_seed, workspace, &host_id, &token_b).await;
    assert_eq!(status, 200);
    assert_eq!(
        body["input_enabled"],
        json!(true),
        "the grant the client is actually holding must carry the keyboard, or a \
         dropped response silently takes control away from a person mid-login"
    );

    // And it can keep the window alive, which is the half a boolean cannot show.
    // A bearer told `true` that renews nothing still starves the lease to death
    // inside 90 seconds and resumes the agent mid-password.
    shorten_lease(&su, session).await;
    let (status, body) = revalidate(&http, &base, &host_seed, workspace, &host_id, &token_b).await;
    assert_eq!(status, 200);
    assert_eq!(body["input_enabled"], json!(true));
    let (_, _, lease_ms) = open_window_row(&su, session).await;
    assert!(
        lease_ms > db_now_ms(&su).await + 60_000,
        "the live producer's re-validation is what holds the window open, and it \
         can only do that against the grant the window names"
    );

    // ---- the replaced bearer is not -----------------------------------------
    // The correct consequence of a rebind, stated so it reads as the decision it
    // is: the newest grant, and only the newest grant, holds the keyboard. A
    // bearer the client has already replaced hearing `true` would mean two live
    // producers could both open input on one screen.
    let (status, body) = revalidate(&http, &base, &host_seed, workspace, &host_id, &token_a).await;
    assert_eq!(
        status, 200,
        "the old grant is still authorised — the owner may still watch"
    );
    assert_eq!(
        body["input_enabled"],
        json!(false),
        "but a superseded bearer no longer holds the keyboard, the same sentence \
         a return produces"
    );
    assert!(
        open_window(&su, session).await.is_some(),
        "and being told no did not close the window the new bearer holds"
    );
}

// ---------------------------------------------------------------------------
// live3-6 — a session that leaves underneath a window closes it
//
// live3-3 proves the ordinary `end`. Two other routes take a session away from
// underneath a person's keyboard and neither of them ran that close:
//
//   * a **resume**, which retires the source session. This is not an exotic
//     shape — a session is orphaned because its host went away, and the person
//     watching that happen is precisely the person most likely to have been
//     holding its screen.
//   * an idempotent **재종료** of a session something else already ended. The
//     offline sweep and `t3_terminate` settle the ledger and leave the window to
//     the lease backstop, so `PATCH status=ended` on an already-ended session is
//     where an ended session with an open window gets reconciled.
//
// In both cases the row left behind claims a person holds a keyboard on a screen
// that no longer exists, and the agent's run path is refused on a session nobody
// can control until the lease happens to lapse.
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live3_6_a_session_that_leaves_underneath_a_window_closes_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let owner_token = login(&http, &base, workspace, &fixture.owner_email).await;
    let (host_id, host_seed) = register_host(&http, &base, &owner_token, workspace, true).await;
    let (target_host_id, _) = register_host(&http, &base, &owner_token, workspace, true).await;

    let controlled_session = |label: &'static str| {
        let http = http.clone();
        let base = base.clone();
        let owner_token = owner_token.clone();
        let host_id = host_id.clone();
        let channel = fixture.channel;
        async move {
            let session =
                create_session(&http, &base, &owner_token, workspace, channel, &host_id).await;
            publish_display(&http, &base, &host_seed, workspace, &host_id, session).await;
            let response = take_control(&http, &base, &owner_token, workspace, session).await;
            assert_eq!(response.status(), 200, "{label}: control opens");
            session
        }
    };

    // ---- 1. the source session of a takeover --------------------------------
    let source = controlled_session("resume").await;
    assert!(open_window(&su, source).await.is_some());
    orphan_session(&su, source).await;

    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{source}/resume"
        ))
        .bearer_auth(&owner_token)
        .json(&json!({ "targetHostId": target_host_id }))
        .send()
        .await
        .expect("resume the orphaned session");
    assert_eq!(
        response.status(),
        201,
        "the owner moves their work to another host"
    );

    assert!(
        open_window(&su, source).await.is_none(),
        "the source session is over, so the window on it is over — leaving it \
         open would block the agent on a session that no longer exists"
    );
    assert_eq!(
        window_end_reason(&su, source).await.as_deref(),
        Some("session_ended"),
        "and it closed for the reason that is true: the session left"
    );
    let envelopes = closed_control_envelopes(&su, workspace, source).await;
    assert_eq!(
        envelopes.len(),
        1,
        "one close, one boundary event — the 재개 half of 증보 3 D3 does not get \
         skipped because the close was caused by a takeover"
    );
    assert_eq!(envelopes[0]["end_reason"], json!("session_ended"));
    assert!(
        envelopes[0]["ended_at"].is_i64(),
        "재개 시각 is the fact the event exists to carry"
    );

    // The window belongs to the source and is not carried over: control is a
    // person's act on one live screen (증보 3 D1), and the successor is a
    // different host with a different screen and no binding published yet.
    let successor: Uuid =
        sqlx::query_scalar("SELECT id FROM work_session WHERE resumed_from_session_id = $1")
            .bind(source)
            .fetch_one(&su)
            .await
            .expect("the takeover created a successor session");
    assert!(
        open_window(&su, successor).await.is_none(),
        "the successor starts with nobody at its keyboard"
    );

    // ---- 2. the idempotent re-end of a session something else ended ---------
    let stale = controlled_session("idempotent re-end").await;
    force_ended(&su, stale).await;
    assert!(
        open_window(&su, stale).await.is_some(),
        "the fixture reproduces the state the sweep leaves: ended, still claimed"
    );

    let response = http
        .patch(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{stale}"
        ))
        .bearer_auth(&owner_token)
        .json(&json!({ "status": "ended" }))
        .send()
        .await
        .expect("re-end the already-ended session");
    assert_eq!(
        response.status(),
        200,
        "ending an ended session is the state the caller asked for"
    );

    assert!(
        open_window(&su, stale).await.is_none(),
        "the early return must not carry a standing window past it — an honest \
         ledger does not say a person holds a keyboard on a finished session"
    );
    assert_eq!(
        window_end_reason(&su, stale).await.as_deref(),
        Some("session_ended")
    );
    let envelopes = closed_control_envelopes(&su, workspace, stale).await;
    assert_eq!(envelopes.len(), 1, "and it announced itself, once");
    assert_eq!(envelopes[0]["end_reason"], json!("session_ended"));
}

// ---------------------------------------------------------------------------
// live3-7 — the run layer parks, and comes back by all four doors (#1425)
//
// ADR-0004 증보 3 D6 is two sentences and LIVE-3 shipped one of them:
//
//   * the VM does not move — `work_session.status` untouched, ADR-0140's state
//     machine untouched, running-time billing (ADR-0164) continuing;
//   * **the agent's RUN layer stops** — 「사용자 개입 대기」, 토큰 소진 0,
//     크레딧이 토큰으로 새지 않음.
//
// The second one had every part except a writer: `RunStatus::Paused` was in the
// enum, in `LIVE`, in `is_approval_held` and in `is_cancellable`, and the
// gateway's two doors had been refusing held runs since the approval batch.
// Nothing ever wrote it. This test is that writer's proof, and it is deliberately
// built as a *round trip* rather than a snapshot: parking that could not be
// undone would be a worse bug than parking that never happened.
//
// ## What each assertion goes red on
//
// | fact | revert that makes it red |
// |---|---|
// | 창 개설 → `paused` | drop `park_runs_for_control_window_in_tx` from `issue_in_tx`, or widen its `status = 'running'` guard so it parks nothing |
// | 토큰 소진 0 | reorder the gateway's `is_approval_held` check below the lease judgement, or drop `Paused` from `is_approval_held` |
// | 반환 → resume | drop the resume from `emit_control_closed_in_tx` |
// | lapse → resume | delete the notifier sweep, or let it close windows whose lease still stands |
// | 세션 종료 → resume | close the window on session end without settling the runs |
// | 멱등 | drop either guard (`status = 'running'` / `status = 'paused'`) |
// | 승인 hold 보존 | park an `awaiting_approval` run, or resume one to `running` |
// ---------------------------------------------------------------------------

/// The gateway callback surface, which every other test in this file leaves off.
///
/// `AgentGatewaySettings::default()` is `Worker` mode, so the two run-callback
/// routes 403 before they reach the ledger. This test needs them reachable
/// because they are where 「토큰 소진 0」 is actually enforced: a run that cannot
/// complete cannot write a `usage_ledger` row, and that is the sentence D6 makes
/// about credit.
const GATEWAY_SECRET: &str = "live3-run-parking-gateway-2f8b41c6d0e7";

async fn start_server_with_gateway(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_agent_gateway(momo_server::config::AgentGatewaySettings {
        mode: momo_server::config::AgentGatewayMode::Gateway,
        secret: GATEWAY_SECRET.to_string(),
        // The legacy shared secret is the only callback credential a test can
        // mint without standing up per-agent bearer issuance
        // (`gateway_mode_conformance_pg` says the same thing at more length).
        allow_legacy_secret: true,
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

/// Try to complete a run through the gateway, and report `(status, message)`.
///
/// Deliberately sent with **no** job/lease. The `complete` transaction answers
/// an approval hold *before* it judges the lease, on purpose (`agent_gateway`
/// :563-575: "a run parked on a human decision must say so even to a gateway
/// whose lease expired"), so the message alone distinguishes the two refusals:
///
/// | run state | message |
/// |---|---|
/// | not held | `gateway job lease is expired or not owned` |
/// | parked   | `agent run requires a human approval decision (paused)` |
///
/// That pair is the mutation proof for the hold: an assertion that only ever saw
/// the second sentence would pass against a server that refused every
/// completion, and this one cannot.
async fn gateway_complete(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    run: Uuid,
) -> (reqwest::StatusCode, String) {
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/agent-runs/{run}/gateway/complete"
        ))
        .header(momo_server::auth::GATEWAY_SECRET_HEADER, GATEWAY_SECRET)
        .json(&json!({ "status": "succeeded", "output": { "text": "done" } }))
        .send()
        .await
        .expect("gateway completion");
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .unwrap_or_else(|_| json!({ "error": { "message": "unparsed" } }));
    let message = body["error"]["message"].as_str().unwrap_or("").to_string();
    (status, message)
}

/// The `runs_parked` / `runs_resumed` lists the two audit rows carry.
async fn audit_run_list(su: &PgPool, session: Uuid, action: &str, key: &str) -> Vec<String> {
    let details: Vec<Value> = sqlx::query_scalar(
        "SELECT detail FROM audit_log \
          WHERE target_type = 'work_session' AND target_id = $1 AND action = $2 \
          ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(session)
    .bind(action)
    .fetch_all(su)
    .await
    .expect("read the audit detail");
    details
        .first()
        .and_then(|detail| detail[key].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect()
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live3_7_a_control_window_parks_the_run_it_stops_and_four_doors_resume_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    // The role the sweep really runs as, not a superuser that would hide a
    // missing BYPASSRLS (see `momo_notifier_pool`).
    let notifier_pool = momo_notifier_pool().await;
    let base = start_server_with_gateway(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let owner_token = login(&http, &base, workspace, &fixture.owner_email).await;
    let (host_id, host_seed) = register_host(&http, &base, &owner_token, workspace, true).await;
    let agent = seed_agent(&su, &fixture, "live3-parking-intern").await;
    let bearer = agent_bearer(&su, &fixture, agent).await;

    // A session this agent drives, carrying the `audit_log ⋈ work_control` link
    // that is the ledger's own record of "this run is driving that screen" — the
    // same relation `linked_work_session_ids_in_tx` reports on a cancel. Written
    // by the real route rather than seeded, because that link IS what decides
    // who gets parked.
    let driven_session = |run: Uuid| {
        let (http, base, su, fixture) = (&http, &base, &su, &fixture);
        let (owner_token, bearer, host_id) = (&owner_token, &bearer, &host_id);
        async move {
            let session =
                create_session(http, base, owner_token, workspace, fixture.channel, host_id).await;
            publish_display(http, base, &host_seed, workspace, host_id, session).await;
            seed_spawn_lineage(su, fixture, agent, host_id, session).await;
            let response =
                agent_work_control(http, base, bearer, fixture, run, host_id, session, "read")
                    .await;
            assert_eq!(
                response.status(),
                201,
                "the run is entitled to this session before anybody takes control"
            );
            session
        }
    };

    // ---- 1. 창 개설 → paused, and what that costs the gateway ---------------
    let run = seed_run(&su, &fixture, agent).await;
    let session = driven_session(run).await;
    assert_eq!(run_status(&su, run).await, "running");

    // The positive half of the gateway proof: before the window, the completion
    // is refused for a reason that has nothing to do with a hold.
    let (status, message) = gateway_complete(&http, &base, workspace, run).await;
    assert_eq!(status, 409);
    assert_eq!(
        message, "gateway job lease is expired or not owned",
        "before the window this run is not held — it is merely leaseless"
    );

    let response = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200, "the owner takes the keyboard");

    assert_eq!(
        run_status(&su, run).await,
        "paused",
        "ADR-0004 증보 3 D6: 정지되는 것은 에이전트 런 층 — this is the writer \
         LIVE-3 left out"
    );
    assert_eq!(
        audit_run_list(&su, session, "work.display_attach.issued", "runs_parked").await,
        vec![run.to_string()],
        "and the audit log — the surface entitled to names — says which run it \
         stopped, because 「why did 김인턴 go quiet」 has no other answer"
    );

    // 토큰 소진 0. Same request, same everything, one changed fact.
    let (status, message) = gateway_complete(&http, &base, workspace, run).await;
    assert_eq!(status, 409);
    assert_eq!(
        message, "agent run requires a human approval decision (paused)",
        "the completion door is shut, and shut ABOVE the lease judgement — a \
         run that cannot complete cannot bill"
    );
    let usage: i64 = sqlx::query_scalar("SELECT count(*) FROM usage_ledger WHERE run_id = $1")
        .bind(run)
        .fetch_one(&su)
        .await
        .expect("count usage rows");
    assert_eq!(
        usage, 0,
        "「크레딧이 토큰으로 새지 않음」 — the ledger is where that sentence is \
         either true or not"
    );

    // The VM did not move (the OTHER half of D6, asserted here beside the half
    // that did, so a future edit cannot satisfy one by breaking the other).
    let session_status: String =
        sqlx::query_scalar("SELECT status FROM work_session WHERE id = $1")
            .bind(session)
            .fetch_one(&su)
            .await
            .expect("read session status");
    assert_eq!(session_status, "running");

    // Idempotent: re-taking control (the client retry `open_control_window_in_tx`
    // is built for) parks nothing a second time and leaves the run where it is.
    let response = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);
    assert_eq!(run_status(&su, run).await, "paused");
    assert_eq!(window_count(&su, session).await, 1, "still one window");

    // ---- 2. door one: 반환 --------------------------------------------------
    let response = return_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        run_status(&su, run).await,
        "running",
        "「사용자 개입 완료」 — the run comes back to the status the park took"
    );
    assert_eq!(
        audit_run_list(&su, session, "work.display_control.closed", "runs_resumed").await,
        vec![run.to_string()]
    );
    let (_, message) = gateway_complete(&http, &base, workspace, run).await;
    assert_eq!(
        message, "gateway job lease is expired or not owned",
        "and the gateway door is open again — the hold is gone, not merely hidden"
    );

    // Idempotent: a retried return resumes nothing and breaks nothing.
    let response = return_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);
    assert_eq!(run_status(&su, run).await, "running");

    // ---- 3. door two: the lease lapses, and who is left to notice -----------
    //
    // This is the case that made the sweep necessary rather than merely tidy.
    // `work_controls::create` judges the requesting run's eligibility ABOVE the
    // window sweep, so the parked run cannot free itself by asking: it is
    // refused by its own status and never reaches the statement that would have
    // closed the window. Asserted first, because it is the *reason* the loop in
    // `momo-notifier` exists and a reader who does not see it will delete that
    // loop as redundant.
    let response = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);
    assert_eq!(run_status(&su, run).await, "paused");
    lapse_lease(&su, session).await;

    let response = agent_work_control(
        &http, &base, &bearer, &fixture, run, &host_id, session, "read",
    )
    .await;
    assert_eq!(
        response.status(),
        409,
        "the parked run is refused by its own hold, above the window sweep"
    );
    let body: Value = response.json().await.expect("error body");
    assert_eq!(
        body["error"]["message"], "agent run is not eligible for work control",
        "and the refusal is the RUN's, not the session's — which is exactly why \
         asking cannot be what reconciles the lapse"
    );
    assert!(
        open_window(&su, session).await.is_some(),
        "so the lapsed window is still standing, and would stand forever"
    );
    assert_eq!(run_status(&su, run).await, "paused");

    // The author of the lapse: one real sweep iteration, in process.
    //
    // The counts are `>=` rather than `==` because the sweep is deliberately
    // cross-tenant (invariant #6: it asks which workspaces need visiting) and
    // this suite shares one database with every other test in the file. What is
    // exact is the state of THIS window and THIS run, asserted below — the
    // counts only have to prove the loop did work at all.
    let stats =
        momo_notifier::control_window_sweep::sweep_lapsed_control_windows(&notifier_pool, 100)
            .await
            .expect("sweep lapsed control windows");
    assert!(stats.closed >= 1, "a lapsed window, closed by the clock");
    assert!(stats.resumed >= 1, "and the run it was holding, released");
    assert!(
        open_window(&su, session).await.is_none(),
        "this session's window in particular"
    );
    assert_eq!(run_status(&su, run).await, "running");
    assert_eq!(
        last_closed_window_end_reason(&su, session).await.as_deref(),
        Some("expired"),
        "closed with the reason that is TRUE — a lapse is not a 반환"
    );
    let envelopes = closed_control_envelopes(&su, workspace, session).await;
    assert!(
        envelopes
            .iter()
            .any(|e| e["end_reason"] == json!("expired")),
        "재개 시각 reaches the channel even when nobody performed the close"
    );

    // Idempotent: a second sweep finds nothing and moves nothing.
    let stats =
        momo_notifier::control_window_sweep::sweep_lapsed_control_windows(&notifier_pool, 100)
            .await
            .expect("second sweep");
    assert_eq!(stats.closed, 0);
    assert_eq!(stats.resumed, 0);
    assert_eq!(run_status(&su, run).await, "running");

    // …and the agent's reach really is back.
    let response = agent_work_control(
        &http, &base, &bearer, &fixture, run, &host_id, session, "read",
    )
    .await;
    assert_eq!(response.status(), 201);

    // ---- 4. door three: the session ends underneath the keyboard ------------
    let ending_run = seed_run(&su, &fixture, agent).await;
    let ending_session = driven_session(ending_run).await;
    let response = take_control(&http, &base, &owner_token, workspace, ending_session).await;
    assert_eq!(response.status(), 200);
    assert_eq!(run_status(&su, ending_run).await, "paused");

    let response = http
        .patch(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{ending_session}"
        ))
        .bearer_auth(&owner_token)
        .json(&json!({ "status": "ended" }))
        .send()
        .await
        .expect("end the session");
    assert_eq!(response.status(), 200);
    assert!(open_window(&su, ending_session).await.is_none());
    assert_eq!(
        run_status(&su, ending_run).await,
        "running",
        "a session that ends must not leave its runs parked on a window nobody \
         can ever close — that is a permanently silent agent"
    );

    // ---- 5. two windows, one run: the second close is the one that frees it --
    //
    // The clause that is easiest to leave out and hardest to notice. A run
    // driving two screens, both taken over, must not be handed back its reach
    // into the one still being typed into just because the other was returned.
    let shared_run = seed_run(&su, &fixture, agent).await;
    let first = driven_session(shared_run).await;
    let second = driven_session(shared_run).await;
    assert_eq!(
        take_control(&http, &base, &owner_token, workspace, first)
            .await
            .status(),
        200
    );
    assert_eq!(
        take_control(&http, &base, &owner_token, workspace, second)
            .await
            .status(),
        200
    );
    assert_eq!(run_status(&su, shared_run).await, "paused");

    assert_eq!(
        return_control(&http, &base, &owner_token, workspace, first)
            .await
            .status(),
        200
    );
    assert_eq!(
        run_status(&su, shared_run).await,
        "paused",
        "one keyboard was handed back; the other is still held, and the run is \
         held with it"
    );
    assert_eq!(
        return_control(&http, &base, &owner_token, workspace, second)
            .await
            .status(),
        200
    );
    assert_eq!(
        run_status(&su, shared_run).await,
        "running",
        "the LAST close is the one that resumes"
    );

    // ---- 6. the approval hold is not this hold, and neither eats the other ---
    //
    // 「승인 hold와의 상호작용은 재설계 금지」 — the two holds share a status
    // predicate (`is_approval_held`) and nothing else, and this is the assertion
    // that keeps it that way. A window must not park a run parked on a human
    // decision, because the approval's own resume
    // (`requeue_run_from_approval_in_tx`) is guarded on `awaiting_approval` and
    // would silently do nothing to a run a window had moved.
    let awaiting_run = seed_run(&su, &fixture, agent).await;
    let awaiting_session = driven_session(awaiting_run).await;
    let parked =
        sqlx::query("UPDATE agent_run SET status = 'awaiting_approval'::run_status WHERE id = $1")
            .bind(awaiting_run)
            .execute(&su)
            .await
            .expect("park the run on an approval")
            .rows_affected();
    assert_eq!(parked, 1);

    let response = take_control(&http, &base, &owner_token, workspace, awaiting_session).await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        run_status(&su, awaiting_run).await,
        "awaiting_approval",
        "a control window does not get to overwrite a hold that belongs to a \
         human decision"
    );
    assert_eq!(
        return_control(&http, &base, &owner_token, workspace, awaiting_session)
            .await
            .status(),
        200
    );
    assert_eq!(
        run_status(&su, awaiting_run).await,
        "awaiting_approval",
        "…and closing the window does not answer the approval either"
    );

    // ---- 7. a human stop still reaches a parked run -------------------------
    //
    // ADR-0132's 휴먼 정지권 (`is_cancellable` admits `paused`), and the resume's
    // refusal to resurrect what it ended.
    let stopped_run = seed_run(&su, &fixture, agent).await;
    let stopped_session = driven_session(stopped_run).await;
    assert_eq!(
        take_control(&http, &base, &owner_token, workspace, stopped_session)
            .await
            .status(),
        200
    );
    assert_eq!(run_status(&su, stopped_run).await, "paused");

    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/agent-runs/{stopped_run}/cancel"
        ))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("stop the parked run");
    assert_eq!(
        response.status(),
        200,
        "being in the room is the right to stop what is happening in it, and a \
         parked run is still happening"
    );
    assert_eq!(run_status(&su, stopped_run).await, "cancelled");

    assert_eq!(
        return_control(&http, &base, &owner_token, workspace, stopped_session)
            .await
            .status(),
        200
    );
    assert_eq!(
        run_status(&su, stopped_run).await,
        "cancelled",
        "a close must never resurrect a run a human ended — the resume's \
         `status = 'paused'` guard is what refuses"
    );
}

// ---------------------------------------------------------------------------
// live3-8 / live3-9 — one run, two sessions, two transactions (#1425 H1)
//
// `live3_7` proves the park/resume pair is right when two windows are opened and
// closed one after another. These two prove it is right when they are **not**,
// which is a different question with a different answer, and the answer was
// wrong.
//
// A run may drive more than one session. `lock_attach_target_in_tx` serializes
// everything that happens to ONE session's window, and nothing serialized
// session A's window work against session B's — while both statements in the
// pair decide from a `display_control_window` read, and under READ COMMITTED
// that read sees only COMMITTED windows. Two transactions on two sessions of one
// run could therefore each decide against a world the other was halfway through
// changing:
//
//   * `live3_8` — B's window opens (its park moves nothing: the run is already
//     `paused` under A) while A's return resumes on a snapshot without B in it.
//     The run goes `running` with a person's keyboard live on B — the gateway
//     hold coming off mid-login, which is 증보 3 D6's 「토큰 소진 0」 broken by an
//     interleaving rather than by a missing statement.
//   * `live3_9` — A and B close at the same instant, each resume sees the other
//     window still standing, and both skip. Both windows end and the run is
//     `paused` with nothing left that could ever resume it: the sweep looks only
//     at OPEN windows, and a replayed close closes nothing. The agent is silent
//     until a human cancels the run.
//
// They are two tests rather than one for the reason every mutation table in this
// file is written the way it is: each half is broken by a **different** missing
// lock, and a single test would only ever report the first one.
//
// Both drive the domain functions on two real connections instead of asserting
// that a `FOR UPDATE` appears somewhere, because what is under test is what two
// UNCOMMITTED transactions can see of each other — and no request can show that.
// An HTTP call is committed by the time it answers.
//
// | test | revert that makes it red |
// |---|---|
// | `live3_8` | drop the lock from `park_runs_for_control_window_in_tx` — the already-`paused` park is exactly the path that used to pass through unlocked — or from `resume_runs_from_control_window_in_tx` |
// | `live3_9` | drop the lock from `resume_runs_from_control_window_in_tx`, or take it before the caller's own window close instead of after |
// ---------------------------------------------------------------------------

/// Open a tenant transaction the way `momo_db::with_tenant_tx` does, but leave
/// the commit in the caller's hands.
///
/// On the `momo_app` role under the real GUC rather than on the superuser pool
/// the fixtures in this file use, and the difference is load-bearing: RLS FORCE
/// applies to `agent_run`, and a `FOR UPDATE` whose rows a policy filters away
/// locks nothing at all.
///
/// `lock_timeout` is the hang guard. A lock these tests expect to be released in
/// well under a second becomes a failure rather than a suite that never
/// finishes.
async fn open_tenant_tx(
    pool: &PgPool,
    workspace: Uuid,
) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = pool.begin().await.expect("begin a tenant transaction");
    momo_db::rebind_tenant_guc(&mut tx, workspace)
        .await
        .expect("bind app.workspace_id");
    sqlx::query("SET LOCAL lock_timeout = '30s'")
        .execute(&mut *tx)
        .await
        .expect("arm the hang guard");
    tx
}

/// `issue_in_tx`'s two control writes — mint the grant, open its window — in a
/// transaction the caller decides when to commit.
async fn open_control_window_uncommitted(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    workspace: Uuid,
    host_id: &str,
    owner: Uuid,
    session: Uuid,
) {
    let capability = momo_t3::issue_attach_capability_in_tx(
        tx,
        workspace,
        session,
        Uuid::parse_str(host_id).expect("host uuid"),
        owner,
        &momo_t3::mint_capability_token(),
        momo_t3::AttachMode::Controller,
        momo_t3::AttachKind::Display,
    )
    .await
    .expect("mint the controller grant");
    momo_t3::open_control_window_in_tx(tx, workspace, session, owner, capability.id)
        .await
        .expect("open the control window")
        .expect("nobody else holds this session's keyboard");
}

/// Close a window and settle its runs, the way every close path does: the window
/// write **first**, the run lock after it.
async fn close_and_resume_in_tx(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    workspace: Uuid,
    session: Uuid,
) -> Vec<Uuid> {
    momo_t3::close_control_window_in_tx(
        tx,
        workspace,
        session,
        momo_t3::ControlWindowEndReason::Returned,
    )
    .await
    .expect("close the window")
    .expect("there was a window to return");
    momo_agent::resume_runs_from_control_window_in_tx(tx, workspace, session)
        .await
        .expect("resume whatever this close frees")
        .iter()
        .map(|run| run.run_id)
        .collect()
}

/// Long enough for the racing transaction to reach its lock and block on it.
///
/// A **red-proof** device, not a synchronisation one: the assertions are about
/// the state both transactions leave behind, and the fixed build reaches that
/// state whatever the timing. What the wait buys is that a build without the
/// lock reliably reaches the interleaving it is broken by, instead of
/// accidentally running in the safe order and passing.
const INTERLEAVE_WAIT: std::time::Duration = std::time::Duration::from_millis(750);

/// Join a raced transaction, failing rather than hanging if it never lands.
async fn settle_race<T: Send + 'static>(handle: tokio::task::JoinHandle<T>) -> T {
    tokio::time::timeout(std::time::Duration::from_secs(60), handle)
        .await
        .expect("the raced transaction finished — a timeout here is a lock nobody released")
        .expect("the raced transaction did not panic")
}

/// The fixture both tests need: an agent whose runs really do drive real
/// sessions, and the pool that can open a transaction beside the server's.
struct CrossSessionRig {
    su: PgPool,
    app_pool: PgPool,
    base: String,
    http: reqwest::Client,
    fixture: Fixture,
    owner_token: String,
    host_id: String,
    host_seed: [u8; 32],
    agent: Uuid,
    bearer: String,
}

impl CrossSessionRig {
    async fn new(handle: &str) -> Self {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        let app_pool = momo_app_pool().await;
        let fixture = seed(&su, &app_pool).await;
        // Cloned rather than moved: these tests need a connection of their own
        // beside the server's, on the same role the server uses.
        let base = start_server(app_pool.clone()).await;
        let http = reqwest::Client::new();
        let owner_token = login(&http, &base, fixture.workspace, &fixture.owner_email).await;
        let (host_id, host_seed) =
            register_host(&http, &base, &owner_token, fixture.workspace, true).await;
        let agent = seed_agent(&su, &fixture, handle).await;
        let bearer = agent_bearer(&su, &fixture, agent).await;
        Self {
            su,
            app_pool,
            base,
            http,
            fixture,
            owner_token,
            host_id,
            host_seed,
            agent,
            bearer,
        }
    }

    fn workspace(&self) -> Uuid {
        self.fixture.workspace
    }

    async fn run(&self) -> Uuid {
        seed_run(&self.su, &self.fixture, self.agent).await
    }

    /// `live3_7`'s fixture: a session this run drives, carrying the
    /// `audit_log ⋈ work_control` link that decides who gets parked. Written by
    /// the real route, because that link IS the relation under test.
    async fn driven_session(&self, run: Uuid) -> Uuid {
        let session = create_session(
            &self.http,
            &self.base,
            &self.owner_token,
            self.workspace(),
            self.fixture.channel,
            &self.host_id,
        )
        .await;
        publish_display(
            &self.http,
            &self.base,
            &self.host_seed,
            self.workspace(),
            &self.host_id,
            session,
        )
        .await;
        seed_spawn_lineage(&self.su, &self.fixture, self.agent, &self.host_id, session).await;
        let response = agent_work_control(
            &self.http,
            &self.base,
            &self.bearer,
            &self.fixture,
            run,
            &self.host_id,
            session,
            "read",
        )
        .await;
        assert_eq!(response.status(), 201, "the run drives this session");
        session
    }

    async fn take_control(&self, session: Uuid) {
        let response = take_control(
            &self.http,
            &self.base,
            &self.owner_token,
            self.workspace(),
            session,
        )
        .await;
        assert_eq!(response.status(), 200, "the owner takes the keyboard");
    }

    async fn run_status(&self, run: Uuid) -> String {
        run_status(&self.su, run).await
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live3_8_a_window_opening_elsewhere_outlasts_a_return_that_races_it() {
    let rig = CrossSessionRig::new("live3-crossing-intern").await;
    let workspace = rig.workspace();

    let run = rig.run().await;
    let taken = rig.driven_session(run).await;
    let opening = rig.driven_session(run).await;

    rig.take_control(taken).await;
    assert_eq!(rig.run_status(run).await, "paused");

    // The opening transaction: the second window exists, uncommitted.
    let mut opening_tx = open_tenant_tx(&rig.app_pool, workspace).await;
    open_control_window_uncommitted(
        &mut opening_tx,
        workspace,
        &rig.host_id,
        rig.fixture.owner,
        opening,
    )
    .await;
    let parked =
        momo_agent::park_runs_for_control_window_in_tx(&mut opening_tx, workspace, opening)
            .await
            .expect("park the runs this window stops");
    assert!(
        parked.is_empty(),
        "the run is already paused under the first window, so this park moves \
         NOTHING — and that is precisely the path that used to take no lock, and \
         so let the return below decide without it"
    );

    // …and the return of the FIRST keyboard, on its own connection, deciding
    // meanwhile.
    let returning = {
        let pool = rig.app_pool.clone();
        tokio::spawn(async move {
            let mut tx = open_tenant_tx(&pool, workspace).await;
            let resumed = close_and_resume_in_tx(&mut tx, workspace, taken).await;
            tx.commit().await.expect("commit the return");
            resumed
        })
    };
    tokio::time::sleep(INTERLEAVE_WAIT).await;
    opening_tx.commit().await.expect("commit the second window");
    let resumed = settle_race(returning).await;

    assert!(
        resumed.is_empty(),
        "the return handed the run back as though nobody else held a keyboard — \
         but the second window is standing, and a run resumed under it is an \
         agent reading a screen somebody is typing a password into (증보 3 D3/D6)"
    );
    assert_eq!(
        rig.run_status(run).await,
        "paused",
        "「사용자 개입 대기」 survives a return on another session of the same run"
    );
    assert!(
        open_window(&rig.su, opening).await.is_some(),
        "and the fixture is the one it claims to be: the second window really is \
         still open at the moment that verdict is read"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live3_9_two_closes_at_once_still_leave_exactly_one_resume() {
    let rig = CrossSessionRig::new("live3-double-close-intern").await;
    let workspace = rig.workspace();

    let shared = rig.run().await;
    let first = rig.driven_session(shared).await;
    let second = rig.driven_session(shared).await;
    rig.take_control(first).await;
    rig.take_control(second).await;
    assert_eq!(rig.run_status(shared).await, "paused");

    let mut first_tx = open_tenant_tx(&rig.app_pool, workspace).await;
    let resumed_first = close_and_resume_in_tx(&mut first_tx, workspace, first).await;
    assert!(
        resumed_first.is_empty(),
        "the first close defers to the second window — `live3_7`'s rule, and \
         correct here"
    );

    let closing_second = {
        let pool = rig.app_pool.clone();
        tokio::spawn(async move {
            let mut tx = open_tenant_tx(&pool, workspace).await;
            let resumed = close_and_resume_in_tx(&mut tx, workspace, second).await;
            tx.commit().await.expect("commit the second return");
            resumed
        })
    };
    tokio::time::sleep(INTERLEAVE_WAIT).await;
    first_tx.commit().await.expect("commit the first return");
    let resumed_second = settle_race(closing_second).await;

    assert_eq!(
        resumed_second,
        vec![shared],
        "「the LAST close is the one that resumes」 has to mean the last close to \
         COMMIT — two closes that each defer to the window the other is closing \
         leave nobody to do it, and nothing ever comes back for the run"
    );
    assert_eq!(
        rig.run_status(shared).await,
        "running",
        "both keyboards are back, so the agent is back — a run parked by windows \
         that have ALL ended has no other door: the sweep reads open windows \
         only, and a replayed return closes nothing"
    );
    assert!(
        open_window(&rig.su, first).await.is_none() && open_window(&rig.su, second).await.is_none(),
        "and both windows really did close — the fixture is the state it claims"
    );
}

// ---------------------------------------------------------------------------
// LIVE-4 — the login handoff card, and the three ways it used to go stale
//          (freeze, and the re-freeze that followed it)
//
// | test | revert that makes it red |
// |---|---|
// | `live4_1_the_handoff_card_hears_the_boundary_and_the_join_survives_a_shouted_uuid` | drop the `message.edited` publish from `stamp_handoff_cards_in_tx` (or from the notifier's sweep), put the model's raw `session_id` back into `props` instead of the canonical one, or drop the end-key delete from the open stamp's merge |
//
// Both halves are about the same card and both were silent failures. The stamp
// wrote `props` with no envelope, so an OPEN timeline never heard it: the card
// kept saying 「사람이 조작 중」 until a reload, and 재개 pressed on that stale
// card claimed 「개입 완료」 about a window that had already lapsed. And the join
// that stamp runs on is text — `props->>'session_id'` against `uuid::text` — so
// a model that wrote its UUID in capitals produced a card the stamp could never
// find at all, which made the first failure permanent rather than merely
// temporary.
//
// The third is the same card told to hold two windows. `props || facts` adds and
// never removes, so a pending handoff that lapsed and was taken up again wore
// the new 정지 시각 over the old 재개 시각 — a live window rendered closed, with
// its return dated before its stop.
// ---------------------------------------------------------------------------

/// A real login handoff card: the approval row, the `approval_request` message
/// built by the **producer's own** props function, and the link between them.
///
/// `session_id_as_written` is what the model put in its tool arguments, not what
/// the card ends up carrying — the difference is the point of the test.
async fn seed_login_handoff_card(
    su: &PgPool,
    fixture: &Fixture,
    agent: Uuid,
    run: Uuid,
    session_id_as_written: &str,
) -> Uuid {
    let workspace = fixture.workspace;
    let channel = fixture.channel;
    let call = momo_agent::tools::ToolCall {
        call_id: format!("call_{}", Uuid::new_v4().simple()),
        name: momo_agent::tools::WORK_SESSION_LOGIN_HANDOFF.to_string(),
        arguments: json!({
            "session_id": session_id_as_written,
            "reason": "배포 콘솔이 2단계 인증을 요구합니다.",
        }),
    };
    let expires_at =
        momo_agent::default_expires_at(chrono::Utc::now(), momo_agent::DEFAULT_TTL_SECONDS);
    momo_db::with_tenant_tx(su, workspace, move |conn| {
        Box::pin(async move {
            let approval_id = momo_agent::create_pending_approval_in_tx(
                conn,
                workspace,
                momo_agent::NewApproval {
                    run_id: run,
                    channel_id: channel,
                    requested_by: agent,
                    action_type: momo_agent::tools::ACTION_TYPE_TOOL_CALL.to_string(),
                    payload: json!({ "tool": call.name }),
                    expires_at,
                },
            )
            .await?;
            let card = momo_messaging::send_message_in_tx(
                conn,
                workspace,
                momo_messaging::NewMessage {
                    channel_id: channel,
                    author_member_id: agent,
                    message_type: momo_messaging::MessageType::ApprovalRequest,
                    body: Some(momo_agent::approval_request_body(&call.name)),
                    props: momo_agent::approval_request_props(
                        approval_id,
                        run,
                        channel,
                        momo_agent::tools::ACTION_TYPE_TOOL_CALL,
                        &call,
                        "{}",
                        expires_at,
                        None,
                    ),
                    root_id: None,
                    reply_to_id: None,
                    client_msg_id: Some(approval_id),
                    run_id: Some(run),
                    hlc_ts: None,
                    hlc_count: None,
                },
            )
            .await?;
            momo_agent::attach_request_message_in_tx(conn, workspace, approval_id, card.message.id)
                .await?;
            Ok(card.message.id)
        })
    })
    .await
    .expect("seed the login handoff card")
}

/// The card's `props`, straight from the row the timeline renders.
async fn card_props(su: &PgPool, message_id: Uuid) -> Value {
    sqlx::query_scalar("SELECT props FROM message WHERE id = $1")
        .bind(message_id)
        .fetch_one(su)
        .await
        .expect("read the card props")
}

/// Every `message.edited` frame published for one message, oldest first.
///
/// Reads the outbox rather than a socket for the reason the whole suite does:
/// the row IS the publication (invariant #3, REST → PG → outbox → relay), and a
/// stamp that wrote no row is a stamp no connected client can ever learn about.
async fn edited_frames(su: &PgPool, workspace: Uuid, message_id: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload->'data'->'payload' FROM outbox \
          WHERE workspace_id = $1 \
            AND payload->'data'->>'type' = 'message.edited' \
            AND payload->'data'->'payload'->>'id' = $2::text \
          ORDER BY id",
    )
    .bind(workspace)
    .bind(message_id.to_string())
    .fetch_all(su)
    .await
    .expect("read this card's edited frames")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live4_1_the_handoff_card_hears_the_boundary_and_the_join_survives_a_shouted_uuid() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let notifier_pool = momo_notifier_pool().await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let owner_token = login(&http, &base, workspace, &fixture.owner_email).await;
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

    let agent = seed_agent(&su, &fixture, "live4-handoff-intern").await;
    let run = seed_run(&su, &fixture, agent).await;

    // The model shouted its UUID. Every id-shaped spelling reaches the tool
    // executor intact (`Uuid::parse_str` takes capitals), so nothing upstream
    // refuses this card — which is exactly why the card has to normalize.
    let card = seed_login_handoff_card(
        &su,
        &fixture,
        agent,
        run,
        &session.to_string().to_uppercase(),
    )
    .await;
    assert_eq!(
        card_props(&su, card).await["session_id"],
        json!(session.to_string()),
        "the card carries the spelling PostgreSQL renders — the stamp's join is \
         `props->>'session_id' = uuid::text`, and a capitalized copy matches \
         nothing forever"
    );

    // ---- 1. the window opens: 정지 시각, and a frame that says so ------------
    let response = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200, "the owner takes the keyboard");

    let props = card_props(&su, card).await;
    let started_at = props["control_started_at_ms"]
        .as_i64()
        .expect("정지 시각 landed on the card");
    assert!(
        props.get("control_ended_at_ms").is_none(),
        "the window is still open, and a card must not date a return that has \
         not happened"
    );

    let frames = edited_frames(&su, workspace, card).await;
    assert_eq!(
        frames.len(),
        1,
        "the stamp is a WRITE to a message row, and the only thing an open \
         timeline hears about a message row is a message frame — #1152's \
         `message.edited`, reused, not reinvented"
    );
    assert_eq!(
        frames[0]["props"]["control_started_at_ms"],
        json!(started_at),
        "and the frame carries the whole props, which is why no client needed a \
         new consumer"
    );
    assert_eq!(
        frames[0]["props"]["kind"],
        json!(momo_agent::approval::LOGIN_HANDOFF_PROPS_KIND),
        "the card is still the card — `||` adds keys and rewrites nothing"
    );
    assert!(
        frames[0].get("edited_at_ms").is_none_or(Value::is_null),
        "「수정됨」 is a claim that a person revised what they said, and a server \
         stamping a boundary fact did not (stream_message_body_in_tx's rule)"
    );

    // ---- 2. the lease lapses: 재개 시각, and a second frame ------------------
    //
    // The lapse, deliberately, because it is the close nobody performs: its only
    // author is the notifier, and a card left uncorrected by it has no other
    // door. This is also the branch that made the stale card actively lie —
    // 재개 on a card still showing 「사람이 조작 중」 says 「개입 완료」 about a
    // window that ended by walking away.
    lapse_lease(&su, session).await;
    let stats =
        momo_notifier::control_window_sweep::sweep_lapsed_control_windows(&notifier_pool, 100)
            .await
            .expect("sweep lapsed control windows");
    assert!(stats.closed >= 1);

    let props = card_props(&su, card).await;
    // The fixture ages `started_at` to produce a lapse the system can actually
    // reach (`lapse_lease`), so the stamp re-states the window's CURRENT 정지
    // 시각 rather than the one the open wrote. What must hold is the shape a
    // reader depends on: both halves present, and the return after the stop.
    let stopped_at = props["control_started_at_ms"]
        .as_i64()
        .expect("정지 시각 survived the close");
    let resumed_at = props["control_ended_at_ms"]
        .as_i64()
        .expect("재개 시각 landed on the card");
    assert!(
        resumed_at > stopped_at,
        "a card that dates the return before the stop is a card that cannot be \
         read"
    );
    assert_eq!(
        props["control_end_reason"],
        json!("expired"),
        "the reason that is TRUE — a lapse is not a 반환, and the card must not \
         let a reader assume the sign-in finished"
    );

    let frames = edited_frames(&su, workspace, card).await;
    assert_eq!(
        frames.len(),
        2,
        "the sweep composes the three close steps itself, so it has to publish \
         the card's frame itself too"
    );
    assert_eq!(frames[1]["props"]["control_end_reason"], json!("expired"));
    assert_eq!(
        frames[1]["seq"], frames[0]["seq"],
        "a growing card is not new unread messages — the frame reuses the \
         message's own seq, exactly as every interaction frame does"
    );

    // ---- 3. the same pending card is taken up AGAIN -------------------------
    //
    // A lapse is not an answer: the handoff is still pending, the person comes
    // back, and the second window is the SAME card's second stop. What the card
    // must not do is wear both windows at once. `||` alone left the previous
    // lapse's 재개 시각 and its 사유 sitting under the new 정지 시각, and a card
    // carrying both is read as closed — 「개입 완료」 about a keyboard somebody is
    // holding right now, dated before the stop it is paired with.
    let response = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200, "the owner takes the keyboard again");

    let props = card_props(&su, card).await;
    let retaken_at = props["control_started_at_ms"]
        .as_i64()
        .expect("the second 정지 시각 landed on the card");
    assert!(
        retaken_at >= resumed_at,
        "the card dates the new stop after the return that preceded it"
    );
    assert!(
        props.get("control_ended_at_ms").is_none(),
        "the window is open again, and the previous lapse's 재개 시각 must not \
         survive under it — a present control_ended_at_ms IS how every client \
         decides the window has closed (parseLoginHandoffControl)"
    );
    assert!(
        props.get("control_end_reason").is_none(),
        "…and neither may its 사유: 「자리 비움으로 종료」 printed over a live \
         window is the copy of a card that has stopped tracking reality"
    );

    let frames = edited_frames(&su, workspace, card).await;
    assert_eq!(
        frames.len(),
        3,
        "the re-open moved the card, so it announced it"
    );
    assert!(
        frames[2]["props"].get("control_ended_at_ms").is_none()
            && frames[2]["props"].get("control_end_reason").is_none(),
        "and the frame carries the same card the row does — both clients merge \
         this props in place, so a stale key here is a stale card there"
    );

    // Closed again, so the settled-card check below judges the state it always
    // judged: a card that has told its whole story, stop and return both.
    lapse_lease(&su, session).await;
    let stats =
        momo_notifier::control_window_sweep::sweep_lapsed_control_windows(&notifier_pool, 100)
            .await
            .expect("sweep the second lapse");
    assert!(stats.closed >= 1);
    assert_eq!(
        card_props(&su, card).await["control_end_reason"],
        json!("expired"),
        "the close writes the end keys back — the delete above is the OPEN \
         stamp's, not a key this ledger stopped keeping"
    );

    // ---- 4. a settled card is not rewritten by a later window ---------------
    sqlx::query(
        "UPDATE approval \
            SET status = 'approved', decided_by = $2, decided_at = clock_timestamp() \
          WHERE request_message_id = $1",
    )
    .bind(card)
    .bind(fixture.owner)
    .execute(&su)
    .await
    .expect("settle the approval");
    let before = edited_frames(&su, workspace, card).await.len();
    let response = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        card_props(&su, card).await["control_end_reason"],
        json!("expired"),
        "a settled handoff has told its story; a second window on the same \
         session must not rewrite it"
    );
    assert_eq!(
        edited_frames(&su, workspace, card).await.len(),
        before,
        "and a card that did not move is a card with nothing to announce"
    );
}

// ---------------------------------------------------------------------------
// live5a-1 — every grant carries a relay credential of its own, and an instance
//            that was given no relay carries none
// ---------------------------------------------------------------------------

/// Split the coturn REST username back into its two halves.
///
/// The format is coturn's, not ours (`<unix expiry>:<subject>`), so parsing it
/// here rather than trusting a struct is the point: this is what the relay will
/// do with the string, and a username the relay cannot split is a credential it
/// will answer 401 to.
fn split_turn_username(username: &str) -> (i64, String) {
    let (expiry, subject) = username
        .split_once(':')
        .unwrap_or_else(|| panic!("coturn parses `<expiry>:<subject>`, got {username:?}"));
    (
        expiry
            .parse::<i64>()
            .unwrap_or_else(|_| panic!("the expiry half must be unix seconds, got {expiry:?}")),
        subject.to_string(),
    )
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live5a_1_a_grant_carries_its_own_expiring_relay_credential() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server_with_turn(app_pool, Some(test_turn_policy())).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let owner_token = login(&http, &base, workspace, &fixture.owner_email).await;
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

    // ---- the browser's copy -------------------------------------------------
    let response =
        issue_display_capability(&http, &base, &owner_token, workspace, session, None).await;
    assert_eq!(response.status(), 200);
    let grant: Value = response.json().await.expect("grant body");
    let servers = grant["ice_servers"]
        .as_array()
        .expect("ice_servers is always present, even when empty");
    assert_eq!(
        servers.len(),
        1,
        "one relay carrying both transports — two entries would look like two \
         relays to fail over between"
    );
    let urls: Vec<&str> = servers[0]["urls"]
        .as_array()
        .expect("urls")
        .iter()
        .map(|url| url.as_str().expect("url string"))
        .collect();
    assert_eq!(
        urls, TEST_TURN_URLS,
        "ADR-0165 D3: the relay is the one the operator named and nobody else's"
    );

    let browser_username = servers[0]["username"].as_str().expect("username");
    let (expiry, subject) = split_turn_username(browser_username);
    assert_eq!(
        subject,
        session.to_string(),
        "the subject is the work session, so a coturn log line answers 「어느 \
         세션이 relay를 썼나」 — the static credential this replaces answered it \
         for every session at once, i.e. not at all"
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("a clock after 1970")
        .as_secs() as i64;
    assert!(
        expiry > now && expiry <= now + TEST_TURN_TTL_SECONDS + 5,
        "the credential expires on its own — that IS the ephemerality. \
         expiry={expiry} now={now}"
    );

    // The wiring, proved against the policy rather than against a second copy of
    // the HMAC: re-minting at the instant this username was minted must produce
    // this exact credential. The derivation itself is pinned in `momo_t3::turn`'s
    // unit tests against an independently computed literal.
    let reminted = test_turn_policy().ice_servers_at(session, expiry - TEST_TURN_TTL_SECONDS);
    assert_eq!(
        servers[0]["credential"].as_str().expect("credential"),
        reminted[0].credential,
        "the route mints from the configured policy, this session, and this TTL"
    );

    // ---- the producer's copy ------------------------------------------------
    let capability = grant["capability_token"].as_str().expect("token");
    let response = validate_display(
        &http, &base, &host_seed, workspace, &host_id, capability, false,
    )
    .await;
    assert_eq!(response.status(), 200);
    let validated: Value = response.json().await.expect("validation body");
    let producer_servers = validated["ice_servers"]
        .as_array()
        .expect("the producer is served the same field");
    let (_, producer_subject) =
        split_turn_username(producer_servers[0]["username"].as_str().expect("username"));
    assert_eq!(
        producer_subject, subject,
        "both ends of one media path allocate under one subject — relay<->relay \
         is the only ICE path we have (증보 1 D3-1), so the two halves must be \
         joinable in the relay's own log"
    );

    // Re-validation mints a FRESH credential rather than replaying the grant's.
    //
    // This is a claim about the SERVER and nothing else, and the distinction is
    // load-bearing enough to say twice: the shipped producer installs a
    // credential once per peer connection and discards these later mints, since
    // `webrtcbin` cannot swap a TURN server on a running ICE agent. So what is
    // proved here is that a client which CAN take a fresh credential — the next
    // viewer's pipeline, or a future renegotiating producer — is handed one with
    // its full TTL ahead of it, rather than a replay of the grant's already-aged
    // copy. Whether a live stream can use it is LIVE-5c's measurement
    // (`template.spec.json` → `unverified.credentialCeiling`).
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    let response = validate_display(
        &http, &base, &host_seed, workspace, &host_id, capability, true,
    )
    .await;
    assert_eq!(response.status(), 200);
    let revalidated: Value = response.json().await.expect("re-validation body");
    let (renewed_expiry, _) = split_turn_username(
        revalidated["ice_servers"][0]["username"]
            .as_str()
            .expect("username"),
    );
    assert!(
        renewed_expiry > expiry,
        "every validate mints against the clock of that call; replaying the \
         grant's credential would hand the next viewer one already partly \
         spent. renewed={renewed_expiry} first={expiry}"
    );

    // ---- and an instance that was given no relay ---------------------------
    // The state EVERY deployment is in on the day this lands. It must not be an
    // error and must not be an absent field: the producer template still carries
    // the static credential the install runbook shipped, and that overlap is the
    // whole retirement order — 신규 단명 자격 실증 먼저, 정적 제거는 그다음.
    let bare_pool = momo_app_pool().await;
    let bare_base = start_server_with_turn(bare_pool, None).await;
    let bare_token = login(&http, &bare_base, workspace, &fixture.owner_email).await;
    let response =
        issue_display_capability(&http, &bare_base, &bare_token, workspace, session, None).await;
    assert_eq!(
        response.status(),
        200,
        "no relay policy is not a closed surface"
    );
    let bare_grant: Value = response.json().await.expect("grant body");
    assert_eq!(
        bare_grant["ice_servers"],
        json!([]),
        "empty, not absent: a client must be able to tell an instance with no \
         relay from one too old to have the field"
    );
}

// ---------------------------------------------------------------------------
// live5a-2 — taking control closes the session to teammates, and every one of
//            the three closes puts back exactly what the owner had chosen
// ---------------------------------------------------------------------------

async fn observation_of(su: &PgPool, session: Uuid) -> String {
    sqlx::query_scalar("SELECT observation FROM work_session WHERE id = $1")
        .bind(session)
        .fetch_one(su)
        .await
        .expect("read the session's observation")
}

async fn prior_observation_of(su: &PgPool, session: Uuid) -> Option<String> {
    sqlx::query_scalar(
        "SELECT prior_observation FROM display_control_window \
          WHERE work_session_id = $1 ORDER BY started_at DESC LIMIT 1",
    )
    .bind(session)
    .fetch_one(su)
    .await
    .expect("read the window's displaced observation")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live5a_2_control_closes_observation_and_all_three_closes_restore_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let owner_token = login(&http, &base, workspace, &fixture.owner_email).await;
    let (host_id, host_seed) = register_host(&http, &base, &owner_token, workspace, true).await;

    let fresh_session = |label: &'static str| {
        let http = http.clone();
        let base = base.clone();
        let owner_token = owner_token.clone();
        let host_id = host_id.clone();
        let channel = fixture.channel;
        async move {
            let session =
                create_session(&http, &base, &owner_token, workspace, channel, &host_id).await;
            publish_display(&http, &base, &host_seed, workspace, &host_id, session).await;
            let response = take_control(&http, &base, &owner_token, workspace, session).await;
            assert_eq!(response.status(), 200, "{label}: control opens");
            session
        }
    };

    // ---- 1. the person hands it back ---------------------------------------
    let returned = fresh_session("return").await;
    assert_eq!(
        observation_of(&su, returned).await,
        "owner_only",
        "a control window exists so somebody can type a password; a teammate \
         watching that happen is exactly what 증보 3 D2 forbids"
    );
    assert_eq!(
        prior_observation_of(&su, returned).await.as_deref(),
        Some("open"),
        "the window carries what it displaced, so the close can put back the \
         owner's own setting rather than a default"
    );
    let response = return_control(&http, &base, &owner_token, workspace, returned).await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        observation_of(&su, returned).await,
        "open",
        "returned: the setting comes back with the keyboard"
    );

    // ---- 2. the lease lapses, and nobody performs the close -----------------
    // The restore rides inside the close statement precisely for this path:
    // there is no actor here to remember it.
    let lapsed = fresh_session("lapse").await;
    assert_eq!(observation_of(&su, lapsed).await, "owner_only");
    lapse_lease(&su, lapsed).await;
    let response = return_control(&http, &base, &owner_token, workspace, lapsed).await;
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.expect("return body");
    assert_eq!(
        body["closed"],
        json!(false),
        "the lapse closed it first — this call found nothing standing"
    );
    assert_eq!(
        observation_of(&su, lapsed).await,
        "open",
        "expired: a window nobody closed still restores the setting, or a person \
         who walked away leaves their session closed to the team forever"
    );

    // ---- 3. the session ends underneath it ---------------------------------
    let ended = fresh_session("session end").await;
    assert_eq!(observation_of(&su, ended).await, "owner_only");
    let response = http
        .patch(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{ended}"
        ))
        .bearer_auth(&owner_token)
        .json(&json!({ "status": "ended" }))
        .send()
        .await
        .expect("end the session");
    assert_eq!(response.status(), 200);
    assert_eq!(
        observation_of(&su, ended).await,
        "open",
        "session_ended: the third close is the third restore"
    );

    // ---- 4. the close nobody performs AND no route detects -----------------
    // `momo-notifier`'s sweep is the fourth author 076's header did not have and
    // #1425 added, and it is the one that matters most here: on the agent's own
    // path there is no reader to notice a lapse, so a session whose watcher shut
    // their laptop would otherwise sit `owner_only` until somebody happened to
    // look at it. The restore rides inside the sweep's own statement for exactly
    // that reason — there is nobody here to remember it.
    let swept = fresh_session("notifier sweep").await;
    assert_eq!(observation_of(&su, swept).await, "owner_only");
    lapse_lease(&su, swept).await;
    let notifier_pool = momo_notifier_pool().await;
    momo_notifier::control_window_sweep::sweep_lapsed_control_windows(&notifier_pool, 100)
        .await
        .expect("one sweep iteration");
    assert!(
        open_window(&su, swept).await.is_none(),
        "the sweep closed it"
    );
    assert_eq!(
        observation_of(&su, swept).await,
        "open",
        "…and put the owner's setting back, with no route and no person involved"
    );

    // ---- a session the owner had ALREADY closed is left alone --------------
    // The failure this guards is the opposite one: a window that "restored"
    // `open` onto a session its owner deliberately closed would widen a setting
    // nobody asked to widen, using a default as the excuse.
    let already_closed = create_session(
        &http,
        &base,
        &owner_token,
        workspace,
        fixture.channel,
        &host_id,
    )
    .await;
    publish_display(
        &http,
        &base,
        &host_seed,
        workspace,
        &host_id,
        already_closed,
    )
    .await;
    sqlx::query("UPDATE work_session SET observation = 'owner_only' WHERE id = $1")
        .bind(already_closed)
        .execute(&su)
        .await
        .expect("close observation first");
    let response = take_control(&http, &base, &owner_token, workspace, already_closed).await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        prior_observation_of(&su, already_closed).await,
        None,
        "this window displaced nothing, and NULL is how it says so"
    );
    let response = return_control(&http, &base, &owner_token, workspace, already_closed).await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        observation_of(&su, already_closed).await,
        "owner_only",
        "restoring a value that was never displaced would be a setting changed \
         by a system the person never asked about it"
    );
}

// ---------------------------------------------------------------------------
// live5a-3 — the mutation proof: a teammate's LIVE stream ends when control
//            opens, and comes back when it closes
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live5a_3_a_teammates_live_stream_ends_when_control_opens() {
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

    // A teammate is already watching — the state that makes this dangerous.
    let response =
        issue_display_capability(&http, &base, &watcher_token, workspace, session, None).await;
    assert_eq!(response.status(), 200);
    let watcher_grant: Value = response.json().await.expect("watcher grant");
    let watcher_capability = watcher_grant["capability_token"]
        .as_str()
        .expect("token")
        .to_string();

    // The control, in the sense `live3_2`'s header means: the watcher is FULLY
    // entitled and the test watches the stream succeed before it is cut. An
    // assertion that only ever saw the refusal would pass against a build that
    // refuses everything.
    let live = |capability: String| {
        let http = http.clone();
        let base = base.clone();
        let host_id = host_id.clone();
        async move {
            validate_display(
                &http,
                &base,
                &host_seed,
                workspace,
                &host_id,
                &capability,
                true,
            )
            .await
            .status()
        }
    };
    assert_eq!(
        live(watcher_capability.clone()).await,
        200,
        "the teammate's stream is live before anybody takes the keyboard"
    );

    // ---- the owner takes control -------------------------------------------
    let response = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);

    assert_eq!(
        live(watcher_capability.clone()).await,
        401,
        "the teammate's ALREADY-OPEN stream stops validating within one \
         re-validation period. Nothing revoked the capability: the validate join \
         re-reads `observation` every time (LIVE-2's reach), and control closed \
         it. A build that only closed observation for NEW grants would leave the \
         password on the screen somebody is already watching."
    );

    // A fresh 관전 request is refused at the door too, with the sentence that
    // says why rather than a generic 401.
    let response =
        issue_display_capability(&http, &base, &watcher_token, workspace, session, None).await;
    assert_eq!(response.status(), 403);
    let error: Value = response.json().await.expect("error body");
    assert_eq!(
        error["error"]["message"],
        json!("session observation is owner-only")
    );

    // …and the owner is exempt, which is the LIVE-3 decision this goal inherits:
    // `owner_only` means 「소유자만 본다」, not 「아무도 못 본다」. Without it the
    // person typing could not watch their own screen while doing it.
    let response =
        issue_display_capability(&http, &base, &owner_token, workspace, session, None).await;
    assert_eq!(
        response.status(),
        200,
        "the owner exemption holds in the arm control just closed"
    );
    let owner_grant: Value = response.json().await.expect("owner grant");
    assert_eq!(
        live(
            owner_grant["capability_token"]
                .as_str()
                .expect("token")
                .to_string()
        )
        .await,
        200,
        "and in the validate join, not only at issuance"
    );

    // ---- the keyboard goes back --------------------------------------------
    let response = return_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);
    let response =
        issue_display_capability(&http, &base, &watcher_token, workspace, session, None).await;
    assert_eq!(
        response.status(),
        200,
        "관전 comes back with the setting; a session left `owner_only` after an \
         intervention is a team quietly locked out of every session anyone has \
         ever taken control of"
    );

    // ---- and the durable projection tells the same story --------------------
    // The reload half (LIVE-5a piece 2). Centrifugo carried the boundary while
    // the window stood, but transport is not the SoT: a surface that reloads
    // reads `display_control_window` through the session projection.
    let taken = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(taken.status(), 200);
    let started_at = taken.json::<Value>().await.expect("grant body")["control_started_at"]
        .as_i64()
        .expect("a controller grant reports when control began");

    let listed: Value = http
        .get(format!("{base}/v1/workspaces/{workspace}/work-sessions"))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("list sessions")
        .json()
        .await
        .expect("session list body");
    let row = listed["workSessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .find(|row| row["id"] == json!(session.to_string()))
        .expect("the controlled session is in the list");
    assert_eq!(
        row["controlStartedAt"],
        json!(started_at),
        "a reload reconstructs 「사람이 조작 중」 from the ledger, at the same \
         정지 시각 the grant reported"
    );

    let reattached: Value = http
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
        reattached["workSession"]["controlStartedAt"],
        json!(started_at),
        "reattach is the reload path a client actually takes, and it must not \
         disagree with the list about who holds the keyboard"
    );

    let response = return_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);
    let listed: Value = http
        .get(format!("{base}/v1/workspaces/{workspace}/work-sessions"))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("list sessions")
        .json()
        .await
        .expect("session list body");
    let row = listed["workSessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .find(|row| row["id"] == json!(session.to_string()))
        .expect("the session is still in the list");
    assert!(
        row.get("controlStartedAt").is_none(),
        "the field is absent, not zero: 「아무도 조작하고 있지 않다」 is an \
         absence, and a 0 would render as 1970"
    );
}

// ---------------------------------------------------------------------------
// live5a-4 — a control window that fails to be written exposes no screen
// ---------------------------------------------------------------------------

/// The standing window as the SESSION SURFACE reports it, over REST.
///
/// Deliberately read through the list projection rather than out of the ledger:
/// the claim under test is that a reload reconstructs the boundary, and reading
/// the table the projection is built from would prove only that the table has a
/// row in it.
async fn projected_control_started_at(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    session: Uuid,
) -> Option<i64> {
    let listed: Value = http
        .get(format!("{base}/v1/workspaces/{workspace}/work-sessions"))
        .bearer_auth(token)
        .send()
        .await
        .expect("list sessions")
        .json()
        .await
        .expect("session list body");
    listed["workSessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .find(|row| row["id"] == json!(session.to_string()))
        .expect("the session is in the list")
        .get("controlStartedAt")
        .and_then(Value::as_i64)
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live5a_4_a_half_written_control_window_exposes_no_screen() {
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

    // The failure this injects is the one the packet names: the observation flip
    // lands and the window it belongs to does not. If those two were separate
    // transactions, the session would sit `owner_only` with nobody holding the
    // keyboard — the team locked out of a session under nobody's control, and no
    // close path anywhere to put it back, because there is no window to close.
    //
    // A BEFORE INSERT trigger is the injection because it fails at exactly the
    // statement in question, deterministically, without a test-only branch
    // existing anywhere in the server.
    sqlx::query(
        "CREATE OR REPLACE FUNCTION live5a_refuse_control_window() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'live5a injected control-window failure'; END; \
         $$ LANGUAGE plpgsql",
    )
    .execute(&su)
    .await
    .expect("create the injection function");
    sqlx::query(
        "CREATE TRIGGER live5a_refuse_control_window_trg \
         BEFORE INSERT ON display_control_window \
         FOR EACH ROW EXECUTE FUNCTION live5a_refuse_control_window()",
    )
    .execute(&su)
    .await
    .expect("install the injection trigger");

    let status = take_control(&http, &base, &owner_token, workspace, session)
        .await
        .status();

    // Removed before any assertion that could panic, so a red run does not leave
    // the injection installed for whatever the harness does next.
    sqlx::query("DROP TRIGGER live5a_refuse_control_window_trg ON display_control_window")
        .execute(&su)
        .await
        .expect("remove the injection trigger");
    sqlx::query("DROP FUNCTION live5a_refuse_control_window()")
        .execute(&su)
        .await
        .expect("remove the injection function");

    assert!(
        status.is_server_error(),
        "the window could not be written, so the grant must fail — got {status}"
    );
    assert_eq!(
        observation_of(&su, session).await,
        "open",
        "the flip rolled back with the window it belongs to. A session left \
         `owner_only` by a control window that never existed is a team locked \
         out with no close path anywhere to let them back in."
    );
    assert!(
        open_window(&su, session).await.is_none(),
        "and nothing half-written stayed behind"
    );

    // The other direction of the same atomicity, and the one the packet asks for
    // by name: there is no window — not even a momentary one — in which a
    // teammate can see a screen while control is being taken. Either the whole
    // grant happened or none of it did.
    let response =
        issue_display_capability(&http, &base, &watcher_token, workspace, session, None).await;
    assert_eq!(
        response.status(),
        200,
        "a failed take leaves 관전 exactly as it was — neither opened nor closed"
    );

    // …and the real path still works, so this test cannot pass by refusing
    // everything.
    let response = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);
    assert_eq!(observation_of(&su, session).await, "owner_only");
}

// ---------------------------------------------------------------------------
// live5a-5 — the durable projection tells the truth in all three window states
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn live5a_5_the_session_surface_reconstructs_all_three_window_states() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let owner_token = login(&http, &base, workspace, &fixture.owner_email).await;
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

    // ---- state 0: nobody has ever held it ----------------------------------
    assert_eq!(
        projected_control_started_at(&http, &base, &owner_token, workspace, session).await,
        None,
        "absent, not zero — a 0 renders as 1970"
    );

    // ---- state 1: the window stands ----------------------------------------
    let taken: Value = take_control(&http, &base, &owner_token, workspace, session)
        .await
        .json()
        .await
        .expect("grant body");
    let started_at = taken["control_started_at"]
        .as_i64()
        .expect("a controller grant reports 정지 시각");
    assert_eq!(
        projected_control_started_at(&http, &base, &owner_token, workspace, session).await,
        Some(started_at),
        "a reload reads the ledger and lands on the SAME 정지 시각 the grant \
         reported — two numbers here would be two stories about one keyboard"
    );

    // ---- state 2: returned --------------------------------------------------
    let response = return_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        projected_control_started_at(&http, &base, &owner_token, workspace, session).await,
        None,
        "a closed window is not a standing one; the surface must stop saying \
         「사람이 조작 중」 the moment the keyboard goes back"
    );

    // ---- state 3: expired --------------------------------------------------
    // The state that separates a ledger read from a status flag. Nobody performs
    // this close: the producer stopped re-validating and the lease simply ran
    // out. The projection carries the lease clause itself, so it answers
    // correctly BEFORE any sweep has run — which matters, because on the agent's
    // own path there is no reader to run one.
    let response = take_control(&http, &base, &owner_token, workspace, session).await;
    assert_eq!(response.status(), 200);
    assert!(
        projected_control_started_at(&http, &base, &owner_token, workspace, session)
            .await
            .is_some(),
        "…standing again"
    );
    lapse_lease(&su, session).await;
    assert!(
        open_window(&su, session).await.is_some(),
        "the row is still open — no close path has run, and that is the point"
    );
    assert_eq!(
        projected_control_started_at(&http, &base, &owner_token, workspace, session).await,
        None,
        "a lapsed lease reads as nobody holding the keyboard, from the same \
         `lease_expires_at > clock_timestamp()` clause the agent's refusal uses. \
         A projection that answered off `ended_at IS NULL` alone would tell a \
         person somebody is typing into a screen whose producer died."
    );
}
