import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatScheduledAt,
  scheduledPresets,
  scheduledZoneLabel,
  sendAtFromInputs,
  sendAtInputs,
  utcOffsetLabel,
} from "./presets";

// =============================================================================
// 서머타임·UTC 오프셋이 다른 시간대의 시험. 시간대를 `vi.stubEnv("TZ", …)`로 바꾼다.
//
// 시간대가 정말 바뀌었는지를 **각 시험의 첫 단정**으로 잰다(1월 15일 정오의 오프셋). 안 바뀌었는데
// 초록이 나오는 시험은 서머타임을 하나도 재지 않는다. `getTimezoneOffset()`은 JS 규약대로
// UTC보다 **늦은** 시간대가 양수다(뉴욕 겨울 +300, 서울 -540).
// =============================================================================

afterEach(() => {
  vi.unstubAllEnvs();
});

function useZone(zone: string, januaryOffsetMinutes: number): void {
  vi.stubEnv("TZ", zone);
  expect(new Date(2026, 0, 15, 12, 0).getTimezoneOffset(), `${zone}가 적용됐다`).toBe(januaryOffsetMinutes);
}

function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

describe("presets across a daylight-saving change (America/New_York)", () => {
  it("lands tomorrow 09:00 on the spring-forward day at 09:00 local, 20 hours after Saturday noon", () => {
    useZone("America/New_York", 300);
    const saturdayNoon = at(2026, 3, 7, 12, 0);
    const tomorrow = scheduledPresets(saturdayNoon)[0];
    // 3월 8일 02:00에 시계가 한 시간 앞으로 간다. 09:00은 이미 EDT(UTC-4)다.
    expect(iso(tomorrow?.atMs)).toBe("2026-03-08T13:00:00.000Z");
    expect((tomorrow?.atMs ?? 0) - saturdayNoon).toBe(20 * 3_600_000);
    expect(tomorrow?.time).toBe("오전 9:00");
  });

  it("lands tomorrow 09:00 on the fall-back day at 09:00 local, in the 25-hour day", () => {
    useZone("America/New_York", 300);
    const saturdayEvening = at(2026, 10, 31, 18, 0);
    // 11월 1일 02:00에 시계가 한 시간 뒤로 간다. 09:00은 EST(UTC-5)다.
    expect(iso(scheduledPresets(saturdayEvening)[0]?.atMs)).toBe("2026-11-01T14:00:00.000Z");
  });

  it("keeps 09:00 local for 다음 주 월요일 when the week crosses the change", () => {
    useZone("America/New_York", 300);
    const thursday = at(2026, 3, 5, 12, 0);
    const presets = scheduledPresets(thursday);
    expect(presets.map((preset) => iso(preset.atMs))).toEqual([
      "2026-03-06T14:00:00.000Z", // 금요일 09:00 EST
      "2026-03-09T13:00:00.000Z", // 월요일 09:00 EDT
    ]);
    expect(presets.map((preset) => preset.time)).toEqual(["오전 9:00", "오전 9:00"]);
  });

  it("still hides 다음 주 월요일 on the Sunday of the change", () => {
    useZone("America/New_York", 300);
    const springForwardSunday = at(2026, 3, 8, 8, 0);
    const presets = scheduledPresets(springForwardSunday);
    expect(presets.map((preset) => preset.id)).toEqual(["tomorrow"]);
    expect(iso(presets[0]?.atMs)).toBe("2026-03-09T13:00:00.000Z");
  });

  it("names 내일 and 모레 by calendar day, not by blocks of 24 hours, across the change", () => {
    useZone("America/New_York", 300);
    // 토 22:00 → 월 00:10은 25시간 10분이지만 이틀 뒤(모레)다. 24시간 몫으로 세면 「내일」이 된다.
    expect(formatScheduledAt(at(2026, 3, 9, 0, 10), at(2026, 3, 7, 22, 0)).day).toBe("모레");
    // 일 00:30 → 월 00:10은 22시간 40분이지만 다음 날(내일)이다. 24시간 몫으로 세면 「오늘」이 된다.
    expect(formatScheduledAt(at(2026, 3, 9, 0, 10), at(2026, 3, 8, 0, 30)).day).toBe("내일");
    // 토 22:00 → 일 09:00은 10시간 뒤이지만 날짜는 내일이다.
    expect(formatScheduledAt(at(2026, 3, 8, 9, 0), at(2026, 3, 7, 22, 0)).full).toBe("내일 오전 9:00");
  });
});

