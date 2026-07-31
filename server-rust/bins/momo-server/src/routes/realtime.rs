//! The two halves of the realtime rail's authorization (B4).
//!
//!   `POST /v1/auth/realtime-token`   — protected; mints the connection token.
//!   `POST /v1/centrifugo/subscribe`  — public path, proxy-secret authenticated;
//!                                      allows or denies ONE subscription.
//!
//! Together they are what makes `clients/web/src/lib/realtime.ts` work at all:
//! `createRealtime` hands `fetchRealtimeToken` to centrifuge-js as its
//! `getToken`, and every `ch:`/`agent:` subscribe then goes through the proxy
//! because `infra/centrifugo.json` sets `subscribe_proxy_enabled` on those
//! namespaces. Before this batch the Rust server served neither, so a client
//! could log in and read history but the live rail never opened
//! (`infra/rust/docker-compose.rust.yml:71-75` says as much: "the subscribe
//! proxy is inert until the Rust api serves /v1/centrifugo/subscribe").
//!
//! ## Why the authorization lives in the proxy and not in the token
//!
//! The connection token could have carried a channel list — Centrifugo supports
//! that. It deliberately does not (Swift `JWT.swift:157-160`). A token is a
//! bearer valid for its whole TTL, so channels baked into one would keep an
//! evicted member subscribed until it expired. Asking per subscribe means
//! **eviction takes effect immediately** (L4 §C4), which is the only version of
//! "removed from the channel" that is true.
//!
//! ## The three checks a subscribe passes, in order
//!
//! 1. **Proxy authentication.** `X-Centrifugo-Proxy-Secret`, compared in
//!    constant time, before the body is parsed at all. Network position is not
//!    an authenticator: anything that can reach the api container could
//!    otherwise forge a subscribe decision for any member.
//! 2. **Credential liveness.** `meta.token_id` names the credential the
//!    connection token was minted from; `has_active_realtime_credential`
//!    re-reads that row. This is what makes a logout cut the rail.
//! 3. **The channel's own rule.** `ch:`/`dm:` = live channel membership.
//!    `agent:` = observer and agent are BOTH live members of that exact channel.
//!    `agentwork:` = only that agent, and only while it is active.
//!
//! Everything unrecognised fails closed with a deny, never an allow.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::{Extension, Json};
use momo_auth::{
    has_active_realtime_credential, sign_centrifugo_connection, Principal, PrincipalKind,
    SCOPE_REALTIME_SUBSCRIBE,
};
use momo_db::{with_tenant_tx, DbError};
use momo_messaging::{can_observe_agent, get_member, is_active_agent, is_channel_member};
use uuid::Uuid;

use crate::config::constant_time_eq;
use crate::dto::{RealtimeTokenResponse, SubscribeProxyRequest, SubscribeProxyResponse};
use crate::error::ApiError;
use crate::AppState;

/// The header Centrifugo attaches to every proxy callback
/// (`infra/centrifugo.json` → `channel.proxy.subscribe.http.static_headers`,
/// overridden per deployment by `CENT_PROXY_SECRET`).
pub const PROXY_SECRET_HEADER: &str = "x-centrifugo-proxy-secret";

/// The `tokenType` this server advertises (Swift `AuthRoutes.realtimeToken` :334).
const CONNECTION_TOKEN_TYPE: &str = "centrifugo.connection.jwt";

// ---------------------------------------------------------------------------
// POST /v1/auth/realtime-token
// ---------------------------------------------------------------------------

/// The scope a principal must hold to open a realtime connection (Swift
/// :311-313): an agent needs `realtime:subscribe`, a human needs the read scope
/// it already got at login.
fn required_scope(kind: PrincipalKind) -> &'static str {
    match kind {
        PrincipalKind::Agent => SCOPE_REALTIME_SUBSCRIBE,
        PrincipalKind::Human | PrincipalKind::WorkHost => "messages:read",
    }
}

