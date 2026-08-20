//! ADR-0162 증보 1 / HAP-E7 — the OAuth 2.1 authorization-server ledger.
//!
//! This module is to OAuth what [`crate::hosted_connection`] is to static
//! pairing: the sole owner of the SQL, taking a caller-supplied tenant
//! transaction and returning raw material exactly once from the mutation that
//! minted it. Protocol arithmetic (PKCE, metadata, redirect construction,
//! parameter grammar) lives in `momo-mcp`, which has no database.
//!
//! ## The three credentials, and why they are three
//!
//! A pairing challenge, an authorization code and an access/refresh token are
//! separate secrets with separate lifetimes and separate audiences, and none of
//! them is ever promoted into another:
//!
//! * the **authorization code** is single-use, short-lived, PKCE-bound and
//!   stored only as a digest. Consuming it and minting the pair it buys is one
//!   statement sequence inside one transaction, so a replay finds a consumed row
//!   rather than a second issuance;
//! * the **access credential** is the only one the Agent Port accepts, and its
//!   envelope prefix differs from both the static agent bearer and the refresh
//!   credential — so the same secret bytes re-labelled as another envelope hash
//!   to something no row carries;
//! * the **refresh credential** never authenticates a request. It buys a new
//!   pair at the token endpoint, and rotation is enforced by a partial unique
//!   index rather than by convention.
//!
//! ## No downgrade
//!
//! Nothing in this module can produce a `hosted_active` (static) credential, and
//! migration 074's `token_hosted_class_auth_mode_guard` refuses one on an
//! `oauth` connection anyway. An OAuth failure therefore has no static path to
//! fall back to: the connection stays where it was and the caller sees an OAuth
//! error.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::hosted_connection::{hosted_identity_is_live_in_tx, HOSTED_AGENT_PORT_AUDIENCE};
use crate::jwt::AuthError;

/// Envelope prefixes. Each names its own credential family, and the stored hash
/// covers the whole envelope — so re-labelling an access credential as a static
/// agent bearer produces a digest no row has.
pub const HOSTED_OAUTH_CODE_PREFIX: &str = "momo_oauth_code_v1";
pub const HOSTED_OAUTH_ACCESS_PREFIX: &str = "momo_oauth_at_v1";
pub const HOSTED_OAUTH_REFRESH_PREFIX: &str = "momo_oauth_rt_v1";

/// An authorization code is a hand-off between two HTTP requests that happen
/// back to back. Sixty seconds is generous for that and short enough that an
/// interception window is not a session.
pub const HOSTED_OAUTH_CODE_TTL_SECONDS: i64 = 60;
pub const HOSTED_OAUTH_ACCESS_TTL_SECONDS: i64 = 30 * 60;
pub const HOSTED_OAUTH_REFRESH_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
/// How long a validated authorization request stays consentable. A person has
/// to log in and read the screen; ten minutes covers that without leaving a
/// pending grant lying around.
pub const HOSTED_OAUTH_REQUEST_TTL_SECONDS: i64 = 10 * 60;

/// The `typ` of the signed authorization-request envelope. Any other momo token
/// presented here is refused by type before its signature buys anything.
pub const HOSTED_OAUTH_REQUEST_TYP: &str = "momo.hosted.oauth.request.v1";
const HOSTED_OAUTH_REQUEST_KID: &str = "hoa";
const HOSTED_OAUTH_REQUEST_KEY_LABEL: &str = "momo.hosted.oauth.request.v1.key";
const HOSTED_OAUTH_REQUEST_LEEWAY_SECONDS: u64 = 5;

const SECRET_BYTES: usize = 32;
const MINIMUM_SECRET_CHARS: usize = 43;

const _: () = assert!(
    HOSTED_OAUTH_CODE_TTL_SECONDS < HOSTED_OAUTH_ACCESS_TTL_SECONDS,
    "a code is a hand-off, not a session: it must outlive nothing"
);

/// Derive the envelope signing key from the app JWT secret.
///
/// `SHA-256(label ‖ 0x00 ‖ secret)` — same construction as
/// [`crate::ephemeral_grant::ephemeral_grant_key`], for the same two reasons:
/// the secret goes last so the input is not length-extendable, and the label
/// makes the output unusable as any other momo key.
pub fn hosted_oauth_request_key(jwt_secret: &str) -> String {
    let mut input = Vec::with_capacity(HOSTED_OAUTH_REQUEST_KEY_LABEL.len() + 1 + jwt_secret.len());
    input.extend_from_slice(HOSTED_OAUTH_REQUEST_KEY_LABEL.as_bytes());
    input.push(0);
    input.extend_from_slice(jwt_secret.as_bytes());
    momo_wire::sha256_hex(&input)
}

