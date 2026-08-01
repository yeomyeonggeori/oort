//! Agent-run creation — Swift `AgentRunRoutes.create` (:29-250) parity.
//!
//! ```text
//! POST /v1/workspaces/{ws}/channels/{ch}/agent-runs
//! ```
//!
//! This is the **writer** half of the B2.6 spine: it creates the authoritative
//! `agent_run` row and enqueues the `agent_job` a gateway will claim. Everything
//! after it (claim → events → complete → ledger) lives in
//! [`crate::routes::agent_gateway`].
//!
//! ## Three properties this route is responsible for
//!
//! 1. **Human-only.** `requireHumanPrincipal` (:643-649): an agent cannot start
//!    an agent. The allow-list in `momo_auth::agent_scope` already makes this
//!    path unreachable with an agent bearer, so this is the second of two locks.
//! 2. **Idempotent on the trigger.** The `(workspace_id, idempotency_key)` unique
//!    index decides, not a read (`momo_agent::run`). A retry returns `200` with
//!    the original run; a *different* request reusing the same `clientRunId` is a
//!    `409`, because silently returning someone else's run would be worse than
//!    refusing.
//! 3. **Gateway mode required.** Without it there is no consumer for the job
//!    (:48-53), so creating the run would queue work nothing can ever claim.
//!
//! Everything in the transaction below is ordered rejection-before-write, the
//! `Rejectable` discipline `routes::shared` documents.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_agent::{
    create_agent_run_in_tx, is_active_human_channel_member_in_tx, load_agent_run_in_tx,
    load_eligible_agent_in_tx, NewAgentRun, RequestedRouting, RunTrigger,
};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::sqlx;
use momo_outbox::{emit_outbox, OutboxKind};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::dto::{AgentRunResponse, CreateAgentRunRequest};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, epoch_ms, path_uuid, require_human, run_response,
    settle_db, workspace_scope,
};
use crate::AppState;

/// Swift `WorkRunInput.allowedKeys` (`AgentRunRoutes.swift:1127`). Closed world:
/// an unknown key is a 400, so a client that invents `priority` learns it was
/// ignored instead of assuming it was honoured.
const WORK_INPUT_KEYS: [&str; 6] = ["type", "title", "brief", "repo", "branch", "routing"];

const TITLE_LIMIT: usize = 200;
const BRIEF_LIMIT: usize = 16_384;
const REPO_LIMIT: usize = 2_048;
const BRANCH_LIMIT: usize = 512;

