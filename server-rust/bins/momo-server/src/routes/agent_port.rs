//! ADR-0162 / HAP-E2 — stateless dual-era MCP Agent Port transport.
//!
//! This adapter owns HTTP, authentication, trusted-origin enforcement and
//! process-local abuse bounds. MCP parsing/dispatch stays in `momo-mcp`; agent
//! bearer SQL/hash/revocation/audit stays in `momo-auth` via [`crate::auth`].
//! There is intentionally no session state and no product-data tool here.

use std::net::SocketAddr;
use std::time::Duration;

use crate::auth::{
    authenticate_and_admit_agent_port_credential, AgentPortAdmission, AgentPortAuthError,
};
use crate::AppState;
use axum::body::{to_bytes, Body};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::Response;

pub(crate) const MCP_PROTOCOL_VERSION: &str = "mcp-protocol-version";
pub(crate) const MCP_METHOD: &str = "mcp-method";
pub(crate) const MCP_NAME: &str = "mcp-name";
const MCP_SESSION_ID: &str = "mcp-session-id";
const LAST_EVENT_ID: &str = "last-event-id";
pub(crate) const MAX_AUTHORIZATION_BYTES: usize = 4096;
pub(crate) const MAX_ORIGIN_BYTES: usize = 2048;
pub(crate) const MAX_ACCEPT_BYTES: usize = 4096;
const MAX_PROTOCOL_HEADER_BYTES: usize = 512;
pub(crate) const MAX_RELEVANT_HEADER_VALUES: usize = 16;
/// The adapter's own two refusal sentences. Constants so the call trace can name their reason
/// from the same text the response carries (`momo_mcp::REFUSAL_REASONS` has a row for each).
const MESSAGE_TRANSPORT_HEADERS: &str = "invalid Agent Port transport headers";
const MESSAGE_BODY_TOO_LARGE: &str = "request body exceeds the limit";

