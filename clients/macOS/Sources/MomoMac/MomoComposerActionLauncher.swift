import SwiftUI
import UniformTypeIdentifiers

enum MomoComposerAction: String, CaseIterable, Identifiable {
    case fileUpload
    case startWork
    case createThread
    case createPoll
    case addPlugin

    var id: String { rawValue }

    var systemImage: String {
        switch self {
        case .fileUpload: return "document.badge.plus"
        case .startWork: return "play.rectangle.on.rectangle"
        case .createThread: return "text.bubble"
        case .createPoll: return "chart.bar.xaxis"
        case .addPlugin: return "puzzlepiece.extension"
        }
    }
}

enum MomoComposerDraftSheet: String, Identifiable {
    case thread
    case poll
    case plugins

    var id: String { rawValue }
}

struct MomoAttachmentDraft: Identifiable, Equatable {
    let url: URL
    let byteCount: Int64?

    var id: URL { url.standardizedFileURL }
    var name: String { url.lastPathComponent }

    var systemImage: String {
        guard let type = UTType(filenameExtension: url.pathExtension) else { return "doc" }
        if type.conforms(to: .image) { return "photo" }
        if type.conforms(to: .movie) { return "video" }
        if type.conforms(to: .audio) { return "waveform" }
        if type.conforms(to: .pdf) { return "doc.richtext" }
        if type.conforms(to: .archive) { return "archivebox" }
        return "doc"
    }

    init(url: URL) {
        self.url = url.standardizedFileURL
        let values = try? url.resourceValues(forKeys: [.fileSizeKey])
        self.byteCount = values?.fileSize.map(Int64.init)
    }
}

enum MomoAttachmentDraftCollection {
    static func merging(
        _ existing: [MomoAttachmentDraft],
        urls: [URL]
    ) -> [MomoAttachmentDraft] {
        var result = existing
        var identifiers = Set(existing.map(\.id))
        for url in urls where url.isFileURL {
            let draft = MomoAttachmentDraft(url: url)
            if identifiers.insert(draft.id).inserted {
                result.append(draft)
            }
        }
        return result
    }
}

struct MomoComposerActionCopy {
    let language: MomoUILanguage

    var launcherTitle: String { localized("추가", "Add") }
    var fileUpload: String { localized("파일 업로드", "Upload file") }
    var fileUploadDetail: String { localized("이미지, 문서 또는 영상을 첨부합니다", "Attach an image, document, or video") }
    var startWork: String { localized("새 작업 시작", "Start new work") }
    var startWorkDetail: String { localized("에이전트에게 실행할 일을 맡깁니다", "Delegate a task to an agent") }
    var createThread: String { localized("스레드 만들기", "Create thread") }
    var createThreadDetail: String { localized("대화 주제를 로컬 초안으로 준비합니다", "Prepare a local conversation draft") }
    var createPoll: String { localized("투표 만들기", "Create poll") }
    var createPollDetail: String { localized("질문과 선택지를 먼저 작성합니다", "Draft a question and its options") }
    var addPlugin: String { localized("플러그인 추가", "Add plugin") }
    var addPluginDetail: String { localized("사용 가능한 업무 도구를 둘러봅니다", "Browse available work tools") }
    var localDraft: String { localized("로컬 초안", "Local draft") }
    var connectionPending: String { localized("연결 준비 후 채널에 공유할 수 있습니다", "Share this in the channel when its connection is ready") }
    var remove: String { localized("첨부 제거", "Remove attachment") }
    var clearAll: String { localized("모두 지우기", "Clear all") }
    var threadTitle: String { localized("새 스레드", "New thread") }
    var threadPrompt: String { localized("어떤 주제로 대화를 이어갈까요?", "What should this conversation be about?") }
    var threadPlaceholder: String { localized("스레드 주제", "Thread topic") }
    var pollTitle: String { localized("새 투표", "New poll") }
    var pollQuestion: String { localized("질문", "Question") }
    var pollOption: String { localized("선택지", "Option") }
    var pluginTitle: String { localized("플러그인 둘러보기", "Browse plugins") }
    var pluginSubtitle: String { localized("설치 경험을 미리 확인하세요. 실제 연결은 엔진 준비 후 활성화됩니다.", "Preview the install experience. Connections activate when the engine is ready.") }
    var selected: String { localized("선택됨", "Selected") }
    var select: String { localized("선택", "Select") }
    var done: String { localized("완료", "Done") }

