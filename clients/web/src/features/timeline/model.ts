import type { Message } from "@/lib/api";
import { uuidEq } from "@/lib/api";

// =============================================================================
// Timeline ordering model (pure). `seq` is the ONLY ordering authority, never
// arrival time, never createdAtMs. Both REST history (descending pages) and
// realtime publications (best-effort, possibly out of order or duplicated) are
// folded into one strictly-ascending-by-seq array, deduped by seq.
//
// This module is shared by the UI (Timeline.tsx) and the seq gate
// (gates/gate-seq.mjs re-implements the identical fold in JS and asserts the
// invariant), so the gate proves the same ordering the user sees.
//
// R-1 §3 adds the render-side derivation on top of that fold: author grouping,
// day separators, the unread boundary, and the reconnect recovery marker. All
// of it is pure and keyed by seq, so tests assert it without mounting a DOM.
// =============================================================================

export interface TimelineState {
  /** Strictly ascending by seq, deduped. Oldest first (render top→bottom). */
  messages: Message[];
  /** Smallest seq loaded, pass as `before` for older history. */
  oldestSeq: number | null;
  /** Largest seq loaded, pass as `after` for realtime-gap backfill. */
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
 *
 * Canonical name per R-1 §공통계약: history pages, realtime publications and
 * `?after` backfill all land here, so a reconnect reconciles by seq instead of
 * appending blindly.
 */
export function reconcileMessages(
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

/** Live-append alias of {@link reconcileMessages} (R-1 §공통계약 vocabulary). */
export const mergeMessages = reconcileMessages;

/** True iff messages are strictly ascending by seq with no duplicates. */
export function isStrictlyOrdered(messages: Message[]): boolean {
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].seq <= messages[i - 1].seq) return false;
  }
  return true;
}

// ---- render derivation (R-1 §3) --------------------------------------------

/** Author group window: a new header after 5 minutes of the same author. */
export const AUTHOR_GROUP_WINDOW_MS = 300_000;

/** The two fields grouping depends on; a pending row has them before it has a seq. */
export type GroupingRow = Pick<Message, "authorMemberId" | "createdAtMs">;

