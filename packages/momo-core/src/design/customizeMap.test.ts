import { describe, expect, it } from "vitest";
import {
  APPEARANCE_LAYOUT,
  CUSTOMIZE_ITEM_IDS,
  CUSTOMIZE_MAP,
  acceptsCustomizeValue,
  appearancePlace,
  customizeItem,
  type CustomizeShape,
} from "./customizeMap";

// 꾸미기 지도(#6085)의 두 계약: ① 값 모양은 모두 닫혀 있다(자유 글 · 주소 · CSS를 받는 항목 0) ② 모양 페이지의
// 자리 표(`APPEARANCE_LAYOUT`)와 항목 표가 서로를 빠짐없이 가리킨다. 화면의 줄과 자리 표가 같다는 것은 웹
// `customizeMapBinding.test.tsx`가 실제로 그려서 잰다.

/** 바깥(테마 파일 · 에이전트 제안)에서 들어올 수 있는 나쁜 값. 어느 모양도 받으면 안 된다. */
const HOSTILE: readonly unknown[] = [
  "url(https://evil.example/x.png)",
  "https://evil.example/theme",
  "javascript:alert(1)",
  "data:image/svg+xml,<svg onload=alert(1)>",
  "red; background: url(x)",
  "var(--signal)",
  "expression(alert(1))",
  "</style><script>alert(1)</script>",
  "@import 'x.css'",
  { kind: "image", url: "https://evil.example/x.png" },
  { kind: "preset", id: "saebyeok", css: "background:red" },
  { code: "KeyK", shift: false, alt: false, script: "x" },
  undefined,
  {},
  [],
];

/** 모양마다 받아야 하는 값(판정이 「전부 거절」로 통과하지 못하게). */
function goodValues(shape: CustomizeShape): unknown[] {
  switch (shape.kind) {
    case "choice":
      return [...shape.options];
    case "toggle":
      return [true, false];
    case "percent":
      return [shape.min, shape.max];
    case "themeRef":
      return ["dawnsky", "catalog:nord"];
    case "wallpaper":
      return [null, { kind: "solid", id: shape.solids[0] }, { kind: "preset", id: shape.presets[0] }, { kind: "image", width: 2560, height: 1600, rev: 3 }];
    case "fontName":
      return ["Pretendard", "D2Coding", "Noto Sans KR"];
    case "keyCombo":
      return [{ code: "KeyK", shift: false, alt: false }, { code: "F12", shift: true, alt: true }];
    case "hexColor":
      return ["#3b5bdb"];
  }
}

const SHAPED = CUSTOMIZE_ITEM_IDS.flatMap((id) => {
  const shape = customizeItem(id).shape;
  return shape ? [{ id, shape }] : [];
});

describe("꾸미기 지도: 값 모양은 모두 닫혀 있다", () => {
  it("모든 live 항목이 모양을 가진다", () => {
    const live = CUSTOMIZE_ITEM_IDS.filter((id) => CUSTOMIZE_MAP[id].status === "live");
    expect(live.length).toBeGreaterThan(0);
    for (const id of live) expect(customizeItem(id).shape, id).toBeDefined();
  });

  it.each(SHAPED)("$id: 주소 · CSS · 모르는 열쇠를 받지 않고, 제 값은 받는다", ({ shape }) => {
    for (const bad of HOSTILE) expect(acceptsCustomizeValue(shape, bad), JSON.stringify(bad)).toBe(false);
    for (const good of goodValues(shape)) expect(acceptsCustomizeValue(shape, good), JSON.stringify(good)).toBe(true);
  });

  it("경계: 범위 밖 퍼센트 · 카탈로그에 없는 테마 · 목록 밖 배경 · 닫힌 키 밖은 받지 않는다", () => {
    const { glassOpacity, theme, wallpaper, shortcuts, fontSans } = CUSTOMIZE_MAP;
    expect(acceptsCustomizeValue(glassOpacity.shape, glassOpacity.shape.max + 1)).toBe(false);
    expect(acceptsCustomizeValue(glassOpacity.shape, 50.5)).toBe(false);
    expect(acceptsCustomizeValue(theme.shape, "catalog:not-a-theme")).toBe(false);
    expect(acceptsCustomizeValue(theme.shape, "user:mine")).toBe(false);
    expect(acceptsCustomizeValue(wallpaper.shape, { kind: "solid", id: "neon" })).toBe(false);
    expect(acceptsCustomizeValue(shortcuts.shape, { code: "Space", shift: false, alt: false })).toBe(false);
    expect(acceptsCustomizeValue(fontSans.shape, "x".repeat(fontSans.shape.max + 1))).toBe(false);
  });
});

describe("꾸미기 지도: 모양 페이지의 자리 표", () => {
  const layoutItems = APPEARANCE_LAYOUT.flatMap((card) => card.rows.flatMap((row) => ("item" in row ? [row.item] : [])));

  it("자리 표의 줄은 모두 모양 갈래의 live 항목을 가리킨다", () => {
    for (const id of layoutItems) {
      expect(CUSTOMIZE_MAP[id].status, id).toBe("live");
      expect(CUSTOMIZE_MAP[id].settings, id).toBe("appearance");
    }
  });

  it("모양 갈래의 live 항목은 모두 자리 표에 줄이 있다", () => {
    const live = CUSTOMIZE_ITEM_IDS.filter((id) => CUSTOMIZE_MAP[id].status === "live" && CUSTOMIZE_MAP[id].settings === "appearance");
    expect(new Set(layoutItems)).toEqual(new Set(live));
    for (const id of live) expect(appearancePlace(id), id).not.toBeNull();
  });

  it("anchor는 페이지 안에서 겹치지 않는다", () => {
    const anchors = APPEARANCE_LAYOUT.flatMap((card) => card.rows.map((row) => row.anchor));
    expect(new Set(anchors).size).toBe(anchors.length);
  });
});
