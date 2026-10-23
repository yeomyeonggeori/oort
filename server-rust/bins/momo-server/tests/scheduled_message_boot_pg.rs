//! #4214 / ADR-0208 — the real `momo-server` binary, booted.
//!
//! Every other scheduled-message test drives `run_tick` or the router **in process**, which leaves
//! the wiring in `main.rs` — the second connection pool, `scheduler::start`, the stop signal, the
//! wait at shutdown — compile-checked and nothing more. This suite starts the actual binary
//! (`CARGO_BIN_EXE_momo-server`) against a real Postgres, with a scrubbed environment, and watches
//! what an operator would watch: the log, the rows, the HTTP answers, and the exit on SIGTERM.
//!
//! | test | what it keeps | revert that makes it red |
//! |---|---|---|
//! | `a_booted_server_sends_a_due_schedule_and_stops_cleanly_on_sigterm` | the tick runs in the api process and ends with it | `main.rs` stops calling `scheduler::start`, or drops the stop sender / never sends the stop signal |
//! | `a_server_booted_with_the_scheduler_off_neither_sends_nor_accepts` | `MOMO_SCHEDULER_ENABLED=0` travels env → config → state → routes | the env key is not read, or the routes ignore `enabled` |
//! | `a_server_booted_on_a_role_that_skips_rls_refuses_to_send_and_to_accept` | no BYPASSRLS write path, and no schedule is accepted that will not be sent | the role guard is dropped from `scheduler::start`, or `scheduler_blocked` is not read by the routes |
//!
//! `#[ignore]` — needs a real PG18 superuser DB plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:24214/momo \
//!   cargo test -p momo-server --test scheduled_message_boot_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

use std::fs::File;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use serde_json::{json, Value};
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const PASSWORD: &str = "scheduled-boot-test-password";

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
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../infra/rust/sql/bootstrap_roles.sql");
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

/// A superuser pool onto a table that holds **no** schedule: a booted server's tick looks at the
/// due rows of every tenant, so a row another test left behind would be sent (or not) by this
/// test's server and make its counts lie.
async fn superuser_pool() -> PgPool {
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect as superuser");
    sqlx::query("DELETE FROM scheduled_message")
        .execute(&pool)
        .await
        .expect("start from an empty schedule table");
    pool
}

/// `DATABASE_URL` with its user and password swapped for a runtime role's.
fn url_as(user: &str, password: &str) -> String {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    format!(
        "postgres://{user}:{password}@{}:{}/{}",
        options.get_host(),
        options.get_port(),
        options.get_database().unwrap_or("momo")
    )
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

struct Fixture {
    workspace: Uuid,
    member: Uuid,
    email: String,
    channel: Uuid,
}

async fn seed(su: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    let member = Uuid::new_v4();
    let channel = Uuid::new_v4();
    let email = format!("{member}@boot.test");
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("boot-{workspace}"))
        .execute(su)
        .await
        .expect("workspace");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', 'boot', $3)",
    )
    .bind(member)
    .bind(workspace)
    .bind(format!("boot-{}", &member.simple().to_string()[..8]))
    .execute(su)
    .await
    .expect("member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(member)
    .bind(workspace)
    .bind(&email)
    .bind(PASSWORD)
    .execute(su)
    .await
    .expect("human");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("workspace_membership");
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', $3, '', $4)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(format!("boot-{}", &channel.simple().to_string()[..8]))
    .bind(member)
    .execute(su)
    .await
    .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("channel_seq");
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) VALUES ($1, $2, $3, 'member')",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("membership");
    Fixture {
        workspace,
        member,
        email,
        channel,
    }
}

/// A schedule that is already due (two seconds late on the database clock).
async fn insert_due(su: &PgPool, fx: &Fixture, body: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO scheduled_message \
           (id, workspace_id, channel_id, author_member_id, body, send_at, client_request_id) \
         VALUES ($1, $2, $3, $4, $5, now() - interval '2 seconds', $6)",
    )
    .bind(id)
    .bind(fx.workspace)
    .bind(fx.channel)
    .bind(fx.member)
    .bind(body)
    .bind(Uuid::new_v4())
    .execute(su)
    .await
    .expect("seed a due schedule");
    id
}

async fn status_of(su: &PgPool, id: Uuid) -> (String, i32) {
    sqlx::query_as("SELECT status, attempts FROM scheduled_message WHERE id = $1")
        .bind(id)
        .fetch_one(su)
        .await
        .expect("row")
}

