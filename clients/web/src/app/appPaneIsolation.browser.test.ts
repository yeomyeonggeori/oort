import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { TOOLTIP_CLASS, TOOLTIP_END_CLASS, TOOLTIP_SIDE_CLASS } from "@/design/ui/tooltip";

// =============================================================================
// 판(`app-pane`)을 `isolation: isolate`로 가둔 뒤에도 겹침 층의 순서가 그대로다 (#4587, design-review H1 수리의 부작용 점검).
//
// 판이 스스로 스태킹 컨텍스트가 되면 판 안의 수치 z(대화 머리·호버 툴바 100, 판 안에서 창을 덮는 스레드·작업 판 200)는 판 안에서만 겨루고,
// 판 바깥의 것(띠·사이드바의 툴팁 100, 서랍 300, `body`로 포털되는 스크림 200·표면 300)은 판 전체를 한 덩어리로 상대한다.
// 기존 층 하네스(`scripts/capture-overlay-layers.mjs`)는 이 트리의 base(`origin/track/uxui`)에서도 첫 장면(메시지 행 동작 단추를 못 찾음)에서
// 똑같이 시간 초과로 멈춰 이 변경의 증거가 될 수 없었다. 그래서 바뀔 수 있는 관계를 **그려진 픽셀**로 직접 잰다:
//
//   I1 body로 포털된 스크림(200)은 판 안의 덮는 판(200)을 가린다(DOM이 뒤라서가 아니라 판 전체가 그 아래라서)
//   I2 서랍(300, DOM이 판보다 앞)은 판 안의 덮는 판(200) 위에 선다
//   I3 판 안에서는 덮는 판(200)이 머리(100) 위에 선다(판 안의 순서 그대로)
//   I4 띠에서 떨어지는 툴팁 알약(100, DOM이 판보다 앞)은 판의 머리(100) 위에 선다(H1: 이 시험이 지키는 것)
//   I5 같은 알약은 판 안의 덮는 판(200) 위에도 선다 — **이번 수리로 바뀐 관계**다(예전에는 판 안의 200이 띠의 100을 눌렀다).
//      받아 두는 이유: 알약은 보이는 띠 컨트롤에서만 뜨고, 그 컨트롤을 덮은 판은 알약이 뜰 길을 막는다.
//   I6 사이드바 스크림(200, DOM이 판보다 앞 — 600 미만의 서랍 스크림 자리)은 판 안의 덮는 판(200) 위에 선다 — 이것도 **바뀐 관계**다
//      (예전에는 DOM이 뒤인 판 안의 200이 스크림을 눌러 서랍이 열렸는데도 덮는 판이 스크림 위에 밝게 남을 수 있었다). 서랍이 열린 동안
//      뒤의 모든 표면을 한 장의 스크림이 덮는다는 쪽이 의도(`tokens.css` `ade-scrim`의 주석)와 같다.
//
// 장면은 진짜 `tokens.css`(Tailwind로 컴파일)와 진짜 클래스(`layer-*`, `app-pane`, `channel-head`, 툴팁 클래스)를 쓰고, 단색 상자로 겹친 곳의
// 픽셀을 읽는다. `isolate`를 빼면 I4·I5·I6이 붉다(여덟 조합 모두, 사보타주 표 T8).
// =============================================================================

const split = (cls: string) => cls.split(/\s+/).filter(Boolean);

const CANDIDATES = [
  "app-shell",
  "app-titlebar",
  "app-titlebar-trailing",
  "sidebar-drawer",
  "app-pane",
  "channel-head",
  "layer-content-float",
  "layer-overlay-scrim",
  "layer-overlay-surface",
  "bg-primary",
  "bg-ok",
  "bg-warn",
  "bg-danger",
  "relative",
  "inline-flex",
  "flex",
  "items-center",
  "justify-end",
  "py-row-fixed",
  "min-h-0",
  "min-w-0",
  "flex-col",
  "size-control-sm",
  ...split(TOOLTIP_CLASS),
  ...split(TOOLTIP_SIDE_CLASS.bottom),
  ...split(TOOLTIP_END_CLASS),
];

