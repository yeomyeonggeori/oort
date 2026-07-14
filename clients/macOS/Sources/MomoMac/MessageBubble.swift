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
    private let groupingStyle: MessageBubbleGroupingStyle
    private let timelineCopy: MomoWorkspaceCopy
    private let presentation: MomoDeveloperModePresentation
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isHovered = false
    @State private var isBasicCardExpanded = false
    @FocusState private var isCopyActionFocused: Bool

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
        self.groupingStyle = .standalone
        self.timelineCopy = MomoWorkspaceCopy(language: .preferredDefault)
        self.presentation = .standard
    }

    init(
        message: Message,
        author: Member?,
        cost: CostSnapshot? = nil,
        approvalStatus: ApprovalStatus? = nil,
        isApprovalDecisionInFlight: Bool = false,
        onApprovalDecision: ((ApprovalID, Bool) -> Void)? = nil,
        groupingStyle: MessageBubbleGroupingStyle,
        timelineCopy: MomoWorkspaceCopy,
        presentation: MomoDeveloperModePresentation = .standard
    ) {
        self.message = message
        self.author = author
        self.cost = cost
        self.approvalStatus = approvalStatus
        self.isApprovalDecisionInFlight = isApprovalDecisionInFlight
        self.onApprovalDecision = onApprovalDecision
        self.groupingStyle = groupingStyle
        self.timelineCopy = timelineCopy
        self.presentation = presentation
    }

    private var isAgent: Bool { author?.isAgent ?? false }

    public var body: some View {
        HStack(alignment: .top, spacing: MomoTheme.gutter) {
            leadingColumn
            VStack(alignment: .leading, spacing: 4) {
                if groupingStyle != .compact {
                    header
                } else if message.isPendingAck {
                    Text(timelineCopy.messageSending)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                content
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
        .animation(reduceMotion ? nil : MomoTheme.Motion.hover, value: isHovered)
        .contentShape(Rectangle())
        .overlay(alignment: .topTrailing) {
            copyAction
                .padding(.trailing, isAgent && presentation.showsCosts && cost != nil ? 32 : 0)
        }
        .onHover { isHovered = $0 }
        .contextMenu {
            if copyText != nil {
                Button(timelineCopy.copyMessage, systemImage: "doc.on.doc", action: copyMessage)
            }
        }
        .opacity(message.isDeleted ? 0.45 : 1)
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
            Text("sending…")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private var timelineTimestamp: some View {
        if message.isPendingAck {
            Text(timelineCopy.messageSending)
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(.secondary)
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

    @ViewBuilder
    private var copyAction: some View {
        if copyText != nil {
            Button(action: copyMessage) {
                Image(systemName: "doc.on.doc")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .focused($isCopyActionFocused)
            .help(timelineCopy.copyMessage)
            .accessibilityLabel(timelineCopy.copyMessage)
            .padding(4)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner))
            .opacity(isHovered || isCopyActionFocused ? 1 : 0)
        }
    }

    @ViewBuilder
    private var content: some View {
        if message.isDeleted {
            Text("(deleted)").italic().foregroundStyle(.secondary)
        } else if isAgent,
                  !presentation.showsDeveloperDetails,
                  message.type != .text,
                  message.type != .system {
            basicAgentContent
        } else {
            switch message.type {
            case .text, .system:
                Text(message.body ?? "")
                    .textSelection(.enabled)
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
