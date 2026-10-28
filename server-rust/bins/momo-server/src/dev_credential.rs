//! The request-extension marker for a **developer token** (ADR-0216 D1·D4·D8, #4660).
//!
//! A developer token (`momo_dev_v1…`) authenticates as a person: the `Principal` it
//! travels beside is `PrincipalKind::Human` with the member's id, so every existing
//! "is this a human?" guard passes for it. That is exactly why this marker exists. It
//! lets the handful of routes the closed table (`momo_auth::dev_token::required_dev_scope`)
//! opens recognise the caller, and **narrow** what that caller may do:
//!
//! - the channel restriction (`channel_ids`) on the read, thread and send routes and on
//!   the channel list and inbox (L3–L7),
//! - the body allow-list and the `message.sent_via = 'dev'` stamp on a send (L6),
//! - the refusal of an approval decision inside `routes::approvals::decide` (the second
//!   layer behind the table's first).
//!
//! **It narrows, it never grants.** No handler may read its presence as a reason to
//! allow anything a plain person session could not do, and no handler may take a value
//! from it that a request could have chosen. The same rule [`crate::auth::PushActionCredential`]
//! keeps. The only inserter is the developer-token branch of [`crate::auth::require_principal`]
//! (so a request cannot carry one in): it is built from the verified `token` row, never
//! from a header, a path segment or a body.

use momo_auth::dev_token::DevForm;
use uuid::Uuid;

/// What the door learned from the verified `token` row, handed to the handlers.
#[derive(Debug, Clone)]
pub struct DevCredential {
    /// The `token` row that authenticated this request (the card, or the session's
    /// access row). Never a refresh row: the data door does not accept one.
    pub token_id: Uuid,
    /// `card` or `access` (the door accepts nothing else).
    pub form: DevForm,
    /// The row's scopes (`dev:*` only, `dev:identity` always present).
    pub scopes: Vec<String>,
    /// `None` = no channel restriction. `Some(list)` = the 1..=50 channel ids the
    /// token was issued for; handlers intersect it with the member's **current**
    /// memberships on every request and never trust the stored list alone.
    pub channel_ids: Option<Vec<Uuid>>,
}

impl DevCredential {
    /// Whether this credential is limited to a chosen set of channels.
    pub fn is_channel_restricted(&self) -> bool {
        self.channel_ids.is_some()
    }

    /// Whether `channel_id` is inside the restriction (always true when there is none).
    /// This is the restriction half of the check only; the member must still be in the
    /// channel today.
    pub fn allows_channel(&self, channel_id: Uuid) -> bool {
        match &self.channel_ids {
            None => true,
            Some(ids) => ids.contains(&channel_id),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credential(channel_ids: Option<Vec<Uuid>>) -> DevCredential {
        DevCredential {
            token_id: Uuid::from_u128(1),
            form: DevForm::Card,
            scopes: vec!["dev:identity".to_string()],
            channel_ids,
        }
    }

    #[test]
    fn an_unrestricted_credential_allows_every_channel() {
        let unrestricted = credential(None);
        assert!(!unrestricted.is_channel_restricted());
        assert!(unrestricted.allows_channel(Uuid::from_u128(7)));
    }

    #[test]
    fn a_restricted_credential_allows_only_its_listed_channels() {
        let listed = Uuid::from_u128(7);
        let restricted = credential(Some(vec![listed]));
        assert!(restricted.is_channel_restricted());
        assert!(restricted.allows_channel(listed));
        assert!(!restricted.allows_channel(Uuid::from_u128(8)));
    }
}
