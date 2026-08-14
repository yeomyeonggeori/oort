//! ADR-0162 hosted-agent static-bearer pairing and activation ledger.
//!
//! This is the sole owner of hosted connection/challenge/token SQL. Callers
//! supply a tenant-scoped transaction and write their audit row before commit.
//! Raw material is generated locally, hashed by PostgreSQL, and returned only
//! from the create/regenerate/confirm mutation that minted it.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde_json::{Map, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::{mint_agent_bearer, AgentBearerIdentity};

pub const HOSTED_PAIRING_PREFIX: &str = "momo_pair_v1";
pub const HOSTED_AGENT_PORT_AUDIENCE: &str = "/v1/mcp/agent-port";
pub const HOSTED_PAIRING_TTL_SECONDS: i64 = 15 * 60;
pub const HOSTED_AGENT_MODEL: &str = "hosted-agent";
pub const HOSTED_AGENT_INERT_BASE_URL: &str = "https://hosted-agent.invalid/disabled";
pub const HOSTED_AGENT_SCOPES: [&str; 6] = [
    "agent:port:connect",
    "agent:inbox:read",
    "messages:read",
    "messages:write",
    "agent:jobs:read",
    "agent:runs:callback",
];

const SECRET_BYTES: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedConnection {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub agent_member_id: Uuid,
    pub status: String,
    pub auth_mode: String,
    pub audience: String,
    pub detected_client_name: Option<String>,
    pub detected_client_version: Option<String>,
    pub approved_channel_ids: Vec<Uuid>,
    pub approved_scopes: Vec<String>,
    pub active_token_id: Option<Uuid>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedPairingIssuance {
    pub connection: HostedConnection,
    pub pairing_credential: String,
    pub pairing_expires_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedActivationIssuance {
    pub connection: HostedConnection,
    pub credential_id: Uuid,
    pub credential: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedConnectionApproval {
    pub agent_member_id: Uuid,
    pub auth_mode: String,
    pub audience: String,
    pub channel_ids: Vec<Uuid>,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostedMutation<T> {
    Applied(T),
    NotFound,
    WrongState,
    InvalidApproval,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostedProof {
    Rejected,
    Allowed,
    Activated,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HostedInputError {
    #[error("authMode must equal static_bearer")]
    AuthMode,
    #[error("hosted scopes must be a non-empty subset of the closed hosted scope set and include agent:port:connect")]
    Scopes,
    #[error("approvedChannelIds must be unique")]
    Channels,
    #[error("detected client metadata exceeds the hosted pairing bounds")]
    Observation,
    #[error("credential entropy unavailable")]
    Entropy,
}

pub fn validate_hosted_scopes(scopes: &[String]) -> Result<Vec<String>, HostedInputError> {
    if scopes.is_empty() {
        return Err(HostedInputError::Scopes);
    }
    let mut normalized = Vec::with_capacity(scopes.len());
    for scope in scopes {
        let scope = scope.trim();
        if !HOSTED_AGENT_SCOPES.contains(&scope) || normalized.iter().any(|item| item == scope) {
            return Err(HostedInputError::Scopes);
        }
        normalized.push(scope.to_string());
    }
    if !normalized.iter().any(|scope| scope == "agent:port:connect") {
        return Err(HostedInputError::Scopes);
    }
    Ok(normalized)
}

pub fn validate_channel_ids(channels: &[Uuid]) -> Result<(), HostedInputError> {
    let mut sorted = channels.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    if sorted.len() == channels.len() {
        Ok(())
    } else {
        Err(HostedInputError::Channels)
    }
}

pub fn pairing_workspace_id(raw: &str) -> Option<Uuid> {
    let mut parts = raw.split('.');
    let prefix = parts.next()?;
    let workspace = parts.next()?;
    let secret = parts.next()?;
    if prefix != HOSTED_PAIRING_PREFIX
        || parts.next().is_some()
        || secret.len() < 43
        || !secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    Uuid::parse_str(workspace).ok()
}

fn mint_pairing(workspace_id: Uuid) -> Result<String, HostedInputError> {
    let mut secret = [0_u8; SECRET_BYTES];
    getrandom::getrandom(&mut secret).map_err(|_| HostedInputError::Entropy)?;
    Ok(format!(
        "{HOSTED_PAIRING_PREFIX}.{}.{}",
        workspace_id.to_string().to_ascii_lowercase(),
        URL_SAFE_NO_PAD.encode(secret)
    ))
}

const PROJECTION: &str = "id, workspace_id, agent_member_id, status, auth_mode, audience, \
    detected_client_name, detected_client_version, approved_channel_ids, approved_scopes, \
    active_token_id, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_at_ms, \
    (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_at_ms";

fn decode(row: &sqlx::postgres::PgRow) -> Result<HostedConnection, sqlx::Error> {
    Ok(HostedConnection {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        agent_member_id: row.try_get("agent_member_id")?,
        status: row.try_get("status")?,
        auth_mode: row.try_get("auth_mode")?,
        audience: row.try_get("audience")?,
        detected_client_name: row.try_get("detected_client_name")?,
        detected_client_version: row.try_get("detected_client_version")?,
        approved_channel_ids: row.try_get("approved_channel_ids")?,
        approved_scopes: row.try_get("approved_scopes")?,
        active_token_id: row.try_get("active_token_id")?,
        created_at_ms: row.try_get("created_at_ms")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

pub async fn create_hosted_connection_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    created_by: Uuid,
) -> Result<HostedPairingIssuance, sqlx::Error> {
    let raw =
        mint_pairing(workspace_id).map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
    let sql = format!(
        "INSERT INTO hosted_agent_connection \
           (workspace_id, agent_member_id, pairing_challenge_hash, pairing_expires_at, created_by) \
         VALUES ($1, $2, digest($3::text, 'sha256'), now() + ($4::bigint * interval '1 second'), $5) \
         RETURNING {PROJECTION}, \
           (EXTRACT(EPOCH FROM pairing_expires_at) * 1000)::bigint AS pairing_expires_at_ms"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(agent_member_id)
        .bind(&raw)
        .bind(HOSTED_PAIRING_TTL_SECONDS)
        .bind(created_by)
        .fetch_one(&mut *conn)
        .await?;
    Ok(HostedPairingIssuance {
        connection: decode(&row)?,
        pairing_credential: raw,
        pairing_expires_at_ms: row.try_get("pairing_expires_at_ms")?,
    })
}

pub async fn get_hosted_connection_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
) -> Result<Option<HostedConnection>, sqlx::Error> {
    let sql = format!(
        "SELECT {PROJECTION} FROM hosted_agent_connection WHERE workspace_id = $1 AND id = $2"
    );
    sqlx::query(&sql)
        .bind(workspace_id)
        .bind(connection_id)
        .fetch_optional(&mut *conn)
        .await?
        .as_ref()
        .map(decode)
        .transpose()
}

pub async fn list_hosted_connections_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Vec<HostedConnection>, sqlx::Error> {
    let sql = format!(
        "SELECT {PROJECTION} FROM hosted_agent_connection WHERE workspace_id = $1 \
         ORDER BY created_at DESC, id DESC LIMIT 100"
    );
    sqlx::query(&sql)
        .bind(workspace_id)
        .fetch_all(&mut *conn)
        .await?
        .iter()
        .map(decode)
        .collect()
}

pub async fn regenerate_pairing_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
) -> Result<HostedMutation<HostedPairingIssuance>, sqlx::Error> {
    let raw =
        mint_pairing(workspace_id).map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
    let locked_status: Option<String> = sqlx::query_scalar(
        "SELECT status::text FROM hosted_agent_connection \
          WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_optional(&mut *conn)
    .await?;
    match locked_status.as_deref() {
        None => return Ok(HostedMutation::NotFound),
        Some("pairing_pending" | "detected" | "expired") => {}
        Some(_) => return Ok(HostedMutation::WrongState),
    }
    // This must be a statement after the connection lock. A data-modifying CTE
    // would retain the snapshot from before a concurrent confirm finished and
    // could miss the token that confirm inserted while regeneration waited.
    sqlx::query(
        "UPDATE token SET revoked_at = COALESCE(revoked_at, now()) \
          WHERE workspace_id = $1 AND hosted_connection_id = $2 AND revoked_at IS NULL",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .execute(&mut *conn)
    .await?;
    let sql = format!(
        "UPDATE hosted_agent_connection SET status = 'pairing_pending', \
           pairing_challenge_hash = digest($3::text, 'sha256'), \
           pairing_expires_at = now() + ($4::bigint * interval '1 second'), \
           pairing_consumed_at = NULL, detected_at = NULL, detected_by = NULL, detected_client_name = NULL, \
           detected_client_version = NULL, detected_capabilities = '{{}}'::jsonb, \
           confirmed_by = NULL, confirmed_at = NULL, approved_channel_ids = '{{}}', \
           approved_scopes = '{{}}', active_token_id = NULL, proved_at = NULL, proved_by = NULL, updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 \
          RETURNING {PROJECTION}, \
           (EXTRACT(EPOCH FROM pairing_expires_at) * 1000)::bigint AS pairing_expires_at_ms"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(connection_id)
        .bind(&raw)
        .bind(HOSTED_PAIRING_TTL_SECONDS)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else {
        return Ok(HostedMutation::NotFound);
    };
    Ok(HostedMutation::Applied(HostedPairingIssuance {
        connection: decode(&row)?,
        pairing_credential: raw,
        pairing_expires_at_ms: row.try_get("pairing_expires_at_ms")?,
    }))
}

pub async fn detect_pairing_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    raw: &str,
    _client_name: Option<&str>,
    _client_version: Option<&str>,
    capabilities: &Value,
) -> Result<HostedMutation<AgentBearerIdentity>, sqlx::Error> {
    // Raw clientInfo is never persisted. Even a plausible name/version is an
    // untrusted string channel and cannot be proven non-secret. Protocol era
    // and foundation method are already server-derived elsewhere; only the
    // finite boolean capability projection below is retained.
    let client_name: Option<String> = None;
    let client_version: Option<String> = None;
    let capabilities = sanitize_capabilities(capabilities);
    let live_member: Option<Uuid> = sqlx::query_scalar(
        "SELECT agent_member_id FROM hosted_agent_connection \
          WHERE workspace_id=$1 AND status='pairing_pending' \
            AND pairing_challenge_hash=digest($2::text, 'sha256') FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(raw)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(agent_member_id) = live_member {
        if !hosted_identity_is_live_in_tx(conn, workspace_id, agent_member_id).await? {
            invalidate_hosted_lifecycle_in_tx(conn, workspace_id, agent_member_id).await?;
            return Ok(HostedMutation::Expired);
        }
    }
    let row = sqlx::query(
        "WITH expired AS ( \
           UPDATE hosted_agent_connection SET status = 'expired', updated_at = now() \
            WHERE workspace_id = $1 AND status = 'pairing_pending' \
              AND pairing_expires_at <= now() \
              AND pairing_challenge_hash = digest($2::text, 'sha256') \
         ) UPDATE hosted_agent_connection SET status = 'detected', pairing_consumed_at = now(), \
           detected_at = now(), detected_by = agent_member_id, detected_client_name = $3, detected_client_version = $4, \
           detected_capabilities = $5, updated_at = now() \
         WHERE workspace_id = $1 AND status = 'pairing_pending' \
           AND pairing_expires_at > now() \
           AND pairing_challenge_hash = digest($2::text, 'sha256') \
         RETURNING id, agent_member_id",
    )
    .bind(workspace_id)
    .bind(raw)
    .bind(client_name)
    .bind(client_version)
    .bind(capabilities)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        let expired: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM hosted_agent_connection WHERE workspace_id = $1 AND status = 'expired' \
               AND pairing_challenge_hash = digest($2::text, 'sha256') LIMIT 1",
        )
        .bind(workspace_id)
        .bind(raw)
        .fetch_optional(&mut *conn)
        .await?;
        if expired.is_some() {
            return Ok(HostedMutation::Expired);
        }
        return Ok(HostedMutation::NotFound);
    };
    Ok(HostedMutation::Applied(AgentBearerIdentity {
        token_id: row.try_get("id")?,
        member_id: row.try_get("agent_member_id")?,
        workspace_id,
        scopes: vec!["agent:port:connect".to_string()],
        hosted_connection_id: Some(row.try_get("id")?),
        audience: Some(HOSTED_AGENT_PORT_AUDIENCE.to_string()),
    }))
}

/// Resolve and lock a valid one-time pairing credential without consuming it.
/// The Agent Port uses this stable identity for admission before calling
/// [`detect_pairing_in_tx`], so a 429 never advances the lifecycle.
pub async fn resolve_pairing_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    raw: &str,
) -> Result<HostedMutation<AgentBearerIdentity>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, agent_member_id, pairing_expires_at <= now() AS expired \
           FROM hosted_agent_connection \
          WHERE workspace_id = $1 AND status = 'pairing_pending' \
            AND pairing_challenge_hash = digest($2::text, 'sha256') \
          FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(raw)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(HostedMutation::NotFound);
    };
    let agent_member_id: Uuid = row.try_get("agent_member_id")?;
    if row.try_get::<bool, _>("expired")?
        || !hosted_identity_is_live_in_tx(conn, workspace_id, agent_member_id).await?
    {
        invalidate_hosted_lifecycle_in_tx(conn, workspace_id, agent_member_id).await?;
        return Ok(HostedMutation::Expired);
    }
    Ok(HostedMutation::Applied(AgentBearerIdentity {
        token_id: row.try_get("id")?,
        member_id: agent_member_id,
        workspace_id,
        scopes: vec!["agent:port:connect".to_string()],
        hosted_connection_id: Some(row.try_get("id")?),
        audience: Some(HOSTED_AGENT_PORT_AUDIENCE.to_string()),
    }))
}

fn insert_capability_bool(
    source: &Value,
    target: &mut Map<String, Value>,
    parent: &str,
    child: &str,
) {
    let Some(value) = source
        .get(parent)
        .and_then(Value::as_object)
        .and_then(|object| object.get(child))
        .and_then(Value::as_bool)
    else {
        return;
    };
    let nested = target
        .entry(parent.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(nested) = nested.as_object_mut() {
        nested.insert(child.to_string(), Value::Bool(value));
    }
}

fn sanitize_capabilities(value: &Value) -> Value {
    // This is deliberately a closed vocabulary. Even harmless-looking unknown
    // keys are not persisted because arbitrary provider-controlled names can
    // themselves be credential material.
    let mut projected = Map::new();
    if let Some(value) = value.get("sampling").and_then(Value::as_bool) {
        projected.insert("sampling".to_string(), Value::Bool(value));
    }
    for (parent, child) in [
        ("tools", "listChanged"),
        ("resources", "subscribe"),
        ("resources", "listChanged"),
        ("prompts", "listChanged"),
        ("roots", "listChanged"),
    ] {
        insert_capability_bool(value, &mut projected, parent, child);
    }
    Value::Object(projected)
}

async fn hosted_identity_is_live_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let live: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM member m \
           JOIN workspace_membership wm ON wm.workspace_id=m.workspace_id AND wm.member_id=m.id \
           JOIN agent a ON a.workspace_id=m.workspace_id AND a.member_id=m.id \
          WHERE m.workspace_id=$1 AND m.id=$2 AND m.kind='agent' \
            AND m.status='active' AND m.deleted_at IS NULL \
          FOR UPDATE OF m, wm, a",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(live.is_some())
}

async fn invalidate_hosted_lifecycle_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE token SET revoked_at=COALESCE(revoked_at, now()) \
          WHERE workspace_id=$1 AND actor_member_id=$2 \
            AND credential_class='hosted_active' AND revoked_at IS NULL",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='expired', active_token_id=NULL, updated_at=now() \
          WHERE workspace_id=$1 AND agent_member_id=$2 \
            AND status IN ('pairing_pending','detected')",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "UPDATE agent_profile SET paused=true, version=version + CASE WHEN paused THEN 0 ELSE 1 END, \
           updated_at=now() WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn expire_stale_detected_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let agent_member_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT agent_member_id FROM hosted_agent_connection \
          WHERE workspace_id=$1 AND id=$2 AND status='detected' \
            AND pairing_expires_at <= now() FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(agent_member_id) = agent_member_id {
        invalidate_hosted_lifecycle_in_tx(conn, workspace_id, agent_member_id).await?;
        return Ok(true);
    }
    Ok(false)
}

pub async fn confirm_hosted_connection_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    actor_member_id: Uuid,
    approval: &HostedConnectionApproval,
) -> Result<HostedMutation<HostedActivationIssuance>, sqlx::Error> {
    if expire_stale_detected_in_tx(conn, workspace_id, connection_id).await? {
        return Ok(HostedMutation::Expired);
    }
    let detected_member: Option<Uuid> = sqlx::query_scalar(
        "SELECT agent_member_id FROM hosted_agent_connection \
          WHERE workspace_id=$1 AND id=$2 AND status='detected' FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(agent_member_id) = detected_member {
        if !hosted_identity_is_live_in_tx(conn, workspace_id, agent_member_id).await? {
            invalidate_hosted_lifecycle_in_tx(conn, workspace_id, agent_member_id).await?;
            return Ok(HostedMutation::Expired);
        }
    }
    let raw = mint_agent_bearer(workspace_id)
        .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
    let sql = format!(
        "WITH locked AS ( \
           SELECT id, agent_member_id FROM hosted_agent_connection \
            WHERE workspace_id = $1 AND id = $2 AND status = 'detected' \
              AND confirmed_at IS NULL AND agent_member_id = $4 \
              AND auth_mode = $5 AND audience = $6 FOR UPDATE \
         ), valid_channels AS ( \
           SELECT count(*)::bigint AS count FROM unnest($7::uuid[]) channel_id \
            WHERE EXISTS (SELECT 1 FROM channel c WHERE c.workspace_id = $1 AND c.id = channel_id \
                            AND c.archived_at IS NULL AND c.kind <> 'dm') \
         ), memberships AS ( \
           INSERT INTO membership (workspace_id, channel_id, member_id, role) \
           SELECT $1, channel_id, agent_member_id, 'member' FROM locked \
             CROSS JOIN unnest($7::uuid[]) channel_id \
            WHERE (SELECT count FROM valid_channels) = cardinality($7::uuid[]) \
           ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL \
             WHERE membership.workspace_id = EXCLUDED.workspace_id \
           RETURNING id \
         ), inserted AS ( \
           INSERT INTO token (workspace_id, actor_member_id, kind, token_hash, scopes, label, \
                              credential_class, hosted_connection_id, audience, created_by) \
           SELECT $1, agent_member_id, 'agent_bearer', digest($9::text, 'sha256'), $8, \
                  'hosted agent port', 'hosted_active', id, $6, $3 FROM locked \
            WHERE (SELECT count FROM valid_channels) = cardinality($7::uuid[]) \
              AND (SELECT count(*) FROM memberships) >= 0 \
           RETURNING id \
         ), updated AS ( \
           UPDATE hosted_agent_connection SET confirmed_by = $3, confirmed_at = now(), \
             approved_channel_ids = $7, approved_scopes = $8, \
             active_token_id = (SELECT id FROM inserted), updated_at = now() \
            WHERE id IN (SELECT id FROM locked) AND EXISTS (SELECT 1 FROM inserted) \
           RETURNING * \
         ) \
         SELECT {PROJECTION}, (SELECT id FROM inserted) AS credential_id FROM updated"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(connection_id)
        .bind(actor_member_id)
        .bind(approval.agent_member_id)
        .bind(&approval.auth_mode)
        .bind(&approval.audience)
        .bind(&approval.channel_ids)
        .bind(&approval.scopes)
        .bind(&raw)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else {
        let state: Option<(String, Uuid, String, String, bool)> = sqlx::query_as(
            "SELECT status::text, agent_member_id, auth_mode, audience, confirmed_at IS NULL \
               FROM hosted_agent_connection WHERE workspace_id = $1 AND id = $2",
        )
        .bind(workspace_id)
        .bind(connection_id)
        .fetch_optional(&mut *conn)
        .await?;
        return Ok(match state {
            None => HostedMutation::NotFound,
            Some((status, member, auth_mode, audience, unconfirmed))
                if status == "detected"
                    && unconfirmed
                    && member == approval.agent_member_id
                    && auth_mode == approval.auth_mode
                    && audience == approval.audience =>
            {
                HostedMutation::InvalidApproval
            }
            Some(_) => HostedMutation::WrongState,
        });
    };
    Ok(HostedMutation::Applied(HostedActivationIssuance {
        credential_id: row.try_get("credential_id")?,
        connection: decode(&row)?,
        credential: raw,
    }))
}

/// First admitted active call proves possession and unpauses atomically.
pub async fn prove_hosted_binding_in_tx(
    conn: &mut PgConnection,
    identity: &AgentBearerIdentity,
    foundation_request: bool,
) -> Result<HostedProof, sqlx::Error> {
    let Some(connection_id) = identity.hosted_connection_id else {
        return Ok(HostedProof::Allowed);
    };
    if identity.audience.as_deref() != Some(HOSTED_AGENT_PORT_AUDIENCE) {
        return Ok(HostedProof::Rejected);
    }
    if expire_stale_detected_in_tx(conn, identity.workspace_id, connection_id).await? {
        return Ok(HostedProof::Rejected);
    }
    // Regenerate also locks connection then token. Keeping the same order here
    // prevents proof/regenerate from forming a connection↔token deadlock.
    let status: Option<String> = sqlx::query_scalar(
        "SELECT status::text FROM hosted_agent_connection WHERE workspace_id=$1 AND id=$2 \
          AND agent_member_id=$3 AND active_token_id=$4 AND confirmed_at IS NOT NULL \
          AND (($5 AND status IN ('detected','active')) OR (NOT $5 AND status='active')) FOR UPDATE",
    )
    .bind(identity.workspace_id)
    .bind(connection_id)
    .bind(identity.member_id)
    .bind(identity.token_id)
    .bind(foundation_request)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(status) = status else {
        return Ok(HostedProof::Rejected);
    };
    let token_live: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM token WHERE workspace_id=$1 AND id=$2 AND actor_member_id=$3 \
          AND kind='agent_bearer' AND credential_class='hosted_active' \
          AND hosted_connection_id=$4 AND audience=$5 AND 'agent:port:connect'=ANY(scopes) \
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) FOR UPDATE",
    )
    .bind(identity.workspace_id)
    .bind(identity.token_id)
    .bind(identity.member_id)
    .bind(connection_id)
    .bind(HOSTED_AGENT_PORT_AUDIENCE)
    .fetch_optional(&mut *conn)
    .await?;
    let member_live: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM member WHERE workspace_id=$1 AND id=$2 AND kind='agent' \
          AND status='active' AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(identity.workspace_id)
    .bind(identity.member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let membership_live: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM workspace_membership WHERE workspace_id=$1 AND member_id=$2 FOR UPDATE",
    )
    .bind(identity.workspace_id)
    .bind(identity.member_id)
    .fetch_optional(&mut *conn)
    .await?;
    if token_live.is_none() || member_live.is_none() || membership_live.is_none() {
        invalidate_hosted_lifecycle_in_tx(conn, identity.workspace_id, identity.member_id).await?;
        return Ok(HostedProof::Rejected);
    }
    let activated: bool = sqlx::query_scalar(
        "WITH touched AS ( \
           UPDATE token SET last_used_at = now() \
            WHERE workspace_id = $2 AND id = $4 \
            RETURNING id \
         ), unpaused AS ( \
           UPDATE agent_profile SET paused = false, version = version + 1, updated_at = now() \
            WHERE $5 AND $6 = 'detected' AND workspace_id = $2 AND agent_member_id = $3 \
              AND EXISTS (SELECT 1 FROM touched) \
            RETURNING agent_member_id \
         ), activated AS ( \
           UPDATE hosted_agent_connection SET status = 'active', proved_at = now(), \
             proved_by = agent_member_id, updated_at = now() \
            WHERE workspace_id = $2 AND id = $1 AND status = 'detected' \
              AND agent_member_id IN (SELECT agent_member_id FROM unpaused) \
            RETURNING id \
         ) \
         SELECT EXISTS (SELECT 1 FROM activated)",
    )
    .bind(connection_id)
    .bind(identity.workspace_id)
    .bind(identity.member_id)
    .bind(identity.token_id)
    .bind(foundation_request)
    .bind(&status)
    .fetch_one(&mut *conn)
    .await?;
    if activated {
        Ok(HostedProof::Activated)
    } else if status == "detected" {
        // The detected→active transaction requires exactly one profile UPDATE.
        // Returning an error makes the tenant transaction roll back the token
        // touch as well as every lifecycle write when the row is absent.
        Err(sqlx::Error::RowNotFound)
    } else {
        Ok(HostedProof::Allowed)
    }
}