/** Local-day key, used for the day separator and to force a group break. */
export function dayKey(atMs: number): string {
  const d = new Date(atMs);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * A message starts a new author group when the author changes, when more than
 * AUTHOR_GROUP_WINDOW_MS passed since the previous message, or across a day
 * boundary. Continuation rows drop the header for density (Slack convention).
 */
export function startsAuthorGroup(
  previous: GroupingRow | undefined,
  current: GroupingRow
): boolean {
  if (!previous) return true;
  if (!uuidEq(previous.authorMemberId, current.authorMemberId)) return true;
  if (current.createdAtMs - previous.createdAtMs > AUTHOR_GROUP_WINDOW_MS) {
    return true;
  }
  return dayKey(previous.createdAtMs) !== dayKey(current.createdAtMs);
}

/**
 * A reconnect that healed a gap. `seq` is the newest seq confirmed present
 * after the heal, which is exactly what the marker states to the user: no
 * clock skew, no "since 5 seconds ago" guess (R-1 §3, momo 우위).
 */
export interface RecoveryMarker {
  /** Stable key, monotonic per session. */
  id: string;
  /** Newest seq confirmed present after the resubscribe healed the gap. */
  seq: number;
  /** Whether the transport replayed the gap, or REST `?after` backfill did. */
  source: "replay" | "backfill";
}

// ---- optimistic insert (M10, R-1 §3 "로컬 echo → seq 도착 시 reconcile") -----
//
// A message the user just sent has no seq yet: the server mints it inside the
// write transaction (REST -> PG -> outbox -> relay). Since seq is the ONLY
// ordering authority in this module, a local echo must never be given a fake
// one. Pending rows therefore live OUTSIDE the seq array, as a tail overlay
// appended after the confirmed stream, and the confirmed array keeps its
// strictly-ascending-by-seq invariant untouched (the seq gate re-implements
// that fold and would catch any violation).
//
// Settlement, i.e. how a pending row is replaced by its confirmed twin:
//   1. the POST response carries clientMsgId AND seq, so the sender always
//      learns the exact identity of its own message (the strong path);
//   2. but the realtime `message.new` frame does NOT carry client_msg_id
//      (MessageRoutes.broadcastPayload: id/seq/type/body/author/hlc/root only),
//      and it can beat the POST response back to this client. During that
//      window the confirmed row is already on screen while the pending row is
//      still waiting, which is exactly the duplicate this fold removes.
//
// So settlement is decided by the render fold, on content the realtime frame
// does carry: same author, same body, and a seq ABOVE the newest one that
// existed when the send started. That last clause is what keeps an older
// identical message ("네") from swallowing a fresh send. Each confirmed message
// settles at most one pending row, oldest first, so sending the same text twice
// still shows two rows and settles them one at a time.

export interface PendingMessage {
  /** Idempotency key (L4 §3.1). Stable across retries of the same attempt. */
  clientMsgId: string;
  channelId: string;
  authorMemberId: string;
  body: string;
  createdAtMs: number;
  /** newestSeq at the moment the send started; the echo must land above it. */
  sinceSeq: number | null;
  status: "sending" | "failed";
}

/** True when `message` is the server's echo of `pending`. */
export function confirmsPending(
  message: Message,
  pending: PendingMessage
): boolean {
  if (message.type !== "text") return false;
  if (message.state === "deleted") return false;
  if (pending.sinceSeq !== null && message.seq <= pending.sinceSeq) return false;
  if (!uuidEq(message.authorMemberId, pending.authorMemberId)) return false;
  return (message.body ?? "") === pending.body;
}

/**
 * The pending rows that are still unconfirmed against this message array, in
 * send order. One confirmed message settles at most one pending row.
 */
export function unsettledPending(
  messages: Message[],
  pending: PendingMessage[]
): PendingMessage[] {
  if (pending.length === 0) return pending;
  const open = pending.slice();
  for (const message of messages) {
    const index = open.findIndex((p) => confirmsPending(message, p));
    if (index >= 0) open.splice(index, 1);
    if (open.length === 0) break;
  }
  return open;
}

// ---- pending list transitions (pure, so the hook holds no logic) ------------

export function addPending(
  list: PendingMessage[],
  pending: PendingMessage
): PendingMessage[] {
  return [...list, pending];
}

export function removePending(
  list: PendingMessage[],
  clientMsgId: string
): PendingMessage[] {
  return list.filter((p) => p.clientMsgId !== clientMsgId);
}

/** The send attempt failed. The row stays put and offers a retry (R-1 §3). */
export function failPending(
  list: PendingMessage[],
  clientMsgId: string
): PendingMessage[] {
  return list.map((p) =>
    p.clientMsgId === clientMsgId ? { ...p, status: "failed" } : p
  );
}

/**
 * Retry a failed row. The clientMsgId is deliberately REUSED: a failed POST
 * may still have committed on the server (a dropped response, a timeout), and
 * the idempotency key is exactly what turns that ambiguity into a guarantee.
 * Re-sending with the same key returns the original message instead of writing
 * a second one, which is what makes the duplicate count zero here.
 */
export function retryPending(
  list: PendingMessage[],
  clientMsgId: string
): PendingMessage[] {
  return list.map((p) =>
    p.clientMsgId === clientMsgId ? { ...p, status: "sending" } : p
  );
}

export type TimelineItem =
  | { kind: "day"; key: string; atMs: number }
  | { kind: "unread"; key: string; count: number }
  | { kind: "recovery"; key: string; seq: number; source: "replay" | "backfill" }
  | { kind: "message"; key: string; message: Message; startsGroup: boolean }
  | { kind: "pending"; key: string; pending: PendingMessage; startsGroup: boolean };

export interface BuildItemsOptions {
  /** Server read cursor (P7). The divider sits above the first newer message. */
  lastReadSeq?: number | null;
  /** Server unread count for the channel; rendered on the divider. */
  unreadCount?: number;
  /** Reconnect markers, each anchored after the seq it recovered up to. */
  recoveryMarkers?: RecoveryMarker[];
  /** Local echoes of messages this client sent, still awaiting their seq. */
  pending?: PendingMessage[];
}

/**
 * Fold the ascending message array into the render stream: day separators, the
 * unread boundary, reconnect markers, and author-group flags.
 */
export function buildTimelineItems(
  messages: Message[],
  options: BuildItemsOptions = {}
): TimelineItem[] {
  const {
    lastReadSeq = null,
    unreadCount = 0,
    recoveryMarkers = [],
    pending = [],
  } = options;
  const items: TimelineItem[] = [];
  let previous: Message | undefined;
  let unreadPlaced = false;
  // A divider cuts the visual thread of an author group, so the row on the far
  // side of it must re-introduce its author. Without this the first row under
  // "새 메시지 3개" or "재연결됨" is anonymous whenever the same author happens
  // to continue across the line, which is exactly when the reader is least able
  // to infer who is speaking. Day dividers need no flag: a day boundary already
  // forces a group through startsAuthorGroup.
  let dividerAbove = false;

  // Markers anchor AFTER the newest loaded message at or below their seq, so
  // "seq N까지 복구" reads as a line drawn under everything it confirmed.
  const markersBySeq = new Map<number, RecoveryMarker[]>();
  for (const marker of recoveryMarkers) {
    let anchor: number | null = null;
    for (const message of messages) {
      if (message.seq <= marker.seq) anchor = message.seq;
      else break;
    }
    if (anchor === null) continue; // nothing loaded at or below it yet
    const list = markersBySeq.get(anchor);
    if (list) list.push(marker);
    else markersBySeq.set(anchor, [marker]);
  }

  for (const message of messages) {
    if (
      !previous ||
      dayKey(previous.createdAtMs) !== dayKey(message.createdAtMs)
    ) {
      items.push({
        kind: "day",
        key: `day-${dayKey(message.createdAtMs)}`,
        atMs: message.createdAtMs,
      });
    }
    if (
      !unreadPlaced &&
      lastReadSeq !== null &&
      unreadCount > 0 &&
      message.seq > lastReadSeq
    ) {
      items.push({
        kind: "unread",
        key: `unread-${lastReadSeq}`,
        count: unreadCount,
      });
      unreadPlaced = true;
      dividerAbove = true;
    }
    items.push({
      kind: "message",
      key: `m-${message.seq}`,
      message,
      startsGroup: dividerAbove || startsAuthorGroup(previous, message),
    });
    dividerAbove = false;
    for (const marker of markersBySeq.get(message.seq) ?? []) {
      items.push({
        kind: "recovery",
        key: `r-${marker.id}`,
        seq: marker.seq,
        source: marker.source,
      });
      dividerAbove = true;
    }
    previous = message;
  }

  // Pending rows close the stream: they are always the newest thing the user
  // did, and they carry no seq to be sorted by. A row whose confirmed twin is
  // already in `messages` is dropped here, which is where "중복 0" is enforced
  // regardless of whether the POST response or the realtime frame won the race.
  let previousRow: GroupingRow | undefined = previous;
  for (const row of unsettledPending(messages, pending)) {
    items.push({
      kind: "pending",
      key: `p-${row.clientMsgId}`,
      pending: row,
      startsGroup: dividerAbove || startsAuthorGroup(previousRow, row),
    });
    dividerAbove = false;
    previousRow = row;
  }
  return items;
}
