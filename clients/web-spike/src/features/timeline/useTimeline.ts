import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMessages, type Message } from "@/lib/api";
import type { MessageNewEvent, RealtimeHandle } from "@/lib/realtime";
import {
  emptyTimeline,
  mergeMessages,
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
  loadOlder: () => Promise<void>;
  loadingOlder: boolean;
  reachedStart: boolean;
}

/**
 * Loads channel history head, subscribes the realtime rail, and heals gaps via
 * REST `?after` backfill on a non-recovered resubscribe. `seq` is the sole
 * ordering authority throughout (mergeMessages).
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
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reachedStart, setReachedStart] = useState(false);

  // Refs so the realtime callbacks always see the latest cursor without
  // re-subscribing on every state change.
  const newestSeqRef = useRef<number | null>(null);
  newestSeqRef.current = state.newestSeq;
  const firstSubscribeRef = useRef(true);

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
        setState((s) => mergeMessages(s, page.messages));
        const maxSeq = page.messages.reduce((m, x) => Math.max(m, x.seq), after);
        if (maxSeq <= after) break;
        after = maxSeq;
        if (page.messages.length < PAGE_LIMIT) break;
      }
      return total;
    },
    [workspaceId]
  );

  useEffect(() => {
    if (!channelId || !realtime) return;
    let cancelled = false;
    firstSubscribeRef.current = true;
    setState(emptyTimeline());
    setStatus("loading");
    setReachedStart(false);
    setResume({ lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0 });

    // 1) REST head (descending page; merge is order-agnostic).
    fetchMessages(workspaceId, channelId, { limit: HEAD_LIMIT })
      .then((page) => {
        if (cancelled) return;
        setState((s) => mergeMessages(s, page.messages));
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
        // A non-recovered (re)subscribe may have missed publications: pull the
        // authoritative tail from PG. (Also safe on first subscribe.)
        if (!recovered) {
          backfillAfter(channelId).then((count) => {
            if (!cancelled && !isFirst) {
              setResume((r) => ({ ...r, lastBackfillCount: count }));
            }
          });
        }
      },
      onMessage: (event) => {
        if (cancelled) return;
        setState((s) => mergeMessages(s, [payloadToMessage(event.payload)]));
      },
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [realtime, workspaceId, channelId, backfillAfter]);

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
      setState((s) => mergeMessages(s, page.messages));
      if (page.nextBefore === undefined) setReachedStart(true);
    } finally {
      setLoadingOlder(false);
    }
  }, [workspaceId, channelId, state.oldestSeq, loadingOlder, reachedStart]);

  return { state, status, resume, loadOlder, loadingOlder, reachedStart };
}
