//! The provider cascade: `provider_link_chain` (migration 042) plus the pure
//! fall-over rule.
//!
//! Port of Swift `Provider/ProviderLinkChainStore.swift` + `ProviderCascade.swift`
//! (ADR-0135 D1).
//!
//! **Position 0 is not in this table.** It is the legacy `provider_link`
//! singleton — or, when no row is configured, the boot-time `HERMES_*` env trio.
//! Migration 042's `position >= 1` CHECK is what keeps the two stores from
//! drifting into two records of the same hop, so nothing here ever writes a 0.
//!
//! **The fall-over rule is the ADR.** Only a provider-side *availability*
//! failure — no response, any 5xx, or 429 — advances to the next hop. Every other
//! 4xx is a caller/config error and propagates, because retrying it on a second
//! provider spends a second budget on the same guaranteed failure and hides the
//! real cause.

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::crypto::open_bearer;
use crate::link::{ProviderSource, ResolvedProvider};
use crate::provider::{redacted_endpoint_label, ProviderMode};

/// Upper bound on configured fallback hops (Swift :34). A cascade is an
/// availability net, not a load balancer: each extra hop multiplies both the
/// worst-case latency of a failing turn and the number of budgets one prompt can
/// spend.
pub const MAX_CHAIN_ENTRIES: usize = 8;

/// Reason label for "the provider never answered" (Swift
/// `ProviderCascadeClassifier.unreachableReason`).
pub const UNREACHABLE_REASON: &str = "provider_unreachable";
/// Reason label for 429 (Swift `rateLimitedReason`).
pub const RATE_LIMITED_REASON: &str = "provider_rate_limited";

/// One stored fallback hop, bearer still sealed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredChainEntry {
    pub id: Uuid,
    pub position: i32,
    pub base_url: String,
    pub bearer_ciphertext: Vec<u8>,
    pub mode: String,
    pub enabled: bool,
    pub updated_by_member_id: Option<Uuid>,
    pub updated_at_ms: i64,
}

/// A stored hop with its bearer opened. Never serialized (ADR-0004).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecryptedChainEntry {
    pub id: Uuid,
    pub position: i32,
    pub base_url: String,
    pub bearer: String,
    pub mode: ProviderMode,
    pub enabled: bool,
}

/// The desired state of one hop as the operator supplied it.
///
/// `bearer: None` means "keep the secret already stored **at this position**".
/// That is why a position is an identity and never silently rewritten: moving a
/// base URL to another position without re-typing its key would pair it with a
/// different provider's credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainEntryInput {
    pub position: i32,
    pub base_url: String,
    pub bearer: Option<String>,
    pub mode: ProviderMode,
    pub enabled: bool,
}

/// Where a cascade hop's configuration came from (Swift `ProviderCascadeHop.Source`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CascadeSource {
    /// Position 0, from the `provider_link` singleton (migration 039).
    ProviderLink,
    /// Position 0 with no DB row — the boot-time `HERMES_*` env trio.
    Environment,
    /// Position >= 1, from `provider_link_chain` (migration 042).
    Chain,
}

impl CascadeSource {
    pub fn as_str(self) -> &'static str {
        match self {
            CascadeSource::ProviderLink => "provider_link",
            CascadeSource::Environment => "environment",
            CascadeSource::Chain => "chain",
        }
    }
}

/// One resolved hop, bearer included. **Never serialize this type** — the REST
/// projection carries a masked tail instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CascadeHop {
    pub position: i32,
    pub source: CascadeSource,
    pub base_url: String,
    pub bearer: String,
    pub mode: ProviderMode,
    pub enabled: bool,
}

impl CascadeHop {
    pub fn endpoint_label(&self) -> String {
        redacted_endpoint_label(&self.base_url)
    }

