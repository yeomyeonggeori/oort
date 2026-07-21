#if os(iOS)
import MomoCore
import MomoiOSPushKit
import SwiftUI
import UIKit

@MainActor
public struct IOSWorkspaceView: View {
    private let session: IOSSession
    private let bootstrap: WorkspaceBootstrap
    private let signOut: @MainActor () async -> Void
    private let backend: MomoServerConversationClient
    private let huddleService: any IOSHuddleService
    @Binding private var selectedTab: IOSAppTab
    @Binding private var homePath: [IOSPushDeepLink]
    @Binding private var workPath: [IOSPushDeepLink]
    @State private var model: IOSChannelListModel
    @State private var workModel: IOSWorkListModel
    @State private var workApprovalModel: IOSWorkApprovalInboxModel
    @AppStorage("momo.ios.developer-mode") private var developerModeEnabled = false

    public init(
        session: IOSSession,
        bootstrap: WorkspaceBootstrap,
        selectedTab: Binding<IOSAppTab>,
        homePath: Binding<[IOSPushDeepLink]>,
        workPath: Binding<[IOSPushDeepLink]>,
        signOut: @escaping @MainActor () async -> Void
    ) {
        let backend = MomoServerConversationClient(authenticated: session)
        self.session = session
        self.bootstrap = bootstrap
        self.signOut = signOut
        self.backend = backend
        self.huddleService = IOSHuddleRESTService(authenticated: session)
        _selectedTab = selectedTab
        _homePath = homePath
        _workPath = workPath
        _model = State(initialValue: IOSChannelListModel(currentMemberID: session.member.id, backend: backend))
        _workModel = State(initialValue: IOSWorkListModel(backend: backend))
        _workApprovalModel = State(initialValue: IOSWorkApprovalInboxModel(backend: backend))
    }

    public var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack(path: $homePath) {
                IOSChannelHomeView(
                    session: session,
                    bootstrap: bootstrap,
                    model: model,
                    backend: backend,
                    huddleService: huddleService
                )
            }
            .tabItem { Label("Home", systemImage: "house") }
            .tag(IOSAppTab.home)
            .accessibilityIdentifier("tab.home")

            NavigationStack {
                IOSChannelSearchView(
                    session: session,
                    model: model,
                    backend: backend,
                    huddleService: huddleService
                )
            }
            .tabItem { Label("Search", systemImage: "magnifyingglass") }
            .tag(IOSAppTab.search)
            .accessibilityIdentifier("tab.search")

            NavigationStack {
                IOSActivityView(
                    session: session,
                    model: model,
                    backend: backend,
                    huddleService: huddleService,
                    selectedTab: $selectedTab
                )
            }
            .tabItem { Label("Activity", systemImage: "bell") }
            .badge(model.totalMentionCount)
            .tag(IOSAppTab.activity)
            .accessibilityIdentifier("tab.activity")

            NavigationStack(path: $workPath) {
                IOSWorkView(
                    model: workModel,
                    approvalModel: workApprovalModel,
                    channelIDs: bootstrap.channels.filter { !$0.isArchived }.map(\.id),
                    isActive: selectedTab == .work,
                    currentMemberID: session.member.id,
                    workspace: session.workspaceID,
                    members: model.membersByID,
                    backend: backend,
                    developerModeEnabled: $developerModeEnabled
                )
                .navigationDestination(for: IOSPushDeepLink.self) { link in
                    workDestination(link)
                }
            }
            .tabItem { Label("Work", systemImage: "terminal") }
            .tag(IOSAppTab.work)
            .accessibilityIdentifier("tab.work")

            NavigationStack {
                IOSProfileView(
                    session: session,
                    workspaceName: bootstrap.workspace.name,
                    channelListModel: model,
                    developerModeEnabled: $developerModeEnabled,
                    signOut: signOut
                )
            }
            .tabItem { Label("Profile", systemImage: "person.crop.circle") }
            .tag(IOSAppTab.profile)
            .accessibilityIdentifier("tab.profile")
        }
        .task { await model.load() }
    }

    @ViewBuilder
    private func workDestination(_ link: IOSPushDeepLink) -> some View {
        if link.workspaceID != session.workspaceID || !link.opensWorkSession {
            unavailableWorkNotification("This notification does not belong to the active Work space.")
        } else {
            switch workModel.phase {
            case .loading:
                ProgressView("Opening Work session")
                    .navigationTitle("Work")
            case .failed(let failure):
                ContentUnavailableView {
                    Label(
                        failure.isOffline ? "Work unavailable offline" : "Could not load Work",
                        systemImage: failure.isOffline ? "wifi.slash" : "exclamationmark.triangle"
                    )
                } description: {
                    Text(failure.message)
                } actions: {
                    Button("Retry") { Task { await workModel.retry() } }
                }
            case .loaded:
                if let workSession = deepLinkedWorkSession(link) {
                    IOSWorkSessionDetailView(
                        session: workSession,
                        host: workModel.host(for: workSession),
                        currentMemberID: session.member.id,
                        workspace: session.workspaceID,
                        members: model.membersByID,
                        backend: backend
                    )
                } else {
                    unavailableWorkNotification("The session may have expired or is not visible to this member.")
                }
            }
        }
    }

    private func deepLinkedWorkSession(_ link: IOSPushDeepLink) -> IOSWorkSession? {
        let rootID = link.threadRootID ?? link.messageID
        return workModel.sessions.first { $0.rootMessageId == rootID }
    }

    private func unavailableWorkNotification(_ description: String) -> some View {
        ContentUnavailableView(
            "Work session unavailable",
            systemImage: "terminal",
            description: Text(description)
        )
        .navigationTitle("Work")
    }
}

