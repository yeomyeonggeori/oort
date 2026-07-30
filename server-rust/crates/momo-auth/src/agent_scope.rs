//! The route→scope allow-list for agent bearers (Swift
//! `AuthMiddleware.requiredAgentScope`, `AuthMiddleware.swift:142-251`).
//!
//! ## The default is "no"
//!
//! Swift's comment on the function is the contract: *"Unknown routes return nil
//! and are therefore unavailable to agent bearers."* An agent credential does not
//! reach a protected surface merely by having a bearer shape — it reaches
//! exactly the paths named here, and only when the row carries the named scope.
//! Porting this as a closed list (rather than "agents may do what humans may do
//! minus X") is what keeps a new human route from being silently agent-reachable
//! the day it is mounted.
//!
//! ## Only this batch's paths are listed
//!
//! Swift's table covers surfaces that do not exist on this server yet
//! (`work-controls`, `search/messages`, `read-state`, `/v1/mcp/drive`,
//! `plugins`, `realtime-token`, the quota-snapshot ingest). Listing a scope for
//! a route that is not mounted would be a claim this server cannot keep, so the
//! table below carries the B2.6 gateway surface plus the one already-mounted
//! route Swift also allows an agent to reach (`POST …/channels/{ch}/messages`).
//! Everything else stays absent — which is the fail-closed answer, not a gap.

/// `GET …/gateway/jobs/pending` and the two lease verbs (Swift :211-233).
pub const SCOPE_AGENT_JOBS_READ: &str = "agent:jobs:read";
/// `POST …/agent-runs/{run}/gateway/{events,complete}` (Swift :234-243).
pub const SCOPE_AGENT_RUNS_CALLBACK: &str = "agent:runs:callback";
/// `POST …/channels/{ch}/messages` (Swift :165-173).
pub const SCOPE_MESSAGES_WRITE: &str = "messages:write";

/// The scope an agent bearer must carry to reach `method path`, or `None` when
/// no agent credential may reach it at all.
///
/// Matching is on **path shape**, exactly like Swift: the segments are split and
/// the fixed positions compared, so the `{ws}`/`{agent}`/`{run}`/`{job}` slots
/// match any value and a longer or shorter path never matches by accident.
pub fn required_agent_scope(method: &str, path: &str) -> Option<&'static str> {
    let method = method.to_ascii_uppercase();
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();

    // POST /v1/workspaces/{ws}/channels/{ch}/messages
    if method == "POST"
        && segments.len() == 6
        && segments[0] == "v1"
        && segments[1] == "workspaces"
        && segments[3] == "channels"
        && segments[5] == "messages"
    {
        return Some(SCOPE_MESSAGES_WRITE);
    }

    // GET /v1/workspaces/{ws}/agents/{agent}/gateway/jobs/pending
    if method == "GET"
        && segments.len() == 8
        && segments[0] == "v1"
        && segments[1] == "workspaces"
        && segments[3] == "agents"
        && segments[5] == "gateway"
        && segments[6] == "jobs"
        && segments[7] == "pending"
    {
        return Some(SCOPE_AGENT_JOBS_READ);
    }

    // POST /v1/workspaces/{ws}/agents/{agent}/gateway/jobs/{job}/lease/{renew|release}
    if method == "POST"
        && segments.len() == 10
        && segments[0] == "v1"
        && segments[1] == "workspaces"
        && segments[3] == "agents"
        && segments[5] == "gateway"
        && segments[6] == "jobs"
        && segments[8] == "lease"
        && (segments[9] == "renew" || segments[9] == "release")
    {
        return Some(SCOPE_AGENT_JOBS_READ);
    }

    // POST /v1/workspaces/{ws}/agent-runs/{run}/gateway/{events|complete}
    if method == "POST"
        && segments.len() == 7
        && segments[0] == "v1"
        && segments[1] == "workspaces"
        && segments[3] == "agent-runs"
        && segments[5] == "gateway"
        && (segments[6] == "events" || segments[6] == "complete")
    {
        return Some(SCOPE_AGENT_RUNS_CALLBACK);
    }

    None
}

