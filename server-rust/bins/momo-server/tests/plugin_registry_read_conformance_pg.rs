//! ADR-0113 증보 2026-10-15 (#3838) P-S1 / #3859 — the plugin registry's two
//! reads (`GET …/plugins`, `GET …/plugins/{plugin}`), official four only.
//!
//! Red proofs (ADR-0113 증보 「구현 슬라이스」 P-S1 ①~⑤ + manifest admission):
//!   ① a non-official row, a revoked row, and an official valid row whose id is
//!     not one of the four are each hidden (404) — and each by exactly one guard
//!   ② no credential-shaped key leaves the server: a structural-key allowlist
//!     over every response, and a seeded `access_token` key is refused
//!   ③ another workspace's install / grant rows never reach my catalog or my
//!     policy (RLS), and neither does another member's grant (member-scoped)
//!   ④ a caller who is no longer an active member gets 404, not a catalog (and
//!     403 on the P3 writes — `plugin_registry_write_conformance_pg.rs`)
//!   ⑤ the bytes equal `server/Fixtures/plugin-wire/*.json`, which
//!     `clients/web/src/lib/pluginApi.test.ts` feeds through the deployed core
//!     parser (`pluginCatalogFromWire` / `pluginDetailFromWire`)
//!   + a manifest edited without rotating its digest, or whose `plugin.id` no
//!     longer matches its registry row, is omitted from the catalog and 409 on
//!     detail
//!
//! `plugin_registry` is a **global** table. Tests that tamper with an official
//! row restore it before asserting, and the whole binary holds one lock, so
//! run with `--test-threads=1`.
//!
//! `#[ignore]` — needs a real Postgres (pg18 + pgvector, superuser URL):
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test plugin_registry_read_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Regenerate the wire fixtures (only when the seeded manifests legitimately
//! change): add `PLUGIN_WIRE_FIXTURES_WRITE=1`.

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::plugin_manifest::is_secret_like_key;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "plugin-registry-read-conformance-secret";
const TEST_PASSWORD: &str = "plugin-registry-test-password";

const GITHUB: &str = "com.momo.plugins.github";
const GMAIL: &str = "com.momo.plugins.gmail";
const GCAL: &str = "com.momo.plugins.google-calendar";
const GDRIVE: &str = "com.momo.plugins.google-drive";
const NOTION: &str = "com.momo.plugins.notion";
const LINEAR: &str = "com.momo.plugins.linear";
const DRIVE: &str = "com.momo.plugins.drive";
const EXTRA: &str = "com.momo.plugins.extra-conformance";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
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
    su: PgPool,
    base: String,
    http: reqwest::Client,
}

async fn env() -> Env {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await).await;
    Env {
        su,
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
    let handle = format!("pl-{}", &id.simple().to_string()[..8]);
    let email = format!("{id}@plugins.test");
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

async fn seed_audit(su: &PgPool, workspace: Uuid, actor: Uuid, action: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO audit_log (workspace_id, actor_member_id, subject_member_id, action) \
         VALUES ($1, $2, $2, $3) RETURNING id",
    )
    .bind(workspace)
    .bind(actor)
    .bind(action)
    .fetch_one(su)
    .await
    .expect("seed audit row")
}

