import Foundation
import Logging
import PostgresNIO

/// Multi-agent loop-safety gates (L4 §3.3 6-gate AND-combination + §3.4 A2A).
///
/// MOMO-301: the gates are backed by **real Postgres queries** (SoT = L4 §3.3
/// table), evaluated inside one transaction on the worker's claim/turn path.
/// The DB snapshot is the ONLY gate authority — there is deliberately no
/// payload-seeded pre-evaluation (removed in review: a payload fast-fail could
/// halt a run on stale seeds and contradict the DB-SoT contract).
///
///   G1 — per-agent concurrency: count of other `status='running'` runs vs
///        `agent.max_concurrent_runs`. Held states (`awaiting_approval`,
///        `paused`) are NOT counted — a run parked on a human decision must not
///        starve re-mentions of the same agent. Stale running runs (updated_at
///        older than `g1StaleRunningSeconds`, i.e. worker crashed mid-run) are
///        also excluded and surfaced for an audit_log observation, so a dead
///        run cannot permanently lock the agent out. The `agent` row is locked
///        `FOR UPDATE` as the per-agent gate mutex, so two workers claiming
///        jobs for the same agent serialize here and the winner's
///        `status='running'` claim commits before the loser counts.
///   G2 — per-agent consecutive auto-reply cap (§3.3 counter semantics): the
///        number of THIS agent's auto text utterances in the channel since the
///        last human utterance, one count per run. A human message resets the
///        counter structurally (§3.4 "사람 개입 리셋"); tool_call/tool_result/
///        system messages never count; other agents' messages neither count
///        nor reset (round-barrier compatible — scheduler lands with MOMO-313).
///   G3 — step hard cap: `agent_run.step_count` vs
///        `min(agent_run.max_steps, MAX_STEPS)` (schema CHECK is the backstop).
///        Each gate claim consumes one step (`step_count + 1` in the proceed
///        UPDATE), so the cap is actually enforced at runtime.
///   a2a_depth — §3.4 hop-depth cap: blocks when `agent_run.depth` EXCEEDS
///        `MAX_DEPTH` ("MAX_DEPTH=4 초과 시 차단" — depth 4 itself is valid;
///        the 007 migration CHECK `depth <= 4` agrees). Durable records use the
///        `a2a_depth` label, NOT "G4": the L4 §3.3 canonical G4 is the SimHash
///        semantic-loop detector (still a stub, `isSemanticLoop`). Once A2A
///        spawn exists, the real enforcement point is child-run creation
///        (reject when parent.depth >= MAX_DEPTH); this run-side gate is the
///        belt-and-suspenders check.
///
/// G5 (budget) lives in CostAccounting; G6 (approval) below.
struct LoopGuards: Sendable {
    let config: Config
    let logger: Logger

    // MARK: - DB-backed gate evaluation (MOMO-301, SoT = Postgres)

    /// What the guard saw in the database at evaluation time (one tx snapshot).
    struct DBGateSnapshot: Sendable, Equatable {
        var runStatus: String
        var stepCount: Int
        var runMaxSteps: Int          // agent_run.max_steps (per-run column)
        var depth: Int                // agent_run.depth (§3.4)
        var roundCount: Int           // agent_run.round_count (§3.4, stored; scheduler = MOMO-313)
        var consecutiveAutoStreak: Int // this agent's auto text runs since the last human message
        var activeOtherRuns: Int      // other status='running' runs (non-stale), id <> run
        var maxConcurrentRuns: Int    // agent.max_concurrent_runs (fallback: config)
        // Abandoned `running` runs (updated_at older than g1StaleRunningSeconds)
        // excluded from activeOtherRuns; the caller records an audit_log
        // observation for each. Failing them for real = follow-up reaper ticket.
        var staleRunningRunIDs: [UUID] = []
    }

    /// Gate decision over a DB snapshot, carrying the gate id for audit_log.
    enum GateOutcome: Sendable, Equatable {
        case proceed
        case tripped(gate: String, reason: String)
    }

