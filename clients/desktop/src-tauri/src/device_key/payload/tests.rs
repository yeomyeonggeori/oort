use super::*;
use p256::elliptic_curve::scalar::IsHigh as _;
use serde_json::Value;

/// The shared E1 vectors (#3021). On this base branch the only in-repo copy
/// is the phone's fixture; it is byte-identical to
/// `docs/api/human-control-signing.vectors.json` on track/engine.
const VECTORS: &str =
    include_str!("../../../../../mobile/__tests__/fixtures/human-control-signing.vectors.json");

fn cases() -> Vec<Value> {
    let root: Value = serde_json::from_str(VECTORS).unwrap();
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
    // The vector's content object is the E1 shape (snake_case); the webview
    // sends camelCase. Re-key it the way the bridge does.
    let mut camel = serde_json::Map::new();
    for (key, value) in content.as_object().unwrap() {
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
        HUMAN_CONTROL_SCHEMA_V1 => Statement::Control {
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
        DEVICE_REVOKE_SCHEMA_V1 => Statement::Revoke {
            signer: signer_of(fields, "root_key_id"),
            request: RevokeRequest {
                workspace_id: uuid(&fields["workspace_id"]),
                target_key_id: uuid(&fields["target_key_id"]),
                // Any valid point: not part of the signed bytes.
                target_public_key: "A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW".into(),
                target_label: String::new(),
            },
            revoked_at_ms: fields["revoked_at_ms"].as_i64().unwrap(),
        },
        other => panic!("unknown schema {other}"),
    }
}

/// `now` inside each control's window (vectors are dated 2026-09).
fn now_for(case: &Value) -> i64 {
    case["fields"]["issued_at_ms"].as_i64().unwrap_or(0) + 1_000
}

#[test]
fn every_shared_vector_rebuilds_byte_for_byte_and_every_signature_verifies() {
    let cases = cases();
    assert_eq!(
        cases.len(),
        8,
        "the E1 vector set changed; review this port"
    );
    let mut schemas = std::collections::BTreeSet::new();
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let statement = statement_of(case);
        let bytes = statement.signed_bytes(now_for(case)).unwrap();
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
                request.content.content_sha256().unwrap(),
                case["content_sha256"].as_str().unwrap(),
                "{name}: content sha256"
            );
        }
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
                verify_raw(&key, &bytes, &raw),
                "{name}: {} signature",
                signature["signer"]
            );
        }
        schemas.insert(statement.schema());
    }
    assert_eq!(
        schemas.len(),
        3,
        "control, endorse and revoke all come from the vectors"
    );
}

#[test]
fn the_revocation_letter_is_the_e1_vector() {
    let case = cases()
        .into_iter()
        .find(|c| c["name"] == "device_revoke")
        .unwrap();
    let fields = &case["fields"];
    let bytes = revoke_bytes(
        &signer_of(fields, "root_key_id"),
        uuid(&fields["target_key_id"]),
        fields["revoked_at_ms"].as_i64().unwrap(),
    );
    assert_eq!(bytes, case["payload"].as_str().unwrap().as_bytes());
}

#[test]
fn only_the_three_schemas_with_their_exact_line_counts_are_signable() {
    for case in cases() {
        let payload = case["payload"].as_str().unwrap();
        assert_eq!(check_signing_payload(payload.as_bytes()), Ok(()));
        // A trailing newline or an appended line changes the count.
        assert!(check_signing_payload(format!("{payload}\n").as_bytes()).is_err());
        assert!(check_signing_payload(format!("{payload}\nx").as_bytes()).is_err());
        // A carriage return is a control character.
        assert!(check_signing_payload(payload.replacen('\n', "\r\n", 1).as_bytes()).is_err());
    }
    for foreign in [
        "momo.human.control.v2\na",
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
        text: "팀 👨\u{200D}👩\u{200D}👧\t확인".into(),
    };
    assert!(Statement::Control { signer, request: r }
        .signed_bytes(now)
        .is_ok());
}

/// The web pre-flight cannot read Rust, so the dialog's copy rule is held
/// here: no em/en dash in any title, body or button (design-review M8).
#[test]
fn no_dialog_text_carries_a_dash() {
    for case in cases() {
        let summary = statement_of(&case).summary(None);
        for text in [&summary.title, &summary.body, &summary.confirm] {
            assert!(
                !text.contains('\u{2014}') && !text.contains('\u{2013}'),
                "{}: {text}",
                case["name"]
            );
        }
    }
}
