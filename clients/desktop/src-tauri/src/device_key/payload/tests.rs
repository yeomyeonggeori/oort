use super::*;
use p256::elliptic_curve::scalar::IsHigh as _;
use serde_json::Value;

/// The shared E1 vectors (#3021). On this base branch the only in-repo copy
/// is the phone's fixture; it is byte-identical to
/// `docs/api/human-control-signing.vectors.json` on track/engine.
const VECTORS: &str =
    include_str!("../../../../../mobile/__tests__/fixtures/human-control-signing.vectors.json");

/// The E7 v2 vectors (#3027·#3068): control v2 and device_revoke.v2.
const VECTORS_V2: &str =
    include_str!("../../../../../../docs/api/human-control-signing-v2.vectors.json");

/// #3118 v3 vectors: a permission body binds the host's preview hash.
const VECTORS_V3: &str =
    include_str!("../../../../../../docs/api/human-control-signing-v3.vectors.json");

/// #3592 v4 vectors (a new-work spawn); the phone's fixture is a byte copy of
/// `docs/api/human-control-signing-v4.vectors.json`.
const VECTORS_V4: &str =
    include_str!("../../../../../mobile/__tests__/fixtures/human-control-signing-v4.vectors.json");

fn cases_v4() -> Vec<Value> {
    let root: Value = serde_json::from_str(VECTORS_V4).unwrap();
    root["cases"].as_array().unwrap().clone()
}

fn cases_v3() -> Vec<Value> {
    let root: Value = serde_json::from_str(VECTORS_V3).unwrap();
    root["cases"].as_array().unwrap().clone()
}

fn cases() -> Vec<Value> {
    let root: Value = serde_json::from_str(VECTORS).unwrap();
    root["cases"].as_array().unwrap().clone()
}

fn cases_v2() -> Vec<Value> {
    let root: Value = serde_json::from_str(VECTORS_V2).unwrap();
    root["cases"].as_array().unwrap().clone()
}

fn uuid(v: &Value) -> Uuid {
    Uuid::parse_str(v.as_str().unwrap()).unwrap()
}

fn signer_of(fields: &Value, key_field: &str) -> Signer {
    Signer {
        workspace_id: uuid(&fields["workspace_id"]),
        member_id: uuid(&fields["member_id"]),
        key_id: uuid(&fields[key_field]),
    }
}

fn control_request(fields: &Value, content: &Value) -> ControlRequest {
    let mut content = content.clone();
    // A v1 spawn names no tool or channel; the v1 recipe ignores them, the
    // struct needs them.
    if content["kind"] == "spawn" && content.get("tool").is_none() {
        content["tool"] = Value::from("unused-by-v1");
        content["channel_id"] = Value::from(Uuid::nil().to_string());
    }
    let content = &content;
    // The vector's content object is the E1 shape (snake_case); the webview
    // sends camelCase. Re-key it the way the bridge does.
    let mut camel = serde_json::Map::new();
    for (key, value) in content.as_object().unwrap() {
        // The v3 vectors record the preview's canonical form beside it; the
        // page does not send it (the shell derives it).
        if key == "preview_canonical" {
            continue;
        }
        let key = if key == "kind" {
            key.clone()
        } else {
            let mut out = String::new();
            let mut upper = false;
            for c in key.chars() {
                if c == '_' {
                    upper = true;
                } else if upper {
                    out.extend(c.to_uppercase());
                    upper = false;
                } else {
                    out.push(c);
                }
            }
            out
        };
        camel.insert(key, value.clone());
    }
    ControlRequest {
        workspace_id: uuid(&fields["workspace_id"]),
        instance_id: fields["instance_id"].as_str().unwrap().to_string(),
        host_id: uuid(&fields["host_id"]),
        session_id: fields["session_id"]
            .as_str()
            .map(|s| Uuid::parse_str(s).unwrap()),
        nonce: uuid(&fields["nonce"]),
        issued_at_ms: fields["issued_at_ms"].as_i64().unwrap(),
        expires_at_ms: fields["expires_at_ms"].as_i64().unwrap(),
        content: serde_json::from_value(Value::Object(camel)).unwrap(),
    }
}

fn statement_of(case: &Value) -> Statement {
    let fields = &case["fields"];
    match case["schema"].as_str().unwrap() {
        HUMAN_CONTROL_SCHEMA_V1
        | HUMAN_CONTROL_SCHEMA_V2
        | HUMAN_CONTROL_SCHEMA_V3
        | HUMAN_CONTROL_SCHEMA_V4 => Statement::Control {
            signer: signer_of(fields, "device_key_id"),
            request: control_request(fields, &case["content"]),
        },
        DEVICE_ENDORSE_SCHEMA_V1 => Statement::Endorse {
            signer: signer_of(fields, "root_key_id"),
            request: EndorseRequest {
                workspace_id: uuid(&fields["workspace_id"]),
                target_key_id: Uuid::from_u128(0xd002),
                target_alg: fields["target_alg"].as_str().unwrap().into(),
                target_public_key: fields["target_public_key_b64"].as_str().unwrap().into(),
                label: fields["label"].as_str().unwrap().into(),
            },
        },
        DEVICE_REVOKE_SCHEMA_V1 | DEVICE_REVOKE_SCHEMA_V2 => Statement::Revoke {
            signer: signer_of(fields, "root_key_id"),
            request: RevokeRequest {
                workspace_id: uuid(&fields["workspace_id"]),
                target_key_id: uuid(&fields["target_key_id"]),
                target_label: String::new(),
            },
            target_public_key: fields["target_public_key_b64"]
                .as_str()
                .unwrap_or("A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW")
                .into(),
            revoked_at_ms: fields["revoked_at_ms"].as_i64().unwrap(),
        },
        other => panic!("unknown schema {other}"),
    }
}

/// `now` inside each control's window (vectors are dated 2026-09).
fn now_for(case: &Value) -> i64 {
    case["fields"]["issued_at_ms"].as_i64().unwrap_or(0) + 1_000
}

fn verify_all(name: &str, case: &Value, bytes: &[u8]) {
    let signatures = case["signatures"].as_array().unwrap();
    assert!(signatures.len() >= 3, "{name}: webcrypto, cryptokit, SE");
    for signature in signatures {
        let key = BASE64
            .decode(signature["public_key"].as_str().unwrap())
            .unwrap();
        let raw = BASE64
            .decode(signature["signature"].as_str().unwrap())
            .unwrap();
        assert!(
            verify_raw(&key, bytes, &raw),
            "{name}: {} signature",
            signature["signer"]
        );
    }
}

