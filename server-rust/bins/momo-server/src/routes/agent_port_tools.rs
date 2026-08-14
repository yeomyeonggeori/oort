//! The Agent Port's eight product tools (ADR-0162 D3/D6, HAP-E5).
//!
//! `momo-mcp` decides what a credential may see and call; **this module is the
//! typed domain port it is handed**, and it is the whole reason the protocol
//! crate can stay free of SQL. Every method below is thin binding:
//!
//! | tool | the existing thing it calls |
//! |---|---|
//! | `oort_inbox_read` | `momo_messaging::list_hosted_inbox_in_tx` (HAP-E4) |
//! | `oort_conversation_read` | `momo_messaging::list_channel_page` — the REST history's own read |
//! | `oort_message_post` | `momo_messaging::send_message_with_mentions_in_tx` — the REST send's own transaction |
//! | `oort_jobs_claim` | `momo_outbox::claim_hosted_gateway_jobs_in_tx` — the gateway claim, hosted branch |
//! | `oort_job_renew` / `oort_job_release` | `momo_outbox`'s existing lease verbs, unchanged |
//! | `oort_run_event` | `routes::agent_gateway::record_gateway_event_in_tx` |
//! | `oort_run_complete` | `routes::agent_gateway::complete_gateway_run_in_tx` |
//!
//! There is **no SQL in this file** beyond what those functions own, no second
//! message or job ledger, and no Centrifugo publish: a hosted answer reaches a
//! channel through the same outbox row a human's message does.
//!
//! ## Authority is re-proved inside every transaction
//!
//! The transport authenticated the bearer, and `tools/list` was built from a
//! connection snapshot. Neither is carried into the write: each tool opens its
//! own tenant transaction and calls
//! [`momo_auth::resolve_hosted_tool_identity_in_tx`] again, so a revoke, a
//! pause, a membership removal or a scope narrowing that commits between the
//! listing and the call lands on the closed side.
//!
//! ## Nothing internal crosses the wire
//!
//! A client never receives a job id, a lease owner, a run id, an inbox
//! sequence, or a raw cursor position. Job authority travels as a sealed
//! [`momo_mcp::LeaseHandle`]; inbox position travels as HAP-E4's sealed cursor.
//! Failures are the five fixed [`ToolFailure`] answers, so a refusal never
//! confirms which of "absent", "invisible" and "forbidden" it was.

use axum::http::StatusCode;
use momo_auth::{HostedToolIdentity, Principal};
use momo_db::{DbError, PgConnection, PgPool};
use momo_mcp::{
    decode_lease_handle, encode_lease_handle, LeaseHandle, ToolCall, ToolCapability, ToolFailure,
    ToolView,
};
use momo_messaging::{
    clamp_history_limit, is_channel_member, list_channel_page, list_hosted_inbox_in_tx,
    validate_quote_target_in_tx, validate_thread_root_in_tx, HistoryCursor, MessageType,
    NewMessage, SendExtras, HOSTED_INBOX_LIMIT_DEFAULT,
};
use momo_outbox::GatewayLeaseBinding;
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::error::ApiError;
use crate::routes::agent_gateway::{
    complete_gateway_run_in_tx, record_gateway_event_in_tx, sanitized_gateway_error,
    validated_event_fields, GatewayCompleteInput, GatewayEventInput,
};
use crate::routes::agent_mentions::{route_agent_mentions_in_tx, MentionSend};
use crate::AppState;

/// What the transport proved before a tool ran.
#[derive(Debug, Clone, Copy)]
pub(crate) struct HostedCaller {
    pub workspace_id: Uuid,
    pub agent_member_id: Uuid,
    pub token_id: Uuid,
}

impl HostedCaller {
    /// `None` for any principal that is not an agent bearer carrying a token id
    /// — which is every credential class the Agent Port already refuses, so this
    /// is a type-level restatement rather than a second gate.
    pub fn from_principal(principal: &Principal) -> Option<HostedCaller> {
        if principal.kind != momo_auth::PrincipalKind::Agent {
            return None;
        }
        Some(HostedCaller {
            workspace_id: principal.workspace_id,
            agent_member_id: principal.member_id,
            token_id: principal.token_id?,
        })
    }
}

