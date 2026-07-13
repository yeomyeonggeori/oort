import SwiftUI
import MomoCore

// MARK: - AgentPartialView  (agent.partial streaming render)
//
// Renders an in-flight agent message as it streams (L4 §5.2 agent.partial +
// §6.2 worker SSE → publish loop). Coalesced text deltas grow a single bubble;
// an in-progress tool_call shows a live card; running micro_usd ticks up via the
// CostBreathingRing (experience B). This is the live counterpart to MessageBubble
// before the message is committed with a seq.

public struct AgentPartialView: View {
    public let partial: AgentPartial
    public let author: Member?
    /// Live run status (drives the phase chip: thinking/streaming/…).
    public let status: AgentStatus?

    public init(partial: AgentPartial, author: Member?, status: AgentStatus? = nil) {
        self.partial = partial
        self.author = author
        self.status = status
    }

    public var body: some View {
        HStack(alignment: .top, spacing: MomoTheme.gutter) {
            avatar
            VStack(alignment: .leading, spacing: 4) {
                header
                // Streaming text delta (coalesced upstream in the ViewModel).
                // A subtle streaming caret cue is concatenated as Text before any
                // view modifier so the `+` stays a Text concatenation.
                if let text = partial.textDelta, !text.isEmpty {
                    AgentTranscriptText(text: text, isStreaming: true, style: .message)
                }
                // In-progress tool_call (experience D: live tool-call card).
                if let toolName = partial.toolCallName {
                    liveToolCallCard(name: toolName)
                }
            }
            Spacer(minLength: 0)
            CostBreathingRing(
                reservedMicroUSD: status?.reservedMicroUSD,
                spentMicroUSD: partial.spentMicroUSD ?? status?.spentMicroUSD,
                isReconciled: false,
                wasEstimated: false
            )
        }
        .padding(.vertical, 4)
    }

    private var avatar: some View {
        Circle()
            .fill(MomoTheme.agentAccent.opacity(0.2))
            .frame(width: MomoTheme.messageAvatarSize, height: MomoTheme.messageAvatarSize)
            .overlay(
                Image(systemName: "sparkles")
                    .font(.caption)
                    .foregroundStyle(MomoTheme.agentAccent)
            )
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text(author?.displayName ?? "agent").font(.subheadline.bold())
            phaseChip
        }
    }

    @ViewBuilder
    private var phaseChip: some View {
        let phase = status?.phase ?? .streaming
        Text(phase.rawValue)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 4)
            .padding(.vertical, 4)
            .background(MomoTheme.agentAccent.opacity(0.18), in: Capsule())
            .foregroundStyle(MomoTheme.agentAccent)
    }

    private func liveToolCallCard(name: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                ProgressView().controlSize(.small)
                Text("tool_call · \(name)").font(.caption.bold())
                    .foregroundStyle(MomoTheme.agentAccent)
            }
            if let args = partial.toolCallArgs,
               let data = try? JSONEncoder.momo.encode(args),
               let str = String(data: data, encoding: .utf8) {
                Text(str).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            // TODO(T09-followup, experience D): [Cancel] [Edit params] [Retry] while live.
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MomoTheme.agentAccent.opacity(0.06),
                    in: RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner))
    }
}

/// Shared text renderer for live partials and Work transcript surfaces. Keeping
/// the streaming caret here prevents Work cards from inventing a second partial
/// stream visual language.
struct AgentTranscriptText: View {
    enum Style {
        case message
        case transcript
    }

    let text: String
    var isStreaming = false
    var lineLimit: Int?
    var style: Style = .transcript

    var body: some View {
        Group {
            switch style {
            case .message:
                renderedText
                    .font(.body)
            case .transcript:
                renderedText
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .lineLimit(lineLimit)
        .textSelection(.enabled)
        .accessibilityLabel(text)
    }

    private var renderedText: Text {
        if isStreaming {
            return Text(text) + Text(" ▌").foregroundColor(MomoTheme.agentAccent)
        }
        return Text(text)
    }
}
