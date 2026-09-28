//! Shared human-signing vectors (#3021, ADR-0146 개정 2026-09-28 D-5).
//!
//! `docs/api/human-control-signing.vectors.json` holds each case's inputs, the
//! bytes JS and Swift built from them (the generator refuses to write unless the
//! two agree), and signatures made by WebCrypto, CryptoKit and a Secure Enclave
//! key. This file is the third implementation: it rebuilds the bytes from the
//! inputs through `momo_wire::human_control`, checks them against the recorded
//! ones, and verifies every signature — then shows that changing any one line,
//! any one content field, or the key breaks verification.
//!
//! The JSON is read from a test only: the server image does not copy `docs/api`.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_wire::human_control::{
    normalize_p256_signature, verify_p256, ControlContent, DeviceEndorse, DeviceKeyAlg,
    DeviceRevoke, HumanControl, HumanSigningError, InputMode, PermissionScope,
};
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization as _;
use uuid::Uuid;

const VECTORS: &str = include_str!("../../../../docs/api/human-control-signing.vectors.json");

fn doc() -> Value {
    serde_json::from_str(VECTORS).expect("vectors parse")
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("string field {k}"))
}
fn u(v: &Value, k: &str) -> Uuid {
    s(v, k).parse().unwrap_or_else(|_| panic!("uuid field {k}"))
}
fn i(v: &Value, k: &str) -> i64 {
    v[k].as_i64().unwrap_or_else(|| panic!("int field {k}"))
}

fn content(c: &Value) -> ControlContent<'_> {
    match s(c, "kind") {
        "input" => ControlContent::Input {
            mode: match s(c, "mode") {
                "queue" => InputMode::Queue,
                "interrupt" => InputMode::Interrupt,
                m => panic!("mode {m}"),
            },
            text: s(c, "text"),
        },
        "spawn" => ControlContent::Spawn {
            agent_member_id: u(c, "agent_member_id"),
            folder_id: s(c, "folder_id"),
            first_prompt: s(c, "first_prompt"),
        },
        "permission" => ControlContent::Permission {
            request_event_id: u(c, "request_event_id"),
            option_id: s(c, "option_id"),
            option_kind: s(c, "option_kind"),
            scope: match s(c, "scope") {
                "once" => PermissionScope::Once,
                "session" => PermissionScope::Session,
                x => panic!("scope {x}"),
            },
        },
        "bundle_manifest" => ControlContent::BundleManifest {
            manifest: &c["manifest"],
        },
        "host_register" => ControlContent::HostRegister {
            host_public_key_b64: s(c, "host_public_key_b64"),
            host_id: u(c, "host_id"),
            label: s(c, "label"),
        },
        k => panic!("kind {k}"),
    }
}

fn control(tc: &Value) -> HumanControl<'_> {
    let f = &tc["fields"];
    HumanControl {
        instance_id: s(f, "instance_id"),
        workspace_id: u(f, "workspace_id"),
        member_id: u(f, "member_id"),
        device_key_id: u(f, "device_key_id"),
        host_id: u(f, "host_id"),
        session_id: if f["session_id"].is_null() {
            None
        } else {
            Some(u(f, "session_id"))
        },
        nonce: u(f, "nonce"),
        issued_at_ms: i(f, "issued_at_ms"),
        expires_at_ms: i(f, "expires_at_ms"),
        content: content(&tc["content"]),
    }
}

fn endorse(tc: &Value) -> DeviceEndorse<'_> {
    let f = &tc["fields"];
    assert_eq!(s(f, "target_alg"), "p256");
    DeviceEndorse {
        workspace_id: u(f, "workspace_id"),
        member_id: u(f, "member_id"),
        root_key_id: u(f, "root_key_id"),
        target_alg: DeviceKeyAlg::P256,
        target_public_key_b64: s(f, "target_public_key_b64"),
        label: s(f, "label"),
    }
}

fn revoke(tc: &Value) -> DeviceRevoke {
    let f = &tc["fields"];
    DeviceRevoke {
        workspace_id: u(f, "workspace_id"),
        member_id: u(f, "member_id"),
        root_key_id: u(f, "root_key_id"),
        target_key_id: u(f, "target_key_id"),
        revoked_at_ms: i(f, "revoked_at_ms"),
    }
}

