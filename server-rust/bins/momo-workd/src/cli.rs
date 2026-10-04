//! `momo-workd register` and `momo-workd run`.
//!
//! ```text
//! MOMO_WORKD_REGISTER_TOKEN=<owner access token> \
//!   momo-workd register --config workd.json [--dev-key-file PATH] [--force]
//! momo-workd run      --config workd.json [--dev-key-file PATH]
//!                     [--control-socket PATH [--dev-unsigned-peer]]
//! momo-workd forget   --config workd.json [--dev-key-file PATH]
//! ```
//!
//! `register --sign-stdin` (the desktop app, #3120) asks the parent for the
//! owner's root device key to sign this registration (ADR-0146 개정 D-8):
//! after the host key exists it prints `{"momoWorkd":"host_register_request",
//! "hostPublicKey",…}` on stdout and reads one answer line from stdin
//! (`{"registration":{…}}`, `{"unsigned":true}` or `{"declined":"…"}`). The
//! pipes are the ones the app made for this child, so nothing else can answer.
//!
//! ```text
//! momo-workd reset-root --config workd.json
//! ```
//!
//! `reset-root` forgets the pinned R2 root key (ADR-0146 개정 D-6) so the
//! desktop app can pin a new one. It is local only: nothing the server sends
//! can pin, replace or clear the root. Run it while `momo-workd run` is
//! stopped: a running host keeps the root it loaded.
//!
//! `forget` is the local half of 「등록 해제」 (#2778): it deletes this host's
//! key and its registration state. The server half (revoking the row) is the
//! owner's `DELETE …/work-hosts/{host}`, which the desktop app sends first.
//!
//! Registration takes the **owner's** session token (ADR-0188 D2/D3). In this
//! slice it comes from the environment — never a command-line argument, which
//! any local process could read from the process table — and is used for one
//! request and dropped. The desktop app's registration GUI (#2778) hands it over
//! the same way: in the child's environment, never in its arguments.
//!
//! `--control-socket` is how the desktop app, which starts `run` as its child,
//! asks for status and a shutdown (see [`crate::control_socket`]). It is a
//! user-only Unix socket with a peer code-signature check; workd opens no TCP
//! socket with or without it.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::client::{self, ClientError, HostClient};
use crate::config::{ConfigError, HostState, WorkdConfig, SERVED_SCOPE};
#[cfg(target_os = "macos")]
use crate::control_socket::{ControlSocket, ControlSocketError, HostIdentity, PeerPolicy};
use crate::controls::HostHealth;
use crate::controls::SocketShared;
use crate::controls::{heartbeat_loop, ControlLoop};
use crate::human_trust::{HumanTrust, TrustIdentity};
use crate::keystore::{HostKey, KeyStore, KeyStoreError};
use crate::policy::{AdapterKind, CodexHome};
use crate::session::{SessionManager, SessionSettings};
use crate::signature_requirement::SignatureRequirement;

/// The environment variable `register` reads the owner's token from.
pub const REGISTER_TOKEN_ENV: &str = "MOMO_WORKD_REGISTER_TOKEN";

pub const USAGE: &str = "\
momo-workd — oort desktop work host (ADR-0188)

usage:
  momo-workd register --config PATH [--dev-key-file PATH] [--force] [--token-stdin]
                      [--sign-stdin]
      reads the owner's access token from MOMO_WORKD_REGISTER_TOKEN,
      or from one line on stdin with --token-stdin.
      --sign-stdin (the desktop app, #3120): after the host key exists, prints
      one JSON line asking its parent to have the owner's root device key sign
      this registration, and reads the answer as one stdin line
  momo-workd run --config PATH [--dev-key-file PATH]
                 [--control-socket PATH [--dev-unsigned-peer]]
  momo-workd forget --config PATH [--dev-key-file PATH]
      deletes the host key and the registration state (after a revoke)
  momo-workd reset-root --config PATH
      forgets the pinned device root key (a new one can then be pinned);
      run it while the host is stopped
  momo-workd --version

--dev-key-file keeps the host key in a 0600 file instead of the keychain.
It exists for development and tests only.
--control-socket answers the desktop app on a user-only Unix socket (macOS).
--dev-unsigned-peer skips the peer's code-signature check; an unsigned
development build only (a team-signed momo-workd refuses it).";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    Register {
        config: PathBuf,
        dev_key_file: Option<PathBuf>,
        force: bool,
        /// Read the owner's token from one stdin line instead of the
        /// environment (#2778 security review M3: another same-user process
        /// can read a child's environment while it runs; a pipe it cannot).
        token_stdin: bool,
        /// #3120: ask the parent process (the desktop app) for the root
        /// key's `host_register` signature over the child's stdio.
        sign_stdin: bool,
    },
    Run {
        config: PathBuf,
        dev_key_file: Option<PathBuf>,
        control_socket: Option<PathBuf>,
        dev_unsigned_peer: bool,
    },
    Forget {
        config: PathBuf,
        dev_key_file: Option<PathBuf>,
    },
    ResetRoot {
        config: PathBuf,
    },
    Help,
    Version,
}

