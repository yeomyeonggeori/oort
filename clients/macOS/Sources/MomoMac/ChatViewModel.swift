import Foundation
import SwiftUI
import MomoCore

public protocol MomoSessionSensitiveStateClearing: Sendable {
    func clearSessionSensitiveState() async
}

protocol AuthenticatedMemberIDProvidingBackend: Sendable {
    func authenticatedMemberID() async -> MemberID?
}

protocol WorkspaceIdentityCacheScopeProviding: Sendable {
    func workspaceIdentityCacheServerScope() async -> String
}

/// Marker for backends whose member identity and channel scope must remain
/// server-owned. Local demo profile hints are never merged into these rosters.
public protocol ServerRosterSourceOfTruth: Sendable {}

public enum DogfoodAgentInviteError: Error, LocalizedError {
    case selectChannelFirst
    case unsupportedAlias(String)
    case missingHermesAgent

    public var errorDescription: String? {
        switch self {
        case .selectChannelFirst:
            return "Select a channel before inviting Hermes."
        case .unsupportedAlias(let alias):
            return "Dogfood v0 only supports @hermes. \(alias) needs the server alias API first."
        case .missingHermesAgent:
            return "Hermes runtime member is not available. Start local alpha or run the Hermes gateway setup first."
        }
    }
}

public struct AgentWorkingState: Identifiable, Sendable, Equatable {
    public var id: MemberID { memberId }
    public var memberId: MemberID
    public var channelId: ChannelID
    public var message: String

    public init(memberId: MemberID, channelId: ChannelID, message: String) {
        self.memberId = memberId
        self.channelId = channelId
        self.message = message
    }
}

public struct TypingActivity: Identifiable, Sendable, Equatable {
    public var id: MemberID { memberId }
    public var memberId: MemberID
    public var channelId: ChannelID
    public var isLocalEcho: Bool

    public init(memberId: MemberID, channelId: ChannelID, isLocalEcho: Bool = false) {
        self.memberId = memberId
        self.channelId = channelId
        self.isLocalEcho = isLocalEcho
    }
}

public enum AgentWorkSurfaceError: Sendable, Equatable, CaseIterable {
    case channelRequired
    case unsupportedServer
    case activeAgentRequired
    case titleRequired
    case briefRequired
    case creationFailed
    case historyFailed
    case detailFailed
}

public enum MomoConnectionIssue: Sendable, Equatable {
    case authenticationExpired
    case loadFailed
    case sendFailed
    case actionFailed
}

public enum MomoChannelCreateIssue: Sendable, Equatable {
    case invalidInput
    case duplicateName
    case permissionDenied
    case connection
    case unavailable
}

public enum WorkspaceNameUpdateIssue: Sendable, Equatable {
    case unavailable
    case invalidName
    case reloadRequired
    case conflict
    case authenticationExpired
    case forbidden
    case connection
}

public enum MomoDirectMessageOpenOutcome: Sendable, Equatable {
    case opened(ChannelID)
    case ignored
    case failed
}

// MARK: - ChatViewModel
//
// The single source of UI state for the macOS demo. Drives ChannelListView,
// MessageListView, MessageBubble, AgentPartialView, CostBreathingRing,
// ApprovalInboxView. Holds a `ChatBackend` + `AgentTransport` (MomoCore §5.3 / §6.1)
// — here `LiveChatBackend` (in-memory stub), later the real REST + SwiftCentrifuge.
// Approval decisions are sent through `ChatBackend` because they are timeline
// writes/audit intents rather than agent-stream transport events.
//
// Threading: @MainActor ObservableObject. Realtime events arrive on the backend's
// AsyncStream and are applied on the main actor. Ordering authority = Message.seq
// (L4 §1.2 #3): the message list is always re-sorted by seq.

@MainActor
public final class ChatViewModel: ObservableObject {
    private static let maximumMarkReadFailures = 5
    private static let workspaceCachePrefix = "momo.workspace.identity."

    private struct PendingMessageSend: Sendable {
        let draft: DraftMessage
        let clientMsgId: UUID
        let mentionedAgent: Member?
    }

    private struct AgentCredentialRefresh {
        let id: UUID
        let task: Task<[MomoAgentCredential], Error>
    }

    private enum ChannelCreateSessionState: Equatable {
        case disconnected
        case transitioning
        case ready(WorkspaceID)
    }

    // Backend contracts (same instance conforms to both, but typed separately).
    private let chat: any ChatBackend
    private let workspaceBackend: (any WorkspaceBackend)?
    private let readStateBackend: (any ReadStateBackend)?
    private let agentTransport: any AgentTransport
    private let workRunBackend: (any AgentWorkRunBackend)?
    private let onboarding: (any OnboardingInviteBackend)?
    private let agentCredentialBackend: (any MomoAgentCredentialBackend)?
    private let localContextCopilot: LocalContextCopilotService
    private let readStateDebounce: Duration
    private let workspaceIdentityDefaults: UserDefaults
    public let usesServerRosterSourceOfTruth: Bool

    public var allowsLocalProfileEditing: Bool {
        !usesServerRosterSourceOfTruth
    }

    // Workspace context.
    @Published public private(set) var workspaceId: WorkspaceID?
    @Published public private(set) var workspace: Workspace?
    @Published public private(set) var workspaceIdentityUsesCache = false
    @Published public private(set) var workspaceNameUpdateInFlight = false
    @Published public private(set) var workspaceNameUpdateError: String?
    @Published public private(set) var workspaceNameUpdateIssue: WorkspaceNameUpdateIssue?
    @Published public private(set) var members: [Member] = []
    @Published public private(set) var channels: [Channel] = []
    @Published public var selectedChannelId: ChannelID?
    @Published public private(set) var recentChannelIds: [ChannelID] = []
    @Published public private(set) var readStatesByChannel: [ChannelID: ChannelReadState] = [:]
    @Published public private(set) var readStateSyncError: String?

    // Per-channel message store (kept seq-sorted on insert).
    @Published public private(set) var messagesByChannel: [ChannelID: [Message]] = [:]
    @Published private(set) var historyLoadingChannels: Set<ChannelID> = []

    // Live agent state for the selected channel.
    /// In-flight `agent.partial` buffers, keyed by run, for AgentPartialView (L4 §5.2).
    @Published public private(set) var partials: [RunID: AgentPartial] = [:]
    /// Latest `agent.status` per run, drives CostBreathingRing + presence (L4 §5.2).
    @Published public private(set) var agentStatuses: [RunID: AgentStatus] = [:]
    /// Server-owned cost projection per run. Experience B consumes this instead
    /// of deriving ledger/budget math in the client.
    @Published public private(set) var costSnapshots: [RunID: CostSnapshot] = [:]
    @Published public private(set) var realtimeStatuses: [ChannelID: RealtimeConnectionStatus] = [:]
    @Published public private(set) var agentRuntimeStatus: AgentRuntimeStatus = .localMock
    @Published public private(set) var agentWorkingStates: [MemberID: AgentWorkingState] = [:]
    @Published public private(set) var typingStates: [ChannelID: [MemberID: TypingActivity]] = [:]
    @Published public var composerDraft: String = ""
    @Published public private(set) var mentionNotice: String?

    // Work v0 is an optional projection over the existing agent_run contract.
    @Published public private(set) var workRunsByChannel: [ChannelID: [AgentWorkRun]] = [:]
    @Published public private(set) var workRunLoadingChannels: Set<ChannelID> = []
    @Published public private(set) var workRunDetailLoadingIds: Set<RunID> = []
    @Published public private(set) var isCreatingWorkRun = false
    @Published public private(set) var workCreationError: AgentWorkSurfaceError?
    @Published public private(set) var workHistoryErrorsByChannel: [ChannelID: AgentWorkSurfaceError] = [:]
    @Published public private(set) var workDetailErrorsById: [RunID: AgentWorkSurfaceError] = [:]

    // Approval inbox (experience C). Keyed by approval id, newest first in view.
    @Published public private(set) var approvals: [ApprovalID: ApprovalEvent] = [:]
    @Published public private(set) var approvalDecisionsInFlight: Set<ApprovalID> = []
    @Published public private(set) var channelCreateInFlight = false
    @Published public private(set) var channelCreateIssue: MomoChannelCreateIssue?
    @Published private(set) var channelCreateSessionGeneration: UInt64 = 0
    @Published public private(set) var channelMemberMutationIds: Set<MemberID> = []
    @Published public private(set) var directMessageMutationIds: Set<MemberID> = []
    @Published public private(set) var directMessageError: String?
    @Published public private(set) var memberDirectoryIsRefreshing = false
    @Published public private(set) var memberDirectoryError: String?
    @Published private(set) var agentCredentialsByMember: [MemberID: [MomoAgentCredential]] = [:]
    @Published private(set) var agentCredentialLoadingMembers: Set<MemberID> = []

    // Onboarding / invite flow v0. The dev app drives this through LiveChatBackend
    // until the production REST join API lands.
    @Published public private(set) var inviteJoinState: InviteJoinState = .idle

    // macOS-only local model capability. Apple framework calls stay in this target;
    // MomoCore remains Foundation-only.
    @Published public private(set) var foundationModelsCapability: FoundationModelsCapabilityState
    @Published public private(set) var localContextCopilotPreview: LocalContextCopilotPreview?
    @Published public private(set) var isLocalContextCopilotRefreshing = false

    /// Diagnostic text remains available to developer surfaces and tests, but
    /// user-facing chrome renders only the typed, redacted issue grammar.
    @Published public private(set) var connectionError: String?
    @Published public private(set) var connectionIssue: MomoConnectionIssue?

    private var channelSubscriptions: [ChannelID: Task<Void, Never>] = [:]
    private var channelSubscriptionTokens: [ChannelID: UUID] = [:]
    private var realtimeStatusSubscription: Task<Void, Never>?
    private var realtimeStatusSubscriptionToken: UUID?
    private var readStateSubscription: Task<Void, Never>?
    private var readStateSubscriptionToken: UUID?
    private var readStateRefreshTask: Task<Void, Never>?
    private var markReadTasks: [ChannelID: Task<Void, Never>] = [:]
    private var pendingReadSequences: [ChannelID: Int64] = [:]
    private var markReadFailureCounts: [ChannelID: Int] = [:]
    private var channelNavigationHistory: [ChannelID] = []
    private var channelNavigationIndex: Int?
    private var authenticatedMemberId: MemberID?
    private var activeTimelineChannelId: ChannelID?
    private var pendingFallbackMentionRuns: [ChannelID: Set<RunID>] = [:]
    private var localTypingChannels: Set<ChannelID> = []
    private var typingStopTasks: [ChannelID: Task<Void, Never>] = [:]
    private var agentCredentialRefreshes: [MemberID: AgentCredentialRefresh] = [:]
    private var failedMessageSend: PendingMessageSend?
    private var workspaceIdentityCacheScope: String?
    private var workspaceIdentitySessionGeneration: UInt64 = 0
    private var workspaceIdentityLoadGeneration: UInt64 = 0
    private var workspaceNameUpdateGeneration: UInt64 = 0
    private var channelCreateOperationGeneration: UInt64 = 0
    private var channelCreateSessionState: ChannelCreateSessionState = .disconnected
    private var directMessageOperationTokens: [MemberID: UUID] = [:]
    private var navigationIntentGeneration: UInt64 = 0

    var activeChannelSubscriptionCount: Int { channelSubscriptions.count }

    /// Redacted user-facing context for a failed agent mention. Raw transport
    /// diagnostics remain isolated in `connectionError`.
    public var failedMentionedAgentName: String? {
        failedMessageSend?.mentionedAgent?.displayName
    }

    public var authenticatedMember: Member? {
        guard let authenticatedMemberId else { return nil }
        return members.first { $0.id == authenticatedMemberId }
    }

    public var canManageWorkspace: Bool {
        authenticatedMember?.workspaceRole == .owner || authenticatedMember?.workspaceRole == .admin
    }

