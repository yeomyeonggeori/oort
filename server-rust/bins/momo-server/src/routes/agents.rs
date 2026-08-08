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
//! ## B5.3a — the operating surface beside the creating one
//!
//! ```text
//! PUT  /v1/workspaces/{ws}/agents/{agent}/profile         (AgentProfileRoutes.put)
//! PUT  /v1/workspaces/{ws}/agents/{agent}/pause           (AgentProfileRoutes.putPause)
//! GET  /v1/workspaces/{ws}/agents/{agent}/allowed-models  (AgentProfileRoutes.allowedModels)
//! ```
//!
//! B5.2 shipped creation and the profile *read*, and deliberately stopped there
//! ("shipping a model-picker endpoint with no picker"). What it left behind was
//! an agent whose behaviour could be set exactly once, at birth: `paused` was
//! read and respected by the mention path with nothing able to write it, and the
//! instructions an operator got wrong on the create form were permanent.
//!
//! The three endpoints carry **two different authorities**, and the split is
//! Swift's (:369-406 vs :40-60):
//!
//! | endpoint | who | why |
//! |---|---|---|
//! | `PUT …/profile`, `PUT …/pause` | the agent's owner **or** a workspace admin | a profile carries the instructions an operator wrote; pause stops the agent acting for everyone |
//! | `GET …/allowed-models` | any active workspace member | it is the picker's vocabulary, and refusing it would leave a teammate guessing which models a `routing` block may name |
//!
//! No credential is issued anywhere here (Swift's create stops at the identity
//! boundary too, ADR-0004).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_agent::{
    agent_owner_in_tx, allowed_agent_models, create_agent_identity_in_tx,
    load_agent_model_policy_in_tx, load_agent_profile_in_tx, normalized_model,
    normalized_system_prompt, set_agent_paused_in_tx, upsert_agent_profile_in_tx,
    validate_agent_profile, validated_config, AgentCreation, AgentProfile, AgentProfileSpec,
    AgentSpecInvalid, NewAgentMember,
};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::PgConnection;
use momo_messaging::active_workspace_role;
use momo_settings::{
    is_handle_banned_in_tx, normalized_join_display_name, normalized_requested_handle,
    validated_base_url,
};
use serde_json::json;
use uuid::Uuid;

use crate::dto::{
    AgentMemberDto, AgentPauseInput, AgentProfileDto, AgentProfileInput, AgentProfileResponse,
    AllowedAgentModelsResponse, CreateAgentRequest, CreateAgentResponse,
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

/// Swift `AgentProfileRoutes.requireEditor` (:369-406) — a human that is the
/// agent's **owner** or a workspace owner/admin.
///
/// Not every member, and not the agent itself. A profile carries the
/// instructions an operator wrote (and, since B5.3a, the switch that stops the
/// agent acting), while the roster already serves the parts a teammate needs —
/// name, handle, model. An agent that could edit its own profile could also
/// unpause itself, which is the one thing pause exists to prevent.
///
/// The order of the two refusals is Swift's and it matters: a caller who is not
/// in the workspace at all is told so (403) before any agent id is resolved, so
/// this endpoint cannot be used to probe which agent ids exist in a workspace
/// the caller has no part in.
///
/// Runs inside the caller's transaction so the authorization and the write it
/// guards share one commit boundary.
async fn require_profile_editor_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    actor_member_id: Uuid,
) -> Result<Result<(), ApiError>, momo_db::DbError> {
    let Some(role) = active_workspace_role(conn, workspace_id, actor_member_id).await? else {
        return Ok(Err(ApiError::forbidden("not an active workspace member")));
    };
    let Some(owner) = agent_owner_in_tx(conn, workspace_id, agent_member_id).await? else {
        return Ok(Err(ApiError::not_found("active agent not found")));
    };
    if !role.is_admin() && owner != Some(actor_member_id) {
        return Ok(Err(ApiError::forbidden(
            "agent owner or workspace admin required",
        )));
    }
    Ok(Ok(()))
}