/// The validated authorization request, carried to the consent surface as one
/// opaque signed string.
///
/// It is signed rather than stored because `GET /v1/oauth/authorize` is
/// unauthenticated: a DB row per arriving browser would be an unauthenticated
/// write. The nonce below is what a decision is later keyed on, so exactly one
/// terminal decision per envelope survives regardless of how many times the
/// consent screen is submitted.
///
/// **Nothing secret is inside.** The code challenge is a public PKCE value, the
/// state is the client's own, and there is no verifier, code or token here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostedOauthRequestClaims {
    /// Server-minted nonce; the uniqueness key of the terminal decision.
    pub jti: String,
    /// Pre-registered public client.
    pub cid: String,
    /// The exact registered redirect URI this request named.
    pub ru: String,
    /// RFC 8707 resource; always the canonical Agent Port.
    pub res: String,
    /// Requested scopes, already intersected with the hosted ceiling.
    pub scp: Vec<String>,
    /// PKCE challenge (S256 only; the method is implied by `ccm`).
    pub cc: String,
    pub ccm: String,
    /// Client state, echoed once into the redirect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub st: Option<String>,
    pub exp: usize,
    pub iat: usize,
    pub typ: String,
}

/// The already-validated material one authorization request envelope carries.
///
/// A struct rather than eight positional arguments because five of them are
/// `&str` and three of those — client id, redirect URI, resource — are exactly
/// the values whose transposition would be a security bug that still compiles.
#[derive(Debug, Clone, Copy)]
pub struct AuthorizationRequestSeed<'a> {
    pub nonce: Uuid,
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub resource: &'a str,
    pub scopes: &'a [String],
    pub code_challenge: &'a str,
    pub code_challenge_method: &'a str,
    pub state: Option<&'a str>,
}

/// Sign one validated authorization request.
pub fn sign_authorization_request(
    key: &str,
    seed: AuthorizationRequestSeed<'_>,
    now_seconds: i64,
) -> Result<String, AuthError> {
    let claims = HostedOauthRequestClaims {
        jti: seed.nonce.to_string(),
        cid: seed.client_id.to_string(),
        ru: seed.redirect_uri.to_string(),
        res: seed.resource.to_string(),
        scp: seed.scopes.to_vec(),
        cc: seed.code_challenge.to_string(),
        ccm: seed.code_challenge_method.to_string(),
        st: seed.state.map(str::to_string),
        iat: now_seconds.max(0) as usize,
        exp: (now_seconds + HOSTED_OAUTH_REQUEST_TTL_SECONDS).max(0) as usize,
        typ: HOSTED_OAUTH_REQUEST_TYP.to_string(),
    };
    let mut header = Header::new(Algorithm::HS256);
    header.kid = Some(HOSTED_OAUTH_REQUEST_KID.to_string());
    encode(&header, &claims, &EncodingKey::from_secret(key.as_bytes()))
        .map_err(AuthError::InvalidToken)
}

/// Verify one presented authorization request envelope.
pub fn verify_authorization_request(
    key: &str,
    presented: &str,
) -> Result<HostedOauthRequestClaims, AuthError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = HOSTED_OAUTH_REQUEST_LEEWAY_SECONDS;
    validation.required_spec_claims.clear();
    validation.validate_aud = false;
    let claims = decode::<HostedOauthRequestClaims>(
        presented,
        &DecodingKey::from_secret(key.as_bytes()),
        &validation,
    )
    .map_err(AuthError::InvalidToken)?
    .claims;
    if claims.typ != HOSTED_OAUTH_REQUEST_TYP {
        return Err(AuthError::NotAccessToken);
    }
    if Uuid::parse_str(&claims.jti).is_err() {
        return Err(AuthError::MalformedClaims);
    }
    Ok(claims)
}

/// Mint one workspace-carrying opaque credential.
///
/// The workspace travels in the envelope for exactly the reason it does in the
/// static agent bearer ([`crate::agent_bearer`]): the API role is NOBYPASSRLS,
/// so the tenant GUC has to be set before the row can be found, and the only
/// pre-authentication source of that value is the credential itself. Nothing
/// else is read from it.
fn mint_envelope(prefix: &str, workspace_id: Uuid) -> Result<String, sqlx::Error> {
    let mut secret = [0_u8; SECRET_BYTES];
    getrandom::getrandom(&mut secret)
        .map_err(|_| sqlx::Error::Protocol("credential entropy unavailable".to_string()))?;
    Ok(format!(
        "{prefix}.{}.{}",
        workspace_id.to_string().to_ascii_lowercase(),
        URL_SAFE_NO_PAD.encode(secret)
    ))
}

fn envelope_workspace_id(raw: &str, prefix: &str) -> Option<Uuid> {
    let mut parts = raw.split('.');
    let presented_prefix = parts.next()?;
    let workspace = parts.next()?;
    let secret = parts.next()?;
    if presented_prefix != prefix
        || parts.next().is_some()
        || secret.chars().count() < MINIMUM_SECRET_CHARS
        || !secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    Uuid::parse_str(workspace).ok()
}

/// The workspace an OAuth **access** credential claims, or `None` when the
/// string is not one. Returning `None` is what keeps the Agent Port's credential
/// dispatch total and keeps an OAuth token out of the static branch.
pub fn hosted_oauth_access_workspace_id(raw: &str) -> Option<Uuid> {
    envelope_workspace_id(raw, HOSTED_OAUTH_ACCESS_PREFIX)
}

