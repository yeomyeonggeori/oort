//! The owner-key door: an `owner_only` agent whose brain is its owner's
//! personal API key (#3396, ADR-0147 증보 2026-10-03).
//!
//! This is deliberately **not** part of [`AgentWorker::resolve_transport`]. That
//! function is the team's door, and `personal_credential_isolation.rs` pins that
//! it names no fact of a person's runtime. A personal credential is resolved
//! here, from the agent's own row, for that agent's turn only, and the rules are
//! one-directional:
//!
//! * the key is found through the *agent* (`owner_only` + `uses_owner_key` +
//!   `agent.owner_human_id`), never through the person who asked — a turn that
//!   reaches this door for agent A can only ever see A's owner's key;
//! * a missing, revoked, unreadable or non-API-key credential means **no
//!   answer** ([`OwnerKeyTransport::Unavailable`]). It never means the team's
//!   env bearer, the team's `provider_link`, a chain hop or the 「기본 AI」 row:
//!   the caller does not even compute those for this turn (ADR-0135 D1, #2897);
//! * nothing is cached. A revoke is the next turn's refusal, not "after the TTL".

use momo_settings::{decrypt_personal_link, read_owner_key_for_agent, LinkCredential};
use uuid::Uuid;

use crate::provider::{ProviderEndpoint, ProviderWire};
use crate::{with_tenant_tx, AgentWorker, ResolvedTransport};

/// `ProviderEndpoint::source` of a personal-key turn: the only provenance fact
/// that may be logged. It names a *kind*, never an owner or a key.
pub const PERSONAL_KEY_SOURCE: &str = "personal_key";

/// The outcome of resolving an owner-key agent's credential.
pub enum OwnerKeyTransport {
    Ready(Box<ResolvedTransport>),
    /// No usable personal key for this agent: refuse the turn, say so, and do
    /// not borrow another credential.
    Unavailable(&'static str),
    /// The database could not be read. Retryable; still never a fallback.
    ReadFailed(String),
}

impl AgentWorker {
    pub(crate) async fn resolve_owner_key_transport(
        &self,
        workspace_id: Uuid,
        agent_member_id: Uuid,
    ) -> OwnerKeyTransport {
        let Some(master_key) = self.config.provider_link_master_key.as_deref() else {
            return OwnerKeyTransport::Unavailable("no master key");
        };
        let stored = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(
                async move { read_owner_key_for_agent(conn, workspace_id, agent_member_id).await },
            )
        })
        .await;
        let stored = match stored {
            Ok(Some(stored)) => stored,
            Ok(None) => return OwnerKeyTransport::Unavailable("no active personal key"),
            Err(error) => return OwnerKeyTransport::ReadFailed(error.to_string()),
        };
        let opened = match decrypt_personal_link(&stored, master_key) {
            Ok(opened) => opened,
            Err(error) => {
                // The error text names no key material, only why it was refused.
                tracing::warn!(
                    agent_member_id = %agent_member_id,
                    error = %error,
                    "personal key present but not usable; refusing the turn"
                );
                return OwnerKeyTransport::Unavailable("personal key unusable");
            }
        };
        let endpoint = ProviderEndpoint {
            base_url: opened.base_url,
            bearer: opened.credential.presentable_bearer().to_string(),
            source: PERSONAL_KEY_SOURCE,
            wire: ProviderWire::for_credential(&opened.credential),
            account_id: None,
        };
        // A personal key is never an OAuth grant (decrypt refuses one), so the
        // refresh / re-seal machinery has nothing to do with it: `Bearer` or
        // `AnthropicKey` only, and no `provider_link` timestamp to write back to.
        debug_assert!(!matches!(opened.credential, LinkCredential::OpenAiOAuth(_)));
        OwnerKeyTransport::Ready(Box::new(ResolvedTransport {
            endpoint,
            credential: opened.credential,
            link_updated_at_ms: None,
        }))
    }
}