/// The live capability projection one authenticated Agent Port request has —
/// the connection it is bound to, plus both halves of the scope intersection
/// (ADR-0162 / HAP-E5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedToolIdentity {
    pub connection_id: Uuid,
    pub agent_member_id: Uuid,
    pub token_id: Uuid,
    /// What the credential still carries.
    pub token_scopes: Vec<String>,
    /// What a human actually confirmed on this connection.
    pub approved_scopes: Vec<String>,
    pub approved_channel_ids: Vec<Uuid>,
}

/// Resolve the connection behind an already-authenticated Agent Port bearer, or
/// `None` when there is no live one.
///
/// `None` is the fail-closed answer for **every** way this can go wrong, and it
/// is what makes an inactive hosted agent see an empty tool catalog rather than
/// a partially-open one: a revoked/expired token, a token that is no longer the
/// connection's `active_token_id`, a token minted for another audience, a token
/// whose actor is not the connection's agent, a suspended member, a lost
/// workspace membership, or a paused profile all take this exit.
///
/// The three axes worth naming, because 070's SQL asserted them and nothing
/// exercised them: `audience` (a generic bearer cannot address the Agent Port),
/// `actor_member_id` (a token minted for another member cannot borrow this
/// connection), and `hosted_connection_id`/`active_token_id` (a token belonging
/// to a previous connection era cannot be replayed against the current one).
///
/// Lock order is HAP-E4's: connection → token → member → membership → profile.
/// Any other order here would form the AB-BA pair #1374 already tracks.
pub async fn resolve_hosted_tool_identity_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    token_id: Uuid,
) -> Result<Option<HostedToolIdentity>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT hc.id AS connection_id, hc.agent_member_id, t.id AS token_id,                 t.scopes AS token_scopes, hc.approved_scopes, hc.approved_channel_ids            FROM hosted_agent_connection hc            JOIN token t ON t.workspace_id=hc.workspace_id AND t.id=hc.active_token_id            JOIN member m ON m.workspace_id=hc.workspace_id AND m.id=hc.agent_member_id            JOIN workspace_membership wm              ON wm.workspace_id=hc.workspace_id AND wm.member_id=hc.agent_member_id            JOIN agent_profile ap              ON ap.workspace_id=hc.workspace_id AND ap.agent_member_id=hc.agent_member_id           WHERE hc.workspace_id=$1 AND hc.agent_member_id=$2 AND t.id=$3             AND hc.status='active' AND hc.proved_at IS NOT NULL             AND t.kind='agent_bearer' AND t.credential_class='hosted_active'             AND t.revoked_at IS NULL             AND (t.expires_at IS NULL OR t.expires_at > now())             AND t.hosted_connection_id=hc.id AND t.actor_member_id=hc.agent_member_id             AND t.audience=$4             AND 'agent:port:connect'=ANY(t.scopes)             AND 'agent:port:connect'=ANY(hc.approved_scopes)             AND m.kind='agent' AND m.status='active' AND m.deleted_at IS NULL             AND ap.paused=false           FOR SHARE OF hc,t,m,wm,ap",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(token_id)
    .bind(HOSTED_AGENT_PORT_AUDIENCE)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(HostedToolIdentity {
        connection_id: row.try_get("connection_id")?,
        agent_member_id: row.try_get("agent_member_id")?,
        token_id: row.try_get("token_id")?,
        token_scopes: row.try_get("token_scopes")?,
        approved_scopes: row.try_get("approved_scopes")?,
        approved_channel_ids: row.try_get("approved_channel_ids")?,
    }))
}

