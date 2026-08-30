import { describe, expect, it } from "vitest";
import { WireShapeError } from "../../lib/wire";
import {
  clampReminderNote,
  dueArrivalPlan,
  DUE_NOTIFY_BURST_CAP,
  parseReminder,
  parseReminderPage,
  parseReminderResponse,
  reminderBacklogNotificationBody,
  reminderDueLabel,
  reminderFailureMessage,
  reminderIsOverdue,
  reminderNoteForWire,
  reminderPreviewText,
  REMINDER_NOTE_MAX,
  type MessageReminder,
} from "./model";

const NOW = at(2026, 0, 7, 12, 0);

function at(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute = 0
): number {
  return new Date(year, monthIndex, day, hour, minute, 0, 0).getTime();
}

function row(overrides: Partial<MessageReminder> = {}): MessageReminder {
  return {
    id: "r-1",
    workspaceId: "ws-1",
    memberId: "m-1",
    channelId: "ch-1",
    messageId: "msg-1",
    dueAtMs: NOW + 60_000,
    createdAtMs: NOW - 60_000,
    ...overrides,
  };
}

describe("reminder note cap", () => {
  it("trims and clamps to the UI 200-character ceiling", () => {
    expect(clampReminderNote("  hello  ")).toBe("hello");
    expect(reminderNoteForWire("   ")).toBeUndefined();
    const long = "가".repeat(REMINDER_NOTE_MAX + 8);
    expect(clampReminderNote(long)).toHaveLength(REMINDER_NOTE_MAX);
  });
});

describe("reminder due labels and preview", () => {
  it("counts forward for upcoming rows and marks overdue without a countdown", () => {
    expect(reminderDueLabel(NOW + 5 * 60_000, NOW)).toBe("5분 후");
    expect(reminderDueLabel(NOW + 2 * 60 * 60_000, NOW)).toBe("2시간 후");
    expect(reminderDueLabel(NOW - 60_000, NOW)).toBe("기한 지남");
    expect(reminderIsOverdue(row({ dueAtMs: NOW - 1 }), NOW)).toBe(true);
    expect(
      reminderIsOverdue(row({ dueAtMs: NOW - 1, completedAtMs: NOW }), NOW)
    ).toBe(false);
  });

  it("calls the last 30 seconds upcoming, not overdue, and keeps 곧 reachable", () => {
    expect(reminderDueLabel(NOW + 20_000, NOW)).toBe("곧");
    expect(reminderIsOverdue(row({ dueAtMs: NOW + 20_000 }), NOW)).toBe(false);
    expect(reminderDueLabel(NOW + 1, NOW)).toBe("곧");
    expect(reminderDueLabel(NOW, NOW)).toBe("기한 지남");
  });

  it("prefers the source preview, then the note, then a generic label", () => {
    expect(
      reminderPreviewText(row({ messagePreview: "  배포 점검  ", note: "나중에" }))
    ).toBe("배포 점검");
    expect(reminderPreviewText(row({ note: "메모만" }))).toBe("메모만");
    expect(reminderPreviewText(row())).toBe("메시지");
  });
});

