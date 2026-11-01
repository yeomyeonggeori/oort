//! Migration runner — applies the existing 69 SQL files **in place, unmodified**
//! via `psql`, matching `scripts/migrate.sh` (L4 §8.7 canonical mechanism).
//!
//! ADR-0145 / D2 §3: the 69 migrations under `server/Migrations/NNN_*.sql` are
//! Postgres DDL, language independent, and are the enforcement layer we inherit.
//!
//! **Why psql, not `sqlx::raw_sql`.** Several seed migrations (002/006/012) use
//! psql *client* meta-commands — `\if :MOMO_AGENT_SEED_ENABLED … \else … \endif`
//! — which the wire protocol does not understand. Sending those files straight
//! to the server (as `sqlx::raw_sql` did) fails at the first `\if` with
//! `42601 syntax error at "\"`. psql is already the canonical migration
//! dependency (§8.7 / `scripts/migrate.sh`), so this is no new dependency; we
//! shell out to it and never reimplement its meta-command handling.
//!
//! This runner discovers the files, orders them by their numeric `NNN` prefix,
//! and applies each with `psql <conn> -v ON_ERROR_STOP=1
//! -v MOMO_AGENT_SEED_ENABLED=<0|1> --no-psqlrc --quiet --single-transaction -f`
//! — the exact flags `migrate.sh` uses. It never edits, copies, or reorders a
//! file (hard rule). `schema_v0.sql` is a duplicate snapshot of `001` and is
//! intentionally NOT under this directory, so it is never a target.
//!
//! **Idempotent `schema_migrations` tracking (B1.6).** The runner reproduces
//! `scripts/migrate.sh`'s skip judgement (`migrate.sh:102-143`) measured
//! one-for-one:
//!   * the tracking table is the *runner's*, not a migration's — no file under
//!     `server/Migrations/` creates `schema_migrations` (007 only mentions it in
//!     a comment), so `migrate.sh:104-109` issues the `CREATE TABLE IF NOT
//!     EXISTS` itself and so does [`run_migrations`];
//!   * `version` is the **full filename** including the `NNN_` prefix and the
//!     `.sql` extension (`version=$(basename "$f")`, :122) — which is why
//!     `scripts/check_migration_numbers.sh` exists: two files sharing a numeric
//!     prefix would both apply;
//!   * a version already present → `SKIP`; only a new one is applied, and the
//!     file plus its `INSERT INTO schema_migrations` go in **one**
//!     `--single-transaction` psql invocation (:137-139), so a half-applied
//!     migration can never be recorded as done.
//!
//! Consequence for the test harnesses: a second run against an already-migrated
//! database is a no-op ([`MigrationReport::applied`] empty), so conformance
//! binaries may share one database instead of each needing a throwaway one.
//! `migrate.sh`'s in-process verify pass (:150-158) is deliberately NOT
//! duplicated here — the `momo-db` conformance test runs the runner twice for
//! real, which is the stronger form of the same evidence.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::DbError;

/// Agent-seed selection, mapped exactly as `scripts/migrate.sh` maps
/// `MOMO_AGENT_SEED_MODE` → `MOMO_AGENT_SEED_ENABLED` (`none`→0, `demo`/`e2e`→1).
/// The seed migrations gate their product-data fixtures on this psql variable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SeedMode {
    /// Product default — no legacy agent fixtures (`MOMO_AGENT_SEED_ENABLED=0`).
    #[default]
    None,
    /// Deterministic demo fixtures (`=1`).
    Demo,
    /// Deterministic e2e fixtures (`=1`).
    E2e,
}

impl SeedMode {
    /// The `0|1` value passed to psql as `-v MOMO_AGENT_SEED_ENABLED=<v>`.
    fn enabled_flag(self) -> &'static str {
        match self {
            SeedMode::None => "0",
            SeedMode::Demo | SeedMode::E2e => "1",
        }
    }
}

/// One discovered migration file. `version` is the parsed `NNN` prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Migration {
    pub version: i64,
    pub name: String,
    pub path: PathBuf,
}

/// The canonical migrations directory, resolved relative to this crate at
/// compile time: `server-rust/crates/momo-db` → repo root → `server/Migrations`.
pub fn default_migrations_dir() -> PathBuf {
    PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../server/Migrations"
    ))
}

/// Discover and order the migration files in `dir` by numeric prefix.
///
/// Files without an `NNN_` integer prefix (e.g. a stray `schema_v0.sql`) are
/// skipped, so the runner is robust to non-migration `.sql` siblings.
pub fn discover_migrations(dir: &Path) -> Result<Vec<Migration>, DbError> {
    let entries = std::fs::read_dir(dir).map_err(|source| DbError::MigrationIo {
        path: dir.display().to_string(),
        source,
    })?;

    let mut migrations = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| DbError::MigrationIo {
            path: dir.display().to_string(),
            source,
        })?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("sql") {
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| DbError::MigrationName(path.display().to_string()))?;

        // Expect `<version>_<description>.sql`. A missing numeric prefix means
        // this is not a versioned migration (skip, don't error).
        let Some((prefix, _rest)) = file_name.split_once('_') else {
            continue;
        };
        let Ok(version) = prefix.parse::<i64>() else {
            continue;
        };
        migrations.push(Migration {
            version,
            name: file_name.to_string(),
            path,
        });
    }

    migrations.sort_by_key(|m| m.version);
    Ok(migrations)
}

