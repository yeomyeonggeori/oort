import XCTest
@testable import AgentWorker

final class AgentWorkerTests: XCTestCase {
    func testMicroUSDPricingUsesIntegerRounding() {
        XCTAssertEqual(
            CostAccounting.microUSD(tokens: 64, unitPriceText: "0.600000", rounding: .up),
            39
        )
        XCTAssertEqual(
            CostAccounting.microUSD(tokens: 64, unitPriceText: "0.600000", rounding: .plain),
            38
        )
    }

    func testUsageCostUsesAllTokenBuckets() {
        let pricing = CostAccounting.Pricing(
            input: "0.150000",
            output: "0.600000",
            cacheRead: "0.015000",
            reasoning: "0.600000"
        )

        XCTAssertEqual(
            CostAccounting.usageCostMicroUSD(
                promptTokens: 11,
                completionTokens: 7,
                cachedTokens: 0,
                reasoningTokens: 0,
                pricing: pricing
            ),
            6
        )
    }

    func testCachedPromptTokensAreNotDoubleCharged() {
        let pricing = CostAccounting.Pricing(
            input: "0.150000",
            output: "0.600000",
            cacheRead: "0.015000",
            reasoning: "0.600000"
        )

        XCTAssertEqual(
            CostAccounting.usageCostMicroUSD(
                promptTokens: 110,
                completionTokens: 7,
                cachedTokens: 100,
                reasoningTokens: 0,
                pricing: pricing
            ),
            8
        )
    }

    func testLoopGuardDefaultsProceedForFreshRunAndHaltAtCaps() {
        let config = Config(
            pgHost: "localhost",
            pgPort: 5432,
            pgUser: "momo_worker",
            pgPassword: "dev",
            pgDatabase: "momo",
            centAPIURL: "http://localhost:8000/api",
            centAPIKey: "dev",
            momoEnvironment: "local",
            agentProviderMode: .localMock,
            hermesBaseURL: "http://localhost:8088/v1",
            hermesAPIKey: "dev",
            agentModel: "hermes-agent",
            pollInterval: .milliseconds(300),
            maxAttempts: 3,
            maxConsecutiveAuto: 3,
            maxSteps: 12,
            maxDepth: 4,
            maxConcurrentRuns: 1
        )
        let guards = LoopGuards(config: config, logger: .init(label: "test.loop-guards"))

        XCTAssertEqual(
            guards.evaluatePreInvoke(.init(
                stepCount: 0,
                depth: 0,
                consecutiveAuto: 0,
                activeRunsForAgent: 0,
                lastContentHash: nil
            )),
            .proceed
        )

        XCTAssertEqual(
            guards.evaluatePreInvoke(.init(
                stepCount: 12,
                depth: 0,
                consecutiveAuto: 0,
                activeRunsForAgent: 0,
                lastContentHash: nil
            )),
            .halt(reason: "G3 step cap (max_steps=12)")
        )
    }

    func testStrictProviderConfigRejectsMockOrPlaceholderHermes() {
        var config = testConfig()
        config.momoEnvironment = "staging"
        config.agentProviderMode = .internalHostMock
        config.hermesBaseURL = "http://mock-hermes:8088/v1"
        config.hermesAPIKey = "change-me-hermes-bearer"

        XCTAssertThrowsError(try config.validateAgentProviderForBoot()) { error in
            let text = String(describing: error)
            XCTAssertTrue(text.contains("external-hermes"))
            XCTAssertTrue(text.contains("HERMES_BASE_URL"))
            XCTAssertTrue(text.contains("HERMES_API_KEY"))
            XCTAssertFalse(text.contains("change-me-hermes-bearer"))
        }
    }

    func testExternalProviderConfigAcceptsHTTPSAndRedactsEndpointLabel() throws {
        var config = testConfig()
        config.momoEnvironment = "internal-host"
        config.agentProviderMode = .externalHermes
        config.hermesBaseURL = "https://operator:secret@kim.example.net/v1?token=hidden"
        config.hermesAPIKey = "sk-live-valid-runtime-key-123456"

        XCTAssertNoThrow(try config.validateAgentProviderForBoot())
        XCTAssertEqual(config.agentAvailability, "available")
        XCTAssertEqual(config.agentProviderEndpointLabel, "https://kim.example.net/v1")
        XCTAssertFalse(config.agentProviderEndpointLabel.contains("secret"))
        XCTAssertFalse(config.agentProviderEndpointLabel.contains("hidden"))
    }

