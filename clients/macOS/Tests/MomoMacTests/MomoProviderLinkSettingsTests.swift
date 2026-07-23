import Foundation
import MomoCore
import XCTest
@testable import MomoMac

@MainActor
final class MomoProviderLinkSettingsTests: XCTestCase {
    func testLoadPopulatesStatusAndBaseURLDraftButNeverTheBearer() async {
        let fixture = ProviderLinkFixture()
        let client = MockProviderLinkClient(status: fixture.databaseStatus)
        let model = fixture.model(client: client)

        await model.load()

        XCTAssertEqual(model.loadState, .loaded)
        XCTAssertEqual(model.status?.source, .database)
        XCTAssertEqual(model.status?.bearerLast4, "z9k2")
        XCTAssertEqual(model.baseURLDraft, fixture.databaseStatus.baseUrl)
        XCTAssertEqual(model.modeDraft, .externalHermes)
        // The write-only bearer is never populated from a response.
        XCTAssertTrue(model.bearerDraft.isEmpty)
        XCTAssertFalse(model.navigationLocked)
    }

    func testSaveSendsEnteredValuesThenClearsBearerAndReleasesNavigationLock() async {
        let fixture = ProviderLinkFixture()
        let client = MockProviderLinkClient(status: fixture.environmentStatus, putResult: fixture.databaseStatus)
        let model = fixture.model(client: client)
        await model.load()

        model.baseURLDraft = "https://provider.example/v1"
        model.bearerDraft = "  hermes-gateway-bearer-abcdz9k2  "
        XCTAssertTrue(model.hasUnsavedBearer)
        XCTAssertTrue(model.navigationLocked)
        XCTAssertTrue(model.canSave)

        let saved = await model.save()

        XCTAssertTrue(saved)
        XCTAssertEqual(model.notice, .saved)
        XCTAssertEqual(model.status?.source, .database)
        // Bearer is dropped from memory after storage; navigation unlocks.
        XCTAssertTrue(model.bearerDraft.isEmpty)
        XCTAssertFalse(model.navigationLocked)

        let calls = await client.recordedCalls()
        XCTAssertEqual(calls.putRequests.count, 1)
        XCTAssertEqual(calls.putRequests.first?.baseUrl, "https://provider.example/v1")
        // Whitespace trimmed; exact bearer forwarded once.
        XCTAssertEqual(calls.putRequests.first?.bearer, "hermes-gateway-bearer-abcdz9k2")
        XCTAssertEqual(calls.putRequests.first?.mode, .externalHermes)
    }

    func testSaveRejectsInvalidBaseURLWithoutHittingServer() async {
        let fixture = ProviderLinkFixture()
        let client = MockProviderLinkClient(status: fixture.environmentStatus, putResult: fixture.databaseStatus)
        let model = fixture.model(client: client)
        await model.load()

        model.baseURLDraft = "provider.example/v1"  // no scheme
        model.bearerDraft = "bearer"
        XCTAssertFalse(model.canSave)

        let saved = await model.save()
        XCTAssertFalse(saved)
        XCTAssertEqual(model.mutationIssue?.action, .save)
        XCTAssertEqual(model.mutationIssue?.failure, .invalidInput)
        let calls = await client.recordedCalls()
        XCTAssertTrue(calls.putRequests.isEmpty)
    }

    func testBaseURLValidationRejectsUserinfoQueryAndFragment() {
        XCTAssertTrue(MomoProviderLinkBaseURL.isValid("https://provider.example/v1"))
        XCTAssertTrue(MomoProviderLinkBaseURL.isValid("http://127.0.0.1:8080/v1"))
        XCTAssertFalse(MomoProviderLinkBaseURL.isValid(""))
        XCTAssertFalse(MomoProviderLinkBaseURL.isValid("ftp://provider.example/v1"))
        XCTAssertFalse(MomoProviderLinkBaseURL.isValid("https://user:pass@provider.example/v1"))
        XCTAssertFalse(MomoProviderLinkBaseURL.isValid("https://provider.example/v1?token=x"))
        XCTAssertFalse(MomoProviderLinkBaseURL.isValid("https://provider.example/v1#frag"))
    }

