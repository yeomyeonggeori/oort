import SwiftUI
import MomoCore

enum MomoUnreadKeyboardShortcut {
    static let modifiers: EventModifiers = [.option, .shift]
    static let helpGlyphs = "⌥⇧↑ / ⌥⇧↓"
}

struct MomoKeyboardShortcutItem: Identifiable, Equatable {
    var id: String { key }
    let key: String
    let label: String
}

enum MomoKeyboardShortcutCatalog {
    static func items(copy: MomoWorkspaceCopy) -> [MomoKeyboardShortcutItem] {
        [
            MomoKeyboardShortcutItem(key: "⌘K", label: copy.quickSwitcherOpen),
            MomoKeyboardShortcutItem(key: "⌘F", label: copy.workspaceSearch),
            MomoKeyboardShortcutItem(key: "⇧⌘I", label: copy.inviteToChannel),
            MomoKeyboardShortcutItem(key: "⇧⌘,", label: copy.channelSettings),
            MomoKeyboardShortcutItem(key: "⇧⌘D", label: copy.appDownloads),
            MomoKeyboardShortcutItem(key: "⇧⌘W", label: copy.startWork),
            MomoKeyboardShortcutItem(key: "⌘1…⌘9", label: copy.quickSwitcherChannelShortcuts),
            MomoKeyboardShortcutItem(
                key: MomoUnreadKeyboardShortcut.helpGlyphs,
                label: copy.unreadChannelNavigation
            ),
            MomoKeyboardShortcutItem(key: "⌘[", label: copy.quickSwitcherHistoryBack),
            MomoKeyboardShortcutItem(key: "⌘]", label: copy.quickSwitcherHistoryForward),
            MomoKeyboardShortcutItem(key: "⌘/", label: copy.quickSwitcherShortcutHelp),
            MomoKeyboardShortcutItem(key: "↑ / ↓", label: copy.quickSwitcherMoveSelection),
            MomoKeyboardShortcutItem(key: "↩", label: copy.quickSwitcherOpenResult),
            MomoKeyboardShortcutItem(key: "esc", label: copy.quickSwitcherClose),
        ]
    }
}
struct MomoKeyboardShortcutsView: View {
    var copy: MomoWorkspaceCopy
    @Environment(\.dismiss) private var dismiss

