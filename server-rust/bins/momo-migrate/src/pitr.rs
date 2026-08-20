//! Signed, caller-bound pgBackRest time-target recovery evidence for #1330.
//!
//! The migration command reaches this module before role posture or migration
//! SQL. Static shape, HMAC, freshness, execution nonce, images, volumes and the
//! exact embedded migration bytes all pass before the read-only live probes
//! (`pg_control_system()` and migration-lineage containment); only then may the
//! ordinary runner proceed.

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use momo_db::migrate::Migration;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{env, psql_scalar, MigrateError};

const EVIDENCE_SCHEMA: &str = "momo-pitr-evidence/v1";
const HMAC_DOMAIN: &[u8] = b"momo-pitr-evidence/v1\n";
const MAX_AGE_SECONDS: i64 = 15 * 60;
const DEFAULT_EVIDENCE_PATH: &str = "/run/momo-pitr/evidence.json";
const DEFAULT_HMAC_KEY_PATH: &str = "/run/secrets/momo_pitr_hmac_key";
const CIPHER_SECRET_PATH: &str = "/run/secrets/pgbackrest_repo1_cipher_pass";
const ARCHIVE_COMMAND_PREFIX: &str = "/usr/local/bin/oort-pgbackrest --stanza=";
const CIPHER_FINGERPRINT_DOMAIN: &[u8] = b"momo-pitr-cipher-fingerprint/v1\n";
const PG_CLOCK_SQL: &str =
    r#"SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');"#;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct EvidencePayload {
    result: String,
    run_id: String,
    started_at: String,
    source_backup_completed_at: String,
    recovery_target_time: String,
    restored_at: String,
    completed_at: String,
    duration_seconds: u64,
    git_commit: String,
    compose_project: String,
    stanza: String,
    postgres_image_ref: String,
    postgres_image_digest: String,
    postgres_image_id: String,
    candidate_migrate_image_digest: String,
    migrations_sha256: String,
    postgres_version: String,
    pgbackrest_version: String,
    source_volume: String,
    restore_volume: String,
    repo_volume: String,
    source_system_identifier: String,
    restore_system_identifier: String,
    cipher_type: String,
    cipher_fingerprint_hmac_sha256: String,
    backup_label: String,
    backup_type: String,
    backup_lsn_start: String,
    backup_lsn_stop: String,
    archive_wal_start: String,
    archive_wal_stop: String,
    marker_a_count: u64,
    marker_b_count: u64,
    archive_mode: String,
    archive_command: String,
    archive_timeout_seconds: u64,
    cleanup_container_leaks: u64,
    cleanup_volume_leaks: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EvidenceEnvelope {
    schema: String,
    payload: EvidencePayload,
    signature: String,
}

#[derive(Debug)]
struct Expected {
    run_id: String,
    git_commit: String,
    compose_project: String,
    source_volume: String,
    restore_volume: String,
    repo_volume: String,
    postgres_image_digest: String,
    migrate_image_digest: String,
    stanza: String,
    cipher_type: String,
    cipher_fingerprint: String,
    system_identifier: String,
}

impl Expected {
    fn from_env() -> Result<Self, MigrateError> {
        Ok(Self {
            run_id: require_env("MOMO_PITR_EXPECT_RUN_ID")?,
            git_commit: require_env("MOMO_PITR_EXPECT_GIT_COMMIT")?,
            compose_project: require_env("MOMO_PITR_EXPECT_COMPOSE_PROJECT")?,
            source_volume: require_env("MOMO_PITR_EXPECT_SOURCE_VOLUME")?,
            restore_volume: require_env("MOMO_PITR_EXPECT_RESTORE_VOLUME")?,
            repo_volume: require_env("MOMO_PITR_EXPECT_REPO_VOLUME")?,
            postgres_image_digest: require_env("MOMO_PITR_EXPECT_POSTGRES_IMAGE_DIGEST")?,
            migrate_image_digest: require_env("MOMO_PITR_EXPECT_MIGRATE_IMAGE_DIGEST")?,
            stanza: require_env("MOMO_PITR_EXPECT_STANZA")?,
            cipher_type: require_env("MOMO_PITR_EXPECT_CIPHER_TYPE")?,
            cipher_fingerprint: require_env("MOMO_PITR_EXPECT_CIPHER_FINGERPRINT")?,
            system_identifier: require_env("MOMO_PITR_EXPECT_SYSTEM_IDENTIFIER")?,
        })
    }
}

fn require_env(key: &str) -> Result<String, MigrateError> {
    env(key).ok_or_else(|| MigrateError::Failed(format!("PITR gate: set {key}")))
}

fn open_regular_no_follow(path: &Path, label: &str) -> Result<File, MigrateError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|error| {
            MigrateError::Failed(format!(
                "PITR gate: cannot open {label} as a no-follow file at {}: {error}",
                path.display()
            ))
        })?;
    if !file
        .metadata()
        .map_err(|error| MigrateError::Failed(format!("PITR gate: stat {label}: {error}")))?
        .is_file()
    {
        return Err(MigrateError::Failed(format!(
            "PITR gate: {label} must be a regular file"
        )));
    }
    Ok(file)
}

