//! Human-admin lifecycle primitives for generic per-agent bearer credentials.
//!
//! The `token` table is sufficient for issue/list/rotate/revoke, so this module
//! adds no schema and keeps every `token` mutation beside the existing
//! authentication lookup. Callers supply an already tenant-scoped connection
//! and write the corresponding audit row before committing the same
//! transaction.
//!
//! Two details are security boundaries rather than implementation choices:
//!
//! * issuance locks the target `agent` row before shortening predecessors and
//!   inserting the successor. Concurrent rotations therefore serialize; after
//!   they finish, at most the last successor retains its requested lifetime;
//! * [`AgentCredentialMutationPolicy`] is the typed seam HAP-E3 will widen when
//!   a dedicated hosted connection exists. Generic routes already handle the
//!   `HostedConnectionManaged` verdict as a conflict, without teaching token
//!   SQL about the future connection table today.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::AGENT_BEARER_PREFIX;

/// Existing generic credentials keep their conversational/gateway defaults.
///
/// ADR-0162 deliberately removes `messages:read` from the default set. It and
/// the two Agent Port read/reachability scopes are grantable only when a human
/// names them explicitly.
pub const DEFAULT_AGENT_CREDENTIAL_SCOPES: [&str; 5] = [
    "agent:jobs:read",
    "agent:runs:callback",
    "messages:write",
    "realtime:subscribe",
    "work:control",
];

const GRANTABLE_AGENT_CREDENTIAL_SCOPES: [&str; 9] = [
    "agent:jobs:read",
    "agent:runs:callback",
    "messages:read",
    "messages:write",
    "realtime:subscribe",
    "work:control",
    "provider:quota:write",
    "agent:port:connect",
    "agent:inbox:read",
];

const PROVIDER_QUOTA_WRITE_SCOPE: &str = "provider:quota:write";
pub const DEFAULT_AGENT_CREDENTIAL_LABEL: &str = "agent bearer";
pub const DEFAULT_ROTATION_GRACE_SECONDS: i64 = 24 * 60 * 60;
pub const MAXIMUM_ROTATION_GRACE_SECONDS: i64 = 7 * 24 * 60 * 60;
const MAXIMUM_LABEL_CHARACTERS: usize = 120;
const MAXIMUM_REASON_CHARACTERS: usize = 500;
const SECRET_BYTES: usize = 32;
const LIST_LIMIT: i64 = 100;

pub const AUDIT_ACTION_ISSUED: &str = "agent.credential.issued";
pub const AUDIT_ACTION_REVOKED: &str = "agent.credential.revoked";
pub const AUDIT_SCHEMA_ISSUED: &str = "momo.agent_credential.issued.v1";
pub const AUDIT_SCHEMA_REVOKED: &str = "momo.agent_credential.revoked.v1";
pub const HOSTED_CONNECTION_MANAGED_CODE: &str = "hosted_connection_managed";

/// How generic credential mutations are managed for one active agent.
///
/// HAP-E1 can only observe generic agents because the connection table does not
/// exist yet. HAP-E3 changes the single loader below to return the hosted arm;
/// handlers already fail that arm closed with HTTP 409.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentCredentialMutationPolicy {
    Generic,
    HostedConnectionManaged,
}

impl AgentCredentialMutationPolicy {
    pub fn allows_generic_mutation(self) -> bool {
        matches!(self, Self::Generic)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentCredentialStatus {
    Active,
    Expired,
    Revoked,
}

impl AgentCredentialStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Expired => "expired",
            Self::Revoked => "revoked",
        }
    }
}