/// Read the caller's live connection and turn it into the request's tool view.
///
/// A caller with no live connection — a pairing credential, an expired or
/// revoked one, a paused agent — gets [`ToolView::empty`], which is exactly what
/// a connect-only credential gets: an empty `tools/list` and an unknown-tool
/// answer for every call.
pub(crate) async fn tool_view_for(state: &AppState, caller: HostedCaller) -> ToolView {
    match hosted_identity(&state.pool, caller).await {
        Ok(Some(identity)) => ToolView::intersect(
            &identity.approved_scopes,
            &identity.token_scopes,
            ToolCapability::FULL,
        ),
        Ok(None) => ToolView::empty(),
        Err(error) => {
            // Never the raw error at the boundary, and never the bearer: this
            // fixed context plus the typed DB error is enough to separate a
            // pool failure from a query failure while the client only learns
            // that it may call nothing.
            tracing::error!(
                error = %error,
                route = "/v1/mcp/agent-port",
                "Agent Port tool view resolution failed"
            );
            ToolView::empty()
        }
    }
}

async fn hosted_identity(
    pool: &PgPool,
    caller: HostedCaller,
) -> Result<Option<HostedToolIdentity>, DbError> {
    momo_db::with_tenant_tx(pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            momo_auth::resolve_hosted_tool_identity_in_tx(
                conn,
                caller.workspace_id,
                caller.agent_member_id,
                caller.token_id,
            )
            .await
            .map_err(DbError::from)
        })
    })
    .await
}

/// Run one admitted tool call and answer on the wire.
///
/// The status and the body are built from **one** verdict, in one place, so a
/// 200 can never carry an error envelope (or the reverse).
pub(crate) async fn execute(
    state: &AppState,
    caller: HostedCaller,
    call: ToolCall,
) -> momo_mcp::HttpResponse {
    let result = match call.tool.name {
        momo_mcp::TOOL_INBOX_READ => inbox_read(state, caller, &call.arguments).await,
        momo_mcp::TOOL_CONVERSATION_READ => conversation_read(state, caller, &call.arguments).await,
        momo_mcp::TOOL_MESSAGE_POST => message_post(state, caller, &call.arguments).await,
        momo_mcp::TOOL_JOBS_CLAIM => jobs_claim(state, caller, &call.arguments).await,
        momo_mcp::TOOL_JOB_RENEW => {
            job_lease(state, caller, &call.arguments, LeaseVerb::Renew).await
        }
        momo_mcp::TOOL_JOB_RELEASE => {
            job_lease(state, caller, &call.arguments, LeaseVerb::Release).await
        }
        momo_mcp::TOOL_RUN_EVENT => run_event(state, caller, &call.arguments).await,
        momo_mcp::TOOL_RUN_COMPLETE => run_complete(state, caller, &call.arguments).await,
        _ => Err(ToolFailure::InvalidArguments),
    };
    match result {
        Ok(structured) => momo_mcp::tool_success(&call, structured),
        Err(failure) => momo_mcp::tool_failure(&call, failure),
    }
}

// ---------------------------------------------------------------------------
// argument readers — every one of them fail-closed on shape
// ---------------------------------------------------------------------------

fn arguments(value: &Value) -> Result<&Map<String, Value>, ToolFailure> {
    value.as_object().ok_or(ToolFailure::InvalidArguments)
}

fn optional_uuid(args: &Map<String, Value>, key: &str) -> Result<Option<Uuid>, ToolFailure> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(raw)) => Uuid::parse_str(raw)
            .map(Some)
            .map_err(|_| ToolFailure::InvalidArguments),
        Some(_) => Err(ToolFailure::InvalidArguments),
    }
}

fn required_uuid(args: &Map<String, Value>, key: &str) -> Result<Uuid, ToolFailure> {
    optional_uuid(args, key)?.ok_or(ToolFailure::InvalidArguments)
}

fn optional_i64(args: &Map<String, Value>, key: &str) -> Result<Option<i64>, ToolFailure> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_i64()
            .map(Some)
            .ok_or(ToolFailure::InvalidArguments),
        Some(_) => Err(ToolFailure::InvalidArguments),
    }
}

fn optional_str<'a>(
    args: &'a Map<String, Value>,
    key: &str,
    max_bytes: usize,
) -> Result<Option<&'a str>, ToolFailure> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(raw)) if raw.len() <= max_bytes => Ok(Some(raw.as_str())),
        Some(_) => Err(ToolFailure::InvalidArguments),
    }
}

fn required_str<'a>(
    args: &'a Map<String, Value>,
    key: &str,
    max_bytes: usize,
) -> Result<&'a str, ToolFailure> {
    optional_str(args, key, max_bytes)?
        .filter(|value| !value.is_empty())
        .ok_or(ToolFailure::InvalidArguments)
}

