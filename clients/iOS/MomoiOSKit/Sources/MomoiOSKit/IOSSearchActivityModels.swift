import Foundation
import MomoCore
import Observation

public struct IOSWorkspaceMessageSearchHit: Identifiable, Sendable, Hashable {
    public let channelID: ChannelID
    public let messageID: MessageID
    public let sequence: Int64
    public let authorMemberID: MemberID
    public let createdAtMs: Int64
    public let snippet: String
    public let matchOffset: Int

    public var id: MessageID { messageID }
}

public struct IOSWorkspaceMessageSearchPage: Sendable, Hashable {
    public let hits: [IOSWorkspaceMessageSearchHit]
    public let nextCursor: String?

    public init(hits: [IOSWorkspaceMessageSearchHit], nextCursor: String?) {
        self.hits = hits
        self.nextCursor = nextCursor
    }
}

public enum IOSSearchSnippet {
    public static func segments(
        snippet: String,
        matchOffset: Int,
        matchLength: Int
    ) -> (prefix: String, match: String, suffix: String) {
        guard matchOffset >= 0,
              matchLength > 0,
              matchOffset <= snippet.count else {
            return (snippet, "", "")
        }
        let start = snippet.index(snippet.startIndex, offsetBy: matchOffset)
        let end = snippet.index(start, offsetBy: min(matchLength, snippet.distance(from: start, to: snippet.endIndex)))
        return (
            String(snippet[..<start]),
            String(snippet[start..<end]),
            String(snippet[end...])
        )
    }
}

@MainActor
@Observable
public final class IOSWorkspaceSearchModel {
    public enum Phase: Equatable {
        case idle
        case searching
        case loaded
    }

    public private(set) var phase: Phase = .idle
    public private(set) var hits: [IOSWorkspaceMessageSearchHit] = []
    public private(set) var failureMessage: String?
    public private(set) var hasMore = false
    public private(set) var normalizedQuery = ""

    private let backend: any IOSConversationBackend
    private var nextCursor: String?
    private var generation = 0
    private var debounceTask: Task<Void, Never>?

    public init(backend: any IOSConversationBackend) {
        self.backend = backend
    }

    public func schedule(query: String) {
        generation += 1
        let scheduledGeneration = generation
        debounceTask?.cancel()
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized.count >= 2 else {
            normalizedQuery = normalized
            hits = []
            nextCursor = nil
            hasMore = false
            failureMessage = nil
            phase = .idle
            return
        }
        phase = .searching
        debounceTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await self?.perform(query: normalized, generation: scheduledGeneration, appending: false)
        }
    }

    public func retry() async {
        guard normalizedQuery.count >= 2 else { return }
        generation += 1
        await perform(query: normalizedQuery, generation: generation, appending: false)
    }

    public func loadMore() async {
        guard phase != .searching,
              hasMore,
              let nextCursor,
              normalizedQuery.count >= 2 else { return }
        generation += 1
        await perform(
            query: normalizedQuery,
            cursor: nextCursor,
            generation: generation,
            appending: true
        )
    }

    private func perform(
        query: String,
        cursor: String? = nil,
        generation: Int,
        appending: Bool
    ) async {
        phase = .searching
        failureMessage = nil
        do {
            let page = try await backend.searchMessages(query: query, cursor: cursor, limit: 20)
            guard self.generation == generation else { return }
            normalizedQuery = query
            if appending {
                var seen = Set(hits.map(\.messageID))
                hits.append(contentsOf: page.hits.filter { seen.insert($0.messageID).inserted })
            } else {
                hits = page.hits
            }
            nextCursor = page.nextCursor
            hasMore = page.nextCursor != nil
            phase = .loaded
        } catch is CancellationError {
            return
        } catch {
            guard self.generation == generation else { return }
            normalizedQuery = query
            failureMessage = "Search could not be refreshed. Existing results are preserved."
            phase = hits.isEmpty ? .idle : .loaded
        }
    }
}

public struct IOSActivityItem: Identifiable, Sendable, Hashable {
    public enum Kind: Sendable, Hashable {
        case mention
        case reaction(emoji: String, count: Int)
    }

