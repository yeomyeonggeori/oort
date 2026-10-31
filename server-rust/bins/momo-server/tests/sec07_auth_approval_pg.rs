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
//! Since #4763 the file also holds the approval **list** as the inbox 「승인」 칸 reads it
//! (ADR-0186 v6 R-f), under its own banner at the end: all five states with who, when and the
//! card's sentence, newest-first order, the keyset page, `scope=mine`, rooms and workspaces.
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

// ---------------------------------------------------------------------------
// ADR-0186 v6 R-f (#4763) — the approval list as the inbox 「승인」 칸 reads it
// ---------------------------------------------------------------------------
//
// Fixtures are written as superuser; the server runs on `momo_app` (NOBYPASSRLS), so
// what a test sees is what a person sees. Two things are produced by the **real
// routes** on purpose — approve, reject, a late tap and a run stop — so the card's
// outcome sentence under test is the one the server itself wrote.

impl Env {
    async fn list(&self, token: &str, workspace: Uuid, query: &str) -> (u16, Value) {
        let response = self
            .http
            .get(format!(
                "{}/v1/workspaces/{workspace}/approvals?{query}",
                self.base
            ))
            .bearer_auth(token)
            .send()
            .await
            .expect("list approvals");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn stop_run(&self, token: &str, workspace: Uuid, run: Uuid) -> u16 {
        self.http
            .post(format!(
                "{}/v1/workspaces/{workspace}/agent-runs/{run}/cancel",
                self.base
            ))
            .bearer_auth(token)
            .send()
            .await
            .expect("stop run")
            .status()
            .as_u16()
    }
}

/// A room: `public`, `private` or `dm`.
async fn seed_room(su: &PgPool, workspace: Uuid, kind: &str, name: &str) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, dm_key) \
         VALUES ($1, $2, $3::channel_kind, CASE WHEN $3 = 'dm' THEN NULL ELSE $4 END, \
                 CASE WHEN $3 = 'dm' THEN $1::text END)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(kind)
    .bind(name)
    .execute(su)
    .await
    .expect("seed room");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed room seq");
    channel
}

/// An agent of the workspace, owned by `owner`, in `channel`.
async fn seed_agent_in(
    su: &PgPool,
    workspace: Uuid,
    channel: Uuid,
    owner: Uuid,
    handle: &str,
) -> Uuid {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, $3, 'https://gateway.invalid/v1', 8, 50, $4)",
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
    agent
}

async fn next_seq(su: &PgPool, workspace: Uuid, channel: Uuid) -> i64 {
    sqlx::query_scalar(
        "UPDATE channel_seq SET last_seq = last_seq + 1 \
          WHERE channel_id = $1 AND workspace_id = $2 RETURNING last_seq",
    )
    .bind(channel)
    .bind(workspace)
    .fetch_one(su)
    .await
    .expect("take the next channel seq")
}

/// A text message `author` typed: the request a run starts from.
async fn seed_request(su: &PgPool, workspace: Uuid, channel: Uuid, author: Uuid) -> Uuid {
    let seq = next_seq(su, workspace, channel).await;
    sqlx::query_scalar(
        "INSERT INTO message (workspace_id, channel_id, seq, hlc_ts, hlc_count, \
                              author_member_id, type, body) \
         VALUES ($1, $2, $3, $3, 0, $4, 'text', '@에이전트 해 줘') RETURNING id",
    )
    .bind(workspace)
    .bind(channel)
    .bind(seq)
    .bind(author)
    .fetch_one(su)
    .await
    .expect("seed request message")
}

/// One approval, as the producers and the decision route leave it.
struct Record<'a> {
    workspace: Uuid,
    channel: Uuid,
    agent: Uuid,
    /// `pending`, `approved`, `rejected`, `expired` or `cancelled`.
    status: &'a str,
    /// Only `approved` / `rejected` have a decider (`approval_decided_ck`).
    decided_by: Option<Uuid>,
    /// A timestamptz literal: when it was settled; for a pending one, when it was asked.
    moved: &'a str,
    /// A Postgres interval from now, for a pending one (`"-1 minute"` = already late).
    expires: &'a str,
    /// The human whose message started the run.
    asked_by: Option<Uuid>,
    /// Someone's `agent.work.queued` record instead of a trigger message.
    work_queued_by: Option<Uuid>,
    action_type: &'a str,
    payload: Value,
    /// The card message: extra props over the minimal real ones, and its body.
    card: Option<(Value, &'a str)>,
    /// The thread the card sits in.
    thread_root: Option<Uuid>,
}

