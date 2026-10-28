//! `/v1/workspaces/{ws}/dev-access…` — issuing, listing and revoking a person's
//! **developer tokens**, and a developer token's own whoami and logout (ADR-0216
//! D2·D3·D6-가·D7, #4660).
//!
//! ```text
//! GET    /v1/workspaces/{ws}/dev-access                    person  the switch, and what it lets me do
//! GET    /v1/workspaces/{ws}/dev-access/credentials        person  mine; ?scope=all → everyone's (owner/admin)
//! POST   /v1/workspaces/{ws}/dev-access/credentials        person  + current password → a card, secret once
//! DELETE /v1/workspaces/{ws}/dev-access/credentials/{id}   person  mine, or down the ladder; idempotent
//! GET    /v1/workspaces/{ws}/dev-access/self               dev     L1 whoami
//! DELETE /v1/workspaces/{ws}/dev-access/self               dev     L2 logout: this token (lineage) only
//! ```
//!
//! ## Two walls keep a developer token off the first four
//!
//! A developer token authenticates as a *person* — the `Principal` it travels with is
//! `Human` — so `require_human` is no wall against it (D4). The door's closed table
//! (`momo_auth::dev_token::required_dev_scope`) is the first wall: these four templates are
//! not in it, so the door answers 403 `dev_route_not_allowed` before the database. Each of
//! the four handlers is the second: a request that carries the [`DevCredential`] marker is
//! refused with the same code before anything else is looked at, so a developer token can
//! never mint, list or revoke developer tokens even if the table is someday edited wrongly.
//! The narrow push tokens never reach these handlers (their own route lists stop them in
//! the middleware). The two `self` routes are the opposite: they answer a developer token
//! only, and a person's session is refused with 403 `dev_credential_required`.
//!
//! ## Issuance (D6-가)
//!
//! The walls → the failure budget's cheap look → the body → one tenant transaction that
//! takes the workspace's membership lock **shared**, first, and without waiting (#4695 —
//! a suspension, removal, role change or password change holds it exclusively, so this
//! transaction sees the workspace wholly before or wholly after one of them), re-checks that
//! the session this request came in on is still alive, judges the switch, checks the
//! channels, re-checks the current password and issues. Every refusal found inside the
//! transaction is returned as a value after its audit row is written, so the transaction
//! commits the audit row and **no `token` row** (`with_tenant_tx` commits an `Ok`).
//!
//! ## The current-password failure budget (D6-가 2, D9, R7)
//!
//! Five wrong passwords per member per window (`RATE_LIMIT_WINDOW_SECONDS`, a minute by
//! default) — a constant, with no knob that could be set to 0. Only failures count: a right
//! password, an account with no password, and every refusal that comes before the
//! comparison give their slot back or never take one. In a full window even the right
//! password is refused (429 + `Retry-After`), and it is refused **without being compared**:
//! otherwise the 429 would itself tell a right guess from a wrong one.
//!
//! Two looks, one budget. The handler first asks whether the window is already full
//! ([`SlidingWindowRateLimiter::exhausted`]) and turns the caller away before any database
//! work. That look alone does not bound parallel guesses — every request that arrives while
//! four failures are counted sees room — so the transaction also takes a slot
//! **atomically** ([`SlidingWindowRateLimiter::check_at`]) immediately before the comparison
//! and gives it back ([`SlidingWindowRateLimiter::forget_at`]) unless the comparison failed.
//! At most five comparisons are counted or in flight per window, however many requests race.
//! A request that ends mid-comparison (a database error, a dropped connection) keeps its
//! slot: a comparison that may have run is counted.
//!
//! The key is `dev-pw:{workspace}:{member}`, never the join door's `pwguess:` account
//! budget, which counts right passwords too.
//!
//! ## Who may revoke whose (D7, R21)
//!
//! `momo_auth::dev_token::revoke_dev_credential_in_tx` takes no member: it revokes whatever
//! an id names. **The owner/ladder wall is this route, not the domain function** — remove
//! the check in [`revoke`] and the route tests (R21 a) go red. The credential's owner may
//! revoke it. Otherwise an owner-role member may revoke anyone else's (another owner's
//! included, ADR-0215 F5) and an admin a member's or a guest's
//! ([`WorkspaceRole::can_manage_target`], ADR-0128 D2). A member or guest asking about
//! someone else's id gets the same 404 bytes as an id that does not exist, so this route is
//! no oracle for which ids are live. A repeated revoke answers 200 (`revokedNow: false`) and
//! writes no second audit row.

use std::time::{Duration, Instant};

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::{
    active_workspace_role, dev_credential_owner_in_tx, has_active_realtime_credential,
    issue_dev_card_in_tx, list_dev_credentials_in_tx, normalized_current_password,
    normalized_dev_channel_ids, normalized_dev_label, normalized_dev_scopes,
    revoke_dev_credential_in_tx, revoke_dev_self_in_tx, validated_dev_card_days,
    verify_current_password_in_tx, DevAccessPolicy, DevCredentialRecord, DevForm, DevIdentity,
    DevIssueError, DevListScope, DevTool, IssuedDevCard, NewDevCard, PasswordCheck, Principal,
    WorkspaceRole, DEV_CREDENTIAL_KIND_CARD, DEV_CREDENTIAL_KIND_SESSION, DEV_FIXED_POLICY,
    DEV_MAX_CHANNEL_IDS, DEV_MAX_LIFETIME_DAYS,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{DbError, PgConnection};
use momo_messaging::is_channel_member;
use momo_settings::try_share_membership_state;
use serde_json::json;
use uuid::Uuid;

use crate::config::RateLimitConfig;
use crate::dev_credential::DevCredential;
use crate::dto::{
    CreateDevCredentialRequest, CreateDevCredentialResponse, DevAccessPolicyResponse,
    DevAccessSelfResponse, DevCredentialDto, DevCredentialListQuery, DevCredentialListResponse,
    OptionalPatch, RevokeDevCredentialResponse,
};
use crate::error::ApiError;
use crate::rate_limit::{SlidingWindowRateLimiter, Verdict};
use crate::routes::auth_routes::MEMBERSHIP_BUSY_RETRY_SECONDS;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
    DbRejectable,
};
use crate::routes::webhooks::no_store;
use crate::AppState;

/// The switch every judgement here uses until it has storage (D3 「출시 순서」): `admins`.
pub(crate) const POLICY: DevAccessPolicy = DEV_FIXED_POLICY;

/// Wrong current passwords one member may enter per window (D6-가 2, D9 권장값). A
/// constant on purpose: a guessable surface gets no knob that could turn it off (ADR-0180
/// C6).
pub(crate) const PASSWORD_RECHECK_FAILURES_PER_WINDOW: u32 = 5;

/// Refusal codes a client branches on (`error.code`).
const CODE_ROUTE_NOT_ALLOWED: &str = "dev_route_not_allowed";
pub(crate) const CODE_ACCESS_DENIED: &str = "dev_access_denied";
pub(crate) const CODE_CREDENTIAL_LIMIT: &str = "dev_credential_limit";
const CODE_CREDENTIAL_REQUIRED: &str = "dev_credential_required";
pub(crate) const CODE_PASSWORD_INCORRECT: &str = "current_password_incorrect";
pub(crate) const CODE_PASSWORD_UNAVAILABLE: &str = "current_password_unavailable";

