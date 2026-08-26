//! Cross-cutting route helpers for the B2.2 T3 surface.
//!
//! Everything here is a *translation* concern — path parameters, credential
//! shape, the domain-error → HTTP-status table, and the one transaction pattern
//! the T3 routes share. No SQL, no invariant of its own.

use axum::http::StatusCode;
use momo_auth::{Principal, PrincipalKind};
use momo_db::{DbError, PgConnection, PgPool};
use momo_t3::T3Error;
use uuid::Uuid;

use crate::config::T3Settings;
use crate::error::ApiError;

/// Swift `InviteRoutes.workspaceID` (:443-455): the `{ws}` path parameter must
/// parse **and** must equal the credential's workspace.
///
/// The returned id — never the raw path string — is what opens the tenant
/// transaction, so a client cannot address another tenant even if RLS were
/// somehow permissive (invariant #6, defence in depth).
pub(crate) fn workspace_scope(raw: &str, principal: &Principal) -> Result<Uuid, ApiError> {
    let workspace_id =
        Uuid::parse_str(raw).map_err(|_| ApiError::bad_request("invalid workspace id"))?;
    if workspace_id != principal.workspace_id {
        return Err(ApiError::forbidden("workspace scope mismatch"));
    }
    Ok(workspace_id)
}

/// Parse a path UUID with the route's own 400 message (Swift `parameterUUID`).
pub(crate) fn path_uuid(raw: &str, message: &'static str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw).map_err(|_| ApiError::bad_request(message))
}

/// Swift's `requireHumanPrincipal` guards. The Rust middleware only ever
/// resolves `PrincipalKind::Human` today (the agent-bearer and work-host bearer
/// paths are not ported — see `auth.rs`), so this check is currently always
/// true; it is written anyway so that porting those credentials cannot silently
/// widen a human-only route.
pub(crate) fn require_human(principal: &Principal, message: &'static str) -> Result<(), ApiError> {
    if principal.kind == PrincipalKind::Human {
        Ok(())
    } else {
        Err(ApiError::forbidden(message))
    }
}

/// Swift `create` guard (`WorkSessionRoutes.swift:129-131`): a work session
/// may be opened by a human bearer **or** a signed work host. Agents stay out.
pub(crate) fn require_human_or_work_host(
    principal: &Principal,
    message: &'static str,
) -> Result<(), ApiError> {
    match principal.kind {
        PrincipalKind::Human | PrincipalKind::WorkHost => Ok(()),
        PrincipalKind::Agent => Err(ApiError::forbidden(message)),
    }
}

/// The `audit_log.via_token_id` a principal may legitimately claim (B2.4).
///
/// `via_token_id` is `REFERENCES token(id)`. A human bearer's `token_id` IS such
/// a row, so it is the delegation provenance the column exists to record. A
/// work-host principal's `token_id` slot carries its **host** id, which is not a
/// `token` row: writing it there is a foreign-key violation, and the Swift
/// server took that as a live 500 before fixing it to NULL
/// (`WorkSessionRoutes.swift:1009-1017` — "No token was used, so NULL is the
/// true statement; the acting host is already named in detail.host_id").
///
/// Centralised here rather than repeated per route so the next audit call site
/// cannot re-introduce the same 500.
pub(crate) fn audit_via_token_id(principal: &Principal) -> Option<Uuid> {
    match principal.kind {
        PrincipalKind::WorkHost => None,
        PrincipalKind::Human | PrincipalKind::Agent => principal.token_id,
    }
}

/// `oort Cloud(T3)는 기본 비활성입니다` — Swift `CloudProvisionerRoutes.disabledError`
/// (:1183-1188), same 503 and same sentence an operator would see from the Swift
/// server, with the product name carried to `oort` (ADR-0152 D2-1). The brand
/// word is the only difference; the shape and the issue reference are verbatim.
pub(crate) fn t3_disabled() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "oort Cloud(T3)는 기본 비활성입니다. 재설계 진행 중(#888)입니다.",
    )
}

