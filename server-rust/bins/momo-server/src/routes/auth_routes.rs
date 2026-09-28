//! The public auth routes: `login`, `refresh`, `logout`.
//!
//! All three are mounted **outside** the auth middleware, exactly like Swift's
//! `AuthRoutes.add(to:)` (`AuthRoutes.swift:36-44`): refresh and logout verify
//! the presented JWT themselves, and logout deliberately skips the revocation
//! check so revoking an already-revoked token stays a 200 (idempotency), not a
//! 401.
//!
//! ## `POST /v1/auth/login`
//!
//! Parity with Swift `AuthRoutes.login` (`AuthRoutes.swift:51-132`):
//!   * same path, same request/response bodies (`dto::LoginRequest`/`LoginResponse`);
//!   * the workspace defaults to the seeded demo workspace when the request omits
//!     it (single-tenant v0 convenience);
//!   * the password is verified **in Postgres** by `momo_password_verify`
//!     (pgcrypto/bcrypt, `005_auth_password_hash.sql`) — the same hashes work
//!     against either server;
//!   * suspended → 403, everything else that fails → 401 `invalid credentials`
//!     (one bucket, so the response cannot enumerate accounts);
//!   * on success an access (15m) + refresh (30d) HS256 pair is minted with the
//!     shared `momo-auth` claims and coarse v0 scopes;
//!   * **both halves are recorded in the `token` table** (`kind='session'`,
//!     `label='access'|'refresh'`, only `sha256(jwt)` stored) — Swift
//!     `recordSessionTokens` (`AuthRoutes.swift:412-426`). This is what makes the
//!     middleware's MOMO-300 revocation check meaningful: minting without a row
//!     would turn every subsequent request into a 401 `unknown token`.
//!
//! ## `POST /v1/auth/refresh` (B1.6)
//!
//! Parity with Swift `AuthRoutes.refresh` (`AuthRoutes.swift:140-227`), in the
//! same order, because the order *is* the contract:
//!   1. verify signature/exp → 401 `invalid or expired refresh token` (:146-149);
//!   2. `typ == "refresh"` → 401 `not a refresh token` (:150-152);
//!   3. `sub`/`ws` parse → 401 `malformed token claims` (:153-157);
//!   4. `requireActive` advisory pre-check → the precise 401 (:162);
//!   5. the member is still active in the workspace → else 403 (:164-167);
//!   6. **`revoke` is the atomic single-use gate** (:177-181): the loser of a
//!      concurrent replay gets 401 `refresh token already used or revoked`;
//!   7. mint + record a new pair, answer `{accessToken, refreshToken}`.
//!      Linked-device refresh locks the stable `device_link_token` row first,
//!      re-reads the current pair, then consumes / records / rebinds in that
//!      same tenant transaction so a racing DELETE cannot leave a live pair.
//!
//! ## `POST /v1/auth/logout` (B1.6)
//!
//! Parity with Swift `AuthRoutes.logout` (`AuthRoutes.swift:236-306`):
//!   * the access token comes from `Authorization: Bearer`, and is verified for
//!     signature/`typ` but **not** for revocation state — logging out twice is
//!     200 with `alreadyRevoked=true` (:229-235);
//!   * an optional body `{refreshToken}` is validated *before* anything is
//!     revoked (same member, same workspace, `typ=refresh`), else 403
//!     `refresh token does not match this session` — a mismatched body must not
//!     leave the session half-revoked (:261-276);
//!   * the response reports exactly which halves this call killed;
//!   * when the refresh half dies, the session's push registrations die with it
//!     in the same transaction (#2677, ADR-0120 D4). The session is a lineage
//!     (`token.session_id`), not a pair: a phone registers with the access token
//!     it has at launch and signs out with whatever pair it holds after any
//!     number of rotations. The response body is unchanged. Its device signing
//!     keys end in the same commit (#3022, ADR-0146 개정 D-7).
//!
//! ## Refresh-token reuse ends the lineage (#3022, ADR-0188 §4 R1)
//!
//! A refresh token is single-use. Presenting one that is already spent — a
//! replay of a rotated token (`TokenState::Revoked`) or the loser of a
//! concurrent rotation (`AlreadyUsed`) — means two parties hold the lineage,
//! and the server cannot tell which one is the thief. So neither keeps it:
//! every live token of that `token.session_id` is revoked, and the lineage's
//! push registrations and device keys end with it, in the transaction that
//! answers the 401 (it commits). The next rotation by whoever won is refused.
//!
//! **Which lineages.** A QR-linked (phone) lineage always; a password
//! sign-in's only with `MOMO_REFRESH_REUSE_SWEEP_ALL_SESSIONS=true` (default
//! off): browser tabs rotate without cross-tab coordination, so a tab opened
//! later spends the token an older tab still holds, and that is
//! indistinguishable from theft (review H2). See `end_reused_lineage`.
//!
//! **Grace.** A token spent less than 30 seconds ago is never swept
//! (`REFRESH_REUSE_GRACE_SECONDS`): web tabs share one refresh token, and a
//! client whose rotation response was lost (tab closed mid-request, F5, sleep,
//! a slow network past the 15 s deadline) still holds only the spent token.
//! Inside the window, while the pair that rotation minted is still unused, the
//! presentation is answered with **that same pair** again (#3074,
//! `reissue_lost_rotation`, ADR-0146 D-7 증보): a refusal would not save the
//! lineage from the client's point of view — its 401 signs every tab out.
//! Otherwise (the successor was rotated, logged out or swept) it is refused
//! and nothing else happens. "Unused" means **not yet rotated**: calling the
//! API with the successor's access token does not count. The accepted cost
//! (ADR-0146 D-7 증보, #3074 review M1): anyone holding the spent token who
//! presents it inside the window receives the live pair too, where #3022 gave
//! them a 401. Two holders are caught only when their presentations of one
//! token fall more than 30 s apart; a co-holder that rotates in lockstep with
//! the client (both hold the same access `exp`) is never detected. The server
//! stores no copy of the pair; it re-signs it
//! (`momo_auth::sign_rotation_successor`).
//!
//! **Sender constraint (#3079, ADR-0146 D-7 증보 2026-09-29).** A native
//! client binds its lineage to a Secure Enclave refresh key (the first
//! `deviceProof` on a live token binds it, `momo_auth::refresh_proof`) and
//! signs every refresh with `momo.human.refresh_proof.v1`. The proof is
//! judged once at the top of the transaction; every answer to a spent token
//! then goes through [`answer_spent`]: a verified proof recovers the lineage
//! however long ago the token was spent ([`recover_lineage`]); under
//! `MOMO_REFRESH_PROOF_MODE=require` a key-bound lineage's spent token without
//! its key ends the lineage at once, and a live one is refused unspent. A
//! lineage with no key (browsers) is unchanged in every mode.
//!
//! Every rotation also consumes **and** records its new pair in one
//! transaction now (the linked-device path always did): a rotation is
//! all-or-nothing, and a sweep can never commit between a winner's consume and
//! its mint.
//!
//! Deviations (deliberate, see PR body):
//!   * no platform-admin scope elevation and no privileged-session sweep on
//!     login. Absent elevation the issued scopes are strictly the narrower set,
//!     so the deviation fails closed.
//!   * refresh consequently treats a privileged-scoped refresh token as **no
//!     longer eligible** (this server cannot mint one and has no operator
//!     allowlist to re-check against): it takes Swift's `remainsPrivileged =
//!     false` branch — strip the privileged scopes and bulk-revoke the member's
//!     sibling privileged sessions (:202-211) — instead of re-validating the
//!     operator. The narrower branch, again fail-closed.
//!   * logout does not write the `auth.logout` `audit_log` row Swift adds
//!     (:428-452): `momo_db::audit::write_audit` is still a B0 stub and
//!     `momo-db` beyond the migration runner is outside this batch's surface.
//!     Observability gap only — the revocation itself is complete.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use momo_auth::{
    carries_privileged_scope, find_linked_device_id_by_refresh_in_tx, judge_refresh_proof,
    lock_linked_device_in_tx, lock_member_session_tokens_by_ids, lock_session_rows_in_tx,
    new_session_id, rebind_device_link_session_in_tx, rebind_locked_device_link_session_in_tx,
    record_session_token, record_session_token_with_device, revoke_privileged_session_tokens,
    revoke_session_lineage_tokens, revoke_token, session_device_label, session_id_of, sign_access,
    sign_refresh, sign_rotation_successor, token_state, verify_app_access, verify_app_refresh,
    without_privileged_scopes, AuthError, DeviceSessionRecord, IssuedToken, PresentedRefreshProof,
    ProofInput, ProofVerdict, RefreshProofMode, TokenRejection, TokenState, SESSION_LABEL_ACCESS,
    SESSION_LABEL_REFRESH,
};
use momo_db::{with_tenant_tx, DbError, PgConnection};
use momo_messaging::{get_member, verify_password_login, PasswordLogin};
use uuid::Uuid;