fn read_evidence(path: &Path) -> Result<Vec<u8>, MigrateError> {
    let mut file = open_regular_no_follow(path, "evidence")?;
    let metadata = file
        .metadata()
        .map_err(|error| MigrateError::Failed(format!("PITR gate: stat evidence: {error}")))?;
    if metadata.permissions().mode() & 0o022 != 0 || metadata.len() == 0 || metadata.len() > 65_536
    {
        return Err(MigrateError::Failed(
            "PITR gate: evidence must be 1..65536 bytes and not group/world writable".to_string(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| MigrateError::Failed(format!("PITR gate: read evidence: {error}")))?;
    Ok(bytes)
}

fn read_hmac_key(path: &Path) -> Result<Vec<u8>, MigrateError> {
    read_owner_secret(path, "HMAC key", 32)
}

fn read_cipher_secret(path: &Path) -> Result<Vec<u8>, MigrateError> {
    read_owner_secret(path, "repository cipher", 32)
}

fn read_owner_secret(path: &Path, label: &str, minimum: usize) -> Result<Vec<u8>, MigrateError> {
    let mut file = open_regular_no_follow(path, label)?;
    let metadata = file
        .metadata()
        .map_err(|error| MigrateError::Failed(format!("PITR gate: stat {label}: {error}")))?;
    let mode = metadata.permissions().mode();
    // SAFETY: `geteuid` has no arguments, dereferences no pointers and has no
    // preconditions. Comparing the opened inode's uid prevents root-owned
    // Compose bind files from accidentally becoming a reusable cross-service
    // secret seam for the uid-10001 migration process.
    let effective_uid = unsafe { libc::geteuid() };
    if mode & 0o077 != 0
        || mode & 0o400 == 0
        || metadata.uid() != effective_uid
        || !((minimum as u64)..=4097).contains(&metadata.len())
    {
        return Err(MigrateError::Failed(format!(
            "PITR gate: {label} must be owned by this process, owner-readable, owner-only, and one {minimum}..4096 byte line"
        )));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| MigrateError::Failed(format!("PITR gate: read {label}: {error}")))?;
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.len() < minimum
        || bytes.len() > 4096
        || bytes.iter().any(|byte| matches!(byte, b'\n' | b'\r' | 0))
    {
        return Err(MigrateError::Failed(format!(
            "PITR gate: {label} must be exactly one {minimum}..4096 byte line"
        )));
    }
    Ok(bytes)
}

fn cipher_fingerprint(key: &[u8], cipher: &[u8]) -> Result<String, MigrateError> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| MigrateError::Failed("PITR gate: invalid HMAC key".to_string()))?;
    mac.update(CIPHER_FINGERPRINT_DOMAIN);
    mac.update(cipher);
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn require_distinct_secrets(key: &[u8], cipher: &[u8]) -> Result<(), MigrateError> {
    if key == cipher {
        return Err(MigrateError::Failed(
            "PITR gate: evidence HMAC key and repository cipher must be distinct".to_string(),
        ));
    }
    Ok(())
}

fn verify_secret_snapshots_unchanged(
    key_path: &Path,
    cipher_path: &Path,
    initial_key: &[u8],
    initial_cipher_fingerprint: &str,
) -> Result<(), MigrateError> {
    let current_key = read_hmac_key(key_path)?;
    if current_key != initial_key {
        return Err(MigrateError::Failed(
            "PITR gate: HMAC key changed during verification".to_string(),
        ));
    }
    let current_cipher_fingerprint =
        cipher_fingerprint(&current_key, &read_cipher_secret(cipher_path)?)?;
    if current_cipher_fingerprint != initial_cipher_fingerprint {
        return Err(MigrateError::Failed(
            "PITR gate: repository cipher changed during verification".to_string(),
        ));
    }
    Ok(())
}

fn write_canonical_json(value: &Value, output: &mut Vec<u8>) -> Result<(), MigrateError> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            serde_json::to_writer(output, value).map_err(|error| {
                MigrateError::Failed(format!("PITR gate: canonical JSON failed: {error}"))
            })
        }
        Value::Array(values) => {
            output.push(b'[');
            for (index, item) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                write_canonical_json(item, output)?;
            }
            output.push(b']');
            Ok(())
        }
        Value::Object(values) => {
            output.push(b'{');
            let mut keys: Vec<&String> = values.keys().collect();
            keys.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
            for (index, key) in keys.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                serde_json::to_writer(&mut *output, key).map_err(|error| {
                    MigrateError::Failed(format!("PITR gate: canonical key failed: {error}"))
                })?;
                output.push(b':');
                write_canonical_json(&values[key], output)?;
            }
            output.push(b'}');
            Ok(())
        }
    }
}

fn canonical_payload(payload: &EvidencePayload) -> Result<Vec<u8>, MigrateError> {
    let value = serde_json::to_value(payload)
        .map_err(|error| MigrateError::Failed(format!("PITR gate: encode payload: {error}")))?;
    let mut output = Vec::with_capacity(2048);
    write_canonical_json(&value, &mut output)?;
    Ok(output)
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_upper_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
}

fn is_sha256(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(|digest| is_lower_hex(digest, 64))
}

fn is_safe_identifier(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_system_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value != "0"
}

fn is_lsn(value: &str) -> bool {
    let mut parts = value.split('/');
    let valid_part = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
    };
    matches!((parts.next(), parts.next(), parts.next()), (Some(left), Some(right), None) if valid_part(left) && valid_part(right))
}

fn utc(label: &str, value: &str) -> Result<DateTime<Utc>, MigrateError> {
    if !value.ends_with('Z') {
        return Err(MigrateError::Failed(format!(
            "PITR gate: {label} must be RFC3339 UTC ending in Z"
        )));
    }
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(|_| MigrateError::Failed(format!("PITR gate: invalid {label}")))
}

