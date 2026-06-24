import SwiftUI
import MomoCore

// MARK: - CostBreathingRing  (experience B — Cost Breathing, placeholder)
//
// A ring gauge that "breathes" with the two-phase cost accounting (L4 §8.5):
//   - reserve  : dashed ring + "예약 $X" (pre-call estimate, reservedMicroUSD).
//   - in-flight: amber ring fills toward reserve as spentMicroUSD streams in
//                (driven by agent.partial / agent.status, L4 §5.2).
//   - reconcile: ring color locks at the reconciled actual.
//
// This is the v0 PLACEHOLDER per ticket T09 — static render of the phase, no
// breathing animation loop yet (that lands with the .app polish). It is wired to
// the real MomoCore cost fields so the data path is correct.
//
// TODO(T09-followup): add the breathing animation + soft_limit warning glow +
// inline approval_request slide-in (experience B money-shot).

public struct CostBreathingRing: View {
    /// Pre-call reservation (estimate upper bound), micro_usd. nil → no reserve yet.
    public let reservedMicroUSD: Int64?
    /// Reconciled / running spend, micro_usd.
    public let spentMicroUSD: Int64?
    /// True once reconciled (ring color locks, solid stroke).
    public let isReconciled: Bool
    /// True if usage was estimated (SSE usage missing) → keep dashed + "추정치".
    public let wasEstimated: Bool

    public init(
        reservedMicroUSD: Int64?,
        spentMicroUSD: Int64?,
        isReconciled: Bool = false,
        wasEstimated: Bool = false
    ) {
        self.reservedMicroUSD = reservedMicroUSD
        self.spentMicroUSD = spentMicroUSD
        self.isReconciled = isReconciled
        self.wasEstimated = wasEstimated
    }

    private var fraction: Double {
        guard let reserved = reservedMicroUSD, reserved > 0 else { return 0 }
        let spent = Double(spentMicroUSD ?? 0)
        return min(1.0, spent / Double(reserved))
    }

    public var body: some View {
        VStack(spacing: 4) {
            ZStack {
                // Track.
                Circle()
                    .stroke(Color.secondary.opacity(0.2), lineWidth: 4)
                // Fill — dashed while reserved/estimated, solid once reconciled.
                Circle()
                    .trim(from: 0, to: fraction)
                    .stroke(
                        MomoTheme.costAmber,
                        style: StrokeStyle(
                            lineWidth: 4,
                            lineCap: .round,
                            dash: (isReconciled && !wasEstimated) ? [] : [3, 3]
                        )
                    )
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 34, height: 34)

            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .accessibilityLabel(Text("cost \(label)"))
    }

    private var label: String {
        if isReconciled, let spent = spentMicroUSD {
            return CostFormat.usd(spent)
        }
        if let spent = spentMicroUSD, spent > 0 {
            return wasEstimated ? "추정 \(CostFormat.usd(spent))" : CostFormat.usd(spent)
        }
        if let reserved = reservedMicroUSD {
            return "예약 \(CostFormat.usd(reserved))"
        }
        return "—"
    }
}
