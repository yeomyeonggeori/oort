import SwiftUI
import MomoCore

enum MomoPluginMarketplaceControlLayout {
    static let searchMinimumWidth = MomoTheme.PluginMarketplace.scopePickerWidth
    static let refreshMinimumSize = MomoTheme.MessageInteraction.actionMinimumSize

    static var wideMinimumContentWidth: CGFloat {
        searchMinimumWidth
            + MomoTheme.PluginMarketplace.contentSpacing
            + MomoTheme.PluginMarketplace.gridMinimumWidth
            + MomoTheme.PluginMarketplace.contentSpacing
            + refreshMinimumSize
    }

    static var compactMinimumContentWidth: CGFloat {
        searchMinimumWidth
            + MomoTheme.PluginMarketplace.contentSpacing
            + refreshMinimumSize
    }
}

struct MomoPluginMarketplaceView: View {
    @Environment(\.momoCenterHeaderLeadingInset) private var centerHeaderLeadingInset

    private enum CatalogFilter: String, CaseIterable, Identifiable {
        case all
        case installed
        case granted

        var id: String { rawValue }
    }

    let language: MomoUILanguage
    let serverIdentity: String?
    let workspaceID: WorkspaceID?
    let memberID: MemberID?
    let apiContext: MomoInviteAdminContext?
    let canManageWorkspace: Bool
    let onOpenChannelIntegrations: (() -> Void)?
    let onClose: () -> Void

    @StateObject private var store: MomoPluginMarketplaceStore
    @State private var query = ""
    @State private var filter = CatalogFilter.all
    @State private var pendingRemoval: MomoPluginCatalogEntry?

    init(
        language: MomoUILanguage,
        serverIdentity: String?,
        workspaceID: WorkspaceID?,
        memberID: MemberID?,
        apiContext: MomoInviteAdminContext? = nil,
        canManageWorkspace: Bool = false,
        onOpenChannelIntegrations: (() -> Void)? = nil,
        service: any MomoPluginMarketplaceService = MomoPluginMarketplaceRESTService(),
        onClose: @escaping () -> Void
    ) {
        self.language = language
        self.serverIdentity = serverIdentity
        self.workspaceID = workspaceID
        self.memberID = memberID
        self.apiContext = apiContext
        self.canManageWorkspace = canManageWorkspace
        self.onOpenChannelIntegrations = onOpenChannelIntegrations
        self.onClose = onClose
        _store = StateObject(wrappedValue: MomoPluginMarketplaceStore(
            service: service,
            context: apiContext
        ))
    }

