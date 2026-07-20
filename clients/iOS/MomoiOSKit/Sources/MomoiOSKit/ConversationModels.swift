import Foundation
import MomoCore

public struct IOSConversationSnapshot: Sendable, Equatable {
    public var channels: [Channel]
    public var members: [Member]
    public var readStates: [ChannelReadState]
    public var channelMuteStates: [ChannelID: Bool]
    public var memberPresenceStates: [MemberID: Presence]

    public init(
        channels: [Channel],
        members: [Member],
        readStates: [ChannelReadState],
        channelMuteStates: [ChannelID: Bool] = [:],
        memberPresenceStates: [MemberID: Presence] = [:]
    ) {
        self.channels = channels
        self.members = members
        self.readStates = readStates
        self.channelMuteStates = channelMuteStates
        self.memberPresenceStates = memberPresenceStates
    }
}

public struct IOSChannelListItem: Identifiable, Sendable, Equatable {
    public let channel: Channel
    public let title: String
    public var unreadCount: Int64
    public var mentionCount: Int
    public var latestSequence: Int64
    public var isMuted: Bool
    public let directMessageMemberID: MemberID?
    public let directMessagePresence: Presence?

    public init(
        channel: Channel,
        title: String,
        unreadCount: Int64,
        mentionCount: Int,
        latestSequence: Int64 = 0,
        isMuted: Bool = false,
        directMessageMemberID: MemberID? = nil,
        directMessagePresence: Presence? = nil
    ) {
        self.channel = channel
        self.title = title
        self.unreadCount = unreadCount
        self.mentionCount = mentionCount
        self.latestSequence = latestSequence
        self.isMuted = isMuted
        self.directMessageMemberID = directMessageMemberID
        self.directMessagePresence = directMessagePresence
    }

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
        channelMuteStates: [ChannelID: Bool] = [:],
        memberPresenceStates: [MemberID: Presence] = [:],
        currentMemberID: MemberID
    ) -> IOSChannelSections {
        let states = Dictionary(uniqueKeysWithValues: readStates.map { ($0.channelId, $0) })
        let membersByID = Dictionary(uniqueKeysWithValues: members.map { ($0.id, $0) })
        let items = channels.filter { !$0.isArchived }.map { channel in
            let state = states[channel.id]
            let directMessageMemberID = channel.kind == .dm
                ? channel.dmMemberIds.first(where: { $0 != currentMemberID })
                : nil
            return IOSChannelListItem(
                channel: channel,
                title: displayName(for: channel, membersByID: membersByID, currentMemberID: currentMemberID),
                unreadCount: state?.unreadCount ?? 0,
                mentionCount: state?.mentionCount ?? 0,
                latestSequence: state?.latestSeq ?? 0,
                isMuted: channelMuteStates[channel.id] ?? false,
                directMessageMemberID: directMessageMemberID,
                directMessagePresence: directMessageMemberID.flatMap { memberPresenceStates[$0] }
            )
        }
        let standard = items.filter { !$0.isDirectMessage }.sorted(by: itemOrder)
        let direct = items.filter(\.isDirectMessage).sorted(by: itemOrder)
        return IOSChannelSections(channels: standard, directMessages: direct)
    }

    private static func displayName(
        for channel: Channel,
        membersByID: [MemberID: Member],
        currentMemberID: MemberID
    ) -> String {
        if channel.kind == .dm,
           let counterpart = channel.dmMemberIds.first(where: { $0 != currentMemberID }),
           let name = membersByID[counterpart]?.displayName,
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

public enum IOSAppTab: String, CaseIterable, Sendable, Hashable, Identifiable {
    case home
    case search
    case activity
    case work
    case profile

    public var id: String { rawValue }
}

public enum IOSChannelSearch {
    public static func filter(_ items: [IOSChannelListItem], query: String) -> [IOSChannelListItem] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return items }
        return items.filter { item in
            item.title.localizedCaseInsensitiveContains(normalized)
        }
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
        case .threadUpdated(let delta):
            guard delta.channelId == channel,
                  let index = result.firstIndex(where: { $0.id == delta.rootId })
            else { return result }
            result[index].thread = delta.rollup
        case .reaction, .typing, .presence, .agentStatus, .agentPartial, .approval, .huddle,
             .workSession, .workControl:
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

struct IOSMessageBodySegment: Identifiable, Sendable, Equatable {
    enum Kind: Sendable, Equatable {
        case prose
        case code(language: String?)
    }

    let id: Int
    let kind: Kind
    let text: String
}

enum IOSMessageBodyParser {
    static func segments(in body: String) -> [IOSMessageBodySegment] {
        let parts = body.components(separatedBy: "```")
        var segments: [IOSMessageBodySegment] = []
        segments.reserveCapacity(parts.count)

        for (partIndex, part) in parts.enumerated() where !part.isEmpty {
            let isCode = partIndex.isMultiple(of: 2) == false
            let parsed = isCode ? codeBlock(from: part) : (nil, part)
            let text = parsed.1.trimmingCharacters(in: .newlines)
            guard !text.isEmpty else { continue }
            segments.append(IOSMessageBodySegment(
                id: segments.count,
                kind: isCode ? .code(language: parsed.0) : .prose,
                text: text
            ))
        }

        if segments.isEmpty, !body.isEmpty {
            return [IOSMessageBodySegment(id: 0, kind: .prose, text: body)]
        }
        return segments
    }

    private static func codeBlock(from raw: String) -> (String?, String) {
        guard let newline = raw.firstIndex(of: "\n") else { return (nil, raw) }
        let candidate = raw[..<newline].trimmingCharacters(in: .whitespaces)
        let languageCharacters = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_+-"))
        let isLanguage = !candidate.isEmpty
            && candidate.count <= 24
            && candidate.unicodeScalars.allSatisfy(languageCharacters.contains)
        guard isLanguage else { return (nil, raw) }
        return (candidate, String(raw[raw.index(after: newline)...]))
    }
}

struct IOSTimelineDisplayRow: Identifiable, Sendable, Equatable {
    enum ID: Hashable, Sendable {
        case date(Int64)
        case message(MessageID)
    }

    enum Content: Sendable, Equatable {
        case date(dayStartMs: Int64)
        case message(
            Message,
            startsAuthorGroup: Bool,
            mentionsCurrentMember: Bool,
            bodySegments: [IOSMessageBodySegment]
        )
    }

    let id: ID
    let content: Content
}

enum IOSTimelineLayout {
    static let authorGroupWindowMs: Int64 = 5 * 60 * 1_000

    static func rows(
        for messages: [Message],
        currentMemberID: MemberID,
        calendar: Calendar = .autoupdatingCurrent
    ) -> [IOSTimelineDisplayRow] {
        var rows: [IOSTimelineDisplayRow] = []
        rows.reserveCapacity(messages.count + max(1, messages.count / 20))
        var previousMessage: Message?
        var previousDayStartMs: Int64?

        for message in messages {
            let timestamp = messageTimestamp(message)
            let date = Date(timeIntervalSince1970: Double(timestamp) / 1_000)
            let dayStartMs = Int64(calendar.startOfDay(for: date).timeIntervalSince1970 * 1_000)

            if dayStartMs != previousDayStartMs {
                rows.append(IOSTimelineDisplayRow(
                    id: .date(dayStartMs),
                    content: .date(dayStartMs: dayStartMs)
                ))
            }

            let startsAuthorGroup = previousMessage.map { previous in
                let gap = timestamp - messageTimestamp(previous)
                return previous.authorMemberId != message.authorMemberId
                    || gap < 0
                    || gap > authorGroupWindowMs
                    || dayStartMs != previousDayStartMs
            } ?? true
            let mentionedMemberIDs = message.props["mention_member_ids"]?.arrayValue ?? []
            let mentionsCurrentMember = mentionedMemberIDs.contains { value in
                value.stringValue == currentMemberID.description
            }
            let bodySegments = message.body.map(IOSMessageBodyParser.segments) ?? []
            rows.append(IOSTimelineDisplayRow(
                id: .message(message.id),
                content: .message(
                    message,
                    startsAuthorGroup: startsAuthorGroup,
                    mentionsCurrentMember: mentionsCurrentMember,
                    bodySegments: bodySegments
                )
            ))
            previousMessage = message
            previousDayStartMs = dayStartMs
        }
        return rows
    }

    private static func messageTimestamp(_ message: Message) -> Int64 {
        message.createdAtMs ?? message.hlcTs
    }
}
