import { describe, expect, it } from "vitest";
import {
  calendarDaysBetween,
  dayDividerLabel,
  dayDividerSegments,
  dividerText,
  DIVIDER_LABEL_SIDE,
  DIVIDER_SPACE,
  recoveryDividerSegments,
  ROW_SPACE,
  unreadDividerSegments,
} from "./divider";

/**
 * 로컬 시각으로 짓는다. 이 모듈이 판정하는 것은 **달력**이지 UTC 오프셋이 아니라서,
 * 픽스처가 UTC로 서면 테스트가 실행 지역에 따라 다른 날을 말한다.
 */
function at(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0
): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

describe("calendarDaysBetween", () => {
  /**
   * 이 모듈이 존재하는 이유의 절반이 이 테스트다. 「86,400,000으로 나눈다」 구현은
   * 두 줄 다 틀린다: 2분 떨어진 두 시각이 다른 날이고, 14시간 떨어진 두 시각이
   * 같은 날이다.
   */
  it("counts midnights, not hours", () => {
    expect(calendarDaysBetween(at(2026, 8, 4, 23, 59), at(2026, 8, 5, 0, 1))).toBe(
      1
    );
    expect(calendarDaysBetween(at(2026, 8, 5, 8, 0), at(2026, 8, 5, 22, 0))).toBe(
      0
    );
  });

  it("crosses month and year boundaries", () => {
    expect(calendarDaysBetween(at(2025, 12, 31), at(2026, 1, 1))).toBe(1);
    expect(calendarDaysBetween(at(2026, 7, 31), at(2026, 8, 1))).toBe(1);
    expect(calendarDaysBetween(at(2026, 8, 5), at(2026, 8, 5))).toBe(0);
  });

  it("is signed, so a future timestamp does not read as ancient", () => {
    expect(calendarDaysBetween(at(2026, 8, 6), at(2026, 8, 5))).toBe(-1);
  });
});

describe("dayDividerSegments", () => {
  const now = at(2026, 8, 5, 14, 30);

  it("says 오늘 for any hour of today", () => {
    for (const hour of [0, 9, 14, 23]) {
      expect(dividerText(dayDividerSegments(at(2026, 8, 5, hour), now))).toBe(
        "오늘"
      );
    }
  });

  it("says 어제 across the midnight boundary, not across 24 hours", () => {
    // 20시간 전이지만 어제다.
    expect(dividerText(dayDividerSegments(at(2026, 8, 4, 18, 30), now))).toBe(
      "어제"
    );
    // 15시간 전이고 오늘이다 — 시간 차로 판정했다면 이 둘이 뒤집힌다.
    expect(dividerText(dayDividerSegments(at(2026, 8, 5, 0, 5), now))).toBe(
      "오늘"
    );
  });

  /** 그저께부터는 낱말이 아니라 날짜다 — 읽는 사람에게 산수를 시키지 않는다. */
  it("falls back to the date from two days out", () => {
    expect(dividerText(dayDividerSegments(at(2026, 8, 3), now))).toBe("8월 3일");
    expect(dividerText(dayDividerSegments(at(2026, 1, 9), now))).toBe("1월 9일");
  });

  it("adds the year only when it differs", () => {
    expect(dividerText(dayDividerSegments(at(2025, 12, 31), now))).toBe(
      "2025년 12월 31일"
    );
    expect(dividerText(dayDividerSegments(at(2026, 12, 31), now))).not.toContain(
      "년"
    );
  });

  /**
   * 이 모듈의 나머지 절반. 웹의 현행 구분선은 `data-numeric`을 라벨 **전체**에 걸어
   * 한글 음절까지 자릿폭 고정에 밀어 넣는다 — 같은 레포가 `RunClock` 독스트링에
   * 실측으로 적어 둔 결함이다("7월  29일"). 숫자만 figure여야 한다.
   */
  it("marks the figures and nothing else", () => {
    expect(dayDividerSegments(at(2025, 12, 31), now)).toEqual([
      { kind: "figure", text: "2025" },
      { kind: "prose", text: "년 " },
      { kind: "figure", text: "12" },
      { kind: "prose", text: "월 " },
      { kind: "figure", text: "31" },
      { kind: "prose", text: "일" },
    ]);
    for (const segments of [
      dayDividerSegments(at(2026, 8, 3), now),
      dayDividerSegments(at(2025, 12, 31), now),
      unreadDividerSegments(12),
      recoveryDividerSegments(4821),
    ]) {
      for (const segment of segments) {
        if (segment.kind === "figure") {
          expect(segment.text).toMatch(/^\d+$/);
        } else {
          // 산문 조각에 숫자가 섞이면 그 조각에 표지를 걸 수도, 안 걸 수도 없다.
          expect(segment.text).not.toMatch(/\d/);
        }
      }
    }
  });

  it("has no figure at all in the relative forms", () => {
    for (const atMs of [at(2026, 8, 5), at(2026, 8, 4)]) {
      expect(
        dayDividerSegments(atMs, now).some((s) => s.kind === "figure")
      ).toBe(false);
    }
  });
});

