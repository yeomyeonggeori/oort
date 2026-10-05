//! The runner's side of the wire: outbound HTTPS to the oort server, nothing else. The runner
//! opens no listener and no inbound port (ADR-0197 D2/D9); this client is its only network
//! code. Three calls — claim, complete, boxes — each authenticated with the runner
//! credential as a bearer. The credential lives in this struct and never in a log line (the
//! `Debug` impl hides it).

use std::time::Duration;

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Deserialize;
use uuid::Uuid;

use crate::reconcile::ServerBox;
use crate::wire::{ClaimEnvelope, CompleteBody};

/// A box-agent registration the server parked for this runner to check (ADR-0197 M4 증보 2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingRegistration {
    pub box_id: Uuid,
    pub host_public_key: [u8; 32],
    pub mac: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("the server could not be reached: {0}")]
    Transport(String),
    /// 401: the credential is not (or no longer) accepted.
    #[error("the server refused the runner credential")]
    Unauthorized,
    /// 404: the box API is closed on this instance.
    #[error("the cloud box API is not enabled on this server")]
    NotEnabled,
    /// 409 on complete: the lease is no longer this runner's (fenced out).
    #[error("the control is stale (lease expired, re-issued or cancelled)")]
    Stale,
    #[error("the server answered {0}")]
    Status(u16),
    #[error("the server's answer is not the expected shape")]
    Shape,
    /// The server already holds a different public key for this runner (the identity is set once).
    #[error("the server already holds another public key for this runner")]
    IdentityConflict,
}

/// What the runner needs from the server. A trait so the loop is testable without HTTP.
#[async_trait]
pub trait ServerApi: Send + Sync {
    async fn claim(&self, limit: u32) -> Result<ClaimEnvelope, ClientError>;
    async fn complete(&self, control_id: Uuid, body: &CompleteBody) -> Result<(), ClientError>;
    async fn boxes(&self) -> Result<Vec<ServerBox>, ClientError>;
    /// The box's first owner device list (opaque bytes), for its `create`.
    async fn provisioning(&self, _box_id: Uuid) -> Result<Vec<u8>, ClientError> {
        Err(ClientError::Status(404))
    }
    /// Registrations waiting for this runner to verify.
    async fn registrations(&self) -> Result<Vec<PendingRegistration>, ClientError> {
        Ok(Vec::new())
    }
    /// The runner verified a registration: attest the host key.
    async fn attest(
        &self,
        _box_id: Uuid,
        _host_public_key: &[u8; 32],
        _attestation: &[u8; 64],
    ) -> Result<(), ClientError> {
        Ok(())
    }
    /// The runner could not verify a registration: free the slot.
    async fn reject(&self, _box_id: Uuid, _host_public_key: &[u8; 32]) -> Result<(), ClientError> {
        Ok(())
    }
    /// Tell the server this runner's public key (set once).
    async fn set_identity(&self, _public_key: &[u8; 32]) -> Result<(), ClientError> {
        Ok(())
    }
}

pub struct HttpServer {
    http: reqwest::Client,
    base: String,
    workspace: Uuid,
    credential: String,
}

impl std::fmt::Debug for HttpServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpServer")
            .field("base", &self.base)
            .field("workspace", &self.workspace)
            .field("credential", &"<hidden>")
            .finish()
    }
}

