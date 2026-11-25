import { catalog as koCatalog } from "@momo/core/i18n/generated/ko-KR";
import { createMessageCopy } from "@momo/core/testkit";
import { describe, expect, it } from "vitest";
import {
  parseWebInboxFilter,
  webInboxFilterLabel,
  withRemindersTab,
} from "./inboxTab";

// 탭 낱말은 사전 키다(#6058). 한국어 생성물로 풀어 예전 낱말 그대로 단정한다.
const ko = createMessageCopy({ messageLocale: "ko-KR", catalog: koCatalog });

describe("web inbox reminders tab", () => {
  it("docks 나중에 after the server-backed filters and keeps the URL value", () => {
    expect(withRemindersTab(["mentions"])).toEqual(["mentions", "reminders"]);
    expect(parseWebInboxFilter("reminders", ["mentions"])).toBe("reminders");
    expect(parseWebInboxFilter("agents", ["mentions"])).toBe("mentions");
    const label = webInboxFilterLabel("reminders");
    expect(typeof label === "object" ? ko(label.key as "reminders.tab.later") : label).toBe("나중에");
  });

  it("always leaves at least two visible tabs so B12 still has something to choose", () => {
    // 서버가 멘션만 답해도 나중에를 붙이므로 탭 줄은 이 클라에서 항상 선다.
    expect(withRemindersTab(["mentions"]).length).toBeGreaterThan(1);
  });
});
