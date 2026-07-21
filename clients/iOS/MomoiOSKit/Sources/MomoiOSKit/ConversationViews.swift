#if os(iOS)
import Foundation
import MomoCore
import PhotosUI
import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers

@MainActor
struct IOSChannelHomeView: View {
    private let session: IOSSession
    private let bootstrap: WorkspaceBootstrap
    private let backend: MomoServerConversationClient
    private let huddleService: any IOSHuddleService
    let model: IOSChannelListModel
    @State private var channelToLeave: IOSChannelListItem?
    @State private var channelLeaveError: String?

    init(
        session: IOSSession,
        bootstrap: WorkspaceBootstrap,
        model: IOSChannelListModel,
        backend: MomoServerConversationClient,
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
                    IOSThreadInboxView(
                        session: session,
                        channelListModel: model,
                        backend: backend,
                        workspace: session.workspaceID,
                        huddleService: huddleService
                    )
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
        .confirmationDialog(
            "Leave this channel?",
            isPresented: Binding(
                get: { channelToLeave != nil },
                set: { if !$0 { channelToLeave = nil } }
            ),
            presenting: channelToLeave
        ) { item in
            Button("Leave \(item.title)", role: .destructive) {
                Task { await leaveChannel(item) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { item in
            Text("You will stop receiving messages from \(item.title). Direct messages cannot be left.")
        }
        .alert(
            "Could not leave channel",
            isPresented: Binding(
                get: { channelLeaveError != nil },
                set: { if !$0 { channelLeaveError = nil } }
            )
        ) {
            Button("Dismiss", role: .cancel) { channelLeaveError = nil }
        } message: {
            Text(channelLeaveError ?? "Try again.")
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
                    huddleService: huddleService,
                    pushLink: link
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
                huddleService: huddleService,
                pushLink: nil
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

            if !item.isDirectMessage {
                Divider()
                Button(role: .destructive) {
                    channelToLeave = item
                } label: {
                    Label("Leave channel", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
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

    private func leaveChannel(_ item: IOSChannelListItem) async {
        channelLeaveError = nil
        do {
            try await backend.leaveChannel(item.id)
            channelToLeave = nil
            await model.refresh()
        } catch {
            channelLeaveError = error.localizedDescription
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
    private let currentMemberID: MemberID
    private let backend: any IOSConversationBackend
    private let workspace: WorkspaceID
    private let huddleService: any IOSHuddleService
    private let threadRoot: MessageID?
    private let onReadState: ((ChannelReadState) -> Void)?
    private let focusMessageID: MessageID?
    private let focusSequence: Int64?
    private let showsComposer: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: IOSTimelineModel
    @State private var visibleMessageIDs: Set<MessageID> = []
    @State private var presentedHuddle: IOSHuddle?
    @State private var presentedInteraction: IOSMessageInteractionPresentation?

    init(
        item: IOSChannelListItem,
        members: [MemberID: Member],
        currentMemberID: MemberID,
        backend: any IOSConversationBackend,
        workspace: WorkspaceID,
        huddleService: any IOSHuddleService,
        threadRoot: MessageID? = nil,
        initialThreadRootMessage: Message? = nil,
        focusMessageID: MessageID? = nil,
        focusSequence: Int64? = nil,
        showsComposer: Bool = true,
        onReadState: ((ChannelReadState) -> Void)? = nil
    ) {
        self.item = item
        self.members = members
        self.currentMemberID = currentMemberID
        self.backend = backend
        self.workspace = workspace
        self.huddleService = huddleService
        self.threadRoot = threadRoot
        self.onReadState = onReadState
        self.focusMessageID = focusMessageID
        self.focusSequence = focusSequence
        self.showsComposer = showsComposer
        _model = State(initialValue: IOSTimelineModel(
            channel: item.id,
            currentMemberID: currentMemberID,
            backend: backend,
            workspace: workspace,
            huddleService: huddleService,
            threadRoot: threadRoot,
            initialThreadRootMessage: initialThreadRootMessage,
            initialBeforeSequence: focusSequence.flatMap { $0 == Int64.max ? nil : $0 + 1 },
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
                if let refreshFailure = model.refreshFailure, model.phase == .loaded {
                    historyRefreshBanner(refreshFailure)
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
            .task(id: focusMessageTrigger) {
                guard let focusMessageID,
                      model.messages.contains(where: { $0.id == focusMessageID })
                else { return }
                await Task.yield()
                proxy.scrollTo(focusMessageID, anchor: .center)
            }
        }
        .safeAreaInset(edge: .bottom) {
            if showsComposer {
                IOSMessageComposer(model: model)
            }
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
        .sheet(item: $presentedInteraction) { presentation in
            IOSMessageInteractionSheet(messageID: presentation.id, model: model)
        }
        .alert(
            "메시지 동작 실패 / Message action failed",
            isPresented: Binding(
                get: { model.interactionFailureMessage != nil },
                set: { isPresented in
                    if !isPresented { model.clearInteractionFailure() }
                }
            )
        ) {
            Button("닫기 / Dismiss", role: .cancel) { model.clearInteractionFailure() }
        } message: {
            Text(model.interactionFailureMessage ?? "다시 시도하세요. / Try again.")
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
            VStack(alignment: .leading, spacing: 4) {
                IOSMessageRow(
                    message: message,
                    member: members[message.authorMemberId],
                    quotedBody: quotedBody(for: message),
                    startsAuthorGroup: startsAuthorGroup,
                    mentionsCurrentMember: mentionsCurrentMember,
                    bodySegments: bodySegments,
                    model: model
                )
                if threadRoot == nil,
                   let rollup = message.thread,
                   rollup.replyCount > 0
                {
                    NavigationLink {
                        IOSThreadDetailView(
                            item: item,
                            rootMessage: message,
                            members: members,
                            currentMemberID: currentMemberID,
                            backend: backend,
                            workspace: workspace,
                            huddleService: huddleService,
                            onReadState: onReadState
                        )
                    } label: {
                        IOSThreadRollupLabel(
                            rollup: rollup,
                            participantMemberIDs: model.threadParticipantIDs[message.id] ?? [],
                            members: members
                        )
                    }
                    .buttonStyle(.plain)
                    .padding(.leading, 32)
                    .task(id: rollup.replyCount) {
                        await model.loadThreadParticipants(for: message)
                    }
                    .accessibilityIdentifier("thread.\(message.id.description)")
                }
            }
            .id(message.id)
            .listRowSeparator(.hidden)
            .listRowBackground(rowBackground(message: message, mentionsCurrentMember: mentionsCurrentMember))
            .accessibilityIdentifier("message.\(message.id.description)")
            .onAppear { visibleMessageIDs.insert(message.id) }
            .onDisappear { visibleMessageIDs.remove(message.id) }
            .onLongPressGesture {
                guard model.canPresentInteractionSheet(for: message) else { return }
                presentedInteraction = IOSMessageInteractionPresentation(id: message.id)
            }
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
        }
    }

    private var focusMessageTrigger: MessageID? {
        guard let focusMessageID,
              model.phase == .loaded,
              model.messages.contains(where: { $0.id == focusMessageID })
        else { return nil }
        return focusMessageID
    }

    private func rowBackground(message: Message, mentionsCurrentMember: Bool) -> Color {
        if message.id == focusMessageID { return Color.accentColor.opacity(0.16) }
        if mentionsCurrentMember { return Color.accentColor.opacity(0.10) }
        return .clear
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

    private func historyRefreshBanner(_ failure: IOSTimelineModel.Failure) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Label(
                    failure.requiresSignIn ? "Session expired" : "Messages may be out of date",
                    systemImage: failure.requiresSignIn ? "person.crop.circle.badge.exclamationmark" : "arrow.clockwise"
                )
                .font(.callout.weight(.semibold))
                Text(failure.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button(failure.requiresSignIn ? "Try refreshing session" : "Retry message refresh") {
                    Task { await model.retry() }
                }
                .accessibilityIdentifier("retryMessageRefresh")
            }
            .padding(.vertical, 8)
        }
        .accessibilityIdentifier("messageRefreshBanner")
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
private struct IOSThreadDetailView: View {
    let item: IOSChannelListItem
    let rootMessage: Message
    let members: [MemberID: Member]
    let currentMemberID: MemberID
    let backend: any IOSConversationBackend
    let workspace: WorkspaceID
    let huddleService: any IOSHuddleService
    let onReadState: ((ChannelReadState) -> Void)?

    var body: some View {
        IOSTimelineView(
            item: item,
            members: members,
            currentMemberID: currentMemberID,
            backend: backend,
            workspace: workspace,
            huddleService: huddleService,
            threadRoot: rootMessage.id,
            initialThreadRootMessage: rootMessage,
            showsComposer: true,
            onReadState: onReadState
        )
        .navigationTitle("Thread")
    }
}

private struct IOSThreadRollupLabel: View {
    let rollup: ThreadRollup
    let participantMemberIDs: [MemberID]
    let members: [MemberID: Member]

    var body: some View {
        HStack(spacing: 8) {
            if participantMemberIDs.isEmpty {
                Image(systemName: "bubble.left.and.text.bubble.right")
                    .frame(width: 24, height: 24)
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 4) {
                    ForEach(Array(participantMemberIDs.prefix(3)), id: \.self) { memberID in
                        Text(initial(for: members[memberID]))
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(width: 24, height: 24)
                            .background(Color.accentColor, in: Circle())
                            .overlay(Circle().stroke(.background, lineWidth: 2))
                    }
                }
            }
            Text(replyLabel)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.tint)
            if participantMemberIDs.count > 3 {
                Text("+\(participantMemberIDs.count - 3)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(replyLabel)
        .accessibilityHint("Open thread")
    }

    private var replyLabel: String {
        rollup.replyCount == 1 ? "1 reply" : "\(rollup.replyCount) replies"
    }

    private func initial(for member: Member?) -> String {
        let name = member?.displayName.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.first.map { String($0).uppercased() } ?? "?"
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

struct IOSMessageDateDivider: View {
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

struct IOSMessageRow: View {
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
                if !message.isDeleted, let attachments = message.attachments, !attachments.isEmpty {
                    ForEach(attachments) { attachment in
                        IOSMessageAttachmentCard(attachment: attachment, model: model)
                    }
                }
                let reactions = model.reactions(for: message)
                if !reactions.isEmpty {
                    IOSReactionPillRow(message: message, reactions: reactions, model: model)
                }
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
        .accessibilityElement(children: containsInteractiveContent ? .contain : .combine)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityHint(mentionsCurrentMember ? "Mentions you" : "")
    }

    @ViewBuilder
    private var messageContent: some View {
        if message.isDeleted {
            Label("메시지 삭제됨", systemImage: "trash")
                .font(.body)
                .foregroundStyle(.secondary)
        } else if let artifactPresentation {
            IOSMessageArtifactCard(presentation: artifactPresentation)
        } else if message.type == .approvalRequest {
            IOSApprovalDecisionCard(
                message: message,
                status: model.approvalStatus(for: message),
                isInFlight: approvalID.map(model.approvalDecisionsInFlight.contains) == true,
                didFail: approvalID.map(model.approvalDecisionFailures.contains) == true,
                onDecide: { approve in Task { await model.decideApproval(message, approve: approve) } },
                onRetry: { Task { await model.retryApprovalDecision(for: message) } }
            )
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

    private var approvalID: ApprovalID? { IOSTimelineModel.approvalID(for: message) }

    private var artifactPresentation: MessageArtifactPresentation? {
        MessageArtifactPresentation.resolve(message: message)
    }

    private var containsInteractiveContent: Bool {
        message.type == .approvalRequest || artifactPresentation != nil
    }
}

private struct IOSMessageAttachmentCard: View {
    let attachment: MessageAttachment
    let model: IOSTimelineModel
    @State private var previewURL: URL?

    private var state: IOSAttachmentDownloadState? {
        model.attachmentDownloadState(for: attachment)
    }

    private var cachedURL: URL? {
        model.cachedAttachmentURL(for: attachment)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if attachment.mime.hasPrefix("image/") {
                imagePreview
            }
            HStack(spacing: 10) {
                Image(systemName: attachment.mime.hasPrefix("image/") ? "photo" : "doc")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.tint)
                    .frame(width: 32, height: 32)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.name)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(2)
                        .truncationMode(.middle)
                    Text(metadata)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                attachmentAction
                if let cachedURL {
                    ShareLink(item: cachedURL, preview: SharePreview(attachment.name)) {
                        Label("Save or share attachment", systemImage: "square.and.arrow.up")
                            .labelStyle(.iconOnly)
                    }
                    .accessibilityLabel("Save or share \(attachment.name)")
                    .frame(minWidth: 44, minHeight: 44)
                }
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .contain)
        .quickLookPreview($previewURL)
        .task(id: attachment.id) {
            guard attachment.mime.hasPrefix("image/"), cachedURL == nil else { return }
            _ = await model.downloadAttachment(attachment)
        }
    }

    @ViewBuilder
    private var imagePreview: some View {
        if let cachedURL,
           let image = UIImage(contentsOfFile: cachedURL.path) {
            Button {
                previewURL = cachedURL
            } label: {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 320, maxHeight: 240)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Preview \(attachment.name)")
        } else if state == .failed {
            Button("Retry image preview") {
                Task { _ = await model.downloadAttachment(attachment) }
            }
            .font(.caption)
        } else {
            HStack(spacing: 8) {
                ProgressView()
                Text("Loading image preview")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(minHeight: 80)
        }
    }

    @ViewBuilder
    private var attachmentAction: some View {
        switch state {
        case .downloading:
            ProgressView()
                .accessibilityLabel("Downloading \(attachment.name)")
                .frame(width: 44, height: 44)
        case .completed(let url):
            Button {
                previewURL = url
            } label: {
                Label("Open attachment", systemImage: "arrow.up.forward.app")
                    .labelStyle(.iconOnly)
            }
            .accessibilityLabel("Open \(attachment.name)")
            .frame(minWidth: 44, minHeight: 44)
        case .failed:
            Button {
                Task { _ = await model.downloadAttachment(attachment) }
            } label: {
                Label("Retry attachment download", systemImage: "arrow.clockwise")
                    .labelStyle(.iconOnly)
            }
            .accessibilityLabel("Retry downloading \(attachment.name)")
            .frame(minWidth: 44, minHeight: 44)
        case nil:
            Button {
                Task {
                    if let url = await model.downloadAttachment(attachment) {
                        previewURL = url
                    }
                }
            } label: {
                Label("Download attachment", systemImage: "arrow.down.to.line")
                    .labelStyle(.iconOnly)
            }
            .accessibilityLabel("Download \(attachment.name)")
            .frame(minWidth: 44, minHeight: 44)
        }
    }

    private var metadata: String {
        let size = ByteCountFormatter.string(fromByteCount: attachment.sizeBytes, countStyle: .file)
        if state == .failed { return "Download failed · \(size)" }
        return "\(attachment.mime) · \(size)"
    }
}

struct IOSMessageInteractionPresentation: Identifiable {
    let id: MessageID
}

@MainActor
struct IOSMessageInteractionSheet: View {
    let messageID: MessageID
    let model: IOSTimelineModel
    @Environment(\.dismiss) private var dismiss
    @State private var isEditing = false
    @State private var editDraft = ""
    @State private var customEmoji = ""
    @State private var confirmsDelete = false

    private let additionalEmojis = ["🔥", "🚀", "✅", "🤔", "🙏", "💯"]

    var body: some View {
        NavigationStack {
            if let message = model.message(id: messageID), model.canPresentInteractionSheet(for: message) {
                if isEditing {
                    editForm(message)
                } else {
                    actionList(message)
                }
            } else {
                ContentUnavailableView(
                    "메시지를 사용할 수 없음 / Message unavailable",
                    systemImage: "message.badge",
                    description: Text("목록을 새로고침하세요. / Refresh the message list.")
                )
            }
        }
        .presentationDetents([.medium, .large])
        .alert(
            "메시지 동작 실패 / Message action failed",
            isPresented: Binding(
                get: { model.interactionFailureMessage != nil },
                set: { isPresented in
                    if !isPresented { model.clearInteractionFailure() }
                }
            )
        ) {
            Button("닫기 / Dismiss", role: .cancel) { model.clearInteractionFailure() }
        } message: {
            Text(model.interactionFailureMessage ?? "다시 시도하세요. / Try again.")
        }
    }

    private func actionList(_ message: Message) -> some View {
        List {
            Section("최근 반응 / Recent reactions") {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(model.recentReactionEmojis, id: \.self) { emoji in
                            reactionButton(emoji, message: message)
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }

            Section("반응 더 보기 / More reactions") {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 12) {
                    ForEach(additionalEmojis, id: \.self) { emoji in
                        reactionButton(emoji, message: message)
                    }
                }
                HStack(spacing: 8) {
                    TextField("이모지 입력 / Enter emoji", text: $customEmoji)
                        .textInputAutocapitalization(.never)
                    Button("반응 추가 / Add reaction") {
                        submitReaction(customEmoji, message: message)
                    }
                    .disabled(customEmoji.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }

            Section("메시지 동작 / Message actions") {
                if model.availableInteractionActions(for: message).contains(.reply) {
                    Button {
                        model.selectReply(to: message)
                        dismiss()
                    } label: {
                        Label("답글 작성 / Reply", systemImage: "arrowshape.turn.up.left")
                    }
                    .accessibilityIdentifier("replyMenu.\(message.id.description)")
                }
                if model.availableInteractionActions(for: message).contains(.edit) {
                    Button {
                        editDraft = message.body ?? ""
                        isEditing = true
                    } label: {
                        Label("메시지 수정 / Edit message", systemImage: "pencil")
                    }
                    .disabled(model.messageMutationsInFlight.contains(message.id))
                }
                if model.availableInteractionActions(for: message).contains(.copy) {
                    Button {
                        UIPasteboard.general.string = message.body
                        dismiss()
                    } label: {
                        Label("메시지 복사 / Copy message", systemImage: "doc.on.doc")
                    }
                }
                if model.availableInteractionActions(for: message).contains(.delete) {
                    Button(role: .destructive) {
                        confirmsDelete = true
                    } label: {
                        Label("메시지 삭제 / Delete message", systemImage: "trash")
                    }
                    .disabled(model.messageMutationsInFlight.contains(message.id))
                }
            }
        }
        .navigationTitle("메시지 동작 / Message actions")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("닫기 / Done") { dismiss() }
            }
        }
        .confirmationDialog(
            "메시지를 삭제할까요? / Delete this message?",
            isPresented: $confirmsDelete,
            titleVisibility: .visible
        ) {
            Button("메시지 삭제 / Delete message", role: .destructive) {
                Task {
                    if await model.deleteMessage(message) { dismiss() }
                }
            }
            Button("삭제 취소 / Cancel deletion", role: .cancel) {}
        } message: {
            Text("삭제한 메시지는 복원할 수 없습니다. / A deleted message cannot be restored.")
        }
    }

    private func editForm(_ message: Message) -> some View {
        Form {
            Section("메시지 / Message") {
                TextEditor(text: $editDraft)
                    .frame(minHeight: 120)
                    .accessibilityIdentifier("editMessageBody")
            }
        }
        .navigationTitle("메시지 수정 / Edit message")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("수정 취소 / Cancel editing") { isEditing = false }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("변경 저장 / Save changes") {
                    Task {
                        if await model.editMessage(message, body: editDraft) { dismiss() }
                    }
                }
                .disabled(
                    editDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || model.messageMutationsInFlight.contains(message.id)
                )
            }
        }
    }

    private func reactionButton(_ emoji: String, message: Message) -> some View {
        Button {
            submitReaction(emoji, message: message)
        } label: {
            Text(emoji)
                .font(.title3)
                .frame(minWidth: 32, minHeight: 32)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .disabled(model.isReactionMutationInFlight(message: message, emoji: emoji))
        .accessibilityLabel("\(emoji) 반응 전환 / Toggle \(emoji) reaction")
    }

    private func submitReaction(_ emoji: String, message: Message) {
        let normalized = emoji.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return }
        customEmoji = ""
        Task { await model.toggleReaction(normalized, on: message) }
    }
}

@MainActor
private struct IOSReactionPillRow: View {
    let message: Message
    let reactions: [IOSMessageReaction]
    let model: IOSTimelineModel

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 4) {
                ForEach(reactions) { reaction in
                    Button {
                        Task { await model.toggleReaction(reaction.emoji, on: message) }
                    } label: {
                        HStack(spacing: 4) {
                            Text(reaction.emoji)
                            Text(reaction.count, format: .number)
                                .monospacedDigit()
                        }
                        .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .tint(reaction.isSelectedByCurrentMember ? .accentColor : .secondary)
                    .disabled(model.isReactionMutationInFlight(message: message, emoji: reaction.emoji))
                    .accessibilityLabel(
                        "\(reaction.emoji), \(reaction.count)개 반응 / \(reaction.count) reactions"
                    )
                    .accessibilityAddTraits(reaction.isSelectedByCurrentMember ? .isSelected : [])
                }
            }
        }
        .scrollIndicators(.hidden)
        .accessibilityIdentifier("reactions.\(message.id.description)")
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
struct IOSApprovalDecisionCard: View {
    let message: Message
    let status: ApprovalStatus
    let isInFlight: Bool
    let didFail: Bool
    let onDecide: (Bool) -> Void
    let onRetry: () -> Void
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
                    onDecide(approve)
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
            if didFail {
                VStack(alignment: .leading, spacing: 4) {
                    Label("Decision not recorded. Retry the same decision.", systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Retry recording decision") {
                        onRetry()
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
            onDecide(approve)
        }
    }

    private var approvalID: ApprovalID? { IOSTimelineModel.approvalID(for: message) }
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
struct IOSMessageComposer: View {
    @Bindable var model: IOSTimelineModel
    @FocusState private var isFocused: Bool
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var presentsFileImporter = false
    @State private var presentsCamera = false
    @State private var pickerFailureMessage: String?

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

            if !model.attachmentDrafts.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(model.attachmentDrafts) { draft in
                            IOSAttachmentDraftChip(
                                draft: draft,
                                onRemove: { model.removeAttachmentDraft(draft.id) },
                                onRetry: { Task { await model.retryAttachmentDraft(draft.id) } }
                            )
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }

            if let failure = model.attachmentFailureMessage ?? pickerFailureMessage {
                Label(failure, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(alignment: .bottom, spacing: 8) {
                Menu {
                    PhotosPicker(selection: $selectedPhoto, matching: .images) {
                        Label("Photo Library", systemImage: "photo.on.rectangle")
                    }
                    Button {
                        presentsFileImporter = true
                    } label: {
                        Label("Files", systemImage: "folder")
                    }
                    Button {
                        presentsCamera = true
                    } label: {
                        Label("Camera", systemImage: "camera")
                    }
                    .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
                } label: {
                    Label("Add attachment", systemImage: "plus.circle")
                        .labelStyle(.iconOnly)
                        .font(.title2)
                }
                .disabled(model.isSending)
                .accessibilityLabel("Add attachment")
                .frame(minWidth: 44, minHeight: 44)

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
        .fileImporter(
            isPresented: $presentsFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case .success(let urls):
                for url in urls { stage(url) }
            case .failure:
                pickerFailureMessage = "Could not open the selected file."
            }
        }
        .sheet(isPresented: $presentsCamera) {
            IOSCameraCaptureView { image in
                presentsCamera = false
                guard let data = image.jpegData(compressionQuality: 0.9) else {
                    pickerFailureMessage = "Could not prepare the captured photo."
                    return
                }
                stage(data: data, name: "Camera Photo.jpg")
            } onCancel: {
                presentsCamera = false
            }
            .ignoresSafeArea()
        }
        .onChange(of: selectedPhoto) { _, item in
            guard let item else { return }
            Task {
                defer { selectedPhoto = nil }
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else {
                        pickerFailureMessage = "Could not load the selected photo."
                        return
                    }
                    let fileType = item.supportedContentTypes.first ?? .jpeg
                    let ext = fileType.preferredFilenameExtension ?? "jpg"
                    stage(data: data, name: "Photo.\(ext)")
                } catch {
                    pickerFailureMessage = "Could not load the selected photo."
                }
            }
        }
    }

    private var canSend: Bool {
        (!model.composerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !model.attachmentDrafts.isEmpty)
            && model.phase == .loaded
            && !model.isSending
            && model.sendFailureMessage == nil
    }

    private func submit() {
        guard canSend else { return }
        Task { await model.sendComposerDraft() }
    }

    private func stage(_ url: URL) {
        do {
            try model.stageAttachment(fileURL: url)
            pickerFailureMessage = nil
        } catch let issue as IOSAttachmentTransferIssue where issue == .fileTooLarge {
            pickerFailureMessage = "Attachments must be 100 MB or smaller."
        } catch {
            pickerFailureMessage = "Could not prepare the selected attachment."
        }
    }

    private func stage(data: Data, name: String) {
        do {
            stage(try IOSAttachmentFileBoundary.materialize(data, named: name))
        } catch let issue as IOSAttachmentTransferIssue where issue == .fileTooLarge {
            pickerFailureMessage = "Attachments must be 100 MB or smaller."
        } catch {
            pickerFailureMessage = "Could not prepare the selected attachment."
        }
    }
}

private struct IOSAttachmentDraftChip: View {
    let draft: IOSAttachmentDraft
    let onRemove: () -> Void
    let onRetry: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            stateIcon
            VStack(alignment: .leading, spacing: 2) {
                Text(draft.name)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(ByteCountFormatter.string(fromByteCount: draft.sizeBytes, countStyle: .file))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if case .failed = draft.state {
                Button(action: onRetry) {
                    Label("Retry upload", systemImage: "arrow.clockwise")
                        .labelStyle(.iconOnly)
                }
                .accessibilityLabel("Retry uploading \(draft.name)")
            }
            if draft.state != .uploading {
                Button(action: onRemove) {
                    Label("Remove attachment", systemImage: "xmark.circle.fill")
                        .labelStyle(.iconOnly)
                }
                .accessibilityLabel("Remove \(draft.name)")
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    @ViewBuilder
    private var stateIcon: some View {
        switch draft.state {
        case .ready:
            Image(systemName: draft.mime.hasPrefix("image/") ? "photo" : "doc")
                .foregroundStyle(.tint)
        case .uploading:
            ProgressView()
                .controlSize(.small)
                .accessibilityLabel("Uploading \(draft.name)")
        case .uploaded:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.red)
        }
    }
}

private struct IOSCameraCaptureView: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onCapture: (UIImage) -> Void
        let onCancel: () -> Void

        init(onCapture: @escaping (UIImage) -> Void, onCancel: @escaping () -> Void) {
            self.onCapture = onCapture
            self.onCancel = onCancel
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let image = info[.originalImage] as? UIImage else {
                onCancel()
                return
            }
            onCapture(image)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }
    }
}

@MainActor
private struct IOSThreadInboxView: View {
    let channelListModel: IOSChannelListModel
    let backend: any IOSConversationBackend
    let workspace: WorkspaceID
    let huddleService: any IOSHuddleService
    private let currentMemberID: MemberID
    @State private var model: IOSThreadInboxModel

    init(
        session: IOSSession,
        channelListModel: IOSChannelListModel,
        backend: any IOSConversationBackend,
        workspace: WorkspaceID,
        huddleService: any IOSHuddleService
    ) {
        self.channelListModel = channelListModel
        self.backend = backend
        self.workspace = workspace
        self.huddleService = huddleService
        self.currentMemberID = session.member.id
        _model = State(initialValue: IOSThreadInboxModel(
            currentMemberID: session.member.id,
            backend: backend
        ))
    }

    var body: some View {
        List {
            if let refreshFailureMessage = model.refreshFailureMessage {
                Section {
                    Label(refreshFailureMessage, systemImage: "wifi.exclamationmark")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("threadsRefreshFailure")
            }
            switch model.phase {
            case .loading:
                Section {
                    ForEach(0..<3, id: \.self) { _ in
                        Label("Loading thread", systemImage: "bubble.left.and.text.bubble.right")
                            .redacted(reason: .placeholder)
                    }
                }
            case .failed(let failure):
                Section {
                    ContentUnavailableView {
                        Label(
                            failure.isOffline ? "Threads unavailable offline" : "Could not load threads",
                            systemImage: failure.isOffline ? "wifi.slash" : "exclamationmark.triangle"
                        )
                    } description: {
                        Text(failure.message)
                    } actions: {
                        Button("Retry loading threads") { refresh() }
                    }
                }
            case .loaded where model.items.isEmpty:
                Section {
                    ContentUnavailableView {
                        Label("No thread activity", systemImage: "bubble.left.and.text.bubble.right")
                    } description: {
                        Text("Threads you start or reply to will appear here.")
                    }
                    .accessibilityIdentifier("threadsEmpty")
                }
            case .loaded:
                Section {
                    ForEach(model.items) { thread in
                        NavigationLink {
                            IOSThreadDetailView(
                                item: thread.channel,
                                rootMessage: thread.rootMessage,
                                members: channelListModel.membersByID,
                                currentMemberID: currentMemberID,
                                backend: backend,
                                workspace: workspace,
                                huddleService: huddleService,
                                onReadState: channelListModel.applyReadState
                            )
                        } label: {
                            threadRow(thread)
                        }
                        .accessibilityIdentifier("threadInbox.\(thread.id.description)")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Threads")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await model.load(channels: channelListModel.allItems)
        }
        .task(id: channelIDs) {
            await model.load(channels: channelListModel.allItems)
        }
    }

    private var channelIDs: [ChannelID] {
        channelListModel.allItems.map(\.id)
    }

    private func refresh() {
        Task { await model.load(channels: channelListModel.allItems) }
    }

    private func threadRow(_ thread: IOSThreadListItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(thread.channel.isDirectMessage ? thread.channel.title : "#\(thread.channel.title)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Text(
                    Date(timeIntervalSince1970: Double(thread.lastReplyAtMs) / 1_000),
                    format: .relative(presentation: .named)
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Text(thread.rootMessage.body ?? "Message")
                .font(.body)
                .lineLimit(2)
            if let rollup = thread.rootMessage.thread {
                IOSThreadRollupLabel(
                    rollup: rollup,
                    participantMemberIDs: thread.participantMemberIDs,
                    members: channelListModel.membersByID
                )
            }
        }
        .padding(.vertical, 4)
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
