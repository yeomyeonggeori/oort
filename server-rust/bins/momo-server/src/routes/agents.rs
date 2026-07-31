//! Agent creation + profile read — "에이전트 초대" (B5.2).
//!
//! ```text
//! POST /v1/workspaces/{ws}/agents                    (AgentRoutes.create)
//! GET  /v1/workspaces/{ws}/agents/{agent}/profile    (AgentProfileRoutes.get)
//! ```
//!
//! There is no bot to install in momo: inviting an agent is creating a `member`
//! with `kind='agent'` (invariant #5), which is why the created agent shows up in
//! `GET …/roster` beside the humans on the very next request and becomes
//! mentionable as soon as it is added to a channel.
//!
//! ## Three orderings this module is responsible for
//!
//! 1. **Human admin, checked before anything is written.** Swift requires a
//!    human principal *and* an owner/admin workspace role (:24-52). Creating an
//!    agent mints an identity that can post into channels, so it is not a
//!    member-level act.
//! 2. **Shape errors before the transaction opens** (MOMO-362): the base-URL
//!    gate, the credential-shaped-field walk and the profile validation are all
//!    pure, so a malformed body costs no connection and leaves no half-written
//!    member behind.
//! 3. **Handle ban, then insert.** `momo_settings::is_handle_banned_in_tx` is the
//!    single owner of `workspace_ban`; asking it here is what stops a banned
//!    handle from re-entering the workspace as an agent.
//!
//! ## Deliberately not served (see the PR body)
//!
//! `PUT …/profile`, `PUT …/pause` and `GET …/allowed-models` — B5.2 needs the
//! *creation* surface and the read a hub UI consumes; the editing surface is
//! B5.3's, and shipping a half of it now would mean shipping a model-picker
//! endpoint with no picker. No credential is issued either (Swift's create
//! deliberately stops at the identity boundary too).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_agent::{
    agent_owner_in_tx, allowed_agent_models, create_agent_identity_in_tx,
    load_agent_model_policy_in_tx, load_agent_profile_in_tx, normalized_model,
    normalized_system_prompt, upsert_agent_profile_in_tx, validate_agent_profile, validated_config,
    AgentCreation, AgentProfile, AgentProfileSpec, AgentSpecInvalid, NewAgentMember,
};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::active_workspace_role;
use momo_settings::{
    is_handle_banned_in_tx, normalized_join_display_name, normalized_requested_handle,
    validated_base_url,
};
use serde_json::json;

use crate::dto::{
    AgentMemberDto, AgentProfileDto, AgentProfileInput, AgentProfileResponse, CreateAgentRequest,
    CreateAgentResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
};
use crate::AppState;

fn spec_error(invalid: AgentSpecInvalid) -> ApiError {
    ApiError::bad_request(invalid.to_string())
}

fn profile_dto(profile: &AgentProfile) -> AgentProfileDto {
    AgentProfileDto {
        agent_member_id: profile.agent_member_id.to_string(),
        workspace_id: profile.workspace_id.to_string(),
        instructions: profile.instructions.clone(),
        model_pref: profile.model_pref.clone(),
        effort_pref: profile.effort_pref.clone(),
        enabled_tools: profile.enabled_tools.clone(),
        triggers: profile.triggers.clone(),
        paused: profile.paused,
        version: profile.version,
        updated_by: profile.updated_by.to_string(),
        updated_at_ms: profile.updated_at_ms,
    }
}

fn validated_profile(input: &AgentProfileInput) -> Result<AgentProfileSpec, ApiError> {
    validate_agent_profile(
        &input.instructions,
        input.model_pref.as_deref(),
        input.effort_pref.as_deref(),
        &input.enabled_tools,
        input.triggers.as_ref(),
    )
    .map_err(spec_error)
}

