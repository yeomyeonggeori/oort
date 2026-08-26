//! HD-1 huddle conformance over the real Axum router and PostgreSQL 18.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test huddle_conformance_pg -- --ignored --nocapture
//! ```
//!
//! `DATABASE_URL` is a superuser used for migrations and fixtures. The server
//! itself connects as `momo_app` (NOBYPASSRLS), so lifecycle and cross-tenant
//! assertions exercise the production FORCE-RLS path. Docker/PG execution is
//! intentionally delegated to the orchestrator for #1757.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_server::config::LiveKitConfig;
use momo_server::{build_app, AppState};
use reqwest::{Client, Method, Response};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "huddle-conformance-app-jwt-secret";
const TEST_LIVEKIT_KEY: &str = "huddle-conformance-livekit-key";
const TEST_LIVEKIT_SECRET: &str = "huddle-conformance-livekit-secret";
const TEST_PASSWORD: &str = "huddle-conformance-password";

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
        .expect("connect as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
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
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/e2e/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args([
            "-v",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "--quiet",
            "--single-transaction",
        ])
        .arg("-f")
        .arg(roles)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

async fn start_server(pool: PgPool, livekit: Option<LiveKitConfig>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
    let state = match livekit {
        Some(config) => state.with_livekit(config),
        None => state,
    };
    tokio::spawn(async move {
        let _ = axum::serve(listener, build_app(state)).await;
    });
    format!("http://{address}")
}

#[derive(Clone)]
struct Person {
    member: Uuid,
    email: String,
}

struct Fixture {
    workspace: Uuid,
    channel: Uuid,
    alice: Person,
    bob: Person,
    foreign_workspace: Uuid,
    foreign_huddle: Uuid,
}

async fn seed_person(su: &PgPool, workspace: Uuid, label: &str) -> Person {
    let member = Uuid::new_v4();
    let email = format!("{member}@huddle.test");
    sqlx::query(
        "INSERT INTO member \
           (id, workspace_id, kind, status, display_name, handle) \
         VALUES ($1, $2, 'human', 'active', $3, $4)",
    )
    .bind(member)
    .bind(workspace)
    .bind(label)
    .bind(format!("huddle-{member}"))
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
    Person { member, email }
}

async fn seed_channel(su: &PgPool, workspace: Uuid, creator: Uuid, members: &[Uuid]) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, created_by) \
         VALUES ($1, $2, 'public', $3, $4)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(format!("huddle-{channel}"))
    .bind(creator)
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (workspace_id, channel_id, last_seq) VALUES ($1, $2, 0)")
        .bind(workspace)
        .bind(channel)
        .execute(su)
        .await
        .expect("seed channel seq");
    for member in members {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
             VALUES ($1, $2, $3, 'member')",
        )
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("seed channel membership");
    }
    channel
}

async fn seed(su: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("huddle-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let alice = seed_person(su, workspace, "Huddle Alice").await;
    let bob = seed_person(su, workspace, "Huddle Bob").await;
    let channel = seed_channel(su, workspace, alice.member, &[alice.member, bob.member]).await;

    let foreign_workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(foreign_workspace)
        .bind(format!("foreign-{foreign_workspace}"))
        .execute(su)
        .await
        .expect("seed foreign workspace");
    let foreign = seed_person(su, foreign_workspace, "Foreign Huddle").await;
    let foreign_channel =
        seed_channel(su, foreign_workspace, foreign.member, &[foreign.member]).await;
    let foreign_huddle: Uuid = sqlx::query_scalar(
        "INSERT INTO huddle (workspace_id, channel_id, started_by) \
         VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(foreign_workspace)
    .bind(foreign_channel)
    .bind(foreign.member)
    .fetch_one(su)
    .await
    .expect("seed foreign huddle");
    sqlx::query(
        "INSERT INTO huddle_participant (workspace_id, huddle_id, member_id) \
         VALUES ($1, $2, $3)",
    )
    .bind(foreign_workspace)
    .bind(foreign_huddle)
    .bind(foreign.member)
    .execute(su)
    .await
    .expect("seed foreign participant");

    Fixture {
        workspace,
        channel,
        alice,
        bob,
        foreign_workspace,
        foreign_huddle,
    }
}

async fn login(client: &Client, base: &str, workspace: Uuid, person: &Person) -> String {
    let response = client
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": person.email,
            "password": TEST_PASSWORD,
            "workspace": workspace,
        }))
        .send()
        .await
        .expect("login request");
    assert_eq!(response.status(), 200, "seeded credentials log in");
    response.json::<Value>().await.expect("login body")["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string()
}

