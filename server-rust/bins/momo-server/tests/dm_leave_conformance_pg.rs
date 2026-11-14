//! #5822 / ADR-0177 증보 2026-11-14 (D15·D16·D17·D18) — 1:1 「대화 나가기」 on a real Postgres.
//!
//! `PUT /v1/workspaces/{ws}/channels/{ch}/dm-leave`, `membership.history_from_seq`, the `message`
//! read policy `dm_leave_history_floor` (migration 180) and the requester value
//! `app.requester_member_id` bound by the two human principal doors. Every read here runs as the
//! **NOBYPASSRLS** `momo_app` role, with two workspaces where the boundary matters.
//!
//! | ADR 수용 | proof | test |
//! |---|---|---|
//! | 1 | member boundary — the other participant's reads are unchanged; another tenant's rows are untouched | `the_policy_hides_only_the_requesters_rows_below_their_floor` |
//! | 2 | read paths — history, thread replies, search, inbox, push fetch and the developer door return nothing below the floor | `the_leaver_reads_nothing_below_the_floor_through_any_door` |
//! | 3 | pass — an empty requester and a channel without the requester's membership row are not filtered; every non-bypass reader still reads | `the_policy_hides_only_the_requesters_rows_below_their_floor`, `every_non_bypass_reader_still_reads_message` |
//! | 4 | watermark — a message after the client's `seenSeq` stays; a repeat is the same; a late retransmit lowers nothing | `the_floor_is_the_clients_seen_seq_and_only_moves_up` |
//! | 5 | resumes — a new message from the other side is the whole conversation; opening the DM again is the same room | `the_conversation_resumes_in_the_same_room` |
//! | 6 | scope — 409 outside D20, 404 for anything not the caller's live DM, 403 for an agent bearer | `leave_answers_by_scope` |
//! | 6a | clean-up order — the caller's reminders, follows and inbox below the floor are gone (row counts); only this room's schedules are cancelled | `the_callers_own_items_are_cleared_before_the_floor_moves` |
//! | 6b | requester value — each human door binds it; an agent and the owner scope do not | `every_human_door_binds_the_requester` |
//! | 7 | write paths answer without a 500 | `write_paths_below_the_floor_answer_without_a_500` |
//!
//! The pending agent admission half of 6 lives with the admission fixture
//! (`tests/cases/dm_agent_admission.rs`, `dm_admission_a_one_to_one_leave_cancels_the_pending_request`).
//!
//! **Assertions are values with controls.** Every "hidden" has a positive control (the other
//! participant, or the same read before leaving).
//!
//! `#[ignore]` — needs a real Postgres (pgvector/pg18). Isolated database only:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test dm_leave_conformance_pg -- --ignored --test-threads=1
//! ```

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use axum::extract::{Path as AxPath, State as AxState};
use axum::routing::{get, post};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "dm-leave-conformance-signing-secret";
const TEST_PASSWORD: &str = "dm-leave-test-password";

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

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

struct World {
    su: PgPool,
    app: PgPool,
    state: AppState,
    base: String,
    http: reqwest::Client,
}

#[derive(Clone)]
struct Person {
    id: Uuid,
    token: String,
}

