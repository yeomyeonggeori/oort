import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Workspace usage summary read projection (MOMO-615, AX-7 layer 1).
///
///   GET /v1/workspaces/{ws}/usage/summary?from=<ISO8601>&to=<ISO8601>&bucket=day|week|month
///
/// `usage_ledger` is the immutable system of record for reconciled spend; this
/// route only aggregates it. Nothing is written, so no migration is required —
/// the `usage_ledger_ws_time_idx (workspace_id, created_at DESC)` index already
/// covers the workspace+time predicate.
///
/// Authorization mirrors the roster read: any active workspace member may read
/// the summary ("워크스페이스에서 발생하는 과금은 사용자가 전부 트래킹"). The handler
/// uses the normal tenant connection under FORCE RLS; cross-tenant reads and
/// bypass roles are never used here.
///
/// Semantics fixed by this implementation (the handoff contract leaves them open):
///   - the time filter is inclusive on both ends (`created_at BETWEEN from AND to`),
///     matching `AuditRoutes`' existing from/to convention;
///   - bucket boundaries are computed in UTC regardless of the database session
///     timezone, so `week` is the ISO week starting Monday 00:00:00Z;
///   - an empty period is `200` with zero totals and empty arrays, never `404`.
struct UsageSummaryRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/usage/summary", use: summary)
    }

    @Sendable
    func summary(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let query = request.uri.queryParameters
        let window = try Self.validatedWindow(
            from: query["from"].map(String.init),
            to: query["to"].map(String.init),
            bucket: query["bucket"].map(String.init),
            now: Date()
        )

        let result: (isMember: Bool, payload: UsageSummaryDTO?) = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let role = try await WorkspaceAuthorization.activeRole(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID
            )
            guard role != nil else { return (false, nil) }

            let totals = try await Self.fetchTotals(
                conn: conn, logger: db.logger, workspaceID: workspaceID, window: window
            )
            let buckets = try await Self.fetchBuckets(
                conn: conn, logger: db.logger, workspaceID: workspaceID, window: window
            )
            let byModel = try await Self.fetchByModel(
                conn: conn, logger: db.logger, workspaceID: workspaceID, window: window
            )
            let byAgent = try await Self.fetchByAgent(
                conn: conn, logger: db.logger, workspaceID: workspaceID, window: window
            )
            let budget = try await Self.fetchWorkspaceBudget(
                conn: conn, logger: db.logger, workspaceID: workspaceID
            )
            return (true, UsageSummaryDTO(
                range: UsageSummaryRangeDTO(
                    from: Self.iso8601(window.from),
                    to: Self.iso8601(window.to),
                    bucket: window.bucket.rawValue
                ),
                totals: totals,
                buckets: buckets,
                byModel: byModel,
                byAgent: byAgent,
                budget: budget
            ))
        }

        guard result.isMember, let payload = result.payload else {
            throw HTTPError(.forbidden, message: "not a workspace member")
        }
        return try payload.response(from: request, context: context)
    }

    // MARK: - Range validation

    enum Bucket: String, CaseIterable, Sendable {
        case day
        case week
        case month
    }

    struct Window: Equatable, Sendable {
        let from: Date
        let to: Date
        let bucket: Bucket
    }

    /// Default lookback when `from` is omitted (contract: `from = to - 30d`).
    static let defaultLookbackSeconds: TimeInterval = 30 * 86_400
    /// Hard ceiling on the requested span (contract: 93 days, over it is 400).
    static let maxRangeSeconds: TimeInterval = 93 * 86_400

    static func validatedWindow(
        from: String?,
        to: String?,
        bucket: String?,
        now: Date
    ) throws -> Window {
        let resolvedBucket: Bucket
        if let raw = bucket?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
           !raw.isEmpty {
            guard let parsed = Bucket(rawValue: raw) else {
                throw HTTPError(.badRequest, message: "bucket must be day, week, or month")
            }
            resolvedBucket = parsed
        } else {
            resolvedBucket = .day
        }

        let upper = try parseTimestamp(to, label: "to") ?? now
        let lower = try parseTimestamp(from, label: "from")
            ?? upper.addingTimeInterval(-defaultLookbackSeconds)
        guard lower <= upper else {
            throw HTTPError(.badRequest, message: "from must not be later than to")
        }
        guard upper.timeIntervalSince(lower) <= maxRangeSeconds else {
            throw HTTPError(.badRequest, message: "range must not exceed 93 days")
        }
        return Window(from: lower, to: upper, bucket: resolvedBucket)
    }

    static func parseTimestamp(_ raw: String?, label: String) throws -> Date? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        for options in timestampFormatOptions {
            let formatter = ISO8601DateFormatter()
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.formatOptions = options
            if let parsed = formatter.date(from: trimmed) { return parsed }
        }
        throw HTTPError(.badRequest, message: "\(label) must be an ISO8601 timestamp")
    }

    private static let timestampFormatOptions: [ISO8601DateFormatter.Options] = [
        [.withInternetDateTime, .withFractionalSeconds],
        [.withInternetDateTime],
        [.withFullDate],
    ]

    static func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    // MARK: - Aggregation

    private static func fetchTotals(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        window: Window
    ) async throws -> UsageSummaryTotalsDTO {
        let rows = try await conn.query(
            """
            SELECT COALESCE(sum(cost_micro_usd), 0)::bigint AS cost_micro_usd,
                   COALESCE(sum(cost_micro_usd) FILTER (WHERE was_estimated), 0)::bigint
                     AS estimated_micro_usd,
                   COALESCE(sum(prompt_tokens), 0)::bigint AS prompt_tokens,
                   COALESCE(sum(completion_tokens), 0)::bigint AS completion_tokens
              FROM usage_ledger
             WHERE workspace_id = \(workspaceID)
               AND created_at >= \(window.from)
               AND created_at <= \(window.to)
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            return UsageSummaryTotalsDTO(
                costMicroUsd: 0, estimatedMicroUsd: 0, promptTokens: 0, completionTokens: 0
            )
        }
        let (cost, estimated, prompt, completion) = try row.decode((Int64, Int64, Int64, Int64).self)
        return UsageSummaryTotalsDTO(
            costMicroUsd: cost,
            estimatedMicroUsd: estimated,
            promptTokens: prompt,
            completionTokens: completion
        )
    }

    private static func fetchBuckets(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        window: Window
    ) async throws -> [UsageSummaryBucketDTO] {
        let rows = try await conn.query(
            """
            SELECT (date_trunc(\(window.bucket.rawValue)::text, created_at AT TIME ZONE 'UTC')
                      AT TIME ZONE 'UTC') AS bucket_start,
                   COALESCE(sum(cost_micro_usd), 0)::bigint AS cost_micro_usd,
                   COALESCE(sum(prompt_tokens), 0)::bigint AS prompt_tokens,
                   COALESCE(sum(completion_tokens), 0)::bigint AS completion_tokens
              FROM usage_ledger
             WHERE workspace_id = \(workspaceID)
               AND created_at >= \(window.from)
               AND created_at <= \(window.to)
             GROUP BY 1
             ORDER BY 1
            """,
            logger: logger
        ).collect()
        return try rows.map { row in
            let (start, cost, prompt, completion) = try row.decode((Date, Int64, Int64, Int64).self)
            return UsageSummaryBucketDTO(
                start: iso8601(start),
                costMicroUsd: cost,
                promptTokens: prompt,
                completionTokens: completion
            )
        }
    }

    private static func fetchByModel(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        window: Window
    ) async throws -> [UsageSummaryModelDTO] {
        let rows = try await conn.query(
            """
            SELECT model,
                   COALESCE(sum(cost_micro_usd), 0)::bigint AS cost_micro_usd,
                   COALESCE(sum(prompt_tokens), 0)::bigint AS prompt_tokens,
                   COALESCE(sum(completion_tokens), 0)::bigint AS completion_tokens
              FROM usage_ledger
             WHERE workspace_id = \(workspaceID)
               AND created_at >= \(window.from)
               AND created_at <= \(window.to)
             GROUP BY model
             ORDER BY cost_micro_usd DESC, model ASC
            """,
            logger: logger
        ).collect()
        return try rows.map { row in
            let (model, cost, prompt, completion) = try row.decode((String, Int64, Int64, Int64).self)
            return UsageSummaryModelDTO(
                model: model,
                costMicroUsd: cost,
                promptTokens: prompt,
                completionTokens: completion
            )
        }
    }

    private static func fetchByAgent(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        window: Window
    ) async throws -> [UsageSummaryAgentDTO] {
        let rows = try await conn.query(
            """
            SELECT u.agent_member_id,
                   COALESCE(m.display_name, '') AS display_name,
                   COALESCE(sum(u.cost_micro_usd), 0)::bigint AS cost_micro_usd,
                   COALESCE(sum(u.prompt_tokens), 0)::bigint AS prompt_tokens,
                   COALESCE(sum(u.completion_tokens), 0)::bigint AS completion_tokens
              FROM usage_ledger u
              LEFT JOIN member m
                ON m.id = u.agent_member_id
               AND m.workspace_id = u.workspace_id
             WHERE u.workspace_id = \(workspaceID)
               AND u.created_at >= \(window.from)
               AND u.created_at <= \(window.to)
             GROUP BY u.agent_member_id, m.display_name
             ORDER BY cost_micro_usd DESC, u.agent_member_id ASC
            """,
            logger: logger
        ).collect()
        return try rows.map { row in
            let (agentID, displayName, cost, prompt, completion) =
                try row.decode((UUID, String, Int64, Int64, Int64).self)
            return UsageSummaryAgentDTO(
                agentMemberId: agentID.uuidString.lowercased(),
                displayName: displayName,
                costMicroUsd: cost,
                promptTokens: prompt,
                completionTokens: completion
            )
        }
    }

    /// Workspace-grain budget projection. This is the `grain = 'workspace'` arm of
    /// the `CostProjectionRoutes` matcher plus its MIN(limit) adoption rule: the
    /// tightest workspace budget wins, and its own rolling window row supplies
    /// spent/reserved so grain, period, and counters stay from one budget row.
    private static func fetchWorkspaceBudget(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID
    ) async throws -> UsageSummaryBudgetDTO? {
        let rows = try await conn.query(
            """
            SELECT b.grain::text AS grain,
                   b.limit_micro_usd::bigint AS limit_micro_usd,
                   b.soft_limit_micro_usd::bigint AS soft_limit_micro_usd,
                   COALESCE(w.spent_micro_usd, 0)::bigint AS spent_micro_usd,
                   COALESCE(w.reserved_micro_usd, 0)::bigint AS reserved_micro_usd,
                   p.period_start
              FROM budget b
              CROSS JOIN LATERAL (
                SELECT to_timestamp(
                         floor(extract(epoch from now()) / b.period_seconds)
                         * b.period_seconds
                       ) AS period_start
              ) p
              LEFT JOIN budget_window w
                ON w.budget_id = b.id
               AND w.period_start = p.period_start
             WHERE b.workspace_id = \(workspaceID)
               AND b.grain::text = 'workspace'
             ORDER BY b.limit_micro_usd ASC, b.id ASC
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else { return nil }
        let (grain, limit, softLimit, spent, reserved, periodStart) =
            try row.decode((String, Int64, Int64?, Int64, Int64, Date).self)
        return UsageSummaryBudgetDTO(
            grain: grain,
            limitMicroUsd: limit,
            spentMicroUsd: spent,
            reservedMicroUsd: reserved,
            state: CostProjectionRoutes.limitState(
                observedMicroUSD: spent + reserved,
                softLimitMicroUSD: softLimit,
                hardLimitMicroUSD: limit
            ),
            periodStart: iso8601(periodStart)
        )
    }
}

