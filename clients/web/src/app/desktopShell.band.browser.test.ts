import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  compileTokensCss,
  ENGINES,
} from "@/design/appearance/compileTokensTestKit";
import { TOOLTIP_CLASS, TOOLTIP_SIDE_CLASS } from "@/design/ui/tooltip";
import { channelHeaderControlClass } from "@/features/chat/channelHeaderControl";

// =============================================================================
// 창 맨 위 잡기 띠와 대화 머리가 **엔진이 계산한 값**으로 계약을 지킨다 (#4591).
//
// 문자열 시험은 「이 줄이 CSS에 있다」만 말한다. 이 시험은 `tokens.css`를 Tailwind로 진짜 컴파일해 WebKit(WKWebView의
// 엔진)과 Chromium에 먹이고, 판이 어디서 시작하는지·머리에 선이 없는지·단추 선이 어떤 색인지를 **계산된 기하**로
// 잰다. 규칙을 지우거나 마커를 빼면 숫자가 움직여 붉어진다(사보타주 표: 스크래치패드 4591/sabotage.md).
//
// 잰 것
//   · 셸(마커 `data-desktop-shell`): 띠 40 · 판 위쪽 40(= 띠 아래) · 사이드바 위쪽 40(판과 같은 높이) · 오른쪽·아래 인셋 8
//   · 웹(마커 없음): 판 위쪽 8 — 띠가 없다. 판이 첫 행까지 올라가 상단 줄 위에 걸친다
//   · 접힘·좁은 창(720)에서도 셸의 판은 띠 아래다
//   · 머리: 아래 선 0 · 그림자는 `--head-edge` 값 그대로이고 라이트와 다크가 다르다 · 고대비에서는 3:1 선이 돌아온다
//   · 머리 단추: 1px 연한 선(`--line`) · 호버 면 · 켜짐은 투명 선 + 신호 면 · 고대비 선
//   · 툴팁: 연회색 알약(`--muted-soft`), 선·그림자 없음
//   · 토글 중심 = 띠 가운데(20.0): 아래 테두리가 없다(신호등 y 22와 한 쌍, desktopShellContract.test.ts)
//   · 전체 화면(`:root[data-window-fullscreen]`): 토글이 신호등 자리 80이 아니라 12에 선다
//   · 판 바깥(위 띠·오른쪽·아래 여백·판 모서리 뒤) = 사이드바와 같은 색: 팔레트 3 × 스킴 2 × 장면(셸·셸 접힘·웹·설정)을 **픽셀로** 읽는다
//   · 노을띠의 「내 작업」(판 없음): 띠는 사이드바 열(접히면 레일)이고 셸에서는 윗줄 40도 전폭이다. 웹에는 윗줄이 없다(**픽셀을 읽는다**)
// =============================================================================

const split = (cls: string) => cls.split(/\s+/).filter(Boolean);
const BUTTON = channelHeaderControlClass();
const BUTTON_ON = channelHeaderControlClass({ pressed: true });
const BUTTON_WIDE = channelHeaderControlClass({ wide: true });

const CANDIDATES = [
  "app-shell",
  "app-titlebar",
  "app-titlebar-trailing",
  "band-surface",
  "sidebar-drawer",
  "app-pane",
  "channel-head",
  "flex",
  "min-h-0",
  "min-w-0",
  "flex-col",
  "items-center",
  "py-row-fixed",
  "bg-line",
  "bg-line-strong",
  "bg-surface-hover",
  "bg-accent-soft",
  "bg-muted-soft",
  ...split(BUTTON),
  ...split(BUTTON_ON),
  ...split(BUTTON_WIDE),
  ...split(TOOLTIP_CLASS),
  ...split(TOOLTIP_SIDE_CLASS.bottom),
];

interface Scene {
  /** 셸의 마커와 상단 줄의 끌기 속성을 함께 찍는다(둘 다 `IS_TAURI`에서 온다). */
  shell: boolean;
  collapsed?: boolean;
  /** 「내 작업」: 판이 없고 칸이 창 바닥 위에 곧바로 선다. */
  workRail?: boolean;
  /** 설정 전면: 앱 상단 줄·사이드바가 없고 본문(`main`)만 판 자리를 채운다. */
  settings?: boolean;
  /** 팔레트 이름(`data-palette`). 노을띠만 띠(`--band`)가 있다. 세 팔레트의 CSS를 다 싣고 속성으로 고른다. */
  palette?: string;
  /** 셸이 전체 화면을 찍는 루트 표지(`data-window-fullscreen`). */
  fullscreen?: boolean;
  /** 판을 감춘다(`visibility: hidden`): 창 바닥만 남겨 판 바깥의 색을 순수하게 읽는다. */
  hidePane?: boolean;
}