pub async fn issue_token(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<RealtimeTokenResponse>, ApiError> {
    // Fail closed on an instance that never configured the broker: no baked-in
    // secret, so there is nothing to sign with and nothing to guess.
    let Some(cent_token_hmac) = state.realtime.cent_token_hmac.clone() else {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "realtime is not configured on this server",
        ));
    };

    let scope = required_scope(principal.kind);
    if !principal.scopes.iter().any(|held| held == scope) {
        return Err(ApiError::forbidden(format!("{scope} scope required")));
    }

    // A credential can outlive the member it names (a suspension does not
    // revoke tokens). Swift re-checks the member here for exactly that reason.
    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;
    let active = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            Ok::<bool, DbError>(
                get_member(conn, member_id)
                    .await?
                    .is_some_and(|member| member.status == "active"),
            )
        })
    })
    .await
    .map_err(|error| ApiError::internal("realtime.member_state", error))?;
    if !active {
        return Err(ApiError::forbidden(
            "member is not active in this workspace",
        ));
    }

    // The binding that lets the subscribe proxy re-check this session. A
    // principal with no `token_id` never authenticated against a `token` row, so
    // there would be nothing to revoke — refuse rather than mint an unbindable
    // connection.
    let credential_token_id = principal
        .token_id
        .ok_or_else(|| ApiError::forbidden("credential cannot be bound to a realtime session"))?;

    let issued = sign_centrifugo_connection(
        member_id,
        workspace_id,
        credential_token_id,
        state.realtime.connection_token_ttl_seconds,
        &cent_token_hmac,
    )
    .map_err(|error| ApiError::internal("realtime.sign", error))?;

    Ok(Json(RealtimeTokenResponse {
        token: issued.token,
        token_type: CONNECTION_TOKEN_TYPE,
        expires_at_ms: issued.expires_at.saturating_mul(1000),
        ttl_seconds: issued.ttl_seconds,
        // Swift renders both through `uuidString` (UPPERCASE); clients compare
        // ids case-insensitively, but the casing is still the contract.
        workspace_id: workspace_id.to_string().to_uppercase(),
        member_id: member_id.to_string().to_uppercase(),
    }))
}

// ---------------------------------------------------------------------------
// POST /v1/centrifugo/subscribe
// ---------------------------------------------------------------------------

/// A parsed Centrifugo channel name (Swift `CentrifugoRoutes.ParsedChannel`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParsedChannel {
    /// `ch:ws<WS>.<CHANNEL>` / `dm:ws<WS>.<CHANNEL>` — the message rail.
    Channel { workspace: Uuid, channel: Uuid },
    /// `agent:ws<WS>.<CHANNEL>.<AGENT>` — observable progress, per channel.
    Agent {
        workspace: Uuid,
        channel: Uuid,
        agent_member: Uuid,
    },
    /// `agentwork:ws<WS>.<AGENT>` — the agent's PRIVATE job stream.
    AgentWork { workspace: Uuid, agent_member: Uuid },
}

impl ParsedChannel {
    pub fn workspace_id(self) -> Uuid {
        match self {
            ParsedChannel::Channel { workspace, .. }
            | ParsedChannel::Agent { workspace, .. }
            | ParsedChannel::AgentWork { workspace, .. } => workspace,
        }
    }

    /// The message a denial carries. Deliberately about the *relationship*, not
    /// about whether the channel exists.
    pub fn deny_reason(self) -> &'static str {
        match self {
            ParsedChannel::Channel { .. } => "not a member of this channel",
            ParsedChannel::Agent { .. } => "not allowed to observe this agent",
            ParsedChannel::AgentWork { .. } => "not allowed to consume this agent work stream",
        }
    }
}

