import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  compileTokensCss,
  ENGINES,
} from "@/design/appearance/compileTokensTestKit";

// =============================================================================
// 좁은 웹 창에서 사이드바 열이 본문 칸에 컴포저 바닥을 내준다: 엔진이 계산한 기하 (#5093, #5048 D4).
//
// 사이드바가 240에서 324가 된 뒤 펼친 셸의 컴포저는 `창 폭 − 390`이라 600px 창에서 210px였다(바닥 240).
// 문자열 시험(`desktopShell.ds2.test.ts`)은 「양보하는 줄이 CSS에 있다」만 말한다. 이 시험은 `tokens.css`를
// Tailwind로 진짜 컴파일해 WebKit(WKWebView의 엔진)과 Chromium에 먹이고, 사이드바·판·컴포저 상자가 **계산된 기하**로
// 어디에 서는지를 잰다. 렌더된 앱 전체(채널·스레드)는 `gates/gate-work-panel.mjs`의 `narrow-shell-*`가 잰다.
//
// 잰 것
//   · 펼침: 사이드바 = min(324, 창 − 306). 600px에서 294, 629px에서 323, 630px 이상에서 324 그대로
//   · 접힘: 모든 폭에서 레일 56 (수리가 접힘을 만지지 않았다)
//   · 컴포저 입력 상자가 모든 폭·상태에서 바닥 240 위이고, 문서는 가로로 스크롤하지 않는다
//   · 630px 이상 펼침의 컴포저 = 창 − 324 − 8 − 58 (양보가 시작하기 전과 같은 값)
//   · 양보하는 열도 평소처럼 접힌다: `grid-template-columns`의 transitionend가 온다(`useSidebarCollapsePaint`가
//     그것을 기다린다). 600px에서 펼친 열의 폭은 창 폭에서 나오는 길이라, 이 전환이 도는지를 두 엔진에서 잰다
// =============================================================================

/** gate-work-panel `MIN_COMPOSER_WIDTH`. 코어가 플레이스홀더 문장을 고른 입력 상자 예산(236)에 상자 자신의 몫을 더한 값. */
const COMPOSER_FLOOR = 240;
const SIDEBAR_FULL = 324;
const RAIL = 56;
/** 판 오른쪽 인셋(접히면 왼쪽도). `app-shell`의 `> main` 여백. */
const PANE_INSET = 8;
/** 본문 판 안에서 컴포저 입력 상자가 아닌 폭: 폼 좌우 24×2 + 카드 안쪽 4×2 + 카드 테두리 1×2. */
const COMPOSER_BOX = 58;
/**
 * 본문 칸(격자 열)의 바닥. CSS의 `calc(100vw - 306px)`와 **따로 적어 둔** 유도다: 한쪽이 움직이면 이 시험이 붉다.
 * 사이드바는 이보다 넓은 창에서 324 그대로이고, 이 아래에서만 줄어든다(630px).
 */
const MAIN_FLOOR = COMPOSER_FLOOR + PANE_INSET + COMPOSER_BOX;
const YIELD_BELOW = SIDEBAR_FULL + MAIN_FLOOR;
const WIDTHS = [600, 629, 630, 650, 719, 720, 1024];

const CANDIDATES = [
  "app-shell",
  "app-titlebar",
  "sidebar-drawer",
  "app-pane",
  "composer-dock",
  "composer-card",
  "flex",
  "min-h-0",
  "min-w-0",
  "flex-col",
];