describe("a custom time that does not exist or happens twice (America/New_York)", () => {
  it("shifts the spring-forward gap (02:30) forward to 03:30 and shows the time that will really be set", () => {
    useZone("America/New_York", 300);
    const ms = sendAtFromInputs("2026-03-08", "02:30");
    // 02:30은 그 날 존재하지 않는다. 결과 문장은 입력한 칸이 아니라 이 값에서 그려야 한다.
    expect(iso(ms ?? undefined)).toBe("2026-03-08T07:30:00.000Z");
    expect(sendAtInputs(ms ?? 0)).toEqual({ date: "2026-03-08", time: "03:30" });
    expect(formatScheduledAt(ms ?? 0, at(2026, 3, 7, 12, 0)).full).toBe("내일 오전 3:30");
  });

  it("reads the repeated fall-back hour (01:30) as its first occurrence, deterministically", () => {
    useZone("America/New_York", 300);
    const ms = sendAtFromInputs("2026-11-01", "01:30");
    expect(iso(ms ?? undefined)).toBe("2026-11-01T05:30:00.000Z");
    expect(sendAtFromInputs("2026-11-01", "01:30")).toBe(ms);
  });
});

describe("a southern-hemisphere change (Australia/Sydney)", () => {
  it("lands tomorrow 09:00 at AEDT on the Sunday the clocks go forward", () => {
    useZone("Australia/Sydney", -660);
    const saturdayNight = at(2026, 10, 3, 22, 0);
    expect(iso(scheduledPresets(saturdayNight)[0]?.atMs)).toBe("2026-10-03T22:00:00.000Z");
  });
});

describe("the UTC offset of the chosen day", () => {
  it("is written per day: New York is UTC-5 in January and UTC-4 in July", () => {
    useZone("America/New_York", 300);
    expect(utcOffsetLabel(at(2026, 1, 15, 9))).toBe("UTC-5");
    expect(utcOffsetLabel(at(2026, 7, 15, 9))).toBe("UTC-4");
  });

  it("follows the chosen day, not today: the zone line of a July day says UTC-4 while it is January", () => {
    useZone("America/New_York", 300);
    expect(scheduledZoneLabel(at(2026, 7, 15, 9))).toBe("America/New_York (UTC-4)");
    expect(scheduledZoneLabel(at(2026, 1, 15, 9))).toBe("America/New_York (UTC-5)");
  });

  it("writes half-hour and quarter-hour zones with the minutes", () => {
    useZone("Asia/Kolkata", -330);
    expect(utcOffsetLabel(at(2026, 10, 23, 9))).toBe("UTC+5:30");
    useZone("Asia/Kathmandu", -345);
    expect(utcOffsetLabel(at(2026, 10, 23, 9))).toBe("UTC+5:45");
    // 서쪽의 반 시간대: 뉴펀들랜드는 겨울 UTC-3:30, 여름 UTC-2:30.
    useZone("America/St_Johns", 210);
    expect(utcOffsetLabel(at(2026, 1, 15, 9))).toBe("UTC-3:30");
    expect(utcOffsetLabel(at(2026, 7, 15, 9))).toBe("UTC-2:30");
  });

  it("writes UTC itself as UTC+0 and a zone ahead of it with a plus sign", () => {
    useZone("UTC", 0);
    expect(utcOffsetLabel(at(2026, 10, 23, 9))).toBe("UTC+0");
    useZone("Europe/London", 0);
    expect(utcOffsetLabel(at(2026, 1, 15, 9))).toBe("UTC+0");
    expect(utcOffsetLabel(at(2026, 7, 15, 9))).toBe("UTC+1");
  });
});
