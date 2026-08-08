//! The **agent bearer** credential — the second thing this server authenticates
//! with a `token` row (B2.6).
//!
//! Ports Swift `Auth/AgentBearerToken.swift` (the envelope) and
//! `Auth/TokenStore.authenticateAgentBearer` (`TokenStore.swift:115-209`, the
//! lookup). It lives in `momo-auth` for one measured reason: this crate is the
//! **only** place in the workspace that contains `token` table SQL
//! ([`crate::token_store`] module docs), and an agent bearer is a `token` row
//! with `kind = 'agent_bearer'`. A second lookup elsewhere would be a second
//! revocation contract.
//!
//! ## Why the workspace travels in the envelope
//!
//! The API process runs as `momo_app` (NOBYPASSRLS). To *find* the token row it
//! must already have set `app.workspace_id`, and the only pre-authentication
//! source of that value is the credential itself. So the envelope is
//! `momo_agent_v1.<workspace-uuid>.<secret>` and the workspace is read from it —
//! but **nothing else is**: the actor id and the scopes always come from the
//! tenant-scoped row (`AgentBearerToken.swift:5-8`). A forged envelope therefore
//! buys an attacker only the right to look up a hash that will not be found,
//! inside the tenant it named.
//!
//! ## The audit row is the caller's, on purpose
//!
//! Swift writes an `audit_log` row whenever the lookup *found a live row* —
//! `auth.agent_bearer.used` when the required scope is present,
//! `auth.agent_bearer.scope_denied` when it is not (:165-184) — and writes
//! nothing for an unknown/revoked/expired token, which never identifies anyone.
//! [`authenticate_agent_bearer_in_tx`] returns that decision in
//! [`AgentBearerResolution::Active`] rather than writing the row itself, because
//! `audit_log` belongs to `momo-db` and this crate deliberately holds no
//! dependency on it (module docs of [`crate::token_store`]: "no DB-topology
//! knowledge"). The middleware writes it **in the same transaction**, which is
//! what makes the record atomic with the `last_used_at` touch.

use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// Envelope prefix (Swift `AgentBearerToken.prefix`).
pub const AGENT_BEARER_PREFIX: &str = "momo_agent_v1";

/// The `audit_log.action` for a scoped, accepted use (Swift :166).
pub const AUDIT_ACTION_USED: &str = "auth.agent_bearer.used";
/// The `audit_log.action` for a live credential missing the route's scope (:167).
pub const AUDIT_ACTION_SCOPE_DENIED: &str = "auth.agent_bearer.scope_denied";
/// The `detail.schema` both rows carry (Swift `agentBearerAuditDetail` :353).
pub const AUDIT_DETAIL_SCHEMA: &str = "momo.agent_bearer.use.v1";

/// Minimum length of the secret segment — 32 random bytes in unpadded
/// base64url (Swift `AgentBearerToken.workspaceID` :27, `parts[2].count >= 43`).
const MINIMUM_SECRET_CHARS: usize = 43;

/// The workspace a presented token *claims*, or `None` when the string is not an
/// agent-bearer envelope at all.
///
/// Returning `None` is what makes the middleware's dispatch total: a token that
/// is not this shape is an App JWT and is verified as one, exactly like Swift
/// (`AuthMiddleware.swift:83`).
pub fn agent_bearer_workspace_id(raw_token: &str) -> Option<Uuid> {
    let parts: Vec<&str> = raw_token.split('.').collect();
    if parts.len() != 3
        || parts[0] != AGENT_BEARER_PREFIX
        || parts[2].chars().count() < MINIMUM_SECRET_CHARS
    {
        return None;
    }
    Uuid::parse_str(parts[1]).ok()
}

/// A resolved agent-bearer identity (Swift `AgentBearerIdentity`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentBearerIdentity {
    pub token_id: Uuid,
    pub member_id: Uuid,
    pub workspace_id: Uuid,
    pub scopes: Vec<String>,
}

/// Outcome of looking an agent bearer up (Swift `AgentBearerResolution`).
///
/// `Active { scope_granted: false }` is deliberately distinct from the three
/// unauthenticated variants: the credential *is* valid, so the answer is 403 with
/// the missing scope named, not a 401 that would send a runtime into a pointless
/// re-mint loop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentBearerResolution {
    Active {
        identity: AgentBearerIdentity,
        scope_granted: bool,
    },
    Revoked,
    Expired,
    Unknown,
}

