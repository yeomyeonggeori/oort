//! How the box-agent presents itself to the server (ADR-0197 D2): a **member
//! host**, `scope = "member"`, whose owner is the box's person.
//!
//! The server route that consumes a pairing code is M1/M4 work; this module is
//! the box side of that contract: the request it would send, and the checks it
//! makes on the answer. Registration alone activates nothing: until the owner
//! confirms (see [`crate::host::BoxHost::confirm_owner`]) the host answers no
//! attach, however the server answers here.

use std::fmt;

use serde_json::{json, Value};

/// The server's `work_host.type` for a host that lives in a personal-cloud box
/// (`routes/work_hosts.rs::validated_type`: `app | workd | cloud`).
pub const HOST_TYPE: &str = "cloud";

/// The only scope a box host ever has (ADR-0197 D2, ADR-0188 D3).
pub const SCOPE: &str = "member";

/// A one-time pairing code, injected by the runner (D2). It is consumed by
/// [`PairingCode::into_request_value`], never printed, never cloned, and
/// overwritten when dropped.
pub struct PairingCode(Vec<u8>);

impl PairingCode {
    pub fn new(code: &str) -> Option<Self> {
        let trimmed = code.trim();
        (!trimmed.is_empty() && trimmed.len() <= 256 && !trimmed.contains('\0'))
            .then(|| Self(trimmed.as_bytes().to_vec()))
    }

    fn into_request_value(mut self) -> String {
        // Consumed here: the bytes leave this object exactly once.
        String::from_utf8_lossy(&std::mem::take(&mut self.0)).into_owned()
    }
}

impl fmt::Debug for PairingCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PairingCode([redacted])")
    }
}

impl Drop for PairingCode {
    fn drop(&mut self) {
        for byte in self.0.iter_mut() {
            // SAFETY: a valid &mut u8; volatile so the wipe is not optimised out.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

/// The registration request body. `scope` is fixed here; there is no parameter
/// that could widen it.
pub fn registration_request(
    box_id: &str,
    display_name: &str,
    public_key_b64: &str,
    code: PairingCode,
) -> Value {
    json!({
        "scope": SCOPE,
        "type": HOST_TYPE,
        "displayName": display_name.trim(),
        "publicKey": public_key_b64,
        // A box host serves the owner's terminal. Claude is never driven over
        // ACP in a box (D6), so it advertises no ACP either.
        "capabilities": { "acp": false, "terminal_attach": true },
        "pairing": { "boxId": box_id, "code": code.into_request_value() },
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
    fn the_request_is_a_member_scope_cloud_host_and_carries_the_code_once() {
        let code = PairingCode::new("  PAIR-1234  ").unwrap();
        assert_eq!(format!("{code:?}"), "PairingCode([redacted])");
        let body = registration_request("box-1", " 성재의 클라우드 ", "KEY", code);
        assert_eq!(body["scope"], "member");
        assert_eq!(body["type"], "cloud");
        assert_eq!(body["displayName"], "성재의 클라우드");
        assert_eq!(body["capabilities"]["acp"], false);
        assert_eq!(body["capabilities"]["terminal_attach"], true);
        assert_eq!(body["pairing"]["code"], "PAIR-1234");
        assert!(body.get("workspace").is_none());
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

    #[test]
    fn empty_or_oversized_codes_are_not_codes() {
        assert!(PairingCode::new("   ").is_none());
        assert!(PairingCode::new(&"x".repeat(257)).is_none());
        assert!(PairingCode::new("a\0b").is_none());
    }
}
