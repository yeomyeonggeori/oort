import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PICKER_EMOJI } from "@/features/emoji/EmojiPickerDialog";
import { HOVER_TOOLBAR_NEIGHBOR_SELECTOR } from "../../../scripts/lib/hoverToolbarOverlap.mjs";
import {
  belowStraddleRect,
  HOVER_TOOLBAR_REACTION_SEED,
  HOVER_TOOLBAR_SLOT_COUNT,
  rectsIntersect,
  shouldFlipToolbarBelow,
  shouldShowHoverToolbar,
  TOOLBAR_NEIGHBOR_SELECTOR,
  toolbarClipsScrollerTop,
} from "./hoverToolbarModel";

const actionsSource = readFileSync(
  fileURLToPath(new URL("./MessageActions.tsx", import.meta.url)),
  "utf8"
);

describe("shouldShowHoverToolbar", () => {
  const rest = {
    pointerCanHover: true,
    editing: false,
    rowHovered: false,
    rowFocused: false,
    overlayOpen: false,
    selecting: false,
  };

  it("비호버·비포커스 행에는 안 뜬다", () => {
    expect(shouldShowHoverToolbar(rest)).toBe(false);
  });

  it("hover 또는 focus-within 이면 뜬다", () => {
    expect(shouldShowHoverToolbar({ ...rest, rowHovered: true })).toBe(true);
    expect(shouldShowHoverToolbar({ ...rest, rowFocused: true })).toBe(true);
  });

  it("열린 오버레이가 있으면 포인터가 떠나도 유지한다", () => {
    expect(
      shouldShowHoverToolbar({ ...rest, overlayOpen: true })
    ).toBe(true);
  });

  it("본문 선택은 툴바를 내린다", () => {
    expect(
      shouldShowHoverToolbar({ ...rest, rowHovered: true, selecting: true })
    ).toBe(false);
  });

  it("선택은 열린 오버레이를 이기지 못한다", () => {
    expect(
      shouldShowHoverToolbar({
        ...rest,
        selecting: true,
        overlayOpen: true,
      })
    ).toBe(true);
  });

  it("이웃 행 배너가 열려 있으면 툴바를 달지 않는다", () => {
    expect(
      shouldShowHoverToolbar({ ...rest, rowHovered: true, neighborBannerOpen: true })
    ).toBe(false);
    expect(
      shouldShowHoverToolbar({
        ...rest,
        overlayOpen: true,
        neighborBannerOpen: true,
      })
    ).toBe(false);
  });

  it("터치와 편집 중에는 절대 안 뜬다", () => {
    expect(
      shouldShowHoverToolbar({ ...rest, pointerCanHover: false, rowHovered: true })
    ).toBe(false);
    expect(
      shouldShowHoverToolbar({ ...rest, editing: true, rowHovered: true })
    ).toBe(false);
    expect(
      shouldShowHoverToolbar({
        ...rest,
        pointerCanHover: false,
        overlayOpen: true,
      })
    ).toBe(false);
  });
});

describe("행 배너 「닫기」와 이웃 툴바 기하 (M-6, geometry-probe-only)", () => {
  it("probe 400 배너의 「닫기」와 위 straddle 툴바가 겹치면 실패한다", () => {
    const close = { left: 1840, right: 1973, top: 674, bottom: 706 };
    const toolbar = { left: 1693, right: 1973, top: 700, bottom: 750 };
    expect(rectsIntersect(close, toolbar)).toBe(true);
  });

  it("배너 아래에 스트래들 띠를 비우면 「닫기」와 툴바가 겹치지 않는다", () => {
    const close = { left: 1840, right: 1973, top: 642, bottom: 674 };
    const toolbar = { left: 1693, right: 1973, top: 700, bottom: 750 };
    expect(rectsIntersect(close, toolbar)).toBe(false);
  });

});

describe("toolbarClipsScrollerTop", () => {
  it("스크롤러 높이가 없으면 뒤집지 않는다", () => {
    expect(
      toolbarClipsScrollerTop({ top: -10 }, { top: 0, height: 0 })
    ).toBe(false);
  });

  it("툴바 상단이 스크롤러 상단을 침범하면 뒤집는다", () => {
    expect(
      toolbarClipsScrollerTop({ top: 18 }, { top: 45, height: 700 })
    ).toBe(true);
  });

  it("여유가 있으면 위 straddle을 유지한다", () => {
    expect(
      toolbarClipsScrollerTop({ top: 80 }, { top: 45, height: 700 })
    ).toBe(false);
  });
});

