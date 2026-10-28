//! ADR-0216 D6 (나) / #4700 — the **human-subject arm** of the OAuth authorization
//! server: the ledger behind `oort login`'s browser approval.
//!
//! This module is to the developer login what [`crate::hosted_oauth`] is to the
//! hosted agent connection: the sole owner of the SQL, taking a caller-supplied
//! tenant transaction. It is deliberately a **separate module with separate
//! secrets** rather than a mode of the hosted one, because nothing is shared on
//! purpose:
//!
//! * the signed request envelope has its own key label and `typ`, so a hosted
//!   request envelope presented to a developer-login consent route (or the other
//!   way round) fails by signature and by type;
//! * the authorization code has its own envelope prefix (`momo_devc_v1`), so the
//!   same secret bytes re-labelled as `momo_dev_v1`, `momo_devr_v1` or
//!   `momo_oauth_code_v1` hash to a digest no row carries;
//! * the code is bought with a human's current password (the route's job) and
//!   buys a *developer login lineage* ([`crate::dev_token::issue_dev_login_in_tx`]),
//!   never a hosted agent credential.
//!
//! ## What the ledger remembers, and why
//!
//! One row per signed request nonce: exactly one terminal decision (approve or
//! deny) survives however many times a consent screen is submitted. The code is
//! stored only as the SHA-256 of the whole envelope. A consumed row remembers the
//! lineage its code opened (`session_id`), so a code presented a second time ends
//! that lineage — the same compromise signal as a re-used refresh token.
//!
//! ## Lock order (#3109)
//!
//! Redeeming a code is `peek the row (no lock) → member-wide sweep lock → the row
//! FOR UPDATE → judge again → issue → mark consumed`, the order
//! [`crate::dev_token::rotate_dev_refresh_in_tx`] uses. A password change or reset
//! sweep (`revoke_member_dev_tokens_in_tx`) takes the same sweep lock first, so the
//! two serialize: either the sweep burns the pending code before the redemption
//! sees it, or the redemption's lineage exists before the sweep locks the
//! member's developer rows and the sweep ends it. A lineage can never slip between
//! the two.

use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::dev_token::{
    envelope_workspace_id, issue_dev_login_in_tx, mint_dev_envelope, normalized_dev_scopes,
    revoke_dev_lineage, DevAccessPolicy, DevIssueError, DevTool, IssuedDevLogin, NewDevLogin,
    ACCESS_TTL_SECONDS,
};
use crate::jwt::AuthError;
use crate::token_store::lock_member_wide_sweep_in_tx;

/// The authorization-code envelope prefix. Its own family: the stored digest
/// covers the whole envelope, so no other credential's bytes can be replayed as a
/// code.
pub const DEV_LOGIN_CODE_PREFIX: &str = "momo_devc_v1";

/// A code is a hand-off between two HTTP requests that happen back to back.
/// Sixty seconds is generous for that and short enough that an interception
/// window is not a session.
pub const DEV_LOGIN_CODE_TTL_SECONDS: i64 = 60;

/// How long a validated login request stays consentable. A person has to read the
/// screen and type a password; ten minutes covers that without leaving a pending
/// grant lying around.
pub const DEV_LOGIN_REQUEST_TTL_SECONDS: i64 = 10 * 60;

/// The `typ` of the signed login-request envelope. Any other momo token presented
/// at a login consent route is refused by type before its signature buys anything.
pub const DEV_LOGIN_REQUEST_TYP: &str = "momo.dev.login.request.v1";
const DEV_LOGIN_REQUEST_KID: &str = "dla";
const DEV_LOGIN_REQUEST_KEY_LABEL: &str = "momo.dev.login.request.v1.key";
const DEV_LOGIN_REQUEST_LEEWAY_SECONDS: u64 = 5;

/// The lineage label a browser login stores (the credentials list shows this plus
/// the device name the connecting side chose).
pub const DEV_LOGIN_LABEL: &str = "oort CLI";

const _: () = assert!(
    DEV_LOGIN_CODE_TTL_SECONDS < ACCESS_TTL_SECONDS,
    "a code is a hand-off, not a session: it must outlive nothing"
);

