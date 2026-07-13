import SwiftUI
import MomoCore

/// Inline metadata chips have no interactive native-control equivalent; this
/// view keeps the existing AGENT badge grammar consistent across Mac surfaces.
struct MomoAgentBadgeGroup: View {
    let capabilities: [String]
    var maximumCapabilities = 2
    var showsAgentIdentity = true

    private var normalizedCapabilities: [String] {
        var seen = Set<String>()
        return capabilities.compactMap { capability in
            guard let normalized = Member.normalizedCapability(capability),
                  seen.insert(normalized).inserted
            else { return nil }
            return normalized
        }
    }

    private var visibleCapabilities: [String] {
        Array(normalizedCapabilities.prefix(max(0, maximumCapabilities)))
    }

    private var remainingCount: Int {
        max(0, normalizedCapabilities.count - visibleCapabilities.count)
    }

    private var remainingCapabilities: [String] {
        Array(normalizedCapabilities.dropFirst(visibleCapabilities.count))
    }

    var body: some View {
        HStack(spacing: MomoTheme.AgentBadge.spacing) {
            if showsAgentIdentity {
                badge("AGENT", background: MomoTheme.AgentBadge.identityBackground)
            }

            ForEach(visibleCapabilities, id: \.self) { capability in
                badge(capability, background: MomoTheme.AgentBadge.capabilityBackground)
                    .frame(maxWidth: MomoTheme.AgentBadge.maximumCapabilityWidth)
            }

            if remainingCount > 0 {
                badge(
                    "+\(remainingCount)",
                    background: MomoTheme.AgentBadge.capabilityBackground,
                    helpText: remainingCapabilities.joined(separator: ", ")
                )
                    .monospacedDigit()
            }
        }
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityElement(children: .combine)
    }

    private func badge(_ label: String, background: Color, helpText: String? = nil) -> some View {
        Text(label)
            .font(MomoTheme.AgentBadge.font)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, MomoTheme.AgentBadge.horizontalPadding)
            .background(background, in: Capsule())
            .foregroundStyle(MomoTheme.agentAccent)
            .help(helpText ?? label)
            .accessibilityLabel(helpText ?? label)
    }
}
