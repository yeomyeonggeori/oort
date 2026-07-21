#if os(iOS)
import MomoCore
import SwiftUI

@MainActor
public struct IOSWorkspaceView: View {
    private let session: IOSSession
    private let bootstrap: WorkspaceBootstrap
    private let signOut: @MainActor () async -> Void
    private let backend: any IOSConversationBackend
    private let huddleService: any IOSHuddleService
    @Binding private var selectedTab: IOSAppTab
    @Binding private var homePath: [IOSPushDeepLink]
    @State private var model: IOSChannelListModel
    @State private var workModel: IOSWorkListModel
    @AppStorage("momo.ios.developer-mode") private var developerModeEnabled = false

    public init(
        session: IOSSession,
        bootstrap: WorkspaceBootstrap,
        selectedTab: Binding<IOSAppTab>,
        homePath: Binding<[IOSPushDeepLink]>,
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
        _model = State(initialValue: IOSChannelListModel(currentMemberID: session.member.id, backend: backend))
        _workModel = State(initialValue: IOSWorkListModel(backend: backend))
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

            NavigationStack {
                IOSWorkView(
                    model: workModel,
                    channelIDs: bootstrap.channels.filter { !$0.isArchived }.map(\.id),
                    isActive: selectedTab == .work,
                    developerModeEnabled: $developerModeEnabled
                )
            }
            .tabItem { Label("Work", systemImage: "terminal") }
            .tag(IOSAppTab.work)
            .accessibilityIdentifier("tab.work")

            NavigationStack {
                IOSProfileView(
                    session: session,
                    workspaceName: bootstrap.workspace.name,
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

    var body: some View {
        IOSTimelineView(
            item: item,
            members: members,
            currentMemberID: currentMemberID,
            backend: backend,
            workspace: workspace,
            huddleService: huddleService,
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
                huddleService: huddleService
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
                                huddleService: huddleService
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

struct IOSThreadsPlaceholderView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ContentUnavailableView {
            Label("No thread activity", systemImage: "bubble.left.and.text.bubble.right")
        } description: {
            Text("Replies to conversations you participate in will appear here.")
        } actions: {
            Button("Browse channels") { dismiss() }
        }
        .navigationTitle("Threads")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("threadsEmpty")
    }
}
#endif