impl<'a> Record<'a> {
    fn new(workspace: Uuid, channel: Uuid, agent: Uuid, status: &'a str, moved: &'a str) -> Self {
        Record {
            workspace,
            channel,
            agent,
            status,
            decided_by: None,
            moved,
            expires: "1 hour",
            asked_by: None,
            work_queued_by: None,
            action_type: "tool_call",
            payload: json!({"tool_call": {
                "call_id": "sec07", "name": "github.search_issues", "arguments": {},
            }}),
            card: None,
            thread_root: None,
        }
    }
}

struct Seeded {
    approval: Uuid,
    run: Uuid,
}

async fn seed_record(su: &PgPool, record: Record<'_>) -> Seeded {
    let Record {
        workspace,
        channel,
        agent,
        status,
        decided_by,
        moved,
        expires,
        asked_by,
        work_queued_by,
        action_type,
        payload,
        card,
        thread_root,
    } = record;
    let pending = status == "pending";
    let trigger = match asked_by {
        Some(author) => Some(seed_request(su, workspace, channel, author).await),
        None => None,
    };
    let run: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, trigger_message_id, \
                                status, finished_at) \
         VALUES ($1, $2, $3, $4, $5::run_status, CASE WHEN $6 THEN NULL ELSE now() END) \
         RETURNING id",
    )
    .bind(workspace)
    .bind(agent)
    .bind(channel)
    .bind(trigger)
    .bind(if pending {
        "awaiting_approval"
    } else {
        "cancelled"
    })
    .bind(pending)
    .fetch_one(su)
    .await
    .expect("seed run");
    if let Some(requester) = work_queued_by {
        sqlx::query(
            "INSERT INTO audit_log (workspace_id, actor_member_id, action, target_type, \
                                    target_id, run_id) \
             VALUES ($1, $2, 'agent.work.queued', 'agent_run', $3, $3)",
        )
        .bind(workspace)
        .bind(requester)
        .bind(run)
        .execute(su)
        .await
        .expect("seed work requester");
    }
    let approval = Uuid::new_v4();
    let card_id = match card {
        Some((extra, body)) => {
            let mut props = json!({
                "approval_id": approval.to_string(),
                "run_id": run.to_string(),
                "channel_id": channel.to_string(),
                "action_type": action_type,
                "status": "pending",
            });
            for (key, value) in extra.as_object().expect("card props are an object") {
                props[key] = value.clone();
            }
            let seq = next_seq(su, workspace, channel).await;
            Some(
                sqlx::query_scalar::<_, Uuid>(
                    "INSERT INTO message (workspace_id, channel_id, seq, hlc_ts, hlc_count, \
                                          author_member_id, type, body, props, root_id) \
                     VALUES ($1, $2, $3, $3, 0, $4, 'approval_request', $5, $6, $7) \
                     RETURNING id",
                )
                .bind(workspace)
                .bind(channel)
                .bind(seq)
                .bind(agent)
                .bind(body)
                .bind(props)
                .bind(thread_root)
                .fetch_one(su)
                .await
                .expect("seed approval card"),
            )
        }
        None => None,
    };
    sqlx::query(
        "INSERT INTO approval \
           (id, workspace_id, run_id, channel_id, request_message_id, requested_by, \
            action_type, payload, status, decided_by, decided_at, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::approval_status, $10, \
                 CASE WHEN $9 = 'pending' THEN NULL ELSE $11::timestamptz END, \
                 CASE WHEN $9 = 'pending' THEN $11::timestamptz \
                      ELSE $11::timestamptz - interval '10 minutes' END, \
                 CASE WHEN $9 = 'pending' THEN now() + $12::interval \
                      ELSE $11::timestamptz + interval '1 hour' END)",
    )
    .bind(approval)
    .bind(workspace)
    .bind(run)
    .bind(channel)
    .bind(card_id)
    .bind(agent)
    .bind(action_type)
    .bind(payload)
    .bind(status)
    .bind(decided_by)
    .bind(moved)
    .bind(expires)
    .execute(su)
    .await
    .expect("seed approval");
    Seeded { approval, run }
}

/// A pending tool-call approval **with its card**, asked "now".
async fn seed_asked(su: &PgPool, tenant: &Tenant, expires: &str) -> Seeded {
    let mut record = Record::new(
        tenant.workspace,
        tenant.channel,
        tenant.agent,
        "pending",
        "now",
    );
    record.expires = expires;
    record.asked_by = Some(tenant.owner);
    record.card = Some((
        json!({"tool_name": "github.search_issues"}),
        "도구 「github.search_issues」을 실행해도 될까요?",
    ));
    seed_record(su, record).await
}

fn row_of(page: &Value, approval: Uuid) -> &Value {
    page["approvals"]
        .as_array()
        .unwrap_or_else(|| panic!("`approvals` is an array: {page}"))
        .iter()
        .find(|row| row["id"] == json!(approval.to_string()))
        .unwrap_or_else(|| panic!("approval {approval} is in {page}"))
}

