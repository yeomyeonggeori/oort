//! #3927 — the lock screen's token is one decision and nothing else (ADR-0204 D6).
//!
//! A locked phone shows [승인] / [거절] on an approval notification. Once Face ID
//! passes, a native handler has no screen, no JS and no way to refresh a session,
//! so it carries a `typ = "push_action"` token minted earlier by
//! `POST /v1/auth/push-action-token`. The middleware confines that token to
//! `POST /v1/workspaces/{ws}/approvals/{approval}/decision` of its own
//! workspace. The decision route keeps every check it has: the token replaces
//! the bearer and adds no authority.
//!
//! Every test drives the real router on an ephemeral port as `momo_app`.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `the_token_approves_and_rejects_through_the_one_route` | drop the `token` row insert in the mint route, or the `NotAccessToken` -> `verify_app_push_action` arm in `require_principal` |
//! | `every_other_route_is_403_and_never_a_query` | add any second entry to `push_action_route_allowed`, or delete the route check in `require_principal` (the "before any query" half is pinned by `an_unrecorded_or_foreign_signed_token_is_401`: an unrecorded token is 403 off the list and 401 on it) |
//! | `method_case_and_shape_tricks_stay_refused` | loosen `push_action_route_allowed` (verb, empty approval segment, `%2F`, the UUID spellings). Routed shapes must be exactly 403; shapes no route matches are exactly 404 (nothing reachable) |
//! | `the_two_narrow_tokens_cannot_stand_in_for_each_other` | let `verify_app_push_fetch`/`verify_app_push_action` accept the other `typ`, or merge the two route lists |
//! | `neither_narrow_token_can_mint_a_successor` | put a mint route on a route list |
//! | `a_session_cannot_pile_up_live_tokens_and_the_two_budgets_are_separate` | drop the live-row cap in the mint route, or count the other label |
//! | `parallel_mints_cannot_walk_past_the_cap` | drop `lock_push_action_mints_in_tx` from the mint route (count-then-insert races) |
//! | `it_is_neither_a_refresh_token_nor_a_logout_credential` | let `verify_app_refresh`/`verify_app_access` accept the typ |
//! | `an_unrecorded_or_foreign_signed_token_is_401` | skip `token_state` for the push-action arm |
//! | `logging_out_ends_the_token` | record the row outside the caller's lineage |
//! | `a_rotation_keeps_it_alive_and_a_spent_session_does_not` | make the token outlive the refresh row (drop `push_action_session_live`) |
//! | `a_password_change_ends_the_token` | stop the real password route from revoking the member's session rows (those sweeps revoke the push_action row itself, so the derived `push_action_session_live` rule is only a second line here — it is pinned by the logout, rotation, access-only-logout and dead-lineage tests) |
//! | `a_refresh_reuse_sweep_ends_the_token` | stop the real reuse sweep from revoking the lineage's session rows (same remark as the password change) |
//! | `a_token_minted_from_a_dead_lineage_is_dead_on_arrival` | make the token outlive the refresh row (drop `push_action_session_live`) — the #2696 gap: an older access token mints into a dead lineage |
//! | `an_access_only_logout_leaves_the_session_and_so_the_token` | (documents the derived-life rule) |
//! | `the_row_is_a_session_row_of_the_callers_lineage` | change the label, kind or lineage the mint route records |
//! | `the_token_adds_no_authority` | skip the channel-membership or role check for a push-action principal |
//! | `a_lock_screen_tap_cannot_decide_what_must_be_opened_in_the_app` | drop the `opens_in_app` refusal in `decide_in_tx`, apply it to approve only, or move it before the membership gate; drop the login handoff from `OPEN_IN_APP_TOOL_NAMES` or the avatar test from the profile update (planner 2026-10-17, #3928) |
//! | `a_decision_replays_idempotently` | key the replay on the credential instead of the decision id |
//! | `the_audit_rows_say_which_door_the_decision_came_through` | drop `stamp_via` at the generic, executor or expiry audit row, or stamp the shared `event` |
//!
//! `#[ignore]` — needs a real Postgres plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test push_action_token_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use momo_auth::{
    sign_push_action, sign_push_fetch, MAX_LIVE_PUSH_ACTION_PER_LINEAGE,
    MAX_LIVE_PUSH_FETCH_PER_LINEAGE, PUSH_ACTION_TTL_SECONDS,
};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::DeviceKeySettings;
use momo_server::{build_app, AppState, RealtimeAdvert};
use serde_json::{json, Value};
use uuid::Uuid;

/// `(kind, label, session_id, expiry is bounded, scopes)` of a recorded token row.
type RecordedRow = (String, String, Option<Uuid>, bool, Vec<String>);

const TEST_JWT_SECRET: &str = "push-action-token-conformance-signing-secret";
const TEST_PASSWORD: &str = "push-action-token-password";
const AGENT_MODEL: &str = "hermes-agent";

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
    /// The workspace owner, a member of `channel`.
    owner: Uuid,
    email: String,
    /// An agent in `channel` — the author of every approval card here.
    agent: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let handle = format!("pat-{}", &id.simple().to_string()[..10]);
    let email = format!("{id}@push-action-token.test");
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

async fn join_channel(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("seed channel membership");
}

async fn world() -> World {
    world_with(DeviceKeySettings::default()).await
}

async fn world_with(device_keys: DeviceKeySettings) -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("pat-{workspace}"))
        .execute(&su)
        .await
        .expect("seed workspace");
    let (owner, email) = seed_human(&su, workspace, "owner").await;
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, dm_key) \
         VALUES ($1, $2, 'public', 'pat', NULL)",
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
    join_channel(&su, workspace, channel, owner).await;

    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', 'pat-agent', 'pat-agent')",
    )
    .bind(agent)
    .bind(workspace)
    .execute(&su)
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
    .execute(&su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(agent)
    .execute(&su)
    .await
    .expect("seed agent workspace membership");
    join_channel(&su, workspace, channel, agent).await;

    let app = build_app(
        AppState::new(
            momo_app_pool().await,
            TEST_JWT_SECRET.to_string(),
            RealtimeAdvert::SameOrigin,
        )
        .with_device_keys(device_keys),
    );
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
        owner,
        email,
        agent,
    }
}

#[derive(Clone)]
struct Session {
    access: String,
    refresh: String,
}

