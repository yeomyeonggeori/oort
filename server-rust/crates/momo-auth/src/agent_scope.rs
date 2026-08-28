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
//! ## Only mounted paths are listed
//!
//! Swift's table covers surfaces that do not exist on this server yet
//! (`search/messages`, `read-state`, `/v1/mcp/drive`, `plugins`,
//! `realtime-token`, the quota-snapshot ingest). Listing a scope for a route
//! that is not mounted would be a claim this server cannot keep, so the table
//! below carries the B2.6 gateway surface, the one already-mounted route Swift
//! also allows an agent to reach (`POST …/channels/{ch}/messages`), and — since
//! #1114 mounted it — the work-control ledger's create route. Everything else
//! stays absent, which is the fail-closed answer, not a gap.

/// `GET …/gateway/jobs/pending` and the two lease verbs (Swift :211-233).
pub const SCOPE_AGENT_JOBS_READ: &str = "agent:jobs:read";
/// `POST …/agent-runs/{run}/gateway/{events,complete}` (Swift :234-243).
pub const SCOPE_AGENT_RUNS_CALLBACK: &str = "agent:runs:callback";
/// `POST …/channels/{ch}/messages` (Swift :165-173) and — since ADR-0158 증보 1
/// D7 — `PATCH …/messages/{id}`.
///
/// **One scope for both verbs, not a new one.** A slice of a growing answer is
/// the same act as the write that opened it (#1152: one turn is one message that
/// *grows*), so a second scope would mean an adapter needed two grants to post
/// one sentence and every already-issued `messages:write` token would have to be
/// re-minted before it could stream. What keeps PATCH narrow is the authorship
/// rule in the domain, not a second scope name — see [`required_agent_scope`].
pub const SCOPE_MESSAGES_WRITE: &str = "messages:write";
/// `POST …/work-controls` (Swift `AuthMiddleware.swift:152-154`).
///
/// The ack route below it in Swift's table is **not** listed here, and the
/// omission is the point: acking is the *host's* act, not the requesting
/// agent's, and an agent that could acknowledge its own dispatch could close the
/// loop on a spawn no host ever ran.
pub const SCOPE_WORK_CONTROL: &str = "work:control";
/// `POST /v1/mcp/agent-port` (ADR-0162 D2/D3, HAP-E2).
///
/// This scope opens only the protocol foundation. Product-data tools remain
/// separately scope-gated when HAP-E5 lands, and this scope is intentionally
/// absent from every default credential grant.
pub const SCOPE_AGENT_PORT_CONNECT: &str = "agent:port:connect";
/// `oort_inbox_read` on the Agent Port (ADR-0162 D3/D6, HAP-E5).
///
/// **Deliberately absent from [`required_agent_scope`]** — it names no REST
/// route, and that absence is the property: a hosted credential that carries it
/// gains one MCP tool and no HTTP surface at all, so an adapter cannot reuse the
/// grant to reach a generic endpoint. Non-default in every credential grant.
pub const SCOPE_AGENT_INBOX_READ: &str = "agent:inbox:read";
/// `GET …/channels/{ch}/messages` and `GET …/messages/{root}/replies`
/// (ADR-0173 EXT-1-READ), and `oort_conversation_read` on the Agent Port
/// (ADR-0162 D3/D6, HAP-E5).
///
/// Generic credentials that carry this grant reach those two REST reads.
/// Hosted credentials never do — `AgentBearerClass` isolates them before this
/// table is consulted. Non-default in every credential grant (ADR-0162 / D5).
pub const SCOPE_MESSAGES_READ: &str = "messages:read";