/// The `requireReady` gate reduced to what a REST handler needs: T3 on, the
/// default provider registered, and an https public base URL. Returns the base
/// URL a workd will register against.
///
/// Fails **before any durable intent is written**, which is the property
/// `CloudProviderSettings.requireReady` exists for: a half-configured instance
/// must not be able to create a billable row it can never finish provisioning.
pub(crate) fn ready_t3(settings: &T3Settings) -> Result<String, ApiError> {
    if !settings.enabled {
        return Err(t3_disabled());
    }
    momo_t3::provider::capabilities_for(&settings.default_provider_id).map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "설정된 T3 provider가 어댑터 레지스트리에 없습니다. 인스턴스 운영자에게 문의하세요.",
        )
    })?;
    settings.ready_public_base_url().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "oort Cloud 프로비저너 설정이 완전하지 않습니다. 인스턴스 운영자에게 문의하세요.",
        )
    })
}

/// The T3 domain-error → HTTP table.
///
/// Every DB-enforced rejection ADR-0140 names has a status here rather than
/// collapsing to a 500: a client that hits the one-unsettled-per-host index or
/// the transition guard is looking at a **conflict**, and telling it so is the
/// difference between a retry and a bug report. Only the genuinely internal
/// variants (a transaction failure, a ladder misuse) become an opaque 500.
pub(crate) fn t3_error(context: &str, error: T3Error) -> ApiError {
    let conflict = |message: String| ApiError::new(StatusCode::CONFLICT, message);
    match error {
        T3Error::Db(inner) => db_error_status(context, inner),
        T3Error::SessionNotFound => ApiError::not_found("work session not found"),
        T3Error::CloudHostNotFound => ApiError::not_found("oort Cloud host not found"),
        // ADR-0140 enforcement points: all conflicts, all retryable-or-not by a
        // client that can read the message.
        error @ (T3Error::IllegalTransition(_)
        | T3Error::SettlementSealed
        | T3Error::CloudHostMissing
        | T3Error::CreditLedgerMissing
        | T3Error::InsufficientCredit
        | T3Error::HostAlreadyBilling
        | T3Error::SlotsExhausted { .. }
        | T3Error::MemberSlotLimit { .. }
        | T3Error::CloudHostNotRunnable(_)
        | T3Error::NoOpenUsage
        | T3Error::IntervalStateConflict) => conflict(error.to_string()),
        T3Error::UnknownProvider(_) | T3Error::Provider(_) => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "oort Cloud 호스트를 준비하지 못했습니다. 잠시 후 다시 시도하세요.",
        ),
        // A ladder misuse, a missing work_pool row, or a reason this server
        // chose itself are all server bugs, not client input.
        // `StaleAfterSettlement` belongs to the B2.3 sweep (the notifier races
        // itself against a session someone else moved) and cannot arise on a
        // route, so it is internal here rather than a client-facing conflict.
        other @ (T3Error::EmptyLockLadder
        | T3Error::WorkPoolMissing
        | T3Error::InvalidTerminationReason
        | T3Error::StaleAfterSettlement(_)) => ApiError::internal(context, other),
    }
}

fn db_error_status(context: &str, error: DbError) -> ApiError {
    ApiError::internal(context, error)
}

/// A tenant transaction whose closure speaks [`T3Error`].
///
/// Delegates to `momo_db::with_tenant_tx_prelude` with empty preludes rather
/// than adding a second transaction opener: `bind_workspace_guc` stays the one
/// and only wiring point for `app.workspace_id` (invariant #6). Used by the
/// paths that must NOT take a T3 advisory — enrollment (no cloud host row exists
/// yet to be advised on) and the pure reads.
pub(crate) async fn tenant_tx<T, F>(
    pool: &PgPool,
    workspace_id: Uuid,
    body: F,
) -> Result<T, T3Error>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> futures_box::BoxFuture<'c, Result<T, T3Error>>
        + Send,
{
    momo_db::with_tenant_tx_prelude(
        pool,
        workspace_id,
        |_conn| Box::pin(async move { Ok(()) }),
        |_conn| Box::pin(async move { Ok(()) }),
        body,
    )
    .await
}

/// Re-export of the boxed-future shape the `momo-db` guards take, so route
/// modules do not each depend on `futures` directly.
pub(crate) mod futures_box {
    pub(crate) type BoxFuture<'a, T> =
        std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;
}

