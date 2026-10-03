//! Personal API keys — the organisation's BYOK issued to one person
//! (#3396, ADR-0147 증보 2026-10-03, 성재 결재 2026-10-03).
//!
//! ```text
//! POST /v1/workspaces/{ws}/personal-keys                 issue (workspace admin)
//! GET  /v1/workspaces/{ws}/personal-keys                 list all (workspace admin)
//! GET  /v1/workspaces/{ws}/personal-keys/mine            list own (any active member)
//! POST /v1/workspaces/{ws}/personal-keys/{key}/revoke    revoke (admin or the key's owner)
//! POST /v1/workspaces/{ws}/personal-keys/{key}/agent     create the owner's personal agent
//! ```
//!
//! ## Rules this module is the door for
//!
//! 1. **Operator-issued only.** v1 has no path by which a member adds their own
//!    key; the issuer is a workspace admin and the holder a human member of the
//!    same workspace. (A "members may add their own" policy is a later,
//!    separately-decided switch; it is deliberately not implied by the
//!    endpoint shape.)
//! 2. **The key is write-only.** It arrives once in `apiKey`, is sealed with the
//!    same AES-GCM master key as the team link and is never read back by any
//!    route: responses carry the endpoint label, format, label, owner and
//!    timestamps. Audit rows carry the same and never the key.
//! 3. **One key, one member.** A keyed fingerprint (unique among active rows)
//!    makes issuing the same key twice a 409 — to the same member, to another
//!    member, or in another workspace — and the table allows one active key per
//!    member. Replacing a key is revoke, then issue.
//! 4. **The endpoint is checked like the team link's** (`validated_base_url`:
//!    scheme, no userinfo/query, loopback only when the operator allowed it; the
//!    connect-time SSRF guard in `momo-egress` applies to every call). There is
//!    no update route, so a stored key never follows an edited URL to a new
//!    origin.
//! 5. **Revoke stops use on the next turn.** The worker reads the key per turn;
//!    nothing is cached.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_agent::{
    create_agent_identity_in_tx, mark_agent_owner_key_in_tx, normalized_model,
    normalized_system_prompt, AgentCreation, ModelSource, NewAgentMember,
};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::{active_workspace_role, WorkspaceRole};
use momo_settings::{
    find_personal_link_in_tx, holder_has_personal_agent_in_tx, is_handle_banned_in_tx,
    issue_personal_link_in_tx, key_fingerprint, last_revoked_base_url_in_tx,
    list_personal_links_in_tx, normalized_join_display_name, normalized_requested_handle,
    redacted_endpoint_label, revoke_personal_link_in_tx, seal_bearer, url_host, validated_base_url,
    EgressPolicy, IssueOutcome, LinkCredential, NewPersonalLink, PersonalLinkInfo, ProviderFormat,
    RevokeOutcome, PERSONAL_LINK_AUDIT_SCHEMA, PERSONAL_LINK_ISSUED_ACTION,
    PERSONAL_LINK_REVOKED_ACTION,
};
use serde_json::json;

use crate::dto::{
    AgentMemberDto, CreateAgentResponse, CreatePersonalKeyAgentRequest, IssuePersonalKeyRequest,
    PersonalKeyDto, PersonalKeyListResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
};
use crate::AppState;

const MAX_API_KEY_CHARS: usize = 512;
const MIN_API_KEY_CHARS: usize = 8;

fn master_key(state: &AppState) -> Result<&str, ApiError> {
    state
        .settings
        .provider_link_master_key
        .as_deref()
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "이 서버에는 PROVIDER_LINK_MASTER_KEY가 설정되어 있지 않아 개인 API 키를 \
                 저장하거나 읽을 수 없습니다. 인스턴스 운영자에게 문의하세요.",
            )
        })
}

fn dto(info: &PersonalLinkInfo) -> PersonalKeyDto {
    PersonalKeyDto {
        id: info.id.to_string(),
        owner_member_id: info.owner_member_id.to_string(),
        format: info.format.clone(),
        endpoint_label: redacted_endpoint_label(&info.base_url),
        label: info.label.clone(),
        status: if info.revoked_at_ms.is_some() {
            "revoked"
        } else {
            "active"
        },
        issued_by: info.issued_by.map(|id| id.to_string()),
        issued_at_ms: info.issued_at_ms,
        revoked_at_ms: info.revoked_at_ms,
    }
}

