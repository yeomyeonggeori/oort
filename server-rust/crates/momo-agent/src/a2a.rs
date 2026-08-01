//! A2A (agent→agent) delegation policy: the depth cap, the §3.3 loop gates, and
//! the chain spend ceiling (B7.2).
//!
//! ## What B5.2 left closed, and why this module is the key
//!
//! `routes::agent_mentions` refuses an agent-authored mention outright
//! (`a2a_source_run_unavailable`): the HTTP send path has no source run, so the
//! child run would have to be created at `depth = 0` and the hop cap would be
//! unenforceable. Fail closed was the right answer **there**.
//!
//! The agent worker has the thing the route was missing. When it commits a turn
//! it is holding the run that produced the reply, so an `@mention` inside that
//! reply has a parent (`agent_run.parent_run_id`) and an inherited depth
//! (`parent.depth + 1`). That is the enforcement point Swift's own
//! `LoopGuards.swift:37-40` names:
//!
//! > Once A2A spawn exists, the real enforcement point is child-run creation
//! > (reject when `parent.depth >= MAX_DEPTH`); this run-side gate is the
//! > belt-and-suspenders check.
//!
//! ## The gates, measured (`workers/AgentWorker/.../LoopGuards.swift:13-105`)
//!
//! | id | quantity | trips when | Swift default |
//! |---|---|---|---|
//! | G1 | other **`status='running'`** runs of the target agent, stale ones excluded | `>= agent.max_concurrent_runs` | `MAX_CONCURRENT_RUNS` fallback, `G1_STALE_RUNNING_SECONDS=600` |
//! | G2 | the target agent's `type='text'` utterances since the channel's last **human** message, one per run | `>= MAX_CONSECUTIVE_AUTO` | 3 |
//! | G3 | the **source** run's `step_count` | `>= min(run.max_steps, MAX_STEPS)` | 12 |
//! | `a2a_depth` | the source run's `depth` | `> MAX_DEPTH` run-side / `>= MAX_DEPTH` at spawn | 4 |
//!
//! Two things in that table are measurements, not guesses, and both were
//! *predicted differently* by the ticket:
//!
//! * the gates are **not** "same-chain revisit / round-trip / time window" —
//!   G1 is a semaphore, G2 is a per-agent streak, G3 is a step cap;
//! * the depth gate is **not** `G4`. Swift labels it `a2a_depth` in every
//!   durable record precisely because the canonical L4 §3.3 G4 is the SimHash
//!   semantic-loop detector (`isSemanticLoop`, still a stub). This module keeps
//!   that label, so an audit row written by either implementation reads the same.
//!
//! ## Ordering
//!
//! [`evaluate_a2a_spawn`] evaluates G1 → G2 → G3 → `a2a_depth` → chain budget.
//! The first four are Swift's order verbatim (`evaluateSnapshot` :72-106); the
//! budget comes last because Swift keeps it out of `LoopGuards` entirely (G5
//! lives in `CostAccounting`), so appending it cannot change any verdict Swift
//! would have reached.
//!
//! ## What this module does not own
//!
//! It owns **no `INSERT`**, exactly like [`crate::mention`]: it reads the
//! counters, returns a verdict and builds the strings, and the worker composes
//! that with `momo_messaging::send_message_in_tx` (the system line),
//! `momo_outbox::emit_outbox` (the job) and `momo_db::audit` (the record) inside
//! one transaction. The G2 streak is a **`message` count**, so it is not read
//! here either — `momo_messaging::agent_auto_reply_streak_in_tx` owns it and the
//! caller passes the number in.

