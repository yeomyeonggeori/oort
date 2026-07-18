import Foundation
import MomoCore
import XCTest
@testable import MomoMac

@MainActor
final class MomoWebhookSettingsTests: XCTestCase {
    func testListFiltersInstallationsToCurrentChannel() async {
        let fixture = WebhookFixture()
        let otherChannel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000299")!
        let client = MockWebhookClient(
            listed: [
                fixture.installation(channel: fixture.channel),
                fixture.installation(
                    id: UUID(uuidString: "00000000-0000-7000-8000-000000000499")!,
                    channel: otherChannel
                ),
            ],
            created: fixture.nativeCredential,
            rotated: fixture.rotatedCredential,
            revoked: fixture.revokedInstallation
        )
        let model = fixture.model(client: client)

        await model.load()

        XCTAssertEqual(model.loadState, .loaded)
        XCTAssertEqual(model.installations.count, 2)
        XCTAssertEqual(model.currentChannelInstallations.map(\.channelId), [fixture.channel])
    }

    func testCreateHoldsCredentialOnlyUntilOneTimeRevealIsDiscarded() async {
        let fixture = WebhookFixture()
        let client = fixture.client()
        let model = fixture.model(client: client)

        let created = await model.create(label: "  배포 알림  ", mode: .native)

        XCTAssertTrue(created)
        XCTAssertEqual(model.oneTimeCredential?.keyId, fixture.nativeCredential.keyId)
        XCTAssertEqual(model.oneTimeCredential?.secret, fixture.nativeCredential.secret)
        XCTAssertEqual(model.currentChannelInstallations.first?.id, fixture.installationID)
        let calls = await client.recordedCalls()
        XCTAssertEqual(calls.createLabels, ["배포 알림"])

        model.discardOneTimeCredential()

        XCTAssertNil(model.oneTimeCredential)
        XCTAssertNil(model.oneTimeReceiveURL)
        XCTAssertFalse(model.copyOneTimeReceiveURL())
        XCTAssertFalse(model.copyOneTimeSigningSecret())
    }

    func testCreateExposesProgressStateAndLocalizedAccessibleVerb() async {
        let fixture = WebhookFixture()
        let client = MockWebhookClient(
            listed: [],
            created: fixture.nativeCredential,
            createDelayNanoseconds: 100_000_000,
            rotated: fixture.rotatedCredential,
            revoked: fixture.revokedInstallation
        )
        let model = fixture.model(client: client)

        let task = Task { await model.create(label: "Deploy alerts", mode: .native) }
        await Task.yield()

        XCTAssertEqual(model.operation, .creating)
        XCTAssertEqual(MomoWebhookCopy(language: .korean).creatingWebhook, "웹훅 만드는 중")
        XCTAssertEqual(MomoWebhookCopy(language: .english).creatingWebhook, "Creating webhook")
        let created = await task.value
        XCTAssertTrue(created)
        XCTAssertEqual(model.operation, .idle)
    }

    func testRotateUsesExplicitOverlapAndRevokeUpdatesCurrentRow() async {
        let fixture = WebhookFixture()
        let client = fixture.client()
        let model = fixture.model(client: client)
        await model.load()
        let active = fixture.installation(channel: fixture.channel)

        let rotated = await model.rotate(active, overlapSeconds: 86_400)
        XCTAssertTrue(rotated)
        XCTAssertEqual(model.oneTimeCredential?.keyId, fixture.rotatedCredential.keyId)
        var calls = await client.recordedCalls()
        XCTAssertEqual(calls.rotationOverlaps, [86_400])

        let revoked = await model.revoke(active)
        XCTAssertTrue(revoked)
        XCTAssertEqual(model.currentChannelInstallations.first?.status, .revoked)
        XCTAssertNil(model.oneTimeCredential)
        XCTAssertEqual(model.notice, .revoked)
        calls = await client.recordedCalls()
        XCTAssertEqual(calls.revokedIDs, [fixture.installationID])
    }