pub fn parse_args(args: &[String]) -> Result<Invocation, String> {
    let Some(command) = args.first() else {
        return Ok(Invocation::Help);
    };
    match command.as_str() {
        "-h" | "--help" | "help" => return Ok(Invocation::Help),
        "-V" | "--version" => return Ok(Invocation::Version),
        "register" | "run" | "forget" | "reset-root" => {}
        other => return Err(format!("unknown command {other:?}")),
    }
    let mut config = None;
    let mut dev_key_file = None;
    let mut force = false;
    let mut token_stdin = false;
    let mut sign_stdin = false;
    let mut control_socket = None;
    let mut dev_unsigned_peer = false;
    let mut rest = args[1..].iter();
    while let Some(argument) = rest.next() {
        let mut value = |name: &str| {
            rest.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match argument.as_str() {
            "--config" => config = Some(PathBuf::from(value("--config")?)),
            "--dev-key-file" if command != "reset-root" => {
                dev_key_file = Some(PathBuf::from(value("--dev-key-file")?))
            }
            "--force" if command == "register" => force = true,
            "--token-stdin" if command == "register" => token_stdin = true,
            "--sign-stdin" if command == "register" => sign_stdin = true,
            "--control-socket" if command == "run" => {
                control_socket = Some(PathBuf::from(value("--control-socket")?))
            }
            "--dev-unsigned-peer" if command == "run" => dev_unsigned_peer = true,
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    let config = config.ok_or_else(|| "--config is required".to_string())?;
    if dev_unsigned_peer && control_socket.is_none() {
        return Err("--dev-unsigned-peer needs --control-socket".to_string());
    }
    if sign_stdin && !token_stdin {
        return Err("--sign-stdin needs --token-stdin (both share one stdin)".to_string());
    }
    Ok(if command == "register" {
        Invocation::Register {
            config,
            dev_key_file,
            force,
            token_stdin,
            sign_stdin,
        }
    } else if command == "reset-root" {
        Invocation::ResetRoot { config }
    } else if command == "forget" {
        Invocation::Forget {
            config,
            dev_key_file,
        }
    } else {
        Invocation::Run {
            config,
            dev_key_file,
            control_socket,
            dev_unsigned_peer,
        }
    })
}

#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    KeyStore(#[from] KeyStoreError),
    #[error("registration failed: {0}")]
    Register(ClientError),
    #[error("{0}")]
    Usage(String),
    #[error("registration not signed: {0}")]
    Signing(String),
    #[error("the server no longer accepts this host (revoked, or its owner left); stopped")]
    Revoked,
    #[cfg(target_os = "macos")]
    #[error(transparent)]
    ControlSocket(#[from] ControlSocketError),
}

impl CliError {
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Usage(_) | Self::Config(_) => 2,
            Self::Revoked => 3,
            #[cfg(target_os = "macos")]
            Self::ControlSocket(ControlSocketError::AlreadyRunning(_)) => 4,
            _ => 1,
        }
    }
}

/// ADR-0197 D8: a production box never keeps its key in a dev file. The box
/// image sets `OORT_BOX`; while it is set `--dev-key-file` is a usage error.
pub(crate) fn dev_key_file_allowed(get: &dyn Fn(&str) -> Option<String>) -> Result<(), CliError> {
    // A guard against mistakes (the same uid can unset a variable); the real
    // wall is the separate box-agent uid (ADR-0197 D1).
    let set = |name: &str| get(name).is_some_and(|v| !v.is_empty());
    if crate::keystore::box_store::in_box()
        || set(crate::keystore::box_store::ENV_BOX_MARKER)
        || set(crate::keystore::box_store::ENV_KEY_DIR)
    {
        return Err(CliError::Usage(
            "--dev-key-file is refused inside an oort box; the host key lives on the box volume"
                .into(),
        ));
    }
    Ok(())
}

/// The Linux box store (spike S4), selected by the box image's environment.
/// Compiled everywhere so it is type-checked on a Mac; only Linux uses it.
fn box_key_store(get: &dyn Fn(&str) -> Option<String>) -> Result<Option<KeyStore>, CliError> {
    if get(crate::keystore::box_store::ENV_KEY_DIR).is_none() {
        return Ok(None);
    }
    let mountinfo = std::fs::read_to_string("/proc/self/mountinfo").map_err(|error| {
        CliError::Usage(format!(
            "cannot read /proc/self/mountinfo to check the key mount: {error}"
        ))
    })?;
    let store = crate::keystore::box_store::BoxKeyStore::from_env(get, Some(&mountinfo))?;
    Ok(Some(KeyStore::Box(store)))
}

fn key_store(config: &WorkdConfig, dev_key_file: Option<PathBuf>) -> Result<KeyStore, CliError> {
    let env = |name: &str| std::env::var(name).ok();
    if cfg!(target_os = "linux") && dev_key_file.is_none() {
        if let Some(store) = box_key_store(&env)? {
            return Ok(store);
        }
    }
    match dev_key_file {
        Some(path) => {
            dev_key_file_allowed(&env)?;
            // ADR-0188 D2: a shipped (team-signed) host keeps its key in the
            // ThisDeviceOnly keychain, never in a file (#2778 security M1).
            #[cfg(target_os = "macos")]
            if crate::control_socket::own_team_identifier()
                .ok()
                .flatten()
                .is_some()
            {
                return Err(CliError::Usage(
                    "--dev-key-file is for unsigned development builds; this momo-workd is \
                     team-signed and keeps its key in the keychain"
                        .into(),
                ));
            }
            if !path.is_absolute() {
                return Err(CliError::Usage(
                    "--dev-key-file must be an absolute path".into(),
                ));
            }
            Ok(KeyStore::dev_file(path))
        }
        None => Ok(KeyStore::platform_default(
            config.workspace_id,
            config.keychain_access_group.clone(),
        )?),
    }
}

/// Keychain calls can block on a system prompt; keep them off the runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, KeyStoreError> + Send + 'static,
) -> Result<T, KeyStoreError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| KeyStoreError::Keychain(format!("key store task failed: {error}")))?
}

