//! DB-backed conformance for **#3628** (N4a): the owner's stop for a running
//! work session (`POST …/work-sessions/{id}/kill`, ADR-0198 D4 / 표 N4,
//! ADR-0188 D3, ADR-0146 D-8), against the real router on an isolated PG as
//! `momo_app` (NOBYPASSRLS). The human-control flag is OFF throughout: a kill
//! needs no device signature.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `the_owners_kill_is_one_unsigned_control_and_never_a_message` | write a message / bump `channel_seq` / emit an outbox row, sign the control, drop the audit row, or skip the replay lookup (a second tap writes a second row) |
//! | `many_taps_at_once_make_one_control` | drop the session row lock or the waiting-kill lookup |
//! | `a_teammate_kills_nothing` | drop the `session.member_id != member_id` check, or the host-owner / member-scope check |
//! | `an_agent_bearer_kills_through_this_route_nothing` | add the route to `required_agent_scope` (the handler check is `work_kill::tests`) |
//! | `an_ended_or_missing_session_writes_nothing` | create a control for an ended session, or answer a missing one with anything but 404 |
//! | `a_dead_or_foreign_target_is_refused_by_name` | drop the revoked-host, `local_pty` or session-state refusals |
//! | `an_offline_mac_keeps_the_kill_and_says_so` | refuse an offline host, or lie in `hostOnline` |
//! | `the_owners_kill_is_not_held_back_by_their_own_control_window` | drop the owner-kill exemption in `pending_controls_for_host_in_tx` (or widen it to an agent's kill) |
//! | `patch_ended_does_not_reach_the_mac` | make `PATCH ended` write a control (then this route would be redundant) |
//!
//! `#[ignore]` — needs a real Postgres plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:26628/momo \
//!   cargo test -p momo-server --test work_kill_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::config::DeviceKeySettings;
use momo_server::{build_app, AppState, RealtimeAdvert};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "work-kill-conformance-signing-secret";
const TEST_PASSWORD: &str = "human-control-password";
const INSTANCE_ID: &str = "inst_3628_conformance";
const HOST_SEED: u8 = 77;

// ---------------------------------------------------------------------------
// harness (same shape as work_instruction_conformance_pg.rs)
// ---------------------------------------------------------------------------

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
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
    let password =
        std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password(&password))
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

fn psql_file(path: PathBuf) -> std::process::Output {
    Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .output()
        .expect("spawn psql")
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema lock");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let roles = psql_file(PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    )));
    assert!(
        roles.status.success(),
        "bootstrap_roles.sql failed to apply"
    );
    *ready = true;
}

fn settings(required: bool) -> DeviceKeySettings {
    DeviceKeySettings {
        instance_id: Some(INSTANCE_ID.to_string()),
        host_register_signature_required: false,
        refresh_reuse_sweep_all_sessions: false,
        human_control_signature_required: required,
        ..DeviceKeySettings::default()
    }
}

