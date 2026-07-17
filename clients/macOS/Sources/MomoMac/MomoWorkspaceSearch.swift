import SwiftUI
import MomoCore

enum MomoWorkspaceSearchDestination: Hashable {
    case channel(ChannelID)
    case member(MemberID)
    case message(channelID: ChannelID, messageID: MessageID)
}

struct MomoWorkspaceSearchItem: Identifiable, Hashable {
    enum Kind: String, CaseIterable, Hashable {
        case channel
        case member
        case message
        case file
    }

    let id: String
    let kind: Kind
    let title: String
    let subtitle: String
    let destination: MomoWorkspaceSearchDestination
    let isAgent: Bool

    var systemImage: String {
        switch kind {
        case .channel: return "number"
        case .member: return "person"
        case .message: return "text.bubble"
        case .file: return "doc"
        }
    }
}

enum MomoWorkspaceSearchIndex {
    static func results(
        query: String,
        channels: [Channel],
        members: [Member],
        currentMemberID: MemberID?,
        messagesByChannel: [ChannelID: [Message]]
    ) -> [MomoWorkspaceSearchItem.Kind: [MomoWorkspaceSearchItem]] {
        let needle = normalized(query)
        guard !needle.isEmpty else { return [:] }

        let channelNames = Dictionary(uniqueKeysWithValues: channels.map { channel in
            (channel.id, MomoChannelDisplayPolicy.name(
                for: channel,
                members: members,
                currentMemberID: currentMemberID
            ))
        })

        let channelItems = channels.compactMap { channel -> MomoWorkspaceSearchItem? in
            let name = channelNames[channel.id] ?? channel.name ?? "channel"
            let topic = MomoLocalChannelPresentationStore.presentation(for: channel).topic
            guard matches(needle, values: [name, topic]) else { return nil }
            return MomoWorkspaceSearchItem(
                id: "channel:\(channel.id)",
                kind: .channel,
                title: channel.kind == .dm ? name : "#\(name)",
                subtitle: topic ?? "",
                destination: .channel(channel.id),
                isAgent: false
            )
        }

        let memberItems = members.compactMap { member -> MomoWorkspaceSearchItem? in
            guard member.status == .active,
                  matches(needle, values: [member.displayName, member.handle])
            else { return nil }
            return MomoWorkspaceSearchItem(
                id: "member:\(member.id)",
                kind: .member,
                title: member.displayName,
                subtitle: "@\(member.handle)",
                destination: .member(member.id),
                isAgent: member.isAgent
            )
        }

        let visibleChannelIDs = Set(channels.map(\.id))
        var messageItems: [MomoWorkspaceSearchItem] = []
        var fileItems: [MomoWorkspaceSearchItem] = []
        for (channelID, messages) in messagesByChannel where visibleChannelIDs.contains(channelID) {
            let channelName = channelNames[channelID] ?? "channel"
            for message in messages where !message.isDeleted {
                if let body = message.body, matches(needle, values: [body]) {
                    messageItems.append(MomoWorkspaceSearchItem(
                        id: "message:\(message.id)",
                        kind: .message,
                        title: messageExcerpt(body, matching: query),
                        subtitle: "#\(channelName)",
                        destination: .message(channelID: channelID, messageID: message.id),
                        isAgent: false
                    ))
                }
                for (attachmentIndex, filename) in attachmentNames(in: message.props).enumerated()
                    where matches(needle, values: [filename]) {
                    fileItems.append(MomoWorkspaceSearchItem(
                        id: "file:\(message.id):\(attachmentIndex):\(filename)",
                        kind: .file,
                        title: filename,
                        subtitle: "#\(channelName)",
                        destination: .message(channelID: channelID, messageID: message.id),
                        isAgent: false
                    ))
                }
            }
        }

        return [
            .channel: Array(channelItems.prefix(8)),
            .member: Array(memberItems.prefix(8)),
            .message: Array(messageItems.prefix(20)),
            .file: Array(fileItems.prefix(12)),
        ].filter { !$0.value.isEmpty }
    }

    private static func matches(_ needle: String, values: [String?]) -> Bool {
        values.compactMap { $0 }.contains { normalized($0).contains(needle) }
    }

    private static func normalized(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }

    private static func messageExcerpt(_ body: String, matching query: String) -> String {
        let lines = body.components(separatedBy: .newlines)
        let matchedLine = lines.first { matches(normalized(query), values: [$0]) } ?? body
        let compact = matchedLine
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        guard let range = compact.range(
            of: query.trimmingCharacters(in: .whitespacesAndNewlines),
            options: [.caseInsensitive, .diacriticInsensitive]
        ) else {
            return compact
        }
        let start = compact.index(range.lowerBound, offsetBy: -48, limitedBy: compact.startIndex) ?? compact.startIndex
        let end = compact.index(range.upperBound, offsetBy: 96, limitedBy: compact.endIndex) ?? compact.endIndex
        let prefix = start == compact.startIndex ? "" : "…"
        let suffix = end == compact.endIndex ? "" : "…"
        return prefix + String(compact[start..<end]) + suffix
    }