impl World {
    async fn login_as(&self, email: &str, password: &str) -> Session {
        let response = self
            .http
            .post(format!("{}/v1/auth/login", self.base))
            .json(&json!({
                "email": email,
                "password": password,
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

    async fn login(&self) -> Session {
        self.login_as(&self.email, TEST_PASSWORD).await
    }

    /// A workspace member who may or may not be in the approvals' channel.
    async fn add_human(&self, role: &str, in_channel: bool) -> (Uuid, String) {
        let (id, email) = seed_human(&self.su, self.workspace, role).await;
        if in_channel {
            join_channel(&self.su, self.workspace, self.channel, id).await;
        }
        (id, email)
    }

    /// Mint the lock screen's token through the real route.
    async fn mint_action(&self, session: &Session) -> String {
        let response = self
            .http
            .post(format!("{}/v1/auth/push-action-token", self.base))
            .bearer_auth(&session.access)
            .send()
            .await
            .expect("mint push-action");
        assert_eq!(response.status().as_u16(), 200, "a live session can mint");
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .and_then(|value| value.to_str().ok()),
            Some("no-store"),
            "a bearer credential in a body is never cached"
        );
        let body: Value = response.json().await.expect("mint body");
        assert_eq!(body["ttlSeconds"].as_i64(), Some(PUSH_ACTION_TTL_SECONDS));
        assert_eq!(
            body["workspaceId"].as_str(),
            Some(self.workspace.to_string().as_str())
        );
        assert!(body["expiresAtMs"].as_i64().unwrap_or(0) > 0);
        body["token"].as_str().expect("token").to_string()
    }

    /// The extension's token — the OTHER narrow token.
    async fn mint_fetch(&self, session: &Session) -> String {
        let response = self
            .http
            .post(format!("{}/v1/auth/push-fetch-token", self.base))
            .bearer_auth(&session.access)
            .send()
            .await
            .expect("mint push-fetch");
        assert_eq!(response.status().as_u16(), 200, "a live session can mint");
        let body: Value = response.json().await.expect("mint body");
        body["token"].as_str().expect("token").to_string()
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        bearer: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let url = format!("{}{path}", self.base);
        let request = match method {
            "GET" => self.http.get(url),
            "POST" => self.http.post(url),
            "PATCH" => self.http.patch(url),
            "PUT" => self.http.put(url),
            "DELETE" => self.http.delete(url),
            "HEAD" => self.http.head(url),
            other => panic!("unexpected method {other}"),
        }
        .bearer_auth(bearer);
        let request = match body {
            Some(body) => request.json(&body),
            None => request,
        };
        let response = request.send().await.expect("request");
        let status = response.status().as_u16();
        let value = response.json::<Value>().await.unwrap_or(Value::Null);
        (status, value)
    }

    async fn status(&self, method: &str, path: &str, bearer: &str, body: Option<Value>) -> u16 {
        self.send(method, path, bearer, body).await.0
    }

    fn decision_path(&self, approval: Uuid) -> String {
        format!(
            "/v1/workspaces/{}/approvals/{approval}/decision",
            self.workspace
        )
    }

    fn decision_body(approval: Uuid, approve: bool, key: Uuid) -> Value {
        json!({
            "approval_id": approval,
            "approve": approve,
            "client_decision_id": key,
        })
    }

    async fn decide(&self, bearer: &str, approval: Uuid, approve: bool, key: Uuid) -> (u16, Value) {
        self.send(
            "POST",
            &self.decision_path(approval),
            bearer,
            Some(Self::decision_body(approval, approve, key)),
        )
        .await
    }

    /// A pending tool-call approval on a run parked for it — the shape a real
    /// agent turn leaves behind. `expires` is a Postgres interval.
    async fn seed_approval_expiring(&self, expires: &str) -> (Uuid, Uuid) {
        let run: Uuid = sqlx::query_scalar(
            "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status) \
             VALUES ($1, $2, $3, 'awaiting_approval') RETURNING id",
        )
        .bind(self.workspace)
        .bind(self.agent)
        .bind(self.channel)
        .fetch_one(&self.su)
        .await
        .expect("seed parked run");
        let approval: Uuid = sqlx::query_scalar(
            "INSERT INTO approval \
               (workspace_id, run_id, channel_id, requested_by, action_type, payload, \
                status, expires_at) \
             VALUES ($1, $2, $3, $4, 'tool_call', $5, 'pending', now() + $6::interval) \
             RETURNING id",
        )
        .bind(self.workspace)
        .bind(run)
        .bind(self.channel)
        .bind(self.agent)
        // An ordinary tool call: one of the **catalog** that the lock screen may decide. (A tool
        // outside the catalog is an operator's own and is opened in the app — ADR-0204 증보 6
        // D6-2 — so it could not stand for "the ordinary approval" here; it has its own row in
        // `a_lock_screen_tap_cannot_decide_what_must_be_opened_in_the_app`.)
        .bind(json!({"tool_call": {
            "call_id": format!("pat-{run}"),
            "name": "work.session.end",
            "arguments": {},
        }}))
        .bind(expires)
        .fetch_one(&self.su)
        .await
        .expect("seed pending approval");
        (run, approval)
    }

    async fn seed_approval(&self) -> (Uuid, Uuid) {
        self.seed_approval_expiring("1 hour").await
    }

    /// A pending approval of `action_type` with the caller's `payload`, on a run
    /// parked for it. For the kinds the decision route reads from the payload alone
    /// (`opens_in_app`), not for ones that must also execute.
    async fn seed_parked_approval(&self, action_type: &str, payload: Value) -> (Uuid, Uuid) {
        let run: Uuid = sqlx::query_scalar(
            "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status) \
             VALUES ($1, $2, $3, 'awaiting_approval') RETURNING id",
        )
        .bind(self.workspace)
        .bind(self.agent)
        .bind(self.channel)
        .fetch_one(&self.su)
        .await
        .expect("seed parked run");
        let approval: Uuid = sqlx::query_scalar(&format!(
            "INSERT INTO approval \
               (workspace_id, run_id, channel_id, requested_by, action_type, payload, \
                status, expires_at) \
             VALUES ($1, $2, $3, $4, '{action_type}', $5, 'pending', now() + interval '1 hour') \
             RETURNING id"
        ))
        .bind(self.workspace)
        .bind(run)
        .bind(self.channel)
        .bind(self.agent)
        .bind(payload)
        .fetch_one(&self.su)
        .await
        .expect("seed pending approval");
        (run, approval)
    }

    async fn count(&self, table: &str) -> i64 {
        sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {table} WHERE workspace_id = $1"
        ))
        .bind(self.workspace)
        .fetch_one(&self.su)
        .await
        .expect("count rows")
    }

    /// A pending `channel.create` workspace action — executed, not resumed, and
    /// gated on the workspace-admin role.
    async fn seed_channel_create_approval(&self, name: &str) -> (Uuid, Uuid) {
        let run: Uuid = sqlx::query_scalar(
            "INSERT INTO agent_run (workspace_id, agent_member_id, channel_id, status) \
             VALUES ($1, $2, $3, 'awaiting_approval') RETURNING id",
        )
        .bind(self.workspace)
        .bind(self.agent)
        .bind(self.channel)
        .fetch_one(&self.su)
        .await
        .expect("seed parked run");
        // The stored form a real proposal leaves behind: the NORMALISED arguments
        // (`channel_create_args`) plus the pins the decision compares with what
        // the names resolve to now (`ChannelCreate` pins its member ids; there
        // are none here). Anything less and the decision route answers
        // `action_args_invalid` before it ever reaches the gate under test.
        let mut payload = momo_agent::actions::workspace_action_payload(
            momo_agent::actions::ACTION_CHANNEL_CREATE,
            &json!({
                "name": name,
                "kind": "public",
                "topic": null,
                "addProposer": true,
                "memberHandles": [],
            }),
            None,
            self.agent,
        );
        payload["action"]["pins"] = json!({"members": []});
        let approval: Uuid = sqlx::query_scalar(
            "INSERT INTO approval \
               (workspace_id, run_id, channel_id, requested_by, action_type, payload, \
                status, expires_at) \
             VALUES ($1, $2, $3, $4, 'workspace_action', $5, 'pending', \
                     now() + interval '1 hour') \
             RETURNING id",
        )
        .bind(self.workspace)
        .bind(run)
        .bind(self.channel)
        .bind(self.agent)
        .bind(payload)
        .fetch_one(&self.su)
        .await
        .expect("seed pending workspace action");
        (run, approval)
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

    /// `(detail.via, via_token_id)` of every audit row `action` wrote about
    /// `target`.
    async fn audit(&self, action: &str, target: Uuid) -> Vec<(Option<String>, Option<Uuid>)> {
        sqlx::query_as::<_, (Option<String>, Option<Uuid>)>(
            "SELECT detail->>'via', via_token_id FROM audit_log \
              WHERE workspace_id = $1 AND action = $2 AND target_id = $3 \
              ORDER BY created_at",
        )
        .bind(self.workspace)
        .bind(action)
        .bind(target)
        .fetch_all(&self.su)
        .await
        .expect("read audit")
    }

    async fn token_label(&self, id: Uuid) -> String {
        sqlx::query_scalar::<_, String>("SELECT label FROM token WHERE id = $1")
            .bind(id)
            .fetch_one(&self.su)
            .await
            .expect("read token label")
    }

    async fn resume_jobs(&self) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM outbox WHERE workspace_id = $1 AND kind = 'agent_job'",
        )
        .bind(self.workspace)
        .fetch_one(&self.su)
        .await
        .expect("count resume jobs")
    }

