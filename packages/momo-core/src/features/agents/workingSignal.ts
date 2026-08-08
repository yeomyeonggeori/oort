// =============================================================================
// "이 에이전트에게 지금 열린 턴이 있는가" — the PURE half (R-1 §1).
//
// This vocabulary used to live entirely in `clients/web/src/features/agents/
// agentWorkingSignal.ts`, which is why the comments below still speak in that
// file's voice. Goal RN-A1 moved the rules here because the phone needs the same
// answer and could not reach them: everything in this file is a plain function
// over plain values, and the STORE that holds them (a module-level map, a
// `useSyncExternalStore` subscription, a `setInterval` clock) stayed in the web
// client, where the platform actually is. That web file now re-exports these
// names, so its callers did not move and cannot end up with a second copy of a
// rule that must have exactly one answer.
//
// An open turn is not the same thing as a working agent. `state` says which of
// the two it is, and no surface may render `awaiting_approval` as 작업 중:
// momowebqa's agent ends every turn on `run_status=awaiting_approval`, so an
// indicator that treats the two alike tells the reader to wait for the agent
// while the agent is waiting for the reader (SKILL §9: awaiting-approval is its
// own state, and absence is never promoted to a story).
//
// The rules here are the web port of the mac resolver
// (clients/macOS/Sources/MomoMac/AgentWorkingSignal.swift, MOMO-568), kept
// rule-for-rule so no client drifts into a different answer to "is this agent
// working":
//
//   - source priority run > status > typing. A turn is proven by observation
//     (ADR-0126), never by a typing indicator alone: typing can be forged, a run
//     cannot. `typing` stays the weakest rank and no producer feeds it, because
//     no server surface publishes `typing.*` for agents today.
//   - one signal per agent per channel. Concurrent runs merge: earliest start
//     wins the clock, headlines are unioned, the strongest source survives.
//   - 90s idle TTL. A signal whose last observed activity is older than the
//     cutoff is treated as gone even if its terminal event never arrived, so a
//     lost frame cannot strand a badge with a clock running away to hours.
// =============================================================================

/** Which realtime source proved the agent is working, in priority order. */
export type AgentWorkingSource = "run" | "status" | "typing";

const SOURCE_RANK: Record<AgentWorkingSource, number> = {
  run: 3,
  status: 2,
  typing: 1,
};

/**
 * What the open turn is doing. `working` means the agent is running; the run
 * came back `awaiting_approval`, which means it stopped and the next move
 * belongs to a person.
 */
export type AgentTurnState = "working" | "awaiting_approval";

export interface AgentWorkingSignal {
  /** The agent member taking the turn. */
  memberId: string;
  /** Channel the turn is happening in. */
  channelId: string;
  /** Working, or stopped and waiting for a human decision. */
  state: AgentTurnState;
  /** Which observation proved it. */
  source: AgentWorkingSource;
  /** The live run behind the turn, when one is known. */
  runId?: string;
  /**
   * Epoch ms (SERVER clock, from the frame envelope) the turn started; the
   * surfaces render elapsed time from this.
   *
   * Absent whenever the start was never observed: a typing-only fallback, or a
   * rail that attached to a turn already in flight. The surfaces then state the
   * turn WITHOUT a clock, because "0s" would be the moment we noticed rather
   * than the moment the agent began, and a number nobody can act on is worse
   * than no number.
   */
  startedAtMs?: number;
  /**
   * Headline candidates drawn from agent-authored content (the last streamed
   * line). Empty until the agent has produced one, in which case the composer
   * states the turn without a headline instead of inventing one.
   */
  headlines: string[];
  /** Last moment fresh activity was observed. Drives the TTL and the sweep. */
  lastActivityAtMs: number;
  /**
   * How many concurrent runs were folded into this one signal. Absent means one
   * — nothing was folded — which is every ordinary turn.
   *
   * It exists because `runId` above names only the ANCHOR (the run that owns the
   * earliest clock), and goal RN-C1 gave a person a button that acts on exactly
   * that one id. Stopping it while two runs are open leaves the badge lit, and a
   * stop that visibly does nothing reads as a broken button rather than as the
   * partial success it is. A surface offering that button has to be able to say
   * how many runs it is NOT stopping, and the merge is the only place that
   * number still exists.
   */
  runCount?: number;
}