    func testNativeURLRemainsCopyableWhileSlackURLExistsOnlyInReveal() async {
        let fixture = WebhookFixture()
        let recorder = WebhookCopyRecorder()
        let client = MockWebhookClient(
            listed: [
                fixture.installation(channel: fixture.channel),
                fixture.installation(
                    id: fixture.slackInstallationID,
                    channel: fixture.channel,
                    mode: .slackCompatible,
                    label: "Build alerts"
                ),
            ],
            created: fixture.slackCredential,
            rotated: fixture.rotatedCredential,
            revoked: fixture.revokedInstallation
        )
        let model = fixture.model(client: client, recorder: recorder)
        await model.load()

        XCTAssertTrue(model.copyReceiveURL(for: fixture.installation(channel: fixture.channel)))
        XCTAssertFalse(model.copyReceiveURL(for: model.currentChannelInstallations[1]))
        XCTAssertEqual(
            recorder.entries.first?.value,
            "https://momo.test/v1/webhooks/\(fixture.workspace.description)/\(fixture.installationID.uuidString.lowercased())"
        )
        XCTAssertEqual(recorder.entries.first?.sensitivity, .regular)

        let created = await model.create(label: "Build alerts", mode: .slackCompatible)
        XCTAssertTrue(created)
        XCTAssertTrue(model.copyOneTimeReceiveURL())
        XCTAssertEqual(recorder.entries.last?.value, "https://momo.test/hooks/one-time-value")
        XCTAssertEqual(recorder.entries.last?.sensitivity, .secret)

        model.discardOneTimeCredential()
        XCTAssertFalse(model.copyOneTimeReceiveURL())
        XCTAssertEqual(recorder.entries.count, 2)
    }

    func testOfflineListHasDistinctRecoveryState() async {
        let fixture = WebhookFixture()
        let client = MockWebhookClient(
            listed: [],
            listError: .offline,
            created: fixture.nativeCredential,
            rotated: fixture.rotatedCredential,
            revoked: fixture.revokedInstallation
        )
        let model = fixture.model(client: client)

        await model.load()

        XCTAssertEqual(model.loadState, .offline)
        XCTAssertTrue(model.currentChannelInstallations.isEmpty)
    }

    func testLoadClassifiesServerFailuresWithoutExposingProblemDetail() async {
        let fixture = WebhookFixture()
        let client = MockWebhookClient(
            listed: [],
            listError: .http(status: 401, message: "raw database and token detail"),
            created: fixture.nativeCredential,
            rotated: fixture.rotatedCredential,
            revoked: fixture.revokedInstallation
        )
        let model = fixture.model(client: client)

        await model.load()

        XCTAssertEqual(model.loadState, .failed(.unauthorized))
        let english = MomoWebhookCopy(language: .english).loadFailedDescription(.unauthorized)
        let korean = MomoWebhookCopy(language: .korean).loadFailedDescription(.unauthorized)
        XCTAssertEqual(english, "Your admin session has expired. Sign in again, then retry.")
        XCTAssertEqual(korean, "관리자 세션이 만료되었습니다. 다시 로그인한 뒤 시도하세요.")
        XCTAssertFalse(english.contains("database"))
        XCTAssertFalse(korean.contains("token"))
    }

