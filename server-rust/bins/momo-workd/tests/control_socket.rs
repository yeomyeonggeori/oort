//! The app ↔ workd control socket (ADR-0188 D2, #2778), without a database.
//!
//! | test | the guard whose removal turns it red |
//! |---|---|
//! | `cs_1_an_unsigned_workd_answers_nobody_without_the_dev_flag` | `PeerPolicy::RefuseAll` in `control_socket::check_peer` |
//! | `cs_2_a_peer_that_is_not_the_team_signed_app_is_refused` | `signing::check_peer_signature` (audit token → `SecCodeCheckValidity`) |
//! | `cs_3_the_dev_flag_answers_status_over_a_user_only_socket` | the `0600` chmod in `ControlSocket::bind` |
//! | `cs_4_a_folder_other_users_can_enter_is_refused` | `check_socket_folder` |
//! | `cs_5_a_live_socket_is_not_stolen_and_a_stale_one_is_replaced` | the connect probe in `ControlSocket::bind` |
//! | `cs_6_the_binary_opens_no_tcp_socket_with_the_control_socket_on` | ADR-0188 D2 (no TCP, including loopback) |
//! | `cs_7_forget_deletes_the_key_and_the_state` | `cli::forget` (the local half of 등록 해제) |
#![cfg(target_os = "macos")]

use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use momo_workd::control_socket::{
    ControlSocket, ControlSocketError, HostHealth, HostIdentity, PeerPolicy, SocketShared,
};
use momo_workd::human_trust::{HumanTrust, TrustIdentity};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::UnixStream;
use tokio::sync::Notify;
use uuid::Uuid;

const WORKD: &str = env!("CARGO_BIN_EXE_momo-workd");

/// A private 0700 folder under /tmp (short: `sun_path` is 104 bytes).
struct Folder(PathBuf);

