//! The AI 연결 surface — the instance-global provider link and its cascade
//! chain (B4.2, diff-matrix D-3).
//!
//! ```text
//! GET    /v1/provider/link          PUT /v1/provider/link      DELETE /v1/provider/link
//! POST   /v1/provider/link/test
//! GET    /v1/provider/link/chain    PUT …/chain                DELETE …/chain
//! ```
//!
//! Ports Swift `Routes/ProviderLinkRoutes.swift` + `ProviderLinkChainRoutes.swift`
//! (MOMO-572/583/622 · ADR-0004 증보 1 · ADR-0135 D1). Client:
//! `clients/web/src/features/settings/api.ts:132-255`.
//!
//! ## Three things this module holds on to
//!
//! 1. **The bearer is write-only.** It arrives in a PUT body, is sealed by
//!    `momo_settings::seal_bearer` before any statement runs, and is never
//!    logged, audited, or echoed. Responses carry `bearerConfigured` plus at most
//!    a 4-character tail.
//! 2. **Authorization completes before the GUC.** `require_instance_operator`
//!    runs its read in the operator's own tenant transaction; only afterwards
//!    does `with_provider_link_admin_tx` unlock the `provider_link` policy.
//! 3. **Position 0 is edited here and nowhere else.** `PUT …/chain` refuses
//!    position 0 with a 400, so the singleton has exactly one writer and the two
//!    stores cannot drift into two records of the same hop.
//!
//! ## The live probe (#2960)
//!
//! `POST /v1/provider/link/test` first decides everything that needs no socket
//! — operator authorization, cascade resolution, and the three configuration
//! verdicts Swift's `probeHop` reaches without calling anything (`hop_disabled`,
//! `not_external_provider`, `provider_not_configured`). A hop that is enabled,
//! external and usable is then **dialled**: one read-only GET through
//! `momo_provider_probe` (ADR-0147 증보 2026-09-27 「연결 확인」) — `{base}/models`
//! with the credential the sealed envelope's kind selects, or OpenRouter's
//! `{base}/key`. The crate owns the HTTP client, so this binary still links no
//! `reqwest` (invariant #2 as ADR-0149 narrowed it), and every call goes through
//! the #2852 egress guard.
//!
//! What comes back per hop is a machine reason from the panel's existing
//! vocabulary (`provider_auth_failed`, `provider_unreachable`,
//! `provider_rate_limited`, `provider_status_NNN`, plus `provider_egress_denied`
//! and `provider_invalid_response`) and a `probe` object holding only numbers
//! the provider itself stated — plus, since #3009, the sanitized model ids its
//! `/models` list named (`modelIds`, `momo_provider_probe::model_ids`). The one
//! hop still reported as `probe_not_run` is a legacy `oauth-openai` link: its
//! access token is refreshed by the worker, and no new such link can be made
//! (ADR-0147 증보 2026-09-26).
//!
//! Two throttles bound what an operator can make this server send: a per-member
//! window on the route (429 + `Retry-After`) and a per-link cache that reuses the
//! last report for [`PROBE_CACHE_TTL`] instead of dialling again.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::with_provider_link_admin_tx;
use momo_provider_probe::{ProbeCache, ProbeCredential, ProbeReport, ProbeTarget, ProviderProbe};
use momo_settings::{
    attemptable_hops, cascade_plan, classify_probe_reason, decrypt_chain_entry, decrypt_link,
    delete_all_chain_entries, delete_link, masked_tail, read_chain, read_link,
    redacted_endpoint_label, replace_chain, requires_strict_external_provider, resolve_link,
    same_origin, seal_bearer, upsert_link, validated_base_url, CascadeHop, CascadeSource,
    ChainEntryInput, DecryptedChainEntry, DecryptedProviderLink, LinkCredential, ProviderFormat,
    ProviderMode, ProviderSource, ResolvedProvider, StoredChainEntry, StoredProviderLink,
    ATTRIBUTION_NOTICE_KO, MAX_CHAIN_ENTRIES, PROVIDER_PRESETS,
};

use crate::dto::{
    ProviderChainEntryDto, ProviderChainProbeDto, ProviderChainResponse, ProviderKeyCreditDto,
    ProviderLinkCredentialMeta, ProviderLinkResponse, ProviderLinkTestResponse,
    ProviderProbeDetailDto, ProviderRateLimitDto, PutProviderChainRequest, PutProviderLinkRequest,
};
use crate::error::ApiError;
use crate::rate_limit::{too_many_requests, SlidingWindowRateLimiter};
use crate::routes::shared::{audit_via_token_id, require_instance_operator};
use crate::AppState;

const LINK_SCHEMA: &str = "momo.provider_link.v0";
const CHAIN_SCHEMA: &str = "momo.provider_link.chain.v0";
const TEST_SCHEMA: &str = "momo.provider_link.test.v0";

/// The reason label for a hop this server does not dial (a legacy
/// `oauth-openai` link — see the module docs). The client renders it as
/// "확인이 끝나지 않았습니다", which is not a verdict about the provider.
const PROBE_NOT_RUN: &str = "probe_not_run";

/// Per-hop request timeout for the live probe.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a link's last report is reused instead of dialling again.
pub const PROBE_CACHE_TTL: Duration = Duration::from_secs(20);
/// `POST …/link/test` calls one operator may make per [`OPERATOR_PROBE_WINDOW`].
pub const OPERATOR_PROBES_PER_WINDOW: u32 = 6;
pub const OPERATOR_PROBE_WINDOW: Duration = Duration::from_secs(60);

/// The probe and its two throttles (see the module docs).
pub struct ProviderProbeState {
    probe: Arc<dyn ProviderProbe>,
    cache: ProbeCache,
    operators: SlidingWindowRateLimiter,
}

impl ProviderProbeState {
    pub fn new(probe: Arc<dyn ProviderProbe>) -> ProviderProbeState {
        ProviderProbeState {
            probe,
            cache: ProbeCache::new(PROBE_CACHE_TTL),
            operators: SlidingWindowRateLimiter::new(),
        }
    }
}