async fn start_server(settings: DeviceKeySettings) -> String {
    let app = build_app(
        AppState::new(
            momo_app_pool().await,
            TEST_JWT_SECRET.to_string(),
            RealtimeAdvert::SameOrigin,
        )
        .with_device_keys(settings),
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

fn ed25519_host_key(seed: u8) -> String {
    let key = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    BASE64.encode(key.verifying_key().to_bytes())
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let handle = format!("hc-{}", &id.simple().to_string()[..10]);
    let email = format!("{id}@human-control.test");
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

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> String {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({ "email": email, "password": TEST_PASSWORD, "workspace": workspace.to_string() }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status().as_u16(), 200, "seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"].as_str().expect("access").to_string()
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

struct Stage {
    su: PgPool,
    http: reqwest::Client,
    base: String,
    workspace: Uuid,
    person: Uuid,
    access: String,
    other_access: String,
    channel: Uuid,
    host: Uuid,
}

async fn stage() -> Stage {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("kill-{workspace}"))
        .execute(&su)
        .await
        .expect("seed workspace");
    let (person, person_email) = seed_human(&su, workspace, "member").await;
    let (_other, other_email) = seed_human(&su, workspace, "member").await;
    let channel = create_channel(
        &app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("kill-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: person,
        },
    )
    .await
    .expect("create channel")
    .id;
    sqlx::query(
        "INSERT INTO work_tool_profile \
           (workspace_id, tool_key, display_name, launch_template, enabled, created_by, updated_by) \
         VALUES ($1, 'claude', 'claude', $2, true, $3, $3) \
         ON CONFLICT (workspace_id, tool_key) DO UPDATE SET enabled = true",
    )
    .bind(workspace)
    .bind(json!({"command": "never-run", "arguments": []}))
    .bind(person)
    .execute(&su)
    .await
    .expect("seed work tool profile");

    // The flag stays OFF: a kill needs no signature, so it must not need R2.
    let base = start_server(settings(false)).await;
    let http = reqwest::Client::new();
    let access = login(&http, &base, workspace, &person_email).await;
    let other_access = login(&http, &base, workspace, &other_email).await;
    let mut stage = Stage {
        su,
        http,
        base,
        workspace,
        person,
        access,
        other_access,
        channel,
        host: Uuid::nil(),
    };
    stage.host = stage.register_host(&stage.access, HOST_SEED).await;
    stage.host_online(stage.host, true).await;
    stage
}

impl Stage {
    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        bearer: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(bearer);
        let request = match body {
            Some(body) => request.json(&body),
            None => request,
        };
        let response = request.send().await.expect("request");
        let status = response.status().as_u16();
        let text = response.text().await.expect("body");
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn post(&self, path: &str, bearer: &str, body: Value) -> (u16, Value) {
        self.call(reqwest::Method::POST, path, bearer, Some(body))
            .await
    }

    async fn register_host(&self, bearer: &str, seed: u8) -> Uuid {
        let (status, body) = self
            .post(
                &format!("/v1/workspaces/{}/work-hosts", self.workspace),
                bearer,
                json!({ "scope": "member", "type": "workd", "displayName": "맥",
                        "publicKey": ed25519_host_key(seed) }),
            )
            .await;
        assert_eq!(status, 201, "register a member host: {body}");
        Uuid::parse_str(body["workHost"]["id"].as_str().unwrap()).unwrap()
    }

    async fn host_online(&self, host: Uuid, online: bool) {
        sqlx::query(
            "UPDATE work_host SET last_seen_at = CASE WHEN $2 THEN clock_timestamp() \
                                               ELSE clock_timestamp() - interval '1 hour' END \
              WHERE id = $1",
        )
        .bind(host)
        .bind(online)
        .execute(&self.su)
        .await
        .expect("stamp last_seen_at");
    }

    /// A running session on the member host, owned by the person.
    async fn session(&self) -> Uuid {
        let (status, body) = self
            .post(
                &format!("/v1/workspaces/{}/work-sessions", self.workspace),
                &self.access,
                json!({ "channelId": self.channel, "hostId": self.host,
                        "tool": "claude", "label": "n4a session" }),
            )
            .await;
        assert_eq!(status, 201, "the owner opens a session: {body}");
        Uuid::parse_str(body["workSession"]["id"].as_str().expect("id")).unwrap()
    }

    fn kill_path(&self, session: Uuid) -> String {
        format!(
            "/v1/workspaces/{}/work-sessions/{session}/kill",
            self.workspace
        )
    }

    async fn kill(&self, bearer: &str, session: Uuid) -> (u16, Value) {
        self.post(&self.kill_path(session), bearer, json!({})).await
    }

    /// A host-signed request exactly as workd sends it (v2).
    async fn host_request(&self, method: &str, path: &str) -> (u16, Value) {
        let sent_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let request_id = Uuid::new_v4();
        let payload = momo_wire::signing::request_payload(
            method,
            path,
            self.workspace,
            self.host,
            sent_at_ms,
            &momo_wire::signing::sha256_hex(&[]),
            request_id,
        );
        let signature = momo_wire::signing::sign_base64(&[HOST_SEED; 32], &payload).expect("sign");
        let response = self
            .http
            .request(
                reqwest::Method::from_bytes(method.as_bytes()).unwrap(),
                format!("{}{path}", self.base),
            )
            .header("Authorization", format!("MomoHost {}", self.host))
            .header("X-Momo-Work-Host-Sent-At", sent_at_ms.to_string())
            .header("X-Momo-Work-Host-Signature", signature)
            .header("X-Momo-Work-Host-Request-ID", request_id.to_string())
            .send()
            .await
            .expect("host request");
        let status = response.status().as_u16();
        let text = response.text().await.expect("body");
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn poll(&self) -> Vec<Value> {
        let (status, body) = self
            .host_request(
                "GET",
                &format!(
                    "/v1/workspaces/{}/work-hosts/{}/pending-controls",
                    self.workspace, self.host
                ),
            )
            .await;
        assert_eq!(status, 200, "the host polls its own queue: {body}");
        body["workControls"].as_array().cloned().unwrap_or_default()
    }

    async fn count(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sql)
            .bind(self.workspace)
            .fetch_one(&self.su)
            .await
            .expect(sql)
    }

    async fn kill_controls(&self) -> i64 {
        self.count("SELECT count(*) FROM work_control WHERE workspace_id = $1 AND kind = 'kill'")
            .await
    }

    /// Everything the message path would have written.
    async fn message_path(&self) -> (i64, i64, i64) {
        (
            self.count(
                "SELECT COALESCE(sum(last_seq), 0)::bigint FROM channel_seq cs \
                   JOIN channel c ON c.id = cs.channel_id WHERE c.workspace_id = $1",
            )
            .await,
            self.count("SELECT count(*) FROM message WHERE workspace_id = $1")
                .await,
            self.count("SELECT count(*) FROM outbox WHERE workspace_id = $1")
                .await,
        )
    }

    /// The state as the host/sweep would have left it, with the columns
    /// `work_session_lifecycle_ck` pairs with it.
    async fn set_status(&self, session: Uuid, status: &str) {
        let sql = match status {
            "idle" => "UPDATE work_session SET status = 'idle', idle_at = now() WHERE id = $1",
            "ended" => "UPDATE work_session SET status = 'ended', ended_at = now() WHERE id = $1",
            _ => "UPDATE work_session SET status = 'orphaned' WHERE id = $1",
        };
        sqlx::query(sql)
            .bind(session)
            .execute(&self.su)
            .await
            .expect("set status");
    }
}

// ---------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_owners_kill_is_one_unsigned_control_and_never_a_message() {
    let _lock = test_lock().await;
    let s = stage().await;
    let session = s.session().await;
    let before = s.message_path().await;

    let (status, body) = s.kill(&s.access, session).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["replayed"], false);
    assert_eq!(body["hostOnline"], true);
    assert_eq!(body["sessionStatus"], "running");
    assert_eq!(body["workControl"]["kind"], "kill");
    assert_eq!(body["workControl"]["status"], "dispatched");
    assert_eq!(body["workControl"]["payload"], json!({}));
    assert_eq!(
        body["workControl"]["requesterMemberId"],
        json!(s.person.to_string())
    );
    assert_eq!(body["workControl"]["sessionId"], json!(session.to_string()));
    assert_eq!(
        body["workControl"]["targetHostId"],
        json!(s.host.to_string())
    );
    let control = Uuid::parse_str(body["workControl"]["id"].as_str().unwrap()).unwrap();

    // No signature anywhere on it (D-8).
    let (nonce, key, sig, mode): (Option<Uuid>, Option<Uuid>, Option<String>, Option<String>) =
        sqlx::query_as(
            "SELECT human_nonce, device_key_id, human_signature, human_mode \
               FROM work_control WHERE id = $1",
        )
        .bind(control)
        .fetch_one(&s.su)
        .await
        .unwrap();
    assert_eq!((nonce, key, sig, mode), (None, None, None, None));

    // The message path is untouched: no channel_seq bump, no message, no outbox row.
    assert_eq!(
        s.message_path().await,
        before,
        "channel_seq · message · outbox unchanged"
    );

    // Audit, same commit.
    let audit: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = 'work.kill.requested' \
            AND target_id = $2",
    )
    .bind(s.workspace)
    .bind(control)
    .fetch_one(&s.su)
    .await
    .unwrap();
    assert_eq!(audit["work_session_id"], json!(session.to_string()));

    // The Mac's poll carries exactly what workd's `kill` arm acts on.
    let polled = s.poll().await;
    let relayed = polled
        .iter()
        .find(|c| c["id"] == json!(control.to_string()))
        .expect("the kill is delivered to the owner's host");
    assert_eq!(relayed["kind"], "kill");
    assert_eq!(relayed["sessionId"], json!(session.to_string()));
    assert_eq!(relayed["requesterMemberId"], json!(s.person.to_string()));
    assert!(relayed["humanSignature"].is_null());

    // A second tap is the same kill, not a second one.
    let (status, again) = s.kill(&s.access, session).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["replayed"], true);
    assert_eq!(again["workControl"]["id"], body["workControl"]["id"]);
    assert_eq!(s.kill_controls().await, 1);
    assert_eq!(s.message_path().await, before);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn many_taps_at_once_make_one_control() {
    let _lock = test_lock().await;
    let s = stage().await;
    let session = s.session().await;
    let (a, b, c, d, e, f) = tokio::join!(
        s.kill(&s.access, session),
        s.kill(&s.access, session),
        s.kill(&s.access, session),
        s.kill(&s.access, session),
        s.kill(&s.access, session),
        s.kill(&s.access, session),
    );
    let answers = [a, b, c, d, e, f];
    let created = answers.iter().filter(|(status, _)| *status == 201).count();
    let replayed = answers.iter().filter(|(status, _)| *status == 200).count();
    assert_eq!((created, replayed), (1, 5), "{answers:?}");
    assert_eq!(s.kill_controls().await, 1);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_teammate_kills_nothing() {
    let _lock = test_lock().await;
    let s = stage().await;
    let session = s.session().await;
    // The owner's session sitting on a host somebody else registered.
    let foreign = s.register_host(&s.other_access, HOST_SEED + 1).await;
    s.host_online(foreign, true).await;
    let moved = s.session().await;
    sqlx::query("UPDATE work_session SET host_id = $2 WHERE id = $1")
        .bind(moved)
        .bind(foreign)
        .execute(&s.su)
        .await
        .unwrap();
    // A host that is not member-scoped (a shared one).
    let shared = s.session().await;
    sqlx::query("UPDATE work_host SET scope = 'workspace' WHERE id = $1")
        .bind(s.host)
        .execute(&s.su)
        .await
        .unwrap();
    let before = s.message_path().await;
    let code = |body: &Value| {
        body["code"]
            .as_str()
            .or(body["error"]["code"].as_str())
            .map(str::to_string)
    };

    // A room member who is not the session's owner.
    let (status, body) = s.kill(&s.other_access, session).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body).as_deref(), Some("kill_owner_only"));
    let (status, body) = s.kill(&s.access, moved).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body).as_deref(), Some("kill_owner_only"));
    let (status, body) = s.kill(&s.access, shared).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(code(&body).as_deref(), Some("kill_member_host_only"));

    assert_eq!(s.kill_controls().await, 0, "nobody's kill reached a ledger");
    assert_eq!(s.message_path().await, before);
    assert!(s.poll().await.is_empty());
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_agent_bearer_kills_through_this_route_nothing() {
    let _lock = test_lock().await;
    let s = stage().await;
    let session = s.session().await;
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(s.workspace)
    .bind(format!("kill-agent-{}", &agent.simple().to_string()[..6]))
    .execute(&s.su)
    .await
    .unwrap();
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{}.{secret}", s.workspace);
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['work:control','messages:write'], 'n4a-conformance')",
    )
    .bind(s.workspace)
    .bind(agent)
    .bind(&token)
    .execute(&s.su)
    .await
    .unwrap();
    let (status, body) = s.kill(&token, session).await;
    assert!(
        status == 403 || status == 401,
        "an agent bearer is refused: {status} {body}"
    );
    assert_eq!(s.kill_controls().await, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_ended_or_missing_session_writes_nothing() {
    let _lock = test_lock().await;
    let s = stage().await;

    let (status, body) = s.kill(&s.access, Uuid::new_v4()).await;
    assert_eq!(status, 404, "{body}");

    // Ended with no kill ever asked: 200, nothing written, no control.
    let ended = s.session().await;
    s.set_status(ended, "ended").await;
    let before = s.message_path().await;
    let (status, body) = s.kill(&s.access, ended).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["replayed"], true);
    assert_eq!(body["sessionStatus"], "ended");
    assert!(body["workControl"].is_null());
    assert_eq!(s.kill_controls().await, 0);
    assert_eq!(s.message_path().await, before);

    // Killed, then the Mac reports it ended: the same answer carries the kill.
    let killed = s.session().await;
    let (status, first) = s.kill(&s.access, killed).await;
    assert_eq!(status, 201, "{first}");
    s.set_status(killed, "ended").await;
    let (status, after) = s.kill(&s.access, killed).await;
    assert_eq!(status, 200, "{after}");
    assert_eq!(after["workControl"]["id"], first["workControl"]["id"]);
    assert_eq!(s.kill_controls().await, 1);

    // The ended session of somebody else is still not the caller's to touch.
    let (status, _) = s.kill(&s.other_access, ended).await;
    assert_eq!(status, 403);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_dead_or_foreign_target_is_refused_by_name() {
    let _lock = test_lock().await;
    let s = stage().await;

    let orphaned = s.session().await;
    s.set_status(orphaned, "orphaned").await;
    let (status, body) = s.kill(&s.access, orphaned).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(
        body["code"].as_str().or(body["error"]["code"].as_str()),
        Some("work_session_not_running")
    );

    // An idle session still has its agent process: it can be stopped.
    let idle = s.session().await;
    s.set_status(idle, "idle").await;
    let (status, body) = s.kill(&s.access, idle).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["sessionStatus"], "idle");

    // A shared local pane takes no control from anyone (ADR-0190 D4).
    let app_host = {
        let (status, body) = s
            .post(
                &format!("/v1/workspaces/{}/work-hosts", s.workspace),
                &s.access,
                json!({ "scope": "member", "type": "app", "displayName": "앱",
                        "publicKey": ed25519_host_key(HOST_SEED + 2) }),
            )
            .await;
        assert_eq!(status, 201, "{body}");
        Uuid::parse_str(body["workHost"]["id"].as_str().unwrap()).unwrap()
    };
    let (status, body) = s
        .post(
            &format!("/v1/workspaces/{}/work-sessions", s.workspace),
            &s.access,
            json!({ "channelId": s.channel, "hostId": app_host, "tool": "shell",
                    "label": "dev server", "origin": "local_pty", "folderLabel": "momo" }),
        )
        .await;
    assert_eq!(status, 201, "the owner shares their own pane: {body}");
    let local = Uuid::parse_str(body["workSession"]["id"].as_str().unwrap()).unwrap();
    let (status, body) = s.kill(&s.access, local).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(
        body["code"].as_str().or(body["error"]["code"].as_str()),
        Some(momo_t3::work_control::REFUSAL_LOCAL_SESSION_NO_CONTROL)
    );
    assert_eq!(s.kill_controls().await, 1, "only the idle session's");

    // The Mac was revoked: nothing can be delivered to it.
    let doomed = s.session().await;
    sqlx::query("UPDATE work_host SET revoked_at = now() WHERE id = $1")
        .bind(s.host)
        .execute(&s.su)
        .await
        .unwrap();
    let (status, body) = s.kill(&s.access, doomed).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(
        body["code"].as_str().or(body["error"]["code"].as_str()),
        Some("work_host_revoked")
    );
    assert_eq!(s.kill_controls().await, 1);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_offline_mac_keeps_the_kill_and_says_so() {
    let _lock = test_lock().await;
    let s = stage().await;
    let session = s.session().await;
    s.host_online(s.host, false).await;
    let (status, body) = s.kill(&s.access, session).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["hostOnline"], false);
    assert_eq!(body["workControl"]["status"], "dispatched");
    // It waits in the ledger and is handed over when the Mac asks again.
    let polled = s.poll().await;
    assert!(polled.iter().any(|c| c["id"] == body["workControl"]["id"]));
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_owners_kill_is_not_held_back_by_their_own_control_window() {
    let _lock = test_lock().await;
    let s = stage().await;
    let session = s.session().await;

    // The owner holds the keyboard on this session's screen.
    let capability: Uuid = sqlx::query_scalar(
        "INSERT INTO terminal_attach_capability \
           (workspace_id, work_session_id, host_id, owner_member_id, token_hash, \
            expires_at, mode, kind) \
         VALUES ($1, $2, $3, $4, digest($5::text, 'sha256'), \
                 clock_timestamp() + interval '60 seconds', 'controller', 'display') \
         RETURNING id",
    )
    .bind(s.workspace)
    .bind(session)
    .bind(s.host)
    .bind(s.person)
    .bind(Uuid::new_v4().to_string())
    .fetch_one(&s.su)
    .await
    .expect("seed capability");
    sqlx::query(
        "INSERT INTO display_control_window \
           (workspace_id, work_session_id, grantee_member_id, capability_id, lease_expires_at) \
         VALUES ($1, $2, $3, $4, clock_timestamp() + interval '90 seconds')",
    )
    .bind(s.workspace)
    .bind(session)
    .bind(s.person)
    .bind(capability)
    .execute(&s.su)
    .await
    .expect("seed window");

    // An agent's kill for the same session (a row an agent made before the
    // window opened) is still withheld (증보 3 D3).
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(s.workspace)
    .bind(format!("kill-win-{}", &agent.simple().to_string()[..6]))
    .execute(&s.su)
    .await
    .unwrap();
    let agent_kill: Uuid = sqlx::query_scalar(
        "INSERT INTO work_control \
           (workspace_id, channel_id, requester_member_id, target_host_id, session_id, \
            kind, payload, status) \
         VALUES ($1, $2, $3, $4, $5, 'kill', '{}'::jsonb, 'dispatched') RETURNING id",
    )
    .bind(s.workspace)
    .bind(s.channel)
    .bind(agent)
    .bind(s.host)
    .bind(session)
    .fetch_one(&s.su)
    .await
    .expect("seed agent kill");

    let (status, body) = s.kill(&s.access, session).await;
    assert_eq!(status, 201, "{body}");
    let polled = s.poll().await;
    assert!(
        polled.iter().any(|c| c["id"] == body["workControl"]["id"]),
        "the owner's kill is delivered during their own window"
    );
    assert!(
        !polled
            .iter()
            .any(|c| c["id"] == json!(agent_kill.to_string())),
        "an agent's kill stays withheld while a person holds the screen"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn patch_ended_does_not_reach_the_mac() {
    let _lock = test_lock().await;
    let s = stage().await;
    let session = s.session().await;
    let (status, body) = s
        .call(
            reqwest::Method::PATCH,
            &format!("/v1/workspaces/{}/work-sessions/{session}", s.workspace),
            &s.access,
            Some(json!({ "status": "ended" })),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["workSession"]["status"], "ended");
    // The ledger is settled and the host was told nothing: no control row,
    // nothing in its queue. Only `POST …/kill` writes one.
    assert_eq!(
        s.count("SELECT count(*) FROM work_control WHERE workspace_id = $1")
            .await,
        0
    );
    assert!(s.poll().await.is_empty());
}