/// The registering app's answer to "sign this registration" (#3120).
#[derive(Debug, Clone, PartialEq)]
pub enum SigningAnswer {
    /// The `registration` object of the request body, signed by the owner's
    /// root device key (`dto::HostRegisterSignature`, camelCase).
    Signed(serde_json::Value),
    /// This Mac has no root key bound for the workspace: register unsigned
    /// and let the server decide (`MOMO_HOST_REGISTER_SIGNATURE_REQUIRED`).
    Unsigned,
}

/// What the parent needs to build the statement: the one thing only this
/// process knows (the host public key) and the server's own signing context.
#[derive(Debug, Clone, PartialEq)]
pub struct SigningAsk {
    pub host_public_key: String,
    pub context: Option<client::SigningContext>,
    /// Why there is, or is no, `context` (`available` · `unconfigured` ·
    /// `not_offered`): the parent is told, not left to infer from a null.
    pub context_state: &'static str,
}

/// Whoever holds the owner's root device key. The shipped implementation is
/// the desktop app over this process's stdio ([`StdioSigner`]); tests play the
/// owner's Secure Enclave.
#[async_trait::async_trait]
pub trait RegistrationSigner: Send {
    /// `Err` is a refusal (the person said no, the dialog could not show the
    /// whole statement, the parent went away): nothing is registered.
    async fn sign(&mut self, ask: &SigningAsk) -> Result<SigningAnswer, String>;
}

/// The parent app over stdio. One JSON line out, one JSON line in; the pipes
/// are the ones the app created for this very child, so the answer can only
/// come from the process that launched it (no listener, no path to squat).
pub struct StdioSigner;

#[async_trait::async_trait]
impl RegistrationSigner for StdioSigner {
    async fn sign(&mut self, ask: &SigningAsk) -> Result<SigningAnswer, String> {
        use std::io::Write as _;
        let line = serde_json::json!({
            "momoWorkd": "host_register_request",
            "hostPublicKey": ask.host_public_key,
            "instanceId": ask.context.as_ref().map(|c| c.instance_id.clone()),
            "serverTimeMs": ask.context.as_ref().map(|c| c.server_time_ms),
            "signingContext": ask.context_state,
            // What the owner can hold the dialog's fingerprint against: the
            // same value is printed when the registration completes, and
            // `momo-workd` never shows a key any other way.
            "hostKeyFingerprint": host_key_fingerprint(&ask.host_public_key),
            "hostRegisterSignatureRequired":
                ask.context.as_ref().is_some_and(|c| c.host_register_signature_required),
        });
        let answer = tokio::task::spawn_blocking(move || {
            let mut out = std::io::stdout().lock();
            writeln!(out, "{line}").map_err(|e| e.to_string())?;
            out.flush().map_err(|e| e.to_string())?;
            drop(out);
            let mut reply = String::new();
            let read = std::io::stdin()
                .read_line(&mut reply)
                .map_err(|e| e.to_string())?;
            if read == 0 {
                return Err("the app closed the pipe without answering".to_string());
            }
            Ok(reply)
        })
        .await
        .map_err(|e| e.to_string())??;
        parse_signing_answer(&answer)
    }
}

