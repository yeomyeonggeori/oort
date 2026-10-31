//! #4245 SEC-07 — the claims of the deleted Swift-era `verify_auth_hardening.sh`
//! and `verify_approval_decision.sh` that no Rust test asserted, moved here so
//! the scripts can be removed (map: group G1 / G4 / G6).
//!
//! | test | what it pins | script claim |
//! |---|---|---|
//! | `the_subscribe_proxy_refuses_every_credential_that_is_not_this_members_live_access_row` | the shared secret, the `meta` binding and the access-row/owner join of the subscribe callback, over real HTTP and a real `token` table | `verify_auth_hardening.sh` A2·A3·A6·A8·A9·A10·A11 |
//! | `a_top_up_is_refused_to_everyone_but_a_listed_verified_operator_admin` | `POST /v1/admin/workspaces/{ws}/credits/topups` → 403 for four non-operator shapes, balance and ledger untouched | A30 |
//! | `the_pending_list_shows_only_the_callers_own_workspace_and_rooms` | `GET …/approvals?status=pending` rows, non-member `[]`, foreign path 403, second tenant | `verify_approval_decision.sh` B2·B3·B4·B5 |
//! | `an_approval_writes_the_ledger_the_audit_row_and_exactly_one_resume_job` | approve receipt keys + ledger row + audit row + resume job tied to the approval id | B6·B7 |
//! | `a_rejection_cancels_the_run_posts_the_tool_result_and_resumes_nothing` | reject receipt + ledger + run `cancelled` + one `tool_result` + zero resume jobs | B10·B11 |
//! | `a_tap_after_the_deadline_settles_the_approval_as_expired_in_the_ledger` | 409 + `expired` + ledger row + run `timed_out` + audit, no job | B12·B13 |
//! | `a_decision_by_a_non_member_changes_nothing_not_even_the_ledger` | 403 and approval/run/ledger/audit/outbox all untouched, then the owner still can | B14·B15 |
//!
//! Contract notes the scripts got wrong for this server (found while porting):
//! the approval JSON is camelCase (`approvalId`, `decidedBy`, `workspaceId`,
//! `channelId`), so the scripts' snake_case `jq` never matched.
//!
//! Not here, on purpose: the `auth.logout` audit row is **not implemented** in the Rust
//! server (see the map's G3), so a test for it could only be red. The per-member 429 +
//! `rate_limit.exceeded` row of the map's G2 now exists for five write endpoints (#4234,
//! ADR-0208 D10 증보) and is tested in `member_write_rate_limit_pg.rs`; the Swift *global*
//! per-member axis (every route) is still not implemented.
//!
//! `#[ignore]` because every test needs a real Postgres. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test sec07_auth_approval_pg -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract is the one `http_smoke_pg.rs` documents: `DATABASE_URL` is a
//! superuser (migrations + fixture seeding), the server runs on `momo_app`
//! (NOBYPASSRLS), and every fixture id is a fresh UUID so the binary can share a
//! container with the other suites.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_auth::CentrifugoConnectionClaims;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_messaging::cent_channel;
use momo_server::config::{RealtimeSettings, T3Settings};
use momo_server::routes::realtime::PROXY_SECRET_HEADER;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (same contract as http_smoke_pg.rs / client_rewire_smoke_pg.rs)
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "sec07-app-signing-secret";
const TEST_CENT_TOKEN_HMAC: &str = "sec07-centrifugo-token-secret";
const TEST_PROXY_SECRET: &str = "sec07-proxy-shared-secret";
const TEST_PASSWORD: &str = "sec07-fixture-password";
const WORKSPACE_NAME: &str = "달무리 스튜디오";
const REALTIME_URL: &str = "ws://127.0.0.1:8000/connection/websocket";
const AGENT_MODEL: &str = "hermes-agent";

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

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
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
    *ready = true;
}

