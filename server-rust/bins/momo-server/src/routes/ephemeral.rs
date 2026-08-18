//! 「작성 중」 — the 휘발 신호 surface (ADR-0149, goal SRV-T2).
//!
//!   `POST /v1/workspaces/{ws}/channels/{ch}/typing/grant` — ONE membership read
//!   `POST /v1/workspaces/{ws}/channels/{ch}/typing`       — publish, **Postgres untouched**
//!
//! ## Why this is two routes and not one
//!
//! ADR-0149 asks for two things that read like a contradiction:
//!
//! > 가드 3: **PG 접근 금지를 테스트로 못박는다.** 휘발 경로 처리 중 **쿼리 0건**을 단언한다.
//! >
//! > RLS FORCE | **주의** — PG를 안 거치므로 RLS가 격리를 강제해 주지 않는다.
//! > **채널 구독 권한 검사를 발행 시점에 직접 해야 한다.**
//!
//! "Is this member in this channel" is a fact in Postgres, so checking it at
//! publish time is a query — unless the publish-time check is a *verification*
//! of something a read already established. So the read moves one step earlier
//! and comes back as a 60-second, member-and-channel-bound grant
//! (`momo_auth::ephemeral_grant`), and the publish route verifies it with a
//! HMAC and nothing else.
//!
//! What this buys, beyond making guard 3 literally true: at a 3s republish
//! cadence a naive inline check would run a membership `SELECT` **20 times a
//! minute per typist**, which is the same shape of waste ADR-0149 refused when
//! it kept 휘발 신호 out of the outbox. With the grant it is one read per
//! minute per channel, whether the person types for a second or an hour.
//!
//! ## The permission check itself — and why it is not a second copy
//!
//! The predicate is `momo_messaging::is_channel_member`: **the same function
//! `routes::realtime::subscribe` calls** to decide whether Centrifugo may let
//! this member subscribe to `ch:`/`typing:` at all. One predicate, two callers.
//! The packet's warning — *"권한 검사를 두 벌 짜면 그 둘이 갈라지는 게 다음
//! 결함이다"* — is answered by there being nothing to drift.
//!
//! `routes::realtime::issue_token`'s check was the packet's first candidate and
//! it is **used but not sufficient**: it proves *scope + the member is active in
//! the workspace + the credential is bindable*, all of which the auth
//! middleware and `workspace_scope` already re-establish on every call here.
//! What it does not prove — deliberately, and its own doc comment says so — is
//! anything about a **channel**: "A token that carried channels would keep an
//! evicted member subscribed for the rest of its TTL." A 「작성 중」 leak is a
//! leak of *which channels exist and who is inside them*, so channel-level is
//! the only granularity that closes it.
//!
//! ## Everything that is deliberately absent
//!
//! * **No `momo-db` call in [`typing`].** That is the assertion
//!   `tests/ephemeral_typing_touches_no_pg.rs` makes by driving this handler
//!   against a pool that refuses every connection.
//! * **No state.** No map of who is typing, no timer, no `stop` signal. The
//!   payload carries `expires_at` and the client forgets on its own (guard 4).
//! * **No aggregation.** The server cannot count typists without holding
//!   state, so it publishes one signal per person and the client renders
//!   `momo_ephemeral::TYPING_AGGREGATE_THRESHOLD`.
//! * **No agents.** Both routes are human-only: an agent that is working says
//!   so through its durable `agent_run`, and dressing that up as 「작성 중」
//!   would be the bot-wrapping ADR-0101 refused. 사람은 작성 중, 에이전트는 작업 중.

use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::{
    sign_ephemeral_grant, verify_ephemeral_grant, EphemeralGrantScope, Principal,
    EPHEMERAL_GRANT_TTL_SECONDS,
};
use momo_ephemeral::{
    ephemeral_channel, now_epoch_ms, EphemeralPublishOutcome, EphemeralSignal, PresenceSignal,
    TypingSignal, PRESENCE_REPUBLISH_INTERVAL_MS, PRESENCE_SIGNAL_TTL_MS,
    TYPING_AGGREGATE_THRESHOLD, TYPING_REPUBLISH_INTERVAL_MS, TYPING_SIGNAL_TTL_MS,
};
use momo_messaging::is_channel_member;