async fn wait_for_status(su: &PgPool, id: Uuid, want: &str, within: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < within {
        if status_of(su, id).await.0 == want {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    false
}

// ---------------------------------------------------------------------------
// the binary
// ---------------------------------------------------------------------------

/// A running `momo-server` that is killed (by its own PID, nothing broader) if a test panics.
struct Server {
    child: Child,
    log: PathBuf,
    base: String,
}

impl Server {
    /// Start the binary with a scrubbed environment: nothing but what is named here reaches it.
    fn start(database_url: &str, extra: &[(&str, &str)]) -> Server {
        let port = {
            let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("a free port");
            probe.local_addr().expect("addr").port()
        };
        let log = std::env::temp_dir().join(format!("momo-boot-{}.log", Uuid::new_v4()));
        let sink = File::create(&log).expect("log file");
        let mut command = Command::new(env!("CARGO_BIN_EXE_momo-server"));
        command
            .env_clear()
            .env("HOST", "127.0.0.1")
            .env("PORT", port.to_string())
            .env("DATABASE_URL", database_url)
            .env("JWT_HMAC", "boot-test-jwt-secret-0123456789abcdef")
            .env(
                "WEBHOOK_INGRESS_MASTER_KEY",
                "boot-test-ingress-key-0123456789abcdef",
            )
            .env(
                "OUTBOUND_WEBHOOK_MASTER_KEY",
                "boot-test-outbound-key-0123456789abcdef",
            )
            .env("MOMO_ENV", "local")
            .env("MOMO_SCHEDULER_TICK_MS", "1000")
            .env("RUST_LOG", "info")
            // plain text, so the assertions below read the log as an operator does
            .env("NO_COLOR", "1")
            .stdout(Stdio::from(sink.try_clone().expect("clone log")))
            .stderr(Stdio::from(sink));
        for (key, value) in extra {
            command.env(key, value);
        }
        let child = command.spawn().expect("spawn momo-server");
        Server {
            child,
            log,
            base: format!("http://127.0.0.1:{port}"),
        }
    }

    fn log(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }

    async fn wait_for_log(&mut self, needle: &str, within: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < within {
            if self.log().contains(needle) {
                return true;
            }
            if let Ok(Some(status)) = self.child.try_wait() {
                panic!(
                    "momo-server exited early ({status}) before logging {needle:?}:\n{}",
                    self.log()
                );
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
    }

    async fn ready(&mut self) {
        assert!(
            self.wait_for_log("listening", Duration::from_secs(40))
                .await,
            "the server never listened:\n{}",
            self.log()
        );
    }

    /// SIGTERM, then wait for the process to end on its own. Returns whether it exited 0.
    async fn terminate(&mut self, within: Duration) -> Option<bool> {
        let status = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status()
            .expect("kill -TERM");
        assert!(status.success(), "could not signal pid {}", self.child.id());
        let started = Instant::now();
        while started.elapsed() < within {
            if let Some(exit) = self.child.try_wait().expect("try_wait") {
                return Some(exit.success());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        None
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        let _ = std::fs::remove_file(&self.log);
    }
}

async fn login(http: &reqwest::Client, base: &str, fx: &Fixture) -> String {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": fx.email,
            "password": PASSWORD,
            "workspace": fx.workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status().as_u16(), 200, "the seeded member logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"].as_str().expect("token").to_string()
}

async fn create(http: &reqwest::Client, base: &str, token: &str, fx: &Fixture) -> (u16, Value) {
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/scheduled-messages",
            fx.workspace, fx.channel
        ))
        .bearer_auth(token)
        .json(&json!({
            "body": "booted",
            "sendAtMs": chrono::Utc::now().timestamp_millis() + 3_600_000,
            "clientRequestId": Uuid::new_v4(),
        }))
        .send()
        .await
        .expect("create");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

// ---------------------------------------------------------------------------
// the three boots
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_booted_server_sends_a_due_schedule_and_stops_cleanly_on_sigterm() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fx = seed(&su).await;
    let mut server = Server::start(&url_as("momo_app", "momo_app_dev_pw"), &[]);
    server.ready().await;
    assert!(
        server
            .wait_for_log("scheduled messages tick started", Duration::from_secs(10))
            .await,
        "the api process starts the tick:\n{}",
        server.log()
    );

    // a schedule that is due is sent by the tick of the process that was just booted
    let due = insert_due(&su, &fx, "sent by the booted server").await;
    assert!(
        wait_for_status(&su, due, "sent", Duration::from_secs(20)).await,
        "the booted tick sent the due schedule:\n{}",
        server.log()
    );
    let messages: i64 = sqlx::query_scalar("SELECT count(*) FROM message WHERE client_msg_id = $1")
        .bind(due)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(messages, 1, "exactly one message went out");
    assert!(
        server
            .wait_for_log("scheduled messages tick", Duration::from_secs(5))
            .await
            && server.log().contains("sent=1"),
        "the tick logs what it did (counts, no body):\n{}",
        server.log()
    );
    assert!(
        !server.log().contains("sent by the booted server"),
        "a body never reaches the log"
    );

    // the routes are on, in the same process
    let http = reqwest::Client::new();
    let token = login(&http, &server.base, &fx).await;
    let (status, created) = create(&http, &server.base, &token, &fx).await;
    assert_eq!(status, 201, "{created}");

    // SIGTERM: the server drains and the tick ends with it, inside the 25-second wait main allows
    let exited_cleanly = server.terminate(Duration::from_secs(30)).await;
    assert_eq!(
        exited_cleanly,
        Some(true),
        "the process exits 0 on SIGTERM:\n{}",
        server.log()
    );
    let log = server.log();
    assert!(log.contains("shutdown signal received"), "{log}");
    assert!(log.contains("scheduled messages tick stopped"), "{log}");
    assert!(
        !log.contains("did not stop within 25 seconds"),
        "the stop signal reached the tick; main did not have to give up on it:\n{log}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_server_booted_with_the_scheduler_off_neither_sends_nor_accepts() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fx = seed(&su).await;
    let mut server = Server::start(
        &url_as("momo_app", "momo_app_dev_pw"),
        &[("MOMO_SCHEDULER_ENABLED", "0")],
    );
    server.ready().await;
    assert!(
        server.log().contains("MOMO_SCHEDULER_ENABLED is off"),
        "the boot says the scheduler is off:\n{}",
        server.log()
    );
    assert!(
        !server.log().contains("scheduled messages tick started"),
        "no tick runs:\n{}",
        server.log()
    );

    // a due schedule is left alone — several ticks' worth of time passes
    let due = insert_due(&su, &fx, "must wait").await;
    tokio::time::sleep(Duration::from_millis(3500)).await;
    assert_eq!(
        status_of(&su, due).await,
        ("pending".to_string(), 0),
        "nothing sends while the scheduler is off, and nothing was even attempted"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM message WHERE client_msg_id = $1")
            .bind(due)
            .fetch_one(&su)
            .await
            .unwrap(),
        0
    );

    // …and a new one is refused out loud (503), while listing and deleting still work
    let http = reqwest::Client::new();
    let token = login(&http, &server.base, &fx).await;
    let (status, refused) = create(&http, &server.base, &token, &fx).await;
    assert_eq!(status, 503, "{refused}");
    assert_eq!(refused["error"]["code"], "scheduler_disabled");
    let listed = http
        .get(format!(
            "{}/v1/workspaces/{}/scheduled-messages",
            server.base, fx.workspace
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list");
    assert_eq!(listed.status().as_u16(), 200);
    let deleted = http
        .delete(format!(
            "{}/v1/workspaces/{}/scheduled-messages/{due}",
            server.base, fx.workspace
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("delete");
    assert_eq!(
        deleted.status().as_u16(),
        204,
        "a schedule can still be dropped"
    );

    assert_eq!(
        server.terminate(Duration::from_secs(30)).await,
        Some(true),
        "the process exits 0 on SIGTERM:\n{}",
        server.log()
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_server_booted_on_a_role_that_skips_rls_refuses_to_send_and_to_accept() {
    let _lock = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fx = seed(&su).await;
    // `momo_relay` is BYPASSRLS: the api must never run its write path as such a role
    let mut server = Server::start(&url_as("momo_relay", "momo_relay_dev_pw"), &[]);
    server.ready().await;
    let log = server.log();
    assert!(
        log.contains("scheduled messages are NOT being sent")
            && log.contains("refused its database role"),
        "the boot says why nothing will be sent:\n{log}"
    );
    assert!(!log.contains("scheduled messages tick started"), "{log}");

    let due = insert_due(&su, &fx, "never sent by a BYPASSRLS role").await;
    tokio::time::sleep(Duration::from_millis(3500)).await;
    assert_eq!(
        status_of(&su, due).await,
        ("pending".to_string(), 0),
        "a tick on a role that skips RLS never ran"
    );

    // …and the routes do not take what nothing will send
    let http = reqwest::Client::new();
    let token = login(&http, &server.base, &fx).await;
    let (status, refused) = create(&http, &server.base, &token, &fx).await;
    assert_eq!(status, 503, "{refused}");
    assert_eq!(refused["error"]["code"], "scheduler_disabled");

    assert_eq!(
        server.terminate(Duration::from_secs(30)).await,
        Some(true),
        "the process still exits 0 on SIGTERM:\n{}",
        server.log()
    );
    // leave nothing due behind: the next server to boot on this database would send it
    sqlx::query("DELETE FROM scheduled_message WHERE id = $1")
        .bind(due)
        .execute(&su)
        .await
        .expect("clean up");
}