/// Row ids in the order the server sent them.
fn ordered_ids(page: &Value) -> Vec<String> {
    page["approvals"]
        .as_array()
        .unwrap_or_else(|| panic!("`approvals` is an array: {page}"))
        .iter()
        .map(|row| row["id"].as_str().expect("row id").to_string())
        .collect()
}

/// All five states come back in one read, each with who settled it, when, and the card's
/// own sentence — and a cancelled approval is one of them.
///
/// Each state is made by the route a person would use: approve, reject, a tap after the
/// deadline, a stop of the run; the fifth is still asking. So `result.line` is the
/// sentence the server wrote on the card, read back.
///
/// Revert that makes it red: drop `cancelled` from the statuses the read takes (the
/// stop's row is missing), drop `decided_by`/`decided_at` from the row (who and when are
/// gone), or read the outcome from anywhere but the card (the lines are missing or wrong).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_approval_list_reads_all_five_states_with_who_when_and_the_cards_sentence() {
    let env = approvals_env().await;
    let t = seed_tenant(&env.su).await;
    let pending = seed_asked(&env.su, &t, "1 hour").await;
    // A card that already carries an outcome while its approval is still asking: the card
    // alone cannot be told from a settled one, so the approval's own status decides, and
    // the row says nothing of an outcome.
    sqlx::query(
        "UPDATE message \
            SET props = props || jsonb_build_object('code', 'approval_approved', \
                                                    'result', jsonb_build_object('line', '남은 문장')), \
                body = '남은 문장' \
          WHERE id = (SELECT request_message_id FROM approval WHERE id = $1)",
    )
    .bind(pending.approval)
    .execute(&env.su)
    .await
    .expect("leave an outcome on a card that is still asking");
    let approved = seed_asked(&env.su, &t, "1 hour").await;
    let rejected = seed_asked(&env.su, &t, "1 hour").await;
    let late = seed_asked(&env.su, &t, "-1 minute").await;
    let stopped = seed_asked(&env.su, &t, "1 hour").await;
    let owner = access_token(&env.http, &env.base, t.workspace, &t.owner_email).await;

    let (status, receipt) = env
        .decide(&owner, t.workspace, approved.approval, true, Uuid::new_v4())
        .await;
    assert_eq!(status, 200, "{receipt}");
    let (status, receipt) = env
        .decide(
            &owner,
            t.workspace,
            rejected.approval,
            false,
            Uuid::new_v4(),
        )
        .await;
    assert_eq!(status, 200, "{receipt}");
    let (status, receipt) = env
        .decide(&owner, t.workspace, late.approval, true, Uuid::new_v4())
        .await;
    assert_eq!(
        status, 409,
        "a tap after the deadline settles it: {receipt}"
    );
    assert_eq!(env.stop_run(&owner, t.workspace, stopped.run).await, 200);

    let (status, page) = env.list(&owner, t.workspace, "status=all&limit=50").await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(
        ordered_ids(&page).len(),
        5,
        "five approvals, five states: {page}"
    );

    let waiting = row_of(&page, pending.approval);
    assert_eq!(waiting["status"], json!("pending"));
    for key in ["decidedBy", "decidedAtMs", "result"] {
        assert!(
            waiting.get(key).is_none(),
            "nothing is settled yet: {waiting}"
        );
    }

    let yes = row_of(&page, approved.approval);
    assert_eq!(yes["status"], json!("approved"));
    assert_eq!(yes["decidedBy"], json!(t.owner.to_string()));
    assert!(
        yes["decidedAtMs"].as_i64().is_some_and(|ms| ms > 0),
        "{yes}"
    );
    assert_eq!(yes["result"]["line"], json!("승인됐어요"));

    let no = row_of(&page, rejected.approval);
    assert_eq!(no["status"], json!("rejected"));
    assert_eq!(no["decidedBy"], json!(t.owner.to_string()));
    assert!(no["decidedAtMs"].as_i64().is_some_and(|ms| ms > 0), "{no}");
    assert_eq!(no["result"]["line"], json!("거부됐어요"));

    // Nobody decided these two: there is a time but no person.
    let lapsed = row_of(&page, late.approval);
    assert_eq!(lapsed["status"], json!("expired"));
    assert!(lapsed.get("decidedBy").is_none(), "{lapsed}");
    assert!(
        lapsed["decidedAtMs"].as_i64().is_some_and(|ms| ms > 0),
        "{lapsed}"
    );
    assert_eq!(
        lapsed["result"]["line"],
        json!("승인을 기다리다 만료됐어요")
    );

    let halted = row_of(&page, stopped.approval);
    assert_eq!(halted["status"], json!("cancelled"));
    assert!(halted.get("decidedBy").is_none(), "{halted}");
    assert!(
        halted["decidedAtMs"].as_i64().is_some_and(|ms| ms > 0),
        "{halted}"
    );
    assert_eq!(halted["result"]["line"], json!("요청을 멈췄어요"));

    // Newest first by when each last moved: the settled ones in the order they were
    // settled, and the one still asking (moved when it was asked, before them) last.
    let moved = |approval: Uuid| {
        let row = row_of(&page, approval);
        row["decidedAtMs"]
            .as_i64()
            .unwrap_or_else(|| row["createdAtMs"].as_i64().expect("createdAtMs"))
    };
    let order: Vec<i64> = ordered_ids(&page)
        .iter()
        .map(|id| moved(Uuid::parse_str(id).expect("uuid")))
        .collect();
    assert!(
        order.windows(2).all(|pair| pair[0] >= pair[1]),
        "newest first by when each moved: {order:?}"
    );

    // Each single status answers with exactly its own row, the cancelled one too.
    for (status, expected) in [
        ("pending", pending.approval),
        ("approved", approved.approval),
        ("rejected", rejected.approval),
        ("expired", late.approval),
        ("cancelled", stopped.approval),
    ] {
        let (code, one) = env
            .list(&owner, t.workspace, &format!("status={status}"))
            .await;
        assert_eq!(code, 200, "{one}");
        assert_eq!(ordered_ids(&one), vec![expected.to_string()], "{status}");
    }
}