/// Pin a closure's signature to the higher-ranked shape both transaction guards
/// require, so the same closure can be handed to
/// [`momo_t3::with_t3_lifecycle_tx`] or [`tenant_tx`] depending on whether the
/// request touches a cloud host.
///
/// Without this the compiler infers a single concrete lifetime for `&mut
/// PgConnection` at the closure's definition site and then refuses it at both
/// call sites; the function is the standard way to force `for<'c>` inference.
pub(crate) fn lifecycle_body<T, F>(body: F) -> F
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> futures_box::BoxFuture<'c, Rejectable<T>> + Send,
{
    body
}

/// The rejection channel for checks performed *inside* a transaction.
///
/// `Ok(Err(api_error))` is a rejection, `Err(t3_error)` is a failure. The
/// distinction matters because only the latter rolls the transaction back — so
/// the rule every handler in this batch follows is: **every rejection is
/// returned before the first write**, which makes committing a read-only
/// transaction indistinguishable from rolling it back. Swift gets the same
/// effect by throwing an `HTTPError` out of the transaction closure; Rust cannot,
/// because the closure's error type is the domain's.
pub(crate) type Rejectable<T> = Result<Result<T, ApiError>, T3Error>;

/// Collapse a [`Rejectable`] into the handler's own result.
pub(crate) fn settle<T>(
    context: &str,
    outcome: Result<Result<T, ApiError>, T3Error>,
) -> Result<T, ApiError> {
    match outcome {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(rejection)) => Err(rejection),
        Err(error) => Err(t3_error(context, error)),
    }
}

// ---------------------------------------------------------------------------
// B2.6 — the same two patterns for the agent surface
//
// The agent routes speak `DbError`, not `T3Error`: nothing they touch is a T3
// lifecycle object, and borrowing `T3Error` would have put agent-run outcomes
// through a table written for cloud-host settlement.
// ---------------------------------------------------------------------------

/// [`Rejectable`]'s agent-side twin: `Ok(Err(_))` is a rejection (the
/// transaction still commits, because every rejection is returned before the
/// first write), `Err(_)` is a failure that rolls back.
pub(crate) type DbRejectable<T> = Result<Result<T, ApiError>, DbError>;

/// A plain tenant transaction whose closure speaks [`DbError`].
pub(crate) async fn agent_tenant_tx<T, F>(
    pool: &PgPool,
    workspace_id: Uuid,
    body: F,
) -> Result<T, DbError>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> futures_box::BoxFuture<'c, Result<T, DbError>>
        + Send,
{
    momo_db::with_tenant_tx(pool, workspace_id, body).await
}

/// A tenant transaction whose closure speaks [`momo_settings::JoinError`] (B4.3).
///
/// It exists instead of reusing [`agent_tenant_tx`] because the join path breaks
/// the assumption the `Ok(Err(_))` rejection channel rests on: *every rejection
/// is returned before the first write*. A join can only discover some refusals
/// **after** writing — the redemption row is what proves a concurrent join lost
/// the race, and the guarded `used_count` update is what proves the code was
/// exhausted. A rejection channel that committed would leave a member row and a
/// channel membership behind for a request that answered 409.
///
/// So every join refusal is an `Err`, and `Err` rolls back. Routed through
/// `momo_db::with_tenant_tx_prelude` with empty preludes rather than opening a
/// transaction here, so `bind_workspace_guc` stays the one and only wiring point
/// for `app.workspace_id` (invariant #6).
pub(crate) async fn join_tenant_tx<T, F>(
    pool: &PgPool,
    workspace_id: Uuid,
    body: F,
) -> Result<T, momo_settings::JoinError>
where
    T: Send,
    F: for<'c> FnOnce(
            &'c mut PgConnection,
        ) -> futures_box::BoxFuture<'c, Result<T, momo_settings::JoinError>>
        + Send,
{
    momo_db::with_tenant_tx_prelude(
        pool,
        workspace_id,
        |_conn| Box::pin(async move { Ok(()) }),
        |_conn| Box::pin(async move { Ok(()) }),
        body,
    )
    .await
}