fn rebuild(tc: &Value) -> Vec<u8> {
    match s(tc, "schema") {
        "momo.human.control.v1" => control(tc).signed_bytes().expect("control bytes"),
        "momo.human.device_endorse.v1" => endorse(tc).signed_bytes().expect("endorse bytes"),
        "momo.human.device_revoke.v1" => revoke(tc).signed_bytes(),
        x => panic!("schema {x}"),
    }
}

struct Sig {
    signer: String,
    key: Vec<u8>,
    sig: Vec<u8>,
}

fn sigs(tc: &Value) -> Vec<Sig> {
    tc["signatures"]
        .as_array()
        .expect("signatures")
        .iter()
        .map(|x| Sig {
            signer: s(x, "signer").to_string(),
            key: BASE64.decode(s(x, "public_key")).unwrap(),
            sig: BASE64.decode(s(x, "signature")).unwrap(),
        })
        .collect()
}

fn cases() -> Vec<Value> {
    doc()["cases"].as_array().expect("cases").clone()
}

#[test]
fn the_file_covers_every_schema_kind_and_signer() {
    let cases = cases();
    let mut seen: Vec<String> = cases
        .iter()
        .map(|tc| match tc.get("content") {
            Some(c) => format!("control/{}", s(c, "kind")),
            None => s(tc, "schema").to_string(),
        })
        .collect();
    seen.sort();
    seen.dedup();
    assert_eq!(
        seen,
        [
            "control/bundle_manifest",
            "control/host_register",
            "control/input",
            "control/permission",
            "control/spawn",
            "momo.human.device_endorse.v1",
            "momo.human.device_revoke.v1",
        ]
    );
    for tc in &cases {
        let signers: Vec<_> = sigs(tc).into_iter().map(|x| x.signer).collect();
        assert_eq!(
            signers,
            ["webcrypto", "cryptokit", "cryptokit-secure-enclave"],
            "{}",
            s(tc, "name")
        );
    }
    assert_eq!(
        doc()["high_s_rule"].as_str().unwrap().split(':').next(),
        Some("normalize-then-verify")
    );
}

#[test]
fn rust_rebuilds_the_bytes_js_and_swift_recorded() {
    for tc in cases() {
        let name = s(&tc, "name");
        let bytes = rebuild(&tc);
        assert_eq!(
            String::from_utf8(bytes.clone()).unwrap(),
            s(&tc, "payload"),
            "{name}"
        );
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            s(&tc, "payload_sha256"),
            "{name}"
        );
        if let Some(c) = tc.get("content") {
            let content = content(c);
            assert_eq!(
                String::from_utf8(content.canonical_bytes().unwrap()).unwrap(),
                s(&tc, "content_canonical"),
                "{name}"
            );
            assert_eq!(
                content.content_sha256().unwrap(),
                s(&tc, "content_sha256"),
                "{name}"
            );
            assert_eq!(bytes.split(|b| *b == b'\n').count(), 13, "{name}");
        }
    }
}

#[test]
fn every_recorded_signature_verifies() {
    let mut n = 0;
    for tc in cases() {
        let bytes = rebuild(&tc);
        for x in sigs(&tc) {
            verify_p256(&x.key, &bytes, &x.sig)
                .unwrap_or_else(|e| panic!("{} / {}: {e}", s(&tc, "name"), x.signer));
            n += 1;
        }
        // The typed verifiers agree with the raw one.
        let x = &sigs(&tc)[0];
        match s(&tc, "schema") {
            "momo.human.control.v1" => control(&tc).verify(&x.key, &x.sig).map(|_| ()),
            "momo.human.device_endorse.v1" => endorse(&tc).verify(&x.key, &x.sig).map(|_| ()),
            _ => revoke(&tc).verify(&x.key, &x.sig).map(|_| ()),
        }
        .expect("typed verify");
    }
    assert_eq!(n, 24);
}

