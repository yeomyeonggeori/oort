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
    public static let mentionAutocompleteWidth: CGFloat = 360
    public static let composerMinimumHeight: CGFloat = 56
    public static let mentionAutocompleteRowHeight: CGFloat = 52
    public static let mentionAutocompleteMaximumRows = 6
    public static let credentialRevealMinimumWidth: CGFloat = 320
    public static let credentialRevealIdealWidth: CGFloat = 480
    public static let credentialRevealMaximumWidth: CGFloat = 640
    public static let memberInvitePopoverWidth: CGFloat = 340
    public static let memberInvitePopoverMaximumHeight: CGFloat = 640

    public enum ComposerAction {
        public static let launcherWidth: CGFloat = 340
        public static let rowMinimumHeight: CGFloat = 56
        public static let iconSize: CGFloat = 28
        public static let attachmentWidth: CGFloat = 240
        public static let sheetMinimumWidth: CGFloat = 520
        public static let sheetMinimumHeight: CGFloat = 420
        public static let compactSpacing: CGFloat = 4
        public static let standardSpacing: CGFloat = 8
        public static let contentSpacing: CGFloat = 12
        public static let sectionSpacing: CGFloat = 16
        public static let sheetInset: CGFloat = 24
        public static let dropInset: CGFloat = 32
    }

    /// First-run and server-session entry. A single width contract keeps the
    /// hero and authentication surface centered from compact to wide windows.
    public enum Onboarding {
        public static let minimumWindowWidth: CGFloat = 680
        public static let connectedMinimumWindowWidth: CGFloat = 980
        public static let minimumWindowHeight: CGFloat = 620
        public static let choiceMaximumWidth: CGFloat = 520
        public static let detailMaximumWidth: CGFloat = 560
        public static let heroMaximumWidth: CGFloat = 520
        public static let splitContentMaximumWidth: CGFloat = 1_104
        public static let wideBreakpoint: CGFloat = 1_120
        public static let compactBreakpoint: CGFloat = 760
        public static let fieldMinimumHeight: CGFloat = 48
        public static let markSize: CGFloat = 40

        public static let compactSpacing: CGFloat = 4
        public static let standardSpacing: CGFloat = 8
        public static let contentSpacing: CGFloat = 12
        public static let sectionSpacing: CGFloat = 16
        public static let blockSpacing: CGFloat = 24
        public static let edgeInset: CGFloat = 32

        public static let fieldBackground = Color(nsColor: .controlBackgroundColor)
        public static let fieldBorder = MomoTheme.subtleBorder
        public static let focusBorder = MomoTheme.humanAccent

        public static func signalBackground(colorScheme: ColorScheme) -> Color {
            colorScheme == .dark
                ? Color(red: 0.025, green: 0.032, blue: 0.038)
                : Color(red: 0.925, green: 0.945, blue: 0.950)
        }

        public static func signalGrid(colorScheme: ColorScheme) -> Color {
            colorScheme == .dark
                ? Color.white.opacity(0.08)
                : Color.black.opacity(0.09)
        }

        public static func signalRail(colorScheme: ColorScheme) -> Color {
            colorScheme == .dark
                ? Color.white.opacity(0.42)
                : Color.black.opacity(0.32)
        }

        public static func signalPlane(colorScheme: ColorScheme) -> Color {
            colorScheme == .dark
                ? Color(red: 0.98, green: 0.32, blue: 0.25)
                : Color(red: 0.88, green: 0.23, blue: 0.18)
        }

        public static func signalForeground(colorScheme: ColorScheme) -> Color {
            colorScheme == .dark ? Color.white.opacity(0.94) : Color.black.opacity(0.88)
        }

        public static func signalSecondaryForeground(colorScheme: ColorScheme) -> Color {
            colorScheme == .dark ? Color.white.opacity(0.88) : Color.black.opacity(0.76)
        }

        public static func choiceHover(colorScheme: ColorScheme) -> Color {
            colorScheme == .dark ? Color.white.opacity(0.07) : Color.black.opacity(0.05)
        }
    }

    /// Three calm elevation levels shared by the shell. Primitive scheme colors
    /// stay inside Theme; views consume the complete fill/border/shadow set.
    public enum Surface {
        public enum Level: Sendable {
            case background
            case panel
            case card
        }

        /// Bounded surfaces clip to their shape. Window chrome surfaces extend
        /// only their fill through the safe area so titlebars never reveal the
        /// system background between shell columns.
        public enum Extent: Sendable {
            case bounded
            case windowChrome
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
        public enum Role: Sendable {
            case screenTitle
            case sectionHeader
            case row
            case emphasizedRow
            case supporting
            case supportingEmphasized
            case metadata
            case metadataEmphasized
            case toolbarTitle
            case toolbarSupporting
            case messageBody
        }

        public static let screenTitle = Font.title2.weight(.semibold)
        public static let sectionHeader = Font.headline
        public static let row = Font.title3
        public static let emphasizedRow = Font.title3.weight(.semibold)
        public static let supporting = Font.subheadline
        public static let metadata = Font.caption
        public static let toolbarTitle = Font.headline
        public static let toolbarSupporting = Font.subheadline
        public static let messageBody = Font.title3

        static func font(for role: Role, dynamicTypeSize: DynamicTypeSize) -> Font {
            let usesExpandedRole = dynamicTypeSize > .large
            switch (role, usesExpandedRole) {
            case (.screenTitle, false): return screenTitle
            case (.screenTitle, true): return .title.weight(.semibold)
            case (.sectionHeader, false): return sectionHeader
            case (.sectionHeader, true): return .title3.weight(.semibold)
            case (.row, false): return row
            case (.row, true): return .title2
            case (.emphasizedRow, false): return emphasizedRow
            case (.emphasizedRow, true): return .title2.weight(.semibold)
            case (.supporting, false): return supporting
            case (.supporting, true): return .body
            case (.supportingEmphasized, false): return supporting.weight(.medium)
            case (.supportingEmphasized, true): return .body.weight(.medium)
            case (.metadata, false): return metadata
            case (.metadata, true): return .callout
            case (.metadataEmphasized, false): return metadata.weight(.semibold)
            case (.metadataEmphasized, true): return .callout.weight(.semibold)
            case (.toolbarTitle, false): return toolbarTitle
            case (.toolbarTitle, true): return .title2.weight(.semibold)
            case (.toolbarSupporting, false): return toolbarSupporting
            case (.toolbarSupporting, true): return .body
            case (.messageBody, false): return messageBody
            case (.messageBody, true): return .title2
            }
        }
    }

    public enum Motion {
        public static let hoverDuration = 0.12
        public static let stateChangeDuration = 0.16
        public static let hover = Animation.easeOut(duration: hoverDuration)
        public static let stateChange = Animation.easeOut(duration: stateChangeDuration)
    }

    public enum QuickTooltip {
        public static let maximumWidth: CGFloat = 280
        public static let anchorGap: CGFloat = 8
        public static let screenEdgeInset: CGFloat = 8
        public static let horizontalPadding: CGFloat = 8
        public static let verticalPadding: CGFloat = 4
    }

    public enum ChannelCreation {
        public static let minimumWidth: CGFloat = 480
        public static let idealWidth: CGFloat = 520
        public static let minimumHeight: CGFloat = 420
        public static let compactSpacing: CGFloat = 4
        public static let standardSpacing: CGFloat = 8
        public static let sectionSpacing: CGFloat = 24
        public static let edgeInset: CGFloat = 24
        public static let background = Color(nsColor: .windowBackgroundColor)
    }

    /// Component tokens for the primary macOS sidebar. Values live here so
    /// channel, DM, member, and utility rows share one density contract.
    public enum Sidebar {
        public static let minimumWidth: CGFloat = 240
        public static let idealWidth: CGFloat = 280
        public static let maximumWidth: CGFloat = 360
        public static let headerMinimumHeight: CGFloat = 44
        public static let rowMinimumHeight: CGFloat = 32
        public static let footerMinimumHeight: CGFloat = 44
        public static let avatarSize: CGFloat = 24
        public static let logoSize: CGFloat = 28
        public static let toolbarLogoSize: CGFloat = 24
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

    /// Channel identity and actions share one responsive header contract.
    public enum ChannelHeader {
        public static let iconSize: CGFloat = 24
        public static let actionSize: CGFloat = 28
        public static let minimumHeight: CGFloat = 48
        public static let searchUnavailableWidth: CGFloat = 320
        public static let settingsSheetWidth: CGFloat = 640
        public static let settingsSheetHeight: CGFloat = 520

        public static let compactSpacing: CGFloat = 4
        public static let standardSpacing: CGFloat = 8
        public static let contentSpacing: CGFloat = 12
        public static let edgeInset: CGFloat = 16
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

    /// Native split-view dimensions and rhythm for the workspace member directory.
    public enum MemberDirectory {
        public static let minimumWidth: CGFloat = 640
        public static let idealWidth: CGFloat = 760
        public static let minimumHeight: CGFloat = 480
        public static let listMinimumWidth: CGFloat = 240
        public static let listIdealWidth: CGFloat = 280
        public static let listMaximumWidth: CGFloat = 360
        public static let profileIconSize: CGFloat = 48
        public static let captureToolbarMinimumHeight: CGFloat = 44

        public static let compactSpacing: CGFloat = 4
        public static let standardSpacing: CGFloat = 8
        public static let contentSpacing: CGFloat = 12
        public static let sectionSpacing: CGFloat = 16
        public static let edgeInset: CGFloat = 24
    }

    /// Compact right-side roster and profile popover for the active conversation.
    public enum MemberInspector {
        public static let attachedWidth: CGFloat = 264
        public static let overlayWidth: CGFloat = 320
        public static let attachedMinimumDetailWidth: CGFloat = 760
        public static let profileWidth: CGFloat = 320
        public static let profileHeight: CGFloat = 320
        public static let profileIconSize: CGFloat = 48
        public static let avatarSize: CGFloat = 32
        public static let presenceSize: CGFloat = 8
        public static let rowMinimumHeight: CGFloat = 44

        public static let compactSpacing: CGFloat = 4
        public static let standardSpacing: CGFloat = 8
        public static let contentSpacing: CGFloat = 12
        public static let sectionSpacing: CGFloat = 16
        public static let edgeInset: CGFloat = 16
        public static let rowCornerRadius = MomoTheme.cornerSmall
        public static let hoverBackground = Color.primary.opacity(0.06)
    }

    public enum Downloads {
        public static let popoverWidth: CGFloat = 380
        public static let popoverMaximumHeight: CGFloat = 520
        public static let rowMinimumHeight: CGFloat = 48
        public static let emptyStateMinimumHeight: CGFloat = 150
        public static let historyMaximumHeight: CGFloat = 280
        public static let rowCornerRadius = MomoTheme.cornerSmall

        public static let compactSpacing: CGFloat = 4
        public static let standardSpacing: CGFloat = 8
        public static let contentSpacing: CGFloat = 12
        public static let sectionSpacing: CGFloat = 16
        public static let edgeInset: CGFloat = 16
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
        cornerRadius: CGFloat = MomoTheme.cornerMedium,
        extent: MomoTheme.Surface.Extent = .bounded
    ) -> some View {
        modifier(MomoSurfaceModifier(level: level, cornerRadius: cornerRadius, extent: extent))
    }

    /// Applies a semantic role and explicitly honors macOS per-app text sizing.
    func momoTypography(_ role: MomoTheme.Typography.Role) -> some View {
        modifier(MomoTypographyModifier(role: role))
    }
}

private struct MomoTypographyModifier: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let role: MomoTheme.Typography.Role

    func body(content: Content) -> some View {
        content.font(MomoTheme.Typography.font(for: role, dynamicTypeSize: dynamicTypeSize))
    }
}

private struct MomoColorSchemeContrastOverrideKey: EnvironmentKey {
    static let defaultValue: ColorSchemeContrast? = nil
}

extension EnvironmentValues {
    /// Headless snapshot hosts do not propagate accessibility appearances into
    /// SwiftUI. Production leaves this nil and follows the system environment.
    var momoColorSchemeContrastOverride: ColorSchemeContrast? {
        get { self[MomoColorSchemeContrastOverrideKey.self] }
        set { self[MomoColorSchemeContrastOverrideKey.self] = newValue }
    }
}

private struct MomoSurfaceModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var systemContrast
    @Environment(\.momoColorSchemeContrastOverride) private var contrastOverride
    let level: MomoTheme.Surface.Level
    let cornerRadius: CGFloat
    let extent: MomoTheme.Surface.Extent

    @ViewBuilder
    func body(content: Content) -> some View {
        let style = MomoTheme.Surface.style(level, colorScheme: colorScheme)
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        switch extent {
        case .bounded:
            surfaceChrome(
                content.background(style.fill, in: shape),
                style: style,
                shape: shape
            )
        case .windowChrome:
            surfaceChrome(
                content.background(style.fill.ignoresSafeArea()),
                style: style,
                shape: shape
            )
        }
    }

    private func surfaceChrome<SurfaceContent: View>(
        _ content: SurfaceContent,
        style: MomoTheme.Surface.Style,
        shape: RoundedRectangle
    ) -> some View {
        content
            .overlay {
                shape.stroke(
                    style.border,
                    lineWidth: effectiveContrast == .increased
                        ? MomoTheme.Surface.borderWidth * 2
                        : MomoTheme.Surface.borderWidth
                )
                    .allowsHitTesting(false)
            }
            .shadow(
                color: style.shadow,
                radius: style.shadowRadius,
                x: 0,
                y: style.shadowY
            )
    }

    private var effectiveContrast: ColorSchemeContrast {
        contrastOverride ?? systemContrast
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
