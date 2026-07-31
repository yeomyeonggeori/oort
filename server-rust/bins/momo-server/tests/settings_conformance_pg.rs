//! **The 설정 화면's own sequence, replayed against the real server** (B4.2).
//!
//! Same discipline as `client_rewire_smoke_pg.rs`: organised by *client*, not by
//! server surface. `clients/web/src/features/settings/SettingsRoute.tsx` opens a
//! fixed set of panels, each panel issues a fixed read, and an operator who
//! changes something issues the matching write — so this test issues those calls,
//! in that order, with those bodies.
//!
//! | # | panel | call | client |
//! |---|---|---|---|
//! | 1 | (login) | `POST /v1/auth/login` | `lib/api.ts:548` |
//! | 2 | 워크스페이스 | `GET /v1/workspaces/{ws}` | `settings/api.ts:399` |
//! | 3 | AI 연결 | `GET·PUT·DELETE /v1/provider/link` | `settings/api.ts:132-147` |
//! | 4 | AI 연결 (체인) | `GET·PUT·DELETE /v1/provider/link/chain` | `settings/api.ts:238-255` |
//! | 5 | AI 연결 (확인) | `POST /v1/provider/link/test` | `settings/api.ts:149` |
//! | 6 | 코드 실행 호스트 | `GET·PUT /v1/provider/work-host-engine` | `settings/api.ts:268-277` |
//! | 7 | 추론 강도 | `GET /v1/provider/effort-table` | `lib/api.ts:1953` |
//! | 8 | 구독 잔여량 | `GET /v1/provider/quota-snapshots` | `settings/api.ts:504` |
//! | 9 | 티어 정책 | `GET·PUT …/work-tier-policy[/me]` | `settings/api.ts:312-336` |
//! | 10 | 초대 | `GET·POST …/invites` | `settings/api.ts:442,449` |
//! | 11 | 워크스페이스 생성 | `POST /v1/workspaces` | `settings/api.ts:389` |
//!
//! Three properties are asserted that no single call could show on its own:
//!
//! * **The bearer round-trips without ever coming back.** The PUT that stores it
//!   and the GET that follows are joined directly: the response may carry the
//!   4-character tail and must carry nothing else of the secret, and the stored
//!   `bytea` must not contain the plaintext either.
//! * **A settings write is a settings write, not a broadcast.** No route in this
//!   batch may add an `outbox` row; the test counts before and after.
//! * **RLS is what stops a foreign tenant, not a `WHERE` clause.** The second
//!   test runs the same domain queries under another tenant's GUC and requires
//!   zero rows, then re-runs them under the owning tenant's GUC and requires the
//!   rows to appear — so a green result cannot come from a broken query.
//!
//! `#[ignore]` because it needs a real Postgres. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test settings_conformance_pg -- --ignored --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_server::config::SettingsConfig;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (same contract as http_smoke_pg.rs / client_rewire_smoke_pg.rs)
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "settings-conformance-app-signing-secret";
/// Deliberately different from the app secret, for the same reason B4 split the
/// Centrifugo key: a provider-bearer leak must not become a token-signing leak.
const TEST_PROVIDER_MASTER_KEY: &str = "settings-conformance-provider-master-key";
const TEST_PASSWORD: &str = "settings-conformance-password";
/// The bearer the operator types. Long enough that `masked_tail` returns a tail,
/// which is the field the panel actually renders.
const TEST_BEARER: &str = "sk-live-conformance-9f2c4a";
const TEST_CHAIN_BEARER: &str = "sk-live-fallback-1b7d3e";

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

