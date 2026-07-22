import Foundation
import MomoCore
import XCTest
@testable import MomoMac

@MainActor
final class MomoEventSubscriptionSettingsTests: XCTestCase {
    func testStatusProjectionCoversFourStatesAndReasons() {
        let fixture = EventSubscriptionFixture()
        XCTAssertEqual(fixture.subscription(enabled: true).status, .enabled)
        XCTAssertEqual(
            fixture.subscription(enabled: false, reason: .disabledByAdmin).status,
            .disabledByAdmin
        )
        XCTAssertEqual(
            fixture.subscription(enabled: false, reason: .serverFailureThreshold).status,
            .disabledAfterFailures
        )
        XCTAssertEqual(fixture.subscription(enabled: false).status, .unavailable)

        let copy = MomoEventSubscriptionCopy(language: .korean)
        XCTAssertEqual(copy.status(.enabled), "사용 중")
        XCTAssertEqual(copy.status(.disabledByAdmin), "관리자 중지")
        XCTAssertEqual(copy.status(.disabledAfterFailures), "자동 중지")
        XCTAssertEqual(copy.status(.unavailable), "상태 확인 필요")
    }

    func testCreateNormalizesInputSortsKindsAndKeepsSecretOutsideListProjection() async throws {
        let fixture = EventSubscriptionFixture()
        let recorder = SecretCopyRecorder()
        let client = MockEventSubscriptionClient(
            listed: [],
            created: fixture.secret
        )
        let model = fixture.model(client: client, recorder: recorder)

        let created = await model.create(
            url: "  https://hooks.example.com/momo  ",
            eventKinds: [.workStatusChanged, .mention]
        )

        XCTAssertTrue(created)
        XCTAssertEqual(model.subscriptions, [fixture.secret.eventSubscription])
        XCTAssertEqual(model.oneTimeSecret?.secret, "one-time-signing-secret")
        XCTAssertFalse(String(describing: model.subscriptions).contains("one-time-signing-secret"))

        model.copyOneTimeSecret()
        XCTAssertEqual(recorder.values, ["one-time-signing-secret"])
        XCTAssertTrue(model.copiedSecret)

        model.discardOneTimeSecret()
        XCTAssertNil(model.oneTimeSecret)
        XCTAssertFalse(model.copiedSecret)

        let calls = await client.recordedCalls()
        XCTAssertEqual(calls.createdURLs, ["https://hooks.example.com/momo"])
        XCTAssertEqual(calls.createdKinds, [[.mention, .workStatusChanged]])
    }

    func testCreateRejectsInvalidURLAndEmptyEventSelectionInline() async {
        let fixture = EventSubscriptionFixture()
        let client = MockEventSubscriptionClient(listed: [], created: fixture.secret)
        let model = fixture.model(client: client)

        let invalidURLCreated = await model.create(url: "file:///tmp/hook", eventKinds: [.mention])
        XCTAssertFalse(invalidURLCreated)
        XCTAssertEqual(model.mutationIssue, .init(mutation: .create, failure: .invalidURL))

        let emptyEventsCreated = await model.create(url: fixture.destination, eventKinds: [])
        XCTAssertFalse(emptyEventsCreated)
        XCTAssertEqual(model.mutationIssue, .init(mutation: .create, failure: .noEvents))
        let calls = await client.recordedCalls()
        XCTAssertTrue(calls.createdURLs.isEmpty)
    }

    func testEnableDisableAndDeleteUseServerProjection() async {
        let fixture = EventSubscriptionFixture()
        let disabled = fixture.subscription(enabled: false, reason: .disabledByAdmin)
        let enabled = fixture.subscription(enabled: true)
        let client = MockEventSubscriptionClient(
            listed: [disabled],
            created: fixture.secret,
            updated: enabled,
            deleted: enabled
        )
        let model = fixture.model(client: client)

        await model.load()
        let enabledResult = await model.setEnabled(disabled, enabled: true)
        XCTAssertTrue(enabledResult)
        XCTAssertEqual(model.subscriptions.first?.status, .enabled)
        let deletedResult = await model.delete(enabled)
        XCTAssertTrue(deletedResult)
        XCTAssertTrue(model.subscriptions.isEmpty)

        let calls = await client.recordedCalls()
        XCTAssertEqual(calls.enabledValues, [true])
        XCTAssertEqual(calls.deletedIDs, [fixture.subscriptionID])
    }

    func testContextRemovalDropsSubscriptionsAndOneTimeSecret() async {
        let fixture = EventSubscriptionFixture()
        let client = MockEventSubscriptionClient(listed: [], created: fixture.secret)
        let model = fixture.model(client: client)
        let created = await model.create(
            url: fixture.destination,
            eventKinds: [.mention, .workStatusChanged]
        )
        XCTAssertTrue(created)
        XCTAssertNotNil(model.oneTimeSecret)

        await model.updateContext(nil)

        XCTAssertEqual(model.loadState, .unavailable)
        XCTAssertTrue(model.subscriptions.isEmpty)
        XCTAssertNil(model.oneTimeSecret)
    }

