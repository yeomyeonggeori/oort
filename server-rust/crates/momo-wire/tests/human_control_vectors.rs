//! Shared human-signing vectors (#3021, ADR-0146 개정 2026-09-28 D-5; v2 #3027).
//!
//! `docs/api/human-control-signing.vectors.json` (v1, frozen — the phone keeps a
//! byte-identical copy) and `docs/api/human-control-signing-v2.vectors.json`
//! (`momo.human.control.v2`) hold each case's inputs, the
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
    normalize_p256_signature, verify_p256, ControlContent, ControlSchema, DeviceEndorse,
    DeviceKeyAlg, DeviceRevoke, HumanControl, HumanSigningError, InputMode, PermissionScope,
};
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization as _;
use uuid::Uuid;

const VECTORS: &str = include_str!("../../../../docs/api/human-control-signing.vectors.json");
const VECTORS_V2: &str = include_str!("../../../../docs/api/human-control-signing-v2.vectors.json");
const VECTORS_V3: &str = include_str!("../../../../docs/api/human-control-signing-v3.vectors.json");

/// A well-formed preview hash no vector preview has.
const OTHER_PREVIEW_SHA256: &str =
    "1111111111111111111111111111111111111111111111111111111111111111";

fn doc() -> Value {
    serde_json::from_str(VECTORS).expect("vectors parse")
}

fn doc_v2() -> Value {
    serde_json::from_str(VECTORS_V2).expect("v2 vectors parse")
}

fn doc_v3() -> Value {
    serde_json::from_str(VECTORS_V3).expect("v3 vectors parse")
}

/// The control schema a case is written in (`None` for endorse / revoke).
fn schema_of(tc: &Value) -> Option<ControlSchema> {
    match s(tc, "schema") {
        "momo.human.control.v1" => Some(ControlSchema::V1),
        "momo.human.control.v2" => Some(ControlSchema::V2),
        "momo.human.control.v3" => Some(ControlSchema::V3),
        _ => None,
    }
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
        // v1 cases carry no tool / channel (v1 does not encode them).
        "spawn" => ControlContent::Spawn {
            agent_member_id: u(c, "agent_member_id"),
            folder_id: s(c, "folder_id"),
            tool: c["tool"].as_str().unwrap_or(""),
            channel_id: c["channel_id"]
                .as_str()
                .map_or(Uuid::nil(), |id| id.parse().expect("channel_id")),
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
            // v3 (#3118) cases carry the preview's hash.
            preview_sha256: c["preview_sha256"].as_str(),
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
        "momo.human.control.v1" | "momo.human.control.v2" | "momo.human.control.v3" => control(tc)
            .signed_bytes_as(schema_of(tc).unwrap())
            .expect("control bytes"),
        "momo.human.device_endorse.v1" => endorse(tc).signed_bytes().expect("endorse bytes"),
        "momo.human.device_revoke.v1" => revoke(tc).signed_bytes(),
        "momo.human.device_revoke.v2" => revoke(tc)
            .signed_bytes_v2(s(&tc["fields"], "target_public_key_b64"))
            .expect("revoke v2 bytes"),
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

/// v1 cases, then v2, then v3.
fn cases() -> Vec<Value> {
    let mut all = doc()["cases"].as_array().expect("cases").clone();
    all.extend(doc_v2()["cases"].as_array().expect("v2 cases").clone());
    all.extend(doc_v3()["cases"].as_array().expect("v3 cases").clone());
    all
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
            "momo.human.device_revoke.v2",
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
    // v2: every control kind, and a spawn both fresh and resumed.
    let v2: Vec<Value> = doc_v2()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|tc| s(tc, "schema") == "momo.human.control.v2")
        .cloned()
        .collect();
    assert_eq!(v2.len(), 7);
    let mut kinds: Vec<&str> = v2.iter().map(|tc| s(&tc["content"], "kind")).collect();
    kinds.sort();
    kinds.dedup();
    assert_eq!(
        kinds,
        [
            "bundle_manifest",
            "host_register",
            "input",
            "permission",
            "spawn"
        ]
    );
    let spawn_sessions: Vec<bool> = v2
        .iter()
        .filter(|tc| s(&tc["content"], "kind") == "spawn")
        .map(|tc| tc["fields"]["session_id"].is_null())
        .collect();
    assert_eq!(spawn_sessions, [true, false]);
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
            let schema = schema_of(&tc).unwrap();
            assert_eq!(
                String::from_utf8(content.canonical_bytes_as(schema).unwrap()).unwrap(),
                s(&tc, "content_canonical"),
                "{name}"
            );
            assert_eq!(
                content.content_sha256_as(schema).unwrap(),
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
            "momo.human.control.v1" | "momo.human.control.v2" | "momo.human.control.v3" => {
                control(&tc)
                    .verify_as(schema_of(&tc).unwrap(), &x.key, &x.sig)
                    .map(|_| ())
            }
            "momo.human.device_endorse.v1" => endorse(&tc).verify(&x.key, &x.sig).map(|_| ()),
            "momo.human.device_revoke.v2" => revoke(&tc)
                .verify_v2(s(&tc["fields"], "target_public_key_b64"), &x.key, &x.sig)
                .map(|_| ()),
            _ => revoke(&tc).verify(&x.key, &x.sig).map(|_| ()),
        }
        .expect("typed verify");
    }
    // v1 8 cases, v2 7 + revoke v2, v3 7 (#3118) — × 3 signers.
    assert_eq!(n, 24 + 21 + 3 + 21);
}