/// Guard against a tool NFC-normalizing the vectors file: the NFC case must
/// still carry decomposed input, or it no longer tests normalization at all.
#[test]
fn the_nfc_cases_really_are_decomposed() {
    let cases = cases();
    let find = |name: &str| cases.iter().find(|c| s(c, "name") == name).unwrap().clone();
    let tc = find("control_input_queue_nfc");
    let text = s(&tc["content"], "text");
    let nfc: String = text.nfc().collect();
    assert_ne!(text, nfc);
    assert_eq!(nfc, s(&tc, "content_canonical"));
    let label = s(&find("device_endorse")["fields"], "label").to_string();
    assert_ne!(label, label.nfc().collect::<String>());
    // And without NFC the hash would differ, so the step is load-bearing.
    assert_ne!(
        hex::encode(Sha256::digest(text.as_bytes())),
        s(&tc, "content_sha256")
    );
}

/// Changing any one of the 13 (control) / 7 (endorse) / 6 (revoke) lines
/// breaks every recorded signature.
#[test]
fn every_line_is_load_bearing() {
    let mut checked = 0;
    for tc in cases() {
        let bytes = rebuild(&tc);
        let text = String::from_utf8(bytes).unwrap();
        let lines: Vec<&str> = text.split('\n').collect();
        for (idx, _) in lines.iter().enumerate() {
            let mut changed: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
            changed[idx].push('x');
            let tampered = changed.join("\n");
            for x in sigs(&tc) {
                assert_eq!(
                    verify_p256(&x.key, tampered.as_bytes(), &x.sig),
                    Err(HumanSigningError::BadSignature),
                    "{} line {idx} / {}",
                    s(&tc, "name"),
                    x.signer
                );
                checked += 1;
            }
        }
    }
    // 6 controls × 13 + endorse 7 + revoke 6 = 91 lines, × 3 signers.
    assert_eq!(checked, 91 * 3);
}