/// Collapse a [`DbRejectable`] into the handler's own result.
pub(crate) fn settle_db<T>(context: &str, outcome: DbRejectable<T>) -> Result<T, ApiError> {
    match outcome {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(rejection)) => Err(rejection),
        Err(error) => Err(ApiError::internal(context, error)),
    }
}

// ---------------------------------------------------------------------------
// B4.2 — the operator authorization matrix
//
// The 설정 표면 has TWO operator gates and Swift is explicit that the split is
// deliberate (`ProviderLinkRoutes.swift:24-27`): **instance-global ⇒ platform
// scope or listed instance operator; per-workspace ⇒ owner/admin.**
//
// The reason is blast radius, not seniority. `provider_link` has no
// `workspace_id`: whoever edits it changes provider resolution for EVERY
// workspace on the instance, so the MOMO-576 "any workspace owner" rule was a
// cross-tenant control leak the moment ADR-0117 opened multi-workspace, and
// MOMO-583 removed it. `work_host_engine` and `work_tier_policy` are RLS-scoped
// rows that only affect their own tenant, so an owner/admin is the right
// authority there.
//
// Both helpers do their DB read in the operator's OWN workspace and complete
// **before** any operator GUC is bound — 권한 판정 → GUC 세팅, never the reverse.
// ---------------------------------------------------------------------------

/// Swift's cross-tenant read scope (`platform:read`).
const PLATFORM_READ_SCOPE: &str = "platform:read";

/// Instance-global gate (Swift `ProviderLinkRoutes.requireOperator` :328-377):
/// a human that either carries `platform:read` or is an owner/admin of its own
/// workspace **and** whose verified email is listed in `PLATFORM_ADMIN_EMAILS`.
///
/// The allow-list path is not a bypass: a self-hosted instance can never mint a
/// platform token, so without it the AI-연결 panel would be unreachable except
/// through the database. What stays removed is *arbitrary* workspace-owner
/// sufficiency.
pub(crate) async fn require_instance_operator(
    state: &crate::AppState,
    principal: &Principal,
) -> Result<(), ApiError> {
    require_human(principal, "human operator required")?;
    if principal
        .scopes
        .iter()
        .any(|scope| scope == PLATFORM_READ_SCOPE)
    {
        return Ok(());
    }
    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;
    let checked = settle_db(
        "settings.authorize_instance_operator",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let role = momo_auth::active_workspace_role(conn, workspace_id, member_id).await?;
                let email =
                    momo_auth::verified_operator_email(conn, workspace_id, member_id).await?;
                Ok(Ok((role, email)))
            })
        })
        .await,
    )?;

    let listed = checked.0.is_some_and(|role| role.is_admin())
        && checked
            .1
            .is_some_and(|email| state.settings.platform_admin_emails.contains(&email));
    if listed {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "platform:read scope or listed instance operator required",
        ))
    }
}

/// Per-workspace gate (Swift `ProviderLinkRoutes.isOperatorAuthorized` :281-289
/// as used by `WorkHostEngineRoutes.requireOperator` :127-154): a human that
/// carries `platform:read` **or** is an owner/admin of its own workspace.
///
/// The platform path needs no DB lookup, so only the role fallback opens a
/// tenant read.
pub(crate) async fn require_workspace_operator(
    state: &crate::AppState,
    principal: &Principal,
    workspace_id: Uuid,
) -> Result<(), ApiError> {
    require_human(principal, "human operator required")?;
    if principal
        .scopes
        .iter()
        .any(|scope| scope == PLATFORM_READ_SCOPE)
    {
        return Ok(());
    }
    let member_id = principal.member_id;
    let role = settle_db(
        "settings.authorize_workspace_operator",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(Ok(momo_auth::active_workspace_role(
                    conn,
                    workspace_id,
                    member_id,
                )
                .await?))
            })
        })
        .await,
    )?;
    if role.is_some_and(|role| role.is_admin()) {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "platform:read scope or workspace owner/admin required",
        ))
    }
}

/// Milliseconds since the epoch — the `*AtMs` wire convention every DTO in this
/// API uses (Swift `Int64(date.timeIntervalSince1970 * 1000)`).
pub(crate) fn epoch_ms(at: chrono::DateTime<chrono::Utc>) -> i64 {
    at.timestamp_millis()
}