/// Boot the router with the settings surface CONFIGURED — the deployed shape.
/// `platform_admin_emails` carries the fixture operator, which is the
/// listed-instance-operator path MOMO-583 defines; the fixture never mints a
/// `platform:read` token, so this is the path under test.
async fn start_server(pool: PgPool, operator_email: &str) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_settings(SettingsConfig {
        provider_link_master_key: Some(TEST_PROVIDER_MASTER_KEY.to_string()),
        env_provider: momo_settings::ProviderConfig::default(),
        platform_admin_emails: vec![operator_email.to_ascii_lowercase()],
        environment: "local".to_string(),
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
}

/// One workspace with one **verified-email owner**. Both halves matter: the
/// settings surfaces are owner/admin gated, and the instance-global ones
/// additionally require `human.email_verified = true` before the allow-list is
/// even consulted.
async fn seed(su: &PgPool, slug_hint: &str) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{slug_hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");

    let member = Uuid::new_v4();
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
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed workspace_membership");

    let email = format!("{member}@settings.test");
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

    Fixture {
        workspace,
        member,
        email,
    }
}

async fn login(http: &reqwest::Client, base: &str, fixture: &Fixture) -> String {
    let body: Value = http
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
    body["accessToken"]
        .as_str()
        .expect("login returns an access token")
        .to_string()
}

async fn outbox_rows(su: &PgPool) -> i64 {
    sqlx::query("SELECT count(*)::bigint FROM outbox")
        .fetch_one(su)
        .await
        .expect("count outbox")
        .get::<i64, _>(0)
}

async fn audit_rows(su: &PgPool, workspace: Uuid, action: &str) -> i64 {
    sqlx::query("SELECT count(*)::bigint FROM audit_log WHERE workspace_id = $1 AND action = $2")
        .bind(workspace)
        .bind(action)
        .fetch_one(su)
        .await
        .expect("count audit")
        .get::<i64, _>(0)
}

// ---------------------------------------------------------------------------
// 1. the settings sequence
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_settings_panels_read_and_write_round_trip() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "settings").await;
    let base = start_server(app_pool, &fixture.email).await;
    let http = reqwest::Client::new();

    // The provider link is instance-global, so a previous run's row would be
    // visible here. Clear it so the "not configured yet" assertions mean what
    // they say.
    sqlx::query("DELETE FROM provider_link")
        .execute(&su)
        .await
        .expect("clear provider_link");
    sqlx::query("DELETE FROM provider_link_chain")
        .execute(&su)
        .await
        .expect("clear provider_link_chain");

    let outbox_before = outbox_rows(&su).await;

    // -- 1. login ----------------------------------------------------------
    let token = login(&http, &base, &fixture).await;
    let auth = |request: reqwest::RequestBuilder| request.bearer_auth(&token);

    // -- 2. 워크스페이스: the panel's first read (B4.1, re-asserted here because
    //       this is the sequence the settings screen actually walks) ---------
    let workspace: Value = auth(http.get(format!("{base}/v1/workspaces/{}", fixture.workspace)))
        .send()
        .await
        .expect("workspace read")
        .json()
        .await
        .expect("workspace body");
    assert!(workspace.get("workspace").is_some(), "{workspace}");

    // -- 3. AI 연결: env fallback → store → read back → delete ---------------
    let before: Value = auth(http.get(format!("{base}/v1/provider/link")))
        .send()
        .await
        .expect("provider link read")
        .json()
        .await
        .expect("provider link body");
    assert_eq!(
        before["source"], "environment",
        "with no row stored the env trio is what is in force: {before}"
    );
    assert_eq!(before["configured"], json!(false));
    assert!(
        before.get("bearerLast4").is_none(),
        "the env tier never exposes a tail: {before}"
    );

    let stored: Value = auth(http.put(format!("{base}/v1/provider/link")))
        .json(&json!({
            "baseUrl": "https://api.example.com/v1",
            "bearer": TEST_BEARER,
            "mode": "external-hermes",
        }))
        .send()
        .await
        .expect("provider link write")
        .json()
        .await
        .expect("provider link write body");
    assert_eq!(stored["source"], "database", "{stored}");
    assert_eq!(stored["configured"], json!(true));
    assert_eq!(stored["bearerConfigured"], json!(true));
    assert_eq!(
        stored["bearerLast4"], "2c4a",
        "the tail is the last FOUR characters and nothing more: {stored}"
    );
    assert_eq!(stored["endpointLabel"], "https://api.example.com/v1");

    // The whole response, serialized, must not contain the secret anywhere —
    // not in a field this test forgot to name, and not inside `diagnostics`.
    let rendered = stored.to_string();
    assert!(
        !rendered.contains(TEST_BEARER),
        "the bearer must never be echoed: {rendered}"
    );

    // …and neither must the stored ciphertext, which is the half a `bytea`
    // column would silently get wrong if the seal were skipped.
    let ciphertext: Vec<u8> =
        sqlx::query("SELECT bearer_ciphertext FROM provider_link WHERE id = true")
            .fetch_one(&su)
            .await
            .expect("stored row")
            .get(0);
    assert!(
        !String::from_utf8_lossy(&ciphertext).contains(TEST_BEARER),
        "the stored column must be sealed, not the plaintext"
    );
    assert_eq!(ciphertext[0], 0x01, "the sealed-box version byte leads");

    let read_back: Value = auth(http.get(format!("{base}/v1/provider/link")))
        .send()
        .await
        .expect("provider link re-read")
        .json()
        .await
        .expect("provider link re-read body");
    assert_eq!(read_back["baseUrl"], "https://api.example.com/v1");
    assert_eq!(read_back["bearerLast4"], stored["bearerLast4"]);
    assert_eq!(
        read_back["updatedBy"],
        fixture.member.to_string(),
        "the last editor is attributable"
    );

    // -- 4. AI 연결 (체인) ---------------------------------------------------
    let chain: Value = auth(http.get(format!("{base}/v1/provider/link/chain")))
        .send()
        .await
        .expect("chain read")
        .json()
        .await
        .expect("chain body");
    assert_eq!(chain["entries"][0]["position"], json!(0));
    assert_eq!(
        chain["entries"][0]["source"], "provider_link",
        "position 0 is the singleton this test just stored: {chain}"
    );
    assert_eq!(chain["fallbackCount"], json!(0));
    assert_eq!(
        chain["attemptableCount"],
        json!(1),
        "attemptable counts the head: {chain}"
    );

    // Position 0 is the singleton's alone — the chain PUT must refuse it.
    let rejected = auth(http.put(format!("{base}/v1/provider/link/chain")))
        .json(&json!({"entries": [{
            "position": 0,
            "baseUrl": "https://takeover.example.com/v1",
            "bearer": TEST_CHAIN_BEARER,
        }]}))
        .send()
        .await
        .expect("chain position 0");
    assert_eq!(rejected.status().as_u16(), 400);

    let saved: Value = auth(http.put(format!("{base}/v1/provider/link/chain")))
        .json(&json!({"entries": [{
            "position": 1,
            "baseUrl": "https://fallback.example.com/v1",
            "bearer": TEST_CHAIN_BEARER,
            "mode": "external-hermes",
            "enabled": true,
        }]}))
        .send()
        .await
        .expect("chain write")
        .json()
        .await
        .expect("chain write body");
    assert_eq!(saved["fallbackCount"], json!(1));
    assert_eq!(saved["attemptableCount"], json!(2), "head + one live hop");
    assert!(!saved.to_string().contains(TEST_CHAIN_BEARER));

    // A replace-all that omits `bearer` keeps the ciphertext stored AT THAT
    // POSITION — the property that lets an operator park a hop without
    // re-typing a secret the API can never show them again.
    let parked: Value = auth(http.put(format!("{base}/v1/provider/link/chain")))
        .json(&json!({"entries": [{
            "position": 1,
            "baseUrl": "https://fallback.example.com/v1",
            "enabled": false,
        }]}))
        .send()
        .await
        .expect("chain park")
        .json()
        .await
        .expect("chain park body");
    assert_eq!(parked["entries"][1]["enabled"], json!(false));
    assert_eq!(
        parked["entries"][1]["bearerConfigured"],
        json!(true),
        "the kept bearer survived the replace-all: {parked}"
    );
    assert_eq!(
        parked["attemptableCount"],
        json!(1),
        "a parked hop is not attempted"
    );

    // -- 5. AI 연결 (확인) — the honest probe -------------------------------
    let probe: Value = auth(http.post(format!("{base}/v1/provider/link/test")))
        .send()
        .await
        .expect("probe")
        .json()
        .await
        .expect("probe body");
    assert_eq!(probe["schema"], "momo.provider_link.test.v0");
    assert_eq!(
        probe["reason"], "probe_not_run",
        "this server has no HTTP client, and says so rather than blaming the \
         provider it never dialled: {probe}"
    );
    assert_eq!(probe["cascadeOk"], json!(false));
    assert_eq!(
        probe["entries"][1]["reason"], "hop_disabled",
        "the parked hop is reported as parked, not as unreachable: {probe}"
    );
    assert_eq!(probe["entries"][1]["disposition"], "skipped");

    // -- 6. 코드 실행 호스트 -------------------------------------------------
    let engine: Value = auth(http.get(format!("{base}/v1/provider/work-host-engine")))
        .send()
        .await
        .expect("engine read")
        .json()
        .await
        .expect("engine body");
    assert_eq!(engine["engine"], "opencode");
    assert_eq!(
        engine["source"], "default",
        "an absent row reports the boot default WITHOUT writing one: {engine}"
    );
    let engine_rows: i64 =
        sqlx::query("SELECT count(*)::bigint FROM work_host_engine WHERE workspace_id = $1")
            .bind(fixture.workspace)
            .fetch_one(&su)
            .await
            .expect("engine rows")
            .get(0);
    assert_eq!(engine_rows, 0, "a read must not create a row");

    let bad = auth(http.put(format!("{base}/v1/provider/work-host-engine")))
        .json(&json!({"engine": "claude-code"}))
        .send()
        .await
        .expect("unknown engine");
    assert_eq!(
        bad.status().as_u16(),
        400,
        "an unknown label is a 400 here, never a 500 from the CHECK constraint"
    );

    let engine: Value = auth(http.put(format!("{base}/v1/provider/work-host-engine")))
        .json(&json!({"engine": "goose"}))
        .send()
        .await
        .expect("engine write")
        .json()
        .await
        .expect("engine write body");
    assert_eq!(engine["engine"], "goose");
    assert_eq!(engine["source"], "database");

    // -- 7. 추론 강도 --------------------------------------------------------
    let effort: Value = auth(http.get(format!("{base}/v1/provider/effort-table")))
        .send()
        .await
        .expect("effort table")
        .json()
        .await
        .expect("effort body");
    assert_eq!(
        effort["levels"],
        json!(["low", "medium", "high", "xhigh", "max"])
    );
    assert_eq!(effort["providers"][0]["provider"], "hermes");

    // -- 8. 구독 잔여량 ------------------------------------------------------
    let quota: Value = auth(http.get(format!("{base}/v1/provider/quota-snapshots")))
        .send()
        .await
        .expect("quota")
        .json()
        .await
        .expect("quota body");
    assert!(quota["snapshots"].is_array(), "{quota}");
    assert!(quota["observedAt"].is_string());

    // -- 9. 티어 정책: default → member override ----------------------------
    let policy: Value = auth(http.get(format!(
        "{base}/v1/workspaces/{}/work-tier-policy",
        fixture.workspace
    )))
    .send()
    .await
    .expect("tier read")
    .json()
    .await
    .expect("tier body");
    assert_eq!(policy["workTierPolicy"]["mode"], "ask");
    assert_eq!(
        policy["workTierPolicy"]["inherited"],
        json!(false),
        "the workspace default inherits from nothing"
    );

    let bad = auth(http.put(format!(
        "{base}/v1/workspaces/{}/work-tier-policy",
        fixture.workspace
    )))
    .json(&json!({"mode": "ask", "autoTarget": "cloud"}))
    .send()
    .await
    .expect("target outside auto");
    assert_eq!(bad.status().as_u16(), 400);

    let saved: Value = auth(http.put(format!(
        "{base}/v1/workspaces/{}/work-tier-policy",
        fixture.workspace
    )))
    .json(&json!({"mode": "auto", "autoTarget": "cloud"}))
    .send()
    .await
    .expect("tier write")
    .json()
    .await
    .expect("tier write body");
    assert_eq!(saved["workTierPolicy"]["mode"], "auto");
    assert_eq!(saved["workTierPolicy"]["autoTarget"], "cloud");

    // With no member row, `/me` reports the workspace default AND says so.
    let mine: Value = auth(http.get(format!(
        "{base}/v1/workspaces/{}/work-tier-policy/me",
        fixture.workspace
    )))
    .send()
    .await
    .expect("member tier read")
    .json()
    .await
    .expect("member tier body");
    assert_eq!(mine["workTierPolicy"]["mode"], "auto");
    assert_eq!(
        mine["workTierPolicy"]["inherited"],
        json!(true),
        "no override exists, so the panel must not imply a saved one: {mine}"
    );

    let mine: Value = auth(http.put(format!(
        "{base}/v1/workspaces/{}/work-tier-policy/me",
        fixture.workspace
    )))
    .json(&json!({"mode": "t1_only"}))
    .send()
    .await
    .expect("member tier write")
    .json()
    .await
    .expect("member tier write body");
    assert_eq!(mine["workTierPolicy"]["mode"], "t1_only");
    assert_eq!(mine["workTierPolicy"]["inherited"], json!(false));
    assert_eq!(
        mine["workTierPolicy"]["memberId"],
        fixture.member.to_string()
    );

    // -- 10. 초대 -----------------------------------------------------------
    let created: Value = auth(http.post(format!(
        "{base}/v1/workspaces/{}/invites",
        fixture.workspace
    )))
    .json(&json!({"role": "member", "maxUses": 3}))
    .send()
    .await
    .expect("invite create")
    .json()
    .await
    .expect("invite create body");
    let raw_code = created["code"]
        .as_str()
        .expect("the raw code, once")
        .to_string();
    assert!(raw_code.len() >= 16);
    assert_eq!(created["invite"]["maxUses"], json!(3));
    assert_eq!(created["invite"]["usedCount"], json!(0));
    assert!(
        raw_code.ends_with(created["invite"]["codePreview"].as_str().expect("preview")),
        "the preview is the code's own tail: {created}"
    );

    // The durable record is a hash. Nothing in the table may contain the code.
    let stored_preview: String = sqlx::query(
        "SELECT code_preview FROM invite_code WHERE code_hash = momo_invite_code_hash($1)",
    )
    .bind(&raw_code)
    .fetch_one(&su)
    .await
    .expect("the invite is addressable only by its hash")
    .get(0);
    assert_eq!(stored_preview.len(), 6);

    let listed: Value = auth(http.get(format!(
        "{base}/v1/workspaces/{}/invites?limit=20",
        fixture.workspace
    )))
    .send()
    .await
    .expect("invite list")
    .json()
    .await
    .expect("invite list body");
    let invites = listed["invites"].as_array().expect("invites array");
    assert_eq!(invites.len(), 1);
    assert!(
        !listed.to_string().contains(&raw_code),
        "the list may never carry a redeemable code: {listed}"
    );

    // -- 11. 워크스페이스 생성 ----------------------------------------------
    let slug = format!("conf-{}", Uuid::new_v4().simple());
    let response = auth(http.post(format!("{base}/v1/workspaces")))
        .json(&json!({"slug": slug, "name": "적합성 워크스페이스"}))
        .send()
        .await
        .expect("workspace create");
    assert_eq!(response.status().as_u16(), 201);
    let created: Value = response.json().await.expect("create body");
    let new_workspace =
        Uuid::parse_str(created["workspaceId"].as_str().expect("new workspace id")).expect("uuid");
    assert_eq!(created["slug"], slug);

    // The new tenant is usable, not just recorded: an owner, a #general channel,
    // and the `channel_seq` row without which the send path answers 404.
    let seeded: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM workspace_membership WHERE workspace_id = $1 AND role = 'owner'), \
                (SELECT count(*) FROM channel WHERE workspace_id = $1 AND name = 'general'), \
                (SELECT count(*) FROM channel_seq WHERE workspace_id = $1)",
    )
    .bind(new_workspace)
    .fetch_one(&su)
    .await
    .expect("seeded tenant");
    assert_eq!(seeded, (1, 1, 1), "owner + #general + its seq counter");

    // The same slug twice is an explicit refusal, detected by the constraint.
    let conflict = auth(http.post(format!("{base}/v1/workspaces")))
        .json(&json!({"slug": slug, "name": "두 번째"}))
        .send()
        .await
        .expect("duplicate slug");
    assert_eq!(conflict.status().as_u16(), 409);

    // -- the joins no single call could show --------------------------------
    assert_eq!(
        outbox_rows(&su).await,
        outbox_before,
        "a settings write is not a timeline event: no route in this batch may \
         write an outbox row"
    );
    for action in [
        "provider_link.updated",
        "provider_link_chain.updated",
        "work_host_engine.updated",
        "work.tier_policy.changed",
        "invite.created",
    ] {
        assert!(
            audit_rows(&su, fixture.workspace, action).await > 0,
            "{action} must leave an audit row"
        );
    }
    assert!(
        audit_rows(&su, new_workspace, "workspace.created").await > 0,
        "the provisioning audit row lives in the NEW tenant, not the operator's"
    );

    // The audit trail must be as free of the secret as the response is.
    let details: Vec<String> = sqlx::query_scalar(
        "SELECT detail::text FROM audit_log WHERE workspace_id = $1 AND action LIKE 'provider_link%'",
    )
    .bind(fixture.workspace)
    .fetch_all(&su)
    .await
    .expect("provider audit details");
    assert!(!details.is_empty());
    for detail in details {
        assert!(
            !detail.contains(TEST_BEARER) && !detail.contains(TEST_CHAIN_BEARER),
            "an audit row is read by more people than a response is: {detail}"
        );
    }

    // -- and the surface closes cleanly -------------------------------------
    let cleared: Value = auth(http.delete(format!("{base}/v1/provider/link/chain")))
        .send()
        .await
        .expect("chain delete")
        .json()
        .await
        .expect("chain delete body");
    assert_eq!(cleared["fallbackCount"], json!(0));

    let dropped: Value = auth(http.delete(format!("{base}/v1/provider/link")))
        .send()
        .await
        .expect("link delete")
        .json()
        .await
        .expect("link delete body");
    assert_eq!(
        dropped["source"], "environment",
        "after the delete the env fallback is in force again: {dropped}"
    );
    assert_eq!(dropped["configured"], json!(false));
}

