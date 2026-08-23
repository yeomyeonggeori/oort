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
//! **#1227 — first-boot owner bootstrap.** The `migrate` command reads the same
//! two `MOMO_INITIAL_OWNER_*` variables the ops one-shot does (both compose
//! files already pass them to this service) and, when both carry a value,
//! finishes by applying `bootstrap_owner_if_absent.sql`. The two paths are
//! deliberately not the same write: `set-owner` is a *rotation* — always
//! overwrite, always revoke live sessions — while the boot-time one writes only
//! when there is no usable password to preserve, because it re-runs on every
//! `up -d`. Absent variables change nothing: migration 012's lock stands and the
//! stack stays unloginable, which is the fail-closed default rather than an
//! oversight (#1227 red proof).
//!
//! **#1651 / ADR-0166 — claim-token opt-in.** `MOMO_BOOTSTRAP_CLAIM=1` with
//! `MOMO_INITIAL_OWNER_EMAIL` (and *without* `MOMO_INITIAL_OWNER_PASSWORD`)
//! creates the owner as claim-pending and prints `MOMO_CLAIM_PATH=/claim/<token>`
//! once. The existing password path is unchanged. The two modes together are
//! exit 2.
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
//! A source checkout may override paths for focused fixtures. The production
//! image instead sets `MOMO_IN_CONTAINER=1`; in that mode migration/role/owner
//! paths are fixed `/opt/momo` payloads and every path override is rejected.
//! This prevents a dotenv value from turning the roles-only or owner commands
//! into an arbitrary pre-gate SQL execution seam.
//!
//! Exit codes (shell-wrapper parity): `0` success, `2` bad invocation or a
//! malformed `MOMO_AGENT_SEED_MODE`, `1` everything else (missing role posture,
//! a migration psql rejected, idempotency violation).

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use momo_db::migrate::{discover_migrations, run_migrations, Migration, SeedMode};

mod pitr;

/// Repo root relative to this crate: `server-rust/bins/momo-migrate` → `../../..`.
const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");
const IMAGE_RUNTIME_ENV: &str = "MOMO_IN_CONTAINER";

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

/// In a source checkout an explicit fixture override wins; otherwise use the
/// compiled-in repo-relative path. Image mode never calls this with an override.
fn resolve_path(override_value: Option<String>, repo_relative: &str) -> PathBuf {
    match override_value {
        Some(value) => PathBuf::from(value),
        None => PathBuf::from(format!("{REPO_ROOT}/{repo_relative}")),
    }
}

fn in_image_runtime() -> Result<bool, MigrateError> {
    match std::env::var_os(IMAGE_RUNTIME_ENV) {
        None => Ok(false),
        Some(value) if value == "1" => Ok(true),
        Some(_) => Err(MigrateError::Failed(format!(
            "{IMAGE_RUNTIME_ENV} must be exactly 1 when present"
        ))),
    }
}

fn select_runtime_path(
    in_image: bool,
    override_key: &str,
    override_value: Option<String>,
    repo_relative: &str,
    image_path: &str,
) -> Result<PathBuf, MigrateError> {
    if in_image {
        if override_value.is_some() {
            return Err(MigrateError::Failed(format!(
                "{override_key} must be unset in the production image"
            )));
        }
        return Ok(PathBuf::from(image_path));
    }
    Ok(resolve_path(override_value, repo_relative))
}

fn runtime_path(
    override_key: &str,
    repo_relative: &str,
    image_path: &str,
) -> Result<PathBuf, MigrateError> {
    // Presence is load-bearing in image mode: even an empty override is an
    // attempted policy mutation and must not be normalized into "unset".
    let raw_present = std::env::var_os(override_key).is_some();
    let override_value = if raw_present {
        Some(std::env::var(override_key).unwrap_or_default())
    } else {
        None
    };
    select_runtime_path(
        in_image_runtime()?,
        override_key,
        override_value,
        repo_relative,
        image_path,
    )
}