/// Derive the envelope signing key from the app JWT secret.
///
/// `SHA-256(label ‖ 0x00 ‖ secret)` — the construction of
/// [`crate::hosted_oauth::hosted_oauth_request_key`] with a different label, so the
/// two keys differ and neither verifies the other's envelope.
pub fn dev_login_request_key(jwt_secret: &str) -> String {
    let mut input = Vec::with_capacity(DEV_LOGIN_REQUEST_KEY_LABEL.len() + 1 + jwt_secret.len());
    input.extend_from_slice(DEV_LOGIN_REQUEST_KEY_LABEL.as_bytes());
    input.push(0);
    input.extend_from_slice(jwt_secret.as_bytes());
    momo_wire::sha256_hex(&input)
}

/// The validated login request, carried to the consent surface as one opaque
/// signed string.
///
/// Signed rather than stored because `GET /v1/oauth/authorize` is unauthenticated:
/// a DB row per arriving browser would be an unauthenticated write. **Nothing
/// secret is inside** — the code challenge is a public PKCE value, the state is
/// the client's own, the device name is a label the connecting side chose.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DevLoginRequestClaims {
    /// Server-minted nonce; the uniqueness key of the terminal decision.
    pub jti: String,
    /// The built-in public client.
    pub cid: String,
    /// The exact fixed loopback redirect this request named.
    pub ru: String,
    /// RFC 8707 resource; always the canonical human-MCP resource.
    pub res: String,
    /// Requested scopes, normalized to the `dev:` vocabulary.
    pub scp: Vec<String>,
    /// PKCE challenge (S256 only; the method is implied by `ccm`).
    pub cc: String,
    pub ccm: String,
    /// Client state, echoed once into the redirect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub st: Option<String>,
    /// Device name chosen by the connecting side (shown as such, never verified).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dn: Option<String>,
    pub exp: usize,
    pub iat: usize,
    pub typ: String,
}

/// The already-validated material one login-request envelope carries. A struct
/// because five of the fields are `&str` and three of them — client id, redirect
/// URI, resource — are exactly the values whose transposition would be a security
/// bug that still compiles.
#[derive(Debug, Clone, Copy)]
pub struct DevLoginRequestSeed<'a> {
    pub nonce: Uuid,
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub resource: &'a str,
    pub scopes: &'a [String],
    pub code_challenge: &'a str,
    pub code_challenge_method: &'a str,
    pub state: Option<&'a str>,
    pub device_name: Option<&'a str>,
}

/// Sign one validated login request.
pub fn sign_dev_login_request(
    key: &str,
    seed: DevLoginRequestSeed<'_>,
    now_seconds: i64,
) -> Result<String, AuthError> {
    let claims = DevLoginRequestClaims {
        jti: seed.nonce.to_string(),
        cid: seed.client_id.to_string(),
        ru: seed.redirect_uri.to_string(),
        res: seed.resource.to_string(),
        scp: seed.scopes.to_vec(),
        cc: seed.code_challenge.to_string(),
        ccm: seed.code_challenge_method.to_string(),
        st: seed.state.map(str::to_string),
        dn: seed.device_name.map(str::to_string),
        iat: now_seconds.max(0) as usize,
        exp: (now_seconds + DEV_LOGIN_REQUEST_TTL_SECONDS).max(0) as usize,
        typ: DEV_LOGIN_REQUEST_TYP.to_string(),
    };
    let mut header = Header::new(Algorithm::HS256);
    header.kid = Some(DEV_LOGIN_REQUEST_KID.to_string());
    encode(&header, &claims, &EncodingKey::from_secret(key.as_bytes()))
        .map_err(AuthError::InvalidToken)
}

/// Verify one presented login-request envelope (signature, expiry, `typ`, nonce).
pub fn verify_dev_login_request(
    key: &str,
    presented: &str,
) -> Result<DevLoginRequestClaims, AuthError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = DEV_LOGIN_REQUEST_LEEWAY_SECONDS;
    validation.required_spec_claims.clear();
    validation.validate_aud = false;
    let claims = decode::<DevLoginRequestClaims>(
        presented,
        &DecodingKey::from_secret(key.as_bytes()),
        &validation,
    )
    .map_err(AuthError::InvalidToken)?
    .claims;
    if claims.typ != DEV_LOGIN_REQUEST_TYP {
        return Err(AuthError::NotAccessToken);
    }
    if Uuid::parse_str(&claims.jti).is_err() {
        return Err(AuthError::MalformedClaims);
    }
    Ok(claims)
}

