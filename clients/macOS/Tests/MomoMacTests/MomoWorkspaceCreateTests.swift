import Foundation
import MomoCore
import XCTest
@testable import MomoMac

@MainActor
final class MomoWorkspaceCreateTests: XCTestCase {
    // MARK: - Slug derivation

    func testSlugDerivationFromLatinName() {
        XCTAssertEqual(MomoWorkspaceSlug.derive(from: "Momo Core Team"), "momo-core-team")
        XCTAssertEqual(MomoWorkspaceSlug.derive(from: "  Momo   Core  "), "momo-core")
        XCTAssertEqual(MomoWorkspaceSlug.derive(from: "Momo_Core_Team"), "momo-core-team")
        XCTAssertEqual(MomoWorkspaceSlug.derive(from: "momo!!!team"), "momo-team")
        XCTAssertEqual(MomoWorkspaceSlug.derive(from: "--Momo--"), "momo")
        XCTAssertEqual(MomoWorkspaceSlug.derive(from: "v2.0 launch"), "v2-0-launch")
    }

    func testSlugDerivationDropsUnusableCharacters() {
        // A Korean-only name has no [a-z0-9] scalars, so the slug is empty and the
        // operator types one directly (the field stays editable).
        XCTAssertEqual(MomoWorkspaceSlug.derive(from: "모모 코어팀"), "")
        // Mixed content keeps only the latin/digit runs.
        XCTAssertEqual(MomoWorkspaceSlug.derive(from: "모모 core 팀 2"), "core-2")
    }

    func testSlugDerivationTruncatesToMaxLength() {
        let long = String(repeating: "a", count: 100)
        let derived = MomoWorkspaceSlug.derive(from: long)
        XCTAssertEqual(derived.count, MomoWorkspaceSlug.maximumLength)
    }

    // MARK: - Slug validation

    func testSlugValidationAcceptsCanonicalShapes() {
        XCTAssertTrue(MomoWorkspaceSlug.isValid("momo-core-team"))
        XCTAssertTrue(MomoWorkspaceSlug.isValid("a"))
        XCTAssertTrue(MomoWorkspaceSlug.isValid("a1"))
        // normalized() lowercases first, mirroring the server's lower(btrim()).
        XCTAssertTrue(MomoWorkspaceSlug.isValid("Momo-Team"))
    }

    func testSlugValidationRejectsBadShapes() {
        XCTAssertFalse(MomoWorkspaceSlug.isValid(""))
        XCTAssertFalse(MomoWorkspaceSlug.isValid("-momo"))
        XCTAssertFalse(MomoWorkspaceSlug.isValid("momo-"))
        XCTAssertFalse(MomoWorkspaceSlug.isValid("momo team"))
        XCTAssertFalse(MomoWorkspaceSlug.isValid("momo_team"))
        XCTAssertFalse(MomoWorkspaceSlug.isValid(String(repeating: "a", count: 64)))
    }

    // MARK: - Name validation

    func testNameValidationBounds() {
        XCTAssertTrue(MomoWorkspaceName.isValid("모모 코어팀"))
        XCTAssertTrue(MomoWorkspaceName.isValid(String(repeating: "a", count: 200)))
        XCTAssertFalse(MomoWorkspaceName.isValid(""))
        XCTAssertFalse(MomoWorkspaceName.isValid("   "))
        XCTAssertFalse(MomoWorkspaceName.isValid(String(repeating: "a", count: 201)))
    }

    // MARK: - Model: auto-derived slug

    func testUpdatingNameAutoDerivesSlugUntilManuallyEdited() {
        let model = WorkspaceCreateFixture().model(client: MockWorkspaceCreateClient())
        model.updateName("Momo Core Team")
        XCTAssertEqual(model.slugDraft, "momo-core-team")
        XCTAssertFalse(model.slugManuallyEdited)

        // A manual slug edit pins it: later name changes must not overwrite it.
        model.updateSlug("core")
        XCTAssertTrue(model.slugManuallyEdited)
        model.updateName("Momo Platform")
        XCTAssertEqual(model.slugDraft, "core")
    }

    func testClearingSlugResumesAutoDerivation() {
        let model = WorkspaceCreateFixture().model(client: MockWorkspaceCreateClient())
        model.updateName("Momo Core")
        model.updateSlug("custom")
        XCTAssertTrue(model.slugManuallyEdited)

        model.updateSlug("")
        XCTAssertFalse(model.slugManuallyEdited)
        model.updateName("Momo Platform")
        XCTAssertEqual(model.slugDraft, "momo-platform")
    }