    /// Swift `isUsable`: URL and bearer both carry real content. A half-written
    /// hop is skipped rather than failing the turn blank.
    pub fn is_usable(&self) -> bool {
        !self.base_url.trim().is_empty() && !self.bearer.trim().is_empty()
    }
}

/// What a real turn would do with a failed hop (Swift `ProviderCascadeDecision`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CascadeDecision {
    /// Provider-side availability failure — try the next hop, record the switch.
    FallOver(String),
    /// Caller/config error — surface it, never silently re-spend.
    Propagate(String),
}

impl CascadeDecision {
    pub fn is_fall_over(&self) -> bool {
        matches!(self, CascadeDecision::FallOver(_))
    }

    pub fn reason(&self) -> &str {
        match self {
            CascadeDecision::FallOver(reason) | CascadeDecision::Propagate(reason) => reason,
        }
    }
}

/// Classify a coarse probe reason (Swift `ProviderCascadeClassifier.decide(probeReason:)`).
///
/// Unknown labels propagate. That default is deliberate: an unrecognised reason
/// is not evidence that the next provider would do better, and treating it as
/// one would turn every future reason string into a silent extra spend.
pub fn classify_probe_reason(reason: Option<&str>) -> CascadeDecision {
    let Some(reason) = reason else {
        return CascadeDecision::Propagate("unknown".to_string());
    };
    if reason == UNREACHABLE_REASON || reason == RATE_LIMITED_REASON {
        return CascadeDecision::FallOver(reason.to_string());
    }
    if let Some(code) = reason
        .strip_prefix("provider_status_")
        .and_then(|code| code.parse::<u16>().ok())
    {
        return classify_status(Some(code));
    }
    CascadeDecision::Propagate(reason.to_string())
}

/// Swift `decide(status:)`. `None` means no response at all.
pub fn classify_status(status: Option<u16>) -> CascadeDecision {
    let Some(status) = status else {
        return CascadeDecision::FallOver(UNREACHABLE_REASON.to_string());
    };
    if status == 429 {
        return CascadeDecision::FallOver(RATE_LIMITED_REASON.to_string());
    }
    let reason = format!("provider_status_{status}");
    if (500..=599).contains(&status) {
        CascadeDecision::FallOver(reason)
    } else {
        CascadeDecision::Propagate(reason)
    }
}

/// Build the whole cascade: the already-resolved position 0, then the chain in
/// ascending position order (Swift `ProviderCascade.plan`).
///
/// `head` arrives resolved, so this never re-implements the DB-over-env
/// precedence that [`crate::link::resolve_link`] owns.
pub fn cascade_plan(head: &ResolvedProvider, chain: &[DecryptedChainEntry]) -> Vec<CascadeHop> {
    let mut hops = vec![CascadeHop {
        position: 0,
        source: match head.source {
            ProviderSource::Database => CascadeSource::ProviderLink,
            ProviderSource::Environment => CascadeSource::Environment,
        },
        base_url: head.config.base_url.clone(),
        bearer: head.config.bearer.clone(),
        mode: head.config.mode,
        enabled: true,
    }];
    let mut sorted: Vec<&DecryptedChainEntry> = chain.iter().collect();
    sorted.sort_by_key(|entry| entry.position);
    hops.extend(sorted.into_iter().map(|entry| CascadeHop {
        position: entry.position,
        source: CascadeSource::Chain,
        base_url: entry.base_url.clone(),
        bearer: entry.bearer.clone(),
        mode: entry.mode,
        enabled: entry.enabled,
    }));
    hops
}

/// The hops a real turn would actually attempt, in order (Swift `attemptable`).
pub fn attemptable_hops(hops: &[CascadeHop]) -> Vec<&CascadeHop> {
    hops.iter()
        .filter(|hop| hop.enabled && hop.is_usable())
        .collect()
}

