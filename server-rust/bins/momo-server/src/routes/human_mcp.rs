//! ADR-0216 D5 / #4661 — the **human MCP**: `POST /v1/mcp/me`.
//!
//! A developer token's (`momo_dev_v1…`) MCP door. The Agent Port (`/v1/mcp/agent-port`) is
//! an agent member's; this is a *person's own credential*, narrowed to five tools —
//! `oort_me_whoami`, `oort_me_channels`, `oort_me_read`, `oort_me_post`, `oort_me_inbox`
//! (`momo_mcp::human`) — that are thin shells over the REST rows L1, L3–L7 (D4). The two
//! servers share the JSON-RPC wire core and nothing else: not the credential class, not the
//! catalog, not the `serverInfo`.
//!
//! ## One request, in order
//!
//! 1. **[`door`]** — a middleware of this route alone, mounted *outside* `require_principal`
//!    (like the Agent Port) because a generic bearer door would answer an agent credential with
//!    its own 403 (`authenticate_agent`'s closed route list) and a session JWT with admission:
//!    ADR-0216 R1(b) wants every non-developer credential to get the **same 401** as an unknown
//!    string. So the door: refuses an `Origin` the operator did not name (a browser page is not
//!    this door's caller; before any budget is spent) → no bearer: 401 → **a bearer that is not
//!    a developer envelope** (an agent bearer, a pairing value, a hosted OAuth access, a session
//!    JWT, a refresh envelope, garbage) is [`invalid_token`], answered **without touching the
//!    database** → a developer envelope goes to `dev_access::require_dev_principal`, the same
//!    function every REST row runs: the closed table (`POST /v1/mcp/me` is L8, `dev:identity`),
//!    the lookup, the workspace policy (role), the per-token and per-member budgets, and the
//!    `auth.dev_token.used` row in the admitting transaction. It is not reimplemented here.
//!    Every other method on this path (GET, DELETE, HEAD, …) is off the table, so a developer
//!    token gets that door's `dev_route_not_allowed` 403 and the route answers 200 to nothing
//!    but a POST.
//! 2. **[`post`]** — the stateless JSON-RPC transport: bounded body, unique protocol headers, no
//!    query string, `Cache-Control: private, no-store`; `momo_mcp::dispatch_with_tools` over the
//!    token's own [`human_view`] (`tools/list` and `tools/call` read one value: a tool whose scope
//!    the token lacks is neither listed nor callable). The role policy was judged by the door on
//!    this very request, so there is no second "∩ policy" here.
//! 3. **[`execute`]** — the tool, *as the REST row*: each tool calls the REST handler it is a shell
//!    over, with the extractors the door filled (`Principal`, `DevCredential`, `DevIdentity`), so
//!    the channel restriction, the membership check, the `approvalsPending: []`, the `sent_via =
//!    'dev'` mark and every other rule are the handler's own and cannot drift into a second copy
//!    (R14 d). The result is the REST body, unchanged.
//!
//! ## What the door does not spend for a send
//!
//! L8's scope is `dev:identity`, so the door cannot tell that one JSON-RPC call is a send. The
//! `post` tool therefore spends, itself and from the **same counters** the REST row spends, the
//! two budgets that sit beside a REST send: the token's send budget
//! ([`crate::dev_access::spend_write_budget`], the door's own `dev:write` key) and the member's
//! send budget ([`crate::rate_limit::spend_member_write`], the route layer `POST …/messages` wears).
//! The door's `used` row for that call is already written when the tool refuses; the per-token
//! budget bounds those rows.
//!
//! ## Refusals
//!
//! A refusal of the REST row (4xx: not a member of this channel, a thread root that does not
//! exist, …) is a tool *result* with `isError: true` carrying the REST status and error body —
//! what the model needs to read and recover from, and exactly what the same person is told by
//! REST. A server fault (5xx) is the closed [`ToolFailure::Internal`]. An over-budget send is the
//! HTTP 429 with `Retry-After` of the Agent Port's `rate_limited`.
//!
//! ## What is not here
//!
//! No `GET`/SSE/`DELETE` (stateless POST only, D5), no sessions, no RFC 9728 metadata (it is
//! advertised only once an OAuth server exists for this door — D5; none is advertised now), no
//! call trace (a later, separate record: ADR-0216 checklist), no search, and no tool that
//! structures the workspace, decides an approval or proposes an action (D4 closes those to a
//! developer token, so there is nothing to call).