/// The Swift `install` write, by hand (the Rust install route is P3).
async fn seed_install(su: &PgPool, workspace: Uuid, by: Uuid, plugin: &str, enabled: bool) {
    let audit = seed_audit(su, workspace, by, "plugin.installed").await;
    sqlx::query(
        "INSERT INTO workspace_plugin_install \
           (workspace_id, plugin_id, enabled, installed_by, installed_audit_id) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(workspace)
    .bind(plugin)
    .bind(enabled)
    .bind(by)
    .bind(audit)
    .execute(su)
    .await
    .expect("seed install");
}

/// The Swift `grant` write, by hand: one active grant plus one projection row
/// per tool that declares the scope.
async fn seed_grant(su: &PgPool, workspace: Uuid, member: Uuid, plugin: &str, scope: &str) {
    let audit = seed_audit(su, workspace, member, "plugin.grant.created").await;
    let grant: Uuid = sqlx::query_scalar(
        "INSERT INTO plugin_grant \
           (workspace_id, member_id, plugin_id, scope, status, granted_by, granted_audit_id) \
         VALUES ($1, $2, $3, $4, 'active', $2, $5) RETURNING id",
    )
    .bind(workspace)
    .bind(member)
    .bind(plugin)
    .bind(scope)
    .bind(audit)
    .fetch_one(su)
    .await
    .expect("seed grant");
    sqlx::query(
        "INSERT INTO plugin_capability_projection \
           (workspace_id, member_id, plugin_id, scope, tool_name, capability_version, \
            schema_digest, risk, approval_tier, grant_id) \
         SELECT $1, $2, pr.plugin_id, $4, tool->>'name', pr.version, tool->>'schemaDigest', \
                tool->>'risk', pr.manifest #>> ARRAY['momo','approvalTier', tool->>'name'], $5 \
           FROM plugin_registry pr \
           CROSS JOIN LATERAL jsonb_array_elements(pr.manifest #> '{mcp,tools}') AS tool \
          WHERE pr.plugin_id = $3 \
            AND tool->'scopes' ? $4",
    )
    .bind(workspace)
    .bind(member)
    .bind(plugin)
    .bind(scope)
    .bind(grant)
    .execute(su)
    .await
    .expect("seed capability projection");
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

async fn get(env: &Env, token: &str, path: &str) -> (u16, Value) {
    let response = env
        .http
        .get(format!("{}{path}", env.base))
        .bearer_auth(token)
        .send()
        .await
        .expect("GET");
    let status = response.status().as_u16();
    let body = response.json().await.unwrap_or(Value::Null);
    (status, body)
}

fn catalog_path(workspace: Uuid) -> String {
    format!("/v1/workspaces/{workspace}/plugins")
}

fn detail_path(workspace: Uuid, plugin: &str) -> String {
    format!("/v1/workspaces/{workspace}/plugins/{plugin}")
}

fn catalog_ids(body: &Value) -> Vec<String> {
    body["plugins"]
        .as_array()
        .expect("plugins array")
        .iter()
        .map(|plugin| plugin["pluginId"].as_str().expect("pluginId").to_string())
        .collect()
}

fn repo_root() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.."))
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
/// so only the validator (not the digest gate) stands between it and the wire.
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

// ---- ⑤ wire fixture ------------------------------------------------------------

/// One deterministic state: github installed + enabled and `github:read`
/// granted to the caller (so `toolPolicy` is non-empty), linear installed but
/// disabled, drive and notion not installed. Drive is deliberately not granted:
/// its hosted descriptor URL would carry this test's ephemeral port.
#[tokio::test]
#[ignore]
async fn the_wire_equals_the_fixture_the_core_parser_reads() {
    let _guard = test_lock().await;
    let env = env().await;
    let workspace = seed_workspace(&env.su, "plugins-wire").await;
    let me = seed_human(&env.su, workspace, "owner").await;
    seed_install(&env.su, workspace, me.id, GITHUB, true).await;
    seed_install(&env.su, workspace, me.id, LINEAR, false).await;
    seed_grant(&env.su, workspace, me.id, GITHUB, "github:read").await;
    let token = login(&env, workspace, &me.email).await;

    let (status, catalog) = get(&env, &token, &catalog_path(workspace)).await;
    assert_eq!(status, 200, "{catalog}");
    assert_eq!(
        catalog_ids(&catalog),
        [DRIVE, GITHUB, GMAIL, GCAL, GDRIVE, LINEAR, NOTION]
    );
    let (status, detail) = get(&env, &token, &detail_path(workspace, GITHUB)).await;
    assert_eq!(status, 200, "{detail}");

    // The seeded registry rows are the manifest fixtures (013/015/031/059).
    for (plugin, file) in [
        (GITHUB, "github"),
        (NOTION, "notion"),
        (LINEAR, "linear"),
        (DRIVE, "drive"),
        (GMAIL, "gmail"),
        (GCAL, "google-calendar"),
        (GDRIVE, "google-drive"),
    ] {
        let (status, body) = get(&env, &token, &detail_path(workspace, plugin)).await;
        assert_eq!(status, 200, "{plugin}: {body}");
        let fixture: Value = serde_json::from_str(
            &std::fs::read_to_string(
                repo_root().join(format!("server/Fixtures/plugin-manifests/{file}.json")),
            )
            .expect("manifest fixture"),
        )
        .expect("manifest fixture json");
        assert_eq!(body["plugin"]["manifest"], fixture, "{plugin} manifest");
    }

    let dir = repo_root().join("server/Fixtures/plugin-wire");
    let pairs = [("catalog.json", &catalog), ("detail-github.json", &detail)];
    if std::env::var("PLUGIN_WIRE_FIXTURES_WRITE").as_deref() == Ok("1") {
        std::fs::create_dir_all(&dir).expect("fixture dir");
        for (name, body) in pairs {
            let text = serde_json::to_string_pretty(body).expect("pretty") + "\n";
            std::fs::write(dir.join(name), text).expect("write fixture");
        }
    }
    for (name, body) in pairs {
        let fixture: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(name)).unwrap_or_else(|_| {
                panic!("{name} missing — run with PLUGIN_WIRE_FIXTURES_WRITE=1")
            }),
        )
        .expect("wire fixture json");
        assert_eq!(body, &fixture, "{name} drifted from the server response");
    }

    // ADR-0113 증보 3 F1 (#4313): every app of the list and of its detail carries the display fields
    // 149 patched in, the developer column is the manifest's own `publisher.name`, and no remote image
    // key exists anywhere on the wire.
    let expected_display: [(&str, &str, &str, bool); 7] = [
        (DRIVE, "google-drive", "files", false),
        (GITHUB, "github", "developer", true),
        (GMAIL, "gmail", "communication", true),
        (GCAL, "google-calendar", "productivity", true),
        (GDRIVE, "google-drive", "files", true),
        (LINEAR, "linear", "project", true),
        (NOTION, "notion", "productivity", true),
    ];
    for (index, (plugin, logo, category, has_website)) in expected_display.iter().enumerate() {
        let item = &catalog["plugins"][index];
        assert_eq!(item["pluginId"], *plugin);
        assert_eq!(item["logoKey"], *logo, "{plugin} logoKey");
        assert_eq!(item["category"], *category, "{plugin} category");
        assert_eq!(
            item["starterPrompts"].as_array().map(Vec::len),
            Some(3),
            "{plugin} starterPrompts"
        );
        assert_eq!(
            item.get("websiteURL").is_some(),
            *has_website,
            "{plugin} websiteURL"
        );
        assert!(
            item["publisherName"]
                .as_str()
                .is_some_and(|name| !name.is_empty()),
            "{plugin} publisherName"
        );
        let (_, detail) = get(&env, &token, &detail_path(workspace, plugin)).await;
        let plugin_manifest = &detail["plugin"]["manifest"]["plugin"];
        assert_eq!(
            detail["plugin"]["publisherName"], plugin_manifest["publisher"]["name"],
            "{plugin}: one developer column, the manifest's"
        );
        for key in ["logoKey", "category", "websiteURL", "starterPrompts"] {
            assert_eq!(
                detail["plugin"].get(key),
                item.get(key),
                "{plugin} {key}: list and detail agree"
            );
        }
        for remote in ["iconURL", "logoURL", "imageURL"] {
            assert!(item.get(remote).is_none() && detail["plugin"].get(remote).is_none());
        }
    }

    // The fixture state is what it claims to be.
    let github = &catalog["plugins"][1];
    assert_eq!(github["installed"], true);
    assert_eq!(github["enabled"], true);
    assert_eq!(catalog["plugins"][5]["installed"], true, "linear installed");
    assert_eq!(catalog["plugins"][5]["enabled"], false, "linear disabled");
    let policy = catalog["toolPolicy"]["plugins"].as_array().expect("policy");
    assert_eq!(policy.len(), 1);
    assert_eq!(policy[0]["pluginId"], GITHUB);
    assert_eq!(policy[0]["tools"].as_array().expect("tools").len(), 26);
}

