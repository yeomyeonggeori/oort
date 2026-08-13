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

const MCP_PROTOCOL_VERSION: &str = "mcp-protocol-version";
const MCP_METHOD: &str = "mcp-method";
const MCP_NAME: &str = "mcp-name";
const MCP_SESSION_ID: &str = "mcp-session-id";
const LAST_EVENT_ID: &str = "last-event-id";
const MAX_AUTHORIZATION_BYTES: usize = 4096;
const MAX_ORIGIN_BYTES: usize = 2048;
const MAX_ACCEPT_BYTES: usize = 4096;
const MAX_PROTOCOL_HEADER_BYTES: usize = 512;
const MAX_RELEVANT_HEADER_VALUES: usize = 16;

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

    // Buffer no more than the contract ceiling plus one byte. A much larger
    // body is rejected without allocation proportional to attacker input.
    let (bytes, body_limit_error) = if !relevant_headers_bounded {
        (
            Default::default(),
            Some(protocol_error(
                StatusCode::BAD_REQUEST,
                -32600,
                "invalid Agent Port transport headers",
            )),
        )
    } else {
        match to_bytes(body, momo_mcp::MAX_BODY_BYTES + 1).await {
            Ok(bytes) => (bytes, None),
            Err(_) => (
                Default::default(),
                Some(protocol_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    -32600,
                    "request body exceeds the limit",
                )),
            ),
        }
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

    let protocol_response = if let Some(response) = body_limit_error {
        response
    } else if query_error || duplicate_transport_header {
        protocol_error(
            StatusCode::BAD_REQUEST,
            -32600,
            "invalid Agent Port transport headers",
        )
    } else {
        let dispatched = momo_mcp::dispatch(momo_mcp::HttpRequest {
            content_type: content_type.value(),
            accept: accept.as_ref().ok().and_then(Option::as_deref),
            protocol_version: protocol_version.value(),
            mcp_method: method.value(),
            mcp_name: name.value(),
            body: &bytes,
        });
        dispatched_response(dispatched)
    };

    // Authentication happens even for a malformed protocol request so no wire
    // detail becomes an unauthenticated oracle. The body is already bounded,
    // and auth never receives or logs it.
    let admission = match authorization {
        UniqueHeader::Missing => {
            return auth_failure(AgentPortAuthError::MissingCredential);
        }
        UniqueHeader::Invalid => return auth_failure(AgentPortAuthError::InvalidToken),
        UniqueHeader::One(value) => {
            match authenticate_and_admit_agent_port_credential(&state, Some(value)).await {
                Ok(admission) => admission,
                Err(error) => return auth_failure(error),
            }
        }
    };
    match admission {
        AgentPortAdmission::Allowed(_principal) => {}
        AgentPortAdmission::RateLimited {
            retry_after_seconds,
        } => return rate_limited(retry_after_seconds),
    }

    // Incoming session/resume headers are deliberately ignored as authority.
    // They do not alter the response and are never echoed.
    let _incoming_session = parts.headers.get(MCP_SESSION_ID);
    let _incoming_event = parts.headers.get(LAST_EVENT_ID);
    protocol_response
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

fn rate_limited(retry_after_seconds: u64) -> Response {
    let mut response = protocol_error(StatusCode::TOO_MANY_REQUESTS, -32029, "rate limit exceeded");
    if let Ok(value) = retry_after_seconds.to_string().parse() {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

fn dispatched_response(dispatched: momo_mcp::HttpResponse) -> Response {
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

fn protocol_error(status: StatusCode, code: i64, message: &str) -> Response {
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

fn empty(status: StatusCode) -> Response {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(Body::empty())
        .expect("status and empty body build a response")
}

#[derive(Debug)]
enum UniqueHeader<'a> {
    Missing,
    One(&'a str),
    Invalid,
}

impl UniqueHeader<'_> {
    fn value(&self) -> Option<&str> {
        match self {
            UniqueHeader::One(value) => Some(value),
            UniqueHeader::Missing | UniqueHeader::Invalid => None,
        }
    }
}

fn unique_text_header<'a>(headers: &'a HeaderMap, name: HeaderName) -> UniqueHeader<'a> {
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

fn unique_bounded_text_header<'a>(
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

fn unique_named_text_header<'a>(headers: &'a HeaderMap, name: &'static str) -> UniqueHeader<'a> {
    unique_text_header(headers, HeaderName::from_static(name))
}

fn joined_text_headers_bounded(
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

fn relevant_headers_are_bounded(headers: &HeaderMap) -> bool {
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
