//! `webhook_installation` + `webhook_secret_key` — every statement, in one place.
//!
//! Ports the management half of Swift `Routes/WebhookRoutes.swift` (:43-445).
//! The public ingress half (`POST /v1/webhooks/{ws}/{id}`, `POST /hooks/{token}`)
//! is **not** ported by #1222 and is tracked separately — see the crate-level
//! note in the PR body. Everything here is the surface an admin drives.
//!
//! ## Why a create is this large
//!
//! Because ADR-0115 makes an installation four rows that only mean something
//! together, and all four must commit or none:
//!
//! ```text
//! workspace_plugin_install   the `external_webhook` reference plugin, upserted
//! member (kind='agent')      a dedicated non-login author — see below
//! membership                 that author, in the target channel
//! webhook_installation       + webhook_secret_key, the credential's metadata
//! ```
//!
//! The dedicated author is the part worth stating out loud: an ingress message
//! could have been attributed to the admin who installed the hook, and that
//! would make every CI notification look like something a person said. A
//! service member with `kind='agent'` avoids the impersonation while carrying no
//! `agent` row, no credential, no provider config and no ability to run — it is
//! a name and a face, and nothing that can act.
//!
//! ## What is never stored
//!
//! * a native HMAC secret — only the random `secret_ref` it is derived from;
//! * a Slack URL token — only `sha256:<hex>` of it.
//!
//! Both are answered exactly once, by create and by rotate, and this module has
//! no read that could return either.

use chrono::{DateTime, Utc};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::crypto;

/// The server-owned reference plugin migration 014 seeds. An installation is
/// always an install of *this* plugin; there is no other id a caller may name.
pub const PLUGIN_ID: &str = "external_webhook";

/// `0..=604800` — openapi `RotateWebhookRequest.overlapSeconds`, Swift
/// `WebhookRoutes.maximumRotationOverlapSeconds`.
pub const MAX_ROTATION_OVERLAP_SECONDS: i64 = 7 * 24 * 60 * 60;
/// What the panel offers and the spec defaults to: one day for a sender to be
/// updated before the previous credential stops working.
pub const DEFAULT_ROTATION_OVERLAP_SECONDS: i64 = 24 * 60 * 60;
/// `webhook_installation_label_ck` — `length(label) BETWEEN 1 AND 80`.
pub const LABEL_MAX_CHARS: usize = 80;

/// The two ingress dialects. `slack_compatible` exists so a team can point an
/// existing Slack integration at oort without rewriting it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebhookMode {
    Native,
    SlackCompatible,
}

impl WebhookMode {
    pub fn as_db_label(self) -> &'static str {
        match self {
            WebhookMode::Native => "native",
            WebhookMode::SlackCompatible => "slack_compatible",
        }
    }

    /// Trim + lowercase, then the closed set. Swift `normalizedMode`.
    pub fn parse(raw: &str) -> Option<WebhookMode> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "native" => Some(WebhookMode::Native),
            "slack_compatible" => Some(WebhookMode::SlackCompatible),
            _ => None,
        }
    }
}

/// One installation as the list returns it. **No `secret`, no `url`** — the list
/// response carries neither by contract, and a struct that cannot hold a secret
/// is one fewer place a secret can be rendered from (the same rule the web
/// client's `WebhookInstallation` states in `features/webhooks/model.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallationRow {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub author_member_id: Uuid,
    pub mode: String,
    pub label: String,
    /// `active` | `revoked`, derived from `revoked_at`.
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl InstallationRow {
    pub fn is_active(&self) -> bool {
        self.status == "active"
    }
}

const PROJECTION: &str =
    "id, channel_id, author_member_id, mode, label, revoked_at, created_at, updated_at";