impl World {
    async fn new() -> World {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        let app = momo_app_pool().await;
        let state = AppState::new(
            app.clone(),
            TEST_JWT_SECRET.to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        );
        let router = build_app(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind momo-server");
        let address: SocketAddr = listener.local_addr().expect("server address");
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        World {
            su,
            app,
            state,
            base: format!("http://{address}"),
            http: reqwest::Client::new(),
        }
    }

    async fn workspace(&self, hint: &str) -> Uuid {
        let workspace = Uuid::new_v4();
        sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
            .bind(workspace)
            .bind(format!("{hint}-{workspace}"))
            .execute(&self.su)
            .await
            .expect("seed workspace");
        workspace
    }

    async fn member_row(&self, workspace: Uuid, kind: &str, label: &str) -> Uuid {
        let id = Uuid::new_v4();
        let handle = format!("{label}-{}", &id.simple().to_string()[..8]);
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, $3::member_kind, $4, $4)",
        )
        .bind(id)
        .bind(workspace)
        .bind(kind)
        .bind(&handle)
        .execute(&self.su)
        .await
        .expect("seed member");
        sqlx::query(
            "INSERT INTO workspace_membership (workspace_id, member_id, role) \
             VALUES ($1, $2, 'member')",
        )
        .bind(workspace)
        .bind(id)
        .execute(&self.su)
        .await
        .expect("seed workspace membership");
        id
    }

    /// A human who can log in, with a ready bearer.
    async fn human(&self, workspace: Uuid, label: &str) -> Person {
        let id = self.member_row(workspace, "human", label).await;
        let email = format!("{id}@dm-leave.test");
        sqlx::query(
            "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
             VALUES ($1, $2, $3, true, momo_password_hash($4))",
        )
        .bind(id)
        .bind(workspace)
        .bind(&email)
        .bind(TEST_PASSWORD)
        .execute(&self.su)
        .await
        .expect("seed human auth");
        let token = self.login(workspace, &email).await;
        Person { id, token }
    }

    async fn login(&self, workspace: Uuid, email: &str) -> String {
        let response = self
            .http
            .post(format!("{}/v1/auth/login", self.base))
            .json(&json!({ "email": email, "password": TEST_PASSWORD, "workspace": workspace }))
            .send()
            .await
            .expect("login");
        assert_eq!(response.status(), 200, "seeded human logs in");
        let body: Value = response.json().await.expect("login body");
        body["accessToken"]
            .as_str()
            .expect("access token")
            .to_string()
    }

    async fn channel(
        &self,
        workspace: Uuid,
        kind: &str,
        key: Option<&str>,
        members: &[Uuid],
    ) -> Uuid {
        let channel = Uuid::new_v4();
        if kind == "dm" {
            sqlx::query(
                "INSERT INTO channel (id, workspace_id, kind, dm_key, created_by) \
                 VALUES ($1, $2, 'dm', $3, $4)",
            )
            .bind(channel)
            .bind(workspace)
            .bind(key.map_or_else(|| format!("t5822-{channel}"), |k| format!("{k}{channel}")))
            .bind(members[0])
            .execute(&self.su)
            .await
            .expect("seed dm");
        } else {
            sqlx::query(
                "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
                 VALUES ($1, $2, $3::channel_kind, $4, '', $5)",
            )
            .bind(channel)
            .bind(workspace)
            .bind(kind)
            .bind(format!("ch-{}", &channel.simple().to_string()[..8]))
            .bind(members[0])
            .execute(&self.su)
            .await
            .expect("seed channel");
        }
        sqlx::query(
            "INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)",
        )
        .bind(channel)
        .bind(workspace)
        .execute(&self.su)
        .await
        .expect("seed channel_seq");
        for member in members {
            sqlx::query(
                "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
            )
            .bind(workspace)
            .bind(channel)
            .bind(member)
            .execute(&self.su)
            .await
            .expect("seed membership");
        }
        channel
    }

    async fn dm(&self, workspace: Uuid, a: &Person, b: &Person) -> Uuid {
        self.channel(workspace, "dm", None, &[a.id, b.id]).await
    }

    fn url(&self, path: String) -> String {
        format!("{}{path}", self.base)
    }

    /// A message through the real REST send. Returns `(id, seq)`.
    async fn say_with(&self, who: &Person, ws: Uuid, ch: Uuid, body: Value) -> (u16, Value) {
        let response = self
            .http
            .post(self.url(format!("/v1/workspaces/{ws}/channels/{ch}/messages")))
            .bearer_auth(&who.token)
            .json(&body)
            .send()
            .await
            .expect("send");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(json!({})))
    }

    async fn say(&self, who: &Person, ws: Uuid, ch: Uuid, text: &str) -> (Uuid, i64) {
        let (status, body) = self
            .say_with(
                who,
                ws,
                ch,
                json!({ "clientMsgId": Uuid::new_v4(), "body": text }),
            )
            .await;
        assert_eq!(status, 201, "send is 201: {body}");
        (
            Uuid::parse_str(body["id"].as_str().expect("message id")).expect("uuid"),
            body["seq"].as_i64().expect("seq"),
        )
    }

    async fn leave(
        &self,
        who: &Person,
        ws: Uuid,
        ch: impl std::fmt::Display,
        seen: Value,
    ) -> (u16, Value) {
        let response = self
            .http
            .put(self.url(format!("/v1/workspaces/{ws}/channels/{ch}/dm-leave")))
            .bearer_auth(&who.token)
            .json(&json!({ "seenSeq": seen }))
            .send()
            .await
            .expect("PUT dm-leave");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(json!({})))
    }

    async fn get_text(&self, bearer: &str, path: String) -> (u16, String) {
        let response = self
            .http
            .get(self.url(path))
            .bearer_auth(bearer)
            .send()
            .await
            .expect("GET");
        let status = response.status().as_u16();
        (status, response.text().await.unwrap_or_default())
    }

    async fn read_row(&self, who: &Person, ws: Uuid, ch: Uuid) -> Value {
        let (status, text) = self
            .get_text(&who.token, format!("/v1/workspaces/{ws}/read-state"))
            .await;
        assert_eq!(status, 200, "read-state is 200: {text}");
        let body: Value = serde_json::from_str(&text).expect("read-state json");
        body["read_states"]
            .as_array()
            .expect("rows")
            .iter()
            .find(|row| row["channel_id"].as_str().map(str::to_lowercase) == Some(ch.to_string()))
            .cloned()
            .unwrap_or_else(|| panic!("no read-state row for {ch}: {text}"))
    }

    async fn floor(&self, member: Uuid, ch: Uuid) -> Option<i64> {
        sqlx::query_scalar(
            "SELECT history_from_seq FROM membership WHERE member_id = $1 AND channel_id = $2",
        )
        .bind(member)
        .bind(ch)
        .fetch_one(&self.su)
        .await
        .expect("read floor")
    }

    async fn count(&self, sql: &str, a: Uuid, b: Uuid) -> i64 {
        sqlx::query_scalar(sql)
            .bind(a)
            .bind(b)
            .fetch_one(&self.su)
            .await
            .unwrap_or_else(|e| panic!("count {sql}: {e}"))
    }

    /// Count `message` rows of `channel` visible to a `momo_app` tenant transaction of `ws`, as
    /// `requester` (the task-local the doors scope) or as nobody.
    async fn visible(&self, ws: Uuid, ch: Uuid, requester: Option<Uuid>) -> i64 {
        let body = with_tenant_tx(&self.app, ws, move |conn| {
            Box::pin(async move {
                let n: i64 =
                    sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
                        .bind(ch)
                        .fetch_one(&mut *conn)
                        .await
                        .map_err(DbError::from)?;
                Ok(n)
            })
        });
        match requester {
            Some(id) => momo_db::tenant::REQUEST_HUMAN_MEMBER.scope(id, body).await,
            None => body.await,
        }
        .expect("count visible")
    }
}

