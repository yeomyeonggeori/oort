//! Which channels a request may reach (ADR-0216 D4 · R11 · F17, #4660).
//!
//! A person reaches every channel they belong to **today**. A developer token can be
//! narrowed further to a chosen list of channels, and that list is only ever half of the
//! answer: the token row stores the ids the person picked when they made it, and the
//! person may have left one of those channels since. So the reach of a restricted token
//! is the **intersection** of its list with the member's live memberships, recomputed on
//! every request — the stored list alone is never trusted (ADR-0216 D4, the same rule
//! ADR-0162 D4 keeps for agent channel grants).
//!
//! This type carries the *restriction* half. The membership half stays exactly where it
//! already was in each read and write — `is_channel_member`, the channel list's
//! `membership` join, the inbox's `membership` join — so a restriction can only remove
//! channels from what a person could already reach, never add one.
//!
//! Every caller that predates developer tokens gets [`ChannelRestriction::Unrestricted`]
//! through the unchanged function it already calls, and the statement it runs is the
//! statement it always ran.

use uuid::Uuid;

/// The channel half of a request's reach.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ChannelRestriction<'a> {
    /// No restriction: every channel the member belongs to today.
    #[default]
    Unrestricted,
    /// Only these channels, and only while the member still belongs to them.
    Within(&'a [Uuid]),
}

impl<'a> ChannelRestriction<'a> {
    /// The restriction a developer token's stored channel list (`token.dev_channel_ids`,
    /// `None` = none) imposes.
    pub fn from_channel_ids(channel_ids: Option<&'a [Uuid]>) -> Self {
        match channel_ids {
            None => ChannelRestriction::Unrestricted,
            Some(ids) => ChannelRestriction::Within(ids),
        }
    }

    /// Whether the restriction lets `channel_id` through. The restriction half only:
    /// see [`Self::reaches`] for the whole answer.
    pub fn admits(self, channel_id: Uuid) -> bool {
        match self {
            ChannelRestriction::Unrestricted => true,
            ChannelRestriction::Within(ids) => ids.contains(&channel_id),
        }
    }

    /// The whole reach of one channel: inside the restriction **and** a member today.
    ///
    /// A channel that is listed but left is out of reach; a channel the member is in but
    /// did not list is out of reach. Both answer exactly as a channel that does not exist,
    /// so a restricted token learns nothing about the channels outside its reach.
    pub fn reaches(self, channel_id: Uuid, is_member_today: bool) -> bool {
        is_member_today && self.admits(channel_id)
    }

    /// The list to bind into a statement, or `None` when there is nothing to narrow.
    pub(crate) fn listed(self) -> Option<&'a [Uuid]> {
        match self {
            ChannelRestriction::Unrestricted => None,
            ChannelRestriction::Within(ids) => Some(ids),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTED: Uuid = Uuid::from_u128(0xa);
    const UNLISTED: Uuid = Uuid::from_u128(0xb);

    #[test]
    fn no_stored_list_restricts_nothing() {
        let restriction = ChannelRestriction::from_channel_ids(None);
        assert_eq!(restriction, ChannelRestriction::Unrestricted);
        assert!(restriction.admits(LISTED));
        assert!(restriction.admits(UNLISTED));
        assert_eq!(restriction.listed(), None);
    }

    #[test]
    fn a_stored_list_admits_only_its_own_channels() {
        let ids = [LISTED];
        let restriction = ChannelRestriction::from_channel_ids(Some(&ids));
        assert!(restriction.admits(LISTED));
        assert!(!restriction.admits(UNLISTED));
        assert_eq!(restriction.listed(), Some(&ids[..]));
    }

    /// ADR-0216 D4: the reach is the stored list **intersected with today's memberships**.
    /// Each of the four corners is a separate case on purpose — dropping either half of the
    /// conjunction turns exactly one of them green-to-red.
    #[test]
    fn the_reach_is_the_list_intersected_with_todays_memberships() {
        let ids = [LISTED];
        let restricted = ChannelRestriction::Within(&ids);
        assert!(restricted.reaches(LISTED, true), "listed and a member");
        assert!(
            !restricted.reaches(LISTED, false),
            "listed but left since: the stored list alone is never trusted"
        );
        assert!(
            !restricted.reaches(UNLISTED, true),
            "a member, but outside the token's list"
        );
        assert!(!restricted.reaches(UNLISTED, false));

        let unrestricted = ChannelRestriction::Unrestricted;
        assert!(unrestricted.reaches(UNLISTED, true));
        assert!(
            !unrestricted.reaches(UNLISTED, false),
            "no restriction is still bounded by membership"
        );
    }

    /// An empty list cannot come from the database (`token_dev_channel_ids_ck` requires
    /// 1..=50 ids), but if one ever arrived it must mean "nothing", never "everything".
    #[test]
    fn an_empty_list_reaches_nothing() {
        let restriction = ChannelRestriction::from_channel_ids(Some(&[]));
        assert!(!restriction.admits(LISTED));
        assert!(!restriction.reaches(LISTED, true));
        assert_eq!(restriction.listed(), Some(&[][..]));
    }
}
