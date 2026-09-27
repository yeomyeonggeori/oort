//! `momo-workd` entry point — see [`momo_workd::cli`].

use momo_workd::cli::{self, CliError, Invocation};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("MOMO_WORKD_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let invocation = match cli::parse_args(&args) {
        Ok(invocation) => invocation,
        Err(message) => {
            eprintln!("momo-workd: {message}\n\n{}", cli::USAGE);
            std::process::exit(2);
        }
    };
    let result: Result<(), CliError> = match invocation {
        Invocation::Help => {
            println!("{}", cli::USAGE);
            Ok(())
        }
        Invocation::Version => {
            println!("momo-workd {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Invocation::Register {
            config,
            dev_key_file,
            force,
            token_stdin,
        } => {
            let token = if token_stdin {
                let mut line = String::new();
                std::io::stdin()
                    .read_line(&mut line)
                    .ok()
                    .map(|_| line.trim().to_string())
            } else {
                std::env::var(cli::REGISTER_TOKEN_ENV).ok()
            };
            cli::register(config, dev_key_file, force, token)
                .await
                .map(|state| {
                    println!(
                        "{}",
                        serde_json::json!({
                            "hostId": state.host_id,
                            "ownerMemberId": state.owner_member_id,
                            "workspaceId": state.workspace_id,
                        })
                    );
                })
        }
        Invocation::Forget {
            config,
            dev_key_file,
        } => cli::forget(config, dev_key_file).await,
        Invocation::Run {
            config,
            dev_key_file,
            control_socket,
            dev_unsigned_peer,
        } => cli::run(config, dev_key_file, control_socket, dev_unsigned_peer).await,
    };
    if let Err(error) = result {
        eprintln!("momo-workd: {error}");
        std::process::exit(error.exit_code());
    }
}