fn ids_in(text: &str, ids: &[Uuid]) -> usize {
    let lower = text.to_lowercase();
    ids.iter()
        .filter(|id| lower.contains(&id.to_string()))
        .count()
}

// ---------------------------------------------------------------------------
// 1 · 3 — the policy itself
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn the_policy_hides_only_the_requesters_rows_below_their_floor() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("policy").await;
    let other_ws = w.workspace("policy-other").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let dm = w.dm(ws, &a, &b).await;
    let open = w.channel(ws, "public", None, &[b.id]).await;
    for n in 0..5 {
        w.say(&b, ws, dm, &format!("dm {n}")).await;
    }
    w.say(&b, ws, open, "open").await;
    let c = w.human(other_ws, "park").await;
    let d = w.human(other_ws, "choi").await;
    let foreign = w.dm(other_ws, &c, &d).await;
    w.say(&c, other_ws, foreign, "foreign").await;

    sqlx::query(
        "UPDATE membership SET history_from_seq = 4 WHERE member_id = $1 AND channel_id = $2",
    )
    .bind(a.id)
    .bind(dm)
    .execute(&w.su)
    .await
    .expect("set floor");

    assert_eq!(
        w.visible(ws, dm, Some(a.id)).await,
        2,
        "the leaver reads seq 4 and 5"
    );
    assert_eq!(
        w.visible(ws, dm, Some(b.id)).await,
        5,
        "the other participant reads all of it"
    );
    assert_eq!(
        w.visible(ws, dm, None).await,
        5,
        "no requester (relay, notifier, workers): not filtered"
    );
    assert_eq!(
        w.visible(ws, open, Some(a.id)).await,
        1,
        "a channel without the requester's membership row has no floor"
    );
    assert_eq!(
        w.visible(other_ws, foreign, Some(a.id)).await,
        1,
        "another tenant is untouched"
    );
    assert_eq!(
        w.visible(other_ws, dm, Some(a.id)).await,
        0,
        "and still cannot see this one"
    );

    // 6b: re-pointing the owner scope (`app.member_id`, what a foreign binding does) inside the
    // requester's transaction changes nothing — the policy reads the requester value only.
    let seen_with_owner_moved = momo_db::tenant::REQUEST_HUMAN_MEMBER
        .scope(
            a.id,
            with_tenant_tx(&w.app, ws, move |conn| {
                Box::pin(async move {
                    sqlx::query("SELECT set_config('app.member_id', $1, true)")
                        .bind(b.id.to_string())
                        .execute(&mut *conn)
                        .await
                        .map_err(DbError::from)?;
                    let n: i64 =
                        sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
                            .bind(dm)
                            .fetch_one(&mut *conn)
                            .await
                            .map_err(DbError::from)?;
                    Ok(n)
                })
            }),
        )
        .await
        .expect("count with the owner scope moved");
    assert_eq!(
        seen_with_owner_moved, 2,
        "the owner scope is not the requester"
    );
}

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn every_non_bypass_reader_still_reads_message() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("roles").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let dm = w.dm(ws, &a, &b).await;
    for n in 0..3 {
        w.say(&b, ws, dm, &format!("r {n}")).await;
    }
    sqlx::query(
        "UPDATE membership SET history_from_seq = 3 WHERE member_id = $1 AND channel_id = $2",
    )
    .bind(a.id)
    .bind(dm)
    .execute(&w.su)
    .await
    .expect("set floor");
    // The policy's `membership` subquery is checked against the reading role's privileges. Each
    // non-bypass role that reads `message` must still read it — empty requester and bound.
    for role in ["momo_app", "momo_helper_read", "mem_definer"] {
        for (requester, expected) in [(String::new(), 3_i64), (a.id.to_string(), 1)] {
            let mut tx = w.su.begin().await.expect("begin");
            sqlx::query("SELECT set_config('app.workspace_id', $1, true), set_config('app.requester_member_id', $2, true)")
                .bind(ws.to_string())
                .bind(&requester)
                .execute(&mut *tx)
                .await
                .expect("bind");
            sqlx::query(&format!("SET LOCAL ROLE {role}"))
                .execute(&mut *tx)
                .await
                .expect("set role");
            let n: i64 = sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
                .bind(dm)
                .fetch_one(&mut *tx)
                .await
                .unwrap_or_else(|e| panic!("{role} reads message: {e}"));
            assert_eq!(n, expected, "{role} with requester {requester:?}");
            tx.rollback().await.expect("rollback");
        }
    }
}

// ---------------------------------------------------------------------------
// 6b — every human door binds the requester
// ---------------------------------------------------------------------------

