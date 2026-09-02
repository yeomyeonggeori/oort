import { describe, expect, it } from "vitest";
import {
  calendarDaysBetween,
  dayDividerLabel,
  dayDividerSegments,
  dividerText,
  DIVIDER_LABEL_SIDE,
  DIVIDER_SPACE,
  recoveryDividerLabel,
  recoveryDividerSegments,
  ROW_SPACE,
  unreadDividerLabel,
  unreadDividerSegments,
  DIVIDER_TONE,
  DIVIDER_TONE_SPEC,
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
      recoveryDividerSegments(4821, "replay"),
      recoveryDividerSegments(4821, "backfill"),
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
    expect(unreadDividerLabel(3)).toBe("새 메시지 3개, 여기까지 읽음");
  });

  /**
   * design-review C-1. 앞 판은 `재연결됨, seq 4821까지 복구`였고, 그 숫자를 지키던
   * 근거(서버 발급값이라 정확하다)는 **표지가 서는 자리**를 정당화하는 근거였지
   * 문장 속의 숫자를 정당화하는 근거가 아니었다 — 어느 행도 자기 seq를 그리지
   * 않으므로 읽는 사람에게는 대조할 대상이 없다.
   */
  it("says where, not which number — seq는 화면 문구에서 사라진다", () => {
    expect(dividerText(recoveryDividerSegments(4821, "replay"))).toBe(
      "재연결됨, 여기까지 복구"
    );
    for (const source of ["replay", "backfill"] as const) {
      const text = dividerText(recoveryDividerSegments(4821, source));
      expect(text).not.toContain("seq");
      expect(text).not.toMatch(/\d/);
    }
  });

  /**
   * 옆 표지와 같은 문법이어야 한다. 안읽음이 「…, 여기까지 읽음」인데 복구가
   * 「…, seq N까지 복구」이면, 같은 자리에 번갈아 서는 두 줄이 서로 다른 종류의
   * 말을 하는 셈이다.
   */
  it("shares the 「여기까지 …」 grammar with the unread marker", () => {
    expect(dividerText(unreadDividerSegments(3))).toContain("여기까지 읽음");
    expect(dividerText(recoveryDividerSegments(4821, "replay"))).toContain(
      "여기까지 복구"
    );
  });

  /**
   * 낭독은 위치를 볼 수 없다. 화면의 「여기까지」는 **이 줄이 서 있는 자리**가 답을
   * 마저 해서 성립하는 말이라, 소리 쪽은 그 자리를 말로 되돌려 준다. 그러면서도
   * 숫자를 다시 들이지는 않는다 — 눈으로 못 쓰는 숫자가 귀로 쓸 수 있게 되지는
   * 않는다.
   */
  it("spells the position out for the ear, still without the number", () => {
    for (const source of ["replay", "backfill"] as const) {
      const label = recoveryDividerLabel(source);
      expect(label).toContain("이 줄 위까지");
      expect(label).not.toContain("seq");
      expect(label).not.toMatch(/\d/);
    }
    expect(recoveryDividerLabel("backfill")).toContain("이미 본 메시지");
    expect(recoveryDividerLabel("replay")).not.toContain("이미 본 메시지");
  });

  /**
   * design-review D-1. 이 낱말은 폰의 `RecoveryDivider` 안에 로컬로 있었고 웹에는
   * 아예 없었다 — 같은 사실에 두 클라가 두 문장을 말했다. 판정이 여기 있으면
   * 두 화면이 같은 배열을 받으므로 갈라질 자리가 없다.
   */
  it("names the rail that healed the gap — 되읽은 구간만 그렇게 말한다", () => {
    expect(dividerText(recoveryDividerSegments(4821, "backfill"))).toBe(
      "재연결됨, 여기까지 복구 (다시 읽음)"
    );
    // 그리고 `replay`에는 붙지 않는다. 둘이 같은 문장이면 `source`가 인자인
    // 이유가 사라진다.
    expect(dividerText(recoveryDividerSegments(4821, "replay"))).not.toContain(
      "다시 읽음"
    );
  });

  it("차이가 꼬리에만 있다 — 앞부분은 두 레일이 같은 문장이다", () => {
    const replay = recoveryDividerSegments(4821, "replay");
    const backfill = recoveryDividerSegments(4821, "backfill");
    expect(backfill.slice(0, replay.length)).toEqual(replay);
    expect(backfill).toHaveLength(replay.length + 1);
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
    // 그러나 묶음 안이 8px(현행 웹)보다는 넓어야 한다 — H-7이 실측한 값이 그것이고,
    // 거기서 다섯 메시지가 한 문단으로 뭉쳤다.
    expect(ROW_SPACE.withinGroup).toBeGreaterThan(8);
    // 그리고 묶음 안이 묶음 사이를 따라잡으면 묶음이라는 개념이 사라진다.
    expect(ROW_SPACE.withinGroup).toBeLessThan(ROW_SPACE.betweenGroups);
  });
});

// ---------------------------------------------------------------------------
// 색 계약 (design-review U4-4 D-2)
//
// 값은 여기서 재지 않는다 — 그것은 각 클라의 계약 테스트가 자기 팔레트를 파싱해
// 잰다(웹: `clients/web/src/features/timeline/dividerTone.test.ts`). 여기서 잠그는
// 것은 그 테스트들이 **같은 표를 보고 있는가**이다.
// ---------------------------------------------------------------------------

describe("색 계약 (D-2)", () => {
  it("경계를 그리는 색을 가진 구분선은 안읽음 하나뿐이다", () => {
    expect(DIVIDER_TONE.unread).toBe("boundary");
    expect(DIVIDER_TONE.day).toBe("quiet");
    expect(DIVIDER_TONE.recovery).toBe("quiet");
  });

  it("경계는 라벨과 rule을 같은 색으로 칠한다 — 한 경계는 한 색이다", () => {
    expect(DIVIDER_TONE_SPEC.boundary.paintsRule).toBe(true);
    // 조용한 표지는 rule까지 물들이지 않는다. 물들이면 「그냥 선」이 아니게 된다.
    expect(DIVIDER_TONE_SPEC.quiet.paintsRule).toBe(false);
  });

  /**
   * 이 목록이 계약의 심장이다. 「경계가 무슨 색인가」는 팔레트마다 다르게 답해도
   * 되지만 「무엇이 아니어야 하는가」는 두 클라에 공통이고, 이 셋 중 하나라도
   * 빠지면 D-2가 실측한 상태(우연히 닮은 두 색)로 되돌아간다.
   */
  it("경계는 조용한 표지·에이전트 정체·위험 중 무엇과도 같지 않다", () => {
    expect([...DIVIDER_TONE_SPEC.boundary.mustDifferFrom].sort()).toEqual([
      "agent",
      "danger",
      "quiet",
    ]);
  });
});
