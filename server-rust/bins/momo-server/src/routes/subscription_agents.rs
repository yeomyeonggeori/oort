//! `POST /v1/workspaces/{ws}/subscription-agents/register` (#3392 AIH-2,
//! ADR-0193 증보 2026-10-03).
//!
//! The desktop app calls this right after the official CLI finished logging the
//! person in. It creates — or reuses — **the caller's own** `owner_only`
//! subscription agent and, when a connection still needs one, mints the one-time
//! connection value the app hands to the official CLI (`mcp add`, ADR-0190 D3-h).
//!
//! ## What is deliberately not new
//!
//! * The gate is today's 「구독 추가」: a human workspace owner/admin
//!   ([`require_admin`]), refused with the same 403 before anything else.
//! * The identity, its paused profile, the `owner_only` mark and the pairing
//!   connection come from [`provision_hosted_agent_in_tx`] — the function
//!   `POST …/hosted-agent-connections` uses — so #2940's guarantee (an
//!   `owner_only` agent never runs on the team key) is carried by the same rows.
//! * The Claude opt-in is `MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED`, **off by
//!   default** (owner decision 2026-10-03, #3397): `harness: claude_code` answers
//!   409 `claude_subscription_agent_paused` and writes nothing. Codex is not affected.
//! * The kill switch is `MOMO_SUBSCRIPTION_AGENTS_ENABLED`. Off answers 409 with
//!   the code `subscription_agents_disabled` so a client can say 「이 서버에서는
//!   꺼져 있어요」 instead of hiding the option.
//!
//! ## Idempotency
//!
//! Key = (caller, harness, `deviceId`). A repeat returns the same agent and never
//! a second row; a connection that still waits for the CLI (`pairing_pending`,
//! `detected`, `expired`) gets a fresh value (the old one is revoked by
//! `regenerate_pairing_in_tx`), an `active` one gets none, a `disconnected` one a
//! new pairing on the same agent, a `cleanup_pending` one a 409. An advisory lock
//! serializes concurrent calls; the partial unique index of migration 116 is the
//! backstop.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::{Extension, Json};
use momo_agent::SubscriptionHarness;
use momo_auth::{
    create_hosted_connection_in_tx, latest_hosted_connection_for_agent_in_tx,
    regenerate_pairing_in_tx, HostedMutation, Principal,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_settings::{
    is_handle_banned_in_tx, normalized_join_display_name, normalized_requested_handle,
};
use serde_json::json;

use crate::dto::{
    AgentMemberDto, RegisterSubscriptionAgentRequest, RegisterSubscriptionAgentResponse,
};
use crate::error::ApiError;
use crate::routes::hosted_agent_connections::{
    dto, no_store, provision_hosted_agent_in_tx, require_admin, Provisioned,
};
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_human, settle_db, workspace_scope,
};
use crate::AppState;

/// Default-name attempts before giving up (`-2` … `-20`).
const NAME_ATTEMPTS: usize = 20;

pub const CODE_DISABLED: &str = "subscription_agents_disabled";
/// #3397 결재: Claude subscription agents are off by default until Anthropic replies.
pub const CODE_CLAUDE_PAUSED: &str = momo_agent::CLAUDE_SUBSCRIPTION_AGENT_PAUSED;
pub const CODE_LIMIT: &str = "subscription_agent_limit";
pub const CODE_CLEANUP_PENDING: &str = "subscription_agent_cleanup_pending";

struct Registered {
    agent: momo_agent::AgentMember,
    connection: momo_auth::HostedConnection,
    reused: bool,
    credential: Option<(String, i64)>,
}

