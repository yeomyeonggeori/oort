// The shell's own refresh rotation (#3106, ADR-0146 D-7 증보 #3079).
//
// Until #3106 the webview rotated the refresh token (`@momo/core`
// `rotateOnce`) and moved it through the keychain commands. Two things now
// need the rotation to live here instead:
//
//   * **The proof.** Every refresh carries `momo.human.refresh_proof.v1`,
//     signed by a Secure Enclave *refresh key* (`device_key::enclave`
//     `REFRESH_KEY_TAG`: PrivateKeyUsage only, no presence, a different item
//     from the Touch ID instruction key). The key lives in the shell (D-3)
//     and the webview is never handed a "sign these bytes" command (#3097
//     L2), so the proof has to be made next to the request.
//   * **Cmd+Q.** tao answers Quit straight into `RunEvent::Exit` with no veto
//     (#3098 `rotation_hold.rs`), so a rotation can always be cut in half.
//     With the server's recovery rule (a spent token presented with the
//     lineage key's proof gets a fresh pair, however long ago it was spent),
//     the half-done rotation is harmless as long as the NEXT launch presents
//     the token it still holds together with a proof — which is exactly what
//     `attempt` does. Nothing extra is written for recovery; the keychain
//     keeps the presented token until a 200's successor replaces it.
//
// What crosses the bridge (commands granted in `capabilities/default.json`):
//
//   session_refresh_attempt  {apiBase, workspaceId, memberId, skewMs} →
//                            {status, code?, date?, accessToken?, refreshToken?, proved}
//                            ONE POST. `refreshToken` is a handle
//                            (`shell:` + 32 hex of SHA-256), never the token.
//                            The retry policy (stale → server time, replayed
//                            → new nonce, one retry of a plain 401 on a proved
//                            refresh) is the core's (`@momo/core` api.ts), so
//                            phone and desktop share one state machine.
//   session_revoke           {apiBase, accessToken, workspaceId, memberId}:
//                            logout's server half with the token the webview
//                            no longer holds.
//
// The token itself reaches the shell only at sign-in
// (`keychain_store_refresh_token`, with the server origin it belongs to) and
// is presented only to that origin: a script in the webview can ask for a
// rotation, but cannot send a token the shell already holds somewhere else.
// (A script that knows a raw token — e.g. the sign-in's first one while it is
// still in webview memory — can store it with an origin of its choosing and
// have it presented and proved there; that needs code execution in the
// webview, ADR-0146 D-10's scope.) Redirects are not followed.
//
// Serialised: one `gate` for every read-modify-write of the stored token
// (attempt, store, clear, revoke, handle), so two windows can never present
// the same token twice from here, and a clear always stashes the token a
// finished rotation wrote.

mod proof;
#[cfg(target_os = "macos")]
mod refresh_key;
#[cfg(test)]
mod tests;

pub use proof::{DeviceProof, ProofFields};

use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager as _;
use uuid::Uuid;

/// One refresh POST's deadline, body included. The same bound as the core's
/// `REQUEST_TIMEOUT_MS`; `rotation_hold::CLOSE_WAIT_CAP` must cover it.
pub const REFRESH_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// What `getRefreshToken()` answers in the webview while the shell holds it.
pub const HANDLE_PREFIX: &str = "shell:";

/// `shell:` + the first 32 hex of the token's SHA-256. Enough to tell two
/// tokens apart across windows; useless to present.
pub fn handle_of(raw_refresh_token: &str) -> String {
    let digest = hex::encode(Sha256::digest(raw_refresh_token.as_bytes()));
    format!("{HANDLE_PREFIX}{}", &digest[..32])
}

/// `scheme://host[:port]` of an absolute http(s) base, or `None`.
pub fn origin_of(api_base: &str) -> Option<String> {
    let url = url::Url::parse(api_base.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

/// `{apiBase}{path}`, refusing a base that carries a query or fragment.
fn endpoint(api_base: &str, path: &str) -> Result<String, String> {
    let url = url::Url::parse(api_base.trim()).map_err(|_| "session_bad_api_base".to_string())?;
    if url.query().is_some() || url.fragment().is_some() {
        return Err("session_bad_api_base".into());
    }
    Ok(format!("{}{path}", url.as_str().trim_end_matches('/')))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- seams ------------------------------------------------------------------

/// A server answer, body read in full.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpAnswer {
    pub status: u16,
    /// The `Date` header, for `refresh_proof_stale`.
    pub date: Option<String>,
    pub body: String,
}

/// One JSON POST. `Err` = nothing answered (connect failure, deadline).
pub trait Transport: Send + Sync + 'static {
    fn post_json(
        &self,
        url: String,
        body: String,
        bearer: Option<String>,
    ) -> impl Future<Output = Result<HttpAnswer, String>> + Send;
}

/// Where the token lives. The shipped one is the OS credential store
/// (`keychain::KeyringStore`).
pub trait TokenStore: Send + Sync + 'static {
    fn load(&self) -> Result<Option<String>, String>;
    fn store(&self, token: &str) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
    fn origin(&self) -> Result<Option<String>, String>;
    fn set_origin(&self, origin: Option<&str>) -> Result<(), String>;
}

