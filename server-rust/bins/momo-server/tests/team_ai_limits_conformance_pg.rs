//! ADR-0201 증보 v3 B9 (#4944) — the team AI's limits at the settings door and the screen's read,
//! against a real Postgres, through the real router as the non-bypass `momo_app` role.
//!
//! `team_ai_limits` is the administrator's: `PATCH …/settings` by a workspace owner/admin and
//! nowhere else. A limit is a real limit (`0`, a negative, a fraction, a word and an unknown field
//! are 400), merges one limit at a time, and a monthly dollar limit needs a model the server can
//! price. `GET|PATCH …/settings?include=team_ai_limits_status` adds the computed read the settings
//! screen shows (limits as set, the cap that applies after the operator's ceiling, today's and this
//! month's usage, whether a dollar limit can be switched on).
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/<db> \
//!   cargo test -p momo-server --test team_ai_limits_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `the_limits_are_the_administrators_door` | drop `require_workspace_operator` from the PATCH, or let an agent/member/guest through |
//! | `a_limit_is_a_real_limit_and_nothing_else_is_stored` | accept `0`, a negative, a fraction or an unknown field in `validate_team_ai_limits` |
//! | `a_patch_that_names_one_limit_never_moves_another` | replace the object instead of merging one level down |
//! | `a_dollar_limit_needs_a_model_the_server_can_price` | drop the availability check from the PATCH (cold start, unpriced model) |
//! | `the_price_check_agrees_with_the_usage_read` | change the match rule of `pricing_available_for_model_in_tx` without changing `agent_usage_in_tx` (or the other way round) |
//! | `the_status_read_explains_limits_ceiling_usage_and_availability` | compute the cap without the ceiling, count another workspace's ledger, or attach the status when it was not asked for |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_server::{build_app, AppState};
use momo_workspace_actions::team_ai_limits::OperatorCaps;
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "team-ai-limits-conformance-signing-secret";
const TEST_PASSWORD: &str = "team-ai-limits-test-password";
/// A model the test prices itself: one micro-dollar per token, in and out.
const PRICED_MODEL: &str = "limit-test-model";
/// A model nobody priced.
const UNPRICED_MODEL: &str = "limit-test-unpriced-model";

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
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password(&momo_app_password()))
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
    let mut ready = READY.lock().expect("schema lock");
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

