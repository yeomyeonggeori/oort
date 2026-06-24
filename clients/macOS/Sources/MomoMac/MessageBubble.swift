import SwiftUI
import MomoCore

// MARK: - MessageBubble
//
// Renders a single message. Agent messages get FIRST-CLASS rendering of the
// structured message types (L4 §5.2, schema message_type): tool_call / tool_result /
// diff / approval_request are rendered as their own cards rather than plain text.
// These are v0 PLACEHOLDER cards per ticket T09 — correct shape + data wiring,
// minimal chrome.
//
// Cost breathing (experience B) attaches a CostBreathingRing to agent bubbles when
// a CostSnapshot is available for the message's run.

public struct MessageBubble: View {
    public let message: Message
    public let author: Member?
    /// Optional cost snapshot for the message's run (experience B).
    public let cost: CostSnapshot?

    public init(message: Message, author: Member?, cost: CostSnapshot? = nil) {
        self.message = message
        self.author = author
        self.cost = cost
    }

    private var isAgent: Bool { author?.isAgent ?? false }

    public var body: some View {
        HStack(alignment: .top, spacing: MomoTheme.gutter) {
            avatar
            VStack(alignment: .leading, spacing: 4) {
                header
                content
            }
            Spacer(minLength: 0)
            if isAgent, let cost {
                CostBreathingRing(
                    reservedMicroUSD: cost.reservedMicroUSD,
                    spentMicroUSD: cost.spentMicroUSD,
                    isReconciled: cost.spentMicroUSD > 0,
                    wasEstimated: cost.wasEstimated
                )
            }
        }
        .padding(.vertical, 4)
        .opacity(message.isDeleted ? 0.45 : 1)
    }

    // MARK: Parts

    private var avatar: some View {
        Circle()
            .fill(isAgent ? MomoTheme.agentAccent.opacity(0.2) : MomoTheme.humanAccent.opacity(0.2))
            .frame(width: 28, height: 28)
            .overlay(
                Text(String((author?.displayName ?? "?").prefix(1)))
                    .font(.caption.bold())
                    .foregroundStyle(isAgent ? MomoTheme.agentAccent : MomoTheme.humanAccent)
            )
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text(author?.displayName ?? "unknown")
                .font(.subheadline.bold())
            if isAgent {
                Text("AGENT").font(.system(size: 8, weight: .bold))
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(MomoTheme.agentAccent.opacity(0.18), in: Capsule())
                    .foregroundStyle(MomoTheme.agentAccent)
            }
            if let seq = message.seq {
                Text("#\(seq)").font(.caption2).foregroundStyle(.tertiary)
            } else {
                Text("sending…").font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if message.isDeleted {
            Text("(deleted)").italic().foregroundStyle(.secondary)
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

    // MARK: First-class type cards (placeholders)

    private var toolCallCard: some View {
        cardFrame(icon: "wrench.and.screwdriver", tint: MomoTheme.agentAccent, title: "tool_call") {
            let name = message.props["name"]?.stringValue ?? "tool"
            Text(name).font(.callout.monospaced())
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
            if let output = message.props["output"] {
                Text(prettyJSON(output)).font(.caption.monospaced()).foregroundStyle(.secondary)
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
            let action = message.props["action_type"]?.stringValue ?? "action"
            Text("Needs approval: \(action)").font(.callout)
            // TODO(T09-followup, experience C): inline [승인]/[거부] wired to decideApproval.
        }
    }

    private var artifactCard: some View {
        cardFrame(icon: "paperclip", tint: .secondary, title: "artifact") {
            Text(message.props["title"]?.stringValue ?? "artifact").font(.callout)
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
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.06), in: RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner))
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
}