    func testFailureClassifierCoversStableWebhookRecoveryCategories() {
        XCTAssertEqual(
            MomoWebhookUserFailure.classify(
                MomoWebhookClientError.http(status: 403, message: "raw forbidden detail")
            ),
            .forbidden
        )
        XCTAssertEqual(
            MomoWebhookUserFailure.classify(
                MomoWebhookClientError.http(status: 409, message: "raw conflict detail")
            ),
            .conflict
        )
        XCTAssertEqual(
            MomoWebhookUserFailure.classify(MomoWebhookClientError.invalidResponse),
            .invalidResponse
        )
        XCTAssertEqual(
            MomoWebhookUserFailure.classify(MomoWebhookClientError.offline),
            .offline
        )
        XCTAssertEqual(
            MomoWebhookUserFailure.classify(
                MomoWebhookClientError.http(status: 500, message: "raw internal detail")
            ),
            .other
        )

        let korean = MomoWebhookCopy(language: .korean)
        let english = MomoWebhookCopy(language: .english)
        for failure in [
            MomoWebhookUserFailure.forbidden,
            .conflict,
            .invalidResponse,
            .offline,
            .other,
        ] {
            XCTAssertFalse(korean.failureDescription(failure).contains("raw"))
            XCTAssertFalse(english.failureDescription(failure).contains("raw"))
        }
    }

    func testMutationClassifiesRawHTTPFailureBeforePresentingIt() async {
        let fixture = WebhookFixture()
        let client = MockWebhookClient(
            listed: [],
            created: fixture.nativeCredential,
            createError: .http(status: 403, message: "workspace secret policy detail"),
            rotated: fixture.rotatedCredential,
            revoked: fixture.revokedInstallation
        )
        let model = fixture.model(client: client)

        let created = await model.create(label: "Deploy alerts", mode: .native)

        XCTAssertFalse(created)
        XCTAssertEqual(model.mutationIssue?.failure, .forbidden)
        let message = MomoWebhookCopy(language: .english).mutationFailure(
            try! XCTUnwrap(model.mutationIssue)
        )
        XCTAssertFalse(message.contains("secret policy"))
        XCTAssertEqual(
            message,
            "The webhook was not created. You do not have permission to manage webhooks in this channel. Contact a workspace admin."
        )
    }

    func testSessionContextRemovalClearsCatalogAndOneTimeCredential() async {
        let fixture = WebhookFixture()
        let model = fixture.model(client: fixture.client())
        await model.load()
        let created = await model.create(label: "Deploy alerts", mode: .native)
        XCTAssertTrue(created)
        XCTAssertFalse(model.installations.isEmpty)
        XCTAssertNotNil(model.oneTimeCredential)

        await model.updateContext(nil)

        XCTAssertEqual(model.loadState, .unavailable)
        XCTAssertTrue(model.installations.isEmpty)
        XCTAssertNil(model.oneTimeCredential)
        XCTAssertEqual(model.operation, .idle)
    }

    func testCreateRejectsCredentialScopedToAnotherChannel() async {
        let fixture = WebhookFixture()
        let otherChannel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000299")!
        let mismatchedCredential = MomoWebhookOneTimeCredential(
            installation: fixture.installation(channel: otherChannel),
            keyId: fixture.nativeKeyID,
            secret: "must-not-be-revealed",
            url: "/v1/webhooks/\(fixture.workspace.description)/\(fixture.installationID.uuidString.lowercased())",
            signatureVersion: "v1",
            algorithm: "HMAC-SHA256",
            overlapSeconds: nil
        )
        let client = MockWebhookClient(
            listed: [],
            created: mismatchedCredential,
            rotated: fixture.rotatedCredential,
            revoked: fixture.revokedInstallation
        )
        let model = fixture.model(client: client)

        let created = await model.create(label: "Deploy alerts", mode: .native)

        XCTAssertFalse(created)
        XCTAssertNil(model.oneTimeCredential)
        XCTAssertTrue(model.installations.isEmpty)
        XCTAssertEqual(model.mutationIssue?.action, .create)
        XCTAssertEqual(model.mutationIssue?.failure, .invalidResponse)
    }

