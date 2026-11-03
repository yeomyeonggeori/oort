import { useEffect, useState, useSyncExternalStore } from "react";
import {
  applyApprovalWaits,
  byOldestTurn,
  isStaleSignal,
  type AgentWorkingSignal,
  type ApprovalWait,
} from "@momo/core/features/agents/workingSignal";

// =============================================================================
// agentWorkingSignal: ONE source for "an agent has an OPEN TURN right now"
// (R-1 §1). The sidebar badge and the composer activity line both read this
// store, so they can never disagree.
//
// ## What moved, and what could not (goal RN-A1)
//
// The RULES — the three types, the 90s TTL, `headlineFrom`, `isStaleSignal`,
// the concurrent-run merge, `elapsedLabel` — now live in
// `@momo/core/features/agents/workingSignal`, because the phone needs the same
// answers and `packages/momo-core` is the only place both clients can reach.
// They are re-exported below verbatim, so nothing that imported them from here
// had to move and no rule exists twice.
//
// What stayed is everything this file has that a rule does not: a module-level
// mutable map, a `useSyncExternalStore` subscription over it, and a
// `setInterval` clock. Those are React and they are web-process state; the core
// purity gate rejects both on sight (ADR-0137 D3), and rewriting them as
// something portable would be a redesign of the store, not a move. React Native
// will subscribe to its own realtime rail when it has one — until then the phone
// reads the agent's state from REST, which needs the rules and not the store.
//
// An open turn is not the same thing as a working agent. See the core module's
// header for why `awaiting_approval` may never render as 작업 중.
// =============================================================================

export {
  applyApprovalWaits,
  byOldestTurn,
  elapsedLabel,
  headlineFrom,
  IDLE_CUTOFF_MS,
  isStaleSignal,
  mergeAgentWorkingSignals,
  resolveAgentWorkingSignals,
  type AgentTurnState,
  type ServerRunFacts,
  type AgentWorkingSignal,
  type AgentWorkingSource,
  type ApprovalWait,
} from "@momo/core/features/agents/workingSignal";

/**
 * Hard clear: past this, the entry is REMOVED from the store, not merely hidden.
 * The gap over the TTL is deliberate. Between 90s and 120s a run that resumes
 * publishing is still the same turn and keeps its original clock; after 120s of
 * total silence the entry is treated as a zombie of a rail that went away, and
 * nothing may resurrect it.
 *
 * This is the ONE constant that stayed behind: it is the sweep interval of this
 * store, not a rule about what a signal means, and there is no store in the core
 * for it to belong to.
 */
export const ZOMBIE_CLEAR_MS = 120_000;

type Key = string;

function keyOf(channelId: string, memberId: string): Key {
  return `${channelId.toLowerCase()}|${memberId.toLowerCase()}`;
}

// ---- the store --------------------------------------------------------------

let signals: ReadonlyMap<Key, AgentWorkingSignal> = new Map();
const listeners = new Set<() => void>();

function emit(next: ReadonlyMap<Key, AgentWorkingSignal>): void {
  signals = next;
  for (const listener of listeners) listener();
}

function sameSignal(a: AgentWorkingSignal, b: AgentWorkingSignal): boolean {
  return (
    a.memberId === b.memberId &&
    a.channelId === b.channelId &&
    a.state === b.state &&
    a.source === b.source &&
    a.runId === b.runId &&
    a.startedAtMs === b.startedAtMs &&
    a.lastActivityAtMs === b.lastActivityAtMs &&
    JSON.stringify(a.server) === JSON.stringify(b.server) &&
    a.headlines.length === b.headlines.length &&
    a.headlines.every((h, i) => h === b.headlines[i])
  );
}

/**
 * Record (or refresh) a turn. The caller has already merged that agent's
 * concurrent runs through `resolveAgentWorkingSignals`, so this is an upsert and
 * not a second merge policy: two merge rules in two places is how the sidebar
 * and the composer would end up disagreeing.
 */
