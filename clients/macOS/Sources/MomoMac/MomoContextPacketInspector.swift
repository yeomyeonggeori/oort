import SwiftUI
import MomoCore

enum MomoContextPacketIDResolver {
    static func resolve(run: AgentWorkRun, messages: [Message]) -> UUID? {
        let runValues = [run.output, run.error].compactMap { $0 }
        for value in runValues {
            if let id = packetID(in: value) { return id }
        }
        for message in messages where message.runId == run.id {
            if let id = packetID(in: message.props) { return id }
        }
        return nil
    }

    private static func packetID(in json: JSON) -> UUID? {
        if let raw = json["context_packet_id"]?.stringValue
            ?? json["packet_id"]?.stringValue,
           let id = UUID(uuidString: raw.lowercased()) {
            return id
        }
        for key in ["context_packet", "context_packet_projection"] {
            if let raw = json[key]?["packet_id"]?.stringValue,
               let id = UUID(uuidString: raw.lowercased()) {
                return id
            }
        }
        return nil
    }
}

@MainActor
private final class MomoContextPacketInspectorModel: ObservableObject {
    @Published private(set) var snapshot: ContextPacketSnapshot?
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?

    private let backend: (any MemoryPlaneBackend)?
    private let workspace: WorkspaceID?
    private let packetID: UUID