/// Parse `<namespace>:ws<UUID>.<UUID>[.<UUID>]`. Ports Swift
/// `CentrifugoRoutes.parseChannel` (:224-253) including its legacy `ch:.<uuid>`
/// fallback, and its refusal of every other shape.
///
/// `agentwork` is a *separate* namespace from `agent` on purpose: one is the
/// observable progress rail any co-member may watch, the other is the private
/// job stream only the agent itself may read. Collapsing them would hand an
/// observer the agent's work queue.
pub fn parse_channel(name: &str) -> Option<ParsedChannel> {
    let (namespace, body) = name.split_once(':')?;
    let after_ws = body.strip_prefix("ws")?;
    let segments: Vec<&str> = after_ws.split('.').collect();

    if segments.len() >= 2 {
        if let Ok(workspace) = Uuid::parse_str(segments[0]) {
            return match namespace {
                "ch" | "dm" if segments.len() == 2 => {
                    let channel = Uuid::parse_str(segments[1]).ok()?;
                    Some(ParsedChannel::Channel { workspace, channel })
                }
                "agent" if segments.len() == 3 => {
                    let channel = Uuid::parse_str(segments[1]).ok()?;
                    let agent_member = Uuid::parse_str(segments[2]).ok()?;
                    Some(ParsedChannel::Agent {
                        workspace,
                        channel,
                        agent_member,
                    })
                }
                "agentwork" if segments.len() == 2 => {
                    let agent_member = Uuid::parse_str(segments[1]).ok()?;
                    Some(ParsedChannel::AgentWork {
                        workspace,
                        agent_member,
                    })
                }
                _ => None,
            };
        }
    }

    // Legacy `ch:ws.<channel>` from pre-bootstrap demo clients. Kept because
    // Swift keeps it; runtime e2e uses the workspace-qualified form.
    if matches!(namespace, "ch" | "dm") && segments.len() == 2 && segments[0].is_empty() {
        let channel = Uuid::parse_str(segments[1]).ok()?;
        return Some(ParsedChannel::Channel {
            workspace: crate::routes::auth_routes::DEMO_WORKSPACE_ID,
            channel,
        });
    }
    None
}