use crate::auth::bearer_token;
use crate::dto::{
    LoginRequest, LoginResponse, LogoutRequest, LogoutResponse, MemberDto, RefreshRequest,
    RefreshResponse,
};
use crate::error::{db_error, ApiError};
use crate::session_end::{end_session_lineage_in_tx, LineageEnd};
use crate::AppState;

/// The workspace seeded by `server/Migrations/002_seed.sql`, used when a login
/// omits an explicit workspace (Swift `AuthRoutes.demoWorkspaceID`).
pub const DEMO_WORKSPACE_ID: Uuid = Uuid::from_u128(0x0000_0000_0000_7000_8000_0000_0000_0001);

/// Coarse v0 scopes (Swift `AuthRoutes.login`). A real implementation derives
/// these from membership/role (L4 §7.2).
///
/// `pub(crate)` since B4.3: `POST /v1/join` signs the caller in on success and
/// must issue the *same* scopes login does. A second literal list there would be
/// a second answer to "what does a fresh session get".
pub(crate) fn base_scopes() -> Vec<String> {
    vec!["messages:write".to_string(), "messages:read".to_string()]
}

/// The freshly minted pair, moved into the recording transaction. Holds raw
/// tokens only long enough to hash them inside Postgres — nothing here is logged.
struct SessionTokens {
    member_id: Uuid,
    scopes: Vec<String>,
    access_token: String,
    access_expires_at: i64,
    refresh_token: String,
    refresh_expires_at: i64,
    /// The #2677 lineage both halves carry.
    session_id: Uuid,
}

/// Mint an access+refresh pair for `member_id` and record **both halves** in one
/// tenant transaction, returning the pair. Swift `recordSessionTokens`
/// (`AuthRoutes.swift:412-426`), shared by login and refresh so the two paths
/// cannot drift in what they persist.
///
/// One transaction rather than Swift's two connections: a session whose access
/// row committed but whose refresh row did not would be unrevocable by a single
/// logout, so the pair is atomic here. Recording is also what makes the
/// middleware's MOMO-300 revocation check meaningful — minting without a row
/// would turn every subsequent request into a 401 `unknown token`.
///
/// `pub(crate)` since B4.3 so `POST /v1/join` mints its session through this and
/// not a copy: a joined session must be revocable exactly like a logged-in one.
///
/// Every caller of this name starts a NEW session (login, join, claim, password
/// change), so it opens a fresh lineage (#2677). A refresh continues one and
/// goes through [`issue_and_record_session_in_lineage`] instead.
pub(crate) async fn issue_and_record_session(
    state: &AppState,
    workspace_id: Uuid,
    member_id: Uuid,
    scopes: Vec<String>,
    context: &str,
) -> Result<(IssuedToken, IssuedToken), ApiError> {
    issue_and_record_session_in_lineage(
        state,
        workspace_id,
        member_id,
        scopes,
        new_session_id(),
        context,
    )
    .await
}

/// [`issue_and_record_session`] for a pair that continues `session_id` — the
/// refresh rotation. Both halves carry the lineage, so a push token registered
/// under the first pair is still this session's after any number of rotations.
async fn issue_and_record_session_in_lineage(
    state: &AppState,
    workspace_id: Uuid,
    member_id: Uuid,
    scopes: Vec<String>,
    session_id: Uuid,
    context: &str,
) -> Result<(IssuedToken, IssuedToken), ApiError> {
    let access = sign_access(member_id, workspace_id, &scopes, &state.jwt_secret)
        .map_err(|error| ApiError::internal(&format!("{context}.sign_access"), error))?;
    let refresh = sign_refresh(member_id, workspace_id, &scopes, &state.jwt_secret)
        .map_err(|error| ApiError::internal(&format!("{context}.sign_refresh"), error))?;

    let session = SessionTokens {
        member_id,
        scopes,
        access_token: access.token.clone(),
        access_expires_at: access.expires_at,
        refresh_token: refresh.token.clone(),
        refresh_expires_at: refresh.expires_at,
        session_id,
    };
    with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            record_session_token(
                conn,
                workspace_id,
                session.member_id,
                &session.access_token,
                SESSION_LABEL_ACCESS,
                &session.scopes,
                session.access_expires_at,
                session.session_id,
            )
            .await?;
            record_session_token(
                conn,
                workspace_id,
                session.member_id,
                &session.refresh_token,
                SESSION_LABEL_REFRESH,
                &session.scopes,
                session.refresh_expires_at,
                session.session_id,
            )
            .await?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .map_err(|error| db_error(&format!("{context}.record_session"), error))?;

    Ok((access, refresh))
}

/// The refusal for a `workspace` that was supplied and is not a workspace id.
///
/// It **names the field and both accepted shapes**, because the client maps
/// this 400 back to a Korean sentence by matching on the word `workspace`
/// (`connectModel.signInFailureCopy`). Renaming it silently degrades that
/// sentence to the generic one.
const WORKSPACE_NOT_AN_ID: &str =
    "workspace must be a workspace id (uuid), or omitted to use the default workspace";

/// Which workspace a login lands in.
///
/// | `workspace` | result |
/// |---|---|
/// | absent, empty, or whitespace | [`DEMO_WORKSPACE_ID`] |
/// | a parseable uuid | that workspace |
/// | anything else | **400** |
///
/// ## Why the last row is not a fallback (goal B13 R2 High 1)
///
/// This used to be `.and_then(|raw| Uuid::parse_str(raw).ok()).unwrap_or(DEMO)`,
/// so a `workspace` the caller actually typed — a slug, a workspace *name*, a
/// typo'd id — was parsed, dropped on the floor, and the person was signed in
/// somewhere else without being told. That is the failure mode the honesty
/// principle exists for: the user asked for A and the server quietly gave them
/// B, and every screen afterwards looked like a working session in the wrong
/// tenant.
///
/// It is a real trap rather than a theoretical one, because **the workspace id
/// is never shown anywhere in the product** — every other surface identifies a
/// workspace by slug and name — so a person filling a box labelled
/// "워크스페이스" has no id to type and will reach for the name they know.
///
/// The blank path is deliberately untouched: the connect form's empty box, the
/// smoke harness and every existing client depend on it, and "I named nothing"
/// is not a mistake to report. Only a value that was *supplied and unusable*
/// fails, and it fails visibly.
fn resolve_login_workspace(raw: Option<&str>) -> Result<Uuid, ApiError> {
    let Some(named) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(DEMO_WORKSPACE_ID);
    };
    Uuid::parse_str(named).map_err(|_| ApiError::bad_request(WORKSPACE_NOT_AN_ID))
}