const PALETTES = ["dawnsky", "graphite", "noeul"] as const;
const PALETTE_CSS = (name: string) =>
  readFileSync(new URL(`../design/themes/palettes/${name}.css`, import.meta.url), "utf8");

function html(css: string, scene: Scene): string {
  const shell = scene.shell ? "data-desktop-shell" : "";
  const drag = scene.shell ? "data-tauri-drag-region" : "";
  const collapsed = scene.collapsed ? "data-sidebar-collapsed" : "";
  const workRail = scene.workRail ? "data-work-rail" : "";
  const settings = scene.settings ? "data-settings-surface" : "";
  const slot = scene.shell
    ? `<div class="app-titlebar-trailing" id="slot" data-tauri-drag-region></div>`
    : "";
  const palette = scene.palette ? `data-palette="${scene.palette}"` : "";
  const fullscreen = scene.fullscreen ? "data-window-fullscreen" : "";
  const paletteCss = scene.palette ? PALETTES.map(PALETTE_CSS).join("\n") : "";
  const chrome = scene.settings
    ? ""
    : `<header class="app-titlebar" id="band" ${drag}>
      <button id="toggle" type="button">토글</button>${slot}
    </header>
    <aside class="sidebar-drawer" id="side">사이드바</aside>`;
  return `<!doctype html><html lang="ko" ${palette} ${fullscreen}><head><style>${css}
${paletteCss}
html, body { margin: 0; }
${scene.hidePane ? "#pane { visibility: hidden; }" : ""}
</style></head><body>
<div id="frame" style="width:100vw;height:100vh">
  <div class="app-shell" id="shell" ${shell} ${collapsed} ${workRail} ${settings}>
    ${chrome}
    <main class="app-pane flex min-h-0 min-w-0 flex-col" id="pane">
      <header class="channel-head flex min-w-0 items-center py-row-fixed" id="head">
        <button class="${BUTTON}" id="btn" type="button" aria-label="터미널"><svg width="16" height="16"></svg></button>
        <button class="${BUTTON_WIDE}" id="btn-wide" type="button" aria-label="멤버"><svg width="16" height="16"></svg><span>12</span></button>
        <button class="${BUTTON_ON}" id="btn-on" type="button" aria-pressed="true" aria-label="켜짐"><svg width="16" height="16"></svg></button>
      </header>
      <div id="timeline" style="flex:1">타임라인</div>
    </main>
  </div>
</div>
<div id="ref-line" class="bg-line" style="height:4px"></div>
<div id="ref-line-strong" class="bg-line-strong" style="height:4px"></div>
<div id="ref-hover" class="bg-surface-hover" style="height:4px"></div>
<div id="ref-accent-soft" class="bg-accent-soft" style="height:4px"></div>
<div id="ref-muted-soft" class="bg-muted-soft" style="height:4px"></div>
<div id="ref-head-edge" style="height:4px;box-shadow:var(--head-edge)"></div>
<div id="ref-band" style="height:4px;background:var(--band)"></div>
<div style="position:relative;margin:40px;width:120px">
  <span id="tip" class="${TOOLTIP_CLASS} ${TOOLTIP_SIDE_CLASS.bottom}">채널 메뉴</span>
</div>
</body></html>`;
}

/** 판 바깥 색의 기준: 같은 팔레트의 바닥 식(160° 세 정지점)을 창 전체에 깐 한 장. 띠가 없는 테마에서 사이드바도 이 위에 녹는다. */
function canvasHtml(css: string, palette: string): string {
  return `<!doctype html><html lang="ko" data-palette="${palette}"><head><style>${css}
${PALETTES.map(PALETTE_CSS).join("\n")}
html, body { margin: 0; }
</style></head><body>
<div style="position:fixed;inset:0;background:linear-gradient(160deg,var(--canvas-top) 0%,var(--canvas-mid) 42%,var(--canvas-bottom) 100%)"></div>
<div id="ref-band" style="position:fixed;left:0;top:0;width:1px;height:1px;background:var(--band)"></div>
</body></html>`;
}

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const box = (id: string): Box | null => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
      };
    };
    return {
      shell: box("shell") as Box,
      band: box("band") as Box,
      pane: box("pane") as Box,
      side: box("side") as Box,
      toggle: box("toggle") as Box,
      slot: box("slot"),
    };
  });
}