/// ADR-0113 증보 2 수용 7 (the registry half, #3944): the active official ids the migrations
/// seeded are exactly the ids `plugin.install` may name and the catalogue shows - a seed
/// without an enum entry (or the reverse) fails here.
#[tokio::test]
#[ignore]
async fn the_registry_seed_and_the_install_enum_name_the_same_plugins() {
    let _guard = test_lock().await;
    let env = env().await;
    let seeded: Vec<String> = sqlx::query_scalar(
        "SELECT plugin_id FROM plugin_registry \
          WHERE official AND revoked_at IS NULL AND plugin_id LIKE 'com.momo.plugins.%' AND plugin_id <> $1 ORDER BY plugin_id",
    )
    .bind(EXTRA)
    .fetch_all(&env.su)
    .await
    .expect("registry ids");
    let mut enum_ids: Vec<String> = momo_agent::actions::PLUGIN_INSTALL_PLUGINS
        .iter()
        .map(|(id, _)| id.to_string())
        .collect();
    enum_ids.sort();
    assert_eq!(seeded, enum_ids, "registry seeds vs plugin.install enum");
    let mut allowlist: Vec<String> = momo_server::routes::plugins::OFFICIAL_PLUGIN_IDS
        .iter()
        .map(|id| id.to_string())
        .collect();
    allowlist.sort();
    assert_eq!(seeded, allowlist, "registry seeds vs catalogue allowlist");
}