/// `POST /v1/workspaces/{ws}/channels/{ch}/agent-runs`.
pub async fn create(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    Json(request): Json<CreateAgentRunRequest>,
) -> Result<(StatusCode, Json<AgentRunResponse>), ApiError> {
    require_human(&principal, "human member required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;

    // Shape errors become 4xx BEFORE a transaction opens (MOMO-362): a malformed
    // body must not cost a connection or leave a half-written row behind.
    let input = validated_work_input(&request)?;

    if !state.agent_gateway.enabled() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "work runs require an enabled BYOA agent gateway",
        ));
    }

    let trigger = RunTrigger::Work {
        channel_id,
        actor_member_id: principal.member_id,
        agent_member_id: request.agent_member_id,
        client_run_id: request.client_run_id,
    };
    let agent_member_id = request.agent_member_id;
    let actor_member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);
    let client_run_id = request.client_run_id;

    let outcome = settle_db(
        "agent_runs.create",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if !is_active_human_channel_member_in_tx(conn, channel_id, actor_member_id).await? {
                    return Ok(Err(ApiError::forbidden(
                        "not an active human channel member",
                    )));
                }

                let Some(agent) =
                    load_eligible_agent_in_tx(conn, workspace_id, channel_id, agent_member_id)
                        .await?
                else {
                    return Ok(Err(ApiError::not_found("active channel agent not found")));
                };

                // The run may already exist — a retry of a request whose response
                // was lost. Resolve that BEFORE the eligibility conflicts below,
                // exactly like Swift (:71-84): a paused agent must not turn a
                // successful earlier create into a 409 on retry.
                let created = create_agent_run_in_tx(
                    conn,
                    workspace_id,
                    NewAgentRun {
                        channel_id,
                        trigger,
                        parent_run_id: None,
                        max_steps: agent.max_run_steps,
                        depth: 0,
                        input: input.clone(),
                    },
                )
                .await?;

                let Some(run) = load_agent_run_in_tx(conn, workspace_id, created.id).await? else {
                    // The row was just inserted (or found) in this transaction,
                    // so its absence is a bug, not a client outcome.
                    return Err(momo_db::DbError::from(sqlx::Error::RowNotFound));
                };

                if !created.created {
                    // Same key, different request = a client bug or a collision;
                    // returning the other run would attribute work to the wrong
                    // ask, so refuse (Swift :77-82).
                    if run.channel_id != channel_id
                        || run.agent_member_id != agent_member_id
                        || run.input != input
                    {
                        return Ok(Err(ApiError::new(
                            StatusCode::CONFLICT,
                            "client_run_id idempotency conflict",
                        )));
                    }
                    return Ok(Ok((false, run)));
                }

                // Eligibility conflicts apply to a genuinely NEW run only.
                if agent.paused {
                    return Ok(Err(ApiError::new(StatusCode::CONFLICT, "agent is paused")));
                }
                let live =
                    momo_agent::live_run_count_in_tx(conn, workspace_id, agent_member_id).await?;
                // The run just inserted is itself live, so the cap compares the
                // count including it.
                if live > i64::from(agent.max_concurrent_runs) {
                    return Ok(Err(ApiError::new(
                        StatusCode::CONFLICT,
                        "agent concurrent run limit reached",
                    )));
                }

                // The job and the wake-up both go through the ONE outbox egress
                // (invariant #3), in this transaction: a job that outlived a
                // rolled-back run would be an instruction to work on nothing.
                let job_payload = work_job_payload(&WorkJob {
                    workspace_id,
                    channel_id,
                    actor_member_id,
                    agent_member_id,
                    run_id: run.id,
                    model: &agent.model,
                    input: &input,
                    idempotency_key: &trigger.idempotency_key(),
                });
                let job_id = emit_outbox(
                    &mut *conn,
                    workspace_id,
                    OutboxKind::AgentJob,
                    "gateway",
                    &job_payload,
                    Some(agent_member_id),
                )
                .await?;

                let wake = agent_job_broadcast_payload(
                    workspace_id,
                    agent_member_id,
                    job_id,
                    run.id,
                    &job_payload,
                );
                emit_outbox(
                    &mut *conn,
                    workspace_id,
                    OutboxKind::Broadcast,
                    "publish",
                    &wake,
                    Some(agent_member_id),
                )
                .await?;

                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "agent.work.queued")
                        .by(actor_member_id)
                        .about(agent_member_id)
                        .target("agent_run", run.id)
                        .via_token(via_token_id)
                        .run(run.id)
                        .with_schema(
                            "momo.agent_work.queued.v0",
                            json!({
                                "run_id": run.id.to_string(),
                                "channel_id": channel_id.to_string(),
                                "agent_member_id": agent_member_id.to_string(),
                                "client_run_id": client_run_id.to_string(),
                                "input": input,
                                "resolved_model": agent.model,
                            }),
                        ),
                )
                .await?;

                Ok(Ok((true, run)))
            })
        })
        .await,
    )?;

    let (created, run) = outcome;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(run_response(&run))))
}

