import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import {
  MARK_UNREAD_ACTION_LABEL,
  MARK_UNREAD_SUCCESS_ANNOUNCEMENT,
  markUnreadFailureMessage,
} from "./copy";

describe("mark-unread copy", () => {
  it("메뉴 낱말은 짧은 한글 문장이다", () => {
    expect(MARK_UNREAD_ACTION_LABEL).toBe("여기부터 안 읽음");
    expect(MARK_UNREAD_ACTION_LABEL).not.toMatch(/[—–]/);
    expect(MARK_UNREAD_SUCCESS_ANNOUNCEMENT).toBe(
      "여기부터 안 읽음으로 표시했습니다"
    );
    expect(MARK_UNREAD_SUCCESS_ANNOUNCEMENT).not.toMatch(/[—–]/);
  });

  it("400/403 은 행 배너 문장이고 와이어를 그대로 싣지 않는다", () => {
    expect(markUnreadFailureMessage(new ApiError(400, "seq does not exist"))).toContain(
      "더 이상 없습니다"
    );
    expect(markUnreadFailureMessage(new ApiError(400, "seq does not exist"))).not.toContain(
      "다시 눌러"
    );
    expect(markUnreadFailureMessage(new ApiError(403, "forbidden"))).toContain(
      "멤버만"
    );
    const generic = markUnreadFailureMessage(new Error("boom"));
    expect(generic).toContain("다시 시도");
    expect(generic).not.toContain("boom");
  });
});