use crate::dto::{
    AvailabilitySignalRequest, AvailabilitySignalResponse, TypingGrantResponse,
    TypingSignalRequest, TypingSignalResponse,
};
use crate::error::ApiError;
use crate::rate_limit::Verdict;
use crate::routes::shared::{
    agent_tenant_tx, path_uuid, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

/// The refusal an un-configured instance answers with.
///
/// 503 rather than 404 on purpose: the route exists, the *instance* has no
/// Centrifugo publish credential. A client can tell "this server does not do
/// 휘발 신호" from "you may not do this here", and stop asking.
fn ephemeral_disabled() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "ephemeral signals are not configured on this server",
    )
}

/// Human-only, stated once. See the module docs for why an agent is not merely
/// unnecessary here but wrong.
const AGENTS_DO_NOT_TYPE: &str =
    "typing is a human signal; an agent's work is its agent_run (ADR-0149)";

/// Human-only for the same reason typing is (ADR-0160 D4): 프레즌스 is 사람 전용,
/// an agent's liveness is its `agent_run`.
const AGENTS_HAVE_NO_PRESENCE: &str =
    "presence is a human signal; an agent's liveness is its agent_run (ADR-0160)";

/// Apply one limiter axis (guard 5). `None` = allowed; `Some(response)` is the
/// 429 to return.
///
/// A refusal is a whole `Response` rather than an [`ApiError`] because it has
/// to carry `Retry-After`: a 429 with no retry hint invites the client to try
/// again immediately and be refused again. Same envelope and same message as
/// the `/v1/join` limiter, so a client that parses one parses both.
fn gate(
    state: &AppState,
    key: &str,
    limit: u32,
    window_seconds: u64,
) -> Option<axum::response::Response> {
    use axum::response::IntoResponse;

    if limit == 0 {
        return None;
    }
    let verdict: Verdict =
        state
            .rate_limit
            .limiter
            .check(key, limit, Duration::from_secs(window_seconds));
    if verdict.allowed {
        return None;
    }
    if verdict.should_log {
        // The key carries member/channel ids, which are not secrets and are the
        // only way to tell a runaway client from a busy channel. No body, no
        // grant and no channel *name* is logged.
        tracing::warn!(key, limit, window_seconds, "ephemeral rate limit exceeded");
    }
    let mut response =
        ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded").into_response();
    if let Ok(value) = verdict.retry_after_seconds.to_string().parse() {
        response.headers_mut().insert("retry-after", value);
    }
    Some(response)
}

// ---------------------------------------------------------------------------
// POST /v1/workspaces/{ws}/channels/{ch}/typing/grant
// ---------------------------------------------------------------------------

/// Mint the 60-second capability the publish route verifies.
///
/// **This is the only place on the 휘발 surface that touches Postgres**, and it
/// touches it once: `is_channel_member` inside `with_tenant_tx`, so the read
/// runs under the tenant GUC on the NOBYPASSRLS api role exactly like every
/// other tenant read on this server (invariant #6). A caller who is not a live
/// member gets the subscribe proxy's own wording back and learns nothing about
/// whether the channel exists.
pub async fn issue_grant(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
) -> Result<Json<TypingGrantResponse>, axum::response::Response> {
    use axum::response::IntoResponse;

    // A grant nobody could spend is worse than no grant: refuse before the read
    // rather than hand out a capability against a transport that does not exist.
    if state.ephemeral.publisher.is_none() {
        return Err(ephemeral_disabled().into_response());
    }
    require_human(&principal, AGENTS_DO_NOT_TYPE).map_err(IntoResponse::into_response)?;
    let workspace_id =
        workspace_scope(&workspace, &principal).map_err(IntoResponse::into_response)?;
    let channel_id =
        path_uuid(&channel, "invalid channel id").map_err(IntoResponse::into_response)?;
    let member_id = principal.member_id;

    // Guard 5 reaches the grant route too, and here it is not about Centrifugo
    // load — it is the only thing bounding how many membership SELECTs a client
    // can make this server run.
    if let Some(refusal) = gate(
        &state,
        &format!("eph:grant:{member_id}:{channel_id}"),
        state.ephemeral.settings.grant_limit,
        state.ephemeral.settings.window_seconds,
    ) {
        return Err(refusal);
    }

    let outcome: DbRejectable<()> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            // THE check. Same predicate `routes::realtime::subscribe` uses to
            // decide whether this member may subscribe to this channel at all —
            // so a member who cannot read the channel cannot signal into it.
            if !is_channel_member(conn, channel_id, member_id).await? {
                return Ok(Err(ApiError::forbidden("not a member of this channel")));
            }
            Ok(Ok(()))
        })
    })
    .await;
    settle_db("ephemeral.grant", outcome).map_err(IntoResponse::into_response)?;

    let issued = sign_ephemeral_grant(
        EphemeralGrantScope {
            member_id,
            workspace_id,
            channel_id,
        },
        EPHEMERAL_GRANT_TTL_SECONDS,
        &state.ephemeral_grant_key,
    )
    .map_err(|error| ApiError::internal("ephemeral.sign_grant", error).into_response())?;

    Ok(Json(TypingGrantResponse {
        grant: issued.token,
        channel: ephemeral_channel(workspace_id, channel_id),
        expires_at_ms: issued.expires_at.saturating_mul(1000),
        ttl_seconds: issued.ttl_seconds,
        signal_ttl_ms: TYPING_SIGNAL_TTL_MS,
        republish_interval_ms: TYPING_REPUBLISH_INTERVAL_MS,
        aggregate_threshold: TYPING_AGGREGATE_THRESHOLD,
    }))
}