/// A domain refusal → its wire answer.
///
/// The mapping is by status, not by message, because the messages are written
/// for humans reading an API and this surface must not hand a hosted adapter a
/// sentence that answers a question it was not allowed to ask.
fn failure_of(error: &ApiError) -> ToolFailure {
    match error.status {
        StatusCode::BAD_REQUEST => ToolFailure::InvalidArguments,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ToolFailure::NotAuthorized,
        StatusCode::NOT_FOUND => ToolFailure::Unavailable,
        StatusCode::CONFLICT => ToolFailure::Conflict,
        _ => ToolFailure::Internal,
    }
}

/// A transaction failure → `Internal`, with the cause logged and nothing about
/// it on the wire.
fn internal(context: &str, error: DbError) -> ToolFailure {
    tracing::error!(error = %error, context, "Agent Port tool transaction failed");
    ToolFailure::Internal
}

fn has_scope(identity: &HostedToolIdentity, scope: &str) -> bool {
    identity.token_scopes.iter().any(|value| value == scope)
        && identity.approved_scopes.iter().any(|value| value == scope)
}

/// Re-prove the connection inside the caller's own transaction and require one
/// scope on both halves of the intersection.
async fn authorize_in_tx(
    conn: &mut PgConnection,
    caller: HostedCaller,
    scope: &str,
) -> Result<Result<HostedToolIdentity, ToolFailure>, DbError> {
    let identity = momo_auth::resolve_hosted_tool_identity_in_tx(
        conn,
        caller.workspace_id,
        caller.agent_member_id,
        caller.token_id,
    )
    .await
    .map_err(DbError::from)?;
    let Some(identity) = identity else {
        return Ok(Err(ToolFailure::NotAuthorized));
    };
    if !has_scope(&identity, scope) {
        return Ok(Err(ToolFailure::NotAuthorized));
    }
    Ok(Ok(identity))
}

// ---------------------------------------------------------------------------
// oort_inbox_read
// ---------------------------------------------------------------------------

async fn inbox_read(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let cursor = optional_str(args, "cursor", 512)?.map(str::to_string);
    let limit = optional_i64(args, "limit")?.unwrap_or(HOSTED_INBOX_LIMIT_DEFAULT);
    let secret = state.agent_port.envelope_secret().to_string();

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_AGENT_INBOX_READ).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            let page = list_hosted_inbox_in_tx(
                conn,
                caller.workspace_id,
                caller.agent_member_id,
                identity.connection_id,
                cursor.as_deref(),
                limit,
                &secret,
            )
            .await?;
            // HAP-E4 answers a stale, forged or foreign cursor with the same
            // `Unavailable` an inactive connection gets. That is deliberate and
            // it is also the cursor-secret rotation contract: an agent whose
            // cursor stops opening must re-establish, never silently restart
            // from the beginning and replay the whole ledger.
            Ok(page.map_err(|_| ToolFailure::Unavailable))
        })
    })
    .await
    .map_err(|error| internal("agent_port.inbox_read", error))?;

    let page = outcome?;
    let events: Vec<Value> = page
        .events
        .iter()
        .map(|event| {
            let mut projected = Map::new();
            projected.insert("kind".into(), json!(event.event_kind));
            if let Some(channel_id) = event.source_channel_id {
                projected.insert("channelId".into(), json!(channel_id));
            }
            if let Some(message_id) = event.source_message_id {
                projected.insert("messageId".into(), json!(message_id));
            }
            if let Some(seq) = event.source_message_seq {
                projected.insert("messageSeq".into(), json!(seq));
            }
            // `source_outbox_id` and `inbox_seq` are deliberately absent: the
            // first is a job row id (lease internals) and the second is the
            // connection-local sequence the opaque cursor exists to hide.
            Value::Object(projected)
        })
        .collect();
    Ok(json!({
        "events": events,
        "nextCursor": page.next_cursor,
        "hasMore": page.has_more,
    }))
}

// ---------------------------------------------------------------------------
// oort_conversation_read
// ---------------------------------------------------------------------------

