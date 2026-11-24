import { describe, expect, it } from "vitest";
import { catalog as koCatalog } from "../../i18n/generated/ko-KR";
import { createMessageCopy } from "../../testkit";
import {
  COPY_LINK_ACTION_KEY,
  COPY_LINK_DONE_KEY,
  COPY_MESSAGE_ACTION_KEY,
  COPY_MESSAGE_DONE_KEY,
  copyLinkActionKey,
  copyMessageActionKey,
} from "./copyLabels";

const ko = createMessageCopy({ messageLocale: "ko-KR", catalog: koCatalog });

describe("복사 액션 낱말", () => {
  it("대기와 영수증이 갈리고 둘 다 메시지를 이름으로 든다", () => {
    expect(copyMessageActionKey(false)).toBe(COPY_MESSAGE_ACTION_KEY);
    expect(copyMessageActionKey(true)).toBe(COPY_MESSAGE_DONE_KEY);
    expect(ko(COPY_MESSAGE_ACTION_KEY)).toBe("메시지 복사하기");
    expect(ko(COPY_MESSAGE_DONE_KEY)).toBe("메시지 복사됨");
    expect(copyMessageActionKey(false)).not.toBe(copyMessageActionKey(true));
  });

  it("링크 복사도 같은 동사 결이다", () => {
    expect(copyLinkActionKey(false)).toBe(COPY_LINK_ACTION_KEY);
    expect(copyLinkActionKey(true)).toBe(COPY_LINK_DONE_KEY);
    expect(ko(COPY_LINK_ACTION_KEY)).toBe("링크 복사하기");
    expect(ko(COPY_LINK_DONE_KEY)).toBe("링크 복사됨");
  });

  it("대기 낱말은 메뉴 형제와 같이 동사형이다", () => {
    expect(ko(COPY_MESSAGE_ACTION_KEY).endsWith("하기")).toBe(true);
    expect(ko(COPY_LINK_ACTION_KEY).endsWith("하기")).toBe(true);
  });
});
