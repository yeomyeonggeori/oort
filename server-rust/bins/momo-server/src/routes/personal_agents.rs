//! Personal agents: the owner turns a connected harness on under an alias
//! (#3591 P2, ADR-0198 증보 1 D7, 결재 2026-10-07 1~3).
//!
//! * `POST /v1/workspaces/{ws}/personal-agents` — 켜기. Creates the
//!   `member.kind = 'agent'` identity for the **caller's own** harness, or turns
//!   back on / returns the one the caller already has (one per harness), or
//!   converts the caller's own existing `owner_only` subscription agent in place
//!   (`agentMemberId`, #3567: same member id, handle and history).
//! * `GET  /v1/workspaces/{ws}/personal-agents` — the caller's own agents,
//!   switched-off ones included.
//! * `POST /v1/workspaces/{ws}/personal-agents/{agent}/disable` — 끄기. The
//!   member is suspended, not deleted: every past message keeps its author.
//!
//! ## What the gate is
//!
//! The caller is the owner **by construction**: the owner id is never a request
//! field, it is the caller's member id. A teammate therefore has no way to name
//! an alias for someone else's harness, to convert, switch off or look at
//! someone else's personal agent (all of those are one non-disclosing 404), and
//! an agent bearer, a guest or an anonymous caller never gets in. Calling the
//! agent is not this file's job: T5's signed spawn already requires "a live
//! `owner_only` agent owned by the requester", which a switched-off personal
//! agent (`member.status = 'suspended'`) no longer is, and the mention gate's
//! `NonOwner` sentence refuses a teammate before anything else (P1 wires the
//! mention into a spawn).
//!
//! ## What is deliberately not here
//!
//! * No hosted connection, token, pairing value, `agent_profile` or channel
//!   membership. The server holds no credential for the harness; the row's
//!   config is not `hosted_dial_in`, so migration 069's guard refuses a hosted
//!   connection for it. How the alias joins a channel is P1's open decision.
//! * No `MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED` or
//!   `MOMO_SUBSCRIPTION_AGENTS_ENABLED` check: ADR-0198 증보 1's D18 table says
//!   neither is the switch for D7.
//! * No requirement that a work host already exists. T5 checks the host, the
//!   folder and the harness at spawn time; a Mac that is off today is not a
//!   reason to refuse naming the agent.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::{Extension, Json};
use momo_agent::{PersonalAgentRow, SubscriptionHarness};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::{active_workspace_role, WorkspaceRole};
use momo_settings::{
    is_handle_banned_in_tx, normalized_join_display_name, normalized_requested_handle,
};
use serde_json::json;
use uuid::Uuid;

use crate::dto::{
    DisablePersonalAgentResponse, EnablePersonalAgentRequest, EnablePersonalAgentResponse,
    PersonalAgentListResponse, PersonalAgentSummaryDto,
};
use crate::error::ApiError;
use crate::routes::hosted_agent_connections::no_store;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_human, settle_db, workspace_scope,
};
use crate::AppState;

/// The owner already has a personal agent for this harness (one per harness);
/// the alias or conversion target named is a different one.
pub const CODE_EXISTS: &str = "personal_agent_exists";
/// An administrator suspended it; the owner cannot undo that by turning it on.
pub const CODE_SUSPENDED: &str = "personal_agent_suspended";
/// The alias is taken by a member (human, agent or switched off) of this workspace.
pub const CODE_ALIAS_TAKEN: &str = "personal_agent_alias_taken";
pub const CODE_NOT_FOUND: &str = "personal_agent_not_found";
/// A hosted connection or live credential is still attached to the agent being
/// converted; revoking them is #3567's step.
pub const CODE_CONNECTIONS_REMAIN: &str = "personal_agent_connections_remain";

fn summary(row: &PersonalAgentRow, owner_display_name: &str) -> PersonalAgentSummaryDto {
    PersonalAgentSummaryDto {
        id: row.id.to_string(),
        handle: row.handle.clone(),
        display_name: row.display_name.clone(),
        harness: row.harness.as_str().to_string(),
        enabled: row.enabled,
        label: momo_agent::personal_agent_label(owner_display_name),
    }
}

/// The caller as a workspace member who may own a personal agent: an active
/// human who is not a guest. Returns the caller's display name.
async fn require_owner(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    actor: Uuid,
) -> Result<Result<String, ApiError>, momo_db::DbError> {
    match active_workspace_role(conn, workspace_id, actor).await? {
        None | Some(WorkspaceRole::Guest) => {
            return Ok(Err(ApiError::forbidden(
                "workspace member required to use a personal agent",
            )))
        }
        Some(_) => {}
    }
    let Some((name, _handle)) =
        momo_agent::load_member_naming_in_tx(conn, workspace_id, actor).await?
    else {
        return Ok(Err(ApiError::forbidden("active human owner required")));
    };
    Ok(Ok(name))
}

