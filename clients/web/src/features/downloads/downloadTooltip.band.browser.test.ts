import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { TOOLTIP_CLASS, TOOLTIP_END_CLASS, TOOLTIP_SIDE_CLASS } from "@/design/ui/tooltip";

// =============================================================================
// 띠 안(셸의 상단 줄 오른쪽 자리)에 뜬 툴팁 알약의 글자가 읽힌다 (#4587).
//
// 상단 줄은 띠 범위라서 `--ink`가 on-band로 다시 묶인다(`tokens.css` 「띠 위의 글자」). 알약의 면(`--muted-soft`)은 다시 묶이지
// 않는다. 노을띠에서 on-band는 두 스킴 모두 밝은 색이라, 알약 글자가 `--ink`면 라이트에서 연회색 면 위에 거의 흰 글자가
// 얹혀 읽히지 않는다(대비 1.2:1, 실측). 알약의 글자는 `--ink-base`(기본 글자 역할)여야 한다.
// 문자열 시험은 「이 줄이 있다」만 말하므로, `tokens.css`를 Tailwind로 진짜 컴파일해 WebKit(WKWebView의 엔진)과 Chromium에 먹이고
// **계산된 색**의 대비를 잰다: 팔레트 3(노을띠는 띠가 있고 나머지 둘은 없다) × 스킴 2 × 엔진.
// 사보타주: 알약 글자를 `--ink`로 되돌리면 노을띠 라이트가 붉어진다(스크래치패드 4587/sabotage.md).
// =============================================================================

const split = (cls: string) => cls.split(/\s+/).filter(Boolean);

const CANDIDATES = [
  "app-shell",
  "app-titlebar",
  "app-titlebar-trailing",
  "app-pane",
  "relative",
  "inline-flex",
  "flex",
  "size-control-sm",
  "bg-muted-soft",
  ...split(TOOLTIP_CLASS),
  ...split(TOOLTIP_SIDE_CLASS.bottom),
  ...split(TOOLTIP_END_CLASS),
];

const PALETTES = ["dawnsky", "graphite", "noeul"] as const;
const PALETTE_CSS = (name: string) =>
  readFileSync(new URL(`../../design/themes/palettes/${name}.css`, import.meta.url), "utf8");

/** 셸(마커 `data-desktop-shell`) 상단 줄의 오른쪽 자리에 알약이 떠 있는 장면. 알약 하나는 판 안(띠 밖)에도 둔다. */
function html(css: string, palette: string): string {
  return `<!doctype html><html lang="ko" data-palette="${palette}"><head><style>${css}
${PALETTES.map(PALETTE_CSS).join("\n")}
html, body { margin: 0; }
</style></head><body>
<div id="frame" style="width:100vw;height:100vh">
  <div class="app-shell" id="shell" data-desktop-shell>
    <header class="app-titlebar" id="band" data-tauri-drag-region>
      <div class="app-titlebar-trailing" id="slot" data-tauri-drag-region>
        <span class="relative inline-flex" id="wrap">
          <button type="button" class="size-control-sm" id="btn">다운로드</button>
          <span id="tip" class="${TOOLTIP_CLASS} ${TOOLTIP_SIDE_CLASS.bottom} ${TOOLTIP_END_CLASS}">다운로드, 받는 중 2개</span>
        </span>
      </div>
    </header>
    <main class="app-pane flex min-h-0 min-w-0 flex-col" id="pane">
      <div style="position:relative;margin:80px;width:160px">
        <span id="tip-pane" class="${TOOLTIP_CLASS} ${TOOLTIP_SIDE_CLASS.bottom}">판 안의 알약</span>
      </div>
    </main>
  </div>
</div>
<div id="ref-muted-soft" class="bg-muted-soft" style="height:4px"></div>
</body></html>`;
}