/// Credential metadata safe to project. It intentionally has no hash, prefix,
/// secret, or token field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCredentialRecord {
    pub id: Uuid,
    pub agent_member_id: Uuid,
    pub status: AgentCredentialStatus,
    pub scopes: Vec<String>,
    pub label: Option<String>,
    pub last_used_at_ms: Option<i64>,
    pub expires_at_ms: Option<i64>,
    pub revoked_at_ms: Option<i64>,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCredentialIssuance {
    pub credential: AgentCredentialRecord,
    pub rotated_credential_count: usize,
    pub rotation_grace_ends_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCredentialRevocation {
    pub credential: AgentCredentialRecord,
    pub revoked_now: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentCredentialMutation<T> {
    Applied(T),
    AgentNotFound,
    CredentialNotFound,
    ExpiryNotFuture,
    HostedConnectionManaged,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AgentCredentialInputError {
    #[error("at least one agent scope is required")]
    EmptyScopes,
    #[error("unsupported agent scope")]
    UnsupportedScope,
    #[error("label must contain 1...120 characters")]
    InvalidLabel,
    #[error("expiresAtMs must be in the future")]
    InvalidExpiry,
    #[error("rotationGraceSeconds must be between 0 and 604800")]
    InvalidRotationGrace,
    #[error("reason must be at most 500 characters")]
    InvalidReason,
    #[error("credential material is forbidden in metadata")]
    CredentialMaterialForbidden,
}

#[derive(Debug, thiserror::Error)]
pub enum AgentCredentialIssueError {
    #[error("operating-system entropy unavailable")]
    EntropyUnavailable,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// Normalize a closed, stable, de-duplicated scope list.
pub fn normalized_agent_credential_scopes(
    raw: Option<&[String]>,
) -> Result<Vec<String>, AgentCredentialInputError> {
    let input: Vec<&str> = match raw {
        Some(values) => values.iter().map(String::as_str).collect(),
        None => DEFAULT_AGENT_CREDENTIAL_SCOPES.to_vec(),
    };
    let mut normalized = Vec::with_capacity(input.len());
    for value in input {
        let scope = value.trim().to_ascii_lowercase();
        if scope.is_empty() {
            return Err(AgentCredentialInputError::EmptyScopes);
        }
        if !GRANTABLE_AGENT_CREDENTIAL_SCOPES.contains(&scope.as_str()) {
            return Err(AgentCredentialInputError::UnsupportedScope);
        }
        if !normalized.iter().any(|existing| existing == &scope) {
            normalized.push(scope);
        }
    }
    if normalized.is_empty() {
        return Err(AgentCredentialInputError::EmptyScopes);
    }
    Ok(normalized)
}

pub fn agent_credential_requires_instance_operator(scopes: &[String]) -> bool {
    scopes
        .iter()
        .any(|scope| scope == PROVIDER_QUOTA_WRITE_SCOPE)
}

fn contains_agent_bearer_material(value: &str) -> bool {
    value
        .to_ascii_lowercase()
        .contains(&format!("{AGENT_BEARER_PREFIX}."))
}

pub fn normalized_agent_credential_label(
    raw: Option<&str>,
) -> Result<String, AgentCredentialInputError> {
    let value = raw.unwrap_or(DEFAULT_AGENT_CREDENTIAL_LABEL).trim();
    let length = value.chars().count();
    if length == 0 || length > MAXIMUM_LABEL_CHARACTERS {
        return Err(AgentCredentialInputError::InvalidLabel);
    }
    if contains_agent_bearer_material(value) {
        return Err(AgentCredentialInputError::CredentialMaterialForbidden);
    }
    Ok(value.to_string())
}

pub fn normalized_agent_credential_reason(
    raw: Option<&str>,
) -> Result<Option<String>, AgentCredentialInputError> {
    let Some(raw) = raw else { return Ok(None) };
    let value = raw.trim();
    if value.chars().count() > MAXIMUM_REASON_CHARACTERS {
        return Err(AgentCredentialInputError::InvalidReason);
    }
    if contains_agent_bearer_material(value) {
        return Err(AgentCredentialInputError::CredentialMaterialForbidden);
    }
    Ok((!value.is_empty()).then(|| value.to_string()))
}

pub fn validated_agent_credential_expiry(
    expires_at_ms: Option<i64>,
    now_ms: i64,
) -> Result<Option<i64>, AgentCredentialInputError> {
    if expires_at_ms.is_some_and(|expires| expires <= now_ms) {
        return Err(AgentCredentialInputError::InvalidExpiry);
    }
    Ok(expires_at_ms)
}

pub fn validated_rotation_grace_seconds(
    raw: Option<i64>,
) -> Result<i64, AgentCredentialInputError> {
    let value = raw.unwrap_or(DEFAULT_ROTATION_GRACE_SECONDS);
    if !(0..=MAXIMUM_ROTATION_GRACE_SECONDS).contains(&value) {
        return Err(AgentCredentialInputError::InvalidRotationGrace);
    }
    Ok(value)
}

/// Mint the established opaque envelope. The secret is 32 bytes from the OS
/// CSPRNG and is never returned by any lookup function in this module.
pub fn mint_agent_bearer(workspace_id: Uuid) -> Result<String, AgentCredentialIssueError> {
    let mut secret = [0_u8; SECRET_BYTES];
    getrandom::getrandom(&mut secret).map_err(|_| AgentCredentialIssueError::EntropyUnavailable)?;
    Ok(format!(
        "{AGENT_BEARER_PREFIX}.{}.{}",
        workspace_id.to_string().to_ascii_lowercase(),
        URL_SAFE_NO_PAD.encode(secret)
    ))
}

/// Lock and classify the active target agent.
///
/// The row lock is the rotation mutex. HAP-E3 extends this one query to classify
/// an attached hosted connection and returns `HostedConnectionManaged` without
/// changing the generic route contract.
async fn lock_agent_credential_target(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<AgentCredentialMutationPolicy>, sqlx::Error> {
    let found: Option<bool> = sqlx::query_scalar(
        "SELECT (hc.id IS NOT NULL) \
           FROM agent a \
           JOIN member m ON m.workspace_id = a.workspace_id AND m.id = a.member_id \
           LEFT JOIN hosted_agent_connection hc \
             ON hc.workspace_id = a.workspace_id AND hc.agent_member_id = a.member_id \
          WHERE a.workspace_id = $1 AND a.member_id = $2 \
            AND m.kind = 'agent' AND m.status = 'active' AND m.deleted_at IS NULL \
          FOR UPDATE OF a",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.map(|hosted| {
        if hosted {
            AgentCredentialMutationPolicy::HostedConnectionManaged
        } else {
            AgentCredentialMutationPolicy::Generic
        }
    }))
}

pub async fn agent_credential_mutation_policy_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<AgentCredentialMutationPolicy>, sqlx::Error> {
    lock_agent_credential_target(conn, workspace_id, agent_member_id).await
}

pub async fn active_agent_for_credential_list(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT 1 \
           FROM agent a \
           JOIN member m ON m.workspace_id = a.workspace_id AND m.id = a.member_id \
          WHERE a.workspace_id = $1 AND a.member_id = $2 \
            AND m.kind = 'agent' AND m.status = 'active' AND m.deleted_at IS NULL \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

const SAFE_PROJECTION: &str = "id, actor_member_id, scopes, label, \
    (EXTRACT(EPOCH FROM last_used_at) * 1000)::bigint AS last_used_at_ms, \
    (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms, \
    (EXTRACT(EPOCH FROM revoked_at) * 1000)::bigint AS revoked_at_ms, \
    (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_at_ms";

fn decode_record(row: &sqlx::postgres::PgRow) -> Result<AgentCredentialRecord, sqlx::Error> {
    let revoked_at_ms: Option<i64> = row.try_get("revoked_at_ms")?;
    let expires_at_ms: Option<i64> = row.try_get("expires_at_ms")?;
    let status = if revoked_at_ms.is_some() {
        AgentCredentialStatus::Revoked
    } else if expires_at_ms.is_some_and(|expires| expires <= unix_time_ms()) {
        AgentCredentialStatus::Expired
    } else {
        AgentCredentialStatus::Active
    };
    Ok(AgentCredentialRecord {
        id: row.try_get("id")?,
        agent_member_id: row.try_get("actor_member_id")?,
        status,
        scopes: row.try_get("scopes")?,
        label: row.try_get("label")?,
        last_used_at_ms: row.try_get("last_used_at_ms")?,
        expires_at_ms,
        revoked_at_ms,
        created_at_ms: row.try_get("created_at_ms")?,
    })
}

fn unix_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// Issue a successor after atomically shortening every live predecessor.
#[allow(clippy::too_many_arguments)]
pub async fn issue_agent_credential_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    created_by: Uuid,
    raw_token: &str,
    scopes: &[String],
    label: &str,
    expires_at_ms: Option<i64>,
    rotation_grace_seconds: i64,
) -> Result<AgentCredentialMutation<AgentCredentialIssuance>, sqlx::Error> {
    let Some(policy) = lock_agent_credential_target(conn, workspace_id, agent_member_id).await?
    else {
        return Ok(AgentCredentialMutation::AgentNotFound);
    };
    if !policy.allows_generic_mutation() {
        return Ok(AgentCredentialMutation::HostedConnectionManaged);
    }

    let grace_ends_at_ms: i64 = sqlx::query_scalar(
        "SELECT (EXTRACT(EPOCH FROM clock_timestamp() \
                + ($1::bigint * interval '1 second')) * 1000)::bigint",
    )
    .bind(rotation_grace_seconds)
    .fetch_one(&mut *conn)
    .await?;

    let sql = format!(
        "WITH validity AS ( \
             SELECT $6::bigint IS NULL \
                 OR to_timestamp($6::double precision / 1000.0) > clock_timestamp() \
                    AS is_valid \
         ), rotated AS ( \
             UPDATE token \
                SET expires_at = CASE \
                      WHEN expires_at IS NULL \
                        OR expires_at > to_timestamp($8::double precision / 1000.0) \
                        THEN to_timestamp($8::double precision / 1000.0) \
                      ELSE expires_at \
                    END \
              WHERE workspace_id = $1 \
                AND actor_member_id = $2 \
                AND kind = 'agent_bearer' \
                AND revoked_at IS NULL \
                AND (expires_at IS NULL OR expires_at > clock_timestamp()) \
                AND (SELECT is_valid FROM validity) \
            RETURNING id \
         ), inserted AS ( \
             INSERT INTO token \
               (workspace_id, kind, actor_member_id, subject_member_id, token_hash, \
                scopes, label, expires_at, created_by) \
             SELECT $1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                    $4, $5, \
                    CASE WHEN $6::bigint IS NULL THEN NULL \
                         ELSE to_timestamp($6::double precision / 1000.0) END, \
                    $7 \
               FROM validity \
              WHERE is_valid \
            RETURNING {SAFE_PROJECTION} \
         ) \
         SELECT inserted.*, \
                (SELECT COUNT(*)::bigint FROM rotated) AS rotated_credential_count \
           FROM inserted"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(agent_member_id)
        .bind(raw_token)
        .bind(scopes)
        .bind(label)
        .bind(expires_at_ms)
        .bind(created_by)
        .bind(grace_ends_at_ms)
        .fetch_optional(&mut *conn)
        .await?;

    // Validation, predecessor shortening, and insert share one statement. A
    // request that expires while waiting for the agent lock therefore mutates
    // neither the predecessor set nor the token table.
    let Some(row) = row else {
        return Ok(AgentCredentialMutation::ExpiryNotFuture);
    };
    let rotated_credential_count: i64 = row.try_get("rotated_credential_count")?;
    let rotated_credential_count = usize::try_from(rotated_credential_count)
        .map_err(|_| sqlx::Error::Decode("negative rotated credential count".into()))?;
    Ok(AgentCredentialMutation::Applied(AgentCredentialIssuance {
        credential: decode_record(&row)?,
        rotated_credential_count,
        rotation_grace_ends_at_ms: (rotated_credential_count > 0).then_some(grace_ends_at_ms),
    }))
}

pub async fn list_agent_credentials_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Vec<AgentCredentialRecord>, sqlx::Error> {
    let sql = format!(
        "SELECT {SAFE_PROJECTION} \
           FROM token \
          WHERE workspace_id = $1 \
            AND actor_member_id = $2 \
            AND kind = 'agent_bearer' \
          ORDER BY created_at DESC, id DESC \
          LIMIT {LIST_LIMIT}"
    );
    sqlx::query(&sql)
        .bind(workspace_id)
        .bind(agent_member_id)
        .fetch_all(&mut *conn)
        .await?
        .iter()
        .map(decode_record)
        .collect()
}

pub async fn revoke_agent_credential_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    credential_id: Uuid,
) -> Result<AgentCredentialMutation<AgentCredentialRevocation>, sqlx::Error> {
    let Some(policy) = lock_agent_credential_target(conn, workspace_id, agent_member_id).await?
    else {
        return Ok(AgentCredentialMutation::AgentNotFound);
    };
    if !policy.allows_generic_mutation() {
        return Ok(AgentCredentialMutation::HostedConnectionManaged);
    }

    let sql = format!(
        "UPDATE token SET revoked_at = now() \
          WHERE id = $1 AND workspace_id = $2 AND actor_member_id = $3 \
            AND kind = 'agent_bearer' AND revoked_at IS NULL \
        RETURNING {SAFE_PROJECTION}"
    );
    if let Some(row) = sqlx::query(&sql)
        .bind(credential_id)
        .bind(workspace_id)
        .bind(agent_member_id)
        .fetch_optional(&mut *conn)
        .await?
    {
        return Ok(AgentCredentialMutation::Applied(
            AgentCredentialRevocation {
                credential: decode_record(&row)?,
                revoked_now: true,
            },
        ));
    }

    let sql = format!(
        "SELECT {SAFE_PROJECTION} FROM token \
          WHERE id = $1 AND workspace_id = $2 AND actor_member_id = $3 \
            AND kind = 'agent_bearer' LIMIT 1"
    );
    let Some(row) = sqlx::query(&sql)
        .bind(credential_id)
        .bind(workspace_id)
        .bind(agent_member_id)
        .fetch_optional(&mut *conn)
        .await?
    else {
        return Ok(AgentCredentialMutation::CredentialNotFound);
    };
    Ok(AgentCredentialMutation::Applied(
        AgentCredentialRevocation {
            credential: decode_record(&row)?,
            revoked_now: false,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_do_not_silently_grant_agent_port_reads() {
        let defaults = normalized_agent_credential_scopes(None).unwrap();
        for non_default in [
            "agent:port:connect",
            "agent:inbox:read",
            "messages:read",
            "provider:quota:write",
        ] {
            assert!(!defaults.iter().any(|scope| scope == non_default));
        }
    }

    #[test]
    fn explicit_scopes_are_closed_normalized_and_deduplicated() {
        let scopes = vec![
            " Messages:Read ".to_string(),
            "messages:read".to_string(),
            "agent:port:connect".to_string(),
        ];
        assert_eq!(
            normalized_agent_credential_scopes(Some(&scopes)).unwrap(),
            vec!["messages:read", "agent:port:connect"]
        );
        assert_eq!(
            normalized_agent_credential_scopes(Some(&[])),
            Err(AgentCredentialInputError::EmptyScopes)
        );
        assert_eq!(
            normalized_agent_credential_scopes(Some(&[
                "messages:read".to_string(),
                " ".to_string(),
            ])),
            Err(AgentCredentialInputError::EmptyScopes)
        );
        assert_eq!(
            normalized_agent_credential_scopes(Some(&["future:scope".to_string()])),
            Err(AgentCredentialInputError::UnsupportedScope)
        );
    }

    #[test]
    fn privileged_scope_is_never_implicit() {
        let ordinary = normalized_agent_credential_scopes(None).unwrap();
        assert!(!agent_credential_requires_instance_operator(&ordinary));
        assert!(agent_credential_requires_instance_operator(&[
            PROVIDER_QUOTA_WRITE_SCOPE.to_string()
        ]));
    }

    #[test]
    fn metadata_cannot_become_a_second_secret_projection() {
        let workspace = Uuid::from_u128(7);
        let raw = format!("{AGENT_BEARER_PREFIX}.{workspace}.{}", "a".repeat(43));
        assert_eq!(
            normalized_agent_credential_label(Some(&raw)),
            Err(AgentCredentialInputError::CredentialMaterialForbidden)
        );
        assert_eq!(
            normalized_agent_credential_reason(Some(&format!("lost {raw}"))),
            Err(AgentCredentialInputError::CredentialMaterialForbidden)
        );
    }

    #[test]
    fn expiry_and_grace_are_bounded() {
        assert_eq!(
            validated_agent_credential_expiry(Some(99), 100),
            Err(AgentCredentialInputError::InvalidExpiry)
        );
        assert_eq!(
            validated_agent_credential_expiry(Some(101), 100),
            Ok(Some(101))
        );
        assert_eq!(validated_rotation_grace_seconds(None), Ok(86_400));
        assert_eq!(validated_rotation_grace_seconds(Some(0)), Ok(0));
        assert_eq!(
            validated_rotation_grace_seconds(Some(MAXIMUM_ROTATION_GRACE_SECONDS + 1)),
            Err(AgentCredentialInputError::InvalidRotationGrace)
        );
    }

    #[test]
    fn minted_token_has_the_existing_envelope_and_32_byte_secret() {
        let workspace = Uuid::from_u128(9);
        let raw = mint_agent_bearer(workspace).unwrap();
        assert_eq!(crate::agent_bearer_workspace_id(&raw), Some(workspace));
        let secret = raw.rsplit('.').next().unwrap();
        assert_eq!(URL_SAFE_NO_PAD.decode(secret).unwrap().len(), SECRET_BYTES);
    }

    #[test]
    fn hosted_policy_is_a_closed_conflict_seam() {
        assert!(AgentCredentialMutationPolicy::Generic.allows_generic_mutation());
        assert!(!AgentCredentialMutationPolicy::HostedConnectionManaged.allows_generic_mutation());
    }
}
