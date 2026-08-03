import {
  fetchMessages,
  fetchReactionSnapshot,
  sendMessage,
  type Message,
} from '@momo/core/lib/api';
import {
  payloadToMessage,
  type MessageNewEvent,
} from '@momo/core/lib/realtimeEvents';
import {
  addPending,
  applyTombstone,
  emptyTimeline,
  failPending,
  reconcileMessages,
  removePending,
  retryPending,
  unsettledPending,
  type PendingMessage,
  type RecoveryMarker,
  type TimelineState,
} from '@momo/core/features/timeline/model';
import {
  applyReactionDelta,
  clearMessageReactions,
  emptyReactions,
  normalizeReactionSnapshot,
  type ReactionMap,
} from '@momo/core/features/timeline/reactions';
import {useCallback, useEffect, useRef, useState} from 'react';
import type {ChannelRail} from '../../realtime/channelRail';

// =============================================================================
// One channel's messages: load, receive, send.
//
// The RN sibling of `clients/web/src/features/timeline/useTimeline.ts`, and
// deliberately the same shape — same merge point, same settlement rule, same
// resume healing. ADR-0137 D3 keeps react hooks in the HOST rather than the
// core, so this is host wiring; every decision it wires is the core's.
//
// ## Why this is not react-query, when everything else on this client is
//
// `features/workspace/queries.ts` and `features/inbox/useInbox.ts` are both
// react-query, and messages deliberately are not. A channel's message array is
// merged from three sources that disagree about order (a descending REST page,
// a realtime publication, an ascending `?after` backfill), paginates in both
// directions, and is keyed by `seq` rather than by a cache key. react-query's
// cache models none of that, and expressing it through `setQueryData` would put
// the fold — the one thing the seq gate re-implements and checks — inside a
// cache callback where no test can reach it. The web client made the same split
// for the same reason.
//
// ## What is NOT here, and why
//
// No reaction toggle, no edit, no delete, no thread replies. This batch is
// 읽기·받기·보내기; the action surface is the next one. But note the asymmetry
// that is deliberate rather than an oversight: a tombstone that ARRIVES is
// handled (`onMessageDeleted`), because receiving a delete someone else made is
// reading, not acting. A row that vanishes for the sender and stays for the
// reader would be the same message telling two stories.
//
// Reactions are read-only for the same reason: `chipsFor` renders what the
// server says, the rail keeps it current, and nothing here writes one.
// =============================================================================

const HEAD_LIMIT = 50;
const PAGE_LIMIT = 50;

export interface ResumeInfo {
  /** How the last (re)subscribe resolved. Null before the first one. */
  lastRecovered: boolean | null;
  /** Messages recovered by the last REST `?after` backfill after a gap. */
  lastBackfillCount: number;
  resubscribeCount: number;
}

export interface UseTimelineResult {
  state: TimelineState;
  status: 'loading' | 'ready' | 'error';
  resume: ResumeInfo;
  recoveryMarkers: RecoveryMarker[];
  /** Local echoes awaiting their server seq. Never inside `state`. */
  pending: PendingMessage[];
  /** The one send path: optimistic echo now, server seq when it lands. */
  send: (body: string) => Promise<void>;
  /** Re-run a failed echo with the SAME idempotency key. */
  resend: (clientMsgId: string) => Promise<void>;
  loadOlder: () => Promise<void>;
  reload: () => void;
  loadingOlder: boolean;
  reachedStart: boolean;
  /** `message id -> emoji -> member ids`, case-folded on ingest. Display only. */
  reactions: ReactionMap;
}