// ---- ① three guards ------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn non_official_revoked_and_unlisted_rows_are_each_hidden() {
    let _guard = test_lock().await;
    let env = env().await;
    let workspace = seed_workspace(&env.su, "plugins-guards").await;
    let me = seed_human(&env.su, workspace, "member").await;
    let token = login(&env, workspace, &me.email).await;

    let linear = snapshot(&env.su, LINEAR).await;
    let notion = snapshot(&env.su, NOTION).await;
    // An official, valid manifest whose only fault is not being one of the four.
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
    .expect("insert unlisted official row");
    sqlx::query("UPDATE plugin_registry SET official = false WHERE plugin_id = $1")
        .bind(LINEAR)
        .execute(&env.su)
        .await
        .expect("linear → unofficial");
    sqlx::query("UPDATE plugin_registry SET revoked_at = now() WHERE plugin_id = $1")
        .bind(NOTION)
        .execute(&env.su)
        .await
        .expect("notion → revoked");

    let (catalog_status, catalog) = get(&env, &token, &catalog_path(workspace)).await;
    let mut details = Vec::new();
    for plugin in [LINEAR, NOTION, EXTRA] {
        details.push((
            plugin,
            get(&env, &token, &detail_path(workspace, plugin)).await,
        ));
    }

    restore(&env.su, &linear).await;
    restore(&env.su, &notion).await;
    sqlx::query("DELETE FROM plugin_registry WHERE plugin_id = $1")
        .bind(EXTRA)
        .execute(&env.su)
        .await
        .expect("remove unlisted row");

    assert_eq!(catalog_status, 200, "{catalog}");
    assert_eq!(
        catalog_ids(&catalog),
        [DRIVE, GITHUB, GMAIL, GCAL, GDRIVE],
        "unofficial linear, revoked notion and unlisted extra are all hidden"
    );
    for (plugin, (status, body)) in details {
        assert_eq!(status, 404, "{plugin}: {body}");
        assert_eq!(body["error"]["message"], "plugin not found", "{plugin}");
    }
}

// ---- admission: digest + identity + credential key -----------------------------

#[tokio::test]
#[ignore]
async fn a_manifest_that_fails_admission_is_omitted_and_409_on_detail() {
    let _guard = test_lock().await;
    let env = env().await;
    let workspace = seed_workspace(&env.su, "plugins-admission").await;
    let me = seed_human(&env.su, workspace, "member").await;
    let token = login(&env, workspace, &me.email).await;
    let original = snapshot(&env.su, GITHUB).await;
    let github = manifest_value(&env.su, GITHUB).await;

    // (a) edited without rotating the digest.
    sqlx::query(
        "UPDATE plugin_registry \
            SET manifest = jsonb_set(manifest, '{plugin,description}', '\"edited\"') \
          WHERE plugin_id = $1",
    )
    .bind(GITHUB)
    .execute(&env.su)
    .await
    .expect("edit without digest");
    let digest_catalog = get(&env, &token, &catalog_path(workspace)).await;
    let digest_detail = get(&env, &token, &detail_path(workspace, GITHUB)).await;
    restore(&env.su, &original).await;

    // (b) a valid manifest for another id under the github row (digest rotated).
    let mut moved = github.clone();
    moved["plugin"]["id"] = json!("com.momo.plugins.not-github");
    set_manifest_rotating_digest(&env.su, GITHUB, &moved).await;
    let id_catalog = get(&env, &token, &catalog_path(workspace)).await;
    let id_detail = get(&env, &token, &detail_path(workspace, GITHUB)).await;
    restore(&env.su, &original).await;

    // (c) a credential-shaped key (digest rotated). Inside `inputSchema.properties`
    // the names are publisher-chosen, so the fragment denylist is the only
    // guard there — no exact-key rule would catch it.
    let mut secret = github.clone();
    secret["mcp"]["tools"][0]["inputSchema"]["properties"]["access_token"] =
        json!({"type": "string", "description": "ghp_conformance"});
    set_manifest_rotating_digest(&env.su, GITHUB, &secret).await;
    let secret_catalog = get(&env, &token, &catalog_path(workspace)).await;
    let secret_detail = get(&env, &token, &detail_path(workspace, GITHUB)).await;
    restore(&env.su, &original).await;

    // The restore really restored.
    let (status, catalog) = get(&env, &token, &catalog_path(workspace)).await;
    assert_eq!(status, 200);
    assert_eq!(
        catalog_ids(&catalog),
        [DRIVE, GITHUB, GMAIL, GCAL, GDRIVE, LINEAR, NOTION]
    );

    for (label, (catalog_status, catalog), (detail_status, detail), reason) in [
        (
            "digest",
            digest_catalog,
            digest_detail,
            "plugin manifest rejected: manifest digest mismatch",
        ),
        (
            "identity",
            id_catalog,
            id_detail,
            "plugin manifest rejected: registry id does not match manifest",
        ),
        (
            "secret",
            secret_catalog,
            secret_detail,
            "plugin manifest rejected: secret-like manifest field is forbidden at manifest.mcp.tools[0].inputSchema.properties.access_token",
        ),
    ] {
        assert_eq!(catalog_status, 200, "{label}: {catalog}");
        assert_eq!(
            catalog_ids(&catalog),
            [DRIVE, GMAIL, GCAL, GDRIVE, LINEAR, NOTION],
            "{label}: github is omitted, the rest stay"
        );
        assert_eq!(detail_status, 409, "{label}: {detail}");
        assert_eq!(detail["error"]["message"], reason, "{label}");
        assert!(
            !detail.to_string().contains("ghp_conformance"),
            "{label}: the refused value never leaves"
        );
    }
}

// ---- ② no credential-shaped key on the wire ------------------------------------

