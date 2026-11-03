import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IMAGE_CORNER,
  IMAGE_FIT_KNOWN,
  IMAGE_FIT_UNKNOWN,
  INLINE_IMAGE,
  imageCornerRadius,
  inlineImageBox,
  isCompactImage,
  type InlineImageBox,
} from "./inlineImageModel";

// #5189. 규칙의 정본은 docs/design-system/README.md §2.10 이고, 이 시험은 그 표를 그대로 옮겨
// 모델이 같은 숫자를 내는지, 규칙이 지켜야 할 성질(원본보다 안 키움 · 절벽 없음 · 절반 한계)이
// 모든 크기에서 성립하는지, 그리고 상수가 `tokens.css` 와 같은 값인지를 잰다.

const TOKENS = readFileSync(new URL("../../design/tokens.css", import.meta.url), "utf8");

function tokenPx(name: string, css: string = TOKENS): number {
  const match = css.match(new RegExp(`--${name}:\\s*(\\d+)px`));
  if (match === null) throw new Error(`tokens.css 에 --${name} 이 없다`);
  return Number(match[1]);
}

/** `@utility image-corner { border-radius: min(<상한>, <비율>%) }` 를 읽는다. */
function boxOf(width: number, height: number): InlineImageBox {
  const box = inlineImageBox({ width, height });
  if (box === null) throw new Error(`${width}x${height}: 상자가 없다`);
  return box;
}

function cornerRuleFrom(css: string): { cap: string; percent: number } {
  const block = css.match(/@utility image-corner\s*\{([^}]*)\}/);
  if (block === null) throw new Error("tokens.css 에 image-corner 유틸이 없다");
  const rule = block[1]?.match(/border-radius:\s*min\(\s*([^,]+?)\s*,\s*([\d.]+)%\s*\)/);
  if (rule === null || rule === undefined) {
    throw new Error("image-corner 가 min(상한, 비율%) 모양이 아니다");
  }
  return { cap: rule[1] as string, percent: Number(rule[2]) };
}

