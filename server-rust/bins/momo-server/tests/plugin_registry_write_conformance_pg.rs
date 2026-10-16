//! ADR-0113 P3 / #3914 — the plugin registry's four writes (`POST/DELETE
//! …/plugins/{plugin}/install`, `POST …/grants`, `DELETE …/grants/{scope}`),
//! official four only, against a real Postgres through the real Axum router.
//!
//! 결재 원문: 2026-10-15 「이월 풀고 읽기부터 (추천)」(쓰기는 P3로 미룸) ·
//! 2026-10-16 「미뤄둔 후속도 같이 작업해줘.」
//!
//! Every assertion below is a *red proof*: it fails when the line that makes it
//! true is taken out. The table is the contract between this file and
//! `src/plugin_writes.rs`; the sabotage that was run for each row is recorded in
//! the PR body.
//!
//! | test | what removing it breaks |
//! |---|---|
//! | `install_and_uninstall_are_for_admins_and_the_manifest_policy` | the `require_admin` gate; the `serverPolicy` role check; the official-four guard (`external_webhook` / non-allowlisted → 404); the no-op of a repeated install; the suspended-member refusal |
//! | `a_grant_is_personal_and_needs_an_enabled_install` | the install-enabled check (409), the 404-before-409 order, the declared-scope check (400), `deny_unknown_fields` (a body naming another member), the guest refusal, the no-op of a repeated grant and the refresh of a drifted one |
//! | `revoking_a_grant_removes_its_projection_and_only_mine` | the `DELETE FROM plugin_capability_projection` in `revoke_grant`; the member predicate on the grant lookup; the official-four guard on a revoke (a seeded `external_webhook` grant must survive) |
//! | `uninstall_cascades_to_every_grant_and_projection` | the grant sweep and projection delete in `uninstall`; re-install must not resurrect consent; a straggler grant under a revoked install is healed by a repeat |
//! | `a_disabled_install_hides_the_tools_but_keeps_the_consent` | the policy join on `wpi.enabled` (D5 fail-closed) end to end through the writes |
//! | `another_workspace_never_sees_or_changes_my_rows` | RLS FORCE on the three tenant tables (checked as `momo_app`, non-vacuously, and `relforcerowsecurity` itself) |
//! | `no_credential_survives_any_request_or_response` | `deny_unknown_fields`; the audit detail allowlist; the response key allowlist |
//! | `the_wire_equals_the_mutation_fixtures_the_core_parser_reads` | any drift of a response from `server/Fixtures/plugin-wire/mutation-*.json` |
//! | `a_grant_waits_for_an_uninstall_in_flight_and_then_refuses` | the shared install key in `grant` (a grant can no longer outlive an uninstall) |
//! | `an_uninstall_waits_for_a_grant_in_flight_and_then_sweeps_it` | the exclusive install key in `uninstall`; the queue discipline that keeps a stream of grants from starving it |
//! | `every_write_leaves_exactly_one_audit_row` | the audit row per write, its actor / target / schema, and the FK it satisfies |
//! | `agent_bearers_cannot_reach_the_writes` | the agent-scope allowlist staying closed for these paths |
//! | `the_domain_function_refuses_a_member_that_is_not_a_human` | the `member.kind = 'human'` predicate in `plugin_writes::grant` itself |
//!
//! `plugin_registry` is a **global** table. Tests that tamper with an official
//! row restore it before asserting, and the whole binary holds one lock, so run
//! with `--test-threads=1`.
//!
//! `#[ignore]` — needs a real Postgres (pg18 + pgvector, superuser URL):
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test plugin_registry_write_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Regenerate the wire fixtures (only when a response legitimately changes):
//! add `PLUGIN_WIRE_FIXTURES_WRITE=1`.

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::plugin_manifest::is_secret_like_key;
use momo_server::plugin_writes::{self, Actor, Provenance};
use momo_server::{build_app, AppState};
use reqwest::Method;
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "plugin-registry-write-conformance-secret";
const TEST_PASSWORD: &str = "plugin-registry-test-password";

const GITHUB: &str = "com.momo.plugins.github";
const NOTION: &str = "com.momo.plugins.notion";
const DRIVE: &str = "com.momo.plugins.drive";
const EXTERNAL_WEBHOOK: &str = "external_webhook";
const EXTRA: &str = "com.momo.plugins.extra-write-conformance";

/// Placeholder the fixtures carry in place of a per-run uuid.
const ZERO_UUID: &str = "00000000-0000-0000-0000-000000000000";

/// Every key a mutation response may carry. Anything else on the wire fails
/// `no_credential_survives_any_request_or_response`.
const RESPONSE_KEYS: [&str; 8] = [
    "pluginId",
    "memberId",
    "scope",
    "status",
    "enabled",
    "auditRef",
    "capabilities",
    "egressDomains",
];

/// Every key an audit `detail` of these writes may carry.
const AUDIT_DETAIL_KEYS: [&str; 8] = [
    "schema",
    "plugin_id",
    "enabled",
    "scope",
    "version",
    "manifest_digest",
    "egress_domains",
    "tools",
];

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(6)
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

async fn start_server(pool: PgPool) -> String {
    let app = build_app(AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

struct Env {
    /// Superuser: seeds fixtures and reads the truth under RLS.
    su: PgPool,
    /// The runtime role, for the RLS check.
    app: PgPool,
    base: String,
    http: reqwest::Client,
}

async fn env() -> Env {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    Env {
        su,
        app,
        base,
        http: reqwest::Client::new(),
    }
}

// ---- fixtures ----------------------------------------------------------------

async fn seed_workspace(su: &PgPool, hint: &str) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    workspace
}

struct Human {
    id: Uuid,
    email: String,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str) -> Human {
    let id = Uuid::new_v4();
    let handle = format!("pw-{}", &id.simple().to_string()[..8]);
    let email = format!("{id}@plugins-write.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(&handle)
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
    sqlx::query(&format!(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, '{role}')"
    ))
    .bind(workspace)
    .bind(id)
    .execute(su)
    .await
    .expect("seed workspace membership");
    Human { id, email }
}

async fn login(env: &Env, workspace: Uuid, email: &str) -> String {
    let response = env
        .http
        .post(format!("{}/v1/auth/login", env.base))
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

/// A workspace with an owner, an admin and two plain members, all logged in.
struct Team {
    workspace: Uuid,
    owner: (Human, String),
    admin: (Human, String),
    alice: (Human, String),
    bob: (Human, String),
}

async fn team(env: &Env, hint: &str) -> Team {
    let workspace = seed_workspace(&env.su, hint).await;
    let mut people = Vec::new();
    for role in ["owner", "admin", "member", "member"] {
        let human = seed_human(&env.su, workspace, role).await;
        let token = login(env, workspace, &human.email).await;
        people.push((human, token));
    }
    let bob = people.pop().expect("bob");
    let alice = people.pop().expect("alice");
    let admin = people.pop().expect("admin");
    let owner = people.pop().expect("owner");
    Team {
        workspace,
        owner,
        admin,
        alice,
        bob,
    }
}

// ---- http --------------------------------------------------------------------

async fn call(
    env: &Env,
    method: Method,
    token: &str,
    path: &str,
    body: Option<&str>,
) -> (u16, Value) {
    let mut request = env
        .http
        .request(method, format!("{}{path}", env.base))
        .bearer_auth(token);
    if let Some(body) = body {
        request = request
            .header("content-type", "application/json")
            .body(body.to_string());
    }
    let response = request.send().await.expect("request");
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    (status, serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn plugin_path(workspace: Uuid, plugin: &str) -> String {
    format!("/v1/workspaces/{workspace}/plugins/{plugin}")
}

async fn install(
    env: &Env,
    token: &str,
    workspace: Uuid,
    plugin: &str,
    enabled: bool,
) -> (u16, Value) {
    call(
        env,
        Method::POST,
        token,
        &format!("{}/install", plugin_path(workspace, plugin)),
        Some(&json!({ "enabled": enabled }).to_string()),
    )
    .await
}

async fn uninstall(env: &Env, token: &str, workspace: Uuid, plugin: &str) -> (u16, Value) {
    call(
        env,
        Method::DELETE,
        token,
        &format!("{}/install", plugin_path(workspace, plugin)),
        None,
    )
    .await
}

async fn grant(env: &Env, token: &str, workspace: Uuid, plugin: &str, scope: &str) -> (u16, Value) {
    call(
        env,
        Method::POST,
        token,
        &format!("{}/grants", plugin_path(workspace, plugin)),
        Some(&json!({ "scope": scope }).to_string()),
    )
    .await
}

/// `encodeURIComponent` the way the deployed core client does: `github%3Aread`.
async fn revoke(
    env: &Env,
    token: &str,
    workspace: Uuid,
    plugin: &str,
    scope: &str,
) -> (u16, Value) {
    call(
        env,
        Method::DELETE,
        token,
        &format!(
            "{}/grants/{}",
            plugin_path(workspace, plugin),
            scope.replace(':', "%3A")
        ),
        None,
    )
    .await
}

async fn catalog(env: &Env, token: &str, workspace: Uuid) -> Value {
    let (status, body) = call(
        env,
        Method::GET,
        token,
        &format!("/v1/workspaces/{workspace}/plugins"),
        None,
    )
    .await;
    assert_eq!(status, 200, "catalog: {body}");
    body
}

fn catalog_item<'a>(catalog: &'a Value, plugin: &str) -> &'a Value {
    catalog["plugins"]
        .as_array()
        .expect("plugins")
        .iter()
        .find(|item| item["pluginId"] == plugin)
        .unwrap_or_else(|| panic!("{plugin} in the catalog"))
}

/// The tool names the caller's own policy lists for `plugin`.
fn policy_tools(catalog: &Value, plugin: &str) -> Vec<String> {
    catalog["toolPolicy"]["plugins"]
        .as_array()
        .expect("toolPolicy.plugins")
        .iter()
        .filter(|descriptor| descriptor["pluginId"] == plugin)
        .flat_map(|descriptor| descriptor["tools"].as_array().expect("tools").clone())
        .map(|tool| tool["name"].as_str().expect("tool name").to_string())
        .collect()
}

fn keys_of(value: &Value, into: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                into.insert(key.clone());
                keys_of(child, into);
            }
        }
        Value::Array(items) => items.iter().for_each(|child| keys_of(child, into)),
        _ => {}
    }
}

