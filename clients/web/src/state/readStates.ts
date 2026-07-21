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
export function mergeEntry(
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

/** Apply an inactive-channel message immediately while REST re-baselines. */
export function applyIncomingMessage(
  current: ReadStateEntry | undefined,
  seq: number,
  mentioned: boolean
): ReadStateEntry {
  const base = current ?? {
    lastReadSeq: 0,
    latestSeq: 0,
    unreadCount: 0,
    mentionCount: 0,
  };
  if (seq <= base.latestSeq) return base;
  return {
    lastReadSeq: base.lastReadSeq,
    latestSeq: seq,
    unreadCount: Math.max(0, seq - base.lastReadSeq),
    mentionCount: base.mentionCount + (mentioned ? 1 : 0),
  };
}

export function highestVisibleSequence(sequences: Iterable<number>): number {
  let highest = 0;
  for (const sequence of sequences) highest = Math.max(highest, sequence);
  return highest;
}

export interface SequenceDebouncer {
  report: (channelId: string, seq: number) => void;
  cancel: () => void;
}

/** Coalesce visibility churn into one monotonic read-state write per channel. */
export function createSequenceDebouncer(
  flush: (channelId: string, seq: number) => void,
  delayMs = 300
): SequenceDebouncer {
  const pending = new Map<string, { channelId: string; seq: number }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer !== null) globalThis.clearTimeout(timer);
    timer = globalThis.setTimeout(() => {
      timer = null;
      const batch = [...pending.values()];
      pending.clear();
      for (const entry of batch) flush(entry.channelId, entry.seq);
    }, delayMs);
  };
  return {
    report: (channelId, seq) => {
      if (seq <= 0) return;
      const key = channelId.toLowerCase();
      const current = pending.get(key);
      if (!current || seq > current.seq) pending.set(key, { channelId, seq });
      schedule();
    },
    cancel: () => {
      if (timer !== null) globalThis.clearTimeout(timer);
      timer = null;
      pending.clear();
    },
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
  noteIncomingMessage: (channelId: string, seq: number, mentioned: boolean) => void;
  refresh: () => Promise<void>;
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
  const refreshTimerRef = useRef<number | null>(null);

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

  useEffect(
    () => () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    },
    []
  );

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

  const enqueueViewedSeq = useCallback(
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

  const debouncerRef = useRef<SequenceDebouncer | null>(null);
  useEffect(() => {
    const debouncer = createSequenceDebouncer(enqueueViewedSeq);
    debouncerRef.current = debouncer;
    return () => {
      debouncer.cancel();
      debouncerRef.current = null;
    };
  }, [enqueueViewedSeq]);

  const reportViewedSeq = useCallback((channelId: string, seq: number) => {
    debouncerRef.current?.report(channelId, seq);
  }, []);

  const noteIncomingMessage = useCallback(
    (channelId: string, seq: number, mentioned: boolean) => {
      const key = channelId.toLowerCase();
      setEntries((current) => {
        const previous = current.get(key);
        const nextEntry = applyIncomingMessage(previous, seq, mentioned);
        if (nextEntry === previous) return current;
        const next = new Map(current);
        next.set(key, nextEntry);
        return next;
      });
      // The local increment is immediate; the canonical projection corrects
      // gaps, mention counts, and concurrent reads from other tabs.
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void loadAll();
      }, 500);
    },
    [loadAll]
  );

  const entryFor = useCallback(
    (channelId: string) => entries.get(channelId.toLowerCase()) ?? null,
    [entries]
  );

  return { entryFor, reportViewedSeq, noteIncomingMessage, refresh: loadAll };
}