/// E1 (v1): the port still rebuilds every v1 byte, but only the endorsement
/// is signable now; v1 control and v1 revocations never reach the enclave.
#[test]
fn every_v1_vector_rebuilds_but_only_the_endorsement_is_still_signable() {
    let cases = cases();
    assert_eq!(
        cases.len(),
        8,
        "the E1 vector set changed; review this port"
    );
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let fields = &case["fields"];
        let bytes = match (case["schema"].as_str().unwrap(), statement_of(case)) {
            (HUMAN_CONTROL_SCHEMA_V1, Statement::Control { signer, request }) => {
                assert_eq!(
                    request
                        .content
                        .content_sha256_for(ControlSchema::V1)
                        .unwrap(),
                    case["content_sha256"].as_str().unwrap(),
                    "{name}: content sha256"
                );
                control_bytes_for(ControlSchema::V1, &signer, &request).unwrap()
            }
            (DEVICE_ENDORSE_SCHEMA_V1, statement) => statement.signed_bytes(now_for(case)).unwrap(),
            (DEVICE_REVOKE_SCHEMA_V1, _) => format!(
                "{DEVICE_REVOKE_SCHEMA_V1}\n{}\n{}\n{}\n{}\n{}",
                fields["workspace_id"].as_str().unwrap(),
                fields["member_id"].as_str().unwrap(),
                fields["root_key_id"].as_str().unwrap(),
                fields["target_key_id"].as_str().unwrap(),
                fields["revoked_at_ms"].as_i64().unwrap(),
            )
            .into_bytes(),
            (other, _) => panic!("{name}: unexpected schema {other}"),
        };
        assert_eq!(
            std::str::from_utf8(&bytes).unwrap(),
            case["payload"].as_str().unwrap(),
            "{name}: payload bytes"
        );
        verify_all(name, case, &bytes);
        let signable = check_signing_payload(&bytes).is_ok();
        assert_eq!(
            signable,
            case["schema"] == DEVICE_ENDORSE_SCHEMA_V1,
            "{name}: only the endorsement stays signable"
        );
    }
}

/// E7 (v2, #3027·#3068): every case is built by the production path
/// (`Statement::signed_bytes`, allow-list included) and equals the vector.
#[test]
fn every_v2_vector_rebuilds_byte_for_byte_and_every_signature_verifies() {
    let cases = cases_v2();
    assert_eq!(
        cases.len(),
        8,
        "the E7 vector set changed; review this port"
    );
    let mut schemas = std::collections::BTreeSet::new();
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let statement = statement_of(case);
        // #3128: a permission is signed as v3 now. The v2 permission body (no
        // preview line) is kept as a recipe only, and production refuses it.
        let bytes = match &statement {
            Statement::Control { signer, request }
                if matches!(request.content, ControlContent::Permission { .. }) =>
            {
                assert_eq!(
                    statement.signed_bytes(now_for(case)),
                    Err(PayloadError::Field("preview", "missing")),
                    "{name}: a permission without a preview is never signed"
                );
                control_bytes_for(ControlSchema::V2, signer, request).unwrap()
            }
            _ => {
                schemas.insert(statement.schema());
                statement.signed_bytes(now_for(case)).unwrap()
            }
        };
        assert_eq!(
            std::str::from_utf8(&bytes).unwrap(),
            case["payload"].as_str().unwrap(),
            "{name}: payload bytes"
        );
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            case["payload_sha256"].as_str().unwrap(),
            "{name}: payload sha256"
        );
        if let Statement::Control { request, .. } = &statement {
            assert_eq!(
                request
                    .content
                    .content_sha256_for(ControlSchema::V2)
                    .unwrap(),
                case["content_sha256"].as_str().unwrap(),
                "{name}: content sha256"
            );
        }
        verify_all(name, case, &bytes);
    }
    assert_eq!(
        schemas,
        [HUMAN_CONTROL_SCHEMA_V2, DEVICE_REVOKE_SCHEMA_V2]
            .into_iter()
            .collect(),
        "control v2 and revoke v2 both come from the vectors"
    );
}

/// The revocation names the PUBLIC KEY it revokes: a letter built over
/// another key is different bytes, so the vector's signatures fail on it.
#[test]
fn the_revocation_letter_is_the_v2_vector_and_binds_the_public_key() {
    let case = cases_v2()
        .into_iter()
        .find(|c| c["name"] == "device_revoke_v2")
        .unwrap();
    let fields = &case["fields"];
    let signer = signer_of(fields, "root_key_id");
    let bytes = revoke_bytes(
        &signer,
        uuid(&fields["target_key_id"]),
        fields["target_public_key_b64"].as_str().unwrap(),
        fields["revoked_at_ms"].as_i64().unwrap(),
    );
    assert_eq!(bytes, case["payload"].as_str().unwrap().as_bytes());
    let other_key = BASE64.encode(
        p256::ecdsa::SigningKey::from_slice(&[5u8; 32])
            .unwrap()
            .verifying_key()
            .to_encoded_point(true)
            .as_bytes(),
    );
    let swapped = revoke_bytes(
        &signer,
        uuid(&fields["target_key_id"]),
        &other_key,
        fields["revoked_at_ms"].as_i64().unwrap(),
    );
    let signature = &case["signatures"][0];
    let key = BASE64
        .decode(signature["public_key"].as_str().unwrap())
        .unwrap();
    let raw = BASE64
        .decode(signature["signature"].as_str().unwrap())
        .unwrap();
    assert!(verify_raw(&key, &bytes, &raw));
    assert!(!verify_raw(&key, &swapped, &raw), "the key is signed");
}

/// A v1 spawn is never produced: the production recipe is v2, and a v2 spawn
/// binds the tool and the channel (changing either changes the bytes).
#[test]
fn a_spawn_is_signed_as_v2_and_binds_tool_channel_and_the_resumed_session() {
    let case = cases_v2()
        .into_iter()
        .find(|c| c["name"] == "control_v2_spawn_resume")
        .unwrap();
    let Statement::Control { signer, request } = statement_of(&case) else {
        unreachable!()
    };
    let now = now_for(&case);
    let base = Statement::Control {
        signer,
        request: request.clone(),
    }
    .signed_bytes(now)
    .unwrap();
    assert!(base.starts_with(b"momo.human.control.v2\n"));
    for (what, changed) in [
        ("tool", {
            let mut r = request.clone();
            if let ControlContent::Spawn { tool, .. } = &mut r.content {
                *tool = "claude".into();
            }
            r
        }),
        ("channel", {
            let mut r = request.clone();
            if let ControlContent::Spawn { channel_id, .. } = &mut r.content {
                *channel_id = Uuid::from_u128(77);
            }
            r
        }),
        ("session", {
            let mut r = request.clone();
            r.session_id = Some(Uuid::from_u128(78));
            r
        }),
    ] {
        let bytes = Statement::Control {
            signer,
            request: changed,
        }
        .signed_bytes(now)
        .unwrap();
        assert_ne!(bytes, base, "{what} is signed");
    }
    // A bundle or host registration still names no session.
    let bundle = cases_v2()
        .into_iter()
        .find(|c| c["name"] == "control_v2_bundle_manifest")
        .unwrap();
    let Statement::Control {
        signer,
        mut request,
    } = statement_of(&bundle)
    else {
        unreachable!()
    };
    request.session_id = Some(Uuid::from_u128(1));
    assert_eq!(
        control_bytes(&signer, &request),
        Err(PayloadError::SessionForbidden)
    );
}

