import AppKit
import MomoCore
import SnapshotTesting
import SwiftUI
import XCTest
@testable import MomoMac

@MainActor
final class MomoMemoryBrowserTests: XCTestCase {
    override func tearDown() async throws {
        await MemoryPlaneURLProtocol.reset()
        try await super.tearDown()
    }

    func testContextPacketResolverUsesOnlyMatchingRunMessages() {
        let runID = RunID(uuidString: "10000000-0000-7000-8000-000000000001")!
        let otherRunID = RunID(uuidString: "10000000-0000-7000-8000-000000000002")!
        let packetID = UUID(uuidString: "20000000-0000-7000-8000-000000000001")!
        let run = AgentWorkRun(
            id: runID,
            workspaceId: .demo,
            agentMemberId: .demoAgent,
            channelId: .demoGeneral,
            input: AgentWorkInput(title: "Review", brief: "Review"),
            createdAtMs: 1,
            updatedAtMs: 1
        )
        let other = Message(
            id: MessageID(), channelId: .demoGeneral, hlcTs: 1,
            authorMemberId: .demoAgent,
            props: .object(["context_packet_id": .string(packetID.uuidString)]),
            runId: otherRunID
        )
        let matching = Message(
            id: MessageID(), channelId: .demoGeneral, hlcTs: 2,
            authorMemberId: .demoAgent,
            props: .object([
                "context_packet": .object(["packet_id": .string(packetID.uuidString.lowercased())]),
            ]),
            runId: runID
        )

        XCTAssertEqual(MomoContextPacketIDResolver.resolve(run: run, messages: [other, matching]), packetID)
        XCTAssertNil(MomoContextPacketIDResolver.resolve(run: run, messages: [other]))
    }

    func testModelUsesRESTAuthorityForEditInvalidateAndPolicy() async throws {
        let backend = MemoryTestBackend()
        let model = MomoMemoryBrowserModel(
            backend: backend,
            workspace: .demo,
            initialAgentID: .demoAgent
        )

        await model.load()
        let first = try XCTUnwrap(model.selectedEntry)
        XCTAssertEqual(model.scope, .agent)
        XCTAssertEqual(model.policy?.enabled, true)

        let didSave = await model.save(entry: first, body: "Updated fact", confidence: 0.72)
        XCTAssertTrue(didSave)
        XCTAssertEqual(model.selectedEntry?.body, "Updated fact")
        let updateMutation = await backend.lastMutation()
        XCTAssertEqual(updateMutation, "update")

        let didInvalidate = await model.invalidate(try XCTUnwrap(model.selectedEntry))
        XCTAssertTrue(didInvalidate)
        XCTAssertTrue(model.entries.isEmpty)
        let invalidateMutation = await backend.lastMutation()
        XCTAssertEqual(invalidateMutation, "invalidate")

        let didSetPolicy = await model.setPolicy(enabled: false)
        XCTAssertTrue(didSetPolicy)
        XCTAssertEqual(model.policy?.enabled, false)
        let policyMutation = await backend.lastMutation()
        XCTAssertEqual(policyMutation, "policy:false")
    }

    func testKoreanCopyKeepsMemoryAndPacketLanguageCentralized() {
        let copy = MomoWorkspaceCopy(language: .korean)
        XCTAssertEqual(copy.memoryBrowserTitle, "에이전트가 아는 것")
        XCTAssertEqual(copy.servedContextTitle, "서빙 내역")
        XCTAssertEqual(copy.servedContextAction, "서빙 내역 보기")
        XCTAssertEqual(copy.servedContextBudgetLabel("reserved_micro_usd"), "예약 금액")
        XCTAssertEqual(copy.memorySourceLabel(channelName: "general", date: "2026. 7. 22."), "#general · 2026. 7. 22.")
        XCTAssertEqual(copy.memorySourceLabel(channelName: nil, date: "2026. 7. 22."), "2026. 7. 22.")
        XCTAssertEqual(copy.memoryScopeTitle(.conversation), "대화")
        XCTAssertFalse(copy.memoryGrantUnavailable.contains("grant"))
        XCTAssertFalse(copy.servedContextSubtitle.contains("Packet"))
        XCTAssertFalse(copy.servedContextUnavailable.contains("packet"))
    }

