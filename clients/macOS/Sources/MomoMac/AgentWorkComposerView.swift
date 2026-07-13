import SwiftUI
import MomoCore

struct AgentWorkComposerView: View {
    @ObservedObject var viewModel: ChatViewModel
    let copy: MomoWorkspaceCopy
    let onStarted: (RunID) -> Void
    let onCancel: () -> Void

    @State private var selectedAgentId: MemberID?
    @State private var title = ""
    @State private var brief: String

    init(
        viewModel: ChatViewModel,
        copy: MomoWorkspaceCopy,
        initialBrief: String,
        onStarted: @escaping (RunID) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.viewModel = viewModel
        self.copy = copy
        self.onStarted = onStarted
        self.onCancel = onCancel
        _brief = State(initialValue: initialBrief)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header

            if !viewModel.isWorkSurfaceAvailable {
                unavailableState
            } else if agents.isEmpty {
                emptyAgentState
            } else {
                workForm
            }
        }
        .padding(16)
        .frame(width: MomoTheme.Work.composerWidth)
        .momoSurface(.card, cornerRadius: MomoTheme.cornerLarge)
        .onAppear {
            selectedAgentId = selectedAgentId ?? agents.first?.id
        }
        .onChange(of: agents.map(\.id)) { _, ids in
            if selectedAgentId.map({ ids.contains($0) }) != true {
                selectedAgentId = ids.first
            }
        }
    }

    private var agents: [Member] {
        viewModel.workTargetAgents
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "hammer")
                .font(.body.weight(.semibold))
                .foregroundStyle(MomoTheme.agentAccent)
                .frame(
                    width: MomoTheme.Work.statusIconSize,
                    height: MomoTheme.Work.statusIconSize
                )

            VStack(alignment: .leading, spacing: 4) {
                Text(copy.workComposerTitle)
                    .font(MomoTheme.Typography.sectionHeader)
                Text(copy.workComposerSubtitle)
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 8)
        }
    }

    private var workForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let status = viewModel.selectedRealtimeStatus, !status.isLive {
                Label(copy.workRestFallbackNote, systemImage: "clock.arrow.circlepath")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let error = viewModel.workCreationError {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(MomoTheme.irreversibleRed)
                    Text(copy.workError(error))
                        .font(.caption)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Button {
                        viewModel.clearWorkCreationError()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.borderless)
                    .help(copy.dismissWorkError)
                    .accessibilityLabel(copy.dismissWorkError)
                }
            }

            Form {
                Picker(copy.workAgentLabel, selection: $selectedAgentId) {
                    ForEach(agents) { agent in
                        Text("\(agent.displayName)  @\(agent.handle)")
                            .tag(Optional(agent.id))
                    }
                }

                TextField(copy.workTitleLabel, text: $title, prompt: Text(copy.workTitlePlaceholder))

                LabeledContent(copy.workBriefLabel) {
                    ZStack(alignment: .topLeading) {
                        TextEditor(text: $brief)
                            .font(.body)
                            .frame(minHeight: MomoTheme.Work.briefMinimumHeight)
                            .accessibilityLabel(copy.workBriefLabel)
                        if brief.isEmpty {
                            Text(copy.workBriefPlaceholder)
                                .font(.body)
                                .foregroundStyle(.tertiary)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 8)
                                .allowsHitTesting(false)
                        }
                    }
                }
            }
            .formStyle(.grouped)

            HStack(spacing: 8) {
                Spacer()
                Button(copy.cancelWorkComposer, action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button {
                    startWork()
                } label: {
                    if viewModel.isCreatingWorkRun {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Label(copy.startWork, systemImage: "play.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!canStart)
            }
        }
    }

    private var unavailableState: some View {
        stateView(
            title: copy.workUnavailableTitle,
            body: copy.workUnavailableBody,
            systemImage: "server.rack"
        )
    }

    private var emptyAgentState: some View {
        stateView(
            title: copy.noWorkAgentsTitle,
            body: copy.noWorkAgentsBody,
            systemImage: "person.crop.circle.badge.questionmark"
        )
    }

    private func stateView(title: String, body: String, systemImage: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: systemImage)
                .font(.body.weight(.semibold))
            Text(body)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(copy.returnToMessage, action: onCancel)
                .keyboardShortcut(.cancelAction)
        }
    }

    private var canStart: Bool {
        selectedAgentId != nil
            && !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !viewModel.isCreatingWorkRun
    }

    private func startWork() {
        guard let selectedAgentId else { return }
        Task {
            if let runId = await viewModel.startWork(
                agent: selectedAgentId,
                title: title,
                brief: brief
            ) {
                onStarted(runId)
            }
        }
    }
}