/// Every route in this module needs the AES-GCM master key: without it the
/// stored ciphertext cannot be opened and a new one cannot be sealed. Answering
/// 503 is the only honest option — a 200 would have to invent a bearer state.
fn master_key(state: &AppState) -> Result<&str, ApiError> {
    state
        .settings
        .provider_link_master_key
        .as_deref()
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "이 서버에는 PROVIDER_LINK_MASTER_KEY가 설정되어 있지 않아 AI 계정 연결을 \
                 저장하거나 읽을 수 없어요. 인스턴스 운영자에게 문의해 주세요.",
            )
        })
}

/// Swift `resolvedMode` (:379-392): absent means `external-hermes`, because
/// configuring a link *is* choosing the external boundary; an unknown value is a
/// 400 rather than a silent downgrade to a mock.
fn resolved_mode(raw: Option<&str>) -> Result<ProviderMode, ApiError> {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(ProviderMode::ExternalHermes),
        Some(raw) => ProviderMode::from_label(raw).ok_or_else(|| {
            ApiError::bad_request(
                "mode must be one of local-mock, internal-host-mock, external-hermes",
            )
        }),
    }
}

// ---------------------------------------------------------------------------
// projection
// ---------------------------------------------------------------------------

/// The singleton response (Swift `makeResponse` :241-268).
fn link_response(
    state: &AppState,
    stored: Option<&StoredProviderLink>,
    decrypted: Option<&DecryptedProviderLink>,
) -> ProviderLinkResponse {
    let resolved = resolve_link(&state.settings.env_provider, decrypted);
    let config = &resolved.config;
    let strict = requires_strict_external_provider(&state.settings.environment);
    let from_database = resolved.source == ProviderSource::Database;
    let credential = from_database
        .then(|| decrypted.map(|link| &link.credential))
        .flatten();
    let oauth = credential.and_then(LinkCredential::as_openai_oauth);

    // An OAuth link's *credential* is what makes it configured, not the access
    // token it happens to be holding: a freshly registered grant has no token
    // until the worker's next turn, and reporting that as "no bearer" would tell
    // the operator their save had not worked.
    let credential_configured = match credential {
        Some(credential) => credential.is_present(),
        None => config.key_configured(),
    };
    // Same reasoning for the diagnostics: `HERMES_API_KEY is missing` is a true
    // statement about an env trio and a false one about a grant.
    let mut diagnostics =
        config.validation_errors(strict || config.mode == ProviderMode::ExternalHermes, None);
    if oauth.is_some() {
        diagnostics.retain(|message| !message.starts_with("HERMES_API_KEY"));
    }

    ProviderLinkResponse {
        schema: LINK_SCHEMA,
        configured: from_database,
        source: resolved.source.as_str().to_string(),
        mode: config.mode.as_str().to_string(),
        base_url: config.base_url.clone(),
        endpoint_label: config.endpoint_label(),
        bearer_configured: credential_configured,
        bearer_last4: if from_database {
            decrypted.and_then(|link| masked_tail(&link.bearer))
        } else {
            None
        },
        availability: if oauth.is_some() && diagnostics.is_empty() {
            "available".to_string()
        } else {
            config.availability().to_string()
        },
        key_configured: credential_configured,
        updated_at_ms: from_database
            .then(|| stored.map(|row| row.updated_at_ms))
            .flatten(),
        updated_by: from_database
            .then(|| {
                stored.and_then(|row| row.updated_by_member_id.map(|member| member.to_string()))
            })
            .flatten(),
        diagnostics,
        credential_kind: credential.map(|credential| credential.kind_label().to_string()),
        format: credential.and_then(|credential| match credential {
            LinkCredential::Bearer(_) => Some(ProviderFormat::Openai.as_str()),
            LinkCredential::AnthropicKey(_) => Some(ProviderFormat::Anthropic.as_str()),
            LinkCredential::OpenAiOAuth(_) => None,
        }),
        presets: &PROVIDER_PRESETS,
        credential_meta: oauth.map(|oauth| ProviderLinkCredentialMeta {
            attribution: oauth.attribution.clone(),
            usage_scope: oauth.usage_scope.clone(),
            account_label: oauth.account_label.clone(),
            notice: ATTRIBUTION_NOTICE_KO,
            access_token_present: oauth.presentable_access_token().is_some(),
            access_token_expires_at_ms: oauth.expires_at_ms,
        }),
    }
}

/// The credential a `PUT` body describes: exactly one of a bearer or a grant —
/// and a grant is always refused now (#2911), so in practice a bearer.
///
/// Requiring exactly one is not pedantry — a body carrying both leaves the
/// operator's intent genuinely ambiguous, and picking a winner silently would
/// store the credential they did not mean to store.
fn requested_credential(request: &PutProviderLinkRequest) -> Result<LinkCredential, ApiError> {
    let bearer = request
        .bearer
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let format = ProviderFormat::from_label(request.format.as_deref())
        .ok_or_else(|| ApiError::bad_request("format must be one of openai, anthropic"))?;
    match (bearer, request.oauth.as_ref()) {
        (Some(_), Some(_)) => Err(ApiError::bad_request(
            "send either bearer or oauth, not both — a link carries one credential",
        )),
        (None, None) => Err(ApiError::bad_request("bearer must not be empty")),
        // Review N4: a "bearer" that is itself a sealed-envelope document
        // would be re-read as another credential kind on decrypt.
        (Some(bearer), None) if LinkCredential::parse(bearer).kind_label() != "bearer" => Err(
            ApiError::bad_request("bearer must be an API key, not a credential envelope"),
        ),
        (Some(bearer), None) => Ok(match format {
            ProviderFormat::Openai => LinkCredential::Bearer(bearer.to_string()),
            ProviderFormat::Anthropic => LinkCredential::AnthropicKey(bearer.to_string()),
        }),
        (None, Some(_)) if format == ProviderFormat::Anthropic => Err(ApiError::bad_request(
            "format anthropic takes an API key in bearer, not an oauth grant",
        )),
        // #2911, ADR-0147 증보 2026-09-27: an `auth.json` (oauth-openai) grant
        // can no longer start a link, from any surface. A link that already
        // holds one stays readable and deletable (GET / DELETE), and the
        // worker keeps refreshing and re-sealing it; only creation is closed.
        (None, Some(_)) => Err(ApiError::bad_request(
            "new auth.json (oauth-openai) links are no longer accepted — connect with an API key \
             (ADR-0147, 2026-09-27)",
        )),
    }
}

