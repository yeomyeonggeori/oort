//! End-to-end HTTP smoke for the **T3 curve** (ADR-0140/0142, batch B2.2).
//!
//! Drives the real router over HTTP against a real Postgres, closing the whole
//! paid-host lifecycle with no provider substrate and no workd:
//!
//! ```text
//! login → credit top-up → BYOC enrollment (one-shot token)
//!       → cloud register (token spent, host bound, state=ready)
//!       → work-session create (ledger opens, host → running)
//!       → list/status
//!       → [RED] direct `settled_at` UPDATE is refused by the seal
//!       → PATCH status=ended  (settlement via t3_terminate ONLY)
//!       → settled_at + active_seconds + credit_entry debit + balance
//! ```
//!
//! `#[ignore]` because it needs a real DB. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test t3_smoke_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract is `http_smoke_pg.rs`'s: `DATABASE_URL` is a **superuser**
//! (migrations + fixture seeding), the server runs on **`momo_app`**
//! (NOBYPASSRLS), and the schema/roles step is re-runnable, so this binary may
//! share one `pgvector/pgvector:pg18` container with the other suites — every
//! fixture id is a fresh UUID.
//!
//! ## The red assertion
//!
//! Between "session running" and "session ended" the test attempts, as
//! **superuser**, the one shortcut the whole ADR-0140 redesign exists to
//! prevent: `UPDATE work_host_usage SET settled_at = clock_timestamp()`.
//! `work_host_usage_settlement_guard` (053:86) raises SQLSTATE 23514. Removing
//! that trigger — or letting the route layer settle by hand — turns this test
//! red, which is the point: it asserts the *enforcement*, not the application's
//! good manners.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::config::T3Settings;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

const TEST_JWT_SECRET: &str = "t3-smoke-test-signing-secret";
const TEST_PASSWORD: &str = "t3-smoke-test-password";
/// `MOMO_T3_RATE_MICRO_USD_PER_SECOND` for this run. Deliberately not the
/// default 25, so the assertion below cannot pass on a coincidence.
const UNIT_RATE_MICRO_USD_SECOND: i64 = 37;
const TOPUP_MICRO_USD: i64 = 5_000_000;

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

/// Boot the real router with T3 **on**, as an operator would configure it.
async fn start_server(pool: PgPool, operator_email: &str) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_t3(T3Settings {
        enabled: true,
        default_provider_id: "byoc".to_string(),
        // Only echoed back as the workd's register URL; nothing dials it.
        public_base_url: Some("https://smoke.momo.invalid".to_string()),
        unit_rate_micro_usd_second: UNIT_RATE_MICRO_USD_SECOND,
        platform_admin_emails: vec![operator_email.to_lowercase()],
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
    channel: Uuid,
}

async fn seed(su: &PgPool, app: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    let member = Uuid::new_v4();
    let email = format!("{member}@t3.smoke.test");

    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    // A workspace is created with a ZERO credit balance (WorkspaceRoutes.swift
    // :158-163) — the reason the top-up below is part of the curve and not a
    // convenience.
    sqlx::query("INSERT INTO workspace_credit (workspace_id, balance_micro_usd) VALUES ($1, 0)")
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed credit ledger");
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
    // `email_verified = true` is required by the listed-instance-operator path
    // of the credit-writer check — an unverified email must never move money.
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
    // Owner membership: the workspace-role authority for the admin-only routes,
    // and the trigger that seeds `work_tool_profile` (029:161-176) so `claude`
    // is an enabled tool in this workspace.
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed workspace membership");

    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("t3-smoke-{}", Uuid::new_v4()),
            topic: None,
            created_by: member,
        },
    )
    .await
    .expect("create channel");

    Fixture {
        workspace,
        member,
        email,
        channel: channel.id,
    }
}