fn migrations_sha256(migrations: &[Migration]) -> Result<String, MigrateError> {
    if migrations.is_empty() {
        return Err(MigrateError::Failed(
            "PITR gate: cannot hash an empty migration set".to_string(),
        ));
    }
    let mut ordered: Vec<&Migration> = migrations.iter().collect();
    ordered.sort_by(|left, right| left.name.as_bytes().cmp(right.name.as_bytes()));
    let mut digest = Sha256::new();
    digest.update(b"momo-migrations/v1\n");
    for migration in ordered {
        if migration
            .name
            .chars()
            .any(|c| matches!(c, '\0' | '\n' | '\r'))
            || migration.name.len() < 9
            || !migration.name.as_bytes()[..3]
                .iter()
                .all(u8::is_ascii_digit)
            || migration.name.as_bytes().get(3) != Some(&b'_')
            || !migration.name.ends_with(".sql")
        {
            return Err(MigrateError::Failed(format!(
                "PITR gate: invalid migration filename {:?}",
                migration.name
            )));
        }
        let mut file = open_regular_no_follow(&migration.path, "migration")?;
        let length = file
            .metadata()
            .map_err(|error| MigrateError::Failed(format!("PITR gate: stat migration: {error}")))?
            .len();
        if length > 64 * 1024 * 1024 {
            return Err(MigrateError::Failed(format!(
                "PITR gate: migration {} exceeds 64 MiB",
                migration.name
            )));
        }
        let mut bytes = Vec::with_capacity(length as usize);
        file.read_to_end(&mut bytes).map_err(|error| {
            MigrateError::Failed(format!(
                "PITR gate: read migration {}: {error}",
                migration.name
            ))
        })?;
        update_migration_digest(&mut digest, migration.name.as_bytes(), &bytes);
    }
    Ok(hex::encode(digest.finalize()))
}

