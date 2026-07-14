import SwiftUI
import MomoCore

enum MomoQuickSwitcherDestination: Hashable {
    case channel(ChannelID)
    case member(MemberID)
}

struct MomoQuickSwitcherItem: Identifiable, Hashable {
    enum Kind: Hashable {
        case channel(ChannelKind)
        case member(isAgent: Bool)
    }

    var id: MomoQuickSwitcherDestination { destination }
    var destination: MomoQuickSwitcherDestination
    var kind: Kind
    var title: String
    var subtitle: String?
    var capabilities: [String] = []
    var shortcutNumber: Int?
    var isRecent: Bool
    var score: Int

    var systemImage: String {
        switch kind {
        case .channel(.publicChannel): return "number"
        case .channel(.privateChannel): return "lock"
        case .channel(.dm): return "person.2.fill"
        case .member: return "person.fill"
        }
    }
}

struct MomoQuickSwitcherSection: Identifiable, Hashable {
    enum Kind: String, Hashable {
        case recentChannels
        case channels
        case members
    }

    var id: Kind { kind }
    var kind: Kind
    var items: [MomoQuickSwitcherItem]

    func title(copy: MomoWorkspaceCopy) -> String {
        switch kind {
        case .recentChannels: return copy.quickSwitcherRecentChannels
        case .channels: return copy.channels
        case .members: return copy.members
        }
    }
}

enum MomoQuickSwitcherSearch {
    static func sections(
        orderedChannels: [Channel],
        members: [Member],
        recentChannelIds: [ChannelID],
        query: String
    ) -> [MomoQuickSwitcherSection] {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let recentRanks = Dictionary(uniqueKeysWithValues: recentChannelIds.enumerated().map { ($1, $0) })
        let channelNumbers = Dictionary(uniqueKeysWithValues: orderedChannels.prefix(9).enumerated().map { ($1.id, $0 + 1) })

        let channelItems = orderedChannels.compactMap { channel -> MomoQuickSwitcherItem? in
            let presentation = MomoLocalChannelPresentationStore.presentation(for: channel)
            let title = presentation.name
            guard let score = fuzzyScore(
                query: trimmedQuery,
                candidates: [title, presentation.topic, "#\(title)"]
            ) else { return nil }
            return MomoQuickSwitcherItem(
                destination: .channel(channel.id),
                kind: .channel(channel.kind),
                title: channel.kind == .dm ? title : "#\(title)",
                subtitle: presentation.topic,
                shortcutNumber: channelNumbers[channel.id],
                isRecent: recentRanks[channel.id] != nil,
                score: score
            )
        }
        .sorted { lhs, rhs in
            let leftRank = recentRank(for: lhs, ranks: recentRanks)
            let rightRank = recentRank(for: rhs, ranks: recentRanks)
            if leftRank != rightRank { return leftRank < rightRank }
            if lhs.score != rhs.score { return lhs.score > rhs.score }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }

        let memberItems = members.compactMap { member -> MomoQuickSwitcherItem? in
            guard let score = fuzzyScore(
                query: trimmedQuery,
                candidates: [member.displayName, member.handle, "@\(member.handle)"]
            ) else { return nil }
            return MomoQuickSwitcherItem(
                destination: .member(member.id),
                kind: .member(isAgent: member.isAgent),
                title: member.displayName,
                subtitle: "@\(member.handle)",
                capabilities: member.normalizedCapabilities,
                shortcutNumber: nil,
                isRecent: false,
                score: score
            )
        }
        .sorted { lhs, rhs in
            if lhs.score != rhs.score { return lhs.score > rhs.score }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }

        if trimmedQuery.isEmpty {
            let recentItems = channelItems.filter(\.isRecent)
            let otherChannels = channelItems.filter { !$0.isRecent }
            return [
                MomoQuickSwitcherSection(kind: .recentChannels, items: recentItems),
                MomoQuickSwitcherSection(kind: .channels, items: otherChannels),
                MomoQuickSwitcherSection(kind: .members, items: memberItems),
            ]
            .filter { !$0.items.isEmpty }
        }

        return [
            MomoQuickSwitcherSection(kind: .channels, items: channelItems),
            MomoQuickSwitcherSection(kind: .members, items: memberItems),
        ]
        .filter { !$0.items.isEmpty }
    }

    private static func recentRank(
        for item: MomoQuickSwitcherItem,
        ranks: [ChannelID: Int]
    ) -> Int {
        guard case .channel(let id) = item.destination else { return Int.max }
        return ranks[id] ?? Int.max
    }

    private static func fuzzyScore(query: String, candidates: [String?]) -> Int? {
        let needle = normalized(query).filter { !$0.isWhitespace && $0 != "#" && $0 != "@" }
        guard !needle.isEmpty else { return 0 }
        return candidates.compactMap { candidate -> Int? in
            guard let candidate else { return nil }
            return fuzzyScore(needle: needle, haystack: normalized(candidate))
        }.max()
    }

    private static func fuzzyScore(needle: String, haystack: String) -> Int? {
        if haystack.hasPrefix(needle) {
            return 1_000 - max(0, haystack.count - needle.count)
        }
        if let range = haystack.range(of: needle) {
            return 800 - haystack.distance(from: haystack.startIndex, to: range.lowerBound)
        }

        let needleCharacters = Array(needle)
        let haystackCharacters = Array(haystack)
        var needleIndex = needleCharacters.startIndex
        var firstMatch: Int?
        var previousMatch: Int?
        var gapPenalty = 0
        var contiguousBonus = 0

        for (index, character) in haystackCharacters.enumerated() where needleIndex < needleCharacters.endIndex {
            guard character == needleCharacters[needleIndex] else { continue }
            if firstMatch == nil { firstMatch = index }
            if let previousMatch {
                let gap = index - previousMatch - 1
                gapPenalty += gap
                if gap == 0 { contiguousBonus += 12 }
            }
            previousMatch = index
            needleCharacters.formIndex(after: &needleIndex)
        }

        guard needleIndex == needleCharacters.endIndex else { return nil }
        return 400 + contiguousBonus - gapPenalty - (firstMatch ?? 0)
    }

    private static func normalized(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }
}

extension ChatViewModel {
    func quickSwitcherSections(query: String) -> [MomoQuickSwitcherSection] {
        MomoQuickSwitcherSearch.sections(
            orderedChannels: sidebarChannelOrder.orderedChannels,
            members: activeMembers(),
            recentChannelIds: recentChannelIds,
            query: query
        )
    }
}