/// #3103 cross test, Rust half: the letter momo-wire's `DeviceRebind` printed
/// for its own golden inputs (`device-rebind.vector.json`; the TS builder and
/// the Swift allow-list read the same file). The bytes match, the recorded
/// signature verifies over them, and they pass the allow-list as 7 lines.
const REBIND_VECTOR: &str =
    include_str!("../../../../../mobile/__tests__/fixtures/device-rebind.vector.json");

fn rebind_vector() -> (Statement, String, String) {
    let v: Value = serde_json::from_str(REBIND_VECTOR).unwrap();
    let i = &v["inputs"];
    let statement = Statement::Rebind {
        signer: Signer {
            workspace_id: uuid(&i["workspaceId"]),
            member_id: uuid(&i["memberId"]),
            key_id: uuid(&i["keyId"]),
        },
        public_key: i["publicKey"].as_str().unwrap().to_string(),
        session_id: uuid(&i["sessionId"]),
        signed_at_ms: i["signedAtMs"].as_i64().unwrap(),
    };
    (
        statement,
        v["payload"].as_str().unwrap().to_string(),
        v["signature"].as_str().unwrap().to_string(),
    )
}

#[test]
fn the_rebind_letter_is_momo_wires_bytes_and_its_signature_verifies() {
    let (statement, payload, signature) = rebind_vector();
    assert_eq!(statement.schema(), DEVICE_REBIND_SCHEMA_V1);
    let bytes = statement.signed_bytes(0).unwrap();
    assert_eq!(String::from_utf8(bytes.clone()).unwrap(), payload);
    assert_eq!(payload.split('\n').count(), 7);
    let Statement::Rebind { public_key, .. } = &statement else {
        unreachable!()
    };
    let key = BASE64.decode(public_key).unwrap();
    let raw = BASE64.decode(&signature).unwrap();
    assert!(verify_raw(&key, &bytes, &raw));
    // Another destination sign-in is another letter: the signature is not it.
    let Statement::Rebind {
        signer,
        public_key,
        signed_at_ms,
        ..
    } = statement.clone()
    else {
        unreachable!()
    };
    let elsewhere = Statement::Rebind {
        signer,
        public_key: public_key.clone(),
        session_id: Uuid::from_u128(5),
        signed_at_ms,
    };
    assert!(!verify_raw(&key, &elsewhere.signed_bytes(0).unwrap(), &raw));
    // Out-of-range time and a key that is not a compressed point are refused.
    for bad in [
        Statement::Rebind {
            signer,
            public_key: public_key.clone(),
            session_id: Uuid::from_u128(4),
            signed_at_ms: 0,
        },
        Statement::Rebind {
            signer,
            public_key: "AAAA".into(),
            session_id: Uuid::from_u128(4),
            signed_at_ms,
        },
    ] {
        assert!(bad.signed_bytes(0).is_err());
    }
}

#[test]
fn only_the_six_schemas_with_their_exact_line_counts_are_signable() {
    let (_, rebind, _) = rebind_vector();
    let rebind_case = serde_json::json!({ "payload": rebind });
    for case in cases_v2()
        .into_iter()
        .chain(cases_v3())
        .chain(cases_v4())
        .chain(
            cases()
                .into_iter()
                .filter(|c| c["schema"] == DEVICE_ENDORSE_SCHEMA_V1),
        )
        .chain([rebind_case])
    {
        let payload = case["payload"].as_str().unwrap();
        assert_eq!(check_signing_payload(payload.as_bytes()), Ok(()));
        // A trailing newline or an appended line changes the count.
        assert!(check_signing_payload(format!("{payload}\n").as_bytes()).is_err());
        assert!(check_signing_payload(format!("{payload}\nx").as_bytes()).is_err());
        // A carriage return is a control character.
        assert!(check_signing_payload(payload.replacen('\n', "\r\n", 1).as_bytes()).is_err());
    }
    // The rebind letter one line short is refused.
    let short = rebind.rsplit_once('\n').unwrap().0.to_string();
    assert!(check_signing_payload(short.as_bytes()).is_err());
    for foreign in [
        "momo.human.control.v2\na",
        "momo.human.control.v3\na",
        "momo.human.control.v4\na\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk",
        "momo.human.control.v5\na\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl",
        "momo.work.host.v1\na\nb",
        "hello",
        "",
    ] {
        assert!(
            check_signing_payload(foreign.as_bytes()).is_err(),
            "{foreign:?}"
        );
    }
    assert!(check_signing_payload(&[0xff, 0xfe]).is_err());
    assert!(check_signing_payload(&vec![b'a'; MAX_SIGNING_PAYLOAD_BYTES + 1]).is_err());
}

fn input_case() -> (Signer, ControlRequest) {
    let case = cases()
        .into_iter()
        .find(|c| c["name"] == "control_input_queue_nfc")
        .map(|mut c| {
            // Production signs v2; the input bytes but the first line match.
            c["schema"] = Value::from(HUMAN_CONTROL_SCHEMA_V2);
            c
        })
        .unwrap();
    let Statement::Control { signer, request } = statement_of(&case) else {
        unreachable!()
    };
    (signer, request)
}

#[test]
fn a_control_outside_its_window_is_never_built() {
    let (signer, request) = input_case();
    let now = request.issued_at_ms + 1_000;
    let mut long = request.clone();
    long.expires_at_ms = long.issued_at_ms + MAX_LIFETIME_MS + 1;
    let statement = Statement::Control {
        signer,
        request: long,
    };
    assert!(matches!(
        statement.signed_bytes(now),
        Err(PayloadError::Window(_))
    ));
    let statement = Statement::Control {
        signer,
        request: request.clone(),
    };
    assert!(matches!(
        statement.signed_bytes(request.issued_at_ms + MAX_CLOCK_SKEW_MS + 1),
        Err(PayloadError::Window(_))
    ));
    assert!(statement.signed_bytes(now).is_ok());
}