async fn api(client: &Client, method: Method, base: &str, path: &str, token: &str) -> Response {
    client
        .request(method, format!("{base}{path}"))
        .bearer_auth(token)
        .send()
        .await
        .expect("huddle request")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn fail_closed_grant_single_active_reentry_and_rls_conformance() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let client = Client::new();

    let closed_base = start_server(app.clone(), None).await;
    let closed_token = login(&client, &closed_base, fixture.workspace, &fixture.alice).await;
    let arbitrary_huddle = Uuid::new_v4();
    for (method, path) in [
        (
            Method::POST,
            format!(
                "/v1/workspaces/{}/channels/{}/huddles",
                fixture.workspace, fixture.channel
            ),
        ),
        (
            Method::GET,
            format!(
                "/v1/workspaces/{}/channels/{}/huddles/active",
                fixture.workspace, fixture.channel
            ),
        ),
        (
            Method::POST,
            format!(
                "/v1/workspaces/{}/huddles/{arbitrary_huddle}/join",
                fixture.workspace
            ),
        ),
        (
            Method::POST,
            format!(
                "/v1/workspaces/{}/huddles/{arbitrary_huddle}/leave",
                fixture.workspace
            ),
        ),
    ] {
        let response = api(&client, method, &closed_base, &path, &closed_token).await;
        assert_eq!(response.status(), 503, "{path} must fail closed");
        let body: Value = response.json().await.expect("503 body");
        assert_eq!(body["error"]["message"], "허들 미구성");
    }

    let livekit = LiveKitConfig::parse(
        Some(TEST_LIVEKIT_KEY),
        Some(TEST_LIVEKIT_SECRET),
        Some("ws://127.0.0.1:7880"),
    )
    .unwrap();
    let base = start_server(app.clone(), Some(livekit)).await;
    let alice_token = login(&client, &base, fixture.workspace, &fixture.alice).await;
    let bob_token = login(&client, &base, fixture.workspace, &fixture.bob).await;
    let start_path = format!(
        "/v1/workspaces/{}/channels/{}/huddles",
        fixture.workspace, fixture.channel
    );
    let (first, second) = tokio::join!(
        api(&client, Method::POST, &base, &start_path, &alice_token),
        api(&client, Method::POST, &base, &start_path, &alice_token),
    );
    let first_status = first.status();
    let second_status = second.status();
    assert!(
        (first_status == 201 && second_status == 200)
            || (first_status == 200 && second_status == 201),
        "concurrent starts must be one create + one idempotent read: {first_status}/{second_status}"
    );
    let first_body: Value = first.json().await.expect("first start body");
    let second_body: Value = second.json().await.expect("second start body");
    let huddle_id = Uuid::parse_str(first_body["huddle"]["id"].as_str().unwrap()).unwrap();
    assert_eq!(second_body["huddle"]["id"], first_body["huddle"]["id"]);
    let active_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM huddle WHERE channel_id = $1 AND ended_at IS NULL",
    )
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(active_count, 1, "partial unique invariant");

    let join_path = format!(
        "/v1/workspaces/{}/huddles/{huddle_id}/join",
        fixture.workspace
    );
    let response = api(&client, Method::POST, &base, &join_path, &alice_token).await;
    assert_eq!(response.status(), 200);
    let joined: Value = response.json().await.expect("join body");
    assert_eq!(joined["livekitUrl"], "ws://127.0.0.1:7880");
    assert_eq!(joined["ttlSeconds"], 600);
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_nbf = true;
    let claims = decode::<Value>(
        joined["token"].as_str().unwrap(),
        &DecodingKey::from_secret(TEST_LIVEKIT_SECRET.as_bytes()),
        &validation,
    )
    .expect("LiveKit HS256 signature")
    .claims;
    assert_eq!(claims["iss"], TEST_LIVEKIT_KEY);
    assert_eq!(
        claims["sub"],
        fixture.alice.member.to_string().to_uppercase()
    );
    assert_eq!(
        claims["video"]["room"],
        huddle_id.to_string().to_uppercase()
    );
    assert_eq!(claims["video"]["roomJoin"], true);
    assert_eq!(claims["video"]["canPublish"], true);
    assert_eq!(claims["video"]["canSubscribe"], true);
    assert_eq!(
        claims["exp"].as_i64().unwrap() - claims["nbf"].as_i64().unwrap(),
        600
    );

    assert_eq!(
        api(&client, Method::POST, &base, &join_path, &bob_token)
            .await
            .status(),
        200
    );
    let leave_path = format!(
        "/v1/workspaces/{}/huddles/{huddle_id}/leave",
        fixture.workspace
    );
    assert_eq!(
        api(&client, Method::POST, &base, &leave_path, &alice_token)
            .await
            .status(),
        200
    );
    assert_eq!(
        api(&client, Method::POST, &base, &join_path, &alice_token)
            .await
            .status(),
        200,
        "a member may re-enter after leaving"
    );
    let (history_rows, current_rows): (i64, i64) = sqlx::query_as(
        "SELECT count(*), count(*) FILTER (WHERE left_at IS NULL) \
           FROM huddle_participant WHERE huddle_id = $1 AND member_id = $2",
    )
    .bind(huddle_id)
    .bind(fixture.alice.member)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!((history_rows, current_rows), (2, 1));

    let alice_left = api(&client, Method::POST, &base, &leave_path, &alice_token).await;
    assert_eq!(alice_left.status(), 200);
    assert_eq!(alice_left.json::<Value>().await.unwrap()["ended"], false);
    let bob_left = api(&client, Method::POST, &base, &leave_path, &bob_token).await;
    assert_eq!(bob_left.status(), 200);
    assert_eq!(bob_left.json::<Value>().await.unwrap()["ended"], true);
    let active = api(
        &client,
        Method::GET,
        &base,
        &format!(
            "/v1/workspaces/{}/channels/{}/huddles/active",
            fixture.workspace, fixture.channel
        ),
        &alice_token,
    )
    .await;
    assert_eq!(active.status(), 200);
    assert!(active
        .json::<Value>()
        .await
        .unwrap()
        .get("huddle")
        .is_none());

    let event_counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT payload->'data'->>'type', count(*) \
           FROM outbox WHERE workspace_id = $1 \
            AND payload->'data'->'payload'->>'huddle_id' ILIKE $2 \
          GROUP BY 1 ORDER BY 1",
    )
    .bind(fixture.workspace)
    .bind(huddle_id.to_string())
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(
        event_counts,
        vec![
            ("huddle_ended".into(), 1),
            ("huddle_participants_changed".into(), 5),
            ("huddle_started".into(), 1),
        ]
    );
    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND target_id = $2 \
          AND action IN ('huddle.started','huddle.joined','huddle.left')",
    )
    .bind(fixture.workspace)
    .bind(huddle_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(audit_count, 7);

    let force_rls_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_class WHERE relname IN ('huddle','huddle_participant') \
          AND relrowsecurity AND relforcerowsecurity",
    )
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(force_rls_count, 2);
    let foreign_workspace = fixture.foreign_workspace;
    let foreign_huddle = fixture.foreign_huddle;
    let hidden = with_tenant_tx(&app, fixture.workspace, move |conn| {
        Box::pin(async move {
            let huddles: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM huddle WHERE workspace_id = $1 AND id = $2",
            )
            .bind(foreign_workspace)
            .bind(foreign_huddle)
            .fetch_one(&mut *conn)
            .await
            .map_err(DbError::from)?;
            let participants: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM huddle_participant WHERE workspace_id = $1 \
                  AND huddle_id = $2",
            )
            .bind(foreign_workspace)
            .bind(foreign_huddle)
            .fetch_one(&mut *conn)
            .await
            .map_err(DbError::from)?;
            Ok((huddles, participants))
        })
    })
    .await
    .unwrap();
    assert_eq!(hidden, (0, 0), "foreign rows must be invisible under RLS");
}
