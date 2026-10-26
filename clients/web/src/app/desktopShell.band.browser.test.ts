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
}

function html(css: string, scene: Scene): string {
  const shell = scene.shell ? "data-desktop-shell" : "";
  const drag = scene.shell ? "data-tauri-drag-region" : "";
  const collapsed = scene.collapsed ? "data-sidebar-collapsed" : "";
  const slot = scene.shell
    ? `<div class="app-titlebar-trailing band-surface" id="slot" data-tauri-drag-region></div>`
    : "";
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
</style></head><body>
<div id="frame" style="width:100vw;height:100vh">
  <div class="app-shell" id="shell" ${shell} ${collapsed}>
    <header class="app-titlebar" id="band" ${drag}>
      <button id="toggle" type="button">토글</button>${slot}
    </header>
    <aside class="sidebar-drawer" id="side">사이드바</aside>
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
<div style="position:relative;margin:40px;width:120px">
  <span id="tip" class="${TOOLTIP_CLASS} ${TOOLTIP_SIDE_CLASS.bottom}">채널 메뉴</span>
</div>
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