    func testResetSlugToDerived() {
        let model = WorkspaceCreateFixture().model(client: MockWorkspaceCreateClient())
        model.updateName("Momo Core")
        model.updateSlug("weird_one")
        XCTAssertTrue(model.slugManuallyEdited)

        model.resetSlugToDerived()
        XCTAssertFalse(model.slugManuallyEdited)
        XCTAssertEqual(model.slugDraft, "momo-core")
    }

    // MARK: - Model: create gating

    func testCanCreateRequiresAuthorizationAndValidInput() {
        let unauthorized = MomoWorkspaceCreateModel(context: nil, client: MockWorkspaceCreateClient())
        unauthorized.updateName("Momo Core")
        XCTAssertFalse(unauthorized.isAuthorized)
        XCTAssertFalse(unauthorized.canCreate)

        let model = WorkspaceCreateFixture().model(client: MockWorkspaceCreateClient())
        XCTAssertFalse(model.canCreate) // empty
        model.updateName("Momo Core")
        XCTAssertTrue(model.canCreate)
        model.updateSlug("bad slug")
        XCTAssertFalse(model.canCreate)
    }

    // MARK: - Model: create success

    func testCreateSendsNormalizedValuesAndCapturesResult() async {
        let fixture = WorkspaceCreateFixture()
        let client = MockWorkspaceCreateClient(result: fixture.createdWorkspace)
        let model = fixture.model(client: client)
        model.updateName("  Momo Core Team  ")
        model.updateSlug("Momo-Core-Team")

        let created = await model.create()

        XCTAssertTrue(created)
        XCTAssertEqual(model.created, fixture.createdWorkspace)
        XCTAssertNil(model.failure)
        XCTAssertEqual(model.operation, .idle)

        let calls = await client.recordedCalls()
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.name, "Momo Core Team")
        XCTAssertEqual(calls.first?.slug, "momo-core-team")
    }

    func testCreateExposesCreatingStateWhileInFlight() async {
        let fixture = WorkspaceCreateFixture()
        let client = MockWorkspaceCreateClient(
            result: fixture.createdWorkspace,
            delayNanoseconds: 100_000_000
        )
        let model = fixture.model(client: client)
        model.updateName("Momo Core Team")

        let task = Task { await model.create() }
        await Task.yield()
        XCTAssertEqual(model.operation, .creating)
        XCTAssertTrue(model.isWorking)

        _ = await task.value
        XCTAssertEqual(model.operation, .idle)
    }

    // MARK: - Model: create failures

    func testCreateRejectsInvalidSlugWithoutHittingServer() async {
        let fixture = WorkspaceCreateFixture()
        let client = MockWorkspaceCreateClient(result: fixture.createdWorkspace)
        let model = fixture.model(client: client)
        model.updateName("Momo Core")
        model.updateSlug("bad slug")

        let created = await model.create()
        XCTAssertFalse(created)
        XCTAssertEqual(model.failure, .invalidInput)
        let calls = await client.recordedCalls()
        XCTAssertTrue(calls.isEmpty)
    }

    func testCreateMapsSlugConflict() async {
        let fixture = WorkspaceCreateFixture()
        let client = MockWorkspaceCreateClient(
            error: MomoWorkspaceCreateClientError.http(status: 409, message: "slug taken")
        )
        let model = fixture.model(client: client)
        model.updateName("Momo Core")

        let created = await model.create()
        XCTAssertFalse(created)
        XCTAssertEqual(model.failure, .slugConflict)
        XCTAssertEqual(model.failure?.isSlugSpecific, true)
        XCTAssertNil(model.created)
    }

    func testCreateMapsForbiddenAndOffline() async {
        let fixture = WorkspaceCreateFixture()

        let forbidden = fixture.model(client: MockWorkspaceCreateClient(
            error: MomoWorkspaceCreateClientError.http(status: 403, message: "forbidden")
        ))
        forbidden.updateName("Momo Core")
        _ = await forbidden.create()
        XCTAssertEqual(forbidden.failure, .forbidden)
        XCTAssertEqual(forbidden.failure?.isSlugSpecific, false)

        let offline = fixture.model(client: MockWorkspaceCreateClient(
            error: MomoWorkspaceCreateClientError.offline
        ))
        offline.updateName("Momo Core")
        _ = await offline.create()
        XCTAssertEqual(offline.failure, .offline)
    }

    func testInputChangeClearsPriorFailure() async {
        let fixture = WorkspaceCreateFixture()
        let model = fixture.model(client: MockWorkspaceCreateClient(
            error: MomoWorkspaceCreateClientError.http(status: 409, message: "slug taken")
        ))
        model.updateName("Momo Core")
        _ = await model.create()
        XCTAssertEqual(model.failure, .slugConflict)

        model.updateSlug("another-slug")
        XCTAssertNil(model.failure)
    }

    // MARK: - Failure classification

    func testFailureClassificationCoversStatusCodes() {
        func classify(_ status: Int) -> MomoWorkspaceCreateFailure {
            MomoWorkspaceCreateFailure.classify(
                MomoWorkspaceCreateClientError.http(status: status, message: "")
            )
        }
        XCTAssertEqual(classify(400), .invalidInput)
        XCTAssertEqual(classify(401), .unauthorized)
        XCTAssertEqual(classify(403), .forbidden)
        XCTAssertEqual(classify(409), .slugConflict)
        XCTAssertEqual(classify(500), .other)
        XCTAssertEqual(
            MomoWorkspaceCreateFailure.classify(MomoWorkspaceCreateClientError.transport),
            .offline
        )
        XCTAssertEqual(
            MomoWorkspaceCreateFailure.classify(URLError(.notConnectedToInternet)),
            .offline
        )
    }

    // MARK: - Copy

    func testCopyIsBilingualAndClean() {
        let korean = MomoWorkspaceCreateCopy(language: .korean)
        let english = MomoWorkspaceCreateCopy(language: .english)

        XCTAssertEqual(korean.title, "새 워크스페이스 만들기")
        XCTAssertEqual(english.createAction, "Create workspace")
        XCTAssertTrue(korean.successTitle("모모 코어팀").contains("모모 코어팀"))
        XCTAssertTrue(english.successTitle("Momo Core").contains("Momo Core"))

        // Design-taste hard rules: no em-dashes, no hype vocabulary in UI copy.
        let strings = [
            korean.title, korean.subtitle, korean.nameHelp, korean.slugHelp,
            korean.slugInvalid, korean.slugConflict, korean.forbidden, korean.offline,
            korean.successSubtitle, korean.successInviteAction, korean.unavailableDescription,
            english.title, english.subtitle, english.nameHelp, english.slugHelp,
            english.slugInvalid, english.slugConflict, english.forbidden, english.offline,
            english.successSubtitle, english.successInviteAction, english.unavailableDescription,
        ]
        for string in strings {
            XCTAssertFalse(string.contains("\u{2014}"), "em-dash in copy: \(string)")
            XCTAssertFalse(string.contains("\u{2013}"), "en-dash in copy: \(string)")
        }
        for banned in ["seamless", "effortless", "원활", "손쉽게"] {
            for string in strings {
                XCTAssertFalse(string.lowercased().contains(banned), "hype word '\(banned)' in copy: \(string)")
            }
        }
    }
}

