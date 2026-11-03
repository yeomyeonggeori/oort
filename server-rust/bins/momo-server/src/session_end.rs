//! What ends with a session (#2677, #3022, #3097).
//!
//! A sign-in's lineage (`token.session_id`, 088) is the unit everything a
//! device registered hangs off: its push registration (ADR-0120 D4) and its
//! signing key (ADR-0146 개정 2026-09-28 D-7). Every path that ends a lineage —
//! or every lineage of a member — calls ONE of the two functions here, inside
//! the transaction that revokes the tokens, so the session and everything
//! registered under it end in one commit. One call per path is the point: a
//! new "thing that lives as long as a session" is added here, not at each
//! call site (no number of them is written down: a count in a comment went stale once).
//!
//! | path                                   | tokens | push | device key | scheduled messages (ADR-0208 D14) |
//! |----------------------------------------|--------|------|------------|------|
//! | logout ([`LineageEnd::Logout`])        | ended  | ended | revoked `logout` | **untouched** (arming one and signing out is the feature) |
//! | unlink a device ([`LineageEnd::DeviceUnlinked`]) | ended | ended | revoked `device_unlinked` | held if that lineage last wrote them |
//! | refresh-token reuse ([`LineageEnd::RefreshReuse`]) | ended | ended | **kept** (#3097) | held if that lineage last wrote them |
//! | member-wide ([`end_member_sessions_in_tx`]) | ended | ended | revoked `member_sessions_ended` | every pending and failed one held |
//! | a root's signed letter (`device_keys::revoke`) | — | — | revoked `signed` | — |
//!
//! A member-wide end also ends the member's **pending reset link** (an operator-issued
//! `password_reset` claim, ADR-0215 D4) — the one thing besides a session that can set their
//! password. A link that outlived the sessions it was meant to recover would let whoever holds
//! it take the account after the owner already recovered it some other way. Except for the
//! member's own password change, and for a refresh-token reuse should one ever end a whole
//! member ([`ends_pending_reset_links`]).
//!
//! **Held** means `failed` + `sessions_ended`, not cancelled: a schedule planted by a stolen
//! session must not go out on its own after the account is recovered, and a legitimate one is not
//! lost silently — its author re-reads it and re-arms it or sends it now. Removal and leaving the
//! workspace cancel instead; that is the route layer's call, beside [`end_member_sessions_in_tx`]
//! (`momo-settings` cannot depend on `momo-messaging`).
//!
//! Why a reuse keeps the key (#3097, ADR-0146 D-7 증보): a reuse proves that
//! a refresh token was copied, not that the device's Secure Enclave key was —
//! and it cannot be exported. Revoking the key hurt only its owner (a root
//! key comes back only with the password, a phone only with a new approval).
//! The key signs nothing while its lineage is dead (every check locks the
//! key's lineage), and it moves onto the owner's next sign-in only with a
//! letter the key itself signs (`momo_auth::device_key::rebind_device_key_in_tx`).

use momo_auth::consume_pending_password_resets_in_tx;
use momo_auth::device_key::{
    revoke_member_device_keys_in_tx, revoke_session_device_keys_in_tx, DeviceKeyRevocationReason,
};
use momo_db::{DbError, PgConnection};
use momo_messaging::{hold_lineage_schedules_in_tx, hold_member_schedules_in_tx, RevocationCause};
use momo_push::{invalidate_member_push_tokens_in_tx, invalidate_session_push_tokens_in_tx};
use uuid::Uuid;

/// Why one lineage ended — which decides whether its device keys end too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LineageEnd {
    /// The session logged out: its keys are revoked.
    Logout,
    /// The linked device was disconnected (ADR-0180 D5): its keys are revoked.
    DeviceUnlinked,
    /// A spent refresh token was presented again (ADR-0188 R1): the tokens and
    /// push registrations end, the keys stay (#3097).
    RefreshReuse,
}

impl LineageEnd {
    /// Whether this end holds the scheduled messages its lineage armed (ADR-0208 D14 point 2),
    /// and the cause the audit rows of the held ones carry. A logout does not hold: the author
    /// chose to leave, and scheduling a message to go out while they are away is what the feature
    /// is for.
    pub(crate) fn schedule_hold_cause(self) -> Option<RevocationCause> {
        match self {
            LineageEnd::Logout => None,
            LineageEnd::DeviceUnlinked => Some(RevocationCause::DeviceUnlinked),
            LineageEnd::RefreshReuse => Some(RevocationCause::RefreshReuse),
        }
    }

    /// The revocation reason, when this end revokes the lineage's keys.
    fn key_revocation(self) -> Option<DeviceKeyRevocationReason> {
        match self {
            LineageEnd::Logout => Some(DeviceKeyRevocationReason::Logout),
            LineageEnd::DeviceUnlinked => Some(DeviceKeyRevocationReason::DeviceUnlinked),
            LineageEnd::RefreshReuse => None,
        }
    }
}