/// Everything the chain surfaces need, resolved once so a projection is
/// internally consistent (Swift `resolvedCascade` :157-183).
struct ResolvedCascade {
    head: ResolvedProvider,
    head_decrypted: Option<DecryptedProviderLink>,
    hops: Vec<CascadeHop>,
    decrypted_chain: Vec<DecryptedChainEntry>,
}

fn resolve_cascade(
    state: &AppState,
    master_key: &str,
    stored_link: Option<&StoredProviderLink>,
    stored_chain: &[StoredChainEntry],
) -> ResolvedCascade {
    let head_decrypted = stored_link.and_then(|row| match decrypt_link(row, master_key) {
        Ok(link) => Some(link),
        Err(error) => {
            // Never silently erase a configured row from the operator's view: it
            // stays visible (`bearerUnavailable`) so a replace-all cannot delete
            // what they can still see.
            tracing::error!(%error, "provider_link cannot be decrypted");
            None
        }
    });
    let head = resolve_link(&state.settings.env_provider, head_decrypted.as_ref());
    let decrypted_chain: Vec<DecryptedChainEntry> = stored_chain
        .iter()
        .filter_map(|row| match decrypt_chain_entry(row, master_key) {
            Some(entry) => Some(entry),
            None => {
                tracing::error!(
                    position = row.position,
                    "provider_link_chain hop cannot be decrypted"
                );
                None
            }
        })
        .collect();
    let hops = cascade_plan(&head, &decrypted_chain);
    ResolvedCascade {
        head,
        head_decrypted,
        hops,
        decrypted_chain,
    }
}

/// The chain response (Swift `chainResponse` :185-236).
fn chain_response(
    state: &AppState,
    master_key: &str,
    stored_link: Option<&StoredProviderLink>,
    stored_chain: &[StoredChainEntry],
) -> ProviderChainResponse {
    let resolved = resolve_cascade(state, master_key, stored_link, stored_chain);
    let head_from_database = resolved.head.source == ProviderSource::Database;
    let head_entry = ProviderChainEntryDto {
        position: 0,
        source: match resolved.head.source {
            ProviderSource::Database => CascadeSource::ProviderLink,
            ProviderSource::Environment => CascadeSource::Environment,
        }
        .as_str()
        .to_string(),
        mode: resolved.head.config.mode.as_str().to_string(),
        base_url: resolved.head.config.base_url.clone(),
        endpoint_label: redacted_endpoint_label(&resolved.head.config.base_url),
        enabled: true,
        bearer_configured: resolved.head.config.key_configured(),
        bearer_unavailable: head_from_database && resolved.head_decrypted.is_none(),
        bearer_last4: if head_from_database {
            resolved
                .head_decrypted
                .as_ref()
                .and_then(|link| masked_tail(&link.bearer))
        } else {
            None
        },
        updated_at_ms: head_from_database
            .then(|| stored_link.map(|row| row.updated_at_ms))
            .flatten(),
        updated_by: head_from_database
            .then(|| stored_link.and_then(|row| row.updated_by_member_id.map(|id| id.to_string())))
            .flatten(),
    };

    let mut entries = vec![head_entry];
    for row in stored_chain {
        let decrypted = resolved
            .decrypted_chain
            .iter()
            .find(|entry| entry.position == row.position);
        entries.push(ProviderChainEntryDto {
            position: row.position,
            source: CascadeSource::Chain.as_str().to_string(),
            mode: row.mode.clone(),
            base_url: row.base_url.clone(),
            endpoint_label: redacted_endpoint_label(&row.base_url),
            enabled: row.enabled,
            bearer_configured: decrypted.is_some(),
            bearer_unavailable: decrypted.is_none(),
            bearer_last4: decrypted.and_then(|entry| masked_tail(&entry.bearer)),
            updated_at_ms: Some(row.updated_at_ms),
            updated_by: row.updated_by_member_id.map(|id| id.to_string()),
        });
    }

    ProviderChainResponse {
        schema: CHAIN_SCHEMA,
        fallback_count: entries.len() - 1,
        attemptable_count: attemptable_hops(&resolved.hops).len(),
        entries,
    }
}

// ---------------------------------------------------------------------------
// GET / PUT / DELETE /v1/provider/link
// ---------------------------------------------------------------------------

