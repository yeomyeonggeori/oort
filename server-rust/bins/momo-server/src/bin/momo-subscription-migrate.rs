//! `momo-subscription-migrate` — operator tool for ADR-0198 증보 1 D2 (#3567 T2).
//!
//! ```text
//! DATABASE_URL=postgres://momo_app:…@host/db \
//!   momo-subscription-migrate convert --workspace <uuid> --handle kwak-claude            # dry-run
//!   momo-subscription-migrate convert --workspace <uuid> --handle kwak-claude \
//!       --execute --note "성재 승인 2026-10-10 (#3567)"                                   # writes
//!   momo-subscription-migrate retire  --workspace <uuid> --handle claude-code [--execute --note …]
//! ```
//!
//! * `convert`: the owner's `owner_only` subscription agent becomes a D7 personal agent in
//!   place (same member id and handle, past messages keep their author).
//! * `retire`: a hosted entry named after a harness with no VM agent behind it is switched
//!   off (suspended, 「이전 구독 에이전트」 marker). Nothing is deleted.
//!
//! **Dry-run is the default** and runs in a read-only transaction. `--execute` needs `--note`
//! (the owner's approval citation, stored in the audit row). Both are idempotent and audited
//! (`subscription_agent.converted` / `subscription_agent.retired`). The tool refuses to run
//! as a superuser or `BYPASSRLS` role: connect as `momo_app`; every statement runs in a
//! tenant transaction.
//!
//! Exit codes: `0` done / nothing to do / dry-run printed, `2` bad invocation,
//! `3` refused (nothing written), `1` any other failure.

use std::process::ExitCode;

use momo_agent::subscription_transition::{
    assert_least_privilege_role, run_transition, validate_note, Transition, Verdict,
};
use momo_db::sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

const USAGE: &str = "usage: DATABASE_URL=… momo-subscription-migrate {convert|retire} \
--workspace <uuid> --handle <handle> [--execute --note <approval citation>]";

struct Args {
    transition: Transition,
    workspace: Uuid,
    handle: String,
    execute: bool,
    note: Option<String>,
}

fn parse(args: &[String]) -> Result<Args, String> {
    let mut iter = args.iter();
    let transition = match iter.next().map(String::as_str) {
        Some("convert") => Transition::Convert,
        Some("retire") => Transition::Retire,
        _ => return Err("expected a command: convert or retire".into()),
    };
    let (mut workspace, mut handle, mut execute, mut note) = (None, None, false, None);
    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--workspace" => {
                let raw = iter.next().ok_or("--workspace needs a value")?;
                workspace = Some(
                    Uuid::parse_str(raw).map_err(|_| "--workspace must be the workspace uuid")?,
                );
            }
            "--handle" => {
                handle = Some(
                    iter.next()
                        .ok_or("--handle needs a value")?
                        .trim_start_matches('@')
                        .to_string(),
                );
            }
            "--note" => note = Some(iter.next().ok_or("--note needs a value")?.clone()),
            "--execute" => execute = true,
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    let handle = handle.ok_or("--handle is required")?;
    if handle.is_empty() {
        return Err("--handle is empty".into());
    }
    if execute {
        validate_note(note.as_deref().unwrap_or(""))?;
    } else if note.is_some() {
        return Err("--note only goes with --execute".into());
    }
    Ok(Args {
        transition,
        workspace: workspace.ok_or("--workspace is required")?,
        handle,
        execute,
        note,
    })
}

/// The operator's machine, for the audit row (`hostname`, else `$HOSTNAME`, else `unknown`).
fn operator_host() -> String {
    let named = std::process::Command::new("hostname")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|name| !name.is_empty());
    named
        .or_else(|| {
            std::env::var("HOSTNAME")
                .ok()
                .filter(|name| !name.is_empty())
        })
        .map(|name| name.chars().filter(|c| !c.is_control()).take(100).collect())
        .unwrap_or_else(|| "unknown".to_string())
}

#[tokio::main]
async fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse(&argv) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("error: {error}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let Ok(database_url) = std::env::var("DATABASE_URL") else {
        eprintln!("error: DATABASE_URL is required; refusing to guess a database\n{USAGE}");
        return ExitCode::from(2);
    };
    let pool = match PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
    {
        Ok(pool) => pool,
        Err(error) => {
            eprintln!("error: cannot connect: {error}");
            return ExitCode::from(1);
        }
    };
    match assert_least_privilege_role(&pool).await {
        Ok(role) => eprintln!("role: {role} (row-level security applies)"),
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::from(3);
        }
    }
    let note = args.note.as_deref().unwrap_or("").trim();
    match run_transition(
        &pool,
        args.workspace,
        args.transition,
        &args.handle,
        args.execute,
        note,
        &operator_host(),
    )
    .await
    {
        Ok(Some(report)) => {
            println!("{}", report.render());
            if matches!(report.verdict, Verdict::Refused { .. }) {
                ExitCode::from(3)
            } else {
                ExitCode::SUCCESS
            }
        }
        Ok(None) => {
            eprintln!(
                "error: no agent with handle @{} in workspace {} (nothing was written)",
                args.handle, args.workspace
            );
            ExitCode::from(3)
        }
        Err(error) => {
            eprintln!("error: {error} (the transaction was rolled back)");
            ExitCode::from(1)
        }
    }
}