use momo_db::DbError;
use serde_json::{json, Map, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// `agent_run_depth_a2a_cap_ck` (`007_agent_run_a2a_guards.sql:34`) rejects
/// `depth > 4` at the SoT. Every configured cap is clamped to it, so a
/// mistyped `A2A_MAX_DEPTH=99` produces a *policy* refusal rather than a CHECK
/// violation that would abort the whole turn transaction — the reply, the
/// ledger row and the run transition included.
pub const SCHEMA_DEPTH_CEILING: i32 = 4;

/// `A2A_MAX_DEPTH` default. Tighter than Swift's `MAX_DEPTH=4`
/// (`Config.swift:139`) on purpose: 3 is what the B7.2 ticket specifies, and a
/// tighter app-layer cap is always representable under the schema ceiling.
pub const DEFAULT_A2A_MAX_DEPTH: i32 = 3;

/// `MAX_CONSECUTIVE_AUTO` — Swift `Config.swift:137`.
pub const DEFAULT_MAX_CONSECUTIVE_AUTO: i32 = 3;

/// `MAX_STEPS` — Swift `Config.swift:138`.
pub const DEFAULT_MAX_STEPS: i32 = 12;

/// `G1_STALE_RUNNING_SECONDS` — Swift `Config.swift:141`. A `running` run older
/// than this is a crashed worker's residue, not an occupied slot.
pub const DEFAULT_G1_STALE_RUNNING_SECONDS: i64 = 600;

/// `A2A_MAX_CHAIN_TOKENS` default: the summed prompt + completion + reasoning
/// tokens one root trigger's whole delegation tree may spend.
pub const DEFAULT_MAX_CHAIN_TOKENS: i64 = 200_000;

/// `A2A_MAX_CHAIN_COST_MICRO_USD` default (= $5.00). `usage_ledger.cost_micro_usd`
/// is 0 on this server until a price-table reader exists (see the B5.1 PR body),
/// so today the token ceiling is the binding half and this one is the guard that
/// starts working the moment prices land.
pub const DEFAULT_MAX_CHAIN_COST_MICRO_USD: i64 = 5_000_000;

/// The five configured ceilings, resolved once and passed down.
///
/// A struct rather than five arguments: four of the five are `i32`/`i64` and a
/// transposed pair would silently swap the depth cap with the step cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct A2aLimits {
    /// Reject the spawn when `source.depth >= max_depth` — clamped to
    /// [`SCHEMA_DEPTH_CEILING`] by [`A2aLimits::clamped`].
    pub max_depth: i32,
    pub max_consecutive_auto: i32,
    pub max_steps: i32,
    pub g1_stale_running_seconds: i64,
    pub max_chain_tokens: i64,
    pub max_chain_cost_micro_usd: i64,
}

impl Default for A2aLimits {
    fn default() -> A2aLimits {
        A2aLimits {
            max_depth: DEFAULT_A2A_MAX_DEPTH,
            max_consecutive_auto: DEFAULT_MAX_CONSECUTIVE_AUTO,
            max_steps: DEFAULT_MAX_STEPS,
            g1_stale_running_seconds: DEFAULT_G1_STALE_RUNNING_SECONDS,
            max_chain_tokens: DEFAULT_MAX_CHAIN_TOKENS,
            max_chain_cost_micro_usd: DEFAULT_MAX_CHAIN_COST_MICRO_USD,
        }
    }
}

impl A2aLimits {
    /// Clamp every ceiling into a range the schema and the arithmetic can hold.
    ///
    /// `max_depth` is the load-bearing one — see [`SCHEMA_DEPTH_CEILING`]. The
    /// others are clamped to `>= 0` so a negative env value reads as "closed"
    /// rather than as "every spawn trips, including the diagnostics".
    pub fn clamped(self) -> A2aLimits {
        A2aLimits {
            max_depth: self.max_depth.clamp(0, SCHEMA_DEPTH_CEILING),
            max_consecutive_auto: self.max_consecutive_auto.max(0),
            max_steps: self.max_steps.max(0),
            g1_stale_running_seconds: self.g1_stale_running_seconds.max(0),
            max_chain_tokens: self.max_chain_tokens.max(0),
            max_chain_cost_micro_usd: self.max_chain_cost_micro_usd.max(0),
        }
    }
}

