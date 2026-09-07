//! Boot configuration, decided once and entirely from the environment.
//!
//! Every path out of [`RelayConfig::load`] is either a usable relay or a
//! thrown error — there is deliberately no third outcome where the process
//! starts and quietly cannot deliver. Push is the failure mode that hides
//! best: a relay that accepts dispatches and drops them looks identical, from
//! the server and from the metrics, to one that works. Both known ways to
//! reach that state (the stub sender without opt-in, an unreadable `.p8`)
//! are refusals here.

use std::collections::HashMap;
use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::VerifyingKey;

/// sysexits(3) EX_CONFIG. `main` prints one operator-readable line and exits
/// with this code so a compose restart loop is diagnosable from `docker logs`.
pub const EX_CONFIG: i32 = 78;

const DEFAULT_HOST: &str = "127.0.0.1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SenderMode {
    Live,
    Stub,
}

impl SenderMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SenderMode::Live => "live",
            SenderMode::Stub => "stub",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApnsEnvironment {
    Sandbox,
    Production,
}

impl ApnsEnvironment {
    pub fn as_str(self) -> &'static str {
        match self {
            ApnsEnvironment::Sandbox => "sandbox",
            ApnsEnvironment::Production => "production",
        }
    }

    pub fn endpoint(self) -> &'static str {
        match self {
            ApnsEnvironment::Sandbox => "https://api.sandbox.push.apple.com",
            ApnsEnvironment::Production => "https://api.push.apple.com",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "sandbox" => Some(Self::Sandbox),
            "production" => Some(Self::Production),
            _ => None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("missing required environment variable: {0}")]
    Missing(&'static str),
    #[error("invalid configuration: {0}")]
    Invalid(String),
    #[error(
        "MOMO_APNS_SENDER=stub never contacts Apple. It answers every dispatch \
         200 with a fabricated apns-id, so the notifier settles the push \
         candidate as delivered and no device is ever woken — a deployment \
         that reports healthy while sending nothing. Set MOMO_APNS_ALLOW_STUB=1 \
         to run the repo verifier deliberately, or leave MOMO_APNS_SENDER=live \
         and supply the APNs key."
    )]
    StubSenderNotAllowed,
    #[error(
        "cannot read the APNs signing key at MOMO_APNS_KEY_PATH={0}. The \
         relay is the only component that holds a .p8 (ADR-0120 D1-A), so a key \
         it cannot open is a relay that cannot deliver. Check the mount path and \
         that the file is readable by the container user."
    )]
    UnreadableApnsKey(String),
}

#[derive(Debug, Clone)]
pub struct RelayConfig {
    pub host: String,
    pub port: u16,
    pub servers: HashMap<String, [u8; 32]>,
    pub rate_limit_per_minute: u32,
    pub sender_mode: SenderMode,
    pub stub_capture_path: Option<String>,
    pub stub_status: i32,
    pub stub_reason: Option<String>,
    pub apns_environment: Option<ApnsEnvironment>,
    pub apns_key_path: Option<String>,
    pub apns_key_id: Option<String>,
    pub apns_team_id: Option<String>,
}

