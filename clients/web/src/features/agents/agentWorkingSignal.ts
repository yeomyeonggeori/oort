import { useSyncExternalStore } from "react";

// =============================================================================
// agentWorkingSignal: ONE source for "an agent is taking a turn right now"
// (R-1 §1). The sidebar badge, the composer line and the timeline chip all read
// this store, so they can never disagree.
//
// The signal is meant to be fed by real observation events (ADR-0126), not by
// typing indicators: a typing indicator can be forged, a turn cannot. Until the
// observation surface lands, the store stays EMPTY on purpose, because rendering a
// decorative "working" badge with no real turn behind it is exactly the banned
// pattern (design-taste-web §8, decorative status dots).
// =============================================================================

export interface AgentWorkingSignal {
  /** The agent member taking the turn. */
  memberId: string;
  /** Channel the turn is happening in. */
  channelId: string;
  /** Epoch ms the turn started; the badge renders elapsed time from this. */
  startedAtMs: number;
}

type Key = string;

function keyOf(channelId: string, memberId: string): Key {
  return `${channelId.toLowerCase()}|${memberId.toLowerCase()}`;
}

let signals: ReadonlyMap<Key, AgentWorkingSignal> = new Map();
const listeners = new Set<() => void>();

function emit(next: ReadonlyMap<Key, AgentWorkingSignal>): void {
  signals = next;
  for (const listener of listeners) listener();
}

/** Record (or refresh) a turn. Called by the observation event consumer. */
export function markAgentWorking(signal: AgentWorkingSignal): void {
  const key = keyOf(signal.channelId, signal.memberId);
  const existing = signals.get(key);
  if (existing && existing.startedAtMs === signal.startedAtMs) return;
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ReadonlyMap<Key, AgentWorkingSignal> {
  return signals;
}

/** All active turns, keyed by `channelId|memberId`. */
export function useAgentWorkingSignals(): ReadonlyMap<Key, AgentWorkingSignal> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Active turns in one channel, oldest first. */
export function workingInChannel(
  all: ReadonlyMap<Key, AgentWorkingSignal>,
  channelId: string
): AgentWorkingSignal[] {
  const prefix = `${channelId.toLowerCase()}|`;
  const out: AgentWorkingSignal[] = [];
  for (const [key, signal] of all) {
    if (key.startsWith(prefix)) out.push(signal);
  }
  return out.sort((a, b) => a.startedAtMs - b.startedAtMs);
}

/** Compact elapsed label for a turn badge: 12s, 3m, 1h. */
export function elapsedLabel(startedAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
