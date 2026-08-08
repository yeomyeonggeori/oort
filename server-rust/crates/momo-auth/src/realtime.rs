//! Centrifugo **connection** JWT issuance (B4).
//!
//! Ports Swift `JWTService.signCentrifugoConnection` (`Auth/JWT.swift:156-200`)
//! claim-for-claim, because Centrifugo verifies this token with the *same* HMAC
//! secret regardless of which server minted it: a claim this crate spells
//! differently is a connection the broker rejects, or worse, accepts with the
//! wrong identity.
//!
//! Three properties are load bearing and none of them is cosmetic:
//!
//! 1. **A different key from the App JWT.** Swift registers two HMAC keys under
//!    two kids (`app`, `cent`) and this signs with the `cent` one
//!    (`CENT_TOKEN_HMAC`). Signing a connection token with `JWT_HMAC` would hand
//!    Centrifugo a key that also verifies REST access tokens.
//! 2. **No channel authorization is embedded.** The token says *who is
//!    connecting*, never *what they may read*: `ch:`/`agent:`/`agentwork:`
//!    subscriptions are decided per-subscribe by the subscribe proxy against
//!    live membership under RLS. A token that carried channels would keep an
//!    evicted member subscribed for the rest of its TTL.
//! 3. **`meta.token_id` binds the connection to the credential that minted it.**
//!    The proxy re-checks that row on every subscribe, which is what makes a
//!    logout cut off *new* subscriptions immediately rather than at token
//!    expiry.
//!
//! The `info` claim is a JSON **string** (not an object) because that is what
//! Swift emits and what Centrifugo passes through verbatim as client info. It is
//! rendered with sorted keys — `member_id`, `schema`, `workspace_id` — matching
//! Swift's `JSONEncoder.outputFormatting = [.sortedKeys]` byte for byte.

use std::time::{SystemTime, UNIX_EPOCH};

use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::jwt::AuthError;

/// Swift `RealtimeTokenInfo.schema`.
pub const REALTIME_INFO_SCHEMA: &str = "momo.realtime.connection.v0";
/// Swift `RealtimeTokenMeta.schema`.
pub const REALTIME_META_SCHEMA: &str = "momo.realtime.credential.v1";
/// Swift `Config.centConnectionTokenTTL` default (`CENT_CONNECTION_TOKEN_TTL_SECONDS`, 5m).
pub const CONNECTION_TOKEN_TTL_SECONDS: i64 = 5 * 60;
/// The `kid` Swift signs Centrifugo tokens under (`JWTService.centKID`).
const CENT_KID: &str = "cent";

/// Connection metadata forwarded to the subscribe proxy when
/// `include_connection_meta` is on (infra/centrifugo.json). Snake-cased on the
/// wire, like Swift's `CodingKeys`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RealtimeTokenMeta {
    pub schema: String,
    #[serde(rename = "token_id")]
    pub token_id: String,
}

/// The `info` claim's payload. Field order IS the wire order here: Swift renders
/// it with `.sortedKeys`, so these are declared alphabetically.
#[derive(Debug, Serialize)]
struct RealtimeTokenInfo<'a> {
    member_id: &'a str,
    schema: &'a str,
    workspace_id: &'a str,
}

/// Centrifugo connection JWT claims (Swift `CentrifugoConnectionJWTPayload`).
#[derive(Debug, Serialize, Deserialize)]
pub struct CentrifugoConnectionClaims {
    /// Centrifugo's client user id = member_id.
    pub sub: String,
    pub exp: usize,
    pub iat: usize,
    /// momo's tenant boundary, carried for correlation only.
    pub ws: String,
    /// JSON **string**, not an object (Swift encodes it that way).
    pub info: String,
    pub meta: RealtimeTokenMeta,
}

/// A minted connection token plus the two numbers the response body reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedRealtimeToken {
    pub token: String,
    /// Expiry as unix **seconds** (the DTO renders milliseconds).
    pub expires_at: i64,
    pub ttl_seconds: i64,
}

fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// Render the `info` claim exactly as Swift does.
///
/// Exposed for the parity test; a caller has no reason to build this by hand.
pub fn realtime_info_string(member_id: Uuid, workspace_id: Uuid) -> String {
    // Swift renders UUIDs through `uuidString`, which is UPPERCASE. The relay
    // bakes the same casing into channel names, so lowercasing here would make
    // the connection info disagree with every channel string on the wire.
    let member = member_id.to_string().to_uppercase();
    let workspace = workspace_id.to_string().to_uppercase();
    let info = RealtimeTokenInfo {
        member_id: &member,
        schema: REALTIME_INFO_SCHEMA,
        workspace_id: &workspace,
    };
    // Infallible for this struct (three owned strings); a `to_string` fallback
    // would be dead code with a wrong shape, so the expect names the invariant.
    serde_json::to_string(&info).expect("RealtimeTokenInfo is always serializable")
}

