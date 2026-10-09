//! `docs/api/human-control-signing-v4.vectors.json` (#3592, P1): the shared
//! vectors the phone, the desktop shell and the shared core rebuild the v4
//! new-work spawn bytes from. `tests/human_control_v4.rs` pins the contract as a
//! hand-written golden; this file proves the **file** every client reads is the
//! same bytes `momo_wire` builds, so a client that matches the file matches the
//! server's verifier.
//!
//! The file carries no signatures: the signature is the same ECDSA P-256 over
//! the payload under every schema (v1 to v3 vectors fix it with three signers).
//! The JSON is read from a test only: the server image does not copy `docs/api`.

use momo_wire::human_control::{ControlContent, ControlSchema, HumanControl};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const VECTORS_V4: &str = include_str!("../../../../docs/api/human-control-signing-v4.vectors.json");

fn doc() -> Value {
    serde_json::from_str(VECTORS_V4).expect("v4 vectors parse")
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("string field {k}"))
}

fn uuid(v: &Value, k: &str) -> Uuid {
    s(v, k).parse().unwrap_or_else(|_| panic!("uuid field {k}"))
}

fn optional_uuid(v: &Value, k: &str) -> Option<Uuid> {
    v[k].as_str()
        .map(|raw| raw.parse().unwrap_or_else(|_| panic!("uuid field {k}")))
}

fn statement(case: &Value) -> HumanControl<'_> {
    let f = &case["fields"];
    let c = &case["content"];
    assert_eq!(s(c, "kind"), "spawn_task");
    HumanControl {
        instance_id: s(f, "instance_id"),
        workspace_id: uuid(f, "workspace_id"),
        member_id: uuid(f, "member_id"),
        device_key_id: uuid(f, "device_key_id"),
        host_id: uuid(f, "host_id"),
        session_id: if f["session_id"].is_null() {
            None
        } else {
            Some(uuid(f, "session_id"))
        },
        nonce: uuid(f, "nonce"),
        issued_at_ms: f["issued_at_ms"].as_i64().unwrap(),
        expires_at_ms: f["expires_at_ms"].as_i64().unwrap(),
        content: ControlContent::SpawnTask {
            agent_member_id: optional_uuid(c, "agent_member_id"),
            folder_id: s(c, "folder_id"),
            tool: s(c, "tool"),
            channel_id: uuid(c, "channel_id"),
            thread_root_id: optional_uuid(c, "thread_root_id"),
            origin_message_id: optional_uuid(c, "origin_message_id"),
            label: s(c, "label"),
            prompt: s(c, "prompt"),
        },
    }
}

#[test]
fn every_v4_vector_is_the_bytes_momo_wire_builds() {
    let doc = doc();
    let cases = doc["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 4, "the file's four cases");
    for case in cases {
        let name = s(case, "name");
        assert_eq!(s(case, "schema"), "momo.human.control.v4", "{name}");
        let control = statement(case);
        let canonical = control
            .content
            .canonical_bytes_as(ControlSchema::V4)
            .expect("canonical");
        assert_eq!(
            String::from_utf8(canonical.clone()).unwrap(),
            s(case, "content_canonical"),
            "{name}: content_canonical"
        );
        assert_eq!(
            hex::encode(Sha256::digest(&canonical)),
            s(case, "content_sha256"),
            "{name}: content_sha256"
        );
        let payload = control.signed_bytes_as(ControlSchema::V4).expect("payload");
        assert_eq!(
            String::from_utf8(payload.clone()).unwrap(),
            s(case, "payload"),
            "{name}: payload"
        );
        assert_eq!(
            hex::encode(Sha256::digest(&payload)),
            s(case, "payload_sha256"),
            "{name}: payload_sha256"
        );
    }
}

/// The file's decomposed (NFD) case is the one that would drift if a client
/// signed what the person typed instead of its NFC form.
#[test]
fn the_nfd_case_signs_nfc_text() {
    let doc = doc();
    let case = doc["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| s(c, "name") == "control_v4_spawn_nfd_text_signs_as_nfc")
        .expect("nfd case");
    let typed = s(&case["content"], "prompt");
    assert_ne!(
        typed,
        s(case, "content_canonical").lines().last().unwrap(),
        "the case really holds decomposed text"
    );
    assert!(
        s(case, "content_canonical").contains("caf\u{e9} \u{d55c}\u{ae00}"),
        "the signed prompt is NFC"
    );
}

/// The clients read byte-identical copies (the server image does not copy
/// `docs/api`, and the phone, the desktop shell and the core each keep the file
/// their own tests read). A copy that drifts would prove a client against bytes
/// the server never builds.
#[test]
fn every_clients_copy_is_the_docs_file() {
    let copies = [
        (
            "packages/momo-core/src/features/auth/__fixtures__/human-control-signing-v4.vectors.json",
            include_str!(
                "../../../../packages/momo-core/src/features/auth/__fixtures__/human-control-signing-v4.vectors.json"
            ),
        ),
        (
            "clients/mobile/__tests__/fixtures/human-control-signing-v4.vectors.json",
            include_str!(
                "../../../../clients/mobile/__tests__/fixtures/human-control-signing-v4.vectors.json"
            ),
        ),
    ];
    for (path, copy) in copies {
        assert_eq!(copy, VECTORS_V4, "{path} must equal docs/api's v4 vectors");
    }
}
