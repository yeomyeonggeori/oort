import SwiftUI
import AppKit
import MomoCore

// MARK: - MessageBubble
//
// Renders a single message. Agent messages get FIRST-CLASS rendering of the
// structured message types (L4 §5.2, schema message_type): tool_call /
// tool_result / diff / approval_request / artifact are rendered as their own
// cards rather than plain text. MOMO-170 keeps these cards lightweight but gives
// them a stable metadata strip for Context Packet, Memory Plane, Capability Cache,
// source, and cost display.
//
// Cost breathing (experience B) attaches a CostBreathingRing to agent bubbles when
// a CostSnapshot is available for the message's run.

public struct MessageBubble: View {
    public let message: Message
    public let author: Member?
    /// Optional cost snapshot for the message's run (experience B).
    public let cost: CostSnapshot?
    public let approvalStatus: ApprovalStatus?
    public let isApprovalDecisionInFlight: Bool
    public let onApprovalDecision: ((ApprovalID, Bool) -> Void)?
    private let reactions: [MomoMessageReaction]
    private let replyCount: Int
    private let canModify: Bool
    private let interactionError: MomoMessageInteractionError?
    private let onToggleReaction: ((String) -> Void)?
    private let onOpenThread: (() -> Void)?
    private let onOpenWorkTerminal: (() -> Void)?
    private let onOpenWorkSession: (() -> Void)?
    private let onEdit: ((String) async -> Bool)?
    private let onDelete: (() -> Void)?
    private let onDismissInteractionError: (() -> Void)?
    private let attachmentDownloadStates: [FileID: MomoAttachmentDownloadState]
    private let onDownloadAttachment: ((MessageAttachment) -> Void)?
    private let onOpenAttachment: ((MessageAttachment) -> Void)?
    private let groupingStyle: MessageBubbleGroupingStyle
    private let timelineCopy: MomoWorkspaceCopy
    private let presentation: MomoDeveloperModePresentation
    private let memoryDelivery: MomoMemoryDeliveryReceipt?
    private let onOpenServedContext: (() -> Void)?
    @State private var isHovered = false
    @State private var isBasicCardExpanded = false
    @State private var isEditing = false
    @State private var editDraft = ""
    @State private var isSavingEdit = false
    @State private var showsDeleteConfirmation = false
    @FocusState private var focusedMessageAction: MessageActionFocus?
    @FocusState private var isEditFieldFocused: Bool

    private enum MessageActionFocus: Hashable {
        case reaction(String)
        case emojiMenu
        case reply
        case more
    }

    public init(
        message: Message,
        author: Member?,
        cost: CostSnapshot? = nil,
        approvalStatus: ApprovalStatus? = nil,
        isApprovalDecisionInFlight: Bool = false,
        onApprovalDecision: ((ApprovalID, Bool) -> Void)? = nil
    ) {
        self.message = message
        self.author = author
        self.cost = cost
        self.approvalStatus = approvalStatus
        self.isApprovalDecisionInFlight = isApprovalDecisionInFlight
        self.onApprovalDecision = onApprovalDecision
        self.reactions = []
        self.replyCount = 0
        self.canModify = false
        self.interactionError = nil
        self.onToggleReaction = nil
        self.onOpenThread = nil
        self.onOpenWorkTerminal = nil
        self.onOpenWorkSession = nil
        self.onEdit = nil
        self.onDelete = nil
        self.onDismissInteractionError = nil
        self.attachmentDownloadStates = [:]
        self.onDownloadAttachment = nil
        self.onOpenAttachment = nil
        self.groupingStyle = .standalone
        self.timelineCopy = MomoWorkspaceCopy(language: .preferredDefault)
        self.presentation = .standard
        self.memoryDelivery = nil
        self.onOpenServedContext = nil
    }

