//! The host's half of the server contract — every call signed with the v2
//! request format (`momo.work_host.request.v2`, ADR-0188 D7).
//!
//! One signer for every route: method, raw path, workspace, host, timestamp,
//! SHA-256 of the exact body bytes sent, and a fresh request id that the server
//! consumes once in the same transaction that verifies the signature
//! (`crates/momo-auth/src/work_host_request.rs`). The body is serialised once
//! and those same bytes are both hashed and sent, so the digest cannot describe
//! a different body than the one on the wire.
//!
//! A signed path never carries a query string: the query is outside the v2
//! payload, and ADR-0188 D7 has the server refuse a signed request that has one.
//! [`HostClient::signed`] refuses to build such a request rather than rely on
//! that.
//!
//! [`HostApi`] is the seam the invariant tests use: a fake server that records
//! calls, so the D6 guards can be proven without a database.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::keystore::HostKey;

const AUTHORIZATION: &str = "Authorization";
const SENT_AT_HEADER: &str = "X-Momo-Work-Host-Sent-At";
const SIGNATURE_HEADER: &str = "X-Momo-Work-Host-Signature";
const REQUEST_ID_HEADER: &str = "X-Momo-Work-Host-Request-ID";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The most bytes the host reads from one response (#2602 L-2). The largest
/// real answer — a page of pending controls — is a few KiB; anything past this
/// is refused rather than buffered.
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, thiserror::Error)]
pub enum ClientError {
    /// 401 — the signature, the host row, or its owner is no longer good.
    /// ADR-0188 D7: the host stops its remote sessions on this.
    #[error("the server refused this host's credential (401)")]
    Unauthorized,
    #[error("server answered {status}: {message}")]
    Status { status: u16, message: String },
    #[error("transport: {0}")]
    Transport(String),
    #[error("unexpected response: {0}")]
    Decode(String),
    #[error("refusing to sign a path with a query string: {0}")]
    QueryInSignedPath(String),
}

impl ClientError {
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Unauthorized => Some(401),
            Self::Status { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// Worth another attempt: the network, a rate limit, or a 5xx.
    pub fn is_transient(&self) -> bool {
        match self {
            Self::Transport(_) => true,
            Self::Status { status, .. } => *status == 429 || *status >= 500,
            _ => false,
        }
    }
}

// ---------------------------------------------------------------------------
// wire shapes (the server's camelCase DTOs; unknown fields tolerated)
// ---------------------------------------------------------------------------

/// `WorkControlDto`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkControl {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub requester_member_id: Uuid,
    pub target_host_id: Uuid,
    #[serde(default)]
    pub session_id: Option<Uuid>,
    pub kind: String,
    pub payload: Value,
    pub status: String,
}

impl WorkControl {
    pub fn payload_str(&self, key: &str) -> Option<&str> {
        self.payload.get(key).and_then(Value::as_str)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingControlsResponse {
    work_controls: Vec<WorkControl>,
}

/// `WorkSessionDto`, the fields the host uses.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkSession {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub host_id: Uuid,
    pub tool: String,
    pub label: String,
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkSessionResponse {
    work_session: WorkSession,
}

/// `WorkHostDto`, the fields registration keeps.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredHost {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub owner_member_id: Uuid,
    pub scope: String,
    #[serde(rename = "type")]
    pub host_type: String,
    pub public_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkHostResponse {
    work_host: RegisteredHost,
}

/// `POST …/work-controls/{control}/ack` body.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ControlAck {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_label: Option<String>,
}

impl ControlAck {
    pub fn ok(session_id: Option<Uuid>) -> Self {
        Self {
            ok: true,
            session_id,
            error_label: None,
        }
    }

    pub fn refused(label: &str) -> Self {
        Self {
            ok: false,
            session_id: None,
            error_label: Some(label.to_string()),
        }
    }
}

/// `POST …/work-sessions` body for a dispatched spawn (`controlId` arm).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateSession {
    pub channel_id: Uuid,
    pub host_id: Uuid,
    pub tool: String,
    pub label: String,
    pub control_id: Uuid,
}

/// `WorkSessionAcpEvent` — snake_case on the wire, as the server decodes it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AcpEvent {
    pub event_id: Uuid,
    #[serde(rename = "type")]
    pub event_type: String,
    pub v: i64,
    pub ts: i64,
    pub payload: Value,
}

/// The host-signed lifecycle PATCHes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    /// A prompt turn finished; `exit_code` is the turn's result (ADR-0139 D1).
    Idle {
        exit_code: i32,
    },
    Running,
    Ended {
        exit_code: Option<i32>,
    },
}

