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
    @State private var searchModel: IOSWorkspaceSearchModel
    @State private var activityModel: IOSActivityModel
    @State private var workModel: IOSWorkListModel
    @State private var workApprovalModel: IOSWorkApprovalInboxModel
    @State private var membershipModel: IOSMembershipAdministrationModel
    @AppStorage("momo.ios.developer-mode") private var developerModeEnabled = false

    public init(
        session: IOSSession,
        bootstrap: WorkspaceBootstrap,
        selectedTab: Binding<IOSAppTab>,
        homePath: Binding<[IOSPushDeepLink]>,
        workPath: Binding<[IOSPushDeepLink]>,
        signOut: @escaping @MainActor () async -> Void
    ) {
        let requestExecutor = IOSAuthenticatedRequestExecutor(authenticated: session)
        let backend = MomoServerConversationClient(
            authenticated: session,
            requestExecutor: requestExecutor
        )
        self.session = session
        self.bootstrap = bootstrap
        self.signOut = signOut
        self.backend = backend
        self.huddleService = IOSHuddleRESTService(
            authenticated: session,
            requestExecutor: requestExecutor
        )
        _selectedTab = selectedTab
        _homePath = homePath
        _workPath = workPath
        _model = State(initialValue: IOSChannelListModel(currentMemberID: session.member.id, backend: backend))
        _searchModel = State(initialValue: IOSWorkspaceSearchModel(backend: backend))
        _activityModel = State(initialValue: IOSActivityModel(backend: backend, currentMemberID: session.member.id))
        _workModel = State(initialValue: IOSWorkListModel(backend: backend))
        _workApprovalModel = State(initialValue: IOSWorkApprovalInboxModel(backend: backend))
        _membershipModel = State(initialValue: IOSMembershipAdministrationModel(backend: backend))
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
                    searchModel: searchModel,
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
                    activityModel: activityModel,
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
                    membershipModel: membershipModel,
                    backend: backend,
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
    let focusedMessageID: MessageID?
    let focusedSequence: Int64?

    init(
        item: IOSChannelListItem,
        members: [MemberID: Member],
        channelListModel: IOSChannelListModel,
        currentMemberID: MemberID,
        backend: any IOSConversationBackend,
        workspace: WorkspaceID,
        huddleService: any IOSHuddleService,
        pushLink: IOSPushDeepLink?,
        focusedMessageID: MessageID? = nil,
        focusedSequence: Int64? = nil
    ) {
        self.item = item
        self.members = members
        self.channelListModel = channelListModel
        self.currentMemberID = currentMemberID
        self.backend = backend
        self.workspace = workspace
        self.huddleService = huddleService
        self.pushLink = pushLink
        self.focusedMessageID = focusedMessageID
        self.focusedSequence = focusedSequence
    }

    var body: some View {
        IOSTimelineView(
            item: item,
            members: members,
            currentMemberID: currentMemberID,
            backend: backend,
            workspace: workspace,
            huddleService: huddleService,
            threadRoot: pushLink?.threadRootID,
            focusMessageID: focusedMessageID ?? pushLink?.messageID,
            focusSequence: focusedSequence,
            showsComposer: true,
            onReadState: channelListModel.applyReadState
        )
    }
}

@MainActor
private struct IOSChannelSearchView: View {
    let session: IOSSession
    let model: IOSChannelListModel
    let searchModel: IOSWorkspaceSearchModel
    let backend: any IOSConversationBackend
    let huddleService: any IOSHuddleService
    @State private var query = ""

    private var results: [IOSChannelListItem] {
        IOSChannelSearch.filter(model.allItems, query: query)
    }