/// Open one stored hop. `None` when the ciphertext will not open — the caller
/// keeps the row **visible** so a replace-all cannot erase it, but resolution
/// skips it rather than failing the whole chain.
pub fn decrypt_chain_entry(
    stored: &StoredChainEntry,
    master_key: &str,
) -> Option<DecryptedChainEntry> {
    let bearer = open_bearer(&stored.bearer_ciphertext, master_key).ok()?;
    Some(DecryptedChainEntry {
        id: stored.id,
        position: stored.position,
        base_url: stored.base_url.clone(),
        bearer,
        mode: ProviderMode::from_label(&stored.mode).unwrap_or(ProviderMode::LocalMock),
        enabled: stored.enabled,
    })
}

/// One `provider_link_chain` row as it comes off the wire.
type ChainRow = (Uuid, i32, String, Vec<u8>, String, bool, Option<Uuid>, i64);

/// Read the chain in cascade order.
pub async fn read_chain(conn: &mut PgConnection) -> Result<Vec<StoredChainEntry>, DbError> {
    let rows: Vec<ChainRow> = sqlx::query_as(
        "SELECT id, \
                position, \
                base_url, \
                bearer_ciphertext, \
                mode, \
                enabled, \
                updated_by, \
                floor(extract(epoch from updated_at) * 1000)::bigint \
           FROM provider_link_chain \
          ORDER BY position ASC",
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                position,
                base_url,
                bearer_ciphertext,
                mode,
                enabled,
                updated_by,
                updated_at_ms,
            )| {
                StoredChainEntry {
                    id,
                    position,
                    base_url,
                    bearer_ciphertext,
                    mode,
                    enabled,
                    updated_by_member_id: updated_by,
                    updated_at_ms,
                }
            },
        )
        .collect())
}

/// Replace the entire chain (Swift `replaceAll`).
///
/// Replace-all rather than per-row PATCH because `position` is UNIQUE: a partial
/// edit that swaps two positions would need a temporary hole and could leave a
/// half-applied cascade order visible to a concurrently resolving worker. One
/// DELETE + INSERT inside the operator transaction makes the new order atomic.
pub async fn replace_chain(
    conn: &mut PgConnection,
    entries: &[(i32, String, Vec<u8>, String, bool)],
    updated_by: Uuid,
) -> Result<Vec<StoredChainEntry>, DbError> {
    sqlx::query("DELETE FROM provider_link_chain")
        .execute(&mut *conn)
        .await?;
    for (position, base_url, bearer_ciphertext, mode, enabled) in entries {
        sqlx::query(
            "INSERT INTO provider_link_chain \
               (position, base_url, bearer_ciphertext, mode, enabled, updated_by, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, now())",
        )
        .bind(position)
        .bind(base_url)
        .bind(bearer_ciphertext)
        .bind(mode)
        .bind(enabled)
        .bind(updated_by)
        .execute(&mut *conn)
        .await?;
    }
    read_chain(&mut *conn).await
}

