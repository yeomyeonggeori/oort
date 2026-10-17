//! The lock-screen action token (#3927, ADR-0204 D6, an addendum to ADR-0188 §8.7).
//!
//! A phone that is locked can still show an approval notification with
//! [승인] / [거절] buttons. Once Face ID passes, the app's native handler has to
//! send ONE request — the approval decision — with no screen, no JS runtime and
//! no chance to refresh a session. This module is the credential for exactly
//! that request, and for nothing else.
//!
//! It is the `push_fetch` token's twin ([`crate::push_fetch_token`]) and is built
//! on the same three facts, because those are what make a parked credential
//! survivable:
//!
//! 1. **A different `typ`** ([`TYP_PUSH_ACTION`]). [`crate::verify_app_access`]
//!    refuses it, and so do the refresh route and logout's verification:
//!    everywhere that is not explicitly taught about this token it is simply not
//!    a credential. It is also not a `push_fetch` token — each entry point
//!    accepts exactly one `typ`, so neither token can stand in for the other.
//! 2. **A closed route list of ONE** ([`push_action_route_allowed`]), judged by
//!    the middleware before the database is touched:
//!    `POST /v1/workspaces/{ws}/approvals/{approval}/decision`, in the token's
//!    own workspace.
//! 3. **It lives exactly as long as its session can rotate.** It is recorded as
//!    a `session` row of the minting session's lineage and accepted only while
//!    [`push_action_session_live`] finds a live refresh row in that lineage —
//!    the same derived rule `push_fetch` uses (one SQL statement, parameterised
//!    by label, shared in [`crate::push_fetch_token`]). Logout with its refresh
//!    half, the reuse sweep, a password change, suspension and removal already
//!    revoke that refresh row, so none of them needed to learn about this token.
//!
//! ## What the token does NOT do
//!
//! It adds no authority. The decision route keeps every check it has — a
//! person, an active workspace member, a member of the approval's channel, the
//! required role, expiry, idempotency — and the token only replaces the bearer
//! that carries the request. A token minted for someone who may not decide an
//! approval gets the same `403 forbidden` receipt an ordinary access token
//! would. It cannot read messages, change settings, mint another token or
//! extend its session.
//!
//! The scope string is a label for humans reading a token, not a control.

use sqlx::PgConnection;
use uuid::Uuid;

use crate::issue::{sign_app_token, IssuedToken};
use crate::jwt::{decode_app_claims, principal_from_claims, AuthError, Principal};
use crate::push_fetch_token::{live_narrow_token_count, narrow_token_session_live};

/// `typ` of the lock-screen action token. Neither `access`, `refresh` nor
/// `push_fetch`.
pub const TYP_PUSH_ACTION: &str = "push_action";

/// Documentary scope carried in the claims. See the module docs: not a control.
pub const SCOPE_PUSH_ACTION: &str = "push:action";

/// `token.label` of the recorded row. Distinct from `access`/`refresh`/
/// `push_fetch`, so the queries that key on those labels (realtime liveness,
/// the linked-device list, refresh binding, the `push_fetch` cap and liveness)
/// can never mistake this row for one of theirs.
pub const SESSION_LABEL_PUSH_ACTION: &str = "push_action";

/// The value stamped into `audit_log.detail.via` on a decision made with this
/// token. Same string as the label: one name for one door.
pub const AUDIT_VIA_PUSH_ACTION: &str = "push_action";

/// Lifetime, in seconds.
///
/// Six hours, the same as `push_fetch` and for the same reason: the one reader
/// is a handler that runs while the app does not, so a phone in a pocket for an
/// hour must still be able to approve the card that lands next. The app remints
/// on launch and once half the lifetime is gone. What a copy of it is worth is
/// "decide an approval the holder could already decide, when the approval id is
/// known", and the lineage sweep — not the clock — is what ends it early.
pub const PUSH_ACTION_TTL_SECONDS: i64 = 6 * 60 * 60;

/// Sign a push-action token for `member_id` in `workspace_id`.
pub fn sign_push_action(
    member_id: Uuid,
    workspace_id: Uuid,
    hmac_secret: &str,
) -> Result<IssuedToken, AuthError> {
    sign_app_token(
        member_id,
        workspace_id,
        &[SCOPE_PUSH_ACTION.to_string()],
        TYP_PUSH_ACTION,
        PUSH_ACTION_TTL_SECONDS,
        hmac_secret,
    )
}

