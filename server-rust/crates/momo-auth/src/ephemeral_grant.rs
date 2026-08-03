//! The **휘발 신호 발행 권한(grant)** — ADR-0149's answer to the one row in its
//! invariant table marked 「주의」.
//!
//! > RLS FORCE | **주의** — PG를 안 거치므로 RLS가 격리를 강제해 주지 않는다.
//! > **채널 구독 권한 검사를 발행 시점에 직접 해야 한다.**
//!
//! That sentence and guard 3 (「휘발 경로 처리 중 쿼리 0건」) look like they
//! cannot both hold: the fact "is this member in this channel" lives in
//! Postgres, so checking it at publish time is a query. They reconcile only if
//! the publish-time check is a **verification** rather than a lookup — which is
//! what this module is.
//!
//! ```text
//! POST …/channels/{ch}/typing/grant   → ONE membership read (is_channel_member, under RLS) → a 60s grant
//! POST …/channels/{ch}/typing         → verify the grant  → publish            (Postgres: untouched)
//! ```
//!
//! ## Why this is not a weaker check than the query it replaces
//!
//! The grant is **not a bearer token.** The publish route sits behind the same
//! `require_principal` middleware as every other write, so a grant only does
//! anything in the hands of the member it was minted for, holding that member's
//! live App JWT. A stolen grant on its own is inert.
//!
//! What the grant does introduce is a *staleness window*: a member evicted from
//! a channel can still signal 「작성 중」 there until their grant expires. That
//! window is [`EPHEMERAL_GRANT_TTL_SECONDS`] = 60s, and it is **strictly
//! shorter than the eviction lag that already exists on the read side** — an
//! evicted member's Centrifugo subscription is only re-authorized when they
//! resubscribe (this server has no unsubscribe call), so they keep *receiving*
//! that channel's messages for longer than they can announce that they are
//! typing in it. The new window is therefore covered by the old one.
//!
//! ## Why the signing key is derived rather than reused
//!
//! Signed with a key derived from `JWT_HMAC`, not with `JWT_HMAC` itself and
//! **never** with `CENT_TOKEN_HMAC`:
//!
//! * `CENT_TOKEN_HMAC` is the key **Centrifugo holds**
//!   (`CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY`). A grant signed with it would
//!   be a valid Centrifugo *connection* token for its `sub`, which would let a
//!   leaked grant open the rail and read that member's `user:read-state#…`
//!   channel — Centrifugo authorizes user-limited channels itself, with no
//!   proxy callback to stop it.
//! * `JWT_HMAC` verbatim would work today only because `verify_app_access`
//!   rejects a foreign `typ`. Deriving a subkey means a grant is not a token in
//!   that family at all, so no future relaxation of a `typ` check can promote
//!   one into API access. The derivation is one-way, so a grant leak never
//!   reaches `JWT_HMAC`.

use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::jwt::AuthError;

/// The `typ` claim. Any other value is refused, so no other momo JWT can be
/// replayed here even if the keys were ever unified by mistake.
pub const EPHEMERAL_GRANT_TYP: &str = "momo.ephemeral.grant.v1";

/// How long a grant is good for.
///
/// 60s is the eviction window this credential opens (see the module docs), and
/// it is deliberately **shorter than the 300s connection-token default**: the
/// connection token says "this session is alive", which a logout revokes at the
/// next subscribe; a grant says "this member was in this channel", which
/// nothing revokes before expiry. The weaker statement gets the shorter life.
///
/// It also has to be long enough that a person typing a sentence does not
/// re-mint mid-thought: at a 3s republish cadence, one grant covers ~20
/// publishes.
pub const EPHEMERAL_GRANT_TTL_SECONDS: i64 = 60;

/// The `kid`, so a token's header names the key family that signed it.
const EPHEMERAL_GRANT_KID: &str = "eph";

/// The two TTL relationships this credential's safety argument rests on,
/// checked by the compiler rather than by a test that someone could delete:
///
/// * a grant asserts something **nothing can revoke**, while a connection token
///   asserts a session that a logout ends at the next subscribe — so the
///   unrevocable one must be the shorter-lived one;
/// * the clock-skew tolerance must be a rounding error against the TTL, not a
///   share of it (`jsonwebtoken`'s 60s default would have doubled a 60s grant).
const _: () = assert!(
    EPHEMERAL_GRANT_TTL_SECONDS < crate::realtime::CONNECTION_TOKEN_TTL_SECONDS,
    "a grant is unrevocable until expiry, so it must outlive nothing"
);
const _: () = assert!(
    (EPHEMERAL_GRANT_LEEWAY_SECONDS as i64) * 4 < EPHEMERAL_GRANT_TTL_SECONDS,
    "clock-skew tolerance must not be a meaningful share of the grant's life"
);

