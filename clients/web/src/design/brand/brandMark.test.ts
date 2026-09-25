import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// =============================================================================
// oort 마크 C2-04 Bubble의 한 원본 규칙 (#2650).
//
// 기하는 scripts/brand-mark.mjs 하나에서 나온다. 거기서 SVG 정본
// (docs/brand/mark/*.svg)과 탭 파비콘이 생성되고, OortMark.tsx에는 그 path를
// 옮겨 적는다. 옮겨 적은 사본이 어긋나면 폰 홈 화면·Dock·탭과 앱 안 로고가
// 다른 마크가 된다(#2650 N-1). 이 파일은 그 어긋남을 잰다.
//
// #2732부터 앱 아이콘과 온보딩 S0의 대표 로고는 코메토 K6 플랫 얼굴이다.
// 얼굴 창의 림은 C2-04 링 그 자체여야 한다(마크와 캐릭터가 한 기하). 아래
// 「코메토」 묶음이 그것을 잰다.
// =============================================================================

const WEB_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const REPO_ROOT = join(WEB_ROOT, "..", "..");
const MARK_DIR = join(REPO_ROOT, "docs/brand/mark");

const read = (path: string) => readFileSync(path, "utf8");
const paths = (svg: string) => [...svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
const fills = (svg: string) => [...svg.matchAll(/<path fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);

function componentGeometry(optical: "small" | "display") {
  const source = read(join(WEB_ROOT, "src/design/brand/OortMark.tsx"));
  const block = source.match(new RegExp(`${optical}: \\{([\\s\\S]*?)\\n  \\}`))?.[1] ?? "";
  const ring = block.match(/ring: "([^"]+)"/)?.[1];
  const satellite = block.match(/satellite: "([^"]+)"/)?.[1];
  return [ring, satellite];
}