async fn serve(state: AppState) -> String {
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

/// The deployed shape for realtime: both secrets configured.
async fn start_realtime_server(pool: PgPool) -> String {
    serve(
        AppState::new(pool, TEST_JWT_SECRET.to_string(), REALTIME_URL.to_string()).with_realtime(
            RealtimeSettings {
                cent_token_hmac: Some(TEST_CENT_TOKEN_HMAC.to_string()),
                cent_proxy_secret: Some(TEST_PROXY_SECRET.to_string()),
                connection_token_ttl_seconds: momo_auth::CONNECTION_TOKEN_TTL_SECONDS,
            },
        ),
    )
    .await
}

/// T3 **on**, with `operators` as the instance-operator allow-list.
async fn start_t3_server(pool: PgPool, operators: &[&str]) -> String {
    serve(
        AppState::new(pool, TEST_JWT_SECRET.to_string(), REALTIME_URL.to_string()).with_t3(
            T3Settings {
                enabled: true,
                default_provider_id: "byoc".to_string(),
                public_base_url: Some("https://sec07.momo.invalid".to_string()),
                unit_rate_micro_usd_second: 37,
                platform_admin_emails: operators.iter().map(|e| e.to_lowercase()).collect(),
            },
        ),
    )
    .await
}

async fn start_plain_server(pool: PgPool) -> String {
    serve(AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        REALTIME_URL.to_string(),
    ))
    .await
}

// ---------------------------------------------------------------------------
// fixtures (superuser → bypass RLS)
// ---------------------------------------------------------------------------

struct Tenant {
    workspace: Uuid,
    channel: Uuid,
    /// 이도현 — workspace `owner`, a member of `channel`, email verified.
    owner: Uuid,
    owner_email: String,
    /// The author of every approval card.
    agent: Uuid,
}

async fn seed_human(
    su: &PgPool,
    workspace: Uuid,
    role: &str,
    display_name: &str,
    email_verified: bool,
) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let handle = format!("sec07-{}", &id.simple().to_string()[..10]);
    let email = format!("{id}@example.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(display_name)
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, $4, momo_password_hash($5))",
    )
    .bind(id)
    .bind(workspace)
    .bind(&email)
    .bind(email_verified)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, $3::membership_role)",
    )
    .bind(workspace)
    .bind(id)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace membership");
    (id, email)
}

async fn join_channel(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("seed channel membership");
}

async fn seed_workspace(su: &PgPool) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $3)")
        .bind(workspace)
        .bind(format!("sec07-{workspace}"))
        .bind(WORKSPACE_NAME)
        .execute(su)
        .await
        .expect("seed workspace");
    workspace
}

/// A workspace with an owner (in the channel), one public channel and an agent
/// in it.
async fn seed_tenant(su: &PgPool) -> Tenant {
    let workspace = seed_workspace(su).await;
    let (owner, owner_email) = seed_human(su, workspace, "owner", "이도현", true).await;
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, dm_key) \
         VALUES ($1, $2, 'public', 'sec07', NULL)",
    )
    .bind(channel)
    .bind(workspace)
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");
    join_channel(su, workspace, channel, owner).await;

    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', 'sec07-agent', 'sec07-agent')",
    )
    .bind(agent)
    .bind(workspace)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, $3, 'https://gateway.invalid/v1', 4, 50, $4)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(AGENT_MODEL)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent workspace membership");
    join_channel(su, workspace, channel, agent).await;

    Tenant {
        workspace,
        channel,
        owner,
        owner_email,
        agent,
    }
}

/// A pending tool-call approval on a run parked for it — the shape a real agent
/// turn leaves behind. `expires` is a Postgres interval (`"-1 minute"` = already
/// late).
async fn seed_pending_approval(su: &PgPool, tenant: &Tenant, expires: &str) -> (Uuid, Uuid) {
    let run: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status) \
         VALUES ($1, $2, $3, 'awaiting_approval') RETURNING id",
    )
    .bind(tenant.workspace)
    .bind(tenant.agent)
    .bind(tenant.channel)
    .fetch_one(su)
    .await
    .expect("seed parked run");
    let approval: Uuid = sqlx::query_scalar(
        "INSERT INTO approval \
           (workspace_id, run_id, channel_id, requested_by, action_type, payload, \
            status, expires_at) \
         VALUES ($1, $2, $3, $4, 'tool_call', $5, 'pending', now() + $6::interval) \
         RETURNING id",
    )
    .bind(tenant.workspace)
    .bind(run)
    .bind(tenant.channel)
    .bind(tenant.agent)
    .bind(json!({"tool_call": {
        "call_id": format!("sec07-{run}"),
        "name": "github.search_issues",
        "arguments": {},
    }}))
    .bind(expires)
    .fetch_one(su)
    .await
    .expect("seed pending approval");
    (run, approval)
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> Value {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": TEST_PASSWORD,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status().as_u16(), 200, "a seeded human logs in");
    response.json().await.expect("login body")
}