/// One lineage ended (logout, unlinking a device, a refresh-token reuse).
pub(crate) async fn end_session_lineage_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    session_id: Uuid,
    end: LineageEnd,
) -> Result<(), DbError> {
    invalidate_session_push_tokens_in_tx(conn, workspace_id, member_id, session_id).await?;
    if let Some(reason) = end.key_revocation() {
        revoke_session_device_keys_in_tx(conn, workspace_id, member_id, session_id, reason)
            .await
            .map_err(DbError::from)?;
    }
    if let Some(cause) = end.schedule_hold_cause() {
        hold_lineage_schedules_in_tx(conn, workspace_id, member_id, session_id, cause).await?;
    }
    Ok(())
}

/// Whether ending every session of a member for `cause` also ends their pending reset link
/// (ADR-0215 D4). Everything does **except the member's own password change and a
/// refresh-token reuse**.
///
/// A change is the act of "someone who knows the current password", which cannot tell the
/// owner from a thief. If a change ended the link, a thief who knows the password could change
/// it again and again (inside the per-member limit) and keep cutting every link an operator
/// issues, and since the change also ends every session and device key, that link is the only
/// recovery the owner has left. The suspension, removal, leaving, and a reset (a claim spent, a
/// device-signed reset) are not things a password alone can do.
///
/// An exhaustive `match` with no `_` arm: a new cause does not compile until someone decides
/// which side of this line it is on. The two lineage-level causes never reach the member-wide
/// end today; they are listed so they are decided too. A device unlink is on the side of the
/// rule (a member-wide end ends the link). A refresh-token reuse is on the other side, for the
/// reason a password change is: whoever holds a copy of the token can raise it.
fn ends_pending_reset_links(cause: RevocationCause) -> bool {
    match cause {
        RevocationCause::PasswordChanged => false,
        // A copied refresh token can raise a reuse; it must not be able to cut a recovery link.
        RevocationCause::RefreshReuse => false,
        RevocationCause::PasswordReset
        | RevocationCause::Suspended
        | RevocationCause::Removed
        | RevocationCause::Left
        | RevocationCause::DeviceUnlinked => true,
    }
}

/// Every session of the member ended (password change or reset, suspension,
/// removal, leaving the workspace, an admin ending the member's sessions). `cause` is the path
/// that ended them; it is recorded, as an enumerated value, on the audit rows of the scheduled
/// messages this holds, and it decides whether the member's pending reset link ends too
/// ([`ends_pending_reset_links`]).
pub(crate) async fn end_member_sessions_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    cause: RevocationCause,
) -> Result<(), DbError> {
    invalidate_member_push_tokens_in_tx(conn, workspace_id, member_id).await?;
    revoke_member_device_keys_in_tx(conn, workspace_id, member_id)
        .await
        .map_err(DbError::from)?;
    // ADR-0208 D14: nothing this person armed may go out on its own now that every sign-in of
    // theirs is gone (the password changed, they were suspended, removed, or left).
    hold_member_schedules_in_tx(conn, workspace_id, member_id, cause).await?;
    // ADR-0215 D4: the operator's pending link ends in the same commit as the sessions it was a
    // way back into. Never waits for a claim row somebody else holds (`SKIP LOCKED`).
    if ends_pending_reset_links(cause) {
        consume_pending_password_resets_in_tx(conn, workspace_id, member_id)
            .await
            .map_err(DbError::from)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ADR-0215 D4: every member-wide end ends the pending reset link, except the member's own
    /// password change and a refresh-token reuse.
    #[test]
    fn only_the_members_own_change_and_a_token_reuse_leave_a_pending_reset_link_alone() {
        for cause in [
            RevocationCause::PasswordChanged,
            RevocationCause::RefreshReuse,
        ] {
            assert!(
                !ends_pending_reset_links(cause),
                "{cause:?} must leave a pending reset link alone"
            );
        }
        for cause in [
            RevocationCause::PasswordReset,
            RevocationCause::Suspended,
            RevocationCause::Removed,
            RevocationCause::Left,
            RevocationCause::DeviceUnlinked,
        ] {
            assert!(
                ends_pending_reset_links(cause),
                "{cause:?} must end a pending reset link"
            );
        }
    }

    /// The path table above, as the code decides it.
    #[test]
    fn only_a_reuse_keeps_the_lineages_keys() {
        assert_eq!(
            LineageEnd::Logout.key_revocation(),
            Some(DeviceKeyRevocationReason::Logout)
        );
        assert_eq!(
            LineageEnd::DeviceUnlinked.key_revocation(),
            Some(DeviceKeyRevocationReason::DeviceUnlinked)
        );
        assert_eq!(LineageEnd::RefreshReuse.key_revocation(), None);
    }

    /// ADR-0208 D14: a logout never holds a schedule; an unlinked device and a reused refresh
    /// token do.
    #[test]
    fn only_a_logout_leaves_the_lineages_schedules_alone() {
        assert_eq!(LineageEnd::Logout.schedule_hold_cause(), None);
        assert_eq!(
            LineageEnd::DeviceUnlinked.schedule_hold_cause(),
            Some(RevocationCause::DeviceUnlinked)
        );
        assert_eq!(
            LineageEnd::RefreshReuse.schedule_hold_cause(),
            Some(RevocationCause::RefreshReuse)
        );
    }
}