/// The workspace an OAuth **refresh** credential claims.
pub fn hosted_oauth_refresh_workspace_id(raw: &str) -> Option<Uuid> {
    envelope_workspace_id(raw, HOSTED_OAUTH_REFRESH_PREFIX)
}

/// The workspace an **authorization code** claims.
pub fn hosted_oauth_code_workspace_id(raw: &str) -> Option<Uuid> {
    envelope_workspace_id(raw, HOSTED_OAUTH_CODE_PREFIX)
}

/// One connection a resource owner may bind an authorization request to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedOauthCandidate {
    pub connection_id: Uuid,
    pub agent_member_id: Uuid,
    pub agent_display_name: String,
    pub created_at_ms: i64,
}

/// The approval's one-time output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedOauthApproval {
    pub request_id: Uuid,
    pub connection_id: Uuid,
    pub authorization_code: String,
    pub code_expires_at_ms: i64,
}

/// The token endpoint's one-time output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedOauthIssuance {
    pub connection_id: Uuid,
    pub agent_member_id: Uuid,
    pub access_token: String,
    pub access_token_id: Uuid,
    pub refresh_token: String,
    pub refresh_token_id: Uuid,
    pub scopes: Vec<String>,
    pub expires_in_seconds: i64,
}

/// A locked authorization code row, before the caller checks PKCE.
///
/// The row and its connection are already held `FOR UPDATE` when this returns,
/// which is what lets the PKCE comparison happen in Rust — where the SHA-256 is
/// — without opening a window between the check and the consume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedOauthCodeLock {
    pub request_id: Uuid,
    pub connection_id: Uuid,
    pub agent_member_id: Uuid,
    pub client_id: String,
    pub redirect_uri: String,
    pub resource: String,
    pub approved_scopes: Vec<String>,
    pub code_challenge: String,
    pub status: String,
    pub expired: bool,
    pub connection_status: String,
}

/// Why an OAuth ledger mutation refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostedOauthRefusal {
    /// No such row, or it named something outside this tenant.
    NotFound,
    /// The connection is not a `pairing_pending` OAuth connection.
    WrongState,
    /// A decision for this request nonce already exists. Exactly one terminal
    /// decision per authorization request, so a second click is inert.
    AlreadyDecided,
    /// The approved scopes are not a live subset of the requested ones.
    InvalidApproval,
    /// The dedicated agent identity is gone.
    Expired,
}

/// The eligible OAuth connections in this workspace: `pairing_pending`,
/// `auth_mode='oauth'`, with a live dedicated sentinel.
pub async fn list_oauth_candidates_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Vec<HostedOauthCandidate>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT hc.id AS connection_id, hc.agent_member_id, m.display_name, \
                (EXTRACT(EPOCH FROM hc.created_at) * 1000)::bigint AS created_at_ms \
           FROM hosted_agent_connection hc \
           JOIN member m ON m.workspace_id = hc.workspace_id AND m.id = hc.agent_member_id \
          WHERE hc.workspace_id = $1 AND hc.status = 'pairing_pending' \
            AND hc.auth_mode = 'oauth' \
            AND m.kind = 'agent' AND m.status = 'active' AND m.deleted_at IS NULL \
          ORDER BY hc.created_at DESC, hc.id DESC LIMIT 50",
    )
    .bind(workspace_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(HostedOauthCandidate {
                connection_id: row.try_get("connection_id")?,
                agent_member_id: row.try_get("agent_member_id")?,
                agent_display_name: row.try_get("display_name")?,
                created_at_ms: row.try_get("created_at_ms")?,
            })
        })
        .collect()
}