fn migration_lineage_sql(migrations: &[Migration]) -> Result<String, MigrateError> {
    if migrations.is_empty() {
        return Err(MigrateError::Failed(
            "PITR gate: cannot validate lineage against an empty migration set".to_string(),
        ));
    }
    let allowed = migrations
        .iter()
        .map(|migration| format!("'{}'", migration.name.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!(
        "SELECT count(*)::text FROM public.schema_migrations WHERE version NOT IN ({allowed});"
    ))
}

fn verify_live_migration_lineage(
    database_url: &str,
    migrations: &[Migration],
) -> Result<(), MigrateError> {
    let tracking_exists = psql_scalar(
        database_url,
        "SELECT to_regclass('public.schema_migrations') IS NOT NULL;",
        "PITR live migration tracking probe",
    )?;
    if tracking_exists == "f" {
        // A recovery proof may precede the first tracked migration only on an
        // actually empty public schema (the isolated closed-loop harness).
        // Missing history on a legacy/corrupt nonempty database is not an
        // invitation to replay the entire candidate set.
        let public_schema_empty = psql_scalar(
            database_url,
            "SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p'));",
            "PITR live untracked-schema emptiness probe",
        )?;
        return lineage_tracking_plan(&tracking_exists, &public_schema_empty);
    }
    if tracking_exists != "t" {
        return Err(MigrateError::Failed(
            "PITR gate: migration tracking probe returned an invalid value".to_string(),
        ));
    }
    let unknown = psql_scalar(
        database_url,
        &migration_lineage_sql(migrations)?,
        "PITR live migration lineage probe",
    )?;
    if unknown != "0" {
        return Err(MigrateError::Failed(format!(
            "PITR gate: live database has {unknown} applied migration(s) absent from the candidate image"
        )));
    }
    Ok(())
}

fn lineage_tracking_plan(
    tracking_exists: &str,
    public_schema_empty: &str,
) -> Result<(), MigrateError> {
    match (tracking_exists, public_schema_empty) {
        ("f", "t") => Ok(()),
        ("f", "f") => Err(MigrateError::Failed(
            "PITR gate: nonempty public schema is missing migration history".to_string(),
        )),
        _ => Err(MigrateError::Failed(
            "PITR gate: untracked-schema probe returned an invalid value".to_string(),
        )),
    }
}

fn update_migration_digest(digest: &mut Sha256, name: &[u8], bytes: &[u8]) {
    digest.update(name);
    digest.update([0]);
    digest.update(bytes.len().to_string().as_bytes());
    digest.update([0]);
    digest.update(bytes);
    digest.update(b"\n");
}

fn validate(
    bytes: &[u8],
    key: &[u8],
    expected: &Expected,
    expected_migrations_sha256: &str,
    current_cipher_fingerprint: &str,
    now: DateTime<Utc>,
) -> Result<EvidencePayload, MigrateError> {
    let envelope: EvidenceEnvelope = serde_json::from_slice(bytes).map_err(|error| {
        MigrateError::Failed(format!("PITR gate: invalid evidence JSON: {error}"))
    })?;
    if envelope.schema != EVIDENCE_SCHEMA || !is_lower_hex(&envelope.signature, 64) {
        return Err(MigrateError::Failed(
            "PITR gate: unsupported schema or malformed signature".to_string(),
        ));
    }
    let signature = hex::decode(&envelope.signature)
        .map_err(|_| MigrateError::Failed("PITR gate: invalid signature hex".to_string()))?;
    let canonical = canonical_payload(&envelope.payload)?;
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|_| MigrateError::Failed("PITR gate: invalid HMAC key".to_string()))?;
    mac.update(HMAC_DOMAIN);
    mac.update(&canonical);
    mac.verify_slice(&signature)
        .map_err(|_| MigrateError::Failed("PITR gate: evidence signature mismatch".to_string()))?;

    let payload = envelope.payload;
    if payload.result != "PASS" {
        return Err(MigrateError::Failed(
            "PITR gate: evidence result is not exact PASS".to_string(),
        ));
    }
    if !is_safe_identifier(&payload.run_id, 16, 128) || payload.run_id != expected.run_id {
        return Err(MigrateError::Failed(
            "PITR gate: run binding mismatch".to_string(),
        ));
    }
    if !is_lower_hex(&payload.git_commit, 40) || payload.git_commit != expected.git_commit {
        return Err(MigrateError::Failed(
            "PITR gate: git commit binding mismatch".to_string(),
        ));
    }
    if !is_safe_identifier(&payload.compose_project, 1, 63)
        || payload.compose_project != expected.compose_project
    {
        return Err(MigrateError::Failed(
            "PITR gate: compose project binding mismatch".to_string(),
        ));
    }
    for (label, value, wanted) in [
        ("source", &payload.source_volume, &expected.source_volume),
        ("restore", &payload.restore_volume, &expected.restore_volume),
        ("repo", &payload.repo_volume, &expected.repo_volume),
    ] {
        if !is_safe_identifier(value, 1, 255) || value != wanted {
            return Err(MigrateError::Failed(format!(
                "PITR gate: {label} volume binding mismatch"
            )));
        }
    }
    if payload.source_volume == payload.restore_volume
        || payload.source_volume == payload.repo_volume
        || payload.restore_volume == payload.repo_volume
    {
        return Err(MigrateError::Failed(
            "PITR gate: source, restore and repository volumes must be distinct".to_string(),
        ));
    }
    if !is_sha256(&payload.postgres_image_digest)
        || payload.postgres_image_digest != expected.postgres_image_digest
        || !is_sha256(&payload.postgres_image_id)
        || !is_sha256(&payload.candidate_migrate_image_digest)
        || payload.candidate_migrate_image_digest != expected.migrate_image_digest
    {
        return Err(MigrateError::Failed(
            "PITR gate: OCI image binding mismatch".to_string(),
        ));
    }
    if payload.postgres_image_ref.contains(char::is_whitespace)
        || !matches!(payload.postgres_image_ref.rsplit_once('@'), Some((name, digest)) if !name.is_empty() && digest == payload.postgres_image_digest)
    {
        return Err(MigrateError::Failed(
            "PITR gate: postgres image ref is not digest pinned".to_string(),
        ));
    }
    if !is_lower_hex(&payload.migrations_sha256, 64)
        || payload.migrations_sha256 != expected_migrations_sha256
    {
        return Err(MigrateError::Failed(
            "PITR gate: candidate migration bytes mismatch".to_string(),
        ));
    }
    if !is_safe_identifier(&payload.stanza, 1, 64) || payload.stanza != expected.stanza {
        return Err(MigrateError::Failed(
            "PITR gate: stanza binding mismatch".to_string(),
        ));
    }
    if payload.cipher_type != "aes-256-cbc" || payload.cipher_type != expected.cipher_type {
        return Err(MigrateError::Failed(
            "PITR gate: cipher binding mismatch".to_string(),
        ));
    }
    if !is_lower_hex(&payload.cipher_fingerprint_hmac_sha256, 64)
        || !is_lower_hex(&expected.cipher_fingerprint, 64)
        || payload.cipher_fingerprint_hmac_sha256 != expected.cipher_fingerprint
        || payload.cipher_fingerprint_hmac_sha256 != current_cipher_fingerprint
    {
        return Err(MigrateError::Failed(
            "PITR gate: repository cipher fingerprint mismatch".to_string(),
        ));
    }
    if !is_system_identifier(&payload.source_system_identifier)
        || payload.source_system_identifier != expected.system_identifier
        || payload.restore_system_identifier != payload.source_system_identifier
    {
        return Err(MigrateError::Failed(
            "PITR gate: system identifier mismatch".to_string(),
        ));
    }
    if payload.postgres_version.trim().is_empty()
        || payload.pgbackrest_version.trim().is_empty()
        || payload.postgres_version.len() > 128
        || payload.pgbackrest_version.len() > 128
        || payload
            .postgres_version
            .chars()
            .chain(payload.pgbackrest_version.chars())
            .any(char::is_control)
    {
        return Err(MigrateError::Failed(
            "PITR gate: version evidence invalid".to_string(),
        ));
    }
    if !is_safe_identifier(&payload.backup_label, 1, 128)
        || payload.backup_type != "full"
        || !is_lsn(&payload.backup_lsn_start)
        || !is_lsn(&payload.backup_lsn_stop)
        || !is_upper_hex(&payload.archive_wal_start, 24)
        || !is_upper_hex(&payload.archive_wal_stop, 24)
    {
        return Err(MigrateError::Failed(
            "PITR gate: backup/WAL range invalid".to_string(),
        ));
    }
    if payload.marker_a_count != 1 || payload.marker_b_count != 0 {
        return Err(MigrateError::Failed(
            "PITR gate: marker boundary is not A=1/B=0".to_string(),
        ));
    }
    let archive_command = format!("{ARCHIVE_COMMAND_PREFIX}{} archive-push %p", payload.stanza);
    if payload.archive_mode != "on"
        || payload.archive_timeout_seconds != 60
        || payload.archive_command != archive_command
    {
        return Err(MigrateError::Failed(
            "PITR gate: archive settings mismatch".to_string(),
        ));
    }
    if payload.cleanup_container_leaks != 0 || payload.cleanup_volume_leaks != 0 {
        return Err(MigrateError::Failed(
            "PITR gate: cleanup leak count is non-zero".to_string(),
        ));
    }
    // Producer timestamps are PostgreSQL clock_timestamp() UTC on the live
    // source, not host UTC. Mixing the two clocks is a false RED when they
    // disagree; `now` must therefore be the same PG clock (see live_pg_clock).
    let started = utc("started_at", &payload.started_at)?;
    let backup_completed = utc(
        "source_backup_completed_at",
        &payload.source_backup_completed_at,
    )?;
    let target = utc("recovery_target_time", &payload.recovery_target_time)?;
    let restored = utc("restored_at", &payload.restored_at)?;
    let completed = utc("completed_at", &payload.completed_at)?;
    if started > backup_completed
        || backup_completed > target
        || target >= restored
        || restored > completed
    {
        return Err(MigrateError::Failed(
            "PITR gate: timestamp chronology invalid".to_string(),
        ));
    }
    let measured = completed.signed_duration_since(started).num_seconds();
    if payload.duration_seconds == 0
        || payload.duration_seconds > 86_400
        || measured < 0
        || (measured - payload.duration_seconds as i64).abs() > 2
    {
        return Err(MigrateError::Failed(
            "PITR gate: duration mismatch".to_string(),
        ));
    }
    if completed > now {
        return Err(MigrateError::Failed(
            "PITR gate: evidence is in the future".to_string(),
        ));
    }
    if now.signed_duration_since(completed).num_seconds() > MAX_AGE_SECONDS {
        return Err(MigrateError::Failed(
            "PITR gate: evidence is older than 15 minutes".to_string(),
        ));
    }
    Ok(payload)
}