// =============================================================================
// 타임라인 자리표시 — 「작업 중」을 사람이 **보고 있는 자리**에서 말하기 (#999)
//
// 성재, 1차 검수: *"경과시계나 중단 버튼 탭 같은 게 있는지 잘 모르겠어… 에이전트가
// 일하고 있는 상태인지도 잘 파악이 안 돼."*
//
// 배선은 이미 있었다(#994). 없던 것은 **인지**다. 짧은 턴은 수 초 만에 끝나고,
// 활동 줄과 배지는 둘 다 시선 밖에 있다 — 사람이 방금 멘션을 쳤을 때 눈이 가 있는
// 곳은 대화의 맨 아래, 자기가 쓴 줄 바로 다음 칸이다. 답이 나타날 그 칸.
//
// 그래서 이 함수가 정하는 것은 하나다: **어느 턴이 그 칸을 얻는가.** 그리고 그
// 답은 규칙 하나로 끝난다 — `working` 인 턴만이다. `awaiting_approval` 은 멈춰
// 서서 사람의 결정을 기다리는 상태이고, 그 칸에 자리표시를 놓으면 화면이 "곧
// 답이 온다"고 말하는 동안 에이전트는 바로 그 사람을 기다리고 있게 된다. 이
// 모듈의 헤더가 처음부터 금지한 거짓말이 정확히 그것이다.
//
// ## 왜 문자열(키)인가
//
// 자리표시는 **존재**만 나른다 — 이름도 시계도 헤드라인도 아니다(그 셋은 컴포저
// 바로 위 활동 줄의 몫이다). 존재만 나르면 스트리밍 청크마다 값이 바뀌지 않고,
// 그래서 소비하는 쪽이 이 키로 memo 를 걸 수 있다. 그것이 중요한 이유는 goal
// RN-P2a 가 방금 산 것이 바로 그것이기 때문이다: 신호가 갱신될 때 메시지 목록이
// 다시 그려지지 않는 것. 헤드라인을 이 자리에 실으면 그 수리가 그대로 풀린다.
//
// 손실 없는 인코딩이라 `parseTurnPlaceholderKey` 가 되돌린다 — `agentRail` 의
// `subscriptionKey`/`parseSubscriptionKey` 와 같은 이유로 같은 모양이다.
// =============================================================================

/** 자리표시 한 칸이 아는 전부. */
export interface TurnPlaceholder {
  memberId: string;
}

/**
 * 타임라인에 자리표시를 얻는 에이전트들을, 값이 같으면 문자열도 같은 키로.
 *
 * 입력은 이미 채널로 걸러지고 오래된 순으로 정렬된 턴 배열이다(`agentTurnsInChannel`).
 * 여기서 더 하는 일은 어휘 경계 하나뿐이다: **`working` 만.**
 */
export function turnPlaceholderKey(
  turns: readonly AgentWorkingSignal[]
): string {
  const out: string[] = [];
  for (const turn of turns) {
    if (turn.state !== "working") continue;
    out.push(turn.memberId.toLowerCase());
  }
  return out.join("|");
}

/** `turnPlaceholderKey` 의 역함수. 빈 키는 빈 배열이다. */
export function parseTurnPlaceholderKey(key: string): TurnPlaceholder[] {
  if (key === "") return [];
  return key.split("|").map((memberId) => ({ memberId }));
}

/**
 * Idle cutoff: past this, a signal self-expires even though no terminal event
 * ever arrived, and every surface stops rendering it on the next tick.
 */
export const IDLE_CUTOFF_MS = 90_000;

const MAX_HEADLINES = 3;
const MAX_HEADLINE_LENGTH = 140;

/**
 * The last meaningful line of streamed text, trimmed and clipped, or undefined
 * when the agent has produced nothing renderable yet.
 */
export function headlineFrom(text: string | null | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length <= MAX_HEADLINE_LENGTH) return trimmed;
    return `${trimmed.slice(0, MAX_HEADLINE_LENGTH).trimEnd()}…`;
  }
  return undefined;
}

/**
 * Has this signal gone quiet past the cutoff? A signal that was never stamped
 * cannot happen here (`lastActivityAtMs` is required), which is the web
 * simplification of the mac's "nil last-activity is not proof of staleness".
 */
