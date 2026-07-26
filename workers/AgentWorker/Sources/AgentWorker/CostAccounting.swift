import Foundation
import Logging
import PostgresNIO

/// Two-stage cost accounting + circuit breaker (L4 §3.3 G5 / §8.5).
///
/// The SoT is Postgres (`model_pricing` / `budget` / `budget_window` /
/// `usage_ledger`). Prices are numeric micro_usd/token and every rollup is
/// stored as integer micro_usd, so the worker never accumulates floating point
/// drift.
///
///   - reserve (pre-call): estimate = max_output_tokens upper bound → touch the
///     matching-grain `budget_window` rows in a fixed order with atomic
///     `INSERT ... ON CONFLICT DO UPDATE ... WHERE spent+reserved+estimate<=limit`
///     (lazy-inline rollover, no reset cron). Over limit → deterministic trip
///     (ROLLBACK) → the worker aborts the run before spending.
///   - reconcile (post-stream): shrink reserved → actual using the SSE final-chunk
///     usage; if usage was missing, keep `was_estimated=true` (L4 §8.5).
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
    func reserve(
        workspaceID: UUID,
        agentMemberID: UUID,
        channelID: UUID,
        model: String,
        maxOutputTokens: Int
    ) async -> ReserveResult {
        do {
            return try await pg.withTransaction(logger: logger) { conn in
                try await setWorkspace(workspaceID, on: conn)
                let pricing = try await loadPricing(
                    workspaceID: workspaceID, model: model, on: conn)
                let estimate = Self.microUSD(
                    tokens: maxOutputTokens, unitPriceText: pricing.output, rounding: .up)

                let budgets = try await loadMatchingBudgets(
                    workspaceID: workspaceID,
                    agentMemberID: agentMemberID,
                    channelID: channelID,
                    on: conn
                )

                for budget in budgets {
                    if budget.spentMicroUSD + budget.reservedMicroUSD + estimate
                        > budget.limitMicroUSD
                    {
                        logger.warning("budget reserve tripped", metadata: [
                            "model": .string(model),
                            "grain": .string(budget.grain),
                            "estimateMicroUSD": .stringConvertible(estimate),
                            "limitMicroUSD": .stringConvertible(budget.limitMicroUSD),
                            "reservedMicroUSD": .stringConvertible(budget.reservedMicroUSD),
                            "spentMicroUSD": .stringConvertible(budget.spentMicroUSD),
                        ])
                        return .tripped(grain: budget.grain)
                    }
                }

                for budget in budgets {
                    try await reserveWindow(
                        budget,
                        workspaceID: workspaceID,
                        estimate: estimate,
                        on: conn
                    )
                }

                logger.debug("budget reserve", metadata: [
                    "model": .string(model),
                    "estimateMicroUSD": .stringConvertible(estimate),
                    "matchedBudgets": .stringConvertible(budgets.count),
                    "agentMemberId": .string(agentMemberID.uuidString),
                ])
                return .reserved(estimateMicroUSD: estimate)
            }
        } catch let trip as BudgetTrip {
            return .tripped(grain: trip.grain)
        } catch {
            logger.error("budget reserve failed; failing closed", metadata: [
                "model": .string(model),
                "error": .string(String(describing: error)),
            ])
            return .tripped(grain: "cost_accounting_error")
        }
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
        effort: String?,
        promptTokens: Int,
        completionTokens: Int,
        cachedTokens: Int,
        reasoningTokens: Int,
        wasEstimated: Bool,
        reservedMicroUSD: Int64
    ) async {
        do {
            try await pg.withTransaction(logger: logger) { conn in
                try await setWorkspace(workspaceID, on: conn)
                let pricing = try await loadPricing(
                    workspaceID: workspaceID, model: model, on: conn)
                let cost = Self.usageCostMicroUSD(
                    promptTokens: promptTokens,
                    completionTokens: completionTokens,
                    cachedTokens: cachedTokens,
                    reasoningTokens: reasoningTokens,
                    pricing: pricing
                )

                _ = try await conn.query(
                    """
                    INSERT INTO usage_ledger
                      (workspace_id, run_id, agent_member_id, channel_id, model,
                       prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens,
                       cost_micro_usd, was_estimated, effort)
                    VALUES
                      (\(workspaceID), \(runID), \(agentMemberID), \(channelID), \(model),
                       \(promptTokens), \(completionTokens), \(cachedTokens), \(reasoningTokens),
                       \(cost), \(wasEstimated), \(Self.normalizedEffort(effort)))
                    """,
                    logger: logger
                )

                let budgets = try await loadMatchingBudgets(
                    workspaceID: workspaceID,
                    agentMemberID: agentMemberID,
                    channelID: channelID,
                    on: conn
                )
                for budget in budgets {
                    try await reconcileWindow(
                        budget, cost: cost, reservedMicroUSD: reservedMicroUSD, on: conn)
                }

                logger.debug("budget reconcile", metadata: [
                    "model": .string(model),
                    "effort": .string(Self.normalizedEffort(effort) ?? "none"),
                    "promptTokens": .stringConvertible(promptTokens),
                    "completionTokens": .stringConvertible(completionTokens),
                    "costMicroUSD": .stringConvertible(cost),
                    "wasEstimated": .stringConvertible(wasEstimated),
                    "releasedReservedMicroUSD": .stringConvertible(reservedMicroUSD),
                    "matchedBudgets": .stringConvertible(budgets.count),
                ])
            }
        } catch {
            logger.error("budget reconcile failed", metadata: [
                "model": .string(model),
                "runId": .string(runID?.uuidString ?? "nil"),
                "error": .string(String(describing: error)),
            ])
        }
    }

    // MARK: - Pricing and budget helpers

    struct Pricing: Sendable {
        var input: String
        var output: String
        var cacheRead: String
        var reasoning: String
    }

    private struct BudgetRow: Sendable {
        var id: UUID
        var grain: String
        var periodStart: Date
        var limitMicroUSD: Int64
        var reservedMicroUSD: Int64
        var spentMicroUSD: Int64
    }

    private struct BudgetTrip: Error, Sendable {
        var grain: String
    }

    private func setWorkspace(_ workspaceID: UUID, on conn: PostgresConnection) async throws {
        _ = try await conn.query(
            "SELECT set_config('app.workspace_id', \(workspaceID.uuidString), true)",
            logger: logger)
    }

    private func loadPricing(
        workspaceID: UUID, model: String, on conn: PostgresConnection
    ) async throws -> Pricing {
        let rows = try await conn.query(
            """
            SELECT input_micro_usd_per_token::text,
                   output_micro_usd_per_token::text,
                   cache_read_micro_usd_per_token::text,
                   COALESCE(reasoning_micro_usd_per_token,
                            output_micro_usd_per_token)::text
              FROM model_pricing
             WHERE model = \(model)
               AND (workspace_id = \(workspaceID) OR workspace_id IS NULL)
               AND effective_from <= now()
             ORDER BY (workspace_id IS NULL) ASC, effective_from DESC
             LIMIT 1
            """,
            logger: logger
        ).collect()

        guard let row = rows.first else {
            logger.warning("model pricing missing; using zero-cost fallback", metadata: [
                "model": .string(model),
                "workspaceId": .string(workspaceID.uuidString),
            ])
            return Pricing(input: "0", output: "0", cacheRead: "0", reasoning: "0")
        }
        let (input, output, cacheRead, reasoning) =
            try row.decode((String, String, String, String).self)
        return Pricing(input: input, output: output, cacheRead: cacheRead, reasoning: reasoning)
    }

    private func loadMatchingBudgets(
        workspaceID: UUID,
        agentMemberID: UUID,
        channelID: UUID,
        on conn: PostgresConnection
    ) async throws -> [BudgetRow] {
        let rows = try await conn.query(
            """
            WITH matched AS (
              SELECT b.id,
                     b.grain::text AS grain,
                     to_timestamp(
                       floor(extract(epoch from now()) / b.period_seconds)
                       * b.period_seconds
                     ) AS period_start,
                     b.limit_micro_usd
                FROM budget b
               WHERE b.workspace_id = \(workspaceID)
                 AND (
                   b.grain::text = 'workspace'
                   OR (b.grain::text = 'agent' AND b.agent_member_id = \(agentMemberID))
                   OR (b.grain::text = 'channel' AND b.channel_id = \(channelID))
                   OR (b.grain::text = 'workspace_agent' AND b.agent_member_id = \(agentMemberID))
                   OR (b.grain::text = 'agent_channel'
                       AND b.agent_member_id = \(agentMemberID)
                       AND b.channel_id = \(channelID))
                 )
            )
            SELECT m.id,
                   m.grain,
                   m.period_start,
                   m.limit_micro_usd,
                   COALESCE(w.reserved_micro_usd, 0)::bigint,
                   COALESCE(w.spent_micro_usd, 0)::bigint
              FROM matched m
              LEFT JOIN budget_window w
                ON w.budget_id = m.id
               AND w.period_start = m.period_start
             ORDER BY CASE m.grain
                        WHEN 'workspace' THEN 1
                        WHEN 'workspace_agent' THEN 2
                        WHEN 'agent' THEN 3
                        WHEN 'channel' THEN 4
                        WHEN 'agent_channel' THEN 5
                        ELSE 6
                      END,
                      m.id
            """,
            logger: logger
        ).collect()

        return try rows.map { row in
            let (id, grain, periodStart, limit, reserved, spent) =
                try row.decode((UUID, String, Date, Int64, Int64, Int64).self)
            return BudgetRow(
                id: id,
                grain: grain,
                periodStart: periodStart,
                limitMicroUSD: limit,
                reservedMicroUSD: reserved,
                spentMicroUSD: spent
            )
        }
    }

    private func reserveWindow(
        _ budget: BudgetRow,
        workspaceID: UUID,
        estimate: Int64,
        on conn: PostgresConnection
    ) async throws {
        let rows = try await conn.query(
            """
            WITH upserted AS (
              INSERT INTO budget_window
                (budget_id, workspace_id, period_start, reserved_micro_usd, spent_micro_usd)
              VALUES
                (\(budget.id), \(workspaceID), \(budget.periodStart), \(estimate), 0)
              ON CONFLICT (budget_id, period_start)
              DO UPDATE
                 SET reserved_micro_usd = budget_window.reserved_micro_usd
                                          + EXCLUDED.reserved_micro_usd,
                     updated_at = now()
               WHERE budget_window.reserved_micro_usd
                     + budget_window.spent_micro_usd
                     + EXCLUDED.reserved_micro_usd <= \(budget.limitMicroUSD)
              RETURNING 1
            )
            SELECT count(*)::bigint FROM upserted
            """,
            logger: logger
        ).collect()
        let affected = try rows.first?.decode(Int64.self) ?? 0
        if affected != 1 {
            throw BudgetTrip(grain: budget.grain)
        }
    }

    private func reconcileWindow(
        _ budget: BudgetRow,
        cost: Int64,
        reservedMicroUSD: Int64,
        on conn: PostgresConnection
    ) async throws {
        _ = try await conn.query(
            """
            UPDATE budget_window
               SET spent_micro_usd = spent_micro_usd + \(cost),
                   reserved_micro_usd = GREATEST(
                     0::bigint,
                     reserved_micro_usd - \(reservedMicroUSD)
                   ),
                   updated_at = now()
             WHERE budget_id = \(budget.id)
               AND period_start = \(budget.periodStart)
            """,
            logger: logger
        )
    }

    static func usageCostMicroUSD(
        promptTokens: Int,
        completionTokens: Int,
        cachedTokens: Int,
        reasoningTokens: Int,
        pricing: Pricing
    ) -> Int64 {
        let uncachedPromptTokens = max(0, promptTokens - cachedTokens)
        return microUSD(tokens: uncachedPromptTokens, unitPriceText: pricing.input, rounding: .plain)
            + microUSD(tokens: completionTokens, unitPriceText: pricing.output, rounding: .plain)
            + microUSD(tokens: cachedTokens, unitPriceText: pricing.cacheRead, rounding: .plain)
            + microUSD(tokens: reasoningTokens, unitPriceText: pricing.reasoning, rounding: .plain)
    }

    /// ADR-0134 D2: the effort the server resolved for this job, normalized to the
    /// canonical lowercase token and bounded by migration 041's length CHECK
    /// (1…32). A blank or oversized payload value becomes NULL rather than
    /// aborting the whole reconcile transaction on a constraint violation — the
    /// ledger row (cost SoT) must never be lost to a cosmetic analysis field.
    /// The worker deliberately does not re-run the provider×model table here; the
    /// server already gated the value before it reached the job payload.
    static func normalizedEffort(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty, trimmed.count <= 32 else { return nil }
        return trimmed
    }

    static func microUSD(
        tokens: Int,
        unitPriceText: String,
        rounding: NSDecimalNumber.RoundingMode
    ) -> Int64 {
        guard tokens > 0 else { return 0 }
        let locale = Locale(identifier: "en_US_POSIX")
        let unitPrice = Decimal(string: unitPriceText, locale: locale) ?? 0
        var amount = unitPrice * Decimal(tokens)
        var rounded = Decimal()
        NSDecimalRound(&rounded, &amount, 0, rounding)
        return max(0, NSDecimalNumber(decimal: rounded).int64Value)
    }
}
