import type { PinnedMessageWire } from "../../lib/api";

// =============================================================================
// Pin state (pure). 이슈 #1112.
//
// The reaction module's shape, with **one axis removed and one added**.
//
// Removed: the member. A reaction is `(message, member, emoji)`; a pin is
// `(message)` alone, because a pin is the channel's fact rather than the
// pinner's. Two people pinning the same message produce one header row, and
// anyone in the channel may unpin — including someone who did not pin it.
// So this map is keyed by message id and holds one entry, not a list.
//
// Added: the entry carries the **message**, not just the fact that it is
// pinned. A pin's whole point is a message that is not on screen, so a store of
// ids alone would force a lookup into a timeline window that, by definition,
// usually misses.
//
// Ids are keyed lowercase, folded at the single ingest point — the same rule
// `reactions.ts` documents at length, kept here for the same reason: the wire's
// UUID casing is mixed by design (`docs/api/openapi.yaml:29-31`) and a map keyed
// by the raw string cannot find a message under its own id. The pin wire is
// lowercase today, so `fold` is currently the identity function on it; that is
// exactly why it must stay — the fold is what makes the casing stop mattering.
//
// Ordering is **not** insertion order here, unlike reactions: entries sort by
// `pinnedAtMs` descending, newest pin first, and ties break on message id so the
// order is total. A header list is read top-down and the thing someone just
// pinned is the thing being talked about; leaving the order to arrival would
// mean a cold load and a live update disagreed about the same channel.
// =============================================================================

/** One pinned message, as the header list draws it. Ids are lowercase. */
export interface PinnedMessage {
  messageId: string;
  channelId: string;
  /** The message's own seq — what a jump scrolls to. Pinning mints none. */
  seq: number;
  authorMemberId: string;
  type: string;
  state: string;
  body: string | null;
  createdAtMs: number;
  /** Where the pin came from. Not permission — anyone in the channel may unpin. */
  pinnedBy: string;
  pinnedAtMs: number;
}

/** `message id (lowercase) -> the pin`. */
export type PinMap = Record<string, PinnedMessage>;

export function emptyPins(): PinMap {
  return {};
}

function fold(id: string): string {
  return id.toLowerCase();
}

function foldEntry(wire: PinnedMessageWire): PinnedMessage {
  return {
    messageId: fold(wire.messageId),
    channelId: fold(wire.channelId),
    seq: wire.seq,
    authorMemberId: fold(wire.authorMemberId),
    type: wire.type,
    state: wire.state,
    body: wire.body ?? null,
    createdAtMs: wire.createdAtMs,
    pinnedBy: fold(wire.pinnedBy),
    pinnedAtMs: wire.pinnedAtMs,
  };
}

function isPinWire(value: unknown): value is PinnedMessageWire {
  if (!value || typeof value !== "object") return false;
  const wire = value as Record<string, unknown>;
  return (
    typeof wire.messageId === "string" &&
    typeof wire.channelId === "string" &&
    typeof wire.seq === "number" &&
    typeof wire.authorMemberId === "string" &&
    typeof wire.pinnedBy === "string" &&
    typeof wire.pinnedAtMs === "number"
  );
}

/**
 * The cold-load list, case-folded and keyed.
 *
 * Malformed entries are dropped rather than thrown on: a header list is an
 * accessory to the channel, and one bad row must not be able to take the
 * conversation down with it.
 */
export function normalizePinList(
  wire: readonly PinnedMessageWire[] | undefined | null
): PinMap {
  const map: PinMap = {};
  if (!Array.isArray(wire)) return map;
  for (const entry of wire) {
    if (!isPinWire(entry)) continue;
    const folded = foldEntry(entry);
    map[folded.messageId] = folded;
  }
  return map;
}

/**
 * Add one pin, returning a new map — or **the same reference** when the message
 * is already pinned, which lets React skip the render for the echo of one's own
 * click.
 *
 * Identity is the message id alone. A second `message.pinned` for a message
 * already in the map is a no-op even if `pinnedBy` differs, because the server
 * is unique on the message: the second pin never happened.
 */
export function applyPinned(map: PinMap, wire: PinnedMessageWire): PinMap {
  if (!isPinWire(wire)) return map;
  const entry = foldEntry(wire);
  if (map[entry.messageId]) return map;
  return { ...map, [entry.messageId]: entry };
}

/**
 * Remove one pin. Same reference when it was not there — the idempotent half of
 * the server's own contract, so the optimistic update and the realtime echo of
 * one click can both be applied.
 */
export function removePin(map: PinMap, messageId: string): PinMap {
  const key = fold(messageId);
  if (!map[key]) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** Whether this message is pinned, for the row's action label. */
export function isPinned(map: PinMap, messageId: string): boolean {
  return map[fold(messageId)] !== undefined;
}

/**
 * The list, newest pin first. Ties break on message id so two clients that
 * received the same two pins in the same millisecond still draw the same order.
 */
export function pinList(map: PinMap): PinnedMessage[] {
  return Object.values(map).sort((a, b) => {
    if (b.pinnedAtMs !== a.pinnedAtMs) return b.pinnedAtMs - a.pinnedAtMs;
    return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
  });
}

/**
 * The cap the server enforces (migration `061_message_pin.sql`, and
 * `momo_messaging::CHANNEL_PIN_LIMIT`).
 *
 * Mirrored here only so the copy that explains a refusal can name the number.
 * The client does **not** pre-check it — a client-side count would be a second
 * authority that goes stale the moment someone else pins.
 */
export const CHANNEL_PIN_LIMIT = 100;

/**
 * The action label, which flips with the state.
 *
 * Here rather than in a component because web and phone must say the same
 * words, and because it is drawn in three places (the web menu, the web sheet,
 * the phone sheet) — a label duplicated three times is a label that drifts.
 * Verb phrases, which the phone's a11y test enforces mechanically.
 */
export function pinActionLabel(pinned: boolean): string {
  return pinned ? "고정 해제하기" : "고정하기";
}

/** The header entry point's label, with the count folded in. */
export function pinListLabel(count: number): string {
  return count > 0 ? `고정 ${count}개` : "고정한 메시지";
}

/**
 * What a pin list says when it is empty, in two halves — the fact and what to
 * do about it.
 *
 * Split rather than one sentence because the two surfaces mount it differently:
 * the phone's `EmptyState` takes a headline and a detail as separate props, and
 * a single string handed to both printed the fact twice (measured on the
 * simulator). The web menu joins them with a space. Same shape as the ADE
 * drawer's `ADE_DRAWER_EMPTY_HEADLINE` / `_DETAIL`.
 *
 * The detail names the *action*, not the gesture: web opens the menu with `⋯`
 * and phone with a long press, so a sentence naming either would be wrong on
 * the other surface.
 */
export const PIN_LIST_EMPTY_HEADLINE = "고정한 메시지가 없습니다.";
export const PIN_LIST_EMPTY_DETAIL = "메시지 액션에서 고정하면 여기 모입니다.";

/** The body a pinned entry draws when the message has no text. */
export const PIN_EMPTY_BODY_TEXT = "내용 없는 메시지";
