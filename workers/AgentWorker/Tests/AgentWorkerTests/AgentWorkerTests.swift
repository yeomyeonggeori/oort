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
            hermesBaseURL: "http://localhost:8088/v1",
            hermesAPIKey: "dev",
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

    func testApprovalPolicyRequiresApprovalForWriteLikeToolNames() {
        let guards = LoopGuards(config: testConfig(), logger: .init(label: "test.approval-policy"))

        XCTAssertTrue(guards.requiresApproval(toolName: "github.create_issue"))
        XCTAssertTrue(guards.requiresApproval(toolName: "jira.transition_issue"))
        XCTAssertTrue(guards.requiresApproval(toolName: "deploy"))
        XCTAssertTrue(guards.requiresApproval(toolName: "unknown.custom_action"))
        XCTAssertTrue(guards.requiresApproval(toolName: ""))
    }

    func testApprovalPolicyAllowsKnownReadOnlyToolNames() {
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

    private func testConfig() -> Config {
        Config(
            pgHost: "localhost",
            pgPort: 5432,
            pgUser: "momo_worker",
            pgPassword: "dev",
            pgDatabase: "momo",
            centAPIURL: "http://localhost:8000/api",
            centAPIKey: "dev",
            hermesBaseURL: "http://localhost:8088/v1",
            hermesAPIKey: "dev",
            pollInterval: .milliseconds(300),
            maxAttempts: 3,
            maxConsecutiveAuto: 3,
            maxSteps: 12,
            maxDepth: 4,
            maxConcurrentRuns: 1
        )
    }
}