/// A single settled status is read newest first. It used to come back in deadline order,
/// so under a `limit` it returned the **oldest** rows — the reason the inbox history only
/// ever showed what was already stale.
///
/// Revert that makes it red: order a settled read by `expires_at` again.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_settled_status_is_read_newest_first_so_a_limit_keeps_the_new_rows() {
    let env = approvals_env().await;
    let t = seed_tenant(&env.su).await;
    let mut ids = Vec::new();
    for moved in [
        "2026-10-30 09:00:00+00",
        "2026-10-30 10:00:00+00",
        "2026-10-30 11:00:00+00",
    ] {
        let mut record = Record::new(t.workspace, t.channel, t.agent, "approved", moved);
        record.decided_by = Some(t.owner);
        ids.push(seed_record(&env.su, record).await.approval.to_string());
    }
    let owner = access_token(&env.http, &env.base, t.workspace, &t.owner_email).await;
    let (status, page) = env.list(&owner, t.workspace, "status=approved").await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(
        ordered_ids(&page),
        vec![ids[2].clone(), ids[1].clone(), ids[0].clone()]
    );
    let (_, newest) = env
        .list(&owner, t.workspace, "status=approved&limit=1")
        .await;
    assert_eq!(ordered_ids(&newest), vec![ids[2].clone()], "{newest}");
}

/// Where each approval lives, and where it may be decided.
///
/// Revert that makes it red: read `isDirect` from anything but the channel's kind, take
/// `rootId` from anywhere but the card, or answer `decisionMode` by anything but the
/// server's one `decision_mode` judgment (a pin must be opened, a channel create need not; since
/// #4764 a tool outside the catalog is opened too).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn each_approval_says_where_it_lives_and_whether_it_opens_in_the_app() {
    let env = approvals_env().await;
    let t = seed_tenant(&env.su).await;
    let direct = seed_room(&env.su, t.workspace, "dm", "").await;
    join_channel(&env.su, t.workspace, direct, t.owner).await;
    join_channel(&env.su, t.workspace, direct, t.agent).await;
    let root = seed_request(&env.su, t.workspace, t.channel, t.owner).await;

    let mut top = Record::new(t.workspace, t.channel, t.agent, "pending", "now");
    top.action_type = "workspace_action";
    top.payload = json!({"action": {"id": "channel.create", "args": {"name": "plan"}}});
    top.card = Some((json!({}), "승인 요청: 채널 만들기"));
    let top = seed_record(&env.su, top).await;

    let mut threaded = Record::new(t.workspace, t.channel, t.agent, "pending", "now");
    threaded.card = Some((
        json!({}),
        "도구 「github.search_issues」을 실행해도 될까요?",
    ));
    threaded.thread_root = Some(root);
    let threaded = seed_record(&env.su, threaded).await;

    let mut dm = Record::new(t.workspace, direct, t.agent, "pending", "now");
    dm.card = Some((
        json!({}),
        "도구 「github.search_issues」을 실행해도 될까요?",
    ));
    let dm = seed_record(&env.su, dm).await;

    let mut pin = Record::new(t.workspace, t.channel, t.agent, "pending", "now");
    pin.action_type = "workspace_action";
    pin.payload = json!({"action": {"id": "message.pin", "args": {}}});
    pin.card = Some((json!({}), "승인 요청: 메시지 고정"));
    let pin = seed_record(&env.su, pin).await;

    let owner = access_token(&env.http, &env.base, t.workspace, &t.owner_email).await;
    let (status, page) = env.list(&owner, t.workspace, "status=pending").await;
    assert_eq!(status, 200, "{page}");

    let top_row = row_of(&page, top.approval);
    assert_eq!(top_row["isDirect"], json!(false));
    assert!(top_row.get("rootId").is_none(), "main stream: {top_row}");
    assert_eq!(top_row["decisionMode"], json!("inline"));

    let thread_row = row_of(&page, threaded.approval);
    assert_eq!(thread_row["isDirect"], json!(false));
    assert_eq!(thread_row["rootId"], json!(root.to_string()));
    assert_eq!(thread_row["channelId"], json!(t.channel.to_string()));

    let dm_row = row_of(&page, dm.approval);
    assert_eq!(dm_row["isDirect"], json!(true));
    assert_eq!(dm_row["channelId"], json!(direct.to_string()));

    let pin_row = row_of(&page, pin.approval);
    assert_eq!(
        pin_row["decisionMode"],
        json!("open"),
        "a pin names a message the person must read in the app"
    );
}

