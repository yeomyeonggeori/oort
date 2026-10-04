//! ADR-0197 M3 acceptance on the host side, in process (macOS and Linux):
//! registration is `scope = member` and **inactive until the owner confirms**,
//! the PTY opens through the blind-relay handshake, the child's environment is
//! the allowlist, and the relay never sees plaintext.
//!
//! The device and the relay are `momo-blind-pty`'s own (the S2 harness); the
//! box side is `momo_box_agent::host::BoxHost` with a real PTY. The uid drop
//! and the ptrace/host-key walls are Linux-container facts, tested by
//! `infra/personal-box/verify-m3.sh`.

use std::ffi::OsString;
use std::sync::Arc;

use ed25519_dalek::SigningKey as EdSigningKey;
use momo_blind_pty::codec::{Auth, BoxId, Challenge, Hello};
use momo_blind_pty::handshake::{DeviceClient, NonceStore};
use momo_blind_pty::harness::{dev_key, BlindRelay, Dir, ManualClock, Relay};
use momo_blind_pty::session::{FrameKind, Session};
use momo_blind_pty::trust::{dev_pub, DeviceList, DeviceListState, Runner};
use momo_blind_pty::Error as ProtocolError;
use momo_box_agent::env::UserProfile;
use momo_box_agent::host::{
    Attachment, BoxHost, HostError, Inbound, Phase, RunnerLocalOwnerList, SpawnTemplate,
    MAX_ATTACHED,
};
use momo_box_agent::pty::WinSize;
use serde_json::json;

const MARKER: &str = "OORT-M3-MARKER-7f3a";
const ENV_MARKER: &str = "OORT-M3-MARKER-env";

struct Rig {
    box_id: BoxId,
    runner: Runner,
    host_sk: EdSigningKey,
    dev_a: p256::ecdsa::SigningKey,
    clock: Arc<ManualClock>,
    list_v1: DeviceList,
}

fn rig() -> Rig {
    let box_id = [7u8; 16];
    let dev_a = dev_key(3);
    Rig {
        box_id,
        runner: Runner::from_seed([1; 32]),
        host_sk: EdSigningKey::from_bytes(&[2; 32]),
        list_v1: DeviceList::sign(box_id, 1, vec![dev_pub(&dev_a)], &dev_a),
        dev_a,
        clock: Arc::new(ManualClock::default()),
    }
}

fn template(script: &str, parent_env: Vec<(OsString, OsString)>) -> SpawnTemplate {
    SpawnTemplate {
        profile: UserProfile {
            cwd: std::env::temp_dir().display().to_string(),
            ..UserProfile::box_default()
        },
        parent_env,
        drop_to: None,
        program: Some(("/bin/sh".into(), vec!["-c".into(), script.into()])),
    }
}

fn host_with(rig: &Rig, script: &str, parent_env: Vec<(OsString, OsString)>) -> BoxHost {
    BoxHost::new(
        rig.box_id,
        rig.host_sk.clone(),
        rig.clock.clone(),
        NonceStore::default(),
        template(script, parent_env),
    )
}

fn server_answer(rig: &Rig, scope: &str) -> serde_json::Value {
    use base64::Engine as _;
    let key =
        base64::engine::general_purpose::STANDARD.encode(rig.host_sk.verifying_key().to_bytes());
    json!({"workHost": {
        "id": "11111111-1111-1111-1111-111111111111",
        "workspaceId": "22222222-2222-2222-2222-222222222222",
        "ownerMemberId": "33333333-3333-3333-3333-333333333333",
        "scope": scope, "type": "cloud", "publicKey": key,
    }})
}

/// Registered by the server (member scope) and confirmed by the owner.
fn active_host(rig: &Rig, script: &str, parent_env: Vec<(OsString, OsString)>) -> BoxHost {
    let mut host = host_with(rig, script, parent_env);
    host.record_registration(&server_answer(rig, "member"))
        .unwrap();
    host.confirm_owner(RunnerLocalOwnerList::from_bytes(&rig.list_v1.to_bytes()).unwrap())
        .unwrap();
    host
}

