import { describe, expect, it } from "vitest";
import {
  composedUnreadCount,
  effectiveUnreadStartSeq,
  unreadDividerCursorSeq,
} from "./model";
import {
  MARK_ABOVE_CURSOR,
  MARK_AT_3_CURSOR_10,
  markAboveCursor,
  markAt3Cursor10,
} from "./proof";

describe("effectiveUnreadStartSeq (ADR-0178 D3)", () => {
  it("마크가 없으면 last_read_seq+1 이다", () => {
    expect(
      effectiveUnreadStartSeq({ lastReadSeq: 10, markedUnreadBeforeSeq: null })
    ).toBe(11);
    expect(
      effectiveUnreadStartSeq({
        lastReadSeq: 10,
        markedUnreadBeforeSeq: undefined,
      })
    ).toBe(11);
    expect(
      effectiveUnreadStartSeq({ lastReadSeq: 0, markedUnreadBeforeSeq: null })
    ).toBe(1);
  });

  it("마크가 커서보다 아래면 마크가 시작점이다", () => {
    expect(
      effectiveUnreadStartSeq({ lastReadSeq: 10, markedUnreadBeforeSeq: 3 })
    ).toBe(3);
    expect(effectiveUnreadStartSeq(markAt3Cursor10())).toBe(
      MARK_AT_3_CURSOR_10.startSeq
    );
  });

  it("마크가 커서보다 위면 시작점은 last_read+1 이다 (min)", () => {
    expect(
      effectiveUnreadStartSeq({ lastReadSeq: 10, markedUnreadBeforeSeq: 12 })
    ).toBe(11);
    expect(effectiveUnreadStartSeq(markAboveCursor())).toBe(
      MARK_ABOVE_CURSOR.startSeq
    );
  });

  it("마크가 커서+1 과 같으면 그 값이 시작점이다", () => {
    expect(
      effectiveUnreadStartSeq({ lastReadSeq: 10, markedUnreadBeforeSeq: 11 })
    ).toBe(11);
  });
});

describe("composedUnreadCount", () => {
  it("마크 없는 경로는 서버 unread_count 와 같다 (latest - last_read)", () => {
    expect(
      composedUnreadCount({
        lastReadSeq: 10,
        latestSeq: 15,
        markedUnreadBeforeSeq: null,
      })
    ).toBe(5);
    expect(
      composedUnreadCount({
        lastReadSeq: 10,
        latestSeq: 10,
        markedUnreadBeforeSeq: null,
      })
    ).toBe(0);
  });

  it("마크 3 · 커서 10 · head 10 이면 3..10 여덟 개다", () => {
    expect(composedUnreadCount(markAt3Cursor10())).toBe(
      MARK_AT_3_CURSOR_10.count
    );
  });

  it("마크가 커서보다 위면 서버 카운트를 넓히지 않는다", () => {
    expect(composedUnreadCount(markAboveCursor())).toBe(MARK_ABOVE_CURSOR.count);
  });
});

describe("unreadDividerCursorSeq", () => {
  it("buildTimelineItems 에 넘기는 커서는 start-1 이다", () => {
    expect(unreadDividerCursorSeq(markAt3Cursor10())).toBe(
      MARK_AT_3_CURSOR_10.dividerCursor
    );
    expect(unreadDividerCursorSeq(markAboveCursor())).toBe(
      MARK_ABOVE_CURSOR.dividerCursor
    );
    expect(
      unreadDividerCursorSeq({ lastReadSeq: 10, markedUnreadBeforeSeq: null })
    ).toBe(10);
  });
});