async fn access_token(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> String {
    login(http, base, workspace, email).await["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string()
}

// ---------------------------------------------------------------------------
// G1 — subscribe proxy binding
// ---------------------------------------------------------------------------

fn decode_connection_token(token: &str) -> CentrifugoConnectionClaims {
    jsonwebtoken::decode::<CentrifugoConnectionClaims>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(TEST_CENT_TOKEN_HMAC.as_bytes()),
        &jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256),
    )
    .expect("Centrifugo must be able to verify the connection token")
    .claims
}

/// The subscribe callback exactly as sent, with the caller choosing the secret
/// header (`None` = no header at all) and the whole body.
async fn subscribe_raw(
    http: &reqwest::Client,
    base: &str,
    secret: Option<&str>,
    body: Value,
) -> (u16, Value) {
    let mut request = http.post(format!("{base}/v1/centrifugo/subscribe"));
    if let Some(secret) = secret {
        request = request.header(PROXY_SECRET_HEADER, secret);
    }
    let response = request.json(&body).send().await.expect("subscribe");
    let status = response.status().as_u16();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    (status, body)
}

fn subscribe_body(user: &str, channel: &str, meta: Option<Value>) -> Value {
    let mut body = json!({
        "client": Uuid::new_v4().to_string(),
        "user": user,
        "channel": channel,
    });
    if let Some(meta) = meta {
        body["meta"] = meta;
    }
    body
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

const NO_BINDING: &str = "missing or invalid realtime credential binding";
const NOT_ACTIVE: &str = "realtime credential is no longer active";

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_subscribe_proxy_refuses_every_credential_that_is_not_this_members_live_access_row() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    // 박서연: a real member of the SAME channel, so the only thing that can
    // refuse her riding 이도현's credential is the credential's owner check.
    let (colleague, _) = seed_human(&su, tenant.workspace, "member", "박서연", true).await;
    join_channel(&su, tenant.workspace, tenant.channel, colleague).await;
    let base = start_realtime_server(app_pool).await;
    let http = reqwest::Client::new();

    let session = login(&http, &base, tenant.workspace, &tenant.owner_email).await;
    let access = session["accessToken"].as_str().expect("accessToken");
    let refresh = session["refreshToken"].as_str().expect("refreshToken");

    // A2 — the realtime-token body names this member and this workspace (the
    // casing is the contract's, the comparison is the client's: case-blind).
    let token_body: Value = http
        .post(format!("{base}/v1/auth/realtime-token"))
        .bearer_auth(access)
        .send()
        .await
        .expect("realtime-token")
        .json()
        .await
        .expect("realtime token body");
    assert_eq!(
        token_body["workspaceId"]
            .as_str()
            .expect("workspaceId")
            .to_lowercase(),
        tenant.workspace.to_string()
    );
    assert_eq!(
        token_body["memberId"]
            .as_str()
            .expect("memberId")
            .to_lowercase(),
        tenant.owner.to_string()
    );
    let connection_token = token_body["token"].as_str().expect("token");
    assert!(!connection_token.is_empty());
    let claims = decode_connection_token(connection_token);

    // A3 — login stored an access row and a refresh row as two different rows,
    // and the connection token is bound to the ACCESS one.
    let rows: Vec<(String, Uuid)> = sqlx::query_as(
        "SELECT label, id FROM token \
          WHERE workspace_id = $1 AND actor_member_id = $2 AND kind = 'session' \
            AND revoked_at IS NULL ORDER BY label",
    )
    .bind(tenant.workspace)
    .bind(tenant.owner)
    .fetch_all(&su)
    .await
    .expect("session rows");
    assert_eq!(
        rows.iter()
            .map(|(label, _)| label.as_str())
            .collect::<Vec<_>>(),
        vec!["access", "refresh"],
        "one login = one access row + one refresh row"
    );
    let (access_id, refresh_id) = (rows[0].1, rows[1].1);
    assert_ne!(access_id, refresh_id);
    assert_eq!(
        claims.meta.token_id.to_lowercase(),
        access_id.to_string(),
        "the connection token is bound to the access row, not the refresh row"
    );
    // The refresh row id, read the same way the access row's was.
    let refresh_row: Uuid = sqlx::query_scalar(
        "SELECT id FROM token WHERE token_hash = digest($1::text, 'sha256') \
           AND label = 'refresh'",
    )
    .bind(refresh)
    .fetch_one(&su)
    .await
    .expect("refresh row by hash");
    assert_eq!(refresh_row, refresh_id);

    let channel = cent_channel(tenant.workspace, tenant.channel);
    let honest_meta = json!({
        "schema": claims.meta.schema,
        "token_id": claims.meta.token_id,
    });

    // ⑥ the control, first: the untouched claims are allowed. Every refusal
    // below changes exactly one input of this request.
    let (status, body) = subscribe_raw(
        &http,
        &base,
        Some(TEST_PROXY_SECRET),
        subscribe_body(&claims.sub, &channel, Some(honest_meta.clone())),
    )
    .await;
    assert_eq!(status, 200);
    assert_allowed(&body);

    // A6 — a WRONG shared secret (and an empty one) is a transport 401, not a
    // deny envelope: the caller is not Centrifugo.
    for wrong in [Some("not-the-proxy-secret"), Some("")] {
        let (status, body) = subscribe_raw(
            &http,
            &base,
            wrong,
            subscribe_body(&claims.sub, &channel, Some(honest_meta.clone())),
        )
        .await;
        assert_eq!(
            status, 401,
            "secret {wrong:?} must not authenticate: {body}"
        );
        assert_eq!(
            body["error"]["message"],
            json!("invalid or missing proxy secret")
        );
    }

    // A9 — no `meta`, `meta` without a token id, and a token id that is not a
    // UUID all fail closed with the binding message.
    for meta in [
        None,
        Some(json!({"schema": claims.meta.schema})),
        Some(json!({"schema": claims.meta.schema, "token_id": "not-a-uuid"})),
    ] {
        let (status, body) = subscribe_raw(
            &http,
            &base,
            Some(TEST_PROXY_SECRET),
            subscribe_body(&claims.sub, &channel, meta.clone()),
        )
        .await;
        assert_eq!(status, 200, "a proxy decision is always HTTP 200");
        assert_denied(&body, NO_BINDING);
    }

    // A10 — a well-formed id that names no row.
    let (_, body) = subscribe_raw(
        &http,
        &base,
        Some(TEST_PROXY_SECRET),
        subscribe_body(
            &claims.sub,
            &channel,
            Some(json!({"schema": claims.meta.schema, "token_id": Uuid::new_v4().to_string()})),
        ),
    )
    .await;
    assert_denied(&body, NOT_ACTIVE);

    // A8 — the member's OWN refresh row, unrevoked and unexpired, is still not a
    // realtime credential: only the access half is.
    let (_, body) = subscribe_raw(
        &http,
        &base,
        Some(TEST_PROXY_SECRET),
        subscribe_body(
            &claims.sub,
            &channel,
            Some(json!({"schema": claims.meta.schema, "token_id": refresh_id.to_string()})),
        ),
    )
    .await;
    assert_denied(&body, NOT_ACTIVE);

    // A11 — a channel member who is not the credential's owner cannot ride it.
    let (_, body) = subscribe_raw(
        &http,
        &base,
        Some(TEST_PROXY_SECRET),
        subscribe_body(&colleague.to_string(), &channel, Some(honest_meta.clone())),
    )
    .await;
    assert_denied(&body, NOT_ACTIVE);

    // ⑥ again: none of the refusals revoked or consumed anything.
    let (_, body) = subscribe_raw(
        &http,
        &base,
        Some(TEST_PROXY_SECRET),
        subscribe_body(&claims.sub, &channel, Some(honest_meta)),
    )
    .await;
    assert_allowed(&body);
}