// 390 열의 숫자 그대로(#5179 레인 실측): 막대 x 151~374, 위 자리 y 329~371(키 42), 포인터 행 y 365~399, 앞 행 마지막 줄 x 56~214 y 337~355.
describe("shouldFlipToolbarBelow (#5179)", () => {
  const bar = { left: 151, right: 374, top: 329, bottom: 371 };
  const row = { top: 365, bottom: 399 };
  const scroller = { top: 120, bottom: 800, height: 680 };
  const reaching = { left: 56, right: 214, top: 337, bottom: 355 };
  const short = { left: 56, right: 121, top: 337, bottom: 355 };
  const nextHead = { left: 56, right: 150, top: 415, bottom: 433 };
  const nextLong = { left: 56, right: 360, top: 410, bottom: 428 };
  const never = () => {
    throw new Error("이 이웃은 재면 안 된다");
  };

  it("아래 자리는 위 자리와 같은 산식으로 선다: 행 하단에서 행 안 깊이만큼 위", () => {
    // 위 자리의 막대 하단이 행 안으로 6 들어온다 → 아래 자리의 상단은 행 하단 − 6, 키는 그대로.
    expect(belowStraddleRect(bar, row)).toEqual({ left: 151, right: 374, top: 393, bottom: 435 });
  });

  it("앞 이웃 글자에 안 닿으면 위 그대로이고 뒤 이웃은 재지도 않는다", () => {
    expect(shouldFlipToolbarBelow({ bar, row, scroller, prevText: () => [short], nextText: never })).toBe(false);
    expect(shouldFlipToolbarBelow({ bar, row, scroller, prevText: () => [], nextText: never })).toBe(false);
  });

  it("앞 이웃 마지막 줄을 덮고 아래 자리는 뒤 이웃 글자를 안 덮으면 아래로 뒤집는다", () => {
    expect(shouldFlipToolbarBelow({ bar, row, scroller, prevText: () => [reaching], nextText: () => [nextHead] })).toBe(true);
  });

  it("아래로 뒤집으면 뒤 이웃 글자를 새로 덮을 때는 위 그대로다(한 겹침을 다른 겹침으로 바꾸지 않는다)", () => {
    expect(shouldFlipToolbarBelow({ bar, row, scroller, prevText: () => [reaching], nextText: () => [nextLong] })).toBe(false);
  });

  it("아래 자리가 스크롤러 아래로 잘리면 위 그대로다", () => {
    const tight = { top: 120, bottom: 420, height: 300 };
    expect(shouldFlipToolbarBelow({ bar, row, scroller: tight, prevText: () => [reaching], nextText: () => [] })).toBe(false);
  });

  it("위가 스크롤러 위에 막히면 이웃을 재기 전에 뒤집는다(옛 규칙 H-4가 먼저)", () => {
    const clipped = { top: 340, bottom: 800, height: 460 };
    expect(shouldFlipToolbarBelow({ bar, row, scroller: clipped, prevText: never, nextText: never })).toBe(true);
  });

  it("행을 못 찾으면(타임라인 밖) 이웃 글자는 보지 않고 위 그대로다", () => {
    expect(shouldFlipToolbarBelow({ bar, row: null, scroller, prevText: never, nextText: never })).toBe(false);
  });
});

describe("이웃 목록 (#5179)", () => {
  it("뒤집기 규칙의 이웃 목록은 겹침 단정의 자와 같은 목록이다(자가 본 칸을 규칙도 본다)", () => {
    expect(TOOLBAR_NEIGHBOR_SELECTOR).toBe(HOVER_TOOLBAR_NEIGHBOR_SELECTOR);
  });
});

describe("슬롯 시드", () => {
  it("큐레이션 3종은 피커 어휘 안에 있다", () => {
    expect(HOVER_TOOLBAR_REACTION_SEED).toHaveLength(HOVER_TOOLBAR_SLOT_COUNT);
    for (const glyph of HOVER_TOOLBAR_REACTION_SEED) {
      expect(PICKER_EMOJI).toContain(glyph);
    }
  });
});

describe("B11 리버트 원인 — 소스 계약", () => {
  it("툴바는 단일 frequency store 를 쓰고 새 store 를 만들지 않는다", () => {
    expect(actionsSource).toContain("useFrequentEmojis");
    expect(actionsSource).toContain("HOVER_TOOLBAR_REACTION_SEED");
    expect(actionsSource).not.toContain("localStorage");
  });

  it("MessageHoverToolbar 본체는 opacity/visibility 트릭을 쓰지 않는다", () => {
    const start = actionsSource.indexOf("export function MessageHoverToolbar");
    expect(start).toBeGreaterThan(0);
    const next = actionsSource.indexOf("\nexport function", start + 1);
    const body = actionsSource.slice(start, next === -1 ? undefined : next);
    expect(body).not.toMatch(/opacity-0|invisible|visibility-hidden/);
    expect(body).toContain('role="toolbar"');
    expect(body).toContain("data-toolbar-item");
    expect(body).not.toContain("stopPropagation");
  });
});
