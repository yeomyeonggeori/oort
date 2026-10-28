//! Secret strings that cannot be printed by accident, and the token envelope grammar.

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A string that must never reach a terminal, a log or an error message by accident.
///
/// `Debug` is redacted and there is no `Display`: the only way to read the value is
/// [`Secret::expose`], which is greppable. It serialises as the bare string because the
/// credential store has to write it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Secret {
        Secret(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Secret(<redacted>)")
    }
}

/// `momo_dev_v1.<workspace id>.<43 chars>`: a card token, or a login session's access half.
pub const ACCESS_PREFIX: &str = "momo_dev_v1.";
/// `momo_devr_v1.<workspace id>.<43 chars>`: a login session's refresh half.
pub const REFRESH_PREFIX: &str = "momo_devr_v1.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvelopeKind {
    Access,
    Refresh,
}

/// What can be read of an envelope without the server: which half it is and its workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Envelope {
    pub kind: EnvelopeKind,
    pub workspace_id: Uuid,
}

/// The server's own grammar (`momo_devr?_v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}`), nothing looser:
/// a string that is not exactly an envelope is never sent anywhere as a credential.
pub fn parse_envelope(raw: &str) -> Option<Envelope> {
    let (kind, rest) = if let Some(rest) = raw.strip_prefix(ACCESS_PREFIX) {
        (EnvelopeKind::Access, rest)
    } else if let Some(rest) = raw.strip_prefix(REFRESH_PREFIX) {
        (EnvelopeKind::Refresh, rest)
    } else {
        return None;
    };
    let (workspace, secret) = rest.split_once('.')?;
    if workspace.len() != 36 {
        return None;
    }
    let workspace_id = Uuid::parse_str(workspace).ok()?;
    if workspace_id.hyphenated().to_string() != workspace {
        return None;
    }
    let secret_ok = secret.len() == 43
        && secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    secret_ok.then_some(Envelope { kind, workspace_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKSPACE: &str = "6f1c2b0e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
    const SECRET: &str = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";

    #[test]
    fn debug_never_prints_the_value() {
        let secret = Secret::new(format!("{ACCESS_PREFIX}{WORKSPACE}.{SECRET}"));
        let printed = format!("{secret:?} {:?}", Some(&secret));
        assert!(!printed.contains(SECRET), "{printed}");
        assert!(printed.contains("redacted"));
    }

    #[test]
    fn the_envelope_grammar_is_the_servers_and_nothing_looser() {
        assert_eq!(SECRET.len(), 43);
        let access = format!("{ACCESS_PREFIX}{WORKSPACE}.{SECRET}");
        let parsed = parse_envelope(&access).expect("an access envelope");
        assert_eq!(parsed.kind, EnvelopeKind::Access);
        assert_eq!(parsed.workspace_id.to_string(), WORKSPACE);
        let refresh = format!("{REFRESH_PREFIX}{WORKSPACE}.{SECRET}");
        assert_eq!(
            parse_envelope(&refresh).map(|envelope| envelope.kind),
            Some(EnvelopeKind::Refresh)
        );
        for bad in [
            String::new(),
            format!("momo_agent_v1.{WORKSPACE}.{SECRET}"),
            format!("{ACCESS_PREFIX}{WORKSPACE}.{}", &SECRET[1..]),
            format!("{ACCESS_PREFIX}{WORKSPACE}.{SECRET}x"),
            format!("{ACCESS_PREFIX}{}.{SECRET}", WORKSPACE.to_uppercase()),
            format!("{ACCESS_PREFIX}{WORKSPACE}.{}+", &SECRET[..42]),
            format!("{ACCESS_PREFIX}not-a-uuid.{SECRET}"),
            format!(" {ACCESS_PREFIX}{WORKSPACE}.{SECRET}"),
            format!("{ACCESS_PREFIX}{WORKSPACE}.{SECRET}\n"),
        ] {
            assert!(parse_envelope(&bad).is_none(), "{bad:?} must not parse");
        }
    }
}
