//! `momo.human.control.v4` — the owner's signed NEW-work spawn (#3570, T5;
//! ADR-0198 D4 · 증보 1 D7). v4 exists for one body, so these tests pin that
//! body's bytes, show that nothing crosses schemas, and that every field the
//! owner signs is bound: change any one and the signature stops verifying.
//!
//! No shared JS/Swift vector file is written for v4 yet (the phone and the
//! desktop sign v2/v3 only until T6); the golden string below is the contract
//! those signers will be written against.

use momo_wire::human_control::{
    ControlContent, ControlSchema, HumanControl, HumanSigningError, InputMode, PermissionScope,
};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const INSTANCE: &str = "oort-test-instance";

fn id(n: u128) -> Uuid {
    Uuid::from_u128(n)
}

fn key() -> SigningKey {
    SigningKey::from_slice(&[7u8; 32]).unwrap()
}

fn public(key: &SigningKey) -> Vec<u8> {
    key.verifying_key().to_sec1_point(true).as_bytes().to_vec()
}

fn sign(key: &SigningKey, bytes: &[u8]) -> Vec<u8> {
    let signature: Signature = key.sign(bytes);
    signature.to_bytes().to_vec()
}

#[derive(Clone)]
struct Task {
    agent: Option<Uuid>,
    folder: &'static str,
    tool: &'static str,
    channel: Uuid,
    thread: Option<Uuid>,
    origin: Option<Uuid>,
    prompt: &'static str,
}

fn task() -> Task {
    Task {
        agent: Some(id(0xa6e7)),
        folder: "fld_0123456789abcdef0123",
        tool: "claude",
        channel: id(0xc4a7),
        thread: Some(id(0x7ead)),
        origin: Some(id(0x0e16)),
        prompt: "빌드가 왜 깨지는지 봐 줘\n첫째, 로그부터요.",
    }
}

fn statement(t: &Task) -> HumanControl<'_> {
    HumanControl {
        instance_id: INSTANCE,
        workspace_id: id(1),
        member_id: id(2),
        device_key_id: id(3),
        host_id: id(4),
        session_id: None,
        nonce: id(5),
        issued_at_ms: 1_000,
        expires_at_ms: 301_000,
        content: ControlContent::SpawnTask {
            agent_member_id: t.agent,
            folder_id: t.folder,
            tool: t.tool,
            channel_id: t.channel,
            thread_root_id: t.thread,
            origin_message_id: t.origin,
            prompt: t.prompt,
        },
    }
}

fn v4(t: &Task) -> Vec<u8> {
    statement(t).signed_bytes_as(ControlSchema::V4).unwrap()
}

/// The 13-line frame and the body, written out by hand.
#[test]
fn the_v4_bytes_are_exactly_these() {
    let t = task();
    let body = format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{}",
        id(0xa6e7),
        "fld_0123456789abcdef0123",
        "claude",
        id(0xc4a7),
        id(0x7ead),
        id(0x0e16),
        "빌드가 왜 깨지는지 봐 줘\n첫째, 로그부터요."
    );
    let sha = hex::encode(Sha256::digest(body.as_bytes()));
    let expected = format!(
        "momo.human.control.v4\n{INSTANCE}\n{}\n{}\n{}\n{}\n-\nspawn\n-\n{}\n1000\n301000\n{sha}",
        id(1),
        id(2),
        id(3),
        id(4),
        id(5),
    );
    assert_eq!(String::from_utf8(v4(&t)).unwrap(), expected);

    // A harness spawn from the room's main line: three absences, spelled `-`.
    let bare = Task {
        agent: None,
        thread: None,
        origin: None,
        ..task()
    };
    let body = format!(
        "-\nfld_0123456789abcdef0123\nclaude\n{}\n-\n-\n{}",
        id(0xc4a7),
        bare.prompt
    );
    assert!(String::from_utf8(v4(&bare))
        .unwrap()
        .ends_with(&hex::encode(Sha256::digest(body.as_bytes()))));
}

/// No agent is `-`, never a made-up nil id: the two are different statements.
#[test]
fn no_agent_is_not_the_nil_agent() {
    let none = Task {
        agent: None,
        ..task()
    };
    let nil = Task {
        agent: Some(Uuid::nil()),
        ..task()
    };
    assert_ne!(v4(&none), v4(&nil));
}