    func testAgentJobPayloadDecodesContextPacketToolGrants() throws {
        let payloadJSON = """
        {
          "run_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001",
          "agent_member_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001",
          "channel_id": "cccccccc-cccc-4ccc-8ccc-cccccccc0001",
          "workspace_id": "dddddddd-dddd-4ddd-8ddd-dddddddd0001",
          "author_member_id": "eeeeeeee-eeee-4eee-8eee-eeeeeeee0002",
          "trigger_message_id": "eeeeeeee-eeee-4eee-8eee-eeeeeeee0003",
          "trigger_message_seq": 42,
          "model": "hermes-agent",
          "prompt": "create an issue",
          "source_attribution": {
            "kind": "message",
            "message_id": "eeeeeeee-eeee-4eee-8eee-eeeeeeee0003",
            "message_seq": 42,
            "permission_snapshot": "actor:channel_member agent:channel_member"
          },
          "context_packet_projection": {
            "schema": "momo.context_packet.tool_grants_projection.v0",
            "packet_id": "eeeeeeee-eeee-4eee-8eee-eeeeeeee0001",
            "tool_grants": [
              {
                "tool_name": "github.create_issue",
                "provider": "github",
                "grant": "propose",
                "risk": "write",
                "approval_policy": "always",
                "allowed_operations": ["create_issue"],
                "denied_operations": ["delete_repo"],
                "input_schema_ref": "momo://capability-cache/github.create_issue/schemas/input/sha256:githubcreateissuev3",
                "resource_scope_summary": "repository_allowlist:Dawn-kim-official/momo",
                "capability_version": "github-plugin@0.3.0",
                "policy_version": "capability-policy@2026-06-26",
                "cache_entry_id": "60000000-0000-7000-8000-000000000010",
                "projection_audit_event_id": "audit_capability_022"
              }
            ]
          }
        }
        """

        let payload = try JSONDecoder().decode(
            AgentJobPayload.self,
            from: Data(payloadJSON.utf8)
        )

        let grant = try XCTUnwrap(payload.toolGrant(for: "github.create_issue"))
        XCTAssertEqual(grant.toolName, "github.create_issue")
        XCTAssertEqual(grant.effectiveRiskLevel, "write")
        XCTAssertEqual(grant.approvalPolicy, "always")
        XCTAssertEqual(grant.resourceScopeSummary, "repository_allowlist:Dawn-kim-official/momo")
        XCTAssertEqual(payload.authorMemberID?.uuidString, "EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEE0002")
        XCTAssertEqual(payload.triggerMessageID?.uuidString, "EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEE0003")
        XCTAssertEqual(payload.triggerMessageSeq, 42)
        XCTAssertEqual(payload.sourceAttribution?["kind"]?.stringValue, "message")
        XCTAssertEqual(payload.sourceAttribution?["permission_snapshot"]?.stringValue, "actor:channel_member agent:channel_member")
    }

    func testApprovalPolicyRequiresApprovalFromToolGrantMetadata() {
        let guards = LoopGuards(config: testConfig(), logger: .init(label: "test.approval-policy"))
        let grants = [
            ToolGrantMetadata(
                toolName: "github.create_issue",
                provider: "github",
                grant: "propose",
                risk: "write",
                approvalPolicy: "require_approval"
            )
        ]

        XCTAssertTrue(guards.requiresApproval(toolName: "github.create_issue", toolGrants: grants))
    }

    func testApprovalPolicyAllowsExplicitNeverPolicy() {
        let guards = LoopGuards(config: testConfig(), logger: .init(label: "test.approval-policy"))
        let grants = [
            ToolGrantMetadata(
                toolName: "docs.fetch_excerpt",
                provider: "docs",
                grant: "read",
                riskLevel: "read",
                approvalPolicy: "never"
            )
        ]

        XCTAssertFalse(guards.requiresApproval(toolName: "docs.fetch_excerpt", toolGrants: grants))
    }

    func testApprovalPolicyNeverFailsClosedForNonReadGrant() {
        let guards = LoopGuards(config: testConfig(), logger: .init(label: "test.approval-policy"))
        let grants = [
            ToolGrantMetadata(
                toolName: "github.create_issue",
                provider: "github",
                grant: "propose",
                risk: "write",
                approvalPolicy: "never"
            )
        ]

        XCTAssertTrue(guards.requiresApproval(toolName: "github.create_issue", toolGrants: grants))
    }

