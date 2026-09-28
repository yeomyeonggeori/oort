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
use crate::controls::{heartbeat_loop, ControlLoop};
use crate::keystore::{HostKey, KeyStore, KeyStoreError};
use crate::policy::{AdapterKind, CodexHome};
use crate::session::{SessionManager, SessionSettings};

/// The environment variable `register` reads the owner's token from.
pub const REGISTER_TOKEN_ENV: &str = "MOMO_WORKD_REGISTER_TOKEN";

pub const USAGE: &str = "\
momo-workd — oort desktop work host (ADR-0188)

usage:
  momo-workd register --config PATH [--dev-key-file PATH] [--force] [--token-stdin]
      reads the owner's access token from MOMO_WORKD_REGISTER_TOKEN,
      or from one line on stdin with --token-stdin
  momo-workd run --config PATH [--dev-key-file PATH]
                 [--control-socket PATH [--dev-unsigned-peer]]
  momo-workd forget --config PATH [--dev-key-file PATH]
      deletes the host key and the registration state (after a revoke)
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
        "register" | "run" | "forget" => {}
        other => return Err(format!("unknown command {other:?}")),
    }
    let mut config = None;
    let mut dev_key_file = None;
    let mut force = false;
    let mut token_stdin = false;
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
            "--dev-key-file" => dev_key_file = Some(PathBuf::from(value("--dev-key-file")?)),
            "--force" if command == "register" => force = true,
            "--token-stdin" if command == "register" => token_stdin = true,
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
    Ok(if command == "register" {
        Invocation::Register {
            config,
            dev_key_file,
            force,
            token_stdin,
        }
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

fn key_store(config: &WorkdConfig, dev_key_file: Option<PathBuf>) -> Result<KeyStore, CliError> {
    match dev_key_file {
        Some(path) => {
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

/// Generate a key, keep it, register its public half with the owner's token,
/// and write the state. Prints the host id; never the key or the token.
pub async fn register(
    config_path: PathBuf,
    dev_key_file: Option<PathBuf>,
    force: bool,
    token: Option<String>,
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

    let registered = match client::register_host(
        &config.server_base(),
        config.workspace_id,
        token.trim(),
        &config.display_name,
        &public_key,
    )
    .await
    {
        Ok(registered) => registered,
        Err(error) => {
            // No host row points at this key: do not keep it around.
            let store = store.clone();
            let _ = blocking(move || store.delete()).await;
            return Err(CliError::Register(error));
        }
    };
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
        public_key,
        scope: registered.scope,
    };
    state.save(&config.state_path)?;
    tracing::info!(host_id = %state.host_id, key_store = %store.describe(), "work host registered");
    Ok(state)
}

/// Bind the control socket and serve it on a task (macOS; see
/// [`crate::control_socket`]). `None` when the app did not ask for one.
#[cfg(target_os = "macos")]
fn start_control_socket(
    path: Option<PathBuf>,
    dev_unsigned_peer: bool,
    state: &HostState,
    health: Arc<HostHealth>,
    stop: Arc<tokio::sync::Notify>,
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
        health,
        stop,
    ))))
}

/// The peer is checked by code signature, which only macOS has.
#[cfg(not(target_os = "macos"))]
fn start_control_socket(
    path: Option<PathBuf>,
    _dev_unsigned_peer: bool,
    _state: &HostState,
    _health: Arc<HostHealth>,
    _stop: Arc<tokio::sync::Notify>,
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
    tracing::info!("host key and registration state deleted");
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
        },
    );
    let health = Arc::new(HostHealth::default());
    let stop = Arc::new(tokio::sync::Notify::new());
    // Bound before the first heartbeat, so a second workd for the same socket
    // stops here (exit 4) instead of racing the first one's server session.
    let control = start_control_socket(
        control_socket,
        dev_unsigned_peer,
        &state,
        health.clone(),
        stop.clone(),
    )?;
    let mut controls = ControlLoop::new(api.clone(), sessions, state.owner_member_id);
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
            }
        );
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
        assert_eq!(parse_args(&[]).unwrap(), Invocation::Help);
    }
}