    public init(
        chat: any ChatBackend,
        agentTransport: any AgentTransport,
        onboarding: (any OnboardingInviteBackend)? = nil,
        foundationModelsCapability: FoundationModelsCapabilityState = FoundationModelsCapabilityProbe().currentState(),
        localContextCopilot: LocalContextCopilotService = LocalContextCopilotService(),
        readStateDebounce: Duration = .seconds(1),
        workspaceIdentityDefaults: UserDefaults = .standard
    ) {
        self.chat = chat
        self.workspaceBackend = chat as? any WorkspaceBackend
        self.readStateBackend = chat as? any ReadStateBackend
        self.agentTransport = agentTransport
        self.workRunBackend = chat as? any AgentWorkRunBackend
        self.onboarding = onboarding
        self.agentCredentialBackend = chat as? any MomoAgentCredentialBackend
        self.usesServerRosterSourceOfTruth = chat is any ServerRosterSourceOfTruth
        self.foundationModelsCapability = foundationModelsCapability
        self.localContextCopilot = localContextCopilot
        self.readStateDebounce = readStateDebounce
        self.workspaceIdentityDefaults = workspaceIdentityDefaults
    }

    /// Convenience initializer when one object conforms to both contracts.
    public convenience init(backend: LiveChatBackend) {
        self.init(chat: backend, agentTransport: backend, onboarding: backend)
    }

    // MARK: Lifecycle

    /// Connect + load workspace roster/channels. Selects the first channel.
    public func bootstrap(workspace: WorkspaceID, accessToken: String) async {
        invalidateChannelCreationForSessionChange()
        workspaceIdentitySessionGeneration &+= 1
        workspaceIdentityLoadGeneration &+= 1
        let identitySessionGeneration = workspaceIdentitySessionGeneration
        channelSubscriptions.values.forEach { $0.cancel() }
        channelSubscriptions = [:]
        channelSubscriptionTokens = [:]
        readStateSubscription?.cancel()
        readStateSubscription = nil
        readStateSubscriptionToken = nil
        realtimeStatusSubscription?.cancel()
        realtimeStatusSubscription = nil
        realtimeStatusSubscriptionToken = nil
        do {
            try await chat.connect(workspace: workspace, accessToken: accessToken)
            guard workspaceIdentitySessionGeneration == identitySessionGeneration else { return }
            self.workspaceId = workspace
            let loadedMembers = try await chat.members(workspace: workspace)
            guard isWorkspaceIdentitySessionCurrent(identitySessionGeneration, workspaceID: workspace) else {
                return
            }
            self.members = usesServerRosterSourceOfTruth
                ? loadedMembers
                : applyLocalProfileHints(to: loadedMembers)
            let memberProvider = chat as? any AuthenticatedMemberIDProvidingBackend
            let resolvedMemberID = await memberProvider?.authenticatedMemberID()
                ?? self.members.first { $0.kind == .human && $0.status == .active }?.id
            guard isWorkspaceIdentitySessionCurrent(identitySessionGeneration, workspaceID: workspace) else {
                return
            }
            authenticatedMemberId = resolvedMemberID
            let serverScope = await (chat as? any WorkspaceIdentityCacheScopeProviding)?
                .workspaceIdentityCacheServerScope()
            guard isWorkspaceIdentitySessionCurrent(identitySessionGeneration, workspaceID: workspace) else {
                return
            }
            if let serverScope, let authenticatedMemberId {
                workspaceIdentityCacheScope = "\(serverScope)|\(authenticatedMemberId.description)"
            } else {
                workspaceIdentityCacheScope = nil
            }
            async let workspaceIdentityLoad: Void = loadWorkspaceIdentity(
                workspace,
                sessionGeneration: identitySessionGeneration
            )
            let loadedChannels = try await chat.channels(workspace: workspace)
            guard isWorkspaceIdentitySessionCurrent(identitySessionGeneration, workspaceID: workspace) else {
                return
            }
            await workspaceIdentityLoad
            guard isWorkspaceIdentitySessionCurrent(identitySessionGeneration, workspaceID: workspace) else {
                return
            }
            self.channels = loadedChannels
            if let readStateBackend {
                do {
                    let states = try await readStateBackend.readStates(workspace: workspace)
                    guard isWorkspaceIdentitySessionCurrent(identitySessionGeneration, workspaceID: workspace) else {
                        return
                    }
                    var authoritative = Dictionary(uniqueKeysWithValues: states.map { ($0.channelId, $0) })
                    for channel in loadedChannels where authoritative[channel.id] == nil {
                        authoritative[channel.id] = Self.emptyReadState(channel: channel.id)
                    }
                    readStatesByChannel = authoritative
                    readStateSyncError = nil
                } catch {
                    guard isWorkspaceIdentitySessionCurrent(identitySessionGeneration, workspaceID: workspace) else {
                        return
                    }
                    guard !Self.isCancellation(error) else { return }
                    readStateSyncError = String(describing: error)
                }
            } else {
                for channel in loadedChannels {
                    ensureReadStateExists(channel: channel.id)
                }
            }
            if let provider = chat as? any AgentRuntimeStatusProviding {
                do {
                    let status = try await provider.agentRuntimeStatus()
                    guard isWorkspaceIdentitySessionCurrent(identitySessionGeneration, workspaceID: workspace) else {
                        return
                    }
                    agentRuntimeStatus = status
                } catch {
                    guard isWorkspaceIdentitySessionCurrent(identitySessionGeneration, workspaceID: workspace) else {
                        return
                    }
                    guard !Self.isCancellation(error) else { return }
                    agentRuntimeStatus = AgentRuntimeStatus(
                        availability: .degraded,
                        endpointLabel: "status unavailable",
                        diagnostics: [String(describing: error)]
                    )
                }
            } else {
                agentRuntimeStatus = .localMock
            }
            do {
                let pending = try await chat.pendingApprovals(workspace: workspace, status: .pending)
                guard isWorkspaceIdentitySessionCurrent(identitySessionGeneration, workspaceID: workspace) else {
                    return
                }
                approvals = Dictionary(
                    uniqueKeysWithValues: pending.map { ($0.id, $0.eventProjection) }
                )
            } catch {
                guard isWorkspaceIdentitySessionCurrent(identitySessionGeneration, workspaceID: workspace) else {
                    return
                }
                guard !Self.isCancellation(error) else { return }
                reportConnectionError(error)
            }
            if !channels.contains(where: { $0.id == selectedChannelId }) {
                self.selectedChannelId = channels.first?.id
            }
            if let selectedChannelId {
                recordChannelSelection(selectedChannelId)
            }
            subscribeReadStateUpdates(
                sessionGeneration: identitySessionGeneration,
                workspaceID: workspace
            )
            for channel in channels {
                subscribe(
                    channel: channel.id,
                    sessionGeneration: identitySessionGeneration,
                    workspaceID: workspace
                )
            }
            channelCreateSessionState = .ready(workspace)
            clearConnectionErrorState(force: true)
        } catch {
            guard workspaceIdentitySessionGeneration == identitySessionGeneration else { return }
            if Self.isCancellation(error) {
                channelCreateSessionState = .disconnected
                return
            }
            channelCreateSessionState = .disconnected
            reportConnectionError(error)
        }
    }

    public func clearSessionSensitiveState() async {
        invalidateChannelCreationForSessionChange()
        workspaceIdentitySessionGeneration &+= 1
        navigationIntentGeneration &+= 1
        workspaceIdentityLoadGeneration &+= 1
        workspaceNameUpdateGeneration &+= 1
        channelSubscriptions.values.forEach { $0.cancel() }
        readStateSubscription?.cancel()
        readStateRefreshTask?.cancel()
        markReadTasks.values.forEach { $0.cancel() }
        realtimeStatusSubscription?.cancel()
        channelSubscriptions = [:]
        channelSubscriptionTokens = [:]
        readStateSubscription = nil
        readStateSubscriptionToken = nil
        readStateRefreshTask = nil
        markReadTasks = [:]
        pendingReadSequences = [:]
        markReadFailureCounts = [:]
        realtimeStatusSubscription = nil
        realtimeStatusSubscriptionToken = nil
        if let resettable = chat as? any MomoSessionSensitiveStateClearing {
            await resettable.clearSessionSensitiveState()
        }
        if let resettable = agentTransport as? any MomoSessionSensitiveStateClearing {
            await resettable.clearSessionSensitiveState()
        }
        workspaceId = nil
        workspace = nil
        workspaceNameUpdateInFlight = false
        workspaceNameUpdateError = nil
        workspaceNameUpdateIssue = nil
        workspaceIdentityUsesCache = false
        members = []
        channels = []
        selectedChannelId = nil
        recentChannelIds = []
        readStatesByChannel = [:]
        readStateSyncError = nil
        channelNavigationHistory = []
        channelNavigationIndex = nil
        authenticatedMemberId = nil
        workspaceIdentityCacheScope = nil
        activeTimelineChannelId = nil
        messagesByChannel = [:]
        historyLoadingChannels = []
        partials = [:]
        agentStatuses = [:]
        costSnapshots = [:]
        realtimeStatuses = [:]
        agentRuntimeStatus = .localMock
        agentWorkingStates = [:]
        agentCredentialsByMember = [:]
        agentCredentialLoadingMembers = []
        agentCredentialRefreshes.values.forEach { $0.task.cancel() }
        agentCredentialRefreshes = [:]
        typingStates = [:]
        localTypingChannels = []
        typingStopTasks.values.forEach { $0.cancel() }
        typingStopTasks = [:]
        composerDraft = ""
        mentionNotice = nil
        failedMessageSend = nil
        workRunsByChannel = [:]
        workRunLoadingChannels = []
        workRunDetailLoadingIds = []
        isCreatingWorkRun = false
        workCreationError = nil
        workHistoryErrorsByChannel = [:]
        workDetailErrorsById = [:]
        approvals = [:]
        approvalDecisionsInFlight = []
        channelMemberMutationIds = []
        directMessageMutationIds = []
        directMessageOperationTokens = [:]
        directMessageError = nil
        memberDirectoryIsRefreshing = false
        memberDirectoryError = nil
        inviteJoinState = .idle
        localContextCopilotPreview = nil
        isLocalContextCopilotRefreshing = false
        clearConnectionErrorState(force: true)
        pendingFallbackMentionRuns = [:]
        channelCreateSessionState = .disconnected
    }

