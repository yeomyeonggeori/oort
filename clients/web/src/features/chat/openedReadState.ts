import type { ReadState } from "@momo/core/lib/api";
import {
  composedUnreadCount,
  unreadDividerCursorSeq,
} from "@momo/core/features/readState/model";

// =============================================================================
// Visit-frozen unread (BT-6 #1934 R2 B-1).
//
// The open's own `explicit_open` PUT clears `marked_unread_before_seq` on the
// server. The divider and pill for THAT visit must keep the start computed
// from the row as it stood at open (mark included). Ignore only that open's
// own `null`. Any non-null live mark (this visit or another device) replaces
// the snapshot. Leaving the channel discards it so the next open is
// cursor-based.
// =============================================================================

export type VisitNullSource = "open_advertisement" | "user_clear";

export interface OpenedReadSnapshot {
  channelId: string;
  lastReadSeq: number | null;
  latestSeq: number;
  /** Open-time mark, or a mark set during this visit. Server `null` does not clear it. */
  markSeq: number | null;
  /** When true, a live `null` is treated as the open's own explicit_open. */
  absorbOpenNull: boolean;
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
      absorbOpenNull: true,
    };
  }
  return {
    channelId,
    lastReadSeq: read.lastReadSeq,
    latestSeq: read.latestSeq,
    markSeq: read.markedUnreadBeforeSeq,
    absorbOpenNull: true,
  };
}

/**
 * Ignore only the open's own `null` (`absorbOpenNull`). A user clear
 * (sidebar 「읽음 처리」) must drop the visit boundary.
 */
export function foldInVisitMark(
  opened: OpenedReadSnapshot,
  live: ReadState | null | undefined,
  source: VisitNullSource = "open_advertisement"
): OpenedReadSnapshot {
  if (!live || opened.lastReadSeq === null) return opened;
  const incoming = freezeOpenedRead(opened.channelId, live);
  if (typeof incoming.markSeq === "number") {
    return { ...opened, markSeq: incoming.markSeq, absorbOpenNull: true };
  }
  if (source === "user_clear" || !opened.absorbOpenNull) {
    return { ...opened, markSeq: null, absorbOpenNull: false };
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