pub async fn login(
    State(state): State<AppState>,
    uri: axum::http::Uri,
    headers: HeaderMap,
    Json(request): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, ApiError> {
    let workspace_id = resolve_login_workspace(request.workspace.as_deref())?;

    // The tenant transaction is the sole RLS GUC seam; the lookup is therefore
    // scoped to the workspace being logged into (invariant #6).
    let email = request.email.clone();
    let password = request.password.clone();
    let resolution = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move { verify_password_login(conn, &email, &password).await })
    })
    .await
    .map_err(|error| db_error("auth.login", error))?;

    let member = match resolution {
        PasswordLogin::Suspended => return Err(ApiError::forbidden("member is suspended")),
        PasswordLogin::Invalid => return Err(ApiError::unauthorized("invalid credentials")),
        PasswordLogin::Active(member) => member,
    };

    // Record both halves so they can be revoked later (MOMO-300).
    let (access, refresh) =
        issue_and_record_session(&state, workspace_id, member.id, base_scopes(), "auth.login")
            .await?;

    Ok(Json(LoginResponse {
        access_token: access.token,
        refresh_token: refresh.token,
        member: MemberDto {
            id: member.id.to_string(),
            workspace_id: member.workspace_id.to_string(),
            kind: member.kind.as_db_label().to_string(),
            display_name: member.display_name,
            handle: member.handle,
        },
        realtime_web_socket_url: state.advertised_realtime_ws_url(&headers, uri.scheme_str())?,
    }))
}

// ---------------------------------------------------------------------------
// POST /v1/auth/refresh
// ---------------------------------------------------------------------------

/// What the refresh gate decided, resolved inside ONE tenant transaction so the
/// pre-check, the member check and the single-use revoke cannot interleave with
/// a competing rotation. Mapped to HTTP outside the transaction.
enum RefreshGate {
    /// The presented row is revoked/expired/unrecorded (Swift `requireActive`).
    Rejected(TokenRejection),
    /// The member is gone, suspended, or soft-deleted → 403, not 401.
    MemberInactive,
    /// The atomic single-use gate was lost: this token was already spent.
    AlreadyUsed,
    /// #3079: the lineage is key-bound and this presentation did not prove
    /// it (under `require`, or a key holder's stale / replayed proof).
    ProofRefused(ProofVerdict),
    /// Rotation finished in this transaction — linked or not: consume, mint,
    /// record (and rebind) either all committed or all rolled back (#3022).
    Issued {
        access: IssuedToken,
        refresh: IssuedToken,
    },
}

/// Map a verification failure on the refresh path to Swift's wording.
fn refresh_tx_error(error: DbError) -> ApiError {
    if let DbError::Sqlx(momo_db::sqlx::Error::Protocol(message)) = &error {
        if message == "linked-device binding changed" {
            return ApiError::unauthorized("refresh token already used or revoked");
        }
    }
    db_error("auth.refresh", error)
}

fn refresh_auth_error(error: AuthError) -> ApiError {
    match error {
        AuthError::InvalidToken(_) => ApiError::unauthorized("invalid or expired refresh token"),
        AuthError::NotRefreshToken => ApiError::unauthorized("not a refresh token"),
        AuthError::NotAccessToken => ApiError::unauthorized("not an access token"),
        AuthError::MalformedClaims => ApiError::unauthorized("malformed token claims"),
    }
}