describe("dayDividerLabel", () => {
  const now = at(2026, 8, 5, 14, 30);

  /**
   * 보이는 글자와 읽히는 글자가 **일부러 다르다**. 「오늘」은 훑을 때 가장 값싼
   * 낱말이지만, 낭독으로만 들으면 어느 날인지 알려주지 않는다.
   */
  it("always speaks the absolute date, even when the eye reads 오늘", () => {
    expect(dayDividerLabel(at(2026, 8, 5, 9), now)).toBe("2026년 8월 5일, 오늘");
    expect(dayDividerLabel(at(2026, 8, 4, 9), now)).toBe("2026년 8월 4일, 어제");
    expect(dayDividerLabel(at(2025, 12, 31), now)).toBe("2025년 12월 31일");
  });

  it("differs from the visible text exactly where the relative word is", () => {
    for (const atMs of [at(2026, 8, 5), at(2026, 8, 4)]) {
      const visible = dividerText(dayDividerSegments(atMs, now));
      expect(dayDividerLabel(atMs, now)).not.toBe(visible);
      expect(dayDividerLabel(atMs, now)).toContain(visible);
    }
    // 절대 날짜만 그리는 날은 둘이 같아야 한다 — 다르면 어느 한쪽이 지어낸 것이다.
    const old = at(2026, 8, 3);
    expect(dayDividerLabel(old, now)).toContain(
      dividerText(dayDividerSegments(old, now))
    );
  });
});

describe("unread / recovery", () => {
  it("keeps the count a figure and the rest prose", () => {
    expect(unreadDividerSegments(3)).toEqual([
      { kind: "prose", text: "새 메시지 " },
      { kind: "figure", text: "3" },
      { kind: "prose", text: "개, 여기까지 읽음" },
    ]);
    expect(dividerText(unreadDividerSegments(3))).toBe(
      "새 메시지 3개, 여기까지 읽음"
    );
  });

  it("keeps seq exact — it is the server's number", () => {
    expect(dividerText(recoveryDividerSegments(4821))).toBe(
      "재연결됨, seq 4821까지 복구"
    );
  });
});

describe("두 클라가 같은 얼굴을 갖는다 (M-2)", () => {
  /**
   * 이 세 상수가 이 모듈의 계약 전부다. 값이 여기 없으면 두 클라가 각자 고르고,
   * 각자 고르면 다시 벌어진다 — M-2가 정확히 그 상태였다.
   */
  it("puts the label on one side, and that side is leading", () => {
    expect(DIVIDER_LABEL_SIDE).toBe("leading");
  });

  it("gives the day boundary more room than the in-day markers", () => {
    expect(DIVIDER_SPACE.day.blockStart).toBeGreaterThan(
      DIVIDER_SPACE.marker.blockStart
    );
    expect(DIVIDER_SPACE.day.blockEnd).toBeGreaterThan(
      DIVIDER_SPACE.marker.blockEnd
    );
  });

  it("separates author groups more than rows inside one", () => {
    expect(ROW_SPACE.betweenGroups).toBeGreaterThan(ROW_SPACE.withinGroup);
  });
});
