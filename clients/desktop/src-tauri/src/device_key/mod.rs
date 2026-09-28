// This Mac's human device key — ADR-0146 개정 2026-09-28 R2-E5 (#3025).
//
// The desktop app is the **root of trust** (D-6): its Secure Enclave P-256 key
// (D-1, D-3) signs the person's instructions (`momo.human.control.v1`),
// approves a phone as an instruction device (`device_endorse.v1`) and revokes
// one (`device_revoke.v1`). The webview never touches the key and never hands
// over bytes to sign; it calls these commands with typed fields, and the
// shell builds the statement, shows it in a native dialog, and only then asks
// the enclave:
//
//   device_key_status          support (ready/absent/unsupported/unsigned_build/
//                              entitlement_missing), public key + fingerprint,
//                              this workspace's root binding, the host's pin
//   device_key_create          make the enclave key (no fallback key, ever)
//   device_key_bind_root       after the server registered the key (password
//                              re-entered in the web UI): remember key id ↔
//                              workspace, then `pin_root` on this Mac's workd
//   device_key_sign_control    momo.human.control.v1 (all five kinds; the Mac
//                              is the root)
//   device_key_sign_endorse    device_endorse.v1 for a phone key
//   device_key_sign_revoke     device_revoke.v1, delivered to workd over the
//                              code-signed socket right away (D-7)
//   device_key_deliver_revocation  hand a stored letter to workd again
//
// Only `capabilities/device-key.json` grants them: the main webview, bundled
// origin, macOS.
//
// Every enclave call runs on one worker thread, one at a time, which also owns
// the reuse window's `LAContext` (not `Send`). Confirmation dialogs run on the
// main thread and the worker waits for them.

mod confirm;
mod enclave;
pub mod payload;

use std::collections::BTreeMap;
use std::io::Write as _;
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;
use uuid::Uuid;

use enclave::{AuthWindow, EnclaveError};
use payload::{
    ControlRequest, EndorseRequest, RevokeRequest, Signer, Statement, Summary, P256_PUBLIC_KEY_LEN,
};

/// Shown by Touch ID / the password sheet when a fresh authentication is due.
const AUTH_REASON: &str = "지시에 서명";

// ---- the testable core ------------------------------------------------------

/// What the flow needs from the platform: a confirmation and an enclave
/// signature. The real one is AppKit + the Secure Enclave; the tests use a
/// software key and a scripted answer.
pub trait Platform {
    fn confirm(&mut self, summary: &Summary) -> bool;
    /// The enclave key's public half and a DER signature over `message`.
    fn sign(
        &mut self,
        message: &[u8],
    ) -> Result<([u8; P256_PUBLIC_KEY_LEN], Vec<u8>), EnclaveError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signed {
    /// base64 raw r‖s, low-s.
    pub signature: String,
    pub public_key: String,
    pub payload_sha256: String,
}

/// Build → confirm → sign → check. `root_public_key` is the key this
/// workspace's root binding recorded; the enclave must still hold it.
pub fn sign_statement(
    platform: &mut impl Platform,
    statement: &Statement,
    root_public_key: &str,
    now_ms: i64,
    local_host: Option<Uuid>,
) -> Result<Signed, String> {
    let bytes = statement
        .signed_bytes(now_ms)
        .map_err(|error| format!("device_key_payload_rejected: {}", error.code()))?;
    if !platform.confirm(&statement.summary(local_host)) {
        return Err("device_key_declined".into());
    }
    let (public_key, der) = platform.sign(&bytes).map_err(|error| error.code())?;
    let public_b64 = BASE64.encode(public_key);
    if public_b64 != root_public_key {
        return Err("device_key_changed".into());
    }
    let raw = payload::der_to_raw_low_s(&der)
        .ok_or_else(|| "device_key_failed: signature encoding".to_string())?;
    if !payload::verify_raw(&public_key, &bytes, &raw) {
        return Err("device_key_failed: signature does not verify".into());
    }
    Ok(Signed {
        signature: BASE64.encode(raw),
        public_key: public_b64,
        payload_sha256: hex::encode(Sha256::digest(&bytes)),
    })
}

// ---- root bindings on disk --------------------------------------------------

/// This Mac's key as each workspace's server knows it (`member_device_key`
/// row id), written when the person bound it after registering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootBinding {
    pub key_id: Uuid,
    pub member_id: Uuid,
    pub public_key: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bindings {
    #[serde(default)]
    pub roots: BTreeMap<Uuid, RootBinding>,
}

fn bindings_path(app_data: &Path) -> PathBuf {
    app_data.join("device-key").join("roots.json")
}

pub fn load_bindings(path: &Path) -> Bindings {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// 0600 in a 0700 folder, written through a sibling + rename.
pub fn save_bindings(path: &Path, bindings: &Bindings) -> Result<(), String> {
    let folder = path.parent().ok_or("device_key_failed: no folder")?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(folder)
        .map_err(|error| format!("device_key_failed: {error}"))?;
    std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("device_key_failed: {error}"))?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&temporary);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| format!("device_key_failed: {error}"))?;
    let body = serde_json::to_vec_pretty(bindings).expect("bindings serialize");
    file.write_all(&body)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("device_key_failed: {error}"))?;
    std::fs::rename(&temporary, path).map_err(|error| format!("device_key_failed: {error}"))
}