pub async fn refresh(
    State(state): State<AppState>,
    Json(request): Json<RefreshRequest>,
) -> Result<Json<RefreshResponse>, ApiError> {
    let principal = verify_app_refresh(&request.refresh_token, &state.jwt_secret)
        .map_err(refresh_auth_error)?;
    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;

    // Scope decision (Swift :183-201) with this server's narrower reality: it
    // never elevates on login, so a privileged refresh token cannot be one it
    // minted. Fail closed — downgrade the pair and sweep the member's sibling
    // privileged sessions, rather than re-issue a privileged token.
    let downgrade = carries_privileged_scope(&principal.scopes);
    let scopes = if downgrade {
        without_privileged_scopes(&principal.scopes)
    } else {
        principal.scopes.clone()
    };

    let presented = request.refresh_token.clone();
    let jwt_secret = state.jwt_secret.clone();
    let linked_scopes = scopes.clone();
    let rotated_scopes = scopes.clone();
    let reissue_scopes = scopes.clone();
    let sweep_all = state.device_keys.refresh_reuse_sweep_all_sessions;
    let proof_mode = state.device_keys.refresh_proof_mode;
    let proof = request.device_proof.map(|proof| PresentedRefreshProof {
        public_key_b64: proof.public_key,
        nonce: proof.nonce,
        signed_at_ms: proof.signed_at_ms,
        signature_b64: proof.signature,
    });
    let gate = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            // (1) Advisory pre-check — precise 401s for a logged-out/rotated
            // token. The *atomic* gate is the revoke below, not this read.
            let presented_state = token_state(conn, &presented).await.map_err(DbError::from)?;

            // (1b) #3079: what the proof says about the presenter, judged
            // against the presented row's lineage. A first proof on a live
            // token binds the lineage's refresh key.
            let verdict = match presented_state {
                TokenState::Active { id } | TokenState::Revoked { id } => {
                    let lineage = session_id_of(conn, id).await.map_err(DbError::from)?;
                    judge_refresh_proof(
                        conn,
                        ProofInput {
                            mode: proof_mode,
                            workspace_id,
                            member_id,
                            session_id: lineage,
                            presented: &presented,
                            proof: proof.as_ref(),
                            may_bind: matches!(presented_state, TokenState::Active { .. }),
                        },
                    )
                    .await
                    .map_err(DbError::from)?
                }
                _ => ProofVerdict::Unbound,
            };
            if verdict != ProofVerdict::Unbound {
                tracing::info!(
                    mode = proof_mode.as_str(),
                    verdict = verdict.as_str(),
                    spent = matches!(presented_state, TokenState::Revoked { .. }),
                    "auth.refresh proof"
                );
            }

            // #3074 / #3079: every refusal of a spent token below first asks
            // whether it is a lost rotation response being retried.
            let reissue = Reissue {
                workspace_id,
                member_id,
                presented: &presented,
                scopes: &reissue_scopes,
                jwt_secret: jwt_secret.as_str(),
                verdict,
                proof_mode,
                sweep_all,
                downgrade,
            };
            let old_refresh_id = match presented_state {
                // R1 (#3022): a spent refresh token, presented again.
                TokenState::Revoked { id } => {
                    if let Some(gate) = answer_spent(conn, &reissue, id, false).await? {
                        return Ok(gate);
                    }
                    return Ok(RefreshGate::Rejected(TokenRejection::Revoked));
                }
                other => match other.require_active() {
                    Ok(id) => id,
                    Err(rejection) => return Ok(RefreshGate::Rejected(rejection)),
                },
            };

            // (1c) #3079 `require`: a key-bound lineage rotates only for its
            // key. Refused before anything is spent — a live token presented
            // without the key is not a copy *in use*, and the device still
            // holds it.
            if proof_mode == RefreshProofMode::Require && verdict.is_unproven_bound() {
                return Ok(RefreshGate::ProofRefused(verdict));
            }

            // (2) The credential is alive, but the human behind it may not be.
            // RLS scopes this lookup to the token's workspace, so "active in
            // *this* workspace" is checked by construction (Swift :454-470).
            let member = get_member(conn, member_id).await?;
            if member.is_none_or(|member| member.status != "active") {
                return Ok(RefreshGate::MemberInactive);
            }

            // The replacement pair continues this session's lineage (#2677).
            // A pre-088 session has none yet and is given one here, once: from
            // this rotation on, what the phone registers is attributable.
            let (session_id, stamp_lineage) = match session_id_of(conn, old_refresh_id)
                .await
                .map_err(DbError::from)?
            {
                Some(session_id) => (session_id, false),
                None => (new_session_id(), true),
            };

            if let Some(device_id) = find_linked_device_id_by_refresh_in_tx(
                conn,
                workspace_id,
                member_id,
                old_refresh_id,
            )
            .await
            .map_err(DbError::from)?
            {
                // Linked path: stable device row first, then the current pair
                // and its lineage's live rows in ONE id-ordered acquisition
                // (#3107): the reuse / recovery answers below lock the lineage
                // again and must find it already held. Consume / mint /
                // rebind stay in this tx.
                let Some(locked) =
                    lock_linked_device_in_tx(conn, workspace_id, member_id, device_id)
                        .await
                        .map_err(DbError::from)?
                else {
                    if let Some(gate) = answer_spent(conn, &reissue, old_refresh_id, true).await? {
                        return Ok(gate);
                    }
                    return Ok(RefreshGate::AlreadyUsed);
                };
                // A binding that moved on is a reuse only when it moved
                // because the presented token was spent (a concurrent winner
                // rotated it). A binding moved under a still-live token is a
                // refusal, not evidence of a second holder.
                if locked.refresh_id != old_refresh_id {
                    if let Some(gate) = answer_spent(conn, &reissue, old_refresh_id, true).await? {
                        return Ok(gate);
                    }
                    return Ok(RefreshGate::AlreadyUsed);
                }
                // Stamped only now, under the device-link and token locks the
                // path already holds, so the lock order stays device → token.
                if stamp_lineage {
                    stamp_spent_lineage(conn, old_refresh_id, session_id).await?;
                }

                let revoke = revoke_token(conn, &presented)
                    .await
                    .map_err(DbError::from)?;
                if !revoke.revoked_now {
                    if let Some(gate) = answer_spent(conn, &reissue, old_refresh_id, false).await? {
                        return Ok(gate);
                    }
                    return Ok(RefreshGate::AlreadyUsed);
                }
                if downgrade {
                    revoke_privileged_session_tokens(conn, workspace_id, member_id)
                        .await
                        .map_err(DbError::from)?;
                }

                // #3074: the successor is a pure function of this rotation,
                // so a retry of a lost response can sign it again.
                let rotated_at = rotated_at_unix(conn, old_refresh_id).await?;
                let (access, refresh) = sign_rotation_successor(
                    member_id,
                    workspace_id,
                    &linked_scopes,
                    jwt_secret.as_str(),
                    &presented,
                    rotated_at,
                )
                .map_err(signing_error)?;
                let device_label = locked.device_label.clone();
                let access_id = record_session_token_with_device(
                    conn,
                    workspace_id,
                    member_id,
                    DeviceSessionRecord {
                        raw_token: &access.token,
                        label: SESSION_LABEL_ACCESS,
                        scopes: &linked_scopes,
                        expires_at_unix: access.expires_at,
                        device_label: device_label.as_deref(),
                        pending_sas: false,
                        session_id,
                    },
                )
                .await
                .map_err(DbError::from)?;
                let refresh_id = record_session_token_with_device(
                    conn,
                    workspace_id,
                    member_id,
                    DeviceSessionRecord {
                        raw_token: &refresh.token,
                        label: SESSION_LABEL_REFRESH,
                        scopes: &linked_scopes,
                        expires_at_unix: refresh.expires_at,
                        device_label: device_label.as_deref(),
                        pending_sas: false,
                        session_id,
                    },
                )
                .await
                .map_err(DbError::from)?;
                let rebound = rebind_locked_device_link_session_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    locked.id,
                    locked.access_id,
                    locked.refresh_id,
                    access_id,
                    refresh_id,
                )
                .await
                .map_err(DbError::from)?;
                if !rebound {
                    // Consume + insert already happened in this tx. Returning
                    // Ok would commit a live pair on a device that just refused
                    // the rebind. Roll back so no orphan tokens survive.
                    return Err(DbError::Sqlx(momo_db::sqlx::Error::Protocol(
                        "linked-device binding changed".to_string(),
                    )));
                }
                return Ok(RefreshGate::Issued { access, refresh });
            }

            // (3) Non-linked single-use gate: exactly one concurrent replay
            // flips the row and may mint a replacement pair (Swift :169-181).
            // The loser is a reuse (#3022) and ends the lineage.
            let revoke = revoke_token(conn, &presented)
                .await
                .map_err(DbError::from)?;
            if !revoke.revoked_now {
                if let Some(gate) = answer_spent(conn, &reissue, old_refresh_id, false).await? {
                    return Ok(gate);
                }
                return Ok(RefreshGate::AlreadyUsed);
            }
            let Some(old_refresh_id) = revoke.id else {
                return Ok(RefreshGate::AlreadyUsed);
            };
            if stamp_lineage {
                stamp_spent_lineage(conn, old_refresh_id, session_id).await?;
            }
            let device_label = session_device_label(conn, old_refresh_id)
                .await
                .map_err(DbError::from)?;

            // (4) Downgrade sweep: the presented row is already revoked above;
            // kill the sibling privileged rows in the same transaction so the
            // loss of privilege takes effect now, while the messages-only pair
            // issued below keeps ordinary use alive (Swift :202-211).
            if downgrade {
                revoke_privileged_session_tokens(conn, workspace_id, member_id)
                    .await
                    .map_err(DbError::from)?;
            }

            // (5) Mint and record the replacement in THIS transaction (#3022):
            // a reuse sweep that commits after this one must find the new pair
            // and revoke it too. A rotation CONTINUES the session: same lineage,
            // never a fresh one (#2677).
            let (access, refresh) = record_rotated_pair_in_tx(
                conn,
                RotatedPair {
                    workspace_id,
                    member_id,
                    scopes: &rotated_scopes,
                    jwt_secret: jwt_secret.as_str(),
                    device_label: device_label.as_deref(),
                    old_refresh_id,
                    session_id,
                    presented: &presented,
                },
            )
            .await?;
            Ok(RefreshGate::Issued { access, refresh })
        })
    })
    .await
    .map_err(refresh_tx_error)?;

    match gate {
        RefreshGate::Rejected(rejection) => Err(ApiError::unauthorized(rejection.message())),
        RefreshGate::MemberInactive => Err(ApiError::forbidden(
            "member is not active in this workspace",
        )),
        RefreshGate::AlreadyUsed => Err(ApiError::unauthorized(
            "refresh token already used or revoked",
        )),
        RefreshGate::ProofRefused(verdict) => Err(proof_refusal(verdict)),
        RefreshGate::Issued { access, refresh } => Ok(Json(RefreshResponse {
            access_token: access.token,
            refresh_token: refresh.token,
        })),
    }
}

/// How long after a refresh row was spent presenting it again is still taken
/// for the same client's retry rather than a second holder (#3022 review H2).
///
/// Two honest clients present a spent token: a web session open in several
/// tabs (they share one refresh token in localStorage), and a client whose
/// rotation response was lost and that retries. The retry lands at most one
/// request deadline later: `REQUEST_TIMEOUT_MS = 15_000` (momo-core
/// `http.ts`). Twice that, so a retry after a timed-out attempt still falls
/// inside. Inside the window the presentation is answered with the pair the
/// rotation already issued, while that pair is unused (#3074,
/// [`reissue_lost_rotation`]); else refused (401) with nothing else ended.
/// Outside it the lineage ends. The same shape as a refresh-token "reuse
/// interval" in hosted identity providers [S], which likewise accept a reuse
/// inside the interval instead of refusing it.
const REFRESH_REUSE_GRACE_SECONDS: f64 = 30.0;

