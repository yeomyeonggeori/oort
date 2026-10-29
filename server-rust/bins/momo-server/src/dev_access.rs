//! The developer-token **door** (ADR-0216 D1·D2·D4·D9, #4660): the `momo_dev_v1…`
//! arm of [`crate::auth::require_principal`], and the server-side wrapper around a
//! login lineage's refresh rotation. The database functions are
//! `momo_auth::dev_token`'s; this module decides the order they run in and what a
//! caller is told.
//!
//! ## One request, in order
//!
//! 1. **Envelope** ([`is_dev_envelope`]). A bearer whose first dot-separated field is
//!    `momo_dev_v1` or `momo_devr_v1` belongs to this door, well-formed or not, and
//!    never falls through to the App JWT verifier. Only a well-formed card/access
//!    envelope (`dev_token_workspace_id`) goes on; a refresh envelope or a malformed
//!    one is answered with [`invalid_token`] right here, without the database (R2 ii:
//!    the data door takes `card` and `access`, never `refresh`).
//! 2. **The closed table, before the database** ([`dev_route_scope`]). The key is the
//!    route template the router matched (`MatchedPath`), never the raw path's shape,
//!    plus the uppercase method, through `required_dev_scope` (L1–L8). A request with
//!    no matched template, a pair off the table (HEAD and OPTIONS included), or a
//!    `{ws}` segment that does not name the envelope's workspace is a 403
//!    `dev_route_not_allowed` — decided before any lookup, so it says nothing about
//!    whether the token is any good (the agent arm's rule).
//! 3. **Who** — one tenant transaction on the workspace the envelope claims (RLS makes
//!    that claim true or empty): `resolve_dev_token_in_tx` (SELECT only).
//!    * `Unknown` — no row, wrong workspace, wrong form, revoked, expired, a suspended,
//!      removed or non-human member — is [`invalid_token`], the App JWT arm's answer
//!      to a bad signature, byte for byte (D2, R2 iii).
//!    * `PolicyDenied` (the role is outside `FIXED_POLICY`, judged on every use, D3)
//!      is a 403 `dev_access_denied`; a live token without the route's scope is a 403
//!      `dev_scope_denied`.
//! 4. **Budgets** (D9, R13): per token, per member, and the send row per token, on
//!    stable ids in the Agent Port limiter map (`dev:token:…`, `dev:member:…`,
//!    `dev:write:…`). Over budget is a 429 with `Retry-After`, and **a 429 writes
//!    nothing** in this transaction — no `last_used_at`, no `used` row — so a flood
//!    cannot turn into a write flood.
//! 5. **Admit**: `finalize_dev_use_in_tx` re-checks every predicate under a fresh
//!    snapshot (a revoke, expiry, suspension or demotion that committed after step 3
//!    fails it: [`invalid_token`] again) and touches `last_used_at`; the
//!    `auth.dev_token.used` row is written **in the same transaction** (R15). That row
//!    is part of authentication: if it cannot be written, the request is not admitted.
//! 6. The handler gets a `Human` [`Principal`] carrying the token row's id and scopes,
//!    the [`DevCredential`] marker and the [`DevIdentity`] (for `…/dev-access/self`).
//!    Only this arm inserts them. **The marker narrows, never grants**: a handler may
//!    refuse because of it, never allow.
//!
//! ## Refusal rows are bounded and never change the answer
//!
//! A 403 from step 3 writes one `auth.dev_token.scope_denied` row and a 429 one
//! `auth.dev_token.rate_limited` row — at most **one per token per window** each
//! (D9 「안정 id 버킷당 창마다 한 줄」, R15). The bound is an audit *slot* in the same
//! limiter map (`dev:audit:…:{token}`, one admission per window), the second bound of
//! `rate_limit::audit_denial_once`: a burst marker alone resets every time the token
//! is admitted again. The row is written on a task of its own, awaited by the request
//! (`rate_limit::audit_denial_detached`'s reason: a client that hangs up mid-write
//! must not be able to cancel it), in its own transaction, so a failed write is logged,
//! hands the slot back for the next refusal, and leaves the 403/429 exactly as it was
//! (D9: an audit failure changes no answer — only the `used` row, which is part of
//! authentication, may).
//!
//! No row, log line or error here carries the presented envelope, its hash, a body, a
//! channel id, a query or the raw path: the audit vocabulary is the method, the route
//! *template*, the scope and a closed reason.

use std::time::{Duration, Instant};

use axum::extract::{MatchedPath, Request};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use momo_auth::dev_token::{
    dev_refresh_workspace_id, dev_token_workspace_id, finalize_dev_use_in_tx, required_dev_scope,
    resolve_dev_token_in_tx, rotate_dev_refresh_in_tx, DevIdentity, DevResolution, DevRotation,
    DEV_REFRESH_PREFIX, DEV_TOKEN_PREFIX, FIXED_POLICY, SCOPE_DEV_MESSAGES_WRITE,
};
use momo_auth::{Principal, PrincipalKind};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, DbError};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::dev_credential::DevCredential;
use crate::error::ApiError;
use crate::AppState;

