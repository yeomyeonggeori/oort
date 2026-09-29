//! #3121 — the notification extension's token is two reads and nothing else.
//!
//! Before: the phone parked its full access token in the keychain group the
//! notification extension reads. After: it parks a `typ = "push_fetch"` token
//! from `POST /v1/auth/push-fetch-token`, which the middleware confines to
//! `GET …/channels/{ch}/messages` and `GET …/roster` of its own workspace.
//!
//! Every test drives the real router on an ephemeral port as `momo_app`.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `the_extension_token_reads_messages_and_roster` | drop the `token` row insert in the mint route, or the `NotAccessToken` arm in `require_principal` |
//! | `every_other_route_is_403_and_never_a_query` | delete the `push_fetch_route_allowed` check in `require_principal` |
//! | `the_extension_cannot_mint_its_own_successor` | same (the mint route is not on the list) |
//! | `it_is_neither_a_refresh_token_nor_a_logout_credential` | let `verify_app_refresh`/`verify_app_access` accept the typ |
//! | `an_unrecorded_or_foreign_signed_token_is_401` | skip `token_state` for the push-fetch arm |
//! | `logging_out_ends_the_extension_token` | record the row outside the caller's lineage |
//! | `the_row_is_a_session_row_of_the_callers_lineage` | change the label or lineage the route records |
//!
//! `#[ignore]` — needs a real Postgres plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test push_fetch_token_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use momo_auth::{sign_push_fetch, PUSH_FETCH_TTL_SECONDS};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::{build_app, AppState, RealtimeAdvert};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "push-fetch-token-conformance-signing-secret";
const TEST_PASSWORD: &str = "push-fetch-token-password";

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
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

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let password = std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".into());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password(&password))
        .await
        .expect("connect as momo_app (run bootstrap_roles.sql first)")
}