/// `POST /v1/workspaces/{ws}/agents`.
pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<CreateAgentRequest>,
) -> Result<(StatusCode, Json<CreateAgentResponse>), ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;

    // ---- pure validation, all of it, before a connection is taken ----
    let display_name = normalized_join_display_name(&request.display_name).map_err(|invalid| {
        // The join surface's own sentence; a second vocabulary for the same
        // rule would be a second contract for clients to learn.
        ApiError::bad_request(invalid.to_string())
    })?;
    let handle = normalized_requested_handle(Some(request.handle.as_str()))
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?
        .ok_or_else(|| ApiError::bad_request("handle is required"))?;
    let model = normalized_model(&request.model).map_err(spec_error)?;
    let base_url = validated_base_url(
        &request.base_url,
        &state.settings.environment,
        state.settings.env_provider.allow_local_loopback,
    )
    .map_err(|invalid| ApiError::bad_request(invalid.to_string()))?;
    let system_prompt =
        normalized_system_prompt(request.system_prompt.as_deref()).map_err(spec_error)?;
    let config = validated_config(request.config.as_ref()).map_err(spec_error)?;
    let profile = request
        .profile
        .as_ref()
        .map(validated_profile)
        .transpose()?;

    let actor_member_id = principal.member_id;
    let owner_human_id = request.owner_human_id.unwrap_or(actor_member_id);
    let via_token_id = audit_via_token_id(&principal);
    let input = NewAgentMember {
        display_name,
        handle,
        model,
        base_url,
        system_prompt,
        config,
        owner_human_id,
    };

    let agent = settle_db(
        "agents.create",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let role = active_workspace_role(conn, workspace_id, actor_member_id).await?;
                if !role.is_some_and(|role| role.is_admin()) {
                    return Ok(Err(ApiError::forbidden("workspace admin required")));
                }
                if is_handle_banned_in_tx(conn, &input.handle).await? {
                    return Ok(Err(ApiError::forbidden(
                        "member is banned from this workspace",
                    )));
                }

                let created = create_agent_identity_in_tx(conn, workspace_id, &input).await?;
                let agent = match created {
                    AgentCreation::InvalidOwner => {
                        return Ok(Err(ApiError::bad_request(
                            "ownerHumanId must reference an active human in this workspace",
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

                if let Some(profile) = profile.as_ref() {
                    // The allow-list gate is paid only when a preference is
                    // present, and it runs against the model this very
                    // transaction just stored — so a create can never leave a
                    // profile naming a model the workspace forbids.
                    if let Some(model_pref) = profile.model_pref.as_deref() {
                        let policy =
                            load_agent_model_policy_in_tx(conn, workspace_id, agent.id).await?;
                        let allowed = policy
                            .map(|(base, settings)| allowed_agent_models(&base, &settings))
                            .unwrap_or_default();
                        if !allowed.iter().any(|entry| entry == model_pref) {
                            return Ok(Err(spec_error(AgentSpecInvalid::ModelPrefNotAllowed)));
                        }
                    }
                    let stored = upsert_agent_profile_in_tx(
                        conn,
                        workspace_id,
                        agent.id,
                        actor_member_id,
                        profile,
                    )
                    .await?;
                    if let Some(stored) = stored {
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, "agent.profile.created")
                                .by(actor_member_id)
                                .about(agent.id)
                                .target("agent_profile", agent.id)
                                .via_token(via_token_id)
                                .with_schema(
                                    "momo.agent_profile.updated.v1",
                                    json!({
                                        "version": stored.version,
                                        "enabled_tool_count": stored.enabled_tools.len(),
                                        "has_model_pref": stored.model_pref.is_some(),
                                        "has_effort_pref": stored.effort_pref.is_some(),
                                        "mention_enabled": true,
                                    }),
                                ),
                        )
                        .await?;
                    }
                }

                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "agent.created")
                        .by(actor_member_id)
                        .about(agent.id)
                        .target("agent", agent.id)
                        .via_token(via_token_id)
                        .with_schema(
                            "momo.agent.created.v1",
                            json!({
                                "handle": agent.handle,
                                "model": input.model,
                                "endpoint_label": input.base_url,
                                "owner_human_id": input.owner_human_id.to_string(),
                                // Creation stops at the identity boundary: adding
                                // the agent to channels is a separate, explicit
                                // decision (Swift's header says so, and the count
                                // is recorded so an auditor sees it was zero).
                                "channel_memberships_created": 0,
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

/// `GET /v1/workspaces/{ws}/agents/{agent}/profile`.
///
/// Authorization is Swift's `requireEditor` (:369-406): a human that is the
/// agent's owner **or** a workspace owner/admin. Not every member — a profile
/// carries the instructions an operator wrote, and the roster already serves the
/// parts a teammate needs (name, handle, model).
pub async fn get_profile(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
) -> Result<Json<AgentProfileResponse>, ApiError> {
    require_human(&principal, "human agent owner or workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let agent_member_id = path_uuid(&agent, "invalid agent id")?;
    let actor_member_id = principal.member_id;

    let profile = settle_db(
        "agents.get_profile",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(role) = active_workspace_role(conn, workspace_id, actor_member_id).await?
                else {
                    return Ok(Err(ApiError::forbidden("not an active workspace member")));
                };
                let Some(owner) = agent_owner_in_tx(conn, workspace_id, agent_member_id).await?
                else {
                    return Ok(Err(ApiError::not_found("active agent not found")));
                };
                if !role.is_admin() && owner != Some(actor_member_id) {
                    return Ok(Err(ApiError::forbidden(
                        "agent owner or workspace admin required",
                    )));
                }
                Ok(Ok(load_agent_profile_in_tx(
                    conn,
                    workspace_id,
                    agent_member_id,
                )
                .await?))
            })
        })
        .await,
    )?;

    let profile = profile.ok_or_else(|| ApiError::not_found("agent profile not found"))?;
    Ok(Json(AgentProfileResponse {
        profile: profile_dto(&profile),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_agent::AgentSpecInvalid;

    /// Every refusal keeps the Swift sentence, because a client that already
    /// renders the Swift server's errors must not have to learn a second
    /// vocabulary for the same rule.
    #[test]
    fn spec_errors_keep_their_own_sentence_and_are_all_400() {
        for (invalid, expected) in [
            (
                AgentSpecInvalid::Model,
                "model must contain 1...200 characters",
            ),
            (
                AgentSpecInvalid::ModelPrefNotAllowed,
                "modelPref is not in workspace.settings.allowed_agent_models",
            ),
            (
                AgentSpecInvalid::CredentialShaped("config.apiKey".into()),
                "credential-shaped field is forbidden at config.apiKey",
            ),
        ] {
            let error = spec_error(invalid);
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
            assert_eq!(error.message, expected);
        }
    }

    /// The create body is closed-world: an unknown key is a 400, so a caller
    /// cannot slip an unrecognised field past the credential walk by inventing a
    /// name for it.
    #[test]
    fn an_unknown_create_field_is_refused_by_the_decoder() {
        let body = json!({
            "displayName": "hermes", "handle": "hermes", "model": "hermes-agent",
            "baseUrl": "https://gw.example/v1", "bearer": "sk-live-oops"
        });
        assert!(
            serde_json::from_value::<CreateAgentRequest>(body).is_err(),
            "deny_unknown_fields must refuse a smuggled credential field"
        );
    }

    /// …and the accepted `config` is then walked, so the credential policy does
    /// not depend on the field name being unknown.
    ///
    /// The body is spelled the way the Swift client spells it (camelCase), which
    /// is also what pins the wire contract: a `rename_all` regression here would
    /// make every real request 400 with "unknown field `displayName`".
    #[test]
    fn a_credential_inside_config_is_refused_by_the_walk() {
        let request: CreateAgentRequest = serde_json::from_value(json!({
            "displayName": "hermes", "handle": "hermes", "model": "hermes-agent",
            "baseUrl": "https://gw.example/v1",
            "config": {"nested": {"api_key": "sk-live-oops"}}
        }))
        .expect("a well-shaped body");
        let error = validated_config(request.config.as_ref()).expect_err("credential-shaped");
        assert!(
            matches!(error, AgentSpecInvalid::CredentialShaped(_)),
            "{error}"
        );
    }

    /// A profile is optional on create, and its defaults must be the ones the
    /// mention trigger depends on (`triggers.mention = true`).
    #[test]
    fn an_initial_profile_defaults_to_a_mention_trigger() {
        let input = AgentProfileInput {
            instructions: "be terse".into(),
            model_pref: None,
            effort_pref: None,
            enabled_tools: vec![],
            triggers: None,
        };
        let spec = validated_profile(&input).expect("valid");
        assert_eq!(spec.triggers, json!({"mention": true}));
        assert_eq!(spec.instructions, "be terse");
    }
}