/// `audit_log.action` of an admitted developer-token request (D9, R15). Unbounded by
/// design: one row per admitted request, atomic with the `last_used_at` touch.
pub const AUDIT_ACTION_USED: &str = "auth.dev_token.used";
/// A policy (role) or scope refusal at the door; at most one per token per window.
pub const AUDIT_ACTION_SCOPE_DENIED: &str = "auth.dev_token.scope_denied";
/// A budget refusal (429) at the door; at most one per token per window.
pub const AUDIT_ACTION_RATE_LIMITED: &str = "auth.dev_token.rate_limited";
/// A spent refresh presented again: the lineage was ended (D2, R10).
pub const AUDIT_ACTION_REFRESH_REUSE_DETECTED: &str = "auth.dev_token.refresh_reuse_detected";

/// `detail.schema` of the `used` and `scope_denied` rows:
/// `{method, route, required_scope, granted[, reason]}`.
pub const USE_SCHEMA: &str = "momo.dev_token.use.v1";
/// `detail.schema` of the `rate_limited` row:
/// `{method, route, required_scope, axes, window_seconds}`.
pub const RATE_LIMIT_SCHEMA: &str = "momo.dev_token.rate_limit.v1";
/// `detail.schema` of the `refresh_reuse_detected` row: `{revoked_tokens}`.
pub const REFRESH_REUSE_SCHEMA: &str = "momo.dev_token.refresh_reuse.v1";

/// `error.code` of a request the closed table refuses (D4): off the table, no
/// matched route, or a `{ws}` that is not the envelope's workspace.
pub const CODE_ROUTE_NOT_ALLOWED: &str = "dev_route_not_allowed";
/// `error.code` of a live token whose member's role the policy no longer admits (D3).
pub const CODE_ACCESS_DENIED: &str = "dev_access_denied";
/// `error.code` of a live token without the scope the route requires (D4).
pub const CODE_SCOPE_DENIED: &str = "dev_scope_denied";

/// The template segment the `{ws}` check reads.
const WORKSPACE_SEGMENT: &str = "{ws}";

// ---------------------------------------------------------------------------
// answers
// ---------------------------------------------------------------------------

/// The one 401 every failure to identify a developer token answers with — the same
/// status and the same bytes the App JWT arm answers a bad signature with
/// (`AuthError::InvalidToken` in `auth::require_principal`), and therefore the same
/// as any string the server does not know. Expired, revoked, unknown, another
/// workspace's, malformed, a refresh envelope at the data door: one answer (D2,
/// R2 iii), so the response is never an oracle for a token's state.
pub(crate) fn invalid_token() -> ApiError {
    ApiError::unauthorized("invalid or expired token")
}

/// 403 `dev_route_not_allowed` — the closed table said no (D4).
pub(crate) fn route_not_allowed() -> ApiError {
    ApiError::coded(
        StatusCode::FORBIDDEN,
        CODE_ROUTE_NOT_ALLOWED,
        "developer token is not allowed for this route",
    )
}

/// 403 `dev_access_denied` — the workspace policy does not admit this member's role
/// today (D3: judged on every use, not only at issuance).
pub(crate) fn access_denied() -> ApiError {
    ApiError::coded(
        StatusCode::FORBIDDEN,
        CODE_ACCESS_DENIED,
        "developer access is not allowed for this member's role",
    )
}

/// 403 `dev_scope_denied` — the token was not issued with the route's scope.
pub(crate) fn scope_denied() -> ApiError {
    ApiError::coded(
        StatusCode::FORBIDDEN,
        CODE_SCOPE_DENIED,
        "developer token does not carry the scope this route requires",
    )
}

// ---------------------------------------------------------------------------
// before the database
// ---------------------------------------------------------------------------

/// Whether `raw` is shaped like a developer envelope at all: its first dot-separated
/// field is `momo_dev_v1` (card, access) or `momo_devr_v1` (refresh). Such a string is
/// this door's to answer whether or not it is well-formed. No App JWT starts that way
/// (a JWT's first field is base64url JSON, `eyJ…`), so taking these strings away from
/// the JWT verifier changes no JWT's path; it only stops the door from relying on the
/// verifier happening to answer a malformed developer string with the same words.
pub(crate) fn is_dev_envelope(raw: &str) -> bool {
    matches!(
        raw.split('.').next(),
        Some(prefix) if prefix == DEV_TOKEN_PREFIX || prefix == DEV_REFRESH_PREFIX
    )
}

/// The closed table's verdict for one request (D4, R3) — the scope a developer token
/// must carry here, or `None`: refuse with [`route_not_allowed`]. Pure, so it runs
/// before any database work and is tested without one.
///
/// `Some` needs all three:
/// 1. the router resolved a route template (`matched_template`, from `MatchedPath`).
///    No template — refuse (fail closed);
/// 2. `required_dev_scope` has that exact (uppercase method, template) pair. `HEAD`,
///    `OPTIONS`, a lowercase method and every template off the table are refused;
/// 3. the raw path lines up with the template segment by segment, and every `{ws}`
///    segment parses (as the handlers' `workspace_scope` parses it) to the workspace
///    the envelope claims. A template without `{ws}` (`/v1/mcp/me`) has nothing to
///    compare. Static segments must be equal and other placeholders are left to the
///    handler; a path that does not line up is refused rather than guessed at.
pub fn dev_route_scope(
    method: &str,
    matched_template: Option<&str>,
    raw_path: &str,
    envelope_workspace: Uuid,
) -> Option<&'static str> {
    let template = matched_template?;
    let scope = required_dev_scope(method, template)?;
    path_names_workspace(template, raw_path, envelope_workspace).then_some(scope)
}