    async fn revoke_every_refresh_row(&self) {
        sqlx::query(
            "UPDATE token SET revoked_at = now() WHERE workspace_id = $1 AND label = 'refresh'",
        )
        .bind(self.workspace)
        .execute(&self.su)
        .await
        .expect("revoke refresh rows");
    }

    async fn logout(&self, session: &Session, with_refresh_half: bool) -> u16 {
        let body = if with_refresh_half {
            json!({"refreshToken": session.refresh})
        } else {
            json!({})
        };
        self.http
            .post(format!("{}/v1/auth/logout", self.base))
            .bearer_auth(&session.access)
            .json(&body)
            .send()
            .await
            .expect("logout")
            .status()
            .as_u16()
    }

    async fn rotate(&self, refresh: &str) -> (u16, Value) {
        let response = self
            .http
            .post(format!("{}/v1/auth/refresh", self.base))
            .json(&json!({"refreshToken": refresh}))
            .send()
            .await
            .expect("refresh");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn the_token_approves_and_rejects_through_the_one_route() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let action = w.mint_action(&session).await;

    let (run, approval) = w.seed_approval().await;
    let (status, receipt) = w.decide(&action, approval, true, Uuid::new_v4()).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["status"], "approved");
    assert_eq!(receipt["decidedBy"], w.owner.to_string());
    let (state, decided_by) = w.approval_state(approval).await;
    assert_eq!(state, "approved");
    assert_eq!(decided_by, Some(w.owner), "decided as the person it names");
    assert_eq!(
        w.run_status(run).await,
        "queued",
        "the parked run is released exactly as an in-app approval releases it"
    );
    assert_eq!(w.resume_jobs().await, 1, "one resume job, not zero or two");

    let (run2, approval2) = w.seed_approval().await;
    let (status, receipt) = w.decide(&action, approval2, false, Uuid::new_v4()).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["status"], "rejected");
    assert_eq!(w.approval_state(approval2).await.0, "rejected");
    assert_ne!(
        w.run_status(run2).await,
        "awaiting_approval",
        "a rejection ends the hold too"
    );
}

