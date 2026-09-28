use super::payload::*;
use super::*;
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::SigningKey;
use p256::elliptic_curve::scalar::IsHigh as _;

/// A software key standing in for the enclave — tests only. The shipped
/// `Platform` has no software branch (`enclave.rs`).
struct Fake {
    key: SigningKey,
    answer: bool,
    confirms: usize,
    signs: usize,
    fail: Option<EnclaveError>,
    corrupt_der: bool,
    last_summary: Option<Summary>,
}

impl Fake {
    fn new(answer: bool) -> Self {
        Self {
            key: SigningKey::from_slice(&[11u8; 32]).unwrap(),
            answer,
            confirms: 0,
            signs: 0,
            fail: None,
            corrupt_der: false,
            last_summary: None,
        }
    }

    fn public_b64(&self) -> String {
        BASE64.encode(self.key.verifying_key().to_encoded_point(true).as_bytes())
    }
}

impl Platform for Fake {
    fn confirm(&mut self, summary: &Summary) -> bool {
        self.confirms += 1;
        self.last_summary = Some(summary.clone());
        self.answer
    }

    fn sign(
        &mut self,
        message: &[u8],
    ) -> Result<([u8; P256_PUBLIC_KEY_LEN], Vec<u8>), EnclaveError> {
        self.signs += 1;
        if let Some(error) = self.fail.clone() {
            return Err(error);
        }
        let signature: p256::ecdsa::Signature = self.key.sign(message);
        let mut der = signature.to_der().as_bytes().to_vec();
        if self.corrupt_der {
            let last = der.len() - 1;
            der[last] ^= 1;
        }
        let mut public = [0u8; P256_PUBLIC_KEY_LEN];
        public.copy_from_slice(self.key.verifying_key().to_encoded_point(true).as_bytes());
        Ok((public, der))
    }
}

const NOW: i64 = 1_790_550_001_000;

fn signer() -> Signer {
    Signer {
        workspace_id: Uuid::from_u128(1),
        member_id: Uuid::from_u128(0x101),
        key_id: Uuid::from_u128(0xd001),
    }
}

fn input(text: &str) -> Statement {
    Statement::Control {
        signer: signer(),
        request: ControlRequest {
            workspace_id: Uuid::from_u128(1),
            instance_id: "inst_1".into(),
            host_id: Uuid::from_u128(0xf001),
            session_id: Some(Uuid::from_u128(0xc001)),
            nonce: Uuid::from_u128(0xa1),
            issued_at_ms: NOW - 1_000,
            expires_at_ms: NOW + 60_000,
            content: ControlContent::Input {
                mode: InputMode::Queue,
                text: text.into(),
            },
        },
    }
}

#[test]
fn a_declined_dialog_never_reaches_the_enclave() {
    let mut fake = Fake::new(false);
    let root = fake.public_b64();
    let error = sign_statement(&mut fake, &input("테스트 돌려 줘"), &root, NOW, None).unwrap_err();
    assert_eq!(error, "device_key_declined");
    assert_eq!((fake.confirms, fake.signs), (1, 0));
}

#[test]
fn a_rejected_statement_is_never_shown_or_signed() {
    let mut fake = Fake::new(true);
    let root = fake.public_b64();
    // Outside its window on this clock.
    let error = sign_statement(
        &mut fake,
        &input("x"),
        &root,
        NOW + MAX_CLOCK_SKEW_MS + 10_000,
        None,
    )
    .unwrap_err();
    assert!(error.starts_with("device_key_payload_rejected"), "{error}");
    assert_eq!((fake.confirms, fake.signs), (0, 0));
}

