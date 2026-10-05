//! #3505 — the end-to-end run of ADR-0197 M2: the real router (flag on, `momo_app` test DB) ↔ the
//! real `momo-box-runner` binary ↔ real Docker. Creates, starts, stops, restarts and deletes a
//! box built from the runner's own image with the hardened template, checks what Docker actually
//! holds (not what the runner says), reconciles an orphan volume, and checks nothing is left.
//!
//! Not part of the normal PG suite: it needs Docker, a built runner binary and the box image, so it
//! is `#[ignore]` and driven by `infra/personal-box/verify-m2.sh`, which sets
//!
//! ```text
//! MOMO_M2_E2E_IMAGE     the box image id (build-image.sh prints it)
//! MOMO_M2_E2E_RUNNER    path to the built momo-box-runner binary
//! MOMO_M2_E2E_NETWORK   a pre-created icc=false docker network (verify-m2.sh makes `momo-m2-net`)
//! ```
//!
//! Every docker object it makes is named `momo-m2-*`; nothing else is touched.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::{
    AgentGatewayMode, AgentGatewaySettings, AgentPortConfig, SettingsConfig,
};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "cloud-box-runner-e2e-signing-secret";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated PostgreSQL 18 URL")
}

fn required_pg_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name} for the isolated PG"))
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
        .max_connections(16)
        .connect_with(options.username("momo_app").password(
            &std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".into()),
        ))
        .await
        .expect("connect as momo_app after bootstrap_roles.sql")
}

fn resolve_psql() -> PathBuf {
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths) {
            let candidate = directory.join("psql");
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
    panic!("psql client not found");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema mutex");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .args([
            "-h",
            &required_pg_env("PGHOST"),
            "-p",
            &required_pg_env("PGPORT"),
            "-U",
            &required_pg_env("PGUSER"),
            "-d",
        ])
        .arg(required_pg_env("PGDATABASE"))
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .env("PGPASSWORD", required_pg_env("PGPASSWORD"))
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

async fn insert_human(pool: &PgPool, workspace: Uuid, name: &str, role: &str) -> (Uuid, String) {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human',$3,$4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(name)
    .bind(format!("h-{}", id.simple()))
    .execute(pool)
    .await
    .expect("human member");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(id)
    .bind(workspace)
    .bind(format!("{id}@cb.test"))
    .execute(pool)
    .await
    .expect("human identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) \
         VALUES($1,$2,$3::text::membership_role)",
    )
    .bind(workspace)
    .bind(id)
    .bind(role)
    .execute(pool)
    .await
    .expect("human membership");
    let jwt = momo_auth::sign_access(id, workspace, &[], TEST_JWT_SECRET)
        .expect("sign")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'cb-conformance')",
    )
    .bind(workspace)
    .bind(id)
    .bind(&jwt)
    .execute(pool)
    .await
    .expect("session token");
    (id, jwt)
}

async fn call(
    client: &reqwest::Client,
    method: &str,
    url: String,
    jwt: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let mut request = match method {
        "GET" => client.get(url),
        _ => client.post(url),
    }
    .bearer_auth(jwt);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.expect("request");
    let status = response.status().as_u16();
    let text = response.text().await.expect("body");
    let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    (status, value)
}

use momo_server::config::RateLimitConfig;

struct World {
    workspace: Uuid,
    operator: Uuid,
    operator_jwt: String,
    plain_admin_jwt: String,
    m: Uuid,
    m_jwt: String,
}

async fn seed_world(pool: &PgPool) -> World {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("cbr-{}", workspace.simple()))
        .execute(pool)
        .await
        .expect("workspace");
    let (operator, operator_jwt) = insert_human(pool, workspace, "운영자", "owner").await;
    let (_a, plain_admin_jwt) = insert_human(pool, workspace, "관리자", "admin").await;
    let (m, m_jwt) = insert_human(pool, workspace, "엠", "member").await;
    World {
        workspace,
        operator,
        operator_jwt,
        plain_admin_jwt,
        m,
        m_jwt,
    }
}

