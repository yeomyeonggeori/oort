import Foundation

// MARK: - Domain enums (mirror schema_v0.sql ENUMs, wire = snake/lower string)
//
// All are String-backed so they round-trip exactly with the Postgres ENUM text
// representation used in API JSON. Unknown values are tolerated where the server
// may add variants (see `unknown` cases) to keep clients forward-compatible.

/// `message_type` ENUM (schema_v0.sql:15).
public enum MessageType: String, Codable, Sendable, Hashable, CaseIterable {
    case text
    case toolCall = "tool_call"
    case toolResult = "tool_result"
    case diff
    case artifact
    case approvalRequest = "approval_request"
    case system
}

/// `message_state` ENUM (schema_v0.sql:18).
public enum MessageState: String, Codable, Sendable, Hashable, CaseIterable {
    case sent
    case edited
    case deleted
    case failed
}

/// `member_kind` ENUM (schema_v0.sql:11). Agents are first-class members.
public enum MemberKind: String, Codable, Sendable, Hashable, CaseIterable {
    case human
    case agent
}

/// `member_status` ENUM (schema_v0.sql:12).
public enum MemberStatus: String, Codable, Sendable, Hashable, CaseIterable {
    case active
    case invited
    case suspended
    case deleted
}

/// `channel_kind` ENUM (schema_v0.sql:13).
public enum ChannelKind: String, Codable, Sendable, Hashable, CaseIterable {
    case publicChannel = "public"
    case privateChannel = "private"
    case dm
}

/// `membership_role` ENUM (schema_v0.sql:14).
public enum MembershipRole: String, Codable, Sendable, Hashable, CaseIterable {
    case owner
    case admin
    case member
    case guest
}

/// `run_status` ENUM (schema_v0.sql:19) — agent_run state machine.
/// Surfaced in the UI as `agent.status` transitions (L4 §5.2).
public enum RunStatus: String, Codable, Sendable, Hashable, CaseIterable {
    case queued
    case running
    case awaitingApproval = "awaiting_approval"
    case paused
    case succeeded
    case failed
    case cancelled
    case timedOut = "timed_out"
}

/// Product-level A2A-style `agent_run` lifecycle.
///
/// This is intentionally separate from `RunStatus`, which mirrors the current
/// Postgres enum. `paused` and `timed_out` remain DB compatibility states; UI and
/// protocol surfaces should project them through this seven-state lifecycle.
public enum AgentRunLifecycleStatus: String, Codable, Sendable, Hashable, CaseIterable {
    case queued
    case running
    case inputRequired = "input_required"
    case awaitingApproval = "awaiting_approval"
    case succeeded
    case failed
    case cancelled
}

public extension RunStatus {
    var lifecycleStatus: AgentRunLifecycleStatus {
        switch self {
        case .queued:
            return .queued
        case .running:
            return .running
        case .awaitingApproval:
            return .awaitingApproval
        case .paused:
            return .inputRequired
        case .succeeded:
            return .succeeded
        case .failed, .timedOut:
            return .failed
        case .cancelled:
            return .cancelled
        }
    }

    var isTerminal: Bool {
        switch lifecycleStatus {
        case .succeeded, .failed, .cancelled:
            return true
        case .queued, .running, .inputRequired, .awaitingApproval:
            return false
        }
    }
}

/// `approval_status` ENUM (schema_v0.sql:22).
public enum ApprovalStatus: String, Codable, Sendable, Hashable, CaseIterable {
    case pending
    case approved
    case rejected
    case expired
    case cancelled
}

/// Realtime presence state for a member on a channel.
/// Not a Postgres ENUM — derived from Centrifugo presence + `agent.status`
/// (L4 §4.2 presence absorbed into `ch` namespace; §5.2 note).
public enum Presence: String, Codable, Sendable, Hashable, CaseIterable {
    case online
    case away
    case offline
    /// Agent is actively working (derived from `agent:` channel presence / status).
    case working
}

/// Live agent status stream values published on `agent.status`
/// (L4 §5.2: queued/thinking/streaming/done/error).
public enum AgentStatusPhase: String, Codable, Sendable, Hashable, CaseIterable {
    case queued
    case thinking
    case streaming
    case done
    case error
}
