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
}