/// Lifecycle audit (D9). `detail` is a closed vocabulary: never a name, a channel id, a
/// body, a query, a password or a token.
const AUDIT_ISSUED: &str = "dev_token.issued";
const AUDIT_ISSUE_DENIED: &str = "dev_token.issue_denied";
pub(crate) const AUDIT_REVOKED: &str = "dev_token.revoked";
const SCHEMA_ISSUED: &str = "momo.dev_token.issued.v1";
const SCHEMA_ISSUE_DENIED: &str = "momo.dev_token.issue_denied.v1";
pub(crate) const SCHEMA_REVOKED: &str = "momo.dev_token.revoked.v1";
/// The audit target: the list's id — a card's token id, or a login lineage's id.
pub(crate) const AUDIT_TARGET: &str = "dev_credential";

const MILLIS_PER_DAY: i64 = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------

/// The second wall (module docs): a developer token on a route only a person's session
/// may use. The same code and sentence the door's closed table answers with, so the two
/// walls are indistinguishable from outside.
pub(crate) fn refuse_developer_token(by_developer_token: bool) -> Result<(), ApiError> {
    if by_developer_token {
        return Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            CODE_ROUTE_NOT_ALLOWED,
            "developer token is not allowed for this route",
        ));
    }
    Ok(())
}

/// A person's session on a route that answers a developer token only (L1, L2).
fn developer_token_required() -> ApiError {
    ApiError::coded(
        StatusCode::FORBIDDEN,
        CODE_CREDENTIAL_REQUIRED,
        "this route answers a developer token only",
    )
}

/// One sentence for "no such credential" and "someone else's, and you may not manage it",
/// so the two are the same bytes (R21 a).
fn credential_not_found() -> ApiError {
    ApiError::not_found("developer credential not found")
}

fn invalid_field(field: &str) -> ApiError {
    ApiError::bad_request(format!("invalid {field}"))
}

/// The wire name of a field the domain's own re-validation refused.
fn wire_field(domain_field: &'static str) -> &'static str {
    match domain_field {
        "channel_ids" => "channelIds",
        "expires_in_days" => "expiresInDays",
        other => other,
    }
}

/// 429 + `Retry-After` for a full password-failure window.
pub(crate) fn too_many_password_failures(retry_after_seconds: u64) -> ApiError {
    let mut error = ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded");
    error.retry_after_seconds = Some(retry_after_seconds.max(1));
    error
}

/// A body the extractor could not read is a 400 — not axum's 422 for well-formed JSON of
/// the wrong shape — and the answer quotes nothing from it: serde's messages can repeat a
/// value, and that value could be a password typed into the wrong field.
fn issue_body_error(rejection: JsonRejection) -> ApiError {
    let status = match rejection.status() {
        StatusCode::UNPROCESSABLE_ENTITY => StatusCode::BAD_REQUEST,
        other => other,
    };
    ApiError::new(status, "invalid developer credential request")
}

/// Why an issuance was refused after the caller was identified. Each one writes one
/// `dev_token.issue_denied` row whose `detail.reason` is [`IssueDenial::reason`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IssueDenial {
    /// The switch does not admit the caller's role (or the caller is not an active member).
    Policy,
    /// The domain found the member is not a human (R21 d).
    NotHuman,
    /// The current password did not match. The one refusal the failure budget counts.
    PasswordMismatch,
    /// The account has no password to re-check (sign-in without one).
    PasswordUnavailable,
}