pub async fn register(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<RegisterSubscriptionAgentRequest>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let harness = SubscriptionHarness::parse(&request.harness)
        .ok_or_else(|| ApiError::bad_request("harness must be claude_code or codex"))?;
    if !momo_agent::valid_device_id(&request.device_id) {
        return Err(ApiError::bad_request(
            "deviceId must be 8-64 characters of letters, digits, '.', '_' or '-'",
        ));
    }
    let explicit_display = request
        .display_name
        .as_deref()
        .map(normalized_join_display_name)
        .transpose()
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let explicit_handle = normalized_requested_handle(request.handle.as_deref())
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let device_slug = request
        .device_label
        .as_deref()
        .map(momo_agent::device_slug)
        .unwrap_or_default();
    let subscription_agents_enabled = state.agent_port.config.subscription_agents_enabled;
    let claude_enabled = state.agent_port.config.claude_subscription_agents_enabled;
    let device_id = request.device_id.clone();
    let actor = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let registered = settle_db(
        "subscription_agents.register",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // Admin first: a member who may not do this hears 403 whatever
                // the switch says, exactly as `hosted-agent-connections` does.
                if let Err(error) = require_admin(conn, workspace_id, actor).await? {
                    return Ok(Err(error));
                }
                if !subscription_agents_enabled {
                    return Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        CODE_DISABLED,
                        "subscription agents are disabled on this server",
                    )));
                }
                // #3397 결재 2026-10-03: a Claude subscription agent is not
                // registered unless the operator opted in. After the admin gate and
                // the general switch; before any lock or write. Codex is unaffected.
                if harness == SubscriptionHarness::ClaudeCode && !claude_enabled {
                    return Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        CODE_CLAUDE_PAUSED,
                        "claude subscription agents are paused on this server",
                    )));
                }
                momo_agent::lock_subscription_registration_in_tx(
                    conn,
                    workspace_id,
                    actor,
                    harness,
                    &device_id,
                )
                .await?;

                let existing = momo_agent::find_subscription_agent_by_device_in_tx(
                    conn,
                    workspace_id,
                    actor,
                    harness,
                    &device_id,
                )
                .await?;
                if let Some((agent_id, handle, display_name, live)) = existing {
                    if live {
                        let agent = momo_agent::AgentMember {
                            id: agent_id,
                            handle,
                            display_name,
                        };
                        let outcome = reuse_in_tx(conn, workspace_id, actor, agent).await?;
                        if let Ok(registered) = &outcome {
                            audit_registered(
                                conn,
                                workspace_id,
                                actor,
                                via_token_id,
                                harness,
                                registered,
                            )
                            .await?;
                        }
                        return Ok(outcome);
                    }
                    // The Mac's earlier agent is gone: free its slot.
                    momo_agent::release_subscription_device_in_tx(conn, workspace_id, agent_id)
                        .await?;
                }

                let owned = momo_agent::count_owner_subscription_agents_in_tx(
                    conn,
                    workspace_id,
                    actor,
                    harness,
                )
                .await?;
                if owned >= momo_agent::SUBSCRIPTION_AGENTS_PER_HARNESS_LIMIT {
                    return Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        CODE_LIMIT,
                        "too many subscription agents for this CLI",
                    )));
                }

                // Candidate names. An explicit handle is taken as is (the person
                // chose it); defaults walk -2, -3, ... (owner decision 2026-10-03).
                let candidates: Vec<(String, String)> = if let Some(handle) = explicit_handle {
                    let display = explicit_display.clone().unwrap_or_else(|| handle.clone());
                    vec![(display, handle)]
                } else {
                    let Some((owner_name, owner_handle)) =
                        momo_agent::load_member_naming_in_tx(conn, workspace_id, actor).await?
                    else {
                        return Ok(Err(ApiError::forbidden("active human owner required")));
                    };
                    let device_part =
                        (owned > 0 && !device_slug.is_empty()).then_some(device_slug.as_str());
                    let mut names = momo_agent::default_name_candidates(
                        &owner_name,
                        &owner_handle,
                        harness,
                        device_part,
                        NAME_ATTEMPTS,
                    );
                    if let Some(display) = &explicit_display {
                        for (shown, _) in names.iter_mut() {
                            *shown = display.clone();
                        }
                    }
                    names
                };
                let explicit_only = candidates.len() == 1;
                for (display_name, handle) in candidates {
                    if is_handle_banned_in_tx(conn, &handle).await? {
                        return Ok(Err(ApiError::forbidden(
                            "member is banned from this workspace",
                        )));
                    }
                    match provision_hosted_agent_in_tx(
                        conn,
                        workspace_id,
                        actor,
                        via_token_id,
                        display_name,
                        handle,
                        Some(harness),
                        Some(&device_id),
                    )
                    .await?
                    {
                        Provisioned::Created(agent, issuance) => {
                            let registered = Registered {
                                agent,
                                connection: issuance.connection,
                                reused: false,
                                credential: Some((
                                    issuance.pairing_credential,
                                    issuance.pairing_expires_at_ms,
                                )),
                            };
                            audit_registered(
                                conn,
                                workspace_id,
                                actor,
                                via_token_id,
                                harness,
                                &registered,
                            )
                            .await?;
                            return Ok(Ok(registered));
                        }
                        Provisioned::DuplicateHandle if explicit_only => {
                            return Ok(Err(ApiError::new(
                                StatusCode::CONFLICT,
                                "agent handle already exists",
                            )));
                        }
                        Provisioned::DuplicateHandle => continue,
                        Provisioned::Rejected(error) => return Ok(Err(error)),
                    }
                }
                Ok(Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "agent handle already exists",
                )))
            })
        })
        .await,
    )?;

    let mut connection = dto(registered.connection);
    connection.invocation_scope = Some(momo_agent::INVOCATION_SCOPE_OWNER_ONLY.to_string());
    connection.subscription_harness = Some(harness.as_str().to_string());
    let (pairing_credential, pairing_expires_at_ms) = match registered.credential {
        Some((credential, expires)) => (Some(credential), Some(expires)),
        None => (None, None),
    };
    Ok(no_store(
        if registered.reused {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        RegisterSubscriptionAgentResponse {
            agent: AgentMemberDto {
                id: registered.agent.id.to_string(),
                handle: registered.agent.handle,
                display_name: registered.agent.display_name,
            },
            connection,
            reused: registered.reused,
            pairing_credential,
            pairing_expires_at_ms,
        },
    ))
}