    func testTestExposesTestingStateThenSuccess() async {
        let fixture = ProviderLinkFixture()
        let client = MockProviderLinkClient(
            status: fixture.databaseStatus,
            testResult: fixture.successfulTest,
            testDelayNanoseconds: 100_000_000
        )
        let model = fixture.model(client: client)
        await model.load()

        let task = Task { await model.test() }
        await Task.yield()
        XCTAssertEqual(model.operation, .testing)
        XCTAssertEqual(MomoProviderLinkCopy(language: .korean).testingConnection, "테스트 중")
        XCTAssertEqual(MomoProviderLinkCopy(language: .english).testingConnection, "Testing")

        let ok = await task.value
        XCTAssertTrue(ok)
        XCTAssertEqual(model.operation, .idle)
        XCTAssertEqual(model.testResult?.ok, true)
    }

    func testTestFailureSurfacesCoarseReasonOnly() async {
        let fixture = ProviderLinkFixture()
        let client = MockProviderLinkClient(status: fixture.databaseStatus, testResult: fixture.failedTest)
        let model = fixture.model(client: client)
        await model.load()

        let ok = await model.test()
        XCTAssertTrue(ok)  // the probe operation itself succeeded
        XCTAssertEqual(model.testResult?.ok, false)
        XCTAssertEqual(model.testResult?.reason, "provider_auth_failed")

        let copy = MomoProviderLinkCopy(language: .korean)
        XCTAssertTrue(copy.testFailed("provider_auth_failed").contains("bearer"))
        XCTAssertFalse(copy.testFailed("provider_auth_failed").contains("token"))
        let english = MomoProviderLinkCopy(language: .english)
        XCTAssertTrue(english.testFailed("provider_status_502").contains("502"))
    }

    func testRemoveOnlyAllowedForDatabaseSourceAndRevertsToEnvironment() async {
        let fixture = ProviderLinkFixture()
        let client = MockProviderLinkClient(status: fixture.databaseStatus, deleteResult: fixture.environmentStatus)
        let model = fixture.model(client: client)
        await model.load()

        XCTAssertTrue(model.canRemove)
        let removed = await model.remove()
        XCTAssertTrue(removed)
        XCTAssertEqual(model.notice, .removed)
        XCTAssertEqual(model.status?.source, .environment)
        XCTAssertFalse(model.canRemove)
        let calls = await client.recordedCalls()
        XCTAssertEqual(calls.deleteCount, 1)
    }

    func testRemoveNoOpWhenSourceIsEnvironment() async {
        let fixture = ProviderLinkFixture()
        let client = MockProviderLinkClient(status: fixture.environmentStatus, deleteResult: fixture.environmentStatus)
        let model = fixture.model(client: client)
        await model.load()

        XCTAssertFalse(model.canRemove)
        let removed = await model.remove()
        XCTAssertFalse(removed)
        let calls = await client.recordedCalls()
        XCTAssertEqual(calls.deleteCount, 0)
    }

    func testForbiddenLoadClassifiesAsForbidden() async {
        let fixture = ProviderLinkFixture()
        let client = MockProviderLinkClient(
            status: fixture.databaseStatus,
            getError: MomoProviderLinkClientError.http(status: 403, message: "forbidden")
        )
        let model = fixture.model(client: client)

        await model.load()

        XCTAssertEqual(model.loadState, .failed(.forbidden))
    }

    func testOfflineLoadClassifiesAsOfflineState() async {
        let fixture = ProviderLinkFixture()
        let client = MockProviderLinkClient(
            status: fixture.databaseStatus,
            getError: MomoProviderLinkClientError.offline
        )
        let model = fixture.model(client: client)

        await model.load()

        XCTAssertEqual(model.loadState, .offline)
    }

    func testDiscardDraftSecretClearsBearerAndUnlocks() async {
        let fixture = ProviderLinkFixture()
        let client = MockProviderLinkClient(status: fixture.environmentStatus)
        let model = fixture.model(client: client)
        await model.load()

        model.bearerDraft = "leftover-secret"
        XCTAssertTrue(model.navigationLocked)
        model.discardDraftSecret()
        XCTAssertTrue(model.bearerDraft.isEmpty)
        XCTAssertFalse(model.navigationLocked)
    }

