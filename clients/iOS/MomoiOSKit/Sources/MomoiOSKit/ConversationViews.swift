#if os(iOS)
import MomoCore
import SwiftUI

@MainActor
public struct IOSWorkspaceView: View {
    private let session: IOSSession
    private let bootstrap: WorkspaceBootstrap
    private let signOut: @MainActor () -> Void
    private let backend: any IOSConversationBackend
    @State private var model: IOSChannelListModel

    public init(
        session: IOSSession,
        bootstrap: WorkspaceBootstrap,
        signOut: @escaping @MainActor () -> Void
    ) {
        let backend = MomoServerConversationClient(authenticated: session)
        self.session = session
        self.bootstrap = bootstrap
        self.signOut = signOut
        self.backend = backend
        _model = State(initialValue: IOSChannelListModel(currentMemberID: session.member.id, backend: backend))
    }

    public var body: some View {
        List {
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
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    LabeledContent("Signed in as", value: session.member.displayName)
                    Button("Sign out", action: signOut)
                } label: {
                    Label("Workspace menu", systemImage: "person.crop.circle")
                }
                .accessibilityIdentifier("workspaceMenu")
            }
        }
        .task { await model.load() }
        .onAppear {
            if model.phase == .loaded {
                Task { await model.refresh() }
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
                ContentUnavailableView(
                    "No conversations yet",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Create a channel or start a direct message in momo on Mac.")
                )
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

    private func channelLink(_ item: IOSChannelListItem) -> some View {
        NavigationLink {
            IOSTimelineView(
                item: item,
                members: model.membersByID,
                currentMemberID: session.member.id,
                backend: backend
            )
        } label: {
            IOSChannelRow(item: item)
        }
        .accessibilityIdentifier("channel.\(item.id.description)")
    }
}

private struct IOSChannelRow: View {
    let item: IOSChannelListItem

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: item.isDirectMessage ? "person.crop.circle" : channelIcon)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(item.title)
                .font(.body.weight(item.hasUnread ? .semibold : .regular))
                .lineLimit(2)
            Spacer(minLength: 8)
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

    private var channelIcon: String {
        item.channel.kind == .privateChannel ? "lock" : "number"
    }

    private var accessibilityLabel: String {
        guard item.unreadCount > 0 else { return item.title }
        if item.mentionCount > 0 {
            return "\(item.title), \(item.unreadCount) unread, \(item.mentionCount) mentions"
        }
        return "\(item.title), \(item.unreadCount) unread"
    }
}

@MainActor
private struct IOSTimelineView: View {
    let item: IOSChannelListItem
    let members: [MemberID: Member]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model: IOSTimelineModel
    @State private var visibleMessageIDs: Set<MessageID> = []

    init(
        item: IOSChannelListItem,
        members: [MemberID: Member],
        currentMemberID: MemberID,
        backend: any IOSConversationBackend
    ) {
        self.item = item
        self.members = members
        _model = State(initialValue: IOSTimelineModel(
            channel: item.id,
            currentMemberID: currentMemberID,
            backend: backend
        ))
    }

    var body: some View {
        ScrollViewReader { proxy in
            List {
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
                    ForEach(model.messages) { message in
                        IOSMessageRow(
                            message: message,
                            member: members[message.authorMemberId],
                            quotedBody: quotedBody(for: message),
                            model: model
                        )
                            .id(message.id)
                            .listRowSeparator(.hidden)
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
        .onDisappear { model.stop() }
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

private struct IOSMessageRow: View {
    let message: Message
    let member: Member?
    let quotedBody: String?
    let model: IOSTimelineModel

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "person.crop.circle.fill")
                .font(.title3)
                .foregroundStyle(member?.kind == .agent ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(member?.displayName ?? "Unknown member")
                        .font(.body.weight(.semibold))
                    Spacer(minLength: 8)
                    if let createdAt = message.createdAtMs {
                        Text(Date(timeIntervalSince1970: Double(createdAt) / 1_000), format: .dateTime.hour().minute())
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
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
        .padding(.vertical, 8)
        .accessibilityElement(children: message.type == .approvalRequest ? .contain : .combine)
    }

    @ViewBuilder
    private var messageContent: some View {
        if message.isDeleted {
            Text("Message deleted")
                .font(.body)
                .foregroundStyle(.secondary)
        } else if message.type == .approvalRequest {
            IOSApprovalDecisionCard(message: message, model: model)
        } else {
            Text(message.body ?? fallbackText)
                .font(.body)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
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