// ---------------------------------------------------------------------------
// G4 — credit top-up is for listed, verified operator admins only
// ---------------------------------------------------------------------------

const TOPUP_MICRO_USD: i64 = 1_000_000;
const TOPUP_REFUSAL: &str = "platform:credits:write scope or listed instance operator required";

async fn topup(http: &reqwest::Client, base: &str, workspace: Uuid, token: &str) -> (u16, Value) {
    let response = http
        .post(format!(
            "{base}/v1/admin/workspaces/{workspace}/credits/topups"
        ))
        .bearer_auth(token)
        .json(&json!({
            "amountMicroUsd": TOPUP_MICRO_USD,
            "idempotencyRef": Uuid::new_v4().to_string(),
        }))
        .send()
        .await
        .expect("topup");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn credit_state(su: &PgPool, workspace: Uuid) -> (i64, i64) {
    let balance: i64 = sqlx::query_scalar(
        "SELECT balance_micro_usd FROM workspace_credit WHERE workspace_id = $1",
    )
    .bind(workspace)
    .fetch_one(su)
    .await
    .expect("credit balance");
    let entries: i64 =
        sqlx::query_scalar("SELECT count(*) FROM credit_entry WHERE workspace_id = $1")
            .bind(workspace)
            .fetch_one(su)
            .await
            .expect("credit entries");
    (balance, entries)
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_top_up_is_refused_to_everyone_but_a_listed_verified_operator_admin() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let workspace = seed_workspace(&su).await;
    sqlx::query("INSERT INTO workspace_credit (workspace_id, balance_micro_usd) VALUES ($1, 0)")
        .bind(workspace)
        .execute(&su)
        .await
        .expect("seed credit ledger");

    // The one real operator: owner, verified email, on the list.
    let (_, operator_email) = seed_human(&su, workspace, "owner", "최민수", true).await;
    // Four callers, each missing exactly ONE of {admin role, verified email, on
    // the list}.
    let (_, plain_email) = seed_human(&su, workspace, "member", "정하윤", true).await;
    let (_, unlisted_admin_email) = seed_human(&su, workspace, "admin", "박서연", true).await;
    let (_, listed_member_email) = seed_human(&su, workspace, "member", "이도현", true).await;
    let (_, unverified_admin_email) = seed_human(&su, workspace, "admin", "박서연", false).await;

    let base = start_t3_server(
        app_pool,
        &[
            &operator_email,
            &listed_member_email,
            &unverified_admin_email,
        ],
    )
    .await;
    let http = reqwest::Client::new();

    let refused = [
        ("a plain member, not listed", &plain_email),
        (
            "a verified admin who is not on the list",
            &unlisted_admin_email,
        ),
        (
            "a listed email without the admin role",
            &listed_member_email,
        ),
        (
            "a listed admin whose email is not verified",
            &unverified_admin_email,
        ),
    ];
    for (who, email) in refused {
        let token = access_token(&http, &base, workspace, email).await;
        let (status, body) = topup(&http, &base, workspace, &token).await;
        assert_eq!(status, 403, "{who} must not move money: {body}");
        assert_eq!(body["error"]["message"], json!(TOPUP_REFUSAL), "{who}");
    }
    assert_eq!(
        credit_state(&su, workspace).await,
        (0, 0),
        "four refusals left the balance and the ledger untouched"
    );

    // The control: the same request from the listed, verified owner goes through,
    // so the 403s above were the authorization and nothing else.
    let token = access_token(&http, &base, workspace, &operator_email).await;
    let (status, body) = topup(&http, &base, workspace, &token).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["balanceMicroUsd"], json!(TOPUP_MICRO_USD));
    assert_eq!(
        credit_state(&su, workspace).await,
        (TOPUP_MICRO_USD, 1),
        "exactly the operator's top-up was applied"
    );
}

