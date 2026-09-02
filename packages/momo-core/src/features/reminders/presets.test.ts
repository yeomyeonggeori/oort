import { describe, expect, it } from "vitest";
import {
  customDueAtMs,
  localDateInputValue,
  localHourOnOffsetDay,
  localTimeInputValue,
  nextMondayLocalHour,
  reminderPresetDueAtMs,
  REMINDER_PRESETS,
} from "./presets";

function at(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute = 0
): number {
  return new Date(year, monthIndex, day, hour, minute, 0, 0).getTime();
}

describe("reminder presets", () => {
  it("names the five ADR presets in house copy", () => {
    expect(REMINDER_PRESETS.map((preset) => preset.id)).toEqual([
      "30m",
      "1h",
      "3h",
      "tomorrow-9",
      "next-monday-9",
    ]);
    expect(REMINDER_PRESETS.map((preset) => preset.label)).toEqual([
      "30분 후",
      "1시간 후",
      "3시간 후",
      "내일 오전 9시",
      "다음 주 월요일 오전 9시",
    ]);
  });

  it("offsets 30분/1시간/3시간 from the injected now", () => {
    const now = at(2026, 0, 7, 12, 0);
    expect(reminderPresetDueAtMs("30m", now) - now).toBe(30 * 60_000);
    expect(reminderPresetDueAtMs("1h", now) - now).toBe(60 * 60_000);
    expect(reminderPresetDueAtMs("3h", now) - now).toBe(3 * 60 * 60_000);
  });

  it("lands tomorrow 09:00 on the next local calendar day, including late night", () => {
    const fridayNight = at(2026, 0, 2, 22, 15);
    expect(reminderPresetDueAtMs("tomorrow-9", fridayNight)).toBe(
      at(2026, 0, 3, 9, 0)
    );
    const sundayNight = at(2026, 0, 4, 23, 0);
    expect(reminderPresetDueAtMs("tomorrow-9", sundayNight)).toBe(
      at(2026, 0, 5, 9, 0)
    );
  });

  it("does not pick today's 09:00 as 다음 주 월요일, even before 9 on a Monday", () => {
    const mondayEarly = at(2026, 0, 5, 0, 30);
    expect(reminderPresetDueAtMs("next-monday-9", mondayEarly)).toBe(
      at(2026, 0, 12, 9, 0)
    );
    expect(reminderPresetDueAtMs("tomorrow-9", mondayEarly)).toBe(
      at(2026, 0, 6, 9, 0)
    );
  });

  it("treats Sunday as still this week, so 다음 주 월요일 is tomorrow", () => {
    const sundayNight = at(2026, 0, 4, 23, 0);
    expect(reminderPresetDueAtMs("next-monday-9", sundayNight)).toBe(
      at(2026, 0, 5, 9, 0)
    );
    expect(reminderPresetDueAtMs("next-monday-9", sundayNight)).toBe(
      reminderPresetDueAtMs("tomorrow-9", sundayNight)
    );
  });

  it("counts Saturday → Monday as two local days", () => {
    const saturday = at(2026, 0, 3, 18, 0);
    expect(nextMondayLocalHour(saturday, 9)).toBe(at(2026, 0, 5, 9, 0));
    expect(localHourOnOffsetDay(saturday, 1, 9)).toBe(at(2026, 0, 4, 9, 0));
  });

  it("parses a local custom date+time and rejects broken pieces", () => {
    expect(customDueAtMs("2026-01-08", "09:30")).toBe(at(2026, 0, 8, 9, 30));
    expect(customDueAtMs("2026-13-01", "09:00")).toBeNull();
    expect(customDueAtMs("2026-01-08", "24:00")).toBeNull();
    expect(customDueAtMs("08/01/2026", "09:00")).toBeNull();
    expect(customDueAtMs("2026-01-08", "9:00")).toBeNull();
  });

  it("round-trips the native date/time input values", () => {
    const ms = at(2026, 0, 8, 9, 5);
    expect(localDateInputValue(ms)).toBe("2026-01-08");
    expect(localTimeInputValue(ms)).toBe("09:05");
  });
});