    func title(for action: MomoComposerAction) -> String {
        switch action {
        case .fileUpload: return fileUpload
        case .startWork: return startWork
        case .createThread: return createThread
        case .createPoll: return createPoll
        case .addPlugin: return addPlugin
        }
    }

    func detail(for action: MomoComposerAction) -> String {
        switch action {
        case .fileUpload: return fileUploadDetail
        case .startWork: return startWorkDetail
        case .createThread: return createThreadDetail
        case .createPoll: return createPollDetail
        case .addPlugin: return addPluginDetail
        }
    }

    private func localized(_ korean: String, _ english: String) -> String {
        language == .korean ? korean : english
    }
}

struct MomoComposerActionLauncher: View {
    let copy: MomoComposerActionCopy
    let onSelect: (MomoComposerAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: MomoTheme.ComposerAction.compactSpacing) {
            Text(copy.launcherTitle)
                .font(MomoTheme.Typography.sectionHeader)
                .padding(.horizontal, MomoTheme.ComposerAction.contentSpacing)
                .padding(.top, MomoTheme.ComposerAction.standardSpacing)

            ForEach(MomoComposerAction.allCases) { action in
                Button {
                    onSelect(action)
                } label: {
                    HStack(spacing: MomoTheme.ComposerAction.contentSpacing) {
                        Image(systemName: action.systemImage)
                            .font(.title3)
                            .frame(width: MomoTheme.ComposerAction.iconSize)
                            .foregroundStyle(action == .startWork ? MomoTheme.agentAccent : .secondary)
                        VStack(alignment: .leading, spacing: MomoTheme.ComposerAction.compactSpacing) {
                            Text(copy.title(for: action))
                                .font(MomoTheme.Typography.emphasizedRow)
                                .foregroundStyle(.primary)
                            Text(copy.detail(for: action))
                                .font(MomoTheme.Typography.supporting)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                    .padding(.horizontal, MomoTheme.ComposerAction.contentSpacing)
                    .frame(minHeight: MomoTheme.ComposerAction.rowMinimumHeight)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copy.title(for: action))
                .accessibilityHint(copy.detail(for: action))
            }
        }
        .padding(.vertical, MomoTheme.ComposerAction.standardSpacing)
        .frame(width: MomoTheme.ComposerAction.launcherWidth)
    }
}

struct MomoAttachmentDraftStrip: View {
    let drafts: [MomoAttachmentDraft]
    let copy: MomoComposerActionCopy
    let onRemove: (MomoAttachmentDraft) -> Void
    let onClear: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: MomoTheme.ComposerAction.standardSpacing) {
            HStack {
                Label(copy.localDraft, systemImage: "paperclip")
                    .font(MomoTheme.Typography.supporting.weight(.medium))
                Spacer()
                Button(copy.clearAll, action: onClear)
                    .buttonStyle(.link)
            }
            ScrollView(.horizontal) {
                HStack(spacing: MomoTheme.ComposerAction.standardSpacing) {
                    ForEach(drafts) { draft in
                        attachmentChip(draft)
                    }
                }
            }
            .scrollIndicators(.hidden)
            Label(copy.connectionPending, systemImage: "info.circle")
                .font(MomoTheme.Typography.metadata)
                .foregroundStyle(.secondary)
        }
        .padding(MomoTheme.ComposerAction.contentSpacing)
        .momoSurface(.panel, cornerRadius: MomoTheme.cornerMedium)
    }

    private func attachmentChip(_ draft: MomoAttachmentDraft) -> some View {
        HStack(spacing: MomoTheme.ComposerAction.standardSpacing) {
            Image(systemName: draft.systemImage)
                .font(.title3)
                .foregroundStyle(MomoTheme.humanAccent)
            VStack(alignment: .leading, spacing: MomoTheme.ComposerAction.compactSpacing) {
                Text(draft.name)
                    .font(MomoTheme.Typography.supporting.weight(.medium))
                    .lineLimit(1)
                Text(detail(for: draft))
                    .font(MomoTheme.Typography.metadata)
                    .foregroundStyle(.secondary)
            }
            Button {
                onRemove(draft)
            } label: {
                Label(copy.remove, systemImage: "xmark")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .accessibilityLabel(copy.remove)
        }
        .padding(MomoTheme.ComposerAction.standardSpacing)
        .frame(width: MomoTheme.ComposerAction.attachmentWidth)
        .momoSurface(.card, cornerRadius: MomoTheme.cornerSmall)
    }

    private func detail(for draft: MomoAttachmentDraft) -> String {
        guard let byteCount = draft.byteCount else { return copy.localDraft }
        return ByteCountFormatter.string(fromByteCount: byteCount, countStyle: .file)
    }
}