fn live_pg_clock(database_url: &str) -> Result<DateTime<Utc>, MigrateError> {
    utc(
        "live clock_timestamp",
        &psql_scalar(database_url, PG_CLOCK_SQL, "PITR live clock probe")?,
    )
}

fn verify_required(database_url: &str, migrations: &[Migration]) -> Result<(), MigrateError> {
    let expected = Expected::from_env()?;
    let evidence_path = PathBuf::from(
        env("MOMO_PITR_EVIDENCE_PATH").unwrap_or_else(|| DEFAULT_EVIDENCE_PATH.to_string()),
    );
    let key_path = PathBuf::from(
        env("MOMO_PITR_HMAC_KEY_PATH").unwrap_or_else(|| DEFAULT_HMAC_KEY_PATH.to_string()),
    );
    let key = read_hmac_key(&key_path)?;
    let current_cipher = read_cipher_secret(Path::new(CIPHER_SECRET_PATH))?;
    require_distinct_secrets(&key, &current_cipher)?;
    let current_cipher_fingerprint = cipher_fingerprint(&key, &current_cipher)?;
    let payload = validate(
        &read_evidence(&evidence_path)?,
        &key,
        &expected,
        &migrations_sha256(migrations)?,
        &current_cipher_fingerprint,
        live_pg_clock(database_url)?,
    )?;
    let live = psql_scalar(
        database_url,
        "SELECT system_identifier::text FROM pg_control_system();",
        "PITR live system identifier probe",
    )?;
    if live != payload.source_system_identifier {
        return Err(MigrateError::Failed(
            "PITR gate: live cluster is not the signed source cluster".to_string(),
        ));
    }
    verify_live_migration_lineage(database_url, migrations)?;
    verify_secret_snapshots_unchanged(
        &key_path,
        Path::new(CIPHER_SECRET_PATH),
        &key,
        &current_cipher_fingerprint,
    )?;
    println!(
        "[migrate] PITR evidence verified: run={} backup={}",
        payload.run_id, payload.backup_label
    );
    Ok(())
}

fn assert_empty_bootstrap(database_url: &str) -> Result<(), MigrateError> {
    const SQL: &str = "SELECT to_regclass('public.schema_migrations') IS NULL \
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c \
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p'));";
    if psql_scalar(database_url, SQL, "PITR empty-bootstrap probe")? != "t" {
        return Err(MigrateError::Failed(
            "PITR gate: empty bootstrap is allowed only before schema_migrations and public user tables"
                .to_string(),
        ));
    }
    println!("[migrate] empty first-install bootstrap confirmed");
    Ok(())
}

pub(crate) fn enforce_policy(
    database_url: &str,
    migrations: &[Migration],
) -> Result<(), MigrateError> {
    let required = read_policy_flag("MOMO_PITR_EVIDENCE_REQUIRED")?;
    let bootstrap = read_policy_flag("MOMO_PITR_BOOTSTRAP_EMPTY")?;
    match policy_plan(env("MOMO_ENV").as_deref(), required, bootstrap)? {
        "evidence" => verify_required(database_url, migrations),
        "bootstrap" => assert_empty_bootstrap(database_url),
        "development" => {
            eprintln!("[migrate] WARNING: PITR evidence gate disabled for development/test");
            Ok(())
        }
        _ => unreachable!("policy_plan has a closed result set"),
    }
}

fn read_policy_flag(key: &str) -> Result<bool, MigrateError> {
    match std::env::var(key) {
        Ok(value) => parse_policy_flag(key, Some(&value)),
        Err(std::env::VarError::NotPresent) => parse_policy_flag(key, None),
        Err(std::env::VarError::NotUnicode(_)) => Err(MigrateError::Failed(format!(
            "PITR gate: {key} must be exactly 0 or 1"
        ))),
    }
}

fn parse_policy_flag(key: &str, value: Option<&str>) -> Result<bool, MigrateError> {
    match value {
        None | Some("0") => Ok(false),
        Some("1") => Ok(true),
        Some(_) => Err(MigrateError::Failed(format!(
            "PITR gate: {key} must be exactly 0 or 1"
        ))),
    }
}

