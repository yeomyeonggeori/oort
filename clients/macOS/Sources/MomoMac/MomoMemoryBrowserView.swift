import SwiftUI
import MomoCore

@MainActor
final class MomoMemoryBrowserModel: ObservableObject {
    @Published private(set) var entries: [MemoryEntry] = []
    @Published var selectedID: UUID?
    @Published var query = ""
    @Published var scope: MemoryScope?
    @Published var agentID: MemberID?
    @Published var includeInvalid = false
    @Published private(set) var policy: WorkspaceMemoryPolicy?
    @Published private(set) var isLoading = false
    @Published private(set) var isMutating = false
    @Published private(set) var errorMessage: String?

    let backend: (any MemoryPlaneBackend)?
    let workspace: WorkspaceID?

    init(
        backend: (any MemoryPlaneBackend)?,
        workspace: WorkspaceID?,
        initialAgentID: MemberID? = nil
    ) {
        self.backend = backend
        self.workspace = workspace
        self.agentID = initialAgentID
        if initialAgentID != nil { self.scope = .agent }
    }

    var selectedEntry: MemoryEntry? {
        entries.first { $0.id == selectedID }
    }

    func load() async {
        guard let backend, let workspace else {
            errorMessage = BackendError.notConnected.localizedDescription
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            async let nextPolicy = backend.memoryPolicy(workspace: workspace)
            let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
            let nextEntries: [MemoryEntry]
            if normalizedQuery.count >= 2 {
                nextEntries = try await backend.searchMemories(
                    workspace: workspace,
                    query: normalizedQuery,
                    scope: scope,
                    agent: agentID,
                    limit: 50
                ).map(\.memory)
            } else {
                nextEntries = try await backend.memories(
                    workspace: workspace,
                    scope: scope,
                    agent: agentID,
                    includeInvalid: includeInvalid,
                    limit: 200
                )
            }
            entries = nextEntries
            policy = try await nextPolicy
            if selectedID.flatMap({ id in entries.first(where: { $0.id == id }) }) == nil {
                selectedID = entries.first?.id
            }
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func save(entry: MemoryEntry, body: String, confidence: Double) async -> Bool {
        guard let backend, let workspace else { return false }
        let normalized = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return false }
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            let updated = try await backend.updateMemory(
                workspace: workspace,
                memory: entry.id,
                body: normalized,
                confidence: min(max(confidence, 0), 1)
            )
            replace(updated)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func invalidate(_ entry: MemoryEntry) async -> Bool {
        guard let backend, let workspace else { return false }
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            let updated = try await backend.invalidateMemory(workspace: workspace, memory: entry.id)
            if includeInvalid {
                replace(updated)
            } else {
                entries.removeAll { $0.id == updated.id }
                selectedID = entries.first?.id
            }
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func setPolicy(enabled: Bool) async -> Bool {
        guard let backend, let workspace else { return false }
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            policy = try await backend.setMemoryPolicy(workspace: workspace, enabled: enabled)
            if !enabled {
                entries = []
                selectedID = nil
            } else {
                await load()
            }
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func reportPresentationError(_ message: String) {
        errorMessage = message
    }

    private func replace(_ entry: MemoryEntry) {
        guard let index = entries.firstIndex(where: { $0.id == entry.id }) else {
            entries.insert(entry, at: 0)
            selectedID = entry.id
            return
        }
        entries[index] = entry
    }
}

struct MomoMemoryBrowserView: View {
    @ObservedObject var viewModel: ChatViewModel
    @StateObject private var model: MomoMemoryBrowserModel
    let copy: MomoWorkspaceCopy
    private let loadsOnAppear: Bool

    @Environment(\.dismiss) private var dismiss
    @State private var confirmsPolicyDisable = false
    @State private var searchTask: Task<Void, Never>?

    init(
        viewModel: ChatViewModel,
        copy: MomoWorkspaceCopy,
        initialAgentID: MemberID? = nil
    ) {
        self.viewModel = viewModel
        self.copy = copy
        loadsOnAppear = true
        _model = StateObject(
            wrappedValue: MomoMemoryBrowserModel(
                backend: viewModel.memoryPlanePresentationBackend,
                workspace: viewModel.workspaceId,
                initialAgentID: initialAgentID
            )
        )
    }

    init(
        viewModel: ChatViewModel,
        copy: MomoWorkspaceCopy,
        model: MomoMemoryBrowserModel
    ) {
        self.viewModel = viewModel
        self.copy = copy
        loadsOnAppear = false
        _model = StateObject(wrappedValue: model)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            HSplitView {
                filters
                    .frame(minWidth: 188, idealWidth: 208, maxWidth: 236)
                memoryList
                    .frame(minWidth: 300, idealWidth: 340, maxWidth: 400)
                detail
                    .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(width: 1_040, height: 700)
        .background(Color(nsColor: .windowBackgroundColor))
        .task {
            guard loadsOnAppear else { return }
            await model.load()
        }
        .onChange(of: searchIdentity) { _, _ in
            guard loadsOnAppear else { return }
            searchTask?.cancel()
            searchTask = Task {
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                await model.load()
            }
        }
        .onDisappear { searchTask?.cancel() }
        .alert(copy.memoryDisableTitle, isPresented: $confirmsPolicyDisable) {
            Button(copy.cancel, role: .cancel) {}
            Button(copy.memoryDisableAction, role: .destructive) {
                Task { _ = await model.setPolicy(enabled: false) }
            }
        } message: {
            Text(copy.memoryPolicyDetail)
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "brain.head.profile")
                .font(.title3.weight(.semibold))
                .foregroundStyle(MomoTheme.agentAccent)
                .frame(width: 36, height: 36)
                .background(MomoTheme.agentAccent.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text(copy.memoryBrowserTitle).font(MomoTheme.Typography.screenTitle)
                Text(copy.memoryBrowserSubtitle)
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(copy.dismiss) { dismiss() }
                .keyboardShortcut(.cancelAction)
        }
        .padding(16)
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: 16) {
            TextField(copy.memorySearchPlaceholder, text: $model.query)
                .textFieldStyle(.roundedBorder)

            VStack(alignment: .leading, spacing: 6) {
                Text(copy.memoryAllScopes)
                    .font(MomoTheme.Typography.sectionHeader)
                Picker(copy.memoryAllScopes, selection: $model.scope) {
                    Text(copy.memoryAllScopes).tag(MemoryScope?.none)
                    ForEach(MemoryScope.allCases, id: \.self) { scope in
                        Text(copy.memoryScopeTitle(scope)).tag(Optional(scope))
                    }
                }
                .labelsHidden()
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(copy.memoryAllAgents)
                    .font(MomoTheme.Typography.sectionHeader)
                Picker(copy.memoryAllAgents, selection: $model.agentID) {
                    Text(copy.memoryAllAgents).tag(MemberID?.none)
                    ForEach(viewModel.members.filter(\.isAgent)) { agent in
                        Text(agent.displayName).tag(Optional(agent.id))
                    }
                }
                .labelsHidden()
            }

            Toggle(copy.memoryShowInactive, isOn: $model.includeInvalid)
                .font(MomoTheme.Typography.row)

            Divider()

            VStack(alignment: .leading, spacing: 8) {
                Text(copy.memoryPolicyTitle).font(MomoTheme.Typography.sectionHeader)
                Toggle(
                    copy.memoryPolicyTitle,
                    isOn: Binding(
                        get: { model.policy?.enabled ?? false },
                        set: { enabled in
                            if enabled {
                                Task { _ = await model.setPolicy(enabled: true) }
                            } else {
                                confirmsPolicyDisable = true
                            }
                        }
                    )
                )
                .labelsHidden()
                .disabled(!viewModel.canManageWorkspace || model.policy == nil || model.isMutating)
                Text(copy.memoryPolicyDetail)
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()

            Button {
                Task { await model.load() }
            } label: {
                Label(copy.memoryRetry, systemImage: "arrow.clockwise")
            }
            .disabled(model.isLoading)
        }
        .padding(16)
        .frame(maxHeight: .infinity, alignment: .top)
        .momoFlatSurface(.panel)
    }

    private var memoryList: some View {
        VStack(spacing: 0) {
            if let error = model.errorMessage {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(MomoTheme.irreversibleRed)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if model.isLoading && model.entries.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.entries.isEmpty {
                ContentUnavailableView(
                    copy.memoryNoResults,
                    systemImage: "brain.head.profile",
                    description: Text(copy.memoryNoResultsDetail)
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(model.entries) { entry in
                            Button {
                                model.selectedID = entry.id
                            } label: {
                                MomoMemoryEntryRow(entry: entry, copy: copy)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(
                                        model.selectedID == entry.id
                                            ? MomoTheme.selectionBackground
                                            : Color.clear,
                                        in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall)
                                    )
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(model.selectedID == entry.id ? .isSelected : [])
                        }
                    }
                    .padding(8)
                }
            }
        }
        .frame(maxHeight: .infinity)
        .momoFlatSurface(.background)
    }

    @ViewBuilder
    private var detail: some View {
        if let entry = model.selectedEntry {
            MomoMemoryEntryDetail(
                entry: entry,
                model: model,
                copy: copy,
                canManage: viewModel.canManageWorkspace,
                onOpenSource: { source in
                    await viewModel.focusMessage(source.messageId, in: source.channelId)
                    if viewModel.failedMessageFocus == nil {
                        dismiss()
                    } else {
                        model.reportPresentationError(copy.memorySourceUnavailable)
                    }
                }
            )
            .id(entry.id.uuidString + "-\(entry.updatedAtMs)")
        } else {
            ContentUnavailableView(copy.memoryNoResults, systemImage: "text.page")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .momoFlatSurface(.background)
        }
    }

    private var searchIdentity: String {
        [
            model.query,
            model.scope?.rawValue ?? "all",
            model.agentID?.description ?? "all",
            model.includeInvalid.description,
        ].joined(separator: "|")
    }
}

private struct MomoMemoryEntryRow: View {
    let entry: MemoryEntry
    let copy: MomoWorkspaceCopy

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(copy.memoryKindTitle(entry.kind))
                    .font(MomoTheme.Typography.supporting.weight(.semibold))
                Text(copy.memoryScopeTitle(entry.scope))
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
                Spacer()
                Circle()
                    .fill(entry.isActive ? MomoTheme.reversibleGreen : Color.secondary)
                    .frame(width: 7, height: 7)
                    .accessibilityLabel(entry.isActive ? copy.memoryActive : copy.memoryInvalidated)
            }
            Text(entry.body)
                .font(MomoTheme.Typography.row)
                .lineLimit(3)
            Text(Date(timeIntervalSince1970: Double(entry.updatedAtMs) / 1_000), style: .date)
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

private struct MomoMemoryEntryDetail: View {
    let entry: MemoryEntry
    @ObservedObject var model: MomoMemoryBrowserModel
    let copy: MomoWorkspaceCopy
    let canManage: Bool
    let onOpenSource: (MemorySourceReference) async -> Void

    @State private var bodyDraft: String
    @State private var confidence: Double
    @State private var confirmsInvalidation = false

    init(
        entry: MemoryEntry,
        model: MomoMemoryBrowserModel,
        copy: MomoWorkspaceCopy,
        canManage: Bool,
        onOpenSource: @escaping (MemorySourceReference) async -> Void
    ) {
        self.entry = entry
        self.model = model
        self.copy = copy
        self.canManage = canManage
        self.onOpenSource = onOpenSource
        _bodyDraft = State(initialValue: entry.body)
        _confidence = State(initialValue: entry.confidence)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(copy.memoryKindTitle(entry.kind)).font(MomoTheme.Typography.screenTitle)
                        Text(copy.memoryScopeTitle(entry.scope))
                            .font(MomoTheme.Typography.supporting)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Label(
                        entry.isActive ? copy.memoryActive : copy.memoryInvalidated,
                        systemImage: entry.isActive ? "checkmark.circle.fill" : "archivebox"
                    )
                    .font(MomoTheme.Typography.supporting.weight(.semibold))
                    .foregroundStyle(entry.isActive ? MomoTheme.reversibleGreen : .secondary)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text(copy.memoryBody).font(MomoTheme.Typography.sectionHeader)
                    TextEditor(text: $bodyDraft)
                        .font(MomoTheme.Typography.row)
                        .frame(minHeight: 150)
                        .padding(8)
                        .momoSurface(.panel)
                        .disabled(!canManage || !entry.isActive)
                }

                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(copy.memoryConfidence).font(MomoTheme.Typography.sectionHeader)
                        Spacer()
                        Text(confidence, format: .percent.precision(.fractionLength(0)))
                            .font(MomoTheme.Typography.supporting.monospacedDigit())
                    }
                    Slider(value: $confidence, in: 0...1, step: 0.01)
                        .disabled(!canManage || !entry.isActive)
                }

                HStack {
                    Button {
                        Task { _ = await model.save(entry: entry, body: bodyDraft, confidence: confidence) }
                    } label: {
                        Label(copy.memorySave, systemImage: "checkmark")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canManage || !entry.isActive || model.isMutating || bodyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    Button(role: .destructive) {
                        confirmsInvalidation = true
                    } label: {
                        Label(copy.memoryInvalidate, systemImage: "archivebox")
                    }
                    .disabled(!canManage || !entry.isActive || model.isMutating)
                }

                Divider()

                VStack(alignment: .leading, spacing: 10) {
                    Text(copy.memorySources).font(MomoTheme.Typography.sectionHeader)
                    if entry.sourceRefs.isEmpty {
                        Text(copy.servedContextEmpty)
                            .font(MomoTheme.Typography.supporting)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(Array(entry.sourceRefs.enumerated()), id: \.offset) { _, source in
                        Button {
                            Task { await onOpenSource(source) }
                        } label: {
                            HStack {
                                Image(systemName: "arrow.turn.up.left")
                                Text(copy.memoryOpenSource)
                                Spacer()
                                Text(source.messageId.description.prefix(8))
                                    .font(MomoTheme.Typography.supporting.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                        .padding(10)
                        .momoSurface(.panel)
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text(copy.memoryGrantTitle).font(MomoTheme.Typography.sectionHeader)
                    Label(copy.memoryGrantUnavailable, systemImage: "lock")
                        .font(MomoTheme.Typography.supporting)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(spacing: 8) {
                    LabeledContent(copy.memoryCreatedAt) {
                        Text(formatted(entry.createdAtMs)).monospacedDigit()
                    }
                    LabeledContent(copy.memoryUpdatedAt) {
                        Text(formatted(entry.updatedAtMs)).monospacedDigit()
                    }
                }
                .font(MomoTheme.Typography.supporting)
            }
            .padding(20)
        }
        .momoFlatSurface(.background)
        .alert(copy.memoryInvalidate, isPresented: $confirmsInvalidation) {
            Button(copy.cancel, role: .cancel) {}
            Button(copy.memoryInvalidate, role: .destructive) {
                Task { _ = await model.invalidate(entry) }
            }
        } message: {
            Text(copy.memoryInvalidateConfirmation)
        }
    }

    private func formatted(_ milliseconds: Int64) -> String {
        Date(timeIntervalSince1970: Double(milliseconds) / 1_000)
            .formatted(date: .abbreviated, time: .shortened)
    }
}