    private static func attachmentNames(in json: JSON) -> [String] {
        guard case .object(let props) = json,
              let attachments = props["attachments"] else { return [] }
        let records: [JSON]
        if case .array(let values) = attachments {
            records = values
        } else {
            records = [attachments]
        }
        return records.compactMap { record in
            guard case .object(let object) = record else { return nil }
            return object["filename"]?.stringValue ?? object["file_name"]?.stringValue
        }
    }
}

struct MomoWorkspaceSearchView: View {
    @ObservedObject var viewModel: ChatViewModel
    let copy: MomoWorkspaceCopy
    let activate: (MomoWorkspaceSearchDestination) -> Void
    let dismiss: () -> Void
    @State private var query = ""
    @State private var selectedItemID: String?
    @State private var searchResults: [MomoWorkspaceSearchItem.Kind: [MomoWorkspaceSearchItem]] = [:]
    @State private var refreshTask: Task<Void, Never>?
    @State private var shouldScrollSelection = false
    @FocusState private var isSearchFocused: Bool

    var body: some View {
        let currentResults = searchResults
        let queryIsEmpty = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let orderedItems = queryIsEmpty ? recentChannelItems : flattened(currentResults)
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField(searchPlaceholder, text: $query)
                    .textFieldStyle(.plain)
                    .font(MomoTheme.Typography.row)
                    .focused($isSearchFocused)
                    .onSubmit { activateSelected(from: orderedItems) }
                    .onKeyPress(.upArrow) {
                        moveSelection(in: orderedItems, offset: -1)
                        return .handled
                    }
                    .onKeyPress(.downArrow) {
                        moveSelection(in: orderedItems, offset: 1)
                        return .handled
                    }
                    .onKeyPress(.escape) {
                        dismiss()
                        return .handled
                    }
                Text("esc")
                    .font(MomoTheme.Typography.metadata.monospaced())
                    .foregroundStyle(.tertiary)
            }
            .padding(16)

            Divider()

