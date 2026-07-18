import Foundation
import MomoCore

public struct IOSConversationSnapshot: Sendable, Equatable {
    public var channels: [Channel]
    public var members: [Member]
    public var readStates: [ChannelReadState]

    public init(channels: [Channel], members: [Member], readStates: [ChannelReadState]) {
        self.channels = channels
        self.members = members
        self.readStates = readStates
    }
}

public struct IOSChannelListItem: Identifiable, Sendable, Equatable {
    public let channel: Channel
    public let title: String
    public let unreadCount: Int64
    public let mentionCount: Int

    public var id: ChannelID { channel.id }
    public var isDirectMessage: Bool { channel.kind == .dm }
    public var hasUnread: Bool { unreadCount > 0 }

    public var badgeLabel: String? {
        let count = isDirectMessage ? unreadCount : Int64(mentionCount)
        guard count > 0 else { return nil }
        return count > 99 ? "99+" : String(count)
    }
}

public struct IOSChannelSections: Sendable, Equatable {
    public var channels: [IOSChannelListItem]
    public var directMessages: [IOSChannelListItem]

    public init(channels: [IOSChannelListItem], directMessages: [IOSChannelListItem]) {
        self.channels = channels
        self.directMessages = directMessages
    }
}

/// MomoMac에서 복제, ADR-0123 D1 복제 후 수렴.
/// Mirrors ADR-0109: channel rows badge mentions; DM rows badge total unread.
public enum IOSChannelListMapper {
    public static func sections(
        channels: [Channel],
        members: [Member],
        readStates: [ChannelReadState],
        currentMemberID: MemberID
    ) -> IOSChannelSections {
        let states = Dictionary(uniqueKeysWithValues: readStates.map { ($0.channelId, $0) })
        let memberNames = Dictionary(uniqueKeysWithValues: members.map { ($0.id, $0.displayName) })
        let items = channels.filter { !$0.isArchived }.map { channel in
            let state = states[channel.id]
            return IOSChannelListItem(
                channel: channel,
                title: displayName(for: channel, memberNames: memberNames, currentMemberID: currentMemberID),
                unreadCount: state?.unreadCount ?? 0,
                mentionCount: state?.mentionCount ?? 0
            )
        }
        let standard = items.filter { !$0.isDirectMessage }.sorted(by: itemOrder)
        let direct = items.filter(\.isDirectMessage).sorted(by: itemOrder)
        return IOSChannelSections(channels: standard, directMessages: direct)
    }

    private static func displayName(
        for channel: Channel,
        memberNames: [MemberID: String],
        currentMemberID: MemberID
    ) -> String {
        if channel.kind == .dm,
           let counterpart = channel.dmMemberIds.first(where: { $0 != currentMemberID }),
           let name = memberNames[counterpart],
           !name.isEmpty {
            return name
        }
        let name = channel.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? "Direct message" : name
    }

    private static func itemOrder(_ lhs: IOSChannelListItem, _ rhs: IOSChannelListItem) -> Bool {
        let order = lhs.title.localizedCaseInsensitiveCompare(rhs.title)
        return order == .orderedSame ? lhs.id.description < rhs.id.description : order == .orderedAscending
    }
}

/// MomoMac에서 복제, ADR-0123 D1 복제 후 수렴.
/// Ordering authority is `Message.seq`; identity guards handle replay and reconciliation.
public enum IOSTimelineReducer {
    public static func sorted(_ messages: [Message]) -> [Message] {
        messages.sorted(by: seqOrder)
    }

    public static func applying(_ event: RealtimeEvent, to messages: [Message], channel: ChannelID) -> [Message] {
        var result = messages
        switch event {
        case .message(let message), .messageEdited(let message):
            guard message.channelId == channel else { return result }
            let existing = result.firstIndex(where: { $0.id == message.id })
                ?? message.clientMsgId.flatMap { clientID in
                    result.firstIndex(where: { $0.clientMsgId == clientID })
                }
            if let existing {
                result[existing] = message
            } else if let sequence = message.seq,
                      result.contains(where: { $0.seq == sequence }) {
                return result
            } else {
                result.append(message)
            }
        case .messageDeleted(let id):
            if let index = result.firstIndex(where: { $0.id == id }) {
                result[index].state = .deleted
            }
        case .reaction, .typing, .presence, .agentStatus, .agentPartial, .approval, .huddle:
            break
        }
        return sorted(result)
    }

    private static func seqOrder(_ lhs: Message, _ rhs: Message) -> Bool {
        switch (lhs.seq, rhs.seq) {
        case let (.some(left), .some(right)) where left != right:
            return left < right
        case (.some, .none):
            return true
        case (.none, .some):
            return false
        default:
            if lhs.hlcTs != rhs.hlcTs { return lhs.hlcTs < rhs.hlcTs }
            if lhs.hlcCount != rhs.hlcCount { return lhs.hlcCount < rhs.hlcCount }
            return lhs.id.description < rhs.id.description
        }
    }
}