/// Every key the two responses may carry. `inputSchema.properties` children are
/// tool parameter names chosen by the publisher, so they are checked against
/// the credential-fragment denylist instead.
const STRUCTURAL_KEYS: &[&str] = &[
    // envelopes + catalog item + policy
    "plugins",
    "toolPolicy",
    "plugin",
    "pluginId",
    "name",
    "version",
    "description",
    "termsURL",
    "privacyPolicyURL",
    "iconText",
    // ADR-0113 증보 3 F1 (#4313): the display fields, and the developer column.
    "publisherName",
    "logoKey",
    "category",
    "websiteURL",
    "starterPrompts",
    "text",
    "tool",
    "official",
    "recommended",
    "egressDomains",
    "recommendedFor",
    "installed",
    "enabled",
    "mcp",
    "url",
    "transport",
    "tools",
    "risk",
    "approvalTier",
    "manifest",
    // manifest (ADR-0113 D6 exact key sets)
    "schemaVersion",
    "skill",
    "momo",
    "id",
    "publisher",
    "license",
    "provenance",
    "verified",
    "spdx",
    "kind",
    "sourceURL",
    "releaseRef",
    "protocolVersion",
    "server",
    "inputSchema",
    "schemaDigest",
    "scopes",
    "approvalPolicy",
    "reference",
    "optional",
    "hosted",
    "serverPolicy",
    "installAllowed",
    "enabledByDefault",
    "allowedRoles",
    // closed JSON-schema vocabulary
    "type",
    "properties",
    "required",
    "additionalProperties",
    "enum",
    "items",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
];

fn collect_keys(value: &Value, parent: Option<&str>, found: &mut Vec<(String, bool)>) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                // Under `properties` a key is a parameter name; under
                // `approvalTier` it is a tool name. Neither is structure.
                let free = matches!(parent, Some("properties") | Some("approvalTier"));
                found.push((key.clone(), free));
                collect_keys(child, Some(key), found);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_keys(child, parent, found);
            }
        }
        _ => {}
    }
}

#[tokio::test]
#[ignore]
async fn no_credential_shaped_key_leaves_the_server() {
    let _guard = test_lock().await;
    let env = env().await;
    let workspace = seed_workspace(&env.su, "plugins-keys").await;
    let me = seed_human(&env.su, workspace, "owner").await;
    seed_install(&env.su, workspace, me.id, GITHUB, true).await;
    seed_grant(&env.su, workspace, me.id, GITHUB, "github:read").await;
    let token = login(&env, workspace, &me.email).await;

    let mut bodies = vec![get(&env, &token, &catalog_path(workspace)).await];
    for plugin in [GITHUB, NOTION, LINEAR, DRIVE] {
        bodies.push(get(&env, &token, &detail_path(workspace, plugin)).await);
    }
    let allowed: BTreeSet<&str> = STRUCTURAL_KEYS.iter().copied().collect();
    for (status, body) in bodies {
        assert_eq!(status, 200, "{body}");
        let mut keys = Vec::new();
        collect_keys(&body, None, &mut keys);
        assert!(!keys.is_empty());
        for (key, free) in keys {
            assert!(!is_secret_like_key(&key), "credential-shaped key {key:?}");
            if !free {
                assert!(
                    allowed.contains(key.as_str()),
                    "unexpected key {key:?} on the wire"
                );
            }
        }
    }
}

// ---- ③ tenant + member isolation -----------------------------------------------