/// `{"registration": {…}}`, `{"unsigned": true}` or `{"declined": "why"}`.
pub fn parse_signing_answer(line: &str) -> Result<SigningAnswer, String> {
    let value: serde_json::Value =
        serde_json::from_str(line.trim()).map_err(|_| "unreadable answer".to_string())?;
    if let Some(registration) = value.get("registration").filter(|r| r.is_object()) {
        return Ok(SigningAnswer::Signed(registration.clone()));
    }
    if value.get("unsigned").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(SigningAnswer::Unsigned);
    }
    let why = value
        .get("declined")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("declined");
    Err(why.chars().take(120).collect())
}

/// Generate a key, keep it, register its public half with the owner's token,
/// and write the state. Prints the host id; never the key or the token.
pub async fn register(
    config_path: PathBuf,
    dev_key_file: Option<PathBuf>,
    force: bool,
    token: Option<String>,
) -> Result<HostState, CliError> {
    register_signed(config_path, dev_key_file, force, token, None).await
}

/// [`register`], asking `signer` for the owner's root-key signature first
/// (ADR-0146 개정 D-8, #3120). Without a signer this is exactly the unsigned
/// registration of before.
pub async fn register_signed(
    config_path: PathBuf,
    dev_key_file: Option<PathBuf>,
    force: bool,
    token: Option<String>,
    mut signer: Option<&mut dyn RegistrationSigner>,
) -> Result<HostState, CliError> {
    let config = WorkdConfig::load(&config_path)?;
    let token = token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| {
            CliError::Usage(format!(
                "{REGISTER_TOKEN_ENV} must carry the owner's access token"
            ))
        })?;
    let store = Arc::new(key_store(&config, dev_key_file)?);
    if store.is_dev_file() {
        tracing::warn!(
            "host key kept in a development key file ({})",
            store.describe()
        );
    }

    let key = HostKey::generate()?;
    let public_key = key.public_key_b64();
    let key = Arc::new(key);
    {
        let (store, key) = (store.clone(), key.clone());
        blocking(move || store.store(&key, force)).await?;
    }

    // From here a failure must leave neither a host row pointing at this key
    // nor this key without a row (#3155 review): `posted` remembers the row
    // the server made, so every later refusal withdraws it as well as the key.
    let posted: std::cell::Cell<Option<uuid::Uuid>> = std::cell::Cell::new(None);
    let attempt = async {
        let registration = match signer.as_mut() {
            None => None,
            Some(signer) => {
                let lookup = client::fetch_signing_context(
                    &config.server_base(),
                    config.workspace_id,
                    token.trim(),
                )
                .await
                .map_err(CliError::Register)?;
                if lookup.context().is_none() {
                    // The one silent fallback there was: say it.
                    tracing::warn!(
                        signing_context = lookup.state(),
                        "this server offers no signing context; registering without the \
                         owner's signature (the server decides whether that is enough)"
                    );
                }
                let required = lookup
                    .context()
                    .is_some_and(|c| c.host_register_signature_required);
                let ask = SigningAsk {
                    host_public_key: public_key.clone(),
                    context_state: lookup.state(),
                    context: lookup.context().cloned(),
                };
                match signer.sign(&ask).await.map_err(CliError::Signing)? {
                    SigningAnswer::Signed(registration) => Some(registration),
                    SigningAnswer::Unsigned if required => {
                        return Err(CliError::Signing(
                            "device_signature_required: this server needs the root device \
                             key's signature and this Mac has none bound"
                                .into(),
                        ));
                    }
                    SigningAnswer::Unsigned => None,
                }
            }
        };
        let signed_host_id = registration
            .as_ref()
            .and_then(|r| r.get("hostId"))
            .and_then(serde_json::Value::as_str)
            .and_then(|id| uuid::Uuid::parse_str(id).ok());
        if registration.is_some() && signed_host_id.is_none() {
            return Err(CliError::Signing("the signature names no host id".into()));
        }
        let registered = client::register_host(
            &config.server_base(),
            config.workspace_id,
            token.trim(),
            &config.display_name,
            &public_key,
            registration.as_ref(),
        )
        .await
        .map_err(CliError::Register)?;
        posted.set(Some(registered.id));
        // The row must be the one the owner signed for, not merely a row.
        if signed_host_id.is_some_and(|id| id != registered.id) {
            return Err(CliError::Register(ClientError::Decode(
                "the server registered another host id than the one signed".into(),
            )));
        }
        if registered.public_key != public_key
            || registered.workspace_id != config.workspace_id
            || registered.scope != "member"
            || registered.host_type != "workd"
        {
            return Err(CliError::Register(ClientError::Decode(
                "the server registered a different host than the one requested".into(),
            )));
        }
        let state = HostState {
            server_url: config.server_base(),
            workspace_id: registered.workspace_id,
            host_id: registered.id,
            owner_member_id: registered.owner_member_id,
            public_key: public_key.clone(),
            scope: registered.scope,
        };
        state.save(&config.state_path)?;
        // A new registration is a new root (ADR-0146 개정 D-6): the old pin and
        // its ledger do not carry over (#3024 review L1).
        remove_trust_files(&config)?;
        Ok(state)
    }
    .await;
    let state = match attempt {
        Ok(state) => state,
        Err(error) => {
            if let Some(host_id) = posted.get() {
                if let Err(revoke) = client::revoke_registered_host(
                    &config.server_base(),
                    config.workspace_id,
                    token.trim(),
                    host_id,
                )
                .await
                {
                    // Not silent: the owner can still revoke it by hand.
                    tracing::warn!(
                        %host_id,
                        "could not withdraw the host row of a registration that failed: {revoke}"
                    );
                }
                // The state file may be the half-written one of this attempt.
                let _ = std::fs::remove_file(&config.state_path);
            }
            let store = store.clone();
            let _ = blocking(move || store.delete()).await;
            return Err(error);
        }
    };
    tracing::info!(
        host_id = %state.host_id,
        key_store = %store.describe(),
        fingerprint = %host_key_fingerprint(&state.public_key).unwrap_or_default(),
        "work host registered"
    );
    Ok(state)
}

