import SwiftUI
import MomoCore

/// MOMO-372 supplies the destination. MOMO-371 owns only this navigation seam.
public typealias MomoMemberDirectoryHook = () -> Void

struct MomoChannelHeaderView: View {
    let channel: Channel
    let presentation: MomoChannelPresentation
    let memberCount: Int
    let realtimeStatus: RealtimeConnectionStatus?
    let spentMicroUSD: Int64
    let showsCosts: Bool
    let copy: MomoWorkspaceCopy
    let retryRealtime: (() -> Void)?
    let openMemberDirectory: MomoMemberDirectoryHook?
    let openDownloads: (() -> Void)?

    var body: some View {
        HStack(alignment: .center, spacing: MomoTheme.ChannelHeader.contentSpacing) {
            channelIdentity
                .layoutPriority(1)

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

                memberCountControl

                if let openDownloads {
                    Button(action: openDownloads) {
                        Image(systemName: "tray.and.arrow.down")
                            .frame(
                                width: MomoTheme.ChannelHeader.iconSize,
                                height: MomoTheme.ChannelHeader.iconSize
                            )
                    }
                    .buttonStyle(.borderless)
                    .help(copy.appDownloads)
                    .momoQuickTooltip(copy.appDownloads)
                    .accessibilityLabel(copy.appDownloads)
                    .accessibilityHint(copy.downloadsScopeNote)
                    .accessibilityIdentifier("app-downloads-entry")
                }
            }
            .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.horizontal, MomoTheme.ChannelHeader.edgeInset)
        .frame(minHeight: MomoTheme.ChannelHeader.minimumHeight)
        .momoSurface(.panel, cornerRadius: 0)
    }

    private var channelIdentity: some View {
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
        }
        .help(presentation.topic ?? presentation.name)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(presentation.name)
        .accessibilityHint(presentation.topic ?? "")
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
            .help(copy.openMemberDirectory)
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