/// One Agent Port POST. Every invocation independently authenticates and no
/// request or response creates protocol-session authority.
pub async fn post(State(state): State<AppState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();

    // Pre-auth socket-peer limit is the first route decision. X-Forwarded-For
    // is intentionally ignored: an untrusted header must not select a bucket
    // or let malformed Origin/header traffic evade abuse control.
    if let Some(ConnectInfo(peer)) = parts.extensions.get::<ConnectInfo<SocketAddr>>() {
        let verdict = state.agent_port.limiter.check(
            &format!("agent-port:ip:{}", peer.ip()),
            state.agent_port.config.per_ip_limit,
            Duration::from_secs(state.agent_port.config.window_seconds),
        );
        if !verdict.allowed {
            if verdict.should_log {
                tracing::warn!(
                    axis = "socket-peer",
                    limit = state.agent_port.config.per_ip_limit,
                    window_seconds = state.agent_port.config.window_seconds,
                    "Agent Port rate limit exceeded"
                );
            }
            return rate_limited(verdict.retry_after_seconds);
        }
    }

    let relevant_headers_bounded = relevant_headers_are_bounded(&parts.headers);
    let authorization = unique_bounded_text_header(
        &parts.headers,
        header::AUTHORIZATION,
        MAX_AUTHORIZATION_BYTES,
    );

    // `Origin` is the only browser-controlled authority-shaped input. Reject it
    // before body parsing or DB access; Host/Forwarded/X-Forwarded-* are never
    // consulted here or in AgentPortConfig.
    let origin = unique_bounded_text_header(&parts.headers, header::ORIGIN, MAX_ORIGIN_BYTES);
    let origin = match origin {
        UniqueHeader::Missing => None,
        UniqueHeader::One(value) => Some(value),
        UniqueHeader::Invalid => return empty(StatusCode::FORBIDDEN),
    };
    if !state.agent_port.config.origin_is_allowed(origin) {
        return empty(StatusCode::FORBIDDEN);
    }

    // A bearer belongs only in Authorization. Reject every query spelling,
    // including a benign-looking parameter, so query-based credential fallback
    // cannot be introduced by a client or reverse proxy.
    let query_error = parts.uri.query().is_some();

    // **The 6 MiB budget is read only after the caller is authenticated and holds the propose
    // scope** (ADR-0218 appendix A: 인증·scope 검사를 대형 바이트 수집 전에). It belongs to two
    // tools and no others: `oort_action_propose` for `expression.create`, and
    // `oort_expression_assemble` (G3.2/G3.7: one picture, base64, at most 4 MiB decoded). Only a
    // call that DECLARES itself `tools/call` of one of them in the mirrored transport headers is a
    // candidate; any other request keeps the 64 KiB ceiling and the order it always had. The
    // body's own shape (that it really is that tool, and for `oort_action_propose` that it really
    // is an `expression.create` proposal) is proved after it is read, so a header alone never
    // widens anything: a body past 64 KiB must be the very tool the header named.
    let declared_method = unique_named_text_header(&parts.headers, MCP_METHOD);
    let declared_name = unique_named_text_header(&parts.headers, MCP_NAME);
    let declared_large_tool: Option<&'static str> = if relevant_headers_bounded
        && !query_error
        && declared_method.value() == Some("tools/call")
    {
        match declared_name.value() {
            Some(momo_mcp::TOOL_ACTION_PROPOSE) => Some(momo_mcp::TOOL_ACTION_PROPOSE),
            Some(momo_mcp::TOOL_EXPRESSION_ASSEMBLE) => Some(momo_mcp::TOOL_EXPRESSION_ASSEMBLE),
            _ => None,
        }
    } else {
        None
    };
    let mut pre_admission: Option<AgentPortAdmission> = None;
    let mut body_cap = momo_mcp::MAX_BODY_BYTES;
    if declared_large_tool.is_some() {
        pre_admission = Some(match &authorization {
            UniqueHeader::Missing => return auth_failure(AgentPortAuthError::MissingCredential),
            UniqueHeader::Invalid => return auth_failure(AgentPortAuthError::InvalidToken),
            UniqueHeader::One(value) => {
                match authenticate_and_admit_agent_port_credential(
                    &state,
                    Some(value),
                    false,
                    None,
                    None,
                    &serde_json::json!({}),
                )
                .await
                {
                    Ok(AgentPortAdmission::Allowed(principal)) => {
                        if principal.kind == momo_auth::PrincipalKind::Agent
                            && principal
                                .scopes
                                .iter()
                                .any(|scope| scope == momo_auth::SCOPE_WORKSPACE_PROPOSE)
                        {
                            body_cap = momo_mcp::MAX_EXPRESSION_REQUEST_BYTES;
                        }
                        AgentPortAdmission::Allowed(principal)
                    }
                    Ok(AgentPortAdmission::RateLimited {
                        retry_after_seconds,
                    }) => return rate_limited(retry_after_seconds),
                    Err(error) => return auth_failure(error),
                }
            }
        });
    }

    // Buffer no more than the contract ceiling plus one byte. A much larger
    // body is rejected without allocation proportional to attacker input.
    let (bytes, body_limit_error) = if !relevant_headers_bounded {
        (
            Default::default(),
            Some(protocol_error(
                StatusCode::BAD_REQUEST,
                -32600,
                MESSAGE_TRANSPORT_HEADERS,
            )),
        )
    } else {
        match to_bytes(body, body_cap + 1).await {
            Ok(bytes) => (bytes, None),
            Err(_) => (
                Default::default(),
                Some(protocol_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    -32600,
                    MESSAGE_BODY_TOO_LARGE,
                )),
            ),
        }
    };

    // A body past the standard limit exists only because the header named a large-budget tool, so
    // it must BE that tool. The header is the caller's claim and the body is the fact: a call
    // that declared one tool and carries another (or carries no tool call at all) never gets the
    // larger budget, whatever the body is. Answered like any oversize body, after authentication.
    let body_limit_error = match body_limit_error {
        None if bytes.len() > momo_mcp::MAX_BODY_BYTES
            && declared_large_tool
                .is_none_or(|declared| momo_mcp::call_shape(&bytes).tool != Some(declared)) =>
        {
            Some(protocol_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                -32600,
                MESSAGE_BODY_TOO_LARGE,
            ))
        }
        other => other,
    };

    let content_type = unique_text_header(&parts.headers, header::CONTENT_TYPE);
    let accept = joined_text_headers_bounded(
        &parts.headers,
        header::ACCEPT,
        MAX_ACCEPT_BYTES,
        MAX_RELEVANT_HEADER_VALUES,
    );
    let protocol_version = unique_named_text_header(&parts.headers, MCP_PROTOCOL_VERSION);
    let method = unique_named_text_header(&parts.headers, MCP_METHOD);
    let name = unique_named_text_header(&parts.headers, MCP_NAME);
    let duplicate_transport_header = matches!(content_type, UniqueHeader::Invalid)
        || matches!(protocol_version, UniqueHeader::Invalid)
        || matches!(method, UniqueHeader::Invalid)
        || matches!(name, UniqueHeader::Invalid)
        || accept.is_err();

    let foundation = if body_limit_error.is_none()
        && !query_error
        && !duplicate_transport_header
        && pre_admission.is_none()
    {
        momo_mcp::classify_foundation_request(momo_mcp::HttpRequest {
            content_type: content_type.value(),
            accept: accept.as_ref().ok().and_then(Option::as_deref),
            protocol_version: protocol_version.value(),
            mcp_method: method.value(),
            mcp_name: name.value(),
            body: &bytes,
        })
    } else {
        None
    };
    // A transport rejection is decided here but **answered after**
    // authentication, so a malformed request still cannot tell an
    // unauthenticated caller anything an authenticated one would not learn.
    let transport_rejection = if let Some(response) = body_limit_error {
        Some(response)
    } else if query_error || duplicate_transport_header {
        Some(protocol_error(
            StatusCode::BAD_REQUEST,
            -32600,
            MESSAGE_TRANSPORT_HEADERS,
        ))
    } else {
        None
    };
    let (detected_client_name, detected_client_version, detected_capabilities) = foundation
        .and_then(|kind| foundation_metadata(&bytes, kind))
        .unwrap_or_else(|| (None, None, serde_json::json!({})));

    // Authentication happens even for a malformed protocol request so no wire
    // detail becomes an unauthenticated oracle. The body is already bounded,
    // and auth never receives or logs it.
    let admission = match (pre_admission, authorization) {
        // Authenticated above, before a large body was collected: not asked a second time.
        (Some(admission), _) => admission,
        (None, UniqueHeader::Missing) => {
            return auth_failure(AgentPortAuthError::MissingCredential);
        }
        (None, UniqueHeader::Invalid) => return auth_failure(AgentPortAuthError::InvalidToken),
        (None, UniqueHeader::One(value)) => match authenticate_and_admit_agent_port_credential(
            &state,
            Some(value),
            foundation.is_some(),
            detected_client_name.as_deref(),
            detected_client_version.as_deref(),
            &detected_capabilities,
        )
        .await
        {
            Ok(admission) => admission,
            Err(error) => return auth_failure(error),
        },
    };
    let principal = match admission {
        AgentPortAdmission::Allowed(principal) => principal,
        AgentPortAdmission::RateLimited {
            retry_after_seconds,
        } => return rate_limited(retry_after_seconds),
    };

    // Incoming session/resume headers are deliberately ignored as authority.
    // They do not alter the response and are never echoed.
    let _incoming_session = parts.headers.get(MCP_SESSION_ID);
    let _incoming_event = parts.headers.get(LAST_EVENT_ID);

    let caller = crate::routes::agent_port_tools::HostedCaller::from_principal(&principal);
    let era = call_era(protocol_version.value());

    if let Some(rejection) = transport_rejection {
        // Every transport refusal is `-32600` (`protocol_error` above); which of the two it was
        // is told by its status (the oversize body is the only `413`).
        if let Some(caller) = caller {
            let sentence = if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                MESSAGE_BODY_TOO_LARGE
            } else {
                MESSAGE_TRANSPORT_HEADERS
            };
            trace_call(
                &state,
                caller,
                momo_mcp::call_shape(&bytes),
                AnswerFacts {
                    era,
                    status: rejection.status().as_u16(),
                    rpc_code: Some(-32600),
                    reason: Some(momo_mcp::reason_of_sentence(sentence)),
                    tools_listed: None,
                    counts: momo_mcp::ResultCounts::default(),
                },
            )
            .await;
        }
        return rejection;
    }

    // ADR-0162 HAP-E5 — the request's own tool view.
    //
    // Resolved only for the two methods that can consult it, so the foundation
    // surface (discover/initialize/ping/notifications) still costs exactly the
    // queries HAP-E2 measured. A caller with no live hosted connection resolves
    // to the empty view, which is byte-identical to a connect-only credential:
    // an empty catalog and an unknown-tool answer.
    let view = match (mentions_tools(&bytes), caller) {
        (true, Some(caller)) => {
            crate::routes::agent_port_tools::tool_view_for(&state, caller).await
        }
        _ => momo_mcp::ToolView::empty(),
    };

    let request = momo_mcp::HttpRequest {
        content_type: content_type.value(),
        accept: accept.as_ref().ok().and_then(Option::as_deref),
        protocol_version: protocol_version.value(),
        mcp_method: method.value(),
        mcp_name: name.value(),
        body: &bytes,
    };
    let dispatched = match momo_mcp::dispatch_with_tools(request, &view) {
        momo_mcp::Outcome::Response(response) => {
            log_invalid_params(&response, &bytes);
            response
        }
        momo_mcp::Outcome::Tool(call) => match caller {
            Some(caller) => {
                momo_db::tenant::REQUEST_AGENT_MEMBER
                    .scope(
                        caller.agent_member_id,
                        crate::routes::agent_port_tools::execute(&state, caller, call),
                    )
                    .await
            }
            // Unreachable: a non-empty view requires a hosted caller. Answering
            // like an unknown tool keeps the impossible case fail-closed.
            None => momo_mcp::tool_failure(&call, momo_mcp::ToolFailure::NotAuthorized),
        },
    };
    if let Some(caller) = caller {
        let shape = momo_mcp::call_shape(&bytes);
        // For a `tools/list`, how many tools this caller's view offered: the one
        // number that tells "listed nothing" from "listed everything".
        let tools_listed =
            (dispatched.status == 200 && shape.method == "tools/list").then(|| view.names().len());
        // For the three tools whose answer says whether work exists, how much it handed
        // over — counted from the server's own answer (`result_counts`).
        let counts = shape
            .tool
            .map(|tool| momo_mcp::result_counts(tool, dispatched.body.as_deref()))
            .unwrap_or_default();
        trace_call(
            &state,
            caller,
            shape,
            AnswerFacts {
                era,
                status: dispatched.status,
                rpc_code: momo_mcp::response_rpc_code(dispatched.body.as_deref()),
                reason: momo_mcp::refusal_reason(dispatched.body.as_deref()),
                tools_listed,
                counts,
            },
        )
        .await;
    }
    dispatched_response(dispatched)
}

