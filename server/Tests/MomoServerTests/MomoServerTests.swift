import XCTest
@testable import MomoServer

final class MomoServerTests: XCTestCase {
    func testSmoke() {
        XCTAssertEqual("MomoServer", "MomoServer")
    }

    func testInviteRoleValidationDefaultsAndRejectsOwner() throws {
        XCTAssertEqual(try InviteRoutes.normalizedRole(nil), "member")
        XCTAssertEqual(try InviteRoutes.normalizedRole(" ADMIN "), "admin")
        XCTAssertEqual(try InviteRoutes.normalizedRole("guest"), "guest")
        XCTAssertThrowsError(try InviteRoutes.normalizedRole("owner"))
        XCTAssertThrowsError(try InviteRoutes.normalizedRole("agent"))
    }

    func testInviteMaxUsesValidationMatchesMigrationConstraint() throws {
        XCTAssertEqual(try InviteRoutes.validatedMaxUses(nil), 1)
        XCTAssertEqual(try InviteRoutes.validatedMaxUses(10_000), 10_000)
        XCTAssertThrowsError(try InviteRoutes.validatedMaxUses(0))
        XCTAssertThrowsError(try InviteRoutes.validatedMaxUses(10_001))
    }

    func testJoinIdentityValidationNormalizesInputs() throws {
        XCTAssertEqual(try JoinRoutes.normalizedEmail("  USER@Example.COM  "), "user@example.com")
        XCTAssertEqual(try JoinRoutes.normalizedDisplayName("  New Human  "), "New Human")
        XCTAssertEqual(try JoinRoutes.normalizedRequestedHandle(" New_Human-1 "), "new_human-1")
        XCTAssertEqual(try JoinRoutes.fallbackHandle(email: "new.human@example.com"), "new-human")
        XCTAssertEqual(try JoinRoutes.normalizedTimeZone(nil), "UTC")
        XCTAssertEqual(try JoinRoutes.normalizedTimeZone("Asia/Seoul"), "Asia/Seoul")
        XCTAssertEqual(try JoinRoutes.normalizedPassword("dev-password"), "dev-password")
    }

    func testJoinIdentityValidationRejectsBadInputs() throws {
        XCTAssertThrowsError(try JoinRoutes.normalizedEmail("missing-at"))
        XCTAssertThrowsError(try JoinRoutes.normalizedDisplayName("   "))
        XCTAssertThrowsError(try JoinRoutes.normalizedRequestedHandle("Owner!"))
        XCTAssertThrowsError(try JoinRoutes.normalizedTimeZone(String(repeating: "a", count: 65)))
        XCTAssertThrowsError(try JoinRoutes.normalizedPassword(nil))
        XCTAssertThrowsError(try JoinRoutes.normalizedPassword(""))
        XCTAssertThrowsError(try JoinRoutes.normalizedPassword(String(repeating: "a", count: 1025)))
    }

    func testPlatformReadScopeRequiresAllowlistAndSecret() {
        let admins = ["ops@momo.local"]

        XCTAssertFalse(AuthRoutes.shouldGrantPlatformRead(
            email: "ops@momo.local",
            platformAdminSecret: "anything",
            platformAdminEmails: admins,
            platformAdminLoginSecret: nil
        ))
        XCTAssertFalse(AuthRoutes.shouldGrantPlatformRead(
            email: "ops@momo.local",
            platformAdminSecret: nil,
            platformAdminEmails: admins,
            platformAdminLoginSecret: "secret"
        ))
        XCTAssertFalse(AuthRoutes.shouldGrantPlatformRead(
            email: "ops@momo.local",
            platformAdminSecret: "wrong",
            platformAdminEmails: admins,
            platformAdminLoginSecret: "secret"
        ))
        XCTAssertFalse(AuthRoutes.shouldGrantPlatformRead(
            email: "other@momo.local",
            platformAdminSecret: "secret",
            platformAdminEmails: admins,
            platformAdminLoginSecret: "secret"
        ))
        XCTAssertTrue(AuthRoutes.shouldGrantPlatformRead(
            email: "OPS@MOMO.LOCAL",
            platformAdminSecret: "secret",
            platformAdminEmails: admins,
            platformAdminLoginSecret: "secret"
        ))
    }