/// Record the resource owner's **approval** and mint the authorization code.
///
/// One transaction closes all of it: the terminal decision row, the channel
/// memberships the human approved, the connection's `pairing_pending →
/// detected` transition with the consenting human recorded, and the code digest.
/// Lock order is the hosted canon — connection → token → member → membership →
/// profile — so this cannot form a cycle with the inbox or tool paths.
#[allow(clippy::too_many_arguments)]
pub async fn approve_hosted_oauth_request_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    actor_member_id: Uuid,
    claims: &HostedOauthRequestClaims,
    approved_scopes: &[String],
    approved_channel_ids: &[Uuid],
) -> Result<Result<HostedOauthApproval, HostedOauthRefusal>, sqlx::Error> {
    if approved_scopes.is_empty()
        || !approved_scopes
            .iter()
            .all(|scope| claims.scp.iter().any(|requested| requested == scope))
        || !approved_scopes
            .iter()
            .any(|scope| scope == "agent:port:connect")
    {
        return Ok(Err(HostedOauthRefusal::InvalidApproval));
    }
    let nonce = match Uuid::parse_str(&claims.jti) {
        Ok(nonce) => nonce,
        Err(_) => return Ok(Err(HostedOauthRefusal::NotFound)),
    };

    let locked: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT agent_member_id, status::text FROM hosted_agent_connection \
          WHERE workspace_id = $1 AND id = $2 AND auth_mode = 'oauth' FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((agent_member_id, status)) = locked else {
        return Ok(Err(HostedOauthRefusal::NotFound));
    };
    if status != "pairing_pending" {
        return Ok(Err(HostedOauthRefusal::WrongState));
    }
    if !hosted_identity_is_live_in_tx(conn, workspace_id, agent_member_id).await? {
        return Ok(Err(HostedOauthRefusal::Expired));
    }

    // Every approved channel must be a live, non-DM channel of this workspace.
    // Counting first keeps the membership insert all-or-nothing.
    let valid_channels: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM unnest($2::uuid[]) channel_id \
          WHERE EXISTS (SELECT 1 FROM channel c WHERE c.workspace_id = $1 AND c.id = channel_id \
                          AND c.archived_at IS NULL AND c.kind <> 'dm')",
    )
    .bind(workspace_id)
    .bind(approved_channel_ids)
    .fetch_one(&mut *conn)
    .await?;
    if valid_channels != approved_channel_ids.len() as i64 {
        return Ok(Err(HostedOauthRefusal::InvalidApproval));
    }

    let raw_code = mint_envelope(HOSTED_OAUTH_CODE_PREFIX, workspace_id)?;
    let inserted = sqlx::query(
        "INSERT INTO hosted_oauth_authorization_request \
           (workspace_id, hosted_connection_id, agent_member_id, request_nonce, client_id, \
            redirect_uri, resource, requested_scopes, approved_scopes, code_challenge, \
            code_challenge_method, client_state, status, decided_by, code_hash, code_expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'approved', $13, \
                 digest($14::text, 'sha256'), now() + ($15::bigint * interval '1 second')) \
         ON CONFLICT (workspace_id, request_nonce) DO NOTHING \
         RETURNING id, (EXTRACT(EPOCH FROM code_expires_at) * 1000)::bigint AS code_expires_at_ms",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(agent_member_id)
    .bind(nonce)
    .bind(&claims.cid)
    .bind(&claims.ru)
    .bind(&claims.res)
    .bind(&claims.scp)
    .bind(approved_scopes)
    .bind(&claims.cc)
    .bind(&claims.ccm)
    .bind(claims.st.as_deref())
    .bind(actor_member_id)
    .bind(&raw_code)
    .bind(HOSTED_OAUTH_CODE_TTL_SECONDS)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(inserted) = inserted else {
        return Ok(Err(HostedOauthRefusal::AlreadyDecided));
    };

    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         SELECT $1, channel_id, $2, 'member' FROM unnest($3::uuid[]) channel_id \
         ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL \
           WHERE membership.workspace_id = EXCLUDED.workspace_id",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(approved_channel_ids)
    .execute(&mut *conn)
    .await?;

    let advanced = sqlx::query(
        "UPDATE hosted_agent_connection \
            SET status = 'detected', detected_at = now(), detected_by = agent_member_id, \
                confirmed_by = $3, confirmed_at = now(), approved_channel_ids = $4, \
                approved_scopes = $5, updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 AND status = 'pairing_pending' \
            AND auth_mode = 'oauth'",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(actor_member_id)
    .bind(approved_channel_ids)
    .bind(approved_scopes)
    .execute(&mut *conn)
    .await?;
    if advanced.rows_affected() != 1 {
        // The connection moved under the lock. Failing the whole transaction is
        // the only outcome that cannot leave a live code for a connection that
        // never reached `detected`.
        return Err(sqlx::Error::RowNotFound);
    }

    Ok(Ok(HostedOauthApproval {
        request_id: inserted.try_get("id")?,
        connection_id,
        authorization_code: raw_code,
        code_expires_at_ms: inserted.try_get("code_expires_at_ms")?,
    }))
}

/// Record the resource owner's **denial**.
///
/// A denial is a terminal decision keyed on the same nonce as an approval, so a
/// deny that lands first makes a later approve inert and vice versa. The
/// connection is not advanced: a denied request leaves `pairing_pending`
/// exactly as it was, with no credential and no membership.
pub async fn deny_hosted_oauth_request_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    actor_member_id: Uuid,
    claims: &HostedOauthRequestClaims,
) -> Result<Result<Uuid, HostedOauthRefusal>, sqlx::Error> {
    let nonce = match Uuid::parse_str(&claims.jti) {
        Ok(nonce) => nonce,
        Err(_) => return Ok(Err(HostedOauthRefusal::NotFound)),
    };
    let locked: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT agent_member_id, status::text FROM hosted_agent_connection \
          WHERE workspace_id = $1 AND id = $2 AND auth_mode = 'oauth' FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((agent_member_id, status)) = locked else {
        return Ok(Err(HostedOauthRefusal::NotFound));
    };
    if status != "pairing_pending" {
        return Ok(Err(HostedOauthRefusal::WrongState));
    }
    let inserted: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO hosted_oauth_authorization_request \
           (workspace_id, hosted_connection_id, agent_member_id, request_nonce, client_id, \
            redirect_uri, resource, requested_scopes, code_challenge, code_challenge_method, \
            client_state, status, decided_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'denied', $12) \
         ON CONFLICT (workspace_id, request_nonce) DO NOTHING RETURNING id",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(agent_member_id)
    .bind(nonce)
    .bind(&claims.cid)
    .bind(&claims.ru)
    .bind(&claims.res)
    .bind(&claims.scp)
    .bind(&claims.cc)
    .bind(&claims.ccm)
    .bind(claims.st.as_deref())
    .bind(actor_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    match inserted {
        Some(id) => Ok(Ok(id)),
        None => Ok(Err(HostedOauthRefusal::AlreadyDecided)),
    }
}

/// Lock one presented authorization code and its connection.
///
/// Returns the row whatever its state — `approved`, already `consumed`, or past
/// its expiry — because the caller has to tell a replay (which revokes the whole
/// family) from a first use.
pub async fn lock_hosted_oauth_code_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    raw_code: &str,
) -> Result<Option<HostedOauthCodeLock>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT r.id AS request_id, r.hosted_connection_id, r.agent_member_id, r.client_id, \
                r.redirect_uri, r.resource, r.approved_scopes, r.code_challenge, \
                r.status::text AS status, \
                (r.code_expires_at IS NULL OR r.code_expires_at <= now()) AS expired, \
                hc.status::text AS connection_status \
           FROM hosted_agent_connection hc \
           JOIN hosted_oauth_authorization_request r \
             ON r.workspace_id = hc.workspace_id AND r.hosted_connection_id = hc.id \
          WHERE r.workspace_id = $1 AND r.code_hash = digest($2::text, 'sha256') \
          FOR UPDATE OF hc, r",
    )
    .bind(workspace_id)
    .bind(raw_code)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(HostedOauthCodeLock {
        request_id: row.try_get("request_id")?,
        connection_id: row.try_get("hosted_connection_id")?,
        agent_member_id: row.try_get("agent_member_id")?,
        client_id: row.try_get("client_id")?,
        redirect_uri: row.try_get("redirect_uri")?,
        resource: row.try_get("resource")?,
        approved_scopes: row.try_get("approved_scopes")?,
        code_challenge: row.try_get("code_challenge")?,
        status: row.try_get("status")?,
        expired: row.try_get("expired")?,
        connection_status: row.try_get("connection_status")?,
    }))
}

