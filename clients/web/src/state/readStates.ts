import { useCallback, useEffect, useRef, useState } from "react";
import { fetchReadStates, updateReadState } from "../api/client";
import type { RealtimeHandle } from "../realtime/realtime";

// =============================================================================
// Read-state store (ADR-0109, web consumption — MOMO-400).
//
//   - The server projection is the unread authority. This store only mirrors
//     it: bulk GET on entry, PUT responses, and `user:read-state#<member-id>`
//     pushes all funnel through one monotonic merge.
//   - Cursor writes are monotonic BY CONTRACT server-side
//     (max(current, min(requested, latestSeq))) and this client additionally
//     never REQUESTS a regression: a PUT is only issued for a seq strictly
//     above both the known cursor and anything already requested.
//   - UUID casing is mixed on the wire (Swift uuidString = UPPERCASE, PG JSON
//     = lowercase); every map key is lowercased.
// =============================================================================

export interface ReadStateEntry {
  lastReadSeq: number;
  latestSeq: number;
  unreadCount: number;
  mentionCount: number;
}

/** Snake-case server shape shared by REST ReadState and the push payload. */
interface ServerReadState {
  channel_id: string;
  last_read_seq: number;
  latest_seq: number;
  unread_count: number;
  mention_count: number;
}

function toEntry(state: ServerReadState): ReadStateEntry {
  return {
    lastReadSeq: state.last_read_seq,
    latestSeq: state.latest_seq,
    unreadCount: state.unread_count,
    mentionCount: state.mention_count,
  };
}

/**
 * Monotonic merge: cursors and heads only move forward. A stale snapshot
 * (older push replayed by recovery, or a PUT response racing a newer push)
 * must never regress the visible unread count.
 */
function mergeEntry(
  current: ReadStateEntry | undefined,
  incoming: ReadStateEntry
): ReadStateEntry {
  if (!current) return incoming;
  if (
    incoming.lastReadSeq <= current.lastReadSeq &&
    incoming.latestSeq <= current.latestSeq
  ) {
    return current;
  }
  const lastReadSeq = Math.max(current.lastReadSeq, incoming.lastReadSeq);
  const latestSeq = Math.max(current.latestSeq, incoming.latestSeq);
  return {
    lastReadSeq,
    latestSeq,
    unreadCount: Math.max(0, latestSeq - lastReadSeq),
    // mention_count is a server-computed projection tied to the cursor; take
    // it from whichever side carries the newer cursor.
    mentionCount:
      incoming.lastReadSeq >= current.lastReadSeq
        ? incoming.mentionCount
        : current.mentionCount,
  };
}

interface PutPipeline {
  inFlight: boolean;
  /** Highest seq already sent (or being sent) — never re-request lower. */
  requestedSeq: number;
  /** Trailing request accumulated while a PUT is in flight. */
  pendingSeq: number | null;
}

export interface ReadStatesStore {
  /** Lowercase-keyed lookup; null until the bulk GET (or a push) lands. */
  entryFor: (channelId: string) => ReadStateEntry | null;
  /**
   * The timeline reports the highest server-committed seq currently visible
   * for a channel the user is viewing; the store advances the cursor.
   */
  reportViewedSeq: (channelId: string, seq: number) => void;
}

export function useReadStates(
  workspaceId: string,
  memberId: string,
  realtime: RealtimeHandle | null
): ReadStatesStore {
  const [entries, setEntries] = useState<Map<string, ReadStateEntry>>(
    () => new Map()
  );
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const pipelinesRef = useRef(new Map<string, PutPipeline>());

  const applyServerState = useCallback((state: ServerReadState) => {
    const key = state.channel_id.toLowerCase();
    setEntries((current) => {
      const merged = mergeEntry(current.get(key), toEntry(state));
      if (current.get(key) === merged) return current;
      const next = new Map(current);
      next.set(key, merged);
      return next;
    });
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const response = await fetchReadStates(workspaceId);
      for (const state of response.read_states) applyServerState(state);
    } catch {
      // Transient; unread badges simply stay stale until the next signal.
    }
  }, [applyServerState, workspaceId]);

  // Initial baseline.
  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Personal-channel subscription: cursor advances from ANY of this member's
  // devices/tabs land here. recovered:false => the missed pushes are healed
  // with a bulk GET re-baseline (REST is the authority, as with messages).
  useEffect(() => {
    if (!realtime) return;
    const unsubscribe = realtime.subscribeReadState(memberId, {
      onSubscribed: (recovered) => {
        if (!recovered) void loadAll();
      },
      onPublication: (event) => {
        applyServerState(event.payload);
      },
    });
    return unsubscribe;
  }, [applyServerState, loadAll, memberId, realtime]);

  const runPutLoop = useCallback(
    (channelId: string, key: string) => {
      const pipeline = pipelinesRef.current.get(key);
      if (!pipeline || pipeline.inFlight) return;
      const seq = pipeline.pendingSeq;
      if (seq === null) return;
      pipeline.pendingSeq = null;
      pipeline.inFlight = true;
      pipeline.requestedSeq = Math.max(pipeline.requestedSeq, seq);
      void (async () => {
        try {
          const state = await updateReadState(workspaceId, channelId, seq);
          applyServerState(state);
        } catch {
          // Dropped PUT: allow a later report to retry this seq.
          pipeline.requestedSeq = Math.min(pipeline.requestedSeq, seq - 1);
        } finally {
          pipeline.inFlight = false;
          runPutLoop(channelId, key);
        }
      })();
    },
    [applyServerState, workspaceId]
  );

  const reportViewedSeq = useCallback(
    (channelId: string, seq: number) => {
      if (seq <= 0) return;
      const key = channelId.toLowerCase();
      const known = entriesRef.current.get(key)?.lastReadSeq ?? 0;
      let pipeline = pipelinesRef.current.get(key);
      if (!pipeline) {
        pipeline = { inFlight: false, requestedSeq: 0, pendingSeq: null };
        pipelinesRef.current.set(key, pipeline);
      }
      // Monotonic client guard: never request a cursor at or below what the
      // server already has, nor below something already requested.
      if (seq <= known || seq <= pipeline.requestedSeq) return;
      pipeline.pendingSeq = Math.max(pipeline.pendingSeq ?? 0, seq);
      runPutLoop(channelId, key);
    },
    [runPutLoop]
  );

  const entryFor = useCallback(
    (channelId: string) => entries.get(channelId.toLowerCase()) ?? null,
    [entries]
  );

  return { entryFor, reportViewedSeq };
}
