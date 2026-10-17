import { describe, expect, it } from "vitest";
import {
  customPauseUntil,
  customPauseUntilMessage,
  PAUSE_UNTIL_NONE_ACTION_LABEL,
  PAUSE_UNTIL_OFFLINE_REASON,
  PAUSE_UNTIL_OPTIONS,
  pauseUntilAtMs,
  pauseUntilDescription,
  pauseUntilElapsed,
  pauseUntilHint,
  pauseUntilLabel,
  pauseUntilOptions,
  pauseUntilPresetHint,
  pauseUntilStateLabel,
  pauseUntilTitle,
} from "./pauseUntil";

// 시험은 **로컬 시계 생성자**로 시각을 만든다. 서버가 아니라 이 기기의 달력으로 세는 계약이라
// 에폭 상수를 박으면 시간대가 다른 CI 에서만 붉어진다. 2026년 10월: 12 월 · 13 화 · 14 수 ·
// 15 목 · 16 금 · 17 토 · 18 일 · 19 월.
const at = (day: number, hour: number, minute = 0, month = 10, year = 2026) =>
  new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

const FRI_2107 = at(16, 21, 7);

describe("PAUSE_UNTIL_OPTIONS (ADR-0204 D2)", () => {
  it("lists the six choices in order and never offers an open-ended one", () => {
    expect(PAUSE_UNTIL_OPTIONS.map((option) => option.label)).toEqual([
      "30분",
      "1시간",
      "2시간",
      "내일 오전 9시까지",
      "다음 주 월요일 오전 9시까지",
      "직접 고르기",
    ]);
    for (const option of PAUSE_UNTIL_OPTIONS) {
      expect(option.label).not.toContain("끌 때까지");
      expect(option.label).not.toContain("기한 없음");
    }
  });
});

describe("pauseUntilAtMs", () => {
  it("counts the short choices from now, to the minute", () => {
    expect(pauseUntilAtMs("30m", FRI_2107)).toBe(FRI_2107 + 30 * 60_000);
    expect(pauseUntilAtMs("1h", FRI_2107)).toBe(FRI_2107 + 60 * 60_000);
    expect(pauseUntilAtMs("2h", FRI_2107)).toBe(FRI_2107 + 120 * 60_000);
  });

  it("ends 「내일」 at 9:00 on the calendar tomorrow", () => {
    expect(pauseUntilAtMs("tomorrow", FRI_2107)).toBe(at(17, 9));
  });

  it("counts 「내일」 from the calendar day, even in the small hours", () => {
    // 새벽 0:30 에 고르면 32시간이다 — 달력의 내일이고, 짧은 선택이 그 옆에 있다.
    expect(pauseUntilAtMs("tomorrow", at(16, 0, 30))).toBe(at(17, 9));
  });

  it("ends 「내일」 at 9:00 after the end of a month and a year", () => {
    expect(pauseUntilAtMs("tomorrow", at(31, 23, 59))).toBe(at(1, 9, 0, 11));
    expect(pauseUntilAtMs("tomorrow", at(31, 12, 0, 12))).toBe(at(1, 9, 0, 1, 2027));
  });

  it("ends 「다음 주 월요일」 at the first Monday strictly after today", () => {
    // 월 → 7일 뒤(오늘 월요일이 아니라 다음 월요일), 화 → 6, 금 → 3, 토 → 2, 일 → 1.
    expect(pauseUntilAtMs("nextMonday", at(12, 10))).toBe(at(19, 9));
    expect(pauseUntilAtMs("nextMonday", at(13, 10))).toBe(at(19, 9));
    expect(pauseUntilAtMs("nextMonday", FRI_2107)).toBe(at(19, 9));
    expect(pauseUntilAtMs("nextMonday", at(17, 10))).toBe(at(19, 9));
    expect(pauseUntilAtMs("nextMonday", at(18, 10))).toBe(at(19, 9));
  });

  it("is always in the future", () => {
    for (const day of [12, 13, 14, 15, 16, 17, 18]) {
      for (const hour of [0, 8, 9, 23]) {
        const now = at(day, hour, 59);
        for (const option of PAUSE_UNTIL_OPTIONS) {
          if (option.id === "custom") continue;
          expect(pauseUntilAtMs(option.id, now)).toBeGreaterThan(now);
        }
      }
    }
  });
});

describe("pauseUntilOptions", () => {
  it("keeps all six on a weekday", () => {
    expect(pauseUntilOptions(FRI_2107)).toHaveLength(6);
  });

  it("drops 「다음 주 월요일」 on a Sunday, when it is the same morning as 「내일」", () => {
    const sunday = at(18, 10);
    expect(pauseUntilAtMs("nextMonday", sunday)).toBe(
      pauseUntilAtMs("tomorrow", sunday)
    );
    expect(pauseUntilOptions(sunday).map((option) => option.id)).toEqual([
      "30m",
      "1h",
      "2h",
      "tomorrow",
      "custom",
    ]);
  });
});