export function markAgentWorking(signal: AgentWorkingSignal): void {
  const key = keyOf(signal.channelId, signal.memberId);
  const existing = signals.get(key);
  if (existing && sameSignal(existing, signal)) return;
  const next = new Map(signals);
  next.set(key, signal);
  emit(next);
}

/** Clear a turn (completed, cancelled, or stalled out). */
export function clearAgentWorking(channelId: string, memberId: string): void {
  const key = keyOf(channelId, memberId);
  if (!signals.has(key)) return;
  const next = new Map(signals);
  next.delete(key);
  emit(next);
}

/**
 * Zombie guard: delete every entry that has not been refreshed for
 * ZOMBIE_CLEAR_MS. Runs on a timer independent of any channel surface, so a
 * stranded turn cannot survive in the store just because nobody is looking at
 * the channel it belongs to.
 */
export function sweepAgentWorking(nowMs: number): void {
  const next = new Map(signals);
  let removed = 0;
  for (const [key, signal] of signals) {
    // 서버가 답한 run은 서버가 끝낸다(ADR-0200). 우리 시계로 지우지 않는다.
    if (signal.server !== undefined) continue;
    if (nowMs - signal.lastActivityAtMs > ZOMBIE_CLEAR_MS) {
      next.delete(key);
      removed += 1;
    }
  }
  if (removed > 0) emit(next);
}

