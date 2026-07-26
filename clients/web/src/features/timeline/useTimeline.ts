import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchMessages,
  sendMessage,
  type Message,
  type RequestRouting,
} from "@/lib/api";
import { payloadToMessage, type RealtimeHandle } from "@/lib/realtime";
import {
  addPending,
  emptyTimeline,
  failPending,
  reconcileMessages,
  removePending,
  retryPending,
  unsettledPending,
  type PendingMessage,
  type RecoveryMarker,
  type TimelineState,
} from "./model";

const HEAD_LIMIT = 50;
const PAGE_LIMIT = 50;

export interface ResumeInfo {
  /** How the last (re)subscribe resolved. */
  lastRecovered: boolean | null;
  /** Messages recovered by the last REST `?after` backfill after a gap. */
  lastBackfillCount: number;
  resubscribeCount: number;
}

export interface UseTimelineResult {
  state: TimelineState;
  status: "loading" | "ready" | "error";
  resume: ResumeInfo;
  /** Reconnect markers, rendered inline as "재연결됨, seq N까지 복구". */
  recoveryMarkers: RecoveryMarker[];
  /** Local echoes awaiting their server seq (M10). Never inside `state`. */
  pending: PendingMessage[];
  /**
   * The one send path: optimistic echo now, server seq when it lands.
   * `routing` is the composer's per-request override (ADR-0134 D1); it rides
   * the pending row so a retry re-sends the choice the person actually made
   * rather than quietly falling back to the inherited value.
   */
  send: (body: string, routing?: RequestRouting) => Promise<void>;
  /** Re-run a failed echo with the SAME idempotency key. */
  resend: (clientMsgId: string) => Promise<void>;
  loadOlder: () => Promise<void>;
  reload: () => void;
  loadingOlder: boolean;
  reachedStart: boolean;
}

/**
 * Loads channel history head, subscribes the realtime rail, heals gaps via REST
 * `?after` backfill on a non-recovered resubscribe, and owns the send path.
 * `seq` is the sole ordering authority throughout (reconcileMessages).
 *
 * Every heal also records a RecoveryMarker so the timeline can state exactly
 * how far it was restored, which is only possible because the server issues a
 * monotonic seq (R-1 §3).
 */