async fn conversation_read(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let channel_id = required_uuid(args, "channelId")?;
    let before = optional_i64(args, "before")?;
    let after = optional_i64(args, "after")?;
    let limit = clamp_history_limit(optional_i64(args, "limit")?);
    let cursor = HistoryCursor::from_query(before, after);

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_MESSAGES_READ).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            // Two independent gates, one answer. A channel outside the human's
            // approval and a channel the agent is not a member of are both
            // `Unavailable`, and so is a channel that does not exist — the read
            // must not become a workspace directory.
            if !identity.approved_channel_ids.contains(&channel_id)
                || !is_channel_member(conn, channel_id, caller.agent_member_id).await?
            {
                return Ok(Err(ToolFailure::Unavailable));
            }
            let page = list_channel_page(conn, channel_id, cursor, limit).await?;
            Ok(Ok(page))
        })
    })
    .await
    .map_err(|error| internal("agent_port.conversation_read", error))?;

    let page = outcome?;
    let messages: Vec<Value> = page
        .iter()
        .map(|paged| {
            let message = &paged.message;
            json!({
                "id": message.id,
                "seq": message.seq,
                "channelId": message.channel_id,
                "authorMemberId": message.author_member_id,
                "type": message.message_type.as_db_label(),
                "state": message.state,
                "body": message.body,
                "rootId": message.root_id,
                "replyToId": message.reply_to_id,
                "createdAtMs": crate::routes::shared::epoch_ms(message.created_at),
            })
        })
        .collect();
    let next_before = page.iter().map(|paged| paged.message.seq).min();
    Ok(json!({"messages": messages, "nextBefore": next_before}))
}

// ---------------------------------------------------------------------------
// oort_message_post
// ---------------------------------------------------------------------------

async fn message_post(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let channel_id = required_uuid(args, "channelId")?;
    let client_msg_id = required_uuid(args, "clientMsgId")?;
    let body = required_str(args, "body", 8_000)?.to_string();
    let root_id = optional_uuid(args, "rootId")?;
    let reply_to_id = optional_uuid(args, "replyToId")?;
    let mention_body = body.clone();
    let gateway_enabled = state.agent_gateway.enabled();
    let hosted_delivery_enabled = state.agent_port.config.hosted_delivery_enabled;
    let context_max_messages = state.mentions.context_max_messages;

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_MESSAGES_WRITE).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            if !identity.approved_channel_ids.contains(&channel_id)
                || !is_channel_member(conn, channel_id, caller.agent_member_id).await?
            {
                return Ok(Err(ToolFailure::Unavailable));
            }
            if let Some(root_id) = root_id {
                if validate_thread_root_in_tx(conn, channel_id, root_id)
                    .await?
                    .is_err()
                {
                    return Ok(Err(ToolFailure::InvalidArguments));
                }
            }
            if let Some(reply_to_id) = reply_to_id {
                if validate_quote_target_in_tx(conn, channel_id, reply_to_id)
                    .await?
                    .is_err()
                {
                    return Ok(Err(ToolFailure::InvalidArguments));
                }
            }

            // THE send transaction — the same function `routes::messages::send`
            // calls, so `channel_seq`, the `client_msg_id` unique index, the
            // message INSERT and the outbox INSERT are one implementation. No
            // attachment, signature or stream-open surface is exposed here;
            // that is a narrowing of one path, not a second one.
            let sent = momo_messaging::send_message_with_mentions_in_tx(
                conn,
                caller.workspace_id,
                NewMessage {
                    channel_id,
                    author_member_id: caller.agent_member_id,
                    message_type: MessageType::Text,
                    body: Some(body),
                    props: json!({}),
                    root_id,
                    reply_to_id,
                    client_msg_id: Some(client_msg_id),
                    run_id: None,
                    hlc_ts: None,
                    hlc_count: None,
                },
                SendExtras {
                    signature: None,
                    attachment_ids: &[],
                    via_token_id: Some(caller.token_id),
                    opens_stream: false,
                },
            )
            .await?;
            let sent = match sent {
                Ok(sent) => sent,
                Err(_) => return Ok(Err(ToolFailure::Conflict)),
            };

            // The mention pass, exactly as the REST send runs it and with the
            // same `author_is_agent` verdict — so an agent-authored mention is
            // still skipped and audited rather than starting an uncapped A2A
            // hop. Skipped entirely on a deduped retry, like REST.
            if !sent.deduped {
                if let Err(rejection) = route_agent_mentions_in_tx(
                    conn,
                    MentionSend {
                        workspace_id: caller.workspace_id,
                        channel_id,
                        message_id: sent.message.id,
                        message_seq: sent.message.seq,
                        author_member_id: caller.agent_member_id,
                        author_is_agent: true,
                        body: &mention_body,
                        hlc_ts: sent.message.hlc_ts,
                        via_token_id: Some(caller.token_id),
                        gateway_enabled,
                        hosted_delivery_enabled,
                        context_max_messages,
                        routing: None,
                    },
                )
                .await?
                {
                    return Ok(Err(failure_of(&rejection)));
                }
            }
            Ok(Ok((sent.message.id, sent.message.seq, sent.deduped)))
        })
    })
    .await
    .map_err(|error| internal("agent_port.message_post", error))?;

    let (message_id, seq, deduped) = outcome?;
    Ok(json!({"messageId": message_id, "seq": seq, "deduplicated": deduped}))
}