/// R1 (#3022): the refresh row `refresh_id` was presented after it was spent.
/// Unless it was spent within [`REFRESH_REUSE_GRACE_SECONDS`], end its whole
/// lineage — every live token, and with them the lineage's push registrations
/// — in the caller's transaction, which the caller then commits with its 401.
/// The lineage's device keys are **not** revoked (#3097, ADR-0146 D-7 증보):
/// a copied refresh token is not a copied Secure Enclave key. They sign
/// nothing until the owner's next sign-in moves them with a letter the key
/// itself signs (`crate::session_end`). A row with no lineage (spent before 088 and never
/// rotated since) names nothing else to revoke.
///
/// **Which lineages.** A QR-linked lineage (the row carries an ADR-0180
/// `device_label`) is a phone app: one process, rotations single-flight in
/// momo-core. That is the device ADR-0188 R1 names (「재사용이 보이면 그
/// 기기의 세션 계열을 전부 폐기」), and it is swept always. A password
/// sign-in may be a browser with several tabs, which rotate without cross-tab
/// coordination: a tab opened later rotates at boot and spends the token an
/// older tab still holds, and the older tab presents it minutes later — a
/// shape the server cannot tell from theft (#3022 review H2). Those lineages
/// are swept only when `MOMO_REFRESH_REUSE_SWEEP_ALL_SESSIONS=true`, off until
/// the web client coordinates rotation across tabs.
async fn end_reused_lineage(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    refresh_id: Uuid,
    sweep_all: bool,
) -> Result<(), DbError> {
    let row: Option<(Option<Uuid>, bool, bool)> = momo_db::sqlx::query_as(
        "SELECT session_id, \
                COALESCE(revoked_at > now() - make_interval(secs => $2), false), \
                device_label IS NOT NULL \
           FROM token WHERE id = $1",
    )
    .bind(refresh_id)
    .bind(REFRESH_REUSE_GRACE_SECONDS)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::from)?;
    let Some((Some(session_id), within_grace, linked)) = row else {
        return Ok(());
    };
    if within_grace || !(linked || sweep_all) {
        return Ok(());
    }
    revoke_session_lineage_tokens(conn, workspace_id, member_id, session_id)
        .await
        .map_err(DbError::from)?;
    end_session_lineage_in_tx(
        conn,
        workspace_id,
        member_id,
        session_id,
        LineageEnd::RefreshReuse,
    )
    .await
}

fn signing_error(error: AuthError) -> DbError {
    DbError::Sqlx(momo_db::sqlx::Error::Protocol(error.to_string()))
}

/// The second the refresh row `refresh_id` was spent, as Postgres wrote it —
/// the `iat` of the pair that replaces it (#3074). Read back inside the
/// rotating transaction, right after its own revoke, so it is the value every
/// later retry reads too (`revoked_at` is only ever written once:
/// `COALESCE(revoked_at, …)` or `WHERE revoked_at IS NULL` everywhere).
async fn rotated_at_unix(conn: &mut PgConnection, refresh_id: Uuid) -> Result<i64, DbError> {
    momo_db::sqlx::query_scalar(
        "SELECT floor(extract(epoch FROM revoked_at))::bigint FROM token \
          WHERE id = $1 AND revoked_at IS NOT NULL",
    )
    .bind(refresh_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(DbError::from)
}

/// What a lost rotation response is re-signed from, and what decides how a
/// spent presentation is answered ([`answer_spent`]).
struct Reissue<'a> {
    workspace_id: Uuid,
    member_id: Uuid,
    presented: &'a str,
    scopes: &'a [String],
    jwt_secret: &'a str,
    /// #3079: the presentation's proof, judged once at the top of the tx.
    verdict: ProofVerdict,
    proof_mode: RefreshProofMode,
    sweep_all: bool,
    /// The presented token carried a privileged scope: a recovered pair is
    /// minted without it and the sibling privileged sessions are swept.
    downgrade: bool,
}

/// #3079: the 401 a key-bound lineage's unproven presentation gets. Each is
/// coded so a client can tell "sign again" (stale, replayed) from "this was
/// not your key" — a client must not treat `refresh_proof_stale` or
/// `refresh_proof_replayed` as a sign-out.
fn proof_refusal(verdict: ProofVerdict) -> ApiError {
    let (code, message) = match verdict {
        ProofVerdict::Missing => ("refresh_proof_required", "refresh proof required"),
        ProofVerdict::Stale => (
            "refresh_proof_stale",
            "refresh proof is outside the time window; sign it again with the server time",
        ),
        ProofVerdict::Replayed => (
            "refresh_proof_replayed",
            "refresh proof nonce was already used; sign it again with a fresh nonce",
        ),
        ProofVerdict::Forged | ProofVerdict::Unbound | ProofVerdict::Verified { .. } => (
            "refresh_proof_invalid",
            "refresh proof is not this session's key",
        ),
    };
    ApiError::coded(axum::http::StatusCode::UNAUTHORIZED, code, message)
}

/// How a **spent** presentation is answered — the one decision table every
/// refusal of a spent token goes through (#3022 → #3074 → #3079):
///
/// | proof (bound lineage)          | answer                                       | lineage |
/// |--------------------------------|----------------------------------------------|---------|
/// | verified                       | the #3074 pair if still unused, else a fresh pair for the live lineage ([`recover_lineage`]) — no time limit | kept |
/// | stale / replayed (key's own)   | 401 coded, sign again                        | kept    |
/// | missing / another key, `require` | 401                                        | **ended**, even inside 30 s |
/// | missing / another key, `observe`; or unbound | #3074 reissue inside 30 s, else #3022 | as before |
///
/// `None` = the caller's own refusal. `only_if_spent`: the linked path's
/// refusals, which follow a binding that may have moved under a still-live
/// token — nothing happens unless the presented row is revoked by now.
async fn answer_spent(
    conn: &mut PgConnection,
    reissue: &Reissue<'_>,
    refresh_id: Uuid,
    only_if_spent: bool,
) -> Result<Option<RefreshGate>, DbError> {
    if only_if_spent
        && !matches!(
            token_state(conn, reissue.presented)
                .await
                .map_err(DbError::from)?,
            TokenState::Revoked { .. }
        )
    {
        return Ok(None);
    }
    match reissue.verdict {
        ProofVerdict::Verified { .. } => {
            if let Some(gate) = reissue_lost_rotation(conn, reissue).await? {
                return Ok(Some(gate));
            }
            recover_lineage(conn, reissue, refresh_id).await
        }
        ProofVerdict::Stale | ProofVerdict::Replayed => {
            Ok(Some(RefreshGate::ProofRefused(reissue.verdict)))
        }
        verdict if reissue.proof_mode == RefreshProofMode::Require && verdict.is_copy() => {
            tracing::warn!(
                verdict = verdict.as_str(),
                "auth.refresh: a key-bound lineage's spent token came back without its key; ending the lineage"
            );
            end_lineage(conn, reissue.workspace_id, reissue.member_id, refresh_id).await?;
            Ok(None)
        }
        _ => {
            if let Some(gate) = reissue_lost_rotation(conn, reissue).await? {
                return Ok(Some(gate));
            }
            end_reused_lineage(
                conn,
                reissue.workspace_id,
                reissue.member_id,
                refresh_id,
                reissue.sweep_all,
            )
            .await?;
            Ok(None)
        }
    }
}

/// The live tail of a lineage: its newest refresh row that can still rotate.
const LIVE_LINEAGE_TAIL_SQL: &str = "SELECT id, device_label \
       FROM token \
      WHERE workspace_id = $1 \
        AND actor_member_id = $2 \
        AND kind = 'session' \
        AND session_id = $3 \
        AND label = 'refresh' \
        AND revoked_at IS NULL \
        AND (expires_at IS NULL OR expires_at > now()) \
      ORDER BY id DESC \
      LIMIT 1";