    public func updateWorkspaceName(_ name: String) async -> Bool {
        guard let workspaceId, let workspaceBackend, !workspaceNameUpdateInFlight else {
            workspaceNameUpdateError = "Workspace settings are unavailable."
            workspaceNameUpdateIssue = .unavailable
            return false
        }
        let normalized = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...80).contains(normalized.count),
              !normalized.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            workspaceNameUpdateError = "Workspace name must be 1-80 supported characters."
            workspaceNameUpdateIssue = .invalidName
            return false
        }
        guard let expectedUpdatedAtMs = workspace?.updatedAtMs else {
            workspaceNameUpdateError = "Reload workspace settings and try again."
            workspaceNameUpdateIssue = .reloadRequired
            return false
        }

        let identitySessionGeneration = workspaceIdentitySessionGeneration
        workspaceIdentityLoadGeneration &+= 1
        workspaceNameUpdateGeneration &+= 1
        let updateGeneration = workspaceNameUpdateGeneration
        workspaceNameUpdateInFlight = true
        workspaceNameUpdateError = nil
        workspaceNameUpdateIssue = nil
        defer {
            if workspaceNameUpdateGeneration == updateGeneration {
                workspaceNameUpdateInFlight = false
            }
        }
        do {
            let updated = try await workspaceBackend.updateWorkspaceName(
                workspace: workspaceId,
                name: normalized,
                expectedUpdatedAtMs: expectedUpdatedAtMs
            )
            guard isWorkspaceIdentitySessionCurrent(
                identitySessionGeneration,
                workspaceID: workspaceId
            ), workspaceNameUpdateGeneration == updateGeneration else {
                return false
            }
            _ = applyWorkspaceIdentityIfNewer(
                updated,
                sessionGeneration: identitySessionGeneration,
                usesCache: false
            )
            clearConnectionErrorState()
            return true
        } catch {
            guard isWorkspaceIdentitySessionCurrent(
                identitySessionGeneration,
                workspaceID: workspaceId
            ), workspaceNameUpdateGeneration == updateGeneration else {
                return false
            }
            guard !Self.isCancellation(error) else { return false }
            let issue = workspaceUpdateIssue(for: error)
            if issue == .conflict {
                await loadWorkspaceIdentity(
                    workspaceId,
                    sessionGeneration: identitySessionGeneration
                )
                guard isWorkspaceIdentitySessionCurrent(
                    identitySessionGeneration,
                    workspaceID: workspaceId
                ), workspaceNameUpdateGeneration == updateGeneration else {
                    return false
                }
            }
            workspaceNameUpdateError = String(describing: error)
            workspaceNameUpdateIssue = issue
            reportConnectionError(error, as: .actionFailed)
            return false
        }
    }

    public func refreshWorkspaceIdentity() async {
        guard let workspaceId else { return }
        await loadWorkspaceIdentity(
            workspaceId,
            sessionGeneration: workspaceIdentitySessionGeneration
        )
    }

    private func loadWorkspaceIdentity(
        _ workspaceID: WorkspaceID,
        sessionGeneration: UInt64
    ) async {
        guard isWorkspaceIdentitySessionCurrent(sessionGeneration, workspaceID: workspaceID) else {
            return
        }
        workspaceIdentityLoadGeneration &+= 1
        let loadGeneration = workspaceIdentityLoadGeneration
        guard let workspaceBackend else {
            workspace = cachedWorkspaceIdentity(workspaceID)
                ?? Workspace(id: workspaceID, slug: workspaceID.description, name: "momo")
            workspaceIdentityUsesCache = true
            return
        }
        do {
            let loaded = try await workspaceBackend.workspace(id: workspaceID)
            guard isWorkspaceIdentityLoadCurrent(
                loadGeneration,
                sessionGeneration: sessionGeneration,
                workspaceID: workspaceID
            ) else { return }
            _ = applyWorkspaceIdentityIfNewer(
                loaded,
                sessionGeneration: sessionGeneration,
                usesCache: false
            )
        } catch {
            guard isWorkspaceIdentityLoadCurrent(
                loadGeneration,
                sessionGeneration: sessionGeneration,
                workspaceID: workspaceID
            ) else { return }
            guard !Self.isCancellation(error) else { return }
            if isAuthoritativeWorkspaceIdentityDenial(error) {
                removeCachedWorkspaceIdentity(workspaceID)
            }
            if canUseWorkspaceIdentityCache(for: error),
               let cached = cachedWorkspaceIdentity(workspaceID) {
                if applyWorkspaceIdentityIfNewer(
                    cached,
                    sessionGeneration: sessionGeneration,
                    usesCache: true
                ) {
                    workspaceNameUpdateError = "Workspace identity is temporarily unavailable. Using the last saved name."
                }
            } else {
                workspace = nil
                workspaceIdentityUsesCache = false
                workspaceNameUpdateError = "Workspace identity is unavailable."
            }
        }
    }

    private func isWorkspaceIdentitySessionCurrent(
        _ sessionGeneration: UInt64,
        workspaceID: WorkspaceID
    ) -> Bool {
        workspaceIdentitySessionGeneration == sessionGeneration && self.workspaceId == workspaceID
    }

    private func isWorkspaceIdentityLoadCurrent(
        _ loadGeneration: UInt64,
        sessionGeneration: UInt64,
        workspaceID: WorkspaceID
    ) -> Bool {
        workspaceIdentityLoadGeneration == loadGeneration
            && isWorkspaceIdentitySessionCurrent(sessionGeneration, workspaceID: workspaceID)
    }

    @discardableResult
    private func applyWorkspaceIdentityIfNewer(
        _ candidate: Workspace,
        sessionGeneration: UInt64,
        usesCache: Bool
    ) -> Bool {
        guard isWorkspaceIdentitySessionCurrent(
            sessionGeneration,
            workspaceID: candidate.id
        ) else { return false }
        if let current = workspace,
           current.id == candidate.id,
           current.updatedAtMs > candidate.updatedAtMs {
            return false
        }
        workspace = candidate
        workspaceIdentityUsesCache = usesCache
        workspaceNameUpdateError = nil
        if !usesCache {
            cacheWorkspaceIdentity(candidate)
        }
        return true
    }

    private func workspaceUpdateIssue(for error: Error) -> WorkspaceNameUpdateIssue {
        guard let backendError = error as? BackendError else { return .unavailable }
        switch backendError {
        case .problem(status: 409, title: _, detail: _):
            return .conflict
        case .problem(status: 401, title: _, detail: _):
            return .authenticationExpired
        case .problem(status: 403, title: _, detail: _):
            return .forbidden
        case .notConnected, .realtime, .timedOut:
            return .connection
        case .problem, .decoding, .budgetExceeded:
            return .unavailable
        }
    }

    private func cacheWorkspaceIdentity(_ workspace: Workspace?) {
        guard let workspace, let key = workspaceIdentityCacheKey(workspace.id) else { return }
        guard let data = try? JSONEncoder().encode(workspace) else { return }
        workspaceIdentityDefaults.set(data, forKey: key)
    }

    private func cachedWorkspaceIdentity(_ workspaceID: WorkspaceID) -> Workspace? {
        guard let key = workspaceIdentityCacheKey(workspaceID) else { return nil }
        guard let data = workspaceIdentityDefaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(Workspace.self, from: data)
    }

    private func removeCachedWorkspaceIdentity(_ workspaceID: WorkspaceID) {
        guard let key = workspaceIdentityCacheKey(workspaceID) else { return }
        workspaceIdentityDefaults.removeObject(forKey: key)
    }

    private func workspaceIdentityCacheKey(_ workspaceID: WorkspaceID) -> String? {
        guard let workspaceIdentityCacheScope else { return nil }
        let encodedScope = Data(workspaceIdentityCacheScope.utf8).base64EncodedString()
        return Self.workspaceCachePrefix + encodedScope + "." + workspaceID.description
    }

    private func canUseWorkspaceIdentityCache(for error: Error) -> Bool {
        guard !Self.isCancellation(error) else { return false }
        guard let backendError = error as? BackendError else { return false }
        switch backendError {
        case .problem(status: let status, title: _, detail: _):
            return status >= 500
        case .realtime, .timedOut:
            return true
        case .notConnected, .decoding, .budgetExceeded:
            return false
        }
    }

    private func isAuthoritativeWorkspaceIdentityDenial(_ error: Error) -> Bool {
        guard let backendError = error as? BackendError else { return false }
        guard case .problem(status: let status, title: _, detail: _) = backendError else { return false }
        return status == 401 || status == 403 || status == 404
    }

    private static func isCancellation(_ error: Error) -> Bool {
        error is CancellationError
            || (error as? URLError)?.code == .cancelled
            || withUnsafeCurrentTask { $0?.isCancelled ?? false }
    }

    public func refreshAgentRuntimeStatus() async {
        guard let provider = chat as? any AgentRuntimeStatusProviding else {
            agentRuntimeStatus = .localMock
            return
        }

        do {
            agentRuntimeStatus = try await provider.agentRuntimeStatus()
        } catch {
            agentRuntimeStatus = AgentRuntimeStatus(
                availability: .degraded,
                endpointLabel: "status unavailable",
                diagnostics: [String(describing: error)]
            )
        }
    }

    /// Inject channels (stub seeding path; real backend fetches them over REST).
    public func setChannels(_ channels: [Channel]) {
        self.channels = channels
        for channel in channels {
            ensureReadStateExists(channel: channel.id)
            subscribe(channel: channel.id)
        }
        if selectedChannelId == nil {
            selectedChannelId = channels.first?.id
        }
        if let selectedChannelId {
            recordChannelSelection(selectedChannelId)
        }
    }

    @discardableResult
    public func createChannel(kind: ChannelKind, name: String, topic: String? = nil) async -> Bool {
        guard case .ready(let createWorkspace) = channelCreateSessionState else {
            if channelCreateSessionState == .disconnected {
                channelCreateIssue = nil
                reportChannelCreateAuthenticationExpired(BackendError.notConnected)
            }
            return false
        }
        guard let workspaceId, workspaceId == createWorkspace else {
            channelCreateIssue = nil
            reportChannelCreateAuthenticationExpired(BackendError.notConnected)
            return false
        }
        guard !channelCreateInFlight else {
            channelCreateIssue = .unavailable
            return false
        }
        let normalizedName = MomoChannelCreationValidation.normalizedName(name)
        guard !normalizedName.isEmpty else {
            channelCreateIssue = .invalidInput
            return false
        }
        let trimmedTopic = topic.map(MomoChannelCreationValidation.normalizedTopic)
        channelCreateOperationGeneration &+= 1
        let operationGeneration = channelCreateOperationGeneration
        let sessionGeneration = channelCreateSessionGeneration
        let startingWorkspace = workspaceId
        channelCreateIssue = nil
        channelCreateInFlight = true
        defer {
            if isChannelCreateOperationCurrent(
                operationGeneration,
                sessionGeneration: sessionGeneration,
                workspaceID: startingWorkspace
            ) {
                channelCreateInFlight = false
            }
        }

        do {
            let result = try await chat.createChannel(
                workspace: startingWorkspace,
                kind: kind,
                name: normalizedName,
                topic: trimmedTopic?.isEmpty == true ? nil : trimmedTopic
            )
            guard !Task.isCancelled,
                  isChannelCreateOperationCurrent(
                    operationGeneration,
                    sessionGeneration: sessionGeneration,
                    workspaceID: startingWorkspace
                  )
            else { return false }
            if !channels.contains(where: { $0.id == result.channel.id }) {
                channels.append(result.channel)
                sortChannels()
            }
            ensureReadStateExists(channel: result.channel.id)
            subscribe(channel: result.channel.id)
            apply(result.creatorMembership)
            messagesByChannel[result.channel.id] = messagesByChannel[result.channel.id] ?? []
            recordChannelSelection(result.channel.id)
            selectedChannelId = result.channel.id
            activeTimelineChannelId = result.channel.id
            subscribeRealtimeStatus(channel: result.channel.id)
            return true
        } catch {
            guard !Self.isCancellation(error), !Task.isCancelled,
                  isChannelCreateOperationCurrent(
                    operationGeneration,
                    sessionGeneration: sessionGeneration,
                    workspaceID: startingWorkspace
                  )
            else { return false }
            if Self.isChannelCreateAuthenticationExpired(error) {
                channelCreateIssue = nil
                reportChannelCreateAuthenticationExpired(error)
            } else {
                channelCreateIssue = Self.channelCreateIssue(for: error)
            }
            return false
        }
    }

    public func cancelChannelCreation() {
        channelCreateOperationGeneration &+= 1
        channelCreateInFlight = false
        channelCreateIssue = nil
    }

    private func invalidateChannelCreationForSessionChange() {
        channelCreateSessionState = .transitioning
        channelCreateSessionGeneration &+= 1
        cancelChannelCreation()
    }

    private func isChannelCreateOperationCurrent(
        _ operationGeneration: UInt64,
        sessionGeneration: UInt64,
        workspaceID: WorkspaceID
    ) -> Bool {
        channelCreateOperationGeneration == operationGeneration
            && channelCreateSessionGeneration == sessionGeneration
            && self.workspaceId == workspaceID
            && channelCreateSessionState == .ready(workspaceID)
    }

    nonisolated static func channelCreateIssue(for error: any Error) -> MomoChannelCreateIssue? {
        guard let backendError = error as? BackendError else { return .unavailable }
        switch backendError {
        case .notConnected:
            return nil
        case .problem(let status, _, _):
            switch status {
            case 401: return nil
            case 403: return .permissionDenied
            case 409: return .duplicateName
            default: return .unavailable
            }
        case .realtime, .timedOut:
            return .connection
        case .decoding, .budgetExceeded:
            return .unavailable
        }
    }

    nonisolated private static func isChannelCreateAuthenticationExpired(_ error: any Error) -> Bool {
        guard let backendError = error as? BackendError else { return false }
        switch backendError {
        case .notConnected:
            return true
        case .problem(status: 401, title: _, detail: _):
            return true
        case .problem, .realtime, .timedOut, .decoding, .budgetExceeded:
            return false
        }
    }

    private func reportChannelCreateAuthenticationExpired(_ error: any Error) {
        connectionError = String(describing: error)
        connectionIssue = .authenticationExpired
    }

    public func refreshMemberDirectory() async {
        guard let workspaceId, !memberDirectoryIsRefreshing else { return }
        memberDirectoryIsRefreshing = true
        memberDirectoryError = nil
        defer { memberDirectoryIsRefreshing = false }

        do {
            let loadedMembers = try await chat.members(workspace: workspaceId)
            members = usesServerRosterSourceOfTruth
                ? loadedMembers
                : applyLocalProfileHints(to: loadedMembers)
            memberDirectoryError = nil
            clearConnectionErrorState()
        } catch {
            memberDirectoryError = String(describing: error)
            reportConnectionError(error)
        }
    }

    @discardableResult
    public func startDirectMessage(with memberID: MemberID) async -> MomoDirectMessageOpenOutcome {
        guard let workspaceId,
              !isCurrentUser(memberID),
              member(memberID)?.status == .active,
              !directMessageMutationIds.contains(memberID)
        else { return .ignored }

        let operationToken = UUID()
        let sessionGeneration = workspaceIdentitySessionGeneration
        let navigationIntent = beginNavigationIntent()
        directMessageOperationTokens[memberID] = operationToken
        directMessageMutationIds.insert(memberID)
        directMessageError = nil
        defer {
            if directMessageOperationTokens[memberID] == operationToken {
                directMessageOperationTokens.removeValue(forKey: memberID)
                directMessageMutationIds.remove(memberID)
            }
        }

        do {
            let channel = try await chat.openDirectMessage(workspace: workspaceId, with: memberID)
            guard directMessageOperationTokens[memberID] == operationToken,
                  isWorkspaceIdentitySessionCurrent(sessionGeneration, workspaceID: workspaceId)
            else { return .ignored }
            if let index = channels.firstIndex(where: { $0.id == channel.id }) {
                channels[index] = channel
            } else {
                channels.append(channel)
                sortChannels()
            }
            for index in members.indices where channel.dmMemberIds.contains(members[index].id) {
                if !members[index].channelIds.contains(channel.id) {
                    members[index].channelIds.append(channel.id)
                }
            }
            ensureReadStateExists(channel: channel.id)
            subscribe(channel: channel.id)
            guard navigationIntentGeneration == navigationIntent else { return .ignored }
            directMessageError = nil
            clearConnectionErrorState()
            recordChannelSelection(channel.id)
            await activateChannel(channel.id)
            guard directMessageOperationTokens[memberID] == operationToken,
                  isWorkspaceIdentitySessionCurrent(sessionGeneration, workspaceID: workspaceId),
                  navigationIntentGeneration == navigationIntent,
                  selectedChannelId == channel.id
            else { return .ignored }
            return .opened(channel.id)
        } catch {
            guard directMessageOperationTokens[memberID] == operationToken,
                  isWorkspaceIdentitySessionCurrent(sessionGeneration, workspaceID: workspaceId),
                  navigationIntentGeneration == navigationIntent,
                  !Self.isCancellation(error)
            else { return .ignored }
            directMessageError = String(describing: error)
            reportConnectionError(error, as: .actionFailed)
            return .failed
        }
    }

    public func addMember(_ member: MemberID, to channel: ChannelID? = nil) async {
        await mutateMember(member, channel: channel, adding: true)
    }

    public func removeMember(_ member: MemberID, from channel: ChannelID? = nil) async {
        await mutateMember(member, channel: channel, adding: false)
    }

    /// Select a channel: load history + (re)subscribe to its realtime stream.
    public func selectChannel(_ id: ChannelID) async {
        _ = beginNavigationIntent()
        recordChannelSelection(id)
        await activateChannel(id)
    }

    @discardableResult
    private func beginNavigationIntent() -> UInt64 {
        navigationIntentGeneration &+= 1
        return navigationIntentGeneration
    }

    public var canNavigateChannelHistoryBackward: Bool {
        guard let channelNavigationIndex else { return false }
        return channelNavigationIndex > channelNavigationHistory.startIndex
    }

    public var canNavigateChannelHistoryForward: Bool {
        guard let channelNavigationIndex else { return false }
        return channelNavigationIndex < channelNavigationHistory.index(before: channelNavigationHistory.endIndex)
    }

    /// The canonical sidebar display order shared by visible sections and navigation commands.
    var sidebarChannelOrder: MomoSidebarChannelOrder {
        MomoSidebarPolicy.channelOrder(
            from: channels,
            members: members,
            currentMemberID: authenticatedMemberId
        )
    }

    public func navigateChannelHistoryBackward() async {
        guard canNavigateChannelHistoryBackward, let channelNavigationIndex else { return }
        let destinationIndex = self.channelNavigationHistory.index(before: channelNavigationIndex)
        self.channelNavigationIndex = destinationIndex
        let id = channelNavigationHistory[destinationIndex]
        recordRecentChannel(id)
        await activateChannel(id)
    }

    public func navigateChannelHistoryForward() async {
        guard canNavigateChannelHistoryForward, let channelNavigationIndex else { return }
        let destinationIndex = self.channelNavigationHistory.index(after: channelNavigationIndex)
        self.channelNavigationIndex = destinationIndex
        let id = channelNavigationHistory[destinationIndex]
        recordRecentChannel(id)
        await activateChannel(id)
    }

    @discardableResult
    public func selectChannel(shortcutNumber: Int) async -> Bool {
        let shortcutChannels = sidebarChannelOrder.orderedChannels
        guard (1...9).contains(shortcutNumber), shortcutChannels.indices.contains(shortcutNumber - 1) else {
            return false
        }
        await selectChannel(shortcutChannels[shortcutNumber - 1].id)
        return true
    }

    public var canNavigateUnreadChannels: Bool {
        let ordered = sidebarChannelOrder.orderedChannels.map(\.id)
        let unread = Set(ordered.filter { readStatesByChannel[$0]?.hasUnread == true })
        return MomoUnreadNavigation.destination(
            from: selectedChannelId,
            orderedChannels: ordered,
            unreadChannels: unread,
            direction: .next
        ) != nil
    }

    @discardableResult
    public func navigateToPreviousUnreadChannel() async -> Bool {
        await navigateUnreadChannel(direction: .previous)
    }

    @discardableResult
    public func navigateToNextUnreadChannel() async -> Bool {
        await navigateUnreadChannel(direction: .next)
    }

    private func navigateUnreadChannel(direction: MomoUnreadNavigationDirection) async -> Bool {
        let ordered = sidebarChannelOrder.orderedChannels.map(\.id)
        let unread = Set(ordered.filter { readStatesByChannel[$0]?.hasUnread == true })
        guard let destination = MomoUnreadNavigation.destination(
            from: selectedChannelId,
            orderedChannels: ordered,
            unreadChannels: unread,
            direction: direction
        ) else {
            return false
        }
        await selectChannel(destination)
        return true
    }

    private func activateChannel(_ id: ChannelID) async {
        selectedChannelId = id
        activeTimelineChannelId = id
        await loadHistory(channel: id)
        guard selectedChannelId == id else { return }
        await refreshCostSnapshots(channel: id)
        guard selectedChannelId == id else { return }
        await loadWorkRuns(channel: id)
        guard selectedChannelId == id else { return }
        subscribeRealtimeStatus(channel: id)
        subscribe(channel: id)
        await refreshLocalContextCopilotPreview()
    }

    private func recordChannelSelection(_ id: ChannelID) {
        recordRecentChannel(id)

        if channelNavigationHistory.isEmpty {
            channelNavigationHistory = [id]
            channelNavigationIndex = channelNavigationHistory.startIndex
            return
        }

        if let channelNavigationIndex,
           channelNavigationHistory[channelNavigationIndex] == id {
            return
        }

        if let channelNavigationIndex,
           channelNavigationIndex < channelNavigationHistory.index(before: channelNavigationHistory.endIndex) {
            channelNavigationHistory.removeSubrange(
                channelNavigationHistory.index(after: channelNavigationIndex)..<channelNavigationHistory.endIndex
            )
        }
        channelNavigationHistory.append(id)
        channelNavigationIndex = channelNavigationHistory.index(before: channelNavigationHistory.endIndex)
    }

    private func recordRecentChannel(_ id: ChannelID) {
        recentChannelIds.removeAll { $0 == id }
        recentChannelIds.insert(id, at: recentChannelIds.startIndex)
        if recentChannelIds.count > 9 {
            recentChannelIds.removeLast(recentChannelIds.count - 9)
        }
    }

    private func loadHistory(channel: ChannelID) async {
        historyLoadingChannels.insert(channel)
        defer { historyLoadingChannels.remove(channel) }
        do {
            let history = try await chat.history(channel: channel, after: nil, limit: 200)
            messagesByChannel[channel] = history.sorted(by: Self.seqOrder)
            for message in history {
                hydrateSidecars(from: message)
                reconcileFinalMessage(message)
                reconcileAgentWorking(from: message)
            }
        } catch {
            reportConnectionError(error)
        }
    }

    private func loadPendingApprovals(workspace: WorkspaceID) async {
        do {
            let pending = try await chat.pendingApprovals(workspace: workspace, status: .pending)
            approvals = Dictionary(
                uniqueKeysWithValues: pending.map { ($0.id, $0.eventProjection) }
            )
        } catch {
            reportConnectionError(error)
        }
    }

    // MARK: Read state (ADR-0109)

    public func refreshReadStates() async {
        guard let workspaceId else { return }
        await refreshReadStates(workspace: workspaceId)
    }

    public func retryReadStateSync() async {
        markReadFailureCounts = [:]
        await refreshReadStates()
        subscribeReadStateUpdates()
        let pending = pendingReadSequences
        for (channel, sequence) in pending {
            if (readStatesByChannel[channel]?.lastReadSeq ?? 0) >= sequence {
                pendingReadSequences[channel] = nil
            } else {
                scheduleMarkRead(channel: channel, sequence: sequence, delay: .zero)
            }
        }
    }

    private func refreshReadStates(workspace: WorkspaceID) async {
        guard let readStateBackend else {
            for channel in channels {
                ensureReadStateExists(channel: channel.id)
            }
            return
        }
        do {
            let states = try await readStateBackend.readStates(workspace: workspace)
            var authoritative = Dictionary(uniqueKeysWithValues: states.map { ($0.channelId, $0) })
            for channel in channels where authoritative[channel.id] == nil {
                authoritative[channel.id] = Self.emptyReadState(channel: channel.id)
            }
            readStatesByChannel = authoritative
            readStateSyncError = nil
        } catch {
            readStateSyncError = String(describing: error)
        }
    }

    private func subscribeReadStateUpdates(
        sessionGeneration: UInt64? = nil,
        workspaceID: WorkspaceID? = nil
    ) {
        readStateSubscription?.cancel()
        guard let readStateBackend, let member = authenticatedMemberId ?? currentHumanMember?.id else { return }
        let capturedSessionGeneration = sessionGeneration ?? workspaceIdentitySessionGeneration
        let capturedWorkspaceID = workspaceID ?? self.workspaceId
        let subscriptionToken = UUID()
        readStateSubscriptionToken = subscriptionToken
        readStateSubscription = Task { [weak self] in
            guard let self else { return }
            defer { self.finishReadStateSubscription(token: subscriptionToken) }
            do {
                let states = try await readStateBackend.subscribeReadStates(member: member)
                guard self.isSessionCurrent(
                    capturedSessionGeneration,
                    workspaceID: capturedWorkspaceID
                ) else { return }
                for try await state in states {
                    guard self.isSessionCurrent(
                        capturedSessionGeneration,
                        workspaceID: capturedWorkspaceID
                    ) else { return }
                    guard self.channels.contains(where: { $0.id == state.channelId }) else { continue }
                    self.readStatesByChannel[state.channelId] = state
                    self.readStateSyncError = nil
                }
            } catch {
                guard self.isSessionCurrent(
                    capturedSessionGeneration,
                    workspaceID: capturedWorkspaceID
                ), !Self.isCancellation(error) else { return }
                self.readStateSyncError = String(describing: error)
            }
        }
    }

    private func isSessionCurrent(_ sessionGeneration: UInt64, workspaceID: WorkspaceID?) -> Bool {
        guard workspaceIdentitySessionGeneration == sessionGeneration else { return false }
        guard let workspaceID else { return true }
        return self.workspaceId == workspaceID
    }

    private func ensureReadStateExists(channel: ChannelID) {
        if readStatesByChannel[channel] == nil {
            readStatesByChannel[channel] = Self.emptyReadState(channel: channel)
        }
    }

    private static func emptyReadState(channel: ChannelID) -> ChannelReadState {
        ChannelReadState(
            channelId: channel,
            lastReadSeq: 0,
            latestSeq: 0,
            unreadCount: 0,
            mentionCount: 0
        )
    }

    public func messageDidRender(_ message: Message) {
        guard message.channelId == selectedChannelId, let sequence = message.seq else { return }
        scheduleMarkRead(channel: message.channelId, sequence: sequence, immediately: false)
    }

    public func isCurrentMemberMessage(_ message: Message) -> Bool {
        currentHumanMember?.id == message.authorMemberId
    }

    private func scheduleMarkRead(
        channel: ChannelID,
        sequence: Int64,
        immediately: Bool
    ) {
        scheduleMarkRead(
            channel: channel,
            sequence: sequence,
            delay: immediately ? .zero : readStateDebounce
        )
    }

    private func scheduleMarkRead(
        channel: ChannelID,
        sequence: Int64,
        delay: Duration
    ) {
        guard readStateBackend != nil else { return }
        pendingReadSequences[channel] = max(pendingReadSequences[channel] ?? 0, sequence)
        guard (markReadFailureCounts[channel] ?? 0) < Self.maximumMarkReadFailures else {
            return
        }
        markReadTasks[channel]?.cancel()
        markReadTasks[channel] = Task { [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(for: delay)
            } catch {
                return
            }
            await self.flushPendingReadState(channel: channel)
        }
    }

    private func flushPendingReadState(channel: ChannelID) async {
        guard let readStateBackend, let sequence = pendingReadSequences[channel] else { return }
        markReadTasks[channel] = nil
        do {
            let state = try await readStateBackend.markRead(channel: channel, through: sequence)
            readStatesByChannel[channel] = state
            markReadFailureCounts[channel] = nil
            readStateSyncError = nil
            if (pendingReadSequences[channel] ?? 0) <= state.lastReadSeq {
                pendingReadSequences[channel] = nil
            } else if let pending = pendingReadSequences[channel] {
                scheduleMarkRead(channel: channel, sequence: pending, immediately: true)
            }
        } catch {
            readStateSyncError = String(describing: error)
            let failures = (markReadFailureCounts[channel] ?? 0) + 1
            markReadFailureCounts[channel] = failures
            guard failures < Self.maximumMarkReadFailures else { return }
            let multiplier = 1 << (failures - 1)
            scheduleMarkRead(
                channel: channel,
                sequence: sequence,
                delay: readStateDebounce * multiplier
            )
        }
    }

    private func noteIncomingMessageForUnread(_ message: Message) {
        guard let sequence = message.seq else { return }
        if isCurrentMemberMessage(message) {
            scheduleMarkRead(channel: message.channelId, sequence: sequence, immediately: true)
            return
        }
        ensureReadStateExists(channel: message.channelId)
        let mentionsCurrentMember = currentHumanMember.map { member in
            message.props["mention_member_ids"]?.arrayValue?.contains { value in
                value.stringValue?.lowercased() == member.id.description.lowercased()
            } == true
        } ?? false
        readStatesByChannel[message.channelId] = readStatesByChannel[message.channelId]?.receivingMessage(
            sequence: sequence,
            mentionsCurrentMember: mentionsCurrentMember
        )
        scheduleReadStateRefresh()
    }

    private func scheduleReadStateRefresh() {
        guard readStateBackend != nil else { return }
        readStateRefreshTask?.cancel()
        readStateRefreshTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(250))
            } catch {
                return
            }
            await self?.refreshReadStates()
        }
    }

    private func subscribe(
        channel: ChannelID,
        sessionGeneration: UInt64? = nil,
        workspaceID: WorkspaceID? = nil
    ) {
        guard channelSubscriptions[channel] == nil else { return }
        let capturedSessionGeneration = sessionGeneration ?? workspaceIdentitySessionGeneration
        let capturedWorkspaceID = workspaceID ?? self.workspaceId
        let subscriptionToken = UUID()
        channelSubscriptionTokens[channel] = subscriptionToken
        channelSubscriptions[channel] = Task { [weak self] in
            guard let self else { return }
            defer {
                self.finishChannelSubscription(channel: channel, token: subscriptionToken)
            }
            do {
                let events = try await self.chat.subscribe(channel: channel)
                guard self.isSessionCurrent(
                    capturedSessionGeneration,
                    workspaceID: capturedWorkspaceID
                ) else { return }
                for await event in events {
                    guard self.isSessionCurrent(
                        capturedSessionGeneration,
                        workspaceID: capturedWorkspaceID
                    ) else { return }
                    self.apply(event, channel: channel)
                }
            } catch {
                guard self.isSessionCurrent(
                    capturedSessionGeneration,
                    workspaceID: capturedWorkspaceID
                ), !Self.isCancellation(error) else { return }
                self.reportConnectionError(error)
            }
        }
    }

    private func subscribeRealtimeStatus(
        channel: ChannelID,
        sessionGeneration: UInt64? = nil,
        workspaceID: WorkspaceID? = nil
    ) {
        realtimeStatusSubscription?.cancel()
        guard let statusProvider = chat as? any RealtimeStatusProvidingBackend else {
            realtimeStatusSubscription = nil
            realtimeStatusSubscriptionToken = nil
            realtimeStatuses[channel] = .restFallback(channel: channel)
            return
        }
        let capturedSessionGeneration = sessionGeneration ?? workspaceIdentitySessionGeneration
        let capturedWorkspaceID = workspaceID ?? self.workspaceId
        let subscriptionToken = UUID()
        realtimeStatusSubscriptionToken = subscriptionToken

        realtimeStatusSubscription = Task { [weak self] in
            guard let self else { return }
            defer { self.finishRealtimeStatusSubscription(token: subscriptionToken) }
            let statuses = await statusProvider.realtimeStatus(channel: channel)
            guard self.isSessionCurrent(
                capturedSessionGeneration,
                workspaceID: capturedWorkspaceID
            ) else { return }
            for await status in statuses {
                guard self.isSessionCurrent(
                    capturedSessionGeneration,
                    workspaceID: capturedWorkspaceID
                ) else { return }
                self.realtimeStatuses[status.channelId] = status
            }
        }
    }

    public func retryRealtime() async {
        guard let channel = selectedChannelId else { return }
        realtimeStatuses[channel] = RealtimeConnectionStatus(
            channelId: channel,
            connection: .reconnecting,
            subscription: .recovering,
            fallback: .restHistory,
            canRetry: false,
            message: "Retrying realtime; REST history remains available."
        )
        await loadHistory(channel: channel)
        if let statusProvider = chat as? any RealtimeStatusProvidingBackend {
            await statusProvider.retryRealtime(channel: channel)
        }
        channelSubscriptions[channel]?.cancel()
        channelSubscriptions[channel] = nil
        channelSubscriptionTokens[channel] = nil
        subscribe(channel: channel)
        subscribeRealtimeStatus(channel: channel)
    }

    private func finishChannelSubscription(channel: ChannelID, token: UUID) {
        guard channelSubscriptionTokens[channel] == token else { return }
        channelSubscriptionTokens[channel] = nil
        channelSubscriptions[channel] = nil
    }

    private func finishReadStateSubscription(token: UUID) {
        guard readStateSubscriptionToken == token else { return }
        readStateSubscriptionToken = nil
        readStateSubscription = nil
    }

    private func finishRealtimeStatusSubscription(token: UUID) {
        guard realtimeStatusSubscriptionToken == token else { return }
        realtimeStatusSubscriptionToken = nil
        realtimeStatusSubscription = nil
    }

    public func retrySelectedChannelLoad() async {
        guard let channel = selectedChannelId else {
            clearConnectionErrorState()
            return
        }
        clearConnectionErrorState()
        await selectChannel(channel)
    }

    public func clearConnectionError() {
        clearConnectionErrorState(force: true)
    }

    // MARK: Work v0

    public var isWorkSurfaceAvailable: Bool {
        workRunBackend != nil
    }

    public var workTargetAgents: [Member] {
        activeMembers()
            .filter(\.isAgent)
            .sorted {
                $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            }
    }

    public var visibleWorkRuns: [AgentWorkRun] {
        guard let channel = selectedChannelId else { return [] }
        return (workRunsByChannel[channel] ?? []).sorted {
            ($0.createdAtMs, $0.id.description) < ($1.createdAtMs, $1.id.description)
        }
    }

    public var selectedWorkHistoryError: AgentWorkSurfaceError? {
        selectedChannelId.flatMap { workHistoryErrorsByChannel[$0] }
    }

    public func workDetailError(for id: RunID) -> AgentWorkSurfaceError? {
        workDetailErrorsById[id]
    }

    public func workRun(_ id: RunID) -> AgentWorkRun? {
        workRunsByChannel.values.lazy
            .flatMap { $0 }
            .first { $0.id == id }
    }

    public func workMessages(for id: RunID) -> [Message] {
        messagesByChannel.values.lazy
            .flatMap { $0 }
            .filter { $0.runId == id }
            .sorted(by: Self.seqOrder)
    }

    public func workApproval(for id: RunID) -> ApprovalEvent? {
        approvals.values
            .filter { $0.runId == id }
            .sorted { $0.approvalId.description > $1.approvalId.description }
            .first
    }

    public func effectiveWorkStatus(for run: AgentWorkRun) -> RunStatus {
        guard !run.status.isTerminal else { return run.status }
        return agentStatuses[run.id]?.runStatus ?? run.status
    }

    @discardableResult
    public func startWork(agent: MemberID, title: String, brief: String) async -> RunID? {
        guard !isCreatingWorkRun else { return nil }
        guard let channel = selectedChannelId else {
            workCreationError = .channelRequired
            return nil
        }
        guard let workRunBackend else {
            workCreationError = .unsupportedServer
            return nil
        }
        guard workTargetAgents.contains(where: { $0.id == agent }) else {
            workCreationError = .activeAgentRequired
            return nil
        }

        let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedBrief = brief.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedTitle.isEmpty else {
            workCreationError = .titleRequired
            return nil
        }
        guard !normalizedBrief.isEmpty else {
            workCreationError = .briefRequired
            return nil
        }

        isCreatingWorkRun = true
        defer { isCreatingWorkRun = false }
        do {
            let run = try await workRunBackend.createWorkRun(
                agent: agent,
                channel: channel,
                input: AgentWorkInput(title: normalizedTitle, brief: normalizedBrief),
                clientRunId: UUID()
            )
            upsertWorkRun(run)
            workCreationError = nil
            return run.id
        } catch {
            workCreationError = .creationFailed
            return nil
        }
    }

    public func retryWorkRuns() async {
        guard let channel = selectedChannelId else { return }
        await loadWorkRuns(channel: channel)
    }

    public func refreshWorkRun(_ id: RunID) async {
        guard let workRunBackend, !workRunDetailLoadingIds.contains(id) else { return }
        workRunDetailLoadingIds.insert(id)
        defer { workRunDetailLoadingIds.remove(id) }
        do {
            upsertWorkRun(try await workRunBackend.workRun(id: id))
            workDetailErrorsById[id] = nil
        } catch {
            workDetailErrorsById[id] = .detailFailed
        }
    }

    public func clearWorkCreationError() {
        workCreationError = nil
    }

    // MARK: Sending

    public func composerDraftDidChange(_ draft: String) {
        guard let channel = selectedChannelId else { return }
        let isTyping = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if isTyping {
            startLocalTyping(channel: channel)
        } else {
            stopLocalTyping(channel: channel)
        }
    }

    /// Optimistic send: local echo with nil seq, reconciled by the returned message.
    public func send(body: String, to channel: ChannelID) async {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        stopLocalTyping(channel: channel)
        let clientMsgId = UUID()
        let draft = DraftMessage(channelId: channel, type: .text, body: trimmed)
        let mentionedAgent = mentionedAgent(in: trimmed, channel: channel)
        let optimistic = optimisticMessage(body: trimmed, channel: channel, clientMsgId: clientMsgId)
        upsert(optimistic, channel: channel)
        await performSend(PendingMessageSend(
            draft: draft,
            clientMsgId: clientMsgId,
            mentionedAgent: mentionedAgent
        ))
    }

    /// Retries the exact failed request, including its `clientMsgId`, so a lost
    /// acknowledgement cannot create a duplicate durable message.
    public func retryFailedSend() async {
        guard let failedMessageSend else {
            clearConnectionErrorState(force: true)
            return
        }
        await performSend(failedMessageSend)
    }

    private func performSend(_ pending: PendingMessageSend) async {
        let channel = pending.draft.channelId
        let mentionedAgent = pending.mentionedAgent
        if let mentionedAgent {
            markAgentWorking(
                mentionedAgent,
                channel: channel,
                message: "\(mentionedAgent.displayName) is working on your mention..."
            )
        }
        if let mentionedAgent, isRESTFallback(channel: channel) {
            showFallbackMentionProgress(agent: mentionedAgent, channel: channel)
        }
        do {
            let acked = try await chat.sendOptimistic(pending.draft, clientMsgId: pending.clientMsgId)
            // Reconcile (the stub already emits the real message via subscribe, but the
            // returned ack is authoritative — upsert by id).
            upsert(acked, channel: channel)
            failedMessageSend = nil
            clearConnectionErrorState(force: true)
            if let sequence = acked.seq {
                scheduleMarkRead(channel: channel, sequence: sequence, immediately: true)
            }
            if let mentionedAgent {
                await refreshAfterMentionSend(channel: channel, agent: mentionedAgent, triggerSeq: acked.seq)
            }
        } catch {
            failedMessageSend = pending
            reportConnectionError(error, as: .sendFailed)
            if let mentionedAgent {
                clearAgentWorking(mentionedAgent.id, channel: channel)
                discardFallbackMentionProgress(channel: channel)
                mentionNotice = nil
            }
        }
    }

    public func insertMention(for member: Member, preferDisplayName: Bool = false) {
        guard selectedChannelId != nil else {
            mentionNotice = "Select a channel before mentioning \(member.displayName)."
            return
        }
        guard member.status == .active else {
            mentionNotice = "\(member.displayName) is not active in this workspace."
            return
        }

        let token = preferDisplayName ? "@\(member.displayName)" : "@\(member.handle)"
        let needsSeparator = composerDraft.last.map { !$0.isWhitespace && !$0.isNewline } ?? false
        composerDraft += "\(needsSeparator ? " " : "")\(token) "
        mentionNotice = "\(member.displayName) mention inserted."
    }

    public func canInsertMention(for member: Member) -> Bool {
        member.status == .active && selectedChannelId != nil && isMember(member.id)
    }

    public func mentionUnavailableReason(for member: Member) -> String? {
        if selectedChannelId == nil {
            return "Select a channel first."
        }
        if member.status != .active {
            return "\(member.displayName) is not active."
        }
        if !isMember(member.id) {
            return "\(member.displayName) is not in this channel."
        }
        return nil
    }

    public func mentionAutocompleteCandidates(for draft: String? = nil) -> [Member] {
        guard let query = Self.activeMentionQuery(in: draft ?? composerDraft) else { return [] }
        let normalizedQuery = query.lowercased()
        return activeMembers()
            .filter { member in
                guard !normalizedQuery.isEmpty else { return true }
                return member.handle.lowercased().hasPrefix(normalizedQuery)
                    || member.displayName.lowercased().contains(normalizedQuery)
            }
            .sorted { lhs, rhs in
                if lhs.isAgent != rhs.isAgent { return lhs.isAgent && !rhs.isAgent }
                return lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
            }
    }

    public func completeMentionAutocomplete(with member: Member) {
        guard canInsertMention(for: member) else {
            mentionNotice = mentionUnavailableReason(for: member)
            return
        }
        let token = "@\(member.handle) "
        if let range = Self.activeMentionTokenRange(in: composerDraft) {
            composerDraft.replaceSubrange(range, with: token)
        } else {
            let needsSeparator = composerDraft.last.map { !$0.isWhitespace && !$0.isNewline } ?? false
            composerDraft += "\(needsSeparator ? " " : "")\(token)"
        }
        mentionNotice = "\(member.displayName) mention inserted."
    }

    func agentCredentials(for member: MemberID) -> [MomoAgentCredential] {
        agentCredentialsByMember[member] ?? []
    }

    func isLoadingAgentCredentials(for member: MemberID) -> Bool {
        agentCredentialLoadingMembers.contains(member)
    }

    func refreshAgentCredentials(for agent: MemberID) async throws {
        try await refreshAgentCredentials(for: agent, refreshAfterInFlight: false)
    }

    private func refreshAgentCredentials(
        for agent: MemberID,
        refreshAfterInFlight: Bool
    ) async throws {
        guard let workspaceId else { throw BackendError.notConnected }
        guard let agentCredentialBackend else {
            throw BackendError.problem(
                status: 501,
                title: "agent credentials unavailable",
                detail: nil
            )
        }

        if let inFlight = agentCredentialRefreshes[agent] {
            let credentials: [MomoAgentCredential]?
            do {
                credentials = try await inFlight.task.value
            } catch {
                guard refreshAfterInFlight else { throw error }
                credentials = nil
            }
            if let credentials, agentCredentialRefreshes[agent]?.id == inFlight.id {
                agentCredentialsByMember[agent] = credentials
            }

            guard refreshAfterInFlight else { return }
            guard self.workspaceId == workspaceId else { throw BackendError.notConnected }

            if let newer = agentCredentialRefreshes[agent], newer.id != inFlight.id {
                let newerCredentials = try await newer.task.value
                if agentCredentialRefreshes[agent]?.id == newer.id {
                    agentCredentialsByMember[agent] = newerCredentials
                }
                return
            }

            agentCredentialRefreshes[agent] = nil
        }

        let refreshID = UUID()
        let refreshTask = Task {
            try await agentCredentialBackend.agentCredentials(
                workspace: workspaceId,
                agent: agent
            )
        }
        agentCredentialRefreshes[agent] = AgentCredentialRefresh(id: refreshID, task: refreshTask)
        agentCredentialLoadingMembers.insert(agent)
        defer {
            if agentCredentialRefreshes[agent]?.id == refreshID {
                agentCredentialRefreshes[agent] = nil
                agentCredentialLoadingMembers.remove(agent)
            }
        }
        let credentials = try await refreshTask.value
        guard agentCredentialRefreshes[agent]?.id == refreshID else { return }
        agentCredentialsByMember[agent] = credentials
    }

    func issueAgentCredential(
        for agent: MemberID,
        rotationGraceSeconds: Int = 24 * 60 * 60
    ) async throws -> MomoAgentCredentialReveal {
        guard let workspaceId else { throw BackendError.notConnected }
        guard let agentCredentialBackend else {
            throw BackendError.problem(
                status: 501,
                title: "agent credentials unavailable",
                detail: nil
            )
        }
        let reveal = try await agentCredentialBackend.issueAgentCredential(
            workspace: workspaceId,
            agent: agent,
            rotationGraceSeconds: rotationGraceSeconds
        )
        do {
            try await refreshAgentCredentials(for: agent, refreshAfterInFlight: true)
        } catch {
            upsertAgentCredential(reveal.credential, for: agent)
        }
        return reveal
    }

    func revokeAgentCredential(_ credential: UUID, for agent: MemberID) async throws {
        guard let workspaceId else { throw BackendError.notConnected }
        guard let agentCredentialBackend else {
            throw BackendError.problem(
                status: 501,
                title: "agent credentials unavailable",
                detail: nil
            )
        }
        let revokedCredential = try await agentCredentialBackend.revokeAgentCredential(
            credential,
            workspace: workspaceId,
            agent: agent
        )
        do {
            try await refreshAgentCredentials(for: agent, refreshAfterInFlight: true)
        } catch {
            upsertAgentCredential(revokedCredential, for: agent)
        }
    }

    private func upsertAgentCredential(_ credential: MomoAgentCredential, for agent: MemberID) {
        var credentials = agentCredentialsByMember[agent] ?? []
        credentials.removeAll { $0.id == credential.id }
        credentials.append(credential)
        credentials.sort { $0.createdAtMs > $1.createdAtMs }
        agentCredentialsByMember[agent] = credentials
    }

    @discardableResult
    public func inviteDogfoodAgent(
        displayName rawDisplayName: String,
        handle rawHandle: String,
        avatarPath: String? = nil
    ) async throws -> Member {
        let normalizedHandle = Self.normalizedAgentHandle(rawHandle)
        guard normalizedHandle == "hermes" else {
            throw DogfoodAgentInviteError.unsupportedAlias("@\(normalizedHandle)")
        }
        guard let channel = selectedChannelId else {
            throw DogfoodAgentInviteError.selectChannelFirst
        }
        let displayName = rawDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveDisplayName = displayName.isEmpty ? normalizedHandle.capitalized : displayName
        let existingIndex = members.firstIndex { member in
            member.isAgent
                && member.handle.caseInsensitiveCompare(normalizedHandle) == .orderedSame
        }
        guard let existingIndex else {
            throw DogfoodAgentInviteError.missingHermesAgent
        }
        var agent = members[existingIndex]

        agent.displayName = effectiveDisplayName
        agent.handle = normalizedHandle
        if let avatarPath, !avatarPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            agent.avatarURL = URL(fileURLWithPath: avatarPath)
        }
        if agent.presence == Presence.offline {
            agent.presence = Presence.online
        }

        if !agent.channelIds.contains(channel) {
            do {
                let membership = try await chat.addMember(agent.id, to: channel, role: .member)
                apply(membership)
                agent.channelIds = member(agent.id)?.channelIds ?? agent.channelIds
                clearConnectionErrorState()
            } catch {
                reportConnectionError(error, as: .actionFailed)
                throw error
            }
        }

        members[existingIndex] = agent
        mentionNotice = "\(agent.displayName) invited. Mention @\(agent.handle) in this channel."
        return agent
    }

    // MARK: Onboarding invite flow

    public func submitInviteCode(_ code: String) async {
        guard !inviteJoinState.isWorking else { return }
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            inviteJoinState = .failed(InviteJoinFailure(
                code: "",
                reason: "Invite code required",
                recoveryHint: "Enter MOMO-012 for the dev fixture."
            ))
            return
        }

        guard let onboarding else {
            inviteJoinState = .failed(InviteJoinFailure(
                code: trimmed,
                reason: "Invite service unavailable",
                recoveryHint: "Use LiveChatBackend in the dev app."
            ))
            return
        }

        inviteJoinState = .validating(code: trimmed)
        inviteJoinState = await onboarding.joinWorkspace(inviteCode: trimmed)
    }

    // MARK: Realtime application (ordering authority = seq, L4 §1.2 #3)

    private func apply(_ event: RealtimeEvent, channel: ChannelID) {
        switch event {
        case .message(let message):
            guard message.channelId == channel else { return }
            if upsert(message, channel: channel) {
                noteIncomingMessageForUnread(message)
            }
        case .messageEdited(let message):
            guard message.channelId == channel else { return }
            upsert(message, channel: channel)
        case .messageDeleted(let id):
            if var msgs = messagesByChannel[channel],
               let idx = msgs.firstIndex(where: { $0.id == id }) {
                msgs[idx].state = .deleted
                messagesByChannel[channel] = msgs
            }
        case .agentStatus(let status):
            guard status.channelId == channel, activeTimelineChannelId == channel else { return }
            agentStatuses[status.runId] = status
            updateWorkRunStatus(status)
            mergeCostSnapshot(from: status)
            reconcileAgentWorking(from: status)
        case .agentPartial(let partial):
            guard partial.channelId == channel, activeTimelineChannelId == channel else { return }
            coalesce(partial)
        case .approval(let ev):
            guard ev.channelId == channel, activeTimelineChannelId == channel else { return }
            approvals[ev.approvalId] = ev
        case .typing(let delta):
            guard delta.channelId == channel, activeTimelineChannelId == channel else { return }
            applyTyping(delta)
        case .reaction, .presence:
            // Rendered elsewhere / not material to the v0 demo surfaces.
            break
        }
    }

    @discardableResult
    private func upsert(_ message: Message, channel: ChannelID) -> Bool {
        var msgs = messagesByChannel[channel] ?? []
        let existingIndex = msgs.firstIndex(where: { $0.id == message.id })
            ?? (message.clientMsgId.flatMap { cid in msgs.firstIndex(where: { $0.clientMsgId == cid }) })
        if let idx = existingIndex {
            msgs[idx] = message
        } else {
            msgs.append(message)
        }
        messagesByChannel[channel] = msgs.sorted(by: Self.seqOrder)
        hydrateSidecars(from: message)
        reconcileFinalMessage(message)
        reconcileAgentWorking(from: message)
        return existingIndex == nil
    }

    private func hydrateSidecars(from message: Message) {
        guard let runId = message.runId else { return }
        let reserved = Self.microUSD(from: message.props["reserved_micro_usd"])
            ?? Self.microUSD(from: message.props["estimated_micro_usd"])
        let spent = Self.microUSD(from: message.props["spent_micro_usd"])
        if message.type == .approvalRequest {
            let existing = agentStatuses[runId]
            agentStatuses[runId] = AgentStatus(
                runId: runId,
                agentMemberId: message.authorMemberId,
                channelId: message.channelId,
                phase: existing?.phase ?? .thinking,
                runStatus: .awaitingApproval,
                reservedMicroUSD: reserved ?? existing?.reservedMicroUSD,
                spentMicroUSD: spent ?? existing?.spentMicroUSD
            )
        } else if reserved != nil || spent != nil {
            agentStatuses[runId] = AgentStatus(
                runId: runId,
                agentMemberId: message.authorMemberId,
                channelId: message.channelId,
                phase: spent == nil ? .thinking : .streaming,
                runStatus: message.type == .approvalRequest ? .awaitingApproval : .running,
                reservedMicroUSD: reserved,
                spentMicroUSD: spent
            )
        }

        guard message.type == .approvalRequest,
              let approvalId = approvalId(for: message) else {
            return
        }
        approvals[approvalId] = ApprovalEvent(
            action: .requested,
            approvalId: approvalId,
            runId: runId,
            channelId: message.channelId,
            requestedBy: message.authorMemberId,
            actionType: message.props["action_type"]?.stringValue
                ?? message.props["tool_name"]?.stringValue
                ?? "tool_call",
            status: approvalStatus(for: message) ?? .pending,
            payload: message.props,
            estimatedMicroUSD: Self.microUSD(from: message.props["estimated_micro_usd"]),
            isReversible: Self.bool(from: message.props["is_reversible"])
        )
    }

    // MARK: Local Context Copilot

    public func refreshLocalContextCopilotPreview() async {
        guard !isLocalContextCopilotRefreshing else { return }
        isLocalContextCopilotRefreshing = true
        defer { isLocalContextCopilotRefreshing = false }

        let channel = selectedChannelId.flatMap { selected in
            channels.first(where: { $0.id == selected })
        }
        let request = LocalContextCopilotRequest(
            channel: channel,
            messages: visibleMessages,
            capability: foundationModelsCapability
        )
        localContextCopilotPreview = await localContextCopilot.preview(request)
    }

    /// Coalesce `agent.partial` deltas into one growing buffer per run (L4 §5.2).
    private func coalesce(_ partial: AgentPartial) {
        guard !hasFinalMessage(for: partial) else {
            partials[partial.runId] = nil
            return
        }
        if var existing = partials[partial.runId] {
            if let delta = partial.textDelta {
                existing.textDelta = (existing.textDelta ?? "") + delta
            }
            if let name = partial.toolCallName { existing.toolCallName = name }
            if let args = partial.toolCallArgs { existing.toolCallArgs = args }
            if let spent = partial.spentMicroUSD { existing.spentMicroUSD = spent }
            if let mid = partial.messageId { existing.messageId = mid }
            partials[partial.runId] = existing
        } else {
            partials[partial.runId] = partial
        }
    }

    private func reconcileFinalMessage(_ message: Message) {
        guard let runId = message.runId else { return }
        guard let partial = partials[runId] else { return }
        if partial.messageId == message.id || message.type == .toolResult {
            partials[runId] = nil
        }
    }

    private func clearFallbackMentionProgress(channel: ChannelID, agent: Member, after triggerSeq: Int64?) {
        guard let runs = pendingFallbackMentionRuns[channel], !runs.isEmpty else { return }
        let messages = messagesByChannel[channel] ?? []
        let hasFinal = messages.contains { message in
            guard message.authorMemberId == agent.id else { return false }
            guard let triggerSeq, let seq = message.seq else { return message.runId != nil }
            return seq > triggerSeq
        }
        guard hasFinal else { return }
        for run in runs {
            partials[run] = nil
            if var status = agentStatuses[run] {
                status.phase = .done
                status.runStatus = .succeeded
                agentStatuses[run] = status
            }
        }
        pendingFallbackMentionRuns[channel] = nil
    }

    private func discardFallbackMentionProgress(channel: ChannelID) {
        guard let runs = pendingFallbackMentionRuns.removeValue(forKey: channel) else { return }
        for run in runs {
            partials[run] = nil
            agentStatuses[run] = nil
        }
    }

    private func markAgentWorking(_ agent: Member, channel: ChannelID, message: String) {
        guard agent.isAgent else { return }
        agentWorkingStates[agent.id] = AgentWorkingState(
            memberId: agent.id,
            channelId: channel,
            message: message
        )
    }

    private func clearAgentWorking(_ member: MemberID, channel: ChannelID? = nil) {
        guard let channel else {
            agentWorkingStates[member] = nil
            return
        }
        if agentWorkingStates[member]?.channelId == channel {
            agentWorkingStates[member] = nil
        }
    }

    private func reconcileAgentWorking(from status: AgentStatus) {
        if status.runStatus.isTerminal || status.phase == .done || status.phase == .error {
            clearAgentWorking(status.agentMemberId, channel: status.channelId)
        } else if member(status.agentMemberId)?.isAgent == true,
                  isMember(status.agentMemberId, in: status.channelId) {
            agentWorkingStates[status.agentMemberId] = AgentWorkingState(
                memberId: status.agentMemberId,
                channelId: status.channelId,
                message: "\(member(status.agentMemberId)?.displayName ?? "Agent") is working..."
            )
        }
    }

    private func reconcileAgentWorking(from message: Message) {
        guard member(message.authorMemberId)?.isAgent == true else { return }
        guard isAgentFinalResponse(message) else { return }
        if let runId = message.runId, var status = agentStatuses[runId] {
            status.phase = .done
            status.runStatus = .succeeded
            agentStatuses[runId] = status
        }
        clearAgentWorking(message.authorMemberId, channel: message.channelId)
    }

    private func isAgentFinalResponse(_ message: Message) -> Bool {
        switch message.type {
        case .text, .toolResult, .system:
            return message.state != .failed
        case .toolCall, .diff, .artifact, .approvalRequest:
            return false
        }
    }

    private func hasFinalMessage(for partial: AgentPartial) -> Bool {
        let messages = messagesByChannel[partial.channelId] ?? []
        return messages.contains { message in
            guard message.runId == partial.runId else { return false }
            if partial.messageId == message.id { return true }
            return message.type == .toolResult && message.seq != nil
        }
    }

    // MARK: Approval inbox actions (experience C)

    public func decideApproval(_ id: ApprovalID, approve: Bool, reason: String? = nil) async {
        guard !approvalDecisionsInFlight.contains(id) else { return }
        approvalDecisionsInFlight.insert(id)
        defer { approvalDecisionsInFlight.remove(id) }

        do {
            let receipt = try await chat.decideApproval(
                ApprovalDecisionRequest(approvalId: id, approve: approve, reason: reason)
            )
            // Optimistically reflect the decision; real `approval.decided` will confirm.
            if var ev = approvals[id] {
                ev.status = receipt.status
                ev.action = .decided
                ev.decidedBy = receipt.decidedBy
                ev.decisionReason = receipt.decisionReason
                approvals[id] = ev
            }
        } catch {
            reportConnectionError(error, as: .actionFailed)
        }
    }

    // MARK: Derived views

    /// seq-sorted messages for the currently selected channel (MessageListView).
    public var visibleMessages: [Message] {
        guard let id = selectedChannelId else { return [] }
        return messagesByChannel[id] ?? []
    }

    var isSelectedChannelHistoryLoading: Bool {
        guard let id = selectedChannelId else { return false }
        return historyLoadingChannels.contains(id)
    }

    public var selectedRealtimeStatus: RealtimeConnectionStatus? {
        guard let id = selectedChannelId else { return nil }
        return realtimeStatuses[id]
    }

    /// Pending approvals, newest-first (ApprovalInboxView).
    public var pendingApprovals: [ApprovalEvent] {
        approvals.values
            .filter { $0.status == .pending }
            .sorted { $0.approvalId.description > $1.approvalId.description }
    }

    public func approvalId(for message: Message) -> ApprovalID? {
        guard message.type == .approvalRequest,
              let raw = message.props["approval_id"]?.stringValue else {
            return nil
        }
        return ApprovalID(raw)
    }

    public func approvalStatus(for message: Message) -> ApprovalStatus? {
        guard let id = approvalId(for: message) else {
            return nil
        }
        if let eventStatus = approvals[id]?.status {
            return eventStatus
        }
        if let raw = message.props["approval_status"]?.stringValue {
            return ApprovalStatus(rawValue: raw)
        }
        return .pending
    }

    public func isApprovalDecisionInFlight(for message: Message) -> Bool {
        guard let id = approvalId(for: message) else {
            return false
        }
        return approvalDecisionsInFlight.contains(id)
    }

    public func member(_ id: MemberID) -> Member? {
        members.first(where: { $0.id == id })
    }

    public func isCurrentUser(_ id: MemberID) -> Bool {
        authenticatedMemberId == id
    }

    var currentNavigationMemberID: MemberID? {
        authenticatedMemberId
    }

    public func directMessageCounterpart(for channel: Channel) -> Member? {
        guard channel.kind == .dm else { return nil }
        let counterpartID = channel.dmMemberIds.first { $0 != authenticatedMemberId }
        return counterpartID.flatMap(member)
    }

    public func applyLocalProfile(
        member id: MemberID,
        displayName rawDisplayName: String,
        avatarPath: String?,
        presence: Presence?
    ) {
        guard allowsLocalProfileEditing else { return }
        guard let index = members.firstIndex(where: { $0.id == id }) else { return }
        let displayName = rawDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !displayName.isEmpty {
            members[index].displayName = displayName
        }
        if let avatarPath, !avatarPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            members[index].avatarURL = URL(fileURLWithPath: avatarPath)
        } else if avatarPath != nil {
            members[index].avatarURL = nil
        }
        if let presence {
            members[index].presence = presence
        }
    }

    public var selectedChannel: Channel? {
        guard let selectedChannelId else { return nil }
        return channels.first(where: { $0.id == selectedChannelId })
    }

    public func isMember(_ member: MemberID, in channel: ChannelID? = nil) -> Bool {
        guard let channel = channel ?? selectedChannelId else { return false }
        return members.first(where: { $0.id == member })?.channelIds.contains(channel) == true
    }

    public func activeMembers(in channel: ChannelID? = nil) -> [Member] {
        guard let channel = channel ?? selectedChannelId else { return [] }
        return members.filter { member in
            member.status == .active && member.channelIds.contains(channel)
        }
    }

    public func isAgentWorking(_ member: Member, in channel: ChannelID? = nil) -> Bool {
        guard member.isAgent else { return false }
        let channel = channel ?? selectedChannelId
        if let channel, !isMember(member.id, in: channel) {
            return false
        }
        if let state = agentWorkingStates[member.id],
           channel == nil || state.channelId == channel {
            return true
        }
        return agentStatuses.values.contains { status in
            status.agentMemberId == member.id
                && (channel == nil || status.channelId == channel)
                && !status.runStatus.isTerminal
                && status.phase != .done
                && status.phase != .error
        }
    }

    public var visibleTypingActivities: [TypingActivity] {
        guard let selectedChannelId else { return [] }
        guard let activities = typingStates[selectedChannelId]?.values else { return [] }
        return Array(activities)
            .filter { activity in
                guard let member = member(activity.memberId) else { return false }
                return member.kind == .human && member.status == .active
            }
            .sorted { lhs, rhs in
                let left = member(lhs.memberId)?.displayName ?? ""
                let right = member(rhs.memberId)?.displayName ?? ""
                return left.localizedCaseInsensitiveCompare(right) == .orderedAscending
            }
    }

    public var visibleTypingMembers: [Member] {
        visibleTypingActivities.compactMap { member($0.memberId) }
    }

    public var visibleWorkingAgents: [Member] {
        guard let selectedChannelId else { return [] }
        return members
            .filter { member in
                member.isAgent
                    && isMember(member.id, in: selectedChannelId)
                    && isAgentWorking(member, in: selectedChannelId)
                    && !visibleWorkRuns.contains {
                        $0.agentMemberId == member.id && !effectiveWorkStatus(for: $0).isTerminal
                    }
            }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    /// Total reserved/spent micro_usd across live runs (cost chip in headers).
    public var liveSpentMicroUSD: Int64 {
        costSnapshots.values.map(\.spentMicroUSD).reduce(0, +)
    }

    public func costSnapshot(for runId: RunID) -> CostSnapshot? {
        costSnapshots[runId]
    }

    private func loadWorkRuns(channel: ChannelID) async {
        guard let workRunBackend else { return }
        workRunLoadingChannels.insert(channel)
        defer { workRunLoadingChannels.remove(channel) }
        do {
            let runs = try await workRunBackend.workRuns(channel: channel, limit: 50)
            workRunsByChannel[channel] = runs
            workHistoryErrorsByChannel[channel] = nil
        } catch {
            workHistoryErrorsByChannel[channel] = .historyFailed
        }
    }

    private func upsertWorkRun(_ run: AgentWorkRun) {
        var runs = workRunsByChannel[run.channelId] ?? []
        if let index = runs.firstIndex(where: { $0.id == run.id }) {
            runs[index] = run
        } else {
            runs.append(run)
        }
        workRunsByChannel[run.channelId] = runs
    }

    private func updateWorkRunStatus(_ status: AgentStatus) {
        guard var run = workRun(status.runId) else { return }
        guard !run.status.isTerminal else { return }
        run.status = status.runStatus
        run.updatedAtMs = Int64(Date().timeIntervalSince1970 * 1_000)
        if status.runStatus.isTerminal, run.finishedAtMs == nil {
            run.finishedAtMs = run.updatedAtMs
        }
        upsertWorkRun(run)
    }

    private func refreshCostSnapshots(channel: ChannelID) async {
        do {
            let snapshots = try await chat.costSnapshots(channel: channel)
            for snapshot in snapshots {
                costSnapshots[snapshot.runId] = snapshot
            }
            clearConnectionErrorState()
        } catch {
            reportConnectionError(error)
        }
    }

    private func mergeCostSnapshot(from status: AgentStatus) {
        guard status.reservedMicroUSD != nil || status.spentMicroUSD != nil else {
            return
        }
        let existing = costSnapshots[status.runId]
        costSnapshots[status.runId] = CostSnapshot(
            runId: status.runId,
            reservedMicroUSD: status.reservedMicroUSD ?? existing?.reservedMicroUSD ?? 0,
            spentMicroUSD: status.spentMicroUSD ?? existing?.spentMicroUSD ?? 0,
            softLimitMicroUSD: existing?.softLimitMicroUSD,
            hardLimitMicroUSD: existing?.hardLimitMicroUSD,
            isReconciled: existing?.isReconciled ?? status.runStatus.isTerminal,
            wasEstimated: existing?.wasEstimated ?? false,
            limitState: existing?.limitState ?? .normal
        )
    }

    private func optimisticMessage(body: String, channel: ChannelID, clientMsgId: UUID) -> Message {
        Message(
            id: MessageID(),
            channelId: channel,
            seq: nil,
            hlcTs: Int64(Date().timeIntervalSince1970 * 1000),
            authorMemberId: members.first(where: { $0.kind == .human })?.id ?? MemberID(),
            type: .text,
            state: .sent,
            body: body,
            clientMsgId: clientMsgId,
            createdAtMs: Int64(Date().timeIntervalSince1970 * 1000)
        )
    }

    private func mentionedAgent(in body: String, channel: ChannelID) -> Member? {
        members.first { member in
            member.isAgent
                && member.status == .active
                && member.channelIds.contains(channel)
                && Self.body(body, mentions: member)
        }
    }

    private func isRESTFallback(channel: ChannelID) -> Bool {
        guard let status = realtimeStatuses[channel] else { return false }
        return status.fallback == .restHistory && !status.isLive
    }

    private var currentHumanMember: Member? {
        if let authenticatedMemberId,
           let authenticated = members.first(where: { $0.id == authenticatedMemberId }) {
            return authenticated
        }
        return members.first { $0.kind == .human && $0.status == .active }
    }

    private func startLocalTyping(channel: ChannelID) {
        guard let member = currentHumanMember else { return }
        setTyping(member: member.id, channel: channel, isTyping: true, isLocalEcho: true)
        if !localTypingChannels.contains(channel) {
            localTypingChannels.insert(channel)
            Task { await chat.setTyping(channel: channel, isTyping: true) }
        }

        typingStopTasks[channel]?.cancel()
        typingStopTasks[channel] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            await MainActor.run {
                self?.stopLocalTyping(channel: channel)
            }
        }
    }

    private func stopLocalTyping(channel: ChannelID) {
        guard let member = currentHumanMember else { return }
        typingStopTasks[channel]?.cancel()
        typingStopTasks[channel] = nil
        setTyping(member: member.id, channel: channel, isTyping: false, isLocalEcho: true)
        if localTypingChannels.remove(channel) != nil {
            Task { await chat.setTyping(channel: channel, isTyping: false) }
        }
    }

    private func applyTyping(_ delta: TypingDelta) {
        setTyping(
            member: delta.memberId,
            channel: delta.channelId,
            isTyping: delta.isTyping,
            isLocalEcho: localTypingChannels.contains(delta.channelId) && currentHumanMember?.id == delta.memberId
        )
    }

    private func setTyping(member: MemberID, channel: ChannelID, isTyping: Bool, isLocalEcho: Bool) {
        guard members.contains(where: { $0.id == member && $0.channelIds.contains(channel) }) else { return }
        var channelTyping = typingStates[channel] ?? [:]
        if isTyping {
            channelTyping[member] = TypingActivity(memberId: member, channelId: channel, isLocalEcho: isLocalEcho)
        } else {
            channelTyping[member] = nil
        }
        if channelTyping.isEmpty {
            typingStates[channel] = nil
        } else {
            typingStates[channel] = channelTyping
        }
    }

    private func showFallbackMentionProgress(agent: Member, channel: ChannelID) {
        let run = RunID()
        pendingFallbackMentionRuns[channel, default: []].insert(run)
        agentStatuses[run] = AgentStatus(
            runId: run,
            agentMemberId: agent.id,
            channelId: channel,
            phase: .thinking,
            runStatus: .running
        )
        partials[run] = AgentPartial(
            runId: run,
            channelId: channel,
            textDelta: "\(agent.displayName) is working from the mention. Waiting for the final channel message..."
        )
    }

    private func refreshAfterMentionSend(channel: ChannelID, agent: Member, triggerSeq: Int64?) async {
        guard isRESTFallback(channel: channel) else { return }
        for delay in [350_000_000, 900_000_000, 1_600_000_000] as [UInt64] {
            try? await Task.sleep(nanoseconds: delay)
            await loadHistory(channel: channel)
            await refreshCostSnapshots(channel: channel)
            clearFallbackMentionProgress(channel: channel, agent: agent, after: triggerSeq)
            if pendingFallbackMentionRuns[channel]?.isEmpty != false {
                return
            }
        }
    }

    // Stable ordering: seq first (nil = optimistic, sort last), then hlc, then id.
    nonisolated static func seqOrder(_ a: Message, _ b: Message) -> Bool {
        switch (a.seq, b.seq) {
        case let (.some(x), .some(y)) where x != y: return x < y
        case (.some, .none): return true     // acked before optimistic
        case (.none, .some): return false
        default: break
        }
        if a.hlcTs != b.hlcTs { return a.hlcTs < b.hlcTs }
        if a.hlcCount != b.hlcCount { return a.hlcCount < b.hlcCount }
        return a.id.description < b.id.description
    }

    nonisolated private static func channelOrder(
        _ a: Channel,
        _ b: Channel,
        members: [Member],
        currentMemberID: MemberID?
    ) -> Bool {
        let kindRank: (ChannelKind) -> Int = { kind in
            switch kind {
            case .publicChannel: return 0
            case .privateChannel: return 1
            case .dm: return 2
            }
        }
        let lhs = kindRank(a.kind)
        let rhs = kindRank(b.kind)
        if lhs != rhs { return lhs < rhs }
        if a.kind == .dm {
            return MomoChannelDisplayPolicy.isDirectMessageOrderedBefore(
                a,
                b,
                members: members,
                currentMemberID: currentMemberID
            )
        }
        let nameOrder = (a.name ?? "").localizedCaseInsensitiveCompare(b.name ?? "")
        if nameOrder != .orderedSame { return nameOrder == .orderedAscending }
        return a.id.description < b.id.description
    }

    private func sortChannels() {
        let memberSnapshot = members
        let currentMemberID = authenticatedMemberId
        channels.sort {
            Self.channelOrder(
                $0,
                $1,
                members: memberSnapshot,
                currentMemberID: currentMemberID
            )
        }
    }

    private func mutateMember(_ member: MemberID, channel: ChannelID?, adding: Bool) async {
        guard let channel = channel ?? selectedChannelId else {
            reportConnectionError("Select a channel first.", as: .actionFailed)
            return
        }
        guard !channelMemberMutationIds.contains(member) else { return }
        channelMemberMutationIds.insert(member)
        defer { channelMemberMutationIds.remove(member) }

        do {
            let membership = adding
                ? try await chat.addMember(member, to: channel, role: .member)
                : try await chat.removeMember(member, from: channel)
            apply(membership)
            clearConnectionErrorState()
        } catch {
            reportConnectionError(error, as: .actionFailed)
        }
    }

    private func apply(_ membership: ChannelMembership) {
        guard let index = members.firstIndex(where: { $0.id == membership.memberId }) else {
            return
        }
        if membership.isActive {
            if !members[index].channelIds.contains(membership.channelId) {
                members[index].channelIds.append(membership.channelId)
            }
        } else {
            members[index].channelIds.removeAll { $0 == membership.channelId }
        }
    }

    private func applyLocalProfileHints(to loaded: [Member]) -> [Member] {
        loaded.map { member in
            var copy = member
            if let localName = MomoLocalProfileStore.displayName(for: copy) {
                copy.displayName = localName
            }
            if let avatarPath = MomoLocalProfileStore.avatarPath(for: copy) {
                copy.avatarURL = URL(fileURLWithPath: avatarPath)
            }
            if let localPresence = MomoLocalProfileStore.presence(for: copy) {
                copy.presence = localPresence
            }
            return copy
        }
    }

    private func reportConnectionError(
        _ error: any Error,
        as issue: MomoConnectionIssue = .loadFailed
    ) {
        connectionError = String(describing: error)
        if let backendError = error as? BackendError,
           case .problem(let status, _, _) = backendError,
           status == 401 {
            connectionIssue = .authenticationExpired
        } else {
            reportConnectionIssue(issue)
        }
    }

    private func reportConnectionError(
        _ diagnostic: String,
        as issue: MomoConnectionIssue = .loadFailed
    ) {
        connectionError = diagnostic
        reportConnectionIssue(issue)
    }

    private func reportConnectionIssue(_ issue: MomoConnectionIssue) {
        guard connectionIssue != .authenticationExpired else { return }
        guard connectionIssue != .sendFailed || issue == .sendFailed else { return }
        connectionIssue = issue
    }

    private func clearConnectionErrorState(force: Bool = false) {
        guard force || (connectionIssue != .authenticationExpired && connectionIssue != .sendFailed) else { return }
        connectionError = nil
        connectionIssue = nil
        if force {
            failedMessageSend = nil
        }
    }

    nonisolated private static func microUSD(from value: JSON?) -> Int64? {
        guard let value else { return nil }
        if let int = value.intValue { return int }
        if let string = value.stringValue { return Int64(string) }
        return nil
    }

    nonisolated private static func bool(from value: JSON?) -> Bool? {
        guard let value else { return nil }
        if let bool = value.boolValue { return bool }
        switch value.stringValue?.lowercased() {
        case "true", "yes", "1": return true
        case "false", "no", "0": return false
        default: return nil
        }
    }

    nonisolated private static func body(_ body: String, mentions member: Member) -> Bool {
        let needles = ["@\(member.handle)", "@\(member.displayName)"]
        return needles.contains { token in
            body.range(of: token, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }

    nonisolated public static func activeMentionQuery(in text: String) -> String? {
        guard let range = activeMentionTokenRange(in: text) else { return nil }
        let queryStart = text.index(after: range.lowerBound)
        return String(text[queryStart..<range.upperBound])
    }

    nonisolated private static func activeMentionTokenRange(in text: String) -> Range<String.Index>? {
        guard let at = text.lastIndex(of: "@") else { return nil }
        if at > text.startIndex {
            let before = text[text.index(before: at)]
            guard before.isWhitespace || before.isNewline else { return nil }
        }
        let tokenStart = text.index(after: at)
        let tail = text[tokenStart..<text.endIndex]
        guard !tail.contains(where: { $0.isWhitespace || $0.isNewline }) else { return nil }
        return at..<text.endIndex
    }

    nonisolated private static func normalizedAgentHandle(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let withoutAt = trimmed.hasPrefix("@") ? String(trimmed.dropFirst()) : trimmed
        let normalized = withoutAt.lowercased().filter { character in
            character.isLetter || character.isNumber || character == "-" || character == "_"
        }
        return normalized.isEmpty ? "hermes" : normalized
    }
}