async fn probe(
    AxState(pool): AxState<PgPool>,
    AxPath(params): AxPath<HashMap<String, String>>,
) -> String {
    let ws = Uuid::parse_str(&params["ws"]).expect("ws");
    with_tenant_tx(&pool, ws, move |conn| {
        Box::pin(async move {
            let (requester, owner): (Option<String>, Option<String>) = sqlx::query_as(
                "SELECT current_setting('app.requester_member_id', true), \
                        current_setting('app.member_id', true)",
            )
            .fetch_one(&mut *conn)
            .await
            .map_err(DbError::from)?;
            Ok(format!(
                "{}|{}",
                requester.unwrap_or_default(),
                owner.unwrap_or_default()
            ))
        })
    })
    .await
    .expect("probe tx")
}

/// The production middleware in front of a handler that reports what the transaction carries, at
/// the exact templates the narrow credentials are confined to.
async fn probe_server(w: &World) -> String {
    let probes = axum::Router::new()
        .route("/v1/workspaces/{ws}/channels/{ch}/messages", get(probe))
        .route(
            "/v1/workspaces/{ws}/approvals/{approval}/decision",
            post(probe),
        )
        .route("/v1/workspaces/{ws}/channels/{ch}/dm-probe", get(probe))
        .with_state(w.app.clone())
        .route_layer(axum::middleware::from_fn_with_state(
            w.state.clone(),
            momo_server::auth::require_principal,
        ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind probe");
    let address: SocketAddr = listener.local_addr().expect("probe address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            probes.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

async fn mint(w: &World, who: &Person, path: &str) -> String {
    let response = w
        .http
        .post(w.url(path.to_string()))
        .bearer_auth(&who.token)
        .send()
        .await
        .expect("mint");
    assert_eq!(response.status(), 200, "mint {path}");
    let body: Value = response.json().await.expect("mint body");
    body["token"].as_str().expect("token").to_string()
}

async fn dev_card(w: &World, who: &Person, ws: Uuid) -> String {
    // The default developer-access policy admits admins; the door, not the policy, is under test.
    sqlx::query(
        "UPDATE workspace_membership SET role = 'admin' WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(ws)
    .bind(who.id)
    .execute(&w.su)
    .await
    .expect("admin role");
    let response = w
        .http
        .post(w.url(format!("/v1/workspaces/{ws}/dev-access/credentials")))
        .bearer_auth(&who.token)
        .json(
            &json!({"name": "도현 맥북", "tool": "claude_code", "currentPassword": TEST_PASSWORD}),
        )
        .send()
        .await
        .expect("issue card");
    let status = response.status();
    let body: Value = response.json().await.expect("card body");
    assert_eq!(status, 201, "issue a developer card: {body}");
    body["token"].as_str().expect("card secret").to_string()
}

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn every_human_door_binds_the_requester() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("doors").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let dm = w.dm(ws, &a, &b).await;
    let probes = probe_server(&w).await;
    let fetch = mint(&w, &a, "/v1/auth/push-fetch-token").await;
    let action = mint(&w, &a, "/v1/auth/push-action-token").await;
    let card = dev_card(&w, &a, ws).await;
    let me = a.id.to_string();

    let ask = |bearer: String, method: &'static str, path: String| {
        let http = w.http.clone();
        let url = format!("{probes}{path}");
        async move {
            let request = match method {
                "POST" => http.post(url),
                _ => http.get(url),
            };
            let response = request.bearer_auth(bearer).send().await.expect("probe");
            let status = response.status().as_u16();
            (status, response.text().await.unwrap_or_default())
        }
    };
    let history = format!("/v1/workspaces/{ws}/channels/{dm}/messages");
    let decision = format!("/v1/workspaces/{ws}/approvals/{}/decision", Uuid::new_v4());
    for (door, bearer, method, path) in [
        ("session", a.token.clone(), "GET", history.clone()),
        ("push-fetch", fetch, "GET", history.clone()),
        ("push-action", action, "POST", decision),
        ("developer token", card, "GET", history.clone()),
    ] {
        let (status, text) = ask(bearer, method, path).await;
        assert_eq!(status, 200, "{door} passes the door: {text}");
        let (requester, owner) = text.split_once('|').expect("probe answer");
        assert_eq!(requester, me, "{door} binds the requester value");
        assert_eq!(owner, "", "{door} leaves the owner scope alone");
    }
}

// ---------------------------------------------------------------------------
// 2 — every read path of the leaver
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn the_leaver_reads_nothing_below_the_floor_through_any_door() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("paths").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let dm = w.dm(ws, &a, &b).await;
    let (root, _) = w.say(&b, ws, dm, "needle-root 옛 글").await;
    let (reply_status, reply) = w
        .say_with(
            &b,
            ws,
            dm,
            json!({"clientMsgId": Uuid::new_v4(), "body": "needle-reply", "rootId": root}),
        )
        .await;
    assert_eq!(reply_status, 201, "{reply}");
    let reply_id = Uuid::parse_str(reply["id"].as_str().unwrap()).unwrap();
    let (mine, head) = w.say(&a, ws, dm, "needle-mine").await;
    let old = [root, reply_id, mine];
    let fetch = mint(&w, &a, "/v1/auth/push-fetch-token").await;
    let card = dev_card(&w, &a, ws).await;

    let history = format!("/v1/workspaces/{ws}/channels/{dm}/messages");
    let replies = format!("/v1/workspaces/{ws}/channels/{dm}/messages/{root}/replies");
    let search = format!("/v1/workspaces/{ws}/search/messages?q=needle");
    let inbox = format!("/v1/workspaces/{ws}/inbox");

    // Controls: before leaving, every door shows the old messages to the leaver.
    for (door, bearer, path) in [
        ("history", &a.token, &history),
        ("search", &a.token, &search),
        ("push fetch", &fetch, &history),
        ("developer token", &card, &history),
    ] {
        let (status, text) = w.get_text(bearer, path.clone()).await;
        assert_eq!(status, 200, "{door}: {text}");
        assert!(
            ids_in(&text, &old) >= 2,
            "{door} control shows the old messages: {text}"
        );
    }
    let (status, text) = w.get_text(&a.token, inbox.clone()).await;
    assert_eq!(status, 200, "{text}");
    assert!(
        ids_in(&text, &old) >= 1,
        "inbox control holds the DM items: {text}"
    );

    let (status, body) = w.leave(&a, ws, dm, json!(head)).await;
    assert_eq!(status, 204, "{body}");

    for (door, bearer, path) in [
        ("history", &a.token, &history),
        ("search", &a.token, &search),
        ("inbox", &a.token, &inbox),
        ("push fetch", &fetch, &history),
        ("developer token", &card, &history),
    ] {
        let (status, text) = w.get_text(bearer, path.clone()).await;
        assert_eq!(status, 200, "{door} still answers: {text}");
        assert_eq!(
            ids_in(&text, &old),
            0,
            "{door} returns nothing below the floor: {text}"
        );
    }
    let (status, text) = w.get_text(&a.token, replies.clone()).await;
    assert_ne!(status, 500, "{text}");
    assert_eq!(
        ids_in(&text, &[reply_id]),
        0,
        "thread replies below the floor: {status} {text}"
    );

    // The other participant: unchanged (수용 1).
    for path in [&history, &search] {
        let (status, text) = w.get_text(&b.token, path.clone()).await;
        assert_eq!(status, 200, "{text}");
        assert!(
            ids_in(&text, &old) >= 2,
            "the other participant still reads it: {text}"
        );
    }
    let (status, text) = w.get_text(&b.token, replies).await;
    assert_eq!(status, 200, "{text}");
    assert_eq!(ids_in(&text, &[reply_id]), 1, "{text}");
}

// ---------------------------------------------------------------------------
// 4 — watermark, idempotence, projection
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn the_floor_is_the_clients_seen_seq_and_only_moves_up() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("watermark").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let dm = w.dm(ws, &a, &b).await;
    for n in 0..3 {
        w.say(&b, ws, dm, &format!("w {n}")).await;
    }
    let before = w.read_row(&a, ws, dm).await;
    assert!(
        before.get("history_from_seq").is_some(),
        "the key is always present: {before}"
    );
    assert!(before["history_from_seq"].is_null(), "{before}");
    let seen = before["latest_seq"].as_i64().unwrap();
    // Mark a seq unread, then a message lands after the projection the client holds.
    let response = w
        .http
        .put(w.url(format!("/v1/workspaces/{ws}/channels/{dm}/read-state")))
        .bearer_auth(&a.token)
        .json(&json!({"last_read_seq": 1, "mark_unread_before_seq": 2}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "mark unread");
    let (late, late_seq) = w.say(&b, ws, dm, "w late").await;

    let audits = "SELECT count(*) FROM audit_log WHERE action = 'dm.left' AND actor_member_id = $1 AND target_id = $2";
    let (status, body) = w.leave(&a, ws, dm, json!(seen)).await;
    assert_eq!(status, 204, "{body}");
    assert_eq!(w.floor(a.id, dm).await, Some(seen + 1));
    let (_, text) = w
        .get_text(
            &a.token,
            format!("/v1/workspaces/{ws}/channels/{dm}/messages"),
        )
        .await;
    assert_eq!(
        ids_in(&text, &[late]),
        1,
        "the message after seenSeq is not buried: {text}"
    );

    let row = w.read_row(&a, ws, dm).await;
    assert_eq!(row["history_from_seq"], json!(seen + 1), "{row}");
    assert_eq!(row["last_read_seq"], json!(seen), "{row}");
    assert_eq!(row["unread_count"], json!(late_seq - seen), "{row}");
    assert_eq!(row["mention_count"], json!(0), "{row}");
    assert!(
        row["marked_unread_before_seq"].is_null(),
        "the mark is cleared with the leave: {row}"
    );
    assert_eq!(
        row["closed_at_seq"],
        json!(seen),
        "older clients hide it too: {row}"
    );
    let other = w.read_row(&b, ws, dm).await;
    assert!(
        other["history_from_seq"].is_null(),
        "never another member's floor: {other}"
    );
    assert_eq!(w.count(audits, a.id, dm).await, 1);

    // The same PUT again, and a late retransmit with an older seq: nothing moves, no second audit.
    for again in [seen, 0] {
        let (status, body) = w.leave(&a, ws, dm, json!(again)).await;
        assert_eq!(status, 204, "{body}");
        assert_eq!(
            w.floor(a.id, dm).await,
            Some(seen + 1),
            "seenSeq {again} lowers nothing"
        );
    }
    assert_eq!(w.count(audits, a.id, dm).await, 1, "one audit row per move");
    // A seenSeq past the head is clamped by it.
    let (status, _) = w.leave(&a, ws, dm, json!(9_999)).await;
    assert_eq!(status, 204);
    assert_eq!(w.floor(a.id, dm).await, Some(late_seq + 1));
    assert_eq!(w.count(audits, a.id, dm).await, 2);
    // The body is the closure route's: a negative or missing seenSeq is a 400.
    for bad in [json!(-1), json!("3"), Value::Null] {
        let (status, _) = w.leave(&a, ws, dm, bad.clone()).await;
        assert_eq!(status, 400, "{bad}");
    }
}

// ---------------------------------------------------------------------------
// 5 — resuming
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn the_conversation_resumes_in_the_same_room() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("resume").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let response = w
        .http
        .post(w.url(format!("/v1/workspaces/{ws}/dms")))
        .bearer_auth(&a.token)
        .json(&json!({ "memberId": b.id }))
        .send()
        .await
        .expect("open dm");
    assert!(response.status().is_success(), "open dm");
    let opened: Value = response.json().await.unwrap();
    let dm = Uuid::parse_str(
        opened["id"]
            .as_str()
            .or(opened["channel"]["id"].as_str())
            .expect("dm id"),
    )
    .unwrap();
    let (old, head) = w.say(&b, ws, dm, "옛 글").await;
    let (status, _) = w.leave(&a, ws, dm, json!(head)).await;
    assert_eq!(status, 204);
    let (new, _) = w.say(&b, ws, dm, "새 글").await;
    let (_, text) = w
        .get_text(
            &a.token,
            format!("/v1/workspaces/{ws}/channels/{dm}/messages"),
        )
        .await;
    assert_eq!(
        (ids_in(&text, &[old]), ids_in(&text, &[new])),
        (0, 1),
        "{text}"
    );
    let row = w.read_row(&a, ws, dm).await;
    assert!(
        row["latest_readable_seq"].as_i64().unwrap() >= row["history_from_seq"].as_i64().unwrap(),
        "D18 3a passes once something readable is above the floor: {row}"
    );
    // Writing to the same person again opens the same room.
    let response = w
        .http
        .post(w.url(format!("/v1/workspaces/{ws}/dms")))
        .bearer_auth(&a.token)
        .json(&json!({ "memberId": b.id }))
        .send()
        .await
        .expect("reopen dm");
    let again: Value = response.json().await.unwrap();
    let again = again["id"]
        .as_str()
        .or(again["channel"]["id"].as_str())
        .unwrap()
        .to_lowercase();
    assert_eq!(again, dm.to_string(), "one room per pair");
    let (mine, _) = w.say(&a, ws, dm, "내 새 글").await;
    let (_, text) = w
        .get_text(
            &b.token,
            format!("/v1/workspaces/{ws}/channels/{dm}/messages"),
        )
        .await;
    assert_eq!(
        ids_in(&text, &[old, new, mine]),
        3,
        "one unbroken conversation on the other side"
    );
}

// ---------------------------------------------------------------------------
// 6 — scope
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn leave_answers_by_scope() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("scope").await;
    let other_ws = w.workspace("scope-other").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let c = w.human(ws, "park").await;
    let agent = w.member_row(ws, "agent", "ag").await;

    let unavailable = [
        ("agent dm", w.channel(ws, "dm", None, &[a.id, agent]).await),
        (
            "group key",
            w.channel(ws, "dm", Some("group:"), &[a.id, b.id]).await,
        ),
        (
            "admitted key",
            w.channel(ws, "dm", Some("admitted:"), &[a.id, b.id]).await,
        ),
        (
            "three people",
            w.channel(ws, "dm", None, &[a.id, b.id, c.id]).await,
        ),
        ("no counterpart", w.channel(ws, "dm", None, &[a.id]).await),
    ];
    for (what, ch) in unavailable {
        let (status, body) = w.leave(&a, ws, ch, json!(0)).await;
        assert_eq!(status, 409, "{what}: {body}");
        assert_eq!(
            body["error"]["code"],
            json!("dm_leave_unavailable"),
            "{what}: {body}"
        );
        assert_eq!(w.floor(a.id, ch).await, None, "{what}: nothing written");
    }

    let theirs = w.dm(ws, &b, &c).await;
    let public = w.channel(ws, "public", None, &[a.id, b.id]).await;
    let archived = w.dm(ws, &a, &b).await;
    sqlx::query("UPDATE channel SET archived_at = now() WHERE id = $1")
        .bind(archived)
        .execute(&w.su)
        .await
        .unwrap();
    let left = w.channel(ws, "dm", None, &[a.id, c.id]).await;
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(left)
        .bind(a.id)
        .execute(&w.su)
        .await
        .unwrap();
    let d = w.human(other_ws, "choi").await;
    let e = w.human(other_ws, "jung").await;
    let foreign = w.dm(other_ws, &d, &e).await;
    let not_found: [(&str, String); 6] = [
        ("someone else's dm", theirs.to_string()),
        ("public channel", public.to_string()),
        ("archived dm", archived.to_string()),
        ("dm the caller left", left.to_string()),
        ("unknown id", Uuid::new_v4().to_string()),
        ("other workspace's dm", foreign.to_string()),
    ];
    for (what, ch) in not_found {
        let (status, body) = w.leave(&a, ws, &ch, json!(0)).await;
        assert_eq!(status, 404, "{what}: {body}");
    }
    assert_eq!(w.floor(b.id, theirs).await, None);

    // An agent bearer — even one in the DM — is refused before routing (layer 1).
    let agent_dm = w.channel(ws, "dm", None, &[agent, b.id]).await;
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
    )
    .bind(agent)
    .bind(ws)
    .bind(b.id)
    .execute(&w.su)
    .await
    .expect("seed agent row");
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let agent_token = format!("momo_agent_v1.{ws}.{secret}");
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:read','messages:write','channels:read']::text[], 't5822')",
    )
    .bind(ws)
    .bind(agent)
    .bind(&agent_token)
    .execute(&w.su)
    .await
    .expect("seed agent bearer");
    let agent_person = Person {
        id: agent,
        token: agent_token,
    };
    let (status, body) = w.leave(&agent_person, ws, agent_dm, json!(0)).await;
    assert_eq!(status, 403, "agent bearer: {body}");
    assert_eq!(
        body["error"]["message"],
        json!("agent bearer is not allowed for this route"),
        "refused by the scope table before routing: {body}"
    );
    let (status, _) = w
        .get_text(
            &agent_person.token,
            format!("/v1/workspaces/{ws}/channels/{agent_dm}/messages"),
        )
        .await;
    assert_eq!(status, 200, "control: the same bearer reads elsewhere");

    // The happy path, as a control for the refusals above.
    let ok = w.dm(ws, &a, &c).await;
    let (status, body) = w.leave(&a, ws, ok, json!(0)).await;
    assert_eq!(status, 204, "{body}");
    assert_eq!(w.floor(a.id, ok).await, Some(1));
}

