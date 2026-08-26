//! LiveKit HS256 video grant issuer (ADR-0122 / HD-1).
//!
//! The token is computed in-process and returned once. It is never persisted,
//! logged, or sent to LiveKit by the server.

use chrono::Utc;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub(crate) const TOKEN_TTL_SECONDS: i64 = 10 * 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct VideoGrant {
    room: String,
    room_join: bool,
    can_publish: bool,
    can_subscribe: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct AccessClaims {
    iss: String,
    sub: String,
    exp: i64,
    nbf: i64,
    video: VideoGrant,
    name: String,
}

pub(crate) struct IssuedToken {
    pub token: String,
    pub expires_at_ms: i64,
    pub ttl_seconds: i64,
}

pub(crate) fn issue_livekit_token(
    api_key: &str,
    api_secret: &str,
    room_id: Uuid,
    member_id: Uuid,
    display_name: &str,
) -> Result<IssuedToken, jsonwebtoken::errors::Error> {
    issue_livekit_token_at(
        api_key,
        api_secret,
        room_id,
        member_id,
        display_name,
        Utc::now().timestamp(),
    )
}

fn issue_livekit_token_at(
    api_key: &str,
    api_secret: &str,
    room_id: Uuid,
    member_id: Uuid,
    display_name: &str,
    now_seconds: i64,
) -> Result<IssuedToken, jsonwebtoken::errors::Error> {
    let claims = AccessClaims {
        iss: api_key.to_string(),
        sub: member_id.to_string().to_uppercase(),
        exp: now_seconds + TOKEN_TTL_SECONDS,
        nbf: now_seconds,
        video: VideoGrant {
            room: room_id.to_string().to_uppercase(),
            room_join: true,
            can_publish: true,
            can_subscribe: true,
        },
        name: display_name.to_string(),
    };
    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(api_secret.as_bytes()),
    )?;
    Ok(IssuedToken {
        token,
        expires_at_ms: claims.exp * 1_000,
        ttl_seconds: TOKEN_TTL_SECONDS,
    })
}

#[cfg(test)]
mod tests {
    use jsonwebtoken::{decode, DecodingKey, Validation};

    use super::*;

    #[test]
    fn grant_is_hs256_video_only_and_expires_in_ten_minutes() {
        let room = Uuid::parse_str("00000000-0000-7000-8000-000000000201").unwrap();
        let member = Uuid::parse_str("00000000-0000-7000-8000-000000000101").unwrap();
        let now = Utc::now().timestamp();
        let issued = issue_livekit_token_at("test-key", "test-secret", room, member, "Kim", now)
            .expect("issue grant");
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_nbf = true;
        let claims = decode::<AccessClaims>(
            &issued.token,
            &DecodingKey::from_secret(b"test-secret"),
            &validation,
        )
        .expect("verify grant")
        .claims;
        assert_eq!(claims.exp - claims.nbf, TOKEN_TTL_SECONDS);
        assert_eq!(claims.video.room, room.to_string().to_uppercase());
        assert!(claims.video.room_join);
        assert!(claims.video.can_publish);
        assert!(claims.video.can_subscribe);
        assert_eq!(claims.sub, member.to_string().to_uppercase());
        assert_eq!(issued.expires_at_ms, claims.exp * 1_000);
        assert_eq!(issued.ttl_seconds, 600);
    }
}
