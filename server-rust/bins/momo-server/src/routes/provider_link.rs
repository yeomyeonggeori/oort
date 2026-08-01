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
//! ## The one surface this batch could not close: the live probe
//!
//! `POST /v1/provider/link/test` performs every check that does not need a
//! socket — operator authorization, cascade resolution, and the three
//! configuration verdicts Swift's `probeHop` reaches without calling anything
//! (`hop_disabled`, `not_external_provider`, `provider_not_configured`). For a
//! hop that is enabled, external, and usable, Swift issues a bounded
//! `GET {baseURL}/models`. **This server cannot**: `momo-server` deliberately
//! links no HTTP client (`bins/momo-server/Cargo.toml`, invariant #2 — "momo
//! never talks to Centrifugo; publishing belongs to momo-relay alone"), and
//! adding one is a boundary change that needs an ADR, not a worker's judgement.
//!
//! So such a hop is reported as `ok: false`, `reason: "probe_not_run"` — a label
//! that already exists in the client's vocabulary and already renders as
//! "확인이 끝나지 않았습니다" (`features/settings/chainModel.ts:probeReasonCopy`),
//! with the top-level message falling through to "연결을 확인하지 못했습니다"
//! (`model.ts:providerTestMessage`). That is the honest sentence: the check did
//! not run. It is deliberately **not** `provider_unreachable`, which would blame
//! a provider this server never dialled, and deliberately not `skipped`, which
//! the panel renders as "꺼둠" and would blame the operator for parking a hop
//! they left switched on.

use axum::extract::State;
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::with_provider_link_admin_tx;
use momo_settings::{
    attemptable_hops, cascade_plan, classify_probe_reason, decrypt_chain_entry, decrypt_link,
    delete_all_chain_entries, delete_link, masked_tail, read_chain, read_link,
    redacted_endpoint_label, replace_chain, requires_strict_external_provider, resolve_link,
    seal_bearer, upsert_link, validated_base_url, CascadeHop, CascadeSource, ChainEntryInput,
    DecryptedChainEntry, DecryptedProviderLink, LinkCredential, OpenAiOAuthCredential,
    ProviderMode, ProviderSource, ResolvedProvider, StoredChainEntry, StoredProviderLink,
    ATTRIBUTION_NOTICE_KO, MAX_CHAIN_ENTRIES,
};

use crate::dto::{
    ProviderChainEntryDto, ProviderChainProbeDto, ProviderChainResponse,
    ProviderLinkCredentialMeta, ProviderLinkResponse, ProviderLinkTestResponse,
    PutProviderChainRequest, PutProviderLinkRequest, PutProviderOAuthRequest,
};
use crate::error::ApiError;
use crate::routes::shared::{audit_via_token_id, require_instance_operator};
use crate::AppState;

const LINK_SCHEMA: &str = "momo.provider_link.v0";
const CHAIN_SCHEMA: &str = "momo.provider_link.chain.v0";
const TEST_SCHEMA: &str = "momo.provider_link.test.v0";

/// The reason label for a hop this server could not dial. See the module docs —
/// the label is the client's existing "확인이 끝나지 않았습니다", not a verdict
/// about the provider.
const PROBE_NOT_RUN: &str = "probe_not_run";

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
                "이 서버에는 PROVIDER_LINK_MASTER_KEY가 설정되어 있지 않아 AI 연결을 \
                 저장하거나 읽을 수 없습니다. 인스턴스 운영자에게 문의하세요.",
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

/// The credential a `PUT` body describes: exactly one of a bearer or a grant.
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
    match (bearer, request.oauth.as_ref()) {
        (Some(_), Some(_)) => Err(ApiError::bad_request(
            "send either bearer or oauth, not both — a link carries one credential",
        )),
        (None, None) => Err(ApiError::bad_request(
            "bearer must not be empty (or send an oauth grant instead)",
        )),
        (Some(bearer), None) => Ok(LinkCredential::Bearer(bearer.to_string())),
        (None, Some(oauth)) => Ok(oauth_credential(oauth)?),
    }
}