/// Changing any one structured input — including every content field — makes
/// the rebuilt bytes fail against the recorded signature (or refuses to build).
#[test]
fn every_structured_field_is_load_bearing() {
    let other = Uuid::from_u128(0xdead_beef);
    let manifest_changed = |tc: &Value| {
        let mut m = tc["content"]["manifest"].clone();
        m["version"] = Value::from(2);
        m
    };
    let mut checked = 0;
    for tc in cases() {
        let name = s(&tc, "name").to_string();
        let x = &sigs(&tc)[0];
        // A refusal to build is also a rejection; a build must not verify.
        let rejects = |bytes: Result<Vec<u8>, HumanSigningError>, what: &str| {
            if let Ok(b) = bytes {
                assert!(
                    verify_p256(&x.key, &b, &x.sig).is_err(),
                    "{name}: changing {what} still verifies"
                );
            }
        };
        match s(&tc, "schema") {
            "momo.human.control.v1" => {
                let base = control(&tc);
                let mut muts: Vec<(&str, HumanControl)> = vec![
                    (
                        "instance_id",
                        HumanControl {
                            instance_id: "inst_other",
                            ..base.clone()
                        },
                    ),
                    (
                        "workspace_id",
                        HumanControl {
                            workspace_id: other,
                            ..base.clone()
                        },
                    ),
                    (
                        "member_id",
                        HumanControl {
                            member_id: other,
                            ..base.clone()
                        },
                    ),
                    (
                        "device_key_id",
                        HumanControl {
                            device_key_id: other,
                            ..base.clone()
                        },
                    ),
                    (
                        "nonce",
                        HumanControl {
                            nonce: other,
                            ..base.clone()
                        },
                    ),
                    (
                        "issued_at_ms",
                        HumanControl {
                            issued_at_ms: base.issued_at_ms + 1,
                            ..base.clone()
                        },
                    ),
                    (
                        "expires_at_ms",
                        HumanControl {
                            expires_at_ms: base.expires_at_ms - 1,
                            ..base.clone()
                        },
                    ),
                    (
                        "session_id",
                        HumanControl {
                            session_id: Some(base.session_id.map_or(other, |_| other)),
                            ..base.clone()
                        },
                    ),
                ];
                if !matches!(base.content, ControlContent::HostRegister { .. }) {
                    muts.push((
                        "host_id",
                        HumanControl {
                            host_id: other,
                            ..base.clone()
                        },
                    ));
                }
                let manifest = manifest_changed(&tc);
                let content_muts: Vec<(&str, ControlContent)> = match &base.content {
                    ControlContent::Input { mode, text } => vec![
                        (
                            "mode",
                            ControlContent::Input {
                                mode: if *mode == InputMode::Queue {
                                    InputMode::Interrupt
                                } else {
                                    InputMode::Queue
                                },
                                text,
                            },
                        ),
                        (
                            "text",
                            ControlContent::Input {
                                mode: *mode,
                                text: "something else",
                            },
                        ),
                        // kind: same text, other kind.
                        (
                            "kind",
                            ControlContent::Spawn {
                                agent_member_id: other,
                                folder_id: "f",
                                first_prompt: text,
                            },
                        ),
                    ],
                    ControlContent::Spawn {
                        agent_member_id,
                        folder_id,
                        first_prompt,
                    } => vec![
                        (
                            "agent_member_id",
                            ControlContent::Spawn {
                                agent_member_id: other,
                                folder_id,
                                first_prompt,
                            },
                        ),
                        (
                            "folder_id",
                            ControlContent::Spawn {
                                agent_member_id: *agent_member_id,
                                folder_id: "fld_other",
                                first_prompt,
                            },
                        ),
                        (
                            "first_prompt",
                            ControlContent::Spawn {
                                agent_member_id: *agent_member_id,
                                folder_id,
                                first_prompt: "other",
                            },
                        ),
                    ],
                    ControlContent::Permission {
                        request_event_id,
                        option_id,
                        option_kind,
                        scope,
                    } => vec![
                        (
                            "request_event_id",
                            ControlContent::Permission {
                                request_event_id: other,
                                option_id,
                                option_kind,
                                scope: *scope,
                            },
                        ),
                        (
                            "option_id",
                            ControlContent::Permission {
                                request_event_id: *request_event_id,
                                option_id: "reject-once",
                                option_kind,
                                scope: *scope,
                            },
                        ),
                        (
                            "option_kind",
                            ControlContent::Permission {
                                request_event_id: *request_event_id,
                                option_id,
                                option_kind: "allow_always",
                                scope: *scope,
                            },
                        ),
                        (
                            "scope",
                            ControlContent::Permission {
                                request_event_id: *request_event_id,
                                option_id,
                                option_kind,
                                scope: if *scope == PermissionScope::Once {
                                    PermissionScope::Session
                                } else {
                                    PermissionScope::Once
                                },
                            },
                        ),
                    ],
                    ControlContent::BundleManifest { .. } => {
                        vec![(
                            "manifest",
                            ControlContent::BundleManifest {
                                manifest: &manifest,
                            },
                        )]
                    }
                    ControlContent::HostRegister {
                        host_public_key_b64,
                        host_id,
                        label,
                    } => vec![
                        (
                            "host_public_key_b64",
                            ControlContent::HostRegister {
                                host_public_key_b64: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
                                host_id: *host_id,
                                label,
                            },
                        ),
                        (
                            "label",
                            ControlContent::HostRegister {
                                host_public_key_b64,
                                host_id: *host_id,
                                label: "other",
                            },
                        ),
                    ],
                };
                for (what, m) in muts {
                    rejects(m.signed_bytes(), what);
                    checked += 1;
                }
                for (what, content) in content_muts {
                    let m = HumanControl {
                        content,
                        ..base.clone()
                    };
                    rejects(m.signed_bytes(), what);
                    checked += 1;
                }
                if let ControlContent::HostRegister {
                    host_public_key_b64,
                    label,
                    ..
                } = base.content
                {
                    // host_id lives in the payload and the content; they must move together.
                    let m = HumanControl {
                        host_id: other,
                        content: ControlContent::HostRegister {
                            host_public_key_b64,
                            host_id: other,
                            label,
                        },
                        ..base.clone()
                    };
                    rejects(m.signed_bytes(), "host_id");
                    assert_eq!(
                        HumanControl {
                            host_id: other,
                            ..base.clone()
                        }
                        .signed_bytes(),
                        Err(HumanSigningError::HostIdMismatch)
                    );
                    checked += 1;
                }
            }
            "momo.human.device_endorse.v1" => {
                let base = endorse(&tc);
                // Another valid compressed point (the webcrypto key of this case).
                let other_key = BASE64.encode(&sigs(&tc)[0].key);
                for (what, m) in [
                    (
                        "workspace_id",
                        DeviceEndorse {
                            workspace_id: other,
                            ..base.clone()
                        },
                    ),
                    (
                        "member_id",
                        DeviceEndorse {
                            member_id: other,
                            ..base.clone()
                        },
                    ),
                    (
                        "root_key_id",
                        DeviceEndorse {
                            root_key_id: other,
                            ..base.clone()
                        },
                    ),
                    (
                        "target_public_key_b64",
                        DeviceEndorse {
                            target_public_key_b64: &other_key,
                            ..base.clone()
                        },
                    ),
                    (
                        "label",
                        DeviceEndorse {
                            label: "other",
                            ..base.clone()
                        },
                    ),
                ] {
                    rejects(m.signed_bytes(), what);
                    checked += 1;
                }
            }
            _ => {
                let base = revoke(&tc);
                for (what, m) in [
                    (
                        "workspace_id",
                        DeviceRevoke {
                            workspace_id: other,
                            ..base
                        },
                    ),
                    (
                        "member_id",
                        DeviceRevoke {
                            member_id: other,
                            ..base
                        },
                    ),
                    (
                        "root_key_id",
                        DeviceRevoke {
                            root_key_id: other,
                            ..base
                        },
                    ),
                    (
                        "target_key_id",
                        DeviceRevoke {
                            target_key_id: other,
                            ..base
                        },
                    ),
                    (
                        "revoked_at_ms",
                        DeviceRevoke {
                            revoked_at_ms: base.revoked_at_ms + 1,
                            ..base
                        },
                    ),
                ] {
                    rejects(Ok(m.signed_bytes()), what);
                    checked += 1;
                }
            }
        }
    }
    // input×2 (9+3 each) + spawn (9+3) + permission (9+4) + manifest (9+1)
    // + host_register (8+2+1) + endorse 5 + revoke 5.
    assert_eq!(checked, 24 + 12 + 13 + 10 + 11 + 5 + 5);
}

