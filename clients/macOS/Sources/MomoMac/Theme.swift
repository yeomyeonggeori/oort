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
    /// Adaptive separator used outside the elevation system.
    public static let subtleBorder = Color(nsColor: .separatorColor)
    /// Modal scrim. Raised-surface shadows and borders come from `Surface`.
    public static let modalScrim = Color.black.opacity(0.18)

    public static let cornerSmall: CGFloat = 6
    public static let cornerMedium: CGFloat = 10
    public static let cornerLarge: CGFloat = 14
    public static let bubbleCorner = cornerMedium
    public static let gutter: CGFloat = 12
    public static let messageAvatarSize: CGFloat = 28
    public static let mentionAutocompleteWidth: CGFloat = 300
    public static let credentialRevealMinimumWidth: CGFloat = 320
    public static let credentialRevealIdealWidth: CGFloat = 480
    public static let credentialRevealMaximumWidth: CGFloat = 640
    public static let memberInvitePopoverWidth: CGFloat = 340
    public static let memberInvitePopoverMaximumHeight: CGFloat = 640

    /// First-run and server-session entry. A single width contract keeps the
    /// hero and authentication surface centered from compact to wide windows.
    public enum Onboarding {
        public static let contentMaximumWidth: CGFloat = 560
        public static let fieldMinimumHeight: CGFloat = 48
        public static let markSize: CGFloat = 40

        public static let compactSpacing: CGFloat = 4
        public static let standardSpacing: CGFloat = 8
        public static let contentSpacing: CGFloat = 12
        public static let sectionSpacing: CGFloat = 16
        public static let blockSpacing: CGFloat = 24
        public static let edgeInset: CGFloat = 32

        public static let backdropTop = Color(nsColor: .windowBackgroundColor)
        public static let backdropMiddle = Color(nsColor: .windowBackgroundColor)
        public static let backdropBottom = MomoTheme.humanAccent.opacity(0.05)
        public static let fieldBackground = Color(nsColor: .controlBackgroundColor)
        public static let fieldBorder = MomoTheme.subtleBorder
        public static let focusBorder = MomoTheme.humanAccent
    }

    /// Three calm elevation levels shared by the shell. Primitive scheme colors
    /// stay inside Theme; views consume the complete fill/border/shadow set.
    public enum Surface {
        public enum Level: Sendable {
            case background
            case panel
            case card
        }

        public struct Style {
            public let fill: Color
            public let border: Color
            public let shadow: Color
            public let shadowRadius: CGFloat
            public let shadowY: CGFloat
        }

        public static let borderWidth: CGFloat = 1

        public static func style(_ level: Level, colorScheme: ColorScheme) -> Style {
            switch (level, colorScheme) {
            case (.background, .dark):
                return Style(
                    fill: Color(red: 0.065, green: 0.067, blue: 0.075),
                    border: .clear,
                    shadow: .clear,
                    shadowRadius: 0,
                    shadowY: 0
                )
            case (.background, _):
                return Style(
                    fill: Color(red: 0.935, green: 0.938, blue: 0.945),
                    border: .clear,
                    shadow: .clear,
                    shadowRadius: 0,
                    shadowY: 0
                )
            case (.panel, .dark):
                return Style(
                    fill: Color(red: 0.085, green: 0.088, blue: 0.098),
                    border: Color.white.opacity(0.07),
                    shadow: Color.black.opacity(0.12),
                    shadowRadius: 4,
                    shadowY: 1
                )
            case (.panel, _):
                return Style(
                    fill: Color(red: 0.965, green: 0.968, blue: 0.974),
                    border: Color.black.opacity(0.07),
                    shadow: Color.black.opacity(0.05),
                    shadowRadius: 4,
                    shadowY: 1
                )
            case (.card, .dark):
                return Style(
                    fill: Color(red: 0.115, green: 0.118, blue: 0.132),
                    border: Color.white.opacity(0.11),
                    shadow: Color.black.opacity(0.22),
                    shadowRadius: 8,
                    shadowY: 2
                )
            case (.card, _):
                return Style(
                    fill: Color(red: 0.992, green: 0.993, blue: 0.996),
                    border: Color.black.opacity(0.10),
                    shadow: Color.black.opacity(0.08),
                    shadowRadius: 8,
                    shadowY: 2
                )
            }
        }
    }

    /// Semantic text rhythm: title -> section -> row -> supporting metadata.
    public enum Typography {
        public static let screenTitle = Font.title3.weight(.semibold)
        public static let sectionHeader = Font.subheadline.weight(.semibold)
        public static let row = Font.body
        public static let emphasizedRow = Font.body.weight(.semibold)
        public static let supporting = Font.caption
        public static let metadata = Font.caption2
    }

    public enum Motion {
        public static let hoverDuration = 0.12
        public static let stateChangeDuration = 0.16
        public static let hover = Animation.easeOut(duration: hoverDuration)
        public static let stateChange = Animation.easeOut(duration: stateChangeDuration)
    }

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

        public static let rowCornerRadius = MomoTheme.cornerSmall

        public static let workspaceFont = MomoTheme.Typography.emphasizedRow
        public static let workspaceDetailFont = MomoTheme.Typography.supporting
        public static let sectionHeaderFont = MomoTheme.Typography.sectionHeader
        public static let rowFont = MomoTheme.Typography.row
        public static let selectedRowFont = MomoTheme.Typography.emphasizedRow
        public static let rowDetailFont = MomoTheme.Typography.supporting
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
        public static let panelCornerRadius = MomoTheme.cornerLarge
        public static let rowCornerRadius = MomoTheme.cornerSmall

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

public extension View {
    /// Applies a complete elevation token set. The custom modifier is needed
    /// because SwiftUI has no native semantic background/panel/card level API.
    func momoSurface(
        _ level: MomoTheme.Surface.Level,
        cornerRadius: CGFloat = MomoTheme.cornerMedium
    ) -> some View {
        modifier(MomoSurfaceModifier(level: level, cornerRadius: cornerRadius))
    }
}

private struct MomoSurfaceModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let level: MomoTheme.Surface.Level
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        let style = MomoTheme.Surface.style(level, colorScheme: colorScheme)
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background(style.fill, in: shape)
            .overlay {
                shape.stroke(style.border, lineWidth: MomoTheme.Surface.borderWidth)
            }
            .shadow(
                color: style.shadow,
                radius: style.shadowRadius,
                x: 0,
                y: style.shadowY
            )
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