// MARK: - Wire DTOs

struct UsageSummaryRangeDTO: Codable, Sendable, Equatable {
    let from: String
    let to: String
    let bucket: String
}

struct UsageSummaryTotalsDTO: Codable, Sendable, Equatable {
    let costMicroUsd: Int64
    let estimatedMicroUsd: Int64
    let promptTokens: Int64
    let completionTokens: Int64
}

struct UsageSummaryBucketDTO: Codable, Sendable, Equatable {
    let start: String
    let costMicroUsd: Int64
    let promptTokens: Int64
    let completionTokens: Int64
}

struct UsageSummaryModelDTO: Codable, Sendable, Equatable {
    let model: String
    let costMicroUsd: Int64
    let promptTokens: Int64
    let completionTokens: Int64
}

struct UsageSummaryAgentDTO: Codable, Sendable, Equatable {
    let agentMemberId: String
    let displayName: String
    let costMicroUsd: Int64
    let promptTokens: Int64
    let completionTokens: Int64
}

struct UsageSummaryBudgetDTO: Codable, Sendable, Equatable {
    let grain: String
    let limitMicroUsd: Int64
    let spentMicroUsd: Int64
    let reservedMicroUsd: Int64
    let state: String
    let periodStart: String
}

struct UsageSummaryDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let range: UsageSummaryRangeDTO
    let totals: UsageSummaryTotalsDTO
    let buckets: [UsageSummaryBucketDTO]
    let byModel: [UsageSummaryModelDTO]
    let byAgent: [UsageSummaryAgentDTO]
    let budget: UsageSummaryBudgetDTO?

    private enum CodingKeys: String, CodingKey {
        case range, totals, buckets, byModel, byAgent, budget
    }

    /// The contract pins `"budget": null | {...}`, so the key must survive
    /// encoding when no workspace-grain budget exists (synthesized `Encodable`
    /// would drop it via `encodeIfPresent`).
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(range, forKey: .range)
        try container.encode(totals, forKey: .totals)
        try container.encode(buckets, forKey: .buckets)
        try container.encode(byModel, forKey: .byModel)
        try container.encode(byAgent, forKey: .byAgent)
        try container.encode(budget, forKey: .budget)
    }
}