async function styles(page: Page) {
  return page.evaluate(() => {
    const g = (id: string) => getComputedStyle(document.getElementById(id)!);
    const bg = (id: string) => g(id).backgroundColor;
    const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    return {
      head: {
        borderBottomWidth: g("head").borderBottomWidth,
        boxShadow: g("head").boxShadow,
        position: g("head").position,
        zIndex: g("head").zIndex,
      },
      btn: {
        w: r("btn").width,
        h: r("btn").height,
        radius: g("btn").borderTopLeftRadius,
        borderWidth: g("btn").borderTopWidth,
        borderColor: g("btn").borderTopColor,
        background: bg("btn"),
      },
      wide: { h: r("btn-wide").height, borderWidth: g("btn-wide").borderTopWidth },
      on: {
        borderColor: g("btn-on").borderTopColor,
        borderWidth: g("btn-on").borderTopWidth,
        background: bg("btn-on"),
      },
      tip: {
        background: bg("tip"),
        boxShadow: g("tip").boxShadow,
        borderWidth: g("tip").borderTopWidth,
        radius: g("tip").borderTopLeftRadius,
      },
      ref: {
        line: bg("ref-line"),
        lineStrong: bg("ref-line-strong"),
        hover: bg("ref-hover"),
        accentSoft: bg("ref-accent-soft"),
        mutedSoft: bg("ref-muted-soft"),
        headEdge: g("ref-head-edge").boxShadow,
      },
    };
  });
}

const near = (actual: number, want: number, tol = 0.51) =>
  Math.abs(actual - want) <= tol;