// MARK: - Fixtures (shared with MomoWorkspaceCreateSnapshotTests)

struct WorkspaceCreateFixture: Sendable {
    let context = MomoInviteAdminContext(
        baseURL: URL(string: "https://momo.example")!,
        workspace: WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000700")!,
        accessToken: "operator-jwt"
    )

    var createdWorkspace: MomoCreatedWorkspace {
        MomoCreatedWorkspace(
            workspaceId: WorkspaceID(uuidString: "00000000-0000-7000-8000-0000000007a1")!,
            slug: "momo-core-team",
            name: "Momo Core Team"
        )
    }

    @MainActor
    func model(client: any MomoWorkspaceCreateClient) -> MomoWorkspaceCreateModel {
        MomoWorkspaceCreateModel(context: context, client: client)
    }
}

actor MockWorkspaceCreateClient: MomoWorkspaceCreateClient {
    private let result: MomoCreatedWorkspace?
    private let error: Error?
    private let delayNanoseconds: UInt64
    private var calls: [MomoWorkspaceCreateRequest] = []

    init(
        result: MomoCreatedWorkspace? = nil,
        error: Error? = nil,
        delayNanoseconds: UInt64 = 0
    ) {
        self.result = result
        self.error = error
        self.delayNanoseconds = delayNanoseconds
    }

    func recordedCalls() -> [MomoWorkspaceCreateRequest] { calls }

    func create(
        context: MomoInviteAdminContext,
        request: MomoWorkspaceCreateRequest
    ) async throws -> MomoCreatedWorkspace {
        calls.append(request)
        if delayNanoseconds > 0 {
            try? await Task.sleep(nanoseconds: delayNanoseconds)
        }
        if let error { throw error }
        guard let result else { throw MomoWorkspaceCreateClientError.invalidResponse }
        return result
    }
}