pub async fn get(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<ProviderLinkResponse>, ApiError> {
    require_instance_operator(&state, &principal).await?;
    let key = master_key(&state)?.to_string();

    let stored = with_provider_link_admin_tx(&state.pool, principal.workspace_id, move |conn| {
        Box::pin(async move { read_link(conn).await })
    })
    .await
    .map_err(|error| ApiError::internal("provider_link.get", error))?;

    let decrypted = stored.as_ref().and_then(|row| decrypt_link(row, &key).ok());
    Ok(Json(link_response(
        &state,
        stored.as_ref(),
        decrypted.as_ref(),
    )))
}

pub async fn put(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<PutProviderLinkRequest>,
) -> Result<Json<ProviderLinkResponse>, ApiError> {
    require_instance_operator(&state, &principal).await?;
    let key = master_key(&state)?.to_string();

    let base_url = validated_base_url(
        &request.base_url,
        &state.settings.environment,
        state.settings.env_provider.allow_local_loopback,
    )
    .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let credential = requested_credential(&request)?;
    let mode = resolved_mode(request.mode.as_deref())?;
    let credential_kind = credential.kind_label();
    let ciphertext = seal_bearer(&credential.to_sealed_plaintext(), &key)
        .map_err(|error| ApiError::internal("provider_link.seal", error))?;

    // provider_link is instance-global (no `:ws` segment); the audit row is
    // attributed to the acting operator's home workspace, which is also the GUC
    // this transaction binds.
    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let endpoint_label = redacted_endpoint_label(&base_url);

    let stored = with_provider_link_admin_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let saved = upsert_link(conn, &base_url, &ciphertext, mode.as_str(), member_id).await?;
            write_audit(
                conn,
                &AuditEntry::new(workspace_id, "provider_link.updated")
                    .by(member_id)
                    .via_token(via_token)
                    .with_schema(
                        "momo.provider_link.audit.v1",
                        serde_json::json!({
                            "mode": mode.as_str(),
                            // Endpoint LABEL only — never the base_url's query or
                            // userinfo, and never the bearer (ADR-0004 evidence rule).
                            "endpoint_label": endpoint_label,
                            "bearer_configured": true,
                            // Which KIND of credential was stored. Non-secret, and
                            // the fact an auditor needs to see that an instance
                            // moved onto the ADR-0147 subscription path.
                            "credential_kind": credential_kind,
                        }),
                    ),
            )
            .await?;
            Ok(saved)
        })
    })
    .await
    .map_err(|error| ApiError::internal("provider_link.put", error))?;

    let decrypted = decrypt_link(&stored, &key).ok();
    Ok(Json(link_response(
        &state,
        Some(&stored),
        decrypted.as_ref(),
    )))
}

pub async fn delete(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<ProviderLinkResponse>, ApiError> {
    require_instance_operator(&state, &principal).await?;
    // The key is still required: a DELETE on an instance that cannot open the
    // row is an operator acting blind, and the surface reports 503 uniformly
    // rather than letting one verb through.
    master_key(&state)?;

    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    with_provider_link_admin_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let existed = delete_link(conn).await?;
            if existed {
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "provider_link.deleted")
                        .by(member_id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.provider_link.audit.v1",
                            serde_json::json!({"bearer_configured": false}),
                        ),
                )
                .await?;
            }
            Ok(())
        })
    })
    .await
    .map_err(|error| ApiError::internal("provider_link.delete", error))?;

    // After deletion the effective config is the env fallback.
    Ok(Json(link_response(&state, None, None)))
}

// ---------------------------------------------------------------------------
// POST /v1/provider/link/test
// ---------------------------------------------------------------------------

pub async fn test(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Response, ApiError> {
    require_instance_operator(&state, &principal).await?;
    let key = master_key(&state)?.to_string();

    // Per-operator window, checked after authorization so a stranger cannot
    // spend an operator's budget, and before any read or dial.
    let verdict = state.provider_probe.operators.check(
        &format!("provider_probe:operator:{}", principal.member_id),
        OPERATOR_PROBES_PER_WINDOW,
        OPERATOR_PROBE_WINDOW,
    );
    if !verdict.allowed {
        return Ok(too_many_requests(verdict.retry_after_seconds));
    }

    let (stored_link, stored_chain) =
        with_provider_link_admin_tx(&state.pool, principal.workspace_id, move |conn| {
            Box::pin(async move {
                let link = read_link(conn).await?;
                let chain = read_chain(conn).await?;
                Ok((link, chain))
            })
        })
        .await
        .map_err(|error| ApiError::internal("provider_link.test", error))?;

    let resolved = resolve_cascade(&state, &key, stored_link.as_ref(), &stored_chain);
    let head_credential = (resolved.head.source == ProviderSource::Database)
        .then(|| {
            resolved
                .head_decrypted
                .as_ref()
                .map(|link| &link.credential)
        })
        .flatten();

    // Decide what needs no socket; dial the rest concurrently so one dead hop
    // does not serialise the route.
    let mut entries: Vec<Option<ProviderChainProbeDto>> = Vec::with_capacity(resolved.hops.len());
    let mut dials = tokio::task::JoinSet::new();
    for (index, hop) in resolved.hops.iter().enumerate() {
        let credential = if index == 0 {
            hop_credential(hop, head_credential)
        } else {
            hop_credential(hop, None)
        };
        match configuration_verdict(hop, credential.as_ref()) {
            Some(decided) => entries.push(Some(decided)),
            None => {
                entries.push(None);
                let target = ProbeTarget {
                    base_url: hop.base_url.clone(),
                    credential: credential.expect("a dialled hop has a credential"),
                };
                let probe_state = state.provider_probe.clone();
                let position = hop.position;
                dials.spawn(async move {
                    let (probed_at_ms, report, cached) =
                        probe_through_cache(&probe_state, &target, position).await;
                    (index, probed_at_ms, report, cached)
                });
            }
        }
    }
    while let Some(joined) = dials.join_next().await {
        let (index, probed_at_ms, report, cached) =
            joined.map_err(|error| ApiError::internal("provider_link.test.probe", error))?;
        entries[index] = Some(probed_entry(
            &resolved.hops[index],
            &report,
            probed_at_ms,
            cached,
        ));
    }
    let entries: Vec<ProviderChainProbeDto> = entries.into_iter().flatten().collect();
    let head = entries.first();

    Ok(Json(ProviderLinkTestResponse {
        schema: TEST_SCHEMA,
        ok: head.is_some_and(|entry| entry.ok),
        reason: head.and_then(|entry| entry.reason.clone()),
        source: resolved.head.source.as_str().to_string(),
        mode: resolved.head.config.mode.as_str().to_string(),
        endpoint_label: resolved.head.config.endpoint_label(),
        checked_at_ms: chrono::Utc::now().timestamp_millis(),
        cascade_ok: entries.iter().any(|entry| entry.ok),
        entries,
    })
    .into_response())
}

/// The credential a hop would present. Chain hops and the env tier carry a
/// plain bearer; the stored head carries whatever its sealed envelope is, and
/// that kind — never the URL — picks the header. `None` for a legacy
/// `oauth-openai` head, which this route does not dial.
fn hop_credential(hop: &CascadeHop, head: Option<&LinkCredential>) -> Option<ProbeCredential> {
    match head {
        Some(LinkCredential::AnthropicKey(key)) => Some(ProbeCredential::AnthropicKey(key.clone())),
        Some(LinkCredential::OpenAiOAuth(_)) => None,
        Some(LinkCredential::Bearer(_)) | None => Some(ProbeCredential::Bearer(hop.bearer.clone())),
    }
}

/// Reuse the link's last report inside [`PROBE_CACHE_TTL`], else dial once.
async fn probe_through_cache(
    state: &ProviderProbeState,
    target: &ProbeTarget,
    position: i32,
) -> (i64, ProbeReport, bool) {
    let cache_key = target.cache_key(position);
    if let Some((probed_at_ms, report)) = state.cache.get(&cache_key) {
        return (probed_at_ms, report, true);
    }
    let report = state.probe.probe(target).await;
    let probed_at_ms = chrono::Utc::now().timestamp_millis();
    tracing::info!(
        position,
        endpoint = %redacted_endpoint_label(&target.base_url),
        outcome = report.outcome.as_str(),
        status = report.http_status,
        "provider link probe"
    );
    state.cache.put(cache_key, probed_at_ms, report.clone());
    (probed_at_ms, report, false)
}

fn disposition_for(reason: Option<&str>) -> &'static str {
    match reason {
        None => "ok",
        Some(reason) => {
            if classify_probe_reason(Some(reason)).is_fall_over() {
                "fall_over"
            } else {
                "propagate"
            }
        }
    }
}