export function isStaleSignal(
  signal: AgentWorkingSignal,
  nowMs: number,
  idleCutoffMs: number = IDLE_CUTOFF_MS
): boolean {
  return nowMs - signal.lastActivityAtMs > idleCutoffMs;
}

/**
 * Collapse one agent's concurrent-run candidates into one signal: earliest
 * start clock, unioned headlines, strongest source. The run that owns the
 * earliest clock also owns `runId`, so the two never describe different turns.
 *
 * State merges toward `working`: one run that is actually running makes the
 * agent working, whatever a second run is waiting on. The reverse would be the
 * lie this whole module exists to prevent.
 */
export function mergeAgentWorkingSignals(
  candidates: readonly AgentWorkingSignal[]
): AgentWorkingSignal | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const working = candidates.filter((c) => c.state === "working");
  // The clock and the headline belong to the state being shown: an agent that
  // is working must not borrow the start time of a run that is parked on an
  // approval.
  const shown = working.length > 0 ? working : candidates;

  const starts = shown
    .map((c) => c.startedAtMs)
    .filter((v): v is number => typeof v === "number");
  const earliest = starts.length > 0 ? Math.min(...starts) : undefined;
  const anchor = shown.find((c) => c.startedAtMs === earliest) ?? shown[0];

  const headlines: string[] = [];
  for (const candidate of shown) {
    for (const headline of candidate.headlines) {
      if (!headlines.includes(headline)) headlines.push(headline);
    }
  }

  let source = candidates[0].source;
  for (const candidate of candidates) {
    if (SOURCE_RANK[candidate.source] > SOURCE_RANK[source]) {
      source = candidate.source;
    }
  }

  const merged: AgentWorkingSignal = {
    memberId: anchor.memberId,
    channelId: anchor.channelId,
    state: working.length > 0 ? "working" : "awaiting_approval",
    source,
    headlines: headlines.slice(0, MAX_HEADLINES),
    lastActivityAtMs: Math.max(...candidates.map((c) => c.lastActivityAtMs)),
    // ALL candidates, not just the `shown` ones. A run parked on an approval is
    // still a run a stop would leave behind, so counting only the working ones
    // would understate exactly what the reader needs to know.
    runCount: candidates.length,
  };
  if (anchor.runId !== undefined) merged.runId = anchor.runId;
  if (earliest !== undefined) merged.startedAtMs = earliest;
  return merged;
}

/**
 * Drop stale candidates, then merge to at most one signal per agent per
 * channel. Ordered oldest turn first so a surface that shows a single line
 * always shows the one that has been running longest.
 */
export function resolveAgentWorkingSignals(
  candidates: readonly AgentWorkingSignal[],
  nowMs: number,
  idleCutoffMs: number = IDLE_CUTOFF_MS
): AgentWorkingSignal[] {
  const byAgent = new Map<string, AgentWorkingSignal[]>();
  for (const candidate of candidates) {
    if (isStaleSignal(candidate, nowMs, idleCutoffMs)) continue;
    const key = `${candidate.channelId.toLowerCase()}|${candidate.memberId.toLowerCase()}`;
    const bucket = byAgent.get(key);
    if (bucket) bucket.push(candidate);
    else byAgent.set(key, [candidate]);
  }
  const out: AgentWorkingSignal[] = [];
  for (const bucket of byAgent.values()) {
    const merged = mergeAgentWorkingSignals(bucket);
    if (merged) out.push(merged);
  }
  return out.sort(byOldestTurn);
}

/** Oldest turn first; a signal with no clock (typing fallback) sorts last. */
export function byOldestTurn(
  a: AgentWorkingSignal,
  b: AgentWorkingSignal
): number {
  const left = a.startedAtMs ?? Number.POSITIVE_INFINITY;
  const right = b.startedAtMs ?? Number.POSITIVE_INFINITY;
  return left - right;
}

// ---- elapsed readout --------------------------------------------------------

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/**
 * Elapsed clock for a turn: `42s`, `3m 12s`, `1h 04m`. Seconds are dropped past
 * an hour because at that scale they are noise, and the minute/second fields are
 * zero-padded so a `data-numeric` (tabular-nums) label does not change width
 * while it ticks.
 */
export function elapsedLabel(startedAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad2(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad2(minutes % 60)}m`;
}