/// The workspace a presented **authorization code** claims, or `None` when the
/// string is not `momo_devc_v1.<lowercase uuid>.<≥43 base64url chars>`. This is
/// what lets the public token route open a tenant transaction before any row can
/// be found (the API role is NOBYPASSRLS); nothing else is read from the code.
pub fn dev_login_code_workspace_id(raw: &str) -> Option<Uuid> {
    envelope_workspace_id(raw, DEV_LOGIN_CODE_PREFIX)
}

/// The approval's one-time output. The code is redacted from `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct DevLoginApproval {
    pub request_id: Uuid,
    pub authorization_code: String,
    pub code_expires_at_ms: i64,
}

impl std::fmt::Debug for DevLoginApproval {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DevLoginApproval")
            .field("request_id", &self.request_id)
            .field("authorization_code", &"<redacted>")
            .field("code_expires_at_ms", &self.code_expires_at_ms)
            .finish()
    }
}

/// Why a ledger decision refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevLoginRefusal {
    /// The envelope's nonce is not a nonce.
    NotFound,
    /// A decision for this request nonce already exists. Exactly one terminal
    /// decision per request, so a second click is inert.
    AlreadyDecided,
    /// The approved scopes are not a non-empty subset of the requested ones in the
    /// `dev:` vocabulary.
    InvalidApproval,
}

/// Record the human's **approval** and mint the one-time code.
///
/// The caller has already judged, in this transaction, that `member_id` is a live
/// human admitted by the access switch, and has verified the member's current
/// password. `approved_scopes` is normalized here (vocabulary, order, `dev:identity`
/// always present) and must be ⊆ the request's scopes — the issued scopes can never
/// exceed what the request named and the person chose.
pub async fn approve_dev_login_request_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    claims: &DevLoginRequestClaims,
    approved_scopes: &[String],
) -> Result<Result<DevLoginApproval, DevLoginRefusal>, sqlx::Error> {
    if approved_scopes.is_empty() {
        return Ok(Err(DevLoginRefusal::InvalidApproval));
    }
    let Ok(approved) = normalized_dev_scopes(Some(approved_scopes)) else {
        return Ok(Err(DevLoginRefusal::InvalidApproval));
    };
    if !approved
        .iter()
        .all(|scope| claims.scp.iter().any(|requested| requested == scope))
    {
        return Ok(Err(DevLoginRefusal::InvalidApproval));
    }
    let Ok(nonce) = Uuid::parse_str(&claims.jti) else {
        return Ok(Err(DevLoginRefusal::NotFound));
    };

    let raw_code = mint_dev_envelope(DEV_LOGIN_CODE_PREFIX, workspace_id)?;
    let inserted = sqlx::query(
        "INSERT INTO dev_login_authorization \
           (workspace_id, member_id, request_nonce, client_id, redirect_uri, resource, \
            requested_scopes, approved_scopes, code_challenge, code_challenge_method, \
            device_name, status, code_hash, code_expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'approved', \
                 digest($12::text, 'sha256'), now() + ($13::bigint * interval '1 second')) \
         ON CONFLICT (workspace_id, request_nonce) DO NOTHING \
         RETURNING id, (EXTRACT(EPOCH FROM code_expires_at) * 1000)::bigint AS code_expires_at_ms",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(nonce)
    .bind(&claims.cid)
    .bind(&claims.ru)
    .bind(&claims.res)
    .bind(&claims.scp)
    .bind(&approved)
    .bind(&claims.cc)
    .bind(&claims.ccm)
    .bind(claims.dn.as_deref())
    .bind(&raw_code)
    .bind(DEV_LOGIN_CODE_TTL_SECONDS)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(inserted) = inserted else {
        return Ok(Err(DevLoginRefusal::AlreadyDecided));
    };
    Ok(Ok(DevLoginApproval {
        request_id: inserted.try_get("id")?,
        authorization_code: raw_code,
        code_expires_at_ms: inserted.try_get("code_expires_at_ms")?,
    }))
}

/// Record the human's **denial**: a terminal decision keyed on the same nonce as an
/// approval, so a deny that lands first makes a later approve inert and vice versa.
/// No code, no scopes, nothing issued.
pub async fn deny_dev_login_request_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    claims: &DevLoginRequestClaims,
) -> Result<Result<Uuid, DevLoginRefusal>, sqlx::Error> {
    let Ok(nonce) = Uuid::parse_str(&claims.jti) else {
        return Ok(Err(DevLoginRefusal::NotFound));
    };
    let inserted: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO dev_login_authorization \
           (workspace_id, member_id, request_nonce, client_id, redirect_uri, resource, \
            requested_scopes, code_challenge, code_challenge_method, device_name, status) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'denied') \
         ON CONFLICT (workspace_id, request_nonce) DO NOTHING RETURNING id",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(nonce)
    .bind(&claims.cid)
    .bind(&claims.ru)
    .bind(&claims.res)
    .bind(&claims.scp)
    .bind(&claims.cc)
    .bind(&claims.ccm)
    .bind(claims.dn.as_deref())
    .fetch_optional(&mut *conn)
    .await?;
    Ok(inserted.ok_or(DevLoginRefusal::AlreadyDecided))
}

