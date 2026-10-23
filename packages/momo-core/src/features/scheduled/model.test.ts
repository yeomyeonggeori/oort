import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCHEDULED_REFETCH_GRACE_MS,
  actionLabel,
  attachmentChipLine,
  attachmentCount,
  bannerLine,
  compareScheduled,
  editLock,
  editableUntilMs,
  focusAfterRemoval,
  isOpenRow,
  needsReview,
  nextScheduledBoundaryMs,
  rowActions,
  rowAriaName,
  rowMenuAriaName,
  rowPhase,
  rowWhenLine,
  rowsInPlace,
  reviewAttachmentsLine,
  scheduledBanner,
  scheduledDisplayOrder,
  scheduledNavEntry,
  scheduledPreview,
  scheduledRefetchAtMs,
  scheduledSections,
  scheduledTotals,
} from "./model";
import type { ScheduledFailureReason, ScheduledMessage } from "./types";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const CH2 = "00000000-0000-7000-8000-000000000202";
const ROOT = "00000000-0000-7000-8000-000000000301";
const ROOT2 = "00000000-0000-7000-8000-000000000302";

beforeEach(() => {
  vi.stubEnv("TZ", "Asia/Seoul");
  expect(new Date(2026, 0, 15, 12, 0).getTimezoneOffset()).toBe(-540);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * 2026년 Asia/Seoul 벽시계 시각의 에포크. **프로세스의 TZ와 무관하게** 계산한다: 모듈 상수(`NOW`)는 `beforeEach`가
 * TZ를 고정하기 전에 만들어지고, CI는 UTC로 돌아서 지역 시각(`new Date(y, m, d, h)`)으로 만들면 9시간이 어긋난다.
 * 서울은 서머타임이 없어 `UTC+9`가 늘 맞다.
 */
function at(month: number, day: number, hour: number, minute = 0, second = 0): number {
  return Date.UTC(2026, month - 1, day, hour - 9, minute, second, 0);
}

// 2026-10-22(목) 14:30
const NOW = at(10, 22, 14, 30);
const TOMORROW_9 = at(10, 23, 9);

let counter = 0;
function row(overrides: Partial<ScheduledMessage> = {}): ScheduledMessage {
  counter += 1;
  const sendAtMs = overrides.sendAtMs ?? TOMORROW_9;
  const status = overrides.status ?? "pending";
  const base: ScheduledMessage = {
    id: `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    workspaceId: WS,
    memberId: ME,
    channelId: CH,
    body: "내일 회의 전에 자료 올려 둘게요",
    sendAtMs,
    status,
    rev: 0,
    createdAtMs: NOW - 86_400_000,
    updatedAtMs: NOW - 86_400_000,
  };
  if (status === "pending") base.editableUntilMs = sendAtMs - 30_000;
  return { ...base, ...overrides };
}

function failed(reason: ScheduledFailureReason, overrides: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return row({ status: "failed", failureReason: reason, sendAtMs: NOW - 3_600_000, ...overrides });
}

describe("sections and counts (UI spec 1.7)", () => {
  it("puts 보내지 못함 above 보낼 예정 and sorts pending by the nearest send time", () => {
    const later = row({ sendAtMs: at(10, 26, 9) });
    const sooner = row({ sendAtMs: at(10, 23, 9) });
    const sameTimeB = row({ sendAtMs: at(10, 24, 9), id: "00000000-0000-7000-8000-0000000000bb" });
    const sameTimeA = row({ sendAtMs: at(10, 24, 9), id: "00000000-0000-7000-8000-0000000000aa" });
    const missed = failed("missed");
    const sections = scheduledSections([later, missed, sameTimeB, sooner, sameTimeA]);
    expect(sections.failed.map((entry) => entry.id)).toEqual([missed.id]);
    expect(sections.pending.map((entry) => entry.id)).toEqual([sooner.id, sameTimeA.id, sameTimeB.id, later.id]);
  });

  it("drops rows that are not open and does not reorder the caller's array", () => {
    const input = [row({ sendAtMs: at(10, 26, 9) }), row({ status: "sent" }), row({ status: "cancelled" }), row()];
    const copy = [...input];
    const sections = scheduledSections(input);
    expect(sections.pending).toHaveLength(2);
    expect(sections.failed).toHaveLength(0);
    expect(input).toEqual(copy);
    expect(isOpenRow(row({ status: "sent" }))).toBe(false);
    expect(isOpenRow(failed("missed"))).toBe(true);
  });

  it("counts 내 예약 as pending plus failed", () => {
    expect(scheduledTotals([row(), row(), failed("missed"), row({ status: "sent" })])).toEqual({
      total: 3,
      pending: 2,
      failed: 1,
    });
    expect(scheduledTotals([])).toEqual({ total: 0, pending: 0, failed: 0 });
  });

  it("lists rows in the order they are shown, failed first", () => {
    const a = row({ sendAtMs: at(10, 24, 9) });
    const b = row({ sendAtMs: at(10, 23, 9) });
    const c = failed("not_member");
    expect(scheduledDisplayOrder([a, b, c])).toEqual([c.id, b.id, a.id]);
  });

  it("orders by the server's keyset: time first, then id", () => {
    const early = row({ sendAtMs: 1, id: "b" });
    const late = row({ sendAtMs: 2, id: "a" });
    expect(compareScheduled(early, late)).toBeLessThan(0);
    expect(compareScheduled(row({ sendAtMs: 1, id: "a" }), row({ sendAtMs: 1, id: "b" }))).toBeLessThan(0);
    expect(compareScheduled(early, early)).toBe(0);
  });
});

describe("the banner above the composer (UI spec 1.6)", () => {
  it("counts a channel's rows in the channel, thread replies included, and a thread's rows in the thread", () => {
    const rows = [
      row(),
      row({ rootId: ROOT }),
      row({ rootId: ROOT }),
      row({ rootId: ROOT2 }),
      row({ channelId: CH2 }),
    ];
    expect(rowsInPlace(rows, { channelId: CH })).toHaveLength(4);
    expect(rowsInPlace(rows, { channelId: CH, rootId: ROOT })).toHaveLength(2);
    expect(rowsInPlace(rows, { channelId: CH, rootId: ROOT2 })).toHaveLength(1);
    expect(rowsInPlace(rows, { channelId: CH2 })).toHaveLength(1);
    expect(scheduledBanner(rows, { channelId: CH })).toEqual({ tone: "pending", count: 4 });
    expect(scheduledBanner(rows, { channelId: CH, rootId: ROOT })).toEqual({ tone: "pending", count: 2 });
  });

  it("matches ids across letter case", () => {
    expect(scheduledBanner([row({ channelId: CH.toLowerCase() })], { channelId: CH.toUpperCase() })).toEqual({
      tone: "pending",
      count: 1,
    });
  });

  it("shows only the failed line when any is failed, and counts the failed ones", () => {
    const rows = [row(), row(), failed("not_member"), failed("missed")];
    expect(scheduledBanner(rows, { channelId: CH })).toEqual({ tone: "failed", count: 2 });
  });

  it("is absent when the place has no open rows, and ignores rows that are not open", () => {
    expect(scheduledBanner([], { channelId: CH })).toBeNull();
    expect(scheduledBanner([row({ status: "sent" }), row({ channelId: CH2 })], { channelId: CH })).toBeNull();
  });

  it("writes the banner sentence with the place word, and the failed one without it", () => {
    expect(bannerLine({ tone: "pending", count: 2 }, "채널")).toBe("이 채널에 예약된 메시지 2개");
    expect(bannerLine({ tone: "pending", count: 2 }, "대화")).toBe("이 대화에 예약된 메시지 2개");
    expect(bannerLine({ tone: "pending", count: 1 }, "스레드")).toBe("이 스레드에 예약된 메시지 1개");
    expect(bannerLine({ tone: "failed", count: 1 }, "채널")).toBe("예약한 메시지 1개를 보내지 못했어요");
  });
});

describe("the sidebar row (UI spec 1.1)", () => {
  it("is absent when nothing is waiting or failed", () => {
    expect(scheduledNavEntry([])).toEqual({ visible: false, failedCount: 0, badgeLabel: null });
    expect(scheduledNavEntry([row({ status: "sent" })]).visible).toBe(false);
  });

  it("shows without a pill when only pending rows exist: waiting rows are never counted on the pill", () => {
    expect(scheduledNavEntry([row(), row(), row()])).toEqual({ visible: true, failedCount: 0, badgeLabel: null });
  });

  it("puts the number of failed rows on the pill, with its spoken name", () => {
    expect(scheduledNavEntry([row(), failed("missed"), failed("not_member")])).toEqual({
      visible: true,
      failedCount: 2,
      badgeLabel: "보내지 못한 예약 2개",
    });
    expect(scheduledNavEntry([failed("sessions_ended")]).visible).toBe(true);
  });
});

describe("phase and lock (UI spec 0.6, ADR-0208 D9)", () => {
  const send = at(10, 23, 9);
  const waiting = row({ sendAtMs: send });

  it("is waiting until 30 seconds before the send time, soon from then, sending after the send time", () => {
    expect(rowPhase(waiting, send - 30_001)).toBe("waiting");
    expect(rowPhase(waiting, send - 30_000)).toBe("soon");
    expect(rowPhase(waiting, send - 1)).toBe("soon");
    expect(rowPhase(waiting, send)).toBe("sending");
    expect(rowPhase(waiting, send + 600_000)).toBe("sending");
  });

  it("reads editableUntilMs as the server's hint and falls back to sendAtMs minus 30 seconds", () => {
    expect(editableUntilMs(waiting)).toBe(send - 30_000);
    const noHint = row({ sendAtMs: send });
    delete noHint.editableUntilMs;
    expect(editableUntilMs(noHint)).toBe(send - 30_000);
    const hinted = row({ sendAtMs: send, editableUntilMs: send - 45_000 });
    expect(rowPhase(hinted, send - 40_000)).toBe("soon");
  });

  it("calls a failed row failed whatever the time", () => {
    expect(rowPhase(failed("missed"), NOW)).toBe("failed");
    expect(rowPhase(failed("missed", { sendAtMs: NOW + 86_400_000 }), NOW)).toBe("failed");
  });

  it("writes the time line: 보낼 시각, then 곧 보내요, then 보내는 중", () => {
    expect(rowWhenLine(waiting, NOW)).toBe("내일 오전 9:00에 보내요");
    expect(rowWhenLine(waiting, send - 10_000)).toBe("곧 보내요");
    expect(rowWhenLine(waiting, send + 10_000)).toBe("보내는 중");
    expect(rowWhenLine(row({ sendAtMs: at(10, 26, 9) }), NOW)).toBe("10월 26일 (월) 오전 9:00에 보내요");
    expect(rowWhenLine(failed("missed"), NOW)).toBe("");
  });

  it("locks a dialog that is open on a row once it enters the last 30 seconds, and when the row is gone", () => {
    expect(editLock(waiting, send - 31_000)).toBe("open");
    expect(editLock(waiting, send - 30_000)).toBe("tooLate");
    expect(editLock(waiting, send + 1)).toBe("tooLate");
    expect(editLock(undefined, NOW)).toBe("gone");
    expect(editLock(row({ status: "sent" }), NOW)).toBe("gone");
    expect(editLock(row({ status: "cancelled" }), NOW)).toBe("gone");
    // 실패 행은 시각과 무관하게 열려 있다(다시 걸 수 있다).
    expect(editLock(failed("missed"), NOW)).toBe("open");
  });

  it("finds the next moment the screen has to change: the nearest edit lock or send time after now", () => {
    const a = row({ sendAtMs: send });
    const b = row({ sendAtMs: send + 3_600_000 });
    expect(nextScheduledBoundaryMs([a, b], NOW)).toBe(send - 30_000);
    expect(nextScheduledBoundaryMs([a, b], send - 10_000)).toBe(send);
    expect(nextScheduledBoundaryMs([a, b], send)).toBe(send + 3_600_000 - 30_000);
    expect(nextScheduledBoundaryMs([a], send)).toBeNull();
    expect(nextScheduledBoundaryMs([], NOW)).toBeNull();
    // 실패한 행과 닫힌 행에는 경계가 없다.
    expect(nextScheduledBoundaryMs([failed("missed"), row({ status: "sent" })], NOW)).toBeNull();
  });

  it("re-reads 35 seconds after the send time, for pending rows only", () => {
    expect(SCHEDULED_REFETCH_GRACE_MS).toBe(35_000);
    expect(scheduledRefetchAtMs(waiting)).toBe(send + 35_000);
    expect(scheduledRefetchAtMs(failed("missed"))).toBeNull();
  });
});

describe("row actions (UI spec 1.7 and 1.8)", () => {
  const waiting = row({ sendAtMs: at(10, 25, 9) });

  it("gives a waiting row the four menu actions and no always-visible button", () => {
    expect(rowActions(waiting, NOW)).toEqual({
      inline: [],
      menu: ["sendNow", "change", "edit", "delete"],
      locked: [],
      editHasTime: true,
    });
  });

  it("dims 시간 바꾸기 and 고치기 in the last 30 seconds, and keeps 지금 보내기 and 지우기 working until the send", () => {
    const soon = row({ sendAtMs: NOW + 20_000 });
    const sending = row({ sendAtMs: NOW - 5_000 });
    for (const locked of [soon, sending]) {
      const actions = rowActions(locked, NOW);
      expect(actions.locked).toEqual(["change", "edit"]);
      expect(actions.menu).toContain("sendNow");
      expect(actions.menu).toContain("delete");
      expect(actions.locked).not.toContain("sendNow");
      expect(actions.locked).not.toContain("delete");
    }
  });

  it("shows 지금 보내기 and 다시 예약 on the row for the recoverable reasons (missed, send_error)", () => {
    for (const reason of ["missed", "send_error"] as const) {
      expect(rowActions(failed(reason), NOW), reason).toEqual({
        inline: ["sendNow", "rearm"],
        menu: ["sendNow", "rearm", "edit", "copy", "delete"],
        locked: [],
        editHasTime: true,
      });
    }
  });

  it("shows only 내용 복사 on the row for the other reasons, with everything in the menu", () => {
    for (const reason of [
      "author_inactive",
      "not_member",
      "root_unavailable",
      "attachment_unavailable",
      "not_allowed",
    ] as const) {
      expect(rowActions(failed(reason), NOW), reason).toEqual({
        inline: ["copy"],
        menu: ["sendNow", "rearm", "edit", "copy", "delete"],
        locked: [],
        editHasTime: true,
      });
    }
  });

  it("never offers 지금 보내기 or 다시 예약 on a sessions_ended row, not even in the menu", () => {
    const held = failed("sessions_ended");
    const actions = rowActions(held, NOW);
    expect(actions.inline).toEqual(["review"]);
    expect(actions.menu).toEqual(["review", "edit", "copy", "delete"]);
    expect(actions.menu).not.toContain("sendNow");
    expect(actions.menu).not.toContain("rearm");
    expect(actions.inline).not.toContain("sendNow");
    expect(actions.inline).not.toContain("rearm");
    // 이 행의 고치기에는 시각 칸이 없다: 시각을 주면 행이 되살아나 내용 확인을 비켜 간다.
    expect(actions.editHasTime).toBe(false);
  });

  it("flags only a failed sessions_ended row as needing the review", () => {
    expect(needsReview(failed("sessions_ended"))).toBe(true);
    expect(needsReview(failed("missed"))).toBe(false);
    expect(needsReview(row())).toBe(false);
    expect(needsReview(row({ failureReason: "sessions_ended" }))).toBe(false);
  });

  it("has no actions on a row that is not open", () => {
    expect(rowActions(row({ status: "sent" }), NOW)).toEqual({ inline: [], menu: [], locked: [], editHasTime: false });
  });

  it("labels each action with the spec's word", () => {
    expect(actionLabel("sendNow")).toBe("지금 보내기");
    expect(actionLabel("change")).toBe("시간 바꾸기");
    expect(actionLabel("rearm")).toBe("다시 예약");
    expect(actionLabel("review")).toBe("내용 확인");
    expect(actionLabel("edit")).toBe("고치기");
    expect(actionLabel("copy")).toBe("내용 복사");
    expect(actionLabel("delete")).toBe("지우기");
  });
});

describe("the words and names of a row", () => {
  it("collapses whitespace in the preview and leaves an attachment-only row empty", () => {
    expect(scheduledPreview(row({ body: "  첫 줄\n\n둘째   줄  " }))).toBe("첫 줄 둘째 줄");
    expect(scheduledPreview(row({ body: "" }))).toBe("");
    const bodyless = row();
    delete bodyless.body;
    expect(scheduledPreview(bodyless)).toBe("");
  });

  it("counts attachments for the chip and names them for the review", () => {
    const withFiles = row({
      attachments: [
        { id: "a1", name: "일정.pdf", mime: "application/pdf", sizeBytes: 1 },
        { id: "a2", name: "변경목록.csv", mime: "text/csv", sizeBytes: 2 },
      ],
    });
    expect(attachmentCount(withFiles)).toBe(2);
    expect(attachmentChipLine(withFiles)).toBe("첨부 2개");
    expect(reviewAttachmentsLine(withFiles)).toBe("첨부 2개: 일정.pdf, 변경목록.csv");
    expect(attachmentChipLine(row())).toBeNull();
    expect(reviewAttachmentsLine(row())).toBeNull();
  });

  it("reads a waiting row aloud as channel, preview and time, with the weekday spelled out", () => {
    const waiting = row({ sendAtMs: TOMORROW_9 });
    expect(rowAriaName(waiting, "일반", NOW, "채널")).toBe(
      "일반, 내일 회의 전에 자료 올려 둘게요, 내일 오전 9:00, 10월 23일 금요일에 보내요"
    );
  });

  it("reads 곧 보내요 and 보내는 중 instead of a time once the lock has begun", () => {
    const soon = row({ sendAtMs: NOW + 20_000 });
    const sending = row({ sendAtMs: NOW - 1_000 });
    expect(rowAriaName(soon, "일반", NOW, "채널")).toBe("일반, 내일 회의 전에 자료 올려 둘게요, 곧 보내요");
    expect(rowAriaName(sending, "일반", NOW, "채널")).toBe("일반, 내일 회의 전에 자료 올려 둘게요, 보내는 중");
  });

  it("reads a failed row aloud as channel, preview and the reason", () => {
    expect(rowAriaName(failed("not_member", { body: "금요일 배포 공지" }), "배포", NOW, "채널")).toBe(
      "배포, 금요일 배포 공지, 이 채널에서 나가서 보내지 못했어요"
    );
    expect(rowAriaName(failed("not_member", { body: "안녕" }), "김인턴과의 대화", NOW, "대화")).toBe(
      "김인턴과의 대화, 안녕, 이 대화에서 나가서 보내지 못했어요"
    );
  });

  it("names the row menu per row so two menus never sound alike", () => {
    expect(rowMenuAriaName(row({ sendAtMs: TOMORROW_9 }), "일반", NOW)).toBe(
      "일반, 내일 오전 9:00, 10월 23일 금요일 예약 동작"
    );
    expect(rowMenuAriaName(row({ sendAtMs: at(10, 26, 9) }), "일반", NOW)).not.toBe(
      rowMenuAriaName(row({ sendAtMs: TOMORROW_9 }), "일반", NOW)
    );
  });
});

describe("where focus goes when a row disappears (UI spec 1.7)", () => {
  const order = ["a", "b", "c"];

  it("goes to the next row, else the previous row, else the list title", () => {
    expect(focusAfterRemoval(order, "a")).toEqual({ kind: "row", id: "b" });
    expect(focusAfterRemoval(order, "b")).toEqual({ kind: "row", id: "c" });
    expect(focusAfterRemoval(order, "c")).toEqual({ kind: "row", id: "b" });
    expect(focusAfterRemoval(["a"], "a")).toEqual({ kind: "title" });
    expect(focusAfterRemoval([], "a")).toEqual({ kind: "title" });
    expect(focusAfterRemoval(order, "zzz")).toEqual({ kind: "title" });
  });

  it("finds the row regardless of letter case", () => {
    expect(focusAfterRemoval(["AA", "BB"], "aa")).toEqual({ kind: "row", id: "BB" });
  });
});