export function useTimeline(
  rail: ChannelRail | null,
  workspaceId: string,
  channelId: string | null,
  authorMemberId: string,
): UseTimelineResult {
  const [state, setState] = useState<TimelineState>(emptyTimeline);
  const [status, setStatus] = useState<UseTimelineResult['status']>('loading');
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
  const [reactions, setReactions] = useState<ReactionMap>(emptyReactions);
  const reactionsRef = useRef<ReactionMap>(reactions);

  // Authoritative newest-seq cursor, updated at MERGE time rather than at render
  // time, so a resubscribe firing between renders still reads truth. A send that
  // read it from `state` would stamp `sinceSeq` from a stale render and let an
  // older identical message settle the echo.
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
    setState(s => reconcileMessages(s, batch));
  }, []);

  const addMarker = useCallback((source: RecoveryMarker['source']) => {
    const seq = newestSeqRef.current;
    if (seq === null) return;
    markerCounterRef.current += 1;
    setRecoveryMarkers(markers => [
      ...markers,
      {id: `recovery-${markerCounterRef.current}`, seq, source},
    ]);
  }, []);

  // ---- optimistic send ------------------------------------------------------
  // Mirrored in a ref so a retry can read the row it is retrying without making
  // the callbacks depend on the list — a dependency there would rebuild the
  // composer's send handler on every keystroke, and this is the one file where
  // that matters most: the composer's `value` must stay synchronous (spike #837
  // gate 1), and a handler identity that churns per keystroke is the first step
  // toward someone "fixing" it with a queue.
  const pendingRef = useRef<PendingMessage[]>([]);
  const updatePending = useCallback(
    (fn: (list: PendingMessage[]) => PendingMessage[]) => {
      pendingRef.current = fn(pendingRef.current);
      setPending(pendingRef.current);
    },
    [],
  );

  // Which channel is on screen, read by in-flight sends that resolved after the
  // person moved on. Without it a POST for channel A merges into channel B.
  const channelRef = useRef<string | null>(null);

  const post = useCallback(
    async (row: PendingMessage) => {
      try {
        const confirmed = await sendMessage(
          workspaceId,
          row.channelId,
          row.clientMsgId,
          row.body,
        );
        // The response IS the committed server echo (seq-authoritative), so
        // merging it is not optimistic rendering: it is the same reconcile the
        // realtime frame gets, and whichever arrives second dedupes by seq.
        if (channelRef.current === row.channelId) applyBatch([confirmed]);
        updatePending(list => removePending(list, row.clientMsgId));
      } catch {
        // The row stays where it is and states 전송 실패 with a retry, in place.
        // No toast: a failure reported far from the message it belongs to makes
        // the person hunt for which message failed.
        updatePending(list => failPending(list, row.clientMsgId));
      }
    },
    [workspaceId, applyBatch, updatePending],
  );

  const send = useCallback(
    async (body: string) => {
      const channel = channelId;
      if (channel === null || body === '') return;
      const row: PendingMessage = {
        // `crypto.randomUUID()` — React Native has no `crypto` global at all, so
        // this call lands on the polyfill installed by `src/boot/polyfills.ts`
        // (RFC 4122 v4 over the platform CSPRNG). Without that import first,
        // every send would throw `ReferenceError` here.
        clientMsgId: crypto.randomUUID(),
        channelId: channel,
        authorMemberId,
        body,
        // Local clock, used only for grouping and the label on a row that has
        // not been ordered yet. Ordering still waits for seq.
        createdAtMs: Date.now(),
        sinceSeq: newestSeqRef.current,
        status: 'sending',
      };
      updatePending(list => addPending(list, row));
      await post(row);
    },
    [channelId, authorMemberId, post, updatePending],
  );

  const resend = useCallback(
    async (clientMsgId: string) => {
      const row = pendingRef.current.find(p => p.clientMsgId === clientMsgId);
      if (!row || row.status === 'sending') return;
      // The key is REUSED on purpose: a failed POST may still have committed
      // (a dropped response, a timeout), and the idempotency key is exactly what
      // turns that ambiguity into "the server returns the original message".
      updatePending(list => retryPending(list, clientMsgId));
      await post(row);
    },
    [post, updatePending],
  );

  const backfillAfter = useCallback(
    async (channel: string) => {
      let after = newestSeqRef.current ?? 0;
      let total = 0;
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
    [workspaceId, applyBatch],
  );

  useEffect(() => {
    channelRef.current = channelId;
  }, [channelId]);

  // Drop echoes whose confirmed twin has landed in the seq stream even though
  // the POST that created them never resolved. That case is real: if the write
  // committed but the response was lost, the realtime frame delivers the row and
  // the echo is settled by content, while the request may hang until its
  // deadline. The render fold already hides such a row; without this the entry
  // would sit in state for the rest of the session, reported as still sending.
  useEffect(() => {
    const open = unsettledPending(state.messages, pendingRef.current);
    if (open.length !== pendingRef.current.length) updatePending(() => open);
  }, [state.messages, updatePending]);

  useEffect(() => {
    if (!channelId || !rail) return;
    let cancelled = false;
    firstSubscribeRef.current = true;
    newestSeqRef.current = null;
    markerCounterRef.current = 0;
    updatePending(() => []);
    setState(emptyTimeline());
    setStatus('loading');
    setReachedStart(false);
    setRecoveryMarkers([]);
    setResume({lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0});
    reactionsRef.current = emptyReactions();
    setReactions(reactionsRef.current);

    // 1) REST head (descending page; the merge is order-agnostic).
    fetchMessages(workspaceId, channelId, {limit: HEAD_LIMIT})
      .then(page => {
        if (cancelled) return;
        applyBatch(page.messages);
        setReachedStart(page.nextBefore === undefined);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    // 1b) The channel's reaction map, in parallel and deliberately not fatal. A
    // channel whose messages loaded but whose chips did not is one you can still
    // read and still send in; failing the whole surface would trade it for an
    // annotation.
    fetchReactionSnapshot(workspaceId, channelId)
      .then(wire => {
        if (cancelled) return;
        // Merge rather than replace: a reaction that arrived on the rail while
        // this request was in flight would otherwise be erased by an older
        // snapshot.
        const cold = normalizeReactionSnapshot(wire);
        reactionsRef.current = {...cold, ...reactionsRef.current};
        setReactions(reactionsRef.current);
      })
      .catch(() => {
        /* chips stay empty; the channel is still fully usable */
      });

    // 2) The realtime rail, with resume healing.
    const unsub = rail.subscribeChannel(workspaceId, channelId, {
      onSubscribed: recovered => {
        if (cancelled) return;
        const isFirst = firstSubscribeRef.current;
        firstSubscribeRef.current = false;
        setResume(r => ({
          ...r,
          lastRecovered: recovered,
          resubscribeCount: r.resubscribeCount + (isFirst ? 0 : 1),
        }));
        if (!recovered) {
          // A non-recovered (re)subscribe may have missed publications: pull the
          // authoritative tail from Postgres. Safe on first subscribe too.
          backfillAfter(channelId)
            .then(count => {
              if (cancelled || isFirst) return;
              setResume(r => ({...r, lastBackfillCount: count}));
              addMarker('backfill');
            })
            .catch(() => {
              /* the rail is live again; the next resubscribe heals it */
            });
        } else if (!isFirst) {
          // The transport replayed the gap. centrifuge-js flushes recovered
          // publications synchronously right after `subscribed`, so the marker
          // is queued behind that flush to state how far the timeline was
          // restored rather than how far it had got before it.
          queueMicrotask(() => {
            if (!cancelled) addMarker('replay');
          });
        }
      },
      onMessage: (event: MessageNewEvent) => {
        if (cancelled) return;
        applyBatch([payloadToMessage(event.payload)]);
      },
      // A tombstone marks the row it names in place. It cannot go through
      // `applyBatch`: the frame carries only an id (by design, so a delete never
      // re-broadcasts the body it erased) and the row must keep its seq.
      onMessageDeleted: event => {
        if (cancelled) return;
        const messageId = event.payload.message_id;
        setState(s => applyTombstone(s, messageId, event.ts));
        reactionsRef.current = clearMessageReactions(
          reactionsRef.current,
          messageId,
        );
        setReactions(reactionsRef.current);
      },
      onReaction: event => {
        if (cancelled) return;
        reactionsRef.current = applyReactionDelta(reactionsRef.current, {
          messageId: event.payload.message_id,
          memberId: event.payload.member_id,
          emoji: event.payload.emoji,
          action: event.payload.action,
        });
        setReactions(reactionsRef.current);
      },
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [
    rail,
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
      setState(s => reconcileMessages(s, page.messages));
      if (page.nextBefore === undefined) setReachedStart(true);
    } catch {
      // Silent: the rows already on screen are still true, and the person can
      // pull again. Replacing a readable timeline with an error because its
      // NEXT page failed is the trade `status: "error"` is reserved for.
    } finally {
      setLoadingOlder(false);
    }
  }, [workspaceId, channelId, state.oldestSeq, loadingOlder, reachedStart]);

  const reload = useCallback(() => setReloadNonce(n => n + 1), []);

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
    reactions,
  };
}
