import Foundation
import Logging
import PostgresNIO

/// Multi-agent loop-safety gates (L4 §3.3 6-gate AND-combination + §3.4 A2A).
///
/// MOMO-301: G1–G4 are backed by **real Postgres queries** (SoT = L4 §3.3 table),
/// evaluated inside one transaction on the worker's claim/turn path:
///
///   G1 — per-agent concurrency: count of other live runs
///        (`running/awaiting_approval/paused`) vs `agent.max_concurrent_runs`.
///        The `agent` row is locked `FOR UPDATE` as the per-agent gate mutex, so
///        two workers claiming jobs for the same agent serialize here and the
///        winner's `status='running'` claim commits before the loser counts.
///   G2 — consecutive auto-reply cap: the trailing streak of agent-authored
///        (non-`system`) messages at the channel tail. A human utterance resets
///        the streak to 0 structurally (it breaks the tail), matching §3.4
///        "사람 개입 리셋" without a separate ingest-path counter write.
///   G3 — step hard cap: `agent_run.step_count` vs
///        `min(agent_run.max_steps, MAX_STEPS)` (schema CHECK is the backstop).
///   G4 — A2A hop-depth cap (§3.4): `agent_run.depth` vs `MAX_DEPTH`; the 007
///        migration also enforces `depth <= 4` as a CHECK at the SoT.
///
/// Gate id note: MOMO-301 numbers depth as **G4**. The L4 §3.3 table's own G4
/// (SimHash semantic-loop detector) remains a stub (`isSemanticLoop`) and is out
/// of MOMO-301 scope; G5 (budget) lives in CostAccounting, G6 (approval) below.
///
/// The payload-seeded `evaluatePreInvoke` remains as a zero-round-trip fast-fail
/// complement; the DB snapshot is authoritative and wins on disagreement.
struct LoopGuards: Sendable {
    let config: Config
    let logger: Logger

    /// Aggregate gate verdict. `.proceed` runs the turn; `.halt(reason)` aborts
    /// before any hermes call (no spend, no publish) and marks the run failed.
    enum Verdict: Sendable, Equatable {
        case proceed
        case halt(reason: String)
    }

    /// Snapshot of the run's gate-relevant counters (claimed from agent_run +
    /// read_state). v0 fills these from the job payload / defaults.
    struct RunGateState: Sendable {
        var stepCount: Int
        var depth: Int
        var consecutiveAuto: Int
        var activeRunsForAgent: Int
        var lastContentHash: UInt64?   // for G4 SimHash window (stub)
    }

    /// Evaluate G1–G3 + §3.4 depth on **payload seeds** before the DB round-trip
    /// (fast-fail complement — the DB snapshot path in loadSnapshot/evaluateSnapshot
    /// is authoritative). SimHash and G5 (budget) are checked at their own call
    /// sites; G6 (human approval) is triggered inline when a tool_call needs it.
    func evaluatePreInvoke(_ s: RunGateState) -> Verdict {
        // G1 — per-agent semaphore. Payload seed only; the authority is the
        // agent-row-locked live-run count in loadSnapshot (MOMO-301).
        if !checkConcurrency(activeRuns: s.activeRunsForAgent) {
            return .halt(reason: "G1 concurrency cap (max_concurrent_runs=\(config.maxConcurrentRuns))")
        }
        // G2 — consecutive auto-reply cap. Payload seed; the authority is the
        // message-tail streak in loadSnapshot (human utterance breaks the tail).
        if !checkConsecutiveAuto(count: s.consecutiveAuto) {
            return .halt(reason: "G2 consecutive auto cap (MAX_CONSECUTIVE_AUTO=\(config.maxConsecutiveAuto))")
        }
        // G3 — step hard cap (turn-level infinite tool-call guard).
        if !checkStepCap(stepCount: s.stepCount) {
            return .halt(reason: "G3 step cap (max_steps=\(config.maxSteps))")
        }
        // §3.4 — A→B→A hop depth cap.
        if !checkDepth(depth: s.depth) {
            return .halt(reason: "depth cap (MAX_DEPTH=\(config.maxDepth))")
        }
        return .proceed
    }

    // MARK: - DB-backed gate evaluation (MOMO-301, SoT = Postgres)

    /// What the guard saw in the database at evaluation time (one tx snapshot).
    struct DBGateSnapshot: Sendable, Equatable {
        var runStatus: String
        var stepCount: Int
        var runMaxSteps: Int          // agent_run.max_steps (per-run column)
        var depth: Int                // agent_run.depth (§3.4)
        var roundCount: Int           // agent_run.round_count (§3.4, stored; scheduler = MOMO-313)
        var consecutiveAutoStreak: Int // trailing agent-authored streak (message tail)
        var activeOtherRuns: Int      // running/awaiting_approval/paused, id <> run
        var maxConcurrentRuns: Int    // agent.max_concurrent_runs (fallback: config)
    }

