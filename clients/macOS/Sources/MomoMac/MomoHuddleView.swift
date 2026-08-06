import SwiftUI
import MomoCore

private enum MomoHuddleLayout {
    static let panelWidth: CGFloat = 320
    static let participantListMaximumHeight: CGFloat = 240
}

struct MomoHuddleComposerControlPresentation: Equatable {
    enum Tone: Equatable {
        case secondary
        case accent
        case success
        case warning
    }

    let systemImage: String
    let tone: Tone

    static func resolve(
        state: MomoHuddleState,
        hasActiveHuddle: Bool,
        isChannelSelected: Bool
    ) -> MomoHuddleComposerControlPresentation {
        guard isChannelSelected else {
            return .init(systemImage: "waveform.slash", tone: .secondary)
        }

        switch state {
        case .unavailable:
            return .init(systemImage: "waveform.slash", tone: .secondary)
        case .connecting:
            return .init(systemImage: "waveform", tone: .secondary)
        case .idle:
            return hasActiveHuddle
                ? .init(systemImage: "person.wave.2", tone: .accent)
                : .init(systemImage: "waveform", tone: .accent)
        case .joined:
            return .init(systemImage: "waveform.circle.fill", tone: .success)
        case .failed:
            return .init(systemImage: "arrow.clockwise", tone: .warning)
        }
    }
}

enum MomoHuddleComposerControlAction: Equatable {
    case explain(String)
    case startOrJoin
    case openPanel
    case retry

    static func resolve(
        state: MomoHuddleState,
        isChannelSelected: Bool,
        noChannelReason: String,
        connectingReason: String
    ) -> MomoHuddleComposerControlAction {
        switch state {
        case .unavailable(let reason):
            return .explain(reason)
        case .connecting:
            return .explain(connectingReason)
        case .idle where isChannelSelected:
            return .startOrJoin
        case .joined where isChannelSelected:
            return .openPanel
        case .failed where isChannelSelected:
            return .retry
        case .idle, .joined, .failed:
            return .explain(noChannelReason)
        }
    }
}

private enum MomoHuddleComposerPopover: Hashable, Identifiable {
    case panel
    case explanation

    var id: Self { self }
}

struct MomoHuddleComposerControl: View {
    @ObservedObject var viewModel: MomoHuddleViewModel
    let copy: MomoHuddleCopy
    let isChannelSelected: Bool
    @State private var presentedPopover: MomoHuddleComposerPopover?

    var body: some View {
        Button {
            switch controlAction {
            case .explain:
                presentedPopover = presentedPopover == .explanation ? nil : .explanation
            case .startOrJoin:
                viewModel.beginStartOrJoin()
            case .openPanel:
                presentedPopover = presentedPopover == .panel ? nil : .panel
            case .retry:
                Task { await viewModel.retry() }
            }
        } label: {
            Group {
                if viewModel.state == .connecting {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: presentation.systemImage)
                }
            }
            .frame(width: 32, height: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(controlColor)
        .momoQuickTooltip(helpText)
        .accessibilityLabel(buttonTitle)
        .accessibilityHint(helpText)
        .keyboardShortcut("h", modifiers: [.command, .shift])
        .popover(item: $presentedPopover, arrowEdge: .bottom) { popover in
            switch popover {
            case .panel:
                MomoHuddlePanelView(viewModel: viewModel, copy: copy)
            case .explanation:
                MomoHuddleExplanationView(
                    title: explanationTitle,
                    reason: explanationReason
                )
            }
        }
        .onChange(of: viewModel.isJoined) { _, isJoined in
            if !isJoined, presentedPopover == .panel {
                presentedPopover = nil
            }
        }
        .onChange(of: controlAction) { _, action in
            guard presentedPopover == .explanation else { return }
            if case .explain = action { return }
            presentedPopover = nil
        }
    }

    private var buttonTitle: String {
        switch controlAction {
        case .explain:
            viewModel.state == .connecting ? copy.connecting : copy.unavailable
        case .openPanel:
            "\(copy.open), \(copy.participantCount(viewModel.participantCount))"
        case .retry:
            copy.retry
        case .startOrJoin:
            viewModel.activeHuddle == nil
                ? copy.start
                : copy.joinWithParticipantCount(viewModel.participantCount)
        }
    }

    private var presentation: MomoHuddleComposerControlPresentation {
        .resolve(
            state: viewModel.state,
            hasActiveHuddle: viewModel.activeHuddle != nil,
            isChannelSelected: isChannelSelected
        )
    }

    private var controlAction: MomoHuddleComposerControlAction {
        .resolve(
            state: localizedControlState,
            isChannelSelected: isChannelSelected,
            noChannelReason: copy.selectChannelReason,
            connectingReason: copy.connecting
        )
    }

    private var localizedControlState: MomoHuddleState {
        guard case .unavailable(let reason) = viewModel.state else {
            return viewModel.state
        }
        return .unavailable(copy.localizedUnavailableReason(reason))
    }

    private var controlColor: Color {
        switch presentation.tone {
        case .secondary: .secondary
        case .accent: MomoTheme.humanAccent
        case .success: MomoTheme.reversibleGreen
        case .warning: MomoTheme.costAmber
        }
    }

    private var helpText: String {
        switch controlAction {
        case .explain(let reason): reason
        case .openPanel: copy.open
        case .retry: copy.connectionFailedReason
        case .startOrJoin: buttonTitle
        }
    }

    private var explanationTitle: String {
        viewModel.state == .connecting ? copy.connecting : copy.unavailable
    }

    private var explanationReason: String {
        if case .explain(let reason) = controlAction { return reason }
        return buttonTitle
    }
}

private struct MomoHuddleExplanationView: View {
    let title: String
    let reason: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: "info.circle")
                .momoTypography(.supportingEmphasized)
            Text(reason)
                .momoTypography(.supporting)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(width: MomoHuddleLayout.panelWidth, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

extension MomoHuddleCopy {
    var selectChannelReason: String {
        switch language {
        case .korean: "허들을 시작하거나 참가하려면 채널을 선택하세요."
        case .english: "Select a channel to start or join a huddle."
        }
    }

    var connectionFailedReason: String {
        switch language {
        case .korean: "허들에 연결할 수 없어요. 잠시 후 다시 시도해 주세요."
        case .english: "Could not connect to the huddle. Try again in a moment."
        }
    }

    func localizedUnavailableReason(_ reason: String) -> String {
        switch reason {
        case MomoHuddleViewModel.serverConnectionRequiredReason:
            return language == .korean
                ? "oort 서버에 연결하면 허들을 사용할 수 있어요."
                : "Connect to an oort server to use huddles."
        case MomoHuddleViewModel.workspaceRequiredReason:
            return language == .korean
                ? "워크스페이스를 선택하면 허들을 사용할 수 있어요."
                : "Select a workspace to use huddles."
        case MomoHuddleViewModel.authenticationRequiredReason:
            return language == .korean
                ? "허들을 사용할 수 없어요. 다시 로그인한 뒤 시도해 주세요."
                : "Huddles are unavailable. Sign in again and retry."
        default:
            return language == .korean
                ? "지금은 허들을 사용할 수 없어요. 잠시 후 다시 시도해 주세요."
                : "Huddles are unavailable right now. Try again in a moment."
        }
    }
}

struct MomoHuddlePanelView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var viewModel: MomoHuddleViewModel
    let copy: MomoHuddleCopy

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Label(copy.live, systemImage: "waveform")
                    .momoTypography(.screenTitle)
                Spacer()
                Text(copy.participantCount(viewModel.participantCount))
                    .momoTypography(.metadata)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }

            Divider()

            Text(copy.participants)
                .momoTypography(.supportingEmphasized)

            ScrollView {
                if participants.isEmpty {
                    Text(copy.noParticipants)
                        .momoTypography(.supporting)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(participants) { participant in
                            participantRow(participant)
                        }
                    }
                }
            }
            .frame(maxHeight: MomoHuddleLayout.participantListMaximumHeight)

            if case .failed = viewModel.state {
                Label(copy.connectionFailedReason, systemImage: "exclamationmark.triangle")
                    .momoTypography(.supporting)
                    .foregroundStyle(MomoTheme.costAmber)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()

            HStack(spacing: 8) {
                Button {
                    Task { await viewModel.toggleMicrophone() }
                } label: {
                    Label(
                        viewModel.isMicrophoneMuted ? copy.unmute : copy.mute,
                        systemImage: viewModel.isMicrophoneMuted ? "mic.slash" : "mic"
                    )
                }
                .keyboardShortcut("m", modifiers: [.command, .shift])
                .disabled(!viewModel.isJoined)

                Spacer()

                Button(copy.leave, role: .destructive) {
                    Task {
                        await viewModel.leave()
                        dismiss()
                    }
                }
                .keyboardShortcut("l", modifiers: [.command, .shift])
            }
        }
        .padding(16)
        .frame(width: MomoHuddleLayout.panelWidth)
        .accessibilityElement(children: .contain)
    }

    private var participants: [MomoHuddleAudioParticipant] {
        if !viewModel.audioParticipants.isEmpty { return viewModel.audioParticipants }
        return (viewModel.activeHuddle?.participants ?? []).map {
            MomoHuddleAudioParticipant(
                id: $0.memberId.description,
                displayName: $0.displayName,
                isSpeaking: false,
                isLocal: false
            )
        }
    }

    private func participantRow(_ participant: MomoHuddleAudioParticipant) -> some View {
        HStack(spacing: 8) {
            Image(systemName: participant.isSpeaking ? "waveform" : "person.crop.circle")
                .foregroundStyle(participant.isSpeaking ? MomoTheme.reversibleGreen : .secondary)
                .opacity(participant.isSpeaking ? 1 : 0.7)
                .frame(width: 24, height: 24)
            Text(participant.displayName)
                .momoTypography(.supporting)
                .lineLimit(2)
            Spacer()
            if participant.isSpeaking {
                Text(copy.speaking)
                    .momoTypography(.metadata)
                    .foregroundStyle(MomoTheme.reversibleGreen)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(participant.isSpeaking
            ? "\(participant.displayName), \(copy.speaking)"
            : participant.displayName)
    }
}