/// The hops this server does not dial, decided as Swift's `probeHop` did
/// without a socket. `None` means "dial it".
fn configuration_verdict(
    hop: &CascadeHop,
    credential: Option<&ProbeCredential>,
) -> Option<ProviderChainProbeDto> {
    let (reason, disposition) = if !hop.enabled {
        // A parked hop is never attempted, so it can neither serve nor fall
        // over — it is simply skipped.
        ("hop_disabled", "skipped")
    } else if hop.mode != ProviderMode::ExternalHermes {
        // Mock modes have no real provider to reach.
        ("not_external_provider", "propagate")
    } else if !hop.is_usable() {
        ("provider_not_configured", "propagate")
    } else if credential.is_none() {
        // Legacy oauth-openai head: see the module docs.
        (PROBE_NOT_RUN, disposition_for(Some(PROBE_NOT_RUN)))
    } else {
        return None;
    };
    Some(ProviderChainProbeDto {
        position: hop.position,
        source: hop.source.as_str().to_string(),
        mode: hop.mode.as_str().to_string(),
        endpoint_label: hop.endpoint_label(),
        enabled: hop.enabled,
        ok: false,
        reason: Some(reason.to_string()),
        disposition: disposition.to_string(),
        probe: None,
    })
}

/// A dialled hop's row: the verdict plus the provider-stated numbers.
fn probed_entry(
    hop: &CascadeHop,
    report: &ProbeReport,
    probed_at_ms: i64,
    cached: bool,
) -> ProviderChainProbeDto {
    ProviderChainProbeDto {
        position: hop.position,
        source: hop.source.as_str().to_string(),
        mode: hop.mode.as_str().to_string(),
        endpoint_label: hop.endpoint_label(),
        enabled: hop.enabled,
        ok: report.reason.is_none(),
        reason: report.reason.clone(),
        disposition: disposition_for(report.reason.as_deref()).to_string(),
        probe: Some(ProviderProbeDetailDto {
            outcome: report.outcome.as_str(),
            method: report.method.as_str(),
            http_status: report.http_status,
            latency_ms: report.latency_ms,
            model_count: report.model_count,
            model_ids: report.model_ids.clone(),
            model_ids_truncated: report.model_ids_truncated,
            rate_limit: report
                .rate_limit
                .as_ref()
                .map(|limits| ProviderRateLimitDto {
                    source: limits.source,
                    requests_limit: limits.requests_limit,
                    requests_remaining: limits.requests_remaining,
                    tokens_limit: limits.tokens_limit,
                    tokens_remaining: limits.tokens_remaining,
                }),
            retry_after_seconds: report.retry_after_seconds,
            credit: report.credit.as_ref().map(|credit| ProviderKeyCreditDto {
                limit: credit.limit,
                limit_remaining: credit.limit_remaining,
                usage: credit.usage,
            }),
            probed_at_ms,
            cached,
        }),
    }
}

// ---------------------------------------------------------------------------
// GET / PUT / DELETE /v1/provider/link/chain
// ---------------------------------------------------------------------------