/// Verify signature, `exp` and `typ = "push_action"`, and resolve the principal.
/// The mirror image of [`crate::verify_app_access`] and
/// [`crate::verify_app_push_fetch`]: each entry point accepts exactly one `typ`.
pub fn verify_app_push_action(token: &str, hmac_secret: &str) -> Result<Principal, AuthError> {
    let claims = decode_app_claims(token, hmac_secret)?;
    if claims.typ != TYP_PUSH_ACTION {
        return Err(AuthError::NotAccessToken);
    }
    principal_from_claims(claims)
}

/// The most push-action rows one session lineage may hold live at once. The app
/// mints about every three hours against a six-hour life, so two or three are
/// live in normal use. The cap exists so that a leaked 15-minute access token
/// cannot pile up six-hour rows (each of which is also a row every lineage lock
/// must take, `LOCK_SESSION_ROWS_SQL`); refusing is a read, so it adds no writes
/// to other rows and no lock-order edge (#3107). Counted per label: this token's
/// rows and `push_fetch`'s do not share a budget.
pub const MAX_LIVE_PUSH_ACTION_PER_LINEAGE: i64 = 4;

/// Serialize the mints of ONE session lineage, so [`MAX_LIVE_PUSH_ACTION_PER_LINEAGE`]
/// is a cap and not a suggestion.
///
/// The cap is "count the live rows, refuse at the limit, otherwise insert". Two
/// transactions that both take `FOR SHARE` on the caller's access row do not wait
/// for each other, so under READ COMMITTED both would count four and both would
/// insert: N parallel mints from a leaked access token would leave 4 + N six-hour
/// rows, which is exactly the pile-up the cap exists to refuse. This transaction
/// advisory lock, keyed on the lineage and taken AFTER the row lock and BEFORE the
/// count, makes the count-then-insert atomic per lineage: the next mint waits for
/// the previous one to commit and then counts its row.
///
/// Lock order: it comes after the caller's access-row `FOR SHARE` and nothing else
/// is taken after it, and no other path takes this key, so it adds no edge to the
/// session-row lock order (#3107) — whoever holds it already holds its share lock
/// and needs nothing more. `conn` must carry the tenant GUC.
pub async fn lock_push_action_mints_in_tx(
    conn: &mut PgConnection,
    session_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended('momo.push_action.cap:' || $1::text, 0))",
    )
    .bind(session_id.to_string())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// How many unrevoked, unexpired push-action rows `session_id` holds. `conn`
/// must carry the tenant GUC.
pub async fn live_push_action_count(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    session_id: Uuid,
) -> Result<i64, sqlx::Error> {
    live_narrow_token_count(
        conn,
        workspace_id,
        member_id,
        session_id,
        SESSION_LABEL_PUSH_ACTION,
    )
    .await
}

/// Whether the session a push-action token was minted under can still rotate:
/// its lineage holds an unrevoked, unexpired refresh row. `token_id` is the
/// push-action row's own id; `conn` must carry the tenant GUC. A row with no
/// lineage, no row, or a row of any other label is not live. Read-only — it
/// takes no lock, so it cannot join the session-row lock order (#3107).
pub async fn push_action_session_live(
    conn: &mut PgConnection,
    token_id: Uuid,
) -> Result<bool, sqlx::Error> {
    narrow_token_session_live(conn, token_id, SESSION_LABEL_PUSH_ACTION).await
}

/// The only request a push-action token may make:
///
/// * `POST /v1/workspaces/{ws}/approvals/{approval}/decision`
///
/// `ws` must be the token's own workspace and `approval` a UUID. Both must be
/// written in the canonical 36-character hyphenated form: `Uuid::parse_str` also
/// takes `urn:uuid:…`, braces and the 32-hex "simple" form, and a credential
/// this narrow has no reason to accept a spelling the native handler never
/// sends. (Anything it accepts, the decision handler's own parse accepts too —
/// the list is a subset of the route, never a different reading of it.) Another
/// method, a trailing slash, an extra or missing segment, a query-shaped or
/// percent-encoded segment, another tenant, or the compatibility route
/// `POST /v1/agent-runs/{run}/approval-decisions` is refused. `path` is the URI
/// path only.
pub fn push_action_route_allowed(method: &str, path: &str, token_workspace: Uuid) -> bool {
    if method != "POST" {
        return false;
    }
    let Some(rest) = path.strip_prefix('/') else {
        return false;
    };
    let segments: Vec<&str> = rest.split('/').collect();
    match segments.as_slice() {
        ["v1", "workspaces", ws, "approvals", approval, "decision"] => {
            canonical_uuid(ws) == Some(token_workspace) && canonical_uuid(approval).is_some()
        }
        _ => false,
    }
}