impl AgentBearerResolution {
    /// The `audit_log.action` this outcome must be recorded under, or `None` when
    /// Swift records nothing (an unidentified credential).
    pub fn audit_action(&self) -> Option<&'static str> {
        match self {
            AgentBearerResolution::Active {
                scope_granted: true,
                ..
            } => Some(AUDIT_ACTION_USED),
            AgentBearerResolution::Active {
                scope_granted: false,
                ..
            } => Some(AUDIT_ACTION_SCOPE_DENIED),
            _ => None,
        }
    }

    /// Collapse the resolution into the identity or its rejection — the exact
    /// `switch` at the end of Swift's `authenticateAgentBearer` (:197-208).
    ///
    /// `required_scope` is echoed back so the 403 names the missing scope the way
    /// Swift's interpolated message does; it is not re-checked here.
    pub fn require_scoped(
        self,
        required_scope: &str,
    ) -> Result<AgentBearerIdentity, AgentBearerRejection> {
        match self {
            AgentBearerResolution::Active {
                identity,
                scope_granted: true,
            } => Ok(identity),
            AgentBearerResolution::Active {
                scope_granted: false,
                ..
            } => Err(AgentBearerRejection::MissingScope(
                required_scope.to_string(),
            )),
            AgentBearerResolution::Revoked => Err(AgentBearerRejection::Revoked),
            AgentBearerResolution::Expired => Err(AgentBearerRejection::Expired),
            AgentBearerResolution::Unknown => Err(AgentBearerRejection::Unknown),
        }
    }
}

/// Why a presented agent bearer is not usable, with the Swift message verbatim.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AgentBearerRejection {
    /// 401 — the envelope is not `momo_agent_v1.<ws>.<secret>`.
    #[error("invalid agent bearer token")]
    MalformedEnvelope,
    /// 401 — no row for this hash inside the claimed workspace.
    #[error("unknown agent bearer token")]
    Unknown,
    /// 401 — `revoked_at` is set.
    #[error("agent bearer token has been revoked")]
    Revoked,
    /// 401 — `expires_at` has passed.
    #[error("agent bearer token has expired")]
    Expired,
    /// 403 — the row is alive but does not carry the route's scope.
    #[error("{0} scope required")]
    MissingScope(String),
}

impl AgentBearerRejection {
    /// `true` when this rejection is a 403 rather than a 401. The distinction is
    /// the whole point of [`AgentBearerResolution::Active`] carrying
    /// `scope_granted`: a valid credential that lacks a scope must not be told to
    /// go and re-authenticate.
    pub fn is_forbidden(&self) -> bool {
        matches!(self, AgentBearerRejection::MissingScope(_))
    }
}

