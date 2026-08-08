//! `momo-migrate` — the image's `migrate` entry point (ADR-0145 B안, batch B1.7).
//!
//! This binary is the Rust stack's stand-in for the Swift image's
//! `internal-smoke-migrate` shell wrapper, and it reproduces that wrapper's
//! **environment contract verbatim** (`infra/prod/docker/internal-smoke-migrate.sh`)
//! so the prod compose services drop onto it unchanged:
//!
//! | compose service | command | env that selects the behaviour |
//! |---|---|---|
//! | `runtime-roles` | `["migrate"]` | `MOMO_RUNTIME_ROLE_PROVISION=1` → apply `bootstrap_runtime_roles.sql`, exit |
//! | `migrate` | `["migrate"]` | `MOMO_BOOTSTRAP_RUNTIME_ROLES=0` → verify the three roles, then apply `001..NNN` |
//! | ops one-shot | `["migrate","set-owner"]` | `MOMO_INITIAL_OWNER_EMAIL`/`_PASSWORD` → `set_initial_owner.sql` |
//!
//! What it does NOT do: own any SQL. Every migration is applied by
//! [`momo_db::migrate::run_migrations`] (psql, single transaction per file,
//! `schema_migrations` tracking — B0/B1.6), and the two role files are the
//! repo's existing ones, applied through psql exactly as the shell wrapper does.
//!
//! **Secrets.** Nothing here prints a value. Role passwords and the bootstrap
//! owner password reach psql only through the inherited process environment
//! (`\getenv` in the SQL files), never through argv, and every error message
//! names a *key*.
//!
//! Paths are runtime-overridable — the compiled-in defaults are repo-relative so
//! a developer checkout works, and the image sets the four `MOMO_*_SQL` /
//! `MOMO_MIGRATIONS_DIR` variables to its `/opt/momo` copies (Dockerfile). This
//! is why the runner needed no change: `run_migrations` already takes the
//! directory as an argument; only `momo_db::migrate::default_migrations_dir`
//! is `CARGO_MANIFEST_DIR`-derived, and it is used solely as the unset fallback.
//!
//! Exit codes (shell-wrapper parity): `0` success, `2` bad invocation or a
//! malformed `MOMO_AGENT_SEED_MODE`, `1` everything else (missing role posture,
//! a migration psql rejected, idempotency violation).

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use momo_db::migrate::{
    default_migrations_dir, discover_migrations, run_migrations, Migration, SeedMode,
};

/// Repo root relative to this crate: `server-rust/bins/momo-migrate` → `../../..`.
const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");

/// The role contract `internal-smoke-migrate.sh:97-101` asserts before it will
/// migrate a database whose runtime roles were provisioned externally.
const ROLE_CONTRACT_SQL: &str = "SELECT count(*) = 3 AND bool_and(rolcanlogin AND NOT rolsuper \
     AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication \
     AND CASE WHEN rolname = 'momo_app' THEN NOT rolbypassrls ELSE rolbypassrls END) \
     FROM pg_roles WHERE rolname IN ('momo_app','momo_relay','momo_worker');";

const USAGE: &str = "usage: momo-migrate {migrate|set-owner}";

/// A failure with the exit code the shell wrapper would have produced.
#[derive(Debug, PartialEq, Eq)]
enum MigrateError {
    /// Bad invocation or a malformed enum-valued variable → exit 2.
    Usage(String),
    /// The work itself failed → exit 1.
    Failed(String),
}

impl MigrateError {
    /// The process exit status, as a `u8` so the mapping itself is assertable
    /// (`std::process::ExitCode` is not comparable).
    fn exit_code(&self) -> u8 {
        match self {
            MigrateError::Usage(_) => 2,
            MigrateError::Failed(_) => 1,
        }
    }
}

impl std::fmt::Display for MigrateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MigrateError::Usage(message) | MigrateError::Failed(message) => {
                formatter.write_str(message)
            }
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("[migrate] {error}");
            ExitCode::from(error.exit_code())
        }
    }
}

fn run(args: &[String]) -> Result<(), MigrateError> {
    match args.first().map(String::as_str).unwrap_or("migrate") {
        "migrate" => {
            reject_extra_args("migrate", args)?;
            migrate()
        }
        "set-owner" => {
            reject_extra_args("set-owner", args)?;
            set_owner()
        }
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            Ok(())
        }
        other => Err(MigrateError::Usage(format!(
            "unknown command: {other}\n{USAGE}"
        ))),
    }
}

