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

struct MomoChannelCreationSheet: View {
    @ObservedObject var viewModel: ChatViewModel
    let copy: MomoWorkspaceCopy
    let dismiss: () -> Void

    @State private var kind: ChannelKind = .publicChannel
    @State private var name = ""
    @State private var topic = ""
    @State private var attemptedSubmission = false
    @State private var feedback = MomoChannelCreationFeedback()
    @FocusState private var focusedField: MomoChannelCreationField?

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
            await Task.yield()
            focusedField = .name
        }
        .onChange(of: kind) { _, _ in feedback.clearForInputChange() }
        .onChange(of: name) { _, _ in feedback.clearForInputChange() }
        .onChange(of: topic) { _, _ in feedback.clearForInputChange() }
    }

    private func submit() {
        attemptedSubmission = true
        feedback.issue = nil
        let validation = MomoChannelCreationValidation(name: name, topic: topic)
        guard validation.isValid, !viewModel.channelCreateInFlight else {
            focusedField = validation.nameError == nil ? .topic : .name
            return
        }

        Task {
            let created = await viewModel.createChannel(
                kind: kind,
                name: MomoChannelCreationValidation.normalizedName(name),
                topic: MomoChannelCreationValidation.normalizedTopic(topic)
            )
            if created {
                dismiss()
            } else {
                feedback.issue = viewModel.channelCreateIssue ?? .unavailable
            }
        }
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