/// Authenticate an agent bearer inside an already tenant-scoped transaction.
///
/// `conn` must carry the GUC for the workspace named in the envelope (open it
/// with `momo_db::with_tenant_tx` keyed by [`agent_bearer_workspace_id`]), so a
/// token minted for workspace A is `Unknown` when presented with a workspace B
/// scope — the RLS backstop, not a code check.
///
/// The joins are not decoration. Swift requires the actor to still be an
/// **active, undeleted `member` of kind `agent` that has an `agent` row**
/// (:130-139): deactivating an agent member must kill its credential, without
/// anybody remembering to also revoke the token.
pub async fn authenticate_agent_bearer_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    raw_token: &str,
    required_scope: &str,
) -> Result<AgentBearerResolution, sqlx::Error> {
    let row = sqlx::query(
        "SELECT t.id, t.actor_member_id, t.scopes, \
                t.revoked_at IS NOT NULL AS revoked, \
                (t.expires_at IS NOT NULL AND t.expires_at <= now()) AS expired \
           FROM token t \
           JOIN member m \
             ON m.id = t.actor_member_id \
            AND m.workspace_id = t.workspace_id \
            AND m.kind = 'agent' \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
           JOIN agent a \
             ON a.member_id = m.id \
            AND a.workspace_id = m.workspace_id \
          WHERE t.workspace_id = $1 \
            AND t.kind = 'agent_bearer' \
            AND t.subject_member_id IS NULL \
            AND t.token_hash = digest($2::text, 'sha256') \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(raw_token)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else {
        return Ok(AgentBearerResolution::Unknown);
    };
    if row.try_get::<bool, _>("revoked")? {
        return Ok(AgentBearerResolution::Revoked);
    }
    if row.try_get::<bool, _>("expired")? {
        return Ok(AgentBearerResolution::Expired);
    }

    let token_id: Uuid = row.try_get("id")?;
    let member_id: Uuid = row.try_get("actor_member_id")?;
    let scopes: Vec<String> = row.try_get("scopes")?;
    let scope_granted = scopes.iter().any(|scope| scope == required_scope);

    // Swift touches `last_used_at` only on the granted path (:158-163) — a denied
    // attempt is not a use, and recording it as one would corrupt the "when was
    // this credential last exercised" signal an operator rotates on.
    if scope_granted {
        sqlx::query("UPDATE token SET last_used_at = now() WHERE id = $1")
            .bind(token_id)
            .execute(&mut *conn)
            .await?;
    }

    Ok(AgentBearerResolution::Active {
        identity: AgentBearerIdentity {
            token_id,
            member_id,
            workspace_id,
            scopes,
        },
        scope_granted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(workspace: Uuid, secret_chars: usize) -> String {
        format!(
            "{AGENT_BEARER_PREFIX}.{}.{}",
            workspace.to_string().to_lowercase(),
            "a".repeat(secret_chars)
        )
    }

    #[test]
    fn the_envelope_names_a_workspace_and_nothing_else_is_trusted() {
        let workspace = Uuid::from_u128(31);
        assert_eq!(
            agent_bearer_workspace_id(&envelope(workspace, 43)),
            Some(workspace)
        );
    }

    /// Every rejected shape must fall through to the **App JWT** path rather than
    /// being treated as a malformed agent bearer, which is what `None` means to
    /// the middleware (Swift `AuthMiddleware.swift:83`).
    #[test]
    fn a_non_envelope_is_not_an_agent_bearer() {
        let workspace = Uuid::from_u128(31);
        // 42 chars is one short of a 32-byte base64url secret.
        assert_eq!(agent_bearer_workspace_id(&envelope(workspace, 42)), None);
        assert_eq!(
            agent_bearer_workspace_id("momo_agent_v1.not-a-uuid.aaaa"),
            None
        );
        assert_eq!(
            agent_bearer_workspace_id(&format!("momo_agent_v2.{workspace}.{}", "a".repeat(43))),
            None
        );
        // An App JWT also has three dot-separated parts, so the prefix is the
        // only thing separating them: a JWT must never take the bearer path.
        assert_eq!(
            agent_bearer_workspace_id("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln"),
            None
        );
        assert_eq!(agent_bearer_workspace_id("momo_agent_v1.x"), None);
    }

    #[test]
    fn rejection_messages_match_swift() {
        assert_eq!(
            AgentBearerRejection::MalformedEnvelope.to_string(),
            "invalid agent bearer token"
        );
        assert_eq!(
            AgentBearerRejection::Unknown.to_string(),
            "unknown agent bearer token"
        );
        assert_eq!(
            AgentBearerRejection::Revoked.to_string(),
            "agent bearer token has been revoked"
        );
        assert_eq!(
            AgentBearerRejection::Expired.to_string(),
            "agent bearer token has expired"
        );
        assert_eq!(
            AgentBearerRejection::MissingScope("agent:runs:callback".into()).to_string(),
            "agent:runs:callback scope required"
        );
    }

    #[test]
    fn a_live_credential_without_the_scope_is_not_an_authentication_failure() {
        let identity = AgentBearerIdentity {
            token_id: Uuid::from_u128(1),
            member_id: Uuid::from_u128(2),
            workspace_id: Uuid::from_u128(3),
            scopes: vec!["agent:jobs:read".to_string()],
        };
        let denied = AgentBearerResolution::Active {
            identity: identity.clone(),
            scope_granted: false,
        };
        assert_eq!(denied.audit_action(), Some(AUDIT_ACTION_SCOPE_DENIED));
        let rejection = denied
            .require_scoped("agent:runs:callback")
            .expect_err("a missing scope is a rejection");
        assert!(
            rejection.is_forbidden(),
            "a live credential lacking a scope is 403, never 401"
        );
        assert_eq!(
            rejection,
            AgentBearerRejection::MissingScope("agent:runs:callback".to_string())
        );

        let granted = AgentBearerResolution::Active {
            identity: identity.clone(),
            scope_granted: true,
        };
        assert_eq!(granted.audit_action(), Some(AUDIT_ACTION_USED));
        assert_eq!(granted.require_scoped("agent:jobs:read"), Ok(identity));
    }

    /// An unidentified credential writes no audit row (Swift returns `.unknown`
    /// / `.revoked` / `.expired` *before* the INSERT), and every one of them is a
    /// 401 rather than a 403.
    #[test]
    fn an_unidentified_credential_is_not_audited() {
        for resolution in [
            AgentBearerResolution::Unknown,
            AgentBearerResolution::Revoked,
            AgentBearerResolution::Expired,
        ] {
            assert_eq!(resolution.audit_action(), None);
            assert!(!resolution
                .require_scoped("agent:jobs:read")
                .expect_err("not authenticated")
                .is_forbidden());
        }
    }
}