fn path_names_workspace(template: &str, raw_path: &str, envelope_workspace: Uuid) -> bool {
    let expected: Vec<&str> = template.split('/').collect();
    let presented: Vec<&str> = raw_path.split('/').collect();
    expected.len() == presented.len()
        && expected
            .iter()
            .zip(&presented)
            .all(|(expected, presented)| match *expected {
                WORKSPACE_SEGMENT => {
                    Uuid::parse_str(presented).is_ok_and(|named| named == envelope_workspace)
                }
                placeholder if placeholder.starts_with('{') && placeholder.ends_with('}') => true,
                literal => literal == *presented,
            })
}

// ---------------------------------------------------------------------------
// the door
// ---------------------------------------------------------------------------

/// The stable ids a door audit row names — never the envelope, never its hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Holder {
    token_id: Uuid,
    member_id: Uuid,
    workspace_id: Uuid,
}

impl Holder {
    fn of(identity: &DevIdentity) -> Self {
        Holder {
            token_id: identity.token_id,
            member_id: identity.member_id,
            workspace_id: identity.workspace_id,
        }
    }
}

/// Why a live, resolved token was refused with a 403.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    /// The member's role is outside the workspace policy today (D3).
    Policy,
    /// The token lacks the route's scope (D4).
    Scope,
}

impl Refusal {
    /// `detail.reason` — the closed vocabulary.
    fn label(self) -> &'static str {
        match self {
            Refusal::Policy => "policy",
            Refusal::Scope => "scope",
        }
    }

    fn answer(self) -> ApiError {
        match self {
            Refusal::Policy => access_denied(),
            Refusal::Scope => scope_denied(),
        }
    }
}

/// What the tenant transaction decided. Every variant commits: the refusals are
/// returned before the transaction's first write.
#[derive(Debug)]
enum DoorVerdict {
    Admitted(Box<DevIdentity>),
    Unknown,
    Refused {
        holder: Holder,
        refusal: Refusal,
    },
    RateLimited {
        holder: Holder,
        retry_after_seconds: u64,
        axes: Vec<&'static str>,
    },
}

/// The developer-token arm of [`crate::auth::require_principal`], for a bearer
/// [`is_dev_envelope`] claimed. See the module docs for the order and the answers.
pub(crate) async fn require_dev_principal(
    state: &AppState,
    raw_token: &str,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    // Only a well-formed card/access envelope goes on. A refresh envelope is the
    // rotation route's (#4700), never the data door's, and is answered exactly like
    // an unknown string — without the database.
    let Some(claimed_workspace) = dev_token_workspace_id(raw_token) else {
        return Err(invalid_token());
    };

    let method = request.method().as_str().to_string();
    let matched = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| matched.as_str().to_string());
    let Some(required_scope) = dev_route_scope(
        &method,
        matched.as_deref(),
        request.uri().path(),
        claimed_workspace,
    ) else {
        return Err(route_not_allowed());
    };
    // `dev_route_scope` answered `Some`, so the router did match a template.
    let route = matched.ok_or_else(route_not_allowed)?;

    match decide(
        state,
        raw_token,
        claimed_workspace,
        &method,
        &route,
        required_scope,
    )
    .await?
    {
        DoorVerdict::Admitted(identity) => {
            let identity = *identity;
            request.extensions_mut().insert(Principal {
                member_id: identity.member_id,
                workspace_id: identity.workspace_id,
                token_id: Some(identity.token_id),
                scopes: identity.scopes.clone(),
                kind: PrincipalKind::Human,
            });
            request.extensions_mut().insert(DevCredential {
                token_id: identity.token_id,
                form: identity.form,
                scopes: identity.scopes.clone(),
                channel_ids: identity.channel_ids.clone(),
            });
            request.extensions_mut().insert(identity);
            Ok(next.run(request).await)
        }
        DoorVerdict::Unknown => Err(invalid_token()),
        DoorVerdict::Refused { holder, refusal } => {
            record_bounded_refusal(
                state,
                format!("dev:audit:refused:{}", holder.token_id),
                door_audit(
                    holder,
                    AUDIT_ACTION_SCOPE_DENIED,
                    USE_SCHEMA,
                    use_detail(&method, &route, required_scope, Some(refusal)),
                ),
            )
            .await;
            Err(refusal.answer())
        }
        DoorVerdict::RateLimited {
            holder,
            retry_after_seconds,
            axes,
        } => {
            let window_seconds = state.dev_access.normalized().window_seconds;
            record_bounded_refusal(
                state,
                format!("dev:audit:rate:{}", holder.token_id),
                door_audit(
                    holder,
                    AUDIT_ACTION_RATE_LIMITED,
                    RATE_LIMIT_SCHEMA,
                    json!({
                        "method": method,
                        "route": route,
                        "required_scope": required_scope,
                        "axes": axes,
                        "window_seconds": window_seconds,
                    }),
                ),
            )
            .await;
            Ok(crate::rate_limit::too_many_requests(retry_after_seconds))
        }
    }
}

