import Foundation
import MomoCore
@testable import MomoiOSKit
import Testing

@Suite("MomoiOSKit Work")
struct IOSWorkTests {
    @Test("REST projections decode sessions hosts and pool without private terminal material")
    func workProjectionMapping() throws {
        let sessions = Data(#"{"workSessions":[{"id":"00000000-0000-7000-8000-000000000505","workspaceId":"00000000-0000-7000-8000-000000000001","channelId":"00000000-0000-7000-8000-000000000010","memberId":"00000000-0000-7000-8000-000000000002","hostId":"00000000-0000-7000-8000-000000000020","rootMessageId":"00000000-0000-7000-8000-000000000030","tool":"codex","label":"Ship the mobile Work tab","status":"running","observation":"open","observerGrantCount":0,"remoteAttachAvailable":true,"startedAtMs":1784632000000}]}"#.utf8)
        let hosts = Data(#"{"workHosts":[{"id":"00000000-0000-7000-8000-000000000020","workspaceId":"00000000-0000-7000-8000-000000000001","scope":"member","ownerMemberId":"00000000-0000-7000-8000-000000000002","type":"app","displayName":"Sungjae Mac","publicKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","capabilities":{"codex":true},"lastSeenAtMs":1784632000000,"revokedAtMs":null,"createdAtMs":1784631000000,"online":true}]}"#.utf8)
        let pool = Data(#"{"workPool":{"workspaceId":"00000000-0000-7000-8000-000000000001","maxActive":4,"includedActiveHours":20,"perMemberSoftLimit":2,"activeSessions":1,"memberActiveSessions":1}}"#.utf8)

        let snapshot = try MomoServerConversationClient.mapWorkSnapshot(
            sessionsData: sessions,
            hostsData: hosts,
            poolData: pool
        )

        #expect(snapshot.sessions.count == 1)
        #expect(snapshot.sessions[0].tool == .codex)
        #expect(snapshot.sessions[0].remoteAttachAvailable)
        #expect(snapshot.hosts[0].displayName == "Sungjae Mac")
        #expect(snapshot.hosts[0].online)
        #expect(snapshot.pool.activeSessions == 1)
        #expect(snapshot.pool.maxActive == 4)
        let encoded = String(decoding: sessions, as: UTF8.self)
        #expect(!encoded.contains("capability_token"))
        #expect(!encoded.contains("attach_endpoint"))
        #expect(!encoded.contains("cwd"))
    }

    @MainActor
    @Test("Work model sorts active sessions and exposes developer summary and filter")
    func workListPresentation() async throws {
        let running = workSession(status: .running, startedAtMs: 2_000, suffix: 1)
        let ended = workSession(status: .ended, startedAtMs: 3_000, endedAtMs: 9_000, suffix: 2)
        let backend = SequenceWorkBackend(snapshots: [workSnapshot(sessions: [ended, running])])
        let model = IOSWorkListModel(backend: backend)

        await model.retry()

        #expect(model.phase == .loaded)
        #expect(model.sessions.map(\.id) == [running.id, ended.id])
        #expect(model.summary.runningCount == 1)
        #expect(model.summary.completedCount == 1)
        model.filter = .running
        #expect(model.visibleSessions.map(\.id) == [running.id])
        #expect(ended.elapsedDescription(now: Date(timeIntervalSince1970: 20)) == "< 1 min")
    }

    @MainActor
    @Test("work session realtime hint reloads the authoritative REST projection")
    func realtimeRefreshesProjection() async throws {
        let running = workSession(status: .running, startedAtMs: 2_000, suffix: 3)
        let ended = workSession(status: .ended, startedAtMs: 2_000, endedAtMs: 62_000, suffix: 3)
        let backend = SequenceWorkBackend(snapshots: [
            workSnapshot(sessions: [running]),
            workSnapshot(sessions: [ended]),
        ])
        let model = IOSWorkListModel(backend: backend)
        await model.retry()

        await model.receive(WorkSessionDelta(
            action: .ended,
            sessionId: running.id,
            channelId: running.channelId,
            rootMessageId: running.rootMessageId,
            memberId: running.memberId,
            hostId: running.hostId,
            tool: .codex,
            label: running.label,
            endedAtMs: 62_000,
            exitCode: 0
        ))

        #expect(model.sessions.first?.status == .ended)
        #expect(model.sessions.first?.exitCode == 0)
        #expect(await backend.snapshotCallCount == 2)
    }
}

private actor SequenceWorkBackend: IOSWorkBackend {
    private let snapshots: [IOSWorkSnapshot]
    private(set) var snapshotCallCount = 0

    init(snapshots: [IOSWorkSnapshot]) {
        self.snapshots = snapshots
    }

    func workSnapshot() async throws -> IOSWorkSnapshot {
        let index = min(snapshotCallCount, snapshots.count - 1)
        snapshotCallCount += 1
        return snapshots[index]
    }

    func workEvents(channel: ChannelID) async throws -> AsyncStream<WorkSessionDelta> {
        AsyncStream { $0.finish() }
    }
}

private let workWorkspaceID = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
private let workChannelID = ChannelID(uuidString: "00000000-0000-7000-8000-000000000010")!
private let workMemberID = MemberID(uuidString: "00000000-0000-7000-8000-000000000002")!
private let workHostID = WorkHostID(uuidString: "00000000-0000-7000-8000-000000000020")!

private func workSession(
    status: IOSWorkSessionStatus,
    startedAtMs: Int64,
    endedAtMs: Int64? = nil,
    suffix: Int
) -> IOSWorkSession {
    IOSWorkSession(
        id: WorkSessionID(uuidString: String(format: "00000000-0000-7000-8000-%012d", suffix))!,
        workspaceId: workWorkspaceID,
        channelId: workChannelID,
        memberId: workMemberID,
        hostId: workHostID,
        rootMessageId: MessageID(uuidString: String(format: "00000000-0000-7000-9000-%012d", suffix))!,
        tool: .codex,
        label: "Session \(suffix)",
        status: status,
        startedAtMs: startedAtMs,
        endedAtMs: endedAtMs,
        exitCode: status == .ended ? 0 : nil
    )
}

private func workSnapshot(sessions: [IOSWorkSession]) -> IOSWorkSnapshot {
    IOSWorkSnapshot(
        sessions: sessions,
        hosts: [
            WorkHost(
                id: workHostID,
                workspaceId: workWorkspaceID,
                scope: .member,
                ownerMemberId: workMemberID,
                type: .app,
                displayName: "Sungjae Mac",
                publicKey: "test-public-key",
                createdAtMs: 1,
                online: true
            ),
        ],
        pool: IOSWorkPool(
            workspaceId: workWorkspaceID,
            maxActive: 4,
            perMemberSoftLimit: 2,
            activeSessions: sessions.count(where: \.isRunning),
            memberActiveSessions: sessions.count(where: \.isRunning)
        )
    )
}
