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
    /// Foreground placed on an accent-filled control or avatar.
    public static let onAccent = Color(nsColor: .selectedMenuItemTextColor)
    /// Adaptive separator used for subtle borders on raised surfaces.
    public static let subtleBorder = Color(nsColor: .separatorColor)
    /// Modal scrim and floating-panel chrome.
    public static let modalScrim = Color.black.opacity(0.18)
    public static let floatingPanelShadow = Color.black.opacity(0.28)
    public static let subtlePanelBorder = Color.white.opacity(0.14)

    public static let bubbleCorner: CGFloat = 12
    public static let gutter: CGFloat = 12
    public static let messageAvatarSize: CGFloat = 28
    public static let mentionAutocompleteWidth: CGFloat = 300
    public static let credentialRevealMinimumWidth: CGFloat = 320
    public static let credentialRevealIdealWidth: CGFloat = 480
    public static let credentialRevealMaximumWidth: CGFloat = 640
    public static let memberInvitePopoverWidth: CGFloat = 340
    public static let memberInvitePopoverMaximumHeight: CGFloat = 640

    /// Component tokens for the primary macOS sidebar. Values live here so
    /// channel, DM, member, and utility rows share one density contract.
    public enum Sidebar {
        public static let minimumWidth: CGFloat = 240
        public static let idealWidth: CGFloat = 280
        public static let maximumWidth: CGFloat = 360
        public static let headerMinimumHeight: CGFloat = 52
        public static let rowMinimumHeight: CGFloat = 32
        public static let footerMinimumHeight: CGFloat = 44
        public static let avatarSize: CGFloat = 24
        public static let logoSize: CGFloat = 28
        public static let actionSize: CGFloat = 24
        public static let utilityPopoverWidth: CGFloat = 360
        public static let utilityPopoverMaximumHeight: CGFloat = 560

        public static let edgeInset: CGFloat = 8
        public static let rowHorizontalPadding: CGFloat = 8
        public static let rowVerticalPadding: CGFloat = 4
        public static let sectionSpacing: CGFloat = 16
        public static let itemSpacing: CGFloat = 4
        public static let compactSpacing: CGFloat = 4
        public static let standardSpacing: CGFloat = 8
        public static let contentSpacing: CGFloat = 12

        public static let rowCornerRadius: CGFloat = 6

        public static let workspaceFont = Font.body.weight(.semibold)
        public static let workspaceDetailFont = Font.caption
        public static let sectionHeaderFont = Font.subheadline.weight(.semibold)
        public static let rowFont = Font.body
        public static let selectedRowFont = Font.body.weight(.semibold)
        public static let rowDetailFont = Font.caption
        public static let badgeFont = Font.caption2.weight(.semibold)

        public static let selectionBackground = MomoTheme.humanAccent.opacity(0.18)
        public static let hoverBackground = Color.primary.opacity(0.06)
        public static let utilityBackground = Color.primary.opacity(0.045)
        public static let mentionBadgeBackground = MomoTheme.irreversibleRed
        public static let mentionBadgeForeground = MomoTheme.onAccent
    }

    public enum QuickSwitcher {
        public static let panelWidth: CGFloat = 560
        public static let resultsMinimumHeight: CGFloat = 280
        public static let resultsMaximumHeight: CGFloat = 360
        public static let sectionHeaderHeight: CGFloat = 24
        public static let shortcutsWidth: CGFloat = 480
        public static let shortcutsHeight: CGFloat = 440
        public static let rowMinimumHeight: CGFloat = 44
        public static let iconSize: CGFloat = 24
        public static let panelCornerRadius: CGFloat = 14
        public static let rowCornerRadius: CGFloat = 6

        public static let edgeInset: CGFloat = 16
        public static let sectionSpacing: CGFloat = 16
        public static let standardSpacing: CGFloat = 8
        public static let compactSpacing: CGFloat = 4
        public static let selectionBackground = MomoTheme.humanAccent.opacity(0.18)
        public static let hoverBackground = Color.primary.opacity(0.06)
    }

    /// Shared visual grammar for AGENT identity and capability metadata.
    public enum AgentBadge {
        public static let spacing: CGFloat = 4
        public static let horizontalPadding: CGFloat = 4
        public static let maximumCapabilityWidth: CGFloat = 80
        public static let font = Font.caption2.weight(.semibold)
        public static let identityBackground = MomoTheme.agentAccent.opacity(0.18)
        public static let capabilityBackground = MomoTheme.agentAccent.opacity(0.12)
    }

    public enum Work {
        public static let composerWidth: CGFloat = 420
        public static let briefMinimumHeight: CGFloat = 120
        public static let cardMaximumWidth: CGFloat = 720
        public static let transcriptMinimumHeight: CGFloat = 240
        public static let statusIconSize: CGFloat = 24

        public static let compactSpacing: CGFloat = 4
        public static let standardSpacing: CGFloat = 8
        public static let contentSpacing: CGFloat = 12
        public static let sectionSpacing: CGFloat = 16
    }
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