/// Consume the locked code and mint the pair it buys, activating the connection.
///
/// This is the OAuth arm of ADR-0162 D6's `detected → active`: the proof is the
/// client's possession of the PKCE verifier (already checked by the caller under
/// this lock), the audience is re-asserted in SQL, and the dedicated agent's
/// unpause commits with the same statement sequence. Nothing here can produce a
/// static credential.
pub async fn consume_hosted_oauth_code_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    locked: &HostedOauthCodeLock,
) -> Result<Option<HostedOauthIssuance>, sqlx::Error> {
    if !hosted_identity_is_live_in_tx(conn, workspace_id, locked.agent_member_id).await? {
        return Ok(None);
    }
    let raw_access = mint_envelope(HOSTED_OAUTH_ACCESS_PREFIX, workspace_id)?;
    let raw_refresh = mint_envelope(HOSTED_OAUTH_REFRESH_PREFIX, workspace_id)?;

    let access_token_id: Uuid = insert_oauth_credential(
        conn,
        workspace_id,
        locked.agent_member_id,
        locked.connection_id,
        locked.request_id,
        &locked.client_id,
        &locked.approved_scopes,
        "hosted_oauth_access",
        &raw_access,
        HOSTED_OAUTH_ACCESS_TTL_SECONDS,
        None,
    )
    .await?;
    let refresh_token_id: Uuid = insert_oauth_credential(
        conn,
        workspace_id,
        locked.agent_member_id,
        locked.connection_id,
        locked.request_id,
        &locked.client_id,
        &locked.approved_scopes,
        "hosted_oauth_refresh",
        &raw_refresh,
        HOSTED_OAUTH_REFRESH_TTL_SECONDS,
        None,
    )
    .await?;

    let consumed = sqlx::query(
        "UPDATE hosted_oauth_authorization_request \
            SET status = 'consumed', code_consumed_at = now(), access_token_id = $3, \
                refresh_token_id = $4, updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 AND status = 'approved' \
            AND code_consumed_at IS NULL",
    )
    .bind(workspace_id)
    .bind(locked.request_id)
    .bind(access_token_id)
    .bind(refresh_token_id)
    .execute(&mut *conn)
    .await?;
    if consumed.rows_affected() != 1 {
        return Err(sqlx::Error::RowNotFound);
    }

    let activated = sqlx::query(
        "UPDATE hosted_agent_connection \
            SET status = 'active', active_token_id = $3, proved_at = now(), \
                proved_by = agent_member_id, updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 AND status = 'detected' \
            AND auth_mode = 'oauth' AND audience = $4",
    )
    .bind(workspace_id)
    .bind(locked.connection_id)
    .bind(access_token_id)
    .bind(HOSTED_AGENT_PORT_AUDIENCE)
    .execute(&mut *conn)
    .await?;
    if activated.rows_affected() != 1 {
        return Err(sqlx::Error::RowNotFound);
    }
    let unpaused = sqlx::query(
        "UPDATE agent_profile SET paused = false, version = version + 1, updated_at = now() \
          WHERE workspace_id = $1 AND agent_member_id = $2",
    )
    .bind(workspace_id)
    .bind(locked.agent_member_id)
    .execute(&mut *conn)
    .await?;
    if unpaused.rows_affected() != 1 {
        return Err(sqlx::Error::RowNotFound);
    }

    Ok(Some(HostedOauthIssuance {
        connection_id: locked.connection_id,
        agent_member_id: locked.agent_member_id,
        access_token: raw_access,
        access_token_id,
        refresh_token: raw_refresh,
        refresh_token_id,
        scopes: locked.approved_scopes.clone(),
        expires_in_seconds: HOSTED_OAUTH_ACCESS_TTL_SECONDS,
    }))
}