/// Is this one of the **gateway callback** routes — the surface a gateway
/// runtime calls back on, rather than a member surface an agent may also reach?
///
/// The distinction exists for the deprecated shared secret. That credential
/// identifies *the gateway process*, not a member, so it can only ever stand in
/// on the callback surface — which is exactly where Swift's `gatewayPrincipal`
/// (`AgentGatewayRoutes.swift:1421-1436`) tolerates a nil principal. Every other
/// route calls `requirePrincipal()` and 401s, so restricting the secret to this
/// set changes no answer; it only makes the restriction structural instead of
/// depending on each handler remembering to ask.
pub fn is_gateway_callback_route(method: &str, path: &str) -> bool {
    matches!(
        required_agent_scope(method, path),
        Some(SCOPE_AGENT_JOBS_READ | SCOPE_AGENT_RUNS_CALLBACK)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const WS: &str = "5b1f4a2e-0000-4000-8000-000000000001";
    const AGENT: &str = "5b1f4a2e-0000-4000-8000-000000000002";
    const RUN: &str = "5b1f4a2e-0000-4000-8000-000000000003";

    #[test]
    fn the_gateway_surface_maps_to_the_swift_scopes() {
        assert_eq!(
            required_agent_scope(
                "GET",
                &format!("/v1/workspaces/{WS}/agents/{AGENT}/gateway/jobs/pending")
            ),
            Some(SCOPE_AGENT_JOBS_READ)
        );
        for verb in ["renew", "release"] {
            assert_eq!(
                required_agent_scope(
                    "POST",
                    &format!("/v1/workspaces/{WS}/agents/{AGENT}/gateway/jobs/42/lease/{verb}")
                ),
                Some(SCOPE_AGENT_JOBS_READ)
            );
        }
        for verb in ["events", "complete"] {
            assert_eq!(
                required_agent_scope(
                    "POST",
                    &format!("/v1/workspaces/{WS}/agent-runs/{RUN}/gateway/{verb}")
                ),
                Some(SCOPE_AGENT_RUNS_CALLBACK),
            );
        }
        assert_eq!(
            required_agent_scope(
                "POST",
                &format!("/v1/workspaces/{WS}/channels/{RUN}/messages")
            ),
            Some(SCOPE_MESSAGES_WRITE)
        );
    }

    /// The fail-closed half, and the reason this is a list rather than a filter:
    /// anything unlisted — including the *reads* that sit next to the listed
    /// writes — is unreachable with an agent credential.
    #[test]
    fn an_unlisted_route_is_unreachable_with_an_agent_bearer() {
        for (method, path) in [
            // the run-creation surface is human-only (`requireHumanPrincipal`)
            (
                "POST",
                format!("/v1/workspaces/{WS}/channels/{RUN}/agent-runs"),
            ),
            // reading a channel's history is not a listed agent capability
            (
                "GET",
                format!("/v1/workspaces/{WS}/channels/{RUN}/messages"),
            ),
            // billing surfaces are never agent-reachable
            ("GET", format!("/v1/workspaces/{WS}/usage/summary")),
            ("POST", format!("/v1/admin/workspaces/{WS}/credits/topups")),
            ("POST", "/v1/auth/login".to_string()),
            // shape traps: one segment too few / too many must not match
            (
                "GET",
                format!("/v1/workspaces/{WS}/agents/{AGENT}/gateway/jobs"),
            ),
            (
                "GET",
                format!("/v1/workspaces/{WS}/agents/{AGENT}/gateway/jobs/pending/extra"),
            ),
            // the right shape with the wrong verb
            (
                "GET",
                format!("/v1/workspaces/{WS}/agent-runs/{RUN}/gateway/complete"),
            ),
            (
                "POST",
                format!("/v1/workspaces/{WS}/agent-runs/{RUN}/gateway/cancel"),
            ),
        ] {
            assert_eq!(
                required_agent_scope(method, &path),
                None,
                "{method} {path} must not be reachable with an agent bearer"
            );
        }
    }

    /// The shared secret stands in for a gateway process, so it may only reach
    /// the callback surface — never a member surface an agent bearer can also use.
    #[test]
    fn the_callback_surface_excludes_the_member_surfaces() {
        assert!(is_gateway_callback_route(
            "GET",
            &format!("/v1/workspaces/{WS}/agents/{AGENT}/gateway/jobs/pending")
        ));
        assert!(is_gateway_callback_route(
            "POST",
            &format!("/v1/workspaces/{WS}/agent-runs/{RUN}/gateway/complete")
        ));
        assert!(
            !is_gateway_callback_route(
                "POST",
                &format!("/v1/workspaces/{WS}/channels/{RUN}/messages")
            ),
            "speaking in a channel is a member act; a process secret must not do it"
        );
        assert!(!is_gateway_callback_route(
            "GET",
            &format!("/v1/workspaces/{WS}/usage/summary")
        ));
    }

    #[test]
    fn the_method_comparison_is_case_insensitive_like_swift() {
        assert_eq!(
            required_agent_scope(
                "post",
                &format!("/v1/workspaces/{WS}/agent-runs/{RUN}/gateway/complete")
            ),
            Some(SCOPE_AGENT_RUNS_CALLBACK)
        );
    }
}
