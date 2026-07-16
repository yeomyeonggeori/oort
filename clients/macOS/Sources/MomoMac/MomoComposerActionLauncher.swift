import AppKit
import SwiftUI
import UniformTypeIdentifiers

enum MomoComposerAction: String, CaseIterable, Identifiable, Sendable {
    case fileUpload
    case startWork
    case createThread
    case createPoll
    case addPlugin

    var id: String { rawValue }
}

enum MomoComposerDraftSheet: String, Identifiable, Sendable {
    case thread
    case poll
    case plugins

    var id: String { rawValue }
}

struct MomoAttachmentDraft: Identifiable, Equatable, Sendable {
    let id: String
    let url: URL
    let name: String
    let byteCount: Int64?
    let systemImage: String

    init(url: URL) {
        let normalizedURL = url.standardizedFileURL
        let values = try? normalizedURL.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
        id = normalizedURL.path
        self.url = normalizedURL
        name = normalizedURL.lastPathComponent
        byteCount = values?.fileSize.map(Int64.init)
        systemImage = Self.systemImage(for: values?.contentType)
    }

    private static func systemImage(for type: UTType?) -> String {
        guard let type else { return "doc" }
        if type.conforms(to: .image) { return "photo" }
        if type.conforms(to: .movie) { return "film" }
        if type.conforms(to: .audio) { return "waveform" }
        if type.conforms(to: .pdf) { return "doc.richtext" }
        if type.conforms(to: .archive) { return "archivebox" }
        return "doc"
    }
}

enum MomoAttachmentDraftCollection {
    static func merging(
        _ existing: [MomoAttachmentDraft],
        urls: [URL]
    ) -> [MomoAttachmentDraft] {
        var seen = Set(existing.map(\.id))
        var merged = existing
        for draft in urls.filter(\.isFileURL).map(MomoAttachmentDraft.init(url:)) {
            guard seen.insert(draft.id).inserted else { continue }
            merged.append(draft)
        }
        return merged
    }
}

struct MomoComposerActionCopy {
    let language: MomoUILanguage

    var launcher: String {
        language == .korean ? "추가 기능" : "Add"
    }

    var launcherHelp: String {
        language == .korean ? "파일, 작업, 스레드, 투표 또는 플러그인 추가" : "Add a file, work item, thread, poll, or plugin"
    }

    func title(for action: MomoComposerAction) -> String {
        switch (language, action) {
        case (.korean, .fileUpload): return "파일 업로드"
        case (.korean, .startWork): return "새 작업 시작"
        case (.korean, .createThread): return "스레드 만들기"
        case (.korean, .createPoll): return "투표 만들기"
        case (.korean, .addPlugin): return "플러그인 추가"
        case (.english, .fileUpload): return "Upload file"
        case (.english, .startWork): return "Start new work"
        case (.english, .createThread): return "Create thread"
        case (.english, .createPoll): return "Create poll"
        case (.english, .addPlugin): return "Add plugin"
        }
    }

    func subtitle(for action: MomoComposerAction) -> String {
        switch (language, action) {
        case (.korean, .fileUpload): return "이 대화에 첨부할 파일을 선택합니다"
        case (.korean, .startWork): return "에이전트에게 맡길 작업을 구성합니다"
        case (.korean, .createThread): return "대화에서 이어갈 스레드 초안을 만듭니다"
        case (.korean, .createPoll): return "질문과 선택지를 준비합니다"
        case (.korean, .addPlugin): return "이 채널에서 사용할 도구를 찾습니다"
        case (.english, .fileUpload): return "Choose files to attach to this conversation"
        case (.english, .startWork): return "Prepare work for an agent"
        case (.english, .createThread): return "Draft a focused thread from this conversation"
        case (.english, .createPoll): return "Prepare a question and choices"
        case (.english, .addPlugin): return "Find tools for this channel"
        }
    }

    func systemImage(for action: MomoComposerAction) -> String {
        switch action {
        case .fileUpload: return "doc.badge.arrow.up"
        case .startWork: return "hammer"
        case .createThread: return "text.bubble"
        case .createPoll: return "chart.bar.xaxis"
        case .addPlugin: return "puzzlepiece.extension"
        }
    }

    var uploadPending: String {
        language == .korean ? "업로드 연결 대기" : "Waiting for upload connection"
    }

    var uploadPendingDetail: String {
        language == .korean
            ? "파일은 이 Mac의 메시지 초안에만 추가됐습니다. 전송 기능이 연결되기 전에는 서버에 올라가지 않습니다."
            : "Files are attached only to this local message draft. They are not uploaded until file transfer is connected."
    }

    var removeAttachment: String {
        language == .korean ? "첨부 제거" : "Remove attachment"
    }

    var clearAttachments: String {
        language == .korean ? "모두 제거" : "Remove all"
    }

    var dropTitle: String {
        language == .korean ? "파일을 놓아 메시지 초안에 추가" : "Drop files to add them to the message draft"
    }

