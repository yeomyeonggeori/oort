import AppKit
import MomoCore

enum MomoDockUnreadBadgePolicy {
    static func totalUnread(_ states: [ChannelID: ChannelReadState]) -> Int64 {
        states.values.reduce(into: 0) { total, state in
            let unread = max(0, state.unreadCount)
            total = total > Int64.max - unread ? Int64.max : total + unread
        }
    }

    static func label(totalUnread: Int64) -> String? {
        guard totalUnread > 0 else { return nil }
        return totalUnread > 99 ? "99+" : String(totalUnread)
    }
}

@MainActor
enum MomoDockUnreadBadgeController {
    static func apply(_ states: [ChannelID: ChannelReadState]) {
        NSApp.dockTile.badgeLabel = MomoDockUnreadBadgePolicy.label(
            totalUnread: MomoDockUnreadBadgePolicy.totalUnread(states)
        )
    }

    static func clear() {
        NSApp.dockTile.badgeLabel = nil
    }
}