// ---- the worker -------------------------------------------------------------

type Job = Box<dyn FnOnce(&mut Worker) + Send>;

/// Lives on the worker thread only.
pub struct Worker {
    app: tauri::AppHandle,
    auth: AuthWindow,
}

#[derive(Default)]
pub struct DeviceKeyState {
    jobs: Mutex<Option<mpsc::Sender<Job>>>,
    /// One binding write at a time.
    bindings: Mutex<()>,
}

impl DeviceKeyState {
    fn submit(&self, app: &tauri::AppHandle, job: Job) -> Result<(), String> {
        let mut guard = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
        if guard.is_none() {
            let (tx, rx) = mpsc::channel::<Job>();
            let app = app.clone();
            std::thread::Builder::new()
                .name("oort-device-key".into())
                .spawn(move || {
                    let mut worker = Worker {
                        app,
                        auth: AuthWindow::new(enclave::clamp_window(
                            enclave::REUSE_WINDOW_DEFAULT_SECS,
                        )),
                    };
                    for job in rx {
                        job(&mut worker);
                    }
                })
                .map_err(|error| format!("device_key_failed: {error}"))?;
            *guard = Some(tx);
        }
        guard
            .as_ref()
            .expect("worker started")
            .send(job)
            .map_err(|_| "device_key_failed: worker stopped".to_string())
    }
}

/// Run `work` on the worker and wait for it (off the IPC thread).
async fn on_worker<T: Send + 'static>(
    app: tauri::AppHandle,
    work: impl FnOnce(&mut Worker) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = mpsc::channel();
        let state = app.state::<DeviceKeyState>();
        state.submit(
            &app,
            Box::new(move |worker| {
                let _ = tx.send(work(worker));
            }),
        )?;
        rx.recv()
            .map_err(|_| "device_key_failed: worker stopped".to_string())?
    })
    .await
    .map_err(|error| format!("device_key_failed: {error}"))?
}

struct EnclavePlatform<'a> {
    worker: &'a mut Worker,
    group: String,
}

impl Platform for EnclavePlatform<'_> {
    fn confirm(&mut self, summary: &Summary) -> bool {
        confirm::ask(&self.worker.app, summary.clone())
    }

    fn sign(
        &mut self,
        message: &[u8],
    ) -> Result<([u8; P256_PUBLIC_KEY_LEN], Vec<u8>), EnclaveError> {
        let context = self.worker.auth.context(AUTH_REASON)?;
        let result = (|| {
            let key = enclave::find(&self.group, Some(&context))?.ok_or(EnclaveError::Absent)?;
            let public = enclave::public_key(&key)?;
            let der = enclave::sign_der(&key, message)?;
            Ok((public, der))
        })();
        match &result {
            Ok(_) => self.worker.auth.authenticated(context),
            Err(_) => self.worker.auth.forget(),
        }
        result
    }
}

impl Worker {
    fn app_data(&self) -> Result<PathBuf, String> {
        self.app
            .path()
            .app_data_dir()
            .map_err(|error| format!("device_key_failed: app data folder: {error}"))
    }

    /// The enclave key's public half, or the named reason there is none.
    fn current_public_key(&self) -> Result<(String, String), EnclaveError> {
        let group = enclave::access_group()?;
        let key = enclave::find(&group, None)?.ok_or(EnclaveError::Absent)?;
        Ok((group, BASE64.encode(enclave::public_key(&key)?)))
    }