/// The fingerprint a person compares: SHA-256 over the decoded public key, the
/// first 10 bytes as upper-case hex in five groups of four — the string the
/// desktop dialog and the web device list show for the same key
/// (`5BAF F89D E7DE 5C1D 7B61` for the shared vector).
pub fn host_key_fingerprint(public_key_b64: &str) -> Option<String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(public_key_b64)
        .ok()?;
    let digest = momo_wire::sha256_hex(&bytes);
    Some(
        digest[..20]
            .to_ascii_uppercase()
            .as_bytes()
            .chunks(4)
            .map(|chunk| std::str::from_utf8(chunk).expect("ascii hex"))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// Bind the control socket and serve it on a task (macOS; see
/// [`crate::control_socket`]). `None` when the app did not ask for one.
#[cfg(target_os = "macos")]
fn start_control_socket(
    path: Option<PathBuf>,
    dev_unsigned_peer: bool,
    state: &HostState,
    shared: SocketShared,
) -> Result<Option<tokio::task::JoinHandle<()>>, CliError> {
    let Some(path) = path else {
        return Ok(None);
    };
    let policy = PeerPolicy::for_this_binary(dev_unsigned_peer).map_err(CliError::Usage)?;
    match &policy {
        PeerPolicy::SameTeamApp { requirement } => {
            tracing::info!(requirement = %requirement, "control socket peers must satisfy")
        }
        PeerPolicy::DevUnsigned => {
            tracing::warn!("control socket without a peer signature check (--dev-unsigned-peer)")
        }
        PeerPolicy::RefuseAll => tracing::warn!(
            "this momo-workd is not team-signed: the control socket will refuse every peer"
        ),
    }
    let socket = ControlSocket::bind(&path, policy)?;
    tracing::info!(path = %socket.path().display(), "control socket listening");
    Ok(Some(tokio::spawn(socket.serve(
        HostIdentity {
            host_id: state.host_id,
            workspace_id: state.workspace_id,
            owner_member_id: state.owner_member_id,
        },
        shared,
    ))))
}

/// The peer is checked by code signature, which only macOS has.
#[cfg(not(target_os = "macos"))]
fn start_control_socket(
    path: Option<PathBuf>,
    _dev_unsigned_peer: bool,
    _state: &HostState,
    _shared: SocketShared,
) -> Result<Option<tokio::task::JoinHandle<()>>, CliError> {
    match path {
        None => Ok(None),
        Some(_) => Err(CliError::Usage(
            "--control-socket needs macOS (the peer is checked by code signature)".into(),
        )),
    }
}

/// Delete this host's key and registration state. Idempotent: nothing to delete
/// is not an error.
pub async fn forget(config_path: PathBuf, dev_key_file: Option<PathBuf>) -> Result<(), CliError> {
    let config = WorkdConfig::load(&config_path)?;
    let store = key_store(&config, dev_key_file)?;
    blocking(move || store.delete()).await?;
    match std::fs::remove_file(&config.state_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(CliError::Config(ConfigError::Io {
                path: config.state_path.display().to_string(),
                source,
            }))
        }
    }
    // Host re-registration is root reset (ADR-0146 개정 D-6).
    remove_trust_files(&config)?;
    tracing::info!("host key, registration state and device trust deleted");
    Ok(())
}

