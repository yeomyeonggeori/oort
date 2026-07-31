//! `momo-settings` — the operator/settings domain crate (batch B4.2).
//!
//! B4.1 closed the dogfooding *sequence*; what stayed shut was the **설정 표면**
//! the diff matrix records as D-3 (`docs/planning/2026-08-01-b4-contract-diff.md`
//! §7, §9.3): AI 연결·체인·코드 실행 호스트·티어 정책·초대·워크스페이스 생성.
//! Every one of those is a settings row, and none of them belongs to the message
//! spine, so they get their own crate rather than a seventh module in
//! `momo-messaging`.
//!
//! The crate rules are the ones every other domain crate here follows:
//!
//! * **It owns SQL; routes own none.** Each function takes a caller-supplied
//!   `&mut PgConnection`, so `momo_db::with_tenant_tx` (and its two operator
//!   variants) stay the only wiring points for the RLS GUCs — invariant #6 is
//!   structural, not a convention.
//! * **It owns no outbox SQL and emits nothing.** Nothing in a settings write is
//!   a timeline event; the one broadcast-shaped settings surface that exists
//!   (`notification-pref`) already lives in `momo-messaging`.
//! * **ADR-0004 holds at the type level.** The provider bearer exists in memory
//!   only on the seal/open boundary ([`crypto`]); every type that can leave the
//!   process carries a masked 4-character tail instead
//!   ([`crypto::masked_tail`]), and no struct here has a field that could hold a
//!   provider OAuth token or a raw API key.
//!
//! ## Module map (Swift source of truth for each)
//!
//! | module | surface | Swift |
//! |---|---|---|
//! | [`provider`] | provider mode/URL vocabulary, endpoint redaction, base-URL validation | `Config.swift:502-700`, `AgentRoutes.validatedBaseURL` |
//! | [`crypto`] | AES-GCM sealed bearer + masked tail | `Provider/ProviderLinkCrypto.swift` |
//! | [`link`] | `provider_link` singleton store + DB-over-env resolution | `Provider/ProviderLinkStore.swift`, `ProviderLinkResolver.swift` |
//! | [`chain`] | `provider_link_chain` store + the cascade plan/classifier | `Provider/ProviderLinkChainStore.swift`, `ProviderCascade.swift` |
//! | [`engine`] | `work_host_engine` per-workspace selection | `Provider/WorkHostEngineStore.swift` |
//! | [`tier`] | `work_tier_policy` workspace default + member override | `Routes/WorkTierPolicyRoutes.swift` |
//! | [`quota`] | `quota_snapshot` read side | `Routes/ProviderQuotaSnapshotRoutes.swift:list` |
//! | [`invite`] | `invite_code` create/list/read | `Routes/InviteRoutes.swift` |
//! | [`join`] | spending an invite (`POST /v1/join`) | `Routes/JoinRoutes.swift` |
//! | [`workspace`] | tenant provisioning (`POST /v1/workspaces`) | `Routes/WorkspaceRoutes.create` |
//!
//! **B4.3 adds [`join`], the half that spends what [`invite`] mints.** It is in
//! this crate and not another because `invite_code` has exactly one owner, and
//! that includes the one statement that runs *before* the tenant GUC exists:
//! `momo_join_private.invite_workspace_id` (migration 009), the EXECUTE-only
//! definer function that maps a code to its workspace and nothing else. See
//! [`join`]'s module docs for why that placement is the invariant-preserving one.

pub mod chain;
pub mod crypto;
pub mod engine;
pub mod invite;
pub mod join;
pub mod link;
pub mod provider;
pub mod quota;
pub mod tier;
pub mod workspace;

pub use chain::{
    attemptable_hops, cascade_plan, classify_probe_reason, decrypt_chain_entry,
    delete_all_chain_entries, read_chain, replace_chain, CascadeDecision, CascadeHop,
    CascadeSource, ChainEntryInput, DecryptedChainEntry, StoredChainEntry, MAX_CHAIN_ENTRIES,
    RATE_LIMITED_REASON, UNREACHABLE_REASON,
};
pub use crypto::{masked_tail, open_bearer, seal_bearer, CryptoError, SEALED_BOX_VERSION};
pub use engine::{
    read_work_host_engine, upsert_work_host_engine, validated_engine, StoredWorkHostEngine,
    ALLOWED_ENGINES, DEFAULT_ENGINE,
};
pub use invite::{
    clamp_invite_list_limit, create_invite, list_invites, normalized_invite_role, read_invite,
    validated_expires_at_ms, validated_max_uses, CreatedInvite, InviteCode, InviteSpecInvalid,
};
pub use join::{
    fallback_handle, is_valid_handle, normalized_invite_code, normalized_join_display_name,
    normalized_join_email, normalized_join_password, normalized_join_time_zone,
    normalized_requested_handle, redeem_invite_in_tx, resolve_invite_workspace, role_rank,
    JoinError, JoinOutcome, JoinRejection, JoinRequestValues, JoinSpecInvalid, JoinedMember,
    JoinedMembership,
};
pub use link::{
    decrypt_link, delete_link, read_link, resolve_link, upsert_link, DecryptedProviderLink,
    ProviderSource, ResolvedProvider, StoredProviderLink,
};
pub use provider::{
    is_unsafe_secret, redacted_endpoint_label, requires_strict_external_provider,
    validated_base_url, BaseUrlInvalid, ProviderConfig, ProviderMode,
};
pub use quota::{list_quota_snapshots, QuotaSnapshot};
pub use tier::{
    load_tier_policy, tier_target_allowed, upsert_tier_policy, validated_auto_target,
    validated_tier_mode, TierPolicy, TierScope, TierSpecInvalid, TierTargetRejected,
};
pub use workspace::{
    create_workspace_in_tx, normalized_workspace_name, normalized_workspace_slug, CreatedWorkspace,
    WorkspaceProvisionRejected, WorkspaceSpecInvalid,
};
