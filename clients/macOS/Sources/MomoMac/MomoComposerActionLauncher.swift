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

enum MomoPluginCatalogFilter: String, CaseIterable, Identifiable {
    case recommended
    case installed
    case custom

    var id: String { rawValue }
}

struct MomoPluginCatalogItem: Identifiable, Hashable {
    enum Category: String, CaseIterable {
        case featured
        case productivity
        case knowledge
        case developer
    }

    let id: String
    let name: String
    let systemImage: String
    let category: Category
    let isFeatured: Bool
    let koreanSummary: String
    let englishSummary: String
    let koreanCapabilities: [String]
    let englishCapabilities: [String]

    func capabilities(for language: MomoUILanguage) -> [String] {
        language == .korean ? koreanCapabilities : englishCapabilities
    }

    static let recommended: [MomoPluginCatalogItem] = [
        .init(id: "google-drive", name: "Google Drive", systemImage: "externaldrive", category: .featured, isFeatured: true, koreanSummary: "문서를 찾고 결과물을 저장하거나 링크로 공유합니다.", englishSummary: "Find documents, save deliverables, and share links.", koreanCapabilities: ["검색", "업로드", "공유"], englishCapabilities: ["Search", "Upload", "Share"]),
        .init(id: "google-calendar", name: "Google Calendar", systemImage: "calendar", category: .productivity, isFeatured: true, koreanSummary: "일정을 확인하고 승인 후 새 일정을 만듭니다.", englishSummary: "Check schedules and create events after approval.", koreanCapabilities: ["일정 조회", "일정 생성"], englishCapabilities: ["Read events", "Create events"]),
        .init(id: "gmail", name: "Gmail", systemImage: "envelope", category: .productivity, isFeatured: false, koreanSummary: "메일과 스레드를 찾고 승인 가능한 초안을 준비합니다.", englishSummary: "Find mail and prepare approval-ready drafts.", koreanCapabilities: ["메일 검색", "초안"], englishCapabilities: ["Search mail", "Draft"]),
        .init(id: "github", name: "GitHub", systemImage: "chevron.left.forwardslash.chevron.right", category: .developer, isFeatured: true, koreanSummary: "이슈, PR, 코드 변경 상태를 채널에서 다룹니다.", englishSummary: "Work with issues, pull requests, and code activity.", koreanCapabilities: ["이슈", "PR", "코드"], englishCapabilities: ["Issues", "PRs", "Code"]),
        .init(id: "notion", name: "Notion", systemImage: "doc.text", category: .knowledge, isFeatured: true, koreanSummary: "팀 문서를 검색하고 새 문서 초안을 만듭니다.", englishSummary: "Search team knowledge and draft new pages.", koreanCapabilities: ["문서 검색", "문서 초안"], englishCapabilities: ["Search pages", "Draft pages"]),
    ]
}

struct MomoAttachmentDraft: Identifiable, Equatable {
    let url: URL

    var id: URL { url.resolvingSymlinksInPath().standardizedFileURL }
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
        self.url = url.resolvingSymlinksInPath().standardizedFileURL
    }
}

