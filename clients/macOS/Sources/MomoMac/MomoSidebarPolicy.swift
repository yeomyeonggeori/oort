import MomoCore

struct MomoSidebarChannelOrder: Equatable {
    var standardChannels: [Channel]
    var directMessages: [Channel]

    var orderedChannels: [Channel] {
        standardChannels + directMessages
    }
}

enum MomoSidebarPolicy {
    /// Canonical visible navigation order: standard channels first, then DMs.
    /// Sidebar sections, quick-switcher numbering, and Cmd+1...9 share this result.
    static func channelOrder(from channels: [Channel]) -> MomoSidebarChannelOrder {
        let visibleChannels = channels.filter { !$0.isArchived }
        return MomoSidebarChannelOrder(
            standardChannels: visibleChannels.filter { $0.kind != .dm },
            directMessages: visibleChannels.filter { $0.kind == .dm }
        )
    }

    static func showsRosterPresence(
        usesServerRosterSourceOfTruth: Bool,
        isActivelyWorking: Bool
    ) -> Bool {
        isActivelyWorking || !usesServerRosterSourceOfTruth
    }
}
