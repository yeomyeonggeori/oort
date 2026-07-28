@preconcurrency import Crypto
import Foundation
import MomoACPHost
import Logging
import XCTest
@testable import WorkHostDaemon

final class WorkHostDaemonTests: XCTestCase {
    func testKeyStoreCreatesReloadsAndHardens0600() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let keyURL = directory.appendingPathComponent("identity.key")
        let first = try SecureLocalStore.loadOrCreateSigner(at: keyURL)
        let second = try SecureLocalStore.loadOrCreateSigner(at: keyURL)
        XCTAssertEqual(first.publicKeyBase64, second.publicKeyBase64)
        XCTAssertEqual(try Data(contentsOf: keyURL).count, 32)
        let attributes = try FileManager.default.attributesOfItem(atPath: keyURL.path)
        let mode = try XCTUnwrap(attributes[.posixPermissions] as? NSNumber).uint16Value
        XCTAssertEqual(mode & 0o077, 0)
    }

    func testSigningPayloadsMatchServerByteContracts() throws {
        let key = Curve25519.Signing.PrivateKey()
        let signer = try WorkHostSigner(rawRepresentation: key.rawRepresentation)
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let hostID = UUID(uuidString: "00000000-0000-7000-8000-000000000488")!
        let sentAtMs: Int64 = 1_784_582_400_000
        XCTAssertEqual(
            String(decoding: signer.heartbeatPayload(
                workspaceID: workspaceID,
                hostID: hostID,
                sentAtMs: sentAtMs
            ), as: UTF8.self),
            "momo.work_host.heartbeat.v1\n\(workspaceID.uuidString.lowercased())\n\(hostID.uuidString.lowercased())\n\(sentAtMs)"
        )
        let path = "/v1/workspaces/\(workspaceID.uuidString.lowercased())/work-sessions"
        XCTAssertEqual(
            String(decoding: signer.requestPayload(
                method: "post",
                path: path,
                workspaceID: workspaceID,
                hostID: hostID,
                sentAtMs: sentAtMs
            ), as: UTF8.self),
            "momo.work_host.request.v1\nPOST\n\(path)\n\(workspaceID.uuidString.lowercased())\n\(hostID.uuidString.lowercased())\n\(sentAtMs)"
        )
    }

    func testConfigRejectsRemotePlaintextAndParsesLocalTemplates() throws {
        let workspaceID = UUID()
        XCTAssertThrowsError(try WorkdConfig.load(environment: [
            "MOMO_WORKD_SERVER_URL": "http://example.com",
            "MOMO_WORKD_WORKSPACE_ID": workspaceID.uuidString,
        ]))
        let config = try WorkdConfig.load(environment: [
            "MOMO_WORKD_SERVER_URL": "http://127.0.0.1:27950",
            "MOMO_WORKD_ALLOW_INSECURE_HTTP": "1",
            "MOMO_WORKD_WORKSPACE_ID": workspaceID.uuidString,
            "MOMO_WORKD_PROFILE_SHELL_EXECUTABLE": "/bin/cat",
            "MOMO_WORKD_PROFILE_SHELL_ARGUMENTS_JSON": "[]",
        ])
        XCTAssertEqual(config.localCommandOverrides["shell"], LocalCommandOverride(
            executable: "/bin/cat",
            arguments: []
        ))
        XCTAssertEqual(config.ringBufferBytes, 256 * 1_024)
        XCTAssertNil(config.registrationToken)
        XCTAssertEqual(config.hostType, "workd")
        XCTAssertEqual(config.childEnvironmentPolicy, .safeDefault)
        XCTAssertFalse(config.allowProfileLegacyEnvironment)
    }

    func testCloudHostTypeRequiresWorkspaceScope() throws {
        let workspaceID = UUID().uuidString
        XCTAssertThrowsError(try WorkdConfig.load(environment: [
            "MOMO_WORKD_SERVER_URL": "https://momo.example.test",
            "MOMO_WORKD_WORKSPACE_ID": workspaceID,
            "MOMO_WORKD_HOST_TYPE": "cloud",
            "MOMO_WORKD_SCOPE": "member",
        ]))
        let config = try WorkdConfig.load(environment: [
            "MOMO_WORKD_SERVER_URL": "https://momo.example.test",
            "MOMO_WORKD_WORKSPACE_ID": workspaceID,
            "MOMO_WORKD_HOST_TYPE": "cloud",
            "MOMO_WORKD_SCOPE": "workspace",
        ])
        XCTAssertEqual(config.hostType, "cloud")
        XCTAssertEqual(config.scope, "workspace")
    }

    func testChildEnvironmentDefaultsToAllowlistAndSupportsExplicitPassthrough() throws {
        let environment = [
            "PATH": "/usr/bin", "HOME": "/tmp/home", "USER": "momo",
            "SHELL": "/bin/zsh", "LANG": "ko_KR.UTF-8", "LC_ALL": "C",
            "TERM": "xterm-256color", "TMPDIR": "/tmp", "GH_TOKEN": "secret",
            "AWS_SECRET_ACCESS_KEY": "secret", "SSH_AUTH_SOCK": "/tmp/agent",
            "CUSTOM_TOOL_HOME": "/tmp/tool", "MOMO_WORKD_SERVER_URL": "https://momo.test",
        ]
        let safe = ChildEnvironmentPolicy.safeDefault.filtered(environment)
        XCTAssertEqual(safe["PATH"], "/usr/bin")
        XCTAssertEqual(safe["LC_ALL"], "C")
        XCTAssertNil(safe["GH_TOKEN"])
        XCTAssertNil(safe["AWS_SECRET_ACCESS_KEY"])
        XCTAssertNil(safe["SSH_AUTH_SOCK"])
        XCTAssertNil(safe["MOMO_WORKD_SERVER_URL"])

        let configured = try WorkdConfig.childEnvironmentPolicy(environment: [
            "MOMO_WORKD_ENV_PASSTHROUGH": "CUSTOM_TOOL_HOME,GH_TOKEN",
        ])
        let passed = configured.filtered(environment)
        XCTAssertEqual(passed["CUSTOM_TOOL_HOME"], "/tmp/tool")
        XCTAssertEqual(passed["GH_TOKEN"], "secret")
        XCTAssertNil(passed["AWS_SECRET_ACCESS_KEY"])
        XCTAssertThrowsError(try WorkdConfig.childEnvironmentPolicy(environment: [
            "MOMO_WORKD_ENV_PASSTHROUGH": "GOOD,MOMO_WORKD_SERVER_URL",
        ]))
    }

    func testProfilePolicyAddsPassthroughAndLegacyRequiresHostOptIn() throws {
        let workspaceID = UUID()
        let profile = Self.profile(
            workspaceID: workspaceID,
            toolKey: "shell",
            command: "sh",
            envPolicy: .object([
                "mode": .string("legacy"),
                "passthrough": .array([.string("GH_TOKEN")]),
            ])
        )
        let safe = try WorkdConfig.commandTemplates(profiles: [profile], localOverrides: [:])
        XCTAssertEqual(safe["shell"]?.environmentPolicy.mode, .allowlist)
        XCTAssertTrue(safe["shell"]?.environmentPolicy.passthrough.isEmpty == true)

        let legacy = try WorkdConfig.commandTemplates(
            profiles: [profile],
            localOverrides: [:],
            hostEnvironmentPolicy: ChildEnvironmentPolicy(
                mode: .allowlist,
                passthrough: ["GH_TOKEN", "CUSTOM_TOOL_HOME"]
            ),
            allowProfileLegacyEnvironment: true
        )
        XCTAssertEqual(legacy["shell"]?.environmentPolicy.mode, .legacy)
        XCTAssertEqual(legacy["shell"]?.environmentPolicy.passthrough, ["GH_TOKEN"])
    }

    func testRegistrationTokenFileMustBePrivateAndCanBeConsumed() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let tokenURL = directory.appendingPathComponent("registration.token")
        try Data("one-time-token\n".utf8).write(to: tokenURL)
        try SecureLocalStore.setMode(0o600, at: tokenURL)
        let config = try WorkdConfig.load(environment: [
            "MOMO_WORKD_SERVER_URL": "http://127.0.0.1:27950",
            "MOMO_WORKD_ALLOW_INSECURE_HTTP": "1",
            "MOMO_WORKD_WORKSPACE_ID": UUID().uuidString,
            "MOMO_WORKD_REGISTRATION_TOKEN_FILE": tokenURL.path,
        ])
        XCTAssertEqual(config.registrationToken, "one-time-token")
        XCTAssertEqual(config.registrationTokenURL, tokenURL)
        try SecureLocalStore.removeConsumedSecret(at: tokenURL)
        XCTAssertFalse(FileManager.default.fileExists(atPath: tokenURL.path))
    }

    func testUnexpectedErrorsNeverBecomeServerFacingDetails() {
        let localFailure = NSError(
            domain: "/Users/private/project/.env",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "OPENAI_API_KEY=secret"]
        )
        XCTAssertEqual(WorkDaemon.label(for: localFailure), "internal_failure")
    }

    func testSpawnInputKillDispatchKeepsRawOutputLocal() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let hostID = UUID()
        let workspaceID = UUID()
        let channelID = UUID()
        let sessionID = UUID()
        let spawn = Self.control(
            workspaceID: workspaceID,
            channelID: channelID,
            hostID: hostID,
            kind: "spawn",
            payload: .object(["tool": .string("shell"), "label": .string("mock echo")])
        )
        let input = Self.control(
            workspaceID: workspaceID,
            channelID: channelID,
            hostID: hostID,
            sessionID: sessionID,
            kind: "input",
            payload: .object(["text": .string("momo-workd-echo\n")])
        )
        let kill = Self.control(
            workspaceID: workspaceID,
            channelID: channelID,
            hostID: hostID,
            sessionID: sessionID,
            kind: "kill",
            payload: .object([:])
        )
        let api = MockWorkHostAPI(
            controls: [[spawn], [input], [kill]],
            profiles: [Self.profile(workspaceID: workspaceID, toolKey: "shell", command: "sh")],
            session: WorkSession(
                id: sessionID,
                workspaceId: workspaceID,
                channelId: channelID,
                memberId: UUID(),
                hostId: hostID,
                rootMessageId: UUID(),
                tool: "shell",
                label: "mock echo",
                status: "running",
                startedAtMs: 1,
                endedAtMs: nil,
                exitCode: nil,
                endReason: nil,
                resumedFromSessionId: nil
            )
        )
        let manager = ProcessManager(
            templates: ["shell": CommandTemplate(executable: "/bin/cat", arguments: [])],
            outputDirectory: directory
        )
        let daemon = WorkDaemon(
            hostID: hostID,
            api: api,
            processes: manager,
            pollInterval: .milliseconds(10),
            heartbeatInterval: .seconds(30),
            localCommandOverrides: [
                "shell": LocalCommandOverride(executable: "/bin/cat", arguments: [])
            ],
            logger: Logger(label: "test")
        )
        await daemon.pollOnce()
        await daemon.pollOnce()
        try await Task.sleep(for: .milliseconds(100))
        await daemon.pollOnce()

        let events = await api.events
        XCTAssertTrue(events.contains("ack:\(spawn.id):true:\(sessionID)"))
        XCTAssertTrue(events.contains("ack:\(input.id):true:\(sessionID)"))
        XCTAssertTrue(events.contains("ack:\(kill.id):true:\(sessionID)"))
        XCTAssertTrue(events.contains(where: { $0.hasPrefix("end:\(sessionID):") }))
        let output = try String(contentsOf: await manager.outputURL(for: sessionID), encoding: .utf8)
        XCTAssertTrue(output.contains("momo-workd-echo"))
        XCTAssertFalse(events.contains(where: { $0.contains("momo-workd-echo") }))
    }

    func testPTYReplayJoinsRetainedMarkerAndLiveWithoutGapOrDuplicate() async throws {
        let buffer = PTYReplayBuffer(capacityBytes: 64)
        buffer.append(Data("before-".utf8))
        var iterator = buffer.connect().makeAsyncIterator()
        buffer.append(Data("after".utf8))

        // Bounded stream, not bounded next(): with the retained-replay yield
        // removed (the red proof), a bare `await iterator.next()` waits forever
        // and the regression shows up as a HANG, not a red assertion — measured
        // live as swift-test pinned at 0% CPU for 10 minutes. The iterator is
        // not Sendable, so instead of racing next() across tasks, a watchdog
        // finishes the buffer (Sendable) after a deadline: a starved stream
        // then yields nil and the equality assertions below go red by name.
        let watchdog = Task { [buffer] in
            try? await Task.sleep(for: .seconds(3))
            buffer.finish()
        }
        defer { watchdog.cancel() }
        let replay = await iterator.next()
        let marker = await iterator.next()
        let live = await iterator.next()
        XCTAssertEqual(replay, .bytes(Data("before-".utf8)))
        XCTAssertEqual(marker, .replayEnd(byteOffset: 7))
        XCTAssertEqual(live, .bytes(Data("after".utf8)))
        buffer.finish()
    }

    func testPTYReplayEvictsOldestBytesAtConfiguredBound() async throws {
        let buffer = PTYReplayBuffer(capacityBytes: 8)
        buffer.append(Data("012345".utf8))
        buffer.append(Data("6789".utf8))
        XCTAssertEqual(buffer.retainedByteCount, 8)

        var iterator = buffer.connect().makeAsyncIterator()
        let replay = await iterator.next()
        let marker = await iterator.next()
        XCTAssertEqual(replay, .bytes(Data("23456789".utf8)))
        XCTAssertEqual(marker, .replayEnd(byteOffset: 10))
        buffer.finish()
    }

    func testReplayEndControlFrameHasStableNonTerminalWireShape() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let encoded = try encoder.encode(PTYReplayEndFrame(byteOffset: 42))
        XCTAssertEqual(
            String(decoding: encoded, as: UTF8.self),
            #"{"byte_offset":42,"type":"replay_end"}"#
        )
    }

    func testDaemonReportsToolIdleThenRunningForCanonicalRerun() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("momo-daemon-idle-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let hostID = UUID()
        let workspaceID = UUID()
        let sessionID = UUID()
        let spawn = Self.control(
            workspaceID: workspaceID,
            channelID: UUID(),
            hostID: hostID,
            kind: "spawn",
            payload: .object(["tool": .string("echo-tool"), "label": .string("echo")])
        )
        let api = MockWorkHostAPI(
            controls: [[spawn], [], []],
            profiles: [Self.profile(
                workspaceID: workspaceID,
                toolKey: "echo-tool",
                command: "echo"
            )],
            session: WorkSession(
                id: sessionID,
                workspaceId: workspaceID,
                channelId: spawn.channelId,
                memberId: UUID(),
                hostId: hostID,
                rootMessageId: UUID(),
                tool: "echo-tool",
                label: "echo",
                status: "running",
                startedAtMs: 1,
                endedAtMs: nil,
                exitCode: nil,
                endReason: nil,
                resumedFromSessionId: nil
            )
        )
        let manager = ProcessManager(
            templates: [:],
            outputDirectory: directory,
            hostEnvironment: [
                "PATH": "/usr/bin:/bin",
                "HOME": directory.path,
                "SHELL": "/bin/bash",
                "TERM": "xterm-256color",
            ]
        )
        let daemon = WorkDaemon(
            hostID: hostID,
            api: api,
            processes: manager,
            pollInterval: .milliseconds(10),
            heartbeatInterval: .seconds(30),
            localCommandOverrides: [
                "echo-tool": LocalCommandOverride(
                    executable: "/bin/echo",
                    arguments: ["daemon-finished"]
                ),
            ],
            logger: Logger(label: "test")
        )

        await daemon.pollOnce()
        let idleDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !(await api.events).contains("idle:\(sessionID):0"),
              ContinuousClock.now < idleDeadline
        {
            try await Task.sleep(for: .milliseconds(20))
            await daemon.pollOnce()
        }
        let eventsAfterIdle = await api.events
        XCTAssertTrue(eventsAfterIdle.contains("idle:\(sessionID):0"))

        try await manager.write("echo\n", to: sessionID)
        let runningDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !(await api.events).contains("running:\(sessionID)"),
              ContinuousClock.now < runningDeadline
        {
            try await Task.sleep(for: .milliseconds(20))
            await daemon.pollOnce()
        }
        let events = await api.events
        let idleIndex = try XCTUnwrap(events.firstIndex(of: "idle:\(sessionID):0"))
        let runningIndex = try XCTUnwrap(events.firstIndex(of: "running:\(sessionID)"))
        XCTAssertLessThan(idleIndex, runningIndex)
        _ = try await manager.terminate(sessionID)
        await manager.markEndReported(sessionID)
    }

    func testShellWrappedToolIdlesKeepsPTYAndReportsOnlyCanonicalToolRerun() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("momo-shell-wrap-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let manager = ProcessManager(
            templates: ["echo-tool": CommandTemplate(
                executable: "/bin/echo",
                arguments: ["tool-finished"]
            )],
            outputDirectory: directory,
            hostEnvironment: [
                "PATH": "/usr/bin:/bin",
                "HOME": directory.path,
                "SHELL": "/bin/bash",
                "TERM": "xterm-256color",
            ],
            ringBufferBytes: 4_096
        )
        let sessionID = UUID()
        try await manager.start(
            sessionID: sessionID,
            channelID: UUID(),
            tool: "echo-tool",
            prompt: "ignored"
        )
        await manager.markAcknowledged(sessionID)

        let initial = try await waitForTransitions(manager, count: 1)
        XCTAssertEqual(initial, [.init(sessionID: sessionID, status: .idle(exitCode: 0))])
        await manager.markTransitionReported(initial[0])
        let endedAfterTool = await manager.endedSessions()
        XCTAssertTrue(endedAfterTool.isEmpty, "the login shell must survive tool exit")

        let resolvedPTYID = await manager.ptyID(for: sessionID)
        let ptyID = try XCTUnwrap(resolvedPTYID)
        let attachedStream = try await manager.connect(ptyID: ptyID)
        var attached = attachedStream.makeAsyncIterator()
        guard case .bytes(let replay)? = await attached.next() else {
            return XCTFail("expected retained PTY replay")
        }
        XCTAssertTrue(String(decoding: replay, as: UTF8.self).contains("tool-finished"))
        guard case .replayEnd? = await attached.next() else {
            return XCTFail("expected explicit replay boundary")
        }
        try await manager.write("printf 'live-tail\\n'\n", to: sessionID)
        // PTY delivery granularity is machine-dependent: the TTY echo of the
        // typed command can arrive split into arbitrarily small fragments (a
        // bare "print" was measured as the first chunk on a loaded host), so a
        // single-chunk assertion is a timing artifact. Accumulate live bytes
        // until the marker shows up; the deadline keeps a real regression red.
        var liveText = ""
        let liveDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !liveText.contains("live-tail"), ContinuousClock.now < liveDeadline {
            guard case .bytes(let live)? = await attached.next() else {
                return XCTFail("expected live bytes after replay boundary")
            }
            liveText += String(decoding: live, as: UTF8.self)
        }
        XCTAssertTrue(liveText.contains("live-tail"))

        try await manager.write("ls >/dev/null\n", to: sessionID)
        try await Task.sleep(for: .milliseconds(150))
        let transitionsAfterLS = await manager.toolTransitions()
        XCTAssertTrue(transitionsAfterLS.isEmpty, "ordinary shell commands are not tools")

        try await manager.write("echo\n", to: sessionID)
        let rerun = try await waitForTransitions(manager, count: 2)
        XCTAssertEqual(rerun, [
            .init(sessionID: sessionID, status: .running),
            .init(sessionID: sessionID, status: .idle(exitCode: 0)),
        ])

        do {
            try await manager.write(Data("denied\n".utf8), toPTY: ptyID, mode: .observer)
            XCTFail("observer input must be rejected")
        } catch WorkdFailure.stdinUnavailable {
        } catch {
            XCTFail("unexpected observer rejection: \(error)")
        }
        try await manager.write(Data("true\n".utf8), toPTY: ptyID, mode: .controller)
        _ = try await manager.terminate(sessionID)
        await manager.markEndReported(sessionID)
        do {
            _ = try await manager.connect(ptyID: ptyID)
            XCTFail("ended PTY must be removed")
        } catch WorkdFailure.stdinUnavailable {
        } catch {
            XCTFail("unexpected ended PTY error: \(error)")
        }
    }

    private func waitForTransitions(
        _ manager: ProcessManager,
        count: Int
    ) async throws -> [ProcessManager.ToolTransition] {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            let transitions = await manager.toolTransitions()
            if transitions.count >= count { return transitions }
            try await Task.sleep(for: .milliseconds(20))
        }
        return await manager.toolTransitions()
    }

    private static func control(
        workspaceID: UUID,
        channelID: UUID,
        hostID: UUID,
        sessionID: UUID? = nil,
        kind: String,
        payload: JSONValue
    ) -> WorkControl {
        WorkControl(
            id: UUID(),
            workspaceId: workspaceID,
            channelId: channelID,
            requesterMemberId: UUID(),
            targetHostId: hostID,
            sessionId: sessionID,
            kind: kind,
            payload: payload,
            status: "dispatched",
            approvalMessageId: nil,
            createdAtMs: 1,
            updatedAtMs: 1
        )
    }

    private static func profile(
        workspaceID: UUID,
        toolKey: String,
        command: String,
        envPolicy: JSONValue = .object([:])
    ) -> WorkToolProfile {
        WorkToolProfile(
            id: UUID(),
            workspaceId: workspaceID,
            toolKey: toolKey,
            displayName: toolKey,
            launchTemplate: WorkToolLaunchTemplate(command: command, arguments: []),
            tierDefaults: .object([:]),
            envPolicy: envPolicy,
            enabled: true,
            createdBy: UUID(),
            updatedBy: UUID(),
            createdAtMs: 1,
            updatedAtMs: 1
        )
    }

    func testServerProfilesResolveThroughHostLocalCommands() throws {
        let workspaceID = UUID()
        let profiles = [
            Self.profile(workspaceID: workspaceID, toolKey: "shell", command: "sh"),
            Self.profile(workspaceID: workspaceID, toolKey: "kimi", command: "kimi"),
        ]
        let templates = try WorkdConfig.commandTemplates(
            profiles: profiles,
            localOverrides: [
                "shell": LocalCommandOverride(executable: "/bin/cat", arguments: [])
            ]
        )
        XCTAssertEqual(
            templates["shell"],
            CommandTemplate(executable: "/bin/cat", arguments: [])
        )
        XCTAssertEqual(
            templates["kimi"],
            CommandTemplate(executable: "/usr/bin/env", arguments: ["kimi"])
        )
    }
}