/// Project an `agent_run` row onto the wire DTO (Swift `runProjectionSQL`,
/// `AgentRunRoutes.swift:800-840`).
///
/// `triggerSummary` is the same excerpt the bounded history page carries, and it
/// is computed by the **same function** (`momo_agent::trigger_summary`): a work
/// run shows its title, a mention run shows its prompt, and anything else shows
/// nothing rather than leaking a raw input blob into a list view. #1223 mounted
/// the second surface that renders this string, so the derivation moved to the
/// domain — two copies is how a channel list and an agent hub come to disagree
/// about what the same run was for.
pub(crate) fn run_response(run: &momo_agent::AgentRunRow) -> crate::dto::AgentRunResponse {
    let summary = momo_agent::trigger_summary(&run.input);

    crate::dto::AgentRunResponse {
        id: run.id.to_string(),
        workspace_id: run.workspace_id.to_string(),
        agent_member_id: run.agent_member_id.to_string(),
        channel_id: run.channel_id.to_string(),
        trigger_message_id: run.trigger_message_id.map(|id| id.to_string()),
        trigger_summary: summary,
        parent_run_id: run.parent_run_id.map(|id| id.to_string()),
        status: run.status.as_db_label().to_string(),
        step_count: run.step_count,
        max_steps: run.max_steps,
        depth: run.depth,
        input: run.input.clone(),
        output: run.output.clone(),
        error: run.error.clone(),
        started_at_ms: run.started_at.map(epoch_ms),
        finished_at_ms: run.finished_at.map(epoch_ms),
        created_at_ms: epoch_ms(run.created_at),
        updated_at_ms: epoch_ms(run.updated_at),
    }
}

/// Publish the terminal `agent.status` frame for a run that just reached a
/// terminal row, on the caller's connection and inside the caller's transaction
/// (goal SRV-B3c).
///
/// Every place in this binary that ends a run calls this, and they all call
/// *this* rather than building a frame of their own, for the reason the effort
/// table gives for living in one module: two producers of the same frame is how
/// a rail comes to say the turn ended in one code path and stay silent in
/// another. The shape itself is [`momo_agent::terminal_agent_status_payload`] —
/// this function is only the egress.
///
/// **A non-terminal status is a no-op, not an error.** The builder refuses it
/// (an `awaiting_approval` run is genuinely still open), and a caller that hands
/// one over has a bug in its own transition rather than in its broadcast; the
/// frame is the safe half to drop.
///
/// The partition key is the **channel**, matching `send_message_in_tx`, so the
/// frame is ordered behind the final message of the same turn rather than racing
/// it. A rail that learned the turn was over before the answer arrived would
/// blank the badge and then show the reply with nothing running.
pub(crate) async fn emit_terminal_agent_status(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    agent_member_id: Uuid,
    run_id: Uuid,
    status: momo_agent::RunStatus,
) -> Result<(), DbError> {
    let Some(frame) = momo_agent::terminal_agent_status_payload(
        workspace_id,
        channel_id,
        agent_member_id,
        run_id,
        status,
        epoch_ms(chrono::Utc::now()),
    ) else {
        return Ok(());
    };
    emit_rail_frame(conn, workspace_id, channel_id, &frame).await
}