async fn audit(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    actor: Uuid,
    via_token_id: Option<Uuid>,
    action: &'static str,
    agent: Uuid,
    harness: SubscriptionHarness,
) -> Result<(), momo_db::DbError> {
    write_audit(
        conn,
        &AuditEntry::new(workspace_id, action)
            .by(actor)
            .about(agent)
            .target("member", agent)
            .via_token(via_token_id)
            .with_schema(
                "momo.personal_agent.v1",
                json!({ "harness": harness.as_str() }),
            ),
    )
    .await?;
    Ok(())
}

pub async fn enable(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<EnablePersonalAgentRequest>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human workspace member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let harness = SubscriptionHarness::parse(&request.harness)
        .ok_or_else(|| ApiError::bad_request("harness must be claude_code or codex"))?;
    let alias = normalized_requested_handle(request.alias.as_deref())
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let display_name = request
        .display_name
        .as_deref()
        .map(normalized_join_display_name)
        .transpose()
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let convert = request.agent_member_id;
    if convert.is_some() && alias.is_some() {
        return Err(ApiError::bad_request(
            "alias cannot be given when converting an existing agent; it keeps its handle",
        ));
    }
    let actor = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let (status, response) = settle_db(
        "personal_agents.enable",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let owner_name = match require_owner(conn, workspace_id, actor).await? {
                    Ok(name) => name,
                    Err(error) => return Ok(Err(error)),
                };
                momo_agent::lock_personal_agent_in_tx(conn, workspace_id, actor, harness).await?;

                if let Some(existing) =
                    momo_agent::find_owner_personal_agent_in_tx(conn, workspace_id, actor, harness)
                        .await?
                {
                    let names_another = alias.as_ref().is_some_and(|a| *a != existing.handle)
                        || convert.is_some_and(|id| id != existing.id);
                    if names_another {
                        return Ok(Err(ApiError::coded(
                            StatusCode::CONFLICT,
                            CODE_EXISTS,
                            "you already have a personal agent for this harness",
                        )));
                    }
                    let mut row = existing;
                    if !row.enabled {
                        if !row.owner_disabled {
                            return Ok(Err(ApiError::coded(
                                StatusCode::CONFLICT,
                                CODE_SUSPENDED,
                                "this personal agent was suspended by an administrator",
                            )));
                        }
                        if !momo_agent::set_personal_agent_enabled_in_tx(
                            conn,
                            workspace_id,
                            row.id,
                            true,
                        )
                        .await?
                        {
                            return Err(momo_db::DbError::from(momo_db::sqlx::Error::RowNotFound));
                        }
                        row.enabled = true;
                        row.owner_disabled = false;
                        audit(
                            conn,
                            workspace_id,
                            actor,
                            via_token_id,
                            "personal_agent.enabled",
                            row.id,
                            harness,
                        )
                        .await?;
                    }
                    return Ok(Ok((
                        StatusCode::OK,
                        EnablePersonalAgentResponse {
                            agent: summary(&row, &owner_name),
                            reused: true,
                        },
                    )));
                }

                // In-place conversion of the caller's own subscription agent.
                if let Some(agent_id) = convert {
                    match momo_agent::mark_personal_agent_in_tx(
                        conn,
                        workspace_id,
                        actor,
                        agent_id,
                        harness,
                    )
                    .await?
                    {
                        momo_agent::MarkOutcome::Marked => {}
                        momo_agent::MarkOutcome::ConnectionsRemain => {
                            return Ok(Err(ApiError::coded(
                                StatusCode::CONFLICT,
                                CODE_CONNECTIONS_REMAIN,
                                "disconnect this agent's hosted connection before converting it",
                            )));
                        }
                        momo_agent::MarkOutcome::NotConvertible => {
                            // Someone else's, a team-callable (workspace-scope)
                            // agent, another harness, a personal-key agent,
                            // already personal, dead or not an agent: one answer.
                            return Ok(Err(ApiError::coded(
                                StatusCode::NOT_FOUND,
                                CODE_NOT_FOUND,
                                "no convertible agent of yours with that id",
                            )));
                        }
                    }
                    let Some(row) = momo_agent::find_owned_personal_agent_in_tx(
                        conn,
                        workspace_id,
                        actor,
                        agent_id,
                    )
                    .await?
                    else {
                        return Err(momo_db::DbError::from(momo_db::sqlx::Error::RowNotFound));
                    };
                    audit(
                        conn,
                        workspace_id,
                        actor,
                        via_token_id,
                        "personal_agent.converted",
                        row.id,
                        harness,
                    )
                    .await?;
                    return Ok(Ok((
                        StatusCode::CREATED,
                        EnablePersonalAgentResponse {
                            agent: summary(&row, &owner_name),
                            reused: false,
                        },
                    )));
                }

                let Some(handle) = alias else {
                    return Ok(Err(ApiError::bad_request("alias is required")));
                };
                if is_handle_banned_in_tx(conn, &handle).await? {
                    return Ok(Err(ApiError::forbidden(
                        "member is banned from this workspace",
                    )));
                }
                let display = display_name.unwrap_or_else(|| handle.clone());
                let member = match momo_agent::create_agent_identity_in_tx(
                    conn,
                    workspace_id,
                    &momo_agent::NewAgentMember {
                        display_name: display,
                        handle,
                        model: momo_auth::HOSTED_AGENT_MODEL.to_string(),
                        model_source: momo_agent::ModelSource::Agent,
                        base_url: momo_auth::HOSTED_AGENT_INERT_BASE_URL.to_string(),
                        system_prompt: None,
                        // Not `hosted_dial_in`: migration 069 then refuses any
                        // hosted connection for this row.
                        config: json!({"execution_mode": "member_host"}),
                        owner_human_id: actor,
                    },
                )
                .await?
                {
                    momo_agent::AgentCreation::Created(member) => member,
                    momo_agent::AgentCreation::DuplicateHandle => {
                        return Ok(Err(ApiError::coded(
                            StatusCode::CONFLICT,
                            CODE_ALIAS_TAKEN,
                            "that alias is already taken in this workspace",
                        )))
                    }
                    momo_agent::AgentCreation::InvalidOwner => {
                        return Ok(Err(ApiError::forbidden("active human owner required")))
                    }
                };
                if !momo_agent::mark_agent_owner_only_in_tx(conn, workspace_id, member.id, harness)
                    .await?
                    || momo_agent::mark_personal_agent_in_tx(
                        conn,
                        workspace_id,
                        actor,
                        member.id,
                        harness,
                    )
                    .await?
                        != momo_agent::MarkOutcome::Marked
                {
                    return Err(momo_db::DbError::from(momo_db::sqlx::Error::RowNotFound));
                }
                audit(
                    conn,
                    workspace_id,
                    actor,
                    via_token_id,
                    "personal_agent.enabled",
                    member.id,
                    harness,
                )
                .await?;
                let row = PersonalAgentRow {
                    id: member.id,
                    handle: member.handle,
                    display_name: member.display_name,
                    harness,
                    enabled: true,
                    owner_disabled: false,
                };
                Ok(Ok((
                    StatusCode::CREATED,
                    EnablePersonalAgentResponse {
                        agent: summary(&row, &owner_name),
                        reused: false,
                    },
                )))
            })
        })
        .await,
    )?;
    Ok(no_store(status, response))
}

pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human workspace member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let actor = principal.member_id;
    let agents = settle_db(
        "personal_agents.list",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let owner_name = match require_owner(conn, workspace_id, actor).await? {
                    Ok(name) => name,
                    Err(error) => return Ok(Err(error)),
                };
                let rows =
                    momo_agent::list_owner_personal_agents_in_tx(conn, workspace_id, actor).await?;
                Ok(Ok(rows
                    .iter()
                    .map(|row| summary(row, &owner_name))
                    .collect::<Vec<_>>()))
            })
        })
        .await,
    )?;
    Ok(no_store(
        StatusCode::OK,
        PersonalAgentListResponse { agents },
    ))
}

pub async fn disable(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, Uuid)>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human workspace member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let actor = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);
    let summary = settle_db(
        "personal_agents.disable",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let owner_name = match require_owner(conn, workspace_id, actor).await? {
                    Ok(name) => name,
                    Err(error) => return Ok(Err(error)),
                };
                // Only the caller's own: someone else's, a non-personal agent and
                // a missing id are the same 404.
                let Some(mut row) =
                    momo_agent::find_owned_personal_agent_in_tx(conn, workspace_id, actor, agent)
                        .await?
                else {
                    return Ok(Err(ApiError::coded(
                        StatusCode::NOT_FOUND,
                        CODE_NOT_FOUND,
                        "no personal agent of yours with that id",
                    )));
                };
                if row.enabled {
                    if !momo_agent::set_personal_agent_enabled_in_tx(
                        conn,
                        workspace_id,
                        row.id,
                        false,
                    )
                    .await?
                    {
                        return Err(momo_db::DbError::from(momo_db::sqlx::Error::RowNotFound));
                    }
                    row.enabled = false;
                    row.owner_disabled = true;
                    audit(
                        conn,
                        workspace_id,
                        actor,
                        via_token_id,
                        "personal_agent.disabled",
                        row.id,
                        row.harness,
                    )
                    .await?;
                }
                Ok(Ok(summary(&row, &owner_name)))
            })
        })
        .await,
    )?;
    Ok(no_store(
        StatusCode::OK,
        DisablePersonalAgentResponse { agent: summary },
    ))
}