/// Sign a short-lived Centrifugo connection token for an authenticated member.
///
/// `credential_token_id` is the `token.id` of the credential that authenticated
/// the request (a human's session access row, or an agent bearer row). The
/// subscribe proxy re-checks it, so passing anything else would let a revoked
/// credential borrow a live one's authority.
pub fn sign_centrifugo_connection(
    member_id: Uuid,
    workspace_id: Uuid,
    credential_token_id: Uuid,
    ttl_seconds: i64,
    cent_token_hmac: &str,
) -> Result<IssuedRealtimeToken, AuthError> {
    let issued_at = now_unix_seconds();
    let expires_at = issued_at + ttl_seconds;
    let claims = CentrifugoConnectionClaims {
        sub: member_id.to_string().to_uppercase(),
        exp: expires_at.max(0) as usize,
        iat: issued_at.max(0) as usize,
        ws: workspace_id.to_string().to_uppercase(),
        info: realtime_info_string(member_id, workspace_id),
        meta: RealtimeTokenMeta {
            schema: REALTIME_META_SCHEMA.to_string(),
            token_id: credential_token_id.to_string().to_uppercase(),
        },
    };
    let mut header = Header::new(Algorithm::HS256);
    header.kid = Some(CENT_KID.to_string());
    let token = encode(
        &header,
        &claims,
        &EncodingKey::from_secret(cent_token_hmac.as_bytes()),
    )?;
    Ok(IssuedRealtimeToken {
        token,
        expires_at,
        ttl_seconds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{decode, DecodingKey, Validation};

    fn decode_claims(token: &str, secret: &str) -> CentrifugoConnectionClaims {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_exp = true;
        decode::<CentrifugoConnectionClaims>(
            token,
            &DecodingKey::from_secret(secret.as_bytes()),
            &validation,
        )
        .expect("decode")
        .claims
    }

    #[test]
    fn the_info_claim_is_a_sorted_key_json_string() {
        let member = Uuid::from_u128(0x1111_2222_3333_4444_5555_6666_7777_8888);
        let workspace = Uuid::from_u128(0x9999_aaaa_bbbb_cccc_dddd_eeee_ffff_0000);
        let info = realtime_info_string(member, workspace);
        assert_eq!(
            info,
            format!(
                "{{\"member_id\":\"{}\",\"schema\":\"{REALTIME_INFO_SCHEMA}\",\"workspace_id\":\"{}\"}}",
                member.to_string().to_uppercase(),
                workspace.to_string().to_uppercase()
            ),
            "Swift encodes this with .sortedKeys; a reordering is a wire change"
        );
    }

    #[test]
    fn a_connection_token_carries_the_credential_binding() {
        let member = Uuid::new_v4();
        let workspace = Uuid::new_v4();
        let credential = Uuid::new_v4();
        let issued = sign_centrifugo_connection(
            member,
            workspace,
            credential,
            CONNECTION_TOKEN_TTL_SECONDS,
            "cent-secret",
        )
        .expect("sign");
        let claims = decode_claims(&issued.token, "cent-secret");
        assert_eq!(claims.sub, member.to_string().to_uppercase());
        assert_eq!(claims.ws, workspace.to_string().to_uppercase());
        assert_eq!(claims.meta.schema, REALTIME_META_SCHEMA);
        assert_eq!(
            claims.meta.token_id,
            credential.to_string().to_uppercase(),
            "the proxy re-checks this row on every subscribe"
        );
        assert_eq!(issued.ttl_seconds, CONNECTION_TOKEN_TTL_SECONDS);
        assert!(issued.expires_at - now_unix_seconds() > CONNECTION_TOKEN_TTL_SECONDS - 5);
    }

    /// The two keys are different keys. Signing with the app secret and
    /// verifying with the Centrifugo secret must fail, or the broker would
    /// accept anything the REST server ever signed.
    #[test]
    fn the_app_secret_does_not_verify_a_connection_token() {
        let issued = sign_centrifugo_connection(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            60,
            "cent-secret",
        )
        .expect("sign");
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_exp = false;
        assert!(decode::<CentrifugoConnectionClaims>(
            &issued.token,
            &DecodingKey::from_secret(b"app-secret"),
            &validation,
        )
        .is_err());
    }

    #[test]
    fn the_header_names_the_cent_key() {
        let issued = sign_centrifugo_connection(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            60,
            "cent-secret",
        )
        .expect("sign");
        let header = jsonwebtoken::decode_header(&issued.token).expect("header");
        assert_eq!(header.kid.as_deref(), Some(CENT_KID));
        assert_eq!(header.alg, Algorithm::HS256);
    }
}