/// A signature over any one differing field does not verify.
#[test]
fn every_signed_field_is_bound() {
    let k = key();
    let t = task();
    let signature = sign(&k, &v4(&t));
    assert_eq!(
        statement(&t)
            .verify_any(&public(&k), &signature)
            .unwrap()
            .schema,
        ControlSchema::V4
    );
    let mutations: Vec<(&str, Task)> = vec![
        (
            "agent",
            Task {
                agent: None,
                ..task()
            },
        ),
        (
            "other agent",
            Task {
                agent: Some(id(0xbad)),
                ..task()
            },
        ),
        (
            "folder",
            Task {
                folder: "fld_0123456789abcdef0124",
                ..task()
            },
        ),
        (
            "tool",
            Task {
                tool: "codex",
                ..task()
            },
        ),
        (
            "channel",
            Task {
                channel: id(0xbad),
                ..task()
            },
        ),
        (
            "thread",
            Task {
                thread: None,
                ..task()
            },
        ),
        (
            "other thread",
            Task {
                thread: Some(id(0xbad)),
                ..task()
            },
        ),
        (
            "origin",
            Task {
                origin: None,
                ..task()
            },
        ),
        (
            "other origin",
            Task {
                origin: Some(id(0xbad)),
                ..task()
            },
        ),
        (
            "prompt",
            Task {
                prompt: "빌드가 왜 깨지는지 봐 줘\n첫째, 로그부터요. 그리고 rm -rf",
                ..task()
            },
        ),
        (
            "empty-line prompt",
            Task {
                prompt: "",
                ..task()
            },
        ),
    ];
    for (what, changed) in mutations {
        assert_eq!(
            statement(&changed).verify_any(&public(&k), &signature),
            Err(HumanSigningError::BadSignature),
            "{what}"
        );
    }
    // And the frame: host, member, workspace, key, nonce, times.
    let t = task();
    let mut s = statement(&t);
    s.host_id = id(0xbad);
    assert!(s.verify_any(&public(&k), &signature).is_err(), "host");
    let mut s = statement(&t);
    s.member_id = id(0xbad);
    assert!(s.verify_any(&public(&k), &signature).is_err(), "member");
    let mut s = statement(&t);
    s.nonce = id(0xbad);
    assert!(s.verify_any(&public(&k), &signature).is_err(), "nonce");
    let mut s = statement(&t);
    s.expires_at_ms += 1;
    assert!(s.verify_any(&public(&k), &signature).is_err(), "expiry");
}

/// v4 is this body's only home and this body is v4's only content.
#[test]
fn nothing_crosses_schemas() {
    let t = task();
    let spawn = statement(&t);
    for schema in [ControlSchema::V1, ControlSchema::V2, ControlSchema::V3] {
        assert!(
            matches!(
                spawn.signed_bytes_as(schema),
                Err(HumanSigningError::InvalidField {
                    field: "schema",
                    ..
                })
            ),
            "a new-work spawn does not build under {schema:?}"
        );
    }
    let text = "다음 지시";
    let others = [
        ControlContent::Input {
            mode: InputMode::Queue,
            text,
        },
        ControlContent::Spawn {
            agent_member_id: id(0xa6e7),
            folder_id: "folder-1",
            tool: "claude",
            channel_id: id(0xc4a7),
            first_prompt: "이어서",
        },
        ControlContent::Permission {
            request_event_id: id(9),
            option_id: "allow-once",
            option_kind: "allow_once",
            scope: PermissionScope::Once,
            preview_sha256: None,
        },
    ];
    for content in others {
        let kind = content.kind();
        let mut s = statement(&t);
        s.content = content;
        s.session_id = Some(id(8));
        assert!(
            s.signed_bytes_as(ControlSchema::V4).is_err(),
            "{kind} does not build under v4"
        );
        // Whatever the session line, the body itself is refused under v4.
        assert!(
            matches!(
                s.content.canonical_bytes_as(ControlSchema::V4),
                Err(HumanSigningError::InvalidField {
                    field: "schema",
                    ..
                })
            ),
            "{kind}'s body is not defined under v4"
        );
    }
}

/// A v2 (resume) spawn signature never stands for a new-work spawn, and a v4
/// one never stands for a resume — even with every shared field equal.
#[test]
fn a_resume_signature_and_a_new_work_signature_do_not_stand_for_each_other() {
    let k = key();
    let t = task();
    // The owner signed a v2 resume over the same agent/folder/tool/channel and
    // the prompt as `first_prompt`.
    let resume = HumanControl {
        session_id: Some(id(8)),
        content: ControlContent::Spawn {
            agent_member_id: id(0xa6e7),
            folder_id: t.folder,
            tool: t.tool,
            channel_id: t.channel,
            first_prompt: t.prompt,
        },
        ..statement(&t)
    };
    let v2 = resume.signed_bytes_as(ControlSchema::V2).unwrap();
    let v2_signature = sign(&k, &v2);
    assert!(resume.verify_any(&public(&k), &v2_signature).is_ok());
    assert!(statement(&t)
        .verify_any(&public(&k), &v2_signature)
        .is_err());
    let v4_signature = sign(&k, &v4(&t));
    assert!(resume.verify_any(&public(&k), &v4_signature).is_err());
}

/// The prompt is signed as NFC; the frame stays free of control characters.
#[test]
fn the_prompt_is_nfc_and_the_tokens_are_clean() {
    let t = Task {
        prompt: "cafe\u{0301}",
        ..task()
    };
    let composed = Task {
        prompt: "caf\u{00e9}",
        ..task()
    };
    assert_eq!(v4(&t), v4(&composed), "NFD and NFC sign the same bytes");
    for bad in ["fld\nx", ""] {
        let t = Task {
            folder: Box::leak(bad.to_string().into_boxed_str()),
            ..task()
        };
        assert!(statement(&t).signed_bytes_as(ControlSchema::V4).is_err());
    }
    let t = Task {
        tool: "cla\nude",
        ..task()
    };
    assert!(statement(&t).signed_bytes_as(ControlSchema::V4).is_err());
    // A session line is not part of a new task.
    let t = task();
    let mut s = statement(&t);
    s.session_id = Some(id(8));
    assert!(matches!(
        s.signed_bytes_as(ControlSchema::V4),
        Err(HumanSigningError::SessionForbidden("spawn"))
    ));
}
