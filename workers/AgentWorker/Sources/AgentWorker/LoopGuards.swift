import Foundation
import Logging
import PostgresNIO

/// Multi-agent loop-safety gates (L4 §3.3 6-gate AND-combination + §3.4 A2A).
///
/// v0 implements these as **function stubs with default-value constants** (per the
/// T07 ticket): the structure, parameters, and decision points are real, but the
/// authoritative DB checks (partial-unique active-run row, read_state consecutive
/// counter, SimHash window, budget_window) are TODO-marked. The SoT for every
/// gate is Postgres (L4 §3.3 table), so these stubs return the *gate decision*
/// the worker loop branches on; wiring the real queries is a follow-up.
///
/// runtime-unverified (no psql): the SQL referenced in TODOs is shaped to
/// schema_v0 but not executed in this build env.
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

    /// Evaluate G1–G3 + §3.4 depth before invoking hermes. G4 (SimHash) and G5
    /// (budget) are checked at their own call sites (post-stream / pre-reserve).
    /// G6 (human approval) is triggered inline when a tool_call needs it.
    func evaluatePreInvoke(_ s: RunGateState) -> Verdict {
        // G1 — per-agent semaphore (schema: agent_run partial-unique active row +
        // agent.max_concurrent_runs). Stub: compare claimed active-run count.
        // TODO: SELECT count(*) FROM agent_run WHERE agent_member_id=$1
        //       AND status IN ('queued','running','awaiting_approval','paused').
        if !checkConcurrency(activeRuns: s.activeRunsForAgent) {
            return .halt(reason: "G1 concurrency cap (max_concurrent_runs=\(config.maxConcurrentRuns))")
        }
        // G2 — consecutive auto-reply cap. Stub: counter from read_state. A human
        // utterance resets this to 0 (L4 §3.4 — handled at message-ingest, TODO).
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

    // MARK: - Individual gate stubs (default-value constants, L4 §3.3)

    /// G1: per-agent concurrent-run semaphore. DB SoT = agent_run partial-unique.
    func checkConcurrency(activeRuns: Int) -> Bool {
        activeRuns < config.maxConcurrentRuns
        // TODO: the claim tx itself should assert this against the live-run index;
        // the in-process check is a fast-fail complement, not the authority.
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
    /// Side-effecting actions always gate. Until Capability Cache risk metadata is
    /// wired into the job payload, unknown tool names fail closed into approval.
    func requiresApproval(toolName: String) -> Bool {
        // TODO(#77): replace this conservative name heuristic with Capability Cache
        // risk/approval_policy evidence from the immutable Context Packet.
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
