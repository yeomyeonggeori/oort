import Foundation
import MomoCore
import XCTest
@testable import MomoMac

@MainActor
final class MomoWorkHostEngineSettingsTests: XCTestCase {
    func testLoadPopulatesStatusAndSeedsEngineDraft() async {
        let fixture = WorkHostEngineFixture()
        let client = MockWorkHostEngineClient(status: fixture.gooseDatabaseStatus)
        let model = fixture.model(client: client)

        await model.load()

        XCTAssertEqual(model.loadState, .loaded)
        XCTAssertEqual(model.status?.engine, .goose)
        XCTAssertEqual(model.status?.source, .database)
        XCTAssertEqual(model.engineDraft, .goose)
        // No change yet, so Save has nothing to send.
        XCTAssertFalse(model.canSave)
    }

    func testCanSaveOnlyWhenEngineChanged() async {
        let fixture = WorkHostEngineFixture()
        let client = MockWorkHostEngineClient(status: fixture.opencodeDefaultStatus)
        let model = fixture.model(client: client)
        await model.load()

        XCTAssertEqual(model.engineDraft, .opencode)
        XCTAssertFalse(model.canSave)
        model.engineDraft = .codexLocal
        XCTAssertTrue(model.canSave)
        model.engineDraft = .opencode
        XCTAssertFalse(model.canSave, "returning to the stored engine must disable Save")
    }

    func testSaveSendsSelectedEngineAndShowsSavedNotice() async {
        let fixture = WorkHostEngineFixture()
        let client = MockWorkHostEngineClient(
            status: fixture.opencodeDefaultStatus,
            putResult: fixture.codexLocalDatabaseStatus
        )
        let model = fixture.model(client: client)
        await model.load()

        model.engineDraft = .codexLocal
        XCTAssertTrue(model.canSave)

        let saved = await model.save()

        XCTAssertTrue(saved)
        XCTAssertEqual(model.notice, .saved)
        XCTAssertEqual(model.status?.engine, .codexLocal)
        XCTAssertEqual(model.status?.source, .database)
        // Draft now matches the stored engine, so Save disables again.
        XCTAssertFalse(model.canSave)

        let calls = await client.recordedCalls()
        XCTAssertEqual(calls.putRequests.map(\.engine), [.codexLocal])
    }

    func testSaveNoOpWhenEngineUnchanged() async {
        let fixture = WorkHostEngineFixture()
        let client = MockWorkHostEngineClient(status: fixture.gooseDatabaseStatus)
        let model = fixture.model(client: client)
        await model.load()

        let saved = await model.save()
        XCTAssertFalse(saved)
        let calls = await client.recordedCalls()
        XCTAssertTrue(calls.putRequests.isEmpty)
    }

    func testForbiddenLoadClassifiesAsFailedForbidden() async {
        let fixture = WorkHostEngineFixture()
        let client = MockWorkHostEngineClient(
            status: fixture.opencodeDefaultStatus,
            getError: MomoProviderLinkClientError.http(status: 403, message: "forbidden")
        )
        let model = fixture.model(client: client)

        await model.load()

        XCTAssertEqual(model.loadState, .failed(.forbidden))
    }

    func testOfflineLoadClassifiesAsOfflineState() async {
        let fixture = WorkHostEngineFixture()
        let client = MockWorkHostEngineClient(
            status: fixture.opencodeDefaultStatus,
            getError: MomoProviderLinkClientError.offline
        )
        let model = fixture.model(client: client)

        await model.load()

        XCTAssertEqual(model.loadState, .offline)
    }

    func testSaveForbiddenSurfacesForbiddenGuidance() async {
        let fixture = WorkHostEngineFixture()
        let client = MockWorkHostEngineClient(
            status: fixture.opencodeDefaultStatus,
            putError: MomoProviderLinkClientError.http(status: 403, message: "forbidden")
        )
        let model = fixture.model(client: client)
        await model.load()
        model.engineDraft = .goose

        let saved = await model.save()

        XCTAssertFalse(saved)
        XCTAssertEqual(model.mutationIssue?.action, .save)
        XCTAssertEqual(model.mutationIssue?.failure, .forbidden)

        let korean = MomoWorkHostEngineCopy(language: .korean)
        XCTAssertTrue(korean.saveFailure(model.mutationIssue!).contains("서버 운영자에게 문의"))
        let english = MomoWorkHostEngineCopy(language: .english)
        XCTAssertTrue(english.failureDescription(.forbidden).contains("Contact a server operator"))
    }

    func testInvalidEngineSaveSurfacesInvalidInputGuidance() async {
        let fixture = WorkHostEngineFixture()
        let client = MockWorkHostEngineClient(
            status: fixture.opencodeDefaultStatus,
            putError: MomoProviderLinkClientError.http(status: 400, message: "bad engine")
        )
        let model = fixture.model(client: client)
        await model.load()
        model.engineDraft = .goose

        let saved = await model.save()
        XCTAssertFalse(saved)
        XCTAssertEqual(model.mutationIssue?.failure, .invalidInput)
        let english = MomoWorkHostEngineCopy(language: .english)
        XCTAssertTrue(english.saveFailure(model.mutationIssue!).contains("supported engine"))
    }