/// A locked authorization-code row, before the caller checks PKCE and the
/// redirect. The row is held `FOR UPDATE` (after the member's sweep lock) when this
/// returns, which is what lets the PKCE comparison happen in Rust — where the
/// SHA-256 is — without opening a window between the check and the consume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevLoginCodeLock {
    pub request_id: Uuid,
    pub member_id: Uuid,
    pub client_id: String,
    pub redirect_uri: String,
    pub resource: String,
    pub approved_scopes: Vec<String>,
    pub code_challenge: String,
    pub device_name: Option<String>,
    /// `approved`, `consumed`, `revoked` (a `denied` row has no code to find).
    pub status: String,
    /// The code's 60 seconds are over (or it has no expiry).
    pub expired: bool,
    /// The lineage a `consumed` code opened.
    pub session_id: Option<Uuid>,
}

/// Lock one presented authorization code.
///
/// Returns the row whatever its state — `approved`, already `consumed`, `revoked`
/// or past its expiry — because the caller has to tell a replay (which ends the
/// lineage the first use opened) from a first use. `None` only when no row carries
/// this code in this tenant.
pub async fn lock_dev_login_code_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    raw_code: &str,
) -> Result<Option<DevLoginCodeLock>, sqlx::Error> {
    // Whose sweep lock to queue behind: read first, without a row lock.
    let member: Option<Uuid> = sqlx::query_scalar(
        "SELECT member_id FROM dev_login_authorization \
          WHERE workspace_id = $1 AND code_hash = digest($2::text, 'sha256')",
    )
    .bind(workspace_id)
    .bind(raw_code)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(member_id) = member else {
        return Ok(None);
    };
    lock_member_wide_sweep_in_tx(conn, workspace_id, member_id).await?;

    let row = sqlx::query(
        "SELECT id, member_id, client_id, redirect_uri, resource, approved_scopes, \
                code_challenge, device_name, status, \
                (code_expires_at IS NULL OR code_expires_at <= now()) AS expired, session_id \
           FROM dev_login_authorization \
          WHERE workspace_id = $1 AND code_hash = digest($2::text, 'sha256') \
          FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(raw_code)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(DevLoginCodeLock {
        request_id: row.try_get("id")?,
        member_id: row.try_get("member_id")?,
        client_id: row.try_get("client_id")?,
        redirect_uri: row.try_get("redirect_uri")?,
        resource: row.try_get("resource")?,
        approved_scopes: row.try_get("approved_scopes")?,
        code_challenge: row.try_get("code_challenge")?,
        device_name: row.try_get("device_name")?,
        status: row.try_get("status")?,
        expired: row.try_get("expired")?,
        session_id: row.try_get("session_id")?,
    }))
}

/// What redeeming a locked code produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevLoginRedeem {
    /// The code is consumed and this is the lineage it bought. The raw envelopes
    /// are in the value exactly once.
    Issued(Box<IssuedDevLogin>),
    /// The exchange-time re-judgement refused (the member is no longer an active
    /// human admitted by the access switch, or the lineage limit is reached). The
    /// code is **burned** (`revoked`) in this transaction — the caller must commit
    /// it and then answer `invalid_grant`.
    Refused(DevIssueError),
    /// The locked row is not an unexpired `approved` one. Nothing was written.
    NotRedeemable,
}