describe("inline image size rule (README §2.10)", () => {
  // README 표 그대로: [이름, 원본 폭, 원본 높이, 넓은 상자가 이겼는가, 표시 폭, 표시 높이]
  const TABLE: ReadonlyArray<readonly [string, number, number, boolean, number, number]> = [
    ["가로 터미널 캡처", 2072, 110, true, 1036, 55],
    ["아주 납작한 띠", 1200, 60, true, 600, 30],
    ["대시보드 판 2.5:1", 1500, 600, true, 450, 180],
    ["16:9 화면", 1920, 1080, false, 360, 203],
    ["큰 사진", 3200, 2400, false, 360, 270],
    ["정사각", 1000, 1000, false, 320, 320],
    ["긴 화면", 600, 2400, false, 80, 320],
    ["작은 조각", 240, 160, false, 240, 160],
  ];

  it.each(TABLE)("%s %i×%i → wide=%s %i×%i", (_name, w, h, wide, shownW, shownH) => {
    expect(inlineImageBox({ width: w, height: h })).toEqual({
      width: shownW,
      height: shownH,
      wide,
    });
  });

  it("does not invent a size while the natural size is unknown", () => {
    expect(inlineImageBox(null)).toBeNull();
    expect(inlineImageBox(undefined)).toBeNull();
    expect(inlineImageBox({})).toBeNull();
    expect(inlineImageBox({ width: 100 })).toBeNull();
    expect(inlineImageBox({ width: 0, height: 50 })).toBeNull();
    expect(inlineImageBox({ width: 50, height: -1 })).toBeNull();
    expect(inlineImageBox({ width: Number.NaN, height: 50 })).toBeNull();
    expect(inlineImageBox({ width: 50, height: Number.POSITIVE_INFINITY })).toBeNull();
  });

  const WIDTHS = [1, 8, 60, 240, 359, 360, 361, 640, 1000, 1200, 2072, 4000, 12000];
  const HEIGHTS = [1, 5, 30, 60, 110, 160, 179, 180, 181, 320, 600, 1080, 2400, 9000];

  it("never draws bigger than the original and never taller than 320", () => {
    for (const w of WIDTHS) {
      for (const h of HEIGHTS) {
        const box = boxOf(w, h);
        expect(box.width, `${w}x${h}`).toBeLessThanOrEqual(w);
        expect(box.height, `${w}x${h}`).toBeLessThanOrEqual(h);
        expect(box.height, `${w}x${h}`).toBeLessThanOrEqual(INLINE_IMAGE.maxHeight);
        expect(box.width, `${w}x${h}`).toBeGreaterThanOrEqual(1);
        expect(box.height, `${w}x${h}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("keeps the aspect ratio (up to the half pixel each side is rounded by)", () => {
    let measured = 0;
    for (const w of WIDTHS) {
      for (const h of HEIGHTS) {
        const box = boxOf(w, h);
        // 변 하나가 20px 아래면 반올림 0.5px 가 비율의 2.5% 를 넘어 비율을 잴 수 없다.
        if (Math.min(box.width, box.height) < 20) continue;
        measured += 1;
        const error = Math.abs(box.width / box.height - w / h) / (w / h);
        expect(error, `${w}x${h}`).toBeLessThanOrEqual(0.06);
      }
    }
    expect(measured, "비율을 잰 크기가 거의 없다: 시험이 비었다").toBeGreaterThan(30);
  });

  it("stops a wide image at half of its original width, so a 2x screen draws it 1:1", () => {
    let seen = 0;
    for (const w of WIDTHS) {
      for (const h of HEIGHTS) {
        const box = boxOf(w, h);
        if (!box.wide) continue;
        seen += 1;
        // 표시 폭 × DPR(2) ≤ 원본 폭 (반올림 1px 여유)
        expect(box.width * 2, `${w}x${h}`).toBeLessThanOrEqual(w + 1);
        expect(box.height * 2, `${w}x${h}`).toBeLessThanOrEqual(h + 1);
        expect(box.height, `${w}x${h}`).toBeLessThanOrEqual(INLINE_IMAGE.wideHeight);
      }
    }
    expect(seen, "wide 갈래를 한 번도 타지 않았다: 시험이 아무것도 재지 않았다").toBeGreaterThan(5);
  });

  it("has no size cliff where the wide box takes over (aspect 2)", () => {
    // 높이 1000 으로 두고 폭을 1500 → 3000 으로 10 씩 늘린다(가로세로비 1.5 → 3). 표시가 한 걸음에
    // 2px 넘게 뛰면 절벽이다(폭이 보통 상자에 갇혔다가 갑자기 넓어지는 모양).
    let previous = boxOf(1500, 1000);
    let sawStandard = false;
    let sawWide = false;
    for (let w = 1510; w <= 3000; w += 10) {
      const next = boxOf(w, 1000);
      expect(Math.abs(next.width - previous.width), `폭 ${w}`).toBeLessThanOrEqual(2);
      expect(Math.abs(next.height - previous.height), `폭 ${w}`).toBeLessThanOrEqual(2);
      sawStandard ||= !next.wide;
      sawWide ||= next.wide;
      previous = next;
    }
    expect(sawStandard && sawWide, "두 갈래를 다 지나가지 않았다").toBe(true);
  });

  it("gives the standard box to anything 2:1 or squarer, exactly as before", () => {
    // 변경 전 규칙: min(1, 360/w, 320/h). 가로세로비 2 이하는 한 값도 달라지지 않는다.
    for (const w of WIDTHS) {
      for (const h of HEIGHTS) {
        if (w > 2 * h) continue;
        const old = Math.min(1, INLINE_IMAGE.standardWidth / w, INLINE_IMAGE.maxHeight / h);
        const box = boxOf(w, h);
        expect(box.wide, `${w}x${h}`).toBe(false);
        expect(box.width, `${w}x${h}`).toBe(Math.max(1, Math.round(w * old)));
        expect(box.height, `${w}x${h}`).toBe(Math.max(1, Math.round(h * old)));
      }
    }
  });

  it("shows an original that already fits the standard box at its own size", () => {
    for (const [w, h] of [[240, 160], [100, 100], [360, 320], [16, 16], [300, 20]] as const) {
      expect(inlineImageBox({ width: w, height: h })).toEqual({ width: w, height: h, wide: false });
    }
  });
});

describe("compact image (hover actions stay inside the picture)", () => {
  it("is compact below 48px tall and only then", () => {
    const at = (height: number): InlineImageBox => ({ width: 600, height, wide: true });
    expect(isCompactImage(at(30))).toBe(true);
    expect(isCompactImage(at(47))).toBe(true);
    expect(isCompactImage(at(INLINE_IMAGE.compactBelow))).toBe(false);
    expect(isCompactImage(at(55))).toBe(false);
    expect(isCompactImage(null)).toBe(false);
  });

  it("calls the thin captures compact and the dashboard not", () => {
    expect(isCompactImage(inlineImageBox({ width: 1200, height: 60 }))).toBe(true);
    expect(isCompactImage(inlineImageBox({ width: 2072, height: 110 }))).toBe(false);
    expect(isCompactImage(inlineImageBox({ width: 1500, height: 600 }))).toBe(false);
  });
});

describe("image corner rule", () => {
  it("never reaches a quarter of the side it is measured on, and never passes 10px", () => {
    for (let w = 1; w <= 1100; w += 7) {
      for (let h = 1; h <= 330; h += 5) {
        const { x, y } = imageCornerRadius(w, h);
        expect(x, `${w}x${h}`).toBeLessThanOrEqual(w / 4 + 1e-9);
        expect(y, `${w}x${h}`).toBeLessThanOrEqual(h / 4 + 1e-9);
        expect(Math.max(x, y), `${w}x${h}`).toBeLessThanOrEqual(10);
        // 알약(변의 절반)과는 늘 멀다.
        expect(y / h, `${w}x${h}`).toBeLessThanOrEqual(0.25 + 1e-9);
      }
    }
  });

  it("is the old 10px on anything 40px tall or more", () => {
    expect(imageCornerRadius(1020, 54)).toEqual({ x: 10, y: 10 });
    expect(imageCornerRadius(450, 180)).toEqual({ x: 10, y: 10 });
    expect(imageCornerRadius(80, 320)).toEqual({ x: 10, y: 10 });
    expect(imageCornerRadius(320, 40)).toEqual({ x: 10, y: 10 });
  });

  it("shrinks with a thin caption instead of turning into a pill", () => {
    expect(imageCornerRadius(600, 30).y).toBe(7.5);
    expect(imageCornerRadius(360, 19.1).y).toBeCloseTo(4.775, 3);
    // 변경 전 고정 반경 10 은 높이 19 의 절반을 넘어 알약이 되었다.
    expect(10 / 19.1).toBeGreaterThan(0.5);
    expect(imageCornerRadius(360, 19.1).y / 19.1).toBeLessThan(0.5);
  });
});

describe("constants match tokens.css", () => {
  it("reads the three named measures and the radius step from the stylesheet", () => {
    expect(tokenPx("spacing-inline-image-w")).toBe(INLINE_IMAGE.standardWidth);
    expect(tokenPx("spacing-inline-image-h")).toBe(INLINE_IMAGE.maxHeight);
    expect(tokenPx("spacing-preview-frame")).toBe(INLINE_IMAGE.wideHeight);
    expect(tokenPx("radius-md")).toBe(IMAGE_CORNER.maxRadius);
  });

  it("names only classes whose measures exist in the stylesheet", () => {
    // `max-w-inline-image-w` 는 `--spacing-inline-image-w` 를 읽는다. 클래스 이름과 토큰이 따로 놀면
    // 모르는 동안의 상자가 조용히 없는 클래스(= 상한 없음)가 된다.
    for (const name of IMAGE_FIT_UNKNOWN) {
      const measure = name.replace(/^max-[wh]-/, "");
      expect(TOKENS, name).toContain(`--spacing-${measure}:`);
    }
    expect(tokenPx("spacing-inline-image-w")).toBe(INLINE_IMAGE.standardWidth);
    expect([...IMAGE_FIT_KNOWN]).toEqual(["h-auto", "max-w-full"]);
  });

  it("says in CSS what imageCornerRadius says in TS", () => {
    const rule = cornerRuleFrom(TOKENS);
    expect(rule.cap).toBe("var(--radius-md)");
    expect(rule.percent / 100).toBe(IMAGE_CORNER.maxRatio);
  });

  it("really fails when the stylesheet drifts (the reader is not vacuous)", () => {
    const drifted = TOKENS.replace("min(var(--radius-md), 25%)", "min(var(--radius-md), 50%)");
    expect(drifted).not.toBe(TOKENS);
    expect(cornerRuleFrom(drifted).percent / 100).not.toBe(IMAGE_CORNER.maxRatio);
    expect(() => cornerRuleFrom(TOKENS.replace("@utility image-corner", "@utility image-cornerx"))).toThrow();
    expect(() => tokenPx("spacing-inline-image-w", TOKENS.replace("--spacing-inline-image-w: 360px", "--spacing-inline-image-w: 380px"))).not.toThrow();
    expect(
      tokenPx("spacing-inline-image-w", TOKENS.replace("--spacing-inline-image-w: 360px", "--spacing-inline-image-w: 380px"))
    ).not.toBe(INLINE_IMAGE.standardWidth);
  });
});
