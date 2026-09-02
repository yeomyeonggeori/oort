//! Device-link QR tokens: mint, hash lookup, consume, SAS confirm (ADR-0180).
//!
//! The raw token is 32 CSPRNG bytes, base64url without padding (43 chars).
//! Postgres stores only `digest(token, 'sha256')`. The plaintext is an exchange
//! voucher — it is not a session credential and cannot call any API.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::issue::{sign_access, sign_refresh, IssuedToken};
use crate::token_store::{
    record_session_token_with_device, DeviceSessionRecord, SESSION_LABEL_ACCESS,
    SESSION_LABEL_REFRESH,
};

/// Sealed TTL (ADR-0180 D1). 120 seconds.
pub const DEVICE_LINK_TTL_SECONDS: i64 = 120;
const SECRET_BYTES: usize = 32;
/// `encode(32 bytes, base64url no pad)` is always 43 characters.
pub const DEVICE_LINK_TOKEN_LEN: usize = 43;
const DEVICE_NAME_MAX: usize = 64;
const DEVICE_PLATFORM_MAX: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DeviceLinkSpecInvalid {
    #[error("device link token is invalid")]
    Token,
    #[error("device name is required")]
    Name,
    #[error("device platform is required")]
    Platform,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DeviceLinkInputError {
    #[error("credential entropy unavailable")]
    Entropy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedDeviceLink {
    pub id: Uuid,
    pub expires_at_ms: i64,
    pub sas: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedeemedDeviceLink {
    pub link_id: Uuid,
    pub member_id: Uuid,
    pub workspace_id: Uuid,
    pub kind: String,
    pub display_name: String,
    pub handle: String,
    pub pending_sas: bool,
    pub device_label: String,
}

pub struct RedeemedSession {
    pub outcome: RedeemedDeviceLink,
    pub access: IssuedToken,
    pub refresh: IssuedToken,
}

pub enum DeviceLinkMutation {
    Applied(Box<RedeemedSession>),
    NotFound,
    Expired,
    AlreadyUsed,
    IssuerSessionRevoked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceLinkStatus {
    pub status: DeviceLinkStatusKind,
    pub device_label: Option<String>,
    pub device_platform: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceLinkStatusKind {
    Pending,
    Consumed,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceLinkConfirm {
    Confirmed,
    AlreadyConfirmed,
    NotRequired,
    NotRedeemed,
    NotFound,
}

pub fn mint_device_link_token() -> Result<String, DeviceLinkInputError> {
    let mut secret = [0_u8; SECRET_BYTES];
    getrandom::getrandom(&mut secret).map_err(|_| DeviceLinkInputError::Entropy)?;
    Ok(URL_SAFE_NO_PAD.encode(secret))
}

pub fn normalized_device_link_token(raw: &str) -> Result<String, DeviceLinkSpecInvalid> {
    let value = raw.trim();
    if value.chars().count() != DEVICE_LINK_TOKEN_LEN
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(DeviceLinkSpecInvalid::Token);
    }
    Ok(value.to_string())
}

pub fn normalized_device_name(raw: &str) -> Result<String, DeviceLinkSpecInvalid> {
    let value = raw.trim();
    if value.is_empty() || value.chars().count() > DEVICE_NAME_MAX {
        return Err(DeviceLinkSpecInvalid::Name);
    }
    Ok(value.to_string())
}

pub fn normalized_device_platform(raw: &str) -> Result<String, DeviceLinkSpecInvalid> {
    let value = raw.trim();
    if value.is_empty() || value.chars().count() > DEVICE_PLATFORM_MAX {
        return Err(DeviceLinkSpecInvalid::Platform);
    }
    Ok(value.to_string())
}

pub async fn resolve_device_link_workspace(
    conn: &mut PgConnection,
    token: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar("SELECT momo_join_private.device_link_workspace_id($1::text)")
        .bind(token)
        .fetch_one(&mut *conn)
        .await
}

async fn sweep_stale_device_links(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM device_link_token \
          WHERE workspace_id = $1 \
            AND consumed_at IS NULL \
            AND (expires_at < now() OR member_id = $2)",
    )
    .bind(workspace_id)
    .bind(member_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn issue_device_link_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    issued_session_token_id: Uuid,
    token: &str,
    require_sas: bool,
) -> Result<IssuedDeviceLink, sqlx::Error> {
    sweep_stale_device_links(conn, workspace_id, member_id).await?;

    let row = sqlx::query(
        "INSERT INTO device_link_token \
            (workspace_id, member_id, issued_session_token_id, token_hash, sas, expires_at) \
         VALUES ( \
            $1, $2, $3, digest($4::text, 'sha256'), \
            CASE WHEN $5 THEN lpad(( \
                (get_byte(digest($4::text, 'sha256'), 0)::int * 256 \
                 + get_byte(digest($4::text, 'sha256'), 1)::int) % 10000 \
            )::text, 4, '0') ELSE NULL END, \
            now() + make_interval(secs => $6) \
         ) \
         RETURNING id, \
                   (extract(epoch from expires_at) * 1000)::bigint AS expires_at_ms, \
                   sas",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(issued_session_token_id)
    .bind(token)
    .bind(require_sas)
    .bind(DEVICE_LINK_TTL_SECONDS as f64)
    .fetch_one(&mut *conn)
    .await?;

    Ok(IssuedDeviceLink {
        id: row.try_get("id")?,
        expires_at_ms: row.try_get("expires_at_ms")?,
        sas: row.try_get("sas")?,
    })
}

fn sign_to_sqlx(error: crate::jwt::AuthError) -> sqlx::Error {
    sqlx::Error::Protocol(error.to_string())
}

pub async fn consume_device_link_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    token: &str,
    device_name: &str,
    device_platform: &str,
    jwt_secret: &str,
    scopes: &[String],
) -> Result<DeviceLinkMutation, sqlx::Error> {
    sqlx::query(
        "DELETE FROM device_link_token \
          WHERE workspace_id = $1 \
            AND consumed_at IS NULL \
            AND expires_at < now() \
            AND token_hash <> digest($2::text, 'sha256')",
    )
    .bind(workspace_id)
    .bind(token)
    .execute(&mut *conn)
    .await?;

    let row = sqlx::query(
        "SELECT d.id, d.member_id, d.expires_at <= now() AS expired, \
                d.consumed_at IS NOT NULL AS consumed, \
                d.sas IS NOT NULL AS pending_sas, \
                (t.revoked_at IS NOT NULL \
                  OR (t.expires_at IS NOT NULL AND t.expires_at < now())) AS issuer_dead \
           FROM device_link_token d \
           JOIN token t \
             ON t.id = d.issued_session_token_id \
            AND t.workspace_id = d.workspace_id \
          WHERE d.workspace_id = $1 \
            AND d.token_hash = digest($2::text, 'sha256') \
          FOR UPDATE OF d",
    )
    .bind(workspace_id)
    .bind(token)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else {
        return Ok(DeviceLinkMutation::NotFound);
    };
    if row.try_get::<bool, _>("consumed")? {
        return Ok(DeviceLinkMutation::AlreadyUsed);
    }
    if row.try_get::<bool, _>("expired")? {
        return Ok(DeviceLinkMutation::Expired);
    }
    if row.try_get::<bool, _>("issuer_dead")? {
        return Ok(DeviceLinkMutation::IssuerSessionRevoked);
    }

    let link_id: Uuid = row.try_get("id")?;
    let member_id: Uuid = row.try_get("member_id")?;
    let pending_sas: bool = row.try_get("pending_sas")?;

    let updated = sqlx::query(
        "UPDATE device_link_token \
            SET consumed_at = now(), \
                device_label = $3, \
                device_platform = $4 \
          WHERE id = $1 \
            AND workspace_id = $2 \
            AND consumed_at IS NULL \
            AND expires_at > now() \
        RETURNING id",
    )
    .bind(link_id)
    .bind(workspace_id)
    .bind(device_name)
    .bind(device_platform)
    .fetch_optional(&mut *conn)
    .await?;
    if updated.is_none() {
        return Ok(DeviceLinkMutation::NotFound);
    }

    let access = sign_access(member_id, workspace_id, scopes, jwt_secret).map_err(sign_to_sqlx)?;
    let refresh =
        sign_refresh(member_id, workspace_id, scopes, jwt_secret).map_err(sign_to_sqlx)?;

    let access_id = record_session_token_with_device(
        conn,
        workspace_id,
        member_id,
        DeviceSessionRecord {
            raw_token: &access.token,
            label: SESSION_LABEL_ACCESS,
            scopes,
            expires_at_unix: access.expires_at,
            device_label: Some(device_name),
            pending_sas,
        },
    )
    .await?;
    let refresh_id = record_session_token_with_device(
        conn,
        workspace_id,
        member_id,
        DeviceSessionRecord {
            raw_token: &refresh.token,
            label: SESSION_LABEL_REFRESH,
            scopes,
            expires_at_unix: refresh.expires_at,
            device_label: Some(device_name),
            pending_sas,
        },
    )
    .await?;

    sqlx::query(
        "UPDATE device_link_token \
            SET redeemed_access_token_id = $3, \
                redeemed_refresh_token_id = $4 \
          WHERE id = $1 AND workspace_id = $2",
    )
    .bind(link_id)
    .bind(workspace_id)
    .bind(access_id)
    .bind(refresh_id)
    .execute(&mut *conn)
    .await?;

    let member = sqlx::query(
        "SELECT m.id, m.workspace_id, m.kind::text AS kind, \
                m.display_name, m.handle \
           FROM member m \
          WHERE m.id = $1 \
            AND m.workspace_id = $2 \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
            AND m.kind = 'human'",
    )
    .bind(member_id)
    .bind(workspace_id)
    .fetch_one(&mut *conn)
    .await?;

    Ok(DeviceLinkMutation::Applied(Box::new(RedeemedSession {
        outcome: RedeemedDeviceLink {
            link_id,
            member_id,
            workspace_id: member.try_get("workspace_id")?,
            kind: member.try_get("kind")?,
            display_name: member.try_get("display_name")?,
            handle: member.try_get("handle")?,
            pending_sas,
            device_label: device_name.to_string(),
        },
        access,
        refresh,
    })))
}

pub async fn device_link_status_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    issued_session_token_id: Uuid,
    link_id: Uuid,
) -> Result<Option<DeviceLinkStatus>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT consumed_at IS NOT NULL AS consumed, \
                expires_at <= now() AS expired, \
                device_label, device_platform \
           FROM device_link_token \
          WHERE workspace_id = $1 \
            AND id = $2 \
            AND issued_session_token_id = $3 \
            AND member_id = ( \
                SELECT actor_member_id FROM token \
                 WHERE id = $3 AND workspace_id = $1 \
            )",
    )
    .bind(workspace_id)
    .bind(link_id)
    .bind(issued_session_token_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };
    let consumed: bool = row.try_get("consumed")?;
    let expired: bool = row.try_get("expired")?;
    let status = if consumed {
        DeviceLinkStatusKind::Consumed
    } else if expired {
        DeviceLinkStatusKind::Expired
    } else {
        DeviceLinkStatusKind::Pending
    };
    Ok(Some(DeviceLinkStatus {
        status,
        device_label: row.try_get("device_label")?,
        device_platform: row.try_get("device_platform")?,
    }))
}

pub async fn confirm_device_link_sas_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    issued_session_token_id: Uuid,
    link_id: Uuid,
) -> Result<DeviceLinkConfirm, sqlx::Error> {
    let row = sqlx::query(
        "SELECT sas IS NOT NULL AS needs_sas, \
                consumed_at IS NOT NULL AS consumed, \
                sas_confirmed_at IS NOT NULL AS confirmed, \
                redeemed_access_token_id, \
                redeemed_refresh_token_id \
           FROM device_link_token \
          WHERE workspace_id = $1 \
            AND id = $2 \
            AND issued_session_token_id = $3 \
          FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(link_id)
    .bind(issued_session_token_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else {
        return Ok(DeviceLinkConfirm::NotFound);
    };
    if !row.try_get::<bool, _>("needs_sas")? {
        return Ok(DeviceLinkConfirm::NotRequired);
    }
    if !row.try_get::<bool, _>("consumed")? {
        return Ok(DeviceLinkConfirm::NotRedeemed);
    }
    if row.try_get::<bool, _>("confirmed")? {
        return Ok(DeviceLinkConfirm::AlreadyConfirmed);
    }

    let access_id: Option<Uuid> = row.try_get("redeemed_access_token_id")?;
    let refresh_id: Option<Uuid> = row.try_get("redeemed_refresh_token_id")?;
    sqlx::query(
        "UPDATE token \
            SET pending_sas = false \
          WHERE workspace_id = $1 \
            AND id = ANY($2::uuid[]) \
            AND pending_sas",
    )
    .bind(workspace_id)
    .bind(
        [access_id, refresh_id]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>(),
    )
    .execute(&mut *conn)
    .await?;

    sqlx::query(
        "UPDATE device_link_token \
            SET sas_confirmed_at = now() \
          WHERE id = $1 AND workspace_id = $2 AND sas_confirmed_at IS NULL",
    )
    .bind(link_id)
    .bind(workspace_id)
    .execute(&mut *conn)
    .await?;

    Ok(DeviceLinkConfirm::Confirmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_shape_matches_claim() {
        assert_eq!(DEVICE_LINK_TOKEN_LEN, 43);
        assert_eq!(DEVICE_LINK_TTL_SECONDS, 120);
        let token = mint_device_link_token().expect("entropy");
        assert_eq!(
            normalized_device_link_token(&token).as_deref(),
            Ok(token.as_str())
        );
        assert!(normalized_device_link_token("short").is_err());
        assert!(normalized_device_link_token(&"A".repeat(43)).is_ok());
    }

    #[test]
    fn device_fields_trim_and_cap() {
        assert_eq!(normalized_device_name("  phone  ").as_deref(), Ok("phone"));
        assert!(normalized_device_name("").is_err());
        assert!(normalized_device_name(&"한".repeat(65)).is_err());
        assert_eq!(normalized_device_platform(" ios ").as_deref(), Ok("ios"));
        assert!(normalized_device_platform("").is_err());
    }
}