    private var shortcuts: [MomoKeyboardShortcutItem] {
        MomoKeyboardShortcutCatalog.items(copy: copy)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: MomoTheme.QuickSwitcher.standardSpacing) {
                VStack(alignment: .leading, spacing: MomoTheme.QuickSwitcher.compactSpacing) {
                    Text(copy.quickSwitcherShortcutHelp)
                        .font(.title3.weight(.semibold))
                    Text(copy.quickSwitcherShortcutHelpSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Label(copy.quickSwitcherShortcutHelpClose, systemImage: "xmark")
                        .labelStyle(.iconOnly)
                }
                .keyboardShortcut(.cancelAction)
                .help(copy.quickSwitcherShortcutHelpClose)
            }
            .padding(MomoTheme.QuickSwitcher.edgeInset)

            Divider()

            // Static help rows do not need List selection, and ScrollView keeps
            // sheet previews deterministic across SwiftPM and Xcode hosts.
            ScrollView {
                LazyVStack(spacing: MomoTheme.QuickSwitcher.standardSpacing) {
                    ForEach(shortcuts) { shortcut in
                        // LabeledContent collapses to its intrinsic width in this
                        // scroll surface, so an HStack preserves the two-column scan.
                        HStack(spacing: MomoTheme.QuickSwitcher.standardSpacing) {
                            Text(shortcut.label)
                            Spacer()
                            Text(shortcut.key)
                                .font(.body.monospaced())
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, MomoTheme.QuickSwitcher.compactSpacing)
                        Divider()
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(MomoTheme.QuickSwitcher.edgeInset)
            }
        }
        .frame(
            width: MomoTheme.QuickSwitcher.shortcutsWidth,
            height: MomoTheme.QuickSwitcher.shortcutsHeight
        )
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

public struct MomoMacCommandActions {
    var language: MomoUILanguage
    var channelCount: Int
    var canNavigateBackward: Bool
    var canNavigateForward: Bool
    var canNavigateUnreadChannels: Bool
    var canOpenSelectedChannelSettings: Bool
    var canInviteToSelectedChannel: Bool
    var presentQuickSwitcher: () -> Void
    var presentWorkspaceSearch: () -> Void
    var presentChannelSettings: () -> Void
    var inviteToChannel: () -> Void
    var openDownloads: () -> Void
    var selectChannel: (Int) -> Void
    var navigateBackward: () -> Void
    var navigateForward: () -> Void
    var navigateToPreviousUnread: () -> Void
    var navigateToNextUnread: () -> Void
    var presentShortcutHelp: () -> Void

    public init(
        language: MomoUILanguage,
        channelCount: Int,
        canNavigateBackward: Bool,
        canNavigateForward: Bool,
        canNavigateUnreadChannels: Bool,
        canOpenSelectedChannelSettings: Bool,
        canInviteToSelectedChannel: Bool,
        presentQuickSwitcher: @escaping () -> Void,
        presentWorkspaceSearch: @escaping () -> Void,
        presentChannelSettings: @escaping () -> Void,
        inviteToChannel: @escaping () -> Void,
        openDownloads: @escaping () -> Void,
        selectChannel: @escaping (Int) -> Void,
        navigateBackward: @escaping () -> Void,
        navigateForward: @escaping () -> Void,
        navigateToPreviousUnread: @escaping () -> Void,
        navigateToNextUnread: @escaping () -> Void,
        presentShortcutHelp: @escaping () -> Void
    ) {
        self.language = language
        self.channelCount = channelCount
        self.canNavigateBackward = canNavigateBackward
        self.canNavigateForward = canNavigateForward
        self.canNavigateUnreadChannels = canNavigateUnreadChannels
        self.canOpenSelectedChannelSettings = canOpenSelectedChannelSettings
        self.canInviteToSelectedChannel = canInviteToSelectedChannel
        self.presentQuickSwitcher = presentQuickSwitcher
        self.presentWorkspaceSearch = presentWorkspaceSearch
        self.presentChannelSettings = presentChannelSettings
        self.inviteToChannel = inviteToChannel
        self.openDownloads = openDownloads
        self.selectChannel = selectChannel
        self.navigateBackward = navigateBackward
        self.navigateForward = navigateForward
        self.navigateToPreviousUnread = navigateToPreviousUnread
        self.navigateToNextUnread = navigateToNextUnread
        self.presentShortcutHelp = presentShortcutHelp
    }
}

private struct MomoMacCommandActionsKey: FocusedValueKey {
    typealias Value = MomoMacCommandActions
}

public extension FocusedValues {
    var momoMacCommandActions: MomoMacCommandActions? {
        get { self[MomoMacCommandActionsKey.self] }
        set { self[MomoMacCommandActionsKey.self] = newValue }
    }
}

public struct MomoMacCommands: Commands {
    @FocusedValue(\.momoMacCommandActions) private var actions

    public init() {}

    public var body: some Commands {
        CommandMenu(copy.quickSwitcherNavigationMenu) {
            Button(copy.quickSwitcherOpen) {
                actions?.presentQuickSwitcher()
            }
            .keyboardShortcut("k", modifiers: .command)
            .disabled(actions == nil)

            Button(copy.workspaceSearch) {
                actions?.presentWorkspaceSearch()
            }
            .keyboardShortcut("f", modifiers: .command)
            .disabled(actions == nil)

            Button(copy.appDownloads) {
                actions?.openDownloads()
            }
            .keyboardShortcut("d", modifiers: [.command, .shift])
            .disabled(actions == nil)

            Divider()

            Button(copy.inviteToChannel) {
                actions?.inviteToChannel()
            }
            .keyboardShortcut("i", modifiers: [.command, .shift])
            .disabled(actions?.canInviteToSelectedChannel != true)

            Button(copy.channelSettings) {
                actions?.presentChannelSettings()
            }
            .keyboardShortcut(",", modifiers: [.command, .shift])
            .disabled(actions?.canOpenSelectedChannelSettings != true)

            Divider()

            ForEach(1...9, id: \.self) { number in
                Button(copy.quickSwitcherChannelShortcut(number)) {
                    actions?.selectChannel(number)
                }
                .keyboardShortcut(KeyEquivalent(Character(String(number))), modifiers: .command)
                .disabled(actions == nil || number > (actions?.channelCount ?? 0))
            }

            Divider()

            Button(copy.unreadChannelPrevious) {
                actions?.navigateToPreviousUnread()
            }
            .keyboardShortcut(.upArrow, modifiers: MomoUnreadKeyboardShortcut.modifiers)
            .disabled(actions?.canNavigateUnreadChannels != true)

            Button(copy.unreadChannelNext) {
                actions?.navigateToNextUnread()
            }
            .keyboardShortcut(.downArrow, modifiers: MomoUnreadKeyboardShortcut.modifiers)
            .disabled(actions?.canNavigateUnreadChannels != true)

            Divider()

            Button(copy.quickSwitcherHistoryBack) {
                actions?.navigateBackward()
            }
            .keyboardShortcut("[", modifiers: .command)
            .disabled(actions?.canNavigateBackward != true)

            Button(copy.quickSwitcherHistoryForward) {
                actions?.navigateForward()
            }
            .keyboardShortcut("]", modifiers: .command)
            .disabled(actions?.canNavigateForward != true)

            Divider()

            Button(copy.quickSwitcherShortcutHelp) {
                actions?.presentShortcutHelp()
            }
            .keyboardShortcut("/", modifiers: .command)
            .disabled(actions == nil)
        }
    }

    private var copy: MomoWorkspaceCopy {
        MomoWorkspaceCopy(language: actions?.language ?? .preferredDefault)
    }
}

extension MomoWorkspaceCopy {
    var quickSwitcherNavigationMenu: String {
        language == .korean ? "이동" : "Navigate"
    }

    var quickSwitcherTitle: String {
        language == .korean ? "퀵 스위처" : "Quick switcher"
    }

    var quickSwitcherOpen: String {
        language == .korean ? "퀵 스위처 열기" : "Open quick switcher"
    }

    var quickSwitcherPlaceholder: String {
        language == .korean ? "채널 또는 멤버 검색" : "Search channels or members"
    }

    var quickSwitcherRecentChannels: String {
        language == .korean ? "최근 채널" : "Recent channels"
    }

    var quickSwitcherLoading: String {
        language == .korean ? "채널과 멤버 불러오는 중" : "Loading channels and members"
    }

    var quickSwitcherEmpty: String {
        language == .korean ? "이동할 채널이나 멤버가 없습니다" : "No channels or members to open"
    }

    var quickSwitcherNoResults: String {
        language == .korean ? "일치하는 채널이나 멤버가 없습니다" : "No matching channels or members"
    }

    var quickSwitcherClearSearch: String {
        language == .korean ? "검색어 지우기" : "Clear search"
    }

    var quickSwitcherMoveSelection: String {
        language == .korean ? "선택 이동" : "Move selection"
    }

    var quickSwitcherOpenResult: String {
        language == .korean ? "선택 항목 열기" : "Open selection"
    }

    var quickSwitcherClose: String {
        language == .korean ? "스위처 닫기" : "Close switcher"
    }

    var quickSwitcherOfflineNote: String {
        language == .korean
            ? "오프라인입니다. 현재 불러온 채널과 멤버만 검색합니다."
            : "Offline. Search is limited to loaded channels and members."
    }

    var quickSwitcherSearchError: String {
        language == .korean
            ? "서버 데이터를 갱신하지 못했습니다. 다시 시도하거나 현재 목록을 검색하세요."
            : "Server data could not be refreshed. Retry or search the current list."
    }

    var quickSwitcherChannelShortcuts: String {
        language == .korean ? "채널 1부터 9까지 열기" : "Open channels 1 through 9"
    }

    func quickSwitcherChannelShortcut(_ number: Int) -> String {
        language == .korean ? "채널 \(number) 열기" : "Open channel \(number)"
    }

    var quickSwitcherHistoryBack: String {
        language == .korean ? "이전 채널로 이동" : "Go to previous channel"
    }

    var quickSwitcherHistoryForward: String {
        language == .korean ? "다음 채널로 이동" : "Go to next channel"
    }

    var unreadChannelNavigation: String {
        language == .korean ? "읽지 않은 채널 순회" : "Move through unread channels"
    }

    var unreadChannelPrevious: String {
        language == .korean ? "이전 읽지 않은 채널로 이동" : "Go to previous unread channel"
    }

    var unreadChannelNext: String {
        language == .korean ? "다음 읽지 않은 채널로 이동" : "Go to next unread channel"
    }

    var quickSwitcherShortcutHelp: String {
        language == .korean ? "키보드 단축키" : "Keyboard shortcuts"
    }

    var quickSwitcherShortcutHelpSubtitle: String {
        language == .korean
            ? "마우스 없이 채널과 멤버 사이를 이동하세요."
            : "Move between channels and members without the mouse."
    }

    var quickSwitcherShortcutHelpClose: String {
        language == .korean ? "단축키 도움말 닫기" : "Close keyboard shortcuts"
    }
}
