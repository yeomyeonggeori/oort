import { describe, expect, it } from "vitest";
import {
  MARK_AT_3_CURSOR_10,
  markAt3Cursor10,
} from "@momo/core/features/readState/proof";
import {
  foldInVisitMark,
  freezeOpenedRead,
  timelineUnreadFromOpened,
} from "./openedReadState";

describe("재열람 방문은 연 순간의 마크 경계를 지킨다 (B-1)", () => {
  it("마크 N, 커서가 밀린 뒤 재열람 → explicit_open 이 마크를 지워도 그 방문의 구분선은 N 위", () => {
    const atOpen = markAt3Cursor10();
    const frozen = freezeOpenedRead(atOpen.channelId, atOpen);
    const afterExplicitOpen = {
      ...atOpen,
      markedUnreadBeforeSeq: null,
    };
    const visiting = foldInVisitMark(frozen, afterExplicitOpen);
    const visit = timelineUnreadFromOpened(visiting);
    expect(visit.lastReadSeq).toBe(MARK_AT_3_CURSOR_10.dividerCursor);
    expect(visit.unreadCount).toBe(MARK_AT_3_CURSOR_10.count);
  });

  it("그 채널을 나갔다가 다시 열면 마크가 없으니 커서 기준이다", () => {
    const afterExplicitOpen = {
      ...markAt3Cursor10(),
      markedUnreadBeforeSeq: null,
    };
    const second = freezeOpenedRead(
      afterExplicitOpen.channelId,
      afterExplicitOpen
    );
    const visit = timelineUnreadFromOpened(second);
    expect(visit.lastReadSeq).toBe(afterExplicitOpen.lastReadSeq);
    expect(visit.unreadCount).toBe(0);
  });

  it("방문 중에 찍은 마크는 스냅샷을 앞당긴다", () => {
    const unmarked = {
      ...markAt3Cursor10(),
      markedUnreadBeforeSeq: null,
    };
    const frozen = freezeOpenedRead(unmarked.channelId, unmarked);
    expect(timelineUnreadFromOpened(frozen).unreadCount).toBe(0);
    const visiting = foldInVisitMark(frozen, markAt3Cursor10());
    const visit = timelineUnreadFromOpened(visiting);
    expect(visit.lastReadSeq).toBe(MARK_AT_3_CURSOR_10.dividerCursor);
    expect(visit.unreadCount).toBe(MARK_AT_3_CURSOR_10.count);
  });
});