/// Validate + normalize the work input (Swift `WorkRunInput.require` :1197-1205
/// and `adoptingRequestRouting` :1165-1178).
///
/// The returned value is what is stored in `agent_run.input`, which is also where
/// the ledger later reads `input.routing.effort` from — so the normalization here
/// is the same normalization the bill depends on.
fn validated_work_input(request: &CreateAgentRunRequest) -> Result<Value, ApiError> {
    let Some(object) = request.input.as_object() else {
        return Err(ApiError::bad_request(
            "agent run input must be an object with type=work",
        ));
    };
    if object.get("type").and_then(Value::as_str) != Some("work") {
        return Err(ApiError::bad_request(
            "agent run input must be an object with type=work",
        ));
    }
    if object
        .keys()
        .any(|key| !WORK_INPUT_KEYS.contains(&key.as_str()))
    {
        return Err(ApiError::bad_request("work input contains unknown fields"));
    }

    let title = required_string(object.get("title"), "title", TITLE_LIMIT)?;
    let brief = required_string(object.get("brief"), "brief", BRIEF_LIMIT)?;
    let repo = optional_string(object.get("repo"), "repo", REPO_LIMIT)?;
    let branch = optional_string(object.get("branch"), "branch", BRANCH_LIMIT)?;

    // Both spellings of the routing block are accepted, but they must AGREE — a
    // disagreement is a 400 rather than a silent winner (Swift :1169-1174). The
    // comparison is between the *validated* blocks, like Swift's
    // `existing != requestRouting`, so `HIGH` and `high` are one intent rather
    // than a conflict a client cannot see.
    let inline_routing = validated_routing(object.get("routing"))?;
    let top_routing = validated_routing(request.routing.as_ref())?;
    let routing = match (inline_routing, top_routing) {
        (Some(inline), Some(top)) if inline != top => {
            return Err(ApiError::bad_request(
                "routing conflicts with input.routing",
            ))
        }
        (Some(value), _) | (None, Some(value)) => value.json_value(),
        (None, None) => None,
    };

    let mut normalized = Map::new();
    normalized.insert("type".to_string(), json!("work"));
    normalized.insert("title".to_string(), json!(title));
    normalized.insert("brief".to_string(), json!(brief));
    if let Some(repo) = repo {
        normalized.insert("repo".to_string(), json!(repo));
    }
    if let Some(branch) = branch {
        normalized.insert("branch".to_string(), json!(branch));
    }
    if let Some(routing) = routing {
        normalized.insert("routing".to_string(), routing);
    }
    Ok(Value::Object(normalized))
}

/// Shape-only routing validation, delegated to the **shared** validator
/// (`momo_agent::routing`).
///
/// B5.3a moved this out of the file: Swift runs one `RunRoutingInput.validate`
/// over both surfaces that can start a run (`WorkRunInput.validateIfWork`
/// :1191 and `MessageRoutes.send` :46), and a per-route copy is precisely how the
/// work path and the mention path come to disagree about whether `HIGH` is a
/// level or a typo.
///
/// **Still not ported here (deviation):** `RunRoutingResolution` — the workspace
/// allowed-models gate and the profile inheritance chain. The mention path runs
/// the full chain (`momo_agent::resolve_mention_routing`); this one records an
/// explicit `model` without resolving it, so the job payload still carries the
/// agent's configured model. What is kept is the half the ledger reads: a
/// normalized `effort`, which `momo_agent::ledger_effort` later accepts only if
/// the model that actually ran supports it.
fn validated_routing(value: Option<&Value>) -> Result<Option<RequestedRouting>, ApiError> {
    momo_agent::validate_request_routing(value)
        .map_err(|invalid| ApiError::bad_request(invalid.to_string()))
}

fn required_string(value: Option<&Value>, field: &str, limit: usize) -> Result<String, ApiError> {
    let raw = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request(format!("{field} is required")))?;
    if raw.len() > limit {
        return Err(ApiError::bad_request(format!("{field} is too large")));
    }
    Ok(raw.to_string())
}

fn optional_string(
    value: Option<&Value>,
    field: &str,
    limit: usize,
) -> Result<Option<String>, ApiError> {
    let Some(value) = value else { return Ok(None) };
    if value.is_null() {
        return Ok(None);
    }
    let raw = value
        .as_str()
        .map(str::trim)
        .ok_or_else(|| ApiError::bad_request(format!("{field} must be a string")))?;
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.len() > limit {
        return Err(ApiError::bad_request(format!("{field} is too large")));
    }
    Ok(Some(raw.to_string()))
}

/// Everything the `agent_job` payload names. A struct rather than eight
/// positional arguments — five of them are `Uuid`, and a transposed pair would
/// hand a gateway the wrong run with no type error to catch it.
struct WorkJob<'a> {
    workspace_id: Uuid,
    channel_id: Uuid,
    actor_member_id: Uuid,
    agent_member_id: Uuid,
    run_id: Uuid,
    model: &'a str,
    input: &'a Value,
    idempotency_key: &'a str,
}

