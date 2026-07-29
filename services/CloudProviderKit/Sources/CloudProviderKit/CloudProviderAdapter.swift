import Foundation

/// ADR-0142 D2 — the surface a T3 execution substrate must implement.
///
/// The lifecycle rules (durable intent, idempotency key, `t3_terminate`,
/// advisory serialization, transition table) live in ADR-0140 and are
/// provider-general. This protocol is the only place a provider-specific fact
/// is allowed to exist; policy code (reconciler, sweep, REST) reads
/// `capabilities` and never a provider identifier constant.
public protocol CloudProviderAdapter: Sendable {
    var capabilities: CloudProviderCapabilities { get }

    /// Create one instance and inject its one-shot workd bootstrap material.
    /// Re-calling with the same `idempotencyKey` must converge on the same
    /// instance rather than creating a second billable one.
    func create(
        spec: CloudInstanceSpec,
        idempotencyKey: String
    ) async throws -> CloudInstanceRef

    /// Suspend an instance. Adapters that do not support pause declare it in
    /// `capabilities` and throw `.unsupported` — simulating a pause is banned
    /// because the ledger would then bill a running instance as paused.
    func pause(ref: CloudInstanceRef, idempotencyKey: String) async throws

    /// Resume a paused instance. `capabilities.resumeSemantics` states whether
    /// process/memory state survives; nothing else may assume it does.
    func resume(ref: CloudInstanceRef, idempotencyKey: String) async throws

    /// Idempotent. An already-absent instance is success, not an error: the
    /// intent ("this instance must not exist") is satisfied either way.
    func destroy(ref: CloudInstanceRef, idempotencyKey: String) async throws

    /// Fact lookup behind the ADR-0140 D4 convergence rules. Three-valued on
    /// purpose: "I could not reach the provider" is not "the instance is gone",
    /// and settling a paid session on the second meaning would be a silent
    /// failure (ADR-0142 D3.1).
    func probe(ref: CloudInstanceRef) async throws -> CloudInstancePresence
}

/// The five adapter operations, so capability refusals can name themselves.
public enum CloudProviderOperation: String, Sendable, Equatable, CaseIterable {
    case create
    case pause
    case resume
    case destroy
    case probe
}

/// What survives a pause/resume round trip.
public enum CloudResumeSemantics: String, Sendable, Equatable {
    /// Process and memory state are restored from a snapshot on resume.
    case memory
    /// Only durable storage survives; the instance boots again from cold.
    case coldBoot
}

/// Whether the provider believes an instance still exists.
public enum CloudInstancePresence: String, Sendable, Equatable {
    case present
    case absent
    /// The provider could not answer. Never treat this as `absent`.
    case unknown
}

/// ADR-0142 D2 capability declaration. Every provider-specific number that
/// used to sit in policy code (pause cost per GiB, continuous runtime ceiling,
/// concurrency limit) lives here.
public struct CloudProviderCapabilities: Sendable, Equatable {
    public let providerID: String
    /// momo can create and destroy instances on this provider. False for BYOC:
    /// the host's lifetime belongs to its owner and momo only observes it.
    public let managesInstanceLifetime: Bool
    public let supportsPause: Bool
    public let resumeSemantics: CloudResumeSemantics
    /// Longest single uninterrupted run the provider will allow, if any.
    public let continuousRuntimeLimitSeconds: Int?
    /// Wall-clock cost of a pause per GiB of instance memory, if declared.
    public let pauseSecondsPerGiB: Double?
    /// Provider-side ceiling on simultaneously running instances, if declared.
    public let maxConcurrentInstances: Int?

    public init(
        providerID: String,
        managesInstanceLifetime: Bool,
        supportsPause: Bool,
        resumeSemantics: CloudResumeSemantics,
        continuousRuntimeLimitSeconds: Int? = nil,
        pauseSecondsPerGiB: Double? = nil,
        maxConcurrentInstances: Int? = nil
    ) {
        self.providerID = providerID
        self.managesInstanceLifetime = managesInstanceLifetime
        self.supportsPause = supportsPause
        self.resumeSemantics = resumeSemantics
        self.continuousRuntimeLimitSeconds = continuousRuntimeLimitSeconds
        self.pauseSecondsPerGiB = pauseSecondsPerGiB
        self.maxConcurrentInstances = maxConcurrentInstances
    }

    public func supports(_ operation: CloudProviderOperation) -> Bool {
        switch operation {
        case .create, .destroy: return managesInstanceLifetime
        case .pause, .resume: return supportsPause
        case .probe: return true
        }
    }
}

/// Everything an adapter needs to start one instance. Deliberately carries no
/// provider credential: the operator key stays inside the adapter's own
/// configuration and never enters a workspace row, response, or log (ADR-0004).
public struct CloudInstanceSpec: Sendable, Equatable {
    public let provisionID: UUID
    public let workspaceID: UUID
    public let displayName: String
    /// One-shot workd registration token. Only its digest reaches PostgreSQL.
    public let registrationToken: String
    /// Public momo base URL the workd registers back against.
    public let serverURL: String

    public init(
        provisionID: UUID,
        workspaceID: UUID,
        displayName: String,
        registrationToken: String,
        serverURL: String
    ) {
        self.provisionID = provisionID
        self.workspaceID = workspaceID
        self.displayName = displayName
        self.registrationToken = registrationToken
        self.serverURL = serverURL
    }
}

/// A durable handle to one provider instance. `providerID` travels with the
/// instance so a workspace that moved providers cannot address the old one.
public struct CloudInstanceRef: Sendable, Equatable, Hashable {
    public let providerID: String
    public let instanceID: String

    public init(providerID: String, instanceID: String) {
        self.providerID = providerID
        self.instanceID = instanceID
    }
}

public enum CloudProviderError: Error, Sendable, Equatable {
    /// The adapter declares it cannot do this — it did not fake it.
    case unsupported(CloudProviderOperation, providerID: String)
    /// The provider says the instance no longer exists.
    case instanceMissing
    /// Honest refusal: the instance is paused and this call needs it running.
    case instancePaused
    case upstreamStatus(Int)
    case invalidResponse
    case requestFailed
    case notConfigured(String)
}

/// Instance identifiers are interpolated into provider URLs, so they are
/// constrained to an opaque-token charset before ever reaching a request line.
public func validatedCloudInstanceID(_ value: String) throws -> String {
    guard value.wholeMatch(of: /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/) != nil else {
        throw CloudProviderError.invalidResponse
    }
    return value
}