export function useTimeline(
  realtime: RealtimeHandle | null,
  workspaceId: string,
  channelId: string | null,
  authorMemberId: string
): UseTimelineResult {
  const [state, setState] = useState<TimelineState>(emptyTimeline);
  const [status, setStatus] = useState<UseTimelineResult["status"]>("loading");
  const [resume, setResume] = useState<ResumeInfo>({
    lastRecovered: null,
    lastBackfillCount: 0,
    resubscribeCount: 0,
  });
  const [recoveryMarkers, setRecoveryMarkers] = useState<RecoveryMarker[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reachedStart, setReachedStart] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Authoritative newest-seq cursor, updated at merge time rather than at
  // render time, so a resubscribe firing between renders still reads truth.
  const newestSeqRef = useRef<number | null>(null);
  const firstSubscribeRef = useRef(true);
  const markerCounterRef = useRef(0);

  const applyBatch = useCallback((batch: Message[]) => {
    if (batch.length === 0) return;
    for (const message of batch) {
      if (newestSeqRef.current === null || message.seq > newestSeqRef.current) {
        newestSeqRef.current = message.seq;
      }
    }
    setState((s) => reconcileMessages(s, batch));
  }, []);

  const addMarker = useCallback((source: RecoveryMarker["source"]) => {
    const seq = newestSeqRef.current;
    if (seq === null) return;
    markerCounterRef.current += 1;
    setRecoveryMarkers((markers) => [
      ...markers,
      { id: `recovery-${markerCounterRef.current}`, seq, source },
    ]);
  }, []);

  // ---- optimistic send (M10) ------------------------------------------------
  // The pending list is mirrored in a ref so a retry can read the row it is
  // retrying without making the callbacks depend on the list (which would
  // rebuild the composer's handler on every keystroke of every other sender).
  const pendingRef = useRef<PendingMessage[]>([]);
  const updatePending = useCallback(
    (fn: (list: PendingMessage[]) => PendingMessage[]) => {
      pendingRef.current = fn(pendingRef.current);
      setPending(pendingRef.current);
    },
    []
  );

  // Which channel the hook is currently showing, read by in-flight sends that
  // resolved after the user moved on. Without it a POST for channel A could
  // merge its row into channel B's timeline.
  const channelRef = useRef<string | null>(null);

  const post = useCallback(
    async (row: PendingMessage) => {
      try {
        const confirmed = await sendMessage(
          workspaceId,
          row.channelId,
          row.clientMsgId,
          row.body,
          row.routing
        );
        // The response IS the committed server echo (seq-authoritative), so
        // merging it is not optimistic rendering: it is the same reconcile the
        // realtime frame gets, and whichever arrives second dedupes by seq.
        if (channelRef.current === row.channelId) applyBatch([confirmed]);
        updatePending((list) => removePending(list, row.clientMsgId));
      } catch {
        // The row stays where it is and states 전송 실패 with a retry (R-1 §3),
        // which is the same inline failure path a server-stored `failed`
        // message row uses. No toast, no banner far from the message.
        updatePending((list) => failPending(list, row.clientMsgId));
      }
    },
    [workspaceId, applyBatch, updatePending]
  );

  const send = useCallback(
    async (body: string, routing?: RequestRouting) => {
      const channel = channelId;
      if (channel === null || body === "") return;
      const row: PendingMessage = {
        clientMsgId: crypto.randomUUID(),
        channelId: channel,
        authorMemberId,
        body,
        ...(routing ? { routing } : {}),
        // Local clock, used only for grouping and the time label on a row that
        // has not been ordered yet. Ordering still waits for seq.
        createdAtMs: Date.now(),
        sinceSeq: newestSeqRef.current,
        status: "sending",
      };
      updatePending((list) => addPending(list, row));
      await post(row);
    },
    [channelId, authorMemberId, post, updatePending]
  );

  const resend = useCallback(
    async (clientMsgId: string) => {
      const row = pendingRef.current.find((p) => p.clientMsgId === clientMsgId);
      if (!row || row.status === "sending") return;
      updatePending((list) => retryPending(list, clientMsgId));
      await post(row);
    },
    [post, updatePending]
  );

  const backfillAfter = useCallback(
    async (channel: string) => {
      let after = newestSeqRef.current ?? 0;
      let total = 0;
      // Loop ascending pages until the server returns fewer than requested.
      for (;;) {
        const page = await fetchMessages(workspaceId, channel, {
          after,
          limit: PAGE_LIMIT,
        });
        if (page.messages.length === 0) break;
        total += page.messages.length;
        applyBatch(page.messages);
        const maxSeq = page.messages.reduce((m, x) => Math.max(m, x.seq), after);
        if (maxSeq <= after) break;
        after = maxSeq;
        if (page.messages.length < PAGE_LIMIT) break;
      }
      return total;
    },
    [workspaceId, applyBatch]
  );

  useEffect(() => {
    channelRef.current = channelId;
  }, [channelId]);

  // Drop echoes whose confirmed twin has landed in the seq stream, even when
  // the POST that created them never resolved. That case is real: if the write
  // committed but the response was lost, the realtime frame delivers the row
  // and the echo is settled by content, while the request may hang forever.
  // The render fold already hides such a row; without this the entry would sit
  // in state for the rest of the session and be reported as still sending.
  useEffect(() => {
    const open = unsettledPending(state.messages, pendingRef.current);
    if (open.length !== pendingRef.current.length) updatePending(() => open);
  }, [state.messages, updatePending]);

  useEffect(() => {
    if (!channelId || !realtime) return;
    let cancelled = false;
    firstSubscribeRef.current = true;
    newestSeqRef.current = null;
    markerCounterRef.current = 0;
    updatePending(() => []);
    setState(emptyTimeline());
    setStatus("loading");
    setReachedStart(false);
    setRecoveryMarkers([]);
    setResume({ lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0 });

    // 1) REST head (descending page; merge is order-agnostic).
    fetchMessages(workspaceId, channelId, { limit: HEAD_LIMIT })
      .then((page) => {
        if (cancelled) return;
        applyBatch(page.messages);
        setReachedStart(page.nextBefore === undefined);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    // 2) Realtime rail with resume healing.
    const unsub = realtime.subscribeChannel(workspaceId, channelId, {
      onSubscribed: (recovered) => {
        if (cancelled) return;
        const isFirst = firstSubscribeRef.current;
        firstSubscribeRef.current = false;
        setResume((r) => ({
          ...r,
          lastRecovered: recovered,
          resubscribeCount: r.resubscribeCount + (isFirst ? 0 : 1),
        }));
        if (!recovered) {
          // A non-recovered (re)subscribe may have missed publications: pull
          // the authoritative tail from PG. (Also safe on first subscribe.)
          backfillAfter(channelId).then((count) => {
            if (cancelled || isFirst) return;
            setResume((r) => ({ ...r, lastBackfillCount: count }));
            addMarker("backfill");
          });
        } else if (!isFirst) {
          // The transport replayed the gap. Let the recovered publications
          // land, then state how far the timeline was restored.
          setTimeout(() => {
            if (!cancelled) addMarker("replay");
          }, 0);
        }
      },
      onMessage: (event) => {
        if (cancelled) return;
        applyBatch([payloadToMessage(event.payload)]);
      },
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [
    realtime,
    workspaceId,
    channelId,
    backfillAfter,
    applyBatch,
    addMarker,
    updatePending,
    reloadNonce,
  ]);

  const loadOlder = useCallback(async () => {
    if (!channelId || loadingOlder || reachedStart) return;
    const oldest = state.oldestSeq;
    if (oldest === null) return;
    setLoadingOlder(true);
    try {
      const page = await fetchMessages(workspaceId, channelId, {
        before: oldest,
        limit: PAGE_LIMIT,
      });
      setState((s) => reconcileMessages(s, page.messages));
      if (page.nextBefore === undefined) setReachedStart(true);
    } finally {
      setLoadingOlder(false);
    }
  }, [workspaceId, channelId, state.oldestSeq, loadingOlder, reachedStart]);

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  return {
    state,
    status,
    resume,
    recoveryMarkers,
    pending,
    send,
    resend,
    loadOlder,
    reload,
    loadingOlder,
    reachedStart,
  };
}
