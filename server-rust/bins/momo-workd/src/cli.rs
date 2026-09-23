//! `momo-workd register` and `momo-workd run`.
//!
//! ```text
//! MOMO_WORKD_REGISTER_TOKEN=<owner access token> \
//!   momo-workd register --config workd.json [--dev-key-file PATH] [--force]
//! momo-workd run      --config workd.json [--dev-key-file PATH]
//! ```
//!
//! Registration takes the **owner's** session token (ADR-0188 D2/D3). In this
//! slice it comes from the environment — never a command-line argument, which
//! any local process could read from the process table — and is used for one
//! request and dropped. The desktop app will hand it over itself once the
//! registration GUI lands.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::client::{self, ClientError, HostClient};
use crate::config::{ConfigError, HostState, WorkdConfig, SERVED_SCOPE};
use crate::controls::{heartbeat_loop, ControlLoop};
use crate::keystore::{HostKey, KeyStore, KeyStoreError};
use crate::session::{SessionManager, SessionSettings};

/// The environment variable `register` reads the owner's token from.
pub const REGISTER_TOKEN_ENV: &str = "MOMO_WORKD_REGISTER_TOKEN";

pub const USAGE: &str = "\
momo-workd — oort desktop work host (ADR-0188)

usage:
  momo-workd register --config PATH [--dev-key-file PATH] [--force]
      reads the owner's access token from MOMO_WORKD_REGISTER_TOKEN
  momo-workd run --config PATH [--dev-key-file PATH]
  momo-workd --version

--dev-key-file keeps the host key in a 0600 file instead of the keychain.
It exists for development and tests only.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    Register {
        config: PathBuf,
        dev_key_file: Option<PathBuf>,
        force: bool,
    },
    Run {
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
        "register" | "run" => {}
        other => return Err(format!("unknown command {other:?}")),
    }
    let mut config = None;
    let mut dev_key_file = None;
    let mut force = false;
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
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    let config = config.ok_or_else(|| "--config is required".to_string())?;
    Ok(if command == "register" {
        Invocation::Register {
            config,
            dev_key_file,
            force,
        }
    } else {
        Invocation::Run {
            config,
            dev_key_file,
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
}

impl CliError {
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Usage(_) | Self::Config(_) => 2,
            Self::Revoked => 3,
            _ => 1,
        }
    }
}

fn key_store(config: &WorkdConfig, dev_key_file: Option<PathBuf>) -> Result<KeyStore, CliError> {
    match dev_key_file {
        Some(path) => {
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

/// Serve until a signal (exit 0) or until the server refuses the host
/// (`CliError::Revoked`, exit 3 — ADR-0188 D7: a 401 stops remote sessions).
pub async fn run(config_path: PathBuf, dev_key_file: Option<PathBuf>) -> Result<(), CliError> {
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
    let sessions = SessionManager::new(
        api.clone(),
        SessionSettings {
            tools: config.tools.clone(),
            working_directory: config.working_directory.clone(),
            acp_start_timeout: Duration::from_millis(config.acp_start_timeout_ms),
            parent_env: std::env::vars().collect(),
        },
    );
    let mut controls = ControlLoop::new(api.clone(), sessions, state.owner_member_id);
    let mut heartbeat = tokio::spawn(heartbeat_loop(
        api.clone(),
        Duration::from_millis(config.heartbeat_interval_ms),
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
            _ = &mut heartbeat => break Err(CliError::Revoked),
        }
    };
    heartbeat.abort();
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
                force: true
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
                dev_key_file: Some("/k".into())
            }
        );
        assert!(parse_args(&args(&["register", "--config", "/c", "--token", "t"])).is_err());
        assert!(parse_args(&args(&["run", "--config", "/c", "--force"])).is_err());
        assert!(parse_args(&args(&["run"])).is_err());
        assert_eq!(parse_args(&[]).unwrap(), Invocation::Help);
    }
}