// ---------------------------------------------------------------------------
// oort_jobs_claim
// ---------------------------------------------------------------------------

/// The job payload projection a hosted adapter receives.
///
/// A whitelist, not a redaction pass: the payload is server-composed and will
/// grow keys, and an allow-list means a new one has to be *added* here before it
/// can reach a client. `run_id` is deliberately absent — the run identity lives
/// inside the sealed handle, which is what makes the handle the only way to act
/// on the work.
fn projected_job_payload(payload: &Value) -> Value {
    let mut projected = Map::new();
    for (source, target) in [
        ("channel_id", "channelId"),
        ("author_member_id", "authorMemberId"),
        ("trigger_message_id", "triggerMessageId"),
        ("trigger_message_seq", "triggerMessageSeq"),
        ("model", "model"),
        ("effort", "effort"),
        ("prompt", "prompt"),
        ("system_prompt", "systemPrompt"),
        ("recent_messages", "recentMessages"),
        ("tools", "tools"),
        ("enabled_tools", "enabledTools"),
        ("max_output_tokens", "maxOutputTokens"),
        ("created_at_ms", "createdAtMs"),
    ] {
        if let Some(value) = payload.get(source) {
            projected.insert(target.to_string(), value.clone());
        }
    }
    Value::Object(projected)
}

async fn jobs_claim(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let limit = momo_outbox::clamp_claim_limit(optional_i64(args, "limit")?);
    let secret = state.agent_port.envelope_secret().to_string();

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_AGENT_JOBS_READ).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            let claimed = momo_outbox::claim_hosted_gateway_jobs_in_tx(
                conn,
                caller.workspace_id,
                caller.agent_member_id,
                identity.connection_id,
                limit,
            )
            .await
            .map_err(DbError::from)?;

            let mut jobs = Vec::with_capacity(claimed.len());
            for job in claimed {
                // A job whose payload has no parseable run id cannot be acted
                // on through this surface (every later verb is keyed by run),
                // so it is left unreported rather than handed over as an
                // unusable handle. Its lease expires on its own.
                let Ok(run_id) = Uuid::parse_str(job.run_id_field()) else {
                    continue;
                };
                let handle = encode_lease_handle(
                    LeaseHandle {
                        workspace_id: caller.workspace_id,
                        agent_member_id: caller.agent_member_id,
                        connection_id: identity.connection_id,
                        run_id,
                        job_id: job.id,
                        lease_id: job.lease_id,
                    },
                    &secret,
                )
                .map_err(|_| {
                    DbError::Sqlx(momo_db::sqlx::Error::Protocol(
                        "lease handle issuance failed".into(),
                    ))
                })?;
                jobs.push(json!({
                    "leaseHandle": handle,
                    "createdAtMs": crate::routes::shared::epoch_ms(job.created_at),
                    "leaseExpiresAtMs": crate::routes::shared::epoch_ms(job.lease_expires_at),
                    "work": projected_job_payload(&job.payload),
                }));
            }
            Ok(Ok(jobs))
        })
    })
    .await
    .map_err(|error| internal("agent_port.jobs_claim", error))?;

    Ok(json!({"jobs": outcome?}))
}

// ---------------------------------------------------------------------------
// oort_job_renew / oort_job_release
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LeaseVerb {
    Renew,
    Release,
}

/// Open a handle and prove it belongs to **this** caller and connection.
///
/// The binding lives inside the sealed plaintext, so a handle stolen from
/// another connection fails here — before any lease statement runs and without
/// telling the caller whether that job exists.
fn bound_handle(
    identity: &HostedToolIdentity,
    caller: HostedCaller,
    raw: &str,
    secret: &str,
) -> Result<LeaseHandle, ToolFailure> {
    let handle = decode_lease_handle(raw, secret).map_err(|_| ToolFailure::NotAuthorized)?;
    if handle.workspace_id != caller.workspace_id
        || handle.agent_member_id != caller.agent_member_id
        || handle.connection_id != identity.connection_id
    {
        return Err(ToolFailure::NotAuthorized);
    }
    Ok(handle)
}

