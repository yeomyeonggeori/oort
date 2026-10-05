//! How the box-agent presents itself to the server (ADR-0197 D2): a **member
//! host**, `scope = "member"`, whose owner is the box's person.
//!
//! The box side of the contract (ADR-0197 M4 증보 2): the request it sends (a MAC over its host key, keyed by a
//! pairing code only the runner and the box know), and the checks it makes on the answer. Registration alone
//! activates nothing: until the owner confirms (see [`crate::host::BoxHost::confirm_owner`]) the host answers no
//! attach, however the server answers here.

use std::fmt;

use serde_json::{json, Value};

/// The server's `work_host.type` for a host that lives in a personal-cloud box
/// (`routes/work_hosts.rs::validated_type`: `app | workd | cloud`).
pub const HOST_TYPE: &str = "cloud";

/// The only scope a box host ever has (ADR-0197 D2, ADR-0188 D3).
pub const SCOPE: &str = "member";

/// The one-time pairing code the runner injected (ADR-0197 M4 증보 2): 32 CSPRNG bytes. It is the key of the
/// registration MAC and **is never sent anywhere**: the server sees only the MAC, which it cannot check; the runner,
/// which holds the same code, can. This type overwrites its own copy on drop (volatile writes); it cannot wipe copies
/// the allocator or the caller made, so it limits how long one copy lives and guarantees nothing more.
pub struct PairingSecret(Vec<u8>);

impl PairingSecret {
    /// From the injected file's text: base64 of exactly 32 bytes.
    pub fn from_file_text(text: &str) -> Option<Self> {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(text.trim())
            .ok()?;
        (bytes.len() == 32).then_some(Self(bytes))
    }

    /// `HMAC-SHA256(code, "momo.box.register.v1" ‖ box_id ‖ host_pub)`.
    pub fn mac(&self, box_id: &[u8; 16], host_pub: &[u8; 32]) -> [u8; 32] {
        momo_blind_pty::trust::registration_mac(&self.0, box_id, host_pub)
    }
}

impl fmt::Debug for PairingSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PairingSecret([redacted])")
    }
}

impl Drop for PairingSecret {
    fn drop(&mut self) {
        for byte in self.0.iter_mut() {
            // SAFETY: a valid &mut u8; volatile so the wipe is not optimised out.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

/// The registration request body: the box's host public key and the MAC proving the pairing code. There is no
/// field for the code, a scope, a type, an owner or a workspace: the server derives every one of them from the
/// box row (owner = the box's owner, `scope = "member"`, `type = "cloud"`).
pub fn registration_body(host_public_key_b64: &str, mac: &[u8; 32]) -> Value {
    use base64::Engine as _;
    json!({
        "hostPublicKey": host_public_key_b64,
        "mac": base64::engine::general_purpose::STANDARD.encode(mac),
    })
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RegisterError {
    #[error("the answer is not a work_host object")]
    Malformed,
    #[error("the server registered scope {0:?}; a box host is always scope \"member\"")]
    WrongScope(String),
    #[error("the server registered type {0:?}, not \"cloud\"")]
    WrongType(String),
    #[error("the server registered a different public key than the one requested")]
    WrongKey,
}

/// What the agent keeps of a successful registration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registered {
    pub host_id: String,
    pub owner_member_id: String,
}

/// Check the server's `{"workHost": {...}}` answer the way `momo-workd register`
/// does: it must be the host that was asked for, not merely a host.
pub fn check_registered(
    answer: &Value,
    requested_key_b64: &str,
) -> Result<Registered, RegisterError> {
    let host = answer.get("workHost").ok_or(RegisterError::Malformed)?;
    let text = |name: &str| host.get(name).and_then(Value::as_str);
    let scope = text("scope").ok_or(RegisterError::Malformed)?;
    if scope != SCOPE {
        return Err(RegisterError::WrongScope(scope.to_string()));
    }
    let host_type = text("type").ok_or(RegisterError::Malformed)?;
    if host_type != HOST_TYPE {
        return Err(RegisterError::WrongType(host_type.to_string()));
    }
    if text("publicKey") != Some(requested_key_b64) {
        return Err(RegisterError::WrongKey);
    }
    Ok(Registered {
        host_id: text("id").ok_or(RegisterError::Malformed)?.to_string(),
        owner_member_id: text("ownerMemberId")
            .ok_or(RegisterError::Malformed)?
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(scope: &str, host_type: &str, key: &str) -> Value {
        json!({"workHost": {
            "id": "11111111-1111-1111-1111-111111111111",
            "workspaceId": "22222222-2222-2222-2222-222222222222",
            "ownerMemberId": "33333333-3333-3333-3333-333333333333",
            "scope": scope, "type": host_type, "publicKey": key,
        }})
    }

    #[test]
    fn the_request_carries_a_key_and_a_mac_and_never_the_code() {
        use base64::Engine as _;
        let code_text = base64::engine::general_purpose::STANDARD.encode([9u8; 32]);
        let secret = PairingSecret::from_file_text(&format!("{code_text}\n")).unwrap();
        assert_eq!(format!("{secret:?}"), "PairingSecret([redacted])");
        let mac = secret.mac(&[1u8; 16], &[2u8; 32]);
        let body = registration_body("KEY", &mac);
        let text = body.to_string();
        assert_eq!(body.as_object().unwrap().len(), 2, "exactly a key and a mac");
        assert!(!text.contains(&code_text), "the code itself is never in the body");
        for widened in ["scope", "type", "owner", "workspace", "capabilities", "pairing", "code"] {
            assert!(body.get(widened).is_none(), "{widened}");
        }
        // The runner verifies exactly this MAC with the same code.
        assert!(momo_blind_pty::trust::verify_registration_mac(
            &[9u8; 32],
            &[1u8; 16],
            &[2u8; 32],
            &mac
        ));
    }

    #[test]
    fn a_pairing_file_is_32_bytes_of_base64() {
        use base64::Engine as _;
        let b64 = |n: usize| base64::engine::general_purpose::STANDARD.encode(vec![1u8; n]);
        assert!(PairingSecret::from_file_text(&b64(32)).is_some());
        assert!(PairingSecret::from_file_text(&b64(31)).is_none());
        assert!(PairingSecret::from_file_text(&b64(33)).is_none());
        assert!(PairingSecret::from_file_text("not base64!").is_none());
        assert!(PairingSecret::from_file_text("").is_none());
    }

    #[test]
    fn a_widened_scope_type_or_key_in_the_answer_is_refused() {
        let ok = check_registered(&answer("member", "cloud", "KEY"), "KEY").unwrap();
        assert_eq!(ok.owner_member_id, "33333333-3333-3333-3333-333333333333");
        assert_eq!(
            check_registered(&answer("workspace", "cloud", "KEY"), "KEY"),
            Err(RegisterError::WrongScope("workspace".into()))
        );
        assert_eq!(
            check_registered(&answer("member", "workd", "KEY"), "KEY"),
            Err(RegisterError::WrongType("workd".into()))
        );
        assert_eq!(
            check_registered(&answer("member", "cloud", "OTHER"), "KEY"),
            Err(RegisterError::WrongKey)
        );
        assert_eq!(
            check_registered(&json!({"nothing": 1}), "KEY"),
            Err(RegisterError::Malformed)
        );
    }
}
