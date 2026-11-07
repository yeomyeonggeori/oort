import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import type { Browser, Page } from "playwright";
import { ENGINES, type EngineName } from "@/design/appearance/compileTokensTestKit";

// =============================================================================
// 이모티콘 창이 작은 창에서 화면 안에 서는가 (#5527, 검수 7c B1)
//
// 결함: 공용 `PopoverContent`를 쓰는 고르개의 높이 상한이 pane-md(512) 고정이라 데스크탑 최소 창(Tauri minWidth 720 · minHeight 480)에서 창이 489px로 서서 위쪽 y = -84였다.
// 탭 줄과 검색 칸이 화면 밖이라 포인터로 GIF·이모지 탭에 갈 길이 없었다(Chromium·WebKit 같음). 고침: 상한을 Radix가 주는 남은 높이에 묶고(`max-h-pane-md-fit`),
// 줄어드는 몫은 격자 스크롤 칸이 지며 탭 줄·검색 칸·세트 띠는 `shrink-0`이라 늘 보인다.
//
// 이 시험은 **실제 엔진의 계산된 상자**를 잰다(문자열 시험이 아니다). 같은 시험이 결함을 실제로 재현한다는 증거를 같이 낸다: 같은 장면에서 상한만 옛 값(512)으로 되돌리면
// 창이 화면 위로 나간다(`옛 상한` 줄). 그래서 고친 줄을 되돌리면 이 시험이 붉고(사보타주: `EmojiPickerDialog.tsx`의 `max-h-pane-md-fit`을 `max-h-pane-md`로),
// 넓은 창(1280×860)은 상한이 걸리지 않아 옛 모양 그대로임을 같은 방법으로 보인다.
// 엔진은 `ENGINES`(설치된 WebKit·Chromium 전부)다. 하나도 없으면 건너뛴다(다른 브라우저 시험과 같은 규약).
// =============================================================================

type Rig = { engine: EngineName; browser: Browser; origin: string };
const rigs: Rig[] = [];
let server: ViteDevServer | null = null;
let cacheDir = "";

beforeAll(async () => {
  if (ENGINES.length === 0) return;
  cacheDir = mkdtempSync(join(tmpdir(), "oort-emoji-picker-fit-vite-"));
  server = await createServer({
    cacheDir,
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    plugins: [{ name: "emoji-picker-fit-fixture", configureServer(vite) {
      vite.middlewares.use("/__emoji-picker-fit", async (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        // 단추는 화면 아래(입력창의 ☺처럼) 또는 가운데(메시지 줄의 「반응 더하기」처럼)에 선다.
        res.end(await vite.transformIndexHtml("/__emoji-picker-fit", `<!doctype html><html lang="ko"><head><style>
          html,body{margin:0;height:100%}
          #picker-opener{position:fixed;left:40px;width:32px;height:32px}
          body[data-at="bottom"] #picker-opener{bottom:12px}
          body[data-at="middle"] #picker-opener{top:240px}
          </style></head><body><div id="root"></div><script type="module">import {mountEmojiPickerFitHarness} from '/measure/emojiPickerFit.harness.tsx';mountEmojiPickerFitHarness();</script></body></html>`));
      });
    } }],
  });
  await server.listen();
  console.info(`emoji picker fit: real engines = ${ENGINES.join(", ")}`);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("브라우저 시험 포트가 없어요");
  const playwright = await import("playwright");
  for (const engine of ENGINES) rigs.push({ engine, browser: await playwright[engine].launch({ headless: true }), origin: `http://127.0.0.1:${address.port}` });
}, 180_000);

