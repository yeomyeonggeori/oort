//! `oort` — the terminal CLI of ADR-0216 D10 (#4662).
//!
//! `login` (browser approval, or a card token on standard input) · `logout` · `whoami` ·
//! `channels` · `read` · `post` · `inbox` · `token` · `mcp`. Every command takes `--json`.
//!
//! This crate links no server crate and installs no logging subscriber: nothing in it can print a
//! header, and the only thing it ever writes to standard output besides a command's own result
//! is a JSON-RPC line (`mcp`).

#[cfg(not(unix))]
compile_error!("oort-cli supports macOS and Linux (ADR-0216 D11); Windows is outside v1");

pub mod api;
pub mod cli;
pub mod commands;
pub mod error;
pub mod login;
pub mod mcp;
pub mod output;
pub mod secret;
pub mod session;
pub mod store;

use std::ffi::OsString;
use std::path::PathBuf;

use clap::Parser;

use crate::cli::{Cli, Command};
use crate::error::CliError;
use crate::secret::Secret;
use crate::session::Ctx;

/// The slice of the process environment the CLI reads, captured once so tests can hand in their own.
#[derive(Debug, Clone, Default)]
pub struct Env {
    /// `OORT_TOKEN` — a card token that overrides the stored login and is never stored.
    pub token: Option<Secret>,
    pub server: Option<String>,
    pub workspace: Option<String>,
    pub xdg_config_home: Option<PathBuf>,
    pub home: Option<PathBuf>,
}

impl Env {
    pub fn from_process() -> Env {
        let text = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        Env {
            token: text("OORT_TOKEN").map(Secret::new),
            server: text("OORT_SERVER"),
            workspace: text("OORT_WORKSPACE"),
            xdg_config_home: text("XDG_CONFIG_HOME").map(PathBuf::from),
            home: text("HOME").map(PathBuf::from),
        }
    }
}

/// Run one invocation and return its exit code (ADR-0216 D10: 0 ok · 1 failure · 2 usage ·
/// 3 login needed · 4 not allowed · 5 not found · 6 over a budget · 7 server or network).
pub fn run<I, T>(args: I, env: Env) -> i32
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let args: Vec<OsString> = args.into_iter().map(Into::into).collect();
    let json_asked = args.iter().any(|argument| argument == "--json");
    let cli = match Cli::try_parse_from(&args) {
        Ok(cli) => cli,
        Err(error) => {
            // `--help` and `--version` are not errors. A real usage error is printed through the
            // same filter as every other message: the parser quotes the offending argument back,
            // and that argument may be a token typed where it does not belong.
            if error.use_stderr() {
                let usage = CliError::usage("usage", error.render().to_string());
                emit_error(json_asked, &usage);
                return usage.exit_code();
            }
            let _ = error.print();
            return 0;
        }
    };
    if cli.version {
        println!("{} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));
        return 0;
    }
    let ctx = Ctx {
        env,
        json: cli.global.json,
        server: cli.global.server.clone(),
        workspace: cli.global.workspace.clone(),
    };
    let Some(command) = cli.command else {
        let error = CliError::usage(
            "usage",
            "명령이 필요해요. `oort --help`로 목록을 볼 수 있어요.",
        );
        emit_error(ctx.json, &error);
        return error.exit_code();
    };
    let result = match command {
        Command::Login(args) => login::login(&ctx, &args),
        Command::Logout => commands::logout(&ctx),
        Command::Whoami => commands::whoami(&ctx),
        Command::Channels => commands::channels(&ctx),
        Command::Read(args) => commands::read(&ctx, &args),
        Command::Post(args) => commands::post(&ctx, &args),
        Command::Inbox(args) => commands::inbox(&ctx, &args),
        Command::Token(args) => commands::token(&ctx, &args),
        Command::Mcp => mcp::serve(&ctx),
    };
    match result {
        Ok(()) => 0,
        Err(error) => {
            emit_error(ctx.json, &error);
            error.exit_code()
        }
    }
}

/// An error on standard error: the `oort.cli.error.v1` document in `--json` mode, one line otherwise.
pub fn emit_error(json: bool, error: &CliError) {
    if json {
        let line = serde_json::to_string(&error.doc()).unwrap_or_else(|_| "{}".to_string());
        output::note(&line);
    } else {
        output::note(&format!("오류: {}", error.message));
        if let Some(seconds) = error.retry_after_seconds {
            output::note(&format!("{seconds}초 뒤에 다시 해 보세요."));
        }
    }
}
