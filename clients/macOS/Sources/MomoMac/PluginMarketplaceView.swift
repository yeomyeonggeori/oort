import SwiftUI
import MomoCore

struct MomoPluginMarketplaceView: View {
    @Environment(\.momoCenterHeaderLeadingInset) private var centerHeaderLeadingInset
    private static let pluginIconSize = MomoTheme.WorkspaceSearch.rowMinimumHeight

    private enum Scope: String, CaseIterable, Identifiable {
        case workspace
        case personal

        var id: String { rawValue }
    }

    let language: MomoUILanguage
    let serverIdentity: String?
    let workspaceID: WorkspaceID?
    let memberID: MemberID?
    let onClose: () -> Void

    @State private var query = ""
    @State private var scope = Scope.workspace
    @State private var selectedCategory: MomoPluginCatalogItem.Category?
    @State private var showsInstalledOnly = false
    @State private var installedPluginIDs: Set<String> = []

    private var copy: MomoComposerActionCopy { .init(language: language) }
    private var isKorean: Bool { language == .korean }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: MomoTheme.PluginMarketplace.edgeInset) {
                    searchField
                    installedSection
                    catalogControls
                    catalogSections
                }
                .frame(maxWidth: MomoTheme.PluginMarketplace.contentMaximumWidth, alignment: .leading)
                .padding(.horizontal, MomoTheme.PluginMarketplace.edgeInset)
                .padding(.vertical, MomoTheme.PluginMarketplace.edgeInset)
                .frame(maxWidth: .infinity, alignment: .top)
            }
        }
        .momoSurface(.background, cornerRadius: 0, extent: .windowChrome)
        .onAppear(perform: loadInstalledPlugins)
        .onChange(of: scope) { _, _ in loadInstalledPlugins() }
        .onChange(of: storageIdentity) { _, _ in loadInstalledPlugins() }
        .onChange(of: installedPluginIDs) { _, _ in saveInstalledPlugins() }
        .accessibilityIdentifier("plugin-marketplace")
    }

    private var header: some View {
        HStack(spacing: MomoTheme.PluginMarketplace.contentSpacing) {
            Button(action: onClose) {
                Label(isKorean ? "채널로 돌아가기" : "Back to channel", systemImage: "chevron.left")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(.plain)
            .help(isKorean ? "채널로 돌아가기" : "Back to channel")

            HStack(alignment: .firstTextBaseline, spacing: MomoTheme.PluginMarketplace.contentSpacing) {
                Text(isKorean ? "플러그인" : "Plugins")
                    .font(.title2.weight(.semibold))
                    .fixedSize(horizontal: true, vertical: false)
                Text(isKorean ? "업무 도구를 연결하고 에이전트와 함께 사용하세요" : "Connect work tools and use them with agents")
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer()
            Button {
                showsInstalledOnly.toggle()
            } label: {
                Label(
                    showsInstalledOnly
                        ? (isKorean ? "모든 플러그인 보기" : "Show all plugins")
                        : (isKorean ? "설치됨만 보기" : "Show installed only"),
                    systemImage: showsInstalledOnly ? "square.grid.2x2" : "checkmark.circle"
                )
            }
            .buttonStyle(.bordered)
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

    private var searchField: some View {
        // The centered catalog search is wider than the native toolbar search placement can express.
        HStack(spacing: MomoTheme.PluginMarketplace.standardSpacing) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField(copy.pluginSearch, text: $query)
                .textFieldStyle(.plain)
                .font(.body)
                .accessibilityIdentifier("plugin-marketplace-search")
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isKorean ? "검색어 지우기" : "Clear search")
            }
        }
        .padding(.horizontal, MomoTheme.PluginMarketplace.sectionSpacing)
        .frame(height: MomoTheme.WorkspaceSearch.rowMinimumHeight)
        .background(MomoTheme.PluginMarketplace.searchBackground, in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall))
        .overlay {
            RoundedRectangle(cornerRadius: MomoTheme.cornerSmall)
                .stroke(MomoTheme.subtleBorder, lineWidth: 1)
        }
    }

    @ViewBuilder
    private var installedSection: some View {
        VStack(alignment: .leading, spacing: MomoTheme.PluginMarketplace.contentSpacing) {
            sectionTitle(isKorean ? "설치됨" : "Installed")
            if installedPlugins.isEmpty {
                HStack(spacing: MomoTheme.PluginMarketplace.standardSpacing) {
                    Image(systemName: "puzzlepiece.extension")
                        .foregroundStyle(.secondary)
                    Text(isKorean ? "아직 선택한 플러그인이 없습니다. 아래에서 업무 도구를 추가해보세요." : "No plugins selected yet. Add a work tool below.")
                        .font(MomoTheme.Typography.supporting)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, MomoTheme.PluginMarketplace.standardSpacing)
            } else {
                ScrollView(.horizontal) {
                    HStack(spacing: MomoTheme.PluginMarketplace.standardSpacing) {
                        ForEach(installedPlugins) { plugin in
                            pluginIcon(plugin, size: Self.pluginIconSize)
                                .help(plugin.name)
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel(plugin.name)
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
        }
    }

    private var catalogControls: some View {
        HStack {
            Picker("", selection: $scope) {
                Text(isKorean ? "워크스페이스" : "Workspace").tag(Scope.workspace)
                Text(isKorean ? "개인용" : "Personal").tag(Scope.personal)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(
                width: MomoTheme.PluginMarketplace.scopePickerWidth,
                alignment: .leading
            )
            .accessibilityLabel(isKorean ? "플러그인 범위" : "Plugin scope")

            Spacer()

            Menu {
                Button {
                    selectedCategory = nil
                } label: {
                    if selectedCategory == nil {
                        Label(isKorean ? "전체" : "All", systemImage: "checkmark")
                    } else {
                        Text(isKorean ? "전체" : "All")
                    }
                }
                ForEach(MomoPluginCatalogItem.Category.allCases, id: \.self) { category in
                    Button {
                        selectedCategory = category
                    } label: {
                        if selectedCategory == category {
                            Label(categoryTitle(category), systemImage: "checkmark")
                        } else {
                            Text(categoryTitle(category))
                        }
                    }
                }
            } label: {
                Label(isKorean ? "분류" : "Categories", systemImage: "line.3.horizontal.decrease")
                    .labelStyle(.iconOnly)
            }
            .menuStyle(.borderlessButton)
            .help(isKorean ? "분류" : "Categories")

            Label(
                serverIdentity == nil
                    ? (isKorean ? "로컬 미리보기" : "Local preview")
                    : (isKorean ? "이 Mac에 선택 저장" : "Selections saved on this Mac"),
                systemImage: "macbook"
            )
            .font(MomoTheme.Typography.supporting)
            .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var catalogSections: some View {
        if filteredPlugins.isEmpty {
            ContentUnavailableView(
                emptyTitle,
                systemImage: showsInstalledOnly ? "checkmark.circle" : "magnifyingglass",
                description: Text(emptyDescription)
            )
            .frame(maxWidth: .infinity, minHeight: MomoTheme.PluginMarketplace.emptyMinimumHeight)
        } else {
            ForEach(visibleCategories, id: \.self) { category in
                let plugins = filteredPlugins.filter { plugin in
                    if category == .featured {
                        return plugin.isFeatured
                    }
                    // The default catalog gives featured tools one clear home. A user-selected
                    // category still reveals every matching tool, including featured entries.
                    return plugin.category == category && (selectedCategory != nil || !plugin.isFeatured)
                }
                if !plugins.isEmpty {
                    VStack(alignment: .leading, spacing: MomoTheme.PluginMarketplace.contentSpacing) {
                        sectionTitle(categoryTitle(category))
                        LazyVGrid(columns: gridColumns, spacing: MomoTheme.PluginMarketplace.standardSpacing) {
                            ForEach(plugins) { plugin in
                                pluginRow(plugin)
                            }
                        }
                    }
                }
            }

            Label(
                isKorean ? "현재 선택 상태는 이 Mac에 저장됩니다. 서버 권한과 실제 연결은 엔진 연동 후 활성화됩니다." : "Selections are stored on this Mac. Server grants and live connections activate when the engine is linked.",
                systemImage: "info.circle"
            )
            .font(MomoTheme.Typography.supporting)
            .foregroundStyle(.secondary)
        }
    }

    private func pluginRow(_ plugin: MomoPluginCatalogItem) -> some View {
        let isInstalled = installedPluginIDs.contains(plugin.id)
        return HStack(spacing: MomoTheme.PluginMarketplace.contentSpacing) {
            pluginIcon(plugin, size: Self.pluginIconSize)

            VStack(alignment: .leading, spacing: MomoTheme.PluginMarketplace.compactSpacing) {
                Text(plugin.name)
                    .font(MomoTheme.Typography.emphasizedRow)
                Text(isKorean ? plugin.koreanSummary : plugin.englishSummary)
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text(plugin.capabilities(for: language).joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }

            Spacer(minLength: MomoTheme.PluginMarketplace.standardSpacing)

            if isInstalled {
                Button(isKorean ? "제거" : "Remove") {
                    installedPluginIDs.remove(plugin.id)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityLabel(isKorean ? "\(plugin.name) 제거" : "Remove \(plugin.name)")
            } else {
                Button(copy.install) {
                    installedPluginIDs.insert(plugin.id)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .accessibilityLabel(isKorean ? "\(plugin.name) 설치" : "Install \(plugin.name)")
            }
        }
        .padding(.horizontal, MomoTheme.PluginMarketplace.compactSpacing)
        .padding(.vertical, MomoTheme.PluginMarketplace.contentSpacing)
        .frame(minHeight: MomoTheme.PluginMarketplace.rowMinimumHeight)
        .overlay(alignment: .bottom) {
            Divider()
        }
        .contentShape(Rectangle())
    }

    private func pluginIcon(_ plugin: MomoPluginCatalogItem, size: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: MomoTheme.cornerSmall)
            .fill(MomoTheme.PluginMarketplace.iconBackground)
            .overlay {
                Image(systemName: plugin.systemImage)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(MomoTheme.PluginMarketplace.iconForeground)
            }
            .frame(width: size, height: size)
            .overlay {
                RoundedRectangle(cornerRadius: MomoTheme.cornerSmall)
                    .stroke(MomoTheme.subtleBorder, lineWidth: 1)
            }
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.headline)
    }

    private var filteredPlugins: [MomoPluginCatalogItem] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return MomoPluginCatalogItem.recommended.filter { plugin in
            let matchesCategory = selectedCategory.map { category in
                category == .featured ? plugin.isFeatured : plugin.category == category
            } ?? true
            let matchesInstalled = !showsInstalledOnly || installedPluginIDs.contains(plugin.id)
            let matchesQuery = normalized.isEmpty
                || plugin.name.localizedCaseInsensitiveContains(normalized)
                || (isKorean ? plugin.koreanSummary : plugin.englishSummary).localizedCaseInsensitiveContains(normalized)
                || plugin.capabilities(for: language).contains { $0.localizedCaseInsensitiveContains(normalized) }
            return matchesCategory && matchesInstalled && matchesQuery
        }
    }

    private var installedPlugins: [MomoPluginCatalogItem] {
        MomoPluginCatalogItem.recommended.filter { installedPluginIDs.contains($0.id) }
    }

    private var visibleCategories: [MomoPluginCatalogItem.Category] {
        selectedCategory.map { [$0] } ?? [.featured, .productivity, .knowledge, .developer]
    }

    private var emptyTitle: String {
        if showsInstalledOnly && query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return isKorean ? "설치된 플러그인이 없습니다" : "No installed plugins"
        }
        return isKorean ? "검색 결과가 없습니다" : "No plugins found"
    }

    private var emptyDescription: String {
        if showsInstalledOnly && query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return isKorean ? "모든 플러그인 보기에서 업무 도구를 설치해보세요." : "Install a work tool from Show all plugins."
        }
        return isKorean ? "다른 이름이나 기능으로 검색해보세요." : "Try another name or capability."
    }

    private func categoryTitle(_ category: MomoPluginCatalogItem.Category) -> String {
        switch category {
        case .featured: return isKorean ? "추천" : "Featured"
        case .productivity: return isKorean ? "생산성" : "Productivity"
        case .knowledge: return isKorean ? "지식" : "Knowledge"
        case .developer: return isKorean ? "개발" : "Developer"
        }
    }

    private var gridColumns: [GridItem] {
        [GridItem(
            .adaptive(minimum: MomoTheme.PluginMarketplace.gridMinimumWidth),
            spacing: MomoTheme.PluginMarketplace.standardSpacing
        )]
    }

    private var storageIdentity: String {
        let rawServer = serverIdentity?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "demo"
        let server = rawServer.data(using: .utf8)?.base64EncodedString() ?? "demo"
        let workspace = workspaceID?.description ?? "demo"
        let member = memberID?.description ?? "anonymous"
        return "\(server).\(workspace).\(member)"
    }

    private var storageKey: String {
        let legacyWorkspaceKey = "momo.plugins.localSelected.v1.\(storageIdentity)"
        switch scope {
        case .workspace:
            return legacyWorkspaceKey
        case .personal:
            return "\(legacyWorkspaceKey).personal"
        }
    }

    private func loadInstalledPlugins() {
        let raw = UserDefaults.standard.string(forKey: storageKey) ?? ""
        installedPluginIDs = Set(raw.split(separator: "\n").map(String.init))
    }

    private func saveInstalledPlugins() {
        UserDefaults.standard.set(installedPluginIDs.sorted().joined(separator: "\n"), forKey: storageKey)
    }
}