// ---- database truth ----------------------------------------------------------

async fn count(su: &PgPool, sql: &str, workspace: Uuid, plugin: &str) -> i64 {
    sqlx::query_scalar(sql)
        .bind(workspace)
        .bind(plugin)
        .fetch_one(su)
        .await
        .expect("count")
}

async fn projection_rows(su: &PgPool, workspace: Uuid, plugin: &str) -> i64 {
    count(
        su,
        "SELECT count(*) FROM plugin_capability_projection \
          WHERE workspace_id = $1 AND plugin_id = $2",
        workspace,
        plugin,
    )
    .await
}

async fn member_projection_rows(su: &PgPool, workspace: Uuid, member: Uuid, plugin: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM plugin_capability_projection \
          WHERE workspace_id = $1 AND member_id = $2 AND plugin_id = $3",
    )
    .bind(workspace)
    .bind(member)
    .bind(plugin)
    .fetch_one(su)
    .await
    .expect("member projection rows")
}

async fn grant_status(
    su: &PgPool,
    workspace: Uuid,
    member: Uuid,
    plugin: &str,
    scope: &str,
) -> Option<String> {
    sqlx::query_scalar(
        "SELECT status FROM plugin_grant \
          WHERE workspace_id = $1 AND member_id = $2 AND plugin_id = $3 AND scope = $4",
    )
    .bind(workspace)
    .bind(member)
    .bind(plugin)
    .bind(scope)
    .fetch_optional(su)
    .await
    .expect("grant status")
}

async fn active_grants(su: &PgPool, workspace: Uuid, plugin: &str) -> i64 {
    count(
        su,
        "SELECT count(*) FROM plugin_grant \
          WHERE workspace_id = $1 AND plugin_id = $2 AND status = 'active'",
        workspace,
        plugin,
    )
    .await
}

async fn install_rows(su: &PgPool, workspace: Uuid, plugin: &str) -> i64 {
    count(
        su,
        "SELECT count(*) FROM workspace_plugin_install WHERE workspace_id = $1 AND plugin_id = $2",
        workspace,
        plugin,
    )
    .await
}

/// `(enabled, revoked)` of the workspace's install row.
async fn install_state(su: &PgPool, workspace: Uuid, plugin: &str) -> Option<(bool, bool)> {
    sqlx::query_as(
        "SELECT enabled, revoked_at IS NOT NULL FROM workspace_plugin_install \
          WHERE workspace_id = $1 AND plugin_id = $2",
    )
    .bind(workspace)
    .bind(plugin)
    .fetch_optional(su)
    .await
    .expect("install state")
}

async fn audit_count(su: &PgPool, workspace: Uuid, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = $2")
        .bind(workspace)
        .bind(action)
        .fetch_one(su)
        .await
        .expect("audit count")
}

async fn plugin_audit_total(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action LIKE 'plugin.%'",
    )
    .bind(workspace)
    .fetch_one(su)
    .await
    .expect("plugin audit total")
}

/// How many stored rows, in any table these writes touch, mention `marker`.
async fn marker_rows(su: &PgPool, marker: &str) -> i64 {
    let pattern = format!("%{marker}%");
    sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM plugin_registry t WHERE to_jsonb(t)::text LIKE $1) \
              + (SELECT count(*) FROM audit_log t WHERE to_jsonb(t)::text LIKE $1) \
              + (SELECT count(*) FROM workspace_plugin_install t WHERE to_jsonb(t)::text LIKE $1) \
              + (SELECT count(*) FROM plugin_grant t WHERE to_jsonb(t)::text LIKE $1) \
              + (SELECT count(*) FROM plugin_capability_projection t WHERE to_jsonb(t)::text LIKE $1)",
    )
    .bind(pattern)
    .fetch_one(su)
    .await
    .expect("marker rows")
}

// ---- global-row tampering, always restored -------------------------------------

#[derive(Clone)]
struct RegistrySnapshot {
    plugin_id: String,
    manifest: String,
    digest: String,
    official: bool,
    revoked: bool,
}

async fn snapshot(su: &PgPool, plugin: &str) -> RegistrySnapshot {
    let (manifest, digest, official, revoked): (String, String, bool, bool) = sqlx::query_as(
        "SELECT manifest::text, manifest_digest, official, revoked_at IS NOT NULL \
           FROM plugin_registry WHERE plugin_id = $1",
    )
    .bind(plugin)
    .fetch_one(su)
    .await
    .expect("snapshot registry row");
    RegistrySnapshot {
        plugin_id: plugin.to_string(),
        manifest,
        digest,
        official,
        revoked,
    }
}

async fn restore(su: &PgPool, row: &RegistrySnapshot) {
    sqlx::query(
        "UPDATE plugin_registry \
            SET manifest = $2::jsonb, manifest_digest = $3, official = $4, \
                revoked_at = CASE WHEN $5 THEN COALESCE(revoked_at, now()) ELSE NULL END \
          WHERE plugin_id = $1",
    )
    .bind(&row.plugin_id)
    .bind(&row.manifest)
    .bind(&row.digest)
    .bind(row.official)
    .bind(row.revoked)
    .execute(su)
    .await
    .expect("restore registry row");
}

/// Replace a row's manifest and rotate its digest with the runtime expression,
/// so only the validator and the install policy (not the digest gate) stand
/// between the manifest and the write.
async fn set_manifest_rotating_digest(su: &PgPool, plugin: &str, manifest: &Value) {
    sqlx::query(
        "UPDATE plugin_registry \
            SET manifest = $2::jsonb, \
                manifest_digest = 'sha256:' || encode(sha256(convert_to(($2::jsonb)::text, 'UTF8')), 'hex') \
          WHERE plugin_id = $1",
    )
    .bind(plugin)
    .bind(manifest.to_string())
    .execute(su)
    .await
    .expect("tamper manifest (digest rotated)");
}

async fn manifest_value(su: &PgPool, plugin: &str) -> Value {
    let text: String =
        sqlx::query_scalar("SELECT manifest::text FROM plugin_registry WHERE plugin_id = $1")
            .bind(plugin)
            .fetch_one(su)
            .await
            .expect("manifest");
    serde_json::from_str(&text).expect("manifest json")
}

fn repo_root() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.."))
}

// ---- 1. who may install, who may uninstall ---------------------------------------