/// This device's refresh key. `Ok(None)`: no key can exist here (unsigned
/// build, no enclave, not macOS) — the refresh goes without a proof, which a
/// server in `observe` answers as before. There is deliberately no method that
/// signs caller-supplied bytes: the only thing it signs is the proof
/// `refresh_proof_bytes` builds from typed fields.
pub trait RefreshSigner: Send + Sync + 'static {
    fn prove(&self, fields: &ProofFields<'_>) -> Result<Option<DeviceProof>, String>;
}

/// The platform's refresh key.
pub fn platform_signer() -> impl RefreshSigner {
    #[cfg(target_os = "macos")]
    {
        refresh_key::EnclaveRefreshKey
    }
    #[cfg(not(target_os = "macos"))]
    {
        NoRefreshKey
    }
}

/// Windows/Linux: no enclave, no proof.
#[allow(dead_code)]
pub struct NoRefreshKey;

impl RefreshSigner for NoRefreshKey {
    fn prove(&self, _: &ProofFields<'_>) -> Result<Option<DeviceProof>, String> {
        Ok(None)
    }
}

pub struct ReqwestTransport(reqwest::Client);

impl ReqwestTransport {
    fn new() -> Result<Self, String> {
        // reqwest here has no provider of its own (`rustls-no-provider`,
        // chosen by tauri-plugin-updater); install ring's like the updater
        // does. A provider someone else installed first is kept.
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        reqwest::Client::builder()
            .timeout(REFRESH_REQUEST_TIMEOUT)
            // A redirect would carry the token to wherever it points.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map(Self)
            .map_err(|error| format!("session_transport: {error}"))
    }
}

impl Transport for ReqwestTransport {
    fn post_json(
        &self,
        url: String,
        body: String,
        bearer: Option<String>,
    ) -> impl Future<Output = Result<HttpAnswer, String>> + Send {
        let request = self
            .0
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body);
        let request = match bearer {
            Some(token) => request.bearer_auth(token),
            None => request,
        };
        async move {
            let response = request
                .send()
                .await
                .map_err(|error| format!("session_unreachable: {}", redact(&error)))?;
            let status = response.status().as_u16();
            let date = response
                .headers()
                .get(reqwest::header::DATE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            let body = response
                .text()
                .await
                .map_err(|error| format!("session_unreachable: {}", redact(&error)))?;
            Ok(HttpAnswer { status, date, body })
        }
    }
}

/// A reqwest error without its URL (never a secret today, but the base is
/// the person's server and does not belong in a log line).
fn redact(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "timeout".into()
    } else if error.is_connect() {
        "connect".into()
    } else {
        "request".into()
    }
}

// ---- state ------------------------------------------------------------------

/// Managed state: the gate, and the token a clear stashed for `session_revoke`.
#[derive(Default)]
pub struct SessionShell {
    gate: tauri::async_runtime::Mutex<()>,
    pending_revoke: Mutex<Option<String>>,
    transport: OnceLock<ReqwestTransport>,
}

impl SessionShell {
    pub fn gate(&self) -> &tauri::async_runtime::Mutex<()> {
        &self.gate
    }

    pub fn stash_for_revoke(&self, token: String) {
        *self.pending() = Some(token);
    }

    pub fn forget_pending_revoke(&self) {
        *self.pending() = None;
    }