    func testRESTBackendUsesAuthoritativeMemoryAndPacketContracts() async throws {
        let workspace = WorkspaceID.demo
        let agent = MemberID.demoAgent
        let memoryID = UUID(uuidString: "20000000-0000-7000-8000-000000000529")!
        let packetID = UUID(uuidString: "30000000-0000-7000-8000-000000000529")!
        let session = URLSession(configuration: .memoryPlaneMocked)

        await MemoryPlaneURLProtocol.setHandler { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer memory-token")
            XCTAssertFalse(request.url?.absoluteString.contains("memory-token") ?? true)
            let method = request.httpMethod ?? "GET"
            let path = request.url?.path ?? ""
            switch (method, path) {
            case ("GET", "/v1/workspaces/\(workspace.description)/memories"):
                let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
                XCTAssertEqual(items.first { $0.name == "scope" }?.value, "agent")
                XCTAssertEqual(items.first { $0.name == "agent" }?.value, agent.description.lowercased())
                XCTAssertEqual(items.first { $0.name == "includeInvalid" }?.value, "true")
                return MemoryPlaneHTTPResponse(json: Self.memoryPageJSON(workspace: workspace, memoryID: memoryID, agent: agent))
            case ("GET", "/v1/workspaces/\(workspace.description)/memories/search"):
                let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
                XCTAssertEqual(items.first { $0.name == "q" }?.value, "runtime gate")
                return MemoryPlaneHTTPResponse(json: Self.memorySearchJSON(workspace: workspace, memoryID: memoryID, agent: agent))
            case ("PATCH", "/v1/workspaces/\(workspace.description)/memories/\(memoryID.uuidString.lowercased())"):
                let body = try Self.bodyObject(request)
                XCTAssertEqual(body["body"] as? String, "Updated fact")
                XCTAssertEqual(body["confidence"] as? Double, 0.72)
                return MemoryPlaneHTTPResponse(json: Self.memoryItemJSON(workspace: workspace, memoryID: memoryID, agent: agent, body: "Updated fact", confidence: 0.72))
            case ("POST", "/v1/workspaces/\(workspace.description)/memories/\(memoryID.uuidString.lowercased())/invalidate"):
                let body = try Self.bodyObject(request)
                XCTAssertTrue(body.isEmpty, "invalidation must not invent a replacement memory id")
                return MemoryPlaneHTTPResponse(json: Self.memoryItemJSON(workspace: workspace, memoryID: memoryID, agent: agent, invalidAtMs: 2))
            case ("GET", "/v1/workspaces/\(workspace.description)/memory-policy"):
                return MemoryPlaneHTTPResponse(json: #"{"memoryPolicy":{"workspaceId":"\#(workspace.description)","enabled":true,"updatedBy":null,"updatedAtMs":1}}"#)
            case ("PUT", "/v1/workspaces/\(workspace.description)/memory-policy"):
                let body = try Self.bodyObject(request)
                XCTAssertEqual(body["enabled"] as? Bool, false)
                return MemoryPlaneHTTPResponse(json: #"{"memoryPolicy":{"workspaceId":"\#(workspace.description)","enabled":false,"updatedBy":null,"updatedAtMs":2},"deletedCount":1}"#)
            case ("GET", "/v1/workspaces/\(workspace.description)/context-packets/\(packetID.uuidString.lowercased())"):
                return MemoryPlaneHTTPResponse(json: #"{"packetId":"\#(packetID.uuidString)","runId":"10000000-0000-7000-8000-000000000529","workspaceId":"\#(workspace.description)","createdAtMs":1,"expiresAtMs":2,"expired":false,"content":{"schema":"momo.context_packet.v0","memory_refs":[],"tool_grants":[]}}"#)
            default:
                return MemoryPlaneHTTPResponse(statusCode: 404, json: #"{"title":"unexpected memory request"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "memory-token"
            ),
            session: session
        )
        try await backend.connect(workspace: workspace, accessToken: "memory-token")

        let memories = try await backend.memories(
            workspace: workspace, scope: .agent, agent: agent,
            includeInvalid: true, limit: 300
        )
        XCTAssertEqual(memories.count, 1)
        let hits = try await backend.searchMemories(
            workspace: workspace, query: "runtime gate", scope: .agent,
            agent: agent, limit: 100
        )
        XCTAssertEqual(hits.first?.score, 0.91)
        let updated = try await backend.updateMemory(
            workspace: workspace, memory: memoryID,
            body: "Updated fact", confidence: 0.72
        )
        XCTAssertEqual(updated.body, "Updated fact")
        let invalidated = try await backend.invalidateMemory(workspace: workspace, memory: memoryID)
        XCTAssertFalse(invalidated.isActive)
        let policy = try await backend.memoryPolicy(workspace: workspace)
        XCTAssertTrue(policy.enabled)
        let disabledPolicy = try await backend.setMemoryPolicy(workspace: workspace, enabled: false)
        XCTAssertFalse(disabledPolicy.enabled)
        let packet = try await backend.contextPacket(workspace: workspace, packet: packetID)
        XCTAssertEqual(packet.packetId, packetID)
    }

    nonisolated private static func bodyObject(_ request: URLRequest) throws -> [String: Any] {
        let data = try XCTUnwrap(request.memoryBodyData)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    nonisolated private static func memoryPageJSON(workspace: WorkspaceID, memoryID: UUID, agent: MemberID) -> String {
        #"{"memories":[\#(memoryJSON(workspace: workspace, memoryID: memoryID, agent: agent))]}"#
    }

    nonisolated private static func memorySearchJSON(workspace: WorkspaceID, memoryID: UUID, agent: MemberID) -> String {
        #"{"hits":[{"memory":\#(memoryJSON(workspace: workspace, memoryID: memoryID, agent: agent)),"score":0.91,"ftsRank":1,"vectorRank":2,"vectorDistance":0.1}]}"#
    }

    nonisolated private static func memoryItemJSON(
        workspace: WorkspaceID,
        memoryID: UUID,
        agent: MemberID,
        body: String = "Runtime gate before deploy",
        confidence: Double = 0.91,
        invalidAtMs: Int64? = nil
    ) -> String {
        #"{"memory":\#(memoryJSON(workspace: workspace, memoryID: memoryID, agent: agent, body: body, confidence: confidence, invalidAtMs: invalidAtMs))}"#
    }

    nonisolated private static func memoryJSON(
        workspace: WorkspaceID,
        memoryID: UUID,
        agent: MemberID,
        body: String = "Runtime gate before deploy",
        confidence: Double = 0.91,
        invalidAtMs: Int64? = nil
    ) -> String {
        let escapedBody = body.replacingOccurrences(of: "\"", with: "\\\"")
        let invalid = invalidAtMs.map(String.init) ?? "null"
        return #"{"id":"\#(memoryID.uuidString)","workspaceId":"\#(workspace.description)","scope":"agent","subjectMemberId":null,"agentMemberId":"\#(agent.description)","channelId":"\#(ChannelID.demoGeneral.description)","kind":"fact","body":"\#(escapedBody)","confidence":\#(confidence),"validAtMs":1,"invalidAtMs":\#(invalid),"invalidatedByMemoryId":null,"createdByKind":"worker","createdByMemberId":null,"createdAtMs":1,"updatedAtMs":2,"sourceRefs":[{"messageId":"30000000-0000-7000-8000-000000000001","channelId":"\#(ChannelID.demoGeneral.description)"}]}"#
    }
}

@MainActor
final class MomoMemoryBrowserSnapshotTests: XCTestCase {
    private var recordMode: SnapshotTestingConfiguration.Record? {
        ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" ? .all : nil
    }

    func testKoreanMemoryBrowserLightSnapshot() async throws {
        try await assertBrowserSnapshot(scheme: .light, named: "korean-light", testName: #function)
    }

    func testKoreanMemoryBrowserDarkSnapshot() async throws {
        try await assertBrowserSnapshot(scheme: .dark, named: "korean-dark", testName: #function)
    }

    func testKoreanContextInspectorCurrentLightSnapshot() async throws {
        try await assertInspectorSnapshot(
            scheme: .light,
            expired: false,
            named: "current-light",
            testName: #function
        )
    }

    func testKoreanContextInspectorExpiredDarkSnapshot() async throws {
        try await assertInspectorSnapshot(
            scheme: .dark,
            expired: true,
            named: "expired-dark",
            testName: #function
        )
    }

    private func assertBrowserSnapshot(
        scheme: ColorScheme,
        named: String,
        testName: String
    ) async throws {
        let canonicalName = testName.replacingOccurrences(of: "()", with: "")
        let reference = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("__Snapshots__/MomoMemoryBrowserTests")
            .appendingPathComponent("\(canonicalName).\(named).png")
        if recordMode == nil, !FileManager.default.fileExists(atPath: reference.path) {
            throw XCTSkip("MOMO-529 canonical snapshot is awaiting recording")
        }

        let live = LiveChatBackend()
        let seed = await live.seedDemo()
        let viewModel = ChatViewModel(backend: live)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "memory-snapshot")
        viewModel.setChannels([
            Channel(
                id: .demoGeneral,
                workspaceId: seed.workspace,
                kind: .publicChannel,
                name: "general"
            ),
        ])
        let agentID = try XCTUnwrap(seed.agents.first?.id)
        let model = MomoMemoryBrowserModel(
            backend: MemoryTestBackend(agentID: agentID),
            workspace: seed.workspace,
            initialAgentID: agentID
        )
        await model.load()
        let size = CGSize(width: 1_040, height: 700)
        let content = MomoMemoryBrowserView(
            viewModel: viewModel,
            copy: MomoWorkspaceCopy(language: .korean),
            model: model
        )
        .frame(width: size.width, height: size.height)
        .environment(\.colorScheme, scheme)

        let host = NSHostingView(rootView: content)
        host.frame = CGRect(origin: .zero, size: size)
        host.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        guard let representation = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            throw XCTSkip("NSHostingView produced no memory browser bitmap")
        }
        host.cacheDisplay(in: host.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: named,
            record: recordMode,
            testName: canonicalName
        )
    }

    private func assertInspectorSnapshot(
        scheme: ColorScheme,
        expired: Bool,
        named: String,
        testName: String
    ) async throws {
        let canonicalName = testName.replacingOccurrences(of: "()", with: "")
        let reference = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("__Snapshots__/MomoMemoryBrowserTests")
            .appendingPathComponent("\(canonicalName).\(named).png")
        if recordMode == nil, !FileManager.default.fileExists(atPath: reference.path) {
            throw XCTSkip("MOMO-529 context inspector canonical snapshot is awaiting recording")
        }

        let live = LiveChatBackend()
        let seed = await live.seedDemo()
        let viewModel = ChatViewModel(backend: live)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "packet-snapshot")
        let snapshot = contextPacketFixture(workspace: seed.workspace, expired: expired)
        let size = CGSize(width: 760, height: 680)
        let content = MomoContextPacketInspectorView(
            viewModel: viewModel,
            snapshot: snapshot,
            copy: MomoWorkspaceCopy(language: .korean)
        )
        .frame(width: size.width, height: size.height)
        .environment(\.colorScheme, scheme)

        let host = NSHostingView(rootView: content)
        host.frame = CGRect(origin: .zero, size: size)
        host.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        guard let representation = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            throw XCTSkip("NSHostingView produced no context inspector bitmap")
        }
        host.cacheDisplay(in: host.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: named,
            record: recordMode,
            testName: canonicalName
        )
    }

    private func contextPacketFixture(workspace: WorkspaceID, expired: Bool) -> ContextPacketSnapshot {
        ContextPacketSnapshot(
            packetId: UUID(uuidString: "30000000-0000-7000-8000-000000000529")!,
            runId: RunID(uuidString: "40000000-0000-7000-8000-000000000529")!,
            workspaceId: workspace,
            createdAtMs: 1_753_144_800_000,
            expiresAtMs: 1_753_231_200_000,
            expired: expired,
            content: .object([
                "recent_messages": .array([
                    .object([
                        "excerpt": .string("배포 전에 macOS UI 게이트와 runtime-db 결과를 함께 확인해 주세요."),
                        "seq": .int(42),
                        "message_id": .string("30000000-0000-7000-8000-000000000529"),
                        "channel_id": .string(ChannelID.demoGeneral.description),
                    ]),
                ]),
                "memory_refs": .array([
                    .object([
                        "excerpt": .string("외부 쓰기는 담당자 승인 후 실행합니다."),
                        "kind": .string("procedure"),
                        "scope": .string("workspace"),
                    ]),
                ]),
                "tool_grants": .array([
                    .object([
                        "tool_name": .string("work.read"),
                        "provider": .string("momo"),
                        "approval_policy": .string("read-only"),
                    ]),
                ]),
                "budget": .object([
                    "max_prompt_tokens": .int(8_192),
                    "max_completion_tokens": .int(2_048),
                    "reserved_micro_usd": .int(12_000),
                    "hard_limit_micro_usd": .int(500_000),
                ]),
                "redactions": .array([
                    .string("개인 API 키와 인증 정보"),
                ]),
            ])
        )
    }
}

private actor MemoryTestBackend: MemoryPlaneBackend {
    private var items: [MemoryEntry]
    private var policyValue: WorkspaceMemoryPolicy
    private var mutation: String?

    init(agentID: MemberID = .demoAgent) {
        let now: Int64 = 1_753_144_800_000
        items = [
            MemoryEntry(
                id: UUID(uuidString: "20000000-0000-7000-8000-000000000529")!,
                workspaceId: .demo,
                scope: .agent,
                agentMemberId: agentID,
                channelId: .demoGeneral,
                kind: .fact,
                body: "배포 전에는 runtime-db와 macOS UI 게이트를 모두 확인합니다.",
                confidence: 0.91,
                validAtMs: now,
                createdByKind: "worker",
                createdAtMs: now,
                updatedAtMs: now,
                sourceRefs: [
                    MemorySourceReference(
                        messageId: MessageID(uuidString: "30000000-0000-7000-8000-000000000529")!,
                        channelId: .demoGeneral
                    ),
                ]
            ),
            MemoryEntry(
                id: UUID(uuidString: "20000000-0000-7000-8000-000000000530")!,
                workspaceId: .demo,
                scope: .workspace,
                kind: .procedure,
                body: "외부 쓰기는 승인 카드에서 담당자가 확인한 뒤 실행합니다.",
                confidence: 0.86,
                validAtMs: now - 86_400_000,
                createdByKind: "human",
                createdAtMs: now - 86_400_000,
                updatedAtMs: now - 86_400_000,
                sourceRefs: []
            ),
        ]
        policyValue = WorkspaceMemoryPolicy(workspaceId: .demo, enabled: true)
    }

    func memories(
        workspace: WorkspaceID,
        scope: MemoryScope?,
        agent: MemberID?,
        includeInvalid: Bool,
        limit: Int
    ) async throws -> [MemoryEntry] {
        items.filter { entry in
            (scope == nil || entry.scope == scope)
                && (agent == nil || entry.agentMemberId == agent)
                && (includeInvalid || entry.isActive)
        }
    }

    func searchMemories(
        workspace: WorkspaceID,
        query: String,
        scope: MemoryScope?,
        agent: MemberID?,
        limit: Int
    ) async throws -> [MemorySearchHit] {
        try await memories(
            workspace: workspace, scope: scope, agent: agent,
            includeInvalid: false, limit: limit
        ).filter { $0.body.localizedCaseInsensitiveContains(query) }
            .map { MemorySearchHit(memory: $0, score: 1) }
    }

    func updateMemory(
        workspace: WorkspaceID,
        memory: UUID,
        body: String,
        confidence: Double
    ) async throws -> MemoryEntry {
        let current = items.first { $0.id == memory }!
        let updated = MemoryEntry(
            id: current.id, workspaceId: current.workspaceId, scope: current.scope,
            subjectMemberId: current.subjectMemberId, agentMemberId: current.agentMemberId,
            channelId: current.channelId, kind: current.kind, body: body,
            confidence: confidence, validAtMs: current.validAtMs,
            invalidAtMs: current.invalidAtMs,
            invalidatedByMemoryId: current.invalidatedByMemoryId,
            createdByKind: current.createdByKind,
            createdByMemberId: current.createdByMemberId,
            createdAtMs: current.createdAtMs, updatedAtMs: current.updatedAtMs + 1,
            sourceRefs: current.sourceRefs
        )
        items[items.firstIndex { $0.id == memory }!] = updated
        mutation = "update"
        return updated
    }

    func invalidateMemory(workspace: WorkspaceID, memory: UUID) async throws -> MemoryEntry {
        let current = items.first { $0.id == memory }!
        let invalidated = MemoryEntry(
            id: current.id, workspaceId: current.workspaceId, scope: current.scope,
            subjectMemberId: current.subjectMemberId, agentMemberId: current.agentMemberId,
            channelId: current.channelId, kind: current.kind, body: current.body,
            confidence: current.confidence, validAtMs: current.validAtMs,
            invalidAtMs: current.updatedAtMs + 1,
            invalidatedByMemoryId: nil, createdByKind: current.createdByKind,
            createdByMemberId: current.createdByMemberId,
            createdAtMs: current.createdAtMs, updatedAtMs: current.updatedAtMs + 1,
            sourceRefs: current.sourceRefs
        )
        items[items.firstIndex { $0.id == memory }!] = invalidated
        mutation = "invalidate"
        return invalidated
    }

    func memoryPolicy(workspace: WorkspaceID) async throws -> WorkspaceMemoryPolicy { policyValue }

    func setMemoryPolicy(workspace: WorkspaceID, enabled: Bool) async throws -> WorkspaceMemoryPolicy {
        policyValue = WorkspaceMemoryPolicy(workspaceId: workspace, enabled: enabled)
        mutation = "policy:\(enabled)"
        return policyValue
    }

    func contextPacket(workspace: WorkspaceID, packet: UUID) async throws -> ContextPacketSnapshot {
        ContextPacketSnapshot(
            packetId: packet,
            runId: RunID(),
            workspaceId: workspace,
            createdAtMs: 1,
            expiresAtMs: 2,
            expired: false,
            content: .object(["schema": .string("momo.context_packet.v0")])
        )
    }

    func lastMutation() -> String? { mutation }
}

private struct MemoryPlaneHTTPResponse: Sendable {
    let statusCode: Int
    let json: String

    init(statusCode: Int = 200, json: String) {
        self.statusCode = statusCode
        self.json = json
    }
}

private final class MemoryPlaneURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> MemoryPlaneHTTPResponse

    nonisolated(unsafe) private static var handler: Handler?
    nonisolated(unsafe) private static var lock = NSLock()

    static func reset() async {
        lock.withLock { handler = nil }
    }

    static func setHandler(_ newHandler: @escaping Handler) async {
        lock.withLock { handler = newHandler }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let current = Self.lock.withLock { Self.handler }
        guard let current else {
            client?.urlProtocol(self, didFailWithError: BackendError.notConnected)
            return
        }
        do {
            let mocked = try current(request)
            let response = HTTPURLResponse(
                url: request.url!, statusCode: mocked.statusCode,
                httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"]
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

private extension URLSessionConfiguration {
    static var memoryPlaneMocked: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MemoryPlaneURLProtocol.self]
        return configuration
    }
}

private extension URLRequest {
    var memoryBodyData: Data? {
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
