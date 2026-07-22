import Foundation
import XCTest
@testable import AgentWorker

final class AgentWorkerTests: XCTestCase {
    func testHumanCancellationGuardsExecutionResumeAndFinalCommit() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/AgentWorker/WorkerService.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        XCTAssertGreaterThanOrEqual(
            source.components(separatedBy: "isRunCancelled(").count - 1,
            5,
            "DB cancellation must be consumed before execution, during SSE, resume, and commit"
        )
        XCTAssertTrue(source.contains("FOR UPDATE"))
        XCTAssertTrue(source.contains("status <> 'cancelled'"))
        XCTAssertTrue(source.contains("cancelled run final message suppressed"))
    }

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

    func testDBGateSnapshotVerdictsCoverAllGates() {
        let guards = LoopGuards(config: testConfig(), logger: .init(label: "test.db-gates"))
        // Defaults from testConfig: maxConsecutiveAuto=3, maxSteps=12, maxDepth=4.
        func snapshot(
            stepCount: Int = 0,
            runMaxSteps: Int = 12,
            depth: Int = 0,
            streak: Int = 0,
            activeOthers: Int = 0,
            maxConcurrent: Int = 1
        ) -> LoopGuards.DBGateSnapshot {
            .init(
                runStatus: "queued",
                stepCount: stepCount,
                runMaxSteps: runMaxSteps,
                depth: depth,
                roundCount: 0,
                consecutiveAutoStreak: streak,
                activeOtherRuns: activeOthers,
                maxConcurrentRuns: maxConcurrent
            )
        }

        XCTAssertEqual(guards.evaluateSnapshot(snapshot()), .proceed)
        XCTAssertEqual(
            guards.evaluateSnapshot(snapshot(activeOthers: 1)),
            .tripped(
                gate: "G1",
                reason: "G1 concurrency cap: 1 other running run(s) for this agent (max_concurrent_runs=1)"))
        XCTAssertEqual(
            guards.evaluateSnapshot(snapshot(streak: 3)),
            .tripped(
                gate: "G2",
                reason: "G2 consecutive auto cap: 3 consecutive auto replies by this agent since the last human message (MAX_CONSECUTIVE_AUTO=3)"))
        XCTAssertEqual(
            guards.evaluateSnapshot(snapshot(stepCount: 12)),
            .tripped(gate: "G3", reason: "G3 step cap: step_count=12 (max_steps=12)"))
        // The run's own max_steps tightens below the env cap.
        XCTAssertEqual(
            guards.evaluateSnapshot(snapshot(stepCount: 5, runMaxSteps: 5)),
            .tripped(gate: "G3", reason: "G3 step cap: step_count=5 (max_steps=5)"))
        // §3.4: depth == MAX_DEPTH is still valid ("초과 시 차단"), depth > trips
        // under the durable a2a_depth label (§3.3 canonical G4 = SimHash).
        XCTAssertEqual(guards.evaluateSnapshot(snapshot(depth: 4)), .proceed)
        XCTAssertEqual(
            guards.evaluateSnapshot(snapshot(depth: 5)),
            .tripped(gate: "a2a_depth", reason: "a2a_depth cap: depth=5 exceeds MAX_DEPTH=4"))
        // Higher agent-owned concurrency cap admits parallel runs.
        XCTAssertEqual(
            guards.evaluateSnapshot(snapshot(activeOthers: 1, maxConcurrent: 2)),
            .proceed)
        // Stale running runs are carried in the snapshot but never counted.
        var staleSnapshot = snapshot()
        staleSnapshot.staleRunningRunIDs = [UUID()]
        XCTAssertEqual(guards.evaluateSnapshot(staleSnapshot), .proceed)
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

    func testLocalExternalProviderConfigAcceptsLoopbackOnlyWithOptIn() throws {
        var config = testConfig()
        config.momoEnvironment = "local"
        config.agentProviderMode = .externalHermes
        config.hermesBaseURL = "http://localhost:22683/v1"
        config.hermesAPIKey = "local-hermes-bearer"
        config.agentModel = "gpt-4.1-mini-through-local-hermes"
        config.allowLocalLoopbackExternalHermes = true

        XCTAssertNoThrow(try config.validateAgentProviderForBoot())
        XCTAssertEqual(config.agentAvailability, "available")
        XCTAssertEqual(config.agentProviderEndpointLabel, "http://localhost:22683/v1")

        config.momoEnvironment = "prod"
        XCTAssertThrowsError(try config.validateAgentProviderForBoot()) { error in
            XCTAssertTrue(String(describing: error).contains("localhost"))
        }
    }

    func testExternalProviderConfigRejectsNonLoopbackHTTPEvenWithOptIn() {
        let errors = AgentProviderValidation.validationErrors(
            mode: .externalHermes,
            hermesBaseURL: "http://kim.example.net/v1",
            hermesAPIKey: "local-hermes-bearer",
            strictEnvironment: false,
            allowLocalLoopback: true
        )

        XCTAssertTrue(errors.joined(separator: " ").contains("https://"))
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

    func testAgentJobPayloadDecodesMatchingContextPacketMemoryRefs() throws {
        let packetID = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaa0528"
        let memory = """
        [{"memory_id":"bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbb0528","kind":"profile","excerpt":"Team profile"}]
        """
        let payloadJSON = """
        {
          "agent_member_id":"cccccccc-cccc-7ccc-8ccc-cccccccc0528",
          "channel_id":"dddddddd-dddd-7ddd-8ddd-dddddddd0528",
          "model":"hermes-agent",
          "prompt":"summarize",
          "context_packet_id":"\(packetID)",
          "memory_refs":\(memory),
          "context_packet":{"memory_refs":\(memory)},
          "context_packet_projection":{"memory_refs":\(memory)}
        }
        """
        let payload = try JSONDecoder().decode(
            AgentJobPayload.self, from: Data(payloadJSON.utf8)
        )
        XCTAssertEqual(payload.contextPacketID?.uuidString.lowercased(), packetID)
        XCTAssertEqual(payload.memoryRefs?.count, 1)
        XCTAssertEqual(payload.memoryRefs?.first?["kind"]?.stringValue, "profile")
    }

    func testAgentJobPayloadRejectsConflictingMemoryRefSources() throws {
        let payloadJSON = """
        {
          "agent_member_id":"cccccccc-cccc-7ccc-8ccc-cccccccc0528",
          "channel_id":"dddddddd-dddd-7ddd-8ddd-dddddddd0528",
          "model":"hermes-agent",
          "prompt":"summarize",
          "memory_refs":[{"memory_id":"aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaa0001"}],
          "context_packet":{"memory_refs":[{"memory_id":"aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaa0002"}]}
        }
        """
        let payload = try JSONDecoder().decode(
            AgentJobPayload.self, from: Data(payloadJSON.utf8)
        )
        XCTAssertNil(payload.memoryRefs)
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

    func testResumeApprovalExecutorAllowsHumanApprovedResumeWithoutPolicyEvidence() throws {
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

        // MOMO-528 이후: capability grant가 없어 missing_or_ambiguous로 정지된
        // 승인은 policy_evidence 없이 인간 결정만으로 재개된다. 결정 검증
        // (approval_id 일치·approved 상태)은 여전히 필수다.
        let validated = try ToolResumeExecutor().validate(payload)
        XCTAssertNil(validated.policyEvidence)
        XCTAssertEqual(validated.toolCall.name, "momo.mock.echo")
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
            allowLocalLoopbackExternalHermes: false,
            momoAPIURL: "http://localhost:8080",
            momoAgentToken: nil,
            momoWorkHostID: nil,
            pollInterval: .milliseconds(300),
            maxAttempts: 3,
            maxConsecutiveAuto: 3,
            maxSteps: 12,
            maxDepth: 4,
            maxConcurrentRuns: 1,
            maxContextChars: 24000
        )
    }

    // MARK: - MOMO-486 work tool dispatch

    func testWorkToolSchemasExposeCanonicalFourTools() throws {
        let merged = WorkToolDispatcher.mergedToolDefinitions(into: .array([]))
        guard case .array(let definitions) = merged else {
            return XCTFail("work tools must be an OpenAI tools array")
        }
        let names = definitions.compactMap { definition in
            definition.objectValue?["function"]?.objectValue?["name"]?.stringValue
        }
        XCTAssertEqual(names, ["work_spawn", "work_input", "work_read", "work_kill"])

        let input = try XCTUnwrap(definitions.first { definition in
            definition.objectValue?["function"]?.objectValue?["name"]?.stringValue == "work_input"
        })
        let maxLength = input.objectValue?["function"]?.objectValue?["parameters"]?
            .objectValue?["properties"]?.objectValue?["text"]?.objectValue?["maxLength"]
        XCTAssertEqual(maxLength, .int(4_000))
    }

    func testWorkToolParserAcceptsAllFourCalls() throws {
        let runID = UUID(uuidString: "00000000-0000-7000-8000-000000000486")!
        let channelID = UUID(uuidString: "00000000-0000-7000-8000-000000000201")!
        let hostID = UUID(uuidString: "00000000-0000-7000-8000-000000000901")!
        let sessionID = UUID(uuidString: "00000000-0000-7000-8000-000000000902")!

        let spawn = try WorkToolDispatcher.parse(
            name: "work_spawn",
            arguments: #"{"tool":"codex","label":"  Fix MOMO-486  ","channel":"00000000-0000-7000-8000-000000000201"}"#,
            currentChannelID: channelID,
            runID: runID,
            targetHostID: hostID
        )
        XCTAssertEqual(spawn.kind, .spawn)
        XCTAssertEqual(spawn.payload["label"]?.stringValue, "Fix MOMO-486")
        XCTAssertNil(spawn.sessionID)

        let input = try WorkToolDispatcher.parse(
            name: "work_input",
            arguments: #"{"session_id":"00000000-0000-7000-8000-000000000902","text":"continue"}"#,
            currentChannelID: channelID,
            runID: runID,
            targetHostID: hostID
        )
        XCTAssertEqual(input.kind, .input)
        XCTAssertEqual(input.sessionID, sessionID)
        XCTAssertEqual(input.payload["text"]?.stringValue, "continue")

        for name in ["work_read", "work_kill"] {
            let call = try WorkToolDispatcher.parse(
                name: name,
                arguments: #"{"session_id":"00000000-0000-7000-8000-000000000902"}"#,
                currentChannelID: channelID,
                runID: runID,
                targetHostID: hostID
            )
            XCTAssertEqual(call.sessionID, sessionID)
            XCTAssertEqual(call.payload, .object([:]))
        }
    }

    func testWorkToolParserRejectsUUIDLengthAndUnexpectedArguments() throws {
        let runID = UUID()
        let channelID = UUID()
        let hostID = UUID()

        XCTAssertThrowsError(try WorkToolDispatcher.parse(
            name: "work_read",
            arguments: #"{"session_id":"not-a-uuid"}"#,
            currentChannelID: channelID,
            runID: runID,
            targetHostID: hostID
        )) { error in
            XCTAssertEqual(
                error as? WorkToolDispatcher.ValidationError,
                .invalidUUID(field: "session_id")
            )
        }

        let tooLongText = String(repeating: "가", count: 4_001)
        let inputJSON = try JSONSerialization.data(withJSONObject: [
            "session_id": UUID().uuidString,
            "text": tooLongText,
        ])
        XCTAssertThrowsError(try WorkToolDispatcher.parse(
            name: "work_input",
            arguments: String(decoding: inputJSON, as: UTF8.self),
            currentChannelID: channelID,
            runID: runID,
            targetHostID: hostID
        )) { error in
            XCTAssertEqual(error as? WorkToolDispatcher.ValidationError, .invalidText)
        }

        let tooLongLabel = String(repeating: "x", count: 121)
        let spawnJSON = try JSONSerialization.data(withJSONObject: [
            "tool": "codex",
            "label": tooLongLabel,
            "channel": channelID.uuidString,
        ])
        XCTAssertThrowsError(try WorkToolDispatcher.parse(
            name: "work_spawn",
            arguments: String(decoding: spawnJSON, as: UTF8.self),
            currentChannelID: channelID,
            runID: runID,
            targetHostID: hostID
        )) { error in
            XCTAssertEqual(error as? WorkToolDispatcher.ValidationError, .invalidLabel)
        }

        XCTAssertThrowsError(try WorkToolDispatcher.parse(
            name: "work_kill",
            arguments: #"{"session_id":"00000000-0000-7000-8000-000000000902","force":true}"#,
            currentChannelID: channelID,
            runID: runID,
            targetHostID: hostID
        )) { error in
            XCTAssertEqual(
                error as? WorkToolDispatcher.ValidationError,
                .unsupportedFields(kind: .kill)
            )
        }
    }

    func testWorkToolPendingAndForbiddenResponsesAreTruthful() {
        let pending = WorkControlClient.Result(
            controlID: UUID(),
            status: "pending_approval",
            responseBody: #"{"status":"pending_approval"}"#
        )
        XCTAssertTrue(
            WorkToolDispatcher.responseText(for: pending, kind: .spawn)?
                .contains("승인 대기") == true
        )
        XCTAssertNil(WorkToolDispatcher.responseText(
            for: .init(controlID: UUID(), status: "dispatched", responseBody: "{}"),
            kind: .input
        ))
        XCTAssertTrue(WorkToolDispatcher.responseText(
            for: .init(controlID: UUID(), status: "dispatched", responseBody: #"{"tail":"ok"}"#),
            kind: .read
        )?.contains(#"{"tail":"ok"}"#) == true)

        let forbidden = WorkToolDispatcher.rejectionText(for:
            WorkControlClient.Failure.http(
                status: 403,
                message: "session is outside the approved requester lineage"
            )
        )
        XCTAssertTrue(forbidden.contains("HTTP 403"))
        XCTAssertTrue(forbidden.contains("outside the approved requester lineage"))
        XCTAssertFalse(forbidden.lowercased().contains("success"))
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

    // MARK: - MOMO-302 context assembly

    private static let ctxAgentID = UUID(uuidString: "00000000-0000-7000-8000-0000000000A1")!
    private static let ctxHumanID = UUID(uuidString: "00000000-0000-7000-8000-0000000000B1")!
    private static let ctxChannelID = UUID(uuidString: "00000000-0000-7000-8000-0000000000C1")!
    private static let ctxTriggerID = UUID(uuidString: "00000000-0000-7000-8000-0000000000E9")!

    func testContextAssemblerDecodesWindowAndMapsRolesWithSourceAttribution() throws {
        let agent = Self.ctxAgentID.uuidString
        let channel = Self.ctxChannelID.uuidString
        let human = Self.ctxHumanID.uuidString
        let trigger = Self.ctxTriggerID.uuidString
        let json = """
        {
          "agent_member_id": "\(agent)",
          "channel_id": "\(channel)",
          "model": "hermes-agent",
          "prompt": "@hermes 재고 몇 개야?",
          "trigger_message_id": "\(trigger)",
          "system_prompt": "You are Hermes.",
          "recent_messages": [
            {"message_id":"00000000-0000-7000-8000-000000000001","channel_id":"\(channel)","seq":1,"author_member_id":"\(human)","author_kind":"human","author_display":"Seun","type":"text","body":"파인애플 재고는 7개다"},
            {"message_id":"00000000-0000-7000-8000-000000000002","channel_id":"\(channel)","seq":2,"author_member_id":"\(agent)","author_kind":"agent","author_display":"Hermes","type":"text","body":"확인했어, 7개 맞아"},
            {"message_id":"\(trigger)","channel_id":"\(channel)","seq":3,"author_member_id":"\(human)","author_kind":"human","author_display":"Seun","type":"text","body":"@hermes 재고 몇 개야?"}
          ]
        }
        """
        let payload = try JSONDecoder().decode(AgentJobPayload.self, from: Data(json.utf8))
        XCTAssertEqual(payload.recentMessages?.count, 3)
        XCTAssertEqual(payload.systemPrompt, "You are Hermes.")

        // Session boundary (workspace, agent, channel): the assembled window must
        // be single-channel — the server guarantees it, and we lock the invariant.
        let channels = Set((payload.recentMessages ?? []).compactMap { $0.channelID })
        XCTAssertEqual(channels, [Self.ctxChannelID])

        let result = ContextAssembler.assemble(
            recentMessages: payload.recentMessages ?? [],
            agentMemberID: payload.agentMemberID,
            triggerMessageID: payload.triggerMessageID,
            fallbackPrompt: payload.prompt,
            systemPrompt: payload.systemPrompt,
            maxChars: 24_000)

        XCTAssertEqual(result.droppedCount, 0)
        XCTAssertEqual(result.messages, [
            .init(role: "system", content: "You are Hermes."),
            .init(role: "user", content: "[Seun] 파인애플 재고는 7개다"),
            .init(role: "assistant", content: "확인했어, 7개 맞아"),
            .init(role: "user", content: "[Seun] @hermes 재고 몇 개야?"),
        ])
    }

    func testContextAssemblerDropsOldestOverBudgetButAlwaysKeepsTrigger() {
        func msg(_ suffix: String, _ seq: Int64, _ body: String, author: UUID) -> RecentMessage {
            RecentMessage(
                messageID: UUID(uuidString: "00000000-0000-7000-8000-0000000000\(suffix)")!,
                channelID: Self.ctxChannelID,
                seq: seq,
                authorMemberID: author,
                authorKind: author == Self.ctxAgentID ? "agent" : "human",
                authorDisplay: author == Self.ctxAgentID ? "Hermes" : "Seun",
                type: "text",
                body: body)
        }
        // "[Seun] one" = 10, "two" (assistant, no prefix) = 3, "[Seun] three" = 12.
        let window = [
            msg("01", 1, "one", author: Self.ctxHumanID),
            msg("02", 2, "two", author: Self.ctxAgentID),
            msg("E9", 3, "three", author: Self.ctxHumanID),
        ]
        let trimmed = ContextAssembler.assemble(
            recentMessages: window,
            agentMemberID: Self.ctxAgentID,
            triggerMessageID: UUID(uuidString: "00000000-0000-7000-8000-0000000000E9")!,
            fallbackPrompt: "unused",
            systemPrompt: nil,
            maxChars: 20)
        XCTAssertEqual(trimmed.droppedCount, 1)
        XCTAssertEqual(trimmed.messages, [
            .init(role: "assistant", content: "two"),
            .init(role: "user", content: "[Seun] three"),
        ])

        // Even a budget of 1 keeps the trigger — the current turn is never erased.
        let onlyTrigger = ContextAssembler.assemble(
            recentMessages: window,
            agentMemberID: Self.ctxAgentID,
            triggerMessageID: UUID(uuidString: "00000000-0000-7000-8000-0000000000E9")!,
            fallbackPrompt: "unused",
            systemPrompt: nil,
            maxChars: 1)
        XCTAssertEqual(onlyTrigger.messages, [.init(role: "user", content: "[Seun] three")])
        XCTAssertEqual(onlyTrigger.droppedCount, 2)
    }

    func testContextAssemblerLegacyEmptyWindowKeepsSingleMessagePath() {
        let legacy = ContextAssembler.assemble(
            recentMessages: [],
            agentMemberID: Self.ctxAgentID,
            triggerMessageID: nil,
            fallbackPrompt: "hi",
            systemPrompt: nil,
            maxChars: 24_000)
        XCTAssertEqual(legacy.messages, [.init(role: "user", content: "hi")])
        XCTAssertEqual(legacy.droppedCount, 0)

        let withSystem = ContextAssembler.assemble(
            recentMessages: [],
            agentMemberID: Self.ctxAgentID,
            triggerMessageID: nil,
            fallbackPrompt: "hi",
            systemPrompt: "You are Hermes.",
            maxChars: 24_000)
        XCTAssertEqual(withSystem.messages, [
            .init(role: "system", content: "You are Hermes."),
            .init(role: "user", content: "hi"),
        ])
    }

    func testContextAssemblerInjectsWorkspaceMemoryAfterSystemPrompt() {
        let memory: [JSONValue] = [
            .object([
                "kind": .string("profile"),
                "scope": .string("workspace"),
                "excerpt": .string("출시는 목요일이다"),
                "source_ids": .array([.string("msg_001"), .string("msg_002")]),
            ]),
        ]
        let result = ContextAssembler.assemble(
            recentMessages: [],
            agentMemberID: Self.ctxAgentID,
            triggerMessageID: nil,
            fallbackPrompt: "일정을 알려줘",
            systemPrompt: "You are Hermes.",
            memoryRefs: memory,
            maxChars: 24_000
        )

        XCTAssertEqual(result.memoryIncludedCount, 1)
        XCTAssertTrue(result.memoryInjected)
        XCTAssertEqual(result.messages.map(\.role), ["system", "system", "user"])
        XCTAssertEqual(result.messages[0].content, "You are Hermes.")
        XCTAssertEqual(result.messages[2].content, "일정을 알려줘")
        XCTAssertTrue(result.messages[1].content.hasPrefix("워크스페이스 메모리\n"))
        XCTAssertTrue(result.messages[1].content.contains("kind: profile"))
        XCTAssertTrue(result.messages[1].content.contains("scope: workspace"))
        XCTAssertTrue(result.messages[1].content.contains("excerpt: |\n    출시는 목요일이다"))
        XCTAssertTrue(result.messages[1].content.contains("source_ids: [\"msg_001\",\"msg_002\"]"))
    }

    func testContextAssemblerDropsMemoryBeforeTriggerWhenBudgetIsExhausted() {
        let result = ContextAssembler.assemble(
            recentMessages: [],
            agentMemberID: Self.ctxAgentID,
            triggerMessageID: nil,
            fallbackPrompt: "trigger",
            systemPrompt: nil,
            memoryRefs: [
                .object([
                    "kind": .string("fact"),
                    "scope": .string("agent"),
                    "excerpt": .string(String(repeating: "메", count: 200)),
                    "source_ids": .array([]),
                ]),
            ],
            maxChars: 7
        )

        XCTAssertEqual(result.memoryIncludedCount, 1)
        XCTAssertFalse(result.memoryInjected)
        XCTAssertEqual(result.messages, [.init(role: "user", content: "trigger")])
    }

    func testContextAssemblerDoesNotInjectEmptyMemoryRefs() {
        let result = ContextAssembler.assemble(
            recentMessages: [],
            agentMemberID: Self.ctxAgentID,
            triggerMessageID: nil,
            fallbackPrompt: "hi",
            systemPrompt: "system",
            memoryRefs: [],
            maxChars: 24_000
        )

        XCTAssertEqual(result.memoryIncludedCount, 0)
        XCTAssertFalse(result.memoryInjected)
        XCTAssertEqual(result.messages, [
            .init(role: "system", content: "system"),
            .init(role: "user", content: "hi"),
        ])
    }

    // MARK: - MOMO-479 thread projection

    func testThreadUpdatedPayloadUsesReplySequenceWithoutMintingAnotherSequence() throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let channelID = UUID(uuidString: "00000000-0000-7000-8000-000000000010")!
        let rootID = UUID(uuidString: "00000000-0000-7000-8000-000000000508")!
        let replyAt = Date(timeIntervalSince1970: 1_750_000_000.125)
        let json = WorkerService.threadUpdatedPayload(
            workspaceID: workspaceID,
            channelID: channelID,
            rootID: rootID,
            replyCount: 3,
            lastReplySeq: 44,
            lastReplyAt: replyAt
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        )
        let data = try XCTUnwrap(object["data"] as? [String: Any])
        let payload = try XCTUnwrap(data["payload"] as? [String: Any])

        XCTAssertEqual(data["type"] as? String, "thread.updated")
        XCTAssertEqual(data["seq"] as? Int, 44)
        XCTAssertNil(
            object["version"],
            "thread.updated reuses the reply seq; a Centrifugo version <= the reply's message.new would be silently dropped"
        )
        XCTAssertEqual(payload["channel_id"] as? String, channelID.uuidString)
        XCTAssertEqual(payload["root_id"] as? String, rootID.uuidString)
        XCTAssertEqual(payload["reply_count"] as? Int, 3)
        XCTAssertEqual(payload["last_reply_seq"] as? Int, 44)
        XCTAssertEqual(payload["last_reply_at"] as? Int64, 1_750_000_000_125)
    }

    func testAllFourDurableMessageInsertSitesPreserveThreadContext() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: packageRoot
                .appendingPathComponent("Sources/AgentWorker/WorkerService.swift"),
            encoding: .utf8
        )

        XCTAssertEqual(source.components(separatedBy: "INSERT INTO message").count - 1, 4)
        XCTAssertEqual(source.components(separatedBy: "root_id, run_id)").count - 1, 4)
        XCTAssertEqual(source.components(separatedBy: "Self.recordThreadProjection(").count - 1, 4)
        XCTAssertEqual(
            source.components(separatedBy: #""root_id": rootID?.uuidString ?? NSNull()"#).count - 1,
            4
        )
        XCTAssertTrue(source.contains("FROM agent_run"))
        XCTAssertTrue(source.contains("SELECT channel_id, root_id"))
        XCTAssertTrue(source.contains("array_append("))
        XCTAssertTrue(source.contains(#""type": "thread.updated""#))
    }
}