enum MomoAttachmentDraftCollection {
    static func merging(
        _ existing: [MomoAttachmentDraft],
        urls: [URL]
    ) -> [MomoAttachmentDraft] {
        var result = existing
        var identifiers = Set(existing.map(\.id))
        for url in urls where url.isFileURL && !url.hasDirectoryPath {
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
    var fileUpload: String { localized("파일 첨부", "Attach files") }
    var fileUploadDetail: String { localized("이미지, 문서 또는 영상을 로컬 초안에 담습니다", "Add images, documents, or videos to a local draft") }
    var startWork: String { localized("새 작업 시작", "Start new work") }
    var startWorkDetail: String { localized("에이전트에게 실행할 일을 맡깁니다", "Delegate a task to an agent") }
    var createThread: String { localized("스레드 초안", "Thread draft") }
    var createThreadDetail: String { localized("대화 주제를 로컬 초안으로 준비합니다", "Prepare a local conversation draft") }
    var createPoll: String { localized("투표 초안", "Poll draft") }
    var createPollDetail: String { localized("질문과 선택지를 먼저 작성합니다", "Draft a question and its options") }
    var addPlugin: String { localized("플러그인 둘러보기", "Browse plugins") }
    var addPluginDetail: String { localized("연결 전 업무 도구와 권한 화면을 미리 봅니다", "Preview work tools and permissions before connecting") }
    var localDraft: String { localized("로컬 초안", "Local draft") }
    var localOnlyStatus: String { localized("로컬 전용 · 전송 안 됨", "Local only · not sent") }
    var connectionPending: String { localized("이 기기의 로컬 미리보기입니다. 아직 채널에 저장되거나 전송되지 않습니다.", "This is a local preview on this Mac. It is not saved or sent to the channel yet.") }
    var remove: String { localized("첨부 제거", "Remove attachment") }
    func removeAttachment(_ filename: String) -> String { localized("\(filename) 첨부 제거", "Remove attachment \(filename)") }
    var clearAll: String { localized("모두 지우기", "Clear all") }
    var threadTitle: String { localized("새 스레드", "New thread") }
    var threadPrompt: String { localized("어떤 주제로 대화를 이어갈까요?", "What should this conversation be about?") }
    var threadPlaceholder: String { localized("스레드 주제", "Thread topic") }
    var pollTitle: String { localized("새 투표", "New poll") }
    var pollQuestion: String { localized("질문", "Question") }
    var pollOption: String { localized("선택지", "Option") }
    var pluginTitle: String { localized("플러그인 둘러보기", "Browse plugins") }
    var pluginSubtitle: String { localized("워크스페이스에서 사용할 도구를 고르고 필요한 권한을 미리 확인하세요.", "Choose tools for this workspace and review the permissions they need.") }
    var selected: String { localized("선택됨", "Selected") }
    var select: String { localized("선택", "Select") }
    var deselect: String { localized("선택 해제", "Deselect") }
    var install: String { localized("이 Mac에서 선택", "Select on this Mac") }
    var installed: String { localized("선택됨", "Selected") }
    var recommended: String { localized("추천", "Recommended") }
    var custom: String { localized("커스텀", "Custom") }
    var pluginSearch: String { localized("플러그인 검색", "Search plugins") }
    var customPluginTitle: String { localized("커스텀 플러그인", "Custom plugin") }
    var customPluginDetail: String { localized("커스텀 플러그인 연결은 준비 중입니다. 연결 가능한 항목이 생기면 이 화면에서 추가할 수 있습니다.", "Custom plugin connections are coming later. Available connections will appear here.") }
    var pluginFilterLabel: String { localized("플러그인 보기", "Plugin view") }
    var closePreview: String { localized("미리보기 닫기", "Close preview") }
    var draftSummaryTitle: String { localized("작성 중인 로컬 초안", "Local drafts in progress") }
    var threadDraftLabel: String { localized("스레드", "Thread") }
    var pollDraftLabel: String { localized("투표", "Poll") }
    var pluginDraftLabel: String { localized("플러그인", "Plugins") }

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
                        if action == .startWork {
                            Text("⇧⌘W")
                                .font(MomoTheme.Typography.metadata.monospacedDigit())
                                .foregroundStyle(.tertiary)
                                .accessibilityHidden(true)
                        }
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
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .help(draft.name)
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
            .accessibilityLabel(copy.removeAttachment(draft.name))
        }
        .padding(MomoTheme.ComposerAction.standardSpacing)
        .frame(width: MomoTheme.ComposerAction.attachmentWidth)
        .momoSurface(.card, cornerRadius: MomoTheme.cornerSmall)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(draft.name)
    }