const PALETTES = ["dawnsky", "noeul"] as const;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 장면에 놓을 겹침 상자들(뷰포트 기준 고정 좌표). 없는 것은 그리지 않는다. 런타임에 스타일을 쓰지 않고 장면을 새로 그린다. */
interface Boxes {
  /** 판 안의 덮는 판(스레드·작업 판, 200). */
  thread?: Box;
  /** 서랍(300, DOM이 판보다 앞). */
  drawer?: Box;
  /** body로 포털된 스크림(200, DOM이 판보다 뒤). */
  portal?: Box;
  /** 사이드바 스크림(200, DOM이 판보다 앞). */
  sscrim?: Box;
}

/** 겹치는 상자들의 장면. 팔레트·스킴은 `data-palette`와 브라우저 스킴이 정한다. */
function html(css: string, palette: string, boxes: Boxes): string {
  const fixed = (id: string, cls: string, b: Box | undefined) =>
    b
      ? `<div id="${id}" class="${cls}" style="position:fixed;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px"></div>`
      : "";
  return `<!doctype html><html lang="ko" data-palette="${palette}"><head><style>${css}
html, body { margin: 0; }
</style></head><body>
<div class="app-shell" id="shell" data-desktop-shell>
  <header class="app-titlebar" id="band" data-tauri-drag-region>
    <div class="app-titlebar-trailing" id="slot" data-tauri-drag-region>
      <span class="relative inline-flex">
        <button type="button" class="size-control-sm" id="btn">다운로드</button>
        <span id="pill" class="${TOOLTIP_CLASS} ${TOOLTIP_SIDE_CLASS.bottom} ${TOOLTIP_END_CLASS}">다운로드, 받지 못한 파일이 있어요</span>
      </span>
    </div>
  </header>
  <aside class="sidebar-drawer" id="side">사이드바</aside>
  ${fixed("drawer", "layer-overlay-surface bg-danger", boxes.drawer)}
  ${fixed("sscrim", "layer-overlay-scrim bg-primary", boxes.sscrim)}
  <main class="app-pane flex min-h-0 min-w-0 flex-col" id="pane">
    <header class="channel-head flex min-w-0 items-center justify-end py-row-fixed" id="head">
      <span id="hbox" class="bg-primary" style="display:block;inline-size:60px;block-size:34px"></span>
    </header>
    ${fixed("thread", "layer-overlay-scrim bg-ok", boxes.thread)}
  </main>
</div>
${fixed("portal", "layer-overlay-scrim bg-warn", boxes.portal)}
</body></html>`;
}

type Rgb = [number, number, number];

/** (x, y) 한 픽셀을 **화면에 그려진 대로** 읽는다: 스크린샷을 같은 엔진의 캔버스에 올려 `getImageData`로 읽는다. */
async function pixel(page: Page, x: number, y: number): Promise<Rgb> {
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

function parseColor(value: string): Rgb {
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value.trim());
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value.trim());
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`읽을 수 없는 색: ${value}`);
}

const near = (a: Rgb, b: Rgb) => a.every((v, i) => Math.abs(v - b[i]!) <= 3);