fn pinned_client(rig: &Rig) -> DeviceClient {
    let mut client = DeviceClient::new(
        rig.dev_a.clone(),
        DeviceListState::bootstrap(rig.list_v1.clone()).unwrap(),
    );
    client.set_runner_fingerprint(rig.runner.fingerprint());
    let host_pub = rig.host_sk.verifying_key().to_bytes();
    client
        .pin_host(
            rig.box_id,
            host_pub,
            rig.runner.public(),
            rig.runner.attest_host(&rig.box_id, &host_pub),
        )
        .unwrap();
    client
}

fn pass(relay: &mut BlindRelay, dir: Dir, bytes: Vec<u8>) -> Vec<u8> {
    relay
        .forward(dir, bytes)
        .into_iter()
        .next()
        .expect("relay forwards")
}

fn attach(
    rig: &Rig,
    host: &mut BoxHost,
    relay: &mut BlindRelay,
) -> Result<(Session, Attachment), HostError> {
    let client = pinned_client(rig);
    let (hello, hs) = client.hello(rig.box_id).unwrap();
    let hello = Hello::from_bytes(&pass(relay, Dir::DeviceToBox, hello.to_bytes())).unwrap();
    let challenge = host.on_hello(hello)?;
    let challenge =
        Challenge::from_bytes(&pass(relay, Dir::BoxToDevice, challenge.to_bytes())).unwrap();
    let (auth, pending) = hs.on_challenge(challenge).unwrap();
    let auth = Auth::from_bytes(&pass(relay, Dir::DeviceToBox, auth.to_bytes())).unwrap();
    let (attachment, ready) = host.on_auth(auth)?;
    let device = pending
        .confirm(&pass(relay, Dir::BoxToDevice, ready))
        .expect("device audit passes");
    Ok((device, attachment))
}

fn send(
    device: &mut Session,
    attachment: &mut Attachment,
    relay: &mut BlindRelay,
    kind: FrameKind,
    payload: &[u8],
) -> Result<Inbound, HostError> {
    let frame = device.seal(kind, payload).unwrap();
    attachment.on_frame(&pass(relay, Dir::DeviceToBox, frame))
}

fn open_terminal(
    device: &mut Session,
    attachment: &mut Attachment,
    relay: &mut BlindRelay,
    cols: u16,
    rows: u16,
) {
    let size = WinSize { cols, rows }.to_payload();
    let result = send(device, attachment, relay, FrameKind::Resize, &size).unwrap();
    assert_eq!(result, Inbound::Opened);
    assert!(attachment.is_open());
}

/// Output until `done(text)` or the shell closes (or ~6 s).
fn collect(
    device: &mut Session,
    attachment: &mut Attachment,
    relay: &mut BlindRelay,
    done: impl Fn(&str) -> bool,
) -> (String, bool) {
    let mut text = String::new();
    let mut closed = false;
    for _ in 0..60 {
        for frame in attachment.pump(100).unwrap() {
            let (kind, payload) = device.open(&pass(relay, Dir::BoxToDevice, frame)).unwrap();
            match kind {
                FrameKind::Data => {
                    text.push_str(&String::from_utf8_lossy(&payload).replace('\r', ""))
                }
                FrameKind::Close => closed = true,
                other => panic!("unexpected frame {other:?}"),
            }
        }
        if closed || done(&text) {
            break;
        }
    }
    (text, closed)
}

fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    pairs
        .iter()
        .map(|(n, v)| ((*n).into(), (*v).into()))
        .collect()
}

// ---------------------------------------------------------------- registration

#[test]
fn registration_is_member_scope_and_never_activates_the_host() {
    let rig = rig();
    let mut host = host_with(&rig, "true", vec![]);
    assert_eq!(host.phase(), Phase::Pending);

    // A server that answers with a wider scope than asked for is refused and
    // recorded as nothing.
    for scope in ["workspace", "team", ""] {
        let err = host
            .record_registration(&server_answer(&rig, scope))
            .unwrap_err();
        assert!(matches!(err, HostError::Register(_)), "{scope}: {err}");
        assert!(host.registered().is_none());
    }
    host.record_registration(&server_answer(&rig, "member"))
        .unwrap();
    assert!(host.registered().is_some());
    assert_eq!(
        host.phase(),
        Phase::Pending,
        "a registered host is still inactive: only the owner's confirmation activates it"
    );
}

