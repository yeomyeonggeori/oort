import { useEffect, useState, useSyncExternalStore } from "react";
import {
  byOldestTurn,
  isStaleSignal,
  type AgentWorkingSignal,
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
  byOldestTurn,
  elapsedLabel,
  headlineFrom,
  IDLE_CUTOFF_MS,
  isStaleSignal,
  mergeAgentWorkingSignals,
  resolveAgentWorkingSignals,
  type AgentTurnState,
  type AgentWorkingSignal,
  type AgentWorkingSource,
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