describe("판을 isolate로 가둔 뒤의 겹침 층 순서 (#4587)", () => {
  type R = { left: number; right: number; top: number; bottom: number };
  /** 한 불변식: `upper`가 `lower` 위에 그려진다. 장면의 상자와 두 id, 알려 줄 이름. */
  interface Case {
    label: string;
    upper: string;
    lower: string;
    upperName: string;
    lowerName: string;
    boxes: Boxes;
    /** 위에 설 것의 색을 읽을 id(알약·상자 모두 자기 배경색이다). */
    upperBgId: string;
    lowerBgId: string;
  }
  // 좌표는 1100×760 뷰포트 기준이다. 머리 단색 상자(`hbox`)는 판의 오른쪽 위(약 x 972~1032, y 53~87), 알약은 띠 오른쪽 끝에서
  // 아래로(약 x 910~1092, y 38~68)에 선다. 각 장면은 겹쳐야 할 두 상자만 둔다.
  const CASES: Case[] = [
    { label: "I1", upper: "portal", lower: "thread", upperName: "포털 스크림", lowerName: "판 안의 덮는 판", upperBgId: "portal", lowerBgId: "thread",
      boxes: { thread: { left: 500, top: 300, width: 300, height: 200 }, portal: { left: 700, top: 380, width: 300, height: 200 } } },
    { label: "I2", upper: "drawer", lower: "thread", upperName: "서랍", lowerName: "판 안의 덮는 판", upperBgId: "drawer", lowerBgId: "thread",
      boxes: { thread: { left: 500, top: 300, width: 300, height: 200 }, drawer: { left: 560, top: 340, width: 200, height: 60 } } },
    { label: "I3", upper: "thread", lower: "hbox", upperName: "판 안의 덮는 판", lowerName: "머리", upperBgId: "thread", lowerBgId: "hbox",
      boxes: { thread: { left: 900, top: 44, width: 190, height: 80 } } },
    { label: "I4", upper: "pill", lower: "hbox", upperName: "띠의 알약", lowerName: "판의 머리", upperBgId: "pill", lowerBgId: "hbox", boxes: {} },
    { label: "I5", upper: "pill", lower: "thread", upperName: "띠의 알약", lowerName: "판 안의 덮는 판", upperBgId: "pill", lowerBgId: "thread",
      boxes: { thread: { left: 950, top: 44, width: 120, height: 60 } } },
    { label: "I6", upper: "sscrim", lower: "thread", upperName: "사이드바 스크림", lowerName: "판 안의 덮는 판", upperBgId: "sscrim", lowerBgId: "thread",
      boxes: { sscrim: { left: 300, top: 600, width: 200, height: 100 }, thread: { left: 350, top: 620, width: 100, height: 60 } } },
  ];

  it.skipIf(ENGINES.length === 0)(
    "I1~I6: 겹친 곳에 그려진 픽셀이 위에 서야 할 것의 색이다",
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
                for (const c of CASES) {
                  await page.setContent(html(css, palette, c.boxes));
                  const at = `${engine} ${palette} ${colorScheme} ${c.label}`;
                  const m = await page.evaluate(
                    ([upperId, lowerId, upperBgId, lowerBgId]) => {
                      const rect = (id: string) => {
                        const r = document.getElementById(id)!.getBoundingClientRect();
                        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
                      };
                      const bg = (id: string) => getComputedStyle(document.getElementById(id)!).backgroundColor;
                      return {
                        upper: rect(upperId!),
                        lower: rect(lowerId!),
                        upperBg: bg(upperBgId!),
                        lowerBg: bg(lowerBgId!),
                        tipZ: getComputedStyle(document.getElementById("pill")!).zIndex,
                        paneZ: getComputedStyle(document.getElementById("pane")!).zIndex,
                        paneIsolation: getComputedStyle(document.getElementById("pane")!).isolation,
                      };
                    },
                    [c.upper, c.lower, c.upperBgId, c.lowerBgId] as const
                  );
                  if (m.tipZ !== "100") problems.push(`${at}: 알약 층 ${m.tipZ}, 기대 100(층 어휘를 올려서 고친 것이 아니다)`);
                  if (m.paneZ !== "auto") problems.push(`${at}: 판에 z-index가 생겼다(${m.paneZ})`);
                  if (m.paneIsolation !== "isolate") problems.push(`${at}: 판이 isolate가 아니다(${m.paneIsolation})`);
                  const a: R = m.upper;
                  const b: R = m.lower;
                  const x0 = Math.max(a.left, b.left);
                  const x1 = Math.min(a.right, b.right);
                  const y0 = Math.max(a.top, b.top);
                  const y1 = Math.min(a.bottom, b.bottom);
                  if (!(x1 - x0 >= 6 && y1 - y0 >= 6)) {
                    problems.push(`${at}: 두 상자가 겹치지 않는다(장면이 틀렸다): 위 ${c.upperName} [${a.left},${a.top},${a.right},${a.bottom}] 아래 ${c.lowerName} [${b.left},${b.top},${b.right},${b.bottom}]`);
                    continue;
                  }
                  const cx = Math.round((x0 + x1) / 2);
                  const cy = Math.round((y0 + y1) / 2);
                  const got = await pixel(page, cx, cy);
                  const want = parseColor(m.upperBg);
                  if (!near(got, want)) {
                    problems.push(`${at}: 겹친 곳(${cx},${cy})의 픽셀 [${got}]이 위에 설 ${c.upperName} [${want.map(Math.round)}]이 아니다(${c.lowerName} [${parseColor(m.lowerBg).map(Math.round)}]가 위에 그려졌나?)`);
                  }
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
    180_000
  );
});