/// Put one already-shaped progress-rail frame on the outbox (goal SRV-B3d).
///
/// The partition key is the **channel**, the same one `send_message_in_tx` uses,
/// and that is the whole ordering story for this rail: opening → thinking →
/// streaming → partial → terminal all take one FIFO with the turn's messages, so
/// a client can never be told the turn ended before it is shown what the turn
/// said, and two frames of the same turn can never swap.
pub(crate) async fn emit_rail_frame(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    frame: &serde_json::Value,
) -> Result<(), DbError> {
    momo_outbox::emit_outbox(
        conn,
        workspace_id,
        momo_outbox::OutboxKind::Broadcast,
        "publish",
        frame,
        Some(channel_id),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal(workspace_id: Uuid) -> Principal {
        Principal {
            member_id: Uuid::from_u128(1),
            workspace_id,
            token_id: Some(Uuid::from_u128(2)),
            scopes: vec![],
            kind: PrincipalKind::Human,
        }
    }

    #[test]
    fn workspace_scope_rejects_a_foreign_path() {
        let credential = Uuid::from_u128(10);
        let other = Uuid::from_u128(11);
        let error = workspace_scope(&other.to_string(), &principal(credential))
            .expect_err("path workspace must match the credential");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(error.message, "workspace scope mismatch");
        assert_eq!(
            workspace_scope("nope", &principal(credential))
                .expect_err("malformed")
                .status,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            workspace_scope(&credential.to_string(), &principal(credential)).expect("match"),
            credential
        );
    }

    /// The FK rule that cost the Swift server a live 500.
    #[test]
    fn a_host_signature_never_claims_a_token_row_as_provenance() {
        let token = Uuid::from_u128(2);
        let human = principal(Uuid::from_u128(10));
        assert_eq!(audit_via_token_id(&human), Some(token));

        let mut host = principal(Uuid::from_u128(10));
        host.kind = PrincipalKind::WorkHost;
        assert_eq!(
            audit_via_token_id(&host),
            None,
            "a work host's token_id is a HOST id; audit_log.via_token_id \
             REFERENCES token(id) and would reject it"
        );
    }

    #[test]
    fn t3_enforcement_points_are_conflicts_not_500s() {
        for error in [
            T3Error::SettlementSealed,
            T3Error::HostAlreadyBilling,
            T3Error::InsufficientCredit,
            T3Error::IllegalTransition("ready -> paused".into()),
            T3Error::CloudHostNotRunnable("destroyed".into()),
            T3Error::SlotsExhausted {
                occupied: 5,
                max_active: 5,
            },
        ] {
            assert_eq!(
                t3_error("test", error).status,
                StatusCode::CONFLICT,
                "a database-enforced rejection must reach the client as a conflict"
            );
        }
        assert_eq!(
            t3_error("test", T3Error::SessionNotFound).status,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            t3_error("test", T3Error::UnknownProvider("e2b".into())).status,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            t3_error("test", T3Error::EmptyLockLadder).status,
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn t3_gate_needs_enabled_registered_provider_and_https() {
        let mut settings = T3Settings::default();
        assert_eq!(
            ready_t3(&settings).expect_err("off by default").status,
            StatusCode::SERVICE_UNAVAILABLE
        );
        settings.enabled = true;
        settings.public_base_url = Some("https://momo.example.com".into());
        assert_eq!(
            ready_t3(&settings).expect("byoc + https"),
            "https://momo.example.com"
        );
        settings.default_provider_id = "e2b".into();
        assert!(
            ready_t3(&settings).is_err(),
            "a retired provider id must fail closed, not default to something billable"
        );
    }

    /// ADR-0156 D4-④ — `MOMO_T3_PROVIDER` may now name the managed substrate,
    /// and the retired id is still refused beside it.
    ///
    /// The gate reads the ADR-0142 registry, so "joining" a provider to the
    /// configuration surface is a registry fact rather than a list in this file —
    /// which is why the assertion below is the whole of the change. What the gate
    /// deliberately does **not** check is whether an adapter was configured for
    /// that id: `ready_t3` guards every T3 route, and the BYOC path needs no
    /// endpoint. The acquisition route asks for the capability separately
    /// (`cloud_hosts::require_provisioner`), so an instance that named a managed
    /// provider without an endpoint keeps serving registration and sessions and
    /// refuses only the one verb it genuinely cannot perform.
    #[test]
    fn a_registered_managed_provider_is_a_legal_default_and_a_retired_one_is_not() {
        let mut settings = T3Settings {
            enabled: true,
            public_base_url: Some("https://momo.example.com".into()),
            ..T3Settings::default()
        };
        for provider_id in momo_t3::provider::registered_provider_ids() {
            settings.default_provider_id = provider_id.to_string();
            assert!(
                ready_t3(&settings).is_ok(),
                "every registered adapter id must be a legal MOMO_T3_PROVIDER ({provider_id})"
            );
        }
        assert!(momo_t3::provider::registered_provider_ids().contains(&"cubesandbox"));
        assert!(
            !momo_t3::provider::registered_provider_ids().contains(&"e2b"),
            "named regression: joining a managed substrate must not resurrect the retired id"
        );
    }
}