#[test]
fn a_pending_host_serves_nothing_even_to_the_owners_own_device() {
    let rig = rig();
    let mut relay = BlindRelay::default();
    let mut host = host_with(&rig, "true", vec![]);
    host.record_registration(&server_answer(&rig, "member"))
        .unwrap();

    // Not confirmed: the owner's device (which the box would accept once active)
    // gets no challenge at all.
    let client = pinned_client(&rig);
    let (hello, _hs) = client.hello(rig.box_id).unwrap();
    let hello = Hello::from_bytes(&pass(&mut relay, Dir::DeviceToBox, hello.to_bytes())).unwrap();
    assert!(matches!(host.on_hello(hello), Err(HostError::NotConfirmed)));
    assert!(matches!(
        attach(&rig, &mut host, &mut relay),
        Err(HostError::NotConfirmed)
    ));

    // A device list from the server changes nothing while pending, however
    // well it is signed.
    let server_dev = dev_key(99);
    let server_list = DeviceList::sign(rig.box_id, 2, vec![dev_pub(&server_dev)], &server_dev);
    assert!(matches!(
        host.on_device_list(server_list),
        Err(HostError::NotConfirmed)
    ));
    assert_eq!(host.phase(), Phase::Pending);
}

#[test]
fn only_a_registered_host_with_a_list_for_its_own_box_can_be_confirmed() {
    let rig = rig();
    let list = || RunnerLocalOwnerList::from_bytes(&rig.list_v1.to_bytes()).unwrap();

    let mut unregistered = host_with(&rig, "true", vec![]);
    assert!(matches!(
        unregistered.confirm_owner(list()),
        Err(HostError::NotRegistered)
    ));
    assert_eq!(unregistered.phase(), Phase::Pending);

    let other_box = DeviceList::sign([8u8; 16], 1, vec![dev_pub(&rig.dev_a)], &rig.dev_a);
    let mut host = host_with(&rig, "true", vec![]);
    host.record_registration(&server_answer(&rig, "member"))
        .unwrap();
    assert!(matches!(
        host.confirm_owner(RunnerLocalOwnerList::from_bytes(&other_box.to_bytes()).unwrap()),
        Err(HostError::WrongBox)
    ));
    assert_eq!(host.phase(), Phase::Pending);

    host.confirm_owner(list()).unwrap();
    assert_eq!(host.phase(), Phase::Active);
    assert!(matches!(
        host.confirm_owner(list()),
        Err(HostError::AlreadyConfirmed)
    ));
}

#[test]
fn once_active_a_server_supplied_list_still_needs_an_owner_signature() {
    let rig = rig();
    let mut host = active_host(&rig, "true", vec![]);
    let server_dev = dev_key(99);
    // Higher version, self-signed by a key the owner never listed.
    let forged = DeviceList::sign(
        rig.box_id,
        2,
        vec![dev_pub(&server_dev), dev_pub(&rig.dev_a)],
        &server_dev,
    );
    match host.on_device_list(forged) {
        Err(HostError::Protocol(ProtocolError::DeviceListBadSigner)) => {}
        other => panic!("a server-made list must be refused, got {other:?}"),
    }
    // An owner-signed +1 is applied.
    let dev_b = dev_key(4);
    let v2 = DeviceList::sign(
        rig.box_id,
        2,
        vec![dev_pub(&rig.dev_a), dev_pub(&dev_b)],
        &rig.dev_a,
    );
    host.on_device_list(v2).unwrap();
}

// ---------------------------------------------------------------- PTY

