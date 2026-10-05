//! ADR-0197 M4 (증보 2): the two personal-cloud kinds of `momo.human.control.v3`.
//!
//! They have no shared JS/Swift vector yet (the phone and desktop signers arrive with M7), so
//! their bytes are pinned here: if the 13-line frame or a content line moves, these fail.
//! Every statement is built under v3 only; v2 and v1 must refuse to build them, and a signature
//! over one statement must not verify as the other kind.

use momo_wire::human_control::{ControlContent, ControlSchema, HumanControl};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use uuid::Uuid;

const HELLO_SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LIST_SHA: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn key() -> SigningKey {
    SigningKey::from_slice(&[7u8; 32]).expect("scalar")
}

fn statement<'a>(content: ControlContent<'a>, host_id: Uuid) -> HumanControl<'a> {
    HumanControl {
        instance_id: "inst_test",
        workspace_id: Uuid::from_u128(1),
        member_id: Uuid::from_u128(2),
        device_key_id: Uuid::from_u128(3),
        host_id,
        session_id: None,
        nonce: Uuid::from_u128(4),
        issued_at_ms: 1_790_000_000_000,
        expires_at_ms: 1_790_000_060_000,
        content,
    }
}

#[test]
fn the_attach_statement_is_the_pinned_thirteen_lines() {
    let box_id = Uuid::from_u128(5);
    let host = Uuid::from_u128(6);
    let st = statement(
        ControlContent::CloudPtyAttach {
            box_id,
            hello_sha256: HELLO_SHA,
        },
        host,
    );
    let text = String::from_utf8(st.signed_bytes().unwrap()).unwrap();
    // The content line is SHA-256("{box_id}\n{hello_sha256}"); the rest is the v3 frame.
    let content_sha = st.content.content_sha256().unwrap();
    let want = format!(
        "momo.human.control.v3\ninst_test\n{}\n{}\n{}\n{host}\n-\ncloud_pty_attach\n-\n{}\n1790000000000\n1790000060000\n{content_sha}",
        Uuid::from_u128(1),
        Uuid::from_u128(2),
        Uuid::from_u128(3),
        Uuid::from_u128(4),
    );
    assert_eq!(text, want);
    assert_eq!(text.lines().count(), 13);
    assert_eq!(
        st.content.canonical_bytes().unwrap(),
        format!("{box_id}\n{HELLO_SHA}").into_bytes()
    );
}

#[test]
fn only_v3_builds_them() {
    for content in [
        ControlContent::CloudPtyAttach {
            box_id: Uuid::from_u128(5),
            hello_sha256: HELLO_SHA,
        },
        ControlContent::CloudBoxOwnerList {
            box_id: Uuid::from_u128(5),
            list_sha256: LIST_SHA,
        },
    ] {
        let st = statement(content, Uuid::from_u128(6));
        assert!(st.signed_bytes_as(ControlSchema::V3).is_ok());
        assert!(st.signed_bytes_as(ControlSchema::V2).is_err());
        assert!(st.signed_bytes_as(ControlSchema::V1).is_err());
    }
}

#[test]
fn a_signature_verifies_for_its_own_kind_and_binds_every_field() {
    let sk = key();
    let public = sk.verifying_key().to_sec1_point(true);
    let box_id = Uuid::from_u128(5);
    let host = Uuid::from_u128(6);
    let st = statement(
        ControlContent::CloudPtyAttach {
            box_id,
            hello_sha256: HELLO_SHA,
        },
        host,
    );
    let sig: Signature = sk.sign(&st.signed_bytes().unwrap());
    assert!(st.verify_any(public.as_bytes(), &sig.to_bytes()).is_ok());

    // Another Hello, another box, another host, another kind: none verifies.
    let other_hello = statement(
        ControlContent::CloudPtyAttach {
            box_id,
            hello_sha256: LIST_SHA,
        },
        host,
    );
    assert!(other_hello
        .verify_any(public.as_bytes(), &sig.to_bytes())
        .is_err());
    let other_box = statement(
        ControlContent::CloudPtyAttach {
            box_id: Uuid::from_u128(9),
            hello_sha256: HELLO_SHA,
        },
        host,
    );
    assert!(other_box
        .verify_any(public.as_bytes(), &sig.to_bytes())
        .is_err());
    let other_host = statement(
        ControlContent::CloudPtyAttach {
            box_id,
            hello_sha256: HELLO_SHA,
        },
        Uuid::from_u128(10),
    );
    assert!(other_host
        .verify_any(public.as_bytes(), &sig.to_bytes())
        .is_err());
    let other_kind = statement(
        ControlContent::CloudBoxOwnerList {
            box_id,
            list_sha256: HELLO_SHA,
        },
        host,
    );
    assert!(other_kind
        .verify_any(public.as_bytes(), &sig.to_bytes())
        .is_err());
}

#[test]
fn a_session_line_or_a_malformed_hash_is_refused() {
    let mut st = statement(
        ControlContent::CloudBoxOwnerList {
            box_id: Uuid::from_u128(5),
            list_sha256: LIST_SHA,
        },
        Uuid::from_u128(5),
    );
    st.session_id = Some(Uuid::from_u128(11));
    assert!(st.signed_bytes().is_err());
    let (g, upper) = ("g".repeat(64), "A".repeat(64));
    for bad in ["", "ABCDEF", g.as_str(), upper.as_str()] {
        let st = statement(
            ControlContent::CloudBoxOwnerList {
                box_id: Uuid::from_u128(5),
                list_sha256: bad,
            },
            Uuid::from_u128(5),
        );
        assert!(st.signed_bytes().is_err(), "{bad:?}");
    }
}