describe("dueArrivalPlan watermark", () => {
  const overdueOld = row({
    id: "old",
    dueAtMs: NOW - 60 * 60_000,
  });
  const overdueNew = row({
    id: "new",
    dueAtMs: NOW - 10_000,
  });
  const upcoming = row({
    id: "later",
    dueAtMs: NOW + 60_000,
  });

  it("on first look notifies nothing and badges every already-due row", () => {
    const plan = dueArrivalPlan({
      reminders: [overdueOld, overdueNew, upcoming],
      nowMs: NOW,
      watermarkMs: null,
      announcedIds: new Set(),
    });
    expect(plan.notifyIds).toEqual([]);
    expect(plan.badgeIds).toEqual(["old", "new"]);
    expect(plan.nextWatermarkMs).toBe(NOW);
  });

  it("on a later poll notifies only rows that crossed due after the watermark", () => {
    const plan = dueArrivalPlan({
      reminders: [overdueOld, overdueNew, upcoming],
      nowMs: NOW,
      watermarkMs: NOW - 30_000,
      announcedIds: new Set(),
    });
    expect(plan.notifyIds).toEqual(["new"]);
    expect(plan.badgeIds).toEqual(["old", "new"]);
  });

  it("does not re-notify a row this session already announced", () => {
    const plan = dueArrivalPlan({
      reminders: [overdueNew],
      nowMs: NOW,
      watermarkMs: NOW - 30_000,
      announcedIds: new Set(["new"]),
    });
    expect(plan.notifyIds).toEqual([]);
    expect(plan.badgeIds).toEqual(["new"]);
  });

  it("collapses a return-from-background burst into one summary above the cap", () => {
    const burst = Array.from({ length: DUE_NOTIFY_BURST_CAP + 1 }, (_, i) =>
      row({ id: `burst-${i}`, dueAtMs: NOW - 1_000 })
    );
    const plan = dueArrivalPlan({
      reminders: burst,
      nowMs: NOW,
      watermarkMs: NOW - 30_000,
      announcedIds: new Set(),
    });
    expect(plan.notifyIds).toEqual([]);
    expect(plan.backlogCount).toBe(DUE_NOTIFY_BURST_CAP + 1);
    expect(plan.backlogIds).toHaveLength(DUE_NOTIFY_BURST_CAP + 1);
    expect(reminderBacklogNotificationBody(4)).toBe("밀린 알림 4건");
  });

  it("still fires individual arrivals at the cap", () => {
    const burst = Array.from({ length: DUE_NOTIFY_BURST_CAP }, (_, i) =>
      row({ id: `cap-${i}`, dueAtMs: NOW - 1_000 })
    );
    const plan = dueArrivalPlan({
      reminders: burst,
      nowMs: NOW,
      watermarkMs: NOW - 30_000,
      announcedIds: new Set(),
    });
    expect(plan.notifyIds).toHaveLength(DUE_NOTIFY_BURST_CAP);
    expect(plan.backlogCount).toBeUndefined();
  });
});

describe("reminder wire parse", () => {
  const wire = {
    id: "r-1",
    workspaceId: "ws-1",
    memberId: "m-1",
    channelId: "ch-1",
    messageId: "msg-1",
    dueAtMs: NOW,
    createdAtMs: NOW - 1,
    note: "배포 후",
    messagePreview: "체크리스트 공유합니다",
    seq: 44,
  };

  it("rebuilds a row from named fields and ignores extras", () => {
    const parsed = parseReminder({ ...wire, secret: "nope" });
    expect(parsed).toMatchObject({
      id: "r-1",
      note: "배포 후",
      messagePreview: "체크리스트 공유합니다",
      messageSeq: 44,
    });
    expect(parsed && "secret" in parsed).toBe(false);
  });

  it("unwraps a list page and a nested create response", () => {
    expect(parseReminderPage({ reminders: [wire] }).reminders).toHaveLength(1);
    expect(parseReminderResponse({ reminder: wire }).id).toBe("r-1");
    expect(parseReminderResponse(wire).id).toBe("r-1");
  });

  it("treats a single malformed row as unusable, not as an empty list", () => {
    expect(parseReminder({ ...wire, dueAtMs: undefined })).toBeNull();
    expect(() => parseReminderPage({ reminders: [{ id: "x" }] })).toThrow(
      WireShapeError
    );
    expect(() => parseReminderPage({ reminders: [] })).not.toThrow();
    expect(parseReminderPage({ reminders: [] }).reminders).toEqual([]);
    expect(() =>
      parseReminderPage({ due_at_ms: NOW, reminders: undefined })
    ).toThrow(WireShapeError);
  });
});

describe("reminderFailureMessage names the verb that failed", () => {
  const fail = (status: number) => ({ status });

  it("keeps create copy as the default and swaps the closing verb", () => {
    expect(reminderFailureMessage(fail(500))).toBe(
      "알림을 저장하지 못했습니다. 다시 시도하세요."
    );
    expect(reminderFailureMessage(fail(500), "delete")).toBe(
      "알림을 지우지 못했습니다. 다시 시도하세요."
    );
    expect(reminderFailureMessage(fail(500), "snooze")).toBe(
      "알림을 미루지 못했습니다. 다시 시도하세요."
    );
    expect(reminderFailureMessage(fail(500), "complete")).toBe(
      "알림을 완료하지 못했습니다. 다시 시도하세요."
    );
  });
});
