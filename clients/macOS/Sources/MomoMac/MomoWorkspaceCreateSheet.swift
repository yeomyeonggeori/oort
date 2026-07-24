import SwiftUI
import MomoCore

// MOMO-590 / W-S1: the "새 워크스페이스 만들기" sheet. A registered operator names
// a workspace, adjusts the auto-derived slug, and creates it; on success the host
// switches the session into the new workspace and can open the invite flow so the
// operator's first move is inviting their team. Split into a stateful wrapper and a
// pure content view so the states rasterize deterministically for snapshots.

enum MomoWorkspaceCreateField: Hashable {
    case name
    case slug
}

struct MomoWorkspaceCreateSheet: View {
    @StateObject private var model: MomoWorkspaceCreateModel
    private let copy: MomoWorkspaceCreateCopy
    private let dismiss: () -> Void
    private let onSwitchToWorkspace: (MomoCreatedWorkspace, Bool) -> Void

    @State private var attemptedSubmission = false
    @State private var submissionTask: Task<Void, Never>?
    @FocusState private var focusedField: MomoWorkspaceCreateField?

    init(
        context: MomoInviteAdminContext?,
        language: MomoUILanguage,
        client: any MomoWorkspaceCreateClient = MomoWorkspaceCreateRESTClient(),
        dismiss: @escaping () -> Void,
        onSwitchToWorkspace: @escaping (MomoCreatedWorkspace, Bool) -> Void
    ) {
        _model = StateObject(wrappedValue: MomoWorkspaceCreateModel(context: context, client: client))
        self.copy = MomoWorkspaceCreateCopy(language: language)
        self.dismiss = dismiss
        self.onSwitchToWorkspace = onSwitchToWorkspace
    }

    // Test/preview initializer that injects a prepared model.
    init(
        model: MomoWorkspaceCreateModel,
        language: MomoUILanguage,
        dismiss: @escaping () -> Void = {},
        onSwitchToWorkspace: @escaping (MomoCreatedWorkspace, Bool) -> Void = { _, _ in }
    ) {
        _model = StateObject(wrappedValue: model)
        self.copy = MomoWorkspaceCreateCopy(language: language)
        self.dismiss = dismiss
        self.onSwitchToWorkspace = onSwitchToWorkspace
    }

    var body: some View {
        MomoWorkspaceCreateSheetContent(
            copy: copy,
            name: Binding(get: { model.nameDraft }, set: { model.updateName($0) }),
            slug: Binding(get: { model.slugDraft }, set: { model.updateSlug($0) }),
            isAuthorized: model.isAuthorized,
            nameIsValid: model.nameIsValid,
            slugIsValid: model.slugIsValid,
            slugManuallyEdited: model.slugManuallyEdited,
            attemptedSubmission: attemptedSubmission,
            failure: model.failure,
            isCreating: model.isWorking,
            canCreate: model.canCreate,
            created: model.created,
            focusedField: $focusedField,
            cancel: dismiss,
            create: submit,
            resetSlug: { model.resetSlugToDerived() },
            switchToWorkspace: { requestInvite in
                guard let created = model.created else { return }
                onSwitchToWorkspace(created, requestInvite)
            }
        )
        .interactiveDismissDisabled(model.isWorking)
        .onExitCommand {
            guard !model.isWorking else { return }
            dismiss()
        }
        .task {
            await Task.yield()
            if model.isAuthorized, model.created == nil {
                focusedField = .name
            }
        }
        .onDisappear {
            submissionTask?.cancel()
        }
    }

    private func submit() {
        attemptedSubmission = true
        guard model.canCreate else {
            focusedField = model.nameIsValid ? .slug : .name
            return
        }
        submissionTask?.cancel()
        submissionTask = Task { @MainActor in
            let created = await model.create()
            guard !Task.isCancelled else { return }
            submissionTask = nil
            if created {
                focusedField = nil
            } else {
                // Anchor the caret on the field the failure is about.
                focusedField = model.failure?.isSlugSpecific == true ? .slug : .name
            }
        }
    }
}

struct MomoWorkspaceCreateSheetContent: View {
    let copy: MomoWorkspaceCreateCopy
    @Binding var name: String
    @Binding var slug: String
    let isAuthorized: Bool
    let nameIsValid: Bool
    let slugIsValid: Bool
    let slugManuallyEdited: Bool
    let attemptedSubmission: Bool
    let failure: MomoWorkspaceCreateFailure?
    let isCreating: Bool
    let canCreate: Bool
    let created: MomoCreatedWorkspace?
    let focusedField: FocusState<MomoWorkspaceCreateField?>.Binding
    let cancel: () -> Void
    let create: () -> Void
    let resetSlug: () -> Void
    let switchToWorkspace: (Bool) -> Void

