import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { catalog as koCatalog } from "../../i18n/generated/ko-KR";
import { createMessageCopy } from "../../testkit";
import { MARK_UNREAD_ACTION_KEY, MARK_UNREAD_SUCCESS_KEY, markUnreadFailureKey } from "./copy";

// 문장은 사전(`readState.json`)에 있다(#6020). 시험은 제품과 같은 한국어 생성물로 키를 풀어 문장을 단정한다.
const ko = createMessageCopy({ messageLocale: "ko-KR", catalog: koCatalog });

describe("mark-unread copy", () => {
  it("메뉴 낱말은 짧은 한글 문장이다", () => {
    expect(ko(MARK_UNREAD_ACTION_KEY)).toBe("여기부터 안 읽음");
    expect(ko(MARK_UNREAD_ACTION_KEY)).not.toMatch(/[—–]/);
    expect(ko(MARK_UNREAD_SUCCESS_KEY)).toBe("여기부터 안 읽음으로 표시했습니다");
    expect(ko(MARK_UNREAD_SUCCESS_KEY)).not.toMatch(/[—–]/);
  });

  it("400/403 은 행 배너 문장이고 와이어를 그대로 싣지 않는다", () => {
    const failure = (error: unknown) => ko(markUnreadFailureKey(error));
    expect(failure(new ApiError(400, "seq does not exist"))).toContain("더 이상 없습니다");
    expect(failure(new ApiError(400, "seq does not exist"))).not.toContain("다시 눌러");
    expect(failure(new ApiError(403, "forbidden"))).toContain("멤버만");
    const generic = failure(new Error("boom"));
    expect(generic).toContain("다시 시도");
    expect(generic).not.toContain("boom");
  });
});
