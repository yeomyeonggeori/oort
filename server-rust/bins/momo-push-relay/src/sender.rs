//! APNs senders: stub (never contacts Apple) and live (HTTP/2 token auth).
//!
//! Live tests drive a loopback mock. The production endpoints
//! `api.push.apple.com` / `api.sandbox.push.apple.com` are never dialled from
//! this crate's test suite.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};

use crate::config::ApnsEnvironment;
use crate::dispatch::{ApnsPayload, PushDispatch};

const PROVIDER_TOKEN_TTL: Duration = Duration::from_secs(50 * 60);
const APNS_TIMEOUT: Duration = Duration::from_secs(10);

/// Receipt JSON the notifier's `decode_receipt` reads (`apns_status`,
/// `apns_reason`). `apns_id` is the Swift field; the notifier ignores it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushReceipt {
    pub apns_status: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apns_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apns_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApnsResult {
    pub status: i32,
    pub reason: Option<String>,
    pub apns_id: Option<String>,
}

impl From<ApnsResult> for PushReceipt {
    fn from(result: ApnsResult) -> Self {
        PushReceipt {
            apns_status: result.status,
            apns_reason: result.reason,
            apns_id: result.apns_id,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SenderError {
    #[error("dispatch APNs environment does not match relay")]
    EnvironmentMismatch,
    #[error("APNs transport failed")]
    Transport(String),
    #[error("cannot read the APNs signing key at MOMO_APNS_KEY_PATH={0}")]
    UnreadableKey(String),
    #[error("APNs signing key is not ES256 P-256 material")]
    InvalidKey,
}

pub enum ApnsSender {
    Stub(StubApnsSender),
    Live(LiveApnsSender),
}

impl ApnsSender {
    pub async fn send(&self, dispatch: &PushDispatch) -> Result<ApnsResult, SenderError> {
        match self {
            ApnsSender::Stub(sender) => sender.send(dispatch).await,
            ApnsSender::Live(sender) => sender.send(dispatch).await,
        }
    }
}

pub struct StubApnsSender {
    status: i32,
    reason: Option<String>,
    capture_path: Option<String>,
}

impl StubApnsSender {
    pub fn new(status: i32, reason: Option<String>, capture_path: Option<String>) -> Self {
        StubApnsSender {
            status,
            reason,
            capture_path,
        }
    }

    async fn send(&self, dispatch: &PushDispatch) -> Result<ApnsResult, SenderError> {
        let payload = serde_json::to_vec(&ApnsPayload::from_dispatch(dispatch))
            .map_err(|error| SenderError::Transport(error.to_string()))?;
        if let Some(path) = &self.capture_path {
            append_jsonl(path, &payload).await?;
        }
        Ok(ApnsResult {
            status: self.status,
            reason: self.reason.clone(),
            apns_id: Some("stub-apns-id".into()),
        })
    }
}

async fn append_jsonl(path: &str, payload: &[u8]) -> Result<(), SenderError> {
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .map_err(|error| SenderError::Transport(error.to_string()))?;
    file.write_all(payload)
        .await
        .map_err(|error| SenderError::Transport(error.to_string()))?;
    file.write_all(b"\n")
        .await
        .map_err(|error| SenderError::Transport(error.to_string()))?;
    Ok(())
}

struct CachedToken {
    token: String,
    issued_at: SystemTime,
}

pub struct LiveApnsSender {
    client: reqwest::Client,
    endpoint: String,
    environment: ApnsEnvironment,
    encoding_key: EncodingKey,
    key_id: String,
    team_id: String,
    cached: Mutex<Option<CachedToken>>,
}

#[derive(Serialize)]
struct ApnsClaims<'a> {
    iss: &'a str,
    iat: u64,
}

impl LiveApnsSender {
    pub fn new(
        environment: ApnsEnvironment,
        key_path: &str,
        key_id: String,
        team_id: String,
    ) -> Result<Self, SenderError> {
        Self::new_with_endpoint(
            environment.endpoint().to_string(),
            environment,
            key_path,
            key_id,
            team_id,
        )
    }

    /// Test seam: talk to a loopback mock instead of Apple.
    pub fn new_with_endpoint(
        endpoint: String,
        environment: ApnsEnvironment,
        key_path: &str,
        key_id: String,
        team_id: String,
    ) -> Result<Self, SenderError> {
        let pem =
            std::fs::read(key_path).map_err(|_| SenderError::UnreadableKey(key_path.into()))?;
        let encoding_key = EncodingKey::from_ec_pem(&pem).map_err(|_| SenderError::InvalidKey)?;
        let client = reqwest::Client::builder()
            .timeout(APNS_TIMEOUT)
            .build()
            .map_err(|error| SenderError::Transport(error.to_string()))?;
        Ok(LiveApnsSender {
            client,
            endpoint,
            environment,
            encoding_key,
            key_id,
            team_id,
            cached: Mutex::new(None),
        })
    }

    fn provider_token(&self, now: SystemTime) -> Result<String, SenderError> {
        let mut cached = self.cached.lock().expect("provider token mutex");
        if let Some(current) = cached.as_ref() {
            if now
                .duration_since(current.issued_at)
                .unwrap_or(Duration::ZERO)
                < PROVIDER_TOKEN_TTL
            {
                return Ok(current.token.clone());
            }
        }
        let iat = now
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_secs();
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(self.key_id.clone());
        header.typ = None;
        let claims = ApnsClaims {
            iss: &self.team_id,
            iat,
        };
        let token = jsonwebtoken::encode(&header, &claims, &self.encoding_key)
            .map_err(|_| SenderError::InvalidKey)?;
        *cached = Some(CachedToken {
            token: token.clone(),
            issued_at: now,
        });
        Ok(token)
    }

    async fn send(&self, dispatch: &PushDispatch) -> Result<ApnsResult, SenderError> {
        if dispatch.apns_env != self.environment.as_str() {
            return Err(SenderError::EnvironmentMismatch);
        }
        let provider_token = self.provider_token(SystemTime::now())?;
        let url = format!(
            "{}/3/device/{}",
            self.endpoint.trim_end_matches('/'),
            dispatch.apns_token
        );
        let payload = serde_json::to_vec(&ApnsPayload::from_dispatch(dispatch))
            .map_err(|error| SenderError::Transport(error.to_string()))?;
        let response = self
            .client
            .post(url)
            .header("authorization", format!("bearer {provider_token}"))
            .header("apns-topic", &dispatch.apns_topic)
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .header("apns-collapse-id", &dispatch.collapse_id)
            .header("content-type", "application/json")
            .body(payload)
            .send()
            .await
            .map_err(|error| SenderError::Transport(error.to_string()))?;
        let status = i32::from(response.status().as_u16());
        let apns_id = response
            .headers()
            .get("apns-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let reason = match response.bytes().await {
            Ok(bytes) if !bytes.is_empty() => serde_json::from_slice::<ValueReason>(&bytes)
                .ok()
                .and_then(|body| body.reason),
            _ => None,
        };
        Ok(ApnsResult {
            status,
            reason,
            apns_id,
        })
    }
}

#[derive(Deserialize)]
struct ValueReason {
    reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::{PushDispatch, TEST_DISPATCH_JSON};

    fn temp_p8() -> std::path::PathBuf {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "momo-push-relay-test-{}-{}.p8",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut last_err = String::from("no openssl binary found");
        for candidate in [
            "openssl",
            "/opt/homebrew/bin/openssl",
            "/usr/local/bin/openssl",
            "/opt/homebrew/opt/openssl@3/bin/openssl",
            "/usr/bin/openssl",
        ] {
            let output = std::process::Command::new(candidate)
                .args([
                    "genpkey",
                    "-algorithm",
                    "EC",
                    "-pkeyopt",
                    "ec_paramgen_curve:P-256",
                    "-out",
                ])
                .arg(&path)
                .output();
            match output {
                Ok(output) if output.status.success() && path.is_file() => return path,
                Ok(output) => {
                    last_err = String::from_utf8_lossy(&output.stderr).into_owned();
                }
                Err(error) => last_err = error.to_string(),
            }
        }
        panic!(
            "cannot mint a throwaway P-256 PKCS#8 for live unit tests (never embed a .p8): {last_err}"
        );
    }

    #[tokio::test]
    async fn stub_writes_id_only_capture_and_returns_configured_status() {
        let dir = std::env::temp_dir();
        let capture = dir.join(format!(
            "momo-push-relay-capture-{}.jsonl",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&capture);
        let sender = StubApnsSender::new(
            410,
            Some("Unregistered".into()),
            Some(capture.to_string_lossy().into()),
        );
        let dispatch = PushDispatch::decode_closed(TEST_DISPATCH_JSON.as_bytes()).unwrap();
        let result = sender.send(&dispatch).await.unwrap();
        assert_eq!(result.status, 410);
        assert_eq!(result.reason.as_deref(), Some("Unregistered"));
        assert_eq!(result.apns_id.as_deref(), Some("stub-apns-id"));
        let line = std::fs::read_to_string(&capture).unwrap();
        let object: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        let keys: Vec<_> = object.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, vec!["aps".to_string(), "momo".to_string()]);
        let text = line;
        for forbidden in [
            "message_body",
            "display_name",
            "handle",
            "channel_name",
            "apns_token",
        ] {
            assert!(!text.contains(forbidden));
        }
        let _ = std::fs::remove_file(&capture);
    }

    #[tokio::test]
    async fn live_sender_posts_http2_shaped_request_to_a_loopback_mock_never_apple() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel::<(String, String, Vec<u8>)>();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0u8; 8192];
            use tokio::io::AsyncReadExt;
            let mut stream = socket;
            let n = stream.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..n]).to_string();
            let auth = request
                .lines()
                .find(|line| line.to_ascii_lowercase().starts_with("authorization:"))
                .unwrap_or("")
                .to_string();
            let path = request.lines().next().unwrap_or("").to_string();
            let body_start = request
                .find("\r\n\r\n")
                .map(|i| i + 4)
                .unwrap_or(request.len());
            let body = request.as_bytes()[body_start..].to_vec();
            let _ = seen_tx.send((path, auth, body));
            use tokio::io::AsyncWriteExt;
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\napns-id: mock-apns-id\r\n\r\n")
                .await
                .unwrap();
        });

        let key_path = temp_p8();
        let sender = LiveApnsSender::new_with_endpoint(
            format!("http://{addr}"),
            ApnsEnvironment::Sandbox,
            key_path.to_str().unwrap(),
            "ABCD123456".into(),
            "TEAM123456".into(),
        )
        .unwrap();
        let dispatch = PushDispatch::decode_closed(TEST_DISPATCH_JSON.as_bytes()).unwrap();
        let result = sender.send(&dispatch).await.unwrap();
        assert_eq!(result.status, 200);
        assert_eq!(result.apns_id.as_deref(), Some("mock-apns-id"));

        let (path, auth, body) = seen_rx.await.unwrap();
        assert!(path.contains("/3/device/deadbeefdeadbeef"), "{path}");
        assert!(auth
            .to_ascii_lowercase()
            .starts_with("authorization: bearer "));
        let object: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(object["aps"]["alert"]["title"], "oort");
        let text = String::from_utf8_lossy(&body);
        assert!(!text.contains("apns_token"));
        let _ = std::fs::remove_file(&key_path);
    }

    #[test]
    fn live_sender_refuses_an_unreadable_p8() {
        let error = match LiveApnsSender::new(
            ApnsEnvironment::Sandbox,
            "/definitely-not-a-key.p8",
            "ABCD123456".into(),
            "TEAM123456".into(),
        ) {
            Ok(_) => panic!("unreadable .p8 must refuse to construct"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("MOMO_APNS_KEY_PATH"));
    }
}
