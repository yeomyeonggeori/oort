import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
// =============================================================================

const WEB_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const REPO_ROOT = join(WEB_ROOT, "..", "..");
const MARK_DIR = join(REPO_ROOT, "docs/brand/mark");

const read = (path: string) => readFileSync(path, "utf8");
const paths = (svg: string) => [...svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);

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

// ---- 코메토 레퍼런스 (#2732 R2) ------------------------------------------------
//
// 앱 아이콘과 S0 히어로는 owner가 고른 레퍼런스 래스터를 그대로 쓴다. 픽셀이
// 레퍼런스에서 파생됐는지는 scripts/render-brand-icons.mjs가 크로미움으로 잰다.
// 여기서는 그 검사가 기대는 전제를 본다: 원본이 owner 파일 그대로이고, 검사가
// 같은 해시를 고정하고, 앱 안 히어로가 그 파생 래스터를 가리킨다.

const pngHeader = (path: string) => {
  const png = readFileSync(path);
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20), colorType: png[25] };
};

describe("코메토 앱 아이콘·S0 히어로는 owner 레퍼런스에서 나온다", () => {
  const source = join(REPO_ROOT, "docs/brand/kometto/K6-flat-dark.png");
  const renderer = read(join(WEB_ROOT, "scripts/render-brand-icons.mjs"));

  it("원본은 1254 정사각 불투명이고, 렌더 검사가 그 해시를 고정한다", () => {
    const sha = createHash("sha256").update(readFileSync(source)).digest("hex");
    expect(renderer).toContain(`SOURCE_SHA256 = "${sha}"`);
    expect(pngHeader(source)).toEqual({ w: 1254, h: 1254, colorType: 2 });
  });

  it("S0 히어로는 레퍼런스에서 오려 낸 래스터를 쓴다(다시 그린 SVG가 아니다)", () => {
    const mark = read(join(WEB_ROOT, "src/design/brand/KomettoMark.tsx"));
    expect(mark).toMatch(/from "@\/assets\/brand\/kometto-badge\.png"/);
    expect(mark).not.toMatch(/<svg\b|<path\b/);
    expect(pngHeader(join(WEB_ROOT, "src/assets/brand/kometto-badge.png"))).toEqual({ w: 576, h: 576, colorType: 6 });
  });

  it("앱 아이콘을 그리던 SVG 판은 남아 있지 않다", () => {
    for (const file of ["oort-app-icon.svg", "oort-app-icon-macos.svg", "oort-kometto.svg"])
      expect(existsSync(join(MARK_DIR, file)), file).toBe(false);
  });
});
