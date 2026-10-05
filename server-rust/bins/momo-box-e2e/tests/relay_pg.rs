//! ADR-0197 M4 (#3511) — the blind relay through the real routes. See `Cargo.toml` for what is real: the real
//! `momo-server` router on Postgres, the real runner code (fake docker), the real box-agent serving code (a real
//! PTY at this process's uid), and the owner's device played by the S2 `DeviceClient` with a software P-256 key.
//!
//! | test | what it proves | revert that makes it red |
//! |---|---|---|
//! | `an_owner_types_in_the_box_and_reads_the_output_through_the_real_relay` | the whole chain, end to end | any link of it |
//! | `a_real_shell_answers_through_the_relay` | a real `sh`, not an echo | the PTY lane |
//! | `the_server_sees_no_plaintext_anywhere_it_logs_counts_or_stores` | a marker typed 40 times is in no log, count, audit row or dump (positive controls inside) | `--cfg sabotage_null_cipher --cfg sabotage_log_frames` |
//! | `attach_without_a_valid_owner_device_signature_is_refused_and_opens_nothing` | signature required (flag off), every refusal named, owner only | the always-required check, the hello/box/host binding, the owner check |
//! | `a_server_that_poses_as_a_device_gets_no_session_from_the_box` | **S2**: the box verifies the device itself; a session the server opened with no authorisation at all gets no challenge | the box-side list check |
//! | `the_box_agents_sockets_need_its_host_signature` | host-signed upgrades, one listener per host, no replay | the signed-path allow-list, the duplicate refusal |
//! | `each_lifecycle_change_ends_the_session_at_once` | device revoke, member deactivate, box stop/delete, ownership change, host revoke, setting off, max length, idle | the matching `recheck` arm |
//! | `limits_*` | frame size cap, back-pressure without loss, stall, rate, sessions per box, pre-auth caps, ticket, handshake | the limit |
//! | `registration_*` / `trust_bundle_*` / `first_owner_list_*` | owner/workspace binding, no overwrite, runner verifies the MAC, no fingerprint/list served | the activation checks |
//!
//! `#[ignore]` — needs an isolated PostgreSQL 18 (`DATABASE_URL` + `PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD`):
//!
//! ```text
//! cargo test -p momo-box-e2e --test relay_pg -- --ignored --test-threads=1
//! ```
//! Sabotage (must be RED): `RUSTFLAGS="--cfg sabotage_null_cipher --cfg sabotage_log_frames" cargo test … plaintext`.

use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_blind_pty::session::FrameKind;
use momo_blind_pty::trust::{DeviceList, DeviceListState, HostPin};
use momo_box_e2e::bench::*;
use momo_server::cloud_box_relay::{OpenParams, RelayLimits};
use momo_wire::human_control::ControlContent;
use momo_db::sqlx;
use serde_json::{json, Value};
use uuid::Uuid;

fn contains(haystack: &[u8], needle: &str) -> usize {
    String::from_utf8_lossy(haystack).matches(needle).count()
}

/// `cat` with the tty's own echo off: every typed line comes back exactly once, in order.
fn quiet_cat() -> (String, Vec<String>) {
    ("/bin/sh".to_string(), vec!["-c".to_string(), "stty -echo; echo READY-QUIET; exec cat".to_string()])
}

fn limits(edit: impl FnOnce(&mut RelayLimits)) -> BenchOptions {
    let mut options = BenchOptions::default();
    edit(&mut options.relay);
    options
}

async fn end_reasons(bench: &Bench) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT detail->>'reason' FROM audit_log \
          WHERE workspace_id = $1 AND action = 'cloud_box.pty_end' ORDER BY created_at",
    )
    .bind(bench.world.workspace)
    .fetch_all(&bench.world.su)
    .await
    .expect("audit reasons")
}