    func testApprovalPolicyAllowsReadOnlyToolGrant() {
        let guards = LoopGuards(config: testConfig(), logger: .init(label: "test.approval-policy"))
        let grants = [
            ToolGrantMetadata(
                toolName: "obsidian.search_notes",
                provider: "obsidian",
                grant: "read",
                risk: "read",
                approvalPolicy: "none"
            )
        ]

        XCTAssertFalse(guards.requiresApproval(toolName: "obsidian.search_notes", toolGrants: grants))
    }

    func testApprovalPolicyFailsClosedForMissingOrAmbiguousMetadata() {
        let guards = LoopGuards(config: testConfig(), logger: .init(label: "test.approval-policy"))
        let readOnlyGrant = ToolGrantMetadata(
            toolName: "docs.search",
            grant: "read",
            risk: "read",
            approvalPolicy: "none"
        )
        let duplicateGrants = [readOnlyGrant, readOnlyGrant]

        XCTAssertTrue(guards.requiresApproval(toolName: "docs.search", toolGrants: nil))
        XCTAssertTrue(guards.requiresApproval(toolName: "docs.search", toolGrants: []))
        XCTAssertTrue(guards.requiresApproval(toolName: "github.create_issue", toolGrants: [readOnlyGrant]))
        XCTAssertTrue(guards.requiresApproval(toolName: "docs.search", toolGrants: duplicateGrants))
        XCTAssertTrue(guards.requiresApproval(
            toolName: "docs.search",
            toolGrants: [ToolGrantMetadata(toolName: "docs.search", grant: "read", risk: "read")]
        ))
    }

    func testAgentJobPayloadRejectsConflictingToolGrantSources() throws {
        let payloadJSON = """
        {
          "agent_member_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001",
          "channel_id": "cccccccc-cccc-4ccc-8ccc-cccccccc0001",
          "model": "hermes-agent",
          "prompt": "search docs",
          "tool_grants": [
            {
              "tool_name": "docs.search",
              "grant": "read",
              "risk": "read",
              "approval_policy": "none",
              "policy_version": "capability-policy@safe"
            }
          ],
          "context_packet": {
            "tool_grants": [
              {
                "tool_name": "docs.search",
                "grant": "read",
                "risk": "write",
                "approval_policy": "never",
                "policy_version": "capability-policy@stale"
              }
            ]
          }
        }
        """

        let payload = try JSONDecoder().decode(
            AgentJobPayload.self,
            from: Data(payloadJSON.utf8)
        )
        let guards = LoopGuards(config: testConfig(), logger: .init(label: "test.approval-policy"))

        XCTAssertNil(payload.toolGrants)
        XCTAssertTrue(guards.requiresApproval(toolName: "docs.search", toolGrants: payload.toolGrants))
    }

    func testApprovalPolicyFailsClosedForConflictingRiskAliases() {
        let guards = LoopGuards(config: testConfig(), logger: .init(label: "test.approval-policy"))
        let grants = [
            ToolGrantMetadata(
                toolName: "docs.search",
                grant: "read",
                risk: "write",
                riskLevel: "read",
                approvalPolicy: "none"
            )
        ]

        XCTAssertTrue(guards.requiresApproval(toolName: "docs.search", toolGrants: grants))
    }

    func testLegacyApprovalFallbackRequiresApprovalForWriteLikeToolNames() {
        let guards = LoopGuards(config: testConfig(), logger: .init(label: "test.approval-policy"))

        XCTAssertTrue(guards.requiresApproval(toolName: "github.create_issue"))
        XCTAssertTrue(guards.requiresApproval(toolName: "jira.transition_issue"))
        XCTAssertTrue(guards.requiresApproval(toolName: "deploy"))
        XCTAssertTrue(guards.requiresApproval(toolName: "unknown.custom_action"))
        XCTAssertTrue(guards.requiresApproval(toolName: ""))
    }

    func testLegacyApprovalFallbackAllowsKnownReadOnlyToolNames() {
        let guards = LoopGuards(config: testConfig(), logger: .init(label: "test.approval-policy"))

        XCTAssertFalse(guards.requiresApproval(toolName: "github.search_issues"))
        XCTAssertFalse(guards.requiresApproval(toolName: "docs.search"))
        XCTAssertFalse(guards.requiresApproval(toolName: "fetch_source_excerpt"))
    }