    var body: some View {
        Group {
            if let created {
                successState(created)
            } else if isAuthorized {
                formState
            } else {
                unavailableState
            }
        }
        .padding(MomoTheme.ChannelCreation.edgeInset)
        .background(MomoTheme.ChannelCreation.background)
        .frame(
            minWidth: MomoTheme.ChannelCreation.minimumWidth,
            idealWidth: MomoTheme.ChannelCreation.idealWidth,
            minHeight: MomoTheme.ChannelCreation.minimumHeight
        )
        .accessibilityIdentifier("workspace-create-sheet")
    }

    // MARK: - Form

    private var formState: some View {
        VStack(alignment: .leading, spacing: MomoTheme.ChannelCreation.sectionSpacing) {
            VStack(alignment: .leading, spacing: MomoTheme.ChannelCreation.standardSpacing) {
                Text(copy.title)
                    .font(.title3.weight(.semibold))
                Text(copy.subtitle)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Form {
                LabeledContent(copy.nameLabel) {
                    VStack(alignment: .leading, spacing: MomoTheme.ChannelCreation.compactSpacing) {
                        TextField("", text: $name, prompt: Text(copy.namePlaceholder))
                            .textFieldStyle(.roundedBorder)
                            .focused(focusedField, equals: .name)
                            .accessibilityIdentifier("workspace-create-name")
                            .accessibilityLabel(copy.nameLabel)
                        fieldMessage(
                            nameValidationMessage,
                            fallback: copy.nameHelp,
                            showsError: (attemptedSubmission || !name.isEmpty) && !nameIsValid
                        )
                    }
                }

                LabeledContent(copy.slugLabel) {
                    VStack(alignment: .leading, spacing: MomoTheme.ChannelCreation.compactSpacing) {
                        TextField("", text: $slug, prompt: Text(copy.slugPlaceholder))
                            .textFieldStyle(.roundedBorder)
                            .focused(focusedField, equals: .slug)
                            .accessibilityIdentifier("workspace-create-slug")
                            .accessibilityLabel(copy.slugLabel)
                        fieldMessage(
                            slugValidationMessage,
                            fallback: copy.slugHelp,
                            showsError: slugShowsError
                        )
                        if slugManuallyEdited {
                            Button(copy.slugResetAction, action: resetSlug)
                                .buttonStyle(.link)
                                .controlSize(.small)
                                .disabled(isCreating)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .disabled(isCreating)

            if let banner = failureBanner {
                Label(banner, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(MomoTheme.irreversibleRed)
                    .fixedSize(horizontal: false, vertical: true)
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
                            .accessibilityLabel(copy.creating)
                    } else {
                        Text(copy.createAction)
                    }
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(!canCreate)
                .accessibilityLabel(isCreating ? copy.creating : copy.createAction)
            }
        }
    }

    // MARK: - Success (session hand-off + invite entry)

    private func successState(_ created: MomoCreatedWorkspace) -> some View {
        VStack(alignment: .leading, spacing: MomoTheme.ChannelCreation.sectionSpacing) {
            VStack(alignment: .leading, spacing: MomoTheme.ChannelCreation.standardSpacing) {
                Label {
                    Text(copy.successTitle(created.name))
                } icon: {
                    Image(systemName: "checkmark.circle")
                        .foregroundStyle(MomoTheme.reversibleGreen)
                }
                .font(.title3.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                Text(copy.successSubtitle)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Form {
                LabeledContent(copy.successWorkspaceLabel) {
                    Text(created.name)
                        .font(.body)
                        .textSelection(.enabled)
                        .multilineTextAlignment(.trailing)
                }
                LabeledContent(copy.slugLabel) {
                    Text(created.slug)
                        .font(.body)
                        .monospaced()
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
            .formStyle(.grouped)

            Divider()

            HStack(spacing: MomoTheme.ChannelCreation.standardSpacing) {
                Spacer()
                Button(copy.successGoToWorkspace) {
                    switchToWorkspace(false)
                }
                .buttonStyle(.bordered)
                .foregroundStyle(.primary)
                Button {
                    switchToWorkspace(true)
                } label: {
                    Label(copy.successInviteAction, systemImage: "person.crop.circle.badge.plus")
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .accessibilityLabel(copy.successInviteAction)
            }
        }
    }

    // MARK: - Unavailable (no operator session)

    private var unavailableState: some View {
        ContentUnavailableView {
            Label(copy.unavailableTitle, systemImage: "person.badge.key")
        } description: {
            Text(copy.unavailableDescription)
        } actions: {
            Button(copy.close, action: cancel)
                .keyboardShortcut(.cancelAction)
        }
    }

    // MARK: - Field helpers

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

    private var nameValidationMessage: String? {
        nameIsValid ? nil : copy.nameInvalid
    }

    private var slugValidationMessage: String? {
        if failure?.isSlugSpecific == true {
            return copy.slugConflict
        }
        return slugIsValid ? nil : copy.slugInvalid
    }

    private var slugShowsError: Bool {
        if failure?.isSlugSpecific == true { return true }
        return (attemptedSubmission || !slug.isEmpty) && !slugIsValid
    }

    /// Sheet-level failures that are not tied to a single field.
    private var failureBanner: String? {
        guard let failure else { return nil }
        switch failure {
        case .slugConflict, .invalidInput:
            // Surfaced inline on the field(s) instead.
            return nil
        case .forbidden:
            return copy.forbidden
        case .unauthorized:
            return copy.unauthorized
        case .offline:
            return copy.offline
        case .invalidResponse:
            return copy.invalidResponse
        case .other:
            return copy.otherFailure
        }
    }
}

struct MomoWorkspaceCreateCopy {
    let language: MomoUILanguage

    private var isKorean: Bool { language == .korean }

    var title: String { isKorean ? "새 워크스페이스 만들기" : "Create a workspace" }
    var subtitle: String {
        isKorean
            ? "팀 이름을 정하면 워크스페이스가 만들어지고, 바로 팀원을 초대할 수 있어요."
            : "Name your team to create the workspace, then invite people right away."
    }

    var nameLabel: String { isKorean ? "이름" : "Name" }
    var namePlaceholder: String { isKorean ? "예: 모모 코어팀" : "e.g. Momo Core Team" }
    var nameHelp: String {
        isKorean
            ? "사이드바와 초대장에 보이는 이름이에요."
            : "The name people see in the sidebar and on invitations."
    }
    var nameInvalid: String {
        isKorean
            ? "이름을 1자 이상 200자 이하로 입력하세요."
            : "Enter a name between 1 and 200 characters."
    }

    var slugLabel: String { isKorean ? "주소(slug)" : "Address (slug)" }
    var slugPlaceholder: String { "momo-core-team" }
    var slugHelp: String {
        isKorean
            ? "워크스페이스 주소로 쓰여요. 이름에서 자동으로 채워지고, 직접 고칠 수 있어요."
            : "Used as the workspace address. It fills in from the name, and you can edit it."
    }
    var slugInvalid: String {
        isKorean
            ? "소문자, 숫자, 하이픈만 쓸 수 있고 하이픈으로 시작하거나 끝날 수 없어요."
            : "Use lowercase letters, numbers, and hyphens; it cannot start or end with a hyphen."
    }
    var slugConflict: String {
        isKorean
            ? "이미 쓰고 있는 주소예요. 다른 주소를 입력하세요."
            : "That address is already taken. Enter a different one."
    }
    var slugResetAction: String { isKorean ? "이름에서 자동 생성" : "Generate from name" }

    var cancel: String { isKorean ? "취소" : "Cancel" }
    var close: String { isKorean ? "닫기" : "Close" }
    var createAction: String { isKorean ? "워크스페이스 만들기" : "Create workspace" }
    var creating: String { isKorean ? "만드는 중" : "Creating" }

    // Sheet-level failures
    var forbidden: String {
        isKorean
            ? "워크스페이스를 만들 권한이 없어요. 서버 운영자에게 문의하세요."
            : "You do not have permission to create a workspace. Contact a server operator."
    }
    var unauthorized: String {
        isKorean
            ? "운영자 세션이 만료됐어요. 다시 로그인한 뒤 시도하세요."
            : "Your operator session expired. Sign in again, then retry."
    }
    var offline: String {
        isKorean
            ? "서버에 연결할 수 없어요. 연결을 확인한 뒤 다시 시도하세요."
            : "The server could not be reached. Check the connection, then retry."
    }
    var invalidResponse: String {
        isKorean
            ? "서버 응답을 확인할 수 없어요. 잠시 후 다시 시도하세요."
            : "The server response could not be verified. Try again shortly."
    }
    var otherFailure: String {
        isKorean
            ? "워크스페이스를 만들지 못했어요. 잠시 후 다시 시도하세요."
            : "The workspace could not be created. Try again shortly."
    }

    // Success + hand-off
    func successTitle(_ name: String) -> String {
        isKorean ? "'\(name)' 워크스페이스를 만들었어요" : "Created the '\(name)' workspace"
    }
    var successSubtitle: String {
        isKorean
            ? "새 워크스페이스로 이동해서 팀원을 초대하세요."
            : "Move to the new workspace and invite your team."
    }
    var successWorkspaceLabel: String { isKorean ? "이름" : "Name" }
    var successInviteAction: String { isKorean ? "이동해서 팀원 초대" : "Move and invite people" }
    var successGoToWorkspace: String { isKorean ? "이동만 하기" : "Just move" }

    // Unavailable
    var unavailableTitle: String { isKorean ? "운영자 세션이 필요해요" : "Operator session required" }
    var unavailableDescription: String {
        isKorean
            ? "등재된 운영자 계정으로 로그인한 뒤 다시 열면 워크스페이스를 만들 수 있어요."
            : "Sign in with a registered operator account, then reopen this to create a workspace."
    }
}