/// Redeem the locked code: re-judge the member (D6 「동의와 교환 두 시점에 정책을
/// 평가」), open the login lineage with exactly the approved scopes, and mark the
/// code consumed with the lineage's `session_id`.
///
/// The caller has already checked the PKCE verifier, the client and the redirect
/// against the locked row, under the same lock. A wrong verifier must not reach
/// this function: it does not burn the code (the holder of the real verifier can
/// still redeem it within its 60 seconds).
pub async fn redeem_dev_login_code_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    locked: &DevLoginCodeLock,
    policy: DevAccessPolicy,
) -> Result<DevLoginRedeem, sqlx::Error> {
    if locked.status != "approved" || locked.expired {
        return Ok(DevLoginRedeem::NotRedeemable);
    }
    let login = NewDevLogin {
        label: DEV_LOGIN_LABEL.to_string(),
        tool: DevTool::Cli,
        client: locked.client_id.clone(),
        device_name: locked.device_name.clone(),
        scopes: locked.approved_scopes.clone(),
        channel_ids: None,
    };
    let issued =
        match issue_dev_login_in_tx(conn, workspace_id, locked.member_id, &login, policy).await? {
            Ok(issued) => issued,
            Err(refusal) => {
                sqlx::query(
                    "UPDATE dev_login_authorization \
                        SET status = 'revoked', updated_at = now() \
                      WHERE workspace_id = $1 AND id = $2 AND status = 'approved'",
                )
                .bind(workspace_id)
                .bind(locked.request_id)
                .execute(&mut *conn)
                .await?;
                return Ok(DevLoginRedeem::Refused(refusal));
            }
        };
    let consumed = sqlx::query(
        "UPDATE dev_login_authorization \
            SET status = 'consumed', code_consumed_at = now(), session_id = $3, \
                updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 AND status = 'approved' \
            AND code_consumed_at IS NULL",
    )
    .bind(workspace_id)
    .bind(locked.request_id)
    .bind(issued.session_id)
    .execute(&mut *conn)
    .await?;
    if consumed.rows_affected() != 1 {
        // The row moved under the lock. Failing the whole transaction is the only
        // outcome that cannot leave a live lineage for a code that was never marked
        // consumed.
        return Err(sqlx::Error::RowNotFound);
    }
    Ok(DevLoginRedeem::Issued(Box::new(issued)))
}

/// A consumed code was presented again: end the lineage its first use opened (the
/// access and the refresh together). `Ok(0)` when the row never opened one or the
/// lineage is already over. The caller commits this and then answers
/// `invalid_grant` — the response is the same bytes as any other bad code.
pub async fn revoke_dev_login_lineage_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    locked: &DevLoginCodeLock,
) -> Result<u64, sqlx::Error> {
    match locked.session_id {
        Some(session_id) => {
            revoke_dev_lineage(conn, workspace_id, locked.member_id, session_id).await
        }
        None => Ok(0),
    }
}

/// Burn every code of this member that is still waiting for its exchange. Called by
/// `revoke_member_dev_tokens_in_tx` under the member-wide sweep lock, so a password
/// change or reset in one transaction ends both the member's developer tokens and
/// the pending logins that would have opened a new lineage a moment later (D7).
pub async fn invalidate_pending_dev_logins_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<u64, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE dev_login_authorization \
            SET status = 'revoked', updated_at = now() \
          WHERE workspace_id = $1 AND member_id = $2 AND status = 'approved' \
            AND code_consumed_at IS NULL",
    )
    .bind(workspace_id)
    .bind(member_id)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected())
}

/// The lineage a presented access or refresh envelope belongs to, for
/// `POST /v1/oauth/revoke` (RFC 7009).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DevLoginRevocationTarget {
    pub member_id: Uuid,
    pub session_id: Uuid,
}