impl IssueDenial {
    fn reason(self) -> &'static str {
        match self {
            IssueDenial::Policy => "policy_denied",
            IssueDenial::NotHuman => "not_human",
            IssueDenial::PasswordMismatch => "password_mismatch",
            IssueDenial::PasswordUnavailable => "password_unavailable",
        }
    }

    fn error(self) -> ApiError {
        match self {
            IssueDenial::Policy | IssueDenial::NotHuman => ApiError::coded(
                StatusCode::FORBIDDEN,
                CODE_ACCESS_DENIED,
                "developer access is not allowed for this member's role",
            ),
            IssueDenial::PasswordMismatch => ApiError::coded(
                StatusCode::FORBIDDEN,
                CODE_PASSWORD_INCORRECT,
                "current password is incorrect",
            ),
            IssueDenial::PasswordUnavailable => ApiError::coded(
                StatusCode::FORBIDDEN,
                CODE_PASSWORD_UNAVAILABLE,
                "this account has no password to confirm",
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// the request body (everything that needs no database)
// ---------------------------------------------------------------------------

/// An issuance body that passed every check needing no database. `Debug` redacts the
/// password.
struct ValidatedIssue {
    card: NewDevCard,
    current_password: String,
}

impl std::fmt::Debug for ValidatedIssue {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ValidatedIssue")
            .field("card", &self.card)
            .field("current_password", &"<redacted>")
            .finish()
    }
}

/// The 400s of `POST …/dev-access/credentials`, with the domain's own normalizers so the
/// route and `issue_dev_card_in_tx` cannot disagree about what is valid.
fn validated_issue(request: CreateDevCredentialRequest) -> Result<ValidatedIssue, ApiError> {
    let label = normalized_dev_label(&request.name).map_err(|_| invalid_field("name"))?;
    let tool = DevTool::from_db_label(&request.tool).ok_or_else(|| invalid_field("tool"))?;
    let scopes = match &request.scopes {
        OptionalPatch::Absent => normalized_dev_scopes(None),
        // `[]` is refused here: the normalizer would quietly turn it into whoami-only.
        OptionalPatch::Set(Some(scopes)) if !scopes.is_empty() => {
            normalized_dev_scopes(Some(scopes.as_slice()))
        }
        OptionalPatch::Set(_) => return Err(invalid_field("scopes")),
    }
    .map_err(|_| invalid_field("scopes"))?;
    let channel_ids = match &request.channel_ids {
        OptionalPatch::Absent => None,
        // Counted as sent, before duplicates collapse, so an oversized list is refused
        // without being walked.
        OptionalPatch::Set(Some(ids)) if (1..=DEV_MAX_CHANNEL_IDS).contains(&ids.len()) => {
            normalized_dev_channel_ids(Some(ids.as_slice()))
                .map_err(|_| invalid_field("channelIds"))?
        }
        // `null` would otherwise read as "every channel".
        OptionalPatch::Set(_) => return Err(invalid_field("channelIds")),
    };
    let expires_in_days = match request.expires_in_days {
        OptionalPatch::Absent => validated_dev_card_days(None),
        OptionalPatch::Set(Some(days)) => validated_dev_card_days(Some(days)),
        // `null` would otherwise read as the 30-day default (R5 b).
        OptionalPatch::Set(None) => return Err(invalid_field("expiresInDays")),
    }
    .map_err(|_| invalid_field("expiresInDays"))?;
    let current_password = normalized_current_password(&request.current_password)
        .map_err(|_| invalid_field("currentPassword"))?;
    Ok(ValidatedIssue {
        card: NewDevCard {
            label,
            tool,
            scopes,
            channel_ids,
            expires_in_days,
        },
        current_password,
    })
}

/// `?scope=` of the list: absent is the caller's own, `all` the workspace's.
fn list_scope_is_all(raw: Option<&str>) -> Result<bool, ApiError> {
    match raw {
        None => Ok(false),
        Some("all") => Ok(true),
        Some(_) => Err(ApiError::bad_request("scope must be all or omitted")),
    }
}

// ---------------------------------------------------------------------------
// the current-password failure budget (module docs)
// ---------------------------------------------------------------------------

/// The key one member's wrong current passwords are counted under. Its own prefix: the
/// join door's account budget (`pwguess:`) counts right passwords as well, so the two must
/// never share a bucket.
pub(crate) fn password_recheck_key(workspace_id: Uuid, member_id: Uuid) -> String {
    format!("dev-pw:{workspace_id}:{member_id}")
}

/// The window every limiter in the process shares; floored at a second, as the env
/// reader does, so a hand-built config cannot make the budget meaningless.
pub(crate) fn password_recheck_window(config: &RateLimitConfig) -> Duration {
    Duration::from_secs(config.window_seconds.max(1))
}

/// The cheap look before any work: `Some(retry after)` when the window is already full.
pub(crate) fn password_recheck_exhausted(
    limiter: &SlidingWindowRateLimiter,
    key: &str,
    window: Duration,
) -> Option<u64> {
    limiter.exhausted(key, PASSWORD_RECHECK_FAILURES_PER_WINDOW, window)
}

/// Take one slot, atomically, immediately before the comparison. `Ok(at)` names the slot
/// for [`refund_password_recheck`]; `Err(verdict)` means the window is full.
pub(crate) fn reserve_password_recheck(
    limiter: &SlidingWindowRateLimiter,
    key: &str,
    window: Duration,
    now: Instant,
) -> Result<Instant, Verdict> {
    let verdict = limiter.check_at(key, PASSWORD_RECHECK_FAILURES_PER_WINDOW, window, now);
    if verdict.allowed {
        Ok(now)
    } else {
        Err(verdict)
    }
}

/// Give a slot back: the comparison was not a failure.
pub(crate) fn refund_password_recheck(limiter: &SlidingWindowRateLimiter, key: &str, at: Instant) {
    limiter.forget_at(key, at);
}

pub(crate) fn log_password_budget_full(workspace_id: Uuid, member_id: Uuid) {
    // One line per burst. The ids are not secrets; nothing the request sent is logged.
    tracing::warn!(
        workspace_id = %workspace_id,
        member_id = %member_id,
        limit = PASSWORD_RECHECK_FAILURES_PER_WINDOW,
        "developer token: wrong current passwords are over budget"
    );
}

// ---------------------------------------------------------------------------
// projections (no secret ever enters one, except the 201's `token`)
// ---------------------------------------------------------------------------

fn policy_view(policy: DevAccessPolicy, role: WorkspaceRole) -> DevAccessPolicyResponse {
    DevAccessPolicyResponse {
        policy: policy.as_str(),
        can_create: policy.allows(role),
        can_manage_all: role.is_admin(),
    }
}

fn credential_kind(form: DevForm) -> &'static str {
    match form {
        DevForm::Card => DEV_CREDENTIAL_KIND_CARD,
        DevForm::Access | DevForm::Refresh => DEV_CREDENTIAL_KIND_SESSION,
    }
}

/// The list's id for the calling token: the card itself, or its login lineage.
fn self_credential_id(identity: &DevIdentity) -> Uuid {
    match identity.form {
        DevForm::Card => identity.token_id,
        DevForm::Access | DevForm::Refresh => identity.session_id.unwrap_or(identity.token_id),
    }
}

fn issued_response(issued: IssuedDevCard) -> CreateDevCredentialResponse {
    CreateDevCredentialResponse {
        id: issued.id.to_string(),
        kind: DEV_CREDENTIAL_KIND_CARD,
        name: issued.label,
        tool: issued.tool.as_db_label(),
        scopes: issued.scopes,
        channel_ids: issued
            .channel_ids
            .map(|ids| ids.iter().map(Uuid::to_string).collect()),
        created_at_ms: issued.created_at_ms,
        expires_at_ms: issued.expires_at_ms,
        token: issued.secret,
    }
}

fn credential_dto(record: &DevCredentialRecord) -> DevCredentialDto {
    DevCredentialDto {
        id: record.id.to_string(),
        member_id: record.member_id.to_string(),
        kind: record.kind,
        name: record.label.clone(),
        tool: record.tool.clone(),
        scopes: record.scopes.clone(),
        channel_restricted: record.channel_restricted,
        device_name: record.device_name.clone(),
        created_at_ms: record.created_at_ms,
        last_used_at_ms: record.last_used_at_ms,
        expires_at_ms: record.expires_at_ms,
        lineage_expires_at_ms: record.lineage_expires_at_ms,
    }
}

pub(crate) fn self_response(identity: &DevIdentity) -> DevAccessSelfResponse {
    // A login session's row is its latest access half, minted at the last rotation; the
    // list dates a lineage from its approval (its cap minus 90 days), and so does whoami.
    let created_at_ms = match (identity.form, identity.lineage_expires_at_ms) {
        (DevForm::Access | DevForm::Refresh, Some(cap)) => {
            cap - DEV_MAX_LIFETIME_DAYS * MILLIS_PER_DAY
        }
        _ => identity.created_at_ms,
    };
    DevAccessSelfResponse {
        id: self_credential_id(identity).to_string(),
        kind: credential_kind(identity.form),
        name: identity.label.clone(),
        tool: identity.tool.clone(),
        workspace_id: identity.workspace_id.to_string(),
        member_id: identity.member_id.to_string(),
        scopes: identity.scopes.clone(),
        channel_restricted: identity.channel_ids.is_some(),
        device_name: identity.device_name.clone(),
        created_at_ms,
        expires_at_ms: identity.expires_at_ms,
        last_used_at_ms: identity.last_used_at_ms,
        lineage_expires_at_ms: identity.lineage_expires_at_ms,
    }
}

// ---------------------------------------------------------------------------
// the ladder (module docs)
// ---------------------------------------------------------------------------

/// How a revocation was authorised — `detail.via` of `dev_token.revoked`. `Owner` is the
/// credential's owner revoking their own (not the workspace role `owner`); `Admin` is a
/// manager down the ladder; `SelfToken` is a developer token ending itself (L2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RevokeVia {
    Owner,
    Admin,
    SelfToken,
}

impl RevokeVia {
    fn as_str(self) -> &'static str {
        match self {
            RevokeVia::Owner => "owner",
            RevokeVia::Admin => "admin",
            RevokeVia::SelfToken => "self",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ladder {
    Revoke(RevokeVia),
    /// Not the caller's, and the caller manages no one: the answer of an unknown id.
    Hidden,
    /// A manager, but not above this credential's owner.
    Forbidden,
}

/// D7 (ADR-0128 D2, ADR-0215 F5). `owner_role` matters only for an admin caller; an
/// unknown one (the owner is no longer an active member) is refused, not guessed.
/// `can_manage_target` alone would refuse an owner-role caller another owner's credential,
/// which F5 allows, so the owner-role arm does not go through it.
fn revoke_ladder(
    is_own: bool,
    caller_role: WorkspaceRole,
    owner_role: Option<WorkspaceRole>,
) -> Ladder {
    if is_own {
        return Ladder::Revoke(RevokeVia::Owner);
    }
    match caller_role {
        WorkspaceRole::Member | WorkspaceRole::Guest => Ladder::Hidden,
        WorkspaceRole::Owner => Ladder::Revoke(RevokeVia::Admin),
        WorkspaceRole::Admin => match owner_role {
            Some(target) if caller_role.can_manage_target(target) => {
                Ladder::Revoke(RevokeVia::Admin)
            }
            _ => Ladder::Forbidden,
        },
    }
}

// ---------------------------------------------------------------------------
// audit rows
// ---------------------------------------------------------------------------

/// Write the refusal's audit row and return the refusal as a value, so the transaction
/// commits the row (and nothing else).
async fn deny_issue(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    via_token: Option<Uuid>,
    denial: IssueDenial,
) -> DbRejectable<IssuedDevCard> {
    write_audit(
        conn,
        &AuditEntry::new(workspace_id, AUDIT_ISSUE_DENIED)
            .by(member_id)
            .via_token(via_token)
            .with_schema(SCHEMA_ISSUE_DENIED, json!({ "reason": denial.reason() })),
    )
    .await?;
    Ok(Err(denial.error()))
}

#[allow(clippy::too_many_arguments)]
async fn audit_revoked(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    actor: Uuid,
    owner: Uuid,
    credential_id: Uuid,
    kind: &'static str,
    via: RevokeVia,
    via_token: Option<Uuid>,
) -> Result<(), DbError> {
    write_audit(
        conn,
        &AuditEntry::new(workspace_id, AUDIT_REVOKED)
            .by(actor)
            .about(owner)
            .target(AUDIT_TARGET, credential_id)
            .via_token(via_token)
            .with_schema(SCHEMA_REVOKED, json!({ "via": via.as_str(), "kind": kind })),
    )
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// handlers — a person's session
// ---------------------------------------------------------------------------

/// `GET /v1/workspaces/{ws}/dev-access` → `{policy, canCreate, canManageAll}`.
pub async fn policy(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    dev_credential: Option<Extension<DevCredential>>,
    Path(workspace): Path<String>,
) -> Result<Json<DevAccessPolicyResponse>, ApiError> {
    refuse_developer_token(dev_credential.is_some())?;
    require_human(&principal, "developer access is managed by a person")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<WorkspaceRole> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .ok_or_else(|| ApiError::forbidden("not a workspace member")))
            })
        })
        .await;
    let role = settle_db("dev_access.policy", outcome)?;
    Ok(Json(policy_view(POLICY, role)))
}

