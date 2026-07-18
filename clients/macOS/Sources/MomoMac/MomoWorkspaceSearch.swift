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
    static let maximumServerMessageResults = 100

    static func results(
        query: String,
        channels: [Channel],
        members: [Member],
        currentMemberID: MemberID?,
        messagesByChannel: [ChannelID: [Message]],
        serverMessages: [Message]? = nil
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
        let messageSource = serverMessages
            ?? messagesByChannel.values.flatMap { $0 }
        for message in messageSource where visibleChannelIDs.contains(message.channelId) {
            let channelID = message.channelId
            let channelName = channelNames[channelID] ?? "channel"
            if !message.isDeleted,
               let body = message.body,
               matches(needle, values: [body]) {
                messageItems.append(MomoWorkspaceSearchItem(
                    id: "message:\(message.id)",
                    kind: .message,
                    title: messageExcerpt(body, matching: query),
                    subtitle: "#\(channelName)",
                    destination: .message(channelID: channelID, messageID: message.id),
                    isAgent: false
                ))
            }
        }
        for (channelID, messages) in messagesByChannel where visibleChannelIDs.contains(channelID) {
            let channelName = channelNames[channelID] ?? "channel"
            for message in messages where !message.isDeleted {
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
            .message: Array(messageItems.prefix(
                serverMessages == nil ? 20 : maximumServerMessageResults
            )),
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
    @State private var activeSearchToken = UUID()
    @State private var serverMessages: [Message]? = nil
    @State private var nextMessageCursor: String?
    @State private var isSearchingMessages = false
    @State private var isLoadingMoreMessages = false
    @State private var messageSearchError: Error?
    @State private var shouldScrollSelection = false
    @FocusState private var isSearchFocused: Bool

    var body: some View {
        let currentResults = searchResults
        let queryIsEmpty = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let queryNeedsMoreCharacters = !queryIsEmpty
            && query.trimmingCharacters(in: .whitespacesAndNewlines).count < 2
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
            } else if currentResults.isEmpty, queryNeedsMoreCharacters {
                emptyState(
                    title: messageSearchMinimum,
                    detail: localSearchStillAvailable,
                    systemImage: "text.bubble"
                )
            } else if currentResults.isEmpty, isSearchingMessages {
                loadingState
            } else if currentResults.isEmpty, messageSearchError != nil {
                searchErrorState
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
                            if isSearchingMessages {
                                searchProgressRow
                            } else if messageSearchError != nil {
                                searchErrorRow
                            } else if queryNeedsMoreCharacters {
                                Text(messageSearchMinimum)
                                    .font(MomoTheme.Typography.metadata)
                                    .foregroundStyle(.secondary)
                            }
                            if nextMessageCursor != nil {
                                Button {
                                    Task { await loadMoreMessages() }
                                } label: {
                                    if isLoadingMoreMessages {
                                        ProgressView()
                                            .controlSize(.small)
                                    } else {
                                        Label(loadMoreMessagesLabel, systemImage: "arrow.down.circle")
                                    }
                                }
                                .disabled(isLoadingMoreMessages)
                                .accessibilityLabel(loadMoreMessagesLabel)
                                .accessibilityValue(isLoadingMoreMessages ? searchingMessages : "")
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
                Label(searchScope, systemImage: searchScopeSystemImage)
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
        .onChange(of: query) { _, newQuery in
            serverMessages = newQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? nil
                : []
            isSearchingMessages = false
            isLoadingMoreMessages = false
            nextMessageCursor = nil
            messageSearchError = nil
            applyResults()
            scheduleRefresh()
        }
        .onReceive(viewModel.$channels) { _ in applyResults() }
        .onReceive(viewModel.$members) { _ in applyResults() }
        .onReceive(viewModel.$messagesByChannel) { _ in applyResults() }
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

    private var loadingState: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text(searchingMessages)
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(.secondary)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var searchErrorState: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(messageSearchErrorDetail, systemImage: "exclamationmark.triangle")
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(.secondary)
            Button(retrySearch) {
                scheduleRefresh(immediately: true)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var searchProgressRow: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text(searchingMessages)
        }
        .font(MomoTheme.Typography.metadata)
        .foregroundStyle(.secondary)
    }

    private var searchErrorRow: some View {
        HStack(spacing: 8) {
            Text(messageSearchErrorDetail)
                .lineLimit(2)
            Spacer()
            Button(retrySearch) {
                scheduleRefresh(immediately: true)
            }
            .controlSize(.small)
        }
        .font(MomoTheme.Typography.metadata)
        .foregroundStyle(.secondary)
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
                try? await Task.sleep(for: .milliseconds(300))
            }
            guard !Task.isCancelled else { return }
            await refreshResults()
        }
    }

    private func refreshResults() async {
        let requestedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let searchToken = UUID()
        activeSearchToken = searchToken
        serverMessages = requestedQuery.isEmpty ? nil : []
        nextMessageCursor = nil
        isSearchingMessages = requestedQuery.count >= 2
        messageSearchError = nil
        applyResults()

        guard requestedQuery.count >= 2 else { return }
        do {
            let page = try await viewModel.searchWorkspaceMessagePage(
                query: requestedQuery,
                cursor: nil
            )
            guard !Task.isCancelled,
                  activeSearchToken == searchToken,
                  query.trimmingCharacters(in: .whitespacesAndNewlines) == requestedQuery
            else { return }
            serverMessages = page.messages
            nextMessageCursor = page.nextCursor
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled,
                  activeSearchToken == searchToken,
                  query.trimmingCharacters(in: .whitespacesAndNewlines) == requestedQuery
            else { return }
            messageSearchError = error
        }
        isSearchingMessages = false
        applyResults()
    }

    private func loadMoreMessages() async {
        guard let cursor = nextMessageCursor,
              !isLoadingMoreMessages
        else { return }
        let requestedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let searchToken = activeSearchToken
        isLoadingMoreMessages = true
        messageSearchError = nil
        defer {
            if activeSearchToken == searchToken {
                isLoadingMoreMessages = false
            }
        }
        do {
            let page = try await viewModel.searchWorkspaceMessagePage(
                query: requestedQuery,
                cursor: cursor
            )
            guard !Task.isCancelled,
                  activeSearchToken == searchToken,
                  query.trimmingCharacters(in: .whitespacesAndNewlines) == requestedQuery,
                  nextMessageCursor == cursor
            else { return }
            var seen = Set((serverMessages ?? []).map(\.id))
            let additional = page.messages.filter { seen.insert($0.id).inserted }
            let combined = (serverMessages ?? []) + additional
            serverMessages = Array(combined.prefix(MomoWorkspaceSearchIndex.maximumServerMessageResults))
            nextMessageCursor = combined.count >= MomoWorkspaceSearchIndex.maximumServerMessageResults
                ? nil
                : page.nextCursor
            applyResults()
        } catch is CancellationError {
            return
        } catch {
            guard activeSearchToken == searchToken,
                  query.trimmingCharacters(in: .whitespacesAndNewlines) == requestedQuery,
                  nextMessageCursor == cursor
            else { return }
            messageSearchError = error
            applyResults()
        }
    }

    private func applyResults() {
        searchResults = MomoWorkspaceSearchIndex.results(
            query: query,
            channels: viewModel.channels,
            members: viewModel.members,
            currentMemberID: viewModel.currentNavigationMemberID,
            messagesByChannel: viewModel.messagesByChannel,
            serverMessages: serverMessages
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
    private var searchHint: String { isKorean ? "워크스페이스 메시지와 이 Mac에 불러온 파일 이름을 한곳에서 찾습니다." : "Find workspace messages and file names loaded on this Mac." }
    private var noResults: String { isKorean ? "검색 결과 없음" : "No results" }
    private var searchScope: String {
        if viewModel.usesServerWorkspaceMessageSearch {
            return isKorean
                ? "워크스페이스 메시지 · 이 Mac에 불러온 파일"
                : "Workspace messages · Files loaded on this Mac"
        }
        return isKorean
            ? "이 Mac에 불러온 대화와 파일"
            : "Conversations and files loaded on this Mac"
    }
    private var searchScopeSystemImage: String {
        viewModel.usesServerWorkspaceMessageSearch ? "server.rack" : "macbook"
    }
    private var searchingMessages: String { isKorean ? "워크스페이스 메시지 검색 중" : "Searching workspace messages" }
    private var loadMoreMessagesLabel: String { isKorean ? "메시지 더 보기" : "Load more messages" }
    private var messageSearchMinimum: String { isKorean ? "메시지는 두 글자 이상 입력해 검색하세요" : "Enter at least two characters to search messages" }
    private var localSearchStillAvailable: String { isKorean ? "채널, 멤버와 불러온 파일 이름은 한 글자부터 검색할 수 있습니다." : "Channels, members, and loaded file names can be searched with one character." }
    private var retrySearch: String { isKorean ? "검색 다시 시도" : "Retry search" }
    private var messageSearchErrorDetail: String {
        if let backendError = messageSearchError as? BackendError,
           backendError == .notConnected {
            return isKorean
                ? "서버에 연결한 뒤 워크스페이스 메시지를 검색할 수 있습니다."
                : "Connect to the server to search workspace messages."
        }
        return isKorean
            ? "메시지 검색 결과를 불러오지 못했습니다. 다시 시도해 주세요."
            : "Message search results could not be loaded. Try again."
    }
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