function html(css: string, collapsed: boolean): string {
  return `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
textarea { display: block; box-sizing: border-box; width: 100%; margin: 0; padding: 0; border: 0; }
</style></head><body>
<div id="frame" style="width:100vw;height:100vh">
  <div class="app-shell" id="shell" ${collapsed ? "data-sidebar-collapsed" : ""}>
    <header class="app-titlebar" id="band"><button id="toggle" type="button">토글</button></header>
    <aside class="sidebar-drawer" id="side">사이드바</aside>
    <main class="app-pane flex min-h-0 min-w-0 flex-col" id="pane">
      <div id="timeline" style="flex:1">타임라인</div>
      <div class="composer-dock">
        <form><div class="composer-card"><textarea id="input" rows="1"></textarea></div></form>
      </div>
    </main>
  </div>
</div>
</body></html>`;
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    const shell = box("shell");
    const side = box("side");
    const pane = box("pane");
    const input = box("input");
    return {
      sideWidth: side.width,
      paneLeft: pane.left - shell.left,
      paneRightInset: shell.right - pane.right,
      inputWidth: input.width,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

const near = (actual: number, want: number, tol = 0.51) => Math.abs(actual - want) <= tol;

describe("좁은 창의 사이드바 열은 본문 칸에 컴포저 바닥을 내준다: 엔진이 계산한 기하 (#5093)", () => {
  it.skipIf(ENGINES.length === 0)(
    "펼침은 min(324, 창 − 306), 접힘은 레일 56이고, 모든 폭에서 컴포저가 바닥 240 위다",
    async () => {
      const css = await compileTokensCss(CANDIDATES);
      const playwright = await import("playwright");
      const problems: string[] = [];
      const eq = (label: string, actual: number, want: number) => {
        if (!near(actual, want)) problems.push(`${label}: ${actual}, 기대 ${want}`);
      };

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const width of WIDTHS) {
            for (const collapsed of [false, true]) {
              // reduced motion: 접힘 전환이 도는 동안의 중간 값이 아니라 선 값을 잰다.
              const ctx = await browser.newContext({
                viewport: { width, height: 760 },
                reducedMotion: "reduce",
              });
              try {
                const page = await ctx.newPage();
                await page.setContent(html(css, collapsed));
                const g = await geometry(page);
                const at = `${engine} ${width}px ${collapsed ? "접힘" : "펼침"}`;

                const side = collapsed ? RAIL : Math.min(SIDEBAR_FULL, width - MAIN_FLOOR);
                eq(`${at} 사이드바 폭`, g.sideWidth, side);
                eq(`${at} 판 오른쪽 인셋`, g.paneRightInset, PANE_INSET);
                eq(`${at} 판 왼쪽`, g.paneLeft, collapsed ? RAIL + PANE_INSET : side);
                if (g.inputWidth < COMPOSER_FLOOR - 0.51) {
                  problems.push(`${at} 컴포저 ${g.inputWidth}px: 바닥 ${COMPOSER_FLOOR}px 아래`);
                }
                if (g.overflowX > 0) {
                  problems.push(`${at} 문서가 가로로 ${g.overflowX}px 스크롤한다`);
                }
                if (collapsed) {
                  eq(`${at} 컴포저`, g.inputWidth, width - RAIL - 2 * PANE_INSET - COMPOSER_BOX);
                } else if (width >= YIELD_BELOW) {
                  // 양보가 시작하기 전: 이 이슈 이전과 같은 값이다.
                  eq(`${at} 컴포저`, g.inputWidth, width - SIDEBAR_FULL - PANE_INSET - COMPOSER_BOX);
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

  it.skipIf(ENGINES.length === 0)(
    "양보하는 열도 평소처럼 접힌다: 600·629px(양보)와 720px(그대로) 모두 transitionend가 온다",
    async () => {
      const css = await compileTokensCss(CANDIDATES);
      const playwright = await import("playwright");
      const problems: string[] = [];

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const width of [600, 629, 720]) {
            const ctx = await browser.newContext({
              viewport: { width, height: 760 },
              reducedMotion: "no-preference",
            });
            try {
              const page = await ctx.newPage();
              await page.setContent(html(css, false));
              // 접힘을 요청하고, 셸 자신의 `grid-template-columns` 전환이 끝나는 신호를 기다린다.
              const fired = await page.evaluate(
                () =>
                  new Promise<boolean>((resolve) => {
                    const shell = document.getElementById("shell")!;
                    const timer = setTimeout(() => resolve(false), 3000);
                    shell.addEventListener("transitionend", (event) => {
                      if (
                        event.target === shell &&
                        event.propertyName === "grid-template-columns"
                      ) {
                        clearTimeout(timer);
                        resolve(true);
                      }
                    });
                    // 전환의 시작 값이 그려진 뒤에 바꾼다.
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() => shell.setAttribute("data-sidebar-collapsed", ""))
                    );
                  })
              );
              if (!fired) {
                problems.push(
                  `${engine} ${width}px: 접힘의 grid-template-columns transitionend가 오지 않았다 (useSidebarCollapsePaint가 이것을 기다린다)`
                );
              }
              const g = await geometry(page);
              if (!near(g.sideWidth, RAIL)) {
                problems.push(`${engine} ${width}px: 접힌 뒤 사이드바 ${g.sideWidth}px, 기대 ${RAIL}`);
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