    private var normalizedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var visibleMessageHits: [IOSWorkspaceMessageSearchHit] {
        searchModel.hits.filter { hit in model.allItems.contains(where: { $0.id == hit.channelID }) }
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
            case .loaded where normalizedQuery.isEmpty:
                Section {
                    ContentUnavailableView(
                        "Search your workspace",
                        systemImage: "magnifyingglass",
                        description: Text("Find conversations and messages across your workspace.")
                    )
                    .accessibilityIdentifier("searchEmpty")
                }
            case .loaded:
                if !results.isEmpty {
                    Section("Conversations") {
                        ForEach(results) { item in
                            conversationLink(item)
                        }
                    }
                }
                if normalizedQuery.count == 1 {
                    Section {
                        Label("Type one more character to search messages.", systemImage: "text.magnifyingglass")
                            .foregroundStyle(.secondary)
                    }
                }
                if let failureMessage = searchModel.failureMessage {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Label(failureMessage, systemImage: "exclamationmark.triangle")
                                .foregroundStyle(.secondary)
                            Button("Retry message search") { Task { await searchModel.retry() } }
                        }
                    }
                }
                if !visibleMessageHits.isEmpty {
                    Section("Messages") {
                        ForEach(visibleMessageHits) { hit in
                            messageLink(hit)
                        }
                        if searchModel.hasMore {
                            Button {
                                Task { await searchModel.loadMore() }
                            } label: {
                                HStack {
                                    Spacer()
                                    if searchModel.phase == .searching {
                                        ProgressView()
                                    } else {
                                        Text("Load more messages")
                                    }
                                    Spacer()
                                }
                            }
                            .disabled(searchModel.phase == .searching)
                        }
                    }
                } else if normalizedQuery.count >= 2, searchModel.phase == .searching {
                    Section { ProgressView("Searching messages") }
                } else if normalizedQuery.count >= 2,
                          searchModel.phase == .loaded,
                          results.isEmpty,
                          searchModel.failureMessage == nil {
                    Section {
                        ContentUnavailableView.search(text: query)
                            .accessibilityIdentifier("searchNoResults")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Search")
        .searchable(text: $query, prompt: "Channels, people, and messages")
        .onChange(of: query) { _, newValue in searchModel.schedule(query: newValue) }
    }

    @ViewBuilder
    private func messageLink(_ hit: IOSWorkspaceMessageSearchHit) -> some View {
        if let item = model.allItems.first(where: { $0.id == hit.channelID }) {
            NavigationLink {
                IOSConversationDestination(
                    item: item,
                    members: model.membersByID,
                    channelListModel: model,
                    currentMemberID: session.member.id,
                    backend: backend,
                    workspace: session.workspaceID,
                    huddleService: huddleService,
                    pushLink: nil,
                    focusedMessageID: hit.messageID,
                    focusedSequence: hit.sequence
                )
            } label: {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Label(item.title, systemImage: item.isDirectMessage ? "person" : "number")
                            .font(.subheadline.weight(.semibold))
                        if let author = model.membersByID[hit.authorMemberID] {
                            Text(author.displayName)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(Date(timeIntervalSince1970: TimeInterval(hit.createdAtMs) / 1_000), style: .date)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    highlightedSnippet(hit)
                        .font(.body)
                        .lineLimit(3)
                }
                .padding(.vertical, 4)
            }
            .accessibilityIdentifier("search.message.\(hit.messageID.description)")
        }
    }

    private func highlightedSnippet(_ hit: IOSWorkspaceMessageSearchHit) -> Text {
        let segments = IOSSearchSnippet.segments(
            snippet: hit.snippet,
            matchOffset: hit.matchOffset,
            matchLength: max(searchModel.normalizedQuery.count, 1)
        )
        return Text(segments.prefix)
            + Text(segments.match).bold().foregroundColor(.accentColor)
            + Text(segments.suffix)
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
    let activityModel: IOSActivityModel
    let backend: any IOSConversationBackend
    let huddleService: any IOSHuddleService
    @Binding var selectedTab: IOSAppTab

    private var visibleItems: [IOSActivityItem] {
        activityModel.items.filter { activity in
            model.allItems.contains(where: { $0.id == activity.channelID })
        }
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
            case .loaded where visibleItems.isEmpty && activityModel.isLoading:
                Section { ProgressView("Loading recent activity") }
            case .loaded where visibleItems.isEmpty:
                Section {
                    if let failureMessage = activityModel.failureMessage {
                        ContentUnavailableView {
                            Label("Could not refresh activity", systemImage: "exclamationmark.triangle")
                        } description: {
                            Text(failureMessage)
                        } actions: {
                            Button("Retry activity") {
                                Task { await activityModel.refresh(channelIDs: model.allItems.map(\.id)) }
                            }
                        }
                    } else {
                        ContentUnavailableView {
                            Label("No new activity", systemImage: "bell")
                        } description: {
                            Text("Recent mentions and reactions to your messages will appear here.")
                        } actions: {
                            Button("Browse channels") { selectedTab = .home }
                        }
                        .accessibilityIdentifier("activityEmpty")
                    }
                }
            case .loaded:
                if let failureMessage = activityModel.failureMessage {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Label(failureMessage, systemImage: "exclamationmark.triangle")
                                .foregroundStyle(.secondary)
                            Button("Retry activity") {
                                Task { await activityModel.refresh(channelIDs: model.allItems.map(\.id)) }
                            }
                        }
                    }
                }
                Section("Recent") {
                    ForEach(visibleItems) { activity in
                        activityLink(activity)
                    }
                }
                Section {
                    Text("Recent activity is derived on this device from the latest 200 messages in each conversation.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Activity")
        .task(id: model.allItems.map(\.id)) {
            guard case .loaded = model.phase else { return }
            await activityModel.refresh(channelIDs: model.allItems.map(\.id))
        }
        .refreshable {
            await model.refresh()
            await activityModel.refresh(channelIDs: model.allItems.map(\.id))
        }
    }

    @ViewBuilder
    private func activityLink(_ activity: IOSActivityItem) -> some View {
        if let item = model.allItems.first(where: { $0.id == activity.channelID }) {
            NavigationLink {
                IOSConversationDestination(
                    item: item,
                    members: model.membersByID,
                    channelListModel: model,
                    currentMemberID: session.member.id,
                    backend: backend,
                    workspace: session.workspaceID,
                    huddleService: huddleService,
                    pushLink: nil,
                    focusedMessageID: activity.messageID,
                    focusedSequence: activity.sequence
                )
            } label: {
                HStack(alignment: .top, spacing: 12) {
                    activityIcon(activity.kind)
                        .font(.title3)
                        .frame(width: 28, height: 28)
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(activityTitle(activity.kind))
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                            Text(Date(timeIntervalSince1970: TimeInterval(activity.createdAtMs) / 1_000), style: .relative)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Text(activity.preview)
                            .lineLimit(2)
                        Text(item.title)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 3)
            }
            .accessibilityIdentifier("activity.message.\(activity.messageID.description)")
        }
    }

    @ViewBuilder
    private func activityIcon(_ kind: IOSActivityItem.Kind) -> some View {
        switch kind {
        case .mention:
            Image(systemName: "at")
                .foregroundStyle(Color.accentColor)
        case .reaction(let emoji, _):
            Text(emoji)
        }
    }

    private func activityTitle(_ kind: IOSActivityItem.Kind) -> String {
        switch kind {
        case .mention: "Mentioned you"
        case .reaction(let emoji, let count): "\(emoji) reaction · \(count)"
        }
    }
}