/// `POST /v1/workspaces/{ws}/dev-access/credentials` → 201 `no-store`, the secret once.
pub async fn issue(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    dev_credential: Option<Extension<DevCredential>>,
    Path(workspace): Path<String>,
    body: Result<Json<CreateDevCredentialRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    refuse_developer_token(dev_credential.is_some())?;
    require_human(&principal, "only a person can create a developer token")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;

    // The budget's cheap look, before the body and before any database work: a member
    // whose window is full is turned away here, right password or not.
    let budget_key = password_recheck_key(workspace_id, member_id);
    let window = password_recheck_window(&state.rate_limit.config);
    if let Some(retry_after) =
        password_recheck_exhausted(&state.rate_limit.limiter, &budget_key, window)
    {
        return Err(too_many_password_failures(retry_after));
    }

    let Json(request) = body.map_err(issue_body_error)?;
    let issue = validated_issue(request)?;
    // The session this request came in on; a person's access token always has its row.
    let session_token_id = principal
        .token_id
        .ok_or_else(|| ApiError::unauthorized("invalid or expired token"))?;
    let via_token = audit_via_token_id(&principal);
    let rate_limit = state.rate_limit.clone();

    let outcome: DbRejectable<IssuedDevCard> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // (1) The membership lock, shared, first, without waiting (#4695). `false`:
                //     a membership change holds it or is next for it — nothing was read.
                if !try_share_membership_state(conn, workspace_id).await? {
                    return Ok(Err(ApiError::busy(MEMBERSHIP_BUSY_RETRY_SECONDS)));
                }
                // (2) The calling session is still alive — unrevoked and unexpired, its
                //     member active. Read after the lock, so a password change (which takes
                //     the lock exclusively and sweeps every session) either committed first
                //     and is seen here, or waits for this commit and then sweeps the card
                //     too. The helper is named for the realtime proxy, its first user; the
                //     predicate is the generic liveness of a person's access row. No row
                //     lock: the membership lock already orders this against every sweep, and
                //     an app logout does not end developer tokens (D7).
                if !has_active_realtime_credential(conn, session_token_id, member_id, workspace_id)
                    .await?
                {
                    return Ok(Err(ApiError::unauthorized("invalid or expired token")));
                }
                // (3) The switch (D3), before the password: a role the switch refuses never
                //     gets a comparison, so it never costs or learns anything.
                let role = active_workspace_role(conn, workspace_id, member_id).await?;
                if !role.is_some_and(|role| POLICY.allows(role)) {
                    return deny_issue(
                        conn,
                        workspace_id,
                        member_id,
                        via_token,
                        IssueDenial::Policy,
                    )
                    .await;
                }
                // (4) The channels: each one the caller is in today (D4).
                if let Some(channel_ids) = issue.card.channel_ids.as_deref() {
                    for channel_id in channel_ids {
                        if !is_channel_member(conn, *channel_id, member_id).await? {
                            return Ok(Err(ApiError::bad_request(
                                "channelIds must name channels you are a member of",
                            )));
                        }
                    }
                }
                // (5) The current password (D6-가 2), under the failure budget's atomic slot.
                let slot = match reserve_password_recheck(
                    &rate_limit.limiter,
                    &budget_key,
                    window,
                    Instant::now(),
                ) {
                    Ok(slot) => slot,
                    Err(verdict) => {
                        if verdict.should_log {
                            log_password_budget_full(workspace_id, member_id);
                        }
                        return Ok(Err(too_many_password_failures(verdict.retry_after_seconds)));
                    }
                };
                match verify_current_password_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    &issue.current_password,
                )
                .await?
                {
                    PasswordCheck::Ok => {
                        refund_password_recheck(&rate_limit.limiter, &budget_key, slot)
                    }
                    PasswordCheck::NoPassword => {
                        // Not a guess: there is nothing to guess against.
                        refund_password_recheck(&rate_limit.limiter, &budget_key, slot);
                        return deny_issue(
                            conn,
                            workspace_id,
                            member_id,
                            via_token,
                            IssueDenial::PasswordUnavailable,
                        )
                        .await;
                    }
                    // The slot stays spent: this is the failure the budget counts.
                    PasswordCheck::Mismatch => {
                        return deny_issue(
                            conn,
                            workspace_id,
                            member_id,
                            via_token,
                            IssueDenial::PasswordMismatch,
                        )
                        .await;
                    }
                }
                // (6) The card. The domain judges human/active/policy and the 20-card limit
                //     again, under its own per-member issuance lock.
                match issue_dev_card_in_tx(conn, workspace_id, member_id, &issue.card, POLICY)
                    .await?
                {
                    Ok(issued) => {
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, AUDIT_ISSUED)
                                .by(member_id)
                                .target(AUDIT_TARGET, issued.id)
                                .via_token(via_token)
                                .with_schema(
                                    SCHEMA_ISSUED,
                                    json!({
                                        "kind": DEV_CREDENTIAL_KIND_CARD,
                                        "tool": issued.tool.as_db_label(),
                                        "scopes": issued.scopes,
                                        "channel_restricted": issued.channel_ids.is_some(),
                                        "expires_in_days": issue.card.expires_in_days,
                                    }),
                                ),
                        )
                        .await?;
                        Ok(Ok(issued))
                    }
                    Err(DevIssueError::LimitReached) => Ok(Err(ApiError::coded(
                        StatusCode::CONFLICT,
                        CODE_CREDENTIAL_LIMIT,
                        "developer credential limit reached",
                    ))),
                    Err(DevIssueError::PolicyDenied) => {
                        deny_issue(
                            conn,
                            workspace_id,
                            member_id,
                            via_token,
                            IssueDenial::Policy,
                        )
                        .await
                    }
                    Err(DevIssueError::NotHuman) => {
                        deny_issue(
                            conn,
                            workspace_id,
                            member_id,
                            via_token,
                            IssueDenial::NotHuman,
                        )
                        .await
                    }
                    Err(DevIssueError::InvalidInput(field)) => {
                        Ok(Err(invalid_field(wire_field(field))))
                    }
                }
            })
        })
        .await;

    let issued = settle_db("dev_access.issue", outcome)?;
    // A bearer credential in a body is never cached (RFC 6749 §5.1's rule for token
    // responses): `no-store` on the one answer that carries it.
    Ok(no_store(
        (StatusCode::CREATED, Json(issued_response(issued))).into_response(),
    ))
}