    /// Pure gate verdict over a snapshot (testable without Postgres).
    func evaluateSnapshot(_ s: DBGateSnapshot) -> GateOutcome {
        // G1 — per-agent semaphore. Only *actually executing* runs count
        // (status='running', non-stale). queued runs are pending work already
        // serialized by the outbox partition_key; awaiting_approval/paused runs
        // are parked on a human decision and must not block re-mentions.
        if s.activeOtherRuns >= s.maxConcurrentRuns {
            return .tripped(
                gate: "G1",
                reason: "G1 concurrency cap: \(s.activeOtherRuns) other running run(s) for this agent (max_concurrent_runs=\(s.maxConcurrentRuns))")
        }
        // G2 — this agent's consecutive auto replies since the last human message.
        if s.consecutiveAutoStreak >= config.maxConsecutiveAuto {
            return .tripped(
                gate: "G2",
                reason: "G2 consecutive auto cap: \(s.consecutiveAutoStreak) consecutive auto replies by this agent since the last human message (MAX_CONSECUTIVE_AUTO=\(config.maxConsecutiveAuto))")
        }
        // G3 — step hard cap (run column, tightened by the env override).
        let stepCap = min(s.runMaxSteps, config.maxSteps)
        if s.stepCount >= stepCap {
            return .tripped(
                gate: "G3",
                reason: "G3 step cap: step_count=\(s.stepCount) (max_steps=\(stepCap))")
        }
        // a2a_depth — §3.4 hop cap: block when depth EXCEEDS MAX_DEPTH (spec
        // wording "MAX_DEPTH=4 초과 시 차단"; the 007 CHECK depth <= 4 agrees, so
        // depth 4 is a valid run). Labeled a2a_depth in durable records — the
        // canonical §3.3 G4 is the SimHash detector, not depth. When A2A spawn
        // lands, child creation must reject parent.depth >= MAX_DEPTH; this
        // run-side check is the backstop.
        if s.depth > config.maxDepth {
            return .tripped(
                gate: "a2a_depth",
                reason: "a2a_depth cap: depth=\(s.depth) exceeds MAX_DEPTH=\(config.maxDepth)")
        }
        return .proceed
    }

    /// Load the authoritative gate snapshot inside the caller's transaction.
    ///
    /// Locking contract (deadlock-free order: agent → agent_run):
    ///   1. `agent` row `FOR UPDATE` = per-agent gate mutex. Concurrent gate
    ///      evaluations for the same agent serialize here, so the G1 count reads
    ///      committed state after the winner's `status='running'` claim.
    ///   2. own `agent_run` row `FOR UPDATE` = counter read is stable vs the
    ///      subsequent proceed/trip UPDATE in the same tx.
    ///
    /// Returns nil when the agent_run row does not exist (nothing to guard).
    func loadSnapshot(
        on conn: PostgresConnection,
        agentMemberID: UUID,
        channelID: UUID,
        runID: UUID
    ) async throws -> DBGateSnapshot? {
        // 1. per-agent mutex + caps (agent rows always exist for dispatchable agents;
        //    fall back to config caps if a fixture run has no agent row).
        let agentRows = try await conn.query(
            """
            SELECT max_concurrent_runs, max_run_steps
              FROM agent
             WHERE member_id = \(agentMemberID)
             FOR UPDATE
            """,
            logger: logger
        ).collect()
        let agentMaxConcurrent: Int
        if let row = agentRows.first {
            let (maxConcurrent, _) = try row.decode((Int, Int).self)
            agentMaxConcurrent = maxConcurrent
        } else {
            agentMaxConcurrent = config.maxConcurrentRuns
        }

        // 2. own run row (counters SoT).
        let runRows = try await conn.query(
            """
            SELECT status::text, step_count, max_steps, depth, round_count, consecutive_auto_count
              FROM agent_run
             WHERE id = \(runID)
             FOR UPDATE
            """,
            logger: logger
        ).collect()
        guard let runRow = runRows.first else { return nil }
        let (status, stepCount, maxSteps, depth, roundCount, _) =
            try runRow.decode((String, Int, Int, Int, Int, Int).self)

        // 3. G1 — other *executing* runs for this agent: status='running' ONLY.
        //    Held states (awaiting_approval/paused) are parked on a human
        //    decision and must not permanently block re-mentions; queued runs
        //    are already serialized by the outbox partition_key. A running run
        //    whose updated_at is older than g1StaleRunningSeconds is treated as
        //    abandoned (worker crash) and excluded from the count — the caller
        //    records an audit_log observation per excluded run. TODO(follow-up
        //    reaper ticket): actually transition stale running runs to failed
        //    instead of only skipping them here.
        let staleSeconds = config.g1StaleRunningSeconds
        let runningRows = try await conn.query(
            """
            SELECT id,
                   (updated_at <= now() - (\(staleSeconds) * interval '1 second')) AS is_stale
              FROM agent_run
             WHERE agent_member_id = \(agentMemberID)
               AND id <> \(runID)
               AND status = 'running'
            """,
            logger: logger
        ).collect()
        var activeOthers = 0
        var staleRunIDs: [UUID] = []
        for row in runningRows {
            let (otherRunID, isStale) = try row.decode((UUID, Bool).self)
            if isStale {
                staleRunIDs.append(otherRunID)
            } else {
                activeOthers += 1
            }
        }

        // 4. G2 — per-agent counter (§3.3): THIS agent's auto text utterances in
        //    the channel since the last human utterance, one count per run
        //    (DISTINCT run_id; falls back to the message id for run-less rows).
        //    Semantics encoded here:
        //      * a human message of any type resets the counter (§3.4 사람 개입 리셋)
        //        — structurally, by bounding the count to seq > last human seq;
        //      * only type='text' counts — tool_call/tool_result are turn plumbing
        //        and system messages (e.g. guard-trip notices) must not let a trip
        //        amplify itself;
        //      * other agents' messages neither count nor reset, so A2A round
        //        alternation (A,B,A,B…) still trips each agent at its own cap
        //        (round scheduler = MOMO-313).
        let streakRows = try await conn.query(
            """
            WITH last_human AS (
              SELECT COALESCE(max(m.seq), 0) AS seq
                FROM message m
                JOIN member mem ON mem.id = m.author_member_id
               WHERE m.channel_id = \(channelID)
                 AND m.deleted_at IS NULL
                 AND mem.kind = 'human'
            )
            SELECT count(DISTINCT COALESCE(m.run_id::text, m.id::text))::int
              FROM message m, last_human h
             WHERE m.channel_id = \(channelID)
               AND m.deleted_at IS NULL
               AND m.author_member_id = \(agentMemberID)
               AND m.type = 'text'
               AND m.seq > h.seq
            """,
            logger: logger
        ).collect()
        let streak = try streakRows.first?.decode(Int.self) ?? 0

        return DBGateSnapshot(
            runStatus: status,
            stepCount: stepCount,
            runMaxSteps: maxSteps,
            depth: depth,
            roundCount: roundCount,
            consecutiveAutoStreak: streak,
            activeOtherRuns: activeOthers,
            maxConcurrentRuns: agentMaxConcurrent,
            staleRunningRunIDs: staleRunIDs
        )
    }