/// Both commands are argument-free, exactly like the shell wrapper's
/// `[ "$#" -le 1 ]` guards: an unexpected argument is a visible exit 2, never a
/// silently ignored intent.
fn reject_extra_args(command: &str, args: &[String]) -> Result<(), MigrateError> {
    if args.len() > 1 {
        return Err(MigrateError::Usage(format!(
            "{command} does not accept arguments"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// environment contract
// ---------------------------------------------------------------------------

fn env(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => Some(value),
        _ => None,
    }
}

/// `MOMO_AGENT_SEED_MODE` → [`SeedMode`], mapped exactly as `scripts/migrate.sh`
/// maps it (`none`→0, `demo`/`e2e`→1, anything else → exit 2).
fn parse_seed_mode(raw: Option<&str>) -> Result<SeedMode, MigrateError> {
    match raw.map(str::trim).unwrap_or("none") {
        "none" => Ok(SeedMode::None),
        "demo" => Ok(SeedMode::Demo),
        "e2e" => Ok(SeedMode::E2e),
        _ => Err(MigrateError::Usage(
            "MOMO_AGENT_SEED_MODE must be one of: none, demo, e2e".to_string(),
        )),
    }
}

/// A strict `0|1` switch. `internal-smoke-migrate.sh` refuses anything else with
/// exit 1 rather than treating a typo as "off" — a fail-open default here would
/// silently skip the role posture check.
fn parse_flag(key: &str, raw: Option<&str>, default: bool) -> Result<bool, MigrateError> {
    match raw.map(str::trim) {
        None => Ok(default),
        Some("0") => Ok(false),
        Some("1") => Ok(true),
        Some(_) => Err(MigrateError::Failed(format!(
            "{key} must be exactly 0 or 1"
        ))),
    }
}

/// `override` wins; otherwise the compiled-in repo-relative path. The image sets
/// every override, so a container never depends on `CARGO_MANIFEST_DIR`.
fn resolve_path(override_value: Option<String>, repo_relative: &str) -> PathBuf {
    match override_value {
        Some(value) => PathBuf::from(value),
        None => PathBuf::from(format!("{REPO_ROOT}/{repo_relative}")),
    }
}

fn migrations_dir() -> PathBuf {
    match env("MOMO_MIGRATIONS_DIR") {
        Some(value) => PathBuf::from(value),
        None => default_migrations_dir(),
    }
}

fn require_database_url() -> Result<String, MigrateError> {
    env("DATABASE_URL").ok_or_else(|| {
        MigrateError::Usage("set DATABASE_URL to the migration role connection string".to_string())
    })
}

// ---------------------------------------------------------------------------
// psql plumbing (the runner's own psql handling lives in momo-db)
// ---------------------------------------------------------------------------

/// Mirrors `momo_db::migrate`'s private resolver (and `scripts/migrate.sh`):
/// PATH first, then the Homebrew keg-only libpq locations.
fn resolve_psql() -> Result<PathBuf, MigrateError> {
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("psql");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    for candidate in [
        "/opt/homebrew/opt/libpq/bin/psql",
        "/usr/local/opt/libpq/bin/psql",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(MigrateError::Failed(
        "psql client not found on PATH or Homebrew libpq locations \
         (the image installs postgresql-client)"
            .to_string(),
    ))
}

/// Apply one repo SQL file through psql with the wrapper's flags. The
/// connection string is passed as the first positional argument (`migrate.sh`
/// parity); secrets inside the file come from the inherited environment via
/// `\getenv`, never from argv.
fn psql_file(database_url: &str, file: &Path, label: &str) -> Result<(), MigrateError> {
    if !file.is_file() {
        return Err(MigrateError::Failed(format!(
            "{label}: SQL file not found at {}",
            file.display()
        )));
    }
    let psql = resolve_psql()?;
    let status = Command::new(psql)
        .arg(database_url)
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("-f")
        .arg(file)
        .status()
        .map_err(|source| {
            MigrateError::Failed(format!("{label}: failed to spawn psql: {source}"))
        })?;
    if !status.success() {
        return Err(MigrateError::Failed(format!(
            "{label}: psql exited with {:?}",
            status.code()
        )));
    }
    Ok(())
}

/// The `MOMO_BOOTSTRAP_RUNTIME_ROLES=0` gate: refuse to migrate unless the three
/// runtime roles already exist with the exact least-privilege posture
/// (`internal-smoke-migrate.sh:95-105`). Fail closed — a probe that cannot run
/// is also a refusal.
fn assert_external_runtime_roles(database_url: &str) -> Result<(), MigrateError> {
    let psql = resolve_psql()?;
    let output = Command::new(psql)
        .arg(database_url)
        .args(["-tA", "-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("-c")
        .arg(ROLE_CONTRACT_SQL)
        .output()
        .map_err(|source| {
            MigrateError::Failed(format!(
                "role posture probe: failed to spawn psql: {source}"
            ))
        })?;
    let verdict = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || verdict != "t" {
        return Err(MigrateError::Failed(
            "required externally provisioned runtime roles are absent or unsafe; \
             refusing to migrate"
                .to_string(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/// Numeric prefixes that appear on more than one file — the guard
/// `scripts/check_migration_numbers.sh` exists for. `schema_migrations` tracks
/// full filenames, so two files sharing `NNN_` would both apply and the ordering
/// between them would be filesystem-dependent.
fn duplicate_prefixes(migrations: &[Migration]) -> Vec<i64> {
    let mut duplicates = Vec::new();
    for window in migrations.windows(2) {
        if window[0].version == window[1].version && !duplicates.contains(&window[0].version) {
            duplicates.push(window[0].version);
        }
    }
    duplicates
}

fn migrate() -> Result<(), MigrateError> {
    let database_url = require_database_url()?;
    let seed_mode = parse_seed_mode(env("MOMO_AGENT_SEED_MODE").as_deref())?;

    // (1) roles-only mode — the prod `runtime-roles` service. Idempotent role
    // creation / password rotation, then exit without touching migrations.
    if parse_flag(
        "MOMO_RUNTIME_ROLE_PROVISION",
        env("MOMO_RUNTIME_ROLE_PROVISION").as_deref(),
        false,
    )? {
        for key in [
            "MOMO_APP_POSTGRES_PASSWORD",
            "RELAY_POSTGRES_PASSWORD",
            "WORKER_POSTGRES_PASSWORD",
        ] {
            if env(key).is_none() {
                return Err(MigrateError::Usage(format!("set {key}")));
            }
        }
        let file = resolve_path(
            env("MOMO_RUNTIME_ROLES_SQL"),
            "infra/prod/bootstrap_runtime_roles.sql",
        );
        psql_file(&database_url, &file, "runtime-roles")?;
        println!("[migrate] runtime roles provisioned (no password printed)");
        return Ok(());
    }

    // (2) role posture gate. `1` (default) = this process also applies the
    // committed dev-password role file afterwards; `0` = the roles were
    // provisioned externally and must already be correct (prod).
    let bootstrap_roles = parse_flag(
        "MOMO_BOOTSTRAP_RUNTIME_ROLES",
        env("MOMO_BOOTSTRAP_RUNTIME_ROLES").as_deref(),
        true,
    )?;
    if !bootstrap_roles {
        assert_external_runtime_roles(&database_url)?;
    }

    // (3) migrations.
    let dir = migrations_dir();
    let discovered = discover_migrations(&dir)
        .map_err(|error| MigrateError::Failed(format!("migration discovery failed: {error}")))?;
    if discovered.is_empty() {
        return Err(MigrateError::Failed(format!(
            "no NNN_*.sql migrations under {} (set MOMO_MIGRATIONS_DIR)",
            dir.display()
        )));
    }
    let duplicates = duplicate_prefixes(&discovered);
    if !duplicates.is_empty() {
        return Err(MigrateError::Failed(format!(
            "duplicate migration number(s) {duplicates:?} in {} — \
             schema_migrations tracks filenames, so both would apply",
            dir.display()
        )));
    }

    println!("[migrate] directory: {}", dir.display());
    println!("[migrate] agent seed mode: {seed_mode:?}");
    let report = run_migrations(&database_url, &dir, seed_mode)
        .map_err(|error| MigrateError::Failed(format!("{error}")))?;
    for version in &report.applied {
        println!("  + APPLY {version}");
    }
    println!(
        "[migrate] (apply) applied={} skipped={} total={}",
        report.applied.len(),
        report.skipped.len(),
        report.total()
    );

    // (4) idempotency evidence in one run (`scripts/migrate.sh` MOMO-316): the
    // second pass shares the runner's skip judgement, so a violation is caught
    // here rather than on the next deploy.
    if parse_flag(
        "MIGRATE_IDEMPOTENCY_CHECK",
        env("MIGRATE_IDEMPOTENCY_CHECK").as_deref(),
        true,
    )? {
        let verify = run_migrations(&database_url, &dir, seed_mode)
            .map_err(|error| MigrateError::Failed(format!("verify pass: {error}")))?;
        if !verify.applied.is_empty() {
            return Err(MigrateError::Failed(format!(
                "IDEMPOTENCY_FAIL second-pass applied={} ({:?})",
                verify.applied.len(),
                verify.applied
            )));
        }
        println!(
            "[migrate] IDEMPOTENCY_OK second-pass applied=0 skipped={}",
            verify.skipped.len()
        );
    }

    // (5) local/e2e role file, after the schema exists (its GRANTs need tables).
    if bootstrap_roles {
        let file = resolve_path(
            env("MOMO_BOOTSTRAP_ROLES_SQL"),
            "infra/e2e/bootstrap_roles.sql",
        );
        psql_file(&database_url, &file, "bootstrap-roles")?;
        println!("[migrate] bootstrap roles applied (development passwords)");
    }
    Ok(())
}

/// `set-owner` — one-shot bootstrap owner credential takeover (MOMO-561).
/// Both values reach the SQL through `\getenv`; neither is echoed.
fn set_owner() -> Result<(), MigrateError> {
    let database_url = require_database_url()?;
    for key in ["MOMO_INITIAL_OWNER_EMAIL", "MOMO_INITIAL_OWNER_PASSWORD"] {
        if env(key).is_none() {
            return Err(MigrateError::Usage(format!("set {key}")));
        }
    }
    let file = resolve_path(
        env("MOMO_SET_OWNER_SQL"),
        "infra/prod/set_initial_owner.sql",
    );
    psql_file(&database_url, &file, "set-owner")?;
    println!("[migrate] bootstrap owner credentials updated (no value printed)");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_mode_maps_like_migrate_sh() {
        assert_eq!(parse_seed_mode(None), Ok(SeedMode::None));
        assert_eq!(parse_seed_mode(Some("none")), Ok(SeedMode::None));
        assert_eq!(parse_seed_mode(Some("demo")), Ok(SeedMode::Demo));
        assert_eq!(parse_seed_mode(Some(" e2e ")), Ok(SeedMode::E2e));
    }

    /// A typo must be exit 2 (`migrate.sh` exits 2 on the same input), not a
    /// silent fallback to `none` — the seed selection changes product data.
    #[test]
    fn an_unknown_seed_mode_is_a_usage_error() {
        let error = parse_seed_mode(Some("prod")).expect_err("must reject");
        assert_eq!(error.exit_code(), 2);
        assert!(error.to_string().contains("none, demo, e2e"));
    }

    #[test]
    fn flags_are_strictly_zero_or_one() {
        assert_eq!(parse_flag("X", None, true), Ok(true));
        assert_eq!(parse_flag("X", None, false), Ok(false));
        assert_eq!(parse_flag("X", Some("0"), true), Ok(false));
        assert_eq!(parse_flag("X", Some("1"), false), Ok(true));
        // "true"/"yes"/"" are rejected rather than read as on or off: a typo in
        // MOMO_BOOTSTRAP_RUNTIME_ROLES would otherwise skip the posture gate.
        for raw in ["true", "yes", "2", "off"] {
            let error = parse_flag("MOMO_BOOTSTRAP_RUNTIME_ROLES", Some(raw), true)
                .expect_err("must reject");
            assert_eq!(error.exit_code(), 1);
            assert!(error.to_string().contains("must be exactly 0 or 1"));
        }
    }

    #[test]
    fn paths_prefer_the_runtime_override() {
        assert_eq!(
            resolve_path(Some("/opt/momo/sql/roles.sql".to_string()), "infra/x.sql"),
            PathBuf::from("/opt/momo/sql/roles.sql")
        );
        let fallback = resolve_path(None, "infra/e2e/bootstrap_roles.sql");
        assert!(
            fallback.is_file(),
            "the compiled-in fallback must point at the repo file, got {}",
            fallback.display()
        );
    }

    /// The image sets `MOMO_MIGRATIONS_DIR`; unset falls back to the runner's
    /// own compile-time directory, which must be the real one.
    #[test]
    fn the_default_migrations_directory_is_the_repo_one() {
        assert!(default_migrations_dir().is_dir());
    }

    #[test]
    fn unknown_commands_and_stray_arguments_are_usage_errors() {
        let error = run(&["worker".to_string()]).expect_err("unknown command");
        assert_eq!(error.exit_code(), 2);
        let error = reject_extra_args("migrate", &["migrate".to_string(), "now".to_string()])
            .expect_err("stray argument");
        assert_eq!(error.exit_code(), 2);
        assert!(reject_extra_args("migrate", &["migrate".to_string()]).is_ok());
    }

    #[test]
    fn duplicate_numeric_prefixes_are_detected() {
        let migration = |version: i64, name: &str| Migration {
            version,
            name: name.to_string(),
            path: PathBuf::from(name),
        };
        assert!(
            duplicate_prefixes(&[migration(1, "001_init.sql"), migration(2, "002_seed.sql")])
                .is_empty()
        );
        assert_eq!(
            duplicate_prefixes(&[
                migration(1, "001_init.sql"),
                migration(2, "002_seed.sql"),
                migration(2, "002_other.sql"),
            ]),
            vec![2]
        );
    }

    /// The shipped migration set must itself be free of duplicate prefixes —
    /// the same assertion `scripts/check_migration_numbers.sh` makes before the
    /// shell runner connects, now enforced at `cargo test` time.
    #[test]
    fn the_shipped_migrations_have_unique_prefixes() {
        let migrations = discover_migrations(&default_migrations_dir()).expect("discover");
        assert!(!migrations.is_empty());
        assert_eq!(duplicate_prefixes(&migrations), Vec::<i64>::new());
    }
}