/// The audit row of one admitted Agent Port POST (ADR-0200 증보 4, #4618).
const CALL_TRACE_ACTION: &str = "agent_port.call";
const CALL_TRACE_SCHEMA: &str = "oort.agent_port.call.v1";
/// Same ceiling as the liveness and `tool_call` writes: the call has already been
/// answered in substance, and a slow database must not become a slow response.
const CALL_TRACE_WRITE_TIMEOUT: Duration = Duration::from_secs(2);

/// The protocol era the caller *said* it was speaking, from the `MCP-Protocol-Version`
/// header alone — a closed token, never the header's text.
fn call_era(header: Option<&str>) -> &'static str {
    match header {
        None => "none",
        Some(momo_mcp::MODERN_PROTOCOL_VERSION) => "modern",
        Some(momo_mcp::LEGACY_PROTOCOL_VERSION) => "legacy",
        Some(_) => "other",
    }
}

/// What the server knows about an answer once it exists: every field is a closed token or a
/// number the server computed, never something the caller sent.
struct AnswerFacts {
    era: &'static str,
    status: u16,
    rpc_code: Option<i64>,
    /// The closed reason token of a refusal (`momo_mcp::REFUSAL_REASONS`); `None` for a success.
    reason: Option<&'static str>,
    tools_listed: Option<usize>,
    counts: momo_mcp::ResultCounts,
}