impl RelayConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let environment: HashMap<String, String> = std::env::vars().collect();
        Self::load(&environment, is_readable_file)
    }

    /// Boot configuration. `is_readable_file` is injected so the key preflight
    /// can be tested without a real credential on disk.
    pub fn load(
        environment: &HashMap<String, String>,
        is_readable_file: impl Fn(&str) -> bool,
    ) -> Result<Self, ConfigError> {
        let registry_json = required("MOMO_RELAY_SERVERS", environment)?;
        let servers = decode_registry(&registry_json)?;
        let mode_raw = environment
            .get("MOMO_APNS_SENDER")
            .map(String::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("live");
        let sender_mode = match mode_raw {
            "live" => SenderMode::Live,
            "stub" => SenderMode::Stub,
            _ => {
                return Err(ConfigError::Invalid(
                    "MOMO_APNS_SENDER must be live or stub".into(),
                ))
            }
        };
        if sender_mode == SenderMode::Stub
            && environment.get("MOMO_APNS_ALLOW_STUB").map(String::as_str) != Some("1")
        {
            return Err(ConfigError::StubSenderNotAllowed);
        }

        let port = positive_u16(
            environment
                .get("MOMO_PUSH_RELAY_PORT")
                .map(String::as_str)
                .unwrap_or("28195"),
            "MOMO_PUSH_RELAY_PORT",
        )?;
        let rate = positive_u32(
            environment
                .get("MOMO_PUSH_RELAY_RATE_LIMIT_PER_MINUTE")
                .map(String::as_str)
                .unwrap_or("60"),
            "MOMO_PUSH_RELAY_RATE_LIMIT_PER_MINUTE",
        )?;
        let stub_status = positive_i32(
            environment
                .get("MOMO_APNS_STUB_STATUS")
                .map(String::as_str)
                .unwrap_or("200"),
            "MOMO_APNS_STUB_STATUS",
        )?;

        let mut apns_environment = None;
        let mut apns_key_path = None;
        let mut apns_key_id = None;
        let mut apns_team_id = None;
        if sender_mode == SenderMode::Live {
            let env_raw = required("MOMO_APNS_ENV", environment)?;
            let parsed = ApnsEnvironment::parse(&env_raw).ok_or_else(|| {
                ConfigError::Invalid("MOMO_APNS_ENV must be sandbox or production".into())
            })?;
            apns_environment = Some(parsed);
            let path = required("MOMO_APNS_KEY_PATH", environment)?;
            if !is_readable_file(&path) {
                return Err(ConfigError::UnreadableApnsKey(path));
            }
            apns_key_path = Some(path);
            apns_key_id = Some(required("MOMO_APNS_KEY_ID", environment)?);
            apns_team_id = Some(required("MOMO_APNS_TEAM_ID", environment)?);
        }

        let host = environment
            .get("MOMO_PUSH_RELAY_HOST")
            .filter(|value| !value.is_empty())
            .cloned()
            .unwrap_or_else(|| DEFAULT_HOST.to_string());

        Ok(RelayConfig {
            host,
            port,
            servers,
            rate_limit_per_minute: rate,
            sender_mode,
            stub_capture_path: environment
                .get("MOMO_APNS_STUB_CAPTURE_PATH")
                .filter(|value| !value.is_empty())
                .cloned(),
            stub_status,
            stub_reason: environment
                .get("MOMO_APNS_STUB_REASON")
                .filter(|value| !value.is_empty())
                .cloned(),
            apns_environment,
            apns_key_path,
            apns_key_id,
            apns_team_id,
        })
    }

    pub fn listen_addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

fn is_readable_file(path: &str) -> bool {
    Path::new(path).is_file() && std::fs::File::open(path).is_ok()
}

fn required(
    name: &'static str,
    environment: &HashMap<String, String>,
) -> Result<String, ConfigError> {
    match environment.get(name) {
        Some(value) if !value.is_empty() => Ok(value.clone()),
        _ => Err(ConfigError::Missing(name)),
    }
}

fn decode_registry(json: &str) -> Result<HashMap<String, [u8; 32]>, ConfigError> {
    let raw: HashMap<String, String> = serde_json::from_str(json).map_err(|_| {
        ConfigError::Invalid(
            "MOMO_RELAY_SERVERS must be a JSON object of server_id to base64 public key".into(),
        )
    })?;
    if raw.is_empty() {
        return Err(ConfigError::Invalid(
            "MOMO_RELAY_SERVERS must not be empty".into(),
        ));
    }
    let mut result = HashMap::new();
    for (server_id, encoded) in raw {
        if server_id.is_empty() || server_id.len() > 200 {
            return Err(ConfigError::Invalid(
                "server_id must contain 1...200 characters".into(),
            ));
        }
        let bytes = BASE64.decode(encoded.as_bytes()).map_err(|_| {
            ConfigError::Invalid(format!(
                "public key for {server_id} must be 32-byte Ed25519 raw key in base64"
            ))
        })?;
        if bytes.len() != 32 {
            return Err(ConfigError::Invalid(format!(
                "public key for {server_id} must be 32-byte Ed25519 raw key in base64"
            )));
        }
        let material: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
            ConfigError::Invalid(format!(
                "public key for {server_id} is not valid Ed25519 material"
            ))
        })?;
        VerifyingKey::from_bytes(&material).map_err(|_| {
            ConfigError::Invalid(format!(
                "public key for {server_id} is not valid Ed25519 material"
            ))
        })?;
        result.insert(server_id, material);
    }
    Ok(result)
}