    func testRESTClientUsesCanonicalRoutesAndNoStoreRequests() async throws {
        let fixture = WebhookFixture()
        WebhookURLProtocol.reset()
        defer { WebhookURLProtocol.reset() }
        WebhookURLProtocol.setHandler { request in
            let path = try XCTUnwrap(request.url?.path)
            switch (request.httpMethod, path) {
            case ("GET", "/v1/workspaces/\(fixture.workspace.description)/webhooks"):
                return WebhookHTTPResponse(json: """
                {"installations":[\(fixture.installationJSON(status: "active"))]}
                """)

            case ("POST", "/v1/workspaces/\(fixture.workspace.description)/webhooks"):
                let body = try XCTUnwrap(request.webhookBodyData)
                let object = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                XCTAssertEqual(object["channelId"] as? String, fixture.channel.description)
                XCTAssertEqual(object["mode"] as? String, "native")
                XCTAssertEqual(object["label"] as? String, "Deploy alerts")
                return WebhookHTTPResponse(statusCode: 201, json: fixture.credentialJSON(
                    keyID: fixture.nativeCredential.keyId,
                    secret: "ephemeral-test-value",
                    url: "/v1/webhooks/\(fixture.workspace.description)/\(fixture.installationID.uuidString.lowercased())"
                ))

            case ("POST", "/v1/workspaces/\(fixture.workspace.description)/webhooks/\(fixture.installationID.uuidString.lowercased())/rotate"):
                let body = try XCTUnwrap(request.webhookBodyData)
                let object = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                XCTAssertEqual((object["overlapSeconds"] as? NSNumber)?.intValue, 86_400)
                return WebhookHTTPResponse(json: fixture.credentialJSON(
                    keyID: fixture.rotatedCredential.keyId,
                    secret: "replacement-test-value",
                    url: "/v1/webhooks/\(fixture.workspace.description)/\(fixture.installationID.uuidString.lowercased())",
                    overlapSeconds: 86_400
                ))

            case ("DELETE", "/v1/workspaces/\(fixture.workspace.description)/webhooks/\(fixture.installationID.uuidString.lowercased())"):
                return WebhookHTTPResponse(json: """
                {"installation":\(fixture.installationJSON(status: "revoked")),"revoked":true}
                """)

            default:
                return WebhookHTTPResponse(
                    statusCode: 404,
                    json: #"{"title":"unexpected webhook request"}"#
                )
            }
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WebhookURLProtocol.self]
        let client = MomoWebhookRESTClient(session: URLSession(configuration: configuration))

        let listed = try await client.list(context: fixture.context)
        let created = try await client.create(
            context: fixture.context,
            channel: fixture.channel,
            mode: .native,
            label: "Deploy alerts"
        )
        let rotated = try await client.rotate(
            context: fixture.context,
            installation: fixture.installationID,
            overlapSeconds: 86_400
        )
        let revoked = try await client.revoke(
            context: fixture.context,
            installation: fixture.installationID
        )

        XCTAssertEqual(listed.map(\.id), [fixture.installationID])
        XCTAssertEqual(created.secret, "ephemeral-test-value")
        XCTAssertEqual(rotated.overlapSeconds, 86_400)
        XCTAssertEqual(revoked.status, .revoked)

        let requests = WebhookURLProtocol.requests()
        XCTAssertEqual(requests.map { $0.httpMethod ?? "" }, ["GET", "POST", "POST", "DELETE"])
        XCTAssertTrue(requests.allSatisfy {
            $0.value(forHTTPHeaderField: "Authorization") == "Bearer admin-token"
        })
        XCTAssertTrue(requests.allSatisfy {
            $0.value(forHTTPHeaderField: "Cache-Control") == "no-store"
                && $0.value(forHTTPHeaderField: "Pragma") == "no-cache"
                && $0.cachePolicy == .reloadIgnoringLocalCacheData
        })
    }
}

@MainActor
private final class WebhookCopyRecorder {
    struct Entry {
        let value: String
        let sensitivity: MomoWebhookClipboardSensitivity
    }

    private(set) var entries: [Entry] = []

    func record(_ value: String, sensitivity: MomoWebhookClipboardSensitivity) {
        entries.append(Entry(value: value, sensitivity: sensitivity))
    }
}