    public let id: String
    public let kind: Kind
    public let channelID: ChannelID
    public let messageID: MessageID
    public let sequence: Int64
    public let authorMemberID: MemberID
    public let createdAtMs: Int64
    public let preview: String
}

public enum IOSActivityAggregator {
    public static func recentItems(
        messagesByChannel: [ChannelID: [Message]],
        reactionsByChannel: [ChannelID: [MessageID: [String: Set<MemberID>]]],
        currentMemberID: MemberID
    ) -> [IOSActivityItem] {
        var items: [IOSActivityItem] = []
        let normalizedCurrentID = currentMemberID.description.lowercased()
        for (channelID, messages) in messagesByChannel {
            let reactions = reactionsByChannel[channelID] ?? [:]
            for message in messages where !message.isDeleted && message.rootId == nil {
                guard let sequence = message.seq else { continue }
                let createdAt = message.createdAtMs ?? message.hlcTs
                let preview = message.body?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Message"
                let mentionsCurrentMember = message.authorMemberId != currentMemberID
                    && (message.props["mention_member_ids"]?.arrayValue ?? []).contains { value in
                        value.stringValue?.lowercased() == normalizedCurrentID
                    }
                if mentionsCurrentMember {
                    items.append(IOSActivityItem(
                        id: "mention:\(message.id.description.lowercased())",
                        kind: .mention,
                        channelID: channelID,
                        messageID: message.id,
                        sequence: sequence,
                        authorMemberID: message.authorMemberId,
                        createdAtMs: createdAt,
                        preview: preview
                    ))
                }
                guard message.authorMemberId == currentMemberID else { continue }
                for (emoji, memberIDs) in reactions[message.id] ?? [:] {
                    let others = memberIDs.filter { $0 != currentMemberID }
                    guard !others.isEmpty else { continue }
                    items.append(IOSActivityItem(
                        id: "reaction:\(message.id.description.lowercased()):\(emoji)",
                        kind: .reaction(emoji: emoji, count: others.count),
                        channelID: channelID,
                        messageID: message.id,
                        sequence: sequence,
                        authorMemberID: message.authorMemberId,
                        createdAtMs: createdAt,
                        preview: preview
                    ))
                }
            }
        }
        return items.sorted {
            if $0.createdAtMs != $1.createdAtMs { return $0.createdAtMs > $1.createdAtMs }
            return $0.id < $1.id
        }
    }
}

@MainActor
@Observable
public final class IOSActivityModel {
    public private(set) var items: [IOSActivityItem] = []
    public private(set) var isLoading = false
    public private(set) var failureMessage: String?

    private let backend: any IOSConversationBackend
    private let currentMemberID: MemberID

    public init(backend: any IOSConversationBackend, currentMemberID: MemberID) {
        self.backend = backend
        self.currentMemberID = currentMemberID
    }

    public func refresh(channelIDs: [ChannelID]) async {
        guard !isLoading else { return }
        isLoading = true
        failureMessage = nil
        defer { isLoading = false }
        do {
            var messagesByChannel: [ChannelID: [Message]] = [:]
            var reactionsByChannel: [ChannelID: [MessageID: [String: Set<MemberID>]]] = [:]
            try await withThrowingTaskGroup(
                of: (ChannelID, [Message], [MessageID: [String: Set<MemberID>]]).self
            ) { group in
                for channelID in channelIDs {
                    group.addTask { [backend] in
                        async let messages = backend.history(channel: channelID, after: nil, limit: 200)
                        async let reactions = backend.reactionSnapshot(channel: channelID)
                        return try await (channelID, messages, reactions)
                    }
                }
                for try await (channelID, messages, reactions) in group {
                    messagesByChannel[channelID] = messages
                    reactionsByChannel[channelID] = reactions
                }
            }
            items = IOSActivityAggregator.recentItems(
                messagesByChannel: messagesByChannel,
                reactionsByChannel: reactionsByChannel,
                currentMemberID: currentMemberID
            )
        } catch is CancellationError {
            return
        } catch {
            failureMessage = "Activity could not be refreshed. Existing items are preserved."
        }
    }
}
