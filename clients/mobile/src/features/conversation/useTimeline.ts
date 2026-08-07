import {
  deleteMessage as deleteMessageRequest,
  editMessage as editMessageRequest,
  fetchChannelPins,
  fetchMessages,
  fetchReactionSnapshot,
  fetchThreadReplies,
  sendMessage,
  sendThreadReply,
  setPin,
  setReaction,
  type Message,
} from '@momo/core/lib/api';
import {
  payloadToMessage,
  pinnedPayloadToWire,
  type MessageNewEvent,
} from '@momo/core/lib/realtimeEvents';
import {
  applyPinned,
  emptyPins,
  isPinned,
  normalizePinList,
  removePin,
  type PinListStatus,
  type PinMap,
} from '@momo/core/features/timeline/pins';
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
  toggleDirection,
  type ReactionChange,
  type ReactionMap,
} from '@momo/core/features/timeline/reactions';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
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
// ## The write side (goal RN-C5), and the one asymmetry inside it
//
// RN-C4 left this file read-only on purpose and said so here. The actions are
// now wired, and they keep the split the web client measured its way to:
//
//   반응    **낙관적**. The direction is DERIVED from the map rather than passed
//           in (`toggleDirection`), so the local update and the request cannot
//           disagree about which way the toggle was going. On failure the change
//           is undone with its own inverse — safe because `applyReactionDelta`
//           is idempotent, so if the realtime echo of a SUCCESSFUL twin already
//           landed, the revert is a no-op rather than a second wrong write.
//
//   고치기·지우기  **낙관적이 아니다.** The server stamps `edited_at` and decides
//           the resulting `state`; showing the new text first would leave the row
//           claiming an edit that a 403 then took back. One request, and the
//           editor says 저장 중… while it runs.
//
// Every one of these THROWS on failure rather than swallowing. The sentence a
// person reads is chosen at the row (`actionCopy`), because that is where the
// failure belongs — B8's rule that the server's wire sentence never reaches the
// screen, and B11's that the reason sits on the row rather than in a toast.
//
// The read-side asymmetry RN-C4 noted still holds and is still deliberate: a
// tombstone that ARRIVES is handled (`onMessageDeleted`), because receiving a
// delete someone else made is reading, not acting.
//
// ## Replies are channel messages, and that is why there is no second hook
//
// A reply is a message in this channel with `rootId` set — the same write path
// (`sendThreadReply` posts to the same endpoint), the same `seq`, and the server
// does NOT filter replies out of channel history (`list_channel_page` has no
// `root_id IS NULL` predicate). So a thread is a VIEW over this state, not a
// second store: `loadReplies` merges through the same `applyBatch`, the rail
// delivers replies to the same `onMessage`, and the thread surface filters by
// `rootId`. A separate hook would have meant a second copy of the seq fold, the
// settle rule and the reaction map — three things that must not be able to
// disagree with what the channel is showing one screen away.
//
// Echoes carry their root in a side map (`pendingRootRef`) rather than in
// `PendingMessage`, so the core's pending model is untouched and one settle
// effect still covers both surfaces.
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
  /** Channel-level echoes awaiting their server seq. Never inside `state`. */
  pending: PendingMessage[];
  /**
   * The one send path: optimistic echo now, server seq when it lands.
   *
   * `replyToId` is ADR-0148 인용 — a column on the same write, never a second
   * path. It rides the pending row (core `PendingMessage.replyToId`) rather than
   * a side map like `pendingRootRef`, because the echo has to draw its own quote
   * block: without it the optimistic row shows no quote and then grows one the
   * instant its seq lands, moving the text under the reader's eye.
   */
  send: (body: string, replyToId?: string) => Promise<void>;
  /** Re-run a failed echo with the SAME idempotency key. */
  resend: (clientMsgId: string) => Promise<void>;
  /**
   * Toggle my reaction, optimistically. **Throws** on failure, after having put
   * the chip back where it was — the caller turns the error into the sentence.
   */
  toggleReaction: (message: Message, emoji: string) => Promise<void>;
  /** Rewrite my own message. Not optimistic; throws on failure. */
  editBody: (message: Message, body: string) => Promise<void>;
  /** Soft-delete my own message; the returned tombstone replaces the row. */
  removeMessage: (message: Message) => Promise<void>;
  /** One page of a root's replies, merged into the same seq-ordered state. */
  loadReplies: (rootId: string) => Promise<void>;
  /** Reply into a thread. Same echo machinery as `send`, tagged with its root. */
  sendReply: (rootId: string, body: string) => Promise<void>;
  /** The echoes belonging to one thread (never shown in the channel list). */
  repliesPending: (rootId: string) => PendingMessage[];
  loadOlder: () => Promise<void>;
  reload: () => void;
  loadingOlder: boolean;
  reachedStart: boolean;
  /** `message id -> emoji -> member ids`, case-folded on ingest. Display only. */
  reactions: ReactionMap;
  /** 이슈 #1112 — `message id -> the pin`, case-folded on ingest. */
  pins: PinMap;
  /**
   * 이슈 #1146 M2 — where the cold read of `pins` stands. An empty map means
   * two different things and only this says which.
   */
  pinsStatus: PinListStatus;
  /** Read the channel's pins again. The retry behind the failure sentence. */
  reloadPins: () => void;
  /**
   * Pin or unpin one message. **Throws** on failure, after having put the list
   * back where it was — the caller turns the error into the sentence.
   */
  togglePin: (message: Message) => Promise<void>;
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
  // 이슈 #1112. Same shape and the same reason as `reactions`: a pin annotates a
  // message rather than being a field of it.
  const [pins, setPins] = useState<PinMap>(emptyPins);
  const pinsRef = useRef<PinMap>(pins);
  // 이슈 #1146 M2. The map alone cannot tell 「nobody pinned anything」 from
  // 「we never found out」, and the list was printing the first sentence for both.
  const [pinsStatus, setPinsStatus] = useState<PinListStatus>('loading');
  /** Which read owns the answer. See `loadPins`. */
  const pinReadRef = useRef(0);

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

  // Which echoes are thread replies: `clientMsgId -> rootId`. A side map rather
  // than a field on `PendingMessage`, so the core's pending model stays as it
  // is and both surfaces keep sharing one array and one settle effect.
  const pendingRootRef = useRef<Record<string, string>>({});

  const post = useCallback(
    async (row: PendingMessage) => {
      try {
        const rootId = pendingRootRef.current[row.clientMsgId];
        const confirmed = await (rootId === undefined
          ? sendMessage(workspaceId, row.channelId, row.clientMsgId, row.body, {
              ...(row.replyToId === undefined
                ? {}
                : {replyToId: row.replyToId}),
            })
          : sendThreadReply(
              workspaceId,
              row.channelId,
              rootId,
              row.clientMsgId,
              row.body,
            ));
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
    async (body: string, replyToId?: string) => {
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
        ...(replyToId === undefined ? {} : {replyToId}),
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

  // ---- message actions (goal RN-C5) -----------------------------------------

  const applyReaction = useCallback((change: ReactionChange) => {
    reactionsRef.current = applyReactionDelta(reactionsRef.current, change);
    setReactions(reactionsRef.current);
  }, []);

  const applyPins = useCallback((next: PinMap) => {
    pinsRef.current = next;
    setPins(next);
  }, []);

  /**
   * Read the channel's pins (이슈 #1146 M2).
   *
   * The read is here rather than inline in the channel effect because the
   * failure now has a retry behind it, and that retry is pressed from outside
   * that effect's closure. `pinReadRef` is what the effect's `cancelled` flag
   * was doing for it: a slow reply from the channel you just left, or from the
   * read a retry superseded, must not write over the one you are in.
   */
  const loadPins = useCallback(
    (channel: string) => {
      const read = ++pinReadRef.current;
      setPinsStatus('loading');
      fetchChannelPins(workspaceId, channel)
        .then(wire => {
          if (pinReadRef.current !== read) return;
          // Merge on the same side as the reaction snapshot: a `message.pinned`
          // that arrived while this was in flight is strictly newer than the
          // read it raced, so it wins.
          applyPins({...normalizePinList(wire), ...pinsRef.current});
          setPinsStatus('ready');
        })
        .catch(() => {
          if (pinReadRef.current !== read) return;
          // The channel stays fully usable — that judgement has not changed.
          // What changes is that the list now says so instead of claiming the
          // channel has no pins.
          setPinsStatus('failed');
        });
    },
    [workspaceId, applyPins],
  );

  /**
   * Pin or unpin one message (이슈 #1112).
   *
   * **Asymmetrically optimistic, and the asymmetry is the design.** An unpin is
   * applied at once — the entry to remove is already in hand, so the revert is
   * exact. A pin is not: the row the list draws is the server's projection, and
   * `pinnedAtMs` in particular is what the list sorts on, so a locally invented
   * one would seat the entry in the wrong place until a reload. That is a worse
   * lie than a half-second wait, and it is why this direction takes the delta
   * the server answers with, exactly as `editBody` takes the row.
   */
  const togglePin = useCallback(
    async (message: Message) => {
      if (isPinned(pinsRef.current, message.id)) {
        const previous = pinsRef.current;
        applyPins(removePin(previous, message.id));
        try {
          await setPin(workspaceId, message.id, 'unpinned');
        } catch (error) {
          applyPins(previous);
          throw error;
        }
        return;
      }
      const delta = await setPin(workspaceId, message.id, 'pinned');
      if (delta.pinned) applyPins(applyPinned(pinsRef.current, delta.pinned));
    },
    [workspaceId, applyPins],
  );

  const toggleReaction = useCallback(
    async (message: Message, emoji: string) => {
      // Derived, never remembered: the optimistic write and the request read the
      // same map at the same instant, so they cannot disagree about direction.
      const action = toggleDirection(
        reactionsRef.current,
        message.id,
        authorMemberId,
        emoji,
      );
      const change: ReactionChange = {
        messageId: message.id,
        memberId: authorMemberId,
        emoji,
        action,
      };
      applyReaction(change);
      try {
        await setReaction(workspaceId, message.id, emoji, action);
      } catch (error) {
        // Put it back, and say so on the row. The inverse is safe even if the
        // realtime echo of a successful twin already landed: the delta is
        // idempotent, so an unnecessary revert is a no-op rather than a second
        // wrong write.
        applyReaction({
          ...change,
          action: action === 'added' ? 'removed' : 'added',
        });
        throw error;
      }
    },
    [workspaceId, authorMemberId, applyReaction],
  );

  const editBody = useCallback(
    async (message: Message, body: string) => {
      const updated = await editMessageRequest(workspaceId, message.id, body);
      applyBatch([updated]);
    },
    [workspaceId, applyBatch],
  );

  const removeMessage = useCallback(
    async (message: Message) => {
      const tombstone = await deleteMessageRequest(workspaceId, message.id);
      applyBatch([tombstone]);
      // The server deletes the reaction rows with the message, so chips for a
      // tombstone would be counts for rows that no longer exist.
      reactionsRef.current = clearMessageReactions(
        reactionsRef.current,
        message.id,
      );
      setReactions(reactionsRef.current);
      applyPins(removePin(pinsRef.current, message.id));
    },
    [workspaceId, applyBatch, applyPins],
  );

  const loadReplies = useCallback(
    async (rootId: string) => {
      const channel = channelRef.current;
      if (channel === null) return;
      let cursor: number | undefined;
      // Ascending pages until the server stops offering one. Replies are ordinary
      // channel messages, so every page lands in the same seq-ordered state the
      // channel is drawn from — loading a thread also heals the channel.
      for (;;) {
        const page = await fetchThreadReplies(
          workspaceId,
          channel,
          rootId,
          cursor,
        );
        applyBatch(page.messages);
        if (page.nextCursor === undefined) break;
        cursor = page.nextCursor;
      }
    },
    [workspaceId, applyBatch],
  );

  const sendReply = useCallback(
    async (rootId: string, body: string) => {
      const channel = channelId;
      if (channel === null || body === '') return;
      const clientMsgId = crypto.randomUUID();
      pendingRootRef.current = {...pendingRootRef.current, [clientMsgId]: rootId};
      const row: PendingMessage = {
        clientMsgId,
        channelId: channel,
        authorMemberId,
        body,
        createdAtMs: Date.now(),
        sinceSeq: newestSeqRef.current,
        status: 'sending',
      };
      updatePending(list => addPending(list, row));
      await post(row);
    },
    [channelId, authorMemberId, post, updatePending],
  );

  const repliesPending = useCallback(
    (rootId: string) =>
      pending.filter(row => pendingRootRef.current[row.clientMsgId] === rootId),
    [pending],
  );

  // The channel list must not show a reply's echo: the reply belongs to the
  // thread that is open over it, and a row appearing in both places is the same
  // message told twice.
  const channelPending = useMemo(
    () => pending.filter(row => pendingRootRef.current[row.clientMsgId] === undefined),
    [pending],
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
    pendingRootRef.current = {};
    updatePending(() => []);
    setState(emptyTimeline());
    setStatus('loading');
    setReachedStart(false);
    setRecoveryMarkers([]);
    setResume({lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0});
    reactionsRef.current = emptyReactions();
    setReactions(reactionsRef.current);
    applyPins(emptyPins());

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

    // 1c) The channel's pins, on the same terms: in parallel, and not fatal. A
    // pin list that failed to load is an absent accessory; a channel that
    // refuses to open because of one is a broken app.
    // 이슈 #1146 M2 — 「absent」 is now something the list can say out loud.
    loadPins(channelId);

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
        // …and its pin, which the server swept with the message. No
        // `message.unpinned` is published for a delete, so this is the only
        // place the pin list learns about it.
        applyPins(removePin(pinsRef.current, messageId));
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
      // 이슈 #1112 — the pin list stays live off these two frames alone. The
      // `message.pinned` payload IS the list entry, so nothing here re-reads
      // the list to find out what was pinned.
      onPin: event => {
        if (cancelled) return;
        if (event.type === 'message.pinned') {
          applyPins(
            applyPinned(pinsRef.current, pinnedPayloadToWire(event.payload)),
          );
        } else {
          applyPins(removePin(pinsRef.current, event.payload.message_id));
        }
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
    applyPins,
    loadPins,
    addMarker,
    updatePending,
    reloadNonce,
  ]);

  /**
   * Read the list again (이슈 #1146 M2).
   *
   * Deliberately **not** `reload()`. That one re-runs the whole channel —
   * history, rail, subscription — and the person pressing this button is
   * answering one sentence about one accessory. Rebuilding the conversation
   * under them to refill a list would throw away their scroll position, which
   * on a phone is the thing hardest to get back.
   */
  const reloadPins = useCallback(() => {
    if (channelId) loadPins(channelId);
  }, [channelId, loadPins]);

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
    pending: channelPending,
    send,
    resend,
    toggleReaction,
    editBody,
    removeMessage,
    loadReplies,
    sendReply,
    repliesPending,
    loadOlder,
    reload,
    loadingOlder,
    reachedStart,
    reactions,
    pins,
    pinsStatus,
    reloadPins,
    togglePin,
  };
}