/// Build the sealed OAuth credential from a request body.
fn oauth_credential(request: &PutProviderOAuthRequest) -> Result<LinkCredential, ApiError> {
    let refresh_token = request.refresh_token.trim();
    if refresh_token.is_empty() {
        return Err(ApiError::bad_request(
            "oauth.refreshToken must not be empty",
        ));
    }
    let optional = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let mut credential = OpenAiOAuthCredential::from_refresh_token(refresh_token);
    credential.access_token = optional(&request.access_token);
    credential.expires_at_ms = request.expires_at_ms;
    credential.account_id = optional(&request.account_id);
    credential.account_label = optional(&request.account_label);
    credential.client_id = optional(&request.client_id);
    credential.token_endpoint = optional(&request.token_endpoint);
    Ok(LinkCredential::OpenAiOAuth(Box::new(credential)))
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
) -> Result<Json<ProviderLinkTestResponse>, ApiError> {
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
        .map_err(|error| ApiError::internal("provider_link.test", error))?;

    let resolved = resolve_cascade(&state, &key, stored_link.as_ref(), &stored_chain);
    let entries: Vec<ProviderChainProbeDto> = resolved.hops.iter().map(probe_hop).collect();
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
    }))
}

/// Classify one hop as far as this server honestly can (Swift `probeHop`
/// :202-237, minus the network call — see the module docs).
fn probe_hop(hop: &CascadeHop) -> ProviderChainProbeDto {
    let (ok, reason, disposition) = if !hop.enabled {
        // A parked hop is never attempted, so it can neither serve nor fall
        // over — it is simply skipped.
        (false, Some("hop_disabled"), "skipped")
    } else if hop.mode != ProviderMode::ExternalHermes {
        // Mock modes have no real provider to reach; the operator has to
        // configure a real base_url/bearer first.
        (false, Some("not_external_provider"), "propagate")
    } else if !hop.is_usable() {
        (false, Some("provider_not_configured"), "propagate")
    } else {
        // Enabled, external, and usable — the one case that needs a socket this
        // process does not have. Report that the check did not run and classify
        // it through the same table every other reason goes through.
        let decision = classify_probe_reason(Some(PROBE_NOT_RUN));
        (
            false,
            Some(PROBE_NOT_RUN),
            if decision.is_fall_over() {
                "fall_over"
            } else {
                "propagate"
            },
        )
    };

    ProviderChainProbeDto {
        position: hop.position,
        source: hop.source.as_str().to_string(),
        mode: hop.mode.as_str().to_string(),
        endpoint_label: hop.endpoint_label(),
        enabled: hop.enabled,
        ok,
        reason: reason.map(str::to_string),
        disposition: disposition.to_string(),
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
                // reorder or park a hop without re-typing its write-only bearer.
                let existing = read_chain(conn).await?;
                let mut rows: Vec<(i32, String, Vec<u8>, String, bool)> =
                    Vec::with_capacity(sealed.len());
                for (position, base_url, ciphertext, mode, enabled) in sealed {
                    let ciphertext = match ciphertext {
                        Some(fresh) => fresh,
                        None => match existing
                            .iter()
                            .find(|row| row.position == position)
                            .map(|row| row.bearer_ciphertext.clone())
                        {
                            Some(kept) => kept,
                            // A rejection, returned before the first write, so the
                            // transaction commits nothing either way.
                            None => return Ok(Err(position)),
                        },
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
        .map_err(|position| {
            ApiError::bad_request(format!(
                "bearer is required for new chain position {position}"
            ))
        })?;

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

    /// The honest half of the probe: everything that needs no socket is
    /// decided, and the one case that does says so by name.
    #[test]
    fn the_probe_reports_configuration_verdicts_and_names_the_check_it_could_not_run() {
        let hop = |mode: ProviderMode, bearer: &str, enabled: bool| CascadeHop {
            position: 1,
            source: CascadeSource::Chain,
            base_url: "https://api.example.com/v1".into(),
            bearer: bearer.into(),
            mode,
            enabled,
        };

        let parked = probe_hop(&hop(
            ProviderMode::ExternalHermes,
            "sk-live-abcdefgh",
            false,
        ));
        assert_eq!(parked.disposition, "skipped");
        assert_eq!(parked.reason.as_deref(), Some("hop_disabled"));

        let mock = probe_hop(&hop(ProviderMode::LocalMock, "sk-live-abcdefgh", true));
        assert_eq!(mock.reason.as_deref(), Some("not_external_provider"));
        assert_eq!(mock.disposition, "propagate");

        let blank = probe_hop(&hop(ProviderMode::ExternalHermes, "  ", true));
        assert_eq!(blank.reason.as_deref(), Some("provider_not_configured"));

        let unprobed = probe_hop(&hop(ProviderMode::ExternalHermes, "sk-live-abcdefgh", true));
        assert!(!unprobed.ok);
        assert_eq!(
            unprobed.reason.as_deref(),
            Some("probe_not_run"),
            "this server has no HTTP client (invariant #2); saying 'unreachable' \
             would blame a provider it never dialled"
        );
        assert_eq!(
            unprobed.disposition, "propagate",
            "an unknown reason must not claim the next provider would do better"
        );
    }
}