describe("pauseUntilLabel (ADR-0204 D3 「오후 9:30까지」)", () => {
  it("names a same-day end by the clock alone, on a 12-hour clock", () => {
    expect(pauseUntilLabel(at(16, 21, 30), FRI_2107)).toBe("오후 9:30까지");
    expect(pauseUntilLabel(at(16, 21, 37), FRI_2107)).toBe("오후 9:37까지");
  });

  it("reads noon and midnight as 12, not 0", () => {
    expect(pauseUntilLabel(at(16, 12, 0), at(16, 9))).toBe("오후 12:00까지");
    expect(pauseUntilLabel(at(16, 0, 5), at(16, 0, 1))).toBe("오전 12:05까지");
    expect(pauseUntilLabel(at(16, 9, 5), at(16, 8))).toBe("오전 9:05까지");
  });

  it("says 「내일」 for the next calendar day and adds the date after that", () => {
    expect(pauseUntilLabel(at(17, 9), FRI_2107)).toBe("내일 오전 9:00까지");
    expect(pauseUntilLabel(at(19, 9), FRI_2107)).toBe("10월 19일(월) 오전 9:00까지");
  });

  it("adds the year only when it is not this year", () => {
    expect(pauseUntilLabel(at(3, 9, 0, 1, 2027), FRI_2107)).toBe(
      "2027년 1월 3일(일) 오전 9:00까지"
    );
  });

  it("counts a late-night end as tomorrow when the clock crossed midnight", () => {
    expect(pauseUntilLabel(at(17, 0, 30), at(16, 23, 50))).toBe("내일 오전 12:30까지");
  });
});

describe("pauseUntilStateLabel", () => {
  it("names a running deadline, and the open-ended row 「기한 없음」", () => {
    expect(pauseUntilStateLabel(at(16, 21, 30), FRI_2107)).toBe("오후 9:30까지");
    expect(pauseUntilStateLabel(undefined, FRI_2107)).toBe("기한 없음");
    expect(PAUSE_UNTIL_NONE_ACTION_LABEL).toBe("기한 없음 · 기한 정하기");
  });
});

describe("pauseUntilHint", () => {
  it("shows the end clock for the short choices and only the date for the named mornings", () => {
    expect(pauseUntilHint("30m", FRI_2107)).toBe("오후 9:37까지");
    expect(pauseUntilHint("2h", FRI_2107)).toBe("오후 11:07까지");
    // 자정을 넘으면 「내일」이 붙는다 — 「오전 12:30까지」만 있으면 오늘 새벽으로 읽힌다.
    expect(pauseUntilHint("2h", at(16, 22, 30))).toBe("내일 오전 12:30까지");
    expect(pauseUntilHint("tomorrow", FRI_2107)).toBe("10월 17일(토)");
    expect(pauseUntilHint("nextMonday", FRI_2107)).toBe("10월 19일(월)");
  });
});

describe("customPauseUntil", () => {
  it("accepts a future date and time", () => {
    expect(customPauseUntil("2026-10-17", "21:30", FRI_2107)).toEqual({
      ok: true,
      atMs: at(17, 21, 30),
    });
  });

  it("refuses a time that is not after now", () => {
    expect(customPauseUntil("2026-10-16", "21:07", FRI_2107)).toEqual({
      ok: false,
      reason: "past",
    });
    expect(customPauseUntil("2026-10-15", "23:59", FRI_2107)).toEqual({
      ok: false,
      reason: "past",
    });
  });

  it("refuses text that is not a date and a time", () => {
    for (const [date, time] of [
      ["", "21:30"],
      ["2026-10-17", ""],
      ["10/17", "21:30"],
      ["2026-13-01", "21:30"],
      ["2026-10-17", "24:00"],
      ["2026-10-17", "21:60"],
    ]) {
      expect(customPauseUntil(date, time, FRI_2107)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });

  it("refuses a day the month does not have, instead of rolling into the next month", () => {
    // `customExpiryAtMs` 는 2월 31일을 3월 3일로 굴린다 — 다른 날 오전에 멈추는 쪽이 사고다.
    expect(customPauseUntil("2026-11-31", "09:00", FRI_2107)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("words both refusals as a request, in the polite register", () => {
    expect(customPauseUntilMessage("past")).toBe(
      "지난 시각은 고를 수 없어요. 다른 시각을 고르세요."
    );
    expect(customPauseUntilMessage("invalid")).toBe("날짜와 시각을 확인하세요.");
  });
});

describe("titles and descriptions", () => {
  it("says the alerts stop together on the do-not-disturb page only", () => {
    expect(pauseUntilTitle("pause")).toBe("알림을 언제까지 멈출까요?");
    expect(pauseUntilTitle("dnd")).toBe("방해 금지를 언제까지 켤까요?");
    expect(pauseUntilDescription("dnd")).toContain("알림도 함께 멈춰요");
    expect(pauseUntilDescription("pause")).not.toContain("방해 금지");
  });

  it("hints that a preset row turns the switch on at once, per switch", () => {
    // 누르면 곧바로 켜진다 — 확인 단계가 없다는 것을 읽어 줘야 하는 줄이다.
    expect(pauseUntilPresetHint("pause")).toBe("누르면 이 시각까지 알림을 멈춰요.");
    expect(pauseUntilPresetHint("dnd")).toBe("누르면 이 시각까지 방해 금지를 켜요.");
  });
});

describe("pauseUntilElapsed — 서버에 다시 물을 때", () => {
  it("기한이 지났으면 참이다(지금과 같은 시각도 지난 것이다)", () => {
    expect(pauseUntilElapsed(at(16, 21, 6), FRI_2107)).toBe(true);
    expect(pauseUntilElapsed(FRI_2107, FRI_2107)).toBe(true);
  });

  it("아직 오지 않았거나 기한이 없으면 거짓이다", () => {
    expect(pauseUntilElapsed(at(16, 21, 8), FRI_2107)).toBe(false);
    expect(pauseUntilElapsed(undefined, FRI_2107)).toBe(false);
  });
});

describe("연결이 끊겼을 때의 이유", () => {
  it("해요체로 이유를 말한다", () => {
    expect(PAUSE_UNTIL_OFFLINE_REASON).toBe("연결이 끊겨 지금은 바꿀 수 없어요.");
  });
});