/// Clock skew tolerated on `exp`, in seconds.
///
/// `jsonwebtoken` defaults to **60**, which for a 60-second credential is not a
/// tolerance but a doubling. 5s is NTP drift between two api replicas, and it
/// keeps the real eviction window under `TTL + 5`.
const EPHEMERAL_GRANT_LEEWAY_SECONDS: u64 = 5;

/// Domain separator for the derived signing key.
const EPHEMERAL_GRANT_KEY_LABEL: &str = "momo.ephemeral.grant.v1.key";

/// Derive the grant signing key from the app JWT secret.
///
/// `SHA-256(label ‖ 0x00 ‖ secret)` — the secret goes **last** so the
/// construction is not length-extendable, and the label makes the output
/// unusable as any other momo key. One-way: a grant leak cannot walk back to
/// `JWT_HMAC`.
pub fn ephemeral_grant_key(jwt_secret: &str) -> String {
    let mut input = Vec::with_capacity(EPHEMERAL_GRANT_KEY_LABEL.len() + 1 + jwt_secret.len());
    input.extend_from_slice(EPHEMERAL_GRANT_KEY_LABEL.as_bytes());
    input.push(0);
    input.extend_from_slice(jwt_secret.as_bytes());
    momo_wire::sha256_hex(&input)
}

/// The claims a grant carries. Nothing here is optional: a grant that did not
/// name all three of member/workspace/channel would authorize more than the one
/// membership that was actually checked.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EphemeralGrantClaims {
    /// The member the membership read was performed for.
    pub sub: String,
    /// The tenant. Bound explicitly even though `ch` is globally unique, so a
    /// grant cannot outlive a channel being addressed under another workspace.
    pub ws: String,
    /// The channel the member was a live member of.
    pub ch: String,
    pub exp: usize,
    pub iat: usize,
    pub typ: String,
}

/// The triple a grant must match. A struct rather than three positional
/// arguments so a call site cannot silently transpose channel and workspace and
/// still compile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EphemeralGrantScope {
    pub member_id: Uuid,
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
}

/// A minted grant plus the two numbers the response reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedEphemeralGrant {
    pub token: String,
    /// Unix **seconds** (the DTO renders milliseconds).
    pub expires_at: i64,
    pub ttl_seconds: i64,
}

/// Why a presented grant was refused.
///
/// Split by cause rather than collapsed into one error because the two halves
/// mean different things to a client: [`Expired`](Self::Expired) and
/// [`Malformed`](Self::Malformed) mean *fetch a new grant*, while every
/// mismatch means *you are asking about a channel this grant was never for* and
/// re-fetching will not help.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EphemeralGrantRejection {
    /// Bad signature, wrong key, or not a JWT at all.
    Malformed,
    /// Valid signature, past `exp`.
    Expired,
    /// Not a grant (some other momo token presented here).
    WrongType,
    /// The grant names a different member than the authenticated caller.
    MemberMismatch,
    /// The grant names a different workspace.
    WorkspaceMismatch,
    /// The grant names a different channel.
    ChannelMismatch,
}

impl EphemeralGrantRejection {
    /// Client-safe wording. Deliberately says nothing about whether the channel
    /// exists or who is in it — the whole reason this check exists is that a
    /// 「작성 중」 leak is really a leak of *which channels exist and who is in
    /// them*.
    pub fn message(self) -> &'static str {
        match self {
            EphemeralGrantRejection::Malformed
            | EphemeralGrantRejection::Expired
            | EphemeralGrantRejection::WrongType => "ephemeral grant is invalid or expired",
            EphemeralGrantRejection::MemberMismatch
            | EphemeralGrantRejection::WorkspaceMismatch
            | EphemeralGrantRejection::ChannelMismatch => {
                "ephemeral grant does not cover this channel"
            }
        }
    }

    /// Whether fetching a fresh grant could plausibly succeed.
    pub fn is_renewable(self) -> bool {
        matches!(
            self,
            EphemeralGrantRejection::Malformed
                | EphemeralGrantRejection::Expired
                | EphemeralGrantRejection::WrongType
        )
    }
}

fn now_unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// Mint a grant. The caller **must** have just proved `scope`'s membership
/// against a live tenant transaction; this function performs no check of its
/// own and cannot — it holds no connection.
pub fn sign_ephemeral_grant(
    scope: EphemeralGrantScope,
    ttl_seconds: i64,
    grant_key: &str,
) -> Result<IssuedEphemeralGrant, AuthError> {
    let ttl_seconds = ttl_seconds.clamp(5, 300);
    let issued_at = now_unix_seconds();
    let expires_at = issued_at + ttl_seconds;
    let claims = EphemeralGrantClaims {
        sub: scope.member_id.to_string().to_uppercase(),
        ws: scope.workspace_id.to_string().to_uppercase(),
        ch: scope.channel_id.to_string().to_uppercase(),
        exp: expires_at.max(0) as usize,
        iat: issued_at.max(0) as usize,
        typ: EPHEMERAL_GRANT_TYP.to_string(),
    };
    let mut header = Header::new(Algorithm::HS256);
    header.kid = Some(EPHEMERAL_GRANT_KID.to_string());
    let token = encode(
        &header,
        &claims,
        &EncodingKey::from_secret(grant_key.as_bytes()),
    )?;
    Ok(IssuedEphemeralGrant {
        token,
        expires_at,
        ttl_seconds,
    })
}