// ---------------------------------------------------------------------------
// G6 — the approval routes over HTTP
// ---------------------------------------------------------------------------

struct Env {
    su: PgPool,
    http: reqwest::Client,
    base: String,
}

async fn approvals_env() -> Env {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_plain_server(momo_app_pool().await).await;
    Env {
        su,
        http: reqwest::Client::new(),
        base,
    }
}

impl Env {
    async fn decide(
        &self,
        token: &str,
        workspace: Uuid,
        approval: Uuid,
        approve: bool,
        key: Uuid,
    ) -> (u16, Value) {
        let response = self
            .http
            .post(format!(
                "{}/v1/workspaces/{workspace}/approvals/{approval}/decision",
                self.base
            ))
            .bearer_auth(token)
            .json(&json!({
                "approval_id": approval,
                "approve": approve,
                "client_decision_id": key,
            }))
            .send()
            .await
            .expect("decision");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn list_pending(&self, token: &str, workspace: Uuid) -> (u16, Value) {
        let response = self
            .http
            .get(format!(
                "{}/v1/workspaces/{workspace}/approvals?status=pending",
                self.base
            ))
            .bearer_auth(token)
            .send()
            .await
            .expect("list approvals");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn approval_state(&self, approval: Uuid) -> (String, Option<Uuid>) {
        sqlx::query_as::<_, (String, Option<Uuid>)>(
            "SELECT status::text, decided_by FROM approval WHERE id = $1",
        )
        .bind(approval)
        .fetch_one(&self.su)
        .await
        .expect("read approval")
    }

    async fn run_status(&self, run: Uuid) -> String {
        sqlx::query_scalar::<_, String>("SELECT status::text FROM agent_run WHERE id = $1")
            .bind(run)
            .fetch_one(&self.su)
            .await
            .expect("read run")
    }

    /// `(status, approve, decided_by, client_decision_id)` of every ledger row of
    /// `approval`.
    async fn ledger(&self, approval: Uuid) -> Vec<(String, bool, Uuid, Uuid)> {
        sqlx::query_as(
            "SELECT status::text, approve, decided_by, client_decision_id \
               FROM approval_decision WHERE approval_id = $1",
        )
        .bind(approval)
        .fetch_all(&self.su)
        .await
        .expect("read approval_decision")
    }

    async fn audit_rows(&self, workspace: Uuid, action: &str, approval: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM audit_log \
              WHERE workspace_id = $1 AND action = $2 AND target_id = $3",
        )
        .bind(workspace)
        .bind(action)
        .bind(approval)
        .fetch_one(&self.su)
        .await
        .expect("count audit rows")
    }

    /// Resume jobs in the outbox that name `approval` as what they resume.
    async fn resume_jobs_for(&self, workspace: Uuid, approval: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM outbox \
              WHERE workspace_id = $1 AND kind = 'agent_job' \
                AND payload->>'resume_from_approval_id' = $2",
        )
        .bind(workspace)
        .bind(approval.to_string())
        .fetch_one(&self.su)
        .await
        .expect("count resume jobs")
    }