    /// Gate decision over a DB snapshot, carrying the gate id for audit_log.
    enum GateOutcome: Sendable, Equatable {
        case proceed
        case tripped(gate: String, reason: String)
    }

    /// Pure G1–G4 verdict over a snapshot (testable without Postgres).
    func evaluateSnapshot(_ s: DBGateSnapshot) -> GateOutcome {
        // G1 — per-agent semaphore. Only *executing/held* runs count; queued runs
        // are pending work already serialized by the outbox partition_key and must
        // not starve their own agent.
        if s.activeOtherRuns >= s.maxConcurrentRuns {
            return .tripped(
                gate: "G1",
                reason: "G1 concurrency cap: \(s.activeOtherRuns) other live run(s) for this agent (max_concurrent_runs=\(s.maxConcurrentRuns))")
        }
        // G2 — consecutive agent auto-replies at the channel tail.
        if s.consecutiveAutoStreak >= config.maxConsecutiveAuto {
            return .tripped(
                gate: "G2",
                reason: "G2 consecutive auto cap: \(s.consecutiveAutoStreak) trailing agent replies (MAX_CONSECUTIVE_AUTO=\(config.maxConsecutiveAuto))")
        }
        // G3 — step hard cap (run column, tightened by the env override).
        let stepCap = min(s.runMaxSteps, config.maxSteps)
        if s.stepCount >= stepCap {
            return .tripped(
                gate: "G3",
                reason: "G3 step cap: step_count=\(s.stepCount) (max_steps=\(stepCap))")
        }
        // G4 — §3.4 A→B→A hop depth cap (MOMO-301 gate id; schema CHECK <= 4).
        if s.depth >= config.maxDepth {
            return .tripped(
                gate: "G4",
                reason: "G4 depth cap: depth=\(s.depth) (MAX_DEPTH=\(config.maxDepth))")
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
    /// Returns nil when the agent_run row does not exist (nothing to guard —
    /// the payload-seeded fast-fail already ran).
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

        // 3. G1 — other live runs for this agent (schema agent_run_active_idx
        //    statuses minus 'queued'; see evaluateSnapshot for the rationale).
        let activeRows = try await conn.query(
            """
            SELECT count(*)::int
              FROM agent_run
             WHERE agent_member_id = \(agentMemberID)
               AND id <> \(runID)
               AND status IN ('running','awaiting_approval','paused')
            """,
            logger: logger
        ).collect()
        let activeOthers = try activeRows.first?.decode(Int.self) ?? 0

        // 4. G2 — trailing agent-authored streak at the channel tail. `system`
        //    messages (e.g. guard-trip notices) are invisible to the streak so a
        //    trip cannot amplify itself; a human message breaks the streak.
        let streakBound = config.maxConsecutiveAuto + 1
        let streakRows = try await conn.query(
            """
            WITH tail AS (
              SELECT m.seq, mem.kind::text AS kind
                FROM message m
                JOIN member mem ON mem.id = m.author_member_id
               WHERE m.channel_id = \(channelID)
                 AND m.deleted_at IS NULL
                 AND m.type <> 'system'
               ORDER BY m.seq DESC
               LIMIT \(streakBound)
            )
            SELECT count(*)::int
              FROM (
                SELECT bool_and(kind = 'agent') OVER (
                         ORDER BY seq DESC
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                       ) AS trailing_agent
                  FROM tail
              ) t
             WHERE trailing_agent
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
            maxConcurrentRuns: agentMaxConcurrent
        )
    }

    // MARK: - Individual gate checks (payload-seeded fast-fail complement)

    /// G1: per-agent concurrent-run semaphore. DB SoT = loadSnapshot/evaluateSnapshot;
    /// this in-process check is a fast-fail complement, not the authority.
    func checkConcurrency(activeRuns: Int) -> Bool {
        activeRuns < config.maxConcurrentRuns
    }

    /// G2: consecutive agent auto-replies before forced halt. DB SoT = read_state.
    func checkConsecutiveAuto(count: Int) -> Bool {
        count < config.maxConsecutiveAuto
    }

    /// G3: per-turn step hard cap. DB SoT = agent_run.step_count <= max_steps
    /// (schema CHECK constraint agent_run_step_cap_ck).
    func checkStepCap(stepCount: Int) -> Bool {
        stepCount < config.maxSteps
    }

    /// §3.4: A2A hop-depth cap. DB SoT = agent_run.depth.
    func checkDepth(depth: Int) -> Bool {
        depth < config.maxDepth
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