    func testRESTClientMatchesOpenAPIPathsBodiesAndNoStoreBoundary() async throws {
        let fixture = EventSubscriptionFixture()
        EventSubscriptionURLProtocol.reset()
        defer { EventSubscriptionURLProtocol.reset() }
        EventSubscriptionURLProtocol.handler = { request in
            let path = try XCTUnwrap(request.url?.path)
            switch (request.httpMethod, path) {
            case ("GET", fixture.collectionPath):
                return .init(json: "{\"eventSubscriptions\":[\(fixture.subscriptionJSON(enabled: true))]}")
            case ("POST", fixture.collectionPath):
                let body = try XCTUnwrap(request.eventSubscriptionBody)
                let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
                XCTAssertEqual(object["url"] as? String, fixture.destination)
                XCTAssertEqual(object["eventKinds"] as? [String], ["mention", "work.status_changed"])
                XCTAssertEqual(object["enabled"] as? Bool, true)
                return .init(status: 201, json: fixture.secretJSON)
            case ("PUT", fixture.itemPath):
                let body = try XCTUnwrap(request.eventSubscriptionBody)
                let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
                XCTAssertEqual(object.keys.sorted(), ["enabled"])
                XCTAssertEqual(object["enabled"] as? Bool, false)
                return .init(json: "{\"eventSubscription\":\(fixture.subscriptionJSON(enabled: false, reason: "disabled_by_admin"))}")
            case ("DELETE", fixture.itemPath):
                return .init(json: "{\"eventSubscription\":\(fixture.subscriptionJSON(enabled: false, reason: "disabled_by_admin"))}")
            default:
                return .init(status: 404, json: "{}")
            }
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EventSubscriptionURLProtocol.self]
        let client = MomoEventSubscriptionRESTClient(session: URLSession(configuration: configuration))

        _ = try await client.list(context: fixture.context)
        let created = try await client.create(
            context: fixture.context,
            url: fixture.destination,
            eventKinds: [.mention, .workStatusChanged]
        )
        _ = try await client.setEnabled(
            context: fixture.context,
            subscription: fixture.subscriptionID,
            enabled: false
        )
        _ = try await client.delete(context: fixture.context, subscription: fixture.subscriptionID)

        XCTAssertEqual(created.secret, "one-time-signing-secret")
        let requests = EventSubscriptionURLProtocol.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["GET", "POST", "PUT", "DELETE"])
        XCTAssertTrue(requests.allSatisfy {
            $0.value(forHTTPHeaderField: "Authorization") == "Bearer admin-token"
                && $0.value(forHTTPHeaderField: "Cache-Control") == "no-store"
                && $0.value(forHTTPHeaderField: "Pragma") == "no-cache"
                && $0.cachePolicy == .reloadIgnoringLocalCacheData
        })
    }

    func testFailuresUseStableCopyWithoutServerDetail() {
        XCTAssertEqual(
            MomoEventSubscriptionFailure.classify(MomoEventSubscriptionClientError.http(403)),
            .forbidden
        )
        XCTAssertEqual(
            MomoEventSubscriptionFailure.classify(MomoEventSubscriptionClientError.offline),
            .offline
        )
        let copy = MomoEventSubscriptionCopy(language: .korean)
        XCTAssertEqual(
            copy.failureDescription(.forbidden),
            "발신 구독을 관리할 권한이 없습니다. 워크스페이스 관리자에게 문의하세요."
        )
    }
}

@MainActor
final class SecretCopyRecorder {
    private(set) var values: [String] = []
    func copy(_ value: String) { values.append(value) }
}

struct EventSubscriptionFixture: Sendable {
    let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
    let member = MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!
    let subscriptionID = UUID(uuidString: "00000000-0000-7000-8000-000000000601")!
    let destination = "https://hooks.example.com/momo"

    var context: MomoInviteAdminContext {
        .init(baseURL: URL(string: "https://momo.test")!, workspace: workspace, accessToken: "admin-token")
    }

    var collectionPath: String { "/v1/workspaces/\(workspace.description)/event-subscriptions" }
    var itemPath: String { "\(collectionPath)/\(subscriptionID.uuidString.lowercased())" }

    var secret: MomoEventSubscriptionSecret {
        .init(
            eventSubscription: subscription(enabled: true, kinds: [.mention, .workStatusChanged]),
            secret: "one-time-signing-secret",
            signatureVersion: "v1",
            algorithm: "HMAC-SHA256"
        )
    }

