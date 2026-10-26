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
  "bg-primary",
  "channel-head",
  "items-center",
  "justify-end",
  "py-row-fixed",
  "min-h-0",
  "min-w-0",
  "flex-col",
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
      <header class="channel-head flex min-w-0 items-center justify-end py-row-fixed" id="head">
        <span id="hb1" class="bg-primary" style="display:block;inline-size:34px;block-size:34px;margin-inline-start:8px"></span>
        <span id="hb2" class="bg-primary" style="display:block;inline-size:34px;block-size:34px;margin-inline-start:8px"></span>
        <span id="hb3" class="bg-primary" style="display:block;inline-size:34px;block-size:34px;margin-inline-start:8px"></span>
        <span id="hb4" class="bg-primary" style="display:block;inline-size:34px;block-size:34px;margin-inline-start:8px"></span>
      </header>
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

type Rgb = [number, number, number];

/** (x, y) 한 픽셀을 **화면에 그려진 대로** 읽는다: 스크린샷을 같은 엔진의 캔버스에 올려 `getImageData`로 읽는다. */
async function pixel(page: import("playwright").Page, x: number, y: number): Promise<Rgb> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]] as [number, number, number];
  }, png.toString("base64"));
}

describe("띠에서 떨어지는 알약은 판의 대화 머리 위에 그려진다 (#4587, design-review H1)", () => {
  // 실기 캡처에서 알약의 아래 30%를 머리 컨트롤이 덮었다: 알약(띠 안, 100)과 머리(판 안, 100)가 같은 스태킹 컨텍스트에서
  // 같은 층이라 DOM 순서(띠가 판보다 앞)로 머리가 이겼다. 판이 `isolate`면 머리의 100은 판 안에서만 겨루고 알약이 이긴다.
  // 히트 테스트(`elementFromPoint`)는 알약이 `pointer-events: none`이라 못 쓴다: 그려진 픽셀을 읽는다.
  it.skipIf(ENGINES.length === 0)(
    "알약과 머리의 단색 상자가 겹친 곳의 픽셀은 알약 면색이고, 알약의 층은 그대로 content-float(100)다",
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
                const at = `${engine} ${palette} ${colorScheme}`;
                const m = await page.evaluate(() => {
                  const rect = (id: string) => {
                    const r = document.getElementById(id)!.getBoundingClientRect();
                    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
                  };
                  const g = (id: string) => getComputedStyle(document.getElementById(id)!);
                  return {
                    tip: rect("tip"),
                    boxes: ["hb1", "hb2", "hb3", "hb4"].map((id) => rect(id)),
                    tipBg: g("tip").backgroundColor,
                    boxBg: g("hb1").backgroundColor,
                    tipZ: g("tip").zIndex,
                    headZ: g("head").zIndex,
                    paneIsolation: g("pane").isolation,
                    paneZ: g("pane").zIndex,
                  };
                });
                if (m.tipZ !== "100") problems.push(`${at}: 알약 층 ${m.tipZ}, 기대 100(층 어휘를 올려서 고친 것이 아니다)`);
                if (m.headZ !== "100") problems.push(`${at}: 머리 층 ${m.headZ}, 기대 100`);
                if (m.paneZ !== "auto") problems.push(`${at}: 판에 z-index가 생겼다(${m.paneZ})`);
                if (m.paneIsolation !== "isolate") problems.push(`${at}: 판이 isolate가 아니다(${m.paneIsolation})`);

                const tipRgb = parseColor(m.tipBg);
                const boxRgb = parseColor(m.boxBg);
                const overlap = m.boxes
                  .map((b) => ({
                    x0: Math.max(b.left, m.tip.left),
                    x1: Math.min(b.right, m.tip.right),
                    y0: Math.max(b.top, m.tip.top),
                    y1: Math.min(b.bottom, m.tip.bottom),
                  }))
                  .find((o) => o.x1 - o.x0 >= 6 && o.y1 - o.y0 >= 6);
                if (!overlap) {
                  problems.push(`${at}: 알약과 머리 상자가 겹치지 않는다(장면이 현장을 못 만들었다)`);
                  continue;
                }
                const cx = Math.round((overlap.x0 + overlap.x1) / 2);
                const cy = Math.round((overlap.y0 + overlap.y1) / 2);
                const got = await pixel(page, cx, cy);
                const near = (a: Rgb, b: Rgb) => a.every((v, i) => Math.abs(v - b[i]!) <= 3);
                if (!near(got, tipRgb)) {
                  problems.push(`${at}: 겹친 곳(${cx},${cy})의 픽셀 [${got}]이 알약 면 [${tipRgb.map(Math.round)}]이 아니다(머리 상자 [${boxRgb.map(Math.round)}]가 알약 위에 그려졌다)`);
                }
                // 대조: 알약 아래의 같은 상자는 상자 색이다(상자가 정말 그려지고 있다).
                const below = Math.round(m.tip.bottom + 6);
                const box = m.boxes.find((b) => cx >= b.left && cx <= b.right && below < b.bottom);
                if (box) {
                  const ref = await pixel(page, cx, below);
                  if (!near(ref, boxRgb)) problems.push(`${at}: 알약 아래의 상자 픽셀 [${ref}]이 상자 색 [${boxRgb.map(Math.round)}]이 아니다(장면이 틀렸다)`);
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
    120_000
  );
});