/// What a verifier accepts ([`HumanControl::verify_any`]): every v2 and v3
/// statement, and **no** v1 one (#3154). The v1 bytes still build (the
/// signatures in the vectors verify as raw P-256 over them, above); what is
/// refused is the schema, for the kinds whose v1 bytes once said the same as
/// v2's as well as for `spawn`.
#[test]
fn verify_any_refuses_every_v1_statement() {
    let mut v1_refused = Vec::new();
    for tc in cases() {
        let Some(schema) = schema_of(&tc) else {
            continue;
        };
        let name = s(&tc, "name").to_string();
        let kind = s(&tc["content"], "kind").to_string();
        let mut statement = control(&tc);
        // A v1 spawn case has no tool/channel; give it v2's so the v2 bytes
        // build and the refusal is the schema's, not a missing field's.
        if let (
            ControlSchema::V1,
            ControlContent::Spawn {
                agent_member_id,
                folder_id,
                first_prompt,
                ..
            },
        ) = (schema, &statement.content)
        {
            let (agent_member_id, folder_id, first_prompt) =
                (*agent_member_id, *folder_id, *first_prompt);
            statement.content = ControlContent::Spawn {
                agent_member_id,
                folder_id,
                tool: "claude",
                channel_id: Uuid::from_u128(0xcc01),
                first_prompt,
            };
        }
        for x in sigs(&tc) {
            let verdict = statement.verify_any(&x.key, &x.sig);
            match schema {
                ControlSchema::V3 => {
                    let v = verdict.unwrap_or_else(|e| panic!("{name}: {e}"));
                    assert_eq!(v.schema, ControlSchema::V3, "{name}");
                    assert_eq!(v.signed_bytes, rebuild(&tc), "{name}");
                }
                ControlSchema::V2 => {
                    let v = verdict.unwrap_or_else(|e| panic!("{name}: {e}"));
                    assert_eq!(v.schema, ControlSchema::V2, "{name}");
                    assert_eq!(v.signed_bytes, rebuild(&tc), "{name}");
                }
                ControlSchema::V1 => {
                    assert_eq!(
                        verdict,
                        Err(HumanSigningError::BadSignature),
                        "{name} ({kind}): a v1 statement must not pass a verifier"
                    );
                    v1_refused.push(name.clone());
                }
            }
        }
    }
    v1_refused.dedup();
    assert_eq!(
        v1_refused,
        [
            "control_input_queue_nfc",
            "control_input_interrupt",
            "control_spawn",
            "control_permission_session",
            "control_bundle_manifest",
            "control_host_register"
        ],
        "every v1 case in the vectors is refused, whatever its kind"
    );
}