async fn start_server(pool: PgPool, caps: OperatorCaps) -> String {
    let app = build_app(
        AppState::new(
            pool,
            TEST_JWT_SECRET.to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        )
        .with_team_ai_caps(caps),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

struct Human {
    id: Uuid,
    email: String,
}

struct Fixture {
    workspace: Uuid,
    owner: Human,
    admin: Human,
    member: Human,
    guest: Human,
    agent: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str) -> Human {
    let id = Uuid::new_v4();
    let email = format!("{id}@workspace-settings.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(id.to_string())
    .execute(su)
    .await
    .expect("seed human member");
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
    .expect("seed human auth");
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
    Human { id, email }
}

async fn seed_agent(su: &PgPool, workspace: Uuid, owner: Uuid) -> Uuid {
    let agent = Uuid::new_v4();
    let handle = format!("set-{}", &agent.simple().to_string()[..8]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent \
           (member_id, workspace_id, model, base_url, max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
    )
    .bind(agent)
    .bind(workspace)
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
    .expect("seed agent membership");
    agent
}

async fn seed(su: &PgPool, hint: &str) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let owner = seed_human(su, workspace, "owner").await;
    let admin = seed_human(su, workspace, "admin").await;
    let member = seed_human(su, workspace, "member").await;
    let guest = seed_human(su, workspace, "guest").await;
    let agent = seed_agent(su, workspace, owner.id).await;
    Fixture {
        workspace,
        owner,
        admin,
        member,
        guest,
        agent,
    }
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> String {
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
    assert_eq!(response.status(), 200, "seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("login returns an access token")
        .to_string()
}

async fn agent_bearer(su: &PgPool, workspace: Uuid, agent: Uuid) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{workspace}.{secret}");
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write']::text[], 'settings-conformance')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

fn settings_url(base: &str, workspace: Uuid) -> String {
    format!("{base}/v1/workspaces/{workspace}/settings")
}

fn with_status(url: &str) -> String {
    format!("{url}?include=team_ai_limits_status")
}

async fn get_settings(http: &reqwest::Client, url: &str, token: &str) -> reqwest::Response {
    http.get(url)
        .bearer_auth(token)
        .send()
        .await
        .expect("GET settings")
}

async fn patch_settings(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    body: &Value,
) -> reqwest::Response {
    http.patch(url)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .expect("PATCH settings")
}

async fn stored_settings(su: &PgPool, workspace: Uuid) -> Value {
    sqlx::query_scalar("SELECT settings FROM workspace WHERE id = $1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .expect("read stored settings")
}

async fn audit_count(su: &PgPool, workspace: Uuid, action: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*)::bigint FROM audit_log WHERE workspace_id = $1 AND action = $2",
    )
    .bind(workspace)
    .bind(action)
    .fetch_one(su)
    .await
    .expect("count audit rows")
}

/// Turn the team AI on the way the product does (the settings PATCH provisions the member) and
/// return the helper's member id.
async fn enable_the_helper(
    http: &reqwest::Client,
    url: &str,
    owner_token: &str,
    su: &PgPool,
    workspace: Uuid,
) -> Uuid {
    let response =
        patch_settings(http, url, owner_token, &json!({"team_ai_fast_path": true})).await;
    assert_eq!(response.status(), 200, "switch the helper on");
    let stored = stored_settings(su, workspace).await;
    stored["team_ai_agent_member_id"]
        .as_str()
        .and_then(|id| Uuid::parse_str(id).ok())
        .expect("the server wrote the helper's member id")
}

/// When a ledger row is stamped, relative to now (a row's order decides which one is "last").
async fn ledger(
    su: &PgPool,
    workspace: Uuid,
    helper: Uuid,
    model: &str,
    tokens: i32,
    searches: i32,
    minutes_ago: i32,
) {
    sqlx::query(
        "INSERT INTO usage_ledger (workspace_id, agent_member_id, model, prompt_tokens, \
                                   web_search_requests, created_at) \
         VALUES ($1, $2, $3, $4, $5, now() - make_interval(mins => $6))",
    )
    .bind(workspace)
    .bind(helper)
    .bind(model)
    .bind(tokens)
    .bind(searches)
    .bind(minutes_ago)
    .execute(su)
    .await
    .expect("ledger row");
}

async fn price_the_model(su: &PgPool, workspace: Uuid) {
    sqlx::query(
        "INSERT INTO model_pricing (workspace_id, model, currency, input_micro_usd_per_token, \
                                    output_micro_usd_per_token, cache_read_micro_usd_per_token, \
                                    effective_from) \
         VALUES ($1, $2, 'USD', 1, 1, 1, now() - interval '120 days')",
    )
    .bind(workspace)
    .bind(PRICED_MODEL)
    .execute(su)
    .await
    .expect("model_pricing row");
}

struct Door {
    http: reqwest::Client,
    su: PgPool,
    base: String,
    url: String,
    fixture: Fixture,
    owner: String,
}

/// A running server, one seeded workspace and its owner's login.
async fn door(caps: OperatorCaps) -> Door {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    // The api answers as the non-bypass role, so RLS applies to every read below.
    let (superuser, bypass): (bool, bool) =
        sqlx::query_as("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
            .fetch_one(&app)
            .await
            .expect("role attributes");
    assert!(
        !superuser && !bypass,
        "the api's role must be a non-bypass role (momo_app)"
    );
    let base = start_server(app, caps).await;
    let http = reqwest::Client::new();
    let fixture = seed(&su, "limits").await;
    let owner = login(&http, &base, fixture.workspace, &fixture.owner.email).await;
    let url = settings_url(&base, fixture.workspace);
    Door {
        http,
        su,
        base,
        url,
        fixture,
        owner,
    }
}

impl Door {
    async fn token_of(&self, human: &Human) -> String {
        login(&self.http, &self.base, self.fixture.workspace, &human.email).await
    }

    async fn patch(&self, body: Value) -> reqwest::Response {
        patch_settings(&self.http, &self.url, &self.owner, &body).await
    }

    async fn stored(&self) -> Value {
        stored_settings(&self.su, self.fixture.workspace).await
    }
}

// --- behaviour -----------------------------------------------------------------------------

/// B9-1: only a workspace owner/admin may set a limit. A member, a guest and an agent are 403 and
/// nothing is written; the owner and the admin are 200.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_limits_are_the_administrators_door() {
    let _guard = test_lock().await;
    let d = door(OperatorCaps::default()).await;
    let body = json!({"team_ai_limits": {"dailyTokens": 5000}});
    let member = d.token_of(&d.fixture.member).await;
    let guest = d.token_of(&d.fixture.guest).await;
    let agent = agent_bearer(&d.su, d.fixture.workspace, d.fixture.agent).await;
    for (who, token) in [("member", member), ("guest", guest), ("agent", agent)] {
        let response = patch_settings(&d.http, &d.url, &token, &body).await;
        assert_eq!(response.status(), 403, "{who} must not set a limit");
        assert!(
            d.stored().await.get("team_ai_limits").is_none(),
            "{who}: nothing written"
        );
    }
    assert_eq!(d.patch(body.clone()).await.status(), 200);
    assert_eq!(
        d.stored().await["team_ai_limits"],
        json!({"dailyTokens": 5000})
    );
    let admin = d.token_of(&d.fixture.admin).await;
    let raised = patch_settings(
        &d.http,
        &d.url,
        &admin,
        &json!({"team_ai_limits": {"dailyTokens": 9000}}),
    )
    .await;
    assert_eq!(raised.status(), 200, "an admin may too");
    assert_eq!(
        d.stored().await["team_ai_limits"],
        json!({"dailyTokens": 9000})
    );
}

/// B9-1: `0`, a negative, a fraction, a word, an unknown field and a wrong shape are 400 and the
/// bag is untouched (and no audit row says it changed). `0` is never a limit — switching the helper
/// off is `team_ai_fast_path`'s job.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_limit_is_a_real_limit_and_nothing_else_is_stored() {
    let _guard = test_lock().await;
    let d = door(OperatorCaps::default()).await;
    let before = audit_count(&d.su, d.fixture.workspace, "workspace_setting.updated").await;
    for bad in [
        json!({"team_ai_limits": {"dailyTokens": 0}}),
        json!({"team_ai_limits": {"dailyTokens": -1}}),
        json!({"team_ai_limits": {"dailyTokens": 2.5}}),
        json!({"team_ai_limits": {"dailyTokens": "many"}}),
        json!({"team_ai_limits": {"dailySearches": 0}}),
        json!({"team_ai_limits": {"dailySearches": -50}}),
        json!({"team_ai_limits": {"monthlyUsd": 0}}),
        json!({"team_ai_limits": {"monthlyUsd": -3}}),
        json!({"team_ai_limits": {"monthlyUsd": "five"}}),
        json!({"team_ai_limits": {"dailyToken": 5}}),
        json!({"team_ai_limits": {"dailyTokens": 5, "weeklyTokens": 5}}),
        json!({"team_ai_limits": [5]}),
        json!({"team_ai_limits": 5}),
        json!({"team_ai_limits": true}),
        json!({"team_ai_limits_status": {}}),
    ] {
        let response = d.patch(bad.clone()).await;
        assert_eq!(response.status(), 400, "{bad}");
        let stored = d.stored().await;
        assert!(
            stored.get("team_ai_limits").is_none(),
            "{bad}: nothing stored"
        );
        assert!(
            stored.get("team_ai_limits_status").is_none(),
            "{bad}: the computed read is not a writable key"
        );
    }
    assert_eq!(
        audit_count(&d.su, d.fixture.workspace, "workspace_setting.updated").await,
        before,
        "a refused patch leaves no audit row"
    );
    // Anti-vacuity: the same route takes a real limit.
    assert_eq!(
        d.patch(
            json!({"team_ai_limits": {"dailyTokens": 1, "dailySearches": 1, "monthlyUsd": null}})
        )
        .await
        .status(),
        200
    );
}

/// The limits merge one level down: naming one never moves another; `null` drops a field; a field
/// left with nothing is no limit and the key goes.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_patch_that_names_one_limit_never_moves_another() {
    let _guard = test_lock().await;
    let d = door(OperatorCaps::default()).await;
    assert_eq!(
        d.patch(json!({"team_ai_limits": {"dailyTokens": 100000}}))
            .await
            .status(),
        200
    );
    let second = d
        .patch(json!({"team_ai_limits": {"dailySearches": 20}}))
        .await;
    assert_eq!(second.status(), 200);
    let body: Value = second.json().await.unwrap();
    assert_eq!(
        body["team_ai_limits"],
        json!({"dailyTokens": 100000, "dailySearches": 20}),
        "naming dailySearches must not drop dailyTokens"
    );
    let dropped = d
        .patch(json!({"team_ai_limits": {"dailyTokens": null}}))
        .await;
    assert_eq!(dropped.status(), 200);
    assert_eq!(
        d.stored().await["team_ai_limits"],
        json!({"dailySearches": 20})
    );
    assert_eq!(
        d.patch(json!({"team_ai_limits": {"dailySearches": null}}))
            .await
            .status(),
        200
    );
    assert!(
        d.stored().await.get("team_ai_limits").is_none(),
        "no limit left: the key goes"
    );
}

/// B9-2: a monthly dollar limit needs a price. Refused (400 `team_ai_usd_limit_unavailable`,
/// nothing written) before the helper has answered anything and while its last request ran on a
/// model nobody priced; accepted once its last request ran on a priced one. A token limit is always
/// available, and clearing the dollar limit is always allowed.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_dollar_limit_needs_a_model_the_server_can_price() {
    let _guard = test_lock().await;
    let d = door(OperatorCaps::default()).await;
    let ws = d.fixture.workspace;
    let helper = enable_the_helper(&d.http, &d.url, &d.owner, &d.su, ws).await;
    price_the_model(&d.su, ws).await;
    let dollars = json!({"team_ai_limits": {"monthlyUsd": 5}});

    // Cold start: no request yet, so no model to ask about.
    let cold = d.patch(dollars.clone()).await;
    assert_eq!(cold.status(), 400);
    let error: Value = cold.json().await.unwrap();
    assert_eq!(
        error["error"]["code"], "team_ai_usd_limit_unavailable",
        "{error}"
    );
    assert!(d.stored().await.get("team_ai_limits").is_none());
    assert_eq!(
        d.patch(json!({"team_ai_limits": {"dailyTokens": 100}}))
            .await
            .status(),
        200,
        "a token limit needs no price"
    );

    // The last request ran on a model nobody priced.
    ledger(&d.su, ws, helper, UNPRICED_MODEL, 10, 0, 0).await;
    let unpriced = d.patch(dollars.clone()).await;
    assert_eq!(unpriced.status(), 400);
    assert_eq!(
        unpriced.json::<Value>().await.unwrap()["error"]["code"],
        "team_ai_usd_limit_unavailable"
    );
    assert_eq!(
        d.stored().await["team_ai_limits"],
        json!({"dailyTokens": 100}),
        "the refusal wrote nothing"
    );

    // Now the last request ran on a priced model.
    ledger(&d.su, ws, helper, PRICED_MODEL, 10, 0, 0).await;
    sqlx::query("UPDATE usage_ledger SET created_at = now() + interval '1 second' WHERE workspace_id = $1 AND model = $2")
        .bind(ws)
        .bind(PRICED_MODEL)
        .execute(&d.su)
        .await
        .unwrap();
    assert_eq!(d.patch(dollars.clone()).await.status(), 200);
    assert_eq!(
        d.stored().await["team_ai_limits"],
        json!({"dailyTokens": 100, "monthlyUsd": 5})
    );
    // Clearing it is always allowed.
    assert_eq!(
        d.patch(json!({"team_ai_limits": {"monthlyUsd": null}}))
            .await
            .status(),
        200
    );
    assert_eq!(
        d.stored().await["team_ai_limits"],
        json!({"dailyTokens": 100})
    );
}

/// B9-4: `?include=team_ai_limits_status` adds the computed read: the limits as set, the cap that
/// applies after the operator's ceiling, the ceiling, today's and this month's usage and whether a
/// dollar limit can be switched on. Without it the bag is what is stored (a workspace that never
/// wrote a key still reads `{}`), an unknown include is 400, another workspace's ledger never
/// counts, and the model is never named.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_status_read_explains_limits_ceiling_usage_and_availability() {
    let _guard = test_lock().await;
    let caps = OperatorCaps {
        daily_tokens: Some(400_000),
        daily_searches: None,
    };
    let d = door(caps).await;
    let ws = d.fixture.workspace;

    // Nothing stored: the plain GET is `{}`, and the status is asked for by name.
    let plain = get_settings(&d.http, &d.url, &d.owner).await;
    assert_eq!(plain.status(), 200);
    assert_eq!(plain.json::<Value>().await.unwrap(), json!({}));
    let unknown = get_settings(&d.http, &format!("{}?include=everything", d.url), &d.owner).await;
    assert_eq!(unknown.status(), 400);

    let helper = enable_the_helper(&d.http, &d.url, &d.owner, &d.su, ws).await;
    price_the_model(&d.su, ws).await;
    assert_eq!(
        d.patch(json!({"team_ai_limits": {"dailyTokens": 1_000_000, "dailySearches": 10}}))
            .await
            .status(),
        200
    );
    // Today: 500 tokens + 4 searches on an unpriced model, then 1,000,000 tokens ($1) on the priced
    // one, then 5,000 more on the unpriced one — the LAST request was on an unpriced model.
    ledger(&d.su, ws, helper, UNPRICED_MODEL, 500, 4, 30).await;
    ledger(&d.su, ws, helper, PRICED_MODEL, 1_000_000, 0, 20).await;
    ledger(&d.su, ws, helper, UNPRICED_MODEL, 5_000, 0, 10).await;
    // Another workspace with a huge ledger of its own must not leak into this read.
    let other = seed(&d.su, "limits-other").await;
    let other_helper = Uuid::new_v4();
    sqlx::query("INSERT INTO member (id, workspace_id, kind, display_name, handle) VALUES ($1, $2, 'agent', 'h', $3)")
        .bind(other_helper)
        .bind(other.workspace)
        .bind(format!("o{}", &other_helper.simple().to_string()[..8]))
        .execute(&d.su)
        .await
        .unwrap();
    ledger(
        &d.su,
        other.workspace,
        other_helper,
        UNPRICED_MODEL,
        9_000_000,
        99,
        5,
    )
    .await;

    let read = get_settings(&d.http, &with_status(&d.url), &d.owner).await;
    assert_eq!(read.status(), 200);
    let bag: Value = read.json().await.unwrap();
    assert_eq!(
        bag["team_ai_limits"],
        json!({"dailyTokens": 1_000_000, "dailySearches": 10})
    );
    let status = &bag["team_ai_limits_status"];
    assert_eq!(
        status["limits"],
        json!({"dailyTokens": 1_000_000, "dailySearches": 10, "monthlyUsd": null})
    );
    assert_eq!(
        status["effective"],
        json!({"dailyTokens": 400_000, "dailySearches": 10}),
        "the operator's 400,000 is lower than the workspace's 1,000,000"
    );
    assert_eq!(
        status["operatorCeiling"],
        json!({"dailyTokens": 400_000, "dailySearches": null, "helperOff": false, "searchOff": false})
    );
    assert_eq!(status["usage"]["todayTokens"], 1_005_500, "{status}");
    assert_eq!(status["usage"]["todaySearches"], 4);
    assert_eq!(status["usage"]["monthCostMicroUsd"], 1_000_000);
    assert_eq!(status["usage"]["monthRuns"], 3);
    assert_eq!(status["usage"]["monthUnpricedRuns"], 2);
    assert_eq!(status["monthlyUsdAvailable"], false);
    assert_eq!(status["monthlyUsdUnavailableReason"], "model_unpriced");
    assert!(
        !status.to_string().contains(UNPRICED_MODEL) && !status.to_string().contains(PRICED_MODEL),
        "only a boolean says whether the model is priced — never its name"
    );
    let now_ms = chrono_now_ms();
    let day = status["dayResetsAtMs"].as_i64().unwrap();
    let month = status["monthResetsAtMs"].as_i64().unwrap();
    assert!(
        day > now_ms && day <= now_ms + 86_400_000,
        "the day resets within 24h: {day}"
    );
    assert!(
        month > now_ms && month <= now_ms + 32 * 86_400_000,
        "the month resets within 32d: {month}"
    );

    // The last request on a priced model: a dollar limit can be switched on.
    ledger(&d.su, ws, helper, PRICED_MODEL, 1, 0, 0).await;
    let after = get_settings(&d.http, &with_status(&d.url), &d.owner)
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(after["team_ai_limits_status"]["monthlyUsdAvailable"], true);
    assert!(after["team_ai_limits_status"]["monthlyUsdUnavailableReason"].is_null());

    // A workspace with no ceiling and no limit: effective is "no limit".
    let free = door(OperatorCaps::default()).await;
    let free_status = get_settings(&free.http, &with_status(&free.url), &free.owner)
        .await
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(
        free_status["team_ai_limits_status"]["effective"],
        json!({"dailyTokens": null, "dailySearches": null})
    );
    assert_eq!(
        free_status["team_ai_limits_status"]["usage"]["todayTokens"],
        0
    );
    assert_eq!(
        free_status["team_ai_limits_status"]["monthlyUsdUnavailableReason"],
        "no_usage_yet"
    );

    // PATCH answers with the status too when asked, and a refused patch answers as before.
    let patched = patch_settings(
        &d.http,
        &with_status(&d.url),
        &d.owner,
        &json!({"team_ai_limits": {"dailyTokens": 123}}),
    )
    .await;
    assert_eq!(patched.status(), 200);
    let patched: Value = patched.json().await.unwrap();
    assert_eq!(
        patched["team_ai_limits_status"]["limits"]["dailyTokens"],
        123
    );
    assert_eq!(
        patched["team_ai_limits_status"]["effective"]["dailyTokens"],
        123
    );
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

/// The "can a dollar limit be switched on" check and the read-time dollar count are two statements
/// that must agree on what a price is: whatever `pricing_available_for_model_in_tx` calls priced,
/// `agent_usage_in_tx` must count in dollars (`unpriced_runs == 0`), and the other way round — a
/// vendor prefix, dots for dashes, a dated snapshot id, the workspace's own row and a plain miss.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_price_check_agrees_with_the_usage_read() {
    let _guard = test_lock().await;
    let d = door(OperatorCaps::default()).await;
    let ws = d.fixture.workspace;
    let helper = enable_the_helper(&d.http, &d.url, &d.owner, &d.su, ws).await;
    price_the_model(&d.su, ws).await;
    // Priced with dashes only: a model id written with dots is priced just by the dot→dash rule.
    sqlx::query(
        "INSERT INTO model_pricing (workspace_id, model, currency, input_micro_usd_per_token, \
                                    output_micro_usd_per_token, cache_read_micro_usd_per_token, \
                                    effective_from) \
         VALUES ($1, 'dotted-model-4-6', 'USD', 1, 1, 1, now() - interval '120 days')",
    )
    .bind(ws)
    .execute(&d.su)
    .await
    .expect("dotted price");
    let app = momo_app_pool().await;
    for (model, priced) in [
        (PRICED_MODEL, true),
        ("LIMIT-TEST-MODEL-2026-01-02", true),
        ("vendor/limit-test-model", true),
        ("openrouter/Dotted-Model-4.6", true),
        (UNPRICED_MODEL, false),
        ("limit-test", false),
        ("some-model-nobody-priced", false),
    ] {
        sqlx::query("DELETE FROM usage_ledger WHERE workspace_id = $1")
            .bind(ws)
            .execute(&d.su)
            .await
            .unwrap();
        ledger(&d.su, ws, helper, model, 10, 0, 0).await;
        let (available, unpriced_runs, runs) = with_tenant_tx(&app, ws, move |conn| {
            Box::pin(async move {
                let available =
                    momo_agent::pricing_available_for_model_in_tx(conn, ws, model).await?;
                let spend = momo_agent::agent_month_spend_in_tx(conn, ws, helper).await?;
                Ok((available, spend.unpriced_runs, spend.runs))
            })
        })
        .await
        .expect("read as momo_app");
        assert_eq!(runs, 1, "{model}: the row is this month's");
        assert_eq!(available, priced, "{model}: the price check");
        assert_eq!(
            unpriced_runs == 0,
            priced,
            "{model}: the usage read must count it exactly when the price check says priced"
        );
    }
}
