import type { ReadState } from "@momo/core/lib/api";
import {
  composedUnreadCount,
  effectiveUnreadStartSeq,
  unreadDividerCursorSeq,
} from "@momo/core/features/readState/model";

// =============================================================================
// Visit-frozen unread (BT-6 #1934 R2 B-1).
//
// The open's own `explicit_open` PUT clears `marked_unread_before_seq` on the
// server. The divider and pill for THAT visit must keep the start computed
// from the row as it stood at open (mark included). A mark set during the
// visit may pull the start earlier. Leaving the channel discards the snapshot
// so the next open is cursor-based.
// =============================================================================

export interface OpenedReadSnapshot {
  channelId: string;
  lastReadSeq: number | null;
  latestSeq: number;
  /** Open-time mark, or a mark set during this visit. Server `null` does not clear it. */
  markSeq: number | null;
}

export function freezeOpenedRead(
  channelId: string,
  read: ReadState | null | undefined
): OpenedReadSnapshot {
  if (!read) {
    return {
      channelId,
      lastReadSeq: null,
      latestSeq: 0,
      markSeq: null,
    };
  }
  return {
    channelId,
    lastReadSeq: read.lastReadSeq,
    latestSeq: read.latestSeq,
    markSeq: read.markedUnreadBeforeSeq,
  };
}

/**
 * A mark applied while the channel is open may pull the start earlier.
 * A live `null` (explicit_open GET) must not raise it.
 */
export function foldInVisitMark(
  opened: OpenedReadSnapshot,
  live: ReadState | null | undefined
): OpenedReadSnapshot {
  if (!live || opened.lastReadSeq === null) return opened;
  const incoming = freezeOpenedRead(opened.channelId, live);
  if (typeof incoming.markSeq !== "number") return opened;
  const liveStart = effectiveUnreadStartSeq({
    lastReadSeq: opened.lastReadSeq,
    markedUnreadBeforeSeq: incoming.markSeq,
  });
  const currentStart = effectiveUnreadStartSeq({
    lastReadSeq: opened.lastReadSeq,
    markedUnreadBeforeSeq: opened.markSeq,
  });
  if (liveStart < currentStart) {
    return { ...opened, markSeq: incoming.markSeq };
  }
  return opened;
}

export function timelineUnreadFromOpened(opened: OpenedReadSnapshot): {
  lastReadSeq: number | null;
  unreadCount: number;
} {
  if (opened.lastReadSeq === null) {
    return { lastReadSeq: null, unreadCount: 0 };
  }
  const input = {
    lastReadSeq: opened.lastReadSeq,
    latestSeq: opened.latestSeq,
    markedUnreadBeforeSeq: opened.markSeq,
  };
  return {
    lastReadSeq: unreadDividerCursorSeq(input),
    unreadCount: composedUnreadCount(input),
  };
}
