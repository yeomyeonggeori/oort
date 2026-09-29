//! The notification extension's token (#3121, ADR-0188 §8.7).
//!
//! The iOS notification service extension (NSE) resolves an id-only push into a
//! title and body while the phone is locked. To do that it reads ONE keychain
//! item from a group the app shares with it, and until #3121 that item held the
//! member's full access token: every route a person may call, for 15 minutes,
//! readable by a second binary. This module is the narrow replacement.
//!
//! ## What "narrow" is made of
//!
//! Not the `scopes` claim. The human-JWT path of the middleware never checks a
//! route against `principal.scopes`, so a token that merely *lists* a small
//! scope would still be a full access token. The narrowing is two structural
//! facts instead:
//!
//! 1. **A different `typ`** ([`TYP_PUSH_FETCH`]). [`crate::verify_app_access`]
//!    refuses it (`NotAccessToken`), and so does the refresh route and logout's
//!    verification: everywhere that is not explicitly taught about this token it
//!    is simply not a credential.
//! 2. **A closed route list** ([`push_fetch_route_allowed`]), checked by the
//!    middleware before the database is touched — the same order the agent
//!    bearer gets. Two GETs, in the token's own workspace, and nothing else.
//!
//! 3. **It lives exactly as long as its session can rotate.** It is recorded as
//!    a `session` row of the minting session's lineage, and the middleware
//!    accepts it only while [`push_fetch_session_live`] finds a live refresh
//!    row in that lineage. Derived, not swept: logout (with its refresh half),
//!    the reuse sweep, a password change, suspension and removal all already
//!    revoke that refresh row, so none of them needed to learn about this token
//!    — and a future way to end a session cannot forget it. It has no refresh
//!    half of its own.
//!
//! The scope string is a label for humans reading a token, not a control.

use sqlx::PgConnection;
use uuid::Uuid;

use crate::issue::{sign_app_token, IssuedToken};
use crate::jwt::{decode_app_claims, principal_from_claims, AuthError, Principal};

/// `typ` of the NSE's token. Neither `access` nor `refresh`.
pub const TYP_PUSH_FETCH: &str = "push_fetch";

/// Documentary scope carried in the claims. See the module docs: not a control.
pub const SCOPE_PUSH_FETCH: &str = "push:fetch";

/// `token.label` of the recorded row. Distinct from `access`/`refresh`, so the
/// queries that key on those labels (realtime liveness, the linked-device list,
/// refresh binding) can never mistake this row for one of a session's halves.
pub const SESSION_LABEL_PUSH_FETCH: &str = "push_fetch";

/// Lifetime, in seconds.
///
/// 15 minutes is the access token's lifetime and the value this replaces, but
/// the extension is the one reader that runs while the app does NOT: a phone in
/// a pocket for an hour still has to show "누가 무엇을" when the next push
/// lands. The app remints on launch and again once half the lifetime is gone.
/// Six hours bounds what a copy of the item is worth without a tap on the
/// server, and what it is worth is two read-only routes; the lineage sweep, not
/// the clock, is what ends it early.
pub const PUSH_FETCH_TTL_SECONDS: i64 = 6 * 60 * 60;

/// Sign a push-fetch token for `member_id` in `workspace_id`.
pub fn sign_push_fetch(
    member_id: Uuid,
    workspace_id: Uuid,
    hmac_secret: &str,
) -> Result<IssuedToken, AuthError> {
    sign_app_token(
        member_id,
        workspace_id,
        &[SCOPE_PUSH_FETCH.to_string()],
        TYP_PUSH_FETCH,
        PUSH_FETCH_TTL_SECONDS,
        hmac_secret,
    )
}

/// Verify signature, `exp` and `typ = "push_fetch"`, and resolve the principal.
/// The mirror image of [`crate::verify_app_access`]: each entry point accepts
/// exactly one `typ`.
pub fn verify_app_push_fetch(token: &str, hmac_secret: &str) -> Result<Principal, AuthError> {
    let claims = decode_app_claims(token, hmac_secret)?;
    if claims.typ != TYP_PUSH_FETCH {
        return Err(AuthError::NotAccessToken);
    }
    principal_from_claims(claims)
}

/// Whether the session a push-fetch token was minted under can still rotate:
/// its lineage holds an unrevoked, unexpired refresh row. `token_id` is the
/// push-fetch row's own id; `conn` must carry the tenant GUC. A row with no
/// lineage (or no row) is not live. Read-only — it takes no lock, so it cannot
/// join the session-row lock order (#3107).
pub async fn push_fetch_session_live(
    conn: &mut PgConnection,
    token_id: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS ( \
           SELECT 1 \
             FROM token p \
             JOIN token r \
               ON r.workspace_id = p.workspace_id \
              AND r.actor_member_id = p.actor_member_id \
              AND r.session_id = p.session_id \
            WHERE p.id = $1 \
              AND p.label = 'push_fetch' \
              AND r.kind = 'session' \
              AND r.label = 'refresh' \
              AND r.revoked_at IS NULL \
              AND (r.expires_at IS NULL OR r.expires_at > now()))",
    )
    .bind(token_id)
    .fetch_one(&mut *conn)
    .await
}