fn remove_trust_files(config: &WorkdConfig) -> Result<(), CliError> {
    for name in [
        crate::human_trust::TRUST_FILE,
        crate::human_trust::NONCE_FILE,
        // A new registration is a new host: the server latches R2 again
        // once it requires signatures and a root is pinned (#3117).
        crate::signature_requirement::REQUIRED_FILE,
    ] {
        let path = state_folder(config).join(name);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(CliError::Config(ConfigError::Io {
                    path: path.display().to_string(),
                    source,
                }))
            }
        }
    }
    Ok(())
}

/// The host state folder: beside `state_path`, where Codex's home also lives.
fn state_folder(config: &WorkdConfig) -> PathBuf {
    config
        .state_path
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn trust_identity(state: &HostState) -> TrustIdentity {
    TrustIdentity {
        workspace_id: state.workspace_id,
        owner_member_id: state.owner_member_id,
        host_id: state.host_id,
    }
}

/// Forget the pinned root key (local reset, ADR-0146 개정 D-6).
pub fn reset_root(config_path: PathBuf) -> Result<(), CliError> {
    let config = WorkdConfig::load(&config_path)?;
    let state = HostState::load(&config.state_path)?;
    let mut trust = HumanTrust::open(&state_folder(&config), trust_identity(&state))?;
    trust.reset_root()?;
    tracing::info!("device root key forgotten; the desktop app can pin a new one");
    Ok(())
}

/// Serve until a signal (exit 0) or until the server refuses the host
/// (`CliError::Revoked`, exit 3 — ADR-0188 D7: a 401 stops remote sessions),
/// or until the desktop app asks for `shutdown` on the control socket (exit 0).
pub async fn run(
    config_path: PathBuf,
    dev_key_file: Option<PathBuf>,
    control_socket: Option<PathBuf>,
    dev_unsigned_peer: bool,
) -> Result<(), CliError> {
    let config = WorkdConfig::load(&config_path)?;
    let state = HostState::load(&config.state_path)?;
    state.check_matches(&config)?;
    // ADR-0188 D3 (#2602 M-4): the owner-only rules below are a member host's
    // rules. A host registered any other way is not one this binary serves.
    if state.scope != SERVED_SCOPE {
        return Err(CliError::Usage(format!(
            "this host is registered with scope {:?}; momo-workd serves only {SERVED_SCOPE:?} \
             hosts (ADR-0188 D3) — re-register with `momo-workd register`",
            state.scope
        )));
    }
    let store = key_store(&config, dev_key_file)?;
    if store.is_dev_file() {
        tracing::warn!(
            "host key read from a development key file ({})",
            store.describe()
        );
    }
    let key = blocking(move || store.load()).await?.ok_or_else(|| {
        CliError::Usage("no host key found; run `momo-workd register` first".into())
    })?;
    if key.public_key_b64() != state.public_key {
        return Err(CliError::Usage(
            "the stored host key does not match the registered public key; re-register".into(),
        ));
    }

    let api = Arc::new(
        HostClient::new(
            config.server_base(),
            state.workspace_id,
            state.host_id,
            Arc::new(key),
        )
        .map_err(CliError::Register)?,
    );
    // ADR-0188 §8: Codex runs from the host's own home, signed in once there.
    // #2630 F5: with an empty host folder as its HOME; the commands it runs
    // get the owner's HOME back.
    let codex = CodexHome::beside(&config.state_path)
        .with_owner_home(std::env::var_os("HOME").map(PathBuf::from));
    if config
        .tools
        .values()
        .any(|entry| entry.adapter == AdapterKind::Codex)
    {
        let signed_in = codex.home.join("auth.json").exists();
        tracing::info!(
            home = %codex.home.display(),
            signed_in,
            "Codex runs from the host's own home (ADR-0188 §8)"
        );
        if !signed_in {
            tracing::warn!(
                login = %codex.login_command(),
                "sign Codex in to the host's own home once; until then Codex sessions are refused"
            );
        }
        if codex.owner_home.is_none() {
            tracing::warn!(
                "no absolute HOME: the commands Codex runs keep the host's empty folder as HOME \
                 (toolchains under the owner's home, such as rustup, will not be found)"
            );
        }
    }
    let sessions = SessionManager::new(
        api.clone(),
        SessionSettings {
            tools: config.tools.clone(),
            working_directory: config.working_directory.clone(),
            acp_start_timeout: Duration::from_millis(config.acp_start_timeout_ms),
            // Filtered per launch to `policy::AGENT_ENV_ALLOWLIST` (#2630 F1).
            parent_env: std::env::vars().collect(),
            max_sessions: config.max_sessions,
            permission_wait: crate::session::DEFAULT_PERMISSION_WAIT,
            codex,
            state_folder: state_folder(&config),
        },
    );
    let health = Arc::new(HostHealth::default());
    let stop = Arc::new(tokio::sync::Notify::new());
    // #3117: whether R2 is required — the owner's config, or the server's
    // word latched earlier (an unreadable latch counts as latched).
    let requirement =
        SignatureRequirement::open(&state_folder(&config), config.require_human_signatures);
    let required_at_start = requirement.required();
    let requirement = Arc::new(std::sync::Mutex::new(requirement));
    // ADR-0146 개정 (#3024): the pinned root and the nonce ledger. Opened even
    // with R2 off, so the desktop app can pin its root before R2 is switched on.
    let trust = match HumanTrust::open(&state_folder(&config), trust_identity(&state)) {
        Ok(trust) => trust,
        // R2 off must not change whether the host starts (#3024 review L2).
        // R2 on (config or latch) and no readable trust state: refuse to start.
        // An R2 latch that arrives later with such a state finds no root and
        // does not latch (`signature_requirement`).
        Err(error) if !required_at_start => {
            tracing::warn!(error = %error, "device trust state unreadable; R2 is off, continuing");
            HumanTrust::empty(&state_folder(&config), trust_identity(&state))
        }
        Err(error) => return Err(error.into()),
    };
    let trust = Arc::new(std::sync::Mutex::new(trust));
    // Bound before the first heartbeat, so a second workd for the same socket
    // stops here (exit 4) instead of racing the first one's server session.
    let control = start_control_socket(
        control_socket,
        dev_unsigned_peer,
        &state,
        SocketShared {
            health: health.clone(),
            stop: stop.clone(),
            trust: trust.clone(),
            requirement: requirement.clone(),
            state_folder: state_folder(&config),
            grants: sessions.grant_epoch(),
            share: Some(api.clone()),
        },
    )?;
    // Always with the requirement (#3117): R2 is on while it says so, and the
    // server's `humanControlSignatureRequired` can latch it on — never off.
    let mut controls = ControlLoop::new(api.clone(), sessions, state.owner_member_id)
        .with_signature_requirement(trust.clone(), requirement.clone());
    if let Some(by) = requirement
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .required_by()
    {
        tracing::info!(
            required_by = by.label(),
            root_pinned = trust
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .root()
                .is_some(),
            "R2: spawns, inputs and allows need the owner's device signature"
        );
    }
    let mut heartbeat = tokio::spawn(heartbeat_loop(
        api.clone(),
        Duration::from_millis(config.heartbeat_interval_ms),
        health.clone(),
    ));
    let mut terminate =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .map_err(|error| CliError::Usage(format!("cannot install SIGTERM handler: {error}")))?;
    tracing::info!(host_id = %state.host_id, "work host running");

    let poll = Duration::from_millis(config.poll_interval_ms);
    let outcome = loop {
        match controls.poll_once().await {
            Err(ClientError::Unauthorized) => break Err(CliError::Revoked),
            Err(error) => tracing::warn!(error = %error, "control poll failed"),
            Ok(_) => {}
        }
        tokio::select! {
            _ = tokio::time::sleep(poll) => {}
            _ = terminate.recv() => break Ok(()),
            _ = tokio::signal::ctrl_c() => break Ok(()),
            _ = stop.notified() => {
                tracing::info!("shutdown requested on the control socket");
                break Ok(());
            }
            _ = &mut heartbeat => break Err(CliError::Revoked),
        }
    };
    heartbeat.abort();
    if let Some(control) = control {
        // Dropping the serve task drops the socket, which removes its file.
        control.abort();
        let _ = control.await;
    }
    controls.sessions().shutdown().await;
    tracing::info!("work host stopped");
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn commands_parse_and_the_token_is_never_an_argument() {
        assert_eq!(
            parse_args(&args(&["register", "--config", "/c.json", "--force"])).unwrap(),
            Invocation::Register {
                config: "/c.json".into(),
                dev_key_file: None,
                force: true,
                token_stdin: false,
                sign_stdin: false,
            }
        );
        assert_eq!(
            parse_args(&args(&[
                "run",
                "--config",
                "/c.json",
                "--dev-key-file",
                "/k"
            ]))
            .unwrap(),
            Invocation::Run {
                config: "/c.json".into(),
                dev_key_file: Some("/k".into()),
                control_socket: None,
                dev_unsigned_peer: false,
            }
        );
        assert_eq!(
            parse_args(&args(&[
                "run",
                "--config",
                "/c.json",
                "--control-socket",
                "/s/workd.sock",
                "--dev-unsigned-peer"
            ]))
            .unwrap(),
            Invocation::Run {
                config: "/c.json".into(),
                dev_key_file: None,
                control_socket: Some("/s/workd.sock".into()),
                dev_unsigned_peer: true,
            }
        );
        assert!(
            parse_args(&args(&["run", "--config", "/c", "--dev-unsigned-peer"])).is_err(),
            "the dev flag means nothing without a control socket"
        );
        assert!(parse_args(&args(&[
            "register",
            "--config",
            "/c",
            "--control-socket",
            "/s"
        ]))
        .is_err());
        assert!(parse_args(&args(&["register", "--config", "/c", "--token", "t"])).is_err());
        assert!(parse_args(&args(&["run", "--config", "/c", "--force"])).is_err());
        assert_eq!(
            parse_args(&args(&["register", "--token-stdin", "--config", "/c.json"])).unwrap(),
            Invocation::Register {
                config: "/c.json".into(),
                dev_key_file: None,
                force: false,
                token_stdin: true,
                sign_stdin: false,
            }
        );
        assert_eq!(
            parse_args(&args(&[
                "register",
                "--token-stdin",
                "--sign-stdin",
                "--config",
                "/c.json"
            ]))
            .unwrap(),
            Invocation::Register {
                config: "/c.json".into(),
                dev_key_file: None,
                force: false,
                token_stdin: true,
                sign_stdin: true,
            }
        );
        assert!(
            parse_args(&args(&["register", "--sign-stdin", "--config", "/c.json"])).is_err(),
            "the signature answer and the token share one stdin"
        );
        assert!(parse_args(&args(&["run", "--config", "/c", "--sign-stdin"])).is_err());
        assert!(parse_args(&args(&["run", "--config", "/c", "--token-stdin"])).is_err());
        assert!(parse_args(&args(&["run"])).is_err());
        assert_eq!(
            parse_args(&args(&["forget", "--config", "/c.json"])).unwrap(),
            Invocation::Forget {
                config: "/c.json".into(),
                dev_key_file: None
            }
        );
        assert!(parse_args(&args(&["forget", "--config", "/c", "--force"])).is_err());
        assert_eq!(
            parse_args(&args(&["reset-root", "--config", "/c.json"])).unwrap(),
            Invocation::ResetRoot {
                config: "/c.json".into()
            }
        );
        assert!(parse_args(&args(&[
            "reset-root",
            "--config",
            "/c",
            "--dev-key-file",
            "/k"
        ]))
        .is_err());
        assert_eq!(parse_args(&[]).unwrap(), Invocation::Help);
    }

    #[test]
    fn the_parents_answer_is_one_of_three_closed_shapes() {
        assert_eq!(
            parse_signing_answer(r#"{"registration":{"hostId":"h"}}"#),
            Ok(SigningAnswer::Signed(serde_json::json!({"hostId": "h"})))
        );
        assert_eq!(
            parse_signing_answer(r#"{"unsigned":true}"#),
            Ok(SigningAnswer::Unsigned)
        );
        assert_eq!(
            parse_signing_answer(r#"{"declined":"device_key_declined"}"#),
            Err("device_key_declined".to_string())
        );
        // Anything else is a refusal, never an unsigned registration.
        for line in [
            "",
            "{}",
            "null",
            r#"{"unsigned":false}"#,
            r#"{"registration":"x"}"#,
        ] {
            assert!(parse_signing_answer(line).is_err(), "{line:?}");
        }
    }

    #[test]
    fn the_host_key_fingerprint_is_the_shared_one() {
        // clients/desktop device_key/payload/tests.rs FINGERPRINT_VECTOR and
        // clients/web deviceKeysShared.test.ts pin the same string.
        assert_eq!(
            host_key_fingerprint("A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW").as_deref(),
            Some("5BAF F89D E7DE 5C1D 7B61")
        );
        assert_eq!(host_key_fingerprint("not base64!"), None);
    }
}
