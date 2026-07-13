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

enum MomoUnreadNavigationDirection {
    case previous
    case next
}

enum MomoUnreadNavigation {
    static func destination(
        from selected: ChannelID?,
        orderedChannels: [ChannelID],
        unreadChannels: Set<ChannelID>,
        direction: MomoUnreadNavigationDirection
    ) -> ChannelID? {
        guard !orderedChannels.isEmpty, !unreadChannels.isEmpty else { return nil }
        guard let selected, let selectedIndex = orderedChannels.firstIndex(of: selected) else {
            switch direction {
            case .next:
                return orderedChannels.first { unreadChannels.contains($0) }
            case .previous:
                return orderedChannels.reversed().first { unreadChannels.contains($0) }
            }
        }

        for offset in 1..<orderedChannels.count {
            let index: Int
            switch direction {
            case .next:
                index = (selectedIndex + offset) % orderedChannels.count
            case .previous:
                index = (selectedIndex - offset + orderedChannels.count) % orderedChannels.count
            }
            let candidate = orderedChannels[index]
            if unreadChannels.contains(candidate) {
                return candidate
            }
        }
        return nil
    }
}

enum MomoUnreadBadge {
    static func label(mentionCount: Int) -> String? {
        guard mentionCount > 0 else { return nil }
        return mentionCount > 99 ? "99+" : String(mentionCount)
    }
}