/// The only two requests a push-fetch token may make, mirroring what the
/// extension's `MomoPushRESTFetcher` sends (`PushNotification.swift`):
///
/// * `GET /v1/workspaces/{ws}/channels/{ch}/messages`
/// * `GET /v1/workspaces/{ws}/roster`
///
/// `ws` must be the token's own workspace and, like `ch`, a UUID. Anything else
/// — another method, a trailing slash, an extra segment, a query-shaped
/// segment, another tenant — is refused. `path` is the URI path only.
pub fn push_fetch_route_allowed(method: &str, path: &str, token_workspace: Uuid) -> bool {
    if method != "GET" {
        return false;
    }
    let Some(rest) = path.strip_prefix('/') else {
        return false;
    };
    let segments: Vec<&str> = rest.split('/').collect();
    let workspace_ok = |segment: &str| Uuid::parse_str(segment) == Ok(token_workspace);
    match segments.as_slice() {
        ["v1", "workspaces", ws, "roster"] => workspace_ok(ws),
        ["v1", "workspaces", ws, "channels", channel, "messages"] => {
            workspace_ok(ws) && Uuid::parse_str(channel).is_ok()
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::issue::sign_access;
    use crate::jwt::{verify_app_access, verify_app_refresh};

    const SECRET: &str = "push-fetch-secret";
    const WS: Uuid = Uuid::from_u128(20);
    const CH: Uuid = Uuid::from_u128(30);

    #[test]
    fn a_push_fetch_token_is_not_an_access_or_refresh_token() {
        let issued = sign_push_fetch(Uuid::from_u128(10), WS, SECRET).expect("sign");
        assert!(matches!(
            verify_app_access(&issued.token, SECRET),
            Err(AuthError::NotAccessToken)
        ));
        assert!(matches!(
            verify_app_refresh(&issued.token, SECRET),
            Err(AuthError::NotRefreshToken)
        ));
        let principal = verify_app_push_fetch(&issued.token, SECRET).expect("verify");
        assert_eq!(principal.workspace_id, WS);
        assert_eq!(principal.scopes, vec![SCOPE_PUSH_FETCH.to_string()]);
    }

    #[test]
    fn an_access_token_is_not_a_push_fetch_token() {
        let access = sign_access(Uuid::from_u128(10), WS, &[], SECRET).expect("sign");
        assert!(matches!(
            verify_app_push_fetch(&access.token, SECRET),
            Err(AuthError::NotAccessToken)
        ));
    }

    #[test]
    fn the_lifetime_is_bounded() {
        let issued = sign_push_fetch(Uuid::from_u128(10), WS, SECRET).expect("sign");
        let principal_exp = issued.expires_at;
        assert!(principal_exp > 0);
        assert_eq!(PUSH_FETCH_TTL_SECONDS, 6 * 3600);
    }

    #[test]
    fn exactly_the_two_reads_of_its_own_workspace_are_allowed() {
        let messages = format!("/v1/workspaces/{WS}/channels/{CH}/messages");
        let roster = format!("/v1/workspaces/{WS}/roster");
        assert!(push_fetch_route_allowed("GET", &messages, WS));
        assert!(push_fetch_route_allowed("GET", &roster, WS));
    }

    #[test]
    fn everything_else_is_refused() {
        let other = Uuid::from_u128(21);
        let refused = [
            (
                "POST",
                format!("/v1/workspaces/{WS}/channels/{CH}/messages"),
            ),
            (
                "PATCH",
                format!("/v1/workspaces/{WS}/channels/{CH}/messages"),
            ),
            ("GET", format!("/v1/workspaces/{other}/roster")),
            (
                "GET",
                format!("/v1/workspaces/{other}/channels/{CH}/messages"),
            ),
            (
                "GET",
                format!("/v1/workspaces/{WS}/channels/{CH}/messages/"),
            ),
            (
                "GET",
                format!("/v1/workspaces/{WS}/channels/{CH}/messages/{CH}/replies"),
            ),
            (
                "GET",
                format!("/v1/workspaces/{WS}/channels/not-a-uuid/messages"),
            ),
            ("GET", format!("/v1/workspaces/{WS}/roster/")),
            ("GET", format!("/v1/workspaces/{WS}/members")),
            ("GET", format!("/v1/workspaces/{WS}/search/messages")),
            ("GET", format!("/v1/workspaces/{WS}/channels")),
            ("GET", "/v1/auth/push-fetch-token".to_string()),
            ("POST", "/v1/auth/push-fetch-token".to_string()),
            ("POST", "/v1/auth/logout".to_string()),
            ("POST", "/v1/auth/realtime-token".to_string()),
            ("GET", "v1/workspaces".to_string()),
        ];
        for (method, path) in refused {
            assert!(
                !push_fetch_route_allowed(method, &path, WS),
                "{method} {path} must be refused"
            );
        }
    }
}