fn flip_s(sig: &[u8]) -> Vec<u8> {
    let parsed = Signature::from_slice(sig).unwrap();
    let (r, s) = parsed.split_scalars();
    let neg = -*s;
    Signature::from_scalars(r.to_bytes(), neg.to_bytes())
        .unwrap()
        .to_bytes()
        .to_vec()
}

fn is_high(sig: &[u8]) -> bool {
    let parsed = Signature::from_slice(sig).unwrap();
    parsed.normalize_s().to_bytes().as_slice() != sig
}

/// The one high-s rule: normalize, then verify. Both `s` and `n − s` verify,
/// and both return the same canonical low-s bytes.
#[test]
fn high_s_is_normalized_then_verified() {
    let (mut high, mut low) = (0, 0);
    for tc in cases() {
        let bytes = rebuild(&tc);
        for x in sigs(&tc) {
            let flipped = flip_s(&x.sig);
            assert_ne!(flipped, x.sig);
            let (hi, lo) = if is_high(&x.sig) {
                high += 1;
                (x.sig.clone(), flipped)
            } else {
                low += 1;
                (flipped, x.sig.clone())
            };
            assert!(is_high(&hi) && !is_high(&lo));
            let from_hi = verify_p256(&x.key, &bytes, &hi).expect("high-s verifies");
            let from_lo = verify_p256(&x.key, &bytes, &lo).expect("low-s verifies");
            assert_eq!(from_hi, from_lo);
            assert_eq!(from_lo.as_slice(), lo.as_slice());
            assert_eq!(
                normalize_p256_signature(&hi).unwrap().as_slice(),
                lo.as_slice()
            );
        }
    }
    assert_eq!(high + low, 24);
    eprintln!("recorded signatures: {high} high-s, {low} low-s (flipped variants cover both)");
}