/// Verify a presented grant **against the scope the request is actually
/// addressing**.
///
/// The expected scope is an argument rather than a return value on purpose:
/// there is no way to call this and forget to compare. A `verify(token) ->
/// claims` shape would let a handler decode a grant for channel A and then
/// publish to channel B, which is the exact failure this whole mechanism
/// exists to prevent.
pub fn verify_ephemeral_grant(
    token: &str,
    expected: EphemeralGrantScope,
    grant_key: &str,
) -> Result<(), EphemeralGrantRejection> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;
    // **`jsonwebtoken`'s default leeway is 60 seconds**, which would exactly
    // DOUBLE the life of a 60-second grant — the one number the whole eviction
    // argument rests on. Narrowed to [`EPHEMERAL_GRANT_LEEWAY_SECONDS`]: both
    // signer and verifier are momo-server processes, so the skew being tolerated
    // is NTP drift between replicas, not a user's device clock.
    validation.leeway = EPHEMERAL_GRANT_LEEWAY_SECONDS;
    let claims = decode::<EphemeralGrantClaims>(
        token,
        &DecodingKey::from_secret(grant_key.as_bytes()),
        &validation,
    )
    .map_err(|error| match error.kind() {
        jsonwebtoken::errors::ErrorKind::ExpiredSignature => EphemeralGrantRejection::Expired,
        _ => EphemeralGrantRejection::Malformed,
    })?
    .claims;

    if claims.typ != EPHEMERAL_GRANT_TYP {
        return Err(EphemeralGrantRejection::WrongType);
    }
    if !uuid_eq(&claims.sub, expected.member_id) {
        return Err(EphemeralGrantRejection::MemberMismatch);
    }
    if !uuid_eq(&claims.ws, expected.workspace_id) {
        return Err(EphemeralGrantRejection::WorkspaceMismatch);
    }
    if !uuid_eq(&claims.ch, expected.channel_id) {
        return Err(EphemeralGrantRejection::ChannelMismatch);
    }
    Ok(())
}