/// Resolve what a presented token names, **access or refresh form only** and only
/// when it was issued to `client_id` — a card token is not a login credential and
/// a token of another client is not this client's to revoke. Revoked and expired
/// rows are found too (revocation is idempotent). `None` is "not a login token":
/// the caller still answers 200 (RFC 7009), so the endpoint is no oracle.
pub async fn resolve_dev_login_revocation_target_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    raw_token: &str,
    client_id: &str,
) -> Result<Option<DevLoginRevocationTarget>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT actor_member_id, session_id \
           FROM token \
          WHERE workspace_id = $1 \
            AND kind = 'dev' \
            AND dev_form IN ('access', 'refresh') \
            AND dev_client = $3 \
            AND session_id IS NOT NULL \
            AND token_hash = digest($2::text, 'sha256') \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(raw_token)
    .bind(client_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(DevLoginRevocationTarget {
        member_id: row.try_get("actor_member_id")?,
        session_id: row.try_get("session_id")?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dev_token::{
        dev_refresh_workspace_id, dev_token_workspace_id, DEV_REFRESH_PREFIX, DEV_TOKEN_PREFIX,
    };
    use crate::hosted_oauth::{
        hosted_oauth_code_workspace_id, hosted_oauth_request_key, sign_authorization_request,
        verify_authorization_request, AuthorizationRequestSeed, HOSTED_OAUTH_CODE_PREFIX,
    };

    const SECRET: &str = "unit-test-jwt-secret-not-used-anywhere-else";
    const WS: &str = "0190f2a4-6b1d-7c3e-8f00-00000000a1a1";
    const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    fn scopes() -> Vec<String> {
        vec!["dev:identity".to_string(), "dev:channels:read".to_string()]
    }

    fn seed<'a>(scopes: &'a [String], nonce: Uuid) -> DevLoginRequestSeed<'a> {
        DevLoginRequestSeed {
            nonce,
            client_id: "oort-cli",
            redirect_uri: "http://127.0.0.1:24681/callback",
            resource: "https://oort.example/v1/mcp/me",
            scopes,
            code_challenge: CHALLENGE,
            code_challenge_method: "S256",
            state: Some("state-value"),
            device_name: Some("oort CLI · macOS"),
        }
    }

    fn now_seconds() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_secs() as i64
    }

    #[test]
    fn a_signed_request_round_trips_and_carries_exactly_what_was_validated() {
        let key = dev_login_request_key(SECRET);
        let nonce = Uuid::new_v4();
        let scopes = scopes();
        let envelope =
            sign_dev_login_request(&key, seed(&scopes, nonce), now_seconds()).expect("signs");
        let claims = verify_dev_login_request(&key, &envelope).expect("verifies");
        assert_eq!(claims.jti, nonce.to_string());
        assert_eq!(claims.cid, "oort-cli");
        assert_eq!(claims.ru, "http://127.0.0.1:24681/callback");
        assert_eq!(claims.res, "https://oort.example/v1/mcp/me");
        assert_eq!(claims.scp, scopes);
        assert_eq!(claims.cc, CHALLENGE);
        assert_eq!(claims.ccm, "S256");
        assert_eq!(claims.st.as_deref(), Some("state-value"));
        assert_eq!(claims.dn.as_deref(), Some("oort CLI · macOS"));
        assert_eq!(claims.typ, DEV_LOGIN_REQUEST_TYP);
        assert_eq!(
            claims.exp - claims.iat,
            DEV_LOGIN_REQUEST_TTL_SECONDS as usize
        );
    }

    #[test]
    fn an_expired_a_tampered_and_a_wrong_key_envelope_all_fail() {
        let key = dev_login_request_key(SECRET);
        let scopes = scopes();
        let nonce = Uuid::new_v4();
        // Long past: expired beyond the leeway.
        let expired =
            sign_dev_login_request(&key, seed(&scopes, nonce), 1_000_000_000).expect("signs");
        assert!(verify_dev_login_request(&key, &expired).is_err());

        let now = now_seconds();
        let good = sign_dev_login_request(&key, seed(&scopes, nonce), now).expect("signs");
        assert!(verify_dev_login_request(&key, &good).is_ok());

        // Flip one character of the payload segment.
        let mut parts: Vec<String> = good.split('.').map(str::to_string).collect();
        let payload = parts[1].clone();
        let flipped = if payload.starts_with('A') { 'B' } else { 'A' };
        parts[1] = format!("{flipped}{}", &payload[1..]);
        assert!(verify_dev_login_request(&key, &parts.join(".")).is_err());

        let other_key = dev_login_request_key("a-different-secret");
        assert!(verify_dev_login_request(&other_key, &good).is_err());
    }

    #[test]
    fn hosted_and_developer_request_envelopes_never_verify_each_other() {
        let now = now_seconds();
        let dev_key = dev_login_request_key(SECRET);
        let hosted_key = hosted_oauth_request_key(SECRET);
        assert_ne!(dev_key, hosted_key, "the two keys are domain-separated");

        let scopes = scopes();
        let dev_envelope =
            sign_dev_login_request(&dev_key, seed(&scopes, Uuid::new_v4()), now).expect("dev");
        let hosted_scopes = vec!["agent:port:connect".to_string()];
        let hosted_envelope = sign_authorization_request(
            &hosted_key,
            AuthorizationRequestSeed {
                nonce: Uuid::new_v4(),
                client_id: "some-hosted-client",
                redirect_uri: "https://client.example/cb",
                resource: "https://oort.example/v1/mcp/agent-port",
                scopes: &hosted_scopes,
                code_challenge: CHALLENGE,
                code_challenge_method: "S256",
                state: None,
            },
            now,
        )
        .expect("hosted");

        // Each verifies under its own key only.
        assert!(verify_dev_login_request(&dev_key, &dev_envelope).is_ok());
        assert!(verify_authorization_request(&hosted_key, &hosted_envelope).is_ok());
        // Wrong kind under the right key for the verifier: the signature (key
        // label) already fails …
        assert!(verify_dev_login_request(&dev_key, &hosted_envelope).is_err());
        assert!(verify_authorization_request(&hosted_key, &dev_envelope).is_err());
        // … and even if an operator-level mistake handed one family the other's
        // key, the `typ` check is the second wall.
        assert!(verify_dev_login_request(&hosted_key, &hosted_envelope).is_err());
        assert!(verify_authorization_request(&dev_key, &dev_envelope).is_err());
    }

    fn body() -> String {
        // 43 base64url characters, the shape of a minted secret.
        "A".repeat(43)
    }

    #[test]
    fn only_a_devc_envelope_names_a_code_workspace() {
        let code = format!("{DEV_LOGIN_CODE_PREFIX}.{WS}.{}", body());
        assert_eq!(
            dev_login_code_workspace_id(&code),
            Some(Uuid::parse_str(WS).unwrap())
        );
        // Same bytes, any other family's prefix: not a code.
        for prefix in [
            DEV_TOKEN_PREFIX,
            DEV_REFRESH_PREFIX,
            HOSTED_OAUTH_CODE_PREFIX,
            "momo_agent_v1",
        ] {
            let relabelled = format!("{prefix}.{WS}.{}", body());
            assert_eq!(dev_login_code_workspace_id(&relabelled), None, "{prefix}");
        }
        // A code is not any other family's credential either.
        assert_eq!(dev_token_workspace_id(&code), None);
        assert_eq!(dev_refresh_workspace_id(&code), None);
        assert_eq!(hosted_oauth_code_workspace_id(&code), None);
    }

    #[test]
    fn a_malformed_code_names_no_workspace() {
        for bad in [
            String::new(),
            format!("{DEV_LOGIN_CODE_PREFIX}.{WS}"),
            format!("{DEV_LOGIN_CODE_PREFIX}.{WS}.{}", "A".repeat(42)),
            format!("{DEV_LOGIN_CODE_PREFIX}.{WS}.{}.extra", body()),
            format!("{DEV_LOGIN_CODE_PREFIX}.not-a-uuid.{}", body()),
            format!("{DEV_LOGIN_CODE_PREFIX}.{}.{}", WS.to_uppercase(), body()),
            format!("{DEV_LOGIN_CODE_PREFIX}.{WS}.{}!", "A".repeat(42)),
            format!(" {DEV_LOGIN_CODE_PREFIX}.{WS}.{}", body()),
        ] {
            assert_eq!(dev_login_code_workspace_id(&bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_approval_redacts_its_code_from_debug() {
        let approval = DevLoginApproval {
            request_id: Uuid::new_v4(),
            authorization_code: format!("{DEV_LOGIN_CODE_PREFIX}.{WS}.{}", body()),
            code_expires_at_ms: 1,
        };
        let shown = format!("{approval:?}");
        assert!(!shown.contains(&body()));
        assert!(!shown.contains(DEV_LOGIN_CODE_PREFIX));
        assert!(shown.contains("<redacted>"));
    }
}