/// Everything the spawn decision reads, as one transaction saw it.
///
/// The Rust port of Swift `LoopGuards.DBGateSnapshot` (:50-63), re-pointed at
/// the moment a *child* run is about to be created: G1/G2 describe the **target**
/// agent (the one being delegated to), G3 and the depth describe the **source**
/// run (the one doing the delegating).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct A2aGateSnapshot {
    /// `agent_run.depth` of the run whose reply carried the mention.
    pub source_depth: i32,
    /// `agent_run.step_count` of that same run — G3's quantity.
    pub source_step_count: i32,
    /// `agent_run.max_steps` of that same run.
    pub source_max_steps: i32,
    /// Other `status='running'`, non-stale runs of the **target** agent — G1.
    pub active_other_runs: i32,
    /// `agent.max_concurrent_runs` of the target agent.
    pub max_concurrent_runs: i32,
    /// The target agent's auto-reply streak since the channel's last human
    /// message — G2. Supplied by the caller from
    /// `momo_messaging::agent_auto_reply_streak_in_tx`; this crate owns no
    /// `message` SQL.
    pub consecutive_auto_streak: i32,
    /// Summed `prompt + completion + reasoning` tokens over every run in this
    /// delegation tree, including the turn that just committed.
    pub chain_tokens: i64,
    /// Summed `usage_ledger.cost_micro_usd` over the same tree.
    pub chain_cost_micro_usd: i64,
}

/// Why a delegation did not happen. Each variant carries the numbers that
/// produced it, so the audit row answers "how close was it" and not only "no".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum A2aBlock {
    /// `a2a_depth` — the §3.4 hop cap. Named exactly as Swift names it in
    /// durable records; see the module docs for why it is not "G4".
    Depth { source_depth: i32, max_depth: i32 },
    /// G1 — the target agent's concurrency semaphore.
    Concurrency { active: i32, max: i32 },
    /// G2 — the target agent's consecutive auto-reply streak.
    ConsecutiveAuto { streak: i32, max: i32 },
    /// G3 — the source run's step cap.
    StepCap { step_count: i32, max: i32 },
    /// The chain spend ceiling. `tokens` is `true` when the token half tripped,
    /// `false` when the cost half did.
    ChainBudget {
        tokens: bool,
        spent: i64,
        max: i64,
        chain_tokens: i64,
        chain_cost_micro_usd: i64,
    },
    /// An agent mentioning itself. Not a Swift gate — Swift has no A2A spawn to
    /// gate — but the degenerate case the spawn point creates: a self-mention
    /// would queue a fresh run on every reply, and only G2 (three wasted
    /// provider calls later) would stop it. Refusing it costs nothing and is
    /// recorded under its own reason so it is never confused with a real cap.
    SelfMention,
}