struct World {
    su: PgPool,
    http: reqwest::Client,
    base: String,
    workspace: Uuid,
    channel: Uuid,
    email: String,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let handle = format!("pft-{}", &id.simple().to_string()[..10]);
    let email = format!("{id}@push-fetch-token.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed member");
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

async fn world() -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("pft-{workspace}"))
        .execute(&su)
        .await
        .expect("seed workspace");
    let (member, email) = seed_human(&su, workspace, "owner").await;
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, dm_key) \
         VALUES ($1, $2, 'public', 'pft', NULL)",
    )
    .bind(channel)
    .bind(workspace)
    .execute(&su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(&su)
        .await
        .expect("seed channel_seq");
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(&su)
        .await
        .expect("seed channel membership");

    let app = build_app(AppState::new(
        momo_app_pool().await,
        TEST_JWT_SECRET.to_string(),
        RealtimeAdvert::SameOrigin,
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    World {
        su,
        http: reqwest::Client::new(),
        base: format!("http://{address}"),
        workspace,
        channel,
        email,
    }
}

struct Session {
    access: String,
    refresh: String,
}

impl World {
    async fn login(&self) -> Session {
        let response = self
            .http
            .post(format!("{}/v1/auth/login", self.base))
            .json(&json!({
                "email": self.email,
                "password": TEST_PASSWORD,
                "workspace": self.workspace.to_string(),
            }))
            .send()
            .await
            .expect("login");
        assert_eq!(response.status().as_u16(), 200, "seeded human logs in");
        let body: Value = response.json().await.expect("login body");
        Session {
            access: body["accessToken"].as_str().expect("access").to_string(),
            refresh: body["refreshToken"].as_str().expect("refresh").to_string(),
        }
    }

    /// Mint through the real route with the session's full access token.
    async fn mint(&self, session: &Session) -> String {
        let response = self
            .http
            .post(format!("{}/v1/auth/push-fetch-token", self.base))
            .bearer_auth(&session.access)
            .send()
            .await
            .expect("mint");
        assert_eq!(response.status().as_u16(), 200, "a live session can mint");
        let body: Value = response.json().await.expect("mint body");
        assert_eq!(body["ttlSeconds"].as_i64(), Some(PUSH_FETCH_TTL_SECONDS));
        body["token"].as_str().expect("token").to_string()
    }

    async fn status(&self, method: &str, path: &str, bearer: &str, body: Option<Value>) -> u16 {
        let url = format!("{}{path}", self.base);
        let request = match method {
            "GET" => self.http.get(url),
            "POST" => self.http.post(url),
            "PATCH" => self.http.patch(url),
            "DELETE" => self.http.delete(url),
            other => panic!("unexpected method {other}"),
        }
        .bearer_auth(bearer);
        let request = match body {
            Some(body) => request.json(&body),
            None => request,
        };
        request.send().await.expect("request").status().as_u16()
    }

    fn messages_path(&self) -> String {
        format!(
            "/v1/workspaces/{}/channels/{}/messages?limit=200",
            self.workspace, self.channel
        )
    }

    fn roster_path(&self) -> String {
        format!("/v1/workspaces/{}/roster", self.workspace)
    }
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn the_extension_token_reads_messages_and_roster() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let push = w.mint(&session).await;
    assert_eq!(w.status("GET", &w.messages_path(), &push, None).await, 200);
    assert_eq!(w.status("GET", &w.roster_path(), &push, None).await, 200);
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn every_other_route_is_403_and_never_a_query() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let push = w.mint(&session).await;
    let ws = w.workspace;
    let ch = w.channel;
    let foreign = Uuid::new_v4();
    let cases: Vec<(&str, String, Option<Value>)> = vec![
        // The write the full token could make.
        (
            "POST",
            format!("/v1/workspaces/{ws}/channels/{ch}/messages"),
            Some(json!({"body": "x", "clientMsgId": Uuid::new_v4().to_string()})),
        ),
        ("GET", format!("/v1/workspaces/{ws}/channels"), None),
        ("GET", format!("/v1/workspaces/{ws}/members"), None),
        (
            "GET",
            format!("/v1/workspaces/{ws}/search/messages?q=x"),
            None,
        ),
        ("GET", "/v1/auth/devices".to_string(), None),
        ("POST", "/v1/auth/realtime-token".to_string(), None),
        // Same reads, another tenant.
        ("GET", format!("/v1/workspaces/{foreign}/roster"), None),
        (
            "GET",
            format!("/v1/workspaces/{foreign}/channels/{ch}/messages"),
            None,
        ),
    ];
    for (method, path, body) in cases {
        assert_eq!(
            w.status(method, &path, &push, body).await,
            403,
            "{method} {path} must be refused for the extension token"
        );
    }
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn the_extension_cannot_mint_its_own_successor() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let push = w.mint(&session).await;
    assert_eq!(
        w.status("POST", "/v1/auth/push-fetch-token", &push, None)
            .await,
        403
    );
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn it_is_neither_a_refresh_token_nor_a_logout_credential() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let push = w.mint(&session).await;
    let refresh = w
        .http
        .post(format!("{}/v1/auth/refresh", w.base))
        .json(&json!({"refreshToken": push}))
        .send()
        .await
        .expect("refresh");
    assert_eq!(refresh.status().as_u16(), 401);
    // Presented as the bearer of a logout, it ends nothing: 401, and the
    // person's real session is untouched.
    assert_eq!(w.status("POST", "/v1/auth/logout", &push, None).await, 401);
    assert_eq!(
        w.status("GET", &w.roster_path(), &session.access, None)
            .await,
        200
    );
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn an_unrecorded_or_foreign_signed_token_is_401() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let member: Uuid = sqlx::query_scalar("SELECT member_id FROM human WHERE email = $1")
        .bind(&w.email)
        .fetch_one(&w.su)
        .await
        .expect("member id");
    // Signed with the right key but never recorded: the revocation table is the
    // authority, not the signature.
    let unrecorded = sign_push_fetch(member, w.workspace, TEST_JWT_SECRET)
        .expect("sign")
        .token;
    assert_eq!(
        w.status("GET", &w.roster_path(), &unrecorded, None).await,
        401
    );
    let foreign = sign_push_fetch(member, w.workspace, "some-other-secret")
        .expect("sign")
        .token;
    assert_eq!(w.status("GET", &w.roster_path(), &foreign, None).await, 401);
    // A refresh token is not this token either.
    assert_eq!(
        w.status("GET", &w.roster_path(), &session.refresh, None)
            .await,
        401
    );
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn logging_out_ends_the_extension_token() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let push = w.mint(&session).await;
    assert_eq!(w.status("GET", &w.roster_path(), &push, None).await, 200);
    let logout = w
        .http
        .post(format!("{}/v1/auth/logout", w.base))
        .bearer_auth(&session.access)
        .json(&json!({"refreshToken": session.refresh}))
        .send()
        .await
        .expect("logout");
    assert_eq!(logout.status().as_u16(), 200);
    assert_eq!(w.status("GET", &w.roster_path(), &push, None).await, 401);
    // And a token cannot be minted from the session that just ended.
    let again = w
        .http
        .post(format!("{}/v1/auth/push-fetch-token", w.base))
        .bearer_auth(&session.access)
        .send()
        .await
        .expect("mint after logout");
    assert_eq!(again.status().as_u16(), 401);
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn a_rotation_keeps_it_alive_and_a_spent_session_does_not() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let push = w.mint(&session).await;
    let rotated = w
        .http
        .post(format!("{}/v1/auth/refresh", w.base))
        .json(&json!({"refreshToken": session.refresh}))
        .send()
        .await
        .expect("refresh");
    assert_eq!(rotated.status().as_u16(), 200);
    let body: Value = rotated.json().await.expect("refresh body");
    assert_eq!(
        w.status("GET", &w.roster_path(), &push, None).await,
        200,
        "the lineage rotated, it did not end"
    );
    // The member is removed from the workspace's sessions: every session row is
    // revoked, refresh included, so the token dies with them.
    sqlx::query(
        "UPDATE token SET revoked_at = now() WHERE workspace_id = $1 AND label = 'refresh'",
    )
    .bind(w.workspace)
    .execute(&w.su)
    .await
    .expect("revoke every refresh row");
    assert!(body["accessToken"].is_string());
    assert_eq!(w.status("GET", &w.roster_path(), &push, None).await, 401);
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn the_row_is_a_session_row_of_the_callers_lineage() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let _push = w.mint(&session).await;
    let rows: Vec<(String, String, Option<Uuid>, bool)> = sqlx::query_as(
        "SELECT kind::text, label, session_id, \
                expires_at < now() + interval '6 hours 1 minute' AS bounded \
           FROM token WHERE workspace_id = $1 AND label = 'push_fetch'",
    )
    .bind(w.workspace)
    .fetch_all(&w.su)
    .await
    .expect("read the recorded row");
    assert_eq!(rows.len(), 1, "one mint, one row");
    let (kind, label, session_id, bounded) = &rows[0];
    assert_eq!(kind, "session");
    assert_eq!(label, "push_fetch");
    assert!(bounded, "the row's expiry is the six-hour bound");
    let lineage: Option<Uuid> = sqlx::query_scalar(
        "SELECT session_id FROM token WHERE workspace_id = $1 AND label = 'access' LIMIT 1",
    )
    .bind(w.workspace)
    .fetch_one(&w.su)
    .await
    .expect("the caller's lineage");
    assert!(session_id.is_some());
    assert_eq!(*session_id, lineage, "the lineage a logout sweeps");
}
