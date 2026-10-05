//! ADR-0197 M4 (#3511) — the end-to-end run against a REAL box container started by the REAL runner binary.
//!
//! ```text
//! this machine: real momo-server router on Postgres (listening on all interfaces)  <--ws-->  owner DEVICE (software P-256)
//! Colima VM:    momo-box-runner (Linux binary, root) --docker--> box container: momo-box-agent (registers, serves) + the person's shell
//! ```
//!
//! Not part of the normal suite: it needs Colima, a built Linux runner and the box image, so it is `#[ignore]` and driven by
//! `infra/personal-box/verify-m4.sh`, which sets
//!
//! ```text
//! MOMO_M4_E2E_IMAGE       the box image id (build-image.sh prints it)
//! MOMO_M4_E2E_RUNNER      path to the Linux momo-box-runner binary (visible to the VM: it lives under $HOME)
//! MOMO_M4_E2E_NETWORK     a pre-created icc=false docker network (`momo-m4-net`)
//! MOMO_M4_E2E_HOST        this machine's address as the VM and the boxes see it
//! MOMO_M4_E2E_KEYS        the VM directory the host mounted nosuid,nodev for the boxes' host keys
//! MOMO_M4_E2E_RUNNER_DIR  the VM directory the runner owns (config, credential, identity, state)
//! MOMO_M4_E2E_WORK        a directory under $HOME for this run's files
//! ```
//!
//! Every docker object it makes is named `momo-m4-*`; nothing else is touched. What the test asserts about Docker it
//! reads back from Docker (`docker inspect`, `docker exec`), not from what the runner says.

use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use momo_blind_pty::session::FrameKind;
use momo_blind_pty::trust::{DeviceList, DeviceListState};
use momo_box_e2e::bench::*;
use momo_wire::human_control::ControlContent;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt as _, BufReader};
use uuid::Uuid;

macro_rules! step {
    ($($arg:tt)*) => { println!("STEP {}", format!($($arg)*)) };
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name} (infra/personal-box/verify-m4.sh does)"))
}

fn run(program: &str, args: &[&str]) -> (bool, String) {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap_or_else(|e| panic!("{program}: {e}"));
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    (output.status.success(), text)
}

/// `docker …` on the Colima daemon (names `momo-m4-*` only: every caller passes one).
fn docker(args: &[&str]) -> (bool, String) {
    run("docker", args)
}

/// A command in the Colima VM.
fn vm(args: &[&str]) -> (bool, String) {
    let mut all = vec!["ssh", "--"];
    all.extend_from_slice(args);
    run("colima", &all)
}

fn vm_sudo(script: &str) -> (bool, String) {
    vm(&["sudo", "sh", "-c", script])
}

