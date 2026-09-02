// =============================================================================
// ADR-0178 D3 — unread composition, the single point.
//
// Effective unread start = mark ? min(marked_unread_before_seq, last_read_seq+1)
//                         : last_read_seq+1
//
// Every consumer (sidebar badge, UnreadDivider, UnreadPill, ⌥↑/⌥↓, anything
// else that derives "unread") goes through these functions. Arithmetic or
// comparison on `markedUnreadBeforeSeq` anywhere else is a ticket failure
// (`compositionGate.test.ts`).
// =============================================================================

export interface UnreadCompositionInput {
  lastReadSeq: number;
  markedUnreadBeforeSeq: number | null | undefined;
}

export interface UnreadCountInput extends UnreadCompositionInput {
  latestSeq: number;
}

/**
 * Inclusive seq where unread begins. `null`/`undefined` mark means unmarked.
 *
 * RED (#1934): the `min` is not here yet. GREEN restores ADR-0178 D3.
 */
export function effectiveUnreadStartSeq(
  readState: UnreadCompositionInput
): number {
  return readState.lastReadSeq + 1;
}

/**
 * How many messages are unread under D3. Always derived from
 * {@link effectiveUnreadStartSeq} — never from `unread_count` on the wire
 * (the server does not fold the mark, ADR-0178 / PR #1961).
 */
export function composedUnreadCount(readState: UnreadCountInput): number {
  const start = effectiveUnreadStartSeq(readState);
  return Math.max(0, readState.latestSeq - start + 1);
}

/**
 * Cursor to hand `buildTimelineItems` (`message.seq > lastReadSeq`). Equal to
 * `effectiveUnreadStartSeq - 1`, so the divider sits above the first unread
 * message without the timeline model knowing the mark exists.
 */
export function unreadDividerCursorSeq(
  readState: UnreadCompositionInput
): number {
  return effectiveUnreadStartSeq(readState) - 1;
}