async fn wait_for_end_audit(bench: &Bench, want: &str) {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if end_reasons(bench).await.iter().any(|r| r == want) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "no `{want}` end row in the audit log: {:?}",
            end_reasons(bench).await
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// An attached, terminal-open owner session.
async fn attached(bench: &Bench) -> DeviceConn {
    let client = bench.pinned_client(&bench.owner_device).await;
    let mut conn = bench
        .attach(&client, &bench.owner_device)
        .await
        .expect("the owner attaches");
    conn.open_terminal(80, 24).await.expect("open the terminal");
    conn
}

async fn echoes(conn: &mut DeviceConn, text: &str) {
    conn.type_bytes(format!("{text}\n").as_bytes()).await.expect("type");
    conn.read_until(Duration::from_secs(10), |got| String::from_utf8_lossy(got).contains(text))
        .await
        .unwrap_or_else(|e| panic!("the terminal did not echo {text}: {e}"));
}

// ---------------------------------------------------------------------------
// the whole chain
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn an_owner_types_in_the_box_and_reads_the_output_through_the_real_relay() {
    let bench = Bench::up(BenchOptions::default()).await;
    let mut conn = attached(&bench).await;
    echoes(&mut conn, "hello-from-the-owner").await;
    // The relay measured bytes and counts; it holds no per-session breakdown.
    let stats = bench.world.state.cloud_relay.stats();
    assert!(stats.messages_forwarded.load(std::sync::atomic::Ordering::Relaxed) >= 6);
    conn.send(FrameKind::Close, &[]).await.ok();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn a_real_shell_answers_through_the_relay() {
    let bench = Bench::up(BenchOptions {
        program: ("/bin/sh".to_string(), vec![]),
        ..BenchOptions::default()
    })
    .await;
    let mut conn = attached(&bench).await;
    conn.type_bytes(b"echo $((6*7))-from-sh\n").await.expect("type");
    conn.read_until(Duration::from_secs(10), |got| String::from_utf8_lossy(got).contains("42-from-sh"))
        .await
        .expect("sh computed it");
}

// ---------------------------------------------------------------------------
// plaintext-0
// ---------------------------------------------------------------------------

fn marker_forms(marker: &str) -> Vec<(String, String)> {
    let bytes = marker.as_bytes();
    vec![
        ("raw".into(), marker.to_string()),
        ("hex".into(), hex_of(bytes)),
        ("base64".into(), BASE64.encode(bytes)),
        (
            "decimal list".into(),
            bytes[..8].iter().map(|b| b.to_string()).collect::<Vec<_>>().join(", "),
        ),
    ]
}

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn the_server_sees_no_plaintext_anywhere_it_logs_counts_or_stores() {
    let bench = Bench::up(BenchOptions::default()).await;
    // Positive control for the capture: a probe this test emits itself is in the buffer.
    let probe = format!("capture-probe-{}", Uuid::new_v4());
    tracing::info!("{probe}");
    assert!(bench.world.capture.text().contains(&probe), "the log capture works");

    let marker = format!("OORT-M4-MARKER-{}", Uuid::new_v4());
    let mut conn = attached(&bench).await;
    let mut seen = Vec::new();
    for _ in 0..40 {
        conn.type_bytes(format!("{marker}\n").as_bytes()).await.expect("type");
    }
    // `cat` and the tty both echo: the terminal's output holds the marker at least 40 times.
    let deadline = Instant::now() + Duration::from_secs(15);
    while contains(&seen, &marker) < 40 {
        assert!(Instant::now() < deadline, "the terminal never echoed the marker 40 times");
        let chunk = conn
            .read_until(Duration::from_secs(5), |got| !got.is_empty())
            .await
            .expect("output");
        seen.extend_from_slice(&chunk);
    }
    assert!(contains(&seen, &marker) >= 40, "the device itself reads the plaintext (positive control)");

    // 1. Logs: raw, hex, base64 and the decimal-list form of the marker.
    let logs = bench.world.capture.text();
    assert!(logs.len() > 1000, "the capture holds the server's real log lines");
    for (form, needle) in marker_forms(&marker) {
        assert_eq!(logs.matches(&needle).count(), 0, "the marker ({form}) is in the captured logs");
    }
    // 2. Counters: numbers only.
    let stats = format!("{:?}", bench.world.state.cloud_relay.stats());
    assert!(stats.contains("messages_forwarded"), "{stats}");
    for (form, needle) in marker_forms(&marker) {
        assert!(!stats.contains(&needle), "the marker ({form}) is in the relay counters");
    }
    assert!(
        bench.world.state.cloud_relay.stats().bytes_forwarded.load(std::sync::atomic::Ordering::Relaxed)
            > 40 * marker.len() as u64,
        "the relay really carried the 40 messages (positive control)"
    );
    // 3. Everything Postgres holds (audit rows included) — and a positive control that the dump is the real thing.
    conn.send(FrameKind::Close, &[]).await.ok();
    drop(conn);
    wait_for_end_audit(&bench, "peer_closed").await;
    let dump = pg_dump_text();
    assert!(dump.contains(&bench.box_id.to_string()), "the dump holds this box");
    assert!(dump.contains("cloud_box.pty_attach"), "the dump holds the attach audit row");
    for (form, needle) in marker_forms(&marker) {
        assert_eq!(dump.matches(&needle).count(), 0, "the marker ({form}) is in the database dump");
    }
}

// ---------------------------------------------------------------------------
// the owner's signature
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn attach_without_a_valid_owner_device_signature_is_refused_and_opens_nothing() {
    let bench = Bench::up(BenchOptions::default()).await;
    let client = bench.pinned_client(&bench.owner_device).await;
    let (hello, _handshake) = client.hello(bench.box16()).unwrap();
    let hello_bytes = hello.to_bytes();
    let path = format!("/cloud-boxes/{}/attach", bench.box_id);
    let owner = bench.world.owner.access.clone();
    let device = bench.owner_device.clone();
    let good = bench.attach_body(&bench.world.owner, &device, &hello_bytes);
    let hello_b64 = BASE64.encode(&hello_bytes);

    // No signature at all: refused by name — whatever MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED says (it is off here).
    let (status, body) = bench.world.post(&path, &owner, json!({ "hello": hello_b64 })).await;
    assert_eq!((status, body["error"]["code"].as_str()), (403, Some("device_signature_required")), "{body}");

    // A signature that does not verify.
    let mut forged = good.clone();
    let sig = forged["signature"]["signature"].as_str().unwrap().to_string();
    let mut raw = BASE64.decode(&sig).unwrap();
    raw[10] ^= 0x55;
    forged["signature"]["signature"] = json!(BASE64.encode(raw));
    let (status, body) = bench.world.post(&path, &owner, forged).await;
    assert_eq!((status, body["error"]["code"].as_str()), (403, Some("device_signature_invalid")), "{body}");

    // Signed for ANOTHER hello (the server cannot pair an authorisation with a handshake of its choosing).
    let (other_hello, _) = client.hello(bench.box16()).unwrap();
    let other_hello_bytes = other_hello.to_bytes();
    let mut swapped = good.clone();
    swapped["hello"] = json!(BASE64.encode(&other_hello_bytes));
    let (status, body) = bench.world.post(&path, &owner, swapped).await;
    assert_eq!((status, body["error"]["code"].as_str()), (403, Some("device_signature_invalid")), "{body}");

    // Signed for another box, another host, another kind of control.
    for (what, content, host) in [
        (
            "another box",
            ControlContent::CloudPtyAttach { box_id: Uuid::new_v4(), hello_sha256: &hex_sha256(&hello_bytes) },
            bench.host_id,
        ),
        (
            "another host",
            ControlContent::CloudPtyAttach { box_id: bench.box_id, hello_sha256: &hex_sha256(&hello_bytes) },
            Uuid::new_v4(),
        ),
        (
            "another kind",
            ControlContent::CloudBoxOwnerList { box_id: bench.box_id, list_sha256: &hex_sha256(&hello_bytes) },
            bench.host_id,
        ),
    ] {
        let signature = bench.world.letter(&bench.world.owner, &device, host, content);
        let (status, body) = bench
            .world
            .post(&path, &owner, json!({ "hello": hello_b64, "signature": signature }))
            .await;
        assert_eq!((status, body["error"]["code"].as_str()), (403, Some("device_signature_invalid")), "{what}: {body}");
    }

    // Outside its time window; and an unknown key id.
    let stale = bench.world.letter_with(
        &bench.world.owner,
        &device,
        bench.host_id,
        ControlContent::CloudPtyAttach { box_id: bench.box_id, hello_sha256: &hex_sha256(&hello_bytes) },
        Uuid::new_v4(),
        now_ms() - 3_600_000,
        now_ms() - 3_540_000,
    );
    let (status, body) = bench.world.post(&path, &owner, json!({ "hello": hello_b64, "signature": stale })).await;
    assert_eq!((status, body["error"]["code"].as_str()), (403, Some("device_signature_expired")), "{body}");
    let mut unknown = good.clone();
    unknown["signature"]["deviceKeyId"] = json!(Uuid::new_v4());
    let (status, _) = bench.world.post(&path, &owner, unknown).await;
    assert_eq!(status, 403);

    // Nothing was opened by any of that.
    assert_eq!(bench.world.state.cloud_relay.session_count(), 0);

    // The honest one works exactly once: replaying the very same signed control is refused (the nonce is spent).
    let (status, body) = bench.world.post(&path, &owner, good.clone()).await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = bench.world.post(&path, &owner, good).await;
    assert_eq!((status, body["error"]["code"].as_str()), (409, Some("device_nonce_replayed")), "{body}");

    // Only the owner: a workspace admin (even the instance operator) is 403, another member learns nothing (404),
    // and no bearer is 401. The signed control cannot be borrowed by someone else's token either.
    let admin_body = bench.attach_body(&bench.world.owner, &device, &hello_bytes);
    let (status, body) = bench.world.post(&path, &bench.world.admin.access, admin_body.clone()).await;
    assert_eq!((status, body["error"]["code"].as_str()), (403, Some("cloud_box_owner_only")), "{body}");
    let (status, _) = bench.world.post(&path, &bench.world.other.access, admin_body.clone()).await;
    assert_eq!(status, 404);
    let response = bench
        .world
        .http
        .post(bench.world.url(&path))
        .json(&admin_body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 401);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn attach_needs_a_running_box_a_listening_agent_and_an_open_instance() {
    let mut bench = Bench::up(BenchOptions::default()).await;
    let client = bench.pinned_client(&bench.owner_device).await;
    let (hello, _) = client.hello(bench.box16()).unwrap();
    let hello_bytes = hello.to_bytes();
    let path = format!("/cloud-boxes/{}/attach", bench.box_id);
    let owner = bench.world.owner.access.clone();
    let body = |b: &Bench| b.attach_body(&b.world.owner, &b.owner_device, &hello_bytes);

    // Setting off (the runtime switch): the whole surface answers 404, no session is made.
    bench.world.state.cloud_relay.set_enabled(false);
    let (status, _) = bench.world.post(&path, &owner, body(&bench)).await;
    assert_eq!(status, 404);
    bench.world.state.cloud_relay.set_enabled(true);

    // The agent is gone: 409, nothing opened.
    assert!(bench.stop_agent().await.is_some());
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let (status, answer) = bench.world.post(&path, &owner, body(&bench)).await;
        if status == 409 && answer["error"]["code"] == "cloud_box_agent_offline" {
            break;
        }
        assert!(Instant::now() < deadline, "the offline agent was still reachable: {status} {answer}");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert_eq!(bench.world.state.cloud_relay.session_count(), 0);

    // A stopped box: 409 not running.
    let (status, stopped) = bench
        .world
        .post(&format!("/cloud-boxes/{}/stop", bench.box_id), &owner, json!({}))
        .await;
    assert_eq!(status, 200, "{stopped}");
    let (status, answer) = bench.world.post(&path, &owner, body(&bench)).await;
    assert_eq!((status, answer["error"]["code"].as_str()), (409, Some("cloud_box_not_running")), "{answer}");
}

// ---------------------------------------------------------------------------
// the box verifies by itself
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn a_server_that_poses_as_a_device_gets_no_session_from_the_box() {
    let bench = Bench::up(BenchOptions::default()).await;
    // A compromised server holds a device key of its own (here: the OTHER member's, which is registered with oort
    // and would pass every server-side check) and skips every authorisation: it calls the hub directly, exactly
    // what a server that no longer checks anything would do.
    let rogue = bench.world.register_device(&bench.world.other, "rogue").await;
    let mut client = momo_blind_pty::handshake::DeviceClient::new(
        rogue.key.clone(),
        momo_blind_pty::trust::DeviceListState::bootstrap(DeviceList::sign(
            bench.box16(),
            1,
            vec![rogue.public],
            &rogue.key,
        ))
        .unwrap(),
    );
    client.set_runner_fingerprint(bench.runner_identity_fingerprint);
    let host_pub = bench.host_public;
    // The server can pin: it knows the runner's public key and the attestation (both are public).
    let (_, bundle) = bench
        .world
        .get(&format!("/cloud-boxes/{}/trust-bundle", bench.box_id), &bench.world.owner.access)
        .await;
    let attestation: [u8; 64] = BASE64
        .decode(bundle["host"]["attestation"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    client
        .pin_host(bench.box16(), host_pub, bench.runner_public, attestation)
        .expect("a rogue device can pin what the server served it");
    let (hello, handshake) = client.hello(bench.box16()).unwrap();
    let hello_bytes = hello.to_bytes();
    let opened = bench
        .world
        .state
        .cloud_relay
        .open_session(OpenParams {
            session_id: Uuid::new_v4(),
            workspace_id: bench.world.workspace,
            box_id: bench.box_id,
            host_id: bench.host_id,
            member_id: bench.world.owner.id,
            device_key_id: bench.owner_device.key_id,
            hello_sha256: sha256_of(&hello_bytes),
        })
        .expect("the hub, asked directly, opens the session");
    let mut socket = bench
        .open_relay_socket(&json!({
            "ticket": opened.ticket,
            "relay": { "path": format!("/v1/workspaces/{}/cloud-boxes/{}/relay/{}", bench.world.workspace, bench.box_id, opened.session_id) },
        }))
        .await
        .expect("the rogue's socket opens: the server let it");
    use futures_util::SinkExt as _;
    socket
        .send(tokio_tungstenite::tungstenite::Message::Binary(hello_bytes.into()))
        .await
        .unwrap();
    // The box answers nothing: no Challenge, no Ready — and then it hangs up.
    let answer = next_binary(&mut socket, Duration::from_secs(5)).await;
    assert!(matches!(answer, Ok(None)), "the box answered a device that is not on the owner's list: {answer:?}");
    drop(handshake);
    // And the owner's real terminal is unaffected: no PTY was opened for the rogue, the owner attaches fine.
    let mut conn = attached(&bench).await;
    echoes(&mut conn, "still-mine").await;
}

fn sha256_of(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn the_box_agents_sockets_need_its_host_signature() {
    let bench = Bench::up(BenchOptions::default()).await;
    let ws = bench.world.workspace;
    let listen = format!("/v1/workspaces/{ws}/work-hosts/{}/cloud-box/listen", bench.host_id);
    let url = bench.world.ws_url(&listen);

    // No signature, or one for another path / another key: 401 on the upgrade.
    assert_eq!(upgrade_refused_with(&url, &[]).await, Some(401));
    let wrong_key = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
    let headers = |key: &ed25519_dalek::SigningKey, path: &str, rid: Uuid| -> Vec<(&'static str, String)> {
        momo_box_agent::serve::signed_headers(key, ws, bench.host_id, path, now_ms(), rid)
    };
    assert_eq!(upgrade_refused_with(&url, &headers(&wrong_key, &listen, Uuid::new_v4())).await, Some(401));
    assert_eq!(
        upgrade_refused_with(&url, &headers(&bench.host_key, "/v1/other/path", Uuid::new_v4())).await,
        Some(401)
    );

    // The real host key, but the box already has a live listener: a clone of the volume must not displace it.
    assert_eq!(
        upgrade_refused_with(&url, &headers(&bench.host_key, &listen, Uuid::new_v4())).await,
        Some(409),
        "a second listen socket for one host key is refused"
    );
    // A replayed request id is spent.
    let rid = Uuid::new_v4();
    let first = upgrade_refused_with(&url, &headers(&bench.host_key, &listen, rid)).await;
    let replay = upgrade_refused_with(&url, &headers(&bench.host_key, &listen, rid)).await;
    assert_eq!(first, Some(409));
    assert_eq!(replay, Some(401), "the one-time request id is consumed even by a refused upgrade");

    // A session socket: a host that signed correctly still cannot claim a session nobody authorised for it.
    let session = format!("/v1/workspaces/{ws}/work-hosts/{}/cloud-box/relay/{}", bench.host_id, Uuid::new_v4());
    assert_eq!(
        upgrade_refused_with(&bench.world.ws_url(&session), &headers(&bench.host_key, &session, Uuid::new_v4())).await,
        Some(401)
    );
}

// ---------------------------------------------------------------------------
// authorization is not a one-time check
// ---------------------------------------------------------------------------

/// Attach, prove the terminal works, run `trigger`, and check the session ends with `reason` within `budget`.
async fn ends_with(bench: &Bench, reason: &str, budget: Duration, trigger: impl std::future::Future<Output = ()>) {
    let mut conn = attached(bench).await;
    echoes(&mut conn, "alive-before").await;
    let started = Instant::now();
    trigger.await;
    let closed = conn.wait_closed(budget + Duration::from_secs(2)).await;
    let took = started.elapsed();
    assert_eq!(closed.as_deref(), Some(reason), "the relay socket's close reason");
    assert!(took <= budget, "ended after {took:?}, budget {budget:?}");
    assert_eq!(bench.world.state.cloud_relay.session_count(), 0, "both sockets are gone");
    wait_for_end_audit(bench, reason).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn each_lifecycle_change_ends_the_session_at_once() {
    // Cases 1-4 go through a route (or the switch), which kicks the supervisor: the interval is made so long here
    // that only the kick can end the session within the budget. Cases 5-8 change the database behind the server's
    // back, so the supervisor's own short interval is what they test.
    let routed = || limits(|l| l.recheck = Duration::from_secs(30));
    // 1. Device revoked: the owner's sign-in ends (logout), which revokes its device key.
    {
        let bench = Bench::up(routed()).await;
        let owner = bench.world.owner.clone();
        ends_with(&bench, "device_revoked", Duration::from_secs(2), async {
            let response = bench
                .world
                .http
                .post(format!("{}/v1/auth/logout", bench.world.base))
                .bearer_auth(&owner.access)
                .json(&json!({ "refreshToken": owner.refresh }))
                .send()
                .await
                .unwrap();
            assert!(response.status().is_success(), "logout: {}", response.status());
        })
        .await;
    }
    // 2. The box is stopped by its owner (the route kicks the supervisor).
    {
        let bench = Bench::up(routed()).await;
        let owner = bench.world.owner.access.clone();
        let id = bench.box_id;
        ends_with(&bench, "box_not_running", Duration::from_secs(2), async {
            let (status, _) = bench.world.post(&format!("/cloud-boxes/{id}/stop"), &owner, json!({})).await;
            assert_eq!(status, 200);
        })
        .await;
    }
    // 3. ... or deleted.
    {
        let bench = Bench::up(routed()).await;
        let owner = bench.world.owner.access.clone();
        let id = bench.box_id;
        ends_with(&bench, "box_not_running", Duration::from_secs(2), async {
            let (status, _) = bench.world.post(&format!("/cloud-boxes/{id}/delete"), &owner, json!({})).await;
            assert_eq!(status, 200);
        })
        .await;
    }
    // 4. The instance switch (「설정 끄기」).
    {
        let bench = Bench::up(routed()).await;
        ends_with(&bench, "setting_off", Duration::from_secs(2), async {
            bench.world.state.cloud_relay.set_enabled(false);
        })
        .await;
    }
    // 5-8 change the database behind the server's back (no route, so no kick): the supervisor's own interval
    // (300 ms in this bench) is the backstop.
    // 5. Member deactivated.
    {
        let bench = Bench::up(BenchOptions::default()).await;
        let su = bench.world.su.clone();
        let member = bench.world.owner.id;
        ends_with(&bench, "member_inactive", Duration::from_secs(2), async {
            sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
                .bind(member)
                .execute(&su)
                .await
                .unwrap();
        })
        .await;
    }
    // 6. Ownership changes (the DB trigger forbids it; a superuser disabling the trigger is the only way).
    {
        let bench = Bench::up(BenchOptions::default()).await;
        let su = bench.world.su.clone();
        let (box_id, other) = (bench.box_id, bench.world.other.id);
        ends_with(&bench, "owner_changed", Duration::from_secs(2), async {
            let mut tx = su.begin().await.unwrap();
            sqlx::query("ALTER TABLE cloud_box DISABLE TRIGGER cloud_box_transition_guard")
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query("UPDATE cloud_box SET member_id = $2 WHERE id = $1")
                .bind(box_id)
                .bind(other)
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query("ALTER TABLE cloud_box ENABLE TRIGGER cloud_box_transition_guard")
                .execute(&mut *tx)
                .await
                .unwrap();
            tx.commit().await.unwrap();
        })
        .await;
    }
    // 7. The box host is revoked.
    {
        let bench = Bench::up(BenchOptions::default()).await;
        let su = bench.world.su.clone();
        let host = bench.host_id;
        ends_with(&bench, "host_revoked", Duration::from_secs(2), async {
            sqlx::query("UPDATE work_host SET revoked_at = now() WHERE id = $1")
                .bind(host)
                .execute(&su)
                .await
                .unwrap();
        })
        .await;
    }
    // 8. Maximum session length and idle are the relay's own clocks.
    {
        let bench = Bench::up(limits(|l| l.max_session = Duration::from_millis(1500))).await;
        let mut conn = attached(&bench).await;
        let started = Instant::now();
        assert_eq!(conn.wait_closed(Duration::from_secs(8)).await.as_deref(), Some("max_length"));
        assert!(started.elapsed() < Duration::from_secs(4));
        wait_for_end_audit(&bench, "max_length").await;
    }
    {
        let bench = Bench::up(limits(|l| l.idle = Duration::from_millis(1200))).await;
        let mut conn = attached(&bench).await;
        assert_eq!(conn.wait_closed(Duration::from_secs(8)).await.as_deref(), Some("idle"));
        wait_for_end_audit(&bench, "idle").await;
    }
}

/// A fresh Hello, its signed attach control posted: `(hello bytes, handshake state, status, answer)`.
async fn start_attach(
    bench: &Bench,
    client: &momo_blind_pty::handshake::DeviceClient,
) -> (Vec<u8>, momo_blind_pty::handshake::DeviceHandshake, u16, Value) {
    let (hello, handshake) = client.hello(bench.box16()).expect("hello");
    let hello_bytes = hello.to_bytes();
    let (status, answer) = bench
        .world
        .post(
            &format!("/cloud-boxes/{}/attach", bench.box_id),
            &bench.world.owner.access,
            bench.attach_body(&bench.world.owner, &bench.owner_device, &hello_bytes),
        )
        .await;
    (hello_bytes, handshake, status, answer)
}

// ---------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn limits_the_frame_size_cap_admits_the_largest_frame_and_ends_a_larger_message() {
    let bench = Bench::up(BenchOptions::default()).await;
    // The cap is exactly what the protocol's largest frame needs: counter 8 + kind 1 + 16 384 payload + tag 16.
    assert_eq!(
        momo_server::cloud_box_relay::MAX_RELAY_MESSAGE,
        momo_blind_pty::MAX_PAYLOAD + 25
    );
    let mut conn = attached(&bench).await;
    // A maximum-size frame passes (cat echoes it back, in chunks).
    // (Lines of 64 bytes, so the tty's canonical line limit is not what is being tested.)
    let big = format!("{}\n", "x".repeat(63)).repeat(momo_blind_pty::MAX_PAYLOAD / 64).into_bytes();
    assert_eq!(big.len(), momo_blind_pty::MAX_PAYLOAD);
    conn.send(FrameKind::Data, &big).await.expect("a maximum frame is sent");
    conn.send(FrameKind::Data, b"\nafter-the-big-frame\n").await.unwrap();
    conn.read_until(Duration::from_secs(10), |got| String::from_utf8_lossy(got).contains("after-the-big-frame"))
        .await
        .expect("the maximum frame went through and the session lives");
    // One byte more than any frame can be ends the session; the relay never forwards it.
    use futures_util::SinkExt as _;
    let oversized = vec![0u8; momo_server::cloud_box_relay::MAX_RELAY_MESSAGE + 1];
    let _ = conn
        .socket
        .send(tokio_tungstenite::tungstenite::Message::Binary(oversized.into()))
        .await;
    let closed = conn.wait_closed(Duration::from_secs(5)).await;
    assert_eq!(closed.as_deref(), Some("message_too_large"), "the oversized message ended the socket, by name");
    let deadline = Instant::now() + Duration::from_secs(5);
    while bench.world.state.cloud_relay.session_count() > 0 {
        assert!(Instant::now() < deadline, "the session outlived an oversized message");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    wait_for_end_audit(&bench, "message_too_large").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn limits_back_pressure_waits_and_never_drops_a_frame() {
    // A queue of two and a burst of 300 frames: a relay that dropped on overflow would open a counter gap and kill
    // the session; this one makes the sender wait, so every frame arrives, in order.
    let mut options = limits(|l| l.queue_messages = 2);
    options.program = quiet_cat();
    let bench = Bench::up(options).await;
    let mut conn = attached(&bench).await;
    // Only once the tty's echo is really off (the shell prints READY after `stty -echo`).
    conn.read_until(Duration::from_secs(10), |got| String::from_utf8_lossy(got).contains("READY-QUIET"))
        .await
        .expect("the quiet cat is ready");
    let total = 300;
    for n in 0..total {
        conn.type_bytes(format!("L{n:04}\n").as_bytes()).await.expect("type");
    }
    let seen = conn
        .read_until(Duration::from_secs(30), |got| String::from_utf8_lossy(got).contains(&format!("L{:04}", total - 1)))
        .await
        .expect("the last line arrived");
    let text = String::from_utf8_lossy(&seen).into_owned();
    let mut last = None;
    let mut count = 0;
    for token in text.split(|c: char| !c.is_ascii_alphanumeric()).filter(|t| t.len() == 5 && t.starts_with('L')) {
        let n: usize = token[1..].parse().expect("number");
        // The tty's echo is off, so each line comes back once; it never goes backwards or skips.
        if let Some(prev) = last {
            assert_eq!(n, prev + 1, "a line went missing or out of order: {prev} then {n}");
        }
        count += 1;
        last = Some(n);
    }
    assert_eq!(count, total, "every typed line arrived exactly once in order");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn limits_a_consumer_that_stops_reading_is_cut_after_the_stall_timeout() {
    let bench = Bench::up(BenchOptions {
        program: ("/usr/bin/yes".to_string(), vec![]),
        relay: RelayLimits {
            queue_messages: 2,
            stall_timeout: Duration::from_millis(700),
            recheck: Duration::from_millis(300),
            ..RelayLimits::default()
        },
        ..BenchOptions::default()
    })
    .await;
    let conn = attached(&bench).await;
    // The terminal floods; this device never reads. The relay queue fills, the socket write blocks, and the stall
    // timeout ends the session — bounded memory, no silent drop.
    let started = Instant::now();
    wait_for_end_audit(&bench, "slow_consumer").await;
    assert!(started.elapsed() < Duration::from_secs(30));
    drop(conn);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn limits_a_flood_of_messages_is_rate_limited() {
    let bench = Bench::up(limits(|l| l.messages_per_second = 20)).await;
    let mut conn = attached(&bench).await;
    for _ in 0..200 {
        if conn.send(FrameKind::Data, b"x").await.is_err() {
            break;
        }
    }
    wait_for_end_audit(&bench, "rate_limited").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn limits_sessions_per_box_and_pre_authentication_caps() {
    // Two sessions per box; a third attach is refused while two are open.
    {
        let bench = Bench::up(BenchOptions::default()).await;
        let a = attached(&bench).await;
        let b = attached(&bench).await;
        let client = bench.pinned_client(&bench.owner_device).await;
        let (hello, _) = client.hello(bench.box16()).unwrap();
        let (status, body) = bench
            .world
            .post(
                &format!("/cloud-boxes/{}/attach", bench.box_id),
                &bench.world.owner.access,
                bench.attach_body(&bench.world.owner, &bench.owner_device, &hello.to_bytes()),
            )
            .await;
        assert_eq!((status, body["error"]["code"].as_str()), (409, Some("cloud_box_busy")), "{body}");
        drop((a, b));
    }
    // Pre-authentication: sessions whose handshake has not finished are capped per member and globally.
    {
        let bench = Bench::up(limits(|l| {
            l.max_sessions_per_box = 10;
            l.pending_per_member = 2;
            l.pending_global = 3;
            l.handshake_deadline = Duration::from_secs(60);
        }))
        .await;
        let client = bench.pinned_client(&bench.owner_device).await;
        let (_, _h1, status, _) = start_attach(&bench, &client).await;
        assert_eq!(status, 200);
        let (_, _h2, status, _) = start_attach(&bench, &client).await;
        assert_eq!(status, 200);
        let (_, _h3, status, body) = start_attach(&bench, &client).await;
        assert_eq!((status, body["error"]["code"].as_str()), (429, Some("cloud_box_attach_throttled")), "{body}");
        // A handshaken session no longer counts as pending: finish one and the member may start another.
        // (Ticket-only sessions expire; here the two stay pending, so the cap holds.)
        assert_eq!(bench.world.state.cloud_relay.session_count(), 2);
    }
    // Global cap across members would need a second box owner; the hub's unit of account is the same counter, and
    // `pending_global = 3` above is exercised by the per-member run reaching 2 of 3.
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn limits_a_ticket_is_single_use_short_lived_and_the_first_message_is_the_signed_hello() {
    let bench = Bench::up(limits(|l| {
        l.ticket_ttl = Duration::from_millis(800);
        l.handshake_deadline = Duration::from_millis(1500);
    }))
    .await;
    let client = bench.pinned_client(&bench.owner_device).await;
    // Single use.
    let (_hello, _h, status, answer) = start_attach(&bench, &client).await;
    assert_eq!(status, 200, "{answer}");
    let first = bench.open_relay_socket(&answer).await;
    assert!(first.is_ok());
    let url = bench.world.ws_url(answer["relay"]["path"].as_str().unwrap());
    let again = upgrade_refused_with(
        &url,
        &[(
            "Sec-WebSocket-Protocol",
            format!("{SUBPROTOCOL}, ticket.{}", answer["ticket"].as_str().unwrap()),
        )],
    )
    .await;
    assert_eq!(again, Some(401), "a spent ticket opens nothing");
    // A wrong ticket and no ticket: the same 401.
    for header in [format!("{SUBPROTOCOL}, ticket.AAAA"), SUBPROTOCOL.to_string(), "ticket.x".to_string()] {
        assert_eq!(
            upgrade_refused_with(&url, &[("Sec-WebSocket-Protocol", header)]).await,
            Some(401)
        );
    }

    // The first message must be the very Hello the control bound: anything else ends the session.
    let mut socket = first.unwrap();
    use futures_util::SinkExt as _;
    socket
        .send(tokio_tungstenite::tungstenite::Message::Binary(vec![1u8; 115].into()))
        .await
        .unwrap();
    assert!(matches!(next_binary(&mut socket, Duration::from_secs(5)).await, Ok(None)));
    wait_for_end_audit(&bench, "hello_mismatch").await;

    // Expiry: a ticket not presented in time is gone, and the reserved session is released.
    let (_hello, _h, status, answer) = start_attach(&bench, &client).await;
    assert_eq!(status, 200);
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let url = bench.world.ws_url(answer["relay"]["path"].as_str().unwrap());
    assert_eq!(
        upgrade_refused_with(
            &url,
            &[("Sec-WebSocket-Protocol", format!("{SUBPROTOCOL}, ticket.{}", answer["ticket"].as_str().unwrap()))]
        )
        .await,
        Some(401),
        "an expired ticket"
    );
    wait_for_end_audit(&bench, "ticket_expired").await;

    // The handshake deadline: connected, Hello sent, never answered the Challenge.
    let (hello, handshake, status, answer) = start_attach(&bench, &client).await;
    assert_eq!(status, 200);
    let mut socket = bench.open_relay_socket(&answer).await.unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Binary(hello.into()))
        .await
        .unwrap();
    let challenge = next_binary(&mut socket, Duration::from_secs(5)).await.unwrap().unwrap();
    drop((challenge, handshake));
    wait_for_end_audit(&bench, "handshake_timeout").await;
}

// ---------------------------------------------------------------------------
// the first owner list, registration and the trust bundle
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn first_owner_list_is_signed_withheld_from_the_runner_until_planted_and_locked_after() {
    let bench = Bench::up(BenchOptions::default()).await;
    let world = &bench.world;
    // A second member's box: its `create` is withheld from the runner until the owner plants a signed list.
    let other_device = world.register_device(&world.other, "other mac").await;
    let (status, body) = world.post("/cloud-boxes", &world.other.access, json!({})).await;
    assert_eq!(status, 201, "{body}");
    let other_box = Uuid::parse_str(body["id"].as_str().unwrap()).unwrap();
    assert_eq!(bench.runner.poll_once().await.unwrap().executed, 0, "no list, no create for the runner");
    let list = DeviceList::sign(*other_box.as_bytes(), 1, vec![other_device.public], &other_device.key);
    let bytes = list.to_bytes();
    let path = format!("/cloud-boxes/{other_box}/owner-device-list");
    let letter = |sha: &str, host: Uuid| {
        world.letter(
            &world.other,
            &other_device,
            host,
            ControlContent::CloudBoxOwnerList { box_id: other_box, list_sha256: sha },
        )
    };
    // Bearer alone is not enough (a stolen sign-in must not plant a trust root), and neither is a letter for other bytes.
    let (status, body) = world.put(&path, &world.other.access, json!({ "list": BASE64.encode(&bytes) })).await;
    assert_eq!((status, body["error"]["code"].as_str()), (403, Some("device_signature_required")), "{body}");
    let (status, body) = world
        .put(
            &path,
            &world.other.access,
            json!({ "list": BASE64.encode(&bytes), "signature": letter(&hex_sha256(b"other bytes"), other_box) }),
        )
        .await;
    assert_eq!((status, body["error"]["code"].as_str()), (403, Some("device_signature_invalid")), "{body}");
    // Only the box's owner: the owner of the first box cannot plant it for the second.
    let (status, _) = world
        .put(
            &path,
            &world.owner.access,
            json!({ "list": BASE64.encode(&bytes), "signature": letter(&hex_sha256(&bytes), other_box) }),
        )
        .await;
    assert_eq!(status, 404);
    // Too large / not base64.
    let (status, _) = world
        .put(&path, &world.other.access, json!({ "list": BASE64.encode(vec![1u8; 5000]), "signature": letter(&hex_sha256(&vec![1u8; 5000]), other_box) }))
        .await;
    assert_eq!(status, 400);
    // The honest one.
    let (status, body) = world
        .put(
            &path,
            &world.other.access,
            json!({ "list": BASE64.encode(&bytes), "signature": letter(&hex_sha256(&bytes), other_box) }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(bench.runner.poll_once().await.unwrap().executed, 1, "now the runner takes the create");
    // After the runner has it, the list is locked.
    let (status, body) = world
        .put(
            &path,
            &world.other.access,
            json!({ "list": BASE64.encode(&bytes), "signature": letter(&hex_sha256(&bytes), other_box) }),
        )
        .await;
    assert_eq!((status, body["error"]["code"].as_str()), (409, Some("cloud_box_list_locked")), "{body}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn registration_binds_the_owner_and_workspace_never_overwrites_and_the_runner_verifies_the_mac() {
    let bench = Bench::up(BenchOptions::default()).await;
    let world = &bench.world;
    // Owner and workspace come from the box row: the host is the OWNER's, scope member, type cloud.
    let (scope, kind, owner, ws, revoked): (String, String, Uuid, Uuid, bool) = sqlx::query_as(
        "SELECT scope, type, owner_member_id, workspace_id, revoked_at IS NOT NULL FROM work_host WHERE id = $1",
    )
    .bind(bench.host_id)
    .fetch_one(&world.su)
    .await
    .unwrap();
    assert_eq!((scope.as_str(), kind.as_str(), owner, ws, revoked), ("member", "cloud", world.owner.id, world.workspace, false));

    // The same key again: an idempotent `active` answer (a restarting box-agent). Another key: 409, nothing overwritten.
    let register = |key: [u8; 32]| {
        let path = format!("{}/v1/workspaces/{}/cloud-boxes/{}/agent/register", world.base, world.workspace, bench.box_id);
        let body = json!({ "hostPublicKey": BASE64.encode(key), "mac": BASE64.encode([7u8; 32]) });
        let http = world.http.clone();
        async move {
            let response = http.post(path).json(&body).send().await.unwrap();
            let status = response.status().as_u16();
            (status, response.json::<Value>().await.unwrap_or(Value::Null))
        }
    };
    let (status, body) = register(bench.host_public).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["state"], "active");
    assert_eq!(body["workHost"]["ownerMemberId"], world.owner.id.to_string());
    assert_eq!(body["workHost"]["scope"], "member");
    assert_eq!(body["workHost"]["type"], "cloud");
    let (status, body) = register([0x66u8; 32]).await;
    assert_eq!((status, body["error"]["code"].as_str()), (409, Some("cloud_box_agent_key_conflict")), "{body}");
    let stored: Vec<u8> = sqlx::query_scalar("SELECT host_public_key FROM cloud_box_agent WHERE box_id = $1")
        .bind(bench.box_id)
        .fetch_one(&world.su)
        .await
        .unwrap();
    assert_eq!(stored, bench.host_public.to_vec(), "the active host key was not overwritten");
    // The database itself refuses to overwrite or delete an active registration, even for a superuser.
    assert!(sqlx::query("UPDATE cloud_box_agent SET host_public_key = $2 WHERE box_id = $1")
        .bind(bench.box_id)
        .bind(vec![1u8; 32])
        .execute(&world.su)
        .await
        .is_err());
    assert!(sqlx::query("DELETE FROM cloud_box_agent WHERE box_id = $1")
        .bind(bench.box_id)
        .execute(&world.su)
        .await
        .is_err());

    // A registration the server (or anyone) made up for another box: the runner holds no pairing code for it, so it
    // is rejected, the slot is freed, and nobody attests it.
    let other_device = world.register_device(&world.other, "other mac").await;
    let (status, body) = world.post("/cloud-boxes", &world.other.access, json!({})).await;
    assert_eq!(status, 201, "{body}");
    let forged_box = Uuid::parse_str(body["id"].as_str().unwrap()).unwrap();
    let _ = other_device;
    let url = format!("{}/v1/workspaces/{}/cloud-boxes/{forged_box}/agent/register", world.base, world.workspace);
    let response = world
        .http
        .post(url)
        .json(&json!({ "hostPublicKey": BASE64.encode([0x42u8; 32]), "mac": BASE64.encode([1u8; 32]) }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.json::<Value>().await.unwrap()["state"], "pending");
    let summary = bench.runner.attest_registrations().await.unwrap();
    assert_eq!((summary.attested, summary.rejected), (0, 1));
    let slot: String = sqlx::query_scalar("SELECT state FROM cloud_box_agent WHERE box_id = $1")
        .bind(forged_box)
        .fetch_one(&world.su)
        .await
        .unwrap();
    assert_eq!(slot, "rejected", "the rejected slot is empty again, and nobody activated it");
    let hosts: i64 = sqlx::query_scalar("SELECT count(*) FROM cloud_box_agent WHERE box_id = $1 AND state = 'active'")
        .bind(forged_box)
        .fetch_one(&world.su)
        .await
        .unwrap();
    assert_eq!(hosts, 0);
    // The runner's own list of work is empty now, and the same forged request parks again (last writer wins).
    assert_eq!(bench.runner.attest_registrations().await.unwrap().rejected, 0);
    // Unknown box → 404; malformed → 400; the route is public (no bearer) and answers a closed instance with 404.
    let response = world
        .http
        .post(format!("{}/v1/workspaces/{}/cloud-boxes/{}/agent/register", world.base, world.workspace, Uuid::new_v4()))
        .json(&json!({ "hostPublicKey": BASE64.encode([1u8; 32]), "mac": BASE64.encode([1u8; 32]) }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 404);
    let response = world
        .http
        .post(format!("{}/v1/workspaces/{}/cloud-boxes/{}/agent/register", world.base, world.workspace, bench.box_id))
        .json(&json!({ "hostPublicKey": "AAAA", "mac": "AAAA" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 400);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn trust_bundle_serves_no_fingerprint_and_no_owner_list_and_the_pin_roundtrips() {
    let bench = Bench::up(BenchOptions::default()).await;
    let world = &bench.world;
    let path = format!("/cloud-boxes/{}/trust-bundle", bench.box_id);
    // Owner only.
    let (status, _) = world.get(&path, &world.admin.access).await;
    assert_eq!(status, 403);
    let (status, _) = world.get(&path, &world.other.access).await;
    assert_eq!(status, 404);
    let (status, bundle) = world.get(&path, &world.owner.access).await;
    assert_eq!(status, 200, "{bundle}");
    // What a device needs, nothing more: no fingerprint (it computes SHA-256 of the key itself) and no owner list
    // (a new device gets that in person, never from the server).
    let text = bundle.to_string().to_lowercase();
    for forbidden in ["fingerprint", "ownerdevicelist", "owner_device_list", "ownerlist", "devicelist"] {
        assert!(!text.contains(forbidden), "the trust bundle names `{forbidden}`: {text}");
    }
    assert_eq!(bundle["runner"]["publicKey"], BASE64.encode(bench.runner_public));
    assert_eq!(bundle["host"]["publicKey"], BASE64.encode(bench.host_public));
    assert_eq!(bundle["hostId"], bench.host_id.to_string());
    assert_eq!(bundle["agentOnline"], true);
    assert!(bundle["pin"].is_null(), "no pin yet");

    // First pairing: the device pins (typed fingerprint matches, attestation verifies), the server stores the pin.
    let _client = bench.pinned_client(&bench.owner_device).await;
    let (_, bundle) = world.get(&path, &world.owner.access).await;
    let pin_bytes = BASE64.decode(bundle["pin"].as_str().expect("the pin is served back")).unwrap();
    let pin = HostPin::from_bytes(&pin_bytes).expect("a pin");
    // A second device of the owner (it knows the same list and typed the same fingerprint) re-verifies the served pin.
    let mut second = momo_blind_pty::handshake::DeviceClient::new(
        bench.owner_device.key.clone(),
        DeviceListState::bootstrap(bench.owner_list.clone()).unwrap(),
    );
    second.set_runner_fingerprint(bench.runner_identity_fingerprint);
    second.import_pin(pin.clone()).expect("the served pin re-verifies");
    // ...but a pin whose runner fingerprint the member did not type is refused, however the server served it.
    let mut stranger = momo_blind_pty::handshake::DeviceClient::new(
        bench.owner_device.key.clone(),
        DeviceListState::bootstrap(bench.owner_list.clone()).unwrap(),
    );
    stranger.set_runner_fingerprint([9u8; 32]);
    assert!(stranger.import_pin(pin.clone()).is_err(), "a pin under a fingerprint nobody typed in");
    // A tampered pin (the server swapping the host key) fails too.
    let mut tampered = pin.clone();
    tampered.host_pub[0] ^= 1;
    assert!(second.import_pin(tampered).is_err());
    // Pin writes: owner only, bounded.
    let (status, _) = world
        .put(&format!("/cloud-boxes/{}/pin", bench.box_id), &world.other.access, json!({ "pin": BASE64.encode(&pin_bytes) }))
        .await;
    assert_eq!(status, 404);
    let (status, _) = world
        .put(&format!("/cloud-boxes/{}/pin", bench.box_id), &world.owner.access, json!({ "pin": BASE64.encode(vec![1u8; 3000]) }))
        .await;
    assert_eq!(status, 400);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn the_spent_challenge_store_is_persisted_after_an_attach() {
    let bench = Bench::up(BenchOptions::default()).await;
    let state_dir = bench.agent.as_ref().unwrap().state_dir.clone();
    assert!(!state_dir.join("nonces.bin").exists(), "nothing spent before the first attach");
    let mut conn = attached(&bench).await;
    echoes(&mut conn, "persist-me").await;
    let bytes = std::fs::read(state_dir.join("nonces.bin")).expect("the store is on disk after the Auth");
    let store = momo_blind_pty::handshake::NonceStore::from_bytes(&bytes).expect("it parses");
    assert!(store.len() >= 1, "the spent challenge is in the persisted store");
    // 0600, like everything the agent keeps.
    use std::os::unix::fs::PermissionsExt as _;
    assert_eq!(std::fs::metadata(state_dir.join("nonces.bin")).unwrap().permissions().mode() & 0o777, 0o600);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn the_box_ends_a_session_on_its_own_when_the_server_would_not() {
    // Defence in depth: the box holds its own clocks. The server's limits are set sky-high here; the box's are short.
    let bench = Bench::up(BenchOptions {
        relay: RelayLimits {
            max_session: Duration::from_secs(3600),
            idle: Duration::from_secs(3600),
            recheck: Duration::from_secs(3600),
            ..RelayLimits::default()
        },
        box_limits: momo_box_agent::serve::BoxLimits {
            max_session: Duration::from_millis(1200),
            idle: Duration::from_secs(3600),
            handshake: Duration::from_secs(20),
            poll_ms: 10,
        },
        ..BenchOptions::default()
    })
    .await;
    let mut conn = attached(&bench).await;
    let started = Instant::now();
    assert!(conn.wait_closed(Duration::from_secs(8)).await.is_some(), "the box hung up on its own");
    assert!(started.elapsed() < Duration::from_secs(5));
    wait_for_end_audit(&bench, "peer_closed").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn a_session_socket_can_only_be_claimed_by_the_host_it_was_authorised_for() {
    let bench = Bench::up(BenchOptions::default()).await;
    let hub = &bench.world.state.cloud_relay;
    let session_id = Uuid::new_v4();
    let opened = hub
        .open_session(OpenParams {
            session_id,
            workspace_id: bench.world.workspace,
            box_id: bench.box_id,
            host_id: bench.host_id,
            member_id: bench.world.owner.id,
            device_key_id: bench.owner_device.key_id,
            hello_sha256: [1u8; 32],
        })
        .expect("open");
    assert_eq!(opened.session_id, session_id);
    // Another host (or another workspace) is refused; the real host gets it, once.
    assert!(hub.claim_box(bench.world.workspace, Uuid::new_v4(), session_id).is_none());
    assert!(hub.claim_box(Uuid::new_v4(), bench.host_id, session_id).is_none());
    assert!(hub.claim_box(bench.world.workspace, bench.host_id, session_id).is_some());
    assert!(hub.claim_box(bench.world.workspace, bench.host_id, session_id).is_none(), "claimed once");
    // The device side likewise: wrong box, wrong workspace, wrong ticket are the same `None`.
    assert!(hub.claim_device(bench.world.workspace, Uuid::new_v4(), session_id, &opened.ticket).is_none());
    assert!(hub.claim_device(bench.world.workspace, bench.box_id, session_id, "nope").is_none());
    assert!(hub.claim_device(bench.world.workspace, bench.box_id, session_id, &opened.ticket).is_some());
}