/// The keyset: a walk of the whole stream, two rows to a page, meets every row once and
/// in order — across a page edge that falls **inside** three approvals that moved at the
/// very same instant, and past a last page that is exactly full. A pending approval sits
/// in the stream where it was asked.
///
/// Revert that makes it red: compare the cursor with `<=` (a row repeats at each edge) or
/// without the id tie-break (the equal-instant rows are skipped or repeated), fetch `limit`
/// rows instead of one more (the exactly-full last page still promises another, or a short
/// page loses its last row), or page `pending` (it must keep its deadline order).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_list_pages_by_keyset_with_no_gap_or_repeat_at_an_edge_or_on_equal_times() {
    let env = approvals_env().await;
    let t = seed_tenant(&env.su).await;
    // (status, moved): the three at 12:02:00 are the equal instant.
    let settled = [
        ("approved", "2026-10-30 12:00:00+00"),
        ("rejected", "2026-10-30 12:01:00+00"),
        ("expired", "2026-10-30 12:02:00+00"),
        ("cancelled", "2026-10-30 12:02:00+00"),
        ("approved", "2026-10-30 12:02:00+00"),
        ("rejected", "2026-10-30 12:03:00+00"),
        ("approved", "2026-10-30 12:04:00+00"),
    ];
    let mut stream: Vec<(&str, Uuid)> = Vec::new();
    for (status, moved) in settled {
        let mut record = Record::new(t.workspace, t.channel, t.agent, status, moved);
        if matches!(status, "approved" | "rejected") {
            record.decided_by = Some(t.owner);
        }
        stream.push((moved, seed_record(&env.su, record).await.approval));
    }
    let asked = "2026-10-30 12:02:30+00";
    let pending = seed_record(
        &env.su,
        Record::new(t.workspace, t.channel, t.agent, "pending", asked),
    )
    .await
    .approval;
    stream.push((asked, pending));
    // Newest first, then the larger id first: the order the server promises.
    stream.sort_by(|a, b| b.cmp(a));
    let expected: Vec<String> = stream.iter().map(|(_, id)| id.to_string()).collect();
    assert_eq!(expected.len(), 8);
    let owner = access_token(&env.http, &env.base, t.workspace, &t.owner_email).await;

    // Walk it two at a time.
    let mut walked = Vec::new();
    let mut cursor: Option<String> = None;
    let mut cursors = Vec::new();
    let mut pages = 0;
    loop {
        let query = match &cursor {
            Some(token) => format!("status=all&limit=2&cursor={token}"),
            None => "status=all&limit=2".to_string(),
        };
        let (status, page) = env.list(&owner, t.workspace, &query).await;
        assert_eq!(status, 200, "{page}");
        pages += 1;
        assert!(pages <= 8, "the walk must end: {page}");
        assert!(ordered_ids(&page).len() <= 2, "{page}");
        walked.extend(ordered_ids(&page));
        match page["nextCursor"].as_str() {
            Some(next) => {
                cursors.push(next.to_string());
                cursor = Some(next.to_string());
            }
            None => break,
        }
    }
    assert_eq!(walked, expected, "every row once, newest first, ties by id");
    assert_eq!(
        pages, 4,
        "eight rows, two to a page: the fourth page is full and is the last"
    );
    assert_eq!(
        cursors.len(),
        3,
        "only the pages that have a next carry a cursor"
    );

    // The page edge after the second page lands inside the equal-instant group.
    let (_, from_inside) = env
        .list(
            &owner,
            t.workspace,
            &format!("status=all&limit=100&cursor={}", cursors[1]),
        )
        .await;
    assert_eq!(
        ordered_ids(&from_inside),
        expected[4..].to_vec(),
        "resuming from the middle of the equal-instant group, with another page size"
    );
    assert!(from_inside.get("nextCursor").is_none(), "{from_inside}");

    // The edge itself: exactly everything, then one short.
    let (_, whole) = env.list(&owner, t.workspace, "status=all&limit=8").await;
    assert_eq!(ordered_ids(&whole), expected);
    assert!(
        whole.get("nextCursor").is_none(),
        "a page that holds the rest has no next: {whole}"
    );
    let (_, short) = env.list(&owner, t.workspace, "status=all&limit=7").await;
    assert_eq!(ordered_ids(&short), expected[..7].to_vec());
    let next = short["nextCursor"].as_str().expect("one row is left");
    let (_, rest) = env
        .list(
            &owner,
            t.workspace,
            &format!("status=all&limit=7&cursor={next}"),
        )
        .await;
    assert_eq!(ordered_ids(&rest), expected[7..].to_vec(), "{rest}");
    assert!(rest.get("nextCursor").is_none(), "{rest}");

    // The to-decide queue keeps its deadline order and is not paged.
    let (_, queue) = env
        .list(&owner, t.workspace, "status=pending&limit=1")
        .await;
    assert_eq!(ordered_ids(&queue), vec![pending.to_string()]);
    assert!(queue.get("nextCursor").is_none(), "{queue}");
}