/// `GET /v1/workspaces/{ws}/dev-access/credentials[?scope=all]` → `no-store`.
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    dev_credential: Option<Extension<DevCredential>>,
    Path(workspace): Path<String>,
    query: Result<Query<DevCredentialListQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    refuse_developer_token(dev_credential.is_some())?;
    require_human(&principal, "only a person can list developer tokens")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let Query(query) = query.map_err(|_| ApiError::bad_request("invalid query"))?;
    let all = list_scope_is_all(query.scope.as_deref())?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<Vec<DevCredentialRecord>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(role) = active_workspace_role(conn, workspace_id, member_id).await? else {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                };
                let scope = if all {
                    if !role.is_admin() {
                        return Ok(Err(ApiError::forbidden("workspace admin required")));
                    }
                    DevListScope::All
                } else {
                    DevListScope::Member(member_id)
                };
                Ok(Ok(
                    list_dev_credentials_in_tx(conn, workspace_id, scope).await?
                ))
            })
        })
        .await;
    let records = settle_db("dev_access.list", outcome)?;
    Ok(no_store(
        Json(DevCredentialListResponse {
            credentials: records.iter().map(credential_dto).collect(),
        })
        .into_response(),
    ))
}

/// `DELETE /v1/workspaces/{ws}/dev-access/credentials/{id}` — idempotent.
pub async fn revoke(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    dev_credential: Option<Extension<DevCredential>>,
    Path((workspace, id)): Path<(String, String)>,
) -> Result<Json<RevokeDevCredentialResponse>, ApiError> {
    refuse_developer_token(dev_credential.is_some())?;
    require_human(&principal, "only a person can revoke developer tokens")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let credential_id = path_uuid(&id, "invalid developer credential id")?;
    let caller = principal.member_id;
    let via_token = audit_via_token_id(&principal);

    let outcome: DbRejectable<RevokeDevCredentialResponse> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(caller_role) = active_workspace_role(conn, workspace_id, caller).await?
                else {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                };
                // Revoked and expired credentials are found too (a repeat stays 200); another
                // workspace's id is not (RLS and the predicate), so it is the 404 below.
                let Some((owner, form)) =
                    dev_credential_owner_in_tx(conn, workspace_id, credential_id).await?
                else {
                    return Ok(Err(credential_not_found()));
                };
                // THE wall (module docs): the domain's revoke takes no member.
                let is_own = owner == caller;
                let owner_role = if !is_own && caller_role.is_admin() {
                    active_workspace_role(conn, workspace_id, owner).await?
                } else {
                    None
                };
                let via = match revoke_ladder(is_own, caller_role, owner_role) {
                    Ladder::Revoke(via) => via,
                    Ladder::Hidden => return Ok(Err(credential_not_found())),
                    Ladder::Forbidden => {
                        return Ok(Err(ApiError::forbidden(
                            "not permitted to revoke this member's developer credential",
                        )))
                    }
                };
                let revoked =
                    revoke_dev_credential_in_tx(conn, workspace_id, credential_id).await?;
                let kind = credential_kind(form);
                if revoked > 0 {
                    audit_revoked(
                        conn,
                        workspace_id,
                        caller,
                        owner,
                        credential_id,
                        kind,
                        via,
                        via_token,
                    )
                    .await?;
                }
                Ok(Ok(RevokeDevCredentialResponse {
                    id: credential_id.to_string(),
                    kind,
                    revoked_now: revoked > 0,
                }))
            })
        })
        .await;
    settle_db("dev_access.revoke", outcome).map(Json)
}

// ---------------------------------------------------------------------------
// handlers — a developer token (L1, L2)
// ---------------------------------------------------------------------------

/// `GET /v1/workspaces/{ws}/dev-access/self` (L1). The door resolved the token in this
/// request, so the answer needs no second read.
pub async fn whoami(
    Extension(principal): Extension<Principal>,
    identity: Option<Extension<DevIdentity>>,
    Path(workspace): Path<String>,
) -> Result<Response, ApiError> {
    let Some(Extension(identity)) = identity else {
        return Err(developer_token_required());
    };
    workspace_scope(&workspace, &principal)?;
    Ok(no_store(Json(self_response(&identity)).into_response()))
}

/// `DELETE /v1/workspaces/{ws}/dev-access/self` (L2, `oort logout`): the calling card, or
/// the calling access token's whole lineage — nothing else of the member (R21 c). There is
/// no id to name another credential with.
pub async fn revoke_self(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    identity: Option<Extension<DevIdentity>>,
    Path(workspace): Path<String>,
) -> Result<Json<RevokeDevCredentialResponse>, ApiError> {
    let Some(Extension(identity)) = identity else {
        return Err(developer_token_required());
    };
    let workspace_id = workspace_scope(&workspace, &principal)?;

    let outcome: DbRejectable<RevokeDevCredentialResponse> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let revoked = revoke_dev_self_in_tx(conn, &identity).await?;
                let id = self_credential_id(&identity);
                let kind = credential_kind(identity.form);
                if revoked > 0 {
                    audit_revoked(
                        conn,
                        workspace_id,
                        identity.member_id,
                        identity.member_id,
                        id,
                        kind,
                        RevokeVia::SelfToken,
                        Some(identity.token_id),
                    )
                    .await?;
                }
                Ok(Ok(RevokeDevCredentialResponse {
                    id: id.to_string(),
                    kind,
                    revoked_now: revoked > 0,
                }))
            })
        })
        .await;
    settle_db("dev_access.revoke_self", outcome).map(Json)
}

#[cfg(test)]
mod tests {
    //! The parts of this surface that need no database: the body's 400s, the projections
    //! (where a secret may and may not appear), the failure budget, the ladder, and the two
    //! walls. The transaction (lock, liveness, policy, channels, password, audit, `token`
    //! rows) is exercised against PostgreSQL by the conformance suite.

    use std::collections::BTreeSet;

    use super::*;
    use axum::body::Body;
    use axum::extract::FromRequest;
    use momo_auth::{
        PrincipalKind, DEV_READ_ONLY_SCOPES, SCOPE_DEV_IDENTITY, SCOPE_DEV_MESSAGES_WRITE,
    };
    use serde_json::Value;

    const WORKSPACE: Uuid = Uuid::from_u128(0x0190_f2a4_6b1d_7c3e_8f00_0000_0000_a1a1);
    const OTHER_WORKSPACE: Uuid = Uuid::from_u128(0x0190_f2a4_6b1d_7c3e_8f00_0000_0000_b2b2);
    const MEMBER: Uuid = Uuid::from_u128(0xd0);
    const OTHER_MEMBER: Uuid = Uuid::from_u128(0xd1);
    const SESSION_TOKEN: Uuid = Uuid::from_u128(0x5e);
    const DEV_TOKEN: Uuid = Uuid::from_u128(0xde);
    /// 43 characters, like a real secret, and unmistakable in any output.
    const SECRET_MARKER: &str = "SECRETmarkerSECRETmarkerSECRETmarker0123456";
    const PASSWORD_MARKER: &str = "pw-marker-달무리-스튜디오";