    init(
        message: Message,
        author: Member?,
        cost: CostSnapshot? = nil,
        approvalStatus: ApprovalStatus? = nil,
        isApprovalDecisionInFlight: Bool = false,
        onApprovalDecision: ((ApprovalID, Bool) -> Void)? = nil,
        reactions: [MomoMessageReaction] = [],
        replyCount: Int = 0,
        canModify: Bool = false,
        interactionError: MomoMessageInteractionError? = nil,
        onToggleReaction: ((String) -> Void)? = nil,
        onOpenThread: (() -> Void)? = nil,
        onOpenWorkTerminal: (() -> Void)? = nil,
        onOpenWorkSession: (() -> Void)? = nil,
        onEdit: ((String) async -> Bool)? = nil,
        onDelete: (() -> Void)? = nil,
        onDismissInteractionError: (() -> Void)? = nil,
        attachmentDownloadStates: [FileID: MomoAttachmentDownloadState] = [:],
        onDownloadAttachment: ((MessageAttachment) -> Void)? = nil,
        onOpenAttachment: ((MessageAttachment) -> Void)? = nil,
        groupingStyle: MessageBubbleGroupingStyle,
        timelineCopy: MomoWorkspaceCopy,
        presentation: MomoDeveloperModePresentation = .standard,
        memoryDelivery: MomoMemoryDeliveryReceipt? = nil,
        onOpenServedContext: (() -> Void)? = nil
    ) {
        self.message = message
        self.author = author
        self.cost = cost
        self.approvalStatus = approvalStatus
        self.isApprovalDecisionInFlight = isApprovalDecisionInFlight
        self.onApprovalDecision = onApprovalDecision
        self.reactions = reactions
        self.replyCount = replyCount
        self.canModify = canModify
        self.interactionError = interactionError
        self.onToggleReaction = onToggleReaction
        self.onOpenThread = onOpenThread
        self.onOpenWorkTerminal = onOpenWorkTerminal
        self.onOpenWorkSession = onOpenWorkSession
        self.onEdit = onEdit
        self.onDelete = onDelete
        self.onDismissInteractionError = onDismissInteractionError
        self.attachmentDownloadStates = attachmentDownloadStates
        self.onDownloadAttachment = onDownloadAttachment
        self.onOpenAttachment = onOpenAttachment
        self.groupingStyle = groupingStyle
        self.timelineCopy = timelineCopy
        self.presentation = presentation
        self.memoryDelivery = memoryDelivery
        self.onOpenServedContext = onOpenServedContext
    }

    private var isAgent: Bool { author?.isAgent ?? false }

    @ViewBuilder
    public var body: some View {
        if safetySystemKind != nil {
            safetySystemLine
        } else {
            standardMessageBody
        }
    }

    private var standardMessageBody: some View {
        HStack(alignment: .top, spacing: MomoTheme.gutter) {
            leadingColumn
            VStack(alignment: .leading, spacing: 4) {
                if groupingStyle != .compact {
                    header
                } else if message.isPendingAck {
                    Text(deliveryStatusText)
                        .font(.caption)
                        .foregroundStyle(deliveryStatusColor)
                }
                if isEditing {
                    inlineEditor
                } else {
                    content
                }
                messageMetadata
            }
            Spacer(minLength: 0)
            if isAgent, presentation.showsCosts, let cost {
                CostBreathingRing(
                    reservedMicroUSD: cost.reservedMicroUSD,
                    spentMicroUSD: cost.spentMicroUSD,
                    isReconciled: cost.isReconciled,
                    wasEstimated: cost.wasEstimated,
                    limitState: cost.limitState
                )
            }
        }
        .padding(.vertical, groupingStyle == .compact ? 0 : 4)
        .padding(.horizontal, 4)
        .background(isHovered ? Color.primary.opacity(0.04) : .clear)
        .contentShape(Rectangle())
        .overlay(alignment: .topTrailing) {
            messageActionBar
                .padding(.trailing, isAgent && presentation.showsCosts && cost != nil ? 32 : 0)
        }
        .onHover { isHovered = $0 }
        .contextMenu {
            if !message.isDeleted, onOpenThread != nil {
                Button(timelineCopy.replyToMessage, systemImage: "arrowshape.turn.up.left", action: openThread)
            }
            if copyText != nil {
                Button(timelineCopy.copyMessage, systemImage: "doc.on.doc", action: copyMessage)
            }
            if canModify, onEdit != nil {
                Divider()
                Button(timelineCopy.editMessage, systemImage: "pencil", action: beginEditing)
            }
            if canModify, onDelete != nil {
                Button(timelineCopy.deleteMessage, systemImage: "trash", role: .destructive) {
                    showsDeleteConfirmation = true
                }
            }
        }
        .confirmationDialog(
            timelineCopy.deleteMessageConfirmation,
            isPresented: $showsDeleteConfirmation
        ) {
            Button(timelineCopy.deleteMessage, role: .destructive) { onDelete?() }
            Button(timelineCopy.cancel, role: .cancel) {}
        }
    }

