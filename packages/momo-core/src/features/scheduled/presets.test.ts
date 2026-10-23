import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSendAtMs,
  formatScheduledAt,
  formatScheduledDate,
  initialSendAtMs,
  scheduledPresets,
  scheduledZoneLabel,
  scheduledZoneLine,
  sendAtFromInputs,
  sendAtInputs,
  sendAtProblemSentence,
  utcOffsetLabel,
  validateSendAt,
} from "./presets";
import { SCHEDULED_MAX_LEAD_MS, SCHEDULED_MIN_LEAD_MS } from "./types";

// 이 파일은 서머타임이 없는 Asia/Seoul로 고정한다: 문장·경계 시험이 실행하는 기계의 시간대와 무관하다.
// 서머타임·UTC 오프셋이 다른 시간대는 `presets.tz.test.ts`가 잰다.
beforeEach(() => {
  vi.stubEnv("TZ", "Asia/Seoul");
  // 시간대 고정이 실제로 먹었는지 첫 단정으로 잰다. 안 먹었는데 초록이 나오는 시험이 되지 않게.
  expect(new Date(2026, 0, 15, 12, 0).getTimezoneOffset()).toBe(-540);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

// 2026-10-22(목) 14:30. 명세 예시(「내일 오전 9:00, 10월 23일 금요일」)가 이 날을 기준으로 쓰였다.
const NOW = at(2026, 10, 22, 14, 30);

describe("formatScheduledAt: the parts of a time (UI spec 0.2)", () => {
  it("writes 오늘·내일·모레 as words and gives the spec's aria sentence for 내일", () => {
    expect(formatScheduledAt(at(2026, 10, 22, 15), NOW)).toEqual({
      day: "오늘",
      time: "오후 3:00",
      full: "오늘 오후 3:00",
      aria: "오늘 오후 3:00, 10월 22일 목요일",
    });
    expect(formatScheduledAt(at(2026, 10, 23, 9), NOW)).toEqual({
      day: "내일",
      time: "오전 9:00",
      full: "내일 오전 9:00",
      aria: "내일 오전 9:00, 10월 23일 금요일",
    });
    expect(formatScheduledAt(at(2026, 10, 24, 18, 5), NOW)).toEqual({
      day: "모레",
      time: "오후 6:05",
      full: "모레 오후 6:05",
      aria: "모레 오후 6:05, 10월 24일 토요일",
    });
  });

  it("writes every other day as a date with the weekday abbreviation, never as a bare weekday", () => {
    expect(formatScheduledAt(at(2026, 10, 26, 9), NOW)).toEqual({
      day: "10월 26일 (월)",
      time: "오전 9:00",
      full: "10월 26일 (월) 오전 9:00",
      aria: "10월 26일 월요일 오전 9:00",
    });
    // 3~6일 뒤도 「목요일 오후 3:00」처럼 요일만 쓰지 않는다.
    for (let ahead = 3; ahead <= 9; ahead += 1) {
      const full = formatScheduledAt(at(2026, 10, 22 + ahead, 15), NOW).full;
      expect(full, `+${ahead}일`).toMatch(/^\d+월 \d+일 \([일월화수목금토]\) 오후 3:00$/);
    }
  });

  it("has no word for yesterday: a past day other than today is a date", () => {
    expect(formatScheduledAt(at(2026, 10, 21, 9), NOW).day).toBe("10월 21일 (수)");
  });

  it("adds the year only when it differs from now's year", () => {
    expect(formatScheduledAt(at(2027, 1, 4, 9), NOW)).toEqual({
      day: "2027년 1월 4일 (월)",
      time: "오전 9:00",
      full: "2027년 1월 4일 (월) 오전 9:00",
      aria: "2027년 1월 4일 월요일 오전 9:00",
    });
    // 내일이 새해여도 말로 쓰고, 낭독의 날짜에는 해를 싣는다.
    const newYearsEve = at(2026, 12, 31, 20);
    expect(formatScheduledAt(at(2027, 1, 1, 9), newYearsEve)).toEqual({
      day: "내일",
      time: "오전 9:00",
      full: "내일 오전 9:00",
      aria: "내일 오전 9:00, 2027년 1월 1일 금요일",
    });
  });

  it("uses a 12-hour clock with two-digit minutes: 12시는 오후, 0시는 오전 12시", () => {
    expect(formatScheduledAt(at(2026, 10, 23, 12), NOW).time).toBe("오후 12:00");
    expect(formatScheduledAt(at(2026, 10, 23, 0), NOW).time).toBe("오전 12:00");
    expect(formatScheduledAt(at(2026, 10, 23, 0, 5), NOW).time).toBe("오전 12:05");
    expect(formatScheduledAt(at(2026, 10, 23, 13, 7), NOW).time).toBe("오후 1:07");
    expect(formatScheduledAt(at(2026, 10, 23, 9), NOW).time).toBe("오전 9:00");
  });

  it("counts days on the calendar, not in 24-hour blocks: 00:10 tomorrow is 내일 from 23:50 tonight", () => {
    const lateTonight = at(2026, 10, 22, 23, 50);
    expect(formatScheduledAt(at(2026, 10, 23, 0, 10), lateTonight).day).toBe("내일");
    expect(formatScheduledAt(at(2026, 10, 22, 23, 59), at(2026, 10, 22, 0, 1)).day).toBe("오늘");
  });

  it("formats the supporting date of a preset row", () => {
    expect(formatScheduledDate(at(2026, 10, 23, 9), NOW)).toBe("10월 23일 (금)");
    expect(formatScheduledDate(at(2027, 2, 1, 9), NOW)).toBe("2027년 2월 1일 (월)");
  });
});

describe("scheduledPresets: 내일 오전 9:00 and 다음 주 월요일 오전 9:00", () => {
  it("offers both from a Thursday, with the time, the supporting date and the aria sentence", () => {
    const presets = scheduledPresets(NOW);
    expect(presets.map((preset) => preset.id)).toEqual(["tomorrow", "next-monday"]);
    expect(presets.map((preset) => preset.label)).toEqual(["내일", "다음 주 월요일"]);
    expect(presets.map((preset) => preset.atMs)).toEqual([at(2026, 10, 23, 9), at(2026, 10, 26, 9)]);
    expect(presets.map((preset) => preset.time)).toEqual(["오전 9:00", "오전 9:00"]);
    expect(presets.map((preset) => preset.date)).toEqual(["10월 23일 (금)", "10월 26일 (월)"]);
    expect(presets[0]?.aria).toBe("내일 오전 9:00, 10월 23일 금요일");
    expect(presets[1]?.aria).toBe("10월 26일 월요일 오전 9:00");
  });

  it("hides 다음 주 월요일 on a Sunday: it is the same instant as 내일", () => {
    const sundayNight = at(2026, 10, 25, 23, 0);
    const presets = scheduledPresets(sundayNight);
    expect(presets.map((preset) => preset.id)).toEqual(["tomorrow"]);
    expect(presets[0]?.atMs).toBe(at(2026, 10, 26, 9));
    // 일요일 낮에도 같다.
    expect(scheduledPresets(at(2026, 10, 25, 8, 0)).map((preset) => preset.id)).toEqual(["tomorrow"]);
  });

  it("never picks today's 09:00 as 다음 주 월요일, even at 00:30 on a Monday", () => {
    const mondayEarly = at(2026, 10, 26, 0, 30);
    const presets = scheduledPresets(mondayEarly);
    expect(presets.map((preset) => preset.atMs)).toEqual([at(2026, 10, 27, 9), at(2026, 11, 2, 9)]);
  });

  it("crosses a month end: Saturday 31 October is followed by Sunday 1 November and Monday 2 November", () => {
    const presets = scheduledPresets(at(2026, 10, 31, 22, 0));
    expect(presets.map((preset) => preset.atMs)).toEqual([at(2026, 11, 1, 9), at(2026, 11, 2, 9)]);
    expect(presets.map((preset) => preset.date)).toEqual(["11월 1일 (일)", "11월 2일 (월)"]);
    // 같은 경계가 1월 31일에도 있다.
    expect(scheduledPresets(at(2026, 1, 31, 22, 0)).map((preset) => preset.atMs)).toEqual([
      at(2026, 2, 1, 9),
      at(2026, 2, 2, 9),
    ]);
    // 달 마지막 날이 일요일이면 다음 날이 곧 월요일이다.
    expect(scheduledPresets(at(2026, 11, 29, 22, 0)).map((preset) => preset.id)).toEqual(["tomorrow"]);
  });

  it("lands on the next calendar day at 09:00 from just before and just after midnight", () => {
    const fridayLate = at(2026, 10, 23, 23, 59);
    const fridayStart = at(2026, 10, 23, 0, 0);
    expect(scheduledPresets(fridayLate)[0]?.atMs).toBe(at(2026, 10, 24, 9));
    expect(scheduledPresets(fridayStart)[0]?.atMs).toBe(at(2026, 10, 24, 9));
  });

  it("counts Saturday to Monday as two local days", () => {
    const presets = scheduledPresets(at(2026, 10, 24, 18, 0));
    expect(presets.map((preset) => preset.atMs)).toEqual([at(2026, 10, 25, 9), at(2026, 10, 26, 9)]);
  });

  it("gives a year on the supporting date when the preset lands in another year", () => {
    const presets = scheduledPresets(at(2026, 12, 31, 20, 0));
    expect(presets[0]?.date).toBe("2027년 1월 1일 (금)");
    expect(presets[1]?.date).toBe("2027년 1월 4일 (월)");
  });
});

describe("validateSendAt: 1분 뒤부터, 120일 안에서 (ADR-0208 D2)", () => {
  it("accepts exactly 60 seconds and exactly 120 days: the server says 이상 and 이하", () => {
    expect(validateSendAt(NOW + SCHEDULED_MIN_LEAD_MS, NOW)).toBeNull();
    expect(validateSendAt(NOW + SCHEDULED_MAX_LEAD_MS, NOW)).toBeNull();
    expect(validateSendAt(at(2026, 10, 23, 9), NOW)).toBeNull();
  });

  it("refuses one millisecond inside the minute, the present and the past as soon", () => {
    expect(validateSendAt(NOW + SCHEDULED_MIN_LEAD_MS - 1, NOW)).toBe("soon");
    expect(validateSendAt(NOW, NOW)).toBe("soon");
    expect(validateSendAt(NOW - 1, NOW)).toBe("soon");
    expect(validateSendAt(at(2020, 1, 1, 9), NOW)).toBe("soon");
  });

  it("refuses one millisecond past 120 days as far", () => {
    expect(validateSendAt(NOW + SCHEDULED_MAX_LEAD_MS + 1, NOW)).toBe("far");
  });

  it("calls a missing or non-finite value invalid", () => {
    expect(validateSendAt(null, NOW)).toBe("invalid");
    expect(validateSendAt(Number.NaN, NOW)).toBe("invalid");
    expect(validateSendAt(Number.POSITIVE_INFINITY, NOW)).toBe("invalid");
  });

  it("answers each problem with the dialog's spec sentence", () => {
    expect(sendAtProblemSentence("soon")).toBe("1분 뒤부터 예약할 수 있어요");
    expect(sendAtProblemSentence("far")).toBe("120일 안에서 골라 주세요");
    expect(sendAtProblemSentence("invalid")).toBe("날짜와 시간을 확인해 주세요");
  });
});

describe("dialog values: 내일 오전 9:00 first, then the row's own time", () => {
  it("starts a new schedule at tomorrow 09:00, not an hour from now", () => {
    expect(defaultSendAtMs(NOW)).toBe(at(2026, 10, 23, 9));
    expect(defaultSendAtMs(NOW)).toBe(scheduledPresets(NOW)[0]?.atMs);
  });

  it("starts 시간 바꾸기·다시 예약 at the row's sendAtMs when it can still be scheduled", () => {
    const row = at(2026, 10, 26, 15, 30);
    expect(initialSendAtMs(row, NOW)).toBe(row);
  });

  it("falls back to tomorrow 09:00 when the row's time has passed or is inside the minute", () => {
    expect(initialSendAtMs(at(2026, 10, 22, 9, 0), NOW)).toBe(at(2026, 10, 23, 9));
    expect(initialSendAtMs(NOW + 30_000, NOW)).toBe(at(2026, 10, 23, 9));
    expect(initialSendAtMs(NOW + SCHEDULED_MAX_LEAD_MS + 1, NOW)).toBe(at(2026, 10, 23, 9));
    expect(initialSendAtMs(undefined, NOW)).toBe(at(2026, 10, 23, 9));
  });

  it("turns the two input fields into the time that will actually be set, and back", () => {
    expect(sendAtFromInputs("2026-10-23", "09:00")).toBe(at(2026, 10, 23, 9));
    expect(sendAtInputs(at(2026, 10, 23, 9, 5))).toEqual({ date: "2026-10-23", time: "09:05" });
    const ms = at(2026, 12, 31, 23, 59);
    const inputs = sendAtInputs(ms);
    expect(sendAtFromInputs(inputs.date, inputs.time)).toBe(ms);
  });

  it("rejects a date that does not exist instead of rolling it into the next month", () => {
    expect(sendAtFromInputs("2026-02-31", "09:00")).toBeNull();
    expect(sendAtFromInputs("2026-04-31", "09:00")).toBeNull();
    expect(sendAtFromInputs("2026-13-01", "09:00")).toBeNull();
    expect(sendAtFromInputs("", "09:00")).toBeNull();
    expect(sendAtFromInputs("2026-10-23", "")).toBeNull();
    expect(sendAtFromInputs("2026-10-23", "25:00")).toBeNull();
  });
});

describe("the time zone line", () => {
  it("writes the zone name with the UTC offset of the chosen day", () => {
    const tomorrow = at(2026, 10, 23, 9);
    expect(utcOffsetLabel(tomorrow)).toBe("UTC+9");
    expect(scheduledZoneLabel(tomorrow)).toBe("Asia/Seoul (UTC+9)");
    expect(scheduledZoneLine(tomorrow)).toBe("Asia/Seoul (UTC+9) 기준이에요");
  });

  it("lets a host inject the zone name, and falls back to the offset alone without one", () => {
    const tomorrow = at(2026, 10, 23, 9);
    expect(scheduledZoneLabel(tomorrow, "Test/Zone")).toBe("Test/Zone (UTC+9)");
    expect(scheduledZoneLabel(tomorrow, "")).toBe("UTC+9");
    expect(scheduledZoneLine(tomorrow, "")).toBe("UTC+9 기준이에요");
  });
});
