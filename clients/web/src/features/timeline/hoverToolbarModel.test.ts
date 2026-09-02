import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PICKER_EMOJI } from "@/features/emoji/EmojiPickerDialog";
import {
  HOVER_TOOLBAR_REACTION_SEED,
  HOVER_TOOLBAR_SLOT_COUNT,
  rectsIntersect,
  shouldShowHoverToolbar,
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

describe("행 배너 「닫기」와 이웃 툴바 기하 (M-6)", () => {
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
