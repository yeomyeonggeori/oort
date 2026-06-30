import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Server-owned cost projection for experience B.
///
///   GET /v1/workspaces/{ws}/channels/{ch}/cost-snapshots
///
/// The API returns a client-visible projection from Postgres SoT tables:
/// `agent_run` carries the run identity/current reservation projection,
/// `usage_ledger` carries immutable reconciled spend, and `budget_window`
/// carries soft/hard limit state. macOS renders this contract instead of
/// deriving ledger math locally.
struct CostProjectionRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/channels/:ch/cost-snapshots", use: channelSnapshots)
    }

    @Sendable
    func channelSnapshots(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let (workspaceID, channelID) = try Self.scopeIDs(context, principal: principal)
        let limit = Self.validatedLimit(request.uri.queryParameters["limit"].map(String.init))

        let result: (isMember: Bool, page: CostSnapshotPageDTO?) = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let isMember = try await Self.hasActiveMembership(
                conn: conn,
                logger: db.logger,
                channelID: channelID,
                memberID: principal.memberID
            )
            guard isMember else { return (false, nil) }

            let snapshots = try await Self.fetchSnapshots(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                channelID: channelID,
                limit: limit
            )
            return (true, CostSnapshotPageDTO(
                schema: "momo.cost_snapshot.channel.v0",
                channelId: channelID.uuidString,
                snapshots: snapshots,
                asOfMs: Int64(Date().timeIntervalSince1970 * 1000)
            ))
        }

        guard result.isMember, let page = result.page else {
            throw HTTPError(.forbidden, message: "not a member of this channel")
        }
        return try page.response(from: request, context: context)
    }

    static func validatedLimit(_ raw: String?) -> Int {
        min(max(raw.flatMap { Int($0) } ?? 50, 1), 200)
    }

    static func limitState(observedMicroUSD: Int64, softLimitMicroUSD: Int64?, hardLimitMicroUSD: Int64?) -> String {
        if let hardLimitMicroUSD, observedMicroUSD >= hardLimitMicroUSD {
            return "hard_limit"
        }
        if let softLimitMicroUSD, observedMicroUSD >= softLimitMicroUSD {
            return "soft_limit"
        }
        return "normal"
    }

    private static func fetchSnapshots(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        channelID: UUID,
        limit: Int
    ) async throws -> [CostSnapshotDTO] {
        let rows = try await conn.query(
            """
            WITH runs AS (
              SELECT id,
                     agent_member_id,
                     channel_id,
                     status::text AS status,
                     input,
                     created_at
                FROM agent_run
               WHERE workspace_id = \(workspaceID)
                 AND channel_id = \(channelID)
               ORDER BY created_at DESC
               LIMIT \(limit)
            ),
            ledger AS (
              SELECT run_id,
                     COALESCE(sum(cost_micro_usd), 0)::bigint AS spent_micro_usd,
                     COALESCE(bool_or(was_estimated), false) AS was_estimated,
                     count(*)::bigint AS ledger_count
                FROM usage_ledger
               WHERE workspace_id = \(workspaceID)
                 AND channel_id = \(channelID)
                 AND run_id IN (SELECT id FROM runs)
               GROUP BY run_id
            )
            SELECT r.id,
                   CASE
                     WHEN r.status IN ('queued','running','awaiting_approval','paused')
                     THEN COALESCE((r.input #>> '{cost_projection,reserved_micro_usd}')::bigint, 0)
                     ELSE 0
                   END AS reserved_micro_usd,
                   COALESCE(l.spent_micro_usd, 0)::bigint AS spent_micro_usd,
                   budget.soft_limit_micro_usd,
                   budget.hard_limit_micro_usd,
                   COALESCE(l.ledger_count, 0) > 0 AS is_reconciled,
                   COALESCE(l.was_estimated, false) AS was_estimated,
                   CASE
                     WHEN budget.hard_limit_micro_usd IS NOT NULL
                      AND GREATEST(
                            COALESCE(budget.observed_micro_usd, 0),
                            COALESCE(l.spent_micro_usd, 0)
                            + CASE
                                WHEN r.status IN ('queued','running','awaiting_approval','paused')
                                THEN COALESCE((r.input #>> '{cost_projection,reserved_micro_usd}')::bigint, 0)
                                ELSE 0
                              END
                          ) >= budget.hard_limit_micro_usd
                     THEN 'hard_limit'
                     WHEN budget.soft_limit_micro_usd IS NOT NULL
                      AND GREATEST(
                            COALESCE(budget.observed_micro_usd, 0),
                            COALESCE(l.spent_micro_usd, 0)
                            + CASE
                                WHEN r.status IN ('queued','running','awaiting_approval','paused')
                                THEN COALESCE((r.input #>> '{cost_projection,reserved_micro_usd}')::bigint, 0)
                                ELSE 0
                              END
                          ) >= budget.soft_limit_micro_usd
                     THEN 'soft_limit'
                     ELSE 'normal'
                   END AS limit_state
              FROM runs r
              LEFT JOIN ledger l ON l.run_id = r.id
              LEFT JOIN LATERAL (
                WITH matched AS (
                  SELECT b.id,
                         b.limit_micro_usd,
                         b.soft_limit_micro_usd,
                         to_timestamp(
                           floor(extract(epoch from now()) / b.period_seconds)
                           * b.period_seconds
                         ) AS period_start
                    FROM budget b
                   WHERE b.workspace_id = \(workspaceID)
                     AND (
                       b.grain::text = 'workspace'
                       OR (b.grain::text = 'agent' AND b.agent_member_id = r.agent_member_id)
                       OR (b.grain::text = 'channel' AND b.channel_id = r.channel_id)
                       OR (b.grain::text = 'workspace_agent' AND b.agent_member_id = r.agent_member_id)
                       OR (b.grain::text = 'agent_channel'
                           AND b.agent_member_id = r.agent_member_id
                           AND b.channel_id = r.channel_id)
                     )
                )
                SELECT MIN(m.limit_micro_usd)::bigint AS hard_limit_micro_usd,
                       MIN(m.soft_limit_micro_usd) FILTER (
                         WHERE m.soft_limit_micro_usd IS NOT NULL
                       )::bigint AS soft_limit_micro_usd,
                       MAX(
                         COALESCE(w.reserved_micro_usd, 0)
                         + COALESCE(w.spent_micro_usd, 0)
                       )::bigint AS observed_micro_usd
                  FROM matched m
                  LEFT JOIN budget_window w
                    ON w.budget_id = m.id
                   AND w.period_start = m.period_start
              ) budget ON true
             ORDER BY r.created_at DESC
            """,
            logger: logger
        ).collect()

        return try rows.map { row in
            let (runID, reserved, spent, softLimit, hardLimit, reconciled, estimated, state) =
                try row.decode((UUID, Int64, Int64, Int64?, Int64?, Bool, Bool, String).self)
            return CostSnapshotDTO(
                runId: runID.uuidString,
                reservedMicroUSD: reserved,
                spentMicroUSD: spent,
                softLimitMicroUSD: softLimit,
                hardLimitMicroUSD: hardLimit,
                isReconciled: reconciled,
                wasEstimated: estimated,
                limitState: state
            )
        }
    }

    private static func hasActiveMembership(
        conn: PostgresConnection,
        logger: Logger,
        channelID: UUID,
        memberID: UUID
    ) async throws -> Bool {
        let rows = try await conn.query(
            """
            SELECT 1
              FROM membership
             WHERE channel_id = \(channelID)
               AND member_id = \(memberID)
               AND left_at IS NULL
             LIMIT 1
            """,
            logger: logger
        ).collect()
        return !rows.isEmpty
    }

    private static func scopeIDs(
        _ context: AppRequestContext, principal: AuthPrincipal
    ) throws -> (workspace: UUID, channel: UUID) {
        let wsParam = try context.parameters.require("ws")
        let chParam = try context.parameters.require("ch")
        guard let ws = UUID(uuidString: wsParam) else {
            throw HTTPError(.badRequest, message: "invalid workspace id")
        }
        guard let ch = UUID(uuidString: chParam) else {
            throw HTTPError(.badRequest, message: "invalid channel id")
        }
        guard ws == principal.workspaceID else {
            throw HTTPError(.forbidden, message: "workspace scope mismatch")
        }
        return (ws, ch)
    }
}