impl HttpServer {
    pub fn new(base: &str, workspace: Uuid, credential: String) -> Result<Self, ClientError> {
        let http = reqwest::Client::builder()
            // The bearer must never follow a redirect to another host.
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!("momo-box-runner/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| ClientError::Transport(error.to_string()))?;
        Ok(HttpServer {
            http,
            base: base.trim_end_matches('/').to_string(),
            workspace,
            credential,
        })
    }

    fn url(&self, tail: &str) -> String {
        format!(
            "{}/v1/workspaces/{}/cloud-box-runner{tail}",
            self.base,
            self.workspace.as_hyphenated()
        )
    }

    async fn send(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, ClientError> {
        let response = request
            .bearer_auth(&self.credential)
            .send()
            .await
            .map_err(|error| ClientError::Transport(error.without_url().to_string()))?;
        match response.status().as_u16() {
            200..=299 => Ok(response),
            401 => Err(ClientError::Unauthorized),
            404 => Err(ClientError::NotEnabled),
            409 => Err(ClientError::Stale),
            other => Err(ClientError::Status(other)),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoxesResponse {
    boxes: Vec<BoxEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoxEntry {
    box_id: Uuid,
    state: String,
}

#[async_trait]
impl ServerApi for HttpServer {
    async fn claim(&self, limit: u32) -> Result<ClaimEnvelope, ClientError> {
        let response = self
            .send(
                self.http
                    .post(self.url("/claim"))
                    .json(&serde_json::json!({ "limit": limit })),
            )
            .await?;
        response.json().await.map_err(|_| ClientError::Shape)
    }

    async fn complete(&self, control_id: Uuid, body: &CompleteBody) -> Result<(), ClientError> {
        self.send(
            self.http
                .post(self.url(&format!(
                    "/controls/{}/complete",
                    control_id.as_hyphenated()
                )))
                .json(body),
        )
        .await
        .map(|_| ())
    }

    async fn boxes(&self) -> Result<Vec<ServerBox>, ClientError> {
        let response = self.send(self.http.get(self.url("/boxes"))).await?;
        let parsed: BoxesResponse = response.json().await.map_err(|_| ClientError::Shape)?;
        Ok(parsed
            .boxes
            .into_iter()
            .map(|entry| ServerBox {
                box_id: entry.box_id,
                state: entry.state,
            })
            .collect())
    }

    async fn provisioning(&self, box_id: Uuid) -> Result<Vec<u8>, ClientError> {
        let response = self
            .send(self.http.get(self.url(&format!(
                "/boxes/{}/provisioning",
                box_id.as_hyphenated()
            ))))
            .await?;
        let parsed: ProvisioningResponse = response.json().await.map_err(|_| ClientError::Shape)?;
        BASE64
            .decode(parsed.owner_device_list.trim())
            .map_err(|_| ClientError::Shape)
    }

    async fn registrations(&self) -> Result<Vec<PendingRegistration>, ClientError> {
        let response = self.send(self.http.get(self.url("/registrations"))).await?;
        let parsed: RegistrationsResponse = response.json().await.map_err(|_| ClientError::Shape)?;
        Ok(parsed
            .registrations
            .into_iter()
            .filter_map(|entry| {
                // A malformed entry is skipped, never acted on.
                let key: [u8; 32] = BASE64.decode(entry.host_public_key.trim()).ok()?.try_into().ok()?;
                let mac = BASE64.decode(entry.mac.trim()).ok()?;
                Some(PendingRegistration {
                    box_id: entry.box_id,
                    host_public_key: key,
                    mac,
                })
            })
            .collect())
    }

    async fn attest(
        &self,
        box_id: Uuid,
        host_public_key: &[u8; 32],
        attestation: &[u8; 64],
    ) -> Result<(), ClientError> {
        self.send(
            self.http
                .post(self.url(&format!("/boxes/{}/attestation", box_id.as_hyphenated())))
                .json(&serde_json::json!({
                    "hostPublicKey": BASE64.encode(host_public_key),
                    "attestation": BASE64.encode(attestation),
                })),
        )
        .await
        .map(|_| ())
    }

    async fn reject(&self, box_id: Uuid, host_public_key: &[u8; 32]) -> Result<(), ClientError> {
        self.send(
            self.http
                .post(self.url(&format!(
                    "/boxes/{}/registration/reject",
                    box_id.as_hyphenated()
                )))
                .json(&serde_json::json!({ "hostPublicKey": BASE64.encode(host_public_key) })),
        )
        .await
        .map(|_| ())
    }

    async fn set_identity(&self, public_key: &[u8; 32]) -> Result<(), ClientError> {
        let response = self
            .http
            .put(self.url("/identity"))
            .bearer_auth(&self.credential)
            .json(&serde_json::json!({ "publicKey": BASE64.encode(public_key) }))
            .send()
            .await
            .map_err(|error| ClientError::Transport(error.without_url().to_string()))?;
        match response.status().as_u16() {
            200..=299 => Ok(()),
            401 => Err(ClientError::Unauthorized),
            404 => Err(ClientError::NotEnabled),
            // 409: a different key is already set. The runner's identity does not change; it must stop.
            409 => Err(ClientError::IdentityConflict),
            other => Err(ClientError::Status(other)),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvisioningResponse {
    owner_device_list: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationEntry {
    box_id: Uuid,
    host_public_key: String,
    mac: String,
}

#[derive(Debug, Deserialize)]
struct RegistrationsResponse {
    registrations: Vec<RegistrationEntry>,
}
