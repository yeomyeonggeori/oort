import Foundation

// =============================================================================
// WorkEngineAdapter — engine-agnostic work host execution surface (MOMO-579 / WH-1)
//
// ADR-0114 증보1 D5: three concrete connection paths (opencode HTTP+SSE, goose
// ACP over stdio, local Codex app-server JSON-RPC over stdio) are normalized
// behind one protocol so the work console drives approvals engine-agnostically.
//
// The single approval contract is `WorkApprovalRequest` / `WorkApprovalDecision`:
//   * opencode  `POST /session/{id}/permissions/{permissionID}`
//   * Codex     `*ApprovalParams` -> `*ApprovalResponse`
//   * ACP/goose `session/request_permission`
// all collapse onto the same request the host presents and the same decision the
// host returns. Absence of a bridge is always a rejection (fail closed).
//
// ADR-0004 boundary is preserved by construction: adapters are consumers of the
// user host's engine + credentials; nothing here reads, stores, or forwards a
// provider key / OAuth token. The engine-native payload survives only in the
// host-local `raw` field and the local JSONL sink, never in the relayed summary.
// =============================================================================

/// The concrete engine backing a work session. `codexLocal` is never bundled in
/// the sidecar image — it connects to the user host's own Codex install.
public enum WorkEngine: String, Sendable, Equatable, CaseIterable, Codable {
    case opencode
    case goose
    case codexLocal = "codex-local"

    /// ADR-0114 증보1 D1: opencode is the default embedded engine.
    public static let `default`: WorkEngine = .opencode
}

/// Approval affordance offered by the engine, normalized across wire formats.
public enum WorkApprovalKind: String, Sendable, Equatable {
    case allowOnce
    case allowAlways
    case rejectOnce
    case rejectAlways
    case other

    /// Best-effort mapping from an ACP `PermissionOption.kind` string.
    public init(acpKind: String?) {
        switch acpKind {
        case "allow_once": self = .allowOnce
        case "allow_always": self = .allowAlways
        case "reject_once": self = .rejectOnce
        case "reject_always": self = .rejectAlways
        default: self = .other
        }
    }

    public var isAllow: Bool { self == .allowOnce || self == .allowAlways }
}

public struct WorkApprovalOption: Sendable, Equatable {
    public let optionID: String
    public let name: String
    public let kind: WorkApprovalKind

    public init(optionID: String, name: String, kind: WorkApprovalKind) {
        self.optionID = optionID
        self.name = name
        self.kind = kind
    }
}

/// One normalized approval prompt. `requestID` is the engine-native correlation
/// handle (opencode permissionID, Codex JSON-RPC request id, ACP request id) the
/// adapter uses to route the decision back to the right engine call.
public struct WorkApprovalRequest: Sendable, Equatable {
    public let engine: WorkEngine
    public let sessionID: String
    public let requestID: String
    public let toolName: String?
    public let title: String?
    public let detail: String?
    public let options: [WorkApprovalOption]
    /// Engine-native payload. Host-local only (ADR-0004): never relayed as-is.
    public let raw: ACPValue

    public init(
        engine: WorkEngine,
        sessionID: String,
        requestID: String,
        toolName: String? = nil,
        title: String? = nil,
        detail: String? = nil,
        options: [WorkApprovalOption],
        raw: ACPValue = .object([:])
    ) {
        self.engine = engine
        self.sessionID = sessionID
        self.requestID = requestID
        self.toolName = toolName
        self.title = title
        self.detail = detail
        self.options = options
        self.raw = raw
    }

    /// The option id the host should pick to allow, if one is offered.
    public var firstAllowOption: WorkApprovalOption? {
        options.first(where: { $0.kind.isAllow })
    }

    /// The option id the host should pick to reject, if one is offered.
    public var firstRejectOption: WorkApprovalOption? {
        options.first(where: { !$0.kind.isAllow })
    }
}

/// The host's decision. `allow`/`deny` carry the engine option id when the engine
/// enumerates options (opencode/ACP); `cancelled` is the fail-closed default and
/// the response when no offered option matches.
public enum WorkApprovalDecision: Sendable, Equatable {
    case allow(optionID: String)
    case deny(optionID: String?)
    case cancelled
}

public protocol WorkApprovalHandler: Sendable {
    func decide(_ request: WorkApprovalRequest) async -> WorkApprovalDecision
}

/// Default in every adapter until an app approval bridge injects a real handler:
/// a daemon-only session has no authority to approve on a human's behalf.
public struct WorkFailClosedApprovalHandler: WorkApprovalHandler {
    public init() {}
    public func decide(_ request: WorkApprovalRequest) async -> WorkApprovalDecision {
        .cancelled
    }
}

/// A fixed decision, useful for tests and for a console that has already resolved
/// the human choice out of band.
public struct WorkStaticApprovalHandler: WorkApprovalHandler {
    private let decision: WorkApprovalDecision
    public init(_ decision: WorkApprovalDecision) { self.decision = decision }
    public func decide(_ request: WorkApprovalRequest) async -> WorkApprovalDecision {
        decision
    }
}

public struct WorkTurnResult: Sendable, Equatable {
    public let sessionID: String
    public let stopReason: String?

    public init(sessionID: String, stopReason: String?) {
        self.sessionID = sessionID
        self.stopReason = stopReason
    }
}

public enum WorkEngineError: Error, Sendable, Equatable {
    case notStarted
    case invalidResponse(String)
    case transport(String)
    case unsupported(String)
}

/// Engine-agnostic session lifecycle. Each concrete adapter maps this onto its
/// own wire protocol; approvals always flow through the injected
/// `WorkApprovalHandler`, and progress/status/approval events flow through the
/// injected `ACPEventSink` (reusing momo's existing projected-event envelope so
/// all three engines share one durable local record + relayed summary shape).
public protocol WorkEngineAdapter: Sendable, AnyObject {
    var engine: WorkEngine { get }

    /// Establishes the underlying engine session and returns its native id.
    func createSession(title: String?) async throws -> String

    /// Runs one prompt/turn to completion, streaming events and resolving any
    /// approval prompts through the handler supplied at construction.
    @discardableResult
    func prompt(sessionID: String, text: String) async throws -> WorkTurnResult

    /// Releases the engine session and any transport resources.
    func shutdown() async
}