            if queryIsEmpty {
                if recentChannelItems.isEmpty {
                    emptyState(title: searchTitle, detail: searchHint, systemImage: "magnifyingglass")
                } else {
                    ScrollViewReader { proxy in
                        ScrollView {
                            section(.channel, items: recentChannelItems)
                                .padding(16)
                        }
                        .onChange(of: selectedItemID) { _, itemID in
                            guard shouldScrollSelection, let itemID else { return }
                            shouldScrollSelection = false
                            proxy.scrollTo(itemID, anchor: .center)
                        }
                    }
                }
            } else if currentResults.isEmpty {
                emptyState(title: noResults, detail: query, systemImage: "magnifyingglass")
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 16) {
                            ForEach(MomoWorkspaceSearchItem.Kind.allCases, id: \.self) { kind in
                                if let items = currentResults[kind], !items.isEmpty {
                                    section(kind, items: items)
                                }
                            }
                        }
                        .padding(16)
                    }
                    .onChange(of: selectedItemID) { _, itemID in
                        guard shouldScrollSelection, let itemID else { return }
                        shouldScrollSelection = false
                        proxy.scrollTo(itemID, anchor: .center)
                    }
                }
            }

            Divider()
            HStack {
                Label(localScope, systemImage: "macbook")
                Spacer()
                Text("⌘F")
            }
            .font(MomoTheme.Typography.metadata)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 16)
            .frame(height: 32)
        }
        .frame(
            minWidth: MomoTheme.WorkspaceSearch.minimumWidth,
            idealWidth: MomoTheme.WorkspaceSearch.idealWidth,
            maxWidth: MomoTheme.WorkspaceSearch.maximumWidth,
            minHeight: MomoTheme.WorkspaceSearch.minimumHeight,
            idealHeight: MomoTheme.WorkspaceSearch.idealHeight,
            maxHeight: MomoTheme.WorkspaceSearch.maximumHeight
        )
        .momoSurface(.background, cornerRadius: MomoTheme.cornerLarge)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityLabel(searchTitle)
        .onAppear {
            isSearchFocused = true
            scheduleRefresh(immediately: true)
        }
        .onChange(of: query) { _, _ in
            scheduleRefresh()
        }
        .onReceive(viewModel.$channels) { _ in scheduleRefresh() }
        .onReceive(viewModel.$members) { _ in scheduleRefresh() }
        .onReceive(viewModel.$messagesByChannel) { _ in scheduleRefresh() }
        .onDisappear { refreshTask?.cancel() }
        .onMoveCommand { direction in
            switch direction {
            case .up: moveSelection(in: orderedItems, offset: -1)
            case .down: moveSelection(in: orderedItems, offset: 1)
            default: break
            }
        }
        .onExitCommand(perform: dismiss)
    }

    private func section(_ kind: MomoWorkspaceSearchItem.Kind, items: [MomoWorkspaceSearchItem]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(sectionTitle(kind))
                .font(MomoTheme.Typography.metadata.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(items) { item in
                Button {
                    activate(item.destination)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: item.isAgent ? "cpu" : item.systemImage)
                            .frame(width: MomoTheme.WorkspaceSearch.iconWidth)
                            .foregroundStyle(item.isAgent ? MomoTheme.agentAccent : .secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title)
                                .font(MomoTheme.Typography.row)
                                .foregroundStyle(.primary)
                                .lineLimit(kind == .message ? 2 : 1)
                            Text(item.subtitle)
                                .font(MomoTheme.Typography.metadata)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 8)
                    .frame(minHeight: MomoTheme.WorkspaceSearch.rowMinimumHeight)
                    .contentShape(Rectangle())
                    .background(
                        selectedItemID == item.id ? MomoTheme.selectionBackground : Color.clear,
                        in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall, style: .continuous)
                    )
                }
                .buttonStyle(.plain)
                .id(item.id)
                .accessibilityValue(selectedItemID == item.id ? selectedLabel : "")
                .onHover { isHovering in
                    if isHovering { selectedItemID = item.id }
                }
            }
        }
    }

    private func emptyState(title: String, detail: String, systemImage: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: systemImage)
                .font(MomoTheme.Typography.emphasizedRow)
            Text(detail)
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(.secondary)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var recentChannelItems: [MomoWorkspaceSearchItem] {
        let rank = Dictionary(uniqueKeysWithValues: viewModel.recentChannelIds.enumerated().map { ($1, $0) })
        let channels = viewModel.channels.sorted { lhs, rhs in
            let lhsRank = rank[lhs.id] ?? Int.max
            let rhsRank = rank[rhs.id] ?? Int.max
            if lhsRank != rhsRank { return lhsRank < rhsRank }
            return (lhs.name ?? "").localizedCaseInsensitiveCompare(rhs.name ?? "") == .orderedAscending
        }
        return channels.prefix(6).map { channel in
            let name = MomoChannelDisplayPolicy.name(
                for: channel,
                members: viewModel.members,
                currentMemberID: viewModel.currentNavigationMemberID
            )
            return MomoWorkspaceSearchItem(
                id: "recent-channel:\(channel.id)",
                kind: .channel,
                title: channel.kind == .dm ? name : "#\(name)",
                subtitle: channel.kind == .dm ? directMessageLabel : recentChannelLabel,
                destination: .channel(channel.id),
                isAgent: false
            )
        }
    }

    private func scheduleRefresh(immediately: Bool = false) {
        refreshTask?.cancel()
        refreshTask = Task { @MainActor in
            if !immediately {
                try? await Task.sleep(for: .milliseconds(120))
            }
            guard !Task.isCancelled else { return }
            refreshResults()
        }
    }

    private func refreshResults() {
        searchResults = MomoWorkspaceSearchIndex.results(
            query: query,
            channels: viewModel.channels,
            members: viewModel.members,
            currentMemberID: viewModel.currentNavigationMemberID,
            messagesByChannel: viewModel.messagesByChannel
        )
        let items = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? recentChannelItems
            : flattened(searchResults)
        if !items.contains(where: { $0.id == selectedItemID }) {
            selectedItemID = items.first?.id
        }
    }

    private func flattened(
        _ results: [MomoWorkspaceSearchItem.Kind: [MomoWorkspaceSearchItem]]
    ) -> [MomoWorkspaceSearchItem] {
        MomoWorkspaceSearchItem.Kind.allCases.flatMap { results[$0] ?? [] }
    }

    private func moveSelection(in items: [MomoWorkspaceSearchItem], offset: Int) {
        guard !items.isEmpty else { selectedItemID = nil; return }
        let current = items.firstIndex { $0.id == selectedItemID } ?? 0
        let nextID = items[(current + offset + items.count) % items.count].id
        shouldScrollSelection = nextID != selectedItemID
        selectedItemID = nextID
    }

    private func activateSelected(from items: [MomoWorkspaceSearchItem]) {
        guard let item = items.first(where: { $0.id == selectedItemID }) ?? items.first else { return }
        activate(item.destination)
    }

    private var isKorean: Bool { copy.language == .korean }
    private var searchTitle: String { isKorean ? "워크스페이스 검색" : "Search workspace" }
    private var searchPlaceholder: String { isKorean ? "채널, 멤버, 메시지 또는 파일 검색" : "Search channels, members, messages, or files" }
    private var searchHint: String { isKorean ? "이 Mac에 불러온 대화와 파일 이름을 한곳에서 찾습니다." : "Find conversations and file names loaded on this Mac." }
    private var noResults: String { isKorean ? "검색 결과 없음" : "No results" }
    private var localScope: String { isKorean ? "현재 불러온 대화에서 검색" : "Searching loaded conversations" }
    private var selectedLabel: String { isKorean ? "선택됨" : "Selected" }
    private var recentChannelLabel: String { isKorean ? "최근 채널" : "Recent channel" }
    private var directMessageLabel: String { isKorean ? "다이렉트 메시지" : "Direct message" }

    private func sectionTitle(_ kind: MomoWorkspaceSearchItem.Kind) -> String {
        switch kind {
        case .channel: return isKorean ? "채널" : "Channels"
        case .member: return isKorean ? "멤버와 에이전트" : "Members and agents"
        case .message: return isKorean ? "메시지" : "Messages"
        case .file: return isKorean ? "파일" : "Files"
        }
    }
}