/// Compare a claim to an id by **parsing**, not by string equality: momo writes
/// uuids uppercase on the wire and lowercase in Postgres, and a casing-sensitive
/// comparison here would reject every legitimate grant on some future call site.
fn uuid_eq(claim: &str, expected: Uuid) -> bool {
    Uuid::parse_str(claim).is_ok_and(|parsed| parsed == expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> EphemeralGrantScope {
        EphemeralGrantScope {
            member_id: Uuid::from_u128(0x11),
            workspace_id: Uuid::from_u128(0x22),
            channel_id: Uuid::from_u128(0x33),
        }
    }

    fn key() -> String {
        ephemeral_grant_key("R7dGqk2mV9xPz1sLb4nJ8yTw3hCf6uEa")
    }

    #[test]
    fn a_grant_verifies_only_against_the_scope_it_was_minted_for() {
        let key = key();
        let issued =
            sign_ephemeral_grant(scope(), EPHEMERAL_GRANT_TTL_SECONDS, &key).expect("sign");
        assert_eq!(verify_ephemeral_grant(&issued.token, scope(), &key), Ok(()));

        // Every axis of the triple, one at a time. Each of these is a real
        // attack: another channel in the same workspace leaks who is in it,
        // another workspace is a cross-tenant leak, another member is
        // impersonation.
        let other = Uuid::from_u128(0x99);
        assert_eq!(
            verify_ephemeral_grant(
                &issued.token,
                EphemeralGrantScope {
                    channel_id: other,
                    ..scope()
                },
                &key
            ),
            Err(EphemeralGrantRejection::ChannelMismatch)
        );
        assert_eq!(
            verify_ephemeral_grant(
                &issued.token,
                EphemeralGrantScope {
                    workspace_id: other,
                    ..scope()
                },
                &key
            ),
            Err(EphemeralGrantRejection::WorkspaceMismatch)
        );
        assert_eq!(
            verify_ephemeral_grant(
                &issued.token,
                EphemeralGrantScope {
                    member_id: other,
                    ..scope()
                },
                &key
            ),
            Err(EphemeralGrantRejection::MemberMismatch)
        );
    }

    fn expired_by(seconds: i64, key: &str) -> String {
        let claims = EphemeralGrantClaims {
            sub: scope().member_id.to_string().to_uppercase(),
            ws: scope().workspace_id.to_string().to_uppercase(),
            ch: scope().channel_id.to_string().to_uppercase(),
            exp: (now_unix_seconds() - seconds).max(0) as usize,
            iat: (now_unix_seconds() - seconds - 60).max(0) as usize,
            typ: EPHEMERAL_GRANT_TYP.to_string(),
        };
        encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(key.as_bytes()),
        )
        .expect("encode")
    }

    #[test]
    fn an_expired_grant_is_refused_and_told_apart_from_a_forged_one() {
        let key = key();
        // `sign` clamps to a 5s floor, so an already-expired token is built by
        // hand — the point is the verifier's verdict, not the minter's.
        assert_eq!(
            verify_ephemeral_grant(&expired_by(30, &key), scope(), &key),
            Err(EphemeralGrantRejection::Expired)
        );
        assert!(EphemeralGrantRejection::Expired.is_renewable());
        assert!(!EphemeralGrantRejection::ChannelMismatch.is_renewable());
    }

    /// **The leeway red test.** `jsonwebtoken`'s default is 60 seconds; leaving
    /// it there would make a 60-second grant last 120, which is the number the
    /// eviction argument in this module's docs rests on. Restore the default
    /// and this goes red.
    #[test]
    fn the_clock_skew_tolerance_cannot_double_the_grants_life() {
        let key = key();
        // Just past the tolerance: refused. With jsonwebtoken's default leeway
        // this token would still verify.
        assert_eq!(
            verify_ephemeral_grant(
                &expired_by(EPHEMERAL_GRANT_LEEWAY_SECONDS as i64 + 3, &key),
                scope(),
                &key
            ),
            Err(EphemeralGrantRejection::Expired)
        );
    }

    /// The whole point of deriving the key: a grant is signed with something
    /// Centrifugo does not hold and `verify_app_access` does not accept.
    #[test]
    fn the_grant_key_is_neither_the_app_secret_nor_anything_centrifugo_holds() {
        let app_secret = "R7dGqk2mV9xPz1sLb4nJ8yTw3hCf6uEa";
        let derived = ephemeral_grant_key(app_secret);
        assert_ne!(derived, app_secret);
        assert_eq!(derived.len(), 64, "sha256 hex");
        assert_ne!(
            derived,
            ephemeral_grant_key("some-other-secret"),
            "the derivation must be secret-dependent"
        );

        // A grant must never verify as an App access token, whichever key is
        // tried — that is what stops a leaked grant becoming API access.
        let issued =
            sign_ephemeral_grant(scope(), EPHEMERAL_GRANT_TTL_SECONDS, &derived).expect("sign");
        assert!(crate::jwt::verify_app_access(&issued.token, app_secret).is_err());
        assert!(crate::jwt::verify_app_access(&issued.token, &derived).is_err());
    }

    /// And the converse: a Centrifugo connection token presented here is not a
    /// grant. It is signed with a different key AND lacks `ch`/`typ`, so both
    /// walls hold independently.
    #[test]
    fn a_connection_token_is_not_a_grant() {
        let connection = crate::realtime::sign_centrifugo_connection(
            scope().member_id,
            scope().workspace_id,
            Uuid::from_u128(0x44),
            60,
            "cent-secret",
        )
        .expect("sign");
        assert_eq!(
            verify_ephemeral_grant(&connection.token, scope(), &key()),
            Err(EphemeralGrantRejection::Malformed),
            "a different key must not verify"
        );
        // Even if the keys were ever unified, the shape still refuses it.
        assert_eq!(
            verify_ephemeral_grant(&connection.token, scope(), "cent-secret"),
            Err(EphemeralGrantRejection::Malformed),
            "connection claims carry no `ch`, so they cannot decode as a grant"
        );
    }

    #[test]
    fn the_ttl_is_clamped_and_shorter_than_a_connection_token() {
        let key = key();
        assert_eq!(
            sign_ephemeral_grant(scope(), 100_000, &key)
                .expect("sign")
                .ttl_seconds,
            300
        );
        assert_eq!(
            sign_ephemeral_grant(scope(), 0, &key)
                .expect("sign")
                .ttl_seconds,
            5
        );
    }

    /// Neither refusal may hint at whether the channel exists.
    #[test]
    fn rejection_messages_do_not_reveal_the_target() {
        for rejection in [
            EphemeralGrantRejection::Malformed,
            EphemeralGrantRejection::Expired,
            EphemeralGrantRejection::WrongType,
            EphemeralGrantRejection::MemberMismatch,
            EphemeralGrantRejection::WorkspaceMismatch,
            EphemeralGrantRejection::ChannelMismatch,
        ] {
            let message = rejection.message();
            assert!(!message.contains("exist"), "{message}");
            assert!(!message.contains("member of"), "{message}");
        }
    }
}