/// #3118 (R2 H1): the v3 permission line is the hash of the preview the case
/// carries — the same canonical form the host builds and the app recomputes
/// (`momo_wire::permission_preview`, `permissionPreview.ts`) — and an allow
/// signed over one preview proves nothing about another, nor does a v2 allow
/// stand for a previewed request.
#[test]
fn a_v3_allow_is_bound_to_the_preview_it_names() {
    use momo_wire::permission_preview::{preview_canonical_bytes, preview_sha256};
    let v3 = doc_v3()["cases"].as_array().unwrap().clone();
    let permissions: Vec<&Value> = v3
        .iter()
        .filter(|tc| s(&tc["content"], "kind") == "permission")
        .collect();
    assert_eq!(permissions.len(), 2);
    for tc in &permissions {
        let name = s(tc, "name");
        let c = &tc["content"];
        assert_eq!(
            String::from_utf8(preview_canonical_bytes(&c["preview"]).unwrap()).unwrap(),
            s(c, "preview_canonical"),
            "{name}"
        );
        assert_eq!(
            preview_sha256(&c["preview"]).unwrap(),
            s(c, "preview_sha256"),
            "{name}"
        );
        // The server swaps the preview: the host rebuilds with its own hash of
        // what it relayed, and the person's signature is over another one.
        let mut swapped = c["preview"].clone();
        swapped["title"] = Value::from("Read README.md");
        swapped["kind"] = Value::from("read");
        let swapped_hash = preview_sha256(&swapped).unwrap();
        let statement = control(tc);
        let ControlContent::Permission {
            request_event_id,
            option_id,
            option_kind,
            scope,
            ..
        } = statement.content
        else {
            unreachable!()
        };
        for x in sigs(tc) {
            assert!(statement.verify_any(&x.key, &x.sig).is_ok(), "{name}");
            let other = HumanControl {
                content: ControlContent::Permission {
                    request_event_id,
                    option_id,
                    option_kind,
                    scope,
                    preview_sha256: Some(&swapped_hash),
                },
                ..statement.clone()
            };
            assert_eq!(
                other.verify_any(&x.key, &x.sig),
                Err(HumanSigningError::BadSignature),
                "{name} / {}: an allow over one preview verified for another",
                x.signer
            );
        }
    }
    // A v2 allow — the phone and desktop signers until they move to v3 — is
    // not accepted for a request that has a preview.
    let v2 = doc_v2()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tc| s(tc, "name") == "control_v2_permission_session")
        .unwrap()
        .clone();
    let legacy = control(&v2);
    let ControlContent::Permission {
        request_event_id,
        option_id,
        option_kind,
        scope,
        preview_sha256: None,
    } = legacy.content
    else {
        panic!("a v2 case carries no preview");
    };
    let previewed = HumanControl {
        content: ControlContent::Permission {
            request_event_id,
            option_id,
            option_kind,
            scope,
            preview_sha256: Some(s(&permissions[1]["content"], "preview_sha256")),
        },
        ..legacy.clone()
    };
    for x in sigs(&v2) {
        assert!(legacy.verify_any(&x.key, &x.sig).is_ok());
        assert_eq!(
            previewed.verify_any(&x.key, &x.sig),
            Err(HumanSigningError::BadSignature),
            "{}: a v2 allow stood for a previewed request",
            x.signer
        );
    }
}