// ---------------------------------------------------------------------------
// 6a — the caller's own things first
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn the_callers_own_items_are_cleared_before_the_floor_moves() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("cleanup").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let dm = w.dm(ws, &a, &b).await;
    let elsewhere = w.channel(ws, "public", None, &[a.id, b.id]).await;
    let (old, _) = w.say(&b, ws, dm, "옛 글").await;
    let (old_root, head) = w.say(&b, ws, dm, "옛 스레드").await;
    let (other_msg, _) = w.say(&b, ws, elsewhere, "다른 방").await;
    for (ch, msg) in [(dm, old), (elsewhere, other_msg)] {
        sqlx::query(
            "INSERT INTO message_reminder (workspace_id, member_id, channel_id, message_id, due_at) \
             VALUES ($1, $2, $3, $4, now() + interval '1 day')",
        )
        .bind(ws)
        .bind(a.id)
        .bind(ch)
        .bind(msg)
        .execute(&w.su)
        .await
        .expect("seed reminder");
    }
    sqlx::query(
        "INSERT INTO thread_follow (workspace_id, channel_id, root_id, member_id, state) \
         VALUES ($1, $2, $3, $4, 'followed')",
    )
    .bind(ws)
    .bind(dm)
    .bind(old_root)
    .bind(a.id)
    .execute(&w.su)
    .await
    .expect("seed follow");
    for (ch, request) in [(dm, Uuid::new_v4()), (elsewhere, Uuid::new_v4())] {
        sqlx::query(
            "INSERT INTO scheduled_message (workspace_id, channel_id, author_member_id, body, send_at, client_request_id) \
             VALUES ($1, $2, $3, '예약', now() + interval '1 day', $4)",
        )
        .bind(ws)
        .bind(ch)
        .bind(a.id)
        .bind(request)
        .execute(&w.su)
        .await
        .expect("seed schedule");
    }
    let mine = "AND member_id = $1 AND channel_id = $2";
    let inbox_before = w
        .count(
            &format!("SELECT count(*) FROM inbox_item WHERE true {mine}"),
            a.id,
            dm,
        )
        .await;
    assert!(
        inbox_before >= 2,
        "the DM put the messages in the inbox (control): {inbox_before}"
    );
    assert_eq!(
        w.count(
            &format!("SELECT count(*) FROM message_reminder WHERE true {mine}"),
            a.id,
            dm
        )
        .await,
        1
    );
    assert_eq!(
        w.count(
            &format!("SELECT count(*) FROM thread_follow WHERE true {mine}"),
            a.id,
            dm
        )
        .await,
        1
    );

    let (status, body) = w.leave(&a, ws, dm, json!(head)).await;
    assert_eq!(status, 204, "{body}");

    for table in ["message_reminder", "thread_follow", "inbox_item"] {
        assert_eq!(
            w.count(
                &format!("SELECT count(*) FROM {table} WHERE true {mine}"),
                a.id,
                dm
            )
            .await,
            0,
            "{table}: the leaver's rows below the floor are gone (row count, not a list)"
        );
    }
    let pending = "SELECT count(*) FROM scheduled_message WHERE author_member_id = $1 AND channel_id = $2 AND status = 'pending'";
    let cancelled = "SELECT count(*) FROM scheduled_message WHERE author_member_id = $1 AND channel_id = $2 AND status = 'cancelled' AND body IS NULL";
    assert_eq!(w.count(pending, a.id, dm).await, 0);
    assert_eq!(
        w.count(cancelled, a.id, dm).await,
        1,
        "this room's schedule is cancelled"
    );
    assert_eq!(
        w.count(pending, a.id, elsewhere).await,
        1,
        "another room's schedule stays"
    );
    assert_eq!(
        w.count(
            "SELECT count(*) FROM message_reminder WHERE member_id = $1 AND channel_id = $2",
            a.id,
            elsewhere
        )
        .await,
        1,
        "another room's reminder stays"
    );
    assert_eq!(
        w.count("SELECT count(*) FROM audit_log WHERE action = 'scheduled_message.cancelled' AND detail::text LIKE '%dm_left%' AND actor_member_id = $1 AND $2::uuid IS NOT NULL", a.id, dm).await,
        1,
        "the cancel is audited with its cause"
    );
}