impl A2aBlock {
    /// The stable `audit_log.detail.reason` for this block.
    ///
    /// Every value is prefixed `a2a_` so one predicate —
    /// `action = 'agent.mention.skipped' AND detail->>'reason' LIKE 'a2a_%'` —
    /// returns exactly the delegations this module refused, alongside the
    /// `agent_not_channel_member` / `agent_paused` reasons B5.2 already writes
    /// under the same schema.
    pub fn reason_code(&self) -> &'static str {
        match self {
            A2aBlock::Depth { .. } => "a2a_depth_cap",
            A2aBlock::Concurrency { .. } => "a2a_loop_gate_g1",
            A2aBlock::ConsecutiveAuto { .. } => "a2a_loop_gate_g2",
            A2aBlock::StepCap { .. } => "a2a_loop_gate_g3",
            A2aBlock::ChainBudget { .. } => "a2a_chain_budget",
            A2aBlock::SelfMention => "a2a_self_mention",
        }
    }

    /// The gate label Swift writes into durable records, when there is one.
    ///
    /// `a2a_depth` rather than `G4` — `LoopGuards.swift:35-37`.
    pub fn gate(&self) -> Option<&'static str> {
        match self {
            A2aBlock::Depth { .. } => Some("a2a_depth"),
            A2aBlock::Concurrency { .. } => Some("G1"),
            A2aBlock::ConsecutiveAuto { .. } => Some("G2"),
            A2aBlock::StepCap { .. } => Some("G3"),
            A2aBlock::ChainBudget { .. } | A2aBlock::SelfMention => None,
        }
    }

    /// Does the channel see a line for this block?
    ///
    /// A self-mention does not produce one: the agent is talking to itself in
    /// its own message, nobody delegated anything, and a system line would be
    /// noise a human has to learn to ignore. Every real cap does — silence is
    /// indistinguishable from "the other agent ignored me".
    pub fn is_visible(&self) -> bool {
        !matches!(self, A2aBlock::SelfMention)
    }

    /// The channel line, in the register `paused_mention_body` established:
    /// Korean, naming the agent and the limit that held.
    pub fn system_line(&self, target_display_name: &str) -> String {
        let head = format!("{target_display_name}에게 위임하지 못했습니다");
        match self {
            A2aBlock::Depth {
                source_depth,
                max_depth,
            } => format!(
                "{head} — 위임 깊이 한도에 도달했습니다(현재 {source_depth}단계, 최대 {max_depth}단계)."
            ),
            A2aBlock::Concurrency { active, max } => format!(
                "{head} — {target_display_name}이(가) 동시 실행 한도에 도달했습니다(실행 중 {active}건, 최대 {max}건)."
            ),
            A2aBlock::ConsecutiveAuto { streak, max } => format!(
                "{head} — 사람의 마지막 메시지 이후 연속 자동 응답 한도에 도달했습니다({streak}회, 최대 {max}회)."
            ),
            A2aBlock::StepCap { step_count, max } => format!(
                "{head} — 이 실행의 단계 한도에 도달했습니다({step_count}단계, 최대 {max}단계)."
            ),
            A2aBlock::ChainBudget {
                tokens: true,
                spent,
                max,
                ..
            } => format!("{head} — 이 위임 체인의 토큰 한도에 도달했습니다({spent}/{max})."),
            A2aBlock::ChainBudget {
                tokens: false,
                spent,
                max,
                ..
            } => format!(
                "{head} — 이 위임 체인의 비용 한도에 도달했습니다({spent}/{max} micro-USD)."
            ),
            A2aBlock::SelfMention => format!("{head} — 자기 자신은 위임 대상이 아닙니다."),
        }
    }

    /// The `a2a` sub-object added to the shared mention diagnostic detail.
    ///
    /// It rides *inside* `momo.agent_mention.diagnostic.v0` rather than in a
    /// schema of its own, so the single query that answers "what happened to
    /// this @mention" keeps returning one shape (B5.2's rule, and the reason all
    /// three of its outcomes share a schema).
    pub fn detail(&self) -> Value {
        let mut detail = Map::new();
        detail.insert("reason".into(), json!(self.reason_code()));
        if let Some(gate) = self.gate() {
            detail.insert("gate".into(), json!(gate));
        }
        match self {
            A2aBlock::Depth {
                source_depth,
                max_depth,
            } => {
                detail.insert("source_depth".into(), json!(source_depth));
                detail.insert("max_depth".into(), json!(max_depth));
            }
            A2aBlock::Concurrency { active, max } => {
                detail.insert("active_other_runs".into(), json!(active));
                detail.insert("max_concurrent_runs".into(), json!(max));
            }
            A2aBlock::ConsecutiveAuto { streak, max } => {
                detail.insert("consecutive_auto_streak".into(), json!(streak));
                detail.insert("max_consecutive_auto".into(), json!(max));
            }
            A2aBlock::StepCap { step_count, max } => {
                detail.insert("step_count".into(), json!(step_count));
                detail.insert("max_steps".into(), json!(max));
            }
            A2aBlock::ChainBudget {
                tokens,
                spent,
                max,
                chain_tokens,
                chain_cost_micro_usd,
            } => {
                detail.insert(
                    "axis".into(),
                    json!(if *tokens { "tokens" } else { "cost" }),
                );
                detail.insert("spent".into(), json!(spent));
                detail.insert("max".into(), json!(max));
                detail.insert("chain_tokens".into(), json!(chain_tokens));
                detail.insert("chain_cost_micro_usd".into(), json!(chain_cost_micro_usd));
            }
            A2aBlock::SelfMention => {}
        }
        Value::Object(detail)
    }
}