/// One approval of `tenant`'s room, settled (or asked) at 12:`minute`, shaped by `shape`.
async fn seed_at(
    su: &PgPool,
    tenant: &Tenant,
    status: &str,
    minute: u32,
    shape: impl FnOnce(&mut Record<'_>),
) -> Uuid {
    let moved = format!("2026-10-30 12:{minute:02}:00+00");
    let mut record = Record::new(
        tenant.workspace,
        tenant.channel,
        tenant.agent,
        status,
        &moved,
    );
    shape(&mut record);
    seed_record(su, record).await.approval
}

/// `scope=mine` is what the caller **decided**, **asked for** (a typed request, or a work
/// run they queued), or whose **agent they own** — each branch has its own approval that
/// is in no other branch — and only inside rooms they are still in. Another member of the
/// same workspace never sees them. `scope=team` is still every approval in the rooms.
///
/// Revert that makes it red: drop any one of the three branches (its approval vanishes
/// for the person it was theirs through), drop the room join (the private room's approval
/// appears for 정하윤), or widen `mine` to the room (박서연 sees 정하윤's).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn scope_mine_is_what_i_decided_asked_for_or_own_the_agent_of_inside_my_rooms() {
    let env = approvals_env().await;
    let t = seed_tenant(&env.su).await; // 이도현 (owner), agent owned by 이도현, #sec07
    let (bo, bo_email) = seed_human(&env.su, t.workspace, "member", "박서연", true).await;
    let (cy, cy_email) = seed_human(&env.su, t.workspace, "member", "정하윤", true).await;
    join_channel(&env.su, t.workspace, t.channel, bo).await;
    join_channel(&env.su, t.workspace, t.channel, cy).await;
    let bo_agent = seed_agent_in(&env.su, t.workspace, t.channel, bo, "owned-by-bo").await;
    let cy_agent = seed_agent_in(&env.su, t.workspace, t.channel, cy, "owned-by-cy").await;
    // A private room 정하윤 is not in.
    let hidden = seed_room(&env.su, t.workspace, "private", "비공개").await;
    for member in [t.owner, t.agent] {
        join_channel(&env.su, t.workspace, hidden, member).await;
    }

    // 정하윤 decided it; 이도현 asked, and owns the agent.
    let decided = seed_at(&env.su, &t, "rejected", 1, |r| {
        r.decided_by = Some(cy);
        r.asked_by = Some(t.owner);
    })
    .await;
    // 정하윤 asked; 이도현 decided, and owns the agent.
    let asked = seed_at(&env.su, &t, "approved", 2, |r| {
        r.decided_by = Some(t.owner);
        r.asked_by = Some(cy);
    })
    .await;
    // 정하윤 queued a work run (no trigger message): the second source of "asked".
    let queued = seed_at(&env.su, &t, "approved", 3, |r| {
        r.decided_by = Some(t.owner);
        r.work_queued_by = Some(cy);
    })
    .await;
    // 정하윤's agent; 이도현 asked and decided.
    let owned = seed_at(&env.su, &t, "approved", 4, |r| {
        r.agent = cy_agent;
        r.decided_by = Some(t.owner);
        r.asked_by = Some(t.owner);
    })
    .await;
    // Nothing of 정하윤's: 이도현 asked, decided, owns the agent.
    let other = seed_at(&env.su, &t, "approved", 5, |r| {
        r.decided_by = Some(t.owner);
        r.asked_by = Some(t.owner);
    })
    .await;
    // 박서연's agent, asked and decided by 이도현.
    let bo_owned = seed_at(&env.su, &t, "approved", 6, |r| {
        r.agent = bo_agent;
        r.decided_by = Some(t.owner);
        r.asked_by = Some(t.owner);
    })
    .await;
    // Asked by 정하윤 in a room she is not in.
    let in_hidden = seed_at(&env.su, &t, "approved", 7, |r| {
        r.channel = hidden;
        r.decided_by = Some(t.owner);
        r.asked_by = Some(cy);
    })
    .await;
    // Still asking: one 정하윤 asked, one 이도현 asked.
    let waiting_mine = seed_at(&env.su, &t, "pending", 8, |r| r.asked_by = Some(cy)).await;
    let waiting_other = seed_at(&env.su, &t, "pending", 9, |r| r.asked_by = Some(t.owner)).await;
    // An in-place channel grant 정하윤 asked for: not hers to decide, but hers.
    let in_place = seed_at(&env.su, &t, "pending", 10, |r| {
        r.action_type = "workspace_action";
        r.payload = json!({
            "origin": "server_in_place",
            "action": {"id": "hosted.channels.grant", "args": {}},
        });
        r.asked_by = Some(cy);
    })
    .await;

    let owner = access_token(&env.http, &env.base, t.workspace, &t.owner_email).await;
    let bo_token = access_token(&env.http, &env.base, t.workspace, &bo_email).await;
    let cy_token = access_token(&env.http, &env.base, t.workspace, &cy_email).await;
    let set = |ids: &[Uuid]| sorted(ids.to_vec());
    let seen = |page: &Value| {
        let mut ids = ordered_ids(page);
        ids.sort();
        ids
    };

    // 정하윤, mine: each of her four ways in, and the pending one she asked — no one
    // else's, nothing from the room she is not in.
    let (status, mine) = env
        .list(&cy_token, t.workspace, "status=all&scope=mine&limit=50")
        .await;
    assert_eq!(status, 200, "{mine}");
    assert_eq!(
        seen(&mine),
        set(&[decided, asked, queued, owned, waiting_mine, in_place]),
        "decided / asked / work-queued / owns the agent of, in her rooms: {mine}"
    );

    // 정하윤, team: every approval of her room, an in-place grant only for an admin.
    let (_, team) = env
        .list(&cy_token, t.workspace, "status=all&scope=team&limit=50")
        .await;
    assert_eq!(
        seen(&team),
        set(&[
            decided,
            asked,
            queued,
            owned,
            other,
            bo_owned,
            waiting_mine,
            waiting_other
        ]),
        "the whole room, minus the private one and the grant she cannot decide: {team}"
    );
    let (_, default_scope) = env
        .list(&cy_token, t.workspace, "status=all&limit=50")
        .await;
    assert_eq!(seen(&default_scope), seen(&team), "team is the default");

    // One status under `mine`.
    let (_, rejected) = env
        .list(&cy_token, t.workspace, "status=rejected&scope=mine")
        .await;
    assert_eq!(ordered_ids(&rejected), vec![decided.to_string()]);

    // 박서연: only the agent she owns. Not 정하윤's, though they share the room.
    let (_, bo_mine) = env
        .list(&bo_token, t.workspace, "status=all&scope=mine&limit=50")
        .await;
    assert_eq!(seen(&bo_mine), set(&[bo_owned]), "{bo_mine}");

    // 이도현 decided or asked or owns the agent of every one of them, the private room's too.
    let (_, owner_mine) = env
        .list(&owner, t.workspace, "status=all&scope=mine&limit=50")
        .await;
    assert_eq!(
        seen(&owner_mine),
        set(&[
            decided,
            asked,
            queued,
            owned,
            other,
            bo_owned,
            in_hidden,
            waiting_mine,
            waiting_other,
            in_place
        ]),
        "{owner_mine}"
    );
    // And the grant is listed for the admin under team as well.
    let (_, owner_team) = env
        .list(&owner, t.workspace, "status=pending&scope=team")
        .await;
    assert!(
        ordered_ids(&owner_team).contains(&in_place.to_string()),
        "an admin is who an in-place grant is listed to: {owner_team}"
    );
}