// ---------------------------------------------------------------------------
// 7 — write paths
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a dedicated real Postgres"]
async fn write_paths_below_the_floor_answer_without_a_500() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("writes").await;
    let a = w.human(ws, "kim").await;
    let b = w.human(ws, "lee").await;
    let dm = w.dm(ws, &a, &b).await;
    let retried = Uuid::new_v4();
    let (status, sent) = w
        .say_with(
            &a,
            ws,
            dm,
            json!({"clientMsgId": retried, "body": "보낸 뒤 응답을 잃은 글"}),
        )
        .await;
    assert_eq!(status, 201, "{sent}");
    let mine = Uuid::parse_str(sent["id"].as_str().unwrap()).unwrap();
    let (theirs, head) = w.say(&b, ws, dm, "상대 옛 글").await;
    let (status, _) = w.leave(&a, ws, dm, json!(head)).await;
    assert_eq!(status, 204);
    let head_before: i64 = w
        .count(
            "SELECT last_seq FROM channel_seq WHERE channel_id = $1 AND $2::uuid IS NOT NULL",
            dm,
            dm,
        )
        .await;

    // The pending send retried after the leave: 409, coded, and the seq bump rolled back.
    let (status, body) = w
        .say_with(
            &a,
            ws,
            dm,
            json!({"clientMsgId": retried, "body": "보낸 뒤 응답을 잃은 글"}),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(
        body["error"]["code"],
        json!("message_before_leave"),
        "{body}"
    );
    assert_eq!(
        w.count(
            "SELECT last_seq FROM channel_seq WHERE channel_id = $1 AND $2::uuid IS NOT NULL",
            dm,
            dm
        )
        .await,
        head_before,
        "no seq was spent"
    );
    // Reply, quote, edit, delete, react, pin on a message below the floor: the unknown-id answer.
    let (status, body) = w
        .say_with(
            &a,
            ws,
            dm,
            json!({"clientMsgId": Uuid::new_v4(), "body": "답글", "rootId": theirs}),
        )
        .await;
    assert_eq!(status, 404, "reply to a root below the floor: {body}");
    let (status, body) = w
        .say_with(
            &a,
            ws,
            dm,
            json!({"clientMsgId": Uuid::new_v4(), "body": "인용", "replyToId": theirs}),
        )
        .await;
    assert!(
        status == 404 || status == 400,
        "quote below the floor is refused, not 500: {status} {body}"
    );
    for (what, method, path, body) in [
        (
            "edit",
            "PATCH",
            format!("/v1/workspaces/{ws}/messages/{mine}"),
            Some(json!({"body": "고침"})),
        ),
        (
            "delete",
            "DELETE",
            format!("/v1/workspaces/{ws}/messages/{mine}"),
            None,
        ),
        (
            "react",
            "PUT",
            format!("/v1/workspaces/{ws}/messages/{theirs}/reactions/%F0%9F%91%8D"),
            None,
        ),
        (
            "pin",
            "PUT",
            format!("/v1/workspaces/{ws}/messages/{theirs}/pin"),
            None,
        ),
    ] {
        let mut request = match method {
            "PATCH" => w.http.patch(w.url(path)),
            "DELETE" => w.http.delete(w.url(path)),
            _ => w.http.put(w.url(path)),
        }
        .bearer_auth(&a.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.expect(what);
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        assert_eq!(
            status, 404,
            "{what} below the floor is the unknown-id answer: {text}"
        );
    }
    // The other participant replies to the old root: the leaver sees the reply, not the root.
    let (status, reply) = w
        .say_with(&b, ws, dm, json!({"clientMsgId": Uuid::new_v4(), "body": "옛 글에 단 새 답글", "rootId": theirs, "alsoInChannel": true}))
        .await;
    assert_eq!(status, 201, "{reply}");
    let reply_id = Uuid::parse_str(reply["id"].as_str().unwrap()).unwrap();
    let (status, text) = w
        .get_text(
            &a.token,
            format!("/v1/workspaces/{ws}/channels/{dm}/messages"),
        )
        .await;
    assert_eq!(status, 200, "{text}");
    assert_eq!(
        (ids_in(&text, &[reply_id]), ids_in(&text, &[mine])),
        (1, 0),
        "{text}"
    );
    // The leaver can write again; every trigger on the send runs as the leaver.
    let (status, body) = w
        .say_with(
            &a,
            ws,
            dm,
            json!({"clientMsgId": Uuid::new_v4(), "body": "다시 씀"}),
        )
        .await;
    assert_eq!(status, 201, "{body}");
}