pub async fn get_chain(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<ProviderChainResponse>, ApiError> {
    require_instance_operator(&state, &principal).await?;
    let key = master_key(&state)?.to_string();

    let (stored_link, stored_chain) =
        with_provider_link_admin_tx(&state.pool, principal.workspace_id, move |conn| {
            Box::pin(async move {
                let link = read_link(conn).await?;
                let chain = read_chain(conn).await?;
                Ok((link, chain))
            })
        })
        .await
        .map_err(|error| ApiError::internal("provider_chain.get", error))?;

    Ok(Json(chain_response(
        &state,
        &key,
        stored_link.as_ref(),
        &stored_chain,
    )))
}

pub async fn put_chain(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<PutProviderChainRequest>,
) -> Result<Json<ProviderChainResponse>, ApiError> {
    require_instance_operator(&state, &principal).await?;
    let key = master_key(&state)?.to_string();
    let inputs = validated_chain_entries(
        &state.settings.environment,
        state.settings.env_provider.allow_local_loopback,
        &request,
    )?;

    // Seal every supplied bearer BEFORE the transaction opens. Two reasons: the
    // plaintext's lifetime stays as short as possible, and a crypto failure can
    // then be an ordinary 500 instead of something the transaction closure has to
    // smuggle out through its own error type.
    let mut sealed: Vec<SealedChainEntry> = Vec::with_capacity(inputs.len());
    for input in &inputs {
        let ciphertext = match input.bearer.as_deref() {
            None => None,
            Some(bearer) => Some(
                seal_bearer(bearer, &key)
                    .map_err(|error| ApiError::internal("provider_chain.seal", error))?,
            ),
        };
        sealed.push((
            input.position,
            input.base_url.clone(),
            ciphertext,
            input.mode.as_str().to_string(),
            input.enabled,
        ));
    }

    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let (stored_link, stored_chain) =
        with_provider_link_admin_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // Existing ciphertexts keyed by POSITION, so an operator can
                // park a hop or edit its path without re-typing its write-only
                // bearer — but only while the hop stays on the ORIGIN the key
                // was typed for (#3040). Anything else would let one operator
                // point another operator's key at a host of their choosing and
                // have 「연결 확인」 (or a later turn) deliver it there.
                let existing = read_chain(conn).await?;
                let mut rows: Vec<(i32, String, Vec<u8>, String, bool)> =
                    Vec::with_capacity(sealed.len());
                let mut origin_changes: Vec<serde_json::Value> = Vec::new();
                for (position, base_url, ciphertext, mode, enabled) in sealed {
                    let stored = existing.iter().find(|row| row.position == position);
                    let ciphertext = match (ciphertext, stored) {
                        (Some(fresh), stored) => {
                            if let Some(stored) =
                                stored.filter(|row| !same_origin(&row.base_url, &base_url))
                            {
                                origin_changes.push(serde_json::json!({
                                    "position": position,
                                    "from": redacted_endpoint_label(&stored.base_url),
                                    "to": redacted_endpoint_label(&base_url),
                                }));
                            }
                            fresh
                        }
                        (None, Some(stored)) if same_origin(&stored.base_url, &base_url) => {
                            stored.bearer_ciphertext.clone()
                        }
                        // Both rejections return before the first write, so the
                        // transaction commits nothing either way.
                        (None, Some(stored)) => {
                            return Ok(Err(ChainKeyRefusal::OriginChanged {
                                position,
                                from: redacted_endpoint_label(&stored.base_url),
                                to: redacted_endpoint_label(&base_url),
                            }))
                        }
                        (None, None) => return Ok(Err(ChainKeyRefusal::NewPosition(position))),
                    };
                    rows.push((position, base_url, ciphertext, mode, enabled));
                }

                let saved = replace_chain(conn, &rows, member_id).await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "provider_link_chain.updated")
                        .by(member_id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.provider_link_chain.audit.v1",
                            serde_json::json!({
                                "positions": saved.iter().map(|row| row.position).collect::<Vec<_>>(),
                                // Endpoint labels only — never a base_url query or
                                // userinfo, never a bearer.
                                "endpoint_labels": saved
                                    .iter()
                                    .map(|row| redacted_endpoint_label(&row.base_url))
                                    .collect::<Vec<_>>(),
                                // #3040: hops whose origin moved, which is only
                                // possible with a freshly typed key. Labels only.
                                "origin_changed": origin_changes,
                            }),
                        ),
                )
                .await?;
                let link = read_link(conn).await?;
                Ok(Ok((link, saved)))
            })
        })
        .await
        .map_err(|error| ApiError::internal("provider_chain.put", error))?
        .map_err(ChainKeyRefusal::into_api_error)?;

    Ok(Json(chain_response(
        &state,
        &key,
        stored_link.as_ref(),
        &stored_chain,
    )))
}

pub async fn delete_chain(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<ProviderChainResponse>, ApiError> {
    require_instance_operator(&state, &principal).await?;
    let key = master_key(&state)?.to_string();

    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let stored_link = with_provider_link_admin_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let removed = delete_all_chain_entries(conn).await?;
            if removed > 0 {
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "provider_link_chain.cleared")
                        .by(member_id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.provider_link_chain.audit.v1",
                            serde_json::json!({"positions": [], "endpoint_labels": []}),
                        ),
                )
                .await?;
            }
            read_link(conn).await
        })
    })
    .await
    .map_err(|error| ApiError::internal("provider_chain.delete", error))?;

    // After the clear the cascade is position 0 alone.
    Ok(Json(chain_response(
        &state,
        &key,
        stored_link.as_ref(),
        &[],
    )))
}

/// The machine code of the #3040 refusal (ADR-0188 R0 `error.code`).
pub const KEY_REQUIRED_FOR_NEW_ORIGIN: &str = "key_required_for_new_origin";

/// Why a hop submitted without a bearer cannot keep one.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ChainKeyRefusal {
    /// Nothing is stored at this position (400, the pre-#3040 sentence the web
    /// draft model already knows).
    NewPosition(i32),
    /// A key is stored here, but for another origin (409, #3040). The labels
    /// are the redacted endpoint projections — never a key, query or userinfo.
    OriginChanged {
        position: i32,
        from: String,
        to: String,
    },
}

impl ChainKeyRefusal {
    fn into_api_error(self) -> ApiError {
        match self {
            ChainKeyRefusal::NewPosition(position) => ApiError::bad_request(format!(
                "bearer is required for new chain position {position}"
            )),
            ChainKeyRefusal::OriginChanged { position, from, to } => ApiError::coded(
                StatusCode::CONFLICT,
                KEY_REQUIRED_FOR_NEW_ORIGIN,
                format!(
                    "chain position {position} moved from {from} to {to}; the stored key is \
                     not sent to a new origin — enter the key for the new provider"
                ),
            ),
        }
    }
}