fn positive_u16(raw: &str, name: &'static str) -> Result<u16, ConfigError> {
    let value: u16 = raw
        .parse()
        .map_err(|_| ConfigError::Invalid(format!("{name} must be a positive integer")))?;
    if value == 0 {
        return Err(ConfigError::Invalid(format!(
            "{name} must be a positive integer"
        )));
    }
    Ok(value)
}

fn positive_u32(raw: &str, name: &'static str) -> Result<u32, ConfigError> {
    let value: u32 = raw
        .parse()
        .map_err(|_| ConfigError::Invalid(format!("{name} must be a positive integer")))?;
    if value == 0 {
        return Err(ConfigError::Invalid(format!(
            "{name} must be a positive integer"
        )));
    }
    Ok(value)
}

fn positive_i32(raw: &str, name: &'static str) -> Result<i32, ConfigError> {
    let value: i32 = raw
        .parse()
        .map_err(|_| ConfigError::Invalid(format!("{name} must be a positive integer")))?;
    if value <= 0 {
        return Err(ConfigError::Invalid(format!(
            "{name} must be a positive integer"
        )));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn stub_environment() -> HashMap<String, String> {
        let seed = [7u8; 32];
        let public = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        let encoded = BASE64.encode(public);
        HashMap::from([
            (
                "MOMO_RELAY_SERVERS".into(),
                format!(r#"{{"server-a":"{encoded}"}}"#),
            ),
            ("MOMO_APNS_SENDER".into(), "stub".into()),
            ("MOMO_APNS_ALLOW_STUB".into(), "1".into()),
        ])
    }

    #[test]
    fn registry_parses_raw_ed25519_public_key() {
        let config = RelayConfig::load(&stub_environment(), |_| true).unwrap();
        assert_eq!(config.servers.len(), 1);
        assert_eq!(config.rate_limit_per_minute, 60);
        assert_eq!(config.port, 28195);
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.sender_mode, SenderMode::Stub);
    }

    /// Delete the MOMO_APNS_ALLOW_STUB guard and this goes red.
    #[test]
    fn stub_sender_without_explicit_opt_in_refuses_to_boot() {
        let mut environment = stub_environment();
        environment.remove("MOMO_APNS_ALLOW_STUB");
        let error = RelayConfig::load(&environment, |_| true).unwrap_err();
        assert!(matches!(error, ConfigError::StubSenderNotAllowed));
        assert!(error.to_string().contains("MOMO_APNS_ALLOW_STUB"));

        for rejected in ["0", "true", "yes", ""] {
            environment.insert("MOMO_APNS_ALLOW_STUB".into(), rejected.into());
            assert!(
                RelayConfig::load(&environment, |_| true).is_err(),
                "MOMO_APNS_ALLOW_STUB={rejected} must not enable the stub"
            );
        }
    }

    #[test]
    fn live_mode_refuses_to_boot_without_the_full_apns_credential() {
        let mut environment = stub_environment();
        environment.remove("MOMO_APNS_SENDER");
        environment.remove("MOMO_APNS_ALLOW_STUB");

        let error = RelayConfig::load(&environment, |_| true).unwrap_err();
        assert!(error.to_string().contains("MOMO_APNS_ENV"));

        environment.insert("MOMO_APNS_ENV".into(), "sandbox".into());
        for omitted in [
            "MOMO_APNS_KEY_PATH",
            "MOMO_APNS_KEY_ID",
            "MOMO_APNS_TEAM_ID",
        ] {
            let mut incomplete = environment.clone();
            incomplete.insert("MOMO_APNS_KEY_PATH".into(), "/run/secrets/apns.p8".into());
            incomplete.insert("MOMO_APNS_KEY_ID".into(), "ABCD123456".into());
            incomplete.insert("MOMO_APNS_TEAM_ID".into(), "TEAM123456".into());
            incomplete.remove(omitted);
            assert!(
                RelayConfig::load(&incomplete, |_| true).is_err(),
                "live mode must not boot without {omitted}"
            );
        }
    }

    #[test]
    fn live_mode_refuses_to_boot_when_the_apns_key_is_unreadable() {
        let mut environment = stub_environment();
        environment.insert("MOMO_APNS_SENDER".into(), "live".into());
        environment.remove("MOMO_APNS_ALLOW_STUB");
        environment.insert("MOMO_APNS_ENV".into(), "sandbox".into());
        environment.insert("MOMO_APNS_KEY_PATH".into(), "/run/secrets/apns.p8".into());
        environment.insert("MOMO_APNS_KEY_ID".into(), "ABCD123456".into());
        environment.insert("MOMO_APNS_TEAM_ID".into(), "TEAM123456".into());

        let error = RelayConfig::load(&environment, |_| false).unwrap_err();
        match error {
            ConfigError::UnreadableApnsKey(ref path) => {
                assert_eq!(path, "/run/secrets/apns.p8")
            }
            other => panic!("expected an unreadable-key refusal, got {other}"),
        }
        assert!(error.to_string().contains("MOMO_APNS_KEY_PATH"));

        let config = RelayConfig::load(&environment, |_| true).unwrap();
        assert_eq!(config.sender_mode, SenderMode::Live);
        assert_eq!(config.apns_environment, Some(ApnsEnvironment::Sandbox));
        assert_eq!(
            config.apns_key_path.as_deref(),
            Some("/run/secrets/apns.p8")
        );
    }

    #[test]
    fn an_empty_server_registry_refuses_to_boot() {
        let mut environment = stub_environment();
        environment.remove("MOMO_RELAY_SERVERS");
        let error = RelayConfig::load(&environment, |_| true).unwrap_err();
        assert!(error.to_string().contains("MOMO_RELAY_SERVERS"));

        environment.insert("MOMO_RELAY_SERVERS".into(), "{}".into());
        assert!(RelayConfig::load(&environment, |_| true).is_err());

        environment.insert(
            "MOMO_RELAY_SERVERS".into(),
            r#"{"server-a":"not-base64"}"#.into(),
        );
        assert!(RelayConfig::load(&environment, |_| true).is_err());
    }

    #[test]
    fn a_valid_key_signs_and_verifies_roundtrip_against_the_registry() {
        let seed = [3u8; 32];
        let key = SigningKey::from_bytes(&seed);
        let mut environment = stub_environment();
        let encoded = BASE64.encode(key.verifying_key().to_bytes());
        environment.insert(
            "MOMO_RELAY_SERVERS".into(),
            format!(r#"{{"verify-server":"{encoded}"}}"#),
        );
        let config = RelayConfig::load(&environment, |_| true).unwrap();
        let public = config.servers.get("verify-server").copied().unwrap();
        let body = br#"{"schema":"momo.push.dispatch.v2"}"#;
        let signature = key.sign(body);
        assert!(momo_wire::verify(&public, body, &signature.to_bytes()));
    }
}
