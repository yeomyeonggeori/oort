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
        hasActiveHuddle: Bool
    ) -> MomoHuddleComposerControlPresentation {
        switch state {
        case .unavailable, .connecting:
            return .init(systemImage: "waveform", tone: .secondary)
        case .idle:
            return hasActiveHuddle
                ? .init(systemImage: "person.wave.2", tone: .accent)
                : .init(systemImage: "waveform", tone: .accent)
        case .joined:
            return .init(systemImage: "waveform", tone: .success)
        case .failed:
            return .init(systemImage: "arrow.clockwise", tone: .warning)
        }
    }
}

struct MomoHuddleComposerControl: View {
    @ObservedObject var viewModel: MomoHuddleViewModel
    let copy: MomoHuddleCopy
    let isChannelSelected: Bool
    @State private var showsPanel = false

    var body: some View {
        Button {
            if case .failed = viewModel.state {
                Task { await viewModel.retry() }
            } else if viewModel.isJoined {
                showsPanel.toggle()
            } else {
                viewModel.beginStartOrJoin()
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
        .disabled(isDisabled)
        .momoQuickTooltip(helpText)
        .accessibilityLabel(buttonTitle)
        .accessibilityHint(helpText)
        .keyboardShortcut("h", modifiers: [.command, .shift])
        .popover(isPresented: $showsPanel, arrowEdge: .bottom) {
            MomoHuddlePanelView(viewModel: viewModel, copy: copy)
        }
        .onChange(of: viewModel.isJoined) { _, isJoined in
            if !isJoined { showsPanel = false }
        }
    }

    private var buttonTitle: String {
        switch viewModel.state {
        case .connecting: copy.connecting
        case .joined: copy.participantCount(viewModel.participantCount)
        case .unavailable: copy.unavailable
        case .failed: copy.retry
        case .idle:
            viewModel.activeHuddle == nil
                ? copy.start
                : copy.joinWithParticipantCount(viewModel.participantCount)
        }
    }

    private var presentation: MomoHuddleComposerControlPresentation {
        .resolve(
            state: viewModel.state,
            hasActiveHuddle: viewModel.activeHuddle != nil
        )
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
        switch viewModel.state {
        case .unavailable(let reason), .failed(let reason): reason
        case .joined: copy.open
        default: buttonTitle
        }
    }

    private var isDisabled: Bool {
        guard isChannelSelected else { return true }
        return switch viewModel.state {
        case .unavailable, .connecting: true
        case .idle, .joined, .failed: false
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

            if case .failed(let message) = viewModel.state {
                Label(message, systemImage: "exclamationmark.triangle")
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