#[test]
fn a_request_for_another_workspace_or_a_smuggled_newline_is_refused() {
    let (signer, mut request) = input_case();
    let now = request.issued_at_ms + 1_000;
    request.workspace_id = Uuid::from_u128(99);
    assert!(control_bytes(&signer, &request).is_err());

    let (signer, mut request) = input_case();
    request.instance_id = "inst\nmomo.human.control.v1".into();
    assert!(Statement::Control { signer, request }
        .signed_bytes(now)
        .is_err());

    let (signer, mut request) = input_case();
    request.session_id = None;
    assert_eq!(
        control_bytes(&signer, &request),
        Err(PayloadError::SessionRequired)
    );
}

#[test]
fn an_endorsement_needs_a_real_compressed_point_and_a_clean_label() {
    let signer = Signer {
        workspace_id: Uuid::from_u128(1),
        member_id: Uuid::from_u128(2),
        key_id: Uuid::from_u128(3),
    };
    let good = EndorseRequest {
        workspace_id: Uuid::from_u128(1),
        target_key_id: Uuid::from_u128(4),
        target_alg: "p256".into(),
        target_public_key: "A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW".into(),
        label: "성재의 iPhone".into(),
    };
    assert!(endorse_bytes(&signer, &good).is_ok());
    for (field, bad) in [
        ("alg", {
            let mut r = good.clone();
            r.target_alg = "ed25519".into();
            r
        }),
        ("not on curve", {
            let mut r = good.clone();
            // The first 02‖x with no point on the curve.
            let off_curve = (1u8..=255)
                .map(|b| {
                    let mut raw = [b; 33];
                    raw[0] = 2;
                    raw
                })
                .find(|raw| VerifyingKey::from_sec1_bytes(raw).is_err())
                .unwrap();
            r.target_public_key = BASE64.encode(off_curve);
            r
        }),
        ("uncompressed prefix", {
            let mut r = good.clone();
            let mut raw = BASE64.decode(&good.target_public_key).unwrap();
            raw[0] = 4;
            r.target_public_key = BASE64.encode(raw);
            r
        }),
        ("newline label", {
            let mut r = good.clone();
            r.label = "a\nb".into();
            r
        }),
    ] {
        assert!(endorse_bytes(&signer, &bad).is_err(), "{field}");
    }
}

#[test]
fn der_from_the_enclave_becomes_low_s_raw_and_verifies() {
    use p256::ecdsa::signature::Signer as _;
    use p256::ecdsa::SigningKey;
    let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
    let public = key.verifying_key().to_encoded_point(true);
    let payload = b"momo.human.device_revoke.v1\na\nb\nc\nd\n1";
    let signature: Signature = key.sign(payload);
    // Force the high-s twin: both verify, only the low-s one is stored.
    let high = {
        let (r, s) = (signature.r(), signature.s());
        let high_s = if bool::from(s.is_high()) { *s } else { -*s };
        Signature::from_scalars(r, high_s).unwrap()
    };
    for sig in [signature, high] {
        let raw = der_to_raw_low_s(sig.to_der().as_bytes()).unwrap();
        let back = Signature::from_slice(&raw).unwrap();
        assert!(!bool::from(back.s().is_high()), "stored form is low-s");
        assert!(verify_raw(public.as_bytes(), payload, &raw));
        assert!(!verify_raw(public.as_bytes(), b"other", &raw));
    }
    assert!(der_to_raw_low_s(&[0x30, 0x02, 0x02, 0x00]).is_none());
}

#[test]
fn an_x963_key_is_compressed_like_the_server_stores_it() {
    let key = p256::ecdsa::SigningKey::from_slice(&[9u8; 32]).unwrap();
    let uncompressed = key.verifying_key().to_encoded_point(false);
    assert_eq!(uncompressed.as_bytes().len(), 65);
    let compressed = compress_x963_public_key(uncompressed.as_bytes()).unwrap();
    assert_eq!(
        &compressed[..],
        key.verifying_key().to_encoded_point(true).as_bytes()
    );
    assert!(compress_x963_public_key(&[4u8; 65]).is_none());
}

/// Shared with `packages/momo-core` `deviceKeyFingerprint` (same key, same
/// string) — the phone and this Mac must show one value.
#[test]
fn the_fingerprint_is_the_shared_one() {
    assert_eq!(
        fingerprint("A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW").unwrap(),
        FINGERPRINT_VECTOR
    );
}

pub const FINGERPRINT_VECTOR: &str = "5BAF F89D E7DE 5C1D 7B61";

#[test]
fn the_dialog_shows_what_is_signed_and_nothing_that_can_spoof_it() {
    let (signer, mut request) = input_case();
    let host = request.host_id;
    let now = request.issued_at_ms + 1_000;
    let text = "\n  테스트를 돌려 줘\n둘째 줄: 그다음 lint도";
    request.content = ControlContent::Input {
        mode: InputMode::Interrupt,
        text: text.into(),
    };
    let statement = Statement::Control { signer, request };
    assert!(statement.signed_bytes(now).is_ok());
    let summary = statement.summary(Some(host));
    assert!(summary.title.contains("지금 끼어들기"), "{summary:?}");
    assert!(summary.body.contains("이 맥"), "{summary:?}");
    assert!(
        summary.body.contains("테스트를 돌려 줘 (3줄"),
        "{summary:?}"
    );
    // Every signed character is on screen: the whole text, not a first line.
    assert_eq!(summary.full_text.as_deref(), Some(text));

    let case = cases()
        .into_iter()
        .find(|c| c["name"] == "device_endorse")
        .unwrap();
    let summary = statement_of(&case).summary(None);
    let fp = fingerprint("A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW").unwrap();
    // The fingerprint comes first, on its own line, before the label.
    assert!(
        summary.body.starts_with(&format!("지문: {fp}\n")),
        "{summary:?}"
    );
    assert!(summary.body.contains("「성재의 iPhone」"));

    // Revoke: the fingerprint of the key the host will drop (the one the
    // v2 letter signs), first.
    let case = cases_v2()
        .into_iter()
        .find(|c| c["name"] == "device_revoke_v2")
        .unwrap();
    let summary = statement_of(&case).summary(None);
    let revoked = fingerprint(case["fields"]["target_public_key_b64"].as_str().unwrap()).unwrap();
    assert!(
        summary.body.starts_with(&format!("지문: {revoked}\n")),
        "{summary:?}"
    );
}