/// What the audit rows say about a key: ids, format, endpoint label, and
/// whether a label exists. Never the key, never its fingerprint.
fn audit_detail(info: &PersonalLinkInfo) -> serde_json::Value {
    json!({
        "link_id": info.id.to_string(),
        "owner_member_id": info.owner_member_id.to_string(),
        "format": info.format,
        "endpoint_label": redacted_endpoint_label(&info.base_url),
        "has_label": info.label.is_some(),
    })
}

/// The key as the body carries it: one plain API key, nothing else.
fn requested_key(raw: &str, format: ProviderFormat) -> Result<LinkCredential, ApiError> {
    let key = raw.trim();
    if key.chars().count() < MIN_API_KEY_CHARS || key.chars().count() > MAX_API_KEY_CHARS {
        return Err(ApiError::bad_request("apiKey must be 8...512 characters"));
    }
    // Printable ASCII only: a zero-width or look-alike character would make
    // two spellings of one key fingerprint differently (one key, one member).
    if !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err(ApiError::bad_request(
            "apiKey must be printable ASCII without whitespace",
        ));
    }
    // A key that is itself a sealed-envelope document would be re-read as
    // another credential kind on decrypt (the team link's review N4).
    if LinkCredential::parse(key).kind_label() != "bearer" {
        return Err(ApiError::bad_request(
            "apiKey must be an API key, not a credential envelope",
        ));
    }
    Ok(match format {
        ProviderFormat::Openai => LinkCredential::Bearer(key.to_string()),
        ProviderFormat::Anthropic => LinkCredential::AnthropicKey(key.to_string()),
    })
}

fn requested_label(raw: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if raw.chars().count() > 80 || raw.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "label must be at most 80 characters without control characters",
        ));
    }
    Ok(Some(raw.to_string()))
}

/// `POST /v1/workspaces/{ws}/personal-keys`.
pub async fn issue(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<IssuePersonalKeyRequest>,
) -> Result<(StatusCode, Json<PersonalKeyDto>), ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let master = master_key(&state)?.to_string();

    let format = ProviderFormat::from_label(request.format.as_deref())
        .ok_or_else(|| ApiError::bad_request("format must be one of openai, anthropic"))?;
    let credential = requested_key(&request.api_key, format)?;
    let base_url = validated_base_url(
        &request.base_url,
        &state.settings.environment,
        state.settings.env_provider.allow_local_loopback,
    )
    .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    // The operator's own provider host and the local-host opt-ins are exempt from
    // the connect-time address check (the operator wrote them). A workspace
    // admin must not be able to aim a person's key at them (SSRF into the
    // operator's network): those hosts are not available to personal keys.
    let reserved = EgressPolicy::from_env(state.settings.env_provider.allow_local_loopback)
        .with_operator_base_url(&state.settings.env_provider.base_url);
    if url_host(&base_url).is_none_or(|host| reserved.host_exempt(&host)) {
        return Err(ApiError::bad_request(
            "baseUrl points at a host reserved for the server operator; a personal key needs a public provider host",
        ));
    }
    let label = requested_label(request.label.as_deref())?;
    let fingerprint = key_fingerprint(credential.presentable_bearer(), &master);
    let ciphertext = seal_bearer(&credential.to_sealed_plaintext(), &master)
        .map_err(|error| ApiError::internal("personal_link.seal", error))?;

    let actor = principal.member_id;
    let owner = request.owner_member_id;
    let via_token = audit_via_token_id(&principal);

    let issued = settle_db(
        "personal_link.issue",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let role = active_workspace_role(conn, workspace_id, actor).await?;
                if !role.is_some_and(|role| role.is_admin()) {
                    return Ok(Err(ApiError::forbidden("workspace admin required")));
                }
                let previous_base_url =
                    last_revoked_base_url_in_tx(conn, workspace_id, owner).await?;
                let outcome = issue_personal_link_in_tx(
                    conn,
                    workspace_id,
                    &NewPersonalLink {
                        owner_member_id: owner,
                        format,
                        base_url: &base_url,
                        bearer_ciphertext: &ciphertext,
                        key_fingerprint: &fingerprint,
                        label: label.as_deref(),
                        issued_by: actor,
                    },
                )
                .await?;
                let info = match outcome {
                    IssueOutcome::Issued(info) => info,
                    IssueOutcome::OwnerNotHuman => {
                        return Ok(Err(ApiError::bad_request(
                            "ownerMemberId must reference an active human in this workspace",
                        )))
                    }
                    IssueOutcome::OwnerHasActiveKey => {
                        return Ok(Err(ApiError::coded(
                            StatusCode::CONFLICT,
                            "personal_key_owner_has_active_key",
                            "this member already has an active personal key; revoke it first",
                        )))
                    }
                    IssueOutcome::KeyAlreadyAttached => return Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        "personal_key_already_attached",
                        "this key is already attached to a member; one key belongs to one member",
                    ))),
                };
                let mut detail = audit_detail(&info);
                // The holder's agent carries over to this key: if it now points
                // at a different origin, the trail says from where to where.
                if let Some(previous) = previous_base_url
                    .filter(|previous| !momo_settings::same_origin(previous, &info.base_url))
                {
                    detail["origin_changed_from"] = json!(redacted_endpoint_label(&previous));
                }
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, PERSONAL_LINK_ISSUED_ACTION)
                        .by(actor)
                        .about(owner)
                        .target("personal_provider_link", info.id)
                        .via_token(via_token)
                        .with_schema(PERSONAL_LINK_AUDIT_SCHEMA, detail),
                )
                .await?;
                Ok(Ok(info))
            })
        })
        .await,
    )?;
    Ok((StatusCode::CREATED, Json(dto(&issued))))
}