#[tokio::test]
#[ignore]
async fn install_and_uninstall_are_for_admins_and_the_manifest_policy() {
    let _guard = test_lock().await;
    let env = env().await;
    let t = team(&env, "plugins-install-gate").await;
    let ws = t.workspace;

    // A plain member: 403 on both, and nothing was written.
    let (status, body) = install(&env, &t.alice.1, ws, GITHUB, true).await;
    assert_eq!(status, 403, "member install: {body}");
    assert_eq!(body["error"]["message"], "workspace admin required");
    let (status, _) = uninstall(&env, &t.alice.1, ws, GITHUB).await;
    assert_eq!(status, 403, "member uninstall");
    assert_eq!(install_rows(&env.su, ws, GITHUB).await, 0);
    assert_eq!(
        plugin_audit_total(&env.su, ws).await,
        0,
        "a refusal writes no audit"
    );

    // An admin installs: 201, a body the core parser reads, the receipt of what
    // the app reaches (D5), and the row says who did it.
    let (status, body) = install(&env, &t.admin.1, ws, GITHUB, true).await;
    assert_eq!(status, 201, "admin install: {body}");
    assert_eq!(body["pluginId"], GITHUB);
    assert_eq!(body["status"], "enabled");
    assert_eq!(body["enabled"], true);
    assert_eq!(body["capabilities"], json!([]));
    assert_eq!(body["egressDomains"], json!(["api.githubcopilot.com"]));
    assert!(body.get("memberId").is_none() && body.get("scope").is_none());
    let (installed_by, audit_ref): (Uuid, Uuid) = sqlx::query_as(
        "SELECT installed_by, installed_audit_id FROM workspace_plugin_install \
          WHERE workspace_id = $1 AND plugin_id = $2",
    )
    .bind(ws)
    .bind(GITHUB)
    .fetch_one(&env.su)
    .await
    .expect("install row");
    assert_eq!(installed_by, t.admin.0.id);
    assert_eq!(body["auditRef"], audit_ref.to_string());

    // The same call again is a no-op, not a second record: 200, the first call's
    // audit row, the first installer still on the row, and nothing written.
    let (status, again) = install(&env, &t.owner.1, ws, GITHUB, true).await;
    assert_eq!(status, 200, "re-install: {again}");
    assert_eq!(again["auditRef"], body["auditRef"], "the install in force");
    assert_eq!(install_rows(&env.su, ws, GITHUB).await, 1);
    assert_eq!(
        audit_count(&env.su, ws, "plugin.installed").await,
        1,
        "a repeat writes no audit row"
    );
    let still_by: Uuid = sqlx::query_scalar(
        "SELECT installed_by FROM workspace_plugin_install \
          WHERE workspace_id = $1 AND plugin_id = $2",
    )
    .bind(ws)
    .bind(GITHUB)
    .fetch_one(&env.su)
    .await
    .expect("installed_by");
    assert_eq!(
        still_by, t.admin.0.id,
        "a repeat does not rewrite who installed it"
    );
    // A change of state is a record: off, then on, writes two more.
    let (status, off) = install(&env, &t.owner.1, ws, GITHUB, false).await;
    assert_eq!(status, 200, "{off}");
    assert_ne!(off["auditRef"], body["auditRef"]);
    let (status, _) = install(&env, &t.owner.1, ws, GITHUB, true).await;
    assert_eq!(status, 200);
    assert_eq!(audit_count(&env.su, ws, "plugin.installed").await, 3);

    // Without a body the manifest's enabledByDefault (false) decides.
    let (status, body) = call(
        &env,
        Method::POST,
        &t.owner.1,
        &format!("{}/install", plugin_path(ws, NOTION)),
        None,
    )
    .await;
    assert_eq!(status, 201, "no body: {body}");
    assert_eq!(body["status"], "disabled");
    assert_eq!(body["enabled"], false);

    // The official four and nothing else: an unknown id, the webhook plugin's
    // registry row, and a valid official manifest that is not one of the four.
    let github = snapshot(&env.su, GITHUB).await;
    let mut extra = manifest_value(&env.su, GITHUB).await;
    extra["plugin"]["id"] = json!(EXTRA);
    sqlx::query(
        "INSERT INTO plugin_registry (plugin_id, version, manifest, manifest_digest, official) \
         VALUES ($1, '1.0.0', $2::jsonb, \
                 'sha256:' || encode(sha256(convert_to(($2::jsonb)::text, 'UTF8')), 'hex'), true) \
         ON CONFLICT (plugin_id) DO NOTHING",
    )
    .bind(EXTRA)
    .bind(extra.to_string())
    .execute(&env.su)
    .await
    .expect("seed an official row outside the four");
    for outside in ["com.momo.plugins.unknown", EXTERNAL_WEBHOOK, EXTRA] {
        let (status, body) = install(&env, &t.owner.1, ws, outside, true).await;
        assert_eq!(status, 404, "{outside}: {body}");
        assert_eq!(install_rows(&env.su, ws, outside).await, 0);
    }
    let (status, _) = install(&env, &t.owner.1, ws, "Bad Id!", true).await;
    assert_eq!(status, 400, "an id outside the registry grammar");

    // A registry row revoked since can no longer be installed (404)…
    sqlx::query("UPDATE plugin_registry SET revoked_at = now() WHERE plugin_id = $1")
        .bind(DRIVE)
        .execute(&env.su)
        .await
        .expect("revoke drive in the registry");
    let (status, _) = install(&env, &t.owner.1, ws, DRIVE, true).await;
    sqlx::query("UPDATE plugin_registry SET revoked_at = NULL WHERE plugin_id = $1")
        .bind(DRIVE)
        .execute(&env.su)
        .await
        .expect("restore drive");
    assert_eq!(status, 404, "a revoked registry row");

    // …and one whose manifest no longer matches its digest is a 409.
    sqlx::query("UPDATE plugin_registry SET manifest_digest = $2 WHERE plugin_id = $1")
        .bind(GITHUB)
        .bind(format!("sha256:{}", "0".repeat(64)))
        .execute(&env.su)
        .await
        .expect("break the digest");
    let (status, body) = install(&env, &t.owner.1, ws, GITHUB, true).await;
    restore(&env.su, &github).await;
    assert_eq!(status, 409, "digest mismatch: {body}");
    assert!(body["error"]["message"]
        .as_str()
        .expect("message")
        .starts_with("plugin manifest rejected"));

    // The manifest's own serverPolicy is judged against the role as well:
    // owner-only means an admin is refused, and installAllowed=false refuses all.
    let mut owner_only = manifest_value(&env.su, GITHUB).await;
    owner_only["momo"]["serverPolicy"]["allowedRoles"] = json!(["owner"]);
    set_manifest_rotating_digest(&env.su, GITHUB, &owner_only).await;
    let (admin_status, admin_body) = install(&env, &t.admin.1, ws, GITHUB, true).await;
    let (owner_status, _) = install(&env, &t.owner.1, ws, GITHUB, true).await;
    restore(&env.su, &github).await;
    assert_eq!(
        admin_status, 403,
        "owner-only plugin, admin caller: {admin_body}"
    );
    assert_eq!(
        admin_body["error"]["message"],
        "plugin serverPolicy rejects installation"
    );
    assert_eq!(owner_status, 200, "owner-only plugin, owner caller");

    let mut closed = manifest_value(&env.su, GITHUB).await;
    closed["momo"]["serverPolicy"]["installAllowed"] = json!(false);
    set_manifest_rotating_digest(&env.su, GITHUB, &closed).await;
    let (status, _) = install(&env, &t.owner.1, ws, GITHUB, true).await;
    restore(&env.su, &github).await;
    assert_eq!(status, 403, "installAllowed=false refuses even an owner");

    // Uninstall: an admin only, and only an install that exists.
    let (status, body) = uninstall(&env, &t.admin.1, ws, DRIVE).await;
    assert_eq!(status, 404, "never installed: {body}");
    assert_eq!(body["error"]["message"], "plugin install not found");

    // A suspended member keeps a membership row and a valid token, and is refused:
    // `active_workspace_role` joins `member.status`.
    sqlx::query("UPDATE member SET status = 'suspended' WHERE workspace_id = $1 AND id = $2")
        .bind(ws)
        .bind(t.admin.0.id)
        .execute(&env.su)
        .await
        .expect("suspend the admin");
    let (status, body) = install(&env, &t.admin.1, ws, NOTION, true).await;
    assert_eq!(status, 403, "suspended admin: {body}");
    let (status, _) = uninstall(&env, &t.admin.1, ws, GITHUB).await;
    assert_eq!(status, 403, "suspended admin uninstall");
    sqlx::query("UPDATE member SET status = 'active' WHERE workspace_id = $1 AND id = $2")
        .bind(ws)
        .bind(t.admin.0.id)
        .execute(&env.su)
        .await
        .expect("reinstate the admin");

    // A member whose membership ended gets 403 on the writes (reads give 404).
    sqlx::query("DELETE FROM workspace_membership WHERE workspace_id = $1 AND member_id = $2")
        .bind(ws)
        .bind(t.admin.0.id)
        .execute(&env.su)
        .await
        .expect("end membership");
    let (status, body) = install(&env, &t.admin.1, ws, NOTION, true).await;
    assert_eq!(status, 403, "former admin: {body}");
    assert_eq!(body["error"]["message"], "not a workspace member");
    let (status, _) = uninstall(&env, &t.admin.1, ws, GITHUB).await;
    assert_eq!(status, 403, "former admin uninstall");

    // The registry row this test added outside the four does not outlive it.
    sqlx::query("DELETE FROM plugin_registry WHERE plugin_id = $1")
        .bind(EXTRA)
        .execute(&env.su)
        .await
        .expect("remove the extra registry row");
}

// ---- 2. grants: personal, declared, behind an enabled install --------------------

