import Foundation

/// ADR-0142 D1 — bring-your-own-cloud, the base form.
///
/// The owner installs `momo-workd` on their own VM and spends a one-shot
/// enrollment token; momo never gained the right to boot or kill that machine,
/// so `create` refuses instead of pretending. `destroy` is the one asymmetry:
/// the durable intent it serves is "momo must stop treating this host as
/// available", which momo *can* satisfy (it revokes the host row), so it
/// succeeds idempotently rather than trapping the lifecycle in a state no
/// retry could ever leave.
public struct BYOCProviderAdapter: CloudProviderAdapter {
    public let capabilities: CloudProviderCapabilities

    public init(capabilities: CloudProviderCapabilities) {
        self.capabilities = capabilities
    }

    public func create(
        spec: CloudInstanceSpec,
        idempotencyKey: String
    ) async throws -> CloudInstanceRef {
        throw CloudProviderError.unsupported(.create, providerID: capabilities.providerID)
    }

    public func pause(ref: CloudInstanceRef, idempotencyKey: String) async throws {
        throw CloudProviderError.unsupported(.pause, providerID: capabilities.providerID)
    }

    public func resume(ref: CloudInstanceRef, idempotencyKey: String) async throws {
        throw CloudProviderError.unsupported(.resume, providerID: capabilities.providerID)
    }

    public func destroy(ref: CloudInstanceRef, idempotencyKey: String) async throws {
        // Releasing momo's own binding is always possible and always idempotent.
        // The owner's machine keeps running; that is the documented contract,
        // and so is the residual-snapshot notice in the self-host guide.
    }

    /// momo has no provider API to ask. Reporting `absent` here would be the
    /// silent-failure ADR-0142 D3.1 bans (it would settle a live session), and
    /// reporting `present` would be a lie. Host liveness is already carried by
    /// the workd heartbeat and the existing offline sweep.
    public func probe(ref: CloudInstanceRef) async throws -> CloudInstancePresence {
        .unknown
    }
}