// ---------------------------------------------------------------------------
// POST /v1/workspaces/{ws}/channels/{ch}/typing
// ---------------------------------------------------------------------------

/// Publish one 「작성 중」. **Issues no database statement of any kind.**
///
/// Order matters and is not arbitrary:
///
/// 1. **transport configured** — refuse before doing any work;
/// 2. **human** — an agent is refused before its grant is even examined;
/// 3. **path scope** — `{ws}` must equal the credential's workspace;
/// 4. **rate limit** — *before* the grant is verified, so a client burning
///    invalid grants cannot make this server verify signatures without bound;
/// 5. **grant** — the membership proof, bound to caller/workspace/channel;
/// 6. **publish**.
pub async fn typing(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    Json(request): Json<TypingSignalRequest>,
) -> Result<(StatusCode, Json<TypingSignalResponse>), axum::response::Response> {
    use axum::response::IntoResponse;

    let Some(publisher) = state.ephemeral.publisher.as_ref() else {
        return Err(ephemeral_disabled().into_response());
    };
    require_human(&principal, AGENTS_DO_NOT_TYPE).map_err(IntoResponse::into_response)?;
    let workspace_id =
        workspace_scope(&workspace, &principal).map_err(IntoResponse::into_response)?;
    let channel_id =
        path_uuid(&channel, "invalid channel id").map_err(IntoResponse::into_response)?;
    let member_id = principal.member_id;

    // Guard 5, both axes. Per channel first: a client stuck in a loop on one
    // conversation must be stopped there before it eats its whole per-member
    // budget and silences the channels it is behaving in.
    if let Some(refusal) = gate(
        &state,
        &format!("eph:typing:{member_id}:{channel_id}"),
        state.ephemeral.settings.per_channel_limit,
        state.ephemeral.settings.window_seconds,
    ) {
        return Err(refusal);
    }
    if let Some(refusal) = gate(
        &state,
        &format!("eph:typing:{member_id}"),
        state.ephemeral.settings.per_member_limit,
        state.ephemeral.settings.window_seconds,
    ) {
        return Err(refusal);
    }

    verify_ephemeral_grant(
        &request.grant,
        EphemeralGrantScope {
            member_id,
            workspace_id,
            channel_id,
        },
        &state.ephemeral_grant_key,
    )
    .map_err(|rejection| ApiError::forbidden(rejection.message()).into_response())?;

    let now_ms = now_epoch_ms();
    let signal = EphemeralSignal::Typing(TypingSignal::starting_at(
        workspace_id,
        channel_id,
        member_id,
        now_ms,
        TYPING_SIGNAL_TTL_MS,
    ));
    let channel_name = signal.channel();
    let expires_at_ms = signal.expires_at_ms();

    match publisher.publish(&signal).await {
        EphemeralPublishOutcome::Ok => {}
        // The broker is down or busy. 502 rather than a silent 202: the client's
        // next republish is the retry, and telling it lets it back off instead
        // of hammering a broker that is already struggling.
        EphemeralPublishOutcome::Unavailable(reason) => {
            tracing::warn!(%reason, "ephemeral publish unavailable");
            return Err(
                ApiError::new(StatusCode::BAD_GATEWAY, "realtime transport unavailable")
                    .into_response(),
            );
        }
        // Centrifugo understood and refused: a namespace that is not configured,
        // a channel name it will not accept. Retrying cannot fix it, and it is
        // this server's fault, so it is an opaque 500 with the detail in the log.
        EphemeralPublishOutcome::Rejected(reason) => {
            return Err(ApiError::internal("ephemeral.publish", reason).into_response());
        }
    }

    Ok((
        StatusCode::ACCEPTED,
        Json(TypingSignalResponse {
            channel: channel_name,
            expires_at_ms,
            republish_after_ms: TYPING_REPUBLISH_INTERVAL_MS,
        }),
    ))
}