    init(backend: (any MemoryPlaneBackend)?, workspace: WorkspaceID?, packetID: UUID) {
        self.backend = backend
        self.workspace = workspace
        self.packetID = packetID
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
            snapshot = try await backend.contextPacket(workspace: workspace, packet: packetID)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct MomoContextPacketInspectorView: View {
    @ObservedObject var viewModel: ChatViewModel
    @StateObject private var model: MomoContextPacketInspectorModel
    let copy: MomoWorkspaceCopy

    @Environment(\.dismiss) private var dismiss
    @State private var sourceNavigationError: String?

    init(viewModel: ChatViewModel, packetID: UUID, copy: MomoWorkspaceCopy) {
        self.viewModel = viewModel
        self.copy = copy
        _model = StateObject(
            wrappedValue: MomoContextPacketInspectorModel(
                backend: viewModel.memoryPlanePresentationBackend,
                workspace: viewModel.workspaceId,
                packetID: packetID
            )
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "shippingbox")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(MomoTheme.agentAccent)
                    .frame(width: 36, height: 36)
                    .background(MomoTheme.agentAccent.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 3) {
                    Text(copy.servedContextTitle).font(MomoTheme.Typography.screenTitle)
                    Text(copy.servedContextSubtitle)
                        .font(MomoTheme.Typography.supporting)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(copy.dismiss) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding(16)
            Divider()

            Group {
                if let snapshot = model.snapshot {
                    content(snapshot)
                } else if model.isLoading {
                    ProgressView(copy.servedContextLoading)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ContentUnavailableView {
                        Label(copy.servedContextUnavailable, systemImage: "exclamationmark.triangle")
                    } description: {
                        if let error = model.errorMessage { Text(error) }
                    } actions: {
                        Button(copy.memoryRetry) { Task { await model.load() } }
                    }
                }
            }
        }
        .frame(width: 760, height: 680)
        .task { await model.load() }
        .alert(copy.memoryOpenSource, isPresented: sourceErrorIsPresented) {
            Button(copy.dismiss, role: .cancel) {}
        } message: {
            Text(sourceNavigationError ?? copy.memorySourceUnavailable)
        }
    }

    private func content(_ snapshot: ContextPacketSnapshot) -> some View {
        let object = snapshot.content.objectValue ?? [:]
        return ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Label(
                        snapshot.expired ? copy.servedContextExpired : copy.servedContextCurrent,
                        systemImage: snapshot.expired ? "clock.badge.exclamationmark" : "checkmark.seal"
                    )
                    .font(MomoTheme.Typography.emphasizedRow)
                    .foregroundStyle(snapshot.expired ? MomoTheme.costAmber : MomoTheme.reversibleGreen)
                    Spacer()
                    Text(Date(timeIntervalSince1970: Double(snapshot.createdAtMs) / 1_000), style: .date)
                        .font(MomoTheme.Typography.supporting)
                        .foregroundStyle(.secondary)
                }

                PacketSection(title: copy.servedContextHistory, systemImage: "text.bubble") {
                    packetHistory(object["recent_messages"]?.arrayValue ?? [])
                }
                PacketSection(title: copy.servedContextMemories, systemImage: "brain.head.profile") {
                    packetMemories(object["memory_refs"]?.arrayValue ?? [])
                }
                PacketSection(title: copy.servedContextTools, systemImage: "puzzlepiece.extension") {
                    packetTools(object["tool_grants"]?.arrayValue ?? [])
                }
                PacketSection(title: copy.servedContextBudget, systemImage: "gauge.with.dots.needle.50percent") {
                    PacketKeyValueRows(object: object["budget"]?.objectValue ?? [:], copy: copy)
                }
                PacketSection(title: copy.servedContextRedactions, systemImage: "eye.slash") {
                    packetRedactions(object["redactions"]?.arrayValue ?? [])
                }
            }
            .padding(18)
        }
    }

    @ViewBuilder
    private func packetHistory(_ values: [JSON]) -> some View {
        if values.isEmpty {
            emptyRow
        } else {
            ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                let object = value.objectValue ?? [:]
                let body = object["excerpt"]?.stringValue
                    ?? object["body"]?.stringValue
                    ?? object["text"]?.stringValue
                    ?? "#\(index + 1)"
                packetRow(
                    title: body,
                    detail: object["seq"]?.intValue.map { "#\($0)" },
                    source: sourceReference(object)
                )
            }
        }
    }

    @ViewBuilder
    private func packetMemories(_ values: [JSON]) -> some View {
        if values.isEmpty {
            emptyRow
        } else {
            ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                let object = value.objectValue ?? [:]
                let detail = [object["kind"]?.stringValue, object["scope"]?.stringValue]
                    .compactMap { $0 }
                    .joined(separator: " · ")
                VStack(alignment: .leading, spacing: 8) {
                    Text(object["excerpt"]?.stringValue ?? copy.servedContextEmpty)
                        .font(MomoTheme.Typography.row)
                        .fixedSize(horizontal: false, vertical: true)
                    if !detail.isEmpty {
                        Text(detail)
                            .font(MomoTheme.Typography.supporting)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(Array((object["source_refs"]?.arrayValue ?? []).enumerated()), id: \.offset) { _, source in
                        if let reference = sourceReference(source.objectValue ?? [:]) {
                            Button {
                                Task {
                                    await viewModel.focusMessage(reference.messageId, in: reference.channelId)
                                    handleSourceNavigationResult()
                                }
                            } label: {
                                Label(copy.memoryOpenSource, systemImage: "arrow.turn.up.left")
                            }
                            .buttonStyle(.link)
                        }
                    }
                }
                .padding(10)
                .momoSurface(.panel)
            }
        }
    }

    @ViewBuilder
    private func packetTools(_ values: [JSON]) -> some View {
        if values.isEmpty {
            emptyRow
        } else {
            ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                let object = value.objectValue ?? [:]
                let name = object["tool_name"]?.stringValue ?? copy.servedContextEmpty
                let provider = object["provider"]?.stringValue
                let policy = object["approval_policy"]?.stringValue
                packetRow(
                    title: name,
                    detail: [provider, policy].compactMap { $0 }.joined(separator: " · "),
                    source: nil
                )
            }
        }
    }

    @ViewBuilder
    private func packetRedactions(_ values: [JSON]) -> some View {
        if values.isEmpty {
            emptyRow
        } else {
            ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                Text(summary(value))
                    .font(MomoTheme.Typography.row)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .momoSurface(.panel)
            }
        }
    }

    private func packetRow(
        title: String,
        detail: String?,
        source: MemorySourceReference?
    ) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(MomoTheme.Typography.row).fixedSize(horizontal: false, vertical: true)
                if let detail, !detail.isEmpty {
                    Text(detail).font(MomoTheme.Typography.supporting).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let source {
                Button {
                    Task {
                        await viewModel.focusMessage(source.messageId, in: source.channelId)
                        handleSourceNavigationResult()
                    }
                } label: {
                    Image(systemName: "arrow.turn.up.left")
                }
                .buttonStyle(.borderless)
                .help(copy.memoryOpenSource)
            }
        }
        .padding(10)
        .momoSurface(.panel)
    }

    private var emptyRow: some View {
        Text(copy.servedContextEmpty)
            .font(MomoTheme.Typography.supporting)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sourceReference(_ object: [String: JSON]) -> MemorySourceReference? {
        guard let rawMessage = object["message_id"]?.stringValue,
              let rawChannel = object["channel_id"]?.stringValue,
              let message = MessageID(uuidString: rawMessage.lowercased()),
              let channel = ChannelID(uuidString: rawChannel.lowercased()) else { return nil }
        return MemorySourceReference(messageId: message, channelId: channel)
    }

    private var sourceErrorIsPresented: Binding<Bool> {
        Binding(
            get: { sourceNavigationError != nil },
            set: { if !$0 { sourceNavigationError = nil } }
        )
    }

    private func handleSourceNavigationResult() {
        if viewModel.failedMessageFocus == nil {
            dismiss()
        } else {
            sourceNavigationError = copy.memorySourceUnavailable
        }
    }

    private func summary(_ value: JSON) -> String {
        if let string = value.stringValue { return string }
        if let object = value.objectValue {
            return object.sorted { $0.key < $1.key }
                .map { "\($0.key): \(summary($0.value))" }
                .joined(separator: " · ")
        }
        if let array = value.arrayValue { return array.map(summary).joined(separator: ", ") }
        if let integer = value.intValue { return String(integer) }
        if let number = value.doubleValue { return number.formatted() }
        if let boolean = value.boolValue { return boolean ? copy.servedContextYes : copy.servedContextNo }
        return copy.servedContextUnknownValue
    }
}

