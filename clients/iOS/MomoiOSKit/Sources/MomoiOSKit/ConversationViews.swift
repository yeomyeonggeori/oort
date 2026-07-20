#if os(iOS)
import Foundation
import MomoCore
import SwiftUI
import UIKit

@MainActor
struct IOSChannelHomeView: View {
    private let session: IOSSession
    private let bootstrap: WorkspaceBootstrap
    private let backend: any IOSConversationBackend
    private let huddleService: any IOSHuddleService
    let model: IOSChannelListModel

    init(
        session: IOSSession,
        bootstrap: WorkspaceBootstrap,
        model: IOSChannelListModel,
        backend: any IOSConversationBackend,
        huddleService: any IOSHuddleService
    ) {
        self.session = session
        self.bootstrap = bootstrap
        self.model = model
        self.backend = backend
        self.huddleService = huddleService
    }

    var body: some View {
        List {
            Section {
                NavigationLink {
                    IOSThreadsPlaceholderView()
                } label: {
                    Label("Threads", systemImage: "bubble.left.and.text.bubble.right")
                        .font(.body.weight(.medium))
                }
                .accessibilityIdentifier("threadsEntry")
            }
            switch model.phase {
            case .loading:
                loadingRows
            case .failed(let failure):
                failureRow(failure)
            case .loaded:
                loadedSections
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(bootstrap.workspace.name)
        .refreshable { await model.refresh() }
        .onAppear {
            if model.phase == .loaded {
                Task { await model.refresh() }
            }
        }
        .alert(
            "Channel update failed",
            isPresented: Binding(
                get: { model.actionFailureMessage != nil },
                set: { isPresented in
                    if !isPresented { model.clearActionFailure() }
                }
            )
        ) {
            Button("Dismiss", role: .cancel) { model.clearActionFailure() }
        } message: {
            Text(model.actionFailureMessage ?? "Try again.")
        }
        .navigationDestination(for: IOSPushDeepLink.self) { link in
            if let item = deepLinkedItem(channelID: link.channelID) {
                IOSConversationDestination(
                    item: item,
                    members: model.membersByID,
                    channelListModel: model,
                    currentMemberID: session.member.id,
                    backend: backend,
                    workspace: session.workspaceID,
                    huddleService: huddleService
                )
            } else {
                ContentUnavailableView(
                    "Conversation unavailable",
                    systemImage: "bell.slash",
                    description: Text("This notification points to a conversation you cannot open.")
                )
            }
        }
    }

    private var loadingRows: some View {
        Section("Channels") {
            ForEach(0..<4, id: \.self) { _ in
                Label("Loading channel", systemImage: "number")
                    .redacted(reason: .placeholder)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Loading channels")
    }

    @ViewBuilder
    private var loadedSections: some View {
        if model.sections.channels.isEmpty && model.sections.directMessages.isEmpty {
            Section {
                ContentUnavailableView {
                    Label("No conversations yet", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Create a channel or start a direct message in momo on Mac.")
                } actions: {
                    Button("Refresh conversations") { Task { await model.refresh() } }
                }
            }
        } else {
            Section("Channels") {
                if model.sections.channels.isEmpty {
                    Label("No channels yet", systemImage: "number")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.sections.channels) { item in channelLink(item) }
                }
            }
            Section("Direct Messages") {
                if model.sections.directMessages.isEmpty {
                    Label("No direct messages yet", systemImage: "bubble.left.and.bubble.right")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.sections.directMessages) { item in channelLink(item) }
                }
            }
        }
    }

    private func failureRow(_ failure: IOSChannelListModel.Failure) -> some View {
        Section(failure.isOffline ? "Offline" : "Channel issue") {
            ContentUnavailableView {
                Label(
                    failure.isOffline ? "You are offline" : "Could not load conversations",
                    systemImage: failure.isOffline ? "wifi.slash" : "exclamationmark.triangle"
                )
            } description: {
                Text(failure.message)
            } actions: {
                Button("Retry loading conversations") {
                    Task { await model.load() }
                }
                .accessibilityIdentifier("retryChannels")
            }
        }
    }

    @ViewBuilder
    private func channelLink(_ item: IOSChannelListItem) -> some View {
        let link = NavigationLink {
            IOSConversationDestination(
                item: item,
                members: model.membersByID,
                channelListModel: model,
                currentMemberID: session.member.id,
                backend: backend,
                workspace: session.workspaceID,
                huddleService: huddleService
            )
        } label: {
            IOSChannelRow(item: item)
        }
        .contextMenu {
            Button {
                Task { await model.setChannelMuted(item.id, muted: !item.isMuted) }
            } label: {
                Label(
                    item.isMuted ? "Unmute notifications" : "Mute notifications",
                    systemImage: item.isMuted ? "bell" : "bell.slash"
                )
            }
            .disabled(model.isMutating(item.id))

            Button {
                Task { await model.markRead(item.id) }
            } label: {
                Label("Mark as read", systemImage: "checkmark.circle")
            }
            .disabled(!item.hasUnread || model.isMutating(item.id))
        }
        .accessibilityAction(named: item.isMuted ? "Unmute notifications" : "Mute notifications") {
            Task { await model.setChannelMuted(item.id, muted: !item.isMuted) }
        }
        .accessibilityIdentifier("channel.\(item.id.description)")

        if item.hasUnread {
            link.accessibilityAction(named: "Mark as read") {
                Task { await model.markRead(item.id) }
            }
        } else {
            link
        }
    }

    private func deepLinkedItem(channelID: ChannelID) -> IOSChannelListItem? {
        if let item = (model.sections.channels + model.sections.directMessages).first(where: { $0.id == channelID }) {
            return item
        }
        guard let channel = bootstrap.channels.first(where: { $0.id == channelID }) else { return nil }
        let title = channel.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        return IOSChannelListItem(
            channel: channel,
            title: title?.isEmpty == false ? title! : "Conversation",
            unreadCount: 0,
            mentionCount: 0
        )
    }
}

struct IOSChannelRow: View {
    let item: IOSChannelListItem
    @ScaledMetric(relativeTo: .body) private var avatarSize = 32.0
    @ScaledMetric(relativeTo: .caption) private var presenceSize = 8.0

    var body: some View {
        HStack(spacing: 12) {
            leadingIcon
            Text(item.title)
                .font(.body.weight(item.hasUnread ? .semibold : .regular))
                .lineLimit(2)
            Spacer(minLength: 8)
            if item.isMuted {
                Image(systemName: "bell.slash")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            if let badge = item.badgeLabel {
                Text(badge)
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .foregroundStyle(.tint)
                    .background(.quaternary, in: Capsule())
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    @ViewBuilder
    private var leadingIcon: some View {
        if item.isDirectMessage {
            ZStack(alignment: .bottomTrailing) {
                Circle()
                    .fill(.quaternary)
                    .frame(width: avatarSize, height: avatarSize)
                    .overlay {
                        Text(String(item.title.prefix(1)).uppercased())
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                if let presence = item.directMessagePresence {
                    Circle()
                        .fill(presenceColor(presence))
                        .frame(width: presenceSize, height: presenceSize)
                }
            }
            .accessibilityHidden(true)
        } else {
            Image(systemName: channelIcon)
                .frame(width: 24)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        }
    }

    private func presenceColor(_ presence: Presence) -> Color {
        switch presence {
        case .online:
            return .green
        case .away:
            return .orange
        case .working:
            return .accentColor
        case .offline:
            return .secondary
        }
    }

    private var channelIcon: String {
        item.channel.kind == .privateChannel ? "lock" : "number"
    }

    private var accessibilityLabel: String {
        var parts = [item.title]
        if item.isDirectMessage, let presence = item.directMessagePresence {
            parts.append(presence == .working ? "working" : presence.rawValue)
        }
        if item.isMuted { parts.append("notifications muted") }
        guard item.unreadCount > 0 else { return parts.joined(separator: ", ") }
        parts.append("\(item.unreadCount) unread")
        if item.mentionCount > 0 {
            parts.append("\(item.mentionCount) mentions")
        }
        return parts.joined(separator: ", ")
    }
}

@MainActor
struct IOSTimelineView: View {
    let item: IOSChannelListItem
    let members: [MemberID: Member]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: IOSTimelineModel
    @State private var visibleMessageIDs: Set<MessageID> = []
    @State private var presentedHuddle: IOSHuddle?

    init(
        item: IOSChannelListItem,
        members: [MemberID: Member],
        currentMemberID: MemberID,
        backend: any IOSConversationBackend,
        workspace: WorkspaceID,
        huddleService: any IOSHuddleService,
        onReadState: ((ChannelReadState) -> Void)? = nil
    ) {
        self.item = item
        self.members = members
        _model = State(initialValue: IOSTimelineModel(
            channel: item.id,
            currentMemberID: currentMemberID,
            backend: backend,
            workspace: workspace,
            huddleService: huddleService,
            onReadState: onReadState
        ))
    }

    var body: some View {
        ScrollViewReader { proxy in
            List {
                if let activeHuddle = model.huddle.activeHuddle {
                    huddleBanner(activeHuddle)
                }
                if model.realtimeStatus.isFallbackActive, model.phase == .loaded {
                    offlineBanner
                }
                switch model.phase {
                case .loading:
                    loadingMessages
                case .failed(let failure):
                    timelineFailure(failure)
                case .loaded where model.messages.isEmpty:
                    Section {
                        ContentUnavailableView(
                            "No messages yet",
                            systemImage: "bubble.left",
                            description: Text("Write the first message below.")
                        )
                    }
                case .loaded:
                    ForEach(model.presentationRows) { row in
                        timelineRow(row)
                    }
                }
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: model.messages.last?.id) { previousMessageID, latestMessageID in
                guard let latestMessageID else { return }
                guard previousMessageID == nil
                    || previousMessageID.map(visibleMessageIDs.contains) == true
                else { return }
                if reduceMotion {
                    proxy.scrollTo(latestMessageID, anchor: .bottom)
                } else {
                    withAnimation(.snappy) {
                        proxy.scrollTo(latestMessageID, anchor: .bottom)
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            IOSMessageComposer(model: model)
        }
        .listStyle(.plain)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.retry() }
        .task { await model.load() }
        .sheet(item: $presentedHuddle) { _ in
            IOSHuddleSheet(model: model.huddle)
        }
        .onChange(of: model.huddle.activeHuddle?.id) { _, activeID in
            if activeID == nil { presentedHuddle = nil }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                Task { await model.resume() }
            case .background:
                Task { await model.shutdown() }
            case .inactive:
                break
            @unknown default:
                break
            }
        }
        .onDisappear { Task { await model.shutdown() } }
    }

    @ViewBuilder
    private func timelineRow(_ row: IOSTimelineDisplayRow) -> some View {
        switch row.content {
        case .date(let dayStartMs):
            IOSMessageDateDivider(dayStartMs: dayStartMs)
                .listRowSeparator(.hidden)
        case .message(let message, let startsAuthorGroup, let mentionsCurrentMember, let bodySegments):
            IOSMessageRow(
                message: message,
                member: members[message.authorMemberId],
                quotedBody: quotedBody(for: message),
                startsAuthorGroup: startsAuthorGroup,
                mentionsCurrentMember: mentionsCurrentMember,
                bodySegments: bodySegments,
                model: model
            )
            .id(message.id)
            .listRowSeparator(.hidden)
            .listRowBackground(mentionsCurrentMember ? Color.accentColor.opacity(0.10) : Color.clear)
            .accessibilityIdentifier("message.\(message.id.description)")
            .onAppear { visibleMessageIDs.insert(message.id) }
            .onDisappear { visibleMessageIDs.remove(message.id) }
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                if !message.isDeleted {
                    Button {
                        model.selectReply(to: message)
                    } label: {
                        Label("Reply to message", systemImage: "arrowshape.turn.up.left")
                    }
                    .tint(.accentColor)
                    .accessibilityIdentifier("reply.\(message.id.description)")
                }
            }
            .contextMenu {
                if !message.isDeleted {
                    Button {
                        model.selectReply(to: message)
                    } label: {
                        Label("Reply to message", systemImage: "arrowshape.turn.up.left")
                    }
                    .accessibilityIdentifier("replyMenu.\(message.id.description)")
                }
            }
        }
    }

    private func huddleBanner(_ huddle: IOSHuddle) -> some View {
        Section {
            Button {
                presentedHuddle = huddle
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "waveform")
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Huddle in progress")
                            .font(.callout.weight(.semibold))
                        Text(participantCountLabel)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Text("Live")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tint)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Join huddle, \(participantCountLabel)")
            .accessibilityIdentifier("activeHuddleBanner")
        }
    }

    private var participantCountLabel: String {
        let count = model.huddle.participantCount
        return count == 1 ? "1 participant" : "\(count) participants"
    }

    private func quotedBody(for message: Message) -> String? {
        let replyID = message.replyToId
            ?? message.props["reply_to_id"]?.stringValue.flatMap(MessageID.init(uuidString:))
        guard let replyID,
              let reply = model.messages.first(where: { $0.id == replyID }) else { return nil }
        return reply.body
    }

    private var offlineBanner: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Label("Live updates unavailable", systemImage: "wifi.slash")
                    .font(.callout.weight(.semibold))
                Text("Message history is still available. Pull to refresh after reconnecting.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Reload message history") {
                    Task { await model.retry() }
                }
                .accessibilityIdentifier("retryRealtime")
            }
            .padding(.vertical, 8)
        }
        .accessibilityIdentifier("offlineBanner")
    }

    private var loadingMessages: some View {
        Section {
            ForEach(0..<4, id: \.self) { _ in
                IOSMessagePlaceholder()
                    .redacted(reason: .placeholder)
                    .accessibilityHidden(true)
            }
        } header: {
            Label("Loading messages", systemImage: "ellipsis.message")
                .accessibilityIdentifier("loadingMessages")
        }
    }

    private func timelineFailure(_ failure: IOSTimelineModel.Failure) -> some View {
        Section {
            ContentUnavailableView {
                Label(
                    failure.isOffline ? "You are offline" : "Could not load messages",
                    systemImage: failure.isOffline ? "wifi.slash" : "exclamationmark.triangle"
                )
            } description: {
                Text(failure.message)
            } actions: {
                Button("Retry loading messages") {
                    Task { await model.retry() }
                }
                .accessibilityIdentifier("retryMessages")
            }
        }
    }
}

@MainActor
private struct IOSHuddleSheet: View {
    let model: IOSHuddleModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            Form {
                statusSection
                if model.isJoined { participantsSection }
                controlsSection
            }
            .navigationTitle("Huddle")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !model.isJoined {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { dismiss() }
                            .accessibilityIdentifier("dismissHuddle")
                    }
                }
            }
            .interactiveDismissDisabled(model.isJoined)
        }
    }

