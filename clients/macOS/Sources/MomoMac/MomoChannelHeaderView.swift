import SwiftUI
import MomoCore

/// MOMO-372 supplies the destination. MOMO-371 owns only this navigation seam.
public typealias MomoMemberDirectoryHook = () -> Void

struct MomoChannelHeaderView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var systemContrast
    @Environment(\.momoColorSchemeContrastOverride) private var contrastOverride
    @Environment(\.momoCenterHeaderLeadingInset) private var centerHeaderLeadingInset
    let channel: Channel
    let presentation: MomoChannelPresentation
    let memberCount: Int
    let realtimeStatus: RealtimeConnectionStatus?
    let spentMicroUSD: Int64
    let showsCosts: Bool
    let copy: MomoWorkspaceCopy
    let retryRealtime: (() -> Void)?
    let openMemberDirectory: MomoMemberDirectoryHook?
    let sidebarToggle: (() -> Void)?
    @Binding var isChannelMenuPresented: Bool

    init(
        channel: Channel,
        presentation: MomoChannelPresentation,
        memberCount: Int,
        realtimeStatus: RealtimeConnectionStatus?,
        spentMicroUSD: Int64,
        showsCosts: Bool,
        copy: MomoWorkspaceCopy,
        retryRealtime: (() -> Void)?,
        openMemberDirectory: MomoMemberDirectoryHook?,
        sidebarToggle: (() -> Void)? = nil,
        isChannelMenuPresented: Binding<Bool> = .constant(false)
    ) {
        self.channel = channel
        self.presentation = presentation
        self.memberCount = memberCount
        self.realtimeStatus = realtimeStatus
        self.spentMicroUSD = spentMicroUSD
        self.showsCosts = showsCosts
        self.copy = copy
        self.retryRealtime = retryRealtime
        self.openMemberDirectory = openMemberDirectory
        self.sidebarToggle = sidebarToggle
        _isChannelMenuPresented = isChannelMenuPresented
    }

    var body: some View {
        HStack(alignment: .center, spacing: MomoTheme.ChannelHeader.contentSpacing) {
            if let sidebarToggle {
                sidebarToggleButton(action: sidebarToggle)
            }

            channelIdentity
                .frame(minWidth: 0)

            memberCountControl

            Spacer(minLength: MomoTheme.ChannelHeader.standardSpacing)

            HStack(spacing: MomoTheme.ChannelHeader.standardSpacing) {
                if let realtimeStatus, !realtimeStatus.isLive {
                    realtimeStatusChip(realtimeStatus)
                }

                if showsCosts, spentMicroUSD > 0 {
                    Label(CostFormat.usdCompact(spentMicroUSD), systemImage: "dollarsign.circle")
                        .momoTypography(.metadata)
                        .foregroundStyle(MomoTheme.costAmber)
                        .monospacedDigit()
                        .fixedSize()
                }

            }
            .fixedSize(horizontal: true, vertical: false)
            .layoutPriority(2)
        }
        .padding(.leading, MomoTheme.ChannelHeader.edgeInset + centerHeaderLeadingInset)
        .padding(
            .trailing,
            MomoTheme.ChannelHeader.edgeInset + MomoWindowChromeLayout.centerChromeControlsReservedWidth
        )
        .frame(minHeight: MomoWindowChromeLayout.integratedHeaderHeight)
        .background(MomoTheme.Surface.style(.panel, colorScheme: colorScheme).fill)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(MomoTheme.subtleBorder.opacity(effectiveContrast == .increased ? 1 : 0.65))
                .frame(height: effectiveContrast == .increased ? 2 : 1)
        }
    }

    private func sidebarToggleButton(action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(copy.toggleSidebar, systemImage: "sidebar.leading")
                .labelStyle(.iconOnly)
                .frame(
                    width: MomoTheme.ChannelHeader.actionSize,
                    height: MomoTheme.ChannelHeader.actionSize
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .momoQuickTooltip(copy.toggleSidebar)
        .accessibilityLabel(copy.toggleSidebar)
        .accessibilityIdentifier("sidebar-toggle")
    }

    private var effectiveContrast: ColorSchemeContrast {
        contrastOverride ?? systemContrast
    }

    private var channelIdentity: some View {
        Button {
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                isChannelMenuPresented.toggle()
            }
        } label: {
            HStack(alignment: .center, spacing: MomoTheme.ChannelHeader.standardSpacing) {
                Image(systemName: channel.kind == .dm ? "person.2.fill" : channel.kind == .privateChannel ? "lock.fill" : "number")
                    .momoTypography(.toolbarTitle)
                    .foregroundStyle(.secondary)
                    .frame(
                        width: MomoTheme.ChannelHeader.iconSize,
                        height: MomoTheme.ChannelHeader.iconSize
                    )

                Text(presentation.name)
                    .momoTypography(.screenTitle)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isChannelMenuPresented ? 180 : 0))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(presentation.topic ?? presentation.name)
        .accessibilityLabel("\(presentation.name), \(copy.channelMenu)")
        .accessibilityValue(copy.channelMenuState(isPresented: isChannelMenuPresented))
        .accessibilityHint(presentation.topic ?? copy.channelSettingsSubtitle)
        .accessibilityIdentifier("channel-header-menu")
    }

    @ViewBuilder
    private var memberCountControl: some View {
        let label = Label(copy.channelMemberCount(memberCount), systemImage: "person.2")
            .momoTypography(.supportingEmphasized)
            .monospacedDigit()

        if let openMemberDirectory {
            Button(action: openMemberDirectory) {
                label
            }
            .buttonStyle(.borderless)
            .momoQuickTooltip(copy.openMemberDirectory)
            .accessibilityLabel(copy.openMemberDirectory)
            .accessibilityValue(copy.channelMemberCount(memberCount))
        } else {
            label
                .foregroundStyle(.secondary)
                .accessibilityLabel(copy.channelMemberCount(memberCount))
        }
    }

    @ViewBuilder
    private func realtimeStatusChip(_ status: RealtimeConnectionStatus) -> some View {
        let label = Label(realtimeStatusTitle(status), systemImage: realtimeStatusIcon(status))
            .momoTypography(.metadataEmphasized)
            .foregroundStyle(realtimeStatusColor(status))
            .padding(.horizontal, MomoTheme.ChannelHeader.standardSpacing)
            .padding(.vertical, MomoTheme.ChannelHeader.compactSpacing)
            .background(realtimeStatusColor(status).opacity(0.08), in: Capsule())
            .fixedSize()

        if status.canRetry, let retryRealtime {
            Button(action: retryRealtime) {
                label
            }
            .buttonStyle(.plain)
            .help(copy.retry)
            .accessibilityLabel("\(realtimeStatusTitle(status)), \(copy.retry)")
        } else {
            label
        }
    }

    private func realtimeStatusTitle(_ status: RealtimeConnectionStatus) -> String {
        if status.isLive {
            return copy.live
        }
        switch (status.connection, status.subscription, status.fallback) {
        case (.disabled, .disabled, .restHistory):
            return copy.restFallback
        case (.connecting, _, _), (.connected, .subscribing, _):
            return copy.connectingLive
        case (.reconnecting, _, _), (_, .recovering, _):
            return copy.reconnecting
        case (.offline, _, .restHistory), (_, .unsubscribed, .restHistory):
            return copy.offlineRestFallback
        case (.error, _, .restHistory), (_, .error, .restHistory):
            return copy.liveErrorRestFallback
        default:
            return copy.connectingLive
        }
    }

    private func realtimeStatusIcon(_ status: RealtimeConnectionStatus) -> String {
        if status.isLive { return "dot.radiowaves.left.and.right" }
        switch status.connection {
        case .connecting, .reconnecting:
            return "arrow.triangle.2.circlepath"
        case .offline, .disabled:
            return "clock.arrow.circlepath"
        case .error:
            return "wifi.exclamationmark"
        case .connected:
            return status.subscription == .subscribed
                ? "dot.radiowaves.left.and.right"
                : "antenna.radiowaves.left.and.right"
        }
    }

    private func realtimeStatusColor(_ status: RealtimeConnectionStatus) -> Color {
        if status.isLive { return MomoTheme.reversibleGreen }
        switch status.connection {
        case .connecting, .reconnecting:
            return MomoTheme.agentAccent
        case .error:
            return MomoTheme.costAmber
        case .offline, .disabled:
            return .secondary
        case .connected:
            return status.subscription == .error ? MomoTheme.costAmber : MomoTheme.agentAccent
        }
    }
}