/// One replace-all hop with its bearer already sealed. `None` ciphertext means
/// "keep whatever is stored at this position" and is resolved inside the
/// transaction, where the stored rows are visible.
type SealedChainEntry = (i32, String, Option<Vec<u8>>, String, bool);

/// Pure validation of the replace-all body (Swift `validatedChainEntries`
/// :241-293).
///
/// It takes the two environment facts rather than the whole state so the rule is
/// unit-testable without booting an app or a pool.
fn validated_chain_entries(
    environment: &str,
    allow_local_loopback: bool,
    request: &PutProviderChainRequest,
) -> Result<Vec<ChainEntryInput>, ApiError> {
    if request.entries.len() > MAX_CHAIN_ENTRIES {
        return Err(ApiError::bad_request(format!(
            "chain may hold at most {MAX_CHAIN_ENTRIES} fallback entries"
        )));
    }
    let mut seen: Vec<i32> = Vec::with_capacity(request.entries.len());
    let mut result = Vec::with_capacity(request.entries.len());
    for entry in &request.entries {
        // Position 0 is the legacy singleton, edited through PUT /v1/provider/link
        // and nowhere else. Accepting it here would create two stores for one hop
        // and let this endpoint overwrite the 583-gated singleton.
        if entry.position < 1 {
            return Err(ApiError::bad_request(
                "position must be >= 1 (position 0 is the provider link singleton)",
            ));
        }
        if seen.contains(&entry.position) {
            return Err(ApiError::bad_request(format!(
                "duplicate chain position {}",
                entry.position
            )));
        }
        seen.push(entry.position);

        let base_url = validated_base_url(&entry.base_url, environment, allow_local_loopback)
            .map_err(|error| ApiError::bad_request(error.to_string()))?;

        let bearer = match entry.bearer.as_deref().map(str::trim) {
            None => None,
            Some("") => {
                return Err(ApiError::bad_request(format!(
                    "bearer must not be empty at position {}",
                    entry.position
                )))
            }
            Some(bearer) => Some(bearer.to_string()),
        };

        result.push(ChainEntryInput {
            position: entry.position,
            base_url,
            bearer,
            mode: resolved_mode(entry.mode.as_deref())?,
            enabled: entry.enabled.unwrap_or(true),
        });
    }
    result.sort_by_key(|entry| entry.position);
    Ok(result)
}

#[cfg(test)]
mod tests {

    /// #2911 (ADR-0147 증보 2026-09-27): no new `auth.json` (oauth-openai)
    /// link can be created — not from onboarding, not from settings, not by a
    /// hand-written PUT. The refusal names the reason and echoes no token.
    #[test]
    fn a_new_oauth_link_is_refused() {
        let request = |format: Option<&str>| crate::dto::PutProviderLinkRequest {
            base_url: "https://chatgpt.com/backend-api/codex".into(),
            bearer: None,
            mode: None,
            oauth: Some(crate::dto::PutProviderOAuthRequest {
                refresh_token: "rt-secret-2911".into(),
                access_token: Some("at-secret-2911".into()),
                expires_at_ms: Some(1),
                account_id: Some("acct".into()),
                account_label: Some("me@example.com".into()),
                client_id: None,
                token_endpoint: None,
            }),
            format: format.map(str::to_string),
        };
        for format in [None, Some("openai")] {
            let error = requested_credential(&request(format))
                .expect_err("a new oauth-openai link must be refused");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
            let text = format!("{error:?}");
            assert!(text.contains("auth.json"), "{text}");
            assert!(!text.contains("secret-2911"), "token echoed: {text}");
        }
        // The anthropic refusal keeps its own, more specific sentence.
        let error =
            requested_credential(&request(Some("anthropic"))).expect_err("anthropic + oauth");
        assert!(format!("{error:?}").contains("format anthropic takes an API key"));
    }

    /// Review N4: an envelope-shaped bearer is refused instead of being
    /// re-read as another credential kind on decrypt.
    #[test]
    fn an_envelope_shaped_bearer_is_refused() {
        let request = |bearer: &str, format: Option<&str>| crate::dto::PutProviderLinkRequest {
            base_url: "https://api.example.com/v1".into(),
            bearer: Some(bearer.into()),
            mode: None,
            oauth: None,
            format: format.map(str::to_string),
        };
        for format in [None, Some("anthropic")] {
            for bearer in [
                r#"{"kind":"anthropic-key","api_key":"sk-ant-x"}"#,
                r#"{"kind":"oauth-openai","refresh_token":"rt"}"#,
            ] {
                let error = requested_credential(&request(bearer, format)).expect_err(bearer);
                assert_eq!(error.status, StatusCode::BAD_REQUEST);
            }
        }
        // An ordinary key (even `{`-leading garbage that is no envelope) is fine.
        assert_eq!(
            requested_credential(&request("sk-live-abc", None))
                .unwrap()
                .kind_label(),
            "bearer"
        );
    }

    use super::*;
    use crate::dto::PutProviderChainEntry;

    fn validate(
        entries: Vec<PutProviderChainEntry>,
        environment: &str,
        allow_loopback: bool,
    ) -> Result<Vec<ChainEntryInput>, ApiError> {
        validated_chain_entries(
            environment,
            allow_loopback,
            &PutProviderChainRequest { entries },
        )
    }

    #[test]
    fn position_zero_is_refused_because_the_singleton_has_one_writer() {
        let error = validate(
            vec![PutProviderChainEntry {
                position: 0,
                base_url: "https://api.example.com/v1".into(),
                bearer: Some("sk-live-abcdefgh".into()),
                mode: None,
                enabled: None,
            }],
            "local",
            false,
        )
        .expect_err("position 0");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert!(error
            .message
            .contains("position 0 is the provider link singleton"));
    }

