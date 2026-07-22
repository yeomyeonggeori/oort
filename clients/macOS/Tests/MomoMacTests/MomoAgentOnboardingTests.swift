import AppKit
import MomoCore
import SnapshotTesting
import SwiftUI
import XCTest
@testable import MomoMac

@MainActor
final class MomoAgentOnboardingTests: XCTestCase {
    override func setUp() {
        super.setUp()
        AgentOnboardingURLProtocol.reset()
    }

    override func tearDown() {
        AgentOnboardingURLProtocol.reset()
        super.tearDown()
    }

    func testRESTInspectConfirmAndRosterOriginProjection() async throws {
        let workspace = WorkspaceID(UUID(uuidString: "10000000-0000-0000-0000-000000000001")!)
        let registrationID = UUID(uuidString: "20000000-0000-0000-0000-000000000001")!
        let agentID = MemberID(UUID(uuidString: "30000000-0000-0000-0000-000000000001")!)
        AgentOnboardingURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v1/workspaces/\(workspace.description)/agents/from-card"):
                return .init(status: 201, json: """
                {"registration":{"id":"\(registrationID.uuidString.lowercased())","status":"pending_consent","name":"리서치 도우미","description":"공개 자료를 조사하고 긴 한국어와 English 요약을 함께 작성합니다.","url":"https://agents.example/research","capabilities":{"streaming":true,"pushNotifications":false},"securitySchemes":{"schemes":{"bearer":{"type":"http","scheme":"bearer"}},"requirements":[{"bearer":[]}]},"createdAtMs":1784707200000}}
                """)
            case ("POST", "/v1/workspaces/\(workspace.description)/agents/from-card/\(registrationID.uuidString.lowercased())/confirm"):
                return .init(status: 201, json: """
                {"registrationId":"\(registrationID.uuidString.lowercased())","status":"confirmed","agent":{"id":"\(agentID.description.lowercased())","handle":"research-helper","displayName":"리서치 도우미"},"credential":{"id":"40000000-0000-0000-0000-000000000001","agentMemberId":"\(agentID.description.lowercased())","status":"active","scopes":["gateway:events"],"createdAtMs":1784707200000},"token":"must-not-enter-client-state","tokenType":"Bearer","confirmedAtMs":1784707200000}
                """)
            case ("GET", "/v1/workspaces/\(workspace.description)/roster"):
                return .init(status: 200, json: """
                {"members":[{"id":"\(agentID.description.lowercased())","workspaceId":"\(workspace.description.lowercased())","kind":"agent","status":"active","displayName":"리서치 도우미","handle":"research-helper","role":"member","channelIds":[],"capabilities":["streaming"],"origin":"card"}]}
                """)
            default:
                return .init(status: 404, json: "{\"detail\":\"unexpected route\"}")
            }
        }

        let backend = makeBackend(workspace: workspace)
        try await backend.connect(workspace: workspace, accessToken: "access-token")
        let registration = try await backend.inspectAgentAddress("https://agents.example")
        XCTAssertEqual(registration.name, "리서치 도우미")
        XCTAssertEqual(registration.capabilitySummaries, ["streaming"])
        XCTAssertEqual(registration.securitySummaries, ["bearer"])

        let confirmedID = try await backend.confirmAgentRegistration(registrationID)
        XCTAssertEqual(confirmedID, agentID)
        let members = try await backend.members(workspace: workspace)
        XCTAssertEqual(members.map(\.id), [agentID])
        let origins = await backend.agentOrigins()
        XCTAssertEqual(origins, [agentID: .card])

        let requests = AgentOnboardingURLProtocol.requests()
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "POST", "GET"])
        XCTAssertTrue(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer access-token" })
        let body = try XCTUnwrap(requests.first?.onboardingBodyData)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String], ["url": "https://agents.example"])
    }

    func testServerFourHundredReasonRemainsAvailableForInlineFailure() async throws {
        let workspace = WorkspaceID.demo
        AgentOnboardingURLProtocol.setHandler { _ in
            .init(
                status: 400,
                json: "{\"title\":\"Unsafe URL\",\"detail\":\"Private and link-local addresses are not allowed. Use a public HTTPS address.\"}"
            )
        }
        let backend = makeBackend(workspace: workspace)
        try await backend.connect(workspace: workspace, accessToken: "access-token")
        do {
            _ = try await backend.inspectAgentAddress("http://127.0.0.1")
            XCTFail("unsafe address must fail")
        } catch {
            let failure = ChatViewModel.agentOnboardingFailure(error)
            XCTAssertEqual(
                MomoWorkspaceCopy(language: .korean).agentOnboardingFailure(failure),
                "Private and link-local addresses are not allowed. Use a public HTTPS address."
            )
        }
    }

    func testCopyUsesProductVocabularyAndNeverRequestsSecrets() {
        for language in [MomoUILanguage.korean, .english] {
            let copy = MomoWorkspaceCopy(language: language)
            let visible = [
                copy.addAgent,
                copy.agentAddress,
                copy.addAgentFromAddressDetail,
                copy.agentAuthenticationNotice,
                copy.agentOrigin(.card),
                copy.agentOrigin(.local),
            ].joined(separator: " ")
            XCTAssertFalse(visible.localizedCaseInsensitiveContains("A2A"))
            XCTAssertFalse(visible.localizedCaseInsensitiveContains("agent card"))
            XCTAssertFalse(visible.localizedCaseInsensitiveContains("secret input"))
        }
        XCTAssertEqual(MomoWorkspaceCopy(language: .korean).agentAddress, "에이전트 주소")
    }

    func testConsentSummaryKoreanLightSnapshot() throws {
        try assertConsentSnapshot(.light, named: "korean-light", testName: #function)
    }

    func testConsentSummaryKoreanDarkSnapshot() throws {
        try assertConsentSnapshot(.dark, named: "korean-dark", testName: #function)
    }

    private func makeBackend(workspace: WorkspaceID) -> MomoServerRESTChatBackend {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AgentOnboardingURLProtocol.self]
        return MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.example")!,
                workspace: workspace
            ),
            session: URLSession(configuration: configuration)
        )
    }

    private func assertConsentSnapshot(
        _ scheme: ColorScheme,
        named: String,
        testName: String
    ) throws {
        let size = CGSize(width: 520, height: 520)
        let content = VStack(alignment: .leading, spacing: 16) {
            Text(MomoWorkspaceCopy(language: .korean).addAgent)
                .font(.title3.weight(.semibold))
            MomoAgentConsentSummaryView(
                registration: consentFixture,
                copy: MomoWorkspaceCopy(language: .korean),
                isConfirming: false,
                confirm: {},
                back: {}
            )
        }
        .padding(24)
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .background(Color(nsColor: .windowBackgroundColor))
        let image = try render(content, size: size, scheme: scheme)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: named,
            record: ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" ? .all : nil,
            testName: testName.replacingOccurrences(of: "()", with: "")
        )
        try writeDesignReviewArtifact(image, named: "momo-550-agent-consent-\(named).png")
    }

    private var consentFixture: MomoAgentRegistration {
        MomoAgentRegistration(
            id: UUID(uuidString: "20000000-0000-0000-0000-000000000001")!,
            name: "리서치 도우미",
            description: "공개 자료를 조사하고 출처를 정리하며 긴 한국어와 English 요약을 함께 작성합니다.",
            url: URL(string: "https://agents.example/research")!,
            capabilities: ["streaming": true, "pushNotifications": false, "documents": "read"],
            securitySchemes: [
                "schemes": ["bearer": ["type": "http", "scheme": "bearer"]],
                "requirements": [["bearer": []]],
            ]
        )
    }

    private func render<Content: View>(
        _ content: Content,
        size: CGSize,
        scheme: ColorScheme
    ) throws -> NSImage {
        let hostingView = NSHostingView(rootView: content.environment(\.colorScheme, scheme))
        hostingView.frame = CGRect(origin: .zero, size: size)
        hostingView.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()
        guard let representation = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(size.width * 2),
            pixelsHigh: Int(size.height * 2),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { throw XCTSkip("NSHostingView produced no onboarding bitmap") }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }

    private func writeDesignReviewArtifact(_ image: NSImage, named name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["MOMO_DESIGN_REVIEW_ARTIFACT_DIR"] else { return }
        let output = URL(fileURLWithPath: directory, isDirectory: true).appendingPathComponent(name)
        try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:])
        else { throw XCTSkip("Onboarding raster could not be encoded") }
        try png.write(to: output, options: .atomic)
    }
}

private struct AgentOnboardingMockResponse {
    let status: Int
    let json: String
}

private final class AgentOnboardingURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> AgentOnboardingMockResponse
    nonisolated(unsafe) private static var handler: Handler?
    nonisolated(unsafe) private static var seenRequests: [URLRequest] = []
    private static let lock = NSLock()

    static func reset() {
        lock.withLock { handler = nil; seenRequests = [] }
    }

    static func setHandler(_ newHandler: @escaping Handler) {
        lock.withLock { handler = newHandler }
    }

    static func requests() -> [URLRequest] {
        lock.withLock { seenRequests }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let currentHandler = Self.lock.withLock { () -> Handler? in
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
                statusCode: mocked.status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
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
    var onboardingBodyData: Data? {
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