    var threadTitle: String { language == .korean ? "스레드 초안" : "Thread draft" }
    var threadPrompt: String { language == .korean ? "스레드에서 이어갈 주제" : "Topic to continue in the thread" }
    var pollTitle: String { language == .korean ? "투표 초안" : "Poll draft" }
    var pollQuestion: String { language == .korean ? "질문" : "Question" }
    var pollOption: String { language == .korean ? "선택지" : "Option" }
    var pluginTitle: String { language == .korean ? "플러그인 찾기" : "Find plugins" }
    var draftBoundary: String {
        language == .korean
            ? "이 화면은 로컬 초안입니다. 서버 전송과 설치는 엔진 연결 후 활성화됩니다."
            : "This is a local draft. Server delivery and installation become available after the engine is connected."
    }
    var keepDraft: String { language == .korean ? "초안 보관" : "Keep draft" }
    var close: String { language == .korean ? "닫기" : "Close" }
    var pluginReady: String { language == .korean ? "연결 준비" : "Prepare connection" }
    var selected: String { language == .korean ? "선택됨" : "Selected" }
}

struct MomoComposerActionLauncher: View {
    let copy: MomoComposerActionCopy
    let select: (MomoComposerAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(MomoComposerAction.allCases) { action in
                Button {
                    select(action)
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: copy.systemImage(for: action))
                            .frame(width: 24)
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(copy.title(for: action))
                                .font(.body.weight(.medium))
                            Text(copy.subtitle(for: action))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        Spacer(minLength: 8)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(8)
        .frame(width: 320)
        .momoSurface(.card)
    }
}

struct MomoAttachmentDraftStrip: View {
    let drafts: [MomoAttachmentDraft]
    let copy: MomoComposerActionCopy
    let remove: (MomoAttachmentDraft.ID) -> Void
    let removeAll: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Label(copy.uploadPending, systemImage: "clock.badge.exclamationmark")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button(copy.clearAttachments, action: removeAll)
                    .buttonStyle(.plain)
                    .font(.caption)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(drafts) { draft in
                        HStack(spacing: 8) {
                            Image(systemName: draft.systemImage)
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(draft.name)
                                    .font(.callout.weight(.medium))
                                    .lineLimit(1)
                                if let byteCount = draft.byteCount {
                                    Text(ByteCountFormatter.string(fromByteCount: byteCount, countStyle: .file))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Button {
                                remove(draft.id)
                            } label: {
                                Label(copy.removeAttachment, systemImage: "xmark")
                                    .labelStyle(.iconOnly)
                            }
                            .buttonStyle(.plain)
                            .help(copy.removeAttachment)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(
                            cornerRadius: MomoTheme.cornerMedium,
                            style: .continuous
                        ))
                        .overlay {
                            RoundedRectangle(cornerRadius: MomoTheme.cornerMedium, style: .continuous)
                                .stroke(MomoTheme.subtleBorder, lineWidth: 1)
                        }
                    }
                }
            }

            Text(copy.uploadPendingDetail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .momoSurface(.panel, cornerRadius: MomoTheme.cornerMedium)
    }
}

struct MomoFileDropOverlay: View {
    let copy: MomoComposerActionCopy

    var body: some View {
        Label(copy.dropTitle, systemImage: "doc.badge.arrow.up")
            .font(.headline)
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
            .momoSurface(.card)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

struct MomoLocalDraftSheet: View {
    let kind: MomoComposerDraftSheet
    let copy: MomoComposerActionCopy
    @Binding var threadTopic: String
    @Binding var pollQuestion: String
    @Binding var pollOptions: [String]
    @Binding var selectedPlugins: Set<String>
    @Environment(\.dismiss) private var dismiss

    private let plugins = ["Google Drive", "Google Calendar", "Gmail", "GitHub", "Notion"]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: headerIcon)
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text(headerTitle)
                        .font(.title3.weight(.semibold))
                    Text(copy.draftBoundary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Label(copy.close, systemImage: "xmark")
                        .labelStyle(.iconOnly)
                }
                .keyboardShortcut(.cancelAction)
                .help(copy.close)
            }
            .padding(24)

            Divider()

            Group {
                switch kind {
                case .thread:
                    Form {
                        TextField(copy.threadPrompt, text: $threadTopic, axis: .vertical)
                            .lineLimit(3...6)
                    }
                    .formStyle(.grouped)
                case .poll:
                    Form {
                        TextField(copy.pollQuestion, text: $pollQuestion)
                        ForEach(pollOptions.indices, id: \.self) { index in
                            TextField("\(copy.pollOption) \(index + 1)", text: $pollOptions[index])
                        }
                    }
                    .formStyle(.grouped)
                case .plugins:
                    List(plugins, id: \.self) { plugin in
                        HStack(spacing: 12) {
                            Image(systemName: pluginIcon(plugin))
                                .frame(width: 24)
                                .foregroundStyle(.secondary)
                            Text(plugin)
                                .font(.body)
                            Spacer()
                            Button(selectedPlugins.contains(plugin) ? copy.selected : copy.pluginReady) {
                                if selectedPlugins.contains(plugin) {
                                    selectedPlugins.remove(plugin)
                                } else {
                                    selectedPlugins.insert(plugin)
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }

            Divider()

            HStack {
                Text(copy.draftBoundary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(copy.keepDraft) { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(24)
        }
        .frame(minWidth: 520, minHeight: 420)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var headerTitle: String {
        switch kind {
        case .thread: return copy.threadTitle
        case .poll: return copy.pollTitle
        case .plugins: return copy.pluginTitle
        }
    }

    private var headerIcon: String {
        switch kind {
        case .thread: return "text.bubble"
        case .poll: return "chart.bar.xaxis"
        case .plugins: return "puzzlepiece.extension"
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