/// The `agent_job` payload (Swift `workJobPayload` :877-910).
///
/// `model`/`effort` are the values the adapter is told to run with, and
/// `AgentGatewayRoutes.lockGatewayRun` reads the run's own copy back at
/// completion time — so the ledger's fallback chain and this payload are two
/// views of the same decision, not two decisions.
fn work_job_payload(job: &WorkJob<'_>) -> Value {
    let mut payload = json!({
        "run_id": job.run_id.to_string(),
        "workspace_id": job.workspace_id.to_string(),
        "channel_id": job.channel_id.to_string(),
        "agent_member_id": job.agent_member_id.to_string(),
        "author_member_id": job.actor_member_id.to_string(),
        "model": job.model,
        "prompt": job.input.get("brief").and_then(Value::as_str).unwrap_or_default(),
        "input": job.input,
        "work": job.input,
        "idempotency_key": job.idempotency_key,
        "delivery": "gateway",
        "created_from": "server.agent_work.v0",
        "created_at_ms": epoch_ms(chrono::Utc::now()),
    });
    // `effort` is OMITTED rather than null when nothing was chosen (Swift :908).
    if let Some(effort) = job
        .input
        .get("routing")
        .and_then(|routing| routing.get("effort"))
        .and_then(Value::as_str)
    {
        payload["effort"] = json!(effort);
    }
    payload
}