function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("oort 마크는 한 기하에서 나온다", () => {
  it("커밋된 SVG가 생성기 출력과 같다", () => {
    // --check는 파일을 쓰지 않고, 다르면 exit 1로 끝난다.
    expect(() =>
      execFileSync(process.execPath, [join(WEB_ROOT, "scripts/brand-mark.mjs"), "--check"], {
        stdio: "pipe",
      })
    ).not.toThrow();
  });

  it("OortMark small은 16~32px 보정판, display는 64 격자 정본과 같은 path다", () => {
    const small = paths(read(join(MARK_DIR, "oort-mark-small-black.svg")));
    const regular = paths(read(join(MARK_DIR, "oort-mark-black.svg")));
    expect(small).toHaveLength(2);
    expect(regular).toHaveLength(2);
    expect(componentGeometry("small")).toEqual(small);
    expect(componentGeometry("display")).toEqual(regular);
    expect(small).not.toEqual(regular);
  });

  it("탭 파비콘과 배경 없는 판은 OortMark small과 같은 마크다", () => {
    const small = paths(read(join(MARK_DIR, "oort-mark-small-black.svg")));
    expect(paths(read(join(WEB_ROOT, "public/favicon.svg")))).toEqual(small);
    expect(paths(read(join(WEB_ROOT, "public/oort-mark.svg")))).toEqual(small);
  });

  it("파비콘의 링과 위성은 타일 위에서 비텍스트 대비 3:1 이상이다", () => {
    const svg = read(join(WEB_ROOT, "public/favicon.svg"));
    const tile = svg.match(/<rect\b[^>]*fill="(#[0-9a-f]{6})"/)?.[1];
    const fills = [...svg.matchAll(/<path fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    expect(tile).toBeDefined();
    expect(fills).toHaveLength(2);
    for (const fill of fills) expect(contrast(fill, tile!)).toBeGreaterThanOrEqual(3);
  });

  it("index.html과 매니페스트가 가리키는 아이콘 파일이 전부 있다", () => {
    const html = read(join(WEB_ROOT, "index.html"));
    const manifest = JSON.parse(read(join(WEB_ROOT, "public/manifest.json"))) as {
      icons: Array<{ src: string }>;
    };
    const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map(
      (m) => m[1]
    );
    expect(hrefs).toEqual(["/favicon-32.png", "/favicon.svg", "/apple-touch-icon.png"]);
    for (const src of [...hrefs, ...manifest.icons.map((icon) => icon.src)]) {
      expect(existsSync(join(WEB_ROOT, "public", src)), src).toBe(true);
    }
  });
});

// ---- 코메토 K6 플랫 얼굴 (#2732) ---------------------------------------------

const KOMETTO_PARTS = ["hood", "face", "rim", "eyes", "bead"] as const;

function komettoComponent() {
  const source = read(join(WEB_ROOT, "src/design/brand/KomettoMark.tsx"));
  return KOMETTO_PARTS.map((part) => source.match(new RegExp(`\\n  ${part}: "([^"]+)"`))?.[1]);
}

/** `M{x+r} {y}A{r} {r} ...` 꼴 원 path의 중심. */
function circleCenter(d: string) {
  const m = d.match(/^M([-\d.]+) ([-\d.]+)A([-\d.]+) /);
  if (!m) throw new Error(`원이 아니다: ${d}`);
  return [Number(m[1]) - Number(m[3]), Number(m[2])];
}

describe("코메토 얼굴은 C2-04 마크와 한 기하다", () => {
  const kometto = read(join(MARK_DIR, "oort-kometto.svg"));
  const [hood, face, rim, eyes, bead] = paths(kometto);
  const markRing = paths(read(join(MARK_DIR, "oort-mark-black.svg")))[0];

  it("다섯 조각이 후드 → 얼굴 → 림 → 눈 → 구슬 순서다", () => {
    expect(paths(kometto)).toHaveLength(5);
    expect(hood).toMatch(/C/); // 후드만 자유 곡선이다
  });

  it("림은 C2-04 regular 링과 같은 꼬리·같은 구멍·같은 바깥 원이다(홈만 없다)", () => {
    // 말풍선 꼬리: 오목 모서리 → 변 → 둥근 끝 → 변 → 오목 모서리. 마크의 링 path에서
    // 첫 번째 「A1.5 1.5」부터 꼬리가 끝나는 오목 모서리까지를 잘라 그대로 찾는다.
    const tail = markRing.match(/A1\.5 1\.5 0 0 0 [^A]+L[^A]+A1\.5 1\.5 0 0 1 [^L]+L[^A]+A1\.5 1\.5 0 0 0 [-\d.]+ [-\d.]+/)?.[0];
    expect(tail, "마크 링에서 꼬리를 찾지 못했다").toBeDefined();
    expect(rim).toContain(tail!);
    // 구멍(얼굴 창)
    const hole = markRing.slice(markRing.indexOf("ZM") + 1);
    expect(rim.endsWith(hole)).toBe(true);
    // 바깥 원은 R=20 한 개. 위성 홈(A8 8)은 림에 없다.
    expect(rim).toMatch(/A20 20 0 1 1 /);
    expect(markRing).toMatch(/A8 8 /);
    expect(rim).not.toMatch(/A8 8 /);
    // 얼굴은 구멍과 같은 원이다
    expect(circleCenter(face)).toEqual(circleCenter(hole));
  });

  it("구슬은 위성과 같은 −45° 대각선 위에 있고 같은 호박색이다", () => {
    const satellite = paths(read(join(MARK_DIR, "oort-mark-black.svg")))[1];
    const [rx, ry] = circleCenter(rim.slice(rim.indexOf("ZM") + 1));
    const [sx, sy] = circleCenter(satellite);
    const [bx, by] = circleCenter(bead);
    expect(sx - rx).toBeCloseTo(-(sy - ry), 5);
    expect(bx - rx).toBeCloseTo(-(by - ry), 5);
    expect(bx - rx).toBeGreaterThan(sx - rx); // 후드 끝으로 물러났다
    // 단색 호박판의 색 = 파비콘 위성의 색 = 코메토 구슬의 색
    const amber = read(join(MARK_DIR, "oort-mark-amber.svg")).match(/<g fill="(#[0-9a-f]{6})"/)?.[1];
    expect(amber).toBeDefined();
    expect(fills(kometto)[4]).toBe(amber);
    expect(fills(read(join(WEB_ROOT, "public/favicon.svg")))[1]).toBe(amber);
  });

  it("눈 둘은 얼굴 안에 좌우 대칭으로 있다", () => {
    const [cx, cy] = circleCenter(face);
    const [left, right] = eyes.split("ZM").map((d, i) => circleCenter(i ? `M${d}` : d));
    expect(left[1]).toBe(right[1]);
    expect((left[0] + right[0]) / 2).toBe(cx);
    expect(Math.abs(left[1] - cy)).toBeLessThan(3);
  });

  it("앱 아이콘 두 판은 같은 얼굴을 싣는다", () => {
    for (const file of ["oort-app-icon.svg", "oort-app-icon-macos.svg"]) {
      const icon = read(join(MARK_DIR, file));
      expect(paths(icon), file).toEqual([hood, face, rim, eyes, bead]);
      expect(fills(icon), file).toEqual(fills(kometto));
    }
  });

  it("KomettoMark는 같은 path이고, S0 토큰은 앱 아이콘과 같은 색이다", () => {
    expect(komettoComponent()).toEqual([hood, face, rim, eyes, bead]);
    const css = read(join(WEB_ROOT, "src/design/tokens.css"));
    const token = (name: string) => css.match(new RegExp(`--onboarding-kometto-${name}:\\s*(#[0-9a-f]{6});`))?.[1];
    const [hoodFill, faceFill, rimFill, eyeFill, beadFill] = fills(kometto);
    expect(token("hood")).toBe(hoodFill);
    expect(token("face")).toBe(faceFill);
    expect(token("rim")).toBe(rimFill);
    expect(token("rim")).toBe(eyeFill);
    expect(token("bead")).toBe(beadFill);
  });

  it("얼굴 색끼리, 그리고 앱 아이콘 바탕의 모든 멈춤점과 비텍스트 대비 3:1 이상이다", () => {
    const [hoodFill, faceFill, rimFill, eyeFill, beadFill] = fills(kometto);
    expect(contrast(rimFill, faceFill)).toBeGreaterThanOrEqual(3);
    expect(contrast(eyeFill, faceFill)).toBeGreaterThanOrEqual(3);
    const icon = read(join(MARK_DIR, "oort-app-icon.svg"));
    const stops = [...icon.matchAll(/stop-color="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    expect(stops.length).toBeGreaterThanOrEqual(1);
    for (const stop of stops)
      for (const fill of [hoodFill, beadFill, rimFill])
        expect(contrast(fill, stop), `${fill} / ${stop}`).toBeGreaterThanOrEqual(3);
  });
});