/// `GET /v1/workspaces/{ws}/agents/{agent}/profile`.
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
                if let Err(rejection) = require_profile_editor_in_tx(
                    conn,
                    workspace_id,
                    agent_member_id,
                    actor_member_id,
                )
                .await?
                {
                    return Ok(Err(rejection));
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

/// `PUT /v1/workspaces/{ws}/agents/{agent}/profile` — Swift
/// `AgentProfileRoutes.put` (:75-94).
///
/// Ordering, and every step of it earns its place:
///
/// 1. **Body validation before the transaction** (MOMO-362). All of it is pure —
///    lengths, the tool list, the closed-world `triggers` — so a malformed body
///    costs no connection.
/// 2. **Editor check, then the allow-list, then the write**, in one transaction.
/// 3. **`model_pref` is gated at write time** (ADR-0131 D2), and the sentence is
///    the create path's, from the same `allowed_agent_models` helper the run
///    gates use. Writing a preference is an explicit act, so a violation is a
///    visible 400 — while the *same* stored value later becoming unusable is
///    silently ignored at run time. That asymmetry is the decision (ADR-0134 D3),
///    not an inconsistency.
///
/// The upsert bumps `version`, which is what a hub UI reads as "edited N times"
/// and what `load_mention_candidates_in_tx` uses to tell "no profile" from "a
/// profile with empty instructions".
pub async fn put_profile(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
    Json(request): Json<AgentProfileInput>,
) -> Result<Json<AgentProfileResponse>, ApiError> {
    require_human(&principal, "human agent owner or workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let agent_member_id = path_uuid(&agent, "invalid agent id")?;
    let spec = validated_profile(&request)?;
    let actor_member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let profile = settle_db(
        "agents.put_profile",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_profile_editor_in_tx(
                    conn,
                    workspace_id,
                    agent_member_id,
                    actor_member_id,
                )
                .await?
                {
                    return Ok(Err(rejection));
                }
                if let Some(model_pref) = spec.model_pref.as_deref() {
                    let Some((base, settings)) =
                        load_agent_model_policy_in_tx(conn, workspace_id, agent_member_id).await?
                    else {
                        return Ok(Err(ApiError::not_found("agent profile target not found")));
                    };
                    if !allowed_agent_models(&base, &settings)
                        .iter()
                        .any(|entry| entry == model_pref)
                    {
                        return Ok(Err(spec_error(AgentSpecInvalid::ModelPrefNotAllowed)));
                    }
                }
                let Some(stored) = upsert_agent_profile_in_tx(
                    conn,
                    workspace_id,
                    agent_member_id,
                    actor_member_id,
                    &spec,
                )
                .await?
                else {
                    return Ok(Err(ApiError::not_found("agent profile target not found")));
                };
                // Swift :247 — the action is derived from the version the write
                // returned, so an operator reading the audit log can tell the
                // first configuration from the tenth edit.
                let action = if stored.version == 1 {
                    "agent.profile.created"
                } else {
                    "agent.profile.updated"
                };
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, action)
                        .by(actor_member_id)
                        .about(agent_member_id)
                        .target("agent_profile", agent_member_id)
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
                Ok(Ok(stored))
            })
        })
        .await,
    )?;

    Ok(Json(AgentProfileResponse {
        profile: profile_dto(&profile),
    }))
}

/// `PUT /v1/workspaces/{ws}/agents/{agent}/pause` — Swift
/// `AgentProfileRoutes.putPause` (:96-113).
///
/// **This is the write half of the flag B5.2 could only read.** The mention path
/// has respected `agent_profile.paused` since B5.2 — a mention of a paused agent
/// starts no run and answers with a visible Korean system line — but nothing
/// could set it, so the only way to stop an agent was to remove it from every
/// channel it was in.
///
/// Pause is workspace-wide and **visible**: silence would be indistinguishable
/// from a broken agent, which is why the mention path posts a line rather than
/// swallowing the turn. Removing the agent from a channel
/// (`DELETE …/channels/{ch}/members/{member}`) is the local, silent alternative;
/// the two exist because they say different things to the team.
pub async fn put_pause(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
    Json(request): Json<AgentPauseInput>,
) -> Result<Json<AgentProfileResponse>, ApiError> {
    require_human(&principal, "human agent owner or workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let agent_member_id = path_uuid(&agent, "invalid agent id")?;
    let paused = request.paused;
    let actor_member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let profile = settle_db(
        "agents.put_pause",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_profile_editor_in_tx(
                    conn,
                    workspace_id,
                    agent_member_id,
                    actor_member_id,
                )
                .await?
                {
                    return Ok(Err(rejection));
                }
                let Some(stored) = set_agent_paused_in_tx(
                    conn,
                    workspace_id,
                    agent_member_id,
                    actor_member_id,
                    paused,
                )
                .await?
                else {
                    return Ok(Err(ApiError::not_found("agent profile target not found")));
                };
                write_audit(
                    conn,
                    &AuditEntry::new(
                        workspace_id,
                        if paused {
                            "agent.profile.paused"
                        } else {
                            "agent.profile.resumed"
                        },
                    )
                    .by(actor_member_id)
                    .about(agent_member_id)
                    .target("agent_profile", agent_member_id)
                    .via_token(via_token_id)
                    .with_schema(
                        "momo.agent_profile.pause.v1",
                        json!({ "paused": paused, "version": stored.version }),
                    ),
                )
                .await?;
                Ok(Ok(stored))
            })
        })
        .await,
    )?;

    Ok(Json(AgentProfileResponse {
        profile: profile_dto(&profile),
    }))
}