#[test]
fn the_owner_opens_a_pty_and_types_through_the_blind_relay() {
    let rig = rig();
    let mut relay = BlindRelay {
        log_everything: true,
        ..BlindRelay::default()
    };
    let mut host = active_host(&rig, "stty -echo; printf 'READY\\n'; cat", vec![]);
    let (mut device, mut attachment) = attach(&rig, &mut host, &mut relay).unwrap();

    // Nothing runs until the device says how big its terminal is.
    assert!(!attachment.is_open());
    assert!(matches!(
        send(
            &mut device,
            &mut attachment,
            &mut relay,
            FrameKind::Data,
            b"too early\n"
        ),
        Err(HostError::NotOpened)
    ));
    assert!(!attachment.is_open());
    open_terminal(&mut device, &mut attachment, &mut relay, 80, 24);
    assert!(attachment.pty_child_id().is_some());

    let (text, _) = collect(&mut device, &mut attachment, &mut relay, |t| {
        t.contains("READY")
    });
    assert!(text.contains("READY"), "{text:?}");
    let typed = format!("{MARKER}-typed\n");
    assert_eq!(
        send(
            &mut device,
            &mut attachment,
            &mut relay,
            FrameKind::Data,
            typed.as_bytes()
        )
        .unwrap(),
        Inbound::Input
    );
    let (text, _) = collect(&mut device, &mut attachment, &mut relay, |t| {
        t.contains(&format!("{MARKER}-typed"))
    });
    assert!(text.contains(&format!("{MARKER}-typed")), "{text:?}");

    // The relay recorded and hex-logged every byte it handled: none of it is
    // plaintext, in either direction.
    assert!(
        relay.seen.len() >= 6,
        "positive control: the relay saw traffic"
    );
    for (_, bytes) in &relay.seen {
        assert!(
            !bytes.windows(MARKER.len()).any(|w| w == MARKER.as_bytes()),
            "plaintext reached the relay"
        );
        assert!(!bytes.windows(5).any(|w| w == b"READY"));
    }
}

#[test]
fn resize_and_close_work_and_a_shell_that_exits_ends_with_an_authenticated_close() {
    let rig = rig();
    let mut relay = BlindRelay::default();
    let mut host = active_host(
        &rig,
        "stty -echo; stty size; read x; stty size; exit 0",
        vec![],
    );
    let (mut device, mut attachment) = attach(&rig, &mut host, &mut relay).unwrap();
    open_terminal(&mut device, &mut attachment, &mut relay, 100, 30);
    let (text, _) = collect(&mut device, &mut attachment, &mut relay, |t| {
        t.contains("30 100")
    });
    assert!(text.contains("30 100"), "initial size: {text:?}");

    let size = WinSize {
        cols: 120,
        rows: 40,
    }
    .to_payload();
    assert_eq!(
        send(
            &mut device,
            &mut attachment,
            &mut relay,
            FrameKind::Resize,
            &size
        )
        .unwrap(),
        Inbound::Resized
    );
    send(
        &mut device,
        &mut attachment,
        &mut relay,
        FrameKind::Data,
        b"\n",
    )
    .unwrap();
    let (text, closed) = collect(&mut device, &mut attachment, &mut relay, |_| false);
    assert!(text.contains("40 120"), "resized: {text:?}");
    assert!(
        closed,
        "the shell exited: the box ends the stream with a Close"
    );
    assert!(
        device.peer_closed(),
        "the Close is authenticated, not a truncation"
    );
    assert!(attachment.is_finished());
}

#[test]
fn a_bad_resize_and_a_device_close_are_handled() {
    let rig = rig();
    let mut relay = BlindRelay::default();
    let mut host = active_host(&rig, "cat", vec![]);
    for bad in [&[0u8, 0, 0, 0][..], &[0xff, 0xff, 0, 24], &[0, 80], &[]] {
        let (mut device, mut attachment) = attach(&rig, &mut host, &mut relay).unwrap();
        let result = send(
            &mut device,
            &mut attachment,
            &mut relay,
            FrameKind::Resize,
            bad,
        );
        assert!(
            matches!(result, Err(HostError::BadFrame)),
            "{bad:?}: {result:?}"
        );
        assert!(!attachment.is_open(), "a bad size opens nothing");
    }
    let (mut device, mut attachment) = attach(&rig, &mut host, &mut relay).unwrap();
    open_terminal(&mut device, &mut attachment, &mut relay, 80, 24);
    assert_eq!(
        send(
            &mut device,
            &mut attachment,
            &mut relay,
            FrameKind::Close,
            &[]
        )
        .unwrap(),
        Inbound::Closed
    );
    assert!(!attachment.is_open());
    assert!(attachment.is_finished());
    assert!(attachment.pump(10).unwrap().is_empty());
}

