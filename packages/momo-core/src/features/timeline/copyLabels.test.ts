import { describe, expect, it } from "vitest";
import {
  COPY_LINK_ACTION_LABEL,
  COPY_LINK_DONE_LABEL,
  COPY_MESSAGE_ACTION_LABEL,
  COPY_MESSAGE_DONE_LABEL,
  copyLinkActionLabel,
  copyMessageActionLabel,
} from "./copyLabels";

describe("복사 액션 낱말", () => {
  it("대기와 영수증이 갈리고 둘 다 메시지를 이름으로 든다", () => {
    expect(copyMessageActionLabel(false)).toBe(COPY_MESSAGE_ACTION_LABEL);
    expect(copyMessageActionLabel(true)).toBe(COPY_MESSAGE_DONE_LABEL);
    expect(COPY_MESSAGE_ACTION_LABEL).toBe("메시지 복사하기");
    expect(COPY_MESSAGE_DONE_LABEL).toBe("메시지 복사됨");
    expect(copyMessageActionLabel(false)).not.toBe(copyMessageActionLabel(true));
  });

  it("링크 복사도 같은 동사 결이다", () => {
    expect(copyLinkActionLabel(false)).toBe(COPY_LINK_ACTION_LABEL);
    expect(copyLinkActionLabel(true)).toBe(COPY_LINK_DONE_LABEL);
    expect(COPY_LINK_ACTION_LABEL).toBe("링크 복사하기");
    expect(COPY_LINK_DONE_LABEL).toBe("링크 복사됨");
  });

  it("대기 낱말은 메뉴 형제와 같이 동사형이다", () => {
    expect(COPY_MESSAGE_ACTION_LABEL.endsWith("하기")).toBe(true);
    expect(COPY_LINK_ACTION_LABEL.endsWith("하기")).toBe(true);
  });
});
