import MomoCore

enum MomoWorkAgentCandidateFilter {
    /// Receives the selected channel's active roster projection. It deliberately
    /// filters only and never chooses a target or applies routing priority.
    static func candidates(
        from rosterMembers: [Member],
        in channel: ChannelID,
        requiredCapability: String? = nil
    ) -> [Member] {
        let normalizedRequirement: String?
        if let requiredCapability {
            guard let normalized = Member.normalizedCapability(requiredCapability) else { return [] }
            normalizedRequirement = normalized
        } else {
            normalizedRequirement = nil
        }

        return rosterMembers
            .filter { member in
                guard member.isAgent,
                      member.status == .active,
                      member.channelIds.contains(channel)
                else { return false }
                if let normalizedRequirement {
                    return member.hasCapability(normalizedRequirement)
                }
                return !member.normalizedCapabilities.isEmpty
            }
            .sorted {
                $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            }
    }
}

extension ChatViewModel {
    /// MOMO-354's active invited-roster predicate stays authoritative. The
    /// capability convention only narrows that set for the explicit Work picker.
    public func workAgentCandidates(
        requiring capability: String? = nil,
        in channel: ChannelID? = nil
    ) -> [Member] {
        guard let channel = channel ?? selectedChannelId else { return [] }
        return MomoWorkAgentCandidateFilter.candidates(
            from: activeMembers(in: channel),
            in: channel,
            requiredCapability: capability
        )
    }
}