#[tokio::test]
#[ignore]
async fn another_workspace_and_another_member_never_reach_my_policy() {
    let _guard = test_lock().await;
    let env = env().await;
    let mine = seed_workspace(&env.su, "plugins-mine").await;
    let theirs = seed_workspace(&env.su, "plugins-theirs").await;
    let me = seed_human(&env.su, mine, "owner").await;
    let colleague = seed_human(&env.su, mine, "member").await;
    let stranger = seed_human(&env.su, theirs, "owner").await;

    // Their workspace: every plugin installed and enabled, everything granted.
    for plugin in [GITHUB, NOTION, LINEAR] {
        seed_install(&env.su, theirs, stranger.id, plugin, true).await;
    }
    seed_grant(&env.su, theirs, stranger.id, GITHUB, "github:read").await;
    seed_grant(&env.su, theirs, stranger.id, NOTION, "notion:read").await;
    // My workspace: notion installed; my colleague (not me) granted it.
    seed_install(&env.su, mine, me.id, NOTION, true).await;
    seed_grant(&env.su, mine, colleague.id, NOTION, "notion:read").await;

    let my_token = login(&env, mine, &me.email).await;
    let (status, catalog) = get(&env, &my_token, &catalog_path(mine)).await;
    assert_eq!(status, 200, "{catalog}");
    let installed: Vec<&str> = catalog["plugins"]
        .as_array()
        .expect("plugins")
        .iter()
        .filter(|plugin| plugin["installed"] == true)
        .map(|plugin| plugin["pluginId"].as_str().expect("id"))
        .collect();
    assert_eq!(installed, [NOTION], "their installs never mark mine");
    assert_eq!(
        catalog["toolPolicy"]["plugins"],
        json!([]),
        "neither their grants nor my colleague's are my policy"
    );
    let (_, github) = get(&env, &my_token, &detail_path(mine, GITHUB)).await;
    assert_eq!(github["plugin"]["installed"], false);

    // The colleague does see their own grant; the stranger sees theirs.
    let colleague_token = login(&env, mine, &colleague.email).await;
    let (_, colleague_catalog) = get(&env, &colleague_token, &catalog_path(mine)).await;
    let colleague_policy: Vec<&str> = colleague_catalog["toolPolicy"]["plugins"]
        .as_array()
        .expect("policy")
        .iter()
        .map(|plugin| plugin["pluginId"].as_str().expect("id"))
        .collect();
    assert_eq!(colleague_policy, [NOTION]);
    let stranger_token = login(&env, theirs, &stranger.email).await;
    let (_, stranger_catalog) = get(&env, &stranger_token, &catalog_path(theirs)).await;
    assert_eq!(
        stranger_catalog["toolPolicy"]["plugins"]
            .as_array()
            .expect("policy")
            .len(),
        2
    );

    // My token cannot address their workspace at all.
    let (status, _) = get(&env, &my_token, &catalog_path(theirs)).await;
    assert_eq!(status, 403, "workspace scope mismatch (shared rule)");
}

/// Review of #3861: the policy join's lifecycle predicates (`pg.status =
/// 'active' AND pg.revoked_at IS NULL`, `wpi.enabled`, `wpi.revoked_at IS
/// NULL`) and the catalog's `installed` revocation check had no test — each
/// could be deleted with the suite still green. A revoked grant, a disabled
/// install and a revoked install must each keep the caller's policy empty for
/// that plugin (ADR-0113 D5 fail-closed), while one live grant stays visible
/// as the positive control.
#[tokio::test]
#[ignore]
async fn a_revoked_grant_or_a_disabled_or_revoked_install_never_reaches_my_policy() {
    let _guard = test_lock().await;
    let env = env().await;
    let workspace = seed_workspace(&env.su, "plugins-lifecycle").await;
    let me = seed_human(&env.su, workspace, "owner").await;

    // Positive control: installed, enabled, granted → in my policy.
    seed_install(&env.su, workspace, me.id, GITHUB, true).await;
    seed_grant(&env.su, workspace, me.id, GITHUB, "github:read").await;

    // Revoked grant on an installed, enabled plugin.
    seed_install(&env.su, workspace, me.id, NOTION, true).await;
    seed_grant(&env.su, workspace, me.id, NOTION, "notion:read").await;
    let grant_revoke_audit = seed_audit(&env.su, workspace, me.id, "plugin.grant.revoked").await;
    sqlx::query(
        "UPDATE plugin_grant \
            SET status = 'revoked', revoked_at = now(), revoked_audit_id = $3 \
          WHERE workspace_id = $1 AND plugin_id = $2",
    )
    .bind(workspace)
    .bind(NOTION)
    .bind(grant_revoke_audit)
    .execute(&env.su)
    .await
    .expect("revoke notion grant");

    // Active grant on an install that is present but disabled.
    seed_install(&env.su, workspace, me.id, LINEAR, false).await;
    seed_grant(&env.su, workspace, me.id, LINEAR, "linear:read").await;

    // Active grant on an install that is revoked but still flagged enabled, so
    // only `wpi.revoked_at IS NULL` stands between it and my policy.
    seed_install(&env.su, workspace, me.id, DRIVE, true).await;
    seed_grant(&env.su, workspace, me.id, DRIVE, "drive:read").await;
    let install_revoke_audit = seed_audit(&env.su, workspace, me.id, "plugin.revoked").await;
    sqlx::query(
        "UPDATE workspace_plugin_install \
            SET revoked_at = now(), revoked_by = $3, revoked_audit_id = $4 \
          WHERE workspace_id = $1 AND plugin_id = $2",
    )
    .bind(workspace)
    .bind(DRIVE)
    .bind(me.id)
    .bind(install_revoke_audit)
    .execute(&env.su)
    .await
    .expect("revoke drive install");

    let token = login(&env, workspace, &me.email).await;
    let (status, catalog) = get(&env, &token, &catalog_path(workspace)).await;
    assert_eq!(status, 200, "{catalog}");
    let policy: Vec<&str> = catalog["toolPolicy"]["plugins"]
        .as_array()
        .expect("policy")
        .iter()
        .map(|plugin| plugin["pluginId"].as_str().expect("id"))
        .collect();
    assert_eq!(
        policy,
        [GITHUB],
        "only the live grant on a live install is my policy: {catalog}"
    );

    let flag = |plugin: &str, key: &str| -> Value {
        catalog["plugins"]
            .as_array()
            .expect("plugins")
            .iter()
            .find(|row| row["pluginId"] == plugin)
            .unwrap_or_else(|| panic!("{plugin} listed"))[key]
            .clone()
    };
    assert_eq!(
        flag(DRIVE, "installed"),
        false,
        "a revoked install is not installed"
    );
    assert_eq!(flag(DRIVE, "enabled"), false);
    assert_eq!(flag(LINEAR, "installed"), true);
    assert_eq!(flag(LINEAR, "enabled"), false);
    let (_, drive) = get(&env, &token, &detail_path(workspace, DRIVE)).await;
    assert_eq!(
        drive["plugin"]["installed"], false,
        "detail agrees: {drive}"
    );
}

