import { describe, expect, it } from "vitest";
import {
  parseWebInboxFilter,
  webInboxFilterLabel,
  withRemindersTab,
} from "./inboxTab";

describe("web inbox reminders tab", () => {
  it("docks 나중에 after the server-backed filters and keeps the URL value", () => {
    expect(withRemindersTab(["mentions"])).toEqual(["mentions", "reminders"]);
    expect(parseWebInboxFilter("reminders", ["mentions"])).toBe("reminders");
    expect(parseWebInboxFilter("agents", ["mentions"])).toBe("mentions");
    expect(webInboxFilterLabel("reminders")).toBe("나중에");
  });

  it("always leaves at least two visible tabs so B12 still has something to choose", () => {
    // 서버가 멘션만 답해도 나중에를 붙이므로 탭 줄은 이 클라에서 항상 선다.
    expect(withRemindersTab(["mentions"]).length).toBeGreaterThan(1);
  });
});