/// Steps 3–5 of the module docs, in one tenant transaction on the claimed workspace.
async fn decide(
    state: &AppState,
    raw_token: &str,
    claimed_workspace: Uuid,
    method: &str,
    route: &str,
    required_scope: &'static str,
) -> Result<DoorVerdict, ApiError> {
    let raw_token = raw_token.to_string();
    let method = method.to_string();
    let route = route.to_string();
    let agent_port = state.agent_port.clone();
    let config = state.dev_access.normalized();
    with_tenant_tx(&state.pool, claimed_workspace, move |conn| {
        Box::pin(async move {
            let identity =
                match resolve_dev_token_in_tx(conn, claimed_workspace, &raw_token, FIXED_POLICY)
                    .await
                    .map_err(DbError::from)?
                {
                    DevResolution::Unknown => return Ok(DoorVerdict::Unknown),
                    DevResolution::PolicyDenied(identity) => {
                        return Ok(DoorVerdict::Refused {
                            holder: Holder::of(&identity),
                            refusal: Refusal::Policy,
                        })
                    }
                    DevResolution::Active(identity) => identity,
                };
            if !identity.has_scope(required_scope) {
                return Ok(DoorVerdict::Refused {
                    holder: Holder::of(&identity),
                    refusal: Refusal::Scope,
                });
            }

            // D9 budgets on stable ids. `check_many` admits all axes or none, so the
            // largest denied `Retry-After` is truthful (rate_limit.rs).
            let token_key = format!("dev:token:{}", identity.token_id);
            let member_key = format!("dev:member:{}", identity.member_id);
            let write_key = write_budget_key(identity.token_id);
            let mut axes = vec![
                ("token", token_key.as_str(), config.per_token_limit),
                ("member", member_key.as_str(), config.per_member_limit),
            ];
            if required_scope == SCOPE_DEV_MESSAGES_WRITE {
                axes.push(("write", write_key.as_str(), config.write_per_token_limit));
            }
            let verdicts = agent_port.limiter.check_many(
                &axes
                    .iter()
                    .map(|(_, key, limit)| (*key, *limit))
                    .collect::<Vec<_>>(),
                Duration::from_secs(config.window_seconds),
            );
            let mut retry_after_seconds = 0;
            let mut denied_axes = Vec::new();
            for ((axis, _, limit), verdict) in axes.iter().zip(&verdicts) {
                if verdict.allowed {
                    continue;
                }
                retry_after_seconds = retry_after_seconds.max(verdict.retry_after_seconds);
                denied_axes.push(*axis);
                if verdict.should_log {
                    tracing::warn!(
                        axis,
                        limit,
                        window_seconds = config.window_seconds,
                        token_id = %identity.token_id,
                        member_id = %identity.member_id,
                        "developer-token rate limit exceeded"
                    );
                }
            }
            if !denied_axes.is_empty() {
                // Nothing written: no `last_used_at`, no `used` row.
                return Ok(DoorVerdict::RateLimited {
                    holder: Holder::of(&identity),
                    retry_after_seconds: retry_after_seconds.max(1),
                    axes: denied_axes,
                });
            }

            if !finalize_dev_use_in_tx(conn, &identity, FIXED_POLICY)
                .await
                .map_err(DbError::from)?
            {
                return Ok(DoorVerdict::Unknown);
            }
            write_audit(
                conn,
                &door_audit(
                    Holder::of(&identity),
                    AUDIT_ACTION_USED,
                    USE_SCHEMA,
                    use_detail(&method, &route, required_scope, None),
                ),
            )
            .await?;
            Ok(DoorVerdict::Admitted(Box::new(identity)))
        })
    })
    .await
    .map_err(|error| ApiError::internal("auth.dev_token", error))
}

// ---------------------------------------------------------------------------
// the send budget, shared with the human MCP
// ---------------------------------------------------------------------------

/// The limiter key of a developer token's **send** budget (D9: 30 per window by default).
///
/// One function, because two doors spend this one counter: the door itself, for
/// `POST …/channels/{ch}/messages` (L6, in [`decide`]'s `check_many`), and the human
/// MCP's `post` tool ([`spend_write_budget`]). The MCP row's own route scope is
/// `dev:identity`, so [`decide`] cannot know that one of its JSON-RPC calls is a send;
/// the tool spends the same key itself. Two spellings of this key would be two
/// budgets, and a token could send 30 a window over each.
pub(crate) fn write_budget_key(token_id: Uuid) -> String {
    format!("dev:write:{token_id}")
}