#[test]
fn at_most_two_sessions_are_attached_and_a_slot_frees_when_one_drops() {
    let rig = rig();
    let mut relay = BlindRelay::default();
    let mut host = active_host(&rig, "cat", vec![]);
    let first = attach(&rig, &mut host, &mut relay).unwrap();
    let second = attach(&rig, &mut host, &mut relay).unwrap();
    assert_eq!(MAX_ATTACHED, 2);
    assert!(matches!(
        attach(&rig, &mut host, &mut relay),
        Err(HostError::TooManyAttached)
    ));
    drop(first);
    let third = attach(&rig, &mut host, &mut relay).expect("a freed slot is reusable");
    drop((second, third));
}

// ---------------------------------------------------------------- environment

#[test]
fn the_shell_gets_the_allowlist_and_nothing_the_agent_was_given() {
    let rig = rig();
    let mut relay = BlindRelay::default();
    // Names only; every value is built from the marker at run time, so the test
    // source carries no `NAME = "secret-looking literal"` for a secret scanner
    // to mistake for a credential.
    let planted: Vec<(&str, String)> = [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "OPENAI_API_KEY",
        "OORT_BOX_KEY_DIR",
        "OORT_BOX_SEAL_KEY_FILE",
        "OORT_BOX_ID",
        "MOMO_WORKD_REGISTER_TOKEN",
        "LD_PRELOAD",
    ]
    .into_iter()
    .map(|name| (name, format!("{ENV_MARKER}-{}", name.len())))
    .collect();
    let mut polluted = os(&[
        ("PATH", "/usr/bin:/bin"),
        ("CLAUDE_CONFIG_DIR", "/cred/claude"),
        ("CODEX_HOME", "/cred/codex"),
    ]);
    polluted.extend(
        planted
            .iter()
            .map(|(name, value)| (OsString::from(*name), OsString::from(value))),
    );
    let mut host = active_host(&rig, "env; exit 0", polluted);
    let (mut device, mut attachment) = attach(&rig, &mut host, &mut relay).unwrap();
    open_terminal(&mut device, &mut attachment, &mut relay, 80, 24);
    let (text, closed) = collect(&mut device, &mut attachment, &mut relay, |_| false);
    assert!(closed, "env finished: {text:?}");
    let names: Vec<&str> = text
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(n, _)| n)
        .collect();
    for wanted in [
        "HOME",
        "USER",
        "SHELL",
        "TERM",
        "PATH",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
    ] {
        assert!(names.contains(&wanted), "{wanted} missing from {names:?}");
    }
    for banned in [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "OPENAI_API_KEY",
        "OORT_BOX_KEY_DIR",
        "OORT_BOX_SEAL_KEY_FILE",
        "OORT_BOX_ID",
        "MOMO_WORKD_REGISTER_TOKEN",
        "LD_PRELOAD",
    ] {
        assert!(!names.contains(&banned), "{banned} reached the PTY child");
    }
    assert!(
        !text.contains(ENV_MARKER),
        "no injected value reaches the terminal: {text:?}"
    );
}

// ---------------------------------------------------------------- credentials

#[test]
fn the_runner_mount_reader_refuses_a_credential_path() {
    use momo_box_agent::fsgate::{FsError, FsGate};
    let gate = FsGate::new([std::path::PathBuf::from("/cred")]);
    for path in [
        "/cred/claude/owner-list.bin",
        "/somewhere/.codex/auth.json",
        "/x/.credentials.json",
    ] {
        match RunnerLocalOwnerList::from_runner_mount(&gate, std::path::Path::new(path)) {
            Err(HostError::Gate(FsError::Refused(_))) => {}
            Err(other) => panic!("{path}: expected a refusal, got {other}"),
            Ok(_) => panic!("{path}: a credential path was read"),
        }
    }
}