#[test]
fn a_confirmed_statement_comes_back_low_s_and_verifiable_over_the_built_bytes() {
    let mut fake = Fake::new(true);
    let root = fake.public_b64();
    let statement = input("테스트 돌려 줘\n둘째 줄");
    let signed = sign_statement(
        &mut fake,
        &statement,
        &root,
        NOW,
        Some(Uuid::from_u128(0xf001)),
    )
    .unwrap();
    let bytes = statement.signed_bytes(NOW).unwrap();
    let raw = BASE64.decode(&signed.signature).unwrap();
    assert_eq!(raw.len(), 64);
    let sig = p256::ecdsa::Signature::from_slice(&raw).unwrap();
    assert!(!bool::from(sig.s().is_high()));
    assert!(verify_raw(
        &BASE64.decode(&signed.public_key).unwrap(),
        &bytes,
        &raw
    ));
    assert_eq!(signed.payload_sha256, hex::encode(Sha256::digest(&bytes)));
    let summary = fake.last_summary.unwrap();
    assert!(summary.body.contains("이 맥"), "{summary:?}");
    assert!(summary.body.contains("테스트 돌려 줘 (2줄"), "{summary:?}");
    assert_eq!(
        summary.full_text.as_deref(),
        Some("테스트 돌려 줘\n둘째 줄")
    );
}

#[test]
fn a_key_that_is_not_the_bound_root_signs_nothing_out() {
    let mut fake = Fake::new(true);
    let other = BASE64.encode(
        SigningKey::from_slice(&[12u8; 32])
            .unwrap()
            .verifying_key()
            .to_encoded_point(true)
            .as_bytes(),
    );
    assert_eq!(
        sign_statement(&mut fake, &input("x"), &other, NOW, None).unwrap_err(),
        "device_key_changed"
    );
}

#[test]
fn enclave_refusals_and_bad_signatures_surface_by_name() {
    let mut fake = Fake::new(true);
    let root = fake.public_b64();
    fake.fail = Some(EnclaveError::Cancelled);
    assert_eq!(
        sign_statement(&mut fake, &input("x"), &root, NOW, None).unwrap_err(),
        "device_key_cancelled"
    );
    fake.fail = Some(EnclaveError::EntitlementMissing);
    assert_eq!(
        sign_statement(&mut fake, &input("x"), &root, NOW, None).unwrap_err(),
        "device_key_entitlement_missing"
    );
    fake.fail = None;
    fake.corrupt_der = true;
    assert!(sign_statement(&mut fake, &input("x"), &root, NOW, None)
        .unwrap_err()
        .starts_with("device_key_failed"));
}

/// workd (E4 `human_trust.rs` Revocation) reads exactly these seven fields.
#[test]
fn the_local_letter_has_workds_field_names() {
    let letter = revocation_json(
        &signer(),
        Uuid::from_u128(0xd002),
        1_790_551_000_000,
        "sig",
        "A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW",
    );
    let mut keys: Vec<_> = letter.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "memberId",
            "revokedAtMs",
            "rootKeyId",
            "signature",
            "targetKeyId",
            "targetPublicKey",
            "workspaceId"
        ]
    );
    assert_eq!(letter["revokedAtMs"], 1_790_551_000_000i64);
    assert_eq!(letter["rootKeyId"], Uuid::from_u128(0xd001).to_string());
}