use axum::body::to_bytes;
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::dev_token::DevIdentity;
use momo_auth::Principal;
use momo_mcp::human::{human_view, TOOL_CHANNELS, TOOL_INBOX, TOOL_POST, TOOL_READ, TOOL_WHOAMI};
use momo_mcp::{HttpRequest, Outcome, ToolCall, ToolFailure};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::dev_access;
use crate::dev_credential::DevCredential;
use crate::dto::{HistoryQuery, RepliesQuery, SendMessageRequest};
use crate::error::ApiError;
use crate::rate_limit::{spend_member_write, MemberWrite};
use crate::routes::agent_port::{
    dispatched_response, empty, joined_text_headers_bounded, protocol_error, rate_limited,
    relevant_headers_are_bounded, unique_bounded_text_header, unique_named_text_header,
    unique_text_header, UniqueHeader, MAX_ACCEPT_BYTES, MAX_AUTHORIZATION_BYTES, MAX_ORIGIN_BYTES,
    MAX_RELEVANT_HEADER_VALUES, MCP_METHOD, MCP_NAME, MCP_PROTOCOL_VERSION,
};
use crate::routes::channels::ChannelListQuery;
use crate::routes::inbox::InboxQuery;
use crate::AppState;

/// The route template — the one string `lib.rs` mounts and `momo_auth`'s closed table (L8) names.
pub const ROUTE: &str = "/v1/mcp/me";

/// The transport's own two refusal sentences (the human MCP's; the Agent Port keeps its own).
const MESSAGE_TRANSPORT_HEADERS: &str = "invalid MCP transport headers";
const MESSAGE_BODY_TOO_LARGE: &str = "request body exceeds the limit";

// ---------------------------------------------------------------------------
// the door
// ---------------------------------------------------------------------------

/// The one 401 every credential that is not a usable developer token gets here: byte for byte
/// the developer door's own answer to an expired, revoked or unknown token (D2, R2 iii) — and so
/// the answer to any string the server does not know.
fn invalid_token() -> Response {
    dev_access::invalid_token().into_response()
}