/// #3079: a spent token came back with a verified proof from its lineage's
/// key — the device that holds the lineage lost a rotation response (sleep,
/// Cmd+Q, a dead network) and holds only the spent token, however long ago it
/// was spent. While the lineage can still rotate, every live token of it is
/// revoked (whatever pair the lost response carried, and anything a copy
/// minted from it) and a fresh pair continues the **same** lineage: its push
/// registrations, device keys and refresh key stay. The device link, if any,
/// is rebound to the fresh pair.
///
/// `None` (the caller refuses) when the lineage has ended — logout, unlink, a
/// sweep, expiry — or its link moved under the lock. A dead lineage stays
/// dead: a proof recovers a sign-in, it never resurrects one.
///
/// SABOTAGE(recover-no-member-check): drop the member check — the suspended
/// member test must go RED. SABOTAGE(recover-no-tail-gate): skip the tail check after
/// the lineage lock — the concurrent-recovery test must go RED.
async fn recover_lineage(
    conn: &mut PgConnection,
    reissue: &Reissue<'_>,
    refresh_id: Uuid,
) -> Result<Option<RefreshGate>, DbError> {
    let (workspace_id, member_id) = (reissue.workspace_id, reissue.member_id);
    let Some(session_id) = session_id_of(conn, refresh_id)
        .await
        .map_err(DbError::from)?
    else {
        return Ok(None);
    };
    let member = get_member(conn, member_id).await?;
    if member.is_none_or(|member| member.status != "active") {
        return Ok(Some(RefreshGate::MemberInactive));
    }
    let tail: Option<(Uuid, Option<String>)> = momo_db::sqlx::query_as(LIVE_LINEAGE_TAIL_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .bind(session_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(DbError::from)?;
    let Some((tail_id, device_label)) = tail else {
        return Ok(None);
    };
    // Linked device: the stable link row first, then the bound pair and the
    // whole lineage in one id-ordered acquisition (the session-row rule,
    // `momo_auth::lock_session_rows_in_tx`, #3107) — the order every linked
    // rotation and unlink takes.
    let locked =
        match find_linked_device_id_by_refresh_in_tx(conn, workspace_id, member_id, tail_id)
            .await
            .map_err(DbError::from)?
        {
            Some(device_id) => {
                match lock_linked_device_in_tx(conn, workspace_id, member_id, device_id)
                    .await
                    .map_err(DbError::from)?
                {
                    Some(locked) if locked.refresh_id == tail_id => Some(locked),
                    _ => return Ok(None),
                }
            }
            None => None,
        };
    // Lock the lineage's live rows in id order — the order logout, unlink and
    // every lineage sweep take (re-review M: spending the tail first locked
    // the highest id before the lower ones and could deadlock with them) —
    // then gate on the tail: the recovery's single-use check, like
    // `revoke_token` is a rotation's (review H1). The read above took no lock:
    // a logout, unlink or sweep that committed since has revoked the tail,
    // it is not among the locked rows, and the lineage stays ended. Two
    // concurrent recoveries serialize here and only one mints.
    //
    // On the linked branch every one of these rows is already held (the link
    // lock took the lineage with the pair): this re-lock waits on nothing and
    // only reads which rows are still live.
    let locked_live = lock_session_rows_in_tx(conn, workspace_id, member_id, Some(session_id), &[])
        .await
        .map_err(DbError::from)?;
    if !locked_live.iter().any(|row| row.id == tail_id && row.live) {
        return Ok(None);
    }
    revoke_session_lineage_tokens(conn, workspace_id, member_id, session_id)
        .await
        .map_err(DbError::from)?;
    if reissue.downgrade {
        revoke_privileged_session_tokens(conn, workspace_id, member_id)
            .await
            .map_err(DbError::from)?;
    }
    let access = sign_access(member_id, workspace_id, reissue.scopes, reissue.jwt_secret)
        .map_err(signing_error)?;
    let refresh = sign_refresh(member_id, workspace_id, reissue.scopes, reissue.jwt_secret)
        .map_err(signing_error)?;
    let mut ids = [Uuid::nil(); 2];
    for (slot, (token, label)) in [
        (&access, SESSION_LABEL_ACCESS),
        (&refresh, SESSION_LABEL_REFRESH),
    ]
    .into_iter()
    .enumerate()
    {
        ids[slot] = record_session_token_with_device(
            conn,
            workspace_id,
            member_id,
            DeviceSessionRecord {
                raw_token: &token.token,
                label,
                scopes: reissue.scopes,
                expires_at_unix: token.expires_at,
                device_label: device_label.as_deref(),
                pending_sas: false,
                session_id,
            },
        )
        .await
        .map_err(DbError::from)?;
    }
    if let Some(locked) = locked {
        let rebound = rebind_locked_device_link_session_in_tx(
            conn,
            workspace_id,
            member_id,
            locked.id,
            locked.access_id,
            locked.refresh_id,
            ids[0],
            ids[1],
        )
        .await
        .map_err(DbError::from)?;
        if !rebound {
            return Err(DbError::Sqlx(momo_db::sqlx::Error::Protocol(
                "linked-device binding changed".to_string(),
            )));
        }
    }
    tracing::info!(
        "auth.refresh: a verified proof recovered a lineage whose rotation response was lost"
    );
    Ok(Some(RefreshGate::Issued { access, refresh }))
}

/// #3079 `require`: a key-bound lineage whose spent token came back without
/// its key ends now — no 30 s grace (that grace exists for browser tabs and
/// lost responses, and a key-bound lineage's device proves both), and no
/// linked-only rule (#3022 H2's tab concern does not apply to a lineage that
/// holds a key). Same ending as [`end_reused_lineage`]: tokens and push
/// registrations, keys kept (#3097).
async fn end_lineage(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    refresh_id: Uuid,
) -> Result<(), DbError> {
    let Some(session_id) = session_id_of(conn, refresh_id)
        .await
        .map_err(DbError::from)?
    else {
        return Ok(());
    };
    revoke_session_lineage_tokens(conn, workspace_id, member_id, session_id)
        .await
        .map_err(DbError::from)?;
    end_session_lineage_in_tx(
        conn,
        workspace_id,
        member_id,
        session_id,
        LineageEnd::RefreshReuse,
    )
    .await
}

/// #3074 (ADR-0146 D-7 증보): answer a spent refresh token with the pair its
/// rotation already issued, when that is what the presentation must be — the
/// same client retrying after it lost the response (tab closed mid-request,
/// F5, sleep, a slow network past the request deadline), or a second tab that
/// lost the race for the single-use gate.
///
/// All three must hold, else `None` and the caller refuses as before (#3022):
///   1. the presented row was spent within [`REFRESH_REUSE_GRACE_SECONDS`];
///   2. the pair re-signed from it ([`sign_rotation_successor`]) is exactly a
///      recorded pair of this server — both `token_hash`es found — and both
///      halves are still live. A successor someone already rotated, logged
///      out or swept is never handed out again: the presenter is then not the
///      client that lost it. A token revoked by a logout has no recorded
///      successor at all;
///   3. the member is still active. Defence in depth: suspending a member
///      also ends their sessions, so (2) refuses first in practice.
///
/// Nothing is written: the pair is the one already recorded, rebound and
/// counted. The server never stores the pair itself, only `sha256(jwt)`.
async fn reissue_lost_rotation(
    conn: &mut PgConnection,
    reissue: &Reissue<'_>,
) -> Result<Option<RefreshGate>, DbError> {
    let row: Option<(Option<i64>, bool)> = momo_db::sqlx::query_as(
        "SELECT floor(extract(epoch FROM revoked_at))::bigint, \
                COALESCE(revoked_at > now() - make_interval(secs => $2), false) \
           FROM token WHERE token_hash = digest($1::text, 'sha256')",
    )
    .bind(reissue.presented)
    .bind(REFRESH_REUSE_GRACE_SECONDS)
    .fetch_optional(&mut *conn)
    .await
    .map_err(DbError::from)?;
    let Some((Some(rotated_at), true)) = row else {
        return Ok(None);
    };
    let (access, refresh) = sign_rotation_successor(
        reissue.member_id,
        reissue.workspace_id,
        reissue.scopes,
        reissue.jwt_secret,
        reissue.presented,
        rotated_at,
    )
    .map_err(signing_error)?;
    for half in [&access.token, &refresh.token] {
        if !matches!(
            token_state(conn, half).await.map_err(DbError::from)?,
            TokenState::Active { .. }
        ) {
            return Ok(None);
        }
    }
    let member = get_member(conn, reissue.member_id).await?;
    if member.is_none_or(|member| member.status != "active") {
        return Ok(None);
    }
    Ok(Some(RefreshGate::Issued { access, refresh }))
}

/// #3022 review M5: a pre-088 row gets the lineage its successor continues,
/// so a later replay of it can name — and end — that lineage.
async fn stamp_spent_lineage(
    conn: &mut PgConnection,
    refresh_id: Uuid,
    session_id: Uuid,
) -> Result<(), DbError> {
    momo_db::sqlx::query("UPDATE token SET session_id = $2 WHERE id = $1 AND session_id IS NULL")
        .bind(refresh_id)
        .bind(session_id)
        .execute(&mut *conn)
        .await
        .map_err(DbError::from)?;
    Ok(())
}

/// What a non-linked rotation records, inside the gate transaction.
struct RotatedPair<'a> {
    workspace_id: Uuid,
    member_id: Uuid,
    scopes: &'a [String],
    jwt_secret: &'a str,
    /// Some for a session that carries an ADR-0180 device label: the new pair
    /// keeps it and `device_link_token.redeemed_*` is rebound to it.
    device_label: Option<&'a str>,
    old_refresh_id: Uuid,
    session_id: Uuid,
    /// The refresh token this rotation spends: the successor is derived from
    /// it (#3074, [`sign_rotation_successor`]).
    presented: &'a str,
}

/// Mint the replacement pair and record both halves (and, for a labelled
/// session, rebind the device link) on the caller's transaction — the rows
/// [`issue_and_record_session_in_lineage`] writes for a sign-in, plus the
/// ADR-0180 label and rebind the labelled rotation always carried.
async fn record_rotated_pair_in_tx(
    conn: &mut PgConnection,
    pair: RotatedPair<'_>,
) -> Result<(IssuedToken, IssuedToken), DbError> {
    let rotated_at = rotated_at_unix(conn, pair.old_refresh_id).await?;
    let (access, refresh) = sign_rotation_successor(
        pair.member_id,
        pair.workspace_id,
        pair.scopes,
        pair.jwt_secret,
        pair.presented,
        rotated_at,
    )
    .map_err(signing_error)?;
    let access_id = record_session_token_with_device(
        conn,
        pair.workspace_id,
        pair.member_id,
        DeviceSessionRecord {
            raw_token: &access.token,
            label: SESSION_LABEL_ACCESS,
            scopes: pair.scopes,
            expires_at_unix: access.expires_at,
            device_label: pair.device_label,
            pending_sas: false,
            session_id: pair.session_id,
        },
    )
    .await
    .map_err(DbError::from)?;
    let refresh_id = record_session_token_with_device(
        conn,
        pair.workspace_id,
        pair.member_id,
        DeviceSessionRecord {
            raw_token: &refresh.token,
            label: SESSION_LABEL_REFRESH,
            scopes: pair.scopes,
            expires_at_unix: refresh.expires_at,
            device_label: pair.device_label,
            pending_sas: false,
            session_id: pair.session_id,
        },
    )
    .await
    .map_err(DbError::from)?;
    if pair.device_label.is_some() {
        rebind_device_link_session_in_tx(
            conn,
            pair.workspace_id,
            pair.member_id,
            pair.old_refresh_id,
            access_id,
            refresh_id,
        )
        .await
        .map_err(DbError::from)?;
    }
    Ok((access, refresh))
}

// ---------------------------------------------------------------------------
// POST /v1/auth/logout
// ---------------------------------------------------------------------------

/// Map a verification failure on the logout path to Swift's wording — the same
/// strings the middleware uses, because logout re-implements the same access
/// check minus the revocation state.
fn logout_auth_error(error: AuthError) -> ApiError {
    match error {
        AuthError::InvalidToken(_) => ApiError::unauthorized("invalid or expired token"),
        AuthError::NotAccessToken => ApiError::unauthorized("not an access token"),
        AuthError::NotRefreshToken => ApiError::unauthorized("not a refresh token"),
        AuthError::MalformedClaims => ApiError::unauthorized("malformed token claims"),
    }
}

pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<LogoutResponse>, ApiError> {
    let raw_access = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(bearer_token)
        .ok_or_else(|| ApiError::unauthorized("missing bearer token"))?
        .to_string();

    // Signature + `typ` only. The revocation check is deliberately absent: a
    // second logout of an already-revoked token must stay a 200 (Swift :229-235).
    let principal = verify_app_access(&raw_access, &state.jwt_secret).map_err(logout_auth_error)?;
    let workspace_id = principal.workspace_id;

    // The body is optional in every shape (Swift decodes it with `try?`): no
    // body, a non-JSON body, or `{}` all mean "revoke the access token only".
    let requested: LogoutRequest = serde_json::from_slice(&body).unwrap_or_default();
    let raw_refresh = match requested.refresh_token {
        Some(raw) if !raw.is_empty() => {
            // Validate BEFORE revoking anything, so a mismatched body cannot
            // leave the session half-revoked behind an error response
            // (Swift :261-276). A refresh token belonging to someone else — or
            // to another workspace — is a 403, never a silent revoke.
            let refresh_principal = verify_app_refresh(&raw, &state.jwt_secret)
                .map_err(|_| ApiError::forbidden("refresh token does not match this session"))?;
            if refresh_principal.member_id != principal.member_id
                || refresh_principal.workspace_id != workspace_id
            {
                return Err(ApiError::forbidden(
                    "refresh token does not match this session",
                ));
            }
            Some(raw)
        }
        _ => None,
    };

    // Both revokes in one transaction (Swift uses two connections): a logout
    // that killed the access half but not the refresh half would leave the
    // session rotatable, which is precisely what logout must prevent.
    let member_id = principal.member_id;
    let (revoked_access, revoked_refresh) =
        with_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // #2498 R3 / H1 — take the SAME id-ordered `token` row locks the
                // linked-device refresh takes (`lock_linked_device_in_tx` →
                // `lock_member_session_tokens_by_ids`) BEFORE either `revoke_token`
                // UPDATE below. Without this, logout's lock order is the semantic
                // access→refresh, while refresh's is `ORDER BY id`; the two only
                // agree because `token.id` is `uuidv7()` and the access half is
                // always INSERTed first. This makes the agreement an invariant of
                // the code instead of a property of the id generator.
                //
                // The two lookups are advisory reads, not the idempotency gate:
                // an unknown token contributes no id (nothing to lock) and an
                // already-revoked one still locks its row. Which halves this call
                // actually flipped is decided by the `revoke_token` UPDATEs, so a
                // second logout stays a 200 exactly as before.
                let mut lock_ids: Vec<Uuid> = Vec::with_capacity(2);
                if let Some(id) = token_state(conn, &raw_access)
                    .await
                    .map_err(DbError::from)?
                    .token_id()
                {
                    lock_ids.push(id);
                }
                if let Some(raw) = raw_refresh.as_deref() {
                    if let Some(id) = token_state(conn, raw)
                        .await
                        .map_err(DbError::from)?
                        .token_id()
                    {
                        lock_ids.push(id);
                    }
                }
                lock_member_session_tokens_by_ids(conn, workspace_id, member_id, &lock_ids)
                    .await
                    .map_err(DbError::from)?;

                let access = revoke_token(conn, &raw_access)
                    .await
                    .map_err(DbError::from)?;
                let refresh = match raw_refresh.as_deref() {
                    Some(raw) => Some(revoke_token(conn, raw).await.map_err(DbError::from)?),
                    None => None,
                };

                // #2677 — the session ends when its refresh half dies (an
                // access-only logout leaves a session that can still rotate).
                // Everything registered under it ends in the same transaction:
                // a signed-out phone must stop receiving pushes, placeholder
                // and badge included (ADR-0120 D4 「로그아웃 시 invalidate」).
                if let Some(ended) = refresh.filter(|outcome| outcome.revoked_now) {
                    if let Some(refresh_id) = ended.id {
                        if let Some(session_id) = session_id_of(conn, refresh_id)
                            .await
                            .map_err(DbError::from)?
                        {
                            end_session_lineage_in_tx(
                                conn,
                                workspace_id,
                                member_id,
                                session_id,
                                LineageEnd::Logout,
                            )
                            .await?;
                        }
                    }
                }

                let refresh_revoked = refresh.is_some_and(|outcome| outcome.revoked_now);
                Ok::<(bool, bool), DbError>((access.revoked_now, refresh_revoked))
            })
        })
        .await
        .map_err(|error| db_error("auth.logout", error))?;

    // Swift also writes an `auth.logout` audit_log row here when something was
    // actually revoked (:288-297). Deferred — see the module deviation note.
    let already_revoked = !(revoked_access || revoked_refresh);
    Ok(Json(LogoutResponse {
        status: "ok",
        revoked_access,
        revoked_refresh,
        already_revoked,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_workspace_matches_the_seed_migration() {
        assert_eq!(
            DEMO_WORKSPACE_ID.to_string(),
            "00000000-0000-7000-8000-000000000001",
            "must equal Swift AuthRoutes.demoWorkspaceID / 002_seed.sql"
        );
    }

    #[test]
    fn v0_scopes_match_swift() {
        assert_eq!(base_scopes(), vec!["messages:write", "messages:read"]);
    }

    #[test]
    fn linked_rebind_failure_rolls_back_as_already_used() {
        let error = DbError::Sqlx(momo_db::sqlx::Error::Protocol(
            "linked-device binding changed".to_string(),
        ));
        let mapped = refresh_tx_error(error);
        assert_eq!(mapped.status.as_u16(), 401);
        assert_eq!(mapped.message, "refresh token already used or revoked");
    }

    #[test]
    fn refresh_rejections_use_swift_wording_and_status() {
        let cases = [
            (AuthError::NotRefreshToken, 401, "not a refresh token"),
            (AuthError::MalformedClaims, 401, "malformed token claims"),
        ];
        for (error, status, message) in cases {
            let api = refresh_auth_error(error);
            assert_eq!(api.status.as_u16(), status);
            assert_eq!(api.message, message);
        }
        // An unverifiable token yields AuthError::InvalidToken without this
        // crate depending on the JWT library.
        let unverifiable = verify_app_refresh("not.a.jwt", "secret").expect_err("must not verify");
        let mapped = refresh_auth_error(unverifiable);
        assert_eq!(mapped.status.as_u16(), 401);
        assert_eq!(
            mapped.message, "invalid or expired refresh token",
            "the refresh route says 'refresh token', not the middleware's wording"
        );
    }

    #[test]
    fn logout_rejections_use_the_middleware_wording() {
        assert_eq!(
            logout_auth_error(AuthError::NotAccessToken).message,
            "not an access token"
        );
        let unverifiable = verify_app_access("not.a.jwt", "secret").expect_err("must not verify");
        assert_eq!(
            logout_auth_error(unverifiable).message,
            "invalid or expired token"
        );
        assert_eq!(
            logout_auth_error(AuthError::MalformedClaims)
                .status
                .as_u16(),
            401
        );
    }

    /// The refresh route can only ever hand a *downgraded* scope list to the
    /// new pair: this server never elevates, so carrying a privileged scope is
    /// by definition not re-issuable here (module deviation note).
    #[test]
    fn refresh_downgrades_a_privileged_scope_list() {
        let carried = vec![
            "messages:write".to_string(),
            "platform:read".to_string(),
            "messages:read".to_string(),
        ];
        assert!(carries_privileged_scope(&carried));
        assert_eq!(
            without_privileged_scopes(&carried),
            vec!["messages:write".to_string(), "messages:read".to_string()]
        );
        // An ordinary session round-trips unchanged (no gratuitous scope loss).
        let ordinary = base_scopes();
        assert!(!carries_privileged_scope(&ordinary));
        assert_eq!(without_privileged_scopes(&ordinary), ordinary);
    }

    /// **The blank path still lands on the demo workspace — the regression
    /// guard for goal B13 R2 High 1.**
    ///
    /// The connect form ships with this box EMPTY (`CONFIGURED_WORKSPACE`), the
    /// smoke harness omits it unless `MOMO_WORKSPACE` is set, and every client
    /// written before this batch sends nothing. Making an unusable value fail
    /// must not make "I named nothing" fail with it: that would lock everyone
    /// out of the default workspace at once.
    #[test]
    fn a_login_that_names_no_workspace_still_gets_the_default() {
        for absent in [None, Some(""), Some("   "), Some("\t\n")] {
            assert_eq!(
                resolve_login_workspace(absent).expect("blank is not an error"),
                DEMO_WORKSPACE_ID,
                "{absent:?} names nothing, which is not a mistake to report"
            );
        }
    }

    /// A named workspace is honoured, whatever case it arrives in.
    #[test]
    fn a_named_workspace_id_is_the_one_the_session_is_scoped_to() {
        let target = Uuid::from_u128(0x0199_aa11_2222_7000_8000_0000_0000_00d1);
        assert_eq!(
            resolve_login_workspace(Some(&target.to_string())).expect("a uuid"),
            target
        );
        assert_eq!(
            resolve_login_workspace(Some(&target.to_string().to_uppercase())).expect("a uuid"),
            target
        );
        // Surrounding whitespace is a paste artifact, not a different workspace.
        assert_eq!(
            resolve_login_workspace(Some(&format!("  {target}  "))).expect("a uuid"),
            target
        );
    }

    /// **A supplied-but-unusable workspace fails loudly instead of signing the
    /// person into a different tenant.**
    ///
    /// The old code parsed, discarded and fell back, so `workspace: "dawn-team"`
    /// logged you into the demo workspace and said nothing. The values below are
    /// exactly what a person reaches for when the box says "워크스페이스" and the
    /// product has never once shown them an id: the slug and the display name.
    ///
    /// The sentence must keep naming `workspace`, because the web client keys
    /// its Korean copy off that word.
    #[test]
    fn a_workspace_that_is_not_an_id_is_a_visible_400() {
        for typed in ["dawn-team", "우리 팀", "not-a-uuid", "00000000", "0"] {
            let rejection = resolve_login_workspace(Some(typed))
                .expect_err("a supplied value that cannot be a workspace id");
            assert_eq!(
                rejection.status,
                axum::http::StatusCode::BAD_REQUEST,
                "{typed:?} must be refused, never silently swapped for the default"
            );
            assert!(
                rejection.message.to_lowercase().contains("workspace"),
                "the client matches on this word to translate the refusal: {}",
                rejection.message
            );
        }
    }
}
