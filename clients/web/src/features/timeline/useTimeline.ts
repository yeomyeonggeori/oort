import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteMessage as deleteMessageRequest,
  editMessage as editMessageRequest,
  fetchChannelPins,
  fetchMessages,
  fetchReactionSnapshot,
  sendMessage,
  setPin,
  setReaction,
  type Message,
  type SendMessageOptions,
} from "@momo/core/lib/api";
import {
  payloadToMessage,
  pinnedPayloadToWire,
  type RealtimeHandle,
} from "@/lib/realtime";
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
} from "@momo/core/features/timeline/model";
import {
  applyReactionDelta,
  clearMessageReactions,
  emptyReactions,
  normalizeReactionSnapshot,
  toggleDirection,
  type ReactionMap,
} from "@momo/core/features/timeline/reactions";
import {
  applyPinned,
  emptyPins,
  isPinned,
  normalizePinList,
  removePin,
  type PinListStatus,
  type PinMap,
} from "@momo/core/features/timeline/pins";

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
   * `routing` is the composer's per-request override (ADR-0134 D1) and
   * `replyToId` is ADR-0148's quote binding; both ride the pending row so a
   * retry re-sends what the person actually chose rather than quietly falling
   * back to the inherited value or dropping the quote.
   */
  send: (body: string, options?: SendMessageOptions) => Promise<void>;
  /** Re-run a failed echo with the SAME idempotency key. */
  resend: (clientMsgId: string) => Promise<void>;
  loadOlder: () => Promise<void>;
  reload: () => void;
  loadingOlder: boolean;
  reachedStart: boolean;
  /** B11 — `message id -> emoji -> member ids`, case-folded on ingest. */
  reactions: ReactionMap;
  /**
   * Toggle my reaction on one message. Optimistic, and reverted on failure —
   * the caller surfaces the refusal as a sentence.
   */
  toggleReaction: (message: Message, emoji: string) => Promise<void>;
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
   * Pin or unpin one message. Optimistic only in the unpin direction — see the
   * implementation for why a pin waits for the server.
   */
  togglePin: (message: Message) => Promise<void>;
  /** Rewrite my own message. The server's row replaces the local one. */
  editMessage: (message: Message, body: string) => Promise<void>;
  /** Soft-delete my own message. The tombstone replaces the local row. */
  deleteMessage: (message: Message) => Promise<void>;
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
  // B11. Kept beside the messages rather than inside them: a reaction changes
  // far more often than the message it annotates, and folding it into the row
  // would make every 👍 replace a `Message` object the virtualiser then has to
  // re-render in full.
  const [reactions, setReactions] = useState<ReactionMap>(emptyReactions);
  // Read by the optimistic toggle, which must know the current direction
  // without depending on the state it is about to change (that dependency would
  // rebuild every row's click handler on every reaction in the channel).
  const reactionsRef = useRef<ReactionMap>(reactions);
  // 이슈 #1112. Same shape and the same reason as `reactions` above: a pin is an
  // annotation on a message, not a field of it.
  const [pins, setPins] = useState<PinMap>(emptyPins);
  const pinsRef = useRef<PinMap>(pins);
  const applyPins = useCallback((next: PinMap) => {
    pinsRef.current = next;
    setPins(next);
  }, []);
  // 이슈 #1146 M2. The map alone cannot tell "nobody pinned anything" from
  // "we never found out", and the header list was printing the first sentence
  // for both.
  const [pinsStatus, setPinsStatus] = useState<PinListStatus>("loading");
  // Which read owns the answer. A channel switch and a retry both bump it, so a
  // slow reply from the channel you just left cannot write over the one you are
  // in — the same hazard the `cancelled` flag guards in the effect, held in a
  // ref because the retry is called from outside that effect's closure.
  const pinReadRef = useRef(0);
  const loadPins = useCallback(
    (channel: string) => {
      const read = ++pinReadRef.current;
      setPinsStatus("loading");
      fetchChannelPins(workspaceId, channel)
        .then((wire) => {
          if (pinReadRef.current !== read) return;
          // Merge with the live map on the same side as the reaction snapshot:
          // a `message.pinned` that arrived while this was in flight wins, since
          // it is strictly newer than the read it raced.
          applyPins({ ...normalizePinList(wire), ...pinsRef.current });
          setPinsStatus("ready");
        })
        .catch(() => {
          if (pinReadRef.current !== read) return;
          // The channel stays fully usable — that judgement has not changed.
          // What changes is that the list now says so instead of claiming the
          // channel has no pins.
          setPinsStatus("failed");
        });
    },
    [workspaceId, applyPins]
  );
  const applyReaction = useCallback(
    (change: Parameters<typeof applyReactionDelta>[1]) => {
      reactionsRef.current = applyReactionDelta(reactionsRef.current, change);
      setReactions(reactionsRef.current);
    },
    []
  );

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
          {
            ...(row.routing ? { routing: row.routing } : {}),
            ...(row.replyToId === undefined
              ? {}
              : { replyToId: row.replyToId }),
          }
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
    async (body: string, options?: SendMessageOptions) => {
      const channel = channelId;
      if (channel === null || body === "") return;
      const row: PendingMessage = {
        clientMsgId: crypto.randomUUID(),
        channelId: channel,
        authorMemberId,
        body,
        ...(options?.routing ? { routing: options.routing } : {}),
        // ADR-0148 - the echo renders its own quote block from this, and a retry
        // must re-send the SAME request under the same idempotency key.
        ...(options?.replyToId === undefined
          ? {}
          : { replyToId: options.replyToId }),
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
    reactionsRef.current = emptyReactions();
    setReactions(reactionsRef.current);
    applyPins(emptyPins());

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

    // 1b) The channel's reaction map, in parallel and deliberately not fatal.
    // A channel whose messages loaded but whose chips did not is a channel you
    // can still read and still send in; turning that into the error state would
    // trade the whole surface for an annotation.
    fetchReactionSnapshot(workspaceId, channelId)
      .then((wire) => {
        if (cancelled) return;
        // Merge rather than replace: a reaction that arrived on the realtime
        // rail while this request was in flight would otherwise be erased by an
        // older snapshot.
        const cold = normalizeReactionSnapshot(wire);
        reactionsRef.current = { ...cold, ...reactionsRef.current };
        setReactions(reactionsRef.current);
      })
      .catch(() => {
        /* chips stay empty; the channel is still fully usable */
      });

    // 1c) The channel's pins, on the same terms as the snapshot above: in
    // parallel, and not fatal. A header list that failed to load is an absent
    // accessory; a channel that refuses to open because of one is a broken app.
    // 이슈 #1146 M2 — "absent" is now something the list can say out loud.
    loadPins(channelId);

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
      // B11 — a tombstone marks the row it names in place. It cannot go through
      // `applyBatch`: the frame carries only an id (by design, so a delete
      // never re-broadcasts the body it erased), and the row must keep its seq.
      onMessageDeleted: (event) => {
        if (cancelled) return;
        const messageId = event.payload.message_id;
        setState((s) => applyTombstone(s, messageId, event.ts));
        // The server deleted the rows with the message; drop the chips so they
        // do not report counts for a body nobody can read.
        reactionsRef.current = clearMessageReactions(
          reactionsRef.current,
          messageId
        );
        setReactions(reactionsRef.current);
        // …and its pin, which the server swept with the message. No
        // `message.unpinned` is published for a delete, so this is the only
        // place the header list learns about it.
        applyPins(removePin(pinsRef.current, messageId));
      },
      onReaction: (event) => {
        if (cancelled) return;
        // Idempotent both ways, which is what lets the echo of my own optimistic
        // click land harmlessly on top of it.
        applyReaction({
          messageId: event.payload.message_id,
          memberId: event.payload.member_id,
          emoji: event.payload.emoji,
          action: event.payload.action,
        });
      },
      // 이슈 #1112 — the header list stays live off these two frames alone. The
      // `message.pinned` payload IS the list entry, so nothing here re-reads
      // the list to find out what was pinned.
      onPin: (event) => {
        if (cancelled) return;
        if (event.type === "message.pinned") {
          applyPins(
            applyPinned(pinsRef.current, pinnedPayloadToWire(event.payload))
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
    realtime,
    workspaceId,
    channelId,
    backfillAfter,
    applyBatch,
    applyReaction,
    applyPins,
    loadPins,
    addMarker,
    updatePending,
    reloadNonce,
  ]);

  /**
   * Read the list again (이슈 #1146 M2).
   *
   * Deliberately *not* `reload()`. That one re-runs the whole channel — history,
   * rail, subscription — and the person pressing this button is answering one
   * sentence about one accessory. Rebuilding the conversation under them to
   * refill a header list is the kind of over-reaction that loses their scroll
   * position.
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
      setState((s) => reconcileMessages(s, page.messages));
      if (page.nextBefore === undefined) setReachedStart(true);
    } finally {
      setLoadingOlder(false);
    }
  }, [workspaceId, channelId, state.oldestSeq, loadingOlder, reachedStart]);

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  // ---- message actions (B11) ------------------------------------------------

  /**
   * Toggle my reaction, optimistically.
   *
   * The direction is *derived* from the current map rather than passed in, so
   * the local update and the request can never disagree about which way the
   * toggle was going — a mismatch there is how a chip ends up showing the
   * opposite of what the server stored.
   *
   * On failure the optimistic change is reverted with its own inverse, which is
   * safe because `applyReactionDelta` is idempotent: if the realtime echo of a
   * *successful* twin already landed, the revert is a no-op rather than a second
   * wrong write.
   */
  const toggleReaction = useCallback(
    async (message: Message, emoji: string) => {
      const action = toggleDirection(
        reactionsRef.current,
        message.id,
        authorMemberId,
        emoji
      );
      const change = {
        messageId: message.id,
        memberId: authorMemberId,
        emoji,
        action,
      };
      applyReaction(change);
      try {
        await setReaction(workspaceId, message.id, emoji, action);
      } catch (error) {
        applyReaction({
          ...change,
          action: action === "added" ? "removed" : "added",
        });
        throw error;
      }
    },
    [workspaceId, authorMemberId, applyReaction]
  );

  /**
   * Rewrite my own message. **Not optimistic**, unlike a reaction: the server
   * stamps `edited_at` and decides the resulting `state`, and showing the new
   * text before it is stored would leave the row claiming an edit that a 403
   * then took back. The round trip here is one request, and the editor says
   * "저장 중…" while it runs.
   */
  const editMessage = useCallback(
    async (message: Message, body: string) => {
      const updated = await editMessageRequest(workspaceId, message.id, body);
      applyBatch([updated]);
    },
    [workspaceId, applyBatch]
  );

  /** Soft-delete my own message; the returned tombstone replaces the row. */
  const deleteMessage = useCallback(
    async (message: Message) => {
      const tombstone = await deleteMessageRequest(workspaceId, message.id);
      applyBatch([tombstone]);
      reactionsRef.current = clearMessageReactions(
        reactionsRef.current,
        message.id
      );
      setReactions(reactionsRef.current);
      applyPins(removePin(pinsRef.current, message.id));
    },
    [workspaceId, applyBatch, applyPins]
  );

  /**
   * Pin or unpin one message (이슈 #1112).
   *
   * **Asymmetrically optimistic, and the asymmetry is the design.** An unpin is
   * applied immediately: the entry to remove is already in hand, so a revert is
   * exact. A pin is not, because the row a header list draws is the server's
   * projection — `pinnedAtMs` in particular is what the list sorts on, and a
   * locally invented one would put the entry in the wrong place until a reload,
   * which is a worse lie than a half-second wait. So the pin direction takes
   * the delta the server answers with, exactly as `editMessage` takes the row.
   *
   * Both directions are idempotent underneath, so the realtime echo of one's own
   * click lands harmlessly on top of whichever happened first.
   */
  const togglePin = useCallback(
    async (message: Message) => {
      if (isPinned(pinsRef.current, message.id)) {
        const previous = pinsRef.current;
        applyPins(removePin(previous, message.id));
        try {
          await setPin(workspaceId, message.id, "unpinned");
        } catch (error) {
          applyPins(previous);
          throw error;
        }
        return;
      }
      const delta = await setPin(workspaceId, message.id, "pinned");
      if (delta.pinned) applyPins(applyPinned(pinsRef.current, delta.pinned));
    },
    [workspaceId, applyPins]
  );

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
    toggleReaction,
    pins,
    pinsStatus,
    reloadPins,
    togglePin,
    editMessage,
    deleteMessage,
  };
}