async fn eventually<T>(what: &str, timeout: Duration, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(found) = probe() {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn box_state(world: &World, bearer: &str) -> Option<String> {
    let (_, mine) = world.get("/cloud-boxes/mine", bearer).await;
    mine["box"]["state"].as_str().map(str::to_string)
}

async fn wait_state(world: &World, bearer: &str, want: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let state = box_state(world, bearer).await;
        if state.as_deref() == Some(want) {
            return;
        }
        assert!(Instant::now() < deadline, "the box never reached `{want}` (last: {state:?})");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn wait_agent(world: &World, box_id: Uuid, bearer: &str, online: bool, timeout: Duration) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        let (_, bundle) = world.get(&format!("/cloud-boxes/{box_id}/trust-bundle"), bearer).await;
        if bundle["agentOnline"] == online && (!online || !bundle["host"].is_null()) {
            return bundle;
        }
        assert!(
            Instant::now() < deadline,
            "the box-agent never became agentOnline={online}: {bundle}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Colima, the box image, a Linux runner and an isolated PostgreSQL 18 (verify-m4.sh)"]
async fn a_real_box_started_by_the_real_runner_serves_the_blind_relay() {
    let image = env("MOMO_M4_E2E_IMAGE");
    let runner_bin = env("MOMO_M4_E2E_RUNNER");
    let network = env("MOMO_M4_E2E_NETWORK");
    let host = env("MOMO_M4_E2E_HOST");
    let keys = env("MOMO_M4_E2E_KEYS");
    let runner_dir = env("MOMO_M4_E2E_RUNNER_DIR");
    let work = std::path::PathBuf::from(env("MOMO_M4_E2E_WORK"));

    // ---- the server, listening where the VM and the boxes can reach it --------------------------------------------
    step!("server on Postgres, reachable at {host}");
    let world = World::start(&BenchOptions {
        external_host: Some(host.clone()),
        ..BenchOptions::default()
    })
    .await;
    let external = world.external_base.clone();
    let capture = world.capture.clone();

    // ---- the box: created by the owner, first owner list signed by the owner's device ------------------------------
    step!("owner creates the box and its device signs the first owner list");
    let owner_device = world.register_device(&world.owner, "owner mac").await;
    let (status, body) = world.post("/cloud-boxes", &world.owner.access, json!({})).await;
    assert_eq!(status, 201, "{body}");
    let box_id = Uuid::parse_str(body["id"].as_str().unwrap()).unwrap();
    let list = DeviceList::sign(*box_id.as_bytes(), 1, vec![owner_device.public], &owner_device.key);
    let list_bytes = list.to_bytes();
    let letter = world.letter(
        &world.owner,
        &owner_device,
        box_id,
        ControlContent::CloudBoxOwnerList { box_id, list_sha256: &hex_sha256(&list_bytes) },
    );
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;
    let (status, body) = world
        .put(
            &format!("/cloud-boxes/{box_id}/owner-device-list"),
            &world.owner.access,
            json!({ "list": BASE64.encode(&list_bytes), "signature": letter }),
        )
        .await;
    assert_eq!(status, 200, "{body}");

    // ---- the runner: registered by the instance operator, installed in the VM, started as root ----------------------
    step!("the instance operator registers the runner; the Linux runner is installed in the VM");
    let (status, body) = world
        .post("/cloud-box-runners", &world.admin.access, json!({ "name": "momo-m4 e2e runner" }))
        .await;
    assert_eq!(status, 201, "{body}");
    let credential = body["credential"].as_str().unwrap().to_string();
    std::fs::write(work.join("credential"), format!("{credential}\n")).unwrap();
    let config = json!({
        "serverUrl": external,
        "allowInsecureLoopback": true,
        "workspaceId": world.workspace,
        "credentialFile": format!("{runner_dir}/credential"),
        "image": image,
        "namePrefix": "momo-m4-",
        "network": network,
        "diskQuota": "unenforced-dev",
        "stateDir": format!("{runner_dir}/state"),
        "signingKeyFile": format!("{runner_dir}/identity.key"),
        "hostKeyRoot": { "path": keys, "prepare": "runner" },
        "boxServerUrl": external,
        "pollIntervalSeconds": 1,
    });
    std::fs::write(work.join("runner.json"), config.to_string()).unwrap();
    let (ok, out) = vm_sudo(&format!(
        "install -d -m 0700 {runner_dir}/state && install -m 0600 -o root -g root {work}/credential {runner_dir}/credential \
         && install -m 0644 -o root -g root {work}/runner.json {runner_dir}/runner.json \
         && install -m 0755 -o root -g root {runner} {runner_dir}/momo-box-runner",
        work = work.display(),
        runner = runner_bin,
    ));
    assert!(ok, "installing the runner in the VM: {out}");
    let config_env = format!("MOMO_BOX_RUNNER_CONFIG={runner_dir}/runner.json");
    let (ok, out) = vm(&["sudo", "env", &config_env, &format!("{runner_dir}/momo-box-runner"), "init-identity"]);
    assert!(ok, "init-identity: {out}");
    let fingerprint_hex = out
        .lines()
        .find_map(|l| l.strip_prefix("fingerprint="))
        .expect("the runner prints its fingerprint on its console")
        .trim()
        .to_string();
    assert_eq!(fingerprint_hex.len(), 64);
    let runner_fingerprint: [u8; 32] = hex_decode(&fingerprint_hex);

    let runner_log = Arc::new(Mutex::new(String::new()));
    let mut runner = tokio::process::Command::new("colima")
        .args(["ssh", "--", "sudo", "env", &config_env, &format!("{runner_dir}/momo-box-runner"), "run"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("start the runner in the VM");
    for stream in [
        runner.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        runner.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let log = runner_log.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log.lock().unwrap().push_str(&format!("{line}\n"));
            }
        });
    }

    // ---- the box comes up on its own: create → register (MAC) → attest → listen -------------------------------------
    step!("the runner creates the box container; the agent registers, the runner attests, the agent listens");
    wait_state(&world, &world.owner.access, "running", Duration::from_secs(120)).await;
    let bundle = wait_agent(&world, box_id, &world.owner.access, true, Duration::from_secs(120)).await;
    let host_key_first = bundle["host"]["publicKey"].clone();
    let name = format!("momo-m4-{box_id}");

    step!("what Docker really holds: mounts, read-only root, no secrets in the environment");
    let (ok, inspect) = docker(&["inspect", &name]);
    assert!(ok, "{inspect}");
    let inspect: Value = serde_json::from_str(&inspect).unwrap();
    let info = &inspect[0];
    assert_eq!(info["State"]["Running"], true);
    assert_eq!(info["HostConfig"]["ReadonlyRootfs"], true);
    let mounts = info["Mounts"].as_array().unwrap();
    let mut seen: Vec<(String, String, bool)> = mounts
        .iter()
        .map(|m| {
            (
                m["Type"].as_str().unwrap().to_string(),
                m["Destination"].as_str().unwrap().to_string(),
                m["RW"].as_bool().unwrap(),
            )
        })
        .collect();
    seen.sort();
    assert_eq!(
        seen,
        [
            ("bind".to_string(), "/run/oort-runner".to_string(), false),
            ("bind".to_string(), "/var/lib/oort-box".to_string(), true),
            ("volume".to_string(), "/home/box".to_string(), true),
        ],
        "the mount set is exactly: the volume, the runner's read-only inject dir, the key dir"
    );
    let key_source = mounts.iter().find(|m| m["Destination"] == "/var/lib/oort-box").unwrap()["Source"].as_str().unwrap();
    assert_eq!(key_source, format!("{keys}/{box_id}"));
    let env_text = info["Config"]["Env"].to_string().to_uppercase();
    for forbidden in ["PAIRING", "TOKEN", "SECRET", "PASSWORD", "API_KEY"] {
        assert!(!env_text.contains(forbidden), "the box's environment names {forbidden}: {env_text}");
    }
    let (_, mountinfo) = docker(&["exec", &name, "sh", "-c", "grep ' /var/lib/oort-box ' /proc/self/mountinfo"]);
    assert!(mountinfo.contains("nosuid") && mountinfo.contains("nodev"), "the key mount inside the box: {mountinfo}");
    let (_, inject) = docker(&["exec", &name, "ls", "-l", "/run/oort-runner"]);
    assert!(inject.contains("seal.key") && inject.contains("owner-list.b64"), "{inject}");
    assert!(!inject.contains("pairing.code"), "the one-time code is gone once the key is attested: {inject}");
    let (_, procs) = docker(&["exec", &name, "ps", "-eo", "uid,args"]);
    assert!(procs.contains("10002") && procs.contains("momo-box-agent run"), "the agent runs as its own uid: {procs}");
    assert!(procs.contains("spawn-helper"), "{procs}");

    // ---- the owner's device pins the host and attaches through the server's relay --------------------------------------
    step!("the owner's device pins the host (typed fingerprint) and attaches");
    let target = Target {
        world: &world,
        box_id,
        host_id: Uuid::parse_str(bundle["hostId"].as_str().unwrap()).unwrap(),
        owner_device: &owner_device,
        owner_list: &list,
        runner_fingerprint,
    };
    let client = target.pinned_client(&owner_device).await;
    let mut conn = target.attach(&client, &owner_device).await.expect("the owner attaches to the real box");
    conn.open_terminal(100, 30).await.unwrap();
    let marker = format!("OORT-M4-DOCKER-MARKER-{}", Uuid::new_v4());
    conn.type_bytes(b"id -u\n").await.unwrap();
    conn.read_until(Duration::from_secs(30), |got| String::from_utf8_lossy(got).contains("\n10001")).await
        .expect("the person's shell runs at the person's uid (10001), not the agent's");
    for _ in 0..20 {
        conn.type_bytes(format!("echo {marker}\n").as_bytes()).await.unwrap();
    }
    let mut seen_marker = 0;
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut collected = Vec::new();
    while seen_marker < 20 {
        assert!(Instant::now() < deadline, "the real shell did not echo the marker");
        let chunk = conn.read_until(Duration::from_secs(10), |g| !g.is_empty()).await.expect("output");
        collected.extend_from_slice(&chunk);
        seen_marker = String::from_utf8_lossy(&collected).matches(&marker).count();
    }
    step!("plaintext: the marker is in no server log, no database dump and no runner log");
    let logs = capture.text();
    let dump = pg_dump_text();
    let runner_text = runner_log.lock().unwrap().clone();
    let hex_marker: String = marker.bytes().map(|b| format!("{b:02x}")).collect();
    for (what, haystack) in [("server logs", &logs), ("database dump", &dump), ("runner log", &runner_text)] {
        assert_eq!(haystack.matches(&marker).count(), 0, "the marker is in the {what}");
        assert_eq!(haystack.matches(&hex_marker).count(), 0, "the marker (hex) is in the {what}");
    }
    assert!(logs.len() > 1000 && dump.contains(&box_id.to_string()), "positive controls: the captures are real");
    assert!(!runner_text.contains(&credential), "the runner never logs its credential");
    assert!(runner_text.contains(&fingerprint_hex), "the fingerprint is on the runner's console (positive control)");
    conn.send(FrameKind::Close, &[]).await.ok();
    drop(conn);

    // ---- stop / start: the host key persists on the nosuid,nodev mount; the agent does not register again --------------
    step!("stop and start: same host key, no new registration, nonces and sealed key on the key mount");
    let (status, _) = world.post(&format!("/cloud-boxes/{box_id}/stop"), &world.owner.access, json!({})).await;
    assert_eq!(status, 200);
    wait_state(&world, &world.owner.access, "stopped", Duration::from_secs(60)).await;
    eventually("the container to stop", Duration::from_secs(60), || {
        let (_, state) = docker(&["inspect", "--format", "{{.State.Running}}", &name]);
        (state.trim() == "false").then_some(())
    })
    .await;
    let (ok, listing) = vm_sudo(&format!("ls -l {keys}/{box_id}/state {keys}/{box_id}/key; head -c 22 {keys}/{box_id}/key/host.key"));
    assert!(ok, "{listing}");
    assert!(listing.contains("nonces.bin") && listing.contains("registered.json") && listing.contains("host.key"), "{listing}");
    assert!(listing.contains("oort-hostkey-sealed-v1"), "the host key at rest is sealed: {listing}");
    let (status, _) = world.post(&format!("/cloud-boxes/{box_id}/start"), &world.owner.access, json!({})).await;
    assert_eq!(status, 200);
    wait_state(&world, &world.owner.access, "running", Duration::from_secs(60)).await;
    let bundle = wait_agent(&world, box_id, &world.owner.access, true, Duration::from_secs(120)).await;
    assert_eq!(bundle["host"]["publicKey"], host_key_first, "the host key survived the stop");
    let mut conn = target.attach(&client, &owner_device).await.expect("the SAME pin attaches after a restart");
    conn.open_terminal(100, 30).await.unwrap();
    conn.type_bytes(b"echo after-restart\n").await.unwrap();
    conn.read_until(Duration::from_secs(30), |g| String::from_utf8_lossy(g).contains("after-restart")).await.unwrap();

    // ---- a dead spawn helper is replaced: the agent exits 75, the entry starts it again --------------------------------
    step!("kill the spawn helper: the next terminal fails, the agent restarts itself, the one after works");
    let helper_pid = || {
        let (_, procs) = docker(&["exec", &name, "ps", "-eo", "pid,args"]);
        procs
            .lines()
            .find(|l| l.contains("spawn-helper"))
            .and_then(|l| l.split_whitespace().next().map(str::to_string))
    };
    let old_helper = helper_pid().expect("a helper is running");
    let (ok, out) = docker(&["exec", "--privileged", "--user", "0", &name, "kill", "-9", &old_helper]);
    assert!(ok, "killing the helper (test oracle): {out}");
    drop(conn);
    // The next attach authenticates fine but its terminal cannot be started.
    if let Ok(mut broken) = target.attach(&client, &owner_device).await {
        let _ = broken.open_terminal(80, 24).await;
        let _ = broken.wait_closed(Duration::from_secs(10)).await;
    }
    wait_agent(&world, box_id, &world.owner.access, false, Duration::from_secs(60)).await;
    let bundle = wait_agent(&world, box_id, &world.owner.access, true, Duration::from_secs(120)).await;
    assert_eq!(bundle["host"]["publicKey"], host_key_first);
    let new_helper = eventually("a new helper", Duration::from_secs(30), helper_pid).await;
    assert_ne!(new_helper, old_helper, "a new spawn helper was started");
    let (_, state) = docker(&["inspect", "--format", "{{.State.Running}}", &name]);
    assert_eq!(state.trim(), "true", "the container itself kept running");
    let mut conn = target.attach(&client, &owner_device).await.expect("attach after the helper was replaced");
    conn.open_terminal(100, 30).await.unwrap();
    conn.type_bytes(b"echo helper-is-back\n").await.unwrap();
    conn.read_until(Duration::from_secs(30), |g| String::from_utf8_lossy(g).contains("helper-is-back")).await.unwrap();

    // ---- revoke the device: the session ends ---------------------------------------------------------------------------
    step!("revoke the owner's sign-in (and with it the device key): the live session ends at once");
    let started = Instant::now();
    let response = world
        .http
        .post(format!("{}/v1/auth/logout", world.base))
        .bearer_auth(&world.owner.access)
        .json(&json!({ "refreshToken": world.owner.refresh }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let reason = conn.wait_closed(Duration::from_secs(10)).await;
    assert_eq!(reason.as_deref(), Some("device_revoked"));
    assert!(started.elapsed() < Duration::from_secs(5), "ended after {:?}", started.elapsed());

    // ---- delete (by the workspace admin: resource management): the keys are destroyed ---------------------------------
    step!("delete: container, volume, key directory and the seal key are gone");
    let (status, body) = world.post(&format!("/cloud-boxes/{box_id}/delete"), &world.admin.access, json!({})).await;
    assert_eq!(status, 200, "{body}");
    eventually("the box to be deleted", Duration::from_secs(120), || {
        let (_, containers) = docker(&["ps", "-a", "--filter", &format!("name={name}"), "--format", "{{.Names}}"]);
        let (_, volumes) = docker(&["volume", "ls", "--filter", &format!("name={name}"), "--format", "{{.Name}}"]);
        (containers.trim().is_empty() && volumes.trim().is_empty()).then_some(())
    })
    .await;
    let (_, left) = vm_sudo(&format!("ls -d {keys}/{box_id} {runner_dir}/state/boxes/{box_id} 2>&1; true"));
    assert!(left.matches("No such file").count() == 2, "the key directory and the runner's per-box files (the seal key) are gone: {left}");
    let revoked: Option<bool> = momo_box_e2e::bench::host_revoked(&world, box_id).await;
    assert_eq!(revoked, Some(true), "the box's host is revoked once the box is gone");

    let runner_text = runner_log.lock().unwrap().clone();
    assert!(!runner_text.contains(&credential));
    let _ = runner.start_kill();
    step!("done");
}

fn hex_decode(text: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex");
    }
    out
}

#[allow(dead_code)]
fn unused(_: DeviceListState) {}
