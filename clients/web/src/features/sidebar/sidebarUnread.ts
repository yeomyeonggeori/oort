import { uuidEq, type ReadState } from "@momo/core/lib/api";
import { composedUnreadCount } from "@momo/core/features/readState/model";

/**
 * Sidebar badge + ⌥↑↓ candidate counts (Sidebar.tsx unreadCountFor).
 * The open channel is treated as read; every other row goes through D3.
 */
export function sidebarUnreadCounts(
  channelId: string,
  openId: string | null,
  read: ReadState | null | undefined
): { unreadCount: number; mentionCount: number } {
  if (openId !== null && uuidEq(channelId, openId)) {
    return { unreadCount: 0, mentionCount: 0 };
  }
  return {
    unreadCount: read ? composedUnreadCount(read) : 0,
    mentionCount: read?.mentionCount ?? 0,
  };
}

/** Ordered unread-channel list the keyboard walks (Sidebar unreadChannels). */
export function unreadChannelsInOrder<T extends { id: string }>(
  ordered: readonly T[],
  openId: string | null,
  readFor: (channelId: string) => ReadState | null | undefined
): T[] {
  return ordered.filter(
    (channel) =>
      sidebarUnreadCounts(channel.id, openId, readFor(channel.id)).unreadCount >
      0
  );
}