/// `GET /v1/workspaces/{ws}/personal-keys` — every key of the workspace.
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<PersonalKeyListResponse>, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let actor = principal.member_id;
    let keys = settle_db(
        "personal_link.list",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let role = active_workspace_role(conn, workspace_id, actor).await?;
                if !role.is_some_and(|role| role.is_admin()) {
                    return Ok(Err(ApiError::forbidden("workspace admin required")));
                }
                Ok(Ok(
                    list_personal_links_in_tx(conn, workspace_id, None).await?
                ))
            })
        })
        .await,
    )?;
    Ok(Json(PersonalKeyListResponse {
        keys: keys.iter().map(dto).collect(),
    }))
}

/// `GET /v1/workspaces/{ws}/personal-keys/mine` — the caller's own keys, and
/// only those: the owner filter is the caller's own member id, not a parameter.
pub async fn list_mine(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Json<PersonalKeyListResponse>, ApiError> {
    require_human(&principal, "human member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let actor = principal.member_id;
    let keys = settle_db(
        "personal_link.list_mine",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, actor)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("active workspace member required")));
                }
                Ok(Ok(list_personal_links_in_tx(
                    conn,
                    workspace_id,
                    Some(actor),
                )
                .await?))
            })
        })
        .await,
    )?;
    Ok(Json(PersonalKeyListResponse {
        keys: keys.iter().map(dto).collect(),
    }))
}

/// `POST /v1/workspaces/{ws}/personal-keys/{key}/revoke`. Idempotent: a key
/// that is already revoked answers 200 with its revoked state and writes no
/// second audit row.
pub async fn revoke(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, key)): Path<(String, String)>,
) -> Result<Json<PersonalKeyDto>, ApiError> {
    require_human(&principal, "human member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let link_id = path_uuid(&key, "invalid personal key id")?;
    let actor = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let revoked = settle_db(
        "personal_link.revoke",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(existing) = find_personal_link_in_tx(conn, workspace_id, link_id).await?
                else {
                    return Ok(Err(ApiError::not_found("personal key not found")));
                };
                // Admin, or the holder revoking their own key. A member who is
                // neither learns nothing about whether the key exists.
                let role = active_workspace_role(conn, workspace_id, actor).await?;
                let is_admin = role.is_some_and(|role| role.is_admin());
                if !(is_admin || (role.is_some() && existing.owner_member_id == actor)) {
                    return Ok(Err(ApiError::not_found("personal key not found")));
                }
                match revoke_personal_link_in_tx(conn, workspace_id, link_id, actor).await? {
                    RevokeOutcome::NotFound => {
                        Ok(Err(ApiError::not_found("personal key not found")))
                    }
                    RevokeOutcome::AlreadyRevoked(info) => Ok(Ok(info)),
                    RevokeOutcome::Revoked(info) => {
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, PERSONAL_LINK_REVOKED_ACTION)
                                .by(actor)
                                .about(info.owner_member_id)
                                .target("personal_provider_link", info.id)
                                .via_token(via_token)
                                .with_schema(PERSONAL_LINK_AUDIT_SCHEMA, audit_detail(&info)),
                        )
                        .await?;
                        Ok(Ok(info))
                    }
                }
            })
        })
        .await,
    )?;
    Ok(Json(dto(&revoked)))
}