#[allow(clippy::too_many_arguments)]
async fn insert_oauth_credential(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    connection_id: Uuid,
    request_id: Uuid,
    client_id: &str,
    scopes: &[String],
    credential_class: &str,
    raw: &str,
    ttl_seconds: i64,
    rotated_from: Option<Uuid>,
) -> Result<Uuid, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO token (workspace_id, actor_member_id, kind, token_hash, scopes, label, \
                            credential_class, hosted_connection_id, audience, expires_at, \
                            oauth_client_id, oauth_request_id, oauth_rotated_from_token_id) \
         VALUES ($1, $2, 'agent_bearer', digest($3::text, 'sha256'), $4, 'hosted agent port oauth', \
                 $5, $6, $7, now() + ($8::bigint * interval '1 second'), $9, $10, $11) \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(raw)
    .bind(scopes)
    .bind(credential_class)
    .bind(connection_id)
    .bind(HOSTED_AGENT_PORT_AUDIENCE)
    .bind(ttl_seconds)
    .bind(client_id)
    .bind(request_id)
    .bind(rotated_from)
    .fetch_one(&mut *conn)
    .await
}

/// What a presented refresh credential resolved to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostedOauthRefresh {
    Rotated(Box<HostedOauthIssuance>),
    /// The credential is real but already rotated away or revoked. Treated as a
    /// compromise signal: the whole family is revoked before this returns. The
    /// connection and dedicated member travel with it so the caller's replay
    /// audit can name the same subject/target the code-replay audit does —
    /// neither is secret.
    Reused {
        connection_id: Uuid,
        agent_member_id: Uuid,
    },
    /// Past `expires_at`, or its connection is no longer active.
    Invalid,
    Unknown,
}