/// A throwaway Ed25519 keypair for the "cloud workd" — the private half never
/// leaves this test, exactly as it never leaves a real daemon. Seeded from two
/// v4 UUIDs so each run registers a distinct host key.
fn workd_keypair() -> ([u8; 32], String) {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;

    let mut seed = [0u8; 32];
    seed[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    seed[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    let public = ed25519_dalek::SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes();
    (seed, BASE64.encode(public))
}

// ---------------------------------------------------------------------------
// the T3 curve
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn t3_smoke_enroll_register_session_settle() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool, &fixture.email).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    // ---- login -----------------------------------------------------------
    let login: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": fixture.email,
            "password": TEST_PASSWORD,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login")
        .json()
        .await
        .expect("login body");
    let token = login["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string();
    let auth = |request: reqwest::RequestBuilder| request.bearer_auth(&token);

    // ---- credit top-up ---------------------------------------------------
    // Without this the enrollment below is a 409: `reserveProvisioningSlot`
    // refuses a workspace whose balance is zero.
    let response = auth(http.post(format!(
        "{base}/v1/admin/workspaces/{workspace}/credits/topups"
    )))
    .json(&json!({
        "amountMicroUsd": TOPUP_MICRO_USD,
        "idempotencyRef": Uuid::new_v4().to_string(),
    }))
    .send()
    .await
    .expect("topup");
    assert_eq!(
        response.status(),
        200,
        "a listed instance operator may top up"
    );
    let topup: Value = response.json().await.expect("topup body");
    assert_eq!(topup["balanceMicroUsd"], json!(TOPUP_MICRO_USD));

    // ---- BYOC enrollment -------------------------------------------------
    let response = auth(http.post(format!(
        "{base}/v1/workspaces/{workspace}/work-hosts/byoc/enrollments"
    )))
    .json(&json!({
        "displayName": "smoke byoc box",
        "scope": "workspace",
        "idempotencyRef": Uuid::new_v4().to_string(),
    }))
    .send()
    .await
    .expect("enroll");
    assert_eq!(response.status(), 201, "enrollment is created");
    let enrollment: Value = response.json().await.expect("enrollment body");
    let enrollment = &enrollment["enrollment"];
    assert_eq!(enrollment["provider"], json!("byoc"));
    assert_eq!(enrollment["state"], json!("provisioning"));
    let bootstrap_token = enrollment["bootstrapToken"]
        .as_str()
        .expect("bootstrapToken is shown exactly once")
        .to_string();
    let provision_id = enrollment["provisionId"]
        .as_str()
        .expect("provisionId")
        .to_string();
    assert!(enrollment["registerUrl"]
        .as_str()
        .is_some_and(|url| url.starts_with("https://smoke.momo.invalid/v1/workspaces/")));

    // Only the digest reached PostgreSQL.
    let stored_digest: String = sqlx::query_scalar(
        "SELECT bootstrap_token_digest FROM work_cloud_host WHERE id = $1::uuid",
    )
    .bind(&provision_id)
    .fetch_one(&su)
    .await
    .expect("stored digest");
    assert_ne!(
        stored_digest, bootstrap_token,
        "the raw bootstrap token must never be persisted"
    );
    assert_eq!(stored_digest.len(), 64);

    // ---- the workd spends its one-shot token -----------------------------
    let (signing_seed, public_key) = workd_keypair();
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-hosts/cloud/register"
        ))
        .header("Authorization", format!("MomoBootstrap {bootstrap_token}"))
        .json(&json!({
            "scope": "workspace",
            "type": "cloud",
            "displayName": "smoke byoc box",
            "publicKey": public_key,
            "capabilities": {"terminal_attach": false},
        }))
        .send()
        .await
        .expect("cloud register");
    assert_eq!(response.status(), 201, "the token registers the host");
    let registered: Value = response.json().await.expect("register body");
    let host_id = registered["workHost"]["id"]
        .as_str()
        .expect("workHost.id")
        .to_string();
    assert_eq!(registered["workHost"]["type"], json!("cloud"));
    assert_eq!(registered["workHost"]["scope"], json!("workspace"));
    assert_eq!(
        registered["workHost"]["ownerMemberId"],
        json!(fixture.member.to_string()),
        "the host is attributed to the member who enrolled it"
    );

    // The same token cannot be spent twice.
    let replay = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-hosts/cloud/register"
        ))
        .header("Authorization", format!("MomoBootstrap {bootstrap_token}"))
        .json(&json!({
            "scope": "workspace",
            "type": "cloud",
            "displayName": "second box",
            "publicKey": public_key,
        }))
        .send()
        .await
        .expect("replayed register");
    assert_eq!(
        replay.status(),
        401,
        "a one-shot bootstrap token is consumed on first use"
    );

    // Binding moved the cloud host to `ready` (provider_sandbox_id was known).
    let response = auth(http.get(format!(
        "{base}/v1/workspaces/{workspace}/work-hosts/cloud/{provision_id}"
    )))
    .send()
    .await
    .expect("cloud host");
    assert_eq!(response.status(), 200);
    let cloud_host: Value = response.json().await.expect("cloud host body");
    assert_eq!(cloud_host["cloudHost"]["state"], json!("ready"));
    assert_eq!(cloud_host["cloudHost"]["hostId"], json!(host_id));

    // ---- heartbeat (signed, outside the auth middleware) -----------------
    let sent_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let host_uuid = Uuid::parse_str(&host_id).expect("host uuid");
    let signature = momo_wire::signing::sign_base64(
        &signing_seed,
        &momo_wire::signing::heartbeat_payload(workspace, host_uuid, sent_at_ms),
    )
    .expect("sign heartbeat");
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-hosts/{host_id}/heartbeat"
        ))
        .json(&json!({"sentAtMs": sent_at_ms, "signature": signature}))
        .send()
        .await
        .expect("heartbeat");
    assert_eq!(response.status(), 200, "a signed heartbeat needs no bearer");
    let beat: Value = response.json().await.expect("heartbeat body");
    assert_eq!(beat["workHost"]["online"], json!(true));

    // Signed by a DIFFERENT key over the same payload — a well-formed 64-byte
    // signature that simply is not this host's. (Mutating base64 characters
    // would be a coin flip on whether the chosen character occurs at all.)
    let (impostor_seed, _) = workd_keypair();
    let impostor_signature = momo_wire::signing::sign_base64(
        &impostor_seed,
        &momo_wire::signing::heartbeat_payload(workspace, host_uuid, sent_at_ms),
    )
    .expect("sign with the wrong key");
    let forged = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-hosts/{host_id}/heartbeat"
        ))
        .json(&json!({"sentAtMs": sent_at_ms, "signature": impostor_signature}))
        .send()
        .await
        .expect("forged heartbeat");
    assert_eq!(
        forged.status(),
        401,
        "only the registered key may report this host alive"
    );

    // ---- session create (the ledger opens) -------------------------------
    let response = auth(http.post(format!("{base}/v1/workspaces/{workspace}/work-sessions")))
        .json(&json!({
            "channelId": fixture.channel.to_string(),
            "hostId": host_id,
            "tool": "claude",
            "label": "t3 smoke run",
        }))
        .send()
        .await
        .expect("create session");
    assert_eq!(response.status(), 201, "session opens on the cloud host");
    let created: Value = response.json().await.expect("session body");
    let session_id = created["workSession"]["id"]
        .as_str()
        .expect("session id")
        .to_string();
    assert_eq!(created["workSession"]["status"], json!("running"));
    assert_eq!(created["workSession"]["hostId"], json!(host_id));

    let (cloud_state, usage_started): (String, bool) = sqlx::query_as(
        "SELECT ch.state, \
                EXISTS(SELECT 1 FROM work_host_usage u \
                        WHERE u.session_id = $1::uuid AND u.settled_at IS NULL) \
           FROM work_cloud_host ch WHERE ch.id = $2::uuid",
    )
    .bind(&session_id)
    .bind(&provision_id)
    .fetch_one(&su)
    .await
    .expect("cloud state + usage");
    assert_eq!(cloud_state, "running", "starting a session runs the host");
    assert!(usage_started, "the T3 ledger opened with the session");

    // ---- status (list) ---------------------------------------------------
    let response = auth(http.get(format!(
        "{base}/v1/workspaces/{workspace}/work-sessions?active=1"
    )))
    .send()
    .await
    .expect("list sessions");
    assert_eq!(response.status(), 200);
    let listed: Value = response.json().await.expect("list body");
    let sessions = listed["workSessions"].as_array().expect("workSessions");
    assert!(
        sessions
            .iter()
            .any(|session| session["id"] == json!(session_id)),
        "the running session is listed"
    );

    // ---- RED: settlement cannot be forged --------------------------------
    // Superuser, RLS bypassed, one UPDATE away from a settled invoice — and the
    // trigger still refuses. This is the assertion that fails the moment the
    // 053 seal is removed or a route learns to settle by hand.
    let forged_settlement = sqlx::query(
        "UPDATE work_host_usage \
            SET settled_at = clock_timestamp(), \
                ended_at = clock_timestamp(), \
                active_seconds = 0 \
          WHERE session_id = $1::uuid",
    )
    .bind(&session_id)
    .execute(&su)
    .await;
    let error = forged_settlement.expect_err("a direct settlement must be refused");
    let database_error = error
        .as_database_error()
        .expect("the refusal comes from PostgreSQL, not from the client");
    assert_eq!(
        database_error.code().as_deref(),
        Some("23514"),
        "work_host_usage_settlement_guard raises a check violation"
    );
    assert!(
        database_error
            .message()
            .contains("t3 settlement must go through"),
        "unexpected refusal: {}",
        database_error.message()
    );

    // Bill at least one whole second, so the debit below is non-zero and the
    // single-floor arithmetic is actually exercised.
    tokio::time::sleep(Duration::from_millis(1_150)).await;

    // ---- end (settlement through t3_terminate only) ----------------------
    let response = auth(
        http.patch(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session_id}"
        ))
        .json(&json!({"status": "ended", "exitCode": 0})),
    )
    .send()
    .await
    .expect("end session");
    assert_eq!(response.status(), 200, "the owner ends the session");
    let ended: Value = response.json().await.expect("end body");
    assert_eq!(ended["workSession"]["status"], json!("ended"));
    assert!(ended["workSession"]["endedAtMs"].as_i64().is_some());
    assert_eq!(ended["workSession"]["exitCode"], json!(0));

    // ---- the invoice -----------------------------------------------------
    let usage = sqlx::query(
        "SELECT settled_at IS NOT NULL AS settled, settled_reason, active_seconds, \
                active_micros \
           FROM work_host_usage WHERE session_id = $1::uuid",
    )
    .bind(&session_id)
    .fetch_one(&su)
    .await
    .expect("usage row");
    assert!(
        usage.get::<bool, _>("settled"),
        "settled_at is stamped by t3_terminate"
    );
    assert_eq!(
        usage.get::<Option<String>, _>("settled_reason").as_deref(),
        Some("ended"),
        "the REST end path settles with the `ended` reason"
    );
    let active_seconds: i64 = usage
        .get::<Option<i64>, _>("active_seconds")
        .expect("seconds");
    let active_micros: i64 = usage
        .get::<Option<i64>, _>("active_micros")
        .expect("micros");
    assert!(
        active_seconds >= 1,
        "a session held open for >1s bills at least one second (got {active_seconds})"
    );
    assert_eq!(
        active_seconds,
        active_micros / 1_000_000,
        "one truncation, at settlement (058: floor(Σ), not Σ floor)"
    );

    let debit: i64 = sqlx::query_scalar(
        "SELECT delta_micro_usd FROM credit_entry \
          WHERE workspace_id = $1 AND reason = 't3_usage' AND ref_id = $2::uuid",
    )
    .bind(workspace)
    .bind(&session_id)
    .fetch_one(&su)
    .await
    .expect("t3 debit entry");
    assert_eq!(
        debit,
        -(active_seconds * UNIT_RATE_MICRO_USD_SECOND),
        "the debit is billed seconds x the host's unit rate"
    );

    let balance: i64 = sqlx::query_scalar(
        "SELECT balance_micro_usd FROM workspace_credit WHERE workspace_id = $1",
    )
    .bind(workspace)
    .fetch_one(&su)
    .await
    .expect("balance");
    assert_eq!(
        balance,
        TOPUP_MICRO_USD + debit,
        "the append-only ledger's trigger moved the balance, not the application"
    );

    // Settlement is idempotent: ending twice is a 200 and moves no money.
    let repeat = auth(
        http.patch(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session_id}"
        ))
        .json(&json!({"status": "ended"})),
    )
    .send()
    .await
    .expect("repeat end");
    assert_eq!(
        repeat.status(),
        200,
        "ending an ended session is idempotent"
    );
    let entries: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM credit_entry \
          WHERE workspace_id = $1 AND reason = 't3_usage' AND ref_id = $2::uuid",
    )
    .bind(workspace)
    .bind(&session_id)
    .fetch_one(&su)
    .await
    .expect("debit count");
    assert_eq!(entries, 1, "a repeated end must never debit twice");

    // The destroy intent and host revocation are `t3_terminate`'s too.
    let (cloud_state, host_revoked): (String, bool) = sqlx::query_as(
        "SELECT ch.state, h.revoked_at IS NOT NULL \
           FROM work_cloud_host ch JOIN work_host h ON h.id = ch.host_id \
          WHERE ch.id = $1::uuid",
    )
    .bind(&provision_id)
    .fetch_one(&su)
    .await
    .expect("post-settlement state");
    assert_eq!(
        cloud_state, "destroy_pending",
        "settlement writes the durable destroy intent"
    );
    assert!(
        host_revoked,
        "settlement revokes the host so it cannot serve another session"
    );
}