/** 엔진이 돌려주는 계산된 색 문자열(rgb 계열 또는 color(srgb …))을 0..255의 [r, g, b]로 읽는다(엔진마다 직렬화가 다르다). */
function parseColor(value: string): [number, number, number] {
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value.trim());
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value.trim());
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`읽을 수 없는 색: ${value}`);
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("띠 안 툴팁 알약의 글자 대비 (#4587)", () => {
  it("파서와 대비식은 알려진 쌍에서 맞는다(시험 도구의 자기 점검)", () => {
    expect(parseColor("rgb(255, 255, 255)")).toEqual([255, 255, 255]); // design-preflight-allow: 파서 입력 형식의 픽스처(색 정의가 아니다)
    expect(parseColor("color(srgb 1 0 0)")).toEqual([255, 0, 0]);
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    // 이 시험이 막으려는 쌍: 노을띠 라이트의 밝은 on-band 글자 위 연회색 면(값은 숫자 배열로 준다).
    expect(contrast([244, 241, 234], [222, 221, 219])).toBeLessThan(1.5);
  });

  it.skipIf(ENGINES.length === 0)(
    "상단 줄 오른쪽 자리의 알약 글자는 모든 팔레트 · 스킴에서 면 위에 4.5:1 이상이고, 판 안의 알약과 같은 색이다",
    async () => {
      const css = await compileTokensCss(CANDIDATES);
      const playwright = await import("playwright");
      const problems: string[] = [];

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const palette of PALETTES) {
            for (const colorScheme of ["light", "dark"] as const) {
              const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme });
              try {
                const page = await ctx.newPage();
                await page.setContent(html(css, palette));
                const read = await page.evaluate(() => {
                  const g = (id: string) => getComputedStyle(document.getElementById(id)!);
                  const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
                  return {
                    tipColor: g("tip").color,
                    tipBackground: g("tip").backgroundColor,
                    paneColor: g("tip-pane").color,
                    paneBackground: g("tip-pane").backgroundColor,
                    mutedSoft: g("ref-muted-soft").backgroundColor,
                    // 알약이 상단 줄 안에 들어 있어도 띠 범위의 글자 역할이 실제로 적용되는 장면인지(이 시험의 전제).
                    bandInk: g("band").color,
                    tip: { right: r("tip").right, left: r("tip").left, top: r("tip").top, bottom: r("tip").bottom },
                    btn: { right: r("btn").right, bottom: r("btn").bottom },
                  };
                });
                const at = `${engine} ${palette} ${colorScheme}`;
                const ratio = contrast(parseColor(read.tipColor), parseColor(read.tipBackground));
                if (ratio < 4.5) problems.push(`${at}: 띠 안 알약 대비 ${ratio.toFixed(2)}:1 (글자 ${read.tipColor} / 면 ${read.tipBackground})`);
                if (read.tipBackground !== read.mutedSoft) {
                  problems.push(`${at}: 알약 면 ${read.tipBackground} ≠ --muted-soft ${read.mutedSoft}`);
                }
                // 띠 안과 밖의 알약은 한 부품이다: 글자도 면도 같아야 한다.
                if (read.tipColor !== read.paneColor) problems.push(`${at}: 띠 안 글자 ${read.tipColor} ≠ 판 안 글자 ${read.paneColor}`);
                if (read.tipBackground !== read.paneBackground) problems.push(`${at}: 띠 안 면 ${read.tipBackground} ≠ 판 안 면 ${read.paneBackground}`);
                // 오른쪽 끝 맞춤: 알약의 오른쪽 끝이 단추의 오른쪽 끝이고, 창 밖으로 나가지 않는다. 아래로 뜬다(단추 아래).
                if (Math.abs(read.tip.right - read.btn.right) > 0.51) problems.push(`${at}: 알약 오른쪽 ${read.tip.right} ≠ 단추 오른쪽 ${read.btn.right}`);
                if (read.tip.left < 0 || read.tip.right > 1100) problems.push(`${at}: 알약이 창 밖이다 (${read.tip.left}..${read.tip.right})`);
                if (!(read.tip.top >= read.btn.bottom)) problems.push(`${at}: 알약이 단추 아래가 아니다 (${read.tip.top} < ${read.btn.bottom})`);
                // 전제 확인: 노을띠에서는 상단 줄의 글자 역할이 실제로 on-band로 다시 묶여 있다(알약만 기본 글자로 되찾는다).
                if (palette === "noeul" && colorScheme === "light" && read.bandInk === read.tipColor) {
                  problems.push(`${at}: 전제가 깨졌다 — 상단 줄 글자(${read.bandInk})와 알약 글자가 같다(띠 범위가 적용되지 않은 장면)`);
                }
              } finally {
                await ctx.close();
              }
            }
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    90_000
  );
});