    private var safetySystemLine: some View {
        HStack(spacing: 8) {
            Image(systemName: safetySystemKind == "agent_run_cancelled" ? "stop.circle" : "pause.circle")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(
                safetySystemKind == "agent_run_cancelled"
                    ? timelineCopy.agentRunCancelledSystemLine
                    : timelineCopy.agentPausedSystemLine
            )
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            if let date = timestampDate {
                Spacer(minLength: 8)
                Text(date, format: .dateTime.hour().minute())
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var safetySystemKind: String? {
        guard message.type == .system,
              let kind = message.props["kind"]?.stringValue,
              kind == "agent_run_cancelled" || kind == "agent_paused"
        else { return nil }
        return kind
    }

    // MARK: Parts

    @ViewBuilder
    private var leadingColumn: some View {
        if groupingStyle == .compact {
            compactTimestamp
                .frame(width: MomoTheme.messageAvatarSize, alignment: .trailing)
        } else {
            avatar
        }
    }

    private var avatar: some View {
        Circle()
            .fill(isAgent ? MomoTheme.agentAccent.opacity(0.2) : MomoTheme.humanAccent.opacity(0.2))
            .frame(width: MomoTheme.messageAvatarSize, height: MomoTheme.messageAvatarSize)
            .overlay(
                Text(String((author?.displayName ?? "?").prefix(1)))
                    .font(.caption.bold())
                    .foregroundStyle(isAgent ? MomoTheme.agentAccent : MomoTheme.humanAccent)
            )
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(author?.displayName ?? "unknown")
                .font(MomoTheme.Typography.emphasizedRow)
            if isAgent {
                Text("AGENT")
                    .font(.caption2.weight(.bold))
                    .padding(.horizontal, 4)
                    .background(MomoTheme.agentAccent.opacity(0.18), in: Capsule())
                    .foregroundStyle(MomoTheme.agentAccent)
            }
            if groupingStyle == .standalone {
                legacySequenceLabel
            } else {
                timelineTimestamp
            }
        }
    }

    @ViewBuilder
    private var legacySequenceLabel: some View {
        if let seq = message.seq {
            Text("#\(seq)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        } else {
            Text(deliveryStatusText)
                .font(.caption2)
                .foregroundStyle(deliveryStatusColor)
        }
    }

    @ViewBuilder
    private var timelineTimestamp: some View {
        if message.isPendingAck {
            Text(deliveryStatusText)
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(deliveryStatusColor)
        } else if let date = timestampDate {
            Text(date, format: .dateTime.hour().minute())
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }

    @ViewBuilder
    private var compactTimestamp: some View {
        if !message.isPendingAck, let date = timestampDate {
            Text(date, format: .dateTime.hour().minute())
                .font(.caption2)
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .opacity(isHovered ? 1 : 0)
                .accessibilityHidden(true)
        }
    }

    private var timestampDate: Date? {
        MessageTimelineLayout.timestampMs(for: message).map {
            Date(timeIntervalSince1970: Double($0) / 1_000)
        }
    }

    private var deliveryStatusText: String {
        message.state == .failed
            ? timelineCopy.messageSendFailed
            : timelineCopy.messageSending
    }

    private var deliveryStatusColor: Color {
        message.state == .failed ? MomoTheme.irreversibleRed : .secondary
    }

    @ViewBuilder
    private var messageActionBar: some View {
        if !message.isDeleted, hasMessageInteractions {
            // A compact custom bar keeps frequent reactions and reply one click away;
            // the lower-frequency actions remain inside native Menu/contextMenu controls.
            HStack(spacing: 0) {
                if onToggleReaction != nil {
                    ForEach(["👍", "👀", "🎉"], id: \.self) { emoji in
                        reactionButton(emoji)
                    }
                    Menu {
                        ForEach(["❤️", "😂", "😮", "😢", "🙏", "✅"], id: \.self) { emoji in
                            Button(emoji) { onToggleReaction?(emoji) }
                        }
                    } label: {
                        Image(systemName: "face.smiling")
                    }
                    .menuStyle(.borderlessButton)
                    .momoQuickTooltip(timelineCopy.addReaction)
                    .focused($focusedMessageAction, equals: .emojiMenu)
                }

                if onOpenThread != nil {
                    Button(action: openThread) {
                        Image(systemName: "arrowshape.turn.up.left")
                    }
                    .buttonStyle(.borderless)
                    .momoQuickTooltip(timelineCopy.replyToMessage)
                    .focused($focusedMessageAction, equals: .reply)
                }

                Menu {
                    if onOpenThread != nil {
                        Button(timelineCopy.replyToMessage, systemImage: "arrowshape.turn.up.left", action: openThread)
                    }
                    if copyText != nil {
                        Button(timelineCopy.copyMessage, systemImage: "doc.on.doc", action: copyMessage)
                    }
                    if canModify, onEdit != nil {
                        Divider()
                        Button(timelineCopy.editMessage, systemImage: "pencil", action: beginEditing)
                    }
                    if canModify, onDelete != nil {
                        Button(timelineCopy.deleteMessage, systemImage: "trash", role: .destructive) {
                            showsDeleteConfirmation = true
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .menuStyle(.borderlessButton)
                .momoQuickTooltip(timelineCopy.moreMessageActions)
                .focused($focusedMessageAction, equals: .more)
            }
            .controlSize(.small)
            .padding(4)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall))
            .overlay(RoundedRectangle(cornerRadius: MomoTheme.cornerSmall).strokeBorder(.separator, lineWidth: 1))
            .shadow(color: .black.opacity(0.08), radius: 4, y: 2)
            .opacity(isHovered || focusedMessageAction != nil ? 1 : 0)
            .padding(.top, -8)
        }
    }

    private func reactionButton(_ emoji: String) -> some View {
        Button(emoji) { onToggleReaction?(emoji) }
            .buttonStyle(.borderless)
            .momoQuickTooltip(timelineCopy.reactWith(emoji))
            .accessibilityLabel(timelineCopy.reactWith(emoji))
            .frame(
                minWidth: MomoTheme.MessageInteraction.actionMinimumSize,
                minHeight: MomoTheme.MessageInteraction.actionMinimumSize
            )
            .focused($focusedMessageAction, equals: .reaction(emoji))
    }

    @ViewBuilder
    private var messageMetadata: some View {
        if visibleMemoryDelivery != nil
            || !reactions.isEmpty
            || showsReplyMetadata
            || interactionError != nil
            || showsEditedMetadata {
            VStack(alignment: .leading, spacing: 4) {
                if let visibleMemoryDelivery, let onOpenServedContext {
                    MomoMemoryDeliveryMetadata(
                        receipt: visibleMemoryDelivery,
                        copy: timelineCopy,
                        onOpenServedContext: onOpenServedContext
                    )
                }
                if !reactions.isEmpty || showsReplyMetadata {
                    MomoReactionFlowLayout(spacing: MomoTheme.MessageInteraction.compactSpacing) {
                        ForEach(reactions) { reaction in
                            if onToggleReaction != nil {
                                reactionChip(reaction)
                            } else {
                                reactionChipLabel(reaction)
                            }
                        }

                        if showsReplyMetadata {
                            if onOpenThread != nil {
                                Button(action: openThread) {
                                    Label(timelineCopy.replyCount(replyCount), systemImage: "arrowshape.turn.up.left")
                                        .font(.caption)
                                }
                                .buttonStyle(.borderless)
                            } else {
                                Label(timelineCopy.replyCount(replyCount), systemImage: "arrowshape.turn.up.left")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if showsEditedMetadata {
                    Text(timelineCopy.editedMessage)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                if let interactionError {
                    HStack(spacing: 4) {
                        Label(interactionError.message(copy: timelineCopy), systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(MomoTheme.irreversibleRed)
                        Button(timelineCopy.dismissMessageFocusFailure) { onDismissInteractionError?() }
                            .buttonStyle(.borderless)
                            .controlSize(.mini)
                    }
                }
            }
        }
    }

    private var showsEditedMetadata: Bool {
        !message.isDeleted && (message.editedAtMs != nil || message.state == .edited)
    }

    private var visibleMemoryDelivery: MomoMemoryDeliveryReceipt? {
        guard isAgent,
              message.runId != nil,
              onOpenServedContext != nil,
              memoryDelivery?.isVisible == true else { return nil }
        return memoryDelivery
    }

    private var showsReplyMetadata: Bool {
        !message.isDeleted && replyCount > 0
    }

    private var inlineEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextEditor(text: $editDraft)
                .font(.body)
                .frame(
                    minHeight: MomoTheme.MessageInteraction.editorMinimumHeight,
                    maxHeight: MomoTheme.MessageInteraction.editorMaximumHeight
                )
                .padding(8)
                .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: MomoTheme.cornerMedium))
                .overlay(RoundedRectangle(cornerRadius: MomoTheme.cornerMedium).strokeBorder(.separator, lineWidth: 1))
                .focused($isEditFieldFocused)
                .onExitCommand(perform: cancelEditing)
            HStack(spacing: 8) {
                Button(timelineCopy.save) {
                    saveEdit()
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    isSavingEdit
                        || editDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
                .keyboardShortcut(.return, modifiers: .command)
                Button(timelineCopy.cancel, action: cancelEditing)
                Text(timelineCopy.editMessageKeyboardHint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var hasMessageInteractions: Bool {
        onToggleReaction != nil || onOpenThread != nil || copyText != nil || onEdit != nil || onDelete != nil
    }

    private func reactionChip(_ reaction: MomoMessageReaction) -> some View {
        Button { onToggleReaction?(reaction.emoji) } label: {
            reactionChipLabel(reaction)
        }
        .buttonStyle(.plain)
    }

    private func reactionChipLabel(_ reaction: MomoMessageReaction) -> some View {
        Text("\(reaction.emoji) \(reaction.count)")
            .font(.caption)
            .monospacedDigit()
            .padding(.horizontal, MomoTheme.MessageInteraction.standardSpacing)
            .padding(.vertical, MomoTheme.MessageInteraction.compactSpacing)
            .background(
                reaction.isSelectedByCurrentMember
                    ? MomoTheme.selectionBackground
                    : Color.primary.opacity(0.05),
                in: Capsule()
            )
            .overlay(
                Capsule().strokeBorder(
                    reaction.isSelectedByCurrentMember
                        ? MomoTheme.humanAccent.opacity(0.45)
                        : Color(nsColor: .separatorColor),
                    lineWidth: 1
                )
            )
            .accessibilityLabel(timelineCopy.reactionCount(emoji: reaction.emoji, count: reaction.count))
    }

    private func openThread() { onOpenThread?() }

    private func beginEditing() {
        editDraft = message.body ?? ""
        isEditing = true
        Task { @MainActor in isEditFieldFocused = true }
    }

    private func cancelEditing() {
        guard !isSavingEdit else { return }
        isEditing = false
        editDraft = ""
    }

    private func saveEdit() {
        guard let onEdit, !isSavingEdit else { return }
        isSavingEdit = true
        Task {
            let didSave = await onEdit(editDraft)
            isSavingEdit = false
            if didSave {
                isEditing = false
                editDraft = ""
            } else {
                isEditFieldFocused = true
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        VStack(alignment: .leading, spacing: MomoTheme.Attachment.standardSpacing) {
            primaryContent
            if !message.isDeleted,
               let attachments = message.attachments,
               !attachments.isEmpty,
               let onDownloadAttachment,
               let onOpenAttachment {
                MomoMessageAttachmentList(
                    attachments: attachments,
                    downloadStates: attachmentDownloadStates,
                    copy: timelineCopy,
                    onDownload: onDownloadAttachment,
                    onOpen: onOpenAttachment
                )
            }
        }
    }

    @ViewBuilder
    private var primaryContent: some View {
        if message.isDeleted {
            Text(timelineCopy.deletedMessage)
                .momoTypography(.messageBody)
                .italic()
                .foregroundStyle(.secondary)
        } else if message.props["kind"]?.stringValue == "resume_offer" {
            resumeOfferCard
        } else if message.props["kind"]?.stringValue == "work_session" {
            workSessionCard
        } else if let artifact = MessageArtifactPresentation.resolve(message: message) {
            MomoMessageArtifactCard(presentation: artifact)
        } else if isAgent,
                  !presentation.showsDeveloperDetails,
                  message.type != .text,
                  message.type != .system {
            basicAgentContent
        } else {
            switch message.type {
            case .text, .system:
                if let body = message.body, !body.isEmpty {
                    Text(body)
                        .momoTypography(.messageBody)
                        .textSelection(.enabled)
                }
            case .toolCall:
                toolCallCard
            case .toolResult:
                toolResultCard
            case .diff:
                diffCard
            case .approvalRequest:
                approvalRequestCard
            case .artifact:
                artifactCard
            }
        }
    }

    @ViewBuilder
    private var basicAgentContent: some View {
        if message.type == .approvalRequest {
            VStack(alignment: .leading, spacing: 8) {
                Text(basicAgentSummary)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                approvalActions
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .momoSurface(.panel)
        } else {
            DisclosureGroup(isExpanded: $isBasicCardExpanded) {
                if basicAgentDetail != basicAgentSummary {
                    Text(basicAgentDetail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 4)
                }
            } label: {
                Label(basicAgentSummary, systemImage: basicAgentIcon)
                    .font(.body)
                    .lineLimit(isBasicCardExpanded ? nil : 2)
                    .fixedSize(horizontal: false, vertical: isBasicCardExpanded)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .momoSurface(.panel)
        }
    }

    // MARK: First-class type cards (placeholders)

    private var toolCallCard: some View {
        cardFrame(icon: "wrench.and.screwdriver", tint: MomoTheme.agentAccent, title: "tool_call") {
            let name = message.props["name"]?.stringValue
                ?? message.props["capability"]?["tool_name"]?.stringValue
                ?? "tool"
            Text(name).font(.callout.monospaced())
            if let callId = message.props["call_id"]?.stringValue {
                Text(callId).font(.caption2.monospaced()).foregroundStyle(.tertiary)
            }
            if let args = message.props["arguments"] {
                Text(prettyJSON(args)).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            // TODO(T09-followup, experience D): inline [Cancel] [Edit params] [Retry]
            // live controls while streaming (modify-then-retry).
        }
    }

    private var toolResultCard: some View {
        let isError = message.props["is_error"]?.boolValue ?? false
        return cardFrame(icon: "arrow.uturn.backward",
                         tint: isError ? MomoTheme.irreversibleRed : MomoTheme.reversibleGreen,
                         title: isError ? "tool_result (error)" : "tool_result") {
            if let toolName = message.props["tool_name"]?.stringValue {
                Text(toolName).font(.callout.monospaced())
            }
            if let output = message.props["output"] {
                Text(prettyJSON(output)).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            if let artifact = message.props["artifact_ref"] {
                Text(prettyJSON(artifact)).font(.caption2.monospaced()).foregroundStyle(.tertiary)
            }
        }
    }

    private var diffCard: some View {
        cardFrame(icon: "doc.text.magnifyingglass", tint: MomoTheme.humanAccent, title: "diff") {
            if let path = message.props["path"]?.stringValue {
                Text(path).font(.caption.monospaced())
            }
            if let patch = message.props["patch"]?.stringValue {
                Text(patch).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(8)
            }
            // TODO(T09-followup): syntax-highlighted +/- gutter rendering.
        }
    }

    private var approvalRequestCard: some View {
        cardFrame(icon: "exclamationmark.shield", tint: MomoTheme.costAmber, title: "approval_request") {
            let action = message.props["action_type"]?.stringValue
                ?? message.props["tool_name"]?.stringValue
                ?? "action"
            Text("Needs approval: \(action)").font(.callout)
            if let title = message.props["title"]?.stringValue {
                Text(title).font(.caption)
            }
            if let summary = message.props["summary"]?.stringValue {
                Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            approvalActions
        }
    }

    @ViewBuilder
    private var approvalActions: some View {
        let status = approvalStatus ?? approvalStatusFromProps ?? .pending
        ApprovalDecisionControls(
            approvalId: approvalId,
            status: status,
            isInFlight: isApprovalDecisionInFlight,
            copy: timelineCopy,
            onDecision: onApprovalDecision
        )
    }

    private var artifactCard: some View {
        cardFrame(icon: "paperclip", tint: .secondary, title: "artifact") {
            Text(message.props["title"]?.stringValue ?? "artifact").font(.callout)
            if let kind = message.props["kind"]?.stringValue {
                Text(kind).font(.caption).foregroundStyle(.secondary)
            }
            if let uri = message.props["uri"]?.stringValue {
                Text(uri).font(.caption2.monospaced()).foregroundStyle(.tertiary).lineLimit(1)
            }
        }
    }

    private var workSessionCard: some View {
        let tool = MomoWorkTool(rawValue: message.props["tool"]?.stringValue ?? "shell")
        let status = MomoWorkSessionStatus(
            rawValue: message.props["status"]?.stringValue ?? "running"
        ) ?? .running
        let isRunning = status == .running
        let label = message.props["label"]?.stringValue ?? timelineCopy.workConsole
        let tint: Color = status == .orphaned
            ? MomoTheme.costAmber
            : (isRunning ? MomoTheme.agentAccent : .secondary)

        return cardFrame(
            icon: tool.systemImage,
            tint: tint,
            title: timelineCopy.workConsole
        ) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(label)
                    .momoTypography(.emphasizedRow)
                Text(timelineCopy.workToolTitle(tool))
                    .momoTypography(.metadata)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Text(timelineCopy.workSessionStatus(status))
                    .momoTypography(.metadata)
                    .fontWeight(.semibold)
                    .foregroundStyle(tint)
            }
            if let rawSourceID = message.props["resumed_from_session_id"]?.stringValue,
               let sourceID = WorkSessionID(uuidString: rawSourceID.lowercased()) {
                Text("\(timelineCopy.workSessionLineage) \(timelineCopy.workSessionShortID(sourceID))")
                    .momoTypography(.metadata)
                    .foregroundStyle(.secondary)
            }
            if let exitCode = message.props["exit_code"]?.intValue {
                Text(timelineCopy.workSessionExit(Int(exitCode)))
                    .momoTypography(.metadata)
                    .foregroundStyle(.secondary)
            }
            if onOpenThread != nil {
                Button(action: openThread) {
                    Label(timelineCopy.workSessionOpenThread, systemImage: "arrowshape.turn.up.left")
                }
                .buttonStyle(.borderless)
            }
            if isRunning, let onOpenWorkTerminal {
                Button(action: onOpenWorkTerminal) {
                    Label(timelineCopy.workSessionOpenRemoteTerminal, systemImage: "terminal")
                }
                .buttonStyle(.borderless)
            }
        }
    }

    private var resumeOfferCard: some View {
        cardFrame(
            icon: "arrow.trianglehead.2.clockwise.rotate.90",
            tint: MomoTheme.costAmber,
            title: timelineCopy.workResumeOfferTitle
        ) {
            Text(message.body?.isEmpty == false ? message.body ?? timelineCopy.workResumeOfferBody : timelineCopy.workResumeOfferBody)
                .momoTypography(.messageBody)
                .fixedSize(horizontal: false, vertical: true)
            Label(timelineCopy.workResumeLossWarning, systemImage: "exclamationmark.triangle")
                .momoTypography(.metadata)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let onOpenWorkSession {
                Button(action: onOpenWorkSession) {
                    Label(timelineCopy.workResumeOpenConsole, systemImage: "terminal")
                }
                .buttonStyle(.bordered)
            }
        }
    }

    // MARK: helpers

    @ViewBuilder
    private func cardFrame<Content: View>(
        icon: String, tint: Color, title: String,
        @ViewBuilder _ content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: icon).foregroundStyle(tint)
                Text(title).font(.caption.bold()).foregroundStyle(tint)
            }
            content()
            AgentProtocolMetadataStrip(
                props: message.props,
                showsCosts: presentation.showsCosts
            )
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.06), in: RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner))
        .momoSurface(.card)
        .overlay(
            RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner)
                .strokeBorder(tint.opacity(0.25), lineWidth: 1)
        )
    }

    private func prettyJSON(_ json: JSON) -> String {
        guard let data = try? JSONEncoder.momo.encode(json),
              let str = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return str
    }

    private var copyText: String? {
        guard !message.isDeleted else { return nil }
        if let body = message.body, !body.isEmpty {
            return body
        }
        if isAgent, !presentation.showsDeveloperDetails {
            return basicAgentDetail
        }
        guard message.props != .object([:]) else { return nil }
        return prettyJSON(message.props)
    }

    private var basicAgentSummary: String {
        if let summary = message.props["human_summary"]?.stringValue,
           !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return summary
        }
        let agentName = author?.displayName ?? timelineCopy.agent
        if let summary = message.props["summary"]?.stringValue
            ?? message.props["title"]?.stringValue,
           !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return timelineCopy.agentActivitySummary(agentName: agentName, detail: summary)
        }
        return timelineCopy.agentActivityFallback(message.type, agentName: agentName)
    }

    private var basicAgentDetail: String {
        if let detail = message.props["human_detail"]?.stringValue,
           !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return detail
        }
        if let summary = message.props["summary"]?.stringValue
            ?? message.props["title"]?.stringValue,
           !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return summary
        }
        return basicAgentSummary
    }

    private var basicAgentIcon: String {
        switch message.type {
        case .toolCall: return "gearshape.2"
        case .toolResult: return "checkmark.circle"
        case .diff: return "doc.text.magnifyingglass"
        case .approvalRequest: return "exclamationmark.shield"
        case .artifact: return "paperclip"
        case .text, .system: return "text.bubble"
        }
    }

    private func copyMessage() {
        guard let copyText else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(copyText, forType: .string)
    }

    private var approvalId: ApprovalID? {
        guard let raw = message.props["approval_id"]?.stringValue else {
            return nil
        }
        return ApprovalID(raw)
    }

    private var approvalStatusFromProps: ApprovalStatus? {
        guard let raw = message.props["approval_status"]?.stringValue else {
            return nil
        }
        return ApprovalStatus(rawValue: raw)
    }

}

enum MessageBubbleGroupingStyle {
    case standalone
    case groupStart
    case compact
}

private struct MomoReactionFlowLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        layout(proposal: proposal, subviews: subviews).size
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let result = layout(proposal: ProposedViewSize(width: bounds.width, height: proposal.height), subviews: subviews)
        for (index, point) in result.points.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y),
                anchor: .topLeading,
                proposal: .unspecified
            )
        }
    }

    private func layout(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, points: [CGPoint]) {
        let availableWidth = proposal.width ?? .infinity
        var points: [CGPoint] = []
        var cursor = CGPoint.zero
        var rowHeight: CGFloat = 0
        var contentWidth: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if cursor.x > 0, cursor.x + size.width > availableWidth {
                cursor.x = 0
                cursor.y += rowHeight + spacing
                rowHeight = 0
            }
            points.append(cursor)
            cursor.x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            contentWidth = max(contentWidth, cursor.x - spacing)
        }
        return (CGSize(width: min(contentWidth, availableWidth), height: cursor.y + rowHeight), points)
    }
}