struct MomoFileDropOverlay: View {
    let copy: MomoComposerActionCopy

    var body: some View {
        VStack(spacing: MomoTheme.ComposerAction.contentSpacing) {
            Image(systemName: "arrow.down.doc.fill")
                .font(.largeTitle)
                .foregroundStyle(MomoTheme.humanAccent)
            Text(copy.fileUpload)
                .font(MomoTheme.Typography.screenTitle)
            Text(copy.fileUploadDetail)
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(.secondary)
        }
        .padding(MomoTheme.ComposerAction.dropInset)
        .momoSurface(.card, cornerRadius: MomoTheme.cornerLarge)
        .overlay {
            RoundedRectangle(cornerRadius: MomoTheme.cornerLarge, style: .continuous)
                .stroke(MomoTheme.humanAccent, style: StrokeStyle(lineWidth: 2, dash: [8]))
        }
        .padding(MomoTheme.ComposerAction.dropInset)
        .allowsHitTesting(false)
    }
}

struct MomoLocalDraftSheet: View {
    let sheet: MomoComposerDraftSheet
    let copy: MomoComposerActionCopy
    @Binding var threadTopic: String
    @Binding var pollQuestion: String
    @Binding var pollOptions: [String]
    @Binding var selectedPlugins: Set<String>
    @Environment(\.dismiss) private var dismiss

    private let plugins = ["Google Drive", "Google Calendar", "Gmail", "GitHub", "Notion"]

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(title, systemImage: icon)
                    .font(MomoTheme.Typography.screenTitle)
                Spacer()
                Button(copy.done) { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(MomoTheme.ComposerAction.sheetInset)
            Divider()
            content
                .padding(MomoTheme.ComposerAction.sheetInset)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(
            minWidth: MomoTheme.ComposerAction.sheetMinimumWidth,
            minHeight: MomoTheme.ComposerAction.sheetMinimumHeight
        )
        .momoSurface(.background, cornerRadius: 0)
    }

    @ViewBuilder
    private var content: some View {
        switch sheet {
        case .thread:
            Form {
                Section(copy.threadPrompt) {
                    TextField(copy.threadPlaceholder, text: $threadTopic)
                }
                Section { connectionNote }
            }
            .formStyle(.grouped)
        case .poll:
            Form {
                TextField(copy.pollQuestion, text: $pollQuestion)
                ForEach(pollOptions.indices, id: \.self) { index in
                    TextField("\(copy.pollOption) \(index + 1)", text: $pollOptions[index])
                }
                Section { connectionNote }
            }
            .formStyle(.grouped)
        case .plugins:
            VStack(alignment: .leading, spacing: MomoTheme.ComposerAction.sectionSpacing) {
                Text(copy.pluginSubtitle)
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
                ForEach(plugins, id: \.self) { plugin in
                    HStack {
                        Image(systemName: pluginIcon(plugin))
                            .font(.title3)
                            .frame(width: MomoTheme.ComposerAction.iconSize)
                        Text(plugin).font(MomoTheme.Typography.row)
                        Spacer()
                        Button(selectedPlugins.contains(plugin) ? copy.selected : copy.select) {
                            if selectedPlugins.contains(plugin) {
                                selectedPlugins.remove(plugin)
                            } else {
                                selectedPlugins.insert(plugin)
                            }
                        }
                        .buttonStyle(.bordered)
                    }
                    .frame(minHeight: MomoTheme.ComposerAction.rowMinimumHeight)
                }
                connectionNote
            }
        }
    }

    private var connectionNote: some View {
        Label(copy.connectionPending, systemImage: "info.circle")
            .font(MomoTheme.Typography.supporting)
            .foregroundStyle(.secondary)
    }

    private var title: String {
        switch sheet {
        case .thread: return copy.threadTitle
        case .poll: return copy.pollTitle
        case .plugins: return copy.pluginTitle
        }
    }

    private var icon: String {
        switch sheet {
        case .thread: return MomoComposerAction.createThread.systemImage
        case .poll: return MomoComposerAction.createPoll.systemImage
        case .plugins: return MomoComposerAction.addPlugin.systemImage
        }
    }

    private func pluginIcon(_ plugin: String) -> String {
        switch plugin {
        case "Google Drive": return "externaldrive"
        case "Google Calendar": return "calendar"
        case "Gmail": return "envelope"
        case "GitHub": return "chevron.left.forwardslash.chevron.right"
        default: return "doc.text"
        }
    }
}