    func subscription(
        id: UUID? = nil,
        enabled: Bool,
        reason: MomoEventSubscriptionDisabledReason? = nil,
        kinds: [MomoEventSubscriptionKind] = [.mention]
    ) -> MomoEventSubscription {
        .init(
            id: id ?? subscriptionID,
            workspaceId: workspace,
            url: destination,
            eventKinds: kinds,
            enabled: enabled,
            deliveryFailureCount: reason == .serverFailureThreshold ? 5 : 0,
            disabledAtMs: enabled ? nil : 1_800_000_001_000,
            disabledReason: reason,
            createdBy: member,
            updatedBy: member,
            createdAtMs: 1_800_000_000_000,
            updatedAtMs: 1_800_000_001_000
        )
    }

    @MainActor
    func model(
        client: any MomoEventSubscriptionClient,
        recorder: SecretCopyRecorder = SecretCopyRecorder()
    ) -> MomoEventSubscriptionSettingsModel {
        .init(
            context: context,
            workspaceID: workspace,
            client: client,
            copySecret: recorder.copy
        )
    }

    func subscriptionJSON(enabled: Bool, reason: String? = nil) -> String {
        let disabled = enabled ? "" : ",\"disabledAtMs\":1800000001000"
        let reasonJSON = reason.map { ",\"disabledReason\":\"\($0)\"" } ?? ""
        return """
        {"id":"\(subscriptionID.uuidString.lowercased())","workspaceId":"\(workspace.description)","url":"\(destination)","eventKinds":["mention","work.status_changed"],"enabled":\(enabled),"deliveryFailureCount":0\(disabled)\(reasonJSON),"createdBy":"\(member.description)","updatedBy":"\(member.description)","createdAtMs":1800000000000,"updatedAtMs":1800000001000}
        """
    }

    var secretJSON: String {
        """
        {"eventSubscription":\(subscriptionJSON(enabled: true)),"secret":"one-time-signing-secret","signatureVersion":"v1","algorithm":"HMAC-SHA256"}
        """
    }
}

actor MockEventSubscriptionClient: MomoEventSubscriptionClient {
    struct Calls: Sendable {
        var createdURLs: [String] = []
        var createdKinds: [[MomoEventSubscriptionKind]] = []
        var enabledValues: [Bool] = []
        var deletedIDs: [UUID] = []
    }

    let listed: [MomoEventSubscription]
    let created: MomoEventSubscriptionSecret
    let updated: MomoEventSubscription?
    let deleted: MomoEventSubscription?
    private(set) var calls = Calls()

    init(
        listed: [MomoEventSubscription],
        created: MomoEventSubscriptionSecret,
        updated: MomoEventSubscription? = nil,
        deleted: MomoEventSubscription? = nil
    ) {
        self.listed = listed
        self.created = created
        self.updated = updated
        self.deleted = deleted
    }

    func list(context: MomoInviteAdminContext) async throws -> [MomoEventSubscription] { listed }

    func create(
        context: MomoInviteAdminContext,
        url: String,
        eventKinds: [MomoEventSubscriptionKind]
    ) async throws -> MomoEventSubscriptionSecret {
        calls.createdURLs.append(url)
        calls.createdKinds.append(eventKinds)
        return created
    }

    func setEnabled(
        context: MomoInviteAdminContext,
        subscription: UUID,
        enabled: Bool
    ) async throws -> MomoEventSubscription {
        calls.enabledValues.append(enabled)
        return updated ?? created.eventSubscription
    }

    func delete(
        context: MomoInviteAdminContext,
        subscription: UUID
    ) async throws -> MomoEventSubscription {
        calls.deletedIDs.append(subscription)
        return deleted ?? created.eventSubscription
    }

    func recordedCalls() -> Calls { calls }
}

private struct EventSubscriptionHTTPResponse: Sendable {
    let status: Int
    let json: String
    init(status: Int = 200, json: String) { self.status = status; self.json = json }
}

private final class EventSubscriptionURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> EventSubscriptionHTTPResponse
    nonisolated(unsafe) static var handler: Handler?
    nonisolated(unsafe) private(set) static var requests: [URLRequest] = []
    private static let lock = NSLock()

    static func reset() {
        lock.withLock { handler = nil; requests = [] }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let currentHandler = Self.lock.withLock { Self.requests.append(request); return Self.handler }
        guard let currentHandler else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        do {
            let result = try currentHandler(request)
            let response = HTTPURLResponse(
                url: request.url!, statusCode: result.status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json", "Cache-Control": "no-store"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(result.json.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private extension URLRequest {
    var eventSubscriptionBody: Data? {
        if let httpBody { return httpBody }
        guard let httpBodyStream else { return nil }
        httpBodyStream.open()
        defer { httpBodyStream.close() }
        var data = Data()
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 1_024)
        defer { buffer.deallocate() }
        while httpBodyStream.hasBytesAvailable {
            let count = httpBodyStream.read(buffer, maxLength: 1_024)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