/// The route layer of `POST /v1/mcp/me` (module docs, "One request, in order", step 1).
///
/// It decides which door a bearer may knock on and then lets the developer door decide
/// everything else. It is the **only** authentication this route has; a request that somehow
/// reached [`post`] without the door's extensions is refused there as well.
pub(crate) async fn door(State(state): State<AppState>, request: Request, next: Next) -> Response {
    // A browser page is not a caller of this door, and DNS rebinding is how one becomes one
    // for a server on a developer's own machine: an `Origin` the operator did not name is
    // refused before a bearer is read, a lookup made or a budget spent (the Agent Port's rule).
    let origin =
        match unique_bounded_text_header(request.headers(), header::ORIGIN, MAX_ORIGIN_BYTES) {
            UniqueHeader::Missing => None,
            UniqueHeader::One(value) => Some(value),
            UniqueHeader::Invalid => return empty(StatusCode::FORBIDDEN),
        };
    if !state.agent_port.config.origin_is_allowed(origin) {
        return empty(StatusCode::FORBIDDEN);
    }

    let bearer = match unique_bounded_text_header(
        request.headers(),
        header::AUTHORIZATION,
        MAX_AUTHORIZATION_BYTES,
    ) {
        UniqueHeader::Missing => None,
        UniqueHeader::One(value) => crate::auth::bearer_token(value).map(str::to_string),
        UniqueHeader::Invalid => return invalid_token(),
    };
    let Some(bearer) = bearer else {
        return ApiError::unauthorized("missing bearer token").into_response();
    };
    // Not a developer envelope: no other credential class is tried here, as a second chance or
    // as a different door. It is not looked up either — the answer needs nothing from the database.
    if !dev_access::is_dev_envelope(&bearer) {
        return invalid_token();
    }
    match dev_access::require_dev_principal(&state, &bearer, request, next).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

// ---------------------------------------------------------------------------
// the transport
// ---------------------------------------------------------------------------

/// What the door proved about the caller — the three values only it inserts.
struct Caller {
    principal: Principal,
    credential: DevCredential,
    identity: DevIdentity,
}

impl Caller {
    fn from_parts(parts: &axum::http::request::Parts) -> Option<Caller> {
        Some(Caller {
            principal: parts.extensions.get::<Principal>()?.clone(),
            credential: parts.extensions.get::<DevCredential>()?.clone(),
            identity: parts.extensions.get::<DevIdentity>()?.clone(),
        })
    }
}

/// One human-MCP POST. Stateless: every call is authenticated by the door and no request or
/// response creates protocol-session authority.
pub async fn post(State(state): State<AppState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    // Only the door inserts these three. Without them this request was not admitted by it, so it
    // is answered as an unknown string — never as a tool call (and never as a 500 that would
    // tell a caller the route was mounted without its door).
    let Some(caller) = Caller::from_parts(&parts) else {
        return invalid_token();
    };

    let relevant_headers_bounded = relevant_headers_are_bounded(&parts.headers);
    // A bearer belongs only in `Authorization`: any query string is refused, so a query-based
    // credential fallback cannot be introduced by a client or a proxy (D2).
    let query_error = parts.uri.query().is_some();
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
    if !relevant_headers_bounded || query_error || duplicate_transport_header {
        return protocol_error(StatusCode::BAD_REQUEST, -32600, MESSAGE_TRANSPORT_HEADERS);
    }

    // No more than the contract ceiling plus one byte is buffered: a much larger body is refused
    // without allocation proportional to attacker input.
    let bytes = match to_bytes(body, momo_mcp::MAX_BODY_BYTES + 1).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return protocol_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                -32600,
                MESSAGE_BODY_TOO_LARGE,
            )
        }
    };

    // The view is the token's own scopes, read from the row the door resolved on this request.
    let view = human_view(&caller.credential.scopes);
    let wire = HttpRequest {
        content_type: content_type.value(),
        accept: accept.as_ref().ok().and_then(Option::as_deref),
        protocol_version: protocol_version.value(),
        mcp_method: method.value(),
        mcp_name: name.value(),
        body: &bytes,
    };
    match momo_mcp::dispatch_with_tools(wire, &view) {
        Outcome::Response(response) => dispatched_response(response),
        Outcome::Tool(call) => execute(&state, &caller, call).await,
    }
}

// ---------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------

/// Why a tool did not produce a result.
#[derive(Debug)]
enum ToolError {
    /// The REST row refused (or failed): its own [`ApiError`].
    Rest(ApiError),
    /// A send over a budget the door does not spend for this tool: HTTP 429 + `Retry-After`.
    OverBudget { retry_after_seconds: u64 },
    /// The arguments satisfy the published schema but name something the tool cannot do (a
    /// `before` cursor on a thread, …).
    InvalidArguments,
    /// The tool's own result could not be encoded. Never carries a cause.
    Internal,
}

impl From<ApiError> for ToolError {
    fn from(error: ApiError) -> Self {
        ToolError::Rest(error)
    }
}

/// Run one validated tool call and shape its answer (module docs, "Refusals").
async fn execute(state: &AppState, caller: &Caller, call: ToolCall) -> Response {
    match run_tool(state, caller, &call).await {
        Ok(structured) => dispatched_response(momo_mcp::tool_success(&call, structured)),
        Err(ToolError::Rest(error)) if error.status.is_client_error() => {
            dispatched_response(momo_mcp::tool_error_result(&call, refusal_body(&error)))
        }
        Err(ToolError::Rest(_) | ToolError::Internal) => {
            dispatched_response(momo_mcp::tool_failure(&call, ToolFailure::Internal))
        }
        Err(ToolError::InvalidArguments) => {
            dispatched_response(momo_mcp::tool_failure(&call, ToolFailure::InvalidArguments))
        }
        Err(ToolError::OverBudget {
            retry_after_seconds,
        }) => rate_limited(retry_after_seconds),
    }
}