fn decode(row: &sqlx::postgres::PgRow) -> Result<InstallationRow, sqlx::Error> {
    let revoked_at: Option<DateTime<Utc>> = row.try_get("revoked_at")?;
    Ok(InstallationRow {
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        author_member_id: row.try_get("author_member_id")?,
        mode: row.try_get("mode")?,
        label: row.try_get("label")?,
        status: if revoked_at.is_none() {
            "active"
        } else {
            "revoked"
        }
        .to_string(),
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// Trim, bound to 1..=80 characters, refuse control characters. Swift
/// `normalizedLabel`, including the `"Incoming Webhook"` default for an absent
/// label.
pub fn normalized_label(raw: Option<&str>) -> Option<String> {
    let value = raw.unwrap_or("Incoming Webhook").trim().to_string();
    if value.is_empty()
        || value.chars().count() > LABEL_MAX_CHARS
        || value.chars().any(char::is_control)
    {
        return None;
    }
    Some(value)
}

/// `0..=604800`, defaulting to one day. Swift `validatedOverlapSeconds`.
pub fn validated_overlap_seconds(raw: Option<i64>) -> Option<i64> {
    let value = raw.unwrap_or(DEFAULT_ROTATION_OVERLAP_SECONDS);
    (0..=MAX_ROTATION_OVERLAP_SECONDS)
        .contains(&value)
        .then_some(value)
}

/// Newest first, at most 200 — the bound openapi states.
pub async fn list_installations(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Vec<InstallationRow>, DbError> {
    let rows = sqlx::query(&format!(
        "SELECT {PROJECTION} FROM webhook_installation \
          WHERE workspace_id = $1 \
          ORDER BY created_at DESC, id DESC \
          LIMIT 200"
    ))
    .bind(workspace_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(decode)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

/// Everything a create needs that the caller decided: which channel, which
/// dialect, what to call it, and the credential material it already generated
/// (so the row and the one-time response are provably built from one value).
#[derive(Debug, Clone)]
pub struct NewInstallation<'a> {
    pub channel_id: Uuid,
    pub mode: WebhookMode,
    pub label: &'a str,
    /// Native only. `None` in Slack-compatible mode.
    pub secret_ref: Option<&'a str>,
    /// Slack-compatible only, already hashed. `None` in native mode.
    pub token_hash: Option<&'a str>,
    pub actor_member_id: Uuid,
    pub via_token_id: Option<Uuid>,
}

/// What a create produced, beyond the row itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedInstallation {
    pub installation: InstallationRow,
    /// The `webhook_secret_key.id` the one-time response reports as `keyId`.
    pub key_id: Uuid,
}

/// Is this an active channel in this workspace? A create against an archived or
/// foreign channel is a 404, decided before any of the four writes.
pub async fn active_channel_exists(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
) -> Result<bool, DbError> {
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM channel \
          WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL",
    )
    .bind(channel_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

/// The full ADR-0115 create, inside the caller's tenant transaction.
///
/// The advisory lock is Swift's and serializes concurrent installs *per
/// workspace*: `workspace_plugin_install` is `UNIQUE (workspace_id, plugin_id)`,
/// so two admins installing at the same second would otherwise race between the
/// `SELECT … FOR UPDATE` that finds nothing and the `INSERT` that then conflicts.
pub async fn create_installation(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    new: NewInstallation<'_>,
) -> Result<CreatedInstallation, DbError> {
    let installation_id = Uuid::new_v4();
    let author_member_id = Uuid::new_v4();
    let key_id = Uuid::new_v4();

    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("external-webhook-install:{workspace_id}"))
        .execute(&mut *conn)
        .await?;

    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM workspace_plugin_install \
          WHERE workspace_id = $1 AND plugin_id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(PLUGIN_ID)
    .fetch_optional(&mut *conn)
    .await?;
    let plugin_install_id = existing.unwrap_or_else(Uuid::new_v4);

    let plugin_audit_id = write_audit(
        conn,
        &AuditEntry::new(workspace_id, "plugin.installed")
            .by(new.actor_member_id)
            .target("plugin_install", plugin_install_id)
            .via_token(new.via_token_id)
            .with_schema(
                "momo.external_webhook.plugin_install.v1",
                serde_json::json!({ "plugin_id": PLUGIN_ID }),
            ),
    )
    .await?;

    if existing.is_none() {
        sqlx::query(
            "INSERT INTO workspace_plugin_install \
               (id, workspace_id, plugin_id, enabled, installed_by, installed_audit_id) \
             VALUES ($1, $2, $3, true, $4, $5)",
        )
        .bind(plugin_install_id)
        .bind(workspace_id)
        .bind(PLUGIN_ID)
        .bind(new.actor_member_id)
        .bind(plugin_audit_id)
        .execute(&mut *conn)
        .await?;
    } else {
        sqlx::query(
            "UPDATE workspace_plugin_install \
                SET enabled = true, installed_by = $2, installed_audit_id = $3, \
                    revoked_at = NULL, revoked_by = NULL, revoked_audit_id = NULL, \
                    updated_at = now() \
              WHERE id = $1",
        )
        .bind(plugin_install_id)
        .bind(new.actor_member_id)
        .bind(plugin_audit_id)
        .execute(&mut *conn)
        .await?;
    }

    // The dedicated author. `kind='agent'` because schema_v0 has only two member
    // kinds and this is not a person — but it gets no `agent` row, so nothing in
    // the run machinery can ever pick it up.
    let handle = format!("webhook-{}", installation_id.simple());
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
         VALUES ($1, $2, 'agent', 'active', $3, $4)",
    )
    .bind(author_member_id)
    .bind(workspace_id)
    .bind(new.label)
    .bind(&handle)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member')",
    )
    .bind(workspace_id)
    .bind(new.channel_id)
    .bind(author_member_id)
    .execute(&mut *conn)
    .await?;

    let webhook_audit_id = write_audit(
        conn,
        &AuditEntry::new(workspace_id, "webhook.issued")
            .by(new.actor_member_id)
            .target("webhook_installation", installation_id)
            .via_token(new.via_token_id)
            .with_schema(
                "momo.webhook.issued.v1",
                serde_json::json!({
                    "channel_id": new.channel_id.to_string(),
                    "mode": new.mode.as_db_label(),
                    "key_id": key_id.to_string(),
                    "author_model": "dedicated_service_member",
                }),
            ),
    )
    .await?;

    let row = sqlx::query(&format!(
        "INSERT INTO webhook_installation \
           (id, workspace_id, channel_id, plugin_install_id, author_member_id, \
            mode, label, created_by, created_audit_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         RETURNING {PROJECTION}"
    ))
    .bind(installation_id)
    .bind(workspace_id)
    .bind(new.channel_id)
    .bind(plugin_install_id)
    .bind(author_member_id)
    .bind(new.mode.as_db_label())
    .bind(new.label)
    .bind(new.actor_member_id)
    .bind(webhook_audit_id)
    .fetch_one(&mut *conn)
    .await?;

    sqlx::query(
        "INSERT INTO webhook_secret_key \
           (id, workspace_id, installation_id, mode, secret_ref, token_hash, \
            created_by, created_audit_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(key_id)
    .bind(workspace_id)
    .bind(installation_id)
    .bind(new.mode.as_db_label())
    .bind(new.secret_ref)
    .bind(new.token_hash)
    .bind(new.actor_member_id)
    .bind(webhook_audit_id)
    .execute(&mut *conn)
    .await?;

    Ok(CreatedInstallation {
        installation: decode(&row).map_err(DbError::from)?,
        key_id,
    })
}

/// Take the row under `FOR UPDATE` so rotate/revoke decide against a state no
/// concurrent request can move underneath them.
pub async fn load_installation_for_update(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    installation_id: Uuid,
) -> Result<Option<InstallationRow>, DbError> {
    let row = sqlx::query(&format!(
        "SELECT {PROJECTION} FROM webhook_installation \
          WHERE id = $1 AND workspace_id = $2 FOR UPDATE"
    ))
    .bind(installation_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    row.as_ref().map(decode).transpose().map_err(DbError::from)
}

/// Issue a replacement credential and put an expiry on every credential that was
/// valid until now.
///
/// The overlap is the whole point of rotation and it is expressed as a *deadline
/// on the old keys*, never as a delete: a sender can be updated at leisure, and
/// the moment the window closes the old material stops verifying with no further
/// action. `CASE WHEN valid_until IS NULL OR valid_until > deadline` means a key
/// that already expires sooner keeps its earlier deadline — a rotation may only
/// shorten a credential's life, never extend one.
#[allow(clippy::too_many_arguments)]
pub async fn rotate_installation_secret(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    installation_id: Uuid,
    mode: WebhookMode,
    secret_ref: Option<&str>,
    token_hash: Option<&str>,
    overlap_seconds: i64,
    actor_member_id: Uuid,
    via_token_id: Option<Uuid>,
) -> Result<Uuid, DbError> {
    let key_id = Uuid::new_v4();
    sqlx::query(
        "UPDATE webhook_secret_key \
            SET valid_until = CASE \
                  WHEN valid_until IS NULL \
                    OR valid_until > now() + make_interval(secs => $3) \
                  THEN now() + make_interval(secs => $3) \
                  ELSE valid_until END \
          WHERE workspace_id = $1 \
            AND installation_id = $2 \
            AND revoked_at IS NULL \
            AND (valid_until IS NULL OR valid_until > now())",
    )
    .bind(workspace_id)
    .bind(installation_id)
    .bind(overlap_seconds as f64)
    .execute(&mut *conn)
    .await?;

    let audit_id = write_audit(
        conn,
        &AuditEntry::new(workspace_id, "webhook.rotated")
            .by(actor_member_id)
            .target("webhook_installation", installation_id)
            .via_token(via_token_id)
            .with_schema(
                "momo.webhook.rotated.v1",
                serde_json::json!({
                    "mode": mode.as_db_label(),
                    "key_id": key_id.to_string(),
                    "overlap_seconds": overlap_seconds,
                }),
            ),
    )
    .await?;

    sqlx::query(
        "INSERT INTO webhook_secret_key \
           (id, workspace_id, installation_id, mode, secret_ref, token_hash, \
            created_by, created_audit_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(key_id)
    .bind(workspace_id)
    .bind(installation_id)
    .bind(mode.as_db_label())
    .bind(secret_ref)
    .bind(token_hash)
    .bind(actor_member_id)
    .bind(audit_id)
    .execute(&mut *conn)
    .await?;

    sqlx::query("UPDATE webhook_installation SET updated_at = now() WHERE id = $1")
        .bind(installation_id)
        .execute(&mut *conn)
        .await?;
    Ok(key_id)
}

/// Revoke the installation and every credential under it, irreversibly.
///
/// Idempotent by construction: the caller only reaches this for an `active` row,
/// and a second revoke of the same installation is answered from the row's
/// existing state rather than by writing a second audit line.
pub async fn revoke_installation(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    installation: &InstallationRow,
    actor_member_id: Uuid,
    via_token_id: Option<Uuid>,
) -> Result<InstallationRow, DbError> {
    let audit_id = write_audit(
        conn,
        &AuditEntry::new(workspace_id, "webhook.revoked")
            .by(actor_member_id)
            .target("webhook_installation", installation.id)
            .via_token(via_token_id)
            .with_schema(
                "momo.webhook.revoked.v1",
                serde_json::json!({
                    "mode": installation.mode,
                    "channel_id": installation.channel_id.to_string(),
                }),
            ),
    )
    .await?;

    let row = sqlx::query(&format!(
        "UPDATE webhook_installation \
            SET revoked_at = now(), revoked_by = $3, revoked_audit_id = $4, \
                updated_at = now() \
          WHERE id = $1 AND workspace_id = $2 \
        RETURNING {PROJECTION}"
    ))
    .bind(installation.id)
    .bind(workspace_id)
    .bind(actor_member_id)
    .bind(audit_id)
    .fetch_one(&mut *conn)
    .await?;

    sqlx::query(
        "UPDATE webhook_secret_key \
            SET revoked_at = COALESCE(revoked_at, now()) \
          WHERE workspace_id = $1 AND installation_id = $2",
    )
    .bind(workspace_id)
    .bind(installation.id)
    .execute(&mut *conn)
    .await?;

    decode(&row).map_err(DbError::from)
}

/// The relative ingress path the one-time response reports as `url`.
///
/// Relative on purpose: the client resolves it against its own API origin
/// (`resolveReceiveUrl` in `features/webhooks/model.ts` refuses anything else),
/// so a server that guessed its own public hostname wrong cannot send someone's
/// secret-bearing path to another origin.
pub fn receive_url(workspace_id: Uuid, installation_id: Uuid, slack_token: Option<&str>) -> String {
    match slack_token {
        Some(token) => format!("/hooks/{token}"),
        None => format!(
            "/v1/webhooks/{}/{}",
            crypto::hyphenated(workspace_id),
            crypto::hyphenated(installation_id)
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_are_the_closed_db_set_and_nothing_else() {
        assert_eq!(WebhookMode::parse(" Native "), Some(WebhookMode::Native));
        assert_eq!(
            WebhookMode::parse("SLACK_COMPATIBLE"),
            Some(WebhookMode::SlackCompatible)
        );
        assert_eq!(WebhookMode::parse("discord"), None);
        assert_eq!(WebhookMode::Native.as_db_label(), "native");
        assert_eq!(
            WebhookMode::SlackCompatible.as_db_label(),
            "slack_compatible"
        );
    }

    #[test]
    fn labels_are_bounded_and_printable() {
        assert_eq!(normalized_label(None).as_deref(), Some("Incoming Webhook"));
        assert_eq!(normalized_label(Some("  CI  ")).as_deref(), Some("CI"));
        assert_eq!(normalized_label(Some("   ")), None);
        assert_eq!(
            normalized_label(Some("a\nb")),
            None,
            "control chars are refused"
        );
        assert!(normalized_label(Some(&"가".repeat(LABEL_MAX_CHARS))).is_some());
        assert_eq!(
            normalized_label(Some(&"가".repeat(LABEL_MAX_CHARS + 1))),
            None,
            "the bound is CHARACTERS, matching length() in the check constraint"
        );
    }

    #[test]
    fn the_overlap_window_is_the_specs_zero_to_a_week() {
        assert_eq!(validated_overlap_seconds(None), Some(86_400));
        assert_eq!(validated_overlap_seconds(Some(0)), Some(0));
        assert_eq!(validated_overlap_seconds(Some(604_800)), Some(604_800));
        assert_eq!(validated_overlap_seconds(Some(604_801)), None);
        assert_eq!(validated_overlap_seconds(Some(-1)), None);
    }

    #[test]
    fn the_receive_url_is_relative_and_names_the_dialect_it_belongs_to() {
        let workspace = Uuid::from_u128(1);
        let installation = Uuid::from_u128(2);
        assert_eq!(
            receive_url(workspace, installation, None),
            "/v1/webhooks/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002"
        );
        assert_eq!(
            receive_url(workspace, installation, Some("momo_hook_v1.x.y")),
            "/hooks/momo_hook_v1.x.y"
        );
        assert!(
            !receive_url(workspace, installation, None).contains("://"),
            "an absolute URL here is how a one-time secret reaches another origin"
        );
    }

    #[test]
    fn the_list_projection_names_no_credential_column() {
        for forbidden in ["secret_ref", "token_hash"] {
            assert!(
                !PROJECTION.contains(forbidden),
                "the list response carries no credential material by contract"
            );
        }
    }
}