/// A repeat call: decide from the agent's newest connection.
async fn reuse_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: uuid::Uuid,
    actor: uuid::Uuid,
    agent: momo_agent::AgentMember,
) -> Result<Result<Registered, ApiError>, momo_db::DbError> {
    let latest = latest_hosted_connection_for_agent_in_tx(conn, workspace_id, agent.id).await?;
    let Some(latest) = latest else {
        let issuance = create_hosted_connection_in_tx(conn, workspace_id, agent.id, actor).await?;
        return Ok(Ok(Registered {
            agent,
            connection: issuance.connection,
            reused: true,
            credential: Some((issuance.pairing_credential, issuance.pairing_expires_at_ms)),
        }));
    };
    match latest.status.as_str() {
        "pairing_pending" | "detected" | "expired" => {
            match regenerate_pairing_in_tx(conn, workspace_id, latest.id).await? {
                HostedMutation::Applied(issuance) => Ok(Ok(Registered {
                    agent,
                    connection: issuance.connection,
                    reused: true,
                    credential: Some((issuance.pairing_credential, issuance.pairing_expires_at_ms)),
                })),
                _ => Err(momo_db::DbError::from(momo_db::sqlx::Error::RowNotFound)),
            }
        }
        "active" => Ok(Ok(Registered {
            agent,
            connection: latest,
            reused: true,
            credential: None,
        })),
        "disconnected" => {
            let issuance =
                create_hosted_connection_in_tx(conn, workspace_id, agent.id, actor).await?;
            Ok(Ok(Registered {
                agent,
                connection: issuance.connection,
                reused: true,
                credential: Some((issuance.pairing_credential, issuance.pairing_expires_at_ms)),
            }))
        }
        _ => Ok(Err(ApiError::coded(
            StatusCode::CONFLICT,
            CODE_CLEANUP_PENDING,
            "finish disconnecting this agent before registering it again",
        ))),
    }
}

/// One audit row. Secret-free by construction: harness, reuse flag, whether a
/// value was minted — never the value, never the device id.
async fn audit_registered(
    conn: &mut momo_db::PgConnection,
    workspace_id: uuid::Uuid,
    actor: uuid::Uuid,
    via_token_id: Option<uuid::Uuid>,
    harness: SubscriptionHarness,
    registered: &Registered,
) -> Result<(), momo_db::DbError> {
    write_audit(
        conn,
        &AuditEntry::new(workspace_id, "subscription_agent.registered")
            .by(actor)
            .about(registered.agent.id)
            .target("hosted_agent_connection", registered.connection.id)
            .via_token(via_token_id)
            .with_schema(
                "momo.subscription_agent.registered.v1",
                json!({
                    "harness": harness.as_str(),
                    "reused": registered.reused,
                    "connection_value_minted": registered.credential.is_some(),
                }),
            ),
    )
    .await?;
    Ok(())
}