describe("창 맨 위 잡기 띠: 엔진이 계산한 기하 (#4591)", () => {
  it.skipIf(ENGINES.length === 0)(
    "셸은 판이 띠(40) 아래에서 시작하고, 웹은 판이 첫 행까지 올라가 8에서 시작한다",
    async () => {
      const css = await compileTokensCss(CANDIDATES);
      const playwright = await import("playwright");
      const problems: string[] = [];
      const eq = (label: string, actual: number, want: number, tol = 0.51) => {
        if (!near(actual, want, tol)) problems.push(`${label}: ${actual}, 기대 ${want}`);
      };

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const [name, scene, viewport] of [
            ["셸", { shell: true }, { width: 1100, height: 760 }],
            ["셸 좁은 창", { shell: true }, { width: 720, height: 480 }],
            ["셸 접힘", { shell: true, collapsed: true }, { width: 1100, height: 760 }],
            ["웹", { shell: false }, { width: 1100, height: 760 }],
          ] as const) {
            const ctx = await browser.newContext({ viewport });
            try {
              const page = await ctx.newPage();
              await page.setContent(html(css, scene));
              const g = await geometry(page);
              const at = `${engine} ${name}`;

              // 띠는 어느 쪽이든 같은 40이다(신호등 높이). 달라지는 것은 판이 시작하는 곳이다.
              eq(`${at} 띠 높이`, g.band.height, 40);
              eq(`${at} 띠 폭 = 창 폭`, g.band.width, viewport.width);
              // 토글 중심 = 띠 가운데(20.0). 아래 테두리가 없어서 내용 상자가 40이다(신호등 y 22 − 2와 한 쌍).
              eq(`${at} 토글 중심 = 띠 가운데`, (g.toggle.top + g.toggle.bottom) / 2 - g.shell.top, 20, 0.26);

              if (scene.shell) {
                eq(`${at} 판 위쪽 = 띠 아래`, g.pane.top - g.shell.top, 40);
                eq(`${at} 사이드바 위쪽 = 판과 같은 높이`, g.side.top - g.shell.top, 40);
                eq(`${at} 판 위쪽과 사이드바 위쪽이 같다`, g.pane.top, g.side.top);
                eq(`${at} 판 아래 인셋`, g.shell.bottom - g.pane.bottom, 8);
                eq(`${at} 판 오른쪽 인셋`, g.shell.right - g.pane.right, 8);
                // 띠와 판이 겹치지 않는다: 띠 어디를 눌러도 판이 아니라 띠가 맞는다.
                if (!(g.pane.top >= g.band.bottom - 0.01)) {
                  problems.push(`${at} 판이 띠를 덮는다: 판 ${g.pane.top} < 띠 ${g.band.bottom}`);
                }
                if (!g.slot) problems.push(`${at} 오른쪽 자리가 없다`);
                else {
                  eq(`${at} 오른쪽 자리는 비어 있으면 폭 0`, g.slot.width, 0);
                  eq(`${at} 오른쪽 자리는 띠 오른쪽 끝(안쪽 여백 8)`, g.band.right - g.slot.right, 8);
                }
                eq(`${at} 토글은 신호등 인셋 80 뒤`, g.toggle.left, 80);
              } else {
                eq(`${at} 판 위쪽 인셋 8(띠 없음)`, g.pane.top - g.shell.top, 8);
                if (!(g.pane.top < g.band.bottom)) {
                  problems.push(`${at} 웹에서 판이 띠 아래로 내려갔다`);
                }
                if (g.slot) problems.push(`${at} 웹에 오른쪽 자리가 있다`);
              }

              if (scene.shell && scene.collapsed) {
                eq(`${at} 접힌 판 왼쪽 = 레일 56 + 인셋 8`, g.pane.left - g.shell.left, 64);
              }
              if (scene.shell && !scene.collapsed) {
                eq(`${at} 판 왼쪽 = 사이드바 324`, g.pane.left - g.shell.left, 324);
              }
            } finally {
              await ctx.close();
            }
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    60_000
  );
});

describe("대화 머리와 머리 단추: 엔진이 계산한 값 (#4591)", () => {
  it.skipIf(ENGINES.length === 0)(
    "머리는 선 대신 --head-edge 그림자, 단추는 1px 연한 선, 툴팁은 연회색 알약이다",
    async () => {
      const css = await compileTokensCss(CANDIDATES);
      const playwright = await import("playwright");
      const problems: string[] = [];
      const shadows: Record<string, string> = {};

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const colorScheme of ["light", "dark"] as const) {
            const ctx = await browser.newContext({
              viewport: { width: 1100, height: 760 },
              colorScheme,
            });
            try {
              const page = await ctx.newPage();
              await page.setContent(html(css, { shell: true }));
              const at = `${engine} ${colorScheme}`;
              const s = await styles(page);

              // 머리: 선 0, 그림자는 토큰 값 그대로(없음이 아니다), 형제 위에 그려지는 층.
              if (s.head.borderBottomWidth !== "0px") {
                problems.push(`${at} 머리 아래 선: ${s.head.borderBottomWidth}`);
              }
              if (s.head.boxShadow === "none" || s.head.boxShadow === "") {
                problems.push(`${at} 머리 그림자 없음`);
              }
              if (s.head.boxShadow !== s.ref.headEdge) {
                problems.push(`${at} 머리 그림자가 --head-edge가 아니다: ${s.head.boxShadow} ≠ ${s.ref.headEdge}`);
              }
              if (s.head.position !== "relative" || s.head.zIndex !== "100") {
                problems.push(`${at} 머리 층: ${s.head.position} z=${s.head.zIndex}`);
              }
              shadows[at] = s.head.boxShadow;

              // 단추: 34 둥근 사각(반경 10), 1px 연한 선.
              if (!near(s.btn.w, 34) || !near(s.btn.h, 34)) {
                problems.push(`${at} 단추 크기 ${s.btn.w}×${s.btn.h}`);
              }
              if (s.btn.radius !== "10px") problems.push(`${at} 단추 반경 ${s.btn.radius}`);
              if (s.btn.borderWidth !== "1px") problems.push(`${at} 단추 선 두께 ${s.btn.borderWidth}`);
              if (s.btn.borderColor !== s.ref.line) {
                problems.push(`${at} 단추 선 색 ${s.btn.borderColor} ≠ --line ${s.ref.line}`);
              }
              if (s.btn.background === s.ref.hover) problems.push(`${at} 쉼 상태가 호버 면이다`);
              if (!near(s.wide.h, 34)) problems.push(`${at} 숫자 단추 높이 ${s.wide.h}`);
              if (s.wide.borderWidth !== "1px") problems.push(`${at} 숫자 단추 선 ${s.wide.borderWidth}`);

              // 켜짐: 선은 투명(신호 면이 구분을 맡는다)이되 두께 1px는 자리를 지킨다.
              if (s.on.borderWidth !== "1px") problems.push(`${at} 켜짐 선 두께 ${s.on.borderWidth}`);
              if (s.on.borderColor === s.ref.line) problems.push(`${at} 켜진 단추에 연한 선이 남았다`);
              if (s.on.background !== s.ref.accentSoft) {
                problems.push(`${at} 켜짐 면 ${s.on.background} ≠ --accent-soft ${s.ref.accentSoft}`);
              }

              // 툴팁: 연회색 알약. 선도 그림자도 없다.
              if (s.tip.background !== s.ref.mutedSoft) {
                problems.push(`${at} 툴팁 면 ${s.tip.background} ≠ --muted-soft ${s.ref.mutedSoft}`);
              }
              if (s.tip.boxShadow !== "none") problems.push(`${at} 툴팁 그림자 ${s.tip.boxShadow}`);
              if (s.tip.borderWidth !== "0px") problems.push(`${at} 툴팁 선 ${s.tip.borderWidth}`);
              if (s.tip.radius !== "10px") problems.push(`${at} 툴팁 반경 ${s.tip.radius}`);

              // 호버: 마우스를 올리면 호버 면(상태 토큰)이다.
              await page.hover("#btn");
              await page.waitForTimeout(300);
              const hovered = await page.evaluate(
                () => getComputedStyle(document.getElementById("btn")!).backgroundColor
              );
              if (hovered !== s.ref.hover) {
                problems.push(`${at} 호버 면 ${hovered} ≠ --surface-hover ${s.ref.hover}`);
              }
            } finally {
              await ctx.close();
            }
          }

          // 고대비: 그림자가 경계를 말하지 못하므로 3:1 선이 돌아오고, 단추 선은 --line-strong이 된다.
          const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
          try {
            const page = await ctx.newPage();
            await page.emulateMedia({ contrast: "more" });
            await page.setContent(html(css, { shell: true }));
            const s = await styles(page);
            const at = `${engine} 고대비`;
            if (s.head.borderBottomWidth !== "1px") {
              problems.push(`${at} 머리 아래 선 ${s.head.borderBottomWidth}`);
            }
            if (s.head.boxShadow !== "none") problems.push(`${at} 머리 그림자가 남았다: ${s.head.boxShadow}`);
            if (s.btn.borderColor !== s.ref.lineStrong) {
              problems.push(`${at} 단추 선 ${s.btn.borderColor} ≠ --line-strong ${s.ref.lineStrong}`);
            }
          } finally {
            await ctx.close();
          }
        } finally {
          await browser.close();
        }
      }

      // 라이트와 다크가 같은 그림자면 다크가 층을 나누지 못한다(어두운 판 위의 어두운 그림자는 보이지 않는다).
      for (const engine of ENGINES) {
        if (shadows[`${engine} light`] === shadows[`${engine} dark`]) {
          problems.push(`${engine}: 머리 그림자가 라이트와 다크에서 같다`);
        }
      }
      expect(problems).toEqual([]);
    },
    60_000
  );
});