    @ViewBuilder
    private var statusSection: some View {
        Section("Status") {
            switch model.state {
            case .connecting:
                ProgressView("Connecting to huddle")
                    .accessibilityIdentifier("huddleConnecting")
            case .permissionDenied:
                ContentUnavailableView {
                    Label("Microphone access denied", systemImage: "mic.slash")
                } description: {
                    Text("Allow microphone access in Settings to speak in this huddle.")
                } actions: {
                    Button("Open Settings") {
                        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                        openURL(url)
                    }
                    .accessibilityIdentifier("openMicrophoneSettings")
                }
            case .failed(let message):
                ContentUnavailableView {
                    Label("Could not connect to huddle", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Retry huddle") { Task { await model.retry() } }
                        .accessibilityIdentifier("retryHuddle")
                }
            case .joined:
                Label(
                    model.isMicrophoneMuted ? "Microphone muted" : "Microphone on",
                    systemImage: model.isMicrophoneMuted ? "mic.slash" : "mic"
                )
                .accessibilityIdentifier("huddleJoinedStatus")
            case .idle:
                Label("Ready to join with audio", systemImage: "waveform")
            case .unavailable:
                ContentUnavailableView(
                    "Huddle unavailable",
                    systemImage: "waveform.slash",
                    description: Text("This momo server is not configured for huddles.")
                )
            }
        }
    }

    private var participantsSection: some View {
        Section("Participants") {
            if model.audioParticipants.isEmpty {
                ProgressView("Loading participants")
            } else {
                ForEach(model.audioParticipants) { participant in
                    HStack {
                        Label(
                            participant.displayName,
                            systemImage: participant.isSpeaking ? "waveform" : "person.crop.circle"
                        )
                        Spacer()
                        if participant.isLocal {
                            Text("You")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .opacity(participant.isSpeaking ? 1 : 0.55)
                    .accessibilityLabel(
                        "\(participant.displayName)\(participant.isLocal ? ", you" : "")\(participant.isSpeaking ? ", speaking" : "")"
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var controlsSection: some View {
        Section("Controls") {
            if model.isJoined {
                Button {
                    Task { await model.toggleMicrophone() }
                } label: {
                    Label(
                        model.isMicrophoneMuted ? "Turn microphone on" : "Mute microphone",
                        systemImage: model.isMicrophoneMuted ? "mic" : "mic.slash"
                    )
                }
                .accessibilityIdentifier("toggleHuddleMicrophone")

                Button("Leave huddle", role: .destructive) {
                    Task {
                        await model.leave()
                        if !model.isJoined { dismiss() }
                    }
                }
                .accessibilityIdentifier("leaveHuddle")
            } else if model.activeHuddle != nil, model.state != .connecting, model.state != .unavailable {
                Button {
                    Task { await model.join() }
                } label: {
                    Label("Join huddle", systemImage: "waveform")
                }
                .accessibilityIdentifier("joinHuddle")
            }
        }
    }
}

private struct IOSMessageDateDivider: View {
    let dayStartMs: Int64
    @Environment(\.calendar) private var calendar

    var body: some View {
        HStack(spacing: 8) {
            Divider()
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .monospacedDigit()
            Divider()
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private var title: String {
        let date = Date(timeIntervalSince1970: Double(dayStartMs) / 1_000)
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.month(.abbreviated).day().weekday(.abbreviated))
    }
}

private struct IOSMessageRow: View {
    let message: Message
    let member: Member?
    let quotedBody: String?
    let startsAuthorGroup: Bool
    let mentionsCurrentMember: Bool
    let bodySegments: [IOSMessageBodySegment]
    let model: IOSTimelineModel

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "person.crop.circle.fill")
                .font(.title3)
                .foregroundStyle(member?.kind == .agent ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                .opacity(startsAuthorGroup ? 1 : 0)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                if startsAuthorGroup {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(member?.displayName ?? "Unknown member")
                            .font(.body.weight(.semibold))
                        Spacer(minLength: 8)
                        if let createdAt = message.createdAtMs {
                            Text(
                                Date(timeIntervalSince1970: Double(createdAt) / 1_000),
                                format: .dateTime.hour().minute()
                            )
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                    }
                }
                if let quotedBody {
                    Label {
                        Text(quotedBody)
                            .lineLimit(2)
                    } icon: {
                        Image(systemName: "quote.bubble")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Replying to: \(quotedBody)")
                }
                messageContent
                if message.isPendingAck {
                    Label(
                        message.state == .failed ? "Message not sent" : "Sending message",
                        systemImage: message.state == .failed ? "exclamationmark.circle" : "clock"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, startsAuthorGroup ? 8 : 4)
        .accessibilityElement(children: message.type == .approvalRequest ? .contain : .combine)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityHint(mentionsCurrentMember ? "Mentions you" : "")
    }

    @ViewBuilder
    private var messageContent: some View {
        if message.isDeleted {
            Label("메시지 삭제됨", systemImage: "trash")
                .font(.body)
                .foregroundStyle(.secondary)
        } else if message.type == .approvalRequest {
            IOSApprovalDecisionCard(message: message, model: model)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                IOSMessageBody(bodySegments: bodySegments, fallbackText: fallbackText)
                if message.editedAtMs != nil || message.state == .edited {
                    Text("Edited")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var accessibilitySummary: String {
        let author = member?.displayName ?? "Unknown member"
        let body = message.isDeleted ? "메시지 삭제됨" : (message.body ?? fallbackText)
        let edited = !message.isDeleted && (message.editedAtMs != nil || message.state == .edited)
            ? ", edited"
            : ""
        return "\(author), \(body)\(edited)"
    }

    private var fallbackText: String {
        switch message.type {
        case .toolCall: "Tool call"
        case .toolResult: "Tool result"
        case .diff: "Change preview"
        case .artifact: "Artifact"
        case .system: "System message"
        case .text, .approvalRequest: "Message"
        }
    }
}

private struct IOSMessageBody: View {
    let bodySegments: [IOSMessageBodySegment]
    let fallbackText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if bodySegments.isEmpty {
                Text(fallbackText)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(bodySegments) { segment in
                    switch segment.kind {
                    case .prose:
                        Text(attributedProse(segment.text))
                            .font(.body)
                            .foregroundStyle(.primary)
                            .tint(.accentColor)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    case .code(let language):
                        VStack(alignment: .leading, spacing: 4) {
                            if let language {
                                Text(language)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            ScrollView(.horizontal) {
                                Text(segment.text)
                                    .font(.callout.monospaced())
                                    .foregroundStyle(.primary)
                                    .textSelection(.enabled)
                                    .padding(12)
                            }
                            .scrollIndicators(.hidden)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                    }
                }
            }
        }
    }

    private func attributedProse(_ prose: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: prose, options: options)) ?? AttributedString(prose)
    }
}

@MainActor
private struct IOSApprovalDecisionCard: View {
    let message: Message
    let model: IOSTimelineModel
    @State private var pendingIrreversibleDecision: Bool?

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                LabeledContent("Action", value: actionName)
                if let summary = message.body, !summary.isEmpty {
                    Text(summary)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Label(statusLabel, systemImage: statusIcon)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                decisionControls
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Label("Approval request", systemImage: "checkmark.shield")
        }
        .accessibilityLabel("Approval request, \(actionName), \(statusLabel)")
        .confirmationDialog(
            "Record irreversible decision?",
            isPresented: Binding(
                get: { pendingIrreversibleDecision != nil },
                set: { if !$0 { pendingIrreversibleDecision = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let approve = pendingIrreversibleDecision {
                Button(approve ? "Approve irreversible action" : "Reject irreversible action", role: approve ? .destructive : nil) {
                    pendingIrreversibleDecision = nil
                    Task { await model.decideApproval(message, approve: approve) }
                }
                .accessibilityIdentifier("confirmApprovalDecision")
            }
            Button("Keep decision pending", role: .cancel) {
                pendingIrreversibleDecision = nil
            }
            .accessibilityIdentifier("cancelApprovalDecision")
        } message: {
            Text("This decision cannot be undone. Review the requested action before recording it.")
        }
    }

    @ViewBuilder
    private var decisionControls: some View {
        if status == .pending, let approvalID {
            let isInFlight = model.approvalDecisionsInFlight.contains(approvalID)
            let didFail = model.approvalDecisionFailures.contains(approvalID)
            if didFail {
                VStack(alignment: .leading, spacing: 4) {
                    Label("Decision not recorded. Retry the same decision.", systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Retry recording decision") {
                        Task { await model.retryApprovalDecision(for: message) }
                    }
                    .accessibilityIdentifier("retryApproval.\(approvalID.description)")
                }
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { approvalButtons(approvalID: approvalID) }
                    VStack(alignment: .leading, spacing: 8) { approvalButtons(approvalID: approvalID) }
                }
                .disabled(isInFlight)

                if isInFlight {
                    ProgressView("Recording decision")
                        .font(.caption)
                }
            }
        }
    }

    @ViewBuilder
    private func approvalButtons(approvalID: ApprovalID) -> some View {
        Button {
            decide(approve: true)
        } label: {
            Label("Approve request", systemImage: "checkmark.circle.fill")
        }
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier("approve.\(approvalID.description)")

        Button {
            decide(approve: false)
        } label: {
            Label("Reject request", systemImage: "xmark.circle")
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("reject.\(approvalID.description)")
    }

    private func decide(approve: Bool) {
        if isIrreversible {
            pendingIrreversibleDecision = approve
        } else {
            Task { await model.decideApproval(message, approve: approve) }
        }
    }

    private var approvalID: ApprovalID? { IOSTimelineModel.approvalID(for: message) }
    private var status: ApprovalStatus { model.approvalStatus(for: message) }
    private var isIrreversible: Bool { message.props["is_reversible"]?.boolValue != true }

    private var actionName: String {
        message.props["action_type"]?.stringValue
            ?? message.props["tool_name"]?.stringValue
            ?? "Requested action"
    }

    private var statusLabel: String {
        switch status {
        case .approved: "Approved"
        case .rejected: "Rejected"
        case .expired: "Expired"
        case .cancelled: "Cancelled"
        case .pending: "Awaiting decision"
        }
    }

    private var statusIcon: String {
        switch status {
        case .approved: "checkmark.circle"
        case .rejected: "xmark.circle"
        case .expired: "clock.badge.exclamationmark"
        case .cancelled: "minus.circle"
        case .pending: "clock"
        }
    }
}

@MainActor
private struct IOSMessageComposer: View {
    @Bindable var model: IOSTimelineModel
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let reply = model.replyTarget {
                HStack(alignment: .top, spacing: 8) {
                    Label {
                        Text(reply.body ?? "Selected message")
                            .lineLimit(2)
                    } icon: {
                        Image(systemName: "arrowshape.turn.up.left")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Button {
                        model.cancelReply()
                    } label: {
                        Label("Cancel reply", systemImage: "xmark.circle.fill")
                            .labelStyle(.iconOnly)
                    }
                    .accessibilityIdentifier("cancelReply")
                    .frame(minWidth: 44, minHeight: 44)
                }
            }

            if let failure = model.sendFailureMessage {
                VStack(alignment: .leading, spacing: 4) {
                    Label(failure, systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Retry sending message") {
                        Task { await model.retryFailedSend() }
                    }
                    .disabled(model.isSending)
                    .accessibilityIdentifier("retrySend")
                }
            }

            HStack(alignment: .bottom, spacing: 8) {
                TextField("Write a message", text: $model.composerDraft, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                    .focused($isFocused)
                    .submitLabel(.send)
                    .onSubmit { submit() }
                    .accessibilityLabel("Write a message")
                    .accessibilityIdentifier("messageComposer")

                Button(action: submit) {
                    Label("Send message", systemImage: "arrow.up.circle.fill")
                        .labelStyle(.iconOnly)
                        .font(.title2)
                }
                .disabled(!canSend)
                .accessibilityLabel("Send message")
                .accessibilityIdentifier("sendMessage")
                .frame(minWidth: 44, minHeight: 44)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var canSend: Bool {
        !model.composerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && model.phase == .loaded
            && !model.isSending
            && model.sendFailureMessage == nil
    }

    private func submit() {
        guard canSend else { return }
        Task { await model.sendComposerDraft() }
    }
}

private struct IOSMessagePlaceholder: View {
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "person.crop.circle.fill")
                .font(.title3)
            VStack(alignment: .leading, spacing: 4) {
                Text("Loading member")
                    .font(.body.weight(.semibold))
                Text("Loading a message with enough content to preserve the timeline layout.")
                    .font(.body)
            }
        }
        .padding(.vertical, 8)
    }
}
#endif
