import SwiftUI
import MomoCore

// MARK: - MomoUpdatePill (MOMO-593)
//
// A T3-Code-style sidebar footer pill that announces an available
// operator-assisted update. It reuses the MOMO-244 manifest pipeline
// (`MomoMacUpdateChannelStatus`) for the version data and the existing Updates
// surface for the destination. The pill checks at launch and every six hours,
// stays completely silent on any failure/offline/not-configured state, and can
// be dismissed for the current session.

/// Pure presentation decision for the sidebar update pill. Deliberately free of
/// SwiftUI and timers so the version-compare and session-dismiss rules are unit
/// tested in isolation.
struct MomoUpdatePillDecision: Equatable, Sendable {
    let status: MomoMacUpdateChannelStatus
    /// The available version the operator dismissed for this session, if any.
    let dismissedVersion: MomoMacAppVersion?

    /// Only a genuine `.updateAvailable` state ever surfaces the pill. Every
    /// failed/offline/not-configured/up-to-date state stays silent, which is how
    /// "check failure is completely quiet" is enforced.
    var isVisible: Bool {
        guard status.hasUpdate, let available = status.availableVersion else {
            return false
        }
        guard let dismissedVersion else { return true }
        // A dismiss only silences the version that was showing. A strictly newer
        // build re-earns the pill; the same build stays hidden for the session.
        return MomoMacUpdateChannelStatus.isUpdateAvailable(
            current: dismissedVersion,
            available: available
        )
    }

    /// The version to display, present only while the pill is visible.
    var availableVersion: MomoMacAppVersion? {
        isVisible ? status.availableVersion : nil
    }
}

/// Owns the update status and the session-scoped dismiss for the pill. The
/// startup check plus the six-hour recurring loop live here; the manifest read
/// runs off the main actor and a failed read simply yields a silent status.
@MainActor
final class MomoUpdatePillModel: ObservableObject {
    /// Recurring manifest check cadence. The startup check runs immediately.
    static let checkInterval: TimeInterval = 6 * 60 * 60

    @Published private(set) var status: MomoMacUpdateChannelStatus
    @Published private(set) var dismissedVersion: MomoMacAppVersion?

    private let interval: TimeInterval
    private let check: @Sendable () -> MomoMacUpdateChannelStatus

    init(
        interval: TimeInterval = MomoUpdatePillModel.checkInterval,
        check: @escaping @Sendable () -> MomoMacUpdateChannelStatus = {
            MomoMacUpdateChannelStatus.fromEnvironment()
        }
    ) {
        self.interval = interval
        self.check = check
        // Start silent until the first check lands. A failed check keeps it so.
        self.status = MomoMacUpdateChannelStatus(state: .notConfigured)
    }

    var decision: MomoUpdatePillDecision {
        MomoUpdatePillDecision(status: status, dismissedVersion: dismissedVersion)
    }

    /// Runs the startup check and then the recurring loop until the view task is
    /// cancelled.
    func run() async {
        await refresh()
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(interval))
            if Task.isCancelled { break }
            await refresh()
        }
    }

    /// Reads the manifest off the main actor. Any read error is already folded
    /// into a `.failed` status by `fromEnvironment`, so the pill stays quiet.
    func refresh() async {
        let check = self.check
        let next = await Task.detached(priority: .utility) { check() }.value
        status = next
    }

    /// Session-scoped dismiss: remembers the version currently offered so the
    /// pill stays hidden until a newer build appears. Not persisted, so a
    /// relaunch clears it.
    func dismiss() {
        dismissedVersion = status.availableVersion
    }
}

/// Sidebar footer pill for an available update.
///
/// Custom-control justification: this is a compound row (a labeled navigation
/// action plus an inline session-dismiss) pinned to the sidebar footer, which no
/// single system control expresses. Both affordances are standard `Button`s.
struct MomoUpdatePillView: View {
    let language: MomoUILanguage
    let openUpdates: (() -> Void)?

    @StateObject private var model: MomoUpdatePillModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        language: MomoUILanguage,
        openUpdates: (() -> Void)?,
        model: @autoclosure @escaping () -> MomoUpdatePillModel = MomoUpdatePillModel()
    ) {
        self.language = language
        self.openUpdates = openUpdates
        _model = StateObject(wrappedValue: model())
    }

    var body: some View {
        let decision = model.decision
        Group {
            if decision.isVisible, let version = decision.availableVersion {
                pill(version: version)
            }
        }
        .animation(reduceMotion ? nil : MomoTheme.Motion.stateChange, value: decision.isVisible)
        .task { await model.run() }
    }

    private func pill(version: MomoMacAppVersion) -> some View {
        let copy = MomoWorkspaceCopy(language: language)
        return HStack(spacing: MomoTheme.Sidebar.compactSpacing) {
            Button {
                openUpdates?()
            } label: {
                HStack(spacing: MomoTheme.Sidebar.standardSpacing) {
                    Image(systemName: MomoMacUpdateState.updateAvailable.systemImage)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(MomoTheme.costAmber)
                    Text(copy.updatePillLabel(version))
                        .font(MomoTheme.Sidebar.rowDetailFont)
                        .monospacedDigit()
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(copy.updatePillHelp)
            .accessibilityLabel(copy.updatePillLabel(version))
            .accessibilityHint(copy.updatePillHelp)

            Button {
                model.dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
                    .frame(width: MomoTheme.Sidebar.actionSize, height: MomoTheme.Sidebar.actionSize)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(copy.dismissUpdatePill)
            .accessibilityLabel(copy.dismissUpdatePill)
        }
        .padding(.leading, MomoTheme.Sidebar.standardSpacing)
        .padding(.trailing, MomoTheme.Sidebar.compactSpacing)
        .frame(minHeight: MomoTheme.Sidebar.rowMinimumHeight)
        .background(
            MomoTheme.costAmber.opacity(0.12),
            in: RoundedRectangle(cornerRadius: MomoTheme.Sidebar.rowCornerRadius, style: .continuous)
        )
        .padding(.horizontal, MomoTheme.Sidebar.edgeInset)
        .padding(.top, MomoTheme.Sidebar.itemSpacing)
    }
}
