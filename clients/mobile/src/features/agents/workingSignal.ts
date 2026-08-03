import {useEffect, useState, useSyncExternalStore} from 'react';
import {
  byOldestTurn,
  isStaleSignal,
  type AgentWorkingSignal,
} from '@momo/core/features/agents/workingSignal';

// =============================================================================
// 「이 에이전트에게 지금 열린 턴이 있는가」 — the phone's half (goal RN-T2).
//
// The RULES are the core's (`@momo/core/features/agents/workingSignal`): the
// three types, the 90s TTL, `isStaleSignal`, the concurrent-run merge,
// `headlineFrom`, `elapsedLabel`, and the one that this whole file exists to
// serve — **no surface may render `awaiting_approval` as 작업 중**. Nothing
// here re-decides any of them.
//
// What IS here is the part the core cannot hold: a module-level mutable map, a
// `useSyncExternalStore` subscription over it, and a `setInterval` clock. The
// web client keeps the same three in
// `clients/web/src/features/agents/agentWorkingSignal.ts` and its header says
// why: they are platform state, and the purity gate rejects them on sight
// (ADR-0137 D3). Its comment then said "React Native will subscribe to its own
// realtime rail when it has one" — this is that store, written against the rail
// `src/realtime/` has had since RN-C3.
//
// ## A second store is not a second answer
//
// The constants and the meanings are the web file's, deliberately identical:
// `ZOMBIE_CLEAR_MS` is the same 120s over the same 90s TTL, the key is the same
// case-folded `channelId|memberId`, and the render-time staleness filter is the
// same one. Two clients that disagree about when a badge goes out have shipped
// a defect, not a variation. What is NOT copied is anything that could have
// lived in the core: every judgement below is a call into it.
//
// The one function web has no use for is `agentTurnsForMember`. The phone's
// 에이전트 tab is a list of AGENTS, not of channels, so a row there asks "does
// this agent have an open turn anywhere" — the same store, read down the other
// axis.
// =============================================================================

/**
 * Hard clear: past this, the entry is REMOVED from the store, not merely
 * hidden. The gap over the 90s TTL is deliberate and is the web file's number
 * for the web file's reason. Between 90s and 120s a run that resumes publishing
 * is still the same turn and keeps its original clock; after 120s of total
 * silence the entry is a zombie of a rail that went away, and nothing may
 * resurrect it.
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
    a.headlines.length === b.headlines.length &&
    a.headlines.every((headline, index) => headline === b.headlines[index])
  );
}

/**
 * Record (or refresh) a turn. The caller has already merged that agent's
 * concurrent runs through the core's `resolveAgentWorkingSignals`, so this is an
 * upsert and not a second merge policy: two merge rules in two places is how the
 * 에이전트 목록 and the 대화 화면 would end up disagreeing about one turn.
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
 * `ZOMBIE_CLEAR_MS`. Runs on a timer independent of any one surface, so a
 * stranded turn cannot survive in the store just because nobody is looking at
 * the channel it belongs to.
 */
export function sweepAgentWorking(nowMs: number): void {
  const next = new Map(signals);
  let removed = 0;
  for (const [key, signal] of signals) {
    if (nowMs - signal.lastActivityAtMs > ZOMBIE_CLEAR_MS) {
      next.delete(key);
      removed += 1;
    }
  }
  if (removed > 0) emit(next);
}

/** Drop everything (sign-out, workspace switch, tests). */
export function resetAgentWorking(): void {
  if (signals.size === 0) return;
  emit(new Map());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
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
 * Open turns in one channel, oldest first, with stale entries filtered at RENDER
 * time. The filter matters even with the sweep running: between 90s and 120s a
 * stranded signal is still in the store, and no surface may claim it is live.
 */
export function agentTurnsInChannel(
  all: ReadonlyMap<Key, AgentWorkingSignal>,
  channelId: string,
  nowMs: number,
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
 * Open turns belonging to ONE agent, across every channel, oldest first.
 *
 * The 에이전트 탭 is a list of agents rather than of channels, so its row asks a
 * question the sidebar never has to: is this agent working ANYWHERE. Same store,
 * same staleness filter, same order — only the axis differs.
 */
export function agentTurnsForMember(
  all: ReadonlyMap<Key, AgentWorkingSignal>,
  memberId: string,
  nowMs: number,
): AgentWorkingSignal[] {
  const suffix = `|${memberId.toLowerCase()}`;
  const out: AgentWorkingSignal[] = [];
  for (const [key, signal] of all) {
    if (!key.endsWith(suffix)) continue;
    if (isStaleSignal(signal, nowMs)) continue;
    out.push(signal);
  }
  return out.sort(byOldestTurn);
}

/**
 * Does this channel have any entry at all in the store? Cheap and CLOCK-FREE,
 * so a surface can decide whether to mount a 1Hz clock before it has one.
 * Without it the conversation screen would re-render once a second because some
 * other channel's agent is busy — a render loop bought with nothing on screen,
 * and on a phone that is battery.
 */
export function hasChannelTurn(
  all: ReadonlyMap<Key, AgentWorkingSignal>,
  channelId: string,
): boolean {
  const prefix = `${channelId.toLowerCase()}|`;
  for (const key of all.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

// ---- elapsed readout --------------------------------------------------------

/**
 * A once-per-second RE-RENDER, mounted only while a clock is actually on screen.
 * The elapsed readout is data cadence rather than animation (it changes exactly
 * as fast as the number it shows), so it keeps ticking under reduced motion.
 *
 * Hoist this to the surface that owns the list, not to each row: ten rows must
 * not mean ten intervals. And pass `false` while the realtime rail is down — a
 * clock that keeps counting on a dead socket is measuring our optimism, not the
 * agent's turn.
 *
 * What it returns is the RENDER's own `Date.now()`, never a value the interval
 * captured. Returning a frozen timestamp while disabled was a real defect on
 * web: the composer fed the same number to `agentTurnsInChannel`, whose whole
 * job is to drop signals older than the TTL, and a frozen now can never find one
 * stale. The rail being down is exactly when a signal most needs to expire, so
 * the TTL was inert precisely when it mattered. `enabled` decides whether this
 * component re-renders on a timer; it does not decide what time it is.
 */
export function useTickingNow(enabled: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    setTick(tick => tick + 1);
    const id = setInterval(() => setTick(tick => tick + 1), 1_000);
    return () => clearInterval(id);
  }, [enabled]);
  return Date.now();
}