/// #3118: the core's copy of the v3 previews (the TS half of the preview hash,
/// `packages/momo-core/.../permissionPreview.test.ts`) is exactly the vectors'.
#[test]
fn the_cores_preview_fixture_is_the_v3_vectors() {
    let core: Value = serde_json::from_str(include_str!(
        "../../../../packages/momo-core/src/features/workbench/__fixtures__/permission-preview.vectors.json"
    ))
    .unwrap();
    let expected: Vec<Value> = doc_v3()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|tc| s(&tc["content"], "kind") == "permission")
        .map(|tc| {
            serde_json::json!({
                "name": tc["name"],
                "preview": tc["content"]["preview"],
                "preview_canonical": tc["content"]["preview_canonical"],
                "preview_sha256": tc["content"]["preview_sha256"],
            })
        })
        .collect();
    assert_eq!(core["cases"].as_array().unwrap(), &expected);
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
    // v1: 6 controls × 13 + endorse 7 + revoke 6 = 91 lines; v2: 7 × 13 = 91
    // + revoke v2 7; v3: 7 × 13 = 91. × 3 signers.
    assert_eq!(checked, (91 + 91 + 7 + 91) * 3);
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
            "momo.human.control.v1" | "momo.human.control.v2" | "momo.human.control.v3" => {
                let schema = schema_of(&tc).unwrap();
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
                                tool: "claude",
                                channel_id: other,
                                first_prompt: text,
                            },
                        ),
                    ],
                    ControlContent::Spawn {
                        agent_member_id,
                        folder_id,
                        tool,
                        channel_id,
                        first_prompt,
                    } => {
                        let mut v = vec![
                            (
                                "agent_member_id",
                                ControlContent::Spawn {
                                    agent_member_id: other,
                                    folder_id,
                                    tool,
                                    channel_id: *channel_id,
                                    first_prompt,
                                },
                            ),
                            (
                                "folder_id",
                                ControlContent::Spawn {
                                    agent_member_id: *agent_member_id,
                                    folder_id: "fld_other",
                                    tool,
                                    channel_id: *channel_id,
                                    first_prompt,
                                },
                            ),
                            (
                                "first_prompt",
                                ControlContent::Spawn {
                                    agent_member_id: *agent_member_id,
                                    folder_id,
                                    tool,
                                    channel_id: *channel_id,
                                    first_prompt: "other",
                                },
                            ),
                        ];
                        // v2 binds the tool and the channel (v1 does not encode them).
                        if schema != ControlSchema::V1 {
                            v.push((
                                "tool",
                                ControlContent::Spawn {
                                    agent_member_id: *agent_member_id,
                                    folder_id,
                                    tool: "shell",
                                    channel_id: *channel_id,
                                    first_prompt,
                                },
                            ));
                            v.push((
                                "channel_id",
                                ControlContent::Spawn {
                                    agent_member_id: *agent_member_id,
                                    folder_id,
                                    tool,
                                    channel_id: other,
                                    first_prompt,
                                },
                            ));
                        }
                        v
                    }
                    ControlContent::Permission {
                        request_event_id,
                        option_id,
                        option_kind,
                        scope,
                        preview_sha256,
                    } => {
                        let mut v = vec![
                            (
                                "request_event_id",
                                ControlContent::Permission {
                                    request_event_id: other,
                                    option_id,
                                    option_kind,
                                    scope: *scope,
                                    preview_sha256: *preview_sha256,
                                },
                            ),
                            (
                                "option_id",
                                ControlContent::Permission {
                                    request_event_id: *request_event_id,
                                    option_id: "reject-once",
                                    option_kind,
                                    scope: *scope,
                                    preview_sha256: *preview_sha256,
                                },
                            ),
                            (
                                "option_kind",
                                ControlContent::Permission {
                                    request_event_id: *request_event_id,
                                    option_id,
                                    option_kind: "allow_always",
                                    scope: *scope,
                                    preview_sha256: *preview_sha256,
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
                                    preview_sha256: *preview_sha256,
                                },
                            ),
                        ];
                        // v3 (#3118): the preview line — another preview's hash.
                        if preview_sha256.is_some() {
                            v.push((
                                "preview_sha256",
                                ControlContent::Permission {
                                    request_event_id: *request_event_id,
                                    option_id,
                                    option_kind,
                                    scope: *scope,
                                    preview_sha256: Some(OTHER_PREVIEW_SHA256),
                                },
                            ));
                        }
                        v
                    }
                    ControlContent::BundleManifest { .. } => {
                        vec![(
                            "manifest",
                            ControlContent::BundleManifest {
                                manifest: &manifest,
                            },
                        )]
                    }
                    // ADR-0197 M4 kinds have no shared vector yet (their bytes are pinned in
                    // `cloud_box_kinds` below, not mutated here).
                    ControlContent::CloudPtyAttach { .. } | ControlContent::CloudBoxOwnerList { .. } => {
                        vec![]
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
                    rejects(m.signed_bytes_as(schema), what);
                    checked += 1;
                }
                for (what, content) in content_muts {
                    let m = HumanControl {
                        content,
                        ..base.clone()
                    };
                    rejects(m.signed_bytes_as(schema), what);
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
                    rejects(m.signed_bytes_as(schema), "host_id");
                    assert_eq!(
                        HumanControl {
                            host_id: other,
                            ..base.clone()
                        }
                        .signed_bytes_as(schema),
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
            "momo.human.device_revoke.v2" => {
                let base = revoke(&tc);
                let key = s(&tc["fields"], "target_public_key_b64");
                // Another valid compressed point: the revoked key is signed.
                let other_key = BASE64.encode(&sigs(&tc)[0].key);
                let muts = [
                    (
                        "workspace_id",
                        DeviceRevoke {
                            workspace_id: other,
                            ..base
                        },
                        key,
                    ),
                    (
                        "member_id",
                        DeviceRevoke {
                            member_id: other,
                            ..base
                        },
                        key,
                    ),
                    (
                        "root_key_id",
                        DeviceRevoke {
                            root_key_id: other,
                            ..base
                        },
                        key,
                    ),
                    (
                        "target_key_id",
                        DeviceRevoke {
                            target_key_id: other,
                            ..base
                        },
                        key,
                    ),
                    (
                        "revoked_at_ms",
                        DeviceRevoke {
                            revoked_at_ms: base.revoked_at_ms + 1,
                            ..base
                        },
                        key,
                    ),
                    ("target_public_key_b64", base, other_key.as_str()),
                ];
                for (what, m, key) in muts {
                    rejects(m.signed_bytes_v2(key), what);
                    checked += 1;
                }
                // The same letter read as v1 does not verify either.
                rejects(Ok(base.signed_bytes()), "schema");
                checked += 1;
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
    // v1: input×2 (9+3 each) + spawn (9+3) + permission (9+4) + manifest
    // (9+1) + host_register (8+2+1) + endorse 5 + revoke 5.
    // v2: input×2 (9+3 each) + spawn×2 (9+5 each: tool, channel_id) +
    // permission (9+4) + manifest (9+1) + host_register (8+2+1).
    // v3: input (9+3) + spawn×2 (9+5 each) + permission×2 (9+5 each: the
    // preview line too) + manifest (9+1) + host_register (8+2+1).
    assert_eq!(
        checked,
        (24 + 12 + 13 + 10 + 11 + 5 + 5) + (24 + 28 + 13 + 10 + 11) + 7 + (12 + 28 + 28 + 10 + 11)
    );
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
    assert_eq!(high + low, 24 + 21 + 3 + 21);
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
    // v1 never had a session line for a spawn…
    assert_eq!(
        HumanControl {
            session_id: Some(Uuid::nil()),
            ..sp.clone()
        }
        .signed_bytes_as(ControlSchema::V1),
        Err(HumanSigningError::SessionForbidden("spawn"))
    );
    // …v2 carries one for a resume, and still refuses one on the kinds that
    // never have a session.
    let v2_spawn = cases()
        .into_iter()
        .find(|c| s(c, "name") == "control_v2_spawn")
        .unwrap();
    let sp2 = control(&v2_spawn);
    assert!(HumanControl {
        session_id: Some(Uuid::nil()),
        ..sp2.clone()
    }
    .signed_bytes()
    .is_ok());
    let manifest = cases()
        .into_iter()
        .find(|c| s(c, "name") == "control_v2_bundle_manifest")
        .unwrap();
    assert_eq!(
        HumanControl {
            session_id: Some(Uuid::nil()),
            ..control(&manifest)
        }
        .signed_bytes(),
        Err(HumanSigningError::SessionForbidden("bundle_manifest"))
    );
    // A v2 tool is a token: empty or a newline moves nothing.
    for bad in ["", "claude\nshell"] {
        let ControlContent::Spawn {
            agent_member_id,
            folder_id,
            channel_id,
            first_prompt,
            ..
        } = sp2.content
        else {
            unreachable!()
        };
        assert!(
            matches!(
                HumanControl {
                    content: ControlContent::Spawn {
                        agent_member_id,
                        folder_id,
                        tool: bad,
                        channel_id,
                        first_prompt,
                    },
                    ..sp2.clone()
                }
                .signed_bytes(),
                Err(HumanSigningError::InvalidField { field: "tool", .. })
            ),
            "{bad:?}"
        );
    }
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