/// `POST /v1/workspaces/{ws}/personal-keys/{key}/agent` — create the agent that
/// speaks on this key. It is the key holder's alone (`owner_only`), its brain is
/// their key (`uses_owner_key`), and it follows its own model, never the team's
/// 「기본 AI」. Callable by the key's holder or a workspace admin; the agent's
/// owner is always the key's holder.
pub async fn create_agent(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, key)): Path<(String, String)>,
    Json(request): Json<CreatePersonalKeyAgentRequest>,
) -> Result<(StatusCode, Json<CreateAgentResponse>), ApiError> {
    require_human(&principal, "human member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let link_id = path_uuid(&key, "invalid personal key id")?;

    let display_name = normalized_join_display_name(&request.display_name)
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    let handle = normalized_requested_handle(Some(request.handle.as_str()))
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?
        .ok_or_else(|| ApiError::bad_request("handle is required"))?;
    let model = normalized_model(&request.model)
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    let system_prompt = normalized_system_prompt(request.system_prompt.as_deref())
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;

    let actor = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let agent = settle_db(
        "personal_link.create_agent",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(link) = find_personal_link_in_tx(conn, workspace_id, link_id).await?
                else {
                    return Ok(Err(ApiError::not_found("personal key not found")));
                };
                let role = active_workspace_role(conn, workspace_id, actor).await?;
                let is_admin = role.is_some_and(|role| role.is_admin());
                if !(is_admin || (role.is_some() && link.owner_member_id == actor)) {
                    return Ok(Err(ApiError::not_found("personal key not found")));
                }
                if link.revoked_at_ms.is_some() {
                    return Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        "personal_key_revoked",
                        "this personal key is revoked",
                    )));
                }
                // A guest cannot mint a workspace member, with or without a key.
                let holder_role = active_workspace_role(conn, workspace_id, link.owner_member_id).await?;
                if holder_role.is_none_or(|role| role == WorkspaceRole::Guest) {
                    return Ok(Err(ApiError::forbidden(
                        "the key's holder must be a non-guest member of this workspace",
                    )));
                }
                if holder_has_personal_agent_in_tx(conn, workspace_id, link.id, link.owner_member_id)
                    .await?
                {
                    return Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        "personal_agent_exists",
                        "this member already has a personal agent; it keeps working across key re-issues",
                    )));
                }
                if is_handle_banned_in_tx(conn, &handle).await? {
                    return Ok(Err(ApiError::forbidden(
                        "member is banned from this workspace",
                    )));
                }
                let input = NewAgentMember {
                    display_name,
                    handle,
                    model,
                    // The agent's own model: the team's 「기본 AI」 row must never
                    // reroute a personal agent (and the worker skips it anyway).
                    model_source: ModelSource::Agent,
                    base_url: link.base_url.clone(),
                    system_prompt,
                    config: json!({}),
                    owner_human_id: link.owner_member_id,
                };
                let created = create_agent_identity_in_tx(conn, workspace_id, &input).await?;
                let agent = match created {
                    AgentCreation::InvalidOwner => {
                        return Ok(Err(ApiError::bad_request(
                            "the key's holder is no longer an active human in this workspace",
                        )))
                    }
                    AgentCreation::DuplicateHandle => {
                        return Ok(Err(ApiError::new(
                            StatusCode::CONFLICT,
                            "agent handle already exists",
                        )))
                    }
                    AgentCreation::Created(agent) => agent,
                };
                if !mark_agent_owner_key_in_tx(conn, workspace_id, agent.id, link.owner_member_id)
                    .await?
                {
                    // Just created in this transaction: not matching is a bug,
                    // and an error rolls the half-made agent back.
                    return Err(momo_db::DbError::Sqlx(momo_db::sqlx::Error::RowNotFound));
                }
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "agent.created")
                        .by(actor)
                        .about(agent.id)
                        .target("agent", agent.id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.agent.created.v1",
                            json!({
                                "handle": agent.handle,
                                "model": input.model,
                                "model_source": input.model_source.as_str(),
                                "owner_human_id": input.owner_human_id.to_string(),
                                "brain": "owner_key",
                                "personal_link_id": link.id.to_string(),
                            }),
                        ),
                )
                .await?;
                Ok(Ok(agent))
            })
        })
        .await,
    )?;
    Ok((
        StatusCode::CREATED,
        Json(CreateAgentResponse {
            agent: AgentMemberDto {
                id: agent.id.to_string(),
                handle: agent.handle,
                display_name: agent.display_name,
            },
        }),
    ))
}