/// What a tool says when the REST row it wraps refused: the row's own status and error body
/// (`{"error":{"message", "code"?}}`), with the status beside it because a tool result has no
/// HTTP status of its own.
fn refusal_body(error: &ApiError) -> Value {
    let mut detail = json!({ "message": error.message });
    if let Some(code) = error.code {
        detail["code"] = json!(code);
    }
    json!({ "status": error.status.as_u16(), "error": detail })
}

fn encode<T: serde::Serialize>(dto: &T) -> Result<Value, ToolError> {
    serde_json::to_value(dto).map_err(|error| {
        tracing::error!(error = %error, "human MCP tool result did not encode");
        ToolError::Internal
    })
}

fn argument_i64(arguments: &Value, key: &str) -> Option<i64> {
    arguments.get(key).and_then(Value::as_i64)
}

/// A uuid argument. The schema already holds it to the 8-4-4-4-12 shape, so a value that
/// still fails to parse is refused as invalid arguments rather than guessed at.
fn argument_uuid(arguments: &Value, key: &str) -> Result<Option<Uuid>, ToolError> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Uuid::parse_str(text)
            .map(Some)
            .map_err(|_| ToolError::InvalidArguments),
        Some(_) => Err(ToolError::InvalidArguments),
    }
}

fn required_uuid(arguments: &Value, key: &str) -> Result<Uuid, ToolError> {
    argument_uuid(arguments, key)?.ok_or(ToolError::InvalidArguments)
}

fn present(arguments: &Value, key: &str) -> bool {
    arguments.get(key).is_some_and(|value| !value.is_null())
}