    fn body_with(extra: Value) -> Value {
        let mut body = json!({
            "name": "달무리 노트북",
            "tool": "cli",
            "currentPassword": PASSWORD_MARKER,
        });
        if let (Some(base), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                base.insert(key.clone(), value.clone());
            }
        }
        body
    }

    fn without(key: &str) -> Value {
        let mut body = body_with(json!({}));
        body.as_object_mut().expect("an object").remove(key);
        body
    }

    fn parsed(body: Value) -> Result<CreateDevCredentialRequest, serde_json::Error> {
        serde_json::from_value(body)
    }

    fn validated(body: Value) -> Result<ValidatedIssue, ApiError> {
        validated_issue(parsed(body).expect("well-formed JSON of the right shape"))
    }

    fn assert_400(result: Result<ValidatedIssue, ApiError>, case: &str) {
        let error = result.expect_err(case);
        assert_eq!(error.status, StatusCode::BAD_REQUEST, "{case}");
    }

    fn window() -> Duration {
        Duration::from_secs(60)
    }

    fn issued_card(channel_ids: Option<Vec<Uuid>>) -> IssuedDevCard {
        IssuedDevCard {
            id: Uuid::from_u128(0xca),
            secret: format!("momo_dev_v1.{WORKSPACE}.{SECRET_MARKER}"),
            label: "달무리 노트북".to_string(),
            tool: DevTool::ClaudeCode,
            scopes: vec![SCOPE_DEV_IDENTITY.to_string()],
            channel_ids,
            created_at_ms: 1_000,
            expires_at_ms: 2_000,
        }
    }

    fn identity(
        form: DevForm,
        session_id: Option<Uuid>,
        channels: Option<Vec<Uuid>>,
    ) -> DevIdentity {
        DevIdentity {
            token_id: DEV_TOKEN,
            member_id: MEMBER,
            workspace_id: WORKSPACE,
            form,
            scopes: vec![SCOPE_DEV_IDENTITY.to_string()],
            channel_ids: channels,
            role: "admin".to_string(),
            session_id,
            label: "달무리 노트북".to_string(),
            tool: Some("cli".to_string()),
            client: None,
            device_name: None,
            created_at_ms: 1_000,
            expires_at_ms: 2_000,
            last_used_at_ms: None,
            lineage_expires_at_ms: None,
        }
    }

    fn person() -> Principal {
        Principal {
            member_id: MEMBER,
            workspace_id: WORKSPACE,
            token_id: Some(SESSION_TOKEN),
            scopes: Vec::new(),
            kind: PrincipalKind::Human,
        }
    }

    /// What the developer door puts beside the person `Principal` it builds.
    fn developer_marker() -> Option<Extension<DevCredential>> {
        Some(Extension(DevCredential {
            token_id: DEV_TOKEN,
            form: DevForm::Card,
            scopes: vec![SCOPE_DEV_IDENTITY.to_string()],
            channel_ids: None,
        }))
    }

    /// A state whose pool never dials: a handler that reached the database would fail with a
    /// 500, so a 403 here proves the refusal came first.
    fn lazy_state() -> AppState {
        let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .expect("a lazy pool never dials");
        AppState::new(
            pool,
            "test-secret".to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        )
    }

    fn refusal<T>(result: Result<T, ApiError>) -> ApiError {
        match result {
            Ok(_) => panic!("the handler answered instead of refusing"),
            Err(error) => error,
        }
    }

    // -- the body ----------------------------------------------------------------------

    #[test]
    fn an_omitted_scope_list_is_the_read_only_preset_for_thirty_days() {
        let issue = validated(body_with(json!({ "name": "  달무리 노트북  " }))).expect("valid");
        assert_eq!(issue.card.label, "달무리 노트북");
        assert_eq!(issue.card.tool, DevTool::Cli);
        let read_only: Vec<String> = DEV_READ_ONLY_SCOPES.iter().map(|s| s.to_string()).collect();
        assert_eq!(issue.card.scopes, read_only);
        assert_eq!(issue.card.expires_in_days, 30);
        assert_eq!(issue.card.channel_ids, None);
        assert_eq!(issue.current_password, PASSWORD_MARKER);
    }

    #[test]
    fn the_name_is_one_to_eighty_characters_without_control_characters() {
        for name in ["", "   ", "bell\u{7}", "line\nbreak"] {
            assert_400(validated(body_with(json!({ "name": name }))), name);
        }
        assert_400(
            validated(body_with(json!({ "name": "가".repeat(81) }))),
            "81 characters",
        );
        assert!(validated(body_with(json!({ "name": "가".repeat(80) }))).is_ok());
        // A pasted secret must not become a listable copy of itself.
        assert_400(
            validated(body_with(
                json!({ "name": format!("momo_dev_v1.{WORKSPACE}.x") }),
            )),
            "an envelope as a name",
        );
    }

    #[test]
    fn the_tool_is_one_of_four_exact_values() {
        for (wire, tool) in [
            ("claude_code", DevTool::ClaudeCode),
            ("codex", DevTool::Codex),
            ("cli", DevTool::Cli),
            ("other", DevTool::Other),
        ] {
            let issue = validated(body_with(json!({ "tool": wire }))).expect(wire);
            assert_eq!(issue.card.tool, tool);
        }
        for wire in ["Claude Code", "CLI", "claude-code", ""] {
            assert_400(validated(body_with(json!({ "tool": wire }))), wire);
        }
    }

    #[test]
    fn scopes_are_refused_when_empty_null_reserved_or_unknown() {
        assert_400(validated(body_with(json!({ "scopes": [] }))), "[]");
        assert_400(validated(body_with(json!({ "scopes": null }))), "null");
        assert_400(
            validated(body_with(json!({ "scopes": ["dev:search"] }))),
            "the reserved search scope",
        );
        assert_400(
            validated(body_with(json!({ "scopes": ["messages:read"] }))),
            "a scope outside the dev: namespace",
        );
        assert_400(
            validated(body_with(
                json!({ "scopes": ["dev:messages:read", "dev:nope"] }),
            )),
            "one unknown among known",
        );
        let write = validated(body_with(json!({ "scopes": ["dev:messages:write"] })))
            .expect("write on its own");
        assert_eq!(
            write.card.scopes,
            vec![
                SCOPE_DEV_IDENTITY.to_string(),
                SCOPE_DEV_MESSAGES_WRITE.to_string()
            ],
            "dev:identity is always added"
        );
    }

    #[test]
    fn expires_in_days_is_a_whole_number_from_one_to_ninety_and_never_null() {
        let omitted = validated(without("expiresInDays")).expect("omitted");
        assert_eq!(omitted.card.expires_in_days, 30);
        for days in [1, 45, 90] {
            let issue = validated(body_with(json!({ "expiresInDays": days }))).expect("in range");
            assert_eq!(issue.card.expires_in_days, days);
        }
        for days in [json!(0), json!(91), json!(-1), json!(i64::MIN), Value::Null] {
            assert_400(
                validated(body_with(json!({ "expiresInDays": days.clone() }))),
                &days.to_string(),
            );
        }
        // Not a whole number of days: the extractor refuses these (a 400, see below).
        for days in [json!("30"), json!(30.5), json!(true), json!(u64::MAX)] {
            assert!(
                parsed(body_with(json!({ "expiresInDays": days.clone() }))).is_err(),
                "{days}"
            );
        }
    }

    #[test]
    fn channel_ids_are_one_to_fifty_channels_and_never_null() {
        let ids = |count: u128| -> Vec<String> {
            (1..=count)
                .map(|n| Uuid::from_u128(n).to_string())
                .collect()
        };
        assert_400(validated(body_with(json!({ "channelIds": [] }))), "[]");
        assert_400(validated(body_with(json!({ "channelIds": null }))), "null");
        assert_400(
            validated(body_with(json!({ "channelIds": ids(51) }))),
            "51 channels",
        );
        let fifty = validated(body_with(json!({ "channelIds": ids(50) }))).expect("50 channels");
        assert_eq!(fifty.card.channel_ids.map(|ids| ids.len()), Some(50));
        let one = Uuid::from_u128(7);
        let twice = validated(body_with(json!({ "channelIds": [one, one] }))).expect("a repeat");
        assert_eq!(twice.card.channel_ids, Some(vec![one]));
        assert!(parsed(body_with(json!({ "channelIds": ["not-a-uuid"] }))).is_err());
    }

    #[test]
    fn the_current_password_is_required_and_bounded_and_the_body_is_closed() {
        assert_400(
            validated(body_with(json!({ "currentPassword": "" }))),
            "an empty password",
        );
        assert_400(
            validated(body_with(json!({ "currentPassword": "x".repeat(1025) }))),
            "over 1024 characters",
        );
        assert!(parsed(without("currentPassword")).is_err());
        assert!(parsed(without("name")).is_err());
        assert!(parsed(without("tool")).is_err());
        assert!(parsed(body_with(json!({ "memberId": OTHER_MEMBER }))).is_err());
        assert!(parsed(body_with(json!({ "token": "x" }))).is_err());
    }

    #[tokio::test]
    async fn a_body_the_extractor_refuses_is_a_400_that_quotes_nothing_from_it() {
        for body in [
            // The password typed into the wrong field.
            body_with(json!({ "expiresInDays": PASSWORD_MARKER })),
            body_with(json!({ "currentPassword": 9_876_543_210_u64 })),
            body_with(json!({ "unexpected": PASSWORD_MARKER })),
        ] {
            let request = axum::http::Request::builder()
                .method("POST")
                .uri("/")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .expect("a request");
            let rejection = Json::<CreateDevCredentialRequest>::from_request(request, &())
                .await
                .expect_err("the extractor refuses it");
            let error = issue_body_error(rejection);
            assert_eq!(error.status, StatusCode::BAD_REQUEST, "{body}");
            assert!(!error.message.contains(PASSWORD_MARKER));
            assert!(!error.message.contains("9876543210"));
        }
    }

    #[test]
    fn debug_output_never_prints_the_password_or_the_token() {
        let request = parsed(body_with(json!({}))).expect("a body");
        assert!(!format!("{request:?}").contains(PASSWORD_MARKER));
        let issue = validated(body_with(json!({}))).expect("valid");
        assert!(!format!("{issue:?}").contains(PASSWORD_MARKER));
        let response = issued_response(issued_card(None));
        assert!(!format!("{response:?}").contains(SECRET_MARKER));
    }

    // -- projections ---------------------------------------------------------------------

    #[test]
    fn the_secret_is_in_the_create_answer_and_in_no_other_projection() {
        let channel = Uuid::from_u128(7);
        let created = serde_json::to_value(issued_response(issued_card(Some(vec![channel]))))
            .expect("serializes");
        assert_eq!(
            created["token"],
            json!(format!("momo_dev_v1.{WORKSPACE}.{SECRET_MARKER}"))
        );
        assert_eq!(created["kind"], "card");
        assert_eq!(created["tool"], "claude_code");
        assert_eq!(created["channelIds"], json!([channel.to_string()]));
        assert_eq!(created["createdAtMs"], 1_000);
        assert_eq!(created["expiresAtMs"], 2_000);
        let unrestricted =
            serde_json::to_value(issued_response(issued_card(None))).expect("serializes");
        assert!(
            unrestricted.get("channelIds").is_none(),
            "omitted, not null"
        );

        let record = DevCredentialRecord {
            id: Uuid::from_u128(0xca),
            member_id: MEMBER,
            kind: DEV_CREDENTIAL_KIND_CARD,
            label: "달무리 노트북".to_string(),
            tool: Some("cli".to_string()),
            scopes: vec![SCOPE_DEV_IDENTITY.to_string()],
            channel_restricted: true,
            device_name: None,
            created_at_ms: 1_000,
            last_used_at_ms: Some(1_500),
            expires_at_ms: 2_000,
            lineage_expires_at_ms: None,
        };
        let listed = serde_json::to_value(credential_dto(&record)).expect("serializes");
        let keys: BTreeSet<&str> = listed
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        let expected: BTreeSet<&str> = [
            "channelRestricted",
            "createdAtMs",
            "expiresAtMs",
            "id",
            "kind",
            "lastUsedAtMs",
            "memberId",
            "name",
            "scopes",
            "tool",
        ]
        .into_iter()
        .collect();
        assert_eq!(keys, expected, "no token, no hash, no channel ids");
        assert_eq!(listed["channelRestricted"], true);
    }

    #[test]
    fn whoami_names_the_card_or_the_lineage_and_not_its_channels() {
        let card = identity(DevForm::Card, None, Some(vec![Uuid::from_u128(7)]));
        let body = serde_json::to_value(self_response(&card)).expect("serializes");
        assert_eq!(body["id"], DEV_TOKEN.to_string());
        assert_eq!(body["kind"], "card");
        assert_eq!(body["memberId"], MEMBER.to_string());
        assert_eq!(body["workspaceId"], WORKSPACE.to_string());
        assert_eq!(body["channelRestricted"], true);
        assert_eq!(body["createdAtMs"], 1_000);
        assert!(body.get("channelIds").is_none());
        assert!(body.get("lastUsedAtMs").is_none(), "a first use has none");

        let lineage = Uuid::from_u128(0x1e);
        let mut access = identity(DevForm::Access, Some(lineage), None);
        access.lineage_expires_at_ms = Some(100 * MILLIS_PER_DAY);
        let body = serde_json::to_value(self_response(&access)).expect("serializes");
        assert_eq!(
            body["id"],
            lineage.to_string(),
            "the list's id for a lineage"
        );
        assert_eq!(body["kind"], "session");
        assert_eq!(
            body["createdAtMs"],
            10 * MILLIS_PER_DAY,
            "dated from approval"
        );
        assert_eq!(body["channelRestricted"], false);
    }

    #[test]
    fn the_shipped_switch_lets_owners_and_admins_create() {
        for (role, can_create, can_manage_all) in [
            (WorkspaceRole::Owner, true, true),
            (WorkspaceRole::Admin, true, true),
            (WorkspaceRole::Member, false, false),
            (WorkspaceRole::Guest, false, false),
        ] {
            let view = serde_json::to_value(policy_view(POLICY, role)).expect("serializes");
            assert_eq!(
                view,
                json!({
                    "policy": "admins",
                    "canCreate": can_create,
                    "canManageAll": can_manage_all,
                }),
                "{role:?}"
            );
        }
    }

    #[test]
    fn only_scope_all_widens_the_list() {
        assert!(!list_scope_is_all(None).expect("absent"));
        assert!(list_scope_is_all(Some("all")).expect("all"));
        for raw in ["ALL", "mine", "", "all "] {
            let error = list_scope_is_all(Some(raw)).expect_err(raw);
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
        }
    }

    #[test]
    fn every_issue_refusal_has_a_closed_reason_and_its_code() {
        for (denial, reason, code) in [
            (IssueDenial::Policy, "policy_denied", "dev_access_denied"),
            (IssueDenial::NotHuman, "not_human", "dev_access_denied"),
            (
                IssueDenial::PasswordMismatch,
                "password_mismatch",
                "current_password_incorrect",
            ),
            (
                IssueDenial::PasswordUnavailable,
                "password_unavailable",
                "current_password_unavailable",
            ),
        ] {
            assert_eq!(denial.reason(), reason);
            let error = denial.error();
            assert_eq!(error.status, StatusCode::FORBIDDEN);
            assert_eq!(error.code, Some(code));
        }
    }

    // -- the failure budget ---------------------------------------------------------------

    #[test]
    fn five_wrong_passwords_fill_the_window_and_then_even_a_right_one_is_not_compared() {
        let limiter = SlidingWindowRateLimiter::new();
        let key = password_recheck_key(WORKSPACE, MEMBER);
        let start = Instant::now();
        for attempt in 0..PASSWORD_RECHECK_FAILURES_PER_WINDOW {
            assert!(
                password_recheck_exhausted(&limiter, &key, window()).is_none(),
                "attempt {attempt} still has room"
            );
            // Kept, as a mismatch keeps it.
            reserve_password_recheck(&limiter, &key, window(), start).expect("a slot");
        }
        // The sixth is turned away before any comparison, right password or not.
        let refused = reserve_password_recheck(&limiter, &key, window(), start)
            .expect_err("the window is full");
        assert!(refused.retry_after_seconds >= 1);
        assert!(password_recheck_exhausted(&limiter, &key, window()).is_some());
        let error = too_many_password_failures(refused.retry_after_seconds);
        assert_eq!(error.status, StatusCode::TOO_MANY_REQUESTS);
        assert!(error
            .retry_after_seconds
            .is_some_and(|seconds| seconds >= 1));
    }

    #[test]
    fn a_comparison_that_did_not_fail_gives_its_slot_back() {
        let limiter = SlidingWindowRateLimiter::new();
        let key = password_recheck_key(WORKSPACE, MEMBER);
        let start = Instant::now();
        for _ in 0..PASSWORD_RECHECK_FAILURES_PER_WINDOW * 3 {
            let slot = reserve_password_recheck(&limiter, &key, window(), start)
                .expect("right passwords never fill the window");
            refund_password_recheck(&limiter, &key, slot);
        }
        assert!(password_recheck_exhausted(&limiter, &key, window()).is_none());
        // Four failures and a success leave room for exactly one more failure.
        for _ in 0..4 {
            reserve_password_recheck(&limiter, &key, window(), start).expect("a failure");
        }
        let right = reserve_password_recheck(&limiter, &key, window(), start).expect("a slot");
        refund_password_recheck(&limiter, &key, right);
        reserve_password_recheck(&limiter, &key, window(), start).expect("the fifth failure");
        assert!(reserve_password_recheck(&limiter, &key, window(), start).is_err());
    }

    #[test]
    fn the_budget_is_one_members_in_one_workspace_and_not_the_join_doors() {
        let limiter = SlidingWindowRateLimiter::new();
        let start = Instant::now();
        let full = password_recheck_key(WORKSPACE, MEMBER);
        for _ in 0..PASSWORD_RECHECK_FAILURES_PER_WINDOW {
            reserve_password_recheck(&limiter, &full, window(), start).expect("a slot");
        }
        assert!(reserve_password_recheck(&limiter, &full, window(), start).is_err());
        let other_member = password_recheck_key(WORKSPACE, OTHER_MEMBER);
        assert!(reserve_password_recheck(&limiter, &other_member, window(), start).is_ok());
        let other_workspace = password_recheck_key(OTHER_WORKSPACE, MEMBER);
        assert!(reserve_password_recheck(&limiter, &other_workspace, window(), start).is_ok());
        let join_key = crate::rate_limit::password_guess_key(WORKSPACE, "stored-address");
        assert_ne!(full.split(':').next(), join_key.split(':').next());
        // A hand-built config with a zero window still has a window.
        let config = RateLimitConfig {
            window_seconds: 0,
            ..RateLimitConfig::default()
        };
        assert_eq!(password_recheck_window(&config), Duration::from_secs(1));
    }

    // -- the ladder ----------------------------------------------------------------------

    #[test]
    fn the_revoke_ladder_is_the_owner_then_role_rank() {
        use WorkspaceRole::{Admin, Guest, Member, Owner};
        for role in [Owner, Admin, Member, Guest] {
            assert_eq!(
                revoke_ladder(true, role, None),
                Ladder::Revoke(RevokeVia::Owner)
            );
        }
        for target in [Some(Owner), Some(Admin), Some(Member), Some(Guest), None] {
            assert_eq!(revoke_ladder(false, Member, target), Ladder::Hidden);
            assert_eq!(revoke_ladder(false, Guest, target), Ladder::Hidden);
            // ADR-0215 F5: an owner may revoke anyone else's, another owner's included.
            assert_eq!(
                revoke_ladder(false, Owner, target),
                Ladder::Revoke(RevokeVia::Admin)
            );
        }
        assert_eq!(
            revoke_ladder(false, Admin, Some(Member)),
            Ladder::Revoke(RevokeVia::Admin)
        );
        assert_eq!(
            revoke_ladder(false, Admin, Some(Guest)),
            Ladder::Revoke(RevokeVia::Admin)
        );
        assert_eq!(revoke_ladder(false, Admin, Some(Admin)), Ladder::Forbidden);
        assert_eq!(revoke_ladder(false, Admin, Some(Owner)), Ladder::Forbidden);
        assert_eq!(revoke_ladder(false, Admin, None), Ladder::Forbidden);
        assert_eq!(
            [RevokeVia::Owner, RevokeVia::Admin, RevokeVia::SelfToken].map(RevokeVia::as_str),
            ["owner", "admin", "self"]
        );
    }

    // -- the walls -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_developer_token_is_refused_by_every_management_handler_before_the_database() {
        let ws = WORKSPACE.to_string();
        let body = parsed(body_with(json!({}))).expect("a body");
        let errors = [
            refusal(
                policy(
                    State(lazy_state()),
                    Extension(person()),
                    developer_marker(),
                    Path(ws.clone()),
                )
                .await,
            ),
            refusal(
                list(
                    State(lazy_state()),
                    Extension(person()),
                    developer_marker(),
                    Path(ws.clone()),
                    Ok(Query(DevCredentialListQuery::default())),
                )
                .await,
            ),
            refusal(
                issue(
                    State(lazy_state()),
                    Extension(person()),
                    developer_marker(),
                    Path(ws.clone()),
                    Ok(Json(body)),
                )
                .await,
            ),
            refusal(
                revoke(
                    State(lazy_state()),
                    Extension(person()),
                    developer_marker(),
                    Path((ws.clone(), Uuid::from_u128(0xca).to_string())),
                )
                .await,
            ),
        ];
        for error in errors {
            assert_eq!(error.status, StatusCode::FORBIDDEN);
            assert_eq!(error.code, Some("dev_route_not_allowed"));
        }
    }

    #[tokio::test]
    async fn a_person_session_on_the_self_routes_is_told_to_bring_a_developer_token() {
        let ws = WORKSPACE.to_string();
        let errors = [
            refusal(whoami(Extension(person()), None, Path(ws.clone())).await),
            refusal(
                revoke_self(
                    State(lazy_state()),
                    Extension(person()),
                    None,
                    Path(ws.clone()),
                )
                .await,
            ),
        ];
        for error in errors {
            assert_eq!(error.status, StatusCode::FORBIDDEN);
            assert_eq!(error.code, Some("dev_credential_required"));
        }
    }

    #[tokio::test]
    async fn whoami_answers_no_store_inside_its_own_workspace_only() {
        let card = identity(DevForm::Card, None, None);
        let answered = whoami(
            Extension(person()),
            Some(Extension(card.clone())),
            Path(WORKSPACE.to_string()),
        )
        .await
        .expect("whoami answers");
        assert_eq!(answered.status(), StatusCode::OK);
        assert_eq!(
            answered
                .headers()
                .get(axum::http::header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("no-store")
        );
        let elsewhere = refusal(
            whoami(
                Extension(person()),
                Some(Extension(card)),
                Path(OTHER_WORKSPACE.to_string()),
            )
            .await,
        );
        assert_eq!(elsewhere.status, StatusCode::FORBIDDEN);
    }
}