/// Write one `agent_port.call` audit row for an admitted call, **after** its answer is
/// known.
///
/// Why this exists: `auth.agent_bearer.used` is written in the authentication
/// transaction, before the body is read, so it can only say "a call happened" — and
/// the liveness and `tool_call` records skip every refusal that is not
/// `unavailable`/`not_authorized` and every call that points at no run. A runtime that
/// wakes, calls, gets a `-32602`, a `-32700` or a version error and goes quiet left
/// nothing behind. This row says which method, which tool, what came back.
///
/// What it carries is closed on purpose (T1): the JSON-RPC `method` and the `tools/call`
/// tool name from fixed lists (`other` / `unknown` / `unparsed` otherwise), the closed
/// outcome token, the HTTP status, the JSON-RPC code, the era, and three server-computed
/// numbers — how many tools a `tools/list` offered, and how many events / `agent_job`
/// events / jobs a successful `oort_inbox_read` / `oort_jobs_claim` / `oort_job_start`
/// handed over. Never an argument, a cursor, a handle, a body, an id, a header's text or a
/// token; `via_token_id` stays empty so a pairing credential's id can never meet the
/// `token` foreign key.
///
/// Best effort, like the other two records: a separate short tenant transaction, a 2 s
/// ceiling, and a failure is logged and dropped — it never changes the answer.
async fn trace_call(
    state: &AppState,
    caller: crate::routes::agent_port_tools::HostedCaller,
    shape: momo_mcp::CallShape,
    facts: AnswerFacts,
) {
    // At most `PER_HOUR` rows per credential per hour, then the trace stops for it until the hour
    // passes (ADR-0200 T3's rule: stop recording, never delete).
    let verdict = state.agent_port.call_trace.admit(caller.token_id);
    if !verdict.allowed {
        if verdict.should_log {
            tracing::warn!(
                limit = crate::rate_limit::CallTraceBudget::PER_HOUR,
                "Agent Port call trace capped for one credential until its hour passes"
            );
        }
        return;
    }
    let mut detail = serde_json::json!({
        "method": shape.method,
        "outcome": momo_mcp::outcome_code(facts.rpc_code),
        "status": facts.status,
        "era": facts.era,
    });
    if let Some(object) = detail.as_object_mut() {
        if let Some(tool) = shape.tool {
            object.insert("tool".to_owned(), serde_json::json!(tool));
        }
        if let Some(code) = facts.rpc_code {
            object.insert("rpc_code".to_owned(), serde_json::json!(code));
        }
        if let Some(reason) = facts.reason {
            object.insert("reason".to_owned(), serde_json::json!(reason));
        }
        for (key, value) in [
            (
                "tools_listed",
                facts
                    .tools_listed
                    .map(|listed| u32::try_from(listed).unwrap_or(u32::MAX)),
            ),
            ("events", facts.counts.events),
            ("agent_jobs", facts.counts.agent_jobs),
            ("jobs", facts.counts.jobs),
        ] {
            if let Some(value) = value {
                object.insert(key.to_owned(), serde_json::json!(value));
            }
        }
    }
    let mut entry = momo_db::audit::AuditEntry::new(caller.workspace_id, CALL_TRACE_ACTION)
        .by(caller.agent_member_id)
        .with_schema(CALL_TRACE_SCHEMA, detail);
    entry.target_type = Some("route".to_string());
    let write = tokio::time::timeout(
        CALL_TRACE_WRITE_TIMEOUT,
        momo_db::with_tenant_tx(&state.pool, caller.workspace_id, move |conn| {
            Box::pin(async move {
                momo_db::audit::write_audit(conn, &entry).await?;
                Ok(())
            })
        }),
    )
    .await;
    match write {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "Agent Port call trace write failed");
        }
        Err(_) => tracing::warn!("Agent Port call trace write timed out"),
    }
}