// ---- ④ membership -----------------------------------------------------------------

#[tokio::test]
#[ignore]
async fn a_former_member_gets_404_on_reads_and_403_on_writes() {
    let _guard = test_lock().await;
    let env = env().await;
    let workspace = seed_workspace(&env.su, "plugins-member").await;
    let me = seed_human(&env.su, workspace, "member").await;
    let token = login(&env, workspace, &me.email).await;

    let (status, _) = get(&env, &token, &catalog_path(workspace)).await;
    assert_eq!(status, 200, "an active member reads the catalog");

    // P3 (#3914) mounted the four writes. A plain member is refused each of
    // them for its own reason — never a 404 from a route that is not there.
    let writes = [
        (
            reqwest::Method::POST,
            format!("{}/install", detail_path(workspace, GITHUB)),
            json!({"enabled": true}),
            403,
        ),
        (
            reqwest::Method::DELETE,
            format!("{}/install", detail_path(workspace, GITHUB)),
            json!({}),
            403,
        ),
        (
            reqwest::Method::POST,
            format!("{}/grants", detail_path(workspace, GITHUB)),
            json!({"scope": "github:read"}),
            409,
        ),
        (
            reqwest::Method::DELETE,
            format!("{}/grants/github:read", detail_path(workspace, GITHUB)),
            json!({}),
            404,
        ),
    ];
    for (method, path, body, expected) in writes {
        let response = env
            .http
            .request(method.clone(), format!("{}{path}", env.base))
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .expect("write route");
        let status = response.status().as_u16();
        let reply: Value = response.json().await.unwrap_or(Value::Null);
        assert_eq!(status, expected, "{method} {path}: {reply}");
        if expected == 404 {
            assert_eq!(
                reply["error"]["message"], "plugin grant not found",
                "{method} {path}: the 404 is a missing grant, not a missing route"
            );
        }
    }
    let (status, _) = get(&env, &token, &detail_path(workspace, "Bad Id!")).await;
    assert_eq!(status, 400, "an id outside the registry grammar");

    // The token outlives the membership; the catalog does not.
    sqlx::query("DELETE FROM workspace_membership WHERE workspace_id = $1 AND member_id = $2")
        .bind(workspace)
        .bind(me.id)
        .execute(&env.su)
        .await
        .expect("end membership");
    for path in [catalog_path(workspace), detail_path(workspace, GITHUB)] {
        let (status, body) = get(&env, &token, &path).await;
        assert_eq!(status, 404, "{path}: {body}");
        assert_eq!(body["error"]["message"], "plugin not found");
    }
}

// ---- ADR-0113 증보 3 F1 (#4313): migration 149 on a real registry ---------------------------------

const OFFICIAL_SEVEN: [&str; 7] = [DRIVE, GITHUB, GMAIL, GCAL, GDRIVE, LINEAR, NOTION];
const DISPLAY_KEYS: [&str; 4] = ["logoKey", "category", "websiteURL", "starterPrompts"];
/// What an older server's validator admits in `plugin` (before F1): anything else is refused there.
const LEGACY_PLUGIN_KEYS: [&str; 10] = [
    "id",
    "name",
    "version",
    "description",
    "publisher",
    "license",
    "provenance",
    "termsURL",
    "privacyPolicyURL",
    "iconText",
];

fn migration_149_sql() -> String {
    std::fs::read_to_string(
        repo_root().join("server/Migrations/149_official_catalog_display_fields.sql"),
    )
    .expect("migration 149")
}

/// The commented-out rollback statement at the bottom of the migration, as SQL (the text a person copies
/// into the PR description and runs on the day the server image rolls back).
fn migration_149_rollback_sql() -> String {
    let text = migration_149_sql();
    let mut lines = text
        .lines()
        .skip_while(|line| !line.starts_with("-- ROLLBACK"));
    lines.next().expect("the ROLLBACK header");
    let statement: Vec<String> = lines
        .take_while(|line| !line.starts_with("-- ----"))
        .filter_map(|line| line.strip_prefix("--   ").map(str::to_string))
        .collect();
    assert!(
        statement
            .first()
            .is_some_and(|line| line.starts_with("UPDATE plugin_registry")),
        "the rollback block must be the UPDATE: {statement:?}"
    );
    statement.join("\n")
}

