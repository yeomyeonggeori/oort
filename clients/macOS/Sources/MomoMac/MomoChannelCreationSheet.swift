import SwiftUI
import MomoCore

enum MomoChannelNameValidationError: Equatable {
    case required
    case tooLong
    case unsupportedCharacters
}

enum MomoChannelTopicValidationError: Equatable {
    case tooLong
}

struct MomoChannelCreationValidation: Equatable {
    static let maximumNameLength = 80
    static let maximumTopicLength = 280

    let nameError: MomoChannelNameValidationError?
    let topicError: MomoChannelTopicValidationError?

    var isValid: Bool { nameError == nil && topicError == nil }

    static func normalizedName(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func normalizedTopic(_ topic: String) -> String {
        topic.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    init(name: String, topic: String) {
        let normalizedName = Self.normalizedName(name)
        if normalizedName.isEmpty {
            nameError = .required
        } else if normalizedName.count > Self.maximumNameLength {
            nameError = .tooLong
        } else if normalizedName.range(
            of: #"^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$"#,
            options: .regularExpression
        ) == nil {
            nameError = .unsupportedCharacters
        } else {
            nameError = nil
        }

        let normalizedTopic = Self.normalizedTopic(topic)
        topicError = normalizedTopic.count > Self.maximumTopicLength ? .tooLong : nil
    }
}

enum MomoChannelCreationField: Hashable {
    case name
    case topic
}

struct MomoChannelCreationFeedback: Equatable {
    var issue: MomoChannelCreateIssue?

    mutating func clearForInputChange() {
        issue = nil
    }
}

struct MomoChannelCreationSubmissionState: Equatable {
    struct Attempt: Equatable {
        let id: UUID
        let inputRevision: UInt64
    }

    private(set) var inputRevision: UInt64 = 0
    private(set) var attemptID: UUID?

    mutating func begin() -> Attempt {
        let id = UUID()
        attemptID = id
        return Attempt(id: id, inputRevision: inputRevision)
    }

    mutating func inputDidChange() {
        inputRevision &+= 1
        attemptID = nil
    }

    mutating func cancel() {
        attemptID = nil
    }

    func isCurrent(_ attempt: Attempt) -> Bool {
        attemptID == attempt.id && inputRevision == attempt.inputRevision
    }

    mutating func finish(_ attempt: Attempt) -> Bool {
        guard isCurrent(attempt) else { return false }
        attemptID = nil
        return true
    }
}

enum MomoChannelCreationCompletion: Equatable {
    case dismiss
    case showIssue(MomoChannelCreateIssue)
    case ignore

    static func resolve(
        created: Bool,
        localIssue: MomoChannelCreateIssue?,
        connectionIssue: MomoConnectionIssue?
    ) -> Self {
        if created || connectionIssue == .authenticationExpired {
            return .dismiss
        }
        if let localIssue {
            return .showIssue(localIssue)
        }
        return .ignore
    }

    static func shouldDismissBeforePresentation(connectionIssue: MomoConnectionIssue?) -> Bool {
        connectionIssue == .authenticationExpired
    }
}

@MainActor
enum MomoChannelCreationSubmitCoordinator {
    static func run(
        expectedSessionGeneration: UInt64,
        isAttemptCurrent: @MainActor () -> Bool,
        currentSessionGeneration: @MainActor () -> UInt64,
        create: @MainActor () async -> Bool
    ) async -> Bool? {
        guard !Task.isCancelled,
              isAttemptCurrent(),
              currentSessionGeneration() == expectedSessionGeneration
        else { return nil }
        return await create()
    }
}

struct MomoChannelCreationSheet: View {
    @ObservedObject var viewModel: ChatViewModel
    let copy: MomoWorkspaceCopy
    let dismiss: () -> Void

    @State private var kind: ChannelKind = .publicChannel
    @State private var name = ""
    @State private var topic = ""
    @State private var attemptedSubmission = false
    @State private var feedback = MomoChannelCreationFeedback()
    @State private var submission = MomoChannelCreationSubmissionState()
    @State private var submissionTask: Task<Void, Never>?
    @State private var presentedSessionGeneration: UInt64?
    @FocusState private var focusedField: MomoChannelCreationField?

    init(
        viewModel: ChatViewModel,
        copy: MomoWorkspaceCopy,
        dismiss: @escaping () -> Void
    ) {
        self.viewModel = viewModel
        self.copy = copy
        self.dismiss = dismiss
        _presentedSessionGeneration = State(initialValue: viewModel.channelCreateSessionGeneration)
    }

    var body: some View {
        MomoChannelCreationSheetContent(
            copy: copy,
            kind: $kind,
            name: $name,
            topic: $topic,
            attemptedSubmission: attemptedSubmission,
            creationIssue: feedback.issue,
            isCreating: viewModel.channelCreateInFlight,
            focusedField: $focusedField,
            cancel: dismiss,
            create: submit,
            retry: submit
        )
        .interactiveDismissDisabled(viewModel.channelCreateInFlight)
        .onExitCommand {
            guard !viewModel.channelCreateInFlight else { return }
            dismiss()
        }
        .task {
            guard !MomoChannelCreationCompletion.shouldDismissBeforePresentation(
                connectionIssue: viewModel.connectionIssue
            ) else {
                cancelSubmission()
                dismiss()
                return
            }
            await Task.yield()
            focusedField = .name
        }
        .onChange(of: kind) { _, _ in handleInputChange() }
        .onChange(of: name) { _, _ in handleInputChange() }
        .onChange(of: topic) { _, _ in handleInputChange() }
        .onChange(of: viewModel.channelCreateSessionGeneration) { _, generation in
            guard let presentedSessionGeneration,
                  generation != presentedSessionGeneration
            else { return }
            cancelSubmission()
            dismiss()
        }
        .onChange(of: viewModel.connectionIssue) { _, issue in
            guard issue == .authenticationExpired else { return }
            cancelSubmission()
            dismiss()
        }
        .onDisappear {
            cancelSubmission()
        }
    }

    private func submit() {
        attemptedSubmission = true
        feedback.issue = nil
        let validation = MomoChannelCreationValidation(name: name, topic: topic)
        guard validation.isValid, !viewModel.channelCreateInFlight else {
            focusedField = validation.nameError == nil ? .topic : .name
            return
        }

        submissionTask?.cancel()
        let attempt = submission.begin()
        let sessionGeneration = viewModel.channelCreateSessionGeneration
        let submittedKind = kind
        let submittedName = MomoChannelCreationValidation.normalizedName(name)
        let submittedTopic = MomoChannelCreationValidation.normalizedTopic(topic)
        submissionTask = Task { @MainActor in
            guard let created = await MomoChannelCreationSubmitCoordinator.run(
                expectedSessionGeneration: sessionGeneration,
                isAttemptCurrent: { submission.isCurrent(attempt) },
                currentSessionGeneration: { viewModel.channelCreateSessionGeneration },
                create: {
                    await viewModel.createChannel(
                        kind: submittedKind,
                        name: submittedName,
                        topic: submittedTopic
                    )
                }
            )
            else { return }
            guard !Task.isCancelled,
                  submission.isCurrent(attempt),
                  viewModel.channelCreateSessionGeneration == sessionGeneration
            else { return }
            guard submission.finish(attempt) else { return }
            submissionTask = nil
            switch MomoChannelCreationCompletion.resolve(
                created: created,
                localIssue: viewModel.channelCreateIssue,
                connectionIssue: viewModel.connectionIssue
            ) {
            case .dismiss:
                dismiss()
            case .showIssue(let issue):
                feedback.issue = issue
            case .ignore:
                break
            }
        }
    }

    private func handleInputChange() {
        submission.inputDidChange()
        feedback.clearForInputChange()
        guard submissionTask != nil else { return }
        cancelSubmission()
    }

    private func cancelSubmission() {
        submissionTask?.cancel()
        submissionTask = nil
        submission.cancel()
        viewModel.cancelChannelCreation()
    }
}

struct MomoChannelCreationSheetContent: View {
    let copy: MomoWorkspaceCopy
    @Binding var kind: ChannelKind
    @Binding var name: String
    @Binding var topic: String
    let attemptedSubmission: Bool
    let creationIssue: MomoChannelCreateIssue?
    let isCreating: Bool
    let focusedField: FocusState<MomoChannelCreationField?>.Binding
    let cancel: () -> Void
    let create: () -> Void
    let retry: () -> Void

    private var validation: MomoChannelCreationValidation {
        MomoChannelCreationValidation(name: name, topic: topic)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: MomoTheme.ChannelCreation.sectionSpacing) {
            VStack(alignment: .leading, spacing: MomoTheme.ChannelCreation.standardSpacing) {
                Text(copy.createChannelTitle)
                    .font(.title3.weight(.semibold))
                Text(copy.createChannelSubtitle)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Form {
                Picker(copy.channelVisibilityLabel, selection: $kind) {
                    Label(copy.publicChannel, systemImage: "number")
                        .tag(ChannelKind.publicChannel)
                    Label(copy.privateChannel, systemImage: "lock")
                        .tag(ChannelKind.privateChannel)
                }
                .pickerStyle(.segmented)

                LabeledContent(copy.channelNameLabel) {
                    VStack(alignment: .leading, spacing: MomoTheme.ChannelCreation.compactSpacing) {
                        TextField("", text: $name, prompt: Text(copy.channelNamePlaceholder))
                            .textFieldStyle(.roundedBorder)
                            .focused(focusedField, equals: .name)
                            .accessibilityLabel(copy.channelNameLabel)
                        fieldMessage(
                            validation.nameError.map(copy.channelNameValidationMessage),
                            fallback: copy.channelNameHelp,
                            showsError: attemptedSubmission || !name.isEmpty
                        )
                    }
                }

                LabeledContent(copy.channelTopicLabel) {
                    VStack(alignment: .leading, spacing: MomoTheme.ChannelCreation.compactSpacing) {
                        TextField("", text: $topic, prompt: Text(copy.channelTopicPlaceholder))
                            .textFieldStyle(.roundedBorder)
                            .focused(focusedField, equals: .topic)
                            .accessibilityLabel(copy.channelTopicLabel)
                        fieldMessage(
                            validation.topicError.map(copy.channelTopicValidationMessage),
                            fallback: copy.channelTopicHelp,
                            showsError: attemptedSubmission || !topic.isEmpty
                        )
                    }
                }
            }
            .formStyle(.grouped)
            .disabled(isCreating)

            if let creationIssue {
                VStack(alignment: .leading, spacing: MomoTheme.ChannelCreation.standardSpacing) {
                    Label(copy.channelCreateErrorMessage(creationIssue), systemImage: "exclamationmark.triangle")
                        .font(.callout)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(copy.retryChannelCreation, action: retry)
                        .controlSize(.small)
                        .disabled(isCreating || !validation.isValid)
                }
            }

            Divider()

            HStack(spacing: MomoTheme.ChannelCreation.standardSpacing) {
                Spacer()
                Button(copy.cancel, action: cancel)
                    .buttonStyle(.bordered)
                    .foregroundStyle(.primary)
                    .keyboardShortcut(.cancelAction)
                    .disabled(isCreating)
                Button(action: create) {
                    if isCreating {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityLabel(copy.creatingChannel)
                    } else {
                        Text(copy.createChannelAction)
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(isCreating || !validation.isValid)
                .accessibilityLabel(isCreating ? copy.creatingChannel : copy.createChannelAction)
            }
        }
        .padding(MomoTheme.ChannelCreation.edgeInset)
        .background(MomoTheme.ChannelCreation.background)
        .frame(
            minWidth: MomoTheme.ChannelCreation.minimumWidth,
            idealWidth: MomoTheme.ChannelCreation.idealWidth,
            minHeight: MomoTheme.ChannelCreation.minimumHeight
        )
    }

    @ViewBuilder
    private func fieldMessage(_ error: String?, fallback: String, showsError: Bool) -> some View {
        if showsError, let error {
            Label(error, systemImage: "exclamationmark.circle")
                .font(.caption)
                .foregroundStyle(MomoTheme.irreversibleRed)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text(fallback)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