impl SessionStatus {
    fn body(self) -> Value {
        match self {
            Self::Idle { exit_code } => json!({"status": "idle", "exitCode": exit_code}),
            Self::Running => json!({"status": "running"}),
            Self::Ended {
                exit_code: Some(code),
            } => json!({"status": "ended", "exitCode": code}),
            Self::Ended { exit_code: None } => json!({"status": "ended"}),
        }
    }
}

/// Everything the loops need from the server. The real implementation is
/// [`HostClient`]; tests substitute a recorder.
#[async_trait]
pub trait HostApi: Send + Sync + 'static {
    fn host_id(&self) -> Uuid;
    async fn heartbeat(&self) -> Result<(), ClientError>;
    async fn pending_controls(&self) -> Result<Vec<WorkControl>, ClientError>;
    async fn ack(&self, control_id: Uuid, ack: &ControlAck) -> Result<(), ClientError>;
    async fn create_session(&self, request: &CreateSession) -> Result<WorkSession, ClientError>;
    async fn record_event(&self, session_id: Uuid, event: &AcpEvent) -> Result<(), ClientError>;
    async fn set_status(&self, session_id: Uuid, status: SessionStatus) -> Result<(), ClientError>;
}

// ---------------------------------------------------------------------------
// the real client
// ---------------------------------------------------------------------------

pub struct HostClient {
    http: reqwest::Client,
    base: String,
    workspace_id: Uuid,
    host_id: Uuid,
    key: Arc<HostKey>,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

fn http_client() -> Result<reqwest::Client, ClientError> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        // A redirect would re-send a signed request to a path it was not signed
        // for; the server never redirects these routes.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| ClientError::Transport(error.to_string()))
}

async fn read_response(response: reqwest::Response) -> Result<Vec<u8>, ClientError> {
    let status = response.status();
    // The status line is the answer; a 401's body is not needed to act on it.
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(ClientError::Unauthorized);
    }
    let bytes = read_capped(response, MAX_RESPONSE_BYTES).await?;
    if !status.is_success() {
        let message = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|body| {
                body.pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_default();
        return Err(ClientError::Status {
            status: status.as_u16(),
            message,
        });
    }
    Ok(bytes.to_vec())
}