    /// G4: semantic-loop (SimHash) detector. Stub — returns false (no loop) until
    /// the content-window comparison is wired. Defaults: hamming<=3, window 6,
    /// threshold 3 (L4 §3.3, tuning-required).
    func isSemanticLoop(newHash: UInt64, previous: UInt64?) -> Bool {
        // TODO: maintain a per-(channel,agent) ring of recent content SimHashes and
        // count near-duplicates within the window. v0: never trips.
        false
    }

    /// G6: does this tool call require a human approval gate? (L4 §3.3 / §6.2).
    ///
    /// The authoritative input is the Context Packet `tool_grants` projection fed
    /// by Capability Cache v0. Missing, duplicate, mismatched, or unknown metadata
    /// fails closed into approval-required.
    func requiresApproval(
        toolName: String,
        toolGrants: [ToolGrantMetadata]?
    ) -> Bool {
        guard let toolGrants,
              let toolGrant = ToolGrantMetadata.singleMatch(in: toolGrants, toolName: toolName)
        else {
            return true
        }
        return requiresApproval(toolGrant: toolGrant)
    }

    func requiresApproval(toolGrant: ToolGrantMetadata) -> Bool {
        guard let policy = toolGrant.normalizedApprovalPolicy else {
            return true
        }

        switch policy {
        case "require_approval", "requires_approval", "approval_required", "always", "required":
            return true
        case "never", "none", "read_only", "readonly":
            return !toolGrant.isReadOnlyGrant
        default:
            // v0 has no runtime implementation for conditional policies such as
            // budget_threshold; pause so a human can decide instead of auto-running.
            return true
        }
    }

    /// Legacy MOMO-164 fallback. WorkerService no longer uses this when
    /// `tool_grants` metadata is absent, because MOMO-165 requires missing or
    /// ambiguous metadata to fail closed. Keep this isolated until all old tests
    /// and payload producers move to Context Packet metadata.
    func requiresApproval(toolName: String) -> Bool {
        // TODO(#79): delete this fallback once all producers send
        // agent_job.payload.tool_grants from the immutable Context Packet.
        let normalized = toolName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return true }

        let tokens = normalized.split { char in
            char == "." || char == "_" || char == "-" || char == "/" || char == ":"
        }.map(String.init)

        let sideEffectVerbs: Set<String> = [
            "approve", "assign", "cancel", "change", "close", "comment", "create",
            "delete", "deploy", "exec", "execute", "invite", "merge", "move",
            "post", "publish", "reject", "run", "send", "spend", "transition",
            "update", "upload", "write",
        ]
        if tokens.contains(where: sideEffectVerbs.contains) || normalized == "tool_call" {
            return true
        }

        let readOnlyVerbs: Set<String> = ["fetch", "find", "get", "list", "lookup", "query", "read", "search"]
        if tokens.contains(where: readOnlyVerbs.contains) {
            return false
        }

        return true
    }
}