/// Rotate one refresh credential into a fresh access/refresh pair.
///
/// Rotation is enforced by the partial unique indexes rather than by care: the
/// old pair must be revoked in this transaction or the inserts violate
/// `token_one_live_hosted_connection_credential` /
/// `token_one_live_hosted_oauth_refresh`.
pub async fn rotate_hosted_oauth_refresh_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    raw_refresh: &str,
    client_id: &str,
) -> Result<HostedOauthRefresh, sqlx::Error> {
    let row = sqlx::query(
        "SELECT t.id, t.actor_member_id, t.scopes, t.oauth_client_id, t.oauth_request_id, \
                t.hosted_connection_id, t.revoked_at IS NOT NULL AS revoked, \
                (t.expires_at IS NOT NULL AND t.expires_at <= now()) AS expired, \
                hc.status::text AS connection_status \
           FROM hosted_agent_connection hc \
           JOIN token t ON t.workspace_id = hc.workspace_id AND t.hosted_connection_id = hc.id \
          WHERE t.workspace_id = $1 AND t.token_hash = digest($2::text, 'sha256') \
            AND t.kind = 'agent_bearer' AND t.credential_class = 'hosted_oauth_refresh' \
            AND t.audience = $3 \
          FOR UPDATE OF hc, t",
    )
    .bind(workspace_id)
    .bind(raw_refresh)
    .bind(HOSTED_AGENT_PORT_AUDIENCE)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(HostedOauthRefresh::Unknown);
    };
    let connection_id: Uuid = row.try_get("hosted_connection_id")?;
    // A client id mismatch is answered as `Unknown` rather than as a distinct
    // error so the token endpoint is not an oracle for which client a
    // credential belongs to.
    if row
        .try_get::<Option<String>, _>("oauth_client_id")?
        .as_deref()
        != Some(client_id)
    {
        return Ok(HostedOauthRefresh::Unknown);
    }
    if row.try_get::<bool, _>("revoked")? {
        revoke_hosted_oauth_family_in_tx(conn, workspace_id, connection_id).await?;
        return Ok(HostedOauthRefresh::Reused {
            connection_id,
            agent_member_id: row.try_get("actor_member_id")?,
        });
    }
    if row.try_get::<bool, _>("expired")?
        || row.try_get::<String, _>("connection_status")? != "active"
    {
        return Ok(HostedOauthRefresh::Invalid);
    }
    let agent_member_id: Uuid = row.try_get("actor_member_id")?;
    if !hosted_identity_is_live_in_tx(conn, workspace_id, agent_member_id).await? {
        return Ok(HostedOauthRefresh::Invalid);
    }
    let previous_refresh_id: Uuid = row.try_get("id")?;
    let scopes: Vec<String> = row.try_get("scopes")?;
    let request_id: Uuid = row
        .try_get::<Option<Uuid>, _>("oauth_request_id")?
        .ok_or(sqlx::Error::RowNotFound)?;

    // Old pair first. The unique indexes make this ordering mandatory rather
    // than stylistic.
    sqlx::query(
        "UPDATE token SET revoked_at = COALESCE(revoked_at, now()) \
          WHERE workspace_id = $1 AND hosted_connection_id = $2 \
            AND credential_class IN ('hosted_oauth_access','hosted_oauth_refresh') \
            AND revoked_at IS NULL",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .execute(&mut *conn)
    .await?;

    let raw_access = mint_envelope(HOSTED_OAUTH_ACCESS_PREFIX, workspace_id)?;
    let raw_refresh_next = mint_envelope(HOSTED_OAUTH_REFRESH_PREFIX, workspace_id)?;
    let access_token_id = insert_oauth_credential(
        conn,
        workspace_id,
        agent_member_id,
        connection_id,
        request_id,
        client_id,
        &scopes,
        "hosted_oauth_access",
        &raw_access,
        HOSTED_OAUTH_ACCESS_TTL_SECONDS,
        Some(previous_refresh_id),
    )
    .await?;
    let refresh_token_id = insert_oauth_credential(
        conn,
        workspace_id,
        agent_member_id,
        connection_id,
        request_id,
        client_id,
        &scopes,
        "hosted_oauth_refresh",
        &raw_refresh_next,
        HOSTED_OAUTH_REFRESH_TTL_SECONDS,
        Some(previous_refresh_id),
    )
    .await?;
    let rebound = sqlx::query(
        "UPDATE hosted_agent_connection SET active_token_id = $3, updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 AND status = 'active' AND auth_mode = 'oauth'",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(access_token_id)
    .execute(&mut *conn)
    .await?;
    if rebound.rows_affected() != 1 {
        return Err(sqlx::Error::RowNotFound);
    }

    Ok(HostedOauthRefresh::Rotated(Box::new(HostedOauthIssuance {
        connection_id,
        agent_member_id,
        access_token: raw_access,
        access_token_id,
        refresh_token: raw_refresh_next,
        refresh_token_id,
        scopes,
        expires_in_seconds: HOSTED_OAUTH_ACCESS_TTL_SECONDS,
    })))
}

/// Revoke every live OAuth credential on one connection.
///
/// Used by RFC 7009 revocation and by refresh-reuse detection. It deliberately
/// does not touch the connection's state: the next Agent Port call finds an
/// `active` connection whose own credential is dead and takes HAP-E6's
/// reconciliation path, which is the one place that transition is written.
pub async fn revoke_hosted_oauth_family_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
) -> Result<u64, sqlx::Error> {
    let revoked = sqlx::query(
        "UPDATE token SET revoked_at = COALESCE(revoked_at, now()) \
          WHERE workspace_id = $1 AND hosted_connection_id = $2 \
            AND credential_class IN ('hosted_oauth_access','hosted_oauth_refresh') \
            AND revoked_at IS NULL",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .execute(&mut *conn)
    .await?;
    Ok(revoked.rows_affected())
}

/// RFC 7009: resolve a presented credential to its connection so the family can
/// be revoked. Returns `None` for anything unknown — the revocation endpoint
/// answers 200 either way, so this is never an existence oracle.
pub async fn resolve_hosted_oauth_revocation_target_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    raw_token: &str,
    client_id: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT hosted_connection_id FROM token \
          WHERE workspace_id = $1 AND token_hash = digest($2::text, 'sha256') \
            AND kind = 'agent_bearer' \
            AND credential_class IN ('hosted_oauth_access','hosted_oauth_refresh') \
            AND oauth_client_id = $3 AND audience = $4 \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(raw_token)
    .bind(client_id)
    .bind(HOSTED_AGENT_PORT_AUDIENCE)
    .fetch_optional(&mut *conn)
    .await
}

