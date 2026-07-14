import Foundation

/// The shared chat transport contract (L4 §5.3). Implemented in the platform apps
/// over REST (send/history/auth) + SwiftCentrifuge (realtime subscribe).
///
/// Invariants the implementation must uphold (L4 §1.2):
/// - Postgres is the source of truth; clients never publish to Centrifugo directly.
/// - Ordering authority is `Message.seq` (NOT Centrifugo offset).
/// - Optimistic send is idempotent via `clientMsgId`; reconcile by server `seq`.
/// - Recovery / gap-fill uses REST `history(after:)`, not Centrifugo recovery.
public protocol ChatBackend: Sendable {
    /// Connect: REST auth → exchange for a Centrifugo connection JWT → connect.
    func connect(workspace: WorkspaceID, accessToken: String) async throws

    /// Optimistic send: `clientMsgId` is the idempotency key. Returns the
    /// server-reconciled `Message` (carrying the authoritative `seq`).
    func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message

    /// Subscribe to a channel's realtime event stream.
    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent>

    /// Backfill / gap-fill from the SoT. `after` is a `seq` cursor (nil = newest page).
    func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message]

    /// Live presence on a channel.
    func presence(channel: ChannelID) async throws -> [PresenceEntry]

    /// All members of a workspace (humans + agents).
    func members(workspace: WorkspaceID) async throws -> [Member]

    /// Channels visible to the authenticated workspace member.
    func channels(workspace: WorkspaceID) async throws -> [Channel]

    /// Idempotently create or return the existing 1:1 DM with `member`.
    /// The server owns membership creation and returns the canonical DM channel.
    func openDirectMessage(workspace: WorkspaceID, with member: MemberID) async throws -> Channel

    /// Create a public/private channel. The server also adds the creator as owner.
    func createChannel(
        workspace: WorkspaceID,
        kind: ChannelKind,
        name: String,
        topic: String?
    ) async throws -> ChannelCreateResult

    /// Add or reactivate a human/agent member in a channel.
    func addMember(_ member: MemberID, to channel: ChannelID, role: MembershipRole) async throws -> ChannelMembership

    /// Remove an active member from a channel.
    func removeMember(_ member: MemberID, from channel: ChannelID) async throws -> ChannelMembership

    /// Server-owned cost projection for a channel. Clients consume this snapshot;
    /// they do not derive budget state directly from usage_ledger/budget_window.
    func costSnapshots(channel: ChannelID) async throws -> [CostSnapshot]

    /// trgm-backed message search within a workspace.
    func search(workspace: WorkspaceID, query: String) async throws -> [Message]

    /// Publish a typing indicator (best-effort, non-throwing).
    func setTyping(channel: ChannelID, isTyping: Bool) async

    /// Edit a message's body. Returns the updated message.
    func editMessage(_ id: MessageID, body: String) async throws -> Message

    /// Add a reaction to a message.
    func addReaction(_ id: MessageID, emoji: String) async throws

    /// Server-owned C inbox projection. Real clients load this before realtime so
    /// pending approvals survive app restart and are scoped by tenant/channel membership.
    func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval]

    /// Approve or reject a pending approval_request message. Real backends record
    /// the decision, audit it, and resume or deny the paused run server-side.
    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt
}

public extension ChatBackend {
    func openDirectMessage(workspace: WorkspaceID, with member: MemberID) async throws -> Channel {
        throw BackendError.problem(status: 501, title: "not implemented", detail: "direct messages are unavailable")
    }

    func createChannel(
        workspace: WorkspaceID,
        kind: ChannelKind,
        name: String,
        topic: String?
    ) async throws -> ChannelCreateResult {
        throw BackendError.problem(status: 501, title: "not implemented", detail: "channel create is unavailable")
    }

    func addMember(_ member: MemberID, to channel: ChannelID, role: MembershipRole = .member) async throws -> ChannelMembership {
        throw BackendError.problem(status: 501, title: "not implemented", detail: "member add is unavailable")
    }

    func removeMember(_ member: MemberID, from channel: ChannelID) async throws -> ChannelMembership {
        throw BackendError.problem(status: 501, title: "not implemented", detail: "member remove is unavailable")
    }
}