    func testApprovalPausePlanUsesDurableCheckpointRecords() {
        let toolCall = ApprovalRuntime.ToolCall(
            callID: "call_001",
            name: "github.create_issue",
            arguments: #"{"repo":"Dawn-kim-official/momo","title":"demo"}"#
        )

        let plan = ApprovalRuntime.pausePlan(for: toolCall)

        XCTAssertEqual(plan.runStatus, .awaitingApproval)
        XCTAssertEqual(plan.approvalStatus, "pending")
        XCTAssertEqual(plan.messageType, "approval_request")
        XCTAssertEqual(plan.auditAction, "approval.requested")
        XCTAssertEqual(plan.actionType, "tool_call")
        XCTAssertEqual(plan.toolCall, toolCall)
    }

    func testApprovalDecisionOutcomesResumeOrTerminateSameRun() {
        XCTAssertEqual(
            ApprovalRuntime.outcome(for: .approved),
            .resumeSameRun(nextStatus: .queued)
        )

        XCTAssertEqual(
            ApprovalRuntime.outcome(for: .rejected),
            .terminateRun(finalStatus: .cancelled, auditAction: "approval.rejected")
        )

        XCTAssertEqual(
            ApprovalRuntime.outcome(for: .expired),
            .terminateRun(finalStatus: .timedOut, auditAction: "approval.expired")
        )
    }

    func testResumeApprovalJobPayloadDecodesServerContract() throws {
        let json = """
        {
          "run_id": "00000000-0000-7000-8000-000000000161",
          "workspace_id": "00000000-0000-7000-8000-000000000001",
          "channel_id": "00000000-0000-7000-8000-000000000010",
          "agent_member_id": "00000000-0000-7000-8000-000000000101",
          "model": "hermes-agent",
          "prompt": "",
          "resume_from_approval_id": "00000000-0000-7000-8000-000000000901",
          "approved_tool_call": {
            "call_id": "call_create_issue_001",
            "name": "github.create_issue",
            "arguments": {
              "repo": "Dawn-kim-official/momo",
              "title": "Demo issue"
            },
            "payload_sha256": "sha256:fixture-approved-payload"
          },
          "policy_evidence": {
            "tool_name": "github.create_issue",
            "approval_policy": "always",
            "capability_version": "github-plugin@0.3.0",
            "policy_version": "capability-policy@2026-06-26"
          },
          "approval_decision": {
            "approval_id": "00000000-0000-7000-8000-000000000901",
            "status": "approved"
          }
        }
        """

        let payload = try JSONDecoder().decode(AgentJobPayload.self, from: Data(json.utf8))

        XCTAssertEqual(payload.resumeFromApprovalID?.uuidString.lowercased(), "00000000-0000-7000-8000-000000000901")
        XCTAssertEqual(payload.approvedToolCall?.callID, "call_create_issue_001")
        XCTAssertEqual(payload.approvedToolCall?.name, "github.create_issue")
        XCTAssertEqual(payload.approvedToolCall?.payloadSHA256, "sha256:fixture-approved-payload")
        XCTAssertEqual(payload.policyEvidence?.approvalPolicy, "always")
        XCTAssertNotNil(payload.approvalDecision)
    }

    func testResumeApprovalExecutorRunsOnlyDeterministicMockTool() throws {
        let payload = try resumePayload(
            toolName: "momo.mock.echo",
            policyToolName: "momo.mock.echo",
            approvalStatus: "approved"
        )
        let executor = ToolResumeExecutor()

        let request = try executor.validate(payload)
        let result = try executor.execute(request)

        XCTAssertFalse(result.isError)
        XCTAssertEqual(result.body, "Deterministic tool executed: momo.mock.echo")
        XCTAssertEqual(result.output["ok"]?.boolValue, true)
        XCTAssertEqual(result.output["tool_name"]?.stringValue, "momo.mock.echo")
    }

