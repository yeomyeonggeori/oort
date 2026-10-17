import { describe, expect, it } from "vitest";
import {
  PAUSE_BANNER_DND_ACTION,
  PAUSE_BANNER_DND_TITLE,
  PAUSE_BANNER_PAUSED_TITLE,
  PAUSE_BANNER_RESUME_ACTION,
  pauseBanner,
} from "./pauseBanner";

// 시험은 로컬 시계 생성자로 시각을 만든다(`pauseUntil.test.ts` 와 같은 이유 — 이 기기의 달력으로
// 세는 계약이라 에폭 상수를 박으면 시간대가 다른 CI 에서만 붉어진다). 2026-10-16 은 금요일이다.
const at = (day: number, hour: number, minute = 0, month = 10, year = 2026) =>
  new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

const NOW = at(16, 21, 7);

describe("pauseBanner — 어느 줄이 서는가 (ADR-0204 D3)", () => {
  it("일시 중지가 진행 중이면 제목·끝나는 때·단추를 한 줄로 말한다", () => {
    const banner = pauseBanner(
      { rulesReady: true, paused: true, untilMs: at(16, 21, 30) },
      NOW
    );
    expect(banner).toEqual({
      kind: "paused",
      title: "알림 일시 중지 중",
      detail: "오후 9:30까지",
      action: "다시 켜기",
      label: "알림 일시 중지 중 · 오후 9:30까지 · 다시 켜기",
      untilMs: at(16, 21, 30),
    });
  });

  it("기한 없는 행(옛 판이 만든 것)은 「기한 없음」으로 말한다", () => {
    const banner = pauseBanner({ rulesReady: true, paused: true }, NOW);
    expect(banner?.detail).toBe("기한 없음");
    expect(banner?.label).toBe("알림 일시 중지 중 · 기한 없음 · 다시 켜기");
    expect(banner?.untilMs).toBeUndefined();
  });

  it("내일 이후의 기한은 날짜가 붙은 이름으로 말한다", () => {
    expect(
      pauseBanner({ rulesReady: true, paused: true, untilMs: at(17, 9) }, NOW)?.detail
    ).toBe("내일 오전 9:00까지");
    expect(
      pauseBanner({ rulesReady: true, paused: true, untilMs: at(19, 9) }, NOW)?.detail
    ).toBe("10월 19일(월) 오전 9:00까지");
  });

  it("방해 금지에 묶여 둘 다 켜져 있어도 일시 중지 줄이 먼저다", () => {
    const banner = pauseBanner(
      {
        rulesReady: true,
        paused: true,
        untilMs: at(16, 22, 0),
        declared: "dnd",
        declaredUntilMs: at(16, 22, 0),
      },
      NOW
    );
    expect(banner?.kind).toBe("paused");
    expect(banner?.title).toBe(PAUSE_BANNER_PAUSED_TITLE);
    expect(banner?.action).toBe(PAUSE_BANNER_RESUME_ACTION);
  });

  it("일시 중지만 꺼지고 선언 상태가 아직 방해 금지이면 「상태는 아직 방해 금지예요 · 풀기」", () => {
    const banner = pauseBanner(
      { rulesReady: true, paused: false, declared: "dnd", declaredUntilMs: at(17, 9) },
      NOW
    );
    expect(banner).toEqual({
      kind: "dnd",
      title: "상태는 아직 방해 금지예요",
      action: "풀기",
      label: "상태는 아직 방해 금지예요 · 풀기",
      untilMs: at(17, 9),
    });
    expect(banner?.detail).toBeUndefined();
    expect(banner?.title).toBe(PAUSE_BANNER_DND_TITLE);
    expect(banner?.action).toBe(PAUSE_BANNER_DND_ACTION);
  });

  it("일시 중지도 방해 금지도 아니면 줄이 없다", () => {
    for (const declared of ["auto", "away", undefined] as const) {
      expect(pauseBanner({ rulesReady: true, paused: false, declared }, NOW)).toBeNull();
    }
  });

  it("규칙을 한 번도 못 읽었으면 어느 줄도 세우지 않는다(모르는 것을 말하지 않는다)", () => {
    expect(pauseBanner({ rulesReady: false, paused: true }, NOW)).toBeNull();
    expect(
      pauseBanner({ rulesReady: false, paused: false, declared: "dnd" }, NOW)
    ).toBeNull();
  });

  it("기한이 지나도 이 함수가 줄을 내리지 않는다 — 내리는 것은 서버의 새 답이다", () => {
    const banner = pauseBanner(
      { rulesReady: true, paused: true, untilMs: at(16, 20, 0) },
      NOW
    );
    expect(banner).not.toBeNull();
    expect(banner?.kind).toBe("paused");
    const dnd = pauseBanner(
      { rulesReady: true, paused: false, declared: "dnd", declaredUntilMs: at(16, 20, 0) },
      NOW
    );
    expect(dnd?.kind).toBe("dnd");
  });
});

describe("pauseBanner — 줄이 기대는 기한", () => {
  it("일시 중지 줄은 일시 중지의 기한을, 방해 금지 줄은 방해 금지의 기한을 내보낸다", () => {
    expect(
      pauseBanner({ rulesReady: true, paused: true, untilMs: at(16, 22, 0) }, NOW)?.untilMs
    ).toBe(at(16, 22, 0));
    expect(
      pauseBanner(
        { rulesReady: true, paused: false, declared: "dnd", declaredUntilMs: at(17, 9) },
        NOW
      )?.untilMs
    ).toBe(at(17, 9));
  });

  it("기한 없는 행은 기한을 내보내지 않는다(다시 물을 이유가 없다)", () => {
    expect(pauseBanner({ rulesReady: true, paused: true }, NOW)?.untilMs).toBeUndefined();
    expect(
      pauseBanner({ rulesReady: true, paused: false, declared: "dnd" }, NOW)?.untilMs
    ).toBeUndefined();
  });
});