fn migrations_dir() -> Result<PathBuf, MigrateError> {
    runtime_path(
        "MOMO_MIGRATIONS_DIR",
        "server/Migrations",
        "/opt/momo/migrations",
    )
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

fn psql_scalar(database_url: &str, sql: &str, label: &str) -> Result<String, MigrateError> {
    let psql = resolve_psql()?;
    let output = Command::new(psql)
        .arg(database_url)
        .args(["-tA", "-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("-c")
        .arg(sql)
        .output()
        .map_err(|source| {
            MigrateError::Failed(format!("{label}: failed to spawn psql: {source}"))
        })?;
    if !output.status.success() {
        return Err(MigrateError::Failed(format!(
            "{label}: psql exited with {:?}",
            output.status.code()
        )));
    }
    let value = String::from_utf8(output.stdout)
        .map_err(|_| MigrateError::Failed(format!("{label}: psql emitted non-UTF-8 output")))?;
    let value = value.trim().to_string();
    if value.is_empty() || value.contains('\n') || value.contains('\r') {
        return Err(MigrateError::Failed(format!(
            "{label}: psql did not emit exactly one scalar value"
        )));
    }
    Ok(value)
}

/// Apply one repo SQL file through psql with the wrapper's flags. The
/// connection string is passed as the first positional argument (`migrate.sh`
/// parity); secrets inside the file come from the inherited environment via
/// `\getenv`, never from argv.
fn psql_file(database_url: &str, file: &Path, label: &str) -> Result<(), MigrateError> {
    psql_file_with_env(database_url, file, label, &[])
}

fn psql_file_with_env(
    database_url: &str,
    file: &Path,
    label: &str,
    extra_env: &[(&str, &str)],
) -> Result<(), MigrateError> {
    if !file.is_file() {
        return Err(MigrateError::Failed(format!(
            "{label}: SQL file not found at {}",
            file.display()
        )));
    }
    let psql = resolve_psql()?;
    let mut command = Command::new(psql);
    command
        .arg(database_url)
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("-f")
        .arg(file);
    for (key, value) in extra_env {
        command.env(key, value);
    }
    let status = command.status().map_err(|source| {
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
        let file = runtime_path(
            "MOMO_RUNTIME_ROLES_SQL",
            "infra/prod/bootstrap_runtime_roles.sql",
            "/opt/momo/sql/bootstrap_runtime_roles.sql",
        )?;
        psql_file(&database_url, &file, "runtime-roles")?;
        println!("[migrate] runtime roles provisioned (no password printed)");
        return Ok(());
    }

    // (2) Discover and bind the exact candidate migration bytes before any
    // migration or role-posture SQL.  Required PITR evidence is verified here;
    // a bad/missing/foreign proof cannot reach psql at all (the one exception
    // is the final live system_identifier comparison after its HMAC passes).
    let dir = migrations_dir()?;
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
    // This gate belongs only to the schema-changing `migrate` command. The
    // roles-only branch returned above, and `set-owner` has its own command
    // path below: rotating one credential neither applies SQL migrations nor
    // claims that the current schema has a fresh recovery proof.
    pitr::enforce_policy(&database_url, &discovered)?;

    // (3) role posture gate. `1` (default) = this process also applies the
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

    // (4) migrations.
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

    // (5) idempotency evidence in one run (`scripts/migrate.sh` MOMO-316): the
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

    // (6) local/e2e role file, after the schema exists (its GRANTs need tables).
    if bootstrap_roles {
        let file = runtime_path(
            "MOMO_BOOTSTRAP_ROLES_SQL",
            "infra/e2e/bootstrap_roles.sql",
            "/opt/momo/sql/bootstrap_roles.sql",
        )?;
        psql_file(&database_url, &file, "bootstrap-roles")?;
        println!("[migrate] bootstrap roles applied (development passwords)");
    }

    // (7) #1227 first-boot owner. Last, because it is the only step that cares
    // about product rows: 002 must have seeded the owner and 012 must already
    // have decided whether its password survives.
    bootstrap_owner(&database_url)
}

/// The two variables that name the first owner. `set-owner` requires them; the
/// `migrate` command treats them as an optional first-boot bootstrap.
const OWNER_ENV_KEYS: [&str; 2] = ["MOMO_INITIAL_OWNER_EMAIL", "MOMO_INITIAL_OWNER_PASSWORD"];
const CLAIM_ENV_KEY: &str = "MOMO_BOOTSTRAP_CLAIM";
/// Sealed with ADR-0166 / T-1. Must match `momo_auth::OWNER_CLAIM_TTL_SECONDS`.
const OWNER_CLAIM_TTL_SECONDS: i64 = 24 * 60 * 60;
const SEEDED_WORKSPACE_ID: &str = "00000000-0000-7000-8000-000000000001";
const SEEDED_OWNER_MEMBER_ID: &str = "00000000-0000-7000-8000-000000000101";

/// #1227 — the first-boot owner bootstrap that runs at the end of `migrate`.
///
/// Migration 012 nulls the seeded owner's publicly known `dev-password`, which
/// is right and which leaves a healthy stack nobody can log into. Before this,
/// the only exit was a *second*, separately documented command; a fresh
/// `up -d` could not produce a usable login no matter what the env file said.
///
/// Three outcomes, and the boring one is the point:
///   * neither variable set → **no write**, and a log line that names the fix.
///     Migration 012's lock stands: this is the fail-closed default.
///   * exactly one set → exit 2. A half-filled env file is a typo, and treating
///     it as "off" would lock the operator out with a green boot log.
///   * both set → apply `bootstrap_owner_if_absent.sql`, which writes only when
///     the owner has no usable password. Every later `up -d` is a no-op, so a
///     restart can neither reset a rotated password nor sign anyone out.
fn bootstrap_owner(database_url: &str) -> Result<(), MigrateError> {
    let email = env(OWNER_ENV_KEYS[0]);
    let password = env(OWNER_ENV_KEYS[1]);
    let claim = parse_flag(CLAIM_ENV_KEY, env(CLAIM_ENV_KEY).as_deref(), false)?;
    match plan_owner_bootstrap(email.as_deref(), password.as_deref(), claim)? {
        OwnerBootstrapPlan::Closed => {
            println!(
                "[migrate] no bootstrap owner requested — migration 012 keeps the seeded \
                 password locked and login is closed. Set {} and {} to open it \
                 (re-runs are no-ops); or set {}=1 with {} for a one-time claim URL. \
                 Rotate later with `migrate set-owner`.",
                OWNER_ENV_KEYS[0], OWNER_ENV_KEYS[1], CLAIM_ENV_KEY, OWNER_ENV_KEYS[0]
            );
            Ok(())
        }
        OwnerBootstrapPlan::Apply => {
            let file = runtime_path(
                "MOMO_BOOTSTRAP_OWNER_SQL",
                "infra/prod/bootstrap_owner_if_absent.sql",
                "/opt/momo/sql/bootstrap_owner_if_absent.sql",
            )?;
            // psql's NOTICE is the verdict and reaches the container log
            // directly: MOMO_BOOTSTRAP_OWNER=created|skipped|absent. Nothing
            // here echoes a value.
            psql_file(database_url, &file, "bootstrap-owner")?;
            println!(
                "[migrate] bootstrap owner reconciled (see MOMO_BOOTSTRAP_OWNER notice above)"
            );
            Ok(())
        }
        OwnerBootstrapPlan::Claim => {
            let email = email.ok_or_else(|| {
                MigrateError::Failed("claim plan selected without an email".to_string())
            })?;
            bootstrap_owner_claim(database_url, &email)
        }
    }
}

/// What [`bootstrap_owner`] does about the two variables, decided without
/// touching the process environment so the rule itself is testable.
#[derive(Debug, PartialEq, Eq)]
enum OwnerBootstrapPlan {
    /// No bootstrap requested — leave migration 012's lock in place.
    Closed,
    /// Both password values present: hand them to the only-if-absent SQL.
    Apply,
    /// Claim opt-in: email present, password absent, `MOMO_BOOTSTRAP_CLAIM=1`.
    Claim,
}

fn plan_owner_bootstrap(
    email: Option<&str>,
    password: Option<&str>,
    claim: bool,
) -> Result<OwnerBootstrapPlan, MigrateError> {
    match (email.is_some(), password.is_some(), claim) {
        (false, false, false) => Ok(OwnerBootstrapPlan::Closed),
        // #1234 retired the spelling guard that used to stand here. It refused a
        // mixed-case `MOMO_INITIAL_OWNER_EMAIL` because the address was stored
        // `lower(btrim(...))` while `verify_password_login` compared
        // `WHERE h.email = $2` verbatim — so `Owner@Example.com` was written and
        // then could never sign in, and refusing beat an unexplainable 401.
        //
        // That premise is now false. The login lookup normalises its own input
        // the same way (`h.email = lower(btrim($2))`) and migration 064 turns the
        // stored form into `human_email_normalized_ck` rather than a convention,
        // so every spelling of the operator's address resolves to the one row.
        // Keeping a fail-closed refusal whose stated reason no longer holds is
        // worse than no guard: it teaches the next reader something untrue about
        // the auth path and charges an env edit for nothing.
        (true, true, false) => Ok(OwnerBootstrapPlan::Apply),
        (true, false, true) => Ok(OwnerBootstrapPlan::Claim),
        (true, true, true) => Err(MigrateError::Usage(format!(
            "{CLAIM_ENV_KEY}=1 cannot be set together with {}",
            OWNER_ENV_KEYS[1]
        ))),
        (false, false, true) => Err(MigrateError::Usage(format!(
            "{CLAIM_ENV_KEY}=1 requires {}",
            OWNER_ENV_KEYS[0]
        ))),
        // A half-filled env file is a typo, and reading it as "off" would lock
        // the operator out behind a green boot log — the exact failure #1227
        // exists to remove. Exit 2, naming the key that is actually set.
        (present_email, _, _) => Err(MigrateError::Usage(format!(
            "{} and {} must be set together (only {} has a value)",
            OWNER_ENV_KEYS[0],
            OWNER_ENV_KEYS[1],
            OWNER_ENV_KEYS[usize::from(!present_email)]
        ))),
    }
}

fn mint_claim_token() -> Result<String, MigrateError> {
    let mut secret = [0_u8; 32];
    getrandom::getrandom(&mut secret).map_err(|error| {
        MigrateError::Failed(format!("claim token entropy unavailable: {error}"))
    })?;
    Ok(URL_SAFE_NO_PAD.encode(secret))
}

fn claim_plan_sql() -> String {
    format!(
        "SELECT CASE \
           WHEN NOT EXISTS ( \
             SELECT 1 FROM human h \
             JOIN member m ON m.id = h.member_id AND m.workspace_id = h.workspace_id \
             JOIN workspace_membership wm \
               ON wm.workspace_id = m.workspace_id AND wm.member_id = m.id AND wm.role = 'owner' \
            WHERE h.member_id = '{SEEDED_OWNER_MEMBER_ID}' \
              AND h.workspace_id = '{SEEDED_WORKSPACE_ID}' \
              AND m.kind = 'human' AND m.status = 'active' AND m.deleted_at IS NULL \
           ) THEN 'absent' \
           WHEN EXISTS ( \
             SELECT 1 FROM human h \
            WHERE h.member_id = '{SEEDED_OWNER_MEMBER_ID}' \
              AND h.workspace_id = '{SEEDED_WORKSPACE_ID}' \
              AND h.password_hash IS NOT NULL AND h.password_hash <> '' \
           ) THEN 'password' \
           WHEN EXISTS ( \
             SELECT 1 FROM owner_claim c \
            WHERE c.workspace_id = '{SEEDED_WORKSPACE_ID}' \
              AND c.member_id = '{SEEDED_OWNER_MEMBER_ID}' \
              AND c.consumed_at IS NULL \
              AND c.expires_at > now() \
           ) THEN 'live' \
           ELSE 'issue' \
         END \
         FROM (SELECT set_config('app.workspace_id', '{SEEDED_WORKSPACE_ID}', true)) AS guc"
    )
}

fn claim_plan(database_url: &str) -> Result<String, MigrateError> {
    psql_scalar(database_url, &claim_plan_sql(), "bootstrap-claim-plan")
}

fn bootstrap_owner_claim(database_url: &str, email: &str) -> Result<(), MigrateError> {
    match claim_plan(database_url)?.as_str() {
        "absent" => {
            println!("[migrate] bootstrap claim skipped — no active owner to adopt");
            println!("MOMO_BOOTSTRAP_CLAIM=absent");
            Ok(())
        }
        "password" => {
            println!("[migrate] bootstrap claim skipped — owner already has a password");
            println!("MOMO_BOOTSTRAP_CLAIM=skipped");
            Ok(())
        }
        "live" => {
            println!(
                "[migrate] bootstrap claim skipped — a live claim already exists (not reprinted)"
            );
            println!("MOMO_BOOTSTRAP_CLAIM=skipped");
            Ok(())
        }
        "issue" => {
            let token = mint_claim_token()?;
            let file = runtime_path(
                "MOMO_BOOTSTRAP_OWNER_CLAIM_SQL",
                "infra/prod/bootstrap_owner_claim_if_absent.sql",
                "/opt/momo/sql/bootstrap_owner_claim_if_absent.sql",
            )?;
            let ttl = OWNER_CLAIM_TTL_SECONDS.to_string();
            psql_file_with_env(
                database_url,
                &file,
                "bootstrap-owner-claim",
                &[
                    (OWNER_ENV_KEYS[0], email),
                    ("MOMO_BOOTSTRAP_CLAIM_TOKEN", &token),
                    ("MOMO_OWNER_CLAIM_TTL_SECONDS", &ttl),
                ],
            )?;
            println!("[migrate] bootstrap claim issued");
            println!("MOMO_BOOTSTRAP_CLAIM=created");
            println!("MOMO_CLAIM_PATH=/claim/{token}");
            Ok(())
        }
        other => Err(MigrateError::Failed(format!(
            "unexpected claim plan: {other}"
        ))),
    }
}

/// `set-owner` — one-shot bootstrap owner credential takeover (MOMO-561).
/// Both values reach the SQL through `\getenv`; neither is echoed.
/// Intentionally outside #1330's PITR gate: this rotates an operator secret but
/// cannot apply or discover a schema migration.
fn set_owner() -> Result<(), MigrateError> {
    let database_url = require_database_url()?;
    for key in OWNER_ENV_KEYS {
        if env(key).is_none() {
            return Err(MigrateError::Usage(format!("set {key}")));
        }
    }
    let file = runtime_path(
        "MOMO_SET_OWNER_SQL",
        "infra/prod/set_initial_owner.sql",
        "/opt/momo/sql/set_initial_owner.sql",
    )?;
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

    /// #1227. Absent variables must be a no-op, not a write: that is the
    /// fail-closed default migration 012 establishes, and the red proof asserts
    /// a stack booted without them still refuses every login.
    #[test]
    fn an_unset_owner_environment_leaves_the_lock_in_place() {
        assert_eq!(
            plan_owner_bootstrap(None, None, false),
            Ok(OwnerBootstrapPlan::Closed)
        );
    }

    #[test]
    fn both_owner_variables_request_the_only_if_absent_write() {
        assert_eq!(
            plan_owner_bootstrap(Some("owner@example.com"), Some("s3cret"), false),
            Ok(OwnerBootstrapPlan::Apply)
        );
    }

    #[test]
    fn claim_opt_in_with_email_and_no_password_is_the_claim_plan() {
        assert_eq!(
            plan_owner_bootstrap(Some("owner@example.com"), None, true),
            Ok(OwnerBootstrapPlan::Claim)
        );
    }

    #[test]
    fn claim_and_password_together_are_a_usage_error() {
        let error = plan_owner_bootstrap(Some("owner@example.com"), Some("s3cret"), true)
            .expect_err("must reject");
        assert_eq!(error.exit_code(), 2);
        assert!(error.to_string().contains(CLAIM_ENV_KEY));
        assert!(error.to_string().contains(OWNER_ENV_KEYS[1]));
    }

    #[test]
    fn claim_without_email_is_a_usage_error() {
        let error = plan_owner_bootstrap(None, None, true).expect_err("must reject");
        assert_eq!(error.exit_code(), 2);
        assert!(error.to_string().contains(OWNER_ENV_KEYS[0]));
    }

    /// Half-filled is the dangerous case: silently treating it as "off" would
    /// hand the operator a green boot log and no way in.
    #[test]
    fn a_half_filled_owner_environment_is_a_usage_error() {
        let missing_password =
            plan_owner_bootstrap(Some("owner@example.com"), None, false).expect_err("must reject");
        assert_eq!(missing_password.exit_code(), 2);
        assert!(missing_password
            .to_string()
            .contains("only MOMO_INITIAL_OWNER_EMAIL has a value"));

        let missing_email =
            plan_owner_bootstrap(None, Some("s3cret"), false).expect_err("must reject");
        assert_eq!(missing_email.exit_code(), 2);
        assert!(missing_email
            .to_string()
            .contains("only MOMO_INITIAL_OWNER_PASSWORD has a value"));
    }

    /// #1234 inverted this case. It used to be exit 2 ("type it lowercase"),
    /// because the address was stored `lower(btrim(...))` while the login lookup
    /// compared verbatim — measured 2026-08-10 against the built image: the owner
    /// row existed and the login 401'd.
    ///
    /// The lookup now normalises its input (`h.email = lower(btrim($2))`) and
    /// migration 064 enforces the stored form, so every spelling reaches the same
    /// row. Accepting is therefore the honest answer, and the operator is spared
    /// an env edit that no longer buys anything. The end-to-end proof — boot with
    /// `Owner@Example.COM`, then log in with it — is phase 5b of
    /// `scripts/verify_owner_bootstrap_rust.sh`.
    #[test]
    fn any_spelling_of_the_owner_email_is_accepted_now_that_the_lookup_normalises() {
        for spelling in [
            "Owner@Example.com",
            " owner@example.com",
            "owner@example.com ",
        ] {
            assert_eq!(
                plan_owner_bootstrap(Some(spelling), Some("s3cret"), false),
                Ok(OwnerBootstrapPlan::Apply),
                "{spelling:?} must boot, not be refused"
            );
        }
    }

    /// The boot-time bootstrap and the ops rotation must stay two files: one
    /// preserves an existing password, the other deliberately replaces it.
    #[test]
    fn the_owner_sql_files_are_distinct_and_present() {
        let bootstrap = resolve_path(None, "infra/prod/bootstrap_owner_if_absent.sql");
        let rotate = resolve_path(None, "infra/prod/set_initial_owner.sql");
        assert!(bootstrap.is_file(), "{}", bootstrap.display());
        assert!(rotate.is_file(), "{}", rotate.display());
        assert_ne!(bootstrap, rotate);

        let bootstrap_sql = std::fs::read_to_string(&bootstrap).expect("read bootstrap sql");
        // The guard is the whole contract: without it a routine `up -d` would
        // overwrite a rotated password on every restart.
        assert!(
            bootstrap_sql.contains("h.password_hash IS NULL OR h.password_hash = ''"),
            "the boot-time file must only write when no usable password exists"
        );
        assert!(
            !bootstrap_sql.contains("UPDATE token"),
            "a restart must never revoke live sessions"
        );
        let rotate_sql = std::fs::read_to_string(&rotate).expect("read rotate sql");
        assert!(
            rotate_sql.contains("UPDATE token"),
            "the deliberate rotation must still revoke live sessions"
        );

        let claim = resolve_path(None, "infra/prod/bootstrap_owner_claim_if_absent.sql");
        assert!(claim.is_file(), "{}", claim.display());
        let claim_sql = std::fs::read_to_string(&claim).expect("read claim sql");
        assert!(
            claim_sql.contains("digest(claim_token, 'sha256')"),
            "claim bootstrap must hash the token inside Postgres"
        );
        assert!(
            claim_sql.contains("RAISE NOTICE 'MOMO_BOOTSTRAP_CLAIM=created'"),
            "claim bootstrap reports created without interpolating the token"
        );
        assert!(
            !claim_sql.contains("NOTICE '%', claim_token")
                && !claim_sql.contains("RAISE NOTICE '%', claim_token"),
            "NOTICE must not interpolate the raw token"
        );
        assert!(
            claim_sql.contains("SELECT i.email, i.token, i.ttl_seconds"),
            "#1673: SELECT INTO columns must be table-qualified; PL/pgSQL ttl_seconds collides with the column"
        );
        assert!(
            claim_sql.contains("FROM momo_bootstrap_claim_input i"),
            "#1673: table alias required so SELECT INTO is not ambiguous"
        );
        assert!(
            !claim_sql.contains("SELECT email, token, ttl_seconds"),
            "#1673: unqualified SELECT INTO of ttl_seconds is ambiguous in PL/pgSQL"
        );
        assert_eq!(OWNER_CLAIM_TTL_SECONDS, 24 * 60 * 60);
    }

    #[test]
    fn a_minted_claim_token_is_32_bytes_of_url_safe_base64() {
        let token = mint_claim_token().expect("entropy");
        assert_eq!(token.len(), 43);
        assert!(token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
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

    #[test]
    fn production_image_paths_are_fixed_and_overrides_are_rejected() {
        assert_eq!(
            select_runtime_path(
                true,
                "MOMO_RUNTIME_ROLES_SQL",
                None,
                "infra/prod/bootstrap_runtime_roles.sql",
                "/opt/momo/sql/bootstrap_runtime_roles.sql",
            ),
            Ok(PathBuf::from("/opt/momo/sql/bootstrap_runtime_roles.sql"))
        );
        for value in ["/tmp/attacker.sql", ""] {
            let error = select_runtime_path(
                true,
                "MOMO_RUNTIME_ROLES_SQL",
                Some(value.to_string()),
                "infra/prod/bootstrap_runtime_roles.sql",
                "/opt/momo/sql/bootstrap_runtime_roles.sql",
            )
            .expect_err("image override must fail closed");
            assert!(error.to_string().contains("must be unset"));
        }
    }

    /// A source checkout falls back to the runner's own compile-time directory,
    /// which must be the real one. Image mode uses fixed `/opt/momo/migrations`.
    #[test]
    fn the_default_migrations_directory_is_the_repo_one() {
        assert!(momo_db::migrate::default_migrations_dir().is_dir());
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
        let migrations =
            discover_migrations(&momo_db::migrate::default_migrations_dir()).expect("discover");
        assert!(!migrations.is_empty());
        assert_eq!(duplicate_prefixes(&migrations), Vec::<i64>::new());
    }
}