    async fn all_agent_jobs(&self, workspace: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM outbox WHERE workspace_id = $1 AND kind = 'agent_job'",
        )
        .bind(workspace)
        .fetch_one(&self.su)
        .await
        .expect("count agent jobs")
    }
}

fn ids(list: &Value) -> Vec<String> {
    let mut ids: Vec<String> = list["approvals"]
        .as_array()
        .unwrap_or_else(|| panic!("`approvals` is an array: {list}"))
        .iter()
        .map(|row| row["id"].as_str().expect("row id").to_string())
        .collect();
    ids.sort();
    ids
}

fn sorted(mut ids: Vec<Uuid>) -> Vec<String> {
    ids.sort();
    ids.into_iter().map(|id| id.to_string()).collect()
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_pending_list_shows_only_the_callers_own_workspace_and_rooms() {
    let env = approvals_env().await;
    let a = seed_tenant(&env.su).await;
    let b = seed_tenant(&env.su).await;
    // 정하윤: a workspace member who is NOT in the approvals' channel.
    let (_, outsider_email) = seed_human(&env.su, a.workspace, "member", "정하윤", true).await;

    let mut pending_a = Vec::new();
    for _ in 0..4 {
        pending_a.push(seed_pending_approval(&env.su, &a, "1 hour").await.1);
    }
    let (_, pending_b) = seed_pending_approval(&env.su, &b, "1 hour").await;

    let owner_a = access_token(&env.http, &env.base, a.workspace, &a.owner_email).await;

    // B2 — a member sees all four, and every row says whose it is. camelCase.
    let (status, list) = env.list_pending(&owner_a, a.workspace).await;
    assert_eq!(status, 200, "{list}");
    assert_eq!(ids(&list), sorted(pending_a.clone()));
    for row in list["approvals"].as_array().expect("rows") {
        assert_eq!(row["workspaceId"], json!(a.workspace.to_string()), "{row}");
        assert_eq!(row["channelId"], json!(a.channel.to_string()), "{row}");
        assert_eq!(row["status"], json!("pending"), "{row}");
        assert_eq!(row["requestedBy"], json!(a.agent.to_string()), "{row}");
        assert!(
            row.get("workspace_id").is_none() && row.get("channel_id").is_none(),
            "the wire is camelCase only: {row}"
        );
    }
    assert!(
        !ids(&list).contains(&pending_b.to_string()),
        "the other tenant's approval never appears"
    );

    // B3 — a workspace member outside the room gets an EMPTY list, not a 403
    // and not the room's cards.
    let outsider = access_token(&env.http, &env.base, a.workspace, &outsider_email).await;
    let (status, list) = env.list_pending(&outsider, a.workspace).await;
    assert_eq!(status, 200, "{list}");
    assert_eq!(list["approvals"], json!([]), "{list}");

    // B4 — A's credential on B's path is a scope mismatch, for the list and for
    // a decision alike, and the decision decides nothing.
    let (status, body) = env.list_pending(&owner_a, b.workspace).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["error"]["message"], json!("workspace scope mismatch"));
    let (status, body) = env
        .decide(&owner_a, b.workspace, pending_b, true, Uuid::new_v4())
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["error"]["message"], json!("workspace scope mismatch"));
    assert_eq!(
        env.approval_state(pending_b).await,
        ("pending".to_string(), None),
        "the foreign decision decided nothing"
    );

    // B5 — B's own member sees exactly B's one card.
    let owner_b = access_token(&env.http, &env.base, b.workspace, &b.owner_email).await;
    let (status, list) = env.list_pending(&owner_b, b.workspace).await;
    assert_eq!(status, 200, "{list}");
    assert_eq!(ids(&list), sorted(vec![pending_b]));
    assert_eq!(
        list["approvals"][0]["workspaceId"],
        json!(b.workspace.to_string())
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_approval_writes_the_ledger_the_audit_row_and_exactly_one_resume_job() {
    let env = approvals_env().await;
    let t = seed_tenant(&env.su).await;
    let (run, approval) = seed_pending_approval(&env.su, &t, "1 hour").await;
    let token = access_token(&env.http, &env.base, t.workspace, &t.owner_email).await;
    let key = Uuid::new_v4();

    let (status, receipt) = env.decide(&token, t.workspace, approval, true, key).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["approvalId"], json!(approval.to_string()));
    assert_eq!(receipt["status"], json!("approved"));
    assert_eq!(receipt["decidedBy"], json!(t.owner.to_string()));
    assert!(
        receipt.get("approval_id").is_none() && receipt.get("decided_by").is_none(),
        "the receipt is camelCase only: {receipt}"
    );

    assert_eq!(
        env.approval_state(approval).await,
        ("approved".to_string(), Some(t.owner))
    );
    assert_eq!(
        env.run_status(run).await,
        "queued",
        "the parked run is released"
    );
    assert_eq!(
        env.ledger(approval).await,
        vec![("approved".to_string(), true, t.owner, key)],
        "one ledger row, keyed by the client's decision id"
    );
    assert_eq!(
        env.audit_rows(t.workspace, "approval.approved", approval)
            .await,
        1
    );
    assert_eq!(
        env.resume_jobs_for(t.workspace, approval).await,
        1,
        "one job that resumes THIS approval, not zero and not two"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_rejection_cancels_the_run_posts_the_tool_result_and_resumes_nothing() {
    let env = approvals_env().await;
    let t = seed_tenant(&env.su).await;
    let (run, approval) = seed_pending_approval(&env.su, &t, "1 hour").await;
    let token = access_token(&env.http, &env.base, t.workspace, &t.owner_email).await;
    let key = Uuid::new_v4();

    let (status, receipt) = env.decide(&token, t.workspace, approval, false, key).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["approvalId"], json!(approval.to_string()));
    assert_eq!(receipt["status"], json!("rejected"));
    assert_eq!(receipt["decidedBy"], json!(t.owner.to_string()));

    assert_eq!(
        env.approval_state(approval).await,
        ("rejected".to_string(), Some(t.owner))
    );
    assert_eq!(
        env.run_status(run).await,
        "cancelled",
        "a rejection ends the run — `cancelled`, not merely `not awaiting`"
    );
    assert_eq!(
        env.ledger(approval).await,
        vec![("rejected".to_string(), false, t.owner, key)]
    );
    assert_eq!(
        env.audit_rows(t.workspace, "approval.rejected", approval)
            .await,
        1
    );
    assert_eq!(
        env.resume_jobs_for(t.workspace, approval).await,
        0,
        "nothing resumes a rejected call"
    );
    assert_eq!(env.all_agent_jobs(t.workspace).await, 0);
    let tool_results: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message \
          WHERE workspace_id = $1 AND channel_id = $2 AND type = 'tool_result' \
            AND props->>'approval_id' = $3 AND props->>'status' = 'rejected'",
    )
    .bind(t.workspace)
    .bind(t.channel)
    .bind(approval.to_string())
    .fetch_one(&env.su)
    .await
    .expect("count tool_result");
    assert_eq!(
        tool_results, 0,
        "approval rejection no longer inserts a standalone tool_result"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_tap_after_the_deadline_settles_the_approval_as_expired_in_the_ledger() {
    let env = approvals_env().await;
    let t = seed_tenant(&env.su).await;
    let (run, approval) = seed_pending_approval(&env.su, &t, "-1 minute").await;
    let token = access_token(&env.http, &env.base, t.workspace, &t.owner_email).await;
    let key = Uuid::new_v4();

    let (status, receipt) = env.decide(&token, t.workspace, approval, true, key).await;
    assert_eq!(status, 409, "{receipt}");
    assert_eq!(receipt["approvalId"], json!(approval.to_string()));
    assert_eq!(receipt["status"], json!("expired"));

    assert_eq!(env.approval_state(approval).await.0, "expired");
    assert_eq!(
        env.run_status(run).await,
        "timed_out",
        "the held run ends as `timed_out`, not `cancelled`"
    );
    assert_eq!(
        env.ledger(approval).await,
        vec![("expired".to_string(), true, t.owner, key)],
        "the ledger records that the tap (approve) landed as `expired`"
    );
    assert_eq!(
        env.audit_rows(t.workspace, "approval.expired", approval)
            .await,
        1
    );
    assert_eq!(
        env.audit_rows(t.workspace, "approval.approved", approval)
            .await,
        0,
        "a late approve is not recorded as an approval"
    );
    assert_eq!(
        env.all_agent_jobs(t.workspace).await,
        0,
        "an expired approval releases no job"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_decision_by_a_non_member_changes_nothing_not_even_the_ledger() {
    let env = approvals_env().await;
    let t = seed_tenant(&env.su).await;
    // 최민수: a workspace ADMIN who is not in the approval's channel — authority
    // over the workspace is not membership of the room.
    let (_, outsider_email) = seed_human(&env.su, t.workspace, "admin", "최민수", true).await;
    let (run, approval) = seed_pending_approval(&env.su, &t, "1 hour").await;
    let outsider = access_token(&env.http, &env.base, t.workspace, &outsider_email).await;
    let key = Uuid::new_v4();

    let (status, receipt) = env
        .decide(&outsider, t.workspace, approval, true, key)
        .await;
    assert_eq!(status, 403, "{receipt}");
    assert_eq!(receipt["status"], json!("forbidden"));

    assert_eq!(
        env.approval_state(approval).await,
        ("pending".to_string(), None)
    );
    assert_eq!(env.run_status(run).await, "awaiting_approval");
    assert_eq!(
        env.ledger(approval).await,
        Vec::new(),
        "a refusal writes no ledger row"
    );
    for action in ["approval.approved", "approval.rejected", "approval.expired"] {
        assert_eq!(
            env.audit_rows(t.workspace, action, approval).await,
            0,
            "{action}"
        );
    }
    assert_eq!(env.all_agent_jobs(t.workspace).await, 0);

    // The control: the refusal was about the caller. The owner decides the very
    // same approval, and the same decision id the outsider burned is not stuck.
    let owner = access_token(&env.http, &env.base, t.workspace, &t.owner_email).await;
    let (status, receipt) = env.decide(&owner, t.workspace, approval, true, key).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(env.ledger(approval).await.len(), 1);
}