#[test]
fn bindings_are_private_files_and_round_trip() {
    let dir = std::env::temp_dir().join(format!("oort-device-key-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = bindings_path(&dir);
    assert_eq!(load_bindings(&path), Bindings::default());
    let mut bindings = Bindings::default();
    bindings.roots.insert(
        Uuid::from_u128(1),
        RootBinding {
            key_id: Uuid::from_u128(2),
            member_id: Uuid::from_u128(3),
            public_key: "A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW".into(),
        },
    );
    save_bindings(&path, &bindings).unwrap();
    assert_eq!(load_bindings(&path), bindings);
    use std::os::unix::fs::MetadataExt as _;
    assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    assert_eq!(
        std::fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777,
        0o700
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Security review H5: kinds whose dialogs cannot yet show what matters are
/// not signable through the command.
#[test]
fn only_instruction_kinds_are_signable_through_the_command() {
    assert_eq!(SIGNABLE_CONTROL_KINDS, ["input", "spawn", "permission"]);
    assert!(!SIGNABLE_CONTROL_KINDS.contains(&"host_register"));
    assert!(!SIGNABLE_CONTROL_KINDS.contains(&"bundle_manifest"));
}

#[test]
fn signed_letters_are_kept_privately_for_replay() {
    let dir = std::env::temp_dir().join(format!("oort-device-key-l-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = letters_path(&dir);
    let mut letters = Letters::default();
    letters.letters.insert(
        Uuid::from_u128(0xd002),
        StoredLetter {
            workspace_id: Uuid::from_u128(1),
            revoked_at_ms: 5,
            signature: "sig".into(),
            target_public_key: "A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW".into(),
        },
    );
    save_private_json(&path, &letters).unwrap();
    assert_eq!(load_letters(&path), letters);
    use std::os::unix::fs::MetadataExt as _;
    assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    let _ = std::fs::remove_dir_all(&dir);
}

const KEY_A: &str = "A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW";

fn key_b() -> String {
    BASE64.encode(
        SigningKey::from_slice(&[13u8; 32])
            .unwrap()
            .verifying_key()
            .to_encoded_point(true)
            .as_bytes(),
    )
}

/// #3028 (E7 인계 ③ High): the webview cannot name the revoked public key.
/// A request that tries is refused before anything runs, and the key a
/// revocation signs is the one this shell endorsed under that id.
#[test]
fn a_revocation_signs_the_key_this_shell_endorsed_never_the_webviews() {
    let smuggled = serde_json::json!({
        "workspaceId": Uuid::from_u128(1),
        "targetKeyId": Uuid::from_u128(0xd002),
        "targetPublicKey": key_b(),
        "targetLabel": "iPhone",
    });
    assert!(
        serde_json::from_value::<RevokeRequest>(smuggled).is_err(),
        "a public key from the webview is refused"
    );

    let mut endorsed = Endorsed::default();
    endorsed.keys.insert(
        Uuid::from_u128(0xd002),
        EndorsedKey {
            workspace_id: Uuid::from_u128(1),
            public_key: KEY_A.into(),
        },
    );
    assert_eq!(
        revocation_target(&endorsed, Uuid::from_u128(1), Uuid::from_u128(0xd002)),
        Ok(KEY_A.to_string())
    );
    // An id this shell never endorsed, or one endorsed for another workspace.
    assert_eq!(
        revocation_target(&endorsed, Uuid::from_u128(1), Uuid::from_u128(0xd003)),
        Err("device_key_not_endorsed_here".to_string())
    );
    assert_eq!(
        revocation_target(&endorsed, Uuid::from_u128(2), Uuid::from_u128(0xd002)),
        Err("device_key_not_endorsed_here".to_string())
    );

    // The signed letter is v2 over key A: key B's bytes differ.
    let mut fake = Fake::new(true);
    let root = fake.public_b64();
    let statement = Statement::Revoke {
        signer: signer(),
        request: RevokeRequest {
            workspace_id: Uuid::from_u128(1),
            target_key_id: Uuid::from_u128(0xd002),
            target_label: "iPhone".into(),
        },
        target_public_key: revocation_target(
            &endorsed,
            Uuid::from_u128(1),
            Uuid::from_u128(0xd002),
        )
        .unwrap(),
        revoked_at_ms: NOW,
    };
    let signed = sign_statement(&mut fake, &statement, &root, NOW, None).unwrap();
    let bytes = statement.signed_bytes(NOW).unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    assert!(text.starts_with("momo.human.device_revoke.v2\n"), "{text}");
    assert!(text.contains(&format!("\n{KEY_A}\n")), "{text}");
    let raw = BASE64.decode(&signed.signature).unwrap();
    let over_b = payload::revoke_bytes(&signer(), Uuid::from_u128(0xd002), &key_b(), NOW);
    let public = BASE64.decode(&signed.public_key).unwrap();
    assert!(verify_raw(&public, &bytes, &raw));
    assert!(!verify_raw(&public, &over_b, &raw));
}

#[test]
fn the_endorsement_record_is_a_private_file() {
    let dir = std::env::temp_dir().join(format!("oort-device-key-e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = endorsed_path(&dir);
    assert_eq!(load_endorsed(&path), Endorsed::default());
    let mut endorsed = Endorsed::default();
    endorsed.keys.insert(
        Uuid::from_u128(0xd002),
        EndorsedKey {
            workspace_id: Uuid::from_u128(1),
            public_key: KEY_A.into(),
        },
    );
    save_private_json(&path, &endorsed).unwrap();
    assert_eq!(load_endorsed(&path), endorsed);
    use std::os::unix::fs::MetadataExt as _;
    assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    let _ = std::fs::remove_dir_all(&dir);
}

fn trust(root_key_id: Option<u128>, root_public_key: Option<&str>) -> crate::work_host::HostTrust {
    crate::work_host::HostTrust {
        host_id: Uuid::from_u128(0xf001).to_string(),
        workspace_id: Uuid::from_u128(1).to_string(),
        owner_member_id: Uuid::from_u128(0x101).to_string(),
        root_key_id: root_key_id.map(|id| Uuid::from_u128(id).to_string()),
        root_public_key: root_public_key.map(str::to_string),
    }
}

/// #3078: a re-login gives the same enclave key a new id; the pre-check lets
/// it through to `pin_root` (which rebinds it) and still stops another key.
#[test]
fn the_bind_precheck_compares_the_pinned_public_key() {
    let ws = Uuid::from_u128(1);
    let member = Uuid::from_u128(0x101);
    let new_id = Uuid::from_u128(0xd009);
    // Same key, new id: through.
    assert_eq!(
        bind_precheck(
            Some(&trust(Some(0xd001), Some(KEY_A))),
            ws,
            member,
            new_id,
            KEY_A
        ),
        Ok(())
    );
    // Another key: refused, whatever the id.
    assert_eq!(
        bind_precheck(
            Some(&trust(Some(0xd009), Some(&key_b()))),
            ws,
            member,
            new_id,
            KEY_A
        ),
        Err("device_key_host_pinned_other".to_string())
    );
    // Nothing pinned, no host, or another owner's host: nothing to compare.
    assert_eq!(
        bind_precheck(Some(&trust(None, None)), ws, member, new_id, KEY_A),
        Ok(())
    );
    assert_eq!(bind_precheck(None, ws, member, new_id, KEY_A), Ok(()));
    assert_eq!(
        bind_precheck(
            Some(&trust(Some(0xd001), Some(&key_b()))),
            ws,
            Uuid::from_u128(7),
            new_id,
            KEY_A
        ),
        Ok(())
    );
    // A workd from before #3078 reports only the id: the old rule.
    assert_eq!(
        bind_precheck(Some(&trust(Some(0xd001), None)), ws, member, new_id, KEY_A),
        Err("device_key_host_pinned_other".to_string())
    );
    assert_eq!(
        bind_precheck(Some(&trust(Some(0xd009), None)), ws, member, new_id, KEY_A),
        Ok(())
    );
}

#[test]
fn workd_status_carries_the_pinned_public_key() {
    let status = serde_json::json!({
        "hostId": "h", "workspaceId": "w", "ownerMemberId": "m",
        "humanSignatures": {"required": false, "rootKeyId": "k", "rootPublicKey": KEY_A},
    });
    let trust = crate::work_host::host_trust_of(&status).unwrap();
    assert_eq!(trust.root_public_key.as_deref(), Some(KEY_A));
    let old = serde_json::json!({
        "hostId": "h", "workspaceId": "w", "ownerMemberId": "m",
        "humanSignatures": {"required": false, "rootKeyId": "k"},
    });
    assert_eq!(
        crate::work_host::host_trust_of(&old)
            .unwrap()
            .root_public_key,
        None
    );
}