#[test]
fn malformed_keys_and_signatures_are_refused() {
    let tc = &cases()[0];
    let bytes = rebuild(tc);
    let all = sigs(tc);
    let x = &all[0];

    // Another signer's key does not verify this signature.
    assert_eq!(
        verify_p256(&all[1].key, &bytes, &x.sig),
        Err(HumanSigningError::BadSignature)
    );
    // A flipped signature bit does not verify.
    let mut bad = x.sig.clone();
    bad[10] ^= 1;
    assert!(verify_p256(&x.key, &bytes, &bad).is_err());

    // The same point uncompressed (65 bytes) is refused: one stored form.
    let vk = VerifyingKey::from_sec1_bytes(&x.key).unwrap();
    let uncompressed = vk.to_sec1_point(false).as_bytes().to_vec();
    assert_eq!(uncompressed.len(), 65);
    assert_eq!(
        verify_p256(&uncompressed, &bytes, &x.sig),
        Err(HumanSigningError::PublicKey)
    );
    // Wrong prefix / not on the curve.
    let mut k = x.key.clone();
    k[0] = 0x04;
    assert_eq!(
        verify_p256(&k, &bytes, &x.sig),
        Err(HumanSigningError::PublicKey)
    );
    let mut k = x.key.clone();
    k[1..].fill(0xff);
    assert_eq!(
        verify_p256(&k, &bytes, &x.sig),
        Err(HumanSigningError::PublicKey)
    );

    // Lengths, zero scalars, s = n.
    for len in [0, 63, 65, 72] {
        let mut s = x.sig.clone();
        s.resize(len, 0);
        assert_eq!(
            verify_p256(&x.key, &bytes, &s),
            Err(HumanSigningError::SignatureEncoding),
            "len {len}"
        );
    }
    let mut zero_r = x.sig.clone();
    zero_r[..32].fill(0);
    assert_eq!(
        verify_p256(&x.key, &bytes, &zero_r),
        Err(HumanSigningError::SignatureEncoding)
    );
    let mut zero_s = x.sig.clone();
    zero_s[32..].fill(0);
    assert_eq!(
        verify_p256(&x.key, &bytes, &zero_s),
        Err(HumanSigningError::SignatureEncoding)
    );
    let n =
        hex::decode("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551").unwrap();
    let mut s_eq_n = x.sig.clone();
    s_eq_n[32..].copy_from_slice(&n);
    assert_eq!(
        verify_p256(&x.key, &bytes, &s_eq_n),
        Err(HumanSigningError::SignatureEncoding)
    );
}

#[test]
fn structural_rules_are_enforced_before_any_signature() {
    let tc = &cases()[0]; // input, has a session
    let base = control(tc);
    assert_eq!(
        HumanControl {
            session_id: None,
            ..base.clone()
        }
        .signed_bytes(),
        Err(HumanSigningError::SessionRequired("input"))
    );
    let spawn = cases()
        .into_iter()
        .find(|c| s(c, "name") == "control_spawn")
        .unwrap();
    let sp = control(&spawn);
    assert_eq!(
        HumanControl {
            session_id: Some(Uuid::nil()),
            ..sp.clone()
        }
        .signed_bytes(),
        Err(HumanSigningError::SessionForbidden("spawn"))
    );
    for bad in ["", "a\nb", "a\u{7f}"] {
        assert!(
            matches!(
                HumanControl {
                    instance_id: bad,
                    ..base.clone()
                }
                .signed_bytes(),
                Err(HumanSigningError::InvalidField {
                    field: "instance_id",
                    ..
                })
            ),
            "{bad:?}"
        );
    }
    // Endorse: non-canonical / wrong-length / off-curve target keys.
    let e = cases()
        .into_iter()
        .find(|c| s(c, "name") == "device_endorse")
        .unwrap();
    let base = endorse(&e);
    for bad in [
        "A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW=",
        "ERERERERERERERERERERERERERERERERERERERERERE=",
        "BGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW",
    ] {
        assert!(
            DeviceEndorse {
                target_public_key_b64: bad,
                ..base.clone()
            }
            .signed_bytes()
            .is_err(),
            "{bad}"
        );
    }
    assert!(DeviceEndorse {
        label: "a\nb",
        ..base.clone()
    }
    .signed_bytes()
    .is_err());
}