/// Locate the `psql` binary. Mirrors `migrate.sh`: PATH first (`command -v
/// psql`), then the Homebrew keg-only libpq locations.
fn resolve_psql() -> Option<PathBuf> {
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("psql");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for candidate in [
        "/opt/homebrew/opt/libpq/bin/psql",
        "/usr/local/opt/libpq/bin/psql",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// The tracking table `scripts/migrate.sh:104-109` creates before its first
/// skip judgement. No migration file owns it, so the runner must.
const SCHEMA_MIGRATIONS_DDL: &str = "CREATE TABLE IF NOT EXISTS schema_migrations (\
   version     text PRIMARY KEY, \
   applied_at  timestamptz NOT NULL DEFAULT now() \
 )";

/// What one [`run_migrations`] call did, in file order. The counts are the
/// runner's own `applied`/`skipped` tally (`migrate.sh:142`), and the pair is
/// what makes idempotency assertable: a second run must report
/// `applied.is_empty()`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationReport {
    /// Versions (filenames) this call applied and recorded.
    pub applied: Vec<String>,
    /// Versions already present in `schema_migrations` and therefore skipped.
    pub skipped: Vec<String>,
}

impl MigrationReport {
    /// Every version the runner considered, applied or skipped.
    pub fn total(&self) -> usize {
        self.applied.len() + self.skipped.len()
    }
}

/// Escape a SQL string literal (double any single quote). Versions are
/// filenames from disk, never user input, but a quoted literal is built here so
/// the runner cannot be surprised by a pathological filename.
fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// One psql invocation with the flags `migrate.sh` uses on every call
/// (`PSQL_FLAGS`, :100): stop on the first error, pass the seed variable, no
/// psqlrc, quiet.
fn psql_command(psql: &Path, database_url: &str, seed_flag: &str) -> Command {
    let mut command = Command::new(psql);
    // Connection URI as the first positional arg, like migrate.sh
    // (`$PSQL_BIN ${DATABASE_URL}`).
    command
        .arg(database_url)
        .args(["-v", "ON_ERROR_STOP=1"])
        .args(["-v", seed_flag])
        .arg("--no-psqlrc")
        .arg("--quiet");
    command
}

/// Has `version` already been applied? Mirrors `migrate.sh:125-127`, including
/// its tolerance: a failed probe (`|| true`) is read as "not applied", so the
/// error surfaces on the apply attempt with the offending file named.
fn is_applied(
    psql: &Path,
    database_url: &str,
    seed_flag: &str,
    version: &str,
) -> Result<bool, DbError> {
    let output = psql_command(psql, database_url, seed_flag)
        .arg("-tA")
        .arg("-c")
        .arg(format!(
            "SELECT 1 FROM schema_migrations WHERE version = {};",
            sql_literal(version)
        ))
        .output()
        .map_err(|source| DbError::PsqlSpawn {
            psql: psql.display().to_string(),
            source,
        })?;
    if !output.status.success() {
        return Ok(false);
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim() == "1")
}

/// Apply every not-yet-applied migration in order against `database_url` via
/// `psql`, recording each in `schema_migrations`.
///
/// Idempotent by the same judgement `scripts/migrate.sh` uses: already-applied
/// versions are skipped, only new ones are applied, and the file plus its
/// history row commit together in ONE `--single-transaction` psql invocation
/// (`migrate.sh:137-139`) — so an interrupted migration is never recorded as
/// done and simply re-applies on the next run. psql (not `sqlx::raw_sql`)
/// interprets the seed files' backslash meta-commands (`\if`, `\set`, …);
/// `seed_mode` selects the agent-seed fixtures (default [`SeedMode::None`] =
/// disabled).
///
/// Returns [`DbError::PsqlNotFound`] if no psql client is installed, and
/// [`DbError::MigrationFailed`] with the offending file + exit code on the first
/// migration psql rejects.
pub fn run_migrations(
    database_url: &str,
    dir: &Path,
    seed_mode: SeedMode,
) -> Result<MigrationReport, DbError> {
    let psql = resolve_psql().ok_or(DbError::PsqlNotFound)?;
    let seed_flag = format!("MOMO_AGENT_SEED_ENABLED={}", seed_mode.enabled_flag());

    // The tracking table belongs to the runner (no migration creates it).
    let status = psql_command(&psql, database_url, &seed_flag)
        .arg("-c")
        .arg(SCHEMA_MIGRATIONS_DDL)
        .status()
        .map_err(|source| DbError::PsqlSpawn {
            psql: psql.display().to_string(),
            source,
        })?;
    if !status.success() {
        return Err(DbError::MigrationFailed {
            version: "schema_migrations (tracking table)".to_string(),
            code: status.code(),
        });
    }

    let mut report = MigrationReport::default();
    for migration in discover_migrations(dir)? {
        if is_applied(&psql, database_url, &seed_flag, &migration.name)? {
            report.skipped.push(migration.name);
            continue;
        }

        // The file and its history row are one transaction: psql runs `-f` and
        // `-c` in the order given, under a single `--single-transaction`.
        let status = psql_command(&psql, database_url, &seed_flag)
            .arg("--single-transaction")
            .arg("-f")
            .arg(&migration.path)
            .arg("-c")
            .arg(format!(
                "INSERT INTO schema_migrations (version) VALUES ({});",
                sql_literal(&migration.name)
            ))
            .status()
            .map_err(|source| DbError::PsqlSpawn {
                psql: psql.display().to_string(),
                source,
            })?;

        if !status.success() {
            return Err(DbError::MigrationFailed {
                version: migration.name,
                code: status.code(),
            });
        }
        report.applied.push(migration.name);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Structural conformance without a DB: the on-disk migration set is exactly
    /// 001..=064, contiguous, correctly ordered, and starts at `001_init`.
    ///
    /// The count is asserted rather than derived on purpose: it is what makes a
    /// **second** file claiming a taken prefix, or a file dropped from the
    /// directory, fail here rather than at deploy time. A new migration
    /// therefore lands with this number bumped, deliberately — a test that
    /// counted whatever it found would have nothing to say. (Two parallel
    /// branches both claiming 061 is exactly what it caught this time.)
    ///
    /// 060 is ADR-0146's `action_signature` sidecar — the first migration this
    /// rewrite added rather than inherited (B2.5). 061 is ADR-0125 D6-A's
    /// per-member last-used host (#1114), the second. 062 is 이슈 #1112's
    /// `message_pin`. 063 is 이슈 #1204's event-subscription delivery audit —
    /// the write helper the outbound webhook path calls once a payload has
    /// actually left for an external host. 064 is 이슈 #1234's
    /// `human_email_normalized_ck` — the constraint that lets the login lookup
    /// normalise only its input and still reach every stored address. 065 is 이슈
    /// #1252's `human_email_norm_uniq` — the same address uniqueness, said by the
    /// uniqueness constraint itself instead of borrowed from 064's CHECK. 066 is
    /// ADR-0124 증보 1's `notification_rule` — the user-editable half of the
    /// notifier's decision tree. 067 is ADR-0161 D5's `workspace_avatar_media` —
    /// the attachment lifecycle re-aimed at a workspace (avatar upload/complete +
    /// `workspace.avatar_media_id`). 068 is ADR-0160 ③'s `member.presence_status`
    /// — the durable declared-presence column (사용자 프레즌스 6b), the first the
    /// presence feature added.
    ///
    /// 066/067/068 are the collision this test's own docstring predicted: three
    /// parallel batches of the same review round each claimed the next free
    /// number, and every one after the first renumbered on rebase rather than
    /// leaving a gap. That is the intended resolution — the contiguity assertion
    /// below is what forces it to be noticed at all, and it is what caught this
    /// one: presence was authored as 066 against a tree where 065 was the head.
    ///
    /// 069/070/071/072 are the ADR-0162 hosted Agent Port wave: the pairing
    /// ledger (HAP-E3), the connection-scoped inbox projection (HAP-E4), the
    /// kind-inclusive outbox reference plus the job↔run binding trigger that
    /// make a hosted inbox reference impossible to aim at the wrong outbox kind
    /// or at another piece of work (HAP-E5), and — closing the wave — HAP-E6's
    /// cleanup manifest, where the disconnect's per-artifact rows and the
    /// terminal-state trigger live.
    ///
    /// 073 is that wave's hygiene follow-up (#1375, #1386): the ledger's delete
    /// surface and the disconnect's two unguarded doors — an INSERT that
    /// arrives already terminal, and leaving the terminal at all.
    ///
    /// 074 is ADR-0162 증보 1's `hosted_agent_oauth` (HAP-E7): the OAuth 2.1
    /// authorization-request ledger, the two OAuth hosted credential classes,
    /// and the trigger that makes a credential class and its connection's
    /// `auth_mode` agree — which is where the "no bearer downgrade" invariant
    /// stops being a convention. It is the wave's second numbering collision
    /// (see 066/067/068 above): the hygiene batch above and this one each
    /// claimed 073 in parallel, so whichever landed second — this one —
    /// renumbered to 074 on rebase rather than leaving a gap, and this
    /// assertion is what forced that to be noticed.
    ///
    /// 075 is ADR-0165's `display_attach` (LIVE-1): the session's display
    /// binding beside its PTY one, and `terminal_attach_capability.kind`. Its
    /// last CHECK is the one worth naming here —
    /// `terminal_attach_display_observer_ck` makes a *controllable* display
    /// capability unrepresentable, which is how the ADR-0004 증보 3 boundary is
    /// held by the schema rather than by a route somebody could rewrite.
    ///
    /// 076 is LIVE-3's `display_control_window` — that same CHECK removed by the
    /// decision it was waiting for, and the ledger that took its place.
    ///
    /// 077 is LIVE-5a's `prior_observation` on that ledger: opening control
    /// closes the session to teammates, and the window carries the value it
    /// displaced so the close can put back what the owner had chosen rather than
    /// guessing at a default.
    ///
    /// 078 is ADR-0166 T-1's `owner_claim`: first-owner bootstrap token hash
    /// plus TTL plus single-use `consumed_at`. The raw token never lands here.
    ///
    /// 079 is ADR-0170's `message_unfurl` sidecar (job + cache + tombstone +
    /// workspace on/off). Derived records — `schema_v0.sql` is not modified.
    ///
    /// 080 is ADR-0171's hosted-connection doorbell sidecar. No outbox producer
    /// trigger — the sender polls `hosted_agent_inbox_counter`.
    ///
    /// 081 is #1767's `credential_claim`: 078's owner_claim generalized with
    /// `kind` (`owner_bootstrap` | `password_reset`). Same hash/TTL/single-use
    /// / definer lookup. schema_v0.sql is not modified.
    ///
    /// 082 is ADR-0175's `message_reminder` (#1888 BF-B1 server half): owner-
    /// scoped personal later-alert rows. schema_v0.sql is not modified; v1 has
    /// no outbox fan-out.
    ///
    /// 083 is ADR-0176's custom member status (#1889 BF-B2 server half): three
    /// nullable columns on `member` (`status_emoji`/`status_text`/
    /// `status_expires_at`) riding the existing presence write path. schema_v0.sql
    /// is not modified; expiry is lazy-on-read, no sweeper.
    ///
    /// 084 is ADR-0177's `member_sidebar_prefs` (#1932 BT-4 server half): one
    /// JSONB blob per (workspace, member) holding that member's custom sidebar
    /// sections, channel placement and stars. `ws_isolation` RLS as D2 names;
    /// schema_v0.sql is not modified; no outbox fan-out.
    ///
    /// 085 is ADR-0178's mark-unread signal (#1934 BT-6 server half): nullable
    /// `read_state.marked_unread_before_seq`. schema_v0.sql is not modified;
    /// last_read_seq GREATEST is unchanged.
    ///
    /// 086 is ADR-0180's `device_link_token` (#1959 M0s): hash-only QR link
    /// tokens, SAS hold, and nullable `token.device_label`/`pending_sas`.
    /// schema_v0.sql is not modified.
    ///
    /// 087 is ADR-0186 D2's `workspace:propose` (#2508 AX-3a): the hosted scope
    /// vocabulary gains a seventh value, so the three CHECK constraints that
    /// enumerate it are rewritten (`hosted_agent_connection_scopes_ck`,
    /// `token_hosted_binding_ck`, `hosted_oauth_request_scope_ck`). No table,
    /// column or index is added; schema_v0.sql is not modified.
    ///
    /// 088 is #2677's push session lineage: nullable `token.session_id` (shared
    /// by a sign-in's pair, inherited on rotation) and `push_token.session_id`
    /// (the session a registration was made under), plus one partial index. A
    /// session that ends invalidates its registrations; the judgment SQL and the
    /// notifier's grants are unchanged. schema_v0.sql is not modified.
    ///
    /// 089 is #2815's subscription-agent scope (ADR-0193 D4): `agent`
    /// gains `invocation_scope` (`workspace` | `owner_only`) and
    /// `subscription_harness`, a shape CHECK, and a trigger that makes
    /// `owner_only` final. `agent` stays under its existing FORCE RLS policy; no
    /// table or policy is added. schema_v0.sql is not modified.
    ///
    /// 090 is #2850's notification pause expiry and DND bundle (ADR-0124 증보
    /// 2): `notification_rule` gains `dnd_until` and the bundle memory
    /// (`presence_prev_dnd`, `presence_prev_dnd_until`), `member` gains
    /// `presence_dnd_until`; only the bundle memory carries a shape CHECK (the
    /// expiry columns carry none so a rolled-back v0.1.10 can still clear DND
    /// and the pause). Both tables stay under
    /// their existing FORCE RLS policy; no table or policy is added.
    /// schema_v0.sql is not modified.
    ///
    /// 091 is #2915's hosted 1:1 DM approval (ADR-0162 증보 2):
    /// `hosted_agent_connection.approved_dm_channel_ids` and the SECURITY
    /// INVOKER function `hosted_connection_channel_ids`, the one definition of
    /// "the rooms this connection covers". The table stays under its existing
    /// FORCE RLS policy; no table or policy is added. schema_v0.sql is not
    /// modified.
    ///
    /// 092 is #3000's permission bridge (ADR-0188 D5 §8.6):
    /// `work_permission_request` (one row per ACP permission request a member
    /// host relayed, keyed by its `approval.requested` event id; ENABLE + FORCE
    /// RLS + `ws_isolation`) and the `permission` kind on `work_control`
    /// (`work_control_kind_ck` and `work_control_payload_ck` rewritten, 029's
    /// arms unchanged, plus a unique index of one decision per request).
    /// schema_v0.sql is not modified.
    ///
    /// 093 is #3009's 「기본 AI」 team rows (ADR-0147 증보 2026-09-28):
    /// `provider_default_ai`, instance-global like `provider_link` (no
    /// `workspace_id`), ENABLE + FORCE RLS behind the `app.provider_link_admin`
    /// operator GUC, `credential_source` CHECKed to `team_link`.
    /// schema_v0.sql is not modified.
    ///
    /// 094 is #3022's device signing keys (ADR-0146 개정 2026-09-28 R2-E2):
    /// `member_device_key` (a person's P-256 key bound to the session lineage
    /// it was registered under, with its endorsement and revocation letters;
    /// ENABLE + FORCE RLS + `ws_isolation`) and `action_signature.alg` with a
    /// per-algorithm public-key CHECK. Re-runnable statements.
    /// schema_v0.sql is not modified.
    ///
    /// 095 is #3023's signed-control half (ADR-0146 개정 2026-09-28 R2-E3):
    /// `human_control_nonce` (one-time `momo.human.control.v1` nonces; ENABLE +
    /// FORCE RLS + `ws_isolation`) and the `work_control` signature columns
    /// with an all-or-none, per-kind CHECK. `work_control_payload_ck` is not
    /// changed. Re-runnable statements. schema_v0.sql is not modified.
    ///
    /// 096 is #3079's refresh-token sender constraint (ADR-0146 D-7 증보):
    /// `session_refresh_key` (one refresh-proof key per session lineage) and
    /// `refresh_proof_nonce` (one-time proof nonces), both ENABLE + FORCE RLS
    /// + `ws_isolation`. Re-runnable statements. schema_v0.sql is not modified.
    ///
    /// 097 is #3118's permission preview (ADR-0146 증보 R2 H1): nullable
    /// `work_permission_request.preview` / `preview_sha256` with a both-or-none
    /// CHECK. No table or policy is added. Re-runnable statements.
    /// schema_v0.sql is not modified.
    ///
    /// 098 is #3147's `agent.model_source` (ADR-0147 증보 2026-09-29): where an
    /// agent's model comes from, `agent` | `instance_default`, with a one-time
    /// backfill of the seed placeholder. No table or policy is added.
    ///
    /// 099 is #3167's drop of the first-generation Memory Plane (ADR-0196 D11):
    /// 027/028/030/035 tables, function, workspace consent columns and the
    /// audit unique index. No table or policy is added. The `vector`
    /// extension stays for team memory v2. schema_v0.sql is not modified.
    ///
    /// 100 is #3161's team-memory M1 schema (ADR-0196 D3/D6/D7/D9):
    /// `mem_digest`, `mem_evidence`, `mem_cursor`, `mem_serving`, `mem_settings`
    /// (all ENABLE + FORCE RLS, per-command policies) and the SQL functions
    /// `mem_can_read_channel` / `mem_can_read_channels`. Re-runnable statements.
    /// schema_v0.sql is not modified.
    ///
    /// 101 is #3186's mem_* lockdown hardening (no schema objects): momo_app
    /// loses TRUNCATE/REFERENCES/TRIGGER on `mem_settings`, PUBLIC ACLs and
    /// runtime-role `mem_definer` membership are revoked, views/matviews are
    /// walked, plus membership and SECURITY DEFINER allow-list self-checks.
    /// 102 is #3162's summary-worker surface (ADR-0196 D4/D6/D10): the tenant table
    /// `mem_usage` (ENABLE + FORCE RLS), worker-only read functions, the daily token budget
    /// functions, the message edit/delete trigger that marks dependent digests stale (security
    /// review L-2) and a `mem_apply_digest` that serialises with it. Re-runnable statements.
    /// 103 is #3163's serving surface (`mem_serve_requester`, `mem_serve_candidates`).
    /// 104 is #3168's items (ADR-0196 D3/D4/D5/D6): `mem_item` + `mem_event` (both ENABLE + FORCE
    /// RLS; the event log is append-only), the FK on `mem_evidence.item_id`, the add-only write
    /// function `mem_add_item` (momo_memory only), the read helpers and audience rule, and the
    /// pg_trgm keyword search.
    /// 105 is #3169's item serving and 「기억해 둘게요」 proposals: `mem_proposal` (ENABLE + FORCE RLS),
    /// `mem_serve_items`, the stricter `mem_record_serving`, `mem_propose_item` (momo_memory only) and
    /// the API-side `mem_accept_proposal` / `mem_reject_proposal`.
    /// 106 is #3208's memory-browser writes (ADR-0196 D9/D10): the API-callable definer functions
    /// `mem_edit_item` (new curated item supersedes the old, evidence kept) and `mem_forget_item`
    /// (permanent delete of the item, its older versions and dead twins), `mem_suppress` (hash-only
    /// re-extraction suppression) with its insert trigger and the suppression checks in
    /// `mem_accept_proposal`/`mem_propose_item`, plus the narrow `mem_definer` privilege widening
    /// (UPDATE of `retired_at`/`retired_reason`, DELETE).
    /// 107 is #3173's local-embedding vector search (ADR-0196 D8 증보): `mem_item_embedding` (ENABLE +
    /// FORCE RLS, no runtime-role privileges), the worker-only embedding writers and readers, the
    /// query-text gate `mem_serve_query`, and the owner-only weighted-RRF fusion behind
    /// `mem_serve_items_fused` (permission filtering stays in SQL, before the top-K cut).
    /// 108 is #3172's consolidation job (ADR-0196 D4/D10): worker-only definer functions for
    /// duplicate merge, decision-interval closing, decay, source-death retirement, retention and
    /// pending-proposal purge (all reversible through `mem_event`), `mem_cons_state`/`mem_cons_pair`/
    /// `mem_suppress_msg`, the `mem.op` marker policies, `mem_proposal.op`, the by-signature
    /// definer allow-list and the follow-ups of #3200/#3209 (event visibility, forget → digests stale).
    /// 108 is #3172's topic layer (L3): `mem_topic`, `mem_topic_summary`, `mem_item.topic_id` and the worker-only
    /// assign / split / summarise / gc / revert functions (same channel only, labels and summaries re-checked in SQL).
    /// 110 is #3212's memory reset (ADR-0196 D9/D10): `mem_reset_workspace` (owner/admin, permanent delete, `reset_epoch`
    /// only raised by it), the per-channel `reset_floor_seq` fence + the reset advisory lock in `mem_apply_digest` /
    /// `mem_add_item`, and `mem_summary_provider` (the team notice's provider/model, three columns of one row).
    ///
    /// 111 is #3277's member avatar (ADR-0161 증보): `member_avatar_media` (the 067 lifecycle re-aimed at a member, image
    /// mime allow-list without SVG) and `member.avatar_media_id` with a composite self-only FK.
    ///
    /// 112 is #3284's avatar Drive reclaim: `drive_reclaimed_at` on both avatar media tables (rows are marked, never deleted)
    /// and the partial scan indexes the reclaim sweep reads.
    ///
    /// 113 is #2793's shared local session (ADR-0190 D4): `work_session.origin` / `folder_label` and the
    /// `work_control_refuse_local_session` trigger that keeps every control off a `local_pty` session.
    ///
    /// 114 is #2862's shared-session S1 payload (ADR-0190 D4-b, ADR-0194 D9): the RLS-FORCE table `work_session_share`
    /// and the widened `work_session.tool` CHECK.
    ///
    /// 115 is #3341's 「작업 끝남」 push inputs (ADR-0120 부록 A): `work_session.turn_started_at` and
    /// `notification_rule.work_complete_push`.
    ///
    /// 116 is #3392's subscription-agent registration key (ADR-0193 증보 2026-10-03):
    /// `agent.subscription_device_id` and its partial unique index.
    ///
    /// 117 is #3396's personal API key (ADR-0147 증보 2026-10-03): the RLS-FORCE table `personal_provider_link`
    /// (sealed owner-scoped BYOK key, key fingerprint unique among active rows) and `agent.uses_owner_key`.
    ///
    /// 118 is #3500's personal cloud box (ADR-0197 M1): the RLS-FORCE tables `cloud_box` (one live
    /// box per member, lifecycle-table trigger) and `cloud_box_control` (closed five-verb runner queue).
    ///
    /// 119 is #3505's box runner (ADR-0197 M2): the RLS-FORCE table `cloud_box_runner` (one live runner per
    /// workspace, sha256-hashed credential) and the fencing/report columns of `cloud_box_control`.
    ///
    /// 120 is #3517's work-run board event (ADR-0162 증보 3 D13): the `agent_run` triggers that put
    /// `work.run.updated` on the outbox for a hosted work run's board-state transitions.
    ///
    /// 121 is #3590's work-host folders (ADR-0188 D6, ADR-0198 증보 1): the RLS-FORCE table
    /// `work_host_folder` (opaque folder id + display name a host announces, never a path).
    ///
    /// 122 is #3570's signed new-work spawn (ADR-0198 D4, 증보 1 D7): `work_control.payload.prompt`,
    /// the thread/origin-message columns, and the signature CHECK that lets only a new task name no agent.
    ///
    /// 123 is #3591's personal agent (ADR-0198 증보 1 D7): `agent.personal_agent`,
    /// `agent.personal_disabled_at` and the one-per-(owner, harness) partial index.
    ///
    /// 124 is #3592's session persona (ADR-0198 증보 1 D7): `work_session.persona_member_id`,
    /// the personal agent a called session's card, progress and answer are authored as.
    ///
    /// 125 is #3567's subscription-agent retirement (ADR-0198 증보 1 D2): `agent.subscription_retired_at`
    /// and the guard that keeps a converted or retired agent's hosted connection closed.
    ///
    /// 126 is #3680's inbox projection (ADR-0199 E1): the RLS-FORCE table `inbox_item` (per-recipient
    /// mention / reply_to_me / thread_reply / dm rows derived from `message`) and the triggers that
    /// fill it and its cursor-driven `read_at`.
    ///
    /// 127 is #3681's inbox realtime event (ADR-0199 E2 D7): the `inbox_item` AFTER INSERT trigger that
    /// puts `inbox_item.created` on the recipient's personal channel through the outbox.
    ///
    /// 128 is #3740's run event ledger (ADR-0200 S1): the RLS-FORCE tables `agent_run_event` and
    /// `hosted_agent_liveness`, `agent_run_event_append`, and the `agent_run`/`approval` lifecycle triggers.
    ///
    /// 129 is #3743's manual doorbell ring ledger (ADR-0200 S4): the RLS-FORCE table
    /// `hosted_agent_doorbell_ring` that bounds 「다시 깨우기」 (60 s cooldown, 5 per hour).
    ///
    /// 130 is #3744's run-event realtime frame (ADR-0200 S5): the `agent_run_event` AFTER INSERT trigger
    /// that puts a thin `agent.run.event` frame on the channel topic through the outbox, and the
    /// `agent_run.finished_at` index the retention sweep scans.
    ///
    /// 131 is ADR-0186 증보 2026-10-13 A0 (#3786): the RLS-FORCE `agent_avatar_image` table (server
    /// re-encoded avatar bytes, immutable but for `status`) and `member.avatar_image_id` with a
    /// self-only composite FK.
    ///
    /// 132 is #3822's `doorbell_rung` ledger kind (ADR-0200 증보 2026-10-14): only the
    /// `agent_run_event_kind_ck` vocabulary grows.
    ///
    /// 133 is #3840's `tool_call` ledger kind (ADR-0200 증보 2026-10-15 T1~T5): `tool`/`duration_ms`
    /// columns, the RLS-FORCE `agent_run_tool_tally`, `agent_run_tool_call_record` (100-row cap per
    /// run, tally past it), a trim that neither counts nor deletes `tool_call`, and no frame for it.
    ///
    /// 134 is #3851's `agent.thread_reply_wake` (ADR-0162 증보 5 W3): one boolean column on the
    /// existing RLS-FORCE `agent` table, default on.
    ///
    /// 135 is #3853 (ADR-0202 E1): `work.run.updated` fires for every agent kind's work
    /// runs and for top-level mention runs' final transition. Function body only.
    ///
    /// 136 is #3873's per-agent AI link pin (ADR-0147 증보 2026-10-16): the RLS-FORCE table
    /// `agent_provider_pin` (a link reference per agent, no credential material; reads are
    /// workspace-scoped, writes need the `app.provider_link_admin` operator GUC) and its guard
    /// trigger (own workspace, never an `owner_only` agent).
    ///
    /// 137 is #3886's 「월 크레딧」 (ADR-0147 증보 2026-10-16): the RLS-FORCE
    /// `provider_key_budget` (one operator-typed number per AI company, read and written only under
    /// `app.provider_link_admin`) and the global Anthropic `model_pricing` rows.
    ///
    /// 138 is #3894's team-AI helper v2 (ADR-0201 증보 2026-10-16 H2·H4·H5): the RLS-FORCE
    /// `member_handle_alias` (the helper's `oort`·`오르트`·`claude` aliases, released by a `member`
    /// trigger when a real member takes that handle), the NOBYPASSRLS SELECT-only
    /// `momo_helper_read` role the read tools `SET LOCAL ROLE` into, and
    /// `usage_ledger.web_search_requests`.
    ///
    /// 139 is #3938's `agent.connector_owner_human_id` (ADR-0113 증보 2 E3): the mark that an agent
    /// runs its owner's connected apps, so only the owner's calls are delivered.
    ///
    /// 140 is #3947's GitHub App storage (ADR-0205 D1·D2·D5·D6): the singleton `github_app` (sealed
    /// pem + webhook secrets, no `client_secret` column), the instance-global
    /// `github_app_installation` routing table (both FORCE RLS behind the `app.github_app_admin` /
    /// `app.github_ingress` GUCs), and the tenant `github_link_claim`, `github_channel_subscription`
    /// and `github_receipt` (ENABLE + FORCE + `ws_isolation`).
    ///
    /// 141 is #4018's `channel_viewing` (ADR-0204 증보 3): the presence heartbeat's last-seen stamp
    /// per (channel, member), tenant ENABLE + FORCE + `ws_isolation`, SELECT for `momo_notifier`.
    ///
    /// 142 is #3954's GitHub receive/link slice (ADR-0205 D3·D4·D5): the non-secret
    /// `github_app_public` identity, the installation repository list, the workspace's dedicated
    /// 「GitHub」 author, the narrow `app.github_link` GUC branches, and
    /// `github_channel_subscription.private_confirmed_at`.
    ///
    /// 143 is #3944's official catalogue (ADR-0113 증보 2): the measured manifests of GitHub,
    /// Notion and Linear replace the 013 placeholders and Gmail, Google Calendar and Google
    /// Drive are seeded. Data only - `plugin_registry` has no RLS and no table is added.
    ///
    /// 144 is #4143's co-hosted model pin (ADR-0203 증보 2026-10-20): `agent_provider_pin` gains
    /// the `model_provider` + `model_id` pair (both NULL = today's behaviour, operator_env only).
    ///
    /// 145 is #4214's scheduled messages (ADR-0208): the owner-scoped FORCE-RLS tables
    /// `scheduled_message` and `scheduled_message_attachment` (workspace **and** author in the policy,
    /// both through `NULLIF`), the `NOLOGIN NOBYPASSRLS` definer role `momo_sched_definer` with
    /// column-level SELECT and a SELECT-only policy, the id-only `SECURITY DEFINER` functions
    /// `momo_schedule_private.due_scheduled_messages` / `expired_scheduled_messages`, and the
    /// `scheduled-message-lockdown` block (also in both bootstrap SQL files).
    ///
    /// 146 is #4227's DM closure (ADR-0177 증보 D6·D9): `channel_seq.last_readable_seq`, the
    /// `AFTER INSERT ON message` trigger that raises it (SECURITY INVOKER, `IS DISTINCT FROM`), the
    /// backfill that follows the trigger (`row_security = off`, a `GET DIAGNOSTICS` row-count
    /// assertion), and the member-owned `dm_closure` table (ENABLE + FORCE + `ws_isolation`).
    ///
    /// 147 is #4381's EXECUTE lockdown: ten API-side `mem_*` definer functions (six entry points, four RLS
    /// policy helpers) go from PUBLIC to `momo_app` only (also reasserted in both bootstrap SQL files).
    ///
    /// 148 is #4385's `member.avatar.set` (ADR-0186 증보 2026-10-25 v4): only the INSERT guard of
    /// `agent_avatar_image` changes — the image's owner may be the person who asked the agent, the
    /// proposer must be an agent.
    ///
    /// 149 is #4313's display fields (ADR-0113 증보 3 F1): a jsonb patch on the seven official
    /// `plugin_registry` manifests (`logoKey`, `category`, `websiteURL`, `starterPrompts`) with the
    /// digest rewritten in the same statement.
    ///
    /// 150 is #4443's attachment reclaim (ADR-0151 증보 2): `attachment.reserved` / `unreserved_at`
    /// mirrored from the owner-scoped `scheduled_message_attachment` by a `SECURITY INVOKER` trigger
    /// (with a `row_security = off` backfill and a row-count assertion), the partial index the reclaim
    /// sweep reads, and the notifier's column-level `SELECT` on `attachment`. No new table, no new
    /// definer.
    ///
    /// 151 is #4443's audit scrub (ADR-0151 증보 2 D3): it removes the top-level `name` key from the
    /// `attachment.upload_started` rows written before schema v2 (a file name can be a person's), with
    /// a `row_security = off` safety line and before/after row counts in a `NOTICE`. Data only: no
    /// column, no function, no grant — and the only migration that edits audit rows.
    ///
    /// 152 is #4660's human developer token (ADR-0216 D2·D3·D4·D7·D8): `token_kind` gains `dev`, `token`
    /// gains nullable `dev_*` columns under named CHECKs (all written on `kind::text`, because the same
    /// single-transaction file cannot use the new enum value as a literal), a `BEFORE INSERT OR UPDATE OF
    /// kind, actor_member_id, workspace_id` trigger that lets only a `human` member own a `dev` row, a partial unique index of one live access/refresh pair
    /// per lineage, and `message.sent_via` (`NULL` or `'dev'`). No new table, so no new RLS policy.
    ///
    /// 153 is #4700's `oort login` browser-approval ledger (ADR-0216 D6 나): the new tenant table
    /// `dev_login_authorization` (one terminal decision per signed request nonce, a 60 s single-use code
    /// stored only as a digest, the lineage a consumed code opened) under RLS ENABLE + FORCE and the
    /// standard `ws_isolation` policy, with a conditional `momo_app` grant.
    ///
    /// 154 is #4704's `workspace:initiate` (ADR-0186 증보 v5 U-b): the hosted scope vocabulary gains an
    /// eighth value, so the three CHECK constraints 087 rewrote are rewritten again. No table, column,
    /// index or row is added or changed; an existing connection's approved scopes stay exactly as they were.
    ///
    /// 155 is #4704's PR B (ADR-0186 증보 v5 U-d): two partial indexes (the rate window over `agent_run`,
    /// the duplicate and cooldown reads over `approval`) and `agent_initiative_refusal`, the per-(agent,
    /// reason) one-hour window of the refusal audit row, under RLS ENABLE + FORCE and `ws_isolation`.
    ///
    /// 158 is #4676's custom expression store (ADR-0218): six tenant tables under RLS ENABLE + FORCE
    /// and `ws_isolation`, with composite workspace foreign keys.
    ///
    /// 159 is #4820 C1b's motion-assembly keep (ADR-0218 G3.6): two tenant tables (`expression_assembly`
    /// and its images) under RLS ENABLE + FORCE, `ws_isolation` and a RESTRICTIVE per-agent policy.
    ///
    /// 160 is #4820 C2a's `self_media_token` (ADR-0218 G4/G8): the hash of a short-lived, single-use
    /// address of the requester's own photo, under RLS ENABLE + FORCE and `ws_isolation`.
    ///
    /// 161 is #4820 C2b's original-photo pointer (ADR-0218 G1/G7): `origin_source_attachment_id` on
    /// `expression` and `expression_draft` (generated origin only) and the six G3.8 card codes in the
    /// draft's `code` CHECK. No new table.
    ///
    /// 162 is #4887's 「대화에도 보내기」 (ADR-0148 증보 2026-10-31): `message.also_in_channel boolean
    /// NOT NULL DEFAULT false` and the CHECK `message_also_in_channel_reply_ck` that lets only a thread
    /// reply (`root_id` set) turn it on. No new table, so no new RLS policy.
    ///
    /// 163 is #4881's link-card site metadata (ADR-0170 amendment 2026-10-31): six columns (site name,
    /// icon proxy key and remote icon address, image width/height, video flag) on `unfurl_url_cache` and
    /// `message_unfurl`, with the column CHECKs that keep the size pair and the icon pair whole. No new
    /// table.
    ///
    /// 164 is #4889's `thread_follow` (ADR-0206 증보 1 F1): who follows which thread, one row per
    /// (root, member) with the state `auto` / `followed` / `unfollowed`, tenant ENABLE + FORCE +
    /// `ws_isolation`. No grant for `momo_notifier` until the stage-2 judgment arm reads it.
    ///
    /// 165 is #4889 stage 2 (ADR-0206 증보 1): `thread_follow.last_read_reply_seq bigint NOT NULL
    /// DEFAULT 0` (the read position behind the thread summary's `unread_reply_count`) with a
    /// `NOT VALID` CHECK `>= 0`, and `GRANT SELECT ON thread_follow TO momo_notifier` — the one grant
    /// the `thread_reply` push arm needs (no INSERT / UPDATE / DELETE, no new BYPASSRLS role). No new
    /// table, so no new RLS policy.
    ///
    /// 166 is #4966's 「별칭이 이름을 따라가요」 (ADR-0201 증보 v3 B10, slice S3): the helper's alias
    /// set stops being fixed (`member_handle_alias_v2_set_ck` is dropped, the shape CHECK stays) and
    /// the trigger `member_handle_alias_guard` takes over: an alias belongs to the workspace's team AI
    /// member only, and a workspace holds at most four. No new table, no new grant.
    ///
    /// 167 is #4900's expiry rule for expression drafts (ADR-0218 D2): `expression_immutable()` lets
    /// `origin` change in exactly one way — when a draft is `expired`, its `prompt` (the agent's words)
    /// becomes JSON null — and the migration blanks the prompts of drafts that expired before it. No new
    /// table, so no new RLS policy.
    ///
    /// 168 is #4656's agent activity report (ADR-0200 증보 7): the two ledger kinds `activity` and
    /// `plan` on `agent_run_event` (seven new columns, the SQL backstop CHECKs, the shared text
    /// function), the per-run ended-unit total `agent_run_activity_tally` (tenant ENABLE + FORCE +
    /// `ws_isolation`, `momo_notifier` SELECT for the retention sweep), the roll function
    /// `agent_run_activity_trim`, the one writer `agent_run_activity_record`, and the stage trim /
    /// append / frame-window functions made to look past the new kinds.
    ///
    /// 169 is #4967's 「도우미 작업 모드」 (ADR-0201 증보 v3 B5·B14-S4): the `team_ai_task` marker
    /// table — one row per run, the row's existence is the task-mode judgement, `steps_done` and the
    /// step claim keep a step from running twice, and the plan/note between steps are gone once the
    /// row is ended (`team_ai_task_ended_ck`). Tenant ENABLE + FORCE + `ws_isolation`; the grants are
    /// the minimum the code reads and writes (`team-ai-task-lockdown`, the same text in the migration
    /// and both role bootstraps).
    ///
    /// 170 is #4341's 「알림 진단과 시험 알림」 (ADR-0206 D11·D15): the `push_system` outbox label
    /// (a value this file never uses, as 011 did), four `notification_rule` columns for the test
    /// push's per-minute window and its last test, and the `push_dispatch_log (member_id,
    /// created_at DESC)` index the diagnostics read. No new table, so no new RLS policy or grant.
    ///
    /// 171 is #4961's 「팀 표현의 종류 값」 (ADR-0218 증보 4 §10): `expression.kind` (`emoji` /
    /// `sticker`), `NOT NULL DEFAULT 'sticker'` so every earlier row reads as a sticker, a closed
    /// `CHECK`, and nothing else. No new table (so no new RLS policy), no new grant, and the identity
    /// trigger of 158 keeps the new column immutable after INSERT without being touched.
    #[test]
    fn discovers_contiguous_migrations_001_to_171() {
        let dir = default_migrations_dir();
        let migrations = discover_migrations(&dir).expect("migrations directory readable");

        let expected: Vec<i64> = (1..=171).collect();
        let found: Vec<i64> = migrations
            .iter()
            .map(|migration| migration.version)
            .collect();
        assert_eq!(
            found,
            expected,
            "expected contiguous 001..=171 under {}",
            dir.display()
        );
        assert!(migrations.first().unwrap().name.starts_with("001_init"));
        assert!(migrations
            .last()
            .unwrap()
            .name
            .starts_with("171_expression_kind"));
    }

    #[test]
    fn seed_mode_maps_like_migrate_sh() {
        assert_eq!(SeedMode::None.enabled_flag(), "0");
        assert_eq!(SeedMode::Demo.enabled_flag(), "1");
        assert_eq!(SeedMode::E2e.enabled_flag(), "1");
        assert_eq!(SeedMode::default(), SeedMode::None);
    }

    /// `migrate.sh` tracks the **filename**, not the numeric prefix
    /// (`version=$(basename "$f")`, :122). Tracking the number instead would
    /// make a renamed file re-apply, and `check_migration_numbers.sh` — which
    /// exists precisely because two files with the same prefix would both apply
    /// — would be pointless.
    #[test]
    fn tracked_version_is_the_full_filename() {
        let migrations = discover_migrations(&default_migrations_dir()).expect("discover");
        let first = migrations.first().expect("at least one migration");
        assert!(
            first.name.starts_with("001_") && first.name.ends_with(".sql"),
            "version must be the basename incl. prefix and extension, got {}",
            first.name
        );
    }

    #[test]
    fn version_literals_are_quoted_and_escaped() {
        assert_eq!(sql_literal("001_init.sql"), "'001_init.sql'");
        assert_eq!(sql_literal("odd'name.sql"), "'odd''name.sql'");
    }

    /// The tracking table is the runner's own: no file under
    /// `server/Migrations/` creates `schema_migrations` (007 mentions it in a
    /// comment only), so a runner that skipped this DDL would fail its first
    /// skip probe on a fresh DB.
    #[test]
    fn the_runner_owns_the_tracking_table() {
        assert!(SCHEMA_MIGRATIONS_DDL.contains("CREATE TABLE IF NOT EXISTS schema_migrations"));
        assert!(
            SCHEMA_MIGRATIONS_DDL.contains("version")
                && SCHEMA_MIGRATIONS_DDL.contains("PRIMARY KEY"),
            "version is the primary key — the uniqueness that makes SKIP sound"
        );

        let dir = default_migrations_dir();
        let creators: Vec<String> = discover_migrations(&dir)
            .expect("discover")
            .into_iter()
            .filter(|migration| {
                std::fs::read_to_string(&migration.path)
                    .map(|sql| {
                        sql.to_lowercase()
                            .contains("create table if not exists schema_migrations")
                            || sql
                                .to_lowercase()
                                .contains("create table schema_migrations")
                    })
                    .unwrap_or(false)
            })
            .map(|migration| migration.name)
            .collect();
        assert!(
            creators.is_empty(),
            "no migration may create schema_migrations (the runner does); found {creators:?}"
        );
    }

    #[test]
    fn a_report_counts_every_considered_version() {
        let report = MigrationReport {
            applied: vec!["001_init.sql".to_string()],
            skipped: vec!["002_seed.sql".to_string(), "003_x.sql".to_string()],
        };
        assert_eq!(report.total(), 3);
        assert_eq!(MigrationReport::default().total(), 0);
    }
}