fn policy_plan(
    momo_env: Option<&str>,
    required: bool,
    bootstrap: bool,
) -> Result<&'static str, MigrateError> {
    let protected = match momo_env {
        Some("development" | "test") => false,
        Some("staging" | "production") => true,
        _ => {
            return Err(MigrateError::Failed(
                "PITR gate: environment must be exactly development, test, staging or production"
                    .to_string(),
            ));
        }
    };
    if required && bootstrap {
        return Err(MigrateError::Failed(
            "PITR gate: required and bootstrap modes are mutually exclusive".to_string(),
        ));
    }
    if required {
        return Ok("evidence");
    }
    if bootstrap {
        return Ok("bootstrap");
    }
    if protected {
        Err(MigrateError::Failed(
            "PITR gate: protected environment cannot disable the gate".to_string(),
        ))
    } else {
        Ok("development")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    const KEY: &[u8] = b"0123456789abcdef0123456789abcdef";
    type Mutation = (&'static str, Box<dyn Fn(&mut EvidencePayload)>);

    fn repeated(character: char, count: usize) -> String {
        std::iter::repeat_n(character, count).collect()
    }

    fn secret_fixture() -> (PathBuf, PathBuf, PathBuf) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "momo-pitr-secret-snapshot-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        let key = directory.join("hmac");
        let cipher = directory.join("cipher");
        replace_secret(&key, KEY);
        replace_secret(&cipher, b"cipher-secret-value-that-is-long-enough");
        (directory, key, cipher)
    }

    fn replace_secret(path: &Path, bytes: &[u8]) {
        if path.exists() {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        fs::write(path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o400)).unwrap();
    }

    fn payload() -> EvidencePayload {
        let postgres_digest = format!("sha256:{}", repeated('a', 64));
        EvidencePayload {
            result: "PASS".into(),
            run_id: "pitr-run-12345678".into(),
            started_at: "2030-01-02T03:04:00Z".into(),
            source_backup_completed_at: "2030-01-02T03:04:10Z".into(),
            recovery_target_time: "2030-01-02T03:04:20Z".into(),
            restored_at: "2030-01-02T03:04:30Z".into(),
            completed_at: "2030-01-02T03:04:40Z".into(),
            duration_seconds: 40,
            git_commit: repeated('a', 40),
            compose_project: "momo-prod".into(),
            stanza: "momo".into(),
            postgres_image_ref: format!("ghcr.io/example/postgres@{postgres_digest}"),
            postgres_image_digest: postgres_digest,
            postgres_image_id: format!("sha256:{}", repeated('b', 64)),
            candidate_migrate_image_digest: format!("sha256:{}", repeated('c', 64)),
            migrations_sha256: repeated('d', 64),
            postgres_version: "18.4".into(),
            pgbackrest_version: "2.59.0".into(),
            source_volume: "momo-prod-pgdata".into(),
            restore_volume: "momo-prod-pitr-restore".into(),
            repo_volume: "momo-prod-pgbackrest-repo".into(),
            source_system_identifier: "7587632512345678901".into(),
            restore_system_identifier: "7587632512345678901".into(),
            cipher_type: "aes-256-cbc".into(),
            cipher_fingerprint_hmac_sha256: cipher_fingerprint(
                KEY,
                b"cipher-secret-value-that-is-long-enough",
            )
            .unwrap(),
            backup_label: "20300102-030410F".into(),
            backup_type: "full".into(),
            backup_lsn_start: "0/1000000".into(),
            backup_lsn_stop: "0/2000000".into(),
            archive_wal_start: "000000010000000000000001".into(),
            archive_wal_stop: "000000010000000000000002".into(),
            marker_a_count: 1,
            marker_b_count: 0,
            archive_mode: "on".into(),
            archive_command: "/usr/local/bin/oort-pgbackrest --stanza=momo archive-push %p".into(),
            archive_timeout_seconds: 60,
            cleanup_container_leaks: 0,
            cleanup_volume_leaks: 0,
        }
    }

    fn expected(payload: &EvidencePayload) -> Expected {
        Expected {
            run_id: payload.run_id.clone(),
            git_commit: payload.git_commit.clone(),
            compose_project: payload.compose_project.clone(),
            source_volume: payload.source_volume.clone(),
            restore_volume: payload.restore_volume.clone(),
            repo_volume: payload.repo_volume.clone(),
            postgres_image_digest: payload.postgres_image_digest.clone(),
            migrate_image_digest: payload.candidate_migrate_image_digest.clone(),
            stanza: payload.stanza.clone(),
            cipher_type: payload.cipher_type.clone(),
            cipher_fingerprint: payload.cipher_fingerprint_hmac_sha256.clone(),
            system_identifier: payload.source_system_identifier.clone(),
        }
    }

    fn signed(payload: &EvidencePayload, key: &[u8]) -> Vec<u8> {
        let mut mac = HmacSha256::new_from_slice(key).unwrap();
        mac.update(HMAC_DOMAIN);
        mac.update(&canonical_payload(payload).unwrap());
        serde_json::to_vec(&serde_json::json!({
            "schema": EVIDENCE_SCHEMA,
            "payload": payload,
            "signature": hex::encode(mac.finalize().into_bytes()),
        }))
        .unwrap()
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2030, 1, 2, 3, 4, 41).single().unwrap()
    }

    fn check(candidate: &EvidencePayload) -> Result<EvidencePayload, MigrateError> {
        let baseline = payload();
        validate(
            &signed(candidate, KEY),
            KEY,
            &expected(&baseline),
            &baseline.migrations_sha256,
            &baseline.cipher_fingerprint_hmac_sha256,
            now(),
        )
    }

    #[test]
    fn authentic_fresh_evidence_passes() {
        assert_eq!(check(&payload()).unwrap().result, "PASS");
    }

    #[test]
    fn a_rotated_repository_cipher_rejects_otherwise_valid_evidence() {
        let baseline = payload();
        let rotated =
            cipher_fingerprint(KEY, b"rotated-cipher-secret-that-is-long-enough").unwrap();
        assert_ne!(rotated, baseline.cipher_fingerprint_hmac_sha256);
        assert!(validate(
            &signed(&baseline, KEY),
            KEY,
            &expected(&baseline),
            &baseline.migrations_sha256,
            &rotated,
            now(),
        )
        .is_err());
    }

    #[test]
    fn evidence_hmac_and_repository_cipher_cannot_share_one_payload() {
        assert!(require_distinct_secrets(KEY, KEY)
            .unwrap_err()
            .to_string()
            .contains("must be distinct"));
        assert!(require_distinct_secrets(KEY, b"different-repository-cipher-value").is_ok());
    }

    #[test]
    fn secrets_changed_during_the_live_probe_are_rejected() {
        let (directory, key_path, cipher_path) = secret_fixture();
        let initial_key = read_hmac_key(&key_path).unwrap();
        let initial_fingerprint =
            cipher_fingerprint(&initial_key, &read_cipher_secret(&cipher_path).unwrap()).unwrap();

        replace_secret(&key_path, b"abcdef0123456789abcdef0123456789");
        assert!(verify_secret_snapshots_unchanged(
            &key_path,
            &cipher_path,
            &initial_key,
            &initial_fingerprint,
        )
        .unwrap_err()
        .to_string()
        .contains("HMAC key changed"));

        replace_secret(&key_path, KEY);
        replace_secret(&cipher_path, b"rotated-cipher-secret-that-is-long-enough");
        assert!(verify_secret_snapshots_unchanged(
            &key_path,
            &cipher_path,
            &initial_key,
            &initial_fingerprint,
        )
        .unwrap_err()
        .to_string()
        .contains("repository cipher changed"));

        fs::remove_file(key_path).unwrap();
        fs::remove_file(cipher_path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn missing_evidence_and_key_are_fail_closed() {
        assert!(
            read_evidence(Path::new("/momo-pitr-v1-definitely-missing/evidence.json")).is_err()
        );
        assert!(read_hmac_key(Path::new("/momo-pitr-v1-definitely-missing/hmac-key")).is_err());
        assert!(read_cipher_secret(Path::new("/momo-pitr-v1-definitely-missing/cipher")).is_err());
    }

    #[test]
    fn migration_manifest_stream_matches_the_cross_language_v1_fixture() {
        // Generated independently with the producer's Python hashlib stream.
        let mut digest = Sha256::new();
        digest.update(b"momo-migrations/v1\n");
        update_migration_digest(&mut digest, b"001_alpha.sql", b"SELECT 1;\n");
        update_migration_digest(&mut digest, b"002_beta.sql", b"-- beta\nSELECT 2;\n");
        assert_eq!(
            hex::encode(digest.finalize()),
            "b2d927e844c4b31023650d108ad34785e2dad15003e80912cabb1dab4d4d60a1"
        );
    }

    #[test]
    fn migration_lineage_rejects_rows_unknown_to_a_rollback_candidate() {
        let migrations = vec![
            Migration {
                version: 1,
                name: "001_alpha.sql".into(),
                path: PathBuf::from("001_alpha.sql"),
            },
            Migration {
                version: 2,
                name: "002_quote's.sql".into(),
                path: PathBuf::from("002_quote's.sql"),
            },
        ];
        assert_eq!(
            migration_lineage_sql(&migrations).unwrap(),
            "SELECT count(*)::text FROM public.schema_migrations WHERE version NOT IN ('001_alpha.sql','002_quote''s.sql');"
        );
        assert!(migration_lineage_sql(&[]).is_err());
        assert!(lineage_tracking_plan("f", "t").is_ok());
        assert!(lineage_tracking_plan("f", "f")
            .unwrap_err()
            .to_string()
            .contains("nonempty public schema is missing migration history"));
        assert!(lineage_tracking_plan("x", "t").is_err());
    }

    #[test]
    fn tamper_forged_unknown_and_duplicate_json_are_rejected() {
        let payload = payload();
        let expected = expected(&payload);
        let mut tampered = signed(&payload, KEY);
        let offset = tampered.windows(4).position(|w| w == b"18.4").unwrap();
        tampered[offset] = b'X';
        assert!(validate(
            &tampered,
            KEY,
            &expected,
            &payload.migrations_sha256,
            &payload.cipher_fingerprint_hmac_sha256,
            now(),
        )
        .unwrap_err()
        .to_string()
        .contains("signature mismatch"));
        assert!(validate(
            br#"{"result":"PASS"}"#,
            KEY,
            &expected,
            &payload.migrations_sha256,
            &payload.cipher_fingerprint_hmac_sha256,
            now()
        )
        .is_err());
        let valid = String::from_utf8(signed(&payload, KEY)).unwrap();
        let unknown = valid.replacen("\"schema\":", "\"unknown\":1,\"schema\":", 1);
        assert!(validate(
            unknown.as_bytes(),
            KEY,
            &expected,
            &payload.migrations_sha256,
            &payload.cipher_fingerprint_hmac_sha256,
            now()
        )
        .is_err());
        let duplicate = valid.replacen("\"schema\":", "\"schema\":\"x\",\"schema\":", 1);
        assert!(validate(
            duplicate.as_bytes(),
            KEY,
            &expected,
            &payload.migrations_sha256,
            &payload.cipher_fingerprint_hmac_sha256,
            now()
        )
        .is_err());
    }

    #[test]
    fn mixed_host_and_pg_clock_chronology_is_rejected() {
        let mut candidate = payload();
        // Host UTC sampled after a slower PG backup clock: started_at >
        // source_backup_completed_at is the false-RED shape.
        candidate.started_at = "2030-01-02T03:04:11.000000Z".into();
        candidate.source_backup_completed_at = "2030-01-02T03:04:10.000000Z".into();
        candidate.duration_seconds = 29;
        assert!(check(&candidate)
            .unwrap_err()
            .to_string()
            .contains("timestamp chronology invalid"));
    }

    #[test]
    fn pg_clock_equal_adjacent_timestamps_are_accepted() {
        let mut candidate = payload();
        candidate.started_at = "2030-01-02T03:04:10.000000Z".into();
        candidate.source_backup_completed_at = "2030-01-02T03:04:10.000000Z".into();
        candidate.recovery_target_time = "2030-01-02T03:04:20.123456Z".into();
        candidate.restored_at = "2030-01-02T03:04:30.123456Z".into();
        candidate.completed_at = "2030-01-02T03:04:40.000000Z".into();
        candidate.duration_seconds = 30;
        assert_eq!(check(&candidate).unwrap().result, "PASS");
    }

    #[test]
    fn recovery_target_must_strictly_precede_restored_at() {
        let mut candidate = payload();
        candidate.recovery_target_time = "2030-01-02T03:04:30.000000Z".into();
        candidate.restored_at = "2030-01-02T03:04:30.000000Z".into();
        assert!(check(&candidate)
            .unwrap_err()
            .to_string()
            .contains("timestamp chronology invalid"));
    }

    #[test]
    fn expired_future_and_fail_results_are_rejected() {
        let mut fail = payload();
        fail.result = "FAIL".into();
        assert!(check(&fail).is_err());
        let baseline = payload();
        let expected = expected(&baseline);
        let expired = Utc.with_ymd_and_hms(2030, 1, 2, 3, 20, 0).single().unwrap();
        assert!(validate(
            &signed(&baseline, KEY),
            KEY,
            &expected,
            &baseline.migrations_sha256,
            &baseline.cipher_fingerprint_hmac_sha256,
            expired
        )
        .is_err());
        let future = Utc.with_ymd_and_hms(2030, 1, 2, 3, 4, 39).single().unwrap();
        assert!(validate(
            &signed(&baseline, KEY),
            KEY,
            &expected,
            &baseline.migrations_sha256,
            &baseline.cipher_fingerprint_hmac_sha256,
            future
        )
        .is_err());
    }

    #[test]
    fn every_expected_binding_is_fail_closed() {
        let baseline = payload();
        let cases: Vec<Mutation> = vec![
            ("run", Box::new(|p| p.run_id = "foreign-run-123456".into())),
            ("git", Box::new(|p| p.git_commit = repeated('e', 40))),
            (
                "project",
                Box::new(|p| p.compose_project = "foreign".into()),
            ),
            (
                "source",
                Box::new(|p| p.source_volume = "foreign-source".into()),
            ),
            (
                "restore",
                Box::new(|p| p.restore_volume = "foreign-restore".into()),
            ),
            ("repo", Box::new(|p| p.repo_volume = "foreign-repo".into())),
            (
                "image",
                Box::new(|p| {
                    p.postgres_image_digest = format!("sha256:{}", repeated('e', 64));
                    p.postgres_image_ref = format!("x@{}", p.postgres_image_digest);
                }),
            ),
            (
                "candidate",
                Box::new(|p| {
                    p.candidate_migrate_image_digest = format!("sha256:{}", repeated('e', 64))
                }),
            ),
            (
                "migrations",
                Box::new(|p| p.migrations_sha256 = repeated('e', 64)),
            ),
            ("stanza", Box::new(|p| p.stanza = "foreign".into())),
            ("cipher", Box::new(|p| p.cipher_type = "none".into())),
            (
                "cipher fingerprint",
                Box::new(|p| p.cipher_fingerprint_hmac_sha256 = repeated('e', 64)),
            ),
            (
                "system",
                Box::new(|p| {
                    p.source_system_identifier = "123".into();
                    p.restore_system_identifier = "123".into();
                }),
            ),
        ];
        for (name, mutation) in cases {
            let mut candidate = baseline.clone();
            mutation(&mut candidate);
            assert!(check(&candidate).is_err(), "{name}");
        }
    }

    #[test]
    fn active_target_markers_archive_and_cleanup_are_fail_closed() {
        let mut same = payload();
        same.restore_volume = same.source_volume.clone();
        let expected = expected(&same);
        assert!(validate(
            &signed(&same, KEY),
            KEY,
            &expected,
            &same.migrations_sha256,
            &same.cipher_fingerprint_hmac_sha256,
            now()
        )
        .is_err());
        let mutations: [fn(&mut EvidencePayload); 9] = [
            |p| p.marker_a_count = 0,
            |p| p.marker_b_count = 1,
            |p| p.archive_mode = "off".into(),
            |p| p.archive_timeout_seconds = 0,
            |p| p.cleanup_container_leaks = 1,
            |p| p.cleanup_volume_leaks = 1,
            |p| p.backup_label.clear(),
            |p| p.archive_wal_start.clear(),
            |p| p.backup_lsn_stop = "not-an-lsn".into(),
        ];
        for mutation in mutations {
            let mut candidate = payload();
            mutation(&mut candidate);
            assert!(check(&candidate).is_err());
        }
    }

    #[test]
    fn protected_and_unknown_environments_cannot_disable_gate() {
        for protected in ["staging", "production"] {
            assert!(policy_plan(Some(protected), false, false).is_err());
        }
        for unknown in [
            None,
            Some("prodction"),
            Some("prod"),
            Some("internal-host"),
            Some("local"),
            Some(" production "),
            Some(""),
        ] {
            assert!(policy_plan(unknown, false, false).is_err());
            assert!(policy_plan(unknown, true, false).is_err());
            assert!(policy_plan(unknown, false, true).is_err());
        }
        assert_eq!(
            policy_plan(Some("development"), false, false),
            Ok("development")
        );
        assert_eq!(policy_plan(Some("test"), false, false), Ok("development"));
        assert_eq!(policy_plan(Some("production"), true, false), Ok("evidence"));
        assert_eq!(
            policy_plan(Some("production"), false, true),
            Ok("bootstrap")
        );
        assert!(policy_plan(Some("production"), true, true).is_err());
    }

    #[test]
    fn pitr_policy_flags_are_exact_zero_or_one() {
        assert_eq!(parse_policy_flag("FLAG", None), Ok(false));
        assert_eq!(parse_policy_flag("FLAG", Some("0")), Ok(false));
        assert_eq!(parse_policy_flag("FLAG", Some("1")), Ok(true));
        for invalid in ["", " 0", "1 ", "true", "2"] {
            assert!(parse_policy_flag("FLAG", Some(invalid)).is_err());
        }
    }
}