private struct WebhookFixture: Sendable {
    let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
    let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000201")!
    let member = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
    let installationID = UUID(uuidString: "00000000-0000-7000-8000-000000000401")!
    let slackInstallationID = UUID(uuidString: "00000000-0000-7000-8000-000000000402")!
    let nativeKeyID = UUID(uuidString: "00000000-0000-7000-8000-000000000501")!
    let rotatedKeyID = UUID(uuidString: "00000000-0000-7000-8000-000000000502")!
    let slackKeyID = UUID(uuidString: "00000000-0000-7000-8000-000000000503")!

    var context: MomoInviteAdminContext {
        MomoInviteAdminContext(
            baseURL: URL(string: "https://momo.test")!,
            workspace: workspace,
            accessToken: "admin-token"
        )
    }

    var nativeCredential: MomoWebhookOneTimeCredential {
        MomoWebhookOneTimeCredential(
            installation: installation(channel: channel),
            keyId: nativeKeyID,
            secret: "native-test-value",
            url: "/v1/webhooks/\(workspace.description)/\(installationID.uuidString.lowercased())",
            signatureVersion: "v1",
            algorithm: "HMAC-SHA256",
            overlapSeconds: nil
        )
    }

    var rotatedCredential: MomoWebhookOneTimeCredential {
        MomoWebhookOneTimeCredential(
            installation: installation(channel: channel),
            keyId: rotatedKeyID,
            secret: "rotated-test-value",
            url: "/v1/webhooks/\(workspace.description)/\(installationID.uuidString.lowercased())",
            signatureVersion: "v1",
            algorithm: "HMAC-SHA256",
            overlapSeconds: 86_400
        )
    }

    var slackCredential: MomoWebhookOneTimeCredential {
        MomoWebhookOneTimeCredential(
            installation: installation(
                id: slackInstallationID,
                channel: channel,
                mode: .slackCompatible,
                label: "Build alerts"
            ),
            keyId: slackKeyID,
            secret: nil,
            url: "/hooks/one-time-value",
            signatureVersion: nil,
            algorithm: nil,
            overlapSeconds: nil
        )
    }

    var revokedInstallation: MomoWebhookInstallation {
        installation(channel: channel, status: .revoked)
    }

    func installation(
        id: UUID? = nil,
        channel: ChannelID,
        mode: MomoWebhookMode = .native,
        label: String = "Deploy alerts",
        status: MomoWebhookStatus = .active
    ) -> MomoWebhookInstallation {
        MomoWebhookInstallation(
            id: id ?? installationID,
            channelId: channel,
            authorMemberId: member,
            mode: mode,
            label: label,
            status: status,
            createdAtMs: 1_800_000_000_000,
            updatedAtMs: 1_800_000_000_000
        )
    }

    @MainActor
    func model(
        client: any MomoWebhookClient,
        recorder: WebhookCopyRecorder = WebhookCopyRecorder()
    ) -> MomoWebhookSettingsModel {
        MomoWebhookSettingsModel(
            context: context,
            channelID: channel,
            workspaceID: workspace,
            client: client,
            copyValue: recorder.record
        )
    }

    func client() -> MockWebhookClient {
        MockWebhookClient(
            listed: [installation(channel: channel)],
            created: nativeCredential,
            rotated: rotatedCredential,
            revoked: revokedInstallation
        )
    }

    func installationJSON(status: String) -> String {
        """
        {"id":"\(installationID.uuidString.lowercased())","channelId":"\(channel.description)","authorMemberId":"\(member.description)","mode":"native","label":"Deploy alerts","status":"\(status)","createdAtMs":1800000000000,"updatedAtMs":1800000000000}
        """
    }