async fn registry_state(su: &PgPool) -> Vec<(String, String, String, String)> {
    sqlx::query_as(
        "SELECT plugin_id, manifest::text, manifest_digest, updated_at::text \
           FROM plugin_registry WHERE plugin_id = ANY($1) ORDER BY plugin_id",
    )
    .bind(OFFICIAL_SEVEN.map(String::from).to_vec())
    .fetch_all(su)
    .await
    .expect("registry state")
}

async fn digests_match_their_manifests(su: &PgPool) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT plugin_id FROM plugin_registry WHERE plugin_id = ANY($1) \
            AND manifest_digest <> 'sha256:' || encode(sha256(convert_to(manifest::text, 'UTF8')), 'hex')",
    )
    .bind(OFFICIAL_SEVEN.map(String::from).to_vec())
    .fetch_all(su)
    .await
    .expect("digest check")
}

/// ADR-0113 증보 3 수용 3: the seed migration rewrote `manifest` **and** `manifest_digest` together — on the
/// real registry, for all seven apps — and running it again changes nothing (not even `updated_at`: the
/// UPDATE fires only where the patched manifest differs).
#[tokio::test]
#[ignore]
async fn migration_149_patched_all_seven_with_matching_digests_and_is_idempotent() {
    let _guard = test_lock().await;
    let env = env().await;

    let before = registry_state(&env.su).await;
    assert_eq!(before.len(), 7);
    for (plugin, manifest, _digest, _updated) in &before {
        let manifest: Value = serde_json::from_str(manifest).expect("manifest json");
        for key in ["logoKey", "category", "starterPrompts"] {
            assert!(
                manifest["plugin"].get(key).is_some(),
                "{plugin}: {key} is patched in"
            );
        }
    }
    assert!(
        digests_match_their_manifests(&env.su).await.is_empty(),
        "every digest equals sha256 of its manifest text (a stale digest drops the app from the catalogue)"
    );

    // Again: the same statements, no row written.
    sqlx::raw_sql(&migration_149_sql())
        .execute(&env.su)
        .await
        .expect("re-run migration 149");
    assert_eq!(
        registry_state(&env.su).await,
        before,
        "a second run changes no manifest, digest or updated_at"
    );
}

/// The rollback SQL in the migration's last comment block (the one the PR description carries) actually runs,
/// restores what an older server admits — the four display keys gone, every other byte of the manifest
/// untouched, the digest re-derived — and re-applying 149 afterwards brings back exactly the 149 state.
/// Always re-applied, so a failing assertion cannot leave the shared registry rolled back for other tests.
#[tokio::test]
#[ignore]
async fn the_rollback_sql_restores_the_legacy_manifests_and_a_reapply_restores_149() {
    let _guard = test_lock().await;
    let env = env().await;
    let after_149 = registry_state(&env.su).await;
    let mut problems: Vec<String> = Vec::new();

    sqlx::query(&migration_149_rollback_sql())
        .execute(&env.su)
        .await
        .expect("the documented rollback SQL runs");
    let rolled_back = registry_state(&env.su).await;
    for ((plugin, patched, _, _), (_, legacy, _, _)) in after_149.iter().zip(&rolled_back) {
        let patched: Value = serde_json::from_str(patched).expect("patched json");
        let legacy: Value = serde_json::from_str(legacy).expect("legacy json");
        let keys: Vec<&String> = legacy["plugin"]
            .as_object()
            .expect("plugin")
            .keys()
            .collect();
        for key in &keys {
            if !LEGACY_PLUGIN_KEYS.contains(&key.as_str()) {
                problems.push(format!("{plugin}: {key} survived the rollback"));
            }
        }
        // Nothing but the four keys moved.
        let mut expected = patched.clone();
        for key in DISPLAY_KEYS {
            expected["plugin"]
                .as_object_mut()
                .expect("plugin")
                .remove(key);
        }
        if legacy != expected {
            problems.push(format!(
                "{plugin}: the rollback changed more than the four keys"
            ));
        }
    }
    let stale = digests_match_their_manifests(&env.su).await;
    if !stale.is_empty() {
        problems.push(format!("digests not re-derived by the rollback: {stale:?}"));
    }

    sqlx::raw_sql(&migration_149_sql())
        .execute(&env.su)
        .await
        .expect("re-apply migration 149");
    let reapplied = registry_state(&env.su).await;
    for ((plugin, manifest, digest, _), (_, manifest_after, digest_after, _)) in
        after_149.iter().zip(&reapplied)
    {
        if manifest != manifest_after || digest != digest_after {
            problems.push(format!(
                "{plugin}: re-applying 149 did not restore the 149 manifest and digest"
            ));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}