/// Leave a diagnostic trail for a JSON-RPC `-32602` refusal.
///
/// Before this existed a client could be refused on every call with nothing in
/// the logs to say why. Only **names** are recorded — the method, the top-level
/// `params` keys and the `_meta` keys — never a value, an argument name or the
/// caller's identity, so no tool input or credential can reach the log.
fn log_invalid_params(response: &momo_mcp::HttpResponse, body: &[u8]) {
    let Some((code, message)) = response
        .body
        .as_deref()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok())
        .and_then(|value| {
            let error = value.get("error")?;
            Some((
                error.get("code")?.as_i64()?,
                error.get("message")?.as_str()?.to_owned(),
            ))
        })
    else {
        return;
    };
    if code != -32602 {
        return;
    }
    let shape = momo_mcp::request_shape(body);
    tracing::warn!(
        method = ?shape.method,
        code,
        message = %message,
        params_keys = ?shape.params_keys,
        meta_keys = ?shape.meta_keys,
        "Agent Port refused request params"
    );
}

/// Whether this body's JSON-RPC method is one the tool view can change.
///
/// Cheap and deliberately permissive: a body that does not parse, or names
/// another method, answers `false` and the request pays no connection lookup.
/// `momo_mcp` still owns every validation decision — this only decides whether
/// resolving the view is worth a query.
fn mentions_tools(body: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .as_ref()
        .and_then(|value| value.get("method"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|method| matches!(method, "tools/list" | "tools/call"))
}

fn foundation_metadata(
    body: &[u8],
    foundation: momo_mcp::FoundationRequest,
) -> Option<(Option<String>, Option<String>, serde_json::Value)> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    let params = value.get("params")?;
    let (info, capabilities) = match foundation {
        momo_mcp::FoundationRequest::ModernDiscover
        | momo_mcp::FoundationRequest::ModernToolsList => {
            let meta = params.get("_meta")?;
            (
                meta.get(momo_mcp::META_CLIENT_INFO),
                meta.get(momo_mcp::META_CLIENT_CAPABILITIES),
            )
        }
        momo_mcp::FoundationRequest::LegacyInitialize => {
            (params.get("clientInfo"), params.get("capabilities"))
        }
        momo_mcp::FoundationRequest::LegacyToolsList => (None, None),
    };
    let name = info
        .and_then(|value| value.get("name"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let version = info
        .and_then(|value| value.get("version"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    Some((
        name,
        version,
        capabilities
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
    ))
}

fn auth_failure(error: AgentPortAuthError) -> Response {
    let (status, challenge) = match error {
        AgentPortAuthError::MissingCredential => (
            StatusCode::UNAUTHORIZED,
            "Bearer scope=\"agent:port:connect\"",
        ),
        AgentPortAuthError::InvalidToken => (
            StatusCode::UNAUTHORIZED,
            "Bearer error=\"invalid_token\", scope=\"agent:port:connect\"",
        ),
        AgentPortAuthError::InsufficientScope => (
            StatusCode::FORBIDDEN,
            "Bearer error=\"insufficient_scope\", scope=\"agent:port:connect\"",
        ),
        AgentPortAuthError::Internal => {
            return empty(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    let mut response = empty(status);
    response.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static(challenge),
    );
    response
}

pub(crate) fn rate_limited(retry_after_seconds: u64) -> Response {
    let mut response = protocol_error(StatusCode::TOO_MANY_REQUESTS, -32029, "rate limit exceeded");
    if let Ok(value) = retry_after_seconds.to_string().parse() {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

pub(crate) fn dispatched_response(dispatched: momo_mcp::HttpResponse) -> Response {
    let status =
        StatusCode::from_u16(dispatched.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = Response::builder()
        .status(status)
        .body(dispatched.body.map_or_else(Body::empty, Body::from))
        .expect("a validated status and body build a response");
    if let Some(content_type) = dispatched.content_type {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    }
    // This endpoint is stateless and every call reauthenticates. No cache may
    // turn one agent's capability response into another's.
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

pub(crate) fn protocol_error(status: StatusCode, code: i64, message: &str) -> Response {
    let body = serde_json::to_vec(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": null,
        "error": {"code": code, "message": message}
    }))
    .expect("static JSON serializes");
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(Body::from(body))
        .expect("static response builds");
    response.headers_mut().remove(MCP_SESSION_ID);
    response
}

pub(crate) fn empty(status: StatusCode) -> Response {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(Body::empty())
        .expect("status and empty body build a response")
}

#[derive(Debug)]
pub(crate) enum UniqueHeader<'a> {
    Missing,
    One(&'a str),
    Invalid,
}

impl UniqueHeader<'_> {
    pub(crate) fn value(&self) -> Option<&str> {
        match self {
            UniqueHeader::One(value) => Some(value),
            UniqueHeader::Missing | UniqueHeader::Invalid => None,
        }
    }
}

pub(crate) fn unique_text_header<'a>(headers: &'a HeaderMap, name: HeaderName) -> UniqueHeader<'a> {
    let mut values = headers.get_all(name).iter();
    match (values.next(), values.next()) {
        (None, _) => UniqueHeader::Missing,
        (Some(value), None) => value
            .to_str()
            .map(UniqueHeader::One)
            .unwrap_or(UniqueHeader::Invalid),
        (Some(_), Some(_)) => UniqueHeader::Invalid,
    }
}

pub(crate) fn unique_bounded_text_header<'a>(
    headers: &'a HeaderMap,
    name: HeaderName,
    max_bytes: usize,
) -> UniqueHeader<'a> {
    match unique_text_header(headers, name) {
        UniqueHeader::One(value) if value.len() <= max_bytes => UniqueHeader::One(value),
        UniqueHeader::One(_) | UniqueHeader::Invalid => UniqueHeader::Invalid,
        UniqueHeader::Missing => UniqueHeader::Missing,
    }
}

pub(crate) fn unique_named_text_header<'a>(
    headers: &'a HeaderMap,
    name: &'static str,
) -> UniqueHeader<'a> {
    unique_text_header(headers, HeaderName::from_static(name))
}

pub(crate) fn joined_text_headers_bounded(
    headers: &HeaderMap,
    name: HeaderName,
    max_bytes: usize,
    max_values: usize,
) -> Result<Option<String>, ()> {
    let mut joined = String::new();
    for (index, value) in headers.get_all(name).iter().enumerate() {
        if index >= max_values {
            return Err(());
        }
        let value = value.to_str().map_err(|_| ())?;
        let separator = usize::from(!joined.is_empty());
        if joined.len() + separator + value.len() > max_bytes {
            return Err(());
        }
        if !joined.is_empty() {
            joined.push(',');
        }
        joined.push_str(value);
    }
    Ok((!joined.is_empty()).then_some(joined))
}

pub(crate) fn relevant_headers_are_bounded(headers: &HeaderMap) -> bool {
    let limits = [
        (header::CONTENT_TYPE, MAX_PROTOCOL_HEADER_BYTES),
        (header::ACCEPT, MAX_ACCEPT_BYTES),
        (header::AUTHORIZATION, MAX_AUTHORIZATION_BYTES),
        (header::ORIGIN, MAX_ORIGIN_BYTES),
        (
            HeaderName::from_static(MCP_PROTOCOL_VERSION),
            MAX_PROTOCOL_HEADER_BYTES,
        ),
        (
            HeaderName::from_static(MCP_METHOD),
            MAX_PROTOCOL_HEADER_BYTES,
        ),
        (HeaderName::from_static(MCP_NAME), MAX_PROTOCOL_HEADER_BYTES),
        (
            HeaderName::from_static(MCP_SESSION_ID),
            MAX_PROTOCOL_HEADER_BYTES,
        ),
        (
            HeaderName::from_static(LAST_EVENT_ID),
            MAX_PROTOCOL_HEADER_BYTES,
        ),
    ];
    let mut count = 0usize;
    for (name, max_bytes) in limits {
        for value in headers.get_all(name).iter() {
            count += 1;
            if count > MAX_RELEVANT_HEADER_VALUES || value.as_bytes().len() > max_bytes {
                return false;
            }
        }
    }
    true
}