describe("전체 화면: 신호등 자리 인셋을 접는다 (#4591)", () => {
  it.skipIf(ENGINES.length === 0)(
    "루트 표지가 있으면 토글이 12에, 없으면 신호등 인셋 80에 선다",
    async () => {
      const css = await compileTokensCss(CANDIDATES);
      const playwright = await import("playwright");
      const problems: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const [name, scene, want] of [
            ["창 모드", { shell: true }, 80],
            ["전체 화면", { shell: true, fullscreen: true }, 12],
            ["전체 화면 접힘", { shell: true, collapsed: true, fullscreen: true }, 12],
          ] as const) {
            const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
            try {
              const page = await ctx.newPage();
              await page.setContent(html(css, scene));
              const g = await geometry(page);
              if (!near(g.toggle.left, want, 0.26)) {
                problems.push(`${engine} ${name}: 토글 왼쪽 ${g.toggle.left}, 기대 ${want}`);
              }
              // 접어도 띠 높이·토글 세로 중심은 그대로다(전체 화면에서 줄이 뛰지 않는다).
              if (!near(g.band.height, 40, 0.01)) problems.push(`${engine} ${name}: 띠 높이 ${g.band.height}`);
              if (!near((g.toggle.top + g.toggle.bottom) / 2, 20, 0.26)) {
                problems.push(`${engine} ${name}: 토글 중심 ${(g.toggle.top + g.toggle.bottom) / 2}`);
              }
            } finally {
              await ctx.close();
            }
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    60_000
  );
});

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

/** 이 스킴에서 풀린 띠 색(`--band`). 장면 안의 참조 요소(`#ref-band`)가 읽은 값이라 `light-dark()`가 풀린 rgb다. 띠가 없으면 투명(null). */
async function bandColor(page: Page): Promise<Rgb | null> {
  return page.evaluate(() => {
    const m = getComputedStyle(document.getElementById("ref-band")!).backgroundColor.match(/[\d.]+/g) ?? [];
    if (m.length === 4 && Number(m[3]) === 0) return null;
    if (m.length < 3) return null;
    return [Number(m[0]), Number(m[1]), Number(m[2])] as [number, number, number];
  });
}

const spread = (a: Rgb, b: Rgb) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

const VIEW = { width: 1100, height: 760 };

/** 판 바깥의 표본점(창 좌표). 셸의 판은 위 40(띠)·오른쪽 8·아래 8에서 시작한다. 모서리 뒤는 판 모서리 안쪽 1px이다(반경 18의 바깥). */
function outsidePoints(kind: "shell" | "web" | "settings", collapsed: boolean): Array<[string, number, number]> {
  const left = kind === "settings" ? 0 : collapsed ? 64 : 324;
  const top = kind === "shell" ? 40 : kind === "web" ? 8 : 0;
  const right = VIEW.width - (kind === "settings" ? 0 : 8);
  const bottom = VIEW.height - (kind === "settings" ? 0 : 8);
  const points: Array<[string, number, number]> = [];
  if (kind !== "settings") {
    points.push(["오른쪽 여백", VIEW.width - 4, 400], ["아래 여백", 700, VIEW.height - 4]);
    points.push(["위 여백", 700, kind === "shell" ? 20 : 4]);
    points.push(
      ["판 왼쪽 위 모서리 뒤", left + 1, top + 1],
      ["판 오른쪽 위 모서리 뒤", right - 2, top + 1],
      ["판 오른쪽 아래 모서리 뒤", right - 2, bottom - 2],
      ["판 왼쪽 아래 모서리 뒤", left + 1, bottom - 2]
    );
  }
  return points;
}

describe("판 바깥은 사이드바와 같은 색이다 (#4591, owner 10-26 「테마가 바뀌었을 때 우측 부분이 UI가 좀 이상해」)", () => {
  it.skipIf(ENGINES.length === 0)(
    "테마마다: 위 띠·오른쪽·아래 여백과 판 모서리 뒤 = 사이드바의 색(띠가 있으면 띠, 없으면 바닥 그라데이션)이다",
    async () => {
      const css = await compileTokensCss(CANDIDATES);
      const playwright = await import("playwright");
      const problems: string[] = [];
      let probed = 0;
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const palette of PALETTES) {
            for (const colorScheme of ["light", "dark"] as const) {
              const ctx = await browser.newContext({ viewport: VIEW, colorScheme });
              try {
                const at = `${engine} ${palette} ${colorScheme}`;
                // 기준 한 장: 바닥 식을 창 전체에 깔았다. 띠가 없는 테마의 사이드바와 여백은 이 면에 녹아 있다.
                const ref = await ctx.newPage();
                await ref.setContent(canvasHtml(css, palette));
                const band = await bandColor(ref);
                // 띠를 가진 것은 노을띠 하나다. 띠 토큰이 사라지거나 다른 테마가 띠를 얻으면 이 시험이 기대하는 색이 조용히
                // 바뀌므로(띠가 없으면 바닥을 기대한다) 여기서 못 박는다.
                if ((palette === "noeul") !== (band !== null)) {
                  problems.push(`${at}: 띠 보유 ${band !== null}, 노을띠만 띠가 있어야 한다`);
                }
                const expectedAt = (x: number, y: number) => (band ? Promise.resolve(band) : pixel(ref, x, y));

                const page = await ctx.newPage();
                for (const [kind, scene, collapsed] of [
                  ["shell", { shell: true }, false],
                  ["shell", { shell: true, collapsed: true }, true],
                  ["web", { shell: false }, false],
                  ["settings", { shell: false, settings: true }, false],
                ] as const) {
                  const points: Array<[string, number, number]> =
                    kind === "settings"
                      ? [
                          ["설정 본문 가운데", 700, 400],
                          ["설정 오른쪽 끝", VIEW.width - 4, 400],
                          ["설정 아래 끝", 700, VIEW.height - 4],
                        ]
                      : [...outsidePoints(kind, collapsed), ["사이드바 열", 100, 400]];
                  // 판을 감춰 창 바닥만 읽는다: 판의 그림자·선 고리가 표본에 섞이지 않는다.
                  await page.setContent(html(css, { ...scene, palette, hidePane: true }));
                  for (const [label, x, y] of points) {
                    const got = await pixel(page, x, y);
                    const expected = await expectedAt(x, y);
                    probed += 1;
                    const d = spread(got, expected);
                    if (d > 3) {
                      problems.push(`${at} ${kind}${collapsed ? " 접힘" : ""} ${label}(${x},${y}): ${got} 인데 사이드바 색 ${expected} (차 ${d})`);
                    }
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
      // 표본이 실제로 읽혔다(빈 순회로 초록이 되지 않는다): 엔진 × 팔레트 3 × 스킴 2 × 장면 4의 표본 수.
      expect(probed).toBeGreaterThanOrEqual(ENGINES.length * 3 * 2 * 20);
      expect(problems).toEqual([]);
    },
    240_000
  );

  it.skipIf(ENGINES.length === 0)(
    "노을띠의 「내 작업」: 띠는 사이드바 열(접히면 레일)이고 셸에서는 윗줄 40도 전폭이다. 그 오른쪽 아래 바닥은 띠가 아니다",
    async () => {
      const css = await compileTokensCss(CANDIDATES);
      const playwright = await import("playwright");
      const problems: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const colorScheme of ["light", "dark"] as const) {
            const ctx = await browser.newContext({ viewport: VIEW, colorScheme });
            try {
              const ref = await ctx.newPage();
              await ref.setContent(canvasHtml(css, "noeul"));
              const band = (await bandColor(ref)) as Rgb;
              const page = await ctx.newPage();
              for (const [name, scene, probes] of [
                [
                  "셸 펼침",
                  { shell: true, workRail: true },
                  [["사이드바 열", 100, 400, true], ["윗줄 사이드바 곁", 700, 20, true], ["윗줄 오른쪽 끝", 1096, 20, true], ["바닥(오른쪽 아래)", 700, 400, false]],
                ],
                [
                  "셸 접힘",
                  { shell: true, workRail: true, collapsed: true },
                  [["레일", 30, 400, true], ["윗줄 토글 곁", 300, 20, true], ["레일 옆 바닥", 300, 400, false]],
                ],
                [
                  "웹 펼침(윗줄 없음)",
                  { shell: false, workRail: true },
                  [["사이드바 열", 100, 400, true], ["윗줄 자리", 700, 4, false], ["바닥", 700, 400, false]],
                ],
              ] as const) {
                await page.setContent(html(css, { ...scene, palette: "noeul", hidePane: true }));
                for (const [label, x, y, wantBand] of probes) {
                  const got = await pixel(page, x, y);
                  const d = spread(got, band);
                  // 같다 = 3 안, 다르다 = 6 이상(다크의 바닥은 띠와 가깝게 설계돼 있다).
                  if (wantBand && d > 3) problems.push(`${engine} ${colorScheme} ${name} ${label}(${x},${y}): 띠 색이어야 하는데 ${got} (차 ${d})`);
                  if (!wantBand && d < 6) problems.push(`${engine} ${colorScheme} ${name} ${label}(${x},${y}): 띠 색이면 안 되는데 ${got} (차 ${d})`);
                }
              }
            } finally {
              await ctx.close();
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

  it.skipIf(ENGINES.length === 0)(
    "테마가 바뀌면 판 바깥이 바로 새 색이다: 전이가 없고, 바꾼 다음 프레임에 옛 색이 남지 않는다 (노을띠 ↔ 새벽하늘 ↔ 흑연)",
    async () => {
      const css = await compileTokensCss(CANDIDATES);
      const playwright = await import("playwright");
      const problems: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext({ viewport: VIEW, colorScheme: "light" });
          try {
            const page = await ctx.newPage();
            const refs = new Map<string, { band: Rgb | null; at: (x: number, y: number) => Promise<Rgb> }>();
            for (const palette of PALETTES) {
              const ref = await ctx.newPage();
              await ref.setContent(canvasHtml(css, palette));
              const band = await bandColor(ref);
              refs.set(palette, { band, at: (x, y) => (band ? Promise.resolve(band) : pixel(ref, x, y)) });
            }
            await page.setContent(html(css, { shell: true, palette: "noeul", hidePane: true }));
            const transition = await page.evaluate(() => getComputedStyle(document.getElementById("shell")!).transitionProperty);
            if (/background|all/.test(transition)) problems.push(`${engine}: 셸이 배경을 전이한다 (${transition})`);
            // 오른쪽 여백·위 띠·아래 여백 세 곳을 돌려 가며 읽는다.
            const spots: Array<[string, number, number]> = [["오른쪽 여백", 1096, 400], ["위 띠", 700, 20], ["아래 여백", 700, 756]];
            for (const next of ["dawnsky", "noeul", "graphite", "noeul", "dawnsky"]) {
              // 속성을 바꾸고 **다음 프레임 한 번**만 기다린 뒤 읽는다(옛 색이 남으면 여기서 붉다).
              await page.evaluate(
                (name) =>
                  new Promise<void>((done) => {
                    document.documentElement.setAttribute("data-palette", name);
                    requestAnimationFrame(() => done());
                  }),
                next
              );
              const ref = refs.get(next)!;
              for (const [label, x, y] of spots) {
                const got = await pixel(page, x, y);
                const want = await ref.at(x, y);
                const d = spread(got, want);
                if (d > 3) problems.push(`${engine} → ${next} ${label}(${x},${y}): ${got} 인데 ${want} (차 ${d})`);
              }
            }
          } finally {
            await ctx.close();
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    120_000
  );

  it.skipIf(ENGINES.length === 0)(
    "판 네 모서리는 같은 반경이고 오른쪽·아래 여백은 같다 (셸·웹·접힘)",
    async () => {
      const css = await compileTokensCss(CANDIDATES);
      const playwright = await import("playwright");
      const problems: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext({ viewport: VIEW });
          try {
            const page = await ctx.newPage();
            for (const [name, scene] of [
              ["셸", { shell: true }],
              ["셸 접힘", { shell: true, collapsed: true }],
              ["웹", { shell: false }],
            ] as const) {
              await page.setContent(html(css, scene));
              const f = await page.evaluate(() => {
                const pane = document.getElementById("pane")!;
                const cs = getComputedStyle(pane);
                const r = pane.getBoundingClientRect();
                return {
                  radii: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
                  right: window.innerWidth - r.right,
                  bottom: window.innerHeight - r.bottom,
                };
              });
              if (new Set(f.radii).size !== 1 || f.radii[0] !== "18px") problems.push(`${engine} ${name}: 모서리 반경 ${f.radii}`);
              if (!near(f.right, 8, 0.01) || !near(f.bottom, 8, 0.01)) problems.push(`${engine} ${name}: 오른쪽 ${f.right} 아래 ${f.bottom} 여백`);
            }
          } finally {
            await ctx.close();
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    60_000
  );

  it.skipIf(ENGINES.length === 0)(
    "띠가 없는 테마(기본)에서는 두 띠 층이 투명 한 장씩이라 아무것도 칠하지 않고, 크기 목록은 층 수(넷)와 같다",
    async () => {
      const css = await compileTokensCss(CANDIDATES);
      const playwright = await import("playwright");
      const problems: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          const ctx = await browser.newContext({ viewport: VIEW });
          try {
            const page = await ctx.newPage();
            const clear = /linear-gradient\(rgba\(0, 0, 0, 0\), rgba\(0, 0, 0, 0\)\)/g;
            for (const [name, scene] of [
              ["셸", { shell: true }],
              ["웹", { shell: false }],
            ] as const) {
              await page.setContent(html(css, scene));
              const layers = await page.evaluate(() => {
                const cs = getComputedStyle(document.getElementById("shell")!);
                return { image: cs.backgroundImage, size: cs.backgroundSize, position: cs.backgroundPosition };
              });
              const clearCount = layers.image.match(clear)?.length ?? 0;
              if (clearCount !== 2) problems.push(`${engine} ${name}: 투명 띠 층 ${clearCount}장(2장이어야 한다) ${layers.image}`);
              if (layers.size.split(/,(?![^(]*\))/).length !== 4) problems.push(`${engine} ${name}: 크기 목록 ${layers.size}`);
              if (layers.position.split(",").length !== 4) problems.push(`${engine} ${name}: 위치 목록 ${layers.position}`);
              // 띠 ②는 높이 0이다(「내 작업」의 셸에서만 윗줄).
              if (!/100% 0px/.test(layers.size)) problems.push(`${engine} ${name}: 띠 ② 높이가 0이 아니다 ${layers.size}`);
            }
          } finally {
            await ctx.close();
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    60_000
  );
});