/// Resolve one presented OAuth **access** credential for the Agent Port.
///
/// Deliberately returns [`crate::AgentBearerResolution`], the same type the
/// static bearer resolves to, so the Agent Port's admission path has exactly one
/// shape of decision to handle — including the HAP-E6 reconciliation branch for
/// a dead credential. What is NOT shared is the lookup: this one matches only
/// `hosted_oauth_access`, so no amount of re-labelling turns a static bearer,
/// a refresh credential, an authorization code or a human JWT into one.
pub async fn resolve_hosted_oauth_access_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    raw_token: &str,
    required_scope: &str,
) -> Result<crate::AgentBearerResolution, sqlx::Error> {
    let row = sqlx::query(
        "SELECT t.id, t.actor_member_id, t.scopes, t.hosted_connection_id, t.audience, \
                t.revoked_at IS NOT NULL AS revoked, \
                (t.expires_at IS NOT NULL AND t.expires_at <= now()) AS expired \
           FROM token t \
          WHERE t.workspace_id = $1 \
            AND t.kind = 'agent_bearer' \
            AND t.subject_member_id IS NULL \
            AND t.credential_class = 'hosted_oauth_access' \
            AND t.audience = $3 \
            AND t.token_hash = digest($2::text, 'sha256') \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(raw_token)
    .bind(HOSTED_AGENT_PORT_AUDIENCE)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(crate::AgentBearerResolution::Unknown);
    };
    if row.try_get::<bool, _>("revoked")? {
        return Ok(crate::AgentBearerResolution::Revoked);
    }
    if row.try_get::<bool, _>("expired")? {
        return Ok(crate::AgentBearerResolution::Expired);
    }
    let scopes: Vec<String> = row.try_get("scopes")?;
    let scope_granted = scopes.iter().any(|scope| scope == required_scope);
    Ok(crate::AgentBearerResolution::Active {
        identity: crate::AgentBearerIdentity {
            token_id: row.try_get("id")?,
            member_id: row.try_get("actor_member_id")?,
            workspace_id,
            scopes,
            hosted_connection_id: row.try_get("hosted_connection_id")?,
            audience: row.try_get("audience")?,
        },
        scope_granted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims() -> HostedOauthRequestClaims {
        HostedOauthRequestClaims {
            jti: Uuid::from_u128(7).to_string(),
            cid: "oort-test-client".to_string(),
            ru: "https://client.example/cb".to_string(),
            res: "https://oort.example/v1/mcp/agent-port".to_string(),
            scp: vec!["agent:port:connect".to_string()],
            cc: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".to_string(),
            ccm: "S256".to_string(),
            st: Some("xyz".to_string()),
            iat: 1_000,
            exp: 1_600,
            typ: HOSTED_OAUTH_REQUEST_TYP.to_string(),
        }
    }

    #[test]
    fn the_three_envelopes_do_not_accept_each_other() {
        let workspace = Uuid::from_u128(11);
        let code = mint_envelope(HOSTED_OAUTH_CODE_PREFIX, workspace).unwrap();
        let access = mint_envelope(HOSTED_OAUTH_ACCESS_PREFIX, workspace).unwrap();
        let refresh = mint_envelope(HOSTED_OAUTH_REFRESH_PREFIX, workspace).unwrap();
        assert_eq!(hosted_oauth_code_workspace_id(&code), Some(workspace));
        assert_eq!(hosted_oauth_access_workspace_id(&access), Some(workspace));
        assert_eq!(hosted_oauth_refresh_workspace_id(&refresh), Some(workspace));
        assert_eq!(hosted_oauth_access_workspace_id(&code), None);
        assert_eq!(hosted_oauth_access_workspace_id(&refresh), None);
        assert_eq!(hosted_oauth_code_workspace_id(&access), None);
        assert_eq!(hosted_oauth_refresh_workspace_id(&access), None);
        // Neither the static agent bearer nor the pairing challenge is one.
        assert_eq!(
            hosted_oauth_access_workspace_id(&format!(
                "momo_agent_v1.{workspace}.{}",
                "a".repeat(43)
            )),
            None
        );
        assert_eq!(
            hosted_oauth_access_workspace_id(&format!(
                "momo_pair_v1.{workspace}.{}",
                "a".repeat(43)
            )),
            None
        );
    }

    #[test]
    fn a_request_envelope_round_trips_and_refuses_a_foreign_key() {
        let key = hosted_oauth_request_key("jwt-secret");
        let other = hosted_oauth_request_key("another-secret");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let signed = sign_authorization_request(
            &key,
            AuthorizationRequestSeed {
                nonce: Uuid::from_u128(7),
                client_id: "oort-test-client",
                redirect_uri: "https://client.example/cb",
                resource: "https://oort.example/v1/mcp/agent-port",
                scopes: &["agent:port:connect".to_string()],
                code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                code_challenge_method: "S256",
                state: Some("xyz"),
            },
            now,
        )
        .unwrap();
        let verified = verify_authorization_request(&key, &signed).unwrap();
        assert_eq!(verified.jti, Uuid::from_u128(7).to_string());
        assert_eq!(verified.cid, "oort-test-client");
        assert_eq!(verified.st.as_deref(), Some("xyz"));
        assert!(verify_authorization_request(&other, &signed).is_err());
    }

    #[test]
    fn the_request_key_is_not_the_jwt_secret_and_is_domain_separated() {
        let secret = "jwt-secret";
        let request_key = hosted_oauth_request_key(secret);
        assert_ne!(request_key, secret);
        assert_ne!(
            request_key,
            crate::ephemeral_grant::ephemeral_grant_key(secret)
        );
    }

    #[test]
    fn an_expired_request_envelope_is_refused() {
        let key = hosted_oauth_request_key("jwt-secret");
        let signed = sign_authorization_request(
            &key,
            AuthorizationRequestSeed {
                nonce: Uuid::from_u128(7),
                client_id: "oort-test-client",
                redirect_uri: "https://client.example/cb",
                resource: "https://oort.example/v1/mcp/agent-port",
                scopes: &["agent:port:connect".to_string()],
                code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                code_challenge_method: "S256",
                state: None,
            },
            0,
        )
        .unwrap();
        assert!(verify_authorization_request(&key, &signed).is_err());
    }

    #[test]
    fn the_envelope_carries_no_secret_material() {
        let rendered = serde_json::to_string(&claims()).unwrap();
        for forbidden in ["verifier", "code_verifier", "secret", "token", "password"] {
            assert!(!rendered.contains(forbidden), "{forbidden} leaked");
        }
    }
}