/// T3 routes must answer 503 — never half-provision — on an instance that never
/// turned momo Cloud on. This is the default posture of the deployed binary.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn t3_routes_are_closed_when_the_operator_did_not_enable_them() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;

    // The default AppState — exactly what `http_smoke_pg.rs` boots.
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
    let workspace = fixture.workspace;

    let login: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": fixture.email,
            "password": TEST_PASSWORD,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login")
        .json()
        .await
        .expect("login body");
    let token = login["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string();

    // Each route gets ITS OWN valid body: the T3 gate lives in the handler, so a
    // body that failed to decode would be answered by the extractor (422) and
    // would prove nothing about the gate.
    let closed: [(&str, String, Value); 2] = [
        (
            "POST",
            format!("/v1/workspaces/{workspace}/work-hosts/byoc/enrollments"),
            json!({
                "displayName": "closed",
                "scope": "workspace",
                "idempotencyRef": Uuid::new_v4().to_string(),
            }),
        ),
        (
            "POST",
            format!("/v1/admin/workspaces/{workspace}/credits/topups"),
            json!({
                "amountMicroUsd": 1,
                "idempotencyRef": Uuid::new_v4().to_string(),
            }),
        ),
    ];
    for (method, path, body) in closed {
        let response = http
            .request(method.parse().unwrap(), format!("{base}{path}"))
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .expect("t3 route");
        assert_eq!(
            response.status(),
            503,
            "{path} must be closed while MOMO_T3_ENABLED is unset"
        );
    }

    // The public register route is closed too — a bootstrap token must not be
    // spendable on an instance that never issued one.
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-hosts/cloud/register"
        ))
        .header("Authorization", format!("MomoBootstrap {}", "a".repeat(64)))
        .json(&json!({
            "scope": "workspace",
            "type": "cloud",
            "displayName": "x",
            "publicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        }))
        .send()
        .await
        .expect("register");
    assert_eq!(response.status(), 503);
}