/** Drop everything (session teardown, workspace switch, tests). */
export function resetAgentWorking(): void {
  if (signals.size === 0) return;
  emit(new Map());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ReadonlyMap<Key, AgentWorkingSignal> {
  return signals;
}

/** Test/diagnostic seam: the raw store without a React subscription. */
export const agentWorkingSnapshot = snapshot;

/** All open turns, keyed by `channelId|memberId`. */
export function useAgentWorkingSignals(): ReadonlyMap<Key, AgentWorkingSignal> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Open turns in one channel, oldest first, with stale entries filtered at
 * render time. The filter matters even with the sweep running: between 90s and
 * 120s a stranded signal is still in the store, and no surface may claim it is
 * live.
 */
export function agentTurnsInChannel(
  all: ReadonlyMap<Key, AgentWorkingSignal>,
  channelId: string,
  nowMs: number
): AgentWorkingSignal[] {
  const prefix = `${channelId.toLowerCase()}|`;
  const out: AgentWorkingSignal[] = [];
  for (const [key, signal] of all) {
    if (!key.startsWith(prefix)) continue;
    if (isStaleSignal(signal, nowMs)) continue;
    out.push(signal);
  }
  return out.sort(byOldestTurn);
}

/**
 * 열린 턴 **전체**(채널 너머)에 승인 원장을 덮은 사본 — 사이드바 「작업 중」 카드와 ADE 요약 줄·서랍이 읽는 판 (#5125).
 *
 * 승인 원장이 레일보다 이긴다(#3738): 사람을 기다리는 승인이 있는 에이전트의 턴은 레일이 뭐라 하든 승인 대기이고, 레일이 턴을 잃었어도
 * 승인이 살아 있는 동안은 그 턴이 존재한다. 사이드바의 채널 알약(`Sidebar`)과 컴포저 활동 줄(`ActivityRail`)은 한 채널의 턴에 이
 * 덮어쓰기를 했고(`applyApprovalWaits(agentTurnsInChannel(…))`), 채널 너머를 읽는 이 두 표면은 원본 신호를 그대로 읽어서 같은 에이전트를
 * 「작업 중」·「실행 중」으로 말했다: 서버는 승인에 걸린 run 을 레일 프레임으로 알리지 않는다(중간 프레임은 늘 `running`).
 *
 * 규칙은 코어 `applyApprovalWaits` 하나이고 여기에 새 판정은 없다. 그 규칙이 **채널 하나**를 받으므로 대기 승인이 있는 채널마다 한 번씩
 * 부를 뿐이다. 폰 `clients/mobile/src/features/agents/workingSignal.ts` 의 같은 이름 함수와 같은 규칙이다(스토어 배관이라 각 클라이언트
 * 파일에 있다. 코어로 올리는 것은 후속). 두 가지는 채널 표면과 같게 지킨다.
 *
 *  - 덮기 전에 **만료된 신호를 거른다**(`agentTurnsInChannel`). 90초를 넘긴 `working` 신호를 그대로 넘기면 덮어쓰기가 그 자리에서 승인
 *    대기로 바꾸고 옛 `lastActivityAtMs` 를 그대로 둬서, 읽는 쪽의 만료 거름이 그 턴을 지우고 살아 있는 승인은 아무 데도 안 보인다. 먼저
 *    거르면 덮어쓰기가 승인을 근거로 새 턴을 세운다.
 *  - 기한이 지난 승인은 기다림이 아니다(코어가 `nowMs` 로 거른다). 사이드바에는 시계가 없으므로 호출자가 렌더의 `Date.now()` 를 준다.
 *
 * 대기 승인이 없는 채널은 건드리지 않는다. 대기 승인이 있는 채널에서도 **지우는 것은 없다**(코어 규칙은 턴을 빼지 않는다): 덮은 턴은 같은
 * 키로 원래 항목을 바꾸고, 승인이 세운 턴은 더한다. 덮지 않은 만료 신호는 사본에도 남고 읽는 쪽의 만료 거름이 거른다(같은 키의 만료 신호는
 * 승인이 세운 새 턴이 덮어쓴다). 입력은 바꾸지 않고 사본을 돌려준다(대기가 없으면 같은 객체).
 */
export function withApprovalWaits(
  all: ReadonlyMap<Key, AgentWorkingSignal>,
  waits: readonly ApprovalWait[],
  nowMs: number
): ReadonlyMap<Key, AgentWorkingSignal> {
  if (waits.length === 0) return all;
  // 대기 승인이 있는 채널들. 접은 id 로 합치고(와이어가 대소문자를 섞어 보낸다), 코어에는 받은 그대로 넘긴다.
  const channels = new Map<string, string>();
  for (const wait of waits) channels.set(wait.channelId.toLowerCase(), wait.channelId);

  const next = new Map(all);
  for (const channelId of channels.values()) {
    for (const turn of applyApprovalWaits(
      agentTurnsInChannel(all, channelId, nowMs),
      channelId,
      waits,
      nowMs
    )) {
      next.set(keyOf(turn.channelId, turn.memberId), turn);
    }
  }
  return next;
}

/**
 * Does this channel have any entry at all in the store? Cheap and clock-free,
 * so a surface can decide whether to mount a 1Hz clock BEFORE it has one. Without
 * it the composer would tick once a second because some other channel's agent is
 * busy, which is a render loop bought with nothing on screen.
 */
export function hasChannelTurn(
  all: ReadonlyMap<Key, AgentWorkingSignal>,
  channelId: string
): boolean {
  const prefix = `${channelId.toLowerCase()}|`;
  for (const key of all.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

// ---- elapsed readout --------------------------------------------------------

/**
 * A once-per-second RE-RENDER, mounted only while a clock is actually on
 * screen. The elapsed readout is data cadence rather than animation (it changes
 * exactly as fast as the number it shows), so it keeps ticking under reduced
 * motion.
 *
 * Hoist this to the surface that owns the list, not to each row: ten channel
 * rows must not mean ten intervals. And pass `false` while the realtime rail is
 * down: a clock that keeps counting on a dead socket is measuring our optimism,
 * not the agent's turn.
 *
 * What it returns is the RENDER's own `Date.now()`, never a value the interval
 * captured. Returning a frozen timestamp while disabled was a real defect: the
 * composer fed the same number to `agentTurnsInChannel`, whose whole job is to
 * drop signals older than IDLE_CUTOFF_MS, and a frozen now can never find one
 * stale. The rail is down is exactly when a signal most needs to expire, so the
 * TTL was inert precisely when it mattered. `enabled` decides whether this
 * component re-renders on a timer; it does not decide what time it is.
 */
export function useTickingNow(enabled: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    setTick((t) => t + 1);
    const id = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => clearInterval(id);
  }, [enabled]);
  return Date.now();
}