    func testTestButtonDisabledForMockModeAndEnabledForExternalHermes() async {
        let fixture = ProviderLinkFixture()

        let mockClient = MockProviderLinkClient(status: fixture.environmentStatus)
        let mockModel = fixture.model(client: mockClient)
        await mockModel.load()
        // A local-mock link would always answer not_external_provider, so the
        // reachability probe stays disabled instead of guaranteeing a failed tap.
        XCTAssertEqual(mockModel.status?.mode, .localMock)
        XCTAssertFalse(mockModel.canTest)

        let externalClient = MockProviderLinkClient(status: fixture.databaseStatus)
        let externalModel = fixture.model(client: externalClient)
        await externalModel.load()
        XCTAssertEqual(externalModel.status?.mode, .externalHermes)
        XCTAssertTrue(externalModel.canTest)
    }

    func testDiscardConfirmationCopyIsBilingualAndNextStepAware() {
        let korean = MomoProviderLinkCopy(language: .korean)
        let english = MomoProviderLinkCopy(language: .english)
        // The exit is explained: discarding drops the entered bearer.
        XCTAssertTrue(korean.discardConfirmationMessage.contains("지워집니다"))
        XCTAssertTrue(english.discardAndLeave.contains("Discard"))
        XCTAssertTrue(korean.unsavedBearerHint.contains("bearer"))
        // Internal governance vocabulary never leaks into work-host copy.
        XCTAssertFalse(korean.workHostGuidance.contains("ADR"))
        XCTAssertFalse(english.workHostGuidance.contains("ADR"))
        // Test-mode note points at the next step.
        XCTAssertTrue(korean.testUnavailableForMode.contains("외부 Hermes"))
        XCTAssertTrue(english.testUnavailableForMode.contains("external Hermes"))
    }

    func testConnectionStateMapping() {
        XCTAssertEqual(ProviderConnectionState(status: nil), .notConfigured)
        let fixture = ProviderLinkFixture()
        XCTAssertEqual(ProviderConnectionState(status: fixture.databaseStatus), .connected)
        XCTAssertEqual(ProviderConnectionState(status: fixture.environmentStatus), .notConfigured)
        XCTAssertEqual(ProviderConnectionState(status: fixture.degradedStatus), .degraded)
    }

    func testFailureClassificationCoversStatusCodes() {
        XCTAssertEqual(
            MomoProviderLinkUserFailure.classify(MomoProviderLinkClientError.http(status: 400, message: "")),
            .invalidInput
        )
        XCTAssertEqual(
            MomoProviderLinkUserFailure.classify(MomoProviderLinkClientError.http(status: 401, message: "")),
            .unauthorized
        )
        XCTAssertEqual(
            MomoProviderLinkUserFailure.classify(MomoProviderLinkClientError.http(status: 409, message: "")),
            .conflict
        )
        XCTAssertEqual(
            MomoProviderLinkUserFailure.classify(MomoProviderLinkClientError.transport),
            .offline
        )
    }

    func testCopyIsBilingualForKeySurfaces() {
        let korean = MomoProviderLinkCopy(language: .korean)
        let english = MomoProviderLinkCopy(language: .english)
        XCTAssertEqual(korean.connectionValue(.connected), "연결됨")
        XCTAssertEqual(korean.connectionValue(.notConfigured), "미설정")
        XCTAssertEqual(english.connectionValue(.connected), "Connected")
        XCTAssertEqual(korean.saveConnection, "연결 저장")
        XCTAssertEqual(english.saveConnection, "Save connection")
        // Work host path is named distinctly from the LLM provider path.
        XCTAssertTrue(korean.workHostSectionHeader.contains("work host"))
        XCTAssertTrue(korean.providerSectionHeader.contains("LLM provider"))
    }
}

// MARK: - Fixtures (shared with MomoProviderLinkSnapshotTests)

struct ProviderLinkFixture: Sendable {
    let context = MomoInviteAdminContext(
        baseURL: URL(string: "https://momo.example")!,
        workspace: WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000700")!,
        accessToken: "operator-jwt"
    )

    var databaseStatus: MomoProviderLinkStatus {
        MomoProviderLinkStatus(
            schema: "momo.provider_link.v0",
            configured: true,
            source: .database,
            mode: .externalHermes,
            baseUrl: "https://hermes.internal.example/v1",
            endpointLabel: "hermes.internal.example",
            bearerConfigured: true,
            bearerLast4: "z9k2",
            availability: .available,
            keyConfigured: true,
            updatedAtMs: 1_753_200_000_000,
            updatedBy: UUID(uuidString: "00000000-0000-7000-8000-000000000900"),
            diagnostics: []
        )
    }