/// `operators` are the listed instance operators' member ids (their fixture email is `<id>@cb.test`).
async fn start_server(
    pool: PgPool,
    enabled: Option<bool>,
    operators: &[Uuid],
    rate: Option<RateLimitConfig>,
) -> String {
    let mut state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_settings(SettingsConfig {
        provider_link_master_key: None,
        env_provider: momo_settings::ProviderConfig::default(),
        platform_admin_emails: operators.iter().map(|id| format!("{id}@cb.test")).collect(),
        environment: "local".to_string(),
    })
    .with_agent_gateway(AgentGatewaySettings {
        mode: AgentGatewayMode::Gateway,
        secret: "cloud-box-gateway-secret".to_string(),
        allow_legacy_secret: false,
    })
    .with_agent_port(AgentPortConfig {
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        ..AgentPortConfig::default()
    })
    .with_rate_limit(rate.unwrap_or(RateLimitConfig {
        claim_per_ip_limit: 0,
        ..RateLimitConfig::default()
    }));
    if let Some(enabled) = enabled {
        state = state.with_cloud_box(momo_server::config::CloudBoxConfig { enabled });
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

fn runners_url(base: &str, ws: Uuid, tail: &str) -> String {
    format!("{base}/v1/workspaces/{ws}/cloud-box-runners{tail}")
}

fn runner_url(base: &str, ws: Uuid, tail: &str) -> String {
    format!("{base}/v1/workspaces/{ws}/cloud-box-runner{tail}")
}

fn boxes_url(base: &str, ws: Uuid, tail: &str) -> String {
    format!("{base}/v1/workspaces/{ws}/cloud-boxes{tail}")
}

fn error_code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or("")
}

/// Register a runner through the operator route and return (runner id, credential).
async fn register_runner(
    client: &reqwest::Client,
    base: &str,
    w: &World,
    name: &str,
) -> (Uuid, String) {
    let (status, body) = call(
        client,
        "POST",
        runners_url(base, w.workspace, ""),
        &w.operator_jwt,
        Some(json!({ "name": name })),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    (
        Uuid::parse_str(body["runner"]["id"].as_str().expect("runner id")).expect("uuid"),
        body["credential"].as_str().expect("credential").to_string(),
    )
}

/// The owner creates a box; returns its id.
async fn create_box(client: &reqwest::Client, base: &str, w: &World) -> Uuid {
    let (status, body) = call(
        client,
        "POST",
        boxes_url(base, w.workspace, ""),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 201, "{body}");
    Uuid::parse_str(body["id"].as_str().expect("box id")).expect("uuid")
}

const PREFIX: &str = "momo-m2-";

fn docker(args: &[&str]) -> (bool, String) {
    let output = Command::new("docker").args(args).output().expect("docker");
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
    )
}

fn inspect(name: &str, format: &str) -> String {
    let (ok, out) = docker(&["inspect", "--format", format, name]);
    assert!(ok, "docker inspect {name} failed");
    out
}

fn container_exists(name: &str) -> bool {
    docker(&[
        "ps",
        "-a",
        "--filter",
        &format!("name=^{name}$"),
        "--format",
        "{{.Names}}",
    ])
    .1 == name
}

fn volume_exists(name: &str) -> bool {
    docker(&[
        "volume",
        "ls",
        "--filter",
        &format!("name=^{name}$"),
        "--format",
        "{{.Name}}",
    ])
    .1 == name
}

fn leftovers() -> Vec<String> {
    let mut found = Vec::new();
    for (args, kind) in [
        (vec!["ps", "-a", "--format", "{{.Names}}"], "container"),
        (vec!["volume", "ls", "--format", "{{.Name}}"], "volume"),
    ] {
        for name in docker(&args)
            .1
            .lines()
            .filter(|n| n.starts_with(PREFIX) && *n != "momo-m2-net" && *n != "momo-m2-pg")
        {
            found.push(format!("{kind}:{name}"));
        }
    }
    found
}

fn remove_all_e2e_objects() {
    for line in leftovers() {
        let (kind, name) = line.split_once(':').expect("kind:name");
        if kind == "container" {
            docker(&["rm", "-f", name]);
        } else {
            docker(&["volume", "rm", "-f", name]);
        }
    }
}

async fn wait_for<F: FnMut() -> bool>(what: &str, seconds: u64, mut condition: F) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(seconds);
    while std::time::Instant::now() < deadline {
        if condition() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn mine_state(client: &reqwest::Client, base: &str, ws: Uuid, jwt: &str) -> Option<String> {
    let (status, body) = call(client, "GET", boxes_url(base, ws, "/mine"), jwt, None).await;
    assert_eq!(status, 200, "{body}");
    body["box"]["state"].as_str().map(str::to_string)
}

async fn wait_state(client: &reqwest::Client, base: &str, ws: Uuid, jwt: &str, want: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
    let mut last = None;
    while std::time::Instant::now() < deadline {
        last = mine_state(client, base, ws, jwt).await;
        if last.as_deref() == Some(want) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    }
    panic!("the box never reached {want} (last: {last:?})");
}

struct RunnerProcess(Option<std::process::Child>);

impl RunnerProcess {
    fn stop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for RunnerProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_runner(bin: &str, config: &std::path::Path, log: &std::path::Path) -> RunnerProcess {
    let log = std::fs::File::create(log).expect("runner log");
    RunnerProcess(Some(
        Command::new(bin)
            .arg("run")
            .env("MOMO_BOX_RUNNER_CONFIG", config)
            .env("RUST_LOG", "info")
            .stdout(log.try_clone().expect("clone"))
            .stderr(log)
            .spawn()
            .expect("spawn the runner"),
    ))
}

/// Removes every `momo-m2-*` docker object this test made, pass or fail.
struct Cleanup;

impl Drop for Cleanup {
    fn drop(&mut self) {
        remove_all_e2e_objects();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Docker, the built runner and the box image (infra/personal-box/verify-m2.sh)"]
async fn the_runner_creates_starts_stops_and_deletes_a_real_hardened_box() {
    let image = std::env::var("MOMO_M2_E2E_IMAGE").expect("MOMO_M2_E2E_IMAGE (build-image.sh)");
    let runner_bin = std::env::var("MOMO_M2_E2E_RUNNER").expect("MOMO_M2_E2E_RUNNER");
    let network = std::env::var("MOMO_M2_E2E_NETWORK").expect("MOMO_M2_E2E_NETWORK");
    assert!(
        leftovers().is_empty(),
        "momo-m2-* docker objects exist before the run: {:?}",
        leftovers()
    );

    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = seed_world(&su).await;
    let n = {
        // a second member, so two boxes live next to one orphan (a 1-of-3 orphan is not "too many")
        let (id, jwt) = insert_human(&su, w.workspace, "엔", "member").await;
        (id, jwt)
    };
    let base = start_server(app.clone(), Some(true), &[w.operator], None).await;
    let client = reqwest::Client::new();

    // --- operator registers the runner; its credential goes into a 0600 file; the config is the runner's own.
    let (_runner_id, credential) = register_runner(&client, &base, &w, "e2e-runner").await;
    let dir = std::env::temp_dir().join(format!("momo-m2-e2e-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("dir");
    let credential_file = dir.join("credential");
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&credential_file)
            .expect("credential file");
        writeln!(file, "{credential}").expect("write");
    }
    let state_dir = dir.join("state");
    let config_path = dir.join("runner.json");
    std::fs::write(
        &config_path,
        json!({
            "serverUrl": base,
            "allowInsecureLoopback": true,
            "workspaceId": w.workspace,
            "credentialFile": credential_file,
            "image": image,
            "namePrefix": PREFIX,
            "network": network,
            "diskQuota": "unenforced-dev",
            "stateDir": state_dir,
            "pollIntervalSeconds": 1,
            "reconcileIntervalSeconds": 2,
        })
        .to_string(),
    )
    .expect("config");
    let log = dir.join("runner.log");
    let mut runner = spawn_runner(&runner_bin, &config_path, &log);

    // --- the owner creates a box; the runner builds it.
    let box_a = create_box(&client, &base, &w).await;
    wait_state(&client, &base, w.workspace, &w.m_jwt, "running").await;
    let name_a = format!("{PREFIX}{box_a}");
    assert!(container_exists(&name_a) && volume_exists(&name_a));

    // What Docker actually holds, not what the runner said.
    let fmt = |f: &str| inspect(&name_a, f);
    assert_eq!(
        fmt("{{.Config.Image}}"),
        image,
        "the box runs the configured image, whatever the server said"
    );
    assert_eq!(fmt("{{.HostConfig.ReadonlyRootfs}}"), "true");
    assert_eq!(fmt("{{.HostConfig.Privileged}}"), "false");
    assert_eq!(fmt("{{json .HostConfig.CapDrop}}"), "[\"ALL\"]");
    let mut cap_add: Vec<String> =
        serde_json::from_str(&fmt("{{json .HostConfig.CapAdd}}")).expect("caps");
    cap_add.sort();
    assert_eq!(
        cap_add,
        ["CAP_SETGID", "CAP_SETUID"],
        "only the two M3 capabilities"
    );
    assert!(fmt("{{json .HostConfig.SecurityOpt}}").contains("no-new-privileges"));
    assert_eq!(fmt("{{.HostConfig.Memory}}"), "2147483648", "2 GB");
    assert_eq!(
        fmt("{{.HostConfig.MemorySwap}}"),
        "2147483648",
        "no swap past the limit"
    );
    assert_eq!(fmt("{{.HostConfig.NanoCpus}}"), "1000000000", "1 vCPU");
    assert_eq!(fmt("{{.HostConfig.PidsLimit}}"), "512");
    assert_eq!(fmt("{{.HostConfig.LogConfig.Type}}"), "none");
    assert_eq!(fmt("{{.HostConfig.NetworkMode}}"), network);
    assert_eq!(
        fmt("{{json .HostConfig.PortBindings}}"),
        "{}",
        "no published ports: no inbound"
    );
    assert_eq!(fmt("{{.HostConfig.RestartPolicy.Name}}"), "no");
    // The box volume is the only (non-tmpfs) mount.
    let mounts: Vec<(String, String, String)> =
        fmt("{{range .Mounts}}{{.Type}} {{.Name}} {{.Destination}}\n{{end}}")
            .lines()
            .map(|l| {
                let mut f = l.split(' ');
                (
                    f.next().unwrap_or("").into(),
                    f.next().unwrap_or("").into(),
                    f.next().unwrap_or("").into(),
                )
            })
            .collect();
    let non_tmpfs: Vec<&(String, String, String)> =
        mounts.iter().filter(|m| m.0 != "tmpfs").collect();
    assert_eq!(non_tmpfs.len(), 1, "{mounts:?}");
    assert_eq!(
        non_tmpfs[0],
        &(
            "volume".to_string(),
            name_a.clone(),
            "/home/box".to_string()
        )
    );
    assert!(!mounts.iter().any(|m| m.0 == "bind"), "{mounts:?}");
    assert!(!fmt("{{json .HostConfig.Binds}}").contains("docker.sock"));
    // The agent runs under its own uid inside, with no capability left.
    let (ok, uid) = docker(&[
        "exec",
        &name_a,
        "sh",
        "-c",
        "grep -m1 '^Uid:' /proc/$(pgrep -x momo-box-agent | head -1)/status | cut -f2",
    ]);
    assert!(
        ok && uid == "10002",
        "the agent runs as uid 10002 (got {uid:?})"
    );
    let (_, cap_eff) = docker(&[
        "exec",
        &name_a,
        "sh",
        "-c",
        "grep -m1 '^CapEff:' /proc/$(pgrep -x momo-box-agent | head -1)/status | cut -f2",
    ]);
    assert_eq!(
        cap_eff, "0000000000000000",
        "the agent dropped every capability after starting its helper"
    );
    // The volume holds the person's work across a stop and a start.
    let (ok, _) = docker(&[
        "exec",
        "--user",
        "10001:10001",
        &name_a,
        "sh",
        "-c",
        "echo e2e-marker > /home/box/marker.txt",
    ]);
    assert!(ok, "the person's uid writes to the volume");

    // --- stop, start.
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, w.workspace, &format!("/{box_a}/stop")),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200);
    wait_for("the container to stop", 60, || {
        inspect(&name_a, "{{.State.Running}}") == "false"
    })
    .await;
    assert!(volume_exists(&name_a), "a stop keeps the volume");
    let (status, _) = call(
        &client,
        "POST",
        boxes_url(&base, w.workspace, &format!("/{box_a}/start")),
        &w.m_jwt,
        None,
    )
    .await;
    assert_eq!(status, 200);
    wait_for("the container to run again", 60, || {
        inspect(&name_a, "{{.State.Running}}") == "true"
    })
    .await;
    let (ok, marker) = docker(&[
        "exec",
        "--user",
        "10001:10001",
        &name_a,
        "cat",
        "/home/box/marker.txt",
    ]);
    assert!(
        ok && marker == "e2e-marker",
        "the volume survived stop/start (got {marker:?})"
    );
    // Controls finished: nothing is left in flight, every control done.
    wait_for("the queue to drain", 30, || {
        let open: i64 = futures_block(
            sqlx::query_scalar(
                "SELECT count(*) FROM cloud_box_control \
                  WHERE workspace_id = $1 AND status IN ('pending','claimed')",
            )
            .bind(w.workspace)
            .fetch_one(&su),
        );
        open == 0
    })
    .await;
    let failed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM cloud_box_control WHERE workspace_id = $1 AND status <> 'done'",
    )
    .bind(w.workspace)
    .fetch_one(&su)
    .await
    .expect("failed controls");
    assert_eq!(failed, 0, "every control this run issued finished ok");

    // --- a second box, and an orphan volume the server has never heard of.
    let (status, created) = call(
        &client,
        "POST",
        boxes_url(&base, w.workspace, ""),
        &n.1,
        None,
    )
    .await;
    assert_eq!(status, 201, "{created}");
    let box_b = Uuid::parse_str(created["id"].as_str().expect("id")).expect("uuid");
    wait_state(&client, &base, w.workspace, &n.1, "running").await;
    let orphan = Uuid::new_v4();
    let orphan_name = format!("{PREFIX}{orphan}");
    let (ok, _) = docker(&[
        "volume",
        "create",
        "--label",
        "io.oort.box=1",
        "--label",
        &format!("io.oort.workspace={}", w.workspace),
        &orphan_name,
    ]);
    assert!(ok);
    wait_for("the orphan to be quarantined", 60, || {
        std::fs::read_to_string(state_dir.join("quarantine.json"))
            .is_ok_and(|text| text.contains(&orphan.to_string()))
    })
    .await;
    assert!(volume_exists(&orphan_name), "quarantine keeps the volume");
    // Live boxes were not disturbed by reconciliation.
    assert_eq!(inspect(&name_a, "{{.State.Running}}"), "true");
    assert_eq!(
        inspect(&format!("{PREFIX}{box_b}"), "{{.State.Running}}"),
        "true"
    );

    // The orphan is not destroyed on its own: not inside the grace period, not unconfirmed.
    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    assert!(
        volume_exists(&orphan_name),
        "destroyed during the grace period"
    );
    // Operator: stop the runner, confirm through the real CLI, age the quarantine past the grace period.
    runner.stop();
    let confirm = Command::new(&runner_bin)
        .args(["confirm-shred", &orphan.to_string()])
        .env("MOMO_BOX_RUNNER_CONFIG", &config_path)
        .output()
        .expect("confirm-shred");
    assert!(
        confirm.status.success(),
        "{}",
        String::from_utf8_lossy(&confirm.stderr)
    );
    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
    let mut runner = spawn_runner(&runner_bin, &config_path, &log);
    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    assert!(
        volume_exists(&orphan_name),
        "destroyed inside the grace period, confirmed or not"
    );
    runner.stop();
    let ledger_path = state_dir.join("quarantine.json");
    let mut ledger: Value =
        serde_json::from_str(&std::fs::read_to_string(&ledger_path).expect("ledger"))
            .expect("json");
    ledger["entries"][orphan.to_string()]["quarantinedAt"] = json!(1_600_000_000_u64);
    std::fs::write(&ledger_path, ledger.to_string()).expect("age the quarantine");
    let mut runner = spawn_runner(&runner_bin, &config_path, &log);
    wait_for("the confirmed, aged orphan to be destroyed", 60, || {
        !volume_exists(&orphan_name)
    })
    .await;
    assert!(
        volume_exists(&name_a) && volume_exists(&format!("{PREFIX}{box_b}")),
        "a live box's volume was destroyed"
    );
    assert_eq!(inspect(&name_a, "{{.State.Running}}"), "true");

    // --- delete both boxes: container and volume are gone, and the server closed them as deleted.
    for (box_id, jwt) in [(box_a, w.m_jwt.clone()), (box_b, n.1.clone())] {
        let (status, body) = call(
            &client,
            "POST",
            boxes_url(&base, w.workspace, &format!("/{box_id}/delete")),
            &jwt,
            None,
        )
        .await;
        assert_eq!(status, 200, "{body}");
    }
    wait_for("both boxes to be deleted", 120, || {
        let states: Vec<String> = futures_block(
            sqlx::query_scalar("SELECT state FROM cloud_box WHERE workspace_id = $1")
                .bind(w.workspace)
                .fetch_all(&su),
        );
        states.len() == 2 && states.iter().all(|s| s == "deleted")
    })
    .await;
    for id in [box_a, box_b] {
        let name = format!("{PREFIX}{id}");
        assert!(
            !container_exists(&name) && !volume_exists(&name),
            "{name} survived its deletion"
        );
    }
    let reports: Vec<(Option<bool>, Option<bool>)> = sqlx::query_as(
        "SELECT container_absent, volume_absent FROM cloud_box_control WHERE workspace_id = $1 AND verb = 'delete' ORDER BY seq",
    )
    .bind(w.workspace)
    .fetch_all(&su)
    .await
    .expect("deletion reports");
    assert_eq!(
        reports,
        vec![(Some(true), Some(true)); 2],
        "the server closed the boxes on the runner's verification report"
    );
    runner.stop();

    // Nothing of this run is left on the host, and the runner's log never carried a credential.
    assert_eq!(leftovers(), Vec::<String>::new());
    let log_text = std::fs::read_to_string(&log).expect("log");
    assert!(
        !log_text.contains(&credential) && !log_text.contains("oort_runner."),
        "the runner logged its credential"
    );
    std::fs::remove_dir_all(&dir).ok();
    remove_all_e2e_objects();
}

fn futures_block<T>(future: impl std::future::Future<Output = Result<T, sqlx::Error>>) -> T {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(future))
        .expect("query")
}
