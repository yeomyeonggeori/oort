//! Registration with the server (ADR-0197 D2, M4 증보 2).
//!
//! The box-agent has no credential yet, so registration is a public request that proves one thing: this box holds
//! the **pairing code** the runner injected. It does that with an HMAC over `(box id, host key)` keyed by the code —
//! the code itself is never sent. The server cannot check the MAC (it never sees the code); it parks the request and
//! the runner, which holds the code, verifies it and attests the key. The agent therefore polls until the server
//! answers `active` with the host the runner's attestation created.
//!
//! The answer is checked as `momo-workd register` checks its own: the host the server created must be a
//! `scope = "member"`, `type = "cloud"` host **with the key that was asked for**
//! ([`crate::register::check_registered`]). A server that answers with a widened scope or another key is refused.

use std::time::{Duration, Instant};

use serde_json::Value;
use uuid::Uuid;

use crate::register::{registration_body, PairingSecret};

#[derive(Debug, thiserror::Error)]
pub enum EnrollError {
    /// This box's host key is already registered under another key: the identity does not change (409).
    #[error("the server holds a different host key for this box")]
    KeyConflict,
    #[error("the server does not know this box (404)")]
    UnknownBox,
    #[error("the runner has not attested this box within the allowed time")]
    TimedOut,
    #[error("could not build the HTTP client: {0}")]
    Client(String),
}

pub struct Enrollment<'a> {
    pub server_url: &'a str,
    pub workspace_id: Uuid,
    pub box_id: Uuid,
    pub host_public_key_b64: &'a str,
    pub host_public_key: [u8; 32],
}

/// Register and wait for `active`. Returns the server's answer (`{"state":"active","workHost":{…}}`).
/// Polls every few seconds, backing off; transport errors and `pending` are retried until `give_up_after`.
pub async fn register_until_active(
    enrollment: &Enrollment<'_>,
    secret: &PairingSecret,
    give_up_after: Duration,
    poll: Duration,
) -> Result<Value, EnrollError> {
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("momo-box-agent/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| EnrollError::Client(error.to_string()))?;
    let url = format!(
        "{}/v1/workspaces/{}/cloud-boxes/{}/agent/register",
        enrollment.server_url.trim_end_matches('/'),
        enrollment.workspace_id,
        enrollment.box_id
    );
    let mac = secret.mac(enrollment.box_id.as_bytes(), &enrollment.host_public_key);
    let body = registration_body(enrollment.host_public_key_b64, &mac);
    let deadline = Instant::now() + give_up_after;
    let mut wait = poll;
    let mut not_found = 0u32;
    loop {
        match http.post(&url).json(&body).send().await {
            Ok(response) => match response.status().as_u16() {
                200 => {
                    if let Ok(answer) = response.json::<Value>().await {
                        if answer.get("state").and_then(Value::as_str) == Some("active") {
                            return Ok(answer);
                        }
                    }
                }
                409 => return Err(EnrollError::KeyConflict),
                // 404 is also what a closed instance answers; only a run of them means "no such box".
                404 => {
                    not_found += 1;
                    if not_found >= 5 {
                        return Err(EnrollError::UnknownBox);
                    }
                }
                // 429 and anything else: wait and ask again.
                _ => {}
            },
            Err(_) => {}
        }
        if Instant::now() >= deadline {
            return Err(EnrollError::TimedOut);
        }
        tokio::time::sleep(wait).await;
        wait = (wait + wait / 2).min(Duration::from_secs(15));
    }
}