/// Read a body chunk by chunk and stop at `limit`, whether or not the server
/// announced a length.
async fn read_capped(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, ClientError> {
    let too_large = || ClientError::Transport(format!("response larger than {limit} bytes"));
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| ClientError::Transport(error.to_string()))?
    {
        if body.len() + chunk.len() > limit {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn decode<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, ClientError> {
    serde_json::from_slice(bytes).map_err(|error| ClientError::Decode(error.to_string()))
}

impl HostClient {
    pub fn new(
        base: String,
        workspace_id: Uuid,
        host_id: Uuid,
        key: Arc<HostKey>,
    ) -> Result<Self, ClientError> {
        Ok(Self {
            http: http_client()?,
            base,
            workspace_id,
            host_id,
            key,
        })
    }

    /// The four signed headers for one request.
    fn signature_headers(
        &self,
        method: &Method,
        path: &str,
        body: &[u8],
    ) -> Vec<(&'static str, String)> {
        let sent_at_ms = now_ms();
        let request_id = Uuid::new_v4();
        let payload = momo_wire::request_payload(
            method.as_str(),
            path,
            self.workspace_id,
            self.host_id,
            sent_at_ms,
            &momo_wire::sha256_hex(body),
            request_id,
        );
        vec![
            (AUTHORIZATION, format!("MomoHost {}", self.host_id)),
            (SENT_AT_HEADER, sent_at_ms.to_string()),
            (SIGNATURE_HEADER, self.key.sign_b64(&payload)),
            (REQUEST_ID_HEADER, request_id.to_string()),
        ]
    }

    /// Send one v2-signed request. `body` is serialised exactly once.
    pub async fn signed(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Vec<u8>, ClientError> {
        if path.contains('?') || path.contains('#') {
            return Err(ClientError::QueryInSignedPath(path.to_string()));
        }
        let raw = match body {
            Some(value) => serde_json::to_vec(value).expect("serde_json::Value serialises"),
            None => Vec::new(),
        };
        let mut request = self
            .http
            .request(method.clone(), format!("{}{path}", self.base));
        for (name, value) in self.signature_headers(&method, path, &raw) {
            request = request.header(name, value);
        }
        if body.is_some() {
            request = request.header("Content-Type", "application/json").body(raw);
        }
        let response = request
            .send()
            .await
            .map_err(|error| ClientError::Transport(error.to_string()))?;
        read_response(response).await
    }

    fn workspace_path(&self, rest: &str) -> String {
        format!("/v1/workspaces/{}/{rest}", self.workspace_id)
    }
}

#[async_trait]
impl HostApi for HostClient {
    fn host_id(&self) -> Uuid {
        self.host_id
    }

    /// v2 heartbeat (ADR-0188 D7, served by #2570): the same signed-request
    /// format as every other host call — request id consumed once — with an
    /// empty body, since the server reads nothing from it (the digest still
    /// covers it). The v1 body (`{sentAtMs, signature}`) is never produced.
    async fn heartbeat(&self) -> Result<(), ClientError> {
        let path = self.workspace_path(&format!("work-hosts/{}/heartbeat", self.host_id));
        self.signed(Method::POST, &path, None).await.map(|_| ())
    }

    async fn pending_controls(&self) -> Result<Vec<WorkControl>, ClientError> {
        let path = self.workspace_path(&format!("work-hosts/{}/pending-controls", self.host_id));
        let bytes = self.signed(Method::GET, &path, None).await?;
        Ok(decode::<PendingControlsResponse>(&bytes)?.work_controls)
    }

    async fn ack(&self, control_id: Uuid, ack: &ControlAck) -> Result<(), ClientError> {
        let path = self.workspace_path(&format!("work-controls/{control_id}/ack"));
        let body = serde_json::to_value(ack).expect("ControlAck serialises");
        self.signed(Method::POST, &path, Some(&body))
            .await
            .map(|_| ())
    }

    async fn create_session(&self, request: &CreateSession) -> Result<WorkSession, ClientError> {
        let path = self.workspace_path("work-sessions");
        let body = serde_json::to_value(request).expect("CreateSession serialises");
        let bytes = self.signed(Method::POST, &path, Some(&body)).await?;
        Ok(decode::<WorkSessionResponse>(&bytes)?.work_session)
    }

    async fn record_event(&self, session_id: Uuid, event: &AcpEvent) -> Result<(), ClientError> {
        let path = self.workspace_path(&format!("work-sessions/{session_id}"));
        let body = json!({ "event": event });
        self.signed(Method::PATCH, &path, Some(&body))
            .await
            .map(|_| ())
    }

    async fn set_status(&self, session_id: Uuid, status: SessionStatus) -> Result<(), ClientError> {
        let path = self.workspace_path(&format!("work-sessions/{session_id}"));
        self.signed(Method::PATCH, &path, Some(&status.body()))
            .await
            .map(|_| ())
    }
}

/// `POST /v1/workspaces/{ws}/work-hosts` with the **owner's** bearer — the one
/// call a host makes as a person rather than as itself (ADR-0188 D2/D3: the
/// person who registers is the owner). The token is used for this request and
/// dropped; it is never stored.
pub async fn register_host(
    base: &str,
    workspace_id: Uuid,
    bearer: &str,
    display_name: &str,
    public_key_b64: &str,
) -> Result<RegisteredHost, ClientError> {
    let http = http_client()?;
    let response = http
        .post(format!("{base}/v1/workspaces/{workspace_id}/work-hosts"))
        .bearer_auth(bearer)
        .json(&json!({
            // ADR-0188 D3: a desktop host is always the registering person's own.
            "scope": "member",
            "type": "workd",
            "displayName": display_name.trim(),
            "publicKey": public_key_b64,
            "capabilities": { "acp": true, "terminal_attach": false },
        }))
        .send()
        .await
        .map_err(|error| ClientError::Transport(error.to_string()))?;
    let bytes = read_response(response).await?;
    Ok(decode::<WorkHostResponse>(&bytes)?.work_host)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> HostClient {
        HostClient::new(
            "https://oort.example.com".to_string(),
            Uuid::from_u128(0xa),
            Uuid::from_u128(0xb),
            Arc::new(HostKey::generate().unwrap()),
        )
        .unwrap()
    }

    /// The signature a host produces verifies under the server's own verifier
    /// for exactly the method, path and body bytes it sends — and for nothing
    /// else.
    #[test]
    fn signed_headers_verify_under_the_server_verifier() {
        let client = client();
        let path = "/v1/workspaces/0000000a/work-hosts/0000000b/heartbeat";
        let body = serde_json::to_vec(&json!({})).unwrap();
        let headers = client.signature_headers(&Method::POST, path, &body);
        let get = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.clone())
                .unwrap()
        };
        assert_eq!(
            get(AUTHORIZATION),
            format!("MomoHost {}", Uuid::from_u128(0xb))
        );
        let sent_at: i64 = get(SENT_AT_HEADER).parse().unwrap();
        let request_id = Uuid::parse_str(&get(REQUEST_ID_HEADER)).unwrap();
        let signature = get(SIGNATURE_HEADER);
        let verify = |method: &str, path: &str, body: &[u8]| {
            momo_wire::verify_work_host_request(
                &client.key.public_key_b64(),
                &signature,
                method,
                path,
                Uuid::from_u128(0xa),
                Uuid::from_u128(0xb),
                sent_at,
                &momo_wire::sha256_hex(body),
                request_id,
            )
        };
        assert!(verify("POST", path, &body));
        assert!(!verify("POST", path, b"{\"ok\":true}"), "body is bound");
        assert!(!verify("GET", path, &body), "method is bound");
        assert!(!verify(
            "POST",
            "/v1/workspaces/0000000a/work-hosts/0000000c/heartbeat",
            &body
        ));
    }

    #[test]
    fn a_fresh_request_id_per_request() {
        let client = client();
        let first = client.signature_headers(&Method::GET, "/p", b"");
        let second = client.signature_headers(&Method::GET, "/p", b"");
        let id = |headers: &[(&str, String)]| {
            headers
                .iter()
                .find(|(key, _)| *key == REQUEST_ID_HEADER)
                .unwrap()
                .1
                .clone()
        };
        assert_ne!(id(&first), id(&second));
    }

    #[tokio::test]
    async fn a_query_string_is_never_signed() {
        let error = client()
            .signed(
                Method::GET,
                "/v1/workspaces/a/work-hosts/b/pending-controls?all=1",
                None,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, ClientError::QueryInSignedPath(_)));
    }

    #[test]
    fn lifecycle_bodies_match_the_server_patch_arms() {
        assert_eq!(
            SessionStatus::Idle { exit_code: 0 }.body(),
            json!({"status": "idle", "exitCode": 0})
        );
        assert_eq!(SessionStatus::Running.body(), json!({"status": "running"}));
        assert_eq!(
            SessionStatus::Ended {
                exit_code: Some(143)
            }
            .body(),
            json!({"status": "ended", "exitCode": 143})
        );
        assert_eq!(
            serde_json::to_value(ControlAck::refused("shell_refused")).unwrap(),
            json!({"ok": false, "errorLabel": "shell_refused"})
        );
    }

    /// One HTTP/1.1 exchange on a loopback socket: read the request, answer
    /// with `head` and then `body_bytes` bytes of JSON-ish filler.
    fn serve_once(head: &'static str, body_bytes: usize) -> std::net::SocketAddr {
        use std::io::{Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = socket.read(&mut request);
            let _ = socket.write_all(head.as_bytes());
            let chunk = vec![b' '; 64 * 1024];
            let mut sent = 0;
            while sent < body_bytes {
                let take = chunk.len().min(body_bytes - sent);
                if socket.write_all(&chunk[..take]).is_err() {
                    break;
                }
                sent += take;
            }
        });
        address
    }

    async fn read_from(address: std::net::SocketAddr) -> Result<Vec<u8>, ClientError> {
        let response = http_client()
            .unwrap()
            .get(format!("http://{address}/"))
            .send()
            .await
            .expect("loopback response head");
        read_response(response).await
    }

    #[tokio::test]
    async fn a_response_past_the_cap_is_refused_with_or_without_a_length() {
        // No length announced: the body is cut off while it streams.
        let address = serve_once(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n",
            2 * MAX_RESPONSE_BYTES,
        );
        match read_from(address).await {
            Err(ClientError::Transport(message)) => assert!(message.contains("larger than")),
            other => panic!(
                "an unbounded body must be refused, got {:?}",
                other.map(|b| b.len())
            ),
        }
        // An announced length past the cap is refused before reading.
        let address = serve_once(
            "HTTP/1.1 200 OK\r\ncontent-length: 2097152\r\nconnection: close\r\n\r\n",
            0,
        );
        match read_from(address).await {
            Err(ClientError::Transport(message)) => assert!(message.contains("larger than")),
            other => panic!(
                "an oversized length must be refused, got {:?}",
                other.map(|b| b.len())
            ),
        }
        // A body within the cap is read whole.
        let address = serve_once(
            "HTTP/1.1 200 OK\r\ncontent-length: 1000\r\nconnection: close\r\n\r\n",
            1000,
        );
        assert_eq!(read_from(address).await.unwrap().len(), 1000);
    }
}
