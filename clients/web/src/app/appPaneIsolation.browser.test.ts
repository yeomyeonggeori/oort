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

/** 겹치는 상자들의 장면. 위치는 뷰포트 기준 고정 좌표라 어느 팔레트·스킴에서도 같다. */
function html(css: string): string {
  const fixed = (id: string, cls: string, box: string) =>
    `<div id="${id}" class="${cls}" style="position:fixed;${box}"></div>`;
  return `<!doctype html><html lang="ko"><head><style>${css}
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
  ${fixed("drawer", "layer-overlay-surface bg-danger", "left:20px;top:300px;width:200px;height:60px")}
  ${fixed("sscrim", "layer-overlay-scrim bg-primary", "left:300px;top:600px;width:200px;height:100px")}
  <main class="app-pane flex min-h-0 min-w-0 flex-col" id="pane">
    <header class="channel-head flex min-w-0 items-center justify-end py-row-fixed" id="head">
      <span id="hbox" class="bg-primary" style="display:block;inline-size:60px;block-size:34px"></span>
    </header>
    ${fixed("thread", "layer-overlay-scrim bg-ok", "left:500px;top:300px;width:300px;height:200px")}
  </main>
</div>
${fixed("portal", "layer-overlay-scrim bg-warn", "left:700px;top:380px;width:300px;height:200px")}
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
                await page.setContent(html(css).replace("<html lang=\"ko\">", `<html lang="ko" data-palette="${palette}">`));
                const at = `${engine} ${palette} ${colorScheme}`;
                const m = await page.evaluate(() => {
                  const rect = (id: string) => {
                    const r = document.getElementById(id)!.getBoundingClientRect();
                    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
                  };
                  const bg = (id: string) => getComputedStyle(document.getElementById(id)!).backgroundColor;
                  return {
                    pill: rect("pill"),
                    hbox: rect("hbox"),
                    thread: rect("thread"),
                    portal: rect("portal"),
                    drawer: rect("drawer"),
                    sscrim: rect("sscrim"),
                    pillBg: bg("pill"),
                    hboxBg: bg("hbox"),
                    threadBg: bg("thread"),
                    portalBg: bg("portal"),
                    drawerBg: bg("drawer"),
                    sscrimBg: bg("sscrim"),
                  };
                });
                const overlap = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) => {
                  const x0 = Math.max(a.left, b.left);
                  const x1 = Math.min(a.right, b.right);
                  const y0 = Math.max(a.top, b.top);
                  const y1 = Math.min(a.bottom, b.bottom);
                  return x1 - x0 >= 6 && y1 - y0 >= 6
                    ? { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) }
                    : null;
                };
                const check = async (
                  label: string,
                  upper: string,
                  lower: string,
                  a: typeof m.pill,
                  b: typeof m.pill,
                  upperBg: string,
                  lowerBg: string
                ) => {
                  const o = overlap(a, b);
                  if (!o) {
                    problems.push(`${at} ${label}: 두 상자가 겹치지 않는다(장면이 틀렸다)`);
                    return;
                  }
                  const got = await pixel(page, o.x, o.y);
                  if (!near(got, parseColor(upperBg))) {
                    problems.push(`${at} ${label}: 겹친 곳(${o.x},${o.y})의 픽셀 [${got}]이 위에 설 ${upper} [${parseColor(upperBg).map(Math.round)}]이 아니다(${lower} [${parseColor(lowerBg).map(Math.round)}]가 위에 그려졌나?)`);
                  }
                };
                // I1 body로 포털된 스크림이 판 안의 덮는 판을 가린다.
                await check("I1", "포털 스크림", "판 안의 덮는 판", m.portal, m.thread, m.portalBg, m.threadBg);
                // I2 서랍이 판 안의 덮는 판 위에 선다: 서랍과 덮는 판을 같은 자리에 겹쳐 두려면 좌표가 달라 별도 상자로 잰다.
                // (서랍 좌표를 덮는 판 쪽으로 옮겨 겹치게 한다)
                await page.evaluate(() => {
                  const d = document.getElementById("drawer")!;
                  d.style.left = "560px";
                  d.style.top = "340px";
                });
                const m2 = await page.evaluate(() => {
                  const r = document.getElementById("drawer")!.getBoundingClientRect();
                  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
                });
                await check("I2", "서랍", "판 안의 덮는 판", m2, m.thread, m.drawerBg, m.threadBg);
                // I3 판 안에서는 덮는 판이 머리 위에 선다: 덮는 판을 머리 쪽으로 올려 겹친다.
                await page.evaluate(() => {
                  const t = document.getElementById("thread")!;
                  const h = document.getElementById("hbox")!.getBoundingClientRect();
                  t.style.left = `${Math.round(h.left - 10)}px`;
                  t.style.top = `${Math.round(h.top - 10)}px`;
                  t.style.width = "120px";
                  t.style.height = "60px";
                  document.getElementById("drawer")!.style.display = "none";
                  document.getElementById("portal")!.style.display = "none";
                });
                const mt = await page.evaluate(() => {
                  const r = document.getElementById("thread")!.getBoundingClientRect();
                  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
                });
                await check("I3", "판 안의 덮는 판", "머리", mt, m.hbox, m.threadBg, m.hboxBg);
                // I4 띠의 알약이 판의 머리 위에 선다(H1). 덮는 판은 치운다.
                await page.evaluate(() => {
                  document.getElementById("thread")!.style.display = "none";
                });
                await check("I4", "띠의 알약", "판의 머리", m.pill, m.hbox, m.pillBg, m.hboxBg);
                // I5 띠의 알약이 판 안의 덮는 판 위에도 선다(이번 수리로 바뀐 관계). 덮는 판을 알약 아래로 옮겨 겹친다.
                await page.evaluate(() => {
                  const t = document.getElementById("thread")!;
                  const p = document.getElementById("pill")!.getBoundingClientRect();
                  t.style.display = "block";
                  t.style.left = `${Math.round(p.left + 10)}px`;
                  t.style.top = `${Math.round(p.top + 6)}px`;
                  t.style.width = "120px";
                  t.style.height = "60px";
                });
                const mt2 = await page.evaluate(() => {
                  const r = document.getElementById("thread")!.getBoundingClientRect();
                  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
                });
                await check("I5", "띠의 알약", "판 안의 덮는 판", m.pill, mt2, m.pillBg, m.threadBg);
                // I6 사이드바 스크림(DOM이 판보다 앞)이 판 안의 덮는 판 위에 선다. 덮는 판을 스크림 쪽으로 옮겨 겹친다.
                await page.evaluate(() => {
                  const t = document.getElementById("thread")!;
                  t.style.left = "350px";
                  t.style.top = "620px";
                  t.style.width = "100px";
                  t.style.height = "60px";
                });
                const mt3 = await page.evaluate(() => {
                  const r = document.getElementById("thread")!.getBoundingClientRect();
                  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
                });
                await check("I6", "사이드바 스크림", "판 안의 덮는 판", m.sscrim, mt3, m.sscrimBg, m.threadBg);
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