/// The whole spawn policy, as a pure function of the snapshot and the limits.
///
/// Pure on purpose: this is the part that must be readable and exhaustively
/// unit-testable without a database, because it is the part that decides whether
/// a runaway agent chain stops. The DB half ([`load_a2a_gate_snapshot_in_tx`])
/// only fetches the numbers it reads.
pub fn evaluate_a2a_spawn(snapshot: &A2aGateSnapshot, limits: &A2aLimits) -> Result<(), A2aBlock> {
    // G1 — the target agent's semaphore. Only runs that are *actually executing*
    // count; a run parked on a human approval must not starve a delegation.
    if snapshot.active_other_runs >= snapshot.max_concurrent_runs {
        return Err(A2aBlock::Concurrency {
            active: snapshot.active_other_runs,
            max: snapshot.max_concurrent_runs,
        });
    }
    // G2 — the target agent's auto-reply streak since the last human message.
    // This is the gate that survives a human re-entering the conversation: a
    // human utterance resets it structurally, so a chain a person is steering is
    // never capped by it.
    if snapshot.consecutive_auto_streak >= limits.max_consecutive_auto {
        return Err(A2aBlock::ConsecutiveAuto {
            streak: snapshot.consecutive_auto_streak,
            max: limits.max_consecutive_auto,
        });
    }
    // G3 — the source run's step cap, tightened by the env override exactly as
    // Swift does (`min(run.max_steps, MAX_STEPS)`). One run may therefore fan
    // out at most that many delegations, because the spawn consumes a step.
    let step_cap = snapshot.source_max_steps.min(limits.max_steps);
    if snapshot.source_step_count >= step_cap {
        return Err(A2aBlock::StepCap {
            step_count: snapshot.source_step_count,
            max: step_cap,
        });
    }
    // a2a_depth — the §3.4 hop cap, at the enforcement point Swift names:
    // child-run creation, rejecting when `parent.depth >= MAX_DEPTH`. Note the
    // `>=` against Swift's run-side `>`: the run-side check judges a depth that
    // already exists, this one judges the depth about to be created.
    if snapshot.source_depth >= limits.max_depth {
        return Err(A2aBlock::Depth {
            source_depth: snapshot.source_depth,
            max_depth: limits.max_depth,
        });
    }
    // The chain ceiling last — see the module docs on ordering.
    if snapshot.chain_tokens >= limits.max_chain_tokens {
        return Err(A2aBlock::ChainBudget {
            tokens: true,
            spent: snapshot.chain_tokens,
            max: limits.max_chain_tokens,
            chain_tokens: snapshot.chain_tokens,
            chain_cost_micro_usd: snapshot.chain_cost_micro_usd,
        });
    }
    if snapshot.chain_cost_micro_usd >= limits.max_chain_cost_micro_usd {
        return Err(A2aBlock::ChainBudget {
            tokens: false,
            spent: snapshot.chain_cost_micro_usd,
            max: limits.max_chain_cost_micro_usd,
            chain_tokens: snapshot.chain_tokens,
            chain_cost_micro_usd: snapshot.chain_cost_micro_usd,
        });
    }
    Ok(())
}

/// The depth a child run inherits from its parent — Swift
/// `inheritedMentionDepth` (`MessageRoutes.swift:2188-2193`), with the cap read
/// from configuration instead of hard-coded to `0..<4`.
///
/// Returns `None` at the cap, which is the same refusal Swift raises as a 409.
pub fn inherited_depth(source_depth: i32, limits: &A2aLimits) -> Option<i32> {
    if source_depth < 0 || source_depth >= limits.max_depth {
        return None;
    }
    Some(source_depth + 1)
}