/// `GET /v1/workspaces/{ws}/agents/{agent}/allowed-models` — Swift
/// `AgentProfileRoutes.allowedModels` (:40-73).
///
/// The **only** read on the agent surface that any active workspace member may
/// make, and the widening is deliberate: this is the vocabulary of the composer's
/// model picker and of every `routing.model` a teammate may name. Gating it to
/// owners would leave everyone else guessing which values the send path accepts,
/// and a guess that is wrong is a 400 on a message someone meant to send.
///
/// What it must NOT become is a `workspace.settings` read. That JSON is an
/// extensible bag and may later hold keys not every member should see; this
/// answer is derived from it by the same `allowed_agent_models` helper the two
/// enforcement paths use, so the picker and the gate cannot disagree about a
/// model string.
///
/// SRV-B3 widened what that helper answers for a workspace that never
/// configured an allow-list — see its doc comment for the rule and why it is
/// fail-closed. The route is unchanged: it still asks the one helper, and still
/// carries nothing but the list.
pub async fn allowed_models(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
) -> Result<Json<AllowedAgentModelsResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let agent_member_id = path_uuid(&agent, "invalid agent id")?;
    let actor_member_id = principal.member_id;

    let models = settle_db(
        "agents.allowed_models",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, actor_member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("not an active workspace member")));
                }
                let Some((base, settings)) =
                    load_agent_model_policy_in_tx(conn, workspace_id, agent_member_id).await?
                else {
                    return Ok(Err(ApiError::not_found("agent profile target not found")));
                };
                Ok(Ok(allowed_agent_models(&base, &settings)))
            })
        })
        .await,
    )?;

    // Sorted so the wire result is deterministic; the gates compare membership,
    // not order, so this changes nothing they enforce (Swift :65-73).
    let mut allowed_agent_models = models;
    allowed_agent_models.sort();
    Ok(Json(AllowedAgentModelsResponse {
        allowed_agent_models,
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

    /// The pause body is one key and closed-world: a request that also carried
    /// `instructions` must not half-apply, and `{"paused": "true"}` is a typo
    /// worth a 400 rather than a truthy string.
    #[test]
    fn the_pause_request_is_one_boolean_and_nothing_else() {
        let parsed: AgentPauseInput =
            serde_json::from_value(json!({"paused": true})).expect("paused");
        assert!(parsed.paused);
        for bad in [
            json!({}),
            json!({"paused": "true"}),
            json!({"paused": true, "instructions": "…"}),
        ] {
            assert!(
                serde_json::from_value::<AgentPauseInput>(bad.clone()).is_err(),
                "{bad} must be refused"
            );
        }
    }

    /// The picker's answer carries the model list and **nothing else** — no
    /// workspace settings, no agent metadata — under the camelCase key the Swift
    /// client reads.
    #[test]
    fn the_allowed_models_answer_is_a_bare_sorted_list() {
        let json = serde_json::to_value(AllowedAgentModelsResponse {
            allowed_agent_models: vec!["hermes-agent".into(), "hermes-fast".into()],
        })
        .expect("serialize");
        assert_eq!(
            json,
            json!({"allowedAgentModels": ["hermes-agent", "hermes-fast"]}),
            "one key, camelCase, and no settings bag: {json}"
        );
    }

    /// A profile edit is judged by the same validator the create form uses, so
    /// the two cannot drift into accepting different profiles.
    #[test]
    fn a_profile_edit_is_validated_exactly_like_a_created_one() {
        let unusable = AgentProfileInput {
            instructions: "be terse".into(),
            model_pref: Some("hermes-fast".into()),
            effort_pref: Some("max".into()),
            enabled_tools: vec![],
            triggers: None,
        };
        let error = validated_profile(&unusable).expect_err("hermes-fast cannot do max");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            error.message,
            "effortPref 'max' is not supported by modelPref 'hermes-fast'"
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