    #[test]
    fn duplicate_positions_and_an_oversized_chain_are_refused() {
        let entry = |position: i32| PutProviderChainEntry {
            position,
            base_url: "https://api.example.com/v1".into(),
            bearer: Some("sk-live-abcdefgh".into()),
            mode: None,
            enabled: None,
        };
        assert!(validate(vec![entry(1), entry(1)], "local", false)
            .expect_err("duplicate")
            .message
            .contains("duplicate chain position 1"));
        let too_many: Vec<_> = (1..=(MAX_CHAIN_ENTRIES as i32 + 1)).map(entry).collect();
        assert!(validate(too_many, "local", false)
            .expect_err("too many")
            .message
            .contains("at most 8"));
    }

    /// Absent bearer is legal (keep the stored one); an *empty* one is not —
    /// the operator cleared the field and meant something by it.
    #[test]
    fn an_absent_bearer_is_legal_and_an_empty_one_is_not() {
        let kept = validate(
            vec![PutProviderChainEntry {
                position: 1,
                base_url: "https://api.example.com/v1".into(),
                bearer: None,
                mode: None,
                enabled: None,
            }],
            "local",
            false,
        )
        .expect("absent bearer keeps the stored ciphertext");
        assert_eq!(kept[0].bearer, None);
        assert!(kept[0].enabled, "enabled defaults to true");
        assert_eq!(
            kept[0].mode,
            ProviderMode::ExternalHermes,
            "configuring a hop is choosing the external boundary"
        );

        assert!(validate(
            vec![PutProviderChainEntry {
                position: 1,
                base_url: "https://api.example.com/v1".into(),
                bearer: Some("   ".into()),
                mode: None,
                enabled: None,
            }],
            "local",
            false,
        )
        .expect_err("empty bearer")
        .message
        .contains("bearer must not be empty at position 1"));
    }

    #[test]
    fn entries_are_stored_in_ascending_position_order() {
        let entry = |position: i32| PutProviderChainEntry {
            position,
            base_url: format!("https://hop{position}.example.com/v1"),
            bearer: Some("sk-live-abcdefgh".into()),
            mode: None,
            enabled: None,
        };
        let sorted = validate(vec![entry(3), entry(1), entry(2)], "local", false).expect("valid");
        assert_eq!(
            sorted
                .iter()
                .map(|entry| entry.position)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
    }

    /// Everything that needs no socket is decided here; a usable external hop
    /// is handed to the dialler (`None`), and only a legacy OAuth head is still
    /// reported as not run.
    #[test]
    fn configuration_verdicts_decide_what_is_not_dialled() {
        let hop = |mode: ProviderMode, bearer: &str, enabled: bool| CascadeHop {
            position: 1,
            source: CascadeSource::Chain,
            base_url: "https://api.example.com/v1".into(),
            bearer: bearer.into(),
            mode,
            enabled,
        };
        let bearer = |value: &str| Some(ProbeCredential::Bearer(value.into()));

        let parked_hop = hop(ProviderMode::ExternalHermes, "sk-live-abcdefgh", false);
        let parked = configuration_verdict(&parked_hop, bearer("sk-live-abcdefgh").as_ref())
            .expect("parked hops are decided");
        assert_eq!(parked.disposition, "skipped");
        assert_eq!(parked.reason.as_deref(), Some("hop_disabled"));

        let mock_hop = hop(ProviderMode::LocalMock, "sk-live-abcdefgh", true);
        let mock = configuration_verdict(&mock_hop, bearer("x").as_ref()).expect("decided");
        assert_eq!(mock.reason.as_deref(), Some("not_external_provider"));
        assert_eq!(mock.disposition, "propagate");

        let blank_hop = hop(ProviderMode::ExternalHermes, "  ", true);
        let blank = configuration_verdict(&blank_hop, bearer("  ").as_ref()).expect("decided");
        assert_eq!(blank.reason.as_deref(), Some("provider_not_configured"));

        let live = hop(ProviderMode::ExternalHermes, "sk-live-abcdefgh", true);
        assert!(
            configuration_verdict(&live, bearer("sk-live-abcdefgh").as_ref()).is_none(),
            "a usable external hop must be dialled, not labelled probe_not_run"
        );

        let oauth = configuration_verdict(&live, None).expect("legacy OAuth head is not dialled");
        assert_eq!(oauth.reason.as_deref(), Some("probe_not_run"));
        assert_eq!(
            oauth.disposition, "propagate",
            "an unknown reason must not claim the next provider would do better"
        );
    }

    /// #3040: the two refusals of a bearer-less hop keep their own status and
    /// sentence; only the origin move carries the machine code.
    #[test]
    fn a_bearerless_hop_refusal_names_its_reason() {
        let new = ChainKeyRefusal::NewPosition(3).into_api_error();
        assert_eq!(new.status, StatusCode::BAD_REQUEST);
        assert_eq!(new.code, None);
        assert_eq!(new.message, "bearer is required for new chain position 3");

        let moved = ChainKeyRefusal::OriginChanged {
            position: 1,
            from: "https://api.example.com/v1".into(),
            to: "https://evil.example.com/v1".into(),
        }
        .into_api_error();
        assert_eq!(moved.status, StatusCode::CONFLICT);
        assert_eq!(moved.code, Some(KEY_REQUIRED_FOR_NEW_ORIGIN));
        assert!(
            moved.message.contains("chain position 1"),
            "{}",
            moved.message
        );
    }

    #[test]
    fn dispositions_follow_the_cascade_table() {
        assert_eq!(disposition_for(None), "ok");
        assert_eq!(disposition_for(Some("provider_unreachable")), "fall_over");
        assert_eq!(disposition_for(Some("provider_rate_limited")), "fall_over");
        assert_eq!(disposition_for(Some("provider_status_503")), "fall_over");
        assert_eq!(disposition_for(Some("provider_auth_failed")), "propagate");
        assert_eq!(disposition_for(Some("provider_egress_denied")), "propagate");
        assert_eq!(
            disposition_for(Some("provider_invalid_response")),
            "propagate"
        );
    }
}
