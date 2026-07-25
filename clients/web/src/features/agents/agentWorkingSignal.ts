import { useEffect, useState, useSyncExternalStore } from "react";

// =============================================================================
// agentWorkingSignal: ONE source for "an agent is taking a turn right now"
// (R-1 §1). The sidebar badge and the composer activity line both read this
// store, so they can never disagree.
//
// The rules here are the web port of the mac resolver
// (clients/macOS/Sources/MomoMac/AgentWorkingSignal.swift, MOMO-568), kept
// rule-for-rule so the two clients cannot drift into two different answers to
// "is this agent working":
//
//   - source priority run > status > typing. A turn is proven by observation
//     (ADR-0126), never by a typing indicator alone: typing can be forged, a run
//     cannot. `typing` stays the weakest rank and no web producer feeds it,
//     because no server surface publishes `typing.*` for agents today.
//   - one signal per agent per channel. Concurrent runs merge: earliest start
//     wins the clock, headlines are unioned, the strongest source survives.
//   - 90s idle TTL. A signal whose last observed activity is older than the
//     cutoff is treated as gone even if its terminal event never arrived, so a
//     lost frame cannot strand a badge with a clock running away to hours.
//
// On top of the mac rules the web adds one thing the mac gets from its view
// model lifecycle: a hard 2-minute sweep that DELETES a stranded entry from the
// store, not just from the render. See ZOMBIE_CLEAR_MS.
// =============================================================================

/** Which realtime source proved the agent is working, in priority order. */
export type AgentWorkingSource = "run" | "status" | "typing";

const SOURCE_RANK: Record<AgentWorkingSource, number> = {
  run: 3,
  status: 2,
  typing: 1,
};

export interface AgentWorkingSignal {
  /** The agent member taking the turn. */
  memberId: string;
  /** Channel the turn is happening in. */
  channelId: string;
  /** Which observation proved it. */
  source: AgentWorkingSource;
  /** The live run behind the turn, when one is known. */
  runId?: string;
  /**
   * Epoch ms the turn started; the surfaces render elapsed time from this.
   * Absent for a typing-only fallback, where no run clock exists yet and the
   * elapsed readout is omitted rather than invented.
   */
  startedAtMs?: number;
  /**
   * Rotating headline candidates drawn from agent-authored content (the last
   * streamed line). Empty until the agent has produced one, in which case the
   * composer states the turn without a headline instead of rotating nothing.
   */
  headlines: string[];
  /** Last moment fresh activity was observed. Drives the TTL and the sweep. */
  lastActivityAtMs: number;
}

/**
 * Idle cutoff: past this, a signal self-expires even though no terminal event
 * ever arrived, and every surface stops rendering it on the next tick.
 */
export const IDLE_CUTOFF_MS = 90_000;

/**
 * Hard clear: past this, the entry is REMOVED from the store, not merely hidden.
 * The gap over the TTL is deliberate. Between 90s and 120s a run that resumes
 * publishing is still the same turn and keeps its original clock; after 120s of
 * total silence the entry is treated as a zombie of a rail that went away, and
 * nothing may resurrect it.
 */
export const ZOMBIE_CLEAR_MS = 120_000;

const MAX_HEADLINES = 3;
const MAX_HEADLINE_LENGTH = 140;

type Key = string;

function keyOf(channelId: string, memberId: string): Key {
  return `${channelId.toLowerCase()}|${memberId.toLowerCase()}`;
}

// ---- pure rules (ported from AgentWorkingSignalResolver) --------------------

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
 */
export function mergeAgentWorkingSignals(
  candidates: readonly AgentWorkingSignal[]
): AgentWorkingSignal | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const starts = candidates
    .map((c) => c.startedAtMs)
    .filter((v): v is number => typeof v === "number");
  const earliest = starts.length > 0 ? Math.min(...starts) : undefined;
  const anchor =
    candidates.find((c) => c.startedAtMs === earliest) ?? candidates[0];

  const headlines: string[] = [];
  for (const candidate of candidates) {
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
    source,
    headlines: headlines.slice(0, MAX_HEADLINES),
    lastActivityAtMs: Math.max(...candidates.map((c) => c.lastActivityAtMs)),
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
  const byAgent = new Map<Key, AgentWorkingSignal[]>();
  for (const candidate of candidates) {
    if (isStaleSignal(candidate, nowMs, idleCutoffMs)) continue;
    const key = keyOf(candidate.channelId, candidate.memberId);
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
function byOldestTurn(a: AgentWorkingSignal, b: AgentWorkingSignal): number {
  const left = a.startedAtMs ?? Number.POSITIVE_INFINITY;
  const right = b.startedAtMs ?? Number.POSITIVE_INFINITY;
  return left - right;
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

/** All active turns, keyed by `channelId|memberId`. */
export function useAgentWorkingSignals(): ReadonlyMap<Key, AgentWorkingSignal> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Active turns in one channel, oldest first, with stale entries filtered at
 * render time. The filter matters even with the sweep running: between 90s and
 * 120s a stranded signal is still in the store, and no surface may claim it is
 * live.
 */
export function workingInChannel(
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

/**
 * A once-per-second clock, mounted only while something is actually working.
 * The elapsed readout is data cadence rather than animation (it changes exactly
 * as fast as the number it shows), so it keeps ticking under reduced motion.
 *
 * Hoist this to the surface that owns the list, not to each row: ten channel
 * rows must not mean ten intervals.
 */
export function useTickingNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}
