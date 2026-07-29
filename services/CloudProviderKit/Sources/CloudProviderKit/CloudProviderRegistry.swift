import Foundation

/// ADR-0142 D2/D4 — `work_cloud_host.provider` is a key into this registry.
///
/// The registry is the *only* table of provider-specific facts. Policy code
/// asks for `capabilities`; it never branches on an identifier. Adding a
/// substrate (ADR-0144) means adding one descriptor here plus its adapter.
public enum CloudProviderRegistry {
    /// Bring-your-own-cloud. Degenerate by construction: momo registers,
    /// schedules, observes and bills the host but never creates or destroys it.
    public static let byocProviderID = "byoc"

    /// Verification-only substrates (ADR-0142 D3). They are registered in the
    /// product binary on purpose: the continuity contract must be provable
    /// against the same code path production uses, not a test-only fork.
    ///
    /// `mock-a` keeps memory across pause; `mock-b` refuses pause outright and
    /// cold-boots. Cross-provider continuity therefore cannot lean on either
    /// provider's convenience.
    public static let mockAProviderID = "mock-a"
    public static let mockBProviderID = "mock-b"

    private static let descriptors: [String: CloudProviderCapabilities] = [
        byocProviderID: CloudProviderCapabilities(
            providerID: byocProviderID,
            managesInstanceLifetime: false,
            supportsPause: false,
            resumeSemantics: .coldBoot
        ),
        mockAProviderID: CloudProviderCapabilities(
            providerID: mockAProviderID,
            managesInstanceLifetime: true,
            supportsPause: true,
            resumeSemantics: .memory,
            continuousRuntimeLimitSeconds: 3_600,
            pauseSecondsPerGiB: 4,
            maxConcurrentInstances: 20
        ),
        mockBProviderID: CloudProviderCapabilities(
            providerID: mockBProviderID,
            managesInstanceLifetime: true,
            supportsPause: false,
            resumeSemantics: .coldBoot,
            continuousRuntimeLimitSeconds: 900,
            maxConcurrentInstances: 5
        ),
    ]

    public static var registeredProviderIDs: [String] {
        descriptors.keys.sorted()
    }

    public static func isRegistered(_ providerID: String) -> Bool {
        descriptors[providerID] != nil
    }

    public static func capabilities(
        for providerID: String
    ) throws -> CloudProviderCapabilities {
        guard let descriptor = descriptors[providerID] else {
            throw CloudProviderConfigError.unknownProvider(providerID)
        }
        return descriptor
    }
}
