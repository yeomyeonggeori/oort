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
});