    func testEngineIsClosedWorldRawValues() {
        XCTAssertEqual(MomoWorkHostEngine.opencode.rawValue, "opencode")
        XCTAssertEqual(MomoWorkHostEngine.goose.rawValue, "goose")
        XCTAssertEqual(MomoWorkHostEngine.codexLocal.rawValue, "codex-local")
        XCTAssertEqual(MomoWorkHostEngine.allCases.count, 3)
        XCTAssertTrue(MomoWorkHostEngine.opencode.isBundled)
        XCTAssertTrue(MomoWorkHostEngine.goose.isBundled)
        XCTAssertFalse(MomoWorkHostEngine.codexLocal.isBundled)
    }

    func testStatusDecodesWithoutOptionalMetadata() throws {
        let json = Data(#"{"engine":"codex-local","source":"database"}"#.utf8)
        let status = try JSONDecoder().decode(MomoWorkHostEngineStatus.self, from: json)
        XCTAssertEqual(status.engine, .codexLocal)
        XCTAssertEqual(status.source, .database)
        XCTAssertNil(status.updatedBy)
        XCTAssertNil(status.updatedAtMs)
    }

    func testStatusIgnoresUnknownServerFields() throws {
        let json = Data(#"{"engine":"opencode","source":"default","schema":"momo.work_host_engine.v0","updatedBy":"seongjae","updatedAtMs":1753200000000}"#.utf8)
        let status = try JSONDecoder().decode(MomoWorkHostEngineStatus.self, from: json)
        XCTAssertEqual(status.engine, .opencode)
        XCTAssertEqual(status.source, .default)
        XCTAssertEqual(status.updatedBy, "seongjae")
        XCTAssertEqual(status.updatedAtMs, 1_753_200_000_000)
    }

    // MARK: - Pairing projection

    func testPairingProjectionCoversRegistrationStates() {
        XCTAssertEqual(
            MomoWorkHostPairing(state: .waitingForSession, heartbeatIssue: nil),
            .waitingForSession
        )
        XCTAssertEqual(
            MomoWorkHostPairing(state: .registering, heartbeatIssue: nil),
            .pairing
        )
        XCTAssertEqual(
            MomoWorkHostPairing(state: .failed(.hostRegistrationFailed), heartbeatIssue: nil),
            .failed(.hostRegistrationFailed)
        )

        let onlineHost = WorkHostEngineFixture.host(displayName: "Momo on Seongjae MacBook Pro", online: true)
        XCTAssertEqual(
            MomoWorkHostPairing(state: .ready(onlineHost), heartbeatIssue: nil).connection,
            .connected
        )
        // A heartbeat failure downgrades a ready host to offline even if online is stale.
        XCTAssertEqual(
            MomoWorkHostPairing(state: .ready(onlineHost), heartbeatIssue: .hostHeartbeatFailed).connection,
            .offline
        )
        let offlineHost = WorkHostEngineFixture.host(displayName: "Momo on Seongjae MacBook Pro", online: false)
        XCTAssertEqual(
            MomoWorkHostPairing(state: .ready(offlineHost), heartbeatIssue: nil).connection,
            .offline
        )
    }

    func testPairingConnectionMapping() {
        XCTAssertEqual(MomoWorkHostPairing.waitingForSession.connection, .waiting)
        XCTAssertEqual(MomoWorkHostPairing.pairing.connection, .pairing)
        XCTAssertEqual(MomoWorkHostPairing.failed(.unavailable).connection, .notPaired)
    }

    // MARK: - Copy

    func testCopyIsBilingualAndDistinguishesProviderPath() {
        let korean = MomoWorkHostEngineCopy(language: .korean)
        let english = MomoWorkHostEngineCopy(language: .english)

        XCTAssertEqual(korean.saveEngine, "엔진 저장")
        XCTAssertEqual(english.saveEngine, "Save engine")
        XCTAssertEqual(korean.pairingConnectionValue(.connected), "연결됨")
        XCTAssertEqual(korean.pairingConnectionValue(.offline), "오프라인")
        XCTAssertEqual(english.pairingConnectionValue(.notPaired), "Not paired")

        // The LLM provider path is named distinctly from the code execution host.
        XCTAssertTrue(korean.providerDistinction.contains("AI 연결"))
        XCTAssertTrue(korean.providerDistinction.contains("코드 실행 호스트"))
        XCTAssertTrue(english.providerDistinction.contains("AI connection"))

        // Engine summaries differentiate bundled engines from the local Codex CLI.
        XCTAssertTrue(korean.engineSummary(.opencode).contains("별도 설치가 필요 없습니다"))
        XCTAssertTrue(korean.engineSummary(.codexLocal).contains("Codex CLI"))
        XCTAssertTrue(english.engineSummary(.codexLocal).contains("your own host"))
        XCTAssertNotEqual(english.engineSummary(.opencode), english.engineSummary(.codexLocal))
    }

    func testUserVisibleCopyHasNoEmDashOrGovernanceVocabulary() {
        for language in MomoUILanguage.allCases {
            let copy = MomoWorkHostEngineCopy(language: language)
            let strings: [String] = [
                copy.pairingSectionHeader,
                copy.pairingSectionFooter,
                copy.pairingStatusLabel,
                copy.hostNameLabel,
                copy.lastSeenLabel,
                copy.retryPairing,
                copy.engineSectionHeader,
                copy.engineSectionFooter,
                copy.engineLabel,
                copy.currentEngineLabel,
                copy.sourceLabel,
                copy.updatedLabel,
                copy.saveEngine,
                copy.savingEngine,
                copy.savedNotice,
                copy.providerDistinctionHeader,
                copy.providerDistinction,
                copy.refresh,
                copy.loading,
                copy.tryAgain,
                copy.unavailableTitle,
                copy.unavailableDescription,
                copy.offlineTitle,
                copy.offlineDescription,
                copy.loadFailedTitle,
            ]
                + MomoWorkHostEngine.allCases.map(copy.engineName)
                + MomoWorkHostEngine.allCases.map(copy.engineSummary)
                + [MomoWorkHostPairingConnection.connected, .offline, .pairing, .waiting, .notPaired]
                    .map(copy.pairingConnectionValue)

            for string in strings {
                XCTAssertFalse(string.contains("\u{2014}"), "em-dash in: \(string)")
                XCTAssertFalse(string.contains("\u{2013}"), "en-dash in: \(string)")
                XCTAssertFalse(string.contains("ADR"), "governance vocabulary in: \(string)")
            }
        }
    }
}

// MARK: - Fixtures

struct WorkHostEngineFixture: Sendable {
    let context = MomoInviteAdminContext(
        baseURL: URL(string: "https://momo.example")!,
        workspace: WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000706")!,
        accessToken: "operator-jwt"
    )

    var opencodeDefaultStatus: MomoWorkHostEngineStatus {
        MomoWorkHostEngineStatus(
            engine: .opencode,
            source: .default,
            updatedBy: nil,
            updatedAtMs: nil
        )
    }

    var gooseDatabaseStatus: MomoWorkHostEngineStatus {
        MomoWorkHostEngineStatus(
            engine: .goose,
            source: .database,
            updatedBy: "00000000-0000-7000-8000-000000000900",
            updatedAtMs: 1_753_200_000_000
        )
    }

    var codexLocalDatabaseStatus: MomoWorkHostEngineStatus {
        MomoWorkHostEngineStatus(
            engine: .codexLocal,
            source: .database,
            updatedBy: "00000000-0000-7000-8000-000000000900",
            updatedAtMs: 1_753_200_100_000
        )
    }

    @MainActor
    func model(client: any MomoWorkHostEngineClient) -> MomoWorkHostEngineSettingsModel {
        MomoWorkHostEngineSettingsModel(context: context, client: client)
    }

    static func host(displayName: String, online: Bool) -> WorkHost {
        WorkHost(
            id: WorkHostID(uuidString: "00000000-0000-7000-8000-000000000901")!,
            workspaceId: WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000706")!,
            scope: .member,
            ownerMemberId: MemberID(uuidString: "00000000-0000-7000-8000-000000000102")!,
            type: .app,
            displayName: displayName,
            publicKey: Data(repeating: 7, count: 32).base64EncodedString(),
            capabilities: ["work.control.realtime": true],
            lastSeenAtMs: 1_753_200_200_000,
            createdAtMs: 1_753_200_000_000,
            online: online
        )
    }
}

struct WorkHostEngineRecordedCalls: Sendable {
    var getCount = 0
    var putRequests: [MomoWorkHostEnginePutRequest] = []
}

actor MockWorkHostEngineClient: MomoWorkHostEngineClient {
    private let status: MomoWorkHostEngineStatus
    private let putResult: MomoWorkHostEngineStatus?
    private let getError: Error?
    private let putError: Error?
    private var calls = WorkHostEngineRecordedCalls()

    init(
        status: MomoWorkHostEngineStatus,
        putResult: MomoWorkHostEngineStatus? = nil,
        getError: Error? = nil,
        putError: Error? = nil
    ) {
        self.status = status
        self.putResult = putResult
        self.getError = getError
        self.putError = putError
    }

    func recordedCalls() -> WorkHostEngineRecordedCalls { calls }

    func get(context: MomoInviteAdminContext) async throws -> MomoWorkHostEngineStatus {
        calls.getCount += 1
        if let getError { throw getError }
        return status
    }

    func put(
        context: MomoInviteAdminContext,
        request: MomoWorkHostEnginePutRequest
    ) async throws -> MomoWorkHostEngineStatus {
        calls.putRequests.append(request)
        if let putError { throw putError }
        return putResult ?? status
    }
}