afterAll(async () => {
  for (const rig of rigs) await rig.browser.close();
  await server?.close();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

type Box = { top: number; bottom: number; left: number; right: number; height: number };
type Layout = {
  vw: number; vh: number;
  pop: Box; tabsRow: Box; firstTab: Box; firstTabHit: boolean; search: Box; strip: Box | null; grid: Box;
  gridClient: number; gridScroll: number; gridMaxHeight: string;
};

/** 고르개를 연 채로(`?at`·`?purpose`) 새 컨텍스트·창 크기에서 잰다. 열림 동작(240ms)과 Radix의 첫 자리 계산이 끝나도록 기다린다. */
async function open(rig: Rig, size: { width: number; height: number }, query: string): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await rig.browser.newContext({ viewport: size, locale: "ko-KR", reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/v1/**", (route) => route.fulfill({ json: [] }));
  await page.goto(`${rig.origin}/__emoji-picker-fit?${query}`);
  await page.locator('[data-testid="picker"]').waitFor();
  await page.locator('[data-testid="picker"] [role="group"] button').first().waitFor();
  await page.waitForTimeout(700);
  return { page, errors, close: () => context.close() };
}

/** `oldCap`이면 고르개의 높이 상한을 옛 값(pane-md 512 고정)으로 되돌린 같은 장면을 잰다: 결함을 이 하네스가 실제로 재현하는지 보는 대조다. */
async function measure(page: Page, oldCap = false): Promise<Layout> {
  if (oldCap) {
    await page.evaluate(() => { document.querySelector<HTMLElement>('[data-testid="picker"]')!.style.setProperty("max-block-size", "512px"); });
    await page.waitForTimeout(500);
  }
  return page.evaluate(() => {
    const box = (el: Element | null | undefined) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height };
    };
    const pop = document.querySelector<HTMLElement>('[data-testid="picker"]')!;
    const tabsRow = pop.querySelector<HTMLElement>('[role="group"]')!;
    const firstTab = tabsRow.querySelector<HTMLElement>("button")!;
    const at = firstTab.getBoundingClientRect();
    const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
    const grid = pop.querySelector<HTMLElement>('[data-testid="expression-grid"]') ?? pop.querySelector<HTMLElement>(".emoji-grid")!.parentElement!;
    return {
      vw: innerWidth, vh: innerHeight,
      pop: box(pop)!, tabsRow: box(tabsRow)!, firstTab: box(firstTab)!, firstTabHit: hit === firstTab || firstTab.contains(hit),
      search: box(pop.querySelector("input"))!, strip: box(pop.querySelector('[data-testid="expression-set-strip"]')),
      grid: box(grid)!, gridClient: grid.clientHeight, gridScroll: grid.scrollHeight, gridMaxHeight: getComputedStyle(grid).maxHeight,
    };
  });
}

const insideScreen = (box: Box, layout: Layout) => box.top >= 0 && box.left >= 0 && box.bottom <= layout.vh && box.right <= layout.vw;
const whereAmI = (engine: EngineName, what: string) => `[${engine}] ${what}`;

describe("이모티콘 창은 작은 창에서 화면 안에 선다 (#5527 B1)", () => {
  it.skipIf(ENGINES.length === 0)("720×480(데스크탑 최소 창): 입력창 ☺로 연 창 상자가 화면 안이고, 탭 자리의 히트 테스트가 탭이며, 줄어든 몫은 격자가 진다", async () => {
    for (const rig of rigs) {
      const { page, errors, close } = await open(rig, { width: 720, height: 480 }, "at=bottom&purpose=insert");
      try {
        const fixed = await measure(page);
        expect(insideScreen(fixed.pop, fixed), whereAmI(rig.engine, `창 상자 ${JSON.stringify(fixed.pop)}가 720×480 안`)).toBe(true);
        expect(fixed.firstTabHit, whereAmI(rig.engine, "탭 자리의 히트 테스트가 탭")).toBe(true);
        expect(insideScreen(fixed.firstTab, fixed), whereAmI(rig.engine, "탭이 화면 안")).toBe(true);
        expect(insideScreen(fixed.search, fixed), whereAmI(rig.engine, "검색 칸이 화면 안")).toBe(true);
        expect(fixed.strip !== null && insideScreen(fixed.strip, fixed), whereAmI(rig.engine, "세트 띠가 화면 안")).toBe(true);
        // 줄어든 몫은 격자가 진다: 격자의 상한(320)보다 낮아졌고 안에서 스크롤한다(보이는 높이 < 내용 높이).
        expect(fixed.gridClient, whereAmI(rig.engine, "격자 높이가 옛 상한 320보다 낮다")).toBeLessThan(320);
        expect(fixed.gridClient, whereAmI(rig.engine, "격자가 그래도 한 줄 이상 보인다")).toBeGreaterThan(100);
        expect(fixed.gridScroll, whereAmI(rig.engine, "격자 안에서 스크롤한다")).toBeGreaterThan(fixed.gridClient);
        // 대조: 상한만 옛 값으로 되돌린 같은 장면은 창이 화면 위로 나가 탭 자리가 탭이 아니다(결함 재현).
        const old = await measure(page, true);
        expect(old.pop.top, whereAmI(rig.engine, "옛 상한에서는 창이 화면 위로 나간다")).toBeLessThan(0);
        expect(old.firstTabHit, whereAmI(rig.engine, "옛 상한에서는 탭 자리가 탭이 아니다")).toBe(false);
        expect(errors, whereAmI(rig.engine, "페이지 오류")).toEqual([]);
      } finally { await close(); }
    }
  }, 180_000);

  it.skipIf(ENGINES.length === 0)("1280×860: 상한이 걸리지 않아 옛 모양 그대로다(창 위치·높이·격자 높이가 같다)", async () => {
    for (const rig of rigs) {
      const { page, close } = await open(rig, { width: 1280, height: 860 }, "at=bottom&purpose=insert");
      try {
        const fixed = await measure(page);
        const old = await measure(page, true);
        expect(insideScreen(fixed.pop, fixed), whereAmI(rig.engine, "창 상자가 화면 안")).toBe(true);
        expect(fixed.pop, whereAmI(rig.engine, "창 상자가 옛 상한과 같다")).toEqual(old.pop);
        expect(fixed.gridClient, whereAmI(rig.engine, "격자 높이가 옛 상한과 같다")).toBe(old.gridClient);
        expect(fixed.gridClient, whereAmI(rig.engine, "격자는 줄지 않았다(상한 그대로)")).toBeGreaterThanOrEqual(300);
      } finally { await close(); }
    }
  }, 180_000);

  it.skipIf(ENGINES.length === 0)("탭 줄·검색 칸·세트 띠는 창이 낮아져도 줄지 않고 늘 보인다(720×300까지)", async () => {
    for (const rig of rigs) {
      const { page: wide, close: closeWide } = await open(rig, { width: 1280, height: 860 }, "at=bottom&purpose=insert");
      const { page: low, close: closeLow } = await open(rig, { width: 720, height: 300 }, "at=bottom&purpose=insert");
      try {
        const natural = await measure(wide);
        const small = await measure(low);
        expect(insideScreen(small.pop, small), whereAmI(rig.engine, `720×300에서도 창 상자가 화면 안 ${JSON.stringify(small.pop)}`)).toBe(true);
        expect(small.firstTabHit, whereAmI(rig.engine, "탭 자리의 히트 테스트가 탭")).toBe(true);
        expect(small.tabsRow.height, whereAmI(rig.engine, "탭 줄 높이가 그대로")).toBe(natural.tabsRow.height);
        expect(small.search.height, whereAmI(rig.engine, "검색 칸 높이가 그대로")).toBe(natural.search.height);
        expect(small.strip!.height, whereAmI(rig.engine, "세트 띠 높이가 그대로")).toBe(natural.strip!.height);
        expect(small.gridClient, whereAmI(rig.engine, "격자만 짧아졌다")).toBeLessThan(natural.gridClient);
        expect(insideScreen(small.strip!, small), whereAmI(rig.engine, "세트 띠가 화면 안")).toBe(true);
      } finally { await closeWide(); await closeLow(); }
    }
  }, 180_000);

  it.skipIf(ENGINES.length === 0)("단추가 화면 가운데에 서는 자리(반응 더하기)와 이모지 탭부터 여는 반응 고르개도 720×480 안에 선다", async () => {
    for (const rig of rigs) {
      for (const purpose of ["insert", "reaction"]) {
        const { page, errors, close } = await open(rig, { width: 720, height: 480 }, `at=middle&purpose=${purpose}`);
        try {
          const fixed = await measure(page);
          const at = whereAmI(rig.engine, `${purpose}, 단추가 가운데`);
          expect(insideScreen(fixed.pop, fixed), `${at}: 창 상자 ${JSON.stringify(fixed.pop)}가 화면 안`).toBe(true);
          expect(fixed.firstTabHit, `${at}: 탭 자리의 히트 테스트가 탭`).toBe(true);
          expect(insideScreen(fixed.search, fixed), `${at}: 검색 칸이 화면 안`).toBe(true);
          expect(errors, `${at}: 페이지 오류`).toEqual([]);
        } finally { await close(); }
      }
    }
  }, 180_000);
});