@MainActor
private struct IOSProfileView: View {
    let session: IOSSession
    let workspaceName: String
    let channelListModel: IOSChannelListModel
    let membershipModel: IOSMembershipAdministrationModel
    let backend: MomoServerConversationClient
    @Binding var developerModeEnabled: Bool
    let signOut: @MainActor () async -> Void
    @State private var showsLeaveWorkspaceConfirmation = false
    @State private var leaveWorkspaceError: String?
    @State private var leaveWorkspaceInFlight = false
    private let copy = IOSWorkspaceCopy.current

    private var currentMember: Member {
        channelListModel.membersByID[session.member.id] ?? session.member
    }

    private var canManageMembers: Bool {
        currentMember.workspaceRole == .owner || currentMember.workspaceRole == .admin
    }

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
                LabeledContent(copy.role, value: copy.roleTitle(currentMember.workspaceRole))
                if canManageMembers {
                    NavigationLink {
                        IOSMemberManagementView(
                            session: session,
                            channelListModel: channelListModel,
                            model: membershipModel
                        )
                    } label: {
                        Label(copy.membersAndAudit, systemImage: "person.2.badge.gearshape")
                    }
                    .accessibilityIdentifier("profileMemberManagement")
                }
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
                if leaveWorkspaceError != nil {
                    Label(copy.leaveWorkspaceFailed, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
                Button(copy.leaveWorkspace, role: .destructive) {
                    showsLeaveWorkspaceConfirmation = true
                }
                .disabled(leaveWorkspaceInFlight)
                .accessibilityIdentifier("profileLeaveWorkspace")
                Button("Sign out", role: .destructive) {
                    Task { await signOut() }
                }
                .accessibilityIdentifier("profileSignOut")
            }
        }
        .navigationTitle("Profile")
        .confirmationDialog(
            copy.leaveWorkspaceQuestion(workspaceName),
            isPresented: $showsLeaveWorkspaceConfirmation,
            titleVisibility: .visible
        ) {
            Button(copy.leaveWorkspace, role: .destructive) {
                Task { await leaveWorkspace() }
            }
            Button(copy.cancel, role: .cancel) {}
        } message: {
            Text(currentMember.workspaceRole == .owner
                 ? copy.lastOwnerLeaveExplanation
                 : copy.leaveWorkspaceExplanation)
        }
    }

    private func leaveWorkspace() async {
        guard !leaveWorkspaceInFlight else { return }
        leaveWorkspaceInFlight = true
        leaveWorkspaceError = nil
        defer { leaveWorkspaceInFlight = false }
        do {
            try await backend.leaveWorkspace()
            await signOut()
        } catch {
            leaveWorkspaceError = error.localizedDescription
        }
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