/// What a person cannot see in a room they are not in — or no longer in — stays out of
/// every status and both scopes, **including what they decided, asked for or own the agent
/// of**; and another workspace is a refusal, never a list.
///
/// Revert that makes it red: drop the room join (the outsider and the leaver read the
/// room's approvals), keep the room check on `team` only (`mine` still lists them), or
/// drop the workspace (the other tenant's owner reads this one's).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_room_i_am_not_in_and_another_workspace_show_me_no_approval_in_any_status_or_scope() {
    let env = approvals_env().await;
    let a = seed_tenant(&env.su).await;
    let b = seed_tenant(&env.su).await;
    // 최민수 never joined the room, but owns an agent that works in it and asked for a run.
    let (outsider, outsider_email) =
        seed_human(&env.su, a.workspace, "member", "최민수", true).await;
    let outsider_agent = seed_agent_in(
        &env.su,
        a.workspace,
        a.channel,
        outsider,
        "owned-by-outsider",
    )
    .await;
    // 정하윤 was in the room, decided one approval there, and left.
    let (leaver, leaver_email) = seed_human(&env.su, a.workspace, "member", "정하윤", true).await;
    join_channel(&env.su, a.workspace, a.channel, leaver).await;

    let mut theirs = Vec::new();
    for (status, minute) in [
        ("approved", 1),
        ("rejected", 2),
        ("expired", 3),
        ("cancelled", 4),
    ] {
        let moved = format!("2026-10-30 12:{minute:02}:00+00");
        let mut record = Record::new(a.workspace, a.channel, outsider_agent, status, &moved);
        record.asked_by = Some(outsider);
        if matches!(status, "approved" | "rejected") {
            record.decided_by = Some(leaver);
        }
        theirs.push(seed_record(&env.su, record).await.approval);
    }
    let mut waiting = Record::new(a.workspace, a.channel, outsider_agent, "pending", "now");
    waiting.asked_by = Some(outsider);
    theirs.push(seed_record(&env.su, waiting).await.approval);
    let foreign = seed_asked(&env.su, &b, "1 hour").await.approval;
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(a.channel)
        .bind(leaver)
        .execute(&env.su)
        .await
        .expect("the leaver leaves");

    let owner_a = access_token(&env.http, &env.base, a.workspace, &a.owner_email).await;
    let (_, control) = env.list(&owner_a, a.workspace, "status=all&limit=50").await;
    assert_eq!(
        ordered_ids(&control).len(),
        5,
        "the control: the room's own member sees all five, so the empties below are the gate: {control}"
    );

    for (who, email) in [("outsider", &outsider_email), ("leaver", &leaver_email)] {
        let token = access_token(&env.http, &env.base, a.workspace, email).await;
        for query in [
            "status=all&limit=50",
            "status=all&scope=mine&limit=50",
            "status=pending",
            "status=pending&scope=mine",
            "status=approved&scope=mine",
            "status=rejected&scope=mine",
            "status=expired&scope=mine",
            "status=cancelled&scope=mine",
        ] {
            let (status, page) = env.list(&token, a.workspace, query).await;
            assert_eq!(status, 200, "{who} {query}: {page}");
            assert_eq!(
                page["approvals"],
                json!([]),
                "{who} reads nothing of a room they are not in ({query}): {page}"
            );
        }
    }

    // Another workspace: A's owner on B's path is refused; B's owner reads only B's.
    let (status, body) = env.list(&owner_a, b.workspace, "status=all").await;
    assert_eq!(status, 403, "{body}");
    let owner_b = access_token(&env.http, &env.base, b.workspace, &b.owner_email).await;
    for query in ["status=all&limit=50", "status=all&scope=mine&limit=50"] {
        let (status, page) = env.list(&owner_b, b.workspace, query).await;
        assert_eq!(status, 200, "{page}");
        assert_eq!(ordered_ids(&page), vec![foreign.to_string()], "{query}");
    }
    for id in &theirs {
        let (_, page) = env.list(&owner_b, b.workspace, "status=all&limit=50").await;
        assert!(
            !ordered_ids(&page).contains(&id.to_string()),
            "another workspace's approval never appears"
        );
    }
}