private struct PacketSection<Content: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder let content: Content

    init(title: String, systemImage: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.systemImage = systemImage
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: systemImage)
                .font(MomoTheme.Typography.sectionHeader)
            content
        }
    }
}

private struct PacketKeyValueRows: View {
    let object: [String: JSON]
    let copy: MomoWorkspaceCopy

    var body: some View {
        if object.isEmpty {
            Text(copy.servedContextEmpty)
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(.secondary)
        } else {
            VStack(spacing: 0) {
                ForEach(object.keys.sorted(), id: \.self) { key in
                    LabeledContent(label(key)) {
                        Text(value(object[key] ?? .null))
                            .font(MomoTheme.Typography.supporting.monospacedDigit())
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, 6)
                    if key != object.keys.sorted().last { Divider().opacity(0.5) }
                }
            }
            .padding(.horizontal, 10)
            .momoSurface(.panel)
        }
    }

    private func label(_ key: String) -> String {
        key.replacingOccurrences(of: "_tokens", with: "")
            .replacingOccurrences(of: "_micro_usd", with: "")
            .replacingOccurrences(of: "_", with: " ")
            .capitalized
    }

    private func value(_ json: JSON) -> String {
        if let string = json.stringValue { return string }
        if let integer = json.intValue { return integer.formatted() }
        if let number = json.doubleValue { return number.formatted() }
        if let boolean = json.boolValue { return boolean ? copy.servedContextYes : copy.servedContextNo }
        if let array = json.arrayValue { return array.map(value).joined(separator: ", ") }
        return copy.servedContextUnknownValue
    }
}