    func testRealtimeTokenTTLIsClampedToShortWindow() {
        XCTAssertEqual(Config.clampedCentConnectionTokenTTL(-1), 60)
        XCTAssertEqual(Config.clampedCentConnectionTokenTTL(59), 60)
        XCTAssertEqual(Config.clampedCentConnectionTokenTTL(300), 300)
        XCTAssertEqual(Config.clampedCentConnectionTokenTTL(1_800), 1_800)
        XCTAssertEqual(Config.clampedCentConnectionTokenTTL(7_200), 1_800)
    }

    func testAgentProviderStatusIsRedactedAndMockVisible() throws {
        let provider = AgentProviderConfig(
            mode: .internalHostMock,
            hermesBaseURL: "http://user:password@mock-hermes:8088/v1?token=secret",
            hermesAPIKey: "change-me-hermes-bearer",
            model: "hermes-agent",
            agentHandle: "kim-intern",
            displayName: "김인턴",
            allowLocalLoopback: false
        )

        let status = provider.statusResponse()
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(status)) as? [String: Any]

        XCTAssertEqual(status.availability, "mock")
        XCTAssertEqual(status.endpointLabel, "http://mock-hermes:8088/v1")
        XCTAssertEqual(object?["mode"] as? String, "internal-host-mock")
        XCTAssertEqual(object?["availability"] as? String, "mock")
        XCTAssertFalse(status.endpointLabel.contains("password"))
        XCTAssertFalse(status.endpointLabel.contains("secret"))
        XCTAssertFalse(status.keyConfigured)
    }

    func testStrictServerProviderConfigFailsFastForUnsafeExternalConfig() {
        let provider = AgentProviderConfig(
            mode: .localMock,
            hermesBaseURL: "http://localhost:8088/v1",
            hermesAPIKey: "dev-insecure-hermes-bearer",
            model: "hermes-agent",
            agentHandle: "kim-intern",
            displayName: "김인턴",
            allowLocalLoopback: false
        )

        XCTAssertThrowsError(try provider.validateForBoot(environmentName: "prod")) { error in
            let text = String(describing: error)
            XCTAssertTrue(text.contains("external-hermes"))
            XCTAssertTrue(text.contains("HERMES_BASE_URL"))
            XCTAssertTrue(text.contains("HERMES_API_KEY"))
            XCTAssertFalse(text.contains("dev-insecure-hermes-bearer"))
        }
    }

    func testLocalExternalProviderAllowsLoopbackOnlyWithExplicitOptIn() throws {
        let provider = AgentProviderConfig(
            mode: .externalHermes,
            hermesBaseURL: "http://127.0.0.1:22683/v1",
            hermesAPIKey: "local-hermes-bearer",
            model: "gpt-4.1-mini-through-local-hermes",
            agentHandle: "kim-intern",
            displayName: "김인턴",
            allowLocalLoopback: true
        )

        XCTAssertNoThrow(try provider.validateForBoot(environmentName: "local"))
        XCTAssertEqual(provider.availability, "available")
        XCTAssertEqual(provider.endpointLabel, "http://127.0.0.1:22683/v1")
        XCTAssertThrowsError(try provider.validateForBoot(environmentName: "staging")) { error in
            let text = String(describing: error)
            XCTAssertTrue(text.contains("localhost"))
        }
    }

    func testNonLoopbackHTTPStillFailsFastForExternalProvider() {
        let provider = AgentProviderConfig(
            mode: .externalHermes,
            hermesBaseURL: "http://kim.example.net/v1",
            hermesAPIKey: "local-hermes-bearer",
            model: "hermes-agent",
            agentHandle: "kim-intern",
            displayName: "김인턴",
            allowLocalLoopback: true
        )

        XCTAssertThrowsError(try provider.validateForBoot(environmentName: "local")) { error in
            let text = String(describing: error)
            XCTAssertTrue(text.contains("https://"))
        }
    }

    func testCentrifugoConnectionTokenCarriesMemberAndWorkspaceClaims() async throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let memberID = UUID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let jwt = await JWTService(config: testServerConfig(centConnectionTokenTTL: 120))

        let issued = try await jwt.signCentrifugoConnection(
            memberID: memberID,
            workspaceID: workspaceID
        )
        let payload = try await jwt.verifyCentrifugoConnection(issued.token)
        let info = try JSONDecoder().decode(RealtimeTokenInfo.self, from: Data(payload.info.utf8))

        XCTAssertEqual(issued.ttlSeconds, 120)
        XCTAssertEqual(payload.sub.value, memberID.uuidString)
        XCTAssertEqual(payload.ws, workspaceID.uuidString)
        XCTAssertEqual(info.schema, "momo.realtime.connection.v0")
        XCTAssertEqual(info.workspaceId, workspaceID.uuidString)
        XCTAssertEqual(info.memberId, memberID.uuidString)
    }

    func testExpiredAppAccessTokenCannotBackRealtimeTokenFlow() async throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let memberID = UUID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let jwt = await JWTService(config: testServerConfig(accessTokenTTL: -60))
        let expired = try await jwt.signAccess(
            memberID: memberID,
            workspaceID: workspaceID,
            scopes: ["messages:read"]
        )

        do {
            _ = try await jwt.verify(expired)
            XCTFail("expired app access token should be rejected before realtime token issue")
        } catch {
            // Expected: JWTKit rejects the expired access token.
        }
    }

    func testRealtimeTokenResponseEncodesClientContract() throws {
        let response = RealtimeTokenResponse(
            token: "jwt",
            tokenType: "centrifugo.connection.jwt",
            expiresAtMs: 1_782_463_260_000,
            ttlSeconds: 300,
            workspaceId: "00000000-0000-7000-8000-000000000001",
            memberId: "00000000-0000-7000-8000-000000000101"
        )

        let object = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(response)
        ) as? [String: Any]

        XCTAssertEqual(object?["token"] as? String, "jwt")
        XCTAssertEqual(object?["tokenType"] as? String, "centrifugo.connection.jwt")
        XCTAssertEqual(object?["expiresAtMs"] as? Int, 1_782_463_260_000)
        XCTAssertEqual(object?["ttlSeconds"] as? Int, 300)
        XCTAssertEqual(object?["workspaceId"] as? String, "00000000-0000-7000-8000-000000000001")
        XCTAssertEqual(object?["memberId"] as? String, "00000000-0000-7000-8000-000000000101")
    }

    func testRosterKindFilterValidation() throws {
        XCTAssertNil(try RosterRoutes.validatedKindFilter(nil))
        XCTAssertNil(try RosterRoutes.validatedKindFilter("   "))
        XCTAssertEqual(try RosterRoutes.validatedKindFilter(" HUMAN "), "human")
        XCTAssertEqual(try RosterRoutes.validatedKindFilter("agent"), "agent")
        XCTAssertThrowsError(try RosterRoutes.validatedKindFilter("bot"))
        XCTAssertThrowsError(try RosterRoutes.validatedKindFilter("platform"))
    }

    func testRosterLimitIsBoundedForV0() {
        XCTAssertEqual(RosterRoutes.validatedLimit(nil), 200)
        XCTAssertEqual(RosterRoutes.validatedLimit("0"), 1)
        XCTAssertEqual(RosterRoutes.validatedLimit("50"), 50)
        XCTAssertEqual(RosterRoutes.validatedLimit("1000"), 500)
        XCTAssertEqual(RosterRoutes.validatedLimit("not-a-number"), 200)
    }

    func testRosterMemberDTODecodesHumanAndAgentShapes() throws {
        let data = Data("""
        [
          {
            "id": "00000000-0000-7000-8000-000000000101",
            "workspaceId": "00000000-0000-7000-8000-000000000001",
            "kind": "human",
            "status": "active",
            "displayName": "Demo Human",
            "handle": "demo",
            "avatarUrl": null,
            "role": "owner",
            "channelCount": 2,
            "email": "demo@momo.local",
            "timeZone": "Asia/Seoul",
            "agentModel": null,
            "ownerHumanId": null,
            "maxConcurrentRuns": null,
            "maxRunSteps": null,
            "createdAtMs": 1782463260000,
            "updatedAtMs": 1782463260000
          },
          {
            "id": "00000000-0000-7000-8000-000000000102",
            "workspaceId": "00000000-0000-7000-8000-000000000001",
            "kind": "agent",
            "status": "active",
            "displayName": "Kim Intern",
            "handle": "kim-intern",
            "avatarUrl": null,
            "role": "member",
            "channelCount": 2,
            "email": null,
            "timeZone": null,
            "agentModel": "hermes-agent",
            "ownerHumanId": "00000000-0000-7000-8000-000000000101",
            "maxConcurrentRuns": 1,
            "maxRunSteps": 12,
            "createdAtMs": 1782463260000,
            "updatedAtMs": 1782463260000
          }
        ]
        """.utf8)

        let members = try JSONDecoder().decode([RosterMemberDTO].self, from: data)

        XCTAssertEqual(members.map(\.kind), ["human", "agent"])
        XCTAssertEqual(members[0].email, "demo@momo.local")
        XCTAssertNil(members[0].agentModel)
        XCTAssertEqual(members[1].agentModel, "hermes-agent")
        XCTAssertNil(members[1].email)
    }

    func testChannelLimitIsBoundedForV0() {
        XCTAssertEqual(ChannelRoutes.validatedLimit(nil), 200)
        XCTAssertEqual(ChannelRoutes.validatedLimit("0"), 1)
        XCTAssertEqual(ChannelRoutes.validatedLimit("50"), 50)
        XCTAssertEqual(ChannelRoutes.validatedLimit("1000"), 500)
        XCTAssertEqual(ChannelRoutes.validatedLimit("not-a-number"), 200)
    }

    func testWorkspaceChannelsResponseDecodesMacOSRESTShape() throws {
        let data = Data("""
        {
          "channels": [
            {
              "id": "00000000-0000-7000-8000-000000000201",
              "workspaceId": "00000000-0000-7000-8000-000000000001",
              "kind": "public",
              "name": "general",
              "topic": "팀 일반 채널",
              "dmKey": null,
              "createdBy": "00000000-0000-7000-8000-000000000101",
              "archivedAtMs": null
            },
            {
              "id": "00000000-0000-7000-8000-000000000202",
              "workspaceId": "00000000-0000-7000-8000-000000000001",
              "kind": "public",
              "name": "agent-lab",
              "topic": "에이전트 실험실",
              "dmKey": null,
              "createdBy": "00000000-0000-7000-8000-000000000101",
              "archivedAtMs": null
            }
          ]
        }
        """.utf8)

        let response = try JSONDecoder().decode(WorkspaceChannelsResponse.self, from: data)

        XCTAssertEqual(response.channels.map(\.name), ["general", "agent-lab"])
        XCTAssertEqual(response.channels.map(\.kind), ["public", "public"])
        XCTAssertEqual(response.channels.first?.createdBy, "00000000-0000-7000-8000-000000000101")
        XCTAssertNil(response.channels.first?.archivedAtMs)
    }

    func testInboundMCPToolSurfaceMatchesMOMO163() {
        let names = InboundMCPToolRegistry.tools.map(\.name)
        XCTAssertEqual(
            names,
            [.searchMessages, .fetchThread, .postMessage, .createToolCall]
        )
    }

    func testInboundMCPPoliciesRequireRLSAndExpectedScopes() {
        let policies = Dictionary(
            uniqueKeysWithValues: InboundMCPToolRegistry.tools.map { ($0.name, $0.policy) }
        )

        XCTAssertEqual(policies[.searchMessages]?.requiredScopes, [.read])
        XCTAssertEqual(policies[.fetchThread]?.requiredScopes, [.read])
        XCTAssertEqual(policies[.postMessage]?.requiredScopes, [.post])
        XCTAssertEqual(policies[.createToolCall]?.requiredScopes, [.toolPropose])

        for policy in policies.values {
            XCTAssertTrue(policy.requiresRLS)
            XCTAssertTrue(policy.requiresChannelMembership)
            XCTAssertFalse(policy.executesProviderTool)
            XCTAssertFalse(policy.auditAction.isEmpty)
        }

        XCTAssertEqual(
            policies[.postMessage]?.canonicalWritePath,
            "channel_seq_bump_message_insert_outbox_insert"
        )
        XCTAssertEqual(
            policies[.createToolCall]?.writes,
            ["message:tool_call", "approval", "message:approval_request", "outbox", "audit_log"]
        )
    }

    func testInboundMCPDiscoveryIsCodable() throws {
        let discovery = InboundMCPToolRegistry.discoveryResponse()
        let data = try JSONEncoder().encode(discovery)
        let decoded = try JSONDecoder().decode(InboundMCPDiscoveryResponse.self, from: data)

        XCTAssertEqual(decoded.schema, "momo.inbound_mcp.discovery_snapshot.v0")
        XCTAssertEqual(decoded.server.protocolVersion, "2025-06-18")
        XCTAssertTrue(decoded.server.capabilities.tools.listChanged)
        XCTAssertTrue(decoded.runtimeStatus.contains("runtime-unverified"))
    }

    func testSearchMessagesRequiresBoundedChannelIDsInDescriptor() throws {
        let descriptor = InboundMCPToolRegistry.descriptor(named: .searchMessages)
        let schema = try XCTUnwrap(descriptor.inputSchema.objectValue)
        let required = try XCTUnwrap(schema["required"]?.arrayValue)
            .compactMap(\.stringValue)
        let properties = try XCTUnwrap(schema["properties"]?.objectValue)
        let channelIDs = try XCTUnwrap(properties["channel_ids"]?.objectValue)

        XCTAssertTrue(required.contains("channel_ids"))
        XCTAssertEqual(channelIDs["maxItems"], .int(InboundMCPToolRegistry.searchMessagesMaxChannelIDs))
    }

    func testSearchMessagesChannelIDsFailClosedBeforeDBPreflight() throws {
        XCTAssertThrowsError(try InboundMCPRoutes.channelIDs(
            for: .searchMessages,
            arguments: ["workspace_id": .string("00000000-0000-7000-8000-000000000001")]
        ))

        XCTAssertThrowsError(try InboundMCPRoutes.channelIDs(
            for: .searchMessages,
            arguments: [
                "channel_ids": .array([])
            ]
        ))

        let tooMany = (0...InboundMCPToolRegistry.searchMessagesMaxChannelIDs)
            .map { JSONValue.string(String(format: "00000000-0000-7000-8000-%012d", $0)) }
        XCTAssertThrowsError(try InboundMCPRoutes.channelIDs(
            for: .searchMessages,
            arguments: [
                "channel_ids": .array(tooMany)
            ]
        ))
    }

    func testApprovalDecisionRequestDecodesMomoCoreWireShape() throws {
        let data = Data("""
        {
          "approval_id": "00000000-0000-7000-8000-000000000901",
          "approve": true,
          "reason": "  safe to run  ",
          "client_decision_id": "00000000-0000-7000-8000-000000167001"
        }
        """.utf8)

        let dto = try JSONDecoder().decode(ApprovalDecisionRequestDTO.self, from: data)

        XCTAssertEqual(dto.approvalId.uuidString.lowercased(), "00000000-0000-7000-8000-000000000901")
        XCTAssertTrue(dto.approve)
        XCTAssertEqual(dto.clientDecisionId.uuidString.lowercased(), "00000000-0000-7000-8000-000000167001")
        XCTAssertEqual(ApprovalDecisionRoutes.status(approve: dto.approve), "approved")
        XCTAssertEqual(ApprovalDecisionRoutes.normalizedReason(dto.reason), "safe to run")
    }

    func testApprovalDecisionReceiptEncodesSnakeCaseContract() throws {
        let receipt = ApprovalDecisionReceiptDTO(
            approvalId: "00000000-0000-7000-8000-000000000901",
            status: "rejected",
            decidedBy: "00000000-0000-7000-8000-000000000101",
            decidedAtMs: 1_782_463_260_000,
            decisionReason: "Do not create external state."
        )

        let object = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(receipt)
        ) as? [String: Any]

        XCTAssertEqual(object?["approval_id"] as? String, receipt.approvalId)
        XCTAssertEqual(object?["status"] as? String, "rejected")
        XCTAssertEqual(object?["decided_by"] as? String, receipt.decidedBy)
        XCTAssertEqual(object?["decided_at_ms"] as? Int, Int(receipt.decidedAtMs!))
        XCTAssertNil(object?["approvalId"])
    }

    func testCentrifugoSubscribeParserDistinguishesChannelAndAgentNamespaces() throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let channelID = UUID(uuidString: "00000000-0000-7000-8000-000000000202")!
        let agentMemberID = UUID(uuidString: "00000000-0000-7000-8000-000000000102")!

        XCTAssertEqual(
            CentrifugoRoutes.parseChannel("ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"),
            .channel(workspace: workspaceID, channel: channelID)
        )
        XCTAssertEqual(
            CentrifugoRoutes.parseChannel("agent:ws\(workspaceID.uuidString).\(agentMemberID.uuidString)"),
            .agent(workspace: workspaceID, agentMember: agentMemberID)
        )
        XCTAssertNil(CentrifugoRoutes.parseChannel("user:\(agentMemberID.uuidString)"))
        XCTAssertNil(CentrifugoRoutes.parseChannel("agent:ws\(workspaceID.uuidString).not-a-uuid"))
    }

    func testApprovalDecisionRouteRejectsMismatchedBodyApprovalID() throws {
        let pathID = UUID(uuidString: "00000000-0000-7000-8000-000000000901")!
        let bodyID = UUID(uuidString: "00000000-0000-7000-8000-000000000902")!

        XCTAssertThrowsError(
            try ApprovalDecisionRoutes.validateBodyApprovalID(bodyID, pathApprovalID: pathID)
        )
        XCTAssertNoThrow(
            try ApprovalDecisionRoutes.validateBodyApprovalID(pathID, pathApprovalID: pathID)
        )
    }

    func testApprovalProjectionDTOEncodesPendingInboxContract() throws {
        let projection = ApprovalProjectionPageDTO(approvals: [
            ApprovalProjectionDTO(
                id: "00000000-0000-7000-8000-000000000901",
                workspaceId: "00000000-0000-7000-8000-000000000001",
                runId: "00000000-0000-7000-8000-000000000801",
                channelId: "00000000-0000-7000-8000-000000000201",
                requestMessageId: "00000000-0000-7000-8000-000000000701",
                requestedBy: "00000000-0000-7000-8000-000000000102",
                onBehalfOf: "00000000-0000-7000-8000-000000000101",
                actionType: "github.issue.create",
                payload: .object(["title": .string("Ship gated write")]),
                status: "pending",
                estimatedMicroUSD: 820_000,
                isReversible: true,
                decidedBy: nil,
                decidedAtMs: nil,
                decisionReason: nil,
                expiresAtMs: 1_782_463_260_000
            )
        ])

        let object = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(projection)
        ) as? [String: Any]
        let approvals = try XCTUnwrap(object?["approvals"] as? [[String: Any]])
        let first = try XCTUnwrap(approvals.first)

        XCTAssertEqual(first["approval_id"] as? String, nil)
        XCTAssertEqual(first["id"] as? String, "00000000-0000-7000-8000-000000000901")
        XCTAssertEqual(first["workspace_id"] as? String, "00000000-0000-7000-8000-000000000001")
        XCTAssertEqual(first["action_type"] as? String, "github.issue.create")
        XCTAssertEqual(first["status"] as? String, "pending")
        XCTAssertEqual(first["estimated_micro_usd"] as? Int, 820_000)
        XCTAssertEqual(first["is_reversible"] as? Bool, true)
        XCTAssertNil(first["workspaceId"])
    }

    func testApprovalProjectionStatusAndLimitValidation() throws {
        XCTAssertEqual(try ApprovalDecisionRoutes.validatedStatus(nil), "pending")
        XCTAssertEqual(try ApprovalDecisionRoutes.validatedStatus(" pending "), "pending")
        XCTAssertEqual(try ApprovalDecisionRoutes.validatedStatus("rejected"), "rejected")
        XCTAssertThrowsError(try ApprovalDecisionRoutes.validatedStatus("all"))

        XCTAssertEqual(ApprovalDecisionRoutes.validatedLimit(nil), 100)
        XCTAssertEqual(ApprovalDecisionRoutes.validatedLimit("0"), 1)
        XCTAssertEqual(ApprovalDecisionRoutes.validatedLimit("501"), 500)
    }

    func testMessageBroadcastPayloadUsesRealtimeSnakeCaseContract() throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let channelID = UUID(uuidString: "00000000-0000-7000-8000-000000000010")!
        let messageID = UUID(uuidString: "00000000-0000-7000-8000-000000000179")!
        let authorID = UUID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let centChannel = "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"

        let raw = MessageRoutes.broadcastPayload(
            centChannel: centChannel,
            messageID: messageID,
            channelID: channelID,
            seq: 43,
            type: "text",
            body: "Realtime contract sample.",
            authorMemberID: authorID,
            hlcTs: 1_782_463_260_000,
            hlcCount: 0
        )

        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
        )
        XCTAssertEqual(object["channel"] as? String, centChannel)
        XCTAssertEqual(object["version"] as? Int, 43)
        XCTAssertEqual(object["idempotency_key"] as? String, "\(centChannel):43")

        let data = try XCTUnwrap(object["data"] as? [String: Any])
        XCTAssertEqual(data["type"] as? String, "message.new")
        XCTAssertEqual(data["seq"] as? Int, 43)

        let payload = try XCTUnwrap(data["payload"] as? [String: Any])
        XCTAssertEqual(payload["channel_id"] as? String, channelID.uuidString)
        XCTAssertEqual(payload["author_member_id"] as? String, authorID.uuidString)
        XCTAssertEqual(payload["hlc_ts"] as? Int, 1_782_463_260_000)
        XCTAssertEqual(payload["hlc_count"] as? Int, 0)
        XCTAssertNil(payload["channelId"])
        XCTAssertNil(payload["authorMemberId"])
        XCTAssertNil(payload["hlcTs"])
        XCTAssertNil(payload["hlcCount"])
    }

    func testAgentMentionDetectionSupportsDisplayNameHandleAndMemberID() {
        let agentID = UUID(uuidString: "00000000-0000-7000-8000-000000000102")!

        XCTAssertTrue(MessageRoutes.containsAgentMention(
            "@김인턴 런타임 확인해줘",
            handle: "kim-intern",
            displayName: "김인턴",
            memberID: agentID
        ))
        XCTAssertTrue(MessageRoutes.containsAgentMention(
            "Can @KIM-INTERN check this?",
            handle: "kim-intern",
            displayName: "김인턴",
            memberID: agentID
        ))
        XCTAssertTrue(MessageRoutes.containsAgentMention(
            "<@00000000-0000-7000-8000-000000000102> please respond",
            handle: "kim-intern",
            displayName: "김인턴",
            memberID: agentID
        ))
        XCTAssertFalse(MessageRoutes.containsAgentMention(
            "@kim-internship is a different token",
            handle: "kim-intern",
            displayName: "김인턴",
            memberID: agentID
        ))
        XCTAssertFalse(MessageRoutes.containsAgentMention(
            "No agent mention here",
            handle: "kim-intern",
            displayName: "김인턴",
            memberID: agentID
        ))
    }

    func testCostSnapshotDTOEncodesSnakeCaseProjectionContract() throws {
        let snapshot = CostSnapshotDTO(
            runId: "00000000-0000-7000-8000-000000000904",
            reservedMicroUSD: 0,
            spentMicroUSD: 6,
            softLimitMicroUSD: 900_000,
            hardLimitMicroUSD: 1_000_000,
            isReconciled: true,
            wasEstimated: false,
            limitState: "normal"
        )
        let page = CostSnapshotPageDTO(
            schema: "momo.cost_snapshot.channel.v0",
            channelId: "00000000-0000-7000-8000-000000000202",
            snapshots: [snapshot],
            asOfMs: 1_782_463_260_000
        )

        let object = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(page)
        ) as? [String: Any]
        let snapshots = object?["snapshots"] as? [[String: Any]]
        let item = snapshots?.first

        XCTAssertEqual(object?["channel_id"] as? String, page.channelId)
        XCTAssertEqual(item?["run_id"] as? String, snapshot.runId)
        XCTAssertEqual(item?["reserved_micro_usd"] as? Int, 0)
        XCTAssertEqual(item?["spent_micro_usd"] as? Int, 6)
        XCTAssertEqual(item?["soft_limit_micro_usd"] as? Int, 900_000)
        XCTAssertEqual(item?["hard_limit_micro_usd"] as? Int, 1_000_000)
        XCTAssertEqual(item?["is_reconciled"] as? Bool, true)
        XCTAssertEqual(item?["was_estimated"] as? Bool, false)
        XCTAssertEqual(item?["limit_state"] as? String, "normal")
        XCTAssertNil(item?["reservedMicroUSD"])
    }

    func testCostProjectionLimitStateHelper() {
        XCTAssertEqual(
            CostProjectionRoutes.limitState(
                observedMicroUSD: 10,
                softLimitMicroUSD: 20,
                hardLimitMicroUSD: 30
            ),
            "normal"
        )
        XCTAssertEqual(
            CostProjectionRoutes.limitState(
                observedMicroUSD: 25,
                softLimitMicroUSD: 20,
                hardLimitMicroUSD: 30
            ),
            "soft_limit"
        )
        XCTAssertEqual(
            CostProjectionRoutes.limitState(
                observedMicroUSD: 30,
                softLimitMicroUSD: 20,
                hardLimitMicroUSD: 30
            ),
            "hard_limit"
        )
    }

    private func testServerConfig(
        accessTokenTTL: TimeInterval = 15 * 60,
        centConnectionTokenTTL: TimeInterval = 5 * 60
    ) -> Config {
        Config(
            host: "127.0.0.1",
            port: 8080,
            pgHost: "localhost",
            pgPort: 5432,
            pgUser: "momo",
            pgPassword: "momo",
            pgDatabase: "momo",
            jwtHMAC: "test-jwt-hmac",
            accessTokenTTL: accessTokenTTL,
            refreshTokenTTL: 30 * 24 * 60 * 60,
            centAPIURL: "http://localhost:8000/api",
            centAPIKey: "test-cent-api-key",
            centTokenHMAC: "test-cent-token-hmac",
            centConnectionTokenTTL: centConnectionTokenTTL,
            platformAdminDatabaseURL: nil,
            platformAdminEmails: [],
            platformAdminLoginSecret: nil,
            momoEnvironment: "local",
            agentProvider: AgentProviderConfig(
                mode: .localMock,
                hermesBaseURL: "http://localhost:8088/v1",
                hermesAPIKey: "dev-insecure-hermes-bearer",
                model: "hermes-agent",
                agentHandle: "kim-intern",
                displayName: "김인턴",
                allowLocalLoopback: false
            )
        )
    }
}