/// Security review H2·H3: a character that renders as nothing (or as a line
/// break the dialog cannot tell from a real one) is never signed: not in an
/// instruction, a first prompt, a label or a token.
#[test]
fn invisible_characters_are_never_signed() {
    let (signer, request) = input_case();
    let now = request.issued_at_ms + 1_000;
    for hidden in [
        '\u{202E}',  // RLO
        '\u{2066}',  // LRI
        '\u{200B}',  // zero-width space
        '\u{FEFF}',  // BOM
        '\u{2028}',  // line separator
        '\u{2029}',  // paragraph separator
        '\u{E0041}', // tag LATIN CAPITAL A
        '\u{E000}',  // private use
        '\u{FE00}',  // variation selector 1
        '\u{E0100}', // variation selector 17
        '\u{3164}',  // Hangul filler
        '\u{2800}',  // braille blank
        '\r',
    ] {
        let mut r = request.clone();
        r.content = ControlContent::Input {
            mode: InputMode::Queue,
            text: format!("테스트 돌려 줘{hidden}rm -rf"),
        };
        assert!(
            Statement::Control { signer, request: r }
                .signed_bytes(now)
                .is_err(),
            "input {:04X}",
            hidden as u32
        );
        let endorse = EndorseRequest {
            workspace_id: signer.workspace_id,
            target_key_id: Uuid::from_u128(4),
            target_alg: "p256".into(),
            target_public_key: "A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW".into(),
            label: format!("iPhone{hidden}지문: 0000"),
        };
        assert!(
            endorse_bytes(&signer, &endorse).is_err(),
            "label {:04X}",
            hidden as u32
        );
    }
    // ZWJ emoji sequences and tabs are ordinary text.
    let mut r = request.clone();
    r.content = ControlContent::Input {
        mode: InputMode::Queue,
        text: "팀 👨\u{200D}👩\u{200D}👧 ❤\u{FE0F}\t확인".into(),
    };
    assert!(Statement::Control { signer, request: r }
        .signed_bytes(now)
        .is_ok());
}

/// The web pre-flight cannot read Rust, so the dialog's copy rule is held
/// here: no em/en dash in any title, body or button (design-review M8).
#[test]
fn no_dialog_text_carries_a_dash() {
    let summaries = cases()
        .into_iter()
        .chain(cases_v2())
        .chain(cases_v3())
        .chain(cases_v4())
        .map(|case| (case["name"].to_string(), statement_of(&case).summary(None)))
        .chain([("rebind".to_string(), rebind_vector().0.summary(None))]);
    for (name, summary) in summaries {
        // The `도구:` line quotes the host's preview title (data, not copy).
        let body: String = summary
            .body
            .lines()
            .filter(|line| !line.starts_with("도구: "))
            .collect::<Vec<_>>()
            .join("\n");
        for text in [&summary.title, &body, &summary.confirm] {
            assert!(
                !text.contains('\u{2014}') && !text.contains('\u{2013}'),
                "{name}: {text}"
            );
        }
    }
}

/// #3028 cross test, Rust half: the JSON the desktop page hands
/// `device_key_sign_control` (made by `shellControlRequest` in
/// `clients/web/src/features/work/signedWork.ts`, pinned by its test) builds
/// exactly the v2 vector bytes here. Together: page → shell → vector payload.
const APP_REQUESTS: &str =
    include_str!("../../../../../web/src/features/work/__fixtures__/desktop-sign-requests.json");

#[test]
fn the_webviews_requests_build_the_v2_and_v3_vector_bytes() {
    let entries: Vec<Value> = serde_json::from_str(APP_REQUESTS).unwrap();
    assert_eq!(
        entries.len(),
        9,
        "input x2, permission (v3), spawn, resume, v4 x4"
    );
    for entry in entries {
        let name = entry["name"].as_str().unwrap();
        let signer = Signer {
            workspace_id: uuid(&entry["signer"]["workspaceId"]),
            member_id: uuid(&entry["signer"]["memberId"]),
            key_id: uuid(&entry["signer"]["keyId"]),
        };
        let request: ControlRequest = serde_json::from_value(entry["request"].clone())
            .unwrap_or_else(|e| panic!("{name}: the shell refuses the page's request: {e}"));
        let now = request.issued_at_ms + 1_000;
        let bytes = Statement::Control { signer, request }
            .signed_bytes(now)
            .unwrap();
        assert_eq!(
            std::str::from_utf8(&bytes).unwrap(),
            entry["payload"].as_str().unwrap(),
            "{name}"
        );
    }
}

// ---- #3128: control v3 — a permission allow binds the host's preview ---------

fn v3_case(name: &str) -> Value {
    cases_v3()
        .into_iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no v3 vector {name}"))
}

/// The permission the v3 vector `control_v3_permission_once` signs, as the
/// page sends it (preview + the page's hash).
fn v3_permission() -> (Signer, ControlRequest, i64) {
    let case = v3_case("control_v3_permission_once");
    let Statement::Control { signer, request } = statement_of(&case) else {
        unreachable!()
    };
    (signer, request, now_for(&case))
}

fn with_preview(
    request: &ControlRequest,
    preview: Option<Value>,
    preview_sha256: Option<String>,
) -> ControlRequest {
    let mut request = request.clone();
    if let ControlContent::Permission {
        preview: p,
        preview_sha256: h,
        ..
    } = &mut request.content
    {
        *p = preview;
        *h = preview_sha256;
    }
    request
}

/// Every v3 case rebuilds byte for byte from its inputs, every recorded
/// signature (WebCrypto, CryptoKit, Secure Enclave) verifies over those
/// bytes, and the preview hash is the one this shell computes itself.
#[test]
fn every_v3_vector_rebuilds_byte_for_byte_and_every_signature_verifies() {
    let cases = cases_v3();
    assert_eq!(
        cases.len(),
        7,
        "the #3118 vector set changed; review this port"
    );
    let mut permissions = 0;
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let Statement::Control { signer, request } = statement_of(case) else {
            panic!("{name}: v3 is control only")
        };
        let bytes = control_bytes_for(ControlSchema::V3, &signer, &request).unwrap();
        assert_eq!(
            std::str::from_utf8(&bytes).unwrap(),
            case["payload"].as_str().unwrap(),
            "{name}: payload bytes"
        );
        assert_eq!(
            request
                .content
                .content_sha256_for(ControlSchema::V3)
                .unwrap(),
            case["content_sha256"].as_str().unwrap(),
            "{name}: content sha256"
        );
        verify_all(name, case, &bytes);
        if let ControlContent::Permission { preview, .. } = &request.content {
            permissions += 1;
            let preview = preview.as_ref().unwrap();
            assert_eq!(
                canonical_json(preview).unwrap(),
                case["content"]["preview_canonical"].as_str().unwrap(),
                "{name}: preview canonical bytes"
            );
            assert_eq!(
                permission_preview_sha256(preview).unwrap(),
                case["content"]["preview_sha256"].as_str().unwrap(),
                "{name}: the shell's own preview hash"
            );
        }
    }
    assert_eq!(permissions, 2);
}

