import SwiftUI
import MomoCore

// MARK: - Design tokens
//
// Minimal token surface for the v0 macOS demo. Centralizes the colors used by the
// agent-native experiences (L4 experiences §B cost breathing, §C approval inbox)
// so the placeholders read consistently. Kept tiny on purpose — full design system
// lands with the .app follow-up ticket.

public enum MomoTheme {
    /// Agent accent (used for agent bubbles, partial streaming, presence ring).
    public static let agentAccent = Color(red: 0.45, green: 0.36, blue: 0.92)
    /// Human accent.
    public static let humanAccent = Color(red: 0.18, green: 0.55, blue: 0.95)
    /// Cost "breathing" amber (reserve → reconcile, experience B).
    public static let costAmber = Color(red: 0.96, green: 0.62, blue: 0.12)
    /// Reversible / safe (experience C green badge).
    public static let reversibleGreen = Color(red: 0.22, green: 0.72, blue: 0.42)
    /// Irreversible / danger (experience C red badge).
    public static let irreversibleRed = Color(red: 0.90, green: 0.27, blue: 0.30)

    public static let bubbleCorner: CGFloat = 12
    public static let gutter: CGFloat = 12
}

// MARK: - micro_usd formatting (display only; never accounting math — L4 §8.5)

public enum CostFormat {
    /// micro_usd → "$0.28" style. Integer micro_usd in, USD string out (display only).
    public static func usd(_ microUSD: Int64) -> String {
        let usd = Double(microUSD) / 1_000_000.0
        return String(format: "$%.4f", usd)
    }

    /// Compact "$0.28" with 2 decimals for headers/chips.
    public static func usdCompact(_ microUSD: Int64) -> String {
        let usd = Double(microUSD) / 1_000_000.0
        return String(format: "$%.2f", usd)
    }
}

// MARK: - Presence dot color

extension Presence {
    var dotColor: Color {
        switch self {
        case .online: return MomoTheme.reversibleGreen
        case .away: return MomoTheme.costAmber
        case .offline: return .secondary
        case .working: return MomoTheme.agentAccent
        }
    }
}