actor MockWorkHostAPI: WorkHostAPI {
    private var controlBatches: [[WorkControl]]
    private let profiles: [WorkToolProfile]
    private let session: WorkSession
    private(set) var events: [String] = []

    init(controls: [[WorkControl]], profiles: [WorkToolProfile], session: WorkSession) {
        controlBatches = controls
        self.profiles = profiles
        self.session = session
    }

    func heartbeat(hostID: UUID) async throws { events.append("heartbeat:\(hostID)") }
    func workToolProfiles(hostID: UUID) async throws -> [WorkToolProfile] { profiles }
    func pendingControls(hostID: UUID) async throws -> [WorkControl] {
        guard !controlBatches.isEmpty else { return [] }
        return controlBatches.removeFirst()
    }
    func createSession(hostID: UUID, control: WorkControl) async throws -> WorkSession {
        events.append("create:\(control.id)")
        return session
    }
    func acknowledge(
        hostID: UUID,
        controlID: UUID,
        ok: Bool,
        sessionID: UUID?,
        errorLabel: String?
    ) async throws {
        events.append("ack:\(controlID):\(ok):\(sessionID?.uuidString ?? "nil")")
    }
    func endSession(hostID: UUID, sessionID: UUID, exitCode: Int?) async throws {
        events.append("end:\(sessionID):\(exitCode.map(String.init) ?? "nil")")
    }
    func reportSessionIdle(hostID: UUID, sessionID: UUID, exitCode: Int) async throws {
        events.append("idle:\(sessionID):\(exitCode)")
    }
    func reportSessionRunning(hostID: UUID, sessionID: UUID) async throws {
        events.append("running:\(sessionID)")
    }
    func relayACPEvent(
        hostID: UUID,
        sessionID: UUID,
        event: ACPProjectedEvent
    ) async throws {
        events.append("acp:\(sessionID):\(event.type)")
    }
}