    fn signer_for(&self, workspace_id: Uuid) -> Result<(Signer, RootBinding), String> {
        let bindings = load_bindings(&bindings_path(&self.app_data()?));
        let binding = bindings
            .roots
            .get(&workspace_id)
            .cloned()
            .ok_or("device_key_not_root_here")?;
        Ok((
            Signer {
                workspace_id,
                member_id: binding.member_id,
                key_id: binding.key_id,
            },
            binding,
        ))
    }

    fn local_host(&self) -> Option<Uuid> {
        let state = self.app.state::<crate::work_host::WorkHostState>();
        let service = crate::work_host::service(&self.app, &state).ok()?;
        service
            .registered()
            .and_then(|r| Uuid::parse_str(&r.host_id).ok())
    }

    fn sign(&mut self, statement: Statement, root_public_key: &str) -> Result<Signed, String> {
        let group = enclave::access_group().map_err(|error| error.code())?;
        let local_host = self.local_host();
        let now = now_ms();
        let mut platform = EnclavePlatform {
            worker: self,
            group,
        };
        sign_statement(&mut platform, &statement, root_public_key, now, local_host)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- workd delivery -----------------------------------------------------------

/// What happened on the local socket. The server path is the webview's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum HostDelivery {
    /// workd took it (`pin_root`: pinned now or already the same key).
    Delivered,
    /// This Mac is not running a host right now; the server path still
    /// carries a revocation (pendingControls.deviceRevocations).
    NotRunning,
    /// The host here belongs to another workspace or owner.
    OtherHost,
    /// workd refused, with its reason.
    Refused { reason: String },
}

fn host_delivery(
    app: &tauri::AppHandle,
    workspace_id: Uuid,
    member_id: Uuid,
    act: impl FnOnce(&crate::work_host::Service<'_>) -> Result<(), crate::work_host::WorkdError>,
) -> HostDelivery {
    let state = app.state::<crate::work_host::WorkHostState>();
    let Ok(service) = crate::work_host::service(app, &state) else {
        return HostDelivery::NotRunning;
    };
    let trust = match service.host_trust() {
        Ok(Some(trust)) => trust,
        Ok(None) => return HostDelivery::NotRunning,
        Err(error) => {
            return HostDelivery::Refused {
                reason: error.code(),
            }
        }
    };
    if trust.workspace_id != workspace_id.to_string()
        || trust.owner_member_id != member_id.to_string()
    {
        return HostDelivery::OtherHost;
    }
    match act(&service) {
        Ok(()) => HostDelivery::Delivered,
        Err(error) => HostDelivery::Refused {
            reason: error.code(),
        },
    }
}

fn pin_binding(app: &tauri::AppHandle, workspace_id: Uuid, binding: &RootBinding) -> HostDelivery {
    host_delivery(app, workspace_id, binding.member_id, |service| {
        service
            .pin_root(&binding.key_id.to_string(), &binding.public_key)
            .map(|_| ())
    })
}

/// After a host starts: pin this workspace's root if workd has none yet
/// (host registered after the key, or a local `reset-root`). Idempotent, and
/// only for a binding whose key the enclave still holds.
pub fn pin_after_start(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // workd binds its socket shortly after start.
        let state = app.state::<crate::work_host::WorkHostState>();
        let mut trust = None;
        for _ in 0..25 {
            if let Ok(service) = crate::work_host::service(&app, &state) {
                if let Ok(Some(found)) = service.host_trust() {
                    trust = Some(found);
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        let Some(trust) = trust else { return };
        if trust.root_key_id.is_some() {
            return;
        }
        let Ok(workspace_id) = Uuid::parse_str(&trust.workspace_id) else {
            return;
        };
        let _ = tauri::async_runtime::block_on(on_worker(app.clone(), move |worker| {
            let bindings = load_bindings(&bindings_path(&worker.app_data()?));
            let Some(binding) = bindings.roots.get(&workspace_id).cloned() else {
                return Ok(());
            };
            let (_, current) = worker.current_public_key().map_err(|e| e.code())?;
            if current != binding.public_key {
                return Ok(());
            }
            let _ = pin_binding(&worker.app, workspace_id, &binding);
            Ok(())
        }));
    });
}

// ---- commands -----------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostPin {
    pub running: bool,
    /// The running host is this workspace's and this member's.
    pub matches: bool,
    pub pinned_root_key_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceKeyStatus {
    /// `ready` · `absent` · `unsupported` · `unsigned_build` ·
    /// `entitlement_missing` · `error`.
    pub support: &'static str,
    pub detail: Option<String>,
    pub public_key: Option<String>,
    pub fingerprint: Option<String>,
    /// This workspace's binding, when `workspaceId` was given.
    pub root: Option<RootBinding>,
    pub reuse_window_seconds: u64,
    pub host: Option<HostPin>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatusRequest {
    #[serde(default)]
    pub workspace_id: Option<Uuid>,
}

fn status_of(worker: &Worker, workspace_id: Option<Uuid>) -> DeviceKeyStatus {
    let reuse = worker.auth.window().as_secs();
    let (support, detail, public_key) = match worker.current_public_key() {
        Ok((_, key)) => ("ready", None, Some(key)),
        Err(error) => (error.support(), Some(error.code()), None),
    };
    let root = match (workspace_id, worker.app_data()) {
        (Some(ws), Ok(data)) => load_bindings(&bindings_path(&data))
            .roots
            .get(&ws)
            .cloned()
            // A binding whose key the enclave no longer holds is not a root.
            .filter(|binding| public_key.as_deref() == Some(binding.public_key.as_str())),
        _ => None,
    };
    let host = {
        let state = worker.app.state::<crate::work_host::WorkHostState>();
        crate::work_host::service(&worker.app, &state)
            .ok()
            .map(|service| match service.host_trust() {
                Ok(Some(trust)) => HostPin {
                    running: true,
                    matches: workspace_id.map(|w| w.to_string()) == Some(trust.workspace_id)
                        && root.as_ref().map(|r| r.member_id.to_string())
                            == Some(trust.owner_member_id),
                    pinned_root_key_id: trust.root_key_id,
                },
                _ => HostPin {
                    running: false,
                    matches: false,
                    pinned_root_key_id: None,
                },
            })
    };
    DeviceKeyStatus {
        support,
        detail,
        fingerprint: public_key.as_deref().and_then(payload::fingerprint),
        public_key,
        root,
        reuse_window_seconds: reuse,
        host,
    }
}

#[tauri::command]
pub async fn device_key_status(
    app: tauri::AppHandle,
    request: Option<StatusRequest>,
) -> Result<DeviceKeyStatus, String> {
    let workspace_id = request.and_then(|r| r.workspace_id);
    on_worker(app, move |worker| Ok(status_of(worker, workspace_id))).await
}

/// Make the enclave key. An existing key is returned as is (idempotent); a
/// build that cannot hold one gets its named reason and no key.
#[tauri::command]
pub async fn device_key_create(app: tauri::AppHandle) -> Result<DeviceKeyStatus, String> {
    on_worker(app, move |worker| {
        match worker.current_public_key() {
            Ok(_) => {}
            Err(EnclaveError::Absent) => {
                let group = enclave::access_group().map_err(|e| e.code())?;
                enclave::create(&group).map_err(|e| e.code())?;
            }
            Err(error) => return Err(error.code()),
        }
        Ok(status_of(worker, None))
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindRequest {
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    /// The server's `member_device_key` id for this Mac's key.
    pub key_id: Uuid,
    /// The public key the server registered; must be this enclave's.
    pub public_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindResult {
    pub status: DeviceKeyStatus,
    pub host: HostDelivery,
}

/// Remember the server's key id for this workspace and pin it on this Mac's
/// workd. Confirmed natively: a pin is permanent until a local reset, so a
/// script must not be able to pin a key id of its choosing.
#[tauri::command]
pub async fn device_key_bind_root(
    app: tauri::AppHandle,
    request: BindRequest,
) -> Result<BindResult, String> {
    on_worker(app, move |worker| {
        let (_, current) = worker.current_public_key().map_err(|e| e.code())?;
        if current != request.public_key {
            return Err("device_key_changed".into());
        }
        let summary = Summary {
            title: "이 맥을 지시 서명의 뿌리로 쓸까요?".into(),
            body: format!(
                "지문: {}\n이 맥의 작업 호스트가 이 키를 뿌리로 고정해요. 고정은 이 맥에서만 되돌릴 수 있어요.",
                payload::fingerprint(&current).unwrap_or_default()
            ),
            confirm: "뿌리로 쓰기".into(),
        };
        if !confirm::ask(&worker.app, summary) {
            return Err("device_key_declined".into());
        }
        let binding = RootBinding {
            key_id: request.key_id,
            member_id: request.member_id,
            public_key: current,
        };
        {
            let state = worker.app.state::<DeviceKeyState>();
            let _one = state.bindings.lock().unwrap_or_else(|p| p.into_inner());
            let path = bindings_path(&worker.app_data()?);
            let mut bindings = load_bindings(&path);
            bindings.roots.insert(request.workspace_id, binding.clone());
            save_bindings(&path, &bindings)?;
        }
        let host = pin_binding(&worker.app, request.workspace_id, &binding);
        Ok(BindResult {
            status: status_of(worker, Some(request.workspace_id)),
            host,
        })
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlSigned {
    pub device_key_id: Uuid,
    pub device_public_key: String,
    pub signature: String,
    pub payload_sha256: String,
}

#[tauri::command]
pub async fn device_key_sign_control(
    app: tauri::AppHandle,
    request: ControlRequest,
) -> Result<ControlSigned, String> {
    on_worker(app, move |worker| {
        let (signer, binding) = worker.signer_for(request.workspace_id)?;
        let signed = worker.sign(Statement::Control { signer, request }, &binding.public_key)?;
        Ok(ControlSigned {
            device_key_id: signer.key_id,
            device_public_key: signed.public_key,
            signature: signed.signature,
            payload_sha256: signed.payload_sha256,
        })
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndorseSigned {
    pub target_key_id: Uuid,
    pub root_key_id: Uuid,
    pub signature: String,
}

#[tauri::command]
pub async fn device_key_sign_endorse(
    app: tauri::AppHandle,
    request: EndorseRequest,
) -> Result<EndorseSigned, String> {
    on_worker(app, move |worker| {
        let (signer, binding) = worker.signer_for(request.workspace_id)?;
        let target_key_id = request.target_key_id;
        let signed = worker.sign(Statement::Endorse { signer, request }, &binding.public_key)?;
        Ok(EndorseSigned {
            target_key_id,
            root_key_id: signer.key_id,
            signature: signed.signature,
        })
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeSigned {
    pub root_key_id: Uuid,
    pub target_key_id: Uuid,
    pub revoked_at_ms: i64,
    pub signature: String,
    /// The same letter on the local socket (D-7) — independent of the server.
    pub host: HostDelivery,
}

/// The letter as workd reads it (E4 `human_trust::Revocation`).
pub fn revocation_json(
    signer: &Signer,
    target_key_id: Uuid,
    revoked_at_ms: i64,
    signature: &str,
    target_public_key: &str,
) -> Value {
    json!({
        "workspaceId": signer.workspace_id,
        "memberId": signer.member_id,
        "rootKeyId": signer.key_id,
        "targetKeyId": target_key_id,
        "revokedAtMs": revoked_at_ms,
        "signature": signature,
        "targetPublicKey": target_public_key,
    })
}

#[tauri::command]
pub async fn device_key_sign_revoke(
    app: tauri::AppHandle,
    request: RevokeRequest,
) -> Result<RevokeSigned, String> {
    on_worker(app, move |worker| {
        let (signer, binding) = worker.signer_for(request.workspace_id)?;
        let revoked_at_ms = now_ms();
        let target_key_id = request.target_key_id;
        let target_public_key = request.target_public_key.clone();
        let signed = worker.sign(
            Statement::Revoke {
                signer,
                request,
                revoked_at_ms,
            },
            &binding.public_key,
        )?;
        let letter = revocation_json(
            &signer,
            target_key_id,
            revoked_at_ms,
            &signed.signature,
            &target_public_key,
        );
        let host = host_delivery(&worker.app, signer.workspace_id, signer.member_id, |s| {
            s.revoke_device(&letter)
        });
        Ok(RevokeSigned {
            root_key_id: signer.key_id,
            target_key_id,
            revoked_at_ms,
            signature: signed.signature,
            host,
        })
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliverRequest {
    pub workspace_id: Uuid,
    pub target_key_id: Uuid,
    pub revoked_at_ms: i64,
    pub signature: String,
    pub target_public_key: String,
}

/// A letter that could not reach workd at signing time (not running), again.
/// workd verifies it against its own pinned root, so this carries no trust.
#[tauri::command]
pub async fn device_key_deliver_revocation(
    app: tauri::AppHandle,
    request: DeliverRequest,
) -> Result<HostDelivery, String> {
    on_worker(app, move |worker| {
        let (signer, _) = worker.signer_for(request.workspace_id)?;
        let letter = revocation_json(
            &signer,
            request.target_key_id,
            request.revoked_at_ms,
            &request.signature,
            &request.target_public_key,
        );
        Ok(host_delivery(
            &worker.app,
            signer.workspace_id,
            signer.member_id,
            |s| s.revoke_device(&letter),
        ))
    })
    .await
}

#[cfg(test)]
mod tests;