    func testResumeApprovalExecutorFailsClosedWithoutPolicyEvidence() throws {
        let json = """
        {
          "run_id": "00000000-0000-7000-8000-000000000161",
          "workspace_id": "00000000-0000-7000-8000-000000000001",
          "channel_id": "00000000-0000-7000-8000-000000000010",
          "agent_member_id": "00000000-0000-7000-8000-000000000101",
          "model": "hermes-agent",
          "prompt": "",
          "resume_from_approval_id": "00000000-0000-7000-8000-000000000901",
          "approved_tool_call": {
            "call_id": "call_echo_001",
            "name": "momo.mock.echo",
            "arguments": {"message": "hello"},
            "payload_sha256": "sha256:00000000-0000-7000-8000-000000000901"
          },
          "approval_decision": {
            "approval_id": "00000000-0000-7000-8000-000000000901",
            "status": "approved"
          }
        }
        """
        let payload = try JSONDecoder().decode(AgentJobPayload.self, from: Data(json.utf8))

        XCTAssertThrowsError(try ToolResumeExecutor().validate(payload)) { error in
            XCTAssertEqual(error as? ToolResumeExecutor.Failure, .missingPolicyEvidence)
        }
    }

    func testResumeApprovalExecutorRejectsNonApprovedDecision() throws {
        let payload = try resumePayload(
            toolName: "momo.mock.echo",
            policyToolName: "momo.mock.echo",
            approvalStatus: "rejected"
        )

        XCTAssertThrowsError(try ToolResumeExecutor().validate(payload)) { error in
            XCTAssertEqual(
                error as? ToolResumeExecutor.Failure,
                .decisionNotApproved("rejected")
            )
        }
    }

    func testResumeApprovalExecutorRejectsPolicyToolMismatch() throws {
        let payload = try resumePayload(
            toolName: "momo.mock.echo",
            policyToolName: "github.create_issue",
            approvalStatus: "approved"
        )

        XCTAssertThrowsError(try ToolResumeExecutor().validate(payload)) { error in
            XCTAssertEqual(
                error as? ToolResumeExecutor.Failure,
                .policyToolMismatch(expected: "momo.mock.echo", actual: "github.create_issue")
            )
        }
    }

    func testResumeApprovalExecutorRejectsExternalToolInV0() throws {
        let payload = try resumePayload(
            toolName: "github.create_issue",
            policyToolName: "github.create_issue",
            approvalStatus: "approved"
        )
        let executor = ToolResumeExecutor()
        let request = try executor.validate(payload)

        XCTAssertThrowsError(try executor.execute(request)) { error in
            XCTAssertEqual(
                error as? ToolResumeExecutor.Failure,
                .unsupportedTool("github.create_issue")
            )
        }
    }

    private func testConfig() -> Config {
        Config(
            pgHost: "localhost",
            pgPort: 5432,
            pgUser: "momo_worker",
            pgPassword: "dev",
            pgDatabase: "momo",
            centAPIURL: "http://localhost:8000/api",
            centAPIKey: "dev",
            momoEnvironment: "local",
            agentProviderMode: .localMock,
            hermesBaseURL: "http://localhost:8088/v1",
            hermesAPIKey: "dev",
            agentModel: "hermes-agent",
            pollInterval: .milliseconds(300),
            maxAttempts: 3,
            maxConsecutiveAuto: 3,
            maxSteps: 12,
            maxDepth: 4,
            maxConcurrentRuns: 1
        )
    }

    private func resumePayload(
        toolName: String,
        policyToolName: String,
        approvalStatus: String
    ) throws -> AgentJobPayload {
        let json = """
        {
          "run_id": "00000000-0000-7000-8000-000000000161",
          "workspace_id": "00000000-0000-7000-8000-000000000001",
          "channel_id": "00000000-0000-7000-8000-000000000010",
          "agent_member_id": "00000000-0000-7000-8000-000000000101",
          "model": "hermes-agent",
          "prompt": "",
          "resume_from_approval_id": "00000000-0000-7000-8000-000000000901",
          "approved_tool_call": {
            "call_id": "call_echo_001",
            "name": "\(toolName)",
            "arguments": {"message": "hello"},
            "payload_sha256": "sha256:00000000-0000-7000-8000-000000000901"
          },
          "policy_evidence": {
            "tool_name": "\(policyToolName)",
            "approval_policy": "always",
            "capability_version": "mock-tool@0.1.0",
            "policy_version": "capability-policy@2026-06-29"
          },
          "approval_decision": {
            "approval_id": "00000000-0000-7000-8000-000000000901",
            "status": "\(approvalStatus)"
          }
        }
        """
        return try JSONDecoder().decode(AgentJobPayload.self, from: Data(json.utf8))
    }
}
