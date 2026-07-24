import type { Message } from "@/lib/api";

// =============================================================================
// Timeline ordering model (pure). `seq` is the ONLY ordering authority — never
// arrival time, never createdAtMs. Both REST history (descending pages) and
// realtime publications (best-effort, possibly out of order or duplicated) are
// folded into one strictly-ascending-by-seq array, deduped by seq.
//
// This module is shared by the UI (Timeline.tsx) and the seq gate
// (gates/gate-seq.mjs re-implements the identical fold in JS and asserts the
// invariant), so the gate proves the same ordering the user sees.
// =============================================================================

export interface TimelineState {
  /** Strictly ascending by seq, deduped. Oldest first (render top→bottom). */
  messages: Message[];
  /** Smallest seq loaded — pass as `before` for older history. */
  oldestSeq: number | null;
  /** Largest seq loaded — pass as `after` for realtime-gap backfill. */
  newestSeq: number | null;
}

export function emptyTimeline(): TimelineState {
  return { messages: [], oldestSeq: null, newestSeq: null };
}

/** Binary-search insertion index for `seq` in an ascending array. */
function lowerBound(messages: Message[], seq: number): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (messages[mid].seq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Merge a batch (any order, may overlap existing) into ascending-by-seq order.
 * Last write wins per seq (realtime edits/tombstones replace history rows).
 */
export function mergeMessages(
  state: TimelineState,
  batch: Message[]
): TimelineState {
  if (batch.length === 0) return state;
  const next = state.messages.slice();
  for (const msg of batch) {
    const idx = lowerBound(next, msg.seq);
    if (idx < next.length && next[idx].seq === msg.seq) {
      next[idx] = msg; // replace duplicate seq (edit/tombstone/re-fetch)
    } else {
      next.splice(idx, 0, msg);
    }
  }
  return {
    messages: next,
    oldestSeq: next.length ? next[0].seq : null,
    newestSeq: next.length ? next[next.length - 1].seq : null,
  };
}

/** True iff messages are strictly ascending by seq with no duplicates. */
export function isStrictlyOrdered(messages: Message[]): boolean {
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].seq <= messages[i - 1].seq) return false;
  }
  return true;
}
