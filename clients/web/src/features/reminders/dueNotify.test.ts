import { describe, expect, it } from "vitest";
import type { MessageReminder } from "@momo/core/features/reminders/model";
import { catalog as koCatalog } from "@momo/core/i18n/generated/ko-KR";
import { createMessageService } from "@momo/core/i18n";
import { reminderNotifyDecision, reminderNotificationBody } from "./dueNotify";
import { reminderBacklogNotificationBody } from "@momo/core/features/reminders/model";

const koFormat = createMessageService({ messageLocale: "ko-KR", catalog: koCatalog }).formatMessage;

const reminder: MessageReminder = {
  id: "r-1",
  workspaceId: "ws",
  memberId: "m",
  channelId: "ch",
  messageId: "msg",
  dueAtMs: 1,
  createdAtMs: 0,
  messagePreview: "배포 점검 부탁드립니다",
};

describe("reminderNotifyDecision", () => {
  it("stays silent in a browser tab and when the kind is off", () => {
    expect(
      reminderNotifyDecision({
        isDesktop: false,
        kindEnabled: true,
        announced: false,
      })
    ).toEqual({ show: false, skip: "browser" });
    expect(
      reminderNotifyDecision({
        isDesktop: true,
        kindEnabled: false,
        announced: false,
      })
    ).toEqual({ show: false, skip: "kind-disabled" });
    expect(
      reminderNotifyDecision({
        isDesktop: true,
        kindEnabled: true,
        announced: true,
      })
    ).toEqual({ show: false, skip: "duplicate" });
    expect(
      reminderNotifyDecision({
        isDesktop: true,
        kindEnabled: true,
        announced: false,
      })
    ).toEqual({ show: true });
  });

  it("reuses the A4 body sanitiser for the OS banner", () => {
    expect(reminderNotificationBody(reminder, koFormat)).toBe("배포 점검 부탁드립니다");
    expect(
      reminderNotificationBody({
        ...reminder,
        messagePreview: "```secret```",
      }, koFormat)
    ).toBe("코드");
    expect(reminderBacklogNotificationBody(koFormat, 4)).toBe("밀린 알림 4건");
  });
});
