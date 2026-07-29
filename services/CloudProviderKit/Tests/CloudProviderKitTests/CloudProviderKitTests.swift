import XCTest

@testable import CloudProviderKit

final class CloudProviderKitTests: XCTestCase {
    func testEnvironmentNamespaceFoldsRegistryIdentifier() {
        XCTAssertEqual(
            CloudProviderSettings.environmentNamespace(for: "mock-a"),
            "MOMO_T3_PROVIDER_MOCK_A"
        )
        XCTAssertEqual(
            CloudProviderSettings.environmentNamespace(for: "byoc"),
            "MOMO_T3_PROVIDER_BYOC"
        )
    }

    func testDefaultProviderIsBYOCAndT3StaysDisabled() throws {
        let settings = CloudProviderSettings.load(environment: [:])
        XCTAssertEqual(settings.defaultProviderID, CloudProviderRegistry.byocProviderID)
        XCTAssertFalse(settings.enabled)
        XCTAssertThrowsError(try settings.requireReady()) { error in
            XCTAssertEqual(error as? CloudProviderConfigError, .disabled)
        }
    }

    func testManagedProviderWithoutEndpointFailsClosed() {
        let settings = CloudProviderSettings.load(environment: [
            "MOMO_T3_ENABLED": "1",
            "MOMO_T3_PROVIDER": "mock-a",
            "MOMO_PUBLIC_BASE_URL": "https://momo.example",
        ])
        XCTAssertThrowsError(try settings.requireReady()) { error in
            XCTAssertEqual(error as? CloudProviderConfigError, .missingEndpoint("mock-a"))
        }
    }

    func testDegenerateProviderIsReadyWithoutAnyOperatorCredential() throws {
        let settings = CloudProviderSettings.load(environment: [
            "MOMO_T3_ENABLED": "1",
            "MOMO_T3_PROVIDER": "byoc",
            "MOMO_PUBLIC_BASE_URL": "https://momo.example",
        ])
        let ready = try settings.requireReady()
        XCTAssertTrue(ready.endpoints.isEmpty)
        XCTAssertFalse(ready.defaultCapabilities.managesInstanceLifetime)
        XCTAssertFalse(ready.defaultCapabilities.supports(.create))
        XCTAssertFalse(ready.defaultCapabilities.supports(.destroy))
        XCTAssertTrue(ready.defaultCapabilities.supports(.probe))
    }

    func testManagedProviderReadsItsOwnEnvironmentNamespace() throws {
        let settings = CloudProviderSettings.load(environment: [
            "MOMO_T3_ENABLED": "1",
            "MOMO_T3_PROVIDER": "mock-a",
            "MOMO_T3_PROVIDER_MOCK_A_API_BASE_URL": "http://127.0.0.1:9/providers/mock-a",
            "MOMO_T3_PROVIDER_MOCK_A_API_KEY": "not-a-credential",
            "MOMO_T3_PROVIDER_MOCK_A_IMAGE_REF": "momo-workd",
            "MOMO_T3_PROVIDER_MOCK_A_INSTANCE_TIMEOUT_SECONDS": "120",
            "MOMO_PUBLIC_BASE_URL": "https://momo.example",
        ])
        let ready = try settings.requireReady()
        XCTAssertEqual(ready.endpoints["mock-a"]?.instanceTimeoutSeconds, 120)
        XCTAssertEqual(ready.defaultProviderID, "mock-a")
        XCTAssertTrue(ready.defaultCapabilities.supportsPause)
        XCTAssertEqual(ready.defaultCapabilities.resumeSemantics, .memory)
        // An existing host on another registry key stays addressable.
        XCTAssertNoThrow(try ready.capabilities(for: "byoc"))
    }

    func testUnknownProviderIsRejectedInsteadOfDefaulting() {
        let settings = CloudProviderSettings.load(environment: [
            "MOMO_T3_ENABLED": "1",
            "MOMO_T3_PROVIDER": "not-registered",
            "MOMO_PUBLIC_BASE_URL": "https://momo.example",
        ])
        XCTAssertThrowsError(try settings.requireReady()) { error in
            XCTAssertEqual(
                error as? CloudProviderConfigError, .unknownProvider("not-registered")
            )
        }
    }

    func testCapabilityRefusalIsDeclaredRatherThanSimulated() async throws {
        let capabilities = try CloudProviderRegistry.capabilities(
            for: CloudProviderRegistry.byocProviderID
        )
        let adapter = BYOCProviderAdapter(capabilities: capabilities)
        let ref = CloudInstanceRef(providerID: "byoc", instanceID: "byoc-instance")
        let spec = CloudInstanceSpec(
            provisionID: UUID(),
            workspaceID: UUID(),
            displayName: "byoc",
            registrationToken: "token",
            serverURL: "https://momo.example"
        )
        await assertThrowsCloudProviderError(.unsupported(.create, providerID: "byoc")) {
            _ = try await adapter.create(spec: spec, idempotencyKey: "k")
        }
        await assertThrowsCloudProviderError(.unsupported(.pause, providerID: "byoc")) {
            try await adapter.pause(ref: ref, idempotencyKey: "k")
        }
        await assertThrowsCloudProviderError(.unsupported(.resume, providerID: "byoc")) {
            try await adapter.resume(ref: ref, idempotencyKey: "k")
        }
        // destroy stays idempotent so a durable destroy intent can converge.
        try await adapter.destroy(ref: ref, idempotencyKey: "k")
        // A provider momo cannot ask must answer `unknown`, never `absent`.
        let presence = try await adapter.probe(ref: ref)
        XCTAssertEqual(presence, .unknown)
    }

    func testMockProvidersDeclareDifferentContinuityGuarantees() throws {
        let a = try CloudProviderRegistry.capabilities(for: "mock-a")
        let b = try CloudProviderRegistry.capabilities(for: "mock-b")
        XCTAssertTrue(a.supportsPause)
        XCTAssertFalse(b.supportsPause)
        XCTAssertEqual(a.resumeSemantics, .memory)
        XCTAssertEqual(b.resumeSemantics, .coldBoot)
        XCTAssertNotEqual(a.continuousRuntimeLimitSeconds, b.continuousRuntimeLimitSeconds)
    }

    func testInstanceIdentifiersAreConstrainedBeforeReachingARequestLine() {
        XCTAssertEqual(try validatedCloudInstanceID("mock-a-instance_1"), "mock-a-instance_1")
        XCTAssertThrowsError(try validatedCloudInstanceID("../../etc/passwd"))
        XCTAssertThrowsError(try validatedCloudInstanceID(""))
    }

    private func assertThrowsCloudProviderError(
        _ expected: CloudProviderError,
        _ body: () async throws -> Void
    ) async {
        do {
            try await body()
            XCTFail("expected \(expected)")
        } catch let error as CloudProviderError {
            XCTAssertEqual(error, expected)
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }
}