/// Load every counter [`evaluate_a2a_spawn`] reads, inside the caller's
/// transaction.
///
/// `consecutive_auto_streak` is a parameter rather than a query: it counts
/// `message` rows, and `momo_messaging` owns those (see the module docs).
///
/// Returns `None` when the source run does not exist in this workspace — there
/// is nothing to delegate *from*, which is the same fail-closed answer B5.2
/// gives the HTTP path.
pub async fn load_a2a_gate_snapshot_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    source_run_id: Uuid,
    target_agent_member_id: Uuid,
    consecutive_auto_streak: i32,
    limits: &A2aLimits,
) -> Result<Option<A2aGateSnapshot>, DbError> {
    let source = sqlx::query(
        "SELECT depth, step_count, max_steps FROM agent_run \
          WHERE id = $1 AND workspace_id = $2",
    )
    .bind(source_run_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(source) = source else {
        return Ok(None);
    };
    let source_depth: i32 = source.try_get("depth").map_err(DbError::from)?;
    let source_step_count: i32 = source.try_get("step_count").map_err(DbError::from)?;
    let source_max_steps: i32 = source.try_get("max_steps").map_err(DbError::from)?;

    // G1's two halves. `agent.max_concurrent_runs` is the per-agent cap; the
    // count excludes stale `running` rows (a crashed worker's residue) exactly
    // as Swift does, so a dead run cannot lock an agent out permanently.
    let concurrency = sqlx::query(
        "SELECT a.max_concurrent_runs, \
                ( SELECT count(*)::int FROM agent_run r \
                   WHERE r.workspace_id = $1 \
                     AND r.agent_member_id = $2 \
                     AND r.id <> $3 \
                     AND r.status = 'running' \
                     AND r.updated_at > now() - ($4::double precision * interval '1 second') \
                ) AS active_other_runs \
           FROM agent a \
          WHERE a.member_id = $2 AND a.workspace_id = $1",
    )
    .bind(workspace_id)
    .bind(target_agent_member_id)
    .bind(source_run_id)
    .bind(limits.g1_stale_running_seconds as f64)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(concurrency) = concurrency else {
        // No `agent` row for the target: it is not a dispatchable agent, so
        // there is nothing to delegate *to*. Fail closed rather than invent a
        // cap out of the process default.
        return Ok(None);
    };
    let max_concurrent_runs: i32 = concurrency
        .try_get("max_concurrent_runs")
        .map_err(DbError::from)?;
    let active_other_runs: i32 = concurrency
        .try_get("active_other_runs")
        .map_err(DbError::from)?;

    let chain = crate::usage::chain_usage_in_tx(&mut *conn, workspace_id, source_run_id).await?;

    Ok(Some(A2aGateSnapshot {
        source_depth,
        source_step_count,
        source_max_steps,
        active_other_runs,
        max_concurrent_runs,
        consecutive_auto_streak,
        chain_tokens: chain.total_tokens,
        chain_cost_micro_usd: chain.cost_micro_usd,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clear() -> A2aGateSnapshot {
        A2aGateSnapshot {
            source_depth: 0,
            source_step_count: 0,
            source_max_steps: 50,
            active_other_runs: 0,
            max_concurrent_runs: 4,
            consecutive_auto_streak: 0,
            chain_tokens: 0,
            chain_cost_micro_usd: 0,
        }
    }

    /// A snapshot with nothing wrong spawns. Without this the rest of the suite
    /// could pass with a function that always refuses.
    #[test]
    fn a_clear_snapshot_delegates() {
        assert_eq!(evaluate_a2a_spawn(&clear(), &A2aLimits::default()), Ok(()));
    }

    /// **The measured Swift table, one assertion per gate.**
    ///
    /// Each value is one below its cap and then exactly at it, because the
    /// difference between `>` and `>=` is the whole gate: a `>` here would let
    /// every cap run one hop past the number an operator configured.
    #[test]
    fn each_gate_trips_at_its_cap_and_not_one_below() {
        let limits = A2aLimits::default();

        // G1 — `activeOtherRuns >= max_concurrent_runs` (LoopGuards.swift:77).
        let mut g1 = clear();
        g1.max_concurrent_runs = 2;
        g1.active_other_runs = 1;
        assert_eq!(evaluate_a2a_spawn(&g1, &limits), Ok(()));
        g1.active_other_runs = 2;
        assert_eq!(
            evaluate_a2a_spawn(&g1, &limits),
            Err(A2aBlock::Concurrency { active: 2, max: 2 })
        );

        // G2 — `consecutiveAutoStreak >= MAX_CONSECUTIVE_AUTO` (:83).
        let mut g2 = clear();
        g2.consecutive_auto_streak = limits.max_consecutive_auto - 1;
        assert_eq!(evaluate_a2a_spawn(&g2, &limits), Ok(()));
        g2.consecutive_auto_streak = limits.max_consecutive_auto;
        assert_eq!(
            evaluate_a2a_spawn(&g2, &limits),
            Err(A2aBlock::ConsecutiveAuto { streak: 3, max: 3 })
        );

        // G3 — `stepCount >= min(runMaxSteps, MAX_STEPS)` (:89-90). The `min` is
        // load-bearing: the run column alone would ignore the env tightening.
        let mut g3 = clear();
        g3.source_max_steps = 50;
        g3.source_step_count = limits.max_steps - 1;
        assert_eq!(evaluate_a2a_spawn(&g3, &limits), Ok(()));
        g3.source_step_count = limits.max_steps;
        assert_eq!(
            evaluate_a2a_spawn(&g3, &limits),
            Err(A2aBlock::StepCap {
                step_count: 12,
                max: 12
            })
        );
        // …and the run's own smaller cap wins over the env one.
        let mut tight = clear();
        tight.source_max_steps = 2;
        tight.source_step_count = 2;
        assert_eq!(
            evaluate_a2a_spawn(&tight, &limits),
            Err(A2aBlock::StepCap {
                step_count: 2,
                max: 2
            })
        );

        // a2a_depth — reject when `parent.depth >= MAX_DEPTH`
        // (LoopGuards.swift:37-40 names this exact predicate for the spawn).
        let mut depth = clear();
        depth.source_depth = limits.max_depth - 1;
        assert_eq!(evaluate_a2a_spawn(&depth, &limits), Ok(()));
        depth.source_depth = limits.max_depth;
        assert_eq!(
            evaluate_a2a_spawn(&depth, &limits),
            Err(A2aBlock::Depth {
                source_depth: 3,
                max_depth: 3
            })
        );
    }

    /// The chain ceiling stops the tree on either axis, and reports which one.
    #[test]
    fn the_chain_ceiling_stops_on_tokens_or_on_cost() {
        let limits = A2aLimits {
            max_chain_tokens: 100,
            max_chain_cost_micro_usd: 1_000,
            ..A2aLimits::default()
        };
        let mut under = clear();
        under.chain_tokens = 99;
        under.chain_cost_micro_usd = 999;
        assert_eq!(evaluate_a2a_spawn(&under, &limits), Ok(()));

        let mut tokens = clear();
        tokens.chain_tokens = 100;
        assert!(matches!(
            evaluate_a2a_spawn(&tokens, &limits),
            Err(A2aBlock::ChainBudget { tokens: true, .. })
        ));

        let mut cost = clear();
        cost.chain_cost_micro_usd = 1_000;
        assert!(matches!(
            evaluate_a2a_spawn(&cost, &limits),
            Err(A2aBlock::ChainBudget { tokens: false, .. })
        ));
    }

    /// **Swift's evaluation order, verbatim.** A snapshot that trips everything
    /// must report G1, then G2, then G3, then `a2a_depth`, then the budget.
    ///
    /// Order is not cosmetic: it is what an operator reads off the audit row to
    /// decide what to change, and reordering it would tell them to raise the
    /// depth cap when the real problem is that the agent is saturated.
    #[test]
    fn the_gate_order_is_the_one_swift_evaluates() {
        let limits = A2aLimits::default();
        let mut all = A2aGateSnapshot {
            source_depth: 9,
            source_step_count: 99,
            source_max_steps: 50,
            active_other_runs: 9,
            max_concurrent_runs: 1,
            consecutive_auto_streak: 9,
            chain_tokens: i64::MAX / 2,
            chain_cost_micro_usd: i64::MAX / 2,
        };
        assert!(matches!(
            evaluate_a2a_spawn(&all, &limits),
            Err(A2aBlock::Concurrency { .. })
        ));
        all.active_other_runs = 0;
        assert!(matches!(
            evaluate_a2a_spawn(&all, &limits),
            Err(A2aBlock::ConsecutiveAuto { .. })
        ));
        all.consecutive_auto_streak = 0;
        assert!(matches!(
            evaluate_a2a_spawn(&all, &limits),
            Err(A2aBlock::StepCap { .. })
        ));
        all.source_step_count = 0;
        assert!(matches!(
            evaluate_a2a_spawn(&all, &limits),
            Err(A2aBlock::Depth { .. })
        ));
        all.source_depth = 0;
        assert!(matches!(
            evaluate_a2a_spawn(&all, &limits),
            Err(A2aBlock::ChainBudget { .. })
        ));
    }

    /// A configured depth cap can never produce a row the schema would reject.
    ///
    /// `agent_run_depth_a2a_cap_ck` (007) is `depth <= 4`. Without the clamp an
    /// operator's `A2A_MAX_DEPTH=99` would let the worker attempt a `depth = 5`
    /// INSERT, and the CHECK violation would roll back the whole turn — the
    /// reply, the ledger row and the run transition with it.
    #[test]
    fn a_configured_depth_cap_can_never_exceed_the_schema_check() {
        let wild = A2aLimits {
            max_depth: 99,
            ..A2aLimits::default()
        }
        .clamped();
        assert_eq!(wild.max_depth, SCHEMA_DEPTH_CEILING);
        // The deepest child this cap can create is therefore exactly the
        // schema's ceiling, never past it.
        assert_eq!(
            inherited_depth(SCHEMA_DEPTH_CEILING - 1, &wild),
            Some(SCHEMA_DEPTH_CEILING)
        );
        assert_eq!(inherited_depth(SCHEMA_DEPTH_CEILING, &wild), None);

        let negative = A2aLimits {
            max_depth: -5,
            max_chain_tokens: -1,
            ..A2aLimits::default()
        }
        .clamped();
        assert_eq!(negative.max_depth, 0);
        assert_eq!(negative.max_chain_tokens, 0);
        assert_eq!(
            inherited_depth(0, &negative),
            None,
            "a zero cap closes A2A entirely rather than allowing one hop"
        );
    }

    /// The inheritance is `parent + 1`, and it refuses at the cap — Swift
    /// `inheritedMentionDepth` (:2188-2193).
    #[test]
    fn the_child_depth_is_the_parents_plus_one_until_the_cap() {
        let limits = A2aLimits::default();
        assert_eq!(inherited_depth(0, &limits), Some(1));
        assert_eq!(inherited_depth(1, &limits), Some(2));
        assert_eq!(inherited_depth(2, &limits), Some(3));
        assert_eq!(inherited_depth(3, &limits), None);
        assert_eq!(inherited_depth(-1, &limits), None);
    }

    /// Every block is attributable and every visible one names the agent it was
    /// about. A reason code that changed would silently orphan the audit query
    /// an operator saved.
    #[test]
    fn every_block_is_audited_under_an_a2a_reason_and_says_so_in_korean() {
        let blocks = [
            A2aBlock::Depth {
                source_depth: 3,
                max_depth: 3,
            },
            A2aBlock::Concurrency { active: 1, max: 1 },
            A2aBlock::ConsecutiveAuto { streak: 3, max: 3 },
            A2aBlock::StepCap {
                step_count: 12,
                max: 12,
            },
            A2aBlock::ChainBudget {
                tokens: true,
                spent: 10,
                max: 10,
                chain_tokens: 10,
                chain_cost_micro_usd: 0,
            },
            A2aBlock::SelfMention,
        ];
        let mut codes: Vec<&str> = blocks.iter().map(A2aBlock::reason_code).collect();
        let total = codes.len();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), total, "each block has its own reason code");
        for block in &blocks {
            assert!(
                block.reason_code().starts_with("a2a_"),
                "one audit predicate must find them all: {}",
                block.reason_code()
            );
            assert_eq!(block.detail()["reason"], json!(block.reason_code()));
            let line = block.system_line("아틀라스");
            assert!(line.contains("아틀라스"), "{line}");
        }
        // The depth line is the one the ticket specifies by name.
        assert!(blocks[0].system_line("아틀라스").contains("위임 깊이 한도"));
        // Swift's durable label for the depth gate is `a2a_depth`, NOT `G4` —
        // the canonical G4 is the SimHash detector (LoopGuards.swift:35-37).
        assert_eq!(blocks[0].gate(), Some("a2a_depth"));
        assert!(blocks.iter().all(|block| block.gate() != Some("G4")));
        // A self-mention is recorded but not narrated.
        assert!(!A2aBlock::SelfMention.is_visible());
        assert!(blocks[..5].iter().all(A2aBlock::is_visible));
    }
}
