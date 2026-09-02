import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { buildTimelineItems } from "@momo/core/features/timeline/model";
import {
  composedUnreadCount,
  effectiveUnreadStartSeq,
  unreadDividerCursorSeq,
} from "@momo/core/features/readState/model";
import {
  MARK_ABOVE_CURSOR,
  MARK_AT_3_CURSOR_10,
  markAboveCursor,
  markAt3Cursor10,
} from "@momo/core/features/readState/proof";
import { countUnreadJump } from "./navigation";
import {
  sidebarUnreadCounts,
  unreadChannelsInOrder,
} from "../sidebar/sidebarUnread";

function msg(seq: number): Message {
  return {
    id: `0000000${seq}-0000-4000-8000-000000000000`,
    channelId: "c",
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: "a",
    type: "text",
    body: `m${seq}`,
    state: "sent",
    createdAtMs: seq * 1000,
  };
}

const STREAM = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(msg);

describe("마크 한 점이 배지·디바이더·필·⌥↑↓ 에 같다", () => {
  const read = markAt3Cursor10();
  const start = effectiveUnreadStartSeq(read);
  const count = composedUnreadCount(read);
  const cursor = unreadDividerCursorSeq(read);

  it("합성 단일점이 마크 3 을 시작으로 센다", () => {
    expect(start).toBe(MARK_AT_3_CURSOR_10.startSeq);
    expect(count).toBe(MARK_AT_3_CURSOR_10.count);
    expect(cursor).toBe(MARK_AT_3_CURSOR_10.dividerCursor);
  });

  it("UnreadDivider 는 seq 3 위에 선다", () => {
    const items = buildTimelineItems(STREAM.slice(0, 10), {
      lastReadSeq: cursor,
      unreadCount: count,
    });
    const divider = items.find((item) => item.kind === "unread");
    expect(divider).toMatchObject({
      kind: "unread",
      count: MARK_AT_3_CURSOR_10.count,
    });
    const index = items.findIndex((item) => item.kind === "unread");
    const next = items[index + 1];
    expect(next?.kind === "message" && next.message.seq).toBe(3);
  });

  it("UnreadPill N 은 구분선과 같은 수다", () => {
    expect(countUnreadJump(count)).toBe(MARK_AT_3_CURSOR_10.count);
  });

  it("사이드바 배지와 ⌥↑↓ 후보가 같은 수로 그 채널을 안 읽음으로 본다", () => {
    const counts = sidebarUnreadCounts(read.channelId, null, read);
    expect(counts.unreadCount).toBe(MARK_AT_3_CURSOR_10.count);
    const unreadChannels = unreadChannelsInOrder(
      [{ id: read.channelId }],
      null,
      () => read
    );
    expect(unreadChannels).toEqual([{ id: read.channelId }]);
    expect(
      sidebarUnreadCounts(read.channelId, read.channelId, read).unreadCount
    ).toBe(0);
    const sidebar = readFileSync(
      new URL("../sidebar/Sidebar.tsx", import.meta.url),
      "utf8"
    );
    expect(sidebar).toContain("sidebarUnreadCounts");
    expect(sidebar).toContain("unreadChannelsInOrder");
  });
});

describe("마크가 커서보다 위면 min 이 소비자에도 보인다", () => {
  it("구분선은 last_read+1 에 남고 배지는 서버 카운트와 같다", () => {
    const read = markAboveCursor();
    const cursor = unreadDividerCursorSeq(read);
    const count = composedUnreadCount(read);
    expect(cursor).toBe(MARK_ABOVE_CURSOR.dividerCursor);
    expect(count).toBe(MARK_ABOVE_CURSOR.count);
    const items = buildTimelineItems(STREAM, {
      lastReadSeq: cursor,
      unreadCount: count,
    });
    const index = items.findIndex((item) => item.kind === "unread");
    const next = items[index + 1];
    expect(next?.kind === "message" && next.message.seq).toBe(11);
  });
});

describe("마크 없는 경로 회귀", () => {
  it("기존 last_read 10 · unread 2 는 seq 11 위에 구분선을 둔다", () => {
    const items = buildTimelineItems(STREAM.slice(0, 12), {
      lastReadSeq: 10,
      unreadCount: 2,
    });
    const index = items.findIndex((item) => item.kind === "unread");
    const next = items[index + 1];
    expect(next?.kind === "message" && next.message.seq).toBe(11);
    expect(countUnreadJump(2)).toBe(2);
  });
});