#[tokio::test]
#[ignore]
async fn a_grant_is_personal_and_needs_an_enabled_install() {
    let _guard = test_lock().await;
    let env = env().await;
    let t = team(&env, "plugins-grant").await;
    let ws = t.workspace;
    let alice = t.alice.0.id;

    // Not installed: 409 for an official app, 404 for an id outside the four
    // (so install state never leaks for an id the caller cannot see).
    let (status, body) = grant(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    assert_eq!(status, 409, "no install: {body}");
    assert_eq!(
        body["error"]["message"],
        "plugin is not installed and enabled"
    );
    let (status, _) = grant(&env, &t.alice.1, ws, EXTERNAL_WEBHOOK, "webhook:receive").await;
    assert_eq!(status, 404, "outside the four");
    assert_eq!(active_grants(&env.su, ws, GITHUB).await, 0);

    // An install that is present but disabled is the same 409.
    install(&env, &t.admin.1, ws, GITHUB, false).await;
    let (status, _) = grant(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    assert_eq!(status, 409, "installed but disabled");
    install(&env, &t.admin.1, ws, GITHUB, true).await;

    // A scope the app does not declare, or that is not a scope at all: 400.
    for bad in ["github:write", "notion:read", "not a scope", ""] {
        let (status, body) = grant(&env, &t.alice.1, ws, GITHUB, bad).await;
        assert_eq!(status, 400, "{bad:?}: {body}");
    }
    assert_eq!(active_grants(&env.su, ws, GITHUB).await, 0);

    // A member grants herself github:read: 201, one capability per tool that
    // declares the scope (two since migration 031), the receipt of the egress.
    let (status, body) = grant(&env, &t.alice.1, ws, GITHUB, "GitHub:Read").await;
    assert_eq!(status, 201, "alice grants: {body}");
    assert_eq!(body["memberId"], alice.to_string());
    assert_eq!(body["scope"], "github:read", "the scope is normalised");
    assert_eq!(body["status"], "active");
    assert_eq!(body["enabled"], true);
    assert_eq!(
        body["capabilities"],
        json!(["github.list_repositories", "github.search_issues"])
    );
    assert_eq!(body["egressDomains"], json!(["api.githubcopilot.com"]));
    let (granted_by, audit_id): (Uuid, Uuid) = sqlx::query_as(
        "SELECT granted_by, granted_audit_id FROM plugin_grant \
          WHERE workspace_id = $1 AND member_id = $2 AND plugin_id = $3 AND scope = 'github:read'",
    )
    .bind(ws)
    .bind(alice)
    .bind(GITHUB)
    .fetch_one(&env.su)
    .await
    .expect("grant row");
    assert_eq!(granted_by, alice, "D2: a grant is the member's own consent");
    assert_eq!(body["auditRef"], audit_id.to_string());
    assert_eq!(member_projection_rows(&env.su, ws, alice, GITHUB).await, 2);
    let first_audit = body["auditRef"].clone();

    // Her policy now lists the tools; bob's does not (a grant is not shared).
    let mine = catalog(&env, &t.alice.1, ws).await;
    assert_eq!(
        policy_tools(&mine, GITHUB),
        ["github.list_repositories", "github.search_issues"]
    );
    let bobs = catalog(&env, &t.bob.1, ws).await;
    assert!(policy_tools(&bobs, GITHUB).is_empty());

    // The same grant again is a no-op: 200, the first call's audit row, nothing
    // written, the projection not doubled.
    let granted_audits = audit_count(&env.su, ws, "plugin.grant.created").await;
    let (status, again) = grant(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    assert_eq!(status, 200, "repeat: {again}");
    assert_eq!(again["auditRef"], first_audit);
    assert_eq!(
        audit_count(&env.su, ws, "plugin.grant.created").await,
        granted_audits,
        "a repeat writes no audit row"
    );
    assert_eq!(member_projection_rows(&env.su, ws, alice, GITHUB).await, 2);
    // A projection that has drifted from the manifest (a tool re-tiered since the
    // grant) is rebuilt by the same call — with a record of the refresh.
    sqlx::query(
        "UPDATE plugin_capability_projection SET approval_tier = 'network_write' \
          WHERE workspace_id = $1 AND member_id = $2 AND plugin_id = $3 \
            AND tool_name = 'github.search_issues'",
    )
    .bind(ws)
    .bind(alice)
    .bind(GITHUB)
    .execute(&env.su)
    .await
    .expect("drift the projection");
    let (status, refreshed) = grant(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    assert_eq!(status, 200, "refresh: {refreshed}");
    assert_ne!(refreshed["auditRef"], first_audit, "a refresh is a record");
    assert_eq!(
        audit_count(&env.su, ws, "plugin.grant.created").await,
        granted_audits + 1
    );
    let tiers: Vec<String> = sqlx::query_scalar(
        "SELECT approval_tier FROM plugin_capability_projection \
          WHERE workspace_id = $1 AND member_id = $2 AND plugin_id = $3 ORDER BY tool_name",
    )
    .bind(ws)
    .bind(alice)
    .bind(GITHUB)
    .fetch_all(&env.su)
    .await
    .expect("tiers");
    assert_eq!(
        tiers,
        ["read_only", "read_only"],
        "the manifest's tiers again"
    );

    // Nobody can grant for somebody else: there is no member field to send, and
    // a body that names one is refused whole.
    let bob = t.bob.0.id;
    let named = json!({ "scope": "github:read", "memberId": bob.to_string() }).to_string();
    let (status, body) = call(
        &env,
        Method::POST,
        &t.admin.1,
        &format!("{}/grants", plugin_path(ws, GITHUB)),
        Some(&named),
    )
    .await;
    assert_eq!(status, 400, "admin naming bob: {body}");
    assert_eq!(
        grant_status(&env.su, ws, bob, GITHUB, "github:read").await,
        None
    );
    // What an admin grants is the admin's own.
    let (status, body) = grant(&env, &t.admin.1, ws, GITHUB, "github:read").await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["memberId"], t.admin.0.id.to_string());
    assert_eq!(
        grant_status(&env.su, ws, bob, GITHUB, "github:read").await,
        None
    );

    // An uninstalled app (this workspace's Notion was never installed): 409.
    let (status, _) = grant(&env, &t.alice.1, ws, NOTION, "notion:read").await;
    assert_eq!(status, 409);

    // A guest cannot connect an app: a hosted app (Drive) reads workspace data with
    // the server's own credential, so the grant is the only per-member gate and a
    // guest does not see the whole workspace.
    let carol = seed_human(&env.su, ws, "guest").await;
    let carol_token = login(&env, ws, &carol.email).await;
    let (status, body) = grant(&env, &carol_token, ws, GITHUB, "github:read").await;
    assert_eq!(status, 403, "guest: {body}");
    assert_eq!(body["error"]["message"], "guests cannot connect apps");
    assert_eq!(
        grant_status(&env.su, ws, carol.id, GITHUB, "github:read").await,
        None
    );

    // A former member cannot grant (403 on writes).
    sqlx::query("DELETE FROM workspace_membership WHERE workspace_id = $1 AND member_id = $2")
        .bind(ws)
        .bind(bob)
        .execute(&env.su)
        .await
        .expect("end bob's membership");
    let (status, body) = grant(&env, &t.bob.1, ws, GITHUB, "github:read").await;
    assert_eq!(status, 403, "former member: {body}");
    assert_eq!(body["error"]["message"], "not a workspace member");

    // …but consent can always be withdrawn: alice, demoted to guest after granting,
    // can still take her grant back, and cannot make a new one.
    sqlx::query(
        "UPDATE workspace_membership SET role = 'guest' WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(ws)
    .bind(alice)
    .execute(&env.su)
    .await
    .expect("demote alice to guest");
    let (status, _) = grant(&env, &t.alice.1, ws, GITHUB, "github:write").await;
    assert_eq!(status, 403, "a guest cannot grant");
    let (status, body) = revoke(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    assert_eq!(status, 200, "a guest can revoke: {body}");
    assert_eq!(member_projection_rows(&env.su, ws, alice, GITHUB).await, 0);
}

// ---- 3. revoking a grant -----------------------------------------------------------

#[tokio::test]
#[ignore]
async fn revoking_a_grant_removes_its_projection_and_only_mine() {
    let _guard = test_lock().await;
    let env = env().await;
    let t = team(&env, "plugins-revoke-grant").await;
    let ws = t.workspace;
    let (alice, bob) = (t.alice.0.id, t.bob.0.id);
    install(&env, &t.admin.1, ws, GITHUB, true).await;
    grant(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    grant(&env, &t.bob.1, ws, GITHUB, "github:read").await;
    assert_eq!(projection_rows(&env.su, ws, GITHUB).await, 4);

    // Alice revokes: her grant and her two projection rows go; bob's stay.
    let (status, body) = revoke(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    assert_eq!(status, 200, "revoke: {body}");
    assert_eq!(body["status"], "revoked");
    assert_eq!(body["memberId"], alice.to_string());
    assert_eq!(body["scope"], "github:read");
    assert_eq!(body["capabilities"], json!([]));
    assert_eq!(body["enabled"], true, "the install is still enabled");
    assert!(
        body.get("egressDomains").is_none(),
        "removal carries no egress receipt"
    );
    assert_eq!(member_projection_rows(&env.su, ws, alice, GITHUB).await, 0);
    assert_eq!(member_projection_rows(&env.su, ws, bob, GITHUB).await, 2);
    assert_eq!(
        grant_status(&env.su, ws, alice, GITHUB, "github:read")
            .await
            .as_deref(),
        Some("revoked")
    );
    assert_eq!(
        grant_status(&env.su, ws, bob, GITHUB, "github:read")
            .await
            .as_deref(),
        Some("active")
    );
    let revoked_audit: Uuid = sqlx::query_scalar(
        "SELECT revoked_audit_id FROM plugin_grant \
          WHERE workspace_id = $1 AND member_id = $2 AND plugin_id = $3 AND scope = 'github:read'",
    )
    .bind(ws)
    .bind(alice)
    .bind(GITHUB)
    .fetch_one(&env.su)
    .await
    .expect("revoked_audit_id");
    assert_eq!(body["auditRef"], revoked_audit.to_string());
    assert!(policy_tools(&catalog(&env, &t.alice.1, ws).await, GITHUB).is_empty());
    assert_eq!(
        policy_tools(&catalog(&env, &t.bob.1, ws).await, GITHUB).len(),
        2
    );

    // Repeating it is idempotent: 200, the first revoke's audit id, no new row.
    let audits = audit_count(&env.su, ws, "plugin.grant.revoked").await;
    let (status, again) = revoke(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["auditRef"], body["auditRef"]);
    assert_eq!(
        audit_count(&env.su, ws, "plugin.grant.revoked").await,
        audits
    );

    // A grant I never held is a 404, and revoking cannot touch somebody else's:
    // the admin holds none of github:read, bob's is still active afterwards.
    let (status, body) = revoke(&env, &t.admin.1, ws, GITHUB, "github:read").await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["error"]["message"], "plugin grant not found");
    assert_eq!(
        grant_status(&env.su, ws, bob, GITHUB, "github:read")
            .await
            .as_deref(),
        Some("active")
    );
    assert_eq!(member_projection_rows(&env.su, ws, bob, GITHUB).await, 2);
    let (status, _) = revoke(&env, &t.alice.1, ws, GITHUB, "bad scope").await;
    assert_eq!(status, 400);
    // The incoming-webhook plugin has a grant row of its own lifecycle; a revoke
    // through this route must neither find nor touch it (a bare 404 would also be
    // "no such grant", so the row is seeded and must stay active).
    let audit: Uuid = sqlx::query_scalar(
        "INSERT INTO audit_log (workspace_id, actor_member_id, subject_member_id, action) \
         VALUES ($1, $2, $2, 'plugin.grant.created') RETURNING id",
    )
    .bind(ws)
    .bind(alice)
    .fetch_one(&env.su)
    .await
    .expect("seed audit");
    sqlx::query(
        "INSERT INTO plugin_grant \
           (workspace_id, member_id, plugin_id, scope, status, granted_by, granted_audit_id) \
         VALUES ($1, $2, $3, 'webhook:receive', 'active', $2, $4)",
    )
    .bind(ws)
    .bind(alice)
    .bind(EXTERNAL_WEBHOOK)
    .bind(audit)
    .execute(&env.su)
    .await
    .expect("seed a webhook-plugin grant");
    let (status, _) = revoke(&env, &t.alice.1, ws, EXTERNAL_WEBHOOK, "webhook:receive").await;
    assert_eq!(status, 404, "outside the four");
    assert_eq!(
        grant_status(&env.su, ws, alice, EXTERNAL_WEBHOOK, "webhook:receive")
            .await
            .as_deref(),
        Some("active"),
        "the webhook plugin's grant is not reachable from here"
    );

    // A grant stays revocable after the registry has moved on: consent can
    // always be withdrawn.
    let github = snapshot(&env.su, GITHUB).await;
    sqlx::query("UPDATE plugin_registry SET revoked_at = now() WHERE plugin_id = $1")
        .bind(GITHUB)
        .execute(&env.su)
        .await
        .expect("revoke github in the registry");
    let (status, body) = revoke(&env, &t.bob.1, ws, GITHUB, "github:read").await;
    restore(&env.su, &github).await;
    assert_eq!(
        status, 200,
        "revocable although the registry revoked the app: {body}"
    );
    assert_eq!(member_projection_rows(&env.su, ws, bob, GITHUB).await, 0);

    // Re-granting after a revoke restores the row (200), with a fresh projection.
    let (status, body) = grant(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    assert_eq!(status, 200, "restore: {body}");
    assert_eq!(member_projection_rows(&env.su, ws, alice, GITHUB).await, 2);
    assert_eq!(
        grant_status(&env.su, ws, alice, GITHUB, "github:read")
            .await
            .as_deref(),
        Some("active")
    );
}

// ---- 4. uninstall cascades -----------------------------------------------------------

#[tokio::test]
#[ignore]
async fn uninstall_cascades_to_every_grant_and_projection() {
    let _guard = test_lock().await;
    let env = env().await;
    let t = team(&env, "plugins-uninstall").await;
    let ws = t.workspace;
    let (alice, bob) = (t.alice.0.id, t.bob.0.id);
    install(&env, &t.admin.1, ws, GITHUB, true).await;
    install(&env, &t.admin.1, ws, NOTION, true).await;
    grant(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    grant(&env, &t.bob.1, ws, GITHUB, "github:read").await;
    grant(&env, &t.alice.1, ws, NOTION, "notion:read").await;

    // The incoming-webhook plugin has an install row of its own lifecycle; a
    // generic uninstall must not be able to reach it.
    let audit: Uuid = sqlx::query_scalar(
        "INSERT INTO audit_log (workspace_id, actor_member_id, subject_member_id, action) \
         VALUES ($1, $2, $2, 'plugin.installed') RETURNING id",
    )
    .bind(ws)
    .bind(t.admin.0.id)
    .fetch_one(&env.su)
    .await
    .expect("seed audit");
    sqlx::query(
        "INSERT INTO workspace_plugin_install \
           (workspace_id, plugin_id, enabled, installed_by, installed_audit_id) \
         VALUES ($1, $2, true, $3, $4)",
    )
    .bind(ws)
    .bind(EXTERNAL_WEBHOOK)
    .bind(t.admin.0.id)
    .bind(audit)
    .execute(&env.su)
    .await
    .expect("seed the webhook plugin's install row");
    let (status, body) = uninstall(&env, &t.admin.1, ws, EXTERNAL_WEBHOOK).await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(
        install_state(&env.su, ws, EXTERNAL_WEBHOOK).await,
        Some((true, false))
    );

    // A member cannot; the admin can.
    let (status, _) = uninstall(&env, &t.bob.1, ws, GITHUB).await;
    assert_eq!(status, 403);
    assert_eq!(active_grants(&env.su, ws, GITHUB).await, 2);
    let (status, body) = uninstall(&env, &t.admin.1, ws, GITHUB).await;
    assert_eq!(status, 200, "uninstall: {body}");
    assert_eq!(body["status"], "revoked");
    assert_eq!(body["enabled"], false);
    assert!(body.get("egressDomains").is_none());
    assert_eq!(
        install_state(&env.su, ws, GITHUB).await,
        Some((false, true))
    );

    // Every grant of the app is revoked under the one audit row, every
    // projection row is gone, and nothing of the other app moved.
    assert_eq!(active_grants(&env.su, ws, GITHUB).await, 0);
    assert_eq!(projection_rows(&env.su, ws, GITHUB).await, 0);
    for member in [alice, bob] {
        assert_eq!(
            grant_status(&env.su, ws, member, GITHUB, "github:read")
                .await
                .as_deref(),
            Some("revoked"),
            "{member}: the grant is kept as history, revoked"
        );
        assert_eq!(member_projection_rows(&env.su, ws, member, GITHUB).await, 0);
    }
    let swept: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM plugin_grant \
          WHERE workspace_id = $1 AND plugin_id = $2 AND status = 'revoked' \
            AND revoked_audit_id = $3::uuid",
    )
    .bind(ws)
    .bind(GITHUB)
    .bind(body["auditRef"].as_str().expect("auditRef"))
    .fetch_one(&env.su)
    .await
    .expect("swept grants");
    assert_eq!(
        swept, 2,
        "alice's and bob's grants share the uninstall's audit row"
    );
    assert_eq!(audit_count(&env.su, ws, "plugin.revoked").await, 1);
    assert_eq!(
        active_grants(&env.su, ws, NOTION).await,
        1,
        "another app is untouched"
    );
    assert_eq!(member_projection_rows(&env.su, ws, alice, NOTION).await, 1);
    let after = catalog(&env, &t.alice.1, ws).await;
    assert_eq!(catalog_item(&after, GITHUB)["installed"], false);
    assert!(policy_tools(&after, GITHUB).is_empty());

    // Repeating is idempotent: 200, the first audit id, no second audit row.
    let (status, again) = uninstall(&env, &t.admin.1, ws, GITHUB).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["auditRef"], body["auditRef"]);
    assert_eq!(audit_count(&env.su, ws, "plugin.revoked").await, 1);

    // …and a repeat heals a straggler: an active grant (with its projection) under
    // the revoked install, the kind an unlocked reader of the old server could leave
    // behind, goes under the revoke that ended the install.
    sqlx::query(
        "UPDATE plugin_grant SET status = 'active', revoked_at = NULL, revoked_audit_id = NULL \
          WHERE workspace_id = $1 AND member_id = $2 AND plugin_id = $3",
    )
    .bind(ws)
    .bind(alice)
    .bind(GITHUB)
    .execute(&env.su)
    .await
    .expect("resurrect a grant under the revoked install");
    sqlx::query(
        "INSERT INTO plugin_capability_projection \
           (workspace_id, member_id, plugin_id, scope, tool_name, capability_version, \
            schema_digest, risk, approval_tier, grant_id) \
         SELECT workspace_id, member_id, plugin_id, scope, 'github.list_repositories', '1.0.0', \
                'sha256:' || repeat('1', 64), 'read', 'read_only', id \
           FROM plugin_grant WHERE workspace_id = $1 AND member_id = $2 AND plugin_id = $3",
    )
    .bind(ws)
    .bind(alice)
    .bind(GITHUB)
    .execute(&env.su)
    .await
    .expect("and its projection");
    assert_eq!(
        active_grants(&env.su, ws, GITHUB).await,
        1,
        "the straggler is there"
    );
    let (status, healed) = uninstall(&env, &t.admin.1, ws, GITHUB).await;
    assert_eq!(status, 200, "{healed}");
    assert_eq!(healed["auditRef"], body["auditRef"]);
    assert_eq!(active_grants(&env.su, ws, GITHUB).await, 0, "healed");
    assert_eq!(projection_rows(&env.su, ws, GITHUB).await, 0);
    assert_eq!(
        audit_count(&env.su, ws, "plugin.revoked").await,
        1,
        "no new record"
    );

    // A grant against the uninstalled app is a 409 again, and an install that
    // is back (200: the row existed) does NOT bring consent back with it.
    let (status, _) = grant(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    assert_eq!(status, 409);
    let (status, body) = install(&env, &t.admin.1, ws, GITHUB, true).await;
    assert_eq!(status, 200, "re-install: {body}");
    assert_eq!(
        install_state(&env.su, ws, GITHUB).await,
        Some((true, false))
    );
    assert_eq!(
        active_grants(&env.su, ws, GITHUB).await,
        0,
        "no resurrected grant"
    );
    assert!(policy_tools(&catalog(&env, &t.alice.1, ws).await, GITHUB).is_empty());
    let (status, _) = grant(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    assert_eq!(status, 200, "consent is given anew: the row is restored");
    assert_eq!(
        policy_tools(&catalog(&env, &t.alice.1, ws).await, GITHUB).len(),
        2
    );

    // An app the registry has since revoked can still be removed.
    let linear = snapshot(&env.su, "com.momo.plugins.linear").await;
    install(&env, &t.admin.1, ws, "com.momo.plugins.linear", true).await;
    sqlx::query("UPDATE plugin_registry SET revoked_at = now() WHERE plugin_id = $1")
        .bind("com.momo.plugins.linear")
        .execute(&env.su)
        .await
        .expect("revoke linear in the registry");
    let (status, body) = uninstall(&env, &t.admin.1, ws, "com.momo.plugins.linear").await;
    restore(&env.su, &linear).await;
    assert_eq!(
        status, 200,
        "removable although the registry revoked it: {body}"
    );
    assert_eq!(
        install_state(&env.su, ws, "com.momo.plugins.linear").await,
        Some((false, true))
    );
}

// ---- 5. D5: a disabled install shows no tool, keeps no secret -----------------------

#[tokio::test]
#[ignore]
async fn a_disabled_install_hides_the_tools_but_keeps_the_consent() {
    let _guard = test_lock().await;
    let env = env().await;
    let t = team(&env, "plugins-disable").await;
    let ws = t.workspace;
    let alice = t.alice.0.id;
    install(&env, &t.admin.1, ws, GITHUB, true).await;
    grant(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    assert_eq!(
        policy_tools(&catalog(&env, &t.alice.1, ws).await, GITHUB).len(),
        2
    );

    // Disabling is a pause: the tools leave the policy at once (fail-closed),
    // the member's consent and its projection rows stay.
    let (status, body) = install(&env, &t.admin.1, ws, GITHUB, false).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "disabled");
    let paused = catalog(&env, &t.alice.1, ws).await;
    assert!(
        policy_tools(&paused, GITHUB).is_empty(),
        "no tool while disabled"
    );
    assert_eq!(catalog_item(&paused, GITHUB)["enabled"], false);
    assert_eq!(catalog_item(&paused, GITHUB)["installed"], true);
    assert_eq!(
        grant_status(&env.su, ws, alice, GITHUB, "github:read")
            .await
            .as_deref(),
        Some("active")
    );
    assert_eq!(member_projection_rows(&env.su, ws, alice, GITHUB).await, 2);

    // Enabling again is the same row, the same consent.
    let (status, _) = install(&env, &t.admin.1, ws, GITHUB, true).await;
    assert_eq!(status, 200);
    assert_eq!(
        policy_tools(&catalog(&env, &t.alice.1, ws).await, GITHUB).len(),
        2
    );
}

// ---- 6. RLS --------------------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn another_workspace_never_sees_or_changes_my_rows() {
    let _guard = test_lock().await;
    let env = env().await;
    let a = team(&env, "plugins-rls-a").await;
    let b = team(&env, "plugins-rls-b").await;
    install(&env, &a.admin.1, a.workspace, GITHUB, true).await;
    grant(&env, &a.alice.1, a.workspace, GITHUB, "github:read").await;

    // B's people see none of it, in either workspace's name.
    let bobs = catalog(&env, &b.alice.1, b.workspace).await;
    assert_eq!(catalog_item(&bobs, GITHUB)["installed"], false);
    assert!(policy_tools(&bobs, GITHUB).is_empty());
    let (status, body) = call(
        &env,
        Method::POST,
        &b.admin.1,
        &format!("{}/install", plugin_path(a.workspace, GITHUB)),
        Some(r#"{"enabled":true}"#),
    )
    .await;
    assert_eq!(status, 403, "B's token against A's path: {body}");
    assert_eq!(body["error"]["message"], "workspace scope mismatch");

    // B acting in B: its own state is independent (A's grant is no precondition,
    // and B's uninstall finds no install of its own).
    let (status, _) = grant(&env, &b.alice.1, b.workspace, GITHUB, "github:read").await;
    assert_eq!(status, 409, "A's install does not satisfy B");
    let (status, body) = uninstall(&env, &b.admin.1, b.workspace, GITHUB).await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(
        install_state(&env.su, a.workspace, GITHUB).await,
        Some((true, false))
    );
    assert_eq!(active_grants(&env.su, a.workspace, GITHUB).await, 1);

    // FORCE is on for all three tables: the policy binds the table's owner too, not
    // only the runtime role below.
    let forced: Vec<(String, bool)> = sqlx::query_as(
        "SELECT relname::text, relforcerowsecurity FROM pg_class \
          WHERE relname IN ('workspace_plugin_install', 'plugin_grant', 'plugin_capability_projection') \
          ORDER BY relname",
    )
    .fetch_all(&env.su)
    .await
    .expect("relforcerowsecurity");
    assert_eq!(forced.len(), 3, "{forced:?}");
    assert!(forced.iter().all(|(_, forced)| *forced), "{forced:?}");

    // The database says the same, as the runtime role: with B's GUC, A's rows in
    // all three tenant tables do not exist, and A's GUC shows them (so the zero is
    // not a vacuous one). A write for A under B's GUC is refused outright.
    for table in [
        "workspace_plugin_install",
        "plugin_grant",
        "plugin_capability_projection",
    ] {
        let sql = format!("SELECT count(*) FROM {table} WHERE workspace_id = $1");
        let mut tx = env.app.begin().await.expect("begin as momo_app");
        sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
            .bind(b.workspace.to_string())
            .execute(&mut *tx)
            .await
            .expect("bind B");
        let seen_as_b: i64 = sqlx::query_scalar(&sql)
            .bind(a.workspace)
            .fetch_one(&mut *tx)
            .await
            .expect("count as B");
        sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
            .bind(a.workspace.to_string())
            .execute(&mut *tx)
            .await
            .expect("bind A");
        let seen_as_a: i64 = sqlx::query_scalar(&sql)
            .bind(a.workspace)
            .fetch_one(&mut *tx)
            .await
            .expect("count as A");
        tx.rollback().await.expect("rollback");
        assert_eq!(seen_as_b, 0, "{table}: A's rows leaked to B");
        assert!(seen_as_a > 0, "{table}: the zero above would be vacuous");
    }
    let mut tx = env.app.begin().await.expect("begin as momo_app");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(b.workspace.to_string())
        .execute(&mut *tx)
        .await
        .expect("bind B");
    let forged =
        sqlx::query("INSERT INTO audit_log (workspace_id, action) VALUES ($1, 'plugin.installed')")
            .bind(a.workspace)
            .execute(&mut *tx)
            .await;
    assert!(
        forged.is_err(),
        "RLS WITH CHECK refuses a row for another workspace"
    );
    tx.rollback().await.expect("rollback");
}

// ---- 7. no credential, anywhere -------------------------------------------------------

#[tokio::test]
#[ignore]
async fn no_credential_survives_any_request_or_response() {
    let _guard = test_lock().await;
    let env = env().await;
    let t = team(&env, "plugins-secrets").await;
    let ws = t.workspace;
    let marker = format!("sk-live-{}", Uuid::new_v4().simple());

    // A body that carries a credential-shaped key is refused whole: 400, nothing
    // written, and the marker is in no response and no row.
    let mut responses = Vec::new();
    for (token, method, path, body) in [
        (
            &t.admin.1,
            Method::POST,
            format!("{}/install", plugin_path(ws, GITHUB)),
            json!({ "enabled": true, "accessToken": marker }),
        ),
        (
            &t.admin.1,
            Method::POST,
            format!("{}/install", plugin_path(ws, GITHUB)),
            json!({ "enabled": true, "oauth_token": marker, "refresh_token": marker }),
        ),
    ] {
        let (status, response) = call(&env, method, token, &path, Some(&body.to_string())).await;
        assert_eq!(status, 400, "{path}: {response}");
        responses.push(response);
    }
    assert_eq!(
        install_rows(&env.su, ws, GITHUB).await,
        0,
        "nothing was written"
    );
    install(&env, &t.admin.1, ws, GITHUB, true).await;
    for body in [
        json!({ "scope": "github:read", "accessToken": marker }),
        json!({ "scope": "github:read", "Authorization": format!("Bearer {marker}") }),
        json!({ "scope": "github:read", "client_secret": marker }),
    ] {
        let (status, response) = call(
            &env,
            Method::POST,
            &t.alice.1,
            &format!("{}/grants", plugin_path(ws, GITHUB)),
            Some(&body.to_string()),
        )
        .await;
        assert_eq!(status, 400, "{response}");
        responses.push(response);
    }
    assert_eq!(
        active_grants(&env.su, ws, GITHUB).await,
        0,
        "nothing was granted"
    );

    // The successful writes: every key on the wire is on the allowlist and none
    // is credential-shaped; every audit detail is too.
    let mut wire = Vec::new();
    let (_, installed) = install(&env, &t.admin.1, ws, DRIVE, true).await;
    let (_, granted) = grant(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    let (_, revoked) = revoke(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    let (_, removed) = uninstall(&env, &t.admin.1, ws, DRIVE).await;
    wire.extend([installed, granted, revoked, removed]);
    let mut keys = BTreeSet::new();
    for response in &wire {
        keys_of(response, &mut keys);
    }
    let allowed: BTreeSet<String> = RESPONSE_KEYS.iter().map(|key| key.to_string()).collect();
    assert!(
        keys.is_subset(&allowed),
        "response keys {keys:?} outside the allowlist"
    );
    assert!(keys.iter().all(|key| !is_secret_like_key(key)), "{keys:?}");

    let details: Vec<Value> = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action LIKE 'plugin.%'",
    )
    .bind(ws)
    .fetch_all(&env.su)
    .await
    .expect("audit details");
    assert!(!details.is_empty());
    let allowed_detail: BTreeSet<String> = AUDIT_DETAIL_KEYS
        .iter()
        .map(|key| key.to_string())
        .collect();
    for detail in &details {
        let mut found = BTreeSet::new();
        keys_of(detail, &mut found);
        assert!(
            found.is_subset(&allowed_detail),
            "audit detail keys {found:?}"
        );
        assert!(found.iter().all(|key| !is_secret_like_key(key)));
    }

    // And the marker is nowhere: not in a response, not in any table.
    for response in responses.iter().chain(wire.iter()) {
        assert!(
            !response.to_string().contains(&marker),
            "marker in a response"
        );
    }
    assert_eq!(marker_rows(&env.su, &marker).await, 0, "marker persisted");
    // Control: the scan finds a marker that *is* stored, so zero means absent.
    let control = format!("control-{}", Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO audit_log (workspace_id, action, detail) VALUES ($1, 'plugin.control', $2::jsonb)",
    )
    .bind(ws)
    .bind(json!({ "note": control }).to_string())
    .execute(&env.su)
    .await
    .expect("control row");
    assert_eq!(
        marker_rows(&env.su, &control).await,
        1,
        "the scan is not blind"
    );
}

// ---- 8. wire fixtures -------------------------------------------------------------------

/// The answers, replayed in a fresh workspace, are the bytes in
/// `server/Fixtures/plugin-wire/mutation-*.json` (per-run uuids replaced by the
/// zero placeholder), which `clients/web/src/lib/pluginApi.test.ts` feeds through
/// the deployed `installPlugin` / `grantPluginScope` / … core parsers.
#[tokio::test]
#[ignore]
async fn the_wire_equals_the_mutation_fixtures_the_core_parser_reads() {
    let _guard = test_lock().await;
    let env = env().await;
    let t = team(&env, "plugins-wire-write").await;
    let ws = t.workspace;

    let normalise = |mut body: Value| {
        for key in ["memberId", "auditRef"] {
            if body.get(key).is_some() {
                body[key] = json!(ZERO_UUID);
            }
        }
        body
    };
    let (status, installed) = install(&env, &t.admin.1, ws, GITHUB, true).await;
    assert_eq!(status, 201, "{installed}");
    let (status, granted) = grant(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    assert_eq!(status, 201, "{granted}");
    let (status, revoked) = revoke(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    assert_eq!(status, 200, "{revoked}");
    let (status, removed) = uninstall(&env, &t.admin.1, ws, GITHUB).await;
    assert_eq!(status, 200, "{removed}");

    let dir = repo_root().join("server/Fixtures/plugin-wire");
    let pairs = [
        ("mutation-install.json", normalise(installed)),
        ("mutation-grant.json", normalise(granted)),
        ("mutation-revoke-grant.json", normalise(revoked)),
        ("mutation-uninstall.json", normalise(removed)),
    ];
    if std::env::var("PLUGIN_WIRE_FIXTURES_WRITE").as_deref() == Ok("1") {
        std::fs::create_dir_all(&dir).expect("fixture dir");
        for (name, body) in &pairs {
            let text = serde_json::to_string_pretty(body).expect("pretty") + "\n";
            std::fs::write(dir.join(name), text).expect("write fixture");
        }
    }
    for (name, body) in &pairs {
        let fixture: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(name)).unwrap_or_else(|_| {
                panic!("{name} missing — run with PLUGIN_WIRE_FIXTURES_WRITE=1")
            }),
        )
        .expect("wire fixture json");
        assert_eq!(body, &fixture, "{name} drifted from the server response");
    }
}

// ---- 9. the race -----------------------------------------------------------------------

/// How many requests are waiting on the install key right now: ungranted advisory
/// locks whose 64-bit key is `hashtextextended(key, 0)` (`classid` is its high word,
/// `objid` its low word). Polling this replaces a sleep: the test proceeds only once
/// the request under test is *provably queued on the lock*, so the assertions after
/// it cannot pass merely because the request had not started yet.
async fn waiters_on(su: &PgPool, key: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM pg_locks \
          WHERE locktype = 'advisory' AND NOT granted \
            AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)",
    )
    .bind(key)
    .fetch_one(su)
    .await
    .expect("waiters")
}

async fn wait_for_waiters(su: &PgPool, key: &str, at_least: i64) {
    for _ in 0..200 {
        if waiters_on(su, key).await >= at_least {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("never saw {at_least} request(s) queued on {key}");
}

fn spawn_grant(env: &Env, token: &str, workspace: Uuid) -> tokio::task::JoinHandle<(u16, String)> {
    let http = env.http.clone();
    let base = env.base.clone();
    let token = token.to_string();
    let path = format!("{}/grants", plugin_path(workspace, GITHUB));
    tokio::spawn(async move {
        let response = http
            .post(format!("{base}{path}"))
            .bearer_auth(token)
            .header("content-type", "application/json")
            .body(r#"{"scope":"github:read"}"#)
            .send()
            .await
            .expect("grant request");
        let status = response.status().as_u16();
        (status, response.text().await.unwrap_or_default())
    })
}

fn spawn_uninstall(
    env: &Env,
    token: &str,
    workspace: Uuid,
) -> tokio::task::JoinHandle<(u16, String)> {
    let http = env.http.clone();
    let base = env.base.clone();
    let token = token.to_string();
    let path = format!("{}/install", plugin_path(workspace, GITHUB));
    tokio::spawn(async move {
        let response = http
            .delete(format!("{base}{path}"))
            .bearer_auth(token)
            .send()
            .await
            .expect("uninstall request");
        let status = response.status().as_u16();
        (status, response.text().await.unwrap_or_default())
    })
}

/// An uninstall that is mid-flight holds the install key. A grant that arrives then
/// must queue behind it and see the revoked install (409) — not read the old state,
/// finish after the sweep, and leave an active grant under a revoked install that
/// the next install would bring back without anyone's consent.
#[tokio::test]
#[ignore]
async fn a_grant_waits_for_an_uninstall_in_flight_and_then_refuses() {
    let _guard = test_lock().await;
    let env = env().await;
    let t = team(&env, "plugins-race-grant").await;
    let ws = t.workspace;
    let key = format!("install:{ws}:{GITHUB}");
    install(&env, &t.admin.1, ws, GITHUB, true).await;
    grant(&env, &t.bob.1, ws, GITHUB, "github:read").await;

    // The uninstall, by hand: the exclusive install key, then the install row, as
    // `uninstall` takes them.
    let mut tx = env.su.begin().await.expect("begin the uninstall");
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&key)
        .execute(&mut *tx)
        .await
        .expect("hold the install key");
    sqlx::query(
        "SELECT id FROM workspace_plugin_install \
          WHERE workspace_id = $1 AND plugin_id = $2 FOR UPDATE",
    )
    .bind(ws)
    .bind(GITHUB)
    .fetch_one(&mut *tx)
    .await
    .expect("lock the install row");

    // Alice's grant arrives while the uninstall is open — and queues on the key.
    let racing = spawn_grant(&env, &t.alice.1, ws);
    wait_for_waiters(&env.su, &key, 1).await;
    assert!(!racing.is_finished(), "the grant waits for the uninstall");

    // The uninstall finishes: revoke the install, sweep the grants and the
    // projection, commit.
    let audit: Uuid = sqlx::query_scalar(
        "INSERT INTO audit_log (workspace_id, actor_member_id, subject_member_id, action) \
         VALUES ($1, $2, $2, 'plugin.revoked') RETURNING id",
    )
    .bind(ws)
    .bind(t.admin.0.id)
    .fetch_one(&mut *tx)
    .await
    .expect("uninstall audit");
    sqlx::query(
        "UPDATE workspace_plugin_install \
            SET enabled = false, revoked_at = now(), revoked_by = $3, revoked_audit_id = $4 \
          WHERE workspace_id = $1 AND plugin_id = $2",
    )
    .bind(ws)
    .bind(GITHUB)
    .bind(t.admin.0.id)
    .bind(audit)
    .execute(&mut *tx)
    .await
    .expect("revoke the install");
    sqlx::query(
        "UPDATE plugin_grant SET status = 'revoked', revoked_at = now(), revoked_audit_id = $3 \
          WHERE workspace_id = $1 AND plugin_id = $2 AND status = 'active'",
    )
    .bind(ws)
    .bind(GITHUB)
    .bind(audit)
    .execute(&mut *tx)
    .await
    .expect("sweep grants");
    sqlx::query(
        "DELETE FROM plugin_capability_projection WHERE workspace_id = $1 AND plugin_id = $2",
    )
    .bind(ws)
    .bind(GITHUB)
    .execute(&mut *tx)
    .await
    .expect("sweep projection");
    tx.commit().await.expect("commit the uninstall");

    let (status, body) = racing.await.expect("racing grant task");
    assert_eq!(status, 409, "the grant saw the revoked install: {body}");
    assert_eq!(
        active_grants(&env.su, ws, GITHUB).await,
        0,
        "no grant outlived the uninstall"
    );
    assert_eq!(projection_rows(&env.su, ws, GITHUB).await, 0);
    assert_eq!(
        grant_status(&env.su, ws, t.alice.0.id, GITHUB, "github:read").await,
        None,
        "alice's grant row was never created"
    );
}

/// The other order: a grant that has passed its install check but not committed
/// holds the key shared. The real `uninstall` must wait for it (so its sweep sees
/// the grant), and a grant that arrives *after* the uninstall started waiting must
/// queue behind the uninstall rather than slip past it — otherwise a member looping
/// on grants could keep an admin's uninstall waiting forever.
#[tokio::test]
#[ignore]
async fn an_uninstall_waits_for_a_grant_in_flight_and_then_sweeps_it() {
    let _guard = test_lock().await;
    let env = env().await;
    let t = team(&env, "plugins-race-uninstall").await;
    let ws = t.workspace;
    let alice = t.alice.0.id;
    let key = format!("install:{ws}:{GITHUB}");
    install(&env, &t.admin.1, ws, GITHUB, true).await;

    // A grant in flight, by hand: the shared install key, then its rows (not yet
    // committed).
    let mut tx = env.su.begin().await.expect("begin the grant");
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))")
        .bind(&key)
        .execute(&mut *tx)
        .await
        .expect("hold the install key shared");

    // The real uninstall arrives and queues for the exclusive key.
    let uninstalling = spawn_uninstall(&env, &t.admin.1, ws);
    wait_for_waiters(&env.su, &key, 1).await;
    assert!(
        !uninstalling.is_finished(),
        "the uninstall waits for the grant"
    );

    // A second grant arrives behind the waiting uninstall: it queues too, instead
    // of overtaking it.
    let overtaker = spawn_grant(&env, &t.bob.1, ws);
    wait_for_waiters(&env.su, &key, 2).await;
    assert!(
        !overtaker.is_finished(),
        "a grant that arrives after a waiting uninstall queues behind it"
    );

    // The grant in flight commits its rows.
    let audit: Uuid = sqlx::query_scalar(
        "INSERT INTO audit_log (workspace_id, actor_member_id, subject_member_id, action) \
         VALUES ($1, $2, $2, 'plugin.grant.created') RETURNING id",
    )
    .bind(ws)
    .bind(alice)
    .fetch_one(&mut *tx)
    .await
    .expect("grant audit");
    let grant_id: Uuid = sqlx::query_scalar(
        "INSERT INTO plugin_grant \
           (workspace_id, member_id, plugin_id, scope, status, granted_by, granted_audit_id) \
         VALUES ($1, $2, $3, 'github:read', 'active', $2, $4) RETURNING id",
    )
    .bind(ws)
    .bind(alice)
    .bind(GITHUB)
    .bind(audit)
    .fetch_one(&mut *tx)
    .await
    .expect("grant row");
    sqlx::query(
        "INSERT INTO plugin_capability_projection \
           (workspace_id, member_id, plugin_id, scope, tool_name, capability_version, \
            schema_digest, risk, approval_tier, grant_id) \
         VALUES ($1, $2, $3, 'github:read', 'github.list_repositories', '1.0.0', \
                 'sha256:' || repeat('1', 64), 'read', 'read_only', $4)",
    )
    .bind(ws)
    .bind(alice)
    .bind(GITHUB)
    .bind(grant_id)
    .execute(&mut *tx)
    .await
    .expect("projection row");
    tx.commit().await.expect("commit the grant");

    // The uninstall runs next and sweeps what it was waiting for; the overtaker,
    // queued behind it, finds the install revoked.
    let (status, removed) = uninstalling.await.expect("uninstall task");
    assert_eq!(status, 200, "{removed}");
    let (status, refused) = overtaker.await.expect("overtaker task");
    assert_eq!(
        status, 409,
        "the queued grant saw the revoked install: {refused}"
    );
    assert_eq!(
        grant_status(&env.su, ws, alice, GITHUB, "github:read")
            .await
            .as_deref(),
        Some("revoked"),
        "the in-flight grant was swept, not left active under a revoked install"
    );
    assert_eq!(active_grants(&env.su, ws, GITHUB).await, 0);
    assert_eq!(projection_rows(&env.su, ws, GITHUB).await, 0);
    assert_eq!(
        grant_status(&env.su, ws, t.bob.0.id, GITHUB, "github:read").await,
        None
    );
}

// ---- 10. one audit row per write -----------------------------------------------------------

#[tokio::test]
#[ignore]
async fn every_write_leaves_exactly_one_audit_row() {
    let _guard = test_lock().await;
    let env = env().await;
    let t = team(&env, "plugins-audit").await;
    let ws = t.workspace;
    let (admin, alice) = (t.admin.0.id, t.alice.0.id);

    let (_, installed) = install(&env, &t.admin.1, ws, GITHUB, true).await;
    let (_, granted) = grant(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    let (_, revoked) = revoke(&env, &t.alice.1, ws, GITHUB, "github:read").await;
    let (_, removed) = uninstall(&env, &t.admin.1, ws, GITHUB).await;
    assert_eq!(
        plugin_audit_total(&env.su, ws).await,
        4,
        "one row per write"
    );

    struct Row {
        actor: Option<Uuid>,
        subject: Option<Uuid>,
        target_type: Option<String>,
        target_id: Option<Uuid>,
        via_token: Option<Uuid>,
        detail: Value,
    }
    async fn row(su: &PgPool, audit_ref: &Value) -> Row {
        use momo_db::sqlx::Row as _;
        let id: Uuid = audit_ref.as_str().expect("auditRef").parse().expect("uuid");
        let found = sqlx::query(
            "SELECT actor_member_id, subject_member_id, target_type, target_id, via_token_id, detail \
               FROM audit_log WHERE id = $1",
        )
        .bind(id)
        .fetch_one(su)
        .await
        .expect("audit row by auditRef");
        Row {
            actor: found.try_get("actor_member_id").expect("actor"),
            subject: found.try_get("subject_member_id").expect("subject"),
            target_type: found.try_get("target_type").expect("target_type"),
            target_id: found.try_get("target_id").expect("target_id"),
            via_token: found.try_get("via_token_id").expect("via_token_id"),
            detail: found.try_get("detail").expect("detail"),
        }
    }

    let install_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM workspace_plugin_install WHERE workspace_id = $1 AND plugin_id = $2",
    )
    .bind(ws)
    .bind(GITHUB)
    .fetch_one(&env.su)
    .await
    .expect("install id");
    let grant_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM plugin_grant WHERE workspace_id = $1 AND member_id = $2 AND plugin_id = $3",
    )
    .bind(ws)
    .bind(alice)
    .bind(GITHUB)
    .fetch_one(&env.su)
    .await
    .expect("grant id");

    let a = row(&env.su, &installed["auditRef"]).await;
    assert_eq!((a.actor, a.subject), (Some(admin), Some(admin)));
    assert_eq!(a.target_type.as_deref(), Some("plugin_install"));
    assert_eq!(a.target_id, Some(install_id));
    assert!(
        a.via_token.is_some(),
        "a human bearer's token is the provenance"
    );
    assert_eq!(a.detail["schema"], "momo.plugin.installed.v1");
    assert_eq!(a.detail["plugin_id"], GITHUB);
    assert_eq!(a.detail["enabled"], true);
    assert_eq!(a.detail["egress_domains"], json!(["api.githubcopilot.com"]));
    assert!(a.detail["manifest_digest"]
        .as_str()
        .expect("digest")
        .starts_with("sha256:"));

    let g = row(&env.su, &granted["auditRef"]).await;
    assert_eq!((g.actor, g.subject), (Some(alice), Some(alice)));
    assert_eq!(g.target_type.as_deref(), Some("plugin_grant"));
    assert_eq!(g.target_id, Some(grant_id));
    assert_eq!(g.detail["schema"], "momo.plugin.grant.v1");
    assert_eq!(g.detail["scope"], "github:read");
    assert_eq!(
        g.detail["tools"],
        json!(["github.list_repositories", "github.search_issues"])
    );

    let r = row(&env.su, &revoked["auditRef"]).await;
    assert_eq!(r.actor, Some(alice));
    assert_eq!(r.target_id, Some(grant_id));
    assert_eq!(r.detail["schema"], "momo.plugin.grant.revoked.v1");

    let u = row(&env.su, &removed["auditRef"]).await;
    assert_eq!(u.actor, Some(admin));
    assert_eq!(u.target_type.as_deref(), Some("plugin_install"));
    assert_eq!(u.target_id, Some(install_id));
    assert_eq!(u.detail["schema"], "momo.plugin.revoked.v1");
    let revoked_audit: Uuid =
        sqlx::query_scalar("SELECT revoked_audit_id FROM workspace_plugin_install WHERE id = $1")
            .bind(install_id)
            .fetch_one(&env.su)
            .await
            .expect("revoked_audit_id");
    assert_eq!(removed["auditRef"], revoked_audit.to_string());
}

// ---- 11. agents ------------------------------------------------------------------------------

/// No agent credential reaches these paths. The middleware decides by route shape
/// *before* it touches the database: a path `required_agent_scope` does not name
/// is a 403 for any `momo_agent_v1` bearer, valid or not — so there is nothing an
/// agent could be granted to hold a grant (D2: grants are the delegating user's
/// own). The handlers hold a second `require_human` behind it.
#[tokio::test]
#[ignore]
async fn agent_bearers_cannot_reach_the_writes() {
    let _guard = test_lock().await;
    let env = env().await;
    let t = team(&env, "plugins-agent").await;
    let ws = t.workspace;
    let plugin = plugin_path(ws, GITHUB);
    install(&env, &t.admin.1, ws, GITHUB, true).await;
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let bearer = format!("momo_agent_v1.{ws}.{secret}");
    for (method, path, body) in [
        (
            Method::POST,
            format!("{plugin}/install"),
            Some(r#"{"enabled":true}"#),
        ),
        (Method::DELETE, format!("{plugin}/install"), None),
        (
            Method::POST,
            format!("{plugin}/grants"),
            Some(r#"{"scope":"github:read"}"#),
        ),
        (
            Method::DELETE,
            format!("{plugin}/grants/github%3Aread"),
            None,
        ),
    ] {
        assert_eq!(
            momo_auth::required_agent_scope(method.as_str(), &path),
            None,
            "{method} {path} must stay out of the agent allowlist"
        );
        let (status, reply) = call(&env, method.clone(), &bearer, &path, body).await;
        assert_eq!(status, 403, "{method} {path}: {reply}");
        assert_eq!(
            reply["error"]["message"], "agent bearer is not allowed for this route",
            "{method} {path}: refused for the route, not for a bad credential"
        );
    }
    assert_eq!(active_grants(&env.su, ws, GITHUB).await, 0);
    assert_eq!(
        install_state(&env.su, ws, GITHUB).await,
        Some((true, false))
    );
}

/// D2 is a rule of the domain function, not only of the HTTP shell in front of it:
/// `plugin_writes::grant` itself refuses a member that is not a human. Every agent
/// has an ordinary `workspace_membership` row, so without the kind predicate it
/// would pass the membership gate and `plugin_grant_self_ck` (which only compares
/// `granted_by` to `member_id`) would accept the row. The same call by a human is
/// the control: it is the kind, and only the kind, that decides.
#[tokio::test]
#[ignore]
async fn the_domain_function_refuses_a_member_that_is_not_a_human() {
    let _guard = test_lock().await;
    let env = env().await;
    let t = team(&env, "plugins-agent-grantor").await;
    let ws = t.workspace;
    install(&env, &t.admin.1, ws, GITHUB, true).await;

    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', 'Plugin Probe', $3)",
    )
    .bind(agent)
    .bind(ws)
    .bind(format!("probe-{}", &agent.simple().to_string()[..8]))
    .execute(&env.su)
    .await
    .expect("seed an agent member");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')",
    )
    .bind(ws)
    .bind(agent)
    .execute(&env.su)
    .await
    .expect("agents get an ordinary membership row");

    let try_grant = |member: Uuid| {
        let app = env.app.clone();
        async move {
            momo_db::with_tenant_tx(&app, ws, move |conn| {
                Box::pin(async move {
                    plugin_writes::grant(
                        conn,
                        ws,
                        GITHUB,
                        "github:read",
                        Actor {
                            member_id: member,
                            via_token_id: None,
                        },
                        &Provenance::default(),
                    )
                    .await
                })
            })
            .await
            .expect("the transaction")
        }
    };
    let refused = try_grant(agent).await.expect_err("an agent cannot grant");
    assert_eq!(refused.status, 403);
    assert_eq!(refused.message, "only a human member can grant an app");
    assert_eq!(
        grant_status(&env.su, ws, agent, GITHUB, "github:read").await,
        None
    );
    assert_eq!(projection_rows(&env.su, ws, GITHUB).await, 0);

    let granted = try_grant(t.alice.0.id).await.expect("a human member can");
    assert_eq!(granted.status, "active");
    assert_eq!(granted.capabilities.len(), 2);
}