/// The realtime wake-up (Swift `agentJobBroadcastPayload` :912-935).
///
/// It is a **notification, not the work item**: the payload carries the outbox id
/// so a gateway that receives it (or receives it twice) goes and claims the
/// durable row rather than acting on the message.
fn agent_job_broadcast_payload(
    workspace_id: Uuid,
    agent_member_id: Uuid,
    job_id: i64,
    run_id: Uuid,
    job_payload: &Value,
) -> Value {
    let channel = format!(
        "agentwork:ws{}.{}",
        workspace_id.to_string().to_uppercase(),
        agent_member_id.to_string().to_uppercase()
    );
    let mut payload = job_payload.clone();
    payload["agent_job_outbox_id"] = json!(job_id);
    json!({
        "channel": channel,
        "data": {
            "type": "agent.job",
            "v": 1,
            "ts": epoch_ms(chrono::Utc::now()),
            "seq": job_id,
            "payload": payload,
        },
        "version": job_id,
        "idempotency_key": format!("{channel}:agent_job:{}", run_id.to_string().to_uppercase()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(input: Value, routing: Option<Value>) -> CreateAgentRunRequest {
        CreateAgentRunRequest {
            agent_member_id: Uuid::from_u128(1),
            client_run_id: Uuid::from_u128(2),
            input,
            routing,
        }
    }

    #[test]
    fn a_work_input_is_normalized_to_the_stored_shape() {
        let stored = validated_work_input(&request(
            json!({"type": "work", "title": "  ship it  ", "brief": "do the thing",
                   "repo": "momo", "branch": ""}),
            None,
        ))
        .expect("a valid work input");
        assert_eq!(stored["title"], json!("ship it"), "values are trimmed");
        assert_eq!(stored["repo"], json!("momo"));
        assert!(
            stored.get("branch").is_none(),
            "an empty optional is omitted, not stored as \"\""
        );
    }

    /// The closed world, which is what makes a typo visible instead of ignored.
    #[test]
    fn unknown_input_fields_are_rejected() {
        let error = validated_work_input(&request(
            json!({"type": "work", "title": "t", "brief": "b", "priority": "high"}),
            None,
        ))
        .expect_err("unknown field");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(error.message, "work input contains unknown fields");
    }

    #[test]
    fn a_non_work_input_is_refused() {
        for input in [
            json!({"type": "mention", "prompt": "hi"}),
            json!({"title": "t", "brief": "b"}),
            json!("just a string"),
        ] {
            assert_eq!(
                validated_work_input(&request(input, None))
                    .expect_err("not a work input")
                    .message,
                "agent run input must be an object with type=work"
            );
        }
    }

    #[test]
    fn required_fields_are_required() {
        for input in [
            json!({"type": "work", "brief": "b"}),
            json!({"type": "work", "title": "   ", "brief": "b"}),
            json!({"type": "work", "title": "t"}),
        ] {
            assert_eq!(
                validated_work_input(&request(input, None))
                    .expect_err("missing required")
                    .status,
                StatusCode::BAD_REQUEST
            );
        }
        let long = "x".repeat(TITLE_LIMIT + 1);
        assert_eq!(
            validated_work_input(&request(
                json!({"type": "work", "title": long, "brief": "b"}),
                None
            ))
            .expect_err("too long")
            .message,
            "title is too large"
        );
    }

    /// Two spellings, one meaning — and a disagreement is never silently resolved.
    #[test]
    fn the_two_routing_spellings_must_agree() {
        let base = json!({"type": "work", "title": "t", "brief": "b"});

        let top_level =
            validated_work_input(&request(base.clone(), Some(json!({"effort": "HIGH"}))))
                .expect("top-level routing is adopted");
        assert_eq!(
            top_level["routing"]["effort"],
            json!("high"),
            "the effort the ledger will read is normalized at write time"
        );

        let mut inline = base.as_object().unwrap().clone();
        inline.insert("routing".to_string(), json!({"effort": "low"}));
        let conflict = validated_work_input(&request(
            Value::Object(inline.clone()),
            Some(json!({"effort": "max"})),
        ))
        .expect_err("a conflict is a 400");
        assert_eq!(conflict.message, "routing conflicts with input.routing");

        // Agreeing spellings are fine.
        assert!(validated_work_input(&request(
            Value::Object(inline),
            Some(json!({"effort": "low"}))
        ))
        .is_ok());
    }

    #[test]
    fn routing_is_closed_world_and_effort_must_be_a_known_level() {
        let base = json!({"type": "work", "title": "t", "brief": "b"});
        assert_eq!(
            validated_work_input(&request(base.clone(), Some(json!({"temperature": 0.7}))))
                .expect_err("unknown routing key")
                .message,
            "routing contains unknown fields"
        );
        assert!(
            validated_work_input(&request(base.clone(), Some(json!({"effort": "ludicrous"}))))
                .is_err(),
            "an unknown effort level must not reach usage_ledger.effort"
        );
        assert!(validated_work_input(&request(
            base,
            Some(json!({"model": "hermes-fast", "effort": "low"}))
        ))
        .is_ok());
    }

    /// `effort` is omitted rather than null when nothing was chosen, so an
    /// adapter reading `payload.effort` sees "absent", not "explicitly nothing".
    #[test]
    fn the_job_payload_omits_an_absent_effort() {
        let input = json!({"type": "work", "title": "t", "brief": "b"});
        let payload = work_job_payload(&WorkJob {
            workspace_id: Uuid::from_u128(1),
            channel_id: Uuid::from_u128(2),
            actor_member_id: Uuid::from_u128(3),
            agent_member_id: Uuid::from_u128(4),
            run_id: Uuid::from_u128(5),
            model: "hermes-agent",
            input: &input,
            idempotency_key: "work:key",
        });
        assert!(payload.get("effort").is_none());
        assert_eq!(payload["delivery"], json!("gateway"));
        assert_eq!(payload["prompt"], json!("b"));

        let with_effort = json!({"type": "work", "title": "t", "brief": "b",
                                 "routing": {"effort": "high"}});
        let payload = work_job_payload(&WorkJob {
            workspace_id: Uuid::from_u128(1),
            channel_id: Uuid::from_u128(2),
            actor_member_id: Uuid::from_u128(3),
            agent_member_id: Uuid::from_u128(4),
            run_id: Uuid::from_u128(5),
            model: "hermes-agent",
            input: &with_effort,
            idempotency_key: "work:key",
        });
        assert_eq!(payload["effort"], json!("high"));
    }

    /// The wake-up must name the durable row, or a gateway would have to trust
    /// the notification's contents.
    #[test]
    fn the_wake_up_carries_the_outbox_id() {
        let job = json!({"run_id": "r"});
        let wake = agent_job_broadcast_payload(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            77,
            Uuid::from_u128(5),
            &job,
        );
        assert_eq!(wake["data"]["payload"]["agent_job_outbox_id"], json!(77));
        assert_eq!(wake["data"]["type"], json!("agent.job"));
        assert_eq!(wake["version"], json!(77));
        assert!(wake["channel"]
            .as_str()
            .unwrap()
            .starts_with("agentwork:ws"));
    }
}