/// The agent's live hosted connection id, if it has one.
///
/// A narrower answer than [`resolve_hosted_tool_identity_in_tx`] for producers
/// that are acting on the agent's behalf rather than as it: there is no bearer
/// in hand here, so the token half of the check is the connection's own
/// `active_token_id` rather than a presented credential.
pub async fn active_hosted_connection_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT hc.id FROM hosted_agent_connection hc \
           JOIN token t ON t.workspace_id=hc.workspace_id AND t.id=hc.active_token_id \
          WHERE hc.workspace_id=$1 AND hc.agent_member_id=$2 \
            AND hc.status='active' AND hc.proved_at IS NOT NULL \
            AND t.kind='agent_bearer' AND t.credential_class='hosted_active' \
            AND t.revoked_at IS NULL \
            AND (t.expires_at IS NULL OR t.expires_at > now()) \
            AND t.hosted_connection_id=hc.id AND t.actor_member_id=hc.agent_member_id \
            AND t.audience=$3 \
          ORDER BY hc.id LIMIT 1",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(HOSTED_AGENT_PORT_AUDIENCE)
    .fetch_optional(&mut *conn)
    .await
}

pub async fn is_hosted_agent_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM hosted_agent_connection WHERE workspace_id = $1 AND agent_member_id = $2 LIMIT 1",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

