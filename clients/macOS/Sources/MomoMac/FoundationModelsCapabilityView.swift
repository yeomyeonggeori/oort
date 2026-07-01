import SwiftUI

struct FoundationModelsCapabilityView: View {
    let state: FoundationModelsCapabilityState

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: symbolName)
                    .foregroundStyle(tint)
                    .frame(width: 16)

                Text("Local LLM")
                    .font(.subheadline)
                    .lineLimit(1)

                Spacer(minLength: 8)

                Text(state.badgeText)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(tint)
            }

            Text("\(state.titleText): \(state.detailText)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private var symbolName: String {
        state.isAvailable ? "sparkles" : "arrow.triangle.2.circlepath"
    }

    private var tint: Color {
        state.isAvailable ? MomoTheme.agentAccent : .orange
    }
}
