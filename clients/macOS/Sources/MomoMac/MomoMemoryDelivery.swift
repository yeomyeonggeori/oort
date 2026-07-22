import Foundation
import SwiftUI
import MomoCore

struct MomoMemoryDeliveryReceipt: Hashable, Sendable {
    let includedCount: Int
    let injected: Bool

    var isVisible: Bool { injected && includedCount > 0 }

    init?(includedCount: Int, injected: Bool) {
        guard includedCount >= 0 else { return nil }
        self.includedCount = includedCount
        self.injected = injected
    }

    init?(json: JSON?) {
        guard let includedCount = json?["included_count"]?.intValue,
              includedCount >= 0,
              includedCount <= Int64(Int.max),
              let injected = json?["injected"]?.boolValue else { return nil }
        self.includedCount = Int(includedCount)
        self.injected = injected
    }
}

protocol MomoAgentRunMemoryDeliveryProviding: Sendable {
    func memoryDeliveries(for runIDs: [RunID]) async -> [RunID: MomoMemoryDeliveryReceipt]
}

struct MomoAgentRunWireResponse: Decodable {
    let run: AgentWorkRun
    let memoryDelivery: MomoMemoryDeliveryReceipt?

    init(from decoder: Decoder) throws {
        run = try AgentWorkRun(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let input = try container.decodeIfPresent(JSON.self, forKey: .input)
        memoryDelivery = MomoMemoryDeliveryReceipt(json: input?["memory_delivery"])
    }

    private enum CodingKeys: String, CodingKey {
        case input
    }
}

struct MomoAgentRunPageWireResponse: Decodable {
    let runs: [MomoAgentRunWireResponse]
}

struct MomoMemoryDeliveryMetadata: View {
    let receipt: MomoMemoryDeliveryReceipt
    let copy: MomoWorkspaceCopy
    let onOpenServedContext: () -> Void

    var body: some View {
        if receipt.isVisible {
            Button(action: onOpenServedContext) {
                label
            }
            // 같은 메타 줄의 인터랙티브 이웃(답글 버튼)과 동일한 hover 피드백 관행.
            .buttonStyle(.borderless)
            .help(copy.servedContextAction)
            .accessibilityLabel(copy.memoryDeliverySummary(receipt.includedCount))
            .accessibilityHint(copy.servedContextAction)
        }
    }

    private var label: some View {
        Label(
            copy.memoryDeliverySummary(receipt.includedCount),
            systemImage: "brain.head.profile"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .monospacedDigit()
    }
}