async fn job_lease(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
    verb: LeaseVerb,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let raw_handle = required_str(args, "leaseHandle", 512)?.to_string();
    let secret = state.agent_port.envelope_secret().to_string();

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_AGENT_JOBS_READ).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            let handle = match bound_handle(&identity, caller, &raw_handle, &secret) {
                Ok(handle) => handle,
                Err(failure) => return Ok(Err(failure)),
            };
            let lease = GatewayLeaseBinding {
                job_id: handle.job_id,
                lease_id: handle.lease_id,
            };
            match verb {
                LeaseVerb::Renew => {
                    let expires = momo_outbox::renew_gateway_lease_in_tx(
                        conn,
                        caller.workspace_id,
                        caller.agent_member_id,
                        lease,
                    )
                    .await
                    .map_err(DbError::from)?;
                    Ok(match expires {
                        Some(expires) => Ok(json!({
                            "status": "renewed",
                            "leaseExpiresAtMs": crate::routes::shared::epoch_ms(expires)
                        })),
                        None => Err(ToolFailure::Conflict),
                    })
                }
                LeaseVerb::Release => {
                    let released = momo_outbox::release_gateway_lease_in_tx(
                        conn,
                        caller.workspace_id,
                        caller.agent_member_id,
                        lease,
                    )
                    .await
                    .map_err(DbError::from)?;
                    Ok(if released {
                        Ok(json!({"status": "released"}))
                    } else {
                        Err(ToolFailure::Conflict)
                    })
                }
            }
        })
    })
    .await
    .map_err(|error| internal("agent_port.job_lease", error))?;

    outcome
}

// ---------------------------------------------------------------------------
// oort_run_event / oort_run_complete
// ---------------------------------------------------------------------------

async fn run_event(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let raw_handle = required_str(args, "leaseHandle", 512)?.to_string();
    let (status, detail, text_delta) = validated_event_fields(
        optional_str(args, "status", 64)?,
        optional_str(args, "detail", 4_096)?,
        optional_str(args, "textDelta", 16_384)?,
    )
    .map_err(|error| failure_of(&error))?;
    let event_id = optional_uuid(args, "eventId")?.unwrap_or_else(Uuid::new_v4);
    let secret = state.agent_port.envelope_secret().to_string();

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_AGENT_RUNS_CALLBACK).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            let handle = match bound_handle(&identity, caller, &raw_handle, &secret) {
                Ok(handle) => handle,
                Err(failure) => return Ok(Err(failure)),
            };
            let recorded = record_gateway_event_in_tx(
                conn,
                caller.workspace_id,
                GatewayEventInput {
                    run_id: handle.run_id,
                    lease: GatewayLeaseBinding {
                        job_id: handle.job_id,
                        lease_id: handle.lease_id,
                    },
                    status,
                    detail,
                    text_delta,
                    event_id,
                    actor_member_id: Some(caller.agent_member_id),
                    via_token_id: Some(caller.token_id),
                },
            )
            .await?;
            Ok(recorded.map_err(|error| failure_of(&error)))
        })
    })
    .await
    .map_err(|error| internal("agent_port.run_event", error))?;

    outcome?;
    Ok(json!({"status": "accepted"}))
}

async fn run_complete(
    state: &AppState,
    caller: HostedCaller,
    arguments_value: &Value,
) -> Result<Value, ToolFailure> {
    let args = arguments(arguments_value)?;
    let raw_handle = required_str(args, "leaseHandle", 512)?.to_string();
    let status = required_str(args, "status", 32)?;
    let error_text = optional_str(args, "error", 4_000)?;
    let succeeded = momo_agent::completion_status(Some(status), error_text)
        .map_err(|_| ToolFailure::InvalidArguments)?;
    // Redacted here, before the text can reach `message.body` and be broadcast
    // to every member of the channel — the same call the REST callback makes.
    let safe_error = sanitized_gateway_error(error_text, &state.agent_gateway.secret);
    let body = optional_str(args, "body", 8_000)?.map(str::to_string);
    let (usage, usage_detail) = usage_from_arguments(args)?;
    let secret = state.agent_port.envelope_secret().to_string();

    let outcome = momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
        Box::pin(async move {
            let identity =
                match authorize_in_tx(conn, caller, momo_auth::SCOPE_AGENT_RUNS_CALLBACK).await? {
                    Ok(identity) => identity,
                    Err(failure) => return Ok(Err(failure)),
                };
            let handle = match bound_handle(&identity, caller, &raw_handle, &secret) {
                Ok(handle) => handle,
                Err(failure) => return Ok(Err(failure)),
            };
            let completed = complete_gateway_run_in_tx(
                conn,
                caller.workspace_id,
                GatewayCompleteInput {
                    run_id: handle.run_id,
                    lease: GatewayLeaseBinding {
                        job_id: handle.job_id,
                        lease_id: handle.lease_id,
                    },
                    succeeded,
                    body,
                    safe_error,
                    usage,
                    usage_detail,
                    actor_member_id: Some(caller.agent_member_id),
                    via_token_id: Some(caller.token_id),
                },
            )
            .await?;
            Ok(completed.map_err(|error| failure_of(&error)))
        })
    })
    .await
    .map_err(|error| internal("agent_port.run_complete", error))?;

    let (message_id, seq, status) = outcome?;
    Ok(json!({"status": status, "messageId": message_id, "seq": seq}))
}

