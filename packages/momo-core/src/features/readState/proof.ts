import type { ReadState } from "../../lib/api";

// =============================================================================
// Shared red-proof fixture (ADR-0178 D3 / #1934).
//
// One channel, one mark, one cursor. Badge, divider, pill, and ⌥↑↓ must all
// agree on this point. Do not fork a shorter fixture that hides a rule.
// =============================================================================

export const MARK_UNREAD_PROOF_CHANNEL_ID =
  "00000000-0000-7000-8000-000000000201";

/**
 * Mark at seq 3, cursor at 10, head at 10. Server `unread_count` stays 0
 * (the server does not fold the mark). Composition must treat 3..10 as unread.
 */
export function markAt3Cursor10(over: Partial<ReadState> = {}): ReadState {
  return {
    channelId: MARK_UNREAD_PROOF_CHANNEL_ID,
    lastReadSeq: 10,
    latestSeq: 10,
    unreadCount: 0,
    mentionCount: 0,
    markedUnreadBeforeSeq: 3,
    ...over,
  };
}

/** Inclusive start and derived count for {@link markAt3Cursor10}. */
export const MARK_AT_3_CURSOR_10 = {
  startSeq: 3,
  count: 8,
  dividerCursor: 2,
} as const;

/**
 * Mark *above* the cursor (mark 12, last_read 10, latest 15). D3 `min` keeps
 * the start at last_read+1 = 11. Sabotage: comment out `min` in
 * `effectiveUnreadStartSeq` and `markUnread.surfaces.test.ts`
 * 「마크가 커서보다 위면 시작점은 last_read+1」 goes red.
 */
export function markAboveCursor(over: Partial<ReadState> = {}): ReadState {
  return {
    channelId: MARK_UNREAD_PROOF_CHANNEL_ID,
    lastReadSeq: 10,
    latestSeq: 15,
    unreadCount: 5,
    mentionCount: 0,
    markedUnreadBeforeSeq: 12,
    ...over,
  };
}

export const MARK_ABOVE_CURSOR = {
  startSeq: 11,
  count: 5,
  dividerCursor: 10,
} as const;