// ---------------------------------------------------------------------------
// 2. the tenant boundary
// ---------------------------------------------------------------------------

/// A foreign tenant's GUC sees **zero** settings rows — and the same queries see
/// them under the owning tenant's GUC.
///
/// The second half is what makes the first half evidence: a query that is simply
/// broken also returns zero rows, and a test that only checked for zero would
/// pass while proving nothing.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_foreign_tenants_settings_rows_are_zero_under_the_callers_guc() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let owner = seed(&su, "owner").await;
    let stranger = seed(&su, "stranger").await;

    // Seed one row of every per-workspace settings table, in the OWNER's tenant.
    momo_db::with_tenant_tx(&app_pool, owner.workspace, {
        let member = owner.member;
        let workspace = owner.workspace;
        move |conn| {
            Box::pin(async move {
                momo_settings::upsert_work_host_engine(conn, workspace, "goose", member).await?;
                momo_settings::upsert_tier_policy(
                    conn,
                    workspace,
                    momo_settings::TierScope::Member(member),
                    "t1_only",
                    None,
                )
                .await?;
                momo_settings::create_invite(conn, workspace, "member", 1, None, member).await?;
                Ok(())
            })
        }
    })
    .await
    .expect("seed the owner's settings rows");

    // Under the STRANGER's GUC every one of them is invisible.
    momo_db::with_tenant_tx(&app_pool, stranger.workspace, {
        let owner_workspace = owner.workspace;
        let owner_member = owner.member;
        move |conn| {
            Box::pin(async move {
                assert!(
                    momo_settings::read_work_host_engine(conn, owner_workspace)
                        .await?
                        .is_none(),
                    "work_host_engine crossed a tenant boundary"
                );
                let policy = momo_settings::load_tier_policy(
                    conn,
                    owner_workspace,
                    momo_settings::TierScope::Member(owner_member),
                )
                .await?;
                assert_eq!(
                    policy.updated_at_ms, None,
                    "the stranger saw the owner's tier policy row"
                );
                assert_eq!(
                    momo_settings::list_invites(conn, true, 200).await?.len(),
                    0,
                    "invite_code crossed a tenant boundary"
                );
                Ok(())
            })
        }
    })
    .await
    .expect("foreign tenant read");

    // …and the SAME queries find them under the owner's GUC, so the zeroes above
    // are the policy at work rather than a broken query.
    momo_db::with_tenant_tx(&app_pool, owner.workspace, {
        let workspace = owner.workspace;
        let member = owner.member;
        move |conn| {
            Box::pin(async move {
                assert_eq!(
                    momo_settings::read_work_host_engine(conn, workspace)
                        .await?
                        .map(|row| row.engine),
                    Some("goose".to_string())
                );
                let policy = momo_settings::load_tier_policy(
                    conn,
                    workspace,
                    momo_settings::TierScope::Member(member),
                )
                .await?;
                assert_eq!(policy.mode, "t1_only");
                assert!(!policy.inherited);
                assert_eq!(momo_settings::list_invites(conn, true, 200).await?.len(), 1);
                Ok(())
            })
        }
    })
    .await
    .expect("owner tenant read");

    // The instance-global provider link has a different boundary and it must be
    // checked on its own terms: an ORDINARY tenant transaction (no
    // `app.provider_link_admin`) sees nothing even in its own workspace, and the
    // operator transaction sees the singleton.
    momo_db::with_provider_link_admin_tx(&app_pool, owner.workspace, {
        let member = owner.member;
        move |conn| {
            Box::pin(async move {
                let sealed = momo_settings::seal_bearer(TEST_BEARER, TEST_PROVIDER_MASTER_KEY)
                    .expect("seal");
                momo_settings::upsert_link(
                    conn,
                    "https://api.example.com/v1",
                    &sealed,
                    "external-hermes",
                    member,
                )
                .await?;
                Ok(())
            })
        }
    })
    .await
    .expect("operator write");

    momo_db::with_tenant_tx(&app_pool, owner.workspace, move |conn| {
        Box::pin(async move {
            assert!(
                momo_settings::read_link(conn).await?.is_none(),
                "provider_link is GUC-gated: a plain tenant transaction — even the \
                 operator's own — must see a default-deny empty view"
            );
            Ok(())
        })
    })
    .await
    .expect("non-operator read");

    momo_db::with_provider_link_admin_tx(&app_pool, owner.workspace, move |conn| {
        Box::pin(async move {
            let stored = momo_settings::read_link(conn)
                .await?
                .expect("the operator transaction sees the singleton it wrote");
            let opened =
                momo_settings::open_bearer(&stored.bearer_ciphertext, TEST_PROVIDER_MASTER_KEY)
                    .expect("the sealed box opens under its own master key");
            assert_eq!(opened, TEST_BEARER);
            assert!(
                momo_settings::open_bearer(&stored.bearer_ciphertext, "another-key").is_err(),
                "and under no other"
            );
            Ok(())
        })
    })
    .await
    .expect("operator read");

    sqlx::query("DELETE FROM provider_link")
        .execute(&su)
        .await
        .expect("clear the instance-global row this test wrote");
}