    func credentialJSON(
        keyID: UUID,
        secret: String,
        url: String,
        overlapSeconds: Int? = nil
    ) -> String {
        let overlap = overlapSeconds.map { ",\"overlapSeconds\":\($0)" } ?? ""
        return """
        {"installation":\(installationJSON(status: "active")),"keyId":"\(keyID.uuidString.lowercased())","secret":"\(secret)","url":"\(url)","signatureVersion":"v1","algorithm":"HMAC-SHA256"\(overlap)}
        """
    }
}

private actor MockWebhookClient: MomoWebhookClient {
    struct Calls: Sendable {
        var createLabels: [String] = []
        var rotationOverlaps: [Int] = []
        var revokedIDs: [UUID] = []
    }

    private let listed: [MomoWebhookInstallation]
    private let listError: MomoWebhookClientError?
    private let created: MomoWebhookOneTimeCredential
    private let createError: MomoWebhookClientError?
    private let createDelayNanoseconds: UInt64
    private let rotated: MomoWebhookOneTimeCredential
    private let revoked: MomoWebhookInstallation
    private var calls = Calls()

    init(
        listed: [MomoWebhookInstallation],
        listError: MomoWebhookClientError? = nil,
        created: MomoWebhookOneTimeCredential,
        createError: MomoWebhookClientError? = nil,
        createDelayNanoseconds: UInt64 = 0,
        rotated: MomoWebhookOneTimeCredential,
        revoked: MomoWebhookInstallation
    ) {
        self.listed = listed
        self.listError = listError
        self.created = created
        self.createError = createError
        self.createDelayNanoseconds = createDelayNanoseconds
        self.rotated = rotated
        self.revoked = revoked
    }

    func list(context: MomoInviteAdminContext) async throws -> [MomoWebhookInstallation] {
        if let listError { throw listError }
        return listed
    }

    func create(
        context: MomoInviteAdminContext,
        channel: ChannelID,
        mode: MomoWebhookMode,
        label: String
    ) async throws -> MomoWebhookOneTimeCredential {
        calls.createLabels.append(label)
        if let createError { throw createError }
        if createDelayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: createDelayNanoseconds)
        }
        return created
    }

    func rotate(
        context: MomoInviteAdminContext,
        installation: UUID,
        overlapSeconds: Int
    ) async throws -> MomoWebhookOneTimeCredential {
        calls.rotationOverlaps.append(overlapSeconds)
        return rotated
    }

    func revoke(
        context: MomoInviteAdminContext,
        installation: UUID
    ) async throws -> MomoWebhookInstallation {
        calls.revokedIDs.append(installation)
        return revoked
    }

    func recordedCalls() -> Calls { calls }
}

private struct WebhookHTTPResponse: Sendable {
    let statusCode: Int
    let json: String

    init(statusCode: Int = 200, json: String) {
        self.statusCode = statusCode
        self.json = json
    }
}

private final class WebhookURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> WebhookHTTPResponse

    nonisolated(unsafe) private static var handler: Handler?
    nonisolated(unsafe) private static var seenRequests: [URLRequest] = []
    private static let lock = NSLock()

    static func reset() {
        lock.withLock {
            handler = nil
            seenRequests = []
        }
    }

    static func setHandler(_ newHandler: @escaping Handler) {
        lock.withLock {
            handler = newHandler
        }
    }

    static func requests() -> [URLRequest] {
        lock.withLock { seenRequests }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let currentHandler: Handler? = Self.lock.withLock {
            Self.seenRequests.append(request)
            return Self.handler
        }
        guard let currentHandler else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }

        do {
            let mocked = try currentHandler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: mocked.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store",
                ]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(mocked.json.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private extension URLRequest {
    var webhookBodyData: Data? {
        if let httpBody { return httpBody }
        guard let httpBodyStream else { return nil }
        httpBodyStream.open()
        defer { httpBodyStream.close() }

        var data = Data()
        let capacity = 1_024
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
        defer { buffer.deallocate() }
        while httpBodyStream.hasBytesAvailable {
            let count = httpBodyStream.read(buffer, maxLength: capacity)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