/// Spend one unit of `token_id`'s send budget from the counter L6 spends: `Ok(())`
/// admits, `Err(seconds)` is the refusal and its `Retry-After`. Reads the same
/// [`crate::config::DevAccessConfig`] the door reads (normalised: a 0 is never "off"),
/// over the same window, in the same limiter map (`agent_port.limiter`).
pub(crate) fn spend_write_budget(state: &AppState, token_id: Uuid) -> Result<(), u64> {
    let config = state.dev_access.normalized();
    let verdict = state.agent_port.limiter.check(
        &write_budget_key(token_id),
        config.write_per_token_limit,
        Duration::from_secs(config.window_seconds),
    );
    if verdict.allowed {
        return Ok(());
    }
    if verdict.should_log {
        tracing::warn!(
            axis = "write",
            limit = config.write_per_token_limit,
            window_seconds = config.window_seconds,
            token_id = %token_id,
            "developer-token rate limit exceeded"
        );
    }
    Err(verdict.retry_after_seconds.max(1))
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

/// `detail` of a `used` (`refusal: None`) or `scope_denied` row: the closed
/// vocabulary and nothing else — the route is the *template*.
fn use_detail(method: &str, route: &str, required_scope: &str, refusal: Option<Refusal>) -> Value {
    let mut detail = json!({
        "method": method,
        "route": route,
        "required_scope": required_scope,
        "granted": refusal.is_none(),
    });
    if let Some(refusal) = refusal {
        detail["reason"] = Value::from(refusal.label());
    }
    detail
}

/// One door row: by the member, via the token row, about a route — the shape of the
/// agent bearer's `auth.agent_bearer.*` rows.
fn door_audit(holder: Holder, action: &str, schema: &str, detail: Value) -> AuditEntry {
    let mut entry = AuditEntry::new(holder.workspace_id, action)
        .by(holder.member_id)
        .via_token(Some(holder.token_id))
        .with_schema(schema, detail);
    entry.target_type = Some("route".to_string());
    entry
}

/// Write one refusal row unless `bucket` already has its row for the current window
/// (module docs, "Refusal rows are bounded"). The slot is taken on the task, before
/// the write, and given back only when the write failed — so a stalled database
/// cannot let a second burst through, and a failure lets the next refusal retry. The
/// request waits for the task (so the row precedes the answer) but cannot cancel it.
/// Never fails the request.
async fn record_bounded_refusal(state: &AppState, bucket: String, entry: AuditEntry) {
    let agent_port = state.agent_port.clone();
    let pool = state.pool.clone();
    let window = Duration::from_secs(state.dev_access.normalized().window_seconds);
    let task = tokio::spawn(async move {
        let claimed_at = Instant::now();
        if !agent_port
            .limiter
            .check_at(&bucket, 1, window, claimed_at)
            .allowed
        {
            return;
        }
        let action = entry.action.clone();
        let workspace_id = entry.workspace_id;
        let written = with_tenant_tx(&pool, workspace_id, move |conn| {
            Box::pin(async move { write_audit(conn, &entry).await.map(|_| ()) })
        })
        .await;
        if let Err(error) = written {
            agent_port.limiter.forget_at(&bucket, claimed_at);
            tracing::error!(
                error = %error,
                action,
                "developer-token refusal audit failed; the refusal stands and the next one retries the row"
            );
        }
    });
    if let Err(error) = task.await {
        tracing::error!(error = %error, "developer-token refusal audit task did not finish");
    }
}

// ---------------------------------------------------------------------------
// refresh rotation (the login lineage, D2·D7)
// ---------------------------------------------------------------------------

/// Rotate a login lineage's refresh envelope into a fresh pair — the server half the
/// refresh route (#4700) will call; nothing mounts it yet.
///
/// The refresh side of the envelope dispatch happens here: only a well-formed
/// `momo_devr_v1` envelope naming `workspace_id` reaches the database. A card or
/// access envelope (`momo_dev_v1`), another workspace's refresh, or anything else is
/// the same [`DevRotation::Invalid`] an unknown refresh is (R2 ii, the second half;
/// the SQL's own `dev_form = 'refresh'` filter is the independent wall behind it).
///
/// On reuse (`ReuseDetected`, R10) the domain function has already revoked every
/// still-live row of the lineage **in this transaction**, so the result is returned as
/// `Ok` and the transaction commits — an error here would roll the revocation back.
/// When it revoked something, one `auth.dev_token.refresh_reuse_detected` row is
/// written in the same transaction, inside a savepoint: a failed audit write is
/// logged and cannot undo the revocation (D9 — an audit failure changes nothing; the
/// `momo-push` dispatch-log precedent). `revoked == 0` means the lineage had already
/// ended, so there is nothing new to report and no row.
pub async fn rotate_dev_refresh(
    state: &AppState,
    workspace_id: Uuid,
    raw_refresh: &str,
) -> Result<DevRotation, DbError> {
    if dev_refresh_workspace_id(raw_refresh) != Some(workspace_id) {
        return Ok(DevRotation::Invalid);
    }
    let raw_refresh = raw_refresh.to_string();
    with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let rotation = rotate_dev_refresh_in_tx(conn, workspace_id, &raw_refresh, FIXED_POLICY)
                .await
                .map_err(DbError::from)?;
            if let DevRotation::ReuseDetected {
                session_id,
                member_id,
                revoked,
            } = &rotation
            {
                if *revoked > 0 {
                    let entry = AuditEntry::new(workspace_id, AUDIT_ACTION_REFRESH_REUSE_DETECTED)
                        // The presenter is unknown (it may be the thief); the lineage's
                        // owner is who it is about.
                        .about(*member_id)
                        .target("dev_lineage", *session_id)
                        .with_schema(REFRESH_REUSE_SCHEMA, json!({ "revoked_tokens": revoked }));
                    let mut savepoint = momo_db::sqlx::Connection::begin(&mut *conn)
                        .await
                        .map_err(DbError::from)?;
                    match write_audit(&mut savepoint, &entry).await {
                        Ok(_) => savepoint.commit().await.map_err(DbError::from)?,
                        Err(error) => {
                            savepoint.rollback().await.map_err(DbError::from)?;
                            tracing::error!(
                                error = %error,
                                "developer refresh reuse audit failed; the lineage stays revoked"
                            );
                        }
                    }
                }
            }
            Ok(rotation)
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use axum::routing::{get, post};
    use axum::Router;
    use momo_auth::dev_token::{
        SCOPE_DEV_CHANNELS_READ, SCOPE_DEV_IDENTITY, SCOPE_DEV_INBOX_READ, SCOPE_DEV_MESSAGES_READ,
    };

    use super::*;

    /// Hex letters on purpose: an upper-cased copy of this id is a different string.
    const WS: Uuid = Uuid::from_u128(0xa1b2_c3d4_e5f6_4a7b_8c9d_0e1f_2a3b_4c5d);
    const OTHER_WS: Uuid = Uuid::from_u128(0xb2c3_d4e5_f6a7_4b8c_9d0e_1f2a_3b4c_5d6e);
    /// 43 base64url characters — the shape of a minted secret. Not a credential.
    const SECRET: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn card(workspace: Uuid) -> String {
        format!("{DEV_TOKEN_PREFIX}.{}.{SECRET}", workspace.hyphenated())
    }

    fn refresh(workspace: Uuid) -> String {
        format!("{DEV_REFRESH_PREFIX}.{}.{SECRET}", workspace.hyphenated())
    }

    fn ws_path(rest: &str) -> String {
        format!("/v1/workspaces/{}{rest}", WS.hyphenated())
    }

    // -- the closed table, before the database ------------------------------

    /// R3 (a) through the door's own judgment: each L1–L7 row, on a path naming the
    /// envelope's workspace, yields exactly its scope.
    #[test]
    fn every_workspace_row_of_the_table_yields_its_scope() {
        let rows = [
            (
                "GET",
                "/v1/workspaces/{ws}/dev-access/self",
                "/dev-access/self",
                SCOPE_DEV_IDENTITY,
            ),
            (
                "DELETE",
                "/v1/workspaces/{ws}/dev-access/self",
                "/dev-access/self",
                SCOPE_DEV_IDENTITY,
            ),
            (
                "GET",
                "/v1/workspaces/{ws}/channels",
                "/channels",
                SCOPE_DEV_CHANNELS_READ,
            ),
            (
                "GET",
                "/v1/workspaces/{ws}/channels/{ch}/messages",
                "/channels/c1/messages",
                SCOPE_DEV_MESSAGES_READ,
            ),
            (
                "GET",
                "/v1/workspaces/{ws}/channels/{ch}/messages/{root}/replies",
                "/channels/c1/messages/r1/replies",
                SCOPE_DEV_MESSAGES_READ,
            ),
            (
                "POST",
                "/v1/workspaces/{ws}/channels/{ch}/messages",
                "/channels/c1/messages",
                SCOPE_DEV_MESSAGES_WRITE,
            ),
            (
                "GET",
                "/v1/workspaces/{ws}/inbox",
                "/inbox",
                SCOPE_DEV_INBOX_READ,
            ),
        ];
        for (method, template, rest, scope) in rows {
            assert_eq!(
                dev_route_scope(method, Some(template), &ws_path(rest), WS),
                Some(scope),
                "{method} {template}"
            );
        }
    }

    /// L8 has no `{ws}`: the envelope alone names the workspace.
    #[test]
    fn the_mcp_row_has_no_workspace_segment_to_compare() {
        assert_eq!(
            dev_route_scope("POST", Some("/v1/mcp/me"), "/v1/mcp/me", WS),
            Some(SCOPE_DEV_IDENTITY)
        );
        assert_eq!(
            dev_route_scope("GET", Some("/v1/mcp/me"), "/v1/mcp/me", WS),
            None
        );
    }

    /// No matched template is a refusal, whatever the raw path looks like (fail
    /// closed: the raw path's shape is never the key).
    #[test]
    fn no_matched_template_is_refused() {
        assert_eq!(
            dev_route_scope("GET", None, &ws_path("/channels"), WS),
            None
        );
    }

    /// HEAD, OPTIONS, a lowercase method and an off-table method on a table path
    /// are refused.
    #[test]
    fn methods_off_the_table_are_refused_on_a_table_path() {
        let template = "/v1/workspaces/{ws}/channels";
        for method in ["HEAD", "OPTIONS", "get", "PUT", "PATCH", "DELETE", "POST"] {
            assert_eq!(
                dev_route_scope(method, Some(template), &ws_path("/channels"), WS),
                None,
                "{method}"
            );
        }
    }

    /// Templates off the table are refused — among them both approval-decision
    /// routes, token issuance, and a message edit.
    #[test]
    fn templates_off_the_table_are_refused() {
        for (method, template, path) in [
            (
                "POST",
                "/v1/workspaces/{ws}/approvals/{approval}/decisions",
                ws_path("/approvals/a1/decisions"),
            ),
            (
                "POST",
                "/v1/agent-runs/{run}/approval-decisions",
                "/v1/agent-runs/r1/approval-decisions".to_string(),
            ),
            (
                "POST",
                "/v1/workspaces/{ws}/dev-access/credentials",
                ws_path("/dev-access/credentials"),
            ),
            (
                "PATCH",
                "/v1/workspaces/{ws}/channels/{ch}/messages/{msg}",
                ws_path("/channels/c1/messages/m1"),
            ),
        ] {
            assert_eq!(
                dev_route_scope(method, Some(template), &path, WS),
                None,
                "{method} {template}"
            );
        }
    }

    /// `{ws}` must name the envelope's workspace: another workspace, a non-UUID, an
    /// empty segment and a percent-encoded one are all refused.
    #[test]
    fn a_workspace_segment_that_is_not_the_envelopes_is_refused() {
        let template = Some("/v1/workspaces/{ws}/channels");
        let other = format!("/v1/workspaces/{}/channels", OTHER_WS.hyphenated());
        assert_eq!(dev_route_scope("GET", template, &other, WS), None);
        assert_eq!(
            dev_route_scope("GET", template, "/v1/workspaces/not-a-uuid/channels", WS),
            None
        );
        assert_eq!(
            dev_route_scope("GET", template, "/v1/workspaces//channels", WS),
            None
        );
        // The envelope's own workspace with its first character percent-encoded: the
        // handler would decode it to the same id, but the door reads the raw segment
        // and refuses rather than decode.
        let hyphenated = WS.hyphenated().to_string();
        let encoded = format!(
            "/v1/workspaces/%{:02X}{}/channels",
            hyphenated.as_bytes()[0],
            &hyphenated[1..]
        );
        assert_eq!(dev_route_scope("GET", template, &encoded, WS), None);
        // An upper-case spelling parses to the same id, as the handlers parse it.
        let upper = format!("/v1/workspaces/{}/channels", hyphenated.to_uppercase());
        assert_eq!(
            dev_route_scope("GET", template, &upper, WS),
            Some(SCOPE_DEV_CHANNELS_READ)
        );
        // The control: the same request naming the envelope's workspace passes.
        assert_eq!(
            dev_route_scope("GET", template, &ws_path("/channels"), WS),
            Some(SCOPE_DEV_CHANNELS_READ)
        );
    }

    /// A raw path that does not line up with the template is refused rather than
    /// guessed at.
    #[test]
    fn a_raw_path_that_does_not_line_up_with_the_template_is_refused() {
        let template = Some("/v1/workspaces/{ws}/channels/{ch}/messages");
        for path in [
            format!("/{}", ws_path("/channels/c1/messages")),
            ws_path("/channels/c1/messages/"),
            ws_path("/channels/c1/extra/messages"),
            ws_path("/Channels/c1/messages"),
        ] {
            assert_eq!(dev_route_scope("GET", template, &path, WS), None, "{path}");
        }
    }

    // -- envelope dispatch ---------------------------------------------------

    #[test]
    fn only_developer_prefixes_are_developer_envelopes() {
        assert!(is_dev_envelope(&card(WS)));
        assert!(is_dev_envelope(&refresh(WS)));
        assert!(is_dev_envelope("momo_dev_v1.not-a-uuid.short"));
        assert!(is_dev_envelope("momo_devr_v1"));
        assert!(!is_dev_envelope(
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"
        ));
        assert!(!is_dev_envelope(&format!(
            "momo_agent_v1.{}.{SECRET}",
            WS.hyphenated()
        )));
        assert!(!is_dev_envelope("momo_dev_v2.x.y"));
        assert!(!is_dev_envelope("xmomo_dev_v1.x.y"));
    }

    // -- answers ---------------------------------------------------------------

    #[test]
    fn the_refusals_carry_their_codes_and_the_unknown_answer_carries_none() {
        let unknown = invalid_token();
        assert_eq!(unknown.status, StatusCode::UNAUTHORIZED);
        assert_eq!(unknown.message, "invalid or expired token");
        assert_eq!(unknown.code, None);
        for (error, code) in [
            (route_not_allowed(), CODE_ROUTE_NOT_ALLOWED),
            (access_denied(), CODE_ACCESS_DENIED),
            (scope_denied(), CODE_SCOPE_DENIED),
        ] {
            assert_eq!(error.status, StatusCode::FORBIDDEN);
            assert_eq!(error.code, Some(code));
            assert_eq!(error.retry_after_seconds, None);
        }
        assert_eq!(Refusal::Policy.answer().code, Some(CODE_ACCESS_DENIED));
        assert_eq!(Refusal::Scope.answer().code, Some(CODE_SCOPE_DENIED));
    }

    /// R15 / D9: the audit detail is the closed vocabulary — exactly these keys, the
    /// route as given (the template), and `reason` only on a refusal.
    #[test]
    fn the_use_detail_is_the_closed_vocabulary() {
        let template = "/v1/workspaces/{ws}/channels/{ch}/messages";
        let granted = use_detail("POST", template, SCOPE_DEV_MESSAGES_WRITE, None);
        assert_eq!(
            granted,
            json!({
                "method": "POST",
                "route": template,
                "required_scope": SCOPE_DEV_MESSAGES_WRITE,
                "granted": true,
            })
        );
        let refused = use_detail(
            "GET",
            template,
            SCOPE_DEV_MESSAGES_READ,
            Some(Refusal::Policy),
        );
        assert_eq!(
            refused,
            json!({
                "method": "GET",
                "route": template,
                "required_scope": SCOPE_DEV_MESSAGES_READ,
                "granted": false,
                "reason": "policy",
            })
        );
        let entry = door_audit(
            Holder {
                token_id: Uuid::from_u128(3),
                member_id: Uuid::from_u128(4),
                workspace_id: WS,
            },
            AUDIT_ACTION_USED,
            USE_SCHEMA,
            granted,
        );
        assert_eq!(entry.via_token_id, Some(Uuid::from_u128(3)));
        assert_eq!(entry.actor_member_id, Some(Uuid::from_u128(4)));
        assert_eq!(entry.target_type.as_deref(), Some("route"));
        assert_eq!(entry.detail["schema"], USE_SCHEMA);
    }

    // -- the middleware, over a real socket, without a database ---------------

    /// The real `require_principal` in front of three stub routes: two on the table
    /// (`GET …/channels`, `GET …/inbox`) and one off it (an approval decision). The
    /// pool never dials, so anything that reaches the database answers 500 — which is
    /// how the control below proves the refusals were decided before it. Returns the
    /// base URL and the handler-hit counter.
    async fn serve_door() -> (String, Arc<AtomicUsize>) {
        let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(250))
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .expect("a lazy pool never dials");
        let state = AppState::new(
            pool,
            "dev-door-unit-test-secret".to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        );
        let hits = Arc::new(AtomicUsize::new(0));
        let counted = |hits: Arc<AtomicUsize>| {
            move || {
                let hits = hits.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    "reached"
                }
            }
        };
        let app = Router::new()
            .route("/v1/workspaces/{ws}/channels", get(counted(hits.clone())))
            .route("/v1/workspaces/{ws}/inbox", get(counted(hits.clone())))
            .route(
                "/v1/workspaces/{ws}/approvals/{approval}/decisions",
                post(counted(hits.clone())),
            )
            .route_layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::require_principal,
            ))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind an ephemeral port");
        let address: SocketAddr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{address}"), hits)
    }

    async fn send(
        base: &str,
        method: reqwest::Method,
        path: &str,
        bearer: &str,
    ) -> (reqwest::StatusCode, Option<String>, String) {
        let response = reqwest::Client::new()
            .request(method, format!("{base}{path}"))
            .header("authorization", format!("Bearer {bearer}"))
            .send()
            .await
            .expect("the test server answers");
        let status = response.status();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        (status, retry_after, response.text().await.expect("a body"))
    }

    /// R2 (ii)(iii), R3 (b)(c) and D4 without a database: every refusal the door can
    /// make before the database is made before it, with the right answer, and no
    /// handler runs. A refresh envelope and a malformed developer string at the data
    /// door are the unknown-token 401, byte for byte the App JWT arm's.
    #[tokio::test]
    async fn the_door_refuses_before_the_database_and_reaches_no_handler() {
        let (base, hits) = serve_door().await;
        let channels = ws_path("/channels");

        // The App JWT arm's answer to a string it cannot verify — the reference bytes.
        let jwt_refusal = send(&base, reqwest::Method::GET, &channels, "not-a-token").await;
        assert_eq!(jwt_refusal.0, reqwest::StatusCode::UNAUTHORIZED);

        for bearer in [
            refresh(WS),
            "momo_dev_v1.not-a-uuid.short".to_string(),
            format!(
                "momo_dev_v1.{}.{}",
                WS.hyphenated().to_string().to_uppercase(),
                SECRET
            ),
        ] {
            assert_eq!(
                send(&base, reqwest::Method::GET, &channels, &bearer).await,
                jwt_refusal,
                "a developer string the data door cannot take answers exactly like an unknown token"
            );
        }

        let route_refusal = json!({"error": {
            "message": "developer token is not allowed for this route",
            "code": CODE_ROUTE_NOT_ALLOWED,
        }});
        for (method, path) in [
            // off the table: an approval decision (D4: a developer token never decides)
            (reqwest::Method::POST, ws_path("/approvals/a1/decisions")),
            // a table path with a method off the table
            (reqwest::Method::HEAD, channels.clone()),
            (reqwest::Method::DELETE, ws_path("/inbox")),
            // another workspace in the path
            (
                reqwest::Method::GET,
                format!("/v1/workspaces/{}/channels", OTHER_WS.hyphenated()),
            ),
        ] {
            let (status, retry_after, body) = send(&base, method.clone(), &path, &card(WS)).await;
            assert_eq!(status, reqwest::StatusCode::FORBIDDEN, "{method} {path}");
            assert_eq!(retry_after, None);
            if method != reqwest::Method::HEAD {
                let body: Value = serde_json::from_str(&body).expect("a JSON error envelope");
                assert_eq!(body, route_refusal, "{method} {path}");
            }
        }
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "no refusal reached a handler"
        );

        // The control: a well-formed card on a table route naming its own workspace
        // goes on to the database, which this test does not have — so every refusal
        // above was the door's own, decided before it.
        let (status, _, _) = send(&base, reqwest::Method::GET, &channels, &card(WS)).await;
        assert_eq!(status, reqwest::StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }
}