// ---------------------------------------------------------------------------
// POST /v1/workspaces/{ws}/channels/{ch}/availability  (ADR-0160 ② 가용성)
// ---------------------------------------------------------------------------

/// Publish one availability(②) heartbeat. **Issues no database statement of any
/// kind** — the exact same 휘발 discipline as [`typing`], with the same order and
/// the same channel-scoped grant.
///
/// This is the transport half of ADR-0160's presence model. The client
/// republishes while its own connection is up (the connection edge is the
/// availability source, ADR-0160 미결 #1), and the signal's expiry is the offline
/// transition — the server holds no idle timer and no map of who is online. The
/// effective dot a co-member renders is `f(this availability, that member's
/// durable declared status)`; this route carries only the availability half, and
/// carries it without touching Postgres.
pub async fn availability(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    Json(request): Json<AvailabilitySignalRequest>,
) -> Result<(StatusCode, Json<AvailabilitySignalResponse>), axum::response::Response> {
    use axum::response::IntoResponse;

    let Some(publisher) = state.ephemeral.publisher.as_ref() else {
        return Err(ephemeral_disabled().into_response());
    };
    require_human(&principal, AGENTS_HAVE_NO_PRESENCE).map_err(IntoResponse::into_response)?;
    let workspace_id =
        workspace_scope(&workspace, &principal).map_err(IntoResponse::into_response)?;
    let channel_id =
        path_uuid(&channel, "invalid channel id").map_err(IntoResponse::into_response)?;
    let member_id = principal.member_id;

    // Guard 5, both axes, on their own keys so an availability heartbeat and a
    // typing signal do not share a budget (a member typing hard must not exhaust
    // the budget that keeps them showing as online).
    if let Some(refusal) = gate(
        &state,
        &format!("eph:presence:{member_id}:{channel_id}"),
        state.ephemeral.settings.per_channel_limit,
        state.ephemeral.settings.window_seconds,
    ) {
        return Err(refusal);
    }
    if let Some(refusal) = gate(
        &state,
        &format!("eph:presence:{member_id}"),
        state.ephemeral.settings.per_member_limit,
        state.ephemeral.settings.window_seconds,
    ) {
        return Err(refusal);
    }

    verify_ephemeral_grant(
        &request.grant,
        EphemeralGrantScope {
            member_id,
            workspace_id,
            channel_id,
        },
        &state.ephemeral_grant_key,
    )
    .map_err(|rejection| ApiError::forbidden(rejection.message()).into_response())?;

    let now_ms = now_epoch_ms();
    let signal = EphemeralSignal::Presence(PresenceSignal::starting_at(
        workspace_id,
        channel_id,
        member_id,
        now_ms,
        PRESENCE_SIGNAL_TTL_MS,
    ));
    let channel_name = signal.channel();
    let expires_at_ms = signal.expires_at_ms();

    match publisher.publish(&signal).await {
        EphemeralPublishOutcome::Ok => {}
        EphemeralPublishOutcome::Unavailable(reason) => {
            tracing::warn!(%reason, "availability publish unavailable");
            return Err(
                ApiError::new(StatusCode::BAD_GATEWAY, "realtime transport unavailable")
                    .into_response(),
            );
        }
        EphemeralPublishOutcome::Rejected(reason) => {
            return Err(ApiError::internal("ephemeral.availability", reason).into_response());
        }
    }

    Ok((
        StatusCode::ACCEPTED,
        Json(AvailabilitySignalResponse {
            channel: channel_name,
            expires_at_ms,
            republish_after_ms: PRESENCE_REPUBLISH_INTERVAL_MS,
        }),
    ))
}