/// What the read refuses is a 400 that says so, before anything is read.
///
/// Revert that makes it red: accept an unknown `status` or `scope`, let a cursor ride on
/// the unpaged `pending` read, or answer a cursor this server never issued with a page.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_status_scope_or_cursor_the_read_does_not_know_is_a_400() {
    let env = approvals_env().await;
    let t = seed_tenant(&env.su).await;
    seed_record(
        &env.su,
        Record::new(t.workspace, t.channel, t.agent, "pending", "now"),
    )
    .await;
    let owner = access_token(&env.http, &env.base, t.workspace, &t.owner_email).await;
    for (query, message) in [
        ("status=bogus", "status must be"),
        ("status=settled", "status must be"),
        ("scope=everyone", "scope must be"),
        (
            "status=pending&cursor=AAAA",
            "cursor is not supported with status=pending",
        ),
        ("cursor=AAAA", "cursor is not supported with status=pending"),
        ("status=all&cursor=not-a-cursor", "invalid approval cursor"),
        ("status=all&cursor=MTox", "invalid approval cursor"),
    ] {
        let (status, body) = env.list(&owner, t.workspace, query).await;
        assert_eq!(status, 400, "{query}: {body}");
        assert!(
            body["error"]["message"]
                .as_str()
                .is_some_and(|text| text.contains(message)),
            "{query}: {body}"
        );
    }
    // A blank cursor is no cursor.
    let (status, page) = env.list(&owner, t.workspace, "status=all&cursor=").await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(ordered_ids(&page).len(), 1);
}