impl Folder {
    fn new() -> Self {
        let dir = PathBuf::from(format!(
            "/tmp/wcs-{}",
            &Uuid::new_v4().simple().to_string()[..12]
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        Self(dir)
    }
    fn sock(&self) -> PathBuf {
        self.0.join("workd.sock")
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn identity() -> HostIdentity {
    HostIdentity {
        host_id: Uuid::from_u128(11),
        workspace_id: Uuid::from_u128(12),
        owner_member_id: Uuid::from_u128(13),
    }
}

fn serve(path: &Path, policy: PeerPolicy) -> (tokio::task::JoinHandle<()>, Arc<Notify>) {
    let socket = ControlSocket::bind(path, policy).expect("bind");
    let stop = Arc::new(Notify::new());
    let identity = identity();
    let trust = HumanTrust::open(
        path.parent().expect("socket folder"),
        TrustIdentity {
            workspace_id: identity.workspace_id,
            owner_member_id: identity.owner_member_id,
            host_id: identity.host_id,
        },
    )
    .expect("trust state");
    let shared = SocketShared {
        health: Arc::new(HostHealth::default()),
        stop: stop.clone(),
        trust: Arc::new(std::sync::Mutex::new(trust)),
        requirement: Arc::new(std::sync::Mutex::new(
            momo_workd::signature_requirement::SignatureRequirement::off(),
        )),
        state_folder: path.parent().expect("socket folder").to_path_buf(),
        grants: momo_workd::session_grant::GrantEpoch::default(),
        share: None,
    };
    let task = tokio::spawn(socket.serve(identity, shared));
    (task, stop)
}

/// Send one line; return whatever came back before the peer closed.
async fn ask(path: &Path, line: &str) -> String {
    let mut stream = UnixStream::connect(path).await.expect("connect");
    stream.write_all(line.as_bytes()).await.unwrap();
    stream.write_all(b"\n").await.unwrap();
    let mut out = String::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut out)).await;
    out
}

#[test]
fn cs_0_this_test_binary_is_not_team_signed() {
    // Everything below leans on it: the test process is the "unsigned peer".
    assert_eq!(
        PeerPolicy::for_this_binary(false).unwrap(),
        PeerPolicy::RefuseAll
    );
    assert_eq!(
        PeerPolicy::for_this_binary(true).unwrap(),
        PeerPolicy::DevUnsigned
    );
}

#[tokio::test]
async fn cs_1_an_unsigned_workd_answers_nobody_without_the_dev_flag() {
    let folder = Folder::new();
    let (task, _) = serve(&folder.sock(), PeerPolicy::RefuseAll);
    assert_eq!(ask(&folder.sock(), r#"{"op":"status"}"#).await, "");
    task.abort();
}

#[tokio::test]
async fn cs_2_a_peer_that_is_not_the_team_signed_app_is_refused() {
    let folder = Folder::new();
    // A real team rule, checked by Security.framework against this (unsigned)
    // test process's audit token.
    let policy = PeerPolicy::decide(Some("ABCDE12345"), false).unwrap();
    let (task, _) = serve(&folder.sock(), policy);
    assert_eq!(ask(&folder.sock(), r#"{"op":"status"}"#).await, "");
    assert_eq!(ask(&folder.sock(), r#"{"op":"shutdown"}"#).await, "");
    task.abort();
}

#[tokio::test]
async fn cs_3_the_dev_flag_answers_status_over_a_user_only_socket() {
    let folder = Folder::new();
    let (task, stop) = serve(&folder.sock(), PeerPolicy::DevUnsigned);
    let mode = std::fs::metadata(folder.sock())
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "the socket file is the user's alone");
    let status: serde_json::Value =
        serde_json::from_str(ask(&folder.sock(), r#"{"op":"status"}"#).await.trim()).unwrap();
    assert_eq!(status["ok"], true);
    assert_eq!(status["hostId"], Uuid::from_u128(11).to_string());
    let stopped = stop.notified();
    let answer = ask(&folder.sock(), r#"{"op":"shutdown"}"#).await;
    assert_eq!(answer.trim(), r#"{"ok":true}"#);
    tokio::time::timeout(Duration::from_secs(2), stopped)
        .await
        .expect("shutdown reaches the run loop");
    task.abort();
    let _ = task.await;
    assert!(
        !folder.sock().exists(),
        "the socket file goes with the listener"
    );
}

#[tokio::test]
async fn cs_4_a_folder_other_users_can_enter_is_refused() {
    let folder = Folder::new();
    for mode in [0o755, 0o750, 0o701, 0o710] {
        std::fs::set_permissions(&folder.0, std::fs::Permissions::from_mode(mode)).unwrap();
        let refused = ControlSocket::bind(&folder.sock(), PeerPolicy::DevUnsigned);
        assert!(
            matches!(refused, Err(ControlSocketError::Unsafe { .. })),
            "{mode:o}"
        );
    }
    std::fs::set_permissions(&folder.0, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(matches!(
        ControlSocket::bind(Path::new("relative.sock"), PeerPolicy::DevUnsigned),
        Err(ControlSocketError::Unsafe { .. })
    ));
}

#[tokio::test]
async fn cs_5_a_live_socket_is_not_stolen_and_a_stale_one_is_replaced() {
    let folder = Folder::new();
    let (task, _) = serve(&folder.sock(), PeerPolicy::DevUnsigned);
    assert!(matches!(
        ControlSocket::bind(&folder.sock(), PeerPolicy::DevUnsigned),
        Err(ControlSocketError::AlreadyRunning(_))
    ));
    task.abort();
    let _ = task.await;
    // A crashed run leaves the file behind with nobody listening.
    let stale = std::os::unix::net::UnixListener::bind(folder.sock()).unwrap();
    drop(stale);
    assert!(folder.sock().exists());
    let (task, _) = serve(&folder.sock(), PeerPolicy::DevUnsigned);
    assert!(ask(&folder.sock(), r#"{"op":"status"}"#)
        .await
        .contains("\"ok\":true"));
    task.abort();
    // Not a socket: never removed.
    let _ = task.await;
    std::fs::write(folder.sock(), b"x").unwrap();
    assert!(matches!(
        ControlSocket::bind(&folder.sock(), PeerPolicy::DevUnsigned),
        Err(ControlSocketError::Unsafe { .. })
    ));
}

/// A registered-looking installation in `folder`: config, dev key, state.
fn installation(folder: &Folder) -> PathBuf {
    let config = folder.0.join("workd.json");
    let repo = folder.0.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let state_dir = folder.0.join("state");
    std::fs::create_dir_all(&state_dir).unwrap();
    std::fs::set_permissions(&state_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(
        &config,
        serde_json::to_vec(&serde_json::json!({
            // A loopback origin nothing listens on: the heartbeat fails, which
            // is the point — workd keeps running and keeps no TCP listener.
            "server_url": "http://127.0.0.1:9",
            "workspace_id": Uuid::from_u128(12),
            "display_name": "cs-6",
            "state_path": state_dir.join("host.json"),
            "working_directory": repo,
            "tools": {"claude": {"adapter": "claude", "executable": "/usr/bin/true"}},
            "heartbeat_interval_ms": 200,
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
    let key = momo_workd::keystore::HostKey::generate().unwrap();
    momo_workd::keystore::KeyStore::dev_file(folder.0.join("host.key"))
        .store(&key, false)
        .unwrap();
    momo_workd::config::HostState {
        server_url: "http://127.0.0.1:9".into(),
        workspace_id: Uuid::from_u128(12),
        host_id: Uuid::from_u128(11),
        owner_member_id: Uuid::from_u128(13),
        public_key: key.public_key_b64(),
        scope: "member".into(),
    }
    .save(&state_dir.join("host.json"))
    .unwrap();
    config
}

/// The real binary, with `--control-socket`, heartbeating at a server that is
/// not there: it serves `status` and `shutdown` on the Unix socket and at no
/// point holds a listening TCP socket or any UDP socket.
#[test]
fn cs_6_the_binary_opens_no_tcp_socket_with_the_control_socket_on() {
    let folder = Folder::new();
    let config = installation(&folder);
    let mut child = Command::new(WORKD)
        .args(["run", "--config"])
        .arg(&config)
        .arg("--dev-key-file")
        .arg(folder.0.join("host.key"))
        .arg("--control-socket")
        .arg(folder.sock())
        .arg("--dev-unsigned-peer")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !folder.sock().exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    // A few heartbeat attempts go by.
    std::thread::sleep(Duration::from_millis(800));
    let pid = child.id().to_string();
    let lsof = |filter: &[&str]| {
        let output = Command::new("lsof")
            .args(["-nP", "-a", "-p", &pid])
            .args(filter)
            .output()
            .expect("lsof");
        String::from_utf8_lossy(&output.stdout).into_owned()
    };
    let unix = lsof(&["-U"]);
    let tcp_listen = lsof(&["-iTCP", "-sTCP:LISTEN"]);
    let udp = lsof(&["-iUDP"]);

    // The status answer over the socket, from the running binary.
    let status = std::os::unix::net::UnixStream::connect(folder.sock()).map(|mut stream| {
        use std::io::{Read as _, Write as _};
        stream.write_all(b"{\"op\":\"status\"}\n").unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).unwrap();
        out
    });
    let shutdown = std::os::unix::net::UnixStream::connect(folder.sock()).map(|mut stream| {
        use std::io::{Read as _, Write as _};
        stream.write_all(b"{\"op\":\"shutdown\"}\n").unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).unwrap();
        out
    });
    let exited = (0..100).find_map(|_| {
        std::thread::sleep(Duration::from_millis(100));
        child.try_wait().unwrap()
    });
    if exited.is_none() {
        let _ = child.kill();
    }

    assert!(
        unix.contains("workd.sock"),
        "the control socket is up: {unix}"
    );
    assert_eq!(tcp_listen, "", "ADR-0188 D2: no TCP listener");
    assert_eq!(udp, "", "no UDP socket either");
    let status = status.expect("status connect");
    assert!(
        status.contains("\"hostId\":\"00000000-0000-0000-0000-00000000000b\""),
        "{status}"
    );
    assert!(
        status.contains("\"failing\":true"),
        "no server → failing heartbeat: {status}"
    );
    assert!(shutdown.expect("shutdown connect").contains("\"ok\":true"));
    assert_eq!(
        exited.and_then(|s| s.code()),
        Some(0),
        "shutdown ends run with 0"
    );
    assert!(
        !folder.sock().exists(),
        "the socket file is removed on exit"
    );
}

#[test]
fn cs_7_forget_deletes_the_key_and_the_state() {
    let folder = Folder::new();
    let config = installation(&folder);
    let key = folder.0.join("host.key");
    let state = folder.0.join("state").join("host.json");
    assert!(key.exists() && state.exists());
    for _ in 0..2 {
        let status = Command::new(WORKD)
            .args(["forget", "--config"])
            .arg(&config)
            .arg("--dev-key-file")
            .arg(&key)
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "forget is idempotent");
    }
    assert!(!key.exists(), "the host key is gone");
    assert!(!state.exists(), "the registration state is gone");
}