async fn run_tool(state: &AppState, caller: &Caller, call: &ToolCall) -> Result<Value, ToolError> {
    let arguments = &call.arguments;
    let principal = &caller.principal;
    let workspace = principal.workspace_id.to_string();
    // The extractors each REST handler takes, filled from what the door verified. `Some(…)` for
    // the marker: this is a developer token, and the handler narrows by it.
    let marker = || Some(Extension(caller.credential.clone()));

    match call.tool.name {
        // L1 — `GET …/dev-access/self`. The door resolved the token on this request, so the
        // answer needs no second read (the REST handler's own).
        TOOL_WHOAMI => encode(&crate::routes::dev_access::self_response(&caller.identity)),

        // L3 — `GET …/channels`.
        TOOL_CHANNELS => {
            let query = ChannelListQuery {
                limit: argument_i64(arguments, "limit").map(|limit| limit.to_string()),
                include_archived: None,
                include_archived_camel: None,
            };
            let Json(page) = crate::routes::channels::list(
                State(state.clone()),
                Extension(principal.clone()),
                Path(workspace),
                Query(query),
                marker(),
            )
            .await?;
            encode(&page)
        }

        // L4 `GET …/messages` or, with a thread root, L5 `GET …/messages/{root}/replies`.
        TOOL_READ => {
            let channel = required_uuid(arguments, "channelId")?.to_string();
            let limit = argument_i64(arguments, "limit").map(|limit| limit.to_string());
            match argument_uuid(arguments, "threadRootId")? {
                None => {
                    // `cursor` is a thread's.
                    if present(arguments, "cursor") {
                        return Err(ToolError::InvalidArguments);
                    }
                    let query = HistoryQuery {
                        limit,
                        before: argument_i64(arguments, "before").map(|seq| seq.to_string()),
                        after: argument_i64(arguments, "after").map(|seq| seq.to_string()),
                    };
                    let Json(page) = crate::routes::messages::history(
                        State(state.clone()),
                        Extension(principal.clone()),
                        Path((workspace, channel)),
                        Query(query),
                        marker(),
                    )
                    .await?;
                    encode(&page)
                }
                Some(root) => {
                    // `before` and `after` are a channel history's.
                    if present(arguments, "before") || present(arguments, "after") {
                        return Err(ToolError::InvalidArguments);
                    }
                    let query = RepliesQuery {
                        limit,
                        cursor: argument_i64(arguments, "cursor").map(|seq| seq.to_string()),
                    };
                    let Json(page) = crate::routes::messages::replies(
                        State(state.clone()),
                        Extension(principal.clone()),
                        Path((workspace, channel, root.to_string())),
                        Query(query),
                        marker(),
                    )
                    .await?;
                    encode(&page)
                }
            }
        }

        // L6 — `POST …/messages`.
        TOOL_POST => {
            let channel = required_uuid(arguments, "channelId")?;
            let client_msg_id = required_uuid(arguments, "clientMsgId")?;
            let body = arguments
                .get("body")
                .and_then(Value::as_str)
                .ok_or(ToolError::InvalidArguments)?
                .to_string();
            // The two send budgets the door does not spend for this row (module docs).
            dev_access::spend_write_budget(state, caller.credential.token_id).map_err(
                |retry_after_seconds| ToolError::OverBudget {
                    retry_after_seconds,
                },
            )?;
            spend_member_write(state, MemberWrite::MessageSend, principal)
                .await
                .map_err(|retry_after_seconds| ToolError::OverBudget {
                    retry_after_seconds,
                })?;
            // The REST request, built from the five keys the tool's schema allows and from
            // nothing else. Every other field is spelled out as absent — the struct has no
            // default on purpose, so a field added to the REST body tomorrow stops this from
            // compiling until someone decides, here, that it is not an argument (the same
            // allow-list the REST row's body gate enforces on a developer token, D4).
            let request = SendMessageRequest {
                client_msg_id,
                root_id: argument_uuid(arguments, "rootId")?,
                reply_to_id: argument_uuid(arguments, "replyToId")?,
                message_type: None,
                body: Some(body),
                props: None,
                run_id: None,
                attachment_ids: None,
                routing: None,
                signature: None,
                stream: None,
                harness_refine: None,
                apps: None,
            };
            let (_created, Json(message)) = crate::routes::messages::send(
                State(state.clone()),
                Extension(principal.clone()),
                Path((workspace, channel.to_string())),
                marker(),
                Json(request),
            )
            .await?;
            encode(&message)
        }

        // L7 — `GET …/inbox`. Marks nothing read (the REST read routes are not tools).
        TOOL_INBOX => {
            let query = InboxQuery {
                filter: arguments
                    .get("filter")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                cursor: arguments
                    .get("cursor")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                limit: argument_i64(arguments, "limit").map(|limit| limit.to_string()),
                muted: None,
            };
            let Json(page) = crate::routes::inbox::list(
                State(state.clone()),
                Extension(principal.clone()),
                Path(workspace),
                Query(query),
                marker(),
            )
            .await?;
            encode(&page)
        }

        // The view only lets a catalog tool through, and the match above names every one of
        // them; a name that reaches here is a catalog entry added without an executor. It fails
        // closed as the unknown tool it is.
        _ => Err(ToolError::InvalidArguments),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_is_the_rest_rows_status_and_error_body() {
        let plain = ApiError::forbidden("not a member of this channel");
        assert_eq!(
            refusal_body(&plain),
            json!({"status": 403, "error": {"message": "not a member of this channel"}})
        );
        let coded = ApiError::coded(StatusCode::BAD_REQUEST, "dev_field_not_allowed", "no");
        assert_eq!(
            refusal_body(&coded),
            json!({"status": 400, "error": {"message": "no", "code": "dev_field_not_allowed"}})
        );
    }

    #[test]
    fn uuid_arguments_are_parsed_or_refused_never_guessed() {
        let id = Uuid::from_u128(0xabc);
        let arguments = json!({"channelId": id.to_string(), "rootId": null, "bad": "nope", "n": 1});
        assert_eq!(argument_uuid(&arguments, "channelId").unwrap(), Some(id));
        assert_eq!(argument_uuid(&arguments, "rootId").unwrap(), None);
        assert_eq!(argument_uuid(&arguments, "absent").unwrap(), None);
        assert!(argument_uuid(&arguments, "bad").is_err());
        assert!(argument_uuid(&arguments, "n").is_err());
        assert!(required_uuid(&arguments, "absent").is_err());
        assert_eq!(required_uuid(&arguments, "channelId").unwrap(), id);
    }

    #[test]
    fn a_null_argument_is_an_absent_one() {
        let arguments = json!({"cursor": null, "before": 7});
        assert!(!present(&arguments, "cursor"));
        assert!(!present(&arguments, "after"));
        assert!(present(&arguments, "before"));
        assert_eq!(argument_i64(&arguments, "before"), Some(7));
        assert_eq!(argument_i64(&arguments, "cursor"), None);
    }
}