/// The ids a `typing:` channel names, for the tests and the subscribe parser to
/// agree on. Kept here so `momo-ephemeral` needs no parser at all — it only ever
/// builds names.
#[cfg(test)]
fn parse_ephemeral_channel(name: &str) -> Option<(uuid::Uuid, uuid::Uuid)> {
    let body = name.strip_prefix("typing:ws")?;
    let (workspace, channel) = body.split_once('.')?;
    Some((
        uuid::Uuid::parse_str(workspace).ok()?,
        uuid::Uuid::parse_str(channel).ok()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_auth::PrincipalKind;
    use uuid::Uuid;

    fn principal(kind: PrincipalKind) -> Principal {
        Principal {
            member_id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            token_id: Some(Uuid::from_u128(3)),
            scopes: vec!["messages:read".to_string()],
            kind,
        }
    }

    /// ADR-0149 scope, enforced rather than documented: an agent principal is
    /// refused before anything else happens. If this ever passes, momo is
    /// wrapping a bot in a human affordance.
    #[test]
    fn an_agent_may_not_signal_that_it_is_typing() {
        let error =
            require_human(&principal(PrincipalKind::Agent), AGENTS_DO_NOT_TYPE).expect_err("403");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert!(error.message.contains("agent_run"), "{}", error.message);
        assert!(require_human(&principal(PrincipalKind::Human), AGENTS_DO_NOT_TYPE).is_ok());
    }

    /// The name the publisher produces has to be the name the subscribe proxy
    /// parses, or subscribers sit on a channel nothing is ever published to and
    /// nothing anywhere reports an error.
    #[test]
    fn the_published_channel_name_round_trips_through_the_subscribe_parser() {
        let workspace = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let name = ephemeral_channel(workspace, channel);
        assert_eq!(parse_ephemeral_channel(&name), Some((workspace, channel)));
        assert_eq!(
            crate::routes::realtime::parse_channel(&name),
            Some(crate::routes::realtime::ParsedChannel::Channel { workspace, channel }),
            "the proxy must authorize `typing:` with the same rule as `ch:`"
        );
    }

    /// A disabled instance must refuse with 503 on BOTH routes — a grant handed
    /// out by an instance that cannot publish is a capability for nothing.
    #[test]
    fn an_unconfigured_instance_refuses_with_a_service_unavailable() {
        let error = ephemeral_disabled();
        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(!error.message.contains("not found"), "{}", error.message);
    }

    /// Guard 5 keys must separate members AND channels: one key for both axes
    /// would let a busy channel throttle a quiet one, and one key for all
    /// members would make one client silence everybody.
    #[test]
    fn the_limiter_keys_separate_every_axis() {
        let member = Uuid::from_u128(7);
        let other_member = Uuid::from_u128(8);
        let channel = Uuid::from_u128(9);
        let other_channel = Uuid::from_u128(10);
        let key = |m: Uuid, c: Uuid| format!("eph:typing:{m}:{c}");
        assert_ne!(key(member, channel), key(member, other_channel));
        assert_ne!(key(member, channel), key(other_member, channel));
        // …and the grant axis is its own budget, not shared with publishes.
        assert_ne!(
            key(member, channel),
            format!("eph:grant:{member}:{channel}")
        );
        // …and availability has its own budget, separate from typing: a member
        // typing at full rate must not silence their own online heartbeat.
        assert_ne!(
            key(member, channel),
            format!("eph:presence:{member}:{channel}")
        );
    }

    /// ADR-0160 D4, enforced rather than documented: an agent principal is
    /// refused an availability heartbeat before anything else happens.
    #[test]
    fn an_agent_may_not_signal_that_it_is_available() {
        let error = require_human(&principal(PrincipalKind::Agent), AGENTS_HAVE_NO_PRESENCE)
            .expect_err("403");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert!(error.message.contains("agent_run"), "{}", error.message);
        assert!(require_human(&principal(PrincipalKind::Human), AGENTS_HAVE_NO_PRESENCE).is_ok());
    }
}