/// One reported token count. `i32` is the ledger's own width, so a value that
/// does not fit is a bad argument here rather than a silent truncation in the
/// row that gets billed.
fn bounded_token_count(usage: &Map<String, Value>, key: &str) -> Result<Option<i32>, ToolFailure> {
    match optional_i64(usage, key)? {
        None => Ok(None),
        Some(value) => i32::try_from(value)
            .map(Some)
            .map_err(|_| ToolFailure::InvalidArguments),
    }
}

/// The reported usage block, in the same two shapes the REST callback produces:
/// the resolver's input and the verbatim echo written to props/output/audit.
#[allow(clippy::type_complexity)]
fn usage_from_arguments(
    args: &Map<String, Value>,
) -> Result<(Option<momo_agent::RunUsageReport>, Option<Value>), ToolFailure> {
    let Some(usage) = args.get("usage") else {
        return Ok((None, None));
    };
    if usage.is_null() {
        return Ok((None, None));
    }
    let usage = usage.as_object().ok_or(ToolFailure::InvalidArguments)?;
    let report = momo_agent::RunUsageReport {
        model: optional_str(usage, "model", 128)?.map(str::to_string),
        effort: optional_str(usage, "effort", 32)?.map(str::to_string),
        prompt_tokens: bounded_token_count(usage, "promptTokens")?,
        completion_tokens: bounded_token_count(usage, "completionTokens")?,
        cached_tokens: bounded_token_count(usage, "cachedTokens")?,
        reasoning_tokens: bounded_token_count(usage, "reasoningTokens")?,
        cost_micro_usd: None,
        was_estimated: None,
    };
    let detail = json!({
        "model": report.model,
        "effort": report.effort,
        "prompt_tokens": report.prompt_tokens,
        "completion_tokens": report.completion_tokens,
        "cached_tokens": report.cached_tokens,
        "reasoning_tokens": report.reasoning_tokens,
        "cost_micro_usd": Value::Null,
        "was_estimated": Value::Null,
    });
    Ok((Some(report), Some(detail)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_job_projection_is_an_allow_list_that_hides_the_run() {
        let payload = json!({
            "run_id": "5B1F4A2E-0000-4000-8000-000000000001",
            "workspace_id": "5B1F4A2E-0000-4000-8000-000000000002",
            "agent_member_id": "5B1F4A2E-0000-4000-8000-000000000003",
            "channel_id": "5B1F4A2E-0000-4000-8000-000000000004",
            "prompt": "hello",
            "delivery": "gateway",
            "step_count": 0,
            "future_secret_looking_key": "momo_agent_v1.leak"
        });
        let projected = projected_job_payload(&payload);
        assert_eq!(
            projected["channelId"],
            json!("5B1F4A2E-0000-4000-8000-000000000004")
        );
        assert_eq!(projected["prompt"], json!("hello"));
        for hidden in [
            "runId",
            "run_id",
            "delivery",
            "step_count",
            "future_secret_looking_key",
            "agent_member_id",
        ] {
            assert!(projected.get(hidden).is_none(), "{hidden}");
        }
        assert!(!projected.to_string().contains("momo_agent_v1"));
    }

    #[test]
    fn a_domain_status_maps_onto_one_of_the_five_wire_failures() {
        for (status, expected) in [
            (StatusCode::BAD_REQUEST, ToolFailure::InvalidArguments),
            (StatusCode::UNAUTHORIZED, ToolFailure::NotAuthorized),
            (StatusCode::FORBIDDEN, ToolFailure::NotAuthorized),
            (StatusCode::NOT_FOUND, ToolFailure::Unavailable),
            (StatusCode::CONFLICT, ToolFailure::Conflict),
            (StatusCode::INTERNAL_SERVER_ERROR, ToolFailure::Internal),
            (StatusCode::IM_A_TEAPOT, ToolFailure::Internal),
        ] {
            assert_eq!(
                failure_of(&ApiError::new(status, "a message a client must never read")),
                expected,
                "{status}"
            );
        }
    }

    #[test]
    fn argument_readers_refuse_every_wrong_shape() {
        let args = json!({
            "channelId": "not-a-uuid",
            "limit": "12",
            "body": 7,
            "ok": "5b1f4a2e-0000-4000-8000-000000000001"
        });
        let args = args.as_object().unwrap();
        assert_eq!(
            required_uuid(args, "channelId"),
            Err(ToolFailure::InvalidArguments)
        );
        assert_eq!(
            required_uuid(args, "missing"),
            Err(ToolFailure::InvalidArguments)
        );
        assert_eq!(
            optional_i64(args, "limit"),
            Err(ToolFailure::InvalidArguments)
        );
        assert_eq!(optional_i64(args, "absent"), Ok(None));
        assert_eq!(
            required_str(args, "body", 10),
            Err(ToolFailure::InvalidArguments)
        );
        assert!(required_uuid(args, "ok").is_ok());
        assert_eq!(
            optional_str(args, "ok", 4),
            Err(ToolFailure::InvalidArguments),
            "a byte ceiling is enforced before the value is used"
        );
        assert_eq!(arguments(&json!([])), Err(ToolFailure::InvalidArguments));
    }

    /// A handle is only usable by the identity it was minted for. Each of the
    /// three axes alone is enough to refuse it, and the refusal is the same
    /// `NotAuthorized` a garbage string gets.
    #[test]
    fn a_lease_handle_is_refused_off_its_own_identity() {
        let caller = HostedCaller {
            workspace_id: Uuid::from_u128(1),
            agent_member_id: Uuid::from_u128(2),
            token_id: Uuid::from_u128(3),
        };
        let identity = HostedToolIdentity {
            connection_id: Uuid::from_u128(4),
            agent_member_id: caller.agent_member_id,
            token_id: caller.token_id,
            token_scopes: Vec::new(),
            approved_scopes: Vec::new(),
            approved_channel_ids: Vec::new(),
        };
        let handle = encode_lease_handle(
            LeaseHandle {
                workspace_id: caller.workspace_id,
                agent_member_id: caller.agent_member_id,
                connection_id: identity.connection_id,
                run_id: Uuid::from_u128(5),
                job_id: 11,
                lease_id: Uuid::from_u128(6),
            },
            "secret",
        )
        .unwrap();
        assert!(bound_handle(&identity, caller, &handle, "secret").is_ok());

        let other_connection = HostedToolIdentity {
            connection_id: Uuid::from_u128(99),
            ..identity.clone()
        };
        assert_eq!(
            bound_handle(&other_connection, caller, &handle, "secret"),
            Err(ToolFailure::NotAuthorized)
        );
        let other_agent = HostedCaller {
            agent_member_id: Uuid::from_u128(98),
            ..caller
        };
        assert_eq!(
            bound_handle(&identity, other_agent, &handle, "secret"),
            Err(ToolFailure::NotAuthorized)
        );
        let other_workspace = HostedCaller {
            workspace_id: Uuid::from_u128(97),
            ..caller
        };
        assert_eq!(
            bound_handle(&identity, other_workspace, &handle, "secret"),
            Err(ToolFailure::NotAuthorized)
        );
        assert_eq!(
            bound_handle(&identity, caller, "momo_lease_v1.zzzz", "secret"),
            Err(ToolFailure::NotAuthorized)
        );
        assert_eq!(
            bound_handle(&identity, caller, &handle, "another-secret"),
            Err(ToolFailure::NotAuthorized)
        );
    }

    /// Both halves of the intersection are required at call time too, not only
    /// when the catalog was listed.
    #[test]
    fn a_scope_must_be_on_both_halves_at_call_time() {
        let mut identity = HostedToolIdentity {
            connection_id: Uuid::from_u128(1),
            agent_member_id: Uuid::from_u128(2),
            token_id: Uuid::from_u128(3),
            token_scopes: vec!["messages:write".into()],
            approved_scopes: vec!["messages:write".into()],
            approved_channel_ids: Vec::new(),
        };
        assert!(has_scope(&identity, "messages:write"));
        assert!(!has_scope(&identity, "messages:read"));
        identity.approved_scopes.clear();
        assert!(!has_scope(&identity, "messages:write"));
        identity.approved_scopes = vec!["messages:write".into()];
        identity.token_scopes.clear();
        assert!(!has_scope(&identity, "messages:write"));
    }
}