    private var isKorean: Bool { language == .korean }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .momoSurface(.background, cornerRadius: 0, extent: .windowChrome)
        .task(id: apiContext) {
            await store.updateContext(apiContext)
        }
        .confirmationDialog(
            pendingRemoval.map { removalTitle($0) } ?? removalTitle(nil),
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            presenting: pendingRemoval
        ) { plugin in
            Button(removalActionTitle(plugin), role: .destructive) {
                pendingRemoval = nil
                Task { await store.revokeInstall(plugin) }
            }
            Button(isKorean ? "취소" : "Cancel", role: .cancel) {
                pendingRemoval = nil
            }
        } message: { plugin in
            Text(removalMessage(plugin))
        }
        .accessibilityIdentifier("plugin-marketplace")
    }

    private var header: some View {
        HStack(spacing: MomoTheme.PluginMarketplace.contentSpacing) {
            Button(action: onClose) {
                Label(isKorean ? "채널로 돌아가기" : "Back to channel", systemImage: "chevron.left")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .help(isKorean ? "채널로 돌아가기" : "Back to channel")

            VStack(alignment: .leading, spacing: MomoTheme.PluginMarketplace.compactSpacing) {
                Text(isKorean ? "플러그인" : "Plugins")
                    .font(.title2.weight(.semibold))
                Text(isKorean
                    ? "워크스페이스 도구와 내 사용 권한을 관리합니다"
                    : "Manage workspace tools and your access")
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: MomoTheme.PluginMarketplace.standardSpacing)

            if let serverLabel {
                Label(serverLabel, systemImage: "server.rack")
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(
            .leading,
            MomoTheme.PluginMarketplace.sectionSpacing + centerHeaderLeadingInset
        )
        .padding(
            .trailing,
            MomoTheme.PluginMarketplace.sectionSpacing
                + MomoWindowChromeLayout.centerChromeControlsReservedWidth
        )
        .frame(minHeight: MomoWindowChromeLayout.integratedHeaderHeight)
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .idle, .loading:
            stateView(
                title: isKorean ? "플러그인을 불러오는 중" : "Loading plugins",
                description: isKorean
                    ? "워크스페이스 카탈로그와 내 권한을 확인하고 있습니다."
                    : "Checking the workspace catalog and your access.",
                systemImage: "puzzlepiece.extension",
                showsProgress: true
            )
        case .unavailable:
            stateView(
                title: isKorean ? "실서버 세션이 필요합니다" : "A live server session is required",
                description: isKorean
                    ? "채널로 돌아가 서버에 로그인한 뒤 플러그인을 다시 여세요."
                    : "Return to the channel, sign in to a server, then open Plugins again.",
                systemImage: "person.crop.circle.badge.exclamationmark",
                secondaryActionTitle: isKorean ? "채널로 돌아가기" : "Back to channel",
                secondaryAction: onClose
            )
        case .offline:
            stateView(
                title: isKorean ? "서버에 연결되어 있지 않습니다" : "Server connection unavailable",
                description: isKorean
                    ? "실서버 세션에 연결한 뒤 플러그인 목록을 다시 불러오세요."
                    : "Connect a live server session, then load the plugin catalog again.",
                systemImage: "network.slash",
                primaryActionTitle: isKorean ? "다시 불러오기" : "Reload",
                primaryAction: { Task { await store.retry() } },
                secondaryActionTitle: isKorean ? "채널로 돌아가기" : "Back to channel",
                secondaryAction: onClose
            )
        case let .failed(error):
            stateView(
                title: catalogFailureTitle(error),
                description: catalogFailureDescription(error),
                systemImage: "exclamationmark.triangle",
                primaryActionTitle: isKorean ? "다시 불러오기" : "Reload",
                primaryAction: { Task { await store.retry() } },
                secondaryActionTitle: isKorean ? "채널로 돌아가기" : "Back to channel",
                secondaryAction: onClose
            )
        case .loaded:
            catalog
        }
    }

    private var catalog: some View {
        VStack(spacing: 0) {
            catalogControls
            Divider()
            if let failure = store.actionFailure {
                actionFailureBanner(failure)
                Divider()
            }
            if visiblePlugins.isEmpty {
                emptyState
            } else {
                pluginList
            }
        }
    }

    private var catalogControls: some View {
        ViewThatFits(in: .horizontal) {
            wideCatalogControls
            compactCatalogControls
        }
        .padding(.horizontal, MomoTheme.PluginMarketplace.edgeInset)
        .padding(.vertical, MomoTheme.PluginMarketplace.contentSpacing)
        .frame(maxWidth: MomoTheme.PluginMarketplace.contentMaximumWidth)
        .frame(maxWidth: .infinity)
    }

    private var wideCatalogControls: some View {
        HStack(spacing: MomoTheme.PluginMarketplace.contentSpacing) {
            catalogSearchField
                .frame(minWidth: MomoPluginMarketplaceControlLayout.searchMinimumWidth)

            catalogFilterPicker
                .frame(width: MomoTheme.PluginMarketplace.gridMinimumWidth)

            refreshCatalogButton
        }
    }

    private var compactCatalogControls: some View {
        VStack(alignment: .leading, spacing: MomoTheme.PluginMarketplace.contentSpacing) {
            HStack(spacing: MomoTheme.PluginMarketplace.contentSpacing) {
                catalogSearchField
                    .frame(minWidth: MomoPluginMarketplaceControlLayout.searchMinimumWidth)
                refreshCatalogButton
            }

            catalogFilterPicker
                .frame(maxWidth: .infinity)
        }
    }

    private var catalogSearchField: some View {
        TextField(
            isKorean ? "플러그인 검색" : "Search plugins",
            text: $query
        )
        .textFieldStyle(.roundedBorder)
        .accessibilityIdentifier("plugin-marketplace-search")
    }

    private var catalogFilterPicker: some View {
        Picker(isKorean ? "플러그인 보기" : "Plugin view", selection: $filter) {
            Text(isKorean ? "전체" : "All").tag(CatalogFilter.all)
            Text(isKorean ? "설치됨" : "Installed").tag(CatalogFilter.installed)
            Text(isKorean ? "내 권한" : "My access").tag(CatalogFilter.granted)
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("plugin-marketplace-filter")
    }

    private var refreshCatalogButton: some View {
        Button {
            Task { await store.retry() }
        } label: {
            Label(isKorean ? "카탈로그 새로고침" : "Refresh catalog", systemImage: "arrow.clockwise")
                .labelStyle(.iconOnly)
                .frame(
                    minWidth: MomoPluginMarketplaceControlLayout.refreshMinimumSize,
                    minHeight: MomoPluginMarketplaceControlLayout.refreshMinimumSize
                )
        }
        .accessibilityIdentifier("plugin-marketplace-refresh")
        .keyboardShortcut("r", modifiers: .command)
        .help(isKorean ? "카탈로그 새로고침" : "Refresh catalog")
    }

    private var pluginList: some View {
        List {
            if !recommendedPlugins.isEmpty {
                Section(isKorean ? "추천" : "Recommended") {
                    ForEach(recommendedPlugins) { plugin in
                        pluginRow(plugin)
                    }
                }
            }

            if !otherPlugins.isEmpty {
                Section(isKorean ? "모든 플러그인" : "All plugins") {
                    ForEach(otherPlugins) { plugin in
                        pluginRow(plugin)
                    }
                }
            }
        }
        .listStyle(.inset)
        .frame(maxWidth: MomoTheme.PluginMarketplace.contentMaximumWidth)
        .frame(maxWidth: .infinity)
    }

    private func pluginRow(_ plugin: MomoPluginCatalogEntry) -> some View {
        HStack(alignment: .top, spacing: MomoTheme.PluginMarketplace.contentSpacing) {
            pluginIcon(plugin)

            VStack(alignment: .leading, spacing: MomoTheme.PluginMarketplace.compactSpacing) {
                HStack(spacing: MomoTheme.PluginMarketplace.standardSpacing) {
                    Text(plugin.name)
                        .font(MomoTheme.Typography.emphasizedRow)
                    if plugin.official {
                        Label(isKorean ? "공식" : "Official", systemImage: "checkmark.seal")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Text(plugin.description)
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)

                pluginStatus(plugin)
                pluginScope(plugin)
            }

            Spacer(minLength: MomoTheme.PluginMarketplace.standardSpacing)
            pluginActions(plugin)
        }
        .padding(.vertical, MomoTheme.PluginMarketplace.standardSpacing)
        .contentShape(Rectangle())
        .task(id: "\(plugin.id):\(store.detailRevision)") {
            await store.loadDetail(for: plugin)
        }
        .contextMenu {
            if plugin.installed, canManageWorkspace, !plugin.isChannelIntegration {
                Button(removalActionTitle(plugin), role: .destructive) {
                    pendingRemoval = plugin
                }
            }
        }
    }

    private func pluginIcon(_ plugin: MomoPluginCatalogEntry) -> some View {
        RoundedRectangle(cornerRadius: MomoTheme.cornerSmall)
            .fill(MomoTheme.PluginMarketplace.iconBackground)
            .overlay {
                Image(systemName: plugin.systemImage)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(MomoTheme.PluginMarketplace.iconForeground)
            }
            .frame(
                width: MomoTheme.WorkspaceSearch.rowMinimumHeight,
                height: MomoTheme.WorkspaceSearch.rowMinimumHeight
            )
            .overlay {
                RoundedRectangle(cornerRadius: MomoTheme.cornerSmall)
                    .stroke(MomoTheme.subtleBorder, lineWidth: 1)
            }
            .accessibilityHidden(true)
    }

    private func pluginStatus(_ plugin: MomoPluginCatalogEntry) -> some View {
        HStack(spacing: MomoTheme.PluginMarketplace.contentSpacing) {
            if plugin.isChannelIntegration {
                Label(isKorean ? "채널 통합" : "Channel integration", systemImage: "number")
            } else if plugin.installed && plugin.enabled {
                Label(isKorean ? "워크스페이스에 설치됨" : "Installed for workspace", systemImage: "checkmark.circle")
            } else if plugin.installed {
                Label(isKorean ? "설치됨, 비활성" : "Installed, disabled", systemImage: "pause.circle")
            } else {
                Label(isKorean ? "설치되지 않음" : "Not installed", systemImage: "circle")
            }

            if store.grantedPluginIDs.contains(plugin.id) {
                Label(isKorean ? "내 사용 권한 있음" : "Access granted to me", systemImage: "person.badge.key")
                    .foregroundStyle(MomoTheme.reversibleGreen)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private func pluginScope(_ plugin: MomoPluginCatalogEntry) -> some View {
        if !plugin.isChannelIntegration {
            if let detail = store.details[plugin.id] {
                if let scope = detail.singleDeclaredScope {
                    Label(scopeTitle(scope), systemImage: "key")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Label(
                        isKorean
                            ? "여러 권한 범위는 아직 지원하지 않습니다"
                            : "Multiple permission scopes are not supported yet",
                        systemImage: "exclamationmark.triangle"
                    )
                    .font(.caption)
                    .foregroundStyle(MomoTheme.costAmber)
                }
            } else if store.detailLoadingPluginIDs.contains(plugin.id) {
                HStack(spacing: MomoTheme.PluginMarketplace.standardSpacing) {
                    ProgressView()
                        .controlSize(.small)
                    Text(isKorean ? "권한 정보 확인 중" : "Checking permissions")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            } else if store.detailFailures[plugin.id] != nil {
                Button(isKorean ? "권한 정보 다시 불러오기" : "Reload permission details") {
                    Task { await store.loadDetail(for: plugin) }
                }
                .buttonStyle(.link)
                .controlSize(.small)
            }
        }
    }

    @ViewBuilder
    private func pluginActions(_ plugin: MomoPluginCatalogEntry) -> some View {
        if store.isMutating(plugin) {
            ProgressView()
                .controlSize(.small)
                .frame(minWidth: MomoTheme.PluginMarketplace.scopePickerWidth)
                .accessibilityLabel(isKorean ? "플러그인 상태 변경 중" : "Updating plugin")
        } else if plugin.isChannelIntegration {
            Button(isKorean ? "채널 통합 열기" : "Open channel integrations") {
                onOpenChannelIntegrations?()
            }
            .buttonStyle(.bordered)
            .disabled(onOpenChannelIntegrations == nil)
            .help(channelIntegrationHelp)
        } else if !plugin.installed || !plugin.enabled {
            VStack(alignment: .trailing, spacing: MomoTheme.PluginMarketplace.standardSpacing) {
                Button(plugin.installed
                    ? (isKorean ? "다시 활성화" : "Enable again")
                    : (isKorean ? "워크스페이스에 설치" : "Install for workspace")) {
                    Task { await store.install(plugin) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canManageWorkspace)

                if !canManageWorkspace {
                    Text(isKorean ? "관리자 설치 필요" : "Admin installation required")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        } else {
            HStack(spacing: MomoTheme.PluginMarketplace.standardSpacing) {
                Button(store.grantedPluginIDs.contains(plugin.id)
                    ? (isKorean ? "내 권한 회수" : "Revoke my access")
                    : (isKorean ? "내 사용 허용" : "Grant me access")) {
                    Task { await store.toggleGrant(for: plugin) }
                }
                .buttonStyle(.bordered)
                .disabled(store.details[plugin.id]?.singleDeclaredScope == nil)

                if canManageWorkspace {
                    Menu {
                        Button(removalActionTitle(plugin), role: .destructive) {
                            pendingRemoval = plugin
                        }
                    } label: {
                        Label(isKorean ? "플러그인 작업" : "Plugin actions", systemImage: "ellipsis.circle")
                            .labelStyle(.iconOnly)
                    }
                    .menuStyle(.borderlessButton)
                    .help(isKorean ? "플러그인 작업" : "Plugin actions")
                }
            }
        }
    }

    private func actionFailureBanner(_ error: MomoPluginMarketplaceError) -> some View {
        HStack(alignment: .top, spacing: MomoTheme.PluginMarketplace.contentSpacing) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(MomoTheme.irreversibleRed)
            VStack(alignment: .leading, spacing: MomoTheme.PluginMarketplace.compactSpacing) {
                Text(actionFailureTitle(error))
                    .font(.body.weight(.semibold))
                Text(actionFailureDescription(error))
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(isKorean ? "오류 닫기" : "Dismiss error") {
                store.dismissActionFailure()
            }
            .buttonStyle(.borderless)
        }
        .padding(.horizontal, MomoTheme.PluginMarketplace.edgeInset)
        .padding(.vertical, MomoTheme.PluginMarketplace.contentSpacing)
        .frame(maxWidth: MomoTheme.PluginMarketplace.contentMaximumWidth)
        .frame(maxWidth: .infinity)
        .background(.regularMaterial)
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label(emptyTitle, systemImage: "puzzlepiece.extension")
        } description: {
            Text(emptyDescription)
        } actions: {
            Button(emptyActionTitle) {
                if store.plugins.isEmpty {
                    Task { await store.retry() }
                } else {
                    query = ""
                    filter = .all
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func stateView(
        title: String,
        description: String,
        systemImage: String,
        showsProgress: Bool = false,
        primaryActionTitle: String? = nil,
        primaryAction: (() -> Void)? = nil,
        secondaryActionTitle: String? = nil,
        secondaryAction: (() -> Void)? = nil
    ) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(description)
        } actions: {
            if showsProgress {
                ProgressView()
                    .controlSize(.small)
            }
            if let primaryActionTitle, let primaryAction {
                Button(primaryActionTitle, action: primaryAction)
                    .buttonStyle(.borderedProminent)
            }
            if let secondaryActionTitle, let secondaryAction {
                Button(secondaryActionTitle, action: secondaryAction)
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var visiblePlugins: [MomoPluginCatalogEntry] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return store.plugins.filter { plugin in
            let matchesFilter: Bool
            switch filter {
            case .all:
                matchesFilter = true
            case .installed:
                matchesFilter = plugin.installed
            case .granted:
                matchesFilter = store.grantedPluginIDs.contains(plugin.id)
            }
            let matchesQuery = normalizedQuery.isEmpty
                || plugin.name.localizedCaseInsensitiveContains(normalizedQuery)
                || plugin.description.localizedCaseInsensitiveContains(normalizedQuery)
                || plugin.recommendedFor.contains {
                    $0.localizedCaseInsensitiveContains(normalizedQuery)
                }
            return matchesFilter && matchesQuery
        }
    }

    private var recommendedPlugins: [MomoPluginCatalogEntry] {
        visiblePlugins.filter(\.recommended)
    }

    private var otherPlugins: [MomoPluginCatalogEntry] {
        visiblePlugins.filter { !$0.recommended }
    }

    private var serverLabel: String? {
        guard let serverIdentity,
              let url = URL(string: serverIdentity),
              let host = url.host
        else { return nil }
        return host
    }

    private var emptyTitle: String {
        if store.plugins.isEmpty {
            return isKorean ? "카탈로그가 비어 있습니다" : "The catalog is empty"
        }
        return isKorean ? "조건에 맞는 플러그인이 없습니다" : "No plugins match"
    }

    private var emptyDescription: String {
        if store.plugins.isEmpty {
            return isKorean
                ? "서버 카탈로그를 새로고침해 등록된 도구를 확인하세요."
                : "Refresh the server catalog to check for registered tools."
        }
        return isKorean
            ? "검색어를 지우거나 다른 보기 조건을 선택하세요."
            : "Clear the search or choose another view."
    }

    private var emptyActionTitle: String {
        store.plugins.isEmpty
            ? (isKorean ? "카탈로그 새로고침" : "Refresh catalog")
            : (isKorean ? "필터 지우기" : "Clear filters")
    }

    private var channelIntegrationHelp: String {
        if onOpenChannelIntegrations == nil {
            return isKorean
                ? "현재 채널을 선택한 뒤 채널 통합에서 웹훅을 관리하세요."
                : "Select a channel, then manage webhooks in channel integrations."
        }
        return isKorean
            ? "현재 채널의 수신 웹훅 설정을 엽니다."
            : "Open incoming webhook settings for the current channel."
    }

    private func scopeTitle(_ scope: String) -> String {
        let parts = scope.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else {
            return isKorean ? "사용 권한 1개" : "One permission scope"
        }
        let resource = parts[0].replacingOccurrences(of: "_", with: " ").capitalized
        switch parts[1] {
        case "read":
            return isKorean ? "\(resource) 읽기 권한" : "Read access to \(resource)"
        case "write":
            return isKorean ? "\(resource) 쓰기 권한" : "Write access to \(resource)"
        default:
            return isKorean ? "\(resource) 사용 권한" : "Access to \(resource)"
        }
    }

    private func catalogFailureTitle(_ error: MomoPluginMarketplaceError) -> String {
        if case let .http(status, _) = error, status == 403 {
            return isKorean ? "카탈로그를 볼 권한이 없습니다" : "Catalog access denied"
        }
        if case let .http(status, _) = error, status == 401 {
            return isKorean ? "로그인이 만료되었습니다" : "Your session expired"
        }
        return isKorean ? "플러그인을 불러오지 못했습니다" : "Plugins could not be loaded"
    }

    private func catalogFailureDescription(_ error: MomoPluginMarketplaceError) -> String {
        if case let .http(status, _) = error, status == 403 {
            return isKorean
                ? "워크스페이스 관리자에게 플러그인 조회 권한을 요청하세요."
                : "Ask a workspace administrator for plugin catalog access."
        }
        if case let .http(status, _) = error, status == 401 {
            return isKorean
                ? "다시 로그인한 뒤 카탈로그를 불러오세요."
                : "Sign in again, then reload the catalog."
        }
        return isKorean
            ? "서버 연결을 확인한 뒤 다시 불러오세요."
            : "Check the server connection, then reload."
    }

    private func actionFailureTitle(_ error: MomoPluginMarketplaceError) -> String {
        switch error {
        case .unsupportedScope:
            return isKorean ? "이 권한 구성을 아직 지원하지 않습니다" : "This permission setup is not supported yet"
        case .channelIntegrationRequired:
            return isKorean ? "채널 통합에서 관리해야 합니다" : "Manage this from channel integrations"
        case let .http(status, _) where status == 403:
            return isKorean ? "이 작업을 할 권한이 없습니다" : "You do not have permission for this action"
        case let .http(status, _) where status == 401:
            return isKorean ? "로그인이 만료되었습니다" : "Your session expired"
        case let .http(status, _) where status == 409:
            return isKorean ? "플러그인 상태가 변경되었습니다" : "The plugin state changed"
        default:
            return isKorean ? "플러그인 상태를 변경하지 못했습니다" : "The plugin could not be updated"
        }
    }

    private func actionFailureDescription(_ error: MomoPluginMarketplaceError) -> String {
        switch error {
        case let .unsupportedScope(_, declaredCount):
            return isKorean
                ? "현재 앱은 플러그인당 권한 범위 1개만 처리합니다. 서버에 \(declaredCount)개가 선언되어 작업을 중단했습니다."
                : "This app currently handles one scope per plugin. The server declared \(declaredCount), so no change was made."
        case .channelIntegrationRequired:
            return isKorean
                ? "수신 웹훅은 현재 채널의 통합 설정에서 발급하고 회수하세요."
                : "Create and revoke incoming webhooks from the current channel's integration settings."
        case let .http(status, _) where status == 403:
            return isKorean
                ? "워크스페이스 관리자에게 필요한 역할을 요청하세요."
                : "Ask a workspace administrator for the required role."
        case let .http(status, _) where status == 401:
            return isKorean
                ? "다시 로그인한 뒤 플러그인 작업을 다시 시도하세요."
                : "Sign in again, then retry the plugin action."
        case let .http(status, _) where status == 409:
            return isKorean
                ? "카탈로그를 새로고침한 뒤 작업을 다시 시도하세요."
                : "Refresh the catalog, then try the action again."
        default:
            return isKorean
                ? "서버 연결을 확인한 뒤 같은 작업을 다시 시도하세요."
                : "Check the server connection, then try the same action again."
        }
    }

    private func removalTitle(_ plugin: MomoPluginCatalogEntry?) -> String {
        guard let plugin else {
            return isKorean ? "플러그인을 제거할까요?" : "Remove plugin?"
        }
        return isKorean
            ? "\(plugin.name)을 워크스페이스에서 제거할까요?"
            : "Remove \(plugin.name) from the workspace?"
    }

    private func removalActionTitle(_ plugin: MomoPluginCatalogEntry) -> String {
        isKorean
            ? "\(plugin.name) 제거"
            : "Remove \(plugin.name)"
    }

    private func removalMessage(_ plugin: MomoPluginCatalogEntry) -> String {
        isKorean
            ? "모든 멤버의 \(plugin.name) 사용 권한도 함께 회수됩니다."
            : "This also revokes \(plugin.name) access for every member."
    }
}
