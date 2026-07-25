import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMessages, type Message } from "@/lib/api";
import type { MessageNewEvent, RealtimeHandle } from "@/lib/realtime";
import {
  emptyTimeline,
  reconcileMessages,
  type RecoveryMarker,
  type TimelineState,
} from "./model";

const HEAD_LIMIT = 50;
const PAGE_LIMIT = 50;

function payloadToMessage(p: MessageNewEvent["payload"]): Message {
  return {
    id: p.id,
    channelId: p.channel_id,
    seq: p.seq,
    hlcTs: p.hlc_ts,
    hlcCount: p.hlc_count,
    authorMemberId: p.author_member_id,
    type: (p.type as Message["type"]) ?? "text",
    body: p.body ?? undefined,
    state: (p.state as Message["state"]) ?? "sent",
    createdAtMs: p.created_at_ms ?? Date.now(),
  };
}

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
  loadOlder: () => Promise<void>;
  reload: () => void;
  loadingOlder: boolean;
  reachedStart: boolean;
}

/**
 * Loads channel history head, subscribes the realtime rail, and heals gaps via
 * REST `?after` backfill on a non-recovered resubscribe. `seq` is the sole
 * ordering authority throughout (reconcileMessages).
 *
 * Every heal also records a RecoveryMarker so the timeline can state exactly
 * how far it was restored, which is only possible because the server issues a
 * monotonic seq (R-1 §3).
 */
export function useTimeline(
  realtime: RealtimeHandle | null,
  workspaceId: string,
  channelId: string | null
): UseTimelineResult {
  const [state, setState] = useState<TimelineState>(emptyTimeline);
  const [status, setStatus] = useState<UseTimelineResult["status"]>("loading");
  const [resume, setResume] = useState<ResumeInfo>({
    lastRecovered: null,
    lastBackfillCount: 0,
    resubscribeCount: 0,
  });
  const [recoveryMarkers, setRecoveryMarkers] = useState<RecoveryMarker[]>([]);
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
    if (!channelId || !realtime) return;
    let cancelled = false;
    firstSubscribeRef.current = true;
    newestSeqRef.current = null;
    markerCounterRef.current = 0;
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
    loadOlder,
    reload,
    loadingOlder,
    reachedStart,
  };
}
