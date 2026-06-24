import Foundation
import Logging
import PostgresNIO

/// Two-stage cost accounting + circuit breaker (L4 §3.3 G5 / §8.5).
///
/// v0 implements **reserve / reconcile stubs**: the structure and the integer
/// micro_usd discipline (no float drift, L4 §8.5) are real, but the hot-row
/// `budget_window` UPDATEs and `model_pricing` lookups are TODO-marked. The SoT
/// is Postgres (`budget` / `budget_window` / `usage_ledger`).
///
///   - reserve (pre-call): estimate = max_output_tokens upper bound → lock the
///     matching-grain `budget_window` rows in a fixed order + `INSERT ... ON
///     CONFLICT DO UPDATE` (lazy-inline rollover, no reset cron). Over limit →
///     deterministic trip (ROLLBACK) → the worker aborts the run before spending.
///   - reconcile (post-stream): shrink reserved → actual using the SSE final-chunk
///     usage; if usage was missing, keep `was_estimated=true` (L4 §8.5).
///
/// runtime-unverified (no psql): SQL in TODOs is shaped to schema_v0 but not
/// executed here.
struct CostAccounting: Sendable {
    let pg: PostgresClient
    let logger: Logger

    /// Result of a pre-call reserve. `.reserved` carries the held micro_usd so
    /// reconcile can release the delta; `.tripped` means a budget grain is over
    /// limit → the worker must abort (G5 circuit breaker).
    enum ReserveResult: Sendable {
        case reserved(estimateMicroUSD: Int64)
        case tripped(grain: String)
    }

    /// Reserve estimated cost before calling hermes (L4 §8.5 reserve step).
    ///
    /// Stub: computes a deterministic estimate from `maxOutputTokens` and an output
    /// unit price, logs the intended `budget_window` reservation, and returns
    /// `.reserved`. The real trip check needs the budget rows.
    func reserve(
        workspaceID: UUID,
        agentMemberID: UUID,
        channelID: UUID,
        model: String,
        maxOutputTokens: Int
    ) async -> ReserveResult {
        // micro_usd = tokens * unit_price(micro_usd/token). v0 uses a placeholder
        // unit price; real path reads model_pricing (effective_from history).
        let placeholderOutputMicroPerToken: Int64 = 1   // TODO: SELECT from model_pricing
        let estimate = Int64(maxOutputTokens) * placeholderOutputMicroPerToken

        // TODO (L4 §8.5): in one tx, lock matching-grain budget_window rows in a
        // fixed order and `INSERT ... ON CONFLICT (budget_id, period_start) DO UPDATE
        // SET reserved_micro_usd = budget_window.reserved_micro_usd + $est`; if any
        // grain's reserved+spent would exceed limit_micro_usd → ROLLBACK → .tripped.
        logger.debug("budget reserve (stub)", metadata: [
            "model": .string(model),
            "estimateMicroUSD": .stringConvertible(estimate),
            "agentMemberId": .string(agentMemberID.uuidString),
        ])
        return .reserved(estimateMicroUSD: estimate)
    }

    /// Reconcile after the turn finishes (L4 §8.5 reconcile step): write the
    /// immutable `usage_ledger` row + shrink the `budget_window` reservation to the
    /// measured spend. `wasEstimated` is preserved when the SSE usage was absent.
    func reconcile(
        workspaceID: UUID,
        runID: UUID?,
        agentMemberID: UUID,
        channelID: UUID,
        model: String,
        promptTokens: Int,
        completionTokens: Int,
        cachedTokens: Int,
        reasoningTokens: Int,
        wasEstimated: Bool,
        reservedMicroUSD: Int64
    ) async {
        // Integer micro_usd accumulation (no float drift, L4 §8.5).
        let placeholderInputMicroPerToken: Int64 = 1    // TODO: model_pricing
        let placeholderOutputMicroPerToken: Int64 = 1   // TODO: model_pricing
        let cost = Int64(promptTokens) * placeholderInputMicroPerToken
            + Int64(completionTokens) * placeholderOutputMicroPerToken

        // TODO (L4 §8.5): in one tx —
        //   INSERT INTO usage_ledger (workspace_id, run_id, agent_member_id, channel_id,
        //     model, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens,
        //     cost_micro_usd, was_estimated) VALUES (...);
        //   UPDATE budget_window SET spent_micro_usd = spent_micro_usd + $cost,
        //     reserved_micro_usd = GREATEST(0, reserved_micro_usd - $reserved)
        //   WHERE ...matching grains...;
        logger.debug("budget reconcile (stub)", metadata: [
            "model": .string(model),
            "promptTokens": .stringConvertible(promptTokens),
            "completionTokens": .stringConvertible(completionTokens),
            "costMicroUSD": .stringConvertible(cost),
            "wasEstimated": .stringConvertible(wasEstimated),
            "releasedReservedMicroUSD": .stringConvertible(reservedMicroUSD),
        ])
    }
}