/// Drop every fallback hop; returns how many were removed.
pub async fn delete_all_chain_entries(conn: &mut PgConnection) -> Result<u64, DbError> {
    let removed = sqlx::query("DELETE FROM provider_link_chain")
        .execute(&mut *conn)
        .await?
        .rows_affected();
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderConfig;

    fn head(source: ProviderSource) -> ResolvedProvider {
        ResolvedProvider {
            config: ProviderConfig {
                mode: ProviderMode::ExternalHermes,
                base_url: "https://head.example.com/v1".into(),
                bearer: "sk-head-000".into(),
                allow_local_loopback: false,
            },
            source,
        }
    }

    fn hop(position: i32, bearer: &str, enabled: bool) -> DecryptedChainEntry {
        DecryptedChainEntry {
            id: Uuid::from_u128(position as u128),
            position,
            base_url: format!("https://hop{position}.example.com/v1"),
            bearer: bearer.into(),
            mode: ProviderMode::ExternalHermes,
            enabled,
        }
    }

    /// The rule the ADR exists for. Only an availability failure advances.
    #[test]
    fn only_no_response_5xx_and_429_fall_over() {
        assert!(classify_status(None).is_fall_over());
        assert!(classify_status(Some(429)).is_fall_over());
        assert!(classify_status(Some(503)).is_fall_over());
        assert!(classify_status(Some(500)).is_fall_over());
        for caller_error in [400, 401, 403, 404, 422] {
            assert!(
                !classify_status(Some(caller_error)).is_fall_over(),
                "{caller_error}: retrying a caller error spends a second budget on the same failure"
            );
        }
    }

    #[test]
    fn probe_reasons_reclassify_through_the_same_table() {
        assert!(classify_probe_reason(Some(UNREACHABLE_REASON)).is_fall_over());
        assert!(classify_probe_reason(Some(RATE_LIMITED_REASON)).is_fall_over());
        assert!(classify_probe_reason(Some("provider_status_502")).is_fall_over());
        assert!(!classify_probe_reason(Some("provider_status_401")).is_fall_over());
        assert!(!classify_probe_reason(Some("provider_auth_failed")).is_fall_over());
        assert!(
            !classify_probe_reason(Some("something_new")).is_fall_over(),
            "an unknown reason is not evidence the next provider would do better"
        );
        assert_eq!(
            classify_probe_reason(None),
            CascadeDecision::Propagate("unknown".into())
        );
    }

    /// Position 0 comes from the resolver, not from this table — and its
    /// `source` says which of the two tiers won.
    #[test]
    fn the_plan_starts_at_the_head_and_names_its_tier() {
        let plan = cascade_plan(&head(ProviderSource::Database), &[]);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].position, 0);
        assert_eq!(plan[0].source, CascadeSource::ProviderLink);

        let plan = cascade_plan(&head(ProviderSource::Environment), &[]);
        assert_eq!(plan[0].source, CascadeSource::Environment);
    }

    #[test]
    fn hops_are_planned_in_ascending_position_order() {
        let plan = cascade_plan(
            &head(ProviderSource::Database),
            &[hop(3, "sk-3", true), hop(1, "sk-1", true)],
        );
        assert_eq!(
            plan.iter().map(|hop| hop.position).collect::<Vec<_>>(),
            vec![0, 1, 3]
        );
    }

    /// `attemptableCount` includes position 0 — the panel's copy depends on it,
    /// and the plan a real turn walks starts at the head.
    #[test]
    fn attemptable_counts_the_head_and_drops_parked_or_half_written_hops() {
        let plan = cascade_plan(
            &head(ProviderSource::Database),
            &[
                hop(1, "sk-1", true),
                hop(2, "sk-2", false),
                hop(3, "   ", true),
            ],
        );
        let attemptable = attemptable_hops(&plan);
        assert_eq!(
            attemptable
                .iter()
                .map(|hop| hop.position)
                .collect::<Vec<_>>(),
            vec![0, 1],
            "two live fallbacks behind a live head answer 3, not 2 — and a parked \
             or bearer-less hop is neither"
        );
    }

    #[test]
    fn an_unopenable_hop_is_absent_from_resolution_but_its_row_is_not_lost() {
        let sealed = crate::crypto::seal_bearer("sk-hop", "master").expect("seal");
        let stored = StoredChainEntry {
            id: Uuid::from_u128(1),
            position: 1,
            base_url: "https://hop.example.com/v1".into(),
            bearer_ciphertext: sealed,
            mode: "external-hermes".into(),
            enabled: true,
            updated_by_member_id: None,
            updated_at_ms: 1,
        };
        assert!(decrypt_chain_entry(&stored, "master").is_some());
        assert!(
            decrypt_chain_entry(&stored, "rotated").is_none(),
            "the caller keeps the row visible; only resolution skips it"
        );
    }

    #[test]
    fn the_chain_cap_is_the_swift_cap() {
        assert_eq!(MAX_CHAIN_ENTRIES, 8);
    }
}