/// The scope an agent bearer must carry to reach `method path`, or `None` when
/// no agent credential may reach it at all.
///
/// Matching is on **path shape**, exactly like Swift: the segments are split and
/// the fixed positions compared, so the `{ws}`/`{agent}`/`{run}`/`{job}` slots
/// match any value and a longer or shorter path never matches by accident.
pub fn required_agent_scope(method: &str, path: &str) -> Option<&'static str> {
    let method = method.to_ascii_uppercase();
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();

    // POST /v1/mcp/agent-port — the only Agent Port transport surface.
    // GET/SSE, DELETE and any sibling path stay absent so an agent bearer cannot
    // widen the stateless HTTP contract merely by carrying this scope.
    if method == "POST" && path == "/v1/mcp/agent-port" {
        return Some(SCOPE_AGENT_PORT_CONNECT);
    }

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

    // GET /v1/workspaces/{ws}/channels/{ch}/messages — ADR-0173 EXT-1-READ.
    //
    // Same six-segment shape as the write above; the verb is what keeps the
    // two acts apart. Search, a bare message id, and every other GET stay
    // absent — this is a history page, not a read of the workspace.
    if method == "GET"
        && segments.len() == 6
        && segments[0] == "v1"
        && segments[1] == "workspaces"
        && segments[3] == "channels"
        && segments[5] == "messages"
    {
        return Some(SCOPE_MESSAGES_READ);
    }

    // GET /v1/workspaces/{ws}/channels/{ch}/messages/{root}/replies
    //
    // The thread page shares the history membership gate, so it shares the
    // scope. A shorter or longer path (the message itself, a nested extra
    // segment) is a different surface and stays closed.
    if method == "GET"
        && segments.len() == 8
        && segments[0] == "v1"
        && segments[1] == "workspaces"
        && segments[3] == "channels"
        && segments[5] == "messages"
        && segments[7] == "replies"
    {
        return Some(SCOPE_MESSAGES_READ);
    }

    // PATCH /v1/workspaces/{ws}/messages/{id} — ADR-0158 증보 1 D7.
    //
    // **The gap this closes, and why it went unnoticed.** Swift's table listed
    // the POST and nothing else, and #1152/#1173 proved the streaming contract
    // with a *human* login, so nobody asked whether the credential an adapter
    // actually holds could write the slices. It could not. That is the literal
    // reason the prime spike posted 17 separate messages for one 3,661-character
    // answer: `POST` was the only door open to it.
    //
    // ## Why PATCH and not DELETE, on a route that serves both
    //
    // The same path serves `DELETE` (`routes::messages::delete_message`), and
    // matching on the method rather than the path is what keeps that door shut.
    // Continuing one's own sentence and retracting it are different acts: an
    // adapter must be able to do the first to stream at all, and nothing about
    // streaming requires the second. Fail-closed means the verb is named, not
    // the resource.
    //
    // ## What actually keeps this narrow
    //
    // The scope grants *reachability*, never authority. Authorship is decided in
    // the domain — `momo_messaging::interaction`'s two edit paths both refuse a
    // non-author with `NotAuthorForEdit` **before** they look at anything else,
    // and the actor they compare against is the credential's member, which no
    // request body can assert. So an agent bearer reaching this route can still
    // only continue a message it wrote itself, and that rule is the same one a
    // human is held to rather than a parallel one written for agents.
    if method == "PATCH"
        && segments.len() == 5
        && segments[0] == "v1"
        && segments[1] == "workspaces"
        && segments[3] == "messages"
    {
        return Some(SCOPE_MESSAGES_WRITE);
    }

    // POST /v1/workspaces/{ws}/work-controls
    if method == "POST"
        && segments.len() == 4
        && segments[0] == "v1"
        && segments[1] == "workspaces"
        && segments[3] == "work-controls"
    {
        return Some(SCOPE_WORK_CONTROL);
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
        assert_eq!(
            required_agent_scope("POST", &format!("/v1/workspaces/{WS}/work-controls")),
            Some(SCOPE_WORK_CONTROL)
        );
    }

    #[test]
    fn agent_port_is_one_post_only_scope() {
        assert_eq!(
            required_agent_scope("POST", "/v1/mcp/agent-port"),
            Some(SCOPE_AGENT_PORT_CONNECT)
        );
        for method in ["GET", "DELETE", "PUT", "PATCH"] {
            assert_eq!(
                required_agent_scope(method, "/v1/mcp/agent-port"),
                None,
                "{method} must not open a second Agent Port transport"
            );
        }
        for path in [
            "/v1/mcp/agent-port/",
            "/v1/mcp/agent-port/tools",
            "/v1/mcp/drive",
            "/v1/mcp/agent-port-evil",
        ] {
            assert_eq!(required_agent_scope("POST", path), None, "{path}");
        }
    }

    /// **ADR-0158 증보 1 D7 — the slice door.**
    ///
    /// One turn is one message that grows (#1152), so the write that opens a
    /// streamed answer and the writes that continue it are the same act and
    /// carry the same scope. Without this the prime spike's 17-messages-per-turn
    /// shape was not a design choice, it was the only door open.
    #[test]
    fn an_agent_may_continue_its_own_streamed_answer() {
        assert_eq!(
            required_agent_scope("PATCH", &format!("/v1/workspaces/{WS}/messages/{RUN}")),
            Some(SCOPE_MESSAGES_WRITE),
            "an adapter must be able to write the slices of the answer it opened"
        );
        // Case-insensitive on the method, like every other row.
        assert_eq!(
            required_agent_scope("patch", &format!("/v1/workspaces/{WS}/messages/{RUN}")),
            Some(SCOPE_MESSAGES_WRITE)
        );
    }

    /// **The verb is named, not the resource** — D7 opened PATCH and nothing else
    /// on a path that serves two methods and has three sub-surfaces.
    ///
    /// Continuing one's own sentence is what streaming needs; retracting it,
    /// reacting to it and pinning it are not, and each of them would be a
    /// separate claim about what an adapter credential may do to a channel's
    /// record. A shape match on the path alone would have granted all four.
    #[test]
    fn the_slice_door_opens_for_patch_alone() {
        for method in ["DELETE", "GET", "PUT", "POST"] {
            assert_eq!(
                required_agent_scope(method, &format!("/v1/workspaces/{WS}/messages/{RUN}")),
                None,
                "{method} on a message is not a slice of a growing answer"
            );
        }
        // The sub-surfaces hanging off the same prefix stay shut: they are
        // longer paths, and length is part of the match.
        for path in [
            format!("/v1/workspaces/{WS}/messages/{RUN}/reactions/%F0%9F%91%8D"),
            format!("/v1/workspaces/{WS}/messages/{RUN}/pin"),
        ] {
            for method in ["PATCH", "PUT", "DELETE", "POST"] {
                assert_eq!(required_agent_scope(method, &path), None, "{method} {path}");
            }
        }
        // Shape traps either side of the five-segment edit route.
        assert_eq!(
            required_agent_scope("PATCH", &format!("/v1/workspaces/{WS}/messages")),
            None
        );
        assert_eq!(
            required_agent_scope("PATCH", &format!("/v1/workspaces/{WS}/search/messages")),
            None,
            "`messages` in the wrong slot is a different surface"
        );
    }

    /// The half of the work-control surface an agent must NOT reach.
    ///
    /// Requesting a control and acknowledging it are two different actors'
    /// acts. If one credential could do both, an agent could report that a host
    /// had spawned a session the host never saw — and `work_control` is the
    /// ledger every later `input`/`kill` checks its lineage against.
    #[test]
    fn an_agent_may_request_a_control_but_never_acknowledge_one() {
        assert_eq!(
            required_agent_scope(
                "POST",
                &format!("/v1/workspaces/{WS}/work-controls/{RUN}/ack")
            ),
            None
        );
        for path in [
            format!("/v1/workspaces/{WS}/work-auto-approvals"),
            format!("/v1/workspaces/{WS}/work-auto-approvals/codex"),
        ] {
            for method in ["GET", "PUT", "DELETE", "POST"] {
                assert_eq!(
                    required_agent_scope(method, &path),
                    None,
                    "auto-approval is the human host owner's setting"
                );
            }
        }
        // Shape trap: the create route is exactly four segments.
        assert_eq!(
            required_agent_scope("GET", &format!("/v1/workspaces/{WS}/work-controls")),
            None
        );
    }

    /// The fail-closed half, and the reason this is a list rather than a filter:
    /// anything unlisted stays unreachable. ADR-0173 opened the two history
    /// GETs; a single-message GET and every other neighbour stay closed.
    #[test]
    fn an_unlisted_route_is_unreachable_with_an_agent_bearer() {
        for (method, path) in [
            // the run-creation surface is human-only (`requireHumanPrincipal`)
            (
                "POST",
                format!("/v1/workspaces/{WS}/channels/{RUN}/agent-runs"),
            ),
            // a single message is not the history page ADR-0173 opened
            (
                "GET",
                format!("/v1/workspaces/{WS}/channels/{RUN}/messages/{AGENT}"),
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

    /// **ADR-0173 — `messages:read` opens the two history GETs, and nothing else.**
    ///
    /// `agent:inbox:read` still names no REST route. Hosted credentials never
    /// consult this table on these paths (`AgentBearerClass` preflight), so
    /// mapping the scope here does not recreate a generic principal for them.
    #[test]
    fn messages_read_opens_only_the_two_history_gets() {
        assert_eq!(
            required_agent_scope(
                "GET",
                &format!("/v1/workspaces/{WS}/channels/{RUN}/messages")
            ),
            Some(SCOPE_MESSAGES_READ)
        );
        assert_eq!(
            required_agent_scope(
                "GET",
                &format!("/v1/workspaces/{WS}/channels/{RUN}/messages/{AGENT}/replies")
            ),
            Some(SCOPE_MESSAGES_READ)
        );
        assert_eq!(
            required_agent_scope(
                "get",
                &format!("/v1/workspaces/{WS}/channels/{RUN}/messages")
            ),
            Some(SCOPE_MESSAGES_READ)
        );
        for (method, path) in [
            (
                "GET",
                format!("/v1/workspaces/{WS}/channels/{RUN}/messages/{AGENT}"),
            ),
            (
                "POST",
                format!("/v1/workspaces/{WS}/channels/{RUN}/messages/{AGENT}/replies"),
            ),
            (
                "GET",
                format!("/v1/workspaces/{WS}/channels/{RUN}/messages/{AGENT}/replies/extra"),
            ),
            ("POST", "/v1/mcp/agent-port".to_string()),
            ("GET", format!("/v1/workspaces/{WS}/agents/{AGENT}/inbox")),
        ] {
            assert_ne!(
                required_agent_scope(method, &path),
                Some(SCOPE_MESSAGES_READ),
                "{method} {path}"
            );
            assert_ne!(
                required_agent_scope(method, &path),
                Some(SCOPE_AGENT_INBOX_READ),
                "{method} {path}"
            );
        }
        for scope in [SCOPE_MESSAGES_READ, SCOPE_AGENT_INBOX_READ] {
            assert_ne!(scope, SCOPE_MESSAGES_WRITE);
            assert_ne!(scope, SCOPE_AGENT_PORT_CONNECT);
        }
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