/// A UUID in the 36-character hyphenated form, or nothing.
fn canonical_uuid(segment: &str) -> Option<Uuid> {
    if segment.len() != 36 {
        return None;
    }
    Uuid::parse_str(segment).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::issue::sign_access;
    use crate::jwt::{verify_app_access, verify_app_refresh};
    use crate::push_fetch_token::{sign_push_fetch, verify_app_push_fetch};

    const SECRET: &str = "push-action-secret";
    const WS: Uuid = Uuid::from_u128(20);
    const APPROVAL: Uuid = Uuid::from_u128(40);

    #[test]
    fn a_push_action_token_is_not_an_access_refresh_or_push_fetch_token() {
        let issued = sign_push_action(Uuid::from_u128(10), WS, SECRET).expect("sign");
        assert!(matches!(
            verify_app_access(&issued.token, SECRET),
            Err(AuthError::NotAccessToken)
        ));
        assert!(matches!(
            verify_app_refresh(&issued.token, SECRET),
            Err(AuthError::NotRefreshToken)
        ));
        assert!(matches!(
            verify_app_push_fetch(&issued.token, SECRET),
            Err(AuthError::NotAccessToken)
        ));
        let principal = verify_app_push_action(&issued.token, SECRET).expect("verify");
        assert_eq!(principal.workspace_id, WS);
        assert_eq!(principal.scopes, vec![SCOPE_PUSH_ACTION.to_string()]);
    }

    #[test]
    fn neither_an_access_nor_a_push_fetch_token_is_a_push_action_token() {
        let access = sign_access(Uuid::from_u128(10), WS, &[], SECRET).expect("sign");
        assert!(matches!(
            verify_app_push_action(&access.token, SECRET),
            Err(AuthError::NotAccessToken)
        ));
        let fetch = sign_push_fetch(Uuid::from_u128(10), WS, SECRET).expect("sign");
        assert!(matches!(
            verify_app_push_action(&fetch.token, SECRET),
            Err(AuthError::NotAccessToken)
        ));
    }

    #[test]
    fn a_foreign_signature_is_not_a_push_action_token() {
        let issued = sign_push_action(Uuid::from_u128(10), WS, "some-other-secret").expect("sign");
        assert!(matches!(
            verify_app_push_action(&issued.token, SECRET),
            Err(AuthError::InvalidToken(_))
        ));
    }

    #[test]
    fn the_lifetime_is_bounded() {
        let issued = sign_push_action(Uuid::from_u128(10), WS, SECRET).expect("sign");
        assert!(issued.expires_at > 0);
        assert_eq!(PUSH_ACTION_TTL_SECONDS, 6 * 3600);
        assert_eq!(MAX_LIVE_PUSH_ACTION_PER_LINEAGE, 4);
    }

    #[test]
    fn its_label_and_audit_name_cannot_be_another_tokens() {
        // The label is what keeps this row out of every query that keys on
        // another token's label (and keeps theirs out of this one's).
        assert_ne!(
            SESSION_LABEL_PUSH_ACTION,
            crate::push_fetch_token::SESSION_LABEL_PUSH_FETCH
        );
        assert_ne!(SESSION_LABEL_PUSH_ACTION, crate::SESSION_LABEL_ACCESS);
        assert_ne!(SESSION_LABEL_PUSH_ACTION, crate::SESSION_LABEL_REFRESH);
        assert_ne!(TYP_PUSH_ACTION, crate::push_fetch_token::TYP_PUSH_FETCH);
        assert_eq!(AUDIT_VIA_PUSH_ACTION, SESSION_LABEL_PUSH_ACTION);
    }

    #[test]
    fn exactly_the_decision_of_its_own_workspace_is_allowed() {
        let decision = format!("/v1/workspaces/{WS}/approvals/{APPROVAL}/decision");
        assert!(push_action_route_allowed("POST", &decision, WS));
        // Upper-case hex is still the canonical 36-character form.
        let upper = format!(
            "/v1/workspaces/{}/approvals/{}/decision",
            WS.to_string().to_uppercase(),
            APPROVAL.to_string().to_uppercase()
        );
        assert!(push_action_route_allowed("POST", &upper, WS));
    }

    #[test]
    fn everything_else_is_refused() {
        let other = Uuid::from_u128(21);
        let refused = [
            // Same path, wrong verb.
            (
                "GET",
                format!("/v1/workspaces/{WS}/approvals/{APPROVAL}/decision"),
            ),
            (
                "PUT",
                format!("/v1/workspaces/{WS}/approvals/{APPROVAL}/decision"),
            ),
            (
                "PATCH",
                format!("/v1/workspaces/{WS}/approvals/{APPROVAL}/decision"),
            ),
            (
                "DELETE",
                format!("/v1/workspaces/{WS}/approvals/{APPROVAL}/decision"),
            ),
            (
                "post",
                format!("/v1/workspaces/{WS}/approvals/{APPROVAL}/decision"),
            ),
            // Another tenant.
            (
                "POST",
                format!("/v1/workspaces/{other}/approvals/{APPROVAL}/decision"),
            ),
            // Shape tricks.
            (
                "POST",
                format!("/v1/workspaces/{WS}/approvals/{APPROVAL}/decision/"),
            ),
            (
                "POST",
                format!("/v1/workspaces/{WS}/approvals/{APPROVAL}/decision/extra"),
            ),
            (
                "POST",
                format!("/v1/workspaces/{WS}/approvals/{APPROVAL}/decisions"),
            ),
            (
                "POST",
                format!("/v1/workspaces/{WS}//approvals/{APPROVAL}/decision"),
            ),
            ("POST", format!("/v1/workspaces/{WS}/approvals//decision")),
            (
                "POST",
                format!("/v1/workspaces/{WS}/approvals/not-a-uuid/decision"),
            ),
            (
                "POST",
                format!("/v1/workspaces/{WS}/approvals/{APPROVAL}%2F../decision"),
            ),
            (
                "POST",
                format!("/v1/workspaces/{WS}/approvals/%7B{APPROVAL}%7D/decision"),
            ),
            (
                "POST",
                format!(
                    "/v1/workspaces/{WS}/approvals/{}/decision",
                    APPROVAL.simple()
                ),
            ),
            (
                "POST",
                format!("/v1/workspaces/{WS}/approvals/{}/decision", APPROVAL.urn()),
            ),
            (
                "POST",
                format!(
                    "/v1/workspaces/{}/approvals/{APPROVAL}/decision",
                    WS.simple()
                ),
            ),
            (
                "POST",
                format!("/v1/workspaces/{WS}/approvals/../approvals/{APPROVAL}/decision"),
            ),
            (
                "POST",
                format!("v1/workspaces/{WS}/approvals/{APPROVAL}/decision"),
            ),
            (
                "POST",
                format!("/v2/workspaces/{WS}/approvals/{APPROVAL}/decision"),
            ),
            // The compatibility route decides the same approvals but names the
            // run, not the approval — it is not the one door.
            (
                "POST",
                format!("/v1/agent-runs/{APPROVAL}/approval-decisions"),
            ),
            // Every neighbour on the approvals surface.
            ("GET", format!("/v1/workspaces/{WS}/approvals")),
            ("POST", format!("/v1/workspaces/{WS}/approvals")),
            ("GET", format!("/v1/workspaces/{WS}/approvals/{APPROVAL}")),
            // The other narrow token's two reads.
            ("GET", format!("/v1/workspaces/{WS}/roster")),
            (
                "GET",
                format!("/v1/workspaces/{WS}/channels/{APPROVAL}/messages"),
            ),
            // Anything that could widen the credential.
            ("POST", "/v1/auth/push-action-token".to_string()),
            ("POST", "/v1/auth/push-fetch-token".to_string()),
            ("POST", "/v1/auth/refresh".to_string()),
            ("POST", "/v1/auth/logout".to_string()),
            ("POST", "/v1/auth/realtime-token".to_string()),
            (
                "POST",
                format!("/v1/workspaces/{WS}/channels/{APPROVAL}/messages"),
            ),
            ("", String::new()),
        ];
        for (method, path) in refused {
            assert!(
                !push_action_route_allowed(method, &path, WS),
                "{method} {path} must be refused"
            );
        }
    }
}