/// Whether the hosted identity has completed the proof-bound activation that
/// exclusively authorizes unpausing it. `paused=false` before this point would
/// split the lifecycle transition across two transactions.
pub async fn is_hosted_agent_activated_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<bool>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM hosted_agent_connection \
            WHERE workspace_id = $1 AND agent_member_id = $2 \
              AND status = 'active' AND proved_at IS NOT NULL \
         ) WHERE EXISTS ( \
           SELECT 1 FROM hosted_agent_connection \
            WHERE workspace_id = $1 AND agent_member_id = $2 \
         )",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_envelope_is_strict_and_round_trips_workspace() {
        let workspace = Uuid::new_v4();
        let raw = mint_pairing(workspace).unwrap();
        assert_eq!(pairing_workspace_id(&raw), Some(workspace));
        assert_eq!(pairing_workspace_id(&format!("{raw}.extra")), None);
        assert_eq!(
            pairing_workspace_id(&raw.replace("momo_pair_v1", "momo_agent_v1")),
            None
        );
    }

    #[test]
    fn hosted_scope_set_is_closed_and_requires_connect() {
        assert!(validate_hosted_scopes(&["agent:port:connect".into()]).is_ok());
        assert!(validate_hosted_scopes(&["messages:write".into()]).is_err());
        assert!(
            validate_hosted_scopes(&["agent:port:connect".into(), "work:control".into()]).is_err()
        );
    }

    #[test]
    fn observation_projection_keeps_only_finite_capability_booleans() {
        let projected = sanitize_capabilities(&serde_json::json!({
            "tools": {"listChanged": true, "tokenEndpoint": true, "note": "momo_pair_v1.leak"},
            "authorization": {"enabled": true},
            "sampling": false,
            "telemetry": true,
            "experimental": {"safeLookingUnknown": true},
            "values": ["secret"],
            "count": 7
        }));
        assert_eq!(
            projected,
            serde_json::json!({"tools":{"listChanged":true},"sampling":false})
        );
        assert!(!projected.to_string().contains("momo_pair_v1"));
        assert!(!projected.to_string().contains("tokenEndpoint"));
    }
}