@MainActor
struct IOSConversationDestination: View {
    let item: IOSChannelListItem
    let members: [MemberID: Member]
    let channelListModel: IOSChannelListModel
    let currentMemberID: MemberID
    let backend: any IOSConversationBackend
    let workspace: WorkspaceID
    let huddleService: any IOSHuddleService
    let pushLink: IOSPushDeepLink?

    var body: some View {
        IOSTimelineView(
            item: item,
            members: members,
            currentMemberID: currentMemberID,
            backend: backend,
            workspace: workspace,
            huddleService: huddleService,
            threadRoot: pushLink?.threadRootID,
            focusMessageID: pushLink?.messageID,
            showsComposer: true,
            onReadState: channelListModel.applyReadState
        )
    }
}

@MainActor
private struct IOSChannelSearchView: View {
    let session: IOSSession
    let model: IOSChannelListModel
    let backend: any IOSConversationBackend
    let huddleService: any IOSHuddleService
    @State private var query = ""

    private var results: [IOSChannelListItem] {
        IOSChannelSearch.filter(model.allItems, query: query)
    }

    var body: some View {
        List {
            switch model.phase {
            case .loading:
                Section {
                    ProgressView("Loading conversations")
                }
            case .failed(let failure):
                Section {
                    conversationFailure(failure)
                }
            case .loaded where query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                Section {
                    ContentUnavailableView(
                        "Search your workspace",
                        systemImage: "magnifyingglass",
                        description: Text("Find channels and direct messages by name.")
                    )
                    .accessibilityIdentifier("searchEmpty")
                }
            case .loaded where results.isEmpty:
                Section {
                    ContentUnavailableView.search(text: query)
                        .accessibilityIdentifier("searchNoResults")
                }
            case .loaded:
                Section("Conversations") {
                    ForEach(results) { item in
                        conversationLink(item)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Search")
        .searchable(text: $query, prompt: "Channels and direct messages")
    }

    private func conversationLink(_ item: IOSChannelListItem) -> some View {
        NavigationLink {
            IOSConversationDestination(
                item: item,
                members: model.membersByID,
                channelListModel: model,
                currentMemberID: session.member.id,
                backend: backend,
                workspace: session.workspaceID,
                huddleService: huddleService,
                pushLink: nil
            )
        } label: {
            IOSChannelRow(item: item)
        }
        .accessibilityIdentifier("search.channel.\(item.id.description)")
    }

    private func conversationFailure(_ failure: IOSChannelListModel.Failure) -> some View {
        ContentUnavailableView {
            Label(
                failure.isOffline ? "Search unavailable offline" : "Could not load conversations",
                systemImage: failure.isOffline ? "wifi.slash" : "exclamationmark.triangle"
            )
        } description: {
            Text(failure.message)
        } actions: {
            Button("Retry loading conversations") { Task { await model.load() } }
        }
    }
}

@MainActor
private struct IOSActivityView: View {
    let session: IOSSession
    let model: IOSChannelListModel
    let backend: any IOSConversationBackend
    let huddleService: any IOSHuddleService
    @Binding var selectedTab: IOSAppTab

    private var mentionedConversations: [IOSChannelListItem] {
        model.allItems.filter { $0.mentionCount > 0 }
    }

    var body: some View {
        List {
            switch model.phase {
            case .loading:
                Section { ProgressView("Loading activity") }
            case .failed(let failure):
                Section {
                    ContentUnavailableView {
                        Label(
                            failure.isOffline ? "Activity unavailable offline" : "Could not load activity",
                            systemImage: failure.isOffline ? "wifi.slash" : "exclamationmark.triangle"
                        )
                    } description: {
                        Text(failure.message)
                    } actions: {
                        Button("Retry loading activity") { Task { await model.load() } }
                    }
                }
            case .loaded where mentionedConversations.isEmpty:
                Section {
                    ContentUnavailableView {
                        Label("No new activity", systemImage: "bell")
                    } description: {
                        Text("Mentions, reactions, and approval updates will appear here.")
                    } actions: {
                        Button("Browse channels") { selectedTab = .home }
                    }
                    .accessibilityIdentifier("activityEmpty")
                }
            case .loaded:
                Section("Mentions") {
                    ForEach(mentionedConversations) { item in
                        NavigationLink {
                            IOSConversationDestination(
                                item: item,
                                members: model.membersByID,
                                channelListModel: model,
                                currentMemberID: session.member.id,
                                backend: backend,
                                workspace: session.workspaceID,
                                huddleService: huddleService,
                                pushLink: nil
                            )
                        } label: {
                            IOSChannelRow(item: item)
                        }
                        .accessibilityIdentifier("activity.channel.\(item.id.description)")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Activity")
    }
}

@MainActor
private struct IOSProfileView: View {
    let session: IOSSession
    let workspaceName: String
    let channelListModel: IOSChannelListModel
    @Binding var developerModeEnabled: Bool
    let signOut: @MainActor () async -> Void

    var body: some View {
        Form {
            Section("Account") {
                LabeledContent("Name", value: session.member.displayName)
                LabeledContent("Handle", value: "@\(session.member.handle)")
                LabeledContent("Email", value: session.email)
            }
            Section("Workspace") {
                LabeledContent("Name", value: workspaceName)
                LabeledContent("Server", value: session.baseURL.host ?? session.baseURL.absoluteString)
            }
            Section("Notifications") {
                NavigationLink {
                    IOSNotificationSettingsView(model: channelListModel)
                } label: {
                    Label("Notification settings", systemImage: "bell.badge")
                }
                .accessibilityIdentifier("profileNotificationSettings")
            }
            Section {
                Toggle("Developer Mode", isOn: $developerModeEnabled)
                    .accessibilityIdentifier("profileDeveloperMode")
            } header: {
                Text("Developer")
            } footer: {
                Text("Shows individual remote Work sessions and host status. Session output remains private unless explicitly shared.")
            }
            Section {
                Button("Sign out", role: .destructive) {
                    Task { await signOut() }
                }
                .accessibilityIdentifier("profileSignOut")
            }
        }
        .navigationTitle("Profile")
    }
}

@MainActor
private struct IOSNotificationSettingsView: View {
    let model: IOSChannelListModel
    @State private var actionPreferences = IOSNotificationActionPreferenceStore.shared.load()

    var body: some View {
        Form {
            Section {
                actionToggle(.message, title: "Messages", detail: "Quick reply")
                actionToggle(.mention, title: "Mentions", detail: "Quick reply")
                actionToggle(.approval, title: "Approvals", detail: "Approve or reject")
                actionToggle(.work, title: "Work", detail: "Work notification category")
            } header: {
                Text("Lock Screen actions")
            } footer: {
                Text("These switches change actions shown when you press and hold a notification. They do not stop delivery.")
            }

            Section {
                if model.allItems.isEmpty {
                    Text("No channels are available.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.allItems) { item in
                        Toggle(isOn: channelMuteBinding(item)) {
                            Label(item.title, systemImage: item.isDirectMessage ? "person" : "number")
                        }
                        .disabled(model.isMutating(item.id))
                        .accessibilityIdentifier("notification.channel.\(item.id.description.lowercased())")
                    }
                }
            } header: {
                Text("Channel delivery")
            } footer: {
                Text("Turn a switch off to mute all push notifications for that channel, including mentions. Unread counts are unchanged.")
            }

            Section {
                Button("Open iOS notification settings") {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    UIApplication.shared.open(url)
                }
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .alert(
            "Notification update failed",
            isPresented: Binding(
                get: { model.actionFailureMessage != nil },
                set: { if !$0 { model.clearActionFailure() } }
            )
        ) {
            Button("Dismiss", role: .cancel) { model.clearActionFailure() }
        } message: {
            Text(model.actionFailureMessage ?? "Try again.")
        }
    }

    private func actionToggle(
        _ category: MomoPushCategory,
        title: String,
        detail: String
    ) -> some View {
        Toggle(isOn: actionPreferenceBinding(category)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("notification.action.\(category.rawValue)")
    }

    private func actionPreferenceBinding(_ category: MomoPushCategory) -> Binding<Bool> {
        Binding(
            get: { actionPreferences.isEnabled(category) },
            set: { enabled in
                actionPreferences.set(category, enabled: enabled)
                IOSNotificationActionPreferenceStore.shared.save(actionPreferences)
                IOSNotificationCategoryRegistry.register(preferences: actionPreferences)
            }
        )
    }

    private func channelMuteBinding(_ item: IOSChannelListItem) -> Binding<Bool> {
        Binding(
            get: { !item.isMuted },
            set: { receivesNotifications in
                Task { await model.setChannelMuted(item.id, muted: !receivesNotifications) }
            }
        )
    }
}

#endif