    private func detail(for draft: MomoAttachmentDraft) -> String {
        copy.localOnlyStatus
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
    @State private var pluginFilter = MomoPluginCatalogFilter.recommended
    @State private var pluginQuery = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(title, systemImage: icon)
                    .font(MomoTheme.Typography.screenTitle)
                Spacer()
                Button(copy.closePreview) { dismiss() }
                    .keyboardShortcut(.cancelAction)
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
            pluginCatalog
        }
    }

    private var pluginCatalog: some View {
        VStack(alignment: .leading, spacing: MomoTheme.ComposerAction.sectionSpacing) {
            Text(copy.pluginSubtitle)
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(.secondary)

            HStack(spacing: MomoTheme.ComposerAction.contentSpacing) {
                HStack(spacing: MomoTheme.ComposerAction.standardSpacing) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField(copy.pluginSearch, text: $pluginQuery).textFieldStyle(.plain)
                }
                .padding(MomoTheme.ComposerAction.standardSpacing)
                .background(
                    .primary.opacity(0.05),
                    in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall, style: .continuous)
                )

                Picker("", selection: $pluginFilter) {
                    Text(copy.recommended).tag(MomoPluginCatalogFilter.recommended)
                    Text(copy.installed).tag(MomoPluginCatalogFilter.installed)
                    Text(copy.custom).tag(MomoPluginCatalogFilter.custom)
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .accessibilityLabel(copy.pluginFilterLabel)
            }

            if pluginFilter == .custom {
                pluginEmptyState(
                    title: copy.customPluginTitle,
                    detail: copy.customPluginDetail,
                    systemImage: "shippingbox"
                )
            } else if visiblePlugins.isEmpty {
                pluginEmptyState(
                    title: pluginEmptyTitle,
                    detail: pluginEmptyDetail,
                    systemImage: "puzzlepiece.extension"
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(visiblePlugins) { plugin in
                            pluginRow(plugin)
                            if plugin.id != visiblePlugins.last?.id { Divider() }
                        }
                    }
                }
            }
            connectionNote
        }
    }

    private func pluginEmptyState(title: String, detail: String, systemImage: String) -> some View {
        VStack(alignment: .leading, spacing: MomoTheme.ComposerAction.standardSpacing) {
            Label(title, systemImage: systemImage)
                .font(MomoTheme.Typography.emphasizedRow)
            Text(detail)
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: MomoTheme.QuickSwitcher.resultsMinimumHeight, alignment: .topLeading)
        .padding(.top, MomoTheme.ComposerAction.contentSpacing)
    }

    private var visiblePlugins: [MomoPluginCatalogItem] {
        MomoPluginCatalogItem.recommended.filter { plugin in
            let matchesFilter = pluginFilter == .recommended || selectedPlugins.contains(plugin.id)
            let query = pluginQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            let matchesQuery = query.isEmpty
                || plugin.name.localizedCaseInsensitiveContains(query)
                || plugin.capabilities(for: copy.language).contains { $0.localizedCaseInsensitiveContains(query) }
            return matchesFilter && matchesQuery
        }
    }

    private var pluginEmptyTitle: String {
        if !pluginQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return copy.language == .korean ? "검색 결과가 없습니다" : "No plugins found"
        }
        return copy.language == .korean ? "설치한 플러그인이 없습니다" : "No installed plugins"
    }

    private var pluginEmptyDetail: String {
        if !pluginQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return copy.language == .korean ? "다른 이름이나 기능으로 검색해보세요." : "Try another name or capability."
        }
        return copy.language == .korean ? "추천 탭에서 사용할 플러그인을 선택하세요." : "Choose a plugin from Recommended."
    }

    private func pluginRow(_ plugin: MomoPluginCatalogItem) -> some View {
        let isInstalled = selectedPlugins.contains(plugin.id)
        return HStack(alignment: .center, spacing: MomoTheme.ComposerAction.contentSpacing) {
                Image(systemName: plugin.systemImage)
                    .font(.title2)
                    .frame(width: 40, height: 40)
                    .background(
                        .primary.opacity(0.06),
                        in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall, style: .continuous)
                    )
                VStack(alignment: .leading, spacing: MomoTheme.ComposerAction.compactSpacing) {
                    Text(plugin.name).font(MomoTheme.Typography.emphasizedRow)
                    Text(copy.language == .korean ? plugin.koreanSummary : plugin.englishSummary)
                        .font(MomoTheme.Typography.supporting)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Text(plugin.capabilities(for: copy.language).joined(separator: " · "))
                        .font(MomoTheme.Typography.metadata)
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                if isInstalled {
                    Button(copy.deselect) {
                        selectedPlugins.remove(plugin.id)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityLabel("\(copy.deselect) \(plugin.name)")
                } else {
                    Button(copy.install) {
                        selectedPlugins.insert(plugin.id)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .accessibilityLabel("\(copy.install) \(plugin.name)")
                }
        }
        .padding(.vertical, MomoTheme.ComposerAction.contentSpacing)
        .contentShape(Rectangle())
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

}
