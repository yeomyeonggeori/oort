import { describe, expect, it } from "vitest";
import { ROW_SPACE } from "../features/timeline/divider";
import { AVATAR_SIZE } from "../features/workspace/avatar";
import {
  DEFAULT_DENSITY_ID,
  DENSITY,
  DENSITY_DISPLAY_ORDER,
  DENSITY_IDS,
  DENSITY_TOUCH_FLOOR,
  normalizeDensity,
  type DensityValues,
} from "./density";

const KEYS = Object.keys(DENSITY.comfortable) as (keyof DensityValues)[];

describe("밀도 세 단계(ADR-0189 증보 1 D1)", () => {
  it("comfortable이 기본이고 세 단계다", () => {
    expect([...DENSITY_IDS].sort()).toEqual(["comfortable", "compact", "spacious"]);
    expect(DEFAULT_DENSITY_ID).toBe("comfortable");
    // 저장 목록의 첫 값이 기본이다(웹 부트 스크립트가 같은 규칙으로 읽는다).
    expect(DENSITY_IDS[0]).toBe(DEFAULT_DENSITY_ID);
  });

  it("컨트롤에 놓는 순서는 촘촘 → 기본 → 여유이고 세 단계를 한 번씩 담는다", () => {
    expect([...DENSITY_DISPLAY_ORDER]).toEqual(["compact", "comfortable", "spacious"]);
    expect([...DENSITY_DISPLAY_ORDER].sort()).toEqual([...DENSITY_IDS].sort());
  });

  it("모든 값이 compact ≤ comfortable ≤ spacious로 한 단씩 벌어진다 — 거꾸로 서지 않는다", () => {
    for (const key of KEYS) {
      expect([key, DENSITY.compact[key] <= DENSITY.comfortable[key]]).toEqual([key, true]);
      expect([key, DENSITY.comfortable[key] <= DENSITY.spacious[key]]).toEqual([key, true]);
    }
  });

  it("대화 표면의 다섯 값은 세 단계에서 서로 다른 값으로 벌어진다(목록 간격만 촘촘·기본이 같다)", () => {
    for (const key of ["messageGap", "messageGroupGap", "messageAvatar", "proseGap"] as const) {
      const values = DENSITY_IDS.map((id) => DENSITY[id][key]);
      expect([key, new Set(values).size]).toEqual([key, 3]);
    }
    // 목록 항목 간격은 현행 기본이 0이라 아래로 더 내릴 수 없다. 위로만 한 단 연다.
    expect(DENSITY.compact.listItemGap).toBe(0);
    expect(DENSITY.comfortable.listItemGap).toBe(0);
    expect(DENSITY.spacious.listItemGap).toBeGreaterThan(0);
  });

  it("spacious는 반경과 카드 안 여백을 바꾸지 않는다 — 그 규칙은 compact에만 남는다", () => {
    for (const key of [
      "cardPadding",
      "phoneCardRadius",
      "phoneRowRadius",
      "webCardRadius",
      "webRowRadius",
    ] as const) {
      expect([key, DENSITY.spacious[key]]).toEqual([key, DENSITY.comfortable[key]]);
    }
    expect(DENSITY.compact.cardPadding).toBeLessThan(DENSITY.comfortable.cardPadding);
    expect(DENSITY.compact.webRowRadius).toBeLessThan(DENSITY.comfortable.webRowRadius);
  });

  it("묶음이 바뀌는 자리는 묶음 안보다 언제나 더 열린다", () => {
    for (const id of DENSITY_IDS) {
      expect([id, DENSITY[id].messageGroupGap > DENSITY[id].messageGap]).toEqual([id, true]);
    }
  });

  it("행 사이 거리는 위 행·아래 행이 반씩 물어서 만든다 — 홀수 한 칸이 남지 않는다", () => {
    // 웹은 `--spacing-row`(행 하나가 무는 여백)를 두 번 더해 messageGap을 만든다.
    for (const id of DENSITY_IDS) {
      expect([id, DENSITY[id].messageGap % 2]).toEqual([id, 0]);
    }
  });

  it("폰 목록 행은 세 단계 모두 터치 하한 44 이상이다", () => {
    for (const id of DENSITY_IDS) expect(DENSITY[id].phoneListRow).toBeGreaterThanOrEqual(DENSITY_TOUCH_FLOOR);
    expect(DENSITY.compact.phoneListRow).toBe(DENSITY_TOUCH_FLOOR);
  });

  it("comfortable이 지금 대화 표면이 그리는 값과 같다 — 기본 모양은 바뀌지 않는다", () => {
    // 이 줄들이 「제안값」이 아니라 읽은 값이라는 증거다: 코어의 다른 정본과 한 칸씩 맞는다.
    expect(DENSITY.comfortable.messageGap).toBe(ROW_SPACE.withinGroup);
    expect(DENSITY.comfortable.messageGroupGap).toBe(ROW_SPACE.betweenGroups);
    expect(DENSITY.comfortable.messageAvatar).toBe(AVATAR_SIZE);
  });
});

describe("저장된 밀도 읽기(증보 1 D1 이행)", () => {
  it("세 이름은 그대로 읽는다 — spacious도 comfortable로 접지 않는다", () => {
    expect(normalizeDensity("comfortable")).toBe("comfortable");
    expect(normalizeDensity("compact")).toBe("compact");
    expect(normalizeDensity("spacious")).toBe("spacious");
  });

  it("옛 이름 comfy는 comfortable로 읽는다", () => {
    expect(normalizeDensity("comfy")).toBe("comfortable");
  });

  it("모르는 값은 기본값이다", () => {
    for (const raw of [undefined, null, 7, {}, [], "dense", "Compact", "SPACIOUS", ""]) {
      expect([raw, normalizeDensity(raw)]).toEqual([raw, "comfortable"]);
    }
  });

  it("읽은 값은 언제나 목록 안의 값이다", () => {
    for (const raw of [...DENSITY_IDS, "comfy", "x", 1]) {
      expect(DENSITY_IDS).toContain(normalizeDensity(raw));
    }
  });
});