/// Production: a permission is signed as v3 (the vector's exact bytes), the
/// other kinds stay v2, and a cut preview is never signed.
#[test]
fn a_permission_is_signed_as_v3_and_a_cut_preview_never_is() {
    let (signer, request, now) = v3_permission();
    let case = v3_case("control_v3_permission_once");
    let statement = Statement::Control {
        signer,
        request: request.clone(),
    };
    assert_eq!(statement.schema(), HUMAN_CONTROL_SCHEMA_V3);
    assert_eq!(
        std::str::from_utf8(&statement.signed_bytes(now).unwrap()).unwrap(),
        case["payload"].as_str().unwrap()
    );
    // `control_v3_permission_session` carries `truncated: true` (and a tab).
    let cut = v3_case("control_v3_permission_session");
    assert_eq!(
        statement_of(&cut).signed_bytes(now_for(&cut)),
        Err(PayloadError::Field("preview", "truncated"))
    );
    // input and spawn stay v2 (the server and workd accept v2 for them).
    let input = v3_case("control_v3_input_queue_nfc");
    let bytes = statement_of(&input).signed_bytes(now_for(&input)).unwrap();
    assert!(bytes.starts_with(b"momo.human.control.v2\n"));
}

/// Sabotage the page: the server swapped the preview (a harmless read shown
/// over the real command) and the page signs with the original request's hash,
/// or a page hands its own hash for a preview it did not render. The shell's
/// own hash differs and nothing reaches the dialog or the enclave.
#[test]
fn a_preview_that_is_not_the_hashed_one_is_never_signed() {
    let (signer, request, now) = v3_permission();
    let ControlContent::Permission {
        preview: Some(real),
        preview_sha256: Some(real_hash),
        ..
    } = request.content.clone()
    else {
        unreachable!()
    };
    let mut swapped = real.clone();
    swapped["kind"] = Value::from("read");
    swapped["title"] = Value::from("Read README.md");
    swapped["input"] = Value::from(r#"{"path":"README.md"}"#);
    let swapped_hash = permission_preview_sha256(&swapped).unwrap();
    for (what, preview, hash, why) in [
        (
            "swapped preview, original hash",
            Some(swapped.clone()),
            Some(real_hash.clone()),
            PayloadError::Field("preview_sha256", "mismatch"),
        ),
        (
            "real preview, the swapped one's hash",
            Some(real.clone()),
            Some(swapped_hash.clone()),
            PayloadError::Field("preview_sha256", "mismatch"),
        ),
        (
            "no preview",
            None,
            Some(real_hash.clone()),
            PayloadError::Field("preview", "missing"),
        ),
        (
            "no hash",
            Some(real.clone()),
            None,
            PayloadError::Field("preview_sha256", "missing"),
        ),
    ] {
        let mut platform = CountingPlatform::default();
        let statement = Statement::Control {
            signer,
            request: with_preview(&request, preview, hash),
        };
        assert_eq!(statement.signed_bytes(now), Err(why), "{what}");
        assert!(
            super::super::sign_statement(&mut platform, &statement, "unused", now, None).is_err(),
            "{what}"
        );
        assert_eq!(
            (platform.confirms, platform.signs),
            (0, 0),
            "{what}: no dialog, no enclave"
        );
    }
    // A swapped preview WITH its own hash builds (the host refuses it, not
    // this shell: its line is the host's hash, #3118) — and the bytes differ
    // from the real allow's, so the recorded signatures do not carry over.
    let resigned = Statement::Control {
        signer,
        request: with_preview(&request, Some(swapped), Some(swapped_hash)),
    }
    .signed_bytes(now)
    .unwrap();
    let case = v3_case("control_v3_permission_once");
    assert_ne!(resigned, case["payload"].as_str().unwrap().as_bytes());
    let signature = &case["signatures"][0];
    assert!(!verify_raw(
        &BASE64
            .decode(signature["public_key"].as_str().unwrap())
            .unwrap(),
        &resigned,
        &BASE64
            .decode(signature["signature"].as_str().unwrap())
            .unwrap(),
    ));
}

#[derive(Default)]
struct CountingPlatform {
    confirms: usize,
    signs: usize,
}

impl super::super::Platform for CountingPlatform {
    fn confirm(&mut self, _summary: &Summary) -> bool {
        self.confirms += 1;
        true
    }
    fn sign(
        &mut self,
        _message: &[u8],
    ) -> Result<([u8; P256_PUBLIC_KEY_LEN], Vec<u8>), super::super::enclave::EnclaveError> {
        self.signs += 1;
        Ok(([2u8; P256_PUBLIC_KEY_LEN], Vec::new()))
    }
}

/// Only the closed v1 object with nothing the app would not show as is.
#[test]
fn only_a_closed_visible_preview_is_hashed() {
    let (_, request, _) = v3_permission();
    let ControlContent::Permission {
        preview: Some(real),
        ..
    } = request.content
    else {
        unreachable!()
    };
    assert!(permission_preview_sha256(&real).is_ok());
    let mut bad = Vec::new();
    let mut extra = real.clone();
    extra["note"] = Value::from("x");
    bad.push(("extra key", extra));
    let mut kind = real.clone();
    kind["kind"] = Value::from("sudo");
    bad.push(("kind", kind));
    let mut schema = real.clone();
    schema["schema"] = Value::from("momo.work_permission.preview.v2");
    bad.push(("schema", schema));
    let mut long = real.clone();
    long["input"] = Value::from("x".repeat(PREVIEW_FIELD_MAX_CHARS + 1));
    bad.push(("long", long));
    let mut flag = real.clone();
    flag["truncated"] = Value::from(0);
    bad.push(("truncated not bool", flag));
    // What the app's display neutralises (core `INVISIBLE`) and the host
    // removes before hashing: the dialog could not show the hashed bytes.
    for hidden in [
        '\u{202E}', '\u{200B}', '\u{2028}', '\u{FEFF}', '\u{00AD}', '\r', '\u{1b}',
    ] {
        let mut v = real.clone();
        v["title"] = Value::from(format!("Run{hidden} git push"));
        bad.push(("hidden", v));
    }
    for (what, preview) in bad {
        assert!(
            permission_preview_sha256(&preview).is_err(),
            "{what}: {preview}"
        );
    }
    // What the host keeps and the app shows as is: tabs, line breaks in
    // locations, a braille blank, a private-use glyph (a Nerd Font icon in a
    // title). (ZWJ is in both the host's strip set and core `INVISIBLE`, so a
    // preview never carries one.)
    // The shell must not refuse these, or an honest request could be allowed
    // on the phone but never on this Mac (#3118 review M1).
    let mut honest = real.clone();
    honest["title"] = Value::from("\u{E0A0} 브랜치\t💻 \u{2800}확인");
    honest["locations"] = Value::from("/a.rs:3\n/b.rs");
    assert!(permission_preview_sha256(&honest).is_ok());
}

/// The dialog shows the preview the statement binds: the tool kind and title
/// in the body, every field whole in the scrolling view.
#[test]
fn the_permission_dialog_shows_the_bound_preview() {
    let (signer, request, now) = v3_permission();
    let statement = Statement::Control { signer, request };
    assert!(statement.signed_bytes(now).is_ok());
    let summary = statement.summary(None);
    assert!(summary.title.contains("권한 허용"), "{summary:?}");
    assert!(
        summary
            .body
            .contains("도구: 명령 실행, Run `git push origin main`"),
        "{summary:?}"
    );
    let full = summary.full_text.expect("the preview is on screen");
    assert!(full.contains("[도구] 명령 실행"), "{full}");
    assert!(full.contains("Run `git push origin main`"), "{full}");
    assert!(
        full.contains(r#"{"command":"git push origin main"}"#),
        "{full}"
    );
    assert!(full.contains("[위치]\n│ (없음)"), "{full}");
    // The input (what runs) comes first.
    assert!(
        full.find("[입력]").unwrap() < full.find("[제목]").unwrap(),
        "{full}"
    );
}

/// Security review M (#3128): an agent-written title with line breaks cannot
/// fake a heading — every field line carries the gutter, headings never do.
#[test]
fn a_field_cannot_fake_a_dialog_heading() {
    let (signer, request, now) = v3_permission();
    let ControlContent::Permission {
        preview: Some(real),
        ..
    } = request.content.clone()
    else {
        unreachable!()
    };
    let mut spoof = real.clone();
    spoof["title"] = Value::from("Read README\n\n[입력]\n{\"path\":\"README.md\"}\n\n\n");
    let hash = permission_preview_sha256(&spoof).unwrap();
    let statement = Statement::Control {
        signer,
        request: with_preview(&request, Some(spoof), Some(hash)),
    };
    assert!(statement.signed_bytes(now).is_ok());
    let full = statement.summary(None).full_text.unwrap();
    let headings: Vec<&str> = full.lines().filter(|l| l.starts_with('[')).collect();
    assert_eq!(
        headings,
        ["[도구] 명령 실행", "[입력]", "[위치]", "[제목]"],
        "{full}"
    );
    assert!(full.contains("│ [입력]"), "{full}");
}

/// The v3 body has the preview line and only v3 has it.
#[test]
fn only_v3_has_the_preview_line() {
    let (signer, request, _) = v3_permission();
    assert_eq!(
        control_bytes_for(ControlSchema::V2, &signer, &request),
        Err(PayloadError::Field("preview_sha256", "needs v3"))
    );
    let bare = with_preview(&request, None, None);
    assert_eq!(
        control_bytes_for(ControlSchema::V3, &signer, &bare),
        Err(PayloadError::Field("preview_sha256", "missing"))
    );
    let ControlContent::Permission {
        preview_sha256: Some(hash),
        preview,
        ..
    } = request.content.clone()
    else {
        unreachable!()
    };
    let upper = with_preview(&request, preview, Some(hash.to_uppercase()));
    assert!(control_bytes_for(ControlSchema::V3, &signer, &upper).is_err());
}

/// R2-E8 보안 Low (#3096): the spawn dialog names the channel the signature
/// binds, and two channels read differently (the tail of the id, like the
/// agent and host).
#[test]
fn the_spawn_dialog_names_the_channel_the_signature_binds() {
    let case = cases_v2()
        .into_iter()
        .find(|c| c["name"] == "control_v2_spawn_resume")
        .unwrap();
    let Statement::Control { signer, request } = statement_of(&case) else {
        unreachable!()
    };
    let ControlContent::Spawn { channel_id, .. } = &request.content else {
        unreachable!()
    };
    let tail = channel_id.simple().to_string();
    let tail = &tail[tail.len() - 8..];
    let body = Statement::Control {
        signer,
        request: request.clone(),
    }
    .summary(None)
    .body;
    assert!(body.contains(&format!("채널 {tail}")), "{body}");

    let mut other = request.clone();
    if let ControlContent::Spawn { channel_id, .. } = &mut other.content {
        *channel_id = Uuid::from_u128(0x77);
    }
    let other_body = Statement::Control {
        signer,
        request: other,
    }
    .summary(None)
    .body;
    assert!(other_body.contains("채널 00000077"), "{other_body}");
    assert_ne!(body, other_body);
}

// ---- #3592: control v4 — the owner's NEW-work spawn --------------------------

fn v4_control(case: &Value) -> (Signer, ControlRequest) {
    let Statement::Control { signer, request } = statement_of(case) else {
        unreachable!()
    };
    (signer, request)
}

#[test]
fn every_v4_vector_rebuilds_byte_for_byte() {
    let cases = cases_v4();
    assert_eq!(cases.len(), 4);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let (signer, request) = v4_control(&case);
        assert_eq!(
            request.content.signing_schema(),
            ControlSchema::V4,
            "{name}"
        );
        assert_eq!(
            hex::encode(Sha256::digest(
                request
                    .content
                    .canonical_bytes_for(ControlSchema::V4)
                    .unwrap()
            )),
            case["content_sha256"].as_str().unwrap(),
            "{name}: content_sha256"
        );
        assert_eq!(
            std::str::from_utf8(
                &request
                    .content
                    .canonical_bytes_for(ControlSchema::V4)
                    .unwrap()
            )
            .unwrap(),
            case["content_canonical"].as_str().unwrap(),
            "{name}: content_canonical"
        );
        let statement = Statement::Control { signer, request };
        let bytes = statement.signed_bytes(now_for(&case)).unwrap();
        assert_eq!(
            std::str::from_utf8(&bytes).unwrap(),
            case["payload"].as_str().unwrap(),
            "{name}"
        );
        // The dialog holds the whole prompt the hash covers.
        let summary = statement.summary(None);
        assert!(summary.full_text.is_some(), "{name}");
    }
}

#[test]
fn v4_is_the_new_work_spawns_schema_and_only_its() {
    let case = cases_v4().remove(0);
    let (signer, request) = v4_control(&case);
    // SpawnTask under v2 / v3 is refused ...
    for schema in [ControlSchema::V2, ControlSchema::V3] {
        assert!(request.content.canonical_bytes_for(schema).is_err());
        assert!(control_bytes_for(schema, &signer, &request).is_err());
    }
    // ... and no other kind is built under v4.
    let input = input_case().1;
    assert!(input
        .content
        .canonical_bytes_for(ControlSchema::V4)
        .is_err());
    assert!(control_bytes_for(
        ControlSchema::V4,
        &signer,
        &ControlRequest {
            content: input.content,
            ..input_case().1
        }
    )
    .is_err());
    let resume = cases_v2()
        .into_iter()
        .find(|c| c["name"] == "control_v2_spawn_resume")
        .unwrap();
    let (_, resume_request) = v4_control(&resume);
    assert!(resume_request
        .content
        .canonical_bytes_for(ControlSchema::V4)
        .is_err());
    // A new task has no session line (a resume's successor id is v2's).
    let mut with_session = request.clone();
    with_session.session_id = Some(Uuid::from_u128(9));
    assert_eq!(
        control_bytes_for(ControlSchema::V4, &signer, &with_session),
        Err(PayloadError::SessionForbidden)
    );
}

#[test]
fn a_new_task_is_never_signed_with_text_the_server_would_refuse() {
    let case = cases_v4().remove(0);
    let (_, request) = v4_control(&case);
    let build = |edit: &dyn Fn(&mut ControlContent)| {
        let mut content = request.content.clone();
        edit(&mut content);
        content.canonical_bytes_for(ControlSchema::V4)
    };
    let set_prompt = |p: &str| {
        let p = p.to_string();
        move |c: &mut ControlContent| {
            if let ControlContent::SpawnTask { prompt, .. } = c {
                *prompt = p.clone();
            }
        }
    };
    let set_label = |l: &str| {
        let l = l.to_string();
        move |c: &mut ControlContent| {
            if let ControlContent::SpawnTask { label, .. } = c {
                *label = l.clone();
            }
        }
    };
    assert!(build(&|_| {}).is_ok());
    for bad in [
        "",
        "   ",
        "/clear",
        "  /clear",
        "a\u{0}b",
        "a\u{7}b",
        "a\u{202e}b",
    ] {
        assert!(build(&set_prompt(bad)).is_err(), "prompt {bad:?}");
    }
    assert!(build(&set_prompt(&"가".repeat(32_769))).is_err());
    assert!(build(&set_prompt(&"가".repeat(32_768))).is_ok());
    assert!(build(&set_prompt("줄 하나\n줄 둘\t탭")).is_ok());
    for bad in ["", " 앞 ", "두\n줄", "탭\t", "\u{200b}숨김"] {
        assert!(build(&set_label(bad)).is_err(), "label {bad:?}");
    }
    assert!(build(&set_label(&"가".repeat(121))).is_err());
    assert!(build(&set_label(&"가".repeat(120))).is_ok());
    // A folder or tool with a line break would move every later line.
    assert!(build(&|c| {
        if let ControlContent::SpawnTask { folder_id, .. } = c {
            *folder_id = "fld\nx".into();
        }
    })
    .is_err());
}

/// The payload is thirteen lines whatever the prompt: a 32,768-character
/// prompt and a 120-character title are hashed, never put in the bytes the
/// enclave signs, so the 2048-byte ceiling cannot refuse a long task.
#[test]
fn a_long_prompt_does_not_grow_the_signed_payload() {
    let case = cases_v4().remove(0);
    let (signer, mut request) = v4_control(&case);
    if let ControlContent::SpawnTask { prompt, label, .. } = &mut request.content {
        *prompt = "가".repeat(32_768);
        *label = "나".repeat(120);
    }
    let bytes = Statement::Control { signer, request }
        .signed_bytes(now_for(&case))
        .unwrap();
    assert!(bytes.len() <= MAX_SIGNING_PAYLOAD_BYTES);
    assert_eq!(bytes.iter().filter(|b| **b == b'\n').count(), 12);
}

/// The dialog shows the title, the prompt's first line and size, the agent,
/// folder and room: what the person approves is what is signed.
#[test]
fn the_new_task_dialog_shows_the_title_and_the_whole_prompt() {
    let case = cases_v4().remove(0);
    let (signer, request) = v4_control(&case);
    let ControlContent::SpawnTask {
        label,
        prompt,
        channel_id,
        ..
    } = request.content.clone()
    else {
        unreachable!()
    };
    let summary = Statement::Control { signer, request }.summary(None);
    assert!(
        summary.body.contains(&format!("「{label}」")),
        "{}",
        summary.body
    );
    assert!(summary.body.contains("프롬프트: "), "{}", summary.body);
    assert!(
        summary.body.contains(&text_size(&prompt)),
        "{}",
        summary.body
    );
    let tail = channel_id.simple().to_string();
    assert!(summary
        .body
        .contains(&format!("채널 {}", &tail[tail.len() - 8..])));
    assert_eq!(summary.full_text.as_deref(), Some(prompt.as_str()));
    // A plain harness spawn says there is no agent.
    let bare = cases_v4().remove(2);
    let (signer, request) = v4_control(&bare);
    let body = Statement::Control { signer, request }.summary(None).body;
    assert!(body.contains("에이전트 없음"), "{body}");
}

/// #3592 review M2 · L2: the shared text table. The desktop shell refuses every
/// `rejects` entry and accepts every `accepts` entry of the v4 vectors — the
/// same input the server (`momo-wire`) and the core (and so the phone) judge.
#[test]
fn the_text_table_of_the_v4_vectors_is_this_shells_table() {
    let root: Value = serde_json::from_str(VECTORS_V4).unwrap();
    let rules = &root["text_rules"];
    let verdict = |field: &str, value: &str| match field {
        "prompt" => spawn_prompt_ok(value),
        "label" => spawn_label_ok(value),
        other => panic!("field {other}"),
    };
    let rejects = rules["rejects"].as_array().unwrap();
    assert!(rejects.len() >= 20);
    for case in rejects {
        let (name, field, value) = (
            case["name"].as_str().unwrap(),
            case["field"].as_str().unwrap(),
            case["value"].as_str().unwrap(),
        );
        assert!(verdict(field, value).is_err(), "{name} must be refused");
    }
    for case in rules["accepts"].as_array().unwrap() {
        let (name, field, value) = (
            case["name"].as_str().unwrap(),
            case["field"].as_str().unwrap(),
            case["value"].as_str().unwrap(),
        );
        assert!(verdict(field, value).is_ok(), "{name} must be accepted");
    }
}