/// The subscribe-proxy callback.
///
/// Returns `Result<Json<…>, ApiError>` where the **error** arm is reserved for
/// "this caller is not Centrifugo" (401) and a genuine server fault (500).
/// Every authorization outcome — including every refusal — is a 200 carrying
/// the protocol's allow/deny envelope.
pub async fn subscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<SubscribeProxyResponse>, ApiError> {
    // (1) Authenticate the caller BEFORE the body is trusted or parsed.
    let Some(expected) = state.realtime.cent_proxy_secret.as_deref() else {
        tracing::warn!("centrifugo subscribe proxy called but CENT_PROXY_SECRET is unset; denying");
        return Err(ApiError::unauthorized("invalid or missing proxy secret"));
    };
    let presented = headers
        .get(PROXY_SECRET_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !constant_time_eq(presented, expected) {
        tracing::warn!("centrifugo subscribe proxy: missing/invalid proxy secret");
        return Err(ApiError::unauthorized("invalid or missing proxy secret"));
    }

    let request: SubscribeProxyRequest = serde_json::from_slice(&body)
        .map_err(|_| ApiError::bad_request("malformed subscribe proxy request"))?;

    // (2) Shape. An unknown channel name is denied, never allowed by default.
    let Some(parsed) = parse_channel(&request.channel) else {
        return Ok(Json(SubscribeProxyResponse::deny("unrecognized channel")));
    };
    let Some(user_member_id) = request
        .user
        .as_deref()
        .and_then(|raw| Uuid::parse_str(raw).ok())
    else {
        return Ok(Json(SubscribeProxyResponse::deny(
            "missing or invalid user",
        )));
    };
    let Some(token_id) = request
        .meta
        .as_ref()
        .and_then(|meta| meta.token_id.as_deref())
        .and_then(|raw| Uuid::parse_str(raw).ok())
    else {
        // A connection token minted before the binding existed, or a client
        // connecting without one. Fail closed: without the binding a revoked
        // credential would be indistinguishable from a live one.
        return Ok(Json(SubscribeProxyResponse::deny(
            "missing or invalid realtime credential binding",
        )));
    };

    let workspace_id = parsed.workspace_id();
    // (3) Liveness + the channel's own rule, in ONE tenant transaction so a
    // revocation cannot land between the two reads and leave a subscribe
    // authorized by a credential that is already dead.
    let decision = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if !has_active_realtime_credential(conn, token_id, user_member_id, workspace_id)
                .await
                .map_err(DbError::from)?
            {
                return Ok::<Option<bool>, DbError>(None);
            }
            let allowed = match parsed {
                ParsedChannel::Channel { channel, .. } => {
                    is_channel_member(conn, channel, user_member_id).await?
                }
                ParsedChannel::Agent {
                    channel,
                    agent_member,
                    ..
                } => {
                    can_observe_agent(conn, user_member_id, agent_member, channel, workspace_id)
                        .await?
                }
                ParsedChannel::AgentWork { agent_member, .. } => {
                    // The private job stream: the subscriber must BE the agent.
                    user_member_id == agent_member
                        && is_active_agent(conn, agent_member, workspace_id).await?
                }
            };
            Ok(Some(allowed))
        })
    })
    .await
    .map_err(|error| ApiError::internal("centrifugo.subscribe", error))?;

    Ok(Json(match decision {
        None => SubscribeProxyResponse::deny("realtime credential is no longer active"),
        Some(true) => SubscribeProxyResponse::allow(),
        Some(false) => SubscribeProxyResponse::deny(parsed.deny_reason()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_messaging::cent_channel;

    /// The connection token's `sub` IS Centrifugo's user id, and the read-state
    /// rail publishes to a **user-limited** channel (`user:read-state#<MEMBER>`,
    /// `allow_user_limited_channels` in `infra/centrifugo.json`). Centrifugo
    /// authorizes those itself by comparing the suffix to `sub` **byte for
    /// byte** — no proxy callback is involved, so nothing in this file could
    /// rescue a casing mismatch. A lowercase `sub` would silently deny every
    /// member their own unread rail.
    #[test]
    fn the_connection_subject_matches_the_user_limited_channel_suffix() {
        let member = Uuid::new_v4();
        let issued = momo_auth::sign_centrifugo_connection(
            member,
            Uuid::new_v4(),
            Uuid::new_v4(),
            60,
            "cent-secret",
        )
        .expect("sign");
        let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
        validation.validate_exp = false;
        let claims = jsonwebtoken::decode::<momo_auth::CentrifugoConnectionClaims>(
            &issued.token,
            &jsonwebtoken::DecodingKey::from_secret(b"cent-secret"),
            &validation,
        )
        .expect("decode")
        .claims;
        let personal = momo_messaging::read_state_channel(member);
        let suffix = personal.split('#').nth(1).expect("user-limited suffix");
        assert_eq!(
            claims.sub, suffix,
            "Centrifugo compares the `#` suffix to `sub` verbatim"
        );
    }

    #[test]
    fn the_scope_gate_splits_humans_from_agents() {
        assert_eq!(required_scope(PrincipalKind::Human), "messages:read");
        assert_eq!(
            required_scope(PrincipalKind::Agent),
            SCOPE_REALTIME_SUBSCRIBE
        );
    }

    /// The name the relay bakes into every broadcast must parse back to the same
    /// ids. If these two drift, the client subscribes to a channel the proxy
    /// cannot recognise and the rail is silent with no error anywhere.
    #[test]
    fn the_relays_channel_name_round_trips_through_the_parser() {
        let workspace = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let name = cent_channel(workspace, channel);
        assert_eq!(
            parse_channel(&name),
            Some(ParsedChannel::Channel { workspace, channel }),
            "{name}"
        );
    }

    /// The web client builds these two by hand
    /// (`clients/web/src/lib/realtime.ts:73-78,155-161`); uppercase ids and all.
    #[test]
    fn the_web_clients_channel_names_parse() {
        let workspace = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let agent = Uuid::new_v4();
        let ch = format!(
            "ch:ws{}.{}",
            workspace.to_string().to_uppercase(),
            channel.to_string().to_uppercase()
        );
        assert_eq!(
            parse_channel(&ch),
            Some(ParsedChannel::Channel { workspace, channel })
        );
        let agent_name = format!(
            "agent:ws{}.{}.{}",
            workspace.to_string().to_uppercase(),
            channel.to_string().to_uppercase(),
            agent.to_string().to_uppercase()
        );
        assert_eq!(
            parse_channel(&agent_name),
            Some(ParsedChannel::Agent {
                workspace,
                channel,
                agent_member: agent,
            })
        );
    }

    #[test]
    fn agentwork_is_a_separate_namespace_from_agent() {
        let workspace = Uuid::new_v4();
        let agent = Uuid::new_v4();
        assert_eq!(
            parse_channel(&format!("agentwork:ws{workspace}.{agent}")),
            Some(ParsedChannel::AgentWork {
                workspace,
                agent_member: agent,
            })
        );
        // The agent namespace needs three segments; two must not be read as a
        // work stream (or vice versa).
        assert_eq!(parse_channel(&format!("agent:ws{workspace}.{agent}")), None);
        let channel = Uuid::new_v4();
        assert_eq!(
            parse_channel(&format!("agentwork:ws{workspace}.{channel}.{agent}")),
            None
        );
    }

    #[test]
    fn every_unrecognised_shape_fails_closed() {
        let workspace = Uuid::new_v4();
        let channel = Uuid::new_v4();
        for name in [
            "",
            "ch",
            "ch:",
            "nope:ws00000000-0000-7000-8000-000000000001.x",
            &format!("ch:{workspace}.{channel}"), // missing the `ws` prefix
            &format!("ch:ws{workspace}.not-a-uuid"),
            &format!("ch:wsnot-a-uuid.{channel}"),
            &format!("$:ws{workspace}.{channel}"),
        ] {
            assert_eq!(parse_channel(name), None, "{name} must not parse");
        }
    }

    /// The legacy demo form Swift still accepts, kept so a pre-bootstrap client
    /// is not silently disconnected by the port.
    #[test]
    fn the_legacy_demo_channel_form_still_parses() {
        let channel = Uuid::new_v4();
        assert_eq!(
            parse_channel(&format!("ch:ws.{channel}")),
            Some(ParsedChannel::Channel {
                workspace: crate::routes::auth_routes::DEMO_WORKSPACE_ID,
                channel,
            })
        );
    }

    /// The protocol shape: an allow is `{"result":{}}` and a deny is
    /// `{"error":{...}}` — never a bare `{}`, which Centrifugo would read as an
    /// allow with no result.
    #[test]
    fn the_proxy_envelope_is_the_centrifugo_protocol() {
        let allow = serde_json::to_value(SubscribeProxyResponse::allow()).expect("allow");
        assert!(allow.get("result").is_some(), "{allow}");
        assert!(allow.get("error").is_none(), "{allow}");

        let deny = serde_json::to_value(SubscribeProxyResponse::deny("nope")).expect("deny");
        assert!(deny.get("result").is_none(), "{deny}");
        assert_eq!(deny["error"]["code"], 403);
        assert_eq!(deny["error"]["message"], "nope");
    }

    #[test]
    fn deny_reasons_do_not_reveal_whether_the_target_exists() {
        let workspace = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let agent = Uuid::new_v4();
        assert_eq!(
            ParsedChannel::Channel { workspace, channel }.deny_reason(),
            "not a member of this channel"
        );
        assert_eq!(
            ParsedChannel::Agent {
                workspace,
                channel,
                agent_member: agent
            }
            .deny_reason(),
            "not allowed to observe this agent"
        );
        assert_eq!(
            ParsedChannel::AgentWork {
                workspace,
                agent_member: agent
            }
            .deny_reason(),
            "not allowed to consume this agent work stream"
        );
    }
}