    fn take_pending(&self) -> Option<String> {
        self.pending().take()
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        self.pending_revoke
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn transport(&self) -> Result<&ReqwestTransport, String> {
        if let Some(transport) = self.transport.get() {
            return Ok(transport);
        }
        let built = ReqwestTransport::new()?;
        Ok(self.transport.get_or_init(|| built))
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("session_task: {error}"))?
}

// ---- one attempt ------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptRequest {
    pub api_base: String,
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    /// Server time minus local time, from a `refresh_proof_stale` answer's
    /// `Date` (the core computes it).
    #[serde(default)]
    pub skew_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptAnswer {
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    /// A handle (`handle_of`), never the token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// A proof went with the request.
    pub proved: bool,
}

/// POST `/v1/auth/refresh` with `token` and, when this device has a refresh
/// key, its proof. Returns the answer and whether a proof went.
async fn post_refresh<T: Transport, K: RefreshSigner>(
    transport: &T,
    signer: Arc<K>,
    api_base: &str,
    token: &str,
    workspace_id: Uuid,
    member_id: Uuid,
    signed_at_ms: i64,
) -> Result<(HttpAnswer, bool), String> {
    let url = endpoint(api_base, "/v1/auth/refresh")?;
    let proof = {
        let token = token.to_owned();
        blocking(move || {
            let fields = ProofFields {
                workspace_id,
                member_id,
                refresh_token: &token,
                nonce: Uuid::new_v4(),
                signed_at_ms,
            };
            signer.prove(&fields)
        })
        .await
    };
    let proof = match proof {
        Ok(proof) => proof,
        Err(error) => {
            // The refresh still goes: a server in `observe` rotates it as
            // before, one in `require` answers `refresh_proof_required`.
            eprintln!("[oort] refresh key could not sign: {error}");
            None
        }
    };
    let mut body = json!({ "refreshToken": token });
    if let Some(proof) = &proof {
        body["deviceProof"] = serde_json::to_value(proof).map_err(|e| e.to_string())?;
    }
    let answer = transport.post_json(url, body.to_string(), None).await?;
    Ok((answer, proof.is_some()))
}

fn error_code(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get("error")?
        .get("code")?
        .as_str()
        .filter(|code| !code.is_empty())
        .map(str::to_owned)
}

/// The origin check shared by `attempt` and `revoke`: a pinned origin must
/// match; an unpinned token (a legacy record) takes this one.
fn check_origin<S: TokenStore>(store: &S, api_base: &str) -> Result<(), String> {
    let origin = origin_of(api_base).ok_or("session_bad_api_base")?;
    match store.origin()? {
        Some(pinned) if pinned == origin => Ok(()),
        Some(_) => Err("session_origin_mismatch".into()),
        None => store.set_origin(Some(&origin)),
    }
}

/// One rotation attempt. Holds nothing across calls: the stored token is
/// read here, presented, and replaced only by a 200's successor — so an
/// attempt cut off anywhere (no answer, Cmd+Q, a store that failed) leaves the
/// presented token stored, and the next attempt presents it with a fresh
/// proof (the server's recovery, #3079).
pub async fn attempt<T: Transport, S: TokenStore, K: RefreshSigner>(
    transport: &T,
    store: Arc<S>,
    signer: Arc<K>,
    request: &AttemptRequest,
    now_ms: i64,
) -> Result<AttemptAnswer, String> {
    let token = {
        let store = store.clone();
        let base = request.api_base.clone();
        blocking(move || {
            let token = store.load()?;
            if token.is_some() {
                check_origin(&*store, &base)?;
            }
            Ok(token)
        })
        .await?
    };
    let Some(token) = token else {
        return Ok(AttemptAnswer {
            status: 401,
            code: Some("session_absent".into()),
            ..AttemptAnswer::default()
        });
    };
    // The skew is the server's own clock (its `Date`), not clamped: a Mac
    // whose clock is days off must still sign in the server's ±5 min window,
    // and the proof never leaves the shell except to the pinned origin.
    let signed_at_ms = now_ms.saturating_add(request.skew_ms);
    // A time no proof can carry would send the refresh WITHOUT one (the
    // signer refuses it) — under `require` that ends the lineage. Refuse
    // here instead: nothing is sent, the token stays.
    if signed_at_ms <= 0 || signed_at_ms > (1 << 53) - 1 {
        return Err("session_bad_skew".into());
    }
    let (answer, proved) = post_refresh(
        transport,
        signer,
        &request.api_base,
        &token,
        request.workspace_id,
        request.member_id,
        signed_at_ms,
    )
    .await?;
    if answer.status != 200 {
        return Ok(AttemptAnswer {
            status: answer.status,
            code: error_code(&answer.body),
            date: answer.date,
            proved,
            ..AttemptAnswer::default()
        });
    }
    // The server has spent `token`. If what follows fails, `token` stays
    // stored and the next attempt recovers with a proof.
    let pair: Value =
        serde_json::from_str(&answer.body).map_err(|_| "session_bad_response".to_string())?;
    let field = |name: &str| {
        pair.get(name)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| "session_bad_response".to_string())
    };
    let access = field("accessToken")?;
    let refresh = field("refreshToken")?;
    let handle = handle_of(&refresh);
    blocking(move || store.store(&refresh))
        .await
        .map_err(|_| "session_store_failed".to_string())?;
    Ok(AttemptAnswer {
        status: 200,
        access_token: Some(access),
        refresh_token: Some(handle),
        proved,
        ..AttemptAnswer::default()
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevokeRequest {
    pub api_base: String,
    pub access_token: String,
    pub workspace_id: Uuid,
    pub member_id: Uuid,
}

/// Logout's server half: `/v1/auth/logout` with the leaving access token and
/// the refresh token (the one a clear stashed, else the stored one). When the
/// access token has expired (401), the refresh half is rotated once with a
/// proof and the minted pair revoked — otherwise the lineage would stay
/// rotatable for 30 days. Best effort, like the core's: it never fails the
/// logout. Returns whether the server confirmed.
pub async fn revoke<T: Transport, S: TokenStore, K: RefreshSigner>(
    transport: &T,
    store: Arc<S>,
    signer: Arc<K>,
    pending: Option<String>,
    request: &RevokeRequest,
    now_ms: i64,
) -> Result<bool, String> {
    let token = {
        let store = store.clone();
        let base = request.api_base.clone();
        blocking(move || {
            // The stored token first: a clear still queued behind this call
            // has not stashed it yet.
            let token = store.load().ok().flatten().or(pending);
            // Checked before the wipe, which forgets the pin; the wipe
            // happens either way — a refused revocation never leaves the
            // token on the device.
            let origin = match token {
                Some(_) => check_origin(&*store, &base),
                None => Ok(()),
            };
            let wiped = store.clear().and_then(|()| store.set_origin(None));
            origin?;
            wiped?;
            Ok(token)
        })
        .await?
    };
    let url = endpoint(&request.api_base, "/v1/auth/logout")?;
    let body = |refresh: Option<&str>| match refresh {
        Some(refresh) => json!({ "refreshToken": refresh }).to_string(),
        None => "{}".to_string(),
    };
    let first = transport
        .post_json(
            url.clone(),
            body(token.as_deref()),
            Some(request.access_token.clone()),
        )
        .await?;
    if first.status != 401 {
        return Ok((200..300).contains(&first.status));
    }
    let Some(token) = token else {
        return Ok(false);
    };
    // Access expired while the refresh half lives: rotate it once (a replayed
    // nonce or a lost race gets one more try) and revoke what it minted.
    for _ in 0..2 {
        let (answer, _) = post_refresh(
            transport,
            signer.clone(),
            &request.api_base,
            &token,
            request.workspace_id,
            request.member_id,
            now_ms,
        )
        .await?;
        if answer.status == 200 {
            let pair: Value = serde_json::from_str(&answer.body).unwrap_or(Value::Null);
            let (Some(access), Some(refresh)) = (
                pair.get("accessToken").and_then(Value::as_str),
                pair.get("refreshToken").and_then(Value::as_str),
            ) else {
                return Ok(false);
            };
            let done = transport
                .post_json(url, body(Some(refresh)), Some(access.to_owned()))
                .await?;
            return Ok((200..300).contains(&done.status));
        }
        // Only a replayed nonce or a plain 401 (a racing recovery) is worth
        // one more try; stale, required and invalid will not change.
        let code = error_code(&answer.body);
        if answer.status != 401 || !matches!(code.as_deref(), None | Some("refresh_proof_replayed"))
        {
            return Ok(false);
        }
    }
    Ok(false)
}

// ---- commands ---------------------------------------------------------------

/// One refresh attempt, made by the shell (#3106). See the module header.
#[tauri::command]
pub async fn session_refresh_attempt(
    app: tauri::AppHandle,
    request: AttemptRequest,
) -> Result<AttemptAnswer, String> {
    let shell = app.state::<SessionShell>();
    let _one = shell.gate().lock().await;
    // A window close waits for this POST and its keychain write (#3098). The
    // shell's own count: a page reload cannot release it.
    let hold = app.state::<crate::rotation_hold::RotationHold>();
    let _held = hold.shell_rotation();
    let transport = shell.transport()?;
    attempt(
        transport,
        Arc::new(crate::keychain::KeyringStore),
        Arc::new(platform_signer()),
        &request,
        now_ms(),
    )
    .await
}

/// Logout's server half with the token only the shell holds (#3106).
#[tauri::command]
pub async fn session_revoke(app: tauri::AppHandle, request: RevokeRequest) -> Result<bool, String> {
    let shell = app.state::<SessionShell>();
    let _one = shell.gate().lock().await;
    let pending = shell.take_pending();
    let transport = shell.transport()?;
    revoke(
        transport,
        Arc::new(crate::keychain::KeyringStore),
        Arc::new(platform_signer()),
        pending,
        &request,
        now_ms(),
    )
    .await
}