    var environmentStatus: MomoProviderLinkStatus {
        MomoProviderLinkStatus(
            schema: "momo.provider_link.v0",
            configured: false,
            source: .environment,
            mode: .localMock,
            baseUrl: "http://127.0.0.1:8080/v1",
            endpointLabel: "local mock",
            bearerConfigured: false,
            bearerLast4: nil,
            availability: .mock,
            keyConfigured: false,
            updatedAtMs: nil,
            updatedBy: nil,
            diagnostics: ["local-only mock provider"]
        )
    }

    var degradedStatus: MomoProviderLinkStatus {
        MomoProviderLinkStatus(
            schema: "momo.provider_link.v0",
            configured: true,
            source: .database,
            mode: .externalHermes,
            baseUrl: "https://hermes.internal.example/v1",
            endpointLabel: "hermes.internal.example",
            bearerConfigured: true,
            bearerLast4: "z9k2",
            availability: .degraded,
            keyConfigured: true,
            updatedAtMs: 1_753_200_000_000,
            updatedBy: UUID(uuidString: "00000000-0000-7000-8000-000000000900"),
            diagnostics: ["provider probe returned 503"]
        )
    }

    var successfulTest: MomoProviderLinkTestResult {
        MomoProviderLinkTestResult(
            schema: "momo.provider_link.test.v0",
            ok: true,
            reason: nil,
            source: .database,
            mode: .externalHermes,
            endpointLabel: "hermes.internal.example",
            checkedAtMs: 1_753_200_100_000
        )
    }

    var failedTest: MomoProviderLinkTestResult {
        MomoProviderLinkTestResult(
            schema: "momo.provider_link.test.v0",
            ok: false,
            reason: "provider_auth_failed",
            source: .database,
            mode: .externalHermes,
            endpointLabel: "hermes.internal.example",
            checkedAtMs: 1_753_200_100_000
        )
    }

    @MainActor
    func model(client: any MomoProviderLinkClient) -> MomoProviderLinkSettingsModel {
        MomoProviderLinkSettingsModel(context: context, client: client)
    }
}

struct ProviderLinkRecordedCalls: Sendable {
    var getCount = 0
    var putRequests: [MomoProviderLinkPutRequest] = []
    var deleteCount = 0
    var testCount = 0
}

actor MockProviderLinkClient: MomoProviderLinkClient {
    private let status: MomoProviderLinkStatus
    private let putResult: MomoProviderLinkStatus?
    private let deleteResult: MomoProviderLinkStatus?
    private let testResult: MomoProviderLinkTestResult?
    private let getError: Error?
    private let testDelayNanoseconds: UInt64
    private var calls = ProviderLinkRecordedCalls()

    init(
        status: MomoProviderLinkStatus,
        putResult: MomoProviderLinkStatus? = nil,
        deleteResult: MomoProviderLinkStatus? = nil,
        testResult: MomoProviderLinkTestResult? = nil,
        getError: Error? = nil,
        testDelayNanoseconds: UInt64 = 0
    ) {
        self.status = status
        self.putResult = putResult
        self.deleteResult = deleteResult
        self.testResult = testResult
        self.getError = getError
        self.testDelayNanoseconds = testDelayNanoseconds
    }

    func recordedCalls() -> ProviderLinkRecordedCalls { calls }

    func get(context: MomoInviteAdminContext) async throws -> MomoProviderLinkStatus {
        calls.getCount += 1
        if let getError { throw getError }
        return status
    }

    func put(
        context: MomoInviteAdminContext,
        request: MomoProviderLinkPutRequest
    ) async throws -> MomoProviderLinkStatus {
        calls.putRequests.append(request)
        return putResult ?? status
    }

    func delete(context: MomoInviteAdminContext) async throws -> MomoProviderLinkStatus {
        calls.deleteCount += 1
        return deleteResult ?? status
    }

    func test(context: MomoInviteAdminContext) async throws -> MomoProviderLinkTestResult {
        calls.testCount += 1
        if testDelayNanoseconds > 0 {
            try? await Task.sleep(nanoseconds: testDelayNanoseconds)
        }
        guard let testResult else { throw MomoProviderLinkClientError.invalidResponse }
        return testResult
    }
}
