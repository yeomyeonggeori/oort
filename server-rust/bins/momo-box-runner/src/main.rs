//! `momo-box-runner` entry point.
//!
//! ```text
//! momo-box-runner run                    poll the server and run lifecycle controls
//! momo-box-runner check-config           validate the configuration and exit
//! momo-box-runner init-identity          create the runner's Ed25519 identity (signingKeyFile) and print its
//!                                        fingerprint — the value members must be told out of band
//! momo-box-runner quarantine             list quarantined orphan volumes (ids, times, confirmed?)
//! momo-box-runner confirm-shred <uuid>   operator confirmation: this quarantined volume may be destroyed
//! ```
//!
//! The configuration file is named by `MOMO_BOX_RUNNER_CONFIG`; there is no other flag or
//! environment variable that changes what a box runs.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use momo_box_runner::client::HttpServer;
use momo_box_runner::config::{load_config, load_credential};
use momo_box_runner::docker::CliDocker;
use momo_box_runner::engine::Engine;
use momo_box_runner::executor::{Executor, Pacing};
use momo_box_runner::identity::RunnerIdentity;
use momo_box_runner::ledger::Ledger;
use momo_box_runner::provision::HostProvisioner;
use momo_box_runner::runner::{Runner, Trust};
use tokio::sync::watch;
use uuid::Uuid;

const ENV_CONFIG: &str = "MOMO_BOX_RUNNER_CONFIG";

fn usage() -> ExitCode {
    eprintln!("usage: momo-box-runner run | check-config | init-identity | quarantine | confirm-shred <box uuid>");
    ExitCode::from(2)
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = std::env::var_os(ENV_CONFIG).map(PathBuf::from) else {
        eprintln!("momo-box-runner: set {ENV_CONFIG} to the runner configuration file");
        return ExitCode::from(2);
    };
    let cfg = match load_config(&path) {
        Ok(cfg) => Arc::new(cfg),
        Err(error) => {
            eprintln!("momo-box-runner: {error}");
            return ExitCode::from(2);
        }
    };
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["check-config"] => {
            println!(
                "ok: workspace {} image {} prefix {} network {}",
                cfg.workspace_id, cfg.image, cfg.name_prefix, cfg.network
            );
            ExitCode::SUCCESS
        }
        ["init-identity"] => {
            let Some(path) = &cfg.signing_key_file else {
                eprintln!("momo-box-runner: set signingKeyFile in the configuration first");
                return ExitCode::from(2);
            };
            match RunnerIdentity::create(path) {
                Ok(identity) => {
                    println!("public_key={}", identity.public_key_b64());
                    println!("fingerprint={}", identity.fingerprint_hex());
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("momo-box-runner: {error}");
                    ExitCode::from(1)
                }
            }
        }
        ["quarantine"] => match Ledger::load(&cfg.state_dir) {
            Ok(ledger) => {
                for (id, entry) in &ledger.entries {
                    println!(
                        "{id} quarantined_at={} confirmed={}",
                        entry.quarantined_at, entry.confirmed
                    );
                }
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("momo-box-runner: {error}");
                ExitCode::from(1)
            }
        },
        ["confirm-shred", id] => {
            let Ok(id) = Uuid::parse_str(id) else {
                eprintln!("momo-box-runner: not a box uuid");
                return ExitCode::from(2);
            };
            let mut ledger = match Ledger::load(&cfg.state_dir) {
                Ok(ledger) => ledger,
                Err(error) => {
                    eprintln!("momo-box-runner: {error}");
                    return ExitCode::from(1);
                }
            };
            match ledger.entries.get_mut(&id) {
                Some(entry) => {
                    entry.confirmed = true;
                    if let Err(error) = ledger.save(&cfg.state_dir) {
                        eprintln!("momo-box-runner: {error}");
                        return ExitCode::from(1);
                    }
                    println!("confirmed: {id} may be destroyed once its grace period has passed");
                    ExitCode::SUCCESS
                }
                None => {
                    eprintln!("momo-box-runner: {id} is not quarantined on this host");
                    ExitCode::from(1)
                }
            }
        }
        ["run"] => {
            let credential = match load_credential(&cfg.credential_file) {
                Ok(token) => token,
                Err(error) => {
                    eprintln!("momo-box-runner: {error}");
                    return ExitCode::from(2);
                }
            };
            let server = match HttpServer::new(&cfg.server_url, cfg.workspace_id, credential) {
                Ok(server) => Arc::new(server),
                Err(error) => {
                    eprintln!("momo-box-runner: {error}");
                    return ExitCode::from(2);
                }
            };
            let docker = Arc::new(CliDocker::new(cfg.docker_bin.clone()));
            let engine = Engine::new(docker, cfg.clone());
            // ADR-0197 M4: with a signing key the runner provisions each box (seal key, pairing code, owner list)
            // and attests the host keys it registers.
            let trust = match &cfg.signing_key_file {
                None => None,
                Some(path) => match RunnerIdentity::load(path) {
                    Ok(identity) => {
                        let provisioner: Arc<dyn momo_box_runner::provision::Provisioner> =
                            Arc::new(HostProvisioner::new(cfg.clone(), server.clone()));
                        Some(Trust {
                            identity,
                            provisioner,
                        })
                    }
                    Err(error) => {
                        eprintln!("momo-box-runner: {error} (run `momo-box-runner init-identity`)");
                        return ExitCode::from(2);
                    }
                },
            };
            let mut executor = Executor::new(engine.clone(), Pacing::default());
            if let Some(trust) = &trust {
                executor = executor.with_provisioner(trust.provisioner.clone());
            }
            let mut runner = Runner::new(cfg.clone(), engine, executor, server);
            if let Some(trust) = trust {
                runner = runner.with_trust(trust);
            }
            let (stop, shutdown) = watch::channel(false);
            tokio::spawn(async move {
                let _ = tokio::signal::ctrl_c().await;
                let _ = stop.send(true);
            });
            match runner.run(shutdown).await {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("momo-box-runner: {error}");
                    ExitCode::from(1)
                }
            }
        }
        _ => usage(),
    }
}