/// ADR-0204 증보 6 D6-4: the decision answers with the one line a device shows — the lock
/// screen's notification changes into it. Approve and reject carry their own sentence, a second
/// tap carries 「이미 …된 요청이에요 · …」, a replay answers what the first call answered (the line is
/// stored with the receipt), and a refusal carries none: the words of a failure are the device's.
///
/// Revert `with_receipt_line` at any of the three sites (the generic arm, the executed action,
/// the already-decided arm) and the matching assertion goes red.
#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn a_decision_answers_with_the_line_a_device_shows() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let action = w.mint_action(&session).await;

    // A tool approval: approve, the same key again, and a second tap.
    let (_, approval) = w.seed_approval().await;
    let key = Uuid::new_v4();
    let (status, receipt) = w.decide(&action, approval, true, key).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["line"], "✓ 승인했어요 · 「work.session.end」");
    let (status, replay) = w.decide(&action, approval, true, key).await;
    assert_eq!(status, 200, "{replay}");
    assert_eq!(
        replay, receipt,
        "a replay answers the line the first call did"
    );
    let (status, again) = w.decide(&action, approval, true, Uuid::new_v4()).await;
    assert_eq!(status, 409, "{again}");
    assert_eq!(again["status"], "approved");
    assert_eq!(again["line"], "이미 승인된 요청이에요 · 도구 실행");

    // A tool approval: reject, and a second tap on the rejected card.
    let (_, rejected) = w.seed_approval().await;
    let (status, receipt) = w.decide(&action, rejected, false, Uuid::new_v4()).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(
        receipt["line"],
        "도구 실행을 거부했어요 · 「work.session.end」"
    );
    let (status, again) = w.decide(&action, rejected, true, Uuid::new_v4()).await;
    assert_eq!(status, 409, "{again}");
    assert_eq!(again["status"], "rejected");
    assert_eq!(again["line"], "이미 거부된 요청이에요 · 도구 실행");

    // A workspace action that executes: the registry's own words, never an argument.
    let (_, create) = w.seed_channel_create_approval("pat-line-secret-name").await;
    let (status, receipt) = w.decide(&action, create, true, Uuid::new_v4()).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["line"], "✓ 채널을 만들었어요");
    assert!(
        !receipt["line"]
            .as_str()
            .unwrap_or_default()
            .contains("pat-line"),
        "a line says nothing a person typed: {receipt}"
    );
    let (status, again) = w.decide(&action, create, true, Uuid::new_v4()).await;
    assert_eq!(status, 409, "{again}");
    assert_eq!(again["line"], "이미 승인된 요청이에요 · 채널 만들기");
    let (_, reject_create) = w.seed_channel_create_approval("pat-line-rejected").await;
    let (status, receipt) = w
        .decide(&action, reject_create, false, Uuid::new_v4())
        .await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["line"], "채널 만들기를 거부했어요");

    // A refusal carries no line: the lock screen's own tap on an app-only card.
    let (_, opens) = w
        .seed_parked_approval(
            "tool_call",
            json!({"tool_call": {"call_id": "pat-line-open", "name": "github.search_issues"}}),
        )
        .await;
    let (status, refused) = w.decide(&action, opens, true, Uuid::new_v4()).await;
    assert_eq!(status, 403, "{refused}");
    assert_eq!(refused["status"], "opens_in_app");
    assert!(
        refused.get("line").is_none(),
        "a refusal says nothing of the kind: {refused}"
    );
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn every_other_route_is_403_and_never_a_query() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let action = w.mint_action(&session).await;
    let (run, approval) = w.seed_approval().await;
    let ws = w.workspace;
    let ch = w.channel;
    let foreign = Uuid::new_v4();
    let decision_body = World::decision_body(approval, true, Uuid::new_v4());
    let cases: Vec<(&str, String, Option<Value>)> = vec![
        // The same decision through the compatibility route, which names the
        // run instead of the approval: not the one door.
        (
            "POST",
            format!("/v1/agent-runs/{run}/approval-decisions"),
            Some(decision_body.clone()),
        ),
        // The same decision in another tenant.
        (
            "POST",
            format!("/v1/workspaces/{foreign}/approvals/{approval}/decision"),
            Some(decision_body.clone()),
        ),
        // Every neighbour on the approvals surface. (`POST …/approvals` is a path
        // the router knows for GET only: without the route list it would answer
        // 405, so only the middleware can make it 403. A path with NO route at all
        // answers 404 before any middleware runs — nothing to reach, nothing to
        // assert here.)
        ("GET", format!("/v1/workspaces/{ws}/approvals"), None),
        (
            "POST",
            format!("/v1/workspaces/{ws}/approvals"),
            Some(decision_body.clone()),
        ),
        (
            "GET",
            format!("/v1/workspaces/{ws}/approvals/{approval}/avatar-preview?v=x"),
            None,
        ),
        // The write and the reads the full token could make.
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
        // The extension's two reads belong to the OTHER token.
        ("GET", format!("/v1/workspaces/{ws}/roster"), None),
        (
            "GET",
            format!("/v1/workspaces/{ws}/channels/{ch}/messages"),
            None,
        ),
    ];
    for (method, path, body) in cases {
        assert_eq!(
            w.status(method, &path, &action, body).await,
            403,
            "{method} {path} must be refused for the lock-screen token"
        );
    }
    assert_eq!(
        w.approval_state(approval).await.0,
        "pending",
        "none of the refused calls decided anything"
    );
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn method_case_and_shape_tricks_stay_refused() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let action = w.mint_action(&session).await;
    let (_, approval) = w.seed_approval().await;
    let ws = w.workspace;
    let body = World::decision_body(approval, true, Uuid::new_v4());
    for (method, path) in [
        (
            "GET",
            format!("/v1/workspaces/{ws}/approvals/{approval}/decision"),
        ),
        (
            "HEAD",
            format!("/v1/workspaces/{ws}/approvals/{approval}/decision"),
        ),
        (
            "PUT",
            format!("/v1/workspaces/{ws}/approvals/{approval}/decision"),
        ),
        (
            "PATCH",
            format!("/v1/workspaces/{ws}/approvals/{approval}/decision"),
        ),
        (
            "DELETE",
            format!("/v1/workspaces/{ws}/approvals/{approval}/decision"),
        ),
        (
            "POST",
            format!("/v1/workspaces/{ws}/approvals/{approval}/decision/"),
        ),
        (
            "POST",
            format!("/v1/workspaces/{ws}/approvals/{approval}/decision/extra"),
        ),
        (
            "POST",
            format!("/v1/workspaces/{ws}/approvals/{approval}/decisions"),
        ),
        (
            "POST",
            format!("/v1/workspaces/{ws}//approvals/{approval}/decision"),
        ),
        ("POST", format!("/v1/workspaces/{ws}/approvals//decision")),
        (
            "POST",
            format!("/v1/workspaces/{ws}/approvals/{approval}%2Fx/decision"),
        ),
        // Spellings `Uuid::parse_str` takes but the native handler never sends.
        (
            "POST",
            format!(
                "/v1/workspaces/{ws}/approvals/{}/decision",
                approval.simple()
            ),
        ),
        (
            "POST",
            format!("/v1/workspaces/{ws}/approvals/{}/decision", approval.urn()),
        ),
        (
            "POST",
            format!(
                "/v1/workspaces/{}/approvals/{approval}/decision",
                ws.simple()
            ),
        ),
    ] {
        let url = format!("{}{path}", w.base);
        let request = match method {
            "HEAD" => w.http.head(url),
            "GET" => w.http.get(url),
            "PUT" => w.http.put(url).json(&body),
            "PATCH" => w.http.patch(url).json(&body),
            "DELETE" => w.http.delete(url),
            _ => w.http.post(url).json(&body),
        }
        .bearer_auth(&action);
        let response = request.send().await.expect("request");
        // Exact, not a range. A shape the router has a route for reaches the
        // middleware, which answers 403 (every verb: the layer wraps the whole
        // method router). A shape NO route matches (a trailing slash, an extra
        // segment, `decisions`, an empty workspace segment) is a 404 before any
        // middleware runs: nothing is reachable there, so nothing is asserted but
        // that it stays so.
        let unrouted = path.ends_with("/decision/")
            || path.ends_with("/decision/extra")
            || path.ends_with("/decisions")
            || path.contains("//approvals/");
        let expected = if unrouted { 404 } else { 403 };
        assert_eq!(
            response.status().as_u16(),
            expected,
            "{method} {path} must never be served to the lock-screen token"
        );
    }
    assert_eq!(
        w.approval_state(approval).await.0,
        "pending",
        "none of the shape tricks decided anything"
    );
    // And the control: the exact route, with the same token, works.
    let (status, _) = w.decide(&action, approval, true, Uuid::new_v4()).await;
    assert_eq!(status, 200);
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn the_two_narrow_tokens_cannot_stand_in_for_each_other() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let action = w.mint_action(&session).await;
    let fetch = w.mint_fetch(&session).await;
    let (_, approval) = w.seed_approval().await;

    // The extension's token cannot decide...
    let (status, _) = w.decide(&fetch, approval, true, Uuid::new_v4()).await;
    assert_eq!(status, 403, "a push-fetch token is not a push-action token");
    assert_eq!(w.approval_state(approval).await.0, "pending");
    // ...and the lock screen's token cannot read what the extension reads.
    for path in [
        format!("/v1/workspaces/{}/roster", w.workspace),
        format!(
            "/v1/workspaces/{}/channels/{}/messages",
            w.workspace, w.channel
        ),
    ] {
        assert_eq!(w.status("GET", &path, &action, None).await, 403, "{path}");
        assert_eq!(
            w.status("GET", &path, &fetch, None).await,
            200,
            "{path}: the control — the extension's token still reads"
        );
    }
    // The one route each may use, each with its own token.
    let (status, _) = w.decide(&action, approval, true, Uuid::new_v4()).await;
    assert_eq!(status, 200);
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn neither_narrow_token_can_mint_a_successor() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let action = w.mint_action(&session).await;
    let fetch = w.mint_fetch(&session).await;
    for (bearer, name) in [(&action, "push-action"), (&fetch, "push-fetch")] {
        for path in ["/v1/auth/push-action-token", "/v1/auth/push-fetch-token"] {
            assert_eq!(
                w.status("POST", path, bearer, None).await,
                403,
                "the {name} token must not mint at {path} (no self-renewal)"
            );
        }
    }
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn a_session_cannot_pile_up_live_tokens_and_the_two_budgets_are_separate() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let mint = |path: &'static str| {
        let w = &w;
        let access = session.access.clone();
        async move {
            w.http
                .post(format!("{}{path}", w.base))
                .bearer_auth(access)
                .send()
                .await
                .expect("mint")
                .status()
                .as_u16()
        }
    };
    for _ in 0..MAX_LIVE_PUSH_ACTION_PER_LINEAGE {
        assert_eq!(mint("/v1/auth/push-action-token").await, 200);
    }
    assert_eq!(
        mint("/v1/auth/push-action-token").await,
        429,
        "the fifth live push-action token is refused"
    );
    // The extension's budget is its own: a full push-action budget does not
    // starve it, and filling it does not touch the other.
    for _ in 0..MAX_LIVE_PUSH_FETCH_PER_LINEAGE {
        assert_eq!(
            mint("/v1/auth/push-fetch-token").await,
            200,
            "push-fetch rows are not counted against push-action's cap"
        );
    }
    assert_eq!(mint("/v1/auth/push-fetch-token").await, 429);
    assert_eq!(mint("/v1/auth/push-action-token").await, 429);
    let counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT label, count(*) FROM token \
          WHERE workspace_id = $1 AND label IN ('push_action', 'push_fetch') \
          GROUP BY label ORDER BY label",
    )
    .bind(w.workspace)
    .fetch_all(&w.su)
    .await
    .expect("count rows per label");
    assert_eq!(
        counts,
        vec![
            ("push_action".to_string(), MAX_LIVE_PUSH_ACTION_PER_LINEAGE),
            ("push_fetch".to_string(), MAX_LIVE_PUSH_FETCH_PER_LINEAGE),
        ]
    );
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn parallel_mints_cannot_walk_past_the_cap() {
    // Count-then-insert is only a cap if it is atomic per lineage: two mints that
    // both see four live rows must not both insert a fifth. A leaked access token
    // can fire as many parallel mints as it likes; the cap has to hold anyway.
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let attempts = 24usize;
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..attempts {
        let http = w.http.clone();
        let url = format!("{}/v1/auth/push-action-token", w.base);
        let access = session.access.clone();
        tasks.spawn(async move {
            http.post(url)
                .bearer_auth(access)
                .send()
                .await
                .expect("parallel mint")
                .status()
                .as_u16()
        });
    }
    let mut ok = 0usize;
    let mut refused = 0usize;
    while let Some(status) = tasks.join_next().await {
        match status.expect("mint task") {
            200 => ok += 1,
            429 => refused += 1,
            other => panic!("unexpected status {other} from a parallel mint"),
        }
    }
    assert_eq!(
        ok, MAX_LIVE_PUSH_ACTION_PER_LINEAGE as usize,
        "exactly the cap succeeds"
    );
    assert_eq!(refused, attempts - ok, "and every other attempt is refused");
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM token WHERE workspace_id = $1 AND label = 'push_action'",
    )
    .bind(w.workspace)
    .fetch_one(&w.su)
    .await
    .expect("count rows");
    assert_eq!(
        rows, MAX_LIVE_PUSH_ACTION_PER_LINEAGE,
        "and no more rows than the cap"
    );
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn an_access_only_logout_leaves_the_session_and_so_the_token() {
    // Documented, not a hole: without its refresh half a logout does not end the
    // session (it can still rotate), so the lock screen's token lives with it.
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let action = w.mint_action(&session).await;
    assert_eq!(w.logout(&session, false).await, 200);
    let (_, approval) = w.seed_approval().await;
    let (status, _) = w.decide(&action, approval, true, Uuid::new_v4()).await;
    assert_eq!(
        status, 200,
        "the session can still rotate, so the token lives"
    );
    // The rotation half can still end it: revoke the refresh rows the way a
    // removal or a suspension does.
    w.revoke_every_refresh_row().await;
    let (_, approval2) = w.seed_approval().await;
    let (status, _) = w.decide(&action, approval2, true, Uuid::new_v4()).await;
    assert_eq!(status, 401);
    assert_eq!(w.approval_state(approval2).await.0, "pending");
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn it_is_neither_a_refresh_token_nor_a_logout_credential() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let action = w.mint_action(&session).await;
    let (status, _) = w.rotate(&action).await;
    assert_eq!(
        status, 401,
        "a push-action token cannot be spent as a refresh token"
    );
    // Presented as the bearer of a logout, it ends nothing: 401, and the
    // person's real session is untouched.
    assert_eq!(
        w.status("POST", "/v1/auth/logout", &action, None).await,
        401
    );
    let roster = format!("/v1/workspaces/{}/roster", w.workspace);
    assert_eq!(w.status("GET", &roster, &session.access, None).await, 200);
    let (_, approval) = w.seed_approval().await;
    let (status, _) = w.decide(&action, approval, true, Uuid::new_v4()).await;
    assert_eq!(status, 200, "and the token itself was not spent either");
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn an_unrecorded_or_foreign_signed_token_is_401() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    // Signed with the right key but never recorded: the revocation table is the
    // authority, not the signature.
    let unrecorded = sign_push_action(w.owner, w.workspace, TEST_JWT_SECRET)
        .expect("sign")
        .token;
    let (_, approval) = w.seed_approval().await;
    let (status, _) = w.decide(&unrecorded, approval, true, Uuid::new_v4()).await;
    assert_eq!(status, 401, "signature alone is not a credential");
    let foreign = sign_push_action(w.owner, w.workspace, "some-other-secret")
        .expect("sign")
        .token;
    let (status, _) = w.decide(&foreign, approval, true, Uuid::new_v4()).await;
    assert_eq!(status, 401);
    // The route list is judged BEFORE the revocation lookup: the same unrecorded
    // token is a 403 on a route it may never reach and a 401 only on the one it
    // may. (Removing the list check turns this 403 into a 401.)
    assert_eq!(
        w.status(
            "POST",
            &format!(
                "/v1/workspaces/{}/channels/{}/messages",
                w.workspace, w.channel
            ),
            &unrecorded,
            Some(json!({"body": "x"}))
        )
        .await,
        403
    );
    // A refresh token, and an extension token signed the same way, are not this
    // token either.
    let (status, _) = w
        .decide(&session.refresh, approval, true, Uuid::new_v4())
        .await;
    assert_eq!(status, 401);
    let unrecorded_fetch = sign_push_fetch(w.owner, w.workspace, TEST_JWT_SECRET)
        .expect("sign")
        .token;
    let (status, _) = w
        .decide(&unrecorded_fetch, approval, true, Uuid::new_v4())
        .await;
    assert_eq!(
        status, 403,
        "an extension-typed token has no route here at all"
    );
    assert_eq!(w.approval_state(approval).await.0, "pending");
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn logging_out_ends_the_token() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let action = w.mint_action(&session).await;
    let (_, approval) = w.seed_approval().await;
    let (status, _) = w.decide(&action, approval, true, Uuid::new_v4()).await;
    assert_eq!(status, 200);
    assert_eq!(w.logout(&session, true).await, 200);
    let (_, approval2) = w.seed_approval().await;
    let (status, _) = w.decide(&action, approval2, true, Uuid::new_v4()).await;
    assert_eq!(status, 401, "the session ended, so did the token");
    assert_eq!(w.approval_state(approval2).await.0, "pending");
    // And a token cannot be minted from the session that just ended.
    let again = w
        .http
        .post(format!("{}/v1/auth/push-action-token", w.base))
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
    let action = w.mint_action(&session).await;
    let (status, rotated) = w.rotate(&session.refresh).await;
    assert_eq!(status, 200);
    assert!(rotated["accessToken"].is_string());
    let (_, approval) = w.seed_approval().await;
    let (status, _) = w.decide(&action, approval, true, Uuid::new_v4()).await;
    assert_eq!(status, 200, "the lineage rotated, it did not end");
    // The member is removed from the workspace's sessions: every refresh row is
    // revoked, so the token dies with them.
    w.revoke_every_refresh_row().await;
    let (_, approval2) = w.seed_approval().await;
    let (status, _) = w.decide(&action, approval2, true, Uuid::new_v4()).await;
    assert_eq!(status, 401);
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn a_password_change_ends_the_token() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let action = w.mint_action(&session).await;
    let (_, approval) = w.seed_approval().await;
    let (status, _) = w.decide(&action, approval, true, Uuid::new_v4()).await;
    assert_eq!(status, 200);

    let new_password = "push-action-token-password-changed";
    let (status, body) = w
        .send(
            "PATCH",
            &format!("/v1/workspaces/{}/members/me/password", w.workspace),
            &session.access,
            Some(json!({
                "currentPassword": TEST_PASSWORD,
                "newPassword": new_password,
            })),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let (_, approval2) = w.seed_approval().await;
    let (status, _) = w.decide(&action, approval2, true, Uuid::new_v4()).await;
    assert_eq!(
        status, 401,
        "a password change ends every session, and this token"
    );
    assert_eq!(w.approval_state(approval2).await.0, "pending");
    // The person is not locked out: the fresh session the change returned (and a
    // fresh login) can mint a new token and use it.
    let fresh = w.login_as(&w.email, new_password).await;
    let action2 = w.mint_action(&fresh).await;
    let (status, _) = w.decide(&action2, approval2, true, Uuid::new_v4()).await;
    assert_eq!(status, 200);
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn a_refresh_reuse_sweep_ends_the_token() {
    let _guard = test_lock().await;
    // `MOMO_REFRESH_REUSE_SWEEP_ALL_SESSIONS=true`: a password sign-in is swept
    // on a reuse too (a linked phone always is).
    let w = world_with(DeviceKeySettings {
        refresh_reuse_sweep_all_sessions: true,
        ..DeviceKeySettings::default()
    })
    .await;
    let session = w.login().await;
    let action = w.mint_action(&session).await;
    let (status, next) = w.rotate(&session.refresh).await;
    assert_eq!(status, 200);
    let (_, approval) = w.seed_approval().await;
    let (status, _) = w.decide(&action, approval, true, Uuid::new_v4()).await;
    assert_eq!(status, 200, "a rotation inside the lineage ends nothing");

    // The spent refresh token comes back from a second holder, past the grace
    // window: the whole lineage ends.
    let aged = sqlx::query(
        "UPDATE token SET revoked_at = revoked_at - interval '31 seconds' \
          WHERE token_hash = digest($1::text, 'sha256') AND revoked_at IS NOT NULL",
    )
    .bind(&session.refresh)
    .execute(&w.su)
    .await
    .expect("age the spent refresh row")
    .rows_affected();
    assert_eq!(aged, 1, "the presented refresh row was spent");
    let (status, _) = w.rotate(&session.refresh).await;
    assert_eq!(status, 401, "the stale token is a reuse");
    let (status, _) = w
        .rotate(next["refreshToken"].as_str().expect("next refresh"))
        .await;
    assert_eq!(status, 401, "and the reuse ended the lineage");

    let (_, approval2) = w.seed_approval().await;
    let (status, _) = w.decide(&action, approval2, true, Uuid::new_v4()).await;
    assert_eq!(
        status, 401,
        "the reuse sweep ended the lock-screen token too"
    );
    assert_eq!(w.approval_state(approval2).await.0, "pending");
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn a_token_minted_from_a_dead_lineage_is_dead_on_arrival() {
    // #2696 (known): a plain rotation does not revoke the access half it replaces,
    // so an OLDER access token of the same lineage still authenticates for the rest
    // of its 15 minutes after a logout ended the lineage, and
    // `lock_session_for_registration` finds ITS row live. A push registration made
    // that way binds to a dead lineage. This token must not inherit the gap: it
    // lives only while its lineage holds a live refresh row, so whatever the mint
    // route answers, no usable token comes out of a dead lineage.
    let _guard = test_lock().await;
    let w = world().await;
    let first = w.login().await;
    let (status, rotated) = w.rotate(&first.refresh).await;
    assert_eq!(status, 200);
    let second = Session {
        access: rotated["accessToken"].as_str().expect("access").to_string(),
        refresh: rotated["refreshToken"]
            .as_str()
            .expect("refresh")
            .to_string(),
    };
    assert_eq!(w.logout(&second, true).await, 200, "the lineage ends");

    // Is the premise real today? (If #2696 is ever closed this reads 401 and the
    // mint below must be refused too.)
    let roster = format!("/v1/workspaces/{}/roster", w.workspace);
    let older_still_authenticates = w.status("GET", &roster, &first.access, None).await == 200;

    let response = w
        .http
        .post(format!("{}/v1/auth/push-action-token", w.base))
        .bearer_auth(&first.access)
        .send()
        .await
        .expect("mint from the older access token");
    let minted = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    eprintln!(
        "[dead-lineage] older access token still authenticates: {older_still_authenticates}; \
         the mint answered {minted}"
    );
    if !older_still_authenticates {
        assert_eq!(minted, 401, "a dead access token mints nothing: {body}");
        return;
    }
    assert!(
        matches!(minted, 200 | 401),
        "the mint answers 200 (the #2696 gap) or 401 (closed), got {minted}: {body}"
    );
    if minted == 200 {
        let token = body["token"].as_str().expect("a minted token").to_string();
        let (_, approval) = w.seed_approval().await;
        let (decided, receipt) = w.decide(&token, approval, true, Uuid::new_v4()).await;
        assert_eq!(
            decided, 401,
            "a token bound to a dead lineage is refused on arrival: {receipt}"
        );
        assert_eq!(w.approval_state(approval).await.0, "pending");
    }
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn the_row_is_a_session_row_of_the_callers_lineage() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let _action = w.mint_action(&session).await;
    let rows: Vec<RecordedRow> = sqlx::query_as(
        "SELECT kind::text, label, session_id, \
                (expires_at < now() + interval '6 hours 1 minute' \
                 AND expires_at > now() + interval '5 hours 59 minutes') AS bounded, scopes \
           FROM token WHERE workspace_id = $1 AND label = 'push_action'",
    )
    .bind(w.workspace)
    .fetch_all(&w.su)
    .await
    .expect("read the recorded row");
    assert_eq!(rows.len(), 1, "one mint, one row");
    let (kind, label, session_id, bounded, scopes) = &rows[0];
    assert_eq!(kind, "session");
    assert_eq!(label, "push_action");
    assert!(bounded, "the row's expiry is six hours out, to the minute");
    assert_eq!(scopes, &vec!["push:action".to_string()]);
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

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn the_token_adds_no_authority() {
    let _guard = test_lock().await;
    let w = world().await;

    // A workspace member who is NOT in the approval's channel: the membership
    // check stays in force behind the token.
    let (_outsider, outsider_email) = w.add_human("admin", false).await;
    let outsider_session = w.login_as(&outsider_email, TEST_PASSWORD).await;
    let outsider_token = w.mint_action(&outsider_session).await;
    let (_, approval) = w.seed_approval().await;
    let (status, receipt) = w
        .decide(&outsider_token, approval, true, Uuid::new_v4())
        .await;
    assert_eq!(status, 403, "{receipt}");
    assert_eq!(receipt["status"], "forbidden");
    assert_eq!(
        w.approval_state(approval).await,
        ("pending".to_string(), None),
        "a refused decision decided nothing"
    );
    let (status, _) = w
        .decide(&outsider_session.access, approval, true, Uuid::new_v4())
        .await;
    assert_eq!(
        status, 403,
        "the control: their access token is refused the same way"
    );
    assert!(
        w.audit("approval.approved", approval).await.is_empty(),
        "and nothing was audited as an approval"
    );

    // A channel member without the role a workspace action needs: the role check
    // stays in force too (`channel.create` needs a workspace admin).
    let (_member, member_email) = w.add_human("member", true).await;
    let member_session = w.login_as(&member_email, TEST_PASSWORD).await;
    let member_token = w.mint_action(&member_session).await;
    let (_, card) = w.seed_channel_create_approval("pat-not-for-members").await;
    let (status, receipt) = w.decide(&member_token, card, true, Uuid::new_v4()).await;
    assert_eq!(status, 403, "{receipt}");
    assert_eq!(receipt["status"], "role_required");
    assert_eq!(
        w.approval_state(card).await.0,
        "pending",
        "role_required does not consume the approval"
    );
    let made: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM channel WHERE workspace_id = $1 AND name = 'pat-not-for-members'",
    )
    .bind(w.workspace)
    .fetch_one(&w.su)
    .await
    .expect("count channels");
    assert_eq!(made, 0, "the action did not run");

    // The control: the owner's own token does decide it.
    let owner_session = w.login().await;
    let owner_token = w.mint_action(&owner_session).await;
    let (status, receipt) = w.decide(&owner_token, card, true, Uuid::new_v4()).await;
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["status"], "approved");
    let made: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM channel WHERE workspace_id = $1 AND name = 'pat-not-for-members'",
    )
    .bind(w.workspace)
    .fetch_one(&w.su)
    .await
    .expect("count channels");
    assert_eq!(
        made, 1,
        "the owner's token ran the action with the owner's authority"
    );
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn a_lock_screen_tap_cannot_decide_what_must_be_opened_in_the_app() {
    // ADR-0204 D7 on the SERVER side: approvals that mint a value shown once and
    // approvals whose card asks the approver to pick a host — and, by the planner's
    // decision of 2026-10-17, the login handoff and a profile update that changes the
    // avatar — are never decided with the lock screen's credential, approve or reject,
    // whatever the body says. The
    // push category (`momo.approval.open`) is the client's half of the same rule.
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let action = w.mint_action(&session).await;

    let agent_invite = momo_agent::actions::workspace_action_payload(
        momo_agent::actions::ACTION_AGENT_INVITE,
        &json!({}),
        None,
        w.agent,
    );
    let invite_create = momo_agent::actions::workspace_action_payload(
        momo_agent::actions::ACTION_INVITE_CREATE,
        &json!({}),
        None,
        w.agent,
    );
    // A spawn card: it carries the picker's candidate list (empty is still a picker).
    let spawn = json!({
        "tool_call": {"call_id": "pat-spawn", "name": "work.session.spawn", "arguments": {}},
        "execution": {"tool": "codex", "host_candidates": [], "default_host_id": null},
    });
    // Planner decision 2026-10-17 (#3928): the lock screen cannot show what these two
    // ask the approver to look at, so the server refuses them to the lock screen too.
    // The login handoff: which session, and why a person must log in, is read on the card.
    let login_handoff = json!({
        "tool_call": {
            "call_id": "pat-handoff",
            "name": "work.session.login_handoff",
            "arguments": {"session_id": Uuid::new_v4().to_string(), "reason": "로그인이 필요해요"},
        },
    });
    // A profile update that changes the picture: the approver looks at the staged image.
    let avatar_update = momo_agent::actions::workspace_action_payload(
        momo_agent::actions::ACTION_AGENT_PROFILE_UPDATE,
        &json!({"avatar": {"source": "preset", "presetId": "comet"}}),
        None,
        w.agent,
    );
    // ADR-0186 증보 v5 U-e (#4703): a pin card quotes a message the banner cannot show whole.
    // The card names no message that exists — the refusal comes before anything is read.
    let pin = momo_agent::actions::workspace_action_payload(
        momo_agent::actions::ACTION_MESSAGE_PIN,
        &json!({"messageId": Uuid::new_v4().to_string()}),
        None,
        w.agent,
    );
    let unpin = momo_agent::actions::workspace_action_payload(
        momo_agent::actions::ACTION_MESSAGE_UNPIN,
        &json!({"messageId": Uuid::new_v4().to_string()}),
        None,
        w.agent,
    );
    // ADR-0186 증보 v5 U-c (#4704): a card nobody asked for is opened in the app whatever it
    // asks — `channel.create` is otherwise an inline card; here only the origin differs.
    let unasked = {
        let mut payload = momo_agent::actions::workspace_action_payload(
            momo_agent::actions::ACTION_CHANNEL_CREATE,
            &json!({"name": "qa", "kind": "private"}),
            None,
            w.agent,
        );
        payload["origin"] = json!(momo_agent::initiative::APPROVAL_ORIGIN_AGENT_INITIATED);
        payload
    };
    // ADR-0204 증보 6 D6-2, the two rows that changed. A tool the catalog does not carry is an
    // operator's own: the server cannot say what it does can be undone, so it is opened in the
    // app (it used to be decided from the banner).
    let operators_tool = json!({
        "tool_call": {"call_id": "pat-operator", "name": "github.search_issues", "arguments": {}},
    });
    // An agent asking for more channels is a permission: it is opened in the app. The card the
    // server raised in place is the exception and is checked below.
    let channels_asked = momo_agent::actions::workspace_action_payload(
        momo_agent::actions::ACTION_HOSTED_CHANNELS_GRANT,
        &json!({}),
        None,
        w.agent,
    );
    let members_before = w.count("member").await;
    let agents_before = w.count("agent").await;
    let invites_before = w.count("invite_code").await;

    let mut seeded = Vec::new();
    for (label, action_type, payload) in [
        ("agent.invite", "workspace_action", agent_invite),
        ("invite.create", "workspace_action", invite_create),
        ("a spawn card that offers a host", "tool_call", spawn),
        ("the login handoff", "tool_call", login_handoff),
        (
            "a profile update that changes the avatar",
            "workspace_action",
            avatar_update,
        ),
        ("message.pin", "workspace_action", pin),
        ("message.unpin", "workspace_action", unpin),
        ("channel.create raised unasked", "workspace_action", unasked),
        (
            "an operator's own tool (outside the catalog)",
            "tool_call",
            operators_tool,
        ),
        (
            "hosted.channels.grant an agent asked for",
            "workspace_action",
            channels_asked,
        ),
    ] {
        let (_, approval) = w.seed_parked_approval(action_type, payload).await;
        seeded.push((label, approval));
        for approve in [true, false] {
            let (status, receipt) = w.decide(&action, approval, approve, Uuid::new_v4()).await;
            assert_eq!(status, 403, "{label} approve={approve}: {receipt}");
            assert_eq!(receipt["status"], "opens_in_app", "{label}: {receipt}");
            assert!(
                receipt["result"].is_null() && receipt.get("secretOnce").is_none(),
                "{label}: a refusal executes and reveals nothing: {receipt}"
            );
            assert_eq!(
                w.approval_state(approval).await,
                ("pending".to_string(), None),
                "{label} approve={approve}: nothing was decided"
            );
        }
        // The body cannot talk its way past it: a host pick and the secret-delivery
        // flag, the two fields this kind of card reads.
        let (status, receipt) = w
            .send(
                "POST",
                &w.decision_path(approval),
                &action,
                Some(json!({
                    "approval_id": approval,
                    "approve": true,
                    "client_decision_id": Uuid::new_v4(),
                    "host_id": Uuid::new_v4(),
                    "deliver_secret_to_agent": true,
                })),
            )
            .await;
        assert_eq!(status, 403, "{label}: {receipt}");
        assert_eq!(receipt["status"], "opens_in_app", "{label}: {receipt}");
    }
    assert_eq!(
        w.count("member").await,
        members_before,
        "no member was created"
    );
    assert_eq!(
        w.count("agent").await,
        agents_before,
        "no agent was created"
    );
    assert_eq!(
        w.count("invite_code").await,
        invites_before,
        "no invite was minted"
    );

    // The exception, from the route's side: the `hosted.channels.grant` card the server raised in
    // place (a person called the agent in that very channel) is **not** refused to the lock
    // screen. Rejecting is used so the control executes nothing; what is pinned is that the
    // refusal is not `opens_in_app`.
    let mut in_place = momo_agent::actions::workspace_action_payload(
        momo_agent::actions::ACTION_HOSTED_CHANNELS_GRANT,
        &json!({}),
        None,
        w.agent,
    );
    in_place["origin"] = json!(momo_agent::in_place_grant::APPROVAL_ORIGIN_SERVER_IN_PLACE);
    let (_, in_place_approval) = w.seed_parked_approval("workspace_action", in_place).await;
    let (status, receipt) = w
        .decide(&action, in_place_approval, false, Uuid::new_v4())
        .await;
    assert_ne!(
        receipt["status"], "opens_in_app",
        "the in-place channel grant is decided from the lock screen: {receipt}"
    );
    assert_eq!(status, 200, "{receipt}");
    assert_eq!(receipt["status"], "rejected");

    // The refusal sits behind the membership gate: someone outside the approval's
    // channel is told `forbidden`, exactly as with an ordinary token, and learns
    // nothing about what kind of card it is.
    let (_outsider, outsider_email) = w.add_human("admin", false).await;
    let outsider_session = w.login_as(&outsider_email, TEST_PASSWORD).await;
    let outsider_token = w.mint_action(&outsider_session).await;
    let (status, receipt) = w
        .decide(&outsider_token, seeded[0].1, true, Uuid::new_v4())
        .await;
    assert_eq!(
        (status, receipt["status"].as_str()),
        (403, Some("forbidden"))
    );

    // The control: the in-app door is NOT refused by this guard. Rejecting is used
    // so the control executes nothing.
    for (label, approval) in &seeded {
        let (status, receipt) = w
            .decide(&session.access, *approval, false, Uuid::new_v4())
            .await;
        assert_eq!(
            status, 200,
            "{label}: the access token may reject it: {receipt}"
        );
        assert_eq!(receipt["status"], "rejected", "{label}");
    }
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn a_decision_replays_idempotently() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let action = w.mint_action(&session).await;
    let (_, approval) = w.seed_approval().await;
    let key = Uuid::new_v4();

    let (first_status, first) = w.decide(&action, approval, true, key).await;
    assert_eq!(first_status, 200, "{first}");
    // A flaky network: the same tap again, with the same key.
    let (second_status, second) = w.decide(&action, approval, true, key).await;
    assert_eq!(second_status, 200, "{second}");
    assert_eq!(
        first, second,
        "the stored receipt is replayed byte for byte"
    );
    // The app's own retry of the same decision, with its access token, agrees.
    let (third_status, third) = w.decide(&session.access, approval, true, key).await;
    assert_eq!(third_status, 200, "{third}");
    assert_eq!(first, third);
    assert_eq!(w.resume_jobs().await, 1, "three taps, one resume job");
    assert_eq!(
        w.audit("approval.approved", approval).await.len(),
        1,
        "three taps, one audit row"
    );

    // The same key for the opposite decision is a conflict, not a flip.
    let (status, conflict) = w.decide(&action, approval, false, key).await;
    assert_eq!(status, 409, "{conflict}");
    assert_eq!(conflict["status"], "idempotency_conflict");
    // Another key after it was decided answers the stored state.
    let (status, decided) = w.decide(&action, approval, false, Uuid::new_v4()).await;
    assert_eq!(status, 409, "{decided}");
    assert_eq!(decided["status"], "approved");
    assert_eq!(w.approval_state(approval).await.0, "approved");
}

#[tokio::test]
#[ignore = "needs Postgres + runtime roles (DATABASE_URL)"]
async fn the_audit_rows_say_which_door_the_decision_came_through() {
    let _guard = test_lock().await;
    let w = world().await;
    let session = w.login().await;
    let action = w.mint_action(&session).await;
    let action_row: Uuid = sqlx::query_scalar(
        "SELECT id FROM token WHERE workspace_id = $1 AND label = 'push_action'",
    )
    .bind(w.workspace)
    .fetch_one(&w.su)
    .await
    .expect("the minted row");

    // approve, through the lock screen's token
    let (_, approved) = w.seed_approval().await;
    let (status, _) = w.decide(&action, approved, true, Uuid::new_v4()).await;
    assert_eq!(status, 200);
    let rows = w.audit("approval.approved", approved).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0.as_deref(), Some("push_action"), "detail.via");
    assert_eq!(rows[0].1, Some(action_row), "and the exact token row");
    assert_eq!(w.token_label(action_row).await, "push_action");

    // reject, through the lock screen's token
    let (_, rejected) = w.seed_approval().await;
    let (status, _) = w.decide(&action, rejected, false, Uuid::new_v4()).await;
    assert_eq!(status, 200);
    let rows = w.audit("approval.rejected", rejected).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0.as_deref(), Some("push_action"));

    // the same decision made in the app says nothing of the sort
    let (_, in_app) = w.seed_approval().await;
    let (status, _) = w
        .decide(&session.access, in_app, true, Uuid::new_v4())
        .await;
    assert_eq!(status, 200);
    let rows = w.audit("approval.approved", in_app).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, None, "an access token names no `via`");
    let via = rows[0].1.expect("the access token row");
    assert_eq!(w.token_label(via).await, "access");

    // a tap that came too late settles the approval as expired, and still says
    // which door it came through
    let (_, late) = w.seed_approval_expiring("-1 minute").await;
    let (status, receipt) = w.decide(&action, late, true, Uuid::new_v4()).await;
    assert_eq!(status, 409, "{receipt}");
    assert_eq!(receipt["status"], "expired");
    let rows = w.audit("approval.expired", late).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0.as_deref(), Some("push_action"));
    assert_eq!(rows[0].1, Some(action_row));

    // a workspace action is executed in the decision transaction: its decision
    // row (`action.approved`) says so, and the domain row it wrote is tied to the
    // same token row
    let (_, card) = w
        .seed_channel_create_approval("pat-from-the-lock-screen")
        .await;
    let (status, receipt) = w.decide(&action, card, true, Uuid::new_v4()).await;
    assert_eq!(status, 200, "{receipt}");
    let rows = w.audit("action.approved", card).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0.as_deref(), Some("push_action"));
    assert_eq!(rows[0].1, Some(action_row));
    let domain: Vec<(Option<Uuid>,)> = sqlx::query_as(
        "SELECT via_token_id FROM audit_log \
          WHERE workspace_id = $1 AND action = 'channel.created'",
    )
    .bind(w.workspace)
    .fetch_all(&w.su)
    .await
    .expect("read the domain audit");
    assert_eq!(domain.len(), 1);
    assert_eq!(
        domain[0].0,
        Some(action_row),
        "the executor's row names the token too"
    );

    // the stamp is for the audit log only: the broadcast and the resume job are
    // built from the same event and were not told which credential decided
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id = $1 AND payload::text LIKE '%push_action%'",
    )
    .bind(w.workspace)
    .fetch_one(&w.su)
    .await
    .expect("scan outbox payloads");
    assert_eq!(
        leaked, 0,
        "the credential name must not reach the broadcast or the job"
    );
}
